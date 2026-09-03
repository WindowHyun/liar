'use strict';

/**
 * Electron 버전에서만 쓰이는 화면 경로를 검증한다.
 *
 * Electron에서는 화면이 "이 페이지를 준 서버"가 아니라, preload가 알려 주는 주소
 * (window.liar.getServer)로 붙는다. 호스트가 바뀌면 그 주소가 바뀌고, 화면은 새 주소로
 * 다시 붙어야 한다. 그 경로를 가짜 브리지를 심어서 실제 브라우저로 확인한다.
 *
 * (Electron 창을 직접 띄우는 대신 이렇게 하는 이유: 검증하려는 건 app.js의 분기이고,
 *  브리지 규약만 같으면 실제 Electron에서도 같은 코드가 돈다.)
 *
 * 실행: node test/bridge-test.js
 */

const { createGameServer } = require('../web/game-server');
const { createUiServer } = require('../electron/ui-server');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  // CI에서 조용히 건너뛰면 "돌지도 않은 테스트"가 통과로 보인다. 거기서는 실패시킨다.
  if (process.env.CI) {
    console.error('Electron 브리지: Playwright가 설치되지 않았습니다. CI에서는 건너뛸 수 없습니다.');
    process.exit(1);
  }
  console.log('Electron 브리지: Playwright가 없어 건너뜁니다. (npm i 후 npx playwright install chromium)');
  process.exit(0);
}

const PORT_A = 4181;
const PORT_B = 4182;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// preload.js가 노출하는 것과 같은 모양의 가짜 브리지
const BRIDGE = `
  window.__server = null;
  window.__listeners = [];
  window.liar = {
    isElectron: true,
    getServer: function () { return window.__server; },
    onServerChange: function (fn) { window.__listeners.push(fn); },
  };
  window.__attention = 0;
  window.liar.notifyAttention = function () { window.__attention += 1; };
  window.__setServer = function (url) {
    window.__server = url;
    window.__listeners.forEach(function (fn) { fn(url); });
  };
`;

let serverA = null;
let serverB = null;
let browser = null;

async function main() {
  serverA = createGameServer({ port: PORT_A });
  await serverA.start();

  browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(BRIDGE);
  await page.goto(`http://127.0.0.1:${PORT_A}`);

  // 1. 아직 호스트가 정해지기 전 - 붙을 곳이 없다
  await wait(700);
  check('B1 호스트가 정해지기 전에는 참가자를 찾는 중이라고 알린다',
    (await page.textContent('#banner')).includes('참가자를 찾는 중'),
    (await page.textContent('#banner')).trim());
  check('B1 이 페이지를 준 서버로 멋대로 붙지 않는다', serverA.playerCount() === 0,
    `접속자 ${serverA.playerCount()}명`);

  // 2. 호스트가 정해졌다 - 그 주소로 붙어야 한다
  await page.fill('#nickname-input', '철수');
  await page.click('#join-btn');
  await page.evaluate(`window.__setServer('ws://127.0.0.1:${PORT_A}')`);
  await page.waitForFunction(() => document.querySelectorAll('#participant-list li').length === 1, null, { timeout: 6000 });
  check('B2 브리지가 알려 준 주소로 붙는다',
    (await page.textContent('#participant-list')).includes('철수') && serverA.playerCount() === 1);

  // 3. 호스트 인계 - 먼저 켠 사람이 나가고 다른 PC가 이어받은 상황
  serverB = createGameServer({ port: PORT_B });
  await serverB.start();
  await serverA.stop();
  serverA = null;
  await page.evaluate(`window.__setServer('ws://127.0.0.1:${PORT_B}')`);

  const moved = await page.waitForFunction(
    () => document.querySelectorAll('#participant-list li').length === 1,
    null, { timeout: 8000 },
  ).then(() => true).catch(() => false);

  check('B3 호스트가 바뀌면 새 주소로 알아서 다시 붙는다',
    moved && serverB.playerCount() === 1, `새 호스트 접속자 ${serverB.playerCount()}명`);
  check('B3 다시 붙은 뒤에도 접속 화면으로 돌아가지 않는다',
    !(await page.isVisible('#screen-join')));

  // 4. 다시 붙은 서버에서 정상적으로 게임을 이어갈 수 있다
  await page.fill('#chat-input', '인계 후에도 됩니다');
  await page.press('#chat-input', 'Enter');
  await page.waitForFunction(() => document.querySelector('#chat').textContent.includes('인계 후에도 됩니다'), null, { timeout: 5000 });
  check('B4 인계된 서버에서 대화가 정상 동작한다', true);

  check('B5 브라우저 콘솔 오류 없음', errors.length === 0, errors.slice(0, 2).join(' | '));

  await loadingScreen();

  await roundInProgressHandover();
  await attentionWhileAway();
}

/**
 * B7 [요청] 창을 내려 둔 사이에 대화가 오거나 내 차례가 되면 알린다.
 *
 * 실제로 트레이가 깜빡이는지는 메인 프로세스 일이라 여기서 볼 수 없다. 여기서 고정하는 것은
 * 화면이 "알려 달라"고 부르는 조건이다 - 이걸 잘못 잡으면 내가 친 글에도 깜빡이거나
 * (시끄럽다), 정작 남의 글에는 조용하다(놓친다).
 */
async function attentionWhileAway() {
  const PORT_E = 4185;
  const host = createGameServer({ port: PORT_E });
  await host.start();

  const pages = [];
  for (const name of ['가', '나']) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.addInitScript(BRIDGE);
    await page.goto(`http://127.0.0.1:${PORT_E}`);
    await page.evaluate((u) => window.__setServer(u), `ws://127.0.0.1:${PORT_E}`);
    await page.fill('#nickname-input', name);
    await page.click('#join-btn');
    pages.push({ name, ctx, page });
  }
  const [me, other] = pages;
  await me.page.waitForFunction(() => document.querySelectorAll('#participant-list li').length === 2, null, { timeout: 5000 });

  // 처음 그릴 때는 이미 쌓여 있던 것뿐이라 알리지 않아야 한다.
  check('B7 처음 들어왔을 때는 알리지 않는다',
    (await me.page.evaluate(() => window.__attention)) === 0,
    String(await me.page.evaluate(() => window.__attention)));

  // 남이 친 대화 → 알린다
  await me.page.evaluate(() => { window.__attention = 0; });
  await other.page.fill('#chat-input', '안녕하세요');
  await other.page.press('#chat-input', 'Enter');
  await me.page.waitForFunction(() => document.querySelector('#chat').textContent.includes('안녕하세요'), null, { timeout: 5000 });
  check('B7 [요청] 남이 친 대화가 오면 알린다',
    (await me.page.evaluate(() => window.__attention)) > 0);

  // 내가 친 대화 → 알리지 않는다 (내 손으로 친 것에 깜빡이면 시끄럽기만 하다)
  await me.page.evaluate(() => { window.__attention = 0; });
  await me.page.fill('#chat-input', '제가 씁니다');
  await me.page.press('#chat-input', 'Enter');
  await me.page.waitForFunction(() => document.querySelector('#chat').textContent.includes('제가 씁니다'), null, { timeout: 5000 });
  await wait(300);
  check('B7 내가 친 대화로는 알리지 않는다',
    (await me.page.evaluate(() => window.__attention)) === 0,
    String(await me.page.evaluate(() => window.__attention)));

  // 내 차례가 되면 알린다
  for (const p of pages) await p.page.evaluate(() => { window.__attention = 0; });
  await me.page.click('#start-btn');
  await Promise.all(pages.map((p) => p.page.waitForSelector('#role-card:not(.hidden)', { timeout: 5000 })));
  await wait(400);
  const speaker = (await me.page.locator('#composer.my-turn').count()) ? me : other;
  check('B7 [요청] 내 차례가 되면 알린다',
    (await speaker.page.evaluate(() => window.__attention)) > 0,
    `${speaker.name}의 알림 ${await speaker.page.evaluate(() => window.__attention)}회`);

  for (const p of pages) await p.ctx.close();
  await host.stop();
}

/**
 * B8 [요청] 앱을 켜면 뜨는 로딩 화면.
 *
 * 메인 프로세스가 이 페이지를 화면 서버로 띄운다. 여기서는 그 페이지가 실제로 내려오고
 * 글자가 보이는지만 본다(빈 화면이 뜨면 로딩이 아니라 고장으로 보인다).
 */
async function loadingScreen() {
  // 실제 앱에서 이 페이지를 내려주는 것은 게임 서버가 아니라 화면 서버다. 같은 걸 띄운다.
  const ui = createUiServer();
  const port = await ui.start();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/loading.html`);
  const text = await page.textContent('body');
  check('B8 로딩 화면이 내려온다', text.includes('찾는 중'), text.replace(/\s+/g, ' ').trim().slice(0, 60));
  check('B8 로딩 화면에 스타일이 먹는다',
    (await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === 'rgb(63, 14, 64)',
    await page.evaluate(() => getComputedStyle(document.body).backgroundColor));
  check('B8 점 세 개가 그려진다', (await page.locator('.dots i').count()) === 3);
  await page.close();
  ui.stop();
}

/**
 * B6 판이 진행 중일 때 호스트가 바뀌면.
 *
 * 위 B1~B5는 로비에서 한 명일 때만 본다. 실제로 문제가 되는 건 "게임 중에 호스트가
 * 나갔을 때"다. 방 상태는 호스트 PC 메모리에만 있으므로 인계되면 판이 통째로 사라진다.
 * 그 자체는 구조상 어쩔 수 없고, 확인할 것은 이것이다.
 *   - 판이 사라졌다고 화면이 알려 주는가 (아무 말 없이 로비로 돌아가면 버그로 보인다)
 *   - 두 사람 다 새 호스트로 옮겨 붙는가
 *   - 곧바로 새 판을 시작할 수 있는가
 */
async function roundInProgressHandover() {
  const PORT_C = 4183;
  const PORT_D = 4184;
  let hostC = createGameServer({ port: PORT_C });
  await hostC.start();

  // 창마다 저장소를 나눠야 두 참가자가 된다 (같은 컨텍스트면 토큰을 공유한다)
  const pages = [];
  for (const name of ['철수', '영희']) {
    const ctx = await browser.newContext();
    const pg = await ctx.newPage();
    await pg.addInitScript(BRIDGE);
    await pg.goto(`http://127.0.0.1:${PORT_C}`);
    await pg.fill('#nickname-input', name);
    await pg.click('#join-btn');
    await pg.evaluate(`window.__setServer('ws://127.0.0.1:${PORT_C}')`);
    pages.push({ name, page: pg, ctx });
  }
  await pages[0].page.waitForFunction(
    () => document.querySelectorAll('#participant-list li').length === 2, null, { timeout: 8000 });

  await pages[0].page.click('#start-btn');
  await Promise.all(pages.map((p) => p.page.waitForSelector('#live-block .track .pill', { timeout: 8000 })));
  check('B6 인계 전에 판이 진행 중이다',
    (await pages[0].page.textContent('#live-block')).includes('설명'));

  // 호스트가 갑자기 나가고 다른 PC가 이어받는다
  const hostD = createGameServer({ port: PORT_D });
  await hostD.start();
  await hostC.stop();
  hostC = null;
  for (const p of pages) await p.page.evaluate(`window.__setServer('ws://127.0.0.1:${PORT_D}')`);

  const moved = await pages[0].page.waitForFunction(
    () => document.querySelectorAll('#participant-list li').length === 2,
    null, { timeout: 10000 },
  ).then(() => true).catch(() => false);
  check('B6 두 사람 다 새 호스트로 옮겨 붙는다',
    moved && hostD.playerCount() === 2, `새 호스트 접속자 ${hostD.playerCount()}명`);

  check('B6 판이 사라졌다고 화면이 알려 준다',
    (await pages[0].page.textContent('#banner')).includes('이어받았습니다'),
    (await pages[0].page.textContent('#banner')).trim().slice(0, 40) || '(배너 없음)');
  check('B6 새 호스트에서는 로비로 돌아와 있다',
    await pages[0].page.isVisible('#start-btn') && (await pages[0].page.locator('.result-card').count()) === 0);
  check('B6 곧바로 새 판을 시작할 수 있다', !(await pages[0].page.isDisabled('#start-btn')));

  await pages[0].page.click('#start-btn');
  await Promise.all(pages.map((p) => p.page.waitForSelector('#live-block .track .pill', { timeout: 8000 })));
  const cards = await Promise.all(pages.map((p) => p.page.textContent('#role-card')));
  check('B6 새 판이 정상적으로 굴러간다',
    cards.filter((c) => c.includes('담당자: ')).length === 1
    && (await pages[0].page.textContent('#live-block .round-badge')).trim() === '1차',
    cards.map((c) => c.slice(0, 12)).join(' / '));

  for (const p of pages) await p.ctx.close();
  await hostD.stop();
}

main()
  .catch((err) => check('실행 중 예외', false, err.message))
  .finally(async () => {
    if (browser) await browser.close().catch(() => {});
    if (serverA) await serverA.stop();
    if (serverB) await serverB.stop();
    await wait(200);
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\nElectron 브리지: ${results.length - failed}/${results.length} 통과`);
    process.exit(failed === 0 ? 0 : 1);
  });

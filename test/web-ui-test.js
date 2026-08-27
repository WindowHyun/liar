'use strict';

/**
 * 웹 버전 화면 통합 테스트 - 실제 Chromium 창 3개로 한 판을 끝까지 진행한다.
 * LAN 버전에서는 한 PC에 인스턴스가 하나만 뜨므로 이런 검증이 불가능했다.
 * Playwright가 없으면 건너뛴다.
 *
 * 실행: node test/web-ui-test.js
 */

const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  // CI에서 조용히 건너뛰면 "돌지도 않은 테스트"가 통과로 보인다. 거기서는 실패시킨다.
  if (process.env.CI) {
    console.error('웹 화면(브라우저): Playwright가 설치되지 않았습니다. CI에서는 건너뛸 수 없습니다.');
    process.exit(1);
  }
  console.log('웹 화면(브라우저): Playwright가 없어 건너뜁니다. (npm i 후 npx playwright install chromium)');
  process.exit(0);
}

const ROOT = path.join(__dirname, '..');
const PORT = 4177;
const URL = `http://127.0.0.1:${PORT}`;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(URL, (res) => { res.resume(); resolve(); });
      req.on('error', () => (Date.now() > deadline ? reject(new Error('서버가 안 뜸')) : setTimeout(tick, 100)));
    };
    tick();
  });
}

let server = null;
let browser = null;

async function main() {
  server = spawn(process.execPath, [path.join(ROOT, 'web', 'server.js')], {
    stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT, env: { ...process.env, PORT: String(PORT) },
  });
  server.stdout.resume();
  server.stderr.resume();
  await waitForServer(8000);

  browser = await chromium.launch();
  const errors = [];
  const pages = [];
  for (const name of ['철수', '영희', '민수']) {
    const context = await browser.newContext(); // 창마다 localStorage를 분리한다
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
    await page.goto(URL);
    await page.fill('#nickname-input', name);
    await page.click('#join-btn');
    pages.push({ name, page });
  }

  const [p1, p2, p3] = pages;
  await p1.page.waitForFunction(() => document.querySelectorAll('#participant-list li').length === 3, { timeout: 6000 });
  check('X1 세 명이 서로를 본다', (await p1.page.textContent('#participant-list')).includes('민수'));

  // 라운드 시작
  await p1.page.click('#start-btn');
  await p1.page.waitForSelector('#role-card:not(.hidden)', { timeout: 5000 });
  await Promise.all(pages.map((p) => p.page.waitForSelector('#role-card:not(.hidden)', { timeout: 5000 })));

  const cards = await Promise.all(pages.map((p) => p.page.textContent('#role-card')));
  const liars = cards.filter((c) => c.includes('당신은 Oliveyoung입니다'));
  check('X2 라이어는 정확히 한 명', liars.length === 1, `${liars.length}명`);
  check('X2 라이어 화면에는 제시어가 없다', liars[0].includes('제시어는 모릅니다'));

  const citizenCards = cards.filter((c) => !c.includes('당신은 Oliveyoung입니다'));
  const word = citizenCards[0].split('제시어: ')[1].trim();
  check('X2 시민 두 명은 같은 제시어를 본다', citizenCards.every((c) => c.includes(word)), `제시어=${word}`);

  // 라이어의 브라우저 어디에도 제시어가 없어야 한다
  const liarIndex = cards.findIndex((c) => c.includes('당신은 Oliveyoung입니다'));
  const liarHtml = await pages[liarIndex].page.content();
  check('X2 라이어 브라우저 전체에 제시어가 없다', !liarHtml.includes(word));

  // 대화
  await p1.page.fill('#chat-input', '빨갛습니다');
  await p1.page.press('#chat-input', 'Enter');
  await p2.page.waitForFunction(() => document.querySelector('#chat').textContent.includes('빨갛습니다'), { timeout: 5000 });
  check('X3 대화가 모두에게 보인다', (await p3.page.textContent('#chat')).includes('빨갛습니다'));

  // 투표 제안 - 먼저 다 같이 O/X로 진행 여부를 정한다
  await p1.page.click('#vote-btn');
  await Promise.all(pages.map((p) => p.page.waitForSelector('#proposal-panel:not(.hidden)', { timeout: 5000 })));
  check('X4 투표 버튼을 누르면 전원 화면에 O/X가 뜬다',
    (await p2.page.textContent('#proposal-panel')).includes('진행할까요'));
  check('X4 찬반 단계에서는 대화가 아직 열려 있다', !(await p1.page.isDisabled('#chat-input')));

  // 3명 중 1명만 O를 눌러도 아직 33%라 진행되지 않는다
  await p1.page.click('#proposal-yes');
  await wait(400);
  check('X4 찬성 1/3이면 아직 투표로 넘어가지 않는다',
    await p2.page.isVisible('#proposal-panel'));

  // 두 번째 O로 2/3 → 50% 이상이라 투표로 넘어간다
  await p2.page.click('#proposal-yes');
  await Promise.all(pages.map((p) => p.page.waitForSelector('#vote-panel:not(.hidden)', { timeout: 5000 })));
  check('X4 찬성이 절반을 넘으면 투표로 넘어간다', true);
  check('X4 투표 중에는 대화가 잠긴다', await p1.page.isDisabled('#chat-input'));

  const liarName = pages[liarIndex].name;
  for (let i = 0; i < pages.length; i += 1) {
    const target = i === liarIndex ? pages[(i + 1) % pages.length].name : liarName;
    await pages[i].page.click(`#vote-buttons button:has-text("${target}")`);
  }

  // 라이어가 지목됐으므로 정답 단계
  await pages[liarIndex].page.waitForSelector('#guess-panel:not(.hidden)', { timeout: 5000 });
  check('X5 지목된 라이어에게만 정답창이 뜬다',
    !(await pages[(liarIndex + 1) % 3].page.isVisible('#guess-panel')));

  await pages[liarIndex].page.fill('#guess-input', '전혀다른답');
  await pages[liarIndex].page.press('#guess-input', 'Enter');

  await Promise.all(pages.map((p) => p.page.waitForSelector('#result-panel:not(.hidden)', { timeout: 5000 })));
  const panels = await Promise.all(pages.map((p) => p.page.textContent('#result-panel')));
  check('X6 세 명이 같은 결과를 본다',
    panels.every((t) => t.includes('시민 팀 승리')), panels.map((t) => t.slice(0, 14)).join(' | '));
  check('X6 끝난 뒤 라이어와 제시어가 공개된다',
    panels.every((t) => t.includes(liarName) && t.includes(word)));

  // 새로고침해도 자리와 상태가 유지된다
  await p2.page.reload();
  await p2.page.waitForSelector('#screen-game:not(.hidden)', { timeout: 5000 });
  await wait(500);
  check('X7 새로고침해도 접속 화면으로 돌아가지 않는다',
    !(await p2.page.isVisible('#screen-join')));
  check('X7 새로고침해도 참가자와 결과가 그대로다',
    (await p2.page.textContent('#participant-list')).includes('철수') &&
    (await p2.page.textContent('#result-panel')).includes('시민 팀 승리'));

  check('X8 브라우저 콘솔 오류 없음', errors.length === 0, errors.slice(0, 2).join(' | '));
}

main()
  .catch((err) => check('실행 중 예외', false, err.message))
  .finally(async () => {
    if (browser) await browser.close().catch(() => {});
    if (server) server.kill();
    await wait(200);
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n웹 화면(브라우저): ${results.length - failed}/${results.length} 통과`);
    process.exit(failed === 0 ? 0 : 1);
  });

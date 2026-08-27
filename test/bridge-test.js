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

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  try {
    ({ chromium } = require('/opt/node22/lib/node_modules/playwright'));
  } catch {
    console.log('Electron 브리지: Playwright가 없어 건너뜁니다.');
    process.exit(0);
  }
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
  await page.waitForFunction(() => document.querySelectorAll('#participant-list li').length === 1, { timeout: 6000 });
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
    { timeout: 8000 },
  ).then(() => true).catch(() => false);

  check('B3 호스트가 바뀌면 새 주소로 알아서 다시 붙는다',
    moved && serverB.playerCount() === 1, `새 호스트 접속자 ${serverB.playerCount()}명`);
  check('B3 다시 붙은 뒤에도 접속 화면으로 돌아가지 않는다',
    !(await page.isVisible('#screen-join')));

  // 4. 다시 붙은 서버에서 정상적으로 게임을 이어갈 수 있다
  await page.fill('#chat-input', '인계 후에도 됩니다');
  await page.press('#chat-input', 'Enter');
  await page.waitForFunction(() => document.querySelector('#chat').textContent.includes('인계 후에도 됩니다'), { timeout: 5000 });
  check('B4 인계된 서버에서 대화가 정상 동작한다', true);

  check('B5 브라우저 콘솔 오류 없음', errors.length === 0, errors.slice(0, 2).join(' | '));
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

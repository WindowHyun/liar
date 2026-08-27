'use strict';

/**
 * 화면(public.js) 통합 테스트 - 실제 Chromium으로 페이지를 띄워서 확인한다.
 * Playwright가 없으면 건너뛴다 (게임 실행에는 필요 없는 개발용 의존성이라 선택 사항).
 *
 * 여기서 잡는 것:
 *   U3 [P1-6] 혼자 시작하면 왜 안 되는지 알려준다
 *   U4 엔터로 채팅이 전송된다 (로비에서 입력창이 잠겨 있지 않은지도 함께 확인)
 *   U5 [P2-20] 새로고침해도 게임 화면과 참가자 목록이 유지된다
 *   U6 [P2-20] 연결이 끊기면 화면에 알린다 (예전에는 아무 반응 없는 화면만 남았다)
 *   U7 브라우저 콘솔에 오류가 없다
 *
 * 한 PC에서는 인스턴스가 하나만 뜨므로(P0-4) 3인 라운드는 여기서 검증할 수 없다.
 * 라운드 진행은 test/round-test.js가 다룬다.
 *
 * 실행: node test/ui-test.js
 */

const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  try {
    ({ chromium } = require('/opt/node22/lib/node_modules/playwright'));
  } catch {
    console.log('화면(브라우저): Playwright가 없어 건너뜁니다. (npm i -D playwright 후 다시 실행)');
    process.exit(0);
  }
}

const ROOT = path.join(__dirname, '..');
const URL = 'http://127.0.0.1:4000';

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
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error('서버가 시간 안에 뜨지 않음'));
        else setTimeout(tick, 100);
      });
    };
    tick();
  });
}

let server = null;
let browser = null;

async function main() {
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { stdio: ['ignore', 'pipe', 'pipe'], cwd: ROOT });
  server.stdout.resume();
  server.stderr.resume();
  await waitForServer(8000);

  browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  await page.goto(URL);
  check('U1 접속 화면이 먼저 보인다',
    (await page.isVisible('#screen-join')) && !(await page.isVisible('#screen-game')));

  await page.fill('#nickname-input', '홍길동');
  await page.click('#join-btn');
  await page.waitForSelector('#participant-list li', { timeout: 5000 });
  check('U2 접속하면 게임 화면으로 넘어가고 내가 목록에 뜬다',
    (await page.textContent('#participant-list')).includes('홍길동'));
  check('U2 [P2-27] 로그 파일 경로가 화면에 보인다',
    (await page.textContent('#log-hint')).includes('liar-game.log'));

  await page.click('#start-btn');
  await page.waitForSelector('#network-banner:not(.hidden)', { timeout: 4000 });
  const banner = (await page.textContent('#network-banner')).trim();
  check('U3 [P1-6] 혼자 시작하면 이유를 알려준다', banner.includes('최소 3명'), banner);
  check('U3 라운드가 시작되지 않았다', !(await page.isVisible('#role-card')));

  await page.fill('#desc-input', '빨갛습니다');
  await page.press('#desc-input', 'Enter');
  await page.waitForSelector('.msg .text', { timeout: 4000 });
  check('U4 로비에서 엔터로 채팅이 전송된다', (await page.textContent('#chat')).includes('빨갛습니다'));

  await page.reload();
  await wait(1000);
  check('U5 [P2-20] 새로고침해도 게임 화면이 유지된다',
    (await page.isVisible('#screen-game')) && !(await page.isVisible('#screen-join')));
  check('U5 [P2-20] 새로고침 후에도 참가자 목록이 복구된다',
    (await page.textContent('#participant-list')).includes('홍길동'));

  // 서버를 일부러 죽이기 "전"에 검사한다. 죽인 뒤의 WebSocket 재연결 실패는
  // 의도된 동작이라 오류로 세면 안 된다.
  check('U7 브라우저 콘솔 오류 없음', errors.length === 0, errors.slice(0, 2).join(' | '));

  server.kill();
  server = null;
  await wait(2000);
  const dead = (await page.textContent('#network-banner')).trim();
  check('U6 [P2-20] 연결이 끊기면 화면에 알린다', dead.includes('연결이 끊어졌습니다'), dead);
}

main()
  .catch((err) => check('실행 중 예외', false, err.message))
  .finally(async () => {
    if (browser) await browser.close().catch(() => {});
    if (server) server.kill();
    await wait(200);
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n화면(브라우저): ${results.length - failed}/${results.length} 통과`);
    process.exit(failed === 0 ? 0 : 1);
  });

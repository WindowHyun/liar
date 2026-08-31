'use strict';

/**
 * 판이 끊기거나 끝난 뒤 "다시 시작"이 되는지 확인한다. 브라우저 5개를 실제로 띄운다.
 *
 *   케이스 1  한 판 완료 → 다음 라운드 시작 (앞판 잔재가 남지 않는지)
 *   케이스 2  중간에 라이어가 나가서 판이 끝남 → 그 사람이 다시 들어와서 시작
 *   케이스 3  게임 중간에 방(서버)이 통째로 사라짐 → 다시 열리면 모두 복귀해서 시작
 *
 * 여기서 잡으려는 것은 "앞 상태가 남아서 다음 판이 이상해지는" 부류다.
 * 규칙 테스트로는 안 잡힌다. 화면이 앞판 상태를 들고 있는 경우가 많기 때문이다.
 *
 * 실행: node test/restart-test.js
 */
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  if (process.env.CI) {
    console.error('다시 시작: Playwright가 설치되지 않았습니다. CI에서는 건너뛸 수 없습니다.');
    process.exit(1);
  }
  console.log('다시 시작: Playwright가 없어 건너뜁니다.');
  process.exit(0);
}

const ROOT = path.join(__dirname, '..');
const OUT = process.env.LIAR_SHOT_DIR || null; // 화면을 남기려면 이 환경변수로 폴더를 준다
const PORT = Number(process.env.PORT) || 4210;
const URL = `http://127.0.0.1:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => console.log(s);
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  log(`      ${ok ? '✓' : '✗ 실패'} ${name}${detail ? `  (${detail})` : ''}`);
}
function up(t) {
  const d = Date.now() + t;
  return new Promise((res, rej) => {
    const tick = () => { const q = http.get(URL, (r) => { r.resume(); res(); }); q.on('error', () => (Date.now() > d ? rej(new Error('서버 안 뜸')) : setTimeout(tick, 120))); };
    tick();
  });
}
let server = null;
async function startServer() {
  server = spawn(process.execPath, [path.join(ROOT, 'web', 'server.js')], { stdio: 'ignore', cwd: ROOT, env: { ...process.env, PORT: String(PORT) } });
  await up(9000);
}
async function speaker(ps) { for (const p of ps) if (await p.page.locator('#composer.my-turn').count()) return p; return null; }

/** 설명 두 바퀴를 다 돌린다. */
async function passTurns(ps) {
  // 바퀴 사이에 "다음 설명 할까요?" O/X가 끼어든다. 전원 찬성으로 넘기며 계속 돈다.
  for (let i = 0; i < ps.length * 4 + 6; i += 1) {
    const sp = await speaker(ps);
    if (sp) {
      await sp.page.fill('#chat-input', `${sp.name}의 설명`);
      await sp.page.press('#chat-input', 'Enter');
      await wait(260);
      continue;
    }
    if (await ps[0].page.locator('#live-block .chip[data-agree="yes"]').count()) {
      await agreeToFreeChat(ps);
      continue;
    }
    break;
  }
}

/** 설명이 끝나면 뜨는 "자유 대화를 할까요?" O/X를 전원 찬성으로 통과시킨다. */
async function agreeToFreeChat(ps) {
  for (const p of ps) {
    // 절반을 넘는 순간 사라지므로 매번 다시 찾는다.
    await p.page.click('#live-block .chip[data-agree="yes"]', { timeout: 2000 }).catch(() => {});
    await wait(200);
  }
}
/** 라이어를 찾아 지목하고 오답을 내게 해서 한 판을 끝낸다. */
async function finishRound(ps, starter) {
  await passTurns(ps);
  await Promise.all(ps.map((p) => p.page.waitForFunction(
    () => document.querySelector('#live-block').textContent.includes('자유 대화 중'), null, { timeout: 8000 })));
  const cards = await Promise.all(ps.map((p) => p.page.textContent('#role-card')));
  const liar = ps[cards.findIndex((c) => c.includes('당신은 Oliveyoung입니다'))];
  const citizens = ps.filter((p) => p !== liar);
  await starter.page.click('#vote-btn');
  await Promise.all(ps.map((p) => p.page.waitForSelector('#live-block .chip', { timeout: 8000 })));
  for (const p of ps.slice(0, Math.ceil(ps.length / 2))) {
    await p.page.click('#live-block .chip[data-agree="yes"]', { timeout: 3000 }).catch(() => {});
    await wait(200);
  }
  await Promise.all(ps.map((p) => p.page.waitForFunction(
    () => document.querySelector('#live-block').textContent.includes('한 명을 고르세요'), null, { timeout: 8000 })));
  for (const c of citizens) { await c.page.click(`#live-block .opt:has-text("${liar.name}")`); await wait(180); }
  await liar.page.click(`#live-block .opt:has-text("${citizens[0].name}")`).catch(() => {});
  await liar.page.waitForSelector('#guess-input', { timeout: 8000 });
  await liar.page.fill('#guess-input', '엉뚱한답');
  await liar.page.press('#guess-input', 'Enter');
  await Promise.all(ps.map((p) => p.page.waitForSelector('#result-panel:not(.hidden)', { timeout: 8000 })));
  return liar;
}

(async () => {
  await startServer();
  const browser = await chromium.launch();
  const errors = [];
  const players = [];
  async function join(name, ctx) {
    const c = ctx || await browser.newContext({ viewport: { width: 1180, height: 780 } });
    const page = await c.newPage();
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      // 서버를 일부러 내린 동안에는 브라우저가 연결 실패를 콘솔에 찍는다. 그건 정상이다.
      if (/ERR_CONNECTION_REFUSED|WebSocket connection to/.test(m.text())) return;
      errors.push(`${name}: ${m.text()}`);
    });
    await page.goto(URL);
    await page.fill('#nickname-input', name);
    await page.click('#join-btn');
    return { name, page, ctx: c };
  }
  for (const name of ['지훈', '서연', '민준', '하은', '도윤']) players.push(await join(name));
  const [p1] = players;
  await p1.page.waitForFunction(() => document.querySelectorAll('#participant-list li').length === 5, null, { timeout: 8000 });

  // ─────────────────────────────────────────────────────────────
  log('\n━━━━━━━ 케이스 1: 한 판 완료 → 새 게임 시작 ━━━━━━━');
  await p1.page.click('#start-btn');
  await Promise.all(players.map((p) => p.page.waitForSelector('#live-block .track .pill', { timeout: 8000 })));
  const liar1 = await finishRound(players, p1);
  log(`  1판 끝: 라이어=${liar1.name}, 시민 승`);
  check('C1 전적이 1판으로 쌓인다', (await p1.page.textContent('#tally-label')).includes('1판'),
    (await p1.page.textContent('#tally-label')).trim());
  check('C1 다음 라운드 버튼이 보인다', await p1.page.isVisible('#start-btn')
    && (await p1.page.textContent('#start-btn')).includes('다음 라운드'));

  await p1.page.click('#start-btn');
  await Promise.all(players.map((p) => p.page.waitForSelector('#live-block .track .pill', { timeout: 8000 })));
  await wait(400);
  const cards2 = await Promise.all(players.map((p) => p.page.textContent('#role-card')));
  check('C1 새 판에서 라이어가 다시 정해진다',
    cards2.filter((c) => c.includes('당신은 Oliveyoung입니다')).length === 1);
  check('C1 새 판은 1차 설명부터 시작한다',
    (await p1.page.textContent('#live-block .round-badge')).trim() === '1차');
  check('C1 전원이 다시 대기 상태다 (앞판 완료 표시가 남지 않는다)',
    !(await p1.page.textContent('#live-block .track')).includes('✅'),
    (await p1.page.textContent('#live-block .track')).replace(/\s+/g, ' ').trim());
  check('C1 결과 카드가 사라진다', await p1.page.isHidden('#result-panel'));
  check('C1 앞판 기록은 대화에 남아 있다',
    (await p1.page.textContent('#chat-messages')).includes('시민 팀 승리'));
  check('C1 전적은 그대로 유지된다', (await p1.page.textContent('#tally-label')).includes('1판'));
  check('C1 앞판 투표 흔적이 남지 않는다 (전원 대기 태그)',
    !(await p1.page.textContent('#participant-list')).includes('투표함'),
    (await p1.page.textContent('#participant-list')).replace(/\s+/g, ' ').trim());
  check('C1 새 판 제시어를 시민 4명이 함께 받는다',
    cards2.filter((c) => c.includes('제시어: ')).length === 4);
  if (OUT) await p1.page.screenshot({ path: `${OUT}/c1-new-round.png` });

  // ─────────────────────────────────────────────────────────────
  log('\n━━━━━━━ 케이스 2: 중간에 라이어 퇴장 → 종료 → 다시 시작 ━━━━━━━');
  const liar2 = players[cards2.findIndex((c) => c.includes('당신은 Oliveyoung입니다'))];
  const rest = players.filter((p) => p !== liar2);
  await passTurns(players); // 자유 대화까지 진행한 뒤
  log(`  라이어 ${liar2.name}님이 게임 도중 [방 나가기]`);
  await liar2.page.click('#leave-btn');
  await Promise.all(rest.map((p) => p.page.waitForSelector('#result-panel:not(.hidden)', { timeout: 8000 })));
  const panel2 = await rest[0].page.textContent('#result-panel');
  check('C2 라이어가 나가면 그 자리에서 판이 끝난다', panel2.includes('시민 팀 승리'),
    panel2.replace(/\s+/g, ' ').trim().slice(0, 60));
  check('C2 누가 라이어였는지 밝혀진다', panel2.includes(liar2.name) && panel2.includes('도중에 나갔습니다'));
  check('C2 전적이 2판이 된다', (await rest[0].page.textContent('#tally-label')).includes('2판'),
    (await rest[0].page.textContent('#tally-label')).trim());
  check('C2 나간 사람은 목록에서 즉시 빠진다',
    (await rest[0].page.textContent('#member-count')).trim() === '4');
  check('C2 남은 사람은 대화할 수 있다', !(await rest[0].page.isDisabled('#chat-input')));
  if (OUT) await rest[0].page.screenshot({ path: `${OUT}/c2-liar-left.png` });

  log(`  ${liar2.name}님이 다시 들어옵니다`);
  await liar2.page.fill('#nickname-input', liar2.name);
  await liar2.page.click('#join-btn');
  await rest[0].page.waitForFunction(() => document.querySelectorAll('#participant-list li').length === 5, null, { timeout: 8000 });
  check('C2 다시 들어오면 5명이 된다', (await rest[0].page.textContent('#member-count')).trim() === '5');
  check('C2 곧바로 다시 시작할 수 있다', !(await rest[0].page.isDisabled('#start-btn')));

  await rest[0].page.click('#start-btn');
  await Promise.all(players.map((p) => p.page.waitForSelector('#live-block .track .pill', { timeout: 8000 })));
  await wait(400);
  const pills3 = await rest[0].page.locator('#live-block .track .pill').count();
  check('C2 돌아온 사람도 이번 판 참가자다 (관전 아님)', pills3 === 5, `${pills3}명`);
  const cards3 = await Promise.all(players.map((p) => p.page.textContent('#role-card')));
  check('C2 돌아온 사람이 역할을 받는다',
    !cards3[players.indexOf(liar2)].includes('역할을 받는 중'), cards3[players.indexOf(liar2)].slice(0, 30));

  // ─────────────────────────────────────────────────────────────
  log('\n━━━━━━━ 케이스 3: 게임 중간에 방이 사라짐 → 다시 시작 ━━━━━━━');
  await passTurns(players);
  log('  판이 진행 중인 상태에서 서버(방)를 통째로 내립니다');
  server.kill('SIGKILL');
  await wait(1500);
  const banner = await p1.page.textContent('#banner').catch(() => '');
  check('C3 끊기면 화면이 알려 준다', banner.includes('연결이 끊어졌'), banner.trim().slice(0, 40));

  log('  방을 다시 엽니다 (빈 방)');
  await startServer();
  await p1.page.waitForFunction(() => {
    const el = document.getElementById('banner');
    return el.classList.contains('hidden');
  }, null, { timeout: 15000 });
  await wait(1500);
  check('C3 알아서 다시 붙는다 (접속 화면으로 튕기지 않는다)',
    !(await p1.page.isVisible('#screen-join')));
  const backCount = (await p1.page.textContent('#member-count')).trim();
  check('C3 전원이 새 방에 다시 모인다', backCount === '5', `${backCount}명`);
  check('C3 새 방은 로비 상태다 (앞판이 남아 있지 않다)',
    await p1.page.isVisible('#start-btn') && await p1.page.isHidden('#result-panel'));
  check('C3 유령이 남지 않는다',
    (await p1.page.locator('#participant-list li').count()) === 5,
    `${await p1.page.locator('#participant-list li').count()}명`);
  const chatAfter = await p1.page.textContent('#chat-messages');
  check('C3 사라진 방의 옛 대화가 남아 있지 않다',
    !chatAfter.includes('시민 팀 승리') && !chatAfter.includes('의 설명'),
    chatAfter.replace(/\s+/g, ' ').trim().slice(0, 50));
  check('C3 새 방이라 전적도 새로 시작한다',
    (await p1.page.textContent('#tally-label')).trim() === '',
    (await p1.page.textContent('#tally-label')).trim() || '(비어 있음)');
  check('C3 나갔다 들어온 사람도 그대로 있다',
    (await p1.page.textContent('#participant-list')).includes(liar2.name));
  if (OUT) await p1.page.screenshot({ path: `${OUT}/c3-after-restart.png` });

  check('C3 곧바로 새 게임을 시작할 수 있다', !(await p1.page.isDisabled('#start-btn')));
  await p1.page.click('#start-btn');
  await Promise.all(players.map((p) => p.page.waitForSelector('#live-block .track .pill', { timeout: 8000 })));
  await wait(400);
  const cards4 = await Promise.all(players.map((p) => p.page.textContent('#role-card')));
  check('C3 새 판이 정상적으로 굴러간다',
    cards4.filter((c) => c.includes('당신은 Oliveyoung입니다')).length === 1
    && (await p1.page.textContent('#live-block .round-badge')).trim() === '1차');
  const sp = await speaker(players);
  check('C3 대화권도 정상 동작한다', !!sp, sp ? `${sp.name} 차례` : '차례인 사람 없음');
  if (OUT) await p1.page.screenshot({ path: `${OUT}/c3-new-game.png` });

  check('브라우저 콘솔 오류 없음', errors.length === 0, errors.slice(0, 3).join(' | '));

  const failed = results.filter((r) => !r.ok).length;
  log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  log(`다시 시작: ${results.length - failed}/${results.length} 통과`);
  await browser.close();
  if (server) server.kill();
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('실행 중 예외:', e.message); if (server) server.kill(); process.exit(1); });

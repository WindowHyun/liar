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

/**
 * 지금 대화권을 가진 창. 화면만 보고 찾는다 - 내부 상태를 들여다보면
 * "서버는 맞는데 화면이 안 따라간" 경우를 놓친다.
 */
async function speakerPage(pages) {
  for (const p of pages) {
    if (await p.page.locator('#composer.my-turn').count()) return p;
  }
  return null;
}

/** 한 사람이 자기 차례를 쓴다. */
async function speakOnce(pages) {
  const sp = await speakerPage(pages);
  if (!sp) return false;
  await sp.page.fill('#chat-input', `${sp.name}의 설명입니다`);
  await sp.page.press('#chat-input', 'Enter');
  await wait(300);
  return true;
}

/** 지금 바퀴에서 아직 말하지 않은 사람들만 말하게 한다(한 바퀴). */
async function finishOneRound(pages) {
  for (let i = 0; i < pages.length + 1; i += 1) {
    if (!(await speakOnce(pages))) return;
    const badge = await pages[0].page.textContent('#live-block .round-badge').catch(() => null);
    if (badge && badge.trim() !== '1차') return; // 다음 바퀴로 넘어갔다
  }
}

/** 정해진 바퀴를 모두 돌아 설명 단계를 끝낸다. */
async function finishExplanations(pages) {
  for (let guard = 0; guard < pages.length * 3 + 3; guard += 1) {
    if (!(await speakOnce(pages))) return;
  }
}

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
  await p1.page.waitForFunction(() => document.querySelectorAll('#participant-list li').length === 3, null, { timeout: 6000 });
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

  // ── 설명 단계: 랜덤으로 대화권을 넘기며 한 명씩. 1인 1회. ──
  await Promise.all(pages.map((p) => p.page.waitForSelector('#live-block .track .pill', { timeout: 5000 })));
  const speaking = await Promise.all(pages.map((p) => p.page.locator('#composer.my-turn').count()));
  check('X3 대화권은 한 번에 한 명에게만 간다',
    speaking.filter(Boolean).length === 1, speaking.join(','));

  const first = await speakerPage(pages);
  const others = pages.filter((p) => p !== first);
  check('X3 차례가 아닌 사람의 입력창은 잠긴다',
    (await others[0].page.isDisabled('#chat-input')) && (await others[1].page.isDisabled('#chat-input')));
  check('X3 차례가 아닌 사람에게 누구 차례인지 알려 준다',
    (await others[0].page.getAttribute('#chat-input', 'placeholder')).includes(first.name),
    await others[0].page.getAttribute('#chat-input', 'placeholder'));
  check('X3 설명 중에는 투표를 제안할 수 없다', await p1.page.isDisabled('#vote-btn'));

  await first.page.fill('#chat-input', '빨갛습니다');
  await first.page.press('#chat-input', 'Enter');
  await others[0].page.waitForFunction(() => document.querySelector('#chat').textContent.includes('빨갛습니다'), null, { timeout: 5000 });
  check('X3 대화가 모두에게 보인다', (await others[1].page.textContent('#chat')).includes('빨갛습니다'));

  await first.page.waitForFunction(() => !document.querySelector('#composer.my-turn'), null, { timeout: 5000 });
  check('X3 [요청] 대화권은 1인 1회 - 말하고 나면 바로 잠긴다',
    await first.page.isDisabled('#chat-input'));
  check('X3 설명을 마친 사람은 목록에 완료로 표시된다',
    (await first.page.textContent('#live-block .track')).includes('✅'));
  check('X3 [규칙] 지금이 몇 차 설명인지 보인다',
    (await p1.page.textContent('#live-block .round-badge')).trim() === '1차',
    await p1.page.textContent('#live-block .round-badge'));

  // 한 바퀴를 다 돌면 자유 대화가 아니라 2차 설명으로 넘어간다
  await finishOneRound(pages);
  await p1.page.waitForFunction(
    () => (document.querySelector('#live-block .round-badge') || {}).textContent === '2차',
    { timeout: 5000 });
  check('X3 [규칙] 1차를 다 돌면 2차 설명으로 넘어간다 (자유 대화가 아니다)',
    (await p1.page.textContent('#chat-messages')).includes('2차 설명을 시작합니다'));
  check('X3 [규칙] 2차에서는 전원이 다시 대기 상태가 된다',
    !(await p1.page.textContent('#live-block .track')).includes('✅'),
    (await p1.page.textContent('#live-block .track')).replace(/\s+/g, ' ').trim());

  // 2차까지 마치면 자유 채팅이 열린다
  await finishExplanations(pages);
  await Promise.all(pages.map((p) => p.page.waitForFunction(
    () => document.querySelector('#live-block').textContent.includes('자유 대화 중'), null, { timeout: 5000 })));
  check('X3 [규칙] 2차까지 마쳐야 자유 채팅으로 넘어간다',
    (await p1.page.textContent('#chat-messages')).includes('2차 설명까지 끝났습니다'));
  // 대화에 남는 기록과 진행 블록이 같은 문장을 두 번 찍지 않는다
  check('X3 자유 채팅 안내가 두 번 찍히지 않는다',
    (await p1.page.textContent('#chat')).split('자유롭게 이야기하세요').length === 2);
  check('X3 자유 채팅에서는 전원의 입력창이 열린다',
    !(await p1.page.isDisabled('#chat-input')) && !(await p3.page.isDisabled('#chat-input')));
  check('X3 자유 채팅부터 투표를 제안할 수 있다', !(await p1.page.isDisabled('#vote-btn')));

  // 알림 띠는 대화가 넘칠 때만 의미가 있다. 스크롤이 생기도록 충분히 채운다.
  for (let i = 0; i < 14; i += 1) {
    await p1.page.fill('#chat-input', `이야기를 이어갑니다 ${i + 1}`);
    await p1.page.press('#chat-input', 'Enter');
  }
  await p1.page.waitForFunction(() => {
    const box = document.getElementById('chat');
    return box.scrollHeight > box.clientHeight + 60;
  }, null, { timeout: 5000 });

  // 투표 제안 - 먼저 다 같이 O/X로 진행 여부를 정한다.
  // 찬반·투표는 대화 흐름 안(#live-block)에 들여쓰여 나온다.
  await p1.page.click('#vote-btn');
  await Promise.all(pages.map((p) => p.page.waitForSelector('#live-block .chip', { timeout: 5000 })));
  check('X4 투표 버튼을 누르면 전원 대화창에 O/X 칩이 뜬다',
    (await p2.page.textContent('#live-block')).includes('진행할까요'));
  check('X4 체크·X 이모지로 나온다',
    (await p2.page.textContent('#live-block .chip[data-agree="yes"]')).includes('✅') &&
    (await p2.page.textContent('#live-block .chip[data-agree="no"]')).includes('❌'));
  check('X4 [이슈1] 찬반 단계부터 대화가 잠긴다', await p1.page.isDisabled('#chat-input'));
  check('X4 [이슈1] 왜 잠겼는지 입력창이 알려 준다',
    (await p1.page.getAttribute('#chat-input', 'placeholder')).includes('투표가 끝날 때까지'),
    await p1.page.getAttribute('#chat-input', 'placeholder'));

  // 3명 중 1명만 O를 눌러도 아직 33%라 진행되지 않는다
  await p1.page.click('#live-block .chip[data-agree="yes"]');
  await wait(400);
  check('X4 찬성 1/3이면 아직 투표로 넘어가지 않는다',
    (await p2.page.textContent('#live-block')).includes('진행할까요'));

  // 두 번째 O로 2/3 → 50% 이상이라 투표로 넘어간다
  await p2.page.click('#live-block .chip[data-agree="yes"]');
  await Promise.all(pages.map((p) => p.page.waitForSelector('#live-block .opt, #live-block .meta-line', { timeout: 5000 })));
  check('X4 찬성이 절반을 넘으면 투표로 넘어간다',
    (await p1.page.textContent('#live-block')).includes('한 명을 고르세요'));
  check('X4 투표 중에는 대화가 잠긴다', await p1.page.isDisabled('#chat-input'));

  // [2번] 위로 올라가 있으면 하단에 진행 중이라고 알리는 띠가 뜬다.
  // 투표가 대화 안으로 들어가면서 생긴 위험이라 여기서 고정한다.
  check('X4 맨 아래를 보고 있을 때는 알림 띠가 없다', !(await p1.page.isVisible('#jump-bar')));
  await p1.page.evaluate(() => { document.getElementById('chat').scrollTop = 0; });
  await wait(300);
  check('X4 [2번] 위로 올리면 "투표가 진행 중입니다" 띠가 뜬다',
    (await p1.page.isVisible('#jump-bar')) &&
    (await p1.page.textContent('#jump-bar')).includes('투표가 진행 중'),
    (await p1.page.textContent('#jump-bar')).trim());
  await p1.page.click('#jump-bar');
  await wait(300);
  check('X4 [2번] 띠를 누르면 맨 아래로 내려가고 띠가 사라진다',
    !(await p1.page.isVisible('#jump-bar')));

  const liarName = pages[liarIndex].name;
  for (let i = 0; i < pages.length; i += 1) {
    const target = i === liarIndex ? pages[(i + 1) % pages.length].name : liarName;
    await pages[i].page.click(`#live-block .opt:has-text("${target}")`);
  }

  // 라이어가 지목됐으므로 정답 단계
  await pages[liarIndex].page.waitForSelector('#guess-input', { timeout: 5000 });
  check('X5 지목된 라이어에게만 정답창이 뜬다',
    (await pages[(liarIndex + 1) % 3].page.locator('#guess-input').count()) === 0);

  // 요청: "System : ○○○이 (라이어)로 지목되었습니다"
  const accusedLine = await pages[0].page.textContent('#chat-messages');
  check('X5 지목 안내가 System 메시지로 나온다',
    accusedLine.includes(liarName + '님이 Oliveyoung으로 지목되었습니다'),
    accusedLine.split('\n').map((t) => t.trim()).filter(Boolean).slice(-1)[0]);

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

  // 요청한 화면 문구·배치
  check('X8 전적이 사이드바 하단에 버전처럼 표시된다',
    (await p1.page.textContent('#tally-label')).includes('판 ·'),
    (await p1.page.textContent('#tally-label')).trim());
  check('X8 사이드바 목록 제목이 Oliveyoung이다',
    (await p1.page.textContent('#sidebar .label')).trim() === 'Oliveyoung');
  check('X8 인원수가 허들 버튼 왼쪽에 숫자로 나온다',
    (await p1.page.textContent('#member-count')).trim() === '3');
  check('X8 투표 버튼이 헤드셋이다',
    (await p1.page.textContent('#vote-btn')).trim() === '🎧');
  check('X8 입력창 안내가 "댓글 남기기..."다',
    (await p1.page.getAttribute('#chat-input', 'placeholder')) === '댓글 남기기...');
  check('X8 전송 버튼이 종이비행기 아이콘이다',
    (await p1.page.locator('#send-btn svg').count()) === 1);

  // ── 방 나가기: 유예 없이 즉시, 그리고 남은 사람은 갇히지 않는다 ──
  await p1.page.click('#start-btn');
  await Promise.all(pages.map((p) => p.page.waitForSelector('#live-block .track .pill', { timeout: 5000 })));
  check('X10 다음 라운드가 시작됐다', (await p1.page.textContent('#live-block')).includes('설명'));

  // 라이어가 나가면 판이 취소되므로, 판이 이어지는지 보려면 시민이 나가야 한다.
  const cards2 = await Promise.all(pages.map((p) => p.page.textContent('#role-card')));
  const liar2 = pages[cards2.findIndex((c) => c.includes('당신은 Oliveyoung입니다'))];
  const citizens = pages.filter((p) => p !== liar2);

  await citizens[0].page.click('#leave-btn');
  await liar2.page.waitForFunction(
    () => document.querySelectorAll('#participant-list li').length === 2, null, { timeout: 5000 });
  check('X10 [요청] 나가기를 누르면 남은 사람 목록에서 즉시 사라진다',
    !(await liar2.page.textContent('#participant-list')).includes(citizens[0].name),
    (await liar2.page.textContent('#participant-list')).replace(/\s+/g, ' ').trim());
  check('X10 나간 사람은 접속 화면으로 돌아간다',
    (await citizens[0].page.isVisible('#screen-join')) && !(await citizens[0].page.isVisible('#screen-game')));
  check('X10 시민 한 명이 빠져도 남은 2명은 라운드를 이어간다',
    (await liar2.page.locator('#live-block .track .pill').count()) === 3
    && (await liar2.page.isHidden('#start-btn')));

  await citizens[1].page.click('#leave-btn');
  await liar2.page.waitForFunction(
    () => !document.getElementById('start-btn').classList.contains('hidden'), null, { timeout: 5000 });
  check('X10 [이슈] 혼자 남으면 라운드가 그 자리에서 취소되고 로비로 돌아온다',
    (await liar2.page.textContent('#chat-messages')).includes('라운드가 취소되었습니다'));
  check('X10 [이슈] 혼자 남아도 게임 시작 버튼이 다시 보인다',
    await liar2.page.isVisible('#start-btn'));

  // 나갔던 사람이 다시 들어오면 바로 시작할 수 있어야 한다
  await citizens[0].page.fill('#nickname-input', citizens[0].name);
  await citizens[0].page.click('#join-btn');
  await liar2.page.waitForFunction(
    () => !document.getElementById('start-btn').disabled, null, { timeout: 5000 });
  check('X10 [이슈] 다시 2명이 되면 곧바로 시작할 수 있다',
    !(await liar2.page.isDisabled('#start-btn')));

  // ── 라이어가 나가면 판이 취소된다 ──
  await liar2.page.click('#start-btn');
  const here = [liar2, citizens[0]];
  await Promise.all(here.map((p) => p.page.waitForSelector('#live-block .track .pill', { timeout: 5000 })));
  const cards3 = await Promise.all(here.map((p) => p.page.textContent('#role-card')));
  const liar3 = here[cards3.findIndex((c) => c.includes('당신은 Oliveyoung입니다'))];
  const stays = here.find((p) => p !== liar3);

  await liar3.page.click('#leave-btn');
  await stays.page.waitForSelector('#result-panel:not(.hidden)', { timeout: 5000 });
  check('X11 [요청] 라이어가 도망가면 시민 승으로 끝난다',
    (await stays.page.textContent('#result-panel')).includes('시민 팀 승리'),
    (await stays.page.textContent('#result-panel')).replace(/\s+/g, ' ').trim().slice(0, 70));
  check('X11 [요청] 누가 라이어였는지 밝힌다',
    (await stays.page.textContent('#result-panel')).includes(liar3.name)
    && (await stays.page.textContent('#result-panel')).includes('도중에 나갔습니다'));
  check('X11 시민 승으로 전적에 쌓인다',
    (await stays.page.textContent('#tally-label')).includes('시민 2'),
    (await stays.page.textContent('#tally-label')).trim() || '(비어 있음)');
  check('X11 끝난 뒤에는 대화가 잠기지 않는다', !(await stays.page.isDisabled('#chat-input')));

  // ── 대화가 상한(100줄)을 넘어도 화면이 멈추지 않는다 ──
  // 길이만 보고 다시 그리면, 한 줄 밀어내고 한 줄 넣느라 길이가 그대로여서
  // 100줄이 넘는 순간부터 새 글이 화면에 안 붙는다.
  // 라이어가 나가서 혼자 남았으니, 다시 두 명을 만들어야 시작할 수 있다.
  await liar3.page.fill('#nickname-input', liar3.name);
  await liar3.page.click('#join-btn');
  await stays.page.waitForFunction(
    () => !document.getElementById('start-btn').disabled, null, { timeout: 5000 });
  await stays.page.click('#start-btn');
  await Promise.all(here.map((p) => p.page.waitForSelector('#live-block .track .pill', { timeout: 5000 })));
  await finishExplanations(here);
  await stays.page.waitForFunction(
    () => !document.getElementById('chat-input').disabled, null, { timeout: 5000 });

  // 속도 제한(5초에 60개)에 걸리지 않게 나눠 보낸다
  for (let batch = 0; batch < 3; batch += 1) {
    await stays.page.evaluate((n) => {
      for (let i = 0; i < 40; i += 1) window.ws.send(JSON.stringify({ type: 'chat', text: `줄 ${n * 40 + i}` }));
    }, batch);
    await wait(5200);
  }
  await wait(600);
  const chatText = await stays.page.textContent('#chat-messages');
  check('X12 대화가 100줄을 넘어도 새 글이 계속 붙는다',
    chatText.includes('줄 119'), `마지막 40자: ${chatText.replace(/\s+/g, ' ').trim().slice(-40)}`);
  check('X12 오래된 글은 밀려난다 (무한정 쌓이지 않는다)', !chatText.includes('줄 0 '));

  // ── 예전 버전 서버에 붙었을 때 (롤아웃 중 섞이는 상황) ──
  // v0.8.0 이하는 화면이 보내는 연결 확인(ping)을 모른다. 거절당한 것을 그대로 배너로
  // 띄우면 20초마다 "잘못된 요청입니다"가 떠서 고장난 것처럼 보인다.
  await oldServerCheck(browser);

  check('X9 브라우저 콘솔 오류 없음', errors.length === 0, errors.slice(0, 2).join(' | '));
}

/**
 * 예전 버전 서버를 흉내낸다. 정적 파일은 그대로 내려 주되, ping은 "알 수 없는 요청"으로
 * 거절한다(v0.8.0 이하가 그렇게 동작한다).
 */
async function oldServerCheck(browser) {
  const OLD_PORT = PORT + 3;
  const PUBLIC_DIR = path.join(ROOT, 'web', 'public');
  const fs = require('fs');
  const { WebSocketServer } = require('ws');
  const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png' };

  let rejected = 0;
  const srv = http.createServer((req, res) => {
    const name = (req.url || '/').split('?')[0] === '/' ? 'index.html' : path.basename(req.url);
    fs.readFile(path.join(PUBLIC_DIR, name), (err, data) => {
      if (err) { res.writeHead(404); res.end('없음'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(name)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  await new Promise((r) => srv.listen(OLD_PORT, '127.0.0.1', r));
  const wss = new WebSocketServer({ server: srv });
  wss.on('connection', (sock) => {
    sock.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'ping') {                       // 예전 버전은 이걸 모른다
        rejected += 1;
        sock.send(JSON.stringify({ type: 'error', message: '잘못된 요청입니다.' }));
        return;
      }
      if (m.type === 'join') {
        sock.send(JSON.stringify({ type: 'welcome', playerId: 'old1', token: 'tok' }));
        sock.send(JSON.stringify({
          type: 'state', phase: 'lobby', serverTime: Date.now(), minPlayers: 2,
          you: { id: 'old1', nickname: '옛날이', inRound: false },
          players: [{ id: 'old1', nickname: '옛날이', connected: true, inRound: false }],
          round: null, result: null, record: { rounds: 0, liarWins: 0, citizenWins: 0 },
          chat: [], canStart: false,
        }));
      }
    });
  });

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const banners = [];
  await page.goto(`http://127.0.0.1:${OLD_PORT}`);
  await page.fill('#nickname-input', '옛날이');
  await page.click('#join-btn');
  await page.waitForSelector('#screen-game:not(.hidden)', { timeout: 5000 });

  // 확인 요청 주기(20초)를 실제로 기다리는 대신, 화면이 쓰는 것과 같은 방식으로 한 번 보낸다.
  await page.evaluate(() => { window.pingSentAt = Date.now(); window.ws.send(JSON.stringify({ type: 'ping' })); });
  await wait(600);
  const shown = await page.isVisible('#banner');
  banners.push(shown);
  check('X13 예전 버전 서버가 확인 요청을 거절해도 오류 배너를 띄우지 않는다',
    !shown, shown ? await page.textContent('#banner') : '');
  check('X13 대신 예전 버전이라고 알려 준다',
    (await page.textContent('#conn-hint')).includes('예전 버전'),
    (await page.textContent('#conn-hint')).trim() || '(비어 있음)');
  check('X13 거절을 실제로 받았다 (검사가 겉돌지 않았다)', rejected > 0, `${rejected}회`);

  await ctx.close();
  wss.close();
  await new Promise((r) => srv.close(r));
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

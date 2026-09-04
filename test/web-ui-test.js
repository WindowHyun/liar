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
const { createGameServer } = require('../web/game-server');

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
    // 배지가 사라졌을 때 기본 30초를 기다리지 않도록 짧게 끊는다.
    const badge = await pages[0].page.textContent('#live-block .round-badge', { timeout: 1000 }).catch(() => null);
    if (badge && badge.trim() !== '1차') return; // 다음 바퀴로 넘어갔다
  }
}

/** 정해진 바퀴를 모두 돌아 설명 단계를 끝낸다. */
async function finishExplanations(pages) {
  // 바퀴 사이에 "다음 설명 할까요?" O/X가 끼어든다. 전원 찬성으로 통과시키며 계속 돈다.
  for (let guard = 0; guard < pages.length * 4 + 6; guard += 1) {
    if (await speakOnce(pages)) continue;
    if (await agreeOnAsk(pages)) continue;
    break;
  }
  await agreeToFreeChat(pages);
}

/** O/X가 떠 있으면 전원 찬성을 누른다. 눌렀으면 true. */
async function agreeOnAsk(pages) {
  if (!(await pages[0].page.locator('#live-block .chip[data-agree="yes"]').count())) return false;
  for (const p of pages) {
    // 절반을 넘는 순간 사라지므로 매번 다시 찾는다.
    const yes = p.page.locator('#live-block .chip[data-agree="yes"]');
    if (await yes.count()) await yes.click().catch(() => {});
    await wait(180);
  }
  return true;
}

/**
 * 설명을 다 돌면 "자유 대화를 할까요?" O/X가 뜬다. 전원 찬성으로 통과시켜 자유 대화를 연다.
 * (그 O/X 자체를 보는 테스트는 이 도우미를 쓰지 않고 직접 누른다.)
 */
async function agreeToFreeChat(pages) {
  await agreeOnAsk(pages);
  await pages[0].page.waitForFunction(
    () => document.querySelector('#live-block').textContent.includes('자유 대화 중'),
    null, { timeout: 5000 });
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
  const liars = cards.filter((c) => c.includes('담당자입니다'));
  check('X2 라이어는 정확히 한 명', liars.length === 1, `${liars.length}명`);
  check('X2 라이어 화면에는 제시어가 없다', liars[0].includes('제시어는 모릅니다'));

  const citizenCards = cards.filter((c) => !c.includes('담당자입니다'));
  const word = citizenCards[0].split('제시어: ')[1].trim();
  check('X2 시민 두 명은 같은 제시어를 본다', citizenCards.every((c) => c.includes(word)), `제시어=${word}`);

  // 라이어의 브라우저 어디에도 제시어가 없어야 한다
  const liarIndex = cards.findIndex((c) => c.includes('담당자입니다'));
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
  // [규칙 변경] 한 바퀴가 끝나면 2차를 할지 먼저 묻는다.
  await Promise.all(pages.map((p) => p.page.waitForSelector('#live-block .chip', { timeout: 5000 })));
  check('X3 [요청] 한 바퀴가 끝나면 다음 설명을 할지 묻는다',
    (await p1.page.textContent('#chat-messages')).includes('2차 설명을 할까요?'));
  check('X3 정하는 동안에는 대화가 잠긴다', await p1.page.isDisabled('#chat-input'));
  await agreeOnAsk(pages);

  await p1.page.waitForFunction(
    () => (document.querySelector('#live-block .round-badge') || {}).textContent === '2차',
    null, { timeout: 5000 });
  check('X3 [규칙] 찬성하면 2차 설명으로 넘어간다 (자유 대화가 아니다)',
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
  check('X3 [요청] 자유 대화 전에 할지 말지를 물었다',
    (await p1.page.textContent('#chat-messages')).includes('자유 대화를 할까요?'));
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

  // 요청: "Slack bot : ○○○이 (담당자)로 지목되었습니다"
  const accusedLine = await pages[0].page.textContent('#chat-messages');
  check('X5 지목 안내가 Slack bot 메시지로 나온다',
    accusedLine.includes(liarName + '님이 담당자로 지목되었습니다'),
    accusedLine.split('\n').map((t) => t.trim()).filter(Boolean).slice(-1)[0]);

  await pages[liarIndex].page.fill('#guess-input', '전혀다른답');
  await pages[liarIndex].page.press('#guess-input', 'Enter');

  // [요청] 결과는 팝업이 아니라 대화 속 카드(.result-card)로 남는다.
  await Promise.all(pages.map((p) => p.page.waitForSelector('.result-card', { timeout: 5000 })));
  const panels = await Promise.all(pages.map((p) => p.page.locator('.result-card').last().textContent()));
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
    (await p2.page.locator('.result-card').last().textContent()).includes('시민 팀 승리'));

  // 요청한 화면 문구·배치
  check('X8 전적이 사이드바 하단에 버전처럼 표시된다',
    (await p1.page.textContent('#tally-label')).includes('판 ·'),
    (await p1.page.textContent('#tally-label')).trim());
  check('X8 [요청] 사이드바 목록 제목이 다이렉트 메시지다',
    (await p1.page.textContent('#sidebar .label')).trim() === '다이렉트 메시지');
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
  const liar2 = pages[cards2.findIndex((c) => c.includes('담당자입니다'))];
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
  const liar3 = here[cards3.findIndex((c) => c.includes('담당자입니다'))];
  const stays = here.find((p) => p !== liar3);

  await liar3.page.click('#leave-btn');
  // 이번이 이 방의 두 번째 결과 카드다(첫 번째는 X6에서 이미 남았다).
  await stays.page.waitForFunction(
    () => document.querySelectorAll('.result-card').length > 1, null, { timeout: 5000 });
  check('X11 [요청] 라이어가 도망가면 시민 승으로 끝난다',
    (await stays.page.locator('.result-card').last().textContent()).includes('시민 팀 승리'),
    (await stays.page.locator('.result-card').last().textContent()).replace(/\s+/g, ' ').trim().slice(0, 70));
  check('X11 [요청] 누가 라이어였는지 밝힌다',
    (await stays.page.locator('.result-card').last().textContent()).includes(liar3.name)
    && (await stays.page.locator('.result-card').last().textContent()).includes('도중에 나갔습니다'));
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
  await mentionCheck(browser);
  await chatRedrawRecoversCheck(browser);
  await bannerAutoHideCheck(browser);
  await spectatorBannerCheck(browser);
  await oldServerCheck(browser);
  await slackLookCheck(browser);

  check('X9 브라우저 콘솔 오류 없음', errors.length === 0, errors.slice(0, 2).join(' | '));
}

/**
 * X17 [요청] "@닉네임"으로 사람을 부른다.
 *
 * 부른 자리는 파랗게, 나를 부른 말은 줄 전체를 눈에 띄게 그린다.
 * 누구를 부른 것인지는 서버가 정하므로, 여기서는 화면이 그걸 제대로 그리는지만 본다.
 */
async function mentionCheck(browser) {
  const own = createGameServer({ port: PORT + 8 });
  await own.start();
  const ctxs = [];
  const join = async (name) => {
    const ctx = await browser.newContext();
    ctxs.push(ctx);
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${PORT + 8}`);
    await page.fill('#nickname-input', name);
    await page.click('#join-btn');
    return page;
  };
  const me = await join('영희');
  const other = await join('철수');
  await me.waitForFunction(() => document.querySelectorAll('#participant-list li').length === 2, null, { timeout: 6000 });

  // 철수가 영희를 부른다
  await other.fill('#chat-input', '@영희 이거 뭐야');
  await other.press('#chat-input', 'Enter');
  await me.waitForFunction(() => document.querySelector('#chat').textContent.includes('이거 뭐야'), null, { timeout: 5000 });

  check('X17 [요청] 부른 자리가 눈에 띄게 그려진다',
    (await me.textContent('#chat-messages .mention')) === '@영희',
    await me.textContent('#chat-messages .mention'));
  check('X17 부른 자리 말고는 글자가 그대로다',
    (await me.textContent('#chat-messages')).includes('@영희 이거 뭐야'));
  check('X17 [요청] 나를 부른 말은 줄 전체가 강조된다',
    (await me.locator('#chat-messages .msg.mentions-me').count()) === 1,
    String(await me.locator('#chat-messages .msg.mentions-me').count()));
  check('X17 부른 사람 본인 화면에는 줄 강조가 없다',
    (await other.locator('#chat-messages .msg.mentions-me').count()) === 0);
  check('X17 부른 사람 화면에도 파란 표시는 보인다',
    (await other.locator('#chat-messages .mention').count()) === 1);

  // 이름이 아닌 @는 그냥 글자다
  await other.fill('#chat-input', '메일은 a@b.com 이야');
  await other.press('#chat-input', 'Enter');
  await me.waitForFunction(() => document.querySelector('#chat').textContent.includes('a@b.com'), null, { timeout: 5000 });
  check('X17 이름이 아닌 @는 표시하지 않는다',
    (await me.locator('#chat-messages .mention').count()) === 1,
    String(await me.locator('#chat-messages .mention').count()));

  // 꺾쇠가 들어간 닉네임을 불러도 글자로만 보여야 한다(태그로 새지 않는다)
  const tricky = await join('<b>굵게</b>');
  await tricky.waitForFunction(() => document.querySelectorAll('#participant-list li').length === 3, null, { timeout: 6000 });
  await other.fill('#chat-input', '@<b>굵게</b> 안녕');
  await other.press('#chat-input', 'Enter');
  await me.waitForFunction(() => document.querySelector('#chat').textContent.includes('안녕'), null, { timeout: 5000 });
  check('X17 닉네임에 태그 문자가 있어도 글자로만 보인다',
    (await me.locator('#chat-messages b').count()) === 0
      && (await me.textContent('#chat-messages')).includes('@<b>굵게</b>'),
    `b태그 ${await me.locator('#chat-messages b').count()}개`);

  for (const ctx of ctxs) await ctx.close();
  await own.stop();
}

/**
 * X16 [이슈] 대화를 그리다 한 줄에서 문제가 생기면 그 뒤로 대화창이 비어 있었다.
 *
 * 다시 그릴지 판단하는 지문을 그리기 "전에" 남겼다. 그래서 도중에 예외가 나면 이미
 * 비워 둔 대화창이 빈 채로 남는데, 지문은 최신이라 "그릴 것이 없다"고 판단해 버린다.
 * 새 대화가 오면 지문이 달라져 다시 그려지지만, 그 전까지 - 투표든 단계 전환이든
 * 대화가 아닌 변화가 아무리 일어나도 - 대화창은 계속 비어 있다.
 *
 * 지문을 다 그린 뒤에 남기면 다음 상태 갱신에서 곧바로 다시 그려 회복한다.
 * (그래서 이 테스트는 "새 대화"가 아니라 "대화가 아닌 변화"로 확인한다.
 *  새 대화로 확인하면 고치기 전에도 통과해서 아무것도 잡지 못한다.)
 */
async function chatRedrawRecoversCheck(browser) {
  const own = createGameServer({ port: PORT + 7 });
  await own.start();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${PORT + 7}`);
  await page.fill('#nickname-input', '회복');
  await page.click('#join-btn');
  await page.waitForSelector('#screen-game:not(.hidden)', { timeout: 5000 });

  const ctx2 = await browser.newContext();
  const other = await ctx2.newPage();
  await other.goto(`http://127.0.0.1:${PORT + 7}`);
  await other.fill('#nickname-input', '상대');
  await other.click('#join-btn');
  await wait(400);

  await other.fill('#chat-input', '첫 줄');
  await other.press('#chat-input', 'Enter');
  await page.waitForFunction(() => document.querySelector('#chat').textContent.includes('첫 줄'), null, { timeout: 5000 });

  // 다음 한 번만 그리기가 실패하게 만든다(한 줄이 이상해서 터지는 상황을 흉내낸다).
  await page.evaluate(() => {
    const real = window.messageShell;
    let fired = false;
    window.messageShell = function (o) {
      if (!fired) { fired = true; throw new Error('테스트: 한 줄 그리기 실패'); }
      return real(o);
    };
  });
  await other.fill('#chat-input', '터지는 줄');
  await other.press('#chat-input', 'Enter');
  await wait(700);
  check('X16 그리다 실패하면 그 순간에는 대화가 비어 있다',
    (await page.textContent('#chat-messages')).trim() === '',
    (await page.textContent('#chat-messages')).trim().slice(0, 40) || '(빈 화면)');

  // 대화가 아닌 변화(사람이 한 명 더 들어옴)만으로 회복해야 한다.
  // 참가는 대화 줄을 남기지 않으므로 대화 지문은 그대로다 - 고치기 전에는 여기서 안 그렸다.
  const ctx3 = await browser.newContext();
  const third = await ctx3.newPage();
  await third.goto(`http://127.0.0.1:${PORT + 7}`);
  await third.fill('#nickname-input', '세번째');
  await third.click('#join-btn');
  await page.waitForFunction(
    () => document.querySelectorAll('#participant-list li').length === 3, null, { timeout: 5000 });
  await wait(500);

  const text = await page.textContent('#chat-messages');
  check('X16 [이슈] 대화가 아닌 변화만으로도 스스로 회복한다',
    text.includes('첫 줄') && text.includes('터지는 줄'),
    text.replace(/\s+/g, ' ').trim().slice(0, 60) || '(빈 화면)');

  await ctx.close();
  await ctx2.close();
  await ctx3.close();
  await own.stop();
}

/**
 * X15 [이슈] 같은 안내가 자동 숨김 시간 안에 두 번 뜨면 영영 남았다.
 *
 * 글자가 같으면 다시 그리지 않도록 막아 둔 곳에서, 이미 꺼 놓은 자동 숨김 타이머를
 * 다시 걸지 않고 빠져나갔다. 연결이 끊긴 채 시작 버튼을 두 번 누르는 것처럼
 * 같은 안내가 연달아 뜨는 상황이 흔해서, 5초 뒤 사라져야 할 안내가 계속 떠 있었다.
 */
async function bannerAutoHideCheck(browser) {
  // 배너는 #screen-game 안에 있다. 접속 화면에서는 어차피 안 보이므로 먼저 들어간다.
  const own = createGameServer({ port: PORT + 6 });
  await own.start();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${PORT + 6}`);
  await page.fill('#nickname-input', '배너');
  await page.click('#join-btn');
  await page.waitForSelector('#screen-game:not(.hidden)', { timeout: 5000 });

  // 화면이 실제로 쓰는 함수를 그대로 부른다.
  await page.evaluate(() => { window.showBanner('warn', '같은 안내', 800); });
  check('X15 안내가 뜬다', !(await page.isHidden('#banner')));

  await wait(200);
  await page.evaluate(() => { window.showBanner('warn', '같은 안내', 800); });  // 같은 글자로 한 번 더
  check('X15 두 번째에도 그대로 떠 있다', !(await page.isHidden('#banner')));

  await wait(1400);
  check('X15 [이슈] 같은 안내가 두 번 떠도 자동으로 사라진다',
    await page.isHidden('#banner'),
    (await page.textContent('#banner')).trim() || '(숨김)');

  // 자동 숨김이 없는 안내(관전 등)는 그대로 남아야 한다
  await page.evaluate(() => { window.showBanner('ok', '계속 떠 있어야 하는 안내', 0); });
  await wait(1000);
  check('X15 자동 숨김이 없는 안내는 남는다', !(await page.isHidden('#banner')));

  await ctx.close();
  await own.stop();
}

/**
 * X14 [이슈] 관전자가 참가자로 바뀌어도 관전 안내가 남아 있었다.
 *
 * 배너를 띄우기만 하고 내리는 쪽이 없었다. 다음 판이 시작돼 본인 차례가 됐는데도
 * "이번 라운드는 관전합니다"가 그대로 떠 있어서, 말해도 되는지 알 수 없었다.
 */
async function spectatorBannerCheck(browser) {
  // 앞선 테스트가 쓰던 방에는 사람과 판이 남아 있다. 깨끗한 방에서 본다.
  const own = createGameServer({ port: PORT + 5 });
  await own.start();
  const ownUrl = `http://127.0.0.1:${PORT + 5}`;

  const ctxs = [];
  const join = async (name) => {
    const ctx = await browser.newContext();
    ctxs.push(ctx);
    const page = await ctx.newPage();
    await page.goto(ownUrl);
    await page.fill('#nickname-input', name);
    await page.click('#join-btn');
    return page;
  };

  const a = await join('먼저1');
  const b = await join('먼저2');
  await a.waitForFunction(() => !document.getElementById('start-btn').disabled, null, { timeout: 6000 });
  await a.click('#start-btn');
  await a.waitForSelector('#role-card:not(.hidden)', { timeout: 5000 });

  // 진행 중에 들어온다 → 이번 판은 관전
  const late = await join('늦둥이');
  await late.waitForFunction(
    () => !document.getElementById('banner').classList.contains('hidden'), null, { timeout: 6000 });
  check('X14 진행 중에 들어오면 관전 안내가 뜬다',
    (await late.textContent('#banner')).includes('관전'),
    (await late.textContent('#banner')).trim());

  // 먼저 하던 두 사람이 나가면 라운드가 취소되고 로비로 돌아온다
  await a.click('#leave-btn');
  await b.click('#leave-btn');
  await late.waitForFunction(
    () => !document.getElementById('start-btn').classList.contains('hidden'), null, { timeout: 6000 });

  // 다시 두 사람이 들어와 새 판을 시작한다 - 이제 늦둥이도 참가자다
  const c = await join('다시1');
  await late.waitForFunction(() => !document.getElementById('start-btn').disabled, null, { timeout: 6000 });
  await c.click('#start-btn');
  await late.waitForSelector('#role-card:not(.hidden)', { timeout: 6000 });

  check('X14 새 판에서는 참가자가 된다',
    !(await late.textContent('#participant-list')).includes('관전'),
    (await late.textContent('#participant-list')).replace(/\s+/g, ' ').trim());
  check('X14 [이슈] 참가자가 되면 관전 안내가 사라진다',
    await late.isHidden('#banner'),
    (await late.textContent('#banner')).trim() || '(숨김)');

  for (const ctx of ctxs) await ctx.close();
  await own.stop();
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

/**
 * X18 [요청] 슬랙처럼 보이게 한 화면 반영분을 한꺼번에 확인한다.
 *
 *   - 라이어/시민 역할 카드가 같은 색이다 (옆자리에서 색으로 라이어를 알아볼 수 없다)
 *   - 사람마다 다른 아바타 색, 연속 발언은 묶여서 아바타·이름이 한 번만 보인다
 *   - **굵게** · `코드` · ~~취소선~~이 실제 서식으로 그려진다 (그리고 여전히 안전하다)
 *   - 입력창이 Shift+Enter로 줄바꿈되고, Enter만 누르면 그 줄까지 보내고 비워진다
 *   - 역할 카드를 클릭하면 접혔다 펼쳐진다
 *   - System이 아니라 Slack bot으로 나온다 / 팝업(#result-panel)이 아예 없다
 */
async function slackLookCheck(browser) {
  const own = createGameServer({ port: PORT + 9 });
  await own.start();
  const url = `http://127.0.0.1:${PORT + 9}`;
  const ctxs = [];
  const join = async (name) => {
    const ctx = await browser.newContext();
    ctxs.push(ctx);
    const page = await ctx.newPage();
    await page.goto(url);
    await page.fill('#nickname-input', name);
    await page.click('#join-btn');
    return page;
  };
  const a = await join('가영');
  const b = await join('나래');
  await a.waitForFunction(() => document.querySelectorAll('#participant-list li').length === 2, null, { timeout: 6000 });

  check('X18 팝업 결과창(#result-panel)이 화면에 아예 없다',
    (await a.locator('#result-panel').count()) === 0);

  // 아래 대화 관련 확인들은 로비 단계에서 한다 - 라운드가 시작되면 대화권이 있는
  // 사람만 입력창을 쓸 수 있어서(1인 1회), 자유롭게 여러 번 치는 확인과는 안 맞는다.

  // ── 아바타 색: 사람(id)마다 정해진 색 ──
  // 팔레트가 8색뿐이라, 실제 두 사람의 무작위 id가 우연히 같은 색으로 겹칠 수도 있다
  // (그 자체는 버그가 아니다). 그래서 먼저 색을 고르는 함수 자체가 서로 다른 키에는
  // 다른 색을, 같은 키에는 항상 같은 색을 주는지를 직접 확인하고, 이어서 화면에 그려진
  // 아바타 색이 실제로 그 사람의 id로 계산한 색과 일치하는지(제대로 연결됐는지)를 본다.
  const fnCheck = await a.evaluate(() => ({
    same: window.avatarColorFor('player-A') === window.avatarColorFor('player-A'),
    different: window.avatarColorFor('player-A') !== window.avatarColorFor('player-B'),
  }));
  check('X18 [요청] 같은 사람은 항상 같은 색, 다른 사람은 다른 색을 주는 함수다',
    fnCheck.same && fnCheck.different, JSON.stringify(fnCheck));

  await a.fill('#chat-input', '안녕하세요');
  await a.press('#chat-input', 'Enter');
  await b.waitForFunction(() => document.querySelector('#chat').textContent.includes('안녕하세요'), null, { timeout: 5000 });
  await b.fill('#chat-input', '반갑습니다');
  await b.press('#chat-input', 'Enter');
  await a.waitForFunction(() => document.querySelector('#chat').textContent.includes('반갑습니다'), null, { timeout: 5000 });

  const myId = await a.evaluate(() => window.state.you.id);
  const wired = await a.evaluate((id) => {
    var expected = window.avatarColorFor(id);
    var probe = document.createElement('div');
    probe.style.background = expected;
    document.body.appendChild(probe);
    var normalizedExpected = getComputedStyle(probe).backgroundColor;
    document.body.removeChild(probe);
    var mine = document.querySelector('#chat-messages .avatar:not(.sys)');
    return mine ? mine.style.background === normalizedExpected : false;
  }, myId);
  check('X18 [요청] 화면에 그려진 아바타 색이 실제로 그 사람의 id로 계산한 색이다', wired);

  // ── 연속 발언 묶기: 같은 사람이 바로 이어 말하면 아바타·이름이 한 번만 ──
  await a.fill('#chat-input', '연속 첫 줄');
  await a.press('#chat-input', 'Enter');
  await a.waitForFunction(() => document.querySelector('#chat').textContent.includes('연속 첫 줄'), null, { timeout: 5000 });
  await a.fill('#chat-input', '연속 둘째 줄');
  await a.press('#chat-input', 'Enter');
  await a.waitForFunction(() => document.querySelector('#chat').textContent.includes('연속 둘째 줄'), null, { timeout: 5000 });
  const grouped = await a.locator('#chat-messages .msg.grouped').count();
  check('X18 [요청] 같은 사람이 연달아 말하면 묶여서 그려진다', grouped >= 1, `grouped=${grouped}`);

  // ── 서식: **굵게** · `코드` · ~~취소선~~ ──
  await a.fill('#chat-input', '**굵게** `코드` ~~취소선~~');
  await a.press('#chat-input', 'Enter');
  // 아래에서 a의 화면을 읽으므로 b가 아니라 a 자신이 다 그릴 때까지 기다린다.
  await a.waitForFunction(() => document.querySelector('#chat').textContent.includes('코드'), null, { timeout: 5000 });
  const lastMsgText = await a.locator('#chat-messages .msg .text').last();
  check('X18 [요청] **굵게**가 실제 <b>로 그려진다',
    (await lastMsgText.locator('b').count()) === 1 && (await lastMsgText.locator('b').innerText()) === '굵게');
  check('X18 [요청] `코드`가 실제 <code>로 그려진다',
    (await lastMsgText.locator('code').count()) === 1 && (await lastMsgText.locator('code').innerText()) === '코드');
  check('X18 [요청] ~~취소선~~이 실제 <s>로 그려진다',
    (await lastMsgText.locator('s').count()) === 1 && (await lastMsgText.locator('s').innerText()) === '취소선');
  check('X18 서식 기호(*, `, ~) 자체는 화면에 남지 않는다',
    !(await lastMsgText.innerText()).includes('*') && !(await lastMsgText.innerText()).includes('~'));

  // ── 글자 색: :이름[글자] (미리 정한 색) · :#RGB[글자] (직접 지정한 색) ──
  await a.fill('#chat-input', ':red[빨강] :#00ff00[커스텀] :bogus[그냥글자]');
  await a.press('#chat-input', 'Enter');
  await a.waitForFunction(() => document.querySelector('#chat').textContent.includes('커스텀'), null, { timeout: 5000 });
  const colorMsg = await a.locator('#chat-messages .msg .text').last();
  const spans = await colorMsg.evaluate((el) => [...el.querySelectorAll('span')]
    .filter((s) => s.style.color)
    .map((s) => ({ color: s.style.color, text: s.textContent })));
  check('X18 [요청] :이름[글자]가 미리 정한 색으로 그려진다',
    spans.some((s) => s.text === '빨강' && s.color === 'rgb(201, 58, 58)'), JSON.stringify(spans));
  check('X18 [요청] :#RRGGBB[글자]가 그 16진수 색으로 그려진다',
    spans.some((s) => s.text === '커스텀' && s.color === 'rgb(0, 255, 0)'), JSON.stringify(spans));
  check('X18 정의되지 않은 이름은 색 없이 글자 그대로 남는다',
    (await colorMsg.innerText()).includes(':bogus[그냥글자]'));

  // ── 입력창: Shift+Enter는 줄바꿈, Enter는 전송 ──
  await a.fill('#chat-input', '한 줄');
  await a.press('#chat-input', 'Shift+Enter');
  await a.type('#chat-input', '두 줄');
  const valueWithNewline = await a.inputValue('#chat-input');
  check('X18 [요청] Shift+Enter는 줄바꿈만 한다 (전송되지 않는다)',
    valueWithNewline === '한 줄\n두 줄', JSON.stringify(valueWithNewline));
  const heightGrown = await a.evaluate(() => document.getElementById('chat-input').scrollHeight > 30);
  check('X18 [요청] 줄이 늘어나면 입력창도 늘어난다', heightGrown);
  await a.press('#chat-input', 'Enter');
  await b.waitForFunction(() => document.querySelector('#chat').textContent.includes('두 줄'), null, { timeout: 5000 });
  check('X18 Enter를 누르면 그제서야 전송되고 입력창이 비워진다', (await a.inputValue('#chat-input')) === '');

  // ── 입력창 도구줄: 굵게·취소선·코드 버튼은 실제로 기호를 넣고, @ 버튼은 "@"를 넣는다 ──
  await a.fill('#chat-input', '골라야할 글자');
  await a.evaluate(() => { const el = document.getElementById('chat-input'); el.focus(); el.setSelectionRange(0, 4); });
  await a.click('#composer-toolbar .fmt-btn[data-wrap="**"]');
  check('X18 [요청] 도구줄 굵게 버튼이 고른 글자를 **로 감싼다',
    (await a.inputValue('#chat-input')) === '**골라야할** 글자', await a.inputValue('#chat-input'));

  await a.fill('#chat-input', '');
  await a.click('#mention-btn');
  check('X18 [요청] @ 버튼이 커서 자리에 "@"를 넣는다', (await a.inputValue('#chat-input')) === '@');

  check('X18 아직 지원하지 않는 서식(기울임·밑줄 등)은 눌러도 아무 일 없다 (비활성)',
    await a.isDisabled('#composer-toolbar .fmt-btn:has-text("I")'));

  // ── 라운드를 시작해서 역할 카드와 System→Slack bot 안내를 함께 본다 ──
  await a.click('#start-btn');
  await a.waitForSelector('#role-card:not(.hidden)', { timeout: 5000 });
  await b.waitForSelector('#role-card:not(.hidden)', { timeout: 5000 });

  check('X18 [요청] 안내 이름이 System이 아니라 Slack bot이다',
    (await a.textContent('#chat-messages')).includes('Slack bot'));

  // ── 역할 카드: 라이어/시민 색이 같다 (프라이버시 수정) ──
  const [colorA, colorB] = await Promise.all([a, b].map((p) => p.evaluate(() => {
    const el = document.getElementById('role-card');
    return getComputedStyle(el).backgroundColor;
  })));
  check('X18 [요청] 라이어/시민 역할 카드가 같은 색이다 (옆자리에서 안 보인다)',
    colorA === colorB, `${colorA} vs ${colorB}`);

  // ── 역할 카드 접었다 펼치기 ──
  // [요청] 접힌 머리글은 역할과 무관하게 항상 "카테고리: ..."뿐이다 - 옆에서 봐서는
  // 라이어인지조차 알 수 없다. 펼쳐야만 라이어 여부와 제시어(또는 모른다는 사실)가 나온다.
  const cardText = () => a.textContent('#role-card');
  const before = await cardText();
  check('X18 [요청] 접힌 머리글은 역할과 무관하게 카테고리만 보인다', before.includes('카테고리'), before);
  check('X18 역할 카드는 처음에 펼쳐져 있다 (제시어 관련 상세가 보인다)', before.includes('제시어'), before);

  // [정렬] 화살표 때문에 밀려 있는 머리글 글자와, 상세 글자의 시작 위치가 같아야 한다.
  // .role-detail의 글자는 padding-left만큼 안쪽에서 시작하므로, 상자 왼쪽 끝이 아니라
  // 그 padding까지 더한 실제 글자 시작 위치를 봐야 머리글과 같은 기준으로 비교된다.
  const alignX = await a.evaluate(() => {
    const detail = document.querySelector('#role-card .role-detail');
    const detailBox = detail.getBoundingClientRect();
    const detailTextX = detailBox.x + parseFloat(getComputedStyle(detail).paddingLeft);
    return {
      headTextX: document.querySelector('#role-card .role-head .role-line').getBoundingClientRect().x,
      detailTextX,
    };
  });
  check('X18 [정렬] 역할 카드 머리글과 상세 글자의 왼쪽 줄이 맞는다',
    alignX.headTextX === alignX.detailTextX, JSON.stringify(alignX));
  await a.click('#role-card');
  const folded = await cardText();
  check('X18 [요청] 역할 카드를 클릭하면 접힌다 (라이어 여부·제시어가 사라진다)',
    !folded.includes('제시어') && folded.includes('카테고리'), folded);
  await a.click('#role-card');
  const reopened = await cardText();
  check('X18 다시 클릭하면 펼쳐진다', reopened.includes('제시어'));

  // ── 게임 시작/다음 라운드 버튼: 글자 없이 돋보기 아이콘만, 안내는 title로 ──
  check('X18 [요청] 게임 시작 버튼이 돋보기 아이콘만 있고 글자가 없다',
    (await a.locator('#start-btn svg').count()) === 1
    && (await a.innerText('#start-btn')).trim() === '',
    JSON.stringify(await a.innerText('#start-btn')));
  check('X18 [요청] 안내 문구는 title에 남아 있다',
    (await a.getAttribute('#start-btn', 'title')) === '게임 시작');

  for (const ctx of ctxs) await ctx.close();
  await own.stop();
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

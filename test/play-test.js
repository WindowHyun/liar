'use strict';

/**
 * 5명이 한 판을 끝까지 하는 실전 테스트. 브라우저 창 5개를 실제로 띄워 진행한다.
 *
 * web-ui-test.js가 화면 조각조각을 확인한다면, 여기서는 사람이 하듯 처음부터 끝까지
 * 한 판을 돌린다. 5명이라야 드러나는 것들이 있다 - 찬반 과반이 3/5이고, 투표 후보가
 * 4명이고, 설명이 두 바퀴에 열 번 돈다.
 * 진행 내용을 그대로 찍으므로, 실패했을 때 어느 대목에서 어긋났는지 바로 보인다.
 *
 * 실행: node test/play-test.js
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
    console.error('5인 실전: Playwright가 설치되지 않았습니다. CI에서는 건너뛸 수 없습니다.');
    process.exit(1);
  }
  console.log('5인 실전: Playwright가 없어 건너뜁니다.');
  process.exit(0);
}

const ROOT = path.join(__dirname, '..');
const OUT = process.env.LIAR_SHOT_DIR || null; // 화면을 남기고 싶으면 이 환경변수로 폴더를 준다
const PORT = Number(process.env.PORT) || 4200;
const URL = `http://127.0.0.1:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 시민이 낼 설명 (제시어별로 두 바퀴치)
const HINTS = {
  사과: ['빨간 게 흔하죠', '아침에 깎아 먹어요', '떨어지는 걸로 유명한', '병원 갈 일 줄여준다는', '한 입 베어물면 아삭'],
  바나나: ['껍질 조심해야 해요', '노랗습니다', '원숭이가 좋아하죠', '운동 전에 먹기 좋은', '휘어 있어요'],
  수박: ['여름에 딱이죠', '두드려보고 삽니다', '씨가 많아요', '속이 빨갛습니다', '겉은 초록 줄무늬'],
  포도: ['알알이 떼어 먹어요', '보라색이 많죠', '와인 원료입니다', '송이째 사요', '껍질 벗기기 귀찮아요'],
  딸기: ['겨울에 비싸죠', '씨가 겉에 붙어 있어요', '우유랑 갈아 먹어요', '케이크 위에 올라가요', '꼭지를 떼고 먹죠'],
  기린: ['목이 인상적이죠', '동물원에서 위쪽을 봐야 해요', '점무늬가 있어요', '높은 데 잎을 먹어요', '다리가 아주 길죠'],
  코끼리: ['덩치가 큽니다', '코가 손 역할을 하죠', '귀가 큽니다', '무리 지어 다녀요', '기억력이 좋다고 하죠'],
  펭귄: ['추운 데 삽니다', '날지 못해요', '뒤뚱뒤뚱 걷죠', '턱시도 입은 것 같아요', '수영은 잘합니다'],
  고양이: ['집에서 많이 키우죠', '털이 많이 날려요', '높은 데를 좋아해요', '골골 소리를 내요', '박스를 좋아하죠'],
  악어: ['물가에 있어요', '이빨이 무섭습니다', '가방으로도 만들죠', '눈물 얘기가 있어요', '움직임이 갑자기 빨라요'],
  김치찌개: ['국물이 빨갛죠', '해장으로 먹어요', '묵은지가 들어가면 맛있죠', '돼지고기 넣으면 좋아요', '밥이랑 먹어야죠'],
  떡볶이: ['빨갛고 매워요', '분식집 대표죠', '쫀득합니다', '어묵이랑 같이 나와요', '학교 앞에서 많이 먹었죠'],
  삼겹살: ['불판에 굽죠', '쌈에 싸 먹어요', '회식 단골 메뉴', '기름이 많이 나와요', '소주랑 잘 어울리죠'],
  비빔밥: ['고추장 넣고 비벼요', '나물이 여러 가지 올라가요', '전주가 유명하죠', '계란 하나 올리면 좋아요', '한 그릇에 다 들어있어요'],
  치킨: ['금요일 저녁에 시키죠', '맥주랑 먹어요', '뼈 있는 걸 좋아해요', '배달로 많이 먹죠', '양념이냐 후라이드냐'],
  도서관: ['조용히 해야 해요', '책을 빌립니다', '시험 기간에 자리가 없죠', '노트북 자리가 인기예요', '연체하면 눈치 보여요'],
  놀이공원: ['줄이 깁니다', '놀이기구를 타요', '자유이용권을 사죠', '퍼레이드가 있어요', '하루 종일 걸어요'],
  지하철역: ['출퇴근에 지나가죠', '계단이 많아요', '카드를 찍어요', '환승할 때 뛰게 되죠', '안내 방송이 나와요'],
  찜질방: ['땀을 뺍니다', '양머리 수건이 유명하죠', '식혜랑 계란을 먹어요', '누워서 자기도 해요', '온도별로 방이 나뉘죠'],
  편의점: ['24시간 하죠', '삼각김밥이 있어요', '골목마다 있습니다', '급할 때 들르죠', '전자레인지를 빌려 써요'],
  소방관: ['출동을 나갑니다', '장비가 무겁죠', '불이 나면 부릅니다', '고양이도 구해준다죠', '방화복을 입어요'],
  요리사: ['주방에서 일하죠', '칼을 잘 씁니다', '모자가 특징이에요', '불 앞에 오래 서 있어요', '간을 봐야 해요'],
  프로그래머: ['앉아서 일하죠', '검은 화면을 봅니다', '커피를 많이 마셔요', '버그 때문에 야근하죠', '키보드를 많이 씁니다'],
  가수: ['무대에 서죠', '목 관리를 합니다', '음원을 냅니다', '콘서트를 열어요', '팬이 많죠'],
  경찰관: ['제복을 입죠', '신고하면 옵니다', '순찰을 돕니다', '수갑을 가지고 다녀요', '112를 누르면 연결되죠'],
  우산: ['비 올 때 씁니다', '자꾸 잃어버려요', '접었다 폈다 하죠', '지하철에 두고 내리기 쉬워요', '바람에 뒤집혀요'],
  냉장고: ['문을 자주 여닫죠', '항상 켜져 있어요', '자석을 붙여둡니다', '안이 시원해요', '가끔 정리해야 하죠'],
  이어폰: ['줄이 엉켜요', '한쪽만 안 들릴 때가 있죠', '지하철에서 많이 써요', '충전해야 하는 것도 있어요', '귀에 꽂습니다'],
  자전거: ['페달을 밟죠', '한강에서 많이 타요', '체인이 빠지기도 해요', '헬멧을 써야죠', '두 바퀴로 갑니다'],
  칫솔: ['하루에 몇 번 씁니다', '3개월마다 바꾸라죠', '컵에 꽂아둬요', '치약이랑 같이 씁니다', '털이 벌어지면 바꿔요'],
};
// 라이어가 카테고리만 보고 치는 애매한 말
const BLUFFS = {
  과일: ['저는 이거 좋아해요', '자주 사 먹는 편이에요', '요즘 비싸더라고요', '아이들도 잘 먹죠'],
  동물: ['사진으로만 봤어요', '귀엽다고 생각해요', '동물원에서 본 것 같은데', '실제로 보면 놀라죠'],
  음식: ['자주 먹지는 않아요', '먹으면 배부르죠', '호불호가 좀 갈리죠', '저는 괜찮더라고요'],
  장소: ['가본 지 오래됐네요', '사람이 많을 때가 있죠', '주말에 가면 복잡해요', '집 근처에도 있어요'],
  직업: ['쉽지 않은 일이죠', '아무나 못 하죠', '주변에 한 명 있어요', '존경스럽다고 생각해요'],
  물건: ['집에 하나쯤 있죠', '없으면 불편해요', '가끔 새로 사요', '생각보다 자주 쓰죠'],
};

function up(t) {
  const d = Date.now() + t;
  return new Promise((res, rej) => {
    const tick = () => { const q = http.get(URL, (r) => { r.resume(); res(); }); q.on('error', () => (Date.now() > d ? rej(new Error('서버 안 뜸')) : setTimeout(tick, 100))); };
    tick();
  });
}
const log = (s) => console.log(s);
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  log(`      ${ok ? '✓' : '✗ 실패'} ${name}${detail ? `  (${detail})` : ''}`);
}
async function speaker(ps) { for (const p of ps) if (await p.page.locator('#composer.my-turn').count()) return p; return null; }

(async () => {
  const server = spawn(process.execPath, [path.join(ROOT, 'web', 'server.js')], { stdio: 'ignore', cwd: ROOT, env: { ...process.env, PORT: String(PORT) } });
  await up(8000);
  const browser = await chromium.launch();
  const errors = [];
  const players = [];
  for (const name of ['지훈', '서연', '민준', '하은', '도윤']) {
    const ctx = await browser.newContext({ viewport: { width: 1180, height: 780 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
    await page.goto(URL);
    await page.fill('#nickname-input', name);
    await page.click('#join-btn');
    players.push({ name, page });
  }
  const [p1] = players;
  await p1.page.waitForFunction(() => document.querySelectorAll('#participant-list li').length === 5, null, { timeout: 8000 });

  log('\n━━━━━━━━━━ 5명이 모였습니다 ━━━━━━━━━━');
  log(`  참가자: ${players.map((p) => p.name).join(', ')}`);
  check('5명이 서로를 본다', (await p1.page.textContent('#member-count')).trim() === '5');
  check('시작 버튼이 열린다', !(await p1.page.isDisabled('#start-btn')));

  await p1.page.click('#start-btn');
  await Promise.all(players.map((p) => p.page.waitForSelector('#live-block .track .pill', { timeout: 8000 })));
  if (OUT) await p1.page.screenshot({ path: `${OUT}/01-start.png` });

  const cards = await Promise.all(players.map((p) => p.page.textContent('#role-card')));
  const liarIdx = cards.findIndex((c) => c.includes('당신은 Oliveyoung입니다'));
  const liar = players[liarIdx];
  const citizens = players.filter((p) => p !== liar);
  const word = cards.find((c) => !c.includes('당신은 Oliveyoung입니다')).split('제시어: ')[1].trim();
  const category = cards[0].split('카테고리: ')[1].split(/[/(]/)[0].trim();

  log('\n━━━━━━━━━━ 역할이 정해졌습니다 ━━━━━━━━━━');
  log(`  카테고리 : ${category}`);
  log(`  제시어   : ${word}   ← 시민 4명만 압니다`);
  log(`  라이어   : ${liar.name}`);
  check('라이어는 정확히 한 명', cards.filter((c) => c.includes('당신은 Oliveyoung입니다')).length === 1);
  check('시민 4명이 같은 제시어를 본다', cards.filter((c) => c.includes(`제시어: ${word}`)).length === 4);
  const liarHtml = await liar.page.content();
  check('라이어 화면 어디에도 제시어가 없다', !liarHtml.includes(word), `제시어="${word}"`);
  check('설명 단계에서는 투표를 제안할 수 없다', await p1.page.isDisabled('#vote-btn'));

  const used = {};
  async function playRound(roundNo) {
    log(`\n━━━━━━━━━━ ${roundNo}차 설명 ━━━━━━━━━━`);
    const badge = await p1.page.textContent('#live-block .round-badge');
    check(`${roundNo}차 배지가 보인다`, badge.trim() === `${roundNo}차`, badge.trim());
    for (let i = 0; i < players.length + 1; i += 1) {
      const sp = await speaker(players);
      if (!sp) break;
      const locked = await Promise.all(players.filter((p) => p !== sp).map((p) => p.page.isDisabled('#chat-input')));
      if (i === 0) check('차례인 사람만 입력창이 열린다', locked.every(Boolean));
      let line;
      if (sp === liar) {
        const pool = BLUFFS[category] || ['음... 그렇죠'];
        line = pool[(used[sp.name] = (used[sp.name] || 0) + 1) % pool.length];
      } else {
        const pool = HINTS[word] || ['그냥 흔한 거예요'];
        const k = (citizens.indexOf(sp) + (roundNo - 1) * citizens.length) % pool.length;
        line = pool[k];
      }
      log(`  ${sp === liar ? '🎭' : '  '} ${sp.name.padEnd(3)} : ${line}`);
      await sp.page.fill('#chat-input', line);
      await sp.page.press('#chat-input', 'Enter');
      await wait(320);
      const stillMine = await sp.page.locator('#composer.my-turn').count();
      if (i === 0) check('말하고 나면 곧바로 잠긴다 (1인 1회)', stillMine === 0);
      const nowBadge = await p1.page.textContent('#live-block .round-badge').catch(() => null);
      if (!nowBadge || nowBadge.trim() !== `${roundNo}차`) break;
    }
  }
  await playRound(1);
  if (OUT) await p1.page.screenshot({ path: `${OUT}/02-round1.png` });
  await p1.page.waitForFunction(
    () => (document.querySelector('#live-block .round-badge') || {}).textContent === '2차', null, { timeout: 8000 });
  check('1차를 다 돌면 2차로 넘어간다', true);
  await playRound(2);

  await Promise.all(players.map((p) => p.page.waitForFunction(
    () => document.querySelector('#live-block').textContent.includes('자유 대화 중'), null, { timeout: 8000 })));
  log('\n━━━━━━━━━━ 자유 대화 ━━━━━━━━━━');
  check('2차까지 마치면 자유 대화가 열린다', true);
  check('전원의 입력창이 열린다', !(await Promise.all(players.map((p) => p.page.isDisabled('#chat-input')))).some(Boolean));
  check('이제 투표를 제안할 수 있다', !(await p1.page.isDisabled('#vote-btn')));

  const talk = [
    [citizens[0], `${liar.name}님 설명이 좀 두루뭉술한데요?`],
    [liar, '저는 원래 말주변이 없어서요'],
    [citizens[1], '저도 그렇게 느꼈어요'],
    [citizens[2], `${liar.name}님 한 번 더 말해보세요`],
  ];
  for (const [who, line] of talk) {
    log(`  ${who === liar ? '🎭' : '  '} ${who.name.padEnd(3)} : ${line}`);
    await who.page.fill('#chat-input', line);
    await who.page.press('#chat-input', 'Enter');
    await wait(250);
  }
  if (OUT) await p1.page.screenshot({ path: `${OUT}/03-free.png` });

  log('\n━━━━━━━━━━ 투표 제안 ━━━━━━━━━━');
  await citizens[0].page.click('#vote-btn');
  await Promise.all(players.map((p) => p.page.waitForSelector('#live-block .chip', { timeout: 8000 })));
  log(`  ${citizens[0].name}님이 🎧 를 눌렀습니다`);
  check('찬반 단계부터 대화가 잠긴다', await p1.page.isDisabled('#chat-input'));
  check('왜 잠겼는지 알려 준다',
    (await p1.page.getAttribute('#chat-input', 'placeholder')).includes('투표가 끝날 때까지'));
  if (OUT) await p1.page.screenshot({ path: `${OUT}/04-proposal.png` });

  for (const p of players.slice(0, 3)) {
    await p.page.click('#live-block .chip[data-agree="yes"]', { timeout: 4000 }).catch(() => {});
    log(`  ${p.name} ✅`);
    await wait(250);
  }
  await Promise.all(players.map((p) => p.page.waitForFunction(
    () => document.querySelector('#live-block').textContent.includes('한 명을 고르세요'), null, { timeout: 8000 })));
  log('  → 찬성 3/5 (과반) 이라 투표로 넘어갑니다');

  log('\n━━━━━━━━━━ 투표 ━━━━━━━━━━');
  const optCount = await citizens[0].page.locator('#live-block .opt').count();
  check('자기 자신은 후보에 없다 (4명)', optCount === 4, `${optCount}명`);
  for (const c of citizens) {
    await c.page.click(`#live-block .opt:has-text("${liar.name}")`);
    log(`  ${c.name} → ${liar.name}`);
    await wait(200);
  }
  if (OUT) await p1.page.screenshot({ path: `${OUT}/05-voting.png` });
  await liar.page.click(`#live-block .opt:has-text("${citizens[0].name}")`);
  log(`  ${liar.name} → ${citizens[0].name}  (라이어의 물타기)`);

  await liar.page.waitForSelector('#guess-input', { timeout: 8000 });
  log('\n━━━━━━━━━━ 색출 ━━━━━━━━━━');
  log(`  ${liar.name}님이 4표로 지목되었습니다 → 라이어였습니다`);
  check('지목 안내가 대화에 남는다',
    (await p1.page.textContent('#chat-messages')).includes(`${liar.name}님이 Oliveyoung으로 지목되었습니다`));
  check('지목된 라이어에게만 정답창이 뜬다',
    (await citizens[0].page.locator('#guess-input').count()) === 0);
  if (OUT) await p1.page.screenshot({ path: `${OUT}/06-guess.png` });

  const wrong = { 과일: '바나나', 동물: '고양이', 음식: '치킨', 장소: '편의점', 직업: '요리사', 물건: '우산' }[category] || '모르겠어요';
  const answer = wrong === word ? '전혀 모르겠어요' : wrong;
  log(`  ${liar.name}의 마지막 추측: "${answer}"  (정답은 "${word}")`);
  await liar.page.fill('#guess-input', answer);
  await liar.page.press('#guess-input', 'Enter');

  await Promise.all(players.map((p) => p.page.waitForSelector('#result-panel:not(.hidden)', { timeout: 8000 })));
  const panels = await Promise.all(players.map((p) => p.page.textContent('#result-panel')));
  log('\n━━━━━━━━━━ 결과 ━━━━━━━━━━');
  log(`  ${panels[0].replace(/\s+/g, ' ').trim()}`);
  check('5명이 같은 결과를 본다', panels.every((t) => t.includes('시민 팀 승리')));
  check('끝난 뒤 라이어와 제시어가 공개된다', panels.every((t) => t.includes(liar.name) && t.includes(word)));
  check('전적이 쌓인다', (await p1.page.textContent('#tally-label')).includes('1판'),
    (await p1.page.textContent('#tally-label')).trim());
  check('결과가 나오면 대화가 다시 열린다', !(await p1.page.isDisabled('#chat-input')));
  // 결과 카드가 뜨면서 대화 영역이 줄어든다. 방금 나온 지목·결과 줄이 화면 밖으로
  // 밀리면 정작 읽어야 할 순간에 손으로 스크롤해야 한다.
  const seesEnding = await p1.page.evaluate(() => {
    const box = document.getElementById('chat');
    const lines = [...document.querySelectorAll('#chat-messages .msg')];
    const last = lines[lines.length - 1];
    if (!last) return false;
    const r = last.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    return r.bottom <= b.bottom + 2 && r.bottom > b.top;
  });
  check('결과가 뜬 뒤에도 마지막 대화 줄이 화면 안에 있다', seesEnding);
  if (OUT) await p1.page.screenshot({ path: `${OUT}/07-result.png` });

  check('브라우저 콘솔 오류 없음', errors.length === 0, errors.slice(0, 3).join(' | '));

  const failed = results.filter((r) => !r.ok).length;
  log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  log(`5인 실전: ${results.length - failed}/${results.length} 통과`);
  await browser.close();
  server.kill();
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('실행 중 예외:', e.message); process.exit(1); });

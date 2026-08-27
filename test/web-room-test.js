'use strict';

/**
 * 웹 버전 규칙(web/room.js) 테스트. 타이머와 난수를 주입해서 30초를 실제로 기다리지 않고,
 * 라이어도 원하는 사람으로 고정한다.
 *
 * 실행: node test/web-room-test.js
 */

const { createRoom } = require('../web/room');

// ── 가상 시계 ──
let clock = 0;
let seq = 0;
let timers = [];
const setTimer = (fn, ms) => { seq += 1; const t = { id: seq, at: clock + (ms || 0), fn }; timers.push(t); return t; };
const clearTimer = (t) => { if (!t) return; const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); };
const now = () => clock;
function advance(ms) {
  const target = clock + ms;
  for (let guard = 0; guard < 1000; guard += 1) {
    timers.sort((a, b) => a.at - b.at || a.id - b.id);
    if (timers.length === 0 || timers[0].at > target) break;
    const t = timers.shift();
    clock = t.at;
    t.fn();
  }
  clock = target;
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

/** liarIndex번째 참가자가 라이어가 되도록 난수를 고정한 방을 만든다. */
function makeRoom(names, liarIndex) {
  clock = 0; timers = []; seq = 0;
  let call = 0;
  const room = createRoom({
    setTimer, clearTimer, now,
    random: () => {
      call += 1;
      if (call === 1) return 0;                                   // 제시어: 목록 첫 번째
      return (liarIndex + 0.5) / names.length;                    // 라이어 지정
    },
  });
  const players = names.map((n) => room.join({ nickname: n }));
  return { room, players };
}
const idsOf = (players) => players.map((p) => p.playerId);

// ─────────────────────────────── 테스트 ───────────────────────────────

function w1_minimumPlayers() {
  const { room } = makeRoom(['A', 'B'], 0);
  const reason = room.start();
  check('W1 3명 미만이면 시작을 거부하고 사유를 돌려준다',
    typeof reason === 'string' && reason.includes('최소 3명'), reason);
}

function w2_liarNeverSeesWord() {
  const { room, players } = makeRoom(['A', 'B', 'C'], 1); // 라이어 = B
  room.start();
  const [a, b, c] = idsOf(players);
  const word = room._debug().round.word;

  check('W2 라이어에게는 제시어가 전송되지 않는다',
    !JSON.stringify(room.stateFor(b)).includes(word), `제시어=${word}`);
  check('W2 라이어는 카테고리는 받는다', room.stateFor(b).you.category !== null);
  check('W2 시민은 제시어를 받는다',
    room.stateFor(a).you.word === word && room.stateFor(c).you.word === word);
  check('W2 남의 역할은 상태에 없다',
    room.stateFor(a).players.every((p) => !('isLiar' in p)));
}

function w3_everyoneSeesSameResult() {
  const { room, players } = makeRoom(['A', 'B', 'C'], 0); // 라이어 = A. B를 지목하면 오답이다.
  room.start();
  const [a, b, c] = idsOf(players);

  room.callVote(a);
  room.vote(a, b);
  room.vote(c, b);
  room.vote(b, c);

  const states = [a, b, c].map((id) => room.stateFor(id));
  check('W3 오답 지목이면 그 자리에서 라운드가 끝난다 (공개 왕복이 없다)',
    states.every((s) => s.phase === 'result'), states.map((s) => s.phase).join(' '));
  check('W3 전원이 같은 결과를 본다',
    states.every((s) => s.result && s.result.winner === states[0].result.winner && s.result.reason === states[0].result.reason),
    states.map((s) => s.result ? s.result.winner + '/' + s.result.reason : '없음').join(' '));
  check('W3 전원이 같은 라이어·제시어를 본다',
    states.every((s) => s.result.liar.id === states[0].result.liar.id && s.result.word === states[0].result.word),
    states[0].result.liar.nickname + ' / ' + states[0].result.word);
}

function w4_liarGuessFlow() {
  const { room, players } = makeRoom(['A', 'B', 'C'], 1); // 라이어 = B
  room.start();
  const [a, b, c] = idsOf(players);
  const word = room._debug().round.word;

  room.callVote(a);
  room.vote(a, b); room.vote(c, b); room.vote(b, a);
  check('W4 라이어가 지목되면 정답 단계로 넘어간다', room.stateFor(b).phase === 'guess');
  check('W4 지목된 라이어만 정답창을 받는다',
    room.stateFor(b).you.canGuess === true && room.stateFor(a).you.canGuess === false);

  const rejected = room.guess(a, word);
  check('W4 지목되지 않은 사람의 정답은 거부된다', typeof rejected === 'string', rejected);

  room.guess(b, `  ${word.toUpperCase()} `); // 공백·대소문자가 섞여도 정답
  const s = room.stateFor(a);
  check('W4 정규화해서 맞히면 라이어 승',
    s.phase === 'result' && s.result.winner === 'liar' && s.result.reason === 'guess',
    s.result ? s.result.winner + '/' + s.result.reason : '없음');
  check('W4 끝난 뒤에는 전원에게 라이어와 제시어가 공개된다',
    s.result.liar.id === b && s.result.word === word);
}

function w5_guessTimeout() {
  const { room, players } = makeRoom(['A', 'B', 'C'], 1);
  room.start();
  const [a, b, c] = idsOf(players);
  room.callVote(a);
  room.vote(a, b); room.vote(c, b); room.vote(b, a);
  advance(31000);
  const s = room.stateFor(a);
  check('W5 라이어가 시간 안에 못 맞히면 시민 승',
    s.phase === 'result' && s.result.winner === 'citizens' && s.result.reason === 'guessTimeout',
    s.result ? s.result.winner + '/' + s.result.reason : '없음');
}

function w6_voteTimeoutAndTie() {
  const { room, players } = makeRoom(['A', 'B', 'C'], 0);
  room.start();
  const [a] = idsOf(players);
  room.callVote(a);
  advance(31000);
  const s = room.stateFor(a);
  check('W6 아무도 투표하지 않으면 제한 시간 뒤 라이어 승',
    s.phase === 'result' && s.result.reason === 'noVotes', s.result ? s.result.reason : '없음');
}

function w7_disconnectDoesNotBlockVote() {
  const { room, players } = makeRoom(['A', 'B', 'C'], 0); // 라이어 = A
  room.start();
  const [a, b, c] = idsOf(players);
  room.callVote(a);
  room.vote(a, b);
  room.vote(b, a);
  check('W7 아직 결과가 나오지 않음(C가 남음)', room.stateFor(a).phase === 'voting');

  room.disconnect(c); // C가 창을 닫았다
  const s = room.stateFor(a);
  check('W7 나간 사람을 기다리느라 투표가 멈추지 않는다',
    s.phase !== 'voting', `phase=${s.phase}`);
}

function w8_reconnectKeepsSeat() {
  const { room, players } = makeRoom(['A', 'B', 'C'], 1);
  room.start();
  const [a] = idsOf(players);
  const token = players[0].token;

  room.disconnect(a);
  check('W8 라운드 중 끊겨도 자리는 남는다', room.stateFor(a).you !== null);

  const back = room.join({ nickname: 'A', token });
  check('W8 토큰으로 같은 자리에 돌아온다', back.playerId === a && back.restored === true);
  check('W8 돌아오면 내 역할도 그대로 보인다', room.stateFor(a).you.inRound === true);
}

function w9_lateJoinerSpectates() {
  const { room, players } = makeRoom(['A', 'B', 'C'], 0);
  room.start();
  const late = room.join({ nickname: 'D' });
  const s = room.stateFor(late.playerId);
  check('W9 진행 중에 들어온 사람은 이번 판을 관전한다',
    s.you.inRound === false && s.you.word === null && s.you.category === null);
  check('W9 관전자는 투표할 수 없다', typeof room.vote(late.playerId, players[0].playerId) === 'string');
}

function w10_chatLock() {
  const { room, players } = makeRoom(['A', 'B', 'C'], 1);
  room.start();
  const [a, b, c] = idsOf(players);
  check('W10 진행 중에는 대화할 수 있다', room.say(a, '빨갛습니다') === null);
  room.callVote(a);
  check('W10 투표 중에는 서버가 대화를 막는다', typeof room.say(a, '몰래 힌트') === 'string');
  room.vote(a, b); room.vote(c, b); room.vote(b, a);
  check('W10 정답 단계에서도 막힌다', typeof room.say(a, '힌트') === 'string');
  room.guess(b, '땡');
  check('W10 라운드가 끝나면 다시 열린다', room.say(a, '한 판 더') === null);
}

console.log('웹 규칙 테스트');
for (const fn of [w1_minimumPlayers, w2_liarNeverSeesWord, w3_everyoneSeesSameResult, w4_liarGuessFlow,
  w5_guessTimeout, w6_voteTimeoutAndTie, w7_disconnectDoesNotBlockVote, w8_reconnectKeepsSeat,
  w9_lateJoinerSpectates, w10_chatLock]) {
  try { fn(); } catch (err) { check(`${fn.name} 실행 중 예외`, false, err.message); }
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n웹 규칙: ${results.length - failed}/${results.length} 통과`);
process.exit(failed === 0 ? 0 : 1);

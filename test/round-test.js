'use strict';

/**
 * 라운드 진행(game.js) 회귀 테스트.
 *
 * 전송은 메모리 버스로 대체하고(중복 제거는 transport-test.js가 따로 검증한다), 대신
 * "특정 패킷만 골라서 유실시키는" 상황을 만들어 결과가 갈라지는지 확인한다. 타이머는
 * 가상 시계로 돌려서 30초 투표 제한 시간도 즉시 흘려보낸다.
 *
 * 여기서 잡는 것:
 *   T1 [P0-2] 표 하나가 유실돼도 전원이 같은 결과를 본다
 *   T2 [P0-2] 아무도 투표하지 않은 결과(noVotes)가 전원에게 전파된다
 *   T3 [P1-7] 정답 판정 결과(RESULT)가 딱 1건만 나간다
 *   T4 [P0-3] 제시어를 못 받은 사람이 지난 라운드 역할을 그대로 쓰지 않는다
 *   T5 [P1-8] CALL_VOTE를 놓친 사람도 투표에 합류하고 결과를 받는다
 *   T6 [P1-11] 남에게 가야 할 제시어가 내 역할을 덮어쓰지 않는다
 *   T7 [P0-1] 같은 START가 두 번 들어와도 라운드는 한 번만 시작된다
 *
 * 실행: node test/round-test.js
 */

const path = require('path');
const Module = require('module');

// LIAR_GAME_PATH로 다른 구현을 지정할 수 있다. 수정 전 game.js에 이 테스트를 돌려
// "정말 그 버그를 잡는 테스트인지" 확인할 때 쓴다.
const GAME_PATH = process.env.LIAR_GAME_PATH
  ? path.resolve(process.env.LIAR_GAME_PATH)
  : path.join(__dirname, '..', 'game.js');

// ───────────────────────────── 가상 시계 ─────────────────────────────
let clockNow = 0;
let timerSeq = 0;
let timers = [];
const realSetTimeout = global.setTimeout;

global.setTimeout = (fn, ms) => { timerSeq += 1; const t = { id: timerSeq, at: clockNow + (ms || 0), fn }; timers.push(t); return t; };
global.clearTimeout = (t) => { if (!t) return; const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); };
global.setInterval = () => null; // 참가자 목록 주기 갱신은 이 테스트와 무관
global.clearInterval = () => {};

function advance(ms) {
  const target = clockNow + ms;
  for (let guard = 0; guard < 10000; guard += 1) {
    timers.sort((a, b) => a.at - b.at || a.id - b.id);
    if (timers.length === 0 || timers[0].at > target) break;
    const t = timers.shift();
    clockNow = t.at;
    t.fn();
  }
  clockNow = target;
}
const flush = () => advance(1);

// ─────────────────── game.js에 가짜 network/logger 주입 ───────────────────
const originalLoad = Module._load;
let inject = null;
Module._load = function (request, parent, isMain) {
  if (inject && request === './network') return inject.net;
  if (inject && request === './logger') return inject.logger;
  return originalLoad.apply(this, arguments);
};

function makeWorld(names) {
  clockNow = 0; timers = []; timerSeq = 0;

  const bus = {
    players: [],
    sent: [],                       // 버스에 실제로 나간 모든 메시지
    drop: () => false,              // (msg, fromId, toId) => 이 전달을 버릴지
    deliver(from, obj, toPlayer) {
      if (this.drop(obj, from.id, toPlayer.id)) return false;
      const copy = JSON.parse(JSON.stringify(obj)); // 직렬화를 거치는 실제 경로와 맞춘다
      global.setTimeout(() => toPlayer.onMessage(copy, { address: from.ip }), 0);
      return true;
    },
    broadcast(from, obj) {
      this.sent.push({ from: from.id, obj });
      // 실제 UDP도 자기가 보낸 브로드캐스트를 자기가 되받는다(루프백). 그 필터를 같이 검증한다.
      for (const p of this.players) this.deliver(from, obj, p);
    },
    unicast(from, obj, ip) {
      this.sent.push({ from: from.id, obj, ip });
      const target = this.players.find((p) => p.ip === ip);
      if (!target) return false;
      return this.deliver(from, obj, target);
    },
  };

  const players = names.map((nickname, i) => ({
    id: `P${i + 1}`, ip: `10.0.0.${i + 1}`, nickname, events: [], onMessage: () => {},
  }));
  bus.players = players;

  for (const p of players) {
    const fakeNet = {
      MY_ID: p.id,
      PROTOCOL_VERSION: 2,
      PEER_TIMEOUT_MS: 12000,
      setDiagnosticsHandler(fn) { p.diag = fn; },
      startPresence() { return null; },
      startReceiver(onMessage) { p.onMessage = onMessage; },
      getOnlinePeers() {
        return bus.players.filter((o) => o.id !== p.id).map((o) => ({ id: o.id, nickname: o.nickname, ip: o.ip, lastSeen: clockNow }));
      },
      sendBroadcast(obj) { bus.broadcast(p, obj); return 'mid'; },
      sendUnicast(obj, ip) { bus.unicast(p, obj, ip); return 'mid'; },
      sendBroadcastReliable(obj) { bus.broadcast(p, obj); return 'mid'; },
      sendUnicastReliable(obj, ip, onFail) {
        const ok = bus.unicast(p, obj, ip);
        if (!ok && onFail) global.setTimeout(() => onFail('noAck'), 0);
        return 'mid';
      },
      cancelPending() {},
    };

    inject = { net: fakeNet, logger: { log: () => {}, warn: () => {}, error: () => {}, LOG_PATH: '' } };
    delete require.cache[require.resolve(GAME_PATH)];
    p.game = require(GAME_PATH);
    inject = null;

    p.game.setStateHandler((state) => p.events.push(state));
    p.game.join(p.nickname);
  }
  flush();
  return { bus, players, byId: Object.fromEntries(players.map((p) => [p.id, p])) };
}

/** startGame()이 뽑는 라이어와 제시어를 고정한다. */
function fixRandom(liarIndex, total, wordIndex) {
  const queue = [(liarIndex + 0.5) / total, (wordIndex + 0.5) / 5];
  const real = Math.random;
  Math.random = () => (queue.length ? queue.shift() : 0);
  return () => { Math.random = real; };
}

const last = (p, type) => [...p.events].reverse().find((e) => e.type === type);
const has = (p, type) => p.events.some((e) => e.type === type);

// ───────────────────────────── 테스트 ─────────────────────────────
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

function t1_voteLossStillAgrees() {
  const { bus, players, byId } = makeWorld(['A', 'B', 'C']);
  const [A, B, C] = players;
  const restore = fixRandom(2, 3, 0); // 라이어=C, 제시어=사과
  A.game.startGame();
  restore();
  flush();

  A.game.callVote(); flush();

  // C의 표가 B에게만 유실된다. 예전 코드에서는 B가 자기 표 계산으로 동점을 만들어
  // A와 다른 결론(동점 → 라이어 승)을 냈다.
  bus.drop = (msg, from, to) => msg.type === 'VOTE' && from === 'P3' && to === 'P2';

  A.game.sendVote('P2'); flush();   // A → B
  B.game.sendVote('P3'); flush();   // B → C
  C.game.sendVote('P2'); flush();   // C → B  (B에게는 안 도착)
  advance(31000);                   // 투표 제한 시간까지 흘려보낸다

  const finals = players.map((p) => last(p, 'result'));
  const allGot = finals.every(Boolean);
  const same = allGot && finals.every((r) => r.winner === finals[0].winner && r.reason === finals[0].reason);
  check('T1 [P0-2] 표 유실에도 전원이 같은 결과', allGot && same,
    finals.map((r, i) => `${players[i].nickname}:${r ? r.winner + '/' + r.reason : '없음'}`).join(' '));

  const accused = players.map((p) => last(p, 'accused'));
  check('T1 [P0-2] 전원이 같은 사람을 지목',
    accused.every((a) => a && a.id === accused[0].id),
    accused.map((a) => (a ? a.id : '없음')).join(' '));
}

function t2_noVotesBroadcast() {
  const { players } = makeWorld(['A', 'B', 'C']);
  const [A] = players;
  const restore = fixRandom(2, 3, 0);
  A.game.startGame(); restore(); flush();

  A.game.callVote(); flush();
  advance(31000); // 아무도 투표하지 않고 제한 시간 경과

  const finals = players.map((p) => last(p, 'result'));
  check('T2 [P0-2] 미투표 결과가 전원에게 전파',
    finals.every((r) => r && r.reason === 'noVotes'),
    finals.map((r, i) => `${players[i].nickname}:${r ? r.reason : '없음'}`).join(' '));
}

function t3_singleResultOnGuess() {
  const { bus, players } = makeWorld(['A', 'B', 'C']);
  const [A, B, C] = players;
  const restore = fixRandom(2, 3, 0); // 라이어=C, 제시어=사과
  A.game.startGame(); restore(); flush();

  A.game.callVote(); flush();
  A.game.sendVote('P3'); flush();
  B.game.sendVote('P3'); flush();
  C.game.sendVote('P1'); flush();
  advance(1000);

  check('T3 라이어가 지목되어 정답 기회를 받음', has(C, 'awaitGuess'));

  const before = bus.sent.filter((s) => s.obj.type === 'RESULT').length;
  // 제시어 목록은 바뀔 수 있으므로, 시민에게 실제로 배분된 제시어를 읽어서 그대로 맞힌다.
  const realWord = bus.sent.find((m) => m.obj.type === 'WORD' && m.obj.word !== null).obj.word;
  C.game.submitGuess(`  ${realWord.toUpperCase()} `); // [P2-18] 공백·대소문자가 섞여도 정답이어야 한다
  advance(1000);
  const resultMsgs = bus.sent.filter((s) => s.obj.type === 'RESULT').length - before;

  check('T3 [P1-7] 정답 판정 RESULT는 1건만', resultMsgs === 1, `${resultMsgs}건`);
  const finals = players.map((p) => last(p, 'result'));
  check('T3 전원이 라이어 역전승으로 동일 판정',
    finals.every((r) => r && r.winner === 'liar' && r.reason === 'guess'),
    finals.map((r, i) => `${players[i].nickname}:${r ? r.winner : '없음'}`).join(' '));
}

function t4_roleResetBetweenRounds() {
  const { bus, players } = makeWorld(['A', 'B', 'C']);
  const [A, B, C] = players;

  // 1라운드: C가 라이어
  let restore = fixRandom(2, 3, 0);
  A.game.startGame(); restore(); flush();
  const r1 = last(C, 'word');
  check('T4 1라운드에서 C가 라이어 역할을 받음', !!r1 && r1.isLiar === true);

  // 1라운드 종료 (아무도 투표 안 함)
  A.game.callVote(); flush();
  advance(31000);

  // 2라운드: A가 라이어. C에게 갈 제시어(WORD)를 유실시킨다.
  bus.drop = (msg, from, to) => msg.type === 'WORD' && to === 'P3'; // 전송 단계에서 끊는다(메시지 필드에 의존하지 않게)
  restore = fixRandom(0, 3, 1);
  A.game.startGame(); restore(); flush();

  check('T4 [P0-3] 제시어 못 받은 사람의 역할 카드가 초기화됨',
    (last(C, 'rolePending') && C.events.filter((e) => e.type === 'word').length === 1),
    `word 이벤트 ${C.events.filter((e) => e.type === 'word').length}건`);

  advance(6000);
  check('T4 [P0-3] 제시어 미수신을 본인에게 알림', has(C, 'roleMissing'));

  // C를 지목한다. 역할이 초기화됐다면 C는 "나는 라이어가 아니다"라고 공개해야 한다.
  A.game.callVote(); flush();
  A.game.sendVote('P3'); flush();
  B.game.sendVote('P3'); flush();
  C.game.sendVote('P1'); flush();
  advance(1000);

  const reveal = bus.sent.filter((s) => s.obj.type === 'REVEAL').pop();
  check('T4 [P0-3] 지난 라운드 역할(라이어)이 남아 있지 않음',
    !!reveal && reveal.obj.isLiar === false,
    reveal ? `REVEAL isLiar=${reveal.obj.isLiar}` : 'REVEAL 없음');
}

function t5_missedCallVote() {
  const { bus, players } = makeWorld(['A', 'B', 'C']);
  const [A, B, C] = players;
  const restore = fixRandom(0, 3, 0); // 라이어=A(호스트). 지목될 B는 라이어가 아니라 라운드가 그 자리에서 끝난다.
  A.game.startGame(); restore(); flush();

  bus.drop = (msg, from, to) => msg.type === 'CALL_VOTE' && to === 'P3'; // C만 투표 시작을 놓친다
  A.game.callVote(); flush();
  check('T5 C는 투표 시작 알림을 놓침', !has(C, 'voteStart'));

  bus.drop = () => false;
  A.game.sendVote('P2'); flush();
  check('T5 [P1-8] 남의 표를 보고 뒤늦게 투표에 합류', has(C, 'voteStart'));

  B.game.sendVote('P1'); flush();
  C.game.sendVote('P2'); flush();
  advance(1000);

  const finals = players.map((p) => last(p, 'result'));
  check('T5 [P1-8] 놓친 사람도 최종 결과를 받음',
    finals.every(Boolean) && finals.every((r) => r.winner === finals[0].winner),
    finals.map((r, i) => `${players[i].nickname}:${r ? r.winner + '/' + r.reason : '없음'}`).join(' '));
}

function t6_wordForSomeoneElse() {
  const { players } = makeWorld(['A', 'B', 'C']);
  const [A, B, C] = players;
  const restore = fixRandom(0, 3, 0); // 라이어=A
  A.game.startGame(); restore(); flush();

  const before = C.events.filter((e) => e.type === 'word').length;
  // B에게 가야 할 제시어가 어떤 이유로든 C의 수신부로 들어온 상황
  C.onMessage({ type: 'WORD', roundId: last(C, 'roundStart') && 'x', to: 'P2', category: '동물', word: '기린', isLiar: true }, { address: '10.0.0.1' });
  flush();
  const after = C.events.filter((e) => e.type === 'word').length;

  check('T6 [P1-11] 남에게 가야 할 제시어를 무시', after === before, `word 이벤트 ${before} → ${after}`);
}

function t7_duplicateStart() {
  const { bus, players } = makeWorld(['A', 'B', 'C']);
  const [A, B] = players;
  const restore = fixRandom(0, 3, 0);
  A.game.startGame(); restore(); flush();

  // 실제로 나갔던 START를 그대로 한 번 더 밀어 넣는다 (전송 계층 중복 제거가 뚫렸다고 가정).
  const startSent = bus.sent.find((s) => s.obj.type === 'START');
  const before = B.events.filter((e) => e.type === 'roundStart').length;
  B.onMessage(JSON.parse(JSON.stringify(startSent.obj)), { address: '10.0.0.1' });
  flush();
  const after = B.events.filter((e) => e.type === 'roundStart').length;

  check('T7 [P0-1] 같은 START가 다시 들어와도 라운드는 다시 시작되지 않음',
    after === before, `roundStart ${before} → ${after}`);
}

function t8_lateVoteAfterResolve() {
  const { bus, players } = makeWorld(['A', 'B', 'C']);
  const [A, B, C] = players;
  const restore = fixRandom(2, 3, 0); // 라이어=C
  A.game.startGame(); restore(); flush();

  A.game.callVote(); flush();
  A.game.sendVote('P3'); flush();
  B.game.sendVote('P3'); flush();
  advance(31000); // C가 투표하지 않아 제한 시간으로 강제 집계 → C 지목 → 정답 대기

  check('T8 지목 후 정답 대기 단계로 넘어감', has(C, 'awaitGuess'));

  const rid = bus.sent.find((m) => m.obj.type === 'START').obj.roundId;
  const before = A.events.filter((e) => e.type === 'voteStart').length;
  // 집계가 끝난 뒤 C의 표가 뒤늦게 도착한다. 이걸 받아 주면 정답 단계에서 투표가 다시 열린다.
  A.onMessage({ type: 'VOTE', voterId: 'P3', roundId: rid, targetId: 'P1' }, { address: '10.0.0.3' });
  flush();
  const after = A.events.filter((e) => e.type === 'voteStart').length;

  check('T8 늦게 도착한 표가 끝난 투표를 다시 열지 않음', after === before, `voteStart ${before} → ${after}`);
}

function t9_minimumPlayers() {
  const { players } = makeWorld(['A', 'B']);
  const [A] = players;
  A.game.startGame(); flush();

  const rejected = last(A, 'startRejected');
  check('T9 [P1-6] 3명 미만이면 시작을 거부', !!rejected && rejected.reason === 'tooFewPlayers',
    rejected ? `reason=${rejected.reason}, have=${rejected.have}` : '거부 이벤트 없음');
  check('T9 [P1-6] 거부됐으면 라운드도 시작되지 않음', !has(A, 'roundStart'));
}

function t10_guessTimeout() {
  const { players } = makeWorld(['A', 'B', 'C']);
  const [A, B, C] = players;
  const restore = fixRandom(2, 3, 0); // 라이어=C
  A.game.startGame(); restore(); flush();

  A.game.callVote(); flush();
  A.game.sendVote('P3'); flush();
  B.game.sendVote('P3'); flush();
  C.game.sendVote('P1'); flush();
  advance(1000);
  check('T10 라이어가 지목되어 정답 대기', has(C, 'awaitGuess'));

  advance(31000); // 라이어가 정답을 내지 않고 버틴다
  const finals = players.map((p) => last(p, 'result'));
  check('T10 [P1-9] 정답 제한 시간이 지나면 시민 승으로 정리',
    finals.every((r) => r && r.winner === 'citizens' && r.reason === 'guessTimeout'),
    finals.map((r, i) => `${players[i].nickname}:${r ? r.winner + '/' + r.reason : '없음'}`).join(' '));
}

function t11_revealTimeout() {
  const { bus, players } = makeWorld(['A', 'B', 'C']);
  const [A, B, C] = players;
  const restore = fixRandom(0, 3, 0); // 라이어=A(호스트), 지목될 B는 라이어가 아니다
  A.game.startGame(); restore(); flush();

  bus.drop = (msg) => msg.type === 'REVEAL'; // 지목된 사람의 공개가 아무에게도 닿지 않는다
  A.game.callVote(); flush();
  A.game.sendVote('P2'); flush();
  C.game.sendVote('P2'); flush();
  B.game.sendVote('P1'); flush();
  advance(1000);

  check('T11 아직 결과가 나오지 않음(공개 대기)', !last(A, 'result'));
  advance(9000); // 공개 대기 시간 경과
  const finals = players.map((p) => last(p, 'result'));
  check('T11 [P1-9] 공개가 오지 않으면 라운드를 취소',
    finals.every((r) => r && r.reason === 'noReveal'),
    finals.map((r, i) => `${players[i].nickname}:${r ? r.reason : '없음'}`).join(' '));
}

function t12_guessFromWrongPerson() {
  const { bus, players } = makeWorld(['A', 'B', 'C']);
  const [A, B, C] = players;
  const restore = fixRandom(2, 3, 0); // 라이어=C
  A.game.startGame(); restore(); flush();

  A.game.callVote(); flush();
  A.game.sendVote('P3'); flush();
  B.game.sendVote('P3'); flush();
  C.game.sendVote('P1'); flush();
  advance(1000);

  const rid = bus.sent.find((m) => m.obj.type === 'START').obj.roundId;
  // 지목되지 않은 B가 정답을 제출하려 한다 (화면 잠금을 우회한 상황)
  B.game.submitGuess('사과'); flush();
  check('T12 [P2-13] 지목되지 않은 사람의 정답은 전송조차 되지 않음',
    !bus.sent.some((m) => m.obj.type === 'GUESS' && m.from === 'P2'));

  // 위조 패킷을 호스트에게 직접 밀어 넣어도 판정하지 않아야 한다
  A.onMessage({ type: 'GUESS', id: 'P2', roundId: rid, word: '사과' }, { address: '10.0.0.2' });
  flush();
  check('T12 [P2-13] 위조된 정답 패킷도 호스트가 판정하지 않음', !last(A, 'result'));
}

function t13_voteValidation() {
  const { bus, players } = makeWorld(['A', 'B', 'C']);
  const [A] = players;
  const restore = fixRandom(0, 3, 0);
  A.game.startGame(); restore(); flush();
  A.game.callVote(); flush();

  A.game.sendVote('P1'); flush();  // 자기 자신
  A.game.sendVote('P9'); flush();  // 이번 라운드 명단에 없는 사람
  const votesSent = bus.sent.filter((m) => m.obj.type === 'VOTE').length;
  check('T13 [P2-13] 자기 자신·명단 외 투표는 전송되지 않음', votesSent === 0, `VOTE ${votesSent}건`);

  A.game.sendVote('P2'); flush();  // 정상
  check('T13 정상 투표는 전송됨', bus.sent.filter((m) => m.obj.type === 'VOTE').length === 1);
}

console.log(`라운드 진행 테스트  (대상: ${GAME_PATH})`);
for (const fn of [t1_voteLossStillAgrees, t2_noVotesBroadcast, t3_singleResultOnGuess,
  t4_roleResetBetweenRounds, t5_missedCallVote, t6_wordForSomeoneElse, t7_duplicateStart, t8_lateVoteAfterResolve,
  t9_minimumPlayers, t10_guessTimeout, t11_revealTimeout, t12_guessFromWrongPerson, t13_voteValidation]) {
  try { fn(); } catch (err) { check(`${fn.name} 실행 중 예외`, false, err.message); }
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n라운드 진행: ${results.length - failed}/${results.length} 통과`);
Module._load = originalLoad;
process.exit(failed === 0 ? 0 : 1);

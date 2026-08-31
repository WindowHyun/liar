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

/**
 * 전원이 대화권을 한 번씩 써서 설명 단계를 끝낸다(1인 1회). 본론은 대개 그다음이라서.
 * 순서는 매 판 섞이므로 방에 물어보며 진행한다.
 *
 * 설명을 다 돌면 "자유 대화를 할까요?" O/X가 뜬다. 여기서는 전원 찬성으로 통과시켜
 * 자유 대화까지 연다(그 O/X 자체를 보는 테스트는 answerFreeAsk를 직접 쓴다).
 */
function passTurns(room) {
  for (let guard = 0; guard < 200; guard += 1) {
    const dbg = room._debug();
    if (dbg.phase !== 'turn' || !dbg.round) break;
    const speaker = dbg.round.speakOrder[dbg.round.speakIndex];
    if (!speaker) break;
    room.say(speaker, `${speaker} 설명합니다`);
  }
  answerFreeAsk(room, true);
}

/** 자유 대화 O/X에 전원이 같은 답을 낸다. 그 단계가 아니면 아무것도 하지 않는다. */
function answerFreeAsk(room, agree) {
  const dbg = room._debug();
  if (dbg.phase !== 'proposal' || !dbg.round || !dbg.round.proposal) return;
  if (dbg.round.proposal.kind !== 'free') return;
  for (const r of dbg.round.roster) room.respondProposal(r.id, agree);
}

/** 투표를 제안하고 전원 찬성으로 통과시킨다. 설명이 안 끝났으면 먼저 끝낸다. */
function passProposal(room, ids) {
  passTurns(room);
  room.callVote(ids[0]);
  for (const id of ids) room.respondProposal(id, true);
}

// ─────────────────────────────── 테스트 ───────────────────────────────

function w1_minimumPlayers() {
  const { room } = makeRoom(['A'], 0);
  const reason = room.start();
  check('W1 혼자서는 시작할 수 없고 사유를 돌려준다',
    typeof reason === 'string' && reason.includes('최소 2명'), reason);
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

  passProposal(room, [a, b, c]);
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

  passProposal(room, [a, b, c]);
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
  passProposal(room, [a, b, c]);
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
  const [a, b, c] = idsOf(players);
  passProposal(room, [a, b, c]);
  advance(31000);
  const s = room.stateFor(a);
  check('W6 아무도 투표하지 않으면 제한 시간 뒤 라이어 승',
    s.phase === 'result' && s.result.reason === 'noVotes', s.result ? s.result.reason : '없음');
}

function w7_disconnectDoesNotBlockVote() {
  const { room, players } = makeRoom(['A', 'B', 'C'], 0); // 라이어 = A
  room.start();
  const [a, b, c] = idsOf(players);
  passProposal(room, [a, b, c]);
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
  passTurns(room);
  check('W10 자유 대화 중에는 말할 수 있다', room.say(a, '빨갛습니다') === null);
  room.callVote(a);
  check('W10 [이슈1] 찬반 단계부터 대화가 막힌다',
    typeof room.say(a, '나 아니라니까요') === 'string', room.say(a, 'x') || '통과해버림');
  for (const id of [a, b, c]) room.respondProposal(id, true);
  check('W10 투표 중에는 서버가 대화를 막는다', typeof room.say(a, '몰래 힌트') === 'string');
  room.vote(a, b); room.vote(c, b); room.vote(b, a);
  check('W10 정답 단계에서도 막힌다', typeof room.say(a, '힌트') === 'string');
  room.guess(b, '땡');
  check('W10 라운드가 끝나면 다시 열린다', room.say(a, '한 판 더') === null);
}

function w11_proposalMajority() {
  const { room, players } = makeRoom(['A', 'B', 'C', 'D'], 0);
  room.start();
  const [a, b, c, d] = idsOf(players);
  passTurns(room);

  room.callVote(a);
  check('W11 투표 버튼을 누르면 바로 투표가 아니라 찬반 단계로 간다',
    room.stateFor(b).phase === 'proposal', room.stateFor(b).phase);
  check('W11 참가자 전원에게 찬반 창이 뜬다',
    [a, b, c, d].every((id) => room.stateFor(id).round.proposal !== null));

  room.respondProposal(a, true);
  room.respondProposal(b, false);
  check('W11 찬1 반1(4명 중)이면 아직 결론이 나지 않는다',
    room.stateFor(a).phase === 'proposal');

  room.respondProposal(c, false);
  // 반대 2 > 4/2 이 아니라 같음. 아직 A와 D가 남았으므로 결론 보류
  check('W11 찬1 반2(4명 중)면 아직 보류 - 남은 한 명이 찬성하면 50%',
    room.stateFor(a).phase === 'proposal', room.stateFor(a).phase);

  room.respondProposal(d, true);
  check('W11 [요청] 2명 O, 2명 X면 50%라서 투표를 진행한다',
    room.stateFor(a).phase === 'voting', room.stateFor(a).phase);
}

function w12_proposalRejected() {
  const { room, players } = makeRoom(['A', 'B', 'C', 'D'], 0);
  room.start();
  const [a, b, c, d] = idsOf(players);
  passTurns(room);

  room.callVote(a);
  room.respondProposal(a, false);
  room.respondProposal(b, false);
  room.respondProposal(c, false);
  check('W12 반대가 절반을 넘으면 그 자리에서 부결된다 (남은 사람을 기다리지 않는다)',
    room.stateFor(d).phase === 'free', room.stateFor(d).phase);
  check('W12 부결되면 자유 대화로 돌아가 이야기를 이어갈 수 있다', room.say(a, '계속 이야기합니다') === null);
  check('W12 부결 안내가 옛 진행 방식(설명 단계)을 가리키지 않는다',
    room.stateFor(a).chat.some((m) => m.code === 'proposalRejected' && !m.text.includes('설명을')));
  check('W12 부결 뒤에 다시 제안할 수 있다', room.callVote(b) === null);
}

function w13_proposalTimeout() {
  const { room, players } = makeRoom(['A', 'B', 'C', 'D'], 0);
  room.start();
  const [a, b] = idsOf(players);
  passTurns(room);

  room.callVote(a);
  room.respondProposal(a, true);
  room.respondProposal(b, true);
  check('W13 찬2(4명 중)면 50%라 즉시 진행 - 나머지를 기다리지 않는다',
    room.stateFor(a).phase === 'voting', room.stateFor(a).phase);

  const second = makeRoom(['A', 'B', 'C', 'D'], 0);
  second.room.start();
  const ids = idsOf(second.players);
  passTurns(second.room);
  second.room.callVote(ids[0]);
  second.room.respondProposal(ids[0], true);
  advance(21000);
  check('W13 아무도 더 답하지 않으면 제한 시간에 정리된다 (찬1/4 → 부결)',
    second.room.stateFor(ids[1]).phase === 'free', second.room.stateFor(ids[1]).phase);
}

function w15_tokenSeatCollision() {
  const { room, players } = makeRoom(['A', 'B'], 0);
  const token = players[0].token;

  // 같은 토큰으로 또 들어온다 - 첫 번째가 아직 접속해 있는 상태
  const second = room.join({ nickname: 'A2', token });
  check('W15 이미 접속 중인 자리는 토큰이 같아도 뺏지 않는다 (새 참가자가 된다)',
    second.playerId !== players[0].playerId && second.restored === false,
    `기존=${players[0].playerId} / 새로=${second.playerId}`);
  check('W15 그래서 창 두 개가 두 참가자로 보인다',
    room.stateFor(second.playerId).players.length === 3);

  // 끊긴 뒤에는 같은 토큰으로 원래 자리에 돌아온다
  room.disconnect(players[0].playerId);
  const back = room.join({ nickname: 'A', token });
  check('W15 끊긴 자리는 같은 토큰으로 돌아올 수 있다',
    back.playerId === players[0].playerId && back.restored === true);
}

function w14_twoPlayers() {
  const { room, players } = makeRoom(['A', 'B'], 0);
  const reason = room.start();
  check('W14 [요청] 2명이면 시작된다', reason === null, reason || 'OK');
  const [a] = idsOf(players);
  passTurns(room);
  room.callVote(a);
  room.respondProposal(a, true);
  check('W14 2명 중 1명 찬성이면 50%라 진행', room.stateFor(a).phase === 'voting', room.stateFor(a).phase);
}

function w16_emptyRoundIsAbandoned() {
  const { room, players } = makeRoom(['A', 'B', 'C'], 0);
  room.start();
  const ids = idsOf(players);
  check('W16 라운드가 진행 중이다', room._debug().phase === 'turn');

  ids.forEach((id) => room.disconnect(id));
  check('W16 [W-1] 전원이 나가면 라운드를 접고 로비로 돌아온다',
    room._debug().phase === 'lobby', room._debug().phase);

  const late1 = room.join({ nickname: '새참가자' });
  const late2 = room.join({ nickname: '또다른참가자' });
  const s = room.stateFor(late1.playerId);
  check('W16 [W-1] 새로 들어온 사람이 관전자로 갇히지 않는다', s.you.inRound === false && s.phase === 'lobby');
  check('W16 [W-1] 새 참가자들이 게임을 시작할 수 있다', room.start() === null && room._debug().phase === 'turn');

  // 끊긴 유령은 시간이 지나면 목록에서 사라진다
  advance(61000);
  const names = room.stateFor(late2.playerId).players.map((p) => p.nickname);
  check('W16 [W-1] 끊긴 유령이 목록에서 정리된다',
    !names.includes('A') && !names.includes('B') && !names.includes('C'), names.join(', '));
}

function w17_emptyProposalDoesNotPass() {
  const { room, players } = makeRoom(['A', 'B', 'C'], 0);
  room.start();
  const ids = idsOf(players);
  passTurns(room);
  room.callVote(ids[0]);
  check('W17 찬반 단계에 들어갔다', room._debug().phase === 'proposal');

  ids.forEach((id) => room.disconnect(id));
  check('W17 [W-2] 인원 0명이 50% 조건을 통과해 투표로 넘어가지 않는다',
    room._debug().phase === 'lobby', room._debug().phase);
}

function w18_spectatorCannotChat() {
  const { room, players } = makeRoom(['A', 'B'], 0); // 라이어 = A
  room.start();
  const [a, b] = idsOf(players);
  const spectator = room.join({ nickname: '관전자' });

  const reason = room.say(spectator.playerId, '저 사람 수상한데요');
  check('W18 [W-3] 관전자는 진행 중인 판에 끼어들 수 없다',
    typeof reason === 'string' && reason.includes('관전'), reason || '통과해버림');

  // 라운드를 끝까지 진행한다 (서로 지목 → 동점 → 라이어 승)
  passProposal(room, [a, b]);
  room.vote(a, b);
  room.vote(b, a);
  check('W18 라운드가 끝났다', room._debug().phase === 'result', room._debug().phase);

  check('W18 [W-3] 라운드가 끝나면 관전자도 대화할 수 있다',
    room.say(spectator.playerId, '이제 말해도 되나요') === null);
  check('W18 [W-3] 다음 라운드부터는 참가자로 들어간다',
    room.start() === null && room.stateFor(spectator.playerId).you.inRound === true);
}

// ── 진행방식 변경: 설명(1인 1회) → 자유 채팅 1분 → 투표 ──────────────

function w19_oneTurnPerPerson() {
  const { room, players } = makeRoom(['A', 'B', 'C'], 0);
  room.start();
  const ids = idsOf(players);
  const order = room._debug().round.speakOrder.slice();

  check('W19 시작하면 설명 단계부터다', room._debug().phase === 'turn', room._debug().phase);
  check('W19 대화권 순서는 전원이 정확히 1회씩',
    order.length === ids.length && new Set(order).size === ids.length, order.join(','));

  const [first, second] = order;
  const cutIn = room.say(second, '끼어들기');
  check('W19 차례가 아닌 사람은 말할 수 없다', typeof cutIn === 'string', cutIn || '통과해버림');
  check('W19 차례인 사람은 말할 수 있다', room.say(first, '동그랗습니다') === null);

  const again = room.say(first, '하나 더 덧붙이면');
  check('W19 [요청] 대화권은 무조건 1인 1회 - 한 바퀴에 두 번 말할 수 없다',
    typeof again === 'string', again || '통과해버림');
  check('W19 말하고 나면 대화권이 다음 사람에게 넘어간다',
    room.stateFor(first).round.speaker.id === second,
    room.stateFor(first).round.speaker.nickname);
  check('W19 누가 설명을 마쳤는지 모두가 본다',
    room.stateFor(second).players.find((p) => p.id === first).spoke === true);
}

function w20_freeChatAfterEveryoneSpoke() {
  const { room, players } = makeRoom(['A', 'B', 'C'], 0);
  room.start();
  const ids = idsOf(players);
  passTurns(room);

  check('W20 전원이 대화권을 쓰면 자유 채팅으로 넘어간다',
    room._debug().phase === 'free', room._debug().phase);
  check('W20 자유 채팅에서는 아무나 여러 번 말할 수 있다',
    room.say(ids[0], '한 번') === null && room.say(ids[0], '두 번') === null);
  check('W20 자유 채팅에도 남은 시간이 내려간다',
    room.stateFor(ids[0]).round.freeEndsAt > 0);

  advance(61000); // FREE_MS
  check('W20 1분이 지나면 찬반 없이 곧바로 투표로 간다',
    room._debug().phase === 'voting', room._debug().phase);
}

function w21_voteOnlyAfterExplanations() {
  const { room, players } = makeRoom(['A', 'B', 'C'], 0);
  room.start();
  const ids = idsOf(players);

  const tooEarly = room.callVote(ids[0]);
  check('W21 설명이 끝나기 전에는 투표를 제안할 수 없다',
    typeof tooEarly === 'string' && tooEarly.includes('설명'), tooEarly || '통과해버림');

  passTurns(room);
  check('W21 설명이 끝나면 제안할 수 있다', room.callVote(ids[0]) === null);
}

function w22_turnTimeoutMovesOn() {
  const { room } = makeRoom(['A', 'B', 'C'], 0);
  room.start();
  const order = room._debug().round.speakOrder.slice();

  advance(61000); // SPEAK_MS
  check('W22 설명 시간을 넘기면 다음 사람에게 대화권이 넘어간다',
    room.stateFor(order[1]).round.speaker.id === order[1],
    room.stateFor(order[1]).round.speaker.nickname);
  check('W22 넘긴 사람은 설명한 것으로 치지 않는다',
    room._debug().round.spoken.size === 0 && room._debug().round.speakRound === 1);
  check('W22 넘겼다는 사실이 대화에 남는다',
    room.stateFor(order[1]).chat.some((m) => m.code === 'turnSkipped'));
}

function w23_disconnectedSpeakerSkipped() {
  const { room } = makeRoom(['A', 'B', 'C'], 0);
  room.start();
  const order = room._debug().round.speakOrder.slice();

  room.disconnect(order[0]); // 말할 차례인 사람이 창을 닫았다
  check('W23 차례인 사람이 나가면 60초를 기다리지 않고 다음 사람으로 넘어간다',
    room.stateFor(order[1]).round.speaker.id === order[1],
    room.stateFor(order[1]).round.speaker.nickname);

  passTurns(room);
  check('W23 남은 사람이 정해진 바퀴를 다 돌면 자유 채팅으로 넘어간다',
    room._debug().phase === 'free', room._debug().phase);
}

function w24_rejectedProposalReturnsToFree() {
  const { room, players } = makeRoom(['A', 'B', 'C', 'D'], 0);
  room.start();
  const [a, b, c] = idsOf(players);
  passTurns(room);

  room.callVote(a);
  room.respondProposal(a, false);
  room.respondProposal(b, false);
  room.respondProposal(c, false);
  check('W24 부결되면 설명 단계가 아니라 자유 채팅으로 돌아간다',
    room._debug().phase === 'free', room._debug().phase);
  check('W24 부결 뒤에도 대화권을 다시 요구하지 않는다 (아무나 말할 수 있다)',
    room.say(b, '조금만 더 이야기해요') === null);

  advance(61000);
  check('W24 되돌아온 자유 채팅도 1분 뒤 투표로 간다',
    room._debug().phase === 'voting', room._debug().phase);
}

function w25_stateExposesTurnProgress() {
  const { room } = makeRoom(['A', 'B', 'C'], 0);
  room.start();
  const order = room._debug().round.speakOrder.slice();
  const s1 = room.stateFor(order[0]);

  check('W25 화면이 그릴 수 있게 지금 차례를 상태에 담는다',
    s1.round.speaker && s1.round.speaker.id === order[0], JSON.stringify(s1.round.speaker));
  check('W25 내 차례인지 스스로 안다',
    s1.you.myTurn === true && room.stateFor(order[1]).you.myTurn === false);
  check('W25 진행 상황(몇 명 중 몇 명)이 상태에 있다',
    s1.round.speakTotal === 3 && s1.round.spokenCount === 0,
    `${s1.round.spokenCount}/${s1.round.speakTotal}`);

  room.say(order[0], '둥급니다');
  const s2 = room.stateFor(order[0]);
  check('W25 말하고 나면 진행 상황이 올라간다', s2.round.spokenCount === 1);
  check('W25 대화권 순서 자체는 상태로 새어 나가지 않는다',
    !JSON.stringify(s2).includes('speakOrder'));
}

// ── 나가기 / 끊김 정리 ────────────────────────────────────────────────

function w26_leaveIsImmediate() {
  const { room, players } = makeRoom(['A', 'B', 'C'], 0);
  room.start();
  const [a, , c] = idsOf(players);

  room.leave(c);
  const s = room.stateFor(a);
  check('W26 [요청] 나가기를 누르면 유예 없이 그 자리에서 목록에서 사라진다',
    s.players.every((p) => p.id !== c), s.players.map((p) => p.nickname).join(','));
  check('W26 나간 사람은 상태에도 나간 것으로 표시된다',
    s.round.roster.find((r) => r.id === c).left === true);
}

function w27_roundEndsWhenTooFewRemain() {
  // [이슈] 예전에는 "한 명도 안 남았을 때"만 접어서, 2명이 하다가 한 명이 나가면
  // 남은 사람이 2분 넘게 아무것도 못 하고 갇혔다.
  const { room, players } = makeRoom(['A', 'B'], 0);
  room.start();
  const [a, b] = idsOf(players);
  check('W27 라운드가 진행 중이다', room._debug().phase === 'turn');

  room.leave(b);
  const s = room.stateFor(a);
  check('W27 [이슈] 남은 인원이 최소 인원보다 적어지면 그 자리에서 라운드가 취소된다',
    s.phase === 'lobby', s.phase);
  check('W27 [이슈] 취소 사유가 대화에 남는다',
    s.chat.some((m) => m.code === 'abandoned'));

  const late = room.join({ nickname: '지현' });
  check('W27 [이슈] 새 사람이 들어오면 곧바로 다음 판을 시작할 수 있다',
    room.stateFor(a).canStart === true && room.start() === null);
  check('W27 새 사람이 관전자로 갇히지 않는다',
    room.stateFor(late.playerId).you.inRound === true);
}

function w28_disconnectGraceIsTenSeconds() {
  const { room, players } = makeRoom(['A', 'B', 'C'], 0);
  room.start();
  const [a, , c] = idsOf(players);
  const names = () => room.stateFor(a).players.map((p) => p.nickname);

  room.disconnect(c); // 튕겼다 - 돌아올 수도 있다
  check('W28 튕긴 직후에는 자리가 남아 있다', names().includes('C'), names().join(','));

  advance(9000);
  check('W28 [요청] 10초 안에는 돌아올 자리가 남아 있다', names().includes('C'), names().join(','));

  advance(2000);
  check('W28 [요청] 10초가 지나면 목록에서 즉시 지운다', !names().includes('C'), names().join(','));
  check('W28 라운드 중에도 10초다 (예전에는 60초였다)', room.DROP_MS === 10000, String(room.DROP_MS));
}

function w29_cannotVoteForSomeoneWhoLeft() {
  const { room, players } = makeRoom(['A', 'B', 'C', 'D'], 0);
  room.start();
  const [a, b, c, d] = idsOf(players);
  passProposal(room, [a, b, c, d]);
  check('W29 투표 중이다', room._debug().phase === 'voting', room._debug().phase);

  room.leave(d);
  const reason = room.vote(a, d);
  check('W29 이미 나간 사람에게는 투표할 수 없다',
    typeof reason === 'string' && reason.includes('나간'), reason || '통과해버림');
  check('W29 나간 사람을 빼고도 투표는 계속된다',
    room._debug().phase === 'voting', room._debug().phase);

  room.vote(a, b); room.vote(b, a); room.vote(c, a);
  check('W29 남은 사람만으로 개표된다', room._debug().phase !== 'voting', room._debug().phase);
}

function w30_leavingSpeakerPassesTurn() {
  const { room } = makeRoom(['A', 'B', 'C', 'D'], 0);
  room.start();
  const order = room._debug().round.speakOrder.slice();

  room.leave(order[0]); // 말할 차례인 사람이 나갔다
  check('W30 차례인 사람이 나가면 대화권이 바로 다음 사람에게 넘어간다',
    room.stateFor(order[1]).round.speaker.id === order[1],
    room.stateFor(order[1]).round.speaker.nickname);
  check('W30 나간 사람 자리를 기다리지 않는다', room._debug().phase === 'turn');
}

function w31_leaveThenRejoinIsANewSeat() {
  const { room, players } = makeRoom(['A', 'B'], 0);
  const token = players[0].token;
  room.leave(players[0].playerId);

  // 나가기는 자리를 버리는 것이다. 같은 토큰으로 들어와도 옛 자리로 되살아나면 안 된다.
  const back = room.join({ nickname: 'A', token });
  check('W31 나간 뒤 다시 들어오면 새 자리로 들어간다',
    back.restored === false && back.playerId !== players[0].playerId,
    `옛자리=${players[0].playerId} / 새자리=${back.playerId}`);
  check('W31 유령이 남지 않는다', room.stateFor(back.playerId).players.length === 2,
    room.stateFor(back.playerId).players.map((p) => p.nickname).join(','));
}

// ── 튕겼다 돌아오기 / 라이어 이탈 ────────────────────────────────────

function w32_rejoinAfterGraceKeepsSeat() {
  // [이슈] 10초를 넘겨 돌아오면 관전자가 되어, 그 판이 끝날 때까지 말을 못 했다.
  const { room, players } = makeRoom(['A', 'B', 'C'], 0); // 라이어 = A
  room.start();
  passTurns(room);
  const c = players[2].playerId;
  const token = players[2].token;

  room.disconnect(c);
  advance(11000); // 유예를 넘겨 목록에서 지워졌다
  check('W32 유예를 넘기면 목록에서는 지워진다',
    room.stateFor(players[0].playerId).players.every((p) => p.id !== c));

  const back = room.join({ nickname: 'C', token });
  const s = room.stateFor(back.playerId);
  check('W32 [이슈] 늦게 돌아와도 원래 자리로 앉는다',
    back.restored === true && back.playerId === c, `${back.playerId} vs ${c}`);
  check('W32 [이슈] 돌아온 사람은 관전자가 아니라 참가자다', s.you.inRound === true);
  check('W32 [이슈] 돌아오면 바로 대화할 수 있다',
    room.say(back.playerId, '다시 왔어요') === null);
  check('W32 유령이 늘어나지 않는다', s.players.length === 3,
    s.players.map((p) => p.nickname).join(','));
  check('W32 남의 토큰이 상태로 새어 나가지 않는다', !JSON.stringify(s).includes(token));
}

function w33_leavingGivesUpTheSeat() {
  const { room, players } = makeRoom(['A', 'B', 'C'], 0);
  room.start();
  const token = players[2].token;

  room.leave(players[2].playerId); // 스스로 나갔다 - 자리를 버린 것이다
  const back = room.join({ nickname: 'C', token });
  check('W33 나가기를 누른 사람은 같은 토큰으로도 옛 자리로 돌아오지 않는다',
    back.restored === false && back.playerId !== players[2].playerId);
  check('W33 그래서 이번 판은 관전한다',
    room.stateFor(back.playerId).you.inRound === false);
}

function w34_liarLeavingCancelsRound() {
  // [이슈] 라이어가 나가도 판이 계속돼서, 도망간 라이어가 승리로 기록됐다.
  const { room, players } = makeRoom(['A', 'B', 'C'], 1); // 라이어 = B
  room.start();
  passTurns(room);
  const [a, b] = idsOf(players);
  check('W34 라이어는 B다', room._debug().round.liarId === b);

  room.leave(b);
  const s = room.stateFor(a);
  check('W34 [이슈] 라이어가 나가면 그 자리에서 라운드가 끝난다', s.phase === 'result', s.phase);
  check('W34 [요청] 도망친 라이어는 진 것으로 본다 (시민 승)',
    s.result.winner === 'citizens' && s.result.reason === 'liarLeft',
    s.result.winner + '/' + s.result.reason);
  check('W34 [요청] 누가 라이어였는지 밝힌다',
    s.result.liar.nickname === 'B' && s.chat.some((m) => m.code === 'result' && m.liarName === 'B'));
  check('W34 시민 승으로 전적에 쌓인다',
    s.record.citizenWins === 1 && s.record.liarWins === 0, JSON.stringify(s.record));
  check('W34 곧바로 다음 판을 시작할 수 있다', room.start() === null);
}

function w35_liarDisconnectGetsTheSameGrace() {
  const { room, players } = makeRoom(['A', 'B', 'C'], 1); // 라이어 = B
  room.start();
  passTurns(room);
  const b = players[1].playerId;
  const token = players[1].token;

  room.disconnect(b); // 튕겼다 - 돌아올 수 있다
  check('W35 라이어가 튕긴 것만으로는 판을 접지 않는다',
    room._debug().phase === 'free', room._debug().phase);

  const back = room.join({ nickname: 'B', token });
  check('W35 10초 안에 돌아오면 라이어 그대로 이어서 한다',
    room.stateFor(back.playerId).you.isLiar === true && room._debug().phase === 'free');

  room.disconnect(back.playerId);
  advance(11000);
  check('W35 10초를 넘기면 그때 시민 승으로 끝낸다',
    room._debug().phase === 'result'
    && room.stateFor(players[0].playerId).result.reason === 'liarLeft',
    room._debug().phase);
}

function w36_twoPlayerRoundIsNotCancelled() {
  // 2명으로 하는 판이 도중에 "인원 부족"으로 취소되면 안 된다.
  const { room, players } = makeRoom(['A', 'B'], 0);
  room.start();
  const [a, b] = idsOf(players);
  passTurns(room);
  check('W36 2명이어도 설명 단계를 지나 자유 대화까지 간다',
    room._debug().phase === 'free', room._debug().phase);

  room.callVote(a);
  room.respondProposal(a, true);
  check('W36 2명이어도 투표까지 간다', room._debug().phase === 'voting', room._debug().phase);

  room.vote(a, b); room.vote(b, a);
  const s = room.stateFor(a);
  check('W36 2명짜리 판이 끝까지 진행돼 결과가 나온다',
    s.phase === 'result' && !!s.result, s.phase);
  check('W36 도중에 인원 부족으로 취소되지 않았다',
    !s.chat.some((m) => m.code === 'abandoned'));
}

function w37_twoSpeakRounds() {
  // [규칙 변경] 1차 턴제 → 2차 턴제 → 자유 → 투표
  const { room, players } = makeRoom(['A', 'B', 'C'], 0);
  room.start();
  const ids = idsOf(players);
  check('W37 시작하면 1차 설명부터다',
    room.stateFor(ids[0]).round.speakRound === 1
    && room.stateFor(ids[0]).round.speakRounds === 2);

  const first = room._debug().round.speakOrder.slice();
  first.forEach((id) => room.say(id, '1차 설명'));
  check('W37 [규칙] 한 바퀴를 다 돌아도 자유 대화로 가지 않는다',
    room._debug().phase === 'turn', room._debug().phase);
  check('W37 [규칙] 2차 설명으로 넘어간다',
    room.stateFor(ids[0]).round.speakRound === 2);
  check('W37 2차가 시작됐다고 대화에 남는다',
    room.stateFor(ids[0]).chat.some((m) => m.code === 'speakRoundStart' && m.speakRound === 2));
  check('W37 2차에서는 전원이 다시 말할 수 있다',
    room.stateFor(ids[0]).round.spokenCount === 0);

  const second = room._debug().round.speakOrder.slice();
  check('W37 2차 순서는 새로 섞는다 (같은 사람이 계속 마지막에 걸리지 않게)',
    second.length === first.length && new Set(second).size === first.length,
    `1차 ${first.join(',')} / 2차 ${second.join(',')}`);

  const tooEarly = room.callVote(ids[0]);
  check('W37 [규칙] 2차 설명 중에도 투표를 제안할 수 없다',
    typeof tooEarly === 'string' && tooEarly.includes('설명'), tooEarly || '통과해버림');

  second.forEach((id) => room.say(id, '2차 설명'));
  // [규칙 변경] 2차까지 끝나면 바로 자유 대화가 아니라, 할지 말지를 먼저 O/X로 묻는다.
  check('W37 [규칙] 2차까지 끝나면 자유 대화 O/X를 묻는다',
    room._debug().phase === 'proposal' && room._debug().round.proposal.kind === 'free',
    room._debug().phase);
  check('W37 무엇을 묻는지 대화에 남는다',
    room.stateFor(ids[0]).chat.some((m) => m.code === 'freeAsked' && m.text.includes('2차')));

  answerFreeAsk(room, true);
  check('W37 [규칙] 찬성하면 자유 대화가 열린다',
    room._debug().phase === 'free', room._debug().phase);
  check('W37 [규칙] 자유 대화부터 투표를 제안할 수 있다', room.callVote(ids[0]) === null);
}

function w38_secondRoundStillOnePerPerson() {
  const { room } = makeRoom(['A', 'B', 'C'], 0);
  room.start();
  room._debug().round.speakOrder.slice().forEach((id) => room.say(id, '1차'));

  const order2 = room._debug().round.speakOrder.slice();
  check('W38 2차에서도 차례가 아니면 말할 수 없다',
    typeof room.say(order2[1], '끼어들기') === 'string');
  check('W38 2차에서도 차례면 말할 수 있다', room.say(order2[0], '2차 설명') === null);
  check('W38 2차에서도 한 사람이 두 번 말할 수 없다',
    typeof room.say(order2[0], '한 번 더') === 'string');
}

// ── 위험 영역 점검에서 나온 것들 ────────────────────────────────────

function w39_departedVotesAreDropped() {
  // [H1] 나간 사람의 표가 개표에 남아 결과를 갈랐다.
  const { room, players } = makeRoom(['A', 'B', 'C', 'D'], 0); // 라이어 = A
  room.start();
  const [a, b, c, d] = idsOf(players);
  passProposal(room, [a, b, c, d]);

  room.vote(b, c);
  check('W39 B의 표가 들어갔다', room._debug().round.votes.size === 1);

  room.leave(b);
  check('W39 [H1] 나가면 그 사람이 던진 표도 함께 사라진다',
    room._debug().round.votes.size === 0, String(room._debug().round.votes.size));

  room.vote(a, d); room.vote(c, d); room.vote(d, c);
  const s = room.stateFor(a);
  check('W39 [H1] 남은 사람 표만으로 개표된다 (D 단독 2표)',
    s.result && s.result.reason === 'wrongAccusation' && s.result.accused.nickname === 'D',
    s.result ? `${s.result.reason}/${s.result.accused ? s.result.accused.nickname : '-'}` : '아직');
}

function w40_votesForDepartedAreDropped() {
  // [H2] 방에 없는 사람이 지목되어 "○○님이 지목되었습니다"가 떴다.
  const { room, players } = makeRoom(['A', 'B', 'C', 'D'], 0); // 라이어 = A
  room.start();
  const [a, b, c, d] = idsOf(players);
  passProposal(room, [a, b, c, d]);

  room.vote(c, b); room.vote(d, b);   // C와 D가 B를 지목
  room.leave(b);                       // B가 나간다
  check('W40 [H2] 나간 사람에게 갔던 표도 사라진다',
    room._debug().round.votes.size === 0, String(room._debug().round.votes.size));
  check('W40 [H2] 던졌던 사람은 다시 고를 수 있다',
    room.stateFor(c).you.hasVoted === false);

  room.vote(a, c); room.vote(c, a); room.vote(d, c);
  const s = room.stateFor(a);
  check('W40 [H2] 방에 없는 사람이 지목되지 않는다',
    !s.result || !s.result.accused || s.result.accused.nickname !== 'B',
    s.result && s.result.accused ? s.result.accused.nickname : '지목 없음');
}

function w41_departedProposalAnswerIsDropped() {
  const { room, players } = makeRoom(['A', 'B', 'C', 'D'], 0);
  room.start();
  const [a, b] = idsOf(players);
  passTurns(room);

  room.callVote(a);
  room.respondProposal(b, true);
  check('W41 찬성 1표가 들어갔다', room.stateFor(a).round.proposal.agree === 1);

  room.leave(b);
  const p = room.stateFor(a).round;
  check('W41 나간 사람의 찬반 답도 함께 사라진다',
    !p.proposal || p.proposal.agree === 0,
    p.proposal ? `찬성 ${p.proposal.agree} / 인원 ${p.proposal.total}` : '이미 정리됨');
}

function w42_duplicateNicknames() {
  // [M2] 같은 닉네임이면 투표 후보가 "철수, 철수"로 떠서 구분이 안 됐다.
  const { room } = makeRoom(['철수', '철수', '철수'], 0);
  const names = room.stateFor('x').players.map((p) => p.nickname);
  check('W42 [M2] 겹치는 닉네임에는 번호가 붙는다',
    names.join(',') === '철수,철수(2),철수(3)', names.join(','));
  check('W42 [M2] 모두 서로 다르다', new Set(names).size === names.length);
}

function w43_nicknameEdgeCases() {
  const room = createRoom({ setTimer, clearTimer, now });
  const emoji = room.join({ nickname: '🎉'.repeat(30) });
  const shown = room.stateFor(emoji.playerId).players[0].nickname;
  check('W43 [L3] 이모지 닉네임이 중간에서 깨지지 않는다',
    Array.from(shown).length === 24 && !shown.includes('\uFFFD'),
    `글자 수 ${Array.from(shown).length}`);

  const blank = room.join({ nickname: '   ' });
  check('W43 빈 닉네임은 기본 이름으로 들어간다',
    room.stateFor(blank.playerId).players[1].nickname === '참가자',
    room.stateFor(blank.playerId).players[1].nickname);
}

function w44_systemLinesSurviveFlooding() {
  // [M4] 한 사람이 도배하면 "누가 지목됐는지" 같은 안내까지 밀려났다.
  const { room, players } = makeRoom(['A', 'B', 'C'], 1);
  room.start();
  const [a, b, c] = idsOf(players);
  passProposal(room, [a, b, c]);
  room.vote(a, b); room.vote(c, b); room.vote(b, a);
  room.guess(b, '틀린답'); // 결과까지 낸다

  for (let i = 0; i < 200; i += 1) room.say(a, `도배 ${i}`);
  const chat = room.stateFor(a).chat;
  check('W44 대화 상한은 그대로 지켜진다', chat.length <= 100, String(chat.length));
  check('W44 [M4] 도배해도 결과 안내는 남는다',
    chat.some((m) => m.code === 'result'), chat.filter((m) => m.kind === 'system').length + '개 안내 남음');
  check('W44 [M4] 지목 안내도 남는다', chat.some((m) => m.code === 'accused'));
}

function w45_wordListIsValidated() {
  // [H4] 목록이 깨지면 조용히 이상하게 굴러갔다. 이제는 불러올 때 크게 실패한다.
  const { validateWordList } = require('../web/room');
  const cases = [
    ['빈 목록', []],
    ['배열이 아님', ['사과']],
    ['카테고리 없음', [[null, '사과']]],
    ['제시어 빈 문자열', [['과일', '']]],
    ['칸 수가 다름', [['과일', '사과', '여분']]],
  ];
  let caught = 0;
  for (const [, list] of cases) {
    try { validateWordList(list); } catch { caught += 1; }
  }
  check('W45 [H4] 깨진 제시어 목록은 전부 걸러진다', caught === cases.length, `${caught}/${cases.length}`);
  check('W45 [H4] 실제로 쓰는 목록은 통과한다',
    (() => { try { validateWordList(require('../web/words')); return true; } catch (e) { return e.message; } })() === true);
}

console.log('웹 규칙 테스트');
for (const fn of [w1_minimumPlayers, w2_liarNeverSeesWord, w3_everyoneSeesSameResult, w4_liarGuessFlow,
  w5_guessTimeout, w6_voteTimeoutAndTie, w7_disconnectDoesNotBlockVote, w8_reconnectKeepsSeat,
  w9_lateJoinerSpectates, w10_chatLock,
  w11_proposalMajority, w12_proposalRejected, w13_proposalTimeout, w14_twoPlayers, w15_tokenSeatCollision,
  w16_emptyRoundIsAbandoned, w17_emptyProposalDoesNotPass, w18_spectatorCannotChat,
  w19_oneTurnPerPerson, w20_freeChatAfterEveryoneSpoke, w21_voteOnlyAfterExplanations,
  w22_turnTimeoutMovesOn, w23_disconnectedSpeakerSkipped, w24_rejectedProposalReturnsToFree,
  w25_stateExposesTurnProgress, w26_leaveIsImmediate, w27_roundEndsWhenTooFewRemain,
  w28_disconnectGraceIsTenSeconds, w29_cannotVoteForSomeoneWhoLeft,
  w30_leavingSpeakerPassesTurn, w31_leaveThenRejoinIsANewSeat,
  w32_rejoinAfterGraceKeepsSeat, w33_leavingGivesUpTheSeat, w34_liarLeavingCancelsRound,
  w35_liarDisconnectGetsTheSameGrace, w36_twoPlayerRoundIsNotCancelled,
  w37_twoSpeakRounds, w38_secondRoundStillOnePerPerson,
  w39_departedVotesAreDropped, w40_votesForDepartedAreDropped, w41_departedProposalAnswerIsDropped,
  w42_duplicateNicknames, w43_nicknameEdgeCases, w44_systemLinesSurviveFlooding,
  w45_wordListIsValidated,
  w46_lastLeaverResetsTheRoom, w47_emptyRoomResetsAfterDisconnectGrace,
  w48_newGroupStartsClean,
  w49_roomCapacity, w50_capacityDoesNotBlockReconnect,
  w51_noBackToBackSpeaker, w52_noBackToBackWithTwoPlayers,
  w53_freeChatIsAsked, w54_freeChatAgreedOpensFreeChat, w55_freeAskTimeoutSkips,
  w56_voteProposalStillWorks]) {
  try { fn(); } catch (err) { check(`${fn.name} 실행 중 예외`, false, err.message); }
}


// ── 마지막 사람이 나가면 방이 비워지는가 ────────────────────────────────

function w46_lastLeaverResetsTheRoom() {
  // [이슈] "모든 인원이 다 나가도 방이 안 터진다"
  //   판이 끝나면 phase가 'result'가 되는데, abandonRoundIfAlone()은 'result'를
  //   건너뛴다. 그래서 그 뒤에 전원이 나가도 방이 남의 판 결과를 그대로 안고 남았다.
  //   다음에 들어온 사람은 한 번도 하지 않은 판의 결과 화면을 보게 된다 -
  //   제시어와 누가 라이어였는지까지 그대로.
  const { room, players } = makeRoom(['A', 'B', 'C'], 0);
  room.start();
  const [a, b, c] = idsOf(players);

  room.leave(a); // 라이어가 나간다 → 시민 승, phase='result'
  check('W46 라이어가 나가 판이 결과로 끝났다', room._debug().phase === 'result');

  room.leave(b);
  room.leave(c);

  const s = room.stateFor('아무도아님');
  check('W46 [이슈] 전원이 나가면 방이 로비로 돌아온다', s.phase === 'lobby', s.phase);
  check('W46 앞 판의 결과가 남지 않는다', s.result === null,
    s.result ? JSON.stringify(s.result) : '없음');
  check('W46 앞 사람들의 대화가 남지 않는다', s.chat.length === 0, `${s.chat.length}줄`);
  check('W46 앞 사람들의 전적이 남지 않는다', s.record.rounds === 0, JSON.stringify(s.record));
}

function w47_emptyRoomResetsAfterDisconnectGrace() {
  // 스스로 나가지 않고 전원이 튕긴 경우도 같다. 10초 유예가 지나 목록에서
  // 사라지는 순간이 "아무도 없는 방"이 되는 시점이다.
  const { room, players } = makeRoom(['A', 'B'], 0);
  room.start();
  const [a, b] = idsOf(players);

  room.disconnect(a);
  room.disconnect(b);
  check('W47 유예 중에는 아직 비우지 않는다', room.playerIds().length === 2);

  advance(room.DROP_MS + 1000);
  const s = room.stateFor('아무도아님');
  check('W47 유예가 지나 전원이 사라지면 방이 비워진다',
    s.phase === 'lobby' && s.chat.length === 0 && s.record.rounds === 0,
    `phase=${s.phase} chat=${s.chat.length} 전적=${s.record.rounds}`);
}

function w48_newGroupStartsClean() {
  // 방이 비워진 뒤 새로 들어온 사람들이 곧바로, 깨끗한 상태에서 시작할 수 있어야 한다.
  const { room, players } = makeRoom(['A', 'B', 'C'], 0);
  room.start();
  for (const id of idsOf(players)) room.leave(id);

  const x = room.join({ nickname: '새사람1' }).playerId;
  room.join({ nickname: '새사람2' });
  const before = room.stateFor(x);
  check('W48 새로 들어온 사람은 빈 방을 본다',
    before.phase === 'lobby' && before.chat.length === 0 && before.result === null);
  check('W48 곧바로 시작할 수 있다', before.canStart === true);

  const reason = room.start();
  check('W48 새 판이 정상적으로 시작된다', !reason && room._debug().phase === 'turn', reason || '');
}


// ── 요청: 최대 인원 / 연속 설명 금지 / 자유 대화 O-X ─────────────────────

function w49_roomCapacity() {
  const { room } = makeRoom(['A'], 0);
  const joined = [];
  for (let i = 2; i <= room.MAX_PLAYERS; i += 1) joined.push(room.join({ nickname: `참가자${i}` }));
  check('W49 [요청] 정원은 8명이다', room.MAX_PLAYERS === 8, String(room.MAX_PLAYERS));
  check('W49 8명까지는 다 들어온다',
    room.playerIds().length === 8 && joined.every((j) => !j.error), String(room.playerIds().length));

  const overflow = room.join({ nickname: '아홉번째' });
  check('W49 9번째는 사유와 함께 막힌다',
    !!overflow.error && overflow.error.includes('8'), overflow.error || '들어와버림');
  check('W49 막힌 사람은 목록에 남지 않는다', room.playerIds().length === 8);
  check('W49 정원은 화면에도 내려간다', room.stateFor(room.playerIds()[0]).maxPlayers === 8);
}

function w50_capacityDoesNotBlockReconnect() {
  // 정원을 새 참가자에게만 걸어야 한다. 돌아오는 사람까지 막으면 방이 꽉 찬 상태에서
  // 잠깐 튕긴 사람이 자기 자리를 영영 잃는다.
  const { room, players } = makeRoom(['A'], 0);
  for (let i = 2; i <= 8; i += 1) room.join({ nickname: `참가자${i}` });
  check('W50 방이 가득 찼다', room.playerIds().length === 8);

  const me = players[0];
  room.disconnect(me.playerId); // 자리는 남아 있다(10초 유예)
  const back = room.join({ nickname: 'A', token: me.token });
  check('W50 가득 찬 방에서도 원래 있던 사람은 돌아올 수 있다',
    !back.error && back.restored === true && back.playerId === me.playerId,
    back.error || `restored=${back.restored}`);
}

function w51_noBackToBackSpeaker() {
  // [요청] 같은 사람이 두 번 연속으로 설명하지 않게. 1차의 마지막과 2차의 첫 번째가
  // 겹치는 자리에서만 생긴다. 순서가 매번 섞이므로 여러 판을 돌려서 확인한다.
  let collisions = 0;
  const rounds = 40;
  for (let n = 0; n < rounds; n += 1) {
    const room = createRoom({ setTimer, clearTimer, now, random: Math.random });
    const ids = ['A', 'B', 'C', 'D'].map((x) => room.join({ nickname: x }).playerId);
    room.start();
    const first = room._debug().round.speakOrder.slice();
    first.forEach((id) => room.say(id, '1차'));
    const second = room._debug().round.speakOrder.slice();
    if (first[first.length - 1] === second[0]) collisions += 1;
    void ids;
  }
  check('W51 [요청] 1차의 마지막이 2차의 첫 번째로 이어지지 않는다',
    collisions === 0, `${rounds}판 중 ${collisions}판에서 연속`);
}

function w52_noBackToBackWithTwoPlayers() {
  // 2명이면 순서가 [A,B] 둘뿐이라 가장 빡빡하다. 그래도 언제나 만족할 수 있어야 한다.
  for (let n = 0; n < 20; n += 1) {
    const room = createRoom({ setTimer, clearTimer, now, random: Math.random });
    const ids = ['A', 'B'].map((x) => room.join({ nickname: x }).playerId);
    room.start();
    const first = room._debug().round.speakOrder.slice();
    first.forEach((id) => room.say(id, '1차'));
    const second = room._debug().round.speakOrder.slice();
    if (first[1] === second[0] || new Set(second).size !== 2) {
      check('W52 2명일 때도 연속으로 걸리지 않는다', false, `1차 ${first} / 2차 ${second}`);
      void ids;
      return;
    }
  }
  check('W52 2명일 때도 연속으로 걸리지 않는다 (20판)', true);
}

function w53_freeChatIsAsked() {
  // [요청] 설명 → 자유 대화 O/X → (찬성) 자유 대화 / (부결) 바로 투표
  const { room, players } = makeRoom(['A', 'B', 'C', 'D'], 0);
  room.start();
  const ids = idsOf(players);
  for (let g = 0; g < 200 && room._debug().phase === 'turn'; g += 1) {
    const d = room._debug();
    room.say(d.round.speakOrder[d.round.speakIndex], '설명');
  }

  const s = room.stateFor(ids[0]);
  check('W53 설명이 끝나면 자유 대화 O/X를 묻는다', s.phase === 'proposal', s.phase);
  check('W53 무엇을 묻는 O/X인지 구분된다', s.round.proposal.kind === 'free', s.round.proposal.kind);
  check('W53 O/X 중에는 대화가 막힌다',
    typeof room.say(ids[0], '한마디') === 'string');

  for (const id of ids) room.respondProposal(id, false); // 전원 반대
  check('W53 [요청] 부결되면 자유 대화를 건너뛰고 바로 투표로 간다',
    room._debug().phase === 'voting', room._debug().phase);
  check('W53 건너뛴 것이 대화에 남는다',
    room.stateFor(ids[0]).chat.some((m) => m.code === 'freeSkipped'));
  check('W53 건너뛰었으면 "자유 대화 시간이 끝났다"고 하지 않는다',
    !room.stateFor(ids[0]).chat.some((m) => m.code === 'votingStarted' && m.text.includes('시간이 끝났')),
    room.stateFor(ids[0]).chat.filter((m) => m.code === 'votingStarted').map((m) => m.text).join(''));
}

function w54_freeChatAgreedOpensFreeChat() {
  const { room, players } = makeRoom(['A', 'B', 'C', 'D'], 0);
  room.start();
  const ids = idsOf(players);
  for (let g = 0; g < 200 && room._debug().phase === 'turn'; g += 1) {
    const d = room._debug();
    room.say(d.round.speakOrder[d.round.speakIndex], '설명');
  }
  for (const id of ids) room.respondProposal(id, true);
  check('W54 [요청] 찬성하면 자유 대화가 열린다', room._debug().phase === 'free', room._debug().phase);
  check('W54 자유 대화에서는 말할 수 있다', room.say(ids[1], '이야기') === null);
  check('W54 자유 대화 O/X는 정리된다', room.stateFor(ids[0]).round.proposal === null);
}

function w55_freeAskTimeoutSkips() {
  // 아무도 답하지 않으면(전원 자리 비움) 자유 대화를 열어 둘 이유가 없다. 바로 투표로 간다.
  const { room, players } = makeRoom(['A', 'B', 'C'], 0);
  room.start();
  for (let g = 0; g < 200 && room._debug().phase === 'turn'; g += 1) {
    const d = room._debug();
    room.say(d.round.speakOrder[d.round.speakIndex], '설명');
  }
  check('W55 자유 대화 O/X가 떠 있다', room._debug().phase === 'proposal');
  advance(room.PROPOSAL_MS + 1000);
  check('W55 아무도 답하지 않으면 제한 시간 뒤 투표로 넘어간다',
    room._debug().phase === 'voting', room._debug().phase);
  void players;
}

function w56_voteProposalStillWorks() {
  // 자유 대화 O/X를 넣으면서 기존 투표 제안 O/X가 망가지지 않아야 한다.
  const { room, players } = makeRoom(['A', 'B', 'C', 'D'], 0);
  room.start();
  const ids = idsOf(players);
  passTurns(room); // 자유 대화까지 연다
  check('W56 자유 대화 중이다', room._debug().phase === 'free');

  room.callVote(ids[0]);
  const s = room.stateFor(ids[0]);
  check('W56 투표 제안 O/X는 kind가 다르다', s.round.proposal.kind === 'vote', s.round.proposal.kind);
  check('W56 누가 제안했는지도 그대로다', s.round.proposal.byName === 'A', s.round.proposal.byName);

  for (const id of ids) room.respondProposal(id, false);
  check('W56 투표 제안이 부결되면 자유 대화로 돌아간다',
    room._debug().phase === 'free', room._debug().phase);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n웹 규칙: ${results.length - failed}/${results.length} 통과`);
process.exit(failed === 0 ? 0 : 1);

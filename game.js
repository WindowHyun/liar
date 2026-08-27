'use strict';

/**
 * 규칙 v0.4 - 정족수 불일치 버그 수정:
 * 예전에는 투표 정족수·지목자 이름을 "그 순간 내가 아는 온라인 인원"으로 각자 따로
 * 계산했다. 그런데 막 들어온 사람은 하트비트가 아직 안 돌아서 서로를 늦게 알게 되고,
 * 그 틈에 게임이 시작되거나 투표가 열리면 사람마다 "총 인원"이 달라져서
 * (1) 새로 들어온 사람이 게임 시작 시 역할을 못 받고, (2) 투표가 어느 쪽에서는 끝나고
 * 어느 쪽에서는 안 끝나고, (3) 지목된 사람 본인이 스스로를 지목된 걸로 계산 못 해서
 * 공개(REVEAL)를 안 보내는 문제가 있었다 (실제 2-프로세스 재현으로 확인됨).
 *
 * 고친 방식: 게임을 시작하는 사람이 "이번 라운드 참가자 명단(roster)"을 START 메시지에
 * 실어서 보낸다. 이후 이번 라운드의 정족수·이름 조회는 전부 이 고정된 명단
 * (roundParticipants) 기준으로만 한다 - 각자 다시 계산하지 않으므로 위 불일치가
 * 구조적으로 없어진다.
 */

const net = require('./network');

const WORD_LIST = [
  ['과일', '사과'], ['과일', '바나나'], ['동물', '기린'], ['음식', '김치찌개'], ['장소', '도서관'],
];

const VOTE_DURATION_MS = 30000;
const PARTICIPANT_REFRESH_MS = 3000;

let nickname = null;
let onStateChange = () => {};

let myIsLiar = false;
let myWord = null; // 라이어면 null

let votingOpen = false;
const votes = new Map(); // voterId -> targetId
let voteTimeoutHandle = null;

let roundActive = false; // [이슈2] 게임이 시작된 상태에서만 true - 투표 가능 여부의 기준
let roundParticipants = new Map(); // id -> nickname, 이번 라운드로 고정된 명단

function setStateHandler(fn) { onStateChange = fn; }

/** 라운드를 확정 짓는 유일한 통로. 여기서 한 번에 roundActive를 내려서, result를 어디서
 *  내보내든(동점/미투표/오답지목/역전찬스 등) 빠짐없이 "게임 진행 중" 상태가 꺼지게 한다. */
function finishRound(payload) {
  roundActive = false;
  onStateChange({ type: 'result', ...payload });
}

/** 로비(게임 시작 전) 화면에 보여줄, 지금 온라인인 사람 목록 - 매번 새로 계산한다. */
function currentParticipants() {
  const map = new Map();
  map.set(net.MY_ID, nickname);
  for (const p of net.getOnlinePeers()) map.set(p.id, p.nickname);
  return map;
}

function participantList() {
  return [...currentParticipants()].map(([id, nickname]) => ({ id, nickname }));
}

function pushParticipants() {
  onStateChange({ type: 'participants', list: participantList() });
}

function join(myNickname) {
  nickname = myNickname;
  net.setDiagnosticsHandler((d) => onStateChange({ type: 'networkIssue', detail: d }));
  net.startPresence(nickname);
  net.startReceiver(handleMessage);
  net.sendBroadcast({ type: 'JOIN', id: net.MY_ID, nickname });
  pushParticipants();
  setInterval(pushParticipants, PARTICIPANT_REFRESH_MS);
}

/** [수정 1] 시작 버튼을 누른 사람이 이번 라운드의 임시 호스트가 되어 라이어와 제시어를
 *  정하고, 참가자별로 유니캐스트(1:1 전송)로 나눠준다. 이번 라운드 참가자 명단(roster)을
 *  START 메시지에 실어 보내서, 다들 "누가 몇 명인지"를 이 명단 하나로 통일한다. */
function startGame() {
  const everyone = [...currentParticipants()].map(([id, nickname]) => ({
    id, nickname, ip: id === net.MY_ID ? null : net.getOnlinePeers().find((p) => p.id === id)?.ip,
  }));
  const liar = everyone[Math.floor(Math.random() * everyone.length)];
  const [category, word] = WORD_LIST[Math.floor(Math.random() * WORD_LIST.length)];

  clearVoteTimeout();
  votingOpen = false;
  votes.clear();
  roundActive = true;

  const roster = everyone.map(({ id, nickname }) => ({ id, nickname }));
  roundParticipants = new Map(roster.map((p) => [p.id, p.nickname]));

  // [수정 4] START에도 보낸 사람 id를 실어서, 호스트 자신에게 되돌아온 루프백이
  // 필터링되게 한다 (예전엔 id가 없어서 "게임이 시작되었습니다"가 두 번 떴다).
  net.sendBroadcast({ type: 'START', id: net.MY_ID, roster });
  onStateChange({ type: 'roundStart', participants: roster });

  for (const p of everyone) {
    const isLiar = p.id === liar.id;
    if (p.id === net.MY_ID) {
      applyWord(category, isLiar ? null : word, isLiar);
    } else {
      net.sendUnicast({ type: 'WORD', category, word: isLiar ? null : word, isLiar }, p.ip);
    }
  }
}

function applyWord(category, word, isLiar) {
  myIsLiar = isLiar;
  myWord = word;
  onStateChange({ type: 'word', category, word, isLiar });
}

/** [수정 6] 투표 후 채팅 제한을 화면(UI)뿐 아니라 게임 로직에서도 막는다.
 *  화면 잠금은 우회할 수 있어도(예: 개발자 도구로 직접 메시지 전송), 여기서 막으면
 *  실제로 전송 자체가 안 나간다. */
function sendDescription(text) {
  if (votingOpen) return;
  net.sendBroadcast({ type: 'DESC', id: net.MY_ID, nickname, text });
  onStateChange({ type: 'description', id: net.MY_ID, name: nickname, text });
}

function clearVoteTimeout() {
  if (voteTimeoutHandle) {
    clearTimeout(voteTimeoutHandle);
    voteTimeoutHandle = null;
  }
}

function armVoteTimeout() {
  clearVoteTimeout();
  voteTimeoutHandle = setTimeout(() => tryResolveVote(true), VOTE_DURATION_MS);
}

function callVote() {
  if (!roundActive || votingOpen) return; // [이슈2] 게임 시작 전이거나 이미 투표 중이면 무시
  votingOpen = true;
  votes.clear();
  net.sendBroadcast({ type: 'CALL_VOTE', id: net.MY_ID });
  onStateChange({ type: 'voteStart', by: net.MY_ID, durationMs: VOTE_DURATION_MS });
  armVoteTimeout();
}

function sendVote(targetId) {
  net.sendBroadcast({ type: 'VOTE', voterId: net.MY_ID, targetId });
  registerVote(net.MY_ID, targetId);
}

function submitGuess(word) {
  net.sendBroadcast({ type: 'GUESS', id: net.MY_ID, word });
}

function registerVote(voterId, targetId) {
  if (!votingOpen) return;
  if (!roundParticipants.has(voterId)) return; // 이번 라운드 참가자가 아니면 표를 세지 않는다
  votes.set(voterId, targetId);
  onStateChange({ type: 'vote', voterId, targetId });
  tryResolveVote(false);
}

/** [수정 1/2/3의 핵심] 정족수와 이름 조회를 전부 roundParticipants(고정 명단) 기준으로
 *  한다. 그때그때 다시 계산하는 currentParticipants()를 쓰지 않으므로, 사람마다 다른
 *  인원수로 판단해서 어긋나는 일이 없다. force=true면 [수정] 투표 제한 시간이 다 되어
 *  미투표자가 있어도 강제로 집계한다. */
function tryResolveVote(force) {
  if (!votingOpen) return; // 타임아웃이 늦게 발동했는데 이미 다른 경로로 끝난 경우 방지
  if (!force && votes.size < roundParticipants.size) return;

  clearVoteTimeout();
  votingOpen = false;

  if (votes.size === 0) {
    finishRound({ winner: 'liar', reason: 'noVotes' });
    return;
  }

  const counts = new Map();
  for (const targetId of votes.values()) counts.set(targetId, (counts.get(targetId) || 0) + 1);

  let top = [];
  let max = 0;
  for (const [id, count] of counts) {
    if (count > max) { max = count; top = [id]; }
    else if (count === max) { top.push(id); }
  }

  if (top.length !== 1) {
    finishRound({ winner: 'liar', reason: 'tie' });
    return;
  }

  const accusedId = top[0];
  onStateChange({ type: 'accused', id: accusedId, name: roundParticipants.get(accusedId) });

  // 지목된 사람이 실제 라이어인지는 본인만 알 수 있으므로, 본인이 직접 공개한다.
  if (accusedId === net.MY_ID) {
    net.sendBroadcast({ type: 'REVEAL', id: net.MY_ID, isLiar: myIsLiar });
    if (myIsLiar) onStateChange({ type: 'awaitGuess', accusedId: net.MY_ID });
    else finishRound({ winner: 'liar', reason: 'wrongAccusation' });
  }
}

function handleMessage(msg) {
  if (msg.id === net.MY_ID || msg.voterId === net.MY_ID) return; // 루프백으로 돌아온 내 메시지는 이미 로컬에서 처리했으므로 무시

  switch (msg.type) {
    case 'JOIN':
      pushParticipants();
      break;
    case 'HELLO':
      // [이슈1] 새로 들어온 사람의 JOIN에 대한 즉시 응답(HELLO)이 이걸로 오는데, 이걸
      // 반영하는 case가 없으면 network.js 내부 등록만 되고 화면(참가자 목록)은 다음
      // 정기 갱신(최대 3초)까지 그대로였다. 매 HELLO마다 밀어줘서 그 지연을 없앤다.
      pushParticipants();
      break;
    case 'START':
      clearVoteTimeout();
      votingOpen = false;
      votes.clear();
      roundActive = true;
      roundParticipants = new Map((msg.roster || []).map((p) => [p.id, p.nickname]));
      onStateChange({ type: 'roundStart', participants: msg.roster || [] });
      break;
    case 'WORD':
      applyWord(msg.category, msg.word, msg.isLiar);
      break;
    case 'DESC':
      onStateChange({ type: 'description', id: msg.id, name: msg.nickname, text: msg.text });
      break;
    case 'CALL_VOTE':
      votingOpen = true;
      votes.clear();
      onStateChange({ type: 'voteStart', by: msg.id, durationMs: VOTE_DURATION_MS });
      armVoteTimeout();
      break;
    case 'VOTE':
      registerVote(msg.voterId, msg.targetId);
      break;
    case 'REVEAL':
      if (msg.isLiar) onStateChange({ type: 'awaitGuess', accusedId: msg.id });
      else finishRound({ winner: 'liar', reason: 'wrongAccusation' });
      break;
    case 'GUESS': {
      // 라이어 본인은 정답을 모르므로 스스로 판정할 수 없다. 실제 제시어를 아는 참가자(나)가
      // 판정해서 결과를 브로드캐스트하면, 라이어를 포함한 모두가 결과를 받는다.
      if (myWord === null) return;
      const winner = msg.word.trim() === myWord ? 'liar' : 'citizens';
      // [수정 4와 같은 이유] id를 실어 자기 루프백은 걸러지므로, 내 화면 몫은 직접 반영한다.
      net.sendBroadcast({ type: 'RESULT', id: net.MY_ID, winner, reason: 'guess', guess: msg.word });
      finishRound({ winner, reason: 'guess', guess: msg.word });
      break;
    }
    case 'RESULT':
      finishRound({ winner: msg.winner, reason: msg.reason, guess: msg.guess });
      break;
  }
}

module.exports = { join, startGame, sendDescription, callVote, sendVote, submitGuess, setStateHandler };

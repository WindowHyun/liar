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
 *
 * ── 규칙 v0.5 - 결과 확정 권위 도입 [P0-2] ──────────────────────────────────
 * v0.4는 "분모(총 인원)"를 통일했지만 "분자(내가 실제로 받은 표)"는 여전히 각자 달랐다.
 * 표 하나가 유실되면 A는 정족수를 채워 즉시 "X 지목"을 띄우고, B는 30초 타임아웃 뒤
 * 표 하나가 빈 채로 집계해 "동점, 라이어 승"을 띄운다. 게다가 tie/noVotes 결과는
 * 브로드캐스트조차 되지 않아서, 각 PC가 서로 다른 결론을 낸 채 끝났다.
 *
 * 고친 방식: 게임을 시작한 사람이 이번 라운드의 "호스트"가 되고,
 *   - 표 집계, 지목자 결정, 정답 판정, 결과 확정을 전부 호스트만 한다.
 *   - 나머지 PC는 계산하지 않고 호스트가 보낸 ACCUSED / RESULT를 그대로 표시만 한다.
 * 이렇게 하면 누가 어떤 패킷을 받았든 결론은 하나뿐이다.
 *
 * 라운드마다 roundId를 붙여, 이전 라운드나 취소된 라운드에서 뒤늦게 도착한 패킷이
 * 지금 라운드에 섞이지 않게 한다.
 */

const net = require('./network');
const { log } = require('./logger');

const WORD_LIST = [
  ['과일', '사과'], ['과일', '바나나'], ['동물', '기린'], ['음식', '김치찌개'], ['장소', '도서관'],
];

const VOTE_DURATION_MS = 30000;
const PARTICIPANT_REFRESH_MS = 3000;
const WORD_WAIT_MS = 5000; // [P0-3] 라운드가 시작됐는데 이 시간 안에 제시어가 안 오면 사용자에게 알린다

let nickname = null;
let onStateChange = () => {};

let myIsLiar = false;
let myWord = null; // 라이어면 null
let myRoleReceived = false; // [P0-3] 이번 라운드 역할을 실제로 받았는지
let wordWaitHandle = null;
let pendingWord = null; // START보다 WORD가 먼저 도착한 경우를 위한 보관함

let votingOpen = false;
let voteClosed = false; // 이번 라운드의 투표가 이미 집계까지 끝났는지
const votes = new Map(); // voterId -> targetId
let voteTimeoutHandle = null;

let roundActive = false; // [이슈2] 게임이 시작된 상태에서만 true - 투표 가능 여부의 기준
let roundParticipants = new Map(); // id -> nickname, 이번 라운드로 고정된 명단
let roundId = null;      // [P0-2] 이번 라운드 식별자. 지난 라운드의 늦은 패킷을 걸러낸다
let roundHostId = null;  // [P0-2] 이번 라운드의 결과를 확정할 사람

/** 이번 라운드의 정답. 호스트만 들고 있고 절대 화면(onStateChange)으로 내보내지 않는다.
 *  호스트가 라이어로 뽑혀도 정답 판정은 해야 하므로 myWord와 별도로 보관한다.
 *  (주의: 시작 버튼을 누른 사람은 자기 PC에서 라이어와 제시어를 직접 뽑으므로 원래부터
 *   답을 알고 있다. 이건 이 구조의 알려진 한계이고, 없애려면 중립 딜러나 커밋-공개
 *   방식이 필요하다 - 이번 수정 범위 밖.) */
let hostWord = null;

function setStateHandler(fn) { onStateChange = fn; }

function isHost() { return roundActive && roundHostId === net.MY_ID; }

/** 지난 라운드나 취소된 라운드에서 늦게 도착한 패킷을 걸러낸다. */
function isCurrentRound(msg) { return roundActive && !!roundId && msg.roundId === roundId; }

/** 라운드를 확정 짓는 유일한 통로. 여기서 한 번에 roundActive를 내려서, result를 어디서
 *  내보내든(동점/미투표/오답지목/역전찬스 등) 빠짐없이 "게임 진행 중" 상태가 꺼지게 한다. */
function finishRound(payload) {
  if (!roundActive) return; // 같은 결과가 두 번 확정되지 않게 한다
  roundActive = false;
  votingOpen = false;
  roundId = null;
  roundHostId = null;
  hostWord = null;
  clearVoteTimeout();
  clearWordWait();
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

/** [P0-2] 결과를 확정할 사람이 사라지면 그 라운드는 아무도 끝낼 수 없다. 호스트가
 *  하트비트 기준으로 오프라인이 되면 라운드를 취소해서 로비로 돌려보낸다. */
function checkHostAlive() {
  if (!roundActive || !roundHostId || roundHostId === net.MY_ID) return;
  if (net.getOnlinePeers().some((p) => p.id === roundHostId)) return;
  log(`[라운드 취소] 호스트(${roundHostId})가 오프라인으로 판정되어 라운드를 종료합니다.`);
  finishRound({ winner: 'none', reason: 'hostLeft' });
}

function join(myNickname) {
  nickname = myNickname;
  net.setDiagnosticsHandler((d) => onStateChange({ type: 'networkIssue', detail: d }));
  net.startPresence(nickname);
  net.startReceiver(handleMessage);
  net.sendBroadcast({ type: 'JOIN', id: net.MY_ID, nickname, version: net.PROTOCOL_VERSION });
  pushParticipants();
  setInterval(() => { pushParticipants(); checkHostAlive(); }, PARTICIPANT_REFRESH_MS);
}

/** 이번 라운드 상태를 통째로 갈아끼우는 유일한 통로.
 *  [P0-3] 여기서 역할·제시어를 반드시 초기화한다. 예전에는 초기화하지 않아서, WORD가
 *  유실되면 지난 라운드의 역할과 제시어를 그대로 들고 다음 라운드를 진행했다. */
function beginRound({ id, hostId, roster }) {
  clearVoteTimeout();
  clearWordWait();
  votingOpen = false;
  votes.clear();

  voteClosed = false;
  roundActive = true;
  roundId = id;
  roundHostId = hostId;
  roundParticipants = new Map(roster.map((p) => [p.id, p.nickname]));

  myIsLiar = false;
  myWord = null;
  myRoleReceived = false;
  hostWord = null;

  onStateChange({ type: 'roundStart', participants: roster, hostId });
  onStateChange({ type: 'rolePending' }); // 지난 라운드 역할 카드를 화면에서 지우게 한다

  // START보다 WORD가 먼저 도착했다면 여기서 적용한다 (브로드캐스트와 유니캐스트는
  // 서로 다른 소켓이라 도착 순서가 보장되지 않는다).
  if (pendingWord && pendingWord.roundId === id) {
    const w = pendingWord;
    pendingWord = null;
    applyWord(w.category, w.word, w.isLiar);
  } else {
    pendingWord = null;
  }

  if (!myRoleReceived && hostId !== net.MY_ID) armWordWait(id);
}

/** [수정 1] 시작 버튼을 누른 사람이 이번 라운드의 임시 호스트가 되어 라이어와 제시어를
 *  정하고, 참가자별로 유니캐스트(1:1 전송)로 나눠준다. 이번 라운드 참가자 명단(roster)을
 *  START 메시지에 실어 보내서, 다들 "누가 몇 명인지"를 이 명단 하나로 통일한다. */
function startGame() {
  // [P0-2 전제] 라운드가 이미 돌고 있으면 새로 시작하지 않는다. 호스트가 둘이 되면
  // 결과 확정 권위가 갈라져서 이 수정 자체가 무의미해진다.
  if (roundActive) return;

  const online = net.getOnlinePeers();
  const everyone = [...currentParticipants()].map(([id, nickname]) => ({
    id, nickname, ip: id === net.MY_ID ? null : online.find((p) => p.id === id)?.ip,
  }));
  const liar = everyone[Math.floor(Math.random() * everyone.length)];
  const [category, word] = WORD_LIST[Math.floor(Math.random() * WORD_LIST.length)];

  const id = `${net.MY_ID}-${Date.now()}`;
  const roster = everyone.map(({ id, nickname }) => ({ id, nickname }));

  beginRound({ id, hostId: net.MY_ID, roster });
  hostWord = word; // beginRound가 지운 뒤에 호스트 몫만 다시 채운다

  // [수정 4] START에도 보낸 사람 id를 실어서, 호스트 자신에게 되돌아온 루프백이
  // 필터링되게 한다 (예전엔 id가 없어서 "게임이 시작되었습니다"가 두 번 떴다).
  net.sendBroadcastReliable({ type: 'START', id: net.MY_ID, roundId: id, roster });

  for (const p of everyone) {
    const isLiar = p.id === liar.id;
    if (p.id === net.MY_ID) {
      applyWord(category, isLiar ? null : word, isLiar);
      continue;
    }
    // [P1-11] to를 실어 보낸다. WORD에는 보낸 사람 id가 없어서 루프백 필터에 안 걸리는데,
    // 목적지 IP가 비어 유니캐스트가 127.0.0.1로 새면 남의 역할이 내 역할을 덮어썼다.
    // 받는 쪽에서 to가 자기가 아니면 버리므로 이제 그런 일이 없다.
    net.sendUnicastReliable(
      { type: 'WORD', roundId: id, to: p.id, category, word: isLiar ? null : word, isLiar },
      p.ip,
      (why) => {
        if (roundId !== id) return; // 이미 끝나거나 교체된 라운드의 실패는 알리지 않는다
        log(`[제시어 전달 실패] ${p.nickname}(${p.id}) - 사유: ${why}`);
        onStateChange({ type: 'wordDeliveryFailed', id: p.id, name: p.nickname, reason: why });
      },
    );
  }
}

function applyWord(category, word, isLiar) {
  myIsLiar = isLiar;
  myWord = word;
  myRoleReceived = true;
  clearWordWait();
  onStateChange({ type: 'word', category, word, isLiar });
}

function clearWordWait() {
  if (wordWaitHandle) {
    clearTimeout(wordWaitHandle);
    wordWaitHandle = null;
  }
}

/** [P0-3] 제시어가 끝내 안 오면 조용히 "제시어 없는 시민"으로 남지 않게, 본인 화면에 띄운다. */
function armWordWait(id) {
  clearWordWait();
  wordWaitHandle = setTimeout(() => {
    wordWaitHandle = null;
    if (roundId !== id || myRoleReceived) return;
    log('[제시어 미수신] 라운드가 시작됐는데 제시어를 받지 못했습니다.');
    onStateChange({ type: 'roleMissing' });
  }, WORD_WAIT_MS);
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

/** [P0-2] 제한 시간 집계 타이머는 호스트만 건다. 결과를 낼 사람이 호스트뿐이므로
 *  나머지 PC가 타이머를 돌 이유가 없다(각자 다른 시각에 다른 결론을 내던 원인). */
function armVoteTimeout() {
  clearVoteTimeout();
  const id = roundId;
  voteTimeoutHandle = setTimeout(() => {
    voteTimeoutHandle = null;
    if (roundId !== id) return;
    tryResolveVote(true);
  }, VOTE_DURATION_MS);
}

/** 투표를 여는 유일한 통로. callVote(내가 시작) / CALL_VOTE 수신 / [P1-8] 늦게 받은 VOTE가
 *  전부 여기로 들어온다. */
function openVoting(byId) {
  if (!roundActive || votingOpen || voteClosed) return;
  votingOpen = true;
  votes.clear();
  onStateChange({ type: 'voteStart', by: byId, durationMs: VOTE_DURATION_MS });
  if (isHost()) armVoteTimeout();
}

function callVote() {
  // [이슈2] 게임 시작 전이거나 이미 투표 중이면 무시. 한 라운드에 투표는 한 번뿐이므로
  // 집계가 끝난 뒤(공개·정답 단계)에는 다시 열지 않는다.
  if (!roundActive || votingOpen || voteClosed) return;
  net.sendBroadcastReliable({ type: 'CALL_VOTE', id: net.MY_ID, roundId });
  openVoting(net.MY_ID);
}

function sendVote(targetId) {
  if (!votingOpen) return;
  net.sendBroadcastReliable({ type: 'VOTE', voterId: net.MY_ID, roundId, targetId });
  registerVote(net.MY_ID, targetId);
}

function submitGuess(word) {
  // 내가 호스트면 내 GUESS는 루프백 필터에 걸려 되돌아오지 않으므로 여기서 바로 판정한다.
  if (isHost()) { judgeGuess(word); return; }
  net.sendBroadcastReliable({ type: 'GUESS', id: net.MY_ID, roundId, word });
}

function registerVote(voterId, targetId) {
  if (!roundActive) return;
  if (!roundParticipants.has(voterId)) return; // 이번 라운드 참가자가 아니면 표를 세지 않는다
  // [P1-8] CALL_VOTE를 놓쳐도 남의 표를 보고 따라 연다. 예전에는 여기서 그냥 return이라
  // CALL_VOTE 한 장을 놓친 사람만 이후 모든 표를 버리고 혼자 이전 화면에 멈춰 있었다.
  // 단, 이미 집계가 끝난 뒤에 뒤늦게 도착한 표까지 받아 주면 공개·정답 단계에서 투표가
  // 다시 열려 버리므로 그때는 무시한다.
  if (!votingOpen) {
    if (voteClosed) return;
    openVoting(voterId);
  }

  votes.set(voterId, targetId);
  onStateChange({ type: 'vote', voterId, targetId, voted: votes.size, total: roundParticipants.size });
  // [P0-2] 집계는 호스트만. 나머지는 진행 상황 표시용으로만 표를 모은다.
  if (isHost()) tryResolveVote(false);
}

/** [수정 1/2/3의 핵심] 정족수와 이름 조회를 전부 roundParticipants(고정 명단) 기준으로
 *  한다. 그때그때 다시 계산하는 currentParticipants()를 쓰지 않으므로, 사람마다 다른
 *  인원수로 판단해서 어긋나는 일이 없다. force=true면 투표 제한 시간이 다 되어
 *  미투표자가 있어도 강제로 집계한다.
 *  [P0-2] 이 함수는 호스트에서만 돈다. */
function tryResolveVote(force) {
  if (!isHost() || !votingOpen) return;
  if (!force && votes.size < roundParticipants.size) return;

  clearVoteTimeout();
  votingOpen = false;
  voteClosed = true;

  if (votes.size === 0) {
    announceResult({ winner: 'liar', reason: 'noVotes' });
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
    announceResult({ winner: 'liar', reason: 'tie' });
    return;
  }

  const accusedId = top[0];
  // [P0-2] 지목자는 호스트가 정해서 알린다. 예전에는 각 PC가 자기가 받은 표로 따로
  // 계산해서, 표 하나만 유실돼도 사람마다 다른 사람을 지목할 수 있었다.
  net.sendBroadcastReliable({ type: 'ACCUSED', id: net.MY_ID, roundId, accusedId });
  applyAccused(accusedId);
}

/** 호스트가 정한 지목 결과를 화면에 반영하고, 지목된 본인이면 정체를 공개한다. */
function applyAccused(accusedId) {
  votingOpen = false;
  voteClosed = true;
  clearVoteTimeout();
  onStateChange({ type: 'accused', id: accusedId, name: roundParticipants.get(accusedId) });

  // 지목된 사람이 실제 라이어인지는 본인만 알 수 있으므로, 본인이 직접 공개한다.
  if (accusedId !== net.MY_ID) return;
  net.sendBroadcastReliable({ type: 'REVEAL', id: net.MY_ID, roundId, isLiar: myIsLiar });
  if (myIsLiar) {
    onStateChange({ type: 'awaitGuess', accusedId: net.MY_ID });
  } else if (isHost()) {
    // 내가 호스트이면서 지목까지 당한 경우. 그 외에는 호스트가 내 REVEAL을 받고 확정한다.
    announceResult({ winner: 'liar', reason: 'wrongAccusation' });
  }
}

/** [P0-2] 결과는 호스트만 만든다. 브로드캐스트로 알리고 내 화면에도 같은 값을 반영한다. */
function announceResult(payload) {
  if (!isHost()) return;
  net.sendBroadcastReliable({ type: 'RESULT', id: net.MY_ID, roundId, ...payload });
  finishRound(payload);
}

/** [P1-7] 정답 판정도 호스트만 한다. 예전에는 제시어를 아는 시민 전원이 각자 판정하고
 *  각자 RESULT를 뿌려서, 5인 게임이면 RESULT가 8건씩 날아다녔다.
 *  호스트가 라이어로 뽑혔을 수도 있으므로 myWord가 아니라 hostWord로 판정한다. */
function judgeGuess(guess) {
  if (!isHost() || typeof guess !== 'string' || hostWord === null) return;
  const winner = guess.trim() === hostWord ? 'liar' : 'citizens';
  announceResult({ winner, reason: 'guess', guess });
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
    case 'START': {
      if (!msg.roundId || !Array.isArray(msg.roster)) break;
      if (roundId === msg.roundId) break; // 재전송분
      // 두 사람이 거의 동시에 시작 버튼을 누르면 START가 두 개 돈다. 이때 "호스트 id가
      // 작은 쪽"을 모두가 똑같이 채택한다. 도착 순서와 무관하게 같은 결론이 나오므로
      // 라운드가 두 개로 갈라지지 않는다.
      if (roundActive && roundHostId && msg.id > roundHostId) {
        log(`[동시 시작] ${msg.id}의 라운드를 무시하고 ${roundHostId}의 라운드를 유지합니다.`);
        break;
      }
      beginRound({ id: msg.roundId, hostId: msg.id, roster: msg.roster });
      break;
    }
    case 'WORD':
      // [P1-11] 나에게 온 제시어가 아니면 버린다.
      if (msg.to !== undefined && msg.to !== net.MY_ID) break;
      if (!isCurrentRound(msg)) {
        // START가 아직 안 왔을 수 있다. 보관해 뒀다가 그 라운드가 열리면 적용한다.
        if (msg.roundId) pendingWord = { roundId: msg.roundId, category: msg.category, word: msg.word, isLiar: msg.isLiar };
        break;
      }
      applyWord(msg.category, msg.word, msg.isLiar);
      break;
    case 'DESC':
      onStateChange({ type: 'description', id: msg.id, name: msg.nickname, text: msg.text });
      break;
    case 'CALL_VOTE':
      if (!isCurrentRound(msg)) break;
      openVoting(msg.id);
      break;
    case 'VOTE':
      if (!isCurrentRound(msg)) break;
      registerVote(msg.voterId, msg.targetId);
      break;
    case 'ACCUSED':
      if (!isCurrentRound(msg)) break;
      if (msg.id !== roundHostId) break; // 호스트가 아닌 사람이 보낸 지목은 신뢰하지 않는다
      applyAccused(msg.accusedId);
      break;
    case 'REVEAL':
      if (!isCurrentRound(msg)) break;
      if (msg.isLiar) {
        onStateChange({ type: 'awaitGuess', accusedId: msg.id });
      } else if (isHost()) {
        // [P0-2] 오답 지목의 결과 확정도 호스트가 한다. 각자 확정하면 REVEAL을 놓친
        // 사람만 결과를 못 보고 멈춘다.
        announceResult({ winner: 'liar', reason: 'wrongAccusation' });
      }
      break;
    case 'GUESS':
      if (!isCurrentRound(msg)) break;
      judgeGuess(msg.word); // 호스트가 아니면 내부에서 그냥 반환한다
      break;
    case 'RESULT':
      if (!isCurrentRound(msg)) break;
      if (msg.id !== roundHostId) break; // 호스트가 아닌 사람이 보낸 결과는 신뢰하지 않는다
      finishRound({ winner: msg.winner, reason: msg.reason, guess: msg.guess });
      break;
  }
}

module.exports = { join, startGame, sendDescription, callVote, sendVote, submitGuess, setStateHandler };

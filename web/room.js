'use strict';

/**
 * 게임 방 - 규칙과 상태를 전부 여기서 들고 있다. I/O는 없다(테스트하기 쉽게).
 *
 * ── LAN(UDP) 버전과 무엇이 달라지는가 ────────────────────────────────────────
 * LAN 버전의 골칫거리는 대부분 "서버가 없다"에서 나왔다. 각 PC가 자기가 받은 패킷으로
 * 결과를 따로 계산했기 때문에, 표 하나만 유실돼도 사람마다 다른 결론이 나왔다(P0-2).
 * 그걸 막으려고 라운드 호스트를 뽑고, 호스트가 나가면 라운드를 취소하고, 동시 시작이면
 * id가 작은 쪽을 채택하는 규칙까지 넣어야 했다.
 *
 * 웹 버전에는 그 층이 통째로 필요 없다. 판정하는 주체가 처음부터 하나(서버)이기 때문이다.
 *   - 중복 수신 제거(msgId), ACK/재전송  → TCP가 해 준다
 *   - 라운드 호스트 선출, roundId, 호스트 이탈 취소, 동시 시작 조정 → 서버가 곧 권위
 *   - REVEAL 왕복(지목된 사람이 정체를 공개) → 서버가 누가 라이어인지 이미 안다
 *   - 프로토콜 버전 불일치, 2중 실행, 유니캐스트 유실 → 애초에 발생할 수 없다
 *
 * 대신 하나를 지킨다: 상태가 바뀌면 "각자에게 맞춘 전체 상태"를 통째로 다시 보낸다.
 * 증분 이벤트를 쌓아 화면 상태를 맞추는 방식이 LAN 버전에서 어긋남의 근원이었다.
 * 인원이 10명 남짓이라 전체 전송이 훨씬 싸고, 어긋날 여지가 구조적으로 없다.
 *
 * 공정성: 제시어는 서버만 알고, 라이어에게는 절대 내려보내지 않는다. 로그에도 남기지
 * 않는다(LAN 버전은 시작 버튼을 누른 사람이 자기 PC에서 뽑아서 늘 답을 알고 있었다).
 */

const crypto = require('crypto');
const { normalizeWord } = require('./protocol');
const WORD_LIST = require('./words');

/**
 * [H4] 제시어 목록 형식 검사.
 *
 * 목록은 사람이 손으로 고치는 데이터라 대괄호나 쉼표 하나가 빠지기 쉽다. 검사가 없으면
 * 카테고리가 "사", 제시어가 "과"인 채로 게임이 그냥 굴러가 버린다(조용한 실패).
 * 여기서 크게 실패시켜야 릴리즈 전에 걸린다.
 */
function validateWordList(list) {
  const where = 'web/words.js';
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`${where}: 제시어 목록이 비어 있습니다.`);
  }
  list.forEach((entry, i) => {
    const at = `${where} ${i + 1}번째 항목`;
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new Error(`${at}: [카테고리, 제시어] 두 칸짜리 배열이어야 합니다. (받은 값: ${JSON.stringify(entry)})`);
    }
    const [category, word] = entry;
    if (typeof category !== 'string' || category.trim() === '') {
      throw new Error(`${at}: 카테고리가 비어 있습니다. (받은 값: ${JSON.stringify(category)})`);
    }
    if (typeof word !== 'string' || word.trim() === '') {
      throw new Error(`${at}: 제시어가 비어 있습니다. (카테고리: ${category})`);
    }
  });
}
validateWordList(WORD_LIST);

const MIN_PLAYERS = 2;
const TURN_ROUNDS = 2;          // 설명을 몇 바퀴 도는가. 1차는 첫인상, 2차는 서로를 듣고 나서.
const SPEAK_MS = 60000;         // 한 사람의 설명 차례 제한 시간
const FREE_MS = 60000;          // 설명이 끝난 뒤 자유 채팅 1분
const PROPOSAL_MS = 20000;      // 투표를 진행할지 묻는 찬반(O/X) 제한 시간
const VOTE_MS = 30000;          // 투표 제한 시간
const GUESS_MS = 30000;         // 라이어가 제시어를 맞힐 제한 시간
// 끊긴 사람의 자리를 남겨 두는 시간. 잠깐 튕겼다 돌아오는 경우만 구제하면 되므로 짧게 둔다.
// 예전에는 라운드 중에 60초를 기다렸는데, 그동안 남은 사람은 아무것도 할 수 없었다.
// 스스로 나가기를 누른 사람은 이 시간을 기다리지 않고 그 자리에서 지운다(leave 참고).
const DROP_MS = 10000;
const CHAT_MAX = 100;           // 재접속한 사람에게도 보여줄 최근 대화 수
const RECENT_WORDS_MAX = 8;

/**
 * @param onChange 상태가 바뀔 때마다 불린다. 서버는 여기서 모든 접속자에게 상태를 다시 보낸다.
 * 타이머와 난수를 주입받는 이유: 테스트에서 30초를 실제로 기다리지 않고, 라이어를 고정하기 위해서다.
 */
function createRoom(options) {
  const opts = options || {};
  const onChange = opts.onChange || (() => {});
  const setTimer = opts.setTimer || setTimeout;
  const clearTimer = opts.clearTimer || clearTimeout;
  const now = opts.now || (() => Date.now());
  const random = opts.random || Math.random;

  const players = new Map(); // playerId -> { id, token, nickname, connected, joinedAt }
  const chat = [];
  // 대화마다 붙는 번호. 화면이 "새 글이 있는가"를 판단하는 데 쓴다.
  // 길이로만 판단하면 상한(CHAT_MAX)에 닿은 뒤로는 밀어내고 넣느라 길이가 그대로여서,
  // 100줄이 넘어가는 순간부터 대화가 화면에서 멈춰 버린다.
  let chatSeq = 0;
  const recentWords = [];
  // [S-3] 몇 판 했는지, 라이어와 시민이 각각 몇 번 이겼는지. 방이 살아 있는 동안 쌓인다.
  // (개표 함수 tally()와 헷갈리지 않게 record로 둔다)
  const record = { rounds: 0, liarWins: 0, citizenWins: 0 };

  // lobby | turn | free | proposal | voting | guess | result
  //   turn     : 랜덤 순서로 대화권을 넘기며 한 명씩 설명한다. 1인 1회.
  //   free     : 전원이 한 번씩 말하고 나면 열리는 자유 채팅. 1분.
  //   proposal : 누가 투표 버튼을 누르면, 정말 투표로 갈지 다 같이 O/X로 정하는 단계
  let phase = 'lobby';
  let round = null;
  let result = null;
  let phaseTimer = null;

  // ───────────────────────────── 내부 도우미 ─────────────────────────────

  function changed() { onChange(); }

  function clearPhaseTimer() {
    if (phaseTimer === null) return;
    clearTimer(phaseTimer);
    phaseTimer = null;
  }

  function connectedPlayers() {
    return [...players.values()].filter((p) => p.connected);
  }

  /** 이번 라운드에 참여 중이고 아직 접속해 있는 사람. 정족수의 기준. */
  function activeRoster() {
    if (!round) return [];
    return round.roster
      .map((r) => players.get(r.id))
      .filter((p) => p && p.connected);
  }

  function inRound(playerId) {
    return !!round && round.roster.some((r) => r.id === playerId);
  }

  /**
   * [W-1] 진행 중인 판에 혼자 남으면(또는 아무도 안 남으면) 그 판을 접고 로비로 되돌린다.
   *
   * 예전에는 "한 명도 안 남았을 때"만 접었다. 그래서 둘이 하다가 한 명이 나가면 남은
   * 사람은 설명 60초 → 자유 대화 60초 → 투표 30초를 혼자 다 흘려보내야 로비로 돌아왔다.
   * 그동안 게임 시작 버튼은 잠겨 있어서, 다른 사람이 새로 들어와도 아무것도 할 수 없었다.
   *
   * 기준은 딱 "혼자 남았는가"다. 시작 조건(MIN_PLAYERS)과 묶지 않는다. 2명으로 하는 판이
   * 흔한데, 시작 인원을 나중에 3명으로 올리면 2명짜리 판이 도중에 취소돼 버린다.
   * 남은 사람이 둘 이상이면 판은 그대로 이어간다.
   */
  function abandonRoundIfAlone() {
    if (phase === 'lobby' || phase === 'result') return false;
    const remaining = activeRoster().length;
    if (remaining > 1) return false;

    clearPhaseTimer();
    round = null;
    result = null;
    phase = 'lobby';
    pushChat({
      kind: 'system', code: 'abandoned', remaining, at: now(),
      text: remaining === 0
        ? '참가자가 모두 나가 라운드가 취소되었습니다.'
        : '혼자 남아 라운드가 취소되었습니다.',
    });
    return true;
  }

  /**
   * 마지막 사람이 나가면 방을 처음 상태로 되돌린다.
   *
   * 예전에는 아무것도 하지 않았다. 판이 끝난 뒤(phase가 'result') 전원이 나가면
   * abandonRoundIfAlone()은 'result'를 건너뛰도록 되어 있어서, 방이 남의 판 결과를
   * 그대로 안고 텅 빈 채로 남았다. 그 뒤에 들어온 사람은 한 번도 하지 않은 판의
   * 결과 화면 - 제시어와 누가 라이어였는지까지 - 을 그대로 보게 된다.
   * 앞 사람들의 대화와 전적도 남는다.
   *
   * 아무도 없는 방은 새 방과 같아야 한다. 그래서 여기서 전부 지운다.
   * (끊긴 사람은 DROP_MS 동안 목록에 남으므로, 잠깐 튕긴 것만으로는 여기 오지 않는다.)
   */
  function resetIfEmpty() {
    if (players.size > 0) return false;
    clearPhaseTimer();
    round = null;
    result = null;
    phase = 'lobby';
    chat.length = 0;
    chatSeq = 0;
    recentWords.length = 0;
    record.rounds = 0;
    record.liarWins = 0;
    record.citizenWins = 0;
    return true;
  }

  /**
   * 라이어가 빠진 판은 성립하지 않는다. 남은 사람끼리 계속해 봐야 아무도 라이어가 아니고,
   * 예전에는 그대로 진행돼서 "도망간 라이어 승"으로 전적까지 쌓였다.
   * 도망친 것은 진 것으로 본다 - 시민 승. 그래야 불리해진 라이어가 창을 닫아 버리지 않는다.
   */
  function endRoundIfLiarGone() {
    if (phase === 'lobby' || phase === 'result') return false;
    if (!round || players.has(round.liarId)) return false;
    // 아무도 안 남았으면 줄 승리도 없다. "참가자가 모두 나가"쪽에 넘긴다.
    if (activeRoster().length === 0) return false;

    finish('citizens', 'liarLeft');
    return true;
  }

  function pickWord() {
    const pool = WORD_LIST.filter(([, word]) => !recentWords.includes(word));
    const candidates = pool.length > 0 ? pool : WORD_LIST;
    const picked = candidates[Math.floor(random() * candidates.length)];
    recentWords.push(picked[1]);
    while (recentWords.length > RECENT_WORDS_MAX) recentWords.shift();
    return picked;
  }

  /**
   * [H1·H2] 판에서 빠진 사람의 흔적을 개표에서 지운다.
   *
   *   - 그 사람이 던진 표      : 이미 떠난 판의 결과를 가르면 안 된다.
   *                             (불리해지면 표를 던지고 나가는 것이 이득이 되어 버린다)
   *   - 그 사람에게 간 표      : 방에 없는 사람이 지목되어 "○○님이 지목되었습니다"가
   *                             뜨는 일을 막는다. 던진 사람은 다시 고르면 된다.
   *   - 그 사람의 찬반 답       : 인원(분모)에서는 빠졌는데 답(분자)만 남으면 안 된다.
   */
  function forgetFromRound(playerId) {
    if (!round) return;
    round.votes.delete(playerId);
    for (const [voter, target] of round.votes) {
      if (target === playerId) round.votes.delete(voter);
    }
    if (round.proposal) round.proposal.answers.delete(playerId);
  }

  /**
   * [M2] 같은 닉네임이 여러 명이면 투표 후보가 "철수, 철수"로 떠서 누구를 찍는지 알 수 없다.
   * 서버는 id로 정확히 처리하지만, 누르는 사람이 잘못 누른다. 뒤에 번호를 붙여 구분한다.
   */
  function uniqueNickname(base, exceptId) {
    const name = base.trim() === '' ? '참가자' : base;
    const taken = new Set([...players.values()].filter((p) => p.id !== exceptId).map((p) => p.nickname));
    if (!taken.has(name)) return name;
    for (let n = 2; n <= 99; n += 1) {
      const candidate = `${name}(${n})`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${name}(99)`;
  }

  function nameOf(playerId) {
    const player = players.get(playerId);
    if (player) return player.nickname;
    const entry = round && round.roster.find((r) => r.id === playerId);
    return entry ? entry.nickname : '(나간 참가자)';
  }

  // ───────────────────────────── 참가 / 접속 ─────────────────────────────

  function join(input) {
    // [L3] slice()는 UTF-16 기준이라 24번째가 이모지 중간이면 깨진 글자가 남는다.
    // 글자(코드 포인트) 단위로 자른다.
    const nickname = Array.from(String(input.nickname).trim()).slice(0, 24).join('');

    // 토큰이 맞으면 같은 사람으로 되살린다. 새로고침하거나 잠깐 끊겨도 자리를 잃지 않는다.
    // 단, 그 자리에 이미 누가 접속해 있으면 되살리지 않는다. 한 PC에서 창을 두 개 띄우면
    // 저장소를 공유해 토큰이 같아지는데, 그때 두 창이 한 사람으로 합쳐져 버린다.
    // (창 두 개 = 두 참가자여야 한다.)
    if (input.token) {
      for (const player of players.values()) {
        if (player.token !== input.token) continue;
        if (player.connected) break; // 이미 쓰고 있는 자리 - 새 참가자로 들어간다
        player.connected = true;
        if (phase === 'lobby' || phase === 'result') player.nickname = uniqueNickname(nickname, player.id);
        changed();
        return { playerId: player.id, token: player.token, restored: true };
      }

      // 10초 유예를 넘겨 목록에서는 지워졌지만, 이 판의 참가자였던 사람.
      // 이게 없으면 잠깐 튕긴 사람이 관전자가 되어 그 판이 끝날 때까지 말을 못 한다.
      // (스스로 나가기를 누른 사람은 자리 기록도 지우므로 여기 걸리지 않는다.)
      const seat = round && round.seats.get(input.token);
      if (seat && !players.has(seat.id)) {
        const revived = {
          id: seat.id, token: input.token, nickname: seat.nickname,
          connected: true, joinedAt: now(),
        };
        players.set(revived.id, revived);
        changed();
        return { playerId: revived.id, token: revived.token, restored: true };
      }
    }

    const player = {
      id: crypto.randomUUID().slice(0, 8),
      token: crypto.randomBytes(16).toString('hex'),
      nickname: uniqueNickname(nickname, null),
      connected: true,
      joinedAt: now(),
    };
    players.set(player.id, player);
    changed();
    // 라운드 진행 중에 들어온 사람은 이번 판은 구경만 하고 다음 판부터 참여한다.
    return { playerId: player.id, token: player.token, restored: false };
  }

  function disconnect(playerId) {
    const player = players.get(playerId);
    if (!player || !player.connected) return;
    player.connected = false;

    // [W-1] 목록에서 지우는 타이머는 언제나 건다. 예전에는 로비에서만 걸어서, 라운드 중에
    // 끊긴 사람이 영영 유령으로 남았다. 어느 단계든 10초만 기다린다.
    setTimer(() => {
      const still = players.get(playerId);
      if (!still || still.connected) return;
      players.delete(playerId);
      forgetFromRound(playerId);
      // 이 사람이 마지막이었을 수도, 라이어였을 수도 있다.
      if (resetIfEmpty()) { changed(); return; }
      if (endRoundIfLiarGone() || abandonRoundIfAlone()) { changed(); return; }
      if (phase === 'voting') maybeTally();
      else changed();
    }, DROP_MS);

    if (abandonRoundIfAlone()) { changed(); return; }

    // 끊긴 사람을 계속 기다리면 투표가 끝나지 않는다.
    if (phase === 'voting') maybeTally();
    else if (phase === 'proposal') settleProposal(false);
    else if (phase === 'turn' && currentSpeakerId() === playerId) {
      // 말할 차례인 사람이 창을 닫았다. 돌아올 리 없는 60초를 다 기다릴 이유가 없다.
      round.speakIndex += 1;
      beginTurn();
    } else changed();
  }

  /**
   * 스스로 "나가기"를 누른 경우. 끊긴 것과 달리 10초를 기다리지 않고 그 자리에서 지운다.
   * 돌아올 사람이 아니라고 본인이 말한 것이기 때문이다. 남은 사람이 다음 판을 바로
   * 시작할 수 있어야 한다.
   */
  function leave(playerId) {
    const player = players.get(playerId);
    if (!player) return;
    players.delete(playerId);
    // 자리를 버린 것이므로 되찾을 기록도 지운다. 남겨 두면 다시 들어올 때 되살아난다.
    if (round) round.seats.delete(player.token);
    forgetFromRound(playerId);

    // 마지막 한 명이었으면 방을 통째로 비운다. 줄 승리도, 접을 판도 없다.
    if (resetIfEmpty()) { changed(); return; }
    // 라이어가 나갔거나 혼자 남았으면 여기서 판이 끝난다(round가 null이 되므로 아래는 건너뛴다).
    if (endRoundIfLiarGone() || abandonRoundIfAlone()) { changed(); return; }

    // 나간 사람을 계속 기다리면 그 단계가 끝나지 않는다.
    if (phase === 'voting') maybeTally();
    else if (phase === 'proposal') settleProposal(false);
    else if (phase === 'turn' && currentSpeakerId() === playerId) {
      round.speakIndex += 1;
      beginTurn();
    } else changed();
  }

  // ───────────────────────────── 라운드 진행 ─────────────────────────────

  function start() {
    if (phase !== 'lobby' && phase !== 'result') return '이미 게임이 진행 중입니다.';
    const roster = connectedPlayers();
    if (roster.length < MIN_PLAYERS) {
      return `게임을 시작하려면 최소 ${MIN_PLAYERS}명이 필요합니다. (현재 ${roster.length}명)`;
    }

    const [category, word] = pickWord();
    const liar = roster[Math.floor(random() * roster.length)];

    clearPhaseTimer();
    result = null;
    round = {
      roster: roster.map((p) => ({ id: p.id, nickname: p.nickname })),
      liarId: liar.id,
      category,
      word,
      votes: new Map(),
      proposal: null,
      accusedId: null,
      votingEndsAt: null,
      guessEndsAt: null,
      // 대화권을 넘길 순서. 바퀴마다 새로 섞는다(2차 첫 순서가 1차와 같으면 재미가 없다).
      speakOrder: shuffle(roster.map((p) => p.id)),
      speakIndex: 0,
      speakRound: 1,            // 지금 몇 바퀴째인가 (1차 → 2차 → 자유 대화)
      spoken: new Set(),        // 이번 바퀴에 대화권을 쓴 사람 (한 바퀴에 1인 1회)
      speakEndsAt: null,
      freeEndsAt: null,
      // 이 판의 자리 기록(토큰 → 자리). 10초 유예를 넘겨 돌아온 사람을 원래 자리에
      // 앉히는 데만 쓴다. 토큰이 들어 있으므로 상태로는 절대 내보내지 않는다.
      seats: new Map(roster.map((p) => [p.token, { id: p.id, nickname: p.nickname }])),
    };
    phase = 'turn';
    pushChat({ kind: 'system', code: 'roundStart', text: '게임이 시작되었습니다.', at: now() });
    beginTurn();
    return null;
  }

  /** Fisher-Yates. 주입된 난수를 쓰므로 테스트에서 순서를 고정할 수 있다. */
  function shuffle(list) {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }

  function currentSpeakerId() {
    if (!round || phase !== 'turn') return null;
    return round.speakOrder[round.speakIndex] || null;
  }

  /**
   * 한 바퀴가 끝났다. 남은 바퀴가 있으면 순서를 다시 섞어 이어가고, 없으면 자유 대화로 간다.
   * 아직 아무도 말하지 않은 사람만 남기지 않고 통째로 다시 도는 이유: 2차는 "남의 설명을
   * 듣고 나서" 하는 말이라 1차와 성격이 다르다. 순서도 새로 섞어야 같은 사람이 계속
   * 마지막에 걸리지 않는다.
   */
  function nextSpeakRound() {
    if (round.speakRound >= TURN_ROUNDS) { beginFree(); return; }
    round.speakRound += 1;
    round.speakOrder = shuffle(round.roster.map((r) => r.id));
    round.speakIndex = 0;
    round.spoken = new Set();
    pushChat({ kind: 'system', code: 'speakRoundStart', at: now(), speakRound: round.speakRound,
      text: `${round.speakRound}차 설명을 시작합니다.` });
    beginTurn();
  }

  /** 지금 차례인 사람에게 대화권을 준다. 이미 나간 사람은 건너뛴다. */
  function beginTurn() {
    clearPhaseTimer();
    while (round.speakIndex < round.speakOrder.length) {
      const id = round.speakOrder[round.speakIndex];
      const player = players.get(id);
      if (player && player.connected) break;
      round.speakIndex += 1; // 나간 사람의 차례는 건너뛴다
    }

    if (round.speakIndex >= round.speakOrder.length) { nextSpeakRound(); return; }

    round.speakEndsAt = now() + SPEAK_MS;
    phaseTimer = setTimer(() => {
      phaseTimer = null;
      if (phase !== 'turn') return;
      pushChat({ kind: 'system', code: 'turnSkipped', who: nameOf(currentSpeakerId()), at: now(),
        text: `${nameOf(currentSpeakerId())}님이 설명 시간을 넘겼습니다.` });
      round.speakIndex += 1;
      beginTurn();
    }, SPEAK_MS);
    changed();
  }

  /** 정해진 바퀴를 모두 돌았다. 이제 다 같이 이야기한다. */
  function beginFree() {
    clearPhaseTimer();
    phase = 'free';
    round.speakEndsAt = null;
    round.freeEndsAt = now() + FREE_MS;
    pushChat({ kind: 'system', code: 'freeStart', at: now(), speakRounds: TURN_ROUNDS,
      text: `${TURN_ROUNDS}차 설명까지 끝났습니다. 이제 자유롭게 이야기하세요. (1분)` });
    // 1분이 다 되면 곧바로 투표로 간다. 이미 충분히 이야기했으니 찬반을 다시 묻지 않는다.
    phaseTimer = setTimer(() => {
      phaseTimer = null;
      if (phase === 'free') beginVoting();
    }, FREE_MS);
    changed();
  }

  /**
   * [M4] 상한을 넘으면 밀어낸다. 단, 사람이 친 말을 먼저 버리고 안내(System) 줄은 남긴다.
   * 한 사람이 도배하면 "누가 지목됐는지", "결과가 무엇인지" 같은 줄까지 통째로 밀려나서,
   * 재접속한 사람이 판이 어떻게 돌아갔는지 전혀 알 수 없게 된다.
   */
  function trimChat() {
    while (chat.length > CHAT_MAX) {
      const oldestChat = chat.findIndex((m) => m.kind === 'chat');
      chat.splice(oldestChat >= 0 ? oldestChat : 0, 1);
    }
  }

  /** 대화를 한 줄 남긴다. 번호는 여기서만 붙인다. */
  function pushChat(entry) {
    chatSeq += 1;
    chat.push(Object.assign({ seq: chatSeq }, entry));
    trimChat();
  }

  function say(playerId, text) {
    // 투표 버튼을 누른 순간(찬반)부터 결과가 날 때까지 대화를 막는다.
    // 찬반 단계를 열어 두면 "나 아니야" 같은 변론이 오가서 투표가 흐려진다.
    // 화면에서만 막으면 개발자 도구로 우회되므로 여기서 막는다.
    if (phase === 'proposal' || phase === 'voting' || phase === 'guess') return '지금은 대화할 수 없습니다.';
    const player = players.get(playerId);
    if (!player) return '참가자가 아닙니다.';
    // [W-3] 라운드 도중에 들어온 사람은 관전자다. 제시어를 모르니 정보가 새지는 않지만,
    // 참가자와 구분 없이 말풍선이 떠서 판을 흐린다.
    // (대화권 판정보다 먼저 봐야 한다. 아니면 관전자에게 "○○님 차례입니다"라고 답한다.)
    if (phase !== 'lobby' && phase !== 'result' && !inRound(playerId)) {
      return '이번 라운드는 관전 중입니다. 다음 라운드부터 참여할 수 있습니다.';
    }
    // 설명 단계에서는 대화권을 가진 사람만, 그것도 한 번만 말한다.
    if (phase === 'turn' && playerId !== currentSpeakerId()) {
      return '지금은 ' + nameOf(currentSpeakerId()) + '님의 설명 차례입니다.';
    }
    pushChat({ kind: 'chat', id: playerId, name: player.nickname, text: String(text).trim().slice(0, 300), at: now() });

    // 설명을 마쳤으면 대화권을 다음 사람에게 넘긴다.
    if (phase === 'turn') {
      round.spoken.add(playerId);
      round.speakIndex += 1;
      beginTurn();
      return null;
    }
    changed();
    return null;
  }

  /**
   * 투표 버튼을 누르면 바로 투표로 가지 않고, 먼저 다 같이 O/X로 정한다.
   * 찬성이 절반 이상이면 진행한다(4명 중 2명 O 2명 X도 50%라서 진행).
   */
  function callVote(playerId) {
    if (phase === 'turn') return '아직 설명이 끝나지 않았습니다.';
    if (phase !== 'free') return '지금은 투표를 제안할 수 없습니다.';
    if (!inRound(playerId)) return '이번 라운드 참가자가 아닙니다.';

    round.proposal = {
      by: playerId,
      byName: nameOf(playerId),
      answers: new Map(), // playerId -> true(찬성) / false(반대)
      endsAt: now() + PROPOSAL_MS,
    };
    phase = 'proposal';
    pushChat({ kind: 'system', code: 'proposalCalled', who: nameOf(playerId), text: `${nameOf(playerId)}님이 투표를 제안했습니다. 진행할까요?`, at: now() });

    clearPhaseTimer();
    phaseTimer = setTimer(() => { phaseTimer = null; settleProposal(true); }, PROPOSAL_MS);
    changed();
    return null;
  }

  /** 찬반에 답한다. agree=true가 O, false가 X. */
  function respondProposal(playerId, agree) {
    if (phase !== 'proposal') return '지금은 답할 수 없습니다.';
    if (!inRound(playerId)) return '이번 라운드 참가자가 아닙니다.';

    round.proposal.answers.set(playerId, agree === true);
    settleProposal(false); // 안에서 changed()까지 처리한다
    return null;
  }

  function proposalCounts() {
    let agree = 0;
    let disagree = 0;
    // 자유 채팅 시간이 다 되면 찬반 없이 곧바로 투표로 간다. 그때는 셀 것이 없다.
    if (!round || !round.proposal) return { agree: 0, disagree: 0, total: activeRoster().length };
    for (const yes of round.proposal.answers.values()) {
      if (yes) agree += 1; else disagree += 1;
    }
    return { agree, disagree, total: activeRoster().length };
  }

  /**
   * 결론이 이미 정해졌으면 기다리지 않고 바로 넘어간다.
   *   - 찬성이 절반 이상  → 확정, 투표로 진행
   *   - 반대가 절반 초과  → 남은 사람이 다 찬성해도 절반을 못 넘으므로 확정, 부결
   * force=true는 제한 시간이 다 됐을 때. 답하지 않은 사람은 그냥 빠진 것으로 센다.
   */
  function settleProposal(force) {
    if (phase !== 'proposal') return;
    const { agree, disagree, total } = proposalCounts();
    const answered = agree + disagree;

    // [W-2] 인원이 0이면 "찬성 0 × 2 >= 0"이 참이 되어 0명짜리 투표로 넘어갔다.
    // 이 경우는 W-1의 라운드 취소가 처리한다.
    if (total <= 0) { changed(); return; }

    if (agree * 2 >= total) { beginVoting(); return; }
    if (disagree * 2 > total) { rejectProposal(); return; }
    if (force || answered >= total) {
      if (agree * 2 >= total) beginVoting();
      else rejectProposal();
      return;
    }
    changed();
  }

  function rejectProposal() {
    clearPhaseTimer();
    const { agree, disagree } = proposalCounts();
    round.proposal = null;
    // 부결되면 자유 채팅으로 돌아간다. 남은 시간을 다시 준다.
    phase = 'free';
    round.freeEndsAt = now() + FREE_MS;
    phaseTimer = setTimer(() => {
      phaseTimer = null;
      if (phase === 'free') beginVoting();
    }, FREE_MS);
    pushChat({ kind: 'system', code: 'proposalRejected', agree, disagree, text: `투표 제안이 부결되었습니다. (찬성 ${agree} / 반대 ${disagree}) 대화를 이어가세요.`, at: now() });
    changed();
  }

  function beginVoting() {
    clearPhaseTimer();
    // 찬반을 거쳐 왔는지, 자유 채팅 시간이 다 돼서 그냥 넘어온 것인지 구분한다.
    const byProposal = !!round.proposal;
    const { agree, disagree } = proposalCounts();
    round.proposal = null;
    round.freeEndsAt = null;
    round.votes.clear();
    round.votingEndsAt = now() + VOTE_MS;
    phase = 'voting';
    pushChat({ kind: 'system', code: 'votingStarted', byProposal, agree, disagree,
      text: byProposal
        ? `투표를 진행합니다. (찬성 ${agree} / 반대 ${disagree})`
        : '자유 대화 시간이 끝났습니다. 투표를 진행합니다.',
      at: now() });
    phaseTimer = setTimer(() => { phaseTimer = null; tally(); }, VOTE_MS);
    changed();
  }

  function vote(playerId, targetId) {
    if (phase !== 'voting') return '지금은 투표할 수 없습니다.';
    if (!inRound(playerId)) return '이번 라운드 참가자가 아닙니다.';
    if (!inRound(targetId)) return '이번 라운드 참가자가 아닌 사람에게는 투표할 수 없습니다.';
    // 이미 방을 나간 사람은 고를 수 없다. 화면에서도 빼지만 여기서 한 번 더 막는다.
    if (!players.has(targetId)) return '이미 방을 나간 사람에게는 투표할 수 없습니다.';
    if (playerId === targetId) return '자기 자신에게는 투표할 수 없습니다.';

    round.votes.set(playerId, targetId);
    maybeTally(); // 안에서 changed()까지 처리한다
    return null;
  }

  /** 접속해 있는 이번 라운드 참가자가 모두 던졌으면 바로 집계한다. */
  function maybeTally() {
    if (phase !== 'voting') { changed(); return; }
    const active = activeRoster();
    const allVoted = active.length > 0 && active.every((p) => round.votes.has(p.id));
    if (allVoted) tally();
    else changed();
  }

  function tally() {
    if (phase !== 'voting') return;
    clearPhaseTimer();

    if (round.votes.size === 0) {
      finish('liar', 'noVotes');
      return;
    }

    const counts = new Map();
    for (const targetId of round.votes.values()) counts.set(targetId, (counts.get(targetId) || 0) + 1);

    let top = [];
    let max = 0;
    for (const [id, count] of counts) {
      if (count > max) { max = count; top = [id]; }
      else if (count === max) top.push(id);
    }
    if (top.length !== 1) {
      finish('liar', 'tie');
      return;
    }

    round.accusedId = top[0];
    pushChat({ kind: 'system', code: 'accused', who: nameOf(round.accusedId), text: `${nameOf(round.accusedId)}님이 지목되었습니다.`, at: now() });

    // LAN 버전에서는 지목된 본인이 REVEAL을 보내 줘야 정체를 알 수 있었고, 그 패킷이
    // 유실되면 전원이 무한 대기했다. 여기서는 서버가 이미 알고 있으니 왕복이 없다.
    if (round.accusedId !== round.liarId) {
      finish('liar', 'wrongAccusation');
      return;
    }

    phase = 'guess';
    round.guessEndsAt = now() + GUESS_MS;
    phaseTimer = setTimer(() => { phaseTimer = null; finish('citizens', 'guessTimeout'); }, GUESS_MS);
    changed();
  }

  function guess(playerId, word) {
    if (phase !== 'guess') return '지금은 정답을 낼 수 없습니다.';
    if (playerId !== round.accusedId) return '지목된 사람만 정답을 낼 수 있습니다.';
    const correct = normalizeWord(word) === normalizeWord(round.word);
    finish(correct ? 'liar' : 'citizens', 'guess', { guess: String(word).trim().slice(0, 60) });
    return null;
  }

  function finish(winner, reason, extra) {
    clearPhaseTimer();
    result = Object.assign({
      winner,
      reason,
      word: round.word,                                        // 끝났으니 모두에게 공개한다
      liar: { id: round.liarId, nickname: nameOf(round.liarId) },
      accused: round.accusedId ? { id: round.accusedId, nickname: nameOf(round.accusedId) } : null,
    }, extra || {});
    record.rounds += 1;
    if (winner === 'liar') record.liarWins += 1;
    else if (winner === 'citizens') record.citizenWins += 1;

    // 결과는 화면 아래 카드로도 보이지만, 대화에도 남겨야 다음 판을 시작한 뒤에
    // "아까 누가 라이어였지?"를 되짚을 수 있다.
    pushChat({
      kind: 'system', code: 'result', at: now(),
      winner, reason,
      liarName: result.liar.nickname,
      word: result.word,
      guess: result.guess || null,
      text: (winner === 'liar' ? 'Oliveyoung 승리' : winner === 'citizens' ? '시민 팀 승리' : '라운드 취소'),
    });

    phase = 'result';
    round = null;
    changed();
  }

  // ───────────────────── 각자에게 맞춘 상태 ─────────────────────

  function stateFor(playerId) {
    const me = players.get(playerId) || null;
    const iAmIn = inRound(playerId);

    return {
      type: 'state',
      phase,
      minPlayers: MIN_PLAYERS,
      serverTime: now(), // 클라이언트 시계가 어긋나 있어도 남은 시간을 정확히 세도록
      you: me ? {
        id: me.id,
        nickname: me.nickname,
        inRound: iAmIn,
        // 라이어에게는 제시어를 절대 내려보내지 않는다. 브라우저에서 가려지는 게 아니라
        // 애초에 전송되지 않는다.
        isLiar: iAmIn && !!round && round.liarId === me.id,
        word: iAmIn && round && round.liarId !== me.id ? round.word : null,
        category: iAmIn && round ? round.category : null,
        canGuess: phase === 'guess' && !!round && round.accusedId === me.id,
        // 지금 내 대화권 차례인가. 화면은 이걸로 입력창을 열고 닫는다.
        myTurn: phase === 'turn' && currentSpeakerId() === me.id,
        spoken: !!round && round.spoken.has(me.id),
        hasVoted: phase === 'voting' && !!round && round.votes.has(me.id),
        // 찬반 단계에서 내가 이미 답했는지. null이면 아직 안 답함.
        proposalAnswer: phase === 'proposal' && !!round && round.proposal.answers.has(me.id)
          ? round.proposal.answers.get(me.id) : null,
      } : null,
      players: [...players.values()].map((p) => ({
        id: p.id,
        nickname: p.nickname,
        connected: p.connected,
        inRound: inRound(p.id),
        // 누가 아직 안 던졌는지만 보인다. 누구에게 던졌는지는 보이지 않는다.
        voted: phase === 'voting' && !!round && round.votes.has(p.id),
        answered: phase === 'proposal' && !!round && round.proposal.answers.has(p.id),
        // 설명 단계에서 지금 말할 차례인지 / 이미 설명을 마쳤는지
        speaking: phase === 'turn' && currentSpeakerId() === p.id,
        spoke: !!round && round.spoken.has(p.id),
      })),
      round: round ? {
        category: round.category,
        // left = 이미 방을 나간 사람. 화면이 투표 후보에서 빼는 데 쓴다.
        roster: round.roster.map((r) => ({ id: r.id, nickname: r.nickname, left: !players.has(r.id) })),
        // 설명 단계 진행 상황. 화면이 "누구 차례 / 몇 명 남았는지"를 이걸로 그린다.
        speaker: phase === 'turn' && currentSpeakerId()
          ? { id: currentSpeakerId(), nickname: nameOf(currentSpeakerId()) } : null,
        speakEndsAt: phase === 'turn' ? round.speakEndsAt : null,
        freeEndsAt: phase === 'free' ? round.freeEndsAt : null,
        // 이미 나간 사람은 빼고 센다. 넣어서 세면 화면의 "N명 중 M명 설명함"이
        // 끝까지 차지 않아서, 다 말했는데도 안 끝나는 것처럼 보인다.
        spokenCount: [...round.spoken].filter((id) => players.has(id)).length,
        speakTotal: round.speakOrder.filter((id) => players.has(id)).length,
        speakRound: round.speakRound,
        speakRounds: TURN_ROUNDS,
        proposal: round.proposal ? Object.assign(
          { by: round.proposal.by, byName: round.proposal.byName, endsAt: round.proposal.endsAt },
          proposalCounts(),
        ) : null,
        votingEndsAt: round.votingEndsAt,
        guessEndsAt: round.guessEndsAt,
        accused: round.accusedId ? { id: round.accusedId, nickname: nameOf(round.accusedId) } : null,
        voted: round.votes.size,
        total: activeRoster().length,
      } : null,
      result,
      record,
      chat,
      canStart: (phase === 'lobby' || phase === 'result') && connectedPlayers().length >= MIN_PLAYERS,
    };
  }

  return {
    join, disconnect, leave, start, say, callVote, respondProposal, vote, guess, stateFor,
    playerIds: () => [...players.keys()],
    // 테스트에서 들여다보기 위한 것. 서버는 쓰지 않는다.
    _debug: () => ({ phase, round, result }),
    MIN_PLAYERS, TURN_ROUNDS, PROPOSAL_MS, VOTE_MS, GUESS_MS, DROP_MS,
  };
}

module.exports = {
  createRoom, validateWordList,
  MIN_PLAYERS, TURN_ROUNDS, PROPOSAL_MS, VOTE_MS, GUESS_MS, DROP_MS,
};

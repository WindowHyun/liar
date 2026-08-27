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

const MIN_PLAYERS = 2;
const PROPOSAL_MS = 20000;      // 투표를 진행할지 묻는 찬반(O/X) 제한 시간
const VOTE_MS = 30000;          // 투표 제한 시간
const GUESS_MS = 30000;         // 라이어가 제시어를 맞힐 제한 시간
const LOBBY_DROP_MS = 10000;    // 로비에서 끊긴 사람을 목록에서 지우기까지
const ROUND_DROP_MS = 60000;    // 라운드 중에는 더 기다린다 - 잠깐 끊겼다 돌아올 수 있으므로
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
  const recentWords = [];
  // [S-3] 몇 판 했는지, 라이어와 시민이 각각 몇 번 이겼는지. 방이 살아 있는 동안 쌓인다.
  // (개표 함수 tally()와 헷갈리지 않게 record로 둔다)
  const record = { rounds: 0, liarWins: 0, citizenWins: 0 };

  // lobby | playing | proposal | voting | guess | result
  //   proposal: 누가 투표 버튼을 누르면, 정말 투표로 갈지 다 같이 O/X로 정하는 단계
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
   * [W-1] 라운드 중에 접속자가 한 명도 남지 않으면 그 라운드를 접고 로비로 되돌린다.
   *
   * 예전에는 이걸 풀어 주는 것이 아무것도 없었다. 라운드 중에는 자리를 남겨 두는데
   * (돌아올 수 있으니까) 아무도 돌아오지 않으면 phase가 'playing'인 채로 굳어서,
   * 이후 들어오는 사람은 영원히 관전자가 되고 게임을 시작할 수도 없었다.
   * 서버를 다시 켜야만 풀렸다.
   */
  function abandonRoundIfEmpty() {
    if (phase === 'lobby' || phase === 'result') return false;
    if (connectedPlayers().length > 0) return false;

    clearPhaseTimer();
    round = null;
    result = null;
    phase = 'lobby';
    chat.push({ kind: 'system', text: '참가자가 모두 나가 라운드가 취소되었습니다.', at: now() });
    trimChat();
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

  function nameOf(playerId) {
    const player = players.get(playerId);
    if (player) return player.nickname;
    const entry = round && round.roster.find((r) => r.id === playerId);
    return entry ? entry.nickname : '(나간 참가자)';
  }

  // ───────────────────────────── 참가 / 접속 ─────────────────────────────

  function join(input) {
    const nickname = String(input.nickname).trim().slice(0, 24);

    // 토큰이 맞으면 같은 사람으로 되살린다. 새로고침하거나 잠깐 끊겨도 자리를 잃지 않는다.
    // 단, 그 자리에 이미 누가 접속해 있으면 되살리지 않는다. 한 PC에서 창을 두 개 띄우면
    // 저장소를 공유해 토큰이 같아지는데, 그때 두 창이 한 사람으로 합쳐져 버린다.
    // (창 두 개 = 두 참가자여야 한다.)
    if (input.token) {
      for (const player of players.values()) {
        if (player.token !== input.token) continue;
        if (player.connected) break; // 이미 쓰고 있는 자리 - 새 참가자로 들어간다
        player.connected = true;
        if (phase === 'lobby' || phase === 'result') player.nickname = nickname;
        changed();
        return { playerId: player.id, token: player.token, restored: true };
      }
    }

    const player = {
      id: crypto.randomUUID().slice(0, 8),
      token: crypto.randomBytes(16).toString('hex'),
      nickname,
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
    // 끊긴 사람이 영영 유령으로 남았다. 라운드 중에는 더 오래 기다린다(돌아올 수 있으므로).
    const dropAfter = (phase === 'lobby' || phase === 'result') ? LOBBY_DROP_MS : ROUND_DROP_MS;
    setTimer(() => {
      const still = players.get(playerId);
      if (!still || still.connected) return;
      players.delete(playerId);
      // 이 사람이 마지막이었을 수도 있다.
      if (!abandonRoundIfEmpty() && phase === 'voting') maybeTally();
      else changed();
    }, dropAfter);

    if (abandonRoundIfEmpty()) { changed(); return; }

    // 나간 사람을 계속 기다리면 투표가 끝나지 않는다.
    if (phase === 'voting') maybeTally();
    else if (phase === 'proposal') settleProposal(false);
    else changed();
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
    };
    phase = 'playing';
    chat.push({ kind: 'system', text: '게임이 시작되었습니다.', at: now() });
    trimChat();
    changed();
    return null;
  }

  function trimChat() {
    while (chat.length > CHAT_MAX) chat.shift();
  }

  function say(playerId, text) {
    // 투표·정답 단계에서는 대화를 막는다. 화면에서만 막으면 개발자 도구로 우회된다.
    // 찬반(proposal) 단계는 "투표로 갈까요?"를 묻는 절차일 뿐이라 대화를 막지 않는다.
    if (phase === 'voting' || phase === 'guess') return '지금은 대화할 수 없습니다.';
    const player = players.get(playerId);
    if (!player) return '참가자가 아닙니다.';
    // [W-3] 라운드 도중에 들어온 사람은 관전자다. 제시어를 모르니 정보가 새지는 않지만,
    // 참가자와 구분 없이 말풍선이 떠서 판을 흐린다.
    if (phase !== 'lobby' && phase !== 'result' && !inRound(playerId)) {
      return '이번 라운드는 관전 중입니다. 다음 라운드부터 참여할 수 있습니다.';
    }
    chat.push({ kind: 'chat', id: playerId, name: player.nickname, text: String(text).trim().slice(0, 300), at: now() });
    trimChat();
    changed();
    return null;
  }

  /**
   * 투표 버튼을 누르면 바로 투표로 가지 않고, 먼저 다 같이 O/X로 정한다.
   * 찬성이 절반 이상이면 진행한다(4명 중 2명 O 2명 X도 50%라서 진행).
   */
  function callVote(playerId) {
    if (phase !== 'playing') return '지금은 투표를 제안할 수 없습니다.';
    if (!inRound(playerId)) return '이번 라운드 참가자가 아닙니다.';

    round.proposal = {
      by: playerId,
      byName: nameOf(playerId),
      answers: new Map(), // playerId -> true(찬성) / false(반대)
      endsAt: now() + PROPOSAL_MS,
    };
    phase = 'proposal';
    chat.push({ kind: 'system', text: `${nameOf(playerId)}님이 투표를 제안했습니다. 진행할까요?`, at: now() });
    trimChat();

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
    phase = 'playing';
    chat.push({ kind: 'system', text: `투표 제안이 부결되었습니다. (찬성 ${agree} / 반대 ${disagree}) 설명을 이어가세요.`, at: now() });
    trimChat();
    changed();
  }

  function beginVoting() {
    clearPhaseTimer();
    const { agree, disagree } = proposalCounts();
    round.proposal = null;
    round.votes.clear();
    round.votingEndsAt = now() + VOTE_MS;
    phase = 'voting';
    chat.push({ kind: 'system', text: `투표를 진행합니다. (찬성 ${agree} / 반대 ${disagree})`, at: now() });
    trimChat();
    phaseTimer = setTimer(() => { phaseTimer = null; tally(); }, VOTE_MS);
    changed();
  }

  function vote(playerId, targetId) {
    if (phase !== 'voting') return '지금은 투표할 수 없습니다.';
    if (!inRound(playerId)) return '이번 라운드 참가자가 아닙니다.';
    if (!inRound(targetId)) return '이번 라운드 참가자가 아닌 사람에게는 투표할 수 없습니다.';
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
    chat.push({ kind: 'system', text: `${nameOf(round.accusedId)}님이 지목되었습니다.`, at: now() });
    trimChat();

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
      })),
      round: round ? {
        category: round.category,
        roster: round.roster,
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
    join, disconnect, start, say, callVote, respondProposal, vote, guess, stateFor,
    playerIds: () => [...players.keys()],
    // 테스트에서 들여다보기 위한 것. 서버는 쓰지 않는다.
    _debug: () => ({ phase, round, result }),
    MIN_PLAYERS, PROPOSAL_MS, VOTE_MS, GUESS_MS,
  };
}

module.exports = { createRoom, MIN_PLAYERS, PROPOSAL_MS, VOTE_MS, GUESS_MS, LOBBY_DROP_MS };

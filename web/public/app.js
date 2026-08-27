'use strict';

/**
 * 화면. 서버가 보내는 "내 몫으로 걸러진 전체 상태"를 그대로 그린다.
 *
 * 증분 이벤트를 쌓아 화면 상태를 맞추지 않는다. LAN 버전에서 화면이 어긋나던 원인이
 * 그거였다. 상태가 오면 그 시점의 진실을 통째로 다시 그리므로, 어떤 메시지를 놓쳐도
 * 다음 상태 한 번이면 정확히 복구된다.
 */

// 위장 문구. 용어를 바꾸려면 여기만 고치면 된다.
var LABELS = {
  app: 'Slack',
  channel: '# Oliveyoung',
  liar: 'Oliveyoung',
};

var TOKEN_KEY = 'liar-game-token';
var NAME_KEY = 'liar-game-nickname';

var ws = null;
var state = null;
var myId = null;
var myNickname = '';
var joined = false;
var reconnectTimer = null;
var reconnectDelay = 500;
var tickTimer = null;
var everConnected = false; // [E-1] 첫 접속과 호스트 인계를 구분하기 위해
var serverOffset = 0; // 서버 시계 - 내 시계. 남은 시간을 정확히 세기 위해.
var lastChatCount = 0;

function $(id) { return document.getElementById(id); }

function readStored(key) {
  try { return window.localStorage.getItem(key) || null; } catch (e) { return null; }
}
function writeStored(key, value) {
  try { window.localStorage.setItem(key, value); } catch (e) { /* 사생활 보호 모드 등 */ }
}
function readToken() { return readStored(TOKEN_KEY); }

// 위장 문구를 마크업에 끼워 넣는다.
Array.prototype.forEach.call(document.querySelectorAll('[data-label]'), function (el) {
  var key = el.getAttribute('data-label');
  if (LABELS[key]) el.textContent = LABELS[key];
});
document.title = LABELS.app;

// ───────────────────────────── 배너 ─────────────────────────────
var bannerHideTimer = null;
function showBanner(kind, text, autoHideMs) {
  var banner = $('banner');
  if (bannerHideTimer) { clearTimeout(bannerHideTimer); bannerHideTimer = null; }
  banner.className = kind;
  banner.textContent = text;
  banner.classList.remove('hidden');
  if (autoHideMs) {
    bannerHideTimer = setTimeout(function () { banner.classList.add('hidden'); bannerHideTimer = null; }, autoHideMs);
  }
}
function hideBanner() {
  if (bannerHideTimer) { clearTimeout(bannerHideTimer); bannerHideTimer = null; }
  $('banner').classList.add('hidden');
}

// ───────────────────────────── 연결 ─────────────────────────────
/**
 * 붙어야 할 게임 서버 주소.
 *   브라우저(웹 버전)  : 이 페이지를 내려준 그 서버
 *   Electron 버전      : LAN에서 뽑힌 호스트. 호스트가 바뀌면 주소도 바뀐다.
 * 두 경우 모두 이 파일 하나로 돌아간다.
 */
function resolveServerUrl() {
  if (window.liar && typeof window.liar.getServer === 'function') return window.liar.getServer();
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
}

function connect() {
  var url = resolveServerUrl();
  if (!url) {
    // Electron에서 아직 호스트가 정해지기 전. 곧 알려 줄 테니 기다린다.
    $('conn-hint').textContent = '같은 네트워크의 참가자를 찾는 중...';
    showBanner('ok', '같은 네트워크에서 함께할 참가자를 찾는 중입니다...');
    scheduleReconnect();
    return;
  }
  ws = new WebSocket(url);

  ws.onopen = function () {
    everConnected = true;
    reconnectDelay = 500;
    hideBanner();
    $('conn-hint').textContent = '';
    if (joined && myNickname) sendMessage({ type: 'join', nickname: myNickname, token: readToken() });
  };

  ws.onmessage = function (ev) {
    var msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.type === 'welcome') {
      myId = msg.playerId;
      writeStored(TOKEN_KEY, msg.token);
      writeStored(NAME_KEY, myNickname);
      return;
    }
    if (msg.type === 'error') { showBanner('warn', msg.message, 5000); return; }
    if (msg.type === 'state') {
      serverOffset = msg.serverTime - Date.now();
      render(msg);
    }
  };

  ws.onclose = function () {
    $('conn-hint').textContent = '서버와 연결이 끊어졌습니다.';
    showBanner('warn', '서버와의 연결이 끊어졌습니다. 다시 연결하는 중입니다...');
    scheduleReconnect();
  };
  ws.onerror = function () { /* 곧바로 onclose가 이어진다 */ };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(function () {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 5000);
}

function sendMessage(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showBanner('warn', '아직 서버와 연결되지 않았습니다. 잠시 후 다시 시도해 주세요.', 3000);
    return false;
  }
  ws.send(JSON.stringify(payload));
  return true;
}

// ───────────────────────────── 조작 ─────────────────────────────
$('join-btn').onclick = function () {
  var nickname = $('nickname-input').value.trim();
  if (!nickname) return;
  myNickname = nickname;
  joined = true;
  enterGameScreen();
  sendMessage({ type: 'join', nickname: nickname, token: readToken() });
};

function enterGameScreen() {
  $('screen-join').classList.add('hidden');
  $('screen-game').classList.remove('hidden');
}

$('start-btn').onclick = function () { sendMessage({ type: 'start' }); };
$('vote-btn').onclick = function () { sendMessage({ type: 'callVote' }); };
$('send-btn').onclick = function () {
  var text = $('chat-input').value.trim();
  if (!text) return;
  if (sendMessage({ type: 'chat', text: text })) $('chat-input').value = '';
};
$('guess-btn').onclick = function () {
  var word = $('guess-input').value.trim();
  if (!word) return;
  sendMessage({ type: 'guess', word: word });
};

$('nickname-input').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') $('join-btn').click(); });
$('chat-input').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') $('send-btn').click(); });
$('guess-input').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') $('guess-btn').click(); });

$('proposal-yes').onclick = function () { sendMessage({ type: 'proposalVote', agree: true }); };
$('proposal-no').onclick = function () { sendMessage({ type: 'proposalVote', agree: false }); };

$('vote-buttons').addEventListener('click', function (ev) {
  var btn = ev.target.closest('button[data-id]');
  if (!btn) return;
  sendMessage({ type: 'vote', targetId: btn.dataset.id });
});

// ───────────────────────────── 그리기 ─────────────────────────────
function secondsLeft(endsAt) {
  if (!endsAt) return 0;
  return Math.max(0, Math.round((endsAt - (Date.now() + serverOffset)) / 1000));
}

function renderParticipants(s) {
  var list = $('participant-list');
  list.innerHTML = '';
  $('participant-count').textContent = '(' + s.players.filter(function (p) { return p.connected; }).length + '명)';

  s.players.forEach(function (p) {
    var li = document.createElement('li');
    if (!p.connected) li.className = 'offline';
    else if (s.phase !== 'lobby' && s.phase !== 'result' && !p.inRound) li.className = 'spectator';

    var name = document.createElement('span');
    name.className = 'name';
    name.textContent = p.nickname + (p.id === myId ? ' (나)' : '');
    li.appendChild(name);

    var tagText = null;
    var tagClass = 'tag';
    if (!p.connected) tagText = '끊김';
    else if (s.phase === 'proposal' && p.inRound) { tagText = p.answered ? '답함' : '대기'; if (p.answered) tagClass += ' voted'; }
    else if (s.phase === 'voting' && p.inRound) { tagText = p.voted ? '투표함' : '대기'; if (p.voted) tagClass += ' voted'; }
    else if (s.phase !== 'lobby' && s.phase !== 'result' && !p.inRound) tagText = '관전';

    if (tagText) {
      var tag = document.createElement('span');
      tag.className = tagClass;
      tag.textContent = tagText;
      li.appendChild(tag);
    }
    list.appendChild(li);
  });
}

function renderChat(s) {
  // 대화 내용은 서버가 통째로 보내 준다. 개수가 바뀔 때만 다시 그린다.
  if (s.chat.length === lastChatCount) return;
  lastChatCount = s.chat.length;

  var box = $('chat');
  box.innerHTML = '';
  s.chat.forEach(function (m) {
    if (m.kind === 'system') {
      var sys = document.createElement('div');
      sys.className = 'sysmsg';
      sys.textContent = m.text;
      box.appendChild(sys);
      return;
    }
    var name = m.name || '(이름 없음)';
    var wrap = document.createElement('div');
    wrap.className = 'msg';
    wrap.innerHTML = '<div class="avatar"></div><div><div class="name"></div><div class="text"></div></div>';
    wrap.querySelector('.avatar').textContent = name.slice(0, 2);
    wrap.querySelector('.name').textContent = name;
    wrap.querySelector('.text').textContent = m.text;
    box.appendChild(wrap);
  });
  box.scrollTop = box.scrollHeight;
}

function renderRoleCard(s) {
  var card = $('role-card');
  if (s.phase === 'lobby' || s.phase === 'result' || !s.you || !s.you.inRound) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');
  if (s.you.isLiar) {
    card.className = 'liar';
    card.textContent = '당신은 ' + LABELS.liar + '입니다. 카테고리: ' + s.you.category + ' (제시어는 모릅니다)';
  } else if (s.you.word) {
    card.className = 'citizen';
    card.textContent = '카테고리: ' + s.you.category + ' / 제시어: ' + s.you.word;
  } else {
    card.className = 'pending';
    card.textContent = '역할을 받는 중입니다...';
  }
}

/** 투표로 갈지 다 같이 O/X로 정하는 단계. */
function renderProposalPanel(s) {
  var panel = $('proposal-panel');
  var show = s.phase === 'proposal' && s.round && s.round.proposal && s.you && s.you.inRound;
  panel.classList.toggle('hidden', !show);
  if (!show) return;

  var p = s.round.proposal;
  $('proposal-by').textContent = p.byName;
  $('proposal-agree').textContent = p.agree;
  $('proposal-disagree').textContent = p.disagree;
  $('proposal-total').textContent = p.total;
  $('proposal-timer').textContent = secondsLeft(p.endsAt);

  var answered = s.you.proposalAnswer !== null && s.you.proposalAnswer !== undefined;
  $('proposal-yes').classList.toggle('chosen', s.you.proposalAnswer === true);
  $('proposal-no').classList.toggle('chosen', s.you.proposalAnswer === false);
  var mine = $('proposal-mine');
  mine.classList.toggle('hidden', !answered);
  if (answered) {
    mine.textContent = s.you.proposalAnswer
      ? 'O(진행)에 답했습니다. 다른 사람을 기다리는 중...'
      : 'X(더 듣기)에 답했습니다. 다른 사람을 기다리는 중...';
  }
}

function renderVotePanel(s) {
  var panel = $('vote-panel');
  if (s.phase !== 'voting' || !s.you || !s.you.inRound) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  $('vote-count').textContent = s.round.voted + '/' + s.round.total;
  $('vote-timer').textContent = secondsLeft(s.round.votingEndsAt);

  var box = $('vote-buttons');
  box.innerHTML = '';
  if (s.you.hasVoted) {
    var done = document.createElement('p');
    done.className = 'panel-title';
    done.textContent = '투표했습니다. 다른 사람을 기다리는 중...';
    box.appendChild(done);
    return;
  }
  s.round.roster.filter(function (p) { return p.id !== myId; }).forEach(function (p) {
    var btn = document.createElement('button');
    btn.dataset.id = p.id;
    btn.textContent = p.nickname;
    box.appendChild(btn);
  });
}

function renderGuessPanel(s) {
  var panel = $('guess-panel');
  var mine = s.phase === 'guess' && s.you && s.you.canGuess;
  panel.classList.toggle('hidden', !mine);
  if (mine) $('guess-timer').textContent = secondsLeft(s.round.guessEndsAt);
}

function renderResult(s) {
  var panel = $('result-panel');
  if (s.phase !== 'result' || !s.result) {
    panel.classList.add('hidden');
    return;
  }
  var r = s.result;
  var reasons = {
    tie: '투표가 동점이었습니다.',
    noVotes: '제한 시간 안에 아무도 투표하지 않았습니다.',
    wrongAccusation: (r.accused ? r.accused.nickname + '님은 ' : '지목된 사람은 ') + LABELS.liar + '이 아니었습니다.',
    guessTimeout: LABELS.liar + '이 제한 시간 안에 제시어를 맞히지 못했습니다.',
    guess: r.winner === 'liar'
      ? LABELS.liar + '이 제시어를 맞혔습니다! ("' + r.guess + '")'
      : LABELS.liar + '이 제시어를 맞히지 못했습니다. ("' + r.guess + '")',
  };

  panel.classList.remove('hidden');
  panel.innerHTML = '';
  var headline = document.createElement('div');
  headline.className = 'headline';
  headline.textContent = (r.winner === 'liar' ? LABELS.liar + ' 승리!' : '시민 팀 승리!');
  var detail = document.createElement('div');
  detail.className = 'detail';
  detail.textContent = (reasons[r.reason] || '') + ' · ' + LABELS.liar + '는 ' + r.liar.nickname + '님, 제시어는 "' + r.word + '"였습니다.';
  panel.appendChild(headline);
  panel.appendChild(detail);
}

function render(s) {
  state = s;
  if (s.you) myId = s.you.id;

  renderParticipants(s);
  renderChat(s);
  renderRoleCard(s);
  renderProposalPanel(s);
  renderVotePanel(s);
  renderGuessPanel(s);
  renderResult(s);

  $('start-btn').disabled = !s.canStart;
  $('start-btn').textContent = s.phase === 'result' ? '다음 라운드' : '게임 시작';
  $('start-btn').classList.toggle('hidden', s.phase === 'playing' || s.phase === 'voting' || s.phase === 'guess');
  $('vote-btn').disabled = !(s.phase === 'playing' && s.you && s.you.inRound);
  $('vote-btn').textContent = s.phase === 'proposal' ? '찬반 진행 중' : '투표';

  // 대화는 투표·정답 단계에서만 잠긴다. 서버도 같은 규칙으로 막으므로 화면만의 잠금이 아니다.
  var chatLocked = s.phase === 'voting' || s.phase === 'guess';
  $('chat-input').disabled = chatLocked;
  $('send-btn').disabled = chatLocked;

  if (s.phase !== 'lobby' && s.phase !== 'result' && s.you && !s.you.inRound) {
    showBanner('ok', '이미 시작된 판이라 이번 라운드는 관전합니다. 다음 라운드부터 참여합니다.');
  }

  // 남은 시간은 1초마다 다시 계산한다(서버 시계 기준).
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  if (s.phase === 'proposal' || s.phase === 'voting' || s.phase === 'guess') {
    tickTimer = setInterval(function () {
      if (!state || !state.round) return;
      if (state.phase === 'proposal' && state.round.proposal) $('proposal-timer').textContent = secondsLeft(state.round.proposal.endsAt);
      if (state.phase === 'voting') $('vote-timer').textContent = secondsLeft(state.round.votingEndsAt);
      if (state.phase === 'guess') $('guess-timer').textContent = secondsLeft(state.round.guessEndsAt);
    }, 1000);
  }
}

// 새로고침해도 접속 화면으로 되돌아가지 않게, 닉네임과 토큰을 저장해 두고 자동으로 다시 참가한다.
// (서버가 재시작돼 토큰을 모르면 같은 닉네임의 새 참가자로 들어간다.)
var savedName = readStored(NAME_KEY);
if (savedName && readToken()) {
  myNickname = savedName;
  joined = true;
  enterGameScreen();
}

// Electron 버전에서 호스트가 바뀌면(먼저 켠 사람이 나가면) 붙을 주소가 달라진다.
// 기존 연결을 정리하고 새 주소로 곧바로 다시 붙는다.
// Electron이 올려 주는 알림(버전 불일치 등)을 배너로 띄운다.
if (window.liar && typeof window.liar.onNotice === 'function') {
  window.liar.onNotice(function (notice) {
    if (notice && notice.text) showBanner('warn', notice.text);
  });
}

if (window.liar && typeof window.liar.onServerChange === 'function') {
  window.liar.onServerChange(function (url) {
    // [E-1] 호스트가 바뀌면 라운드 상태는 옛 호스트의 메모리와 함께 사라진다.
    // 조용히 초기화되면 "왜 갑자기 처음이지?"가 되므로 이유를 알려 준다.
    if (url && everConnected) {
      showBanner('warn', '게임을 진행하던 사람의 접속이 끊겨 다른 PC가 이어받았습니다. 라운드는 처음부터 다시 시작합니다.', 8000);
    }
    if (ws) {
      ws.onclose = null; // 자동 재연결 경로가 겹치지 않게
      try { ws.close(); } catch (e) { /* 이미 닫힘 */ }
      ws = null;
    }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    reconnectDelay = 300;
    connect();
  });
}

connect();

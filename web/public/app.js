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
function connect() {
  var scheme = location.protocol === 'https:' ? 'wss://' : 'ws://';
  ws = new WebSocket(scheme + location.host);

  ws.onopen = function () {
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
  renderVotePanel(s);
  renderGuessPanel(s);
  renderResult(s);

  $('start-btn').disabled = !s.canStart;
  $('start-btn').textContent = s.phase === 'result' ? '다음 라운드' : '게임 시작';
  $('start-btn').classList.toggle('hidden', s.phase === 'playing' || s.phase === 'voting' || s.phase === 'guess');
  $('vote-btn').disabled = !(s.phase === 'playing' && s.you && s.you.inRound);

  // 대화는 투표·정답 단계에서만 잠긴다. 서버도 같은 규칙으로 막으므로 화면만의 잠금이 아니다.
  var chatLocked = s.phase === 'voting' || s.phase === 'guess';
  $('chat-input').disabled = chatLocked;
  $('send-btn').disabled = chatLocked;

  if (s.phase !== 'lobby' && s.phase !== 'result' && s.you && !s.you.inRound) {
    showBanner('ok', '이미 시작된 판이라 이번 라운드는 관전합니다. 다음 라운드부터 참여합니다.');
  }

  // 남은 시간은 1초마다 다시 계산한다(서버 시계 기준).
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  if (s.phase === 'voting' || s.phase === 'guess') {
    tickTimer = setInterval(function () {
      if (!state) return;
      if (state.phase === 'voting' && state.round) $('vote-timer').textContent = secondsLeft(state.round.votingEndsAt);
      if (state.phase === 'guess' && state.round) $('guess-timer').textContent = secondsLeft(state.round.guessEndsAt);
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

connect();

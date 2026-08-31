'use strict';

/**
 * 화면. 서버가 보내는 "내 몫으로 걸러진 전체 상태"를 그대로 그린다.
 *
 * 증분 이벤트를 쌓아 화면 상태를 맞추지 않는다. 상태가 오면 그 시점의 진실을 통째로
 * 다시 그리므로, 어떤 메시지를 놓쳐도 다음 상태 한 번이면 정확히 복구된다.
 *
 * 화면 구성:
 *   #chat > #chat-messages   지나간 대화. 개수가 바뀔 때만 다시 그린다.
 *         > #live-block      지금 답해야 하는 것(찬반/투표/정답). 상태마다 다시 그린다.
 * 찬반·투표를 화면 아래 별도 패널이 아니라 대화 흐름 안에 들여쓰여 놓는다. 슬랙에서
 * 앱이 보내는 메시지와 같은 모양이라, 지금 무엇에 답하는 중인지가 분명해진다.
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
var serverOffset = 0;      // 서버 시계 - 내 시계. 남은 시간을 정확히 세기 위해.
var bannerWhy = null;       // 지금 배너가 떠 있는 사유. 그 사유가 사라지면 내린다.
var lastChatKey = '';       // 대화를 다시 그릴지 판단하는 지문
// [요청] 창을 내려 둔 사이에 온 것을 알리기 위한 직전 값. 처음 그릴 때는 알리지 않는다.
var lastNotifiedSeq = null;
var wasMyTurn = false;
// [E-3] 연결 감시. 사내망에서 조용한 연결이 끊기거나, 끊긴 줄도 모르고 있는 것을 막는다.
var PING_MS = 20000;       // 살아 있는지 물어보는 주기
var SILENCE_MS = 50000;    // 이만큼 아무 소식이 없으면 죽은 연결로 보고 다시 붙는다
var pingTimer = null;
var lastSeenAt = 0;
// 예전 버전(v0.8.0 이하) 서버는 이 확인 요청을 모른다. 그런 서버에 붙으면 20초마다
// "잘못된 요청입니다" 배너가 떠서 고장난 것처럼 보인다. 한 번 거절당하면 그만 보낸다.
var pingSupported = true;
var pongSeen = false;
var pingSentAt = 0;
var liveSignature = '';    // 진행 블록을 필요할 때만 다시 그리기 위한 지문

function $(id) { return document.getElementById(id); }

/**
 * 받침에 맞는 조사를 고른다. 한글이 아니면(영문 등) 받침 있는 쪽을 쓴다.
 * 이 게임에서 영문은 위장 단어 Oliveyoung뿐이고, 그건 "Oliveyoung은"이 맞다.
 */
function josa(word, withBatchim, without) {
  var last = String(word == null ? '' : word).trim().slice(-1);
  var code = last.charCodeAt(0);
  if (!(code >= 0xAC00 && code <= 0xD7A3)) return withBatchim;
  return (code - 0xAC00) % 28 !== 0 ? withBatchim : without;
}

function readStored(key) {
  try { return window.localStorage.getItem(key) || null; } catch (e) { return null; }
}
function writeStored(key, value) {
  try { window.localStorage.setItem(key, value); } catch (e) { /* 사생활 보호 모드 등 */ }
}
function clearStored(key) {
  try { window.localStorage.removeItem(key); } catch (e) { /* 사생활 보호 모드 등 */ }
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
function showBanner(kind, text, autoHideMs, why) {
  var banner = $('banner');
  if (bannerHideTimer) { clearTimeout(bannerHideTimer); bannerHideTimer = null; }

  // 같은 배너를 다시 띄우는 것이면 글자는 손대지 않는다. 매 상태마다 갈아 끼우면
  // 화면이 미세하게 흔들린다.
  var same = bannerWhy === (why || null)
    && banner.textContent === text
    && !banner.classList.contains('hidden');
  if (!same) {
    bannerWhy = why || null;
    banner.className = kind;
    banner.textContent = text;
    banner.classList.remove('hidden');
  }

  // [이슈] 자동 숨김은 같은 배너를 다시 띄울 때도 반드시 다시 건다.
  // 예전에는 위에서 글자가 같으면 바로 빠져나갔는데, 그때 이미 타이머를 꺼 놓은 뒤라
  // 다시 거는 줄에 닿지 못했다. 같은 오류가 5초 안에 두 번 나면 배너가 영영 남았다.
  if (autoHideMs) {
    bannerHideTimer = setTimeout(function () {
      banner.classList.add('hidden');
      bannerHideTimer = null;
      bannerWhy = null;
    }, autoHideMs);
  }
}
function hideBanner() {
  if (bannerHideTimer) { clearTimeout(bannerHideTimer); bannerHideTimer = null; }
  bannerWhy = null;
  $('banner').classList.add('hidden');
}

/** 그 사유로 떠 있는 배너만 내린다. 다른 사유(오류·버전 불일치)로 떠 있으면 두고 본다. */
function hideBannerIf(why) {
  if (bannerWhy !== why) return;
  hideBanner();
}

// ───────────────────────────── 연결 ─────────────────────────────
/**
 * 붙어야 할 게임 서버 주소.
 *   브라우저(웹 버전)  : 이 페이지를 내려준 그 서버
 *   Electron 버전      : LAN에서 뽑힌 호스트. 호스트가 바뀌면 주소도 바뀐다.
 */
function resolveServerUrl() {
  if (window.liar && typeof window.liar.getServer === 'function') return window.liar.getServer();
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
}

function connect() {
  var url = resolveServerUrl();
  if (!url) {
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
    startWatchdog();
    if (joined && myNickname) sendMessage({ type: 'join', nickname: myNickname, token: readToken() });
  };

  ws.onmessage = function (ev) {
    lastSeenAt = Date.now(); // 무엇이 오든 연결이 살아 있다는 뜻이다
    var msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.type === 'pong') { pongSeen = true; return; }
    if (msg.type === 'welcome') {
      myId = msg.playerId;
      writeStored(TOKEN_KEY, msg.token);
      writeStored(NAME_KEY, myNickname);
      return;
    }
    if (msg.type === 'error') {
      // 방금 보낸 확인 요청이 거절당한 것이라면, 이 서버는 예전 버전이다.
      // 사용자에게는 아무 의미 없는 오류라 띄우지 않고, 확인 요청만 그만 보낸다.
      if (!pongSeen && pingSentAt && Date.now() - pingSentAt < 3000) {
        pingSupported = false;
        stopWatchdog();
        $('conn-hint').textContent = '상대가 예전 버전입니다. 모두 같은 파일로 받아주세요.';
        return;
      }
      showBanner('warn', msg.message, 5000);
      return;
    }
    if (msg.type === 'state') {
      serverOffset = msg.serverTime - Date.now();
      render(msg);
    }
  };

  ws.onclose = function () {
    stopWatchdog();
    $('conn-hint').textContent = '서버와 연결이 끊어졌습니다.';
    showBanner('warn', '서버와의 연결이 끊어졌습니다. 다시 연결하는 중입니다...');
    scheduleReconnect();
  };
  ws.onerror = function () { /* 곧바로 onclose가 이어진다 */ };
}

/**
 * [E-3] 연결이 살아 있는지 스스로 확인한다.
 *
 * 브라우저는 WebSocket의 ping 프레임을 자바스크립트로 볼 수 없어서, 서버가 아무리
 * 확인해도 화면은 자기 연결이 죽었는지 알 방법이 없다. 사내망에서는 조용한 연결이
 * 소리 없이 끊기고 close 이벤트도 한참 뒤에야 오거나 아예 안 온다. 그동안 화면은
 * 멀쩡해 보이는데 아무것도 안 되는 상태가 된다.
 * 그래서 주기적으로 물어보고, 답이 없으면 먼저 끊고 다시 붙는다.
 */
function startWatchdog() {
  stopWatchdog();
  if (!pingSupported) return; // 예전 버전 서버 - 물어봐야 거절만 당한다
  lastSeenAt = Date.now();
  pingTimer = setInterval(function () {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // 조용하다고 곧바로 끊지 않는다. 확인 요청에 답이 오는 서버일 때만 판단할 수 있다.
    if (pongSeen && Date.now() - lastSeenAt > SILENCE_MS) {
      $('conn-hint').textContent = '연결이 끊어진 것 같아 다시 붙는 중...';
      try { ws.close(); } catch (e) { /* 이미 닫힘 */ } // onclose가 재연결을 맡는다
      return;
    }
    pingSentAt = Date.now();
    try { ws.send(JSON.stringify({ type: 'ping' })); } catch (e) { /* 곧 onclose가 온다 */ }
  }, PING_MS);
}

function stopWatchdog() {
  if (!pingTimer) return;
  clearInterval(pingTimer);
  pingTimer = null;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(function () { reconnectTimer = null; connect(); }, reconnectDelay);
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
function enterGameScreen() {
  $('screen-join').classList.add('hidden');
  $('screen-game').classList.remove('hidden');
}

$('join-btn').onclick = function () {
  var nickname = $('nickname-input').value.trim();
  if (!nickname) return;
  myNickname = nickname;
  joined = true;
  enterGameScreen();
  sendMessage({ type: 'join', nickname: nickname, token: readToken() });
};

/**
 * 방 나가기. 서버는 이 사람의 자리를 그 자리에서 지운다(끊김과 달리 10초를 기다리지 않는다).
 * 토큰도 지운다. 남겨 두면 다시 들어올 때 방금 버린 자리로 되살아난다.
 * 소켓은 그대로 둔다 - 서버가 playerId만 떼어 내므로 같은 연결로 새로 참가할 수 있다.
 */
function leaveRoom() {
  sendMessage({ type: 'leave' });
  clearStored(TOKEN_KEY);
  clearStored(NAME_KEY);
  joined = false;
  myId = null;
  myNickname = '';
  state = null;
  lastChatKey = '';
  lastNotifiedSeq = null;
  wasMyTurn = false;
  liveSignature = '';
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  $('chat-messages').innerHTML = '';
  $('live-block').innerHTML = '';
  $('result-panel').classList.add('hidden');
  $('role-card').classList.add('hidden');
  $('jump-bar').classList.add('hidden');
  hideBanner();
  $('screen-game').classList.add('hidden');
  $('screen-join').classList.remove('hidden');
  $('nickname-input').value = '';
  $('nickname-input').focus();
}

$('leave-btn').onclick = leaveRoom;
$('start-btn').onclick = function () { sendMessage({ type: 'start' }); };
$('vote-btn').onclick = function () { sendMessage({ type: 'callVote' }); };
$('send-btn').onclick = function () {
  var text = $('chat-input').value.trim();
  if (!text) return;
  if (sendMessage({ type: 'chat', text: text })) $('chat-input').value = '';
};

$('nickname-input').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') $('join-btn').click(); });
$('chat-input').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') $('send-btn').click(); });

// 진행 블록(찬반/투표/정답)은 매번 새로 그리므로 위임으로 받는다.
$('live-block').addEventListener('click', function (ev) {
  var chip = ev.target.closest('button[data-agree]');
  if (chip) { sendMessage({ type: 'proposalVote', agree: chip.dataset.agree === 'yes' }); return; }

  var opt = ev.target.closest('button[data-id]');
  if (opt) { sendMessage({ type: 'vote', targetId: opt.dataset.id }); return; }

  if (ev.target.closest('#guess-btn')) submitGuess();
});
$('live-block').addEventListener('keydown', function (ev) {
  if (ev.key === 'Enter' && ev.target.id === 'guess-input') submitGuess();
});
function submitGuess() {
  var input = $('guess-input');
  if (!input) return;
  var word = input.value.trim();
  if (!word) return;
  sendMessage({ type: 'guess', word: word });
}

// [2번] 위로 올라가 있으면 진행 중이라고 알리고, 누르면 맨 아래로 내려간다.
$('jump-bar').onclick = function () { scrollChatToBottom(); };
$('chat').addEventListener('scroll', updateJumpBar);

function isChatAtBottom() {
  var box = $('chat');
  return box.scrollHeight - box.scrollTop - box.clientHeight < 40;
}
function scrollChatToBottom() {
  var box = $('chat');
  box.scrollTop = box.scrollHeight;
  updateJumpBar();
}

var JUMP_TEXT = {
  turn: '설명이 진행 중입니다',
  free: '자유 대화가 진행 중입니다',
  proposal: 'O/X로 정하는 중입니다',
  voting: '투표가 진행 중입니다',
  guess: '정답을 기다리는 중입니다',
};
function updateJumpBar() {
  var bar = $('jump-bar');
  var phase = state ? state.phase : null;
  var live = JUMP_TEXT[phase];
  if (!live || isChatAtBottom()) { bar.classList.add('hidden'); return; }
  $('jump-text').textContent = live;
  bar.classList.remove('hidden');
}

// ───────────────────────────── 그리기 ─────────────────────────────
function secondsLeft(endsAt) {
  if (!endsAt) return 0;
  return Math.max(0, Math.round((endsAt - (Date.now() + serverOffset)) / 1000));
}

function clockOf(at) {
  var d = new Date(at);
  var h = d.getHours();
  var ampm = h < 12 ? '오전' : '오후';
  var hh = h % 12 || 12;
  return ampm + ' ' + hh + ':' + String(d.getMinutes()).padStart(2, '0');
}

/** 슬랙의 메시지 한 덩어리(아바타 + 이름 + 시각 + 본문). 본문은 호출한 쪽이 채운다. */
function messageShell(opts) {
  var wrap = document.createElement('div');
  wrap.className = 'msg';

  var avatar = document.createElement('div');
  avatar.className = opts.system ? 'avatar sys' : 'avatar';
  avatar.textContent = opts.system ? '⚙️' : (opts.name || '?').slice(0, 2);
  wrap.appendChild(avatar);

  var body = document.createElement('div');
  body.className = 'body';

  var who = document.createElement('div');
  who.className = 'who';
  who.appendChild(document.createTextNode(opts.system ? 'System' : (opts.name || '(이름 없음)')));
  if (opts.system) {
    var tag = document.createElement('span');
    tag.className = 'app-tag';
    tag.textContent = '앱';
    who.appendChild(tag);
  }
  if (opts.at) {
    var time = document.createElement('span');
    time.className = 'time';
    time.textContent = clockOf(opts.at);
    who.appendChild(time);
  }
  body.appendChild(who);
  wrap.appendChild(body);

  wrap.body = body;
  return wrap;
}

/** 사람 이름과 위장 단어를 강조한 한 줄. 서버가 준 code로 화면이 문구를 만든다. */
function systemLine(m) {
  var p = document.createElement('div');
  p.className = 'text';

  function who(name) {
    var s = document.createElement('span');
    s.className = 'who-hl';
    s.textContent = name;
    return s;
  }
  function liar() {
    var s = document.createElement('span');
    s.className = 'liar-hl';
    s.textContent = LABELS.liar;
    return s;
  }

  if (m.code === 'accused' && m.who) {
    // 요청: "System : ○○○이 (라이어)로 지목되었습니다"
    p.appendChild(who(m.who));
    p.appendChild(document.createTextNode('님이 '));
    p.appendChild(liar());
    p.appendChild(document.createTextNode('으로 지목되었습니다.'));
  } else if (m.code === 'proposalCalled' && m.who) {
    p.appendChild(who(m.who));
    p.appendChild(document.createTextNode('님이 투표를 제안했습니다.'));
  } else if (m.code === 'result') {
    p.className = 'text result-line ' + (m.winner === 'liar' ? 'win-liar' : m.winner === 'citizens' ? 'win-citizens' : 'win-none');
    var head = document.createElement('b');
    head.textContent = m.winner === 'liar' ? LABELS.liar + ' 승리'
      : m.winner === 'citizens' ? '시민 팀 승리' : '라운드 취소';
    p.appendChild(head);
    var tail = document.createElement('span');
    tail.textContent = '  ' + LABELS.liar + josa(LABELS.liar, '은 ', '는 ') + m.liarName
      + '님, 제시어는 "' + m.word + '"' + josa(m.word, '이었습니다.', '였습니다.');
    p.appendChild(tail);
  } else if (m.code === 'speakRoundStart') {
    p.textContent = m.speakRound + '차 설명을 시작합니다.';
  } else if (m.code === 'turnSkipped' && m.who) {
    p.appendChild(who(m.who));
    p.appendChild(document.createTextNode('님이 설명 시간을 넘겼습니다.'));
  } else if (m.code === 'nextRoundAsked') {
    p.textContent = m.speakRound + '차 설명이 끝났습니다. ' + m.nextRound + '차 설명을 할까요?';
  } else if (m.code === 'roundsSkipped') {
    p.textContent = '설명을 여기서 마칩니다. (찬성 ' + m.agree + ' / 반대 ' + m.disagree + ')';
  } else if (m.code === 'freeAsked') {
    p.textContent = (m.speakRounds > 1 ? m.speakRounds + '차 설명까지 끝났습니다.' : '설명이 모두 끝났습니다.')
      + ' 자유 대화를 할까요?';
  } else if (m.code === 'freeSkipped') {
    p.textContent = '자유 대화를 건너뜁니다. (찬성 ' + m.agree + ' / 반대 ' + m.disagree + ')';
  } else if (m.code === 'freeStart') {
    p.textContent = '이제 자유롭게 이야기하세요. (1분)';
  } else if (m.code === 'votingStarted') {
    // 찬반을 거쳐 온 경우와, 자유 대화 시간이 다 돼서 그냥 넘어온 경우를 구분한다.
    p.textContent = (m.from === 'freeSkipped' || m.from === 'roundsSkipped')
      ? '투표를 진행합니다.'
      : m.byProposal === false
        ? '자유 대화 시간이 끝났습니다. 투표를 진행합니다.'
        : '투표를 진행합니다. (찬성 ' + m.agree + ' / 반대 ' + m.disagree + ')';
  } else if (m.code === 'proposalRejected') {
    p.textContent = '투표 제안이 부결되었습니다. (찬성 ' + m.agree + ' / 반대 ' + m.disagree + ') 대화를 이어가세요.';
  } else {
    p.textContent = m.text || '';
  }
  return p;
}

function renderChat(s) {
  // 길이로만 판단하면 안 된다. 대화가 상한(100줄)에 닿은 뒤로는 한 줄 밀어내고 한 줄
  // 넣느라 길이가 계속 100이라, 그 시점부터 새 글이 화면에 안 붙는다.
  // 서버가 붙여 주는 글 번호를 같이 본다.
  var key = s.chat.length + ':' + (s.chat.length ? s.chat[s.chat.length - 1].seq : 0);
  if (key === lastChatKey) return;
  var wasAtBottom = isChatAtBottom();
  lastChatKey = key;

  var box = $('chat-messages');
  box.innerHTML = '';

  if (s.chat.length === 0) {
    var empty = document.createElement('p');
    empty.className = 'chat-empty';
    empty.textContent = s.phase === 'lobby'
      ? '아직 대화가 없습니다. 참가자가 모이면 게임을 시작하세요.'
      : '아직 대화가 없습니다.';
    box.appendChild(empty);
  }

  s.chat.forEach(function (m) {
    // 투표 제안은 아래 진행 블록이 같은 내용을 보여준다. 두 번 찍히지 않게 건너뛴다.
    // (제안의 결말인 "진행합니다 / 부결되었습니다"는 기록으로 남긴다.)
    if (m.code === 'proposalCalled') return;
    var shell = messageShell({ system: m.kind === 'system', name: m.name, at: m.at });
    if (m.kind === 'system') {
      shell.body.appendChild(systemLine(m));
    } else {
      var t = document.createElement('div');
      t.className = 'text';
      t.textContent = m.text == null ? '' : m.text;
      shell.body.appendChild(t);
    }
    box.appendChild(shell);
  });
  if (wasAtBottom) scrollChatToBottom();
}

/** 지금 답해야 하는 것을 대화 끝에 이어 붙인다. 내용이 바뀔 때만 다시 그린다. */
function renderLive(s) {
  var sig = liveSignatureOf(s);
  var block = $('live-block');
  if (sig === liveSignature) { refreshLiveTimers(s); return; }
  liveSignature = sig;

  var wasAtBottom = isChatAtBottom();
  block.innerHTML = '';

  if (s.phase === 'turn' && s.round && s.round.speaker) {
    block.appendChild(buildTurn(s));
  } else if (s.phase === 'free' && s.round) {
    block.appendChild(buildFree(s));
  } else if (s.phase === 'proposal' && s.round && s.round.proposal && s.you && s.you.inRound) {
    block.appendChild(buildProposal(s));
  } else if (s.phase === 'voting' && s.round && s.you && s.you.inRound) {
    block.appendChild(buildVote(s));
  } else if (s.phase === 'guess' && s.you && s.you.canGuess) {
    block.appendChild(buildGuess(s));
  }

  if (wasAtBottom || sig !== '') scrollChatToBottom();
  updateJumpBar();
}

/** 다시 그릴지 판단하는 지문. 남은 시간은 뺀다(1초마다 숫자만 갈아 끼운다). */
function liveSignatureOf(s) {
  // 설명/자유 단계는 관전자에게도 보여 준다. 지금 무엇을 하는 중인지는 모두가 알아야 한다.
  // 사람이 빠져도 다시 그려야 하므로 남은 인원을 지문에 넣는다.
  var here = s.round ? s.round.roster.filter(function (r) { return !r.left; }).length : 0;
  if (s.phase === 'turn' && s.round && s.round.speaker) {
    return 't|' + s.round.speakRound + '|' + s.round.speaker.id + '|'
      + s.round.spokenCount + '|' + s.round.speakTotal + '|' + here;
  }
  if (s.phase === 'free' && s.round) return 'f|' + s.round.spokenCount + '|' + here;
  if (!s.you || !s.you.inRound) return '';
  if (s.phase === 'proposal' && s.round && s.round.proposal) {
    var p = s.round.proposal;
    return 'p|' + p.kind + '|' + p.agree + '|' + p.disagree + '|' + p.total + '|' + s.you.proposalAnswer;
  }
  if (s.phase === 'voting' && s.round) {
    return 'v|' + s.round.voted + '|' + s.round.total + '|' + s.you.hasVoted + '|' + here;
  }
  if (s.phase === 'guess' && s.you.canGuess) return 'g';
  return '';
}

/**
 * 설명 단계. 랜덤으로 대화권을 넘기며 한 명씩 설명한다. 1인 1회.
 * 지금 누구 차례인지가 화면에서 제일 커야 한다 - 내 차례를 놓치면 그냥 넘어가 버린다.
 */
function buildTurn(s) {
  var sp = s.round.speaker;
  var mine = !!(s.you && s.you.myTurn);
  var shell = messageShell({ system: true, at: s.round.speakEndsAt - 60000 });

  var text = document.createElement('div');
  text.className = 'text';
  var mic = document.createElement('span');
  mic.className = 'turn-mic';
  mic.textContent = '🎙️';
  text.appendChild(mic);
  if (s.round.speakRounds > 1) {
    var badge = document.createElement('span');
    badge.className = 'round-badge';
    badge.textContent = s.round.speakRound + '차';
    text.appendChild(badge);
  }
  if (mine) {
    var me = document.createElement('span');
    me.className = 'who-hl';
    me.textContent = '내 차례';
    text.appendChild(me);
    text.appendChild(document.createTextNode('입니다. 제시어를 한 번만 설명하세요.'));
  } else {
    var w = document.createElement('span');
    w.className = 'who-hl';
    w.textContent = sp.nickname;
    text.appendChild(w);
    text.appendChild(document.createTextNode('님이 설명하는 중입니다.'));
  }
  shell.body.appendChild(text);
  shell.body.appendChild(speakerTrack(s));

  var meta = document.createElement('p');
  meta.className = 'meta-line';
  meta.id = 'live-meta';
  meta.textContent = metaTurn(s);
  shell.body.appendChild(meta);

  if (mine) shell.classList.add('my-turn');
  return shell;
}

/** 누가 설명을 마쳤는지 한 줄로. 이름 앞에 ✅(마침) / 🎙️(지금) / ⏳(대기). */
function speakerTrack(s) {
  var track = document.createElement('div');
  track.className = 'track';
  var byId = {};
  s.players.forEach(function (p) { byId[p.id] = p; });

  s.round.roster.forEach(function (r) {
    var p = byId[r.id] || {};
    var pill = document.createElement('span');
    pill.className = 'pill' + (r.left ? ' gone' : p.speaking ? ' now' : p.spoke ? ' done' : '');
    var em = document.createElement('span');
    em.className = 'em';
    em.textContent = r.left ? '🚪' : p.speaking ? '🎙️' : p.spoke ? '✅' : '⏳';
    pill.appendChild(em);
    pill.appendChild(document.createTextNode(r.nickname));
    track.appendChild(pill);
  });
  return track;
}

function metaTurn(s) {
  var rounds = s.round.speakRounds > 1
    ? ' · 설명은 ' + s.round.speakRounds + '차까지 돕니다'
    : '';
  return '남은 시간 ' + secondsLeft(s.round.speakEndsAt) + '초 · '
    + s.round.speakTotal + '명 중 ' + s.round.spokenCount + '명 설명함'
    + ' · 한 바퀴에 1인 1회' + rounds;
}

/** 전원이 설명을 마친 뒤의 자유 대화 1분. 여기서만 투표를 제안할 수 있다. */
function buildFree(s) {
  var shell = messageShell({ system: true, at: s.round.freeEndsAt - 60000 });

  var text = document.createElement('div');
  text.className = 'text';
  var em = document.createElement('span');
  em.className = 'turn-mic';
  em.textContent = '💬';
  text.appendChild(em);
  text.appendChild(document.createTextNode('자유 대화 중입니다. 누가 '));
  var l = document.createElement('span');
  l.className = 'liar-hl';
  l.textContent = LABELS.liar;
  text.appendChild(l);
  text.appendChild(document.createTextNode('일지 이야기해 보세요.'));
  shell.body.appendChild(text);

  var meta = document.createElement('p');
  meta.className = 'meta-line';
  meta.id = 'live-meta';
  meta.textContent = metaFree(s);
  shell.body.appendChild(meta);
  return shell;
}

function metaFree(s) {
  return '남은 시간 ' + secondsLeft(s.round.freeEndsAt) + '초 · '
    + '🎧 를 누르면 투표를 제안할 수 있습니다 · 시간이 다 되면 바로 투표로 넘어갑니다';
}

function buildProposal(s) {
  var p = s.round.proposal;
  var shell = messageShell({ system: true, at: p.endsAt - 20000 });

  var text = document.createElement('div');
  text.className = 'text';
  if (p.kind === 'nextRound') {
    // 한 바퀴가 끝나고 "다음 바퀴를 돌까요?"를 묻는 경우.
    text.appendChild(document.createTextNode(
      s.round.speakRound + '차 설명이 끝났습니다. ' + (s.round.speakRound + 1) + '차 설명을 할까요?'));
  } else if (p.kind === 'free') {
    // 설명을 다 돌고 나서 "자유 대화를 할까요?"를 묻는 경우. 제안한 사람이 없다.
    text.appendChild(document.createTextNode('설명이 모두 끝났습니다. 자유 대화를 할까요?'));
  } else {
    var w = document.createElement('span');
    w.className = 'who-hl';
    w.textContent = p.byName;
    text.appendChild(w);
    text.appendChild(document.createTextNode('님이 투표를 제안했습니다. 진행할까요?'));
  }
  shell.body.appendChild(text);

  var chips = document.createElement('div');
  chips.className = 'chips';
  chips.appendChild(chip('yes', '✅', p.agree, s.you.proposalAnswer === true));
  chips.appendChild(chip('no', '❌', p.disagree, s.you.proposalAnswer === false));
  shell.body.appendChild(chips);

  var meta = document.createElement('p');
  meta.className = 'meta-line';
  meta.id = 'live-meta';
  meta.textContent = metaProposal(s);
  shell.body.appendChild(meta);
  return shell;
}

function chip(value, emoji, count, picked) {
  var b = document.createElement('button');
  b.className = picked ? 'chip picked' : 'chip';
  b.dataset.agree = value;
  var em = document.createElement('span');
  em.className = 'em';
  em.textContent = emoji;
  var n = document.createElement('span');
  n.className = 'n';
  n.textContent = count;
  b.appendChild(em);
  b.appendChild(n);
  return b;
}

function metaProposal(s) {
  var p = s.round.proposal;
  return '남은 시간 ' + secondsLeft(p.endsAt) + '초 · ' + p.total + '명 중 ' + (p.agree + p.disagree) + '명 응답'
    + (p.kind === 'nextRound'
      ? ' · 찬성이 절반 이상이면 다음 설명, 아니면 바로 투표로 넘어갑니다'
      : p.kind === 'free'
        ? ' · 찬성이 절반 이상이면 자유 대화, 아니면 바로 투표로 넘어갑니다'
        : ' · 찬성이 절반 이상이면 투표로 넘어갑니다');
}

function buildVote(s) {
  var shell = messageShell({ system: true, at: s.round.votingEndsAt - 30000 });

  var text = document.createElement('div');
  text.className = 'text';
  text.appendChild(document.createTextNode('누가 '));
  var l = document.createElement('span');
  l.className = 'liar-hl';
  l.textContent = LABELS.liar;
  text.appendChild(l);
  text.appendChild(document.createTextNode('일까요? 한 명을 고르세요.'));
  shell.body.appendChild(text);

  if (s.you.hasVoted) {
    var done = document.createElement('div');
    done.className = 'meta-line';
    done.textContent = '투표했습니다. 다른 사람을 기다리는 중...';
    shell.body.appendChild(done);
  } else {
    var opts = document.createElement('div');
    opts.className = 'opts';
    // 이미 방을 나간 사람은 고를 수 없다. 서버도 같은 규칙으로 막는다.
    s.round.roster.filter(function (p) { return p.id !== myId && !p.left; }).forEach(function (p) {
      var b = document.createElement('button');
      b.className = 'opt';
      b.dataset.id = p.id;
      var mini = document.createElement('span');
      mini.className = 'mini';
      mini.textContent = p.nickname.slice(0, 2);
      b.appendChild(mini);
      b.appendChild(document.createTextNode(p.nickname));
      opts.appendChild(b);
    });
    shell.body.appendChild(opts);
  }

  var meta = document.createElement('p');
  meta.className = 'meta-line';
  meta.id = 'live-meta';
  meta.textContent = metaVote(s);
  shell.body.appendChild(meta);
  return shell;
}

function metaVote(s) {
  return '남은 시간 ' + secondsLeft(s.round.votingEndsAt) + '초 · '
    + s.round.total + '명 중 ' + s.round.voted + '명 투표함';
}

function buildGuess(s) {
  var shell = messageShell({ system: true, at: s.round.guessEndsAt - 30000 });

  var text = document.createElement('div');
  text.className = 'text';
  var l = document.createElement('span');
  l.className = 'liar-hl';
  l.textContent = LABELS.liar;
  text.appendChild(l);
  text.appendChild(document.createTextNode('으로 지목되었습니다. 제시어를 맞히면 역전승합니다.'));
  shell.body.appendChild(text);

  var row = document.createElement('div');
  row.className = 'guess-row';
  var input = document.createElement('input');
  input.id = 'guess-input';
  input.placeholder = '제시어 입력';
  input.maxLength = 60;
  input.autocomplete = 'off';
  var btn = document.createElement('button');
  btn.id = 'guess-btn';
  btn.textContent = '제출';
  row.appendChild(input);
  row.appendChild(btn);
  shell.body.appendChild(row);

  var meta = document.createElement('p');
  meta.className = 'meta-line';
  meta.id = 'live-meta';
  meta.textContent = metaGuess(s);
  shell.body.appendChild(meta);
  return shell;
}

function metaGuess(s) { return '남은 시간 ' + secondsLeft(s.round.guessEndsAt) + '초'; }

/** 남은 시간만 1초마다 갈아 끼운다. 블록 전체를 다시 그리면 입력 중인 글자가 날아간다. */
function refreshLiveTimers(s) {
  var meta = $('live-meta');
  if (!meta || !s.round) return;
  if (s.phase === 'turn') meta.textContent = metaTurn(s);
  else if (s.phase === 'free') meta.textContent = metaFree(s);
  else if (s.phase === 'proposal' && s.round.proposal) meta.textContent = metaProposal(s);
  else if (s.phase === 'voting') meta.textContent = metaVote(s);
  else if (s.phase === 'guess') meta.textContent = metaGuess(s);
}

function renderParticipants(s) {
  var list = $('participant-list');
  list.innerHTML = '';
  var online = s.players.filter(function (p) { return p.connected; }).length;
  $('member-count').querySelector('b').textContent = online;

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
    else if (s.phase === 'turn' && p.inRound) {
      if (p.speaking) { tagText = '설명 중'; tagClass += ' speaking'; }
      else if (p.spoke) { tagText = '완료'; tagClass += ' voted'; }
      else tagText = '대기';
    } else if (s.phase === 'free' && p.inRound && p.spoke) { tagText = '완료'; tagClass += ' voted'; }
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

/** 전적은 사이드바 맨 아래에 버전 표기처럼 둔다. */
function renderTally(s) {
  var el = $('tally-label');
  if (!s.record || s.record.rounds === 0) { el.textContent = ''; return; }
  el.textContent = s.record.rounds + '판 · ' + LABELS.liar + ' ' + s.record.liarWins + ' / 시민 ' + s.record.citizenWins;
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

function renderResult(s) {
  var panel = $('result-panel');
  if (s.phase !== 'result' || !s.result) { panel.classList.add('hidden'); return; }

  var r = s.result;
  var reasons = {
    tie: '투표가 동점이었습니다.',
    noVotes: '제한 시간 안에 아무도 투표하지 않았습니다.',
    wrongAccusation: (r.accused ? r.accused.nickname + '님은 ' : '지목된 사람은 ') + LABELS.liar + '이 아니었습니다.',
    guessTimeout: LABELS.liar + '이 제한 시간 안에 제시어를 맞히지 못했습니다.',
    // 불리해졌다고 창을 닫아 버리면 진 것으로 본다.
    liarLeft: r.liar.nickname + '님이 ' + LABELS.liar + josa(LABELS.liar, '이었는데 ', '였는데 ')
      + '도중에 나갔습니다.',
    hostLeft: '게임을 진행하던 사람의 접속이 끊겨 라운드가 취소되었습니다.',
    guess: r.winner === 'liar'
      ? LABELS.liar + '이 제시어를 맞혔습니다!'
      : LABELS.liar + '이 제시어를 맞히지 못했습니다.',
  };

  // 승패에 따라 색이 달라진다. 같은 흰 카드면 이겼는지 졌는지 한눈에 안 들어온다.
  panel.className = r.winner === 'liar' ? 'win-liar' : r.winner === 'citizens' ? 'win-citizens' : 'win-none';
  panel.innerHTML = '';

  var headline = document.createElement('div');
  headline.className = 'headline';
  headline.textContent = r.winner === 'liar' ? LABELS.liar + ' 승리!'
    : r.winner === 'citizens' ? '시민 팀 승리!' : '라운드 취소';
  panel.appendChild(headline);

  var why = document.createElement('div');
  why.className = 'why';
  why.textContent = reasons[r.reason] || '';
  panel.appendChild(why);

  var facts = document.createElement('div');
  facts.className = 'facts';
  facts.appendChild(fact(LABELS.liar, r.liar.nickname));
  facts.appendChild(fact('제시어', r.word));
  if (r.guess) facts.appendChild(fact('제출한 답', r.guess));
  panel.appendChild(facts);
}

function fact(label, value) {
  var box = document.createElement('div');
  box.className = 'fact';
  var k = document.createElement('span');
  k.className = 'k';
  k.textContent = label;
  var v = document.createElement('b');
  v.textContent = value;
  box.appendChild(k);
  box.appendChild(v);
  return box;
}

/**
 * 입력창을 지금 쓸 수 있는지, 못 쓴다면 왜 못 쓰는지. 서버 say()와 같은 규칙이다.
 * 화면에서만 막으면 개발자 도구로 우회되므로 서버가 최종 판정을 하고, 여기서는
 * "왜 회색인지"를 알려 주는 역할만 한다. 그냥 회색이면 고장으로 보인다.
 */
function applyComposer(s) {
  var input = $('chat-input');
  var locked = true;
  var hint = '댓글 남기기...';

  if (s.phase === 'lobby' || s.phase === 'result') {
    locked = false;
  } else if (!s.you || !s.you.inRound) {
    hint = '이번 라운드는 관전 중입니다';
  } else if (s.phase === 'turn') {
    if (s.you.myTurn) {
      locked = false;
      hint = '내 차례입니다. 제시어를 한 번만 설명하세요';
    } else {
      hint = (s.round && s.round.speaker ? s.round.speaker.nickname + '님이 설명하는 중입니다' : '설명이 진행 중입니다');
    }
  } else if (s.phase === 'free') {
    locked = false;
    hint = '자유롭게 이야기하세요...';
  } else if (s.phase === 'proposal' && s.round && s.round.proposal && s.round.proposal.kind === 'nextRound') {
    hint = '다음 설명을 할지 정하는 중입니다';
  } else if (s.phase === 'proposal' && s.round && s.round.proposal && s.round.proposal.kind === 'free') {
    hint = '자유 대화를 할지 정하는 중입니다';
  } else {
    // 투표 버튼을 누른 순간(찬반)부터 결과가 날 때까지 대화를 막는다.
    hint = '투표가 끝날 때까지 대화할 수 없습니다';
  }

  input.disabled = locked;
  $('send-btn').disabled = locked;
  input.placeholder = hint;
  document.getElementById('composer').classList.toggle('my-turn', !locked && s.phase === 'turn');
}

/**
 * [요청] 창을 내려 둔 사이에 대화가 오거나 내 차례가 되면 트레이/작업 표시줄로 알린다.
 *
 * Electron에서만 동작한다(브라우저에는 트레이가 없다). 창이 눈앞에 있는지는 메인 쪽에서
 * 판단하므로 여기서는 "알릴 만한 일"만 가린다.
 *   - 남이 친 대화가 새로 왔을 때 (내가 친 것은 제외)
 *   - 내 차례가 아니었다가 내 차례가 됐을 때
 */
function notifyIfWorthIt(s) {
  if (!window.liar || typeof window.liar.notifyAttention !== 'function') return;

  var last = s.chat.length ? s.chat[s.chat.length - 1] : null;
  var seq = last ? last.seq : 0;
  var myTurn = !!(s.you && s.you.myTurn);

  // 처음 그리는 순간에는 이미 쌓여 있던 것뿐이라 알리지 않는다.
  if (lastNotifiedSeq === null) {
    lastNotifiedSeq = seq;
    wasMyTurn = myTurn;
    return;
  }

  var newChat = seq > lastNotifiedSeq && last && last.kind === 'chat' && last.id !== myId;
  var turnCameToMe = myTurn && !wasMyTurn;
  lastNotifiedSeq = seq;
  wasMyTurn = myTurn;

  if (newChat || turnCameToMe) {
    try { window.liar.notifyAttention(); } catch (e) { /* 알림은 없어도 게임은 돈다 */ }
  }
}

function render(s) {
  state = s;
  if (s.you) myId = s.you.id;

  // 입력창부터 정한다. 아래에서 그리다가 문제가 생겨도 대화까지 막히면 안 된다.
  // (예전에 "방이 리셋될 때까지 채팅이 안 된다"는 신고가 이런 모양이었다.)
  applyComposer(s);

  // 결과 카드가 뜨면 대화 영역이 그만큼 줄어든다. 대화를 다 그린 뒤에 카드가 붙기 때문에,
  // 그리기 직전에 맨 아래를 보고 있었다면 다 그린 다음 한 번 더 내려야 한다.
  // 안 그러면 방금 나온 "○○님이 지목되었습니다"와 결과 줄이 화면 밖으로 밀려서,
  // 정작 읽어야 할 순간에 손으로 스크롤해야 한다.
  var wasAtBottom = isChatAtBottom();

  try {
    renderParticipants(s);
    renderTally(s);
    renderRoleCard(s);
    renderChat(s);
    renderLive(s);
    renderResult(s);
  } catch (err) {
    // 조용히 삼키지 않는다. 화면은 계속 쓸 수 있게 두되, 원인은 남긴다.
    console.error('화면을 그리는 중 문제가 생겼습니다:', err);
  }

  notifyIfWorthIt(s);

  var lobbyish = s.phase === 'lobby' || s.phase === 'result';
  $('start-btn').disabled = !s.canStart;
  $('start-btn').textContent = s.phase === 'result' ? '다음 라운드' : '게임 시작';
  $('start-btn').classList.toggle('hidden', !lobbyish);
  // 투표 제안은 자유 대화 때만. 설명이 끝나기 전에는 누를 수 없다.
  $('vote-btn').disabled = !(s.phase === 'free' && s.you && s.you.inRound);
  $('vote-btn').title = s.phase === 'turn' ? '설명이 끝나면 투표를 제안할 수 있습니다' : '투표 제안';

  // [이슈] 관전자로 들어왔다가 다음 판에서 참가자가 되어도 이 배너가 그대로 남아 있었다.
  // 띄우기만 하고 내리는 쪽이 없었다. 본인 차례인데도 "관전합니다"가 떠 있었다.
  if (s.phase !== 'lobby' && s.phase !== 'result' && s.you && !s.you.inRound) {
    showBanner('ok', '이미 시작된 판이라 이번 라운드는 관전합니다. 다음 라운드부터 참여합니다.', 0, 'spectating');
  } else {
    hideBannerIf('spectating');
  }

  if (wasAtBottom) scrollChatToBottom();

  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  if (s.phase !== 'lobby' && s.phase !== 'result') {
    tickTimer = setInterval(function () { if (state) refreshLiveTimers(state); }, 1000);
  }
  updateJumpBar();
}

// Electron이 올려 주는 알림(버전 불일치 등)을 배너로 띄운다.
if (window.liar && typeof window.liar.onNotice === 'function') {
  window.liar.onNotice(function (notice) {
    if (notice && notice.text) showBanner('warn', notice.text);
  });
}

// Electron 버전에서 호스트가 바뀌면 붙을 주소가 달라진다.
if (window.liar && typeof window.liar.onServerChange === 'function') {
  window.liar.onServerChange(function (url) {
    // [E-1] 호스트가 바뀌면 라운드 상태는 옛 호스트의 메모리와 함께 사라진다.
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

// 새로고침해도 접속 화면으로 되돌아가지 않게, 닉네임과 토큰을 저장해 두고 다시 참가한다.
var savedName = readStored(NAME_KEY);
if (savedName && readToken()) {
  myNickname = savedName;
  joined = true;
  enterGameScreen();
}

connect();

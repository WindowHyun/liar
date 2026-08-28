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
var lastChatCount = -1;
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
  proposal: '투표 여부를 정하는 중입니다',
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
  } else if (m.code === 'turnSkipped' && m.who) {
    p.appendChild(who(m.who));
    p.appendChild(document.createTextNode('님이 설명 시간을 넘겼습니다.'));
  } else if (m.code === 'freeStart') {
    p.textContent = '설명이 모두 끝났습니다. 이제 자유롭게 이야기하세요. (1분)';
  } else if (m.code === 'votingStarted') {
    // 찬반을 거쳐 온 경우와, 자유 대화 시간이 다 돼서 그냥 넘어온 경우를 구분한다.
    p.textContent = m.byProposal === false
      ? '자유 대화 시간이 끝났습니다. 투표를 진행합니다.'
      : '투표를 진행합니다. (찬성 ' + m.agree + ' / 반대 ' + m.disagree + ')';
  } else if (m.code === 'proposalRejected') {
    p.textContent = '투표 제안이 부결되었습니다. (찬성 ' + m.agree + ' / 반대 ' + m.disagree + ') 설명을 이어가세요.';
  } else {
    p.textContent = m.text || '';
  }
  return p;
}

function renderChat(s) {
  if (s.chat.length === lastChatCount) return;
  var wasAtBottom = isChatAtBottom();
  lastChatCount = s.chat.length;

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
  if (s.phase === 'turn' && s.round && s.round.speaker) {
    return 't|' + s.round.speaker.id + '|' + s.round.spokenCount + '|' + s.round.speakTotal;
  }
  if (s.phase === 'free' && s.round) return 'f|' + s.round.spokenCount;
  if (!s.you || !s.you.inRound) return '';
  if (s.phase === 'proposal' && s.round && s.round.proposal) {
    var p = s.round.proposal;
    return 'p|' + p.agree + '|' + p.disagree + '|' + p.total + '|' + s.you.proposalAnswer;
  }
  if (s.phase === 'voting' && s.round) {
    return 'v|' + s.round.voted + '|' + s.round.total + '|' + s.you.hasVoted + '|' + s.round.roster.length;
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
    pill.className = 'pill' + (p.speaking ? ' now' : p.spoke ? ' done' : '');
    var em = document.createElement('span');
    em.className = 'em';
    em.textContent = p.speaking ? '🎙️' : p.spoke ? '✅' : '⏳';
    pill.appendChild(em);
    pill.appendChild(document.createTextNode(r.nickname));
    track.appendChild(pill);
  });
  return track;
}

function metaTurn(s) {
  return '남은 시간 ' + secondsLeft(s.round.speakEndsAt) + '초 · '
    + s.round.speakTotal + '명 중 ' + s.round.spokenCount + '명 설명함'
    + ' · 대화권은 1인 1회입니다';
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
  var w = document.createElement('span');
  w.className = 'who-hl';
  w.textContent = p.byName;
  text.appendChild(w);
  text.appendChild(document.createTextNode('님이 투표를 제안했습니다. 진행할까요?'));
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
    + ' · 찬성이 절반 이상이면 투표로 넘어갑니다';
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
    s.round.roster.filter(function (p) { return p.id !== myId; }).forEach(function (p) {
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
  } else {
    // 투표 버튼을 누른 순간(찬반)부터 결과가 날 때까지 대화를 막는다.
    hint = '투표가 끝날 때까지 대화할 수 없습니다';
  }

  input.disabled = locked;
  $('send-btn').disabled = locked;
  input.placeholder = hint;
  document.getElementById('composer').classList.toggle('my-turn', !locked && s.phase === 'turn');
}

function render(s) {
  state = s;
  if (s.you) myId = s.you.id;

  renderParticipants(s);
  renderTally(s);
  renderRoleCard(s);
  renderChat(s);
  renderLive(s);
  renderResult(s);

  var lobbyish = s.phase === 'lobby' || s.phase === 'result';
  $('start-btn').disabled = !s.canStart;
  $('start-btn').textContent = s.phase === 'result' ? '다음 라운드' : '게임 시작';
  $('start-btn').classList.toggle('hidden', !lobbyish);
  // 투표 제안은 자유 대화 때만. 설명이 끝나기 전에는 누를 수 없다.
  $('vote-btn').disabled = !(s.phase === 'free' && s.you && s.you.inRound);
  $('vote-btn').title = s.phase === 'turn' ? '설명이 끝나면 투표를 제안할 수 있습니다' : '투표 제안';

  applyComposer(s);

  if (s.phase !== 'lobby' && s.phase !== 'result' && s.you && !s.you.inRound) {
    showBanner('ok', '이미 시작된 판이라 이번 라운드는 관전합니다. 다음 라운드부터 참여합니다.');
  }

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

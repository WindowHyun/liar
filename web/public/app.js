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

var JUMP_TEXT = { proposal: '투표 여부를 정하는 중입니다', voting: '투표가 진행 중입니다', guess: '정답을 기다리는 중입니다' };
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
  } else if (m.code === 'votingStarted') {
    p.textContent = '투표를 진행합니다. (찬성 ' + m.agree + ' / 반대 ' + m.disagree + ')';
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

  if (s.phase === 'proposal' && s.round && s.round.proposal && s.you && s.you.inRound) {
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
  if (s.phase === 'proposal' && s.round.proposal) meta.textContent = metaProposal(s);
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
      ? LABELS.liar + '이 제시어를 맞혔습니다! ("' + r.guess + '")'
      : LABELS.liar + '이 제시어를 맞히지 못했습니다. ("' + r.guess + '")',
  };

  panel.classList.remove('hidden');
  panel.innerHTML = '';
  var headline = document.createElement('div');
  headline.className = 'headline';
  headline.textContent = r.winner === 'liar' ? LABELS.liar + ' 승리!' : '시민 팀 승리!';
  var detail = document.createElement('div');
  detail.className = 'detail';
  detail.textContent = (reasons[r.reason] || '') + ' · ' + LABELS.liar + '는 ' + r.liar.nickname
    + '님, 제시어는 "' + r.word + '"였습니다.';
  panel.appendChild(headline);
  panel.appendChild(detail);
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

  $('start-btn').disabled = !s.canStart;
  $('start-btn').textContent = s.phase === 'result' ? '다음 라운드' : '게임 시작';
  $('start-btn').classList.toggle('hidden', s.phase === 'playing' || s.phase === 'proposal' || s.phase === 'voting' || s.phase === 'guess');
  $('vote-btn').disabled = !(s.phase === 'playing' && s.you && s.you.inRound);

  // 대화는 투표·정답 단계에서만 잠긴다. 서버도 같은 규칙으로 막는다.
  var chatLocked = s.phase === 'voting' || s.phase === 'guess';
  $('chat-input').disabled = chatLocked;
  $('send-btn').disabled = chatLocked;

  if (s.phase !== 'lobby' && s.phase !== 'result' && s.you && !s.you.inRound) {
    showBanner('ok', '이미 시작된 판이라 이번 라운드는 관전합니다. 다음 라운드부터 참여합니다.');
  }

  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  if (s.phase === 'proposal' || s.phase === 'voting' || s.phase === 'guess') {
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

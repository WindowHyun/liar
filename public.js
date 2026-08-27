'use strict';

/**
 * 브라우저에 그대로 내려가는 화면.
 *
 * [P3-35] 위장용 문구(Slack / Oliveyoung)가 화면 곳곳에 10군데 넘게 흩어져 있어서
 * 용어 하나 바꾸려면 산탄총 수정이 됐다. 여기 LABELS 한 곳에 모아 두고 끼워 넣는다.
 */

const LABELS = {
  app: 'Slack',
  workspace: '워크스페이스',
  channel: '# Oliveyoung',
  liar: 'Oliveyoung',
};

const L = LABELS;

module.exports = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>${L.app}</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; font-family: -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", Arial, sans-serif; background:#F5F5F7; color:#1D1C1D; }
  .hidden { display:none !important; }

  #screen-join { max-width: 420px; margin: 80px auto; background:#fff; border:1px solid #E4E4E6; border-radius:10px; padding:32px; }
  #screen-join h1 { font-size:22px; margin:0 0 8px; }
  #screen-join p { font-size:14px; color:#616061; margin:0 0 16px; }
  #nickname-input { width:100%; height:38px; border:1px solid #D8D8DA; border-radius:6px; padding:0 12px; font-size:14px; margin-bottom:12px; }
  #join-btn { width:100%; height:40px; background:#3F0E40; color:#fff; border:none; border-radius:6px; font-size:14px; font-weight:700; cursor:pointer; }

  #screen-game { display:flex; height:100vh; }
  #sidebar { width:220px; background:#3F0E40; color:#fff; padding:20px 16px; flex-shrink:0; display:flex; flex-direction:column; }
  #sidebar h2 { font-size:15px; margin:0 0 4px; }
  #sidebar .sub { font-size:12px; color:#D1B3D6; margin:0 0 20px; }
  #sidebar .label { font-size:12px; color:#D1B3D6; margin:16px 0 6px; }
  #participant-list { list-style:none; padding:0; margin:0; font-size:14px; }
  #participant-list li { display:flex; align-items:center; gap:8px; padding:4px 0; }
  #participant-list .dot { width:8px; height:8px; border-radius:50%; background:#2BAC76; margin-left:auto; flex-shrink:0; }
  #participant-list .dot.stale { background:#9A7FA0; }
  #log-hint { margin-top:auto; padding-top:16px; font-size:11px; color:#B695BC; line-height:1.5; word-break:break-all; }

  #main { flex:1; display:flex; flex-direction:column; min-width:0; }
  #topbar { display:flex; align-items:center; justify-content:space-between; padding:12px 20px; border-bottom:1px solid #E4E4E6; background:#fff; }
  #topbar h2 { font-size:15px; margin:0; }
  #vote-btn { background:#FCEBEB; color:#791F1F; border:1px solid #F0C7C7; border-radius:14px; padding:6px 14px; font-size:13px; font-weight:700; cursor:pointer; }
  #vote-btn:disabled { opacity:0.5; cursor:default; }
  #desc-input:disabled, #send-btn:disabled, #start-btn:disabled { opacity:0.5; cursor:default; }

  #role-card { margin:14px 20px 0; padding:12px 16px; border-radius:8px; font-size:13px; }
  #role-card.citizen { background:#EAF3DE; color:#27500A; }
  #role-card.liar { background:#FCEBEB; color:#791F1F; }
  #role-card.pending { background:#EDEDF0; color:#5B5B60; }

  #chat { flex:1; overflow-y:auto; padding:14px 20px; }
  .msg { display:flex; gap:10px; margin-bottom:14px; }
  .msg .avatar { width:28px; height:28px; border-radius:6px; background:#7F77DD; color:#fff; font-size:11px; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
  .msg .name { font-size:13px; font-weight:700; }
  .msg .text { font-size:14px; margin-top:2px; }
  .sysmsg { font-size:12px; color:#8A8A8E; font-style:italic; margin-bottom:10px; }

  #composer { display:flex; gap:8px; padding:12px 20px; border-top:1px solid #E4E4E6; background:#fff; }
  #desc-input { flex:1; height:36px; border:1px solid #D8D8DA; border-radius:8px; padding:0 12px; font-size:13px; }
  #send-btn, #start-btn { height:36px; padding:0 14px; border:1px solid #D8D8DA; border-radius:8px; background:#fff; font-size:13px; cursor:pointer; }

  #vote-panel, #guess-panel, #result-panel { margin:14px 20px; padding:14px 16px; border-radius:8px; background:#fff; border:1px solid #E4E4E6; }
  #vote-panel button, #guess-panel button { margin:4px 6px 0 0; padding:6px 12px; border-radius:6px; border:1px solid #D8D8DA; background:#F5F5F7; cursor:pointer; font-size:13px; }
  #guess-panel input { height:34px; border:1px solid #D8D8DA; border-radius:6px; padding:0 10px; font-size:13px; margin-right:6px; }
  #result-panel { font-size:15px; font-weight:700; text-align:center; }
  #network-banner { font-size:13px; padding:8px 20px; text-align:center; }
  #network-banner.warn { background:#FCEBEB; color:#791F1F; }
  #network-banner.ok { background:#EAF3DE; color:#27500A; }
</style>
</head>
<body>

  <div id="screen-join">
    <h1>${L.app}</h1>
    <p>닉네임을 입력하고 접속하세요.</p>
    <input id="nickname-input" placeholder="닉네임" maxlength="24" />
    <button id="join-btn">접속</button>
    <p style="font-size:12px;color:#8A8A8E;margin-top:14px;">처음 실행할 때 Windows 방화벽 허용 팝업이 뜨면 반드시 "허용"을 눌러주세요. 취소하면 내 화면은 되는데 다른 사람에게는 내가 안 보일 수 있습니다.</p>
  </div>

  <div id="screen-game" class="hidden">
    <div id="sidebar">
      <h2>${L.app}</h2>
      <p class="sub">${L.workspace}</p>
      <p class="label">참가자 (내 화면 기준, 방금 켰다면 낮게 보일 수 있음)</p>
      <ul id="participant-list"></ul>
      <p id="log-hint"></p>
    </div>
    <div id="main">
      <div id="network-banner" class="hidden"></div>
      <div id="topbar">
        <h2>${L.channel}</h2>
        <button id="vote-btn" disabled>투표</button>
      </div>
      <div id="role-card" class="hidden"></div>
      <div id="chat"></div>
      <div id="vote-panel" class="hidden"></div>
      <div id="guess-panel" class="hidden">
        <p style="margin:0 0 8px;font-size:13px;">${L.liar}으로 지목되었습니다. 제시어를 맞히면 역전승합니다. (남은 시간: <span id="guess-timer">30</span>초)</p>
        <input id="guess-input" placeholder="제시어 입력" maxlength="60" />
        <button id="guess-btn">제출</button>
      </div>
      <div id="result-panel" class="hidden"></div>
      <div id="composer">
        <button id="start-btn">게임 시작</button>
        <input id="desc-input" placeholder="내 턴에 설명 입력..." maxlength="300" />
        <button id="send-btn">설명 전송</button>
      </div>
    </div>
  </div>

<script>
  var LIAR = ${JSON.stringify(L.liar)};

  var ws = null;
  var myId = null;
  var myNickname = '';
  var joined = false;
  var participants = [];
  var roundParticipants = []; // [수정 1] START에 실려 온, 이번 라운드로 고정된 명단
  var voteCountdownHandle = null;
  var guessCountdownHandle = null;
  var reconnectTimer = null;
  var reconnectDelay = 500;

  function $(id) { return document.getElementById(id); }

  // 상단 배너는 여러 곳에서 쓰므로 한 곳으로 모은다. 이전 자동 숨김 타이머를 반드시
  // 취소해야, 복구 배너가 사라지는 타이밍에 새로 뜬 경고까지 같이 지워지지 않는다.
  var bannerHideHandle = null;
  function showBanner(kind, text, autoHideMs) {
    var banner = $('network-banner');
    if (bannerHideHandle) { clearTimeout(bannerHideHandle); bannerHideHandle = null; }
    banner.className = kind;
    banner.textContent = text;
    banner.classList.remove('hidden');
    if (autoHideMs) {
      bannerHideHandle = setTimeout(function () { banner.classList.add('hidden'); bannerHideHandle = null; }, autoHideMs);
    }
  }
  function hideBanner() {
    if (bannerHideHandle) { clearTimeout(bannerHideHandle); bannerHideHandle = null; }
    $('network-banner').classList.add('hidden');
  }

  // [수정] 투표 후 채팅 제한 - 투표가 시작되면 잠그고, 라운드가 끝나거나 다음 라운드가
  // 시작될 때 다시 연다. [P2-19] 예전에는 다음 roundStart에서만 풀려서, 결과 화면부터
  // 다음 라운드까지 로직상 허용된 채팅이 화면에서만 막혀 있었다.
  function setChatEnabled(enabled) {
    $('desc-input').disabled = !enabled;
    $('send-btn').disabled = !enabled;
  }

  // ───────────────────────── 서버 연결 [P2-20 / P2-21] ─────────────────────────
  // 예전에는 onerror/onclose가 아예 없어서, 서버가 죽으면 아무 반응 없는 화면만 남았다.
  // 또 readyState를 보지 않고 send를 불러서 연결 전에 버튼을 누르면 예외가 났다.
  function connect() {
    ws = new WebSocket('ws://' + location.host);

    ws.onopen = function () {
      reconnectDelay = 500;
      hideBanner();
      if (joined && myNickname) send({ type: 'join', nickname: myNickname });
    };
    ws.onmessage = function (ev) {
      var state;
      try { state = JSON.parse(ev.data); } catch (err) { return; }
      try { handleState(state); } catch (err) {
        showBanner('warn', '화면 처리 중 오류가 발생했습니다: ' + err.message);
      }
    };
    ws.onclose = function () {
      showBanner('warn', '프로그램과의 연결이 끊어졌습니다. 다시 연결하는 중입니다...');
      scheduleReconnect();
    };
    ws.onerror = function () { /* 곧바로 onclose가 이어지므로 여기서는 따로 알리지 않는다 */ };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(function () { reconnectTimer = null; connect(); }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 5000);
  }

  function send(payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      showBanner('warn', '아직 프로그램과 연결되지 않았습니다. 잠시 후 다시 시도해 주세요.', 3000);
      return false;
    }
    ws.send(JSON.stringify(payload));
    return true;
  }

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
    send({ type: 'join', nickname: nickname });
  };

  $('start-btn').onclick = function () { send({ type: 'start' }); };
  $('vote-btn').onclick = function () { send({ type: 'callVote' }); };
  $('send-btn').onclick = function () {
    var text = $('desc-input').value.trim();
    if (!text) return;
    if (send({ type: 'desc', text: text })) $('desc-input').value = '';
  };
  $('guess-btn').onclick = function () {
    var word = $('guess-input').value.trim();
    if (!word) return;
    send({ type: 'guess', word: word });
  };

  // [이슈] 채팅 엔터키 안됨 - desc-input에 keydown 리스너 자체가 없었다. 닉네임/제시어
  // 입력창도 같이 눌러서 보내지도록 통일한다.
  $('nickname-input').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') $('join-btn').click(); });
  $('desc-input').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') $('send-btn').click(); });
  $('guess-input').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') $('guess-btn').click(); });

  $('vote-panel').addEventListener('click', function (ev) {
    var btn = ev.target.closest('button[data-id]');
    if (!btn) return;
    send({ type: 'vote', targetId: btn.dataset.id });
    $('vote-panel').classList.add('hidden');
  });

  function addSystemMessage(text) {
    var div = document.createElement('div');
    div.className = 'sysmsg';
    div.textContent = text;
    $('chat').appendChild(div);
    $('chat').scrollTop = $('chat').scrollHeight;
  }

  function addChatMessage(name, text) {
    var label = name || '(이름 없음)'; // [P2-24] 이름이 비어 있어도 화면이 멈추지 않게
    var wrap = document.createElement('div');
    wrap.className = 'msg';
    wrap.innerHTML = '<div class="avatar"></div><div><div class="name"></div><div class="text"></div></div>';
    wrap.querySelector('.avatar').textContent = label.slice(0, 2);
    wrap.querySelector('.name').textContent = label;
    wrap.querySelector('.text').textContent = text == null ? '' : text;
    $('chat').appendChild(wrap);
    $('chat').scrollTop = $('chat').scrollHeight;
  }

  // [P2-26] 하트비트가 끊긴 사람은 점 색을 흐리게 해서, "온라인 N명"이 어디까지나
  // 내 화면 기준 추정치라는 걸 눈으로도 알 수 있게 한다.
  function renderParticipants() {
    $('participant-list').innerHTML = '';
    participants.forEach(function (p) {
      var li = document.createElement('li');
      li.textContent = p.nickname || '(이름 없음)';
      var dot = document.createElement('span');
      dot.className = p.stale ? 'dot stale' : 'dot';
      dot.title = p.stale ? '최근 신호가 끊겼습니다' : '온라인';
      li.appendChild(dot);
      $('participant-list').appendChild(li);
    });
  }

  function clearCountdowns() {
    if (voteCountdownHandle) { clearInterval(voteCountdownHandle); voteCountdownHandle = null; }
    if (guessCountdownHandle) { clearInterval(guessCountdownHandle); guessCountdownHandle = null; }
  }

  function startCountdown(elementId, totalSeconds, onDone) {
    var remaining = totalSeconds;
    return setInterval(function () {
      remaining -= 1;
      var el = $(elementId);
      if (el) el.textContent = Math.max(remaining, 0);
      if (remaining <= 0 && onDone) onDone();
    }, 1000);
  }

  function showRoleCard(category, word, isLiar) {
    var card = $('role-card');
    card.classList.remove('hidden');
    if (isLiar) {
      card.className = 'liar';
      card.textContent = '당신은 ' + LIAR + '입니다. 카테고리: ' + category + ' (제시어는 모릅니다)';
    } else {
      card.className = 'citizen';
      card.textContent = '카테고리: ' + category + ' / 제시어: ' + word;
    }
  }

  function renderVotePanel(durationMs, voted, total) {
    var panel = $('vote-panel');
    panel.classList.remove('hidden');
    var totalSeconds = Math.round((durationMs || 30000) / 1000);
    panel.innerHTML = '<p style="margin:0 0 8px;font-size:13px;">' + LIAR +
      '이라고 생각하는 사람에게 투표하세요. (남은 시간: <span id="vote-timer">' + totalSeconds +
      '</span>초 · <span id="vote-count">' + (voted || 0) + '/' + (total || 0) + '</span>명 투표함)</p>';
    roundParticipants.filter(function (p) { return p.id !== myId; }).forEach(function (p) {
      var btn = document.createElement('button');
      btn.dataset.id = p.id;
      btn.textContent = p.nickname;
      panel.appendChild(btn);
    });
    clearCountdowns();
    voteCountdownHandle = startCountdown('vote-timer', totalSeconds, function () {
      clearInterval(voteCountdownHandle); voteCountdownHandle = null;
    });
  }

  // [P2-20] 새로고침하거나 잠깐 끊겼다 붙었을 때, 그동안의 이벤트를 놓쳐 화면이 빈 채로
  // 남지 않도록 현재 상태를 한 번에 받아 그린다.
  function applySnapshot(state) {
    if (state.joined) {
      joined = true;
      myNickname = state.nickname || myNickname;
      enterGameScreen();
    }
    participants = state.participants || [];
    renderParticipants();

    var round = state.round;
    $('vote-btn').disabled = !round;
    $('start-btn').classList.toggle('hidden', !!round);
    $('vote-panel').classList.add('hidden');
    $('guess-panel').classList.add('hidden');

    // 채팅은 투표 중에만 잠긴다. 로비(라운드 없음)에서는 열려 있어야 한다.
    setChatEnabled(!(round && round.votingOpen));

    if (!round) return;

    roundParticipants = round.participants || [];
    $('vote-btn').disabled = round.votingOpen || round.voteClosed;

    if (state.role) showRoleCard(state.role.category, state.role.word, state.role.isLiar);
    else {
      var card = $('role-card');
      card.className = 'pending';
      card.textContent = '역할을 받는 중입니다...';
      card.classList.remove('hidden');
    }

    if (round.votingOpen) renderVotePanel(30000, round.voted, round.total);
    if (round.awaitingGuessFrom && round.awaitingGuessFrom === myId) $('guess-panel').classList.remove('hidden');
  }

  function handleState(state) {
    switch (state.type) {
      case 'me':
        myId = state.id;
        // [P2-27] 문제가 생겼을 때 사용자가 스스로 확인할 수 있게 로그 파일 위치를 알려준다.
        if (state.logPath) $('log-hint').textContent = '문제 발생 시 로그: ' + state.logPath;
        break;
      case 'snapshot':
        applySnapshot(state);
        break;
      case 'participants':
        participants = state.list;
        renderParticipants();
        break;
      case 'rolePending': {
        // [P0-3] 새 라운드가 시작되면 이전 라운드의 역할·제시어를 화면에서 반드시 지운다.
        // 안 지우면 제시어가 유실됐을 때 지난 라운드 제시어를 그대로 믿고 게임하게 된다.
        var card = $('role-card');
        card.className = 'pending';
        card.textContent = '역할을 받는 중입니다...';
        card.classList.remove('hidden');
        break;
      }
      case 'roleMissing':
        // [P0-3] 제시어가 끝내 안 왔다. 조용히 "제시어 없는 시민"으로 두지 않는다.
        showBanner('warn', '제시어를 받지 못했습니다. 게임을 시작한 사람에게 다시 시작해 달라고 알려주세요.');
        $('role-card').textContent = '제시어를 받지 못했습니다.';
        break;
      case 'wordDeliveryFailed':
        // [P0-3] 호스트 화면: 특정 참가자에게 제시어가 전달되지 않았다.
        showBanner('warn', (state.name || state.id) + '님에게 제시어를 전달하지 못했습니다. 그분은 이번 라운드를 진행할 수 없습니다.');
        break;
      case 'startRejected':
        // [P1-6] 왜 시작이 안 됐는지 알려준다. 예전에는 버튼을 눌러도 아무 일이 없었다.
        if (state.reason === 'tooFewPlayers') {
          showBanner('warn', '게임을 시작하려면 최소 ' + state.need + '명이 필요합니다. (현재 ' + state.have + '명)', 5000);
        } else {
          showBanner('warn', '이미 게임이 진행 중입니다.', 4000);
        }
        break;
      case 'roundStart':
        addSystemMessage('게임이 시작되었습니다.');
        roundParticipants = state.participants || [];
        $('vote-panel').classList.add('hidden');
        $('guess-panel').classList.add('hidden');
        $('result-panel').classList.add('hidden');
        $('vote-btn').disabled = false;
        $('start-btn').classList.add('hidden'); // [수정] 게임 시작 후 시작 버튼 숨김
        setChatEnabled(true);
        clearCountdowns();
        break;
      case 'word':
        showRoleCard(state.category, state.word, state.isLiar);
        break;
      case 'description':
        addChatMessage(state.name, state.text);
        break;
      case 'voteStart':
        $('vote-btn').disabled = true;
        setChatEnabled(false); // [수정] 투표 후 채팅 제한
        renderVotePanel(state.durationMs, 0, roundParticipants.length);
        break;
      case 'vote': {
        // 정족수(전원 투표)로 기다리는 구조라, 누가 아직 안 했는지 보이지 않으면
        // 다들 무작정 기다리게 된다.
        var counter = $('vote-count');
        if (counter) counter.textContent = state.voted + '/' + state.total;
        break;
      }
      case 'accused':
        addSystemMessage((state.name || '알 수 없는 참가자') + '님이 ' + LIAR + '으로 지목되었습니다.');
        break;
      case 'awaitGuess':
        $('vote-panel').classList.add('hidden');
        clearCountdowns();
        if (state.accusedId === myId) {
          $('guess-panel').classList.remove('hidden');
          var seconds = Math.round((state.durationMs || 30000) / 1000);
          var timer = $('guess-timer');
          if (timer) timer.textContent = seconds;
          guessCountdownHandle = startCountdown('guess-timer', seconds, function () {
            clearInterval(guessCountdownHandle); guessCountdownHandle = null;
          });
        } else {
          addSystemMessage(LIAR + '이 제시어를 맞혀볼 기회를 기다리는 중...');
        }
        break;
      case 'result': {
        $('vote-panel').classList.add('hidden');
        $('guess-panel').classList.add('hidden');
        $('start-btn').classList.remove('hidden'); // [수정] 다음 라운드를 시작할 수 있게 다시 노출
        $('vote-btn').disabled = true; // [이슈2] 라운드가 끝났으니 다음 게임 시작 전까지 투표 불가
        setChatEnabled(true);          // [P2-19] 라운드가 끝나면 채팅은 다시 열린다
        clearCountdowns();
        var panel = $('result-panel');
        panel.classList.remove('hidden');
        var labels = {
          hostLeft: '게임을 시작한 사람의 접속이 끊겨 라운드가 취소되었습니다.',
          noReveal: '지목된 사람이 응답하지 않아 라운드가 취소되었습니다.',
          guessTimeout: LIAR + '이 제한 시간 안에 제시어를 맞히지 못했습니다.',
          tie: '투표가 동점이었습니다.',
          noVotes: '제한 시간 안에 아무도 투표하지 않았습니다.',
          wrongAccusation: '지목된 사람은 ' + LIAR + '이 아니었습니다.',
          guess: state.winner === 'liar'
            ? LIAR + '이 제시어를 맞혔습니다! ("' + state.guess + '")'
            : LIAR + '이 제시어를 맞히지 못했습니다. ("' + state.guess + '")',
        };
        var prefix = state.winner === 'liar' ? LIAR + ' 승리! '
          : state.winner === 'citizens' ? '시민 팀 승리! '
          : ''; // winner 'none' - 승패 없이 끝난 라운드
        panel.textContent = prefix + (labels[state.reason] || '');
        break;
      }
      case 'networkIssue': {
        var detail = state.detail || {};
        if (detail.type === 'receiveLost') {
          showBanner('warn', '네트워크 수신에 문제가 생겨 다시 연결하는 중입니다. 다른 참가자 화면에 내가 안 보일 수 있어요.');
        } else if (detail.type === 'receiveRecovered') {
          showBanner('ok', '네트워크 수신 기능이 복구되었습니다.', 4000);
        } else if (detail.type === 'versionMismatch') {
          showBanner('warn', '다른 참가자와 프로그램 버전이 다릅니다(상대 v' + detail.peerVersion + ' / 나 v' + detail.myVersion + '). 모두 같은 파일로 다시 받아주세요.');
        } else if (detail.type === 'deliveryFailed') {
          showBanner('warn', '일부 참가자에게 메시지가 전달되지 않았습니다(' + (detail.targetIp || '') + '). 그 사람 화면은 나와 다를 수 있어요.');
        } else if (detail.type === 'handlerError') {
          showBanner('warn', '메시지 처리 중 오류가 발생했습니다(' + (detail.messageType || '') + '). 로그를 확인해 주세요.');
        }
        // 처리할 수 없는 진단은 배너를 건드리지 않는다 - 빈 배너가 뜨지 않게.
        break;
      }
    }
  }

  connect();
</script>
</body>
</html>
`;

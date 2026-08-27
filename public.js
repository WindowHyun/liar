'use strict';

module.exports = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>Slack</title>
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
  #sidebar { width:220px; background:#3F0E40; color:#fff; padding:20px 16px; flex-shrink:0; }
  #sidebar h2 { font-size:15px; margin:0 0 4px; }
  #sidebar .sub { font-size:12px; color:#D1B3D6; margin:0 0 20px; }
  #sidebar .label { font-size:12px; color:#D1B3D6; margin:16px 0 6px; }
  #participant-list { list-style:none; padding:0; margin:0; font-size:14px; }
  #participant-list li { display:flex; align-items:center; gap:8px; padding:4px 0; }
  #participant-list .dot { width:8px; height:8px; border-radius:50%; background:#2BAC76; margin-left:auto; }

  #main { flex:1; display:flex; flex-direction:column; min-width:0; }
  #topbar { display:flex; align-items:center; justify-content:space-between; padding:12px 20px; border-bottom:1px solid #E4E4E6; background:#fff; }
  #topbar h2 { font-size:15px; margin:0; }
  #vote-btn { background:#FCEBEB; color:#791F1F; border:1px solid #F0C7C7; border-radius:14px; padding:6px 14px; font-size:13px; font-weight:700; cursor:pointer; }
  #vote-btn:disabled { opacity:0.5; cursor:default; }
  #desc-input:disabled, #send-btn:disabled { opacity:0.5; cursor:default; }

  #role-card { margin:14px 20px 0; padding:12px 16px; border-radius:8px; font-size:13px; }
  #role-card.citizen { background:#EAF3DE; color:#27500A; }
  #role-card.liar { background:#FCEBEB; color:#791F1F; }

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
    <h1>Slack</h1>
    <p>닉네임을 입력하고 접속하세요.</p>
    <input id="nickname-input" placeholder="닉네임" />
    <button id="join-btn">접속</button>
    <p style="font-size:12px;color:#8A8A8E;margin-top:14px;">처음 실행할 때 Windows 방화벽 허용 팝업이 뜨면 반드시 "허용"을 눌러주세요. 취소하면 내 화면은 되는데 다른 사람에게는 내가 안 보일 수 있습니다.</p>
  </div>

  <div id="screen-game" class="hidden">
    <div id="sidebar">
      <h2>Slack</h2>
      <p class="sub">워크스페이스</p>
      <p class="label">참가자 (내 화면 기준, 방금 켰다면 낮게 보일 수 있음)</p>
      <ul id="participant-list"></ul>
    </div>
    <div id="main">
      <div id="network-banner" class="hidden"></div>
      <div id="topbar">
        <h2># Oliveyoung</h2>
        <button id="vote-btn" disabled>투표</button>
      </div>
      <div id="role-card" class="hidden"></div>
      <div id="chat"></div>
      <div id="vote-panel" class="hidden"></div>
      <div id="guess-panel" class="hidden">
        <p style="margin:0 0 8px;font-size:13px;">Oliveyoung으로 지목되었습니다. 제시어를 맞히면 역전승합니다.</p>
        <input id="guess-input" placeholder="제시어 입력" />
        <button id="guess-btn">제출</button>
      </div>
      <div id="result-panel" class="hidden"></div>
      <div id="composer">
        <button id="start-btn">게임 시작</button>
        <input id="desc-input" placeholder="내 턴에 설명 입력..." />
        <button id="send-btn">설명 전송</button>
      </div>
    </div>
  </div>

<script>
  let ws;
  let myId = null;
  let participants = [];
  let roundParticipants = []; // [수정 1] 서버가 START에 실어 보낸, 이번 라운드로 고정된 명단
  let voteCountdownHandle = null;

  function $(id) { return document.getElementById(id); }

  // [수정] 투표 후 채팅 제한 - 투표가 시작되면 잠그고, 다음 라운드가 시작될 때만 다시 연다.
  function setChatEnabled(enabled) {
    $('desc-input').disabled = !enabled;
    $('send-btn').disabled = !enabled;
  }

  $('join-btn').onclick = () => {
    const nickname = $('nickname-input').value.trim();
    if (!nickname) return;
    ws = new WebSocket('ws://' + location.host);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'join', nickname }));
    ws.onmessage = (ev) => handleState(JSON.parse(ev.data));
    $('screen-join').classList.add('hidden');
    $('screen-game').classList.remove('hidden');
  };

  $('start-btn').onclick = () => ws.send(JSON.stringify({ type: 'start' }));
  $('vote-btn').onclick = () => ws.send(JSON.stringify({ type: 'callVote' }));
  $('send-btn').onclick = () => {
    const text = $('desc-input').value.trim();
    if (!text) return;
    ws.send(JSON.stringify({ type: 'desc', text }));
    $('desc-input').value = '';
  };
  $('guess-btn').onclick = () => {
    const word = $('guess-input').value.trim();
    if (!word) return;
    ws.send(JSON.stringify({ type: 'guess', word }));
  };

  // [이슈] 채팅 엔터키 안됨 - desc-input에 keydown 리스너 자체가 없었다. 닉네임/제시어
  // 입력창도 같이 눌러서 보내지도록 통일한다.
  $('nickname-input').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') $('join-btn').click(); });
  $('desc-input').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') $('send-btn').click(); });
  $('guess-input').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') $('guess-btn').click(); });

  $('vote-panel').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-id]');
    if (!btn) return;
    ws.send(JSON.stringify({ type: 'vote', targetId: btn.dataset.id }));
    $('vote-panel').classList.add('hidden');
  });

  function addSystemMessage(text) {
    const div = document.createElement('div');
    div.className = 'sysmsg';
    div.textContent = text;
    $('chat').appendChild(div);
    $('chat').scrollTop = $('chat').scrollHeight;
  }

  function addChatMessage(name, text) {
    const wrap = document.createElement('div');
    wrap.className = 'msg';
    wrap.innerHTML = '<div class="avatar"></div><div><div class="name"></div><div class="text"></div></div>';
    wrap.querySelector('.avatar').textContent = name.slice(0, 2);
    wrap.querySelector('.name').textContent = name;
    wrap.querySelector('.text').textContent = text;
    $('chat').appendChild(wrap);
    $('chat').scrollTop = $('chat').scrollHeight;
  }

  function renderParticipants() {
    $('participant-list').innerHTML = '';
    participants.forEach((p) => {
      const li = document.createElement('li');
      li.textContent = p.nickname;
      const dot = document.createElement('span');
      dot.className = 'dot';
      li.appendChild(dot);
      $('participant-list').appendChild(li);
    });
  }

  function handleState(state) {
    switch (state.type) {
      case 'me':
        myId = state.id;
        break;
      case 'participants':
        participants = state.list;
        renderParticipants();
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
        if (voteCountdownHandle) { clearInterval(voteCountdownHandle); voteCountdownHandle = null; }
        break;
      case 'word': {
        const card = $('role-card');
        card.classList.remove('hidden');
        if (state.isLiar) {
          card.className = 'liar';
          card.textContent = '당신은 Oliveyoung입니다. 카테고리: ' + state.category + ' (제시어는 모릅니다)';
        } else {
          card.className = 'citizen';
          card.textContent = '카테고리: ' + state.category + ' / 제시어: ' + state.word;
        }
        break;
      }
      case 'description':
        addChatMessage(state.name, state.text);
        break;
      case 'voteStart': {
        $('vote-btn').disabled = true;
        setChatEnabled(false); // [수정] 투표 후 채팅 제한
        const panel = $('vote-panel');
        panel.classList.remove('hidden');
        const totalSeconds = Math.round((state.durationMs || 30000) / 1000);
        panel.innerHTML = '<p style="margin:0 0 8px;font-size:13px;">Oliveyoung이라고 생각하는 사람에게 투표하세요. (남은 시간: <span id="vote-timer">' + totalSeconds + '</span>초)</p>';
        roundParticipants.filter((p) => p.id !== myId).forEach((p) => {
          const btn = document.createElement('button');
          btn.dataset.id = p.id;
          btn.textContent = p.nickname;
          panel.appendChild(btn);
        });
        if (voteCountdownHandle) clearInterval(voteCountdownHandle);
        let remaining = totalSeconds;
        voteCountdownHandle = setInterval(() => {
          remaining -= 1;
          const timerEl = $('vote-timer');
          if (timerEl) timerEl.textContent = Math.max(remaining, 0);
          if (remaining <= 0) { clearInterval(voteCountdownHandle); voteCountdownHandle = null; }
        }, 1000);
        break;
      }
      case 'accused':
        addSystemMessage(state.name + '님이 Oliveyoung으로 지목되었습니다.');
        break;
      case 'awaitGuess':
        $('vote-panel').classList.add('hidden');
        if (state.accusedId === myId) $('guess-panel').classList.remove('hidden');
        else addSystemMessage('Oliveyoung이 제시어를 맞혀볼 기회를 기다리는 중...');
        break;
      case 'result': {
        $('vote-panel').classList.add('hidden');
        $('guess-panel').classList.add('hidden');
        $('start-btn').classList.remove('hidden'); // [수정] 다음 라운드를 시작할 수 있게 다시 노출
        $('vote-btn').disabled = true; // [이슈2] 라운드가 끝났으니 다음 게임 시작 전까지 투표 불가
        if (voteCountdownHandle) { clearInterval(voteCountdownHandle); voteCountdownHandle = null; }
        const panel = $('result-panel');
        panel.classList.remove('hidden');
        const labels = {
          tie: '투표가 동점이었습니다.',
          noVotes: '제한 시간 안에 아무도 투표하지 않았습니다.',
          wrongAccusation: '지목된 사람은 Oliveyoung이 아니었습니다.',
          guess: state.winner === 'liar'
            ? 'Oliveyoung이 제시어를 맞혔습니다! ("' + state.guess + '")'
            : 'Oliveyoung이 제시어를 맞히지 못했습니다. ("' + state.guess + '")',
        };
        panel.textContent = (state.winner === 'liar' ? 'Oliveyoung 승리! ' : '시민 팀 승리! ') + (labels[state.reason] || '');
        break;
      }
      case 'networkIssue': {
        const banner = $('network-banner');
        const detail = state.detail || {};
        banner.classList.remove('hidden');
        if (detail.type === 'receiveLost') {
          banner.className = 'warn';
          banner.textContent = '네트워크 수신에 문제가 생겨 다시 연결하는 중입니다. 다른 참가자 화면에 내가 안 보일 수 있어요.';
        } else if (detail.type === 'receiveRecovered') {
          banner.className = 'ok';
          banner.textContent = '네트워크 수신 기능이 복구되었습니다.';
          setTimeout(() => banner.classList.add('hidden'), 4000);
        } else if (detail.type === 'versionMismatch') {
          banner.className = 'warn';
          banner.textContent = '다른 참가자와 프로그램 버전이 다른 것 같습니다. 모두 같은 파일로 다시 받아주세요.';
        }
        break;
      }
    }
  }
</script>
</body>
</html>
`;

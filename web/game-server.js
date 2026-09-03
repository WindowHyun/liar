'use strict';

/**
 * 게임 서버를 "켰다 껐다 할 수 있는 물건"으로 만들어 준다.
 *
 * 웹 버전에서는 한 번 켜면 끝이라 굳이 필요 없었지만, Electron 버전에서는 LAN에서
 * 뽑힌 호스트만 이걸 켜고, 호스트가 바뀌면 껐다가 다른 PC가 켠다. 그래서 시작·중지가
 * 되는 형태로 분리했다.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { createRoom } = require('./room');
const { validateClientMessage } = require('./protocol');
const { log, warn, error } = require('../logger');

const PUBLIC_DIR = path.join(__dirname, 'public');

// [S-2] 한 사람이 보낼 수 있는 요청 수 제한. 악의가 아니라 화면 쪽 버그로도
// 무한 루프가 돌 수 있다. 넉넉하게 잡되 폭주는 끊는다.
const RATE_WINDOW_MS = 5000;
const RATE_MAX = 60;

// [E-3] 연결 유지 확인. 두 가지를 한꺼번에 해결한다.
//   1) 사내망 방화벽/프록시는 조용한 TCP 연결을 1분 안팎에 끊어 버린다. 이 게임은
//      남의 설명을 듣는 60초 동안 아무 데이터도 오가지 않아서 딱 그 시간에 끊겼다.
//   2) 반쯤 죽은 연결(전원이 나갔거나 케이블이 빠진)은 close 이벤트가 몇 분씩 안 온다.
//      그동안 그 사람 자리를 계속 기다리게 된다.
const PING_MS = 25000;
const PONG_GRACE = 2; // 이 횟수만큼 응답이 없으면 죽은 연결로 본다
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
};

function createGameServer(options) {
  const opts = options || {};
  const port = opts.port;
  const bindHost = opts.host || '0.0.0.0';
  const pingMs = opts.pingMs || PING_MS; // 테스트에서 짧게 잡으려고 주입받는다

  const clients = new Set(); // { ws, playerId }
  let server = null;
  let wss = null;
  let room = null;
  let pingTimer = null;

  function sendTo(ws, payload) {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch (err) {
      warn(`[전송 실패] ${err.message}`);
    }
  }

  /** 상태가 바뀌면 접속자 각각에게 "그 사람 몫으로 걸러낸" 전체 상태를 다시 보낸다. */
  function broadcastState() {
    if (!room) return;
    for (const client of clients) {
      if (!client.playerId) continue;
      sendTo(client.ws, room.stateFor(client.playerId));
    }
  }

  function handleHttp(req, res) {
    const requested = (req.url || '/').split('?')[0];
    const name = requested === '/' ? 'index.html' : path.basename(requested);
    const file = path.join(PUBLIC_DIR, name);

    // basename으로 잘라 냈으므로 상위 디렉터리로는 못 나간다.
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('없는 파일입니다.');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(name)] || 'application/octet-stream',
        // 화면을 고친 뒤에도 브라우저가 옛 파일을 들고 있으면 "나만 안 되는" 상황이 된다.
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
  }

  /**
   * [E-3] 25초마다 살아 있는지 묻는다. 조용한 연결이 방화벽에 끊기는 것을 막고,
   * 이미 죽은 연결은 여기서 걸러 낸다(close를 기다리면 몇 분씩 걸린다).
   */
  function startHeartbeat() {
    pingTimer = setInterval(() => {
      for (const client of clients) {
        if (client.missedPongs >= PONG_GRACE) {
          warn(`[연결 끊김] ${client.playerId || '미참가'} 응답이 없어 정리합니다`);
          try { client.ws.terminate(); } catch { /* 이미 닫힘 */ }
          continue;
        }
        client.missedPongs += 1;
        try { client.ws.ping(); } catch { /* 이미 닫힘 */ }
      }
    }, pingMs);
    // 이 타이머 때문에 프로세스가 안 죽는 일이 없게 한다.
    if (typeof pingTimer.unref === 'function') pingTimer.unref();
  }

  function handleConnection(ws) {
    const client = { ws, playerId: null, windowStart: 0, count: 0, missedPongs: 0 };
    clients.add(client);

    // 듣는 사람이 없으면 소켓 오류 하나로 프로세스 전체가 죽는다.
    ws.on('error', (err) => { warn(`[연결 오류] ${err.message}`); });
    ws.on('pong', () => { client.missedPongs = 0; });
    ws.on('close', () => {
      clients.delete(client);
      // stop() 중이면 room은 이미 없다. 호스트가 물러나면서 서버를 내릴 때 이 경로가
      // 반드시 지나가므로, 여기서 null을 참조하면 인계 때마다 프로세스가 죽는다.
      if (room && client.playerId) room.disconnect(client.playerId);
    });

    ws.on('message', (raw) => {
      // [E-3] 여기서 예외가 나면 ws가 그대로 위로 던져 프로세스가 죽는다. 그러면 요청을
      // 보낸 한 사람이 아니라 접속자 전원이 동시에 튕긴다. 한 번의 잘못된 요청이
      // 판 전체를 날리지 않도록 여기서 잡는다.
      try {
        handleMessage(client, ws, raw);
      } catch (err) {
        error(`[요청 처리 실패] ${client.playerId || '미참가'} ${err && err.stack ? err.stack : err}`);
        sendTo(ws, { type: 'error', message: '요청을 처리하지 못했습니다. 다시 시도해 주세요.' });
      }
    });
  }

  function handleMessage(client, ws, raw) {
    // 서버를 내리는 중이면 방이 이미 없다(호스트를 넘길 때 이 경로를 지난다).
    if (!room) return;

    // [S-2] 창 하나가 서버를 독차지하지 못하게 한다.
    const now = Date.now();
    if (now - client.windowStart > RATE_WINDOW_MS) {
      client.windowStart = now;
      client.count = 0;
    }
    client.count += 1;
    if (client.count > RATE_MAX) {
      if (client.count === RATE_MAX + 1) {
        warn(`[속도 제한] ${client.playerId || '미참가'} 연결이 너무 많이 보냅니다 - 잠시 무시합니다`);
        sendTo(ws, { type: 'error', message: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' });
      }
      return;
    }

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const invalid = validateClientMessage(msg);
    if (invalid) {
      warn(`[요청 무시] ${invalid}`);
      sendTo(ws, { type: 'error', message: '잘못된 요청입니다.' });
      return;
    }

    // [E-3] 화면 쪽 확인. 브라우저는 WebSocket ping 프레임을 자바스크립트로 볼 수
    // 없어서, 화면이 스스로 살아 있는지 확인하려면 이렇게 주고받아야 한다.
    if (msg.type === 'ping') { sendTo(ws, { type: 'pong' }); return; }

    if (msg.type === 'join') {
      // 한 연결이 참가를 두 번 보내면 앞서 잡았던 자리가 주인 없이 남는다. 연결이
      // 끊길 때 정리되는 건 마지막 자리 하나뿐이라, 앞 자리는 "접속 중"인 채로
      // 영영 목록에 남아 인원수와 시작 조건까지 어긋나게 만든다.
      if (client.playerId) room.disconnect(client.playerId);
      const joined = room.join({ nickname: msg.nickname, token: msg.token });
      // 정원이 찬 경우. 자리를 잡지 못했으므로 playerId를 붙이지 않는다.
      if (joined.error) {
        warn(`[참가 거절] ${joined.error}`);
        sendTo(ws, { type: 'error', message: joined.error });
        return;
      }
      client.playerId = joined.playerId;
      // 토큰은 브라우저가 저장해 두었다가 새로고침·재접속 때 같은 자리로 돌아오는 데 쓴다.
      sendTo(ws, { type: 'welcome', playerId: joined.playerId, token: joined.token });
      sendTo(ws, room.stateFor(joined.playerId));
      log(`[참가] ${joined.restored ? '재접속' : '신규'} ${joined.playerId}`);
      return;
    }

    if (!client.playerId) {
      sendTo(ws, { type: 'error', message: '먼저 닉네임을 입력하고 접속해 주세요.' });
      return;
    }

    // 나가기는 "돌아오지 않는다"는 선언이라 자리를 남기지 않는다. 소켓이 끊겨서
    // 사라지는 것(disconnect)과 달리 10초 유예도 주지 않는다.
    if (msg.type === 'leave') {
      const goneId = client.playerId;
      client.playerId = null;
      room.leave(goneId);
      log(`[퇴장] ${goneId}`);
      return;
    }

    let reason = null;
    if (msg.type === 'start') reason = room.start();
    else if (msg.type === 'chat') reason = room.say(client.playerId, msg.text);
    else if (msg.type === 'callVote') reason = room.callVote(client.playerId);
    else if (msg.type === 'proposalVote') reason = room.respondProposal(client.playerId, msg.agree);
    else if (msg.type === 'vote') reason = room.vote(client.playerId, msg.targetId);
    else if (msg.type === 'guess') reason = room.guess(client.playerId, msg.word);

    // 거절 사유는 요청한 사람에게만 알린다. 눌러도 아무 일이 없으면 원인을 알 수 없다.
    if (reason) sendTo(ws, { type: 'error', message: reason });
  }

  /**
   * [S-1] Origin 검사. 브라우저가 보내는 Origin만 본다.
   *   - 브라우저 버전: 이 서버가 내려준 페이지 → 이 서버의 주소
   *   - Electron 버전: 로컬 화면 서버 → http://127.0.0.1:<포트>
   *   - Node 클라이언트(테스트 등)는 Origin을 안 보내므로 통과시킨다
   */
  function allowOrigin(info) {
    const origin = info.origin;
    if (!origin) return true; // 브라우저가 아닌 클라이언트
    if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return true;
    // 같은 LAN에서 이 서버 주소로 직접 들어온 경우
    if (/^https?:\/\/\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(origin)) return true;
    warn(`[접속 거절] 허용되지 않은 출처: ${origin}`);
    return false;
  }

  function start() {
    return new Promise((resolve, reject) => {
      if (server) { resolve(); return; }

      // 규칙 타이머(설명 시간 초과, 투표 마감 등)에서 예외가 나도 프로세스가 죽지
      // 않게 감싼다. 죽으면 접속자 전원이 동시에 튕긴다.
      const guardedTimer = (fn, ms) => setTimeout(() => {
        try { fn(); } catch (err) {
          error(`[진행 처리 실패] ${err && err.stack ? err.stack : err}`);
        }
      }, ms);
      room = createRoom({ onChange: broadcastState, setTimer: guardedTimer });
      startHeartbeat();
      server = http.createServer(handleHttp);
      // [S-1] 이 서버는 자기가 내려준 화면(같은 출처)이나 Electron 창(로컬 출처)만
      // 상대한다. 참가자가 열어 둔 아무 웹페이지가 붙어 오는 것(CSWSH)을 막는다.
      // [M3] 기본값이 100MB다. 이 게임이 주고받는 가장 큰 메시지는 300자 채팅이라
      // 그만한 프레임을 받아 줄 이유가 없다. 화면 쪽 버그 하나로 서버 메모리가
      // 통째로 물리는 일을 막는다.
      wss = new WebSocketServer({ server, verifyClient: allowOrigin, maxPayload: 16 * 1024 });
      wss.on('connection', handleConnection);

      // ws는 http 서버의 error를 WebSocketServer로도 다시 올린다. 한쪽만 들으면
      // 나머지 한쪽이 "듣는 사람 없는 error"가 되어 결국 스택 트레이스로 죽는다.
      let settled = false;
      const onError = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };
      server.on('error', onError);
      wss.on('error', onError);

      server.listen(port, bindHost, () => {
        if (settled) return;
        settled = true;
        log(`[서버 시작] 포트 ${port} (${bindHost})`);
        resolve();
      });
    });
  }

  function cleanup() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    for (const client of clients) {
      try { client.ws.terminate(); } catch { /* 이미 끊김 */ }
    }
    clients.clear();
    if (wss) { try { wss.close(); } catch { /* 무시 */ } wss = null; }
    if (server) { try { server.close(); } catch { /* 무시 */ } server = null; }
    room = null;
  }

  function stop() {
    return new Promise((resolve) => {
      if (!server) { resolve(); return; }
      log('[서버 중지]');
      cleanup();
      // 소켓이 완전히 닫힐 틈을 준다. 같은 포트를 바로 다시 열 수 있어야 한다.
      setTimeout(resolve, 100);
    });
  }

  return {
    start,
    stop,
    port,
    isRunning: () => server !== null,
    playerCount: () => [...clients].filter((c) => c.playerId).length,
  };
}

module.exports = { createGameServer };

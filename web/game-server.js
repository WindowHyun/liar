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
const { log, warn } = require('../logger');

const PUBLIC_DIR = path.join(__dirname, 'public');

// [S-2] 한 사람이 보낼 수 있는 요청 수 제한. 악의가 아니라 화면 쪽 버그로도
// 무한 루프가 돌 수 있다. 넉넉하게 잡되 폭주는 끊는다.
const RATE_WINDOW_MS = 5000;
const RATE_MAX = 60;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function createGameServer(options) {
  const opts = options || {};
  const port = opts.port;
  const bindHost = opts.host || '0.0.0.0';

  const clients = new Set(); // { ws, playerId }
  let server = null;
  let wss = null;
  let room = null;

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

  function handleConnection(ws) {
    const client = { ws, playerId: null, windowStart: 0, count: 0 };
    clients.add(client);

    // 듣는 사람이 없으면 소켓 오류 하나로 프로세스 전체가 죽는다.
    ws.on('error', (err) => { warn(`[연결 오류] ${err.message}`); });
    ws.on('close', () => {
      clients.delete(client);
      // stop() 중이면 room은 이미 없다. 호스트가 물러나면서 서버를 내릴 때 이 경로가
      // 반드시 지나가므로, 여기서 null을 참조하면 인계 때마다 프로세스가 죽는다.
      if (room && client.playerId) room.disconnect(client.playerId);
    });

    ws.on('message', (raw) => {
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

      if (msg.type === 'join') {
        const joined = room.join({ nickname: msg.nickname, token: msg.token });
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
    });
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

      room = createRoom({ onChange: broadcastState });
      server = http.createServer(handleHttp);
      // [S-1] 이 서버는 자기가 내려준 화면(같은 출처)이나 Electron 창(로컬 출처)만
      // 상대한다. 참가자가 열어 둔 아무 웹페이지가 붙어 오는 것(CSWSH)을 막는다.
      wss = new WebSocketServer({ server, verifyClient: allowOrigin });
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

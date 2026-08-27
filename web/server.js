'use strict';

/**
 * 웹 버전 서버 - 이 프로세스 하나가 게임의 유일한 권위다.
 *
 * LAN 버전과 실행 방식이 다르다:
 *   LAN 버전 : 참가자 각자가 자기 PC에서 exe를 실행하고, UDP 브로드캐스트로 서로를 찾는다.
 *   웹 버전  : 한 사람만 이 서버를 켜고, 나머지는 브라우저로 그 주소에 접속한다.
 *
 * 그래서 0.0.0.0에 바인딩하고(다른 PC에서 들어와야 한다), 시작할 때 접속 주소를 찍어 준다.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const { createRoom } = require('./room');
const { validateClientMessage } = require('./protocol');
const { log, warn, error, LOG_PATH } = require('../logger');

const PORT = Number(process.env.PORT) || 4100;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

const server = http.createServer((req, res) => {
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
});

const wss = new WebSocketServer({ server });
const clients = new Set(); // { ws, playerId }

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
  for (const client of clients) {
    if (!client.playerId) continue;
    sendTo(client.ws, room.stateFor(client.playerId));
  }
}

const room = createRoom({ onChange: broadcastState });

wss.on('connection', (ws) => {
  const client = { ws, playerId: null };
  clients.add(client);

  // 듣는 사람이 없으면 소켓 오류 하나로 서버 전체가 죽는다.
  ws.on('error', (err) => { warn(`[연결 오류] ${err.message}`); });
  ws.on('close', () => {
    clients.delete(client);
    if (client.playerId) room.disconnect(client.playerId);
  });

  ws.on('message', (raw) => {
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

    let reason = null;
    if (msg.type === 'start') reason = room.start();
    else if (msg.type === 'chat') reason = room.say(client.playerId, msg.text);
    else if (msg.type === 'callVote') reason = room.callVote(client.playerId);
    else if (msg.type === 'vote') reason = room.vote(client.playerId, msg.targetId);
    else if (msg.type === 'guess') reason = room.guess(client.playerId, msg.word);

    // 거절 사유는 요청한 사람에게만 알린다. 예전처럼 눌러도 아무 일이 없으면 원인을 알 수 없다.
    if (reason) sendTo(ws, { type: 'error', message: reason });
  });
});

/** 다른 PC에서 접속할 때 쓸 주소. 참가자에게 공유해야 하므로 시작할 때 찍어 준다. */
function lanAddresses() {
  const found = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const info of entries || []) {
      if (info.family === 'IPv4' && !info.internal) found.push(info.address);
    }
  }
  return found;
}

// http 서버의 error는 ws가 WebSocketServer로도 다시 올린다. 한쪽만 들으면
// 나머지 한쪽이 "듣는 사람 없는 error"가 되어 결국 스택 트레이스로 죽는다.
let fatalHandled = false;
function handleFatal(err) {
  if (fatalHandled) return;
  fatalHandled = true;

  if (err.code === 'EADDRINUSE') {
    error(`[중복 실행] ${PORT}번 포트가 이미 사용 중입니다.`);
    console.error('');
    console.error(`  이미 서버가 실행 중인 것 같습니다. 브라우저에서 http://localhost:${PORT} 로 접속하세요.`);
    console.error(`  다른 포트로 띄우려면: PORT=4200 npm run web`);
    console.error('');
    process.exit(0);
  }
  error(`[서버 오류] ${err.code || ''} ${err.message}`);
  process.exit(1);
}
server.on('error', handleFatal);
wss.on('error', handleFatal);

server.listen(PORT, '0.0.0.0', () => {
  log(`[시작] 웹 서버 실행 중 (포트 ${PORT})`);
  console.log('');
  console.log('  라이어 게임 (웹 버전) 서버가 실행되었습니다.');
  console.log('');
  console.log(`  내 화면          : http://localhost:${PORT}`);
  for (const ip of lanAddresses()) {
    console.log(`  다른 참가자에게  : http://${ip}:${PORT}`);
  }
  console.log('');
  console.log(`  최소 인원 ${room.MIN_PLAYERS}명. 문제가 생기면 로그를 확인하세요: ${LOG_PATH}`);
  console.log('');
});

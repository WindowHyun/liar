'use strict';

/**
 * 브라우저 화면과 Node 백엔드를 잇는 로컬 서버.
 *
 * v0.5에서 고친 것:
 *   [P0-4] 이 프로그램을 같은 PC에서 두 번 실행해도 UDP bind는 reuseAddr 때문에 성공한다.
 *          그래서 "2중 실행"은 UDP 쪽에서 잡히지 않는다. 대신 여기 TCP 4000번은 반드시
 *          충돌하므로, 이 자리가 2중 실행을 감지할 수 있는 유일한 지점이다. 예전에는
 *          listen 실패가 미처리 예외로 스택 트레이스만 남기고 죽었다.
 *   [P2-20] 상태 핸들러가 "마지막에 연결된 ws" 하나만 붙잡고 있었다. 창을 두 개 열면
 *          먼저 열린 창이 조용히 죽고, 창을 닫으면 갈 곳 없는 상태가 계속 쌓였다.
 *          연결 목록을 두고 살아 있는 클라이언트 전부에게 보낸다.
 *   [P2-20] 새로 붙은 클라이언트에게 현재 상태(snapshot)를 넘겨준다. 새로고침하거나
 *          잠깐 끊겼다 붙었을 때 화면이 빈 채로 남지 않는다.
 */

const http = require('http');
const { WebSocketServer } = require('ws');
const { exec } = require('child_process');
const game = require('./game');
const net = require('./network');
const protocol = require('./protocol');
const html = require('./public');
const { log, warn, error, LOG_PATH } = require('./logger');

// 이건 LAN 브로드캐스트 포트(50000)와는 별개로, 이 PC 안에서 브라우저 화면과
// Node 백엔드를 잇는 로컬 전용 포트다. 참가자 각자 자기 PC에서 이 exe를 실행하면
// 이 포트로 화면이 자동으로 뜬다.
const PORT = 4000;
const URL = `http://localhost:${PORT}`;

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    // 버전이 올라간 뒤에도 브라우저가 옛 화면을 들고 있으면 "나만 안 되는" 상황이 된다.
    'Cache-Control': 'no-store',
  });
  res.end(html);
});

const wss = new WebSocketServer({ server });
const clients = new Set();

function sendTo(ws, payload) {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch (err) {
    warn(`[화면 전송 실패] ${err.message}`);
  }
}

// [P2-20] 게임 상태는 연결된 모든 창으로 나간다. 핸들러는 시작할 때 한 번만 건다.
game.setStateHandler((state) => {
  for (const ws of clients) sendTo(ws, state);
});

wss.on('connection', (ws) => {
  clients.add(ws);

  // ws는 소켓 오류를 'error' 이벤트로 올린다. 듣는 사람이 없으면 그대로 프로세스가 죽는다.
  ws.on('error', (err) => {
    warn(`[화면 연결 오류] ${err.message}`);
    clients.delete(ws);
  });
  ws.on('close', () => clients.delete(ws));

  sendTo(ws, { type: 'me', id: net.MY_ID, version: net.PROTOCOL_VERSION, logPath: LOG_PATH });
  sendTo(ws, game.snapshot()); // [P2-20] 새로고침·재접속해도 화면이 비지 않게

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'join') {
      const nickname = String(msg.nickname == null ? '' : msg.nickname).trim().slice(0, protocol.LIMITS.nickname);
      if (!nickname) return;
      game.join(nickname);
    } else if (msg.type === 'start') game.startGame();
    else if (msg.type === 'desc') game.sendDescription(msg.text);
    else if (msg.type === 'callVote') game.callVote();
    else if (msg.type === 'vote') game.sendVote(msg.targetId);
    else if (msg.type === 'guess') game.submitGuess(msg.word);
  });
});

function openBrowser() {
  // exe로 실행됐을 때 참가자가 따로 브라우저 주소를 입력하지 않아도 되도록 자동으로 열어준다.
  const openCmd =
    process.platform === 'win32' ? `start "" "${URL}"` :
    process.platform === 'darwin' ? `open "${URL}"` :
    `xdg-open "${URL}"`;
  exec(openCmd, () => {});
}

// [P0-4] listen 실패를 미처리 예외로 두지 않는다. 4000번이 이미 쓰이고 있다는 건
// 거의 항상 "이 프로그램이 이미 실행 중"이라는 뜻이다. UDP 쪽에서는 reuseAddr 때문에
// 이 상황이 조용히 지나가고, 대신 제시어(유니캐스트)가 한쪽에만 도착해서 다른 한 명이
// 원인 모르게 게임을 못 하게 된다. 여기서 확실히 끊는다.
//
// 주의: ws는 http 서버의 error를 WebSocketServer로도 다시 올린다. 둘 중 한쪽만 듣고
// 있으면 나머지 한쪽이 "듣는 사람 없는 error"가 되어 결국 스택 트레이스로 죽는다.
// 그래서 양쪽 모두에 붙이고, 실제 처리는 한 번만 하도록 막아 둔다.
let fatalHandled = false;
function handleFatal(err) {
  if (fatalHandled) return;
  fatalHandled = true;

  if (err.code === 'EADDRINUSE') {
    error(`[중복 실행] ${PORT}번 포트가 이미 사용 중입니다. 이 프로그램이 이미 실행 중일 가능성이 큽니다.`);
    console.error('');
    console.error('  이미 실행 중인 창을 사용하세요. 두 번 실행하면 제시어가 한쪽에만 전달되어');
    console.error('  다른 한 명이 원인 모르게 게임을 못 하게 됩니다.');
    console.error(`  기존 창 주소: ${URL}`);
    console.error(`  로그 파일: ${LOG_PATH}`);
    console.error('');
    openBrowser();
    process.exit(0);
  }

  error(`[서버 오류] ${err.code || ''} ${err.message}`);
  process.exit(1);
}

server.on('error', handleFatal);
wss.on('error', handleFatal);

server.listen(PORT, '127.0.0.1', () => {
  log(`[시작] 라이어 게임 서버 실행 중: ${URL} (프로토콜 v${net.PROTOCOL_VERSION})`);
  console.log(`라이어 게임 서버 실행 중: ${URL}`);
  console.log(`같은 네트워크의 다른 참가자와는 UDP ${net.PORT}번 포트로 통신합니다.`);
  console.log(`문제가 생기면 이 로그 파일을 확인하세요: ${LOG_PATH}`);
  openBrowser();
});

'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');
const { exec } = require('child_process');
const game = require('./game');
const net = require('./network');
const html = require('./public');

// 이건 LAN 브로드캐스트 포트(50000)와는 별개로, 이 PC 안에서 브라우저 화면과
// Node 백엔드를 잇는 로컬 전용 포트다. 참가자 각자 자기 PC에서 이 exe를 실행하면
// 이 포트로 화면이 자동으로 뜬다.
const PORT = 4000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'me', id: net.MY_ID }));
  game.setStateHandler((state) => ws.send(JSON.stringify(state)));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') game.join(msg.nickname);
    else if (msg.type === 'start') game.startGame();
    else if (msg.type === 'desc') game.sendDescription(msg.text);
    else if (msg.type === 'callVote') game.callVote();
    else if (msg.type === 'vote') game.sendVote(msg.targetId);
    else if (msg.type === 'guess') game.submitGuess(msg.word);
  });
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`라이어 게임 서버 실행 중: ${url}`);
  console.log(`같은 네트워크의 다른 참가자와는 UDP ${net.PORT}번 포트로 통신합니다.`);

  // exe로 실행됐을 때 참가자가 따로 브라우저 주소를 입력하지 않아도 되도록 자동으로 열어준다.
  const openCmd =
    process.platform === 'win32' ? `start "" "${url}"` :
    process.platform === 'darwin' ? `open "${url}"` :
    `xdg-open "${url}"`;
  exec(openCmd, () => {});
});

'use strict';

/**
 * [E-3] 연결이 유지되는지 / 죽은 연결이 정리되는지.
 *
 * 사내망에서 "게임 중에 갑자기 접속이 끊긴다"는 신고가 있었다. 조용한 TCP 연결을
 * 방화벽이 끊어 버리는 것이 흔한 원인이고, 이 게임은 남의 설명을 듣는 60초 동안
 * 아무 데이터도 오가지 않아서 딱 그 시간에 걸렸다.
 *
 * 실행: node test/connection-test.js
 */

const WebSocket = require('ws');
const { createGameServer } = require('../web/game-server');

const PORT = 4193;
const URL = `ws://127.0.0.1:${PORT}`;
const PING_MS = 150; // 테스트에서는 짧게

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function open() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/** 조건에 맞는 메시지가 올 때까지 기다린다. */
function expect(ws, match, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', onMsg); reject(new Error('응답 없음')); }, timeoutMs || 2000);
    function onMsg(raw) {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!match(msg)) return;
      clearTimeout(timer);
      ws.off('message', onMsg);
      resolve(msg);
    }
    ws.on('message', onMsg);
  });
}

async function main() {
  const server = createGameServer({ port: PORT, pingMs: PING_MS });
  await server.start();

  // ── C1: 화면이 보내는 살아있음 확인에 답한다 ──
  const a = await open();
  a.send(JSON.stringify({ type: 'ping' }));
  let pong = null;
  try { pong = await expect(a, (m) => m.type === 'pong'); } catch { /* 아래에서 걸린다 */ }
  check('C1 화면의 연결 확인(ping)에 서버가 답한다(pong)', !!pong);

  // ── C2: 아무 말도 안 하고 있어도 연결이 끊기지 않는다 ──
  a.send(JSON.stringify({ type: 'join', nickname: '철수' }));
  await expect(a, (m) => m.type === 'welcome');
  await wait(PING_MS * 6); // 조용히 기다린다 (실제로는 남의 설명을 듣는 60초에 해당)
  check('C2 [이슈7] 조용히 있어도 연결이 유지된다',
    a.readyState === WebSocket.OPEN && server.playerCount() === 1,
    `readyState=${a.readyState} 접속자=${server.playerCount()}`);

  // ── C3: 반쯤 죽은 연결은 서버가 걸러 낸다 ──
  const b = await open();
  b.send(JSON.stringify({ type: 'join', nickname: '영희' }));
  await expect(b, (m) => m.type === 'welcome');
  check('C3 두 명이 붙어 있다', server.playerCount() === 2, String(server.playerCount()));

  // 소켓 읽기를 멈추면 서버가 보낸 ping을 파싱하지 못해 pong도 못 보낸다.
  // 전원이 나갔거나 랜선이 빠진 것과 같은 상태다(close 이벤트가 오지 않는다).
  b._socket.pause();
  await wait(PING_MS * 8);
  check('C3 [이슈6·7] 응답 없는 연결은 서버가 정리한다',
    server.playerCount() === 1, `접속자=${server.playerCount()}`);
  check('C3 멀쩡한 사람은 그대로 남는다', a.readyState === WebSocket.OPEN);

  // ── C4: 한 사람의 잘못된 요청이 판 전체를 날리지 않는다 ──
  const c = await open();
  c.send(JSON.stringify({ type: 'join', nickname: '민수' }));
  await expect(c, (m) => m.type === 'welcome');
  for (let i = 0; i < 20; i += 1) {
    c.send(JSON.stringify({ type: 'vote', targetId: '없는사람' }));
    c.send('이건 JSON도 아님');
    c.send(JSON.stringify({ type: '알수없는요청' }));
  }
  await wait(300);
  check('C4 잘못된 요청을 퍼부어도 서버가 살아 있다', server.isRunning());
  check('C4 다른 사람 연결이 끊기지 않는다',
    a.readyState === WebSocket.OPEN, `readyState=${a.readyState}`);
  a.send(JSON.stringify({ type: 'ping' }));
  let stillAlive = null;
  try { stillAlive = await expect(a, (m) => m.type === 'pong'); } catch { /* 아래에서 걸린다 */ }
  check('C4 다른 사람은 계속 게임할 수 있다', !!stillAlive);

  // ── C5: 한 연결이 참가를 두 번 보내도 유령이 남지 않는다 ──
  // 앞서 잡았던 자리가 "접속 중"인 채로 남으면 인원수와 시작 조건이 어긋난다.
  let lastState = null;
  a.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'state') lastState = m;
  });

  const d = await open();
  d.send(JSON.stringify({ type: 'join', nickname: '지현' }));
  const first = await expect(d, (m) => m.type === 'welcome');
  d.send(JSON.stringify({ type: 'join', nickname: '지현2' }));
  const second = await expect(d, (m) => m.type === 'welcome');
  await wait(300);
  check('C5 두 번째 참가는 새 자리로 들어간다', first.playerId !== second.playerId);

  const connectedNow = lastState ? lastState.players.filter((p) => p.connected) : [];
  // 붙어 있는 사람: 철수(a), 민수(c), 지현2(d)  → 지현(첫 자리)은 접속 중이면 안 된다
  check('C5 앞 자리가 접속 중인 채로 남지 않는다',
    connectedNow.length === 3 && !connectedNow.some((p) => p.id === first.playerId),
    connectedNow.map((p) => p.nickname).join(',') || '(상태 못 받음)');

  try { a.close(); } catch { /* 무시 */ }
  try { b.terminate(); } catch { /* 무시 */ }
  try { c.close(); } catch { /* 무시 */ }
  try { d.close(); } catch { /* 무시 */ }
  await server.stop();
}

main()
  .catch((err) => check('실행 중 예외', false, err.message))
  .finally(async () => {
    await wait(200);
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n연결 유지: ${results.length - failed}/${results.length} 통과`);
    process.exit(failed === 0 ? 0 : 1);
  });

'use strict';

/**
 * 로컬 서버(server.js) 통합 테스트 - 실제로 프로세스를 띄우고 WebSocket으로 붙는다.
 *
 * 여기서 잡는 것:
 *   S1 [P2-20] 창을 두 개 열어도 양쪽 다 상태를 받는다 (예전에는 나중 창이 먼저 창을 죽였다)
 *   S2 [P2-20] 새로 붙은 창이 현재 상태(snapshot)를 받는다 - 새로고침해도 화면이 비지 않는다
 *   S3 [P2-20] 창 하나를 닫아도 서버가 죽지 않고 남은 창은 계속 받는다
 *   S4 [P0-4] 두 번째 실행은 스택 트레이스 대신 안내를 남기고 스스로 종료한다
 *
 * 실행: node test/server-test.js
 */

const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');

const SERVER = path.join(__dirname, '..', 'server.js');
const URL = 'http://127.0.0.1:4000';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(URL, (res) => { res.resume(); resolve(); });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error('서버가 시간 안에 뜨지 않음'));
        else setTimeout(tick, 100);
      });
    };
    tick();
  });
}

/** 상태 메시지를 모아 두고, 원하는 타입이 올 때까지 기다릴 수 있는 클라이언트. */
function connect() {
  const ws = new WebSocket('ws://127.0.0.1:4000');
  const seen = [];
  ws.on('message', (raw) => { try { seen.push(JSON.parse(raw)); } catch { /* 무시 */ } });
  ws.on('error', () => {});
  ws.seen = seen;
  ws.waitFor = (type, timeoutMs = 3000) => new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const found = seen.find((m) => m.type === type);
      if (found) return resolve(found);
      if (Date.now() > deadline) return reject(new Error(`${type} 상태가 오지 않음`));
      setTimeout(tick, 30);
    };
    tick();
  });
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('WebSocket 연결 실패')), 3000);
  });
}

let server;

async function main() {
  server = spawn(process.execPath, [SERVER], { stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.resume();
  server.stderr.resume();
  await waitForServer(6000);

  // S1/S2 ────────────────────────────────────────────────
  const a = await connect();
  const meA = await a.waitFor('me');
  check('S1 접속 즉시 내 id를 받는다', typeof meA.id === 'string' && meA.id.length > 0, `id=${meA.id}`);
  check('S1 로그 파일 경로를 화면에 전달한다 [P2-27]', typeof meA.logPath === 'string' && meA.logPath.length > 0, meA.logPath);

  const snapA = await a.waitFor('snapshot');
  check('S2 접속 즉시 현재 상태(snapshot)를 받는다', snapA.joined === false, `joined=${snapA.joined}`);

  a.send(JSON.stringify({ type: 'join', nickname: '홍길동' }));
  await a.waitFor('participants');

  const b = await connect();
  const snapB = await b.waitFor('snapshot');
  check('S2 나중에 붙은 창도 참가 상태를 그대로 받는다',
    snapB.joined === true && snapB.nickname === '홍길동',
    `joined=${snapB.joined}, nickname=${snapB.nickname}`);

  // S1: 두 창 모두에게 상태가 간다
  a.send(JSON.stringify({ type: 'desc', text: '빨갛습니다' }));
  const descA = await a.waitFor('description');
  const descB = await b.waitFor('description');
  check('S1 [P2-20] 창 두 개가 모두 상태를 받는다',
    descA.text === '빨갛습니다' && descB.text === '빨갛습니다');

  // S3: 창 하나를 닫아도 서버는 살아 있고 남은 창은 계속 받는다
  b.close();
  await wait(400);
  a.seen.length = 0;
  a.send(JSON.stringify({ type: 'desc', text: '두 번째 설명' }));
  const after = await a.waitFor('description');
  check('S3 [P2-20] 창 하나를 닫아도 남은 창은 계속 받는다', after.text === '두 번째 설명');
  check('S3 서버 프로세스가 살아 있다', server.exitCode === null, `exitCode=${server.exitCode}`);

  // S4 ────────────────────────────────────────────────
  const second = spawn(process.execPath, [SERVER], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  second.stderr.on('data', (d) => { stderr += d.toString(); });
  const code = await new Promise((resolve) => second.on('exit', resolve));

  check('S4 [P0-4] 두 번째 실행은 스스로 종료한다', code === 0, `exit=${code}`);
  check('S4 [P0-4] 중복 실행이라고 안내한다', stderr.includes('중복 실행'), stderr.split('\n')[0].slice(0, 60));
  check('S4 [P0-4] 스택 트레이스로 죽지 않는다', !stderr.includes('throw er;') && !stderr.includes('EADDRINUSE\n    at'));
  check('S4 첫 번째 서버는 그대로 살아 있다', server.exitCode === null);

  a.close();
}

main()
  .catch((err) => check('실행 중 예외', false, err.message))
  .finally(async () => {
    if (server) server.kill();
    await wait(200);
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n로컬 서버: ${results.length - failed}/${results.length} 통과`);
    process.exit(failed === 0 ? 0 : 1);
  });

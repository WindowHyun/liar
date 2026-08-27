'use strict';

/**
 * UDP 자동 발견 + 호스트 선출 + 호스트 인계 테스트.
 * Electron 없이 peer.js만 든 프로세스를 여러 개 띄워서 확인한다.
 *
 * 여기서 잡는 것:
 *   D1 프로그램을 켜면 서로를 자동으로 찾는다 (주소 입력 없이)
 *   D2 호스트는 정확히 한 명이고, 모두가 같은 사람을 호스트로 본다
 *   D3 모두가 같은 게임 서버 주소를 가리킨다 = 자동으로 한 방에 모인다
 *   D5 나중에 들어온 인스턴스는 진행 중인 호스트를 뺏지 않는다
 *   D4 호스트가 갑자기 나가면 남은 인스턴스가 이어받고 다시 한 명으로 수렴한다
 *
 * 실행: node test/discovery-test.js
 */

const path = require('path');
const { spawn } = require('child_process');

const PORT = 55500;
const HELPER = path.join(__dirname, 'helpers', 'headless-peer.js');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const running = [];

function launch(label) {
  const child = spawn(process.execPath, [HELPER, String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const peer = { label, child, status: null, exited: false };
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try { peer.status = JSON.parse(line); } catch { /* 로그 줄은 무시 */ }
    }
  });
  child.stderr.resume();
  child.on('exit', () => { peer.exited = true; });
  running.push(peer);
  return peer;
}

async function until(label, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(200);
  }
  console.log(`    (대기 실패: ${label})`);
  return false;
}

const hostsOf = (peers) => peers.map((p) => (p.status ? p.status.hostId : null));
const urlsOf = (peers) => peers.map((p) => (p.status ? p.status.serverUrl : null));

async function main() {
  const a = launch('A');
  const b = launch('B');
  const c = launch('C');
  const three = [a, b, c];

  const found = await until('세 인스턴스가 서로를 발견',
    () => three.every((p) => p.status && p.status.peerCount === 3), 15000);
  check('D1 프로그램을 켜면 서로를 자동으로 찾는다 (주소 입력 없이)',
    found, three.map((p) => `${p.label}:${p.status ? p.status.peerCount : 0}명`).join(' '));

  const settled = await until('호스트 수렴',
    () => three.every((p) => p.status && p.status.serverUrl) && new Set(hostsOf(three)).size === 1, 15000);

  check('D2 모두가 같은 사람을 호스트로 본다', settled, hostsOf(three).join(' '));
  check('D2 호스트는 정확히 한 명',
    three.filter((p) => p.status && p.status.isHost).length === 1,
    three.filter((p) => p.status && p.status.isHost).map((p) => p.label).join(',') || '없음');
  check('D3 모두가 같은 게임 서버를 가리킨다 (자동으로 한 방에 모임)',
    urlsOf(three).filter(Boolean).length === 3, urlsOf(three).join(' '));

  const hostPeer = three.find((p) => p.status && p.status.isHost);
  check('D3 호스트 자신은 자기 서버를 본다',
    !!hostPeer && hostPeer.status.serverUrl === `ws://127.0.0.1:${PORT}`,
    hostPeer ? hostPeer.status.serverUrl : '호스트 없음');
  if (!hostPeer) return;

  const beforeHost = hostPeer.status.hostId;
  const d = launch('D');
  const joined = await until('D 합류', () => d.status && d.status.serverUrl, 15000);
  await wait(3000);
  check('D5 나중에 들어와도 진행 중인 호스트를 뺏지 않는다',
    joined && d.status.hostId === beforeHost && hostPeer.status.isHost === true,
    `기존=${beforeHost} / D가 보는 호스트=${d.status ? d.status.hostId : '?'}`);

  const survivors = [a, b, c, d].filter((p) => p !== hostPeer);
  hostPeer.child.kill('SIGKILL'); // 정상 종료가 아니라 갑자기 죽은 상황
  const handedOver = await until('호스트 인계',
    () => survivors.every((p) => p.status && p.status.hostId && p.status.hostId !== beforeHost) &&
          new Set(hostsOf(survivors)).size === 1 &&
          survivors.some((p) => p.status.isHost), 30000);

  check('D4 호스트가 갑자기 나가면 남은 쪽이 이어받는다', handedOver, hostsOf(survivors).join(' '));
  check('D4 인계 후에도 호스트는 한 명',
    survivors.filter((p) => p.status && p.status.isHost).length === 1,
    survivors.filter((p) => p.status && p.status.isHost).map((p) => p.label).join(',') || '없음');
  // 호스트 자신은 루프백으로, 나머지는 호스트의 IP로 붙는다. 가리키는 서버는 같은 곳이다.
  const newHost = survivors.find((p) => p.status && p.status.isHost);
  const others = survivors.filter((p) => p !== newHost);
  check('D4 인계 후에도 모두 같은 게임 서버를 가리킨다',
    !!newHost &&
    newHost.status.serverUrl === `ws://127.0.0.1:${PORT}` &&
    others.every((p) => p.status.serverUrl === `ws://${p.status.hostAddress}:${PORT}`) &&
    others.every((p) => p.status.hostId === newHost.status.nodeId),
    urlsOf(survivors).join(' '));
}

main()
  .catch((err) => check('실행 중 예외', false, err.message))
  .finally(async () => {
    for (const p of running) { if (!p.exited) p.child.kill('SIGKILL'); }
    await wait(300);
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n자동 발견/호스트 선출: ${results.length - failed}/${results.length} 통과`);
    process.exit(failed === 0 ? 0 : 1);
  });

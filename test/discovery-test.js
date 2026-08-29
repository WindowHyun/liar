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
 *   D6 호스트의 알림이 잠깐 끊겨도 호스트를 뺏지 않는다 (판이 날아가지 않는다)
 *   D7 호스트의 게임 서버가 죽으면 호스트 자리를 내려놓고 다시 정한다
 *   D4 호스트가 갑자기 나가면 남은 인스턴스가 이어받고 다시 한 명으로 수렴한다
 *
 * 실행: node test/discovery-test.js
 */

const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

// 실제 앱(55500)과 겹치면 돌고 있는 인스턴스를 4번째 참가자로 잡아 버린다.
// 테스트는 전용 포트를 쓴다.
const PORT = Number(process.env.LIAR_TEST_PORT) || 55599;
const HELPER = path.join(__dirname, 'helpers', 'headless-peer.js');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const running = [];

function launch(label, port) {
  const child = spawn(process.execPath, [HELPER, String(port || PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
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
    // await를 빼면 안 된다. 비동기 조건(예: 실제로 붙어 보기)이 Promise를 돌려주는데,
    // Promise는 그 자체로 항상 참이라 검사가 통째로 무의미해진다.
    if (await predicate()) return true;
    await wait(200);
  }
  console.log(`    (대기 실패: ${label})`);
  return false;
}

/** 지금 게임 서버에 실제로 붙을 수 있는가. 상태 문자열만으로는 굳은 걸 알 수 없다. */
function canConnect(port) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    let ws;
    try { ws = new WebSocket(`ws://127.0.0.1:${port || PORT}`); } catch { finish(false); return; }
    const timer = setTimeout(() => { try { ws.terminate(); } catch { /* 무시 */ } finish(false); }, 2000);
    ws.on('open', () => { clearTimeout(timer); try { ws.close(); } catch { /* 무시 */ } finish(true); });
    ws.on('error', () => { clearTimeout(timer); finish(false); });
  });
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

  // D6 호스트의 알림이 잠깐 끊겨도 호스트를 뺏지 않는다.
  //
  // 사내 Wi-Fi의 AP는 브로드캐스트 프레임을 곧잘 버린다. 알림 몇 번을 연속으로 놓쳤다고
  // 다른 PC가 호스트를 넘겨받아 버리면, 게임 서버가 새로 켜지면서 전원의 연결이 끊기고
  // 진행 중이던 판이 통째로 날아간다. 실제로 "게임 중에 갑자기 끊긴다"는 신고가 있었다.
  // SIGSTOP으로 호스트 프로세스를 얼려서 알림만 끊긴 상황을 그대로 만든다.
  const watchers = [a, b, c, d].filter((p) => p !== hostPeer);
  hostPeer.child.kill('SIGSTOP');
  await wait(12000); // 보통 참가자 기준(7초)은 훌쩍 넘고, 호스트 기준(21초)에는 못 미친다
  const kept = watchers.every((p) => p.status && p.status.hostId === beforeHost);
  hostPeer.child.kill('SIGCONT');
  check('D6 호스트 알림이 12초 끊겨도 호스트를 뺏지 않는다 (판이 날아가지 않는다)',
    kept, hostsOf(watchers).join(' '));

  await wait(4000); // 얼렸다 푼 뒤 서로를 다시 찾을 틈을 준다
  check('D6 알림이 돌아오면 그대로 이어간다',
    watchers.every((p) => p.status && p.status.hostId === beforeHost)
    && hostPeer.status.isHost === true,
    hostsOf(watchers).join(' '));

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

  // ── D7 호스트의 게임 서버가 죽어도 굳지 않는다 ──
  //
  // hosting 플래그가 "호스트를 넘길 때"만 꺼지도록 되어 있어서, 서버가 다른 이유로
  // 죽으면 계속 "내가 호스트"라고 알렸다. 다른 PC들은 규칙 1(호스트 주장자 우선)에
  // 따라 그 PC를 호스트로 보고 아무도 서버를 켜지 않아, 전원이 접속 실패만 반복했다.
  //
  // 인스턴스 하나로 확인한다. 여럿이면 다른 PC가 이어받는 경로가 있어서
  // "굳었는지"가 가려진다. 상태 문자열이 아니라 실제로 붙을 수 있는지로 본다.
  const SOLO_PORT = PORT + 1;
  const solo = launch('S', SOLO_PORT);
  await until('혼자 호스트가 됨', () => solo.status && solo.status.isHost, 15000);
  check('D7 서버가 살아 있으면 붙을 수 있다', await canConnect(SOLO_PORT));

  solo.child.kill('SIGUSR2'); // 게임 서버만 내린다. peer는 계속 "내가 호스트"라고 알린다
  const healed = await until('다시 붙을 수 있게 됨', () => canConnect(SOLO_PORT), 20000);
  check('D7 [H3] 게임 서버가 죽어도 스스로 다시 켠다 (전원이 굳지 않는다)',
    healed, healed ? '' : '굳었다 - 아무도 서버를 켜지 않는다');
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

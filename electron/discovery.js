'use strict';

/**
 * UDP 브로드캐스트로 같은 LAN의 다른 실행 인스턴스를 찾는다. 포트 55500.
 *
 * 여기서 오가는 건 "나 여기 있다"는 announce뿐이다. 게임 규칙은 하나도 실리지 않는다.
 * 누가 호스트가 될지 정하고 나면, 실제 게임은 그 호스트의 TCP 55500(WebSocket)으로 간다.
 *
 * ── 예전 LAN 버전에서 배운 것을 그대로 가져온다 ────────────────────────────
 * [절대 최적화하지 말 것] announce를 "어댑터마다 각각" 보낸다. 255.255.255.255로 한 번만
 * 보내면 OS가 어댑터 하나만 골라 내보내서, 이더넷과 Wi-Fi가 동시에 연결된 PC는 반대쪽
 * 네트워크에 있는 사람에게 패킷이 안 간다. 중복 판정은 반드시 (로컬 IP, 목적지) 조합으로
 * 한다. 두 어댑터가 같은 서브넷이면 목적지가 같아지는데, "목적지가 같으니 한 번만"이라고
 * 줄이면 두 번째 어댑터로는 아예 안 나가서 같은 버그가 재발한다.
 *
 * 넷마스크 계산이 틀어지는 어댑터(가상 어댑터 등)를 대비해, 어댑터마다 계산된 서브넷
 * 브로드캐스트와 255.255.255.255로 각각 한 번씩 보낸다. 그래서 같은 announce가 여러 번
 * 도착하는데, announce는 "마지막으로 본 시각"을 갱신할 뿐이라 중복이 무해하다.
 * (게임 메시지였다면 중복 제거가 필요했다 - 그게 LAN 버전의 P0-1이었다.)
 */

const dgram = require('dgram');
const os = require('os');
const { log, warn, error } = require('../logger');

const ANNOUNCE_MS = 2000;      // 알림 주기
const PEER_TIMEOUT_MS = 7000;  // 알림 3~4번을 연속으로 놓치면 나간 것으로 본다

function getLocalIPv4Interfaces() {
  const result = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const info of entries || []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      const broadcast = computeBroadcast(info.address, info.netmask);
      if (broadcast) result.push({ address: info.address, broadcast });
    }
  }
  return result;
}

function computeBroadcast(address, netmask) {
  try {
    const ip = address.split('.').map(Number);
    const mask = netmask.split('.').map(Number);
    if (ip.length !== 4 || mask.length !== 4) return null;
    return ip.map((octet, i) => (octet | (~mask[i] & 0xff)) & 0xff).join('.');
  } catch {
    return null;
  }
}

/**
 * @param port          UDP 포트 (55500)
 * @param nodeId        내 식별자
 * @param buildAnnounce 매번 보낼 내용을 만들어 주는 함수 (호스트 여부 등이 바뀌므로)
 * @param onChange      피어 목록이 바뀌면 호출
 */
function createDiscovery(options) {
  const { port, nodeId, buildAnnounce, onChange = () => {} } = options;

  const peers = new Map(); // nodeId -> { nodeId, address, isHost, lastSeen }
  const sockets = new Map(); // "로컬IP|목적지" -> 재사용할 송신 소켓
  let receiver = null;
  let announceTimer = null;
  let sweepTimer = null;
  let stopped = false;

  function safeClose(sock) {
    if (!sock || sock.__closed) return;
    sock.__closed = true;
    try { sock.close(); } catch { /* 이미 닫힘 */ }
  }

  function sendVia(key, address, broadcast, data) {
    let sock = sockets.get(key);
    if (!sock) {
      sock = dgram.createSocket('udp4');
      sock.__ready = false;
      sockets.set(key, sock);
      sock.on('error', (err) => {
        // 흔한 원인: 방화벽/보안에이전트가 이 프로세스의 아웃바운드를 막은 경우.
        error(`[알림 실패] ${address || '기본'} → ${broadcast}: ${err.message}`);
        sockets.delete(key);
        safeClose(sock);
      });
      sock.bind(0, address || undefined, () => {
        if (sockets.get(key) !== sock) { safeClose(sock); return; }
        try { sock.setBroadcast(true); } catch (err) {
          error(`[알림 실패] 브로드캐스트 설정 실패(${address || '기본'}): ${err.message}`);
          sockets.delete(key);
          safeClose(sock);
          return;
        }
        sock.__ready = true;
      });
    }
    if (!sock.__ready) return; // 다음 주기(2초 뒤)에 나간다
    sock.send(data, port, broadcast, (err) => {
      if (!err) return;
      error(`[알림 실패] ${address || '기본'} → ${broadcast} 전송: ${err.message}`);
      sockets.delete(key);
      safeClose(sock);
    });
  }

  function announce() {
    if (stopped) return;
    const payload = Object.assign({ v: 1, nodeId }, buildAnnounce());
    const data = Buffer.from(JSON.stringify(payload), 'utf-8');

    let interfaces = getLocalIPv4Interfaces();
    if (interfaces.length === 0) interfaces = [{ address: null, broadcast: '255.255.255.255' }];

    const targets = [];
    for (const iface of interfaces) {
      targets.push(iface);
      if (iface.broadcast !== '255.255.255.255') targets.push({ address: iface.address, broadcast: '255.255.255.255' });
    }

    const seen = new Set();
    for (const { address, broadcast } of targets) {
      const key = `${address}|${broadcast}`; // 목적지만으로 줄이지 말 것
      if (seen.has(key)) continue;
      seen.add(key);
      sendVia(key, address, broadcast, data);
    }
    // 어댑터가 바뀌면(Wi-Fi 재접속 등) 예전 IP에 묶인 소켓은 못 쓴다. 정리한다.
    for (const key of [...sockets.keys()]) {
      if (!seen.has(key)) { safeClose(sockets.get(key)); sockets.delete(key); }
    }
  }

  function sweep() {
    const now = Date.now();
    let changed = false;
    for (const [id, peer] of peers) {
      if (now - peer.lastSeen > PEER_TIMEOUT_MS) {
        peers.delete(id);
        log(`[발견] 참가자가 나갔습니다: ${id}`);
        changed = true;
      }
    }
    if (changed) onChange();
  }

  function openReceiver() {
    if (stopped) return;
    // reuseAddr이라 같은 PC에서 두 번 실행해도 양쪽 다 받는다. 게임 통신은 TCP로 하므로
    // 예전처럼 "유니캐스트가 한쪽에만 도착하는" 문제가 생기지 않는다.
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true, recvBufferSize: 65535 });

    sock.on('message', (data, rinfo) => {
      let msg;
      try { msg = JSON.parse(data.toString('utf-8')); } catch (err) {
        warn(`[발견 경고] 알 수 없는 패킷 from ${rinfo.address}: ${err.message}`);
        return;
      }
      if (!msg || typeof msg.nodeId !== 'string' || msg.nodeId.length > 64) return;
      if (msg.nodeId === nodeId) return; // 내가 보낸 것이 돌아온 것

      const before = peers.get(msg.nodeId);
      peers.set(msg.nodeId, {
        nodeId: msg.nodeId,
        address: rinfo.address,
        isHost: msg.isHost === true,
        lastSeen: Date.now(),
      });
      if (!before) log(`[발견] 참가자를 찾았습니다: ${msg.nodeId} (${rinfo.address})`);
      if (!before || before.isHost !== (msg.isHost === true) || before.address !== rinfo.address) onChange();
    });

    sock.on('error', (err) => {
      // 여기로 오는 건 소켓 자체가 죽은 경우다. 그 패킷만 버리는 게 아니라 다시 열어야 한다.
      error(`[발견 실패] 수신 소켓 오류 - 2초 후 재생성: ${err.message}`);
      safeClose(sock);
      receiver = null;
      if (!stopped) setTimeout(openReceiver, 2000);
    });

    sock.bind(port, '0.0.0.0');
    receiver = sock;
  }

  return {
    start() {
      stopped = false;
      openReceiver();
      announce();
      announceTimer = setInterval(announce, ANNOUNCE_MS);
      sweepTimer = setInterval(sweep, 1000);
    },
    stop() {
      stopped = true;
      if (announceTimer) { clearInterval(announceTimer); announceTimer = null; }
      if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
      safeClose(receiver);
      receiver = null;
      for (const sock of sockets.values()) safeClose(sock);
      sockets.clear();
      peers.clear();
    },
    peers: () => [...peers.values()],
  };
}

module.exports = { createDiscovery, getLocalIPv4Interfaces, ANNOUNCE_MS, PEER_TIMEOUT_MS };

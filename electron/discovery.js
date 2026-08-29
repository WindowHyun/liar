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

/**
 * [E-2] 알림 형식 버전. 배포 시점이 갈려 구/신 버전이 섞이면 서로를 발견해 한 방에
 * 모이려 하고, 게임 메시지 형식이 다르면 그때 가서 이상하게 깨진다. 버전이 다른 상대는
 * 아예 참가자로 세지 않고, 사용자에게 "버전이 다르다"고 알린다.
 * 형식을 바꿀 때 반드시 올릴 것.
 */
const DISCOVERY_VERSION = 1;

const ANNOUNCE_MS = 2000;      // 알림 주기
const PEER_TIMEOUT_MS = 7000;  // 알림 3~4번을 연속으로 놓치면 나간 것으로 본다
// 호스트는 훨씬 오래 기다린다. 보통 참가자가 잠깐 사라지는 것은 아무 대가가 없지만
// (돌아오면 그만), 호스트가 사라진 것으로 판단하면 다른 PC가 게임 서버를 새로 켜고
// 모두의 연결이 끊기면서 진행 중이던 판이 통째로 날아간다. 사내 Wi-Fi의 AP는
// 브로드캐스트 프레임을 곧잘 버리기 때문에 몇 번 연속으로 놓치는 일이 드물지 않다.
const HOST_TIMEOUT_MS = 21000;
// [F1] 한 PC가 랜선과 와이파이로 같은 망에 동시에 붙어 있으면(도킹한 노트북에서 흔하다)
// 같은 인스턴스의 알림이 두 주소에서 번갈아 도착한다. 올 때마다 주소를 갈아치우면
// 붙을 주소가 2초마다 바뀌고, 화면은 그때마다 연결을 끊고 다시 붙는다 - 계속 튕긴다.
// 쓰던 주소가 아직 살아 있으면 그대로 둔다. 이 시간만큼 그 주소가 조용하면 그때 갈아탄다
// (공유기가 IP를 새로 준 경우처럼 진짜로 바뀐 상황).
const ADDRESS_STICKY_MS = 6000;

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
 * @param onVersionMismatch 버전이 다른 인스턴스를 봤을 때 호출
 */
function createDiscovery(options) {
  const { port, nodeId, buildAnnounce, onChange = () => {}, onVersionMismatch = () => {} } = options;
  let mismatchReported = null; // 같은 버전을 2초마다 반복해서 알리지 않게

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
    const payload = Object.assign({ v: DISCOVERY_VERSION, nodeId }, buildAnnounce());
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
      const limit = peer.isHost ? HOST_TIMEOUT_MS : PEER_TIMEOUT_MS;
      if (now - peer.lastSeen > limit) {
        peers.delete(id);
        log(`[발견] ${peer.isHost ? '호스트' : '참가자'}가 나갔습니다: ${id}`);
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

      // [E-2] 버전이 다르면 참가자로 세지 않는다. 같이 모이면 게임이 이상하게 깨진다.
      if (msg.v !== DISCOVERY_VERSION) {
        if (mismatchReported !== msg.v) {
          mismatchReported = msg.v;
          warn(`[버전 불일치] ${rinfo.address}의 버전 ${msg.v} != 내 버전 ${DISCOVERY_VERSION} - 참가자로 세지 않습니다`);
          onVersionMismatch({ peerVersion: msg.v, myVersion: DISCOVERY_VERSION, address: rinfo.address });
        }
        return;
      }

      const now = Date.now();
      const before = peers.get(msg.nodeId);
      const isHost = msg.isHost === true;

      // [F1] 쓰던 주소가 계속 살아 있으면 다른 주소에서 온 알림이 있어도 갈아타지 않는다.
      let address = rinfo.address;
      let addressSeen = now;
      if (before) {
        if (rinfo.address === before.address) {
          address = before.address; // 쓰던 주소에서 왔다 - 살아 있다는 뜻
        } else if (now - before.addressSeen <= ADDRESS_STICKY_MS) {
          address = before.address;          // 아직 살아 있다. 그대로 간다
          addressSeen = before.addressSeen;  // 이 알림은 다른 주소 것이므로 갱신하지 않는다
        } else {
          log(`[발견] ${msg.nodeId}의 주소가 바뀌었습니다: ${before.address} → ${rinfo.address}`);
        }
      }

      peers.set(msg.nodeId, { nodeId: msg.nodeId, address, isHost, lastSeen: now, addressSeen });
      if (!before) log(`[발견] 참가자를 찾았습니다: ${msg.nodeId} (${address})`);
      if (!before || before.isHost !== isHost || before.address !== address) onChange();
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

module.exports = {
  createDiscovery, getLocalIPv4Interfaces, DISCOVERY_VERSION,
  ANNOUNCE_MS, PEER_TIMEOUT_MS, HOST_TIMEOUT_MS, ADDRESS_STICKY_MS,
};

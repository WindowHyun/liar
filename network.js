'use strict';

/**
 * lan_alarm.py의 UDP 브로드캐스트 방식을 그대로 옮긴 LAN 통신 모듈.
 *
 * 아래 체크리스트(사용자 제공 - 과거 같은 종류의 프로그램에서 반복됐던 장애 원인 목록)를
 * 기준으로 점검·수정함. 각 처리 옆에 어떤 규칙에 대응하는지 주석으로 남긴다 - 이유가
 * 안 적혀 있으면 나중에 "불필요한 중복"으로 오인해 제거했다가 같은 장애가 재발한다.
 */

const dgram = require('dgram');
const os = require('os');
const crypto = require('crypto');
const { log } = require('./logger');

const PORT = 50000;
const RECV_BUFFER = 65535;          // [규칙 2] UDP 프로토콜 최대치. 1024/2048 같은 임의값 금지.
                                     // (참고: 이건 Node.js dgram이라 Python의 recvfrom(N)처럼
                                     //  큰 패킷이 WSAEMSGSIZE로 잘려나가는 문제 자체는 없다.
                                     //  Node는 데이터그램 전체를 그대로 message 이벤트로 준다.
                                     //  다만 OS 수신 버퍼 힌트는 그대로 최대치로 잡아둔다.)
const HELLO_INTERVAL_MS = 3000;     // [이슈1] 5초→3초. 무선 환경에서 패킷 한두 개가 유실돼도
                                     // 빨리 다음 신호가 가서 "일부 인원 미노출"이 오래가지 않게 한다.
const PEER_TIMEOUT_MS = 12000;      // 하트비트 4번(=12초) 연속으로 놓쳐야 오프라인 처리 - 순간적인
                                     // 패킷 유실 한두 번 정도는 사람이 사라져 보이지 않게 여유를 둔다.
const PROTOCOL_VERSION = 1;         // [규칙 7] 배포 시점이 갈리면 구/신 버전이 섞인다.

const MY_ID = crypto.randomUUID().slice(0, 8);
const knownPeers = new Map(); // id -> { nickname, ip, lastSeen }
let myNickname = null; // JOIN에 즉시 HELLO로 응답할 때 쓴다

let diagnosticsHandler = () => {};
/** 수신 장애/복구/버전 불일치 같은 진단 이벤트를 상위(game.js → UI)로 올려보낸다.
 *  [규칙 4] 로그 파일만으로는 사용자가 못 보므로, 화면에도 띄울 수 있게 콜백을 둔다. */
function setDiagnosticsHandler(fn) { diagnosticsHandler = fn; }

/** 활성 네트워크 어댑터별 (내 IP, 그 어댑터의 브로드캐스트 주소) 목록. */
function getLocalIPv4Interfaces() {
  const result = [];
  const ifaces = os.networkInterfaces();
  for (const entries of Object.values(ifaces)) {
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
 * [규칙 5 - 절대 최적화하지 말 것] obj를 "어댑터마다 각각" 전송한다.
 * <broadcast>(255.255.255.255)로 한 번만 보내면 OS가 어댑터 하나만 골라 내보내서,
 * 이더넷+Wi-Fi가 동시에 연결된 PC는 반대쪽 네트워크에 있는 사람에게 패킷이 안 간다.
 *
 * 중복 판정은 반드시 (로컬 IP, 목적지) 조합으로 한다. 이더넷과 Wi-Fi가 같은 서브넷이면
 * 목적지(브로드캐스트 주소)가 같아지는데, 이때 "목적지가 같으니 한 번만 보내자"고
 * 중복 제거하면 두 번째 어댑터로는 아예 안 나가서 위 버그가 그대로 재발한다.
 * (실제로 이 "최적화"를 넣었다가 장애를 재발시킨 전례가 있어 여기 남겨둔다.)
 */
function sendBroadcast(obj) {
  const data = Buffer.from(JSON.stringify(obj), 'utf-8');
  let interfaces = getLocalIPv4Interfaces();
  if (interfaces.length === 0) interfaces = [{ address: null, broadcast: '255.255.255.255' }];

  // [이슈1] 넷마스크 계산이 특정 어댑터(가상 어댑터, 특이한 서브넷 등)에서 어긋나면 그
  // 어댑터로는 아예 안 나갈 수 있다. 계산된 서브넷 브로드캐스트에 더해 같은 어댑터에서
  // 255.255.255.255로도 한 번 더 보내서, 계산이 틀려도 최소한 그 어댑터 자체로는 나가게 한다.
  const targets = [];
  for (const iface of interfaces) {
    targets.push(iface);
    if (iface.broadcast !== '255.255.255.255') targets.push({ address: iface.address, broadcast: '255.255.255.255' });
  }

  const seen = new Set();
  for (const { address, broadcast } of targets) {
    const key = `${address}|${broadcast}`; // 목적지만으로 dedup 금지 - 반드시 (로컬IP, 목적지) 조합
    if (seen.has(key)) continue;
    seen.add(key);

    const sock = dgram.createSocket('udp4');
    sock.on('error', (err) => {
      // [규칙 4] 송신 실패도 조용히 넘어가지 않는다. 흔한 원인: 방화벽/보안에이전트가
      // 이 프로세스의 아웃바운드 자체를 막은 경우.
      log(`[송신 실패] 브로드캐스트(${address || '기본'} → ${broadcast}) 소켓 오류: ${err.message}`);
      sock.close();
    });
    sock.bind(0, address || undefined, () => {
      sock.setBroadcast(true);
      sock.send(data, PORT, broadcast, (err) => {
        if (err) log(`[송신 실패] 브로드캐스트(${address || '기본'} → ${broadcast}) 전송 오류: ${err.message}`);
        sock.close();
      });
    });
  }
}

/** 특정 피어에게만 보내는 유니캐스트. 라이어 게임의 제시어처럼 모두에게 알려지면 안 되는
 *  정보를 보낼 때 쓴다 (브로드캐스트와 달리 지정한 IP 한 곳으로만 간다). */
function sendUnicast(obj, targetIp) {
  const data = Buffer.from(JSON.stringify(obj), 'utf-8');
  const sock = dgram.createSocket('udp4');
  sock.on('error', (err) => {
    log(`[송신 실패] 유니캐스트(→ ${targetIp}) 소켓 오류: ${err.message}`);
    sock.close();
  });
  sock.send(data, PORT, targetIp, (err) => {
    if (err) log(`[송신 실패] 유니캐스트(→ ${targetIp}) 전송 오류: ${err.message}`);
    sock.close();
  });
}

function touchPeer(id, nickname, ip) {
  if (id === MY_ID) return false;
  const isNewPeer = !knownPeers.has(id);
  knownPeers.set(id, { nickname, ip, lastSeen: Date.now() });
  return isNewPeer;
}

/** [규칙 6] 서버 없는 P2P라 "온라인 N명"은 내가 받은 하트비트로 스스로 계산한 로컬 추정치다.
 *  사람마다 다르게 보일 수 있고, 그 불일치 자체가 "특정 구간만 수신이 막혔다"는 진단 단서다. */
function getOnlinePeers() {
  const now = Date.now();
  const online = [];
  for (const [id, info] of knownPeers) {
    if (now - info.lastSeen <= PEER_TIMEOUT_MS) online.push({ id, ...info });
  }
  return online;
}

/**
 * [규칙 1] 수신 루프는 어떤 예외에도 죽지 않는다.
 * - "소켓 자체가 죽은 오류"(sock.on('error'))와 "패킷 하나 파싱/처리 실패"(message 핸들러
 *   내부 try/catch)를 구분한다. 전자만 소켓을 재생성하고, 후자는 그 패킷만 버리고 계속 듣는다.
 *   파싱 실패로 소켓을 매번 재생성하면 그때마다 수 초씩 수신이 통째로 멈춘다.
 * [규칙 4] 두 경로 모두 반드시 로그를 남긴다. 복구됐을 때도 남긴다.
 */
function startReceiver(onMessage) {
  let hasFailedBefore = false;

  function open() {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true, recvBufferSize: RECV_BUFFER });

    sock.on('message', (data, rinfo) => {
      try {
        const msg = JSON.parse(data.toString('utf-8'));

        let isNewPeer = false;
        if (msg.type === 'HELLO' || msg.type === 'JOIN') {
          // JOIN도 등록해야, 새로 들어온 사람이 다음 HELLO를 기다리지 않고
          // 기존 참가자를 즉시 알 수 있다 (반대 방향은 이미 JOIN 브로드캐스트로 해결되어 있었음).
          isNewPeer = touchPeer(msg.id, msg.nickname, rinfo.address);
        }
        // [이슈1 핵심] 새로 들어온 사람의 JOIN을 보면, 다음 정기 HELLO(최대 3초 뒤)를
        // 기다리지 않고 즉시 내 존재를 알려준다. 이게 없으면 "먼저 있던 사람"을
        // "늦게 들어온 사람"이 몇 초간 못 보는 비대칭이 계속 생긴다.
        // HELLO에는 반응하지 않게 해서(JOIN에만 반응) 무한 응답 루프를 막는다.
        if (msg.type === 'JOIN' && isNewPeer && myNickname) {
          sendBroadcast({ type: 'HELLO', id: MY_ID, nickname: myNickname, version: PROTOCOL_VERSION });
        }
        if (msg.type === 'HELLO') {
          // [규칙 7] 나와 다른 버전이 감지되면 사용자에게 알린다. 조용히 무시하면
          // "일부만 안 되는" 것처럼 보여서 원인 파악이 매우 어려워진다.
          if (msg.version !== undefined && msg.version !== PROTOCOL_VERSION) {
            log(`[버전 불일치] ${rinfo.address}(${msg.nickname || msg.id})의 버전 ${msg.version} != 내 버전 ${PROTOCOL_VERSION}`);
            diagnosticsHandler({ type: 'versionMismatch', peerVersion: msg.version, myVersion: PROTOCOL_VERSION });
          }
        }

        onMessage(msg, rinfo);
      } catch (err) {
        // 패킷 하나 파싱/처리 실패는 그 패킷만 버리고 계속 수신한다 (소켓 재생성 금지).
        // 다만 원인 진단을 위해 반드시 로그는 남긴다 - [규칙 4].
        log(`[수신 경고] 패킷 처리 실패(무시하고 계속 수신) from ${rinfo.address}: ${err.message}`);
      }
    });

    sock.on('error', (err) => {
      // 여기로 오는 건 "소켓 자체가 죽은" 경우다 (예: 다른 프로세스가 이미 50000번 포트를
      // 쓰고 있어 bind 실패 - 흔히 이 exe를 두 번 실행했을 때 발생).
      log(`[수신 실패] 수신 소켓 오류 - 2초 후 재생성: ${err.message}`);
      diagnosticsHandler({ type: 'receiveLost', message: err.message });
      hasFailedBefore = true;
      sock.close();
      setTimeout(open, 2000);
    });

    sock.on('listening', () => {
      if (hasFailedBefore) {
        log('[수신 복구] 수신 소켓이 다시 정상적으로 열렸습니다.');
        diagnosticsHandler({ type: 'receiveRecovered' });
      }
    });

    sock.bind(PORT, '0.0.0.0');
  }
  open();
}

function startPresence(nickname) {
  myNickname = nickname;
  const hello = () => sendBroadcast({ type: 'HELLO', id: MY_ID, nickname: myNickname, version: PROTOCOL_VERSION });
  hello();
  return setInterval(hello, HELLO_INTERVAL_MS);
}

module.exports = {
  PORT, MY_ID, PROTOCOL_VERSION,
  getLocalIPv4Interfaces, sendBroadcast, sendUnicast,
  startReceiver, startPresence, getOnlinePeers,
  setDiagnosticsHandler,
};

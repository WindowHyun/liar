'use strict';

/**
 * lan_alarm.py의 UDP 브로드캐스트 방식을 그대로 옮긴 LAN 통신 모듈.
 *
 * 아래 체크리스트(사용자 제공 - 과거 같은 종류의 프로그램에서 반복됐던 장애 원인 목록)를
 * 기준으로 점검·수정함. 각 처리 옆에 어떤 규칙에 대응하는지 주석으로 남긴다 - 이유가
 * 안 적혀 있으면 나중에 "불필요한 중복"으로 오인해 제거했다가 같은 장애가 재발한다.
 *
 * ── v0.5에서 추가된 전송 신뢰성 계층 ────────────────────────────────────────
 * [P0-1] 수신 중복 제거: 이 모듈은 "어댑터 × 목적지" 조합마다 같은 내용을 각각 내보낸다
 *        (규칙 5 + 이슈1). 그래서 어댑터가 하나뿐인 PC도 브로드캐스트 1건을 항상 2번
 *        수신한다(서브넷 브로드캐스트 1 + 255.255.255.255 1). 이더넷+Wi-Fi가 같은
 *        서브넷이면 4번이다. 실제로 재현해서 확인한 동작이다.
 *
 *          --- DESC 1건 브로드캐스트 ---
 *          수신 #1: {"type":"DESC",...,"text":"빨갛습니다"} from 192.0.2.2
 *          수신 #2: {"type":"DESC",...,"text":"빨갛습니다"} from 192.0.2.2
 *
 *        송신 전략은 절대 건드리지 않는다(그러면 이슈1이 재발한다). 대신 모든 메시지에
 *        msgId를 실어 보내고, 수신부에서 이미 본 msgId를 버린다. 즉 중복은 "생기게 두되
 *        받는 쪽에서 걷어낸다".
 *
 * [P0-3] ACK / 재전송: UDP는 유실돼도 아무도 모른다. 특히 제시어(WORD)는 유니캐스트
 *        1회 전송이라 한 번 잃으면 그 사람은 그 라운드를 통째로 못 한다.
 *        - 유니캐스트: needAck를 실어 보내고 ACK가 올 때까지 300ms 간격 3회 재전송.
 *          그래도 응답이 없으면 조용히 넘어가지 않고 로그 + 진단 이벤트로 올린다(규칙 4).
 *        - 브로드캐스트: 받는 사람이 몇 명인지 전송 계층은 모르므로 ACK를 쓰지 않고,
 *          같은 msgId로 그냥 3회 더 뿌린다. 중복은 위 [P0-1] 필터가 알아서 걷어낸다.
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
const PROTOCOL_VERSION = 2;         // [규칙 7] 배포 시점이 갈리면 구/신 버전이 섞인다.
                                     // 1→2: msgId(중복 제거)·ACK·라운드 호스트 권위가 들어가면서
                                     // 메시지 형식이 바뀌었다. v1과 섞이면 결과가 어긋나므로
                                     // 반드시 올려서 사용자에게 "버전이 다르다"고 보이게 한다.

const DEDUP_TTL_MS = 10000;         // [P0-1] 같은 msgId를 이 시간 동안 기억한다. 재전송 창(최대
                                     // 900ms)보다 넉넉히 길게 잡아 재전송분까지 확실히 걸러낸다.
const DEDUP_MAX = 512;              // 메모리 상한. 오래된 것부터 버린다.
const ACK_RETRY_MS = 300;           // [P0-3] 재전송 간격
const ACK_MAX_RETRIES = 3;          // [P0-3] 최초 1회 + 재전송 3회 = 총 4번 보낸다
const BROADCAST_REPEATS = 3;        // [P0-3] 브로드캐스트는 ACK 없이 같은 msgId로 3회 더 뿌린다

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

// ───────────────────────── 메시지 식별자 / 중복 제거 [P0-1] ─────────────────────────

let msgSeq = 0;
const seenMsgIds = new Map(); // msgId -> 처음 본 시각

function nextMsgId() {
  msgSeq += 1;
  return `${MY_ID}-${msgSeq}`;
}

/** 아직 msgId가 없는 메시지에만 새로 붙인다. 재전송은 "같은 msgId"로 나가야 수신측에서
 *  중복으로 걸러지므로, 이미 붙어 있으면 절대 새로 만들지 않는다. 원본 객체는 건드리지 않는다. */
function stampMsgId(obj) {
  return obj.msgId ? obj : { ...obj, msgId: nextMsgId() };
}

/** 이미 처리한 메시지면 true. msgId가 없는 메시지(구버전 피어)는 거를 방법이 없으므로 통과시킨다. */
function isDuplicate(msgId) {
  if (!msgId) return false;
  const now = Date.now();
  const firstSeen = seenMsgIds.get(msgId);
  if (firstSeen !== undefined && now - firstSeen <= DEDUP_TTL_MS) return true;

  seenMsgIds.delete(msgId); // 재삽입 시 "가장 최근"으로 밀어 넣기 위해(Map은 삽입 순서를 유지)
  seenMsgIds.set(msgId, now);

  for (const [id, at] of seenMsgIds) {
    if (now - at <= DEDUP_TTL_MS && seenMsgIds.size <= DEDUP_MAX) break;
    seenMsgIds.delete(id);
  }
  return false;
}

// ───────────────────────────────── 송신 ─────────────────────────────────

/** 소켓은 한 번만 닫는다. 이미 닫힌 dgram 소켓에 close()를 다시 부르면
 *  ERR_SOCKET_DGRAM_NOT_RUNNING이 콜백 안에서 던져져 프로세스가 통째로 죽는다.
 *  error 핸들러와 send 콜백이 둘 다 타는 경우(방화벽이 아웃바운드를 막은 경우 등)가 실제로 있다. */
function safeClose(sock) {
  if (sock.__closed) return;
  sock.__closed = true;
  try { sock.close(); } catch { /* 이미 닫힘 */ }
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
 *
 * 이 함수가 한 번의 논리적 메시지를 여러 데이터그램으로 내보내기 때문에, 받는 쪽은
 * 같은 메시지를 여러 번 받는다. 그건 정상이고, 수신부의 msgId 필터가 걷어낸다 - [P0-1].
 */
function sendBroadcast(obj) {
  const msg = stampMsgId(obj);
  const data = Buffer.from(JSON.stringify(msg), 'utf-8');
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
      safeClose(sock);
    });
    sock.bind(0, address || undefined, () => {
      sock.setBroadcast(true);
      sock.send(data, PORT, broadcast, (err) => {
        if (err) log(`[송신 실패] 브로드캐스트(${address || '기본'} → ${broadcast}) 전송 오류: ${err.message}`);
        safeClose(sock);
      });
    });
  }
  return msg.msgId;
}

/** 특정 피어에게만 보내는 유니캐스트. 라이어 게임의 제시어처럼 모두에게 알려지면 안 되는
 *  정보를 보낼 때 쓴다 (브로드캐스트와 달리 지정한 IP 한 곳으로만 간다). */
function sendUnicast(obj, targetIp) {
  // [P1-11] 목적지가 비어 있으면 Node dgram은 조용히 127.0.0.1로 보낸다. 그러면 남에게
  // 갈 제시어가 내 프로세스로 되돌아와 내 역할을 덮어쓴다. 절대 그냥 보내지 않는다.
  if (!targetIp) {
    log(`[송신 실패] 유니캐스트 목적지 IP가 없어 전송을 취소함 (type=${obj.type})`);
    return null;
  }
  const msg = stampMsgId(obj);
  const data = Buffer.from(JSON.stringify(msg), 'utf-8');
  const sock = dgram.createSocket('udp4');
  sock.on('error', (err) => {
    log(`[송신 실패] 유니캐스트(→ ${targetIp}) 소켓 오류: ${err.message}`);
    safeClose(sock);
  });
  sock.send(data, PORT, targetIp, (err) => {
    if (err) log(`[송신 실패] 유니캐스트(→ ${targetIp}) 전송 오류: ${err.message}`);
    safeClose(sock);
  });
  return msg.msgId;
}

// ─────────────────────── 유실 대비 재전송 [P0-3] ───────────────────────

const pendingAcks = new Map(); // msgId -> setTimeout 핸들

/**
 * 반드시 도착해야 하는 브로드캐스트(START, CALL_VOTE, ACCUSED, REVEAL, RESULT 등).
 * 받는 사람이 몇 명인지 전송 계층은 알 수 없으므로 ACK를 쓰지 않고, 같은 msgId로 그냥
 * 몇 번 더 뿌린다. 중복은 수신부의 msgId 필터가 걷어내므로 받는 쪽에는 1건으로 보인다.
 */
function sendBroadcastReliable(obj, repeats = BROADCAST_REPEATS) {
  const msg = stampMsgId(obj);
  sendBroadcast(msg);
  for (let i = 1; i <= repeats; i += 1) {
    setTimeout(() => sendBroadcast(msg), i * ACK_RETRY_MS).unref?.();
  }
  return msg.msgId;
}

/**
 * 반드시 도착해야 하는 유니캐스트(WORD). ACK가 올 때까지 재전송하고, 끝내 못 받으면
 * onFail로 알린다. [규칙 4] 조용히 실패하지 않는다 - 제시어를 못 받은 사람이 생기면
 * 보낸 쪽 화면에도, 받는 쪽 화면에도 그 사실이 떠야 한다.
 */
function sendUnicastReliable(obj, targetIp, onFail) {
  if (!targetIp) {
    log(`[전달 실패] ${obj.type} 전송 대상 IP를 모른다 - 전송하지 않음`);
    if (onFail) onFail('noAddress');
    return null;
  }
  const msg = stampMsgId({ ...obj, needAck: true });
  let tries = 0;

  const fire = () => {
    if (tries > ACK_MAX_RETRIES) {
      pendingAcks.delete(msg.msgId);
      log(`[전달 실패] ${msg.type} → ${targetIp}: ${ACK_MAX_RETRIES}회 재전송했으나 ACK 없음`);
      diagnosticsHandler({ type: 'deliveryFailed', messageType: msg.type, targetIp });
      if (onFail) onFail('noAck');
      return;
    }
    tries += 1;
    sendUnicast(msg, targetIp);
    pendingAcks.set(msg.msgId, setTimeout(fire, ACK_RETRY_MS));
  };

  fire();
  return msg.msgId;
}

function resolveAck(msgId) {
  const timer = pendingAcks.get(msgId);
  if (timer === undefined) return;
  clearTimeout(timer);
  pendingAcks.delete(msgId);
}

/** 이 라운드에서 더 이상 의미 없어진 재전송을 멈춘다(예: 동시 시작 충돌로 내 라운드를 접었을 때). */
function cancelPending(msgId) { resolveAck(msgId); }

function touchPeer(id, nickname, ip) {
  if (!id || id === MY_ID) return false;
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

        // [P0-3] ACK는 전송 계층에서 소비하고 게임 로직까지 올리지 않는다.
        if (msg.type === 'ACK') { resolveAck(msg.ackFor); return; }

        // [P0-3] ACK 응답은 중복 제거보다 "먼저" 보낸다. 첫 ACK가 유실돼 상대가 재전송했는데
        // 여기서 중복이라고 버리면 ACK를 다시 안 보내게 되고, 상대는 잘 도착한 메시지를
        // 끝내 실패로 판정한다.
        if (msg.needAck && msg.msgId) sendUnicast({ type: 'ACK', id: MY_ID, ackFor: msg.msgId }, rinfo.address);

        // [P0-1] 여기서 중복을 걷어낸다. 이 줄이 없으면 채팅 한 줄이 두 번 찍히고,
        // "게임이 시작되었습니다"가 두 번 뜨고, 결과가 여러 번 확정된다.
        if (isDuplicate(msg.msgId)) return;

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
        if (msg.type === 'HELLO' || msg.type === 'JOIN') {
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
      // 여기로 오는 건 "소켓 자체가 죽은" 경우다.
      // 주의: 이 소켓은 reuseAddr로 열기 때문에, 같은 PC에서 이 프로그램을 두 번 실행해도
      // bind는 대체로 성공한다(EADDRINUSE가 안 난다). 대신 브로드캐스트는 양쪽 다 받지만
      // 유니캐스트(제시어)는 한쪽에만 도착해서, 다른 한 명이 조용히 역할을 못 받는다.
      // → 2중 실행은 이 오류로 잡히지 않으므로 앱 진입점의 단일 인스턴스 락으로 막아야 한다.
      log(`[수신 실패] 수신 소켓 오류 - 2초 후 재생성: ${err.message}`);
      diagnosticsHandler({ type: 'receiveLost', message: err.message });
      hasFailedBefore = true;
      safeClose(sock);
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
  PORT, MY_ID, PROTOCOL_VERSION, PEER_TIMEOUT_MS,
  getLocalIPv4Interfaces, sendBroadcast, sendUnicast,
  sendBroadcastReliable, sendUnicastReliable, cancelPending,
  startReceiver, startPresence, getOnlinePeers,
  setDiagnosticsHandler,
};

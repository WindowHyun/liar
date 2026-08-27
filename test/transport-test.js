'use strict';

/**
 * 전송 계층(network.js) 회귀 테스트 - 실제 UDP를 그대로 쓴다.
 *
 * 여기서 잡는 것:
 *   1. [P0-1] 브로드캐스트 1건이 수신부에 정확히 1번만 올라오는가
 *      (송신은 어댑터 × 목적지만큼 여러 번 나간다. 중복 제거가 빠지면 2번 이상 올라온다.)
 *   2. [P0-3] 재전송분이 같은 msgId로 나가서 역시 1번만 올라오는가
 *   3. [P0-3] 유니캐스트가 ACK를 받으면 재전송을 멈추고 실패로 판정하지 않는가
 *   4. [P0-3] 응답 없는 상대에게는 조용히 넘어가지 않고 실패를 알리는가
 *   5. [P1-11] 목적지 IP가 비면 127.0.0.1로 새지 않고 전송을 취소하는가
 *
 * 실행: node test/transport-test.js
 */

const net = require('../network');

const received = [];
net.startReceiver((msg) => received.push(msg));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const countOf = (tag) => received.filter((m) => m.tag === tag).length;

async function main() {
  await wait(300); // 수신 소켓이 열릴 시간

  // 1. 단발 브로드캐스트
  net.sendBroadcast({ type: 'DESC', tag: 't1', id: 'PEER-A', nickname: '홍길동', text: '빨갛습니다' });
  await wait(600);
  check('[P0-1] 브로드캐스트 1건 → 수신 1건', countOf('t1') === 1, `수신 ${countOf('t1')}건`);

  // 2. 재전송이 붙는 브로드캐스트 (같은 msgId로 4번 나간다)
  net.sendBroadcastReliable({ type: 'START', tag: 't2', id: 'PEER-A', roundId: 'r1', roster: [{ id: 'PEER-A', nickname: '홍길동' }] });
  await wait(1600);
  check('[P0-3] 재전송 포함 브로드캐스트 → 수신 1건', countOf('t2') === 1, `수신 ${countOf('t2')}건`);

  // 3. ACK를 받는 유니캐스트 (내 수신 소켓이 127.0.0.1로 받아 ACK를 돌려준다)
  let failed3 = null;
  net.sendUnicastReliable({ type: 'WORD', tag: 't3', roundId: 'r1', to: net.MY_ID, category: '과일', word: '사과', isLiar: false }, '127.0.0.1', (why) => { failed3 = why; });
  await wait(1600);
  check('[P0-3] ACK 받은 유니캐스트 → 실패 처리 안 함', failed3 === null, failed3 || 'onFail 미호출');
  check('[P0-3] ACK 받은 유니캐스트 → 수신 1건', countOf('t3') === 1, `수신 ${countOf('t3')}건`);

  // 4. 아무도 없는 주소 (TEST-NET 대역의 빈 IP) → 재전송 소진 후 실패 통보
  let failed4 = null;
  const t0 = Date.now();
  net.sendUnicastReliable({ type: 'WORD', tag: 't4', roundId: 'r1', to: 'nobody', category: '과일', word: '사과', isLiar: false }, '192.0.2.99', (why) => { failed4 = why; });
  await wait(2500);
  check('[P0-3] 응답 없는 상대 → 조용히 넘어가지 않고 실패 통보',
    failed4 === 'noAck', `onFail=${failed4}, ${Date.now() - t0}ms`);

  // 5. 목적지 IP가 undefined
  const before = received.length;
  const ret = net.sendUnicast({ type: 'WORD', tag: 't5', roundId: 'r1', to: 'someone-else', category: '과일', word: '남의제시어', isLiar: false }, undefined);
  await wait(600);
  const leaked = received.filter((m) => m.tag === 't5').length;
  check('[P1-11] 목적지 IP가 없으면 전송 취소 (127.0.0.1로 새지 않음)',
    ret === null && leaked === 0, `반환=${ret}, 자기수신=${leaked}건, 총수신증가=${received.length - before}`);

  // 6. [P3-33] 형식이 어긋난 패킷은 게임 로직에 닿기 전에 버려진다
  const bad = [
    { type: 'DESC', tag: 't6a', id: 'PEER-A', text: '닉네임이 없다' },        // nickname 누락
    { type: 'GUESS', tag: 't6b', id: 'PEER-A', roundId: 'r1', word: 12345 },   // word가 문자열이 아님
    { type: 'START', tag: 't6c', id: 'PEER-A', roundId: 'r1', roster: 'x' },   // roster가 배열이 아님
    { type: 'DESC', tag: 't6d', id: 'PEER-A', nickname: '홍', text: 'x'.repeat(5000) }, // 길이 초과
    { type: '알수없음', tag: 't6e' },                                          // 모르는 type
  ];
  for (const m of bad) net.sendBroadcast(m);
  await wait(800);
  const leakedBad = bad.filter((m) => countOf(m.tag) > 0).map((m) => m.tag);
  check('[P3-33] 형식이 어긋난 패킷은 게임 로직에 올라오지 않음',
    leakedBad.length === 0, leakedBad.length ? `통과해버림: ${leakedBad.join(',')}` : '5종 모두 차단');

  // 7. 정상 패킷은 그대로 통과한다 (검증기가 지나치게 막지 않는지)
  net.sendBroadcast({ type: 'DESC', tag: 't7', id: 'PEER-A', nickname: '홍길동', text: '정상 메시지' });
  await wait(600);
  check('[P3-33] 정상 패킷은 정상 통과', countOf('t7') === 1, `수신 ${countOf('t7')}건`);

  const failedCount = results.filter((r) => !r.ok).length;
  console.log(`\n전송 계층: ${results.length - failedCount}/${results.length} 통과`);
  process.exit(failedCount === 0 ? 0 : 1);
}

main();

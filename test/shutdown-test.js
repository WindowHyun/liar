'use strict';

/**
 * 종료 정리(electron/shutdown.js) 테스트.
 *
 * 여기서 잡는 것은 하나다 - 정리 하나가 실패해도 종료는 끝까지 가야 한다.
 * 예전에는 peer.stop()이 실패하면 app.quit()까지 가지 못했고, 프로세스가 게임
 * 포트(55500)와 화면 포트를 쥔 채 남았다. 다음에 앱을 켜면 "포트를 다른 프로그램이
 * 쓰고 있습니다"가 뜨는데, 원인이 방금 닫은 자기 자신이라 짚어낼 방법이 없었다.
 *
 * 실행: node test/shutdown-test.js
 */

const { runSteps } = require('../electron/shutdown');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

async function s1_allStepsRun() {
  const done = [];
  await runSteps([
    ['하나', () => done.push(1)],
    ['둘', async () => { done.push(2); }],
    ['셋', () => done.push(3)],
  ]);
  check('S1 정리가 순서대로 모두 돈다', done.join(',') === '1,2,3', done.join(','));
}

async function s2_failureDoesNotStop() {
  const done = [];
  const errs = [];
  await runSteps([
    ['하나', () => done.push(1)],
    ['터지는 것', () => { throw new Error('동기 실패'); }],
    ['셋', () => done.push(3)],
    ['거부하는 것', async () => { throw new Error('비동기 실패'); }],
    ['다섯', () => done.push(5)],
  ], (what, err) => errs.push(`${what}:${err.message}`));

  check('S2 [이슈] 하나가 실패해도 나머지 정리를 계속한다',
    done.join(',') === '1,3,5', done.join(','));
  check('S2 동기 실패와 비동기 실패를 모두 잡는다',
    errs.length === 2, errs.join(' / '));
  check('S2 어느 단계가 실패했는지 남긴다',
    errs[0].startsWith('터지는 것') && errs[1].startsWith('거부하는 것'), errs.join(' / '));
}

async function s3_neverThrows() {
  // 이 함수가 던지면 부른 쪽(종료 경로)이 멈춘다. 무슨 일이 있어도 던지면 안 된다.
  let threw = false;
  try {
    await runSteps([
      ['터지는 것', () => { throw new Error('실패'); }],
    ], () => { throw new Error('로그조차 실패'); });   // 로그마저 터지는 최악의 경우
  } catch { threw = true; }
  check('S3 로그까지 실패해도 위로 던지지 않는다', !threw);

  let threw2 = false;
  try { await runSteps([['터지는 것', () => { throw new Error('실패'); }]]); } catch { threw2 = true; }
  check('S3 오류 처리기를 안 줘도 던지지 않는다', !threw2);
}

async function s4_quitIsReached() {
  // 실제 종료 경로의 모양. peer 정리가 실패해도 화면 서버 정리와 quit까지 가야 한다.
  const log = [];
  await runSteps([
    ['알림 정리', () => log.push('알림')],
    ['참가자 발견/게임 서버 정리', async () => { throw new Error('EADDRINUSE 흉내'); }],
    ['화면 서버 정리', () => log.push('화면서버')],
  ], () => {});
  log.push('quit');
  check('S4 peer 정리가 실패해도 화면 서버를 닫고 종료까지 간다',
    log.join(',') === '알림,화면서버,quit', log.join(','));
}

(async () => {
  for (const fn of [s1_allStepsRun, s2_failureDoesNotStop, s3_neverThrows, s4_quitIsReached]) {
    try { await fn(); } catch (err) { check(`${fn.name} 실행 중 예외`, false, err.message); }
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n종료 정리: ${results.length - failed}/${results.length} 통과`);
  process.exit(failed === 0 ? 0 : 1);
})();

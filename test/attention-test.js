'use strict';

/**
 * 알림(트레이/작업 표시줄 깜빡임) 규칙 테스트.
 *
 * 여기서 잡는 것은 실제로 신고가 들어온 두 가지다.
 *   A1 창이 눈앞에 있으면 알리지 않는다 - 특히 "초점만 잃은" 상태는 알림 대상이 아니다.
 *      (사무실에서는 게임 창을 띄워 둔 채 다른 일을 하는 것이 보통이라, 초점을 기준으로
 *       잡으면 대화가 올 때마다 깜빡임이 다시 걸려 "계속 깜빡인다"가 된다.)
 *   A2 깜빡임은 스스로 멈춘다 - 자리를 비운 사이 몇 분이고 깜빡이면 그게 더 성가시다.
 *
 * 실행: node test/attention-test.js
 */

const { createAttention, needsAttention } = require('../electron/attention');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

/** 창 흉내. Electron 없이 상태만 바꿔 가며 본다. */
function fakeWindow(state) {
  return Object.assign({
    minimized: false, visible: true, destroyed: false,
    isMinimized() { return this.minimized; },
    isVisible() { return this.visible; },
    isDestroyed() { return this.destroyed; },
  }, state);
}

// ── 가상 시계 ──
function clockFactory() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    api: {
      setTimeout: (fn, ms) => { seq += 1; timers.set(seq, { at: now + ms, fn, repeat: 0 }); return seq; },
      clearTimeout: (id) => timers.delete(id),
      setInterval: (fn, ms) => { seq += 1; timers.set(seq, { at: now + ms, fn, repeat: ms }); return seq; },
      clearInterval: (id) => timers.delete(id),
    },
    advance(ms) {
      const target = now + ms;
      for (let guard = 0; guard < 1000; guard += 1) {
        let next = null;
        for (const [id, t] of timers) if (!next || t.at < next[1].at) next = [id, t];
        if (!next || next[1].at > target) break;
        now = next[1].at;
        if (next[1].repeat) next[1].at = now + next[1].repeat; else timers.delete(next[0]);
        next[1].fn();
      }
      now = target;
    },
  };
}

// ── A1 언제 알리는가 ──
function a1_whenToAlert() {
  check('A1 창이 보이고 있으면 알리지 않는다',
    needsAttention(fakeWindow({ minimized: false, visible: true })) === false);
  check('A1 [이슈] 초점만 잃은 것은 알림 대상이 아니다 (계속 깜빡이던 원인)',
    needsAttention(fakeWindow({ minimized: false, visible: true, focused: false })) === false);
  check('A1 [요청] 최소화했으면 알린다',
    needsAttention(fakeWindow({ minimized: true })) === true);
  check('A1 창이 숨겨져 있어도 알린다',
    needsAttention(fakeWindow({ visible: false })) === true);
  check('A1 창이 없거나 이미 닫혔으면 알리지 않는다',
    needsAttention(null) === false && needsAttention(fakeWindow({ destroyed: true })) === false);
}

// ── A2 얼마나 깜빡이는가 ──
function a2_blinkStopsByItself() {
  const clock = clockFactory();
  let frames = 0;
  let stops = 0;
  const att = createAttention(Object.assign({
    blinkMs: 600, maxMs: 10000,
    onFrame: () => { frames += 1; },
    onStop: () => { stops += 1; },
  }, clock.api));

  check('A2 보고 있는 창에는 시작하지 않는다',
    att.start(fakeWindow({ minimized: false, visible: true })) === false && !att.isBlinking());

  const away = fakeWindow({ minimized: true });
  check('A2 내려 둔 창에는 시작한다', att.start(away) === true && att.isBlinking());

  clock.advance(3000);
  check('A2 깜빡이고 있다', frames >= 4, `${frames}칸`);

  clock.advance(8000); // 시작으로부터 11초
  check('A2 [이슈] 정해진 시간이 지나면 스스로 멈춘다 (영영 깜빡이지 않는다)',
    !att.isBlinking() && stops === 1, `깜빡임=${att.isBlinking()} 멈춤=${stops}회`);

  const before = frames;
  clock.advance(5000);
  check('A2 멈춘 뒤에는 더 깜빡이지 않는다', frames === before, `${frames - before}칸 더`);
}

function a3_newArrivalExtends() {
  const clock = clockFactory();
  let stops = 0;
  const att = createAttention(Object.assign({
    blinkMs: 600, maxMs: 10000, onFrame: () => {}, onStop: () => { stops += 1; },
  }, clock.api));
  const away = fakeWindow({ minimized: true });

  att.start(away);
  clock.advance(8000);
  att.start(away); // 8초 시점에 새 대화가 왔다 - 그만큼 더 알려야 한다
  clock.advance(4000); // 처음 시작으로부터 12초, 두 번째로부터 4초
  check('A3 새로 온 것이 있으면 시간을 다시 채운다', att.isBlinking() && stops === 0,
    `깜빡임=${att.isBlinking()} 멈춤=${stops}회`);

  clock.advance(7000);
  check('A3 그 뒤로도 결국 멈춘다', !att.isBlinking() && stops === 1);
}

function a4_stopIsIdempotent() {
  const clock = clockFactory();
  let stops = 0;
  const att = createAttention(Object.assign({
    blinkMs: 600, maxMs: 10000, onFrame: () => {}, onStop: () => { stops += 1; },
  }, clock.api));
  att.start(fakeWindow({ minimized: true }));
  att.stop();
  att.stop();
  check('A4 창을 다시 봤을 때 여러 번 꺼도 탈이 없다', !att.isBlinking() && stops === 2, `${stops}회`);
  clock.advance(20000);
  check('A4 멈춘 뒤 예약된 타이머가 남지 않는다', stops === 2, `${stops}회`);
}

for (const fn of [a1_whenToAlert, a2_blinkStopsByItself, a3_newArrivalExtends, a4_stopIsIdempotent]) {
  try { fn(); } catch (err) { check(`${fn.name} 실행 중 예외`, false, err.message); }
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n알림(트레이): ${results.length - failed}/${results.length} 통과`);
process.exit(failed === 0 ? 0 : 1);

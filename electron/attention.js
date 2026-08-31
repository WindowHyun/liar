'use strict';

/**
 * "지금 알려야 하는가"와 "얼마나 알릴 것인가"만 담당한다.
 *
 * Electron을 모른다(창은 isMinimized/isVisible/isDestroyed만 물어보는 객체로 받는다).
 * main.js에서 떼어 낸 이유는 두 가지가 실제로 문제를 냈고, 둘 다 규칙이라 테스트로
 * 고정해 둘 값어치가 있기 때문이다.
 *
 *   1) 처음에는 "초점을 잃었으면" 알렸다. 사무실에서는 게임 창을 띄워 둔 채 다른 일을
 *      하는 것이 보통이라 그 상태가 계속 이어지고, 대화가 올 때마다 깜빡임이 다시
 *      걸려서 "화면이 계속 깜빡인다"가 됐다. 창을 내려 뒀을 때만 알린다.
 *   2) 깜빡임이 스스로 멈추지 않아서, 자리를 비우면 몇 분이고 깜빡였다.
 *      알림은 "왔다"는 것만 알리면 된다.
 */

const BLINK_MS = 600;
const BLINK_MAX_MS = 10000;

/** 창을 내려 뒀는가. 다른 창에 가려 초점만 잃은 것은 여기에 들지 않는다. */
function needsAttention(win) {
  if (!win || win.isDestroyed()) return false;
  return win.isMinimized() || !win.isVisible();
}

/**
 * @param onFrame  깜빡임 한 칸. true면 아이콘을 감추고 false면 되돌린다.
 * @param onStop   멈출 때 한 번. 아이콘과 작업 표시줄을 원래대로 돌리는 자리.
 */
function createAttention(options) {
  const opts = options || {};
  const blinkMs = opts.blinkMs || BLINK_MS;
  const maxMs = opts.maxMs || BLINK_MAX_MS;
  const onFrame = opts.onFrame || (() => {});
  const onStop = opts.onStop || (() => {});
  const setIntervalFn = opts.setInterval || setInterval;
  const clearIntervalFn = opts.clearInterval || clearInterval;
  const setTimeoutFn = opts.setTimeout || setTimeout;
  const clearTimeoutFn = opts.clearTimeout || clearTimeout;

  let blinkTimer = null;
  let stopTimer = null;
  let on = false;

  function stop() {
    if (stopTimer) { clearTimeoutFn(stopTimer); stopTimer = null; }
    if (blinkTimer) { clearIntervalFn(blinkTimer); blinkTimer = null; }
    on = false;
    onStop();
  }

  return {
    isBlinking: () => blinkTimer !== null,

    /** 알릴 만한 일이 생겼다. 창이 눈앞에 있으면 아무것도 하지 않는다. */
    start(win) {
      if (!needsAttention(win)) return false;
      // 이미 깜빡이고 있으면 시간만 다시 채운다(새로 온 것이니 그만큼 더 알린다).
      if (stopTimer) clearTimeoutFn(stopTimer);
      stopTimer = setTimeoutFn(stop, maxMs);
      if (blinkTimer) return true;
      blinkTimer = setIntervalFn(() => { on = !on; onFrame(on); }, blinkMs);
      return true;
    },

    stop,
  };
}

module.exports = { createAttention, needsAttention, BLINK_MS, BLINK_MAX_MS };

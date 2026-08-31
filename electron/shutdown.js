'use strict';

/**
 * 종료 정리를 순서대로 돌린다. 하나가 실패해도 멈추지 않고 끝까지 간다.
 *
 * [이슈] 예전에는 창을 모두 닫을 때 이렇게만 했다.
 *
 *     if (peer) await peer.stop();     // 여기서 예외가 나면
 *     if (uiServer) uiServer.stop();   // 아래 두 줄에 닿지 못한다
 *     app.quit();
 *
 * 정리 하나가 실패하면 app.quit()까지 가지 못하고, 프로세스가 게임 포트(55500)와
 * 화면 포트를 쥔 채 남는다. 다음에 앱을 켜면 "포트를 다른 프로그램이 쓰고 있습니다"가
 * 뜨는데, 정작 원인은 방금 닫은 자기 자신이라 사용자가 짚어낼 방법이 없다.
 *
 * 정리는 "되면 좋은 것"이고 종료는 "반드시 되어야 하는 것"이다. 그래서 여기서는
 * 실패를 남기기만 하고 계속 간다. Electron을 모르므로 테스트에서 그냥 부를 수 있다.
 *
 * @param steps   [이름, 함수] 목록. 함수는 동기·비동기 모두 된다.
 * @param onError (이름, 오류)로 불린다. 로그를 남기는 자리.
 */
async function runSteps(steps, onError) {
  const report = onError || (() => {});
  for (const [what, fn] of steps) {
    try {
      await fn();
    } catch (err) {
      // 여기서 다시 던지면 이 함수를 부른 쪽(종료 경로)이 멈춘다. 그러면 안 된다.
      try { report(what, err); } catch { /* 로그조차 실패해도 종료는 계속한다 */ }
    }
  }
}

module.exports = { runSteps };

'use strict';

/**
 * 규칙 4(조용한 실패를 만들지 않는다): console.error만 찍으면 콘솔 창이 없는 빌드
 * (Electron GUI 앱)에서는 아무도 못 본다. 그래서 항상 파일에도 같이 남긴다.
 * "아무도 접속 안 한 상태"와 "내 수신이 죽은 상태"를 구분할 유일한 단서가 이 로그다.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const LOG_PATH = path.join(os.tmpdir(), 'liar-game.log');

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  try { console.error(line); } catch { /* 콘솔이 없는 빌드는 무시 */ }
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch { /* 파일 시스템 문제는 로그만 못 남길 뿐, 앱은 계속 돌아야 함 */ }
}

module.exports = { log, LOG_PATH };

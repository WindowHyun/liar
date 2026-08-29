'use strict';

/**
 * 웹 버전 실행 진입점 - 한 사람만 이걸 켜고, 나머지는 브라우저로 접속한다.
 * 실제 서버는 game-server.js에 있다(Electron 버전과 같은 것을 쓴다).
 */

const os = require('os');
const { createGameServer } = require('./game-server');
const { MIN_PLAYERS } = require('./room');
const { log, error, LOG_PATH } = require('../logger');

const PORT = Number(process.env.PORT) || 4100;

/** 다른 PC에서 접속할 때 쓸 주소. 참가자에게 공유해야 하므로 시작할 때 찍어 준다. */
function lanAddresses() {
  const found = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const info of entries || []) {
      if (info.family === 'IPv4' && !info.internal) found.push(info.address);
    }
  }
  return found;
}

// 웹 버전은 이 프로세스가 유일한 서버다. 여기서 죽으면 접속자 전원이 동시에 튕기고,
// 다시 켜 줄 사람이 없으면 게임이 끝난다. Electron 버전(electron/main.js)과 같은
// 판단으로, 예상 못 한 예외는 크게 남기되 프로세스는 살려 둔다.
process.on('uncaughtException', (err) => {
  error(`[치명적 오류] ${err && err.stack ? err.stack : err}`);
});
process.on('unhandledRejection', (reason) => {
  error(`[처리되지 않은 실패] ${reason && reason.stack ? reason.stack : reason}`);
});

const server = createGameServer({ port: PORT });

server.start().then(() => {
  log(`[시작] 웹 서버 실행 중 (포트 ${PORT})`);
  console.log('');
  console.log('  라이어 게임 (웹 버전) 서버가 실행되었습니다.');
  console.log('');
  console.log(`  내 화면          : http://localhost:${PORT}`);
  for (const ip of lanAddresses()) {
    console.log(`  다른 참가자에게  : http://${ip}:${PORT}`);
  }
  console.log('');
  console.log(`  최소 인원 ${MIN_PLAYERS}명. 문제가 생기면 로그를 확인하세요: ${LOG_PATH}`);
  console.log('');
}).catch((err) => {
  if (err.code === 'EADDRINUSE') {
    error(`[중복 실행] ${PORT}번 포트가 이미 사용 중입니다.`);
    console.error('');
    console.error(`  이미 서버가 실행 중인 것 같습니다. 브라우저에서 http://localhost:${PORT} 로 접속하세요.`);
    console.error('  다른 포트로 띄우려면: PORT=4200 npm run web');
    console.error('');
    process.exit(0);
  }
  error(`[서버 오류] ${err.code || ''} ${err.message}`);
  process.exit(1);
});

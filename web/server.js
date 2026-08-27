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

'use strict';

/** 전체 회귀 테스트 실행: node test/run-all.js */

const { spawnSync } = require('child_process');
const path = require('path');

const suites = [
  'web-room-test.js', 'web-ui-test.js',    // 게임 규칙과 화면 (웹·Electron 공용)
  'fuzz-test.js',                          // 무작위 조작으로 규칙 두들기기
  'connection-test.js',                    // 연결 유지 / 죽은 연결 정리
  'discovery-test.js', 'bridge-test.js',   // Electron - 자동 발견, 호스트 인계
];
let failed = 0;

for (const suite of suites) {
  const r = spawnSync(process.execPath, [path.join(__dirname, suite)], { stdio: 'inherit' });
  if (r.status !== 0) failed += 1;
  console.log('');
}

console.log(failed === 0 ? '전체 통과' : `${failed}개 스위트 실패`);
process.exit(failed === 0 ? 0 : 1);

'use strict';

/** 전체 회귀 테스트 실행: node test/run-all.js */

const { spawnSync } = require('child_process');
const path = require('path');

// LAN(UDP) 버전과 웹 버전 스위트를 모두 돌린다.
const suites = [
  'transport-test.js', 'round-test.js', 'server-test.js', 'ui-test.js',   // LAN 버전
  'web-room-test.js', 'web-ui-test.js',                                   // 웹 버전
  'discovery-test.js', 'bridge-test.js',                                  // Electron 버전
];
let failed = 0;

for (const suite of suites) {
  const r = spawnSync(process.execPath, [path.join(__dirname, suite)], { stdio: 'inherit' });
  if (r.status !== 0) failed += 1;
  console.log('');
}

console.log(failed === 0 ? '전체 통과' : `${failed}개 스위트 실패`);
process.exit(failed === 0 ? 0 : 1);

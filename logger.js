'use strict';

/**
 * 규칙 4(조용한 실패를 만들지 않는다): console.error만 찍으면 콘솔 창이 없는 빌드
 * (Electron GUI 앱)에서는 아무도 못 본다. 그래서 항상 파일에도 같이 남긴다.
 * "아무도 접속 안 한 상태"와 "내 수신이 죽은 상태"를 구분할 유일한 단서가 이 로그다.
 *
 * v0.5에서 고친 것:
 *   [P2-29] 줄마다 PID를 남긴다. 같은 PC에서 두 번 실행되는 일이 실제로 가능하므로
 *           (reuseAddr 때문에 bind가 성공한다) 어느 프로세스가 쓴 줄인지 구분이 필요하다.
 *   [P2-30] appendFileSync를 매 줄 호출하던 것을 비동기 큐 + 200ms 배치로 바꿨다.
 *           잘못된 패킷이 쏟아지면 그때마다 동기 디스크 쓰기가 이벤트 루프를 세웠다.
 *   [P2-28] 5MB를 넘으면 .1로 밀어내고 새로 쓴다. 수신 소켓 재생성 루프는 2초마다
 *           로그를 남기므로 방화벽에 막힌 채 오래 두면 파일이 계속 커졌다.
 *   [P2-31] INFO / WARN / ERROR 레벨을 붙였다.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const LOG_PATH = path.join(os.tmpdir(), 'liar-game.log');
const MAX_BYTES = 5 * 1024 * 1024;
const FLUSH_MS = 200;
const PID = process.pid;

let queue = [];
let scheduled = false;
let writing = false;
let bytes = 0;
try { bytes = fs.statSync(LOG_PATH).size; } catch { bytes = 0; }

function rotate() {
  try { fs.renameSync(LOG_PATH, `${LOG_PATH}.1`); } catch { /* 밀어내기 실패해도 로깅은 계속한다 */ }
  bytes = 0;
}

function flush() {
  scheduled = false;
  if (writing || queue.length === 0) return;
  writing = true;
  const chunk = queue.join('');
  queue = [];
  if (bytes + chunk.length > MAX_BYTES) rotate();
  fs.appendFile(LOG_PATH, chunk, () => {
    bytes += chunk.length;
    writing = false;
    if (queue.length > 0) schedule();
  });
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  const t = setTimeout(flush, FLUSH_MS);
  if (t.unref) t.unref(); // 로그 한 줄 때문에 프로세스가 안 끝나는 일은 없게
}

function write(level, message) {
  const line = `[${new Date().toISOString()}] [${PID}] [${level}] ${message}`;
  try { console.error(line); } catch { /* 콘솔이 없는 빌드는 무시 */ }
  queue.push(`${line}\n`);
  schedule();
}

// 프로세스가 죽는 순간의 마지막 로그가 큐에 남아 사라지면, 정작 원인을 담은 줄을 잃는다.
process.on('exit', () => {
  if (queue.length === 0) return;
  try { fs.appendFileSync(LOG_PATH, queue.join('')); } catch { /* 파일 시스템 문제는 어쩔 수 없다 */ }
  queue = [];
});

const log = (message) => write('INFO', message);
const warn = (message) => write('WARN', message);
const error = (message) => write('ERROR', message);

module.exports = { log, warn, error, LOG_PATH };

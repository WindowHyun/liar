'use strict';

/**
 * 화면 파일(web/public)을 이 PC 안에서만 서비스하는 아주 작은 서버.
 *
 * 왜 필요한가: 창을 file:// 로 띄우면 출처가 없는 페이지가 되고, 그 상태에서 다른 PC의
 * WebSocket으로 붙는 것을 브라우저 엔진이 막을 수 있다. http://127.0.0.1 출처로 띄우면
 * 일반 웹페이지와 같은 취급을 받아 그 제약이 없다.
 *
 * 127.0.0.1에만 바인딩하므로 이 서버는 바깥에서 보이지 않는다. 게임 통신과는 무관하고,
 * 오로지 화면 파일을 내려주기만 한다.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { warn } = require('../logger');

const PUBLIC_DIR = path.join(__dirname, '..', 'web', 'public');

/**
 * [E-6] 화면 서버 포트를 고정한다.
 *
 * 예전에는 빈 포트를 OS가 골라 주게 했는데(listen(0)), 그러면 앱을 켤 때마다 출처가
 * http://127.0.0.1:33329 → :39343 처럼 바뀐다. localStorage는 출처마다 따로라서
 * 저장해 둔 닉네임과 토큰을 못 읽고, 앱을 다시 켤 때마다 닉네임을 새로 입력해야 했다.
 *
 * 같은 PC에서 두 번 실행하면 첫 번째가 이 포트를 쓰고 있으므로, 그때는 다음 번호로
 * 넘어간다. 두 번째 창은 출처가 달라 닉네임을 다시 넣어야 하지만, 흔한 경우가 아니다.
 */
const BASE_PORT = 55510;
const MAX_TRIES = 10;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function createUiServer() {
  let server = null;

  return {
    /** 고정 포트부터 순서대로 시도한다. 실제로 잡힌 포트 번호를 돌려준다. */
    start() {
      return new Promise((resolve, reject) => {
        let attempt = 0;
        server = http.createServer((req, res) => {
          const requested = (req.url || '/').split('?')[0];
          const name = requested === '/' ? 'index.html' : path.basename(requested);
          fs.readFile(path.join(PUBLIC_DIR, name), (err, data) => {
            if (err) {
              res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
              res.end('없는 파일입니다.');
              return;
            }
            res.writeHead(200, {
              'Content-Type': MIME[path.extname(name)] || 'application/octet-stream',
              'Cache-Control': 'no-store',
            });
            res.end(data);
          });
        });

        server.on('error', (err) => {
          if (err.code === 'EADDRINUSE' && attempt < MAX_TRIES) {
            // 같은 PC에서 이미 하나가 떠 있다. 다음 번호로 넘어간다.
            attempt += 1;
            server.listen(BASE_PORT + attempt, '127.0.0.1');
            return;
          }
          warn(`[화면 서버] ${err.code || ''} ${err.message}`);
          reject(err);
        });
        server.listen(BASE_PORT, '127.0.0.1', () => resolve(server.address().port));
      });
    },

    stop() {
      if (!server) return;
      try { server.close(); } catch { /* 무시 */ }
      server = null;
    },
  };
}

module.exports = { createUiServer };

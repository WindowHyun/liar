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
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function createUiServer() {
  let server = null;

  return {
    /** 빈 포트를 하나 잡아서 연다. 실제로 잡힌 포트 번호를 돌려준다. */
    start() {
      return new Promise((resolve, reject) => {
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
          warn(`[화면 서버] ${err.code || ''} ${err.message}`);
          reject(err);
        });
        // 포트 0 = 비어 있는 포트를 OS가 골라 준다. 같은 PC에서 두 번 실행해도 겹치지 않는다.
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
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

'use strict';

/**
 * 앱 아이콘을 코드로 그린다. (Electron 기본 로고 대신 쓰려고)
 *
 * 그림 파일을 외부에서 받아 오지 않고 여기서 만든다. 사내망에서 빌드해도 되고,
 * 색이나 크기를 바꾸고 싶으면 이 파일만 고치면 다시 만들 수 있다.
 *   node tools/make-icon.js
 *
 * 네 갈래 풍차 모양. 슬랙 팔레트를 쓰되 도형은 여기서 직접 계산해 그린다.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PALETTE = [
  [0x36, 0xC5, 0xF0], // 파랑
  [0x2E, 0xB6, 0x7D], // 초록
  [0xEC, 0xB2, 0x2E], // 노랑
  [0xE0, 0x1E, 0x5A], // 빨강
];

// 100x100 기준 좌표. 가로로 누운 알약 하나를 90도씩 돌려 네 갈래를 만든다.
const C = 50;
const BAR = { x0: 13, x1: 58, y0: 20.5, y1: 33.5 };
const R = (BAR.y1 - BAR.y0) / 2;

/** 둥근 사각형 안쪽인지. 밖이면 음수, 안이면 양수(경계까지의 거리). */
function insidePill(x, y) {
  const ix0 = BAR.x0 + R;
  const ix1 = BAR.x1 - R;
  const cy = (BAR.y0 + BAR.y1) / 2;
  const nx = Math.min(Math.max(x, ix0), ix1); // 심선 위의 가장 가까운 점
  return R - Math.hypot(x - nx, y - cy);
}

/** 점을 중심 기준 90도*k 만큼 돌린다. */
function rotate(x, y, k) {
  let px = x - C;
  let py = y - C;
  for (let i = 0; i < k; i += 1) {
    const t = px;
    px = -py;
    py = t;
  }
  return [px + C, py + C];
}

function render(size) {
  const px = Buffer.alloc(size * size * 4, 0);
  const SS = 4; // 계단 현상을 없애려고 한 픽셀을 4x4로 나눠 본다
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const cover = [0, 0, 0, 0];
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const ux = ((x + (sx + 0.5) / SS) / size) * 100;
          const uy = ((y + (sy + 0.5) / SS) / size) * 100;
          for (let k = 0; k < 4; k += 1) {
            const [rx, ry] = rotate(ux, uy, k);
            if (insidePill(rx, ry) > 0) { cover[k] += 1; break; }
          }
        }
      }
      const total = SS * SS;
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let k = 0; k < 4; k += 1) {
        if (!cover[k]) continue;
        const w = cover[k] / total;
        r += PALETTE[k][0] * w; g += PALETTE[k][1] * w; b += PALETTE[k][2] * w; a += w;
      }
      const i = (y * size + x) * 4;
      if (a > 0) {
        px[i] = Math.round(r / a); px[i + 1] = Math.round(g / a); px[i + 2] = Math.round(b / a);
        px[i + 3] = Math.round(Math.min(1, a) * 255);
      }
    }
  }
  return px;
}

// ── PNG로 묶기 ──
const CRC = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return (buf) => {
    let c = -1;
    for (const byte of buf) c = table[(c ^ byte) & 0xFF] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(body));
  return Buffer.concat([len, body, crc]);
}

function toPng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // 8비트
  ihdr[9] = 6;   // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // 필터 없음
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 여러 크기를 담은 .ico. 각 항목은 PNG 그대로 넣는다(Vista 이후 표준). */
function toIco(entries) {
  const header = Buffer.alloc(6 + entries.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // 아이콘
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach((e, i) => {
    const at = 6 + i * 16;
    header[at] = e.size >= 256 ? 0 : e.size;      // 256은 0으로 적는다
    header[at + 1] = e.size >= 256 ? 0 : e.size;
    header[at + 4] = 1;                            // 색 평면
    header.writeUInt16LE(32, at + 6);              // 비트 수
    header.writeUInt32BE(0, at + 8);
    header.writeUInt32LE(e.png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += e.png.length;
  });
  return Buffer.concat([header, ...entries.map((e) => e.png)]);
}

const ROOT = path.join(__dirname, '..');
const sizes = [256, 128, 64, 48, 32, 16];
const made = sizes.map((size) => ({ size, png: toPng(size, render(size)) }));

fs.writeFileSync(path.join(ROOT, 'build', 'icon.png'), toPng(512, render(512)));
fs.writeFileSync(path.join(ROOT, 'build', 'icon.ico'), toIco(made));
fs.writeFileSync(path.join(ROOT, 'web', 'public', 'favicon.png'), made[3].png); // 48px
// 창 아이콘은 electron/ 아래에 둔다. 패키징 목록(files)에 이미 들어 있는 경로라
// build/를 따로 넣지 않아도 exe 안에 함께 들어간다.
fs.writeFileSync(path.join(ROOT, 'electron', 'icon.png'), made[0].png); // 256px
console.log('만들었습니다: build/icon.png (512), build/icon.ico, electron/icon.png, web/public/favicon.png');

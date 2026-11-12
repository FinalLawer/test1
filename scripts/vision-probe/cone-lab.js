'use strict';
/* 扇形通道离线实验公共件（2026-11-12）。
 *
 * 只做三件事：
 *   · 从 src/webview-preload.js 抠出 analyzeCone（先把 CRLF 归一成 LF —— 工作区是
 *     autocrlf 检出的，旧探针脚本用 '\n' 锚点在 CRLF 源码上会找不到函数结尾）
 *   · 读 Temp/vidframes500 的 500 帧离线 ROI
 *   · 手写 PNG 编码 + 画射线，方便把识别结果叠到原图上目视核对
 *
 * 不启动应用、不改识别器源码。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..', '..');
const TMP500 = path.join(os.tmpdir(), 'vidframes500');

function readSrc(file = path.join(ROOT, 'src/webview-preload.js')) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

/** 从源码文本里抠出 analyzeCone；text 缺省读工作区源码 */
function loadAnalyzer(text = readSrc()) {
  const h0 = text.indexOf('function degOf(ux, uy) {');
  const h1 = text.indexOf('/* ---------------------------------------------------------------- 扇形通道', h0);
  const c0 = text.indexOf('function analyzeCone(img, size, step) {');
  const c1 = text.indexOf('/**\n * 圆形 α-β 滤波', c0);
  if (h0 < 0 || h1 < 0 || c0 < 0 || c1 < 0) throw new Error('源码锚点没找到');
  const H = new Function(text.slice(h0, h1) + ';return { degOf, angDiff };')();
  return new Function('degOf', 'angDiff', text.slice(c0, c1) + ';return analyzeCone;')(H.degOf, H.angDiff);
}

function loadFrames500() {
  const man = JSON.parse(fs.readFileSync(path.join(TMP500, 'vidroi500.json'), 'utf8'));
  const blob = fs.readFileSync(path.join(TMP500, 'vidroi500.bin'));
  const frames = man.list.map((e, i) => ({
    i,
    t: e.t,
    S: e.size,
    img: {
      data: new Uint8ClampedArray(blob.buffer, blob.byteOffset + e.off, e.size * e.size * 4),
      width: e.size,
      height: e.size
    }
  }));
  return { frames, step: man.step };
}

function loadFixture(name, size) {
  const raw = fs.readFileSync(path.join(ROOT, 'scripts/vision-probe/fixtures', name));
  return { data: new Uint8ClampedArray(raw), width: size, height: size };
}

const ad = (x, y) => Math.abs(((x - y + 540) % 360) - 180);

/* ---- PNG ---- */
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  const src = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.length);
  for (let y = 0; y < h; y += 1) {
    raw[y * (stride + 1)] = 0;
    src.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 3 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** 简易画布：RGBA，支持贴图（整数倍放大）和画线 */
class Canvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.d = new Uint8ClampedArray(w * h * 4);
    for (let i = 3; i < this.d.length; i += 4) this.d[i] = 255;
  }
  px(x, y, r, g, b) {
    x |= 0;
    y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    this.d[i] = r;
    this.d[i + 1] = g;
    this.d[i + 2] = b;
  }
  blit(img, size, ox, oy, scale = 1, map = null) {
    const s = img.data;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const i = (y * size + x) * 4;
        let r = s[i];
        let g = s[i + 1];
        let b = s[i + 2];
        if (map) [r, g, b] = map(r, g, b, x, y);
        for (let yy = 0; yy < scale; yy += 1) {
          for (let xx = 0; xx < scale; xx += 1) this.px(ox + x * scale + xx, oy + y * scale + yy, r, g, b);
        }
      }
    }
  }
  line(x0, y0, x1, y1, r, g, b, thick = 1) {
    const n = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))) || 1;
    for (let k = 0; k <= n; k += 1) {
      const x = x0 + ((x1 - x0) * k) / n;
      const y = y0 + ((y1 - y0) * k) / n;
      for (let a = 0; a < thick; a += 1) {
        for (let c = 0; c < thick; c += 1) this.px(x + a, y + c, r, g, b);
      }
    }
  }
  /** 从 (cx,cy) 沿数学角 deg 画一条射线（屏幕 y 向下） */
  ray(cx, cy, deg, r0, r1, col, thick = 1) {
    const rad = (deg * Math.PI) / 180;
    this.line(cx + Math.cos(rad) * r0, cy - Math.sin(rad) * r0, cx + Math.cos(rad) * r1, cy - Math.sin(rad) * r1,
      col[0], col[1], col[2], thick);
  }
  save(file) {
    fs.writeFileSync(file, encodePNG(this.w, this.h, this.d));
  }
}

module.exports = { ROOT, TMP500, readSrc, loadAnalyzer, loadFrames500, loadFixture, ad, encodePNG, Canvas };

'use strict';
/* 打印指定帧在当前 analyzeCone 下的实际判定与全部结构量。
 * 2026-11-06 P1 之前这里是「把硬判据改成只记录」的诊断版，用来定位 67 帧漏检；
 * 现在 flat/mono/相对优势已不再否决，直接读返回的 dbg 更诚实。 */
const fs = require('fs');
const src = fs.readFileSync(require('path').join(require('path').resolve(__dirname, '..', '..'), 'src', 'webview-preload.js'), 'utf8');
const h0 = src.indexOf('function degOf(ux, uy) {');
const h1 = src.indexOf('/* ---------------------------------------------------------------- 扇形通道', h0);
const c0 = src.indexOf('function analyzeCone(img, size, step) {');
const c1 = src.indexOf('/**\n * 圆形 α-β 滤波', c0);
const helpers = new Function(src.slice(h0, h1) + ';return { degOf, angDiff };')();
const analyzeCone = new Function('degOf', 'angDiff', src.slice(c0, c1) + ';return analyzeCone;')(helpers.degOf, helpers.angDiff);

const man = JSON.parse(fs.readFileSync(require('path').join(require('os').tmpdir(), 'vidroi.json'), 'utf8'));
const blob = fs.readFileSync(require('path').join(require('os').tmpdir(), 'vidroi.bin'));
const want = [8, 20, 26, 60, 100, 190, 200, 242, 304, 312, 6, 54, 256, 268, 298];
for (const t of want) {
  const e = man.list.find(x => x.t === t);
  if (!e) continue;
  const S = e.size, bytes = S * S * 4;
  const data = new Uint8ClampedArray(blob.buffer.slice(blob.byteOffset + e.off, blob.byteOffset + e.off + bytes));
  const r = analyzeCone({ data, width: S, height: S }, S, man.step);
  const b = r.dbg;
  if (!b) { console.log(`${String(t).padStart(4)}s  无候选  cyan=${(r.cyanFrac || 0).toFixed(4)}`); continue; }
  console.log(
    `${String(t).padStart(4)}s  ${r.valid ? '✓ ' + r.deg.toFixed(1) + '°' : '✗ invalid'} ` +
    `best c=${String(b.c).padStart(2)} score=${b.score.toFixed(2)} rival=${(b.rivalScore || 0).toFixed(2)} | ` +
    `pos=${b.pos} fade=${b.fade.toFixed(2)} all=${b.all.toFixed(2)} inner=${b.inner.toFixed(2)} ` +
    `mono=${b.mono} flat=${b.flat.toFixed(2)} | cyan=${(r.cyanFrac || 0).toFixed(4)}`
  );
}

'use strict';
/* 把若干帧拼成对照图：原图 + 识别出的中轴（绿）与两条半径（黄）。
 * 用法：node cone-lab-sheet.js <out.png> <帧号,帧号,...> [--src <另一份源码>] [--plain] [--cols N] [--scale N]
 */
const fs = require('fs');
const path = require('path');
const { loadAnalyzer, loadFrames500, readSrc, Canvas } = require('./cone-lab');

const out = process.argv[2];
const ids = process.argv[3].split(',').map(Number);
const arg = (k, dflt) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const plain = process.argv.includes('--plain');
const cols = Number(arg('--cols', Math.min(ids.length, 3)));
const scale = Number(arg('--scale', 1));
const srcFile = arg('--src', null);
const analyzeCone = loadAnalyzer(srcFile ? readSrc(path.resolve(srcFile)) : readSrc());
const { frames, step } = loadFrames500();

const S = frames[0].S * scale;
const rows = Math.ceil(ids.length / cols);
const cv = new Canvas(cols * S, rows * S);
ids.forEach((id, n) => {
  const f = frames[id];
  const ox = (n % cols) * S;
  const oy = Math.floor(n / cols) * S;
  cv.blit(f.img, f.S, ox, oy, scale);
  const r = analyzeCone(f.img, f.S, step);
  const c = ox + S / 2;
  const cy = oy + S / 2;
  if (!plain && r.valid) {
    cv.ray(c, cy, r.deg, S * 0.1, S * 0.48, [0, 255, 0], 2);
    cv.ray(c, cy, r.deg - 45, S * 0.1, S * 0.48, [255, 230, 0], 1);
    cv.ray(c, cy, r.deg + 45, S * 0.1, S * 0.48, [255, 230, 0], 1);
  }
  console.log(`#${id} t=${f.t} valid=${r.valid} deg=${r.deg.toFixed(1)} conf=${r.conf.toFixed(2)} cyan=${(r.cyanFrac || 0).toFixed(4)}`);
});
cv.save(out);

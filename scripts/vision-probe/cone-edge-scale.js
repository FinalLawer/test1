'use strict';
/* 双半径边择优的尺度稳健性（2026-11-06）。
 *
 * 对两张实拍原图按不同 ROI 中心（±5px）、半径（±10）、采样步长（1/2）
 * 重新裁 1.5R 窗口，对比 W=0（关掉边证据）与 W=0.6（当前源码）。
 *
 * 关键结论：绝大多数配置两者一致；唯独「本次截图 + 中心偏上 5px」时
 * W=0 会翻到 198.2°（反方向、conf 0.86），W=0.6 仍给 14.5°。
 * 说明边证据同时压住了 ROI 定位误差诱发的假峰。
 *
 * 需要 Python + Pillow 来裁剪 JPG；帧原图已固化在 fixtures。
 */
const fs = require('fs');
const { execFileSync } = require('child_process');
const src = fs.readFileSync(require('path').join(require('path').resolve(__dirname, '..', '..'), 'src', 'webview-preload.js'), 'utf8');
const h0 = src.indexOf('function degOf(ux, uy) {');
const h1 = src.indexOf('/* ---------------------------------------------------------------- 扇形通道', h0);
const c0 = src.indexOf('function analyzeCone(img, size, step) {');
const c1 = src.indexOf('/**\n * 圆形 α-β 滤波', c0);
const H = new Function(src.slice(h0, h1) + ';return { degOf, angDiff };')();
const CORE = src.slice(c0, c1);
const ad = (x, y) => Math.abs(((x - y + 540) % 360) - 180);
const SORT_LINE = '  cand.sort((x, y) => y.rank - x.rank);';
if (!CORE.includes(SORT_LINE)) throw new Error('源码里的 rank 择优实现已变化，请同步本脚本');
const build = (on) => new Function('degOf', 'angDiff',
  (on ? CORE : CORE.replace(SORT_LINE, '  cand.sort((x, y) => y.score - x.score);')) + ';return analyzeCone;')(H.degOf, H.angDiff);
const base = build(false);
const fix = build(true);

const FIX = require('path').join(__dirname, 'fixtures') + '/';
const imgs = {
  old: FIX + 'source-annotated.jpg',
  cur: FIX + 'source-current.jpg',
};
const RAW = require('path').join(require('os').tmpdir(), 'rank-scale.raw');
console.log('帧    CX   CY    R  step | W=0 deg  conf | W=0.6 deg conf | 差');
for (const [key, CX0, CY0, R0] of [['old', 196, 610, 110], ['cur', 109, 555, 95]]) {
  for (const [dx, dy, dr] of [[0, 0, 0], [5, 0, 0], [-5, 0, 0], [0, 5, 0], [0, -5, 0], [0, 0, 10], [0, 0, -10], [4, 4, -6]]) {
    for (const step of [1, 2]) {
      const CX = CX0 + dx, CY = CY0 + dy, R = R0 + dr;
      const S = Math.round(1.5 * R) + (Math.round(1.5 * R) % 2);
      execFileSync('python', ['-c', `
from PIL import Image
im = Image.open('${imgs[key]}').convert('RGB')
cx, cy, S = ${CX}, ${CY}, ${S}
box = (cx - S//2, cy - S//2, cx - S//2 + S, cy - S//2 + S)
open('${RAW}', 'wb').write(im.crop(box).convert('RGBA').tobytes())
`]);
      const img = { data: new Uint8ClampedArray(fs.readFileSync(RAW)), width: S, height: S };
      const a = base(img, S, step), b = fix(img, S, step);
      console.log(`${key.padEnd(3)} ${String(CX).padStart(4)} ${String(CY).padStart(4)} ${String(R).padStart(4)} ${step}    | ${a.valid ? a.deg.toFixed(1).padStart(6) : ' invalid'} ${a.conf.toFixed(2)} | ${b.valid ? b.deg.toFixed(1).padStart(6) : ' invalid'} ${b.conf.toFixed(2)} | ${ad(a.deg, b.deg).toFixed(1)}`);
    }
  }
}

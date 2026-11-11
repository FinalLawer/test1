'use strict';
/* 核对专家 B2-3：源码用「90° 窗口内响应加权质心」定中轴，是否把方向拖偏？
 * 构造两个只差这一处的 analyzeCone 变体，在真实帧上对比。只读，不改源码。 */
const fs = require('fs');
const src = fs.readFileSync(require('path').join(require('path').resolve(__dirname, '..', '..'), 'src', 'webview-preload.js'), 'utf8');
const h0 = src.indexOf('function degOf(ux, uy) {');
const h1 = src.indexOf('/* ---------------------------------------------------------------- 扇形通道', h0);
const H = new Function(src.slice(h0, h1) + ';return {degOf,angDiff};')();
const c0 = src.indexOf('function analyzeCone(img, size, step) {');
const c1 = src.indexOf('/**\n * 圆形 α-β 滤波', c0);
const base = src.slice(c0, c1);
const RET = '  return { valid: conf > 0.12, deg, conf, width: 90, peakCov: wsum, cyanFrac, dbg: best };';
if (!base.includes(RET)) throw new Error('return 语句未匹配');
function build(useCentroid) {
  let core = base.replace('const deg = wsum > 1e-6 ? degOf(sx, sy) : best.c * 5 + 2.5;',
    useCentroid
      ? 'const deg = wsum > 1e-6 ? degOf(sx, sy) : best.c * 5 + 2.5;'
      : 'const deg = (best.c * 5 + 2.5) % 360;');
  core = core.replace(RET, '  DIAG.out = { deg, phase: (best.c*5+2.5)%360, wsum, conf, score: best.score, valid: conf>0.12 };\n' + RET);
  return new Function('degOf', 'angDiff', 'DIAG', core + ';return function(i,s,st){DIAG.out=null;analyzeCone(i,s,st);return DIAG.out;};')(H.degOf, H.angDiff, { out: null });
}
const centroid = build(true), phase = build(false);
const man = JSON.parse(fs.readFileSync(require('path').join(require('os').tmpdir(), 'vidroi.json'), 'utf8'));
const blob = fs.readFileSync(require('path').join(require('os').tmpdir(), 'vidroi.bin'));
const gate = JSON.parse(fs.readFileSync(require('path').join(require('os').tmpdir(), 'vidscan-gate.json'), 'utf8'));
const gm = new Map(gate.map(g => [g.t, g.blob >= 8]));
const ad = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

const rows = [];
for (const e of man.list) {
  const S = e.size, b = S * S * 4;
  const img = { data: new Uint8ClampedArray(blob.buffer.slice(blob.byteOffset + e.off, blob.byteOffset + e.off + b)), width: S, height: S };
  const a = centroid(img, S, man.step), p = phase(img, S, man.step);
  rows.push({ t: e.t, has: gm.get(e.t) === true, a, p });
}
const both = rows.filter(r => r.has && r.a && r.p && r.a.valid && r.p.valid);
const off = both.map(r => ad(r.a.deg, r.p.deg)).sort((x, y) => x - y);
console.log(`两版都检出的有小地图帧 = ${both.length}`);
console.log(`质心角 vs 模板相位角：中位偏移 ${off.length ? off[off.length >> 1].toFixed(1) : '-'}°  p90 ${off.length ? off[Math.floor(off.length * 0.9)].toFixed(1) : '-'}°  最大 ${off.length ? off[off.length - 1].toFixed(1) : '-'}°`);
console.log(`偏移 >10° 的帧 = ${off.filter(x => x > 10).length}，>20° = ${off.filter(x => x > 20).length}`);

/* 用「前后各一帧、间隔均为 2s、方向本身连续」的三帧组做插值残差：
 * 中帧角度应接近两端中点；谁的残差小谁更可信。 */
function residual(key) {
  const errs = [];
  for (let i = 1; i < rows.length - 1; i++) {
    const L = rows[i - 1], M = rows[i], R = rows[i + 1];
    if (!L.has || !M.has || !R.has) continue;
    if (M.t - L.t !== 2 || R.t - M.t !== 2) continue;
    if (!L.a || !M.a || !R.a || !L.a.valid || !M.a.valid || !R.a.valid) continue;
    const dl = L.a[key], dm = M.a[key], dr = R.a[key];
    if (ad(dl, dr) > 40) continue;                 // 排除急转
    const mid = (dl + ((((dr - dl + 540) % 360) - 180)) / 2 + 360) % 360;
    errs.push(ad(dm, mid));
  }
  errs.sort((x, y) => x - y);
  return { n: errs.length, med: errs.length ? errs[errs.length >> 1] : NaN, p90: errs.length ? errs[Math.floor(errs.length * 0.9)] : NaN };
}
console.log('\n三帧连续段插值残差（越小越稳）：');
for (const [name, key] of [['质心角(当前源码)', 'deg'], ['模板相位角', 'phase']]) {
  const r = residual(key);
  console.log(`  ${name.padEnd(20)} n=${r.n}  中位=${r.med.toFixed(1)}°  p90=${r.p90.toFixed(1)}°`);
}

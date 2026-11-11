'use strict';
/* 标定运行时「小地图存在性门控」：在真实帧的 0.62R 几何窗口上跑真实 analyze()，
 * 看 cyans / 连通块面积能否把「有小地图 153 帧」与「无小地图 13 帧」干净分开。
 * 只读分析，不改源码。 */
const fs = require('fs');
const src = fs.readFileSync(require('path').join(require('path').resolve(__dirname, '..', '..'), 'src', 'webview-preload.js'), 'utf8');
function slice(from, to) { const a = src.indexOf(from), b = src.indexOf(to, a); if (a < 0 || b < 0) throw new Error('slice fail: ' + from); return src.slice(a, b); }
const geometry = slice('function cyanScore(r, g, b) {', 'function degOf');
const helpers = slice('function degOf(ux, uy) {', '/* ---------------------------------------------------------------- 扇形通道');
const BEARING = { mask: null, lbl: null, stack: null, maskMeta: null };
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const { analyze } = new Function('BEARING', 'clamp', geometry + helpers + '\n; return { analyze };')(BEARING, clamp);

const man = JSON.parse(fs.readFileSync(require('path').join(require('os').tmpdir(), 'vidroi.json'), 'utf8'));
const blob = fs.readFileSync(require('path').join(require('os').tmpdir(), 'vidroi.bin'));
const gate = JSON.parse(fs.readFileSync(require('path').join(require('os').tmpdir(), 'vidscan-gate.json'), 'utf8'));
const gm = new Map(gate.map(g => [g.t, g.blob >= 8]));

// 1.5R 裁窗边长 S，几何窗口 0.62R ⇒ 0.62/1.5*S ≈ 0.4133*S，居中裁
const G = Math.round((0.62 / 1.5) * man.list[0].size);
const rows = [];
for (const e of man.list) {
  const S = e.size, off = blob.byteOffset + e.off;
  const full = new Uint8ClampedArray(blob.buffer.slice(off, off + S * S * 4));
  const s0 = Math.round((S - G) / 2);
  const sub = new Uint8ClampedArray(G * G * 4);
  for (let y = 0; y < G; y++) {
    sub.set(full.subarray(((y + s0) * S + s0) * 4, ((y + s0) * S + s0 + G) * 4), y * G * 4);
  }
  const r = analyze({ data: sub, width: G, height: G }, G, 1);
  rows.push({ t: e.t, has: gm.get(e.t) === true, cyans: r.cyans, area: Math.round(r.area || 0), valid: r.valid });
}
const yes = rows.filter(r => r.has), no = rows.filter(r => !r.has);
const stat = (a, k) => { const v = a.map(x => x[k]).sort((x, y) => x - y); return { min: v[0], p05: v[Math.floor(v.length * 0.05)], med: v[v.length >> 1], max: v[v.length - 1] }; };
console.log(`几何窗口 ${G}px，step=1；有地图 ${yes.length} 帧 / 无地图 ${no.length} 帧`);
for (const k of ['cyans', 'area']) {
  console.log(`\n${k}: 有地图 ${JSON.stringify(stat(yes, k))}`);
  console.log(`${k}: 无地图 ${JSON.stringify(stat(no, k))}`);
}
console.log('\n无地图帧明细：', JSON.stringify(no));
console.log('\n有地图帧里 cyans 最小的 12 帧：', JSON.stringify(yes.slice().sort((a, b) => a.cyans - b.cyans).slice(0, 12)));
for (const k of ['cyans', 'area']) {
  let best = null;
  for (let thr = 0; thr <= 200; thr++) {
    const fp = no.filter(r => r[k] >= thr).length;
    const fn = yes.filter(r => r[k] < thr).length;
    if (!best || fp + fn < best.fp + best.fn) best = { thr, fp, fn };
  }
  console.log(`${k} 最优阈值 >=${best.thr}: 误判无地图为有 ${best.fp}/13，有地图被拒 ${best.fn}/153`);
}
fs.writeFileSync(require('path').join(require('os').tmpdir(), 'cone-gate-calib.json'), JSON.stringify(rows));

/* 换一个信号：扇形通道已经取到的 1.5R 大窗口（363px, step=2）上，
 * 用**固定**青色判据数像素。它不依赖 analyze() 的 p99 自适应阈值，
 * 且能在 analyzeCone 的扫描循环里顺手统计，运行时几乎零额外成本。 */
const cyanScore = (r, g, b) => Math.min(g, b) - r;
const bigRows = [];
for (const e of man.list) {
  const S = e.size, off = blob.byteOffset + e.off;
  const full = new Uint8ClampedArray(blob.buffer.slice(off, off + S * S * 4));
  const counts = [0, 0, 0, 0];   // 阈值 80 / 100 / 112 / 130
  for (let y = 0; y < S; y += 2) {
    for (let x = 0; x < S; x += 2) {
      const i = (y * S + x) * 4;
      const c = cyanScore(full[i], full[i + 1], full[i + 2]);
      if (c >= 80) counts[0]++;
      if (c >= 100) counts[1]++;
      if (c >= 112) counts[2]++;
      if (c >= 130) counts[3]++;
    }
  }
  bigRows.push({ t: e.t, has: gm.get(e.t) === true, counts });
}
console.log('\n=== 1.5R 大窗固定青色阈值（step=2）===');
for (let k = 0; k < 4; k++) {
  const Y = bigRows.filter(r => r.has).map(r => r.counts[k]).sort((a, b) => a - b);
  const N = bigRows.filter(r => !r.has).map(r => r.counts[k]);
  let best = null;
  for (let thr = 1; thr <= 500; thr++) {
    const fp = N.filter(v => v >= thr).length;
    const fn = Y.filter(v => v < thr).length;
    if (!best || fp + fn < best.fp + best.fn) best = { thr, fp, fn };
  }
  console.log(`阈值 cyan>=${[80,100,112,130][k]}: 有图 min=${Y[0]} p05=${Y[Math.floor(Y.length*0.05)]} med=${Y[Y.length>>1]} | 无图 max=${Math.max(...N)}` +
    ` | 最优 >=${best.thr}: 误判 ${best.fp}/13, 漏判 ${best.fn}/153`);
}
console.log('无地图帧各阈值计数：', JSON.stringify(bigRows.filter(r => !r.has).map(r => ({ t: r.t, c: r.counts }))));

/* 再收紧到中心圆：玩家箭头恒在圆心附近，零散青色 UI 噪声多在边缘。
 * 复现离线 gate 的「连通块」思路，但用更便宜的中心聚集计数。 */
console.log('\n=== 中心圆内青色计数（step=2, cyan>=80）===');
const cenRows = [];
for (const e of man.list) {
  const S = e.size, off = blob.byteOffset + e.off;
  const full = new Uint8ClampedArray(blob.buffer.slice(off, off + S * S * 4));
  const c0 = (S - 1) / 2;
  const cnt = [0, 0, 0];   // rho < 0.15S / 0.20S / 0.25S
  const lim = [0.15 * S, 0.20 * S, 0.25 * S];
  const l2 = lim.map(v => v * v);
  for (let y = 0; y < S; y += 2) {
    const dy = y - c0;
    for (let x = 0; x < S; x += 2) {
      const dx = x - c0, rr = dx * dx + dy * dy;
      if (rr > l2[2]) continue;
      const i = (y * S + x) * 4;
      if (cyanScore(full[i], full[i + 1], full[i + 2]) < 80) continue;
      for (let k = 0; k < 3; k++) if (rr <= l2[k]) cnt[k]++;
    }
  }
  cenRows.push({ t: e.t, has: gm.get(e.t) === true, cnt });
}
for (let k = 0; k < 3; k++) {
  const Y = cenRows.filter(r => r.has).map(r => r.cnt[k]).sort((a, b) => a - b);
  const N = cenRows.filter(r => !r.has).map(r => r.cnt[k]);
  let best = null;
  for (let thr = 1; thr <= 300; thr++) {
    const fp = N.filter(v => v >= thr).length;
    const fn = Y.filter(v => v < thr).length;
    if (!best || fp + fn < best.fp + best.fn) best = { thr, fp, fn };
  }
  console.log(`rho<${[0.15,0.20,0.25][k]}S: 有图 min=${Y[0]} p05=${Y[Math.floor(Y.length*0.05)]} med=${Y[Y.length>>1]} | 无图 max=${Math.max(...N)}` +
    ` | 最优 >=${best.thr}: 误判 ${best.fp}/13, 漏判 ${best.fn}/153`);
}
console.log('无地图帧中心计数：', JSON.stringify(cenRows.filter(r => !r.has).map(r => ({ t: r.t, c: r.cnt }))));

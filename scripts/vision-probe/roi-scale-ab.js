'use strict';
/* ROI 尺度/圆心敏感性 A/B（2026-11-07）。
 *
 * 背景：用户把打包版的检测圈「缩小一点」后箭头变准。本脚本量化这件事：
 *   500 帧离线 raw 是围绕玩家中心的 363px 全分辨率裁窗，
 *   改 roi.r  == 改喂给 analyze() 的中心子窗口边长 s（0.62R 通道），
 *   改 roi.cx/cy == 改子窗口相对裁窗中心的像素偏移 dx/dy。
 *   因此能在不启动应用、不改源码的前提下精确复现任意 ROI 配置。
 *
 * 箭头方向没有人工真值，故用两类客观代理指标：
 *   A. 内在质量：valid 率、平均 conf、结构裕度（angMargin/radMargin/noseFlat）
 *   B. 时间连续性：相邻有效帧角差 p50/p90、孤立反向脉冲数
 *      —— 真实角色转向是连续的，错选鼻尖/把青色图标当箭头的典型特征就是
 *         单帧翻到反方向、下一帧又跳回。这个判据不需要真值。
 *
 * 配置换算（相对量，不依赖绝对 R）：
 *   s_ref = 150 对应开发版 r=.1496538；s = 150 * r / .1496538
 *   dx = (cx - cx_true) * 1920, cx_true = 280/1920（抽帧时对准的玩家中心）
 *   dy = (cy - cy_true) * 1080, cy_true = 266/1080
 *
 * 只读：不启动应用、不连调试端口、不改识别器源码、不碰任何 settings.json。
 */
const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '..', '..');
const TMP = require('path').join(require('os').tmpdir(), 'vidframes500');

/* ---------- 从真实源码构造 analyze() ---------- */
const src = fs.readFileSync(ROOT + '/src/webview-preload.js', 'utf8');
const a0 = src.indexOf('function cyanScore(');
const a1 = src.indexOf('/* ---------------------------------------------------------------- 扇形通道', a0);
if (a0 < 0 || a1 <= a0) throw new Error('源码结构变化：找不到几何通道切片');
const helpers = src.slice(a0, a1);   // cyanScore / analyze / degOf / angDiff
const BEARING = {};                  // analyze 只用它缓存 mask/lbl/stack
const { analyze, angDiff } = new Function('BEARING', helpers + ';return { analyze, angDiff };')(BEARING);

/* ---------- 载入 500 帧 ---------- */
const man = JSON.parse(fs.readFileSync(TMP + '/vidroi500.json', 'utf8'));
const blob = fs.readFileSync(TMP + '/vidroi500.bin');
const frames = man.list.map((e) => ({
  t: e.t, S: e.size,
  raw: Buffer.from(blob.buffer, blob.byteOffset + e.off, e.size * e.size * 4)
}));
console.log(`帧数 ${frames.length}，间隔 ${(frames[1].t - frames[0].t).toFixed(2)}s`);

/* ---------- 按 (s,dx,dy) 裁中心子窗口 ---------- */
function crop(f, s, dx, dy) {
  const S = f.S;
  const x0 = Math.round((S - s) / 2 + dx);
  const y0 = Math.round((S - s) / 2 + dy);
  if (x0 < 0 || y0 < 0 || x0 + s > S || y0 + s > S) throw new Error('子窗口越界');
  const out = new Uint8ClampedArray(s * s * 4);
  const rowBytes = s * 4;
  for (let y = 0; y < s; y++) {
    const off = ((y0 + y) * S + x0) * 4;
    out.set(f.raw.subarray(off, off + rowBytes), y * rowBytes);
  }
  return { data: out, width: s, height: s };
}

/* ---------- 单配置跑全序列 ---------- */
function run(s, dx, dy) {
  const seq = frames.map((f) => {
    const r = analyze(crop(f, s, dx, dy), s, 1);   // s≈150 → 运行时 step=1
    return {
      t: f.t, valid: r.valid, angle: r.angle, conf: r.conf,
      cyans: r.cyans, noseFlat: r.noseFlat, angMargin: r.angMargin,
      radMargin: r.radMargin, corners: r.corners ? r.corners.length : 0,
      bcX: r.bcX, bcY: r.bcY
    };
  });
  return { s, dx, dy, seq };
}

/* ---------- 指标 ---------- */
const ad = (a, b) => Math.abs(angDiff(a, b));
function metrics(R) {
  const q = R.seq;
  const v = q.filter((e) => e.valid);
  const mean = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const pct = (arr, p) => {
    if (!arr.length) return 0;
    const a = [...arr].sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.floor(a.length * p))];
  };
  const diffs = [];
  let pulses = 0;
  for (let i = 1; i < q.length; i++) {
    if (q[i].valid && q[i - 1].valid) diffs.push(ad(q[i].angle, q[i - 1].angle));
  }
  // 孤立脉冲：连续三帧都有效，本帧相对前后都 >90°，而前后彼此 <30°
  for (let i = 1; i < q.length - 1; i++) {
    const a = q[i - 1], b = q[i], c = q[i + 1];
    if (!a.valid || !b.valid || !c.valid) continue;
    if (ad(b.angle, a.angle) > 90 && ad(b.angle, c.angle) > 90 && ad(a.angle, c.angle) < 30) pulses++;
  }
  return {
    validRate: +(v.length / q.length).toFixed(3),
    confMean: +mean(v.map((e) => e.conf)).toFixed(3),
    confP10: +pct(v.map((e) => e.conf), 0.1).toFixed(3),
    angMargin: +mean(v.map((e) => e.angMargin)).toFixed(1),
    radMargin: +mean(v.map((e) => e.radMargin)).toFixed(2),
    noseFlat: +mean(v.map((e) => e.noseFlat)).toFixed(2),
    diffP50: +pct(diffs, 0.5).toFixed(1),
    diffP90: +pct(diffs, 0.9).toFixed(1),
    bigJumps: diffs.filter((d) => d > 60).length,
    pulses
  };
}

/* 与参考配置的逐帧偏差（只在两者都有效时比较） */
function deviation(R, BASE) {
  const ds = [];
  for (let i = 0; i < R.seq.length; i++) {
    const a = R.seq[i], b = BASE.seq[i];
    if (a && b && a.valid && b.valid) ds.push(ad(a.angle, b.angle));
  }
  const s = [...ds].sort((x, y) => x - y);
  return {
    n: ds.length,
    median: s.length ? +s[s.length >> 1].toFixed(1) : 0,
    p90: s.length ? +s[Math.floor(s.length * 0.9)].toFixed(1) : 0,
    over20: ds.filter((d) => d > 20).length,
    over90: ds.filter((d) => d > 90).length
  };
}

/* ---------- 配置 ---------- */
const S_REF = 150, R_REF = 0.14965378560000003;
const CX_TRUE = 280 / 1920, CY_TRUE = 266 / 1080;
const toS = (r) => Math.round(S_REF * r / R_REF);
const toDX = (cx) => +((cx - CX_TRUE) * 1920).toFixed(1);
const toDY = (cy) => +((cy - CY_TRUE) * 1080).toFixed(1);

// 用户/开发版真实配置
const A = { name: 'A 打包版初始 SEED', cx: .1434, cy: .2481, r: .1542 };
const B = { name: 'B 只缩小 r', cx: .1434, cy: .2481, r: .1427892 };
const C = { name: 'C 只移圆心', cx: .14746137727479894, cy: .2481, r: .1542 };
const D = { name: 'D 用户当前（缩小+移心）', cx: .14746137727479894, cy: .2481, r: .1427892 };
const E = { name: 'E 开发版（原基准）', cx: .14649973227204588, cy: .24885233396531967, r: .14965378560000003 };
const cfgs = [A, B, C, D, E].map((c) => ({ ...c, s: toS(c.r), dx: toDX(c.cx), dy: toDY(c.cy) }));
console.log('\n配置映射：');
for (const c of cfgs) console.log(`  ${c.name.padEnd(26)} s=${String(c.s).padStart(3)} dx=${String(c.dx).padStart(5)} dy=${String(c.dy).padStart(5)}`);

const cache = new Map();
const keyOf = (s, dx, dy) => `${s}|${dx}|${dy}`;
function get(s, dx, dy) {
  const k = keyOf(s, dx, dy);
  if (!cache.has(k)) cache.set(k, run(s, dx, dy));
  return cache.get(k);
}

console.log('\n===== 五配置消融 =====');
const results = [];
for (const c of cfgs) {
  const R = get(c.s, c.dx, c.dy);
  const m = metrics(R);
  results.push({ ...c, ...m });
  console.log(`  ${c.name.padEnd(26)} valid=${m.validRate} conf=${m.confMean} p50=${m.diffP50}° p90=${m.diffP90}° 大跳=${String(m.bigJumps).padStart(3)} 脉冲=${String(m.pulses).padStart(2)} angM=${m.angMargin}`);
}

const DC = cfgs[3];                          // cfgs 里才带 s/dx/dy
const REF = get(DC.s, DC.dx, DC.dy);         // 用户说「准」的配置作参考
console.log('\n===== 相对用户当前配置的逐帧偏差 =====');
for (const c of cfgs) {
  const d = deviation(get(c.s, c.dx, c.dy), REF);
  console.log(`  ${c.name.padEnd(26)} n=${d.n} 中位=${d.median}° p90=${d.p90}° >20°=${d.over20} >90°=${d.over90}`);
}

console.log('\n===== 尺度扫描（圆心固定对准，dx=dy=0） =====');
for (const s of [125, 130, 135, 140, 143, 145, 150, 155, 160, 165, 170, 180]) {
  const m = metrics(get(s, 0, 0));
  console.log(`  s=${String(s).padStart(3)} (r≈${(s / S_REF * R_REF).toFixed(4)})  valid=${m.validRate} conf=${m.confMean} p50=${m.diffP50}° p90=${m.diffP90}° 大跳=${String(m.bigJumps).padStart(3)} 脉冲=${String(m.pulses).padStart(2)} angM=${m.angMargin}`);
}

console.log('\n===== 圆心 X 扫描（s=150, dy=0） =====');
for (const dx of [-8, -6, -4, -2, 0, 2, 4, 6, 8]) {
  const m = metrics(get(150, dx, 0));
  console.log(`  dx=${String(dx).padStart(3)}  valid=${m.validRate} conf=${m.confMean} p50=${m.diffP50}° p90=${m.diffP90}° 大跳=${String(m.bigJumps).padStart(3)} 脉冲=${String(m.pulses).padStart(2)} angM=${m.angMargin}`);
}

const out = {
  spec: { frames: frames.length, S_REF, R_REF, CX_TRUE, CY_TRUE, note: '离线 363px 裁窗，step=1 复现几何通道' },
  configs: results,
  scaleScan: [125, 130, 135, 140, 143, 145, 150, 155, 160, 165, 170, 180].map((s) => ({ s, ...metrics(get(s, 0, 0)) })),
  dxScan: [-8, -6, -4, -2, 0, 2, 4, 6, 8].map((dx) => ({ dx, ...metrics(get(150, dx, 0)) }))
};
fs.writeFileSync(ROOT + '/scripts/vision-probe/roi-scale-ab.json', JSON.stringify(out, null, 2));
console.log('\n→ scripts/vision-probe/roi-scale-ab.json');

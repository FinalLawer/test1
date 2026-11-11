'use strict';
/* 双半径边择优：权重 W / 归一化上限 cap 的标定与消融（2026-11-06）。
 *
 * 当前源码内置 rank = score + 0.6 * min(1, edgeBoost(c) / 30)。
 * 本脚本直接对 analyzeCone 的那两行做参数替换，扫描 W 与 cap，
 * 在 166 帧真实视频 + 两帧实拍上对比：
 *   检出 / 误检、相对 W=0 基线的改向帧（好/坏）、相邻帧大跳、
 *   与「高置信锚点插值」的偏差（残留白标干扰的直接指标）。
 *
 * W=0 把排序换回 y.score，边证据仍在算但不参与择优，是严格的关通道对照。
 * cap=0 表示去掉 Math.min 饱和（rank = score + W * boost/30）。
 * 若源码里 rank 实现改名，下面的字符串检查会主动报错，避免静默失效。
 *
 * 另外把每帧的全部候选（含 boost）导出到 globalThis.__coneCand，
 * 用来回答「单纯提高 W 有没有用」：若大部分候选 boost/30 已经 >= 1，
 * 提高 W 只是给所有「有边」候选统一加常数，排序几乎不变。
 */
const fs = require('fs');
const src = fs.readFileSync(require('path').join(require('path').resolve(__dirname, '..', '..'), 'src', 'webview-preload.js'), 'utf8');
const h0 = src.indexOf('function degOf(ux, uy) {');
const h1 = src.indexOf('/* ---------------------------------------------------------------- 扇形通道', h0);
const c0 = src.indexOf('function analyzeCone(img, size, step) {');
const c1 = src.indexOf('/**\n * 圆形 α-β 滤波', c0);
const H = new Function(src.slice(h0, h1) + ';return { degOf, angDiff };')();
const CORE = src.slice(c0, c1);
const ad = (x, y) => Math.abs(((x - y + 540) % 360) - 180);

const RANK_LINE = '    const rank = score + 0.6 * Math.min(1, edgeBoost(c) / 30);';
const SORT_LINE = '  cand.sort((x, y) => y.rank - x.rank);';
if (!CORE.includes(RANK_LINE) || !CORE.includes(SORT_LINE)) {
  throw new Error('源码里的 rank 择优实现已变化，请同步本标定脚本');
}
const INJECTED = CORE.replace(
  SORT_LINE,
  '  globalThis.__coneCand = cand.map((t) => ({ c: t.c, score: t.score, boost: edgeBoost(t.c) }));\n' + SORT_LINE
);
function build(W, cap = 30) {
  const term = cap === 0
    ? '(edgeBoost(c) / 30)'
    : `Math.min(1, edgeBoost(c) / ${cap})`;
  let c = INJECTED.replace(RANK_LINE, `    const rank = score + ${W} * ${term};`);
  if (W === 0) c = c.replace(SORT_LINE, '  cand.sort((x, y) => y.score - x.score);');
  return new Function('degOf', 'angDiff', c + ';return analyzeCone;')(H.degOf, H.angDiff);
}

const man = JSON.parse(fs.readFileSync(require('path').join(require('os').tmpdir(), 'vidroi.json'), 'utf8'));
const gate = JSON.parse(fs.readFileSync(require('path').join(require('os').tmpdir(), 'vidscan-gate.json'), 'utf8'));
const gm = new Map(gate.map((g) => [g.t, g.blob >= 8]));
const blob = fs.readFileSync(require('path').join(require('os').tmpdir(), 'vidroi.bin'));
const frames = man.list.map((e) => {
  const S = e.size, bytes = S * S * 4;
  return { t: e.t, has: gm.get(e.t) === true, S,
    img: { data: new Uint8ClampedArray(blob.buffer.slice(blob.byteOffset + e.off, blob.byteOffset + e.off + bytes)), width: S, height: S } };
});
const FIX = require('path').join(__dirname, 'fixtures') + '/';
const shots = [
  { n: '标注帧', raw: FIX + 'icon-frame-135deg.raw', size: 165 },
  { n: '本次截图', raw: FIX + 'current-frame.raw', size: 142 },
].map((s) => ({ ...s, img: { data: new Uint8ClampedArray(fs.readFileSync(s.raw)), width: s.size, height: s.size } }));

const base = build(0);
const B = frames.map((e) => {
  const r = base(e.img, e.S, man.step);
  return { t: e.t, has: e.has, deg: r.deg, conf: r.conf, ok: r.valid && (r.cyanFrac || 0) >= 0.0015 };
});
const anchors = B.filter((r) => r.has && r.ok && r.conf >= 0.35);
function interp(t) {
  const a = [...anchors].filter((r) => r.t < t).sort((x, y) => y.t - x.t)[0];
  const b = [...anchors].filter((r) => r.t > t).sort((x, y) => x.t - y.t)[0];
  if (!a || !b || b.t - a.t > 12) return null;
  const w = (t - a.t) / (b.t - a.t);
  let d = b.deg - a.deg;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return (a.deg + d * w + 360) % 360;
}

function ev(f) {
  const s0 = f(shots[0].img, 165, 1), s1 = f(shots[1].img, 142, 1);
  let hit = 0, fp = 0, chg = 0, good = 0, bad = 0, confUp = 0;
  const seq = [], errs = [], offenders = [];
  for (let i = 0; i < frames.length; i++) {
    const e = frames[i], r = f(e.img, e.S, man.step), b = B[i];
    const ok = r.valid && (r.cyanFrac || 0) >= 0.0015;
    if (e.has && ok) hit++;
    else if (!e.has && ok) fp++;
    if (e.has && b.ok && ok) {
      if (r.conf > b.conf + 0.05) confUp++;
      if (ad(r.deg, b.deg) > 15) {
        chg++;
        const ref = interp(e.t);
        if (ref !== null) { if (ad(r.deg, ref) < ad(b.deg, ref)) good++; else bad++; }
      }
      const ref = interp(e.t);
      if (ref !== null && r.conf >= 0.2) {
        const err = ad(r.deg, ref);
        errs.push(err);
        if (err > 25) offenders.push({ t: e.t, deg: r.deg, ref, err, conf: r.conf });
      }
    }
    seq.push({ t: e.t, ok: e.has && ok, deg: r.deg });
  }
  const j = [];
  for (let i = 1; i < seq.length; i++) {
    if (seq[i].ok && seq[i - 1].ok && seq[i].t - seq[i - 1].t <= 4) j.push(ad(seq[i].deg, seq[i - 1].deg));
  }
  j.sort((a, b) => a - b);
  errs.sort((a, b) => a - b);
  return { s0, s1, hit, fp, chg, good, bad, confUp, offenders,
    meanErr: errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : 0,
    p90Err: errs[Math.floor(errs.length * 0.9)] || 0,
    bad25: offenders.length,
    med: j[j.length >> 1] || 0, p90: j[Math.floor(j.length * 0.9)] || 0, big: j.filter((x) => x > 60).length };
}

const cases = [
  [0, 30], [0.3, 30], [0.6, 30], [1.0, 30], [1.5, 30], [2.0, 30], [3.0, 30], [5.0, 30], [10.0, 30],
  [0.6, 60], [1.2, 60], [0.6, 120], [1.2, 120], [0.6, 0], [1.2, 0],
];
console.log('W   cap | 标注帧误差 本次截图 | 检出 误检 | 改向(好/坏) | 跳变 p90/>60° | 偏差帧(>25°) 均误 p90误');
const results = [];
for (const [W, cap] of cases) {
  const f = build(W, cap);
  const r = ev(f);
  results.push({ W, cap, r });
  console.log(
    `${W.toFixed(1).padStart(4)} ${String(cap).padStart(3)} | ` +
    `${ad(r.s0.deg, 135).toFixed(1).padStart(6)}° ${r.s1.deg.toFixed(1).padStart(6)}° | ` +
    `${r.hit}/153 ${r.fp}/13 | ${String(r.chg).padStart(2)}(${r.good}/${r.bad}) | ` +
    `${r.p90.toFixed(1).padStart(5)}/${String(r.big).padStart(2)} | ` +
    `${String(r.bad25).padStart(2)} ${r.meanErr.toFixed(1).padStart(5)} ${r.p90Err.toFixed(1).padStart(5)}`
  );
}

/* 边证据饱和诊断：boost>=cap 的候选占多少、每帧是否「所有候选都饱和」。 */
const fdiag = build(0.6, 30);
let total = 0, sat = 0, framesAllSat = 0, framesWithCand = 0;
const boosts = [];
const winnerLoses = [];
for (const e of frames) {
  globalThis.__coneCand = null;
  const r = fdiag(e.img, e.S, man.step);
  const cs = globalThis.__coneCand || [];
  if (!cs.length) continue;
  framesWithCand++;
  const nSat = cs.filter((c) => c.boost >= 30).length;
  total += cs.length; sat += nSat;
  if (nSat === cs.length) framesAllSat++;
  for (const c of cs) boosts.push(c.boost);
  const byScore = [...cs].sort((x, y) => y.score - x.score)[0];
  if (r.dbg && byScore && r.dbg.c !== byScore.c) {
    winnerLoses.push({ t: e.t, scoreWinnerBoost: byScore.boost, rankWinnerBoost: cs.find((c) => c.c === r.dbg.c).boost });
  }
}
boosts.sort((a, b) => a - b);
console.log('\n--- 边证据 boost 分布（cap=30 口径）---');
console.log(`候选总数 ${total}，boost>=30 已饱和 ${sat} (${(100 * sat / total).toFixed(1)}%)`);
console.log(`有候选的帧 ${framesWithCand}，其中「全部候选都饱和」${framesAllSat} 帧 (${(100 * framesAllSat / framesWithCand).toFixed(1)}%)`);
console.log(`boost 中位 ${boosts[boosts.length >> 1].toFixed(1)} / p90 ${boosts[Math.floor(boosts.length * 0.9)].toFixed(1)} / max ${boosts[boosts.length - 1].toFixed(1)}`);
console.log(`W=0.6 时 rank 峰与 score 峰不同选的帧 ${winnerLoses.length}`);
if (winnerLoses.length) {
  const a = winnerLoses.map((x) => x.rankWinnerBoost - x.scoreWinnerBoost).sort((x, y) => x - y);
  console.log(`  这些帧 rank 峰的 boost 相对 score 峰的差：中位 ${a[a.length >> 1].toFixed(1)}，为正 ${a.filter((x) => x > 0).length}/${a.length}`);
}

/* 残留干扰帧明细：只看当前 W=0.6 与高权重 W=3.0。 */
for (const [W, cap] of [[0.6, 30], [3.0, 30]]) {
  const r = results.find((x) => x.W === W && x.cap === cap).r;
  console.log(`\n--- 与锚点插值偏差 >25° 的帧（W=${W}）共 ${r.offenders.length} 帧 ---`);
  for (const o of r.offenders.slice(0, 16)) {
    console.log(`  t=${String(o.t).padStart(3)}s deg=${o.deg.toFixed(1).padStart(6)}° ref=${o.ref.toFixed(1).padStart(6)}° 误差=${o.err.toFixed(1).padStart(5)}° conf=${o.conf.toFixed(2)}`);
  }
}

'use strict';
/* 梯度峰 + 强制 90° 配对：对 EV 宽带边证据的 A/B（2026-11-07）。
 *
 * 方法论来源：BetterGI 的 CameraOrientationFromGia（GPL-3.0，只读学习，不移植代码）。
 * 它的关键不是「求梯度」，而是：
 *   ① 在极坐标展开图上，**每条半径行独立**沿角度方向找梯度局部极大/极小；
 *   ② 把峰位置跨行**投票**累加 —— 从圆心出发的射线在所有行同一角度，
 *      斜穿画面的海岸线在极坐标里角度随半径漂移，票数自然散掉；
 *   ③ 进入边与离开边必须相隔 90°（±容差）才相乘配对，再做三角卷积。
 * 我们当前 EV 是「10~30° 宽带亮度差跨 6 层平均」，长直线能整体抬升宽带，
 * 500 帧里 t=111.37 / t=117.31 两帧疑似误检正是海岸线 + 密集白标。
 *
 * 本脚本只做离线注入副本，不改 src/webview-preload.js：
 *   - 在像素循环里额外累加 72 角格 × 18 径向层的亮度网格（沿用纯白图标同层回填）；
 *   - 逐层中心差分 + 严格局部极大/极小投票（计数票 / 强度票两种）；
 *   - 90° 配对（单向 / 双向），三角加权 ±2 格，再平滑，开方还原量纲；
 *   - 先把配对峰当「独立第二意见」诊断，再替换/叠加进 rank 做全量 A/B。
 *
 * 统一标尺：frames500-summary.json 里由 W=0.6 序列构建的局部伪真值 ref，
 * 保证不同配置可比，不受各自序列影响。硬指标：
 *   t=111.37 / 117.31 两帧疑似误差、标注帧误差(真值135°)、本次截图方向、
 *   500 帧孤立偏差帧数 / 均误 / 大跳、有图检出。
 */
const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '..', '..');
const TMP = require('path').join(require('os').tmpdir(), 'vidframes500');
const FIX = ROOT + '/scripts/vision-probe/fixtures/';

const src = fs.readFileSync(ROOT + '/src/webview-preload.js', 'utf8');
const h0 = src.indexOf('function degOf(ux, uy) {');
const h1 = src.indexOf('/* ---------------------------------------------------------------- 扇形通道', h0);
const c0 = src.indexOf('function analyzeCone(img, size, step) {');
const c1 = src.indexOf('/**\n * 圆形 α-β 滤波', c0);
const H = new Function(src.slice(h0, h1) + ';return { degOf, angDiff };')();
const CORE = src.slice(c0, c1);
const ad = (x, y) => Math.abs(((x - y + 540) % 360) - 180);

/* ---------------------------------------------------------------- 注入点 */
const DECL = '  const pureAt = [];                        // 纯白图标像素落在哪个格段';
const KLINE = '      const k = b * SEGS + seg;';
const PUSH = '        pureAt.push(k);';
const ACC = '      segTot[k] += 1;\n      segLum[k] += lum;';
const FILL = `  for (const k of pureAt) {
    const seg = k % SEGS;
    const fill = layerTot[seg] ? layerLum[seg] / layerTot[seg] : 0;
    segTot[k] += 1;
    segLum[k] += fill;
  }`;
const CAND = '  const cand = [];';
const RANK_LINE = '    const rank = score + 0.6 * Math.min(1, edgeBoost(c) / 30);';
const SORT_LINE = '  cand.sort((x, y) => y.rank - x.rank);';
for (const [n, s] of Object.entries({ DECL, KLINE, PUSH, ACC, FILL, CAND, RANK_LINE, SORT_LINE })) {
  if (!CORE.includes(s)) throw new Error('源码注入点已变化: ' + n + '，请同步本脚本');
}

const FINE = `
  /* --- 细径向网格：仅用于梯度峰投票，不参与原有结构分 --- */
  const FS = 18;
  const fTot = new Uint32Array(NB2 * FS);
  const fLum = new Float64Array(NB2 * FS);
  const fLayerLum = new Float64Array(FS);
  const fLayerTot = new Uint32Array(FS);
  const pureAtF = [];
  const invFSpan = FS / (rOut - rIn);`;

const GIA = `
  /* --- 梯度峰 + 90° 配对（Gia 方法论，独立实现） --- */
  const FL = new Float32Array(NB2 * FS);
  for (let a = 0; a < NB2; a += 1) {
    for (let s = 0; s < FS; s += 1) {
      const k = a * FS + s;
      FL[k] = fTot[k] ? fLum[k] / fTot[k] : 0;
    }
  }
  // 每层角度方向 3 点平滑，压掉视频压缩噪声
  const SM = new Float32Array(NB2 * FS);
  for (let s = 0; s < FS; s += 1) {
    for (let a = 0; a < NB2; a += 1) {
      SM[a * FS + s] = (FL[((a - 1 + NB2) % NB2) * FS + s] +
        2 * FL[a * FS + s] + FL[((a + 1) % NB2) * FS + s]) / 4;
    }
  }
  // 每条半径行独立投票：正梯度局部极大 = 进入边，负梯度局部极小 = 离开边
  const enterC = new Float32Array(NB2), leaveC = new Float32Array(NB2);
  const enterS = new Float32Array(NB2), leaveS = new Float32Array(NB2);
  for (let s = 0; s < FS; s += 1) {
    const g = new Float32Array(NB2);
    for (let a = 0; a < NB2; a += 1) {
      g[a] = SM[((a + 1) % NB2) * FS + s] - SM[((a - 1 + NB2) % NB2) * FS + s];
    }
    for (let a = 0; a < NB2; a += 1) {
      const gl = g[(a - 1 + NB2) % NB2], gm = g[a], gr = g[(a + 1) % NB2];
      if (gm > 0 && gm > gl && gm > gr) { enterC[a] += 1; enterS[a] += gm; }
      if (gm < 0 && gm < gl && gm < gr) { leaveC[a] += 1; leaveS[a] -= gm; }
    }
  }
  // 双向混淆抑制：同一角度不可能既是进入边又是离开边
  const net = (e, l) => {
    const a = new Float32Array(NB2), b = new Float32Array(NB2);
    for (let i = 0; i < NB2; i += 1) {
      a[i] = Math.max(0, e[i] - l[i]);
      b[i] = Math.max(0, l[i] - e[i]);
    }
    return [a, b];
  };
  const [eC, lC] = net(enterC, leaveC);
  const [eS, lS] = net(enterS, leaveS);
  const W3 = [1 / 3, 2 / 3, 1, 2 / 3, 1 / 3];
  const pairAt = (e, l, c, rev) => {
    let p = 0;
    for (let i = -2; i <= 2; i += 1) {
      for (let j = -2; j <= 2; j += 1) {
        const A = (c - 9 + i + NB2) % NB2, B = (c + 9 + j + NB2) % NB2;
        p += W3[i + 2] * W3[j + 2] * (rev ? l[A] * e[B] : e[A] * l[B]);
      }
    }
    return p;
  };
  const makeP = (e, l, sym) => {
    const raw = new Float32Array(NB2);
    for (let c = 0; c < NB2; c += 1) {
      let v = pairAt(e, l, c, false);
      if (sym) v = Math.max(v, pairAt(e, l, c, true));
      raw[c] = v;
    }
    const P = new Float32Array(NB2);
    for (let c = 0; c < NB2; c += 1) {
      let v = 0;
      for (let i = -2; i <= 2; i += 1) v += W3[i + 2] * raw[(c + i + NB2) % NB2];
      P[c] = Math.sqrt(Math.max(0, v));
    }
    return P;
  };
  const giaP = {
    fwdC: makeP(eC, lC, false), symC: makeP(eC, lC, true),
    fwdS: makeP(eS, lS, false), symS: makeP(eS, lS, true)
  };
  const giaMax = {}, giaMin = {};
  for (const k of Object.keys(giaP)) {
    let mx = 0, mn = 1e9;
    for (let a = 0; a < NB2; a += 1) {
      if (giaP[k][a] > mx) mx = giaP[k][a];
      if (giaP[k][a] < mn) mn = giaP[k][a];
    }
    giaMax[k] = mx;
    giaMin[k] = mn;
  }
  globalThis.__giaP = giaP;
  globalThis.__giaVotes = { enterC, leaveC, enterS, leaveS, giaMax, giaMin };
`;

function injectBase() {
  let c = CORE;
  c = c.replace(DECL, DECL + FINE);
  c = c.replace(KLINE, KLINE + '\n      const fseg = Math.min(FS - 1, ((rho - rIn) * invFSpan) | 0);\n      const fk = b * FS + fseg;');
  c = c.replace(PUSH, PUSH + '\n        pureAtF.push(fk);');
  c = c.replace(ACC, ACC + '\n      fTot[fk] += 1;\n      fLum[fk] += lum;\n      fLayerLum[fseg] += lum;\n      fLayerTot[fseg] += 1;');
  c = c.replace(FILL, `  for (let pi = 0; pi < pureAt.length; pi += 1) {
    const k = pureAt[pi];
    const fk = pureAtF[pi];
    const seg = k % SEGS;
    const fill = layerTot[seg] ? layerLum[seg] / layerTot[seg] : 0;
    segTot[k] += 1;
    segLum[k] += fill;
    const fseg = fk % FS;
    const ffill = fLayerTot[fseg] ? fLayerLum[fseg] / fLayerTot[fseg] : 0;
    fTot[fk] += 1;
    fLum[fk] += ffill;
  }`);
  c = c.replace(CAND, GIA + '\n' + CAND);
  return c;
}
const BASE = injectBase();

/* mode: base | replace | add | tie
 * key: giaP 的键 ; cap: 绝对归一化分母
 * norm: abs = 绝对常数封顶；rel = 帧内最大值归一；ctr = 帧内 min~max 拉伸
 *       （计数票全帧只有 16~23.4，abs 会让所有候选拿到几乎相同的加分，等于没加） */
function build(mode, key, W, cap, norm = 'abs', tieWin = 0.15) {
  let c = BASE;
  const term = (k, cp, nm, v) => {
    if (nm === 'rel') return `(giaP.${k}[${v}] / (giaMax.${k} + 1e-6))`;
    if (nm === 'ctr') return `((giaP.${k}[${v}] - giaMin.${k}) / (giaMax.${k} - giaMin.${k} + 1e-6))`;
    return `Math.min(1, giaP.${k}[${v}] / ${cp})`;
  };
  if (mode === 'base') {
    // 保持原样
  } else if (mode === 'replace') {
    c = c.replace(RANK_LINE, `    const rank = score + ${W} * ${term(key, cap, norm, 'c')};`);
  } else if (mode === 'add') {
    c = c.replace(RANK_LINE, `    const rank = score + 0.6 * Math.min(1, edgeBoost(c) / 30) + ${W} * ${term(key, cap, norm, 'c')};`);
  } else if (mode === 'tie') {
    c = c.replace(RANK_LINE, '    const rank = score;');
    c = c.replace(SORT_LINE, `  {
    let top = -1e9;
    for (const t of cand) if (t.score > top) top = t.score;
    for (const t of cand) {
      t.rank = t.score + (t.score >= top - ${tieWin} ? ${W} * ${term(key, cap, norm, 't.c')} : 0);
    }
  }
` + SORT_LINE);
  } else throw new Error('unknown mode ' + mode);
  return new Function('degOf', 'angDiff', c + ';return analyzeCone;')(H.degOf, H.angDiff);
}

/* ---------------------------------------------------------------- 数据 */
const man = JSON.parse(fs.readFileSync(TMP + '/vidroi500.json', 'utf8'));
const blob = fs.readFileSync(TMP + '/vidroi500.bin');
const frames = man.list.map((e) => {
  const bytes = e.size * e.size * 4;
  return { t: e.t, S: e.size,
    img: { data: new Uint8ClampedArray(blob.buffer, blob.byteOffset + e.off, bytes), width: e.size, height: e.size } };
});
const summary = JSON.parse(fs.readFileSync(ROOT + '/scripts/vision-probe/frames500-summary.json', 'utf8'));
const refs = summary.frames.map((f) => f.ref);
const suspectTimes = summary.frames.filter((f) => f.suspect).map((f) => f.t);
const shots = [
  { n: '标注帧', p: FIX + 'icon-frame-135deg.raw', S: 165, truth: 135 },
  { n: '本次截图', p: FIX + 'current-frame.raw', S: 142, truth: null }
].map((s) => ({ ...s, img: { data: new Uint8ClampedArray(fs.readFileSync(s.p)), width: s.S, height: s.S } }));
console.log(`帧数 ${frames.length}，有可信 ref ${refs.filter((x) => x !== null).length}，疑似误检帧 ${suspectTimes.join(' / ')}s`);

/* ---------------------------------------------------------------- 阶段1：配对峰当独立第二意见 */
console.log('\n=== 阶段1：90° 配对峰本身能否当方向估计（argmax·5+2.5 对比 ref）===');
const diagF = build('base');
const diag = frames.map((e) => { diagF(e.img, e.S, man.step); return globalThis.__giaP; });
const diagShots = shots.map((s) => { diagF(s.img, s.S, 1); return globalThis.__giaP; });
const KEYS = ['fwdC', 'symC', 'fwdS', 'symS'];
const allP = [];
for (const k of KEYS) {
  const errs = [], tops = [];
  diag.forEach((p, i) => {
    const P = p[k];
    let bi = 0; for (let a = 1; a < 72; a += 1) if (P[a] > P[bi]) bi = a;
    tops.push(P[bi]);
    if (refs[i] !== null) errs.push(ad(bi * 5 + 2.5, refs[i]));
  });
  errs.sort((a, b) => a - b); tops.sort((a, b) => a - b);
  allP.push(...diag.map((p) => Math.max(...p[k])));
  const sus = suspectTimes.map((t) => {
    const i = frames.findIndex((e) => e.t === t);
    const P = diag[i][k];
    let bi = 0; for (let a = 1; a < 72; a += 1) if (P[a] > P[bi]) bi = a;
    return `${(bi * 5 + 2.5).toFixed(0)}°(ref${refs[i].toFixed(0)}°)`;
  });
  const s0 = diagShots[0][k], s1 = diagShots[1][k];
  const arg = (P) => { let b = 0; for (let a = 1; a < 72; a += 1) if (P[a] > P[b]) b = a; return b * 5 + 2.5; };
  console.log(`${k.padEnd(5)} | 中位误差 ${(errs[errs.length >> 1] || 0).toFixed(1).padStart(5)}° ` +
    `<20° ${String(errs.filter((x) => x < 20).length).padStart(3)}/${errs.length} | ` +
    `峰强中位 ${tops[tops.length >> 1].toFixed(1)} / max ${tops[tops.length - 1].toFixed(1)} | ` +
    `标注帧 ${arg(s0).toFixed(0)}° 本次截图 ${arg(s1).toFixed(0)}° | 两帧疑似 ${sus.join(' / ')}`);
}
allP.sort((a, b) => a - b);
console.log(`全部帧 P 峰值分布：p10 ${allP[Math.floor(allP.length * 0.1)].toFixed(1)} / 中位 ${allP[allP.length >> 1].toFixed(1)} / p90 ${allP[Math.floor(allP.length * 0.9)].toFixed(1)} / max ${allP[allP.length - 1].toFixed(1)}`);

/* 两帧疑似附近的时间序列：判断是「单帧误检」还是「ref 在快速转镜头时失效」 */
console.log('\n--- 两帧疑似附近的 deg / ref 序列（W=0.6 基线）---');
for (const st of suspectTimes) {
  const i0 = frames.findIndex((e) => e.t === st);
  const seg = [];
  for (let i = Math.max(0, i0 - 6); i <= Math.min(frames.length - 1, i0 + 6); i += 1) {
    const f = summary.frames[i];
    seg.push(`${f.t.toFixed(2)}s:${f.ok ? f.deg.toFixed(0) + '°' : '----'}/${f.ref === null ? 'no' : f.ref.toFixed(0) + '°'}${f.suspect ? '*' : ''}`);
  }
  console.log(`  ${st}s  ` + seg.join('  '));
}

/* ---------------------------------------------------------------- 阶段2：rank A/B */
function evalCfg(label, f) {
  const rr = frames.map((e) => {
    const r = f(e.img, e.S, man.step);
    return { deg: r.deg, conf: r.conf, cyan: r.cyanFrac || 0,
      ok: !!(r.valid && r.conf > 0.12 && (r.cyanFrac || 0) >= 0.0015) };
  });
  const errs = [], jumps = [];
  rr.forEach((x, i) => {
    if (refs[i] !== null && x.ok) errs.push(ad(x.deg, refs[i]));
    if (i > 0 && x.ok && rr[i - 1].ok && frames[i].t - frames[i - 1].t <= 1.4) jumps.push(ad(x.deg, rr[i - 1].deg));
  });
  errs.sort((a, b) => a - b); jumps.sort((a, b) => a - b);
  const sr = shots.map((s) => f(s.img, s.S, 1));
  const susErr = suspectTimes.map((t) => {
    const i = frames.findIndex((e) => e.t === t);
    return refs[i] === null ? null : ad(rr[i].deg, refs[i]);
  });
  const withMap = rr.filter((x) => x.cyan >= 0.0015).length;
  return { label,
    hit: rr.filter((x) => x.ok).length, withMap,
    over30: errs.filter((x) => x > 30).length,
    mean: errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : 0,
    p90e: errs[Math.floor(errs.length * 0.9)] || 0,
    big: jumps.filter((x) => x > 60).length,
    p90j: jumps[Math.floor(jumps.length * 0.9)] || 0,
    shot0: ad(sr[0].deg, 135), shot1: sr[1].deg,
    sus: susErr };
}
function line(r) {
  return `${r.label.padEnd(24)} | ${String(r.hit).padStart(3)}/${r.withMap} | ` +
    `${String(r.over30).padStart(2)} ${r.mean.toFixed(1).padStart(5)} ${r.p90e.toFixed(1).padStart(5)} | ` +
    `${String(r.big).padStart(2)} ${r.p90j.toFixed(1).padStart(5)} | ` +
    `${r.shot0.toFixed(1).padStart(5)}° ${r.shot1.toFixed(1).padStart(6)}° | ` +
    r.sus.map((x) => x === null ? 'n/a' : x.toFixed(1) + '°').join(' / ');
}
const HEAD = '配置                     | 检出/有图 | >30° 均误 p90误 | 大跳 p90跳 | 标注帧 本次截图 | 两帧疑似误差';
console.log('\n=== 阶段2：rank A/B（统一用 W=0.6 序列的局部 ref）===');
console.log(HEAD);
const results = [];
function push(label, f) { const r = evalCfg(label, f); results.push(r); console.log(line(r)); return r; }

push('base (当前 EV 0.6)', build('base'));

console.log('\n--- A. 绝对归一化（第一版，计数票几乎无区分度）---');
for (const W of [0.3, 0.6, 1.0]) push(`replace symC abs W${W}/30`, build('replace', 'symC', W, 30));
for (const W of [0.3, 0.6, 1.0]) push(`add symC abs W${W}/30`, build('add', 'symC', W, 30));
for (const W of [0.3, 0.6, 1.0]) push(`tie symC abs W${W}/30`, build('tie', 'symC', W, 30));

console.log('\n--- B. 帧内相对量 rel = P[c]/max(P) ---');
for (const W of [0.1, 0.3, 0.6, 1.0]) push(`add symC rel W${W}`, build('add', 'symC', W, 0, 'rel'));
for (const W of [0.1, 0.3, 0.6, 1.0]) push(`tie symC rel W${W}`, build('tie', 'symC', W, 0, 'rel'));
for (const W of [0.3, 0.6]) push(`replace symC rel W${W}`, build('replace', 'symC', W, 0, 'rel'));

console.log('\n--- C. 对比度拉伸 ctr = (P[c]-min)/(max-min) ---');
for (const W of [0.2, 0.5, 1.0]) push(`add symC ctr W${W}`, build('add', 'symC', W, 0, 'ctr'));
for (const W of [0.2, 0.5, 1.0]) push(`tie symC ctr W${W}`, build('tie', 'symC', W, 0, 'ctr'));

console.log('\n--- D. 其它配对变体（计数单向 / 强度票 / 双向强度）---');
for (const key of ['fwdC', 'fwdS', 'symS']) {
  push(`add ${key} rel W0.6`, build('add', key, 0.6, 0, 'rel'));
  push(`tie ${key} rel W0.6`, build('tie', key, 0.6, 0, 'rel'));
}

/* ---------------------------------------------------------------- 阶段3：共模失效诊断 */
console.log('\n=== 阶段3：两种独立方法论是否「共模失效」===');
const argOf = (P) => { let b = 0; for (let a = 1; a < 72; a += 1) if (P[a] > P[b]) b = a; return b * 5 + 2.5; };
let agree = 0, disagree = 0;
const disList = [];
diag.forEach((p, i) => {
  const f = summary.frames[i];
  if (!f.ok) return;
  const g = argOf(p.fwdC);
  if (ad(g, f.deg) < 30) agree += 1;
  else { disagree += 1; disList.push({ t: f.t, gia: g, deg: f.deg, ref: refs[i] }); }
});
console.log(`Gia(fwdC) 与当前识别器方向一致 ${agree} 帧 / 分歧 ${disagree} 帧（检出帧 ${agree + disagree}）`);
for (const t of suspectTimes) {
  const i = frames.findIndex((e) => e.t === t);
  const f = summary.frames[i];
  console.log(`  t=${t}s  当前 deg ${f.deg.toFixed(1)}° conf ${f.conf.toFixed(2)} | ` +
    `Gia 计数票 ${argOf(diag[i].fwdC).toFixed(0)}° 强度票 ${argOf(diag[i].fwdS).toFixed(0)}° | ref ${refs[i].toFixed(1)}°`);
}

/* ---------------------------------------------------------------- 阶段4：时序层孤立脉冲抑制的离线可行性
 * 两帧误检 conf 高 ⇒ updateView 的 (jump>100 && conf>=0.55) 直接就位，平滑完全绕过。
 * 这里按帧模拟三种门限，不改源码。注意 500 帧是 0.66s 间隔，运行时帧率高得多，
 * 「延迟一帧」的实际代价远小于这里的 0.66s；k 按帧施加，故绝对收敛速度不可直接外推。
 */
const signed = H.angDiff;
function simulate(strategy) {
  let theta = -1, pending = null, held = 0, confirmed = 0;
  const out = frames.map((e, i) => {
    const f = summary.frames[i];
    if (!f.ok) return { deg: theta, conf: 0, held: false };
    const deg = f.deg, conf = f.conf;
    if (theta < 0) { theta = deg; return { deg: theta, conf, held: false }; }
    let wasPending = false;
    if (pending !== null) {
      wasPending = true;
      if (ad(deg, pending) < 30) { theta = deg; confirmed += 1; }
      pending = null;
    }
    const jump = ad(deg, theta);
    if (jump > 100) {
      if (strategy === 'confirm') { pending = deg; held += 1; return { deg: theta, conf, held: true }; }
      if (conf >= 0.55) theta = deg;
      else theta = (theta + signed(deg, theta) * 0.05 + 360) % 360;
    } else {
      const k = jump > 100 ? 0.05 : 0.10 + 0.62 * conf;
      theta = (theta + signed(deg, theta) * k + 360) % 360;
    }
    return { deg: theta, conf, held: wasPending };
  });
  return { out, held, confirmed };
}
console.log('\n=== 阶段4：时序层门限模拟（按帧，0.66s 抽帧序列）===');
console.log('策略           | 有ref帧 均误 p90误 >30° | 两帧疑似上屏误差 | 上屏大跳 | hold/确认');
for (const st of ['current', 'confirm']) {
  const { out, held, confirmed } = simulate(st);
  const errs = [], jumps = [];
  out.forEach((x, i) => {
    if (refs[i] !== null) errs.push(ad(x.deg, refs[i]));
    if (i > 0 && frames[i].t - frames[i - 1].t <= 1.4) jumps.push(ad(x.deg, out[i - 1].deg));
  });
  errs.sort((a, b) => a - b);
  const susErr = suspectTimes.map((t) => {
    const i = frames.findIndex((e) => e.t === t);
    return ad(out[i].deg, refs[i]);
  });
  console.log(`${st.padEnd(14)} | ${String(errs.length).padStart(3)} ${(errs.reduce((a, b) => a + b, 0) / errs.length).toFixed(1).padStart(5)} ` +
    `${(errs[Math.floor(errs.length * 0.9)] || 0).toFixed(1).padStart(5)} ${String(errs.filter((x) => x > 30).length).padStart(3)} | ` +
    `${susErr[0].toFixed(1).padStart(6)}° / ${susErr[1].toFixed(1).padStart(6)}° | ` +
    `${String(jumps.filter((x) => x > 60).length).padStart(3)} | ${held}/${confirmed}`);
}

fs.writeFileSync(ROOT + '/scripts/vision-probe/gradient-pair-ab.json', JSON.stringify({
  spec: { frames: frames.length, fineLayers: 18, keys: KEYS, refSource: 'frames500-summary.json (W=0.6)' },
  suspectTimes, results
}, null, 2));
console.log('\nAB → scripts/vision-probe/gradient-pair-ab.json');

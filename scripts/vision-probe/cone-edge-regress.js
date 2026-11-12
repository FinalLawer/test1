'use strict';
/* 扇形通道回归：半径边 + 白膜 alpha 一致性（2026-11-12）。
 *
 * 三部分，前一部分不依赖任何外部素材，随时可跑：
 *
 *   A. 合成帧。按真实视频实测到的渲染模型生成（张角 90°、硬边，
 *      dst = src + α(r)·(255 − src)，α(r) = 0.40·(1 − r/R)）；
 *        底色是水 (40,93,103) / 陆 (146,170,108) 被一条斜穿的海岸线分开；
 *        上面再盖不透明白色标点（带 1.5px 抗锯齿灰边）和圆心的青色箭头。
 *      覆盖 24 个朝向 × 3 种布局 × 2 种窗口尺寸，另有「标点铺满角度带」的极端密度、
 *      「只有标点没有扇形」的负样本。
 *
 *   B. 用户实拍标注帧 fixtures/icon-frame-135deg.raw（真值 135°，白色标点压住一条边）。
 *
 *   C. Temp/vidframes500 的 500 帧真实视频：
 *        · 27 帧目视核对过的真值（把输出的两条边叠到原图上，与可见扇形边重合）
 *        · 青色门控漏放的游戏场景帧不得出方向
 *        · 圆心偏移、降分辨率下的中轴漂移
 *
 * B、C 的素材不入库（见 .gitignore），不在时打印 SKIP，不算失败。
 * 不启动应用、不连调试端口、不改识别器源码。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ROOT, TMP500, loadAnalyzer, loadFrames500, loadFixture, ad } = require('./cone-lab');

const analyzeCone = loadAnalyzer();
const GATE = 0.0015;

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
}
const stepOf = (size) => (size > 320 ? 2 : 1);
const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0);

/* ------------------------------------------------------------------ A. 合成帧 */

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {object} o
 *   size     窗口边长（= 1.5R）
 *   axis     扇形中轴（数学角）；null = 不画扇形
 *   seed     随机种子
 *   icons    白色标点个数
 *   band     true = 标点集中铺在扇形所在的角度带里（极端密度）
 *   coast    海岸线法向（数学角）；让水陆分界斜穿圆心附近
 */
function synth(o) {
  const S = o.size;
  const R = S / 1.5;
  const c0 = (S - 1) / 2;
  const rnd = rng(o.seed);
  const d = new Uint8ClampedArray(S * S * 4);
  const water = [40, 93, 103];
  const land = [146, 170, 108];
  const cn = [Math.cos((o.coast * Math.PI) / 180), Math.sin((o.coast * Math.PI) / 180)];
  const coastOff = (rnd() - 0.5) * 0.3 * R;

  const icons = [];
  for (let n = 0; n < o.icons; n += 1) {
    const rr = (0.22 + rnd() * 0.48) * R;
    const base = o.band && o.axis !== null ? o.axis + (rnd() - 0.5) * 120 : rnd() * 360;
    const th = (base * Math.PI) / 180;
    icons.push({ x: c0 + Math.cos(th) * rr, y: c0 - Math.sin(th) * rr, r: (o.band ? 0.03 : 0.045 + rnd() * 0.03) * R });
  }

  for (let y = 0; y < S; y += 1) {
    for (let x = 0; x < S; x += 1) {
      const dx = x - c0;
      const dy = c0 - y;
      const rho = Math.sqrt(dx * dx + dy * dy);
      // 海岸线：带一点正弦起伏的直线
      const along = -dx * cn[1] + dy * cn[0];
      const side = dx * cn[0] + dy * cn[1] - coastOff - Math.sin(along / (0.12 * R)) * 0.04 * R;
      const t = Math.max(0, Math.min(1, side / 2 + 0.5)); // 2px 过渡
      let r = water[0] + (land[0] - water[0]) * t;
      let g = water[1] + (land[1] - water[1]) * t;
      let b = water[2] + (land[2] - water[2]) * t;
      // 地形纹理 / 压缩噪声
      const nz = (rnd() - 0.5) * 6;
      r += nz;
      g += nz;
      b += nz;
      // 白膜
      if (o.axis !== null && rho > 1) {
        let a = (Math.atan2(dy, dx) * 180) / Math.PI;
        const off = Math.abs(((a - o.axis + 540) % 360) - 180);
        // 边上 1px 的抗锯齿
        const edgePx = ((45 - off) * Math.PI) / 180 * rho;
        const cov = Math.max(0, Math.min(1, edgePx + 0.5));
        const alpha = Math.max(0, 0.4 * (1 - rho / R)) * cov;
        r += alpha * (255 - r);
        g += alpha * (255 - g);
        b += alpha * (255 - b);
      }
      // 白色标点（画在白膜之上，不透明，1.5px 灰边）
      for (const ic of icons) {
        const dd = Math.sqrt((x - ic.x) * (x - ic.x) + (y - ic.y) * (y - ic.y));
        const cov = Math.max(0, Math.min(1, (ic.r - dd) / 1.5 + 0.5));
        if (cov > 0) {
          r += cov * (252 - r);
          g += cov * (255 - g);
          b += cov * (250 - b);
        }
      }
      // 圆心的青色玩家箭头（只为过小地图门控）
      if (rho < 0.1 * R) {
        r = 34;
        g = 200;
        b = 232;
      }
      const i = (y * S + x) * 4;
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = 255;
    }
  }
  return { data: d, width: S, height: S };
}

console.log('--- A. 合成帧 ---');
{
  const layouts = [
    { name: '稀疏标点', icons: 5, band: false },
    { name: '密集标点', icons: 12, band: false },
    { name: '标点铺满扇形角度带', icons: 18, band: true }
  ];
  for (const size of [363, 165]) {
    for (const L of layouts) {
      const errs = [];
      let miss = 0;
      let seed = 1;
      for (let axis = 0; axis < 360; axis += 15) {
        seed += 1;
        const img = synth({ size, axis: axis + 3.7, seed: seed * 7919 + size, icons: L.icons, band: L.band, coast: axis * 2.3 + 20 });
        const r = analyzeCone(img, size, stepOf(size));
        if (!r.valid) miss += 1;
        else errs.push(ad(r.deg, axis + 3.7));
      }
      errs.sort((a, b) => a - b);
      const worst = errs.length ? errs[errs.length - 1] : 0;
      // 极端密度下允许个别帧认不出（两条边都被压住），但认出来的不许错
      const missMax = L.band ? 6 : 0;
      check(`${size}px ${L.name}`, miss <= missMax && worst <= 6,
        `24 个朝向：漏检 ${miss}，最大误差 ${worst.toFixed(1)}°，p90 ${pct(errs, 0.9).toFixed(1)}°`);
    }
    let fp = 0;
    for (let n = 0; n < 24; n += 1) {
      const img = synth({ size, axis: null, seed: 4242 + n * 31 + size, icons: 12, band: false, coast: n * 15 });
      const r = analyzeCone(img, size, stepOf(size));
      if (r.valid) fp += 1;
    }
    check(`${size}px 只有标点 + 海岸线、没有扇形`, fp === 0, `24 帧里误报 ${fp}`);
  }
}

/* ------------------------------------------------------------- B. 实拍标注帧 */

console.log('\n--- B. 用户实拍标注帧 ---');
const FIX = path.join(ROOT, 'scripts/vision-probe/fixtures');
if (fs.existsSync(path.join(FIX, 'icon-frame-135deg.raw'))) {
  const r = analyzeCone(loadFixture('icon-frame-135deg.raw', 165), 165, 1);
  const err = r.valid ? ad(r.deg, 135) : 999;
  check('标注帧必须检出', r.valid === true, `deg=${r.deg.toFixed(1)}° conf=${r.conf.toFixed(2)}`);
  check('标注帧方向误差 <= 8°', err <= 8, `真值 135°（手画两条半径 90°/180°），误差 ${err.toFixed(1)}°（旧算法 8.5°，更早 38.2°）`);
  check('小地图门控判定为存在', (r.cyanFrac || 0) >= GATE, `cyanFrac=${(r.cyanFrac || 0).toFixed(4)}`);
} else {
  console.log('SKIP  fixtures/icon-frame-135deg.raw 不在');
}

/* ---------------------------------------------------------- C. 500 帧真实视频 */

console.log('\n--- C. 500 帧真实视频 ---');
if (fs.existsSync(path.join(TMP500, 'vidroi500.bin'))) {
  const { frames, step } = loadFrames500();
  const res = frames.map((f) => analyzeCone(f.img, f.S, step));

  /* 目视核对过的帧：帧号 → 中轴。核对方式是把输出的两条半径边画回原图，
   * 确认与可见的扇形边重合（scripts/vision-probe/cone-lab-sheet.js）。
   * 这些帧覆盖了旧算法的主要翻车类型：海岸线斜穿、标点压边、整段连续指反。 */
  const TRUTH = {
    8: 247, 56: 39, 76: 306, 77: 13, 93: 103, 105: 2, 129: 17, 143: 60, 147: 37, 157: 129,
    160: 139, 167: 136, 168: 124, 169: 53, 176: 118, 177: 118, 178: 227, 250: 192, 286: 201,
    287: 149, 289: 88, 329: 355, 336: 316, 344: 241, 346: 213, 350: 227, 353: 224
  };
  const errs = [];
  const bad = [];
  for (const [id, truth] of Object.entries(TRUTH)) {
    const r = res[id];
    const e = r.valid ? ad(r.deg, truth) : 999;
    errs.push(e);
    if (e > 6) bad.push(`#${id}:${r.valid ? r.deg.toFixed(0) : '--'}≠${truth}`);
  }
  errs.sort((a, b) => a - b);
  check('目视核对帧误差 <= 6°', bad.length === 0,
    `${errs.length} 帧，最大 ${errs[errs.length - 1].toFixed(1)}°${bad.length ? '，超差：' + bad.join(' ') : ''}`);

  /* 青色门控放行、但 ROI 里其实是游戏场景（t=184.7~186.7s，画面切走了）。
   * 旧算法在这 4 帧上给出 conf 0.34~1.00 的假方向。
   * 注：#472（资料界面，青色占比 0.0016 贴着门限漏放）仍会被一条水平面板边骗出
   * 单边方向 —— 那是门控的问题，试过「正对面有反向边就剔除」会误伤 57 帧真扇形，没有采用。 */
  const noMap = [279, 280, 281, 282];
  const leaked = noMap.filter((id) => res[id].valid);
  check('门控漏放的游戏场景帧不出方向', leaked.length === 0, `帧 ${noMap.join(',')}，误报 ${leaked.length}`);

  const gated = res.filter((r) => (r.cyanFrac || 0) >= GATE);
  const hit = gated.filter((r) => r.valid).length;
  check('有小地图帧检出率', hit >= gated.length - 12, `${hit}/${gated.length}（扇形恒在，漏检只应来自上面那几帧非小地图画面与转场）`);

  // 相邻帧（0.66s）方向差：真实转镜头是连续的，孤立的大跳多半是误检
  let jumps = 0;
  let pairs = 0;
  for (let i = 1; i < res.length - 1; i += 1) {
    const a = res[i - 1];
    const b = res[i];
    const c = res[i + 1];
    if (![a, b, c].every((r) => r.valid && (r.cyanFrac || 0) >= GATE)) continue;
    pairs += 1;
    // 孤立脉冲：前后两帧互相一致，中间这帧单独飞出去
    if (ad(a.deg, c.deg) < 20 && ad(b.deg, a.deg) > 40 && ad(b.deg, c.deg) > 40) jumps += 1;
  }
  check('孤立单帧脉冲', jumps === 0, `${pairs} 个三连帧里 ${jumps} 个（旧算法 500 帧里有 t=111.37 / 117.31 等多处）`);

  // 稳健性：以原始帧输出为基准，看圆心偏移 / 降分辨率后的中轴漂移
  const base = [];
  frames.forEach((f, i) => {
    const r = res[i];
    if ((r.cyanFrac || 0) >= GATE && r.valid && r.dbg.rise >= 0.1 && r.dbg.fall >= 0.1) base.push({ f, deg: r.deg });
  });
  const crop = (img, S, size, ox, oy) => {
    const out = new Uint8ClampedArray(size * size * 4);
    const x0 = Math.round((S - size) / 2 + ox);
    const y0 = Math.round((S - size) / 2 + oy);
    for (let y = 0; y < size; y += 1) {
      const off = ((y0 + y) * S + x0) * 4;
      out.set(img.data.subarray(off, off + size * 4), y * size * 4);
    }
    return { data: out, width: size, height: size };
  };
  const down = (img, S, k) => {
    const n = Math.floor(S / k);
    const o = Math.floor((S - n * k) / 2);
    const out = new Uint8ClampedArray(n * n * 4);
    for (let y = 0; y < n; y += 1) {
      for (let x = 0; x < n; x += 1) {
        let r = 0;
        let g = 0;
        let b = 0;
        for (let yy = 0; yy < k; yy += 1) {
          for (let xx = 0; xx < k; xx += 1) {
            const i = ((o + y * k + yy) * S + o + x * k + xx) * 4;
            r += img.data[i];
            g += img.data[i + 1];
            b += img.data[i + 2];
          }
        }
        const q = (y * n + x) * 4;
        out[q] = r / (k * k);
        out[q + 1] = g / (k * k);
        out[q + 2] = b / (k * k);
        out[q + 3] = 255;
      }
    }
    return { img: { data: out, width: n, height: n }, size: n };
  };
  const drift = (name, fn, p90Max) => {
    const e = [];
    let miss = 0;
    for (const b of base) {
      const r = fn(b.f);
      if (!r.valid) miss += 1;
      else e.push(ad(r.deg, b.deg));
    }
    e.sort((x, y) => x - y);
    check(name, miss <= 2 && pct(e, 0.9) <= p90Max,
      `${base.length} 帧：漏检 ${miss}，p90 ${pct(e, 0.9).toFixed(1)}°，最大 ${(e[e.length - 1] || 0).toFixed(1)}°`);
  };
  const C = 331;
  drift('圆心偏 (5,5)px', (f) => analyzeCone(crop(f.img, f.S, C, 5, 5), C, stepOf(C)), 5);
  drift('圆心偏 (-8,0)px', (f) => analyzeCone(crop(f.img, f.S, C, -8, 0), C, stepOf(C)), 6);
  drift('降到 1/3 分辨率（121px）', (f) => {
    const dn = down(f.img, f.S, 3);
    return analyzeCone(dn.img, dn.size, stepOf(dn.size));
  }, 2);
  drift('降到 1/5 分辨率（72px）', (f) => {
    const dn = down(f.img, f.S, 5);
    return analyzeCone(dn.img, dn.size, stepOf(dn.size));
  }, 2);

  // 耗时
  const t0 = process.hrtime.bigint();
  for (const f of frames) analyzeCone(f.img, f.S, step);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / frames.length;
  check('单帧耗时 < 3ms', ms < 3, `${ms.toFixed(2)} ms/帧（363px 窗口、step=2）`);
} else {
  console.log(`SKIP  ${path.join(os.tmpdir(), 'vidframes500')} 不在`);
}

console.log(`\n${fail ? '存在失败' : '全部通过'}：pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);

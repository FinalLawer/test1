'use strict';
/* 500 帧密集序列扫描（2026-11-06）。
 *
 * 相比 166 帧 / 2s 间隔，0.66s 间隔让「白标是单帧脉冲、真扇形连续」可判定：
 *   用 ±2s 窗口里 conf>=0.45 的帧做圆形加权均值，且要求窗内一致（离散 <=25°），
 *   得到比两点插值可靠得多的局部伪真值 ref；本帧 conf 高却孤立偏离 ref >30°，
 *   且相邻帧都贴着 ref，就是疑似白标干扰帧。
 *
 * 产出：
 *   Temp/vidframes500/png/                    500 张 ROI 原图（供目视/标注）
 *   scripts/vision-probe/frames500-summary.json  每帧 deg/conf/ref/err/标记
 *   scripts/vision-probe/fixtures/frames500/     疑似干扰帧原图 + suspects.json
 * 控制台另给 W=0/0.6/1.5/3.0 在 500 帧上的复核，验证「提高权重无收益」是否稳固。
 *
 * 不启动应用、不连调试端口、不改识别器源码，只读离线 raw 帧。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const ROOT = require('path').resolve(__dirname, '..', '..');
const TMP = require('path').join(require('os').tmpdir(), 'vidframes500');
const OUT = ROOT + '/scripts/vision-probe/fixtures/frames500';

const src = fs.readFileSync(ROOT + '/src/webview-preload.js', 'utf8');
const h0 = src.indexOf('function degOf(ux, uy) {');
const h1 = src.indexOf('/* ---------------------------------------------------------------- 扇形通道', h0);
const c0 = src.indexOf('function analyzeCone(img, size, step) {');
const c1 = src.indexOf('/**\n * 圆形 α-β 滤波', c0);
const H = new Function(src.slice(h0, h1) + ';return { degOf, angDiff };')();
const CORE = src.slice(c0, c1);
const RANK_LINE = '    const rank = score + 0.6 * Math.min(1, edgeBoost(c) / 30);';
const SORT_LINE = '  cand.sort((x, y) => y.rank - x.rank);';
if (!CORE.includes(RANK_LINE) || !CORE.includes(SORT_LINE)) {
  throw new Error('源码里的 rank 择优实现已变化，请同步本脚本');
}
const INJECTED = CORE.replace(SORT_LINE,
  '  globalThis.__coneCand = cand.map((t) => ({ c: t.c, score: t.score, boost: edgeBoost(t.c) }));\n' + SORT_LINE);
function build(W, cap = 30) {
  const term = cap === 0 ? '(edgeBoost(c) / 30)' : `Math.min(1, edgeBoost(c) / ${cap})`;
  let c = INJECTED.replace(RANK_LINE, `    const rank = score + ${W} * ${term};`);
  if (W === 0) c = c.replace(SORT_LINE, '  cand.sort((x, y) => y.score - x.score);');
  return new Function('degOf', 'angDiff', c + ';return analyzeCone;')(H.degOf, H.angDiff);
}
const ad = (x, y) => Math.abs(((x - y + 540) % 360) - 180);
const degOfRad = (sx, sy) => H.degOf(sx, sy);

const man = JSON.parse(fs.readFileSync(TMP + '/vidroi500.json', 'utf8'));
const blob = fs.readFileSync(TMP + '/vidroi500.bin');
const frames = man.list.map((e) => {
  const bytes = e.size * e.size * 4;
  return { t: e.t, S: e.size,
    img: { data: new Uint8ClampedArray(blob.buffer, blob.byteOffset + e.off, bytes), width: e.size, height: e.size },
    raw: Buffer.from(blob.buffer, blob.byteOffset + e.off, bytes) };
});
console.log(`帧数 ${frames.length}，间隔约 ${(frames[1].t - frames[0].t).toFixed(2)}s，总像素 ${(blob.length / 1048576).toFixed(0)}MiB`);

/* ---- 手写 PNG 编码（不引入图像库），RGBA8 + filter 0 ---- */
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 3 })), chunk('IEND', Buffer.alloc(0))
  ]);
}
const pngDir = TMP + '/png';
fs.mkdirSync(pngDir, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
if (process.argv.includes('--png')) {
  for (let i = 0; i < frames.length; i++) {
    const name = 'f' + String(i).padStart(3, '0') + '_t' + String(frames[i].t).replace('.', '_') + '.png';
    fs.writeFileSync(path.join(pngDir, name), encodePNG(frames[i].S, frames[i].raw));
  }
  console.log('已导出 500 张 PNG → ' + pngDir);
}

/* ---- 逐帧跑识别器 ---- */
function run(W) {
  const f = build(W);
  return frames.map((e) => {
    globalThis.__coneCand = null;
    const r = f(e.img, e.S, man.step);
    const cs = globalThis.__coneCand || [];
    const hit = r.dbg ? cs.find((c) => c.c === r.dbg.c) : null;
    return {
      t: e.t, deg: r.deg, conf: r.conf, cyan: r.cyanFrac || 0,
      ok: !!(r.valid && r.conf > 0.12 && (r.cyanFrac || 0) >= 0.0015),
      nCand: cs.length, score: r.dbg ? r.dbg.score : 0,
      boost: hit ? hit.boost : 0
    };
  });
}

/* ---- 用当前 W=0.6 的序列构建局部伪真值 ---- */
const rows = run(0.6);
function localRef(i) {
  const win = rows.filter((q, j) => j !== i && Math.abs(q.t - rows[i].t) <= 2.0 && q.ok && q.conf >= 0.45);
  if (win.length < 3) return null;
  let sx = 0, sy = 0;
  for (const q of win) {
    const rad = q.deg * Math.PI / 180;
    sx += Math.cos(rad) * q.conf; sy += Math.sin(rad) * q.conf;
  }
  const m = degOfRad(sx, sy);
  const spread = Math.max(...win.map((q) => ad(q.deg, m)));
  if (spread > 25) return null;
  return { deg: m, n: win.length, spread };
}
const refs = rows.map((_, i) => localRef(i));
function suspect(i, deg, conf) {
  const r = refs[i];
  if (!r || !rows[i].ok || conf < 0.4 || ad(deg, r.deg) <= 30) return false;
  const near = rows.filter((q, j) => j !== i && Math.abs(q.t - rows[i].t) <= 1.4 && q.ok);
  return near.length >= 2 && near.every((q) => ad(q.deg, r.deg) < 25);
}

/* ---- 各 W 配置在 500 帧上的复核 ---- */
console.log('\nW   | 有图帧 检出 | 有可信ref | 孤立偏差>30° 均误 p90误 | 相邻>60°大跳 p90');
const summary = [];
for (const W of [0, 0.6, 1.5, 3.0]) {
  const rr = W === 0.6 ? rows : run(W);
  const withMap = rr.filter((x) => x.cyan >= 0.0015).length;
  const hit = rr.filter((x) => x.ok).length;
  const errs = [], sus = [], jumps = [];
  rr.forEach((x, i) => {
    const r = refs[i];
    if (r && x.ok) {
      const err = ad(x.deg, r.deg);
      errs.push(err);
      if (suspect(i, x.deg, x.conf)) sus.push({ t: x.t, deg: x.deg, ref: r.deg, err, conf: x.conf });
    }
    if (i > 0 && x.ok && rr[i - 1].ok && x.t - rr[i - 1].t <= 1.4) jumps.push(ad(x.deg, rr[i - 1].deg));
  });
  errs.sort((a, b) => a - b); jumps.sort((a, b) => a - b);
  const stat = {
    W, withMap, hit, refCount: refs.filter(Boolean).length,
    suspects: sus.length, meanErr: errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : 0,
    p90Err: errs[Math.floor(errs.length * 0.9)] || 0,
    big: jumps.filter((x) => x > 60).length, p90Jump: jumps[Math.floor(jumps.length * 0.9)] || 0
  };
  summary.push(stat);
  console.log(
    `${W.toFixed(1)} | ${String(withMap).padStart(3)} ${String(hit).padStart(3)} | ` +
    `${String(stat.refCount).padStart(3)} | ${String(sus.length).padStart(3)} ` +
    `${stat.meanErr.toFixed(1).padStart(5)} ${stat.p90Err.toFixed(1).padStart(5)} | ` +
    `${String(stat.big).padStart(3)} ${stat.p90Jump.toFixed(1).padStart(5)}`
  );
  if (W === 0.6) {
    const cur = sus;
    fs.writeFileSync(OUT + '/suspects.json', JSON.stringify(cur, null, 2));
    for (const s of cur.slice(0, 40)) {
      const idx = frames.findIndex((e) => e.t === s.t);
      if (idx < 0) continue;
      const name = 'sus_t' + String(s.t).replace('.', '_') + '.png';
      fs.writeFileSync(OUT + '/' + name, encodePNG(frames[idx].S, frames[idx].raw));
    }
    console.log(`  疑似白标干扰帧 ${cur.length} 个，已导出前 ${Math.min(40, cur.length)} 张 → ${OUT}`);
    for (const s of cur.slice(0, 20)) {
      console.log(`  t=${String(s.t).padStart(6)}s deg=${s.deg.toFixed(1).padStart(6)}° ref=${s.ref.toFixed(1).padStart(6)}° 误差=${s.err.toFixed(1).padStart(5)}° conf=${s.conf.toFixed(2)}`);
    }
  }
}

fs.writeFileSync(ROOT + '/scripts/vision-probe/frames500-summary.json', JSON.stringify({
  spec: { count: frames.length, t0: frames[0].t, t1: frames[frames.length - 1].t, step: man.step, size: frames[0].S },
  wScan: summary,
  frames: rows.map((x, i) => ({ ...x, ref: refs[i] ? refs[i].deg : null, refN: refs[i] ? refs[i].n : 0,
    err: refs[i] ? ad(x.deg, refs[i].deg) : null, suspect: refs[i] ? suspect(i, x.deg, x.conf) : false }))
}, null, 2));
console.log('\nSUMMARY → scripts/vision-probe/frames500-summary.json');

/* ---- 追加 A/B：EV 只累计内侧 k 层 ----
 * 两张疑似干扰帧都是「海岸线斜穿 + 密集白标」，海岸线是贯穿全半径的直线，
 * 会被 EV 当成扇形半径边。内层靠近圆心，最不容易被海岸线和地图标点覆盖。
 * 只改注入副本，不动源码；用 W=0.6 原始序列的局部 ref 当统一标尺。 */
const EV_LOOP = 'for (let s = 0; s < SEGS; s += 1) {\n      let rp = 0;';
const EV_DIV = 'EV[a] = sum / SEGS;';
if (!CORE.includes(EV_LOOP) || !CORE.includes(EV_DIV)) {
  throw new Error('源码里的 EV 实现已变化，请同步本脚本');
}
function buildInner(k) {
  const c = INJECTED
    .replace(EV_LOOP, `for (let s = 0; s < ${k}; s += 1) {\n      let rp = 0;`)
    .replace(EV_DIV, `EV[a] = sum / ${k};`);
  return new Function('degOf', 'angDiff', c + ';return analyzeCone;')(H.degOf, H.angDiff);
}
const FIX = ROOT + '/scripts/vision-probe/fixtures/';
const shotImgs = [
  { n: '标注帧', p: FIX + 'icon-frame-135deg.raw', S: 165, truth: 135 },
  { n: '本次截图', p: FIX + 'current-frame.raw', S: 142, truth: null }
].map((s) => ({ ...s, img: { data: new Uint8ClampedArray(fs.readFileSync(s.p)), width: s.S, height: s.S } }));
const suspectTimes = rows.map((x, i) => (x.ok && suspect(i, x.deg, x.conf) ? x.t : null)).filter((x) => x !== null);
console.log('\nk  | 孤立偏差帧 均误 p90误 | 大跳 p90 | 标注帧误差 本次截图 | 两帧疑似误差');
for (const k of [2, 3, 4, 5, 6]) {
  const f = buildInner(k);
  const rr = frames.map((e) => {
    const r = f(e.img, e.S, man.step);
    return { deg: r.deg, conf: r.conf, ok: !!(r.valid && r.conf > 0.12 && (r.cyanFrac || 0) >= 0.0015) };
  });
  const errs = [], jumps = [];
  rr.forEach((x, i) => {
    const ref = refs[i];
    if (ref && x.ok) errs.push(ad(x.deg, ref.deg));
    if (i > 0 && x.ok && rr[i - 1].ok && frames[i].t - frames[i - 1].t <= 1.4) {
      jumps.push(ad(x.deg, rr[i - 1].deg));
    }
  });
  errs.sort((a, b) => a - b); jumps.sort((a, b) => a - b);
  const shots = shotImgs.map((s) => f(s.img, s.S, 1));
  const susErr = suspectTimes.map((t) => {
    const i = frames.findIndex((e) => e.t === t);
    return refs[i] ? ad(rr[i].deg, refs[i].deg) : null;
  });
  console.log(
    `${k} | ${String(errs.filter((x) => x > 30).length).padStart(2)} ` +
    `${(errs.reduce((a, b) => a + b, 0) / errs.length).toFixed(1).padStart(5)} ${(errs[Math.floor(errs.length * 0.9)] || 0).toFixed(1).padStart(5)} | ` +
    `${String(jumps.filter((x) => x > 60).length).padStart(2)} ${(jumps[Math.floor(jumps.length * 0.9)] || 0).toFixed(1).padStart(5)} | ` +
    `${ad(shots[0].deg, 135).toFixed(1).padStart(5)}° ${shots[1].deg.toFixed(1).padStart(6)}° | ` +
    susErr.map((x) => x === null ? 'n/a' : x.toFixed(1) + '°').join(' / ')
  );
}

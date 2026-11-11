'use strict';
/* 用户实拍标注帧回归（2026-11-06）。
 *
 * 这一帧是「地图标点干扰扇形」的真实样本，也是唯一有人工标注真值的帧：
 * 用户用红线标出扇形两条半径 90°(北) / 180°(西)，中轴 135°，张角 90°，
 * 并说明外弧不完整是因为扇形有部分超出小地图。
 * 帧内玩家中心 (196,610)、R=110，按运行时 1.5R 裁成 165×165，step=1。
 *
 * 改动前：真峰 score 0.675 / fade 1.02 被 all<=0、pos<5 误杀，
 *         只剩 U 形假峰 → deg 96.8°，误差 38.2°。
 * 改动后：定向救援放行真峰 → deg 126.5°，误差 8.5°。
 *
 * 同时校验真实视频 166 帧，避免为救一帧而伤整体。
 */
const fs = require('fs');
const path = require('path');

const ROOT = require('path').resolve(__dirname, '..', '..');
const src = fs.readFileSync(path.join(ROOT, 'src/webview-preload.js'), 'utf8');
const h0 = src.indexOf('function degOf(ux, uy) {');
const h1 = src.indexOf('/* ---------------------------------------------------------------- 扇形通道', h0);
const c0 = src.indexOf('function analyzeCone(img, size, step) {');
const c1 = src.indexOf('/**\n * 圆形 α-β 滤波', c0);
const H = new Function(src.slice(h0, h1) + ';return { degOf, angDiff };')();
const analyzeCone = new Function('degOf', 'angDiff', src.slice(c0, c1) + ';return analyzeCone;')(H.degOf, H.angDiff);
const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log(`PASS  ${name}  ${detail}`); }
  else { fail += 1; console.log(`FAIL  ${name}  ${detail}`); }
}

// ---- 1. 标注帧 ----
const size = 165;
const raw = fs.readFileSync(path.join(ROOT, 'scripts/vision-probe/fixtures/icon-frame-135deg.raw'));
const shot = { data: new Uint8ClampedArray(raw), width: size, height: size };
const r = analyzeCone(shot, size, 1);
const err = r.valid ? angDiff(r.deg, 135) : 999;
check('标注帧必须检出', r.valid === true, `valid=${r.valid} deg=${r.deg.toFixed(1)}° conf=${r.conf.toFixed(2)}`);
check('标注帧方向误差 <= 15°', err <= 15, `deg=${r.deg.toFixed(1)}° 真值=135° 误差=${err.toFixed(1)}°（改动前 38.2°）`);
check('标注帧走的是救援通道', !!(r.dbg && r.dbg.rescued), `rescued=${r.dbg && r.dbg.rescued} fade=${r.dbg && r.dbg.fade.toFixed(2)} score=${r.dbg && r.dbg.score.toFixed(2)}`);
check('标注帧置信度提升', r.conf >= 0.5, `conf=${r.conf.toFixed(2)}（改动前 0.35）`);
check('小地图门控仍判定为存在', (r.cyanFrac || 0) >= 0.0015, `cyanFrac=${(r.cyanFrac || 0).toFixed(4)}`);

// ---- 2. 真实视频 166 帧 ----
const man = JSON.parse(fs.readFileSync(require('path').join(require('os').tmpdir(), 'vidroi.json'), 'utf8'));
const gate = JSON.parse(fs.readFileSync(require('path').join(require('os').tmpdir(), 'vidscan-gate.json'), 'utf8'));
const gm = new Map(gate.map((g) => [g.t, g.blob >= 8]));
const blob = fs.readFileSync(require('path').join(require('os').tmpdir(), 'vidroi.bin'));
let hit = 0;
let miss = 0;
let fp = 0;
let tn = 0;
for (const e of man.list) {
  const S = e.size;
  const bytes = S * S * 4;
  const data = new Uint8ClampedArray(blob.buffer.slice(blob.byteOffset + e.off, blob.byteOffset + e.off + bytes));
  const q = analyzeCone({ data, width: S, height: S }, S, man.step);
  const present = (q.cyanFrac || 0) >= 0.0015;
  const valid = q.valid && present;
  const has = gm.get(e.t) === true;
  if (has && valid) hit += 1;
  else if (has && !valid) miss += 1;
  else if (!has && valid) fp += 1;
  else tn += 1;
}
check('真实视频有小地图检出 >= 147/153', hit >= 147, `检出 ${hit}/153（改动前 147，改动后 150）`);
check('真实视频无小地图误检 <= 1/13', fp <= 1, `误检 ${fp}/13 正确拒绝 ${tn}`);

console.log(`\n全部通过：pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);

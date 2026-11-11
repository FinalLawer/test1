'use strict';
/* 双半径边择优回归（2026-11-06 第二轮实拍反馈）。
 *
 * 用户思路：扇形两条半径边是从圆心出发的直线、分界清晰、夹角恒 90°，
 * 应当重点检测这两条线，而不是「找一块亮的 90° 楔形」。
 *
 * 落地方式：在 analyzeCone 里预计算 72 个角度方向的「宽基线边证据」
 *   EV[a] = 同层 [a+10°,a+30°] 带 减 [a-30°,a-10°] 带，跨 6 个径向层累加，
 * 候选 c 的两条边落在 c±9 格，要求进入边 EV>0、离开边 EV<0，
 * 以 rank = score + 0.6*min(1, edgeBoost/30) 择优。
 * score 原样保留 → 0.16 下限、conf、救援门限、时序层行为全部不变。
 *
 * 改动前典型症状：单帧方向突然翻到反方向、下一帧又跳回来
 *   t=144s 50→60→61→218→61→57；t=178s 251→245→249→64→256→241
 * 这类帧共 7~8 个，正是用户看到的「白标把绿弧顶歪」。
 *
 * 验证口径与数据依赖见 cone-icon-shot-test.js；帧数据在 Temp。
 */
const fs = require('fs');
const path = require('path');

const ROOT = require('path').resolve(__dirname, '..', '..');
const FIX = path.join(ROOT, 'scripts/vision-probe/fixtures');
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
function loadFrame(name) {
  const raw = fs.readFileSync(path.join(FIX, name));
  const size = Math.round(Math.sqrt(raw.length / 4));
  return { img: { data: new Uint8ClampedArray(raw), width: size, height: size }, size };
}

// ---- 1. 两帧实拍：方向不得回归 ----
const a = loadFrame('icon-frame-135deg.raw');
const rOld = analyzeCone(a.img, a.size, 1);
check('人工标注帧仍保持定向救援结果',
  rOld.valid && angDiff(rOld.deg, 135) <= 15,
  `deg=${rOld.deg.toFixed(1)}° 真值135° 误差=${angDiff(rOld.deg, 135).toFixed(1)}°`);

const b = loadFrame('current-frame.raw');
const rCur = analyzeCone(b.img, b.size, 1);
// 独立双边界检测给 17.5°（6/6 层同号、内 0.78/外 0.08），主判据 22.8°
check('本次实拍帧方向落在双边界给出的 17.5° 附近',
  rCur.valid && angDiff(rCur.deg, 22.8) <= 15,
  `deg=${rCur.deg.toFixed(1)}° 参考=22.8° 双边界=17.5°`);

const c = loadFrame('current-frame-offset5.raw');
const rOff = analyzeCone(c.img, c.size, 1);
// 改动前 ROI 中心偏上 5px 会翻到 198.2°（conf 0.86），是定位误差诱发的假峰
check('ROI 中心偏 5px 不再翻到反方向',
  rOff.valid && angDiff(rOff.deg, 22.8) <= 40,
  `deg=${rOff.deg.toFixed(1)}°（改动前 198.2°）`);

// ---- 2. 时序层不受影响：conf 必须仍由未加权的 score 决定 ----
const confFromScore = Math.max(0, Math.min(1, ((rCur.dbg ? rCur.dbg.score : 0) - 0.15) / 0.8));
check('conf 仍由原始结构分决定（边证据未混入置信度）',
  Math.abs(rCur.conf - confFromScore) < 1e-6,
  `conf=${rCur.conf.toFixed(3)} 由score推出=${confFromScore.toFixed(3)}`);

// ---- 3. 真实视频 166 帧 ----
const man = JSON.parse(fs.readFileSync(require('path').join(require('os').tmpdir(), 'vidroi.json'), 'utf8'));
const gate = JSON.parse(fs.readFileSync(require('path').join(require('os').tmpdir(), 'vidscan-gate.json'), 'utf8'));
const gm = new Map(gate.map((g) => [g.t, g.blob >= 8]));
const blob = fs.readFileSync(require('path').join(require('os').tmpdir(), 'vidroi.bin'));
const rows = [];
for (const e of man.list) {
  const S = e.size;
  const bytes = S * S * 4;
  const data = new Uint8ClampedArray(blob.buffer.slice(blob.byteOffset + e.off, blob.byteOffset + e.off + bytes));
  const q = analyzeCone({ data, width: S, height: S }, S, man.step);
  const has = gm.get(e.t) === true;
  const ok = q.valid && (q.cyanFrac || 0) >= 0.0015;
  rows.push({ t: e.t, has, ok, deg: q.deg, conf: q.conf });
}
const hit = rows.filter((r) => r.has && r.ok).length;
const fp = rows.filter((r) => !r.has && r.ok).length;
check('真实视频有小地图检出 >= 147/153', hit >= 147, `检出 ${hit}/153`);
check('真实视频无小地图误检 <= 1/13', fp <= 1, `误检 ${fp}/13`);

// 相邻帧（间隔 <=4s）的大跳数：改动前 31 → 改动后 20
const jumps = [];
for (let i = 1; i < rows.length; i += 1) {
  if (rows[i].ok && rows[i - 1].ok && rows[i].t - rows[i - 1].t <= 4) {
    jumps.push(angDiff(rows[i].deg, rows[i - 1].deg));
  }
}
const big = jumps.filter((v) => v > 60).length;
check('相邻帧 >60° 大跳 <= 25', big <= 25, `大跳 ${big}/${jumps.length}（改动前 31）`);

// 用高置信帧插值做弱监督真值，核对三个原本「单帧翻转」的时刻
const anchors = rows.filter((r) => r.has && r.ok && r.conf >= 0.35);
function interp(t) {
  const before = [...anchors].filter((r) => r.t < t).sort((x, y) => y.t - x.t)[0];
  const after = [...anchors].filter((r) => r.t > t).sort((x, y) => x.t - y.t)[0];
  if (!before || !after || after.t - before.t > 12) return null;
  const w = (t - before.t) / (after.t - before.t);
  let d = after.deg - before.deg;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return (before.deg + d * w + 360) % 360;
}
// 改动前：144s=217.7° / 178s=64.5° / 118s=10.2°，都是反方向
for (const t of [118, 144, 178]) {
  const row = rows.find((r) => r.t === t);
  const ref = interp(t);
  const err = row && ref !== null ? angDiff(row.deg, ref) : 999;
  check(`t=${t}s 单帧翻转已修正`, err <= 45,
    `deg=${row ? row.deg.toFixed(1) : '-'}° 锚点插值=${ref === null ? '无' : ref.toFixed(1) + '°'} 误差=${err.toFixed(1)}°`);
}

console.log(`\n全部通过：pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);

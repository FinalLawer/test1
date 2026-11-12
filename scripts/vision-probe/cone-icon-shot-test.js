'use strict';
/* 用户实拍标注帧回归（2026-11-06 建，2026-11-12 随扇形通道重写更新）。
 *
 * 这一帧是「地图标点干扰扇形」的真实样本，也是唯一有人工标注真值的帧：
 * 用户用红线标出扇形两条半径 90°(北) / 180°(西)，中轴 135°，张角 90°，
 * 并说明外弧不完整是因为扇形有部分超出小地图。
 * 帧内玩家中心 (196,610)、R=110，按运行时 1.5R 裁成 165×165，step=1。
 *
 * 历史：
 *   最初      真峰被结构条件误杀，只剩 U 形假峰 → 96.8°，误差 38.2°
 *   11-06     定向救援放行真峰 → 126.5°，误差 8.5°
 *   11-12     改为「半径边 + 白膜 alpha 一致性」→ 140.1°，误差 5.1°
 *      北侧那条边被两颗白星压住，靠西侧的下降边单边定向；
 *      该边实测在 184~185°（手画红线取整到 180°），所以 140° 比 135° 更贴近画面
 *
 * 同时校验真实视频 166 帧（2s 间隔），避免为救一帧而伤整体。
 * 更完整的回归见 cone-edge-regress.js。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ROOT, loadAnalyzer, loadFixture, ad } = require('./cone-lab');

const analyzeCone = loadAnalyzer();

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
}

// ---- 1. 标注帧 ----
const size = 165;
const r = analyzeCone(loadFixture('icon-frame-135deg.raw', size), size, 1);
const err = r.valid ? ad(r.deg, 135) : 999;
check('标注帧必须检出', r.valid === true, `valid=${r.valid} deg=${r.deg.toFixed(1)}° conf=${r.conf.toFixed(2)}`);
check('标注帧方向误差 <= 8°', err <= 8, `deg=${r.deg.toFixed(1)}° 真值=135° 误差=${err.toFixed(1)}°`);
check('西侧下降边落在 180°±8°', !!r.dbg && r.dbg.fallDeg >= 0 && ad(r.dbg.fallDeg, 180) <= 8,
  `fallDeg=${r.dbg && r.dbg.fallDeg.toFixed(1)}° α=${r.dbg && r.dbg.fall.toFixed(2)}`);
check('置信度 >= 0.3（单边也要够时序层采纳）', r.conf >= 0.3, `conf=${r.conf.toFixed(2)}`);
check('小地图门控仍判定为存在', (r.cyanFrac || 0) >= 0.0015, `cyanFrac=${(r.cyanFrac || 0).toFixed(4)}`);

// ---- 2. 真实视频 166 帧 ----
const TMP = os.tmpdir();
if (fs.existsSync(path.join(TMP, 'vidroi.bin'))) {
  const man = JSON.parse(fs.readFileSync(path.join(TMP, 'vidroi.json'), 'utf8'));
  const gate = JSON.parse(fs.readFileSync(path.join(TMP, 'vidscan-gate.json'), 'utf8'));
  const gm = new Map(gate.map((g) => [g.t, g.blob >= 8]));
  const blob = fs.readFileSync(path.join(TMP, 'vidroi.bin'));
  let hit = 0;
  let miss = 0;
  let fp = 0;
  let tn = 0;
  const missed = [];
  for (const e of man.list) {
    const S = e.size;
    const data = new Uint8ClampedArray(blob.buffer, blob.byteOffset + e.off, S * S * 4);
    const q = analyzeCone({ data, width: S, height: S }, S, man.step);
    const present = (q.cyanFrac || 0) >= 0.0015;
    const valid = q.valid && present; // 运行时：先门控再谈扇形
    const has = gm.get(e.t) === true;
    if (has && valid) hit += 1;
    else if (has && !valid) {
      miss += 1;
      missed.push(e.t);
    } else if (!has && valid) fp += 1;
    else tn += 1;
  }
  check('真实视频有小地图检出 >= 147/153', hit >= 147, `检出 ${hit}/${hit + miss}${missed.length ? '，漏检 t=' + missed.join(',') : ''}`);
  check('真实视频无小地图误检 <= 1/13', fp <= 1, `误检 ${fp}/${fp + tn} 正确拒绝 ${tn}`);
} else {
  console.log('SKIP  Temp/vidroi.bin 不在，跳过 166 帧校验');
}

console.log(`\n${fail ? '存在失败' : '全部通过'}：pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);

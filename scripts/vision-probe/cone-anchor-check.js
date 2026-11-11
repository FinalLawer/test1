'use strict';
/* 用「当前高置信检出」当稀疏锚点，检验放宽阈值后新增的检出是真方向还是假峰。
 * 只读分析，不改源码。 */
const fs = require('fs');
const frames = JSON.parse(fs.readFileSync(require('path').join(require('os').tmpdir(), 'cone-candidates.json'), 'utf8'));
const ad = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

function pick(f, flatMin, monoMin, useRival) {
  if (!f.has) return null;                      // 小地图存在性门控
  const ok = f.cand.filter(x => !x.f1 && x.flat >= flatMin && x.mono >= monoMin)
                   .sort((a, b) => b.score - a.score);
  if (!ok.length) return null;
  const b = ok[0];
  const rival = useRival
    ? (ok.find(x => ad(x.c * 5 + 2.5, b.c * 5 + 2.5) > 30) || { score: 0 }).score
    : 0;
  if (b.score < Math.max(0.16, rival * 1.18)) return null;
  return { deg: (b.c * 5 + 2.5) % 360, score: b.score, cand: ok };
}

const A = (f) => pick(f, 0.62, 4, true);      // 当前
const B = (f) => pick(f, 0, 0, false);        // 放宽 + 门控
const rows = frames.map(f => ({ ...f, a: A(f), b: B(f) }));
const anchors = rows.filter(r => r.a);

const added = rows.filter(r => r.b && !r.a);
let withPair = 0, agree = 0, disagree = 0, noAnchor = 0;
const samples = [];
for (const r of added) {
  const left = anchors.filter(x => x.t < r.t && r.t - x.t <= 6).slice(-1)[0];
  const right = anchors.filter(x => x.t > r.t && x.t - r.t <= 6)[0];
  if (!left || !right) { noAnchor++; continue; }
  // 锚点两端本身必须一致，否则这段是急转/剪辑，不能当标尺
  if (ad(left.a.deg, right.a.deg) > 45) { noAnchor++; continue; }
  withPair++;
  const mid = (left.a.deg + ((((right.a.deg - left.a.deg + 540) % 360) - 180)) / 2 + 360) % 360;
  const err = ad(r.b.deg, mid);
  if (err <= 25) agree++; else disagree++;
  if (samples.length < 12) samples.push({ t: r.t, deg: +r.b.deg.toFixed(1), mid: +mid.toFixed(1), err: +err.toFixed(1) });
}
console.log(`锚点帧(当前配置检出)=${anchors.length}/153  放宽后新增检出=${added.length}`);
console.log(`可配对(前后6s各有一个一致锚点)=${withPair}  与锚点中点差<=25°: ${agree}  不符: ${disagree}  无可用锚点: ${noAnchor}`);
if (withPair) console.log(`锚点一致率 = ${(100 * agree / withPair).toFixed(1)}%`);
console.log('\n样例：', JSON.stringify(samples));

// 反向校验：在两者都检出的帧上，放宽配置是否把方向改坏了
const both = rows.filter(r => r.a && r.b);
const diff = both.map(r => ad(r.a.deg, r.b.deg)).sort((x, y) => x - y);
const changed = diff.filter(x => x > 15).length;
console.log(`\n两者都检出=${both.length}  角度差中位数=${diff.length ? diff[diff.length >> 1].toFixed(1) : '-'}°  >15°改向=${changed}`);

// 随机基线：把新增帧的方向随机打乱，看锚点一致率是多少
let rndAgree = 0;
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff * 360;
for (const r of added) {
  const left = anchors.filter(x => x.t < r.t && r.t - x.t <= 6).slice(-1)[0];
  const right = anchors.filter(x => x.t > r.t && x.t - r.t <= 6)[0];
  if (!left || !right || ad(left.a.deg, right.a.deg) > 45) continue;
  const mid = (left.a.deg + ((((right.a.deg - left.a.deg + 540) % 360) - 180)) / 2 + 360) % 360;
  if (ad(rnd(), mid) <= 25) rndAgree++;
}
console.log(`随机方向基线一致率 = ${withPair ? (100 * rndAgree / withPair).toFixed(1) : '-'}%（25/360×2 ≈ 13.9% 理论值）`);

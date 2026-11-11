'use strict';
/* 真实视频帧（B站教程 P，原生解码→1.5R 裁窗）跑当前 analyzeCone。
 * 两种口径都报：
 *   离线标签 gate：青色三角 blob>=8 认为有小地图（用来标注天然负样本）
 *   运行时门控 present：analyzeCone 自己返回的 cyanFrac（和 tickBearing 完全同源）
 * 后者才是产品里真正生效的那个。 */
const fs = require('fs');
const src = fs.readFileSync(require('path').join(require('path').resolve(__dirname, '..', '..'), 'src', 'webview-preload.js'), 'utf8');
const h0 = src.indexOf('function degOf(ux, uy) {');
const h1 = src.indexOf('/* ---------------------------------------------------------------- 扇形通道', h0);
const c0 = src.indexOf('function analyzeCone(img, size, step) {');
const c1 = src.indexOf('/**\n * 圆形 α-β 滤波', c0);
const { degOf, angDiff } = new Function(src.slice(h0, h1) + ';return { degOf, angDiff };')();
const analyzeCone = new Function('degOf', 'angDiff', src.slice(c0, c1) + ';return analyzeCone;')(degOf, angDiff);
const man = JSON.parse(fs.readFileSync(require('path').join(require('os').tmpdir(), 'vidroi.json'), 'utf8'));
const gate = JSON.parse(fs.readFileSync(require('path').join(require('os').tmpdir(), 'vidscan-gate.json'), 'utf8'));
const gateMap = new Map(gate.map(g => [g.t, g.blob >= 8]));
const blob = fs.readFileSync(require('path').join(require('os').tmpdir(), 'vidroi.bin'));
const MIN_CYAN = 0.0015;
let hit = 0, miss = 0, fp = 0, tn = 0;
let gHit = 0, gMiss = 0, gFp = 0, gTn = 0;
const rows = [];
for (const e of man.list) {
  const S = e.size, bytes = S * S * 4;
  const data = new Uint8ClampedArray(blob.buffer.slice(blob.byteOffset + e.off, blob.byteOffset + e.off + bytes));
  const r = analyzeCone({ data, width: S, height: S }, S, man.step);
  const has = gateMap.get(e.t) === true;
  const present = (r.cyanFrac || 0) >= MIN_CYAN;
  const valid = r.valid && present;             // 运行时：先门控再谈扇形
  if (has && valid) hit += 1;
  else if (has && !valid) miss += 1;
  else if (!has && valid) fp += 1;
  else tn += 1;
  if (has && r.valid) gHit += 1;
  else if (has && !r.valid) gMiss += 1;
  else if (!has && r.valid) gFp += 1;
  else gTn += 1;
  const d = r.dbg ? `score=${r.dbg.score.toFixed(2)} all=${r.dbg.all.toFixed(2)} fade=${r.dbg.fade.toFixed(2)} flat=${r.dbg.flat.toFixed(2)} pos=${r.dbg.pos}` : '';
  rows.push(`${String(e.t).padStart(5)}s ${has ? '有小地图' : '无小地图'} ${present ? '门控✓' : '门控✗'} ${r.valid ? `✓ ${r.deg.toFixed(1)}° conf=${r.conf.toFixed(2)}` : '✗ invalid'} cyan=${(r.cyanFrac || 0).toFixed(4)} ${d}`);
}
console.log(rows.join('\n'));
console.log('\n================ 汇总 ================');
console.log(`【未接门控，历史对照】有小地图 ${gHit + gMiss} 帧  检出 ${gHit} (${(100*gHit/(gHit+gMiss)).toFixed(1)}%)  无小地图误检 ${gFp}/13`);
console.log(`【运行时：门控 + 放宽判据】有小地图 ${hit + miss} 帧  检出 ${hit}  漏检 ${miss}  检出率 ${(100*hit/(hit+miss)).toFixed(1)}%`);
console.log(`                          无小地图 ${fp + tn} 帧  误检 ${fp}  正确拒绝 ${tn}`);

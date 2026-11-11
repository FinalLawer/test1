'use strict';
/* 大跳挂起确认：500 帧端到端 A/B（2026-11-07）。
 *
 * 不是手写模拟 —— 分别从**当前源码**与**改动前备份**里抠出真实的
 * angDiff / viewPayload / updateView（常量也从各自源码提取），
 * 把 frames500-summary.json 的逐帧识别结果按时间戳喂进去，比较「上屏」序列。
 *
 * 硬指标：t=111.37 / 117.31 两帧孤立误检的上屏误差、
 * 有可信 ref 帧的均误 / >30° 数、上屏大跳数、挂起与确认次数。
 * 不启动应用、不连调试端口、不读运行帧。
 */
const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '..', '..');
const TMP = require('os').tmpdir();
const ad = (x, y) => Math.abs(((x - y + 540) % 360) - 180);

function grab(src, name) {
  const re = new RegExp('^function ' + name + '\\s*\\([^)]*\\)\\s*\\{', 'm');
  const m = re.exec(src);
  if (!m) throw new Error('找不到函数 ' + name);
  let i = m.index + m[0].length, depth = 1;
  while (depth > 0 && i < src.length) {
    const c = src[i];
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    i += 1;
  }
  return src.slice(m.index, i);
}
function grabConst(src, name, required) {
  const re = new RegExp('^const ' + name + ' = ([^;]+);', 'm');
  const m = re.exec(src);
  if (!m) {
    if (required) throw new Error('找不到常量 ' + name);
    return '';
  }
  return `const ${name} = ${m[1]};`;
}
function makeRunner(src) {
  const consts = ['VIEW_GRACE_MS', 'VIEW_JUMP_DEG', 'VIEW_PENDING_MATCH_DEG']
    .map((n, i) => grabConst(src, n, i === 0)).filter(Boolean).join('\n');
  const code = consts + '\n' + ['angDiff', 'viewPayload', 'updateView'].map((n) => grab(src, n)).join('\n\n');
  const BEARING = { view: { theta: -1, conf: 0, src: '', t: 0, sent: -1, pending: -1 } };
  const updateView = new Function('BEARING', code + '\nreturn updateView;')(BEARING);
  return { updateView, BEARING };
}
function minCyan(src) {
  const m = /^const MAP_CYAN_FRAC_MIN = ([^;]+);/m.exec(src);
  if (!m) throw new Error('找不到 MAP_CYAN_FRAC_MIN');
  return Number(m[1]);
}

const curSrc = fs.readFileSync(ROOT + '/src/webview-preload.js', 'utf8');
const oldSrc = fs.readFileSync(TMP + '/webview-preload.before-pending.js', 'utf8');
const runners = { old: makeRunner(oldSrc), cur: makeRunner(curSrc) };
const GATE = minCyan(curSrc);
const summary = JSON.parse(fs.readFileSync(ROOT + '/scripts/vision-probe/frames500-summary.json', 'utf8'));
const F = summary.frames;
const suspectTimes = F.filter((f) => f.suspect).map((f) => f.t);

function run(which) {
  const { updateView, BEARING } = runners[which];
  let held = 0, confirmed = 0, dropped = 0, prevPending = -1;
  const out = F.map((f) => {
    const now = 1000 + f.t * 1000;
    const v = updateView(
      { valid: f.ok, deg: f.deg, conf: f.conf, width: 90 },
      now,
      (f.cyan || 0) >= GATE
    );
    if (prevPending >= 0) {
      if (ad(f.deg, prevPending) < 30 && F.some((q) => q.t === f.t && q.ok)) confirmed += 1;
      else dropped += 1;
    }
    prevPending = BEARING.view.pending;
    if (v && v.src === 'pending') held += 1;
    return { t: f.t, deg: v ? v.deg : null, src: v ? v.src : 'null' };
  });
  return { out, held, confirmed, dropped };
}
function metrics(r) {
  const { out } = r;
  const errs = [], jumps = [];
  out.forEach((x, i) => {
    if (x.deg === null) return;
    if (F[i].ref !== null) errs.push(ad(x.deg, F[i].ref));
    if (i > 0 && out[i - 1].deg !== null && F[i].t - F[i - 1].t <= 1.4) jumps.push(ad(x.deg, out[i - 1].deg));
  });
  errs.sort((a, b) => a - b);
  const sus = suspectTimes.map((t) => {
    const i = F.findIndex((f) => f.t === t);
    return out[i].deg === null ? 999 : ad(out[i].deg, F[i].ref);
  });
  return {
    n: errs.length,
    mean: errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : 0,
    p90: errs[Math.floor(errs.length * 0.9)] || 0,
    over30: errs.filter((x) => x > 30).length,
    big: jumps.filter((x) => x > 60).length,
    sus
  };
}
const A = run('old'), B = run('cur');
const ma = metrics(A), mb = metrics(B);
console.log(`帧数 ${F.length}，有可信 ref ${F.filter((f) => f.ref !== null).length}，门控 ${GATE}`);
console.log('版本        | 上屏帧 均误 p90误 >30° | 上屏大跳 | 两帧孤立误检上屏误差 | 挂起 确认 丢弃');
for (const [name, r, m, meta] of [['改动前', A, ma, null], ['当前', B, mb, B]]) {
  console.log(`${name.padEnd(10)} | ${String(m.n).padStart(3)} ${m.mean.toFixed(1).padStart(5)} ${m.p90.toFixed(1).padStart(5)} ${String(m.over30).padStart(3)} | ` +
    `${String(m.big).padStart(3)} | ${m.sus[0].toFixed(1).padStart(6)}° / ${m.sus[1].toFixed(1).padStart(6)}° | ` +
    (meta ? `${String(meta.held).padStart(3)} ${String(meta.confirmed).padStart(3)} ${String(meta.dropped).padStart(3)}` : '  -   -   -'));
}
console.log('\n两帧疑似附近的上屏序列（时间: 改动前 / 当前 / ref）');
for (const st of suspectTimes) {
  const i0 = F.findIndex((f) => f.t === st);
  const seg = [];
  for (let i = Math.max(0, i0 - 3); i <= Math.min(F.length - 1, i0 + 3); i += 1) {
    const a = A.out[i].deg === null ? '----' : A.out[i].deg.toFixed(0) + '°';
    const b = B.out[i].deg === null ? '----' : B.out[i].deg.toFixed(0) + '°' + (B.out[i].src === 'pending' ? 'P' : '');
    seg.push(`${F[i].t.toFixed(2)}s:${a}/${b}/${F[i].ref === null ? 'no' : F[i].ref.toFixed(0) + '°'}`);
  }
  console.log('  ' + seg.join('  '));
}
const ok = mb.mean < ma.mean && mb.sus[0] < ma.sus[0] && mb.sus[1] < ma.sus[1] && mb.big <= ma.big;
console.log(`\n${ok ? 'PASS 当前版本在全部硬指标上不劣于改动前' : 'FAIL 存在退化'}`);
process.exit(ok ? 0 : 1);

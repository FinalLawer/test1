'use strict';
/* 视角时序层回归（2026-11-07）。
 *
 * 本文件取代系统 Temp 下的 bearing-view-test.js（旧版按「高把握大跳直接就位」写）。
 * 500 帧密集序列证实 t=111.37 / 117.31 两处误检都是**孤立单帧脉冲**，
 * 旧门限 (jump>100 && conf>=0.55) 会让 conf=1.00 的假峰原样上屏。
 * 现改为：>100° 大跳一律挂起一帧，等下一个有效帧复核，
 * 下一帧与挂起角度相差 <30° 才承认是真转身。
 *
 * 常量直接从源码提取，避免测试里的数值与运行时静默失配。
 * 不启动应用、不连调试端口，只读 src/webview-preload.js 做离线注入。
 */
const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '..', '..');
const src = fs.readFileSync(ROOT + '/src/webview-preload.js', 'utf8');

/** 按函数名抠出整段函数体（花括号配平） */
function grab(name) {
  const re = new RegExp('^function ' + name + '\\s*\\([^)]*\\)\\s*\\{', 'm');
  const m = re.exec(src);
  if (!m) throw new Error('找不到函数 ' + name);
  let i = m.index + m[0].length;
  let depth = 1;
  while (depth > 0 && i < src.length) {
    const c = src[i];
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    i += 1;
  }
  return src.slice(m.index, i);
}
/** 常量定义从源码同步，源码改名会主动报错 */
function grabConst(name) {
  const re = new RegExp('^const ' + name + ' = ([^;]+);', 'm');
  const m = re.exec(src);
  if (!m) throw new Error('找不到常量 ' + name);
  return `const ${name} = ${m[1]};`;
}
const code = ['VIEW_GRACE_MS', 'VIEW_JUMP_DEG', 'VIEW_PENDING_MATCH_DEG']
  .map(grabConst).join('\n') + '\n' +
  ['angDiff', 'viewPayload', 'updateView'].map(grab).join('\n\n');
const BEARING = { view: { theta: -1, conf: 0, src: '', t: 0, sent: -1, pending: -1 } };
const { updateView, viewPayload } = new Function(
  'BEARING', code + '\nreturn { updateView, viewPayload };'
)(BEARING);
const reset = () => {
  BEARING.view = { theta: -1, conf: 0, src: '', t: 0, sent: -1, pending: -1 };
};

let pass = 0;
let fail = 0;
function check(label, got, want, tol = 0.6) {
  const ok = typeof want === 'number'
    ? typeof got === 'number' && Math.abs(((got - want + 540) % 360) - 180) <= tol
    : got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(38)} got=${typeof got === 'number' ? got.toFixed(1) : got}  want=${typeof want === 'number' ? want.toFixed(1) : want}`);
  ok ? pass++ : fail++;
}
const now = Date.now();
const cone = (deg, conf = 0.8, width = 90) => ({ valid: true, deg, conf, width });
const invalid = () => ({ valid: false, deg: 0, conf: 0, width: 90 });

// ---- 1. 基础：扇形角度 / 来源 / 置信原样透传 ----
reset();
let v = updateView(cone(90), now);
check('仅扇形 → 角度=扇形', v.deg, 90);
check('仅扇形 → 来源', v.src, 'cone');
check('仅扇形 → 置信', v.conf, 0.8, 0.01);

// ---- 2. 四个正方向都不被改写 ----
for (const [label, deg] of [['东', 0], ['北', 90], ['西', 180], ['南', 270]]) {
  reset();
  v = updateView(cone(deg), now);
  check(`扇形 ${label} → ${deg}°`, v.deg, deg, 0.1);
}

// ---- 3. 扇形恒在 ⇒ 漏检保持，宽限耗尽才消失 ----
reset();
check('首帧无证据 → null', updateView(null, now) === null ? 'null' : 'object', 'null');
reset();
updateView(cone(90, 0.8), now);
let h = updateView(invalid(), now + 100);
check('漏检一帧 → 保持方向', h.deg, 90);
check('漏检一帧 → 来源 hold', h.src, 'hold');
check('漏检一帧 → 置信衰减', h.conf < 0.8 ? '衰减' : '未衰减', '衰减');
h = updateView(cone(270, 0.1), now + 200);
check('低置信帧也不丢绿弧', h.deg, 90);
check('宽限耗尽 → null', updateView(null, now + 2000) === null ? 'null' : 'object', 'null');

// ---- 4. 连续小幅输入：首帧直接就位，之后稳定收敛 ----
reset();
let prev = null;
for (let i = 0; i < 6; i += 1) {
  const r = updateView(cone(90, 0.7), now + i * 33);
  if (prev === null) check('首帧直接就位', r.deg, 90);
  prev = r;
}
check('六帧后仍收敛在目标', prev.deg, 90);

// ---- 5. 大跳语义（本轮改动核心）：一律挂起，不直接就位 ----
reset();
updateView(cone(90, 0.7), now);
const jump = updateView(cone(270, 0.7), now + 33);
check('普通大跳 → 不上屏', jump.deg, 90);
check('普通大跳 → 来源 pending', jump.src, 'pending');
check('普通大跳 → 置信仍透传', jump.conf, 0.7, 0.01);
reset();
updateView(cone(90, 0.8), now);
const lowJump = updateView(cone(270, 0.2), now + 33);
check('低把握大跳 → 不就位', lowJump.deg < 100 ? '保持' : '甩过去', '保持');
reset();
updateView(cone(90, 0.8), now);
const hiJump = updateView(cone(270, 1.0), now + 33);
check('高把握大跳(1.00) → 也挂起', hiJump.deg < 100 ? '保持' : '甩过去', '保持');

// ---- 6. 孤立单帧脉冲：下一帧回原方向 ⇒ 丢弃 ----
reset();
updateView(cone(90, 0.8), now);
updateView(cone(270, 1.0), now + 33);
const back = updateView(cone(90, 0.8), now + 66);
check('孤立脉冲 → 绿弧不被甩反', back.deg, 90);
check('孤立脉冲 → 恢复正常采样', back.src, 'cone');

// ---- 7. 真实转身：连续两帧在新方向 ⇒ 确认，只延迟一帧 ----
reset();
updateView(cone(90, 0.8), now);
updateView(cone(270, 0.9), now + 33);
const turned = updateView(cone(272, 0.9), now + 66);
check('真实转身 → 第二帧就位', turned.deg, 272);
check('真实转身 → 来源 cone', turned.src, 'cone');

// ---- 8. 确认容差边界（<30° 才承认）----
reset();
updateView(cone(90, 0.8), now);
updateView(cone(270, 0.9), now + 33);
const edge30 = updateView(cone(300, 0.9), now + 66);
check('相差 30° → 不确认', edge30.deg < 100 ? '保持' : '确认', '保持');
reset();
updateView(cone(90, 0.8), now);
updateView(cone(270, 0.9), now + 33);
const edge25 = updateView(cone(295, 0.9), now + 66);
check('相差 25° → 确认', edge25.deg, 295);

// ---- 9. 状态清理 ----
reset();
updateView(cone(90, 0.8), now);
updateView(cone(270, 0.9), now + 33);
const held = updateView(invalid(), now + 66);
check('挂起期间漏检 → hold', held.src, 'hold');
const afterHold = updateView(cone(272, 0.9), now + 99);
check('挂起期间漏检不消费 pending', afterHold.deg, 272);

reset();
updateView(cone(90, 0.8), now);
updateView(cone(270, 0.9), now + 33);
check('小地图消失 → null', updateView(null, now + 66, false) === null ? 'null' : 'object', 'null');
const afterGone = updateView(cone(45, 0.8), now + 99);
check('小地图消失后清 pending', afterGone.deg, 45);

reset();
updateView(cone(90, 0.8), now);
const t0 = now + 33;
updateView(cone(270, 0.9), t0);
check('宽限耗尽 → null', updateView(null, t0 + 1300) === null ? 'null' : 'object', 'null');
const afterTimeout = updateView(cone(272, 0.9), t0 + 1366);
check('宽限耗尽清 pending → 不认旧跳变', afterTimeout.deg < 100 ? '保持' : '被旧值确认', '保持');

reset();
updateView(cone(90, 0.8), now);
updateView(cone(270, 1.0), now + 33);
updateView(cone(200, 1.0), now + 66);
const multi = updateView(cone(90, 0.8), now + 99);
check('连续两个异向假峰 → 都不上屏', multi.deg, 90);

// ---- 10. 出口换算与宽度 ----
check('viewPayload 北→0°', viewPayload({ deg: 90, conf: 0.8, src: 'cone' }, { valid: true, width: 72 }).view, 0, 0.1);
check('viewPayload 东→90°', viewPayload({ deg: 0, conf: 0.8, src: 'cone' }, { valid: true, width: 72 }).view, 90, 0.1);
check('viewPayload 南→180°', viewPayload({ deg: 270, conf: 0.8, src: 'cone' }, { valid: true, width: 72 }).view, 180, 0.1);
check('viewPayload 保留宽度', viewPayload({ deg: 90, conf: 0.8, src: 'cone' }, { valid: true, width: 72 }).viewWidth, 72, 0.1);
check('挂起帧仍报恒定宽度', viewPayload({ deg: 90, conf: 0.9, src: 'pending' }, { valid: true, width: 90 }).viewWidth, 90, 0.1);
check('保持期仍报恒定宽度', viewPayload({ deg: 90, conf: 0.4, src: 'hold' }, { valid: false, width: 90 }).viewWidth, 90, 0.1);
const pl2 = viewPayload(null, null);
check('viewPayload 无视角 → view=null', pl2.view === null ? 'null' : 'object', 'null');
check('viewPayload 无视角 → 空来源', pl2.viewSource, '');

console.log(`\n${fail === 0 ? '全部通过' : '有失败项'}：pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

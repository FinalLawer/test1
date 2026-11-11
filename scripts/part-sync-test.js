'use strict';
/* 分 P 自动连播同步 / 当前 P 标注 回归（2026-11-08）。
 *
 * 纯离线：从 src/renderer/app.js 与 src/webview-preload.js 抠出真实函数体注入执行，
 * 不启动 Electron、不连调试端口、不碰运行窗口。源码改名会主动抛错，避免静默失配。
 *
 * 覆盖两条链路：
 *   1. 访客页 snapshot() 把 location 里的 ?p= 与视频 id 带出来；
 *   2. 浮窗 syncPartFromGuest() 校准 state.p / 下拉框 / 快捷键基准 / lastPart。
 */
const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '..');
const appSrc = fs.readFileSync(ROOT + '/src/renderer/app.js', 'utf8');
const guestSrc = fs.readFileSync(ROOT + '/src/webview-preload.js', 'utf8');

/** 按函数名抠出整段函数体（花括号配平） */
function grab(src, name) {
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

let pass = 0;
let fail = 0;
function check(label, got, want) {
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(44)} got=${String(got)}  want=${String(want)}`);
  ok ? pass++ : fail++;
}

/* ------------------------------------------------ 环境：可观测的 DOM / API */
let clock = 1_000_000;
const FakeDate = { now: () => clock };
const saved = [];
const toasts = [];
const flags = [];

const sel = {
  _opts: [],
  value: '',
  title: '',
  set textContent(v) { if (v === '') this._opts = []; },
  get textContent() { return ''; },
  get opts() { return this._opts; },
  appendChild(o) { this._opts.push(o); },
  classList: {
    add(c) { flags.push('add:' + c); },
    toggle(c, on) { flags.push(`toggle:${c}:${on}`); }
  }
};

const state = {
  id: 'BV1xx411c7mD',
  p: 1,
  pages: Array.from({ length: 20 }, (_, i) => ({ page: i + 1, part: `第${i + 1}段` })),
  loadIssuedAt: 0
};

const env = {
  state,
  $: () => sel,
  document: { createElement: () => ({}) },
  window: { api: { save: (p) => { saved.push(p); return Promise.resolve(); } } },
  toast: (msg) => toasts.push(msg),
  Date: FakeDate
};

const appCode = ['partFromUrl', 'idFromUrl', 'syncPartFromGuest', 'setCurrentPart', 'renderParts']
  .map((n) => grab(appSrc, n)).join('\n\n');
const A = new Function(...Object.keys(env), appCode + '\nreturn { partFromUrl, idFromUrl, syncPartFromGuest, setCurrentPart, renderParts };')(
  ...Object.values(env)
);

/* guest 侧单独一套：同名函数不能与 app 混在一个作用域 */
const guestCode = ['partFromUrl', 'idFromUrl', 'snapshot'].map((n) => grab(guestSrc, n)).join('\n\n');
let location = { href: '', pathname: '' };
const G = new Function('video', 'location', guestCode + '\nreturn { partFromUrl, idFromUrl, snapshot };')(
  null, { get href() { return location.href; }, get pathname() { return location.pathname; } }
);

function reset(over = {}) {
  clock = 1_000_000;
  saved.length = 0;
  toasts.length = 0;
  flags.length = 0;
  sel._opts = [];
  sel.value = '';
  sel.title = '';
  Object.assign(state, {
    id: 'BV1xx411c7mD', p: 1, loadIssuedAt: 0,
    pages: Array.from({ length: 20 }, (_, i) => ({ page: i + 1, part: `第${i + 1}段` }))
  }, over);
}

/* ------------------------------------------------------ 1. URL 解析 */
console.log('\n--- 1. URL 解析 ---');
const BV = 'https://www.bilibili.com/video/BV1xx411c7mD/';
check('?p=3&autoplay=1 → 3', A.partFromUrl(BV + '?p=3&autoplay=1'), 3);
check('&p=12 → 12', A.partFromUrl(BV + '?autoplay=1&p=12'), 12);
check('page=7 兼容 → 7', A.partFromUrl(BV + '?page=7'), 7);
check('无 p → 0', A.partFromUrl(BV), 0);
check('p=0 → 0', A.partFromUrl(BV + '?p=0'), 0);
check('p=abc → 0', A.partFromUrl(BV + '?p=abc'), 0);
check('sp=3 不误命中', A.partFromUrl(BV + '?sp=3'), 0);
check('null → 0', A.partFromUrl(null), 0);
check('guest 与浮窗解析一致', G.partFromUrl(BV + '?p=9'), A.partFromUrl(BV + '?p=9'));

console.log('\n--- 2. 视频 id 解析 ---');
check('BV 号（大小写归一）', A.idFromUrl('https://www.bilibili.com/video/bv1XX411c7mD/?p=2'), 'bv1xx411c7md');
check('av 号', A.idFromUrl('https://www.bilibili.com/video/av170001/?p=4'), 'av170001');
check('非视频页 → 空', A.idFromUrl('https://www.bilibili.com/?p=3'), '');
check('guest 与浮窗一致', G.idFromUrl(BV + '?p=2'), A.idFromUrl(BV + '?p=2'));

console.log('\n--- 3. guest snapshot 带 p / vid ---');
location = {
  href: 'https://www.bilibili.com/video/BV1xx411c7mD/?p=6&autoplay=1',
  pathname: '/video/BV1xx411c7mD/'
};
let s = G.snapshot();
check('无 video 时 found=false', s.found, false);
check('无 video 仍带 p', s.p, 6);
check('无 video 仍带 vid', s.vid, 'bv1xx411c7md');

/* ------------------------------------------------------ 4. 同步逻辑 */
console.log('\n--- 4. 自动连播同步 ---');
reset();
A.syncPartFromGuest({ p: 3, vid: 'bv1xx411c7md' }, false);
check('导航事件 → state.p 更新', state.p, 3);
check('导航事件 → 下拉 value 更新', sel.value, '3');
check('导航事件 → 记住 lastPart', saved[0] && saved[0].lastPart, 3);
check('导航事件 → 提示带总数', toasts[0], '已切到 P3/20');
check('当前项文本带 P3/20', sel.opts[2].textContent.startsWith('▶ P3/20'), true);
check('非当前项不带 ▶', sel.opts[1].textContent.startsWith('▶'), false);
check('下拉 title 写明当前 P', sel.title.includes('P3/20'), true);

reset();
A.syncPartFromGuest({ p: 1, vid: 'bv1xx411c7md' }, false);
check('相同页码 → 不重复动作', saved.length + toasts.length, 0);

reset();
A.syncPartFromGuest({ p: 4, vid: 'bvOTHERRRRRR' }, false);
check('别的视频上报 → 拒绝', state.p, 1);

reset();
A.syncPartFromGuest({ p: 4, vid: '' }, false);
check('vid 读不到 → 放行（宽松）', state.p, 4);

reset();
A.syncPartFromGuest({ p: 21, vid: 'bv1xx411c7md' }, false);
check('超出分 P 总数 → 拒绝', state.p, 1);

reset({ pages: [] });
A.syncPartFromGuest({ p: 4, vid: 'bv1xx411c7md' }, false);
check('分 P 列表为空 → 拒绝', state.p, 1);

console.log('\n--- 5. 载入竞态门控 ---');
reset({ loadIssuedAt: clock });
A.syncPartFromGuest({ p: 5, vid: 'bv1xx411c7md' }, true);
check('载入后 0ms 的旧页心跳 → 忽略', state.p, 1);
A.syncPartFromGuest({ p: 5, vid: 'bv1xx411c7md' }, false);
check('同一时刻的导航事件 → 不被门限挡', state.p, 5);

reset({ loadIssuedAt: clock });
clock += 1600;
A.syncPartFromGuest({ p: 7, vid: 'bv1xx411c7md' }, true);
check('载入 1.6s 后的心跳 → 放行', state.p, 7);

reset({ loadIssuedAt: clock });
clock += 1400;
A.syncPartFromGuest({ p: 7, vid: 'bv1xx411c7md' }, true);
check('载入 1.4s 的心跳 → 仍忽略', state.p, 1);

console.log('\n--- 6. 手动 / 单 P 边界 ---');
reset();
A.setCurrentPart(12, false);
check('非自动切换不弹提示不写设置', saved.length + toasts.length, 0);
check('非自动切换仍更新下拉', sel.value, '12');

reset({ pages: [{ page: 1, part: '唯一一集' }] });
A.renderParts();
check('单 P 时隐藏下拉', flags.includes('toggle:hidden:true'), true);

console.log(`\n==== ${pass} PASS / ${fail} FAIL ====`);
if (fail) process.exit(1);

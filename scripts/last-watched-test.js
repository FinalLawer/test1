'use strict';
/* 「上次看到」回归（2026-11-08）。
 *
 * 纯离线：从 src/main.js / src/console/console.js 抠出真实函数体注入执行，
 * 不启动 Electron、不连调试端口、不碰运行窗口。源码改名会主动抛错，避免静默失配。
 *
 * 覆盖四条链路：
 *   1. 主进程 noteWatched() 把片名 / id / 第几 P / 总数 / 时间一次写全；
 *   2. 启动器 lastWatchedLabel() + fmtWatchedAt() 拼装可读信息；
 *   3. partForLaunch() 修掉「空 <select> 把 lastPart 覆写成 P1」这个 bug；
 *   4. renderLastPart() / renderLastWatched() 的 UI 占位与隐藏逻辑。
 */
const fs = require('fs');
const ROOT = require('path').resolve(__dirname, '..');
const mainSrc = fs.readFileSync(ROOT + '/src/main.js', 'utf8');
const consoleSrc = fs.readFileSync(ROOT + '/src/console/console.js', 'utf8');
const htmlSrc = fs.readFileSync(ROOT + '/src/console/index.html', 'utf8');
const cssSrc = fs.readFileSync(ROOT + '/src/console/console.css', 'utf8');

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
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)} got=${JSON.stringify(got)}`);
  ok ? pass++ : fail++;
}

/* ------------------------------------------------------------------ 环境 */
const RealDate = Date;
const NOW = new RealDate(2026, 10, 8, 15, 0, 0).getTime(); // 本地 2026-11-08 15:00
class MockDate extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [NOW]));
  }
  static now() {
    return NOW;
  }
}

function makeEl() {
  return {
    _text: '',
    _html: '',
    value: '',
    title: '',
    hidden: false,
    disabled: false,
    _children: [],
    set textContent(v) {
      this._text = String(v);
      if (v === '') this._children = [];
    },
    get textContent() {
      return this._text;
    },
    set innerHTML(v) {
      this._html = String(v);
    },
    get innerHTML() {
      return this._html;
    },
    appendChild(o) {
      this._children.push(o);
    },
    classList: { add() {}, remove() {}, toggle() {} }
  };
}

const els = {};
const $ = (id) => els[id] || (els[id] = makeEl());
const documentStub = { createElement: () => makeEl() };
const uiState = { video: null };

const mainCode = [grab(mainSrc, 'shouldResumeOnLaunch'), grab(mainSrc, 'noteWatched')].join('\n\n');
const M = new Function(
  'Date', mainCode + '\nreturn { noteWatched, shouldResumeOnLaunch };'
)(MockDate);

const uiCode = [
  'escapeHtml',
  'fmtWatchedAt',
  'lastWatchedLabel',
  'renderLastWatched',
  'renderLastPart',
  'partForLaunch'
].map((n) => grab(consoleSrc, n)).join('\n\n');
const C = new Function(
  '$', 'document', 'state', 'Date',
  uiCode + '\nreturn { escapeHtml, fmtWatchedAt, lastWatchedLabel, renderLastWatched, renderLastPart, partForLaunch };'
)($, documentStub, uiState, MockDate);

/* ------------------------------------------------ 1. noteWatched 写入全字段 */
console.log('\n--- 主进程：noteWatched ---');
let s = {};
M.noteWatched(s, {
  text: 'https://www.bilibili.com/video/BV1xx411c7mD?p=3',
  p: 3,
  id: 'BV1xx411c7mD',
  title: '【原神一条龙全收集】蒙德',
  pageCount: 20
});
check('写入 lastText', s.lastText, 'https://www.bilibili.com/video/BV1xx411c7mD?p=3');
check('写入 lastPart', s.lastPart, 3);
check('写入 lastTitle', s.lastTitle, '【原神一条龙全收集】蒙德');
check('写入 lastVideoId', s.lastVideoId, 'BV1xx411c7mD');
check('写入 lastPageCount', s.lastPageCount, 20);
check('写入 lastWatchedAt', s.lastWatchedAt, NOW);

console.log('\n--- 主进程：只切 P 时保留片名与总数 ---');
M.noteWatched(s, { p: 4 });
check('lastPart 更新', s.lastPart, 4);
check('lastTitle 保留', s.lastTitle, '【原神一条龙全收集】蒙德');
check('lastPageCount 保留', s.lastPageCount, 20);
check('lastText 保留', s.lastText, 'https://www.bilibili.com/video/BV1xx411c7mD?p=3');
check('时间戳刷新', s.lastWatchedAt, NOW);

console.log('\n--- 主进程：非法值不污染记录 ---');
let t = { lastPart: 7, lastPageCount: 20, lastTitle: 'X' };
M.noteWatched(t, { p: 0, pageCount: -3, title: '' });
check('p=0 被忽略', t.lastPart, 7);
check('pageCount=-3 归零', t.lastPageCount, 0);
check('title 显式清空生效', t.lastTitle, '');
check('undefined 不覆盖 lastPageCount', (M.noteWatched({ lastPageCount: 9 }, { p: 2 }).lastPageCount), 9);
check('null settings 不抛错', M.noteWatched(null, { p: 1 }), null);

/* ------------------------------------------- 2. 时间格式 / 标签拼装 */
console.log('\n--- 启动器：fmtWatchedAt / lastWatchedLabel ---');
const at = (y, m, d, h = 12, mi = 34) => new RealDate(y, m - 1, d, h, mi, 0).getTime();
check('今天', C.fmtWatchedAt(at(2026, 11, 8, 9, 5)), '今天 09:05');
check('昨天', C.fmtWatchedAt(at(2026, 11, 7, 23, 50)), '昨天 23:50');
check('本月更早', C.fmtWatchedAt(at(2026, 11, 3)), '11月3日 12:34');
check('跨年', C.fmtWatchedAt(at(2025, 12, 31)), '2025/12/31');
check('无时间戳', C.fmtWatchedAt(0), '');
check('NaN', C.fmtWatchedAt('abc'), '');

const base = {
  lastText: 'https://www.bilibili.com/video/BV1xx411c7mD?p=7',
  lastPart: 7,
  lastPageCount: 20,
  lastTitle: '蒙德一条龙',
  lastVideoId: 'BV1xx411c7mD',
  lastWatchedAt: at(2026, 11, 8, 9, 5)
};
check('标题优先 + P7/20 + 今天', C.lastWatchedLabel(base), {
  name: '蒙德一条龙', part: 'P7/20', when: '今天 09:05'
});
check('无标题回退 BV 号', C.lastWatchedLabel({ ...base, lastTitle: '' }).name, 'BV1xx411c7mD');
check('只有 lastText 也能显示', C.lastWatchedLabel({ lastText: 'BV1aa411c7mE', lastPart: 2 }).name, 'BV1aa411c7mE');
check('无总数只显示 P7', C.lastWatchedLabel({ ...base, lastPageCount: 0 }).part, 'P7');
check('无记录返回 null', C.lastWatchedLabel({}), null);
check('老 settings 无时间戳 → when 为空', C.lastWatchedLabel({ lastText: 'BV1', lastPart: 1 }).when, '');
check('标题里 < > 会被转义', C.escapeHtml('<a&"b>'), '&lt;a&amp;&quot;b&gt;');

/* -------------------------------- 3. partForLaunch：修掉丢 P 的核心 bug */
console.log('\n--- 启动器：partForLaunch（核心回归） ---');
check('空 select 回退到 lastPart=7（旧代码会给 1）',
  C.partForLaunch('https://x/BV1', { lastText: 'https://x/BV1', lastPart: 7 }, ''), 7);
check('占位 select 有值就用它',
  C.partForLaunch('https://x/BV1', { lastText: 'https://x/BV1', lastPart: 7 }, '7'), 7);
check('下拉改到 P9 就按 P9',
  C.partForLaunch('https://x/BV1', { lastText: 'https://x/BV1', lastPart: 7 }, '9'), 9);
check('贴了新链接 → 换片回 P1',
  C.partForLaunch('https://x/BV2', { lastText: 'https://x/BV1', lastPart: 7 }, '7'), 1);
check('首次使用（无 lastText）取下拉值',
  C.partForLaunch('https://x/BV2', { lastText: '', lastPart: 1 }, '3'), 3);
check('首次使用且下拉为空 → P1',
  C.partForLaunch('https://x/BV2', { lastText: '', lastPart: 1 }, ''), 1);
check('非法下拉值回退 lastPart',
  C.partForLaunch('https://x/BV1', { lastText: 'https://x/BV1', lastPart: 5 }, 'abc'), 5);
check('负数下拉值回退 lastPart',
  C.partForLaunch('https://x/BV1', { lastText: 'https://x/BV1', lastPart: 5 }, '-2'), 5);
check('首尾空格不影响判定',
  C.partForLaunch('  https://x/BV1  ', { lastText: 'https://x/BV1', lastPart: 6 }, ''), 6);

/* ------------------------------------------ 4. UI 占位 / 显示与隐藏 */
console.log('\n--- 启动器：renderLastPart / renderLastWatched ---');
C.renderLastPart({ lastPart: 7, lastPageCount: 20 });
check('占位 option 的 value', els.part._children[0].value, '7');
check('占位 option 带 P/总数与 ▶', els.part._children[0].textContent, '▶ P7/20');
check('占位时下拉禁用', els.part.disabled, true);
check('占位时 sel.value', els.part.value, '7');

C.renderLastWatched(base);
check('有记录时信息条显示', els.resumeBar.hidden, false);
check('信息条含片名', els.resumeInfo.innerHTML.includes('蒙德一条龙'), true);
check('信息条含 P7/20', els.resumeInfo.innerHTML.includes('P7/20'), true);
check('信息条含时间', els.resumeInfo.innerHTML.includes('今天 09:05'), true);
check('title 给完整信息', els.resumeInfo.title, '蒙德一条龙 · P7/20 · 今天 09:05');

C.renderLastWatched({});
check('无记录时信息条隐藏', els.resumeBar.hidden, true);

C.renderLastWatched({ lastText: '<img src=x>', lastPart: 1, lastWatchedAt: 0 });
check('恶意标题被转义（无原始标签）', els.resumeInfo.innerHTML.includes('<img'), false);
check('转义后保留文本', els.resumeInfo.innerHTML.includes('&lt;img'), true);

/* ------------------------------------------- 5. 启动恢复开关与老配置迁移 */
console.log('\n--- 启动恢复：shouldResumeOnLaunch / 迁移 ---');
check('有记录且开关开 → 自动恢复',
  M.shouldResumeOnLaunch({ resumeOnLaunch: true, lastText: 'BV1' }, ''), true);
check('开关关 → 不自动恢复',
  M.shouldResumeOnLaunch({ resumeOnLaunch: false, lastText: 'BV1' }, ''), false);
check('没记录 → 不自动恢复',
  M.shouldResumeOnLaunch({ resumeOnLaunch: true, lastText: '' }, ''), false);
check('老配置没这字段 → 默认恢复',
  M.shouldResumeOnLaunch({ lastText: 'BV1' }, ''), true);
check('--open 显式指定时不抢',
  M.shouldResumeOnLaunch({ resumeOnLaunch: true, lastText: 'BV1' }, 'BV2'), false);

const defaultsMatch = /const DEFAULT_SETTINGS = (\{[\s\S]*?\n\});/.exec(mainSrc);
if (!defaultsMatch) throw new Error('找不到 DEFAULT_SETTINGS');
const DEFAULTS = new Function('DEFAULT_HOTKEYS', 'return ' + defaultsMatch[1])({});
check('resumeOnLaunch 出厂默认开启', DEFAULTS.resumeOnLaunch, true);
check('lastWatchedAt 出厂默认 0', DEFAULTS.lastWatchedAt, 0);
check('lastTitle 出厂默认空', DEFAULTS.lastTitle, '');
// 模拟 loadSettings() 的合并：老 settings.json 只有 lastText / lastPart
const merged = { ...JSON.parse(JSON.stringify(DEFAULTS)), ...{ lastText: 'BV1', lastPart: 6 } };
check('老配置合并不丢 lastPart', merged.lastPart, 6);
check('老配置补齐 lastTitle', merged.lastTitle, '');
check('老配置补齐 resumeOnLaunch', merged.resumeOnLaunch, true);
check('老配置能被 shouldResumeOnLaunch 接受', M.shouldResumeOnLaunch(merged, ''), true);

/* ------------------------------------------------------ 6. 结构完整性 */
console.log('\n--- 源码结构断言 ---');
check('main.js 有 noteWatched', mainSrc.includes('function noteWatched('), true);
check('main.js 有 shouldResumeOnLaunch', mainSrc.includes('function shouldResumeOnLaunch('), true);
check('bili:load 会广播 settings:changed',
  /noteWatched\(settings, \{[\s\S]*?broadcast\('settings:changed', settings\)/.test(mainSrc), true);
check('whenReady 有自动恢复分支',
  mainSrc.includes('shouldResumeOnLaunch(settings, OPEN_ARG)'), true);
check('--open 优先于自动恢复',
  /if \(OPEN_ARG\) createWindow\(\);[\s\S]{0,400}else if \(shouldResumeOnLaunch/.test(mainSrc), true);
check('resumeOnLaunch 变更不刷新观看时间',
  mainSrc.includes("patch.resumeOnLaunch !== undefined) settings.resumeOnLaunch"), true);
check('settings:save 只在 lastText/lastPart 时调 noteWatched',
  /patch\.lastText !== undefined \|\| patch\.lastPart !== undefined\) \{\s*noteWatched\(/.test(mainSrc), true);
check('浮窗 init 恢复时 autoplay=true',
  /loadVideo\(s\.lastText, p, true\)/.test(fs.readFileSync(ROOT + '/src/renderer/app.js', 'utf8')), true);

check('index.html 有上次看到四元素',
  ['resumeBar', 'resumeInfo', 'btnResume', 'setResumeOnLaunch'].every((id) => htmlSrc.includes('id="' + id + '"')), true);
check('CSS 有 .resume[hidden] 兜底', cssSrc.includes('.resume[hidden]'), true);
check('console.js 绑定了 setResumeOnLaunch',
  consoleSrc.includes("$('setResumeOnLaunch').addEventListener('change'"), true);
check('console.js 监听 settings:changed 刷新信息条',
  consoleSrc.includes('renderLastWatched(next)'), true);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail) process.exitCode = 1;

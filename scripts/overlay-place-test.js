'use strict';

/**
 * 「② 拖到小地图上 → 锁定位置」状态机回归。
 *
 * 复现的 bug：启动器 btnPlace 每次点击都调 overlayPlace(true)，参数写死，
 * 第二下点「锁定位置」只是又进了一次放置模式，红圈永远锁不上。
 *
 * 纯离线：从源码里抠出 setOverlayPlacing 函数体，注入 mock 窗口执行，
 * 不启动 Electron、不连调试端口、不碰任何设置文件。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TEMP = require('os').tmpdir();
const read = (p) => fs.readFileSync(p, 'utf8');

const mainSrc = read(path.join(ROOT, 'src/main.js'));
const consoleSrc = read(path.join(ROOT, 'src/console/console.js'));
const preloadSrc = read(path.join(ROOT, 'src/preload.js'));
const oldMainSrc = read(path.join(TEMP, 'main.before-placefix.js'));

let pass = 0;
let fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
}

/** 花括号配平提取函数体，避免下一个 function 行截断 async/嵌套 */
function grab(src, name) {
  const re = new RegExp('^(?:async\\s+)?function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{', 'm');
  const m = re.exec(src);
  if (!m) throw new Error('找不到函数 ' + name);
  let i = m.index + m[0].length;
  let depth = 1;
  while (depth > 0 && i < src.length) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  return src.slice(m.index, i);
}

/** 构造一个带 mock BrowserWindow 的 setOverlayPlacing 沙盒 */
function harness(src, initial) {
  const fnCode = grab(src, 'setOverlayPlacing');
  const calls = [];
  const w = {
    setIgnoreMouseEvents: (...a) => calls.push(['ignore', ...a]),
    setFocusable: (v) => calls.push(['focusable', v]),
    showInactive: () => calls.push(['showInactive']),
    webContents: {
      isLoading: () => false,
      send: (...a) => calls.push(['send', ...a])
    }
  };
  const factory = new Function('w', 'calls', `
    let overlayPlacing = ${JSON.stringify(initial)};
    const showOverlay = () => w;
    ${fnCode}
    return { setOverlayPlacing, get: () => overlayPlacing };
  `);
  return { ...factory(w, calls), calls };
}

console.log('--- 1. 两次点击 = 进入放置 → 锁定 ---');
{
  const h = harness(mainSrc, false);
  const first = h.setOverlayPlacing();
  check('第 1 下（不传参）进入放置模式', first, true);
  check('第 1 下鼠标可点', h.calls.some((c) => c[0] === 'ignore' && c[1] === false), true);
  check('第 1 下发 place 模式', h.calls.some((c) => c[0] === 'send' && c[2] === 'place'), true);

  h.calls.length = 0;
  const second = h.setOverlayPlacing();
  check('第 2 下（不传参）锁定', second, false);
  check('内部状态已复位', h.get(), false);
  check('锁定后开启鼠标穿透',
    h.calls.some((c) => c[0] === 'ignore' && c[1] === true && c[2] && c[2].forward === true), true);
  check('锁定后不可聚焦', h.calls.some((c) => c[0] === 'focusable' && c[1] === false), true);
  check('锁定后发 lock 模式', h.calls.some((c) => c[0] === 'send' && c[2] === 'lock'), true);

  const third = h.setOverlayPlacing();
  check('第 3 下重新进入放置（可再次调整）', third, true);
}

console.log('\n--- 2. 显式布尔值仍然幂等（热键等调用方） ---');
{
  const h = harness(mainSrc, false);
  check('setOverlayPlacing(true)', h.setOverlayPlacing(true), true);
  check('再 true 仍为 true', h.setOverlayPlacing(true), true);
  check('setOverlayPlacing(false)', h.setOverlayPlacing(false), false);
  check('再 false 仍为 false', h.setOverlayPlacing(false), false);
  const h2 = harness(mainSrc, false);
  check('null 视为切换', h2.setOverlayPlacing(null), true);
  check('undefined 视为切换', h2.setOverlayPlacing(undefined), false);
  const h3 = harness(mainSrc, true);
  check('初始 true 时切换为 false', h3.setOverlayPlacing(), false);
}

console.log('\n--- 3. 旧代码确实会复现「锁不上」 ---');
{
  const old = harness(oldMainSrc, false);
  // 旧启动器每次都硬传 true，等价于这里的两次调用
  const a = old.setOverlayPlacing(true);
  const b = old.setOverlayPlacing(true);
  check('旧实现第 1 下 true', a, true);
  check('旧实现第 2 下仍 true（永远锁不上）', b, true);
  check('旧实现从未发过 lock', old.calls.some((c) => c[0] === 'send' && c[2] === 'lock'), false);
}

console.log('\n--- 4. 状态查询接口与启动器联动 ---');
{
  check('main.js 注册 overlay:place-state',
    /ipcMain\.handle\('overlay:place-state',\s*\(\)\s*=>\s*overlayPlacing\)/.test(mainSrc), true);
  check('preload.js 暴露 overlayPlaceState',
    /overlayPlaceState:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('overlay:place-state'\)/.test(preloadSrc), true);
  check('启动器点击不再硬传 true', /window\.api\.overlayPlace\(true\)/.test(consoleSrc), false);
  check('启动器点击改为无参切换', /window\.api\.overlayPlace\(\)/.test(consoleSrc), true);
  check('有 renderPlaceButton 统一改文案', /function renderPlaceButton\(placing\)/.test(consoleSrc), true);
  check('放置中按钮为「锁定位置」', /placing \? '锁定位置'/.test(consoleSrc), true);
  check('锁定后按钮复位为「② 拖到…」', /: '② 拖到我的游戏小地图上'/.test(consoleSrc), true);
  check('锁定后有明确成功提示', /已锁定位置，红圈不会再被拖动/.test(consoleSrc), true);
  check('init 时向主进程同步状态', /syncPlaceButton\(\);/.test(consoleSrc), true);
  check('关闭箭头开关时也同步状态',
    /if \(!on\) \{\s*await syncPlaceButton\(\);\s*return;/.test(consoleSrc), true);
  check('未开启箭头时点击被拦下', /先打开「显示方位箭头」/.test(consoleSrc), true);
}

console.log('\n--- 5. 位置持久化链路未被破坏 ---');
{
  check('overlay 窗口 move 时记录圆心',
    /overlayWin\.on\('move',\s*\(\)\s*=>\s*\{[\s\S]{0,300}settings\.bearing\.x = Math\.round\(b\.x \+ b\.width \/ 2\)/.test(mainSrc), true);
  check('move 后 persist', /overlayWin\.on\('move'[\s\S]{0,320}persist\(\)/.test(mainSrc), true);
  check('overlayBounds 用已保存圆心',
    /settings\.bearing\.x\).*area\.x \+ 260/.test(mainSrc) ||
    /Number\.isFinite\(settings\.bearing\.x\) \? settings\.bearing\.x :/.test(mainSrc), true);
}

console.log('\n--- 6. 源码语法 ---');
{
  const { execFileSync } = require('child_process');
  for (const f of ['src/main.js', 'src/preload.js', 'src/console/console.js', 'src/webview-preload.js']) {
    let ok = true;
    try { execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' }); }
    catch (_) { ok = false; }
    check(`node --check ${f}`, ok, true);
  }
}

console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);

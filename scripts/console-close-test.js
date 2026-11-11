'use strict';

/**
 * 「关闭启动器 → 跟跑视频窗同步关闭」+「双击即提权配置」回归。
 *
 * 复现的 bug：旧 createConsole 的 closed 回调只在「浮窗没开」时 app.quit()，
 * 于是开着跟跑时关启动器，视频窗留在屏幕上、进程也不退出。
 *
 * 纯离线：从 main.js 抠出 createConsole 函数体，注入 mock 窗口执行 closed 回调，
 * 不启动 Electron、不连调试端口、不碰任何设置文件。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(p, 'utf8');
const mainSrc = read(path.join(ROOT, 'src/main.js'));
const html = read(path.join(ROOT, 'src/console/index.html'));
const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));

let pass = 0;
let fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
}

/** 花括号配平提取函数体，避免注释/嵌套对象把函数截断 */
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

/** 用 mock 窗口跑一次 createConsole，返回它的 closed 回调 */
function harness({ withVideo = true, destroyThrows = false } = {}) {
  const calls = [];
  const events = {};
  const mkWindow = (kind) => {
    let dead = false;
    return {
      isDestroyed: () => dead,
      destroy: () => {
        calls.push('destroy:' + kind);
        if (destroyThrows && kind === 'video') throw new Error('simulated destroy failure');
        dead = true;
      }
    };
  };
  const fakeConsoleWin = {
    loadFile: () => {},
    on: (n, cb) => { events[n] = cb; },
    once: () => {},
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: () => {},
    show: () => {},
    focus: () => {}
  };
  const deps = {
    win: withVideo ? mkWindow('video') : null,
    overlayWin: mkWindow('overlay'),
    loginWin: mkWindow('login'),
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    consoleBounds: () => ({ width: 1280, height: 720, x: 0, y: 0 }),
    BrowserWindow: function BrowserWindow() { return fakeConsoleWin; },
    path: { join: (...a) => a.join('/') },
    notifyFloatState: () => {},
    hookHotkeys: { rearm: () => {} },
    app: { quit: () => calls.push('app.quit') },
    process: { platform: 'win32' },
    __dirname: ROOT,
    events,
    calls
  };
  const code = `
    let consoleWin = null;
    let win = deps.win;
    let overlayWin = deps.overlayWin;
    let loginWin = deps.loginWin;
    let quittingFromConsole = false;
    const screen = deps.screen;
    const consoleBounds = deps.consoleBounds;
    const BrowserWindow = deps.BrowserWindow;
    const path = deps.path;
    const notifyFloatState = deps.notifyFloatState;
    const hookHotkeys = deps.hookHotkeys;
    const app = deps.app;
    const process = deps.process;
    const __dirname = deps.__dirname;
    ${grab(mainSrc, 'createConsole')}
    createConsole();
    return {
      closed: deps.events.closed,
      consoleWinNull: () => consoleWin === null,
      quitting: () => quittingFromConsole
    };
  `;
  const state = new Function('deps', code)(deps);
  return { ...state, calls };
}

console.log('--- 1. 开着跟跑时关启动器：三个窗口一起收掉并退出 ---');
{
  const h = harness();
  check('closed 回调已注册', typeof h.closed, 'function');
  h.closed();
  check('销毁跟跑视频窗', h.calls.filter((c) => c === 'destroy:video').length, 1);
  check('销毁方位叠加层', h.calls.filter((c) => c === 'destroy:overlay').length, 1);
  check('销毁登录窗', h.calls.filter((c) => c === 'destroy:login').length, 1);
  check('调用 app.quit()', h.calls.filter((c) => c === 'app.quit').length, 1);
  check('consoleWin 已置空', h.consoleWinNull(), true);
  check('退出标志已置位', h.quitting(), true);
  h.closed();
  check('重复触发不重入（仍只 quit 一次）', h.calls.filter((c) => c === 'app.quit').length, 1);
  check('重复触发不重复销毁视频窗', h.calls.filter((c) => c === 'destroy:video').length, 1);
}

console.log('\n--- 2. 没开跟跑时关启动器：照样完整退出 ---');
{
  const h = harness({ withVideo: false });
  h.closed();
  check('不因 win=null 抛错', h.calls.includes('app.quit'), true);
  check('叠加层仍被收掉', h.calls.includes('destroy:overlay'), true);
  check('登录窗仍被收掉', h.calls.includes('destroy:login'), true);
}

console.log('\n--- 3. 单个窗口销毁失败不阻断其余窗口与退出 ---');
{
  const h = harness({ destroyThrows: true });
  h.closed();
  check('叠加层仍被销毁', h.calls.includes('destroy:overlay'), true);
  check('登录窗仍被销毁', h.calls.includes('destroy:login'), true);
  check('仍调用 app.quit()', h.calls.includes('app.quit'), true);
}

console.log('\n--- 4. 双击即提权的打包配置（两层清单必须同时提权） ---');
{
  check('win.requestedExecutionLevel', pkg.build.win.requestedExecutionLevel, 'requireAdministrator');
  check('portable.requestExecutionLevel', pkg.build.portable.requestExecutionLevel, 'admin');
  check('保留运行时提权兜底接口', mainSrc.includes("ipcMain.handle('app:relaunch-elevated'"), true);
  check('旧的「只在没浮窗时退出」逻辑已移除',
    mainSrc.includes('if (!win || win.isDestroyed()) app.quit();'), false);
}

console.log('\n--- 5. 界面文字删减 ---');
{
  check('左下角提示已删', html.includes('关掉本窗口不影响浮窗'), false);
  check('加权平均那行已删', html.includes('任何加权平均'), false);
}

console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;

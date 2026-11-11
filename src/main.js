'use strict';

/**
 * 原神跟跑助手 —— 主进程
 * 职责：无边框置顶窗口、全局快捷键、B 站视频解析、设置持久化
 */

const { app, BrowserWindow, globalShortcut, ipcMain, powerSaveBlocker, screen, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync, spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const hookHotkeys = require('./hook-hotkeys');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// 允许无用户手势自动播放（浮窗场景必须有）
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// 关掉 Chromium 的「后台进程进效率模式」：Windows 11 会在进程所有窗口都最小化时
// 把它判成后台、套上 EcoQoS（低优先级 + 省电调度）。低级钩子跑在独立线程里，
// 一旦被这样降速，按键回调就会超时、甚至被系统悄悄把钩子摘掉 ——
// 表现正是「启动器在前台时热键好用，一最小化就全废，切回来也回不来」。
app.commandLine.appendSwitch('disable-features', 'UseEcoQoSForBackgroundProcess');

/**
 * 是否以管理员（高完整性级别）身份运行。
 *
 * 这条决定了热键在游戏里能不能用：原神这类带反作弊的游戏一律以管理员启动，
 * 而 Windows 的 UIPI 规定 —— **非提权进程的低级键盘/鼠标钩子，收不到提权窗口在前台时的按键**。
 * 于是现象就是「启动器在前台时热键好用，一切进游戏里就全废」，与代码无关。
 * 这不是我们能绕的系统约束，只能提权运行（打包版清单里已要求管理员）。
 */
let cachedElevated = null;
// 提权重启时带上的标记，用来区分「本来就没提权」和「用户刚拒绝过 UAC」
const ELEVATE_FLAG = '--elevated';
function isElevated() {
  if (cachedElevated !== null) return cachedElevated;
  try {
    // 用 PowerShell 而不是 `whoami /groups`：在 Git Bash / MSYS 里启动时，
    // MSYS 会把 `/groups` 当 POSIX 路径转换成 `C:/Program Files/Git/groups`，
    // whoami 直接报「extra operand」→ 提权状态被误判成 false，白弹一次 UAC。
    const psExe = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    );
    const out = execFileSync(
      psExe,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 }
    );
    // S-1-16-12288 = High Mandatory Level（管理员）；中完整性是 S-1-16-8192
    cachedElevated = out.trim().toLowerCase() === 'true';
  } catch {
    cachedElevated = false;
  }
  return cachedElevated;
}

/* ------------------------------------------------- 按需提权重启（UAC） */

/**
 * 以管理员身份重新启动本程序（兜底路径）。
 *
 * 现在打包版是「双击即提权」，配置在 package.json：
 *   win.requestedExecutionLevel = "requireAdministrator"  → 主 exe 清单
 *   portable.requestExecutionLevel = "admin"              → NSIS 自解压壳清单
 * 两层都提权，双击时 Windows 只弹一次 UAC、壳只解压一次，不必进来再点重启。
 *
 * 历史坑（dist-release3）：只给内层 app.exe 加 requireAdministrator、壳仍是 asInvoker，
 * 壳用 ExecWait 启动 app.exe 时 Windows 返回 ERROR_ELEVATION_REQUIRED(740)，
 * 双击毫无反应、进程都不出现。关键是**壳和主程序必须同时提权**。
 *
 * 运行时重启只留给：开发版（electron.exe 无清单）、zip 解压直跑、UAC 被取消后
 * 仍想用普通权限，以及任何清单没生效的场景。提权是为低级键盘钩子服务的：
 * 不提权的话，UIPI 会挡住提权窗口（原神）在前台时的按键。
 */
function relaunchElevated() {
  return new Promise((resolve) => {
    // portable 版必须用**原始 exe**：process.execPath 指向 %TEMP% 里的解压副本，
    // 从那里重启等于从一个随时会被清掉的目录里启动。
    const exePath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const argv = process.argv
      .slice(1)
      .filter((a) => !a.startsWith('--inspect') && !a.startsWith('--remote-debugging') && a !== ELEVATE_FLAG);
    // 打上标记：万一下次判断提权状态出错，也不会陷入「无限弹 UAC」
    argv.unshift(ELEVATE_FLAG);

    // PowerShell 单引号字符串里，单引号本身写成两个
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    const argList = argv.length ? ` -ArgumentList @(${argv.map(q).join(',')})` : '';
    const script =
      `Start-Process -FilePath ${q(exePath)}${argList}` +
      ` -WorkingDirectory ${q(process.cwd())} -Verb RunAs -ErrorAction Stop`;

    let child;
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
        { windowsHide: true, stdio: 'ignore' }
      );
    } catch (err) {
      resolve({ ok: false, reason: err.message });
      return;
    }
    child.on('error', (err) => resolve({ ok: false, reason: err.message }));
    child.on('exit', (code) => {
      // 退出码 0 = 提权后的新进程已经创建；非 0 基本都是用户在 UAC 上点了「否」
      resolve(code === 0 ? { ok: true } : { ok: false, reason: 'uac-cancelled' });
    });
  });
}

/* ------------------------------- 数据目录：绿色版 / 安装版 [DATA-DIR-START] */

/**
 * 决定 userData 落在哪 —— 两种发行形态必须分流，否则安装版必坏。
 *
 *  绿色版（zip / portable 单 exe）：exe 同级 data\，整夹拷走设置与 ROI 标定一起走。
 *  安装版（NSIS，装到 Program Files）：%APPDATA%\原神跟跑助手\，
 *    因为 Program Files 对普通用户只读，写 settings.json 会直接抛 EPERM。
 *
 * 判定**只看 installed.flag**（由 build/installer.nsh 安装时写在 exe 同级），
 * 不猜安装路径：有人把绿色版放进 Program Files，也有人把安装版装在 D 盘可写目录，
 * 路径都不可靠。zip 里放的是 portable.flag，安装版里没有它，两者不会混淆。
 *
 * 开发时（npm start）一律用系统默认 %APPDATA%，不动用户已有设置和登录态。
 *
 * 两个老坑：
 * 1. portable 单 exe 先解压到 %TEMP% 再运行，process.execPath 指向临时副本，
 *    真实位置 electron-builder 写在 PORTABLE_EXECUTABLE_DIR 里，必须优先用它。
 * 2. 程序目录不可写时退回 APPDATA，否则启动阶段就会因为建不了 settings.json 报错。
 */
const DATA_DIR_NAME = 'data';
const INSTALLED_FLAG = 'installed.flag';
const PORTABLE_FLAG = 'portable.flag';
const MIGRATE_FROM_FILE = 'migrate-from.txt';
const MIGRATED_FLAG = '.migrated';
// settings.json 内含 ROI 标定、窗口位置、观看记录；两张 png 是识别调试截图。
// Chromium 缓存 / GPUCache / 日志一律不搬，避免把几十 MB 垃圾和隐私带进新目录。
const MIGRATE_FILES = ['settings.json', 'bearing-dump.png', 'bearing-frame.png'];
const MIGRATE_LOGIN_DIR = 'Partitions';
const MIGRATE_LOGIN_FILES = ['Local State'];

function programDir() {
  return process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe'));
}

function hasProgramFlag(name) {
  try {
    return fs.existsSync(path.join(programDir(), name));
  } catch {
    return false;
  }
}

function readTextSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** 只复制白名单文件，且绝不覆盖目标里已存在的内容 */
function copyFileIfAbsent(src, dst) {
  if (!fs.existsSync(src) || fs.existsSync(dst)) return false;
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    return true;
  } catch (err) {
    console.warn(`[data] 复制 ${path.basename(src)} 失败：${err.code || err.message}`);
    return false;
  }
}

function copyTreeIfAbsent(srcDir, dstDir) {
  if (!fs.existsSync(srcDir) || fs.existsSync(dstDir)) return;
  try {
    fs.mkdirSync(dstDir, { recursive: true });
    for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const from = path.join(srcDir, ent.name);
      const to = path.join(dstDir, ent.name);
      if (ent.isDirectory()) copyTreeIfAbsent(from, to);
      else if (ent.isFile()) copyFileIfAbsent(from, to);
    }
  } catch (err) {
    console.warn(`[data] 复制目录 ${srcDir} 失败：${err.code || err.message}`);
  }
}

/**
 * 旧绿色版 data\ 的可能位置，按优先级：
 *  1. 安装页「迁移旧数据」填的目录 → 写在 exe 同级 migrate-from.txt 第一行
 *  2. GRB_MIGRATE_FROM 环境变量（手动 / CI 用）
 *  3. exe 同级 data\（把安装版覆盖装到原绿色版目录里的场景）
 * 允许填绿色版根目录或它里面的 data 目录，自动识别。
 */
function legacyDataCandidates(target) {
  const out = [];
  const add = (value) => {
    if (!value) return;
    let dir = path.resolve(String(value).trim().replace(/^"|"$/g, ''));
    if (!fs.existsSync(path.join(dir, 'settings.json')) &&
        fs.existsSync(path.join(dir, DATA_DIR_NAME, 'settings.json'))) {
      dir = path.join(dir, DATA_DIR_NAME);
    }
    if (dir !== path.resolve(target) && !out.includes(dir)) out.push(dir);
  };
  const lines = readTextSafe(path.join(programDir(), MIGRATE_FROM_FILE)).split(/\r?\n/);
  add(lines[0]);
  add(process.env.GRB_MIGRATE_FROM);
  add(path.join(programDir(), DATA_DIR_NAME));
  return out;
}

function migrationIncludeLogin() {
  const text = readTextSafe(path.join(programDir(), MIGRATE_FROM_FILE));
  return /includeLogin\s*=\s*1/.test(text) || process.env.GRB_MIGRATE_LOGIN === '1';
}

/**
 * 安装版首次启动时，把旧绿色版的设置 / ROI 标定搬进 %APPDATA%。
 *
 * 登录态（Partitions + Local State）**默认不搬**：过去「打包前顺手把 Cookie 库
 * 拷进 data\」的教训是，那份带凭证的目录会被整包发出去，等于送账号。
 * 这里方向相反 —— 只在本机、从用户明确指定的旧目录搬进本机 APPDATA，
 * 不进任何发布产物，所以做成安装页上的可选项（includeLogin=1）是安全的。
 * 复制而非移动，旧绿色版仍可照常用；.migrated 标记保证只跑一次。
 */
function migrateLegacyData(target) {
  const marker = path.join(target, MIGRATED_FLAG);
  if (fs.existsSync(marker) || fs.existsSync(path.join(target, 'settings.json'))) {
    return { ok: false, reason: 'already-initialized' };
  }
  const source = legacyDataCandidates(target).find(
    (dir) => fs.existsSync(path.join(dir, 'settings.json'))
  );
  if (!source) return { ok: false, reason: 'no-legacy-data' };

  const withLogin = migrationIncludeLogin();
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch (err) {
    console.warn(`[data] 创建 ${target} 失败：${err.code || err.message}`);
    return { ok: false, reason: 'target-not-writable' };
  }

  let copied = 0;
  for (const name of MIGRATE_FILES) {
    if (copyFileIfAbsent(path.join(source, name), path.join(target, name))) copied++;
  }
  if (withLogin) {
    for (const name of MIGRATE_LOGIN_FILES) {
      if (copyFileIfAbsent(path.join(source, name), path.join(target, name))) copied++;
    }
    copyTreeIfAbsent(path.join(source, MIGRATE_LOGIN_DIR), path.join(target, MIGRATE_LOGIN_DIR));
  }
  try {
    fs.writeFileSync(marker, JSON.stringify({ from: source, at: new Date().toISOString(), withLogin }, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[data] 写迁移标记失败：${err.code || err.message}`);
  }
  console.log(`[data] 已从 ${source} 迁移 ${copied} 项${withLogin ? '（含登录态）' : '（不含登录态）'}`);
  return { ok: true, from: source, copied, withLogin };
}

let installMode = 'dev'; // dev | installed | portable | fallback
function resolveUserDataDir() {
  const fallback = app.getPath('userData');
  if (!app.isPackaged) {
    installMode = 'dev';
    return fallback;
  }

  if (hasProgramFlag(INSTALLED_FLAG)) {
    installMode = 'installed';
    try {
      migrateLegacyData(fallback);
    } catch (err) {
      console.warn(`[data] 旧数据迁移异常，继续用 ${fallback}：${err.message}`);
    }
    try {
      fs.mkdirSync(fallback, { recursive: true });
    } catch {}
    return fallback;
  }

  const dir = path.join(programDir(), DATA_DIR_NAME);
  try {
    fs.mkdirSync(dir, { recursive: true });
    // 探写权限：只判断 exists 不够，目录可能存在但没有写权限
    const probe = path.join(dir, '.write-probe');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    installMode = 'portable';
    return dir;
  } catch (err) {
    console.warn(`[data] 程序目录不可写（${err.code || err.message}），回退到 ${fallback}`);
    installMode = 'fallback';
    return fallback;
  }
}

const USER_DATA_DIR = resolveUserDataDir();
app.setPath('userData', USER_DATA_DIR);
// 缓存类目录一并挪过去，否则 C 盘会多出一份 Chromium 缓存
app.setPath('sessionData', USER_DATA_DIR);
/* [DATA-DIR-END] ---------------------------------------------------------- */


// 支持 `npm start -- --open BV1xx411c7mD`：从命令行/快捷方式直接带视频启动
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  const v = i !== -1 ? process.argv[i + 1] : '';
  return v && !v.startsWith('--') ? v : '';
}
const OPEN_ARG = argValue('--open');

// 播放器与登录窗口共用同一个持久化分区，登录一次全局生效
const BILI_PARTITION = 'persist:bili';

function biliSession() {
  return session.fromPartition(BILI_PARTITION);
}

/** 用该分区的 Cookie 发请求，避开 B 站风控，并且能读到登录态 */
function biliFetch(url, extraHeaders) {
  return biliSession().fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer: 'https://www.bilibili.com/',
      Accept: 'application/json, text/plain, */*',
      ...(extraHeaders || {})
    }
  });
}

const DEFAULT_HOTKEYS = {  togglePlay: 'Alt+Space',
  seekBack: 'Alt+Left',
  seekFwd: 'Alt+Right',
  prevPart: 'Alt+Up',
  nextPart: 'Alt+Down',
  toggleVisible: 'Alt+H',
  togglePass: 'Alt+L',
  toggleOpacity: 'Alt+O'
};

const HOTKEY_META = [
  { key: 'togglePlay', label: '播放 / 暂停' },
  { key: 'seekBack', label: '后退 5 秒' },
  { key: 'seekFwd', label: '前进 5 秒' },
  { key: 'prevPart', label: '上一分 P' },
  { key: 'nextPart', label: '下一分 P' },
  { key: 'toggleVisible', label: '隐藏 / 显示浮窗' },
  { key: 'togglePass', label: '鼠标穿透 开 / 关' },
  { key: 'toggleOpacity', label: '半透明 开 / 关' }
];

/**
 * 出厂预置的识别区域 —— 只用来定「第一次框选时金色圆环的起始位置」，不写进 rois。
 *
 * 这里踩过一个坑：早先把两个猜的坐标直接塞进 DEFAULT_SETTINGS.bearing.rois，
 * 而保存逻辑是「位置接近就替换、否则追加」。用户框一次，猜错的那条留在列表里，
 * 面板上就显示「已标定 2 处」，其中一处压根没对准小地图 —— 这就是
 * 「框选一次出两次标定」的根因。现在出厂列表为空，下面这个值只影响圆环初值。
 *
 * 数值来自实测对准的原生迷你地图 / 博主放大贴片布局。
 */
const SEED_ROI = { cx: 0.1434, cy: 0.2481, r: 0.1542 };

/** 0.2.3 及更早版本写进出厂列表的猜测值，装载设置时精确剔除（容差 1e-4，不会误伤真实标定） */
const LEGACY_SEED_ROIS = [
  { cx: 0.0875, cy: 0.122, r: 0.046 },
  { cx: 0.148, cy: 0.222, r: 0.163 }
];

/** 剔除历史遗留的出厂猜测值；顺手丢掉结构不合法的条目 */
function dropLegacySeeds(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(
    (r) =>
      r &&
      Number.isFinite(r.cx) &&
      Number.isFinite(r.cy) &&
      Number.isFinite(r.r) &&
      !LEGACY_SEED_ROIS.some(
        (s) =>
          Math.abs(s.cx - r.cx) < 1e-4 &&
          Math.abs(s.cy - r.cy) < 1e-4 &&
          Math.abs(s.r - r.r) < 1e-4
      )
  );
}

const DEFAULT_SETTINGS = {
  // 内容区 896×504 正好 16:9，加上标题栏 30 + 控制条 34 = 604
  bounds: { width: 896, height: 568, x: null, y: null, aspect: 2 },
  pinned: true,
  opacity: 1,
  clickThrough: false,
  mode: 'web',
  volume: 100,
  muxed: false,
  lastText: '',
  lastPart: 1,
  // 「上次看到」：光有 lastText/lastPart 不够 —— 用户记不住的是「哪个视频、第几 P」，
  // 长链接/BV 号看不出片名，所以额外存标题、视频 id、分 P 总数和最后观看时间。
  lastTitle: '',
  lastVideoId: '',
  lastPageCount: 0,
  lastWatchedAt: 0,
  // 下次启动直接把浮窗起来继续播，不用每次重粘链接
  resumeOnLaunch: true,
  hotkeys: { ...DEFAULT_HOTKEYS },
  bearing: {
    enabled: false,
    /**
     * 识别区域列表：{ cx, cy, r }，cx/cy 按画面宽高归一、r 按画面宽度归一。
     * 一个视频里布局会变（原生迷你地图 / 剪辑放大的地图贴片），所以要存多块。
     *
     * 出厂**必须为空**：预置猜测值会被算成「已经标定过」，用户框一次就变两处。
     * 圆环初值走 SEED_ROI，未标定时界面也会主动引导去框一次。
     */
    rois: [],
    // 用户是否在画面上真正框过一次；没框过就先引导标定，不拿默认值硬猜
    calibrated: false,
    // 按视频记住标定结果
    roiBy: {},
    // 叠加层：圆环半径（屏幕像素）与圆心屏幕坐标
    radius: 110,
    x: null,
    y: null
  }
};

/**
 * 记住「上次看到」。换片和切 P 都走这里，字段一次写全。
 * 抽成纯函数是为了能离线回归（只就地改传入对象，不碰 fs / Electron）。
 */
/** 启动时是否自动把浮窗起来继续播（纯函数，便于离线回归） */
function shouldResumeOnLaunch(s, openArg) {
  if (openArg) return false; // --open 显式指定了视频，别抢
  return !!(s && s.resumeOnLaunch !== false && s.lastText);
}

function noteWatched(s, info) {
  if (!s) return s;
  const text = String(info.text || '').trim();
  if (text) s.lastText = text;
  const p = Number(info.p);
  if (Number.isFinite(p) && p > 0) s.lastPart = Math.floor(p);
  if (info.id) s.lastVideoId = String(info.id);
  if (info.title !== undefined) s.lastTitle = String(info.title || '');
  if (info.pageCount !== undefined) {
    const n = Number(info.pageCount);
    s.lastPageCount = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }
  s.lastWatchedAt = Date.now();
  return s;
}

let settings = structuredClone(DEFAULT_SETTINGS);
let win = null;         // 跟跑浮窗（无边框置顶，只管播放）
let consoleWin = null;  // 启动器（所有设置都在这里）
let loginWin = null;
let quittingFromConsole = false; // 关启动器 = 退出整个应用，防止 closed 事件重入
let failedHotkeys = [];
let saveTimer = null;
// 渲染层上报的输入状态：打字时不该触发单键热键，但「窗口在前台」不等于在打字
let typingInField = false;
let capturingHotkey = false;

/* ------------------------------------------------------------------ 设置 */

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    const rawBearing = raw.bearing || {};

    // 迁移：剔除 0.2.3 及更早版本写进出厂列表的猜测区域。
    // 那两条会被当成「已标定」，用户框一次就变成两处标定，先清干净再谈别的。
    const rois = dropLegacySeeds(rawBearing.rois);
    const roiBy = {};
    for (const [id, list] of Object.entries(rawBearing.roiBy || {})) {
      const kept = dropLegacySeeds(list);
      if (kept.length) roiBy[id] = kept;
    }

    settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      ...raw,
      bounds: { ...DEFAULT_SETTINGS.bounds, ...(raw.bounds || {}) },
      hotkeys: { ...DEFAULT_HOTKEYS, ...(raw.hotkeys || {}) },
      bearing: {
        ...DEFAULT_SETTINGS.bearing,
        ...rawBearing,
        rois,
        roiBy,
        // 清完一条不剩，就别再标榜「已标定」，否则界面显示 0 处却不去引导框选
        calibrated: !!rawBearing.calibrated && rois.length > 0
      }
    };
  } catch {
    settings = structuredClone(DEFAULT_SETTINGS);
  }
}

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
      fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), 'utf8');
    } catch (err) {
      console.error('[settings] 写入失败', err);
    }
  }, 250);
}

/* ------------------------------------------------------------------ 窗口 */

function clampBounds(b) {
  let width = Math.max(240, Math.round(b.width || 896));
  let height = Math.max(150, Math.round(b.height || 568));

  // 老配置是 540×340（2:1 扁条，画面上下被压得只剩一条）。只做一次性纠正，
  // 之后用户自己拉伸的任意比例都尊重，不再干预。
  if (b.aspect !== 2 && width < 720) {
    const maxW = Math.round(screen.getPrimaryDisplay().workArea.width * 0.8);
    width = Math.min(896, maxW);
    height = Math.round((width / 16) * 9) + 64; // 标题栏 30 + 控制条 34
  }

  const area = screen.getPrimaryDisplay().workArea;
  let x = Number.isFinite(b.x) ? Math.round(b.x) : area.x + area.width - width - 40;
  let y = Number.isFinite(b.y) ? Math.round(b.y) : area.y + 60;

  // 窗口变宽后可能顶出屏幕右边（老配置是贴着右边缘摆的），拉回来。
  // 用窗口所在的那块屏，别把它从副屏拽回主屏。
  const near = screen.getDisplayNearestPoint({ x, y }).workArea;
  if (x + width > near.x + near.width - 8) x = Math.max(near.x + 8, near.x + near.width - width - 40);

  // 保证窗口至少有一部分落在某个屏幕上
  const visible = screen.getAllDisplays().some((d) => {
    const w = d.workArea;
    return x + width > w.x + 40 && x < w.x + w.width - 40 && y + height > w.y && y < w.y + w.height - 40;
  });
  if (!visible) {
    x = area.x + area.width - width - 40;
    y = area.y + 60;
  }
  return { x, y, width, height };
}

function applyPin() {
  if (!win || win.isDestroyed()) return;
  if (settings.pinned) {
    // screen-saver 层级：在 Windows 上能压住绝大多数全屏/无边框窗口
    win.setAlwaysOnTop(true, 'screen-saver');
    try {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch {
      /* 平台不支持则忽略 */
    }
  } else {
    win.setAlwaysOnTop(false);
  }
}

function createWindow() {
  // 浮窗可以被关掉再重新启动，这里做成幂等
  if (win && !win.isDestroyed()) {
    win.showInactive();
    applyPin();
    return win;
  }

  const bounds = clampBounds(settings.bounds);
  // 老的扁条尺寸被纠正过一次就记下来，之后用户自己拉成什么比例都不再干预
  if (settings.bounds.aspect !== 2) {
    settings.bounds = { ...bounds, aspect: 2 };
    persist();
  }

  win = new BrowserWindow({
    ...bounds,
    minWidth: 240,
    minHeight: 150,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0d0e12',
    show: false,
    resizable: true,
    maximizable: false,
    minimizable: true,
    fullscreenable: true,
    hasShadow: true,
    alwaysOnTop: settings.pinned,
    title: '原神跟跑助手',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      spellcheck: false,
      backgroundThrottling: false
    }
  });

  applyPin();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // webview 里的 <video> 一旦走 HTML 全屏，它会铺满整个客户区并盖住我们自己的
  // 标题栏和设置按钮 —— 这是「视频全屏后找不到设置」的根因。直接禁掉，
  // 让 B 站播放器的全屏按钮改走窗口全屏（见 webview-preload 里的 requestFullscreen 改写）。
  win.webContents.on('will-attach-webview', (_e, prefs) => {
    prefs.disableHtmlFullscreen = true;
  });

  // 全屏状态回传给渲染页，用来切换「标题栏/控制条浮层化」
  const sendFullscreen = (on) => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('win:state', { fullscreen: on });
  };
  win.on('enter-full-screen', () => sendFullscreen(true));
  win.on('leave-full-screen', () => sendFullscreen(false));

  win.once('ready-to-show', () => {
    win.showInactive(); // 不抢游戏焦点
    if (settings.opacity < 1) win.setOpacity(settings.opacity);
    if (settings.clickThrough) win.setIgnoreMouseEvents(true, { forward: true });
    notifyFloatState();
  });

  // 窗口失焦后重新压制层级（某些窗口会抢到上面）
  win.on('blur', () => applyPin());

  const rememberBounds = () => {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    // 保留 aspect 标记：用户手动拉过之后就不该在下次启动时被强行改回 16:9
    settings.bounds = { ...settings.bounds, x: b.x, y: b.y, width: b.width, height: b.height, aspect: 2 };
    persist();
  };
  win.on('move', rememberBounds);
  win.on('resize', rememberBounds);

  win.on('closed', () => {
    win = null;
    // 主窗关了，叠加层不能独自留下，否则 window-all-closed 不触发、进程退不掉
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.destroy();
    notifyFloatState();
  });
}

/* ---------------------------------------------------------------- 启动器 */

function sendTo(w, channel, payload) {
  if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
}

/** 广播给所有界面窗口：设置改了，两边都要跟上 */
function broadcast(channel, payload) {
  sendTo(win, channel, payload);
  sendTo(consoleWin, channel, payload);
}

function notifyFloatState() {
  sendTo(consoleWin, 'float:state', { running: !!(win && !win.isDestroyed()) });
}

/** 启动器窗口：16:9、居中、按工作区留边等比缩放（小屏/125% 缩放也不出界） */
function consoleBounds(work) {
  const maxW = Math.max(800, work.width - 80);
  const maxH = Math.max(450, work.height - 70);
  let width = Math.min(1280, maxW);
  let height = Math.round((width * 9) / 16);
  if (height > maxH) {
    height = maxH;
    width = Math.round((height * 16) / 9);
  }
  width = Math.round(width);
  height = Math.round(height);
  return {
    width,
    height,
    x: Math.round(work.x + (work.width - width) / 2),
    y: Math.round(work.y + (work.height - height) / 2)
  };
}

function createConsole() {
  if (consoleWin && !consoleWin.isDestroyed()) {
    if (consoleWin.isMinimized()) consoleWin.restore();
    consoleWin.show();
    consoleWin.focus();
    return consoleWin;
  }

  // 首次打开固定 16:9（1280×720 基准），屏幕放不下时等比缩，并居中显示
  const work = screen.getPrimaryDisplay().workArea;
  const box = consoleBounds(work);

  consoleWin = new BrowserWindow({
    width: box.width,
    height: box.height,
    x: box.x,
    y: box.y,
    minWidth: 800,
    minHeight: 450,
    title: '原神跟跑助手 · 启动器',
    backgroundColor: '#1e1e1e',
    autoHideMenuBar: true,
    // Windows 原生标题栏在浅色系统主题下是一条白条，会和我们自绘的 40px 深色
    // TitleBar 叠成两层。用 Window Controls Overlay 把网页内容延伸到窗口顶部，
    // 最小化/最大化/关闭三个系统按钮浮在深色顶栏右上角（VS Code / Wpf.Ui 同款）。
    // 对应 console.css 里 .topbar 的右侧留白与拖动区域；仅 Windows 有效。
    ...(process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden',
          titleBarOverlay: { color: '#1e1e1e', symbolColor: '#e6e6e6', height: 40 }
        }
      : {}),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  consoleWin.loadFile(path.join(__dirname, 'console', 'index.html'));

  // 最小化/恢复都补挂一次钩子。Windows 对低级钩子有「钩子过程超时就被静默摘掉」的
  // 规矩，而窗口最小化恰恰会让主进程忙上一阵（窗口销毁、合成器重排），
  // 正好是钩子最容易被打掉的时候；最小化后 1 秒补一次，切回前台再补一次，
  // 用户不必为了热键失灵去重启程序。
  consoleWin.on('minimize', () => setTimeout(() => hookHotkeys.rearm(), 1000));
  consoleWin.on('restore', () => hookHotkeys.rearm());

  consoleWin.once('ready-to-show', () => {
    consoleWin.show();
    notifyFloatState();
  });

  consoleWin.on('closed', () => {
    consoleWin = null;
    // 关启动器就是退出整个应用：跟跑视频窗、方位叠加层、登录窗一起收掉。
    // 旧逻辑只在「浮窗没开」时 quit，于是开着跟跑时关启动器，视频窗会留在
    // 屏幕上、进程也不退出，用户还得再去任务栏手动关一次。
    if (quittingFromConsole) return;
    quittingFromConsole = true;
    for (const w of [win, overlayWin, loginWin]) {
      try {
        if (w && !w.isDestroyed()) w.destroy();
      } catch (err) {
        console.warn('[quit] 关闭窗口失败：', err.message);
      }
    }
    app.quit();
  });

  return consoleWin;
}

// 强力置顶：层级被抢时自动恢复
setInterval(() => {
  if (!win || win.isDestroyed() || !settings.pinned) return;
  if (!win.isAlwaysOnTop()) applyPin();
}, 2500);

/* ------------------------------------------------------- 方位标记叠加层 */

let overlayWin = null;
let overlayPlacing = false;
let lastBearing = null;

function overlaySize() {
  // 半径 ×2 再留 12% 余量，箭头尖端才不会贴到窗口边被裁掉
  return Math.round(Math.max(60, Number(settings.bearing.radius) || 110) * 2.24);
}

function overlayBounds() {
  const size = overlaySize();
  const area = screen.getPrimaryDisplay().workArea;
  const cx = Number.isFinite(settings.bearing.x) ? settings.bearing.x : area.x + 260;
  const cy = Number.isFinite(settings.bearing.y) ? settings.bearing.y : area.y + 260;
  return {
    x: Math.round(cx - size / 2),
    y: Math.round(cy - size / 2),
    width: size,
    height: size
  };
}

function createOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;

  overlayWin = new BrowserWindow({
    ...overlayBounds(),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'overlay', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setIgnoreMouseEvents(true, { forward: true });

  // 拖动后记住圆心，下次启动原地复活
  overlayWin.on('move', () => {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    const b = overlayWin.getBounds();
    settings.bearing.x = Math.round(b.x + b.width / 2);
    settings.bearing.y = Math.round(b.y + b.height / 2);
    persist();
  });

  overlayWin.on('closed', () => {
    overlayWin = null;
  });

  overlayWin.loadFile(path.join(__dirname, 'overlay', 'index.html'));

  overlayWin.webContents.on('did-finish-load', () => {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    overlayWin.webContents.send('mode', overlayPlacing ? 'place' : 'lock');
    if (lastBearing) overlayWin.webContents.send('bearing', lastBearing);
  });

  return overlayWin;
}

function showOverlay() {
  const w = createOverlay();
  if (w.isVisible()) return w;

  if (w.webContents.isLoading()) {
    w.once('ready-to-show', () => {
      if (!w.isDestroyed()) w.showInactive();
    });
  } else {
    w.showInactive();
  }
  return w;
}

function setOverlayPlacing(placing) {
  // 不传参数 = 按当前状态切换。主进程是唯一真相源：以前启动器每次都硬传
  // true，第二下点「锁定位置」又进了一次放置模式，红圈永远锁不上。
  // 显式传 true/false 仍然保留，供热键等需要幂等设置的调用方使用。
  overlayPlacing = placing === undefined || placing === null ? !overlayPlacing : !!placing;
  const w = showOverlay();

  if (overlayPlacing) {
    w.setIgnoreMouseEvents(false);
    w.setFocusable(true);
    w.showInactive();
  } else {
    w.setIgnoreMouseEvents(true, { forward: true });
    w.setFocusable(false);
  }

  if (!w.webContents.isLoading()) w.webContents.send('mode', overlayPlacing ? 'place' : 'lock');
  return overlayPlacing;
}

function setBearingEnabled(on) {
  settings.bearing.enabled = !!on;

  if (on) {
    showOverlay();
  } else {
    overlayPlacing = false;
    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.setIgnoreMouseEvents(true, { forward: true });
      overlayWin.setFocusable(false);
      overlayWin.hide();
    }
    lastBearing = null;
  }

  if (win && !win.isDestroyed()) win.webContents.send('bearing:state', settings.bearing);
  persist();
  return settings.bearing;
}

function setOverlayRadius(r) {
  settings.bearing.radius = Math.min(400, Math.max(50, Math.round(Number(r) || 110)));
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.setBounds(overlayBounds());
  }
  persist();
  return settings.bearing.radius;
}

/* -------------------------------------------------------------- 全局热键 */

function sendPlayerAction(action) {
  // 浮窗没起来时热键也要有反应：否则用户在启动器里按键，什么都不发生
  if (!win || win.isDestroyed()) {
    createWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.once('did-finish-load', () => {
        if (win && !win.isDestroyed()) win.webContents.send('hotkey', action);
      });
    }
    return;
  }
  win.webContents.send('hotkey', action);
}

/** 热键动作的唯一入口：键盘加速器和鼠标侧键都走这里 */
function handleHotkey(key) {
  if (key === 'toggleVisible') return toggleVisible();
  if (key === 'togglePass') return setPass(!settings.clickThrough);
  if (key === 'toggleOpacity') return setOpacity(settings.opacity > 0.95 ? 0.65 : 1);
  sendPlayerAction(key);
}

function toggleVisible() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) {
    win.hide();
  } else {
    win.showInactive();
    applyPin();
  }
}

function setPass(on) {
  settings.clickThrough = !!on;
  if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!!on, { forward: true });
  persist();
  if (win && !win.isDestroyed()) win.webContents.send('win:state', { clickThrough: settings.clickThrough });
}

function setOpacity(v) {
  settings.opacity = Math.min(1, Math.max(0.3, Number(v) || 1));
  if (win && !win.isDestroyed()) win.setOpacity(settings.opacity);
  persist();
  if (win && !win.isDestroyed()) win.webContents.send('win:state', { opacity: settings.opacity });
}

function registerHotkeys() {
  globalShortcut.unregisterAll();
  failedHotkeys = [];

  for (const { key } of HOTKEY_META) {
    const acc = settings.hotkeys[key];
    if (!acc) continue;
    // 鼠标侧键和单键不进 globalShortcut：前者不支持，后者会把键全局吞掉。
    // 这两类统一交给低级钩子被动监听。
    if (hookHotkeys.isHookAccelerator(acc)) continue;

    let ok = false;
    try {
      ok = globalShortcut.register(acc, () => handleHotkey(key));
    } catch {
      ok = false;
    }
    if (!ok) failedHotkeys.push({ key, accelerator: acc });
  }

  // 钩子类绑定：不可用时要把涉及的动作全部标为失败，界面才解释得清
  const hookState = hookHotkeys.apply(
    settings.hotkeys,
    handleHotkey,
    /**
     * 什么时候不响应单键/侧键。
     *
     * 原来这里是「自己的任一窗口在前台就全部忽略」，代价太大：浮窗本身就是
     * 置顶播放器，用户点一下它、或者刚在启动器里配完热键就按 J 试试，
     * 都会被判成「在自己的窗口里」，表现得就像热键彻底没接上。
     *
     * 现在只挡两种确实会打架的情形：正在输入框里打字、正在录制新键位。
     * 登录窗例外：那里面一定要能正常输入账号密码。
     */
    () => {
      if (capturingHotkey) return true;
      if (typingInField) return true;
      const focused = BrowserWindow.getFocusedWindow();
      return !!focused && focused === loginWin;
    }
  );

  if (hookState.needed && !hookState.ok) {
    for (const { key } of HOTKEY_META) {
      const acc = settings.hotkeys[key];
      if (hookHotkeys.isHookAccelerator(acc)) failedHotkeys.push({ key, accelerator: acc, hook: true });
    }
  }
  for (const acc of hookState.keys) {
    const hit = HOTKEY_META.find((m) => settings.hotkeys[m.key] === acc);
    if (hit) failedHotkeys.push({ key: hit.key, accelerator: acc, unsupported: true });
  }

  if (failedHotkeys.length) {
    console.warn('[hotkeys] 注册失败（可能被其他程序占用）:', failedHotkeys);
  }
  return failedHotkeys;
}

/* ------------------------------------------------------------ B 站解析 */

async function followRedirect(url) {
  try {
    const res = await biliFetch(url, { Accept: 'text/html' });
    try {
      await res.arrayBuffer();
    } catch {
      /* ignore */
    }
    return res.url || url;
  } catch {
    return url;
  }
}

function extractId(text) {
  const s = String(text || '').trim();
  let m = s.match(/(BV[0-9A-Za-z]{10})/);
  if (m) return 'BV' + m[0].slice(2);
  m = s.match(/[?&/]av(\d+)/i) || s.match(/^av(\d+)$/i);
  if (m) return 'av' + m[1];
  return null;
}

async function resolveInput(text) {
  let s = String(text || '').trim();
  if (!s) return { ok: false, message: '请输入视频链接或 BV 号' };

  if (/b23\.tv|bili2233\.cn/i.test(s)) {
    const direct = s.match(/https?:\/\/\S+/i);
    if (direct) s = await followRedirect(direct[0]);
  }

  const id = extractId(s);
  if (!id) return { ok: false, message: '没认出 BV 号，请粘贴完整视频链接' };

  const pm = s.match(/[?&](?:p|page)=(\d+)/i);
  return { ok: true, id, p: pm ? Number(pm[1]) : 1 };
}

async function fetchVideoInfo(id) {
  const q = id.startsWith('av') ? `aid=${id.slice(2)}` : `bvid=${id}`;
  try {
    const res = await biliFetch(`https://api.bilibili.com/x/web-interface/view?${q}`);
    const json = await res.json();
    if (json.code !== 0) return { ok: false, message: json.message || `接口返回 ${json.code}` };
    const d = json.data || {};
    return {
      ok: true,
      id: d.bvid || id,
      title: d.title || '',
      owner: d.owner ? d.owner.name : '',
      pages: (d.pages || []).map((p) => ({ page: p.page, part: p.part, duration: p.duration }))
    };
  } catch (err) {
    return { ok: false, message: '读取视频信息失败：' + err.message };
  }
}

/** 查询登录态：未登录只能看预览/低清晰度，登录后才是完整视频 */
async function fetchNav() {
  try {
    const res = await biliFetch('https://api.bilibili.com/x/web-interface/nav');
    const json = await res.json();
    const d = json.data || {};
    return {
      ok: true,
      loggedIn: !!d.isLogin,
      uname: d.uname || '',
      mid: d.mid || 0,
      vip: d.vipStatus === 1,
      level: d.level_info ? d.level_info.current_level : 0
    };
  } catch (err) {
    return { ok: false, loggedIn: false, uname: '', message: err.message };
  }
}

/** 只用 www.bilibili.com 视频页：站外嵌入播放器（player.bilibili.com）无论如何都上不了高清 */
function buildUrl(id, p) {
  const page = Math.max(1, Number(p) || 1);
  const key = id.startsWith('av') ? `av${id.slice(2)}` : id;
  return `https://www.bilibili.com/video/${key}/?p=${page}&autoplay=1`;
}

/* ---------------------------------------------------------------- 登录 */

function openLogin() {
  if (loginWin && !loginWin.isDestroyed()) {
    loginWin.show();
    loginWin.focus();
    return;
  }

  loginWin = new BrowserWindow({
    width: 480,
    height: 720,
    title: '登录 B 站',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    alwaysOnTop: true, // 别被置顶浮窗挡住
    webPreferences: {
      partition: BILI_PARTITION,
      sandbox: true,
      spellcheck: false
    }
  });

  loginWin.loadURL('https://passport.bilibili.com/login');

  // 轮询登录态：扫码成功即刻关窗并通知渲染进程刷新播放器
  // 2 秒一次、最多 5 分钟，避免长时间挂着触发 B 站风控（-412）
  let polls = 0;
  const timer = setInterval(async () => {
    polls += 1;
    if (!loginWin || loginWin.isDestroyed() || polls > 150) {
      clearInterval(timer);
      return;
    }
    const nav = await fetchNav();
    if (!nav.loggedIn) return;

    clearInterval(timer);
    console.log('[bili] 登录成功：', nav.uname, nav.vip ? '(大会员)' : '');
    if (win && !win.isDestroyed()) win.webContents.send('login:state', nav);
    if (loginWin && !loginWin.isDestroyed()) loginWin.close();
  }, 2000);

  loginWin.on('closed', () => {
    clearInterval(timer);
    loginWin = null;
    if (win && !win.isDestroyed()) win.webContents.send('login:state', null);
  });
}

/* ---------------------------------------------------------------- IPC */

function registerIpc() {
  ipcMain.handle('app:boot', async () => {
    const nav = await fetchNav();
    console.log(
      '[bili] 登录态：',
      nav.loggedIn ? `已登录 ${nav.uname}${nav.vip ? '（大会员）' : ''}` : '未登录',
      nav.ok ? '' : `接口异常 ${nav.message || ''}`
    );
    return {
      settings,
      hotkeys: HOTKEY_META,
      failedHotkeys,
      initialUrl: OPEN_ARG,
      nav,
      // 框选圆环的出厂初值。**不进标定列表**，只用来决定第一次打开标定时圆环落在哪，
      // 免得一打开就偏到画面外、用户点「完成」直接存下一个错区域。
      seedRoi: SEED_ROI,
      webviewPreload: pathToFileURL(path.join(__dirname, 'webview-preload.js')).href,
      version: app.getVersion(),
      // 界面要能一眼看出「单键/侧键的全局钩子到底起来了没有」，
      // 否则热键不响应时只能靠猜
      hookRunning: hookHotkeys.isRunning(),
      // 没提权时游戏内热键必然收不到（UIPI），界面要直说，别让用户怀疑程序坏了
      elevated: isElevated(),
      // 让启动器能显示「设置和登录态存在哪」，绿色版就是 exe 同级的 data\
      dataDir: app.getPath('userData'),
      portable: installMode === 'portable',
      installMode
    };
  });

  ipcMain.handle('bili:nav', () => fetchNav());

  /* ---- 提权重启：游戏内热键要管理员身份才行（UIPI），由用户按需触发 ---- */
  ipcMain.handle('app:relaunch-elevated', async () => {
    if (isElevated()) return { ok: false, reason: 'already-elevated' };
    // 先让出单实例锁：提权后的新进程启动时会申请它。不让出的话新进程会立刻自杀，
    // 而这边也已经退出 —— 用户看到的现象就是「点了按钮，程序直接消失」。
    const hadLock = app.hasSingleInstanceLock();
    if (hadLock) app.releaseSingleInstanceLock();
    const result = await relaunchElevated();
    // UAC 被取消：把锁要回来，继续以普通权限运行
    if (!result.ok && hadLock) app.requestSingleInstanceLock();
    if (result.ok) setTimeout(() => app.exit(0), 400);
    return result;
  });

  /* ---- 输入状态：决定单键热键要不要让路 ---- */

  ipcMain.on('ui:typing', (_e, on) => {
    typingInField = !!on;
  });
  ipcMain.on('ui:capture', (_e, on) => {
    capturingHotkey = !!on;
  });

  /* ---- 方位标记：视频侧只上报一个角度，主进程转发给叠加窗 ---- */

  ipcMain.on('overlay:bearing', (_e, payload) => {
    lastBearing = payload;
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send('bearing', payload);
  });

  ipcMain.handle('overlay:enable', (_e, on) => setBearingEnabled(on));
  ipcMain.handle('overlay:place', (_e, on) => setOverlayPlacing(on));
  // 启动器重建 / 箭头开关切换后，用它把按钮文案对齐到主进程的真实状态
  ipcMain.handle('overlay:place-state', () => overlayPlacing);
  ipcMain.handle('overlay:radius', (_e, r) => setOverlayRadius(r));

  // 调试：把访客抓到的识别区域落盘，用来肉眼确认 ROI 有没有对准小地图
  ipcMain.handle('overlay:dump-save', (_e, payload = {}) => {
    const dir = app.getPath('userData');
    const b64 = String(payload.dataUrl || '').split(',')[1] || '';
    if (!b64) return { ok: false, file: '' };

    const file = path.join(dir, 'bearing-dump.png');
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));

    // 整帧 + 红框图：用来肉眼判断识别区域有没有落在小地图上
    const fb64 = String(payload.frame || '').split(',')[1] || '';
    const frameFile = path.join(dir, 'bearing-frame.png');
    if (fb64) fs.writeFileSync(frameFile, Buffer.from(fb64, 'base64'));

    const rois = Array.isArray(payload.rois) ? payload.rois : [];
    const roiText = rois
      .map((r) => `(${r.cx.toFixed(3)}, ${r.cy.toFixed(3)}) r=${r.r.toFixed(3)}`)
      .join(' | ');

    console.log(
      '[bearing] 识别区域已导出',
      `${payload.size}px`,
      `视频 ${payload.vw}×${payload.vh}`,
      `${rois.length} 处：${roiText || '无'}`,
      `不透明 ${payload.opaque}/${payload.total}`,
      `→ ${frameFile}`
    );
    return { ok: true, file, frameFile: fb64 ? frameFile : '', dir, size: payload.size };
  });

  // 导出后让用户在资源管理器里直接看到，不用自己翻 AppData
  ipcMain.handle('overlay:reveal-dump', () => {
    const dir = app.getPath('userData');
    const frame = path.join(dir, 'bearing-frame.png');
    if (fs.existsSync(frame)) shell.showItemInFolder(frame);
    else shell.openPath(dir);
    return dir;
  });

  ipcMain.handle('settings:save', (_e, patch = {}) => {
    // 自动连播 / 手动切 P 只带 lastPart：页码和时间要一起刷新，
    // 否则启动器上的「上次看到」会一直停在第一次打开视频那一刻。
    if (patch.lastText !== undefined || patch.lastPart !== undefined) {
      noteWatched(settings, {
        ...(patch.lastText !== undefined ? { text: patch.lastText } : {}),
        ...(patch.lastPart !== undefined ? { p: patch.lastPart } : {})
      });
    }
    // 这个开关本身不是「观看记录」，别顺手刷新 lastWatchedAt
    if (patch.resumeOnLaunch !== undefined) settings.resumeOnLaunch = !!patch.resumeOnLaunch;
    if (patch.pinned !== undefined) {
      settings.pinned = !!patch.pinned;
      applyPin();
    }
    if (patch.clickThrough !== undefined) setPass(patch.clickThrough);
    if (patch.opacity !== undefined) setOpacity(patch.opacity);
    if (patch.hotkeys) settings.hotkeys = { ...settings.hotkeys, ...patch.hotkeys };
    if (patch.bearing) {
      const b = patch.bearing;
      if (b.calibrated !== undefined) settings.bearing.calibrated = !!b.calibrated;

      if (Array.isArray(b.rois)) {
        const rois = dropLegacySeeds(b.rois).slice(0, 4);
        settings.bearing.rois = rois;
        if (b.videoId) {
          // 清空时必须把这个视频的专属记录一起删掉。以前只清全局 rois，
          // roiBy 里还留着 —— 看着「清除本视频标定」成功了，重载视频又回来了，
          // 因为取区域时优先读 roiBy。
          if (rois.length) settings.bearing.roiBy[b.videoId] = rois;
          else delete settings.bearing.roiBy[b.videoId];
        }
      }
    }
    persist();
    broadcast('settings:changed', settings);
    return settings;
  });

  ipcMain.handle('hotkeys:update', (_e, next = {}) => {
    const valid = {};
    for (const [k, v] of Object.entries(next)) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_HOTKEYS, k) && typeof v === 'string' && v.trim()) {
        valid[k] = v.trim();
      }
    }

    const prev = { ...settings.hotkeys };
    const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

    // 冲突处理：新键已被别的动作占用时，把两者**互换**。
    // 以前是直接覆盖，导致对方注册失败、悄悄丢了键位 —— 用户看到的就是「改了没反应」。
    const swaps = [];
    for (const [k, v] of Object.entries(valid)) {
      for (const [other, acc] of Object.entries(prev)) {
        if (other === k || !same(acc, v)) continue;
        swaps.push({ target: k, partner: other, partnerAcc: prev[k] });
      }
    }

    settings.hotkeys = { ...prev, ...valid };
    for (const s of swaps) settings.hotkeys[s.partner] = s.partnerAcc;

    let failed = registerHotkeys();

    // 新键注册不上（被系统或其他程序占用）→ 把这一项回滚到旧键。
    // 关键：不能让它「新键没成、旧键也没了」，那等于改一次少一个热键。
    const rejected = Object.keys(valid).filter((k) => failed.some((f) => f.key === k));
    if (rejected.length) {
      for (const k of rejected) {
        settings.hotkeys[k] = prev[k];
        // 因为互换被改动过对家，也要一起还原
        const s = swaps.find((x) => x.target === k);
        if (s) settings.hotkeys[s.partner] = prev[s.partner];
      }
      failed = registerHotkeys();
    }

    persist();
    return {
      hotkeys: settings.hotkeys,
      failed,
      rejected,
      swapped: swaps.map((s) => s.partner),
      hookRunning: hookHotkeys.isRunning()
    };
  });

  ipcMain.handle('hotkeys:reset', () => {
    settings.hotkeys = { ...DEFAULT_HOTKEYS };
    const failed = registerHotkeys();
    persist();
    return { hotkeys: settings.hotkeys, failed, hookRunning: hookHotkeys.isRunning() };
  });

  ipcMain.handle('win:action', (_e, action, payload) => {
    // 下面这几个动作主要由启动器发起，而启动器点它们的时候浮窗往往还没起，
    // 所以必须放在「浮窗存在」的守卫之前；否则按钮点了没有任何反应。
    switch (action) {
      case 'start-float':
        createWindow();
        return true;
      case 'stop-float':
        if (win && !win.isDestroyed()) win.close();
        return true;
      case 'open-console':
        createConsole();
        return true;
      case 'open-data':
        shell.openPath(app.getPath('userData'));
        return true;
      case 'calib':
        // 框选要看着视频拖圆环，只能在浮窗里做 —— 这里负责把它叫起来
        if (!win || win.isDestroyed()) createWindow();
        sendTo(win, 'float:cmd', { cmd: 'calib' });
        return true;
      case 'dump':
        if (win && !win.isDestroyed()) sendTo(win, 'float:cmd', { cmd: 'dump' });
        return true;
      case 'float-load':
        if (win && !win.isDestroyed()) {
          sendTo(win, 'float:cmd', { cmd: 'load', text: payload && payload.text, p: payload && payload.p });
        }
        return true;
      default:
        break;
    }

    if (!win || win.isDestroyed()) return false;
    switch (action) {
      case 'minimize':
        win.minimize();
        break;
      case 'close':
        // 只关跟跑浮窗，不退出程序 —— 启动器还在，随时可以再点「启动跟跑」。
        // 反方向不一样：关启动器会连带收掉所有窗口并退出（见 createConsole）。
        win.close();
        break;
      case 'hide':
        toggleVisible();
        break;
      case 'pin':
        settings.pinned = !!payload;
        applyPin();
        persist();
        break;
      case 'pass':
        setPass(payload);
        break;
      case 'opacity':
        setOpacity(payload);
        break;
      case 'fullscreen':
        // payload 省略时按当前状态取反，方便同一个入口做开关
        win.setFullScreen(payload === undefined ? !win.isFullScreen() : !!payload);
        break;
      case 'resize':
        if (payload && Number.isFinite(payload.w) && Number.isFinite(payload.h)) {
          win.setBounds({
            x: win.getBounds().x,
            y: win.getBounds().y,
            width: Math.max(240, Math.round(payload.w)),
            height: Math.max(150, Math.round(payload.h))
          });
        }
        break;
      case 'login':
        openLogin();
        break;
      default:
        break;
    }
    return true;
  });

  ipcMain.handle('bili:load', async (_e, payload = {}) => {
    const resolved = await resolveInput(payload.text);
    if (!resolved.ok) return { ok: false, message: resolved.message };

    const p = Number(payload.p) || resolved.p || 1;
    const info = await fetchVideoInfo(resolved.id);
    const id = (info.ok && info.id) || resolved.id;
    const pages = info.ok ? info.pages : [];

    // 同一视频切 P 时接口偶尔读不到分 P 信息，别把已知的标题/总数清掉
    const sameVideo =
      settings.lastVideoId &&
      String(settings.lastVideoId).toLowerCase() === String(id).toLowerCase();
    noteWatched(settings, {
      text: payload.text,
      p,
      id,
      title: info.ok ? info.title : sameVideo ? settings.lastTitle : '',
      pageCount: pages.length || (sameVideo ? settings.lastPageCount : 0)
    });
    persist();
    // 启动器可能正开着：让「上次看到」那一行立刻跟上，不用等下次启动
    broadcast('settings:changed', settings);

    return {
      ok: true,
      id,
      p,
      url: buildUrl(id, p),
      title: info.ok ? info.title : '',
      owner: info.ok ? info.owner : '',
      pages,
      message: info.ok ? '' : `读不到分 P 信息（${info.message}），已直接载入`
    };
  });
}

/* ---------------------------------------------------------------- 生命周期 */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 再次启动 exe 时把启动器叫回来，而不是只动浮窗
    if (consoleWin && !consoleWin.isDestroyed()) {
      if (consoleWin.isMinimized()) consoleWin.restore();
      consoleWin.show();
      consoleWin.focus();
    } else {
      createConsole();
    }
  });

  app.whenReady().then(async () => {
    // 打包版已在 exe 清单层提权（双击即弹 UAC），这里**不再自动重启**：
    // portable 版是「自解压壳 + 主程序」，运行时再提权等于多解压一遍 100MB、多等 20 秒。
    // 只有清单没生效时（开发版 / 解压直跑 / UAC 被取消），启动器顶部横幅仍提供
    // 「以管理员身份重启」作为兜底。
    // 常驻工具：明确告诉系统「别挂起我」。配合上面的 EcoQoS 开关，
    // 保证窗口最小化后全局钩子照常工作（这正是「在游戏里按热键」的核心场景）。
    powerSaveBlocker.start('prevent-app-suspension');

    loadSettings();
    // 调试用：本次启动强制打开方位标记，不写进设置文件
    if (process.argv.includes('--bearing')) settings.bearing.enabled = true;
    try {
      session.defaultSession.setUserAgent(UA);
    } catch {
      /* ignore */
    }
    registerIpc();
    createConsole(); // 先出启动器，配置好了再点「启动跟跑」
    registerHotkeys();

    // `--open BVxxx` 是从快捷方式直接带视频来的，那就顺手把浮窗也起来
    if (OPEN_ARG) createWindow();
    // 「上次看到」：直接把浮窗起来，浮窗 init() 会读 lastText/lastPart 继续播。
    // 显式 --open 优先；开关可在启动器里关掉（只想改设置、不想每次弹浮窗时）。
    else if (shouldResumeOnLaunch(settings, OPEN_ARG)) {
      console.log('[resume] 继续上次观看', settings.lastTitle || settings.lastText, `P${settings.lastPart}`);
      createWindow();
    }

    if (settings.bearing.enabled && win) showOverlay();

    // 只允许登录窗口弹 B 站域名的子窗口（第三方登录/扫码），其余一律拦截
    app.on('web-contents-created', (_e, contents) => {
      contents.setWindowOpenHandler(({ url }) => {
        const isBili = /^https?:\/\/([a-z0-9-]+\.)*bilibili\.com([/?#:]|$)/i.test(url);
        const fromLogin =
          loginWin && !loginWin.isDestroyed() && contents === loginWin.webContents;
        if (fromLogin && isBili) {
          return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } };
        }
        return { action: 'deny' };
      });
    });
  });

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    try {
      hookHotkeys.apply({}, null); // 清空映射并停止钩子
    } catch (err) {
      // 退出路径上的异常会弹出 Electron 的报错框，这里必须兜住
      console.warn('[hook] 退出前停止钩子失败：', err.message);
    }
  });
}

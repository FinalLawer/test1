'use strict';

/**
 * 系统级热键钩子（鼠标侧键 + 单键）。
 *
 * 为什么不用 Electron 的 globalShortcut 处理这两类：
 *
 * 1. **鼠标侧键**：globalShortcut 只接受键盘加速器，官方不支持鼠标按键。
 * 2. **单键**（不带修饰键，如 J / Space / F9）：globalShortcut 能注册，但它在
 *    Windows 上是靠低级键盘钩子实现的，注册后会把按键**吞掉** —— 绑了 J 之后
 *    你在任何程序里都打不出 J。用户想绑单键，但不可能接受这个副作用。
 *
 * 所以这两类都走 libuiohook（WH_MOUSE_LL / WH_KEYBOARD_LL）：它是被动监听，
 * 事件照常继续传递给前台程序，游戏里的同名按键、浏览器里的侧键前进/后退都不受影响。
 * 代价是「不拦截」，因此单键仍然会在游戏里生效 —— 界面里已经写清楚了。
 *
 * 其余带修饰键的组合（Alt+Space 等）继续交给 globalShortcut，那条路更稳，
 * 也不会被输入法之类的东西干扰。
 */

const MOUSE_ACC = /^Mouse([45])$/i;

/** uiohook 的 button 编码：1=左 2=右 3=中 4=侧键后退 5=侧键前进 */
const BUTTON_OF = { Mouse4: 4, Mouse5: 5 };

/** Electron 加速器名 → uiohook 键名（其余同名直接用） */
const KEY_ALIAS = {
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Esc: 'Escape',
  Return: 'Enter',
  '-': 'Minus',
  '=': 'Equal',
  '[': 'BracketLeft',
  ']': 'BracketRight',
  ';': 'Semicolon',
  ',': 'Comma',
  '.': 'Period',
  '/': 'Slash',
  '`': 'Backquote',
  '\\': 'Backslash',
  "'": 'Quote'
};

let uiohook = null;
let UiohookKey = null;
let loaded = false;
let available = false;
let running = false;
let onTrigger = null;
let shouldIgnore = null;

/** 'mouse:4' / 'key:36' → 动作名 */
const bindings = new Map();
/** 按住不放时系统会连发 keydown，用它节流，避免暂停/播放疯狂翻转 */
const lastFire = new Map();

function load() {
  if (loaded) return available;
  loaded = true;
  try {
    const mod = require('uiohook-napi');
    uiohook = mod.uIOhook || null;
    UiohookKey = mod.UiohookKey || null;
    available = !!uiohook && typeof uiohook.start === 'function' && !!UiohookKey;
  } catch (err) {
    console.warn('[hook] 全局钩子不可用：', err.message);
    available = false;
    uiohook = null;
  }
  return available;
}

/** 该加速器是否归钩子管：鼠标侧键，或任何不带修饰键的单键 */
function isHookAccelerator(acc) {
  const s = String(acc || '').trim();
  if (!s) return false;
  if (MOUSE_ACC.test(s)) return true;
  return !s.includes('+');
}

/** 单键 → uiohook keycode；认不出来返回 0 */
function keycodeOf(acc) {
  const raw = String(acc || '').trim();
  if (!raw || !UiohookKey) return 0;
  const name = KEY_ALIAS[raw] || raw;
  // 字母统一成大驼峰（UiohookKey 里是 A~Z），F 键、数字、NumpadX 原本就一致
  const norm = name.length === 1 ? name.toUpperCase() : name;
  const code = UiohookKey[norm];
  return Number.isFinite(code) ? code : 0;
}

function fire(action, token) {
  if (!action) return;
  const now = Date.now();
  if (now - (lastFire.get(token) || 0) < 200) return;
  lastFire.set(token, now);
  console.log(`[hook] ${token} → ${action}`);
  try {
    onTrigger(action);
  } catch (err) {
    console.warn('[hook] 触发失败', err);
  }
}

function onMouseDown(e) {
  const action = bindings.get(`mouse:${e.button}`);
  if (!action) return;
  if (shouldIgnore && shouldIgnore()) {
    console.log(`[hook] 鼠标侧键 ${e.button} 被忽略（正在输入或录制）`);
    return;
  }
  fire(action, `mouse:${e.button}`);
}

function onKeyDown(e) {
  // 带修饰键的是组合键，交给 globalShortcut，这里不重复处理
  if (e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;
  const action = bindings.get(`key:${e.keycode}`);
  if (!action) return;
  if (shouldIgnore && shouldIgnore()) {
    console.log(`[hook] 键码 ${e.keycode} 被忽略（正在输入或录制）`);
    return;
  }
  fire(action, `key:${e.keycode}`);
}

function start() {
  if (running || !available) return;
  uiohook.on('mousedown', onMouseDown);
  uiohook.on('keydown', onKeyDown);
  uiohook.start();
  running = true;
  console.log(
    '[hook] 全局钩子已启动，已绑定：',
    [...bindings.entries()].map(([t, a]) => `${t}→${a}`).join(' ') || '（无）'
  );
}

function stop() {
  if (!running) return;
  try {
    uiohook.off('mousedown', onMouseDown);
    uiohook.off('keydown', onKeyDown);
    uiohook.stop();
  } catch (err) {
    console.warn('[hook] 停止钩子出错', err);
  }
  running = false;
}

/**
 * 重新挂载钩子（保留已有监听与映射）。
 *
 * Windows 在进程被降级成「后台/效率模式」时可能把低级钩子悄悄摘掉，
 * 这时 `running` 仍是 true，界面也显示「监听已启动」，但按键再也进不来。
 * 窗口恢复/浮窗重新显示时补挂一次，成本只有几十毫秒，比让用户重启程序划算。
 */
function rearm() {
  if (!running || !available) return false;
  try {
    uiohook.stop();
    uiohook.start();
    console.log('[hook] 全局钩子已重新挂载');
    return true;
  } catch (err) {
    console.warn('[hook] 重新挂载失败', err.message);
    return false;
  }
}

/**
 * 按最新热键配置重建映射。
 * @param {object} hotkeys 动作 → 加速器
 * @param {(action:string)=>void} trigger 触发回调
 * @param {()=>boolean} ignore 返回 true 时忽略事件（自己的窗口在前台，别抢输入）
 * @returns {{ needed: boolean, ok: boolean, keys: string[] }}
 *          needed=是否有钩子类绑定；ok=钩子是否真的跑起来了；keys=认不出的键位
 */
function apply(hotkeys, trigger, ignore) {
  if (trigger) onTrigger = trigger;
  if (ignore) shouldIgnore = ignore;
  bindings.clear();

  // 先把原生模块和键码表加载好：keycodeOf 依赖 UiohookKey，
  // 放到循环之后加载的话，第一次调用会全部映射失败（都变成「不认识的键」）
  const available = load();

  const unknown = [];
  let needHook = false;

  for (const [action, acc] of Object.entries(hotkeys || {})) {
    const s = String(acc || '').trim();
    if (!s) continue;

    const m = s.match(MOUSE_ACC);
    if (m) {
      needHook = true;
      bindings.set(`mouse:${BUTTON_OF[`Mouse${m[1]}`]}`, action);
      continue;
    }
    if (!isHookAccelerator(s)) continue; // 带修饰键的走 globalShortcut

    needHook = true;
    const code = keycodeOf(s);
    if (!code) {
      unknown.push(s);
      continue;
    }
    bindings.set(`key:${code}`, action);
  }

  if (!needHook) {
    stop();
    return { needed: false, ok: true, keys: unknown };
  }
  if (!available) return { needed: true, ok: false, keys: unknown };
  if (!bindings.size) {
    stop();
    return { needed: true, ok: true, keys: unknown };
  }

  start();
  return { needed: true, ok: true, keys: unknown };
}

/** 给界面用的可读名称 */
function describe(acc) {
  if (/^Mouse4$/i.test(acc)) return '鼠标侧键（后退）';
  if (/^Mouse5$/i.test(acc)) return '鼠标侧键（前进）';
  return acc;
}

function isRunning() {
  return running;
}

module.exports = { apply, isHookAccelerator, describe, isRunning, rearm };

/* 临时探针：直接给 uiohook 注入合成事件，验证「监听 → 键码映射 → 触发」整条链路。用完即删。 */
const { app } = require('electron');
const hook = require('../src/hook-hotkeys');
const { uIOhook } = require('uiohook-napi');

const key = (keycode, mods = {}) => ({
  type: 4,
  time: Date.now(),
  altKey: !!mods.alt,
  ctrlKey: !!mods.ctrl,
  shiftKey: !!mods.shift,
  metaKey: false,
  keycode
});

const mouse = (button) => ({
  type: 7,
  time: Date.now(),
  altKey: false,
  ctrlKey: false,
  shiftKey: false,
  metaKey: false,
  x: 0,
  y: 0,
  button,
  clicks: 1
});

app.whenReady().then(() => {
  const fired = [];
  let ignore = false;

  const state = hook.apply(
    { togglePlay: 'J', seekFwd: 'F9', togglePass: 'Mouse4', seekBack: 'Space' },
    (action) => fired.push(action),
    () => ignore
  );

  console.log('apply:', JSON.stringify(state));

  // 36 = J，67 = F9，57 = Space，分别对应上面三个键位
  uIOhook.emit('keydown', key(36));
  uIOhook.emit('keydown', key(67));
  uIOhook.emit('keydown', key(57));

  // 带修饰键的不该被钩子接管（那是 globalShortcut 的活）
  uIOhook.emit('keydown', key(36, { alt: true }));
  uIOhook.emit('keydown', key(36, { ctrl: true }));

  // 侧键
  uIOhook.emit('mousedown', mouse(4));

  // 自己的窗口在前台时应当整个忽略
  ignore = true;
  uIOhook.emit('keydown', key(36));
  uIOhook.emit('mousedown', mouse(4));
  ignore = false;

  // 连按节流：同一键 200ms 内只算一次
  uIOhook.emit('keydown', key(67));

  console.log('实际触发序列:', JSON.stringify(fired));
  console.log('期望序列: ["togglePlay","seekFwd","seekBack","togglePass"]');
  app.quit();
});

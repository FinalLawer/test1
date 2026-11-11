'use strict';

/**
 * 一次性探针：验证在「当前 Electron 版本 + 本机权限」下，
 * libuiohook 的低级鼠标钩子能否正常启动、能否收到按键。
 *
 * 用法：node scripts/probe-mouse.js
 * 启动后 8 秒内按一下鼠标侧键，就能看到对应的 button 编号。
 */

const { app } = require('electron');

app.disableHardwareAcceleration();

app.whenReady().then(() => {
  let mod;
  try {
    mod = require('uiohook-napi');
  } catch (err) {
    console.log('RESULT=LOAD_FAIL', err.message);
    app.quit();
    return;
  }

  const { uIOhook } = mod;
  const seen = [];

  uIOhook.on('mousedown', (e) => {
    seen.push(e.button);
    console.log(`[probe] mousedown button=${e.button}`);
  });

  try {
    uIOhook.start();
    console.log('[probe] hook started ok');
  } catch (err) {
    console.log('RESULT=START_FAIL', err.message);
    app.quit();
    return;
  }

  setTimeout(() => {
    try {
      uIOhook.stop();
    } catch {
      /* ignore */
    }
    console.log(`RESULT=OK buttons_seen=[${seen.join(',')}] count=${seen.length}`);
    app.quit();
  }, 8000);
});

'use strict';

/**
 * 端到端验证「按键 → 全局钩子 → 主进程 → 浮窗 → 视频」这条链。
 *
 * 沙箱禁止用 SendKeys 模拟系统按键，所以直接向主进程里的 uiohook 单例注入合成事件。
 * 这和真实按键走同一个 EventEmitter 上的同一个监听器，差别只在事件来源。
 * 被测键位从当前 settings.json 里读，改配置后无需改脚本。
 */

const MAIN = 'http://127.0.0.1:9229/json';
const PAGES = 'http://127.0.0.1:9333/json';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error('WebSocket 连接失败：' + wsUrl));
  });
}

function makeEval(ws) {
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) return reject(new Error(JSON.stringify(msg.error)));
    const ex = msg.result && msg.result.exceptionDetails;
    if (ex) return reject(new Error(ex.text + ' ' + (ex.exception ? ex.exception.description : '')));
    resolve(msg.result && msg.result.result ? msg.result.result.value : undefined);
  };
  return (expression) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true }
        })
      );
    });
}

async function main() {
  const [mainTargets, pages] = await Promise.all([
    (await fetch(MAIN)).json(),
    (await fetch(PAGES)).json()
  ]);

  const mainWs = await connect(mainTargets[0].webSocketDebuggerUrl);
  const mainEval = makeEval(mainWs);

  const floatPage = pages.find((t) => t.url.includes('/renderer/index.html'));
  const consolePage = pages.find((t) => t.url.includes('/console/index.html'));
  const biliPage = pages.find((t) => t.url.includes('bilibili.com/video/'));
  if (!floatPage || !biliPage) throw new Error('浮窗或 B 站页面未就绪');

  const floatWs = await connect(floatPage.webSocketDebuggerUrl);
  const floatEval = makeEval(floatWs);
  const biliWs = await connect(biliPage.webSocketDebuggerUrl);
  const biliEval = makeEval(biliWs);

  const cfg = await mainEval(`
    (() => {
      const h = process.mainModule.require(process.cwd() + '/src/hook-hotkeys.js');
      const fs = process.mainModule.require('fs');
      const s = JSON.parse(fs.readFileSync(process.mainModule.require('electron').app.getPath('userData') + '/settings.json', 'utf8'));
      return { running: h.isRunning(), hotkeys: s.hotkeys };
    })()
  `);
  console.log('1) 钩子运行：', cfg.running, '| 当前热键：', JSON.stringify(cfg.hotkeys));

  const emit = async (acc) => {
    const m = /^Mouse([45])$/i.exec(acc || '');
    if (m) {
      await mainEval(`(() => { process.mainModule.require(process.cwd() + '/node_modules/uiohook-napi').uIOhook.emit('mousedown', { button: ${Number(m[1])} }); return 1; })()`);
      return `鼠标键 ${m[1]}`;
    }
    const code = await mainEval(`
      (() => {
        const { UiohookKey } = process.mainModule.require(process.cwd() + '/node_modules/uiohook-napi');
        const k = ${JSON.stringify(acc)};
        return UiohookKey[k.length === 1 ? k.toUpperCase() : k] || 0;
      })()
    `);
    if (!code) throw new Error(`认不出的键位：${acc}`);
    await mainEval(`
      (() => {
        process.mainModule.require(process.cwd() + '/node_modules/uiohook-napi').uIOhook.emit('keydown', { keycode: ${code}, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false });
        return 1;
      })()
    `);
    return `键码 ${code}`;
  };

  const video = `(() => { const v = document.querySelector('video'); return v ? { paused: v.paused, t: +v.currentTime.toFixed(1) } : null; })()`;

  // 播放/暂停
  const before = await biliEval(video);
  const playAcc = cfg.hotkeys.togglePlay;
  const how = await emit(playAcc);
  await sleep(1000);
  const after = await biliEval(video);
  const okPlay = before && after && before.paused !== after.paused;
  console.log(`2) 触发「播放/暂停」(${playAcc} / ${how})：`, JSON.stringify(before), '→', JSON.stringify(after), okPlay ? '✅' : '❌ 无变化');

  // 快进：先确保处于播放态，再比较时间
  const fwdAcc = cfg.hotkeys.seekFwd;
  const t0 = await biliEval(`(() => { const v = document.querySelector('video'); return v ? +v.currentTime.toFixed(1) : null; })()`);
  const how2 = await emit(fwdAcc);
  await sleep(1000);
  const t1 = await biliEval(`(() => { const v = document.querySelector('video'); return v ? +v.currentTime.toFixed(1) : null; })()`);
  console.log(`3) 触发「快进」(${fwdAcc} / ${how2})：`, t0, '→', t1, t1 !== null && t0 !== null && t1 > t0 + 1 ? '✅' : '⚠ 未跳转');

  // 输入框聚焦时应静默
  if (consolePage) {
    const consoleWs = await connect(consolePage.webSocketDebuggerUrl);
    const consoleEval = makeEval(consoleWs);
    await consoleEval(`(() => { document.getElementById('url').focus(); return document.activeElement.tagName; })()`);
    await sleep(250);
    const p1 = await biliEval(video);
    await emit(playAcc);
    await sleep(900);
    const p2 = await biliEval(video);
    console.log('4) 输入框聚焦时按键：', p1 && p2 && p1.paused === p2.paused ? '✅ 已让路' : '❌ 仍在触发');
    await consoleEval(`(() => { document.getElementById('url').blur(); return 1; })()`);
    consoleWs.close();
  }

  // 窗口尺寸
  const wins = await mainEval(`
    process.mainModule.require('electron').BrowserWindow.getAllWindows().map((w) => ({ title: w.getTitle(), b: w.getBounds() }))
  `);
  console.log('5) 窗口尺寸：', JSON.stringify(wins));

  mainWs.close();
  floatWs.close();
  biliWs.close();
}

main().catch((e) => {
  console.error('验证失败：', e.message);
  process.exit(1);
});

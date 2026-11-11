'use strict';
/* 用项目自带 Electron 无头加载本地 mp4 抽帧。
 * 为什么不用 ffmpeg：本机没装，且 <video>→canvas 的解码链路与 analyzeCone() 完全同源。
 * 用法： electron.exe grab-video.js <时间点JSON文件> <输出目录>
 *   时间点文件： {"times":[0,5,10,...], "w":960}  （w=导出宽度，省略则用原始分辨率）
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const conf = JSON.parse(fs.readFileSync(path.join(__dirname, 'video-conf.json'), 'utf8'));
const specFile = process.argv[2];
const outDir = process.argv[3] || conf.out;
const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
const times = spec.times || (spec.count
  ? Array.from({ length: spec.count }, (_, i) =>
      Number((spec.t0 + (spec.t1 - spec.t0) * i / (spec.count - 1)).toFixed(2)))
  : []);
const rawMode = spec.format === 'raw';
fs.mkdirSync(outDir, { recursive: true });
const binPath = path.join(outDir, spec.rawBin || 'frames.bin');
const manPath = path.join(outDir, spec.rawManifest || 'frames.json');
let binFd = null;
let cursor = 0;
const manifest = [];
if (rawMode) binFd = fs.openSync(binPath, 'w');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('allow-file-access-from-files');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 720,
    webPreferences: { webSecurity: false, offscreen: true, backgroundThrottling: false }
  });
  const html = 'file://' + path.join(__dirname, 'grab-video.html').replace(/\\/g, '/');
  const src = 'file://' + conf.video.replace(/\\/g, '/').replace(/ /g, '%20');
  await win.loadURL(html);

  const meta = await win.webContents.executeJavaScript(`(async () => {
    const v = document.getElementById('v');
    v.src = ${JSON.stringify(src)};
    await new Promise((res, rej) => {
      v.addEventListener('loadedmetadata', res, { once: true });
      v.addEventListener('error', () => rej(new Error('video load error')), { once: true });
      setTimeout(() => rej(new Error('metadata timeout')), 15000);
    });
    return { w: v.videoWidth, h: v.videoHeight, dur: v.duration };
  })()`);
  console.log('META ' + JSON.stringify(meta));

  const W = spec.w || meta.w;
  const H = Math.round(meta.h * W / meta.w);
  // 可选：按运行时 grabCenter 的方式，直接从原生分辨率裁一个以玩家为圆心的方形窗口。
  // spec.crop = { cx, cy, size }（坐标按 spec.w 缩放后的帧；不填则导出整帧）
  const crop = spec.crop || null;
  const outW = crop ? crop.size : W;
  const outH = crop ? crop.size : H;

  for (let i = 0; i < times.length; i += 1) {
    const t = times[i];
    const dataUrl = await win.webContents.executeJavaScript(`(async () => {
      const v = document.getElementById('v');
      // 暂停态 seek 不会重绘：seek → 短暂 play → pause，等一帧真正解码出来
      v.currentTime = ${t};
      await new Promise((res) => {
        if (Math.abs(v.currentTime - ${t}) < 0.02 && v.readyState >= 2) return res();
        v.addEventListener('seeked', res, { once: true });
        setTimeout(res, 4000);
      });
      try { await v.play(); } catch (e) { /* autoplay 被拦时仍可尝试 */ }
      await new Promise((res) => {
        if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(res);
        else setTimeout(res, 120);
      });
      v.pause();
      const c = document.createElement('canvas');
      c.width = ${outW}; c.height = ${outH};
      const cx = c.getContext('2d', { willReadFrequently: true });
      ${crop
        ? `const k = v.videoWidth / ${W};\n      cx.drawImage(v, (${crop.cx} - ${crop.size}/2) * k, (${crop.cy} - ${crop.size}/2) * k, ${crop.size} * k, ${crop.size} * k, 0, 0, ${outW}, ${outH});`
        : `cx.drawImage(v, 0, 0, ${W}, ${H});`}
      if (!${rawMode}) return c.toDataURL('image/png');
      const d = cx.getImageData(0, 0, ${outW}, ${outH}).data;
      let s = '';
      for (let k = 0; k < d.length; k += 0x8000) s += String.fromCharCode.apply(null, d.subarray(k, k + 0x8000));
      return btoa(s);
    })()`);
    if (rawMode) {
      const buf = Buffer.from(dataUrl, 'base64');
      fs.writeSync(binFd, buf);
      manifest.push({ t, size: outW, off: cursor });
      cursor += buf.length;
      if (i % 25 === 0 || i === times.length - 1) {
        console.log('RAW ' + (i + 1) + '/' + times.length + ' t=' + t + ' bytes=' + buf.length);
      }
    } else {
      const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
      const name = 't' + String(t).replace('.', '_').padStart(7, '0') + '.png';
      fs.writeFileSync(path.join(outDir, name), buf);
      console.log('OK ' + t + ' ' + name + ' ' + buf.length);
    }
  }
  if (rawMode) {
    fs.closeSync(binFd);
    fs.writeFileSync(manPath, JSON.stringify({ count: manifest.length, list: manifest, step: spec.step || 2 }));
    console.log('MANIFEST ' + manPath + ' BYTES ' + cursor);
  }
  console.log('DONE ' + times.length);
  app.exit(0);
}).catch((e) => { console.error('FAIL ' + e.stack); app.exit(1); });

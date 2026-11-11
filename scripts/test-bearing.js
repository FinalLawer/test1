'use strict';

/**
 * 开发用离线验证脚本：拿真实视频帧测试朝向识别算法。
 *
 * 为什么需要它：识别算法跑在 webview 的 preload 里（沙箱内不能 require 本地模块），
 * 没法直接单测。这里用同样的像素逻辑在 Node 里复现一遍，用真实帧校准阈值，
 * 确认无误后再同步回 webview-preload.js。
 *
 * 用法：node scripts/run-e.js scripts/test-bearing.js <frame.png> <cx> <cy> <r> [size]
 */

const { app, nativeImage } = require('electron');

/* ---------------- 算法本体（与 webview-preload.js 中的实现保持一致） ---------------- */

function detectAngle(data, size) {
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const r0 = size * 0.05;
  const r1 = size * 0.26;
  const r2 = size * 0.46;

  const rows = [];

  for (let deg = 0; deg < 360; deg += 2) {
    const rad = (deg * Math.PI) / 180;
    const sn = Math.sin(rad);
    const cs = Math.cos(rad);

    let inner = 0;
    let nIn = 0;
    let outer = 0;
    let nOut = 0;

    for (let r = r0; r <= r2; r += 0.7) {
      const x = Math.round(cx + sn * r);
      const y = Math.round(cy - cs * r);
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const i = (y * size + x) * 4;
      const s = cyanScore(data[i], data[i + 1], data[i + 2]);
      if (r <= r1) {
        inner += s;
        nIn += 1;
      } else {
        outer += s;
        nOut += 1;
      }
    }

    if (!nIn || !nOut) continue;
    rows.push({ deg, inner: inner / nIn, contrast: inner / nIn - (outer / nOut) * 0.9 });
  }

  if (rows.length < 60) return { angle: 0, valid: false, inner: 0, peak: 0 };

  let best = rows[0];
  for (const row of rows) if (row.contrast > best.contrast) best = row;

  const sorted = rows.map((row) => row.contrast).sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];

  return {
    angle: best.deg,
    inner: best.inner,
    peak: best.contrast - median
  };
}

function cyanScore(r, g, b) {
  return Math.max(0, Math.min(g, b) - r);
}

/* ------------------------------- 取样 ------------------------------- */

function crop(data, width, height, cx, cy, size) {
  const half = size / 2;
  const x0 = Math.round(cx - half);
  const y0 = Math.round(cy - half);
  const out = new Uint8Array(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = x0 + x;
      const sy = y0 + y;
      const di = (y * size + x) * 4;
      if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
      const si = (sy * width + sx) * 4;
      out[di] = data[si];
      out[di + 1] = data[si + 1];
      out[di + 2] = data[si + 2];
      out[di + 3] = 255;
    }
  }
  return out;
}

/** nativeImage.toBitmap() 在 Windows 上是 BGRA，转成 RGBA 再算 */
function toRgba(bitmap, width, height) {
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const j = i * 4;
    out[j] = bitmap[j + 2];
    out[j + 1] = bitmap[j + 1];
    out[j + 2] = bitmap[j];
    out[j + 3] = 255;
  }
  return out;
}

app.whenReady().then(() => {
  const [src, cxArg, cyArg, rArg, sizeArg] = process.argv.slice(2);
  const img = nativeImage.createFromPath(src);
  const { width, height } = img.getSize();
  const rgba = toRgba(img.toBitmap(), width, height);

  console.log(`帧 ${width}×${height}`);

  const cases = [
    ['标定正确', Number(cxArg), Number(cyArg)],
    ['偏左上 20%', Number(cxArg) - Number(rArg) * 0.2, Number(cyArg) - Number(rArg) * 0.2],
    ['纯地形（右下）', Number(cxArg) + Number(rArg) * 2.5, Number(cyArg) + Number(rArg) * 1.6]
  ];

  const size = Math.round(Math.min(160, Math.max(48, Number(rArg) * 0.62)));

  if (process.argv[6] === 'sweep') {
    // 网格搜索：看哪个圆心能把箭头判据拉到最高
    let top = [];
    for (let dx = -14; dx <= 14; dx += 2) {
      for (let dy = -14; dy <= 14; dy += 2) {
        const x = Number(cxArg) + dx;
        const y = Number(cyArg) + dy;
        const r = detectAngle(crop(rgba, width, height, x, y, size), size);
        top.push({ x, y, ...r });
      }
    }
    top.sort((a, b) => b.peak - a.peak);
    console.log(`网格搜索（步长 2px，采样框 ${size}px），按突出度排序前 6：`);
    for (const t of top.slice(0, 6)) {
      console.log(
        `  (${t.x}, ${t.y})  → ${String(Math.round(t.angle)).padStart(3)}°  青色 ${t.inner.toFixed(1)}  突出度 ${t.peak.toFixed(1)}`
      );
    }
    app.exit(0);
    return;
  }

  for (const [label, x, y] of cases) {
    const px = crop(rgba, width, height, x, y, size);
    const r = detectAngle(px, size);
    console.log(
      `${label.padEnd(14)} 中心(${Math.round(x)},${Math.round(y)}) ` +
        `→ ${String(Math.round(r.angle)).padStart(3)}°  青色 ${r.inner.toFixed(1)}  突出度 ${r.peak.toFixed(1)}`
    );
  }

  app.exit(0);
});

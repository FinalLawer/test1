'use strict';

// 开发用临时脚本：裁剪并放大一张图片，便于肉眼核对小地图箭头。
// node scripts/run-electron.js scripts/crop.js <src> <x,y,w,h> <scale> <out>

const { app, nativeImage } = require('electron');
const fs = require('node:fs');

app.whenReady().then(() => {
  const [src, box, scaleArg, out] = process.argv.slice(2);
  if (!src || !box || !out) {
    console.error('用法: <src> <x,y,w,h> <scale> <out>');
    app.exit(1);
    return;
  }

  const [x, y, w, h] = box.split(',').map(Number);
  const scale = Number(scaleArg) || 1;

  const img = nativeImage.createFromPath(src);
  const size = img.getSize();
  console.log('源图尺寸', size);

  const crop = img.crop({ x, y, width: w, height: h });
  const big = crop.resize({ width: Math.round(w * scale), height: Math.round(h * scale), quality: 'best' });

  fs.writeFileSync(out, big.toPNG());
  console.log('已输出', out, big.getSize());
  app.exit(0);
});

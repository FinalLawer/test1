'use strict';

// 开发用临时脚本：截一张主屏，用于核对叠加层与识别区域的实际表现。
// 用法：<electron> scripts/shot.js <out.png>

const { app, desktopCapturer, screen } = require('electron');
const fs = require('node:fs');

app.whenReady().then(async () => {
  const display = screen.getPrimaryDisplay();
  const width = Math.round(display.size.width * display.scaleFactor);
  const height = Math.round(display.size.height * display.scaleFactor);

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height }
  });

  const out = process.argv[2];
  if (!sources.length) {
    console.error('没有可截取屏幕');
    app.exit(1);
    return;
  }

  fs.writeFileSync(out, sources[0].thumbnail.toPNG());
  console.log('已截图', out, sources[0].thumbnail.getSize());
  app.exit(0);
});

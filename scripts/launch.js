'use strict';

/**
 * 启动器。
 * 某些 Electron 宿主环境（如 WorkBuddy / VS Code 的内置终端）会预设
 * ELECTRON_RUN_AS_NODE=1，让 electron.exe 退化成纯 Node 进程，
 * 于是 require('electron').app 为 undefined。这里显式剔除该变量再拉起。
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const electronBinary = require('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const args = [path.resolve(__dirname, '..'), ...process.argv.slice(2)];

const child = spawn(electronBinary, args, { stdio: 'inherit', env });
child.on('close', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  console.error('启动失败：', err.message);
  process.exit(1);
});

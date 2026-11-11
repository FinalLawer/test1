'use strict';

/**
 * 双产物自检：不运行安装器、不写注册表，只做静态核对。
 *
 *   node scripts/verify-artifacts.js --out=dist-release-1
 *
 * 覆盖：zip 结构 + 全条目 CRC + UTF-8 中文名 / Setup.exe 完整性 /
 * SHA256SUMS / 主 exe 提权清单 / NSIS 自定义页宏与模板钩子是否对齐 /
 * 品牌资源格式 / package.json 打包配置。
 * 实机安装（欢迎页显示、installed.flag 落盘、卸载保留设置）不在此脚本范围内。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { verifyZip } = require('./zip-writer');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const ARG_OUT = process.argv.slice(2).find((a) => a.startsWith('--out='));

function latestOut() {
  const dirs = fs.readdirSync(ROOT)
    .filter((n) => /^dist-release-\d+$/.test(n))
    .map((n) => ({ n, t: fs.statSync(path.join(ROOT, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!dirs.length) throw new Error('找不到 dist-release-N 产物目录');
  return path.join(ROOT, dirs[0].n);
}
const OUT = ARG_OUT ? path.resolve(ROOT, ARG_OUT.slice('--out='.length)) : latestOut();
const ZIP = path.join(OUT, `GenshinRouteBuddy-${VERSION}-win-x64.zip`);
const SETUP = path.join(OUT, `GenshinRouteBuddy-${VERSION}-Setup.exe`);
const SUMS = path.join(OUT, 'SHA256SUMS.txt');

let pass = 0;
let fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
}
const has = (p) => fs.existsSync(p);
const read = (p) => fs.readFileSync(p);

function sha256(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1024 * 1024);
  let n;
  while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  fs.closeSync(fd);
  return h.digest('hex');
}
function bmpSize(file) {
  const b = read(file);
  return [b.readInt32LE(18), Math.abs(b.readInt32LE(22))];
}

console.log(`产物自检：${OUT}`);

/* ---- 1. 三个交付文件 ---- */
check('zip 存在', has(ZIP), true);
check('Setup.exe 存在', has(SETUP), true);
check('SHA256SUMS.txt 存在', has(SUMS), true);

/* ---- 2. 绿色版 zip ---- */
if (has(ZIP)) {
  const z = verifyZip(ZIP); // 全条目解压 + CRC 校验，坏了直接抛
  const top = [...new Set(z.names.map((n) => n.split('/')[0]))];
  check('zip 条目数 > 100', z.count > 100, true);
  check('顶层只有 GenshinRouteBuddy/', top, ['GenshinRouteBuddy']);
  const hasEntry = (n) => z.names.includes('GenshinRouteBuddy/' + n);
  check('中文主 exe 条目', z.names.some((n) => n.endsWith('原神跟跑助手.exe')), true);
  check('app.asar 条目', z.names.some((n) => n.endsWith('resources/app.asar')), true);
  check('portable.flag', hasEntry('portable.flag'), true);
  check('绿色版说明', hasEntry('README-绿色版.txt'), true);
  check('data/ 目录项', hasEntry('data/'), true);
  check('没有混进 installed.flag', hasEntry('installed.flag'), false);
  check('没有混进 migrate-from.txt', hasEntry('migrate-from.txt'), false);
  const flag = z.read('GenshinRouteBuddy/portable.flag');
  check('portable.flag 内容', flag && flag.toString('utf8').startsWith('portable'), true);
  const readme = z.read('GenshinRouteBuddy/README-绿色版.txt');
  check('说明文件带 UTF-8 BOM', readme && readme.subarray(0, 3).toString('hex'), 'efbbbf');
  check('说明写了 data 目录', readme && readme.toString('utf8').includes('data\\'), true);
}

/* ---- 3. 安装版 exe ---- */
if (has(SETUP)) {
  const b = read(SETUP);
  check('Setup.exe > 50 MiB', b.length > 50 * 1048576, true);
  check('PE 头 MZ', b.subarray(0, 2).toString('ascii'), 'MZ');
  check('内含中文产品名（UTF-16LE）', b.indexOf(Buffer.from('原神跟跑助手', 'utf16le')) >= 0, true);
}

/* ---- 4. 主 exe 提权清单（安装版里的就是这份 --dir 产物） ---- */
const mainExe = path.join(OUT, 'win-unpacked', '原神跟跑助手.exe');
if (has(mainExe)) {
  const b = read(mainExe);
  check('主 exe 清单 requireAdministrator', b.indexOf(Buffer.from('requireAdministrator', 'utf8')) >= 0, true);
} else {
  check('主 exe 存在（--pd 源）', false, true);
}

/* ---- 5. SHA256 与文件一致 ---- */
if (has(SUMS)) {
  const lines = read(SUMS).toString('ascii').trim().split(/\r?\n/);
  check('校验清单两行', lines.length, 2);
  let allOk = true;
  for (const line of lines) {
    const [hash, name] = line.split(/\s+/);
    const f = path.join(OUT, name);
    if (!has(f) || sha256(f) !== hash) allOk = false;
  }
  check('两个 hash 都对得上', allOk, true);
}

/* ---- 6. 打包配置 ---- */
const build = pkg.build;
check('win 提权（主 exe）', build.win.requestedExecutionLevel, 'requireAdministrator');
check('portable 壳提权', build.portable.requestExecutionLevel, 'admin');
check('nsis 一键安装关闭', build.nsis.oneClick, false);
check('nsis 可改安装目录', build.nsis.allowToChangeInstallationDirectory, true);
check('nsis 卸载保留数据', build.nsis.deleteAppDataOnUninstall, false);
check('nsis 自定义脚本', build.nsis.include, 'build/installer.nsh');
check('nsis 许可页', build.nsis.license, 'build/LICENSE.txt');
check('nsis 侧栏位图', build.nsis.installerSidebar, 'build/installerSidebar.bmp');
check('nsis 页眉位图', build.nsis.installerHeader, 'build/installerHeader.bmp');
check('nsis 图标', build.nsis.installerIcon, 'build/icon.ico');
check('nsis 产物名', build.nsis.artifactName, 'GenshinRouteBuddy-${version}-Setup.${ext}');
check('pack:zip 脚本', !!pkg.scripts['pack:zip'], true);
check('pack:setup 脚本', !!pkg.scripts['pack:setup'], true);

/* ---- 7. 自定义页宏与 electron-builder 模板钩子对齐 ---- */
const nshPath = path.join(ROOT, 'build/installer.nsh');
if (has(nshPath)) {
  const raw = read(nshPath);
  const nsh = raw.toString('utf8');
  check('installer.nsh 是 UTF-8 BOM', raw.subarray(0, 3).toString('hex'), 'efbbbf');
  for (const macro of ['customWelcomePage', 'customInit', 'customPageAfterChangeDir', 'customInstall', 'customUnInstall', 'customFinishPage']) {
    check(`定义了 !macro ${macro}`, nsh.includes(`!macro ${macro}`), true);
  }
  // 只匹配真正以 !undef 开头的指令行，注释里提到这个词不算
  check('没有多余 !undef（会被 /WX 判失败）', /^\s*!undef\s/m.test(nsh), false);
  check('页面函数有 BUILD_UNINSTALLER 守卫', /!ifndef BUILD_UNINSTALLER[\s\S]*Function grbOptionsPageCreate/.test(nsh), true);
  check('写了 installed.flag', nsh.includes('FileWrite $0 "installed'), true);
  check('写了 migrate-from.txt', nsh.includes('migrate-from.txt'), true);
  check('写了 includeLogin=1', nsh.includes('includeLogin=1'), true);
  check('卸载清理标记', nsh.includes('Delete "$INSTDIR\\installed.flag"'), true);

  const tpl = read(path.join(ROOT, 'node_modules/app-builder-lib/templates/nsis/assistedInstaller.nsh')).toString('utf8');
  const hooks = [...tpl.matchAll(/!ifmacrodef (\w+)/g)].map((m) => m[1]);
  for (const h of ['customWelcomePage', 'licensePage', 'customPageAfterChangeDir', 'customFinishPage']) {
    check(`模板有钩子 ${h}`, hooks.includes(h), true);
  }
  check('licensePage 交给 electron-builder 生成', nsh.includes('!macro licensePage'), false);
}

/* ---- 8. 品牌资源格式 ---- */
const bmp = path.join(ROOT, 'build/installerSidebar.bmp');
const hdr = path.join(ROOT, 'build/installerHeader.bmp');
const ico = path.join(ROOT, 'build/icon.ico');
const lic = path.join(ROOT, 'build/LICENSE.txt');
check('侧栏 164x314', has(bmp) ? bmpSize(bmp) : null, [164, 314]);
check('页眉 150x57', has(hdr) ? bmpSize(hdr) : null, [150, 57]);
check('侧栏 BMP 头', has(bmp) ? read(bmp).subarray(0, 2).toString('ascii') : null, 'BM');
check('ICO 头', has(ico) ? read(ico).subarray(0, 4).toString('hex') : null, '00000100');
check('许可文件 UTF-8 BOM', has(lic) ? read(lic).subarray(0, 3).toString('hex') : null, 'efbbbf');

/* ---- 9. .gitignore 不能把 build/ 排掉 ---- */
const gi = read(path.join(ROOT, '.gitignore')).toString('utf8');
check('build/ 已不再被忽略', /^build\/$/m.test(gi), false);

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;

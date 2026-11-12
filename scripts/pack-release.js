'use strict';

/**
 * 双产物打包入口：一次 --dir 构建，同时产出 zip 绿色版与 NSIS 安装版。
 *
 *   node scripts/pack-release.js                # 两个都打
 *   node scripts/pack-release.js --zip-only     # 只打绿色版
 *   node scripts/pack-release.js --setup-only   # 只打安装版
 *   node scripts/pack-release.js --no-build     # 复用已有 win-unpacked，跳过 --dir
 *   node scripts/pack-release.js --out=dist-xxx # 指定全新输出目录
 *
 * 输出目录必须**全新**：本机 safe-delete shim 会拦 electron-builder 解包后的
 * fs.rm(win-unpacked.tmp)，覆盖旧目录会失败。不指定时自动挑 dist-release-N。
 * -c.electronDist 也是为了绕开这个坑（见项目记忆）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { createZip } = require('./zip-writer');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const ARGS = process.argv.slice(2);
const ZIP_ONLY = ARGS.includes('--zip-only');
const SETUP_ONLY = ARGS.includes('--setup-only');
const NO_BUILD = ARGS.includes('--no-build');
const SUMS_ONLY = ARGS.includes('--sums-only'); // 只重算 SHA256SUMS（分步打包后补齐两行）
const OUT_ARG = ARGS.find((a) => a.startsWith('--out='));

function pickOutDir() {
  if (OUT_ARG) return path.resolve(ROOT, OUT_ARG.slice('--out='.length));
  for (let n = 1; n < 100; n++) {
    const dir = path.join(ROOT, `dist-release-${n}`);
    if (!fs.existsSync(dir)) return dir;
  }
  throw new Error('找不到可用的输出目录');
}

const OUT = pickOutDir();
const UNPACKED = path.join(OUT, 'win-unpacked');
const STAGE = path.join(OUT, 'GenshinRouteBuddy'); // zip 里的顶层目录
const ZIP_NAME = `GenshinRouteBuddy-${VERSION}-win-x64.zip`;
const SETUP_NAME = `GenshinRouteBuddy-${VERSION}-Setup.exe`;
const CLI = require.resolve('electron-builder/cli.js');

function builder(extraArgs) {
  const args = [CLI, ...extraArgs, `-c.directories.output=${OUT}`, '-c.electronDist=node_modules/electron/dist'];
  console.log(`\n> electron-builder ${extraArgs.join(' ')}`);
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`electron-builder 退出码 ${r.status}`);
}

const GREEN_README = `原神跟跑助手 ${VERSION} · zip 绿色版

【怎么运行】
解压整个文件夹到任意可写目录（不要放在 C:\\Program Files 里），
双击「原神跟跑助手.exe」。首次运行会弹一次 UAC —— 全局热键在原神这种
管理员权限窗口里生效，需要管理员身份，这是 Windows 的 UIPI 机制，不是异常。
如果你的系统关闭了 UAC，或点了「否」，程序仍可用，只是游戏内热键会失效，
可以在启动器里用「以管理员身份重启」补上。

【数据放在哪】
设置、小地图 ROI 标定、观看记录、B 站登录态都写在同级的 data\\ 里。
整个文件夹拷到 U 盘 / 另一台电脑，配置和标定一起带走。
data\\ 里含有本机可用的 B 站 Cookie，**不要把运行过的整个文件夹发给别人**。

【卸载 / 升级】
绿色版不写注册表、不建快捷方式：删掉整个文件夹即可。
升级时先备份 data\\，覆盖其余文件；或直接装「安装版」，
在安装页勾选「从旧绿色版迁移设置与标定」并选中旧的 data\\ 目录。
注意：绿色版与安装版的数据目录不同（安装版用 %APPDATA%\\原神跟跑助手\\），
两者不会自动同步。

【和 B 站视频跟跑的用法】
启动器里粘贴 B 站攻略视频 BV 号 → 打开跟跑浮窗 → 用「框选」把圆环
对准视频里的小地图 → 锁定位置。红箭头是角色行进方向，绿弧是镜头朝向，
两条通道独立识别，任一被地图标点干扰都不会带偏另一条。
`;

const FLAG_TEXT = `portable
这个标记表示「绿色版」：userData 用 exe 同级的 data\\。
安装版用的是 installed.flag，两种标记不会同时出现。
`;

/**
 * 自己递归复制，不用 fs.cpSync：本机沙箱会直接把调用 cpSync 的进程杀掉
 * （exit 127，连异常都抛不出来），而逐文件 copyFileSync 正常。
 */
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, ent.name);
    const to = path.join(dst, ent.name);
    if (ent.isDirectory()) copyDir(from, to);
    else if (ent.isFile()) fs.copyFileSync(from, to);
  }
}

function stageGreen() {
  if (!fs.existsSync(UNPACKED)) throw new Error(`找不到 --dir 产物：${UNPACKED}`);
  const exe = fs.readdirSync(UNPACKED).find((f) => f.endsWith('.exe'));
  if (!exe) throw new Error('win-unpacked 里没有主 exe');
  if (fs.existsSync(STAGE)) {
    if (!ARGS.includes('--reuse-stage')) throw new Error(`${STAGE} 已存在；要复用请加 --reuse-stage`);
    console.log(`\n复用已组装的绿色版目录：${STAGE}`);
  } else {
    console.log(`\n组装绿色版：${UNPACKED} → ${STAGE}`);
    copyDir(UNPACKED, STAGE);
  }
  fs.mkdirSync(path.join(STAGE, 'data'), { recursive: true });
  fs.writeFileSync(path.join(STAGE, 'portable.flag'), FLAG_TEXT, 'utf8');
  fs.writeFileSync(path.join(STAGE, 'README-绿色版.txt'), '\ufeff' + GREEN_README.replace(/\n/g, '\r\n'), 'utf8');
  // 安装版的标记绝不能混进绿色包
  const stray = path.join(STAGE, 'installed.flag');
  if (fs.existsSync(stray)) fs.unlinkSync(stray);
  console.log(`  主程序 ${exe} / portable.flag / README / data\\`);
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const s = fs.createReadStream(file);
    s.on('data', (c) => hash.update(c));
    s.on('end', resolve);
    s.on('error', reject);
  });
  return hash.digest('hex');
}

async function writeSums() {
  // 总是扫描产物目录，而不是只看本次生成的文件：
  // 分步跑 --zip-only / --setup-only 时，两次都要留在校验清单里。
  const files = [ZIP_NAME, SETUP_NAME].map((n) => path.join(OUT, n)).filter((f) => fs.existsSync(f));
  const lines = [];
  for (const f of files) {
    lines.push(`${await sha256(f)}  ${path.basename(f)}`);
  }
  fs.writeFileSync(path.join(OUT, 'SHA256SUMS.txt'), lines.join('\n') + '\n', 'ascii');
  console.log(`\nSHA256SUMS.txt：`);
  for (const l of lines) console.log('  ' + l);
  return lines;
}

async function main() {
  // 安装脚本丢了 BOM 时 makensis 不会报错，只会把中文按系统代码页读成乱码打进安装器，
  // 等装到一半才发现就晚了，所以打包前先拦下
  if (!ZIP_ONLY && !SUMS_ONLY) {
    const nsh = fs.readFileSync(path.join(ROOT, 'build', 'installer.nsh'));
    if (nsh.subarray(0, 3).toString('hex') !== 'efbbbf') {
      throw new Error('build/installer.nsh 缺少 UTF-8 BOM，安装页中文会乱码；请补上前三字节 EF BB BF 再打包');
    }
  }

  fs.mkdirSync(OUT, { recursive: true });
  console.log(`输出目录：${OUT}`);

  if (SUMS_ONLY) {
    await writeSums();
    return;
  }

  if (!NO_BUILD || !fs.existsSync(UNPACKED)) {
    builder(['--win', '--dir']);
  } else {
    console.log(`\n复用已有 --dir 产物：${UNPACKED}`);
  }

  let zipFile = null;
  let setupFile = null;

  if (!SETUP_ONLY) {
    stageGreen();
    zipFile = path.join(OUT, ZIP_NAME);
    const stat = await createZip(STAGE, zipFile, { level: 6, prefix: path.basename(STAGE) });
    console.log(`\n${ZIP_NAME}：${stat.files} 文件 / ${stat.dirs} 目录 / ${(stat.bytes / 1048576).toFixed(1)} MiB`);
  }

  if (!ZIP_ONLY) {
    // NSIS 直接复用同一份 --dir 产物，不再重新打包 app.asar。
    // 写法是 `--win nsis`（平台后跟 target 名），electron-builder 没有 --nsis 这个开关。
    builder(['--win', 'nsis', '--pd', UNPACKED]);
    setupFile = path.join(OUT, SETUP_NAME);
    if (!fs.existsSync(setupFile)) throw new Error(`未生成 ${SETUP_NAME}`);
  }

  await writeSums();
  console.log(`\n完成。产物目录：${OUT}`);
  console.log(`自检：node scripts/verify-artifacts.js --out=${path.basename(OUT)}`);
}

main().catch((err) => {
  console.error('\n[pack] 失败：', err.message || err);
  process.exitCode = 1;
});

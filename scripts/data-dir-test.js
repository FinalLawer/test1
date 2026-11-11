'use strict';

/**
 * P0 回归：安装版 / 绿色版 userData 分流 + 旧数据一次性迁移。
 *
 * 纯离线：从 main.js 抠出 [DATA-DIR-START] ~ [DATA-DIR-END] 整块，注入 mock app /
 * process / console，用系统临时目录里的真实文件跑，不启动 Electron、不碰用户配置。
 * 运行：node scripts/data-dir-test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');

const START = '/* ------------------------------- 数据目录：绿色版 / 安装版 [DATA-DIR-START] */';
const END = '/* [DATA-DIR-END]';
const a = mainSrc.indexOf(START);
const b = mainSrc.indexOf(END);
if (a < 0 || b < 0 || b <= a) throw new Error('找不到 [DATA-DIR-START/END] 区块');
const block = mainSrc.slice(a, b);

let pass = 0;
let fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
}
const exists = (p) => fs.existsSync(p);
const read = (p) => (exists(p) ? fs.readFileSync(p, 'utf8') : '');

/** 每个 case 一套独立目录：exeDir（假程序目录） / appData（模拟 %APPDATA%） / old（旧绿色版） */
function makeCase(name) {
  const base = path.join(TMP, name);
  const exeDir = path.join(base, 'exe');
  const appData = path.join(base, 'appdata', '原神跟跑助手');
  const oldRoot = path.join(base, 'old-green');
  fs.mkdirSync(exeDir, { recursive: true });
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(oldRoot, { recursive: true });
  return { base, exeDir, appData, oldRoot };
}

function put(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}
const touch = (dir, rel, content) => put(path.join(dir, rel), content);

/**
 * 注入执行整块代码。fsOverride 用来模拟「程序目录只读」和「复制失败」。
 */
function run(c, opts = {}) {
  const setPaths = [];
  const logs = [];
  const app = {
    isPackaged: opts.isPackaged !== false,
    getPath(kind) {
      if (kind === 'exe') return path.join(c.exeDir, '原神跟跑助手.exe');
      return c.appData;
    },
    setPath: (kind, value) => setPaths.push([kind, value])
  };
  const proc = { env: { ...(opts.env || {}) }, platform: 'win32' };
  const con = { warn: (...x) => logs.push('warn:' + x.join(' ')), log: (...x) => logs.push('log:' + x.join(' ')) };
  const injectedFs = opts.fsOverride ? Object.assign(Object.create(fs), opts.fsOverride) : fs;
  const factory = new Function('app', 'fs', 'path', 'process', 'console', 'setPaths', `${block}
    return {
      dir: USER_DATA_DIR,
      mode: installMode,
      setPaths,
      migrate: migrateLegacyData,
      candidates: legacyDataCandidates,
      includeLogin: migrationIncludeLogin
    };`);
  const result = factory(app, injectedFs, path, proc, con, setPaths);
  result.logs = logs;
  return result;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'grb-datadir-'));

try {
  console.log('P0 userData 分流 / 迁移回归');

  /* ---- 1. 开发版：完全不动，也不碰程序目录 ---- */
  {
    const c = makeCase('dev');
    const r = run(c, { isPackaged: false });
    check('开发版 → APPDATA', r.dir, c.appData);
    check('开发版 installMode', r.mode, 'dev');
    check('开发版 setPath 两次', r.setPaths, [['userData', c.appData], ['sessionData', c.appData]]);
    check('开发版不建 data/', exists(path.join(c.exeDir, 'data')), false);
  }

  /* ---- 2. 绿色版（zip 带 portable.flag）---- */
  {
    const c = makeCase('green');
    touch(c.exeDir, 'portable.flag', 'portable\n');
    const r = run(c);
    check('绿色版 → exe 同级 data/', r.dir, path.join(c.exeDir, 'data'));
    check('绿色版 installMode', r.mode, 'portable');
    check('探测文件已清理', exists(path.join(c.exeDir, 'data', '.write-probe')), false);
    check('绿色版不动 APPDATA 设置', exists(path.join(c.appData, 'settings.json')), false);
  }

  /* ---- 3. 老 portable 单 exe：没有任何 flag 也按绿色版处理 ---- */
  {
    const c = makeCase('legacy-green');
    const r = run(c, { env: { PORTABLE_EXECUTABLE_DIR: c.exeDir } });
    check('老 portable 单 exe → data/', r.dir, path.join(c.exeDir, 'data'));
    check('PORTABLE_EXECUTABLE_DIR 生效', r.mode, 'portable');
  }

  /* ---- 4. 程序目录只读 → 回退 APPDATA ---- */
  {
    const c = makeCase('readonly');
    const r = run(c, {
      fsOverride: {
        writeFileSync(file, ...rest) {
          if (String(file).endsWith('.write-probe')) {
            const err = new Error('EPERM');
            err.code = 'EPERM';
            throw err;
          }
          return fs.writeFileSync(file, ...rest);
        }
      }
    });
    check('只读目录回退 APPDATA', r.dir, c.appData);
    check('只读目录 installMode', r.mode, 'fallback');
    check('有警告', r.logs.some((x) => x.startsWith('warn:')), true);
  }

  /* ---- 5. 安装版：installed.flag 优先，且绝不写 exe 同级 data/ ---- */
  {
    const c = makeCase('installed');
    touch(c.exeDir, 'installed.flag', 'installed\n');
    touch(c.exeDir, 'portable.flag', 'portable\n'); // 两个 flag 同时存在也不能误判
    const r = run(c);
    check('安装版 → APPDATA', r.dir, c.appData);
    check('安装版 installMode', r.mode, 'installed');
    check('安装版不建 exe/data', exists(path.join(c.exeDir, 'data')), false);
    check('无旧数据时不写迁移标记', exists(path.join(c.appData, '.migrated')), false);
  }

  /** 造一份旧绿色版数据 */
  function seedOld(c) {
    const data = path.join(c.oldRoot, 'data');
    touch(data, 'settings.json', JSON.stringify({ bearing: { rois: [{ cx: 0.14, cy: 0.25, r: 0.15 }] } }));
    touch(data, 'bearing-dump.png', 'fake-png');
    touch(data, 'Partitions/bili/Cookies', 'cookie-db');
    touch(data, 'Local State', 'os_crypt');
    touch(data, 'GPUCache/data_0', 'junk');
    return data;
  }

  /* ---- 6. 安装版迁移：默认只搬设置 + 标定，不搬登录态 ---- */
  {
    const c = makeCase('migrate-basic');
    const data = seedOld(c);
    touch(c.exeDir, 'installed.flag', 'installed\n');
    touch(c.exeDir, 'migrate-from.txt', `${data}\n`);
    const r = run(c);
    check('迁移后仍用 APPDATA', r.dir, c.appData);
    check('settings.json 已迁移', read(path.join(c.appData, 'settings.json')), read(path.join(data, 'settings.json')));
    check('调试截图一并迁移', read(path.join(c.appData, 'bearing-dump.png')), 'fake-png');
    check('默认不搬 Partitions', exists(path.join(c.appData, 'Partitions')), false);
    check('默认不搬 Local State', exists(path.join(c.appData, 'Local State')), false);
    check('Chromium 缓存不搬', exists(path.join(c.appData, 'GPUCache')), false);
    check('写了 .migrated 标记', exists(path.join(c.appData, '.migrated')), true);
    const marker = JSON.parse(read(path.join(c.appData, '.migrated')));
    check('标记记录来源', marker.from, data);
    check('标记记录不含登录态', marker.withLogin, false);
    check('旧目录仍是完整可用的', read(path.join(data, 'settings.json')).includes('rois'), true);
  }

  /* ---- 7. 安装页勾选登录态：Partitions + Local State 一起搬 ---- */
  {
    const c = makeCase('migrate-login');
    const data = seedOld(c);
    touch(c.exeDir, 'installed.flag', 'installed\n');
    touch(c.exeDir, 'migrate-from.txt', `${data}\nincludeLogin=1\n`);
    const r = run(c);
    check('includeLogin 被识别', r.includeLogin(), true);
    check('Partitions 子目录已复制', read(path.join(c.appData, 'Partitions/bili/Cookies')), 'cookie-db');
    check('Local State 已复制', read(path.join(c.appData, 'Local State')), 'os_crypt');
    check('GPUCache 仍不复制', exists(path.join(c.appData, 'GPUCache')), false);
    check('标记记录含登录态', JSON.parse(read(path.join(c.appData, '.migrated'))).withLogin, true);
  }

  /* ---- 8. 幂等：已有 .migrated 就不再跑，绝不覆盖用户后来改的设置 ---- */
  {
    const c = makeCase('migrate-idempotent');
    const data = seedOld(c);
    touch(c.exeDir, 'installed.flag', 'installed\n');
    touch(c.exeDir, 'migrate-from.txt', `${data}\n`);
    run(c);
    put(path.join(c.appData, 'settings.json'), '{"edited":true}');
    put(path.join(data, 'settings.json'), '{"old":true}');
    const r = run(c);
    check('第二次启动不覆盖设置', read(path.join(c.appData, 'settings.json')), '{"edited":true}');
    check('第二次仍是 installed', r.mode, 'installed');
    check('迁移函数返回已初始化', r.migrate(c.appData), { ok: false, reason: 'already-initialized' });
  }

  /* ---- 9. 目标里已有 settings.json（用户已配置过）→ 不覆盖 ---- */
  {
    const c = makeCase('target-exists');
    const data = seedOld(c);
    touch(c.exeDir, 'installed.flag', 'installed\n');
    touch(c.exeDir, 'migrate-from.txt', `${data}\n`);
    put(path.join(c.appData, 'settings.json'), '{"mine":true}');
    run(c);
    check('已有设置不被旧数据覆盖', read(path.join(c.appData, 'settings.json')), '{"mine":true}');
    check('不写迁移标记', exists(path.join(c.appData, '.migrated')), false);
  }

  /* ---- 10. 环境变量指向绿色版根目录 → 自动补 /data ---- */
  {
    const c = makeCase('env-root');
    seedOld(c);
    touch(c.exeDir, 'installed.flag', 'installed\n');
    const r = run(c, { env: { GRB_MIGRATE_FROM: c.oldRoot } });
    check('候选项自动补 data/', r.candidates(c.appData).includes(path.join(c.oldRoot, 'data')), true);
    check('env 来源也能迁移', read(path.join(c.appData, 'settings.json')).includes('rois'), true);
  }

  /* ---- 11. 就地覆盖安装：exe 同级就摆着旧 data/ ---- */
  {
    const c = makeCase('inplace');
    const data = path.join(c.exeDir, 'data');
    touch(data, 'settings.json', '{"inplace":true}');
    touch(c.exeDir, 'installed.flag', 'installed\n');
    run(c);
    check('就地覆盖场景自动迁移', read(path.join(c.appData, 'settings.json')), '{"inplace":true}');
  }

  /* ---- 12. 来源不存在 / 复制失败都不能拖垮启动 ---- */
  {
    const c = makeCase('missing-source');
    touch(c.exeDir, 'installed.flag', 'installed\n');
    touch(c.exeDir, 'migrate-from.txt', path.join(c.base, 'does-not-exist') + '\n');
    const r = run(c);
    check('无效来源仍正常启动', r.dir, c.appData);
    check('无垃圾文件', exists(path.join(c.appData, 'settings.json')), false);

    const c2 = makeCase('copy-fails');
    const data = seedOld(c2);
    touch(c2.exeDir, 'installed.flag', 'installed\n');
    touch(c2.exeDir, 'migrate-from.txt', `${data}\n`);
    const r2 = run(c2, {
      fsOverride: {
        copyFileSync(file, ...rest) {
          const err = new Error('EACCES');
          err.code = 'EACCES';
          throw err;
        }
      }
    });
    check('复制失败仍正常启动', r2.dir, c2.appData);
    check('复制失败有警告', r2.logs.some((x) => x.includes('EACCES')), true);
  }

  /* ---- 13. 源码契约：boot 里要暴露 installMode，且注释别退回旧说法 ---- */
  check('boot 暴露 installMode', /dataDir: app\.getPath\('userData'\)[\s\S]{0,160}installMode/.test(mainSrc), true);
  check('boot portable 改用 installMode', /portable: installMode === 'portable'/.test(mainSrc), true);
  check('不再用旧的路径比较判 portable', /userData'\) === path\.join/.test(mainSrc), false);
} finally {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
}

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exitCode = fail ? 1 : 0;

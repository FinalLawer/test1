'use strict';
/* 手动「自动定心」离线回归（2026-11-12）。
 *
 * 验证 src/webview-preload.js 里的手动定心：beginAutoCenter / autoCenterStep / decideAutoCenter。
 * 从真实源码抠出函数，用 500 帧离线 ROI 假装 <video>（假 canvas 1:1 复制），
 * 模拟「用户在某一刻点了一次自动定心」：只跑一次、20 秒内算准就固定，失败就不改。
 *
 * 指标（箭头方向没有人工真值，统一以「最佳圆心」为参照）：
 *   · 相对最佳圆心误差 <10° 的帧数（越多越好）
 *   · >30° 的帧数（越少越好）
 *   · 是否算出修正、修正误差、尝试次数
 *
 * 起点覆盖用户框选可能偏多少：0、±4.7（打包版默认 SEED）、±8、±12、±18。
 * 只读源码与离线帧，不启动应用、不连调试端口、不碰设置文件。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');
const TMP = path.join(os.tmpdir(), 'vidframes500');
const SRC = fs.readFileSync(path.join(ROOT, 'src/webview-preload.js'), 'utf8').replace(/\r\n/g, '\n');

function slice(from, to) {
  const a = SRC.indexOf(from);
  const b = SRC.indexOf(to, a);
  if (a < 0 || b <= a) throw new Error(`源码锚点没找到：${from}`);
  return SRC.slice(a, b);
}

const HELPERS = slice('function cyanScore(', '/* ---------------------------------------------------------------- 扇形通道');
const GRAB = slice('function bearingCanvas(', '/**\n * 读一帧的箭头朝向');
const AC = slice('const AC_KAPPA', '/**\n * 启动识别循环。');
const clampSrc = slice('function clamp(', 'function safePlay(');

const man = JSON.parse(fs.readFileSync(path.join(TMP, 'vidroi500.json'), 'utf8'));
const blob = fs.readFileSync(path.join(TMP, 'vidroi500.bin'));
const S0 = man.list[0].size; // 363
const frames = man.list.map((e) => ({
  t: e.t,
  data: new Uint8ClampedArray(blob.buffer, blob.byteOffset + e.off, e.size * e.size * 4)
}));

/* ---------- 假 video / canvas / ipcRenderer ---------- */
const video = { videoWidth: S0, videoHeight: S0, paused: false, ended: false, __frame: null };
const document = {
  createElement() {
    const c = { width: 0, height: 0 };
    const ctx = {
      clearRect() {},
      drawImage(_v, sx, sy, sw, sh, dx, dy) {
        const need = c.width * c.height * 4;
        if (!c.__buf || c.__buf.length !== need) c.__buf = new Uint8ClampedArray(need);
        const src = video.__frame;
        for (let y = 0; y < sh; y += 1) {
          const off = ((sy + y) * S0 + sx) * 4;
          c.__buf.set(src.subarray(off, off + sw * 4), ((dy + y) * c.width + dx) * 4);
        }
      },
      getImageData(x, y, w, h) {
        return { data: c.__buf.slice(0, w * h * 4), width: w, height: h };
      }
    };
    c.getContext = () => ctx;
    return c;
  }
};
let lastResult = null;
const ipcRenderer = {
  sendToHost(channel, payload) {
    if (channel === 'bearing-autocenter' && payload && payload.phase === 'done') lastResult = payload;
  }
};

function makeAuto() {
  return { active: false, trim: { x: 0, y: 0 }, votes: [], attempts: 0, lastAttemptAt: 0, deadline: 0 };
}

const quiet = { log() {}, warn() {}, error() {} };
const BEARING = { auto: makeAuto() };
const api = new Function(
  'BEARING',
  'video',
  'document',
  'clamp',
  'console',
  'ipcRenderer',
  HELPERS + '\n' + GRAB + '\n' + AC + '\n' + clampSrc +
    ';return { analyze, angDiff, grabCenter, cropCenterWindow, beginAutoCenter, autoCenterStep, resetAutoCenter };'
)(BEARING, video, document, (n, lo, hi) => Math.max(lo, Math.min(hi, n)), quiet, ipcRenderer);

const { analyze, angDiff, grabCenter, cropCenterWindow, beginAutoCenter, autoCenterStep, resetAutoCenter } = api;

/* ---------- 参照：最佳圆心（dx=2, dy=1） ---------- */
const BEST = { dx: 2, dy: 1 };
const ROI_R = (0.1496538 * 1920) / S0; // 287/363：几何窗 178、扇形窗 363（整帧）
const c0 = (S0 - 1) / 2;
const roiAt = (dx, dy) => ({ cx: (c0 + dx + 0.5) / S0, cy: (c0 + dy + 0.5) / S0, r: ROI_R });

function arrowAt(dx, dy, trimX, trimY) {
  const big = grabCenter(roiAt(dx, dy), 1.5, 512, trimX, trimY);
  const g = big ? cropCenterWindow(big, roiAt(dx, dy), 0.62, 320, trimX, trimY) : null;
  return g ? analyze(g.img, g.size, g.step) : { valid: false, angle: 0, conf: 0 };
}

function mapPresent(i) {
  const d = frames[i].data;
  let n = 0;
  let hit = 0;
  for (let y = 0; y < S0; y += 2) {
    for (let x = 0; x < S0; x += 2) {
      const k = (y * S0 + x) * 4;
      n += 1;
      if (Math.min(d[k + 1], d[k + 2]) - d[k] >= 80) hit += 1;
    }
  }
  return hit / n >= 0.0015;
}

const ref = frames.map((f) => {
  video.__frame = f.data;
  return arrowAt(BEST.dx, BEST.dy, 0, 0);
});
const hasMap = frames.map((_f, i) => mapPresent(i));
console.log(`帧数 ${frames.length}，有小地图 ${hasMap.filter(Boolean).length}，参照（最佳圆心）有效 ${ref.filter((r) => r.valid).length}`);

/* ---------- 单次模拟：一个起点、一次点击 ---------- */
function simulate(dx0, dy0, startIdx) {
  BEARING.auto = makeAuto();
  lastResult = null;
  resetAutoCenter();
  const roi = roiAt(dx0, dy0);
  const stat = { near: 0, wrong: 0, mid: 0, valid: 0, ref: 0 };
  const base = { near: 0, wrong: 0, valid: 0 };

  beginAutoCenter(frames[startIdx].t * 1000);

  for (let n = 0; n < frames.length; n += 1) {
    const i = (startIdx + n) % frames.length;
    const f = frames[i];
    video.__frame = f.data;
    const tx = BEARING.auto.trim.x;
    const ty = BEARING.auto.trim.y;

    const big = grabCenter(roi, 1.5, 512, tx, ty);
    const g = big ? cropCenterWindow(big, roi, 0.62, 320, tx, ty) : null;
    const r = g ? analyze(g.img, g.size, g.step) : { valid: false, angle: 0, conf: 0 };
    const b = arrowAt(dx0, dy0, 0, 0);

    if (ref[i].valid) {
      stat.ref += 1;
      for (const [o, t] of [[r, stat], [b, base]]) {
        if (!o.valid) continue;
        t.valid += 1;
        const e = Math.abs(angDiff(o.angle, ref[i].angle));
        if (e < 10) t.near += 1;
        else if (e > 30) t.wrong += 1;
        else t.mid = (t.mid || 0) + 1;
      }
    }

    if (BEARING.auto.active) autoCenterStep(roi, 0, big, hasMap[i], f.t * 1000);
  }

  const res = lastResult || { ok: false, reason: 'no-result' };
  const applied = !!(res.ok && res.applied);
  const finalErr = applied ? Math.hypot(res.dx - (BEST.dx - dx0), res.dy - (BEST.dy - dy0)) : null;
  return { stat, base, res, applied, finalErr, trim: { ...BEARING.auto.trim } };
}

/* ---------- 批量 ---------- */
const starts = [
  [0, 0],
  [BEST.dx, BEST.dy],
  [-4.7, 1.9],
  [0, 11.6],
  [-8, -8],
  [8, 8],
  [12, 0],
  [0, -12],
  [-12, 6],
  [15, 15],
  [-18, 10]
];
const startIdxList = [0, 250];

console.log('\n起点(dx,dy)    起点帧 | 现状 对/错/有效 | 定心后 对/错/有效 | 结果            修正误差');
const total = { ref: 0, baseNear: 0, baseWrong: 0, near: 0, wrong: 0, applied: 0, hit: 0, runs: 0 };
for (const [dx0, dy0] of starts) {
  for (const s of startIdxList) {
    const r = simulate(dx0, dy0, s);
    total.ref += r.stat.ref;
    total.baseNear += r.base.near;
    total.baseWrong += r.base.wrong;
    total.near += r.stat.near;
    total.wrong += r.stat.wrong;
    total.runs += 1;
    if (r.applied) total.hit += 1;
    total.applied += r.applied ? 1 : 0;
    const why = r.applied ? `修正 (${r.res.dx},${r.res.dy})` : r.res.ok ? '本来就准' : `失败:${r.res.reason}`;
    console.log(
      `(${String(dx0).padStart(5)},${String(dy0).padStart(5)}) ${String(s).padStart(4)} | ` +
        `${String(r.base.near).padStart(3)}/${String(r.base.wrong).padStart(3)}/${String(r.base.valid).padStart(3)} | ` +
        `${String(r.stat.near).padStart(3)}/${String(r.stat.wrong).padStart(3)}/${String(r.stat.valid).padStart(3)} | ` +
        `${why.padEnd(18)} ${r.finalErr === null ? '-' : r.finalErr.toFixed(1) + 'px'}`
    );
  }
}
const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) : '0.0');
console.log(
  `\n合计 ${total.runs} 组、参照有效帧 ${total.ref}：` +
    `现状 对 ${total.baseNear}（${pct(total.baseNear, total.ref)}%）错 ${total.baseWrong}；` +
    `定心后 对 ${total.near}（${pct(total.near, total.ref)}%）错 ${total.wrong}；` +
    `算出并应用修正 ${total.applied}/${total.runs} 组`
);
// 成功应用修正的组，误差必须在 3px 内
if (total.applied > 0 && total.near <= total.baseNear) process.exitCode = 1;

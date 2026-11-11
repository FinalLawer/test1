'use strict';

/**
 * 注入到 B 站页面（player.bilibili.com / www.bilibili.com）的访客脚本。
 * 通过 <webview> 的 preload 运行，能直接操作页面里的 <video>，
 * 因此全局快捷键可以真正控制 B 站播放器（含其自有 UI 播放时）。
 */

const { ipcRenderer } = require('electron');

/* --------------------------------------------------- 全屏行为改写 */

/**
 * B 站播放器的全屏按钮、双击视频，最终都走 Element.requestFullscreen()。
 * 那样会把 <video> 铺满整个客户端，连我们自己的标题栏和设置按钮一起盖掉
 * —— 用户会「找不到设置」。这里拦下来，改成让整个浮窗窗口全屏：
 * 视频照样放大到满屏，而标题栏、设置抽屉仍然是窗口里的普通 DOM，随时能点。
 */
try {
  const notify = (on) => ipcRenderer.sendToHost('want-window-fullscreen', on);

  Element.prototype.requestFullscreen = function requestFullscreen() {
    notify(true);
    return Promise.resolve();
  };
  Element.prototype.webkitRequestFullscreen = Element.prototype.requestFullscreen;
  Element.prototype.mozRequestFullScreen = Element.prototype.requestFullscreen;

  document.exitFullscreen = function exitFullscreen() {
    notify(false);
    return Promise.resolve();
  };
  document.webkitExitFullscreen = document.exitFullscreen;
  document.mozCancelFullScreen = document.exitFullscreen;
} catch {
  /* 改写失败就退回原生行为，不影响播放 */
}

let video = null;
let cleanOn = false;
let cleanStyle = null;

/* ------------------------------------------------------------- 元素发现 */

function visibleArea(v) {
  const r = v.getBoundingClientRect();
  if (r.width < 80 || r.height < 60) return 0;
  const st = getComputedStyle(v);
  if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return 0;
  return r.width * r.height;
}

function pickVideo() {
  const list = Array.from(document.querySelectorAll('video'));
  if (!list.length) return null;
  let best = null;
  let bestArea = 0;
  for (const v of list) {
    const a = visibleArea(v);
    if (a > bestArea) {
      bestArea = a;
      best = v;
    }
  }
  return best || list[0];
}

const EVENTS = [
  'play', 'pause', 'timeupdate', 'durationchange', 'loadedmetadata',
  'ratechange', 'volumechange', 'ended', 'waiting', 'playing',
  'seeking', 'seeked', 'error', 'canplay', 'emptied'
];

function bind(v) {
  if (!v || v === video) return;
  if (video) {
    for (const ev of EVENTS) video.removeEventListener(ev, onEvent, true);
  }
  video = v;
  for (const ev of EVENTS) v.addEventListener(ev, onEvent, true);
  console.log('[跟跑助手] 已接管视频元素', v.currentSrc || v.src || '');
  push(true);
}

function onEvent() {
  push();
}

/* --------------------------------------------------------------- 状态上报 */

/**
 * B 站视频页形如 /video/BV1xx411c7mD/?p=3&autoplay=1。
 * 一 P 播完自动连播下一 P 时，播放器会把 ?p= 改掉（整页导航或 SPA 都可能），
 * 但浮窗的 state.p 只在用户手动 loadVideo 时更新过，下拉框会一直停在旧页码。
 * 所以把页码和视频 id 随每次状态一起带回，让浮窗自己校准。
 */
function partFromUrl(u) {
  const m = /[?&](?:p|page)=(\d+)/.exec(String(u || ''));
  const n = m ? Number(m[1]) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function idFromUrl(u) {
  const m = /\/video\/(BV[0-9A-Za-z]{10}|av\d+)/i.exec(String(u || ''));
  return m ? m[1].toLowerCase() : '';
}

function snapshot() {
  const p = partFromUrl(location.href);
  const vid = idFromUrl(location.pathname);
  if (!video || !video.isConnected) return { found: false, p, vid };
  const d = video.duration;
  return {
    found: true,
    p,
    vid,
    playing: !video.paused && !video.ended,
    current: video.currentTime || 0,
    duration: Number.isFinite(d) && d > 0 ? d : 0,
    rate: video.playbackRate || 1,
    muted: video.muted || video.volume === 0,
    volume: video.muted ? 0 : video.volume,
    ready: video.readyState >= 3,
    title: document.title.replace(/\s*[-_]\s*bilibili.*$/i, '').trim()
  };
}

function push(force) {
  try {
    ipcRenderer.sendToHost('state', snapshot());
  } catch {
    /* 页面正在卸载 */
  }
}

/* ------------------------------------------- 小地图朝向识别（方位标记） */

/**
 * 从视频帧的左上角小地图里读出「角色朝向的世界方位角」。
 *
 * 前提：博主的小地图必须是「固定北朝上」。如果小地图随角色旋转，
 * 中央箭头恒朝上，读出来永远是 0°，方位信息不存在。
 *
 * 做法：小地图以玩家为圆心渲染，中央是青蓝色的角色朝向箭头。
 * 从圆心向外按 2° 步进做径向扫描，统计每个方向的「青色强度」积分，
 * 峰值方向就是箭头指向。纯几何，不需要模板也不需要 OpenCV。
 */
const BEARING = {
  enabled: false,
  /**
   * 识别区域列表。同一个视频里画面布局会变 ——
   * 平时是游戏原生的迷你小地图（左上角），讲到路线时常常是剪辑放大的地图贴片，
   * 两者大小、位置完全不同。用单一区域必然一半时间在瞎读，所以按列表存多块，
   * 每帧挑最可信的一块用。
   */
  rois: [],
  canvas: null,
  ctx: null,
  timer: null,
  // requestVideoFrameCallback 的句柄：有新视频帧才算，天然和画面同步
  rvfc: null,
  // 守护定时器：B 站换分 P 可能换掉 <video>，换了要重挂循环
  guard: null,
  loopKind: '',
  lastAngle: -1,
  // 自适应低通的当前值；-1 表示还没初始化
  smooth: -1,
  lastSentAt: 0,
  /**
   * α-β 滤波状态。
   *   theta    当前角度（数学角）
   *   omega    角速度，度/秒 —— 匀速转身时靠它消除滞后
   *   t        上次更新时间戳
   *   suspect  连续的「180° 大跳」累计次数，用来区分真掉头和误认
   */
  ab: { theta: -1, omega: 0, t: 0, suspect: 0 },
  /**
   * 视角通道状态（只由白色扇形驱动）。
   *
   * 视角和行进是**两个独立的量**：原神里角色永远朝跑动方向，但镜头可以
   * 随便转 —— 站着不动把鼠标往后拉，人没动、视角转了 180°。所以这里
   * 单独一套状态，绝不能被 smoothBearing 的门限或角速度污染。
   *
   *   theta    平滑后的视角角（数学角）
   *   conf     最近一次的置信度
   *   src      来源标记：cone / hold / pending
   *   t        上次更新时间
   *   pending  挂起待确认的大跳角度，-1 表示没有。
   *            500 帧密集序列证实 t=111.37 / 117.31 两处误检都是**孤立单帧脉冲**，
   *            且高 conf 会绕过平滑直接上屏，必须等下一个有效帧复核。
   */
  view: { theta: -1, conf: 0, src: '', t: 0, sent: -1, pending: -1 },
  // 最近几帧的原始角度，用来做圆形中值（剔除「认成三角形另一个角」这类野值）
  raw: [],
  invalidSince: 0,
  reportedValid: null,
  explained: false,
  logged: false
};

function bearingCanvas(size) {
  if (!BEARING.canvas) {
    BEARING.canvas = document.createElement('canvas');
    BEARING.ctx = BEARING.canvas.getContext('2d', { willReadFrequently: true });
  }
  if (BEARING.canvas.width !== size) {
    BEARING.canvas.width = size;
    BEARING.canvas.height = size;
  }
  return BEARING.ctx;
}

/**
 * 抠出小地图中央区域。
 *
 * 两个关键点：
 *
 * 1. **1:1 原始像素，不做缩放。** 一旦缩放，双线性插值会把箭头那条青色描边
 *    和地形混在一起，min(g,b)-r 直接掉一半 —— 这是「换个画质就判不出来」的根源。
 *    窗口过大时改为**隔点采样**（整数步长），只丢采样点、不动颜色。
 *
 * 2. 窗口取小地图半径的 **0.62 倍**，圆心直接用用户框选出来的那个点。
 *    放大到 1.2 倍是错的：那样会把传送锚点、神瞳这些青色图标一起框进来，
 *    它们比箭头伸得更远，会让「最远点就是尖端」这类判据整体失效。
 */
function grabCenter(roi, scale = 0.62, cap = 320) {
  if (!video || !video.videoWidth || !video.videoHeight) return null;

  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const mapR = Math.max(18, roi.r * vw);
  // 几何通道默认只取小地图半径的 0.62 倍 —— 圆心是用户框出来的**真圆心**，
  // 箭头就住在这附近。放大到 1.2 倍会把传送点、神瞳这些青色图标一起框进来，
  // 它们比箭头伸得更远，「最远青点」就锁到图标上，角度直接飞掉。
  //
  // 扇形通道反过来：视锥从圆心一路铺到小地图边缘，是**全局结构**。
  // 0.62R 的中心小窗只看得到 0.10R~0.30R，那里 alpha 还在平台期，
  // 「越往圆心越白」这个最本质的证据根本没展开。故扇形单独用大窗口。
  // 大窗口向画面边界让位，保证窗口始终以玩家为几何中心（极坐标不能偏）。
  const want = Math.round(clamp(mapR * scale, 64, cap));
  const roomX = 2 * Math.min(roi.cx, 1 - roi.cx) * vw;
  const roomY = 2 * Math.min(roi.cy, 1 - roi.cy) * vh;
  const size = Math.max(64, Math.min(want, vw, vh, Math.floor(Math.min(roomX, roomY))));
  const sx = Math.round(roi.cx * vw - size / 2);
  const sy = Math.round(roi.cy * vh - size / 2);

  if (sx < 0 || sy < 0 || sx + size > vw || sy + size > vh) return null;

  const ctx = bearingCanvas(size);
  try {
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(video, sx, sy, size, size, 0, 0, size, size);
    // 512² 全采是 26 万像素，30fps 下太重；隔点采样把像素数压到 6.5 万以内，
    // 且因为是整数采样点，颜色值仍然是原始值（不像缩放会插值出新颜色）。
    const step = size > 320 ? 2 : 1;
    return { img: ctx.getImageData(0, 0, size, size), size, step };
  } catch {
    // 视频源跨域时 canvas 会被污染，读像素会抛 SecurityError
    return null;
  }
}

/**
 * 读一帧的箭头朝向。
 *
 * 处理顺序：
 *   1. 青色阈值（p99 自适应 + 高下限，草地阴影能到 20~90，箭头约 166）
 *   2. 二值 mask → **最大连通块**。小地图上还有传送锚点、神瞳等青色，
 *      但角色箭头是唯一「贴着圆心、成片、实心」的那块，按面积就能摘出来
 *   3. 72 格径向 far 剖面 → 取局部极大作为「角」的候选
 *   4. 每个候选角用 ±16° / ≥92% 半径的扇区做圆形平均，得到亚像素精度的角位
 *   5. 枚举三点组合，按飞镖的对称性挑出「钝鼻 + 两片尖尾」，输出尾巴中分线的反向
 *
 * 第 5 步的细节和第 3、4 步为什么这样取，见下方注释块 —— 那里记录了实测数据和
 * 「取最远点会反向 180°」这个曾经的致命错误。
 */
/** 青色分数。原神箭头约 rgb(34,200,232)，草地/雪地/棕色地形都接近 0 */
function cyanScore(r, g, b) {
  return Math.min(g, b) - r;
}

function analyze(img, size, step) {
  const d = img.data;
  const c0 = (size - 1) / 2;

  // 阈值按本帧自适应，但**下限必须很高**。
  // 实测：原神草地/树影的阴影处 min(g,b)-r 能有 20~90，而角色箭头约 166。
  // 之前把阈值放到 36，结果满屏草地都被当成青色，质心随机乱指 —— 这也解释了
  // 为什么「换个场景就偏到别处」。所以门限抬到 110 上下，只留接近纯青的像素。
  const probeStep = Math.max(step, 4);
  const probe = [];
  for (let y = 0; y < size; y += probeStep) {
    for (let x = 0; x < size; x += probeStep) {
      const i = (y * size + x) * 4;
      probe.push(cyanScore(d[i], d[i + 1], d[i + 2]));
    }
  }
  if (!probe.length) return { valid: false, angle: 0, conf: 0, cyans: 0, tipFrac: 0, spread: 180 };
  probe.sort((a, b) => a - b);
  const p99 = probe[Math.min(probe.length - 1, Math.floor(probe.length * 0.99))];
  // 整块画面里都没有接近纯青的像素 → 这一帧根本没有箭头（转场 / 特写 / 对话）
  if (p99 < 100) return { valid: false, angle: 0, conf: 0, cyans: 0, tipFrac: 0, spread: 180 };
  const thr = Math.max(112, p99 * 0.74);

  const rMin = size * 0.04;
  // 有效半径收到窗口的一半：角色箭头从圆心伸出约 0.13 倍小地图半径，
  // 而青色图标在 0.3 倍开外，这条线把它们分开
  const rMax = size * 0.5;

  // 二值 mask → 连通块。这一步是整版最关键的结构性改动：
  // 小地图上除了角色箭头，还有传送锚点、神瞳、水域等零散青色。
  // 只要其中任何一个比箭头伸得远，「最远点就是尖端」就会被它劫持
  // （实测能把角度带偏 100° 以上，表现就是「指到旁边的图标上」）。
  // 而角色箭头是**唯一一块实心、成片、贴着圆心**的青色 —— 按连通块面积就能单独摘出来。
  const mask =
    BEARING.mask && BEARING.mask.length === size * size ? BEARING.mask : new Uint8Array(size * size);
  BEARING.mask = mask;
  BEARING.maskMeta = { size, step };
  mask.fill(0);

  let cyans = 0;
  for (let y = 0; y < size; y += step) {
    const dy = c0 - y; // 屏幕 y 向下，翻成数学坐标（y 向上）
    for (let x = 0; x < size; x += step) {
      const i = (y * size + x) * 4;
      if (cyanScore(d[i], d[i + 1], d[i + 2]) < thr) continue;
      const dx = x - c0;
      const rho = Math.sqrt(dx * dx + dy * dy);
      if (rho < rMin || rho > rMax) continue;
      mask[y * size + x] = 1;
      cyans += 1;
    }
  }

  const empty = { valid: false, angle: 0, conf: 0, cyans, tipFrac: 0, spread: 180 };
  if (cyans < 12) return empty;

  const lbl =
    BEARING.lbl && BEARING.lbl.length === size * size ? BEARING.lbl : new Int32Array(size * size);
  BEARING.lbl = lbl;
  lbl.fill(0);
  const stack =
    BEARING.stack && BEARING.stack.length === size * size
      ? BEARING.stack
      : new Int32Array(size * size);
  BEARING.stack = stack;

  const cells = size * size;
  let bestId = 0;
  let bestArea = 0;
  let bestCx = 0;
  let bestCy = 0;
  let compId = 0;

  for (let seed = 0; seed < cells; seed += 1) {
    if (!mask[seed] || lbl[seed]) continue;
    compId += 1;
    lbl[seed] = compId;
    let top = 0;
    stack[top++] = seed;
    let area = 0;
    let sumX = 0;
    let sumY = 0;

    while (top) {
      const cur = stack[--top];
      const py = (cur / size) | 0;
      const px = cur - py * size;
      area += 1;
      sumX += px;
      sumY += py;

      for (let k = 0; k < 4; k += 1) {
        const nx = px + (k === 0 ? step : k === 1 ? -step : 0);
        const ny = py + (k === 2 ? step : k === 3 ? -step : 0);
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const n = ny * size + nx;
        if (!mask[n] || lbl[n]) continue;
        lbl[n] = compId;
        stack[top++] = n;
      }
    }

    if (area > bestArea) {
      bestArea = area;
      bestId = compId;
      bestCx = sumX / area;
      bestCy = sumY / area;
    }
  }

  if (!bestId) return empty;

  const bcDx = bestCx - c0;
  const bcDy = c0 - bestCy;
  const bcRho = Math.sqrt(bcDx * bcDx + bcDy * bcDy);
  // 重心必须贴着圆心，否则多半是窗外漏进来的地形青
  if (bcRho > rMax * 0.85) return empty;

  /* ---------------------------------------------------------- 三角几何定鼻尖
   *
   * 实测（誓言岬 P2 25~31 秒，12 帧）：角色箭头是一个**钝鼻 + 两个尖锐尾巴**的
   * 飞镖形。三个角的位置极其稳定：
   *     tails:  5°（r≈38.5）   265°（r≈36）
   *     nose: 128°（r≈28.5）—— 半径最小、而且是个圆钝的凸包
   * 而这一段的行进方向（用小地图平移量标定）是 135~139°。
   *
   * 所以真正指向的是**半径最小的那个钝角**，两个尖角是尾巴。
   * 之前取「离圆心最远的点」，拿到的正是尾巴，输出刚好反 180°——
   * 这就是「箭头乱指」的根因。
   *
   * 光按半径排序不够稳：尾巴一旦被白色星标/图标压住，半径会掉到鼻子以下，
   * 结果就翻 180°。所以再加一条几何约束——飞镖是**对称**的，两个尾巴之间的
   * 夹角明显小于尾巴到鼻子的夹角（实测 100° vs 123°/137°）。
   * 两条证据加权投票：|角度余量| 占主导，半径余量做修正。
   */
  const NB = 72; // 5° 一格
  const far = new Float32Array(NB);
  for (let i2 = 0; i2 < cells; i2 += 1) {
    if (lbl[i2] !== bestId) continue;
    const py = (i2 / size) | 0;
    const px = i2 - py * size;
    const ddx = px - c0;
    const ddy = c0 - py;
    const rr = Math.sqrt(ddx * ddx + ddy * ddy);
    let a = (Math.atan2(ddy, ddx) * 180) / Math.PI;
    if (a < 0) a += 360;
    const b = Math.min(NB - 1, (a * NB / 360) | 0);
    if (rr > far[b]) far[b] = rr;
  }

  // 环形三点平滑，只为压掉量化毛刺（找峰用），不影响后面的精修
  const sm = new Float32Array(NB);
  for (let i2 = 0; i2 < NB; i2 += 1) {
    sm[i2] = (far[(i2 - 1 + NB) % NB] + far[i2] * 2 + far[(i2 + 1) % NB]) / 4;
  }

  let peakMax = 0;
  for (let i2 = 0; i2 < NB; i2 += 1) if (sm[i2] > peakMax) peakMax = sm[i2];
  if (peakMax < size * 0.06) return empty;

  /* 角的「支撑宽度」——用来区分钝鼻、尖尾、凹口。
   *
   * 飞镖形的三个特征角在角度剖面上长得完全不一样：
   *   · 鼻子是圆钝凸包 → 沿角度方向连续好几格都有材料，支撑宽（实测 30~40°）
   *   · 尾巴是尖锐的翼尖 → 只有一两格，支撑窄（5~10°）
   *   · 凹口是往里的 V 形尖 → 更窄，通常只占一格
   *
   * 这条判据和「半径最小」互补：鼻子和凹口的半径都小（凹口甚至更小），
   * 光看半径分不开，但看宽窄一眼就能分开。而且它对整体旋转免疫 —— 箭头转
   * 180° 之后钝的仍然是钝的，尖的仍然是尖的，不会像半径判据那样被遮挡带偏。
   */
  const spanOf = (idx) => {
    // 阈值必须相对**这个峰自己的高度**。之前用 peakMax*0.15 判断「有没有材料」，
    // 结果箭头是实心的、每个方向都有材料，量出来全都是满宽，判据等于没做。
    const thr = far[idx] * 0.86;
    let n = 1;
    for (let s = 1; s < 13; s += 1) {
      const l = far[(idx - s + NB) % NB];
      const r2 = far[(idx + s) % NB];
      const okL = l >= thr;
      const okR = r2 >= thr;
      // 两侧都断了才算结束，避免单侧被图标切断时低估宽度
      if (!okL && !okR) break;
      if (okL) n += 1;
      if (okR) n += 1;
    }
    return n;
  };

  const cands = [];
  for (let i2 = 0; i2 < NB; i2 += 1) {
    const v = sm[i2];
    if (v < peakMax * 0.5) continue;
    if (v < sm[(i2 - 1 + NB) % NB] || v < sm[(i2 + 1) % NB]) continue;
    const a2 = (i2 * 360) / NB;
    if (cands.every((o) => Math.abs(angDiff(o.deg, a2)) >= 25)) {
      cands.push({ deg: a2, far: v, idx: i2, span: spanOf(i2), tx: 0, ty: 0, tn: 0, rmax: 0 });
    }
    if (cands.length >= 6) break;
  }
  if (!cands.length) return empty;

  // 一趟扫描，顺手把所有候选峰一起精修
  for (let i2 = 0; i2 < cells; i2 += 1) {
    if (lbl[i2] !== bestId) continue;
    const py = (i2 / size) | 0;
    const px = i2 - py * size;
    const ddx = px - c0;
    const ddy = c0 - py;
    const rr = Math.sqrt(ddx * ddx + ddy * ddy);
    for (let k = 0; k < cands.length; k += 1) {
      const c = cands[k];
      // 先用半径快速筛掉绝大多数像素，再算角度
      if (rr < c.far * 0.92) continue;
      let a = (Math.atan2(ddy, ddx) * 180) / Math.PI;
      if (a < 0) a += 360;
      if (Math.abs(angDiff(a, c.deg)) > 16) continue;
      c.tx += ddx / rr;
      c.ty += ddy / rr;
      c.tn += 1;
      if (rr > c.rmax) c.rmax = rr;
    }
  }

  const corners = [];
  for (const c of cands) {
    if (!c.tn) continue;
    corners.push({ deg: degOf(c.tx, c.ty), far: c.rmax || c.far, span: c.span });
  }
  if (corners.length < 2) return empty;

  /* 从任意三点里挑「鼻子 + 两个尾巴」。
   *
   * 不再只按半径取前三：窗口里一旦混进传送点/神瞳那种又远又亮的青色，
   * 它的半径会排在真鼻子前面，把真鼻子挤出候选。改成枚举所有三点组合，
   * 用飞镖的对称性打分——真正的三点里，两个尾巴的夹角明显小于它们到鼻子的夹角，
   * 而且鼻子的半径最小。错误的组合会在两项上都拿负分，自然被排除。 */
  const evalTriple = (n, t1, t2) => {
    const sep = Math.abs(angDiff(t1.deg, t2.deg));
    const o1 = Math.abs(angDiff(n.deg, t1.deg));
    const o2 = Math.abs(angDiff(n.deg, t2.deg));
    const angMargin = Math.min(o1, o2) - sep;
    const radMargin = (Math.min(t1.far, t2.far) - n.far) / Math.max(1, n.far);
    const radSym = 1 - Math.min(1, Math.abs(t1.far - t2.far) / Math.max(1, t1.far, t2.far));

    // 尾巴中分线 → 鼻子理应落在它的正对面
    const axis = (t1.deg + angDiff(t2.deg, t1.deg) / 2 + 720) % 360;
    const want = (axis + 180) % 360;
    const bisErr = Math.abs(angDiff(n.deg, want));

    // 钝/尖：鼻子比两条尾巴都「宽」（-1 表示鼻子反而更尖，+1 表示明显更钝）
    const tailSpan = (t1.span + t2.span) / 2;
    const noseFlat = Math.max(-1, Math.min(1, (n.span - tailSpan) / 4));

    /* 四条硬约束。少一条都不行：
     * · 尾巴夹角落在 60~150°（飞镖的两片尾翼）
     * · 鼻子到两个尾巴各 95~162°（太近不是鼻子，太远就是凹口串进来）
     * · 鼻子必须基本落在中分线反向 ±15° 内 —— 飞镖左右对称，
     *   这一条专门排掉「凹口点 + 一侧尾翼」这种伪组合（实测能骗到 110°）
     * · 鼻子必须是三者里半径**最小**的那个，且鼻子不能比尾巴更尖。
     *   这两条是为 180° 翻转加的：凹口的半径比鼻子还小，单靠半径分不开，
     *   但凹口一定很尖，加上「不能更尖」就把它的伪组合压死了。 */
    const ok =
      sep > 60 &&
      sep < 150 &&
      o1 >= 95 &&
      o1 <= 162 &&
      o2 >= 95 &&
      o2 <= 162 &&
      bisErr <= 15 &&
      n.far < Math.min(t1.far, t2.far) * 1.02 &&
      noseFlat > -0.5;

    const score = ok
      ? Math.min(angMargin, 25) / 45 +
        radMargin * 1.5 +
        radSym * 0.25 +
        (1 - bisErr / 15) * 0.5 +
        noseFlat * 0.45
      : -99;
    return { score, angMargin, radMargin, radSym, bisErr, noseFlat, nose: n, t1, t2, sep, axis };
  };

  let chosen = null;
  if (corners.length >= 3) {
    for (let i2 = 0; i2 < corners.length; i2 += 1) {
      for (let j = i2 + 1; j < corners.length; j += 1) {
        for (let k = j + 1; k < corners.length; k += 1) {
          const trio = [corners[i2], corners[j], corners[k]];
          for (let m = 0; m < 3; m += 1) {
            const others = trio.filter((_, idx) => idx !== m);
            const r = evalTriple(trio[m], others[0], others[1]);
            if (!chosen || r.score > chosen.score) chosen = r;
          }
        }
      }
    }
    // 全部组合都被硬约束否掉，说明这一帧的青色块不像箭头
    if (chosen && chosen.score <= -99) chosen = null;
  }

  /* 只找到两个角：只有在「两个都是尾巴」时才敢用。
   *
   * 这一支曾经是 180° 翻转的另一个来源：两个角里若有一个其实是鼻子，
   * 拿它们的中分线反向就正好指反。所以除了夹角，还要求两角**半径接近**、
   * **都很尖** —— 两条尾翼是对称的，半径差不会超过一成多；鼻子半径明显更短，
   * 凹口则更窄。满足不了就判 invalid，让上层保持上一帧的角度，
   * 而不是给出一个 180° 错的答案。 */
  if ((!chosen || chosen.score <= 0) && corners.length === 2) {
    const [p, q] = corners;
    const sep = Math.abs(angDiff(p.deg, q.deg));
    const rSym = 1 - Math.min(1, Math.abs(p.far - q.far) / Math.max(1, p.far, q.far));
    const bothSharp = p.span <= 4 && q.span <= 4;
    if (sep <= 125 && rSym > 0.82 && bothSharp) {
      chosen = {
        score: 0.3,
        angMargin: 8,
        radMargin: 0,
        radSym: rSym,
        bisErr: 0,
        noseFlat: 0,
        nose: null,
        t1: p,
        t2: q,
        sep
      };
    }
  }
  if (!chosen) return empty;

  // 指向 = 两尾巴的中分线反向（对称轴朝外）
  const axisTail = (chosen.t1.deg + angDiff(chosen.t2.deg, chosen.t1.deg) / 2 + 720) % 360;
  const angle = (axisTail + 180) % 360;

  const a1 = degOf(bcDx, bcDy);
  const tipFrac = peakMax / size; // 尾巴伸出的长度，占窗口比例
  const spread = Math.abs(angDiff(angle, a1));
  const cover = (bestArea * step * step) / (size * size);
  const angConf = Math.max(0, Math.min(1, chosen.angMargin / 22));
  const radConf = Math.max(0, Math.min(1, (chosen.radMargin + 0.08) / 0.3));
  const sizeConf = Math.max(0, Math.min(1, cover / 0.05));
  // 钝/尖证据单独记一档：鼻子越明显比尾巴「宽」，这一帧越可信
  const flatConf = Math.max(0, Math.min(1, (chosen.noseFlat + 0.2) / 1.2));
  const conf = Math.max(
    0,
    Math.min(
      1,
      angConf * 0.3 +
        radConf * 0.24 +
        sizeConf * 0.18 +
        chosen.radSym * 0.16 +
        flatConf * 0.12
    )
  );

  // 有效判据：三点齐全、对称关系成立、长度和面积过线。
  // 有鼻子时额外要求「鼻子确实比尾巴钝」（noseFlat >= -0.4）——
  // 这一条是 180° 翻转的最后一道闸，宁可这一帧不出结果，也不出反向结果。
  const valid =
    corners.length >= 3 &&
    chosen.angMargin > 4 &&
    chosen.radMargin > -0.12 &&
    chosen.noseFlat >= -0.4 &&
    chosen.score > 0.25 &&
    tipFrac >= 0.1 &&
    bestArea * step * step >= 120;

  return {
    valid,
    angle,
    conf,
    cyans,
    tipFrac,
    spread,
    a1,
    a2: axisTail,
    aTip: angle,
    area: bestArea,
    corners: corners.map((c) => ({
      deg: Math.round(c.deg * 10) / 10,
      r: Math.round(c.far * 10) / 10,
      span: c.span
    })),
    noseDeg: chosen.nose ? Math.round(chosen.nose.deg * 10) / 10 : null,
    noseFlat: Math.round(chosen.noseFlat * 100) / 100,
    angMargin: Math.round(chosen.angMargin * 10) / 10,
    radMargin: Math.round(chosen.radMargin * 100) / 100,
    bcX: Math.round(bestCx),
    bcY: Math.round(bestCy),
    center: Math.round(c0),
    size
  };
}

/** 单位向量 → 0..360 度 */
function degOf(ux, uy) {
  return ((Math.atan2(uy, ux) * 180) / Math.PI + 360) % 360;
}

/** 两角之差，落在 -180..180，正确处理 359°→1° 这种跨越 */
function angDiff(a, b) {
  return ((a - b + 540) % 360) - 180;
}

/* ---------------------------------------------------------------- 扇形通道
 *
 * 原神小地图在角色周围铺一个白色半透明的扇形，表示**镜头**的视野朝向。
 * 它和青色箭头是两件独立的事：箭头是「人往哪走」，扇形是「镜头朝哪看」。
 * 站着转视角时扇形转、箭头不转；跑动时两者基本一致。所以它不能替代箭头，
 * 但可以做两件事：
 *   · 几何判据模糊时（比如只有两个角、鼻子被图标压住）拿它打破平局
 *   · 几何整帧失效时当兜底，总比箭头消失强
 *
 * 纯像素统计 + 结构判据，**不设任何地图底色 / 白度 / 饱和度阈值**：
 *   1. 只采亮度；不透明纯白（地图标点核心）按同层均值抹掉
 *      —— 这是唯一保留的颜色判据，因为图标永远 250+ 且中性，与底色无关
 *   2. 每格每段减去「同层相邻角度带」均值，得到底色无关的局部抬升
 *   3. 72 个候选中心 × 固定 90° 模板，逐径向层算局部对比
 *   4. 要求：各层同向为正、内浓外淡、内侧 4 层强度接近（等角宽楔形）、
 *      胜出方向明显强于次高峰 —— 全部是相对量/结构量
 *
 * 为什么不用底色：不同地图区域（深蓝水 / 黄绿草地 / 灰白岩石 / 雪地）的
 * 底色差异极大且无法预测。半透明白叠在深蓝水上只是把 (48,104,202) 提亮成
 * 灰蓝 (100,130,160)，仍比旁边黄绿陆地暗；任何「够亮 / 够白 / 低饱和」
 * 的绝对阈值都会让整片扇形消失。用户实拍帧实测白度命中率 0%。
 *
 * 采样窗口必须覆盖 0.24R~0.72R：几何通道那个 0.62R 的中心小窗只看得到
 * 0.10R~0.30R，那里 alpha 还在平台期，「越往圆心越白」根本没展开。
 */

function analyzeCone(img, size, step) {
  const d = img.data;
  const c0 = (size - 1) / 2;
  const NB2 = 72; // 5° 一格
  const SEGS = 6;
  const rIn = size * 0.16;
  /* 外径必须落在**窗口内**：窗口是 size×size、圆心在正中，能看到的半径上限就是
   * 0.5*size。之前写成 0.92*size，等于要求扇形铺到画面外面去，径向 6 段里
   * 永远只命中 3 段，「径向连续」这条判据必然判死 —— 整个通道等于空转。
   * 取 0.48 留一点边，避开窗口四角抗锯齿导致的亮度衰减。 */
  const rOut = size * 0.48;
  const invSpan = SEGS / (rOut - rIn);

  /* 不设任何颜色 / 白度 / 饱和度判据。
   * 用户实拍证明：不同地图区域底色差异极大且无法预测，半透明白叠在深蓝水上
   * 只是把 (48,104,202) 提亮成灰蓝 (100,130,160)，叠在雪地上几乎不着色，
   * 叠在草地上又偏绿。任何「够亮 / 够白 / 低饱和」的绝对阈值都会整片失效。
   * 唯一稳健的量是**局部相对亮度差**：这一角比它两侧亮多少。 */
  const segTot = new Uint16Array(NB2 * SEGS);
  const segLum = new Float32Array(NB2 * SEGS);
  const layerLum = new Float32Array(SEGS);   // 各径向层的非纯白像素亮度和
  const layerTot = new Uint32Array(SEGS);
  const pureAt = [];                        // 纯白图标像素落在哪个格段
  /* 小地图存在性门控信号：整窗的青色像素比例。
   * 玩家箭头恒在圆心、且随小地图一起消失，与底色/视锥判据完全独立。
   * 必须用固定阈值，不能用 analyze() 的 p99 自适应阈值（后者会把草地算成青色）。
   * 真实视频 166 帧标定：有小地图 p05 ≈ 2.0% 采样点，无小地图 ≤ 0.11%，
   * 相差约 18 倍；按采样点数归一化后可跨窗口尺寸使用。 */
  let cyanHits = 0;

  for (let y = 0; y < size; y += step) {
    const dy = c0 - y;
    for (let x = 0; x < size; x += step) {
      const i = (y * size + x) * 4;
      const r = d[i];
      const g = d[i + 1];
      const bl = d[i + 2];
      if (Math.min(g, bl) - r >= 80) cyanHits += 1;
      const dx = x - c0;
      const rho = Math.sqrt(dx * dx + dy * dy);
      if (rho < rIn || rho > rOut) continue;
      let a = (Math.atan2(dy, dx) * 180) / Math.PI;
      if (a < 0) a += 360;
      const b = Math.min(NB2 - 1, (a * NB2 / 360) | 0);
      const seg = Math.min(SEGS - 1, ((rho - rIn) * invSpan) | 0);
      const k = b * SEGS + seg;
      const mn = Math.min(r, g, bl);
      const mx = Math.max(r, g, bl);
      /* 唯一保留的颜色判据：不透明纯白 = 地图标点 / 四角星 / 玩家标记的**核心**。
       * 它跟底色无关（图标永远 250+ 且三通道相等），但比半透明白膜亮得多，
       * 若计入亮度剖面会形成尖锐假峰。这里先记下来，稍后用「同一径向层的
       * 非纯白像素均值」替换 —— 等于把图标从画面里抹掉，
       * 既不留下亮点，也不留下会让局部对比反向的暗洞。
       * 抗锯齿灰边（200~235）仍会计入，但强度已经低一个量级。 */
      if (mx >= 244 && mx - mn <= 8) {
        pureAt.push(k);
        continue;
      }
      const lum = (r + g + bl) / 3;
      segTot[k] += 1;
      segLum[k] += lum;
      layerLum[seg] += lum;
      layerTot[seg] += 1;
    }
  }
  for (const k of pureAt) {
    const seg = k % SEGS;
    const fill = layerTot[seg] ? layerLum[seg] / layerTot[seg] : 0;
    segTot[k] += 1;
    segLum[k] += fill;
  }
  const nx = Math.ceil(size / step);
  const cyanFrac = nx > 0 ? cyanHits / (nx * nx) : 0;

  /* 每格每段：亮度减去「同层相邻角度带」的均值，得到与底色无关的局部抬升。
   * 背景带取两侧各 5 格（±25°），跳过中间 90°，不会被扇形自己抬高。 */
  const S = new Float32Array(NB2 * SEGS);
  /* 原始亮度网格（纯白图标核心已被同层均值替换）。S 做过 ±9 格的局部归一化，
   * 会把扇形两条半径边的阶跃压平；「边证据」必须用未经归一化的亮度。 */
  const lumGrid = new Float32Array(NB2 * SEGS);
  const LIFT_HALF = 9;
  const LIFT_OUT = 5;
  for (let s = 0; s < SEGS; s += 1) {
    const lum = new Float32Array(NB2);
    for (let b = 0; b < NB2; b += 1) {
      const k = b * SEGS + s;
      lum[b] = segTot[k] ? segLum[k] / segTot[k] : 0;
      lumGrid[b * SEGS + s] = lum[b];
    }
    for (let b = 0; b < NB2; b += 1) {
      let bg = 0;
      let n = 0;
      for (let dd = -LIFT_HALF - LIFT_OUT; dd <= LIFT_HALF + LIFT_OUT; dd += 1) {
        if (Math.abs(dd) <= LIFT_HALF) continue;
        bg += lum[(b + dd + NB2) % NB2];
        n += 1;
      }
      bg /= n || 1;
      S[b * SEGS + s] = Math.max(0, Math.min(1, (lum[b] - bg) / 28));
    }
  }

  const HALF = 9; // ±9 格 = 90°，用户确认的恒定视野张角
  const OUT = 5;  // 外侧再取 5 格做背景带
  const sumBox = (c, s0, s1) => {
    let sum = 0;
    let n = 0;
    for (let dd = -HALF; dd <= HALF; dd += 1) {
      const b = (c + dd + NB2) % NB2;
      for (let s = s0; s < s1; s += 1) {
        sum += S[b * SEGS + s];
        n += 1;
      }
    }
    return n ? sum / n : 0;
  };
  const sumBand = (c, s0, s1) => {
    let sum = 0;
    let n = 0;
    for (let dd = -HALF - OUT; dd <= HALF + OUT; dd += 1) {
      if (Math.abs(dd) <= HALF) continue;
      const b = (c + dd + NB2) % NB2;
      for (let s = s0; s < s1; s += 1) {
        sum += S[b * SEGS + s];
        n += 1;
      }
    }
    return n ? sum / n : 0;
  };
  // ② 边界锐度：模板两端内侧 2 格 vs 外侧 2 格的强度落差（只加分、不作硬门槛）
  const edgeScore = (c) => {
    let inner = 0;
    let outer = 0;
    for (const dd of [-HALF, -HALF + 1, HALF - 1, HALF]) {
      const b = (c + dd + NB2) % NB2;
      for (let s = 0; s < SEGS; s += 1) inner += S[b * SEGS + s];
    }
    for (const dd of [-HALF - 2, -HALF - 1, HALF + 1, HALF + 2]) {
      const b = (c + dd + NB2) % NB2;
      for (let s = 0; s < SEGS; s += 1) outer += S[b * SEGS + s];
    }
    return (inner - outer) / (4 * SEGS);
  };

  /* 逐径向层的 90° 局部对比。真实视锥是等角宽楔形、alpha 随半径衰减：
   *   ① 两条半径边从圆心出发 → 每一层都是同一个方向比两侧亮（pos）
   *   ② 内浓外淡            → 内两层响应 > 外两层（fade > 0）
   * 这两条都是**结构**，不依赖任何底色或亮度幅度。
   * 旧版用 contrast/edge/score 的绝对硬门槛（按合成帧标定），
   * 在真实帧上扇形 contrast 只有 0.165 就被卡死 —— 改成相对决策。 */
  const resp = new Float32Array(NB2 * SEGS);
  for (let c = 0; c < NB2; c += 1) {
    for (let s = 0; s < SEGS; s += 1) {
      resp[c * SEGS + s] = sumBox(c, s, s + 1) - sumBand(c, s, s + 1);
    }
  }

  /* ---- 两条半径边证据 --------------------------------------------------
   * 用户 2026-11-06 指出的物理先验：扇形两条半径边是从圆心出发的直线，
   * 分界清晰、夹角恒 90°。旧判据只看「90° 窗口内比两侧亮」，一块亮地形
   * 或一串白标就能顶出一个假峰；真扇形的**边**却很难被点状图标伪造。
   *
   * 对每个角度 a，取「右侧 10~30° 带」减「左侧 10~30° 带」的平均亮度，
   * 沿 6 个径向层累加：贯穿全半径的直线在每层同号，白星标只点亮 1~2 格、
   * 1~2 层，被宽角度带平均稀释。仍是同层相邻角度带的**相对差**，
   * 不是绝对白度判据，与「底色不可预测」的约定不冲突。
   */
  const EV = new Float32Array(NB2);
  for (let a = 0; a < NB2; a += 1) {
    let sum = 0;
    for (let s = 0; s < SEGS; s += 1) {
      let rp = 0;
      let lp = 0;
      for (let d = 2; d <= 6; d += 1) {
        rp += lumGrid[((a + d) % NB2) * SEGS + s];
        lp += lumGrid[((a - d + NB2) % NB2) * SEGS + s];
      }
      sum += (rp - lp) / 5;
    }
    EV[a] = sum / SEGS;
  }
  // 90° 楔形的两条边落在 c±9 格；±1 格留量化余量。
  // 进入边右亮左暗(EV>0)、离开边左亮右暗(EV<0)，必须同时成立。
  const edgeBoost = (c) => {
    let ein = -1e9;
    let eout = -1e9;
    for (const d of [-10, -9, -8]) ein = Math.max(ein, EV[(c + d + NB2) % NB2]);
    for (const d of [8, 9, 10]) eout = Math.max(eout, -EV[(c + d + NB2) % NB2]);
    return Math.sqrt(Math.max(0, ein) * Math.max(0, eout));
  };

  const cand = [];
  for (let c = 0; c < NB2; c += 1) {
    let all = 0;
    let inner = 0;
    let outer = 0;
    let pos = 0;
    for (let s = 0; s < SEGS; s += 1) {
      const v = resp[c * SEGS + s];
      all += v;
      if (s < 2) inner += v;
      if (s >= 4) outer += v;
      if (v > 0.02) pos += 1;
    }
    all /= SEGS;
    inner /= 2;
    outer /= 2;
    const fade = inner - outer;
    /* 全为相对量的结构条件；不再有「必须比某个绝对亮度白」这类判据。
     *
     * 定向救援（2026-11-06 用户实拍标注帧）：地图标点（不透明白四角星 / 圆形
     * 图标）常落在 90° 模板窗口**外侧的背景带**里，把背景抬得比扇形还亮，
     * 于是外侧 3 层响应全变负 → all<=0 / pos<5，真峰被自己的结构条件误杀，
     * 候选里只剩一个 U 形假峰（图标边缘），绿弧就指到扇形边界上去了。
     * 实测该帧：真峰 score 0.675 / fade 1.02 / layers [0.11,0.58,0.32,
     * -0.34,-0.62,-0.72]，假峰只有 0.430 / fade 0.08。
     * 所以只对「内浓外淡极强 + 内侧三层连续为正」这一类开救援通道，
     * 让它参与排序；普通的负响应假峰仍然被挡。 */
    const blocked = (pos < 5 || fade <= 0.03 || all <= 0.02 || inner <= 0.03);
    const rescueOK = fade >= 0.8 && inner >= 0.25 &&
      resp[c * SEGS] > 0 && resp[c * SEGS + 1] > 0 && resp[c * SEGS + 2] > 0;
    if (blocked && !rescueOK) continue;
    const edge = edgeScore(c);
    // 实心度：90° 窗口里 19 根角柱各自跨 6 层的强度，取 25% 分位。
    // 这是纯空间结构 —— 视锥是连续面，每根柱都有值；地图标点只点亮少数柱。
    // 不依赖颜色，白色四角星和灰白图标一视同仁。
    const cols = [];
    // 只看窗口中央 13 柱：视锥实际约 80~90°，90° 模板两端本就可能落在
    // 扇形外（真实帧在深蓝水上就是这样），把边缘空柱算进来会冤枉真扇形。
    for (let dd = -6; dd <= 6; dd += 1) {
      const b = (c + dd + NB2) % NB2;
      let v = 0;
      for (let s = 0; s < SEGS; s += 1) v += S[b * SEGS + s];
      cols.push(v / SEGS);
    }
    cols.sort((x, y) => x - y);
    const solid = cols[3];
    const score = all + inner * 0.7 + fade * 0.5 + Math.max(0, edge) * 0.4;
    const layers = [];
    for (let s = 0; s < SEGS; s += 1) layers.push(resp[c * SEGS + s]);
    let mono = 0;
    for (let s = 0; s < SEGS - 1; s += 1) if (layers[s] - layers[s + 1] > -0.05) mono += 1;
    /* 等角宽楔形：两条半径边从圆心出发，所以内侧 4 个径向层上视锥的
     * 角宽不变，局部对比强度应当接近（真实帧 0.70~0.99）。
     * 地形亮块只在某个半径出现，层间陡降（实测 0.08~0.51）。
     * 这是纯几何量，不涉及任何底色或亮度绝对值。 */
    const head = layers.slice(0, 4);
    const hMin = Math.min(...head);
    const hMax = Math.max(...head);
    const flat = hMax > 0 ? hMin / hMax : 0;
    /* flat / mono 只作诊断，不再一票否决（2026-11-06 真实视频 166 帧实测）。
     * 漏检帧的 best 候选 score 0.99~1.37 / fade 0.39~0.72 / pos 5~6 都健康，
     * 唯独真实地形的明暗起伏让「前 4 层 min/max」掉到 0.11~0.60。
     * 合成帧地形均匀所以 flat 高 —— 这正是「合成回归全过、实测 43.8% 漏检」的根因。
     * 保留计算并塞进 dbg，方便后续做软证据标定。 */
    /* rank 只用于候选择优；score 原样保留给 0.16 下限、conf 和救援门限，
     * 这样时序层（平滑系数 / 大跳门限）的行为完全不变，只改「选哪个峰」。
     * W=0.6、/30 归一化按 166 帧真实视频标定：见 scripts/vision-probe/。 */
    const rank = score + 0.6 * Math.min(1, edgeBoost(c) / 30);
    cand.push({ c, score, rank, all, inner, outer, fade, pos, edge, solid, mono, flat, layers, rescued: blocked });
  }
  if (!cand.length) return { valid: false, deg: 0, conf: 0, width: 90, cyanFrac };

  // 按「结构分 + 两条半径边证据」择优，而不是纯结构分。
  cand.sort((x, y) => y.rank - x.rank);
  /* 救援候选必须「明显强于」正常候选才能上位。另一处高 fade 地形也可能满足
   * 救援条件，若让它和正常峰自由比大小，会把原本连续的视角甩到反方向：
   * 真实视频 t=108s 实测 49.9°(夹在 95°→30.7° 之间，正确) 被甩到 166.4°。
   * 1.35 倍门限下该帧回退到正常峰；标注帧真峰 0.675 / 假峰 0.430 = 1.57 倍
   * 仍能正常救援。 */
  const normalBest = cand.find((t) => !t.rescued);
  let best = cand[0];
  if (best.rescued && normalBest && best.score < normalBest.score * 1.35) best = normalBest;
  /* 相对优势也只留作诊断，不再一票否决。
   * 真实帧里真扇形常与另一侧地形亮块并列，1.18 倍峰比额外砍掉 18/153 个真检出。
   * 用高置信锚点检验过：放宽后新增的 57 帧检出里，能与前后锚点配对的 17 帧
   * 有 13 帧（76.5%）落在锚点插值 ±25° 内，随机基线仅 11.8%。
   * 保留 0.16 绝对下限，只挡「整帧没有任何成结构响应」的空画面。 */
  const rival = cand.find((t) => Math.abs(angDiff(t.c * 5 + 2.5, best.c * 5 + 2.5)) > 30);
  best.rivalScore = rival ? rival.score : 0;
  if (best.score < 0.16) {
    return { valid: false, deg: 0, conf: 0, width: 90, cyanFrac, dbg: best };
  }

  // 90° 窗口内按各层响应之和求加权质心，微调中轴
  let sx = 0;
  let sy = 0;
  let wsum = 0;
  for (let dd = -HALF; dd <= HALF; dd += 1) {
    const b = (best.c + dd + NB2) % NB2;
    let w = 0;
    for (let s = 0; s < SEGS; s += 1) w += Math.max(0, resp[b * SEGS + s]);
    if (w <= 0) continue;
    const rad = (((b + 0.5) * 360) / NB2) * Math.PI / 180;
    sx += Math.cos(rad) * w;
    sy += Math.sin(rad) * w;
    wsum += w;
  }
  const deg = wsum > 1e-6 ? degOf(sx, sy) : best.c * 5 + 2.5;
  const conf = Math.max(0, Math.min(1, (best.score - 0.15) / 0.8));
  return { valid: conf > 0.12, deg, conf, width: 90, peakCov: wsum, cyanFrac, dbg: best };
}

/**
 * 圆形 α-β 滤波 + 180° 翻转门限。
 *
 * 为什么不再用「最近几帧取中值」：中值只会延迟，不会预测。角色匀速转身时
 * 中值永远滞后半拍，视觉上就是箭头拖着人走；更糟的是遇到「凹口冒充鼻子」
 * 这种单帧 180° 反相时，中值要攒三帧才纠回来，中间那三帧是明确的反向。
 *
 * α-β 滤波多带一个角速度项：匀速转动时理论上零滞后，静止时 β 收敛到 0、
 * α 又小，画面就稳。这比单纯调 alpha 曲线在数学上干净得多。
 *
 * 翻转门限专门对付「角度变化 180° 时被尾部凹槽尖端带偏」：
 * 真实转身在视频里是连续的，每帧十几度，不可能一帧跳 180°；
 * 能一帧跳 180° 的只有误认（凹口被当成鼻子）。所以要求连续两帧都指向
 * 新方向、且置信度 >= 0.5 才承认掉头，否则这一帧不进状态。
 * 代价是真实掉头晚约 33ms（一帧），换来的是永远不会突然指反。
 *
 * @returns {number|null} 平滑后的角度；null 表示这一帧被门限挡下，不要上报
 */
function smoothBearing(obs, conf, now, coneDeg = -1, coneConf = 0) {
  const st = BEARING.ab;
  if (st.theta < 0) {
    st.theta = obs;
    st.omega = 0;
    st.t = now;
    st.suspect = 0;
    return obs;
  }

  // 视频暂停后恢复 / 切分 P，dt 会很大，限幅避免速度项被推飞
  const dt = Math.min(0.4, Math.max(0.008, (now - st.t) / 1000));
  const pred = (st.theta + st.omega * dt + 360) % 360;
  const res = angDiff(obs, pred);

  if (Math.abs(res) > 130) {
    /* 疑似 180° 翻转，让扇形投票。
     *
     * 之所以不让它直接改角度：扇形是镜头朝向，站着转视角时和角色朝向
     * 不是一回事。它只能回答「翻没翻」这个是非题，不能回答「具体多少度」。 */
    let voteNew = 0;
    let voteOld = 0;
    if (coneConf > 0.3) {
      const dn = Math.abs(angDiff(obs, coneDeg));
      const d0 = Math.abs(angDiff(st.theta, coneDeg));
      if (dn + 15 < d0) voteNew += 1;
      else if (d0 + 15 < dn) voteOld += 1;
    }

    st.suspect += 1;
    // 认翻的条件：扇形明确支持新方向，或连续两帧都跳且本身够可信
    const confirmed = voteNew > voteOld || (st.suspect >= 2 && conf >= 0.5);
    if (!confirmed) {
      st.t = now;
      return null;
    }
    st.theta = obs;
    st.omega = 0;
    st.suspect = 0;
    st.t = now;
    return obs;
  }

  st.suspect = 0;
  // 增益随置信度浮动：认得越死，跟得越快；半信半疑就多平滑
  const a = 0.32 + 0.3 * conf;
  const b = 0.06 + 0.1 * conf;
  st.theta = (pred + a * res + 360) % 360;
  st.omega = Math.max(-540, Math.min(540, st.omega + (b * res) / dt));
  st.t = now;
  return st.theta;
}

/**
 * 视角通道：白色扇形（镜头视锥）→ 一个独立的「当前视角」角度。
 *
 * 和行进通道的区别在于**谁说了算**：
 *   · 行进靠青色三角，一帧一帧解几何，精确但只在箭头可见时有效
 *   · 视角靠白色扇形（镜头视锥），它天生就是一个有向的宽扇，中轴就是镜头朝向
 *
 * 视角只认扇形这一路证据：它就在这一帧的像素里，没有语义歧义，
 * 也不存在「说的是下一步、比画面超前」这种时序错位。
 *
 * 拿不到扇形时进入宽限保持，只有小地图确实不在才返回 null —— 不猜，
 * 也不拿行进方向顶上，因为那两者本来就可以不同。
 *
 * @returns {{deg:number, conf:number, src:string}|null} 数学角；
 *          src = cone / hold / pending（大跳挂起、等下一有效帧确认）；
 *          null = 小地图确实不在（宽限已耗尽）；单帧漏检不再返回 null。
 */
/* 用户确认（2026-11-06）：扇形是视野朝向指示，只要小地图在就**恒渲染**，
 * 没有淡入淡出、没有周期性隐藏，张角恒 90°，顶点严格在玩家中心，地图固定北上。
 * 于是「绿弧消失」永远是漏检，不能再拿「宁可不显示也不指假方向」当挡箭牌。
 * 漏检帧保持上一次方向，宽限窗口内不让绿弧闪掉。 */
const VIEW_GRACE_MS = 1200;
/* 小地图存在性门控：analyzeCone 顺手统计的青色像素占采样点比例。
 * 166 帧实测分界：有小地图 ≥ 0.019，无小地图 ≤ 0.0011（仅 1 帧转场例外）。
 * 取 0.0015 留足余量，跨画质/色彩管理的小幅漂移不会误杀。 */
const MAP_CYAN_FRAC_MIN = 0.0015;
/* 大跳挂起确认（2026-11-07）：相对当前方向 >100° 的观测先不采纳，等下一个有效帧；
 * 下一帧角度与挂起值相差 <30° 才承认是真的转身，否则判为单帧假峰丢弃。
 * 500 帧离线验证：两帧孤立误检上屏误差 10.5°/125.2° → 3.8°/0.8°，
 * 上屏大跳 20 → 16，19 次挂起里 14 次被真实转身在下一帧确认（只延迟一帧）。
 * 刻意不设时间超时：只按「下一个有效帧」结算，与帧率无关，
 * 离线 0.66s 抽帧序列与运行时逐帧行为一致。 */
const VIEW_JUMP_DEG = 100;
const VIEW_PENDING_MATCH_DEG = 30;
function updateView(cone, now, mapPresent = true) {
  const V = BEARING.view;
  /* 小地图确实不在（转场 / 结算 / 菜单）⇒ 立刻清掉视角状态，不走宽限。
   * 否则绿弧会挂着上一段的方向，只能等 overlay 的过期定时器慢慢收。 */
  if (!mapPresent) {
    V.theta = -1;
    V.conf = 0;
    V.src = '';
    V.t = now;
    V.pending = -1;
    return null;
  }
  const ok = !!cone && cone.valid && cone.conf > 0.12;

  /* 扇形恒在，所以「这一帧没认出来」不等于「没有视角」。
   * 宽限窗口内保持上一次的方向，置信度逐帧衰减让绿弧自然变淡。
   *
   * 刻意**不**拿低把握帧的 deg 来顶：那多半是地形/图标的假峰，
   * 平滑进绿弧比原地保持更糟。只有长时间没有任何可信证据
   * （通常是小地图真的消失：过场、菜单、转场）才返回 null。
   * 漏检帧不消费 pending：挂起的大跳要等下一个**有效**观测来裁决。 */
  if (!ok) {
    if (V.theta < 0 || now - V.t > VIEW_GRACE_MS) {
      V.pending = -1;
      return null;
    }
    V.conf = Math.max(0, V.conf * 0.85);
    V.src = 'hold';
    return { deg: V.theta, conf: V.conf, src: 'hold' };
  }

  const deg = cone.deg;
  const conf = cone.conf;

  /* 结算上一帧挂起的大跳。
   * 视角能被鼠标一甩就转 180°，所以不能用「翻转门限」硬挡；
   * 但真实转身会连续多帧停在新方向，而白标 / 地形假峰是**单帧脉冲**。
   * 因此判据不是「这一帧有多可信」，而是「下一帧是不是还在那儿」。 */
  if (V.pending >= 0) {
    const p = V.pending;
    V.pending = -1;
    if (Math.abs(angDiff(deg, p)) < VIEW_PENDING_MATCH_DEG) {
      V.theta = deg;   // 确认成立，直接就位（只比原来晚一帧）
    }
    // 不成立就当这个脉冲没发生过，theta 保持挂起前的值继续正常平滑
  }

  const jump = V.theta < 0 ? 999 : Math.abs(angDiff(deg, V.theta));

  /* 首帧没有历史可平滑，必须直接就位。
   * 之后凡是 >100° 的大跳一律挂起一帧：旧版「conf>=0.55 直接就位」
   * 会让 conf=1.00 的单帧假峰原样上屏，正是「绿弧突然翻到反方向又跳回」。 */
  if (V.theta < 0) {
    V.theta = deg;
  } else if (jump > VIEW_JUMP_DEG) {
    V.pending = deg;
    V.conf = conf;
    V.src = 'pending';
    V.t = now;
    return { deg: V.theta, conf, src: 'pending' };
  } else {
    const k = 0.10 + 0.62 * conf;
    V.theta = (V.theta + angDiff(deg, V.theta) * k + 360) % 360;
  }

  V.conf = conf;
  V.src = 'cone';
  V.t = now;
  return { deg: V.theta, conf, src: 'cone' };
}

/**
 * 视角 → 上报字段。
 * 内部一路用数学角，出口换算成罗盘角（0=北、顺时针），和 angle 保持同一套约定。
 */
function viewPayload(view, cone) {
  if (!view) return { view: null, viewConfidence: 0, viewSource: '', viewWidth: 0 };
  return {
    view: (90 - view.deg + 720) % 360,
    viewConfidence: Math.round(view.conf * 100) / 100,
    viewSource: view.src,
    // 扇形张角：外环绿弧的长度要不要跟着实体视锥宽度变，由显示层决定
    // 扇形张角恒 90°；漏检保持期 cone.valid=false 也别让绿弧长度跳变
    viewWidth: view ? Math.round((cone && cone.width) || 90) : 0
  };
}

/**
 * 连续认不出来时通知一次前端，宽限 1 秒避免偶尔一帧抖动把箭头闪掉。
 *
 * extra 用来捎上视角：箭头认不出来不等于视角也丢了（箭头被特效盖住、
 * 扇形反而清楚是常事），这种情况绿弧还得继续走。
 */
function markInvalid(reason, extra) {
  BEARING.raw.length = 0;
  BEARING.smooth = -1;
  BEARING.ab.theta = -1;
  BEARING.ab.omega = 0;
  BEARING.ab.suspect = 0;
  BEARING.lastAngle = -1;
  if (!BEARING.invalidSince) BEARING.invalidSince = Date.now();
  if (Date.now() - BEARING.invalidSince < 1000) return;
  if (BEARING.reportedValid === false) return;

  BEARING.reportedValid = false;
  ipcRenderer.sendToHost('bearing', { ok: false, reason, angle: null, ...(extra || {}) });
}

function tickBearing() {
  if (!BEARING.enabled) return;
  BEARING.ticks = (BEARING.ticks || 0) + 1;

  if (!BEARING.rois.length) {
    markInvalid('还没框选小地图');
    return;
  }

  // 逐个区域试，取置信度最高的一块。布局在原生迷你地图和放大贴片之间切换时，
  // 不匹配的区域会被判无效，匹配的那块自然接管。
  let best = null;
  let seen = null;
  let cone = null;
  let mapCyan = 0;   // 所有 ROI 里最高的青色比例（布局切换时别取错区域）

  for (const roi of BEARING.rois) {
    const g = grabCenter(roi);
    if (!g) continue;
    const r = analyze(g.img, g.size, g.step);
    if (!seen || r.conf > seen.conf) seen = r;

    // 扇形每帧都要算，且必须换**大窗口**：几何通道的 0.62R 中心小窗
    // 看不到径向衰减，等于把「内浓外淡」这个关键证据直接丢掉。
    // 大窗口按 step=2 跳采，扫描像素数与几何通道同量级。
    const gc = grabCenter(roi, 1.5, 512);
    if (gc) {
      const cn = analyzeCone(gc.img, gc.size, gc.step);
      mapCyan = Math.max(mapCyan, cn.cyanFrac || 0);
      // 扇形恒在：连 invalid 的结果也交给 updateView 走宽限，别在采集层就丢掉
      if (!cone || cn.conf > cone.conf) cone = { ...cn, size: gc.size };
    }

    if (!r.valid) continue;
    if (!best || r.conf > best.conf) best = { ...r, size: g.size };
  }

  const now = Date.now();
  // 视角通道独立于行进通道，先把它算出来。几何彻底失效时它可能还有值。
  // 门控只管「小地图在不在」，不管「这一帧有没有认出扇形」—— 后者由宽限兜。
  const view = updateView(cone, now, mapCyan >= MAP_CYAN_FRAC_MIN);

  if (!best) {
    // 只在第一次失配时打一行日志，避免每帧刷屏
    if (!BEARING.explained) {
      BEARING.explained = true;
      console.log(
        `[跟跑助手] 画面里没有小地图（青色 ${seen ? seen.cyans : 0} 像素，` +
          `伸展 ${seen ? (seen.tipFrac * 100).toFixed(0) : 0}%） · 转场 / 特写 / 对话时属正常`
      );
    }
    // 箭头认不出来时**不再**拿扇形冒充行进方向 —— 镜头可以独立于角色转，
    // 那样画出去的是视角不是走向。但视角本身要是还在，绿弧得继续走，
    // 否则外环会跟着箭头一起卡住。
    markInvalid('画面里没有小地图', view ? viewPayload(view, cone) : null);
    return;
  }

  BEARING.explained = false;
  BEARING.invalidSince = 0;

  // 三路一致性：几何说了算，扇形只加/减置信，不改角度。
  // 让扇形改角度是危险的 —— 镜头可以独立于角色转，一改就把行进方向带歪。
  let conf = best.conf;
  if (cone && !best.fromCone) {
    const d = Math.abs(angDiff(cone.deg, best.angle));
    if (d < 25) conf = Math.min(1, conf + 0.12);
    else if (d > 60 && conf < 0.55) conf *= 0.7;
  }

  if (!BEARING.logged) {
    BEARING.logged = true;
    console.log(
      `[跟跑助手] 首次识别到朝向 ${best.angle.toFixed(1)}°（置信 ${(conf * 100).toFixed(0)}%，` +
        `青色 ${best.cyans} 像素，三角 ${(best.corners || [])
          .map((c) => `${c.deg.toFixed(0)}°/${c.r.toFixed(0)}/${c.span}`)
          .join(' ')}，鼻尖 ${best.noseDeg}°，钝度 ${best.noseFlat}，` +
        `扇形 ${cone ? `${cone.deg.toFixed(0)}°/${(cone.conf * 100).toFixed(0)}%` : '无'}，` +
        `采样 ${best.size}px，共 ${BEARING.rois.length} 个区域）`
    );
  }

  // 时序滤波在这里一把做完：α-β 平滑 + 180° 翻转门限。
  // 返回 null 表示这一帧的判据是「疑似反向」，宁可不动，也不要指反。
  const out = smoothBearing(
    best.angle,
    conf,
    now,
    cone ? cone.deg : -1,
    cone ? cone.conf : 0
  );
  // 原始观测只留最近 5 帧，纯诊断用（state() 里能取到）
  BEARING.raw.push(best.angle);
  if (BEARING.raw.length > 5) BEARING.raw.shift();

  // out === null：这一帧被判为「疑似反向」，箭头保持不动。
  // 但视角是**独立通道**，必须照常送 —— 否则绿弧会跟着箭头一起卡住半秒。
  if (out === null) {
    ipcRenderer.sendToHost('bearing', {
      ok: true,
      angle: BEARING.lastAngle < 0 ? (90 - best.angle + 720) % 360 : (90 - BEARING.lastAngle + 720) % 360,
      confidence: conf,
      source: 'arrow',
      hold: true,
      ...viewPayload(view, cone)
    });
    return;
  }

  BEARING.smooth = out;
  const moved = BEARING.lastAngle < 0 ? 999 : Math.abs(angDiff(out, BEARING.lastAngle));
  // 视角也要参与「要不要重发」的判断：箭头不动但镜头在转时，绿弧不能停
  const viewMoved = view ? Math.abs(angDiff(view.deg, BEARING.view.sent)) : 0;
  // 只挡「几乎没动」的重复上报，不再有 450ms 的强制冷却
  if (BEARING.reportedValid === true && moved <= 0.6 && viewMoved <= 1.5 && now - BEARING.lastSentAt < 250) {
    return;
  }

  BEARING.reportedValid = true;
  BEARING.lastAngle = out;
  BEARING.lastSentAt = now;
  BEARING.view.sent = view ? view.deg : -1;

  /* 坐标系换算 —— 曾经在这里翻了船。
   *
   * 识别核内部一路用**数学角**（0°=东、逆时针），因为那是 atan2 的天然输出，
   * 极坐标剖面算出来的角度直接用最省事、也不会在 0/360 处出岔子。
   *
   * 但 overlay 是按**罗盘角**画的：它取 `(deg - 90)` 再 cos/sin，也就是
   * 0°=北、顺时针。两边约定不同却没人换算，于是屏幕上的箭头成了
   * 「数学角当罗盘角用」的镜像 —— 误差是 90° - 2θ，随朝向变化，
   * 看起来就是「箭头到处乱转」，实际上识别本身是准的。
   *
   * 所以出口这一处必须转：compass = (90 - math) mod 360。
   * 顺便和「0=北、顺时针」这个业界约定对齐，日志读起来也直观。
   */
  const compass = (90 - out + 720) % 360;
  ipcRenderer.sendToHost('bearing', {
    ok: true,
    angle: compass,
    confidence: conf,
    // 箭头走的是几何，视角走的是扇形，两路互不覆盖
    source: 'arrow',
    ...viewPayload(view, cone)
  });
}

/**
 * 启动识别循环。
 *
 * 用 requestVideoFrameCallback 而不是定时器：它只在**来了新视频帧**时回调，
 * 天然与画面同步，也不会把同一帧反复计算。旧版 110ms 定时器在 24fps 视频上
 * 会重复处理同一帧（无效平滑），在 60fps 上又会漏帧。
 * 视频暂停时不回调，箭头停在最后角度 —— 正是想要的行为。
 */
function startBearingLoop() {
  stopBearingLoop();
  BEARING.raw.length = 0;
  BEARING.smooth = -1;
  BEARING.ab.theta = -1;
  BEARING.ab.omega = 0;
  BEARING.ab.suspect = 0;
  BEARING.lastAngle = -1;
  BEARING.logged = false;
  BEARING.invalidSince = 0;
  BEARING.reportedValid = null;
  BEARING.explained = false;
  // 视角通道独立重置：切视频/切分 P 后镜头位置全变了，沿用旧值会先指错一下
  BEARING.view.theta = -1;
  BEARING.view.sent = -1;
  BEARING.view.conf = 0;
  BEARING.view.src = '';

  const v = video;
  if (!v) return;

  if (typeof v.requestVideoFrameCallback === 'function') {
    BEARING.loopKind = 'rvfc';
    const cb = () => {
      if (!BEARING.enabled || video !== v) return;
      try {
        tickBearing();
      } catch (err) {
        console.warn('[跟跑助手] 朝向识别异常：', err.message);
      }
      // 回调每次只触发一次，必须重新注册
      if (BEARING.enabled && video === v) {
        BEARING.rvfc = v.requestVideoFrameCallback(cb);
      }
    };
    BEARING.rvfc = v.requestVideoFrameCallback(cb);
  } else {
    // 老内核兜底：50ms，比旧版 110ms 快一倍
    BEARING.loopKind = 'timer';
    BEARING.timer = setInterval(tickBearing, 50);
  }

  // 守护：B 站切换分 P 时可能整个换掉 <video>，换了就重挂循环
  BEARING.guard = setInterval(() => {
    if (!BEARING.enabled) return;
    if (video && video.isConnected) return;
    bind(pickVideo());
    if (video) startBearingLoop();
  }, 2000);
}

function stopBearingLoop() {
  if (BEARING.rvfc && video && typeof video.cancelVideoFrameCallback === 'function') {
    try {
      video.cancelVideoFrameCallback(BEARING.rvfc);
    } catch {
      /* 元素可能已销毁 */
    }
  }
  BEARING.rvfc = null;
  if (BEARING.timer) clearInterval(BEARING.timer);
  BEARING.timer = null;
  if (BEARING.guard) clearInterval(BEARING.guard);
  BEARING.guard = null;
  BEARING.loopKind = '';
}

/**
 * 调试钩子：把内部状态和几个纯函数挂到隔离世界的 globalThis 上。
 * preload 跑在 Electron 的隔离上下文里，外部（CDP / 启动器）无法直接访问模块作用域，
 * 排查「框到哪了、这一帧算出来什么」时只能靠它。不影响正常识别。
 */
try {
  globalThis.__bearing = {
    state: () => ({
      enabled: BEARING.enabled,
      loopKind: BEARING.loopKind,
      rois: BEARING.rois,
      raw: BEARING.raw.slice(),
      smooth: BEARING.smooth,
      lastAngle: BEARING.lastAngle,
      ticks: BEARING.ticks || 0,
      reportedValid: BEARING.reportedValid,
      ab: { ...BEARING.ab }
    }),
    frame: () => grabFrameWithRoi(),
    window: () => (BEARING.canvas ? BEARING.canvas.toDataURL('image/png') : ''),
    // 把 mask 缩成 44x44 的字符画，用来肉眼确认「到底把什么当成了箭头」
    maskAscii: () => {
      const m = BEARING.mask;
      const meta = BEARING.maskMeta;
      if (!m || !meta) return '';
      const n = 44;
      const cells = [];
      for (let ry = 0; ry < n; ry += 1) {
        let line = '';
        for (let rx = 0; rx < n; rx += 1) {
          const x = Math.floor((rx * meta.size) / n);
          const y = Math.floor((ry * meta.size) / n);
          line += m[y * meta.size + x] ? '#' : '.';
        }
        cells.push(line);
      }
      return cells.join('\n');
    },
    grab: (roi) => {
      const g = grabCenter(roi || BEARING.rois[0]);
      if (!g) return { ok: false };
      const r = analyze(g.img, g.size, g.step);
      // 顺手把扇形也跑一遍，方便一次拿到两路证据做对比（同样用大窗口）
      const gc = grabCenter(roi || BEARING.rois[0], 1.5, 512);
      const c = gc ? analyzeCone(gc.img, gc.size, gc.step) : null;
      return { ok: true, size: g.size, step: g.step, ...r, cone: c, ab: { ...BEARING.ab } };
    },
    // 放大导出：像素级看清箭头到底是三角形、还是只有描边的空心块
    windowZoom: (k) => {
      const s = BEARING.canvas;
      if (!s) return '';
      const z = Math.max(1, Math.min(8, Math.round(k || 4)));
      const c = document.createElement('canvas');
      c.width = s.width * z;
      c.height = s.height * z;
      const cx2 = c.getContext('2d');
      cx2.imageSmoothingEnabled = false;
      cx2.drawImage(s, 0, 0, c.width, c.height);
      return c.toDataURL('image/png');
    },
    // 只放大一块区域（原始像素坐标），并画上每 z 像素一格的网格，用来量顶点位置
    cropZoom: (x0, y0, w, h, k) => {
      const s = BEARING.canvas;
      if (!s) return '';
      const z = Math.max(1, Math.min(8, Math.round(k || 6)));
      const c = document.createElement('canvas');
      c.width = w * z;
      c.height = h * z;
      const cx2 = c.getContext('2d');
      cx2.imageSmoothingEnabled = false;
      cx2.drawImage(s, x0, y0, w, h, 0, 0, c.width, c.height);
      return c.toDataURL('image/png');
    },
    // 最大连通块在原始像素坐标下的字符画（1 格 = 1..cell 像素），带边界与坐标
    asciiBbox: (cell) => {
      const m = BEARING.mask;
      const meta = BEARING.maskMeta;
      if (!m || !meta) return '';
      const size = meta.size;
      const lbl = new Int32Array(size * size);
      const stack = new Int32Array(size * size);
      let bestId = 0;
      let bestArea = 0;
      let compId = 0;
      for (let seed = 0; seed < size * size; seed += 1) {
        if (!m[seed] || lbl[seed]) continue;
        compId += 1;
        lbl[seed] = compId;
        let top = 0;
        stack[top++] = seed;
        let area = 0;
        while (top) {
          const cur = stack[--top];
          const py = (cur / size) | 0;
          const px = cur - py * size;
          area += 1;
          for (let k = 0; k < 4; k += 1) {
            const nx = px + (k === 0 ? 1 : k === 1 ? -1 : 0);
            const ny = py + (k === 2 ? 1 : k === 3 ? -1 : 0);
            if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
            const n = ny * size + nx;
            if (!m[n] || lbl[n]) continue;
            lbl[n] = compId;
            stack[top++] = n;
          }
        }
        if (area > bestArea) {
          bestArea = area;
          bestId = compId;
        }
      }
      if (!bestId) return '';
      let x0 = size;
      let x1 = 0;
      let y0 = size;
      let y1 = 0;
      for (let i3 = 0; i3 < size * size; i3 += 1) {
        if (lbl[i3] !== bestId) continue;
        const py = (i3 / size) | 0;
        const px = i3 - py * size;
        if (px < x0) x0 = px;
        if (px > x1) x1 = px;
        if (py < y0) y0 = py;
        if (py > y1) y1 = py;
      }
      const st = Math.max(1, Math.round(cell || 1));
      const c0 = Math.floor((size - 1) / 2);
      const rows = ['bbox x ' + x0 + '..' + x1 + '  y ' + y0 + '..' + y1 + '  center ' + c0 + '  area ' + bestArea];
      for (let y = y0; y <= y1; y += st) {
        let line = String(y).padStart(4) + ' ';
        for (let x = x0; x <= x1; x += st) {
          line += lbl[y * size + x] === bestId ? '#' : '.';
        }
        rows.push(line);
      }
      rows.push('     ' + ' '.repeat(Math.floor((c0 - x0) / st)) + '^ center x ' + c0);
      return rows.join('\n');
    },
    // ← 起始标记：客观标定工具（仅调试，不参与识别）
    // 小地图是北朝上的静态地图，角色移动时地图内容整体平移。测出平移量就得到
    // 「行进方向」——跟跑视频里角色朝前进方向走，可以拿它当箭头朝向的地面真值。
    // 拆成三个同步调用，避免在页面里 await 事件（seeked 有时不触发，会把 evaluate 挂死）。
    // 直接把识别循环拉起来（正常由渲染进程下发配置，这里给调试用）
    enable: () => {
      if (!video) bind(pickVideo());
      BEARING.enabled = true;
      startBearingLoop();
      return BEARING.loopKind;
    },
    // 诊断：确认 preload 里的 video 还是不是页面上那个
    ping: () => {
      const list = Array.from(document.querySelectorAll('video'));
      return {
        bound: !!video,
        connected: !!(video && video.isConnected),
        same: !!(video && list[0] === video),
        n: list.length,
        t: video ? Math.round(video.currentTime * 100) / 100 : -1,
        rs: video ? video.readyState : -1,
        dur: video ? Math.round((video.duration || 0) * 100) / 100 : -1,
        vw: video ? video.videoWidth : 0
      };
    },
    rebind: () => {
      video = null;
      bind(pickVideo());
      return !!(video && video.isConnected);
    },
    // 关键：Chromium 在**暂停**状态下 seek 不会重绘，drawImage 拿到的还是旧帧
    // （实测 currentTime 从 25.2 变到 33.0，取到的像素完全一样）。
    // 所以这里 seek 之后短暂 play 一下强制出一帧，再自动暂停。
    seekTo: (t, playMs) => {
      const v = video;
      if (!v) return false;
      try {
        v.currentTime = t;
        v.play().catch(() => {});
      } catch {
        return false;
      }
      clearTimeout(BEARING.seekTimer);
      BEARING.seekTimer = setTimeout(() => {
        try {
          v.pause();
        } catch {
          /* 忽略 */
        }
      }, Math.max(120, playMs || 320));
      return true;
    },
    pauseNow: () => {
      if (video) {
        try {
          video.pause();
        } catch {
          /* 忽略 */
        }
      }
      return true;
    },
    // 导出某一时刻的裁剪放大图，用于人工核对
    shot: (t, x0, y0, w, h, k) => {
      const v = video;
      if (!v) return '';
      v.currentTime = t;
      v.play().catch(() => {});
      return new Promise((res) => {
        setTimeout(() => {
          try {
            v.pause();
          } catch {
            /* 忽略 */
          }
          res(
            globalThis.__bearing.cropZoom(x0, y0, w, h, k) ||
              ''
          );
        }, 700);
      });
    },
    // 把当前窗口存成基准帧
    markPrev: (roi) => {
      const g = grabCenter(roi || BEARING.rois[0]);
      if (!g) return false;
      BEARING.prev = { data: new Uint8ClampedArray(g.img.data), size: g.size };
      return true;
    },
    // 与基准帧做 SAD，返回地图内容的平移量 → 换算成行进方向
    flow: (roi) => {
      const g = grabCenter(roi || BEARING.rois[0]);
      const A = BEARING.prev;
      if (!g || !A || A.size !== g.size) return { ok: false, why: 'no baseline' };
      const size = g.size;
      const st = 2;
      const pad = Math.round(size * 0.08);
      const lo = -pad;
      let bestSx = 0;
      let bestSy = 0;
      let bestCost = Infinity;
      for (let sy = lo; sy <= pad; sy += 1) {
        for (let sx = lo; sx <= pad; sx += 1) {
          let cost = 0;
          let n = 0;
          for (let y = pad; y < size - pad; y += st) {
            const by = y + sy;
            if (by < 0 || by >= size) continue;
            for (let x = pad; x < size - pad; x += st) {
              const bx = x + sx;
              if (bx < 0 || bx >= size) continue;
              const ia = (y * size + x) * 4;
              const ib = (by * size + bx) * 4;
              cost += Math.abs(A.data[ia] - g.img.data[ib]);
              n += 1;
            }
          }
          if (!n) continue;
          cost /= n;
          if (cost < bestCost) {
            bestCost = cost;
            bestSx = sx;
            bestSy = sy;
          }
        }
      }
      // (bestSx,bestSy) 是「地图内容」的屏幕位移，玩家位移与之相反；
      // 屏幕 y 向下，翻成数学坐标后 dy 取正。
      const moveDx = -bestSx;
      const moveDy = bestSy;
      return {
        ok: true,
        shift: { sx: bestSx, sy: bestSy },
        cost: Math.round(bestCost * 100) / 100,
        travelAngle: Math.round(degOf(moveDx, moveDy) * 10) / 10,
        travelRho: Math.round(Math.sqrt(moveDx * moveDx + moveDy * moveDy) * 10) / 10
      };
    },
    radial: (bins) => {
      const m = BEARING.mask;
      const meta = BEARING.maskMeta;
      if (!m || !meta) return [];
      const N = Math.max(8, Math.min(120, Math.round(bins || 36)));
      const size = meta.size;
      const c0 = (size - 1) / 2;
      // 用与 analyze 相同的连通块规则取最大块，避免把远处图标算进来
      const lbl = new Int32Array(size * size);
      const stack = new Int32Array(size * size);
      let bestId = 0;
      let bestArea = 0;
      let compId = 0;
      for (let seed = 0; seed < size * size; seed += 1) {
        if (!m[seed] || lbl[seed]) continue;
        compId += 1;
        lbl[seed] = compId;
        let top = 0;
        stack[top++] = seed;
        let area = 0;
        while (top) {
          const cur = stack[--top];
          const py = (cur / size) | 0;
          const px = cur - py * size;
          area += 1;
          for (let k = 0; k < 4; k += 1) {
            const nx = px + (k === 0 ? 1 : k === 1 ? -1 : 0);
            const ny = py + (k === 2 ? 1 : k === 3 ? -1 : 0);
            if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
            const n = ny * size + nx;
            if (!m[n] || lbl[n]) continue;
            lbl[n] = compId;
            stack[top++] = n;
          }
        }
        if (area > bestArea) {
          bestArea = area;
          bestId = compId;
        }
      }
      if (!bestId) return [];
      const out = [];
      for (let b = 0; b < N; b += 1) {
        out.push({ deg: Math.round((b * 360) / N), far: 0, n: 0, sum: 0 });
      }
      for (let i3 = 0; i3 < size * size; i3 += 1) {
        if (lbl[i3] !== bestId) continue;
        const py = (i3 / size) | 0;
        const px = i3 - py * size;
        const ddx = px - c0;
        const ddy = c0 - py;
        const rr = Math.sqrt(ddx * ddx + ddy * ddy);
        let a = (Math.atan2(ddy, ddx) * 180) / Math.PI;
        if (a < 0) a += 360;
        const b = Math.min(N - 1, Math.floor((a * N) / 360));
        if (rr > out[b].far) out[b].far = Math.round(rr * 10) / 10;
        out[b].n += 1;
        out[b].sum += rr;
      }
      for (const o of out) o.mean = o.n ? Math.round((o.sum / o.n) * 10) / 10 : 0;
      return out;
    }
  };
} catch {
  /* 调试接口挂了不影响识别 */
}

/** 导出一张整帧缩略图，并把当前识别区域用红框标出来，用于人工校准 */
function grabFrameWithRoi() {
  if (!video || !video.videoWidth) return '';
  const w = Math.min(480, video.videoWidth);
  const h = Math.round((video.videoHeight / video.videoWidth) * w);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  try {
    ctx.drawImage(video, 0, 0, w, h);
  } catch {
    return '';
  }

  const k = w / video.videoWidth;

  ctx.strokeStyle = '#ff0000';
  ctx.lineWidth = 1.5;

  for (const roi of BEARING.rois) {
    const cx = roi.cx * video.videoWidth * k;
    const cy = roi.cy * video.videoHeight * k;
    const r = Math.max(6, roi.r * video.videoWidth * k);

    ctx.strokeRect(cx - r, cy - r, r * 2, r * 2);
    ctx.beginPath();
    ctx.moveTo(cx - 4, cy);
    ctx.lineTo(cx + 4, cy);
    ctx.moveTo(cx, cy - 4);
    ctx.lineTo(cx, cy + 4);
    ctx.stroke();
  }

  return c.toDataURL('image/png');
}

/**
 * 上报 <video> 在页面里的实际位置与缩放方式。
 *
 * 标定界面在浮窗里画圈，而识别用的是视频原始像素，两者之间必须知道：
 * 元素摆在哪、多大、以及画面是完整显示（contain）还是被裁切（cover）。
 * 少了这层换算，宽窗口下的框选就是错的。
 */
function videoRectInfo() {
  if (!video || !video.isConnected) return { ok: false, error: 'no-video' };
  if (!video.videoWidth || !video.videoHeight) return { ok: false, error: 'no-frame' };

  const r = video.getBoundingClientRect();
  let fit = 'contain';
  try {
    fit = getComputedStyle(video).objectFit || 'contain';
  } catch {
    /* 保持默认 */
  }

  return {
    ok: true,
    x: r.left,
    y: r.top,
    w: r.width,
    h: r.height,
    vw: video.videoWidth,
    vh: video.videoHeight,
    fit,
    vpW: window.innerWidth,
    vpH: window.innerHeight
  };
}

function setBearing(cfg = {}) {
  // 区域列表是主入口；旧的单区域参数保留兼容
  if (Array.isArray(cfg.rois)) {
    BEARING.rois = cfg.rois
      .filter((r) => r && Number.isFinite(r.cx) && Number.isFinite(r.cy) && Number.isFinite(r.r))
      .slice(0, 4);
  } else if (Number.isFinite(cfg.mapCx)) {
    BEARING.rois = [{ cx: cfg.mapCx, cy: cfg.mapCy, r: cfg.mapR }];
  }

  if (cfg.dump) {
    const first = BEARING.rois[0];
    const g = first ? grabCenter(first) : null;
    if (!g) {
      ipcRenderer.sendToHost('bearing-dump', {
        dataUrl: '',
        error: video ? '坐标越界或像素读取被拒' : '还没找到 video 元素'
      });
    } else {
      let opaque = 0;
      const px = g.img.data;
      for (let i = 3; i < px.length; i += 4) if (px[i] > 0) opaque += 1;

      try {
        ipcRenderer.sendToHost('bearing-dump', {
          dataUrl: BEARING.canvas.toDataURL('image/png'),
          frame: grabFrameWithRoi(),
          size: g.size,
          vw: video.videoWidth,
          vh: video.videoHeight,
          ready: video.readyState,
          opaque,
          total: g.size * g.size,
          src: (video.currentSrc || '').slice(0, 24),
          rois: BEARING.rois
        });
      } catch (err) {
        console.warn('[跟跑助手] 导出小地图截图失败', err.message);
      }
    }
  }

  // 纯 dump 调用（只抓一帧比对，不动识别开关）
  if (cfg.on === undefined) return;

  const on = !!cfg.on;
  BEARING.enabled = on;

  if (on) {
    if (!BEARING.guard && !BEARING.rvfc) {
      if (!video) bind(pickVideo());

      // 打一行画面几何信息：标定坐标对不上时，这是唯一能直接核对的依据
      const info = videoRectInfo();
      if (info.ok) {
        console.log(
          `[跟跑助手] 视频元素 ${Math.round(info.w)}×${Math.round(info.h)} @(${Math.round(info.x)}, ${Math.round(info.y)})` +
            ` · 视口 ${info.vpW}×${info.vpH} · 源 ${info.vw}×${info.vh} · object-fit=${info.fit}`
        );
      }

      startBearingLoop();
    }
  } else if (BEARING.guard || BEARING.rvfc || BEARING.timer) {
    stopBearingLoop();
    ipcRenderer.sendToHost('bearing', { ok: false });
  }
}

/* ---------------------------------------------------------------- 指令 */

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function safePlay() {
  if (!video) return;
  const p = video.play();
  if (p && typeof p.catch === 'function') p.catch(() => {});
}

function apply(msg) {
  if (!msg || typeof msg !== 'object') return;

  if (msg.cmd === 'clean') {
    setClean(!!msg.on);
    return;
  }
  if (msg.cmd === 'bearing') {
    setBearing(msg);
    return;
  }
  if (msg.cmd === 'video-rect') {
    if (!video) bind(pickVideo());
    ipcRenderer.sendToHost('video-rect', videoRectInfo());
    return;
  }
  if (msg.cmd === 'ping') {
    if (!video) bind(pickVideo());
    push(true);
    return;
  }
  if (!video) {
    bind(pickVideo());
    if (!video) return;
  }

  switch (msg.cmd) {
    case 'toggle':
      if (video.paused || video.ended) safePlay();
      else video.pause();
      break;
    case 'play':
      safePlay();
      break;
    case 'pause':
      video.pause();
      break;
    case 'seek': {
      const t = Number(msg.value) || 0;
      video.currentTime = clamp(t, 0, video.duration || 1e9);
      break;
    }
    case 'seekBy': {
      const t = video.currentTime + (Number(msg.value) || 0);
      video.currentTime = clamp(t, 0, video.duration || 1e9);
      break;
    }
    case 'rate':
      video.playbackRate = clamp(Number(msg.value) || 1, 0.25, 3);
      break;
    case 'mute':
      video.muted = !!msg.value;
      break;
    case 'volume':
      video.volume = clamp(Number(msg.value) || 0, 0, 1);
      video.muted = video.volume === 0;
      break;
    default:
      break;
  }
  push(true);
}

/* ------------------------------------------------- 网页版「纯净模式」样式 */

const CLEAN_CSS = `
  .bili-header, #biliMainHeader, .international-header,
  .right-container, #reco_list, .recommend-list-v1,
  .video-toolbar-container, .video-toolbar-left, .video-toolbar-right,
  #commentapp, .bili-comments, .comment-container,
  .video-sections-container, .bili-video-card, .pop-live-small-mode,
  .fixed-sidenav-storage-component, .ad-report { display: none !important; }
  .left-container { width: 100% !important; max-width: 100% !important; padding: 0 !important; margin: 0 !important; }
  html, body { background: #000 !important; }
`;

function setClean(on) {
  cleanOn = on;
  if (!/^www\.bilibili\.com$/.test(location.hostname)) return;
  if (on && !cleanStyle) {
    cleanStyle = document.createElement('style');
    cleanStyle.id = 'route-buddy-clean';
    cleanStyle.textContent = CLEAN_CSS;
    (document.head || document.documentElement).appendChild(cleanStyle);
    expandPlayer();
  } else if (!on && cleanStyle) {
    cleanStyle.remove();
    cleanStyle = null;
  }
}

/**
 * 浮窗尺寸很小时，替用户点一下播放器的「网页全屏」，
 * 让视频铺满整个浮窗（比把页面元素一个个隐藏掉可靠得多）。
 */
let fullscreenTried = false;

function expandPlayer() {
  // 这里以前还有一条 `window.innerWidth >= 900` 的跳过条件：窗口一旦被调宽，
  // 就再也不点网页全屏了，可 B 站页面里的 video 还是 320×180 的小窗，
  // 于是宽窗口里只有中间一小块画面。浮窗永远是小窗口，一律铺满。
  if (fullscreenTried) return;
  fullscreenTried = true;

  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    if (tries > 12 || !document.body) {
      clearInterval(timer);
      return;
    }
    const btn = document.querySelector('.bpx-player-ctrl-web');
    if (!btn) return;
    btn.click();
    clearInterval(timer);
    console.log('[跟跑助手] 已切到播放器网页全屏');
  }, 1000);
}

/* ---------------------------------------------------------------- 启动 */

function boot() {
  bind(pickVideo());
  if (cleanOn) setClean(cleanOn);

  // 自动连播下一 P 时 ?p= 会变，但不一定伴随视频事件（也可能整页导航）。
  // 单独轮询地址栏，变了就立刻把新页码推给浮窗；整页导航则由新 preload 的
  // boot() → bind() → push(true) 覆盖。两条路都指向同一个 snapshot()。
  let lastHref = location.href;
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    push(true);
  }, 500);

  // B 站是 SPA，切 P / 换片会重建 <video>，持续轮询兜底
  setInterval(() => {
    const v = pickVideo();
    if (v && v !== video) bind(v);
    else if (!v && video && !video.isConnected) {
      video = null;
      push(true);
    }
  }, 700);

  // 无播放事件时也保持状态新鲜（比如卡在加载中）
  setInterval(() => {
    if (video && !video.paused) push();
  }, 1000);
}

ipcRenderer.on('player', (_e, msg) => apply(msg));

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

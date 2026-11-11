'use strict';

/**
 * 方位标记叠加层。
 *
 * 画两个**独立**的量：
 *   · 红箭头   行进方向 —— 青色三角解出来的，人往哪走
 *   · 绿弧段   视角方向 —— 白色扇形（镜头视锥）解出来的，镜头朝哪看
 *
 * 这两者在原神里本来就能不一致：站着不动把鼠标往后拉，人没动、视角转了 180°。
 * 所以绝不能合成一个角度 —— 一旦合并，两种状态都会被对方带歪。各算各的、
 * 各补各的间、各画各的。
 *
 * 坐标约定：两者都是罗盘角（0°=北、顺时针），画到 canvas 上要减 90°。
 */

const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');

let placing = false;

/* 两路角度各有一套补间状态，互不干扰 */
const tween = {
  arrow: { target: null, shown: null, raf: 0 },
  view: { target: null, shown: null, raf: 0, conf: 0, width: 0, at: 0 }
};

// 视觉常量：与浮窗的深色主题保持同一套红
const RED = '#ff2f2f';
const RED_SOFT = 'rgba(255, 47, 47, 0.72)';
const WHITE = 'rgba(255, 255, 255, 0.94)';
const GREEN = '#35d96b';

/** 视角多久没更新就把绿弧收起来，避免画面里明明没视锥却挂一段假绿 */
const VIEW_STALE_MS = 1500;

function shortAngle(a, b) {
  return ((a - b + 540) % 360) - 180;
}

function radius(w, h) {
  return (Math.min(w, h) / 2) * 0.86;
}

/**
 * 补间一帧。
 *
 * 识别端已经做到「有新帧才算」，但 IPC 到这边是一跳一跳的。
 * 每帧追 45% 的差值，大约 3~4 帧收敛，视觉上是连续转动而不是硬切，代价 ~50ms。
 */
function step(key) {
  const t = tween[key];
  t.raf = 0;
  if (t.shown === null || t.target === null) return;

  const d = shortAngle(t.target, t.shown);
  if (Math.abs(d) < 0.25) {
    t.shown = t.target;
    draw();
    return;
  }
  t.shown = (t.shown + d * 0.45 + 360) % 360;
  draw();
  t.raf = requestAnimationFrame(() => step(key));
}

/**
 * 设目标角度。大跳（>90°，比如切镜头、认到别处）不补间，直接就位，
 * 否则会看到画面绕一整圈转过去，比硬切还难看。
 */
function setTarget(key, deg) {
  const t = tween[key];
  t.target = deg;
  if (t.shown === null || Math.abs(shortAngle(deg, t.shown)) > 90) {
    t.shown = deg;
    draw();
    return;
  }
  if (!t.raf) t.raf = requestAnimationFrame(() => step(key));
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth;
  const h = window.innerHeight;

  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  cv.style.width = `${w}px`;
  cv.style.height = `${h}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

function drawRing(cx, cy, r) {
  ctx.save();
  ctx.setLineDash([6, 7]);
  ctx.strokeStyle = RED_SOFT;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.strokeStyle = RED_SOFT;
  ctx.beginPath();
  ctx.moveTo(cx - 9, cy);
  ctx.lineTo(cx + 9, cy);
  ctx.moveTo(cx, cy - 9);
  ctx.lineTo(cx, cy + 9);
  ctx.stroke();
  ctx.restore();
}

/**
 * 外环绿弧：一段带圆头的弧，标出视角朝向。
 *
 * 弧的半张角不直接照搬实体视锥（用户确认恒为 90°），而是夹在 18°~34°：
 * 太长会把整圈环糊掉，太短又看不出朝向。按参考图的比例，
 * 整段弧大约占圆周的 1/6 到 1/5，一眼能读出方向又不抢戏。
 */
function drawViewArc(cx, cy, r, deg, conf, width) {
  const half = Math.max(18, Math.min(34, (width > 0 ? width : 60) * 0.45));
  const a0 = ((deg - 90 - half) * Math.PI) / 180;
  const a1 = ((deg - 90 + half) * Math.PI) / 180;
  const lw = Math.max(4, r * 0.075);
  const alpha = 0.45 + 0.5 * Math.max(0, Math.min(1, conf));

  ctx.save();
  ctx.lineCap = 'round';

  // 深色垫底：绿弧压在草地/天空这类彩色地形上，没有一圈暗边会糊成一团
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.lineWidth = lw + 3;
  ctx.beginPath();
  ctx.arc(cx, cy, r, a0, a1);
  ctx.stroke();

  ctx.globalAlpha = alpha;
  ctx.strokeStyle = GREEN;
  ctx.lineWidth = lw;
  ctx.beginPath();
  ctx.arc(cx, cy, r, a0, a1);
  ctx.stroke();

  ctx.restore();
}

function drawArrow(cx, cy, r, deg) {
  const a = ((deg - 90) * Math.PI) / 180;
  const dx = Math.cos(a);
  const dy = Math.sin(a);

  // 起点靠近中心、尖端落在圆环**内侧**：外环还要留给绿弧，
  // 箭头探出环外会和绿弧叠在一起，两样都看不清
  const r0 = r * 0.42;
  const r1 = r * 0.84;
  const head = Math.max(11, r * 0.15);
  const halfW = head * 0.6;

  const x0 = cx + dx * r0;
  const y0 = cy + dy * r0;
  const x1 = cx + dx * r1;
  const y1 = cy + dy * r1;

  // 尖端再往外探出一点，落在圆环内侧边缘
  const tipX = cx + dx * (r1 + head * 0.75);
  const tipY = cy + dy * (r1 + head * 0.75);

  // 垂直于箭头方向的单位向量，用来撑开箭头两翼
  const px = -dy;
  const py = dx;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // 第一遍：白色描边，保证在雪地/深色地形上都能看见
  ctx.strokeStyle = WHITE;
  ctx.lineWidth = 9;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();

  ctx.fillStyle = WHITE;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(x1 + px * (halfW + 2), y1 + py * (halfW + 2));
  ctx.lineTo(x1 - px * (halfW + 2), y1 - py * (halfW + 2));
  ctx.closePath();
  ctx.fill();

  // 第二遍：红色主体
  ctx.strokeStyle = RED;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();

  ctx.fillStyle = RED;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(x1 + px * halfW, y1 + py * halfW);
  ctx.lineTo(x1 - px * halfW, y1 - py * halfW);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

function draw() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  ctx.clearRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h / 2;
  const r = radius(w, h);

  if (placing) drawRing(cx, cy, r);

  // 绿弧画在箭头下面：两者重叠时箭头要压在上面看得清
  const v = tween.view;
  if (v.shown !== null && Date.now() - v.at < VIEW_STALE_MS) {
    drawViewArc(cx, cy, r, v.shown, v.conf, v.width);
  }
  if (tween.arrow.shown !== null) drawArrow(cx, cy, r, tween.arrow.shown);
}

/** 视角有更新时续期，并在过期那一刻重绘一次把绿弧收掉 */
let viewExpireTimer = 0;
function touchView() {
  tween.view.at = Date.now();
  clearTimeout(viewExpireTimer);
  viewExpireTimer = setTimeout(draw, VIEW_STALE_MS + 50);
}

window.addEventListener('resize', resize);

window.overlayApi.onBearing((payload) => {
  if (!payload) return;

  // 箭头：hold 表示这一帧的判据是「疑似反向」，保持原角度不动，不要跟着转
  if (!payload.hold && typeof payload.angle === 'number') {
    setTarget('arrow', payload.angle);
  }

  // 视角：可能是 null（这一帧没识别到扇形）。
  // 这时**不续期**，让绿弧自然过期消失 —— 否则会挂一段没有证据的假方向。
  if (typeof payload.view === 'number') {
    tween.view.conf = payload.viewConfidence || 0;
    tween.view.width = payload.viewWidth || 0;
    setTarget('view', payload.view);
    touchView();
  }
});

window.overlayApi.onMode((mode) => {
  placing = mode === 'place';
  document.body.classList.toggle('placing', placing);
  draw();
});

resize();

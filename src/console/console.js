'use strict';

/**
 * 启动器 —— 所有设置都在这里改。
 * 浮窗只负责播放和方位箭头，本身不带任何设置界面。
 */

const $ = (id) => document.getElementById(id);

const state = {
  boot: null,
  video: null, // 当前载入的 { text, id, pages, p, title }
  floatRunning: false,
  placing: false, // 方位红圈是否处于「可拖动」状态，只由主进程返回值驱动
  toastTimer: null
};

/** 自动定心失败的原因 → 给用户看的话 */
const AUTO_CENTER_FAIL = {
  paused: '视频没在播放，先播放再点自动定心',
  timeout: '没学会圆心：画面里可能没有小地图，或角色一直没转向，再点一次并让角色转个身',
  disabled: '先打开「显示方位箭头」',
  'no-roi': '还没框选视频里的小地图',
  'no-video': '浮窗里还没载入视频，先启动跟跑',
  reset: '已取消',
  'save-failed': '已对准，但写入标定失败'
};

/* ------------------------------------------------------------------ 启动 */

document.addEventListener('DOMContentLoaded', init);

async function init() {
  state.boot = await window.api.boot();
  const s = state.boot.settings;

  $('ver').textContent = 'v' + (state.boot.version || '');

  // 数据目录：便携版就在 exe 同级的 data\，开发版还是 %APPDATA%
  $('dataDir').textContent = state.boot.dataDir || '—';
  // 路径长了会被省略号截断，挂个 title 让鼠标悬停能看到完整路径
  $('dataDir').title = state.boot.dataDir || '';
  // 四种形态各说各的。以前只分「便携 / 其它」，安装版也会显示「当前为开发模式」。
  const mode = state.boot.installMode || (state.boot.portable ? 'portable' : 'dev');
  const dataTips = {
    portable: '绿色版：设置、标定和登录态都在 data\\ 里，整个文件夹拷走即可迁移；别把它发给别人',
    installed: '安装版：设置、标定和登录态都在这里，卸载不会删除，重装可以接着用',
    fallback: '程序目录不可写，已改存到系统 %APPDATA% 目录',
    dev: '开发模式：用的是系统 %APPDATA% 目录'
  };
  $('dataTip').textContent = dataTips[mode] || dataTips.dev;
  $('dataTip').title = $('dataTip').textContent;
  $('btnOpenData').addEventListener('click', () => window.api.action('open-data'));

  // 滑块拖动时同步左侧的填充；程序改值（fillSettings）那条路在 fillSettings 里单独调
  document.addEventListener('input', (e) => {
    if (e.target && e.target.type === 'range') paintRange(e.target);
  });

  fillSettings(s);
  renderHotkeys();
  applyNav(state.boot.nav);

  // 上次看过的视频先填进输入框，省得每次重新粘。
  // 分 P 下拉也必须预置到上次那一集：空 <select> 的 value 是 ''，
  // 点「启动跟跑」时 Number('')||1 会把 lastPart 覆写成 P1，进度就丢了。
  if (s.lastText) $('url').value = s.lastText;
  renderLastPart(s);
  renderLastWatched(s);
  updateVideoMeta();

  wireVideo();
  wireSettings();
  wireBearing();
  wireHotkeys();

  // 启动器窗口可能被关掉再打开，此刻主进程的放置状态未必是初始值，
  // 按钮文案必须对齐主进程，否则「显示 ② 拖到…」却一点就变成锁定。
  syncPlaceButton();

  // 只有在输入框里真的打字时才让单键热键让路。以前是「本程序窗口在前台就全忽略」，
  // 结果用户在启动器里按 J 想试试热键，一律被吞掉，看起来就像热键没接上。
  const isField = (el) =>
    !!el && /^(INPUT|TEXTAREA)$/.test(el.tagName) && !['checkbox', 'radio', 'range'].includes(el.type);
  document.addEventListener('focusin', (e) => window.api.typing(isField(e.target)));
  document.addEventListener('focusout', () => window.api.typing(false));

  window.api.onFloatState((st) => setFloatState(!!(st && st.running)));
  window.api.onLogin((nav) => applyNav(nav));
  // 「③ 自动定心」的结果：主进程写标定成功后还会广播 settings，这里只负责告诉用户
  window.api.onAutoCenterResult((r) => {
    if (!r) return;
    if (r.ok && r.applied) toast(`自动定心完成：圆心已修正 (${r.dx}, ${r.dy})px，已记住`);
    else if (r.ok) toast('圆心本来就对准了，不用调整');
    else toast(AUTO_CENTER_FAIL[r.reason] || '自动定心没成功，再试一次', true);
  });
  // 浮窗改了设置（比如按热键切了穿透）就同步回界面
  window.api.onSettingsChanged((next) => {
    state.boot.settings = next;
    fillSettings(next);
    // 浮窗换片 / 自动连播下一 P 时，「上次看到」要立刻跟上
    renderLastWatched(next);
    // 同一个视频里切了 P，启动器的下拉与当前 P 标注也跟着走
    if (
      state.video &&
      next.lastPart &&
      next.lastPart !== state.video.p &&
      (!next.lastVideoId || !state.video.id ||
        String(next.lastVideoId).toLowerCase() === String(state.video.id).toLowerCase())
    ) {
      state.video.p = next.lastPart;
      renderParts();
      updateVideoMeta();
    }
  });
}

/* ------------------------------------------------------------ 视频与浮窗 */

function wireVideo() {
  $('btnLaunch').addEventListener('click', launch);
  $('btnResume').addEventListener('click', resumeLast);
  $('url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') launch();
  });

  $('part').addEventListener('change', async () => {
    const p = Number($('part').value) || 1;
    if (!state.video) return;
    state.video.p = p;
    renderParts();
    updateVideoMeta();
    await window.api.save({ lastPart: p });
    await window.api.load({ text: state.video.text, p });
    await window.api.action('float-load', { text: state.video.text, p });
    updateVideoMeta();
  });

  $('btnStop').addEventListener('click', () => window.api.action('stop-float'));
}

/**
 * 点「启动跟跑」时用第几 P。
 * 输入框里贴了和上次不同的链接 = 换片 → P1；否则沿用下拉里选中的（上次那一集）。
 * 抽成纯函数便于离线回归。
 */
function partForLaunch(text, s, selValue) {
  const t = String(text || '').trim();
  const last = String((s && s.lastText) || '').trim();
  if (t && last && t !== last) return 1;
  const n = Number(selValue);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return Math.max(1, Math.floor(Number(s && s.lastPart) || 1));
}

/** 「继续观看」：把记录填回去，再走正常的启动流程 */
async function resumeLast() {
  const s = state.boot.settings;
  if (!s.lastText) {
    toast('还没有观看记录', true);
    return;
  }
  $('url').value = s.lastText;
  const p = Math.max(1, Number(s.lastPart) || 1);
  if (!state.video) renderLastPart(s);
  $('part').value = String(p);
  await launch();
}

async function launch() {
  const text = $('url').value.trim();
  if (!text && !state.boot.settings.lastText) {
    toast('先粘一个 B 站链接', true);
    $('url').focus();
    return;
  }

  $('btnLaunch').disabled = true;
  $('btnLaunch').textContent = '载入中…';

  try {
    if (text) {
      const p = partForLaunch(text, state.boot.settings, $('part').value);
      const res = await window.api.load({ text, p });
      if (!res.ok) {
        toast(res.message || '载入失败', true);
        return;
      }
      state.video = {
        text,
        id: res.id,
        title: res.title || '',
        pages: res.pages || [],
        p: res.p
      };
      // 本地先同步一次：bili:load 的广播是异步的，紧接着再点「启动跟跑」
      // 不能因为快照还没刷新就被误判成「换片」而退回 P1。
      Object.assign(state.boot.settings, {
        lastText: text,
        lastPart: res.p,
        lastTitle: res.title || '',
        lastVideoId: res.id,
        lastPageCount: (res.pages || []).length,
        lastWatchedAt: Date.now()
      });
      renderParts();
      renderLastWatched(state.boot.settings);
      updateVideoMeta();
      // 换视频后「已标定 N 处」要按新视频的记录重算，否则一直显示上一个视频的数字
      fillSettings(state.boot.settings);
    }

    await window.api.action('start-float');
    // 浮窗已经在跑的时候不能只切窗口，得让它换片
    if (state.floatRunning && text) {
      await window.api.action('float-load', { text, p: (state.video && state.video.p) || 1 });
    }
    toast('浮窗已启动，按 Alt+H 可以随时隐藏');
  } finally {
    $('btnLaunch').disabled = false;
    $('btnLaunch').textContent = '启动跟跑';
  }
}

/** 还没载入视频时，先给分 P 下拉一个「上次的 P」占位，避免 launch() 取到空值 */
function renderLastPart(s) {
  if (state.video) return;
  const sel = $('part');
  const p = Math.max(1, Number(s.lastPart) || 1);
  const total = Number(s.lastPageCount) || 0;
  sel.textContent = '';
  const opt = document.createElement('option');
  opt.value = String(p);
  opt.textContent = `▶ P${p}${total ? '/' + total : ''}`;
  opt.title = opt.textContent;
  sel.appendChild(opt);
  sel.value = String(p);
  sel.disabled = true;
  sel.title = '载入视频后可选分 P';
}

function renderParts() {
  const sel = $('part');
  const pages = (state.video && state.video.pages) || [];
  sel.textContent = '';

  if (!pages.length) {
    const opt = document.createElement('option');
    opt.textContent = '仅 1 个分 P';
    opt.value = '1';
    opt.title = '仅 1 个分 P';
    sel.appendChild(opt);
    sel.value = '1';
    sel.disabled = true;
    sel.title = '仅 1 个分 P';
    return;
  }

  sel.disabled = false;
  const total = pages.length;
  let curLabel = '';
  for (const pg of pages) {
    const opt = document.createElement('option');
    opt.value = String(pg.page);
    // 和浮窗的下拉保持一致：把「第几 P / 共几 P」写进文本，当前项加 ▶
    const label = `P${pg.page}/${total} ${pg.part || ''}`.trim();
    const cur = !!(state.video && pg.page === state.video.p);
    opt.textContent = cur ? `▶ ${label}` : label;
    opt.title = label;
    sel.appendChild(opt);
    if (cur) curLabel = label;
  }
  sel.value = String(state.video ? state.video.p : 1);
  sel.title = curLabel ? `当前 ${curLabel}` : '分 P';
}

/* ------------------------------------------------------------ 上次看到 */

/** 时间戳 → 今天 / 昨天 / M月D日，带上时分；老记录没有时间戳就返回空 */
function fmtWatchedAt(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return `今天 ${hm}`;
  if (diff === 1) return `昨天 ${hm}`;
  // 同一年内才省掉年份；否则「去年 12 月」会显示成「12月31日」被误读成今年
  if (diff > 1 && d.getFullYear() === now.getFullYear())
    return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** 纯逻辑：从设置里挑出「上次看到」要显示的三段信息，便于离线回归 */
function lastWatchedLabel(s) {
  const name = String((s && (s.lastTitle || s.lastVideoId || s.lastText)) || '').trim();
  if (!name) return null;
  const p = Math.max(1, Number(s && s.lastPart) || 1);
  const total = Number(s && s.lastPageCount) || 0;
  return { name, part: `P${p}${total ? '/' + total : ''}`, when: fmtWatchedAt(s && s.lastWatchedAt) };
}

function renderLastWatched(s) {
  const bar = $('resumeBar');
  const info = lastWatchedLabel(s);
  if (!info) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const tail = `${info.part}${info.when ? ' · ' + info.when : ''}`;
  const el = $('resumeInfo');
  el.innerHTML = `<b>${escapeHtml(info.name)}</b> <span class="dim">· ${escapeHtml(tail)}</span>`;
  el.title = `${info.name} · ${info.part}${info.when ? ' · ' + info.when : ''}`;
}

function updateVideoMeta() {
  const v = state.video;
  if (!v) {
    $('videoMeta').textContent = state.boot.settings.resumeOnLaunch
      ? '已开启「下次启动自动继续」，启动时直接接着看'
      : '还没载入视频；点「启动跟跑」开始';
    return;
  }
  const title = v.title || v.id;
  $('videoMeta').innerHTML =
    `<b>${escapeHtml(title)}</b> · 当前 P${v.p}${v.pages.length ? '/' + v.pages.length : ''}`;
}

function setFloatState(on) {
  state.floatRunning = on;
  const badge = $('floatState');
  badge.textContent = on ? '浮窗运行中' : '浮窗未启动';
  badge.className = 'badge ' + (on ? 'on' : 'off');
  $('btnStop').disabled = !on;
}

/* ---------------------------------------------------------------- 设置 */

/** 当前视频真正生效的识别区域：优先视频专属记录，其次全局 —— 跟浮窗里 roisFor() 保持一致 */
function effectiveRois(b, videoId) {
  const own = videoId && b.roiBy ? b.roiBy[videoId] : null;
  if (Array.isArray(own) && own.length) return own;
  return Array.isArray(b.rois) ? b.rois : [];
}

/**
 * 滑块左侧「已走过」的部分要填强调色，但 Chromium 的 range 没有对应的伪元素，
 * 只能把当前百分比写进 CSS 变量，由 console.css 里的渐变背景去画。
 */
function paintRange(el) {
  const min = Number(el.min) || 0;
  const max = Number(el.max) || 100;
  const pct = max > min ? ((Number(el.value) - min) / (max - min)) * 100 : 0;
  el.style.setProperty('--fill', `${Math.min(100, Math.max(0, pct))}%`);
}

function fillSettings(s) {
  $('setPin').checked = !!s.pinned;
  $('setPass').checked = !!s.clickThrough;
  // 老 settings.json 没这个字段，默认视为开启
  $('setResumeOnLaunch').checked = s.resumeOnLaunch !== false;

  const op = Math.round((s.opacity ?? 1) * 100);
  $('setOpacity').value = String(op);
  $('opacityVal').textContent = op + '%';

  const vol = s.volume ?? 100;
  $('setVolume').value = String(vol);
  $('volumeVal').textContent = vol + '%';

  const b = s.bearing || {};
  $('setBearing').checked = !!b.enabled;
  $('setBearingSize').value = String(b.radius ?? 110);
  $('sizeVal').textContent = String(b.radius ?? 110);

  // 数量要按「这个视频实际会用到的」算，直接用全局 rois 会和浮窗对不上
  const n = effectiveRois(b, state.video && state.video.id).length;
  const done = !!(b.calibrated && n);
  $('btnPickRoi').textContent = done
    ? `① 框选小地图（已标定 ${n} 处）`
    : '① 框选视频里的小地图（未标定）';
  // 标定过的那一步打个绿勾，一眼能看出两步走到哪了
  $('btnPickRoi').classList.toggle('done', done);

  for (const id of ['setOpacity', 'setVolume', 'setBearingSize']) paintRange($(id));
}

function wireSettings() {
  $('setResumeOnLaunch').addEventListener('change', (e) => {
    state.boot.settings.resumeOnLaunch = e.target.checked;
    window.api.save({ resumeOnLaunch: e.target.checked });
    updateVideoMeta();
  });

  $('setPin').addEventListener('change', (e) => window.api.action('pin', e.target.checked));

  $('setPass').addEventListener('change', (e) => {
    window.api.action('pass', e.target.checked);
    if (e.target.checked) toast('鼠标穿透已开启，按 Alt+L 关闭');
  });

  $('setOpacity').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('opacityVal').textContent = v + '%';
    window.api.action('opacity', v / 100);
  });

  $('setVolume').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('volumeVal').textContent = v + '%';
    state.boot.settings.volume = v;
    window.api.save({ volume: v });
  });

  $('btnLogin').addEventListener('click', () => window.api.action('login'));
}

/**
 * 按钮文案只认主进程返回的真实状态，界面不自行推断。
 * 主进程是唯一真相源：关掉箭头开关、启动器重开都会改变放置状态。
 */
function renderPlaceButton(placing) {
  state.placing = !!placing;
  $('btnPlace').textContent = placing ? '锁定位置' : '② 拖到我的游戏小地图上';
  // 摆放中整颗按钮高亮，提醒「再点一次才算锁定」
  $('btnPlace').classList.toggle('active', !!placing);
}

async function syncPlaceButton() {
  try {
    renderPlaceButton(await window.api.overlayPlaceState());
  } catch (_) {
    // 老版主进程没有查询接口时保持默认文案，不影响其它设置
  }
}

function wireBearing() {
  $('setBearing').addEventListener('change', async (e) => {
    const on = e.target.checked;
    state.boot.settings.bearing = await window.api.overlayEnable(on);

    // 关掉箭头时主进程会强制退出放置模式，按钮得跟着复位
    if (!on) {
      await syncPlaceButton();
      return;
    }
    if (!state.boot.settings.bearing.calibrated) {
      toast('还没标定过，现在把浮窗叫起来框一次');
      window.api.action('calib');
    } else {
      toast('方位箭头已开启');
    }
    fillSettings(state.boot.settings);
    await syncPlaceButton();
  });

  $('setBearingSize').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('sizeVal').textContent = String(v);
    window.api.overlayRadius(v);
  });

  $('btnPickRoi').addEventListener('click', () => {
    window.api.action('calib');
    toast('在浮窗里拖金色圆环套住小地图，滚轮调大小');
  });

  // ③ 自动定心：用户主动点，跑一次、算准就停；结果由主进程写进这个视频的标定
  $('btnAutoCenter').addEventListener('click', () => {
    if (!state.boot.settings.bearing.enabled) {
      toast('先打开「显示方位箭头」', true);
      return;
    }
    window.api.action('autocenter');
    toast('开始自动定心：保持视频播放，角色走动 / 转身更容易成功（5~20 秒）', 6000);
  });

  $('btnPlace').addEventListener('click', async () => {
    if (!state.boot.settings.bearing.enabled) {
      toast('先打开「显示方位箭头」', true);
      return;
    }
    // 关键：不传参数，让主进程按当前状态切换。
    // 以前这里硬写 true，第二下点「锁定位置」只是又进了一次放置模式，
    // 红圈永远退出不了拖动状态，看起来就像「怎么点都锁不上」。
    const placing = await window.api.overlayPlace();
    renderPlaceButton(placing);
    toast(
      placing
        ? '把红圈拖到游戏里的小地图上，再点一次「锁定位置」'
        : '已锁定位置，红圈不会再被拖动；下次启动仍在这里'
    );
  });

  $('btnDumpRoi').addEventListener('click', () => {
    window.api.action('dump');
    toast('正在抓取识别区域…');
  });

  $('btnOpenDump').addEventListener('click', async () => {
    const dir = await window.api.revealDump();
    toast(`导出目录：${dir}`);
  });

  $('btnClearRoi').addEventListener('click', async () => {
    // 必须带上 videoId：主进程要靠它删掉 roiBy 里的专属记录，
    // 否则取区域时优先读 roiBy，清了等于没清，重载视频又回来。
    const videoId = state.video && state.video.id ? state.video.id : '';
    await window.api.save({ bearing: { rois: [], calibrated: false, videoId } });
    state.boot.settings.bearing.rois = [];
    state.boot.settings.bearing.calibrated = false;
    if (videoId && state.boot.settings.bearing.roiBy) {
      delete state.boot.settings.bearing.roiBy[videoId];
    }
    fillSettings(state.boot.settings);
    toast('已清除标定，点「① 框选」重新框一次');
  });
}

/* --------------------------------------------------------------- 热键 */

function wireHotkeys() {
  $('btnResetHk').addEventListener('click', async () => {
    const res = await window.api.resetHotkeys();
    state.boot.settings.hotkeys = res.hotkeys;
    state.boot.hookRunning = res.hookRunning;
    renderHotkeys();
    reportFailed(res.failed);
  });
}

function renderHotkeys() {
  const list = $('hkList');
  const hotkeys = state.boot.settings.hotkeys || {};
  list.textContent = '';

  for (const meta of state.boot.hotkeys) {
    const row = document.createElement('div');
    row.className = 'hk-row';

    const label = document.createElement('span');
    label.textContent = meta.label;

    const kbd = document.createElement('button');
    kbd.className = 'kbd';
    paintKeys(kbd, hotkeys[meta.key]);
    kbd.addEventListener('click', () => captureHotkey(kbd, meta.key));

    row.append(label, kbd);
    list.appendChild(row);
  }

  renderHookState();
}

/**
 * 把加速器画成一组键帽：Alt+Space → [Alt] + [空格]。
 * 一整串「Alt+空格」塞在一个按钮里，扫一眼分不清是几个键；拆开后和键盘上的样子对得上。
 * 鼠标侧键是一个整体，不按 + 拆。
 */
function paintKeys(kbd, acc) {
  kbd.textContent = '';
  kbd.title = '点击后按下新的键位';
  if (!acc) {
    kbd.textContent = '未设置';
    return;
  }
  const parts = /^Mouse[45]$/i.test(acc) ? [acc] : String(acc).split('+');
  parts.forEach((part, i) => {
    if (i) {
      const plus = document.createElement('span');
      plus.className = 'plus';
      plus.textContent = '+';
      kbd.appendChild(plus);
    }
    const key = document.createElement('span');
    key.className = 'key';
    key.textContent = prettify(part);
    kbd.appendChild(key);
  });
}

/**
 * 单键 / 侧键靠系统钩子，钩子没起来时这两类热键是彻底不响的。
 * 与其让用户猜「是不是坏了」，不如直接把状态摆在键盘位下面。
 */
function renderHookState() {
  const el = $('hkState');
  if (!el) return;
  // 提权提示与「有没有单键绑定」无关：Alt 组合键走 RegisterHotKey，
  // 在提权窗口（原神）前台时同样收不到（UIPI），所以永远要在首屏提示
  renderElevateState();

  const hotkeys = state.boot.settings.hotkeys || {};
  const hookKeys = Object.entries(hotkeys).filter(([, acc]) => acc && !String(acc).includes('+'));
  const running = !!state.boot.hookRunning;

  if (!hookKeys.length) {
    el.className = 'hk-state';
    el.textContent = '当前没有单键 / 侧键绑定，全部走系统独占组合键';
    return;
  }
  el.className = 'hk-state ' + (running ? 'ok' : 'bad');
  el.textContent = running
    ? `单键与侧键监听已启动（${hookKeys.length} 个键位）${
        state.boot.elevated ? '，在游戏里也能触发' : '，但游戏内需管理员身份（见上）'
      }`
    : '单键与侧键监听未启动，这些键位目前不会响应（可能被杀毒软件拦截）';
}

/**
 * 没提权时，游戏里的热键必然不响 —— 这是 Windows 的 UIPI 规则，不是程序坏了：
 * 原神这类游戏以管理员启动，非提权进程的低级钩子收不到「提权窗口在前台」时的按键。
 * 与其让用户反复试，不如把原因和办法直接写在键盘位下面。
 */
function renderElevateState() {
  const el = $('elevBanner');
  if (!el) return;
  if (state.boot.elevated) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const text = $('elevBannerText');
  if (text) {
    text.textContent =
      '未以管理员身份运行：原神等以管理员权限启动的程序在前台时，全局快捷键（含单键与组合键）收不到，这是 Windows 的 UIPI 限制。点右侧按钮重启即可，当前配置不会丢。';
  }

  const btn = $('btnElevate');
  if (btn && !btn.dataset.bound) {
    btn.dataset.bound = '1';
    btn.addEventListener('click', async () => {
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = '正在请求权限…';
      // 成功时主进程会退出本实例，UAC 确认后以管理员身份重新拉起；
      // 失败基本只有一种原因：用户在 UAC 弹窗上点了「否」
      const r = await window.api.relaunchElevated();
      if (!r || !r.ok) {
        btn.disabled = false;
        btn.textContent = r && r.reason === 'uac-cancelled' ? '已取消，重试' : label;
      }
    });
  }
}

/** 当前正在录制的那一个键位，点别的键位时先取消它，避免监听器叠加 */
let activeCapture = null;

function captureHotkey(kbd, key) {
  if (activeCapture) activeCapture();

  // 录制期间把全局单键热键挡掉，否则按 J 会先暂停视频再被录进去，顺序全靠运气
  window.api.capturing(true);

  kbd.classList.add('capturing');
  kbd.textContent = '按键位或鼠标侧键…';

  const cleanup = () => {
    window.api.capturing(false);
    kbd.classList.remove('capturing');
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onMouse, true);
    if (activeCapture === cleanup) activeCapture = null;
  };

  const commit = async (acc) => {
    cleanup();
    const res = await window.api.updateHotkeys({ [key]: acc });
    state.boot.settings.hotkeys = res.hotkeys;
    state.boot.hookRunning = res.hookRunning;
    renderHotkeys();

    // 注册被系统否决时主进程已经把旧键位还原了，这里要说清楚，别让用户以为改成了
    if (res.rejected && res.rejected.includes(key)) {
      toast(`${prettify(acc)} 被系统或其他程序占用，已保留原来的键位`, true);
      return;
    }
    // 撞到别的动作时主进程做了互换，得提示一句，否则用户会发现自己另一个热键变了却不知道为什么
    if (res.swapped && res.swapped.length && !(res.failed || []).length) {
      toast(`已设置为 ${prettify(acc)}，原来占用它的动作已和它互换`);
      return;
    }
    reportFailed(res.failed, key);
  };

  const onKey = async (e) => {
    // 只按住 Ctrl/Alt/Shift/Win 时不算一次录入，继续等真正的按键
    if (/^(Control|Shift|Alt|Meta)(Left|Right)?$/.test(e.code || '')) return;

    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') {
      cleanup();
      renderHotkeys();
      return;
    }

    const acc = toAccelerator(e);
    if (!acc) {
      kbd.textContent = '这个键不支持，换一个';
      return;
    }
    await commit(acc);
  };

  // 鼠标侧键：DOM 里 button 3 = 后退侧键、4 = 前进侧键
  const onMouse = async (e) => {
    if (e.button !== 3 && e.button !== 4) return;
    e.preventDefault();
    e.stopPropagation();
    await commit(`Mouse${e.button + 1}`);
  };

  activeCapture = cleanup;
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onMouse, true);
}

function reportFailed(failed, focusKey) {
  if (!failed || !failed.length) return;
  const hit = focusKey ? failed.find((f) => f.key === focusKey) : failed[0];
  if (!hit) return;
  if (hit.unsupported) {
    toast(`${prettify(hit.accelerator)} 这个键钩子认不出来，换成字母、数字、F 键或方向键试试`, true);
    return;
  }
  if (hit.hook) {
    toast('单键和鼠标侧键靠系统钩子实现，当前钩子启动失败（常见于杀毒软件拦截），可先用带 Alt/Ctrl 的组合', true);
    return;
  }
  toast(`${prettify(hit.accelerator)} 被系统或其他程序占用，请换一个`, true);
}

function toAccelerator(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');

  const k = keyName(e);
  if (!k) return '';
  // 单键（不带修饰键）现在也允许：它们走低级钩子被动监听，不会把键从别的程序里抢走
  return [...mods, k].join('+');
}

function keyName(e) {
  const code = e.code || '';
  let m;
  if ((m = code.match(/^Key([A-Z])$/))) return m[1];
  if ((m = code.match(/^Digit(\d)$/))) return m[1];
  if ((m = code.match(/^F(\d{1,2})$/))) return 'F' + m[1];

  const map = {
    Space: 'Space',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    Escape: 'Esc',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Semicolon: ';',
    Comma: ',',
    Period: '.',
    Slash: '/'
  };
  if (map[code]) return map[code];
  if (e.key && e.key.length === 1) return e.key.toUpperCase();
  return '';
}

function prettify(acc) {
  if (!acc) return '未设置';
  if (/^Mouse4$/i.test(acc)) return '鼠标侧键 ◀';
  if (/^Mouse5$/i.test(acc)) return '鼠标侧键 ▶';
  return String(acc)
    .replace(/\bSuper\b/g, 'Win')
    .replace(/\bLeft\b/g, '←')
    .replace(/\bRight\b/g, '→')
    .replace(/\bUp\b/g, '↑')
    .replace(/\bDown\b/g, '↓')
    .replace(/\bSpace\b/g, '空格');
}

/* ---------------------------------------------------------------- 账号 */

function applyNav(nav) {
  const el = $('accountLine');
  // 前面的小圆点：登录后变绿（样式在 console.css 的 .account.on）
  el.classList.toggle('on', !!(nav && nav.loggedIn));
  if (!nav) {
    el.textContent = '登录状态未知';
    return;
  }
  if (nav.loggedIn) {
    el.innerHTML = `已登录 <b>${escapeHtml(nav.uname || '')}</b>${nav.vip ? '（大会员）' : ''}`;
  } else {
    el.textContent = '未登录 · 只能看预览和标清';
  }
}

/* ---------------------------------------------------------------- 杂项 */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(text, bad) {
  const el = $('toast');
  el.textContent = text;
  el.classList.toggle('bad', !!bad);
  el.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => el.classList.remove('show'), 4200);
}

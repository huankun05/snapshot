/*
 * eIsland - A sleek, Apple Dynamic Island inspired floating widget for Windows, built with Electron.
 * https://github.com/JNTMTMTM/eIsland
 *
 * Copyright (C) 2026 JNTMTMTM
 * Copyright (C) 2026 pyisland.com
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 */

/**
 * 贴图浮窗交互：整窗拖动 / 滚轮缩放（可不成比例）/ 悬停工具条 / 仅销毁按钮关闭。
 * 窗口本身无边框透明，图片铺满；鼠标按住拖 → 走主进程 pin-move 位移（跨 DPI 显示器不跳尺寸）。
 * 左键 / 右键均不关闭贴图（右键仅屏蔽原生菜单），只有顶部 × 销毁按钮（或 Esc）可关闭。
 */

const { ipcRenderer } = require('electron');

const img = document.getElementById('pinImage');
const btnCopy = document.getElementById('btnPinCopy');
const btnSave = document.getElementById('btnPinSave');
const btnClose = document.getElementById('btnPinClose');
const hint = document.getElementById('pinHint');
const sizeLabel = document.getElementById('pinSize');

/** 初始显示尺寸（缩放 1.0 时），由主进程按屏幕 1:1 DIP 算出 */
let baseW = 0;
let baseH = 0;
let pendingDataURL = '';
/** 独立横/纵缩放系数：默认相等（等比），Shift/Alt 可拉成任意比例 */
let zoomX = 1;
let zoomY = 1;

/* ── 贴图增强三件（2026-11-25 竞品调研 N4）：缩略图 / 旋转镜像 / 鼠标穿透 ── */
/** 缩略图态与进入前的缩放（Shift+双击切换，还原回原比例而不是回 1.0） */
let thumbMode = false;
let savedZoom = null;
const THUMB_LONG = 160;
/** 旋转角（0/90/180/270）与镜像；90/270 时窗口宽高互换 */
let rotation = 0;
let flipH = false;
let flipV = false;
/** 鼠标穿透：窗口不再吃鼠标事件，靠全局 Ctrl+Shift+T 恢复 */
let through = false;

/** 单轴最小显示尺寸（CSS px）：允许贴图缩得很小，但轴不会低于它 */
const MIN_AXIS = 48;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;

function clampZoom(z) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/** 等比保下限：短边不足 MIN_AXIS 时整体等比放大（不破坏宽高比） */
function fitMinAxis(w, h) {
  let width = Math.max(1, Math.round(w));
  let height = Math.max(1, Math.round(h));
  if (width < MIN_AXIS || height < MIN_AXIS) {
    const k = MIN_AXIS / Math.min(width, height);
    width = Math.max(MIN_AXIS, Math.round(width * k));
    height = Math.max(MIN_AXIS, Math.round(height * k));
  }
  return { width, height };
}

/** 由当前 zoom 计算窗口应发的宽高（等比统一缩放时保持比例）。
 *  旋转 90/270 时视觉宽高互换 —— zoomX/zoomY 始终表示「显示宽/高」的系数，
 *  这样旋转后仍保持用户已拉伸的比例意图。 */
function computeDims() {
  const swap = rotation === 90 || rotation === 270;
  return fitMinAxis((swap ? baseH : baseW) * zoomX, (swap ? baseW : baseH) * zoomY);
}

/** 更新左上角尺寸标签（当前窗口显示尺寸） */
function updateSizeLabel() {
  if (!sizeLabel) return;
  const dims = computeDims();
  sizeLabel.textContent = `${dims.width} × ${dims.height}`;
}

function sendResize() {
  const dims = computeDims();
  ipcRenderer.send('pin-resize', { width: dims.width, height: dims.height });
  applyTransform();
}

/* ── 拖动：pointer capture + 主进程「光标锚点」位移（每帧只发一次，避免高频 IPC） ──
   渲染端 e.screenX/screenY 是 Chromium 的 CSS px（按窗口所在屏的缩放率换算），
   主进程 getBounds/setPosition 是 Electron DIP 系（主屏 125% / 副屏 150%），两者并不同源。
   把 CSS px 增量累加后交给 setPosition，混合 DPI 下会按缩放率成比例失配 ——
   实测「一拖就跑到另一块屏幕、而且拽不回来」。
   改为只上报「拖动开始 / 移动一帧 / 拖动结束」，位移量由主进程用自己的
   screen.getCursorScreenPoint()（与 getBounds 同一坐标系）减去起点光标算得，
   跨屏与混合 DPI 天然正确。 */
let dragging = false;
let dragRafPending = false;

/** 拖动结束后的一小段“静默窗”：期间忽略滚轮，防止触控板惯性滚动 / 误触把刚放好的贴图又缩放 */
let dragEndedAt = 0;

function flushDragMove() {
  dragRafPending = false;
  if (!dragging) return;
  // 携带期望图尺寸：主进程发现窗口尺寸被意外改大/改小（系统/事件误触）会自动回正，
  // 杜绝“拖拽中尺寸变化”。
  const dims = computeDims();
  ipcRenderer.send('pin-drag-move', { expectW: dims.width, expectH: dims.height });
}

function endDrag(e) {
  if (!dragging) return;
  dragging = false;
  dragRafPending = false;
  ipcRenderer.send('pin-drag-end');
  dragEndedAt = Date.now();
  document.body.classList.remove('is-dragging');
  if (e && e.pointerId != null) {
    try { document.body.releasePointerCapture(e.pointerId); } catch (_) { /* 忽略 */ }
  }
}

document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (e.target.closest('.pin-bar')) return; // 工具条按钮不触发拖动
  dragging = true;
  dragRafPending = false;
  document.body.classList.add('is-dragging');
  try {
    document.body.setPointerCapture(e.pointerId);
  } catch (_) { /* 宽容：不支持捕获时退化为窗口内拖动 */ }
  // 起点交给主进程记录（同一坐标系下的光标 + 窗口位置）
  const dims = computeDims();
  ipcRenderer.send('pin-drag-start', { expectW: dims.width, expectH: dims.height });
});

document.addEventListener('pointermove', () => {
  if (!dragging || dragRafPending) return;
  // mousemove 125~500Hz，逐事件 IPC 会把主进程拖垮 → 每帧只发一次
  dragRafPending = true;
  requestAnimationFrame(flushDragMove);
});

document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', endDrag);

/* 左键单击不再关闭贴图（点击只用于拖动 / 命中工具条） */

/* 右键 = 屏蔽原生菜单，但绝不关闭贴图 */
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
});

/* Esc = 关闭；R/Shift+R 旋转、H/V 镜像、Ctrl+T 穿透（2026-11-25） */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { window.close(); return; }
  if (e.ctrlKey && (e.key === 't' || e.key === 'T')) {
    e.preventDefault();
    setThrough(!through);
    return;
  }
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const k = (e.key || '').toLowerCase();
  if (k === 'r') rotateBy(e.shiftKey ? -90 : 90);
  else if (k === 'h') { flipH = !flipH; applyTransform(); flashHint(flipH ? '水平镜像' : '取消水平镜像'); }
  else if (k === 'v') { flipV = !flipV; applyTransform(); flashHint(flipV ? '垂直镜像' : '取消垂直镜像'); }
});

/* Shift+双击 = 缩略图 / 还原（Snipaste 同款手势） */
document.addEventListener('dblclick', (e) => {
  if (!e.shiftKey || !baseW || !baseH) return;
  if (e.target.closest('.pin-bar')) return;
  toggleThumb();
});

/* 滚轮缩放：默认横纵同比例；Shift+滚轮=仅宽；Alt+滚轮=仅高（可拉成任意比例）；
   Ctrl+滚轮=调贴图透明度（2026-11-20 借鉴青蛙截图，窗口本就透明，直接作用在图片上）。
   拖动进行中忽略滚轮，避免拖拽同时误触缩放导致“移动时尺寸变化”；
   拖动刚结束的 250ms 内同样忽略（触控板惯性 / 松手误触）。 */
const PIN_OPACITY_KEY = 'petalsnap.pinOpacity';
const PIN_OPACITY_MIN = 0.15;
let pinOpacity = 1;

function applyPinOpacity(v, persist) {
  pinOpacity = Math.min(1, Math.max(PIN_OPACITY_MIN, v));
  if (img) img.style.opacity = String(pinOpacity);
  try {
    if (persist) localStorage.setItem(PIN_OPACITY_KEY, String(pinOpacity));
  } catch (_) { /* 存储不可用（如禁写环境）时只在本次会话内生效 */ }
}

document.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (dragging || !baseW || !baseH) return;
  if (Date.now() - dragEndedAt < 250) return;
  if (e.ctrlKey) {
    // 透明度：上滚更实、下滚更透；工具条/标签不受影响（只调图片本体）
    const step = e.deltaY < 0 ? 0.06 : -0.06;
    applyPinOpacity(pinOpacity + step, true);
    flashHint(`透明度 ${Math.round(pinOpacity * 100)}%`);
    return;
  }
  const factor = e.deltaY < 0 ? 1.12 : 0.89;
  if (e.shiftKey) {
    // 仅宽：只有这一轴动，短轴下限由 fitMinAxis 兜底（单轴极端小才允许轻微变形）
    zoomX = clampZoom(zoomX * factor);
  } else if (e.altKey) {
    zoomY = clampZoom(zoomY * factor);
  } else {
    // 等比（保留当前宽高比，含已拉伸状态）：两轴同乘，短轴到 MIN_AXIS 后整体停住
    zoomX = clampZoom(zoomX * factor);
    zoomY = clampZoom(zoomY * factor);
  }
  updateSizeLabel();
  sendResize();
}, { passive: false });

ipcRenderer.on('pin-image', (_e, data) => {
  const dataURL = typeof data?.dataURL === 'string' ? data.dataURL : '';
  if (!dataURL) return;
  pendingDataURL = dataURL;
  baseW = Number(data.displayWidth) || 0;
  baseH = Number(data.displayHeight) || 0;
  zoomX = 1;
  zoomY = 1;
  rotation = 0;
  flipH = false;
  flipV = false;
  thumbMode = false;
  savedZoom = null;
  applyTransform();
  img.src = dataURL;
  // 恢复上次的贴图透明度（Ctrl+滚轮可调；存储不可用时保持 1）
  try {
    const saved = Number(localStorage.getItem(PIN_OPACITY_KEY));
    if (Number.isFinite(saved) && saved > 0) applyPinOpacity(saved, false);
    else applyPinOpacity(1, false);
  } catch (_) { /* 忽略 */ }
  updateSizeLabel();
});

btnCopy.addEventListener('click', () => {
  if (!pendingDataURL) return;
  ipcRenderer.send('pin-copy', { dataURL: pendingDataURL });
  flashHint('已复制到剪贴板');
});

btnSave.addEventListener('click', () => {
  if (!pendingDataURL) return;
  ipcRenderer.send('pin-save', { dataURL: pendingDataURL });
});

btnClose.addEventListener('click', () => {
  window.close();
});

/** 工具条按钮点击后的短暂反馈（复用引导条位置） */
function flashHint(message) {
  if (!hint) return;
  hint.textContent = message;
  hint.style.animation = 'none';
  // 强制重排后重新播放短反馈动画
  void hint.offsetWidth;
  hint.style.animation = 'pin-hint-flash 1.8s ease forwards';
}

/* ── 变换 / 缩略图 / 穿透（2026-11-25）───────────────────────────────── */

/** 把旋转/镜像落到图片本体：窗口尺寸已按视觉包围盒调好，这里只摆图片。
 *  无变换时完全恢复原样式（width/height:100%），保证既有行为零改动。 */
function applyTransform() {
  if (!img) return;
  if (!rotation && !flipH && !flipV) {
    img.classList.remove('is-transformed');
    img.style.width = '';
    img.style.height = '';
    img.style.transform = '';
    return;
  }
  const dims = computeDims();
  const swap = rotation === 90 || rotation === 270;
  const w0 = swap ? dims.height : dims.width;  // 元素未旋转时的尺寸
  const h0 = swap ? dims.width : dims.height;
  img.classList.add('is-transformed');
  img.style.width = `${w0}px`;
  img.style.height = `${h0}px`;
  // left/top:50% 落在 padding box 中心；四周留白相等 ⇒ 也是 content 中心，
  // 再按元素自身尺寸平移一半即精确居中（无需知道留白具体像素值）
  img.style.transform = `translate(-50%, -50%) rotate(${rotation}deg) scaleX(${flipH ? -1 : 1}) scaleY(${flipV ? -1 : 1})`;
}

function rotateBy(deg) {
  if (!baseW || !baseH) return;
  rotation = (((rotation + deg) % 360) + 360) % 360;
  updateSizeLabel();
  sendResize(); // 90/270 时窗口宽高互换，内部同步 applyTransform
  flashHint(rotation ? `旋转 ${rotation}°` : '已回正');
}

/** 缩略图：长边压到 THUMB_LONG，再 Shift+双击还原到进入前的比例 */
function toggleThumb() {
  const dims = computeDims();
  if (!thumbMode) {
    savedZoom = { x: zoomX, y: zoomY };
    const k = Math.min(1, THUMB_LONG / Math.max(dims.width, dims.height));
    zoomX = clampZoom(zoomX * k);
    zoomY = clampZoom(zoomY * k);
    thumbMode = true;
    flashHint('缩略图 · Shift+双击还原');
  } else {
    if (savedZoom) { zoomX = savedZoom.x; zoomY = savedZoom.y; }
    thumbMode = false;
    savedZoom = null;
    flashHint('已还原尺寸');
  }
  updateSizeLabel();
  sendResize();
}

/** 鼠标穿透：穿透后本窗收不到鼠标，只能靠宿主的全局 Ctrl+Shift+T 唤回 */
function setThrough(on) {
  through = on === true;
  document.body.classList.toggle('is-through', through);
  ipcRenderer.send('pin-set-through', { on: through });
  flashHint(through ? '已穿透 · Ctrl+Shift+T 恢复' : '已恢复交互');
}

// 全局热键恢复时由宿主回告，渲染端同步视觉状态
ipcRenderer.on('pin-through-changed', (_e, on) => {
  through = on === true;
  document.body.classList.toggle('is-through', through);
});

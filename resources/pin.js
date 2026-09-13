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

/** 由当前 zoom 计算窗口应发的宽高（等比统一缩放时保持比例） */
function computeDims() {
  return fitMinAxis(baseW * zoomX, baseH * zoomY);
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
}

/* ── 拖动：pointer capture + 主进程位移（RAF 合并，避免跨显示器跳尺寸/跳位置） ── */
let dragging = false;
let lastScreenX = 0;
let lastScreenY = 0;
let dragAccumX = 0;
let dragAccumY = 0;
let dragRafPending = false;

function flushDragMove() {
  dragRafPending = false;
  if (dragging && (dragAccumX !== 0 || dragAccumY !== 0)) {
    // 携带期望图尺寸：主进程发现窗口尺寸被意外改大/改小（系统/事件误触）会自动回正，
    // 杜绝“拖拽中尺寸变化”。
    const dims = computeDims();
    ipcRenderer.send('pin-move', { dx: dragAccumX, dy: dragAccumY, expectW: dims.width, expectH: dims.height });
    dragAccumX = 0;
    dragAccumY = 0;
  }
}

/** 拖动结束后的一小段“静默窗”：期间忽略滚轮，防止触控板惯性滚动 / 误触把刚放好的贴图又缩放 */
let dragEndedAt = 0;

function endDrag(e) {
  if (!dragging) return;
  dragging = false;
  // 收尾：把残余位移发完
  if (dragAccumX !== 0 || dragAccumY !== 0) {
    const dims = computeDims();
    ipcRenderer.send('pin-move', { dx: dragAccumX, dy: dragAccumY, expectW: dims.width, expectH: dims.height });
    dragAccumX = 0;
    dragAccumY = 0;
  }
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
  lastScreenX = e.screenX;
  lastScreenY = e.screenY;
  dragAccumX = 0;
  dragAccumY = 0;
  document.body.classList.add('is-dragging');
  try {
    document.body.setPointerCapture(e.pointerId);
  } catch (_) { /* 宽容：不支持捕获时退化为窗口内拖动 */ }
});

document.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  // 增量累计，下一帧统一发送：mousemove 125~500Hz，逐事件 IPC 会把主进程拖垮
  dragAccumX += e.screenX - lastScreenX;
  dragAccumY += e.screenY - lastScreenY;
  lastScreenX = e.screenX;
  lastScreenY = e.screenY;
  if (!dragRafPending) {
    dragRafPending = true;
    requestAnimationFrame(flushDragMove);
  }
});

function endDrag(e) {
  if (!dragging) return;
  dragging = false;
  // 收尾：把残余位移发完（携带期望尺寸，主进程一并校验回正）
  if (dragAccumX !== 0 || dragAccumY !== 0) {
    const dims = computeDims();
    ipcRenderer.send('pin-move', { dx: dragAccumX, dy: dragAccumY, expectW: dims.width, expectH: dims.height });
    dragAccumX = 0;
    dragAccumY = 0;
  }
  dragEndedAt = Date.now();
  document.body.classList.remove('is-dragging');
  if (e && e.pointerId != null) {
    try { document.body.releasePointerCapture(e.pointerId); } catch (_) { /* 忽略 */ }
  }
}

document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', endDrag);

/* 左键单击不再关闭贴图（点击只用于拖动 / 命中工具条） */

/* 右键 = 屏蔽原生菜单，但绝不关闭贴图 */
document.addEventListener('contextmenu', (e) => {
  e.preventDefault();
});

/* Esc = 关闭（键盘快捷，非鼠标点击） */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.close();
});

/* 滚轮缩放：默认横纵同比例；Shift+滚轮=仅宽；Alt+滚轮=仅高（可拉成任意比例）。
   拖动进行中忽略滚轮，避免拖拽同时误触缩放导致“移动时尺寸变化”；
   拖动刚结束的 250ms 内同样忽略（触控板惯性 / 松手误触）。 */
document.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (dragging || !baseW || !baseH) return;
  if (Date.now() - dragEndedAt < 250) return;
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
  img.src = dataURL;
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

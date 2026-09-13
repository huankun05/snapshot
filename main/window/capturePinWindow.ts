/*
 * eIsland - A sleek, Apple Dynamic Island inspired floating widget for Windows, built with Electron.
 * https://github.com/JNTMTMTM/eIsland
 *
 * Copyright (C) 2026 JNTMTMTM
 * Copyright (C) 2026 pyisland.com
 *
 * Original author: JNTMTMTM[](https://github.com/JNTMTMTM)
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
 * @file capturePinWindow.ts
 * @description 截图「贴图到桌面」浮窗服务（Snipaste 式 pin）。
 * 截图编辑器点「贴图」→ 主进程新建一个无边框置顶小窗，图片常驻桌面可拖动；
 * 支持：按住拖动、滚轮缩放、顶部悬停工具条（复制/保存/关闭）、右键/双击/Esc 关闭。
 * 截图开始时自动隐藏全部贴图（避免挡住选区层），截图窗关闭后恢复显示。
 */

import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, screen } from 'electron';
import { join } from 'path';
import { existsSync, writeFileSync } from 'fs';
import { is } from '@electron-toolkit/utils';

/** 贴图最大占所在工作区的比例（等比缩小的上限，不放大） */
const MAX_PIN_DISPLAY_RATIO = 0.6;
/** 连续贴多张时的层叠偏移（px） */
const PIN_STACK_OFFSET = 26;
/** 单轴最小显示尺寸（CSS px）。这是“轴下限”而非窗口下限：
 *  贴图通常宽 > 高，若把两个轴都钳到 120px，宽扁图的高度会永远卡在 120 无法再缩小
 *  （比例被拉坏），且细长贴图一出现就被拉成 120 高。降到 48 并尽量保比例。 */
const MIN_PIN_AXIS = 48;
/** 窗口四周留白（CSS px）：常驻柔和投影 + 悬停发光画在留白内（透明窗会裁掉超出窗口的阴影）。
 *  渲染端 #pinImage 铺满 content（= 窗口 − 2×PIN_EDGE），即图片 1:1 尺寸。
 *  20px：CSS 投影（0 8px 24px）向下扩散约 32px，留白太小会把投影尾巴裁出生硬直线。 */
const PIN_EDGE = 20;

/** 图尺寸 → 窗口尺寸（含留白） */
function withPinEdge(w: number, h: number): { width: number; height: number } {
  return { width: w + PIN_EDGE * 2, height: h + PIN_EDGE * 2 };
}

const pinWindows: BrowserWindow[] = [];

/**
 * 等比缩到最小尺寸以上：先算纯等比 w/h，若短边低于 MIN_PIN_AXIS 再整体放大，
 * 保证短边 ≥ 下限的同时不破坏宽高比（不逐轴硬钳，避免把图拉变形）。
 */
function fitMinAxis(w: number, h: number): { width: number; height: number } {
  let width = Math.max(1, Math.round(w));
  let height = Math.max(1, Math.round(h));
  if (width < MIN_PIN_AXIS || height < MIN_PIN_AXIS) {
    const k = MIN_PIN_AXIS / Math.min(width, height);
    width = Math.max(MIN_PIN_AXIS, Math.round(width * k));
    height = Math.max(MIN_PIN_AXIS, Math.round(height * k));
  }
  return { width, height };
}

function getPinHtmlPath(): string {
  if (is.dev) {
    const candidates = [
      join(process.cwd(), 'resources', 'pin.html'),
      join(app.getAppPath(), 'resources', 'pin.html'),
      join(__dirname, '../../../resources/pin.html'),
    ];
    return candidates.find((c) => existsSync(c)) ?? candidates[0];
  }
  return join(process.resourcesPath, 'pin.html');
}

/** 从 dataURL 解析图片物理尺寸；无效返回 null */
function resolveImageSize(dataURL: string): { width: number; height: number } | null {
  try {
    const img = nativeImage.createFromDataURL(dataURL);
    const size = img.getSize();
    if (img.isEmpty() || size.width <= 0 || size.height <= 0) return null;
    return { width: size.width, height: size.height };
  } catch {
    return null;
  }
}

/**
 * 新建一张桌面贴图
 * @returns 是否成功创建
 */
export function createPinWindow(dataURL: string): boolean {
  const size = resolveImageSize(dataURL);
  if (!size) return false;

  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const workArea = display.workArea;
  // nativeImage 尺寸是物理像素；窗口尺寸用 CSS(DIP) px。除以该屏 scaleFactor 得到 1:1 的
  // 桌面显示尺寸——否则 125%/150% 缩放下贴图会比原选区大 25%/50%（“缩放不是原比例”的来源）。
  const sf = display.scaleFactor || 1;
  const imgCssW = size.width / sf;
  const imgCssH = size.height / sf;

  // 等比适配：超出工作区 60% 时缩小（只缩小不放大）；整体短边保 MIN_PIN_AXIS
  const maxW = Math.round(workArea.width * MAX_PIN_DISPLAY_RATIO);
  const maxH = Math.round(workArea.height * MAX_PIN_DISPLAY_RATIO);
  const scale = Math.min(1, maxW / imgCssW, maxH / imgCssH);
  const fitted = fitMinAxis(imgCssW * scale, imgCssH * scale);
  // 窗口尺寸 = 图尺寸 + 四周留白（发光/投影区）；position 居中按窗口算
  const winSize = withPinEdge(fitted.width, fitted.height);
  const width = winSize.width;
  const height = winSize.height;

  const stackOffset = (pinWindows.length % 10) * PIN_STACK_OFFSET;
  const rawX = Math.round(workArea.x + (workArea.width - width) / 2 + stackOffset);
  const rawY = Math.round(workArea.y + (workArea.height - height) / 2 + stackOffset);
  const x = Math.max(workArea.x, Math.min(rawX, workArea.x + workArea.width - width));
  const y = Math.max(workArea.y, Math.min(rawY, workArea.y + workArea.height - height));

  const win = new BrowserWindow({
    width,
    height,
    x,
    y,
    show: false,
    frame: false,
    // 同截图窗：关 WS_THICKFRAME，避免贴图窗出现时也有系统扩张动画
    thickFrame: false,
    transparent: true,
    resizable: false,
    movable: false,
    // 系统阴影绕「透明窗的方形矩形」画，视觉上是生硬的暗色边框 → 关掉，投影全由
    // 渲染端 CSS 画（跟随图片圆角，柔和环境光效果，见 pin.css #pinImage）。
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');

  pinWindows.push(win);
  win.on('closed', () => {
    const index = pinWindows.indexOf(win);
    if (index >= 0) pinWindows.splice(index, 1);
  });

  win.webContents.once('did-finish-load', () => {
    if (win.isDestroyed()) return;
    // displayWidth/Height = 图片 1:1 尺寸（窗口 = 图 + 2×留白，渲染端 img 铺满 content）
    win.webContents.send('pin-image', { dataURL, displayWidth: fitted.width, displayHeight: fitted.height });
    win.showInactive();
  });

  void win.loadFile(getPinHtmlPath());
  return true;
}

/** 截图开始前隐藏全部贴图，避免挡住全屏选区层 */
export function hideAllPinWindows(): void {
  pinWindows.forEach((win) => {
    if (!win.isDestroyed() && win.isVisible()) win.hide();
  });
}

/** 截图流程结束后恢复全部贴图 */
export function restoreAllPinWindows(): void {
  pinWindows.forEach((win) => {
    if (!win.isDestroyed() && !win.isVisible()) win.showInactive();
  });
}

/** 全部关闭（应用退出前的兜底） */
export function closeAllPinWindows(): void {
  pinWindows.forEach((win) => {
    if (!win.isDestroyed()) win.close();
  });
}

function registerPinIpcHandlers(): void {
  // 截图编辑器「贴图」按钮 → 新建贴图窗
  ipcMain.handle('capture-pin', (_event, payload: { dataURL?: string }) => {
    const dataURL = typeof payload?.dataURL === 'string' ? payload.dataURL : '';
    try {
      return createPinWindow(dataURL);
    } catch (err) {
      console.error('[Pin] create pin window error:', err);
      return false;
    }
  });

  // 贴图窗「复制」→ 图片进剪贴板
  ipcMain.on('pin-copy', (_event, payload: { dataURL?: string }) => {
    const dataURL = typeof payload?.dataURL === 'string' ? payload.dataURL : '';
    try {
      clipboard.writeImage(nativeImage.createFromDataURL(dataURL));
    } catch (err) {
      console.error('[Pin] copy error:', err);
    }
  });

  // 贴图窗「保存」→ 系统另存为对话框（挂父窗：置顶于贴图窗之上且模态，避免落在 screen-saver 层下面）
  ipcMain.on('pin-save', async (event, payload: { dataURL?: string }) => {
    const dataURL = typeof payload?.dataURL === 'string' ? payload.dataURL : '';
    try {
      const pngBuffer = nativeImage.createFromDataURL(dataURL).toPNG();
      if (!pngBuffer || pngBuffer.length === 0) return;
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const dialogOptions = {
        title: '保存贴图',
        defaultPath: join(app.getPath('pictures'), `eIsland_pin_${timestamp}.png`),
        filters: [{ name: 'PNG', extensions: ['png'] }],
      };
      const pinWindow = BrowserWindow.fromWebContents(event.sender);
      const result = pinWindow && !pinWindow.isDestroyed()
        ? await dialog.showSaveDialog(pinWindow, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions);
      if (!result.canceled && result.filePath) {
        writeFileSync(result.filePath, pngBuffer);
      }
    } catch (err) {
      console.error('[Pin] save error:', err);
    }
  });

  // 贴图窗滚轮缩放 → 调整窗口尺寸（左上角锚定）。
  // 用 setBounds 同时改宽高并保证贴图不越出工作区（贴近屏边放大时自动回推 y/x），
  // 避免 setContentSize 在部分环境只生效宽度、以及贴图被推到屏幕外看不见。
  // 请求尺寸 = 图尺寸（渲染端已按等比钳好），窗口 = 图 + 2×留白；
  // 单轴下限只做“最小保护”（MIN_PIN_AXIS），绝不把请求尺寸反向放大——
  // 渲染端已在等比逻辑里钳好，主进程再放大只会让两个状态失步、出现“拖拽/缩放跳变”。
  ipcMain.on('pin-resize', (event, payload: { width?: number; height?: number }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const width = Math.max(MIN_PIN_AXIS, Math.round(Number(payload?.width) || 0));
    const height = Math.max(MIN_PIN_AXIS, Math.round(Number(payload?.height) || 0));

    const current = win.getBounds();
    const display = screen.getDisplayMatching(current);
    const wa = display.workArea;
    // 超过工作区（扣除留白）的维度压回工作区，另一维保持
    const targetW = Math.min(width, wa.width - PIN_EDGE * 2);
    const targetH = Math.min(height, wa.height - PIN_EDGE * 2);
    const winSize = withPinEdge(targetW, targetH);
    // 左上角锚定，仅在贴图会越出工作区右侧/底部时整体回推，保证始终可见
    const x = Math.max(wa.x, Math.min(current.x, wa.x + wa.width - winSize.width));
    const y = Math.max(wa.y, Math.min(current.y, wa.y + wa.height - winSize.height));
    win.setBounds({ x, y, width: winSize.width, height: winSize.height });
  });

  // 贴图窗拖动：主进程按屏幕 DIP 位移整体 move，越界收进任一工作区。
  // 渲染端拖动时把事件交给主进程处理（setPosition），避免跨 DPI 显示器时
  // window.moveTo 的坐标换算导致窗口“跳尺寸/跳位置”。
  // 附带“期望尺寸校正”：拖动全程渲染端几何应恒定（移动不改尺寸）；万一有其他路径
  // （系统/事件误触等）把窗口尺寸改大，下一次 move 自动回正，杜绝“拖拽中变大”。
  ipcMain.on('pin-move', (event, payload: { dx?: number; dy?: number; expectW?: number; expectH?: number }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const dx = Math.round(Number(payload?.dx) || 0);
    const dy = Math.round(Number(payload?.dy) || 0);
    if (dx === 0 && dy === 0) return;
    const expectW = Math.round(Number(payload?.expectW) || 0);
    const expectH = Math.round(Number(payload?.expectH) || 0);
    let current = win.getBounds();
    if (expectW >= MIN_PIN_AXIS && expectH >= MIN_PIN_AXIS) {
      const ew = expectW + PIN_EDGE * 2;
      const eh = expectH + PIN_EDGE * 2;
      if (Math.abs(current.width - ew) > 2 || Math.abs(current.height - eh) > 2) {
        // 拖动中尺寸被意外改大/改小 → 先回正（保留当前位置），再继续位移
        win.setBounds({ ...current, width: ew, height: eh });
        current = win.getBounds();
      }
    }
    // 粗略约束：不让整窗彻底跑出所有显示器工作区（允许贴边一部分在外面）
    const all = screen.getAllDisplays();
    const leftMost = Math.min(...all.map((d) => d.workArea.x));
    const topMost = Math.min(...all.map((d) => d.workArea.y));
    const rightMost = Math.max(...all.map((d) => d.workArea.x + d.workArea.width));
    const bottomMost = Math.max(...all.map((d) => d.workArea.y + d.workArea.height));
    const x = Math.min(Math.max(current.x + dx, leftMost - current.width + Math.min(MIN_PIN_AXIS, 64)), rightMost - MIN_PIN_AXIS);
    const y = Math.min(Math.max(current.y + dy, topMost - current.height + Math.min(MIN_PIN_AXIS, 64)), bottomMost - MIN_PIN_AXIS);
    win.setPosition(x, y);
  });
}

registerPinIpcHandlers();

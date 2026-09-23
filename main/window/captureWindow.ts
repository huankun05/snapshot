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
 * @file captureWindow.ts
 * @description 截图窗口服务模块
 * @description 管理截图窗口的创建、屏幕捕获和区域选择功能
 * @author 鸡哥
 */

import { app, BrowserWindow, desktopCapturer, ipcMain, nativeImage, screen } from 'electron';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { is } from '@electron-toolkit/utils';
import { capturePrimaryDisplayPng, captureAllDisplaysPng, captureDisplayRectPng, captureVirtualScreenComposite, getVisibleWindows } from './screenshotHelper';
import { readScreenshotEngineConfig, readScreenshotMultiMonitorMode } from '../config/storeConfig';
import { ensureLocalOcrMtService } from '../services/localOcrMtService';
import { hideAllPinWindows, restoreAllPinWindows } from './capturePinWindow';
import { disableWindowTransition } from './dwmTransition';
import { isNativeCaptureEnabled, triggerNativeRegionCapture } from '../services/nativeCapture';

interface CreateCaptureWindowServiceOptions {
  getMainWindow: () => BrowserWindow | null;
  /** GDI 首帧直抓成功后主进程直接喂像素帧（BGRA，DLL 通道度量对称无需换序）：
   *  省掉渲染端 33MB getImageData + IPC，帧在亮窗前就绪 → 选框与蒙版同时出现（2026-09-23）。
   *  阶段三多窗：传整个会话的逐屏帧表 + 当前光标屏 id（DLL 单槽按光标屏预备，
   *  smart:pixel-at 落在别的屏时由主进程按表换槽）。 */
  onSessionFrames?: (
    frames: Array<{ displayId: number; bounds: { x: number; y: number; width: number; height: number }; bgra: Buffer; width: number; height: number }>,
    cursorDisplayId?: number,
  ) => void;
}

interface CaptureWindowService {
  /** 归属窗（选择期=光标窗，选择后=选区窗）；对话框父窗等用途 */
  getCaptureWindow: () => BrowserWindow | null;
  /** 会话窗组全部窗口（多窗模式 hover-mode 等需逐窗处理的场景） */
  getSessionWindows: () => BrowserWindow[];
  /** sender 是否为本会话任一截图窗（OCR/翻译/长截图等 IPC 的鉴权） */
  isCaptureSender: (senderId: number) => boolean;
  /** 按 webContents id 反查会话窗（长截图编辑器/录屏等作用于发起窗） */
  getWindowBySender: (senderId: number) => BrowserWindow | null;
  /** 设置归属窗（smart:hover-mode active 的发起窗 = 选区所在屏的窗口） */
  setOwnerWindow: (win: BrowserWindow | null) => void;
  /** 悬停模式(仅活跃屏生效):idle=forward 悬停,active=选区交互 */
  applyHoverMode: (senderId: number, mode: 'idle' | 'active') => void;
  closeCaptureWindow: () => void;
  startRegionScreenshot: (
    externalImage?: Buffer,
    external?: { rect: { x: number; y: number; w: number; h: number }; scaleFactor?: number },
  ) => Promise<void>;
  triggerScreenshot: (opts?: { autoCopy?: boolean }) => Promise<void>;
}

/**
 * 创建截图窗口服务
 * @description 初始化并返回截图窗口管理服务，支持区域截图功能
 * @param options - 服务配置选项，包含主窗口获取函数
 * @returns 截图窗口服务对象
 */
export function createCaptureWindowService(options: CreateCaptureWindowServiceOptions): CaptureWindowService {
  /** 会话窗口组（2026-09-23 阶段三「每屏一窗」）：每个窗口只服务自己那块屏（原生缩放，
   *  永不跨屏 → 永不吃别的屏的 DPI 变更 = 根治混合缩放变形/发虚）。cursor 模式数组只有一项。
   *  驻留时原地 opacity 0；预热期为所有屏各建一个。 */
  interface SessionWindow {
    win: BrowserWindow;
    display: Electron.Display;
    pageReady: Promise<void> | null;
    shownOnce: boolean;
    /** 本屏的原始抓帧(跨屏裁剪合成用) */
    frame?: { bgra: Buffer; width: number; height: number };
  }
  let sessionWindows: SessionWindow[] = [];
  /** 选中归属窗（进入 SELECTED 的那扇）：编辑期对话框/长截图/录屏都挂在它上面。
   *  同时作为旧代码路径的「主窗别名」：选择期 = 光标所在窗，选择后 = 选区归属窗。 */
  let captureWindow: BrowserWindow | null = null;
  let isStartingCaptureWindow = false;
  let captureWindowDwmDisabled = false;
  /** 活跃会话标志（2026-09-23）：替代「屏内位置 + opacity」几何推断 —— 原地驻留方案下
   *  窗口平时就停在真实屏幕上，几何判断失效。预热/驻留不置位，仅真实会话置位。 */
  let captureSessionActive = false;
  /** 「截图并复制」热键：框选完成后自动复制并退出，不进标注工具栏 */
  let pendingAutoCopy = false;

  function getCaptureHtmlPath(): string {
    if (is.dev) {
      const candidates = [
        join(process.cwd(), 'resources', 'capture.html'),
        join(app.getAppPath(), 'resources', 'capture.html'),
        join(__dirname, '../../../resources/capture.html'),
      ];

      return candidates.find((c) => existsSync(c)) ?? candidates[0];
    }
    return join(process.resourcesPath, 'capture.html');
  }

  /**
   * 页面常驻（2026-09-23，Snipaste 级速度的必要条件）：capture.html 每窗只在首次（预热）加载，
   * 会话间靠 capture-clear 重置状态（该信号已清画布/全部浮层/文字编辑器/state/选区），
   * 不再每次 loadFile（实测 ~95ms，是触发→亮窗延迟仅剩的大头之一）。
   */
  function ensureCapturePage(sw: SessionWindow): Promise<void> {
    const win = sw.win;
    if (!win || win.isDestroyed()) return Promise.resolve();
    if (sw.pageReady) return sw.pageReady;
    sw.pageReady = win
      .loadFile(getCaptureHtmlPath())
      .then(() => {
        console.error(`[Screenshot] capture page loaded (persistent) t=${Date.now()} display=${sw.display.id}`);
      })
      .catch((err) => {
        console.error('[Screenshot] capture html load error:', err);
        sw.pageReady = null; // 允许下次会话重试
      });
    return sw.pageReady;
  }

  /** 截图窗收起的共同动作：恢复贴图窗与主窗。隐藏复用与真正销毁都要走这里。 */
  function onCaptureWindowDismissed(): void {
    restoreAllPinWindows();
    const mainWindow = options.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.setAlwaysOnTop(true, 'screen-saver');
    }
  }

  /**
   * 结束一次截图会话：**屏幕外驻留而不销毁、不 hide**（与 standaloneWindow / settingsWindow 复用模式同源）。
   *
   * 复用是消除 Win11 DWM 开场动画唯一可靠的手段 —— 开场动画只在窗口首次 show 时播放，
   * 复用后再 show 不再播放，reveal 里那 280ms「等动画播完」的等待也就能省掉。
   * 页面状态仍靠下次截图前重新 loadFile 保证干净（等价销毁重建，但省掉建窗/销毁开销与开场动画）。
   * 退出不受影响：托盘菜单 / IPC / 热键都是直接 app.quit()，不依赖 window-all-closed。
   *
   * 驻留前先让渲染进程清掉画布与浮层：否则下次 show 的瞬间会闪出**上一张截图**。
   */
  /** 当前活跃窗（光标所在屏的那扇）：唯一开 forward 转发跑悬停的窗；其余窗纯蒙版零事件。
   *  forward 转发的是全系统鼠标事件 —— 若两窗同时 forward，两屏都会出框且双份 UIA 查询 = 卡顿
   *  （2026-09-23 用户实测「切屏后两屏都有框 + 移动卡顿」根因）。 */
  let activeSw: SessionWindow | null = null;

  // ── 光标换屏跟随（Snipaste 模型：选框只在鼠标所在屏，无鼠标的屏 = 纯蒙版）──
  // 渲染端靠转发鼠标事件驱动悬停，光标离开后不再有任何事件 → 旧屏的框无法自知该清。
  // 主进程 40ms 轮询光标落点屏，变更即给旧屏发 capture-deactivate（新屏的悬停由转发事件自动接上）。
  let cursorPollTimer: NodeJS.Timeout | null = null;
  let pollLastDisplayId = -1;
  function stopCursorSwitchPoll(): void {
    if (cursorPollTimer) { clearInterval(cursorPollTimer); cursorPollTimer = null; }
  }
  function startCursorSwitchPoll(): void {
    stopCursorSwitchPoll();
    if (sessionWindows.length < 2) return; // 单窗无需跟随
    try { pollLastDisplayId = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id; } catch { return; }
    cursorPollTimer = setInterval(() => {
      if (!captureSessionActive) { stopCursorSwitchPoll(); return; }
      try {
        const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        const cur = activeSw && !activeSw.win.isDestroyed() && activeSw.display.id === d.id ? activeSw : null;
        if (!cur) {
          // 光标换了屏:旧屏撤转发(事件源断)+ 通知清框回纯蒙版;新屏开 forward 接管悬停
          const next = sessionWindows.find((s2) => s2.display.id === d.id && !s2.win.isDestroyed());
          if (!next) return;
          if (activeSw && !activeSw.win.isDestroyed()) {
            try {
              activeSw.win.setIgnoreMouseEvents(true);   // 纯蒙版:零事件
              activeSw.win.setFocusable(false);
            } catch { /* ignore */ }
            try { activeSw.win.webContents.send('capture-deactivate'); } catch { /* ignore */ }
          }
          try {
            // 新活跃窗 = 完全可交互(接收真实鼠标事件:悬停/框选/右键/Esc),焦点给它(键盘生效)
            next.win.setIgnoreMouseEvents(false);
            next.win.setFocusable(true);
            next.win.focus();
          } catch { /* ignore */ }
          activeSw = next;
          try {
            const pt = screen.getCursorScreenPoint();
            next.win.webContents.send('capture-activate', {
              x: Math.round(pt.x - next.display.bounds.x),
              y: Math.round(pt.y - next.display.bounds.y),
            });
          } catch { /* ignore */ }
          console.error(`[Screenshot] cursor switched to display ${d.id} (old screen → pure mask)`);
        }
      } catch { /* 取光标失败忽略 */ }
    }, 40);
  }

  // ── 跨屏拖选(Snipaste 模型):全局输入轮询 + 屏幕坐标系选区 ──
  interface InputApi {
    GetCursorPos: (pt: { x: number; y: number }) => number;
    GetAsyncKeyState: (vKey: number) => number;
  }
  let inputApi: InputApi | null | undefined;
  function getInputApi(): InputApi | null {
    if (inputApi !== undefined) return inputApi;
    try {
      const koffi = require('koffi');
      const user32 = koffi.load('user32.dll');
      // 结构体名带后缀,避免与 capture.ts 的 'POINT' 全局注册冲突
      koffi.struct('POINT_SEL', { x: 'long', y: 'long' });
      inputApi = {
        GetCursorPos: user32.func('bool GetCursorPos(POINT_SEL *pt)'),
        GetAsyncKeyState: user32.func('int16_t GetAsyncKeyState(int32_t vKey)'),
      };
    } catch (err) {
      console.warn('[Screenshot] koffi input bindings unavailable:', err);
      inputApi = null;
    }
    return inputApi;
  }

  interface SelDrag {
    startX: number; startY: number; // 逻辑坐标
    ownerWin: BrowserWindow;
    timer: NodeJS.Timeout;
  }
  let selDrag: SelDrag | null = null;

  function finishSelectionDrag(confirm: boolean): void {
    const drag = selDrag;
    selDrag = null;
    if (!drag) return;
    if (drag.timer) clearInterval(drag.timer);
    if (!confirm) {
      for (const s2 of sessionWindows) {
        if (!s2.win.isDestroyed()) {
          try { s2.win.webContents.send('capture-sel-finish', { confirm: false }); } catch { /* ignore */ }
        }
      }
      // 取消后恢复换屏跟随
      if (captureSessionActive) startCursorSwitchPoll();
      return;
    }
    // 松键:取最终光标位置定稿
    let lx = drag.startX, ly = drag.startY;
    try {
      const api = getInputApi();
      const pt = { x: 0, y: 0 };
      if (api && api.GetCursorPos(pt)) {
        try { const dip = screen.screenToDipPoint({ x: pt.x, y: pt.y }); lx = dip.x; ly = dip.y; }
        catch { lx = pt.x; ly = pt.y; }
      }
    } catch { /* ignore */ }
    const sel = {
      x: Math.min(drag.startX, lx), y: Math.min(drag.startY, ly),
      w: Math.abs(lx - drag.startX), h: Math.abs(ly - drag.startY),
    };
    if (sel.w < 3 || sel.h < 3) {
      try { drag.ownerWin.webContents.send('capture-sel-finish', { confirm: false }); } catch { /* ignore */ }
      return;
    }
    const ownerSw = sessionWindows.find((s2) => s2.win === drag.ownerWin);
    const b = ownerSw?.display.bounds;
    const within = b && sel.x >= b.x - 2 && sel.y >= b.y - 2
      && sel.x + sel.w <= b.x + b.width + 2 && sel.y + sel.h <= b.y + b.height + 2;
    if (within && ownerSw) {
      // 单屏选区:归属窗走既有定稿流程(标注/OCR/保存零改动);其余窗回纯蒙版
      for (const s2 of sessionWindows) {
        if (s2.win.isDestroyed()) continue;
        const mine = s2 === ownerSw;
        try {
          s2.win.webContents.send('capture-sel-finish', mine
            ? { confirm: true, rect: { x: Math.round(sel.x - b.x), y: Math.round(sel.y - b.y), w: Math.round(sel.w), h: Math.round(sel.h) } }
            : { confirm: false });
        } catch { /* ignore */ }
      }
      return;
    }
    // 跨屏选区:从各屏原始帧合成选区像素 → 关闭会话 → 以外调图模式进编辑器
    const parts: Array<{ x: number; sf: number; px: number; py: number; pw: number; ph: number; frame: { bgra: Buffer; width: number; height: number } }> = [];
    for (const sw of sessionWindows) {
      if (!sw.frame || sw.win.isDestroyed()) continue;
      const db = sw.display.bounds;
      const sf = sw.display.scaleFactor || 1;
      const ix0 = Math.max(sel.x, db.x), iy0 = Math.max(sel.y, db.y);
      const ix1 = Math.min(sel.x + sel.w, db.x + db.width), iy1 = Math.min(sel.y + sel.h, db.y + db.height);
      if (ix1 - ix0 < 1 || iy1 - iy0 < 1) continue;
      const px = Math.round((ix0 - db.x) * sf), py = Math.round((iy0 - db.y) * sf);
      const pw = Math.min(sw.frame.width - px, Math.round((ix1 - ix0) * sf));
      const ph = Math.min(sw.frame.height - py, Math.round((iy1 - iy0) * sf));
      if (pw < 1 || ph < 1) continue;
      parts.push({ x: ix0, sf, px, py, pw, ph, frame: sw.frame });
    }
    if (parts.length === 0) {
      try { drag.ownerWin.webContents.send('capture-sel-finish', { confirm: false }); } catch { /* ignore */ }
      return;
    }
    parts.sort((a, b2) => a.x - b2.x);
    const totalW = parts.reduce((acc, p2) => acc + p2.pw, 0);
    const totalH = Math.max(...parts.map((p2) => p2.ph));
    const out = Buffer.alloc(totalW * totalH * 4, 0xff);
    let dx = 0;
    for (const p2 of parts) {
      for (let row = 0; row < p2.ph; row++) {
        p2.frame.bgra.copy(
          out,
          (row * totalW + dx) * 4,
          (p2.py + row) * p2.pw * 4,
          (p2.py + row) * p2.pw * 4 + p2.pw * 4,
        );
      }
      dx += p2.pw;
    }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { nativeImage } = require('electron');
    const img = nativeImage.createFromBitmap(out, { width: totalW, height: totalH });
    if (img.isEmpty()) {
      try { drag.ownerWin.webContents.send('capture-sel-finish', { confirm: false }); } catch { /* ignore */ }
      return;
    }
    const cropPng = img.toPNG();
    const sfRef = parts[0].sf || 1;
    const cssW = Math.max(1, Math.round(totalW / sfRef));
    const cssH = Math.max(1, Math.round(totalH / sfRef));
    console.error(`[Screenshot] cross-display selection ${totalW}x${totalH} → crop edit ${cssW}x${cssH}css`);
    closeCaptureWindow();
    void startRegionScreenshot(cropPng, { rect: { x: 0, y: 0, w: cssW, h: cssH }, cropOnly: true });
  }

  function startSelectionDrag(senderId: number, localX: number, localY: number): void {
    const sw = sessionWindows.find((s2) => !s2.win.isDestroyed() && s2.win.webContents.id === senderId);
    if (!sw || selDrag) return;
    const api = getInputApi();
    if (!api) return;
    // 幽灵拖选守卫:发起时左键必须确实按着(单击事件到达时键已松开 → 轮询首拍即取消 → 闪动)
    try {
      const pt0 = { x: 0, y: 0 };
      if (!(api.GetAsyncKeyState(0x01) & 0x8000)) return;
      void pt0;
    } catch { /* ignore */ }
    stopCursorSwitchPoll(); // 拖选期锁定跟随(松键或取消后由 renderder 重新触发悬停)
    // 广播全部窗进入「主进程驱动的绘制状态」:每窗都要绘制选区覆盖自己的交集
    // (此前只有发起窗进入,另一窗 IDLE 拒收更新 = 拖到边界选区不延续的根因)
    for (const s2 of sessionWindows) {
      if (!s2.win.isDestroyed()) {
        try { s2.win.webContents.send('capture-sel-drag-begin'); } catch { /* ignore */ }
      }
    }
    selDrag = {
      startX: sw.display.bounds.x + localX,
      startY: sw.display.bounds.y + localY,
      ownerWin: sw.win,
      timer: setInterval(() => {
        if (!selDrag) return;
        try {
          const pt = { x: 0, y: 0 };
          if (!api.GetCursorPos(pt)) return;
          let lx = pt.x, ly = pt.y;
          try { const dip = screen.screenToDipPoint({ x: pt.x, y: pt.y }); lx = dip.x; ly = dip.y; } catch { /* ignore */ }
          if ((api.GetAsyncKeyState(0x1B) & 0x8000) || (api.GetAsyncKeyState(0x02) & 0x8000)) {
            finishSelectionDrag(false); // Esc / 右键 = 取消
            return;
          }
          if (!(api.GetAsyncKeyState(0x01) & 0x8000)) {
            finishSelectionDrag(true); // 松左键 = 定稿
            return;
          }
          const sel = {
            x: Math.min(selDrag.startX, lx), y: Math.min(selDrag.startY, ly),
            w: Math.abs(lx - selDrag.startX), h: Math.abs(ly - selDrag.startY),
          };
          for (const s2 of sessionWindows) {
            if (s2.win.isDestroyed()) continue;
            const b2 = s2.display.bounds;
            // 裁剪到本窗视口 = 各窗只画选区覆盖自己的交集;屏界两侧同一条边(边缘拉杆效果)
            const cx0 = Math.max(0, Math.round(sel.x - b2.x));
            const cy0 = Math.max(0, Math.round(sel.y - b2.y));
            const cx1 = Math.min(b2.width, Math.round(sel.x - b2.x + sel.w));
            const cy1 = Math.min(b2.height, Math.round(sel.y - b2.y + sel.h));
            const has = cx1 - cx0 >= 1 && cy1 - cy0 >= 1;
            try {
              s2.win.webContents.send('capture-sel-update', {
                x: cx0, y: cy0, w: has ? cx1 - cx0 : 0, h: has ? cy1 - cy0 : 0,
              });
            } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
      }, 25),
    };
    console.error('[Screenshot] cross-screen selection drag started');
  }

  function closeCaptureWindow(): void {
    captureSessionActive = false;
    stopCursorSwitchPoll();
    for (const sw of sessionWindows) {
      if (!sw.win || sw.win.isDestroyed()) continue;
      try {
        sw.win.webContents.send('capture-clear');
      } catch {
        /* 渲染进程已崩溃时忽略 */
      }
      try {
        sw.win.setIgnoreMouseEvents(true);
        sw.win.setFocusable(false);
        // 原地驻留 + opacity 0（不 hide）：合成表面保留 → 下次 reveal 无黑帧无开场动画；
        // 各窗停在自己屏上 → 各自 DPR 环境恒定（混合缩放零闪动的关键）
        sw.win.setOpacity(0);
      } catch { /* 单窗失败不拖累其它 */ }
    }
    captureWindow = null;
    console.error(`[Screenshot] session parked in-place t=${Date.now()} (${sessionWindows.length} windows, opacity 0)`);
    onCaptureWindowDismissed();
  }

  /**
   * 创建截图窗口壳（先不可见）：构造 + 边界 + 置顶 + 忽略鼠标 + closed 恢复回调。
   *
   * 窗口创建尽量**提前**（与截屏并行）：desktopCapturer 回退首帧最慢可达数百 ms，
   * 若等截屏完成再建窗 + loadFile，就是"按下热键 → 干等 → 突然弹窗"的「打开慢」来源。
   * Snipaste 之所以无感，正是"窗口常备、拿到帧即显示"。我们无法常备(尺寸每屏不同)，
   * 但可以把窗口准备与截屏同时进行，把可见延迟压到只剩"等帧"本身。
   */
  function createCaptureWindowShell(display: Electron.Display, bounds: Electron.Rectangle): SessionWindow {
    const win = new BrowserWindow({
      width: bounds.width,
      height: bounds.height,
      // 创建时先把窗口水平推到该屏左侧外：
      // reveal 时首次 show 发生在屏幕外，随后程序化 move 回真实位置，DWM 不会播「开窗/扩张」动画。
      x: bounds.x - bounds.width,
      y: bounds.y,
      show: false,
      transparent: true,
      frame: false,
      // 关掉 WS_THICKFRAME：否则无边框透明窗在 show() 时会被 DWM 播放
      // 「从内向外扩张」的系统动画，肉眼就是进截图时的缩放感。设为 false 同时去掉窗口阴影
      // （本就不需阴影，hasShadow 已 false），进入完全无感。
      thickFrame: false,
      // Win11 对 frameless 窗口默认加系统圆角并可能附带圆角入场动画，截图窗不需要圆角。
      roundedCorners: false,
      // 创建时不参与焦点切换：show 后再恢复可聚焦，避免任务栏图标闪烁 / 前台切换动画。
      focusable: false,
      alwaysOnTop: true,
      resizable: false,
      movable: false,
      hasShadow: false,
      skipTaskbar: true,
      // 首帧即「整屏暗蒙版」：与 capture.js 的 .capture-mask.is-full（rgba(0,0,0,.28)）同色。
      // 页面还没加载完时窗口背景就是这层半透明黑 —— 用户按热键立刻看到「整屏变暗」，
      // 而不是空/黑的透明窗表面（闪黑的根因）。截图内容随后画在它之上，两者同色 → 视觉连续。
      backgroundColor: '#47000000',
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        // 长截图期间主窗被 park 到屏外（opacity 0）：不关节流的话 Chromium 会把
        // 后台窗定时器降到 1s，拼接循环（250ms/tick）被饿死 → 滚动了也拼不上
        backgroundThrottling: false,
      },
    });

    /** Windows 会在 BrowserWindow 构造阶段将超大无边框窗口限制到单屏工作区，显式重设边界才能覆盖目标屏。 */
    win.setBounds(bounds);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true);

    // 双保险：尽量同步禁用 DWM 开窗过渡（对 Win10 有效；Win11 经常失效，微软已确认）。
    // 真正“无感进入”由「暗蒙版先行」时序保证（页面未加载时首帧即是蒙版，不存在空 surface），
    // 不依赖此 API。
    captureWindowDwmDisabled = disableWindowTransition(win);
    if (captureWindowDwmDisabled) {
      console.error('[Screenshot] DWM transition disable attempted (secondary; primary = mask-first reveal)');
    }

    // 崩溃留痕：截图编辑器渲染进程崩溃/无响应时打主进程日志（否则用户「一移动就退」无从排查）。
    win.webContents.on('render-process-gone', (_e, details) => {
      console.error('[Screenshot] capture renderer GONE:', details.reason, 'exitCode =', details.exitCode);
    });
    win.webContents.on('unresponsive', () => {
      console.error('[Screenshot] capture renderer UNRESPONSIVE');
    });
    // 渲染进程 console（capture.js 内部 console.error 不会自动上主进程 stdout）转发，
    // 崩溃前一刻的报错/警告都会出现在主进程日志里。
    // Electron 43：console-message 新式签名字段全挂事件对象上，且 level 是 **string**
    // （'verbose'|'info'|'warning'|'error'）——旧代码按 number 比较（level >= 2）恒为 false，
    // 导致 [cap] 打点从未转发（用户实测日志里一条都没有）。这里做 string/number 双兼容。
    win.webContents.on(
      'console-message',
      // 监听器签名按 Electron 内置类型是 (event: Event<ConsoleMessageParams>)，
      // 但历史版本是 (event, level, message, line, sourceId) 展开式，统一按 any 处理兼容两者。
      ((...args: unknown[]) => {
        const first = (args[0] ?? {}) as Record<string, unknown>;
        const newStyle = typeof first.level === 'string' || typeof first.level === 'number';
        const levelRaw = newStyle ? first.level : args[1];
        const message = newStyle ? (first.message ?? '') : (args[2] ?? '');
        const line = newStyle ? (first.lineNumber ?? first.line ?? 0) : (args[3] ?? 0);
        const sourceId = newStyle ? (first.sourceId ?? '') : (args[4] ?? '');
        const levelNum =
          typeof levelRaw === 'number'
            ? levelRaw
            : levelRaw === 'error' || levelRaw === 'warning'
              ? 2
              : 0;
        // 诊断期：全级别转发（capture 窗口仅截图期间存在，log 量可控）
        if (levelNum >= 2) {
          console.error(`[capture-console:${String(levelRaw)}]`, String(message), `(${String(sourceId)}:${String(line)})`);
        } else if (message) {
          console.log(`[capture-console:${String(levelRaw)}]`, String(message), `(${String(sourceId)}:${String(line)})`);
        }
      }) as (...args: unknown[]) => void,
    );
    // 谁关的窗口：区分「渲染崩溃连带关闭」vs「代码主动 close / capture-cancel / 用户按键」
    win.on('close', () => {
      console.error('[Screenshot] capture window closing (display=' + display.id + ')');
    });

    win.on('closed', () => {
      sessionWindows = sessionWindows.filter((s) => s.win !== win);
      if (captureWindow === win) captureWindow = null;
      captureSessionActive = false;
      onCaptureWindowDismissed();
    });

    const sw: SessionWindow = { win, display, pageReady: null, shownOnce: false };
    sessionWindows.push(sw);
    return sw;
  }

  /**
   * 确保会话窗口组覆盖目标屏集合（2026-09-23 阶段三「每屏一窗」）：
   * 复用池内驻留窗（边界匹配 ±2px 直接用；不匹配则挪到目标屏 —— opacity 0 不可见期完成
   * DPI 切换，settle 等待吃在暗处），缺的屏新建壳。返回全部就位的窗口组 + settle 等待。
   */
  function ensureSessionWindows(targets: Electron.Display[]): { windows: SessionWindow[]; settled: Promise<void> } {
    const settles: Array<Promise<void>> = [];
    const windows: SessionWindow[] = targets.map((display) => {
      const bounds = { x: display.bounds.x, y: display.bounds.y, width: display.size.width, height: display.size.height };
      let sw = sessionWindows.find((s) => s.display.id === display.id && !s.win.isDestroyed());
      if (!sw) {
        sw = createCaptureWindowShell(display, bounds);
      } else {
        sw.display = display;
        const cur = sw.win.getBounds();
        const sameSpot = Math.abs(cur.x - bounds.x) <= 2 && Math.abs(cur.y - bounds.y) <= 2
          && Math.abs(cur.width - bounds.width) <= 2 && Math.abs(cur.height - bounds.height) <= 2;
        if (!sameSpot) {
          // 不可见期挪屏/改尺寸：WM_DPICHANGED 的重排吃在暗处（混合缩放零闪动的关键）
          sw.win.setBounds(bounds, false);
          settles.push(new Promise<void>((resolve) => setTimeout(resolve, 140)));
          console.error(`[Screenshot] session window moved to display ${display.id} (invisible dpr transition, settle 140ms)`);
        }
      }
      return sw;
    });
    return { windows, settled: Promise.all(settles).then(() => undefined) };
  }

  /**
   * 显示截图窗（Win10/Win11 通用）。
   *
   * 实测结论（2026-09-03，用户跑应用）：
   * - 「最终位置 1px 种子 + 50ms 后扩全屏」被 Win11 DWM 合并成「从左上角 1px 展开到全屏」的
   *   可见动画（用户反馈"窗口从左上角打开了"）——resize 离 show 太近，DWM 把它当开场的一部分。
   * - 「直接 show + DWMWA_TRANSITIONS_FORCEDISABLED」在 Win11 对该开场缩放经常失效
   *   （微软官方 Q&A 确认，返回 S_OK 是假成功）。
   * - 唯一可靠做法 = 让 DWM 开放在**完全屏外**播完，再瞬移回真实位置：屏外方向无任何可见性，
   *   故无论开场是「从中心」「从角」都不会被看到；setBounds(..., false) 的 move/resize 无动画。
   *   代价是 ~200ms 延迟（等开场播完），这是 Win11 无 API 可编程禁开场下的必然取舍。
   */
  /**
   * 一次性亮窗：把窗口从「屏外 + opacity 0」驻留位移回屏内并恢复不透明。
   *
   * 调用时机（2026-09-04 核心时序）：**渲染端已把截图内容画好、帧已提交合成器之后**
   * （主进程等到 capture-ready 才调这里）。因此亮起瞬间 = 「暗化截图 + 蒙版」完整终态，
   * 不存在「活的桌面 → 静止截图」的中间帧 → 无闪。
   *
   * 窗口此时已 show 过（预热 / 上会话驻留时从未 hide），再次 showInactive 无 DWM 开场动画，
   * 直接瞬移 + 恢复不透明度即可，无需任何等待。
   */
  function revealMaskWindow(win: BrowserWindow, bounds: Electron.Rectangle): void {
    win.setBounds(bounds, false);
    win.setOpacity(1);
    win.showInactive();
    const sw = sessionWindows.find((s) => s.win === win);
    if (sw) sw.shownOnce = true;
    console.error(
      `[Screenshot] reveal t=${Date.now()} pos=${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`,
    );
  }

  /**
   * 收尾：放开鼠标交互 + 聚焦。紧跟在 revealMaskWindow 之后调用（窗口刚亮起）。
   * 这里不做任何 show/move/opacity 变化 —— 那些动作正是历史上「进截图闪一下」的来源。
   */
  function finalizeCaptureWindow(win: BrowserWindow): void {
    console.error(`[Screenshot] finalize t=${Date.now()} mouse-on + focus`);
    captureSessionActive = true;
    win.setIgnoreMouseEvents(false);
    win.setFocusable(true);
    win.focus();
  }

  async function waitForMainWindowHidden(timeoutMs: number = 80): Promise<void> {
    const targetWindow = options.getMainWindow();
    if (!targetWindow || targetWindow.isDestroyed() || !targetWindow.isVisible()) {
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (!targetWindow.isDestroyed()) {
          targetWindow.removeListener('hide', finish);
        }
        resolve();
      };

      targetWindow.once('hide', finish);
      targetWindow.hide();
      setTimeout(finish, timeoutMs);
    });
  }

  /**
   * 多显示器按光标截屏（2026-09-22 方案①）：**触发时刻**光标所在屏 = 本次会话目标屏。
   * 会话全程（截屏 / 建窗 / 亮窗）固定用同一个目标屏 —— 期间光标可能移动，逐处重新取会
   * 造成「截的是 A 屏、窗口亮在 B 屏」的错位。选区限制在单屏内（不跨屏，用户已确认）。
   */
  function resolveTargetDisplay(): Electron.Display {
    try {
      return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    } catch {
      return screen.getPrimaryDisplay();
    }
  }

  /**
   * 计算所有显示器合并后的虚拟屏幕边界
   * @description 遍历全部显示器，返回包含所有屏幕的最小矩形和最大缩放因子
   */
  function getVirtualScreenBounds(): { x: number; y: number; width: number; height: number; scaleFactor: number } {
    const displays = screen.getAllDisplays();
    if (displays.length <= 1) {
      const primary = screen.getPrimaryDisplay();
      return {
        x: primary.bounds.x,
        y: primary.bounds.y,
        width: primary.size.width,
        height: primary.size.height,
        scaleFactor: primary.scaleFactor || 1,
      };
    }

    const { minX, minY, maxX, maxY, maxScale } = displays.reduce(
      (acc, d) => {
        const b = d.bounds;
        return {
          minX: Math.min(acc.minX, b.x),
          minY: Math.min(acc.minY, b.y),
          maxX: Math.max(acc.maxX, b.x + b.width),
          maxY: Math.max(acc.maxY, b.y + b.height),
          maxScale: Math.max(acc.maxScale, d.scaleFactor || 1),
        };
      },
      { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, maxScale: 1 },
    );

    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
      scaleFactor: maxScale,
    };
  }

  interface DisplayLayout {
    id: number;
    bounds: Electron.Rectangle;
    physicalBounds: Electron.Rectangle;
    scaleFactor: number;
  }

  /**
   * 获取所有显示器的布局信息
   * @returns 显示器布局数组与合并后的物理屏幕边界
   */
  function getDisplayLayouts(): { displayLayouts: DisplayLayout[]; physicalScreen: { x: number; y: number; width: number; height: number } } {
    const displays = screen.getAllDisplays();
    const displayLayouts = displays.map((display) => ({
      id: display.id,
      bounds: display.bounds,
      physicalBounds: screen.dipToScreenRect(null, display.bounds),
      scaleFactor: display.scaleFactor,
    }));
    const physicalScreen = displayLayouts.reduce(
      (bounds, display) => ({
        x: Math.min(bounds.x, display.physicalBounds.x),
        y: Math.min(bounds.y, display.physicalBounds.y),
        right: Math.max(bounds.right, display.physicalBounds.x + display.physicalBounds.width),
        bottom: Math.max(bounds.bottom, display.physicalBounds.y + display.physicalBounds.height),
      }),
      { x: Infinity, y: Infinity, right: -Infinity, bottom: -Infinity },
    );

    return {
      displayLayouts,
      physicalScreen: {
        x: physicalScreen.x,
        y: physicalScreen.y,
        width: physicalScreen.right - physicalScreen.x,
        height: physicalScreen.bottom - physicalScreen.y,
      },
    };
  }

  interface CaptureResult {
    /** PNG 字节。GDI 直抓路径为 null（走 rawFrame 直出，跳过 PNG 编解码） */
    imageBytes: Buffer | null;
    captureSource: 'plugin' | 'js' | 'external';
    winBounds: { x: number; y: number; width: number; height: number };
    virtualScreen: { x: number; y: number; width: number; height: number };
    scaleFactor: number;
    /** GDI 直抓原始帧：渲染端 putImageData 上屏 + 主进程直喂像素帧（同一份 BGRA） */
    rawFrame?: { bgra: Buffer; width: number; height: number };
  }

  /**
   * 尝试截取屏幕图像，优先 GDI 直抓，回退到 JS 方案（2026-09-23 启动速度专项 + 多屏范围设置）
   * @param target - 光标所在屏（多屏范围=「仅光标屏」时的目标屏；「全部屏幕」模式仅用于 JS 回退参考）
   * @param allScreens - 多显示器范围设置：true=全部屏幕（窗口/帧覆盖整块虚拟屏，可跨屏框选）
   * @param vs - 虚拟屏合并边界（allScreens 模式的窗口/帧范围）
   * @returns 截图结果，JS 回退失败时返回 null
   */
  async function tryCaptureScreenshot(
    target: Electron.Display,
    allScreens: boolean,
    vs: { x: number; y: number; width: number; height: number; scaleFactor: number },
  ): Promise<CaptureResult | null> {
    const enginePref = readScreenshotEngineConfig();
    // 会话矩形：「仅光标屏」=目标屏 bounds；「全部屏幕」=整块虚拟屏（旧多屏行为）
    const sessionRect = allScreens
      ? { x: vs.x, y: vs.y, width: vs.width, height: vs.height }
      : { x: target.bounds.x, y: target.bounds.y, width: target.size.width, height: target.size.height };
    const sessionScale = allScreens ? (vs.scaleFactor || 1) : (target.scaleFactor || 1);

    if (enginePref === 'plugin') {
      // 首帧 GDI 直抓（毫秒级）：desktopCapturer 系统取屏 300~900ms 是触发→亮窗延迟大头，
      // 长截图 2026-09-06 起同款 BitBlt 路线已长期验证。失败依序回退：@eisland 插件 → desktopCapturer。
      // ⚠️ 本版 Electron 的 dipToScreenRect 第一参数只认 BrowserWindow|null（传 Display 返回 undefined
      // ——2026-09-23「F1 无响应」根因，探针 _diag 实证）；null = 取 rect 所在屏，与 getDisplayLayouts 同款。
      // 「全部屏幕」模式：整块虚拟屏没有单一缩放率，对合并矩形做一次 dipToScreenRect 会把副屏
      // 裁掉+切片变形（实测 4694 vs 真实 5120，用户截图确认）→ 逐屏各自抓取后行拷贝合成。
      let gdi: { bgra: Buffer; width: number; height: number } | null = null;
      if (allScreens) {
        gdi = captureVirtualScreenComposite(getDisplayLayouts().displayLayouts);
      } else {
        const pb = screen.dipToScreenRect(null, sessionRect);
        gdi = pb ? captureDisplayRectPng(pb.x, pb.y, pb.width, pb.height) : null;
      }
      if (gdi) {
        return {
          imageBytes: null,
          captureSource: 'plugin',
          winBounds: sessionRect,
          virtualScreen: sessionRect,
          scaleFactor: sessionScale,
          rawFrame: { bgra: gdi.bgra, width: gdi.width, height: gdi.height },
        };
      }

      const isMultiMonitor = screen.getAllDisplays().length > 1;
      // 插件引擎：单屏会话直接抓；多屏时插件只有「整块虚拟屏」导出 → 抓全屏后裁出目标屏；
      // 裁剪失败不再退「主屏 PNG」（内容与目标屏不符，宁走 JS 回退）
      let nativeScreenshot: Buffer | null = null;
      if (allScreens) {
        nativeScreenshot = isMultiMonitor ? captureAllDisplaysPng() : capturePrimaryDisplayPng();
      } else {
        nativeScreenshot = isMultiMonitor ? captureAllDisplaysPng() : null;
        if (!nativeScreenshot) {
          nativeScreenshot = isMultiMonitor ? null : capturePrimaryDisplayPng();
        } else {
          nativeScreenshot = cropImageToDisplay(nativeScreenshot, target) ;
        }
      }

      if (nativeScreenshot) {
        return {
          imageBytes: nativeScreenshot,
          captureSource: 'plugin',
          winBounds: sessionRect,
          virtualScreen: sessionRect,
          scaleFactor: sessionScale,
        };
      }
    }

    /** JS 回退：desktopCapturer（按 display_id 匹配源）。「全部屏幕」模式无合成能力，
     *  退历史行为：主屏源 + 主屏 bounds（多屏下仅主屏区域有画面，与 GDI 前的旧行为一致） */
    const srcDisplay = allScreens ? screen.getPrimaryDisplay() : target;
    const { width: sw, height: sh } = srcDisplay.size;
    const sf = srcDisplay.scaleFactor || 1;
    const tSources = Date.now();
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(sw * sf), height: Math.round(sh * sf) },
    });
    console.error(`[Screenshot] desktopCapturer getSources ${Date.now() - tSources}ms (fallback path)`);
    if (!sources || sources.length === 0) {
      return null;
    }
    // display_id 匹配失败（个别驱动源缺 display_id）退 sources[0]：与旧行为一致，至少不空手
    const source = sources.find((s) => s.display_id === String(srcDisplay.id)) ?? sources[0];

    return {
      imageBytes: source.thumbnail.toPNG(),
      captureSource: 'js',
      winBounds: { x: srcDisplay.bounds.x, y: srcDisplay.bounds.y, width: sw, height: sh },
      virtualScreen: { x: srcDisplay.bounds.x, y: srcDisplay.bounds.y, width: sw, height: sh },
      scaleFactor: sf,
    };
  }

  /**
   * 把整块虚拟屏截图裁出目标屏的物理矩形（原生插件多屏导出专用；单屏路径不经过这里）
   */
  function cropImageToDisplay(png: Buffer, target: Electron.Display): Buffer | null {
    try {
      const dl = getDisplayLayouts();
      const targetLayout = dl.displayLayouts.find((l) => l.id === target.id);
      if (!targetLayout || dl.displayLayouts.length === 0) return null;
      const originX = Math.min(...dl.displayLayouts.map((l) => l.physicalBounds.x));
      const originY = Math.min(...dl.displayLayouts.map((l) => l.physicalBounds.y));
      const pb = targetLayout.physicalBounds;
      const cropped = nativeImage
        .createFromBuffer(png)
        .crop({ x: pb.x - originX, y: pb.y - originY, width: pb.width, height: pb.height });
      return cropped.isEmpty() ? null : cropped.toPNG();
    } catch (err) {
      console.warn('[Screenshot] crop plugin capture to target display failed:', err);
      return null;
    }
  }

  async function startRegionScreenshot(
    externalImage?: Buffer,
    external?: { rect: { x: number; y: number; w: number; h: number }; scaleFactor?: number; cropOnly?: boolean },
  ): Promise<void> {
    // 会话进行中（窗口正显示）或正在启动 → 忽略重复触发（防热键连按/按钮双击）。
    // 复用模式下会话结束是「屏幕外驻留 + opacity 0」而非销毁，窗口一直 visible，
    // 所以仅凭 isVisible() 会把第二次截图误判成重复触发 → 必须叠加 opacity >= 1 判断。
    // 预热 show 后 ~450ms 内 opacity 仍是 1（屏外）→ 若只判 opacity 会把「启动后
    // 1.2~1.65s 内按热键」误拦（预热窗口期竞态）→ 再加屏内位置判断：
    // 驻留/预热窗口 x = vs.x - width - 200 < vs.x，永远不算活跃会话。
    if (isStartingCaptureWindow) return;
    if (captureSessionActive) return;
    isStartingCaptureWindow = true;
    console.error(`[Screenshot] trigger t=${Date.now()} (hotkey → this line = 注册回调+防重入判断开销)`);

    // 预热本地 OCR/翻译服务（后台 fire-and-forget，不阻塞截图流程）：
    // 用户框选/标注期间 PaddleOCR 模型在后台加载，点 OCR/翻译时已就绪，避免首调等 ~11s。
    // 服务为应用级单例（启动后常驻、退出时由 will-quit 回收）；预热失败不阻塞，
    // 真正首次点击 OCR/翻译时会重试并给出明确错误。
    // 延迟到 1.2s 再拉起：Python 冷启动/模型导入瞬间 CPU 冲高，太早启动会挤占
    // 「全屏 PNG 解码 + 首帧合成」关键路径——这是"打开截图变慢"的主因之一。
    // 调试开关：XIYUE_DISABLE_OCR_PREWARM=1 可临时关掉预热（排查「拖选区卡退」是否由
    // Paddle 初始化抢 GPU/CPU 引起，无需改代码）。
    if (process.env.XIYUE_DISABLE_OCR_PREWARM !== '1') {
      setTimeout(() => {
        void ensureLocalOcrMtService().catch(() => {
          /* 预热失败静默，不打断截图 */
        });
      }, 1200);
    }

    try {
      // 截图开始前隐藏已贴到桌面的贴图，避免挡在选区层上；截图窗关闭（完成/取消）时由 closed 恢复
      hideAllPinWindows();
      // 多显示器范围（设置「截图 → 多显示器范围」）：仅光标屏（默认）或全部屏幕
      const allScreens = readScreenshotMultiMonitorMode() === 'all';
      let capture: CaptureResult | null = null; // 仅 external 路径使用（built-in 走「每窗一屏」流程）

      if (externalImage) {
        // 外调 native_shot 返回的图：
        //  - 带选区 rect → 全屏接管，选区原位高亮 + 四周暗化（与内置截图 UI 一致）。
        //  - 不带 rect（旧式） → 窗口尺寸=图尺寸居中显示（兼容裁剪图直传）。
        const img = nativeImage.createFromBuffer(externalImage);
        const size = img.getSize();
        if (img.isEmpty() || size.width <= 0 || size.height <= 0) {
          // 图无效（可能读到半截文件）→ 抛错走外层 catch，恢复主窗并清理窗口，
          // 避免建出 1×1 不可见空窗导致「截图后没反应 + 灵动岛消失」。
          console.error('[Screenshot] external image invalid, size =', size);
          throw new Error('Invalid external screenshot image');
        }
        const primary = screen.getPrimaryDisplay();
        const sf = external?.scaleFactor ?? primary.scaleFactor ?? 1;
        if (external?.cropOnly && external.rect && external.rect.w > 0 && external.rect.h > 0) {
          // 跨屏裁剪编辑:窗口=裁剪图尺寸,选区=全图(标注/OCR/保存作用于裁剪结果)
          const b = primary.bounds;
          capture = {
            imageBytes: externalImage,
            captureSource: 'external',
            winBounds: { x: b.x, y: b.y, width: external.rect.w, height: external.rect.h },
            virtualScreen: { x: b.x, y: b.y, width: external.rect.w, height: external.rect.h },
            scaleFactor: sf,
          };
        } else if (external?.rect && external.rect.w > 0 && external.rect.h > 0) {
          // 全屏接管：窗口铺满主屏，选区按原始屏幕坐标落位。
          const b = primary.bounds;
          capture = {
            imageBytes: externalImage,
            captureSource: 'external',
            winBounds: { x: b.x, y: b.y, width: b.width, height: b.height },
            virtualScreen: { x: b.x, y: b.y, width: b.width, height: b.height },
            scaleFactor: sf,
          };
        } else {
          // 居中小窗（旧行为）：窗口尺寸=图尺寸（CSS px）
          const cssW = Math.max(1, Math.round(size.width / sf));
          const cssH = Math.max(1, Math.round(size.height / sf));
          const x = Math.round(primary.bounds.x + (primary.size.width - cssW) / 2);
          const y = Math.round(primary.bounds.y + (primary.size.height - cssH) / 2);
          capture = {
            imageBytes: externalImage,
            captureSource: 'external',
            winBounds: { x, y, width: cssW, height: cssH },
            virtualScreen: { x, y, width: cssW, height: cssH },
            scaleFactor: sf,
          };
        }
      } else {
        // ── built-in「每窗一屏」流程（2026-09-23 阶段三）：每窗只服务自己那块屏，原生缩放
        // 永不跨屏 → 永不吃别的屏的 DPI 重排（混合缩放变形/发虚的根治）。
        // cursor 模式 = 目标屏单窗（行为与旧版一致）；all 模式 = 全部屏各一窗，同亮同灭，
        // 选区在哪屏就在哪屏完成（Snipaste 模型：锁所有屏，选框不出屏）。
        const targetDisplays = allScreens ? screen.getAllDisplays() : [resolveTargetDisplay()];
        const cursorDisplay = resolveTargetDisplay();
        const { windows: session, settled } = ensureSessionWindows(targetDisplays);
        captureWindow = session.find((s) => s.display.id === cursorDisplay.id)?.win ?? session[0]?.win ?? null;

        await waitForMainWindowHidden();
        // 换屏/改尺寸的窗口在不可见期完成了 DPI 切换，等它稳定（同屏窗口立即兑现）
        await settled;

        // 逐屏截帧：必须在暗蒙版亮起之前（此刻全部窗口不可见，截到干净桌面）。
        // 引擎偏好 'js' = 跳过 GDI 直接 desktopCapturer（用户显式选择的兼容模式）。
        const enginePref = readScreenshotEngineConfig();
        type PerDisplayCapture = {
          display: Electron.Display;
          raw?: { bgra: Buffer; width: number; height: number };
          png?: Buffer;
        };
        const captures: PerDisplayCapture[] = [];
        for (const d of targetDisplays) {
          let raw: { bgra: Buffer; width: number; height: number } | undefined;
          let png: Buffer | undefined;
          if (enginePref !== 'js') {
            const pb = screen.dipToScreenRect(null, d.bounds);
            raw = (pb ? captureDisplayRectPng(pb.x, pb.y, pb.width, pb.height) : null) ?? undefined;
          }
          if (!raw) {
            // JS 回退：desktopCapturer 按 display_id 匹配该屏源，thumbnail=该屏尺寸×缩放
            try {
              const sf2 = d.scaleFactor || 1;
              const sources = await desktopCapturer.getSources({
                types: ['screen'],
                thumbnailSize: { width: Math.round(d.size.width * sf2), height: Math.round(d.size.height * sf2) },
              });
              const src = sources.find((s) => s.display_id === String(d.id)) ?? sources[0];
              if (src) png = src.thumbnail.toPNG();
            } catch (err) {
              console.warn('[Screenshot] desktopCapturer fallback failed for display', d.id, err);
            }
          }
          if (!raw && !png) {
            console.error('[Screenshot] capture failed for display', d.id, '→ session aborted');
          }
          captures.push({ display: d, raw, png });
        }
        if (captures.every((c) => !c.raw && !c.png)) {
          closeCaptureWindow();
          const mainWindow = options.getMainWindow();
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.show();
            mainWindow.setAlwaysOnTop(true, 'screen-saver');
          }
          return;
        }

        // 页面就绪（并行；预热期通常已全部加载完成）
        await Promise.all(session.map((sw) => ensureCapturePage(sw)));
        console.error(
          `[Screenshot] builtin ready t=${Date.now()} displays=${captures.map((c) => (c.raw ? `gdi${c.raw.width}x${c.raw.height}` : `png${c.display.id}`)).join(',')} windows=${session.length}`,
        );

        // 会话帧挂到各窗(跨屏裁剪合成用)
        for (const c of captures) {
          const sw = session.find((s2) => s2.display.id === c.display.id);
          if (sw && c.raw) sw.frame = c.raw;
        }
        // 像素帧交给主进程会话缓存：smart:pixel-at 按 vsX/vsY 所在屏切换 DLL 单槽
        //（混合缩放下每屏帧各自自洽；旧「整块合成帧」方案比例混杂无法换算，已废弃）
        if (options.onSessionFrames) {
          options.onSessionFrames(
            captures
              .filter((c) => c.raw)
              .map((c) => ({
                displayId: c.display.id,
                bounds: { x: c.display.bounds.x, y: c.display.bounds.y, width: c.display.size.width, height: c.display.size.height },
                bgra: c.raw!.bgra,
                width: c.raw!.width,
                height: c.raw!.height,
              })),
          );
        }

        // 逐窗发载荷：virtualScreen = 自己屏的 bounds（单屏会话语义，渲染端恒等绘制 1:1）；
        // 窗口此刻全部不可见，内容在暗处画好
        let sendAt = Date.now();
        const readyTargets = new Set<Electron.WebContents>();
        for (const c of captures) {
          const sw = session.find((s) => s.display.id === c.display.id);
          if (!sw || sw.win.isDestroyed() || (!c.raw && !c.png)) continue;
          const own = { x: c.display.bounds.x, y: c.display.bounds.y, width: c.display.size.width, height: c.display.size.height };
          let cursorInCapture: { x: number; y: number } | null = null;
          try {
            const cur = screen.getCursorScreenPoint();
            cursorInCapture = { x: Math.round(cur.x - own.x), y: Math.round(cur.y - own.y) };
          } catch { /* ignore */ }
          readyTargets.add(sw.win.webContents);
          sw.win.webContents.send('capture-image', {
            imageBytes: c.png ?? null,
            rawFrame: c.raw ?? null,
            virtualScreen: own,
            displays: [],
            physicalScreen: null,
            scaleFactor: c.display.scaleFactor || 1,
            captureSource: c.raw ? 'plugin' : 'js',
            framePrepared: Boolean(c.raw),
            multiWindow: session.length > 1,
            visibleWindows: getVisibleWindows(),
            externalCapture: false,
            autoCopy: pendingAutoCopy,
            cursor: cursorInCapture,
            cropRect: null,
          });
        }
        pendingAutoCopy = false;

        // 等全部窗口 capture-ready（800ms 兜底：任一渲染端没回也要亮窗，避免「按了没反应」）
        await new Promise<void>((resolve) => {
          let got = 0;
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            ipcMain.removeListener('capture-ready', onReady);
            clearTimeout(timer);
            resolve();
          };
          const onReady = (event: Electron.IpcMainEvent) => {
            if (!readyTargets.has(event.sender)) return;
            got++;
            if (got >= readyTargets.size) finish();
          };
          const timer = setTimeout(() => {
            console.error(`[Screenshot] capture-ready TIMEOUT ${got}/${readyTargets.size} after 800ms`);
            finish();
          }, 800);
          ipcMain.on('capture-ready', onReady);
        });

        // 全部窗口一次性亮窗（首帧 = 完整暗化画面）；交互全开，焦点只给光标所在窗
        captureSessionActive = true; // 换屏跟随轮询的存活条件;防会话中重复触发(此前漏置→轮询首tick自停→切屏失效)
        for (const c of captures) {
          const sw = session.find((s) => s.display.id === c.display.id);
          if (!sw || sw.win.isDestroyed()) continue;
          revealMaskWindow(sw.win, { x: c.display.bounds.x, y: c.display.bounds.y, width: c.display.size.width, height: c.display.size.height });
        }
        for (const sw of session) {
          if (sw.win.isDestroyed()) continue;
          try {
            sw.win.setIgnoreMouseEvents(false);
            sw.win.setFocusable(true);
          } catch { /* ignore */ }
        }
        const cursorSw = session.find((s) => s.display.id === cursorDisplay.id);
        try { cursorSw?.win.focus(); } catch { /* ignore */ }
        if (allScreens && cursorSw) {
          // 唯一活跃屏:光标窗**完全可交互**(真实鼠标事件:悬停/框选/右键/Esc 全通);
          // 其余窗纯蒙版(零事件零框零查询)。废弃 forward 悬停——它是点击穿透导致
          // 「无法选中/无法退出」的根源(2026-09-23 用户实测)
          activeSw = cursorSw;
          for (const sw of session) {
            if (sw.win.isDestroyed()) continue;
            try {
              if (sw === activeSw) {
                sw.win.setIgnoreMouseEvents(false);
                sw.win.setFocusable(true);
              } else {
                sw.win.setIgnoreMouseEvents(true);
                sw.win.setFocusable(false);
              }
            } catch { /* ignore */ }
          }
          startCursorSwitchPoll();
        }
        console.error(
          `[Screenshot] capture editor shown, mode=${allScreens ? 'all' : 'cursor'} windows=${session.length} t=${Date.now()}`,
        );
      }

      // external（外调图）路径：单窗会话（主屏），载荷带原图 + 选区 rect，与旧版行为一致
      let sendAt = 0;
      let externalWin: SessionWindow | null = null;
      if (externalImage && capture) {
        const primary = screen.getPrimaryDisplay();
        const { windows: session, settled } = ensureSessionWindows([primary]);
        externalWin = session[0] ?? null;
        captureWindow = externalWin?.win ?? null;
        if (externalWin) {
          // 不可见期把窗摆到载荷边界（external 载荷的 winBounds 即 reveal 边界）
          externalWin.win.setBounds(capture.winBounds, false);
          await settled;
          await ensureCapturePage(externalWin);
          await waitForMainWindowHidden();
        }
      }

      /**
       * 【核心时序】内容先画好 → 帧提交合成器 → 再一次性亮窗（同前）；external 为单窗版本。
       * 兜底 800ms：渲染进程万一没发 capture-ready，也要把窗口亮出来并放开交互。
       */
      let contentReadyPromise: Promise<void> | null = null;
      if (externalWin && capture) {
        contentReadyPromise = new Promise<void>((resolve) => {
        const target = externalWin?.win ?? null;
        let settled2 = false;
        const finish = () => {
          if (settled2) return;
          settled2 = true;
          ipcMain.removeListener('capture-ready', onReady);
          clearTimeout(timer);
          resolve();
        };
        const onReady = (event: Electron.IpcMainEvent) => {
          if (!target || target.isDestroyed() || event.sender !== target.webContents) return;
          console.error(`[Screenshot] renderer capture-ready t=${Date.now()} (${Date.now() - sendAt}ms after send)`);
          finish();
        };
        const timer = setTimeout(() => {
          console.error(`[Screenshot] capture-ready TIMEOUT after 800ms (renderer never replied)`);
          finish();
        }, 800);
        ipcMain.on('capture-ready', onReady);
        });
      }

      if (externalWin && !externalWin.win.isDestroyed() && capture) {
        sendAt = Date.now();
        console.error(
          `[Screenshot] send capture-image t=${sendAt} bytes=${capture.imageBytes ? capture.imageBytes.length : 0} src=${capture.captureSource} (window parked/invisible)`,
        );
        let cursorInCapture: { x: number; y: number } | null = null;
        try {
          const cur = screen.getCursorScreenPoint();
          cursorInCapture = {
            x: Math.round(cur.x - capture.virtualScreen.x),
            y: Math.round(cur.y - capture.virtualScreen.y),
          };
        } catch { /* ignore */ }

        externalWin.win.webContents.send('capture-image', {
          imageBytes: capture.imageBytes,
          rawFrame: null,
          virtualScreen: capture.virtualScreen,
          displays: [],
          physicalScreen: null,
          scaleFactor: capture.scaleFactor,
          captureSource: capture.captureSource,
          framePrepared: false,
          visibleWindows: [],
          externalCapture: true,
          autoCopy: pendingAutoCopy,
          cursor: cursorInCapture,
          cropRect: external && external.rect && external.rect.w > 0 && external.rect.h > 0
            ? { x: external.rect.x, y: external.rect.y, w: external.rect.w, h: external.rect.h }
            : null,
        });
        pendingAutoCopy = false;
        // 渲染端画完（帧已提交）之前一直保持不可见
        if (contentReadyPromise) await contentReadyPromise;
      }

      // 内容已就绪 → 一次性亮窗（首帧 = 完整暗化画面）+ 交付交互
      if (externalWin && !externalWin.win.isDestroyed() && capture) {
        revealMaskWindow(externalWin.win, capture.winBounds);
        console.error(
          `[Screenshot] capture editor shown, mode=${capture.captureSource} window=${capture.winBounds.width}x${capture.winBounds.height}`,
        );
        finalizeCaptureWindow(externalWin.win);
      }
    } catch (err) {
      console.error('[Screenshot] start error:', err);
      captureSessionActive = false;
      if (captureWindow && !captureWindow.isDestroyed()) {
        captureWindow.destroy();
      }
      captureWindow = null;
      const mainWindow = options.getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.setAlwaysOnTop(true, 'screen-saver');
      }
    } finally {
      isStartingCaptureWindow = false;
    }
  }

  /**
   * 统一截图入口（热键与渲染端工具栏按钮、IPC 都走这一条）：
   * 1. 若配置了原生开源截图工具（xland/ScreenCapture 等），优先唤起原生引擎——
   *    原生窗口由 OS 直接合成，无 Electron 透明窗的「闪黑 / 放大镜黑块」问题；截完即退。
   * 2. 未配置、或原生调用失败/退出码非 0 时，回退到内置 Electron 截图窗（选区 + 标注 + OCR/翻译）。
   * 这样无论用户按热键还是点灵动岛上的截图按钮，行为都一致，不会有人绕回旧引擎。
   */
  async function triggerScreenshot(opts?: { autoCopy?: boolean }): Promise<void> {
    pendingAutoCopy = opts?.autoCopy === true;
    if (isNativeCaptureEnabled()) {
      // 走原生引擎时 Electron 的 startRegionScreenshot 不会被调用，而它原本负责预热本地
      // OCR/MT 服务。这里提前把服务拉起来，编辑面板里的「OCR / 翻译」才能连上
      // 127.0.0.1:18765（冷启动 Python 要几秒，趁用户框选的功夫刚好起好）。
      void ensureLocalOcrMtService().catch(() => { /* 预热失败静默，点 OCR/翻译时再报错 */ });
      const mainWindow = options.getMainWindow();
      const ok = await triggerNativeRegionCapture({
        hideMainWindow: () => {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
        },
        showMainWindow: () => {
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
        },
      });
      if (ok) {
        // 原生引擎已把「全主屏 PNG」写到临时文件、选区元数据写到同名 json，
        // 并把裁剪图复制进剪贴板。交给 Electron 编辑面板时连同选区 rect 一起传，
        // 让 capture.js 以「全屏 + 选区原位高亮 + 四周暗化」的方式接管（与内置 UI 一致）。
        try {
          const tmp = join(app.getPath('temp'), 'xiyue_native_capture.png');
          const metaPath = join(app.getPath('temp'), 'xiyue_native_capture_meta.json');
          if (existsSync(tmp)) {
            const buf = readFileSync(tmp);
            let external: { rect: { x: number; y: number; w: number; h: number }; scaleFactor?: number } | undefined;
            if (existsSync(metaPath)) {
              try {
                const m = JSON.parse(readFileSync(metaPath, 'utf-8'));
                if (m && typeof m.x === 'number' && typeof m.w === 'number' && m.w > 0 && m.h > 0) {
                  external = {
                    rect: { x: m.x, y: m.y, w: m.w, h: m.h },
                    scaleFactor: typeof m.scaleFactor === 'number' ? m.scaleFactor : undefined,
                  };
                }
              } catch {
                /* 元数据坏掉就退化成居中裁剪图模式 */
              }
            }
            await startRegionScreenshot(buf, external);
            return;
          }
          console.warn('[Screenshot] native capture ok but temp png missing, falling back');
        } catch (err) {
          console.error('[Screenshot] read native capture png failed:', err);
        }
      }
      console.warn('[Screenshot] native capture unavailable/failed, falling back to built-in window');
    }
    await startRegionScreenshot();
  }

  // —— 启动预热：把 DWM「开场动画」消费在离屏、不可见的一次 show 上 ——
  // Win11 的窗口开场缩放动画只在窗口实例**首次** show 时播放一次，且无 API 可禁。
  // 应用启动后把截图窗壳在屏幕外 show 一次再隐藏，之后所有正式 reveal 都是「再次显示」，
  // 系统不再播动画 → 进入截图 = 整屏**瞬间**变暗（用户要的观感），而不是「窗口打开」动画。
  // 预热不加载 capture.html（避免启动期开销 / OCR 初始化），页面仍在每次截图前隐藏加载；
  // 若预热失败/被跳过，首次 reveal 会带一次开场动画（内容已就绪、随动画缩放进入，可接受降级）。
  app.whenReady().then(() => {
    setTimeout(() => {
      try {
        // 截图会话进行中 → 无需预热；已预热过（池非空）→ 跳过
        if (isStartingCaptureWindow) return;
        if (sessionWindows.some((s) => !s.win.isDestroyed())) return;
        // 预热「每屏一窗」：全部屏各一个壳，各自建在**自己的屏**上（DPR 环境从预热起就正确），
        // show 前 opacity 0 —— DWM 开场动画在完全不可见中播完，随后原地驻留
        const targets = screen.getAllDisplays();
        const { windows: session } = ensureSessionWindows(targets);
        for (const sw of session) {
          try {
            const b = { x: sw.display.bounds.x, y: sw.display.bounds.y, width: sw.display.size.width, height: sw.display.size.height };
            sw.win.setOpacity(0);
            sw.win.setBounds(b, false);
            sw.win.showInactive();
            sw.shownOnce = true;
            sw.win.setIgnoreMouseEvents(true);
            sw.win.setFocusable(false);
            // 页面常驻：预热期把 capture.html 一并加载好（后台一次性开销），会话零加载
            void ensureCapturePage(sw);
          } catch (e) {
            console.warn('[Screenshot] warm-up single window failed:', e);
          }
        }
        console.error(`[Screenshot] warm-up done, windows=${session.length}`);
        // opacity 0 常驻（不 hide）：hide() 会释放合成表面 → 正式会话 reveal 时表面重建 →
        // 首帧黑（闪黑根因）。各窗驻留各自屏 = DPR 恒定，任何屏触发零 DPI 切换零闪动。
      } catch (err) {
        console.error('[Screenshot] warm-up failed (first reveal may show open animation):', err);
        for (const sw of sessionWindows) {
          try { if (!sw.win.isDestroyed()) sw.win.destroy(); } catch { /* 忽略 */ }
        }
        sessionWindows = [];
      }
    }, 1200);
  });

  ipcMain.on('capture-sel-start', (_e, p: { x: number; y: number }) => {
    startSelectionDrag(_e.sender.id, p?.x || 0, p?.y || 0);
  });

  return {
    getCaptureWindow: () => captureWindow,
    getSessionWindows: () => sessionWindows.filter((s) => !s.win.isDestroyed()).map((s) => s.win),
    isCaptureSender: (senderId: number) =>
      sessionWindows.some((s) => !s.win.isDestroyed() && s.win.webContents.id === senderId),
    getWindowBySender: (senderId: number) =>
      sessionWindows.find((s) => !s.win.isDestroyed() && s.win.webContents.id === senderId)?.win ?? null,
    setOwnerWindow: (win: BrowserWindow | null) => {
      captureWindow = win;
      if (win) stopCursorSwitchPoll(); // 选区已开始(归属屏锁定),停止换屏跟随
    },
    /** 悬停模式:只作用于发起窗,且仅当它是活跃屏(非活跃屏的消息一律忽略——双驱动卡顿根源)。
     *  active = 该窗进入选区交互(归属屏锁定,停换屏跟随);idle = 恢复 forward 悬停。 */
    applyHoverMode: (senderId: number, mode: 'idle' | 'active') => {
      const sender = sessionWindows.find((s) => !s.win.isDestroyed() && s.win.webContents.id === senderId);
      if (!sender) return;
      if (activeSw && sender !== activeSw) return;
      if (mode === 'active') {
        captureWindow = sender.win;
        stopCursorSwitchPoll();
      }
      // idle/active 都保持完全可交互(悬停用真实鼠标事件);单窗时代最终态即如此
      try { sender.win.setIgnoreMouseEvents(false); } catch { /* ignore */ }
    },
    closeCaptureWindow,
    startRegionScreenshot,
    triggerScreenshot,
  };
}

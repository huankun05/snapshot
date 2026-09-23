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
import { capturePrimaryDisplayPng, captureAllDisplaysPng, captureDisplayRectPng, getVisibleWindows } from './screenshotHelper';
import { readScreenshotEngineConfig, readScreenshotMultiMonitorMode } from '../config/storeConfig';
import { ensureLocalOcrMtService } from '../services/localOcrMtService';
import { hideAllPinWindows, restoreAllPinWindows } from './capturePinWindow';
import { disableWindowTransition } from './dwmTransition';
import { isNativeCaptureEnabled, triggerNativeRegionCapture } from '../services/nativeCapture';

interface CreateCaptureWindowServiceOptions {
  getMainWindow: () => BrowserWindow | null;
  /** GDI 首帧直抓成功后主进程直喂智能选区像素帧（BGRA，DLL 通道度量对称无需换序）：
   *  省掉渲染端 33MB getImageData + IPC，帧在亮窗前就绪 → 选框与蒙版同时出现（2026-09-23） */
  onGdiFrame?: (bgra: Buffer, width: number, height: number) => void;
}

interface CaptureWindowService {
  getCaptureWindow: () => BrowserWindow | null;
  closeCaptureWindow: () => void;
  startRegionScreenshot: (
    externalImage?: Buffer,
    external?: { rect: { x: number; y: number; w: number; h: number }; scaleFactor?: number },
  ) => Promise<void>;
  triggerScreenshot: () => Promise<void>;
}

/**
 * 创建截图窗口服务
 * @description 初始化并返回截图窗口管理服务，支持区域截图功能
 * @param options - 服务配置选项，包含主窗口获取函数
 * @returns 截图窗口服务对象
 */
export function createCaptureWindowService(options: CreateCaptureWindowServiceOptions): CaptureWindowService {
  let captureWindow: BrowserWindow | null = null;
  let isStartingCaptureWindow = false;
  let captureWindowDwmDisabled = false;
  /** 截图窗是否已经 show 过：窗口复用后不再有 DWM 开场动画（预热/驻留模式窗口从未 hide）。 */
  let captureWindowShownOnce = false;
  /** 活跃会话标志（2026-09-23）：替代旧的「屏内位置 + opacity」几何推断 —— 原地驻留方案下
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
   * 页面常驻（2026-09-23，Snipaste 级速度的必要条件）：capture.html 只在首次（预热）加载，
   * 会话间靠 capture-clear 重置状态（该信号已清画布/全部浮层/文字编辑器/state/选区），
   * 不再每次 loadFile（实测 ~95ms，是触发→亮窗延迟仅剩的大头之一）。
   */
  let capturePageReady: Promise<void> | null = null;
  function ensureCapturePage(): Promise<void> {
    if (!captureWindow || captureWindow.isDestroyed()) return Promise.resolve();
    if (capturePageReady) return capturePageReady;
    capturePageReady = captureWindow
      .loadFile(getCaptureHtmlPath())
      .then(() => {
        console.error(`[Screenshot] capture page loaded (persistent) t=${Date.now()}`);
      })
      .catch((err) => {
        console.error('[Screenshot] capture html load error:', err);
        capturePageReady = null; // 允许下次会话重试
      });
    return capturePageReady;
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
  function closeCaptureWindow(): void {
    if (!captureWindow || captureWindow.isDestroyed()) return;
    captureSessionActive = false;
    try {
      captureWindow.webContents.send('capture-clear');
    } catch {
      /* 渲染进程已崩溃时忽略 */
    }
    captureWindow.setIgnoreMouseEvents(true);
    captureWindow.setFocusable(false);
    // 会话结束**不 hide()**：透明窗 hide() 会释放窗口合成表面，下次 show() 时 DWM/Chromium
    // 重建表面 → 首帧黑（用户实测的每次「闪黑」；CSDN/Electron 社区已证实 hide/show 闪烁根因）。
    // 2026-09-23 改为「**原地驻留** + opacity 0」（旧方案推到虚拟屏左侧外）：窗口停在最后一次
    // 会话的屏幕上，该屏的 devicePixelRatio 环境保持不变 —— 下次同屏截图零切换零闪动；
    // 换屏截图时在不可见期完成 DPI 切换（见 startRegionScreenshot 复用分支的 settle 等待），
    // 旧方案在 reveal 挪屏瞬间才吃 WM_DPICHANGED → 用户看到「进蒙版闪一下像在适应分辨率」。
    captureWindow.setOpacity(0);
    console.error(`[Screenshot] session parked in-place t=${Date.now()} (opacity 0, surface kept for reuse)`);
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
  function createCaptureWindowShell(bounds: Electron.Rectangle): void {
    captureWindow = new BrowserWindow({
      width: bounds.width,
      height: bounds.height,
      // 创建时先把窗口水平推到虚拟屏幕左侧外：
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

    /** Windows 会在 BrowserWindow 构造阶段将超大无边框窗口限制到单屏工作区，显式重设边界才能覆盖虚拟桌面。 */
    captureWindow.setBounds(bounds);
    captureWindow.setAlwaysOnTop(true, 'screen-saver');
    captureWindow.setIgnoreMouseEvents(true);

    // 双保险：尽量同步禁用 DWM 开窗过渡（对 Win10 有效；Win11 经常失效，微软已确认）。
    // 真正“无感进入”由「暗蒙版先行」时序保证（页面未加载时首帧即是蒙版，不存在空 surface），
    // 不依赖此 API。
    captureWindowDwmDisabled = disableWindowTransition(captureWindow);
    if (captureWindowDwmDisabled) {
      console.error('[Screenshot] DWM transition disable attempted (secondary; primary = mask-first reveal)');
    }

    // 崩溃留痕：截图编辑器渲染进程崩溃/无响应时打主进程日志（否则用户「一移动就退」无从排查）。
    captureWindow.webContents.on('render-process-gone', (_e, details) => {
      console.error('[Screenshot] capture renderer GONE:', details.reason, 'exitCode =', details.exitCode);
    });
    captureWindow.webContents.on('unresponsive', () => {
      console.error('[Screenshot] capture renderer UNRESPONSIVE');
    });
    // 渲染进程 console（capture.js 内部 console.error 不会自动上主进程 stdout）转发，
    // 崩溃前一刻的报错/警告都会出现在主进程日志里。
    // Electron 43：console-message 新式签名字段全挂事件对象上，且 level 是 **string**
    // （'verbose'|'info'|'warning'|'error'）——旧代码按 number 比较（level >= 2）恒为 false，
    // 导致 [cap] 打点从未转发（用户实测日志里一条都没有）。这里做 string/number 双兼容。
    captureWindow.webContents.on(
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
    captureWindow.on('close', () => {
      console.error('[Screenshot] capture window closing');
    });

    captureWindow.on('closed', () => {
      captureWindow = null;
      captureWindowShownOnce = false;
      captureSessionActive = false;
      capturePageReady = null;
      onCaptureWindowDismissed();
    });
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
    captureWindowShownOnce = true;
    console.error(
      `[Screenshot] reveal t=${Date.now()} pos=${bounds.x},${bounds.y} ${bounds.width}x${bounds.height} shownOnce=${captureWindowShownOnce}`,
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
      const pb = screen.dipToScreenRect(null, sessionRect);
      const gdi = pb ? captureDisplayRectPng(pb.x, pb.y, pb.width, pb.height) : null;
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
    external?: { rect: { x: number; y: number; w: number; h: number }; scaleFactor?: number },
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
      let capture: CaptureResult;
      let displayLayouts: DisplayLayout[] = [];
      let physicalScreen: { x: number; y: number; width: number; height: number } | null = null;
      // reveal 边界 = 窗口**实际尺寸**（内容按它布局），不是 capture.virtualScreen：
      // built-in 时两者相等（都是目标屏 bounds），external（外调图）时 = winBounds；
      // 若按 virtualScreen reveal 会把「内容已按窗口画好」的窗口 resize → 错位/闪。
      let revealBounds: Electron.Rectangle = { x: 0, y: 0, width: 1, height: 1 };

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
        if (external?.rect && external.rect.w > 0 && external.rect.h > 0) {
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
        const vs = getVirtualScreenBounds();
        // 多显示器范围（设置「截图 → 多显示器范围」）：仅光标屏（默认，2026-09-22 方案）或
        // 全部屏幕（旧多屏行为，蒙版铺满虚拟屏、可跨屏框选；2026-09-23 用户要求可配）
        const allScreens = readScreenshotMultiMonitorMode() === 'all';
        const targetDisplay = resolveTargetDisplay();
        const targetBounds: Electron.Rectangle = {
          x: targetDisplay.bounds.x,
          y: targetDisplay.bounds.y,
          width: targetDisplay.size.width,
          height: targetDisplay.size.height,
        };
        // 会话矩形 = 遮罩窗口 / 截图内容 / reveal 边界三者共用的范围
        const sessionBounds: Electron.Rectangle = allScreens
          ? { x: vs.x, y: vs.y, width: vs.width, height: vs.height }
          : targetBounds;
        // displays/physicalScreen 与图内容一致：光标屏模式只带目标屏一条（图只含目标屏，
        // 渲染端按 displays 逐条切片绘制，带多余屏会切出空区）；全部屏幕模式带全部
        const dl = getDisplayLayouts();
        if (allScreens) {
          displayLayouts = dl.displayLayouts;
          physicalScreen = dl.physicalScreen;
        } else {
          const targetLayout = dl.displayLayouts.find((l) => l.id === targetDisplay.id);
          displayLayouts = targetLayout ? [targetLayout] : [];
          physicalScreen = targetLayout
            ? {
                x: targetLayout.physicalBounds.x,
                y: targetLayout.physicalBounds.y,
                width: targetLayout.physicalBounds.width,
                height: targetLayout.physicalBounds.height,
              }
            : dl.physicalScreen;
        }

        // 复用上次会话**原地驻留**（opacity 0，不可见；无 DWM 开场动画、省建窗开销）；没有才新建。
        // 事件监听器等都绑在 webContents 上，复用时不能重复注册 → 只在新建分支里调 createCaptureWindowShell。
        // 换屏会话（驻留屏 ≠ 目标屏）：此刻窗口 opacity 0 不可见，先挪到目标屏把 WM_DPICHANGED
        // 的重排吃在暗处 —— 旧方案驻留屏外、reveal 挪屏瞬间才切 DPI，用户看到「进蒙版闪一下」
        // （2026-09-23 用户实测，混合缩放双屏 100%+150%）。settle 等待给 Chromium 完成 dpr 切换。
        let dprSettleWait: Promise<void> = Promise.resolve();
        if (!captureWindow || captureWindow.isDestroyed()) {
          createCaptureWindowShell(sessionBounds);
        } else {
          const cur = captureWindow.getBounds();
          const sameSpot = Math.abs(cur.x - sessionBounds.x) <= 2 && Math.abs(cur.y - sessionBounds.y) <= 2
            && Math.abs(cur.width - sessionBounds.width) <= 2 && Math.abs(cur.height - sessionBounds.height) <= 2;
          if (!sameSpot) {
            captureWindow.setBounds(sessionBounds, false);
            dprSettleWait = new Promise<void>((resolve) => setTimeout(resolve, 140));
            console.error(`[Screenshot] parked window moved to target display (invisible dpr transition, settle 140ms)`);
          }
        }
        // 页面加载在**不可见状态**下进行（opacity 0 屏外驻留或全新隐藏窗；从 t0 开始与主窗隐藏并行，
        // 压缩"按下→变暗"空档）：窗口不可见 → 不存在「可见时导航」的闪黑帧
        // （旧实现先 reveal 再 loadFile，导航瞬间合成器丢旧 surface → 用户实测的"闪黑"）。
        // 2026-09-23 页面常驻：通常已加载（预热时），此处直接复用；仅首次会话真正等待加载。
        const pageLoadPromise = ensureCapturePage();

        await waitForMainWindowHidden();

        // 换屏会话：等不可见期的 DPI 切换稳定后再截屏/绘制（同屏会话此 Promise 立即兑现）
        await dprSettleWait;

        // 截屏必须在暗蒙版亮起**之前**完成：desktopCapturer 截的是「当前屏幕合成结果」，
        // 窗口若已显示，蒙版会被截进图里 → 选区显示的是变暗的图，永远"恢复不了亮度"（用户实测反馈）。
        // 此刻窗口仍隐藏 → 截到的是干净桌面；等截完、页面也加载完，再亮窗。
        const c = await tryCaptureScreenshot(targetDisplay, allScreens, vs);
        await pageLoadPromise;
        console.error(
          `[Screenshot] builtin ready t=${Date.now()} pageLoaded + capture ${c ? `${c.imageBytes ? c.imageBytes.length + 'B png' : `raw ${c.rawFrame?.width}x${c.rawFrame?.height}`} (${c.captureSource})` : 'NULL'}`,
        );

        if (!c) {
          closeCaptureWindow();
          const mainWindow = options.getMainWindow();
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.show();
            mainWindow.setAlwaysOnTop(true, 'screen-saver');
          }
          return;
        }
        capture = c;
        revealBounds = sessionBounds;
        // GDI 直抓成功 → 主进程直接用原始位图喂像素帧（亮窗前就绪，选框与蒙版同时出现），
        // 渲染端据 framePrepared 跳过自己的 smart:frame
        if (c.rawFrame && options.onGdiFrame) {
          try {
            options.onGdiFrame(c.rawFrame.bgra, c.rawFrame.width, c.rawFrame.height);
          } catch (err) {
            console.warn('[Screenshot] onGdiFrame failed (pixel chain falls back to renderer frame):', err);
          }
        }
        // ⚠️ 不要在这里亮窗！窗口此刻仍是「屏外 + opacity 0」——保持不可见，
        // 让共享段的「send capture-image → 渲染端画完 → capture-ready」全程在**不可见期**完成，
        // 内容就绪后才一次性 reveal（见下）。若提前 reveal，亮起瞬间透出的是活的真实桌面
        // （页面只有 body 暗蒙版、还没截图），43ms 后静止截图才跳入 → 用户看到的「闪」。
      }

      const { imageBytes, captureSource, winBounds, virtualScreen, scaleFactor } = capture;

      // external（外调图）专属：built-in 分支已在上面的 else 完成「隐藏加载 → 截屏」，
      // 这里只为外调图补「隐藏加载」（同样**不 reveal** —— 与 built-in 一致，等共享段
      // 把内容画好、capture-ready 后再一次性亮窗，避免「亮起是活的桌面、43ms 后才跳成截图」的闪）。
      if (externalImage) {
        if (!captureWindow || captureWindow.isDestroyed()) {
          createCaptureWindowShell(winBounds);
        } else {
          // 复用 built-in 留下的驻留窗：摆到「winBounds 同尺寸的屏外位」（此刻 opacity 0，resize 不可见）。
          // 不直接放屏内 —— 屏内 opacity 0 窗会被 getVisibleWindows 计入 hover 数据；reveal 时再移回。
          captureWindow.setBounds(
            { x: winBounds.x - winBounds.width - 200, y: winBounds.y, width: winBounds.width, height: winBounds.height },
            false,
          );
        }
        await ensureCapturePage();
        revealBounds = winBounds;
      }

      /**
       * 【核心时序】内容先画好 → 帧提交合成器 → 再一次性亮窗。
       *
       * 窗口此刻仍是「屏外 + opacity 0」（built-in 截屏后未 reveal、external 加载后未 reveal），
       * 对用户完全不可见：
       *   1. send capture-image → 渲染端解码 + 绘制（日志实测 16~43ms，全程不可见）
       *   2. 渲染端双 rAF 确认帧已提交合成器后才发 capture-ready
       *   3. 收到 ready 才 reveal：亮起瞬间 = 「暗化截图 + 蒙版」完整画面 ——
       *      没有「活的真实桌面 → 静止截图」的中间帧 → 无闪。
       *
       * 旧时序是「先 reveal 亮纯色蒙版 → 43ms 后截图跳入」：亮起的头 43ms 窗口只有
       * body 半透明暗、底下透出**活的桌面**（含鼠标/动画），截图随后替换 —— 内容不同
       * 的两帧相接就是用户实测的「闪」。现改为内容在暗处就绪、亮起即终态，从根上消除。
       *
       * 兜底 800ms：渲染进程万一没发 capture-ready，也要把窗口亮出来并放开交互，
       * 否则会变成「按了截图却点不动」。
       */
      let sendAt = 0;
      const contentReadyPromise = new Promise<void>((resolve) => {
        const target = captureWindow;
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
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

      if (captureWindow && !captureWindow.isDestroyed()) {
        sendAt = Date.now();
        console.error(
          `[Screenshot] send capture-image t=${sendAt} ${imageBytes ? `bytes=${imageBytes.length}` : 'raw-bgra'} src=${captureSource} (window parked/invisible)`,
        );
        // 光标在虚拟屏上的逻辑坐标 → 截图窗 CSS 坐标（用于打开即智能选中光标下窗口）
        let cursorInCapture: { x: number; y: number } | null = null;
        try {
          const cur = screen.getCursorScreenPoint();
          cursorInCapture = {
            x: Math.round(cur.x - virtualScreen.x),
            y: Math.round(cur.y - virtualScreen.y),
          };
        } catch { /* ignore */ }

        captureWindow.webContents.send('capture-image', {
          imageBytes,
          rawFrame: capture.rawFrame ?? null,
          virtualScreen,
          displays: captureSource === 'plugin' ? displayLayouts : [],
          physicalScreen: captureSource === 'plugin' ? physicalScreen : null,
          scaleFactor,
          captureSource,
          framePrepared: Boolean(capture.rawFrame),
          visibleWindows: externalImage ? [] : getVisibleWindows(),
          externalCapture: Boolean(externalImage),
          autoCopy: pendingAutoCopy,
          cursor: cursorInCapture,
          cropRect: external && external.rect && external.rect.w > 0 && external.rect.h > 0
            ? { x: external.rect.x, y: external.rect.y, w: external.rect.w, h: external.rect.h }
            : null,
        });
        pendingAutoCopy = false;
        // 渲染端画完（帧已提交）之前一直保持不可见
        await contentReadyPromise;
      }

      // 内容已就绪 → 一次性亮窗（首帧 = 完整暗化画面）+ 交付交互
      if (captureWindow && !captureWindow.isDestroyed()) {
        revealMaskWindow(captureWindow, revealBounds);
        console.error(
          `[Screenshot] capture editor shown, mode=${captureSource} window=${winBounds.width}x${winBounds.height}`,
        );
        finalizeCaptureWindow(captureWindow);
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
        // 截图会话进行中 / 窗口已可见 / 已 show 过 → 无需预热
        if (isStartingCaptureWindow) return;
        if (captureWindow && !captureWindow.isDestroyed() && (captureWindow.isVisible() || captureWindowShownOnce)) return;
        // 预热壳按**主屏**尺寸建（原地驻留方案：驻留位即主屏，DPR 环境从预热起就正确）
        const primary = screen.getPrimaryDisplay();
        const primaryBounds = { x: primary.bounds.x, y: primary.bounds.y, width: primary.size.width, height: primary.size.height };
        if (!captureWindow || captureWindow.isDestroyed()) {
          createCaptureWindowShell(primaryBounds);
        }
        // show 前先压到 opacity 0：DWM 开场动画在完全不可见中播完（旧方案移到屏外 show 是因为
        // show 时 opacity 还是 1，会真亮 450ms）。开窗动画消费后窗口就地驻留在主屏位置。
        captureWindow!.setOpacity(0);
        captureWindow!.setBounds(primaryBounds, false);
        captureWindow!.showInactive();
        captureWindowShownOnce = true; // 已 show 过一次 → 后续正式 reveal 不再有 DWM 开场动画
        captureWindow!.setIgnoreMouseEvents(true);
        captureWindow!.setFocusable(false);
        // 页面常驻：预热期把 capture.html 一并加载好（后台一次性 ~100ms 开销），
        // 之后所有会话零加载直接进截图（2026-09-23，替换"每次会话 loadFile"旧方案）
        ensureCapturePage();
        // opacity 0 常驻（不 hide）：hide() 会释放合成表面 → 正式会话 reveal 时表面重建 →
        // 首帧黑（闪黑根因）。驻留在主屏 = 预热后 DPR 即主屏，首屏会话零 DPI 切换零闪动。
      } catch (err) {
        console.error('[Screenshot] warm-up failed (first reveal may show open animation):', err);
        try {
          if (captureWindow && !captureWindow.isDestroyed()) captureWindow.destroy();
        } catch {
          /* 忽略 */
        }
        captureWindow = null;
        captureWindowShownOnce = false;
      }
    }, 1200);
  });

  return {
    getCaptureWindow: () => captureWindow,
    closeCaptureWindow,
    startRegionScreenshot,
    triggerScreenshot,
  };
}

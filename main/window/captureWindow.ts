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
 *
 * @description 阶段3「单窗·全虚拟屏」重构（2026-09-24）：
 *   - sessionWindows：仅一扇窗，覆盖所有屏幕的 DIP 外接矩形（跨屏外接框 vbox）。
 *   - captureVirtualScreenComposite 抓**一张**全虚拟物理 BGRA 作背景（GDI 失败回退
 *     desktopCapturer 逐屏 PNG → nativeImage.toBitmap 拼进虚拟外接缓冲）。
 *   - 像素帧 feed onGdiFrame 一次；capture-image multiWindow:false → 渲染端走本地快速路径，
 *     跨屏拖动/裁剪天然成立。删除了多窗（startCursorSwitchPoll / 跨屏拖选 / activeSw 等）机制。
 *   - 会话结束 closeCaptureWindow 单窗 capture-clear + setIgnoreMouseEvents(true) +
 *     setFocusable(false) + setOpacity(0)「原地驻留」（不 hide，合成表面保留 → 零黑帧零开场动画）。
 *   - 预热改为仅建/预热一扇虚拟窗。
 */
import { app, BrowserWindow, desktopCapturer, ipcMain, nativeImage, screen } from 'electron';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { is } from '@electron-toolkit/utils';
import { captureVirtualScreenComposite, getVisibleWindows } from './screenshotHelper';
import { captureVirtualScreenCompositeAsync } from '../services/gdiGrabWorker';
import { readScreenshotEngineConfig } from '../config/storeConfig';
import { ensureLocalOcrMtService } from '../services/localOcrMtService';
import { hideAllPinWindows, restoreAllPinWindows } from './capturePinWindow';
import { disableWindowTransition } from './dwmTransition';
import { isNativeCaptureEnabled, triggerNativeRegionCapture } from '../services/nativeCapture';

interface CreateCaptureWindowServiceOptions {
  getMainWindow: () => BrowserWindow | null;
  /** GDI 首帧直抓成功后主进程直喂智能选区像素帧（BGRA，DLL 通道度量对称无需换序）：
   *  省掉渲染端 33MB getImageData + IPC，帧在亮窗前就绪 → 选框与蒙版同时出现（2026-09-23）。
   *  阶段1多窗：触发时仅喂「光标所在屏」那一帧（单帧签名不变，像素链只需光标屏）。 */
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
  /** 会话窗口组（阶段1「每屏一窗」）：每个窗口只服务自己那块屏（原生缩放，永不跨屏 —
   *  永不吃别的屏的 DPI 变更 = 根治混合缩放变形/发虚）。驻留时原地 opacity 0；预热期为所有屏各建一个。 */
  interface SessionWindow {
    win: BrowserWindow;
    display: Electron.Display;
    pageReady: Promise<void> | null;
    shownOnce: boolean;
    /** 本屏的原始抓帧(阶段2+跨屏裁剪合成用，阶段1 亦存入供逐屏下发) */
    frame?: { bgra: Buffer; width: number; height: number };
  }
  let sessionWindows: SessionWindow[] = [];
  /** 归属窗（光标所在屏的那扇，作为旧代码路径的「主窗别名」；getCaptureWindow 返回值） */
  let captureWindow: BrowserWindow | null = null;
  let isStartingCaptureWindow = false;
  let captureWindowDwmDisabled = false;
  /** 活跃会话标志（2026-09-23）：替代旧的「屏内位置 + opacity」几何推断 —— 原地驻留方案下
   *  窗口平时就停在真实屏幕上，几何判断失效。预热/驻留不置位，仅真实会话置位。 */
  let captureSessionActive = false;
  /** 「截图并复制」热键：框选完成后自动复制并退出，不进标注工具栏 */
  let pendingAutoCopy = false;

  /** 单窗「放大 DIP 外接框」= 全虚拟物理外接框 ÷ 主屏缩放率（2026-09-25 修混合 DPI 预览缩放）。
   * 窗口 dpr = 主屏缩放率（实测 1.25），backing = 窗口 CSS × dpr = 物理帧 1:1（如 5120×1440）。
   * 旧 vbox（各屏 DIP 外接框 -1707,0,3755,1152）→ backing=W×dpr=4694×1440，只覆盖 4694/5120 物理宽，
   * DWM 按 1:1 摆布时副屏(150%)内容被按 1.25×/1.5× = 0.833× 缩放 → 变小发虚 + 蒙版边缘露桌面。
   * 放大后窗口物理覆盖恰为 [-2560,2560]×[0,1440]：两屏各自 1:1，且「窗口原点==帧原点」恢复成立
   * （smart:pixel-at 的 x*sf 公式、smart:at-point 的 vsX 换算、裁剪 DIP→物理 全部自动正确）。 */
  function computeAllDisplaysWinBounds(): Electron.Rectangle {
    const ds = screen.getAllDisplays();
    const sf = screen.getPrimaryDisplay().scaleFactor || 1;
    const phys = ds.map((d) => screen.dipToScreenRect(null, d.bounds) ?? d.bounds);
    const x0 = Math.min(...phys.map((p) => p.x));
    const y0 = Math.min(...phys.map((p) => p.y));
    const x1 = Math.max(...phys.map((p) => p.x + p.width));
    const y1 = Math.max(...phys.map((p) => p.y + p.height));
    return {
      x: Math.round(x0 / sf),
      y: Math.round(y0 / sf),
      width: Math.round((x1 - x0) / sf),
      height: Math.round((y1 - y0) / sf),
    };
  }

  /**
   * 解析 capture.html 绝对路径。
   * ⚠️ 2026-09-25 修：旧实现 find(existsSync) ?? candidates[0] 在 cwd=app 目录启动时，
   *   若候选全部判不存在会兜底返回 cwd/resources/capture.html（不存在）→ ERR_FILE_NOT_FOUND
   *   → 页面加载失败、渲染端无 JS → capture-image 消息丢失 → 800ms 超时「按 F1 卡死」。
   *   改为 __dirname（打包后 = app/dist → ../../../resources = 工作区 resources）优先，最可靠。
   */
  function getCaptureHtmlPath(): string {
    if (is.dev) {
      const cwd = process.cwd();
      const appDir = app.getAppPath();
      const candidates = [
        // __dirname 在 esbuild 产物 = app/dist → ../../../resources = 工作区 resources（不依赖 cwd / 启动目录）
        join(__dirname, '../../../resources/capture.html'),
        join(appDir, 'resources', 'capture.html'),
        join(cwd, 'resources', 'capture.html'),
      ];
      const hit = candidates.find((c) => existsSync(c));
      const picked = hit ?? candidates[0];
      if (!hit) {
        // 全部候选缺失（部署结构异常）→ 打全量诊断，便于一次定位
        console.error(
          `[Screenshot] capture.html NOT FOUND. __dirname=${__dirname} cwd=${cwd} appPath=${appDir} ` +
            candidates.map((c) => `${c}:${existsSync(c)}`).join(' | '),
        );
      }
      return picked;
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
   * 结束一次截图会话：**原地驻留而不销毁、不 hide**（各窗停在自己屏，opacity 0）。
   *
   * 复用是消除 Win11 DWM 开场动画唯一可靠的手段 —— 开场动画只在窗口首次 show 时播放，
   * 复用后再 show 不再播放。页面状态仍靠下次截图前重新 loadFile 保证干净（等价销毁重建，
   * 但省掉建窗/销毁开销与开场动画）。退出不受影响：托盘菜单 / IPC / 热键都是直接 app.quit()。
   *
   * 驻留前先让渲染进程清掉画布与浮层：否则下次 show 的瞬间会闪出**上一张截图**。
   * 单窗停在外接矩形上；不 hide() → 合成表面保留 → 下次 reveal 无黑帧无开场动画。
   */
  function closeCaptureWindow(): void {
    captureSessionActive = false;
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
        // 原地驻留 + opacity 0（不 hide）：合成表面保留 → 下次 reveal 无黑帧无开场动画
        sw.win.setOpacity(0);
      } catch {
        /* 单窗失败不拖累其它 */
      }
    }
    captureWindow = null;
    console.error(`[Screenshot] session parked in-place t=${Date.now()} (${sessionWindows.filter((s) => !s.win.isDestroyed()).length} windows, opacity 0)`);
    onCaptureWindowDismissed();
  }

  /**
   * 创建截图窗口壳（先不可见）：构造 + 边界 + 置顶 + 忽略鼠标 + closed 恢复回调。
   * 窗口创建尽量**提前**（与截屏并行）：desktopCapturer 回退首帧最慢可达数百 ms，
   * 若等截屏完成再建窗 + loadFile，就是"按下热键 → 干等 → 突然弹窗"的「打开慢」来源。
   * 单窗壳：bounds 为所有屏幕的 DIP 外接矩形（跨屏，不做任何缩放换算，浏览器直绘 1:1）。
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
   * 确保唯一「全虚拟屏」窗：复用池内未销毁驻留窗（边界与 bounds 匹配 ±2px 直接用；
   * 不匹配则挪到目标 bounds —— opacity 0 不可见期完成任何尺寸/DPI 变化）；否则新建壳。
   * built-in / external / 预热三处共用的唯一一扇窗。
   */
  function ensureVirtualCaptureWindow(bounds: Electron.Rectangle): SessionWindow {
    const existing = sessionWindows.find((s) => !s.win.isDestroyed());
    if (existing) {
      const cur = existing.win.getBounds();
      const sameSpot = Math.abs(cur.x - bounds.x) <= 2 && Math.abs(cur.y - bounds.y) <= 2
        && Math.abs(cur.width - bounds.width) <= 2 && Math.abs(cur.height - bounds.height) <= 2;
      if (!sameSpot) {
        existing.win.setBounds(bounds, false);
        console.error(`[Screenshot] virtual window resized to ${bounds.width}x${bounds.height} (invisible)`);
      }
      return existing;
    }
    const primary = screen.getPrimaryDisplay();
    return createCaptureWindowShell(primary, bounds);
  }

  /**
   * 显示截图窗（Win10/Win11 通用）。
   *
   * 实测结论（2026-09-03，用户跑应用）：
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
      `[Screenshot] reveal t=${Date.now()} pos=${bounds.x},${bounds.y} ${bounds.width}x${bounds.height} shownOnce=${sw ? sw.shownOnce : false}`,
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

  async function startRegionScreenshot(
    externalImage?: Buffer,
    external?: { rect: { x: number; y: number; w: number; h: number }; scaleFactor?: number },
  ): Promise<void> {
    // 会话进行中（窗口正显示）或正在启动 → 忽略重复触发（防热键连按/按钮双击）。
    // 复用模式下会话结束是「原地驻留 + opacity 0」而非销毁，窗口一直 visible，
    // 所以仅凭 isVisible() 会把第二次截图误判成重复触发 → 用活跃会话标志判断。
    if (isStartingCaptureWindow) return;
    if (captureSessionActive) return;
    isStartingCaptureWindow = true;
    console.error(`[Screenshot] trigger t=${Date.now()} (hotkey → this line = 注册回调+防重入判断开销)`);

    // 预热本地 OCR/翻译服务（后台 fire-and-forget，不阻塞截图流程）：
    // 用户框选/标注期间 PaddleOCR 模型在后台加载，点 OCR/翻译时已就绪，避免首调等 ~11s。
    // 延迟到 1.2s 再拉起：Python 冷启动/模型导入瞬间 CPU 冲高，太早启动会挤占
    // 「全屏 PNG 解码 + 首帧合成」关键路径——这是"打开截图变慢"的主因之一。
    // 2026-09-28 空闲探测化：ensure 内部先 /health 探测——服务已常驻时是毫秒级 no-op，
    // 空闲回收后再预热重建；仍然每次触发调用（幂等），GB 级侧车由 10 分钟空闲回收兜底。
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
      // —— external（外调图）路径：单窗会话（主屏），带选区 rect 进编辑器 ——
      let externalCapture: {
        imageBytes: Buffer;
        captureSource: 'external';
        winBounds: { x: number; y: number; width: number; height: number };
        virtualScreen: { x: number; y: number; width: number; height: number };
        scaleFactor: number;
      } | null = null;

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
          externalCapture = {
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
          externalCapture = {
            imageBytes: externalImage,
            captureSource: 'external',
            winBounds: { x, y, width: cssW, height: cssH },
            virtualScreen: { x, y, width: cssW, height: cssH },
            scaleFactor: sf,
          };
        }
      }

      // external 路径与 built-in 路径共用的一扇全虚拟屏窗
      let session: SessionWindow[] = [];

      if (externalCapture) {
        // external 路径：确保一窗并摆到载荷边界
        const extWin = ensureVirtualCaptureWindow({ ...externalCapture.winBounds });
        session = [extWin];
        captureWindow = extWin.win;
        // 不可见期把窗摆到载荷边界（external 载荷的 winBounds 即 reveal 边界）
        extWin.win.setBounds({ ...externalCapture.winBounds }, false);
        if (extWin.win.isDestroyed()) return;
        await ensureCapturePage(extWin);
        await waitForMainWindowHidden();
      } else {
        // ── built-in「单窗·全虚拟屏」流程（2026-09-24 重构）────
        // 一扇窗覆盖所有屏幕的 DIP 外接矩形；抓**一张**全虚拟物理 BGRA 作背景喂渲染端一次，
        // multiWindow:false → 渲染端走本地快速路径，跨屏拖动/裁剪天然成立（根治多窗卡死）。
        const displays = screen.getAllDisplays();
        const winBox = computeAllDisplaysWinBounds();
        const layouts = displays.map((d) => ({ physicalBounds: screen.dipToScreenRect(null, d.bounds) }));
        const originX = Math.min(...layouts.map((l) => l.physicalBounds.x));
        const originY = Math.min(...layouts.map((l) => l.physicalBounds.y));
        const vbp = {
          x: originX,
          y: originY,
          width: Math.max(...layouts.map((l) => l.physicalBounds.x + l.physicalBounds.width)) - originX,
          height: Math.max(...layouts.map((l) => l.physicalBounds.y + l.physicalBounds.height)) - originY,
        };

        // 抓帧：GDI 全虚拟合成优先，失败回退 desktopCapturer 逐屏 PNG 拼进 vbp 缓冲
        const enginePref = readScreenshotEngineConfig();
        let frame: { bgra: Buffer; width: number; height: number } | null = null;
        if (enginePref !== 'js') {
          // 2026-09-28 worker 化：BitBlt+行拷贝（双屏 68-100ms）不再堵主进程事件循环
          const comp = await captureVirtualScreenCompositeAsync(layouts);
          if (comp) frame = comp;
        }
        if (!frame) {
          // JS 回退：逐屏 desktopCapturer PNG → nativeImage.toBitmap 取每屏 BGRA 手工拼进 vbp
          try {
            const parts: Array<{ px: number; py: number; pw: number; ph: number; bgra: Buffer }> = [];
            for (const d of displays) {
              const sf = d.scaleFactor || 1;
              const sources = await desktopCapturer.getSources({
                types: ['screen'],
                thumbnailSize: { width: Math.round(d.size.width * sf), height: Math.round(d.size.height * sf) },
              });
              const src = sources.find((s) => s.display_id === String(d.id)) ?? sources[0];
              if (!src) continue;
              const bmp = nativeImage.createFromBuffer(src.thumbnail.toPNG()).toBitmap();
              const pb = screen.dipToScreenRect(null, d.bounds);
              if (!pb) continue;
              parts.push({ px: pb.x - vbp.x, py: pb.y - vbp.y, pw: pb.width, ph: pb.height, bgra: bmp });
            }
            if (parts.length > 0) {
              const out = Buffer.alloc(vbp.width * vbp.height * 4, 0xff);
              for (const p of parts) {
                if (p.pw < 1 || p.ph < 1 || p.bgra.length < p.pw * p.ph * 4) continue;
                for (let row = 0; row < p.ph; row++) {
                  p.bgra.copy(out, ((p.py + row) * vbp.width + p.px) * 4, row * p.pw * 4, (row + 1) * p.pw * 4);
                }
              }
              frame = { bgra: out, width: vbp.width, height: vbp.height };
            }
          } catch (err) {
            console.warn('[Screenshot] desktopCapturer composite fallback failed:', err);
          }
        }
        if (!frame) {
          closeCaptureWindow();
          const mainWindow = options.getMainWindow();
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.show();
            mainWindow.setAlwaysOnTop(true, 'screen-saver');
          }
          return;
        }

        // 会话窗：唯一一扇全虚拟屏窗，挂帧
        const sw = ensureVirtualCaptureWindow(winBox);
        sw.frame = frame;
        const singleWin = sw.win;
        captureWindow = singleWin;

        // 像素帧喂主进程像素链（一次）
        if (options.onGdiFrame) {
          try {
            options.onGdiFrame(frame.bgra, frame.width, frame.height);
          } catch (err) {
            console.warn('[Screenshot] onGdiFrame failed (pixel chain falls back to renderer frame):', err);
          }
        }

        await waitForMainWindowHidden();
        // 页面常驻：预热已加载，这里确保兜底重试
        await ensureCapturePage(sw);

        // 光标 DIP → 窗口内坐标（钳制）
        let cursorInCapture: { x: number; y: number } | null = null;
        try {
          const cur = screen.getCursorScreenPoint();
          cursorInCapture = {
            x: Math.max(0, Math.min(Math.round(cur.x - winBox.x), winBox.width - 1)),
            y: Math.max(0, Math.min(Math.round(cur.y - winBox.y), winBox.height - 1)),
          };
        } catch { /* ignore */ }

        console.error(
          `[Screenshot] send capture-image t=${Date.now()} raw=${frame.width}x${frame.height} src=${enginePref !== 'js' ? 'plugin' : 'js'} multi=false`,
        );
        // virtualScreen.x/y = 窗口 CSS 原点（= 全虚拟物理外接框 ÷ 主屏 dpr，-2048）。
        // 渲染端 css + vsX 即「窗口 CSS → 全虚拟物理」的唯一平移量，UIA 与像素链共用
        // （phys = (css+vsX)×窗口dpr）。各屏 dip min 原点（-1707）对窗口 CSS 不是平移关系
        // （两屏 sf 不同），故不再下发 xdip/ydip——那是 DIP 中转路线的残留（2026-09-30）。
        singleWin.webContents.send('capture-image', {
          imageBytes: null,
          rawFrame: frame,
          virtualScreen: { x: winBox.x, y: winBox.y, width: winBox.width, height: winBox.height },
          displays: displays.map((d, i) => ({
            id: d.id,
            bounds: d.bounds,
            physicalBounds: layouts[i]?.physicalBounds ?? null,
            scaleFactor: d.scaleFactor || 1,
            primary: d.id === screen.getPrimaryDisplay().id,
          })),
          physicalScreen: vbp,
          scaleFactor: 1,
          captureSource: enginePref !== 'js' ? 'plugin' : 'js',
          framePrepared: true,
          coordSpace: 'global',
          visibleWindows: getVisibleWindows(),
          externalCapture: false,
          autoCopy: pendingAutoCopy,
          cursor: cursorInCapture,
          cropRect: null,
          multiWindow: false,
        });
        pendingAutoCopy = false;

        // 等唯一窗 capture-ready（800ms 兜底）+ 一次性亮窗
        await new Promise<void>((resolve) => {
          let done = false;
          const finish = () => { if (done) return; done = true; resolve(); };
          const timer = setTimeout(() => {
            console.error('[Screenshot] capture-ready TIMEOUT after 800ms');
            finish();
          }, 800);
          ipcMain.once('capture-ready', (event: Electron.IpcMainEvent) => {
            if (!singleWin.isDestroyed() && event.sender === singleWin.webContents) {
              clearTimeout(timer);
              console.error(`[Screenshot] capture-ready ok t=${Date.now()}`);
              finish();
            }
          });
        });

        revealMaskWindow(singleWin, { x: winBox.x, y: winBox.y, width: winBox.width, height: winBox.height });
        captureSessionActive = true;
        finalizeCaptureWindow(singleWin);
        console.error(`[Screenshot] capture editor shown, mode=single window=${winBox.width}x${winBox.height} t=${Date.now()}`);
      }

      // —— external 路径：内容已就绪 → 一次性亮窗（同「先画好 → 再亮窗」时序）——
      if (externalCapture) {
        const extWin = session[0] ?? null;
        if (!extWin || extWin.win.isDestroyed()) return;
        const target = extWin.win;
        let sendAt = 0;
        const contentReadyPromise = new Promise<void>((resolve) => {
          let settled2 = false;
          const finish = () => {
            if (settled2) return;
            settled2 = true;
            ipcMain.removeListener('capture-ready', onReady);
            clearTimeout(timer);
            resolve();
          };
          const onReady = (event: Electron.IpcMainEvent) => {
            if (!target.isDestroyed() && event.sender === target.webContents) {
              console.error(`[Screenshot] renderer capture-ready t=${Date.now()} (${Date.now() - sendAt}ms after send)`);
              finish();
            }
          };
          const timer = setTimeout(() => {
            console.error(`[Screenshot] capture-ready TIMEOUT after 800ms (renderer never replied)`);
            finish();
          }, 800);
          ipcMain.on('capture-ready', onReady);
        });

        sendAt = Date.now();
        console.error(
          `[Screenshot] send capture-image t=${sendAt} bytes=${externalCapture.imageBytes.length} src=external (window parked/invisible)`,
        );
        let cursorInCapture: { x: number; y: number } | null = null;
        try {
          const cur = screen.getCursorScreenPoint();
          cursorInCapture = {
            x: Math.round(cur.x - externalCapture.virtualScreen.x),
            y: Math.round(cur.y - externalCapture.virtualScreen.y),
          };
        } catch { /* ignore */ }

        target.webContents.send('capture-image', {
          imageBytes: externalCapture.imageBytes,
          rawFrame: null,
          virtualScreen: externalCapture.virtualScreen,
          displays: [],
          physicalScreen: null,
          scaleFactor: externalCapture.scaleFactor,
          captureSource: 'external',
          framePrepared: false,
          coordSpace: 'global',
          visibleWindows: [],
          externalCapture: true,
          autoCopy: pendingAutoCopy,
          cursor: cursorInCapture,
          cropRect: external && external.rect && external.rect.w > 0 && external.rect.h > 0
            ? { x: external.rect.x, y: external.rect.y, w: external.rect.w, h: external.rect.h }
            : null,
        });
        pendingAutoCopy = false;
        await contentReadyPromise;
        if (!extWin.win.isDestroyed()) {
          revealMaskWindow(extWin.win, externalCapture.winBounds);
          console.error(
            `[Screenshot] capture editor shown, mode=external window=${externalCapture.winBounds.width}x${externalCapture.winBounds.height}`,
          );
          finalizeCaptureWindow(extWin.win);
        }
      }
    } catch (err) {
      console.error('[Screenshot] start error:', err);
      captureSessionActive = false;
      for (const sw of sessionWindows) {
        try { if (!sw.win.isDestroyed()) sw.win.destroy(); } catch { /* ignore */ }
      }
      sessionWindows = [];
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
  // 应用启动后把截图窗壳全屏外 show 一次再隐藏，之后所有正式 reveal 都是「再次显示」，
  // 系统不再播动画 → 进入截图 = 整屏**瞬间**变暗（用户要的观感），而不是「窗口打开」动画。
  // 预热「单窗·全虚拟屏」：仅建/预热一扇跨屏外接矩形窗，show 前 opacity 0 —— DWM 开场动画
  // 在完全不可见中播完，随后原地驻留。
  app.whenReady().then(() => {
    setTimeout(() => {
      try {
        // 截图会话进行中 → 无需预热；已预热过（池非空）→ 跳过
        if (isStartingCaptureWindow) return;
        if (sessionWindows.some((s) => !s.win.isDestroyed())) return;
        const winBox = computeAllDisplaysWinBounds();
        const sw = ensureVirtualCaptureWindow(winBox);
        if (sw.win.isDestroyed()) return;
        try {
          sw.win.setOpacity(0);
          sw.win.setBounds(winBox, false);
          sw.win.showInactive();
          sw.shownOnce = true;
          sw.win.setIgnoreMouseEvents(true);
          sw.win.setFocusable(false);
          // 页面常驻：预热期把 capture.html 一并加载好（后台一次性开销），会话零加载
          void ensureCapturePage(sw);
        } catch (e) {
          console.warn('[Screenshot] warm-up single window failed:', e);
        }
        console.error('[Screenshot] warm-up done (single virtual window)');
        // opacity 0 常驻（不 hide）：hide() 会释放合成表面 → 正式会话 reveal 时表面重建 →
        // 首帧黑（闪黑根因）。单窗驻留全虚拟外接矩形 = 任意屏触发零 DPI 切换零闪动。
      } catch (err) {
        console.error('[Screenshot] warm-up failed (first reveal may show open animation):', err);
        for (const sw of sessionWindows) {
          try { if (!sw.win.isDestroyed()) sw.win.destroy(); } catch { /* 忽略 */ }
        }
        sessionWindows = [];
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
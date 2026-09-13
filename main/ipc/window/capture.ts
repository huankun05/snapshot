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
 * @file capture.ts
 * @description 截图相关 IPC 处理模块
 * @description 处理截图、保存和复制到剪贴板等 IPC 请求
 * @author 鸡哥
 */

import { app, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain, nativeImage, screen, BrowserWindow } from 'electron';
import { join } from 'path';
import { mkdirSync, writeFileSync } from 'fs';

/* ── koffi FFI 懒加载（长截图焦点让渡 + 方案B PostMessage 滚轮）── */
type Win32FocusApi = {
  WindowFromPoint: (p: { x: number; y: number }) => number | bigint;
  SetForegroundWindow: (hWnd: number | bigint) => number;
  GetAncestor: (hWnd: number | bigint, gaFlags: number) => number | bigint;
  GetForegroundWindow: () => number | bigint;
  GetWindowThreadProcessId: (hWnd: number | bigint, lpdwProcessId: any) => number;
  GetCurrentThreadId: () => number;
  AttachThreadInput: (idAttach: number, idAttachTo: number, fAttach: number) => number;
  /* 方案B（r49）：PostMessage WM_MOUSEWHEEL 直达目标窗口 */
  FindWindowExW: (hwndParent: number | bigint, hwndChildAfter: number | bigint, cls: Buffer | null, win: Buffer | null) => number | bigint;
  GetClassNameW: (hWnd: number | bigint, buf: Buffer, max: number) => number;
  PostMessageW: (hWnd: number | bigint, msg: number, wParam: number | bigint, lParam: number | bigint) => number;
  IsWindow: (hWnd: number | bigint) => number;
};
let cachedWin32Focus: Win32FocusApi | null | undefined;
function getWin32FocusApi(): Win32FocusApi | null {
  if (cachedWin32Focus !== undefined) return cachedWin32Focus;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    // GetCurrentThreadId 属于 kernel32.dll（user32 不导出），从 user32 加载会抛
    // "Cannot find function" → 整段 catch 把 api 置 null → 长截图焦点让渡永久失效。
    const kernel32 = koffi.load('kernel32.dll');
    // 注册具名 struct（供下方 func 签名按名 'POINT p' 引用），无需另存引用
    koffi.struct('POINT', { x: 'long', y: 'long' });
    // HWND 一律以 uint64_t 收发：koffi 2.x 对 void* 返回不可用的 External 对象，
    // 旧代码 BigInt(hRoot) 会抛 "Cannot convert object to primitive value"。uint64_t 返回 number/BigInt 稳定可比。
    cachedWin32Focus = {
      WindowFromPoint: user32.func('uint64_t WindowFromPoint(POINT p)'),
      SetForegroundWindow: user32.func('int SetForegroundWindow(uint64_t hWnd)'),
      GetAncestor: user32.func('uint64_t GetAncestor(uint64_t hWnd, uint32_t gaFlags)'),
      GetForegroundWindow: user32.func('uint64_t GetForegroundWindow()'),
      GetWindowThreadProcessId: user32.func('uint32_t GetWindowThreadProcessId(uint64_t hWnd, void* lpdwProcessId)'),
      GetCurrentThreadId: kernel32.func('uint32_t GetCurrentThreadId()'),
      AttachThreadInput: user32.func('int AttachThreadInput(uint32_t idAttach, uint32_t idAttachTo, int fAttach)'),
      FindWindowExW: user32.func('uint64_t FindWindowExW(uint64_t hwndParent, uint64_t hwndChildAfter, const char16_t *lpszClass, const char16_t *lpszWindow)'),
      GetClassNameW: user32.func('int GetClassNameW(uint64_t hWnd, uint8_t *lpClassName, int32_t nMaxCount)'),
      PostMessageW: user32.func('int PostMessageW(uint64_t hWnd, uint32_t Msg, uintptr_t wParam, intptr_t lParam)'),
      IsWindow: user32.func('int IsWindow(uint64_t hWnd)'),
    };
  } catch (err) {
    console.error('[LS-MAIN] koffi user32 load failed:', (err as Error)?.message);
    cachedWin32Focus = null;
  }
  return cachedWin32Focus;
}

/** 把系统前台焦点让给选区正下方的窗口（洞内滚轮需要底层窗口有焦点）。
 * 截图窗本身 click-through + blur 还不够：Windows 滚轮事件默认发给前台窗口，
 * 截图窗若仍是前台，滚轮不会到下面的页面。用 WindowFromPoint 命中测试跳过
 * click-through 的截图窗，直接拿到底层窗口并 SetForegroundWindow。 */
/** 获取 Xiyue 所有可见 BrowserWindow 的 HWND 十六进制集合（用于焦点让渡时排除，
 * 避免把系统前台又交回 Xiyue 自己，导致用户看到"主窗口弹出来挡住截图"）。 */
function getXiyueWindowHandles(): Set<string> {
  const handles = new Set<string>();
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w || w.isDestroyed()) continue;
    try {
      const buf = w.getNativeWindowHandle();
      handles.add((buf.byteLength >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0))).toString(16));
    } catch { /* ignore */ }
  }
  return handles;
}

// 焦点让渡结果追踪（模块级，供模块级 transferFocusTo 与函数内 lsSetClickThrough/lsPollTick 共享）：
// Windows 前台锁（foreground-lock）可能让首次 SetForegroundWindow 失败；光标在洞内时轮询重试
// （约每 400ms），直到成功把焦点交给底层窗口（滚轮才能翻页）。
let lsFocusTransferOk = false;
let lsLastFocusAttempt = 0;
// r49 方案B：滚轮用 PostMessage WM_MOUSEWHEEL 直达选区正下方窗口，彻底摆脱
// 「鼠标必须在选区洞内」（方案A 的硬伤：用户鼠标移出选区滚轮就被截图窗吞掉）。
// 实测（_ls_wheel_test12/13，2026-09-08）：
//  - Chromium 系（Edge/Chrome/Electron）：post 到 Chrome_RenderWidgetHostHWND 子窗口，
//    delta 与位移线性精准（-120→400px、-60→200px、-10→33px），且**前台/焦点无关**（test12
//    前台是别的窗口时依然有效）、**鼠标位置无关**（全程未动鼠标）。
//  - 普通 Win32 应用：post 到 WindowFromPoint 命中的子窗口（大多数在消息循环处理 WM_MOUSEWHEEL）。
//  - koffi 不可用 / 解析失败 / PostMessage 返回 0：fallback 到 mouse_event（方案A 保底）。
// 绝不移用户光标（不做 SetCursorPos）。

// 模块级选区洞引用（屏幕坐标）：lsHole 是长截图设置函数内的局部变量，模块级 lsWheel
// 访问不到；active handler 赋值，lsStopPolling 清空。
let lsWheelHole: Electron.Rectangle | null = null;

// PostMessage 滚轮目标缓存（会话内解析一次；窗口关闭时 IsWindow 校验失败重解析）
let lsWheelTarget: { wnd: bigint; cls: string; viaRender: boolean } | null = null;
// 轮询闭包的透传状态标记重置钩子（lsResolveWheelTarget 临时透传截图窗后，把闭包里的
// lsLastClickThrough 重置为 false，下个 30ms tick 会按光标位置重新同步真实透传状态）
let lsResetClickThroughState: (() => void) | null = null;

/** 读取窗口类名（koffi 版，失败返回空串） */
function lsClassOf(api: Win32FocusApi, h: number | bigint): string {
  try {
    const b = Buffer.alloc(1024);
    api.GetClassNameW(h, b, 512);
    let i = 0;
    while (i < 1024 && b.readUInt16LE(i)) i += 2;
    return b.slice(0, i).toString('utf16le');
  } catch { return ''; }
}

/** 递归（≤3 层）查找 root 子树里最深的 Chrome_RenderWidgetHostHWND（Chromium 渲染子窗口）。
 *  深度优先取最深层：嵌套结构的最新渲染窗在最里层。 */
function lsFindRenderChild(api: Win32FocusApi, root: bigint, depth: number): bigint | null {
  if (depth > 3) return null;
  let prev: number | bigint = 0;
  let found: bigint | null = null;
  for (let i = 0; i < 40; i++) {
    const c = api.FindWindowExW(root, prev, null, null);
    if (!c || BigInt(c) === 0n) break;
    const cls = lsClassOf(api, c);
    if (cls === 'Chrome_RenderWidgetHostHWND') found = BigInt(c);
    const deeper = lsFindRenderChild(api, BigInt(c), depth + 1);
    if (deeper) found = deeper;
    prev = c;
  }
  return found;
}

/** 按句柄 hex 反查 Xiyue 的 BrowserWindow（解析目标时若命中自己，临时透传后重试命中） */
function lsFindXiyueWindowByHex(hex: string): BrowserWindow | null {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w || w.isDestroyed()) continue;
    try {
      const buf = w.getNativeWindowHandle();
      if ((buf.byteLength >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0))).toString(16) === hex) return w;
    } catch { /* ignore */ }
  }
  return null;
}

/** 逻辑(DIP)选区中心 → 物理屏幕坐标（WindowFromPoint / WM_MOUSEWHEEL lParam 均要物理像素；
 *  Electron 主进程 DPI-aware，lsWheelHole 是 DIP，直接用会命中错误窗口——r49 首测踩坑） */
function lsHoleCenterPhys(): { x: number; y: number } | null {
  if (!lsWheelHole) return null;
  const dip = {
    x: Math.round(lsWheelHole.x + lsWheelHole.width / 2),
    y: Math.round(lsWheelHole.y + lsWheelHole.height / 2),
  };
  try {
    const phys = screen.dipToScreenPoint(dip);
    return { x: Math.round(phys.x), y: Math.round(phys.y) };
  } catch {
    // 兜底：按主屏缩放因子换算（display 配对失败时）
    try {
      const sf = screen.getPrimaryDisplay().scaleFactor || 1;
      return { x: Math.round(dip.x * sf), y: Math.round(dip.y * sf) };
    } catch { return dip; }
  }
}

/** 解析选区中心正下方的滚轮目标窗口（Chromium → render 子窗口；普通 App → 命中窗口本身）。
 *  命中 Xiyue 截图窗（未处于透传态，WindowFromPoint 被它挡住）时：临时 setIgnoreMouseEvents(true)
 *  让命中跳过截图窗，解析完恢复为可点击并同步轮询闭包的透传状态标记（30ms 轮询会按光标
 *  位置立即纠正回正确状态）。返回 true=成功缓存 lsWheelTarget。 */
function lsResolveWheelTarget(): boolean {
  const api = getWin32FocusApi();
  const center = lsHoleCenterPhys();
  if (!api || !center) return false;
  const { x: cx, y: cy } = center;
  try {
    let hit = api.WindowFromPoint({ x: cx, y: cy });
    if (!hit) { console.error('[LS-MAIN] resolve-wheel: WindowFromPoint null'); return false; }
    let root = BigInt(api.GetAncestor(hit, 3) || hit);
    const xiyue = getXiyueWindowHandles();
    const rootHex = root.toString(16);
    if (xiyue.has(rootHex)) {
      // 命中自己：临时整窗透传，让命中测试跳过截图窗拿到真正的底层窗口
      const cap = lsFindXiyueWindowByHex(rootHex);
      if (cap) {
        try { cap.setIgnoreMouseEvents(true); } catch { /* ignore */ }
        hit = api.WindowFromPoint({ x: cx, y: cy });
        // 恢复可点击 + 重置轮询的状态标记（下个 30ms tick 按光标位置重设）
        try { cap.setIgnoreMouseEvents(false); lsResetClickThroughState?.(); } catch { /* ignore */ }
      }
      if (!hit) { console.error('[LS-MAIN] resolve-wheel: retry hit null'); return false; }
      root = BigInt(api.GetAncestor(hit, 3) || hit);
      if (xiyue.has(root.toString(16))) {
        console.error('[LS-MAIN] resolve-wheel: still self after passthrough');
        return false;
      }
    }
    // Chromium 系：优先 render 子窗口（滚轮直达渲染层，前台无关）
    const render = lsFindRenderChild(api, root, 0);
    if (render) {
      lsWheelTarget = { wnd: render, cls: 'Chrome_RenderWidgetHostHWND', viaRender: true };
      console.error(`[LS-MAIN] wheel-target: render=0x${render.toString(16)} root=0x${root.toString(16)} cls=${lsClassOf(api, root)}`);
      return true;
    }
    // 普通 App：post 到命中窗口本身（多数在消息循环里处理 WM_MOUSEWHEEL）
    lsWheelTarget = { wnd: BigInt(hit), cls: lsClassOf(api, hit), viaRender: false };
    console.error(`[LS-MAIN] wheel-target: hit=0x${BigInt(hit).toString(16)} cls=${lsWheelTarget.cls} (no render child)`);
    return true;
  } catch (err) {
    console.error('[LS-MAIN] resolve-wheel failed:', (err as Error)?.message);
    lsWheelTarget = null;
    return false;
  }
}

/** 方案B：PostMessage WM_MOUSEWHEEL（lParam=选区中心物理屏幕坐标）。缓存失效自动重解析。 */
function lsPostWheel(delta: number): boolean {
  const api = getWin32FocusApi();
  const center = lsHoleCenterPhys();
  if (!api || !center) return false;
  try {
    if (!lsWheelTarget || !api.IsWindow(lsWheelTarget.wnd)) {
      if (lsWheelTarget) console.error('[LS-MAIN] wheel-target stale, re-resolving');
      if (!lsResolveWheelTarget()) return false;
    }
    const { x: cx, y: cy } = center;
    // wParam 高16位=delta（有符号），低16位=键状态0；lParam 低16位=x、高16位=y（物理屏幕坐标）
    const wParam = BigInt(((delta & 0xffff) << 16) >>> 0);
    const lParam = BigInt(((((cy & 0xffff) << 16) | (cx & 0xffff)) >>> 0));
    const ok = api.PostMessageW(lsWheelTarget!.wnd, 0x020a, wParam, lParam);
    if (ok) {
      console.error(`[LS-MAIN] post-wheel delta=${delta} -> 0x${lsWheelTarget!.wnd.toString(16)} (${lsWheelTarget!.cls}) at=(${cx},${cy}) ok=${ok}`);
      return true;
    }
    console.error(`[LS-MAIN] post-wheel failed (ret=0), fallback to mouse_event`);
    lsWheelTarget = null; // 目标可能已失效，下次重新解析
    return false;
  } catch (err) {
    console.error('[LS-MAIN] post-wheel failed:', (err as Error)?.message);
    return false;
  }
}

/** 滚轮注入统一入口（r49）：方案B PostMessage 优先 → 方案A mouse_event 保底。 */
function lsWheel(delta: number): boolean {
  if (lsPostWheel(delta)) return true;
  // ── 方案A 保底（koffi 失败 / PostMessage 被拒）：真实输入 mouse_event。
  //  滚轮按「光标所在窗口」派发，需要鼠标在选区洞内（截图窗 click-through 透传）。 */
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const mouseEvent = user32.func('void mouse_event(uint32_t dwFlags, int32_t dx, int32_t dy, uint32_t dwData, uint64_t dwExtraInfo)');
    const getCursorPos = user32.func('uint32_t GetCursorPos(_Out_ uint8_t *lpPoint)');
    const pt = Buffer.alloc(8);
    const havePt = !!getCursorPos(pt);
    const cx0 = havePt ? pt.readInt32LE(0) : 0;
    const cy0 = havePt ? pt.readInt32LE(4) : 0;
    const inHole = lsWheelHole
      ? (cx0 >= lsWheelHole!.x && cx0 <= lsWheelHole!.x + lsWheelHole!.width && cy0 >= lsWheelHole!.y && cy0 <= lsWheelHole!.y + lsWheelHole!.height)
      : false;
    console.error(`[LS-MAIN] fallback wheel delta=${delta} at=(${cx0},${cy0}) inHole=${inHole}`);
    mouseEvent(0x0800, 0, 0, delta, 0); // MOUSEEVENTF_WHEEL，负值向下翻页
    return true;
  } catch (err) {
    console.error('[LS-MAIN] wheel inject failed:', (err as Error)?.message);
    return false;
  }
}

function transferFocusTo(x: number, y: number): void {
  const api = getWin32FocusApi();
  if (!api) return;
  const exclude = getXiyueWindowHandles();
  try {
    // x/y 是逻辑(DIP)屏幕坐标；WindowFromPoint 需物理像素（主进程 DPI-aware）
    let px = x, py = y;
    try {
      const phys = screen.dipToScreenPoint({ x, y });
      px = Math.round(phys.x); py = Math.round(phys.y);
    } catch { /* 转换失败按原值（单屏 100% 缩放时 DIP=物理） */ }
    const hChild = api.WindowFromPoint({ x: px, y: py });
    if (!hChild) { console.error('[LS-MAIN] WindowFromPoint returned null'); return; }
    let hRoot = api.GetAncestor(hChild, 3); // GA_ROOT = 3
    if (!hRoot) hRoot = hChild;
    // HWND 是 number|bigint（uint64_t 收发），统一转 BigInt 取 hex，与 getNativeWindowHandle 的 Buffer 地址一致可比
    const rootHex = BigInt(hRoot).toString(16);
    if (exclude.has(rootHex)) {
      console.error(`[LS-MAIN] focus transfer skipped: hit Xiyue window ${rootHex}`);
      return;
    }
    // Windows 前台锁（ForegroundLockTimeout）可能让 SetForegroundWindow 静默失败 → 滚轮翻不动底层窗口。
    // 标准解：把当前线程附加到「当前前台窗口」的线程，SetForegroundWindow 即被视作前台线程调用而成功。
    let attached = false;
    let fgTid = 0;
    let curTid = 0;
    try {
      const fgWin = api.GetForegroundWindow();
      if (fgWin) {
        fgTid = api.GetWindowThreadProcessId(fgWin, null);
        curTid = api.GetCurrentThreadId();
        if (fgTid && curTid && fgTid !== curTid) {
          api.AttachThreadInput(curTid, fgTid, 1);
          attached = true;
        }
      }
    } catch { /* 附加失败不影响后续 SetForegroundWindow 兜底 */ }
    const ok = api.SetForegroundWindow(hRoot);
    if (attached) {
      try { api.AttachThreadInput(curTid, fgTid, 0); } catch { /* ignore */ }
    }
    lsFocusTransferOk = ok !== 0;
    lsLastFocusAttempt = Date.now();
    console.error(`[LS-MAIN] focus transfer -> ${ok} root=${rootHex}${attached ? ' (attached)' : ''}`);
  } catch (err) {
    lsFocusTransferOk = false;
    lsLastFocusAttempt = Date.now();
    console.error('[LS-MAIN] transferFocus failed:', (err as Error)?.message);
  }
}
import { capturePrimaryDisplayPng } from '../../window/screenshotHelper';
import { recognizeCaptureTextLocally } from '../../services/captureLocalOcrService';
import { recognizeCaptureTableWithRapid, recognizeCaptureTextWithRapid } from '../../services/rapidOcrService';
import { recognizeCaptureText } from '../../services/captureOcrService';
import { translateCaptureImage } from '../../services/imageTranslationService';
import {
  cancelPendingLayoutOcr,
  getLayoutOcrStatus,
  recognizeWithPaddleOcr,
  recognizeWithPaddleOcrLayout,
  translateTextWithLocalMt,
  translateWithLocalMt,
} from '../../services/localOcrMtService';
import {
  readScreenshotCloudTranslateConfig,
  readScreenshotOcrEngineConfig,
  readScreenshotTranslateEngineConfig,
} from '../../config/storeConfig';

interface RegisterCaptureIpcHandlersOptions {
  getCaptureWindow: () => BrowserWindow | null;
  closeCaptureWindow: () => void;
  triggerScreenshot: () => Promise<void>;
}

/**
 * 注册截图相关 IPC 处理器
 * @description 注册截图、保存、取消等 IPC 事件处理器
 * @param options - 配置选项，包含获取和关闭截图窗口的函数
 */
export function registerCaptureIpcHandlers(options: RegisterCaptureIpcHandlersOptions): void {
  ipcMain.handle('system:screenshot:region:start', async () => {
    try {
      await options.triggerScreenshot();
      return true;
    } catch (err) {
      console.error('[System] start region screenshot error:', err);
      return false;
    }
  });

  ipcMain.handle('system:screenshot', async () => {
    try {
      const nativeScreenshot = capturePrimaryDisplayPng();
      if (nativeScreenshot) {
        return nativeScreenshot.toString('base64');
      }

      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1920, height: 1080 },
      });
      if (sources.length > 0) {
        const screenshot = sources[0].thumbnail.toPNG();
        return screenshot.toString('base64');
      }
    } catch (err) {
      console.error('[System] screenshot error:', err);
    }
    return null;
  });

  /**
   * 取桌面屏幕源（长截图 / 录屏用）。⚠️ Electron 新版已把 desktopCapturer 从渲染进程
   * 移除（渲染端 `require('electron').desktopCapturer` 是 undefined，运行时报
   * "Cannot read properties of undefined (reading 'getSources')"），必须由主进程代取。
   */
  ipcMain.handle('capture-desktop-sources', async () => {
    try {
      return await desktopCapturer.getSources({ types: ['screen'] });
    } catch (err) {
      console.error('[Capture] desktop sources error:', err);
      return [];
    }
  });

  /**
   * 长截图：取桌面源原生分辨率 thumbnail 并按选区矩形裁剪，返回裁剪区 dataURL。
   * ⚠️ 2026-09-06 起 Xiyue 长截图走「主屏截图」路线（零 WebRTC 视频编码，清晰度=单张截图）：
   * 渲染端 desktopCapturer 已被移除，必须由主进程代取；thumbnailSize 需传物理分辨率
   * （screen 逻辑尺寸 × dpr），默认 150×150 的 thumbnail 不能用于拼接。
   */
  ipcMain.handle('capture-longshot-frame', async (_event, p: {
    sourceId: string;
    thumbSize: { width: number; height: number };
    selX: number; selY: number; selW: number; selH: number;
    screenW: number; screenH: number;
  }) => {
    try {
      const t0 = Date.now();
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: p.thumbSize });
      const src = sources.find((s) => s.id === p.sourceId) || sources[0];
      if (!src) return null;
      const ts = src.thumbnail.getSize();
      // 耗时打点：定位 getSources 是否是主进程卡顿元凶（全分辨率 vs 探针小图分开看）
      console.error(`[LS-MAIN] frame ${ts.width}x${ts.height} getSources=${Date.now() - t0}ms`);
      // 文档明确 thumbnail 实际尺寸不保证等于请求值（受屏幕 scale 影响）→ 按实际尺寸回算比例
      const scale = ts.width / (p.screenW || ts.width);
      const rect = {
        x: Math.max(0, Math.round(p.selX * scale)),
        y: Math.max(0, Math.round(p.selY * scale)),
        width: Math.max(1, Math.round(p.selW * scale)),
        height: Math.max(1, Math.round(p.selH * scale)),
      };
      const crop = src.thumbnail.crop(rect);
      return { url: crop.toDataURL() };
    } catch (err) {
      console.error('[LS] longshot frame error:', err);
      return null;
    }
  });

  // ── GDI 抓屏（koffi）：BitBlt 选区 → GetDIBits → BGRA raw，毫秒级。
  // desktopCapturer.getSources 无论 thumbnailSize 多小都要 600~900ms（开销在系统取屏），
  // 400ms 探针×700ms 调用 = 主进程 100% 占空比 → 鼠标卡死 + 抓帧间隔过长致滚动大步位移被拒。
  interface GdiCaptureApi {
    GetDC: (hWnd: number) => number;
    ReleaseDC: (hWnd: number, hdc: number) => number;
    CreateCompatibleDC: (hdc: number) => number;
    DeleteDC: (hdc: number) => number;
    CreateCompatibleBitmap: (hdc: number, w: number, h: number) => number;
    SelectObject: (hdc: number, obj: number) => number;
    BitBlt: (hdc: number, x: number, y: number, w: number, h: number, hdcSrc: number, x1: number, y1: number, rop: number) => number;
    GetDIBits: (hdc: number, hbmp: number, start: number, lines: number, bits: Uint8Array, lpbi: Uint8Array, usage: number) => number;
    DeleteObject: (obj: number) => number;
  }
  let cachedGdi: GdiCaptureApi | null | undefined;
  function getGdiCaptureApi(): GdiCaptureApi | null {
    if (cachedGdi !== undefined) return cachedGdi;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const koffi = require('koffi');
      const user32 = koffi.load('user32.dll');
      const gdi32 = koffi.load('gdi32.dll');
      // HDC/HBITMAP 一律 uint64_t 收发（同 HWND 经验：void* 返回 External 不可用）
      cachedGdi = {
        GetDC: user32.func('uint64_t GetDC(uint64_t hWnd)'),
        ReleaseDC: user32.func('int ReleaseDC(uint64_t hWnd, uint64_t hdc)'),
        CreateCompatibleDC: gdi32.func('uint64_t CreateCompatibleDC(uint64_t hdc)'),
        DeleteDC: gdi32.func('int DeleteDC(uint64_t hdc)'),
        CreateCompatibleBitmap: gdi32.func('uint64_t CreateCompatibleBitmap(uint64_t hdc, int w, int h)'),
        SelectObject: gdi32.func('uint64_t SelectObject(uint64_t hdc, uint64_t obj)'),
        BitBlt: gdi32.func('int BitBlt(uint64_t hdc, int x, int y, int w, int h, uint64_t hdcSrc, int x1, int y1, uint32_t rop)'),
        GetDIBits: gdi32.func('int GetDIBits(uint64_t hdc, uint64_t hbmp, uint32_t start, uint32_t lines, _Out_ uint8_t *bits, _Inout_ uint8_t *lpbi, uint32_t usage)'),
        DeleteObject: gdi32.func('int DeleteObject(uint64_t obj)'),
      };
    } catch (err) {
      console.error('[LS-MAIN] koffi gdi32 load failed:', (err as Error)?.message);
      cachedGdi = null;
    }
    return cachedGdi;
  }

  /**
   * 长截图 GDI 抓屏：按物理像素矩形 BitBlt 主屏 → BGRA buffer 返回。
   * 仅支持主屏区域（gx/gy<0 时返回 null，走 getSources fallback）；调用方需 try/catch。
   */
  ipcMain.handle('capture-longshot-gdi', (_event, p: { gx: number; gy: number; gw: number; gh: number }) => {
    try {
      if (!p || p.gx < 0 || p.gy < 0 || p.gw < 4 || p.gh < 4 || p.gw > 8192 || p.gh > 8192) return null;
      const api = getGdiCaptureApi();
      if (!api) return null;
      const t0 = Date.now();
      const hdcScreen = api.GetDC(0);
      if (!hdcScreen) return null;
      let hdcMem = 0, hbm = 0, oldBmp = 0, ok = false;
      let out: Buffer | null = null;
      try {
        hdcMem = api.CreateCompatibleDC(hdcScreen);
        hbm = api.CreateCompatibleBitmap(hdcScreen, p.gw, p.gh);
        if (!hdcMem || !hbm) return null;
        oldBmp = api.SelectObject(hdcMem, hbm);
        // SRCCOPY = 0x00CC0020
        if (!api.BitBlt(hdcMem, 0, 0, p.gw, p.gh, hdcScreen, p.gx, p.gy, 0x00cc0020)) return null;
        const bi = Buffer.alloc(40);
        bi.writeUInt32LE(40, 0); // biSize
        bi.writeInt32LE(p.gw, 4); // biWidth
        bi.writeInt32LE(-p.gh, 8); // biHeight 负值 = top-down 行序
        bi.writeUInt16LE(1, 12); // biPlanes
        bi.writeUInt16LE(32, 14); // biBitCount
        bi.writeUInt32LE(0, 16); // biCompression = BI_RGB
        bi.writeUInt32LE(p.gw * p.gh * 4, 20); // biSizeImage
        out = Buffer.allocUnsafe(p.gw * p.gh * 4);
        // MSDN：GetDIBits 要求 hbm 未被选入 DC → 先还原旧位图（违规会间歇性失败）
        if (oldBmp) api.SelectObject(hdcMem, oldBmp);
        const lines = api.GetDIBits(hdcMem, hbm, 0, p.gh, out, bi, 0);
        if (lines !== p.gh) return null;
        ok = true;
      } finally {
        if (hbm) api.DeleteObject(hbm);
        if (hdcMem) api.DeleteDC(hdcMem);
        api.ReleaseDC(0, hdcScreen);
      }
      if (!ok || !out) return null;
      console.error(`[LS-MAIN] gdi ${p.gw}x${p.gh} bitblt=${Date.now() - t0}ms`);
      return { buf: out, w: p.gw, h: p.gh };
    } catch (err) {
      console.error('[LS] gdi capture error:', (err as Error)?.message);
      return null;
    }
  });

  // 长截图调试转储：把被拒帧/关键帧落盘，供离线取证（帧内容异常时肉眼可查）
  ipcMain.on('capture-ls-debug', (_event, p: { name: string; dataURL: string }) => {
    try {
      const dir = join(app.getPath('temp'), 'xiyue-ls-debug');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, p.name), Buffer.from(p.dataURL.split(',')[1], 'base64'));
    } catch (err) {
      console.error('[LS] debug dump failed:', err);
    }
  });

  /* ── 长截图自动滚动（r21）：匀速合成滚轮，解决手动变速滚动（走走停停+甩滚）
   * 与速度连续性先验匹配器的矛盾——实测 session 1788745242484：真值 1657px，变速滚动下速度闸门
   * 把真实加速（s=299/306）当假谷拒绝，只拼上 1099px。匀速滚动让每帧位移恒定、重叠大且可预测。 ── */
  let lsAutoScrollTimer: ReturnType<typeof setInterval> | null = null;
  let lsAutoScrollDeadline = 0;
  function lsAutoScrollStop(reason: string): void {
    if (lsAutoScrollTimer) { clearInterval(lsAutoScrollTimer); lsAutoScrollTimer = null; console.error(`[LS-MAIN] autoscroll stop (${reason})`); }
  }
  function lsAutoScrollStart(intervalMs: number, delta: number): boolean {
    lsAutoScrollStop('restart');
    try {
      lsAutoScrollDeadline = Date.now() + 180000; // 安全阀：最多 3 分钟自动停
      lsAutoScrollTimer = setInterval(() => {
        if (Date.now() > lsAutoScrollDeadline) { lsAutoScrollStop('deadline'); return; }
        // r49 方案B：滚轮统一走 lsWheel（PostMessage 优先 → mouse_event 保底）
        if (!lsWheel(delta)) lsAutoScrollStop('error');
      }, Math.max(30, intervalMs));
      console.error(`[LS-MAIN] autoscroll start interval=${intervalMs}ms delta=${delta}`);      return true;
    } catch (err) {
      console.error('[LS-MAIN] autoscroll start failed:', (err as Error)?.message);
      return false;
    }
  }
  ipcMain.handle('capture-ls-autoscroll', (_event, p: { action: 'start' | 'stop' | 'step'; intervalMs?: number; delta?: number }) => {
    if (!p) return false;
    if (p.action === 'step') {
      // r23 步进制：只发一格滚轮，由渲染端等画面静止抓帧后再发下一格——每帧都是静止帧（锐度拉满），
      // 连续滚动模式页面永远在动画中，沉降等待预算耗尽后照样抓中途帧（亚像素重采样→文字发虚）
      // r49 方案B：lsWheel 内部优先 PostMessage WM_MOUSEWHEEL 直达选区下方窗口（Chromium
      // render 子窗口优先），鼠标在不在选区内都能翻页、不抢前台焦点；全失败才 fallback mouse_event。
      return lsWheel(p.delta ?? -40);
    }
    if (p.action === 'start') return lsAutoScrollStart(p.intervalMs ?? 600, p.delta ?? -40);
    lsAutoScrollStop('ipc');
    return true;
  });
  // 双保险：长截图会话结束（capture-ls-active on=false）时即使渲染端漏发 stop 也停滚
  ipcMain.on('capture-ls-active', (_event, p: { on: boolean }) => {
    if (p && p.on === false) lsAutoScrollStop('session-end');
  });


  ipcMain.on('capture-complete', (_event, { dataURL }: { dataURL: string }) => {
    try {
      const image = nativeImage.createFromDataURL(dataURL);
      clipboard.writeImage(image);
    } catch (err) {
      console.error('[Screenshot] copy error:', err);
    }
    options.closeCaptureWindow();
  });

  ipcMain.handle('capture-ocr-local', async (event, payload: {
    dataURL: string;
  }) => {
    const captureWindow = options.getCaptureWindow();
    if (!captureWindow || captureWindow.isDestroyed() || event.sender.id !== captureWindow.webContents.id) {
      return { success: false, code: 'captureWindowClosed' };
    }

    const controller = new AbortController();
    const abort = (): void => controller.abort();
    event.sender.once('destroyed', abort);
    try {
      // 本机 OCR：local=RapidOCR(飞桨 PP-OCRv6/ONNX，不可用时回退 Tesseract.js) / paddleocr=本机 PaddleOCR
      if (readScreenshotOcrEngineConfig() === 'paddleocr') {
        return await recognizeWithPaddleOcr(
          typeof payload?.dataURL === 'string' ? payload.dataURL : '',
          controller.signal,
        );
      }
      const dataUrlArg = typeof payload?.dataURL === 'string' ? payload.dataURL : '';
      try {
        const rapid = await recognizeCaptureTextWithRapid(dataUrlArg, controller.signal);
        if (rapid.success) {
          return { success: true, text: rapid.text };
        }
        console.warn('[Capture] RapidOCR unavailable, fallback to Tesseract:', rapid.text);
      } catch (err) {
        console.warn('[Capture] RapidOCR error, fallback to Tesseract:', err);
      }
      return await recognizeCaptureTextLocally(dataUrlArg, controller.signal);
    } finally {
      event.sender.removeListener('destroyed', abort);
    }
  });

  // 表格结构还原（RapidTable/SLANet-plus）：按需触发，返回 HTML 表格供面板复制
  ipcMain.handle('capture-ocr-table', async (event, payload: {
    dataURL: string;
  }) => {
    const captureWindow = options.getCaptureWindow();
    if (!captureWindow || captureWindow.isDestroyed() || event.sender.id !== captureWindow.webContents.id) {
      return { success: false, code: 'captureWindowClosed' };
    }

    const controller = new AbortController();
    const abort = (): void => controller.abort();
    event.sender.once('destroyed', abort);
    try {
      return await recognizeCaptureTableWithRapid(
        typeof payload?.dataURL === 'string' ? payload.dataURL : '',
        controller.signal,
      );
    } finally {
      event.sender.removeListener('destroyed', abort);
    }
  });

  ipcMain.handle('capture-ocr', async (event, payload: {
    dataURL: string;
    token: string;
  }) => {
    const captureWindow = options.getCaptureWindow();
    if (!captureWindow || captureWindow.isDestroyed() || event.sender.id !== captureWindow.webContents.id) {
      return { success: false, code: 'captureWindowClosed' };
    }

    const controller = new AbortController();
    const abort = (): void => controller.abort();
    event.sender.once('destroyed', abort);
    try {
      return await recognizeCaptureText(
        typeof payload?.token === 'string' ? payload.token : '',
        typeof payload?.dataURL === 'string' ? payload.dataURL : '',
        controller.signal,
      );
    } finally {
      event.sender.removeListener('destroyed', abort);
    }
  });

  ipcMain.handle('capture-translate', async (event, payload: {
    dataURL: string;
    token: string;
    sourceLanguage: string;
    targetLanguage: string;
  }) => {
    const captureWindow = options.getCaptureWindow();
    if (!captureWindow || captureWindow.isDestroyed() || event.sender.id !== captureWindow.webContents.id) {
      return { success: false, code: 'captureWindowClosed' };
    }

    const controller = new AbortController();
    const abort = (): void => controller.abort();
    event.sender.once('destroyed', abort);
    try {
      return await translateCaptureImage(
        typeof payload?.token === 'string' ? payload.token : '',
        typeof payload?.dataURL === 'string' ? payload.dataURL : '',
        typeof payload?.sourceLanguage === 'string' && payload.sourceLanguage ? payload.sourceLanguage : 'auto',
        typeof payload?.targetLanguage === 'string' && payload.targetLanguage ? payload.targetLanguage : 'zh',
        controller.signal,
      );
    } finally {
      event.sender.removeListener('destroyed', abort);
    }
  });

  ipcMain.handle('capture-translate-local', async (event, payload: {
    dataURL: string;
    targetLanguage: string;
  }) => {
    const captureWindow = options.getCaptureWindow();
    if (!captureWindow || captureWindow.isDestroyed() || event.sender.id !== captureWindow.webContents.id) {
      return { success: false, code: 'captureWindowClosed' };
    }

    const controller = new AbortController();
    const abort = (): void => controller.abort();
    event.sender.once('destroyed', abort);
    try {
      return await translateWithLocalMt(
        typeof payload?.dataURL === 'string' ? payload.dataURL : '',
        typeof payload?.targetLanguage === 'string' && payload.targetLanguage ? payload.targetLanguage : 'zh',
        controller.signal,
        'fast',
        readScreenshotTranslateEngineConfig() === 'cloud' ? readScreenshotCloudTranslateConfig() : null,
      );
    } finally {
      event.sender.removeListener('destroyed', abort);
    }
  });

  /** 纯文本翻译（OCR 面板「翻译」按钮用）：翻译面板里已识别的文字，不重新截屏/OCR */
  ipcMain.handle('capture-translate-text', async (event, payload: {
    text: string;
    targetLanguage: string;
  }) => {
    const captureWindow = options.getCaptureWindow();
    if (!captureWindow || captureWindow.isDestroyed() || event.sender.id !== captureWindow.webContents.id) {
      return { success: false, code: 'captureWindowClosed' };
    }

    const controller = new AbortController();
    const abort = (): void => controller.abort();
    event.sender.once('destroyed', abort);
    try {
      return await translateTextWithLocalMt(
        typeof payload?.text === 'string' ? payload.text : '',
        typeof payload?.targetLanguage === 'string' && payload.targetLanguage ? payload.targetLanguage : 'zh',
        controller.signal,
        readScreenshotTranslateEngineConfig() === 'cloud' ? readScreenshotCloudTranslateConfig() : null,
      );
    } finally {
      event.sender.removeListener('destroyed', abort);
    }
  });

  /* ── 长截图：纯 click-through + 全局热键 ──
   * ⚠️ 不用 forward:true（Windows 实测）：forward 依赖低级鼠标钩子，会把滚轮吞进钩子
   * （底层页面翻不动页），且每个鼠标事件转发进渲染端，配合拼接像素读取造成全系统鼠标
   * 发滞。纯 click-through 无钩子、零系统负担；Enter/Esc 由 globalShortcut 全局接管。 */
  let lsHotkeysActive = false;

  const registerLsHotkeys = (): void => {
    const captureWindow = options.getCaptureWindow();
    if (!captureWindow || captureWindow.isDestroyed() || lsHotkeysActive) return;
    lsHotkeysActive = true;
    try {
      // ⚠️ Electron 加速器 token 是 'Esc'（不是 'Escape'）；用 'Escape' 会静默注册失败、
      // 回调永不触发 → 表现为「ESC 无法退出长截图」。这里必须用 'Esc'。
      globalShortcut.register('Enter', () => {
        captureWindow.webContents.send('capture-ls-finish', true);
      });
      globalShortcut.register('Esc', () => {
        captureWindow.webContents.send('capture-ls-finish', false);
      });
      console.error('[LS-MAIN] hotkeys registered (Enter=finish, Esc=cancel)');
    } catch (err) {
      console.error('[LS-MAIN] register hotkeys failed', err);
    }
  };

  const unregisterLsHotkeys = (): void => {
    if (!lsHotkeysActive) return;
    lsHotkeysActive = false;
    try {
      globalShortcut.unregister('Enter');
      globalShortcut.unregister('Esc');
      console.error('[LS-MAIN] hotkeys unregistered');
    } catch (err) {
      console.error('[LS-MAIN] unregister hotkeys failed', err);
    }
  };

  /* ── 长截图：窗口保持可见 + 选区洞透出真实桌面 + 光标轮询切换 click-through ──
   * 用户心智模型：长截图时整窗像正常截图一样（暗蒙版 + 选区洞），洞里看到的是活的页面，
   * 滚轮在洞里翻页；把光标移出洞（到工具栏/蒙版）截图窗恢复可点击 → 再点长截图按钮结束。
   * 主进程用 screen.getCursorScreenPoint 每 30ms 轮询光标位置：
   *  - 光标在选区洞内 → setIgnoreMouseEvents(true)：滚轮/点击透传给底层页面（截图窗不挡）；
   *  - 光标在洞外 → setIgnoreMouseEvents(false)：截图窗恢复接收事件，工具栏按钮可点。
   * 窗口始终留在屏幕上（不 park、不 opacity 0），所以"整窗像正常截图"；桌面流裁剪选区时
   * 洞是透明的 → 截到的是活页面，拼接正确。Enter=完成、Esc=取消 仍由 globalShortcut 兜底。 */
  let lsHole: Electron.Rectangle | null = null;
  let lsPollTimer: NodeJS.Timeout | null = null;
  let lsLastClickThrough = false;

  const lsStopPolling = (): void => {
    if (lsPollTimer) { clearInterval(lsPollTimer); lsPollTimer = null; }
    lsHole = null;
    lsWheelHole = null; // 清空模块级洞引用，防止下一会话误用旧坐标
    lsWheelTarget = null; // 清空滚轮目标缓存，下个会话重新解析
    lsLastClickThrough = false;
  };

  // 注册透传状态重置钩子（模块级 lsResolveWheelTarget 临时透传截图窗后同步闭包状态标记）
  lsResetClickThroughState = () => { lsLastClickThrough = false; };

  const lsSetClickThrough = (on: boolean): void => {
    const captureWindow = options.getCaptureWindow();
    if (!captureWindow || captureWindow.isDestroyed()) return;
    if (on === lsLastClickThrough) return;
    // 只在状态切换时打日志（带光标位置），方便对账「蒙版区为什么能/不能透传」
    try {
      const pt = screen.getCursorScreenPoint();
      const holeStr = lsHole ? `${lsHole.x},${lsHole.y} ${lsHole.width}x${lsHole.height}` : 'null';
      console.error(`[LS-MAIN] clickThrough ${lsLastClickThrough}->${on} cursor=(${pt.x},${pt.y}) hole=${holeStr}`);
    } catch { /* ignore */ }
    lsLastClickThrough = on;
    try {
      // 洞内透传：窗口不参与命中测试 → 滚轮/点击直达底层应用；
      // 洞外恢复：截图窗恢复接收事件，工具栏按钮可点（含「再点长截图按钮结束」）。
      // ⚠️ 保持 setFocusable(true)：setFocusable(false) 会让 Electron 把前台交回 Xiyue 主窗口，
      // 用户会看到主窗口弹出来挡住截图（即"出现错误应用模板"）。我们只通过 blur()+Win32
      // SetForegroundWindow 把焦点让给选区正下方的底层窗口。
      captureWindow.setIgnoreMouseEvents(on);
      if (on) {
        captureWindow.blur();
        lsFocusTransferOk = false;
        // Windows 滚轮事件默认发给前台窗口；仅 click-through 不够，必须把焦点让给
        // 选区正下方的底层窗口，滚轮才会翻页。
        if (lsHole) {
          const cx = Math.round(lsHole.x + lsHole.width / 2);
          const cy = Math.round(lsHole.y + lsHole.height / 2);
          transferFocusTo(cx, cy);
        }
      } else {
        captureWindow.focus();
      }
    } catch (err) {
      console.error('[LS-MAIN] setIgnoreMouseEvents failed', err);
    }
  };

  const lsPollTick = (): void => {
    const captureWindow = options.getCaptureWindow();
    if (!captureWindow || captureWindow.isDestroyed() || !lsHole) { lsStopPolling(); return; }
    try {
      const pt = screen.getCursorScreenPoint();
      // ⚠️ 洞内透传（鼠标停在选区里 → 截图窗不挡，滚轮直达底层页面翻页）；选区外
      // （蒙版/工具栏/底部控制条）一律恢复可点击。这样窗口在选区外时保留焦点 → 按钮
      // 可点、Esc 渲染端键盘兜底仍有效，绝不会像「整窗纯透传」那样让窗口永远失焦而卡死。
      // 滚动时用户的手本就在选区（洞）内，拼接与实时预览不受影响。
      const inHole =
        pt.x >= lsHole.x && pt.x <= lsHole.x + lsHole.width &&
        pt.y >= lsHole.y && pt.y <= lsHole.y + lsHole.height;
      lsSetClickThrough(inHole);
      // 光标在透传中、但焦点让渡还没成功（Windows 前台锁）：周期性重试，直到底层窗口拿到
      // 焦点（滚轮才能翻页）。约每 400ms 一次，不刷屏。
      if (lsLastClickThrough && !lsFocusTransferOk) {
        const now = Date.now();
        if (now - lsLastFocusAttempt > 400) {
          const cx = Math.round(lsHole.x + lsHole.width / 2);
          const cy = Math.round(lsHole.y + lsHole.height / 2);
          transferFocusTo(cx, cy);
        }
      }
    } catch {
      /* 取光标失败忽略，下次再试 */
    }
  };

  ipcMain.on('capture-ls-active', (_event, payload: { on: boolean; sel?: { x: number; y: number; w: number; h: number } }) => {
    const on = payload?.on === true;
    const captureWindow = options.getCaptureWindow();
    if (!captureWindow || captureWindow.isDestroyed()) { console.error('[LS-MAIN] active: window missing/destroyed'); return; }
    try {
      if (on) {
        if (!payload.sel || payload.sel.w < 1 || payload.sel.h < 1) { console.error('[LS-MAIN] active: invalid sel'); return; }
        const b = captureWindow.getBounds();
        // 选区在窗口内 CSS 坐标；窗口满屏且位于虚拟屏 vs.x/vs.y → 屏幕坐标 = bounds + sel
        lsHole = {
          x: Math.round(b.x + payload.sel.x),
          y: Math.round(b.y + payload.sel.y),
          width: Math.round(payload.sel.w),
          height: Math.round(payload.sel.h),
        };
        lsWheelHole = lsHole; // 同步到模块级：滚轮注入/光标锁定需要（存在局部 lsHole 作用域不可达）
        // 洞里的活桌面要全亮度透出：窗口底色临时转全透明。
        // 平时 '#47000000'（28% 黑）作为首帧防闪底色；长截图期间它会把透明洞里的活页面再压暗 28%
        //（和 body 的 0.28 背景叠成 0.48 → 实测灰值 133，即"洞里是灰色蒙版"的一半成因）。
        try { captureWindow.setBackgroundColor('#00000000'); } catch (_) { /* ignore */ }
        // ⚠️ 激活时不能无脑透传：光标此刻多半还在洞外（蒙版/工具栏上，比如刚点完长截图按钮），
        // 无脑透传会让蒙版区的滚轮/点击直达底层页面（"灰色蒙版区也能滑动"）。
        // 正确做法：按光标当前位置决定初始态，之后由 30ms 轮询接管。
        try {
          const pt0 = screen.getCursorScreenPoint();
          // 初始态同样按「光标是否在选区内」决定：在洞内 -> 透传；在洞外（蒙版/工具栏）-> 可点击。
          const inHole0 =
            pt0.x >= lsHole.x && pt0.x <= lsHole.x + lsHole.width &&
            pt0.y >= lsHole.y && pt0.y <= lsHole.y + lsHole.height;
          lsSetClickThrough(inHole0);
          console.error(`[LS-MAIN] initial cursor=(${pt0.x},${pt0.y}) inHole=${inHole0}`);
        } catch {
          lsSetClickThrough(false);
        }
        registerLsHotkeys();
        if (lsPollTimer) clearInterval(lsPollTimer);
        lsPollTimer = setInterval(lsPollTick, 30);
        // r49 方案B：会话激活即预解析滚轮目标窗口（此时截图窗透传状态刚按光标设定，
        // 解析内部自带「命中自己→临时透传重试」兜底），首格滚动零延迟。
        lsWheelTarget = null;
        const resolved = lsResolveWheelTarget();
        console.error(`[LS-MAIN] active on hole=${JSON.stringify(lsHole)} wheelTargetResolved=${resolved}`);
      } else {
        // ⚠️ 顺序铁律：先恢复可交互再清轮询状态。lsStopPolling 会把 lsLastClickThrough
        // 重置为 false，若先清状态，随后的 lsSetClickThrough(false) 因「状态已一致」被
        // 短路，setIgnoreMouseEvents(false) 永不执行 → ESC 取消后窗口永久 click-through
        // 且焦点已让渡给底层窗口 → 鼠标键盘全部无响应（用户实测「卡死无法退出」根因）
        lsSetClickThrough(false);
        lsStopPolling();
        unregisterLsHotkeys();
        // 恢复首帧防闪底色（长截图期间临时转过全透明）
        try { captureWindow.setBackgroundColor('#47000000'); } catch (_) { /* ignore */ }
        console.error('[LS-MAIN] active off');
      }
    } catch (err) {
      console.error('[LS-MAIN] active failed', err);
    }
  });


  /** r27 灰度拉普拉斯方差（清晰度）：BGRA 位图流式计算，与渲染端 lsLapVar 同族。
   *  仅作同补丁相对比较（渲染输出 vs 原图参考），不设绝对阈值。 */
  const lsLapVarOf = (img: Electron.NativeImage): number => {
    try {
      const sz = img.getSize();
      const bw = sz.width, bh = sz.height;
      if (bw < 8 || bh < 8) return 0;
      const b = img.getBitmap();
      const stride = bw * 4;
      const gray = new Float32Array(bw * bh);
      for (let y = 0; y < bh; y++) {
        let p = y * stride;
        for (let x = 0; x < bw; x++, p += 4) {
          gray[y * bw + x] = 0.299 * b[p + 2] + 0.587 * b[p + 1] + 0.114 * b[p];
        }
      }
      let sum = 0, sum2 = 0, n = 0;
      for (let y = 1; y < bh - 1; y++) {
        for (let x = 1; x < bw - 1; x++) {
          const i = y * bw + x;
          const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - bw] - gray[i + bw];
          sum += lap; sum2 += lap * lap; n++;
        }
      }
      if (!n) return 0;
      const mean = sum / n;
      return sum2 / n - mean * mean;
    } catch (_) { return 0; }
  };

  /** r27 编辑器清晰度守卫：窗口 setBounds 后软件合成可能以旧栅格尺度绘制（整窗发虚且
   *  持久不自愈，实测渲染清晰度掉到原图 31%）。用渲染端带来的原图参考补丁，对
   *  capturePage 实测同区域输出做 lap_var 比对，比值 <0.7 判发虚 → hide/show 重建
   *  合成表面（Electron DPI 失效标准解法）后复测，最多 2 轮。 */
  const lsEditorSharpnessGuard = (win: Electron.BrowserWindow, ref: { x: number; y: number; w: number; h: number; dataURL: string }, resized: boolean): void => {
    try {
      const refImg = nativeImage.createFromDataURL(ref.dataURL);
      const refLap = lsLapVarOf(refImg);
      if (refLap < 100) {
        // r28: 补丁全平（选区顶部是纯背景，渲染端已尽力扫描）→ 无法量化比对；若本轮发生过
        // setBounds 缩放（栅格尺度失效触发器），盲修一次 hide/show 重建合成表面，不再静默放过。
        if (resized) {
          console.error('[LS-MAIN] sharp-guard flat patch -> blind heal (resized)');
          setTimeout(() => {
            try {
              if (win.isDestroyed()) return;
              win.webContents.setZoomFactor(1.001);
              setTimeout(() => { try { win.webContents.setZoomFactor(1.0); } catch (_) {} }, 50);
            } catch (_) { /* ignore */ }
          }, 600);
        } else {
          console.error('[LS-MAIN] sharp-guard skip (flat patch, no resize, lap=' + Math.round(refLap) + ')');
        }
        return;
      }
      let round = 0;
      // r52 自愈梯度：1.001 zoom 抖动实测无效（17:31 会话 0.60→0.60 两轮不动）。
      // ①zoom 1.02（强制全页重排+重光栅）→ ②1px 窗口尺寸抖动（强制合成器按原尺寸重建光栅，
      // 结束恢复原 bounds，不违反 r27 move-only 铁律的最终状态）→ ③仍 <0.7 放弃并记疑似采样伪报
      // （导出文件是画布 1:1 像素，不受显示发虚影响；r29 已证 hide/show 更糟，不再尝试）。
      const applyZoomHeal = (amount: number): void => {
        try { win.webContents.setZoomFactor(amount); } catch (_) { /* ignore */ }
        setTimeout(() => { try { win.webContents.setZoomFactor(1.0); } catch (_) { /* ignore */ } }, 50);
      };
      const applyBoundsNudgeHeal = (): void => {
        try {
          const b = win.getBounds();
          win.setBounds({ x: b.x, y: b.y, width: b.width + 1, height: b.height });
          setTimeout(() => { try { if (!win.isDestroyed()) win.setBounds(b); } catch (_) { /* ignore */ } }, 80);
        } catch (_) { /* ignore */ }
      };
      const check = (): void => {
        if (win.isDestroyed() || round >= 3) return;
        round++;
        win.webContents.capturePage({ x: ref.x, y: ref.y, width: ref.w, height: ref.h })
          .then((shot) => {
            if (win.isDestroyed() || shot.isEmpty()) return;
            const got = lsLapVarOf(shot);
            const ratio = refLap > 0 ? got / refLap : 0;
            console.error('[LS-MAIN] sharp-guard round' + round + ' ratio=' + ratio.toFixed(2) + ' (got=' + Math.round(got) + ' ref=' + Math.round(refLap) + ')');
            if (ratio >= 0.7) return;
            if (round === 1) {
              applyZoomHeal(1.02);
              setTimeout(check, 700);
            } else if (round === 2) {
              applyBoundsNudgeHeal();
              setTimeout(check, 700);
            } else {
              console.error('[LS-MAIN] sharp-guard give-up after zoom+bounds heal (ratio=' + ratio.toFixed(2)
                + '; suspect guard sampling artifact, export file unaffected)');
            }
          })
          .catch(() => { /* ignore */ });
      };
      setTimeout(check, 900);
    } catch (err) {
      console.error('[LS-MAIN] sharp-guard failed', (err as Error)?.message);
    }
  };

  /** 长截图编辑态：渲染端把整图载入编辑器后，主进程把截图窗尺寸改成整图大小（夹在屏幕内），
   * 让长图像正常截图结果一样可标注/OCR/翻译/保存；超出屏幕部分由 body 纵向滚动（is-longshot-edit）。
   * r27/r29: 窗口尺寸变化可能触发软件合成栅格尺度失效（编辑器整窗持久发虚的实测根因），
   * 附参考补丁做渲染清晰度闭环自愈（见 lsEditorSharpnessGuard，r55 升级为梯度自愈）。
   * r56: 窗口**始终**缩放到结果尺寸（走既有的屏外先改、200ms 挪回安全路径）——
   * 此前"窗口≥目标就保持全屏"的 move-only 策略留下大片露底区域，被用户持续感知为灰色"阴影区"；
   * 露底根治后由 sharp-guard 继续守护清晰度。 */
  ipcMain.on('capture-longshot-editor', (_event, payload) => {
    const captureWindow = options.getCaptureWindow();
    if (!captureWindow || captureWindow.isDestroyed()) return;
    try {
      const w = Math.max(1, Math.round(payload && payload.w ? payload.w : 0));
      const h = Math.max(1, Math.round(payload && payload.h ? payload.h : 0));
      if (w < 1 || h < 1) return;
      const display = screen.getDisplayMatching(captureWindow.getBounds());
      const wa = display.workAreaSize;
      // 底部预留工具栏高度：编辑态工具栏 fixed 在窗口底部（约 80px + 底部 28px 安全距），
      // 窗口若只比图片高几十 px，工具栏会整个叠在图上（实测遮挡）。图片高于屏幕时无法预留，
      // 工具栏悬浮在图上属常规编辑器行为。
      const LS_EDITOR_TOOLBAR_RESERVE = 170;
      const LS_BOTTOM_GAP = 24;
      const eh = Math.max(240, Math.min(h + LS_EDITOR_TOOLBAR_RESERVE + LS_BOTTOM_GAP, wa.height - 40));
      // r56: 图高于窗口会出现纵向滚动条（约 17~24 CSS px），给宽度留出余量，
      // 否则画布右缘被滚动条区域裁掉，导出 1:1 的图在编辑器里看不全。
      const needsVScroll = h + LS_EDITOR_TOOLBAR_RESERVE + LS_BOTTOM_GAP > wa.height - 40;
      const ew = Math.max(320, Math.min(w + (needsVScroll ? 24 : 0), wa.width - 40));
      const bx = display.workArea.x + Math.max(0, Math.round((wa.width - ew) / 2));
      const by = display.workArea.y + Math.max(0, Math.round((wa.height - eh) / 2));
      try { captureWindow.setResizable(true); } catch (_) { /* ignore */ }
      const cur = captureWindow.getBounds();
      // r56: 编辑器窗口始终缩放到结果尺寸——"窗口比结果大"的露底区域被用户持续感知为
      // 灰色"阴影区"（漂移的深/浅色处理都治标不治本），根治 = 窗口贴住结果。
      // 走既有的屏外先改尺寸、200ms 挪回屏内的安全路径（栅格按目标尺寸重建，避开可见中间态）；
      // 清晰度由 lsEditorSharpnessGuard 守护。当前尺寸已精确等于目标时仅居中挪动，避免无谓闪动。
      let resized = true;
      if (cur.width === ew && cur.height === eh) {
        captureWindow.setBounds({ x: bx, y: by, width: cur.width, height: cur.height });
        resized = false;
        console.error('[LS-MAIN] editor window exact-fit @' + bx + ',' + by + ' (' + ew + 'x' + eh + ')');
      } else {
        captureWindow.setBounds({ x: bx - ew - 300, y: by, width: ew, height: eh });
        setTimeout(() => {
          try {
            if (!captureWindow.isDestroyed()) captureWindow.setBounds({ x: bx, y: by, width: ew, height: eh });
          } catch (_) { /* ignore */ }
        }, 200);
        console.error('[LS-MAIN] editor window resize offscreen-first -> ' + ew + 'x' + eh + ' (was ' + cur.width + 'x' + cur.height + ')');
      }
      const ref = payload && payload.ref;
      if (ref && ref.dataURL && ref.w >= 8 && ref.h >= 8) lsEditorSharpnessGuard(captureWindow, ref, resized);
    } catch (err) {
      console.error('[LS-MAIN] editor resize failed', (err as Error)?.message);
    }
  });

  /* 拼接预览改为渲染端直接在窗口内绘制（#longShotPreview），不再用独立浮层窗 */

  /** 录屏透传：光标进录制区 → forward 透传（可操作被录应用），移出（到录制条）→ 恢复 */
  ipcMain.on('capture-record-ignore-mouse', (_event, ignore: boolean) => {
    console.error(`[REC-MAIN] ignoreMouse <- ${ignore}`);
    const captureWindow = options.getCaptureWindow();
    if (!captureWindow || captureWindow.isDestroyed()) return;
    try {
      if (ignore) captureWindow.setIgnoreMouseEvents(true, { forward: true });
      else captureWindow.setIgnoreMouseEvents(false);
    } catch (err) {
      console.error('[REC-MAIN] setIgnoreMouseEvents failed', err);
    }
  });

  // 应用退出时兜底注销热键 + 停止长截图光标轮询
  app.once('will-quit', () => {
    unregisterLsHotkeys();
    lsStopPolling(); // 长截图光标轮询兜底停止
  });

  ipcMain.on('capture-save', async (_event, { dataURL, filename }: { dataURL: string; filename?: string }) => {
    try {
      const image = nativeImage.createFromDataURL(dataURL);
      const pngBuffer = image.toPNG();
      if (!pngBuffer || pngBuffer.length === 0) return;
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      // 长截图结果编辑态会传入「长截图_年月日时分秒_1」默认名；普通截图沿用原名
      const baseName = filename || `eIsland_screenshot_${timestamp}`;
      const dialogOptions = {
        title: '保存截图',
        defaultPath: join(app.getPath('pictures'), `${baseName}.png`),
        filters: [{ name: 'PNG', extensions: ['png'] }],
      };
      // 对话框必须挂到截图窗上（modal + owned）：否则它是普通 z-order 窗口，会落在
      // screen-saver 置顶的截图窗下面 →「没有位于最上方，其他页面还能点」。
      // 挂上父窗后：对话框置顶于截图窗之上，且模态禁用父窗，关掉前无法操作其他页面。
      const captureWindow = options.getCaptureWindow();
      const result = captureWindow && !captureWindow.isDestroyed()
        ? await dialog.showSaveDialog(captureWindow, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions);
      // 先弹文件选择器；未确认（取消或关掉对话框）→ 不退出，回到截图面板
      if (!result.canceled && result.filePath) {
        writeFileSync(result.filePath, pngBuffer);
        options.closeCaptureWindow();
      }
      // 取消/关闭对话框：窗口保持原样，用户继续编辑
    } catch (err) {
      console.error('[Screenshot] save error:', err);
    }
  });

  /** 长截图超限拆分：直接把 N 张瓦片写入图片目录（保存对话框不支持多文件，故不走对话框） */
  ipcMain.on('capture-longshot-save', (_event, { images, baseName }: { images: string[]; baseName: string }) => {
    try {
      const dir = app.getPath('pictures');
      const list = Array.isArray(images) ? images : [];
      for (let i = 0; i < list.length; i++) {
        const img = nativeImage.createFromDataURL(list[i]);
        writeFileSync(join(dir, `${baseName}_${i + 1}.png`), img.toPNG());
      }
      console.error('[LS] saved tiles:', list.length, '->', dir);
    } catch (err) {
      console.error('[LS] save tiles error:', err);
    }
  });

  ipcMain.on('capture-cancel', () => {
    options.closeCaptureWindow();
  });

  /** 渲染进程崩溃留痕：capture.js 的未捕获异常/拒绝经此上报，复现「移动即退」时可定位根因 */
  ipcMain.on('capture-log', (_event, payload: { type?: string; message?: string; stack?: string }) => {
    const msg = payload && typeof payload === 'object' ? payload : {};
    console.error('[capture-renderer]', msg.type || 'log', msg.message || '', msg.stack ? `\n${msg.stack}` : '');
  });

  /** 本地版面 OCR（保留格式：图表/表格/公式 → 图 + 结构化文本） */
  ipcMain.handle('capture-ocr-local-layout', async (event, payload: {
    dataURL: string;
  }) => {
    const captureWindow = options.getCaptureWindow();
    if (!captureWindow || captureWindow.isDestroyed() || event.sender.id !== captureWindow.webContents.id) {
      return { success: false, code: 'captureWindowClosed' };
    }

    const controller = new AbortController();
    const abort = (): void => controller.abort();
    event.sender.once('destroyed', abort);
    try {
      return await recognizeWithPaddleOcrLayout(
        typeof payload?.dataURL === 'string' ? payload.dataURL : '',
        controller.signal,
      );
    } finally {
      event.sender.removeListener('destroyed', abort);
    }
  });

  /** 版面模型加载状态查询：首次调用会下载数百 MB 模型，前端据此提示「正在下载模型」而非干等 */
  ipcMain.handle('capture-ocr-layout-status', async (event) => {
    const captureWindow = options.getCaptureWindow();
    if (!captureWindow || captureWindow.isDestroyed() || event.sender.id !== captureWindow.webContents.id) {
      return { success: false };
    }
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    event.sender.once('destroyed', abort);
    try {
      return await getLayoutOcrStatus(controller.signal);
    } finally {
      event.sender.removeListener('destroyed', abort);
    }
  });

  /** 渲染端按 Esc 取消进行中的版面 OCR（中断等待；python 侧模型加载会缓存，下次秒用） */
  ipcMain.handle('capture-ocr-layout-cancel', (event) => {
    const captureWindow = options.getCaptureWindow();
    if (!captureWindow || captureWindow.isDestroyed() || event.sender.id !== captureWindow.webContents.id) {
      return false;
    }
    cancelPendingLayoutOcr();
    return true;
  });

  /** #91 录屏：把渲染端合成的 webm 缓冲写入用户选定的文件（默认「视频」目录） */
  ipcMain.handle('capture-record-save', async (_event, payload: { buffer?: ArrayBuffer }) => {
    try {
      const buf = payload && payload.buffer ? Buffer.from(payload.buffer) : null;
      if (!buf || buf.length === 0) return false;
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const dialogOptions = {
        title: '保存录屏',
        defaultPath: join(app.getPath('videos'), `eIsland_recording_${timestamp}.webm`),
        filters: [{ name: 'WebM', extensions: ['webm'] }],
      };
      const captureWindow = options.getCaptureWindow();
      const result = captureWindow && !captureWindow.isDestroyed()
        ? await dialog.showSaveDialog(captureWindow, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions);
      if (!result.canceled && result.filePath) {
        writeFileSync(result.filePath, buf);
        console.error(`[REC-MAIN] saved ${result.filePath} (${buf.length} bytes)`);
        return true;
      }
      console.error(`[REC-MAIN] save canceled=${result.canceled}`);
    } catch (err) {
      console.error('[Record] save error:', err);
    }
    return false;
  });
}

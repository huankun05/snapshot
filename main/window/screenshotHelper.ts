/*
 * eIsland - A sleek, Apple Dynamic Island inspired floating widget for Windows, built with Electron.
 * https://github.com/JNTMTMTM/eIsland
 *
 * Copyright (c) 2026 JNTMTMTM
 * Copyright (c) 2026 pyisland.com
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
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * @file screenshotHelper.ts
 * @description Windows 主屏幕截图辅助模块，优先加载原生插件，失败时回退到 desktopCapturer
 *   可见窗口枚举：插件不可用时用 koffi EnumWindows 回退（智能选框依赖此数据）
 */

import { join } from 'path';

interface ScreenshotResult {
  data: Buffer;
  size: number;
  format: 'png';
}

export interface VisibleWindowBounds {
  hwnd: string;
  title: string;
  processId: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WindowsScreenshotHelper {
  capturePrimaryDisplayPng: () => ScreenshotResult | null;
  captureAllDisplaysPng?: () => ScreenshotResult | null;
  getVisibleWindows?: () => VisibleWindowBounds[];
  getLastError?: () => string;
}

let cachedHelper: WindowsScreenshotHelper | null | undefined;
let hasLoggedLoadFailure = false;
let hasLoggedEnumFallback = false;

function loadWindowsScreenshotHelper(): WindowsScreenshotHelper | null {
  if (process.platform !== 'win32') return null;
  if (cachedHelper !== undefined) return cachedHelper;

  const candidates = [
    '@eisland/windows-screenshot-helper',
    join(process.cwd(), 'plugins', 'eisland-windows-screenshot-helper'),
  ];

  const errors: string[] = [];
  const loaded = candidates.some((candidate) => {
    try {
      cachedHelper = require(candidate) as WindowsScreenshotHelper;
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`  ${candidate}: ${msg}`);
      return false;
    }
  });

  if (!loaded && !hasLoggedLoadFailure) {
    hasLoggedLoadFailure = true;
    console.warn('[ScreenshotHelper] native helper unavailable, fallback to desktopCapturer:\n' + errors.join('\n'));
  }

  if (!loaded) cachedHelper = null;
  return cachedHelper ?? null;
}

/**
 * Win32 绑定单例：koffi 的结构体类型名是进程级全局注册，`koffi.struct('RECT_W', …)` 写在函数体里
 * 会在第二次调用抛 `Duplicate type name`（2026-09-17 智能选区诊断根因之一：窗口枚举第二次会话起恒空、
 * 光标下窗口每帧抛错）。所有 koffi 加载/注册/绑定集中在此只做一次。
 */
type Win32Bindings = {
  koffi: any;
  IsWindowVisible: (h: number) => number;
  GetWindowRect: (h: number, rect: Buffer) => number;
  GetWindowThreadProcessId: (h: number, pid: Buffer) => number;
  GetWindowTextLengthW: (h: number) => number;
  GetWindowTextW: (h: number, buf: Buffer, max: number) => number;
  GetCurrentProcessId: () => number;
  GetShellWindow: () => number | bigint;
  GetDesktopWindow: () => number | bigint;
  EnumWindows: (proc: unknown, lParam: number) => number;
  WindowFromPoint: (pt: Buffer) => number | bigint;
  GetAncestor: (h: number, flags: number) => number | bigint;
  GetWindow: (h: number, cmd: number) => number | bigint;
  enumProcType: unknown;
};
let win32Cache: Win32Bindings | null | undefined;

function getWin32(): Win32Bindings | null {
  if (win32Cache !== undefined) return win32Cache;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    koffi.struct('RECT_W', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
    koffi.struct('POINT_W', { x: 'long', y: 'long' });
    win32Cache = {
      koffi,
      IsWindowVisible: user32.func('int IsWindowVisible(uint64_t hWnd)'),
      GetWindowRect: user32.func('int GetWindowRect(uint64_t hWnd, RECT_W *rect)'),
      GetWindowThreadProcessId: user32.func('uint32_t GetWindowThreadProcessId(uint64_t hWnd, uint32_t *pid)'),
      GetWindowTextLengthW: user32.func('int GetWindowTextLengthW(uint64_t hWnd)'),
      GetWindowTextW: user32.func('int GetWindowTextW(uint64_t hWnd, uint16_t *buf, int max)'),
      GetCurrentProcessId: kernel32.func('uint32_t GetCurrentProcessId()'),
      GetShellWindow: user32.func('uint64_t GetShellWindow()'),
      GetDesktopWindow: user32.func('uint64_t GetDesktopWindow()'),
      EnumWindows: user32.func('int EnumWindows(void *lpEnumFunc, intptr_t lParam)'),
      WindowFromPoint: user32.func('uint64_t WindowFromPoint(POINT_W p)'),
      GetAncestor: user32.func('uint64_t GetAncestor(uint64_t hWnd, uint32_t gaFlags)'),
      GetWindow: user32.func('uint64_t GetWindow(uint64_t hWnd, uint32_t cmd)'),
      enumProcType: koffi.pointer(koffi.proto('bool __stdcall (uint64_t, intptr_t)')),
    };
  } catch (err) {
    console.warn('[ScreenshotHelper] koffi Win32 bindings unavailable:', err);
    win32Cache = null;
  }
  return win32Cache;
}

/** koffi EnumWindows 回退：无原生插件时枚举可见顶层窗口（智能选框数据源） */
function enumVisibleWindowsKoffi(): VisibleWindowBounds[] {
  const out: VisibleWindowBounds[] = [];
  const w32 = getWin32();
  if (!w32) return out;
  try {
    const {
      koffi, IsWindowVisible, GetWindowRect, GetWindowThreadProcessId, GetWindowTextLengthW,
      GetWindowTextW, GetCurrentProcessId, GetShellWindow, GetDesktopWindow, EnumWindows, enumProcType,
    } = w32;

    const selfPid = GetCurrentProcessId();
    const shellHwnd = Number(GetShellWindow());
    const desktopHwnd = Number(GetDesktopWindow());
    const ourHandles = new Set<string>();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { BrowserWindow } = require('electron');
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w || w.isDestroyed()) continue;
      try {
        const buf = w.getNativeWindowHandle();
        const h = buf.byteLength >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
        ourHandles.add(h.toString());
        ourHandles.add(Number(h).toString());
      } catch { /* ignore */ }
    }

    const rectBuf = Buffer.alloc(16);
    const pidBuf = Buffer.alloc(4);
    const cbType = enumProcType;

    const enumProc = koffi.register((hWnd: number | bigint) => {
      const h = Number(hWnd);
      if (!h || h === shellHwnd || h === desktopHwnd) return true;
      if (ourHandles.has(String(h))) return true;
      try {
        if (!IsWindowVisible(h)) return true;
        if (!GetWindowRect(h, rectBuf)) return true;
        const left = rectBuf.readInt32LE(0);
        const top = rectBuf.readInt32LE(4);
        const right = rectBuf.readInt32LE(8);
        const bottom = rectBuf.readInt32LE(12);
        const width = right - left;
        const height = bottom - top;
        if (width < 40 || height < 40) return true;
        if (!GetWindowThreadProcessId(h, pidBuf)) return true;
        const pid = pidBuf.readUInt32LE(0);
        if (pid === selfPid) return true;

        let title = '';
        const len = GetWindowTextLengthW(h);
        if (len > 0 && len < 512) {
          const tbuf = Buffer.alloc((len + 1) * 2);
          GetWindowTextW(h, tbuf, len + 1);
          title = tbuf.toString('utf16le').replace(/\0+$/, '');
        }
        if (!title && width < 80 && height < 80) return true;

        out.push({
          hwnd: h.toString(16),
          title,
          processId: pid,
          x: left,
          y: top,
          width,
          height,
        });
      } catch { /* single window fail */ }
      return true;
    }, cbType);

    EnumWindows(enumProc, 0);
    koffi.unregister(enumProc);

    if (!hasLoggedEnumFallback) {
      hasLoggedEnumFallback = true;
      console.log(`[ScreenshotHelper] koffi EnumWindows fallback: ${out.length} windows`);
    }
  } catch (err) {
    console.warn('[ScreenshotHelper] koffi EnumWindows failed:', err);
  }
  return out;
}

/**
 * 截取主显示器画面并返回 PNG Buffer
 * @description 优先使用原生插件截屏，插件不可用时返回 null 以触发 desktopCapturer 回退
 * @returns PNG 格式的 Buffer，截屏失败或插件不可用时返回 null
 */
export function capturePrimaryDisplayPng(): Buffer | null {
  const helper = loadWindowsScreenshotHelper();
  if (!helper) return null;

  try {
    const result = helper.capturePrimaryDisplayPng();
    if (!result || !Buffer.isBuffer(result.data) || result.data.length === 0 || result.format !== 'png') {
      const lastError = helper.getLastError?.();
      if (lastError) console.warn('[ScreenshotHelper] capture failed:', lastError);
      return null;
    }
    return result.data;
  } catch (err) {
    console.warn('[ScreenshotHelper] capture error, fallback to desktopCapturer:', err);
    return null;
  }
}

/**
 * 截取所有显示器画面（虚拟屏幕）并返回 PNG Buffer
 * @description 优先使用原生插件截取全部多显示器画面，插件不可用时返回 null
 * @returns PNG 格式的 Buffer，截屏失败或插件不可用时返回 null
 */
export function captureAllDisplaysPng(): Buffer | null {
  const helper = loadWindowsScreenshotHelper();
  if (!helper?.captureAllDisplaysPng) return null;

  try {
    const result = helper.captureAllDisplaysPng();
    if (!result || !Buffer.isBuffer(result.data) || result.data.length === 0 || result.format !== 'png') {
      const lastError = helper.getLastError?.();
      if (lastError) console.warn('[ScreenshotHelper] capture all displays failed:', lastError);
      return null;
    }
    return result.data;
  } catch (err) {
    console.warn('[ScreenshotHelper] capture all displays error:', err);
    return null;
  }
}

/**
 * 获取所有可见窗口的位置和尺寸信息
 * @description 优先原生插件；不可用时 koffi EnumWindows 回退（智能选框必需）
 */
export function getVisibleWindows(): VisibleWindowBounds[] {
  const helper = loadWindowsScreenshotHelper();
  if (helper?.getVisibleWindows) {
    try {
      const windows = helper.getVisibleWindows();
      if (Array.isArray(windows) && windows.length > 0) return windows;
    } catch (err) {
      console.warn('[ScreenshotHelper] plugin window bounds failed, fallback koffi:', err);
    }
  }
  return enumVisibleWindowsKoffi();
}

/** 光标下「顶层主窗口」：跳过本进程截图窗（全屏挡在最上层），再 GA_ROOT。 */
export function getTopLevelWindowAtPoint(screenX: number, screenY: number): VisibleWindowBounds | null {
  const w32 = getWin32();
  if (!w32) return null;
  try {
    const {
      WindowFromPoint, GetAncestor, GetWindow, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
      GetWindowThreadProcessId, IsWindowVisible, GetCurrentProcessId,
    } = w32;
    const selfPid = GetCurrentProcessId();
    const GW_HWNDNEXT = 2;

    const rectBuf = Buffer.alloc(16);
    const pidBuf = Buffer.alloc(4);
    const pt = Buffer.alloc(8);
    pt.writeInt32LE(Math.round(screenX), 0);
    pt.writeInt32LE(Math.round(screenY), 4);

    function infoOf(h: number): VisibleWindowBounds | null {
      if (!h) return null;
      const root = Number(GetAncestor(h, 2)) || Number(GetAncestor(h, 3)) || h;
      const hh = root || h;
      if (!IsWindowVisible(hh)) return null;
      if (!GetWindowRect(hh, rectBuf)) return null;
      const left = rectBuf.readInt32LE(0);
      const top = rectBuf.readInt32LE(4);
      const right = rectBuf.readInt32LE(8);
      const bottom = rectBuf.readInt32LE(12);
      if (screenX < left || screenX > right || screenY < top || screenY > bottom) return null;
      GetWindowThreadProcessId(hh, pidBuf);
      const pid = pidBuf.readUInt32LE(0);
      if (pid === selfPid) return null; // 截图窗自己
      let title = '';
      const len = GetWindowTextLengthW(hh);
      if (len > 0 && len < 512) {
        const tbuf = Buffer.alloc((len + 1) * 2);
        GetWindowTextW(hh, tbuf, len + 1);
        title = tbuf.toString('utf16le').replace(/\0+$/, '');
      }
      return {
        hwnd: hh.toString(16),
        title,
        processId: pid,
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
      };
    }

    let h = Number(WindowFromPoint(pt));
    // 命中自己 → 沿 z 序 GW_HWNDNEXT 找下层非本进程窗
    for (let i = 0; i < 64 && h; i++) {
      const info = infoOf(h);
      if (info) return info;
      h = Number(GetWindow(h, GW_HWNDNEXT));
    }
    return null;
  } catch (err) {
    console.warn('[ScreenshotHelper] getTopLevelWindowAtPoint failed:', err);
    return null;
  }
}

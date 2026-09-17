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

/** koffi EnumWindows 回退：无原生插件时枚举可见顶层窗口（智能选框数据源） */
function enumVisibleWindowsKoffi(): VisibleWindowBounds[] {
  const out: VisibleWindowBounds[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');

    koffi.struct('RECT_W', { left: 'long', top: 'long', right: 'long', bottom: 'long' });

    const IsWindowVisible = user32.func('int IsWindowVisible(uint64_t hWnd)');
    const GetWindowRect = user32.func('int GetWindowRect(uint64_t hWnd, RECT_W *rect)');
    const GetWindowThreadProcessId = user32.func('uint32_t GetWindowThreadProcessId(uint64_t hWnd, uint32_t *pid)');
    const GetWindowTextLengthW = user32.func('int GetWindowTextLengthW(uint64_t hWnd)');
    const GetWindowTextW = user32.func('int GetWindowTextW(uint64_t hWnd, uint16_t *buf, int max)');
    const GetCurrentProcessId = kernel32.func('uint32_t GetCurrentProcessId()');
    const GetShellWindow = user32.func('uint64_t GetShellWindow()');
    const GetDesktopWindow = user32.func('uint64_t GetDesktopWindow()');
    const EnumWindows = user32.func('int EnumWindows(void *lpEnumFunc, intptr_t lParam)');

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
    const cbType = koffi.pointer(koffi.proto('bool __stdcall (uint64_t, intptr_t)'));

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

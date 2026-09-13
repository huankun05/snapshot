/**
 * @file dwmTransition.ts
 * @description 用 koffi（N-API FFI）在主进程同步调用 dwmapi.dll 的 DwmSetWindowAttribute，
 *              在截图窗首次显示前禁用 DWM 开窗过渡动画（DWMWA_TRANSITIONS_FORCEDISABLED = 3）。
 *
 * 这是 Snipaste 等原生截图工具「无感进入」的真正做法：原生程序在主线程同步调 dwmapi，
 * 零冷启动，属性在窗口亮起前即生效，故窗口直接出现在最终位置、无由内向外扩张的动画。
 * Electron 网页进程不能直接调 Windows API，故用 koffi 在主进程加载 dwmapi.dll 同步调用。
 *
 * 安全边界：koffi 懒加载，且 require / 调用全程被 try-catch 包裹；任何失败（如打包后 N-API
 * 二进制与 Electron 不兼容）一律返回 false，调用方回退到「屏外 show + 延迟 move」方案，
 * 绝不让截图窗打不开或主进程崩溃。
 */

import { BrowserWindow } from 'electron';

type DwmDisableFn = (hwnd: Buffer) => boolean;

let cachedDisable: DwmDisableFn | null | undefined;

function resolveDisable(): DwmDisableFn | null {
  if (cachedDisable !== undefined) return cachedDisable;
  try {
    // 懒加载：避免 koffi 的 .node 二进制在 Electron 下不兼容时，于模块求值期直接让主进程崩溃。
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi');
    const dwmapi = koffi.load('dwmapi.dll');
    const DwmSetWindowAttribute = dwmapi.func(
      'long DwmSetWindowAttribute(void* hwnd, uint32_t dwAttribute, const void* pvAttribute, uint32_t cbAttribute)',
    );
    cachedDisable = (hwnd: Buffer): boolean => {
      try {
        // HWND 在 64 位 Windows 上是 8 字节句柄值；getNativeWindowHandle() 返回的正是这 8 字节，
        // 必须作为「数值」传给 void* 参数。若直接把 Buffer 当 void* 传入，koffi 会把 Buffer 的
        // 数据地址当作句柄值，导致 DwmSetWindowAttribute 收到一个无效堆地址（句柄失效）。
        // 32 位 Windows 上句柄为 4 字节，这里兼容处理。
        const handle =
          hwnd.byteLength >= 8 ? hwnd.readBigUInt64LE(0) : BigInt(hwnd.readUInt32LE(0));
        // DWMWA_TRANSITIONS_FORCEDISABLED = 3；pvAttribute 指向 BOOL(TRUE)，cbAttribute = sizeof(BOOL) = 4。
        const enabled = Buffer.alloc(4, 1);
        const hr = DwmSetWindowAttribute(handle, 3, enabled, 4);
        return hr === 0; // S_OK
      } catch {
        return false;
      }
    };
  } catch (err) {
    console.error('[DWM] koffi/DwmSetWindowAttribute 不可用，回退屏外 reveal：', (err as Error)?.message);
    cachedDisable = null;
  }
  return cachedDisable;
}

/**
 * 禁用某窗口的 DWM 开窗过渡动画。hwnd 直接传 Electron 的 getNativeWindowHandle() 返回值。
 * @returns true 表示已成功禁用（调用方即可放心在最终位置直接 show，无需屏外延迟）
 */
export function disableWindowTransition(win: BrowserWindow): boolean {
  const disable = resolveDisable();
  if (!disable) return false;
  try {
    const hwnd = win.getNativeWindowHandle();
    return disable(hwnd);
  } catch (err) {
    console.error('[DWM] getNativeWindowHandle/调用失败，回退屏外 reveal：', (err as Error)?.message);
    return false;
  }
}

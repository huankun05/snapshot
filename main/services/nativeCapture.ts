/**
 * nativeCapture.ts
 *
 * 截图引擎可插拔。当前策略（2026-09-03 调整）：默认走 Xiyue 内置 Electron 截图窗
 * （capture.js 全屏暗蒙版 + 选区原位高亮 + 工具栏，即仿 Snipaste 的 UI），不再自动
 * 发现/唤起 userData/native-capture/ 下的原生 exe。
 *
 * 只有当用户显式设置环境变量 XIYUE_NATIVE_CAPTURE_EXE 指向原生 exe 时，截图热键
 * 才改为唤起该工具（体验等同 Snipaste 原生框选，无 Electron 透明窗在 Win11 下的
 * 「闪黑 / 放大镜黑块」问题）。
 *
 * 启用方式：
 *   XIYUE_NATIVE_CAPTURE_EXE=<exe 绝对路径>   （如指向自研 native_shot.exe，见下）
 *   XIYUE_NATIVE_CAPTURE_ARGS=...             （可选，覆盖默认启动参数）
 * 启动参数（可选）：
 *   - 文件名含 "native_shot" → 无需参数（截完写临时 PNG + 选区元数据 + 剪贴板即退）
 *   - 文件名含 "screencapture"（xland）→ 自动用 "--auto-quit=true"
 *   - 其它工具回退 "--cap:custom,clipboard"
 */

import { spawn } from 'node:child_process';

const EXE_ENV = 'XIYUE_NATIVE_CAPTURE_EXE';
const ARGS_ENV = 'XIYUE_NATIVE_CAPTURE_ARGS';

/** 按 exe 名推断默认启动参数；可通过 XIYUE_NATIVE_CAPTURE_ARGS 覆盖。 */
function defaultArgsFor(exe: string): string[] {
  const base = exe.toLowerCase().replace(/\\/g, '/');
  // 自研 native_shot：截完写临时 PNG + 剪贴板即退，无需参数
  if (base.includes('native_shot')) return [];
  // xland/ScreenCapture：--auto-quit=true 让其即用即走，避免常驻托盘/重复占热键
  if (base.includes('screencapture')) return ['--auto-quit=true'];
  return ['--cap:custom,clipboard'];
}

/** 仅当环境变量显式指定 exe 时才启用原生截图；否则返回 null（走 Electron 内置窗）。 */
export function getNativeCaptureExePath(): string | null {
  const env = process.env[EXE_ENV];
  if (env && env.trim()) return env.trim();
  return null;
}

export function isNativeCaptureEnabled(): boolean {
  return getNativeCaptureExePath() !== null;
}

export interface NativeCaptureHooks {
  /** 唤起原生工具前隐藏主窗，避免被截进去 / 与全屏暗蒙版重叠。 */
  hideMainWindow: () => void;
  /** 原生工具退出后恢复主窗。 */
  showMainWindow: () => void;
}

/**
 * 唤起原生截图工具做一次区域截图（结果进剪贴板）。
 * 返回 true 表示原生工具成功跑完；false 表示未配置/启动失败，调用方应回退内置窗。
 */
export async function triggerNativeRegionCapture(hooks: NativeCaptureHooks): Promise<boolean> {
  const exe = getNativeCaptureExePath();
  if (!exe) return false;

  const args = process.env[ARGS_ENV]?.trim()
    ? process.env[ARGS_ENV]!.trim().split(/\s+/)
    : defaultArgsFor(exe);

  hooks.hideMainWindow();

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      hooks.showMainWindow();
      resolve(ok);
    };

    let child;
    try {
      child = spawn(exe, args, {
        windowsHide: true,
        stdio: 'ignore',
        detached: false,
      });
    } catch (err) {
      console.error('[NativeCapture] spawn failed:', (err as Error).message);
      finish(false);
      return;
    }

    child.on('error', (err) => {
      console.error('[NativeCapture] spawn error:', err.message);
      finish(false);
    });

    child.on('exit', (code) => {
      console.log(`[NativeCapture] capture process exited, code=${code}`);
      finish(code === 0);
    });

    // 安全兜底：用户取消/工具卡住时，30s 后强制恢复主窗，避免主窗一直隐藏。
    const watchdog = setTimeout(() => finish(false), 30000);
    // 不阻止 Electron 事件循环退出
    if (typeof watchdog.unref === 'function') watchdog.unref();
  });
}

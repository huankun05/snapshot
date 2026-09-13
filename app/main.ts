/*
 * eIsland Screenshot —— 截图功能独立应用
 *
 * 承载 OCR/screenshot 工作区提取的完整截图功能（区域截图/标注/贴图/长截图/OCR/翻译），
 * 以独立应用形态运行，与 Xiyue 完全隔离（独立 userData / 托盘 / 热键）。
 *
 * 构建: node build-host.js
 * 启动: electron.exe app/dist/main.js   （工作目录必须是 screenshot/，capture.html 按 cwd 定位）
 *
 * 触发: 全局热键 Alt+A（截图），或托盘菜单「截图」
 * 退出: 托盘菜单「退出」（贴图/截图窗口的关闭不会导致应用退出）
 */

import { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage } from 'electron';
import { mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { existsSync } from 'fs';
import { createCaptureWindowService } from '../main/window/captureWindow';
import { registerCaptureIpcHandlers } from '../main/ipc/window/capture';
import { registerScreenshotHotkeyIpcHandlers } from '../main/ipc/system/screenshotHotkey';
import { stopRapidOcrService } from '../main/services/rapidOcrService';
import {
  readScreenshotHotkeyConfig,
  SCREENSHOT_HOTKEY_STORE_KEY,
} from '../main/config/storeConfig';

let currentHotkey = '';
let tray: Tray | null = null;

// 单实例：双开会抢全局热键与托盘，旧实例残留时新实例直接退出
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

/** 资源定位：优先 cwd（启动目录=screenshot/），兜底 app 路径 */
function resPath(rel: string): string {
  const a = join(process.cwd(), rel);
  if (existsSync(a)) return a;
  return join(app.getAppPath(), rel);
}

const captureService = createCaptureWindowService({
  getMainWindow: () => null,
});

function registerHotkey(accelerator: string): boolean {
  if (currentHotkey) {
    try { globalShortcut.unregister(currentHotkey); } catch { /* ignore */ }
    currentHotkey = '';
  }
  if (!accelerator) return true;
  try {
    const ok = globalShortcut.register(accelerator, () => {
      captureService.triggerScreenshot().catch((err) => console.error('[App] trigger error:', err));
    });
    if (ok) currentHotkey = accelerator;
    return ok;
  } catch (err) {
    console.error('[App] register hotkey error:', err);
    return false;
  }
}

function createTray(): void {
  const icon = nativeImage.createFromPath(resPath(join('resources', 'icon', 'eisland_16x16.ico')));
  tray = new Tray(icon);
  tray.setToolTip('eIsland Screenshot');
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: `截图${currentHotkey ? `（${currentHotkey}）` : ''}`,
      click: () => {
        captureService.triggerScreenshot().catch((err) => console.error('[App] trigger error:', err));
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => app.quit(),
    },
  ]));
  tray.on('double-click', () => {
    captureService.triggerScreenshot().catch((err) => console.error('[App] trigger error:', err));
  });
}

app.whenReady().then(() => {
  const storeDir = join(app.getPath('userData'), 'eIsland_store');
  if (!existsSync(storeDir)) mkdirSync(storeDir, { recursive: true });

  registerCaptureIpcHandlers({
    getCaptureWindow: captureService.getCaptureWindow,
    closeCaptureWindow: captureService.closeCaptureWindow,
    triggerScreenshot: captureService.triggerScreenshot,
  });

  registerScreenshotHotkeyIpcHandlers({
    storeDir,
    screenshotHotkeyStoreKey: SCREENSHOT_HOTKEY_STORE_KEY,
    getCurrentScreenshotHotkey: () => currentHotkey,
    readScreenshotHotkeyConfig,
    getReservedHotkeys: () => [],
    registerScreenshotHotkey: registerHotkey,
  });

  // 测试辅助 IPC：DevTools / 外部可触发截图
  ipcMain.handle('host:trigger-screenshot', async () => {
    await captureService.triggerScreenshot();
    return true;
  });

  // capture.js 经 store:read 读 OCR/翻译引擎等配置（对齐 Xiyue registerStoreIpcHandlers 的最小子集）
  ipcMain.handle('store:read', (_e, storeKey: string) => {
    try {
      const filePath = join(app.getPath('userData'), 'eIsland_store', `${String(storeKey)}.json`);
      if (!existsSync(filePath)) return undefined;
      return JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch {
      return undefined;
    }
  });

  const hotkey = readScreenshotHotkeyConfig();
  const ok = registerHotkey(hotkey);
  createTray();

  console.log(`[App] eIsland Screenshot 就绪（独立应用）`);
  console.log(`[App] 热键 ${hotkey}: ${ok ? '已注册' : '注册失败（可能被微信等占用）'}`);
  console.log(`[App] 触发: 全局热键 / 托盘菜单 / 托盘双击`);
  console.log(`[App] userData: ${app.getPath('userData')}`);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  captureService.closeCaptureWindow();
  stopRapidOcrService();
  tray?.destroy();
});

/**
 * 贴图窗与截图窗都是普通 BrowserWindow：全部关闭不应退出（托盘应用语义），
 * 否则用户关掉最后一张贴图整个应用就没了。退出只走托盘「退出」。
 */
app.on('window-all-closed', () => {
  /* no-op：保持托盘常驻 */
});

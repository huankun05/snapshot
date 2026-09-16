/*
 * 拾花 PetalSnap —— 简约的 Windows 截图工具（独立应用宿主）
 *
 * 承载 OCR/screenshot 工作区提取的完整截图功能（区域截图/标注/贴图/长截图/OCR/翻译），
 * 以独立应用形态运行，与 Xiyue 完全隔离（独立 userData / 托盘 / 热键）。
 *
 * 构建: node build-host.js
 * 启动: electron.exe app/dist/main.js   （工作目录必须是 screenshot/，capture.html 按 cwd 定位）
 *
 * 触发: 全局热键（默认 Alt+Q），或托盘菜单「截图」/ 托盘双击
 * 退出: 托盘菜单「退出」（贴图/截图窗口的关闭不会导致应用退出）
 */

import { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage } from 'electron';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { existsSync } from 'fs';
import { createCaptureWindowService } from '../main/window/captureWindow';
import { registerCaptureIpcHandlers } from '../main/ipc/window/capture';
import { registerScreenshotHotkeyIpcHandlers } from '../main/ipc/system/screenshotHotkey';
import { ensureRapidOcrService, stopRapidOcrService } from '../main/services/rapidOcrService';
import {
  readScreenshotHotkeyConfig,
  SCREENSHOT_HOTKEY_STORE_KEY,
} from '../main/config/storeConfig';

let currentHotkey = '';
let tray: Tray | null = null;

// 独立隔离：以 JS 文件启动的 Electron 默认共用 "Electron" userData，
// 会和其他未打包应用共享单实例锁目录 → 必须在加锁前改到自己的 userData
app.setName('petalsnap');
const userDataDir = join(app.getPath('appData'), 'petalsnap');
// 定名前的 userData（eisland-screenshot）整体迁移：热键/引擎/翻译凭据等配置无损带过来，只做一次
const legacyUserDataDir = join(app.getPath('appData'), 'eisland-screenshot');
if (!existsSync(userDataDir) && existsSync(legacyUserDataDir)) {
  try {
    cpSync(legacyUserDataDir, userDataDir, { recursive: true });
  } catch (err) {
    console.error('[App] 旧配置迁移失败（将以默认配置启动）:', err);
  }
}
app.setPath('userData', userDataDir);

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
  // 托盘用 PNG 而非 ico：nativeImage 对 png 的 @2x 尺寸选取更稳；tray.png 是主稿的紧凑取景版
  const icon = nativeImage.createFromPath(resPath(join('resources', 'icon', 'tray.png')));
  tray = new Tray(icon);
  tray.setToolTip('拾花 PetalSnap');
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

  // store:write：语言选择等设置的持久化（缺失会导致下拉选择静默失败、永远读默认值）
  ipcMain.handle('store:write', (_e, storeKey: string, value: unknown) => {
    try {
      const dir = join(app.getPath('userData'), 'eIsland_store');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${String(storeKey)}.json`), JSON.stringify(value, null, 2), 'utf-8');
      return true;
    } catch (err) {
      console.error('[App] store write error:', err);
      return false;
    }
  });

  const hotkey = readScreenshotHotkeyConfig();
  let ok = registerHotkey(hotkey);
  if (!ok) {
    // 备用键链：默认键被占用（旧实例残留/其他软件）时自动降级
    for (const fallback of ['Ctrl+Alt+Q', 'Alt+Shift+S', 'Ctrl+Alt+S']) {
      if (registerHotkey(fallback)) { ok = true; break; }
    }
  }
  createTray();

  // 识别服务后台预热：Python 进程 + 三模型加载 + 预热推理在启动期完成，
  // 用户首次点 OCR 不再承担 4~6s 的冷启动（首次延迟问题的根治）
  setTimeout(() => {
    void ensureRapidOcrService().catch((err) => console.error('[App] OCR 预热失败:', err));
  }, 600);

  console.log(`[App] 拾花 PetalSnap 就绪（独立应用）`);
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

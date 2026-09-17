/*
 * 拾花 PetalSnap —— 简约的 Windows 截图工具（独立应用宿主）
 *
 * 构建: node build-host.js
 * 启动: electron.exe app/dist/main.js
 * 触发: 全局热键 / 托盘菜单 / 托盘双击
 * 设置: 托盘「设置…」
 */

import { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, dialog, shell } from 'electron';
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createCaptureWindowService } from '../main/window/captureWindow';
import { registerCaptureIpcHandlers } from '../main/ipc/window/capture';
import { registerScreenshotHotkeyIpcHandlers } from '../main/ipc/system/screenshotHotkey';
import { ensureRapidOcrService, stopRapidOcrService, getRapidOcrHealth, restartRapidOcrService } from '../main/services/rapidOcrService';
import { installAppLogging, getLogsDir } from '../main/services/appLogger';
import { openSettingsWindow } from './settings';
import {
  readScreenshotHotkeyConfig,
  SCREENSHOT_HOTKEY_STORE_KEY,
} from '../main/config/storeConfig';

let currentHotkey = '';
let tray: Tray | null = null;
let ocrPrewarmTimer: ReturnType<typeof setTimeout> | null = null;

app.setName('petalsnap');
const userDataDir = join(app.getPath('appData'), 'petalsnap');
const legacyUserDataDir = join(app.getPath('appData'), 'eisland-screenshot');
if (!existsSync(userDataDir) && existsSync(legacyUserDataDir)) {
  try {
    cpSync(legacyUserDataDir, userDataDir, { recursive: true });
  } catch (err) {
    console.error('[App] 旧配置迁移失败（将以默认配置启动）:', err);
  }
}
app.setPath('userData', userDataDir);

// 日志：控制台 + userData/logs/app-YYYY-MM-DD.log
installAppLogging();

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

function resPath(rel: string): string {
  const a = join(process.cwd(), rel);
  if (existsSync(a)) return a;
  return join(app.getAppPath(), rel);
}

function storeDirPath(): string {
  return join(app.getPath('userData'), 'eIsland_store');
}

function readStoreJson(storeKey: string): unknown {
  try {
    const filePath = join(storeDirPath(), `${storeKey}.json`);
    if (!existsSync(filePath)) return undefined;
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return undefined;
  }
}

function writeStoreJson(storeKey: string, value: unknown): void {
  const dir = storeDirPath();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${storeKey}.json`), JSON.stringify(value, null, 2), 'utf-8');
}

function readOcrWarmupMode(): string {
  const v = readStoreJson('screenshot-ocr-warmup');
  return v === 'resident' || v === 'on-demand' || v === 'capture-prewarm' ? v : 'capture-prewarm';
}

function prewarmOcr(reason: string): void {
  if (ocrPrewarmTimer) return;
  ocrPrewarmTimer = setTimeout(() => {
    ocrPrewarmTimer = null;
    void ensureRapidOcrService().catch((err) => console.error('[App] OCR 预热失败:', err));
  }, 200);
  console.log(`[App] OCR 预热排队 (${reason})`);
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
      if (readOcrWarmupMode() === 'capture-prewarm') prewarmOcr('hotkey');
      captureService.triggerScreenshot().catch((err) => console.error('[App] trigger error:', err));
    });
    if (ok) currentHotkey = accelerator;
    return ok;
  } catch (err) {
    console.error('[App] register hotkey error:', err);
    return false;
  }
}

function rebuildTray(): void {
  const hk = currentHotkey || readScreenshotHotkeyConfig();
  const warm = readOcrWarmupMode();
  tray?.setContextMenu(Menu.buildFromTemplate([
    {
      label: `截图${hk ? `（${hk}）` : ''}`,
      click: () => {
        if (warm === 'capture-prewarm') prewarmOcr('tray');
        captureService.triggerScreenshot().catch((err) => console.error('[App] trigger error:', err));
      },
    },
    {
      label: '截图并复制（Alt+C）',
      click: () => {
        if (warm === 'capture-prewarm') prewarmOcr('tray-copy');
        captureService.triggerScreenshot({ autoCopy: true })
          .catch((err) => console.error('[App] copy-shot error:', err));
      },
    },
    { type: 'separator' },
    {
      label: '设置…',
      click: () => {
        console.log('[Tray] menu click 设置');
        openSettingsWindow();
      },
    },
    {
      label: '重启识别服务',
      click: () => {
        console.log('[Tray] menu click 重启识别服务');
        void restartRapidOcrService().then((ok) => {
          console.log(`[Tray] 识别服务重启 ${ok ? '成功' : '失败'}`);
        }).catch((err) => console.error('[Tray] restart ocr error:', err));
      },
    },
    { type: 'separator' },
    {
      label: '打开日志目录',
      click: () => {
        void shell.openPath(getLogsDir()).catch(() => { /* ignore */ });
      },
    },
    {
      label: '打开配置目录',
      click: () => {
        void shell.openPath(storeDirPath()).catch(() => { /* ignore */ });
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => app.quit(),
    },
  ]));
}

function createTray(): void {
  const icon = nativeImage.createFromPath(resPath(join('resources', 'icon', 'tray.png')));
  tray = new Tray(icon);
  tray.setToolTip('拾花 PetalSnap');
  rebuildTray();
  tray.on('double-click', () => {
    if (readOcrWarmupMode() === 'capture-prewarm') prewarmOcr('tray-dbl');
    captureService.triggerScreenshot().catch((err) => console.error('[App] trigger error:', err));
  });
}

app.whenReady().then(() => {
  const storeDir = storeDirPath();
  if (!existsSync(storeDir)) mkdirSync(storeDir, { recursive: true });
  try { mkdirSync(getLogsDir(), { recursive: true }); } catch { /* ignore */ }

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
    registerScreenshotHotkey: (accel: string) => {
      const ok = registerHotkey(accel);
      rebuildTray();
      return ok;
    },
  });

  ipcMain.handle('host:trigger-screenshot', async () => {
    await captureService.triggerScreenshot();
    return true;
  });

  ipcMain.handle('store:read', (_e, storeKey: string) => {
    return readStoreJson(String(storeKey));
  });

  ipcMain.handle('store:write', (_e, storeKey: string, value: unknown) => {
    try {
      writeStoreJson(String(storeKey), value);
      return true;
    } catch (err) {
      console.error('[App] store write error:', err);
      return false;
    }
  });

  // ===== 设置窗 IPC =====
  ipcMain.on('settings:minimize', () => {
    const w = BrowserWindow.getFocusedWindow();
    w?.minimize();
  });
  ipcMain.on('settings:toggle-max', () => {
    const w = BrowserWindow.getFocusedWindow();
    if (!w) return;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
  });

  ipcMain.handle('settings:getLoginItem', () => {
    return app.getLoginItemSettings().openAtLogin === true;
  });
  ipcMain.handle('settings:setLoginItem', (_e, enable: boolean) => {
    app.setLoginItemSettings({ openAtLogin: enable === true, path: process.execPath });
    // 打包/脚本启动时额外带 args 更稳；开发态仅记开关
    try {
      app.setLoginItemSettings({
        openAtLogin: enable === true,
        path: process.execPath,
        args: app.isPackaged ? [] : ['app/dist/main.js'],
      });
    } catch { /* ignore */ }
    console.log(`[App] 开机自启=${enable === true}`);
    return true;
  });

  ipcMain.handle('settings:openPath', async (_e, which: string) => {
    const w = String(which || '');
    let target = '';
    if (w === 'logs') target = getLogsDir();
    else if (w === 'videos') target = app.getPath('videos');
    else if (w) target = w;
    if (!target || !existsSync(target)) {
      try { mkdirSync(target || getLogsDir(), { recursive: true }); } catch { /* ignore */ }
    }
    const err = await shell.openPath(target || getLogsDir());
    if (err) console.error('[Settings] openPath error:', err);
    return !err;
  });

  ipcMain.handle('settings:pickFolder', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    return r.filePaths[0];
  });

  ipcMain.handle('settings:appInfo', async () => {
    const h = await getRapidOcrHealth();
    return {
      version: app.getVersion() || '0.1.0',
      ocr: h.ok ? `${h.backend || 'GPU'} · ${h.build || 'ready'} · :${h.port}` : '未运行',
    };
  });

  ipcMain.handle('ocr:health', async () => getRapidOcrHealth());
  ipcMain.handle('ocr:restart', async () => {
    console.log('[App] OCR 服务重启（设置窗）');
    return restartRapidOcrService();
  });

  // OCR 识别路径按需拉起（on-demand / 识别时兜底）
  ipcMain.handle('ocr:ensure', async () => ensureRapidOcrService());

  const hotkey = readScreenshotHotkeyConfig();
  let ok = registerHotkey(hotkey);
  if (!ok) {
    for (const fallback of ['Ctrl+Alt+Q', 'Alt+Shift+S', 'Ctrl+Alt+S']) {
      if (registerHotkey(fallback)) { ok = true; break; }
    }
  }

  // 第二热键：截图并复制（框选完成即进剪贴板并退出，不进标注）
  const copyHk = 'Alt+C';
  let copyHkOk = false;
  try {
    copyHkOk = globalShortcut.register(copyHk, () => {
      if (readOcrWarmupMode() === 'capture-prewarm') prewarmOcr('copy-hotkey');
      captureService.triggerScreenshot({ autoCopy: true }).catch((err) => console.error('[App] copy-shot error:', err));
    });
  } catch (err) {
    console.error('[App] register copy hotkey error:', err);
  }
  console.log(`[App] 截图并复制热键 ${copyHk}: ${copyHkOk ? '已注册' : '注册失败（可能被占用）'}`);

  createTray();

  const warm = readOcrWarmupMode();
  if (warm === 'resident') {
    setTimeout(() => {
      void ensureRapidOcrService().catch((err) => console.error('[App] OCR 预热失败:', err));
    }, 600);
  } else {
    console.log(`[App] OCR 预热模式=${warm}（不在启动时加载）`);
  }

  console.log(`[App] 拾花 PetalSnap 就绪（独立应用）`);
  console.log(`[App] 热键 ${hotkey}: ${ok ? '已注册' : '注册失败（可能被微信等占用）'}`);
  console.log(`[App] 触发: 全局热键 / 托盘菜单 / 托盘双击`);
  console.log(`[App] 设置: 托盘「设置…」`);
  console.log(`[App] userData: ${app.getPath('userData')}`);
  console.log(`[App] logs: ${getLogsDir()}`);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  captureService.closeCaptureWindow();
  stopRapidOcrService();
  tray?.destroy();
});


app.on('window-all-closed', () => {
  /* 托盘常驻 */
});

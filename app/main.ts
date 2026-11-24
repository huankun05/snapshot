/*
 * 拾花 PetalSnap —— 简约的 Windows 截图工具（独立应用宿主）
 *
 * 构建: node build-host.js
 * 启动: electron.exe app/dist/main.js
 * 触发: 全局热键 / 托盘菜单 / 托盘双击
 * 设置: 托盘「设置…」
 */

import { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, dialog, shell, screen } from 'electron';
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createCaptureWindowService } from '../main/window/captureWindow';
import { registerCaptureIpcHandlers } from '../main/ipc/window/capture';
import { registerScreenshotHotkeyIpcHandlers } from '../main/ipc/system/screenshotHotkey';
import { ensureRapidOcrService, stopRapidOcrService, getRapidOcrHealth, restartRapidOcrService } from '../main/services/rapidOcrService';
import { downloadLangPack, downloadServiceModel, getLangPackStatus, getOcrChainStatus, getServiceModelStatuses } from '../main/services/ocrAssetsService';
import { backupNow, exportSettings, importSettings, listBackups, resolveBackupDir, restoreBackup } from '../main/services/settingsBackupService';
import { stopLocalOcrMtService } from '../main/services/localOcrMtService';
import { installAppLogging, getLogsDir } from '../main/services/appLogger';
import { openSettingsWindow } from './settings';
import { getTopLevelWindowAtPoint } from '../main/window/screenshotHelper';
import { smartUiaGetLevelsAsync, smartPixelFramePrepare, smartPixelDetectLevels, smartUiaGetMap } from '../main/services/smartUiaNative';
import {
  DEFAULT_LOCAL_OCR_DIR,
  readScreenshotHotkeyConfig,
  readScreenshotLocalOcrDirConfig,
  readScreenshotSaveDirConfig,
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

// 智能选区像素帧状态（模块级：smart:frame IPC 与 GDI 首帧直喂 onGdiFrame 共用）
let pixelFrameW = 0;
let pixelFrameH = 0;

const captureService = createCaptureWindowService({
  getMainWindow: () => null,
  // GDI 首帧直抓后主进程直接喂像素帧（BGRA；DLL 通道度量=三通道绝对差求和，对称，无需换序）：
  // 帧在亮窗前就绪，省渲染端 33MB getImageData+IPC —— 选框与蒙版同时出现（2026-09-23）
  onGdiFrame: (bgra, w, h) => {
    pixelFrameW = w;
    pixelFrameH = h;
    smartPixelFramePrepare(bgra, w, h);
  },
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
      label: '重启应用',
      click: () => {
        console.log('[Tray] menu click 重启应用');
        app.relaunch();
        app.exit(0);
      },
    },
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
  try {
    const dws = screen.getAllDisplays().map((d, i) => {
      const r = screen.dipToScreenRect(null, d.bounds);
      return `  #${i} id=${d.id} dip=(${d.bounds.x},${d.bounds.y},${d.bounds.width}x${d.bounds.height}) sf=${d.scaleFactor} phys=(${r.x},${r.y},${r.width}x${r.height})`;
    });
    console.error('[DisplayLayout] primary=' + screen.getPrimaryDisplay().id + '\n' + dws.join('\n'));
  } catch (e) { console.error('[DisplayLayout] failed', e); }
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
    else if (w === 'screenshots') target = readScreenshotSaveDirConfig() || app.getPath('pictures');
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

  // ===== OCR 可选资产（2026-11-22 缺口1/2：模型与语言包手动下载，不再静默联网）=====
  ipcMain.handle('ocr:asset-status', async () => {
    const models = await getServiceModelStatuses();
    return { models, langPack: getLangPackStatus() };
  });
  ipcMain.handle('ocr:model-download', async (_e, id: string) => {
    console.log('[App] OCR 模型手动下载:', id);
    return downloadServiceModel(String(id));
  });
  ipcMain.handle('ocr:langpack-status', async () => getLangPackStatus());
  ipcMain.handle('ocr:langpack-download', async () => {
    console.log('[App] Tesseract 语言包手动下载');
    return downloadLangPack();
  });

  // ===== 设置备份（2026-11-23 通用页「保存」分组）=====
  ipcMain.handle('settings:backup-now', async () => backupNow());
  ipcMain.handle('settings:export', async (e) => exportSettings(BrowserWindow.fromWebContents(e.sender)));
  ipcMain.handle('settings:import', async (e) => importSettings(BrowserWindow.fromWebContents(e.sender)));
  // 备份列表/一键恢复：渲染端 settings.js 双份同源，F1 漏注册会让「最近备份」永远显示读取失败
  ipcMain.handle('settings:backup-list', async () => listBackups());
  ipcMain.handle('settings:backup-restore', async (_e, name: string) => restoreBackup(String(name)));
  ipcMain.handle('settings:backup-dir', async () => {
    const dir = resolveBackupDir();
    try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    return dir;
  });

  // 引擎优先级链状态（设置页灰/红/下载图标展示；探测不拉起服务）
  ipcMain.handle('ocr:chain-status', async () => {
    const token = readStoreJson('user-account-token');
    const loggedIn = typeof token === 'string' && token.trim().length > 0;
    const paddleModelsOk = (): boolean => {
      try {
        const dir = join(readScreenshotLocalOcrDirConfig() || DEFAULT_LOCAL_OCR_DIR, 'models', 'official_models', 'PP-OCRv5_mobile_det');
        return existsSync(dir);
      } catch {
        return false;
      }
    };
    return getOcrChainStatus(() => loggedIn, paddleModelsOk);
  });

  /**
   * 智能选区：窗口 CSS ↔ 虚拟屏物理 + 原生 UIA。
   * IDLE 悬停期间保持 click-through（forward），避免每帧 setIgnoreMouseEvents 造成卡顿。
   *
   * 坐标模型（2026-09-30 定案，[COORD] 日志 1322 条采样实锤）：
   * 单窗覆盖全虚拟屏，窗口只有一个 dpr（canvasDpr = 主屏 scaleFactor），窗口物理原点
   * = virtualScreen.x × dpr。**窗口 CSS 是单一均匀线性空间**，因此与像素链
   * （smart:pixel-at，同一个 canvasDpr）必须共用一个换算：
   *     phys = (css + vs) × winDpr        窗口 CSS → 绝对虚拟屏物理
   *     css  = phys / winDpr − vs        绝对物理 → 窗口 CSS
   *
   * ⚠️ 此前走 dipToScreenPoint / screenToDipPoint（按"点所在屏"各取自己的 scaleFactor）
   * 是错的：那套 API 假设输入是**逐屏按各自 sf 铺开的虚拟桌面 DIP**，而窗口是单一 dpr
   * 表面，副屏内容在窗口里被统一按主屏 dpr 摆放。两屏 sf 不同（125% vs 150%）时纯平移
   * 必然错位——副屏最深处偏差 341 dip = 511 物理 px（vsX 是物理÷1.25，不是 DIP 原点；
   * 副屏真实 dip 范围 -1707~0）。平移改原点治不了，必须避免 DIP 中转。
   */
  ipcMain.handle('smart:at-point', async (_e, p: { x: number; y: number; vsX?: number; vsY?: number; sf?: number }) => {
    const t0 = Date.now();
    const vsX = p?.vsX || 0;
    const vsY = p?.vsY || 0;
    // winDpr = 帧 backing 比（渲染端按 bgCanvas.width / W 传）= 窗口 dpr。本路径下
    // screen 的 scaleFactor 字段被 captureWindow 写成 1，不能用全局 scaleFactor 猜。
    const winDpr = p?.sf && p.sf > 0 ? p.sf : (screen.getPrimaryDisplay().scaleFactor || 1);
    const physX = Math.round(((p?.x || 0) + vsX) * winDpr);
    const physY = Math.round(((p?.y || 0) + vsY) * winDpr);
    // 物理 → 窗口 CSS：与上面互为逆运算。不再按"矩形所在屏"二次取 sf（同一错误模型）。
    const physToCssX = (n: number) => Math.round(n / winDpr) - vsX;
    const physToCssY = (n: number) => Math.round(n / winDpr) - vsY;

    // worker 线程执行（跨进程 COM 等待不阻塞主进程），连发自动合并
    const native = await smartUiaGetLevelsAsync(physX, physY);
    let levels: Array<{
      x: number; y: number; width: number; height: number;
      name?: string; controlType?: string;
    }> = [];
    if (native.ok && native.levels.length) {
      // 物理矩形 → 窗口 css：与查询点同一套换算（÷winDpr 后减窗口原点），
      // 保证"查得准"与"画得对"严格同源——不再按矩形所在屏二次取 sf。
      levels = native.levels.map((lv) => ({
        x: physToCssX(lv.x),
        y: physToCssY(lv.y),
        width: Math.round(lv.width / winDpr),
        height: Math.round(lv.height / winDpr),
        name: lv.name,
        controlType: lv.controlType,
      }));
    }

    let winCss = null;
    if (native.ok && native.window && native.window.width >= 80) {
      winCss = {
        x: physToCssX(native.window.x),
        y: physToCssY(native.window.y),
        width: Math.round(native.window.width / winDpr),
        height: Math.round(native.window.height / winDpr),
        title: native.window.name || '',
      };
    } else {
      const win = getTopLevelWindowAtPoint(physX, physY);
      if (win) {
        winCss = {
          x: physToCssX(win.x),
          y: physToCssY(win.y),
          width: Math.round(win.width / winDpr),
          height: Math.round(win.height / winDpr),
          title: win.title,
        };
      }
    }

    // 原生无结果才回退 Python UIA（2026-09-28 降级：只在 18766 **已在运行**时搭车查询，
    // 不再 ensureRapidOcrService 冷启动——为一次悬停拉起整个 Python OCR（2.2s+ 模型初始化
    // + GB 级常驻）曾是恶性路径；地图优先架构下此处命中率极低，像素链已是双保险。
    // 探测用 300ms 短超时 fetch（getRapidOcrHealth 的 4s 超时对悬停路径太长）。
    let pyUiaWarm = false;
    if (!levels.length) {
      try {
        const h = await fetch('http://127.0.0.1:18766/health', { signal: AbortSignal.timeout(300) });
        pyUiaWarm = h.ok;
      } catch { /* 未运行 */ }
    }
    if (pyUiaWarm) {
      try {
        const res = await fetch('http://127.0.0.1:18766/uia', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ x: physX, y: physY }),
          signal: AbortSignal.timeout(500),
        });
        const data = await res.json();
        if (data && Array.isArray(data.levels)) {
          levels = data.levels
            .filter((lv: { width: number; height: number }) => lv.width > 0 && lv.height > 0)
            .map((lv: { left: number; top: number; width: number; height: number; name?: string; controlType?: string }) => ({
              x: physToCssX(lv.left),
              y: physToCssY(lv.top),
              width: Math.round(lv.width / winDpr),
              height: Math.round(lv.height / winDpr),
              name: lv.name,
              controlType: lv.controlType,
            }));
        }
      } catch { /* optional */ }
    }

    const elem = levels.length ? levels[0] : null;
    if (process.env.PETALSNAP_SMART_DEBUG) {
      const l0 = levels[0];
      // 同时打出两套换算结果，便于对照像素链（winDpr 恒等）与旧路径（按屏 sf）：
      // 修复后 phys 必须恒等于 (css+vs)×winDpr，与 smart:pixel-at 完全一致。
      console.error(`[COORD] css=(${p?.x},${p?.y}) vs=(${vsX},${vsY}) dpr=${winDpr} phys=(${physX},${physY})`
        + ` native=${native.ok} n=${levels.length}`
        + (l0 ? ` l0css=(${l0.x},${l0.y},${l0.width}x${l0.height})` : ''));
    }
    return {
      window: winCss,
      element: elem,
      levels,
      diag: { dllMs: native.diag?.ms ?? null, src: native.diag?.src ?? null, totalMs: Date.now() - t0 },
    };
  });

  /**
   * 整窗元素图下发（2026-09-30，方案 A：查询下沉渲染端）。
   *
   * 背景（[SMART-DIAG] 实锤）：`dll=0ms`、地图命中 0ms，但 `total=678-1635ms` —— 时间不在
   * 识别上，全在「等 worker」。worker 单线程串行，而快照(~200ms)/poke(≤120ms)/EFP(240-400ms)/
   * 交叉校验探针全是同线程同步调用，建图期间悬停查询全排队。
   *
   * 这里把 worker 已建好的整窗图转成**窗口 CSS** 后交给渲染端：渲染端悬停时自己做
   * point-in-rect 查表直接出框，不走 IPC、不进 worker，谁也堵不住它 —— 这才是字面意义的
   * 「一次性全部识别出来，移到哪里点到哪里」。worker 侧应答逻辑完全不变，回包到达后作为
   * 权威值覆盖本地预测，地图新鲜度维护（rowMissing 重拍 / 600ms EFP 交叉校验）照常运转。
   */
  ipcMain.handle('smart:map-get', (_e, p: { vsX?: number; vsY?: number; sf?: number }) => {
    const vsX = p?.vsX || 0;
    const vsY = p?.vsY || 0;
    const winDpr = p?.sf && p.sf > 0 ? p.sf : (screen.getPrimaryDisplay().scaleFactor || 1);
    const m = smartUiaGetMap();
    if (!m || !m.items || !m.items.length || !m.win) return null;
    // 与 smart:at-point 同一套换算，保证「图上画的」与「回包里画的」严格同源
    const physToCssX = (n: number) => Math.round(n / winDpr) - vsX;
    const physToCssY = (n: number) => Math.round(n / winDpr) - vsY;
    return {
      t: m.t,
      win: {
        x: physToCssX(m.win.x), y: physToCssY(m.win.y),
        width: Math.round(m.win.width / winDpr), height: Math.round(m.win.height / winDpr),
      },
      items: m.items.map((it) => ({
        x: physToCssX(it.x), y: physToCssY(it.y),
        width: Math.round(it.width / winDpr), height: Math.round(it.height / winDpr),
        name: it.name, controlType: it.controlType,
      })),
    };
  });

  /** IDLE 悬停：保持 click-through+forward，不再每帧开关（卡顿主因） */
  ipcMain.on('smart:hover-mode', (_e, mode: 'idle' | 'active') => {
    const cap = captureService.getCaptureWindow();
    if (!cap || cap.isDestroyed()) return;
    try {
      if (mode === 'idle') cap.setIgnoreMouseEvents(true, { forward: true });
      else cap.setIgnoreMouseEvents(false);
    } catch { /* ignore */ }
  });

  // ── 像素矩形层级检测（Snipaste/微信同款路线）：渲染端会话内发一次截图帧，悬停只传坐标 ──
  // pixelFrameW/H 已提升到模块级（GDI 直喂 onGdiFrame 也写这里）
  ipcMain.on('smart:frame', (_e, data: Uint8Array, w: number, h: number) => {
    if (!data || !w || !h) return;
    pixelFrameW = w;
    pixelFrameH = h;
    smartPixelFramePrepare(data, w, h);
  });

  ipcMain.handle('smart:pixel-at', (_e, p: { x: number; y: number; vsX?: number; vsY?: number; sf?: number }) => {
    // 帧内坐标：smart:frame 缓存的帧 = 目标屏截图（单屏会话），窗口原点 == 帧原点，
    // 查询点直接 x*sf 即帧内索引。旧公式 (x+vsX)*sf 把屏幕原点重复叠加 —— 主屏 vsX=0
    // 时碰巧成立，窗口在副屏（vsX≠0）时查询点越界到帧外，像素链全废（2026-09-22 多屏改造发现）。
    // sf 必须与帧的实际 backing 比例一致（渲染端按 bgCanvas.width/W 传），不能用屏幕缩放因子猜。
    const sf = p?.sf && p.sf > 0 ? p.sf : 1;
    const physX = Math.round((p?.x || 0) * sf);
    const physY = Math.round((p?.y || 0) * sf);
    const toDip = (n: number) => Math.round(n / sf);
    if (!pixelFrameW || !pixelFrameH) return { ok: false, levels: [] };
    const res = smartPixelDetectLevels(physX, physY, 0, 0, pixelFrameW, pixelFrameH);
    const levels = res.ok
      ? res.levels
        .filter((lv) => lv.width > 0 && lv.height > 0)
        .map((lv) => ({
          x: toDip(lv.x),
          y: toDip(lv.y),
          width: toDip(lv.width),
          height: toDip(lv.height),
          controlType: lv.controlType,
        }))
      : [];
    return { ok: res.ok && levels.length > 0, levels };
  });

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
  stopLocalOcrMtService();
  tray?.destroy();
});


app.on('window-all-closed', () => {
  /* 托盘常驻 */
});

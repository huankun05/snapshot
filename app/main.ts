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
import { stopLocalOcrMtService } from '../main/services/localOcrMtService';
import { installAppLogging, getLogsDir } from '../main/services/appLogger';
import { openSettingsWindow } from './settings';
import { getTopLevelWindowAtPoint } from '../main/window/screenshotHelper';
import { smartUiaGetLevelsAsync, smartPixelFramePrepare, smartPixelDetectLevels } from '../main/services/smartUiaNative';
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

  /**
   * 智能选区：DIP↔物理换算 + 原生 UIA。
   * IDLE 悬停期间保持 click-through（forward），避免每帧 setIgnoreMouseEvents 造成卡顿。
   */
  ipcMain.handle('smart:at-point', async (_e, p: { x: number; y: number; vsX?: number; vsY?: number; sf?: number; coordSpace?: string }) => {
    const t0 = Date.now();
    const vsX = p?.vsX || 0;
    const vsY = p?.vsY || 0;
    const dipX = (p?.x || 0) + vsX;
    const dipY = (p?.y || 0) + vsY;
    // 换算按「点所在屏」取缩放率（2026-09-23）：渲染端 devicePixelRatio 在屏外驻留/混合缩放
    // 过渡期可能滞后（属于最近屏），按它换算会把 UIA 查询打到错误的物理点。
    // dipToScreenPoint/getDisplayNearestPoint 均按点定位屏幕，单一事实源。
    let physX: number, physY: number, sf: number;
    if (p?.coordSpace === 'pdip') {
      // 2026-09-30 修正（副屏全链路坐标日志实锤）：旧公式 dipX×主屏sf 把副屏查询点
      // 打到主屏物理位置（副屏 150% 有自己的物理起点与缩放）。全局 css == 虚拟桌面
      // DIP（每屏 css 范围=每屏 dip 范围），dipToScreenPoint 做正确的每屏物理换算。
      try {
        // vddip = 窗口css + vsXdip（vddip 原点 = 各屏 dip bounds min x/y，与 vsX 的
        // 物理÷主屏sf 原点相差 (1707-2048)）——dipToScreenPoint 需要 vddip。
        const vdX = dipX - (p?.vsX || 0) + (p?.vsXdip ?? (p?.vsX || 0));
        const vdY = dipY - (p?.vsY || 0) + (p?.vsYdip ?? (p?.vsY || 0));
        const phys = screen.dipToScreenPoint({ x: vdX, y: vdY });
        physX = Math.round(phys.x);
        physY = Math.round(phys.y);
        sf = screen.getDisplayNearestPoint({ x: vdX, y: vdY }).scaleFactor || 1;
      } catch {
        sf = p?.sf && p.sf > 0 ? p.sf : (screen.getPrimaryDisplay().scaleFactor || 1);
        physX = Math.round(dipX * sf);
        physY = Math.round(dipY * sf);
      }
    } else try {
      const phys = screen.dipToScreenPoint({ x: dipX, y: dipY });
      physX = Math.round(phys.x);
      physY = Math.round(phys.y);
      sf = screen.getDisplayNearestPoint({ x: dipX, y: dipY }).scaleFactor || 1;
    } catch {
      sf = p?.sf && p.sf > 0 ? p.sf : (screen.getPrimaryDisplay().scaleFactor || 1);
      physX = Math.round(dipX * sf);
      physY = Math.round(dipY * sf);
    }
    const toDip = (n: number) => Math.round(n / sf);

    // worker 线程执行（跨进程 COM 等待不阻塞主进程），连发自动合并
    const native = await smartUiaGetLevelsAsync(physX, physY);
    let levels: Array<{
      x: number; y: number; width: number; height: number;
      name?: string; controlType?: string;
    }> = [];
    if (native.ok && native.levels.length) {
      // 物理矩形 → 窗口 css：screenToDipPoint 按矩形所在屏做正确换算（混合 DPI 下
      // 统一 ÷主屏sf 是错的——副屏 150% 的元素会被压小/错位），宽高按所在屏 sf 缩放。
      levels = native.levels.map((lv) => {
        let cssX = toDip(lv.x), cssY = toDip(lv.y), sfR = sf;
        try {
          const d0 = screen.screenToDipPoint({ x: lv.x, y: lv.y });
          sfR = screen.getDisplayNearestPoint(d0).scaleFactor || sf;
          cssX = Math.round(d0.x - (p?.vsXdip ?? 0));
          cssY = Math.round(d0.y - (p?.vsYdip ?? 0));
        } catch { /* 回退统一 toDip */ }
        return {
          x: cssX,
          y: cssY,
          width: Math.round(lv.width / sfR),
          height: Math.round(lv.height / sfR),
          name: lv.name,
          controlType: lv.controlType,
        };
      });
    }

    let winCss = null;
    if (native.ok && native.window && native.window.width >= 80) {
      let wX = toDip(native.window.x), wY = toDip(native.window.y), sfW = sf;
      try {
        const d0 = screen.screenToDipPoint({ x: native.window.x, y: native.window.y });
        sfW = screen.getDisplayNearestPoint(d0).scaleFactor || sf;
        wX = Math.round(d0.x - (p?.vsXdip ?? 0));
        wY = Math.round(d0.y - (p?.vsYdip ?? 0));
      } catch { /* 回退统一 toDip */ }
      winCss = {
        x: wX,
        y: wY,
        width: Math.round(native.window.width / sfW),
        height: Math.round(native.window.height / sfW),
        title: native.window.name || '',
      };
    } else {
      const win = getTopLevelWindowAtPoint(physX, physY);
      if (win) {
        winCss = {
          x: toDip(win.x) - vsX,
          y: toDip(win.y) - vsY,
          width: toDip(win.width),
          height: toDip(win.height),
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
              x: toDip(lv.left) - vsX,
              y: toDip(lv.top) - vsY,
              width: toDip(lv.width),
              height: toDip(lv.height),
              name: lv.name,
              controlType: lv.controlType,
            }));
        }
      } catch { /* optional */ }
    }

    const elem = levels.length ? levels[0] : null;
    if (process.env.PETALSNAP_SMART_DEBUG) {
      const l0 = levels[0];
      console.error(`[COORD] css=(${p?.x},${p?.y}) vs=(${vsX},${vsY}) sf=${sf} phys=(${physX},${physY})`
        + ` native=${native.ok} n=${levels.length}`
        + (l0 ? ` l0physCss=(${l0.x + vsX},${l0.y + vsY},${l0.width}x${l0.height})` : ''));
    }
    return {
      window: winCss,
      element: elem,
      levels,
      diag: { dllMs: native.diag?.ms ?? null, src: native.diag?.src ?? null, totalMs: Date.now() - t0 },
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

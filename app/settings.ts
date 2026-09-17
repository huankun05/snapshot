/*
 * @file app/settings.ts
 * @description 拾花设置窗口（单例 BrowserWindow）。托盘「设置…」打开；store 经主进程全局 IPC。
 */

import { app, BrowserWindow, shell } from 'electron';
import { existsSync } from 'fs';
import { join } from 'path';

let settingsWindow: BrowserWindow | null = null;

function getSettingsHtmlPath(): string {
  const candidates = [
    join(process.cwd(), 'resources', 'settings.html'),
    join(app.getAppPath(), 'resources', 'settings.html'),
    join(__dirname, '../../resources/settings.html'),
    join(__dirname, '../../../resources/settings.html'),
  ];
  const hit = candidates.find((c) => existsSync(c));
  return hit ?? candidates[0];
}

function showSettingsWindow(win: BrowserWindow, reason: string): void {
  if (win.isDestroyed()) return;
  if (!win.isVisible()) {
    win.show();
    win.focus();
    console.log(`[Settings] window shown (${reason})`);
  } else {
    win.focus();
  }
}

export function openSettingsWindow(): void {
  try {
    console.log('[Settings] openSettingsWindow() called');
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      console.log('[Settings] reuse existing window');
      showSettingsWindow(settingsWindow, 'reuse');
      return;
    }

    const htmlPath = getSettingsHtmlPath();
    console.log('[Settings] html=', htmlPath, 'exists=', existsSync(htmlPath));
    if (!existsSync(htmlPath)) {
      console.error('[Settings] settings.html missing, abort open');
      return;
    }

    settingsWindow = new BrowserWindow({
      width: 880,
      height: 660,
      minWidth: 760,
      minHeight: 560,
      show: false,
      frame: false, // 只用页面内标题栏，避免双标题栏
      title: '拾花 设置',
      autoHideMenuBar: true,
      backgroundColor: '#faf7f8',
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        spellcheck: false,
      },
    });
    console.log('[Settings] BrowserWindow created', settingsWindow.id);

    settingsWindow.setMenuBarVisibility(false);

    // 兜底：ready-to-show 若因白屏/渲染异常不触发，did-finish-load 也强制显示
    const revealOnce = (reason: string): void => {
      if (settingsWindow) showSettingsWindow(settingsWindow, reason);
    };
    settingsWindow.once('ready-to-show', () => revealOnce('ready-to-show'));
    settingsWindow.webContents.once('did-finish-load', () => {
      console.log('[Settings] did-finish-load');
      revealOnce('did-finish-load');
    });
    settingsWindow.webContents.on('did-fail-load', (_e, code, desc) => {
      console.error('[Settings] did-fail-load', code, desc);
      revealOnce('did-fail-load');
    });
    settingsWindow.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) console.error('[Settings-renderer]', message);
      else console.log('[Settings-renderer]', message);
    });

    // 300ms 后仍未显示则强制 show（防 ready-to-show 卡死）
    // 注意：主进程没有 window 对象，必须用 Node 的 setTimeout
    setTimeout(() => revealOnce('timeout-fallback'), 300);

    void settingsWindow.loadFile(htmlPath).then(() => {
      console.log('[Settings] loadFile resolved');
    }).catch((err) => {
      console.error('[Settings] load error:', err);
      revealOnce('load-error');
    });

    settingsWindow.on('closed', () => {
      console.log('[Settings] window closed');
      settingsWindow = null;
    });

    settingsWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http://') || url.startsWith('https://')) {
        void shell.openExternal(url);
      }
      return { action: 'deny' };
    });
  } catch (err) {
    console.error('[Settings] openSettingsWindow threw:', err);
  }
}

export function closeSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.destroy();
  settingsWindow = null;
}

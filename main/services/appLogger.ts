/*
 * @file appLogger.ts
 * @description 主进程统一日志：控制台 + userData/logs/app-YYYY-MM-DD.log
 *   （此前仅有 console，散落不可查；设置窗「打开日志目录」指向本目录）
 */

import { app } from 'electron';
import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

let logsDir: string | null = null;
let fileReady = false;

function ensureLogsDir(): string {
  if (logsDir) return logsDir;
  logsDir = join(app.getPath('userData'), 'logs');
  if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
  return logsDir;
}

function todayFile(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return join(ensureLogsDir(), `app-${y}-${m}-${day}.log`);
}

function stamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 23);
}

export function getLogsDir(): string {
  return ensureLogsDir();
}

/** 追加一行到当日日志文件；失败静默（不打断业务） */
function appendLine(level: string, args: unknown[]): void {
  try {
    if (!fileReady) {
      ensureLogsDir();
      fileReady = true;
    }
    const parts = args.map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack || a.message;
      try { return JSON.stringify(a); } catch { return String(a); }
    });
    appendFileSync(todayFile(), `${stamp()} [${level}] ${parts.join(' ')}\n`, 'utf-8');
  } catch { /* ignore */ }
}

/** 包装 console：stdout 原样 + 落盘 */
export function installAppLogging(): void {
  try {
    ensureLogsDir();
    fileReady = true;
  } catch { /* ignore */ }

  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  console.log = (...args: unknown[]) => {
    origLog(...args);
    appendLine('INFO', args);
  };
  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    appendLine('WARN', args);
  };
  console.error = (...args: unknown[]) => {
    origError(...args);
    appendLine('ERROR', args);
  };

  process.on('uncaughtException', (err) => {
    origError('[App] uncaughtException', err);
    appendLine('FATAL', [err]);
  });
  process.on('unhandledRejection', (reason) => {
    origError('[App] unhandledRejection', reason);
    appendLine('FATAL', [reason]);
  });
}

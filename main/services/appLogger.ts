/*
 * @file appLogger.ts
 * @description 主进程统一日志：控制台 + userData/logs/app-YYYY-MM-DD.log
 *   （此前仅有 console，散落不可查；设置窗「打开日志目录」指向本目录）
 */

import { app } from 'electron';
import { appendFileSync, existsSync, readdirSync, mkdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';

/** 当日日志文件体积上限（达到后轮转到 .1 覆盖重写），默认 10MB，避免无限无限增长 */
const LOG_SIZE_CAP = 10 * 1024 * 1024;
/** 只保留最近 N 天的日志文件，更早的自动删除 */
const KEEP_DAYS = 7;

let logsDir: string | null = null;
let fileReady = false;

function ensureLogsDir(): string {
  if (logsDir) return logsDir;
  logsDir = join(app.getPath('userData'), 'logs');
  if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
  return logsDir;
}

/** 维护日志目录：删除超过保留天数的旧 .log，并截断超大的轮转备份（.1） */
function pruneOldLogs(): void {
  try {
    const dir = ensureLogsDir();
    const now = Date.now();
    for (const name of readdirSync(dir)) {
      if (!/^app-\d{4}-\d{2}-\d{2}(\.\d+)?\.log$/.test(name)) continue;
      const p = join(dir, name);
      try {
        const mtime = statSync(p).mtimeMs;
        if (now - mtime > KEEP_DAYS * 24 * 60 * 60 * 1000) { rmSync(p, { force: true }); }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

/** 当日日志追加：体积超限即把现有文件备份为 .1（截断主文件），保证单文件不失控。
 *  2026-09-28 批量落盘：行先进内存缓冲，500ms 定时或攒满 64 条一次写入——
 *  每行一次 statSync+appendFileSync 的同步 IO 叠在长截图拼接循环上（每帧多条日志
 *  = 主线程抖动）；崩溃丢失窗口 ≤500ms 的日志，可接受。 */
const LOG_FLUSH_MS = 500;
const LOG_FLUSH_MAX = 64;
let logBuf: string[] = [];
let logFlushTimer: ReturnType<typeof setTimeout> | null = null;

function flushLogBuf(): void {
  logFlushTimer = null;
  if (!logBuf.length) return;
  const lines = logBuf;
  logBuf = [];
  try {
    const f = todayFile();
    try {
      if (statSync(f).size >= LOG_SIZE_CAP) {
        try { writeFileSync(f + '.1', readFileSync(f), 'utf-8'); } catch { /* ignore */ }
        try { writeFileSync(f, ''); } catch { /* ignore */ }
      }
    } catch { /* 文件还不存在 */ }
    appendFileSync(f, lines.join(''), 'utf-8');
  } catch { /* ignore */ }
}

function appendLine(level: string, args: unknown[]): void {
  try {
    if (!fileReady) {
      ensureLogsDir();
      pruneOldLogs();
      fileReady = true;
    }
    const parts = args.map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack || a.message;
      try { return JSON.stringify(a); } catch { return String(a); }
    });
    logBuf.push(`${stamp()} [${level}] ${parts.join(' ')}\n`);
    if (logBuf.length >= LOG_FLUSH_MAX) {
      if (logFlushTimer) { clearTimeout(logFlushTimer); logFlushTimer = null; }
      flushLogBuf();
    } else if (!logFlushTimer) {
      logFlushTimer = setTimeout(flushLogBuf, LOG_FLUSH_MS);
      logFlushTimer.unref?.();
    }
  } catch { /* ignore */ }
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

  // 致命异常处理器：**只落盘，不再写 stdout/err**。
  // 原因：后台管道启动（EPIPE）或 console 被替换时，这里若再 origError(...) 写 stdout，
  // 管道断开会抛 EPIPE → 又进 uncaughtException → 无限递归，日志狂涨到 GB 级、事件循环卡死
  //（2026-09-24 实测 F1 无响应即此死锁）。appendLine 自带 try/catch 落盘，绝不外抛。
  process.on('uncaughtException', (err) => {
    try { appendLine('FATAL', [err]); } catch { /* 落盘失败也绝不递归 */ }
  });
  process.on('unhandledRejection', (reason) => {
    try { appendLine('FATAL', [reason]); } catch { /* 落盘失败也绝不递归 */ }
  });
}

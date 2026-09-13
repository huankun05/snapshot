/*
 * eIsland - A sleek, Apple Dynamic Island inspired floating widget for Windows, built with Electron.
 * https://github.com/JNTMTMTM/eIsland
 *
 * Copyright (C) 2026 JNTMTMTM
 * Copyright (C) 2026 pyisland.com
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * @file rapidOcrService.ts
 * @description RapidOCR(PP-OCRv6 small) 本机识别服务桥接 —— 截图 OCR 的新识别内核（试验期）。
 *   常驻 Python HTTP 服务（rapidocr_service.py，127.0.0.1:18766）按需拉起；
 *   不可用时由调用方回落 Tesseract.js。识别结果带段落分组（阅读顺序还原）。
 */

import { spawn, ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { net } from 'electron';

const SERVICE_PORT = 18766;
const HEALTH_TIMEOUT_MS = 1500;
const OCR_TIMEOUT_MS = 30000;

/** venv_ocr 解释器与脚本位置（独立工作区固定路径；移回 Xiyue 时随侧车部署方案调整） */
const VENV_PYTHON = process.env.XIYUE_RAPIDOCR_PYTHON || 'F:\\Work\\Create\\OCR\\venv_ocr\\Scripts\\python.exe';
const SERVICE_SCRIPT = process.env.XIYUE_RAPIDOCR_SCRIPT || 'F:\\Work\\Create\\OCR\\rapidocr_service.py';

let child: ChildProcess | null = null;
let starting: Promise<boolean> | null = null;

function httpJson<T>(url: string, options: { method: string; body?: string; timeoutMs: number }, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeout after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const req = net.request({ url, method: options.method });
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as T);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(err);
    });
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function checkHealth(): Promise<boolean> {
  try {
    const res = await httpJson<{ ok: boolean }>(`http://127.0.0.1:${SERVICE_PORT}/health`, {
      method: 'GET',
      timeoutMs: HEALTH_TIMEOUT_MS,
    }, new AbortController().signal);
    return res?.ok === true;
  } catch {
    return false;
  }
}

/** 拉起常驻服务（幂等）。就绪返回 true；脚本/解释器缺失或启动失败返回 false。 */
export async function ensureRapidOcrService(): Promise<boolean> {
  if (await checkHealth()) return true;
  if (starting) return starting;

  starting = (async () => {
    if (!existsSync(VENV_PYTHON) || !existsSync(SERVICE_SCRIPT)) {
      console.warn('[RapidOCR] python/service script missing:', VENV_PYTHON, SERVICE_SCRIPT);
      return false;
    }
    try {
      if (child && !child.killed) child.kill();
    } catch { /* ignore */ }
    child = spawn(VENV_PYTHON, [SERVICE_SCRIPT], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr?.on('data', (d) => console.log(`[rapidocr-service] ${String(d).trimEnd()}`));
    child.on('exit', () => { child = null; });

    // 等模型加载 + 端口就绪（首启含 onnx 初始化，实测 ~2s）
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (await checkHealth()) {
        console.log('[RapidOCR] service ready');
        return true;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    console.warn('[RapidOCR] service not ready in 20s');
    return false;
  })();

  try {
    return await starting;
  } finally {
    starting = null;
  }
}

/** 停止常驻服务（应用退出时调用） */
export function stopRapidOcrService(): void {
  if (child) {
    try { child.kill(); } catch { /* ignore */ }
    child = null;
  }
}

export interface RapidOcrResult {
  success: boolean;
  text: string;
  paragraphs?: string[];
  ms?: number;
}

/**
 * 用 RapidOCR 识别截图文字（含段落分组）
 * @returns success=false 表示服务不可用/识别失败，调用方应回落 Tesseract
 */
export async function recognizeCaptureTextWithRapid(dataUrl: string, signal: AbortSignal): Promise<RapidOcrResult> {
  if (!(await ensureRapidOcrService())) {
    return { success: false, text: '' };
  }
  const res = await httpJson<{
    ok: boolean;
    error?: string;
    ms?: number;
    lines?: { text: string }[];
    paragraphs?: string[];
    markdown?: string;
  }>(`http://127.0.0.1:${SERVICE_PORT}/ocr`, {
    method: 'POST',
    body: JSON.stringify({ image_b64: dataUrl }),
    timeoutMs: OCR_TIMEOUT_MS,
  }, signal);
  if (!res?.ok) {
    return { success: false, text: res?.error || 'rapidocr failed' };
  }
  // 优先取带格式标记的 Markdown（标题/列表启发式），让「复制 Markdown/预览」与纯文本有区别
  const text = res.markdown
    || (Array.isArray(res.paragraphs) && res.paragraphs.length ? res.paragraphs.join('\n\n') : '')
    || (res.lines || []).map((l) => l.text).join('\n');
  return { success: true, text, paragraphs: res.paragraphs, ms: res.ms };
}

export interface RapidTableResult {
  success: boolean;
  html: string;
  rows?: number;
  ms?: number;
}

/**
 * 表格结构还原（RapidTable/SLANet-plus，飞桨表格模型 ONNX）
 * @returns success=false 表示服务不可用/未检出表格，调用方自行提示
 */
export async function recognizeCaptureTableWithRapid(dataUrl: string, signal: AbortSignal): Promise<RapidTableResult> {
  if (!(await ensureRapidOcrService())) {
    return { success: false, html: '' };
  }
  const res = await httpJson<{
    ok: boolean;
    error?: string;
    ms?: number;
    html?: string;
    rows?: number;
  }>(`http://127.0.0.1:${SERVICE_PORT}/table`, {
    method: 'POST',
    body: JSON.stringify({ image_b64: dataUrl }),
    timeoutMs: OCR_TIMEOUT_MS,
  }, signal);
  if (!res?.ok || !res.html) {
    return { success: false, html: res?.error || '' };
  }
  return { success: true, html: res.html, rows: res.rows, ms: res.ms };
}

/** 智能识别：版面分析（PP-DocLayoutV3）分区 → 标题/正文/表格分流 → 合成 Markdown */
export async function recognizeCaptureSmartWithRapid(dataUrl: string, signal: AbortSignal): Promise<RapidOcrResult> {
  if (!(await ensureRapidOcrService())) {
    return { success: false, text: '' };
  }
  const res = await httpJson<{
    ok: boolean;
    error?: string;
    ms?: number;
    regions?: number;
    markdown?: string;
  }>(`http://127.0.0.1:${SERVICE_PORT}/smart`, {
    method: 'POST',
    body: JSON.stringify({ image_b64: dataUrl }),
    timeoutMs: 120000, // 版面+多区域 OCR，耗时数倍于普通识别
  }, signal);
  if (!res?.ok || !res.markdown) {
    return { success: false, text: res?.error || 'smart failed' };
  }
  return { success: true, text: res.markdown, ms: res.ms };
}

/** 供测试/诊断：返回脚本路径（存在性检查用） */
export function rapidOcrScriptPath(): string {
  return join(SERVICE_SCRIPT);
}

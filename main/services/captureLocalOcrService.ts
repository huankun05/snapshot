/*
 * eIsland - A sleek, Apple Dynamic Island inspired floating widget for Windows, built with Electron.
 * https://github.com/JNTMTMTM/eIsland
 *
 * Copyright (C) 2026 JNTMTMTM
 * Copyright (C) 2026 pyisland.com
 *
 * Original author: JNTMTMTM[](https://github.com/JNTMTMTM)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

/**
 * @file captureLocalOcrService.ts
 * @description 使用 Tesseract.js 在本机识别截图文字，不上传图片。
 * @author 鸡哥
 */

import { app } from 'electron';
import { existsSync, statSync } from 'fs';
import { join } from 'path';
import { createWorker, type Worker } from 'tesseract.js';
import { readScreenshotAssetsDirConfig } from '../config/storeConfig';

export type CaptureLocalOcrResult = {
  success: boolean;
  text?: string;
  code?: string;
  message?: string;
};

/**
 * 语言包固定缓存目录（userData/tessdata）：2026-11-22 起 Tesseract 兜底不再落主进程 cwd，
 * 由设置窗「下载语言包」按钮预先下好（ocr:langpack-download），识别时只读缓存不再联网。
 */
export function getTessdataDir(): string {
  // 用户自定义资产目录优先（设置 → 识别 → 识别资源 → 存放位置），空则默认 userData/tessdata
  const custom = readScreenshotAssetsDirConfig();
  if (custom) return join(custom, 'tessdata');
  return join(app.getPath('userData'), 'tessdata');
}

/** 语言包是否就绪（chi_sim + eng 都已下载且非占位文件）。
 *  优先级链据此跳过 Tesseract——未下载时链上直接略过，而不是运行中联网失败。 */
export function isLangPackReady(): boolean {
  const dir = getTessdataDir();
  for (const lang of ['chi_sim', 'eng']) {
    const fp = join(dir, `${lang}.traineddata`);
    try {
      if (!existsSync(fp) || statSync(fp).size < 1024 * 512) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** 复用的 Tesseract 单例 worker，避免每次请求重新初始化。 */
let cachedWorker: Worker | null = null;
let workerReady = false;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

/** 空闲 5 分钟后自动释放 worker 以回收内存。 */
const WORKER_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 获取或创建 Tesseract 单例 worker。
 * 首次调用时初始化，后续调用直接复用。
 */
async function getWorker(): Promise<Worker> {
  if (cachedWorker && workerReady) {
    return cachedWorker;
  }
  // cachePath 固定到 userData/tessdata：语言包就绪时离线加载；缺失时 tesseract.js 才会联网拉取
  cachedWorker = await createWorker('eng+chi_sim', 1, { cachePath: getTessdataDir() });
  workerReady = true;
  return cachedWorker;
}

/** 每次使用后重置空闲计时器，超时自动释放 worker。 */
function scheduleIdleDispose(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    void resetWorker();
  }, WORKER_IDLE_TIMEOUT_MS);
  // 允许 Node 在 app 退出前不因该定时器而阻塞
  if (idleTimer.unref) idleTimer.unref();
}

/**
 * 重置单例 worker（worker 出错或空闲超时后调用，下次请求会重新创建）。
 */
async function resetWorker(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (!cachedWorker) return;
  const old = cachedWorker;
  cachedWorker = null;
  workerReady = false;
  try {
    await old.terminate();
  } catch {
    // 忽略终止失败
  }
}

/** 应用退出时清理 worker。 */
export async function disposeLocalOcrWorker(): Promise<void> {
  await resetWorker();
}

function dataUrlToBuffer(dataUrl: string): Buffer | null {
  const [metadata, encoded = ''] = dataUrl.split(',', 2);
  if (!/^data:image\/(?:png|jpeg|bmp|gif|tiff|webp);base64$/i.test(metadata) || !encoded) {
    return null;
  }
  const buffer = Buffer.from(encoded, 'base64');
  return buffer.length > 0 ? buffer : null;
}

/**
 * 使用中英文模型在本机识别截图文字。
 * @param dataUrl - 待识别图片的 data URL。
 * @param signal - 截图窗口关闭时用于中止识别的信号。
 * @returns 本地 OCR 识别结果。
 */
export async function recognizeCaptureTextLocally(
  dataUrl: string,
  signal: AbortSignal,
): Promise<CaptureLocalOcrResult> {
  const image = dataUrlToBuffer(dataUrl);
  if (!image) {
    return { success: false, code: 'invalidData', message: '无效的截图数据' };
  }

  if (signal.aborted) {
    return { success: false, code: 'ocrTimeout', message: '文字识别请求已取消' };
  }

  try {
    const worker = await getWorker();
    if (signal.aborted) {
      return { success: false, code: 'ocrTimeout', message: '文字识别请求已取消' };
    }
    const result = await worker.recognize(image);
    scheduleIdleDispose();
    return {
      success: true,
      text: typeof result.data.text === 'string' ? result.data.text.trim() : '',
    };
  } catch (error) {
    // worker 可能已损坏，下次请求重新创建
    await resetWorker();
    if (signal.aborted) {
      return { success: false, code: 'ocrTimeout', message: '文字识别请求已取消' };
    }
    return {
      success: false,
      code: 'ocrFailed',
      message: error instanceof Error ? error.message : '本地文字识别失败',
    };
  }
}
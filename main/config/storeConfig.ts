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
 * @file storeConfig.ts
 * @description 截图功能相关配置读取（独立工作区版）。
 *   由 `storeConfig-screenshot-excerpt.ts` 摘录补全为完整可编译模块：
 *   函数体与 Xiyue `src/main/config/storeConfig.ts` 保持一致，
 *   仅把 shared/storeKeys 之外未摘录的依赖（readJsonFile/getStoreDir）一并补齐。
 *   移回 Xiyue 时删除本文件，恢复引用原 storeConfig.ts。
 */

import { app } from 'electron';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  SCREENSHOT_ENGINE_STORE_KEY,
  SCREENSHOT_OCR_ENGINE_STORE_KEY,
  SCREENSHOT_TRANSLATE_ENGINE_STORE_KEY,
  SCREENSHOT_LOCAL_OCR_DIR_STORE_KEY,
  SCREENSHOT_CLOUD_TRANSLATE_APPID_STORE_KEY,
  SCREENSHOT_CLOUD_TRANSLATE_SECRET_STORE_KEY,
  type ScreenshotEngine,
  type ScreenshotOcrEngine,
  type ScreenshotTranslateEngine,
} from '../../shared/storeKeys';

/** 截图快捷键存储键名 */
export const SCREENSHOT_HOTKEY_STORE_KEY = 'screenshot-hotkey';

/** 默认截图快捷键（独立测试应用用 Alt+Q，避开 Xiyue 的 Alt+A——全局热键同键只能一个应用持有） */
export const DEFAULT_SCREENSHOT_HOTKEY = 'Alt+Q';

// ===== Helper =====

function getStoreDir(): string {
  return join(app.getPath('userData'), 'eIsland_store');
}

function readJsonFile(storeKey: string): unknown | undefined {
  try {
    const filePath = join(getStoreDir(), `${storeKey}.json`);
    if (!existsSync(filePath)) return undefined;
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return undefined;
  }
}

// ===== 截图配置 =====

/**
 * 读取截图快捷键配置
 * @returns 快捷键字符串
 */
export function readScreenshotHotkeyConfig(): string {
  const data = readJsonFile(SCREENSHOT_HOTKEY_STORE_KEY);
  return typeof data === 'string' ? data : DEFAULT_SCREENSHOT_HOTKEY;
}

/**
 * 读取截图引擎偏好配置
 * @returns 'plugin'（原生插件优先）或 'js'（JS 回退优先），默认 'plugin'
 */
export function readScreenshotEngineConfig(): ScreenshotEngine {
  const data = readJsonFile(SCREENSHOT_ENGINE_STORE_KEY);
  return data === 'js' ? 'js' : 'plugin';
}

/** 本地 OCR 服务目录默认值（local_capture_service.py 所在目录） */
export const DEFAULT_LOCAL_OCR_DIR = 'F:\\Work\\Create\\OCR';

/**
 * 读取 OCR 引擎偏好：local=Tesseract.js(秒开) / paddleocr=本机 PaddleOCR(高精度) / server=服务端
 * @returns 默认 'local'（本机 Tesseract 秒开，PaddleOCR 作为可选高精度档）
 */
export function readScreenshotOcrEngineConfig(): ScreenshotOcrEngine {
  const data = readJsonFile(SCREENSHOT_OCR_ENGINE_STORE_KEY);
  if (data === 'paddleocr' || data === 'server' || data === 'local') return data;
  return 'local';
}

/**
 * 读取截图翻译引擎偏好：local=本机 Hy-MT2 / cloud=云端百度翻译 / server=服务端
 * @returns 默认 'local'（本机免费翻译，无需账号）
 */
export function readScreenshotTranslateEngineConfig(): ScreenshotTranslateEngine {
  const data = readJsonFile(SCREENSHOT_TRANSLATE_ENGINE_STORE_KEY);
  return data === 'server' || data === 'cloud' ? data : 'local';
}

export type ScreenshotCloudTranslateConfig = { appId: string; secretKey: string };

/**
 * 读取云端翻译（百度翻译通用版）凭据；任一为空返回 null（走本地引擎）
 */
export function readScreenshotCloudTranslateConfig(): ScreenshotCloudTranslateConfig | null {
  const appId = readJsonFile(SCREENSHOT_CLOUD_TRANSLATE_APPID_STORE_KEY);
  const secretKey = readJsonFile(SCREENSHOT_CLOUD_TRANSLATE_SECRET_STORE_KEY);
  if (typeof appId === 'string' && appId.trim() && typeof secretKey === 'string' && secretKey.trim()) {
    return { appId: appId.trim(), secretKey: secretKey.trim() };
  }
  return null;
}

/**
 * 读取本地 OCR/翻译服务目录（local_capture_service.py 所在目录）
 * @returns 路径字符串，留空表示使用 DEFAULT_LOCAL_OCR_DIR
 */
export function readScreenshotLocalOcrDirConfig(): string {
  const data = readJsonFile(SCREENSHOT_LOCAL_OCR_DIR_STORE_KEY);
  return typeof data === 'string' && data.trim() ? data.trim() : DEFAULT_LOCAL_OCR_DIR;
}

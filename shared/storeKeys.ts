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
 * @file storeKeys.ts
 * @description 截图功能相关的存储键名与类型（独立工作区摘录；与 Xiyue src/shared/storeKeys.ts 保持同名同值，
 *   移回时直接删除本文件并恢复引用原模块）
 */

/** 截图引擎偏好存储键名 */
export const SCREENSHOT_ENGINE_STORE_KEY = 'screenshot-engine';

/** OCR 引擎偏好存储键名 */
export const SCREENSHOT_OCR_ENGINE_STORE_KEY = 'screenshot-ocr-engine';

/** 截图翻译引擎偏好存储键名 */
export const SCREENSHOT_TRANSLATE_ENGINE_STORE_KEY = 'screenshot-translate-engine';

/** 本地 OCR/翻译服务目录存储键名 */
export const SCREENSHOT_LOCAL_OCR_DIR_STORE_KEY = 'screenshot-local-ocr-dir';

/** 云端翻译 appId 存储键名 */
export const SCREENSHOT_CLOUD_TRANSLATE_APPID_STORE_KEY = 'screenshot-cloud-translate-appid';

/** 云端翻译 secretKey 存储键名 */
export const SCREENSHOT_CLOUD_TRANSLATE_SECRET_STORE_KEY = 'screenshot-cloud-translate-secret';

/** 截图引擎类型：plugin=原生插件优先 / js=JS 回退优先 */
export type ScreenshotEngine = 'plugin' | 'js';

/** OCR 引擎类型：local=Tesseract.js(秒开) / paddleocr=本机 PaddleOCR(高精度) / server=服务端 */
export type ScreenshotOcrEngine = 'local' | 'paddleocr' | 'server';

/** 截图翻译引擎类型：local=本机 Hy-MT2 / cloud=云端百度翻译(免费额度) / server=服务端 */
export type ScreenshotTranslateEngine = 'local' | 'cloud' | 'server';

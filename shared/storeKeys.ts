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

// ===== 设置窗新增键（2026-09-17 P2b）=====

/** 界面语言：system=跟随系统 / zh / en */
export const I18N_LANGUAGE_STORE_KEY = 'i18n-language';

/** 截图后自动识别 */
export const OCR_AUTO_STORE_KEY = 'screenshot.ocr-auto';
/** 识别性能：resident / capture-prewarm / on-demand */
export const OCR_WARMUP_STORE_KEY = 'screenshot-ocr-warmup';
/** 默认识别动作：text / table / smart */
export const OCR_DEFAULT_ACTION_STORE_KEY = 'screenshot-ocr-default-action';
/** 表格复制格式：html / tsv */
export const TABLE_COPY_FORMAT_STORE_KEY = 'screenshot.table-copy-format';
/** 智能识别是否保留 Markdown 标题 */
export const SMART_HEADINGS_STORE_KEY = 'screenshot.smart-headings';
/** 长截图默认自动滚动 */
export const LS_AUTOSCROLL_STORE_KEY = 'screenshot.ls-autoscroll';
/** 长截图步长：dense / standard / fast */
export const LS_STEP_STORE_KEY = 'screenshot.ls-step';
/** 长截图完成后：editor / clipboard */
export const LS_ON_DONE_STORE_KEY = 'screenshot.ls-on-done';
/** 录屏倒计时秒：0/1/3/5 */
export const REC_COUNTDOWN_STORE_KEY = 'screenshot.rec-countdown';
/** 录屏画质：smooth / balanced / sharp */
export const REC_QUALITY_STORE_KEY = 'screenshot.rec-quality';
/** 录屏保存：dialog / folder */
export const REC_SAVE_MODE_STORE_KEY = 'screenshot.rec-save-mode';
/** 录屏固定目录（空=系统视频） */
export const REC_SAVE_DIR_STORE_KEY = 'screenshot.rec-save-dir';
/** 录屏文件名前缀 */
export const REC_FILENAME_PREFIX_STORE_KEY = 'screenshot.rec-filename-prefix';
/** 翻译呈现：overlay / panel */
export const TRANSLATE_RENDER_STORE_KEY = 'screenshot.translate-render';

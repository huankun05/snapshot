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
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 */
/**
 * @file capture.js
 * @description 截图选区与涂鸦交互逻辑，负责选区绘制、马赛克/线条/矩形/画笔标注及结果导出
 * @author 鸡哥
 */

const { ipcRenderer, clipboard, shell, nativeImage } = require('electron');
// ⚠️ Electron 新版已把 desktopCapturer 从渲染进程移除（require 拿到 undefined），
// 取桌面屏幕源必须经主进程 IPC（'capture-desktop-sources'），见 getDesktopSource()。
/**
 * 取主屏桌面源（长截图/录屏共用）：走主进程 desktopCapturer（渲染端已不可用）。
 * @returns {Promise<{id:string,name:string}|null>}
 */
async function getDesktopSource() {
  try {
    const sources = await ipcRenderer.invoke('capture-desktop-sources');
    return (sources && sources[0]) || null;
  } catch (err) {
    console.error('[Capture] getDesktopSource failed', err);
    return null;
  }
}

// —— 试验开关：XIYUE_CAPTURE_NO_HOVER=1 时禁用「IDLE 悬停窗口自动开洞摘蒙版」——
// 用途：用户反馈「进截图后蒙版消失变亮」。最可疑路径 = IDLE 下鼠标悬停在某个可见窗口上时，
// capture.js 会把该窗口区域的蒙版整块摘除（窗口恢复原亮度；若鼠标停在全屏应用上 → 视觉≈蒙版没了）。
// 设 1 后 IDLE 永远保持整屏 is-full 均匀蒙版，只有显式拖框才开洞。
// 二分定位法：设 1 复测 —— 若"变亮"消失 → 元凶就是 hover；若仍在 → 是 captureMask 合成层问题（看 [cap] 快照日志）。
const CAPTURE_NO_HOVER = process.env.XIYUE_CAPTURE_NO_HOVER === '1';

// —— 崩溃留痕：任何未捕获 JS 异常/拒绝都上报主进程日志（经 'capture-log' 打到主进程 stdout）。
//    此前「进截图一动就卡退」类问题无法复现时只能盲猜，这里保证下次必留下堆栈。
window.addEventListener('error', (ev) => {
  try {
    ipcRenderer.send('capture-log', {
      type: 'error',
      message: ev.message || 'unknown error',
      source: ev.filename || '',
      line: ev.lineno || 0,
      col: ev.colno || 0,
      stack: ev.error && ev.error.stack ? String(ev.error.stack).slice(0, 4000) : '',
    });
  } catch (_) { /* 上报失败静默 */ }
});
window.addEventListener('unhandledrejection', (ev) => {
  try {
    const r = ev.reason;
    ipcRenderer.send('capture-log', {
      type: 'rejection',
      message: r && r.message ? String(r.message) : String(r),
      stack: r && r.stack ? String(r.stack).slice(0, 4000) : '',
    });
  } catch (_) { /* 上报失败静默 */ }
});

const bgCanvas = document.getElementById('bg-canvas');
const drawCanvas = document.getElementById('draw-canvas');
const annotCanvas = document.getElementById('annot-canvas');
const tempCanvas = document.getElementById('temp-canvas');
const captureMask = document.getElementById('captureMask');
const captureMaskFrame = document.getElementById('captureMaskFrame');
const captureMaskBars = captureMask
  ? Array.from(captureMask.querySelectorAll('.capture-mask-bar'))
  : [];
const captureHandles = document.getElementById('captureHandles');

const bgCtx = bgCanvas.getContext('2d');
const drawCtx = drawCanvas.getContext('2d');
const annotCtx = annotCanvas ? annotCanvas.getContext('2d') : null;
const tempCtx = tempCanvas.getContext('2d');

const sizeInfo = document.getElementById('size-info');
const toolbar = document.getElementById('toolbar');
const colorPicker = document.getElementById('colorPicker');
const sizeSlider = document.getElementById('sizeSlider');
const sizeValue = document.getElementById('sizeValue');
const btnUndo = document.getElementById('btnUndo');
const btnOcr = document.getElementById('btnOcr');
const ocrProIcon = document.querySelector('.capture-ocr-pro-icon');
const ocrPanel = document.getElementById('ocrPanel');
const ocrText = document.getElementById('ocrText');
const ocrPreview = document.getElementById('ocrPreview');
const btnOcrCopyText = document.getElementById('btnOcrCopyText');
const btnOcrCopyMd = document.getElementById('btnOcrCopyMd');
const btnOcrPreview = document.getElementById('btnOcrPreview');
const btnOcrPreviewLabel = document.getElementById('btnOcrPreviewLabel');
const btnOcrTable = document.getElementById('btnOcrTable');
const btnOcrTableLabel = document.getElementById('btnOcrTableLabel');
const btnOcrClose = document.getElementById('btnOcrClose');
const btnOcrLang = document.getElementById('btnOcrLang');
const btnOcrLangLabel = document.getElementById('btnOcrLangLabel');
const ocrLangRow = document.getElementById('ocrLangRow');
const ocrTargetLang = document.getElementById('ocrTargetLang');
let userPositionedOcr = false; // 用户手动拖拽/缩放 OCR 面板后，positionOcrPanel 不再覆盖其位置
/** 原文/译文对：翻译完成后 { original, translated, showing }，共用 ocrText 一个可编辑文本区 */
let translatePair = null;
/** 本次 OCR 的选区原图 dataURL：表格识别按需复用（避免重新截屏/重复框选） */
let ocrSourceImage = '';
/** 表格识别结果（带边框 HTML）：复制按钮据它附加 text/html 剪贴板格式 */
let ocrTableHtml = '';

/** 表格 HTML → Markdown 表格源（面板展示/复制 Markdown 用；首行作表头） */
function htmlTableToMarkdown(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = String(html || '');
  const trs = Array.from(tmp.querySelectorAll('tr'));
  const rowsMd = [];
  trs.forEach((tr, idx) => {
    const cells = Array.from(tr.querySelectorAll('th,td'))
      .map((td) => (td.textContent || '').trim().replace(/\|/g, '/'));
    if (!cells.length) return;
    rowsMd.push('| ' + cells.join(' | ') + ' |');
    if (idx === 0) rowsMd.push('|' + cells.map(() => ' --- ').join('|') + '|');
  });
  return rowsMd.join(String.fromCharCode(10));
}

/** 表格 HTML → TSV（纯文本兜底：Excel/WPS 粘贴仍按列分） */
function htmlTableToTsv(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = String(html || '');
  return Array.from(tmp.querySelectorAll('tr')).map((tr) =>
    Array.from(tr.querySelectorAll('th,td')).map((td) => (td.textContent || '').trim()).join(String.fromCharCode(9))
  ).join(String.fromCharCode(10));
}
const btnTranslate = document.getElementById('btnTranslate');
// 图片翻译二级面板（▾ 展开）：选择图片翻译的目标语言
const translateMenu = document.getElementById('translateMenu');
const translateTargetLang = document.getElementById('translateTargetLang');
// 统一工具二级面板：即原打码面板（#maskMenu），样式区（颜色/粗细）已并入其中
const btnLongShot = document.getElementById('btnLongShot');
const btnRecord = document.getElementById('btnRecord');
const btnQr = document.getElementById('btnQr');
// #92 二维码识别结果卡片
const qrResult = document.getElementById('qrResult');
const qrText = document.getElementById('qrText');
const qrCopy = document.getElementById('qrCopy');
const qrOpen = document.getElementById('qrOpen');
const qrClose = document.getElementById('qrClose');
const translateOverlay = document.getElementById('translateOverlay');
const translateMessage = document.getElementById('translateMessage');
const magnifier = document.getElementById('magnifier');
const magnifierCanvas = document.getElementById('magnifier-canvas');
const captureHint = document.getElementById('captureHint');
const captureGuide = document.getElementById('captureGuide');
const btnPin = document.getElementById('btnPin');
const shapeBtn = document.getElementById('btnShape');
const shapeIcon = document.getElementById('shapeIcon');
const shapeMenu = document.getElementById('shapeMenu');
const shapeItems = Array.from(shapeMenu ? shapeMenu.querySelectorAll('.capture-shape-item') : []);
const maskBtn = document.getElementById('btnMask');
const maskIcon = document.getElementById('maskIcon');
const maskMenu = document.getElementById('maskMenu');
const maskItems = Array.from(maskMenu ? maskMenu.querySelectorAll('.capture-shape-item') : []);
const maskStrength = document.getElementById('maskStrength');
const maskStrengthValue = document.getElementById('maskStrengthValue');
const maskStrengthLabel = document.getElementById('maskStrengthLabel');
/** 打码二级面板的圆头 / 方头 笔刷形状按钮 */
const maskModeBtns = maskMenu ? Array.from(maskMenu.querySelectorAll('.capture-mask-mode-btn')) : [];
/** 取色器持续色环浮层（按住时跟随光标显示，松开自动关闭） */
const pickerOverlay = document.getElementById('pickerOverlay');
const pickerSwatch = document.getElementById('pickerSwatch');
const pickerHex = document.getElementById('pickerHex');
const pickerRgb = document.getElementById('pickerRgb');
/** 笔刷预览圈：pen / 打码系列 工具激活且光标在选区内时跟随鼠标显示 */
const brushCursor = document.getElementById('brushCursor');
/** 文字工具：JS 动态创建的 textarea（完全隐形：透明背景、无边框，仅保留 caret 主题蓝） */
let textEditor = null;
let textEditorHint = null;

let bgImage = null;
let W = 0;
let H = 0;
let scaleFactor = 1;
let captureDisplays = [];
let captureVirtualScreen = null;
let capturePhysicalScreen = null;

let selX = 0;
let selY = 0;
let selW = 0;
let selH = 0;

const STATE = { IDLE: 0, DRAWING: 1, SELECTED: 2, MOVING: 3, RESIZING: 4, ANNOTATING: 5, PICKING: 6 };
let state = STATE.IDLE;

let startX = 0;
let startY = 0;
let moveOffX = 0;
let moveOffY = 0;
let resizeHandle = '';
let resizeAnchorX = 0;
let resizeAnchorY = 0;

let activeTool = 'select';
let drawingColor = '#ff4d4f';
let drawingSize = 4;
/**
 * 打码工具两级参数：
 * - **笔刷粗细**统一由工具栏「粗细」滑块（drawingSize）控制，面板里不再重复一个粗细滑块。
 * - **效果参数**按打码类型不同而不同（见 MASK_PARAM），由面板滑块控制：
 *   像素 / 模糊 / 噪点 = 强度（块大小 / 模糊半径 / 颗粒），纯色 = 透明度(%)。
 */
let maskTool = 'mosaic';
/** 当前打码类型的效果参数值（语义随 maskTool 变化） */
let maskIntensity = 12;
/** 各打码类型各自记住自己的参数值，来回切换不互相污染 */
const maskParams = { mosaic: 12, blur: 16, noise: 8, solid: 100 };
/** 涂抹方式：brush = 自由笔刷涂抹；rect = 拖框整块打码 */
let maskMode = 'brush';

/**
 * 各类打码的效果参数定义
 * - labelKey：滑块的 i18n 文案 key
 * - min / max / def：滑块范围与默认值
 * - percent：true 时显示成百分比（纯色透明度）
 */
const MASK_PARAM = {
  mosaic: { labelKey: 'strength', min: 2, max: 40, def: 12, percent: false },
  blur: { labelKey: 'strength', min: 2, max: 40, def: 16, percent: false },
  noise: { labelKey: 'strength', min: 1, max: 30, def: 8, percent: false },
  solid: { labelKey: 'opacity', min: 10, max: 100, def: 100, percent: true },
};
/** 文字输入浮层的落点（画布 CSS 坐标） */
let textAnchorX = 0;
let textAnchorY = 0;
let annotStartX = 0;
let annotStartY = 0;
let penLastX = 0;
let penLastY = 0;

const HANDLE_SIZE = 5;
const HANDLE_HIT = 8;
/** 撤销历史最大步数（正常选区可达上限） */
const MAX_HISTORY = 10;
/**
 * 历史栈总内存预算（字节）。高分屏全屏选区单快照可达 ~20MB（DPR=2, 2880×1800×4），
 * 若仍允许 10 步会吃 ~200MB；按快照面积动态收缩上限，把峰值压在预算内。
 * 典型小选区（几百 KB~2MB）不受影响，仍可撤销 10 步。
 */
const HISTORY_BUDGET_BYTES = 128 * 1024 * 1024;
const historyStack = [];

/**
 * 矢量标注对象层（MOVE 工具可点选/拖动的"单个对象"）。
 *
 * 架构（对象层重构 #48）：
 * - 文字 / 图形（直线·矩形·箭头·椭圆）从「直接画进 drawCanvas 位图」改为
 *   存入本数组并整层渲染到独立 annotCanvas —— 每对象是独立实体，可命中/拖动/单步撤销。
 * - 打码 / 画笔等位图操作仍画进 drawCanvas（无几何语义，拖动=改像素，不适合对象化）。
 * - 合成顺序：bg(背景位图) < drawCanvas(打码/画笔) < annotCanvas(矢量对象)。
 *   因此「后打的码」不会再盖住「先画的矢量对象」（矢量恒在最上）——这是分层带来的
 *   z 序差异：要盖住矢量，需先打码再画矢量。Snipaste 主流程（先处理敏感信息再标注）不受影响。
 * - 对象坐标一律为全屏 CSS 坐标（与 drawCanvas 一致）；渲染与保存都裁到当前选区。
 */
let annotations = [];
/** MOVE 工具当前拖动中的对象下标；-1 = 未在拖对象（此时 MOVING = 拖动整个选区） */
let dragAnnotIndex = -1;
/** 悬停在某个矢量对象上（任意工具）：renderAnnots 会给它画虚线选中框，提示可直接拖动 */
let hoverAnnotIndex = -1;
/** 按下瞬间鼠标坐标（算位移用，拖动中不随选区移动而漂移） */
let dragStartX = 0;
let dragStartY = 0;
/** 按下瞬间对象各坐标快照（拖动中 base + 位移） */
let dragBase = null;
/**
 * 文字工具编辑中的临时对象：**不进入 annotations 数组**，每次输入实时刷新样式/折行，
 * 由 refreshEditorCanvas 直接画到 annotCanvas 顶层；commit 才克隆进数组固化，cancel 整体丢弃。
 * （不占数组位 → hitTest 不会把"编辑中的字"当可拖动对象，renderAnnots 也不会双画。）
 */
let editingTextAnnot = null;
/** 当前这笔打码「笔刷」是否真的落过像素：mouseup 只对真画过的收一步历史，避免空撤销步 */
let maskStrokePainted = false;

let currentCaptureObjectUrl = '';
let captureLanguage = 'zh-CN';
let captureWindowRects = [];
let hoverWindowRect = null;
let pendingWindowClickRect = null;
let isTranslating = false;
let isRecognizing = false;
/** OCR 运行序号：Esc 取消后旧请求的结果回来时不再改写 UI（避免“取消了却又弹出结果”） */
let ocrRunId = 0;
let ocrEngine = 'server';
let translateEngine = 'server';
let recognizedText = '';
let translatedText = '';
let translationCache = null;
let displayedImageVersion = 'original';

/** 放大镜状态：固定放大倍数（Snipaste 式，不循环切换）。
 * MAGNIFIER_SIZE 取 zoom 整数倍（33 源像素 × 4 = 132 CSS px），保证像素网格精确对齐。 */
const MAGNIFIER_ZOOM = 4;
const MAGNIFIER_SIZE = 120;
const magnifierCtx = magnifierCanvas ? magnifierCanvas.getContext('2d') : null;
/** 临时调试开关：false = 禁用放大镜，验证「左上黑块」是否放大镜引起（用户 2026-09-03 要求）。
 * 已确认黑块确实是放大镜引起（禁用后消失）；当前 CSS 已改直角+满铺 canvas+无大投影，
 * 恢复 true 让用户实测当前版是否已无黑块。 */
const ENABLE_MAGNIFIER = true;

const CAPTURE_I18N = {
  'zh-CN': {
    tools: {
      select: '移动',
      mosaic: '马赛克',
      line: '直线',
      rect: '矩形',
      pen: '画笔',
      arrow: '箭头',
      ellipse: '椭圆',
      text: '文字',
      blur: '模糊',
      picker: '取色',
      maskMosaic: '像素',
      maskBlur: '模糊',
      noise: '噪点',
      solid: '纯色',
      strength: '强度',
      opacity: '透明度',
      maskBrush: '笔刷',
      maskRect: '框选',
      brushSize: '笔刷大小',
      strengthDisabled: '—',
      undo: '撤销',
      redo: '重做',
      pin: '贴图到桌面',
      pinnedHint: '已贴到桌面 · 拖动移动 · 滚轮缩放 · 点 × 销毁',
      pinFailed: '贴图失败，请重试',
      color: '颜色',
      size: '粗细',
      save: '保存',
      ocr: '文字识别',
      ocrResult: '文字识别结果',
      translateResult: '翻译结果',
      copyTranslation: '复制译文',
      recognizing: '识别中',
      ocrLoginRequired: '请先登录后再使用文字识别',
      copyText: '复制文本',
      copyPlainText: '复制纯文本',
      copyMarkdown: '复制 Markdown',
      previewMd: '预览',
      editMd: '编辑',
      copied: '已复制',
      close: '关闭',
      noTextFound: '未识别到文字',
      ocrFailed: '文字识别失败',
      ocrTimeout: '文字识别请求已取消或超时',
      imageTooLarge: '截图不能超过 10MB',
      invalidImageDimensions: '截图边长需为 15～8192 像素，且长宽比小于 50',
      translate: '图片翻译',
      translateText: '翻译',
      langAuto: '自动检测',
      showOriginal: '显示原文',
      showTranslation: '显示译文',
      translating: '翻译中',
      loginRequired: '请先登录 Pro 账号后再使用图片翻译',
      translateFailed: '图片翻译失败',
      invalidData: '无效的截图数据',
      submitFailed: '图片翻译任务提交失败',
      queryFailed: '查询图片翻译任务失败',
      noResultUrl: '服务端未返回翻译图片',
      timeout: '图片翻译等待超时，请稍后重试',
      aborted: '图片翻译请求已取消或超时',
      captureWindowClosed: '截图窗口已关闭',
      cancel: '取消',
      done: '完成',
      captureHint: '拖拽框选截图区域 · 悬停窗口可快速选中 · Enter 完成 · Esc 取消',
      lsStartHint: '长截图中：滚轮自动翻页（鼠标位置无关），建议将鼠标移出选区——悬停效果会干扰拼接',
      guideStart: '拖拽框选 · 悬停窗口可快速选中',
      guideNudgeSel: '↑↓←→ 微调选区 · Shift = 10px',
      guideNudgeAnnot: '↑↓←→ 微调悬停的对象 · Shift = 10px',
      guideDblEdit: '双击文字/图形可再次编辑',
      guideFinish: 'Enter 完成 · Esc 取消',
      captureInputText: '输入文字',
      longScreenshot: '长截图',
      record: '录屏',
      qr: '二维码',
      featureSoon: '功能开发中',
      qrResult: '二维码内容',
      openLink: '打开链接',
      noQrFound: '未识别到二维码',
      recording: '录制中',
      stopRec: '停止',
      pauseRec: '暂停',
      resumeRec: '继续',
      longShotHint: '选区里滚轮翻页自动拼接；移到底部点「完成」或按 Enter，Esc 取消',
      longShotPreview: '拼接预览',
      translateTargetLang: '翻译为',
    },
  },
  'en-US': {
    tools: {
      select: 'Move',
      mosaic: 'Mosaic',
      line: 'Line',
      rect: 'Rectangle',
      pen: 'Pen',
      arrow: 'Arrow',
      ellipse: 'Ellipse',
      text: 'Text',
      blur: 'Blur',
      picker: 'Color picker',
      maskMosaic: 'Pixel',
      maskBlur: 'Blur',
      noise: 'Noise',
      solid: 'Solid',
      strength: 'Strength',
      opacity: 'Opacity',
      maskBrush: 'Brush',
      maskRect: 'Box',
      brushSize: 'Brush size',
      strengthDisabled: '—',
      undo: 'Undo',
      redo: 'Redo',
      pin: 'Pin to desktop',
      pinnedHint: 'Pinned · drag to move · scroll to zoom · click × to destroy',
      pinFailed: 'Failed to pin, please retry',
      color: 'Color',
      size: 'Size',
      save: 'Save',
      ocr: 'Recognize text',
      ocrResult: 'Recognized text',
      translateResult: 'Translation',
      copyTranslation: 'Copy translation',
      recognizing: 'Recognizing',
      ocrLoginRequired: 'Please sign in to use text recognition',
      copyText: 'Copy text',
      copyPlainText: 'Copy as plain text',
      copyMarkdown: 'Copy Markdown',
      previewMd: 'Preview',
      editMd: 'Edit',
      copied: 'Copied',
      close: 'Close',
      noTextFound: 'No text recognized',
      ocrFailed: 'Text recognition failed',
      ocrTimeout: 'Text recognition was cancelled or timed out',
      imageTooLarge: 'Screenshot must not exceed 10MB',
      invalidImageDimensions: 'Image sides must be 15–8192 px with an aspect ratio below 50',
      translate: 'Translate',
      translateText: 'Translate',
      langAuto: 'Auto detect',
      showOriginal: 'Show original',
      showTranslation: 'Show translation',
      translating: 'Translating',
      loginRequired: 'Please sign in to a Pro account to translate images',
      translateFailed: 'Image translation failed',
      invalidData: 'Invalid screenshot data',
      submitFailed: 'Failed to submit image translation task',
      queryFailed: 'Failed to query image translation task',
      noResultUrl: 'Server did not return translated image',
      timeout: 'Image translation timed out, please try again',
      aborted: 'Image translation request was cancelled or timed out',
      captureWindowClosed: 'Screenshot window was closed',
      cancel: 'Cancel',
      done: 'Done',
      captureHint: 'Drag to select a region · Hover a window to select it · Enter to finish · Esc to cancel',
      lsStartHint: 'Scrolling captures automatically (mouse position irrelevant). Move the mouse out of the selection — hover effects interfere with stitching',
      guideStart: 'Drag to select · Hover a window to select it',
      guideNudgeSel: '↑↓←→ / WASD nudge selection · Shift = 10px',
      guideNudgeAnnot: '↑↓←→ nudge hovered object · Shift = 10px',
      guideDblEdit: 'Double-click text/shape to edit again',
      guideFinish: 'Enter to finish · Esc to cancel',
      captureInputText: 'Enter text',
      longScreenshot: 'Long screenshot',
      record: 'Record',
      qr: 'QR code',
      featureSoon: 'Coming soon',
      qrResult: 'QR content',
      openLink: 'Open link',
      noQrFound: 'No QR code recognized',
      recording: 'Recording',
      stopRec: 'Stop',
      pauseRec: 'Pause',
      resumeRec: 'Resume',
      longShotHint: 'Window stays visible; scroll inside the selection to stitch; click "Done" at bottom or press Enter to finish, Esc to cancel',
      longShotPreview: 'Stitch preview',
      translateTargetLang: 'Translate to',
    },
  },
};

function normalizeCaptureLanguage(raw) {
  if (typeof raw !== 'string') return 'zh-CN';
  if (raw === 'en' || raw === 'en-US' || raw.startsWith('en-')) return 'en-US';
  return 'zh-CN';
}

function tCapture(key) {
  return CAPTURE_I18N[captureLanguage].tools[key] || CAPTURE_I18N['zh-CN'].tools[key] || key;
}

function applyCaptureLanguage(language) {
  captureLanguage = normalizeCaptureLanguage(language);
  document.documentElement.lang = captureLanguage;
  Array.from(document.querySelectorAll('[data-i18n]')).forEach((el) => {
    el.textContent = tCapture(el.dataset.i18n);
  });
  Array.from(document.querySelectorAll('[data-i18n-title]')).forEach((el) => {
    el.title = tCapture(el.dataset.i18nTitle);
  });
  Array.from(document.querySelectorAll('[data-i18n-aria-label]')).forEach((el) => {
    el.setAttribute('aria-label', tCapture(el.dataset.i18nAriaLabel));
  });
  updateTranslateButtonLabel();
  syncShapeButton();
  syncMaskButton();
  if (textEditor) {
    const ph = textEditor.getAttribute('data-i18n-placeholder');
    if (ph) textEditor.placeholder = tCapture(ph) || '';
  }
}

async function initCaptureLanguage() {
  try {
    const stored = await ipcRenderer.invoke('store:read', 'i18n-language');
    applyCaptureLanguage(stored);
  } catch {
    applyCaptureLanguage(navigator.language);
  }
}

void initCaptureLanguage();

async function initOcrEngine() {
  try {
    // 与 src/shared/storeKeys.ts 中 SCREENSHOT_OCR_ENGINE_STORE_KEY 保持一致。
    // store:read 未设置时返回 null → 一律落到本机 Tesseract（秒开），与设置页/storeConfig 默认值一致，
    // 只有用户显式选过 paddleocr/server 才用服务端（避免首装误走需登录的 server OCR）。
    const stored = await ipcRenderer.invoke('store:read', 'screenshot-ocr-engine');
    ocrEngine = stored === 'paddleocr' || stored === 'server' ? stored : 'local';
    // 与 src/shared/storeKeys.ts 中 SCREENSHOT_TRANSLATE_ENGINE_STORE_KEY 保持一致。
    // 未设置/null → 本机 Hy-MT2（免费离线）；'cloud' 也走本地服务 IPC（主进程按配置转发云端百度翻译）。
    const trStored = await ipcRenderer.invoke('store:read', 'screenshot-translate-engine');
    translateEngine = trStored === 'server' || trStored === 'cloud' ? trStored : 'local';
  } catch {
    ocrEngine = 'local';
    translateEngine = 'local';
  }
  if (ocrProIcon) {
    // 本机引擎（Tesseract / PaddleOCR）都不需要服务端会员标识
    ocrProIcon.style.display = ocrEngine === 'server' ? '' : 'none';
  }
  const translateProIcon = document.querySelector('.capture-translate-pro-icon');
  if (translateProIcon) {
    // 翻译按钮同理：本机 Hy-MT2 不需要服务端会员标识
    translateProIcon.style.display = translateEngine === 'server' ? '' : 'none';
  }
}

void initOcrEngine();

/** 当前窗口 DPR（高分屏 >1），canvas backing store 与 CSS 显示尺寸分离 */
let canvasDpr = 1;

/**
 * 设置 canvas 的 backing store 为物理分辨率、CSS 显示为逻辑分辨率，
 * 并让 2D context 以 DPR 缩放，使后续绘制代码可用逻辑坐标直接操作。
 */
function setupCanvasDpr(cv) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = window.innerWidth;
  const cssH = window.innerHeight;
  cv.width = Math.round(cssW * dpr);
  cv.height = Math.round(cssH * dpr);
  cv.style.width = `${cssW}px`;
  cv.style.height = `${cssH}px`;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
}

/**
 * 初始化各层画布尺寸
 * @description 在窗口尺寸变化后同步画布，保证坐标系统一致。
 * 背景层 bgCanvas 一次性绘制屏幕位图；标注/临时层按需重绘；
 * 遮罩与选区已 DOM 化（captureMask/captureHandles），不再占用 canvas 图层。
 */
function initCanvases() {
  canvasDpr = window.devicePixelRatio || 1;
  W = window.innerWidth;
  H = window.innerHeight;
  [bgCanvas, drawCanvas, annotCanvas, tempCanvas].forEach(setupCanvasDpr);
  drawBackground();
  // 修复历史遗留 bug：原调用未定义的 redrawFromHistoryTop()，每次 init 都 ReferenceError，
  // 导致 capture-ready 从不主动发送（首帧永远等主进程 800ms 兜底）且 resize 后遮罩不刷新。
  // 这里语义就是"按当前历史态重绘"。
  restoreHistoryTop();
  drawMask();
}

function drawBackground() {
  bgCtx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
  if (!bgImage) return;

  if (!captureVirtualScreen || !capturePhysicalScreen || captureDisplays.length === 0) {
    // LS 编辑态：bg 画布 backing = 原图物理像素 + 恒等变换 → 自然尺寸绘制 = 严格 1:1
    // 零重采样（任何 W,H 缩放路径都会引入 ±1px 级重采样，探针能测出差值）。
    // ⚠️ 变换感知：若 bg 被重新设为 dpr 变换（如 resize 重入 setupCanvasDpr），
    // 自然尺寸绘制会整体放大 dpr 倍 —— 此时回退 W,H 逻辑绘制保底
    const bt = bgCtx.getTransform();
    if (bt.a === 1 && bt.d === 1 && bgImage.naturalWidth === bgCanvas.width
      && bgImage.naturalHeight === bgCanvas.height) {
      bgCtx.drawImage(bgImage, 0, 0);
    } else {
      bgCtx.drawImage(bgImage, 0, 0, W, H);
    }
    return;
  }

  const sourceScaleX = bgImage.naturalWidth / capturePhysicalScreen.width;
  const sourceScaleY = bgImage.naturalHeight / capturePhysicalScreen.height;
  captureDisplays.forEach((display) => {
    const source = display.physicalBounds;
    const target = display.bounds;
    bgCtx.drawImage(
      bgImage,
      (source.x - capturePhysicalScreen.x) * sourceScaleX,
      (source.y - capturePhysicalScreen.y) * sourceScaleY,
      source.width * sourceScaleX,
      source.height * sourceScaleY,
      target.x - captureVirtualScreen.x,
      target.y - captureVirtualScreen.y,
      target.width,
      target.height,
    );
  });
}

function clearTemp() {
  tempCtx.clearRect(0, 0, W, H);
}

/**
 * 绘制遮罩层与选区边框
 * @description 非选区区域使用半透明遮罩，便于用户聚焦当前操作区域
 */
/**
 * 更新遮罩与选区装饰（DOM 版，取代旧的全屏 canvas 遮罩重绘）
 * @description 四边暗条 + 中心透明框，明确做出「选区高亮、其余变黑」。
 * 位置用 transform: translate3d 做 GPU 合成，避免每次 mousemove 都触发全量 layout。
 */
function layoutHole(hole) {
  if (!captureMask) return;
  // hole: null → 未进入任何选区（IDLE 且无 hover 窗口）：整屏均匀半透明蒙版。
  if (!hole) {
    captureMask.classList.remove('is-deep');
    captureMask.classList.add('is-full');
    captureMask.style.display = 'block';
    return;
  }
  captureMask.classList.remove('is-full');
  captureMask.classList.add('is-deep');
  captureMask.style.display = 'block';

  const x = hole.x;
  const y = hole.y;
  const w = hole.width;
  const h = hole.height;
  const right = x + w;
  const bottom = y + h;

  // 四边暗条：只覆盖选区外的四个矩形区域
  const [topBar, bottomBar, leftBar, rightBar] = captureMaskBars;
  if (topBar) {
    topBar.style.transform = 'translate3d(0, 0, 0)';
    topBar.style.width = '100%';
    topBar.style.height = `${Math.max(0, y)}px`;
  }
  if (bottomBar) {
    bottomBar.style.transform = `translate3d(0, ${bottom}px, 0)`;
    bottomBar.style.width = '100%';
    bottomBar.style.height = `${Math.max(0, H - bottom)}px`;
  }
  if (leftBar) {
    leftBar.style.transform = `translate3d(0, ${y}px, 0)`;
    leftBar.style.width = `${Math.max(0, x)}px`;
    leftBar.style.height = `${Math.max(0, h)}px`;
  }
  if (rightBar) {
    rightBar.style.transform = `translate3d(${right}px, ${y}px, 0)`;
    rightBar.style.width = `${Math.max(0, W - right)}px`;
    rightBar.style.height = `${Math.max(0, h)}px`;
  }

  // 中心透明框：贴边蓝框 + 白高光，框内直接透出 bgCanvas（高亮）
  if (captureMaskFrame) {
    captureMaskFrame.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    captureMaskFrame.style.width = `${Math.max(0, w)}px`;
    captureMaskFrame.style.height = `${Math.max(0, h)}px`;
  }
  // 自校验：下一帧核对暗条实际盒子 == 期望几何，错位立即抓拍现场
  verifyMaskGeometry(hole);
}

/**
 * 遮罩审计（低频诊断，只在关键状态切换时调用）：
 * 转储遮罩几何、每条暗条的行内样式与实际盒子，并用 elementFromPoint 探测
 * 「洞中心 / 四边 / 四角」每个采样点上最顶层的元素是谁 —— 用于远程定位
 * 「蒙版位置不对 / 该暗的地方不暗 / 洞里被盖住」这类只有肉眼能发现的问题。
 */
function auditMask(reason) {
  try {
    const vpW = window.innerWidth;
    const vpH = window.innerHeight;
    const info = [];
    info.push(`reason=${reason} sel=${selX},${selY} ${selW}x${selH} state=${state}`);
    info.push(`W/H=${W}x${H} viewport=${vpW}x${vpH} dpr=${window.devicePixelRatio} scaleFactor=${scaleFactor}`);
    info.push(`mask.class=${captureMask.className} display=${captureMask.style.display}`);
    info.push(`maskColors: idleVar=${getComputedStyle(captureMask).getPropertyValue('--cap-mask-idle')}`
      + ` deepVar=${getComputedStyle(captureMask).getPropertyValue('--cap-mask-deep')}`
      + ` bar0Bg=${captureMaskBars[0] ? getComputedStyle(captureMaskBars[0]).backgroundColor : '?'}`);
    const bars = captureMaskBars.map((b, i) => {
      const r = b.getBoundingClientRect();
      return `bar${i}[${b.dataset.bar}](${b.style.transform || 'none'} ${b.style.width}x${b.style.height})`
        + ` rect=${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`
        + ` disp=${getComputedStyle(b).display}`;
    });
    info.push(bars.join(' | '));
    if (captureMaskFrame) {
      const fr = captureMaskFrame.getBoundingClientRect();
      info.push(`frame rect=${Math.round(fr.left)},${Math.round(fr.top)} ${Math.round(fr.width)}x${Math.round(fr.height)} disp=${getComputedStyle(captureMaskFrame).display}`);
    }
    // 探针点：洞中心（应透亮）+ 洞四边外侧 24px（应压暗）+ 屏幕四角（应压暗）
    const probes = [];
    if (selW >= 1 && selH >= 1) {
      probes.push(
        ['hole-center(应透亮)', selX + selW / 2, selY + selH / 2],
        ['above-hole(应暗)', selX + selW / 2, Math.max(2, selY - 24)],
        ['below-hole(应暗)', selX + selW / 2, Math.min(vpH - 2, selY + selH + 24)],
        ['left-of-hole(应暗)', Math.max(2, selX - 24), selY + selH / 2],
        ['right-of-hole(应暗)', Math.min(vpW - 2, selX + selW + 24), selY + selH / 2],
      );
    }
    probes.push(
      ['corner-TL(应暗)', 2, 2],
      ['corner-TR(应暗)', vpW - 2, 2],
      ['corner-BL(应暗)', 2, vpH - 2],
      ['corner-BR(应暗)', vpW - 2, vpH - 2],
    );
    for (const [name, px, py] of probes) {
      const el = document.elementFromPoint(px, py);
      const cs = el ? getComputedStyle(el) : null;
      info.push(`probe ${name} @(${Math.round(px)},${Math.round(py)}) -> ${el ? `${el.tagName}.${el.className || el.id}` : 'null'} bg=${cs ? cs.backgroundColor : '?'} disp=${cs ? cs.display : '?'}`);
    }
    info.forEach((l) => console.error(`[MASK-AUDIT] ${l}`));
  } catch (err) {
    console.error('[MASK-AUDIT] failed', err);
  }
}

// 自校验节流：500ms 最多一次（rAF 里读 rect 是一次强制布局，不能每帧做）
let lastMaskVerify = 0;

/**
 * 遮罩几何自校验：layoutHole 写完样式后下一帧核对「每条暗条的实际渲染盒子」
 * 是否与期望几何一致。偏差 >1px 视为错位（比如暗条拿到过期几何 / 行内样式被覆盖），
 * 立即转储完整审计现场。这是远程定位「蒙版位置不对」的自动抓拍器。
 */
function verifyMaskGeometry(hole) {
  // 长截图/结果编辑态暗条被 CSS display:none 隐藏（rect 全 0），校验无意义
  if (document.body.classList.contains('is-longshot') || document.body.classList.contains('is-longshot-edit')) return;
  const nowMs = Date.now();
  if (nowMs - lastMaskVerify < 500) return;
  lastMaskVerify = nowMs;
  requestAnimationFrame(() => {
    try {
      const x = hole.x, y = hole.y, w = hole.width, h = hole.height;
      const right = x + w, bottom = y + h;
      const expected = [
        ['top', 0, 0, window.innerWidth, y],
        ['bottom', 0, bottom, window.innerWidth, window.innerHeight - bottom],
        ['left', 0, y, x, h],
        ['right', right, y, window.innerWidth - right, h],
      ];
      const bars = captureMaskBars;
      for (let i = 0; i < 4; i++) {
        const r = bars[i].getBoundingClientRect();
        const [name, ex, ey, ew, eh] = expected[i];
        const off = Math.max(Math.abs(r.left - ex), Math.abs(r.top - ey), Math.abs(r.width - ew), Math.abs(r.height - eh));
        if (off > 1) {
          console.error(`[MASK-VERIFY] MISMATCH bar=${name} expect=(${ex},${ey}) ${ew}x${eh} actual=(${Math.round(r.left)},${Math.round(r.top)}) ${Math.round(r.width)}x${Math.round(r.height)} off=${Math.round(off)}px`);
          auditMask(`mask-mismatch:${name}`);
          return;
        }
      }
      console.error(`[MASK-VERIFY] ok hole=${x},${y} ${w}x${h}`);
    } catch (_) { /* ignore */ }
  });
}

function layoutHandles(visible) {
  if (!visible) {
    captureHandles.style.display = 'none';
    return;
  }
  captureHandles.style.display = 'block';
  captureHandles.style.left = `${selX}px`;
  captureHandles.style.top = `${selY}px`;
  captureHandles.style.width = `${selW}px`;
  captureHandles.style.height = `${selH}px`;
}

function drawMask() {
  if (captureHint) {
    // 仅 IDLE（未选区）时显示操作提示，进入选区/标注后隐藏
    captureHint.style.display = state === STATE.IDLE ? 'flex' : 'none';
  }

  if (state === STATE.IDLE) {
    // 未选区：仅 hover 到窗口时开洞高亮，否则整屏遮罩
    if (!hoverWindowRect) {
      layoutHole(null);
      layoutHandles(false);
      return;
    }
    layoutHole(hoverWindowRect);
    layoutHandles(false);
    return;
  }

  // 选区/拖动/标注中：洞 = 当前选区
  if (selW >= 1 && selH >= 1) {
    layoutHole({ x: selX, y: selY, width: selW, height: selH });
  } else {
    layoutHole(null);
  }
  layoutHandles(
    activeTool === 'select'
    && (state === STATE.SELECTED || state === STATE.MOVING || state === STATE.RESIZING)
    && !document.body.classList.contains('is-longshot-edit'),
  );

  // 对象层跟随当前选区重裁：选区几何（大小/位置）一变，矢量对象的可见范围就变。
  // renderAnnots 内部会 clearRect + clipToSelection，空数组直接清屏跳过，开销可忽略。
  if (annotCtx && annotations.length && selW >= 1 && selH >= 1) {
    renderAnnots();
  }
}

function getHandlePositions() {
  const cx = selX + selW / 2;
  const cy = selY + selH / 2;
  return {
    tl: [selX, selY],
    t: [cx, selY],
    tr: [selX + selW, selY],
    r: [selX + selW, cy],
    br: [selX + selW, selY + selH],
    b: [cx, selY + selH],
    bl: [selX, selY + selH],
    l: [selX, cy],
  };
}

function hitTestHandle(mx, my) {
  const handles = getHandlePositions();
  const matched = Object.entries(handles).find((entry) => {
    const p = entry[1];
    return Math.abs(mx - p[0]) <= HANDLE_HIT && Math.abs(my - p[1]) <= HANDLE_HIT;
  });
  return matched ? matched[0] : '';
}

function isInsideSelection(mx, my) {
  return mx >= selX && mx <= selX + selW && my >= selY && my <= selY + selH;
}

/**
 * 设置可见窗口矩形列表
 * @description 将窗口的虚拟屏幕坐标转换为画布相对坐标，支持多显示器偏移
 * @param windows - 原始窗口边界数组（虚拟屏幕坐标）
 * @param virtualScreen - 虚拟屏幕边界 { x, y, width, height }
 */
function setVisibleWindowRects(windows, virtualScreen) {
  const vs = virtualScreen || { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
  captureWindowRects = Array.isArray(windows)
    ? windows.map((item) => {
      const left = Math.max(item.x, vs.x);
      const top = Math.max(item.y, vs.y);
      const right = Math.min(item.x + item.width, vs.x + vs.width);
      const bottom = Math.min(item.y + item.height, vs.y + vs.height);
      return {
        x: Math.max(0, Math.round(left - vs.x)),
        y: Math.max(0, Math.round(top - vs.y)),
        width: Math.max(0, Math.round(right - left)),
        height: Math.max(0, Math.round(bottom - top)),
        title: item.title || '',
      };
    }).filter((item) => item.width >= 40 && item.height >= 40)
    : [];
}

function findWindowRectAt(mx, my) {
  return captureWindowRects.find((item) => (
    mx >= item.x && mx <= item.x + item.width && my >= item.y && my <= item.y + item.height
  )) || null;
}

function selectWindowRect(rect) {
  resetTranslationCache();
  selX = rect.x;
  selY = rect.y;
  selW = rect.width;
  selH = rect.height;
  hoverWindowRect = null;
  state = STATE.SELECTED;
  historyStack.length = 0;
  resetAnnots();
  drawCtx.clearRect(0, 0, W, H);
  showToolbar();
  drawMask();
  updateSizeInfo(selX, selY);
}

function clipToSelection(ctx) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(selX, selY, selW, selH);
  ctx.clip();
}

function restoreClip(ctx) {
  ctx.restore();
}

/* ── 矢量标注对象层：annotations 数组 + annotCanvas 整层渲染 ── */

/** 深拷贝对象数组（历史快照/移动基准都基于拷贝，避免原地修改污染） */
function cloneAnnots(src) {
  const list = Array.isArray(src) ? src : annotations;
  return list.map((a) => {
    if (a.type === 'text') {
      return {
        type: 'text', x: a.x, y: a.y, text: a.text,
        color: a.color, fontFamily: a.fontFamily, fontSize: a.fontSize,
        lineHeight: a.lineHeight, maxWidth: a.maxWidth,
        lines: Array.isArray(a.lines) ? a.lines.map((ln) => ({ text: ln.text, start: ln.start, end: ln.end, width: ln.width })) : [],
        editing: a.editing === true,
      };
    }
    return { type: 'shape', shape: a.shape, x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, color: a.color, size: a.size };
  });
}

/** 把当前 annotations 整层重绘到 annotCanvas（裁到选区；空数组只清屏） */
function renderAnnots() {
  if (!annotCtx) return;
  annotCtx.clearRect(0, 0, W, H);
  if (!annotations.length) return;
  clipToSelection(annotCtx);
  for (const a of annotations) {
    if (a.type === 'text') drawAnnotText(annotCtx, a);
    else drawAnnotShape(annotCtx, a);
  }
  restoreClip(annotCtx);
  // 悬停 / 拖动中的对象：画虚线选中框（拖动优先），提示可直接拖动、移动中保持可见
  const boxIdx = dragAnnotIndex >= 0 ? dragAnnotIndex : hoverAnnotIndex;
  if (boxIdx >= 0 && annotations[boxIdx]) {
    clipToSelection(annotCtx);
    drawAnnotSelectionBox(annotCtx, annotations[boxIdx]);
    restoreClip(annotCtx);
  }
}

/** 对象选中框：虚线描边 + 半透明底（悬停提示 / 拖动反馈共用） */
function drawAnnotSelectionBox(ctx, a) {
  const b = annotBounds(a);
  if (!b || (b.w <= 0 && b.h <= 0)) return;
  const pad = 4;
  ctx.save();
  ctx.fillStyle = 'rgba(64, 156, 255, .10)';
  ctx.fillRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
  ctx.strokeStyle = 'rgba(64, 156, 255, .95)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.strokeRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
  ctx.restore();
}

/** 清空对象层（翻译切图/重置时调用：标注已烤进替换的图像里） */
function resetAnnots() {
  annotations = [];
  dragAnnotIndex = -1;
  hoverAnnotIndex = -1;
  if (annotCtx) annotCtx.clearRect(0, 0, W, H);
}

/** 渲染单个图形对象（drawXxx 系列支持显式 color/width，见各自定义） */
function drawAnnotShape(ctx, a) {
  if (a.shape === 'line') drawLine(ctx, a.x1, a.y1, a.x2, a.y2, a.color, a.size);
  else if (a.shape === 'rect') drawRect(ctx, a.x1, a.y1, a.x2, a.y2, a.color, a.size);
  else if (a.shape === 'arrow') drawArrow(ctx, a.x1, a.y1, a.x2, a.y2, a.color, a.size);
  else if (a.shape === 'ellipse') drawEllipse(ctx, a.x1, a.y1, a.x2, a.y2, a.color, a.size);
}

/** 渲染单个文字对象（行宽在布局时已固化在 lines[].width） */
function drawAnnotText(ctx, a) {
  if (!a.text || !a.lines || !a.lines.length) return;
  ctx.save();
  ctx.fillStyle = a.color;
  ctx.font = `${a.fontSize}px ${a.fontFamily}`;
  // 垂直居中：每行文字落在「行盒中线」(a.y + (idx+0.5)*lineHeight)，而非顶边对齐。
  // 这样文字在选区/文字框里视觉居中（不再整体偏高），点击点也正好是第一行中线（Snipaste 手感）。
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const lineHeightPx = Math.max(1, Math.round(a.fontSize * a.lineHeight));
  a.lines.forEach((ln, idx) => {
    if (ln.text) ctx.fillText(ln.text, a.x, a.y + lineHeightPx * (idx + 0.5));
  });
  ctx.restore();
}

/** 对象包围盒（CSS 坐标；文字按已布局的每行矩形并集） */
function annotBounds(a) {
  if (a.type === 'text') {
    if (!a.lines || !a.lines.length) return { x: a.x, y: a.y, w: 0, h: 0 };
    const lineHeightPx = Math.max(1, Math.round(a.fontSize * a.lineHeight));
    const width = Math.max(1, ...a.lines.map((ln) => ln.width || 1));
    const height = Math.max(1, a.lines.length * lineHeightPx);
    return { x: a.x, y: a.y, w: width, h: height };
  }
  const x = Math.min(a.x1, a.x2);
  const y = Math.min(a.y1, a.y2);
  return { x, y, w: Math.abs(a.x2 - a.x1), h: Math.abs(a.y2 - a.y1) };
}

/** 点到线段的最短距离（命中判定用） */
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-6) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/**
 * MOVE 工具命中检测：从最上层（数组尾部）往下找第一个命中 mx,my 的对象。
 * - 矩形/椭圆：命中其内部或边框带（Snipaste 手感：点中对象区域即可拖动）
 * - 直线/箭头：命中线段附近（含线宽/2 + 4px 容差；箭头还含末端三角区）
 * - 文字：命中任一行文字的包围矩形
 * @returns {number} 命中的对象下标；-1 = 未命中任何对象
 */
function hitTestAnnot(mx, my) {
  const pad = 4;
  for (let i = annotations.length - 1; i >= 0; i--) {
    const a = annotations[i];
    if (a.editing) continue; // 编辑中的文字不允许被 MOVE 抢走
    if (a.type === 'text') {
      const { x, y, w, h } = annotBounds(a);
      if (mx >= x - pad && mx <= x + w + pad && my >= y - pad && my <= y + h + pad) return i;
      continue;
    }
    if (a.shape === 'rect' || a.shape === 'ellipse') {
      const b = annotBounds(a);
      if (mx < b.x - pad || mx > b.x + b.w + pad || my < b.y - pad || my > b.y + b.h + pad) continue;
      if (a.shape === 'rect') return i; // 实心命中：内部或边框都算
      // 椭圆：近似 bbox 内判定（内切椭圆误差对拖动够用）
      if (b.w < 2 || b.h < 2) return i;
      const nx = (mx - (b.x + b.w / 2)) / (b.w / 2 + pad);
      const ny = (my - (b.y + b.h / 2)) / (b.h / 2 + pad);
      if (nx * nx + ny * ny <= 1.25) return i; // 略放宽，接近边框即可命中
      continue;
    }
    // line / arrow：线段附近（线宽一半 + 容差）；箭头再加头部范围
    const tol = Math.max(6, a.size / 2 + pad);
    if (distToSegment(mx, my, a.x1, a.y1, a.x2, a.y2) <= tol) return i;
    if (a.shape === 'arrow') {
      const angle = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
      const head = Math.max(10, a.size * 3);
      const a1 = angle + Math.PI * 0.75;
      const a2 = angle - Math.PI * 0.75;
      const p1x = a.x2 + head * Math.cos(a1);
      const p1y = a.y2 + head * Math.sin(a1);
      const p2x = a.x2 + head * Math.cos(a2);
      const p2y = a.y2 + head * Math.sin(a2);
      if (distToSegment(mx, my, a.x2, a.y2, p1x, p1y) <= tol) return i;
      if (distToSegment(mx, my, a.x2, a.y2, p2x, p2y) <= tol) return i;
    }
  }
  return -1;
}

/**
 * 对象拖动的单轴位移钳制：
 * - 对象比选区小：极限 = 「贴左」~「贴右」，即拖动中对象始终完整留在选区内；
 * - 对象比选区还大：只限相位，保证选区始终被对象覆盖；
 * - 对象创建时可能已部分越界（渲染只裁到选区）：把 base 位置并入允许区间，
 *   于是只能把它往选区内拉，不能拖得更出去（杜绝对象被整只拖出选区后找不回来）。
 * @param basePos 对象 bbox 在该轴上的 base 左上坐标
 * @param size    对象 bbox 在该轴上的尺寸
 * @param delta   本次鼠标位移
 * @returns 实际可用的位移量（已钳制）
 */
function clampAnnotAxis(basePos, size, delta, selPos, selSize) {
  let pMin = selPos;
  let pMax = selPos + selSize - size;
  if (size >= selSize) {
    // 对象不比选区小：相位范围反转（覆盖选区时左右两端都可达）
    pMin = selPos + selSize - size;
    pMax = selPos;
  }
  const lo = Math.min(basePos, pMin);
  const hi = Math.max(basePos, pMax);
  const candidate = basePos + delta;
  return Math.min(hi, Math.max(lo, candidate)) - basePos;
}

/**
 * 拖动中实时更新 dragAnnotIndex 指向的对象 = dragBase 的坐标 + 钳制后的位移。
 * 位图与历史都不动；mouseup 时确认位移过才收一步 commitHistory(false)。
 */
function moveAnnotByDrag(mx, my) {
  const a = annotations[dragAnnotIndex];
  const b = dragBase;
  if (!a || !b) return;
  const bb = annotBounds(b);
  const dx = clampAnnotAxis(bb.x, bb.w, mx - dragStartX, selX, selW);
  const dy = clampAnnotAxis(bb.y, bb.h, my - dragStartY, selY, selH);
  if (a.type === 'text') {
    a.x = b.x + dx;
    a.y = b.y + dy;
  } else {
    a.x1 = b.x1 + dx;
    a.y1 = b.y1 + dy;
    a.x2 = b.x2 + dx;
    a.y2 = b.y2 + dy;
  }
}

/**
 * 历史栈：仅存储选区范围内的 ImageData 快照，避免高分屏整屏快照导致内存暴涨。
 * 采用 historyIndex + historyStack 的线性模型：commit 时截断后续分支，
 * undo/redo 通过移动 historyIndex 并在绘制层重绘对应快照实现。
 *
 * 对象层重构后每步还携带 annots（当时矢量对象数组的深拷贝）：
 * 撤销/重做同时回退位图与对象层，保证 hitTest/拖动永远基于当前历史态。
 */
/** 当前历史状态索引，-1 表示空白画布 */
let historyIndex = -1;

/**
 * 提交一次标注后的状态到历史栈（截断 redo 分支）。
 * @param bitmapChanged - 自上次 commit 后 drawCanvas 位图是否被改过。
 *   true（画笔/打码/翻译叠图/文字等改像素的操作）：重新截取选区 ImageData；
 *   false（仅增删/移动矢量对象）：位图没变，直接复用栈顶快照的 ImageData 引用
 *   —— 对象步不再产生新的几十 MB 像素拷贝，历史内存与原来持平。
 * 历史深度按快照字节数动态收缩：小选区允许 MAX_HISTORY 步，
 * 高分屏大选区（单快照可达 ~20MB）自动降低步数，把总内存压在 HISTORY_BUDGET_BYTES 内。
 */
function commitHistory(bitmapChanged = true) {
  if (selW < 1 || selH < 1) return;
  const dpr = canvasDpr;
  const top = historyIndex >= 0 ? historyStack[historyIndex] : null;
  let data = null;
  if (bitmapChanged) {
    data = drawCtx.getImageData(
      Math.round(selX * dpr), Math.round(selY * dpr), Math.round(selW * dpr), Math.round(selH * dpr),
    );
  } else if (top && top.data) {
    data = top.data; // 位图未变：共享同一份 ImageData（restore 只读不写，可安全共享）
  }
  const snap = { data, x: selX, y: selY, w: selW, h: selH, annots: cloneAnnots() };
  historyStack.length = historyIndex + 1;
  historyStack.push(snap);
  const snapBytes = data ? data.data.length : 0;
  const cap = snapBytes > 0 ? Math.min(MAX_HISTORY, Math.max(1, Math.floor(HISTORY_BUDGET_BYTES / snapBytes))) : MAX_HISTORY;
  while (historyStack.length > cap) historyStack.shift();
  historyIndex = historyStack.length - 1;
}

/**
 * 将 historyIndex 指向的快照恢复到绘制层与对象层（-1 = 清空为空白画布）。
 * data 为 null 的快照表示「该步位图=空白」：清掉选区内的像素（其余区域本就是透明的）。
 */
function restoreHistoryTop() {
  drawCtx.clearRect(0, 0, W, H);
  if (historyIndex >= 0) {
    const snap = historyStack[historyIndex];
    if (snap) {
      const dpr = canvasDpr;
      if (snap.data) {
        drawCtx.putImageData(snap.data, Math.round(snap.x * dpr), Math.round(snap.y * dpr));
      } else {
        drawCtx.clearRect(Math.round(snap.x * dpr), Math.round(snap.y * dpr), Math.round(snap.w * dpr), Math.round(snap.h * dpr));
      }
      // 同步恢复矢量对象层（深拷贝，避免与历史快照共享引用后被原地修改）
      annotations = Array.isArray(snap.annots) ? cloneAnnots(snap.annots) : [];
    }
  } else {
    annotations = [];
  }
  renderAnnots();
}

function undoLast() {
  if (historyIndex < 0) return;
  historyIndex -= 1;
  restoreHistoryTop();
}

function redoLast() {
  if (historyIndex >= historyStack.length - 1) return;
  historyIndex += 1;
  restoreHistoryTop();
}

/** 物理像素化：CSS 坐标 × scaleFactor（≈DPR），与 Snipaste 显示真实屏幕像素一致 */
function physPx(css) {
  const sf = scaleFactor && scaleFactor > 0 ? scaleFactor : 1;
  return Math.round(css * sf);
}

function updateSizeInfo(mx, my) {
  if (state === STATE.IDLE) {
    // 空闲态（尚未框选区域）：不展示尺寸标识，避免与放大镜旁的标签重复、也避免未选区时多余信息
    sizeInfo.style.display = 'none';
    return;
  }
  if (state === STATE.SELECTED || state === STATE.MOVING || state === STATE.RESIZING || state === STATE.ANNOTATING || state === STATE.DRAWING) {
    sizeInfo.style.display = 'block';
    sizeInfo.textContent = `${physPx(selW)} × ${physPx(selH)}  (${physPx(selX)}, ${physPx(selY)})`;
    sizeInfo.style.left = `${selX}px`;
    sizeInfo.style.top = `${Math.max(selY - 26, 0)}px`;
    return;
  }
}

/**
 * Snipaste 式像素放大镜：固定倍数、像素网格、整数像素对齐采样。
 * @description 采样源为 bgCanvas（物理分辨率 backing，1:1 还原各显示器）；
 * 以光标所在物理像素为中心，取整数个源像素放大，避免亚像素插值产生的模糊。
 * @param mx - 鼠标 CSS x（窗口内）
 * @param my - 鼠标 CSS y（窗口内）
 */
// 放大镜外框尺寸缓存：updateMagnifier 每帧都读 offsetWidth/offsetHeight 会触发
// 「强制同步布局」（上一帧刚写了 style.left/top，下一帧立刻读几何 → 浏览器必须立即
// 重排整页才能回答）。框选拖动时这就是掉帧主因。尺寸由 CSS 决定，量一次即可。
let magnifierBoxW = 0;
let magnifierBoxH = 0;

function measureMagnifierBox() {
  if (!magnifier) return;
  // 仅在 display 已切到 block 之后量，否则量到 0
  magnifierBoxW = magnifier.offsetWidth || MAGNIFIER_SIZE;
  magnifierBoxH = magnifier.offsetHeight || MAGNIFIER_SIZE;
}

function invalidateMagnifierBox() {
  magnifierBoxW = 0;
  magnifierBoxH = 0;
}

function updateMagnifier(mx, my) {
  if (!magnifier || !magnifierCanvas || !magnifierCtx || !bgImage) return;
  const dpr = window.devicePixelRatio || 1;
  const css = MAGNIFIER_SIZE;
  const zoom = MAGNIFIER_ZOOM;
  const physical = Math.round(css * dpr);

  if (magnifierCanvas.width !== physical) {
    magnifierCanvas.width = physical;
    magnifierCanvas.height = physical;
  }
  magnifierCtx.setTransform(1, 0, 0, 1, 0, 0);
  magnifierCtx.imageSmoothingEnabled = false;
  magnifierCtx.clearRect(0, 0, physical, physical);

  // 光标所在物理像素（对齐到整数）
  const cxPhys = Math.round(mx * dpr);
  const cyPhys = Math.round(my * dpr);
  // 每边源像素数 = MAGNIFIER_SIZE / zoom（整数），源跨度物理像素 = 每边源像素 × dpr
  const srcPixels = MAGNIFIER_SIZE / MAGNIFIER_ZOOM;
  const srcSpan = Math.round(srcPixels * dpr);
  const srcHalf = Math.floor(srcSpan / 2);
  const bgW = bgCanvas.width;
  const bgH = bgCanvas.height;
  let sx = cxPhys - srcHalf;
  let sy = cyPhys - srcHalf;
  let sw = srcSpan;
  let sh = srcSpan;

  // 钳制源矩形到 bgCanvas 边界：鼠标靠近屏幕边缘时源会越界，drawImage 越界部分
  // 目标保持透明 → 透出底层整屏暗蒙版（capture-mask.is-full）→ 形成「左上角深色方块」。
  // 钳制后 canvas 始终完整铺满，不再露透明。光标那侧留出的透明区对应「屏幕外」，本就该是暗色。
  const scale = physical / srcSpan;
  let dx = 0;
  let dy = 0;
  if (sx < 0) { dx = -sx * scale; sw += sx; sx = 0; }
  if (sy < 0) { dy = -sy * scale; sh += sy; sy = 0; }
  if (sx + sw > bgW) sw = bgW - sx;
  if (sy + sh > bgH) sh = bgH - sy;
  const dw = Math.max(1, sw * scale);
  const dh = Math.max(1, sh * scale);

  // 从 bgCanvas（物理 backing）采样 → 目标物理画布（每源像素正好 zoom×dpr 物理像素），最近邻放大
  magnifierCtx.drawImage(bgCanvas, sx, sy, Math.max(1, sw), Math.max(1, sh), dx, dy, dw, dh);

  // 不再叠加整幅像素网格线：1px 白线在浅色截图上会变成“左侧/上侧一片莫名其妙的线条”
  // （dpr 非 1 时 0.5px 错位叠线更明显）。Snipaste 放大镜默认是干净放大 + 边缘描边 + 中心十字。

  // 中心十字准星：中央留出 gap（=1 个放大像素格）让“光标所在源像素”保持裸露可读。
  // 双色两遍绘制（深晕 + 白芯）：浅色/深色内容上都清晰，不会像单白色那样被白底吞掉。
  const hcx = physical / 2 + 0.5;
  const hcy = physical / 2 + 0.5;
  const gap = Math.max(2, Math.round(zoom * dpr)); // 每格边长
  const arm = physical;
  const drawCrosshair = (color, width) => {
    magnifierCtx.strokeStyle = color;
    magnifierCtx.lineWidth = width;
    magnifierCtx.lineCap = 'butt';
    magnifierCtx.beginPath();
    magnifierCtx.moveTo(hcx, 0);
    magnifierCtx.lineTo(hcx, hcy - gap);
    magnifierCtx.moveTo(hcx, hcy + gap);
    magnifierCtx.lineTo(hcx, arm);
    magnifierCtx.moveTo(0, hcy);
    magnifierCtx.lineTo(hcx - gap, hcy);
    magnifierCtx.moveTo(hcx + gap, hcy);
    magnifierCtx.lineTo(arm, hcy);
    magnifierCtx.stroke();
  };
  drawCrosshair('rgba(0,0,0,.75)', Math.round(3 * dpr)); // 深色外晕
  drawCrosshair('rgba(255,255,255,.98)', 1); // 白色内芯

  // 定位：默认显示在光标右下，越界自动翻转到左侧/上方。
  // 尺寸走缓存（measureMagnifierBox 已量过），绝不在这里读 offsetWidth —— 那会强制同步布局。
  const boxW = magnifierBoxW || MAGNIFIER_SIZE;
  const boxH = magnifierBoxH || MAGNIFIER_SIZE;
  let left = mx + 18;
  let top = my + 18;
  if (left + boxW > window.innerWidth - 4) left = mx - boxW - 18;
  if (top + boxH > window.innerHeight - 4) top = my - boxH - 18;
  left = Math.max(4, Math.min(left, window.innerWidth - boxW - 4));
  top = Math.max(4, Math.min(top, window.innerHeight - boxH - 4));
  magnifier.style.left = `${Math.round(left)}px`;
  magnifier.style.top = `${Math.round(top)}px`;
}

function showMagnifier(mx, my) {
  if (!ENABLE_MAGNIFIER || !magnifier || !bgImage) return;
  // display 由 none→block 时才有必要重新量一次（此后尺寸不变，用缓存）
  if (magnifier.style.display !== 'block') {
    magnifier.style.display = 'block';
    measureMagnifierBox();
  }
  updateMagnifier(mx, my);
}

function hideMagnifier() {
  if (magnifier) magnifier.style.display = 'none';
}

function showToolbar() {
  toolbar.style.display = 'flex';
  // 长截图结果编辑态：位置交给 CSS（fixed 底部居中）。内联 left/top 优先级高于 CSS，
  // 不清掉会把工具栏钉在旧选区坐标上（ty 被钳到顶部 6px）+ translateX(-50%) 再左移半宽 → 叠在长图内容上。
  if (document.body.classList.contains('is-longshot-edit')) {
    toolbar.style.left = '';
    toolbar.style.top = '';
    return;
  }
  const tbW = toolbar.offsetWidth || 520;
  const tbH = toolbar.offsetHeight || 40;
  let tx = selX + selW - tbW;
  if (tx < 6) tx = 6;
  let ty = selY + selH + 8;
  if (ty + tbH > H - 6) ty = selY - tbH - 8;
  if (ty < 6) ty = 6;
  toolbar.style.left = `${tx}px`;
  toolbar.style.top = `${ty}px`;
}

function hideToolbar() {
  closeShapeMenu();
  closeMaskMenu();
  closePickerOverlay();
  // 文字是实时画在画布上的，必须用「提交」收尾（先落历史栈再撤浮层），
  // 直接 destroy 会把文字留在画布上却不进历史，后续 undo 就乱了。
  commitTextEditor();
  if (brushCursor) brushCursor.style.display = 'none';
  toolbar.style.display = 'none';
}

function positionTranslateOverlay() {
  translateOverlay.style.left = `${selX}px`;
  translateOverlay.style.top = `${selY}px`;
  translateOverlay.style.width = `${selW}px`;
  translateOverlay.style.height = `${selH}px`;
}

function showTranslateOverlay(message, isError = false) {
  positionTranslateOverlay();
  translateMessage.textContent = message;
  translateOverlay.classList.toggle('is-error', isError);
  translateOverlay.style.display = 'flex';
}

/** 轻量提示（无转圈动画）：贴图成功等短暂反馈。
 *  r61：toast 收缩为内容自适应小胶囊、悬在选区上沿之外——旧实现复用"识别中"状态条的
 *  定位（整块盖住选区），把原图挡住导致没法对比识别结果（用户实测反馈）。
 *  autoHideMs 传参时到时自动消失；不传保持既有调用方语义。 */
function showToastMessage(message, autoHideMs) {
  showTranslateOverlay(message, false);
  translateOverlay.classList.add('is-toast');
  translateOverlay.style.width = 'auto';
  translateOverlay.style.height = 'auto';
  translateOverlay.style.left = `${selX}px`;
  translateOverlay.style.top = `${Math.max(4, selY - 46)}px`;
  translateOverlay.style.maxWidth = `${Math.max(220, selW)}px`;
  if (autoHideMs && autoHideMs > 0) {
    window.setTimeout(() => {
      if (translateOverlay.classList.contains('is-toast')) hideTranslateOverlay();
    }, autoHideMs);
  }
}

function hideTranslateOverlay() {
  translateOverlay.style.display = 'none';
  translateOverlay.classList.remove('is-error');
  translateOverlay.classList.remove('is-toast');
}

function rectanglesOverlap(first, second) {
  return first.left < second.left + second.width
    && first.left + first.width > second.left
    && first.top < second.top + second.height
    && first.top + first.height > second.top;
}

function getToolbarRect() {
  const previousDisplay = toolbar.style.display;
  const previousVisibility = toolbar.style.visibility;
  toolbar.style.display = 'flex';
  toolbar.style.visibility = 'hidden';
  const width = toolbar.offsetWidth || 520;
  const height = toolbar.offsetHeight || 40;
  let left = selX + selW - width;
  if (left < 6) left = 6;
  let top = selY + selH + 8;
  if (top + height > H - 6) top = selY - height - 8;
  if (top < 6) top = 6;
  toolbar.style.display = previousDisplay;
  toolbar.style.visibility = previousVisibility;
  return { left, top, width, height };
}

function availableSpace(candidate) {
  return candidate.width * candidate.height;
}

function positionOcrPanel() {
  if (userPositionedOcr) return true; // 用户已手动定位，保持不动
  const edge = 12;
  const gap = 12;
  const desiredWidth = Math.min(520, Math.max(280, W - edge * 2));
  const desiredHeight = Math.min(420, Math.max(180, H - edge * 2));
  const selection = {
    left: selX,
    top: selY,
    width: selW,
    height: selH,
  };
  const toolbarRect = getToolbarRect();
  const createCandidate = (side) => {
    const horizontal = side === 'top' || side === 'bottom';
    const availableWidth = horizontal
      ? W - edge * 2
      : side === 'left' ? selX - gap - edge : W - selX - selW - gap - edge;
    const availableHeight = horizontal
      ? side === 'top' ? selY - gap - edge : H - selY - selH - gap - edge
      : H - edge * 2;
    const width = Math.min(desiredWidth, availableWidth);
    const height = Math.min(desiredHeight, availableHeight);
    if (width < 220 || height < 140) return null;

    if (side === 'top' || side === 'bottom') {
      return {
        side,
        left: Math.max(edge, Math.min(selX + (selW - width) / 2, W - width - edge)),
        top: side === 'top' ? selY - height - gap : selY + selH + gap,
        width,
        height,
      };
    }
    return {
      side,
      left: side === 'left' ? selX - width - gap : selX + selW + gap,
      top: Math.max(edge, Math.min(selY + (selH - height) / 2, H - height - edge)),
      width,
      height,
    };
  };
  const candidates = ['top', 'bottom', 'left', 'right']
    .map(createCandidate)
    .filter(Boolean);

  const validCandidates = candidates
    .filter((candidate) => (
      candidate.left >= edge
      && candidate.top >= edge
      && candidate.left + candidate.width <= W - edge
      && candidate.top + candidate.height <= H - edge
      && !rectanglesOverlap(candidate, selection)
      && !rectanglesOverlap(candidate, toolbarRect)
    ))
    .sort((first, second) => availableSpace(second) - availableSpace(first));

  const selected = validCandidates[0];
  if (!selected) {
    ocrPanel.style.display = 'none';
    return false;
  }

  ocrPanel.style.width = `${selected.width}px`;
  ocrPanel.style.height = `${selected.height}px`;
  ocrPanel.style.left = `${selected.left}px`;
  ocrPanel.style.top = `${selected.top}px`;
  return true;
}

/** OCR 面板拖拽（标题栏）+ 缩放（右下角手柄）。自适应定位后用户可自由调整位置与大小。
 *  一旦手动操作，userPositionedOcr=true，positionOcrPanel 不再覆盖；下一次新识别结果会重置回自适应。 */
function attachOcrPanelInteractions() {
  if (!ocrPanel) return;
  const header = ocrPanel.querySelector('.capture-ocr-header');
  const resizeHandles = Array.from(ocrPanel.querySelectorAll('.capture-ocr-resize'));
  const MIN_W = 240;
  const MIN_H = 160;
  const MARGIN = 12;

  const clampPanel = (left, top, width, height) => {
    const maxLeft = Math.max(MARGIN, W - width - MARGIN);
    const maxTop = Math.max(MARGIN, H - height - MARGIN);
    return {
      left: Math.min(Math.max(MARGIN, left), maxLeft),
      top: Math.min(Math.max(MARGIN, top), maxTop),
      width,
      height,
    };
  };

  // ---- 拖拽：标题栏 ----
  let drag = null;
  const onHeaderDown = (e) => {
    if (e.target.closest('button')) return; // 关闭按钮等不触发拖拽
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    const rect = ocrPanel.getBoundingClientRect();
    drag = { offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top };
    userPositionedOcr = true;
    if (header.setPointerCapture) header.setPointerCapture(e.pointerId);
    header.classList.add('capture-ocr-dragging');
  };
  const onHeaderMove = (e) => {
    if (!drag) return;
    const rect = ocrPanel.getBoundingClientRect();
    const p = clampPanel(e.clientX - drag.offsetX, e.clientY - drag.offsetY, rect.width, rect.height);
    ocrPanel.style.left = `${p.left}px`;
    ocrPanel.style.top = `${p.top}px`;
  };
  const onHeaderUp = (e) => {
    if (!drag) return;
    drag = null;
    if (header.releasePointerCapture) header.releasePointerCapture(e.pointerId);
    header.classList.remove('capture-ocr-dragging');
  };

  // ---- 缩放：四边 + 四角 8 向手柄 ----
  let resize = null;
  const onResizeDown = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const dir = e.currentTarget.dataset.dir || 'se';
    resize = {
      dir,
      startX: e.clientX,
      startY: e.clientY,
      baseRect: ocrPanel.getBoundingClientRect(),
    };
    userPositionedOcr = true;
    const handleEl = e.currentTarget;
    if (handleEl.setPointerCapture) handleEl.setPointerCapture(e.pointerId);
    handleEl.classList.add('capture-ocr-resizing');
  };
  const onResizeMove = (e) => {
    if (!resize) return;
    const base = resize.baseRect;
    const dx = e.clientX - resize.startX;
    const dy = e.clientY - resize.startY;
    let width = base.width;
    let height = base.height;
    if (resize.dir.includes('e')) width = base.width + dx;
    if (resize.dir.includes('s')) height = base.height + dy;
    if (resize.dir.includes('w')) width = base.width - dx;
    if (resize.dir.includes('n')) height = base.height - dy;
    width = Math.min(Math.max(MIN_W, width), W - MARGIN * 2);
    height = Math.min(Math.max(MIN_H, height), H - MARGIN * 2);
    // 西/北向：固定对边，左/上边跟随尺寸移动
    let left = base.left;
    let top = base.top;
    if (resize.dir.includes('w')) left = base.left + base.width - width;
    if (resize.dir.includes('n')) top = base.top + base.height - height;
    const p = clampPanel(left, top, width, height);
    ocrPanel.style.left = `${p.left}px`;
    ocrPanel.style.top = `${p.top}px`;
    ocrPanel.style.width = `${p.width}px`;
    ocrPanel.style.height = `${p.height}px`;
  };
  const onResizeUp = (e) => {
    if (!resize) return;
    const handleEl = e.currentTarget;
    resize = null;
    if (handleEl.releasePointerCapture) handleEl.releasePointerCapture(e.pointerId);
    handleEl.classList.remove('capture-ocr-resizing');
  };

  if (header) {
    header.addEventListener('pointerdown', onHeaderDown);
    header.addEventListener('pointermove', onHeaderMove);
    header.addEventListener('pointerup', onHeaderUp);
    header.addEventListener('pointercancel', onHeaderUp);
  }
  for (const handleEl of resizeHandles) {
    handleEl.addEventListener('pointerdown', onResizeDown);
    handleEl.addEventListener('pointermove', onResizeMove);
    handleEl.addEventListener('pointerup', onResizeUp);
    handleEl.addEventListener('pointercancel', onResizeUp);
  }
}
attachOcrPanelInteractions();

function showOcrResult(text) {
  recognizedText = text;
  ocrText.value = text || tCapture('noTextFound');
  // 新结果默认进预览态：渲染后的标题/列表/表格/链接可读性远好于 Markdown 源码（用户反馈）
  // 注意：setOcrPreviewVisible 内部已处理 ocrText/ocrPreview 互斥显隐，这里不能再置 ocrText.hidden=false
  setOcrPreviewVisible(Boolean(ocrText.value));
  translatePair = null; // 新的识别结果：清掉上一轮原文/译文对
  // 面板内「翻译/显示原文」三态按钮：识别完成即可点「翻译」触发文本翻译（不重新截屏）
  if (btnOcrLang && btnOcrLangLabel) {
    btnOcrLangLabel.textContent = tCapture('translateText');
    btnOcrLang.hidden = false;
  }
  if (ocrLangRow) ocrLangRow.hidden = false; // 语言设置行：随识别结果一起出现
  syncOcrCopyButtons();
  ocrPanel.style.display = 'flex';
  userPositionedOcr = false; // 新的识别结果：先回到自适应定位，用户可再拖拽/缩放
  positionOcrPanel();
}

/* ── OCR 面板复制按钮组 + Markdown 编写/预览 ── */
function setOcrCopyEnabled(enabled) {
  if (btnOcrCopyText) btnOcrCopyText.disabled = !enabled;
  if (btnOcrCopyMd) btnOcrCopyMd.disabled = !enabled;
  if (btnOcrPreview) btnOcrPreview.disabled = !enabled;
  if (btnOcrTable) btnOcrTable.disabled = !enabled;
}

/** 复制按钮可用态同步：文本区有内容即可复制/预览 */
function syncOcrCopyButtons() {
  setOcrCopyEnabled(!!(ocrText && ocrText.value));
}

/** 点击复制按钮后的短暂「已复制」反馈（恢复各自原文案） */
function flashOcrCopied(btn) {
  const span = btn ? btn.querySelector('span') : null;
  if (!span) return;
  const restoreKey = btn === btnOcrCopyMd ? 'copyMarkdown'
    : btn === btnOcrPreview ? (ocrPreviewVisible ? 'editMd' : 'previewMd')
    : 'copyPlainText';
  span.textContent = tCapture('copied');
  window.setTimeout(() => {
    span.textContent = tCapture(restoreKey);
  }, 1200);
}

/* ── 迷你 Markdown 渲染器（无外部依赖）：标题/列表/引用/代码/粗斜体/链接/分隔线/表格 ── */
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 行内语法：粗体/斜体/行内代码/链接（先转义再替换，防 XSS） */
function mdInline(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function mdToHtml(src) {
  const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inCode = false;
  let listType = null; // 'ul' | 'ol'
  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
  const isMdTableLine = (l) => /^\s*\|.*\|\s*$/.test(l);
  const isMdTableSep = (l) => /^\s*\|[\s:|-]+\|\s*$/.test(l);
  const mdTableCells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => mdInline(c.trim()));
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    if (/^```/.test(line)) {
      closeList();
      out.push(inCode ? '</code></pre>' : '<pre><code>');
      inCode = !inCode;
      continue;
    }
    if (inCode) { out.push(escapeHtml(line)); continue; }
    // Markdown 表格块：表头行 + 可选分隔行 + 数据行 → 带边框 <table>（CSS 在 .capture-ocr-preview）
    if (isMdTableLine(line)) {
      const block = [line];
      while (lineIdx + 1 < lines.length && isMdTableLine(lines[lineIdx + 1])) block.push(lines[++lineIdx]);
      const body = block.filter((l) => !isMdTableSep(l));
      if (body.length) {
        closeList();
        const rowsHtml = body.map((l, ri) => {
          const tag = ri === 0 && body.length !== block.length ? 'th' : 'td';
          return `<tr>${mdTableCells(l).map((c) => `<${tag}>${c}</${tag}>`).join('')}</tr>`;
        });
        out.push(`<table>${rowsHtml.join('')}</table>`);
      }
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeList(); out.push(`<h${h[1].length}>${mdInline(h[2])}</h${h[1].length}>`); continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { closeList(); out.push('<hr>'); continue; }
    const q = line.match(/^>\s?(.*)$/);
    if (q) { closeList(); out.push(`<blockquote>${mdInline(q[1])}</blockquote>`); continue; }
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
      out.push(`<li>${mdInline(ul[1])}</li>`);
      continue;
    }
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
      out.push(`<li>${mdInline(ol[1])}</li>`);
      continue;
    }
    if (!line.trim()) { closeList(); continue; }
    closeList();
    out.push(`<p>${mdInline(line)}</p>`);
  }
  closeList();
  if (inCode) out.push('</code></pre>');
  return out.join('\n');
}

/** Markdown 源 → 纯文本：去掉常见语法标记，保留正文（「复制纯文本」用） */
function mdToPlainText(src) {
  return String(src || '')
    .replace(/^```[a-zA-Z0-9]*\s*$/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*([-*+]|\d+[.)])\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\(([^)\s]+)\)/g, '$1')
    .replace(/^\s*([-*_]\s*){3,}$/gm, '');
}

/** 预览态：true = 显示渲染视图（文本区隐藏），false = 编辑态 */
let ocrPreviewVisible = false;

function setOcrPreviewVisible(visible) {
  ocrPreviewVisible = !!visible && !!ocrText.value;
  if (!ocrText || !ocrPreview) return;
  if (ocrPreviewVisible) {
    ocrPreview.innerHTML = mdToHtml(ocrText.value);
    ocrPreview.hidden = false;
    ocrText.hidden = true;
  } else {
    ocrPreview.hidden = true;
    ocrPreview.innerHTML = '';
    ocrText.hidden = false;
  }
  if (btnOcrPreviewLabel) btnOcrPreviewLabel.textContent = tCapture(ocrPreviewVisible ? 'editMd' : 'previewMd');
}

/** 切换显示原文/译文某一侧（共用可编辑文本区；按钮文案指向「要切到」的那一侧）。
 *  Markdown 预览态独立于翻译切换：预览中切换只刷新渲染内容，不退出预览。 */
function renderOcrSide(pair, side) {
  if (!pair) return;
  ocrText.value = side === 'translated' ? (pair.translated || '') : (pair.original || '');
  if (ocrPreviewVisible && ocrPreview) {
    ocrPreview.innerHTML = mdToHtml(ocrText.value); // 保持预览态，仅刷新渲染内容
  } else {
    ocrText.hidden = false;
  }
  if (btnOcrLangLabel) btnOcrLangLabel.textContent = tCapture(side === 'translated' ? 'showOriginal' : 'showTranslation');
  pair.showing = side;
  syncOcrCopyButtons();
}

// 预览区链接：Ctrl/⌘+点击 → 系统浏览器打开（渲染端 target=_blank 不可靠，显式走 shell）
if (ocrPreview) {
  ocrPreview.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.ctrlKey || e.metaKey) {
      try { shell.openExternal(a.href); } catch (_) { /* ignore */ }
    }
  });
}

function resetOcrResult() {
  ocrTableHtml = '';
  recognizedText = '';
  ocrText.value = '';
  setOcrPreviewVisible(false); // 复位时退出 Markdown 预览态
  ocrText.hidden = false;
  setOcrCopyEnabled(false);
  ocrPanel.style.display = 'none';
  // 同步清掉原文/译文对与切换按钮、语言设置行
  translatedText = '';
  translatePair = null;
  if (btnOcrLang) btnOcrLang.hidden = true;
  if (ocrLangRow) ocrLangRow.hidden = true;
  syncOcrCopyButtons();
}

/**
 * 译文并入 OCR 面板：译文直接写入可编辑文本区，原文本保留在 translatePair 中，
 * 通过「显示原文/显示译文」按钮切换查看。两侧均可继续编辑、复制。
 */
function showTranslateText(text) {
  translatedText = typeof text === 'string' ? text : '';
  if (!translatedText) {
    translatePair = null;
    if (btnOcrLang && btnOcrLangLabel) {
      // 翻译失败/无译文：按钮回到「翻译」态，用户可直接重试
      btnOcrLangLabel.textContent = tCapture('translate');
      btnOcrLang.hidden = false;
    }
    return;
  }
  translatePair = {
    original: ocrText.value,
    translated: translatedText,
    showing: 'translated',
  };
  ocrText.value = translatedText;
  // 预览态保持预览，只刷新渲染内容（译文写入不打断 Markdown 预览）
  if (ocrPreviewVisible && ocrPreview) ocrPreview.innerHTML = mdToHtml(translatedText);
  else ocrText.hidden = false;
  setOcrCopyEnabled(true);
  syncOcrCopyButtons();
  if (btnOcrLang && btnOcrLangLabel) {
    btnOcrLangLabel.textContent = tCapture('showOriginal');
    btnOcrLang.hidden = false;
  }
}

function isCaptureBusy() {
  return isTranslating || isRecognizing;
}

function updateTranslateButtonLabel() {
  const labelKey = !translationCache
    ? 'translate'
    : displayedImageVersion === 'translated'
      ? 'showOriginal'
      : 'showTranslation';
  // 工具栏已改为图标-only，无可见文字标签；改为动态更新按钮 tooltip/aria-label
  // 以反映当前动作（图片翻译 / 显示原文 / 显示译文）。btnTranslate 在图标-only 模式恒存在。
  if (btnTranslate) {
    const text = tCapture(labelKey);
    btnTranslate.title = text;
    btnTranslate.setAttribute('aria-label', text);
  }
}

function resetTranslationCache() {
  resetOcrResult();
  translationCache = null;
  displayedImageVersion = 'original';
  updateTranslateButtonLabel();
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(tCapture('translateFailed')));
    image.src = src;
  });
}

async function renderSelectionImage(dataUrl, { history = 'commit' } = {}) {
  const image = await loadImage(dataUrl);
  const dpr = canvasDpr;
  drawCtx.clearRect(selX, selY, selW, selH);
  // 译文图可能与选区物理尺寸相同（本地服务）或逻辑尺寸（旧服务端）。
  // 以选区物理尺寸为基准，让图片在高分屏下 1:1 绘制而不被额外拉伸。
  const expectedPhysW = Math.round(selW * dpr);
  const expectedPhysH = Math.round(selH * dpr);
  if (Math.abs(image.naturalWidth - expectedPhysW) <= 2 && Math.abs(image.naturalHeight - expectedPhysH) <= 2) {
    drawCtx.drawImage(image, selX, selY, selW, selH);
  } else {
    // 非高清图：直接按物理像素铺满选区（牺牲一点锐利度，但保证覆盖完整）
    drawCtx.drawImage(image, selX * dpr, selY * dpr, expectedPhysW, expectedPhysH);
  }
  activeTool = 'select';
  Array.from(document.querySelectorAll('button.tool')).forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tool === 'select');
  });
  drawMask();
  // 维持「历史栈顶 == 当前画布」不变量：
  //  - commit：新步（翻译首次叠图等改像素操作，撤销可回到叠图前）
  //  - replace：原地替换栈顶位图（原文/译文来回切换不产生历史步——撤销一键就回到翻译前，
  //    不会在「原文/译文/原文…」之间一步步倒带，用户明确要求）
  if (history === 'replace') {
    replaceHistoryTop();
  } else {
    commitHistory(true);
  }
}

/** 原文/译文切换专用：把历史栈顶快照的位图原地换成当前画布内容（annots 不变，不新增步） */
function replaceHistoryTop() {
  if (selW < 1 || selH < 1) return;
  if (historyIndex < 0) {
    commitHistory(true); // 没有历史（理论不可达，保险）：退化为普通提交
    return;
  }
  const dpr = canvasDpr;
  const snap = historyStack[historyIndex];
  snap.data = drawCtx.getImageData(
    Math.round(selX * dpr), Math.round(selY * dpr), Math.round(selW * dpr), Math.round(selH * dpr),
  );
}

async function toggleCachedTranslation() {
  if (!translationCache) return false;
  const nextVersion = displayedImageVersion === 'translated' ? 'original' : 'translated';
  const nextImage = nextVersion === 'translated'
    ? translationCache.translatedImage
    : translationCache.originalImage;
  // 文字面板模式下 translatedImage 为空：跳过绘制（原图保持原样），仅切换版本标签
  if (nextImage) {
    // replace：原地替换栈顶位图，原文/译文切换不进历史（撤销一键回到翻译前）
    await renderSelectionImage(nextImage, { history: 'replace' });
  }
  displayedImageVersion = nextVersion;
  updateTranslateButtonLabel();
  return true;
}

/* 绘制类工具集合：颜色/粗细已改为工具栏常驻行，不再按工具显隐（保留集合供后续按需引用） */
const DRAWING_TOOLS = ['mosaic', 'blur', 'noise', 'solid', 'rect', 'line', 'arrow', 'ellipse', 'pen', 'text'];

function setTool(tool) {
  activeTool = tool;
  Array.from(document.querySelectorAll('button.tool')).forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tool === tool);
  });
  // 统一工具面板：内容与显隐随工具切换（打码区 / 颜色粗细区 / 收起）
  syncToolPanel();
  drawMask();
}

/* ── 打码工具二级面板：像素马赛克 / 高斯模糊 / 噪点 / 纯色 共用一个按钮 + 强度 ── */
const MASK_TOOLS = ['mosaic', 'blur', 'noise', 'solid'];
const MASK_ICON_SVG = { mosaic: 'MOSAIC', blur: 'BLUR', noise: 'NOISE', solid: 'SOLID' };
/** 面板文案 key：按钮 title/aria 与菜单项高亮共用 */
const MASK_LABEL_KEY = { mosaic: 'maskMosaic', blur: 'maskBlur', noise: 'noise', solid: 'solid' };

/** 让打码按钮图标/文案跟随当前样式（data-tool 同步，便于 active 高亮） */
function syncMaskButton() {
  if (!maskBtn || !maskIcon) return;
  maskBtn.dataset.tool = maskTool;
  maskIcon.src = `./svg/${MASK_ICON_SVG[maskTool] || 'MOSAIC'}.svg`;
  const label = tCapture(MASK_LABEL_KEY[maskTool] || maskTool) || maskTool;
  maskBtn.title = label;
  maskBtn.setAttribute('aria-label', label);
  syncMaskMenuItems();
  syncMaskStrengthUI();
}

/** 打码菜单内当前项高亮 */
function syncMaskMenuItems() {
  maskItems.forEach((item) => {
    item.classList.toggle('active', item.dataset.mask === maskTool);
  });
}

/**
 * 效果参数滑块：文案 / 范围 / 数值随打码类型切换
 * （像素·模糊·噪点 = 强度；纯色 = 透明度。笔刷粗细不在这里，统一用工具栏「粗细」）
 */
function syncMaskStrengthUI() {
  if (!maskStrength) return;
  const cfg = MASK_PARAM[maskTool] || MASK_PARAM.mosaic;
  maskStrength.disabled = false;
  maskStrength.min = String(cfg.min);
  maskStrength.max = String(cfg.max);
  maskStrength.step = '1';
  maskStrength.value = String(maskIntensity);
  if (maskStrengthLabel) {
    maskStrengthLabel.textContent = tCapture(cfg.labelKey) || (cfg.percent ? '透明度' : '强度');
  }
  if (maskStrengthValue) {
    maskStrengthValue.textContent = cfg.percent ? `${maskIntensity}%` : String(maskIntensity);
  }
  maskStrength.title = tCapture(cfg.labelKey) || (cfg.percent ? '透明度' : '强度');
}

/** 笔刷 / 框选 两个模式按钮的高亮同步 */
function syncMaskModeUI() {
  if (!maskModeBtns || maskModeBtns.length === 0) return;
  maskModeBtns.forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.mode === maskMode);
  });
  // 框选模式下不显示"跟随光标的笔刷圈"（此时是拖框，不是涂抹）
  if (maskMode !== 'brush' && brushCursor) {
    brushCursor.style.display = 'none';
  }
}

/** 切换涂抹方式（笔刷 / 框选） */
function setMaskMode(mode) {
  if (mode !== 'brush' && mode !== 'rect') return;
  maskMode = mode;
  syncMaskModeUI();
}

function isMaskMenuOpen() {
  return maskMenu && maskMenu.style.display !== 'none';
}

/** 关闭统一工具面板 */
function closeMaskMenu() {
  if (!maskMenu) return;
  maskMenu.style.display = 'none';
}

/** 面板锚定按钮：打码 → 打码按钮；其余绘制工具 → data-tool 匹配的工具按钮 */
function toolPanelAnchor() {
  if (MASK_TOOLS.includes(activeTool)) return maskBtn;
  return toolbar ? toolbar.querySelector(`button.tool[data-tool="${activeTool}"]`) : null;
}

/** 统一工具面板定位：默认在锚定按钮上方弹出，贴近屏顶时向下（与图形面板一致） */
function positionToolPanel() {
  if (!maskMenu) return;
  const anchor = toolPanelAnchor();
  if (!anchor) return;
  maskMenu.style.visibility = 'hidden';
  maskMenu.style.display = 'flex';
  const menuW = maskMenu.offsetWidth || 150;
  const menuH = maskMenu.offsetHeight || 210;
  const rect = anchor.getBoundingClientRect();
  let left = rect.left;
  if (left + menuW > window.innerWidth - 6) left = window.innerWidth - menuW - 6;
  maskMenu.classList.toggle('capture-shape-menu-down', rect.top < 170);
  if (rect.top < 170) {
    maskMenu.style.top = `${Math.min(window.innerHeight - menuH - 6, rect.bottom + 8)}px`;
  } else {
    maskMenu.style.top = `${Math.max(6, rect.top - menuH - 8)}px`;
  }
  maskMenu.style.left = `${Math.max(6, left)}px`;
  maskMenu.style.visibility = 'visible';
}

/**
 * 打码二级面板显隐：仅打码工具激活时弹出（颜色/粗细已改为工具栏常驻行，
 * 不再依赖面板——面板与图形/翻译菜单在同区域弹会重叠）。
 * 非打码工具 / 非选中态 / 忙碌 → 面板收起。
 */
function syncToolPanel() {
  if (!maskMenu) return;
  const isMask = MASK_TOOLS.includes(activeTool)
    && state === STATE.SELECTED
    && !isCaptureBusy();
  if (!isMask) {
    closeMaskMenu();
    return;
  }
  syncMaskMenuItems();
  syncMaskStrengthUI();
  positionToolPanel();
}

function toggleMaskMenu() {
  if (isMaskMenuOpen()) {
    closeMaskMenu();
  } else {
    syncToolPanel(); // 内容与定位随当前工具自动装配
  }
}

/* ── 图片翻译二级面板（▾ 展开，选择目标语言）──
 * 点击按钮右下角 ▾ → 开合面板选语言；点击按钮主体 → 直接图片翻译。
 * OCR 已无二级面板（保留格式已移除），面板机制仅剩翻译一个使用者。 */
function isTranslateMenuOpen() {
  return !!(translateMenu && translateMenu.style.display !== 'none');
}

/* ── OCR 二级菜单（▾ → 表格识别）：交互镜像翻译菜单 ── */
const ocrMenu = document.getElementById('ocrMenu');
const ocrMenuTable = document.getElementById('ocrMenuTable');
const ocrMenuSmart = document.getElementById('ocrMenuSmart');

function closeOcrMenu() {
  if (ocrMenu) ocrMenu.style.display = 'none';
  const btn = document.getElementById('btnOcr');
  if (btn) btn.classList.remove('is-open');
}

function isOcrMenuOpen() {
  return !!ocrMenu && ocrMenu.style.display === 'flex';
}

function openOcrMenu() {
  if (!ocrMenu) return;
  closeTranslateMenu();
  closeShapeMenu();
  closeMaskMenu();
  const btn = document.getElementById('btnOcr');
  ocrMenu.style.visibility = 'hidden';
  ocrMenu.style.display = 'flex';
  const menuW = ocrMenu.offsetWidth || 140;
  const menuH = ocrMenu.offsetHeight || 40;
  const rect = btn.getBoundingClientRect();
  let left = rect.left;
  if (left + menuW > window.innerWidth - 6) left = window.innerWidth - menuW - 6;
  ocrMenu.classList.toggle('capture-shape-menu-down', rect.top < 170);
  if (rect.top < 170) {
    ocrMenu.style.top = `${Math.min(window.innerHeight - menuH - 6, rect.bottom + 8)}px`;
  } else {
    ocrMenu.style.top = `${Math.max(6, rect.top - menuH - 8)}px`;
  }
  ocrMenu.style.left = `${Math.max(6, left)}px`;
  ocrMenu.style.visibility = 'visible';
  if (btn) btn.classList.add('is-open');
}

function closeTranslateMenu() {
  if (translateMenu) translateMenu.style.display = 'none';
  if (btnTranslate) btnTranslate.classList.remove('is-open');
}

function openTranslateMenu() {
  if (!translateMenu || !btnTranslate) return;
  // 展开前先收起其它浮层，避免重叠
  closeShapeMenu();
  closeMaskMenu();
  closeOcrMenu();
  translateMenu.style.visibility = 'hidden';
  translateMenu.style.display = 'flex';
  const menuW = translateMenu.offsetWidth || 180;
  const menuH = translateMenu.offsetHeight || 56;
  const rect = btnTranslate.getBoundingClientRect();
  let left = rect.left;
  if (left + menuW > window.innerWidth - 6) left = window.innerWidth - menuW - 6;
  translateMenu.classList.toggle('capture-shape-menu-down', rect.top < 170);
  if (rect.top < 170) {
    translateMenu.style.top = `${Math.min(window.innerHeight - menuH - 6, rect.bottom + 8)}px`;
  } else {
    translateMenu.style.top = `${Math.max(6, rect.top - menuH - 8)}px`;
  }
  translateMenu.style.left = `${Math.max(6, left)}px`;
  translateMenu.style.visibility = 'visible';
  btnTranslate.classList.add('is-open');
}

// ▾ 三角点击判定：按钮右下角 18×18 区域都算 caret 热区（CSS 的 ::after 热区铺在这）
function isCaretHit(e, btn) {
  if (!btn) return false;
  const rect = btn.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  return x >= rect.width - 18 && y >= rect.height - 18;
}

/** 切换到指定打码样式并立即激活（画布拖框即按该样式应用） */
function setMaskTool(tool) {
  if (!MASK_TOOLS.includes(tool)) return;
  if (tool !== maskTool) {
    // 切换打码类型时换上该类型自己的效果参数（强度 / 透明度互不干扰）
    maskParams[maskTool] = maskIntensity;
    maskTool = tool;
    maskIntensity = maskParams[tool] ?? (MASK_PARAM[tool] || MASK_PARAM.mosaic).def;
  }
  syncMaskButton();
  setTool(tool);
}

/* ── 取色器持续色环浮层（按住时跟随光标显示色块 + hex + RGB，松开自动关闭） ── */

/**
 * 显示/移动取色器色环浮层到当前光标位置，并刷新 hex/RGB/色块；
 * 色环默认在光标右下，越界自动翻转。
 */
function updatePickerOverlay(mx, my, color) {
  if (!pickerOverlay || !color) return;
  // 解析颜色并刷新 UI
  const m = /^#([0-9A-Fa-f]{6})$/.exec(color);
  const rgb = m
    ? { r: parseInt(m[1].slice(0, 2), 16), g: parseInt(m[1].slice(2, 4), 16), b: parseInt(m[1].slice(4, 6), 16) }
    : { r: 255, g: 255, b: 255 };
  if (pickerSwatch) pickerSwatch.style.backgroundColor = color;
  if (pickerHex) pickerHex.textContent = color;
  if (pickerRgb) pickerRgb.textContent = `${rgb.r}, ${rgb.g}, ${rgb.b}`;
  pickerOverlay.style.display = 'flex';

  // 定位：色环浮层宽 ~180px，高 ~36px；先在光标右下，
  // 越界后翻到左侧 / 上方，最后再做边界 clamp
  pickerOverlay.style.visibility = 'hidden';
  const pw = pickerOverlay.offsetWidth || 180;
  const ph = pickerOverlay.offsetHeight || 36;
  let left = mx + 18;
  let top = my + 18;
  if (left + pw > window.innerWidth - 4) left = mx - pw - 18;
  if (top + ph > window.innerHeight - 4) top = my - ph - 18;
  left = Math.max(4, Math.min(left, window.innerWidth - pw - 4));
  top = Math.max(4, Math.min(top, window.innerHeight - ph - 4));
  pickerOverlay.style.left = `${Math.round(left)}px`;
  pickerOverlay.style.top = `${Math.round(top)}px`;
  pickerOverlay.style.visibility = 'visible';
  pickerOverlay.setAttribute('aria-hidden', 'false');
}

/** 关闭取色器色环浮层 */
function closePickerOverlay() {
  if (!pickerOverlay) return;
  pickerOverlay.style.display = 'none';
  pickerOverlay.setAttribute('aria-hidden', 'true');
}

/* ── 笔刷预览圈：选区内跟随鼠标显示当前笔刷大小 + 形状 ── */

/** 哪些工具显示笔刷预览圈（pen + 打码四种） */
const BRUSH_CURSOR_TOOLS = new Set(['pen', 'blur', 'mosaic', 'noise', 'solid']);

/**
 * 当前工具对应的笔刷半径（CSS px）。
 * pen 与四种打码统一用工具栏「粗细」滑块（drawingSize）——打码面板里只剩"效果参数"，
 * 不再重复一个粗细调节（用户明确要求）。
 */
function currentBrushRadius() {
  if (BRUSH_CURSOR_TOOLS.has(activeTool)) return Math.max(2, drawingSize);
  return 0;
}

/** 显示 / 移动 / 隐藏笔刷预览圈
 *  @param mx - 当前光标 CSS x
 *  @param my - 当前光标 CSS y
 *  @param visible - true 显示，false 隐藏 */
function setBrushCursor(mx, my, visible) {
  if (!brushCursor) return;
  // 打码的「框选」模式是拖矩形，不跟光标显示笔刷圈
  const maskRectMode = activeTool !== 'pen' && BRUSH_CURSOR_TOOLS.has(activeTool) && maskMode === 'rect';
  if (!visible || !BRUSH_CURSOR_TOOLS.has(activeTool) || maskRectMode || !isInsideSelection(mx, my)) {
    if (brushCursor.style.display !== 'none') brushCursor.style.display = 'none';
    return;
  }
  const radius = currentBrushRadius();
  if (radius <= 0) {
    brushCursor.style.display = 'none';
    return;
  }
  // 笔刷预览圈：CSS px 直径 = 半径 * 2（CSS px 尺寸，跟着鼠标；高 DPR 下画布用 backing 缩放）
  brushCursor.style.setProperty('--brush-size', `${radius * 2}px`);
  // 画笔工具：填充 drawingColor（看笔触色）；打码工具：仅轮廓
  if (activeTool === 'pen') {
    brushCursor.classList.add('is-pen');
    brushCursor.style.color = drawingColor;
  } else {
    brushCursor.classList.remove('is-pen');
    brushCursor.style.color = '';
  }
  brushCursor.style.left = `${mx}px`;
  brushCursor.style.top = `${my}px`;
  brushCursor.style.display = 'block';
}

/* ── 文字工具：真正的"所见即所得"（输入即渲染到画布） ── */

/**
 * Snipaste 风格文字工具的最终形态：
 *
 * 关键设计——**不依赖 textarea 自己渲染字符**。
 * 之前把 textarea 做成"隐形输入框"想让浏览器渲染的字符和最终 fillText 重合，
 * 但两者天然对不齐：textarea 是行盒布局（line-height 半行距居中），
 * canvas fillText(textBaseline='top') 是 em-box 顶对齐，折行宽度也各有算法
 * → 提交瞬间字符必然跳动。
 *
 * 现在的做法：textarea 只当「输入面」（承接键盘 / IME / 光标逻辑），文字与光标
 * 全部由我们用**与提交时完全同一段代码**（drawAnnotText）画到 annotCanvas 顶层
 * （对象层重构 #48：文字是矢量对象，commit 才进 annotations 数组固化）。
 * 用户边打边看到的就是最终像素，提交时只是把光标撤掉——零位移。
 */

/** 与 drawAnnotText（annotCanvas 渲染）完全一致的字体度量 */
function getEditorFontConfig() {
  return {
    fontFamily: '"Microsoft YaHei", "PingFang SC", system-ui, -apple-system, "Segoe UI", sans-serif',
    // 与工具栏「粗细」滑块(drawingSize 1~60px) 直接对应：放大到 drawingSize * 3+12，
    // 范围 15~192px，方便看清。
    fontSize: Math.max(16, Math.round((drawingSize || 4) * 3 + 12)),
    lineHeight: 1.32,
  };
}

/** 文字排版可用宽度（选区内剩余宽度，CSS px） */
function editorMaxWidth() {
  return Math.max(24, selX + selW - textAnchorX - 4);
}

/**
 * 按 maxWidth 折行，返回每行 { text, start, end, width }（start/end 为源串字符下标，
 * width 供命中检测 bbox 使用）。提交与实时渲染共用同一份结果，保证折行位置也绝不会变。
 */
function layoutEditorText(text, maxWidth) {
  const { fontFamily, fontSize } = getEditorFontConfig();
  drawCtx.save();
  drawCtx.font = `${fontSize}px ${fontFamily}`;
  const lines = [];
  let cursor = 0;
  text.split('\n').forEach((paragraph) => {
    let line = '';
    let lineStart = cursor;
    for (const ch of paragraph) {
      if (line && drawCtx.measureText(line + ch).width > maxWidth) {
        lines.push({ text: line, start: lineStart, end: cursor, width: Math.ceil(drawCtx.measureText(line).width) });
        lineStart = cursor;
        line = ch;
      } else {
        line += ch;
      }
      cursor += ch.length;
    }
    lines.push({ text: line, start: lineStart, end: cursor, width: Math.ceil(drawCtx.measureText(line).width) });
    cursor += 1; // 换行符本身
  });
  drawCtx.restore();
  return lines;
}

/** 在 annotCanvas 顶层画自绘光标（深浅双色，任何背景都可见；外层已 clip 到选区） */
function drawEditorCaret() {
  if (!textEditor || !annotCtx) return;
  const { fontFamily, fontSize, lineHeight } = getEditorFontConfig();
  const lineHeightPx = Math.round(fontSize * lineHeight);
  const text = textEditor.value.replace(/\r/g, '');
  const lines = layoutEditorText(text, editorMaxWidth());
  if (lines.length === 0) return;

  const pos = typeof textEditor.selectionStart === 'number' ? textEditor.selectionStart : text.length;
  let lineIdx = lines.length - 1;
  let col = lines[lineIdx].text.length;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (pos >= ln.start && pos <= ln.end) {
      lineIdx = i;
      col = pos - ln.start;
      break;
    }
  }

  annotCtx.save();
  annotCtx.font = `${fontSize}px ${fontFamily}`;
  const caretX = textAnchorX + annotCtx.measureText(lines[lineIdx].text.slice(0, col)).width;
  annotCtx.restore();

  const caretW = Math.max(2, Math.round(fontSize / 16));
  // 光标竖向覆盖整行盒（与 drawAnnotText 的行盒一致）：lineIdx 行顶 = textAnchorY + lineIdx*lineHeightPx
  const caretY = textAnchorY + lineIdx * lineHeightPx;
  // 先描一圈半透明黑，再压一条白线：深色底 / 浅色底都能看清
  annotCtx.save();
  annotCtx.fillStyle = 'rgba(0, 0, 0, .45)';
  annotCtx.fillRect(Math.round(caretX) - 1, caretY, caretW + 2, lineHeightPx);
  annotCtx.fillStyle = 'rgba(255, 255, 255, .95)';
  annotCtx.fillRect(Math.round(caretX), caretY, caretW, lineHeightPx);
  annotCtx.restore();
}

/** 同步编辑态到临时对象（样式随工具栏实时刷新），返回是否有可见文字 */
function syncEditingTextAnnot() {
  if (!textEditor || !editingTextAnnot) return false;
  const text = textEditor.value.replace(/\r/g, '');
  const { fontFamily, fontSize, lineHeight } = getEditorFontConfig();
  const a = editingTextAnnot;
  a.text = text;
  a.color = drawingColor;
  a.fontFamily = fontFamily;
  a.fontSize = fontSize;
  a.lineHeight = lineHeight;
  a.maxWidth = editorMaxWidth();
  a.lines = layoutEditorText(text, a.maxWidth);
  return text.length > 0;
}

/**
 * 重画编辑画面（**位图与历史完全不动**）：
 * renderAnnots() 重画已提交对象（编辑中的字不在数组里）→ 当前输入作为临时对象
 * 画到 annotCanvas 顶层（裁到选区）→ 画光标。输入/退格/粘贴/换色/换字号都走这里，
 * 提交瞬间看到的像素 = 输入时看到的像素（同一套 drawAnnotText，零位移）。
 */
function refreshEditorCanvas() {
  if (!textEditor || !annotCtx) return;
  renderAnnots();
  const hasText = syncEditingTextAnnot();
  clipToSelection(annotCtx);
  if (hasText) drawAnnotText(annotCtx, editingTextAnnot);
  if (textCaretOn) drawEditorCaret();
  restoreClip(annotCtx);
  syncEditorBox();
}

/** 光标闪烁计时器 */
let textCaretTimer = null;
/** 光标当前是否处于"亮"相位（输入时强制常亮） */
let textCaretOn = true;

function startCaretBlink() {
  stopCaretBlink();
  textCaretOn = true;
  textCaretTimer = setInterval(() => {
    if (!textEditor) {
      stopCaretBlink();
      return;
    }
    textCaretOn = !textCaretOn;
    refreshEditorCanvas();
  }, 530);
}

function stopCaretBlink() {
  if (textCaretTimer) {
    clearInterval(textCaretTimer);
    textCaretTimer = null;
  }
}

/** textarea 只覆盖文字实际占用的矩形，其余选区仍可点（点空白处 = 提交并另起一处） */
function syncEditorBox() {
  if (!textEditor) return;
  const { fontFamily, fontSize, lineHeight } = getEditorFontConfig();
  const lineHeightPx = Math.round(fontSize * lineHeight);
  const lines = layoutEditorText(textEditor.value.replace(/\r/g, ''), editorMaxWidth());
  const h = Math.max(1, lines.length) * lineHeightPx;
  textEditor.style.height = `${h}px`;
  if (textEditorHint) textEditorHint.style.minHeight = `${h + 4}px`;
  // 让浏览器（IME 候选框定位）用同一套字体度量
  textEditor.style.font = `${fontSize}px / ${lineHeightPx}px ${fontFamily}`;
}

/** 打开文字编辑器
 *  @param mx - 选区内 CSS x（文字左边界）
 *  @param my - 选区内 CSS y（**首行文字的垂直中点**，Snipaste 手感：
 *              点击点对齐文本框左缘中部，文字落在光标正下方，
 *              而不是旧版“文字框左上角=点击点”导致文字整体偏到点击点右下） */
function openTextEditor(mx, my) {
  if (textEditor) commitTextEditor();

  // 先落一个快照：本次文字编辑"之前"的状态，Esc 可直接回退到这里。
  // 文字是矢量对象：编辑前后位图都不变，快照复用栈顶 ImageData（零内存增长）。
  commitHistory(false);

  const { fontFamily, fontSize, lineHeight } = getEditorFontConfig();
  const lineHeightPx = Math.round(fontSize * lineHeight);

  textAnchorX = Math.round(mx);
  // 首行顶边 = 点击点 − 半行高；至少保证顶边不越出选区上缘
  textAnchorY = Math.round(Math.max(selY + 2, my - lineHeightPx / 2));

  // 编辑中的临时对象：不进 annotations 数组，样式/折行随每次输入实时刷新；
  // commit 才克隆固化（颜色/字号取提交瞬间值），cancel 则连同这次历史步一起丢弃。
  editingTextAnnot = {
    type: 'text', x: textAnchorX, y: textAnchorY, text: '',
    color: drawingColor, fontFamily, fontSize, lineHeight,
    maxWidth: editorMaxWidth(), lines: [], editing: true,
  };

  const ta = document.createElement('textarea');
  ta.className = 'capture-text-editor';
  ta.spellcheck = false;
  ta.autocomplete = 'off';
  ta.maxLength = 5000;
  ta.rows = 1;
  ta.wrap = 'soft';
  ta.setAttribute('aria-label', tCapture('captureInputText') || '输入文字');
  ta.setAttribute('data-i18n-placeholder', 'captureInputText');
  ta.placeholder = tCapture('captureInputText') || '直接在这里打字…';
  // 完全透明：字符由画布渲染，textarea 只负责接键 / IME / 选区
  ta.style.left = `${textAnchorX}px`;
  ta.style.top = `${textAnchorY}px`;
  ta.style.width = `${editorMaxWidth()}px`;
  ta.style.setProperty('--cap-editor-size', `${fontSize}px`);

  // 极简 hint 框：提示"这里可以输入"，提交 / 取消时移除
  const hint = document.createElement('div');
  hint.className = 'capture-text-editor-hint';
  hint.style.left = `${textAnchorX - 2}px`;
  hint.style.top = `${textAnchorY - 2}px`;
  hint.style.width = `${editorMaxWidth() + 4}px`;
  hint.style.minHeight = `${lineHeightPx + 4}px`;
  textEditorHint = hint;

  // 任何内容 / 选区变化都重画一次（输入、退格、粘贴、方向键、点选、中文组词中）
  const onChange = () => {
    if (textEditor !== ta) return;
    textCaretOn = true;
    refreshEditorCanvas();
    startCaretBlink();
  };
  ta.addEventListener('input', onChange);
  ta.addEventListener('click', onChange);
  ta.addEventListener('keyup', onChange);
  ta.addEventListener('compositionupdate', onChange);
  ta.addEventListener('compositionend', onChange);

  ta.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.ctrlKey && !ev.shiftKey && !ev.altKey) {
      ev.preventDefault();
      ev.stopPropagation();
      commitTextEditor();
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      cancelTextEditor();
    }
  });

  // 失焦 = 落地提交。例外：焦点移到「颜色 / 粗细」这类样式控件时不提交，
  // 让用户能边打字边换色换字号；点到别处（含工具栏其它按钮、画布、选区）一律提交。
  ta.addEventListener('blur', (ev) => {
    if (textEditor !== ta) return;
    const next = ev.relatedTarget;
    if (next && (next === colorPicker || next === sizeSlider)) return;
    commitTextEditor();
  });

  document.body.appendChild(hint);
  document.body.appendChild(ta);
  textEditor = ta;
  syncEditorBox();
  startCaretBlink();
  setTimeout(() => {
    try { ta.focus(); } catch (_) { /* 容忍 */ }
    if (textEditorHint) textEditorHint.classList.add('is-focus');
  }, 0);
}

/** 提交：撤掉光标，把文字固化成矢量对象（进 annotations + 一步对象历史） */
function commitTextEditor() {
  if (!textEditor) return;
  stopCaretBlink();
  const raw = textEditor.value;
  const pending = editingTextAnnot;
  destroyTextEditor();
  editingTextAnnot = null;
  const text = raw.replace(/\r/g, '');
  if (!text.trim()) {
    // 什么都没输入：撤掉 open 时压入的那条快照，回到编辑前状态（Undo 不出现"空按一次"）
    renderAnnots();
    if (historyIndex >= 0) {
      historyStack.pop();
      historyIndex = historyStack.length - 1;
    }
    restoreHistoryTop();
    return;
  }
  if (pending) {
    // 提交瞬间再次同步样式与折行：与实时渲染同一套代码（layoutEditorText），像素零位移
    const { fontFamily, fontSize, lineHeight } = getEditorFontConfig();
    pending.text = text;
    pending.color = drawingColor;
    pending.fontFamily = fontFamily;
    pending.fontSize = fontSize;
    pending.lineHeight = lineHeight;
    pending.maxWidth = editorMaxWidth();
    pending.lines = layoutEditorText(text, pending.maxWidth);
    pending.editing = false;
    annotations.push(pending);
  }
  renderAnnots();
  commitHistory(false); // 文字是矢量对象：位图未变，快照复用栈顶，历史内存与原来持平
}

/** 取消（Esc）：丢弃本次输入，回退到 open 压入前的那一步 */
function cancelTextEditor() {
  if (!textEditor) return;
  stopCaretBlink();
  destroyTextEditor();
  editingTextAnnot = null;
  // 编辑期间没有其它 commit，栈顶就是 open 时压入的那条快照，弹掉即回到编辑前
  if (historyIndex >= 0) {
    historyStack.pop();
    historyIndex = historyStack.length - 1;
  }
  restoreHistoryTop();
}

/** 销毁文字编辑器浮层（textarea + hint 框） */
function destroyTextEditor() {
  stopCaretBlink();
  if (textEditor) {
    if (textEditor.parentNode) textEditor.parentNode.removeChild(textEditor);
    textEditor = null;
  }
  if (textEditorHint) {
    if (textEditorHint.parentNode) textEditorHint.parentNode.removeChild(textEditorHint);
    textEditorHint = null;
  }
}


/* ── 图形工具二级面板：直线 / 矩形 / 箭头 / 椭圆 共用一个按钮 ── */
const SHAPE_TOOLS = ['line', 'rect', 'arrow', 'ellipse'];
/** 当前默认图形（按钮图标与点击后使用的工具）；未激活时点按钮直接用它，再次点击可弹出面板换其它图形 */
let shapeTool = 'rect';
const SHAPE_ICON_SVG = { line: 'LINE', rect: 'RECTANGLE', arrow: 'ARROW', ellipse: 'ELLIPSE' };

/** 让图形按钮的图标/文案跟随当前默认图形（data-tool 同步，便于 active 高亮） */
function syncShapeButton() {
  if (!shapeBtn || !shapeIcon) return;
  shapeBtn.dataset.tool = shapeTool;
  shapeIcon.src = `./svg/${SHAPE_ICON_SVG[shapeTool] || 'RECTANGLE'}.svg`;
  const label = tCapture(shapeTool) || shapeTool;
  shapeBtn.title = label;
  shapeBtn.setAttribute('aria-label', label);
  syncShapeMenuItems();
}

/** 图形菜单内当前项高亮 */
function syncShapeMenuItems() {
  shapeItems.forEach((item) => {
    item.classList.toggle('active', item.dataset.shape === shapeTool);
  });
}

function isShapeMenuOpen() {
  return shapeMenu && shapeMenu.style.display !== 'none';
}

/** 关闭图形二级面板 */
function closeShapeMenu() {
  if (!shapeMenu) return;
  shapeMenu.style.display = 'none';
}

/**
 * 展开图形二级面板：以窗口坐标定位，紧贴按钮（默认在按钮上方弹出；
 * 按钮贴近屏幕顶部时改向下展开，避免溢出）。
 */
function openShapeMenu() {
  if (!shapeMenu || !shapeBtn) return;
  syncShapeMenuItems();
  // 先隐形测量菜单尺寸，避免闪现
  shapeMenu.style.visibility = 'hidden';
  shapeMenu.style.display = 'flex';
  const menuW = shapeMenu.offsetWidth || 128;
  const menuH = shapeMenu.offsetHeight || 148;
  const rect = shapeBtn.getBoundingClientRect();
  let left = rect.left;
  if (left + menuW > window.innerWidth - 6) left = window.innerWidth - menuW - 6;
  shapeMenu.classList.toggle('capture-shape-menu-down', rect.top < 170);
  if (rect.top < 170) {
    shapeMenu.style.top = `${Math.min(window.innerHeight - menuH - 6, rect.bottom + 8)}px`;
  } else {
    shapeMenu.style.top = `${Math.max(6, rect.top - menuH - 8)}px`;
  }
  shapeMenu.style.left = `${Math.max(6, left)}px`;
  shapeMenu.style.visibility = 'visible';
}

function toggleShapeMenu() {
  if (isShapeMenuOpen()) {
    closeShapeMenu();
  } else {
    openShapeMenu();
  }
}

/** 切换到指定图形并立即激活（画布拖拽直接按新图形绘制） */
function setShapeTool(tool) {
  if (!SHAPE_TOOLS.includes(tool)) return;
  shapeTool = tool;
  syncShapeButton();
  setTool(tool);
}

/**
 * 合并背景层 + 标注层为一张画布（供马赛克/模糊/取色采样）。
 * 关键：两层 backing store 同尺寸（W×dpr），这里直接做像素级 1:1 拷贝。
 * 曾用 setTransform(dpr) + drawImage(bg, 0, 0) —— 缺省目标尺寸会取源 backing
 * 像素数作为 CSS 尺寸绘制，DPR>1 时目标溢出、只剩左上角内容（取色器恒取错/FFFFFF 的根因）。
 */
function getMergedCanvas() {
  const merged = document.createElement('canvas');
  const dpr = canvasDpr;
  merged.width = Math.round(W * dpr);
  merged.height = Math.round(H * dpr);
  const mctx = merged.getContext('2d');
  mctx.imageSmoothingEnabled = false;
  mctx.drawImage(bgCanvas, 0, 0);
  mctx.drawImage(drawCanvas, 0, 0);
  return merged;
}

/**
 * 只合成"当前需要的那一小块"区域（bg + draw），替代整屏 getMergedCanvas。
 * 笔刷涂抹时每个 mousemove 都要取源像素，整屏合并在高分屏下要临时分配几十 MB 画布
 * 并做两次全屏 drawImage，会明显掉帧；这里只拷贝笔刷覆盖的那块。
 */
function getMergedRegion(bx, by, bw, bh) {
  const merged = document.createElement('canvas');
  merged.width = bw;
  merged.height = bh;
  const mctx = merged.getContext('2d');
  mctx.imageSmoothingEnabled = false;
  mctx.drawImage(bgCanvas, bx, by, bw, bh, 0, 0, bw, bh);
  mctx.drawImage(drawCanvas, bx, by, bw, bh, 0, 0, bw, bh);
  return merged;
}

/**
 * 计算笔刷落点需要取样的矩形（backing px + CSS px 两套坐标）。
 * 四周留一个 pad（= 半径）给模糊滤镜 / 马赛克格子，避免切圆后出现硬边。
 */
function brushSampleRect(cx, cy, cssRadius) {
  const dpr = canvasDpr;
  const pad = cssRadius;
  const fullCssX = cx - cssRadius - pad;
  const fullCssY = cy - cssRadius - pad;
  const fullCssW = cssRadius * 2 + pad * 2;
  const fullCssH = cssRadius * 2 + pad * 2;
  const bx = Math.max(0, Math.round(fullCssX * dpr));
  const by = Math.max(0, Math.round(fullCssY * dpr));
  const bw = Math.min(Math.round(W * dpr) - bx, Math.round(fullCssW * dpr));
  const bh = Math.min(Math.round(H * dpr) - by, Math.round(fullCssH * dpr));
  if (bw < 2 || bh < 2) return null;
  return { bx, by, bw, bh, fullCssX, fullCssY, fullCssW, fullCssH };
}

/** 把 temp 画布的内容用"圆点"裁切后贴回 drawCtx（画到 brushSampleRect 对应的 CSS 矩形） */
function stampBrushRound(tmp, rect, cssRadius) {
  const dpr = canvasDpr;
  const tctx = tmp.getContext('2d');
  tctx.globalCompositeOperation = 'destination-in';
  tctx.fillStyle = '#fff';
  tctx.beginPath();
  tctx.arc(rect.bw / 2, rect.bh / 2, cssRadius * dpr, 0, Math.PI * 2);
  tctx.fill();
  tctx.globalCompositeOperation = 'source-over';
  drawCtx.drawImage(tmp, Math.round(rect.fullCssX), Math.round(rect.fullCssY), Math.round(rect.fullCssW), Math.round(rect.fullCssH));
}

/** 把拖框矩形裁到选区范围内（CSS px），太小返回 null */
function clipRectToSelection(x1, y1, x2, y2) {
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  const w = Math.abs(x2 - x1);
  const h = Math.abs(y2 - y1);
  const rx = Math.max(selX, x);
  const ry = Math.max(selY, y);
  const rr = Math.min(selX + selW, x + w);
  const rb = Math.min(selY + selH, y + h);
  if (rr - rx < 2 || rb - ry < 2) return null;
  return { rx, ry, rw: rr - rx, rh: rb - ry };
}

/**
 * 按 blockPx 网格把整块区域填成小方块：
 * - mode='mosaic'：取每个块中心像素填充满块（保留原图色调）
 * - mode='noise'：每块填一个随机灰阶（内容完全不可辨）
 *
 * 关键：网格按**全图 backing 坐标**对齐（originX/originY = 该区域左上角的全图坐标），
 * 而不是从区域左上角开始排。否则笔刷每移动一点，采样窗口偏移一点，格子就跟着错位，
 * 连续涂抹会拼出明显的"接缝花纹"。
 */
function fillBlockGrid(data, w, h, blockPx, originX, originY, mode) {
  const startY = -(((originY % blockPx) + blockPx) % blockPx);
  const startX = -(((originX % blockPx) + blockPx) % blockPx);
  for (let yy = startY; yy < h; yy += blockPx) {
    const y0 = Math.max(0, yy);
    const yEnd = Math.min(yy + blockPx, h);
    if (yEnd <= y0) continue;
    for (let xx = startX; xx < w; xx += blockPx) {
      const x0 = Math.max(0, xx);
      const xEnd = Math.min(xx + blockPx, w);
      if (xEnd <= x0) continue;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 255;
      if (mode === 'noise') {
        r = 24 + Math.floor(Math.random() * 208);
        g = r;
        b = r;
      } else {
        const sxL = Math.min(x0 + ((xEnd - x0) >> 1), w - 1);
        const syL = Math.min(y0 + ((yEnd - y0) >> 1), h - 1);
        const i = (syL * w + sxL) * 4;
        r = data[i];
        g = data[i + 1];
        b = data[i + 2];
        a = data[i + 3];
      }
      for (let by = y0; by < yEnd; by++) {
        const row = by * w;
        for (let bx = x0; bx < xEnd; bx++) {
          const j = (row + bx) * 4;
          data[j] = r;
          data[j + 1] = g;
          data[j + 2] = b;
          data[j + 3] = a;
        }
      }
    }
  }
}

/* ── 打码：笔刷涂抹（半径 = 工具栏「粗细」，效果参数 = 面板「强度」/「透明度」） ── */

/** 当前打码笔刷半径（CSS px）：统一跟随工具栏的「粗细」滑块 */
function maskBrushRadius() {
  return Math.max(2, drawingSize);
}

/**
 * 像素马赛克笔刷：在 (cx, cy) 处按圆形笔刷打码。
 * 块边长 = 面板「强度」（CSS px）；笔刷粗细由工具栏「粗细」控制。
 */
function applyMosaic(cx, cy) {
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;
  const dpr = canvasDpr;
  const cssRadius = maskBrushRadius();
  const rect = brushSampleRect(cx, cy, cssRadius);
  if (!rect) return;

  const merged = getMergedRegion(rect.bx, rect.by, rect.bw, rect.bh);
  const srcData = merged.getContext('2d').getImageData(0, 0, rect.bw, rect.bh);
  // 马赛克块边长 = 面板「强度」（CSS px）
  const blockPx = Math.max(2, Math.round((maskIntensity || 10) * dpr));
  fillBlockGrid(srcData.data, rect.bw, rect.bh, blockPx, rect.bx, rect.by, 'mosaic');

  const tmp = document.createElement('canvas');
  tmp.width = rect.bw;
  tmp.height = rect.bh;
  tmp.getContext('2d').putImageData(srcData, 0, 0);
  stampBrushRound(tmp, rect, cssRadius);
}

/**
 * 模糊笔刷：在 (cx, cy) 处按圆形笔刷糊一片。
 * 模糊半径 = 面板「强度」（CSS px）；笔刷粗细由工具栏「粗细」控制。
 */
function applyBlur(cx, cy) {
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;
  const dpr = canvasDpr;
  const cssRadius = maskBrushRadius();
  const rect = brushSampleRect(cx, cy, cssRadius);
  if (!rect) return;

  const merged = getMergedRegion(rect.bx, rect.by, rect.bw, rect.bh);
  const tmp = document.createElement('canvas');
  tmp.width = rect.bw;
  tmp.height = rect.bh;
  const tctx = tmp.getContext('2d');
  tctx.filter = `blur(${(maskIntensity || 12) * dpr}px)`;
  tctx.drawImage(merged, 0, 0);
  tctx.filter = 'none';
  stampBrushRound(tmp, rect, cssRadius);
}

/** 噪点笔刷：颗粒边长 = 面板「强度」/2（CSS px） */
function applyNoise(cx, cy) {
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;
  const dpr = canvasDpr;
  const cssRadius = maskBrushRadius();
  const rect = brushSampleRect(cx, cy, cssRadius);
  if (!rect) return;

  const merged = getMergedRegion(rect.bx, rect.by, rect.bw, rect.bh);
  const srcData = merged.getContext('2d').getImageData(0, 0, rect.bw, rect.bh);
  // 噪点颗粒边长 = 面板「强度」/2（CSS px）
  const cellPx = Math.max(1, Math.round(((maskIntensity || 8) / 2) * dpr));
  fillBlockGrid(srcData.data, rect.bw, rect.bh, cellPx, rect.bx, rect.by, 'noise');

  const tmp = document.createElement('canvas');
  tmp.width = rect.bw;
  tmp.height = rect.bh;
  tmp.getContext('2d').putImageData(srcData, 0, 0);
  stampBrushRound(tmp, rect, cssRadius);
}

/**
 * 纯色笔刷：走「单次描边缓冲」——每一笔都先画到一张离屏画布上（不透明），
 * 再以面板「透明度」整体合成一次。这样来回涂抹不会出现半透明叠加越涂越实的现象。
 */
let solidStroke = null;

function beginSolidStroke() {
  const dpr = canvasDpr;
  const sx = Math.max(0, Math.round(selX * dpr));
  const sy = Math.max(0, Math.round(selY * dpr));
  const sw = Math.min(Math.round(W * dpr) - sx, Math.round(selW * dpr));
  const sh = Math.min(Math.round(H * dpr) - sy, Math.round(selH * dpr));
  if (sw < 1 || sh < 1) return;
  const cv = document.createElement('canvas');
  cv.width = sw;
  cv.height = sh;
  solidStroke = {
    canvas: cv,
    ctx: cv.getContext('2d'),
    base: drawCtx.getImageData(sx, sy, sw, sh),
    x: sx,
    y: sy,
    w: sw,
    h: sh,
  };
}

function endSolidStroke() {
  solidStroke = null;
}

function applySolid(cx, cy) {
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;
  if (!solidStroke) beginSolidStroke();
  if (!solidStroke) return;
  const dpr = canvasDpr;
  const r = maskBrushRadius();
  const sctx = solidStroke.ctx;
  sctx.fillStyle = drawingColor;
  sctx.beginPath();
  sctx.arc((cx - selX) * dpr, (cy - selY) * dpr, r * dpr, 0, Math.PI * 2);
  sctx.fill();

  // 每帧都从本笔开始前的底图重来，再按统一透明度合成一次
  drawCtx.putImageData(solidStroke.base, solidStroke.x, solidStroke.y);
  drawCtx.save();
  clipToSelection(drawCtx);
  drawCtx.globalAlpha = Math.max(0.05, Math.min(1, (maskIntensity || 100) / 100));
  drawCtx.drawImage(
    solidStroke.canvas,
    solidStroke.x / dpr,
    solidStroke.y / dpr,
    solidStroke.w / dpr,
    solidStroke.h / dpr,
  );
  drawCtx.restore();
}

/* ── 打码：框选模式（拖矩形整块应用一次） ── */

function applyMosaicRect(x1, y1, x2, y2) {
  const box = clipRectToSelection(x1, y1, x2, y2);
  if (!box) return;
  const dpr = canvasDpr;
  const sx = Math.round(box.rx * dpr);
  const sy = Math.round(box.ry * dpr);
  const sw = Math.round(box.rw * dpr);
  const sh = Math.round(box.rh * dpr);
  if (sw < 2 || sh < 2) return;
  const merged = getMergedRegion(sx, sy, sw, sh);
  const img = merged.getContext('2d').getImageData(0, 0, sw, sh);
  const blockPx = Math.max(2, Math.round((maskIntensity || 10) * dpr));
  fillBlockGrid(img.data, sw, sh, blockPx, sx, sy, 'mosaic');
  drawCtx.putImageData(img, sx, sy);
}

function applyBlurRect(x1, y1, x2, y2) {
  const box = clipRectToSelection(x1, y1, x2, y2);
  if (!box) return;
  const dpr = canvasDpr;
  const blurCss = Math.max(1, maskIntensity || 12);
  const pad = Math.ceil(blurCss * dpr);
  const sx = Math.round(box.rx * dpr);
  const sy = Math.round(box.ry * dpr);
  const sw = Math.round(box.rw * dpr);
  const sh = Math.round(box.rh * dpr);
  // 向外多取一圈 pad，避免滤镜在矩形边缘采样到透明像素而发暗
  const px = Math.max(0, sx - pad);
  const py = Math.max(0, sy - pad);
  const pw = Math.min(Math.round(W * dpr) - px, sw + pad * 2);
  const ph = Math.min(Math.round(H * dpr) - py, sh + pad * 2);
  if (pw < 2 || ph < 2) return;
  const merged = getMergedRegion(px, py, pw, ph);
  const tmp = document.createElement('canvas');
  tmp.width = pw;
  tmp.height = ph;
  const tctx = tmp.getContext('2d');
  tctx.filter = `blur(${blurCss * dpr}px)`;
  tctx.drawImage(merged, 0, 0);
  tctx.filter = 'none';
  const out = tctx.getImageData(sx - px, sy - py, sw, sh);
  drawCtx.putImageData(out, sx, sy);
}

function applyNoiseRect(x1, y1, x2, y2) {
  const box = clipRectToSelection(x1, y1, x2, y2);
  if (!box) return;
  const dpr = canvasDpr;
  const sx = Math.round(box.rx * dpr);
  const sy = Math.round(box.ry * dpr);
  const sw = Math.round(box.rw * dpr);
  const sh = Math.round(box.rh * dpr);
  if (sw < 2 || sh < 2) return;
  const merged = getMergedRegion(sx, sy, sw, sh);
  const img = merged.getContext('2d').getImageData(0, 0, sw, sh);
  const cellPx = Math.max(1, Math.round(((maskIntensity || 8) / 2) * dpr));
  fillBlockGrid(img.data, sw, sh, cellPx, sx, sy, 'noise');
  drawCtx.putImageData(img, sx, sy);
}

function applySolidRect(x1, y1, x2, y2) {
  const box = clipRectToSelection(x1, y1, x2, y2);
  if (!box) return;
  drawCtx.save();
  clipToSelection(drawCtx);
  drawCtx.globalAlpha = Math.max(0.05, Math.min(1, (maskIntensity || 100) / 100));
  drawCtx.fillStyle = drawingColor;
  drawCtx.fillRect(box.rx, box.ry, box.rw, box.rh);
  drawCtx.restore();
}

/** 按当前涂抹方式把一次操作分发到对应实现 */
function applyMaskAt(cx, cy) {
  if (activeTool === 'blur') applyBlur(cx, cy);
  else if (activeTool === 'mosaic') applyMosaic(cx, cy);
  else if (activeTool === 'noise') applyNoise(cx, cy);
  else if (activeTool === 'solid') applySolid(cx, cy);
}

function applyMaskRect(x1, y1, x2, y2) {
  if (activeTool === 'blur') applyBlurRect(x1, y1, x2, y2);
  else if (activeTool === 'mosaic') applyMosaicRect(x1, y1, x2, y2);
  else if (activeTool === 'noise') applyNoiseRect(x1, y1, x2, y2);
  else if (activeTool === 'solid') applySolidRect(x1, y1, x2, y2);
}

/** 直线（color/width 缺省取全局：交互预览/画笔用；annot 渲染时显式传对象固化值） */
function drawLine(ctx, x1, y1, x2, y2, color = drawingColor, width = drawingSize) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function drawRect(ctx, x1, y1, x2, y2, color = drawingColor, width = drawingSize) {
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  const w = Math.abs(x2 - x1);
  const h = Math.abs(y2 - y1);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.strokeRect(x, y, w, h);
}

/** 箭头：直线 + 末端双斜线箭头 */
function drawArrow(ctx, x1, y1, x2, y2, color = drawingColor, width = drawingSize) {
  drawLine(ctx, x1, y1, x2, y2, color, width);
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = Math.max(10, width * 3);
  const a1 = angle + Math.PI * 0.75;
  const a2 = angle - Math.PI * 0.75;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 + head * Math.cos(a1), y2 + head * Math.sin(a1));
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 + head * Math.cos(a2), y2 + head * Math.sin(a2));
  ctx.stroke();
}

/** 椭圆描边 */
function drawEllipse(ctx, x1, y1, x2, y2, color = drawingColor, width = drawingSize) {
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const rx = Math.abs(x2 - x1) / 2;
  const ry = Math.abs(y2 - y1) / 2;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.stroke();
}

/** 取色：返回点击位置的颜色 hex（#RRGGBB） */
function pickColorAt(mx, my) {
  const dpr = canvasDpr;
  // 只合成 1×1 那一格：取色是每帧调用，整屏合成会明显卡顿
  const px = Math.max(0, Math.min(Math.round(mx * dpr), Math.round(W * dpr) - 1));
  const py = Math.max(0, Math.min(Math.round(my * dpr), Math.round(H * dpr) - 1));
  const merged = getMergedRegion(px, py, 1, 1);
  const ctx = merged.getContext('2d');
  const d = ctx.getImageData(0, 0, 1, 1).data;
  const r = d[0].toString(16).padStart(2, '0');
  const g = d[1].toString(16).padStart(2, '0');
  const b = d[2].toString(16).padStart(2, '0');
  return `#${r}${g}${b}`.toUpperCase();
}

function finishSelection(mx, my) {
  resetTranslationCache();
  hoverWindowRect = null;
  selX = Math.min(startX, mx);
  selY = Math.min(startY, my);
  selW = Math.abs(mx - startX);
  selH = Math.abs(my - startY);
  if (selW < 3 || selH < 3) {
    state = STATE.IDLE;
    selX = selY = selW = selH = 0;
    drawCtx.clearRect(0, 0, W, H);
    historyStack.length = 0;
    resetAnnots();
    hideToolbar();
    drawMask();
    updateSizeInfo(mx, my);
    return;
  }
  state = STATE.SELECTED;
  console.error(`[cap] selection done t=${Date.now()} sel=${selX},${selY} ${selW}x${selH} state=SELECTED`);
  showToolbar();
  drawMask();
  updateSizeInfo(mx, my);
}

/**
 * 裁剪选区并合并涂鸦图层
 * @returns PNG dataURL，若选区无效则返回 null
 */
function cropSelectionWithAnnotations() {
  if (!bgImage || selW < 2 || selH < 2) return null;
  const dpr = canvasDpr;

  const usesCompositedBackground = Boolean(
    captureVirtualScreen && capturePhysicalScreen && captureDisplays.length > 0,
  );
  const sourceCanvas = usesCompositedBackground ? bgCanvas : bgImage;
  // 输出采用物理分辨率：保存/复制的截图与屏幕原始清晰度一致
  // 帧像素/逻辑像素 比：desktopCapturer 帧是物理分辨率（naturalWidth = W*dpr），
  // 旧公式 /(W*dpr) 在 dpr>1 时把逻辑选区当物理坐标裁剪 → 内容向左上偏移 (1-1/dpr)（r61 修复）
  const scaleX = usesCompositedBackground ? dpr : bgImage.naturalWidth / W;
  const scaleY = usesCompositedBackground ? dpr : bgImage.naturalHeight / H;

  const sx = Math.round(selX * scaleX);
  const sy = Math.round(selY * scaleY);
  const sw = Math.round(selW * scaleX);
  const sh = Math.round(selH * scaleY);

  const outCanvas = document.createElement('canvas');
  outCanvas.width = sw;
  outCanvas.height = sh;
  const outCtx = outCanvas.getContext('2d');
  outCtx.imageSmoothingEnabled = false;

  outCtx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, sw, sh);

  const scaledDraw = document.createElement('canvas');
  scaledDraw.width = sw;
  scaledDraw.height = sh;
  const sctx = scaledDraw.getContext('2d');
  sctx.drawImage(drawCanvas, Math.round(selX * dpr), Math.round(selY * dpr), sw, sh, 0, 0, sw, sh);
  outCtx.drawImage(scaledDraw, 0, 0);

  // 矢量对象层（文字/图形）与 drawCanvas 同 backing 网格（round(selX*dpr)），
  // 按同一选区物理矩形合成 → pin/copy/save/OCR/翻译 的结果都包含矢量标注。
  if (annotCanvas && annotations.length > 0) {
    const scaledAnnot = document.createElement('canvas');
    scaledAnnot.width = sw;
    scaledAnnot.height = sh;
    const actx = scaledAnnot.getContext('2d');
    actx.drawImage(annotCanvas, Math.round(selX * dpr), Math.round(selY * dpr), sw, sh, 0, 0, sw, sh);
    outCtx.drawImage(scaledAnnot, 0, 0);
  }

  return outCanvas.toDataURL('image/png');
}

/** 仅裁出选区原始背景（不含标注/矢量层），供二维码等需要干净像素的识别使用 */
function cropSelectionRaw() {
  if (!bgImage || selW < 2 || selH < 2) return null;
  const dpr = canvasDpr;
  const usesCompositedBackground = Boolean(
    captureVirtualScreen && capturePhysicalScreen && captureDisplays.length > 0,
  );
  const sourceCanvas = usesCompositedBackground ? bgCanvas : bgImage;
  // 帧像素/逻辑像素 比：desktopCapturer 帧是物理分辨率（naturalWidth = W*dpr），
  // 旧公式 /(W*dpr) 在 dpr>1 时把逻辑选区当物理坐标裁剪 → 内容向左上偏移 (1-1/dpr)（r61 修复）
  const scaleX = usesCompositedBackground ? dpr : bgImage.naturalWidth / W;
  const scaleY = usesCompositedBackground ? dpr : bgImage.naturalHeight / H;
  const sx = Math.round(selX * scaleX);
  const sy = Math.round(selY * scaleY);
  const sw = Math.round(selW * scaleX);
  const sh = Math.round(selH * scaleY);
  const outCanvas = document.createElement('canvas');
  outCanvas.width = sw;
  outCanvas.height = sh;
  const outCtx = outCanvas.getContext('2d');
  outCtx.imageSmoothingEnabled = false;
  outCtx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, sw, sh);
  return outCanvas;
}

/**
 * 释放截图页中的大对象资源
 * @description 截图窗口销毁前主动释放 URL、位图与历史栈，降低内存峰值残留
 */
function releaseCaptureResources() {
  if (currentCaptureObjectUrl) {
    URL.revokeObjectURL(currentCaptureObjectUrl);
    currentCaptureObjectUrl = '';
  }

  historyStack.length = 0;
  bgImage = null;
  captureDisplays = [];
  captureVirtualScreen = null;
  capturePhysicalScreen = null;

  [bgCanvas, drawCanvas, annotCanvas, tempCanvas].forEach((cv) => {
    cv.width = 0;
    cv.height = 0;
  });
  if (captureMask) captureMask.style.display = 'none';
  if (captureHandles) captureHandles.style.display = 'none';
}

// 窗口复用模式下，会话结束（隐藏窗口）前主进程发此信号：清掉画布与全部浮层，只留
// body 那层暗蒙版。不清的话，下次 show 的瞬间会闪出**上一张截图**（页面还在、canvas 上
// 仍是上次的画面）。注意这与 reload 不冲突 —— reload 负责重置 JS 状态，这里负责视觉清空。
ipcRenderer.on('capture-clear', () => {
  try {
    releaseCaptureResources();
  } catch (_) { /* 容忍 */ }

  const hide = (el) => {
    if (el) el.style.display = 'none';
  };
  hide(toolbar);
  hide(ocrPanel);
  hide(translateOverlay);
  hide(magnifier);
  hide(captureHint);
  hide(pickerOverlay);
  hide(brushCursor);
  hide(shapeMenu);
  hide(maskMenu);
  hide(sizeInfo);

  if (textEditor) {
    try { textEditor.remove(); } catch (_) { /* 容忍 */ }
    textEditor = null;
  }
  if (textEditorHint) {
    try { textEditorHint.remove(); } catch (_) { /* 容忍 */ }
    textEditorHint = null;
  }

  state = STATE.IDLE;
  selX = 0;
  selY = 0;
  selW = 0;
  selH = 0;
});

ipcRenderer.on('capture-image', (_e, data) => {
  console.error(
    `[cap] capture-image recv t=${Date.now()} bytes=${data.imageBytes ? data.imageBytes.length : 0} ` +
      `src=${data.captureSource} external=${data.externalCapture === true} rect=${data.cropRect ? `${data.cropRect.w}x${data.cropRect.h}` : 'none'} ` +
      `visibleWins=${data.visibleWindows ? data.visibleWindows.length : 0} noHover=${CAPTURE_NO_HOVER}`,
  );
  resetTranslationCache();
  scaleFactor = data.scaleFactor || 1;
  captureDisplays = Array.isArray(data.displays) ? data.displays : [];
  captureVirtualScreen = data.virtualScreen || null;
  capturePhysicalScreen = data.physicalScreen || null;
  setVisibleWindowRects(data.visibleWindows, captureVirtualScreen);
  const isExternal = data.externalCapture === true;

  if (currentCaptureObjectUrl) {
    URL.revokeObjectURL(currentCaptureObjectUrl);
    currentCaptureObjectUrl = '';
  }

  let imageSrc = data.imageDataURL || '';
  if (data.imageBytes && data.imageBytes.length > 0) {
    const blob = new Blob([data.imageBytes], { type: 'image/png' });
    currentCaptureObjectUrl = URL.createObjectURL(blob);
    imageSrc = currentCaptureObjectUrl;
  }

  if (!imageSrc) {
    return;
  }

  const img = new Image();
  img.onload = () => {
    bgImage = img;
    console.error(`[cap] img decode done t=${Date.now()} natural=${img.naturalWidth}x${img.naturalHeight} W=${W} H=${H}`);
    initCanvases();
    // 打点：截图画完 + 蒙版层布局后的真实状态（若此处蒙版异常，用户看到的就是「变亮无蒙版」）
    try {
      console.error(
        `[cap] canvases done t=${Date.now()} state=${state} mask.display=${captureMask ? captureMask.style.display : 'null'} ` +
          `mask.class=${captureMask ? captureMask.className : 'null'} ` +
          `bgImage=${bgImage ? 'set' : 'null'} dpr=${window.devicePixelRatio}`,
      );
    } catch (_) { /* 打点失败静默 */ }

    // 通知主进程：内容已就位、帧已提交合成器，可以一次性亮窗了。
    // 主进程的 reveal 在收到本信号后才执行（2026-09-04 核心时序：内容在**不可见期**
    // 画好 → 帧提交 → 才亮窗 → 亮起瞬间 = 完整暗化画面，无「活桌面→截图」中间帧 → 无闪）。
    // 窗口此刻是「屏外 + opacity 0」驻留，从未 hide → 依然 visible，rAF 正常触发；
    // 等两帧确保合成器已拾取新帧 —— 否则主进程 reveal 后首帧可能仍是旧画面
    // （空白暗蒙版透出真实桌面），下一帧截图才到 → 那一下就是用户看到的「闪」。
    let readySent = false;
    const sendReady = () => {
      if (readySent) return;
      readySent = true;
      try {
        console.error(`[cap] send capture-ready t=${Date.now()}`);
        ipcRenderer.send('capture-ready');
      } catch (_) { /* 容忍 */ }
    };
    requestAnimationFrame(() => requestAnimationFrame(sendReady));
    setTimeout(sendReady, 120); // 兜底：rAF 若被节流（罕见），最迟 120ms 也要放行，避免窗口永远不亮

    if (isExternal) {
      if (data.cropRect && data.cropRect.w > 0 && data.cropRect.h > 0) {
        // 原生引擎（native_shot）全屏截屏 + 选区坐标：选区落回原始屏幕位置，
        // 四周暗化，工具条跟在选区旁——与内置截图 UI 完全一致（仅框选动作由原生完成）。
        selX = Math.max(0, Math.min(data.cropRect.x, W - 1));
        selY = Math.max(0, Math.min(data.cropRect.y, H - 1));
        selW = Math.max(1, Math.min(data.cropRect.w, W - selX));
        selH = Math.max(1, Math.min(data.cropRect.h, H - selY));
      } else {
        // 旧式裁剪图直传：整图即选区（居中全图，无暗化洞）
        selX = 0;
        selY = 0;
        selW = W;
        selH = H;
      }
      state = STATE.SELECTED;
      showToolbar();
      drawMask();
      updateSizeInfo(selX, selY);
    }

    if (currentCaptureObjectUrl) {
      URL.revokeObjectURL(currentCaptureObjectUrl);
      currentCaptureObjectUrl = '';
    }
  };

  img.onerror = () => {
    if (currentCaptureObjectUrl) {
      URL.revokeObjectURL(currentCaptureObjectUrl);
      currentCaptureObjectUrl = '';
    }
  };

  img.src = imageSrc;
});

tempCanvas.addEventListener('mousedown', (e) => {
  if (isCaptureBusy()) return;
  // PICKING 状态下忽略额外 mousedown（避免被「再次点击选其他色」截断；只能通过 mouseup 完成）
  if (state === STATE.PICKING) return;
  // 右键：取消当前选区回到 IDLE，再次右键或按 Esc 退出截图
  if (e.button === 2) {
    e.preventDefault();
    if (state === STATE.DRAWING) {
      // 框选过程中：取消本次框选
      state = STATE.IDLE;
      hoverWindowRect = pendingWindowClickRect || null;
      drawMask();
      if (hoverWindowRect) showToolbar();
    } else if (state === STATE.SELECTED) {
      // 已选区：清掉选区 + 翻译 / OCR 缓存，回到 IDLE
      resetTranslationCache();
      selX = 0; selY = 0; selW = 0; selH = 0;
      resizeHandle = null;
      state = STATE.IDLE;
      hideToolbar();
      drawMask();
    } else if (state === STATE.RESIZING) {
      // 拖拽 handle 中：放弃本次 resize
      resizeHandle = null;
      state = STATE.SELECTED;
      drawMask();
    } else if (state === STATE.MOVING) {
      // 拖动（选区或对象）中右键：取消本次拖动；对象拖动还原到按下瞬间的位置
      if (dragAnnotIndex >= 0) {
        if (dragBase) annotations[dragAnnotIndex] = cloneAnnots([dragBase])[0];
        dragAnnotIndex = -1;
        dragBase = null;
        renderAnnots();
      }
      state = STATE.SELECTED;
      showToolbar();
      drawMask();
    } else if (state === STATE.IDLE) {
      // 无选区：右键直接退出截图
      ipcRenderer.send('capture-cancel');
    }
    return;
  }
  if (e.button !== 0) return;
  const _lsPt = lsClientToLogical(e);
  const mx = _lsPt.x;
  const my = _lsPt.y;

  if (state === STATE.IDLE) {
    resetTranslationCache();
    pendingWindowClickRect = hoverWindowRect;
    state = STATE.DRAWING;
    startX = mx;
    startY = my;
    hoverWindowRect = null;
    hideToolbar();
    console.error(`[cap] mousedown -> DRAWING t=${Date.now()} at=${mx},${my} pendingWin=${pendingWindowClickRect ? 'yes' : 'no'}`);
    drawMask();
    return;
  }

  if (state === STATE.SELECTED && activeTool === 'select') {
    const handle = hitTestHandle(mx, my);
    if (handle) {
      resetTranslationCache();
      state = STATE.RESIZING;
      hoverAnnotIndex = -1;
      resizeHandle = handle;
      const anchors = {
        tl: [selX + selW, selY + selH], t: [selX, selY + selH],
        tr: [selX, selY + selH], r: [selX, selY],
        br: [selX, selY], b: [selX, selY],
        bl: [selX + selW, selY], l: [selX + selW, selY],
      };
      resizeAnchorX = anchors[handle][0];
      resizeAnchorY = anchors[handle][1];
      hideToolbar();
      return;
    }
    if (isInsideSelection(mx, my)) {
      resetTranslationCache();
      // #48 对象层：MOVE 工具点中矢量对象 → 只拖动该对象（Snipaste 手感：点中文字/图形即可拉动），
      // 未命中（空白处）仍整体移动选区。
      const hitAnnot = hitTestAnnot(mx, my);
      if (hitAnnot >= 0) {
        dragAnnotIndex = hitAnnot;
        dragBase = cloneAnnots([annotations[hitAnnot]])[0];
        dragStartX = mx;
        dragStartY = my;
        hoverAnnotIndex = -1; // 拖动中的选中框接管悬停框
        state = STATE.MOVING;
        hideToolbar();
        return;
      }
      state = STATE.MOVING;
      moveOffX = mx - selX;
      moveOffY = my - selY;
      hideToolbar();
      return;
    }
    resetTranslationCache();
    state = STATE.DRAWING;
    startX = mx;
    startY = my;
    hoverAnnotIndex = -1;
    hideToolbar();
    drawMask();
    return;
  }

  if (state === STATE.SELECTED && activeTool !== 'select' && isInsideSelection(mx, my)) {
    resetTranslationCache();
    // 任意工具下点中已有矢量对象（文字/图形/序号）→ 直接进入拖动，无需切「移动」工具；
    // 取色器除外（按住采样是它的核心交互，不能被拖动抢走）。
    if (activeTool !== 'picker') {
      const hitAnnot = hitTestAnnot(mx, my);
      if (hitAnnot >= 0) {
        dragAnnotIndex = hitAnnot;
        dragBase = cloneAnnots([annotations[hitAnnot]])[0];
        dragStartX = mx;
        dragStartY = my;
        hoverAnnotIndex = -1;
        state = STATE.MOVING;
        hideToolbar();
        return;
      }
    }
    if (activeTool === 'text') {
      // 在选区内 mx, my 处直接嵌入 textarea，焦点已就位，键入即落字；
      // Enter 提交、Ctrl+Enter 换行、Esc 丢弃并销毁。
      openTextEditor(mx, my);
      return;
    }
    if (activeTool === 'picker') {
      // 按住取色：进入 PICKING 态持续采样，松开才关闭色环。
      state = STATE.PICKING;
      const color = pickColorAt(mx, my);
      if (color) {
        updatePickerOverlay(mx, my, color);
      }
      return;
    }
    state = STATE.ANNOTATING;
    annotStartX = mx;
    annotStartY = my;
    penLastX = mx;
    penLastY = my;
    maskStrokePainted = false;
    hideToolbar();
    // 纯色笔刷：开启一次描边缓冲（整笔只按透明度合成一次，避免半透明来回涂叠加变实）
    if (activeTool === 'solid' && maskMode === 'brush') beginSolidStroke();
    if (activeTool === 'pen') {
      clipToSelection(drawCtx);
      drawLine(drawCtx, penLastX, penLastY, mx, my);
      restoreClip(drawCtx);
    }
  }
});

/**
 * mousemove 的 RAF 节流调度器
 * @description mousemove 事件可达 125~500Hz，直接处理会反复全屏重绘/放大镜采样导致卡顿。
 * 统一缓存最新坐标，在下一帧（~60Hz）合并处理一次；同一帧内多次移动只消费一次。
 */
let pendingMouseX = 0;
let pendingMouseY = 0;
let hasScheduledMouseFrame = false;

function scheduleMouseMove(mx, my) {
  pendingMouseX = mx;
  pendingMouseY = my;
  if (hasScheduledMouseFrame) return;
  hasScheduledMouseFrame = true;
  requestAnimationFrame(() => {
    hasScheduledMouseFrame = false;
    if (isCaptureBusy()) return;
    handleMouseMove(pendingMouseX, pendingMouseY);
  });
}

function handleMouseMove(mx, my) {
  // 笔刷预览圈：不论在哪个 state，只要光标在选区内 + 工具是 pen/打码系，就跟随显示
  setBrushCursor(mx, my, true);

  if (state === STATE.IDLE) {
    const nextHoverWindow = CAPTURE_NO_HOVER ? null : findWindowRectAt(mx, my);
    if (nextHoverWindow !== hoverWindowRect) {
      hoverWindowRect = nextHoverWindow;
      // 打点：IDLE 悬停开洞切换 —— 这是「进入截图后蒙版被局部摘除/变亮」的主要嫌疑路径
      try {
        console.error(
          `[cap] hover t=${Date.now()} ${nextHoverWindow ? `WINDOW ${nextHoverWindow.x},${nextHoverWindow.y} ${nextHoverWindow.width}x${nextHoverWindow.height}` : 'none -> full mask'}`,
        );
      } catch (_) { /* 打点失败静默 */ }
      drawMask();
    }
    document.body.style.cursor = 'crosshair';
    updateSizeInfo(mx, my);
    showMagnifier(mx, my);
    return;
  }

  if (state === STATE.DRAWING) {
    selX = Math.min(startX, mx);
    selY = Math.min(startY, my);
    selW = Math.abs(mx - startX);
    selH = Math.abs(my - startY);
    drawMask();
    updateSizeInfo(mx, my);
    showMagnifier(mx, my);
    return;
  }

  // MOVING / RESIZING：用户已经选好区在拖动 / 缩放，关闭放大镜
  // （截图分两步：① IDLE 框选看像素 → ② SELECTED 调整位置 → 不应再叠像素放大镜）
  if (state === STATE.MOVING) {
    if (dragAnnotIndex >= 0) {
      // 拖动单个矢量对象：对象坐标 = dragBase + 钳制位移，只重画对象层，位图与选区不动
      if (dragBase) moveAnnotByDrag(mx, my);
      renderAnnots();
      updateSizeInfo(mx, my);
      hideMagnifier();
      return;
    }
    selX = Math.max(0, Math.min(mx - moveOffX, W - selW));
    selY = Math.max(0, Math.min(my - moveOffY, H - selH));
    drawMask();
    updateSizeInfo(mx, my);
    hideMagnifier();
    return;
  }

  if (state === STATE.RESIZING) {
    let newX = selX;
    let newY = selY;
    let newW = selW;
    let newH = selH;
    const h = resizeHandle;

    if (h === 'tl' || h === 'l' || h === 'bl') { newX = Math.min(mx, resizeAnchorX); newW = Math.abs(resizeAnchorX - mx); }
    else if (h === 'tr' || h === 'r' || h === 'br') { newX = Math.min(mx, resizeAnchorX); newW = Math.abs(mx - resizeAnchorX); }

    if (h === 'tl' || h === 't' || h === 'tr') { newY = Math.min(my, resizeAnchorY); newH = Math.abs(resizeAnchorY - my); }
    else if (h === 'bl' || h === 'b' || h === 'br') { newY = Math.min(my, resizeAnchorY); newH = Math.abs(my - resizeAnchorY); }

    selX = newX;
    selY = newY;
    selW = newW;
    selH = newH;
    drawMask();
    updateSizeInfo(mx, my);
    hideMagnifier();
    return;
  }

  // 取色器按住取色：PICKING 状态下持续采样并刷新色环浮层（松开自动关闭）
  if (state === STATE.PICKING) {
    const color = pickColorAt(mx, my);
    if (color) {
      updatePickerOverlay(mx, my, color);
      // 同步把 hex 显示在 sizeInfo 旁，便于未拖动鼠标时也能看到
      sizeInfo.textContent = color;
      sizeInfo.style.display = 'block';
      sizeInfo.style.left = `${Math.min(mx + 16, W - 90)}px`;
      sizeInfo.style.top = `${Math.max(my + 16, 0)}px`;
    }
    return;
  }

  if (state === STATE.ANNOTATING) {
    clearTemp();
    if (activeTool === 'pen') {
      clipToSelection(drawCtx);
      drawLine(drawCtx, penLastX, penLastY, mx, my);
      restoreClip(drawCtx);
      penLastX = mx;
      penLastY = my;
    } else if (BRUSH_CURSOR_TOOLS.has(activeTool) && activeTool !== 'pen' && maskMode === 'brush') {
      // 打码「笔刷」模式：每个 mousemove 立即涂一个点，mouseup 收整笔历史。
      maskStrokePainted = true;
      clipToSelection(drawCtx);
      applyMaskAt(mx, my);
      restoreClip(drawCtx);
    } else if (BRUSH_CURSOR_TOOLS.has(activeTool) && activeTool !== 'pen' && maskMode === 'rect') {
      // 打码「框选」模式：拖出矩形预览，mouseup 才真正应用。
      // 双色两遍描边（深晕 3.5px + 白芯 1.5px），保证在深/浅任何底色下边框都清晰
      // —— 单白色虚线在浅色区域几乎看不见（“马赛克选框看不清”的根因）。
      clipToSelection(tempCtx);
      const rx = Math.min(annotStartX, mx);
      const ry = Math.min(annotStartY, my);
      const rw = Math.abs(mx - annotStartX);
      const rh = Math.abs(my - annotStartY);
      tempCtx.lineJoin = 'round';
      tempCtx.strokeStyle = 'rgba(0,0,0,.72)';
      tempCtx.lineWidth = 3.5;
      tempCtx.strokeRect(rx, ry, rw, rh);
      tempCtx.strokeStyle = 'rgba(255,255,255,.98)';
      tempCtx.lineWidth = 1.5;
      tempCtx.strokeRect(rx, ry, rw, rh);
      restoreClip(tempCtx);
    } else {
      clipToSelection(tempCtx);
      if (activeTool === 'line') {
        drawLine(tempCtx, annotStartX, annotStartY, mx, my);
      } else if (activeTool === 'rect') {
        drawRect(tempCtx, annotStartX, annotStartY, mx, my);
      } else if (activeTool === 'arrow') {
        drawArrow(tempCtx, annotStartX, annotStartY, mx, my);
      } else if (activeTool === 'ellipse') {
        drawEllipse(tempCtx, annotStartX, annotStartY, mx, my);
      }
      restoreClip(tempCtx);
    }
    updateSizeInfo(mx, my);
    return;
  }

  if (state === STATE.SELECTED && activeTool === 'select') {
    const handle = hitTestHandle(mx, my);
    // 悬停对象 → 画选中框（提示可直接拖动）
    const hoverHit = (!handle && isInsideSelection(mx, my)) ? hitTestAnnot(mx, my) : -1;
    if (hoverHit !== hoverAnnotIndex) {
      hoverAnnotIndex = hoverHit;
      renderAnnots();
    }
    if (handle) {
      const map = { tl: 'nwse-resize', tr: 'nesw-resize', bl: 'nesw-resize', br: 'nwse-resize', t: 'ns-resize', b: 'ns-resize', l: 'ew-resize', r: 'ew-resize' };
      document.body.style.cursor = map[handle] || 'crosshair';
    } else if (hoverAnnotIndex >= 0) {
      document.body.style.cursor = 'default';
    } else if (isInsideSelection(mx, my)) {
      document.body.style.cursor = 'move';
    } else {
      document.body.style.cursor = 'crosshair';
    }
    updateSizeInfo(mx, my);
    return;
  }

  if (state === STATE.SELECTED && activeTool !== 'select') {
    // 非移动工具：悬停到已有矢量对象上 → 画选中框 + 箭头光标，提示可直接拖动
    const hoverHit = isInsideSelection(mx, my) ? hitTestAnnot(mx, my) : -1;
    if (hoverHit !== hoverAnnotIndex) {
      hoverAnnotIndex = hoverHit;
      renderAnnots();
    }
    if (hoverAnnotIndex >= 0) {
      // 命中对象：隐藏笔刷预览圈（拖动优先），光标用普通箭头
      setBrushCursor(mx, my, false);
      document.body.style.cursor = 'default';
    } else {
      document.body.style.cursor = 'crosshair';
    }
    updateSizeInfo(mx, my);
    return;
  }

  updateSizeInfo(mx, my);
}

tempCanvas.addEventListener('mousemove', (e) => {
  const _lsPtMv = lsClientToLogical(e);
  scheduleMouseMove(_lsPtMv.x, _lsPtMv.y);
});

/**
 * Alt+滚轮快速调整笔刷粗细（pen 与四种打码共用同一个 drawingSize，
 * 与工具栏「粗细」滑块双向同步；打码的效果参数在二级面板里调）。
 */
tempCanvas.addEventListener('wheel', (e) => {
  if (!e.altKey || state !== STATE.SELECTED) return;
  if (!BRUSH_CURSOR_TOOLS.has(activeTool)) return;
  e.preventDefault();
  e.stopPropagation();
  // 滚轮 dy 1~2 微调；按住 shift 步进大
  const step = e.shiftKey ? 5 : 1;
  const delta = -Math.sign(e.deltaY) * step;
  drawingSize = Math.max(1, Math.min(60, drawingSize + delta));
  if (sizeSlider) sizeSlider.value = String(drawingSize);
  if (sizeValue) sizeValue.textContent = `${drawingSize}px`;
  sizeInfo.textContent = `${drawingSize}px`;
  sizeInfo.style.display = 'block';
  sizeInfo.style.left = `${Math.min(e.clientX + 16, W - 90)}px`;
  sizeInfo.style.top = `${Math.max(e.clientY + 16, 0)}px`;
  // 笔刷预览圈跟随大小更新
  setBrushCursor(e.clientX, e.clientY, true);
}, { passive: false });

tempCanvas.addEventListener('mouseup', (e) => {
  if (isCaptureBusy()) return;
  if (e.button === 2) return; // 右键已在 mousedown 处理
  const _lsPt = lsClientToLogical(e);
  const mx = _lsPt.x;
  const my = _lsPt.y;

  if (state === STATE.DRAWING) {
    hideMagnifier();
    const moved = Math.abs(mx - startX) >= 3 || Math.abs(my - startY) >= 3;
    if (!moved && pendingWindowClickRect) {
      selectWindowRect(pendingWindowClickRect);
      pendingWindowClickRect = null;
      return;
    }
    pendingWindowClickRect = null;
    finishSelection(mx, my);
    return;
  }

  if (state === STATE.MOVING || state === STATE.RESIZING) {
    // 拖动矢量对象结束：确实移动过才收一步对象历史（Ctrl+Z 可整体回退），
    // 没动过（原地点击/单击）不收，避免 Undo 出现空步骤。
    if (dragAnnotIndex >= 0) {
      const a = annotations[dragAnnotIndex];
      const b = dragBase;
      const moved = a && b && (
        a.type === 'text'
          ? (a.x !== b.x || a.y !== b.y)
          : (a.x1 !== b.x1 || a.y1 !== b.y1 || a.x2 !== b.x2 || a.y2 !== b.y2)
      );
      dragAnnotIndex = -1;
      dragBase = null;
      if (moved) commitHistory(false);
    }
    state = STATE.SELECTED;
    showToolbar();
    drawMask();
    updateSizeInfo(mx, my);
    return;
  }

  // 取色器松开：关闭色环浮层，把最后一次采样颜色写入工具栏 colorPicker + 复制到剪贴板
  if (state === STATE.PICKING) {
    const color = pickColorAt(mx, my);
    if (color) {
      drawingColor = color;
      if (colorPicker) colorPicker.value = color;
      if (clipboard && clipboard.writeText) {
        try { clipboard.writeText(color); } catch (_) { /* 无 clipboard API 时静默 */ }
      }
    }
    closePickerOverlay();
    sizeInfo.style.display = 'none';
    state = STATE.SELECTED;
    showToolbar();
    drawMask();
    return;
  }

  if (state === STATE.ANNOTATING) {
    clearTemp();
    if (SHAPE_TOOLS.includes(activeTool)) {
      // 图形工具（直线/矩形/箭头/椭圆）→ 矢量对象：存入对象层（可被 MOVE 拖动/undo），
      // 不再直接写进 drawCanvas 位图。像素由 renderAnnots() 统一画到 annotCanvas。
      const half = Math.abs(mx - annotStartX) >= 0.5 || Math.abs(my - annotStartY) >= 0.5;
      if (half) {
        annotations.push({
          type: 'shape',
          shape: activeTool,
          x1: annotStartX,
          y1: annotStartY,
          x2: mx,
          y2: my,
          color: drawingColor,
          size: drawingSize,
        });
        renderAnnots();
        commitHistory(false); // 只改了对象层：位图快照复用栈顶，内存零增长
      }
    } else if (BRUSH_CURSOR_TOOLS.has(activeTool) && activeTool !== 'pen' && maskMode === 'rect') {
      // 打码「框选」：整块应用一次（位图操作，直接改 drawCanvas 像素）
      clipToSelection(drawCtx);
      applyMaskRect(annotStartX, annotStartY, mx, my);
      restoreClip(drawCtx);
      commitHistory(true);
    } else if (activeTool === 'pen') {
      // 画笔笔迹：mousemove 已实时画线，mouseup 收尾压一次位图快照
      commitHistory(true);
    } else if (BRUSH_CURSOR_TOOLS.has(activeTool) && activeTool !== 'pen' && maskStrokePainted) {
      // 打码「笔刷」涂抹整笔：像素在 mousemove 已实时落在 drawCanvas，
      // 这里收一次位图快照 → 一步撤销一整笔（曾漏收：笔迹既不能撤销，
      // 后续任何 restoreHistoryTop（如文字编辑/翻译切换）还会把它整笔抹掉）。
      commitHistory(true);
    }
    // 打码「笔刷」：mousemove 已实时涂抹，mouseup 只收尾（结束纯色描边缓冲）
    endSolidStroke();
    state = STATE.SELECTED;
    showToolbar();
    drawMask();
    updateSizeInfo(mx, my);
  }
});

/**
 * 双击文字对象 → 重新进入编辑（保留原文本/颜色/字号/位置）。
 * 实现：先 openTextEditor（其内部先把"含该对象"的现状压入历史栈，Esc 可整体回退），
 * 再把原对象从 annotations 摘除、把原文灌进编辑器 —— 提交时按原样式固化回同位置。
 */
tempCanvas.addEventListener('dblclick', (e) => {
  if (isCaptureBusy() || state !== STATE.SELECTED) return;
  if (e.button !== 0) return;
  const _lsPt = lsClientToLogical(e);
  const mx = _lsPt.x;
  const my = _lsPt.y;
  if (!isInsideSelection(mx, my)) return;
  const hit = hitTestAnnot(mx, my);
  if (hit < 0) return;
  const a = annotations[hit];
  if (!a || a.type !== 'text' || a.editing) return;

  if (textEditor) commitTextEditor();
  // 先按原字号恢复工具栏粗细/颜色（编辑器字体取自当前工具栏状态）
  const restoredSize = Math.max(1, Math.min(60, Math.round((a.fontSize - 12) / 3)));
  drawingSize = restoredSize;
  if (sizeSlider) sizeSlider.value = String(restoredSize);
  if (sizeValue) sizeValue.textContent = `${restoredSize}px`;
  drawingColor = a.color;
  if (colorPicker) colorPicker.value = a.color;

  const lineHeightPx = Math.max(1, Math.round(a.fontSize * a.lineHeight));
  openTextEditor(a.x, a.y + lineHeightPx / 2); // 点击点 = 首行中线 → textAnchorY 正好回到 a.y
  if (!textEditor) return;
  annotations.splice(hit, 1); // 摘除原对象：编辑期间由 editingTextAnnot 临时接管
  renderAnnots();
  textEditor.value = a.text;
  refreshEditorCanvas();
  startCaretBlink();
});

Array.from(document.querySelectorAll('button.tool')).forEach((btn) => {
  if (btn === shapeBtn || btn === maskBtn) return; // 复合按钮行为单独处理（见下方绑定）
  btn.addEventListener('click', () => {
    if (isCaptureBusy() || state !== STATE.SELECTED) return;
    setTool(btn.dataset.tool || 'select');
  });
});

if (maskBtn) {
  maskBtn.addEventListener('click', () => {
    if (isCaptureBusy() || state !== STATE.SELECTED) {
      closeMaskMenu();
      return;
    }
    if (activeTool === maskTool) {
      // 已在使用当前打码样式：再次点击 → 弹出面板换样式/调强度
      toggleMaskMenu();
      return;
    }
    // 未激活：直接用当前默认打码样式开始画
    setTool(maskTool);
  });
}

if (shapeBtn) {
  shapeBtn.addEventListener('click', () => {
    if (isCaptureBusy() || state !== STATE.SELECTED) {
      closeShapeMenu();
      return;
    }
    if (activeTool === shapeTool) {
      // 已在使用当前图形：再次点击 → 弹出面板选择其它图形
      toggleShapeMenu();
      return;
    }
    // 未激活：直接用当前默认图形开始画
    setTool(shapeTool);
  });
}

if (maskMenu) {
  maskItems.forEach((item) => {
    item.addEventListener('click', () => {
      if (isCaptureBusy() || state !== STATE.SELECTED) return;
      setMaskTool(item.dataset.mask || 'mosaic');
      // 统一面板保持打开：切换类型后强度/透明度滑块就地刷新，方便连着调参（Esc 或再点按钮收起）
    });
  });
  maskModeBtns.forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const next = btn.dataset.mode;
      if (!next) return;
      setMaskMode(next);
      // 切换后保持菜单打开，方便连着调参数；Esc 或点外部才关闭
    });
  });
  // 初始高亮：笔刷模式 + 当前打码类型对应的效果参数
  syncMaskModeUI();
  syncMaskStrengthUI();
}

if (maskStrength) {
  syncMaskStrengthUI();
  maskStrength.addEventListener('input', () => {
    maskIntensity = Number(maskStrength.value || 12);
    maskParams[maskTool] = maskIntensity;
    const cfg = MASK_PARAM[maskTool] || MASK_PARAM.mosaic;
    if (maskStrengthValue) {
      maskStrengthValue.textContent = cfg.percent ? `${maskIntensity}%` : String(maskIntensity);
    }
  });
}

if (textEditor) {
  // 文字编辑器由 openTextEditor 内部统一绑定键位/失焦处理，这里只刷新占位符 i18n
}

if (shapeMenu) {
  shapeItems.forEach((item) => {
    item.addEventListener('click', () => {
      if (isCaptureBusy() || state !== STATE.SELECTED) return;
      setShapeTool(item.dataset.shape || 'rect');
      closeShapeMenu();
    });
  });
}

// 点击菜单/输入浮层以外的任意位置（画布 / 工具栏其它按钮）都先收起浮层；
// 捕获阶段执行，保证后续按钮/画布逻辑按“浮层已关闭”的状态处理。
document.addEventListener('mousedown', (e) => {
  if (isShapeMenuOpen() && !shapeMenu.contains(e.target) && !shapeBtn.contains(e.target)) {
    closeShapeMenu();
  }
  // 统一工具面板不参与「点外部收起」：它是绘制工具的常驻参数面板（颜色/强度要边画边调），
  // 显隐完全跟随 activeTool（setTool → syncToolPanel）；再点工具按钮可手动收起
  // 翻译语言二级面板：点击面板与按钮以外区域即收起
  if (isTranslateMenuOpen() && !translateMenu.contains(e.target) && !btnTranslate.contains(e.target)) {
    closeTranslateMenu();
  }
  // 点击文字编辑器以外的画布/工具栏，blur textarea → 走 commitTextEditor（失焦分支）
  if (textEditor && !textEditor.contains(e.target)) {
    // 不直接关闭：commitTextEditor 已在 textarea.addEventListener('blur') 内统一处理
    // 这里不需要动作
  }
}, true);

if (btnPin) {
  btnPin.addEventListener('click', async () => {
    if (isCaptureBusy() || state !== STATE.SELECTED) return;
    const dataURL = cropSelectionWithAnnotations();
    if (!dataURL) return;
    try {
      const pinned = await ipcRenderer.invoke('capture-pin', { dataURL });
      if (pinned) {
        // 贴图窗已独立常驻桌面；这里确认后自动退出截图面板
        showToastMessage(tCapture('pinnedHint'));
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        ipcRenderer.send('capture-cancel');
        return;
      }
      showToastMessage(tCapture('pinFailed'));
    } catch {
      showToastMessage(tCapture('pinFailed'));
    }
  });
}

colorPicker.addEventListener('input', () => {
  drawingColor = colorPicker.value;
  // 文字编辑中换色：画布上的字实时变色（字符是我们自己画的，直接重绘即可）
  if (textEditor) refreshEditorCanvas();
});
if (sizeSlider) {
  // 初始数值同步
  drawingSize = Number(sizeSlider.value || 4);
  if (sizeValue) sizeValue.textContent = `${drawingSize}px`;
  sizeSlider.addEventListener('input', () => {
    drawingSize = Number(sizeSlider.value || 4);
    if (sizeValue) sizeValue.textContent = `${drawingSize}px`;
    // 文字编辑中改粗细 = 改字号，画布上的字实时缩放
    if (textEditor) refreshEditorCanvas();
  });
}

/* #88 三个新功能按钮：长截图 / 录屏 / 二维码。
   主进程对应 handler 在 #90/#91/#92 实现；这里先派发 IPC，无 handler 时给出温和提示，
   保证按钮可点、不报错，待功能接入后自动生效。 */
function requestFeature(channel, soonKey) {
  ipcRenderer.invoke(channel).catch(() => {
    showToastMessage(tCapture(soonKey));
    window.setTimeout(() => {
      if (translateOverlay.classList.contains('is-toast')) hideTranslateOverlay();
    }, 1600);
  });
}
// ⚠️ 提前声明长截图控制条按钮：下方 3951-3952 行处理器在【加载期】就引用它们，
// 若 const 放到后面会触发 TDZ（Cannot access ... before initialization）加载期中断 →
// 其后所有工具栏按钮绑定不执行 → 工具栏点不动 + 点长截图崩溃。
const btnLongShotDone = document.getElementById('btnLongShotDone');
const btnLongShotCancel = document.getElementById('btnLongShotCancel');
const btnLongShotAuto = document.getElementById('btnLongShotAuto');
/* 长截图自动滚动（r21）：主进程匀速合成滚轮。手动变速滚动（走走停停+甩滚）与速度连续性
 * 先验匹配器天然矛盾（实测真值 1657px 只拼上 1099px），匀速滚动位移恒定、重叠大且可预测。 */
let lsAutoScrollOn = true; // 默认开：进入长截图即自动匀速滚动，用户可随时关闭改手动
let lsAutoScrollActive = false; // 自动滚动运行中（r22）：此时抓帧策略切为「沉降抓帧」——只在滚动动画结束的静止点抓帧
let lsSettleRetries = 0;       // 沉降重试计数：lsFullStep 发现仍在动就推迟，超限放弃等待直接抓（防漏帧）
if (btnLongShotAuto) btnLongShotAuto.addEventListener('click', () => {
  lsAutoScrollOn = !lsAutoScrollOn;
  btnLongShotAuto.textContent = lsAutoScrollOn ? '自动滚动：开' : '自动滚动：关';
  console.error(`[LS] autoscroll toggle -> ${lsAutoScrollOn}`);
  if (lsAutoScrollOn) lsAutoScrollStart(); else lsAutoScrollStop();
});

if (btnLongShot) btnLongShot.addEventListener('click', () => {
  if (isCaptureBusy()) return;
  if (longShotActive) { stopLongScreenshot(true); return; } // 再点长截图按钮 = 结束拼接
  if (state !== STATE.SELECTED) return;
  startLongScreenshot();
});
if (btnLongShotDone) btnLongShotDone.addEventListener('click', () => { if (longShotActive) stopLongScreenshot(true); });
if (btnLongShotCancel) btnLongShotCancel.addEventListener('click', () => { if (longShotActive) stopLongScreenshot(false); });

/* #90 长截图（手动滚动 + 自动拼接）：选区保持可见 → 主屏截图(thumbnail)裁剪选区 → 定时取帧 → 纵向重叠拼接 → 右侧实时预览
 * 2026-09-06 重构：彻底移除视频流(getUserMedia+<video>+requestVideoFrameCallback)。
 * 改为「主屏截图」路线：每次捕获经主进程 capture-longshot-frame 取桌面源 thumbnail，
 * 按选区矩形裁剪出原生分辨率选区图（NativeImage→dataURL→Image），零 WebRTC 视频编码，
 * 清晰度等同于单张截图。拼接/匹配/消缝逻辑复用 lsMatchScroll/lsAppendRows。 */
const longShotOverlay = document.getElementById('longShotOverlay');
const longShotPreview = document.getElementById('longShotPreview');
const longShotPreviewCanvas = document.getElementById('longShotPreviewCanvas');
const longShotControl = document.getElementById('longShotControl');

let longShotActive = false;
let lsSourceId = null;        // 桌面源 id（进入时取一次，后续复用）
let lsTimer = 0;
let lsCumShift = 0;
let lsBaseH = 0;
let lsAccum = null;           // 当前瓦片累加图（canvas，原生分辨率）
let lsTiles = [];             // 超限拆分的已结算瓦片 dataURL[]
let lsFlushedH = 0;           // 已结算瓦片累计高度
let lsOverLimitWarned = false;
let lsSaveFilename = null;    // 编辑器保存默认名（长截图_时间戳_1）
let lsPreviewCtx = null;
let lsLastHeartbeat = 0;
let lsDiagLast = 0;
function lsDiagDue() { const n = Date.now(); if (n - lsDiagLast < 1000) return false; lsDiagLast = n; return true; }
let lsLiveLast = 0;
let lsPrevGray = null;

const LS_PROBE_MS = 150;           // GDI 通道探针间隔（BitBlt ~10ms；150ms 才追得上快滚 ~500px/s）
const LS_FULL_COOLDOWN_MS = 100;   // 全分辨率捕获最小间隔（GDI 抓帧 ~10-19ms，仅防同一步滚动重复匹配）
const LS_SETTLE_MS = 0;            // GDI 通道无沉降窗口：帧越密位移越小、重叠越多、谷越稳
const LS_AUTO_SETTLE_MS = 220;     // （r22 遗留，r23 步进制下探针不再排程抓帧）自动滚动模式沉降等待
const LS_AUTO_STEP_GAP_MS = 120;   // r53: 200→120（抓帧前已有 lsWaitMotion+lsWaitQuiet 双重确认静止，
                                   // gap 只影响感知节奏；r48 的 100ms 软帧问题在步进制+静止确认下不复存在）
const LS_MOTION_WAIT_MS = 700;     // r53: 900→700（实测滚轮要么被吞要么 <300ms 内起滚，无中间态）；
                                   // 超时补发一次滚轮（再超时判到底/不可滚，自动收尾 1.4s）
const LS_MULTI_WHEEL_GAP_MS = 100; // r57: 吸附模式多滚轮间隔（ms）——太近会被页面合并成一次手势
const LS_ACTIVE_MS = 45;           // 活跃期全帧连拍节拍（GDI bitblt ~10ms；45ms×滚速1m/s=45px 位移，量程内必拼上）
const LS_MOTION_HOLD = 300;        // 活跃保持窗口：最近一次变化后持续连拍 300ms 才交还探针巡查

/** GDI 抓屏（主进程 BitBlt，毫秒级）：物理像素矩形 → BGRA raw → RGBA canvas；失败返回 null（调用方 fallback） */
async function lsGdiFrame(gx, gy, gw, gh, dst) {
  try {
    // r55: 请求高度比选区少 2 物理行——GDI BitBlt 的最后 1~2 行与合成器更新存在竞争
    // （实测白色瀑布流会话：末行 MAD 29~51 vs 倒数第二行 1.2），撕裂行拼进结果 =
    // 每条拼接缝上一道贯穿全宽的细线。选区少 2 行对拼接无感知影响。
    const ghr = Math.max(8, Math.round(gh) - 2);
    const res = await ipcRenderer.invoke('capture-longshot-gdi', { gx: Math.round(gx), gy: Math.round(gy), gw: Math.round(gw), gh: ghr });
    if (!res || !res.buf || !(res.w > 0) || !(res.h > 0)) return null;
    const src = res.buf instanceof Uint8Array ? res.buf : new Uint8Array(res.buf);
    const n = res.w * res.h;
    if (src.length < n * 4) return null;
    const rgba = new Uint8ClampedArray(n * 4);
    for (let i = 0, j = 0; j < n; i += 4, j++) {
      rgba[i] = src[i + 2]; rgba[i + 1] = src[i + 1]; rgba[i + 2] = src[i]; rgba[i + 3] = 255;
    }
    let cv = dst;
    if (!cv || cv.width !== res.w || cv.height !== res.h) {
      cv = document.createElement('canvas');
      cv.width = res.w; cv.height = res.h;
    }
    cv.getContext('2d', { willReadFrequently: true }).putImageData(new ImageData(rgba, res.w, res.h), 0, 0);
    return cv;
  } catch (_) { return null; }
}

/** GDI raw BGRA 直接算灰度（探针专用：省 putImage/getImageData 两趟内存拷贝） */
function lsGdiGray(res) {
  const src = res.buf instanceof Uint8Array ? res.buf : new Uint8Array(res.buf);
  const n = res.w * res.h;
  const gray = new Float32Array(n);
  for (let j = 0, i = 0; j < n; j++, i += 4) gray[j] = (src[i + 2] * 114 + src[i + 1] * 587 + src[i] * 299) / 1000;
  return gray;
}
/** r26 拉普拉斯方差（清晰度）：列采样 2px、三行滑动的流式 laplacian。
 *  值仅作同会话相对比较（静止基准 EMA），不设绝对阈值——内容本身决定量级。 */
function lsLapVar(cv) {
  try {
    const w = cv.width, h = cv.height;
    if (w < 8 || h < 8) return 0;
    const d = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    const cols = Math.floor((w - 2) / 2);
    if (cols < 4) return 0;
    const read = (row, buf) => {
      const base = row * w;
      for (let c = 0; c < cols; c++) { const x = 1 + c * 2; const i = (base + x) * 4; buf[c] = d[i] * 114 + d[i + 1] * 587 + d[i + 2] * 299; }
    };
    const r0 = new Float32Array(cols), r1 = new Float32Array(cols), r2 = new Float32Array(cols);
    read(0, r0); read(1, r1);
    let sum = 0, sum2 = 0, n = 0;
    for (let y = 1; y < h - 1; y++) {
      read(y + 1, r2);
      for (let c = 1; c < cols - 1; c++) {
        const lap = 4 * r1[c] - r0[c] - r2[c] - r1[c - 1] - r1[c + 1];
        sum += lap; sum2 += lap * lap; n++;
      }
      r0.set(r1); r1.set(r2);
    }
    if (!n) return 0;
    const m = sum / n;
    return sum2 / n - m * m;
  } catch (_) { return 0; }
}
/** r54 内容归一化清晰度：只统计「有纹理行」的 laplacian 方差。
 *  r52 已证 lap_var 会被内容疏密稀释（大面积纯背景把均值拉低），深/浅色页面都会误判：
 *  深色页把锐利但稀疏的帧当软帧（17:31 每步白耗 360ms 重试），浅色页漏判真软帧
 *  （18:43 会话软帧混入被用户感知为清晰度差）。行内灰度方差 ≥64（0-255 口径，×1e6 缩放单位）
 *  的行才是文字/图形行——它们的 lap 下降才是真模糊信号，与背景占比无关。
 *  lap 跨三行：要求该行与上下邻行都有纹理才计入。返回 0 = 纹理不足无法量化。 */
function lsLapVarInfo(cv) {
  try {
    const w = cv.width, h = cv.height;
    if (w < 8 || h < 8) return 0;
    const d = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    const cols = Math.floor((w - 2) / 2);
    if (cols < 4) return 0;
    const VAR_MIN = 64 * 1e6; // 行纹理门槛：64 × (灰度×1000 缩放)²
    const rowInf = new Uint8Array(h);
    const gray = new Float32Array(h * cols);
    let textured = 0;
    for (let y = 0; y < h; y++) {
      const base = y * w, row = y * cols;
      let rs = 0, rs2 = 0;
      for (let c = 0; c < cols; c++) { const x = 1 + c * 2; const i = (base + x) * 4; const v = d[i] * 114 + d[i + 1] * 587 + d[i + 2] * 299; gray[row + c] = v; rs += v; rs2 += v * v; }
      rowInf[y] = (rs2 / cols - (rs / cols) ** 2) >= VAR_MIN ? 1 : 0;
      textured += rowInf[y];
    }
    if (textured < 4) return 0;
    let sum = 0, sum2 = 0, n = 0;
    for (let y = 1; y < h - 1; y++) {
      if (!(rowInf[y - 1] && rowInf[y] && rowInf[y + 1])) continue; // lap 跨三行，任一行纯背景都会稀释
      const row = y * cols;
      for (let c = 1; c < cols - 1; c++) {
        const lap = 4 * gray[row + c] - gray[row + c - 1] - gray[row + c + 1] - gray[row - cols + c] - gray[row + cols + c];
        sum += lap; sum2 += lap * lap; n++;
      }
    }
    if (n < cols * 2) return 0;
    const m = sum / n;
    return sum2 / n - m * m;
  } catch (_) { return 0; }
}
let lsProbeCanvas = null;
let lsFullBusy = false; let lsProbeGray = null; let lsProbeTimer = 0; let lsLastFullAt = 0; let lsProbeDiagLast = 0;
let lsFullTimer = 0; let lsStartT = 0; let lsDebugDumps = 0; let lsLastFrameDiff = 0;
let lsMotionUntil = 0;             // 活跃期截止时间戳：滚动进行中 full step 自循环连拍，静止后回归探针
const LS_MAX_HEIGHT = 16000;   // 单张 canvas 高度上限（<16384 硬限，超出自动拆瓦片）
const LS_STRIP_MAX = 400;
const LS_TILE_OVERLAP = 240;   // 瓦片间重叠行（seed 新瓦片用，保证拼接连续）

let lsPrev = null;
let lsBufA = null; let lsBufB = null;
let lsCw = 0; let lsCh = 0; // 选区裁剪尺寸（物理像素）

/** 鼠标客户端坐标 → 逻辑画布坐标（长图编辑态需补偿页面滚动） */
function lsClientToLogical(e) {
  if (document.body.classList.contains('is-longshot-edit')) {
    return { x: e.clientX + (window.scrollX || 0), y: e.clientY + (window.scrollY || 0) };
  }
  return { x: e.clientX, y: e.clientY };
}

function lsStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 取长截图编辑器保存默认文件名（btnSave 用） */
function lsGetSaveFilename() { return window.__lsSaveFilename || null; }

/** 把一张选区图(已裁剪好的 Image)画进持久缓冲 dst，返回该 canvas；失败返回 null */
function lsDrawFrameInto(dst, src, cw, ch) {
  if (!dst || dst.width !== cw || dst.height !== ch) {
    dst = document.createElement('canvas');
    dst.width = cw;
    dst.height = ch;
  }
  const ctx = dst.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  try { ctx.drawImage(src, 0, 0, cw, ch); } catch (_) { return null; }
  return dst;
}

/** 更新右侧预览面板 */
function lsUpdatePreview() {
  if (!lsAccum) return;
  if (!longShotPreviewCanvas) return;
  const previewW = longShotPreviewCanvas.clientWidth || 164;
  const scale = Math.min(1, previewW / lsAccum.width);
  const drawW = Math.round(lsAccum.width * scale);
  const drawH = Math.round(lsAccum.height * scale);
  if (longShotPreviewCanvas.width !== drawW || longShotPreviewCanvas.height !== drawH) {
    longShotPreviewCanvas.width = drawW;
    longShotPreviewCanvas.height = drawH;
    lsPreviewCtx = longShotPreviewCanvas.getContext('2d');
  }
  if (!lsPreviewCtx) lsPreviewCtx = longShotPreviewCanvas.getContext('2d');
  lsPreviewCtx.clearRect(0, 0, drawW, drawH);
  lsPreviewCtx.drawImage(lsAccum, 0, 0, drawW, drawH);
  console.error(`[LS] preview accum=${lsAccum.width}x${lsAccum.height} total=${(lsFlushedH + lsAccum.height)} draw=${drawW}x${drawH}`);
}

let lsPreviewUpdates = 0;

let lsLastUpHintAt = 0;
let lsHintRestoreTimer = 0;
function lsHintUpScroll() {
  const now = Date.now();
  if (now - lsLastUpHintAt < 2000) return;
  lsLastUpHintAt = now;
  if (!longShotPreview) return;
  const label = longShotPreview.querySelector('.capture-longshot-preview-label');
  if (!label) return;
  if (!label.dataset.orig) label.dataset.orig = label.textContent;
  label.textContent = '已到已拼底部：继续向下滚动拼接';
  if (lsHintRestoreTimer) window.clearTimeout(lsHintRestoreTimer);
  lsHintRestoreTimer = window.setTimeout(() => {
    const el = longShotPreview && longShotPreview.querySelector('.capture-longshot-preview-label');
    if (el && el.dataset.orig) el.textContent = el.dataset.orig;
  }, 1800);
}

function lsSendOverlayPreview() {}

// r57: 拼接健康度状态点（借鉴 ShareX 绿/黄/红状态灯）：绿=正常拼接，黄=吸附加速/猜测对齐，红=连续拒帧
let lsHealthDot = null;
function lsSetHealth(color) {
  if (!longShotPreview) return;
  if (!lsHealthDot) {
    lsHealthDot = document.createElement('span');
    lsHealthDot.id = 'ls-health-dot';
    longShotPreview.appendChild(lsHealthDot);
  }
  lsHealthDot.style.background = color;
}

// r58: 编辑态画布平移——中键拖动或 Alt+左键拖动滚动页面（参考图片查看器惯例）。
// 左键保留给标注工具，避免冲突；平移在手势期间临时关闭平滑，松开恢复。
(function initEditorCanvasPan() {
  const cv = document.getElementById('bgCanvas');
  if (!cv) return;
  let pan = null;
  cv.addEventListener('pointerdown', (e) => {
    if (!document.body.classList.contains('is-longshot-edit')) return;
    if (!(e.button === 1 || (e.button === 0 && e.altKey))) return;
    e.preventDefault();
    e.stopPropagation();
    pan = { x: e.clientX, y: e.clientY, sx: window.scrollX || 0, sy: window.scrollY || 0 };
    try { cv.setPointerCapture(e.pointerId); } catch (_) { }
  });
  cv.addEventListener('pointermove', (e) => {
    if (!pan) return;
    window.scrollTo(pan.sx - (e.clientX - pan.x), pan.sy - (e.clientY - pan.y));
  });
  const endPan = (e) => {
    if (!pan) return;
    pan = null;
    try { if (e.pointerId !== undefined) cv.releasePointerCapture(e.pointerId); } catch (_) { }
  };
  cv.addEventListener('pointerup', endPan);
  cv.addEventListener('pointercancel', endPan);
})();
// r57: 编辑器工具栏可拖动（参考微信截图）：按住工具栏非按钮区域拖动，按钮交互不受影响
(function initEditorToolbarDrag() {
  const bar = document.getElementById('toolbar');
  if (!bar) return;
  let drag = null;
  bar.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, select, input, label')) return;
    const rect = bar.getBoundingClientRect();
    drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    bar.style.left = `${rect.left}px`;
    bar.style.top = `${rect.top}px`;
    bar.style.right = 'auto';
    bar.style.bottom = 'auto';
    bar.style.transform = 'none';
    try { bar.setPointerCapture(e.pointerId); } catch (_) { }
  });
  bar.addEventListener('pointermove', (e) => {
    if (!drag) return;
    // r58: clamp 到整个虚拟屏幕（screenX/Y 是全局坐标，窗口可在其内任意位置），
    // 不再被编辑器窗口边界困住（用户反馈"只能窗口内移动"）。
    const left = Math.max(4, Math.min(e.clientX - drag.dx, window.screen.width - bar.offsetWidth - 4));
    const top = Math.max(4, Math.min(e.clientY - drag.dy, window.screen.height - bar.offsetHeight - 4));
    bar.style.left = `${left}px`;
    bar.style.top = `${top}px`;
  });
  const endDrag = () => { drag = null; };
  bar.addEventListener('pointerup', endDrag);
  bar.addEventListener('pointercancel', endDrag);
})();

function lsPositionPreview() {
  if (!longShotPreview) return;
  const pad = 12;
  const pw = 180;
  const ph = longShotPreview.offsetHeight || 120;
  const selR = selX + selW, selB = selY + selH;
  let left, top;
  if (selR + pad + pw <= window.innerWidth - pad) {
    left = selR + pad; top = selY;
  } else if (selX - pad - pw >= pad) {
    left = selX - pad - pw; top = selY;
  } else {
    // r55: 两侧都放不下 → 选区下方（配合抓帧斗篷，即使与选区重叠也不会进结果）
    left = Math.max(pad, Math.min(selX, window.innerWidth - pad - pw));
    top = Math.max(pad, Math.min(selB + pad, window.innerHeight - pad - ph));
  }
  top = Math.max(pad, Math.min(top, window.innerHeight - ph - pad));
  longShotPreview.style.left = `${left}px`;
  longShotPreview.style.top = `${top}px`;
}

function abortLongShotStartup() {
  longShotActive = false;
  lsAccum = null; lsTiles = []; lsFlushedH = 0; lsSaveFilename = null; window.__lsSaveFilename = null;
  document.body.classList.remove('is-longshot');
  document.body.classList.remove('is-longshot-edit');
  if (annotCanvas) annotCanvas.style.visibility = '';
  if (drawCanvas) drawCanvas.style.visibility = '';
  if (longShotOverlay) longShotOverlay.hidden = true;
  if (longShotPreview) longShotPreview.hidden = true;
  if (longShotControl) longShotControl.hidden = true;
  showToolbar();
  drawMask();
}

async function startLongScreenshot() {
  if (longShotActive || selW < 4 || selH < 4) { console.error(`[LS] start blocked: active=${longShotActive} sel=${selW}x${selH}`); return; }
  const lsT0 = performance.now();
  console.error(`[LS] start(gdi mode) sel=(${selX},${selY}) ${selW}x${selH} dpr=${window.devicePixelRatio}`);
  longShotActive = true;
  lsStartT = Date.now(); lsDebugDumps = 0;
  lsPrev = null; lsPrevGray = null; lsTiles = []; lsFlushedH = 0; lsOverLimitWarned = false;
  lsLastGoodS = 0; lsAcceptCount = 0; lsRecIdx = 0; lsRecLog = [];
  lsSaveFilename = `长截图_${lsStamp()}_1`;
  if (captureHandles) captureHandles.style.display = 'none';
  if (captureGuide) captureGuide.classList.add('is-away');
  document.body.classList.add('is-longshot');
  if (annotCanvas) annotCanvas.style.visibility = 'hidden';
  if (drawCanvas) drawCanvas.style.visibility = 'hidden';
  if (longShotOverlay) longShotOverlay.hidden = false;
  if (longShotPreview) { longShotPreview.hidden = false; lsPositionPreview(); }
  if (longShotControl) longShotControl.hidden = false;
  // 桌面源不再预取：主通道是 GDI，getSources 600~900ms 是进入长截图卡顿元凶；
  // fallback（capture-longshot-frame）需要时才懒取
  lsSourceId = null;
  clearLongShotHole();
  setLsActive(true);
  // r60: 业界共识（ShareX/Snagit 官方文档）——悬停效果是滚动拼接的头号输入源干扰，
  // 处理方式是引导用户移开鼠标而非程序化移动（侵入性强，无商业产品这么做）。
  showToastMessage(tCapture('lsStartHint'));
  // 默认自动匀速滚动：进入会话即开始（UI paint 后），用户可点控制条开关改手动
  if (lsAutoScrollOn) {
    if (btnLongShotAuto) btnLongShotAuto.textContent = '自动滚动：开';
    lsAutoScrollStart();
  } else if (btnLongShotAuto) {
    btnLongShotAuto.textContent = '自动滚动：关';
  }
  lsAttachKeyDown();
  // 让 UI 先完成一次 paint 再启动采样循环，消除进入瞬间卡顿
  await new Promise((r) => setTimeout(r, 0));
  console.error(`[LS] entry ui-ready in ${(performance.now() - lsT0).toFixed(0)}ms`);
  lsProbeStep();
}

function setLsActive(on) {
  console.error(`[LS] active -> ${on}`);
  const sel = { x: selX, y: selY, w: selW, h: selH };
  try { ipcRenderer.send('capture-ls-active', { on: on === true, sel }); } catch (err) { console.error('[LS] active send failed', err); }
}

/** r23 步进制自动滚动：滚一格 → 等画面完全静止（连续 2 次探针无变化）→ 抓帧 → 停顿 → 下一格。
 *  连续滚动模式（r21/r22）页面永远处于平滑动画中（600ms/格 vs 动画 ~500-700ms），沉降预算耗尽后
 *  照样抓中途帧——实测静止帧锐度(lap_var) 7097 vs 动画帧 3481，差一倍（文字亚像素重采样发虚）。
 *  步进制保证每帧都是静止帧：接缝零发虚 + 位移恒定（一格一轮），节奏由 LS_AUTO_STEP_GAP_MS 控制。 */
let lsAutoStepToken = 0; // 循环代币：stop/重启时失效旧循环，防双循环并发抓帧

function lsAutoScrollStart() {
  lsAutoScrollActive = true;
  lsSettleRetries = 0;
  // 方案A 首格系数校准：先发一次小滚(探针)实测该 App 滚轮→像素系数，据其设定正式首格 delta，
  // 取代 r38 固定 -60 在滚动系数差异大的不同 App 下首格过冲(重叠不足被拒)/不足(内容大量重复)的问题。
  // 探针位移小→重叠大→首格必然可接；随后闭环收敛到 lsAutoTargetFrac×帧高目标（r53 起 0.65）。
  lsAutoProbe = -24;
  lsAutoCalib = true;
  lsAutoRampScale = 0; // r56: 渐进系数每会话重置
  lsAutoSnapMode = false; lsAutoMultiWheel = 1; lsAutoSnapStreak = 0; lsPrevLockS = 0; // r57/r59: 每会话重置
  lsAutoDelta = lsAutoProbe;
  lsAutoStepLoop(++lsAutoStepToken);
}

function lsAutoScrollStop() {
  lsAutoScrollActive = false;
  try { ipcRenderer.invoke('capture-ls-autoscroll', { action: 'stop' }).catch(() => { }); } catch (_) { }
}

async function lsAutoStepLoop(token) {
  console.error('[LS] auto-step loop start');
  while (longShotActive && lsAutoScrollActive && token === lsAutoStepToken) {
    // r57: 吸附模式下每步连发 N 个滚轮（间隔 100ms 避免被页面合并成一次手势），
    // 一次跨过多个吸附卡点，恢复 0.5 帧高的正常步长。
    const wheels = lsAutoSnapMode ? Math.max(1, lsAutoMultiWheel) : 1;
    for (let wi = 0; wi < wheels; wi++) {
      try { await ipcRenderer.invoke('capture-ls-autoscroll', { action: 'step', delta: lsAutoDelta }); }
      catch (err) { console.error('[LS] auto-step wheel failed', err); }
      if (wi < wheels - 1) await new Promise((r) => setTimeout(r, LS_MULTI_WHEEL_GAP_MS));
    }
    // r51: 发轮后先等「画面真的动起来」再等静止。被遮挡的目标窗口会节流丢弃 PostedMessage
    // 的 WM_MOUSEWHEEL（实测 15:47 会话第 2 格滚轮被吞，静置 2s 后下一格才恢复滚动），
    // 旧流程直接 lsWaitQuiet 在「从未滚动」的画面上 ~300ms 即判静 → 抓到与上一帧相同的
    // 静止帧（static-gdi 跳过）→ 白白空转一格。先等运动出现，等不到就补发一次。
    const moved = await lsWaitMotion(LS_MOTION_WAIT_MS);
    if (!moved) {
      if (!longShotActive || !lsAutoScrollActive || token !== lsAutoStepToken) break;
      console.error('[LS] auto-step wheel no-op, resend once');
      try { await ipcRenderer.invoke('capture-ls-autoscroll', { action: 'step', delta: lsAutoDelta }); }
      catch (err) { console.error('[LS] auto-step wheel resend failed', err); }
      const moved2 = await lsWaitMotion(LS_MOTION_WAIT_MS);
      if (!moved2) {
        // 连续两轮无运动：页面已滚动到底 / 目标不可滚动。旧流程会永远空转（静帧被
        // static-gdi 跳过、不计拒链，循环没有停止条件），只能用户手动停止 → 自动收尾。
        // r52 不弹 toast：收尾即进编辑器，浮层会盖在结果上被误读为"遮挡"。
        // r54: 例外——一步都没拼上（页面未滚动/不可滚）时必须说明原因，否则用户只看到
        // "单帧编辑器"以为功能坏了（18:42 会话实测反馈"不稳定"）。
        console.error('[LS] auto-step wheel dead (page bottom or unscrollable) -> auto finish');
        if (lsAcceptCount === 0) showToastMessage('页面未滚动或不可滚动，已保留当前画面');
        stopLongScreenshot(true);
        break;
      }
    }
    const settled = await lsWaitQuiet(2500); // 平滑动画 ~500-700ms；超时兜底照抓（防卡死不滚）
    if (!longShotActive || !lsAutoScrollActive || token !== lsAutoStepToken) break;
    if (!settled && lsDiagDue()) console.error('[LS] auto-step settle-timeout, capture anyway');
    lsMotionUntil = 0; // 已确认静止 → 绕过 lsFullStep 入口的沉降推迟检查
    lsLastFullAt = Date.now();
    lsLastStepAppended = false;
    await lsFullStep();
    // r58: 位移过大保护——单步位移 > 0.7 帧高即拒拼（重叠 <30% 不可靠），改为补半步重拍：
    // 帧-帧间真位移 590px 被拒后直接进下一格，590px 内容整段跳过错拼（22:47 会话 B 实测）。
    // 现在改为：记录待补位置，下一格匹配时由 rescue/prev 链自然桥接；仍连续超限时收紧 delta。
    if (lsLastStepAppended && lsCh > 0 && lsLastGoodS > lsCh * 0.7) {
      console.error(`[LS] oversize s=${lsLastGoodS.toFixed(0)} > 0.7*fh=${(lsCh * 0.7).toFixed(0)} -> 收紧步长防跳变`);
      lsAutoDelta = -Math.max(18, Math.round(Math.abs(lsAutoDelta) * 0.6));
    }
    // r59: 周期锁死自愈——连续 2 步位移几乎相同（差 <5px）且都 >0.6×帧高：匹配器锁死在
    // 重复元素周期假谷上（23:10 会话连续 585±10 → 内容周期性重复+跳段）。重置速度先验，
    // 下一格回种子先验重新搜索，打破周期锁定。
    if (lsLastStepAppended && lsCh > 0 && lsLastGoodS > lsCh * 0.6) {
      if (lsPrevLockS > 0 && Math.abs(lsLastGoodS - lsPrevLockS) < 5) {
        console.error(`[LS] period-lock detected (s=${lsLastGoodS.toFixed(0)} twice) -> 重置匹配状态打破周期`);
        lsLastGoodS = 0; lsAcceptCount = 0; lsRejectStreak = 0; lsAutoRampScale = 0; lsAutoCalib = true;
        lsAutoProbe = -Math.max(24, Math.round(lsCh * 0.08));
        lsAutoDelta = lsAutoProbe;
        lsPrevLockS = 0;
      } else {
        lsPrevLockS = lsLastGoodS;
      }
    } else {
      lsPrevLockS = 0;
    }
    // r57: 拼接健康度状态点（预览面板右上角）
    if (lsLastStepAppended) lsSetHealth('#34d399');
    else if (lsRejectStreak >= 4) lsSetHealth('#f87171');
    else if (lsRejectStreak >= 2) lsSetHealth('#fbbf24');
    // r31 自适应步进：用匹配器实测位移 s 反推下一格滚轮量，使每格位移恒定≈目标比例*帧高。
    // 滚轮 delta 与目标 App 像素位移不线性（平滑滚动放大），但"实测 s→调 delta"闭环即可让
    // 每格位移收敛到目标，重叠恒足→不拒拼、不浪费小步，整体更快且清晰。
    // r57: 吸附式滚动检测与处理——实测位移持续 < 一半目标（与滚轮量大小无关）时，
    // 判定页面按卡点固定步进（scroll-snap/分页滚动）。此时 delta→位移映射失效，
    // delta 冻结，改用「每步连发 N 个滚轮」控制步长（N 按实测/目标自适应，1~4）。
    const fullTarget = lsAutoTargetFrac * lsCh;
    if (lsAutoSnapMode) {
      if (lsLastStepAppended && lsLastGoodS > 0) {
        if (lsLastGoodS < fullTarget * 0.55 && lsAutoMultiWheel < 4) lsAutoMultiWheel++;
        else if (lsLastGoodS > fullTarget * 1.35 && lsAutoMultiWheel > 1) lsAutoMultiWheel--;
        if (lsDiagDue()) console.error(`[LS] snap-mode wheels=${lsAutoMultiWheel} s=${lsLastGoodS.toFixed(0)} target=${fullTarget.toFixed(0)}`);
      }
    } else if (lsLastStepAppended && lsLastGoodS > 0 && lsCh > 0) {
      // r58: 判据从"目标一半"改为绝对值 60px——target 已收紧到 0.35 帧高（矮选区 ~90px），
      // 旧相对判据失效。吸附页面每手势 100~130px 恒定；正常页面校准后位移逼近 target 绝不恒小。
      if (lsLastGoodS <= 60) lsAutoSnapStreak++; else lsAutoSnapStreak = 0;
      if (lsAutoSnapStreak >= 2 && lsAcceptCount >= 3) {
        lsAutoSnapMode = true;
        lsAutoMultiWheel = Math.min(4, Math.max(2, Math.ceil(fullTarget / Math.max(1, lsLastGoodS))));
        lsSetHealth('#fbbf24');
        showToastMessage('该页面按卡片滚动，已自动加速');
        console.error(`[LS] snap scroll detected -> multi-wheel=${lsAutoMultiWheel} (s=${lsLastGoodS.toFixed(0)} target=${fullTarget.toFixed(0)})`);
      }
    }
    if (!lsAutoSnapMode && lsLastStepAppended && lsLastGoodS > 0 && lsCh > 0) {
      // r56: 校准后从 60% 目标起步、每步 ×1.25 渐进到 100%——探针 120px 小跳后直接接
      // 3~4 倍大步，起步速度突变观感明显（0.65 目标下用户实测反馈"不是平滑的速度"）。
      let target = lsAutoTargetFrac * lsCh;
      let next;
      if (lsAutoCalib) {
        // 方案A 首格校准：由探针实测位移反推该 App 滚轮系数(px/单位)，直接设定 delta 使下一格命中 target，
        // 序贯计算比 r31 比例闭环首轮更快收敛（避免 fixed 首格在 App 系数差异大时反复震荡几步）。
        const coef = lsLastGoodS / Math.abs(lsAutoProbe);
        lsAutoRampScale = 0.6;
        next = Math.round(target * lsAutoRampScale / (coef || 1));
        lsAutoCalib = false;
        if (lsDiagDue()) console.error(`[LS] calib coef=${coef.toFixed(3)}px/unit target=${target.toFixed(0)} -> delta=${-next}`);
      } else {
        // 原 r31 比例闭环。r50 收紧：Chromium 平滑滚动的 delta→位移非线性（-24→120、-60→420），
        // 裸乘法比例在 120↔420 间来回震荡（3.7-A 会话B 跳变 3.5× → 重叠忽大忽小 → 内容重复囤积）。
        // clamp 单步比例到 [0.8, 1.5]，每次只微调、逐步收敛锁单一基线，避免 delta 骤降/陡升。
        if (lsAutoRampScale > 0 && lsAutoRampScale < 1) lsAutoRampScale = Math.min(1, lsAutoRampScale * 1.25);
        target *= lsAutoRampScale;
        const ratio = Math.min(1.5, Math.max(0.8, target / lsLastGoodS));
        next = Math.round(Math.abs(lsAutoDelta) * ratio);
      }
      lsAutoDelta = -Math.min(260, Math.max(18, next));
      if (lsDiagDue()) console.error(`[LS] auto-delta s=${lsLastGoodS.toFixed(0)} target=${target.toFixed(0)} -> delta=${lsAutoDelta}`);
    }
    await new Promise((r) => setTimeout(r, LS_AUTO_STEP_GAP_MS)); // 节奏：感知速度 = 格位移/(动画+gap)
  }
  console.error('[LS] auto-step loop exit');
}

/** 静止检测：每 100ms 抓 GDI 小图灰度，连续 3 次 diff<=0.05 判静止（r24 收紧）。
 *  r47 曾提速 60ms 轮询致软帧（sharp-gate 重试耗尽仍软），r48 回退 100ms。
 *  GDI 对静止画面 diff 精确 0.0，任何微动都非零。
 *  r50 曾把阈值收到 0.02+连续 4 次+settle 100ms → 含轻微持续动画的页面几乎永不判静止，
 *  每步吃满 2500ms 超时，实测单步 9.7s（极慢）。r50b 回退原值恢复速度——静止判定宽松一点
 *  造成的过早抓帧，改由下方 sharp-gate 兜底仲裁（见 r50b 改动），而不是卡住滚动节奏。 */
async function lsWaitQuiet(timeoutMs) {
  const t0 = Date.now();
  let quietStreak = 0;
  let prev = null;
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 100));
    let gray = null;
    try {
      const dpr = window.devicePixelRatio || 1;
      const gres = await ipcRenderer.invoke('capture-longshot-gdi', { gx: Math.round(selX * dpr), gy: Math.round(selY * dpr), gw: Math.round(selW * dpr), gh: Math.round(selH * dpr) });
      if (gres && gres.buf && gres.w > 0) gray = lsGdiGray(gres);
    } catch (_) { }
    if (gray) {
      if (prev && prev.length === gray.length) {
        let acc = 0; let n = 0;
        for (let i = 0; i < gray.length; i += 3) { acc += Math.abs(gray[i] - prev[i]); n++; }
        const diff = n ? acc / n : 999;
        if (diff <= 0.05) { quietStreak++; if (quietStreak >= 3) { await new Promise((r) => setTimeout(r, 60)); return true; } } else quietStreak = 0;
      }
      prev = gray;
    }
  }
  return false;
}

/** r51: 发轮后等「画面真的动起来」。返回 true=已检测到滚动；false=超时无任何运动
 *  （滚轮被目标窗口吞掉，或页面已滚动到底）。采样与 lsWaitQuiet 同源（GDI 全分辨率选区、
 *  100ms 轮询、1/3 像素步进灰度差），阈值同探针 changed（>0.5）：真滚动哪怕几像素也远超此值，
 *  被吞的滚轮画面 diff 实测恒 0.00（15:47 会话第 2 格静帧 fdiff=0.00）——二者不会混淆。 */
async function lsWaitMotion(timeoutMs) {
  const t0 = Date.now();
  const dpr = window.devicePixelRatio || 1;
  let prev = null;
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 100));
    let gray = null;
    try {
      const gres = await ipcRenderer.invoke('capture-longshot-gdi', { gx: Math.round(selX * dpr), gy: Math.round(selY * dpr), gw: Math.round(selW * dpr), gh: Math.round(selH * dpr) });
      if (gres && gres.buf && gres.w > 0) gray = lsGdiGray(gres);
    } catch (_) { }
    if (gray && prev && prev.length === gray.length) {
      let acc = 0; let n = 0;
      for (let i = 0; i < gray.length; i += 3) { acc += Math.abs(gray[i] - prev[i]); n++; }
      if (n && acc / n > 0.5) return true;
    }
    if (gray) prev = gray;
  }
  return false;
}

function clearLongShotHole() {
  bgCtx.clearRect(0, 0, W, H);
}

function setRecordMouseIgnore(ignore) {
  console.error(`[REC] ignoreMouse -> ${ignore}`);
  try { ipcRenderer.send('capture-record-ignore-mouse', ignore === true); } catch (err) { console.error('[REC] ignoreMouse send failed', err); }
}

let recordMouseIgnored = false;

document.addEventListener('mousemove', (e) => {
  if (!isRecording) return;
  const overUi = !!(e.target && e.target.closest && e.target.closest('#recBar'));
  const inside = !overUi
    && e.clientX >= selX && e.clientX <= selX + selW
    && e.clientY >= selY && e.clientY <= selY + selH;
  if (inside !== recordMouseIgnored) {
    recordMouseIgnored = inside;
    setRecordMouseIgnore(inside);
  }
});

ipcRenderer.on('capture-ls-finish', (_event, save) => stopLongScreenshot(save !== false));

function lsOnKeyDown(e) {
  if (!longShotActive) return;
  if (textEditor && document.activeElement === textEditor) return;
  if (e.key === 'Escape') { e.preventDefault(); stopLongScreenshot(false); }
  else if (e.key === 'Enter') { e.preventDefault(); stopLongScreenshot(true); }
}
function lsAttachKeyDown() {
  document.removeEventListener('keydown', lsOnKeyDown, true);
  document.addEventListener('keydown', lsOnKeyDown, true);
}
function lsDetachKeyDown() {
  document.removeEventListener('keydown', lsOnKeyDown, true);
}

/** 调试转储：把被拒帧落盘（temp/xiyue-ls-debug/），离线肉眼取证帧内容异常 */
function lsDebugDump(frame, tag) {
  try {
    if (lsDebugDumps >= 24 || !frame || !frame.toDataURL) return;
    lsDebugDumps++;
    console.error(`[LS] dump#${lsDebugDumps} ${lsMatchSrc || 'acc'}_${tag} ${frame.width}x${frame.height} t=${Date.now() - lsStartT}ms`);
    ipcRenderer.send('capture-ls-debug', { name: `ls_${lsStartT}_${lsDebugDumps}_${lsMatchSrc || 'acc'}_${tag}.png`, dataURL: frame.toDataURL('image/png') });
  } catch (_) {}
}

/* 滚动量匹配（帧顶 ↔ 累加图尾对齐，只向下）：复用旧逻辑，消费裁剪后的选区帧 canvas */
let lsFrameIsGdi = false; // 当前帧是否来自 GDI（像素精确）→ 匹配器跳过视频帧时代的 not-sharp 门槛
let lsMatchSrc = '';      // 当前匹配来源标记（''=accum / 'prev'=救援），dump 取证用
let lsFrameDiffAccum = 0; // accum 匹配路径的帧间灰度差（救援二次调用会把 lsLastFrameDiff 覆盖为 0，不能用于活跃判定）
let lsRejectStreak = 0;   // 连续拒帧计数：>=2 转入 best-guess 接受最似谷（宁错位不丢内容）
let lsLastGoodS = 0;      // 最近一次成功匹配的单帧位移（速度连续性先验：等高周期内容多假谷时优先接近它的谷）
let lsAcceptCount = 0;    // 成功匹配计数：前 2 次用种子级宽松门槛，避免首帧大跳因重叠不足永远接不上
let lsRecIdx = 0;         // 全帧录制计数（离线回放迭代匹配算法用）
let lsRecLog = [];        // 接受的匹配记录 [{i,t,s}]（回放时作对齐参照）
// GDI/koffi 预热：截图窗加载即完成主进程 DLL 懒加载，进入长截图首拍不再卡（约几十 ms 的 koffi.load 开销）
try { ipcRenderer.invoke('capture-longshot-gdi', { gx: 0, gy: 0, gw: 8, gh: 8 }).catch(() => {}); } catch (_) { }
let lsPageShift = 0;      // 帧相对 seed 的累计页下移（accum 匹配成功时精确重锚，救援模式增量累加）
let lsLastMatchRatio = 1; // 最近一次匹配的谷深比值（救援接受判定用）
let lsSharpBase = 0;      // r26 清晰度静止基准（lap_var EMA，闸门 = <0.6×base 判虚帧）
// r31 自适应步进：滚轮 delta 经目标 App 平滑滚动放大，与像素不线性，无法命令"精确像素位移"。
// 但匹配器每步都实测出真实位移 s（lsLastGoodS），用它对 delta 做闭环反馈，使每格位移收敛到
// 目标比例*帧高 —— 即"按像素格数移动"的工程等价实现：重叠恒足→不拒拼、不浪费小步→更快且清晰。
let lsAutoDelta = -60;        // 当前滚轮 delta（自适应调）
let lsAutoTargetFrac = 0.35;  // 目标每格位移 = 0.35*帧高 → 重叠 65%（r58 从 0.5 收紧：
                              // 实测页面瞬时滚动速度有波动，0.5 步长下单步可冲到 0.8+ 帧高
                              // → 重叠 <12% 被拒 → 整段内容跳过错拼；65% 重叠给波动留足余量）
let lsLastStepAppended = false; // 上一步是否真正追加了行（用于自适应反馈是否采纳）
let lsAutoProbe = -24;        // 方案A 首格探针滚轮量：小位移保证首格必然可接（重叠大、无过冲）
let lsAutoCalib = false;      // 方案A 校准态：首个已追加步据探针实测位移反推正式 delta，取代固定 -60
let lsAutoRampScale = 0;      // r56: 校准后的步长渐进系数（0.6 → ×1.25/步 → 1.0）；0=未校准无渐进
let lsAutoSnapMode = false;   // r57: 吸附式滚动模式——页面按卡点固定步进，位移与滚轮量解耦
let lsAutoMultiWheel = 1;     // r57: 吸附模式下每步注入的滚轮次数（1~4，按实测/目标自适应）
let lsAutoSnapStreak = 0;     // r57: 连续「位移 < 一半目标」计数（连续 2 次且已拼 3 格才判吸附）
let lsPrevLockS = 0;          // r59: 上一格位移（周期锁死检测用：连续 2 步几乎相同且大步 → 重置）
function lsMatchScroll(frame, refCanvas) {
  if (!lsAccum) return 0;
  const ref = refCanvas || lsAccum; // 参考帧：默认累加图底部；救援模式传 lsPrev（新鲜参考）
  const w = frame.width;
  const fh = frame.height;
  const ah = ref.height;
  if (fh < 24 || ah < fh || ref.width !== w) return 0;
  const fctx = frame.getContext('2d', { willReadFrequently: true });
  const actx = ref.getContext('2d', { willReadFrequently: true });
  const stepX = Math.max(1, Math.floor(w / 160));
  const colCount = Math.floor((w - 1) / stepX) + 1;
  const fData = fctx.getImageData(0, 0, w, fh).data;
  const gf = new Float32Array(fh * colCount);
  for (let r = 0; r < fh; r++) {
    const base = r * w;
    for (let ci = 0, x = 0; ci < colCount; ci++, x += stepX) {
      const i = (base + x) * 4;
      gf[r * colCount + ci] = (fData[i] * 114 + fData[i + 1] * 587 + fData[i + 2] * 299) / 1000;
    }
  }
  const nowDiag = Date.now();
  lsLastFrameDiff = 0;
  if (lsPrevGray && lsPrevGray.length === gf.length) {
    let acc = 0;
    const stride = 7;
    let n = 0;
    for (let i = 0; i < gf.length; i += stride) { acc += Math.abs(gf[i] - lsPrevGray[i]); n++; }
    lsLastFrameDiff = n ? acc / n : 0;
    if (!refCanvas) lsFrameDiffAccum = lsLastFrameDiff; // 救援调用时 lsPrevGray 已是本帧、diff 恒 0，不覆盖
    if (nowDiag - lsLiveLast > 1000) {
      lsLiveLast = nowDiag;
      console.error(`[LS] diag live frameDiff=${lsLastFrameDiff.toFixed(2)} t=${nowDiag - lsStartT}ms`);
    }
  }
  // r26: 主路径（ref=accum）时先快照上一帧灰度——下方 set(gf) 会把它覆盖成本帧，帧-帧副链要用
  const pg = (!refCanvas && lsPrevGray && lsPrevGray.length === gf.length) ? Float32Array.from(lsPrevGray) : null;
  if (lsPrevGray && lsPrevGray.length === gf.length) lsPrevGray.set(gf);
  else lsPrevGray = Float32Array.from(gf);
  const aData = actx.getImageData(0, ah - fh, w, fh).data;
  const ga = new Float32Array(fh * colCount);
  for (let r = 0; r < fh; r++) {
    const base = r * w;
    for (let ci = 0, x = 0; ci < colCount; ci++, x += stepX) {
      const i = (base + x) * 4;
      ga[r * colCount + ci] = (aData[i] * 114 + aData[i + 1] * 587 + aData[i + 2] * 299) / 1000;
    }
  }
  const S_MAX = fh - 8;
  // r52 行纹理度：每行灰度方差。方差 <64（σ<8 灰阶）= 纯背景行，不构成位移证据。
  // 实测深色聊天窗（会话 1788946273508）：假位移 488 的重叠仅 31 行且全为纯背景，
  // 平均 SSD err=0 完美夺魁（真位移 260 重叠 259 行带文字，err 反而数千）——
  // min-err 目标被"小而纯"的条带欺骗。ShareX ScrollingCaptureManager 同课：
  // 它按"逐行字节全等的最长连击"评分，证据数量决定胜负，背景条带的连击天然短于真重叠。
  // 等价实现：粗搜 evalS 与仲裁 evalR 都只在有纹理行上计分，有效纹理行不足的偏移直接 Infinity。
  // 注意候选生成也必须加权——否则真位移根本进不了候选（实测 f4→f5 真值 135 因粗搜未加权漏选）。
  const stepR = 4;
  const colsR = Math.floor((w - 1) / stepR) + 1;
  const gfR = new Float32Array(fh * colsR);
  for (let r = 0; r < fh; r++) {
    const base = r * w;
    for (let ci = 0, x = 0; ci < colsR; ci++, x += stepR) {
      const i = (base + x) * 4;
      gfR[r * colsR + ci] = (fData[i] * 114 + fData[i + 1] * 587 + fData[i + 2] * 299) / 1000;
    }
  }
  const gaR = new Float32Array(fh * colsR);
  for (let r = 0; r < fh; r++) {
    const base = r * w;
    for (let ci = 0, x = 0; ci < colsR; ci++, x += stepR) {
      const i = (base + x) * 4;
      gaR[r * colsR + ci] = (aData[i] * 114 + aData[i + 1] * 587 + aData[i + 2] * 299) / 1000;
    }
  }
  const gaRowInf = new Uint8Array(fh);
  let gaInfTotal = 0;
  for (let r = 0; r < fh; r++) {
    const gi = r * colsR;
    let sum = 0, sum2 = 0;
    for (let ci = 0; ci < colsR; ci++) { const v = gaR[gi + ci]; sum += v; sum2 += v * v; }
    const mean = sum / colsR;
    const inf = (sum2 / colsR - mean * mean) >= 64 ? 1 : 0;
    gaRowInf[r] = inf;
    gaInfTotal += inf;
  }
  // r59: 纹理行"多样性"——重复小元素（头像/图标/分隔条行）行均值几乎相同，行间多样性≈0，
  // 这类伪纹理在任何周期位移上都能凑出 ≥10 行的低误差重叠（23:10 会话：585px 假谷仅
  // 23 行重复头像行，err=451 夺魁，真谷 140 的 500+ 多样行被无视 → 内容周期性重复+跳段）。
  // 多样性 = 重叠区内相邻**有纹理**行的行均值差；低于阈值的对不计入证据行数。
  const gaRowMean = new Float32Array(fh);
  for (let r = 0; r < fh; r++) {
    let s = 0;
    const gi = r * colsR;
    for (let ci = 0; ci < colsR; ci++) s += gaR[gi + ci];
    gaRowMean[r] = s / colsR;
  }
  const evalS = (s) => {
    const rows = fh - s;
    if (rows < 8) return Infinity;
    let err = 0, n = 0;
    for (let r = 0; r < rows; r++) {
      if (!gaRowInf[s + r]) continue; // 纯背景行对任何位移都"全等"，不计分不掩盖证据稀缺
      const gi = (s + r) * colCount;
      const fi = r * colCount;
      for (let ci = 0; ci < colCount; ci++) {
        const d = gf[fi + ci] - ga[gi + ci];
        err += d * d;
      }
      n++;
    }
    // r59: 证据门槛 10→25——重复小元素（头像/图标行）在周期位移上能凑出 10~24 行
    // "看似有效"的重叠（23:10 会话假谷 585 仅 23 行重复头像行，err=451 夺魁，真谷 140
    // 有 124 行）。25 行 ≈ 帧高 5% 的实质内容重叠，真实滚动步长（≥0.35 帧高）下
    // 真谷的重叠纹理行远超此值（实测 87~152 行）。
    if (n < 25) return Infinity;
    return err / (n * colCount);
  };
  // r52: 参考图底部整体无证据（<10 纹理行）→ 无从判断任何位移，按静止跳过不计拒链
  // （与 static-gdi 同语义：纯背景内容的滚动在像素层面本就不可检测）
  if (gaInfTotal < 10) {
    if (lsDiagDue()) console.error(`[LS] diag no-evidence ref infRows=${gaInfTotal} t=${Date.now() - lsStartT}ms (参考区纯背景，跳过匹配)`);
    lsRejectStreak = 0;
    return 0;
  }
  const e0 = evalS(0);
  if (e0 < 0.3) {
    if (lsDiagDue()) console.error(`[LS] diag static e0=${e0.toFixed(2)} t=${Date.now() - lsStartT}ms (帧未变化/页面未滚动)`);
    if (lsLastFrameDiff > 3) lsDebugDump(frame, 'static_but_changed');
    lsRejectStreak = 0; // 静止不是拒链
    return 0;
  }
  // r28: GDI 帧静止判据——0.3 是视频帧时代遗产，GDI 同内容重抓 e0 实测 87~1061（噪声地板）。
  // 静止帧漏过此闸 → 粗搜在静止内容上找假谷（实测 bestSB=46/288）→ fine_miss 拒帧污染拒链
  // → guessMode 连锁错拼/断档（矮选区会话 1788757841115 拒 7/9 的直接根因）。
  // 双条件：帧间 diff 极小（步进制保证 prev 是静止帧）+ e0 低于滚动帧量级（滚动帧 e0≈4958+）。
  if (lsFrameIsGdi && e0 < 2500 && lsLastFrameDiff <= 0.5) {
    if (lsDiagDue()) console.error(`[LS] diag static-gdi e0=${Math.round(e0)} fdiff=${lsLastFrameDiff.toFixed(2)} t=${Date.now() - lsStartT}ms (GDI 静止帧跳过，不计拒链)`);
    lsRejectStreak = 0;
    return 0;
  }
  // r26 双证据链副链：用上一帧灰度 pg 独立做帧-帧匹配（与主链帧-accum 互不污染）。
  // 两链一致才接受；偏差 >5 行判错拼拒帧（宁可断档不错拼——实测单链 551 vs 帧-帧真值 422 错拼 129 行）。
  // pg 为 null（救援路径/首帧）或帧间静止（e0p<0.3，无独立证据）时不拦截。
  let pfCache = null;
  const crossCheck = (sMain) => {
    if (!pg) return { has: false };
    if (pfCache) return pfCache;
    // r52: 副链同样只信有纹理行——无加权的副链会被背景条带假谷骗过，经 cross-trust-pf
    // 覆盖正确的主链（17:31 会话 f6→f7：主链正确 50 被副链假谷 135 覆盖，实测复现）
    const pgRowInf = new Uint8Array(fh);
    let pgInfTotal = 0;
    for (let r = 0; r < fh; r++) {
      const gi = r * colCount;
      let sum = 0, sum2 = 0;
      for (let ci = 0; ci < colCount; ci++) { const v = pg[gi + ci]; sum += v; sum2 += v * v; }
      const mean = sum / colCount;
      pgRowInf[r] = (sum2 / colCount - mean * mean) >= 64 ? 1 : 0;
      pgInfTotal += pgRowInf[r];
    }
    const evalPf = (s) => {
      const rows = fh - s;
      if (rows < 8) return Infinity;
      let err = 0, n = 0;
      for (let r = 0; r < rows; r++) {
        if (!pgRowInf[s + r]) continue;
        const gi = (s + r) * colCount, fi = r * colCount;
        for (let ci = 0; ci < colCount; ci++) { const d = gf[fi + ci] - pg[gi + ci]; err += d * d; }
        n++;
      }
      if (n < 10) return Infinity;
      return err / (n * colCount);
    };
    if (pgInfTotal < 10) { pfCache = { has: false }; return pfCache; }
    const e0p = evalPf(0);
    if (e0p < 0.3) { pfCache = { has: false }; return pfCache; }
    const sn = Math.floor(S_MAX / 2) + 1;
    const verrs = new Float32Array(sn);
    for (let i = 0; i < sn; i++) verrs[i] = evalPf(i * 2);
    let vb = 0, ve = e0p;
    for (let i = 1; i < sn - 1; i++) {
      if (verrs[i] < verrs[i - 1] && verrs[i] <= verrs[i + 1] && verrs[i] < ve) { ve = verrs[i]; vb = i * 2; }
    }
    if (vb > 0) {
      const lo = Math.max(0, vb - 3), hi = Math.min(S_MAX, vb + 3);
      for (let s2 = lo; s2 <= hi; s2++) { const e = evalPf(s2); if (e < ve) { ve = e; vb = s2; } }
    }
    pfCache = { has: vb > 0 && ve < e0p, sPf: vb, ve, e0p }; // r37: 暴露副链误差与帧-帧 e0 供终审判别副链是否强对齐
    return pfCache;
  };
  // r25: 粗搜废弃 BIN=4 分箱——4px 行平均在复杂/周期页面会抹平真谷（实测 f2 真谷 446 err=2859
  // 在 binned 空间没进 top-4 谷，被 29 假谷 err=2897 反超接受 → 错拼）。改全分辨率 evalS 步长 2px
  // 直接扫描（~310 次 × 52K ops ≈ 20-50ms，步进制下每格仅一次匹配，开销可接受），谷检测后 top-4 细搜。
  const scanN = Math.floor(S_MAX / 2) + 1;
  const errsS = new Float32Array(scanN);
  for (let i = 0; i < scanN; i++) errsS[i] = evalS(i * 2);
  const valleys = [];
  for (let i = 1; i < scanN - 1; i++) { if (errsS[i] < errsS[i - 1] && errsS[i] <= errsS[i + 1]) valleys.push({ s: i * 2, e: errsS[i] }); }
  if (!valleys.length) valleys.push({ s: 0, e: errsS[0] });
  valleys.sort((a, b) => a.e - b.e);
  const bestSB = valleys[0].s;
  const minErrB = valleys[0].e;
  const cands = [];
  // r52: 精搜扩展到全部局部谷（cap 48，按粗搜深度排序截断）。
  // top-4/8 的教训：窄真谷在 2px 粗网格上深度严重失真——真位移 135 谷底 err=68，
  // 网格 ±2px 采样即 929，按采样深度排不进 top-N → 精搜永远到不了真位移，
  // 候选里只剩内容重复的宽假谷（17:31 会话 f4→f5 实测）。谷实测 20~39 个，
  // 全部精搜 + evalR 复核 ≈ 额外 10ms，步进制下每格仅一次匹配，开销可接受。
  const valleyCands = valleys.length > 48 ? valleys.slice(0, 48) : valleys;
  for (const v of valleyCands) {
    const lo = Math.max(0, v.s - 3);
    const hi = Math.min(S_MAX, v.s + 3);
    let bs = -1, be = Infinity;
    for (let s = lo; s <= hi; s++) { const e = evalS(s); if (e < be) { be = e; bs = s; } }
    if (bs > 0 && be < e0) cands.push({ s: bs, e: be });
  }
  // 速度先验兜底：周期内容远假谷误差可能比近真谷更低，必须显式把“最接近上次位移”的谷纳入候选，否则 bestS 锁错周期
  if (lsLastGoodS > 8 && valleys.length) {
    let nb = valleys[0], bestd = Infinity;
    for (const v of valleys) { const d = Math.abs(v.s - lsLastGoodS); if (d < bestd) { bestd = d; nb = v; } }
    const lo = Math.max(0, nb.s - 3), hi = Math.min(S_MAX, nb.s + 3);
    let nbs = -1, nbe = Infinity;
    for (let s = lo; s <= hi; s++) { const e = evalS(s); if (e < nbe) { nbe = e; nbs = s; } }
    if (nbs > 0 && nbe < e0 && !cands.some((c) => Math.abs(c.s - nbs) <= 2)) cands.push({ s: nbs, e: nbe });
  }
  let bestS = 0;
  let minErr = e0;
  // r26b/c 高密度复核（stepX=4）：主链 stepX≈w/160 的列采样在浅误差曲线（帧间内容变化/亚像素残留）上
  // 会翻转真假谷（实测真实帧 stepX=9 下伪谷 68 err=3710 反超真谷 422 err=3759，而 stepX=4/全精度均
  // 正确给出 422）。evalR 提升到函数级：候选重排与 crossCheck 仲裁共用。
  // （r52: gfR/gaR/gaRowInf 已上移到 evalS 之前共用——粗搜与仲裁必须同一套加权口径）
  const evalR = (s) => {
    const rows = fh - s;
    if (rows < 8) return Infinity;
    let err = 0, n = 0;
    for (let r = 0; r < rows; r++) {
      if (!gaRowInf[s + r]) continue; // 纯背景行对任何位移都"全等"，计分只会稀释证据、误导仲裁
      const gi = (s + r) * colsR, fi = r * colsR;
      for (let ci = 0; ci < colsR; ci++) { const d = gfR[fi + ci] - gaR[gi + ci]; err += d * d; }
      n++;
    }
    // r59: 与 evalS 同口径（证据门槛 10→25，防重复小元素伪谷）
    if (n < 25) return Infinity;
    return err / (n * colsR);
  };
  // r28: 交叉验证仲裁必须带速度先验——周期内容（聊天列表等距消息）半周期位移的裸 evalR
  // 可能更低（实测主链真值 202 eR=2705 被副链伪谷 99 eR=2166 否决 = 正确帧被拒）。
  // 与 cands 的 eff 评分同式：偏离上次位移越远罚得越重。
  const effR = (s) => evalR(s) * (1 + 0.2 * Math.min(1.5, Math.abs(s - lsLastGoodS) / 50));
  if (cands.length) {
    for (const c of cands) c.eR = evalR(c.s);
    // r52: eR=Infinity（有效纹理行不足）的候选不参与胜出——那是背景条带假谷，不是证据
    const viable = cands.filter((c) => c.eR < Infinity);
    // r38 seeding 偏好：首 1-2 格无速度基准，周期内容(聊天/列表/代码块)易锁到等于内容周期的假谷，
    // 导致过小位移(重叠>70%→顶部重复)或过大位移(重叠<20%→匹配不稳定)。
    // 在候选排序中加入向 0.5×帧高的软偏好(系数 0.8)，既防假谷错拼，又不过分压制真强谷。
    const isSeedingNow = lsAcceptCount < 2 && lsLastGoodS < 200;
    for (const c of viable) {
      if (isSeedingNow) {
        c.eff = c.eR * (1 + 0.8 * Math.abs(c.s - fh * lsAutoTargetFrac) / fh);
      } else {
        // 速度连续性先验：等高列表行等周期内容会产生多个误差接近的假谷，
        // 单帧位移不会突变 → 有效误差 = err * (1 + 0.2*min(1.5, |s-上次位移|/50))，弱惩罚不压制真强谷
        c.eff = c.eR * (1 + 0.2 * Math.min(1.5, Math.abs(c.s - lsLastGoodS) / 50));
      }
    }
    viable.sort((a, b) => a.eff - b.eff);
    if (viable.length) {
      bestS = viable[0].s; minErr = viable[0].e;
    }
  }
  if (bestS === 0) {
    lsRejectStreak++;
    // fine-miss 的 best-guess 兜底：连拒 2 次后，粗搜最佳谷附近精搜直接采用（宁轻微错位不持续丢帧，后续精确 match 重锚）
    if (lsRejectStreak >= 2 && bestSB > 0) {
      const glo = Math.max(1, bestSB - 4), ghi = Math.min(S_MAX, bestSB + 4);
      let gbs = -1, gbe = Infinity;
      for (let s2 = glo; s2 <= ghi; s2++) { const e = evalS(s2); if (e < gbe) { gbe = e; gbs = s2; } }
      if (gbs > 0 && gbe < e0 * 0.95) {
        // r52: best-guess 证据校验（粗搜已加权，此处兜底精搜窗口边缘纹理行不足的情形）
        let infRows = 0;
        for (let r = 0; r < fh - gbs; r++) { if (gaRowInf[gbs + r]) infRows++; }
        if (infRows < 10) {
          if (lsDiagDue()) console.error(`[LS] best-guess no-evidence gbs=${gbs} infRows=${infRows} (reject)`);
          lsRejectStreak++; lsDebugDump(frame, 'guess_no_evidence'); return 0;
        }
        // 速度连续性：周期假谷会锁到远离真实位移的谷，偏离过大且非深谷判为假谷（防 best-guess 锁错周期错拼）
        // velBound 0.5×last：周期 P=42 时假谷偏离 42px，可拒；真实滚动 50% 变速仍可容。
        if (lsLastGoodS > 8 && lsAcceptCount >= 2) {
          const velBound = Math.max(20, lsLastGoodS * 0.5);
          if (Math.abs(gbs - lsLastGoodS) > velBound && gbe >= e0 * 0.45) {
            if (lsDiagDue()) console.error(`[LS] best-guess fine-miss vel-inconsist gbs=${gbs} lastGood=${lsLastGoodS} (reject)`);
            lsRejectStreak++; lsDebugDump(frame, 'vel_inconsist_guess'); return 0;
          }
        }
        const ccG = crossCheck(gbs);
        if (ccG.has && Math.abs(gbs - ccG.sPf) > 5) {
          if (effR(gbs) > effR(ccG.sPf)) {
            if (lsDiagDue()) console.error(`[LS] cross-mismatch(guess) gbs=${gbs} sPf=${ccG.sPf} (副链质疑且速度加权终审败，拒防错拼)`);
            lsRejectStreak++; lsDebugDump(frame, 'cross_mismatch'); return 0;
          }
          if (lsDiagDue()) console.error(`[LS] cross-disagree-dense-wins(guess) gbs=${gbs} sPf=${ccG.sPf}`);
        }
        if (lsDiagDue()) console.error(`[LS] best-guess fine-miss s=${gbs} err=${Math.round(gbe)} e0=${Math.round(e0)} streak=${lsRejectStreak}`);
        lsRejectStreak = 0;
        lsLastMatchRatio = e0 > 0 ? gbe / e0 : 1;
        lsLastGoodS = gbs; lsAcceptCount++;
        return gbs;
      }
    }
    const missHint = (e0 > 200 && bestSB === 0) ? ' 疑似单次滚动超量程(采样间隔内位移过大)' : '';
    if (lsDiagDue()) console.error(`[LS] diag fine-miss e0=${Math.round(e0)} bestSB=${bestSB} minErrB=${Math.round(minErrB)} (粗搜未锁定谷底)${missHint}`);
    lsDebugDump(frame, 'fine_miss');
    return 0;
  }
  const ratio = e0 > 0 ? minErr / e0 : 1;
  const guessMode = lsRejectStreak >= 2; // 连续拒帧 2 次即 best-guess（ShareX 黄色状态同款）：80ms 节拍下 4 次拒帧=320ms 内容断层风险，宁轻微错位不丢内容，后续精确 match 重锚修复
  if (guessMode && lsDiagDue()) console.error(`[LS] best-guess mode s=${bestS} minErr=${Math.round(minErr)} e0=${Math.round(e0)} streak=${lsRejectStreak}`);
  // r20 速度边界：0.5×last 可拒周期假谷（偏离≈周期 P），20px 下限保小滚动。
  // r37 收紧 seed：首格无基准需宽松，但一旦已有可信位移(lastGoodS≥200，强谷对齐)即退出 seed，
  // 启用速度先验——否则前 2 格都跳过速度先验，矮选区周期假谷(160)无法被纠正。
  const isSeeding = lsAcceptCount < 2 && lsLastGoodS < 200;
  let velBound = Infinity, isNear = true;
  if (lsLastGoodS > 8 && !isSeeding) {
    // r37 速度容差用相对基准 0.3×last：dwarf 160偏离243=83>73 拒周期假谷，会话B 452偏离600=148<180 接受真值
    velBound = Math.max(20, lsLastGoodS * 0.3);
    isNear = Math.abs(bestS - lsLastGoodS) <= velBound;
  }
  // r20 速度-aware ratioCap：近真谷放宽到 0.9（抗亚像素噪声），远谷深谷才收；种子级极宽松防首帧大跳接不上。
  let ratioCap;
  if (isSeeding) ratioCap = 0.99; // r26b: 0.98 会误杀复核重排找回的真谷（实测真实帧 ratio=0.984）
  else if (guessMode) ratioCap = 0.95;
  else if (!isNear) ratioCap = 0.55;
  else if (bestS <= 15) ratioCap = 0.98; // 小滚动抗锯齿：真谷 ratio 常近 1
  else ratioCap = 0.9;
  // guess 模式/种子也要最低门槛：err 接近 e0（ratio≈1）= 与随机对齐无区别的垃圾谷，接受必错拼
  if (minErr >= e0 * ratioCap) { lsRejectStreak++; if (lsDiagDue()) console.error(`[LS] diag reject not-better${guessMode ? '(guess)' : ''} s=${bestS} minErr=${Math.round(minErr)} e0=${Math.round(e0)} cap=${ratioCap.toFixed(2)}`); lsDebugDump(frame, 'not_better'); return 0; }
  const noiseCap = lsFrameIsGdi ? 8000 : 2000; // GDI 帧精确但亚像素滚动仍有重采样噪声（实测真谷 err~1456）
  if (!guessMode && minErr > noiseCap) { lsRejectStreak++; if (lsDiagDue()) console.error(`[LS] diag reject too-noisy s=${bestS} minErr=${Math.round(minErr)}`); lsDebugDump(frame, 'too_noisy'); return 0; }
  if (bestS >= S_MAX - 2) { lsRejectStreak++; if (lsDiagDue()) console.error(`[LS] diag reject boundary s=${bestS} S_MAX=${S_MAX} (单次滚动接近整帧高，缩短 tick 可解)`); return 0; }
  const overlapRows = fh - bestS;
  // r20 重叠下限：种子/强匹配用 fh*3%（r25 从 6% 放宽——实测一格滚 595px/帧高 629 重叠仅 34 行被 37 行下限拒掉导致零拼接；
  // delta 已改 -40 从源头保证重叠，此下限只作最后防线），普通匹配仍用自适应 60 行防周期弱谷。
  // 方案B 普通下限放宽：比例 0.35→0.22 且硬顶 60→48 行——矮选区(如 fh=540)不再被固定 60 行(=11%)卡成断档，
  // 合理的大位移(重叠偏小)可接受；高帧仍由 48 行硬顶保护不过度要求重叠。
  const isStrong = minErr < e0 * 0.45;
  // r39 回退方案B：恢复 r38 的 60 行防周期假谷下限（min(60, 35%)）。方案B 放宽到 22%/48 实测在
  // 周期内容(IDE聊天等)上会让跨周期强伪谷(如 s=66/180)以过大重叠被收进来=重复带，故还原收紧。
  const normalMinOverlap = Math.max(8, Math.min(60, Math.floor(fh * 0.35)));
  const strongMinOverlap = Math.max(8, Math.floor(fh * 0.03));
  const minOverlap = isSeeding ? strongMinOverlap : (isStrong ? strongMinOverlap : normalMinOverlap);
  if (overlapRows < minOverlap) { lsRejectStreak++; if (lsDiagDue()) console.error(`[LS] diag reject tiny-overlap s=${bestS} rows=${overlapRows} need=${minOverlap} strong=${isStrong} seed=${isSeeding} (重叠不足不可靠，交 prev 桥接)`); return 0; }
  // r25 防静止页污染：自动步进一格滚 ~200 物理 px，真实位移不可能 <15。bestS<15 说明这格滚轮没生效
  // （鼠标停在控制条上/目标忽略小 delta/已滚到底），帧与 accum 底部几乎相同——接受会叠加重复行
  // （实测 s=13 污染 accum 后整图错乱）。跳过累加、不计拒绝，循环下一格继续滚。
  if (lsAutoScrollActive && bestS < 15) {
    if (lsDiagDue()) console.error(`[LS] auto-step skip no-motion s=${bestS} (滚动未生效，防重复行)`);
    return 0;
  }
  // 重叠行少时相邻位移误差差异天然小 → 谷尖锐门槛按重叠量放宽
  const sharpK = overlapRows < 100 ? 0.85 : 0.5;
  const eBefore = evalS(bestS - 1);
  const eAfter = evalS(bestS + 1);
  // GDI 帧像素级精确：not-sharp 门槛是视频压缩帧时代的遗产，会误杀周期/平坦误差曲线上的真谷（等高列表行对齐误差天然平缓）→ GDI 全程跳过
  const skipSharp = lsFrameIsGdi;
  if (!skipSharp && !guessMode && eBefore > 0 && minErr > eBefore * sharpK) { lsRejectStreak++; if (lsDiagDue()) console.error(`[LS] diag reject not-sharp(-1) s=${bestS} minErr=${Math.round(minErr)} eBefore=${Math.round(eBefore)}`); lsDebugDump(frame, 'not_sharp_m1'); return 0; }
  if (!skipSharp && !guessMode && eAfter > 0 && minErr > eAfter * sharpK) { lsRejectStreak++; if (lsDiagDue()) console.error(`[LS] diag reject not-sharp(+1) s=${bestS} minErr=${Math.round(minErr)} eAfter=${Math.round(eAfter)}`); lsDebugDump(frame, 'not_sharp_p1'); return 0; }
  // 速度连续性闸门：相邻真实帧位移不会突变（45ms 节拍内≈恒定）。周期内容生成多个等深假谷，
  // 仅靠误差无法区分真假 → 用速度先验强约束：偏离 lsLastGoodS 过远且非深谷即判为假谷（防 best-guess 锁错周期错拼）。
  // 深谷（ratio<0.45）例外放行：真实快滚/追帧对齐质量高，与周期假谷（ratio~0.75）可区分。
  if (lsLastGoodS > 8 && !isSeeding) {
    if (!isNear && (guessMode || minErr >= e0 * 0.45 || (fh < 800 && minErr < e0 * 0.1))) {
      // r37 矮选区(帧矮)周期内容：主链锁到周期假谷(160)使速度先验偏差大。硬拒会让 accum 落后→
      // 后续重叠耗尽死循环(漏帧)。改为在候选中找"速度一致"(|s-lastGood|≤velBound)的谷采用——它即真位移；
      // 无则采用匀速预测(上次位移)。仅矮选区(fh<800)启用，高选区保持硬拒防错拼。
      if (!guessMode && fh < 800) {
        // 优先采用候选中"速度一致"(|s-lastGood|≤velBound)的谷——它是真位移(匀速)；
        // 无 alt：主链呈极强谷(ratio<0.1，假谷信号)才采用预测防漏帧，否则硬拒(保护 r26 变速真值不被错改)
        let alt = null;
        if (cands && cands.length) for (const c of cands) { if (c.eR === Infinity) continue; if (Math.abs(c.s - lsLastGoodS) <= velBound) { alt = c; break; } }
        if (alt) {
          if (lsDiagDue()) console.error(`[LS] vel-inconsist -> adopt ${alt.s} (alt) 矮选区防周期假谷/漏帧`);
          lsRejectStreak = 0; lsLastMatchRatio = 1; lsAcceptCount++;
          return alt.s;
        }
        // r52: 证据丰富的极强谷优先于速度预测。加权口径下"极强谷 + ≥20 纹理行"即真位移
        // （实测 f6→f7：真值 50 有 63 纹理行 err=14，却因偏离 lastGood=135 走到"强谷无 alt
        // → predict"被 135 覆盖 → 重拼 85px）。速度先验只对薄证据谷（10~19 行）继续防周期假谷。
        if (minErr < e0 * 0.1) {
          let infAtBest = 0;
          for (let r = 0; r < fh - bestS; r++) { if (gaRowInf[bestS + r]) infAtBest++; }
          if (infAtBest >= 20) {
            if (lsDiagDue()) console.error(`[LS] vel-inconsist -> trust evidence-rich valley s=${bestS} infRows=${infAtBest} (速度先验让位)`);
            lsRejectStreak = 0; lsLastMatchRatio = e0 > 0 ? minErr / e0 : 1;
            lsLastGoodS = bestS; lsAcceptCount++;
            return bestS;
          }
        }
        if (minErr < e0 * 0.1) {
          if (lsDiagDue()) console.error(`[LS] vel-inconsist -> adopt predict ${Math.round(lsLastGoodS)} (强谷无 alt) 防漏帧`);
          lsRejectStreak = 0; lsLastMatchRatio = 1; lsAcceptCount++;
          return Math.round(lsLastGoodS);
        }
        // 否则落入下方硬拒（原逻辑）
      }
      lsRejectStreak++;
      if (lsDiagDue()) console.error(`[LS] diag reject vel-inconsist s=${bestS} lastGood=${lsLastGoodS} bound=${velBound.toFixed(0)} minErr=${Math.round(minErr)} e0=${Math.round(e0)}${guessMode ? ' (guess)' : ''}`);
      lsDebugDump(frame, 'vel_inconsist');
      return 0;
    }
  }
  // r26 双证据链闸门：帧-accum 主链结论 bestS 必须与帧-帧副链 sPf 一致（±5 行容差：羽化/重锚系统性偏差）
  const ccM = crossCheck(bestS);
  if (ccM.has && Math.abs(bestS - ccM.sPf) > 5) {
    // r37 矮选区(帧矮/重叠小)周期内容：主链易锁到等于内容周期的假谷（实测 f0003 主链 160 假谷 err=9
    // 反超真谷 270 err=23，因 160 行内容周期性重复整段对齐）。副链=帧-帧相邻独立匹配，不依赖可能
    // 陈旧的 accum，对周期内容最不敏感 → 当两链显著分歧且副链自身强对齐(ve<0.5*e0p)时优先采信副链，
    // 根治"主链锁周期假谷→accum 错位累积→拼接不准"。
    const ccDev = Math.abs(bestS - ccM.sPf);
    // r37 矮选区(帧矮/重叠小)周期内容：主链易锁到等于内容周期的假谷（实测 f0003 主链 160 假谷
    // ratio=9/1909≈0.005，因 160 行内容周期性重复整段对齐，真对齐 err 绝不会这么低）。副链=帧-帧
    // 相邻独立匹配，不依赖可能陈旧的 accum，对周期内容最不敏感 → 当主链呈极强谷(ratio<0.1，假谷
    // 信号)且副链显著分歧时，前几格易错期优先采信副链，根治"主链锁周期假谷→accum 错位累积→拼接不准"。
    // 该条件不伤 r26 旧会话（其主链 ratio 正常、非矮选区周期假谷），不触发。
    // r40 副链采信必须通过位移先验一致性 + 重叠充足，否则不采信（防把正确主链覆盖成近整帧伪谷）。
    // 实测会话 1788844918914：帧1 真位移 365(r=目标 0.5*729)，主链正确 365，副链却锁到周期伪谷 704
    // (重叠仅25行) 被无条件采信 → 365 被覆盖成 704 → 作为 lsLastGoodS 毒化后续所有帧=大量重复/错拼。
    // 副链"帧-帧相邻"对周期内容并不免疫(等高行周期同样产生等深伪谷)，只有结果符合位移先验才可信：
    // 种子期先验≈0.5*帧高(步进目标)，已锚定期先验=lsLastGoodS(匀速)。重叠 <6% 帧高必为近整帧伪谷。
    const pfPrior = isSeeding ? fh * lsAutoTargetFrac : lsLastGoodS;
    const pfBound = isSeeding ? fh * 0.35 : Math.max(20, lsLastGoodS * 0.3);
    const pfOverlap = fh - ccM.sPf;
    const pfPriorOK = pfPrior > 0 && Math.abs(ccM.sPf - pfPrior) <= pfBound;
    const pfOverlapOK = pfOverlap >= Math.max(strongMinOverlap, Math.floor(fh * 0.06));
    if (ccM.has && ccDev > 12 && minErr < e0 * 0.1 && (isSeeding || lsAcceptCount < 3) && pfPriorOK && pfOverlapOK) {
      if (lsDiagDue()) console.error(`[LS] cross-trust-pf s=${bestS} -> pf=${ccM.sPf} dev=${Math.round(ccDev)} pfErr=${Math.round(ccM.ve)} (副链强对齐且符合位移先验，采信防周期假谷错拼)`);
      lsRejectStreak = 0;
      lsLastMatchRatio = ccM.e0p > 0 ? ccM.ve / ccM.e0p : 1;
      lsLastGoodS = ccM.sPf; lsAcceptCount++;
      return ccM.sPf;
    }
    // r26c 高密度仲裁：副链与主链同用主密度采样，自身也可能锁浅伪谷——不一致时以 stepX=4 终审，
    // 主链 bestS 高密度误差更低则放行（实测 E2E f1 真谷 422 eR=3767 < 伪谷 68 eR=3877）。
    if (effR(bestS) > effR(ccM.sPf)) {
      lsRejectStreak++;
      if (lsDiagDue()) console.error(`[LS] cross-mismatch s=${bestS} sPf=${ccM.sPf} effR(best)=${Math.round(effR(bestS))} effR(pf)=${Math.round(effR(ccM.sPf))} (副链质疑且速度加权终审败，拒防错拼)`);
      lsDebugDump(frame, 'cross_mismatch');
      return 0;
    }
    if (lsDiagDue()) console.error(`[LS] cross-disagree-dense-wins s=${bestS} sPf=${ccM.sPf} (副链质疑，高密度终审主链胜，放行)`);
  }
  // 三段一致性：重叠区垂直三等分各自算 err，部分对齐假谷（重复内容锁错周期）只会一段对上
  const segRows = Math.floor(overlapRows / 3);
  if (!guessMode && segRows >= 12) {
    const segErr = (rs, re) => {
      let err = 0;
      for (let r = rs; r < re; r++) {
        const gi = (bestS + r) * colCount, fi = r * colCount;
        for (let ci = 0; ci < colCount; ci++) { const d = gf[fi + ci] - ga[gi + ci]; err += d * d; }
      }
      return err / ((re - rs) * colCount);
    };
    const e1 = segErr(0, segRows), e2 = segErr(segRows, 2 * segRows), e3 = segErr(2 * segRows, 3 * segRows);
    const mx = Math.max(e1, e2, e3), mn = Math.min(e1, e2, e3);
    if (mx > 3 * mn + 50 && lsDiagDue()) console.error(`[LS] diag seg-warn s=${bestS} segs=${Math.round(e1)}/${Math.round(e2)}/${Math.round(e3)} (段间不齐，仅诊断不拒帧——真实内容变化会假阳性)`);
  }
  // r39 周期强谷防护：等高列表/聊天窗等"跨周期对齐"能得到低比值(isStrong, ratio<0.45)的伪谷，
  // 且通常落在偏离速度先验的位移上（真滚动匀速→每步位移≈恒定）。这类强伪谷会绕过上方速度闸门
  // （闸门只对非 strong 拒），实跑在 IDE 聊天上被任意位移(66/180/588/610)收进来=重复带/错位。
  // 处理：在粗搜候选中寻找"速度一致"(|c.s-lastGoodS|≤velBound)且误差不显著高于伪谷(≤1.5×)的真谷，
  // 找到则采信它修正错拼；找不到(无歧义强谷)则保留原结果、不额外干预——避免误伤真实强对齐。
  if (lsLastGoodS > 8 && !isSeeding && isStrong && !isNear && cands && cands.length) {
    const bound = velBound !== Infinity ? velBound : Math.max(20, lsLastGoodS * 0.3);
    let alt = null;
    for (const c of cands) {
      if (c.eR === Infinity) continue; // r52: 无证据（背景条带）候选不参与周期假谷纠偏
      if (Math.abs(c.s - lsLastGoodS) <= bound && c.e <= minErr * 1.5) { if (!alt || c.e < alt.e) alt = c; }
    }
    if (alt) {
      if (lsDiagDue()) console.error(`[LS] strong-off-vel -> adopt ${alt.s} (周期假谷纠偏, 领速度一致真谷, err ${Math.round(alt.e)} vs ${Math.round(minErr)})`);
      lsRejectStreak = 0;
      lsLastMatchRatio = e0 > 0 ? alt.e / e0 : 1;
      lsLastGoodS = alt.s; lsAcceptCount++;
      return alt.s;
    }
  }
  // r58: 近距离滑谷防护——浅内容+亚像素时，比真谷近 20~40px 的滑谷 err 可能更低且落在
  // 速度窗口内（22:46 会话 A：真值 175 被换成 140，35px 错位）。全谷候选里若存在与胜出谷
  // 距离 <60px 的强谷（err <= 3×minErr），取其中 err 最小者——谷间距离远小于步长时，
  // 两者必是同一对齐的相邻候选，择优而非择先。
  if (cands && cands.length > 1) {
    let near = null;
    for (const c of cands) {
      if (c.eR === Infinity) continue;
      if (Math.abs(c.s - bestS) > 0 && Math.abs(c.s - bestS) <= 60 && c.e <= minErr * 3) {
        if (!near || c.e < near.e) near = c;
      }
    }
    if (near && near.s !== bestS) {
      if (lsDiagDue()) console.error(`[LS] near-valley refine ${bestS} -> ${near.s} (err ${Math.round(near.e)} vs ${Math.round(minErr)})`);
      bestS = near.s; minErr = near.e;
    }
  }
  let sExact = bestS;
  const denom = eBefore + eAfter - 2 * minErr;
  if (eBefore > 0 && eAfter > 0 && denom > 1e-9) {
    const frac = Math.max(-0.5, Math.min(0.5, 0.5 * (eBefore - eAfter) / denom));
    sExact = bestS + frac;
  }
  lsRejectStreak = 0;
  lsLastMatchRatio = e0 > 0 ? minErr / e0 : 1;
  lsLastGoodS = bestS; lsAcceptCount++;
  console.error(`[LS] match s=${bestS}${sExact !== bestS ? ` (${sExact.toFixed(2)})` : ''} err=${Math.round(minErr)} e0=${Math.round(e0)} ratioCap=${ratioCap.toFixed(2)}`);
  return sExact;
}

/** 把新帧底部滚动新进入的内容追加到累加图（亚像素拼接 + 空白尾截断 + 接缝羽化+亮度增益） */
function lsAppendRows(frame, sExact) {
  if (!lsAccum || !(sExact > 0)) return;
  const w = frame.width;
  const fh = frame.height;
  const ah = lsAccum.height;
  let srcY = fh - sExact;
  try {
    const bandTopI = Math.max(0, Math.floor(srcY));
    const bandRowsI = fh - bandTopI;
    if (bandRowsI >= 8) {
      const bd = frame.getContext('2d', { willReadFrequently: true }).getImageData(0, bandTopI, w, bandRowsI).data;
      const step = Math.max(1, Math.floor(w / 64));
      let lastContent = -1;
      for (let r = 0; r < bandRowsI; r++) {
        const base = r * w;
        let mean = 0, m2 = 0, cnt = 0;
        for (let x = 0; x < w; x += step) {
          const i = (base + x) * 4;
          const g = (bd[i] * 114 + bd[i + 1] * 587 + bd[i + 2] * 299) / 1000;
          cnt++;
          const d0 = g - mean;
          mean += d0 / cnt;
          m2 += d0 * (g - mean);
        }
        if (cnt > 1 && Math.sqrt(m2 / cnt) >= 3) lastContent = r;
      }
      if (lastContent < 0) {
        console.error(`[LS] band-blank s=${(+sExact).toFixed(1)} (整带纯色/空白，不追加)`);
        return;
      }
      const keep = Math.min(bandRowsI, lastContent + 25);
      if (keep < bandRowsI) {
        console.error(`[LS] band truncated ${bandRowsI}->${keep} (uniform tail)`);
        sExact = keep;
        srcY = bandTopI;
        lsCumShift = ah + sExact - lsBaseH;
      }
    }
  } catch (_) { }
  lsCumShift += sExact;
  const targetH = lsBaseH + Math.round(lsCumShift);
  let n = targetH - ah;
  if (n <= 0) return;
  if (n > sExact + 1) n = Math.max(1, Math.round(sExact));
  const out = document.createElement('canvas');
  out.width = w;
  out.height = ah + n;
  const octx = out.getContext('2d');
  octx.drawImage(lsAccum, 0, 0);
  const srcYi = fh - n;
  octx.drawImage(frame, 0, srcYi, w, n, 0, ah, w, n); // 整数 1:1 硬切（无重采样=文字锐利）
  // r31 内容感知最小能量缝（仿全景拼接 DP seam finding，文献标准做法）：
  // r31b 内容感知最小能量缝（仿全景拼接 DP seam finding，文献标准做法）：
  // 在名义缝 ±SEAM 行内逐列找使"缝上/缝下"像素差最小的垂直线，沿该缝做硬切 + 仅 1px 淡化。
  // 文献明确反对宽线性羽化带——线性 alpha 渐变会让低频亮度差发虚、高频边缘出重影（用户看到的"横线"即此）。
  // 最小能量缝把接缝落在像素最一致处，且无宽渐变带 → 无横线、无发虚。
  const SEAM = 2;
  if (n >= 6) {
    try {
      const E = 2 * SEAM + 2; // 扩展带：多读 1 行，避免 o=-SEAM 时缝上像素越界
      const aBand = lsAccum.getContext('2d', { willReadFrequently: true }).getImageData(0, ah - SEAM - 1, w, E).data;
      const fBand = frame.getContext('2d', { willReadFrequently: true }).getImageData(0, srcYi - SEAM - 1, w, E).data;
      const step = Math.max(1, Math.floor(w / 60));
      const cols = Math.ceil(w / step);
      const OFFS = 2 * SEAM + 1; // 候选偏移 -SEAM..SEAM
      const cost = new Float32Array(cols * OFFS);
      for (let x = 0; x < w; x += step) {
        const c = (x / step) | 0;
        for (let o = -SEAM; o <= SEAM; o++) {
          const ri = SEAM + o; // 缝在扩展带内的行索引（缝上 accum 行 ah-1+o ↔ 缝下 frame 行 srcYi-1+o）
          const pi = (ri * w + x) * 4;
          const d = Math.abs(aBand[pi] - fBand[pi]) + Math.abs(aBand[pi + 1] - fBand[pi + 1]) + Math.abs(aBand[pi + 2] - fBand[pi + 2]);
          cost[c * OFFS + (o + SEAM)] = d;
        }
      }
      // DP 最小能量缝（相邻列偏移差≤1，防阶梯；复杂度 O(W×H)，远低于 graph cut）
      const energy = new Float32Array(cols * OFFS);
      const back = new Int8Array(cols * OFFS);
      for (let c = 0; c < cols; c++) for (let o = 0; o < OFFS; o++) energy[c * OFFS + o] = cost[c * OFFS + o];
      for (let c = 1; c < cols; c++) {
        for (let o = 0; o < OFFS; o++) {
          let best = energy[(c - 1) * OFFS + o], bo = o;
          if (o > 0 && energy[(c - 1) * OFFS + o - 1] < best) { best = energy[(c - 1) * OFFS + o - 1]; bo = o - 1; }
          if (o < OFFS - 1 && energy[(c - 1) * OFFS + o + 1] < best) { best = energy[(c - 1) * OFFS + o + 1]; bo = o + 1; }
          energy[c * OFFS + o] = cost[c * OFFS + o] + best;
          back[c * OFFS + o] = bo;
        }
      }
      const seam = new Int8Array(cols);
      let bo = 0; for (let o = 1; o < OFFS; o++) if (energy[(cols - 1) * OFFS + o] < energy[(cols - 1) * OFFS + bo]) bo = o;
      for (let c = cols - 1; c >= 0; c--) { seam[c] = bo - SEAM; bo = back[c * OFFS + bo]; }
      // 沿缝写回（扩展带内层 2SEAM+1 行）：缝上=accum，缝下=frame，缝处仅 1px 淡化（无宽渐变带）
      const bandH = 2 * SEAM + 1;
      const band = octx.createImageData(w, bandH);
      for (let x = 0; x < w; x++) {
        const c = Math.min(cols - 1, (x / step) | 0);
        const cut = SEAM + seam[c]; // 缝在写回带内的行索引（0..2SEAM）
        for (let i = 0; i < bandH; i++) {
          const pi = ((i + 1) * w + x) * 4; // 扩展带行 i+1（扩展带比写回带多顶部 1 行）
          let r, g, b;
          if (i < cut) { r = aBand[pi]; g = aBand[pi + 1]; b = aBand[pi + 2]; }
          else if (i > cut) { r = fBand[pi]; g = fBand[pi + 1]; b = fBand[pi + 2]; }
          else { r = (aBand[pi] + fBand[pi]) >> 1; g = (aBand[pi + 1] + fBand[pi + 1]) >> 1; b = (aBand[pi + 2] + fBand[pi + 2]) >> 1; }
          band.data[pi] = r; band.data[pi + 1] = g; band.data[pi + 2] = b; band.data[pi + 3] = 255;
        }
      }
      octx.putImageData(band, 0, ah - SEAM); // 直接写回接缝区（覆盖名义硬切，单 pass、无宽渐变）
    } catch (_) { /* 失败则保留硬切，不影响拼接 */ }
  }
  lsAccum = out;
  lsLastStepAppended = true;
  lsUpdatePreview();
  lsPositionPreview();
}

/** 全分辨率捕获 + 匹配 + 拼接：仅在探针检测到内容变化时调用（旧方案每 140ms
 *  全分辨率 getSources 会打满主进程 → 光标轮询/焦点让渡饿死 → 页面滚不动 + 鼠标卡死）。 */
async function lsFullStep() {
  if (!longShotActive || lsFullBusy) return;
  // r22 沉降抓帧：自动滚动模式下若滚动动画仍在进行（最近 ~250ms 内探针见变化），推迟抓帧等页面静止。
  // 动画中途抓的帧是亚像素重采样（文字发虚）→ 拼接接缝羽化带双重曝光（用户实测"清晰度低"的元凶）。
  // 静止点抓帧与 accum 整数像素对齐 → 接缝清晰。超 6 次重试（~360ms）放弃等待照常抓（防漏帧）。
  if (lsAutoScrollActive && Date.now() < lsMotionUntil - 50 && lsSettleRetries < 6) {
    lsSettleRetries++;
    if (!lsFullTimer) {
      lsFullTimer = window.setTimeout(() => {
        lsFullTimer = 0;
        if (longShotActive) { lsLastFullAt = Date.now(); lsFullStep(); }
      }, 60);
    }
    return;
  }
  lsSettleRetries = 0;
  lsFullBusy = true;
  // r55: 拍摄斗篷——预览面板/控制条若与选区重叠（屏幕空间不足时可能），会被 GDI 帧
  // 拍进结果（18:5x 白色瀑布流实测：预览面板出现在拼接图左缘）。抓帧瞬间隐藏这两块 UI，
  // 抓完立即恢复——单次 GDI ~10-20ms，视觉不可感知。
  let cloaked = false;
  const overlapsSel = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.left < selX + selW && r.right > selX && r.top < selY + selH && r.bottom > selY;
  };
  const cloak = (on) => {
    const need = on && (overlapsSel(longShotPreview) || overlapsSel(longShotControl));
    if (cloaked === need) return;
    cloaked = need;
    for (const el of [longShotPreview, longShotControl]) { if (el) el.style.visibility = need ? 'hidden' : ''; }
  };
  try {
    cloak(true);
    const dpr = window.devicePixelRatio || 1;
    const sw = window.screen.width || window.innerWidth;
    const sh = window.screen.height || window.innerHeight;
    let nextBuf = (lsPrev === lsBufA) ? lsBufB : (lsPrev === lsBufB ? lsBufA : lsBufA);
    // GDI 毫秒级抓屏优先（主屏区域）；getSources 仅作 fallback（600~900ms/次，卡顿元凶）
    let frame = null;
    const gx = selX * dpr, gy = selY * dpr, gw = selW * dpr, gh = selH * dpr;
    if (gx >= 0 && gy >= 0) {
      frame = await lsGdiFrame(gx, gy, gw, gh, nextBuf);
      if (frame) { lsCw = frame.width; lsCh = frame.height; }
    }
    // r26 清晰度闸门：GDI 帧抓完先测 lap_var，显著低于会话静止基准（<0.6×EMA）= 画面仍在
    // lsWaitQuiet 拦不住的亚像素动画长尾 → 等 120ms 重抓同缓冲；耗尽仍低则放行（防平坦内容误杀）。
    // r53: 重试 3→1——lap_var 衡量的是内容疏密而非模糊度，深色稀疏内容（大面积纯背景）几乎每帧
    // 都被误判（17:31 会话每步 retries=3 白耗 360ms），且 lsWaitQuiet 已确认静止、r50b 已证
    // soft_frame 多为显示缩放而非动画帧，重抓无益；保留 1 次重试作为动画长尾的最后保险。
    // r54: 改用 lsLapVarInfo（只统计有纹理行的 lap）——整帧 lap 被背景占比稀释是深/浅色都误判的
    // 总根源（浅色页漏判真软帧：18:43 会话软帧混入被感知为清晰度差）；重试 1→2 兜住动画长尾。
    if (frame) {
      let lap = lsLapVarInfo(frame);
      if (lsSharpBase > 0 && lap > 0 && lap < lsSharpBase * 0.6) {
        let retries = 0;
        while (lap > 0 && lap < lsSharpBase * 0.6 && retries < 2) {
          await new Promise((r) => setTimeout(r, 120));
          const nf = await lsGdiFrame(gx, gy, gw, gh, nextBuf);
          if (!nf) break;
          frame = nf; lsCw = nf.width; lsCh = nf.height;
          lap = lsLapVarInfo(frame);
          retries++;
        }
        if (retries > 0) console.error(`[LS] sharp-gate retries=${retries} lap=${Math.round(lap)} base=${Math.round(lsSharpBase)}`);
        // r50 曾把 soft_frame 改丢弃重抓 → 实测 15:21 会话：4 帧被判软、唯一拼接帧 s=552 只 27px 重叠，
        // 内容大量跳过且单步 9.7s。取证软帧实为整图均匀发虚（静态降采样/显示缩放），非滚动动画中途帧，
        // sharp-gate 误触发；丢弃只会重滚造成位移漂移与丢内容。r50b 回退为仅落盘诊断、照常拼接。
        // r58 更新：r54 的内容归一化口径（只统计有纹理行）已消除"稀疏内容误判"——那时误判的是
        // 整图均匀降采样帧（lap 与纹理无关地低），现在口径下仍 <0.6×基线的必是动画中途帧。
        // r58 改为：耗尽重试仍软 → 整帧弃用（返回不拼），下格匹配由 rescue/prev 链桥接，
        // 杜绝软帧入图（22:47 会话软帧 2311 vs 邻帧 3858~4861 被拼入）。
        if (retries >= 2 && lap > 0 && lap < lsSharpBase * 0.6) {
          lsDebugDump(frame, 'soft_frame');
          console.error('[LS] soft frame discarded (动画中途帧，弃拼防发虚)');
          lsPrev = frame; // 更新 prev 供救援链桥接
          return;
        }
      }
      // r54: lap=0（纹理不足无法量化）不参与 EMA，避免纯背景帧把基线拖向 0
      if (lap > 0) lsSharpBase = lsSharpBase > 0 ? lsSharpBase * 0.7 + lap * 0.3 : lap;
    }
    lsFrameIsGdi = !!frame;
    if (!frame) {
      if (!lsSourceId) { // 懒取桌面源：仅 GDI 失败的 fallback 路径走到这里
        try { const src = await getDesktopSource(); if (!src) return; lsSourceId = src.id; } catch (_) { return; }
      }
      const thumbW = Math.max(1, Math.round(sw * dpr));
      const thumbH = Math.max(1, Math.round(sh * dpr));
      const res = await ipcRenderer.invoke('capture-longshot-frame', {
        sourceId: lsSourceId,
        thumbSize: { width: thumbW, height: thumbH },
        selX, selY, selW, selH, screenW: sw, screenH: sh,
      });
      if (!res || !res.url) return;
      const img = await loadImage(res.url);
      if (!img || !img.width || !img.height) return;
      lsCw = img.width; lsCh = img.height;
      frame = lsDrawFrameInto(nextBuf, img, lsCw, lsCh);
    }
    if (nextBuf === lsBufA) lsBufA = frame; else lsBufB = frame;
    if (!frame) return;
    if (!lsAccum) {
      // 独立拷贝：accum 绝不引用双缓冲 canvas（否则后续帧重画 lsBufA/B 会静默覆盖 accum）
      const seedCv = document.createElement('canvas');
      seedCv.width = frame.width; seedCv.height = frame.height;
      seedCv.getContext('2d').drawImage(frame, 0, 0);
      lsAccum = seedCv; lsBaseH = frame.height; lsCumShift = 0; lsPrev = frame;
      lsPageShift = 0;
      lsFlushedH = 0;
      console.error(`[LS] seed accum=${lsAccum.width}x${lsAccum.height}`);
      if (frame.height < 210) showToastMessage('选区较矮，滚动请尽量慢而匀速，拼接更可靠');
      lsUpdatePreview(); lsPositionPreview();
      return;
    }
    let s = lsMatchScroll(frame);
    // 全帧录制（离线回放迭代算法用）：静止帧跳过省负载，偶发关键帧保底。
    // 必须 PNG 无损：JPEG q85 噪声地板 ~400-600 会淹没浅真谷（实测 f36 真位移 236 被噪声判成静止）
    lsRecIdx++;
    try {
      if (lsRecIdx <= 300 && (lsFrameDiffAccum > 0.5 || lsRecIdx % 12 === 0) && frame.toDataURL) {
        ipcRenderer.send('capture-ls-debug', { name: `ls_${lsStartT}_f${String(lsRecIdx).padStart(4, '0')}.png`, dataURL: frame.toDataURL('image/png') });
      }
    } catch (_) { }
    if (s > 0) lsRecLog.push({ i: lsRecIdx, t: Date.now() - lsStartT, s: +Number(s).toFixed(2) });
    if (s > 0) {
      // 精确重锚：sExact = S - (H - fh) → S = sExact + (H - fh)，漂移每次成功即清零
      lsPageShift = s + (lsAccum.height - frame.height);
    } else if (lsPrev && lsPrev.width === frame.width && lsPrev.height === frame.height) {
      // 救援：accum 陈旧（快滚/卡顿跳帧）时改匹配上一帧——间隔短、位移小、重叠大、谷可靠
      lsMatchSrc = 'prev';
      const sRel = lsMatchScroll(frame, lsPrev);
      lsMatchSrc = '';
      // 救援是增量记账（无法重锚）→ 只接受强谷（新鲜帧对真谷比值 ~0.07，0.4 已留足余量）
      if (sRel > 0 && lsLastMatchRatio < 0.6) {
        lsPageShift += sRel;
        const sExact = Math.min(Math.max(1, lsPageShift - (lsAccum.height - frame.height)), frame.height - 8);
        if (lsDiagDue()) console.error(`[LS] rescue prev-match sRel=${sRel.toFixed(1)} pageShift=${lsPageShift.toFixed(1)} append=${sExact.toFixed(1)}`);
        lsLastGoodS = sRel; lsAcceptCount++;
        s = sExact;
      }
    }
    if (s > 0 || lsFrameDiffAccum > 3) lsMotionUntil = Date.now() + LS_MOTION_HOLD;
    if (s > 0) {
      lsAppendRows(frame, s);
      if (lsAccum.height >= LS_MAX_HEIGHT) {
        lsFlushTile();
        if (!lsOverLimitWarned) { lsOverLimitWarned = true; showToastMessage('长截图已超单张上限，继续将分段保存为多张图片'); }
      }
    }
    lsPrev = frame;
  } catch (e) {
    console.error('[LS] capture step error', e && e.message ? e.message : e);
  } finally {
    cloak(false); // r55: 无论成败都恢复预览/控制条可见
    lsFullBusy = false;
    // 活跃期自循环：滚动进行中 45ms 连拍（Picsew/录屏拼接的核心：帧率远高于内容变化率，帧间位移永远在量程内）。
    // r22：自动滚动模式不走快拍自循环——由探针在静止点排程沉降抓帧（见 lsFullStep 入口与探针 LS_AUTO_SETTLE_MS）。
    if (longShotActive && !lsAutoScrollActive && Date.now() < lsMotionUntil && !lsFullTimer) {
      lsFullTimer = window.setTimeout(() => {
        lsFullTimer = 0;
        if (longShotActive) { lsLastFullAt = Date.now(); lsFullStep(); }
      }, LS_ACTIVE_MS);
    }
  }
}

/** 探针循环：低分辨率小图（1/6）只做"洞内内容是否变化"检测；变化才触发全分辨率捕获。
 *  空闲期负载近乎为零，彻底消除主进程被打满导致的鼠标卡顿。 */
async function lsProbeStep() {
  if (!longShotActive) return;
  if (Date.now() < lsMotionUntil) { // 活跃期 full 自循环接管，探针只续拍不抓图
    lsProbeTimer = window.setTimeout(() => { lsProbeStep(); }, LS_PROBE_MS);
    return;
  }
  try {
    const dpr = window.devicePixelRatio || 1;
    const sw = window.screen.width || window.innerWidth;
    const sh = window.screen.height || window.innerHeight;
    let gray = null;
    const gx = selX * dpr, gy = selY * dpr, gw = selW * dpr, gh = selH * dpr;
    // 探针 GDI-only：getSources 缩略图有陈旧缓存（曾输出 diff=0.00 假静止毒化探针），失败就跳过本 tick 等 GDI 恢复
    if (gx >= 0 && gy >= 0) {
      const gres = await ipcRenderer.invoke('capture-longshot-gdi', { gx: Math.round(gx), gy: Math.round(gy), gw: Math.round(gw), gh: Math.round(gh) });
      if (gres && gres.buf && gres.w > 0) gray = lsGdiGray(gres);
      if (!gray && Date.now() - lsProbeDiagLast > 2000) {
        lsProbeDiagLast = Date.now();
        console.error('[LS] probe gdi-null, skip tick');
      }
    }
    if (gray) {
      {
        let acc = 0; let n = 0;
        for (let i = 0; i < gray.length; i += 3) {
          if (lsProbeGray && lsProbeGray.length === gray.length) { acc += Math.abs(gray[i] - lsProbeGray[i]); n++; }
        }
        const diff = n ? acc / n : 999;
        const changed = diff > 0.5;
        if (changed) lsMotionUntil = Date.now() + LS_MOTION_HOLD;
        const nowDiag = Date.now();
        if (changed || nowDiag - lsProbeDiagLast > 2000) {
          lsProbeDiagLast = nowDiag;
          console.error(`[LS] probe diff=${diff.toFixed(2)} changed=${changed} t=${nowDiag - lsStartT}ms`);
        }
        lsProbeGray = gray;
        // 沉降延迟：r23 步进模式下抓帧由 lsAutoStepLoop 全权负责（探针只更新 diff/灰度），
        // 手动模式保持变化即拍（0ms 快拍）
        if (changed && !lsAutoScrollActive && !lsFullBusy && !lsFullTimer && Date.now() - lsLastFullAt >= LS_FULL_COOLDOWN_MS) {
          const settleDelay = lsAutoScrollActive ? LS_AUTO_SETTLE_MS : LS_SETTLE_MS;
          lsFullTimer = window.setTimeout(() => {
            lsFullTimer = 0;
            if (longShotActive) { lsLastFullAt = Date.now(); lsFullStep(); }
          }, settleDelay);
        }
      }
    }
  } catch (e) {
    console.error('[LS] probe error', e && e.message ? e.message : e);
  }
  if (longShotActive) lsProbeTimer = window.setTimeout(() => { lsProbeStep(); }, LS_PROBE_MS);
}

/** 当前瓦片达到单张上限：结算为一张，开新瓦片并以结尾重叠行 seed（保证连续） */
function lsFlushTile() {
  if (!lsAccum) return;
  const h = lsAccum.height;
  lsTiles.push(lsAccum.toDataURL('image/png'));
  lsFlushedH += h;
  const seedH = Math.min(lsCh, h);
  const seed = document.createElement('canvas');
  seed.width = lsAccum.width; seed.height = seedH;
  seed.getContext('2d').drawImage(lsAccum, 0, h - seedH, lsAccum.width, seedH, 0, 0, lsAccum.width, seedH);
  lsAccum = seed;
  lsBaseH = seedH; lsCumShift = 0; lsPrev = seed;
  console.error(`[LS] tile flushed #${lsTiles.length} flushedH=${lsFlushedH} seed=${seedH}`);
}

function stopLongScreenshot(save) {
  if (!longShotActive) return;
  console.error(`[LS] stop save=${save} accum=${lsAccum ? `${lsAccum.width}x${lsAccum.height}` : 'null'} tiles=${lsTiles.length}`);
  try {
    if (lsRecIdx) {
      const meta = { start: lsStartT, selX, selY, selW, selH, dpr: window.devicePixelRatio || 1, frames: lsRecIdx, matches: lsRecLog };
      ipcRenderer.send('capture-ls-debug', { name: `ls_${lsStartT}_manifest.json`, dataURL: 'data:application/json;base64,' + btoa(unescape(encodeURIComponent(JSON.stringify(meta)))) });
    }
  } catch (_) { }
  longShotActive = false;
  lsAutoScrollStop(); // 会话结束必停自动滚动（主进程 capture-ls-active=false 也有双保险）
  if (longShotControl) longShotControl.hidden = true;
  lsDetachKeyDown();
  setLsActive(false);
  if (annotCanvas) annotCanvas.style.visibility = '';
  if (drawCanvas) drawCanvas.style.visibility = '';
  if (lsTimer) { window.clearTimeout(lsTimer); lsTimer = 0; }
  if (lsProbeTimer) { window.clearTimeout(lsProbeTimer); lsProbeTimer = 0; }
  if (lsFullTimer) { window.clearTimeout(lsFullTimer); lsFullTimer = 0; }
  lsProbeGray = null;
  lsPrev = null; lsPrevGray = null;
  document.body.classList.remove('is-longshot');
  if (longShotOverlay) longShotOverlay.hidden = true;
  if (longShotPreview) {
    longShotPreview.hidden = true;
    if (longShotPreviewCanvas && longShotPreviewCanvas.getContext) {
      const ctx = longShotPreviewCanvas.getContext('2d');
      ctx.clearRect(0, 0, longShotPreviewCanvas.width, longShotPreviewCanvas.height);
    }
  }
  if (save && lsAccum) {
    if (lsTiles.length > 0) {
      // 多瓦片：直接写 N 张（不经过编辑器/保存对话框）
      const all = lsTiles.concat([lsAccum.toDataURL('image/png')]);
      const base = (lsSaveFilename ? lsSaveFilename.replace(/_1$/, '') : `长截图_${lsStamp()}`);
      try { ipcRenderer.send('capture-longshot-save', { images: all, baseName: base }); } catch (_) {}
      showToastMessage(`长截图已保存 ${all.length} 张`);
      lsAccum = null; lsTiles = []; lsSaveFilename = null; window.__lsSaveFilename = null;
      restoreNormalAfterCancel();
    } else {
      const dataURL = lsAccum.toDataURL('image/png');
      const fn = lsSaveFilename;
      lsAccum = null; lsSaveFilename = null;
      enterLongShotEditor(dataURL, fn);
    }
  } else {
    lsAccum = null; lsTiles = []; lsSaveFilename = null; window.__lsSaveFilename = null;
    restoreNormalAfterCancel();
  }
}

/** 长截图完成后：把拼接图载入编辑器，像正常截图一样可标注/OCR/翻译/保存。
 * 整图可能高于屏幕 → 开启纵向滚动（body.is-longshot-edit 让画布随页面滚动）。 */
async function enterLongShotEditor(dataURL, saveFilename) {
  let editorBgCss = '';
  window.__lsSaveFilename = saveFilename || null;
  try {
    const img = await loadImage(dataURL);
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    if (!iw || !ih) { ipcRenderer.send('capture-cancel'); return; }
    // 逻辑宽沿用选区宽，高按比例；长图更高，整图作为"选区"
    // 逻辑尺寸 = 原图物理像素 / dpr（不再从 selW 推导 —— 视频流 scale 与 dpr 有
    // ±0.001 级偏差，用 selW 推导会让 backing ≠ 原图像素，产生周期性重采样）
    const dpr = canvasDpr;
    const logicalW = Math.max(1, Math.round(iw / dpr));
    const logicalH = Math.max(1, Math.round(ih / dpr));
    W = logicalW; H = logicalH;
    [bgCanvas, drawCanvas, annotCanvas, tempCanvas].forEach((cv) => {
      cv.width = iw;   // backing 直接用原图像素，bg 层严格 1:1
      cv.height = ih;
      cv.style.width = `${W}px`;
      cv.style.height = `${H}px`;
    });
    // ⚠️ 给 canvas.width/height 赋值会把 2D context 的全部状态重置（含 setupCanvasDpr 设的
    // dpr setTransform）→ 不补回来，drawBackground 的 drawImage(0,0,W,H) 与后续标注绘制
    // 都在恒等变换下进行，整图按 1/dpr 错绘（实测编辑器图片"被拉伸/比例不对"的根因）
    [bgCanvas, drawCanvas, annotCanvas, tempCanvas].forEach((cv) => {
      const c2 = cv.getContext('2d');
      c2.setTransform(dpr, 0, 0, dpr, 0, 0);
      c2.imageSmoothingEnabled = false;
    });
    // bg 层恒等变换：backing=原图像素，drawBackground 画 (0,0) 自然尺寸即严格 1:1；
    // 标注/绘制三层仍用 dpr 逻辑坐标（与 CSS 尺寸 W×H 对应）
    bgCanvas.getContext('2d').setTransform(1, 0, 0, 1, 0, 0);
    bgImage = img;
    captureVirtualScreen = null;
    capturePhysicalScreen = null;
    captureDisplays = [];
    drawBackground();
    // 像素探针：画布 3 个采样点 vs 原图同比例点逐一比对 —— 若全部一致则绘制链路
    // 严格 1:1（"拉伸"为观感/接缝残留），若有偏差则真有渲染 bug，日志直接给证据
    try {
      const pctx = bgCanvas.getContext('2d');
      const t = document.createElement('canvas'); t.width = 1; t.height = 1;
      const tctx = t.getContext('2d', { willReadFrequently: true });
      const sxr = iw / bgCanvas.width, syr = ih / bgCanvas.height;
      const pts = [
        [2, 2],
        [Math.floor(bgCanvas.width / 2), Math.floor(bgCanvas.height / 2)],
        [bgCanvas.width - 3, bgCanvas.height - 3],
      ];
      const report = pts.map(([px, py]) => {
        const got = Array.from(pctx.getImageData(px, py, 1, 1).data.slice(0, 3)).join(',');
        tctx.clearRect(0, 0, 1, 1);
        tctx.drawImage(img, Math.min(iw - 1, Math.floor(px * sxr)), Math.min(ih - 1, Math.floor(py * syr)), 1, 1, 0, 0, 1, 1);
        const want = Array.from(tctx.getImageData(0, 0, 1, 1).data.slice(0, 3)).join(',');
        return got + '|' + want;
      }).join('  ');
      console.error(`[LS] probe bg-vs-img (got|want): ${report} canvas=${bgCanvas.width}x${bgCanvas.height} css=${W}x${H} img=${iw}x${ih}`);
    } catch (e) { console.error('[LS] probe failed', e && e.message ? e.message : e); }
    state = STATE.SELECTED;
    selX = 0; selY = 0; selW = W; selH = H;
    historyStack.length = 0; historyIndex = -1; annotations = [];
    document.body.classList.remove('is-longshot');
    document.body.classList.add('is-longshot-edit');
    // 编辑器背景跟随图像主色：露底区域与截图融为一体（固定暗背景曾被误读为"截图有大片黑色区域"）
    try {
      const sctxCv = document.createElement('canvas'); sctxCv.width = 8; sctxCv.height = 2;
      const sctx = sctxCv.getContext('2d', { willReadFrequently: true });
      sctx.drawImage(img, 0, 0, 8, 2);
      const d8 = sctx.getImageData(0, 0, 8, 2).data;
      let r8 = 0, g8 = 0, b8 = 0;
      for (let i = 0; i < d8.length; i += 4) { r8 += d8[i]; g8 += d8[i + 1]; b8 += d8[i + 2]; }
      const n8 = d8.length / 4;
      editorBgCss = `rgb(${Math.round(r8 / n8)},${Math.round(g8 / n8)},${Math.round(b8 / n8)})`;
      // r55 露底区域用固定近黑编辑器底色：此前「主题色 × 0.55」在浅色页面呈现为一整块
      // 与内容无关的灰色"阴影区"（用户实测反馈）。近黑是图像编辑器的标准画布外 chrome，
      // 读作"画布之外"而非"内容里的阴影"；导出 PNG 只含画布像素，不受影响。
      editorBgCss = 'rgb(26, 27, 30)';
      document.body.style.background = editorBgCss;
    } catch (_) { }
    document.documentElement.style.setProperty('--ls-edit-w', `${W}px`);
    document.documentElement.style.setProperty('--ls-edit-h', `${H}px`);
    const LS_TOOLBAR_RESERVE = 170;  // 工具栏(约80) + 底部安全距离 28 + 呼吸余量 62
    const LS_BOTTOM_GAP = 24;        // 底部与工具栏/任务栏的间隙，防贴底
    document.documentElement.style.overflowY = 'auto';
    document.body.style.position = 'relative';
    // r57: body 高度 = 画布高度 + 顶部呼吸 14px（画布 CSS top:14px，不再贴屏幕上缘）。
    // 工具栏改为悬浮（fixed）在视口底部、可拖动（参考微信截图）——不再为它预留固定填充区，
    // 长图滚动到底时工具栏直接浮在图片下缘上方，此前的"黑色区域"彻底消失。
    document.body.style.height = `${H + 14}px`;
    // 背景填充 div 双保险：body 行内背景曾在用户会话静默失效（回落 CSS 类 #14181d 深黑 = "黑色区域"）
    try {
      if (!editorBgCss) editorBgCss = 'rgb(26, 27, 30)'; // r55: 采样失败也回落到编辑器暗色 chrome
      let fill = document.getElementById('ls-bg-fill');
      if (!fill) {
        fill = document.createElement('div');
        fill.id = 'ls-bg-fill';
        document.body.insertBefore(fill, document.body.firstChild);
      }
      // r57: 工具栏悬浮化后不再需要填充区（body 高度即画布高度），高度归零防旧节点撑出滚动区
      fill.style.cssText = `left:0;right:0;top:${H + 14}px;height:0;background:${editorBgCss};`;
      setTimeout(() => {
        try { console.error(`[LS] bodyBg applied=${getComputedStyle(document.body).backgroundColor} fillH=${fill.style.height}`); } catch (_) { }
      }, 100);
    } catch (e) { console.error('[LS] bg-fill failed', e && e.message ? e.message : e); }
    if (longShotOverlay) longShotOverlay.hidden = true;
    if (longShotPreview) longShotPreview.hidden = true;
    if (longShotControl) longShotControl.hidden = true;
    setTimeout(() => {
      try {
        const cv = bgCanvas.getBoundingClientRect();
        console.error(`[LS] editor geom win=${window.innerWidth}x${window.innerHeight} dpr=${window.devicePixelRatio} body=${document.body.offsetHeight} bodyBg=${getComputedStyle(document.body).backgroundColor} canvas=${Math.round(cv.width)}x${Math.round(cv.height)} top=${Math.round(cv.top)} bottom=${Math.round(cv.bottom)} scrollY=${Math.round(window.scrollY)}`);
      } catch (_) { }
    }, 400);
    // r27 附带清晰度参考补丁（图内含文字的 200x120 CSS 区域）：主进程 capturePage 实测
    // 同区域渲染输出与原图的 lap_var 比值，<0.7 判栅格尺度失效（整窗发虚）→ hide/show 自愈。
    // 补丁取自视口可见的图顶部区域（capturePage 只能截可视页）。
    let sent = false;
    try {
      const dprE = window.devicePixelRatio || 1;
      const pwE = 200, phE = 120;
      // r28: 固定取图顶部区域会被纯色背景骗过（实测聊天窗顶部空白 → flat patch lap=0 →
      // 主进程守卫整体跳过 → 栅格失效模糊漏网）。在可视顶部范围内扫描候选区，
      // 选清晰度（lap_var）最高的一块发给主进程。
      let bestPatch = null;
      const lapOfPatch = (px, py) => {
        const cw = Math.round(pwE * dprE), ch = Math.round(phE * dprE);
        const c = document.createElement('canvas');
        c.width = cw; c.height = ch;
        const cx = c.getContext('2d', { willReadFrequently: true });
        cx.drawImage(bgImage, Math.round(px * dprE), Math.round(py * dprE), cw, ch, 0, 0, cw, ch);
        const d = cx.getImageData(0, 0, cw, ch).data;
        const g = new Float32Array(cw * ch);
        for (let i = 0, p = 0; p < g.length; i += 4, p++) g[p] = (d[i] * 114 + d[i + 1] * 587 + d[i + 2] * 299) / 1000;
        let s1 = 0, s2 = 0, cnt = 0;
        for (let y = 1; y < ch - 1; y++) for (let x = 1; x < cw - 1; x++) {
          const i2 = y * cw + x;
          const lap = 4 * g[i2] - g[i2 - 1] - g[i2 + 1] - g[i2 - cw] - g[i2 + cw];
          s1 += lap; s2 += lap * lap; cnt++;
        }
        const m = s1 / cnt;
        return s2 / cnt - m * m;
      };
      for (const py of [40, 130, 220, 310, 400]) {
        if (py + phE > H) break;
        for (let px = 40; px + pwE <= W - 40; px += 150) {
          const lap = lapOfPatch(px, py);
          if (!bestPatch || lap > bestPatch.lap) bestPatch = { px, py, lap };
        }
      }
      if (!bestPatch) bestPatch = { px: Math.max(0, Math.floor((W - pwE) / 2)), py: 0, lap: 0 };
      const pxE = bestPatch.px;
      const pyE = bestPatch.py;
      const pcvE = document.createElement('canvas');
      pcvE.width = Math.round(pwE * dprE); pcvE.height = Math.round(phE * dprE);
      pcvE.getContext('2d').drawImage(
        bgImage,
        Math.round(pxE * dprE), Math.round(pyE * dprE), pcvE.width, pcvE.height,
        0, 0, pcvE.width, pcvE.height,
      );
      ipcRenderer.send('capture-longshot-editor', {
        w: W, h: H,
        ref: { x: pxE, y: pyE, w: pwE, h: phE, dataURL: pcvE.toDataURL('image/png') },
      });
      sent = true;
    } catch (_) { /* fallthrough */ }
    if (!sent) { try { ipcRenderer.send('capture-longshot-editor', { w: W, h: H }); } catch (_) { /* ignore */ } }
    if (btnLongShot) btnLongShot.disabled = true; // 结果编辑态：长截图按钮不再触发新一轮
    if (captureHandles) captureHandles.style.display = 'none';
    if (sizeInfo) sizeInfo.style.display = 'none';
    drawMask();
    showToolbar();
    console.error(`[LS] editor entered ${W}x${H}`);
  } catch (err) {
    console.error('[LS] enter editor failed', err);
    ipcRenderer.send('capture-cancel');
  }
}

/** 长截图取消：还原成正常选区编辑态（选区洞里的静态截图重新画回，工具栏/蒙版恢复）。 */
function restoreNormalAfterCancel() {
  window.__lsSaveFilename = null;
  state = STATE.SELECTED;
  drawBackground(); // 还原选区洞里的原始截图
  document.body.classList.remove('is-longshot');
  document.body.classList.remove('is-longshot-edit');
  document.documentElement.style.overflowY = '';
  document.body.style.position = '';
  document.body.style.height = '';
  if (longShotOverlay) longShotOverlay.hidden = true;
  if (longShotPreview) longShotPreview.hidden = true;
  if (longShotControl) longShotControl.hidden = true;
  if (captureHandles) captureHandles.style.display = 'none';
  drawMask();
  showToolbar();
  updateSizeInfo(selX, selY);
  auditMask('ls-cancel-restored');
  console.error('[LS] cancel -> restored normal selection');
}

if (btnRecord) btnRecord.addEventListener('click', () => {
  if (isCaptureBusy() || state !== STATE.SELECTED) return;
  startRecording();
});

// 长截图完成/取消：光标移出选区后（透传关闭）按钮可点
// 完成拼接 / 取消 走主进程 globalShortcut（Enter / Esc）→ 'capture-ls-finish'，
// 纯透传模式下窗口收不到点击，按钮已从浮层移除。

/* #91 录屏：选区 → 3-2-1 倒计时 → 桌面流裁剪到选区 → MediaRecorder(webm) → 主进程存盘 */
const recOverlay = document.getElementById('recOverlay');
const recCountdown = document.getElementById('recCountdown');
const recBar = document.getElementById('recBar');
const recTimer = document.getElementById('recTimer');
const recPause = document.getElementById('recPause');
const recStop = document.getElementById('recStop');
let mediaRecorder = null;
let recordStream = null;
let recordCanvas = null;
let recordRAF = 0;
let recordChunks = [];
let isRecording = false;
let recordTimerInterval = 0;
let recordStartTime = 0;
let recordPausedTime = 0;
let recordElapsedBeforePause = 0;

function _formatRecTimer(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60).toString().padStart(2, '0');
  const s = (totalSec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}
function _positionRecBar() {
  if (!recBar) return;
  const pad = 10;
  let top = selY - recBar.offsetHeight - pad;
  let left = selX + selW - recBar.offsetWidth;
  if (top < pad) top = selY + selH + pad;
  if (left < pad) left = pad;
  if (left + recBar.offsetWidth > window.innerWidth - pad) left = window.innerWidth - recBar.offsetWidth - pad;
  if (top + recBar.offsetHeight > window.innerHeight - pad) top = selY - recBar.offsetHeight - pad;
  recBar.style.top = `${Math.max(pad, top)}px`;
  recBar.style.left = `${Math.max(pad, left)}px`;
}
function _updateRecTimer() {
  if (!recTimer) return;
  let elapsed = recordElapsedBeforePause;
  if (!recordPausedTime) {
    elapsed += Date.now() - recordStartTime;
  }
  recTimer.textContent = _formatRecTimer(elapsed);
}

async function startRecording() {
  if (isRecording || selW < 4 || selH < 4) { console.error(`[REC] start blocked: active=${isRecording} sel=${selW}x${selH} state=${state}`); return; }
  console.error(`[REC] start sel=(${selX},${selY}) ${selW}x${selH}`);
  // 录屏时只隐藏工具栏/手柄/指引，保留选区洞让用户看到录制范围
  hideToolbar();
  if (captureHandles) captureHandles.style.display = 'none';
  if (captureGuide) captureGuide.classList.add('is-away');
  document.body.classList.add('is-recording');
  if (recOverlay) recOverlay.hidden = false;
  if (recCountdown) { recCountdown.hidden = false; recCountdown.textContent = '3'; }
  // 录制条等真正开录时定位到选区旁再显示；倒计时期间显示会落在未定位的左上角
  if (recBar) recBar.hidden = true;
  if (recBar) recBar.classList.remove('is-paused');
  recordStartTime = 0;
  recordPausedTime = 0;
  recordElapsedBeforePause = 0;
  // 3-2-1 倒计时
  await new Promise((resolve) => {
    let n = 3;
    const tick = () => {
      n -= 1;
      if (n <= 0) { if (recCountdown) recCountdown.hidden = true; resolve(); }
      else if (recCountdown) { recCountdown.textContent = String(n); window.setTimeout(tick, 700); }
      else resolve();
    };
    window.setTimeout(tick, 700);
  });
  let source;
  try {
    source = await getDesktopSource();
    console.error(`[REC] getSources id=${source ? source.id : 'NONE'}`);
  } catch (err) {
    console.error('[REC] getSources failed', err);
    _cleanupRecording(false);
    return;
  }
  if (!source) { _cleanupRecording(false); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id } },
    });
    console.error('[REC] getUserMedia OK');
  } catch (err) {
    console.error('[REC] getUserMedia failed', err && err.message ? err.message : err);
    _cleanupRecording(false);
    return;
  }
  recordStream = stream;
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  await video.play().catch((err) => console.error('[REC] video.play rejected', err && err.message ? err.message : err));
  // ⚠️ 裁剪坐标按视频实际尺寸换算（Electron issue #44187：高 DPI 屏上桌面流是
  // 逻辑分辨率而非物理分辨率），不能假设 videoWidth = 屏幕物理宽。
  await new Promise((resolve) => {
    if (video.videoWidth > 0) resolve();
    else video.onloadedmetadata = () => resolve();
  });
  const scale = (video.videoWidth || window.innerWidth) / window.innerWidth;
  const cw = Math.max(1, Math.round(selW * scale));
  const ch = Math.max(1, Math.round(selH * scale));
  recordCanvas = document.createElement('canvas');
  recordCanvas.width = cw;
  recordCanvas.height = ch;
  const rctx = recordCanvas.getContext('2d');
  const sx = Math.round(selX * scale);
  const sy = Math.round(selY * scale);
  console.error(`[REC] video ${video.videoWidth}x${video.videoHeight} scale=${scale.toFixed(3)} crop=(${sx},${sy}) ${cw}x${ch}`);
  const drawFrame = () => {
    try { rctx.drawImage(video, sx, sy, cw, ch, 0, 0, cw, ch); } catch (_) { /* ignore */ }
    recordRAF = window.requestAnimationFrame(drawFrame);
  };
  drawFrame();
  const canvasStream = recordCanvas.captureStream(30);
  recordChunks = [];
  // 编码器优先 VP9（同码率画质更好），不支持再落到默认；码率按分辨率给足，避免默认低码率糊成马赛克
  const vp9Supported = typeof MediaRecorder.isTypeSupported === 'function'
    && MediaRecorder.isTypeSupported('video/webm;codecs=vp9');
  const recMimeType = vp9Supported ? 'video/webm;codecs=vp9' : 'video/webm';
  const recBitrate = Math.min(20_000_000, Math.max(4_000_000, Math.round(cw * ch * 30 * 0.12)));
  console.error(`[REC] recorder mime=${recMimeType} bitrate=${recBitrate}`);
  try {
    mediaRecorder = new MediaRecorder(canvasStream, { mimeType: recMimeType, videoBitsPerSecond: recBitrate });
  } catch (err) {
    console.error('[REC] MediaRecorder failed', err);
    _cleanupRecording(false);
    return;
  }
  mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recordChunks.push(e.data); };
  mediaRecorder.onstop = async () => {
    const totalBytes = recordChunks.reduce((n, c) => n + c.size, 0);
    console.error(`[REC] stop chunks=${recordChunks.length} bytes=${totalBytes}`);
    window.cancelAnimationFrame(recordRAF);
    if (recordStream) recordStream.getTracks().forEach((t) => t.stop());
    // 先退出录制交互态（恢复截图窗鼠标接收 + 隐藏录制条），保存对话框才可正常点击
    _restoreRecordingUi();
    if (recordChunks.length === 0) {
      _cleanupRecording(true);
      return;
    }
    const blob = new Blob(recordChunks, { type: 'video/webm' });
    const buf = await blob.arrayBuffer();
    try {
      const saved = await ipcRenderer.invoke('capture-record-save', { buffer: buf });
      console.error(`[REC] save result=${saved}`);
    } catch (err) { console.error('[REC] save invoke failed', err); }
    _cleanupRecording(true);
  };
  mediaRecorder.start();
  console.error(`[REC] recording started mime=${mediaRecorder.mimeType}`);
  isRecording = true;
  recordStartTime = Date.now();
  recordPausedTime = 0;
  recordElapsedBeforePause = 0;
  _positionRecBar();
  if (recBar) recBar.hidden = false; // 倒计时期间隐藏，开录时先定位到选区旁再显示
  if (recPause) recPause.textContent = tCapture('pauseRec');
  recordTimerInterval = window.setInterval(_updateRecTimer, 500);
  // 录制开始：光标驱动 forward 透传 —— 光标在录制区内事件直达被录的应用（可正常演示操作），
  // 移出选区（到录制条）事件回到截图窗，停止/暂停按钮可点。
  recordMouseIgnored = false;
  setRecordMouseIgnore(false);
}

/** 录制结束后的 UI 恢复（不含变量清理与离场：保存对话框期间窗口必须保持可交互） */
function _restoreRecordingUi() {
  if (recordTimerInterval) { window.clearInterval(recordTimerInterval); recordTimerInterval = 0; }
  document.body.classList.remove('is-recording');
  if (recOverlay) recOverlay.hidden = true;
  if (recBar) recBar.classList.remove('is-paused');
  setRecordMouseIgnore(false); // 透传一定复位，别让截图窗卡在 ignore 态
}

function _cleanupRecording(sendCancel) {
  _restoreRecordingUi();
  window.cancelAnimationFrame(recordRAF);
  if (recordStream) recordStream.getTracks().forEach((t) => t.stop());
  isRecording = false;
  mediaRecorder = null;
  recordStream = null;
  recordCanvas = null;
  recordChunks = [];
  if (sendCancel) ipcRenderer.send('capture-cancel');
}

function pauseRecording() {
  if (!mediaRecorder || mediaRecorder.state !== 'recording' || recordPausedTime) return;
  mediaRecorder.pause();
  recordPausedTime = Date.now();
  if (recBar) recBar.classList.add('is-paused');
  if (recPause) recPause.textContent = tCapture('resumeRec');
  _updateRecTimer();
}
function resumeRecording() {
  if (!mediaRecorder || mediaRecorder.state !== 'paused' || !recordPausedTime) return;
  mediaRecorder.resume();
  recordElapsedBeforePause += recordPausedTime - recordStartTime;
  recordStartTime = Date.now();
  recordPausedTime = 0;
  if (recBar) recBar.classList.remove('is-paused');
  if (recPause) recPause.textContent = tCapture('pauseRec');
}
function togglePauseRecording() {
  if (recordPausedTime) resumeRecording();
  else pauseRecording();
}
function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  else _cleanupRecording(true);
}
if (recPause) recPause.addEventListener('click', togglePauseRecording);
if (recStop) recStop.addEventListener('click', stopRecording);
if (btnQr) btnQr.addEventListener('click', () => {
  if (isCaptureBusy() || state !== STATE.SELECTED) return;
  const canvas = cropSelectionRaw();
  if (!canvas) { showToastMessage(tCapture('noQrFound')); return; }
  try {
    const ctx = canvas.getContext('2d');
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const decoded = window.jsQR
      ? window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' })
      : null;
    if (decoded && decoded.data) showQrResult(decoded.data);
    else showToastMessage(tCapture('noQrFound'));
  } catch (err) {
    console.warn('[QR] decode failed:', err);
    showToastMessage(tCapture('noQrFound'));
  }
});
/* #92 二维码结果卡片：复制内容 / 打开链接（识别为 URL 时显示） */
function showQrResult(text) {
  if (!qrResult || !qrText) return;
  qrText.textContent = text;
  const url = text.trim();
  if (qrOpen) {
    const looksUrl = /^(https?:\/\/|www\.)/i.test(url) || /^[\w-]+(\.[\w-]+){1,}(\/|\?|#|$)/i.test(url);
    qrOpen.hidden = !looksUrl;
    if (looksUrl) {
      qrOpen.onclick = () => {
        try { if (shell) shell.openExternal(url.startsWith('http') ? url : `https://${url}`); } catch (_) { /* ignore */ }
      };
    } else {
      qrOpen.onclick = null;
    }
  }
  qrResult.hidden = false;
}
function hideQrResult() { if (qrResult) qrResult.hidden = true; }
if (qrCopy) qrCopy.addEventListener('click', () => {
  const text = qrText ? qrText.textContent : '';
  if (text) { clipboard.writeText(text); showToastMessage(tCapture('copied')); }
});
if (qrClose) qrClose.addEventListener('click', hideQrResult);

btnUndo.addEventListener('click', () => {
  if (state !== STATE.SELECTED) return;
  resetTranslationCache();
  undoLast();
});

const btnRedo = document.getElementById('btnRedo');
if (btnRedo) {
  btnRedo.addEventListener('click', () => {
    if (state !== STATE.SELECTED) return;
    resetTranslationCache();
    redoLast();
    drawMask();
  });
}

// 双击不再完成截图（用户要求取消）：双击保留给「文字对象再编辑」等编辑交互，
// 完成截图走 Enter / 工具栏「完成」按钮。原 Snipaste 式双击完成逻辑已移除 ——
// 它会在双击文字对象时把整张截图直接完成掉，导致"文字移动后再也无法编辑"。

/** r23b 长截图编辑态全图导出：直接用 bgImage（完整 accum 原图，物理分辨率）1:1 合成标注层。
 *  不能走 cropSelectionWithAnnotations()：编辑态 W/H/selW/selH 会被窗口几何改写
 *  （实测保存出 862x884 = 第一屏视口缩放图，而 accum 是 1359x4341 —— "反而更糊了"的元凶）。 */
function cropLongShotFull() {
  if (!bgImage) return null;
  const iw = bgImage.naturalWidth;
  const ih = bgImage.naturalHeight;
  if (!iw || !ih) return null;
  const out = document.createElement('canvas');
  out.width = iw; out.height = ih;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bgImage, 0, 0); // 原图像素严格 1:1，零重采样
  if (annotCanvas && annotations.length > 0) {
    ctx.drawImage(annotCanvas, 0, 0); // 编辑态标注层 backing = iw×ih，恒等变换直接叠加
  }
  return out.toDataURL('image/png');
}

/** r22 确认动作：普通截图=复制+关闭；长截图编辑态=复制+落盘并保留结果页面（用户要求不直接退出） */
function confirmCapture(dataURL) {
  if (!dataURL) return;
  if (document.body.classList.contains('is-longshot-edit')) {
    const full = cropLongShotFull() || dataURL;
    try { clipboard.writeImage(nativeImage.createFromDataURL(full)); } catch (_) { }
    try {
      const base = (window.__lsSaveFilename || `长截图_${lsStamp()}`).replace(/_1$/, '');
      ipcRenderer.send('capture-longshot-save', { images: [full], baseName: base });
      showToastMessage('长截图已复制并保存到图片目录，可继续标注，✕/Esc 关闭');
    } catch (_) { showToastMessage('长截图已复制到剪贴板'); }
    return;
  }
  ipcRenderer.send('capture-complete', { dataURL });
}

document.getElementById('btnCopy').addEventListener('click', () => {
  confirmCapture(cropSelectionWithAnnotations());
});

btnOcr.addEventListener('click', async (e) => {
  // 右下角 ▾ 三角：展开/收起「表格识别」菜单（镜像翻译按钮交互）
  if (isCaretHit(e, btnOcr)) {
    if (isOcrMenuOpen()) closeOcrMenu();
    else openOcrMenu();
    return;
  }
  closeOcrMenu();
  if (isCaptureBusy() || state !== STATE.SELECTED) return;

  const image = cropSelectionWithAnnotations();
  if (!image) return;
  ocrSourceImage = image; // 表格识别按钮复用同一张选区图
  ocrTableHtml = '';      // 新一轮识别：清上一轮表格结果

  const runId = ++ocrRunId;
  resetOcrResult();
  isRecognizing = true;
  hideToolbar();
  sizeInfo.style.display = 'none';
  showTranslateOverlay(tCapture('recognizing'));

  try {
    let result;
    if (ocrEngine === 'server') {
      const token = await ipcRenderer.invoke('store:read', 'user-account-token');
      if (typeof token !== 'string' || !token.trim()) {
        throw new Error(tCapture('ocrLoginRequired'));
      }
      result = await ipcRenderer.invoke('capture-ocr', { dataURL: image, token });
    } else {
      // 本机 OCR：local=Tesseract.js / paddleocr=本机 PaddleOCR（均由主进程按配置分流）
      result = await ipcRenderer.invoke('capture-ocr-local', { dataURL: image });
    }
    if (runId !== ocrRunId) return;
    if (!result?.success) {
      const errorCode = result?.code;
      const fallbackMessage = errorCode && tCapture(errorCode) !== errorCode
        ? tCapture(errorCode)
        : tCapture('ocrFailed');
      throw new Error(result?.message || fallbackMessage);
    }
    hideTranslateOverlay();
    showOcrResult(typeof result.text === 'string' ? result.text : '');
  } catch (error) {
    if (runId !== ocrRunId) return;
    showTranslateOverlay(error instanceof Error ? error.message : tCapture('ocrFailed'), true);
    await new Promise((resolve) => window.setTimeout(resolve, 2200));
    hideTranslateOverlay();
  } finally {
    // 已 Esc 取消（cancelOcrNow 已恢复 UI）时不再重复恢复
    if (runId === ocrRunId) {
      isRecognizing = false;
      if (ocrPanel.style.display !== 'flex') {
        showToolbar();
        updateSizeInfo(selX, selY);
      }
    }
  }
});

/** Esc 取消进行中的 OCR：中断等待，恢复工具栏继续编辑 */
function cancelOcrNow() {
  ocrRunId += 1;
  isRecognizing = false;
  hideTranslateOverlay();
  showToolbar();
  updateSizeInfo(selX, selY);
}

// 复制当前显示内容（文本/译文视图共用同一个可编辑文本区，编辑实时生效）：
//  - 复制纯文本 = 去掉 Markdown 语法标记后的正文
//  - 复制 Markdown = 文本区原文（Markdown 源码，可用「预览」查看渲染效果）
if (btnOcrCopyText) {
  /** 表格识别共享流程：工具栏 OCR ▾ 菜单与面板「表格识别」按钮共用。
   *  成功：结果（Markdown 表格源）进面板并自动预览；失败/无表格：toast 说明。 */
  async function runTableRecognition() {
    if (!ocrSourceImage) {
      showToastMessage('没有可识别的选区图像', 2400);
      return;
    }
    showTranslateOverlay('表格识别中…'); // 与文字识别的"识别中"蒙版提示一致
    try {
      const r = await ipcRenderer.invoke('capture-ocr-table', { dataURL: ocrSourceImage });
      hideTranslateOverlay();
      if (r && r.success && r.html) {
        ocrTableHtml = r.html; // 带边框 HTML，复制按钮会附带 text/html 剪贴板格式
        showOcrResult(htmlTableToMarkdown(r.html)); // 面板展示 Markdown 表格源
        setOcrPreviewVisible(true); // 自动进预览：表格以带边框 HTML 渲染
        showToastMessage('表格已还原到面板（预览可见），复制后可粘贴到 Excel/WPS', 2600);
      } else if (r && r.success) {
        hideTranslateOverlay();
        showToastMessage('未在选区中识别到表格', 2600);
      } else {
        hideTranslateOverlay();
        showToastMessage('表格识别失败：' + ((r && r.html) || '服务不可用'), 3200);
      }
    } catch (err) {
      hideTranslateOverlay();
      showToastMessage('表格识别失败：' + ((err && err.message) || err), 3200);
    }
  }

  ocrMenuTable.addEventListener('click', async () => {
    closeOcrMenu();
    if (isCaptureBusy() || state !== STATE.SELECTED) return;
    const image = cropSelectionWithAnnotations();
    if (!image) return;
    ocrSourceImage = image;
    ocrTableHtml = '';
    hideToolbar();
    sizeInfo.style.display = 'none';
    await runTableRecognition();
    if (ocrPanel.style.display !== 'flex') {
      showToolbar();
      updateSizeInfo(selX, selY);
    }
  });

  // 智能识别：版面分析分区（标题/正文/表格）→ 合成 Markdown，结果走与文字识别相同的面板展示
  // 图片翻译：与工具栏翻译按钮同一条链路（复用其当前语言设置）
  ocrMenuTranslate.addEventListener('click', async (e) => {
    closeOcrMenu();
    if (isCaptureBusy() || state !== STATE.SELECTED) return;
    if (translationCache) {
      try { await toggleCachedTranslation(); } catch (_) {}
      return;
    }
    await runImageTranslation({});
  });

  ocrMenuSmart.addEventListener('click', async (e) => {
    closeOcrMenu();
    if (isCaptureBusy() || state !== STATE.SELECTED) return;
    const image = cropSelectionWithAnnotations();
    if (!image) return;
    ocrSourceImage = image;
    ocrTableHtml = '';
    hideToolbar();
    sizeInfo.style.display = 'none';
    showTranslateOverlay('智能识别中（版面分析）…');
    try {
      const result = await ipcRenderer.invoke('capture-ocr-smart', { dataURL: image });
      if (result && result.success && result.text) {
        hideTranslateOverlay();
        showOcrResult(result.text);
      } else {
        showTranslateOverlay((result && result.text) || '智能识别失败', true);
        await new Promise((resolve) => window.setTimeout(resolve, 2200));
        hideTranslateOverlay();
      }
    } catch (err) {
      showTranslateOverlay('智能识别失败：' + ((err && err.message) || err), true);
      await new Promise((resolve) => window.setTimeout(resolve, 2200));
      hideTranslateOverlay();
    } finally {
      if (ocrPanel.style.display !== 'flex') {
        showToolbar();
        updateSizeInfo(selX, selY);
      }
    }
  });

  btnOcrCopyText.addEventListener('click', () => {
    if (ocrTableHtml) {
      // 表格结果：text=TSV + text/html 带边框表格，粘贴 Excel/WPS 直接得到真表格
      clipboard.write({ text: htmlTableToTsv(ocrTableHtml), html: ocrTableHtml });
      flashOcrCopied(btnOcrCopyText);
      return;
    }
    const plain = mdToPlainText(ocrText.value);
    if (!plain) return;
    clipboard.writeText(plain);
    flashOcrCopied(btnOcrCopyText);
  });

  // 表格识别：对选区原图跑表格结构还原（RapidTable/SLANet-plus），HTML 进剪贴板，
  // 粘贴到 Excel/WPS 直接得到真表格；纯文本兜底为 TSV（制表符分列）。
  btnOcrTable.addEventListener('click', async () => {
    if (!ocrSourceImage || btnOcrTable.disabled) return;
    const span = btnOcrTableLabel || btnOcrTable.querySelector('span');
    const original = span.textContent;
    span.textContent = tCapture('recognizing');
    btnOcrTable.disabled = true;
    try {
      await runTableRecognition();
      if (span) span.textContent = original;
    } catch (err) {
      if (span) span.textContent = original;
    } finally {
      window.setTimeout(() => {
        if (span) span.textContent = original;
        if (btnOcrTable) btnOcrTable.disabled = !(ocrText && ocrText.value);
      }, 1200);
    }
  });
}
if (btnOcrCopyMd) {
  btnOcrCopyMd.addEventListener('click', () => {
    const md = ocrText.value;
    if (!md) return;
    if (ocrTableHtml) {
      // 表格结果：Markdown 源 + text/html 双格式（支持 Markdown 的编辑器与 Excel 都能吃）
      clipboard.write({ text: md, html: ocrTableHtml });
    } else {
      clipboard.writeText(md);
    }
    flashOcrCopied(btnOcrCopyMd);
  });
}
// Markdown 编写/预览切换：编辑态写 Markdown 源码，预览态看渲染结果
if (btnOcrPreview) {
  btnOcrPreview.addEventListener('click', () => {
    if (!ocrText.value) return;
    setOcrPreviewVisible(!ocrPreviewVisible);
  });
}

// 文本区可直接编辑：输入时实时同步复制按钮可用态（译文/原文编辑均生效）；
// 预览态下输入不会发生（文本区隐藏），无需刷新渲染
ocrText.addEventListener('input', () => {
  setOcrCopyEnabled(!!ocrText.value);
});

/**
 * 面板文本翻译：把 sourceText 译为目标语言（面板下拉当前值），写入译文对并显示译文侧。
 * 「翻译」按钮与「切换语言自动重译」共用；成功返回 true。
 */
async function translatePanelText(sourceText) {
  isTranslating = true;
  if (btnOcrLangLabel) btnOcrLangLabel.textContent = tCapture('translating');
  try {
    const targetLanguage = ocrTargetLang && ocrTargetLang.value ? ocrTargetLang.value : 'zh';
    const result = await ipcRenderer.invoke('capture-translate-text', { text: sourceText, targetLanguage });
    if (!result?.success || typeof result.text !== 'string' || !result.text) {
      throw new Error(result?.message || tCapture('translateFailed'));
    }
    translatePair = { original: sourceText, translated: result.text, showing: 'translated' };
    ocrText.value = result.text;
    // 预览态保持预览，只刷新渲染内容（切换/翻译不应打断 Markdown 预览）
    if (ocrPreviewVisible && ocrPreview) ocrPreview.innerHTML = mdToHtml(result.text);
    else ocrText.hidden = false;
    if (btnOcrLangLabel) btnOcrLangLabel.textContent = tCapture('showOriginal');
    setOcrCopyEnabled(true);
    return true;
  } catch (error) {
    // 失败：短暂提示后按钮回到原状态（有旧译文回「显示原文」，否则回「翻译」可重试）
    showTranslateOverlay(error instanceof Error ? error.message : tCapture('translateFailed'), true);
    await new Promise((resolve) => window.setTimeout(resolve, 1800));
    hideTranslateOverlay();
    if (btnOcrLangLabel) {
      btnOcrLangLabel.textContent = tCapture(translatePair ? 'showOriginal' : 'translateText');
    }
    return false;
  } finally {
    isTranslating = false;
  }
}

/** 切换目标语言后自动重译：已有译文对时按新语言重新翻译原文侧 */
function retranslatePanelIfAny() {
  if (!translatePair || isTranslating || isRecognizing) return;
  const src = (translatePair.original || '').trim();
  if (!src) return;
  void translatePanelText(src);
}

// 面板内「翻译 / 显示原文 / 显示译文」三态按钮：
//  - 无译文（初始识别结果）→ 直接翻译文本区里已识别的文字（不重新截屏/OCR，秒级返回）
//  - 有译文 → 在译文/原文之间切换（双向保存编辑）
// 目标语言由面板内下拉选择（默认中文）；切换语言且有译文时自动重新翻译。
if (btnOcrLang) {
  btnOcrLang.addEventListener('click', async () => {
    if (isTranslating || isRecognizing) return;
    if (translatePair) {
      // 有译文：在原文/译文之间切换（双向保存编辑）
      const next = translatePair.showing === 'original' ? 'translated' : 'original';
      if (translatePair.showing === 'original') translatePair.original = ocrText.value;
      else translatePair.translated = ocrText.value;
      renderOcrSide(translatePair, next);
      return;
    }
    // 无译文：翻译文本区中已识别的文本
    const sourceText = (ocrText.value || '').trim();
    if (!sourceText || sourceText === tCapture('noTextFound')) return;
    await translatePanelText(sourceText);
  });
}

// 目标语言下拉：读取持久化值（默认中文），变更即写回 store；已有译文时自动按新语言重译
(async () => {
  if (!ocrTargetLang) return;
  try {
    const stored = await ipcRenderer.invoke('store:read', 'screenshot-text-translate-target-lang');
    if (typeof stored === 'string' && stored) ocrTargetLang.value = stored;
  } catch { /* 读不到就用默认 zh */ }
  ocrTargetLang.addEventListener('change', () => {
    try {
      void ipcRenderer.invoke('store:write', 'screenshot-text-translate-target-lang', ocrTargetLang.value);
    } catch { /* 持久化失败不影响本次使用 */ }
    retranslatePanelIfAny();
  });
})();

// 图片翻译二级面板目标语言：读取持久化值（默认中文），变更即写回 store（runImageTranslation 读取同一键）
(async () => {
  if (!translateTargetLang) return;
  try {
    const stored = await ipcRenderer.invoke('store:read', 'screenshot-translate-target-lang');
    if (typeof stored === 'string' && stored) translateTargetLang.value = stored;
  } catch { /* 读不到就用默认 zh */ }
  translateTargetLang.addEventListener('change', () => {
    try {
      void ipcRenderer.invoke('store:write', 'screenshot-translate-target-lang', translateTargetLang.value);
    } catch { /* 持久化失败不影响本次使用 */ }
  });
})();

btnOcrClose.addEventListener('click', () => {
  resetOcrResult();
  showToolbar();
  updateSizeInfo(selX, selY);
});

/**
 * 执行图片翻译（工具栏翻译按钮）：译文叠图直接贴回选区（「显示在原图上」），
 * 同时译文文本写入 OCR 浮窗方便复制；无叠图数据时降级为纯文本面板展示。
 */
async function runImageTranslation() {
  const originalImage = cropSelectionWithAnnotations();
  if (!originalImage) return;

  isTranslating = true;
  hideToolbar();
  sizeInfo.style.display = 'none';
  showTranslateOverlay(tCapture('translating'));

  try {
    const [storedSourceLang, storedTargetLang] = await Promise.all([
      ipcRenderer.invoke('store:read', 'screenshot-translate-source-lang'),
      ipcRenderer.invoke('store:read', 'screenshot-translate-target-lang'),
    ]);
    const sourceLanguage = typeof storedSourceLang === 'string' && storedSourceLang ? storedSourceLang : 'auto';
    // 目标语言由二级面板选择并持久化；未设置过时默认中文
    const targetLanguage = typeof storedTargetLang === 'string' && storedTargetLang ? storedTargetLang : 'zh';

    let result;
    if (translateEngine !== 'server') {
      // 本机 Hy-MT2 / 云端百度翻译：都走本地服务 IPC（主进程按引擎配置决定 provider）
      result = await ipcRenderer.invoke('capture-translate-local', {
        dataURL: originalImage,
        targetLanguage,
      });
    } else {
      const token = await ipcRenderer.invoke('store:read', 'user-account-token');
      if (typeof token !== 'string' || !token.trim()) {
        throw new Error(tCapture('loginRequired'));
      }
      result = await ipcRenderer.invoke('capture-translate', {
        dataURL: originalImage,
        token,
        sourceLanguage,
        targetLanguage,
      });
    }
    if (!result?.success) {
      const errorCode = result?.code;
      const fallbackMsg = errorCode && tCapture(errorCode) !== errorCode
        ? tCapture(errorCode)
        : tCapture('translateFailed');
      throw new Error(result?.message || fallbackMsg);
    }
    const translatedImage = typeof result.translatedImage === 'string' ? result.translatedImage : '';
    const translatedText = typeof result.translatedText === 'string' ? result.translatedText : '';
    // 两条路径都没数据 → 视为失败
    if (!translatedImage && !translatedText) {
      throw new Error(result?.message || tCapture('translateFailed'));
    }
    // 先把「原文」状态快照入历史栈（旧代码误调未定义的 pushHistory()，会导致
    // 翻译成功也抛 ReferenceError 走 catch → 永远提示失败），随后绘制译文。
    commitHistory();
    if (translatedImage) {
      // 图片覆盖路径：把"原文 + 译文叠图"贴到选区画布（译文直接显示在原图上）
      await renderSelectionImage(translatedImage);
      translationCache = { originalImage, translatedImage };
    } else {
      // 本地纯文本降级（字体缺失 / 翻译为空）：不覆盖选区，
      // 让用户在 OCR 浮窗里看清晰可调的译文
      translationCache = { originalImage, translatedImage: '' };
    }
    displayedImageVersion = 'translated';
    updateTranslateButtonLabel();
    // 始终把译文文本写进 OCR 浮窗的扩展区（即使走了图片覆盖路径也展示，方便复制）
    showTranslateText(translatedText);
    // 纯文本 / 文字面板模式：主动把 OCR 浮窗拉到前台，确保用户看到译文
    if (!translationCache.translatedImage && translatedText) {
      ocrPanel.style.display = 'flex';
      positionOcrPanel();
    }
    hideTranslateOverlay();
  } catch (error) {
    showTranslateOverlay(error instanceof Error ? error.message : tCapture('translateFailed'), true);
    await new Promise((resolve) => window.setTimeout(resolve, 2200));
    hideTranslateOverlay();
  } finally {
    isTranslating = false;
    showToolbar();
    updateTranslateButtonLabel();
    updateSizeInfo(selX, selY);
  }
}

btnTranslate.addEventListener('click', async (e) => {
  // 点击右下角 ▾ 三角只展开/收起语言二级面板，不触发翻译
  if (isCaretHit(e, btnTranslate)) {
    if (isTranslateMenuOpen()) closeTranslateMenu();
    else openTranslateMenu();
    return;
  }
  closeTranslateMenu();
  if (isCaptureBusy() || state !== STATE.SELECTED) return;

  if (translationCache) {
    isTranslating = true;
    try {
      await toggleCachedTranslation();
    } finally {
      isTranslating = false;
    }
    return;
  }

  await runImageTranslation({});
});

document.getElementById('btnSave').addEventListener('click', () => {
  const dataURL = cropSelectionWithAnnotations();
  if (dataURL) {
    const _lsFn = lsGetSaveFilename();
    ipcRenderer.send('capture-save', _lsFn ? { dataURL, filename: _lsFn } : { dataURL });
  }
});

document.getElementById('btnCancel').addEventListener('click', () => {
  ipcRenderer.send('capture-cancel');
});

/* ── 左下角操作指引：内容随状态刷新；光标靠近自动淡出、移开重现 ── */
let guideLastHtml = '';
function updateGuideContent() {
  if (!captureGuide) return;
  const lines = [];
  if (!isCaptureBusy() && ocrPanel.style.display !== 'flex') {
    if (state === STATE.IDLE) {
      lines.push(`<b>${tCapture('guideStart')}</b>`);
    } else if (state === STATE.SELECTED) {
      const over = hoverAnnotIndex >= 0 && !!annotations[hoverAnnotIndex];
      lines.push(`<b>${tCapture(over ? 'guideNudgeAnnot' : 'guideNudgeSel')}</b>`);
      lines.push(tCapture('guideDblEdit'));
      lines.push(tCapture('guideFinish'));
    }
  }
  const html = lines.map((l) => `<span class="cg-line">${l}</span>`).join('');
  if (html !== guideLastHtml) {
    guideLastHtml = html;
    if (html) {
      captureGuide.style.display = 'flex';
      captureGuide.innerHTML = html;
      // 内容变了 → 盒尺寸可能变，这里量一次（内容切换是低频事件，量一次无所谓）。
      // 绝不能在 rAF 里每帧 getBoundingClientRect —— 那是强制同步布局，拖动会掉帧。
      measureGuideBox();
    } else {
      captureGuide.style.display = 'none';
      guideBox = null;
    }
  }
}

// 指引条矩形缓存：仅在内容/尺寸变化时重算
let guideBox = null;
function measureGuideBox() {
  if (!captureGuide || captureGuide.style.display === 'none') { guideBox = null; return; }
  const r = captureGuide.getBoundingClientRect();
  guideBox = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
}

let guideLastPx = -1;
let guideLastPy = -1;
let guideRaf = 0;
window.addEventListener('pointermove', (e) => {
  guideLastPx = e.clientX;
  guideLastPy = e.clientY;
  updateGuideContent();
  if (guideRaf) return;
  guideRaf = requestAnimationFrame(() => {
    guideRaf = 0;
    if (!captureGuide || captureGuide.style.display === 'none') return;
    const r = guideBox;
    if (!r) return;
    const PAD = 72; // 靠近（含感应区）→ 淡出，避免挡住光标下的操作
    const near = guideLastPx >= r.left - PAD && guideLastPx <= r.right + PAD
      && guideLastPy >= r.top - PAD && guideLastPy <= r.bottom + PAD;
    captureGuide.classList.toggle('is-away', near);
  });
}, { passive: true });
updateGuideContent();

/* ── 方向键微调：1px / Shift = 10px；光标悬停对象时优先微调该对象 ── */
function moveSelectionBy(dx, dy) {
  const nx = Math.max(0, Math.min(selX + dx, Math.max(0, W - selW)));
  const ny = Math.max(0, Math.min(selY + dy, Math.max(0, H - selH)));
  if (nx === selX && ny === selY) return;
  selX = nx;
  selY = ny;
  drawMask();
  updateSizeInfo(selX, selY);
}

let nudgeIdx = -1;
let nudgeBase = null;
let nudgeTimer = null;
function finishNudgeCommit() {
  if (nudgeTimer) {
    clearTimeout(nudgeTimer);
    nudgeTimer = null;
  }
  if (nudgeIdx < 0) return;
  const a = annotations[nudgeIdx];
  const b = nudgeBase;
  const moved = a && b && (a.type === 'text'
    ? (a.x !== b.x || a.y !== b.y)
    : (a.x1 !== b.x1 || a.y1 !== b.y1 || a.x2 !== b.x2 || a.y2 !== b.y2));
  if (moved) commitHistory(false);
  nudgeIdx = -1;
  nudgeBase = null;
}
function nudgeAnnotBy(dx, dy) {
  if (nudgeIdx < 0) {
    nudgeIdx = hoverAnnotIndex >= 0 ? hoverAnnotIndex : -1;
    if (nudgeIdx < 0 || !annotations[nudgeIdx]) return false;
    nudgeBase = cloneAnnots([annotations[nudgeIdx]])[0];
  }
  const a = annotations[nudgeIdx];
  if (!a) return false;
  const bb = annotBounds(a);
  const maxX = Math.max(selX, selX + selW - bb.w);
  const maxY = Math.max(selY, selY + selH - bb.h);
  const nx = Math.min(Math.max(bb.x + dx, selX), maxX);
  const ny = Math.min(Math.max(bb.y + dy, selY), maxY);
  const adx = nx - bb.x;
  const ady = ny - bb.y;
  if (!adx && !ady) return true; // 已到选区边界
  if (a.type === 'text') {
    a.x += adx;
    a.y += ady;
  } else {
    a.x1 += adx;
    a.y1 += ady;
    a.x2 += adx;
    a.y2 += ady;
  }
  renderAnnots();
  if (nudgeTimer) clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(finishNudgeCommit, 650); // 连续按键合并为一次撤销步骤
  return true;
}

document.addEventListener('keydown', (e) => {
  // 文字编辑器（in-place textarea）打开时：Esc 销毁编辑器但不离场
  const isTextEditorFocused = !!textEditor && document.activeElement === textEditor;
    if (e.key === 'Escape') {
      // 优先级：长截图/录屏中（先停）→ 文字编辑器 → 取色器 → 打码面板 → 图形面板 → OCR 面板 → PICKING 态 → 退出截图
      if (longShotActive) { stopLongScreenshot(false); return; }
      if (isRecording) { stopRecording(); return; }
      if (isTextEditorFocused) {
      cancelTextEditor();
    } else if (textEditor) {
      cancelTextEditor();
    } else if (isMaskMenuOpen()) {
      closeMaskMenu();
    } else if (isShapeMenuOpen()) {
      closeShapeMenu();
    } else if (isRecognizing) {
      // OCR 进行中（尤其「保留格式」首次要下载模型，可能等数分钟）：Esc 只取消识别并回编辑器，不离场
      cancelOcrNow();
    } else if (ocrPanel.style.display === 'flex') {
      resetOcrResult();
      showToolbar();
      updateSizeInfo(selX, selY);
    } else if (state === STATE.PICKING) {
      closePickerOverlay();
      sizeInfo.style.display = 'none';
      state = STATE.SELECTED;
      showToolbar();
    } else if (state === STATE.MOVING && dragAnnotIndex >= 0) {
      // 拖动单个对象中按 Esc：还原到按下瞬间的位置，不留下这次移动
      if (dragBase) annotations[dragAnnotIndex] = cloneAnnots([dragBase])[0];
      dragAnnotIndex = -1;
      dragBase = null;
      renderAnnots();
      state = STATE.SELECTED;
      showToolbar();
      updateSizeInfo(selX, selY);
    } else {
      ipcRenderer.send('capture-cancel');
    }
    return;
  }
  if (isTextEditorFocused) {
    // 文字编辑器聚焦中：其余按键交给 textarea 默认行为（IME、复制粘贴、删除等）
    return;
  }
  if (state === STATE.PICKING && (e.key === 'Enter' || e.key === ' ')) {
    // PICKING 状态下按 Enter/Space 也可快速完成取色并退出
    e.preventDefault();
    return;
  }
  if (e.key === 'Enter' && state === STATE.SELECTED && ocrPanel.style.display !== 'flex') {
    confirmCapture(cropSelectionWithAnnotations());
    return;
  }
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (ctrl && key === 'z') {
    // Ctrl+Z 撤销
    if (!e.shiftKey && state === STATE.SELECTED) {
      resetTranslationCache();
      undoLast();
    } else if (e.shiftKey && state === STATE.SELECTED) {
      // Ctrl+Shift+Z 重做
      redoLast();
      drawMask();
    }
    return;
  }
  if (ctrl && key === 'y') {
    // Ctrl+Y 重做
    if (state === STATE.SELECTED) {
      redoLast();
      drawMask();
    }
    return;
  }
  if (ctrl && key === 'c' && state === STATE.SELECTED && ocrPanel.style.display !== 'flex') {
    // Ctrl+C 复制完成（同“完成”按钮：复制并关闭）
    const dataURL = cropSelectionWithAnnotations();
    if (dataURL) ipcRenderer.send('capture-complete', { dataURL });
  }
  if (!ctrl && !e.metaKey && !e.altKey
      && (key === 'arrowup' || key === 'arrowdown' || key === 'arrowleft' || key === 'arrowright'
        || key === 'w' || key === 'a' || key === 's' || key === 'd')
      && state === STATE.SELECTED && !isCaptureBusy() && ocrPanel.style.display !== 'flex' && !textEditor) {
    // 方向键 / WASD 微调（1px / Shift=10px）：悬停对象 → 微调对象，否则微调选区。
    // ⚠️ key 已在小写化（上方 toLowerCase），必须与全小写字面量比较——旧代码写成 'ArrowUp'
    //    驼峰，永不匹配，微调从未生效（2026-09-04 用户反馈根因）。
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const dx = (key === 'arrowleft' || key === 'a') ? -step : (key === 'arrowright' || key === 'd') ? step : 0;
    const dy = (key === 'arrowup' || key === 'w') ? -step : (key === 'arrowdown' || key === 's') ? step : 0;
    const overIdx = hoverAnnotIndex >= 0 && annotations[hoverAnnotIndex] ? hoverAnnotIndex : -1;
    if (overIdx >= 0) {
      nudgeAnnotBy(dx, dy);
    } else {
      finishNudgeCommit(); // 已离开对象：把连续 nudge 收成一步历史
      moveSelectionBy(dx, dy);
    }
    updateGuideContent();
    return;
  }
});

window.addEventListener('resize', () => {
  // 视口变了 → 依赖 CSS 量出来的盒尺寸缓存全部失效（下一帧重新量一次）
  invalidateMagnifierBox();
  guideBox = null;
  initCanvases();
  if (state !== STATE.IDLE) {
    if (isCaptureBusy()) {
      hideToolbar();
      positionTranslateOverlay();
      sizeInfo.style.display = 'none';
    } else if (ocrPanel.style.display === 'flex') {
      hideToolbar();
      positionOcrPanel();
      sizeInfo.style.display = 'none';
    } else {
      showToolbar();
      updateSizeInfo(selX, selY);
    }
  } else {
    sizeInfo.style.display = 'none';
    hideToolbar();
  }
});

window.addEventListener('beforeunload', () => {
  releaseCaptureResources();
});

// 屏蔽浏览器右键菜单（截图工具全程不弹系统菜单，右键用于退出选区）
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
});

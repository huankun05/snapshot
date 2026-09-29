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
// 探测点（2026-09-25）：脚本入口。若此处打点出现在主进程日志，说明页面/脚本已成功加载执行；
// 无此打点 = 页面加载失败（历史根因：capture.html 路径 ERR_FILE_NOT_FOUND → 渲染端无 JS）。
console.error(`[cap] capture.js script start t=${Date.now()} dpr=${window.devicePixelRatio}`);
// ⚠️ Electron 新版已把 desktopCapturer 从渲染进程移除（require 拿到 undefined），
// 取桌面屏幕源必须经主进程 IPC（'capture-desktop-sources'），见 getDesktopSource()。
/**
 * 取桌面屏幕源（长截图/录屏共用）：走主进程 desktopCapturer（渲染端已不可用）。
 * 多显示器按光标截屏：优先按截图窗所在屏匹配源；旧主进程无该通道时退全量列表首项。
 * @returns {Promise<{id:string,name:string}|null>}
 */
async function getDesktopSource() {
  try {
    const matched = await ipcRenderer.invoke('capture-desktop-source-for-window');
    if (matched) return matched;
  } catch (_) { /* 通道不存在（旧打包）→ 走旧路径 */ }
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
/** 智能框选诊断日志总开关（PETALSNAP_SMART_DEBUG=1 开启）：SEED/TINY/APPLY/DIAG/FOLLOW/
 *  HOV-DBG/smartLevel 等排查日志默认静默，异常告警（SMART-GUARD）不受此控 */
const SMART_DEBUG = process.env.PETALSNAP_SMART_DEBUG === '1';

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
const maskCanvas = document.getElementById('maskCanvas');
const maskCtx = maskCanvas ? maskCanvas.getContext('2d') : null;
const guideCanvas = document.getElementById('guide-canvas');
const guideCtx = guideCanvas ? guideCanvas.getContext('2d') : null;
const captureHandles = document.getElementById('captureHandles');
/** 待确认矢量对象的 8 方向缩放手柄层（纯 DOM：不参与导出，不进截图结果） */
const annotHandles = document.getElementById('annotHandles');
/** 旋转手柄（仅文字对象显示；随手柄容器一起 CSS 旋转） */
const annotRotateHandle = annotHandles ? annotHandles.querySelector('.capture-annot-rotate') : null;
/** 删除按钮（仅文字对象显示；吊在选框右上角外，对齐参考图） */
const annotDeleteHandle = annotHandles ? annotHandles.querySelector('.capture-annot-delete') : null;

const bgCtx = bgCanvas.getContext('2d');
const drawCtx = drawCanvas.getContext('2d');
const annotCtx = annotCanvas ? annotCanvas.getContext('2d') : null;
const tempCtx = tempCanvas.getContext('2d');

const sizeInfo = document.getElementById('size-info');
const selectBar = document.getElementById('selectBar');
const sbSize = document.getElementById('sbSize');
const magCoords = document.getElementById('magCoords');
const magSwatch = document.getElementById('magSwatch');
const magHex = document.getElementById('magHex');
const toolbar = document.getElementById('toolbar');
/** 用户拖过工具栏后不再自动贴选区（Shotera 同款「钉住」语义） */
let toolbarUserMoved = false;
/** Alt 准线常显开关：点按 Alt 切换（Slack 式对齐辅助），会话开始/结束时归位 */
let guidesOn = false;
/**
 * Shift 键当前是否按下。Shift 在本轮承担两个语义（2026-09-25）：
 *  ① 矩形/椭圆拖拽 → 正方向约束（正方形/正圆）；
 *  ② 直线/箭头/曲线箭头 → 多点连续画（单击落中间点，松开 Shift 单击收尾）。
 * 每次 pointer/key 事件都用事件自带的修饰键状态刷新它（比只靠 keydown/keyup 更可靠：
 * 窗口失焦或焦点切换时 keyup 会丢，用 blur 兜底归零，避免状态卡死）。
 */
let modShiftDown = false;
/** 多点折线进行中的顶点序列（null = 未进行）。整条折线是**一个**对象，避免多段各自带箭头 */
let polyPoints = null;
/** 进行中的折线在 annotations 里的下标（-1 = 无）；该对象带 live 标记，不参与命中、不进历史栈 */
let polyLiveIdx = -1;
document.addEventListener('keydown', (e) => { if (e.key === 'Shift') modShiftDown = true; });
document.addEventListener('keyup', (e) => { if (e.key === 'Shift') modShiftDown = false; });
window.addEventListener('blur', () => { modShiftDown = false; });
const colorPicker = document.getElementById('colorPicker');
const colorPalette = document.getElementById('colorPalette');
const sizeSlider = document.getElementById('sizeSlider');
const sizeValue = document.getElementById('sizeValue');
/** 文字样式条（Snipaste 式：加粗 / 斜体 / 字体），仅文字工具或待确认文字对象时出现 */
const textStyleRow = document.getElementById('textStyleRow');
const btnTextBold = document.getElementById('btnTextBold');
const btnTextItalic = document.getElementById('btnTextItalic');
const textFontSelect = document.getElementById('textFontSelect');
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
const penBtn = document.getElementById('btnPen');
const penIcon = document.getElementById('penIcon');
const penMenu = document.getElementById('penMenu');
const penItems = Array.from(penMenu ? penMenu.querySelectorAll('.capture-shape-item') : []);
const shapeBtn = document.getElementById('btnShape');
const shapeIcon = document.getElementById('shapeIcon');
const shapeMenu = document.getElementById('shapeMenu');
const shapeItems = Array.from(shapeMenu ? shapeMenu.querySelectorAll('.capture-shape-item') : []);
/** 图形面板的「描边 / 填充」两态按钮（仅矩形、椭圆可用） */
const shapeFillRow = document.getElementById('shapeFillRow');
const shapeFillBtns = shapeFillRow ? Array.from(shapeFillRow.querySelectorAll('.capture-mask-mode-btn')) : [];
const maskBtn = document.getElementById('btnMask');
const maskIcon = document.getElementById('maskIcon');
const maskMenu = document.getElementById('maskMenu');
const maskItems = Array.from(maskMenu ? maskMenu.querySelectorAll('.capture-shape-item') : []);
const maskStrength = document.getElementById('maskStrength');
const maskStrengthValue = document.getElementById('maskStrengthValue');
const maskStrengthLabel = document.getElementById('maskStrengthLabel');
/** 打码二级面板的圆头 / 方头 笔刷形状按钮 */
const maskModeBtns = maskMenu ? Array.from(maskMenu.querySelectorAll('.capture-mask-mode-btn')) : [];
/** 橡皮擦按钮 + 二级面板（细擦 / 框选擦） */
const eraserBtn = document.getElementById('btnEraser');
const eraserMenu = document.getElementById('eraserMenu');
const eraserModeBtns = eraserMenu ? Array.from(eraserMenu.querySelectorAll('.capture-mask-mode-btn')) : [];
/** 取色器持续色环浮层（按住时跟随光标显示，松开自动关闭） */
const pickerOverlay = document.getElementById('pickerOverlay');
const pickerSwatch = document.getElementById('pickerSwatch');
const pickerHex = document.getElementById('pickerHex');
const pickerRgb = document.getElementById('pickerRgb');
/** 笔刷预览圈：pen / 打码系列 工具激活且光标在选区内时跟随鼠标显示 */
const brushCursor = document.getElementById('brushCursor');
/** 文字工具：JS 动态创建的 textarea（完全隐形：透明背景、无边框，仅保留 caret 主题蓝） */
let textEditor = null;
/** 手势进行中的最新鼠标位置（annotResizeGestureBox 跟手显示用） */
let lastGestureMouse = null;
/** 文字「按下待定」状态：拖动超阈值 = 移动，原地点击 = 编辑（Snipaste 语义） */
let pendingTextEdit = null;
/** 是否落在选框边框 ±6px 带内（任意工具下拖动选框用） */
function nearSelectionBorder(mx, my) {
  const B = 6;
  const nearX = (mx >= selX - B && mx <= selX + selW + B);
  const nearY = (my >= selY - B && my <= selY + selH + B);
  const onV = nearY && (Math.abs(mx - selX) <= B || Math.abs(mx - (selX + selW)) <= B);
  const onH = nearX && (Math.abs(my - selY) <= B || Math.abs(my - (selY + selH)) <= B);
  return onV || onH;
}
/** 编辑态拖框待定：textarea 正文按下后，移动超阈值 = 拖动编辑框，原地点击 = 放光标 */
let editorDragPending = null;
let textEditorHint = null;

let bgImage = null;
let W = 0;
let H = 0;
let scaleFactor = 1;
let captureDisplays = [];
let captureVirtualScreen = null;
let capturePhysicalScreen = null;
/** 「截图并复制」热键：框选完成即复制退出，不进工具栏 */
let captureAutoCopy = false;

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
/** 当前绘制色。默认取色板里已有的红（#e5484d）——若用色板外的红，默认态色板匹配不到格子、看不出选中环 */
let drawingColor = '#e5484d';
let drawingSize = 4;
/**
 * 「粗细」按工具分组记忆（2026-09-25 用户要求：各工具沿用自己上次用过的大小）。
 * - 画笔 / 高亮 / 橡皮擦 / 四种打码各自独立（语义差别大：笔宽 vs 块大小 vs 擦除宽）
 * - 图形类（直线·矩形·椭圆·箭头·曲线）共用一份「线宽」
 */
const SIZE_GROUPS = {
  pen: 'pen',
  highlight: 'highlight',
  eraser: 'eraser',
  mosaic: 'mosaic',
  blur: 'blur',
  noise: 'noise',
  solid: 'solid',
  line: 'shape',
  rect: 'shape',
  ellipse: 'shape',
  arrow: 'shape',
  curve: 'shape',
};
const DEFAULT_SIZES = {
  pen: 4, highlight: 24, eraser: 12,
  mosaic: 12, blur: 20, noise: 12, solid: 20,
  shape: 4,
};
const TOOL_SIZE_KEY = 'petalsnap.toolSizes';
/** 各分组「上次使用的粗细」，持久化在 localStorage（重启应用也记得） */
const toolSizes = { ...DEFAULT_SIZES };
try {
  const saved = JSON.parse(localStorage.getItem(TOOL_SIZE_KEY) || 'null');
  if (saved && typeof saved === 'object') {
    for (const [k, v] of Object.entries(saved)) {
      if (k in DEFAULT_SIZES && Number.isFinite(v)) toolSizes[k] = Math.max(1, Math.min(60, v));
    }
  }
} catch { /* 本地数据损坏时忽略，用默认值 */ }
// store 镜像回读（脚本加载期 ipcRenderer 可能尚未就绪 → 延到 loadAppSettings 里做）

function persistToolSizes() {
  try { localStorage.setItem(TOOL_SIZE_KEY, JSON.stringify(toolSizes)); } catch { /* 忽略写入失败 */ }
  // 双保险：镜像到应用 store（用户反馈粗细不沿用——localStorage 在部分会话里不可靠）
  try { ipcRenderer.invoke('store:write', 'petalsnap.tool-sizes', JSON.stringify(toolSizes)).catch(() => {}); } catch { /* ignore */ }
}

/** 粗细滑块与数值跟随 drawingSize（切工具 / 滚轮 / 直接设值后统一走这里） */
function syncSizeSliderUI() {
  if (sizeSlider) sizeSlider.value = String(drawingSize);
  if (sizeValue) sizeValue.textContent = `${drawingSize}px`;
}

/** 把当前 drawingSize 记到 activeTool 所属分组 */
function rememberToolSize() {
  const g = SIZE_GROUPS[activeTool];
  if (!g) return;
  toolSizes[g] = drawingSize;
  persistToolSizes();
}

/** 唯一的粗细写入口：clamp → 记进当前工具分组 → 同步滑块 */
function setDrawingSize(px) {
  drawingSize = Math.max(1, Math.min(60, Math.round(px) || 1));
  rememberToolSize();
  syncSizeSliderUI();
}

/** 切工具：把粗细存回上一工具的分组，并载入新工具分组的粗细 */
function switchSizeGroup(prevTool, nextTool) {
  const prev = SIZE_GROUPS[prevTool];
  const next = SIZE_GROUPS[nextTool];
  if (prev) toolSizes[prev] = drawingSize;
  if (next && next !== prev) drawingSize = toolSizes[next] ?? DEFAULT_SIZES[next] ?? 4;
  persistToolSizes();
  syncSizeSliderUI();
}
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
/** 当前默认画笔（按钮图标与点击后使用的工具）：pen / highlight（半透明马克笔） */
let penTool = 'pen';

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
/**
 * 位图笔画记录（橡皮擦/撤销的依据）：
 * pen / highlight / 打码笔刷 每笔存 points 等可重放数据；打码「框选」存 rect。
 * preData 引用该笔开始前历史栈顶的 ImageData（只读共享，不产生新拷贝）——
 * 橡皮擦据此恢复"此笔之前"的位图，再按序重放其后笔画，实现整笔擦除。
 * 快照历史（commitHistory）里随 annots 一起深拷贝一份，保证 undo/redo 后仍可擦。
 */
let strokes = [];
/** 橡皮擦悬停命中的位图笔画下标；-1 = 未命中 */
let hoverStrokeIndex = -1;
/**
 * 橡皮擦方式（2026-09-25）：
 *  · 'brush'（默认）细擦 —— 按住拖动做像素级挖空（destination-out），能擦掉笔迹的一部分；
 *  · 'rect'           框选擦 —— 拖一个矩形，松手把该区域整块清除（像素 + 压线的图形对象）。
 * 两种方式下 Shift + 点击都是「整笔 / 整对象」一次删除。
 */
let eraserMode = 'brush';
/**
 * 本笔是否为「Shift 拉直线」模式：拖动期间只在 tempCanvas 预览，
 * 松手才一次性落笔（起点 → 终点），避免逐点像素无法回退。
 */
let strokeStraight = false;
/** 正在画的位图笔画记录（pointerdown 创建，mouseup 收进 strokes） */
let curStroke = null;
/** 用户是否手动换过颜色（高亮工具首次激活时若非手动配色则切到默认黄） */
let colorPickedByUser = false;
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
/** openTextEditor 压入的那条历史快照下标（-1 = 没有）。
 *  它的语义是「本次文字编辑之前的状态」，所以：
 *  · 空提交（什么都没打）→ 只把这条快照摘掉，**不能** restore 下面的快照；
 *  · 右键取消 → 恢复到这条快照本身（而不是它下面那条）。
 *  2026-09-26：旧实现两种情形都 restores 下面那条，导致「新建文字后点两次空白，
 *  文字连同像素一起消失」「改完文字点两次空白，退回改动前的内容」。 */
let editorSnapIndex = -1;
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
const MAGNIFIER_ZOOM = 8;
const MAGNIFIER_SIZE = 132;
/** 色号显示格式：hex | rgb | hsv（Shift 循环） */
let colorFormat = 'hex';
let lastPickedColor = '#FFFFFF';
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
      highlight: '高亮',
      eraser: '橡皮擦',
      curve: '曲线箭头',
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
      maskLasso: '套索',
      brushSize: '笔刷大小',
      strengthDisabled: '—',
      undo: '撤销',
      redo: '重做',
      pin: '贴图：把选区贴到桌面',
      pinnedHint: '已贴到桌面 · 拖动移动 · 滚轮缩放 · Shift+滚轮仅宽 · Alt+滚轮仅高 · 点 × 销毁',
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
      // 键帽指引文案（updateGuideContent 内联使用；保留 i18n 键便于后续切语言）
      guideDrag: '框选区域',
      guideClick: '选中智能框',
      guideCycleLevel: '切换检测层级',
      guideCopyColor: '复制色号',
      guideShiftFormat: '切换 HEX / RGB / HSV',
      guideCancel: '退出这一层',
      guideUndoStep: '撤销上一步',
      guideNudge: '移动选区',
      guideExpandEdge: '扩大选区（单边）',
      guideNudge10: '以 10px 步进',
      // Shift 双语义（2026-09-25）：正方向约束 / 多点折线
      guideSquare: '画正方形 / 正圆',
      guidePoly: '多点连续，松开 Shift 后单击收尾',
      guidePolyAdd: '落一个中间点',
      guidePolyAbort: '放弃这条折线',
      // 笔刷类工具（2026-09-25）：Shift 拉直线 / 粗细 / 橡皮擦
      guideStraight: '拉成直线',
      guideSize: '调整画笔 · 线宽',
      guideEraseFine: '按住拖动细擦',
      guideEraseWhole: '整笔 / 整对象擦除',
      guideEraseArea: '拖矩形，整块清除',
      eraserBrush: '细擦',
      eraserRect: '框选擦',
      guideLasso: '自由圈选，松手自动闭合',
      shapeStroke: '描边',
      shapeFill: '填充',
      guideDone: '完成',
      guideSave: '保存',
      captureInputText: '输入文字',
      // 文字样式条（B / I / 字体）：字号沿用「粗细」滑块，颜色沿用色板
      textBold: '加粗',
      textItalic: '斜体',
      textFont: '字体',
      fontYahei: '微软雅黑',
      fontSimsun: '宋体',
      fontSimhei: '黑体',
      fontKaiti: '楷体',
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
      highlight: 'Highlight',
      eraser: 'Eraser',
      curve: 'Curved arrow',
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
      maskLasso: 'Lasso',
      brushSize: 'Brush size',
      strengthDisabled: '—',
      undo: 'Undo',
      redo: 'Redo',
      pin: 'Pin: pin selection to desktop',
      pinnedHint: 'Pinned · drag to move · scroll to zoom · Shift+scroll width only · Alt+scroll height only · × to destroy',
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
      guideDrag: 'Drag to select region',
      guideClick: 'Click to lock smart box',
      guideCycleLevel: 'Cycle detection level',
      guideCopyColor: 'Copy color',
      guideShiftFormat: 'Switch HEX / RGB / HSV',
      guideCancel: 'Exit this layer',
      guideUndoStep: 'Undo last step',
      guideNudge: 'Move selection',
      guideExpandEdge: 'Expand edge',
      guideNudge10: 'Nudge by 10px',
      // Shift 双语义（2026-09-25）：正方向约束 / 多点折线
      guideSquare: 'Square / circle',
      guidePoly: 'Multi-point; click after releasing Shift to finish',
      guidePolyAdd: 'Drop an intermediate point',
      guidePolyEnd: 'Release Shift + click',
      guidePolyAbort: 'Discard this polyline',
      guideStraight: 'Snap to a straight line',
      guideSize: 'Adjust brush / line width',
      guideEraseFine: 'Hold and drag to fine-erase',
      guideEraseWhole: 'Erase a whole stroke / object',
      guideEraseArea: 'Drag a box to wipe it clean',
      eraserBrush: 'Fine',
      eraserRect: 'Box',
      guideLasso: 'Draw freely; closes on release',
      shapeStroke: 'Stroke',
      shapeFill: 'Fill',
      guideDone: 'Finish',
      guideSave: 'Save',
      guideNudgeSel: '↑↓←→ / WASD nudge selection · Shift = 10px',
      guideNudgeAnnot: '↑↓←→ nudge hovered object · Shift = 10px',
      guideDblEdit: 'Double-click text/shape to edit again',
      guideFinish: 'Enter to finish · Esc to cancel',
      captureInputText: 'Enter text',
      // 文字样式条（B / I / 字体）
      textBold: 'Bold',
      textItalic: 'Italic',
      textFont: 'Font',
      fontYahei: 'Microsoft YaHei',
      fontSimsun: 'SimSun',
      fontSimhei: 'SimHei',
      fontKaiti: 'KaiTi',
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
  syncPenButton();
  syncShapeButton();
  syncMaskButton();
  if (textEditor) {
    textEditor.placeholder = ''; // 2026-09-29 用户要求：不显示"输入文字"占位
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
    const stored = await ipcRenderer.invoke('store:read', 'screenshot-ocr-engine');
    ocrEngine = stored === 'paddleocr' || stored === 'server' ? stored : 'local';
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

/* ── 设置窗收编的行为开关（store 读入；默认与设置窗一致） ── */
const APP_SETTINGS = {
  ocrDefaultAction: 'text',
  tableCopyFormat: 'html',
  smartHeadings: true,
  lsAutoscroll: true,
  lsStep: 'standard',
  lsOnDone: 'editor',
  recCountdown: 3,
  recQuality: 'balanced',
  translateRender: 'overlay',
};

async function loadAppSettings() {
  const keys = [
    ['ocrDefaultAction', 'screenshot-ocr-default-action', 'text'],
    ['tableCopyFormat', 'screenshot.table-copy-format', 'html'],
    ['smartHeadings', 'screenshot.smart-headings', true],
    ['lsAutoscroll', 'screenshot.ls-autoscroll', true],
    ['lsStep', 'screenshot.ls-step', 'standard'],
    ['lsOnDone', 'screenshot.ls-on-done', 'editor'],
    ['recCountdown', 'screenshot.rec-countdown', 3],
    ['recQuality', 'screenshot.rec-quality', 'balanced'],
    ['translateRender', 'screenshot.translate-render', 'overlay'],
  ];
  try {
    await Promise.all(keys.map(async ([name, key, def]) => {
      const v = await ipcRenderer.invoke('store:read', key);
      APP_SETTINGS[name] = (v === undefined || v === null) ? def : v;
    }));
  } catch { /* ignore */ }
  // 粗细分组 store 镜像回读（localStorage 失效时的持久化兜底，见 persistToolSizes）
  try {
    const raw = await ipcRenderer.invoke('store:read', 'petalsnap.tool-sizes');
    const saved = raw ? JSON.parse(raw) : null;
    if (saved && typeof saved === 'object') {
      for (const [k, v] of Object.entries(saved)) {
        if (k in DEFAULT_SIZES && Number.isFinite(v)) toolSizes[k] = Math.max(1, Math.min(60, v));
      }
      drawingSize = toolSizes[SIZE_GROUPS[activeTool]] ?? drawingSize;
      syncSizeSliderUI();
    }
  } catch { /* ignore */ }
  // 长截图默认自动滚动：同步会话内变量
  lsAutoScrollOn = APP_SETTINGS.lsAutoscroll !== false;
  if (btnLongShotAuto) {
    btnLongShotAuto.textContent = lsAutoScrollOn ? '自动滚动：开' : '自动滚动：关';
  }
  // 步长 → lsAutoTargetFrac（密集 0.28 / 标准 0.35 / 更快 0.45）
  if (APP_SETTINGS.lsStep === 'dense') lsAutoTargetFrac = 0.28;
  else if (APP_SETTINGS.lsStep === 'fast') lsAutoTargetFrac = 0.45;
  else lsAutoTargetFrac = 0.35;
  console.error('[settings] loaded', JSON.stringify(APP_SETTINGS));
}

void loadAppSettings();

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
  [bgCanvas, drawCanvas, annotCanvas, tempCanvas, guideCanvas].forEach(setupCanvasDpr);
  drawBackground();
  // 种子查询补发（2026-09-27）：此刻 bgCanvas.width/W 是本会话真实 backing 比例，
  // 查询 sf 不再失配（recv 只武装 smartSeedPending，见 capture-image 处理器）。
  if (smartSeedPending) {
    smartSeedPending = false;
    if (state === STATE.IDLE && !CAPTURE_NO_HOVER) {
      if (SMART_DEBUG) console.error(`[SMART-SEED] fire sf=${(bgCanvas.width / Math.max(1, W)).toFixed(3)} W=${W} H=${H} dpr=${canvasDpr} at=${pendingMouseX},${pendingMouseY}`);
      getSmartHoverRect(pendingMouseX, pendingMouseY);
    }
  }
  // 修复历史遗留 bug：原调用未定义的 redrawFromHistoryTop()，每次 init 都 ReferenceError，
  // 导致 capture-ready 从不主动发送（首帧永远等主进程 800ms 兜底）且 resize 后遮罩不刷新。
  // 这里语义就是"按当前历史态重绘"。
  restoreHistoryTop();
  drawMask();
}

function drawBackground() {
  bgCtx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
  invalidateAnnotLuma(); // 底图换了：选框对比色缓存作废（下次取色重建）
  if (!bgImage) return;
  drawBackgroundInner();
  // 智能帧（4K 帧 getImageData ~33MB，日志有 willReadFrequently 警告）不挡亮窗关键路径：
  // 延到 reveal 之后再发；首帧悬停若抢在帧到达前查询，DLL 返回 no-frame，像素链下一拍补齐。
  setTimeout(sendSmartFrame, 150);
}

// 混合缩放多屏：复用窗在屏外驻留期间 devicePixelRatio 属于「最近屏幕」，reveal 挪到目标屏
// 后可能变化 → 画布 backing 与屏幕物理栅格错位（首帧发虚、smart:frame 与查询 sf 失配）。
// dpr 变化且会话仍在 IDLE 时重建画布并重发帧；选区/标注/长截图编辑态不打扰。
(function watchDprChange() {
  try {
    const mql = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    mql.addEventListener('change', () => {
      try {
        if (typeof state !== 'undefined' && state === STATE.IDLE && bgImage) initCanvases();
      } catch (_) { /* ignore */ }
      watchDprChange();
    }, { once: true });
  } catch (_) { /* ignore */ }
})();

function drawBackgroundInner() {
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

  // 单窗·全虚拟屏（2026-09-25 修混合 DPI 预览缩放）：窗口 DIP 外接框 = 全虚拟物理外接框 ÷ 主屏缩放率，
  // 故 bgCanvas backing = 物理帧 1:1（5120×1440）。整帧直绘 = 两屏各自 1:1 物理像素，副屏(150%)不再被
  // 按 dpr/屏缩放率 = 0.833× 缩放 → 不再变小发虚 + 蒙版边缘露桌面。绘制前切恒等变换（setupCanvasDpr
  // 置了 dpr 变换，逻辑坐标会整体放大 dpr 倍），直绘后恢复，保持函数进出变换状态一致。
  const dpr = canvasDpr || 1;
  bgCtx.setTransform(1, 0, 0, 1, 0, 0);
  if (bgImage.naturalWidth === bgCanvas.width && bgImage.naturalHeight === bgCanvas.height) {
    bgCtx.drawImage(bgImage, 0, 0);
  } else {
    // 兜底：backing 与帧失配（如 dpr 非主屏缩放率）时按比例拉伸到整个 backing
    bgCtx.drawImage(bgImage, 0, 0, bgCanvas.width, bgCanvas.height);
  }
  bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/* ── 像素矩形层级检测：会话内把截图帧发给主进程一次（DLL 侧缓存前景掩码+积分图）── */
let smartFrameSentKey = '';
// GDI 直抓会话主进程已用原始位图直喂 DLL（capture-image.framePrepared），渲染端不再重复发 33MB
let smartFrameFromMain = false;
function sendSmartFrame() {
  if (smartFrameFromMain) return;
  if (!bgCanvas.width || !bgCanvas.height) return;
  const key = `${bgCanvas.width}x${bgCanvas.height}`;
  if (smartFrameSentKey === key) return;
  smartFrameSentKey = key;
  try {
    const img = bgCtx.getImageData(0, 0, bgCanvas.width, bgCanvas.height);
    ipcRenderer.send('smart:frame', new Uint8Array(img.data.buffer), bgCanvas.width, bgCanvas.height);
  } catch { /* ignore */ }
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
/** 目标悬停框（检测结果）与视觉框（插值绘制）——「水流」平滑的关键 */
let hoverTargetRect = null;
let hoverVisualRect = null;
let hoverVisualRaf = 0;
let lastDetectX = -9999;
let lastDetectY = -9999;
let lastDetectAt = 0;

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpRect(from, to, t) {
  if (!from) return { x: to.x, y: to.y, width: to.width, height: to.height };
  return {
    x: lerp(from.x, to.x, t),
    y: lerp(from.y, to.y, t),
    width: lerp(from.width, to.width, t),
    height: lerp(from.height, to.height, t),
  };
}

function layoutHole(hole) {
  if (!captureMask || !maskCtx || !maskCanvas) return;
  captureMask.style.display = 'block';

  const dpr = window.devicePixelRatio || 1;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const pw = Math.max(1, Math.round(vw * dpr));
  const ph = Math.max(1, Math.round(vh * dpr));
  if (maskCanvas.width !== pw || maskCanvas.height !== ph) {
    maskCanvas.width = pw;
    maskCanvas.height = ph;
    maskCanvas.style.width = `${vw}px`;
    maskCanvas.style.height = `${vh}px`;
  }
  maskCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  maskCtx.clearRect(0, 0, vw, vh);

  if (!hole) {
    maskCtx.fillStyle = 'rgba(0, 0, 0, 0.30)';
    maskCtx.fillRect(0, 0, vw, vh);
    return;
  }

  // 视觉框用浮点，绘制时四舍五入；过渡在 lerp 中完成
  const x = Math.round(hole.x);
  const y = Math.round(hole.y);
  const w = Math.max(1, Math.round(hole.width));
  const h = Math.max(1, Math.round(hole.height));
  const right = x + w;
  const bottom = y + h;
  // 单次 evenodd 填充挖洞（2026-09-25 修「选区上下两根细线」）：
  // 原先用 上/下/左/右 四块 fillRect 拼暗区，相邻块共享的边在非整数 dpr（主屏 1.25）下
  // 各自抗锯齿 —— 接缝像素被两次 40% 各覆盖一半，合成后只有 ~36% 暗度，比周围亮一档，
  // 于是在选区上下各留一条横贯整屏的细线。单条路径填充只有一个真实边界，接缝自然消失。
  maskCtx.fillStyle = 'rgba(0, 0, 0, 0.40)';
  maskCtx.beginPath();
  maskCtx.rect(0, 0, vw, vh);
  maskCtx.rect(x, y, w, h);
  maskCtx.fill('evenodd');

  // 边框：窗口级粗亮 / 元素级细一点，两种模式一眼可分。
  // 颜色固定为蓝 —— 2026-09-26 用户明确：最外层截图选框这一圈**就该是蓝的**，
  // 「按底色取对比色」指的是里面**文字框的边框**（见 syncAnnotHandles / syncEditorBox），
  // 不是这一圈。别再把这里改成对比色。
  const isWin = smartLevel === 1;
  maskCtx.lineWidth = isWin ? 3 : 2;
  maskCtx.strokeStyle = isWin ? 'rgba(64, 156, 255, 1)' : 'rgba(120, 190, 255, 0.95)';
  maskCtx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}

/* ── 悬停「水流」插值：目标框每帧更新，视觉框 rAF 向目标缓动 ── */
function startHoverSmoothLoop() {
  if (hoverVisualRaf) return;
  // 固定时长缓动滑移（对齐 Shotera"几帧内从大窗口滑到正确元素"）：
  // 亮区连续移动、从不瞬间消失——硬切（亮的瞬间变暗、暗的瞬间变亮）才是频闪的本质。
let hoverAnimFrom = null;
let hoverAnimStart = 0;
let hoverAnimTargetKey = '';
// 会话打开时刻（performance.now 基准）：刚开窗时像素框→UIA 细化的切换强制走 90ms 平滑变形，
// 避免"框一出现又变"的跳变观感（2026-09-23 用户反馈）
let sessionOpenedAt = -1e9;
  const HOVER_ANIM_MS = 90;
  const tick = () => {
    hoverVisualRaf = 0;
    if (state !== STATE.IDLE) {
      hoverVisualRect = null;
      hoverTargetRect = null;
      lastGoodTarget = null;
      hoverAnimTargetKey = '';
      drawMask();
      return;
    }
    // 目标为空时的 lastGoodTarget 兜底**同样必须包含光标**——防止旧框钉在光标之外
    let target = hoverTargetRect;
    if (!target && lastGoodTarget) {
      const px = pendingMouseX, py = pendingMouseY;
      const g = lastGoodTarget;
      if (px >= g.x - 6 && py >= g.y - 6
        && px <= g.x + g.width + 6 && py <= g.y + g.height + 6) {
        target = g;
      }
    }
    if (!target) {
      hoverVisualRect = null;
      hoverAnimTargetKey = '';
      drawMask();
      return;
    }
    // 目标变化 → 二选一：
    //  · 追踪模式（与当前视觉框交叠 ≥15% 或中心距 <80px）：立即贴合，零动画
    //  · 大跨度切换（换窗/大小剧变）：90ms 缓动，避免亮暗区域瞬间互换的频闪
    const key = target.x + ',' + target.y + ',' + target.width + ',' + target.height;
    if (key !== hoverAnimTargetKey) {
      const from = hoverVisualRect || target;
      const ax1 = from.x + from.width, ay1 = from.y + from.height;
      const bx1 = target.x + target.width, by1 = target.y + target.height;
      const iw = Math.min(ax1, bx1) - Math.max(from.x, target.x);
      const ih = Math.min(ay1, by1) - Math.max(from.y, target.y);
      const inter = (iw > 0 && ih > 0) ? iw * ih : 0;
      const union = from.width * from.height + target.width * target.height - inter;
      const iou = union > 0 ? inter / union : 0;
      const cdX = Math.abs((from.x + from.width / 2) - (target.x + target.width / 2));
      const cdY = Math.abs((from.y + from.height / 2) - (target.y + target.height / 2));
      // 开窗后 250ms 内（种子像素框 → UIA 细化的换源期）一律走 90ms 滑移：
      // 跳变=用户看到的"框出现后又变"；平滑变形读起来是"框长到位"
      const track = (performance.now() - sessionOpenedAt > 250)
        && (iou >= 0.15 || (cdX < 80 && cdY < 80));
      hoverAnimTargetKey = key;
      if (track) {
        hoverVisualRect = { x: target.x, y: target.y, width: target.width, height: target.height };
        // 同步动画基准：追踪分支 schedule 的下一帧 key 相同会走下方插值分支，
        // hoverAnimFrom 未赋值时（会话首次悬停即追踪）读 null.x 抛 TypeError
        // （9/20 起日志里每次会话刷上千条，视觉无感但属未捕获异常）
        hoverAnimFrom = { x: target.x, y: target.y, width: target.width, height: target.height };
        drawMask();
        hoverVisualRaf = requestAnimationFrame(tick);
        return;
      }
      hoverAnimFrom = { x: from.x, y: from.y, width: from.width, height: from.height };
      hoverAnimStart = performance.now();
    }
    const p = Math.min(1, (performance.now() - hoverAnimStart) / HOVER_ANIM_MS);
    const e = 1 - Math.pow(1 - p, 3);
    hoverVisualRect = {
      x: hoverAnimFrom.x + (target.x - hoverAnimFrom.x) * e,
      y: hoverAnimFrom.y + (target.y - hoverAnimFrom.y) * e,
      width: hoverAnimFrom.width + (target.width - hoverAnimFrom.width) * e,
      height: hoverAnimFrom.height + (target.height - hoverAnimFrom.height) * e,
    };
    drawMask();
    if (p < 1) hoverVisualRaf = requestAnimationFrame(tick);
  };
  hoverVisualRaf = requestAnimationFrame(tick);
}

function setHoverTarget(rect, refX, refY, opts) {
  // 光标补偿框（skipGuard）：EFP 最小元素描述的是查询点，补偿后贴当前光标，
  // 包含性由查询点保证，跳过检查。
  if (rect && state === STATE.IDLE && !(opts && opts.skipGuard)) {
    const px = (refX === undefined) ? pendingMouseX : refX;
    const py = (refY === undefined) ? pendingMouseY : refY;
    const inside = px >= rect.x - 6 && py >= rect.y - 6
      && px <= rect.x + rect.width + 6 && py <= rect.y + rect.height + 6;
    if (!inside) {
      // 诊断：理论上不该发生——发生即说明还有未知的过期框来源
      console.error(`[SMART-GUARD] reject rect=${rect.width}x${rect.height}@${rect.x},${rect.y} cursor=${px},${py} type=${rect.controlType || '?'}`);
      return;
    }
    if (SMART_DEBUG && rect.width <= 40 && rect.height <= 40) {
      console.error(`[SMART-TINY] accept rect=${rect.width}x${rect.height}@${rect.x},${rect.y} cursor=${px},${py} type=${rect.controlType || '?'} name=${(rect.name || '').slice(0, 20)}`);
    }
  }
  hoverTargetRect = rect;
  hoverWindowRect = rect;
  startHoverSmoothLoop();
}

/** 进入/离开 IDLE 悬停：通知主进程 click-through（forward），减少每帧开关 */
function setSmartHoverMode(mode) {
  try {
    ipcRenderer.send('smart:hover-mode', mode);
  } catch { /* ignore */ }
}

/**
 * 遮罩审计（低频诊断，只在关键状态切换时调用）：
 * 转储遮罩几何、每条暗条的行内样式与实际盒子，并用 elementFromPoint 探测
 * 「洞中心 / 四边 / 四角」每个采样点上最顶层的元素是谁 —— 用于远程定位
 * 「蒙版位置不对 / 该暗的地方不暗 / 洞里被盖住」这类只有肉眼能发现的问题。
 */
function auditMask(reason) {
  try {
    console.error(`[MASK-AUDIT] ${reason} level=${smartLevel} hover=${hoverWindowRect ? `${hoverWindowRect.x},${hoverWindowRect.y} ${hoverWindowRect.width}x${hoverWindowRect.height}` : 'none'}`);
  } catch (err) {
    console.error('[MASK-AUDIT] failed', err);
  }
}

let lastMaskVerify = 0;

function verifyMaskGeometry(hole) {
  // Canvas 蒙版：几何由 layoutHole 直接绘制，无需 DOM rect 校验
  void hole;
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

/** 顶部提示条宽度缓存：drawMask 每帧调用，避免反复读 offsetWidth 触发强制重排 */
let hintBoxW = 0;

function drawMask() {
  // 准线跟随选区：drawMask 是选区每次变化（框选/拖动/resize/微调）的统一刷新入口，
  // 挂在这里准线就会实时跟着选区走，无需在各处补调用。
  drawGuides();
  if (captureHint) {
    // 仅 IDLE（未选区）时显示操作提示，进入选区/标注后隐藏
    captureHint.style.display = state === STATE.IDLE ? 'flex' : 'none';
    if (state === STATE.IDLE) {
      // 顶部提示条单屏居中（2026-09-25 修「跨屏标签」）：窗口横跨两屏时 CSS left:50%
      // 恰落在屏缝（2048）上，提示条被系统分割成两半。改为在光标所在屏内水平居中，
      // 与预览工具栏/悬停角标的单屏钳制同一思路。
      const scr = currentScreenCssRect();
      if (scr) {
        if (!hintBoxW) hintBoxW = captureHint.offsetWidth || 360;
        const cx = scr.x + (scr.width - hintBoxW) / 2;
        const want = `${Math.round(cx)}px`;
        if (captureHint.style.left !== want) captureHint.style.left = want;
      }
    } else if (hintBoxW) {
      hintBoxW = 0; // 隐藏后重清零：下次显示重新量（i18n 切换/缩放等尺寸可能变化）
    }
  }

  if (state === STATE.IDLE) {
    // 悬停：用插值后的视觉框绘制（水流感）；无视觉框则整屏暗
    if (!hoverVisualRect) {
      layoutHole(null);
      layoutHandles(false);
      return;
    }
    layoutHole(hoverVisualRect);
    layoutHandles(false);
    return;
  }

  // 选区/拖动/标注中：洞 = 当前选区
  if (selW >= 1 && selH >= 1) {
    layoutHole({ x: selX, y: selY, width: selW, height: selH });
  } else {
    layoutHole(null);
  }
  // 截图选框的 8 个点**常显**（2026-09-26 用户要求：对齐 Snipaste —— 选框任何时候都有四周的点）：
  // 不再要求 activeTool==='select'，只要已有选区就显示；抓取仍只在移动工具下生效，
  // 避免画笔/橡皮擦在选区边缘按下时误改成「改选区大小」。
  layoutHandles(
    (state === STATE.SELECTED || state === STATE.MOVING || state === STATE.RESIZING)
    && !document.body.classList.contains('is-longshot-edit'),
  );

  // 对象层跟随当前选区重裁：选区几何（大小/位置）一变，矢量对象的可见范围就变。
  // renderAnnots 内部会 clearRect + clipToSelection，空数组直接清屏跳过，开销可忽略。
  if (annotCtx && annotations.length && selW >= 1 && selH >= 1) {
    renderAnnots();
  }
}

/**
 * Alt 准线层（Slack 式对齐辅助，2026-09-25）：点按 Alt 切换常显，画出选区的左右边 / 上下边
 * 与水平、垂直中线，虚线延伸到「选区所在那块屏」的边界，用来目视判断是否对齐。
 * 纯视觉 —— 不吸附、不进截图结果、不接收鼠标事件（.capture-guide-canvas 已 pointer-events:none）。
 * 延伸范围取单屏而非整窗：跨屏单窗里 W/H 是整条虚拟桌面，画满会跨过屏缝显得混乱。
 */
function drawGuides() {
  if (!guideCtx) return;
  guideCtx.clearRect(0, 0, W, H);
  if (!guidesOn) return;
  if (!(selW >= 1 && selH >= 1)) return;
  const scr = screenCssRectAt(selX + selW / 2, selY + selH / 2)
    || { x: 0, y: 0, width: W, height: H };
  const x0 = scr.x; const x1 = scr.x + scr.width;
  const y0 = scr.y; const y1 = scr.y + scr.height;
  const xs = [selX, selX + selW / 2, selX + selW];
  const ys = [selY, selY + selH / 2, selY + selH];
  guideCtx.save();
  guideCtx.lineCap = 'butt';
  // 0.5 偏移对齐物理像素栅格，1px 虚线才不糊
  const strokeAll = () => {
    guideCtx.beginPath();
    for (const vx of xs) {
      const x = Math.round(vx) + 0.5;
      guideCtx.moveTo(x, y0);
      guideCtx.lineTo(x, y1);
    }
    for (const vy of ys) {
      const y = Math.round(vy) + 0.5;
      guideCtx.moveTo(x0, y);
      guideCtx.lineTo(x1, y);
    }
    guideCtx.stroke();
  };
  // 先铺一层白描边打底，再叠 accent 虚线：深底与浅底都能看清（与选区手柄白心蓝圈同一策略）
  guideCtx.setLineDash([]);
  guideCtx.strokeStyle = 'rgba(255, 255, 255, .85)';
  guideCtx.lineWidth = 3;
  strokeAll();
  guideCtx.setLineDash([5, 4]);
  guideCtx.strokeStyle = '#3d6be5';
  guideCtx.lineWidth = 1;
  strokeAll();
  guideCtx.restore();
}

// Alt 点按切换准线（Slack 同款）：只在有选区时生效；忽略长按自动重复，
// 否则按住 Alt 会每秒翻转几十次。preventDefault 顺带挡掉 Windows 菜单栏焦点。
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Alt' || e.repeat) return;
  if (state === STATE.IDLE || state === STATE.DRAWING) return;
  if (!(selW >= 1 && selH >= 1)) return;
  e.preventDefault();
  guidesOn = !guidesOn;
  drawGuides();
});

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
  // 窗口级：取包含光标的**主窗口**（面积尽量大）。
  // 不能取「最小窗」——微信侧栏/菜单弹层会抢在主窗前面，看起来像「没识别到大窗」。
  const screenArea = Math.max(1, W * H);
  let best = null;
  let bestArea = 0;
  for (const item of captureWindowRects) {
    if (mx < item.x || mx > item.x + item.width || my < item.y || my > item.y + item.height) continue;
    // 过小弹层不配当「窗口」
    if (item.width < 90 || item.height < 90) continue;
    // 接近全屏 = 桌面/我们的遮罩，跳过
    const area = item.width * item.height;
    if (area > screenArea * 0.93) continue;
    // 主窗优先：面积最大者胜
    if (area > bestArea) {
      bestArea = area;
      best = item;
    }
  }
  // 若全被滤掉（极小屏/异常枚举），退回「最小命中窗」兜底
  if (!best) {
    let fallback = null;
    let fallbackArea = Infinity;
    for (const item of captureWindowRects) {
      if (mx < item.x || mx > item.x + item.width || my < item.y || my > item.y + item.height) continue;
      const area = item.width * item.height;
      if (area < fallbackArea) {
        fallbackArea = area;
        fallback = item;
      }
    }
    return fallback;
  }
  return best;
}

/* ── 智能选区（投影轮廓法） ──
 * Shotera/Snipaste/ShareX 主路径是 Windows UIA ElementFromPoint。
 * 无 COM 时用像素：垂直投影找文本行 → 合并近距行 → 水平投影找字缘。
 * 拒绝过扁/过宽比结果，避免画成整屏横线。
 */
let smartRectCache = null;
let smartRectCacheKey = '';
let smartRectCacheAt = 0;

function detectTextBlockAt(mx, my) {
  if (!bgCanvas || !bgImage) return null;
  const dpr = window.devicePixelRatio || 1;
  const ctx = bgCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  const win = findWindowRectAt(mx, my);
  const pad = 160;
  let x0 = Math.max(0, Math.floor(mx - pad));
  let y0 = Math.max(0, Math.floor(my - pad));
  let x1 = Math.min(W - 1, Math.ceil(mx + pad));
  let y1 = Math.min(H - 1, Math.ceil(my + pad));
  if (win) {
    x0 = Math.max(Math.floor(win.x), x0);
    y0 = Math.max(Math.floor(win.y), y0);
    x1 = Math.min(Math.ceil(win.x + win.width - 1), x1);
    y1 = Math.min(Math.ceil(win.y + win.height - 1), y1);
  }
  if (x1 - x0 < 48 || y1 - y0 < 48) return null;

  const sx = Math.max(0, Math.round(x0 * dpr));
  const sy = Math.max(0, Math.round(y0 * dpr));
  const sw = Math.max(1, Math.min(bgCanvas.width - sx, Math.round((x1 - x0 + 1) * dpr)));
  const sh = Math.max(1, Math.min(bgCanvas.height - sy, Math.round((y1 - y0 + 1) * dpr)));
  let data;
  try {
    data = ctx.getImageData(sx, sy, sw, sh).data;
  } catch (_) {
    return null;
  }

  const cl = Math.max(0, Math.min(sw - 1, Math.round((mx - x0) * dpr)));
  const ct = Math.max(0, Math.min(sh - 1, Math.round((my - y0) * dpr)));

  // ── 列表行检测（微信会话列表）：找光标上下最近的水平分隔线，包成整行 ──
  {
    const rowLum = (y) => {
      let sum = 0;
      let n = 0;
      for (let x = Math.floor(sw * 0.15); x < sw * 0.85; x += Math.max(2, Math.floor(sw / 80))) {
        const i = (y * sw + x) * 4;
        sum += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        n++;
      }
      return n ? sum / n : 255;
    };
    const isSep = (y) => {
      if (y < 2 || y >= sh - 2) return false;
      const l = rowLum(y);
      const above = rowLum(Math.max(0, y - 3));
      const below = rowLum(Math.min(sh - 1, y + 3));
      return l < Math.min(above, below) - 12 && l < 245;
    };
    let sepUp = -1;
    let sepDn = -1;
    for (let y = ct; y > Math.max(2, ct - 120); y--) {
      if (isSep(y)) { sepUp = y; break; }
    }
    for (let y = ct; y < Math.min(sh - 3, ct + 120); y++) {
      if (isSep(y)) { sepDn = y; break; }
    }
    // 行高合理（36~160 物理像素 ≈ 微信列表行）
    // ⚠ sepUp/selDn 是「抽取图内」物理坐标，必须加回 x0/y0（CSS 原点）再转 CSS
    if (sepUp >= 0 && sepDn >= 0) {
      const rowH = sepDn - sepUp;
      if (rowH >= 36 && rowH <= 160) {
        const padRow = Math.max(1, Math.round(2 * dpr));
        const rect = {
          x: Math.round(x0),
          y: Math.round(y0 + (sepUp + padRow) / dpr),
          width: Math.round((sw - 4) / dpr),
          height: Math.round((rowH - padRow * 2) / dpr),
        };
        if (rect.width > 80 && rect.height > 30) {
          return rect;
        }
      }
    }
    // 单边分隔 + 行高合理
    if (sepUp >= 0 || sepDn >= 0) {
      const guessedH = 72 * dpr;
      const top = sepUp >= 0 ? sepUp : Math.max(0, ct - guessedH / 2);
      const bot = sepDn >= 0 ? sepDn : Math.min(sh - 1, ct + guessedH / 2);
      if (bot - top >= 36 && bot - top <= 160) {
        const rect = {
          x: Math.round(x0),
          y: Math.round(y0 + (top + 1) / dpr),
          width: Math.round((sw - 4) / dpr),
          height: Math.round((bot - top - 2) / dpr),
        };
        if (rect.width > 80 && rect.height > 30) return rect;
      }
    }
  }

  // 继续走原有文字投影（消息区/非列表）

  // 自适应阈值：用采样区中位亮度附近做「墨迹」判定，适配深浅色主题
  const sampleStep = Math.max(1, Math.floor((sw * sh) / 8000));
  const lums = [];
  for (let i = 0; i < sw * sh; i += sampleStep) {
    const o = i * 4;
    lums.push(data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114);
  }
  lums.sort((a, b) => a - b);
  const med = lums.length ? lums[Math.floor(lums.length / 2)] : 200;
  // 墨迹 = 明显暗于背景（深色主题则相反：明显亮于背景）
  const darkMode = med < 128;
  const darkTh = darkMode ? med + 40 : med - 55;
  const lumAt = (x, y) => {
    const i = (y * sw + x) * 4;
    return data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
  };
  const isInk = (x, y) => {
    const L = lumAt(x, y);
    return darkMode ? L > darkTh : L < darkTh;
  };

  // 光标附近 6px 内是否有墨迹
  let nearInk = false;
  for (let dy = -6; dy <= 6 && !nearInk; dy++) {
    for (let dx = -6; dx <= 6; dx++) {
      const x = cl + dx;
      const y = ct + dy;
      if (x >= 0 && y >= 0 && x < sw && y < sh && isInk(x, y)) {
        nearInk = true;
        break;
      }
    }
  }
  if (!nearInk) return null; // 光标不在文字上 → 不抢窗口级智能框

  // 垂直投影（全列，略抽样加速）
  const colStep = Math.max(1, Math.floor(sw / 160));
  const rowInk = new Int32Array(sh);
  for (let y = 0; y < sh; y++) {
    let c = 0;
    for (let x = 0; x < sw; x += colStep) {
      if (isInk(x, y)) c++;
    }
    rowInk[y] = c;
  }
  const sampledCols = Math.ceil(sw / colStep);
  const rowThr = Math.max(2, Math.floor(sampledCols * 0.015));

  // 找光标所在文本行
  let lineTop = -1;
  let lineBot = -1;
  if (rowInk[ct] >= rowThr) {
    lineTop = ct;
    lineBot = ct;
    while (lineTop > 0 && rowInk[lineTop - 1] >= rowThr) lineTop--;
    while (lineBot < sh - 1 && rowInk[lineBot + 1] >= rowThr) lineBot++;
  } else {
    let bestY = -1;
    let bestD = 20;
    for (let y = Math.max(0, ct - 20); y <= Math.min(sh - 1, ct + 20); y++) {
      if (rowInk[y] >= rowThr) {
        const d = Math.abs(y - ct);
        if (d < bestD) {
          bestD = d;
          bestY = y;
        }
      }
    }
    if (bestY < 0) return null;
    lineTop = bestY;
    lineBot = bestY;
    while (lineTop > 0 && rowInk[lineTop - 1] >= rowThr) lineTop--;
    while (lineBot < sh - 1 && rowInk[lineBot + 1] >= rowThr) lineBot++;
  }
  const lineH = lineBot - lineTop + 1;
  if (lineH < 8 || lineH > Math.floor(sh * 0.4)) return null;

  // 段落合并：行距 < 1.1×行高 视为同一段（Shotera 常框住多行段落）
  const gapMax = Math.max(2, Math.floor(lineH * 1.1));
  let bTop = lineTop;
  let bBot = lineBot;
  // 上
  for (;;) {
    let found = -1;
    const from = bTop - 1;
    const to = Math.max(0, bTop - gapMax - 1);
    for (let y = from; y >= to; y--) {
      if (rowInk[y] >= rowThr) {
        found = y;
        break;
      }
    }
    if (found < 0) break;
    let b = found;
    while (b < bTop - 1 && rowInk[b + 1] >= rowThr) b++;
    if (bTop - b - 1 > gapMax) break;
    bTop = found;
  }
  // 下
  for (;;) {
    let found = -1;
    const from = bBot + 1;
    const to = Math.min(sh - 1, bBot + gapMax + 1);
    for (let y = from; y <= to; y++) {
      if (rowInk[y] >= rowThr) {
        found = y;
        break;
      }
    }
    if (found < 0) break;
    let t = found;
    while (t > bBot + 1 && rowInk[t - 1] >= rowThr) t--;
    if (t - bBot - 1 > gapMax) break;
    bBot = found;
  }

  // 水平投影：段落内全部墨迹列（允许词间空洞）
  const colInk = new Int32Array(sw);
  const yStep = Math.max(1, Math.floor((bBot - bTop + 1) / 10));
  for (let x = 0; x < sw; x++) {
    let c = 0;
    for (let y = bTop; y <= bBot; y += yStep) {
      if (isInk(x, y)) c++;
    }
    colInk[x] = c;
  }
  // 从光标列向两侧扩，空洞 > maxHole 停
  const maxHole = Math.max(6, Math.round(12 * dpr));
  let left = cl;
  let right = cl;
  if (colInk[left] < 1) {
    let best = -1;
    let bd = 30;
    for (let x = Math.max(0, cl - 30); x <= Math.min(sw - 1, cl + 30); x++) {
      if (colInk[x] >= 1) {
        const d = Math.abs(x - cl);
        if (d < bd) {
          bd = d;
          best = x;
        }
      }
    }
    if (best < 0) return null;
    left = best;
    right = best;
  }
  let gap = 0;
  while (left > 1) {
    if (colInk[left - 1] >= 1) {
      left--;
      gap = 0;
    } else {
      gap++;
      if (gap > maxHole) break;
      left--;
    }
  }
  gap = 0;
  while (right < sw - 2) {
    if (colInk[right + 1] >= 1) {
      right++;
      gap = 0;
    } else {
      gap++;
      if (gap > maxHole) break;
      right++;
    }
  }

  // 元素级：给更大 padding，看起来像「内容块」而不是单行细条
  const padX = Math.max(8, Math.round(12 * dpr));
  const padY = Math.max(8, Math.round(12 * dpr));
  left = Math.max(0, left - padX);
  right = Math.min(sw - 1, right + padX);
  bTop = Math.max(0, bTop - padY);
  bBot = Math.min(sh - 1, bBot + padY);

  const rect = {
    x: Math.round(x0 + left / dpr),
    y: Math.round(y0 + bTop / dpr),
    width: Math.max(12, Math.round((right - left + 1) / dpr)),
    height: Math.max(10, Math.round((bBot - bTop + 1) / dpr)),
  };
  if (rect.height < 16 || rect.height > 320) return null;
  if (rect.width / Math.max(1, rect.height) > 18) return null;
  // 必须包含光标附近
  const cx = Math.round(mx);
  const cy = Math.round(my);
  if (cx < rect.x - 4 || cy < rect.y - 4 || cx > rect.x + rect.width + 4 || cy > rect.y + rect.height + 4) {
    return null;
  }
  return rect;
}
function detectUiElementAt(mx, my) {
  const key = Math.round(mx / 6) + '_' + Math.round(my / 6);
  const now = Date.now();
  if (smartRectCache && smartRectCacheKey === key && now - smartRectCacheAt < 80) {
    return smartRectCache;
  }
  const result = detectTextBlockAt(mx, my);
  smartRectCache = result;
  smartRectCacheKey = key;
  smartRectCacheAt = now;
  return result;
}

/** 悬停矩形滞回：防止像素检测抖动导致闪动 */
let hoverStableRect = null;
let hoverStableAt = 0;

function rectIoU(a, b) {
  if (!a || !b) return 0;
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (inter <= 0) return 0;
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

/** 智能层级：0=最深元素，1…n=父容器/主窗/全屏（滚轮上=变大，下=变小） */
let smartLevel = 0;
/** smart:at-point 返回的 UIA 层级链 */
let smartIpcRect = { window: null, element: null, levels: [] };
let smartIpcBusy = false;
let smartIpcAt = 0;
let smartIpcPending = null;
let lastDiagLog = 0;
let lastApplyDbg = 0;
let lastFollowDbg = 0;
/** 最近一次 UIA 真链（≥2 层）权威落笔时刻：活跃期（300ms）内像素链不抢驱动——
 *  微信等自绘面上像素碎片是噪声，只在 UIA 死/静默时兜底 */
let lastUiaGoodAt = 0;
// 悬停查询延迟统计（1s 窗口聚合，随 SMART-DIAG 打印后清零）：2026-09-23 起有耗时数据可归因
let smartDiagStats = { n: 0, dllMax: 0, dllSum: 0, totMax: 0, totSum: 0, src: {}, guardDrops: 0, superseded: 0, trackFix: 0, trackSkip: 0 };
/** 像素矩形层级链（主进程 DLL，物理→DIP 已换算，面积升序）——默认展示来源 */
let smartPixelLevels = [];
let smartPixelBusy = false;
let smartPixelAt = 0;
let smartPixelPending = null;
/** 最近一次成功的目标框：检测空窗时保留，避免蒙版「关掉再打开」 */
let lastGoodTarget = null;
/** 种子查询待发标记：capture-image recv 只武装，initCanvases（本会话真实 sf/W 就位）后补发 */
let smartSeedPending = false;

/** 像素矩形层级查询（与 UIA 同一套节流/尾随模式；单次 <0.2ms，节流只为省 IPC） */
function requestSmartPixel(mx, my) {
  if (smartPixelBusy) {
    smartPixelPending = { x: mx, y: my };
    return;
  }
  if (Date.now() - smartPixelAt < 16) {
    smartPixelPending = { x: mx, y: my };
    return;
  }
  smartPixelBusy = true;
  smartPixelAt = Date.now();
  const reqX = Math.round(mx);
  const reqY = Math.round(my);
  ipcRenderer.invoke('smart:pixel-at', {
    x: reqX,
    y: reqY,
    // sf = 帧实际 backing 比例（bgCanvas 宽 / 窗口 CSS 宽），与帧永远一致。
    // 用 devicePixelRatio 会在「屏外驻留窗 dpr 尚未切到目标屏」的过渡期与帧失配。
    sf: W > 0 && bgCanvas && bgCanvas.width > 0 ? bgCanvas.width / W : (window.devicePixelRatio || 1),
  }).then((r) => {
    smartPixelLevels = (r && Array.isArray(r.levels)) ? r.levels : [];
    // 像素链立即出首框（2026-09-23）：UIA 回包要等 provider 10-200ms（Qt 慢时近秒），
    // 蒙版亮起时框还空着 = 「先蒙版后选框」。帧在主进程早已备好（onGdiFrame 直喂），
    // 像素检测 <1ms —— UIA 尚未产出首框时由像素链先画（Snipaste 同帧出框的等价物），
    // UIA 回包后照常细化（开窗 250ms 内强制平滑滑移，不跳变）。UIA 出框后像素不再抢驱动。
    // 最小框收敛（2026-09-27 五轮）：像素链每拍（16-40ms）新鲜。链上 smartLevel 层的
    // 包含框比当前目标更小 → 收敛到它。此前像素链只在「首框」驱动（!hoverTargetRect &&
    // !lastGoodTarget），光标停在 UIA 粗容器/像素大块里就永远不再细化 = 「明明有更小的
    // 元素却不识别」的病灶。只缩不放大（2% 滞回）：不与 UIA 权威回包拉锯；滚轮层级由
    // pickFollowRectAt 的索引语义保证（smartLevel>0 时取对应层，不会强缩到最小）。
    // 八轮加门、九轮收紧：UIA 真链活跃期（1s 内权威落笔过）像素不抢驱动——A→B 移动中
    // 保持 A 框（用户要求跳过不确定中间态）；UIA 死/静默超 1s 的应用像素才兜底收敛。
    if (state === STATE.IDLE && r && Array.isArray(r.levels) && r.levels.length
      && Date.now() - lastUiaGoodAt > 1000) {
      const rect = pickFollowRectAt(reqX, reqY);
      const curArea = hoverTargetRect ? hoverTargetRect.width * hoverTargetRect.height : Infinity;
      if (rect && rect.width * rect.height < curArea * 0.98) {
        lastGoodTarget = rect;
        setHoverTarget(rect, reqX, reqY, { skipGuard: true });
      }
    }
  }).catch(() => { /* ignore */ })
    .finally(() => {
      smartPixelBusy = false;
      if (smartPixelPending) {
        const nx = smartPixelPending.x;
        const ny = smartPixelPending.y;
        smartPixelPending = null;
        requestSmartPixel(nx, ny);
      }
    });
}

function requestSmartIpc(mx, my) {
  if (smartIpcBusy) {
    smartIpcPending = { x: mx, y: my };
    return;
  }
  if (Date.now() - smartIpcAt < 16) {
    smartIpcPending = { x: mx, y: my };
    return;
  }
  smartIpcBusy = true;
  smartIpcAt = Date.now();
  const vs = captureVirtualScreen || { x: 0, y: 0 };
  const reqX = Math.round(mx);
  const reqY = Math.round(my);
  ipcRenderer.invoke('smart:at-point', {
    x: reqX,
    y: reqY,
    vsX: vs.x || 0,
    vsY: vs.y || 0,
    // coordSpace='pdip'（2026-09-25 修副屏智能识别）：放大窗口方案下窗口 DIP 系 = 主屏 DIP 系
    // （全虚拟物理 ÷ 主屏 dpr），而主进程 else 分支的 dipToScreenPoint 期望「虚拟桌面 DIP 系」
    // （各屏 ÷ 各自 sf）——两个坐标系在副屏（150% vs 125%）下相差 ~262px，UIA 查询打在错误
    // 位置 → 「副屏识别不了窗口、主屏正常」。'pdip' 分支直接 × 主屏 dpr 即物理，两屏统一正确。
    // sf 用帧实际 backing 比例（与 smart:pixel-at 一致），不依赖 devicePixelRatio 过渡期。
    sf: W > 0 && bgCanvas && bgCanvas.width > 0 ? bgCanvas.width / W : (window.devicePixelRatio || 1),
    coordSpace: 'pdip',
  }).then((r) => {
    // 诊断统计（1s 限频打印）：DLL 耗时 / 全链路耗时 / 丢弃计数——2026-09-23 起有数据可归因
    if (r && r.diag) {
      smartDiagStats.n++;
      if (r.diag.dllMs != null) {
        smartDiagStats.dllMax = Math.max(smartDiagStats.dllMax, r.diag.dllMs);
        smartDiagStats.dllSum += r.diag.dllMs;
      }
      if (r.diag.totalMs != null) {
        smartDiagStats.totMax = Math.max(smartDiagStats.totMax, r.diag.totalMs);
        smartDiagStats.totSum += r.diag.totalMs;
      }
      if (r.diag.src) smartDiagStats.src[r.diag.src] = (smartDiagStats.src[r.diag.src] || 0) + 1;
    }
    if (r && !r.ok && r.error === 'superseded') smartDiagStats.superseded++;
    // 新鲜度守卫：回包时光标已远离请求点，这条 UIA 链描述的是旧位置。
    // smartIpcRect（滚轮/合并链数据源）只收新鲜回包；画框走下方的光标补偿逻辑。
    const moved = Math.abs(reqX - pendingMouseX) + Math.abs(reqY - pendingMouseY);
    if (r && moved <= 64) {
      smartIpcRect = r || { window: null, element: null, levels: [] };
    } else if (r && moved > 64) {
      smartDiagStats.guardDrops++;
    }
    if (state === STATE.IDLE) {
      // 大单元地板：与 getSmartLevelsRaw/getMergedSmartLevels 同一常量——
      // 词/小控件级 UIA 元素整级不参与画框（2026-09-27 粒度决策）。
      const raw = (r && r.levels) || [];
      // 光标补偿（2026-09-27 三轮，替代二轮的"取祖先大框"）：回包描述查询点邻域，
      // 移动中把链上选中的框整体平移 (当前光标−查询点)，旧数据的小框跟着光标走到
      // 当前位置——大框内扫过小框时框会跟着变小/移动（最小框原则）；停下偏移归零，
      // 新鲜回包自动接管吸附真实元素。二轮的祖先大框逻辑会把大框反复钉回去
      // （用户实测：大框内移动选不了小框），已废弃。
      const dx = pendingMouseX - reqX;
      const dy = pendingMouseY - reqY;
      const lag = Math.abs(dx) + Math.abs(dy);
      const lvs = raw.filter((lv) => lv && lv.width >= SMART_MIN_UNIT_W && lv.height >= SMART_MIN_UNIT_H);
      if (lvs.length && lag <= 300) {
        const idx = Math.max(0, Math.min(smartLevel, lvs.length - 1));
        const src = lvs[idx];
        let rect = null;
        if (lag <= 16) {
          // 基本新鲜：原样应用（真实位置，无补偿抖动）
          rect = src;
        } else {
          // 2026-09-27 七轮：补偿机制废除。回包过时 >16px 时平移旧框，跨元素边界
          // （两条消息行之间划过）正好把上一行的框平移半行 = 用户截图实锤的「骑缝错位」。
          // 旧数据一律弃用，移动中交给锚定当前光标的新鲜像素链（位置由落点算出，不会错），
          // 停下后 UIA 回包一拍内变新鲜（total≈13ms），精确吸附最小元素。
          smartDiagStats.trackSkip = (smartDiagStats.trackSkip || 0) + 1;
        }
        // 最小框门（2026-09-27 五轮）：UIA 回包只在比当前框更小时落笔——粗容器
        // （单层链/快照兜底 696x177 这类）不得覆盖像素链已收敛的细框。放大只经滚轮。
        if (rect) {
          // 落笔门（2026-09-27 八轮）：UIA 真链（≥2 层）= EFP 权威命中，**无条件落笔**
          // （可缩可放）——微信自绘面上像素链的碎片噪声必须让位（上轮"只小不大"门把
          // 权威行框全拒了 = 微信识别瘫痪的根因）。单层链 = 快照/根兜底：近整屏视为
          // 无数据，否则仅当比当前更小时落笔（粗容器不许顶掉像素细框）。
          const curArea = hoverTargetRect ? hoverTargetRect.width * hoverTargetRect.height : Infinity;
          const realChain = lvs.length >= 2;
          const nearFull = lvs.length === 1 && rect.width * rect.height >= W * H * 0.85;
          const allow = realChain || (!nearFull && rect.width * rect.height < curArea * 0.98);
          if (allow) {
            lastGoodTarget = rect;
            setHoverTarget(rect, reqX, reqY, { skipGuard: true });
            if (realChain) lastUiaGoodAt = Date.now();
          }
          // 定位日志（500ms 限频）：smartLevel 是否卡在 >0、链里有没有更小的层、补偿是否在跑
          if (SMART_DEBUG && Date.now() - lastApplyDbg > 500) {
            lastApplyDbg = Date.now();
            console.error(`[SMART-APPLY] smartLvl=${smartLevel} raw=${raw.length} lvs=${lvs.length} idx=${idx}`
              + ` min=${lvs[0].width}x${lvs[0].height} src=${src.width}x${src.height}`
              + ` lag=${lag}px chain=${realChain ? 'real' : 'single'} allow=${allow ? 1 : 0}`
              + ` applied=${allow ? `${rect.width}x${rect.height}@${Math.round(rect.x)},${Math.round(rect.y)}` : 'null'}`);
          }
        }
      } else if (lvs.length) {
        // 光标已跑出旧邻域 300px+：补偿无意义，丢弃等尾随补查
        smartDiagStats.trackSkip = (smartDiagStats.trackSkip || 0) + 1;
      }
    }
    // 1s 限频汇总打印：n/均值/峰值 DLL 耗时、全链路耗时、来源占比、丢弃计数
    const nowDiag = Date.now();
    if (SMART_DEBUG && nowDiag - lastDiagLog > 1000 && smartDiagStats.n > 0) {
      lastDiagLog = nowDiag;
      const s = smartDiagStats;
      const lvs = (r && r.levels) || [];
      console.error(
        `[SMART-DIAG] n=${s.n} dll=${Math.round(s.dllSum / s.n)}/${s.dllMax}ms total=${Math.round(s.totSum / s.n)}/${s.totMax}ms`
        + ` src=${JSON.stringify(s.src)} drop=${s.guardDrops} sup=${s.superseded} trk=${s.trackFix || 0}/${s.trackSkip || 0}`
        + ` uiaLv=${lvs.length} px=${smartPixelLevels.length} cursor=${reqX},${reqY}`,
      );
      smartDiagStats = { n: 0, dllMax: 0, dllSum: 0, totMax: 0, totSum: 0, src: {}, guardDrops: 0, superseded: 0, trackFix: 0, trackSkip: 0 };
    }
  }).catch(() => { /* ignore */ })
    .finally(() => {
      smartIpcBusy = false;
      if (smartIpcPending) {
        const nx = smartIpcPending.x;
        const ny = smartIpcPending.y;
        smartIpcPending = null;
        requestSmartIpc(nx, ny);
      }
    });
}

/** 智能框选地板（DIP）：比这更小的层级整级丢弃（滚轮也切不到）。20x12 = 原始像素链
 *  地板（滤 9x9 墨迹噪点）；UIA 侧同值——最小框原则（2026-09-27 四轮：28x20 过滤掉
 *  小按钮/短行导致「能识别到更小元素却不识别」，回归 20x12）。 */
const SMART_MIN_UNIT_W = 20;
const SMART_MIN_UNIT_H = 12;

function getSmartLevelsRaw() {
  return (smartIpcRect.levels || [])
    .filter((lv) => lv && lv.width >= SMART_MIN_UNIT_W && lv.height >= SMART_MIN_UNIT_H)
    .map((lv) => ({
      x: lv.x, y: lv.y, width: lv.width, height: lv.height,
      name: lv.name, controlType: lv.controlType,
    }));
}

/** 指定点所在屏的窗口 CSS rect（单窗全虚拟屏）。
 *  窗口 CSS 系 = 桌面物理 ÷ canvasDpr（= window.devicePixelRatio，实测 1.25）再减窗口原点
 *  captureVirtualScreen（同一系，-2048,0）→ 主屏 (2048,0,2048,1152)、副屏 (0,0,2048,1152)。
 *  ⚠️ 不能用 d.bounds（各屏自己的 DIP 系，副屏 ÷1.5）：副屏 150% 时 1707 DIP 宽 ≠ 窗口里的
 *  2048 CSS 宽，整块会缩水 0.833 且偏移 341。也不能用全局 scaleFactor —— 该字段本路径下
 *  被主进程写成 1（captureWindow.ts），只有 canvasDpr 才是「物理 → 窗口 CSS」的真实比值
 *  （与 cropPhysicalFromVirtualFrame 的 px = (css + vs.x) × canvasDpr 互为逆运算）。
 *  屏缝/界外时回退距离最近的屏。 */
/** 单块屏在「窗口 CSS 系」里的矩形：物理外接框 ÷ 窗口缩放率 − 窗口原点。
 *  缺 physicalBounds 时退回该屏自己的 DIP bounds（旧行为，仅兜底）。 */
function displayCssRect(d) {
  const sf = canvasDpr && canvasDpr > 0 ? canvasDpr : 1;
  const base = captureVirtualScreen || { x: 0, y: 0 };
  if (d && d.physicalBounds) {
    return {
      x: d.physicalBounds.x / sf - base.x,
      y: d.physicalBounds.y / sf - base.y,
      width: d.physicalBounds.width / sf,
      height: d.physicalBounds.height / sf,
    };
  }
  return {
    x: d.bounds.x - base.x,
    y: d.bounds.y - base.y,
    width: d.bounds.width,
    height: d.bounds.height,
  };
}

function screenCssRectAt(x, y) {
  if (!captureDisplays || !captureDisplays.length || !captureVirtualScreen) return null;
  for (const d of captureDisplays) {
    const r = displayCssRect(d);
    if (x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) return r;
  }
  // 界外（窗口外/屏缝外侧）：取**距离最近**的屏。原来按面积取最大 —— 副屏物理宽 2561 凑整后
  // CSS 宽 2048.8 反而比主屏 2048 大，界外的点会被判给副屏（工具栏因此落到另一块屏）。
  let best = null;
  let bestD = Infinity;
  for (const d of captureDisplays) {
    const r = displayCssRect(d);
    const dx = Math.max(r.x - x, 0, x - (r.x + r.width));
    const dy = Math.max(r.y - y, 0, y - (r.y + r.height));
    const dist = dx * dx + dy * dy;
    if (dist < bestD) { bestD = dist; best = r; }
  }
  return best;
}

function currentScreenCssRect() {
  return screenCssRectAt(pendingMouseX, pendingMouseY);
}

/** 屏幕级尾链：光标所在屏整屏 →（必要时）全虚拟屏（两屏）。
 *  缺屏级时滚到最大从小框直接跳「两屏一起框」，中间没有副屏/主屏整屏级
 *  （2026-09-25 用户反馈：副屏框不到整屏，再扩就把两屏一起框住）。 */
function appendScreenLevels(list, label) {
  const fullWin = { x: 0, y: 0, width: W, height: H, name: '全部屏幕', controlType: 'Screen' };
  const scr = currentScreenCssRect();
  const last = list[list.length - 1];
  const near = (a, b) => !!b && Math.abs(a.x - b.x) <= 4 && Math.abs(a.y - b.y) <= 4
    && Math.abs(a.width - b.width) <= 4 && Math.abs(a.height - b.height) <= 4;
  if (scr && !near(scr, last) && !near(scr, fullWin) && (scr.width < W - 4 || scr.height < H - 4)) {
    list.push({ x: scr.x, y: scr.y, width: scr.width, height: scr.height, name: label, controlType: 'Screen' });
  }
  const nl = list[list.length - 1];
  if (!nl || nl.width < W * 0.92 || nl.height < H * 0.92) list.push(fullWin);
  else list[list.length - 1] = fullWin;
  return list;
}

/**
 * 合并层级链 = 像素边界链（DLL）∪ UIA 元素链，面积升序 + 近重复去重。
 * 两路互补：UIA 元素矩形在有无障碍树的应用里最精确（Shotera 路线），
 * 像素边界在自绘/未激活/游戏场景兜底（Snipaste 路线）；谁的框更小谁排前面。
 */
function getMergedSmartLevels() {
  const list = [];
  for (const lv of smartPixelLevels) {
    // 大单元地板（SMART_MIN_UNIT_*）：配合 DLL quietLadder 砍细级——像素链剩余的最小
    // 矩形是孤立小元素，仍会吐 9x9 级墨迹噪点（SMART-TINY type=Region 9x9），此处兜底。
    if (lv && lv.width >= SMART_MIN_UNIT_W && lv.height >= SMART_MIN_UNIT_H) {
      list.push({ x: lv.x, y: lv.y, width: lv.width, height: lv.height, name: lv.name, controlType: lv.controlType });
    }
  }
  for (const lv of getSmartLevelsRaw()) list.push(lv);
  if (!list.length) return [];

  const winIpc = smartIpcRect.window;
  if (winIpc && winIpc.width >= 90) {
    list.push({
      x: winIpc.x, y: winIpc.y, width: winIpc.width, height: winIpc.height,
      name: winIpc.title || '窗口', controlType: 'Window',
    });
  }

  list.sort((a, b) => (a.width * a.height) - (b.width * b.height));
  const kept = [];
  for (const lv of list) {
    const dup = kept.some((k) => Math.abs(k.x - lv.x) <= 4 && Math.abs(k.y - lv.y) <= 4
      && Math.abs(k.x + k.width - lv.x - lv.width) <= 4 && Math.abs(k.y + k.height - lv.y - lv.height) <= 4);
    if (!dup) kept.push(lv);
  }
  const full = { x: 0, y: 0, width: W, height: H, name: '屏幕', controlType: 'Screen' };
  const last = kept[kept.length - 1];
  if (!last || last.width < W * 0.92 || last.height < H * 0.92) kept.push(full);
  else kept[kept.length - 1] = full;
  return appendScreenLevels(kept, '屏幕');
}

/** 滞回提交的当前框：光标还在框内时只接受更小的细化，拒绝更大的"退缩"（防频闪） */
let smartCommitRect = null;
/** 帧间移动速度（px/帧）：快速移动时光环按需扩展 */
let smartMoveSpeed = 0;

/** 当前生效的层级链（与 pickSmartRectAt 同源）：UIA 命中链优先，像素合并链兜底。
 *  返回 { list, src }——src 标记来源供滞回提交使用。
 *  滚轮切层必须与画框用同一条链——此前滚轮数合并链、画框用 UIA 链，长度不同索引错位，
 *  "滚到最大却停在中间层"由此而来。 */
function getActiveChain() {
  const lvs = (smartIpcRect.levels || [])
    .filter((lv) => lv && lv.width >= SMART_MIN_UNIT_W && lv.height >= SMART_MIN_UNIT_H);
  if (lvs.length) {
    // UIA 链若只有"接近整屏"的窗级大框（最小元素面积 ≥85% 屏幕）——树没钻出细结构，
    // 回退合并链让像素边界兜底出细框（DIAG 里 uiaLv=1 但 px=N 的场景）。
    // 注意：**不做当前光标包含过滤**——EFP 链描述查询点，快速移动时最小元素是路径
    // 上的前一元素，过滤会丢弃它并落到像素面板大框（跨行跳变的病灶）。
    const minArea = Math.min(...lvs.map((l) => l.width * l.height));
    if (minArea < W * H * 0.85) {
      appendScreenLevels(lvs, '屏幕');
      return { list: lvs, src: 'uia' };
    }
  }
  const chain = getMergedSmartLevels();
  // 修复:inRect 仅存在于 pickSmartRectAt 作用域,此处引用必抛 ReferenceError
  //(UIA 无命中走合并链时悬停必崩——基线遗留 bug,2026-09-24 复现于日志)
  const pmx = pendingMouseX, pmy = pendingMouseY;
  return { list: chain.filter((lv) => pmx >= lv.x && pmx <= lv.x + lv.width && pmy >= lv.y && pmy <= lv.y + lv.height), src: 'chain' };
}

/** 跟手重取（2026-09-27）：光标离开当前框时从**新鲜**数据（像素链 <0.2ms + 最近 UIA 链）
 *  重取。包含光标的候选按面积升序后取第 smartLevel 层——与滚轮语义一致（四轮修正：此前
 *  恒取最小层，滚轮选中的层级每次 mousemove 都被覆盖 = 「滚轮参与后彻底乱」）。
 *  UIA 的新鲜回包（moved<=64）照常细化；框内移动此函数不参与 → 无交替闪烁。 */
function pickFollowRectAt(mx, my) {
  const cands = [];
  const consider = (lv) => {
    if (!lv || lv.width < SMART_MIN_UNIT_W || lv.height < SMART_MIN_UNIT_H) return;
    if (mx < lv.x - 6 || my < lv.y - 6
      || mx > lv.x + lv.width + 6 || my > lv.y + lv.height + 6) return;
    cands.push(lv);
  };
  for (const lv of smartPixelLevels) consider(lv);
  for (const lv of (smartIpcRect.levels || [])) consider(lv);
  if (!cands.length) return null;
  cands.sort((a, b) => (a.width * a.height) - (b.width * b.height));
  return cands[Math.min(smartLevel, cands.length - 1)];
}

/** 按当前 smartLevel 从合并层级链取矩形（像素边界 ∪ UIA 元素，面积升序）。
 *  几何滞回（Shotera 平衡点的实现）：间隙里 provider 命中测试返回的是容器（几何事实，
 *  Shotera 也拿到），它的做法是**保持上一个最小框**——这里同样：仅当大候选是已提交
 *  元素的容器（完全包含它）且光标在其 12px 光环内时保持小框；平级元素切换零延迟。 */
function pickSmartRectAt(mx, my) {
  const inRect = (lv) => mx >= lv.x && mx <= lv.x + lv.width && my >= lv.y && my <= lv.y + lv.height;
  const act = getActiveChain();
  const use = act.list;
  if (!use.length) {
    smartCommitRect = null;
    return findWindowRectAt(mx, my) || detectUiElementAt(mx, my);
  }
  const idx = Math.max(0, Math.min(smartLevel, use.length - 1));
  const cand = use[idx];
  smartCommitRect = { rect: cand, src: act.src };
  return cand;
}



let lastHoverDbg = 0;
function getSmartHoverRect(mx, my) {
  // 发查询（16ms 节流）。框由 EFP 回包驱动。
  requestSmartPixel(mx, my);
  requestSmartIpc(mx, my);
}

/**
 * 滚轮/Tab 改变检测层级。
 * @param dir +1 向外（更大：父级/主窗/全屏），-1 向内（更小：子控件）
 */
function cycleSmartLevel(dir = 1) {
  const mx = pendingMouseX || W / 2;
  const my = pendingMouseY || H / 2;
  // 与画框同源的链（UIA 命中链优先）——两处索引空间必须一致
  const levels = getActiveChain().list;
  const maxLevel = Math.max(0, levels.length - 1);

  if (!levels.length) {
    smartLevel = smartLevel === 0 ? 1 : 0;
  } else {
    let next = smartLevel + (dir > 0 ? 1 : -1);
    if (next > maxLevel) next = maxLevel;
    if (next < 0) next = 0;
    smartLevel = next;
  }

  // 只改层级索引，矩形从**当前点**的 levels 取；视觉框连续缩放，不消失
  // 用户主动换层级：清掉滞回提交，允许立即换到更大/更小的框
  smartCommitRect = null;
  const r = pickSmartRectAt(mx, my);
  if (r) {
    lastGoodTarget = r;
    hoverStableRect = r;
  }
  if (SMART_DEBUG) console.error(`[cap] smartLevel -> ${smartLevel}/${maxLevel} ${r ? `${r.controlType || ''} ${Math.round(r.width)}x${Math.round(r.height)}` : 'null'}`);
  if (state === STATE.IDLE) {
    setHoverTarget(r || lastGoodTarget);
    updateSizeInfo(mx, my);
    updateGuideContent();
  }
}
function selectWindowRect(rect) {
  resetTranslationCache();
  selX = rect.x;
  selY = rect.y;
  selW = rect.width;
  selH = rect.height;
  hoverWindowRect = null;
  state = STATE.SELECTED;
  setSmartHoverMode('active');
  historyStack.length = 0;
  resetAnnots();
  strokes = [];
  curStroke = null;
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
      const out = {
        type: 'text', x: a.x, y: a.y, text: a.text,
        color: a.color, fontFamily: a.fontFamily, fontSize: a.fontSize,
        lineHeight: a.lineHeight, maxWidth: a.maxWidth,
        lines: Array.isArray(a.lines) ? a.lines.map((ln) => ({ text: ln.text, start: ln.start, end: ln.end, width: ln.width })) : [],
        editing: a.editing === true,
        // 粗体 / 斜体也要拷：漏掉会让「加粗的文字」进历史快照后瘦回去（与 fill 同类问题）
        bold: a.bold === true,
        italic: a.italic === true,
      };
      // 旋转角、旋转枢轴偏移与「部分擦除」笔迹也必须一起拷：漏掉 rot 会让转过的文字撤销一次
      // 就转回水平，漏掉 pvx/pvy 会让锁定过枢轴的文字在快照/克隆后绕错点转，
      // 漏掉 eraseStrokes 会让被擦掉的那部分重新长回来（与 fill 同类问题）。
      if (a.rot) out.rot = a.rot;
      if (a.pvx != null && a.pvy != null) { out.pvx = a.pvx; out.pvy = a.pvy; }
      if (Array.isArray(a.eraseStrokes) && a.eraseStrokes.length) {
        out.eraseStrokes = a.eraseStrokes.map((s) => ({
          kind: s.kind || 'path',
          size: s.size || 0,
          points: Array.isArray(s.points) ? s.points.map((p) => p.slice()) : [],
        }));
      }
      return out;
    }
    const out = { type: 'shape', shape: a.shape, x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, color: a.color, size: a.size };
    // fill（填充模式）与 live（进行中的折线）必须一起拷：漏掉 fill 会让「填充矩形」进历史快照后
    // 变回描边（撤销一次就掉填充），漏掉 live 会让进行中的折线在快照里变成已定稿对象
    if (a.fill === true) out.fill = true;
    if (a.live === true) out.live = true;
    // 多点折线（Shift 模式）才有 points：逐点深拷贝，避免历史快照与原对象共享数组
    if (Array.isArray(a.points) && a.points.length) out.points = a.points.map((p) => [p[0], p[1]]);
    return out;
  });
}

/* ── 文字＝永久矢量对象（Snipaste 语义，2026-09-26 用户要求）──
   · 形状：画完处于「待确认」态（带选框 + 8 向手柄），点框外 / 切工具 / 画新东西时烘焙进位图；
   · 文字：确认后**不烘焙**，作为矢量对象一直留在对象层，用文字工具再点一下就继续编辑
     （文字/字号/颜色/字体按它自己的样式恢复）；
   · 橡皮擦擦到文字：把笔迹记进它的局部系（eraseStrokes）做挖空 —— 视觉上缺一块，
     再点它编辑即恢复成擦除前的完整样式。 */

/** 永久矢量对象（目前只有文字）：烘焙时跳过，也不参与「待确认」判定 */
function isPersistentAnnot(a) { return !!a && a.type === 'text'; }
/** 待确认对象下标（未烘焙的形状，最多一个；进行中的折线也算）；-1 = 没有 */
function pendingAnnotIndex() {
  for (let i = annotations.length - 1; i >= 0; i--) {
    if (!isPersistentAnnot(annotations[i])) return i;
  }
  return -1;
}
/** 待确认且已收尾的对象下标：手柄命中 / 本体命中 / 改色只认它（进行中的折线不算） */
function pendingSettledIndex() {
  const i = pendingAnnotIndex();
  return i >= 0 && !annotations[i].live ? i : -1;
}

/**
 * 「当前带选框 + 8 个手柄 + 旋转手柄」的对象：
 *  · 优先待确认的形状（画完没定稿的那个）；
 *  · 没有形状时退到**最上层的文字对象** —— 文字是永久矢量，Snipaste 式常显选框，
 *    随时可以直接拖动 / 拉伸 / 旋转，不用先切工具（2026-09-26 用户要求）。
 * 形状定稿后（点框外烘焙）就只剩文字常显，不会满屏选框。
 */
function activeAnnotIndex() {
  const pi = pendingAnnotIndex();
  if (pi >= 0 && !annotations[pi].live) return pi;
  // 手势进行中：正在缩放/拖动的对象就是手柄层的服务对象（2026-09-29 用户反馈
  // 「拉伸过程中框没有正常显示」——手势中框+手柄必须全程可见）
  if (state === STATE.RESIZING && annotResizeIndex >= 0 && annotations[annotResizeIndex]) return annotResizeIndex;
  if (state === STATE.MOVING && dragAnnotIndex >= 0 && annotations[dragAnnotIndex]) return dragAnnotIndex;
  // 2026-09-29 重构（用户反馈"边框和操作是两个层次，第一次点击在切换层次"）：
  // 已提交文字**不再挂常驻选框/手柄**——交互全走直接命中（悬停=移动光标、拖动=移动、
  // 点击=编辑，见 pendingTextEdit 机制），没有"先激活再操作"的两层步骤（Snipaste 同语义）。
  return -1;
}

/* ── 文字对象的旋转（2026-09-26 用户要求「真旋转」；同日二改：绕中心自转）──
   模型：a.rot 为弧度，绕**文字块的中心（重心）**旋转 —— Snipaste 语义，整体原地自转，
   不会像绕框角那样「甩着转」（2026-09-26 用户反馈：别人的很丝滑，我们卡顿）。
   中心会随文字增长/折行而移动，所以一旦真的开始旋转就把枢轴**钉住**（a.pvx/a.pvy =
   枢轴相对框左上角的偏移）：之后打字、改字号、重新折行，枢轴都不再漂。
   渲染 = 在 ctx 上按该枢轴做 rotate；命中 / 手柄 = 把世界坐标点反旋回「局部系」再按
   矩形判定；手柄层用 CSS `rotate` + `transform-origin`（容器左上角内缩 pad 再加枢轴偏移）；
   擦除笔迹存局部系（相对文字块左上角），随对象一起转。 */
/** 枢轴相对「文字块左上角」的偏移：锁定过就用锁定值，没锁过取当前框中心 */
function pivotOffset(a) {
  if (a && a.pvx != null && a.pvy != null) return { x: a.pvx, y: a.pvy };
  const b = annotBounds(a);
  return { x: b.w / 2, y: b.h / 2 };
}
/** 旋转枢轴（世界坐标）= 文字块左上角 + 枢轴偏移 */
function annotPivot(a) {
  const p = pivotOffset(a);
  return { x: a.x + p.x, y: a.y + p.y };
}
function annotRot(a) { return a && a.type === 'text' && a.rot ? a.rot : 0; }
/** 在 ctx 上绕 c 旋转 rot 弧度（rot 为 0 时零开销） */
function applyRotAbout(ctx, c, rot) {
  if (!rot) return;
  ctx.translate(c.x, c.y);
  ctx.rotate(rot);
  ctx.translate(-c.x, -c.y);
}
/** 世界坐标 → 对象局部（未旋转）坐标 */
function annotToLocal(a, mx, my) {
  const rot = annotRot(a);
  if (!rot) return { x: mx, y: my };
  const c = annotPivot(a);
  const cos = Math.cos(-rot);
  const sin = Math.sin(-rot);
  const dx = mx - c.x;
  const dy = my - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}
/** 局部坐标 → 世界坐标 */
function annotToWorld(a, lx, ly) {
  const rot = annotRot(a);
  if (!rot) return { x: lx, y: ly };
  const c = annotPivot(a);
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const dx = lx - c.x;
  const dy = ly - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}
/** 旋转后的世界包围盒（框选擦 / 宽容命中用；未旋转时就等于 annotBounds） */
function annotWorldBounds(a) {
  const b = annotBounds(a);
  const rot = annotRot(a);
  if (!rot) return b;
  const c = annotPivot(a); // 枢轴（= 旋转不动点），不能再用「框中心」——锁定过枢轴时两者不同
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const pts = [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]]
    .map(([x, y]) => {
      const dx = x - c.x;
      const dy = y - c.y;
      return [c.x + dx * cos - dy * sin, c.y + dx * sin + dy * cos];
    });
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 };
}
/** 把 ctx 变换到「文字局部系」：局部 (0,0) = 文字块左上角，
 *  局部坐标轴绕**枢轴**（框中心，或锁定过的 pivotOffset）随 rot 一起转。
 *  擦除笔迹也存这一系，天然跟着文字一起转。 */
function applyAnnotLocalSpace(ctx, a) {
  ctx.translate(a.x, a.y);
  const rot = annotRot(a);
  if (rot) {
    const p = pivotOffset(a);
    ctx.translate(p.x, p.y);
    ctx.rotate(rot);
    ctx.translate(-p.x, -p.y);
  }
}
/** 向量旋转（局部 → 世界方向） */
function rotVec(x, y, rot) {
  if (!rot) return { x, y };
  const c = Math.cos(rot); const s = Math.sin(rot);
  return { x: x * c - y * s, y: x * s + y * c };
}
/** 向量逆旋转（世界方向 → 局部方向） */
function unrotVec(x, y, rot) {
  if (!rot) return { x, y };
  const c = Math.cos(rot); const s = Math.sin(rot);
  return { x: x * c + y * s, y: -x * s + y * c };
}
/** 旋转手柄中心离选框上边的距离（CSS px）—— 常显的小圆，压在框上方居中。
 *  14px 的钮 + 4px 留白，取 18 就够；旧值 26 是给 22px 大圆留的，小框上会顶到别的把手。 */
const ANNOT_ROTATE_OFFSET = 18;
/** 每个缩放手柄的缩放符号（sx/sy：0 = 该轴不动）与「对角锚点」在框内的相对偏移比例（ax/ay）。
 *  旋转态缩放要把锚点钉在世界系不动，靠的就是这张表（rot=0 时仍走原逻辑）。 */
const ANNOT_SCALE_DEF = {
  br: { sx: 1, sy: 1, ax: 0, ay: 0 },
  bl: { sx: -1, sy: 1, ax: 1, ay: 0 },
  tr: { sx: 1, sy: -1, ax: 0, ay: 1 },
  tl: { sx: -1, sy: -1, ax: 1, ay: 1 },
  r: { sx: 1, sy: 0, ax: 0, ay: 0.5 },
  l: { sx: -1, sy: 0, ax: 1, ay: 0.5 },
  b: { sx: 0, sy: 1, ax: 0.5, ay: 0 },
  t: { sx: 0, sy: -1, ax: 0.5, ay: 1 },
};

/** 形状顶点序列：多点折线取 points；单段形状回退为两端点（拖动/命中/包围盒统一走这里） */
function shapePts(a) {
  if (a && Array.isArray(a.points) && a.points.length > 1) return a.points;
  return [[a.x1, a.y1], [a.x2, a.y2]];
}

/** 平移形状对象（含多点折线的全部顶点）；x1/y1/x2/y2 始终同步为「首点/末点」 */
function translateShape(a, dx, dy) {
  a.x1 += dx; a.y1 += dy; a.x2 += dx; a.y2 += dy;
  if (Array.isArray(a.points) && a.points.length) {
    for (const p of a.points) { p[0] += dx; p[1] += dy; }
  }
}

/** 深拷贝位图笔画数组（历史快照用）：points 逐点复制；preData 是共享只读 ImageData 直接引用 */
function cloneStrokes(src) {
  const list = Array.isArray(src) ? src : strokes;
  return list.map((s) => ({
    tool: s.tool,
    color: s.color,
    size: s.size,
    maskTool: s.maskTool,
    maskIntensity: s.maskIntensity,
    maskMode: s.maskMode,
    points: s.points ? s.points.map((p) => [p[0], p[1]]) : [],
    rect: s.rect ? { x1: s.rect.x1, y1: s.rect.y1, x2: s.rect.x2, y2: s.rect.y2 } : null,
    preData: s.preData,
    preRect: s.preRect ? { x: s.preRect.x, y: s.preRect.y, w: s.preRect.w, h: s.preRect.h } : null,
    clipRect: s.clipRect ? { x: s.clipRect.x, y: s.clipRect.y, w: s.clipRect.w, h: s.clipRect.h } : null,
  }));
}

/** 把当前 annotations 整层重绘到 annotCanvas（裁到选区；空数组只清屏） */
function renderAnnots() {
  if (!annotCtx) return;
  annotCtx.clearRect(0, 0, W, H);
  if (annotations.length) {
    // 文字**不裁剪**（2026-09-28 用户反馈"字体会闪现消失"）：文字可越出选区边界——
    // 选区后续缩小/文字写在边缘时，超出部分被 clip 掉 = 打着打着字没了。
    // Snipaste 同语义；导出仍按选区矩形裁剪，越界部分不进成品。
    for (const a of annotations) {
      // 全屏画布：全部不裁剪（选框外可见，导出按选框矩形裁剪）
      if (a.type === 'text') drawAnnotText(annotCtx, a);
      else drawAnnotShape(annotCtx, a);
    }
  }
  // 当前「活动」对象的选框**不画在这里**：改由 DOM 层（#annotHandles 的 border）绘制。
  // 原因有二（2026-09-26 用户要求）：
  //  ① 框线颜色要跟着底图自动对比（白底黑框 / 黑底白框）—— 只有 DOM 层能低成本逐帧改色；
  //  ② annotCanvas 会被 cropSelectionWithAnnotations 整层合进导出图，框线画上去会印在截图里。
  // 橡皮擦悬停位图笔画：同样画虚线选中框，提示可整笔擦除
  if (activeTool === 'eraser' && hoverStrokeIndex >= 0 && strokes[hoverStrokeIndex]) {
    const sb = strokeBounds(strokes[hoverStrokeIndex]);
    if (sb && (sb.w > 0 || sb.h > 0)) {
      clipToSelection(annotCtx);
      drawAnnotSelectionBox(annotCtx, { x1: sb.x, y1: sb.y, x2: sb.x + sb.w, y2: sb.y + sb.h });
      restoreClip(annotCtx);
    }
  }
  syncAnnotHandles(); // DOM 缩放手柄跟随对象包围盒（每次对象层重绘都同步一次）
  syncTextStyleRowVisibility(); // 待确认文字对象在时露出加粗/斜体/字体样式条
}

/** 对象选中框：虚线描边 + 半透明底（悬停提示 / 拖动反馈共用） */
function drawAnnotSelectionBox(ctx, a) {
  const b = annotBounds(a);
  if (!b || (b.w <= 0 && b.h <= 0)) return;
  const pad = 4;
  ctx.save();
  // 文字对象带旋转时选框一起转（绕同一枢轴）→ 框线始终贴合文字，不会出现「字斜框正」
  applyRotAbout(ctx, annotPivot(a), annotRot(a));
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
  syncAnnotHandles(); // 对象没了，DOM 缩放手柄一起收起
  syncTextStyleRowVisibility(); // 待确认文字对象没了，样式条跟着收起
}

/**
 * 「确认」待确认对象：按当前颜色 / 线宽把它一次性烘焙进位图，随后清空对象层。
 *
 * Snipaste 式延迟烘焙（2026-09-25 用户要求）：
 * · 画完 → 对象留在对象层、带选框，可拖动 / 改色 / 改线宽 / 改字号；
 * · 确认（点别处、切工具、画新东西、Enter、导出类动作）→ 烘焙成普通像素；
 * · 烘焙后不可再编辑，但橡皮擦能直接像素级擦掉它，图层顺序也按绘制时间正确。
 * 只在确认这一刻压一次位图快照 —— 所以 Ctrl+Z 一步撤销「整个对象（含确认前的调整）」。
 * @returns 是否真的烘焙了对象
 */
function bakeActiveAnnots() {
  const idx = pendingAnnotIndex();
  if (idx < 0) return false;
  clipToSelection(drawCtx);
  for (const a of annotations) {
    if (isPersistentAnnot(a) || a.live) continue; // 文字永久留矢量；进行中的折线等它自己收尾
    drawAnnotShape(drawCtx, a);
  }
  restoreClip(drawCtx);
  // 只摘掉被烘焙的形状：文字对象继续留在对象层（随时可再点开编辑）
  annotations = annotations.filter((a) => isPersistentAnnot(a) || a.live);
  syncAnnotHandles();
  renderAnnots();
  commitHistory(true);
  return true;
}

/** 有待确认的形状就确认（返回是否发生确认）；文字是永久矢量，不参与 */
function commitPendingAnnot() {
  return pendingSettledIndex() >= 0 ? bakeActiveAnnots() : false;
}

/** 丢弃待确认的形状（不烘焙）：右键 —— 相当于「取消刚画的这一件」，不影响已有文字 */
function discardPendingAnnot() {
  const idx = pendingAnnotIndex();
  if (idx < 0) return false;
  annotations.splice(idx, 1);
  syncAnnotHandles();
  renderAnnots();
  updateGuideContent();
  return true;
}

/* ── 待确认对象的 8 方向缩放手柄（Snipaste 式：选框还在时既能拖也能拉大小）──
   用 DOM 手柄层（#annotHandles）而不是画在 annotCanvas 上：annotCanvas 会被合进导出图，
   画上去的手柄会跟着进截图结果；DOM 层不参与任何导出，也不挡鼠标（pointer-events:none）。 */
let annotResizeHandle = '';
/** 正在被缩放的对象下标（文字不带手柄，所以这里通常就是那个待确认形状） */
let annotResizeIndex = -1;
let annotResizeBase = null;
let annotResizeBox = null;
/** 旋转手柄按下瞬间「枢轴 → 光标」的角度（rad）；拖动时按差值改 rot */
let annotResizeStartAngle = 0;
const ANNOT_HANDLE_POS = ['tl', 't', 'tr', 'r', 'br', 'b', 'bl', 'l'];
const HANDLE_CURSOR = {
  tl: 'nwse-resize', t: 'ns-resize', tr: 'nesw-resize', r: 'ew-resize',
  br: 'nwse-resize', b: 'ns-resize', bl: 'nesw-resize', l: 'ew-resize',
  rot: 'grab',
  del: 'pointer',
};
/** 对象选框外扩量（与 drawAnnotSelectionBox 的 pad 一致，手柄正好压在框线上） */
const ANNOT_BOX_PAD = 4;
/** 对象手柄的视觉边长（CSS px）—— 必须与 capture.css 里 #annotHandles .capture-handle 一致。
 *  旧值 20px 太大：小文字框上 8 个手柄互相叠，糊成一坨（2026-09-26 用户反馈），
 *  对齐 Snipaste 的 14px 圆角方块。 */
const ANNOT_HANDLE_SIZE = 14;
/** 手柄命中容差（CSS px）：略大于视觉尺寸，更好点 */
const ANNOT_HANDLE_HIT = 8;
/** 边中点手柄（t/b/l/r）自动收起的阈值：框的该方向短于 3 个手柄宽时，中点手柄会和
 *  两个角手柄叠在一起 —— 直接藏起来只留四角（Snipaste 的小框就是只有四角）。 */
const ANNOT_EDGE_HANDLE_MIN = ANNOT_HANDLE_SIZE * 3;

/** 文字框**尾部预留的空位数**（单位 = 一个字号，即 1em）。
 *  框不贴着最后一个字收口，后面留一段空白（2026-09-26 用户要求「文字后面预留几个空位」）：
 *  ① 框宽了四角手柄才散得开，不会在小框上挤成一坨；② 观感上像「还能继续输入」的文本域。 */
const ANNOT_TEXT_TRAIL_SLOTS = 0.5;

/** 文字框尾部预留宽度（CSS px） */
function textTrailPad(fontSize) {
  return Math.round((fontSize || 16) * ANNOT_TEXT_TRAIL_SLOTS);
}

/** 编辑中的文字（不在 annotations 数组里）在「缩放 / 拖动」这套机制里的伪下标。
 *  手柄、命中、缩放都按「目标对象」抽象，于是编辑态与已提交对象走同一条路。
 *  取 -2 而不是 -1：-1 已被占作「没有对象」的空值，复用会让「拖动中」与「编辑中」撞车。 */
const EDITING_TARGET = -2;

/** 手柄层当前要服务的对象：优先「正在编辑的文字」，否则「被选中的对象」。
 *  编辑文字时也常显选框 + 手柄 + 旋转 + 删除（2026-09-26 用户要求：任何时候都有点）。 */
function activeHandleObj() {
  if (textEditor && editingTextAnnot) return editingTextAnnot;
  const ai = activeAnnotIndex();
  return ai >= 0 ? annotations[ai] : null;
}

/** 配套下标（编辑中的对象返回 EDITING_TARGET），供 annotResizeIndex / dragAnnotIndex 使用 */
function activeHandleIndex() {
  if (textEditor && editingTextAnnot) return EDITING_TARGET;
  return activeAnnotIndex();
}

/** 下标 → 对象（EDITING_TARGET 取编辑中的临时对象） */
function annotAt(index) {
  if (index === EDITING_TARGET) return editingTextAnnot;
  return index >= 0 ? annotations[index] : null;
}

/** 指针是否停在「当前活动对象」的选框上（含手柄 / 旋转 / 删除钮的命中范围，以及拖动·缩放·编辑中）。
 *  手柄组「悬停才显」的判据（2026-09-26 用户要求，对齐 Snipaste）：8 个缩放手柄和 ✕
 *  平时收起来、鼠标移上去才出现；常显的只有旋转按钮；框内任意处直接拖动即可移动，不要移动徽标。 */
function pointerOnActiveAnnot() {
  const a = activeHandleObj();
  if (!a) return false;
  if (textEditor) return true; // 文字编辑中：textarea 就盖在框上，指针天然在框内
  const b = annotBounds(a);
  if (!b || (b.w <= 0 && b.h <= 0)) return false;
  // 手势进行中保持常显：否则鼠标一滑出框手柄就没了，拖到一半失去抓手
  const idx = activeHandleIndex();
  if (state === STATE.MOVING && dragAnnotIndex === idx) return true;
  if (state === STATE.RESIZING && annotResizeIndex === idx) return true;
  // 旋转钮吊在框外 ANNOT_ROTATE_OFFSET px、删除钮就在右上角：指针压在这两个上时也必须算
  // 「在框上」，否则 ✕ 会「因为鼠标离开框而消失 → 永远点不到」（自指死锁）
  if (annotHandleAt(pendingMouseX, pendingMouseY)) return true;
  const l = annotToLocal(a, pendingMouseX, pendingMouseY);
  const pad = ANNOT_BOX_PAD + ANNOT_HANDLE_HIT;
  return l.x >= b.x - pad && l.x <= b.x + b.w + pad
    && l.y >= b.y - pad && l.y <= b.y + b.h + pad;
}

/* ── 选框对比色（2026-09-26 用户要求「对齐 Snipaste：白底黑框、黑底白框」）──
   背景像素只在本会话里换（新截图 / 长截图进出），这里做一张 1/8 降采样亮度图缓存，
   采样退化成 O(1) 查表，拖拽帧里不会反复 getImageData。 */
const ANNOT_LUMA_STEP = 8;
let annotLumaData = null;
let annotLumaW = 0;
let annotLumaH = 0;
let annotLumaDirty = true;
/** 底图换图时作废亮度缓存（drawBackground 会置脏，下次取色时重建一张） */
function invalidateAnnotLuma() { annotLumaDirty = true; }

function ensureAnnotLuma() {
  if (!annotLumaDirty && annotLumaData) return;
  annotLumaDirty = false;
  annotLumaData = null;
  if (!bgCanvas || !bgCanvas.width || !bgCanvas.height) return;
  try {
    const sw = Math.max(1, Math.ceil(bgCanvas.width / ANNOT_LUMA_STEP));
    const sh = Math.max(1, Math.ceil(bgCanvas.height / ANNOT_LUMA_STEP));
    const c = document.createElement('canvas');
    c.width = sw;
    c.height = sh;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(bgCanvas, 0, 0, sw, sh);
    annotLumaData = cx.getImageData(0, 0, sw, sh).data;
    annotLumaW = sw;
    annotLumaH = sh;
  } catch (_) { annotLumaData = null; }
}

/** 逻辑坐标 (x,y) 处的底图亮度 0..1；无数据返回 -1 */
function lumaAtLogical(x, y) {
  if (!annotLumaData) return -1;
  // 逻辑 → 底图 backing 的换算取实际比例：虚拟屏路径 = dpr，长截图编辑态 = 原图/W。
  const k = bgCanvas.width / Math.max(1, W);
  const ix = Math.min(annotLumaW - 1, Math.max(0, Math.floor((x * k) / ANNOT_LUMA_STEP)));
  const iy = Math.min(annotLumaH - 1, Math.max(0, Math.floor((y * k) / ANNOT_LUMA_STEP)));
  const o = (iy * annotLumaW + ix) * 4;
  return (annotLumaData[o] * 0.299 + annotLumaData[o + 1] * 0.587 + annotLumaData[o + 2] * 0.114) / 255;
}

/** 活动对象选框处的平均底图亮度：沿选框四边各取 5 点（避开框内的文字/图形本身） */
function annotFrameLuma(a) {
  ensureAnnotLuma();
  if (!annotLumaData) return -1;
  const b = annotBounds(a);
  if (!b) return -1;
  const x0 = b.x - ANNOT_BOX_PAD;
  const y0 = b.y - ANNOT_BOX_PAD;
  const x1 = b.x + b.w + ANNOT_BOX_PAD;
  const y1 = b.y + b.h + ANNOT_BOX_PAD;
  let sum = 0;
  let n = 0;
  for (let i = 0; i <= 4; i++) {
    const f = i / 4;
    const fx = x0 + (x1 - x0) * f;
    const fy = y0 + (y1 - y0) * f;
    for (const [lx, ly] of [[fx, y0], [fx, y1], [x0, fy], [x1, fy]]) {
      const p = annotToWorld(a, lx, ly); // 带旋转的框：取样点也要跟着转
      const v = lumaAtLogical(p.x, p.y);
      if (v >= 0) { sum += v; n++; }
    }
  }
  return n ? sum / n : -1;
}

/** 底图亮度 → 一组「对比色」（2026-09-26 用户要求：白底显黑、黑底显白，边框与光标同一套）。
 *  luma 为暗底（≤0.5）→ 出浅色；亮底 → 出深色；无数据（-1）按亮底兜底。
 *  @returns {{line:string, halo:string, solid:string}} line=框线, halo=反向极淡外发光, solid=实心（边框/光标） */
function frameInk(luma) {
  const light = luma >= 0 && luma <= 0.5;
  return {
    line: light ? 'rgba(255, 255, 255, .95)' : 'rgba(12, 14, 18, .92)',
    halo: light ? 'rgba(0, 0, 0, .28)' : 'rgba(255, 255, 255, .28)',
    solid: light ? '#ffffff' : '#0c0e12',
  };
}

/** 上一次真正写进 DOM 的「指针是否在选框上」——用于 pointermove 每帧的廉价去重，
 *  避免为了刷新悬停态每帧都跑一遍亮度采样 + 全量 DOM 写入（那本身就是卡顿源）。 */
let annotHoverApplied = null;

/** 把 #annotHandles 定位到「当前活动对象」的包围盒上（无活动对象则隐藏）。
 *  文字带旋转时给容器加 CSS rotate：transform-origin 取**旋转枢轴**（= 框中心，或锁定过的
 *  pivotOffset）在容器里的位置，于是 8 个手柄、旋转柄、删除钮自动跟着文字一起转。
 *  它同时承担选框本身的绘制（容器 border + 对比色）与手柄组的悬停显隐。 */
function syncAnnotHandles() {
  if (!annotHandles) return;
  const a = activeHandleObj();
  const b = a ? annotBounds(a) : null;
  // 2026-09-29 复盘（用户截图实锤）：此前缩放中显示「拖出矩形」造成第二个图层——
  // 松手后文字按新字号重排，手柄层停在拖出框旧位置 ≠ 文字实际框，点击自己看到的
  // 手柄位置会被判定 NONE → 变编辑。**单一图层铁律**：手柄/框线恒贴文字实际框。
  // 空文字对象（点文字工具后没输入就确认、折行把每行压成 0 宽等）会得到一个 1~9px 的小框：
  // 旋转钮孤零零浮在半空、悬停时 5 个把手全挤在几像素里 —— 这就是「堆叠成一坨」的根因
  // （2026-09-26 实测复现：9×34 的框 + rotate 悬空）。内容为空或包围盒退化到没法用 → 整层收起。
  const emptyText = !!a && a.type === 'text' && !String(a.text || '').trim();
  if (!b || b.w < 2 || b.h < 2 || emptyText) {
    annotHandles.style.display = 'none';
    annotHandles.classList.remove('is-hover');
    annotHoverApplied = false;
    if (annotRotateHandle) annotRotateHandle.style.display = 'none';
    if (annotDeleteHandle) annotDeleteHandle.style.display = 'none';
    return;
  }
  const rot = annotRot(a);
  annotHandles.style.display = 'block';
  annotHandles.style.left = `${b.x - ANNOT_BOX_PAD}px`;
  annotHandles.style.top = `${b.y - ANNOT_BOX_PAD}px`;
  annotHandles.style.width = `${b.w + ANNOT_BOX_PAD * 2}px`;
  annotHandles.style.height = `${b.h + ANNOT_BOX_PAD * 2}px`;
  annotHandles.style.transform = rot ? `rotate(${rot}rad)` : 'none';
  // 枢轴 = 文字框中心（或锁定过的 pivotOffset）；容器左上角内缩了 ANNOT_BOX_PAD，
  // 故 origin 要再加上枢轴相对框左上角的偏移（旧模型枢轴=左上角时这一项是 0）。
  const pv = pivotOffset(a);
  annotHandles.style.transformOrigin = `${ANNOT_BOX_PAD + pv.x}px ${ANNOT_BOX_PAD + pv.y}px`;
  // 框线颜色按底图亮度取反：亮底→深色线、暗底→浅色线；再补一圈反向极淡外发光，
  // 让线在中间灰度上也分得开（对齐 Snipaste 的自适应边框观感）。
  const luma = annotFrameLuma(a);
  const ink = frameInk(luma);
  // 8 个缩放手柄 + ✕ 只在指针停在选框上时露出（class 由 capture.css 消费）。
  // 框线本体也一样只在悬停时显示：未悬停的已提交文字只剩「旋转钮」一个常显标记
  // （2026-09-26 用户要求「鼠标没放在框上就不显示，四周的框放上去才显示；长显的只有旋转按钮」。
  //  旧实现无条件写 ink.line，于是提交后的文字身上一直挂着一圈框线。）
  const hovered = pointerOnActiveAnnot();
  annotHoverApplied = hovered;
  annotHandles.classList.toggle('is-hover', hovered);
  // 编辑中：hint 框已经在画这个框了，对象层不再叠第二条线（否则两框错开一点就像「重影」）
  const showFrame = !textEditor && hovered;
  annotHandles.style.borderColor = showFrame ? ink.line : 'transparent';
  annotHandles.style.boxShadow = showFrame ? `0 0 0 1px ${ink.halo}` : 'none';
  // 手柄「少即是多」（对齐 Snipaste，根治小框上「堆积成一坨」）：
  //  · is-text：文字框只留四角（右上角让位给 ✕），四条边中点全收 —— 见 capture.css
  //  · no-tb / no-lr：框的某一边短于 3 个手柄宽时，那一侧的中点手柄收起（图形框用）
  const isText = a.type === 'text';
  annotHandles.classList.toggle('is-text', isText);
  annotHandles.classList.toggle('no-tb', b.w < ANNOT_EDGE_HANDLE_MIN);
  annotHandles.classList.toggle('no-lr', b.h < ANNOT_EDGE_HANDLE_MIN);
  // 框本身就小：把手整组按比例缩小（14→11px），否则 14px 方块在小框四角还是会挨在一起
  annotHandles.classList.toggle('is-small', Math.min(b.w, b.h) < ANNOT_EDGE_HANDLE_MIN);
  // 旋转手柄常显（用户要求：长显的只有它）；删除钮跟手柄组一起悬停才出。
  // 旋转 / 删除只给文字对象（形状不旋转）—— 它们随容器一起转，永远吊在选框法线方向。
  if (annotRotateHandle) annotRotateHandle.style.display = isText ? 'flex' : 'none';
  if (annotDeleteHandle) annotDeleteHandle.style.display = (isText && hovered) ? 'flex' : 'none';
}

/** 指针每帧移动后刷新「选框悬停态」——只在状态真的翻转时才做全量同步。
 *  为什么需要它（2026-09-26 用户反馈「点了别处，边框过一会儿才消失」）：
 *  is-hover 只在 syncAnnotHandles 里按**当前指针位置**重算，而它此前只由「悬停对象变了 /
 *  命中把手 / 光标闪烁 530ms 定时器」触发 —— 指针移开选框但没跨到别的对象上时，
 *  这一帧没人调用 → 手柄与框要挂到下一次触发才消失（最长约半秒，就是那「准备一段时间」）。 */
function syncAnnotHoverIfChanged() {
  if (!annotHandles || state !== STATE.SELECTED) return;
  const on = pointerOnActiveAnnot();
  if (on === annotHoverApplied) return;
  syncAnnotHandles();
}

/** 活动对象选框在「局部系（未旋转）」里的 8 个手柄坐标。旋转时先把光标反旋回这一系再比对。 */
function annotHandleLocalPts(a) {
  const b = annotBounds(a);
  const x0 = b.x - ANNOT_BOX_PAD;
  const y0 = b.y - ANNOT_BOX_PAD;
  const x1 = b.x + b.w + ANNOT_BOX_PAD;
  const y1 = b.y + b.h + ANNOT_BOX_PAD;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  return {
    tl: [x0, y0], t: [cx, y0], tr: [x1, y0], r: [x1, cy],
    br: [x1, y1], b: [cx, y1], bl: [x0, y1], l: [x0, cy],
  };
}
/** 旋转手柄在局部系里的位置：选框上边中点再往上 ANNOT_ROTATE_OFFSET */
function annotRotateLocalPt(a) {
  const b = annotBounds(a);
  return [b.x + b.w / 2, b.y - ANNOT_BOX_PAD - ANNOT_ROTATE_OFFSET];
}

/** 删除按钮在局部系里的位置 = **选框右上角**（= tr 手柄的位置，对齐 Snipaste：
 *  ✕ 直接占用右上角那个把手位，不往外再吊一个圆，小框上才不会挤成一坨）。
 *  与 capture.css 里 .capture-annot-delete 的 left:100%/top:0 + translate(-50%,-50%) 严格对齐 */
function annotDeleteLocalPt(a) {
  const b = annotBounds(a);
  return [b.x + b.w + ANNOT_BOX_PAD, b.y - ANNOT_BOX_PAD];
}

/** 命中活动对象的手柄 → 'tl' | … | 'rot' | 'del' | '' */
/** 框级命中：点在文字对象包围盒+pad 内（不要求压到字形）——手柄/拖动/编辑的初筛用。
 *  字形级 hitTestAnnot 只认可见文字，框角/边缘留白处返回 -1 → 手柄段进不去 → 新建（用户实测）。 */
function textAnnotAtBox(mx, my) {
  for (let i = annotations.length - 1; i >= 0; i--) {
    const a = annotations[i];
    if (!a || a.type !== 'text' || a.editing || a.live) continue;
    if (!String(a.text || '').trim()) continue;
    const b = annotBounds(a);
    const l = annotToLocal(a, mx, my);
    if (l.x >= b.x - ANNOT_BOX_PAD && l.x <= b.x + b.w + ANNOT_BOX_PAD
      && l.y >= b.y - ANNOT_BOX_PAD && l.y <= b.y + b.h + ANNOT_BOX_PAD) return i;
  }
  return -1;
}

/** 任意「文字对象」的手柄命中（参数化版 annotHandleAt）：几何完全同源，
 *  供任意工具下悬停/拖动已提交文字的边角拉伸用（2026-09-29 用户要求）。 */
function textHandleAt(a, mx, my) {
  if (!a || a.type !== 'text') return '';
  const b = annotBounds(a);
  if (!b || (b.w <= 0 && b.h <= 0)) return '';
  const l = annotToLocal(a, mx, my);
  const rp = annotRotateLocalPt(a);
  if (Math.hypot(l.x - rp[0], l.y - rp[1]) <= ANNOT_HANDLE_HIT + 3) return 'rot';
  const dp = annotDeleteLocalPt(a);
  if (Math.hypot(l.x - dp[0], l.y - dp[1]) <= ANNOT_HANDLE_HIT + 3) return 'del';
  const pts = annotHandleLocalPts(a);
  const hideTb = b.w < ANNOT_EDGE_HANDLE_MIN;
  const hideLr = b.h < ANNOT_EDGE_HANDLE_MIN;
  for (const pos of ANNOT_HANDLE_POS) {
    if (pos === 'tr') continue; // ✕ 占位
    if (hideTb && (pos === 't' || pos === 'b')) continue;
    if (hideLr && (pos === 'r' || pos === 'l')) continue;
    const q = pts[pos];
    if (Math.abs(l.x - q[0]) <= ANNOT_HANDLE_HIT + 4 && Math.abs(l.y - q[1]) <= ANNOT_HANDLE_HIT + 4) return pos;
  }
  return '';
}

function annotHandleAt(mx, my) {
  const a = activeHandleObj();
  if (!a) return '';
  const b = annotBounds(a);
  if (!b || (b.w <= 0 && b.h <= 0)) return '';
  const l = annotToLocal(a, mx, my); // 旋转是刚体变换，长度不变 → 距离判定可在局部系做
  if (a.type === 'text') {
    const rp = annotRotateLocalPt(a);
    if (Math.hypot(l.x - rp[0], l.y - rp[1]) <= ANNOT_HANDLE_HIT + 3) return 'rot';
    const dp = annotDeleteLocalPt(a);
    if (Math.hypot(l.x - dp[0], l.y - dp[1]) <= ANNOT_HANDLE_HIT + 3) return 'del';
  }
  const pts = annotHandleLocalPts(a);
  // 视觉上被「少即是多」规则收起来的手柄不再参与命中（否则会出现「点空白处莫名缩放」）：
  // 文字框只留 tl / bl / br 三角 + ✕；图形框某侧过短时该侧中点也停用。
  const isText = a.type === 'text';
  const hideTb = isText || b.w < ANNOT_EDGE_HANDLE_MIN;
  const hideLr = isText || b.h < ANNOT_EDGE_HANDLE_MIN;
  for (const pos of ANNOT_HANDLE_POS) {
    if (isText && pos === 'tr') continue; // ✕ 占位
    if (hideTb && (pos === 't' || pos === 'b')) continue;
    if (hideLr && (pos === 'r' || pos === 'l')) continue;
    const p = pts[pos];
    if (Math.abs(l.x - p[0]) <= ANNOT_HANDLE_HIT && Math.abs(l.y - p[1]) <= ANNOT_HANDLE_HIT) return pos;
  }
  return '';
}

/**
 * 活动对象的「本体」命中：直接按它的选框（包围盒 + 手柄内边距）判定。
 * 不用 hitTestAnnot 的描边容差 —— 细线/斜线只有线本身能命中，框内空白处点下去会被当成
 * 「点别处 = 确认」而烘焙掉对象、接着开始画新的一笔（2026-09-25 用户反馈：
 * 「选框还在时想拖动，一点击就变成画新的线了」）。按选框判定后，框内任意处都能整体拖动，
 * 和 Snipaste「框还在 = 整体可挪」一致；想确认就点框外。
 * 文字对象带旋转时先把光标反旋回局部系再判矩形（否则斜着的框会错位命中）。
 * @returns {number} 命中的对象下标；-1 = 未命中
 */
function annotBodyHit(mx, my) {
  const a = activeHandleObj();
  if (!a) return -1;
  const b = annotBounds(a);
  if (!b || (b.w <= 0 && b.h <= 0)) return -1;
  const l = annotToLocal(a, mx, my);
  if (l.x < b.x - ANNOT_BOX_PAD || l.x > b.x + b.w + ANNOT_BOX_PAD) return -1;
  if (l.y < b.y - ANNOT_BOX_PAD || l.y > b.y + b.h + ANNOT_BOX_PAD) return -1;
  return activeHandleIndex();
}

/**
 * 拖动对象缩放手柄：被拖的边跟光标走、对边固定；始终从「按下瞬间的 base 对象」重算
 * （不是逐帧累加），所以来回拖不会产生漂移。
 * 零宽度/零高度（纯水平线、纯垂直线）在那一轴退化为平移；文字对象按高度比例缩放字号并重新折行。
 */
function scaleActiveAnnot(mx, my) {
  lastGestureMouse = { x: mx, y: my };
  const base = annotResizeBase;
  const b0 = annotResizeBox;
  const h = annotResizeHandle;
  if (process.env.PETALSNAP_SMART_DEBUG === '1') console.error(`[TXT] scale enter mx,my=${mx},${my} idx=${annotResizeIndex} handle=${h} b0=${b0 ? b0.x + ',' + b0.y + ',' + b0.w + ',' + b0.h : 'null'}`);
  if (!annotAt(annotResizeIndex) || !base || !b0 || !h) return;
  const minSide = 8; // 最小边长：缩到 0 就再也拉不回来
  const px = Math.max(selX, Math.min(mx, selX + selW));
  const py = Math.max(selY, Math.min(my, selY + selH));

  // ① 旋转手柄：绕「文字框中心」自转（Snipaste 语义，2026-09-26 用户要求「中心对称」），
  //    转角 = 当前角 − 按下瞬间角（Shift → 吸附 15° 整数倍）。
  //    注意：起点/当前角必须都从同一个枢轴量，否则拖起来会跳（起点角见 tryBeginAnnotGesture）。
  if (h === 'rot') {
    const b1 = annotBounds(base);
    const c = { x: base.x + b1.w / 2, y: base.y + b1.h / 2 };
    const pvOld = pivotOffset(base);
    const pvNew = { x: b1.w / 2, y: b1.h / 2 };
    const na = cloneAnnots([base])[0];
    // 角度必须用**未钳制**的光标：px/py 被锁在截图选区内，选区小的时候光标一出去
    // 角度就跟着卡住不动（2026-09-26 用户反馈「转起来卡顿、不跟手」）。
    let nr = (base.rot || 0) + (Math.atan2(my - c.y, mx - c.x) - annotResizeStartAngle);
    if (modShiftDown) {
      const step = Math.PI / 12;
      nr = Math.round(nr / step) * step;
    }
    na.rot = nr;
    // 把枢轴钉在「这次旋转时的框中心」：之后打字/改字号/折行让框变了，枢轴也不再漂，
    // 画面不会一边输入一边游走；下一次再转时又会刷新成当时的中心。
    // 换枢轴会让 W(l) = t + pv + R·(l − pv) 在同一次几何下变一次 → 必须补位移，
    // 否则第二次旋转（框已被改过、旧枢轴不在中心）一按下就整块跳一下：
    //   t' = t + pv_old − pv_new + R·(pv_new − pv_old)   ← 让「框中心」的世界位置不变
    if (pvOld.x !== pvNew.x || pvOld.y !== pvNew.y) {
      const dv = rotVec(pvNew.x - pvOld.x, pvNew.y - pvOld.y, base.rot || 0);
      na.x = base.x + pvOld.x - pvNew.x + dv.x;
      na.y = base.y + pvOld.y - pvNew.y + dv.y;
    }
    na.pvx = pvNew.x;
    na.pvy = pvNew.y;
    applyResizeResult(na);
    return;
  }

  const def = ANNOT_SCALE_DEF[h];
  if (!def) return;
  const rot = annotRot(base);

  // ② 带旋转的文字：尺寸解 + 位置解，都从「按下瞬间的 base 对象」重算（解析解）。
  //    若沿用「局部系缩放 + 再按新框旋转」，手柄会随旋转角明显飘开（越大飘越多）。
  //    推导（枢轴 pv = 枢轴相对框左上角 t 的偏移，世界映射 W(l) = t + pv + R·(l − pv)）：
  //      手柄跟手：m = W_new(h_off)；锚点不动：W_new(u_off) = W_old(u_old)。
  //      两式相减消掉枢轴项 → (sx·W', sy·H') = Rᵀ·(m − W_old(u_old))，与枢轴无关（尺寸解不变）。
  //    位置只用「锚点不动」这一式反解：
  //      t = W_old(u_old) − pv − R·(u_off − pv)，u_off = (ax·W', ay·H')。
  //    未卡住时它与「手柄跟手」式 t = m − R·h_off − (I−R)·pv 恒等（四角手柄即严格跟手）；
  //    而只改单轴的边中点手柄（右/左/上/下）后者会把鼠标的垂直位移泄进位置里 → 锚点漂，
  //    用这一式则只按被拖的那条轴变化、对边纹丝不动（2026-09-26 用户反馈「旋转后拉伸发飘」）。
  //    尺寸被最小边长卡住时同样成立 —— 不会再出现「拖缩却看着像拖动」。
  if (rot && base.type === 'text') {
    const W0 = b0.w;
    const H0 = b0.h;
    const pv = pivotOffset(base); // 枢轴偏移：缩放全程不变（与 base 同一个不动点）
    const uWorld = annotToWorld(base, b0.x + def.ax * W0, b0.y + def.ay * H0);
    const d = unrotVec(px - uWorld.x, py - uWorld.y, rot); // = (sx·W', sy·H')
    const Wp = def.sx !== 0 ? Math.max(minSide, def.sx * d.x) : W0;
    const Hp = def.sy !== 0 ? Math.max(minSide, def.sy * d.y) : H0;
    const na = cloneAnnots([base])[0];
    const uOff = { x: def.ax * Wp, y: def.ay * Hp };
    const r2 = rotVec(uOff.x - pv.x, uOff.y - pv.y, rot);
    na.x = uWorld.x - pv.x - r2.x;
    na.y = uWorld.y - pv.y - r2.y;
    na.pvx = pv.x; // 枢轴跟着走：否则重画时会按「新框中心」转，位置与上面这组解对不上
    na.pvy = pv.y;
    const sxr = W0 > 0.5 ? Wp / W0 : 1;
    const syr = H0 > 0.5 ? Hp / H0 : 1;
    na.fontSize = Math.max(8, Math.min(240, Math.round(base.fontSize * syr)));
    na.maxWidth = Math.max(8, Math.round(base.maxWidth * sxr));
    na.lines = layoutEditorText(na.text, na.maxWidth, na);
    applyResizeResult(na);
    return;
  }

  // ③ 未旋转（或非文字）：沿用原逻辑 —— 被拖的边跟光标走、对边固定
  let x0 = b0.x;
  let y0 = b0.y;
  let x1 = b0.x + b0.w;
  let y1 = b0.y + b0.h;
  if (h.includes('l')) x0 = Math.min(px, x1 - minSide);
  if (h.includes('r')) x1 = Math.max(px, x0 + minSide);
  if (h.includes('t')) y0 = Math.min(py, y1 - minSide);
  if (h.includes('b')) y1 = Math.max(py, y0 + minSide);
  const sx = b0.w > 0.5 ? (x1 - x0) / b0.w : 1;
  const sy = b0.h > 0.5 ? (y1 - y0) / b0.h : 1;
  const dxFlat = h.includes('r') ? x1 - b0.x : (h.includes('l') ? x0 - b0.x : 0);
  const dyFlat = h.includes('b') ? y1 - b0.y : (h.includes('t') ? y0 - b0.y : 0);
  const mapX = (x) => (b0.w > 0.5 ? x0 + (x - b0.x) * sx : x + dxFlat);
  const mapY = (y) => (b0.h > 0.5 ? y0 + (y - b0.y) * sy : y + dyFlat);

  const na = cloneAnnots([base])[0];
  if (na.type === 'text') {
    na.fontSize = Math.max(8, Math.min(240, Math.round(base.fontSize * sy)));
    na.x = mapX(base.x);
    na.y = mapY(base.y);
    na.maxWidth = Math.max(8, Math.round(base.maxWidth * sx));
    na.lines = layoutEditorText(na.text, na.maxWidth, na);
  } else if (Array.isArray(base.points) && base.points.length > 1) {
    na.points = base.points.map((p) => [mapX(p[0]), mapY(p[1])]);
    const n = na.points.length;
    na.x1 = na.points[0][0];
    na.y1 = na.points[0][1];
    na.x2 = na.points[n - 1][0];
    na.y2 = na.points[n - 1][1];
  } else {
    na.x1 = mapX(base.x1);
    na.y1 = mapY(base.y1);
    na.x2 = mapX(base.x2);
    na.y2 = mapY(base.y2);
  }
  applyResizeResult(na);
}

/** 缩放/旋转结果落盘：编辑中的文字改「编辑器几何」，已提交的对象直接替换数组元素并重画。
 *  两条路分开是因为编辑中的文字根本不在 annotations 数组里（由 editingTextAnnot 临时接管）。 */
function applyResizeResult(na) {
  if (annotResizeIndex === EDITING_TARGET) {
    applyEditorGeometry(na);
    return;
  }
  annotations[annotResizeIndex] = na;
  renderAnnots();
}

/** 结束对象缩放：清状态（不产生历史 —— 等确认烘焙时统一压一次快照） */
function endAnnotResize() {
  lastGestureMouse = null;
  annotResizeHandle = '';
  annotResizeIndex = -1;
  annotResizeBase = null;
  annotResizeBox = null;
}

/**
 * 编辑中直接拖动 / 缩放 / 旋转文字框：把对象几何写回编辑器（位置、旋转、字号、折行宽度）并重画。
 * 字号与宽度走 override —— 否则 refreshEditorCanvas 会按工具栏滑块与选区宽度重新推导，
 * 刚拉出来的大小立刻被弹回去（「拉不动」的根因）。
 * 编辑中的文字不在 annotations 数组里，所以一切几何只能落回 editingTextAnnot + textAnchor。
 */
function applyEditorGeometry(na) {
  const a = editingTextAnnot;
  if (!a || !na) return;
  a.x = na.x;
  a.y = na.y;
  a.rot = na.rot || 0;
  // 枢轴偏移必须跟着一起落：漏掉它会让「锁定过枢轴的文字」在编辑态拖动/缩放后
  // 一边按旧枢轴画、一边按新框中心算，画面与手柄各说各话。
  if (na.pvx != null && na.pvy != null) { a.pvx = na.pvx; a.pvy = na.pvy; }
  if (na.fontSize) { a.fontSize = na.fontSize; editorFontOverride = na.fontSize; }
  if (na.maxWidth) { a.maxWidth = na.maxWidth; editorWidthOverride = na.maxWidth; }
  textAnchorX = a.x;
  textAnchorY = a.y;
  if (process.env.PETALSNAP_SMART_DEBUG === '1') {
    const b = annotBounds(a);
    console.error(`[TXT] applyGeom anchor=${a.x},${a.y} fs=${a.fontSize} mw=${a.maxWidth} lines=${a.lines.length} bounds=${b.x},${b.y},${b.w},${b.h}`);
  }
  refreshEditorCanvas(); // 内含 renderAnnots + syncEditorBox：画布、光标、textarea 一次对齐
}

/** 手势被中断（Esc / 右键）时把对象还原到「按下瞬间」的 base。
 *  编辑中的文字不在数组里 → 走编辑器几何；其它对象直接替换数组元素后重画。
 *  @returns {boolean} 是否真的还原了（false = 当时没有在操作对象） */
function restoreAnnotTo(base, index) {
  if (!base || index === -1) return false;
  if (index === EDITING_TARGET) { applyEditorGeometry(cloneAnnots([base])[0]); return true; }
  if (index >= 0 && annotations[index]) {
    annotations[index] = cloneAnnots([base])[0];
    renderAnnots();
    return true;
  }
  return false;
}

/** 删除按钮（✕）：编辑中的文字 = 放弃本次编辑（还没提交，撤回即删除）；
 *  已提交的文字 = 从对象层移除，并压一步对象历史（可 Ctrl+Z / 右键撤销回来）。 */
function deleteActiveAnnot() {
  if (textEditor) { cancelTextEditor(); return true; }
  const i = activeAnnotIndex();
  if (i < 0) return false;
  annotations.splice(i, 1);
  renderAnnots();
  commitHistory(false);
  return true;
}

/**
 * 命中「活动对象」的手柄或本体 → 进入缩放 / 拖动；返回 true = 这次按下已被对象手势消费。
 * 两个入口共用同一份实现（避免两套判定各自漂移）：
 *  · tempCanvas 上的普通按下（对象已提交，或文字编辑器没盖住这块）；
 *  · 文字编辑器 textarea 上的按下 —— textarea 宽度 = 选区剩余宽度，会盖住右侧手柄，
 *    不在这里补一次判定，编辑态下 r / b 手柄就是点不动的死区。
 * 消费成功时 preventDefault：阻止 textarea 因焦点转移而 blur（blur = 提交并销毁编辑器，
 * 会让正在拖拽的手势当场失去目标）。
 * @param allowBody - 是否允许「点中本体 → 拖动」。textarea 那条入口传 false：它整块都算本体，
 *   若也接管，正文里随便点一下都会变成拖动，光标就永远放不下去了。
 */
function tryBeginAnnotGesture(mx, my, ev, allowBody = true) {
  if (state !== STATE.SELECTED) return false;
  if (activeTool === 'eraser') return false; // 橡皮擦要能直接擦掉，不能被对象手势抢走
  const ai = activeHandleIndex();
  if (ai === -1) return false;
  const obj = annotAt(ai);
  if (!obj) return false;

  const aHandle = annotHandleAt(mx, my);
  if (aHandle) {
    if (aHandle === 'del') {
      if (ev && ev.preventDefault) ev.preventDefault();
      deleteActiveAnnot();
      return true;
    }
    resetTranslationCache();
    resizeHandle = null; // 互斥：清选框缩放状态（RESIZING 分支优先走 annotResizeHandle）
    annotResizeHandle = aHandle;
    annotResizeIndex = ai;
    annotResizeBase = cloneAnnots([obj])[0];
    annotResizeBox = annotBounds(obj);
    // 旋转手柄：记下按下瞬间「枢轴 → 光标」的角度，拖动时按差值改 rot。
    // 枢轴必须与 scaleActiveAnnot 的 rot 分支用同一个（都取「按下瞬间的框中心」），
    // 否则起点/当前角不同源会跳（2026-09-26：改绕中心后这里也要跟着改，不能再用 annotPivot
    // 的锁定值 —— 锁定值可能是上一次旋转留下的、已经不在框中心了）。
    if (aHandle === 'rot') {
      const b0 = annotBounds(obj);
      const c = { x: obj.x + b0.w / 2, y: obj.y + b0.h / 2 };
      annotResizeStartAngle = Math.atan2(my - c.y, mx - c.x);
    }
    hoverAnnotIndex = -1;
    state = STATE.RESIZING;
    hideToolbar();
    if (ev && ev.preventDefault) ev.preventDefault();
    return true;
  }

  if (!allowBody) return false;
  if (!isInsideSelection(mx, my)) return false;
  const hit = annotBodyHit(mx, my);
  if (hit === -1) return false;
  // 文字工具下点中**文字本体**要留给「继续编辑」，不当成拖动
  if (activeTool === 'text' && obj.type === 'text' && ai !== EDITING_TARGET) return false;
  resetTranslationCache();
  resizeHandle = null; // 互斥
  dragAnnotIndex = hit;
  dragBase = cloneAnnots([obj])[0];
  dragStartX = mx;
  dragStartY = my;
  hoverAnnotIndex = -1;
  state = STATE.MOVING;
  hideToolbar();
  if (ev && ev.preventDefault) ev.preventDefault();
  return true;
}

/**
 * 右键 = 「步骤撤销」/ 中断当前手势（Snipaste 语义：右键一步一步往回退，Esc 才是逐层退出）。
 * 优先级：折线收尾中 → 放弃这条折线；拖 / 缩中 → 还原到按下瞬间；文字编辑中 → 丢弃本次输入；
 * 有待确认对象 → 丢弃这一件；还有编辑内容 → 撤销上一步历史；
 * 都没有 → 取消选区回 IDLE（再按一次才退出截图）。
 */
function handleRightClick() {
  if (polyPoints) { abortPolyline(); return; }
  if (state === STATE.MOVING) {
    restoreAnnotTo(dragBase, dragAnnotIndex);
    dragAnnotIndex = -1;
    dragBase = null;
    state = STATE.SELECTED;
    showToolbar();
    drawMask();
    updateSizeInfo(selX, selY);
    return;
  }
  if (state === STATE.RESIZING) {
    restoreAnnotTo(annotResizeBase, annotResizeIndex);
    endAnnotResize();
    resizeHandle = null;
    state = STATE.SELECTED;
    showToolbar();
    drawMask();
    return;
  }
  if (textEditor) { cancelTextEditor(); return; } // 丢掉刚打的这一段（还没提交，撤回即删除）
  if (discardPendingAnnot()) return; // 刚画完还没确认的形状 = 最后一步
  if (state === STATE.SELECTED) {
    if (hasEdits() && historyIndex >= 0) {
      undoLast(); // 撤销上一步快照（位图 + 对象层一起回退）
      drawMask();
      return;
    }
    // 已经撤干净了：右键取消选区回 IDLE（Snipaste：非编辑状态下按右键取消）
    if (selW >= 1 && selH >= 1) {
      resetTranslationCache();
      selX = 0; selY = 0; selW = 0; selH = 0;
      resizeHandle = null;
      state = STATE.IDLE;
      hideToolbar();
      drawMask();
      return;
    }
  }
  if (state === STATE.DRAWING) {
    state = STATE.IDLE;
    hoverWindowRect = pendingWindowClickRect || null;
    drawMask();
    if (hoverWindowRect) showToolbar();
    return;
  }
  if (state === STATE.IDLE) ipcRenderer.send('capture-cancel');
}

/** 已选区里是否已经有编辑内容（矢量对象或位图笔画）。
 *  有编辑时右键不再「取消选区」—— 避免一次误触把刚画的东西连着选区一起清掉（2026-09-25 用户要求）。 */
function hasEdits() {
  return annotations.length > 0 || strokes.length > 0;
}

/** 渲染单个图形对象（drawXxx 系列支持显式 color/width，见各自定义）。
 *  带 points 的对象是多点折线（Shift 模式），直线/箭头走 polyline、曲线走平滑穿点。 */
function drawAnnotShape(ctx, a) {
  const multi = Array.isArray(a.points) && a.points.length > 1;
  if (a.shape === 'line') {
    if (multi) drawPolyline(ctx, a.points, a.color, a.size);
    else drawLine(ctx, a.x1, a.y1, a.x2, a.y2, a.color, a.size);
  } else if (a.shape === 'rect') {
    drawRect(ctx, a.x1, a.y1, a.x2, a.y2, a.color, a.size, !!a.fill);
  } else if (a.shape === 'arrow') {
    if (multi) {
      drawPolyline(ctx, a.points, a.color, a.size);
      const n = a.points.length;
      drawArrowHead(ctx, a.points[n - 2][0], a.points[n - 2][1], a.points[n - 1][0], a.points[n - 1][1], a.color, a.size);
    } else {
      drawArrow(ctx, a.x1, a.y1, a.x2, a.y2, a.color, a.size);
    }
  } else if (a.shape === 'curve') {
    if (multi) drawPolyCurveArrow(ctx, a.points, a.color, a.size);
    else drawCurveArrow(ctx, a.x1, a.y1, a.x2, a.y2, a.color, a.size);
  } else if (a.shape === 'ellipse') {
    drawEllipse(ctx, a.x1, a.y1, a.x2, a.y2, a.color, a.size, !!a.fill);
  }
}

/** 把字形画到 ctx（调用方须已把 ctx 变换到文字局部系；本函数只按 lines 落字）。
 *  lineHeight/基线口径与命中、编辑框完全一致：每行文字落在行盒中线。 */
function paintTextGlyphs(ctx, a) {
  if (!a.text || !a.lines || !a.lines.length) return;
  ctx.save();
  ctx.fillStyle = a.color;
  ctx.font = annotFontString(a);
  // 垂直居中：每行文字落在「行盒中线」(a.y + (idx+0.5)*lineHeight)，而非顶边对齐。
  // 这样文字在选区/文字框里视觉居中（不再整体偏高），点击点也正好是第一行中线（Snipaste 手感）。
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const lineHeightPx = Math.max(1, Math.round(a.fontSize * a.lineHeight));
  a.lines.forEach((ln, idx) => {
    if (ln.text) ctx.fillText(ln.text, 0, lineHeightPx * (idx + 0.5));
  });
  ctx.restore();
}

/** 在文字局部系里画出「擦除笔迹」的挖空形状（配合 destination-out 使用） */
function paintTextErase(ctx, erase) {
  ctx.save();
  ctx.strokeStyle = '#000';
  ctx.fillStyle = '#000';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const es of erase) {
    const pts = Array.isArray(es.points) ? es.points : [];
    if (es.kind === 'rect' && pts.length >= 4) {
      ctx.beginPath();
      ctx.rect(pts[0], pts[1], pts[2], pts[3]);
      ctx.fill();
      continue;
    }
    if (!pts.length) continue;
    ctx.lineWidth = Math.max(1, es.size || 1);
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0][0], pts[0][1], Math.max(1, (es.size || 1) / 2), 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.stroke();
  }
  ctx.restore();
}

/** 离屏画布（部分擦除的文字先画在它上面再挖空，最后整张贴回 annotCanvas） */
let textScratch = null;
function getTextScratch(w, h) {
  if (!textScratch) textScratch = document.createElement('canvas');
  if (textScratch.width < w) textScratch.width = w;
  if (textScratch.height < h) textScratch.height = h;
  return textScratch;
}

/** 渲染单个文字对象（行宽在布局时已固化在 lines[].width；支持旋转与「部分擦除」）。
 *  有擦除笔迹时走离屏画布：先按局部系画完整文字，再用 destination-out 挖掉笔迹覆盖处，
 *  最后整张贴回 —— 视觉上被擦掉一部分，但对象本身仍是完整矢量，
 *  之后用文字工具点它即恢复完整样式继续编辑（Snipaste 语义，2026-09-26 用户要求）。 */
function drawAnnotText(ctx, a) {
  if (!a.text || !a.lines || !a.lines.length) return;
  const erase = Array.isArray(a.eraseStrokes) ? a.eraseStrokes : null;
  if (!erase || !erase.length) {
    ctx.save();
    applyAnnotLocalSpace(ctx, a);
    paintTextGlyphs(ctx, a);
    ctx.restore();
    return;
  }
  const wb = annotWorldBounds(a);
  const sx = Math.floor(wb.x) - 2;
  const sy = Math.floor(wb.y) - 2;
  const sw = Math.ceil(wb.w) + 4;
  const sh = Math.ceil(wb.h) + 4;
  if (sw <= 0 || sh <= 0) return;
  const scratch = getTextScratch(sw, sh);
  const sctx = scratch.getContext('2d');
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.clearRect(0, 0, sw, sh);
  sctx.save();
  sctx.translate(-sx, -sy);
  applyAnnotLocalSpace(sctx, a);
  paintTextGlyphs(sctx, a);
  sctx.restore();
  sctx.save();
  sctx.globalCompositeOperation = 'destination-out';
  sctx.translate(-sx, -sy);
  applyAnnotLocalSpace(sctx, a);
  paintTextErase(sctx, erase);
  sctx.restore();
  ctx.drawImage(scratch, 0, 0, sw, sh, sx, sy, sw, sh);
}

/** 对象包围盒（CSS 坐标；文字按已布局的每行矩形并集） */
function annotBounds(a) {
  if (a.type === 'text') {
    if (!a.lines || !a.lines.length) return { x: a.x, y: a.y, w: 0, h: 0 };
    const lineHeightPx = Math.max(1, Math.round(a.fontSize * a.lineHeight));
    const raw = Math.max(1, ...a.lines.map((ln) => ln.width || 1));
    // 尾部预留空位：框比文字多出 textTrailPad 一段（上限 = 折行宽度 maxWidth，
    // 与编辑态 syncEditorBox 的 boxW 用同一条算法，保证「编辑中」和「已提交」的框一样宽）
    const cap = a.maxWidth > 0 ? a.maxWidth : Infinity;
    const width = Math.max(1, Math.min(cap, raw + textTrailPad(a.fontSize)));
    const height = Math.max(1, a.lines.length * lineHeightPx);
    return { x: a.x, y: a.y, w: width, h: height };
  }
  // 多点折线：包围盒取**所有顶点**的极值（只用 x1..y2 首末点会漏掉中间外扩的顶点）
  if (Array.isArray(a.points) && a.points.length > 1) {
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const p of a.points) {
      if (p[0] < minX) minX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] > maxY) maxY = p[1];
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  const x = Math.min(a.x1, a.x2);
  const y = Math.min(a.y1, a.y2);
  return { x, y, w: Math.abs(a.x2 - a.x1), h: Math.abs(a.y2 - a.y1) };
}

/** 几何指纹：判断一次「拖动 / 缩放 / 旋转」手势是否真的改了东西（只比几何，不比颜色/文字）。
 *  用于 mouseup 时决定要不要为持久对象（文字）压一步历史 —— 没变就不压，
 *  免得 Ctrl+Z 出现「按一下什么都没动」的空步。 */
function annotGeomSig(a) {
  if (!a) return '';
  const b = annotBounds(a);
  const pts = Array.isArray(a.points) ? a.points.map((p) => `${p[0]}:${p[1]}`).join('|') : '';
  return [a.x, a.y, a.rot || 0, b.w, b.h, a.fontSize || 0, a.maxWidth || 0,
    a.x1 || 0, a.y1 || 0, a.x2 || 0, a.y2 || 0, pts].join(',');
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
    if (a.live) continue; // 正在画的多点折线（未收尾）不参与命中
    if (a.editing) continue; // 编辑中的文字不允许被 MOVE 抢走
    if (a.type === 'text') {
      const l = annotToLocal(a, mx, my); // 旋转过的文字：先反旋回局部系再按矩形判定
      // 紧贴字形命中（2026-09-28 用户实测：annotBounds 含尾部预留+pad，隐形命中区比
      // 可见文字大一圈 → 点"空白"总被判定成点中文字 → 重开编辑而不是新建）。
      // 命中 = 任一行文字的实际矩形（不含 trail、不含外扩 pad）。
      const lineHeightPx = Math.max(1, Math.round(a.fontSize * a.lineHeight));
      const lines = a.lines || [];
      if (l.y >= a.y && l.y <= a.y + lines.length * lineHeightPx) {
        const idx = Math.min(lines.length - 1, Math.max(0, Math.floor((l.y - a.y) / lineHeightPx)));
        const ln = lines[idx];
        const lw = ln ? (ln.width || 1) : 0;
        if (l.x >= a.x && l.x <= a.x + lw) return i;
      }
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
    // line / arrow / curve：逐段命中（多点折线按相邻顶点对拆段）；箭头再加头部范围
    const tol = Math.max(6, a.size / 2 + pad);
    const pts = shapePts(a);
    for (let k = 1; k < pts.length; k++) {
      if (distToSegment(mx, my, pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1]) <= tol) return i;
    }
    if (a.shape === 'arrow') {
      // 头部沿**最后一段**的方向（多点折线时不再是首末点连线）
      const last = pts[pts.length - 1];
      const prev = pts[pts.length - 2] || last;
      const angle = Math.atan2(last[1] - prev[1], last[0] - prev[0]);
      const head = Math.max(10, a.size * 3);
      const a1 = angle + Math.PI * 0.75;
      const a2 = angle - Math.PI * 0.75;
      const p1x = last[0] + head * Math.cos(a1);
      const p1y = last[1] + head * Math.sin(a1);
      const p2x = last[0] + head * Math.cos(a2);
      const p2y = last[1] + head * Math.sin(a2);
      if (distToSegment(mx, my, last[0], last[1], p1x, p1y) <= tol) return i;
      if (distToSegment(mx, my, last[0], last[1], p2x, p2y) <= tol) return i;
    }
  }
  return -1;
}

/* ── 位图笔画：橡皮擦整笔擦除（Snipaste 语义：整笔/整对象擦除，非像素擦除） ── */

/** 笔画包围盒（CSS 坐标）：框选打码用 rect，笔刷用 points 极值 */
function strokeBounds(s) {
  if (!s) return null;
  if (s.rect) {
    return {
      x: Math.min(s.rect.x1, s.rect.x2),
      y: Math.min(s.rect.y1, s.rect.y2),
      w: Math.abs(s.rect.x2 - s.rect.x1),
      h: Math.abs(s.rect.y2 - s.rect.y1),
    };
  }
  const pts = s.points || [];
  if (!pts.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** 橡皮擦命中检测：从最新一笔往前找距离 (mx,my) ≤ 线宽/2+容差的笔画（框选按 rect 命中） */
function hitTestStroke(mx, my) {
  for (let i = strokes.length - 1; i >= 0; i--) {
    const s = strokes[i];
    if (!s) continue;
    // 细擦笔迹（挖空操作）不参与命中：否则擦出来的空白处再点一下会「复原」，语义反直觉
    if (s.tool === 'eraser') continue;
    if (s.rect) {
      const b = strokeBounds(s);
      const pad = 4;
      if (b && mx >= b.x - pad && mx <= b.x + b.w + pad && my >= b.y - pad && my <= b.y + b.h + pad) return i;
      continue;
    }
    const pts = s.points || [];
    if (!pts.length) continue;
    const tol = Math.max(8, s.size / 2 + 4);
    // 先粗判包围盒，跳过不相交的笔（长笔画逐段算距离较贵）
    const bb = strokeBounds(s);
    if (!bb || mx < bb.x - tol || mx > bb.x + bb.w + tol || my < bb.y - tol || my > bb.y + bb.h + tol) continue;
    for (let j = 0; j < pts.length - 1; j++) {
      if (distToSegment(mx, my, pts[j][0], pts[j][1], pts[j + 1][0], pts[j + 1][1]) <= tol) return i;
    }
    // 单点笔画（单击未拖动）：按点距命中
    if (pts.length === 1 && Math.hypot(mx - pts[0][0], my - pts[0][1]) <= tol) return i;
  }
  return -1;
}

/**
 * 按原参数把一笔位图笔画重放到 drawCtx（橡皮擦擦除后，按序重放其后笔画还原后续内容）。
 * 重放期间临时接管 selX..H / maskIntensity / drawingSize / maskMode / activeTool 等全局，
 * 保证几何与采样（getMergedRegion、clipToSelection）和当初绘制时一致，结束后还原。
 */
function replayStroke(s) {
  if (!s) return;
  const prevSel = { x: selX, y: selY, w: selW, h: selH };
  const prevMask = maskIntensity;
  const prevSize = drawingSize;
  const prevTool = activeTool;
  const prevMode = maskMode;
  const prevColor = drawingColor;
  if (s.clipRect) {
    selX = s.clipRect.x; selY = s.clipRect.y; selW = s.clipRect.w; selH = s.clipRect.h;
  }
  if (s.maskIntensity !== undefined) maskIntensity = s.maskIntensity;
  if (s.size !== undefined) drawingSize = s.size;
  if (s.maskMode !== undefined) maskMode = s.maskMode;
  if (s.color !== undefined) drawingColor = s.color;
  try {
    if (s.rect) {
      // 打码「框选」：整块应用一次
      if (MASK_TOOLS.includes(s.tool)) {
        activeTool = s.tool;
        applyMaskRect(s.rect.x1, s.rect.y1, s.rect.x2, s.rect.y2);
      }
    } else if (s.tool === 'pen') {
      clipToSelection(drawCtx);
      const pts = s.points || [];
      for (let j = 0; j < pts.length - 1; j++) {
        drawLine(drawCtx, pts[j][0], pts[j][1], pts[j + 1][0], pts[j + 1][1], s.color, s.size);
      }
      if (pts.length === 1) drawLine(drawCtx, pts[0][0], pts[0][1], pts[0][0] + 0.01, pts[0][1], s.color, s.size);
      restoreClip(drawCtx);
    } else if (s.tool === 'eraser') {
      // 细擦笔迹：按原样再挖一次（destination-out），保证「擦掉某笔后再重放其后笔画」结果一致
      const pts = s.points || [];
      for (let j = 0; j < pts.length - 1; j++) {
        eraseSegmentAt(pts[j][0], pts[j][1], pts[j + 1][0], pts[j + 1][1], s.size);
      }
      if (pts.length === 1) eraseSegmentAt(pts[0][0], pts[0][1], pts[0][0], pts[0][1], s.size);
    } else if (s.tool === 'highlight') {
      // 半透明马克笔：单笔缓冲一次合成（base 取当前 drawCtx = 此笔开始前的状态）
      clipToSelection(drawCtx);
      replayHighlightStroke(s);
      restoreClip(drawCtx);
    } else if (s.tool === 'solid') {
      // 纯色笔刷：整笔缓冲，按透明度一次合成（与实时路径一致）
      activeTool = 'solid';
      clipToSelection(drawCtx);
      beginSolidStroke();
      const pts = s.points || [];
      for (const p of pts) applySolid(p[0], p[1]);
      endSolidStroke();
      restoreClip(drawCtx);
    } else if (s.tool && MASK_TOOLS.includes(s.tool) && s.maskMode === 'lasso') {
      // 打码「套索」：对多边形内部整块重放一次（与实时路径同一实现）
      activeTool = s.tool;
      applyMaskInPath(s.points);
    } else if (s.tool && MASK_TOOLS.includes(s.tool)) {
      // 马赛克 / 模糊 / 噪点笔刷：逐点涂抹
      activeTool = s.tool;
      clipToSelection(drawCtx);
      const pts = s.points || [];
      for (const p of pts) applyMaskAt(p[0], p[1]);
      restoreClip(drawCtx);
    }
  } finally {
    selX = prevSel.x; selY = prevSel.y; selW = prevSel.w; selH = prevSel.h;
    maskIntensity = prevMask;
    drawingSize = prevSize;
    activeTool = prevTool;
    maskMode = prevMode;
    drawingColor = prevColor;
  }
}

/**
 * 橡皮擦整笔擦除：
 * 1) 恢复到此笔开始前的位图（preData = 该笔开始时历史栈顶快照的 ImageData，只读共享）；
 * 2) 从 strokes 摘除该笔；
 * 3) 按序重放其后所有笔画 → 画面只剩「此笔之后的标注」；
 * 4) commitHistory(true) 收一步历史：撤销可整步找回，重做可再擦除。
 */
function eraseStroke(idx) {
  const s = strokes[idx];
  if (!s) return;
  const dpr = canvasDpr;
  if (s.preData) {
    drawCtx.putImageData(s.preData, Math.round(s.preRect.x * dpr), Math.round(s.preRect.y * dpr));
  } else {
    drawCtx.clearRect(
      Math.round(s.preRect.x * dpr), Math.round(s.preRect.y * dpr),
      Math.round(s.preRect.w * dpr), Math.round(s.preRect.h * dpr),
    );
  }
  strokes.splice(idx, 1);
  for (let i = idx; i < strokes.length; i++) {
    replayStroke(strokes[i]);
  }
  hoverStrokeIndex = -1;
  hoverAnnotIndex = -1;
  commitHistory(true);
  renderAnnots();
}

/**
 * 细擦：在 drawCtx 上按笔刷大小挖空一段（destination-out 抹掉 alpha）。
 * 单点（起笔/单击）走圆点，其余走圆头线段 —— 与画笔同一套圆头手感。
 * 实时路径与 replayStroke 共用，保证「擦掉某笔后重放其后笔画」结果一致。
 */
function eraseSegmentAt(x1, y1, x2, y2, size = drawingSize) {
  const w = Math.max(1, size);
  drawCtx.save();
  clipToSelection(drawCtx);
  drawCtx.globalCompositeOperation = 'destination-out';
  if (Math.abs(x2 - x1) < 0.01 && Math.abs(y2 - y1) < 0.01) {
    drawCtx.beginPath();
    drawCtx.arc(x1, y1, w / 2, 0, Math.PI * 2);
    drawCtx.fillStyle = '#000';
    drawCtx.fill();
  } else {
    drawLine(drawCtx, x1, y1, x2, y2, '#000', w);
  }
  drawCtx.restore();
}

/** 两个矩形是否相交（框选擦：判断矢量对象是否落在擦除区域里） */
function rectsOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

/** 点到折线（多段）的最短距离 */
function distToPolyline(x, y, pts) {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const d = distToSegment(x, y, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    if (d < best) best = d;
  }
  return best;
}

/** 折线与折线是否「挨上」：双向采样（任一端点落进对方线段容差内即算命中） */
function polylineHitPath(pts, path, tol) {
  for (const [x, y] of pts) if (distToPolyline(x, y, path) <= tol) return true;
  for (const [x, y] of path) if (distToPolyline(x, y, pts) <= tol) return true;
  return false;
}

/**
 * 橡皮擦「细擦」结算：把被本笔扫过的矢量对象一并吃掉。
 * （2026-09-25 用户反馈：细擦只挖位图，擦不掉画的直线。）
 * 规则：
 *  · 直线/箭头/曲线（含 Shift 多点折线）→ 只删「被扫到的段」，其余段重组成新对象，
 *    于是直线能被擦断一截；箭头/曲线只在仍接在原末尾的那一段保留原样式；
 *  · 矩形/椭圆/文字 → 整删（矢量无法表达「缺一块」）。
 * @returns 是否改动了对象层
 */
function eraseAnnotsAlongPath(path, size) {
  if (!annotations.length || !path || !path.length) return false;
  const tol = Math.max(4, size / 2 + 2);
  const kept = [];
  let changed = false;
  for (const a of annotations) {
    if (a.type !== 'shape' || !['line', 'arrow', 'curve'].includes(a.shape)) {
      // 实心图形 / 文字：任一轨迹点落进其包围盒（外扩 tol）即命中（旋转文字用旋转后的 AABB）
      const b = annotWorldBounds(a);
      const hit = !!b && path.some(([px, py]) => px >= b.x - tol && px <= b.x + b.w + tol
        && py >= b.y - tol && py <= b.y + b.h + tol);
      if (hit) {
        // 文字是永久矢量对象：把本笔轨迹「翻译」成文字的局部坐标存起来，渲染时按笔迹挖空 ——
        // 视觉上被擦掉一部分，但对象本身仍是完整矢量；之后用文字工具点它即恢复完整样式继续编辑
        //（Snipaste 语义，2026-09-26 用户要求）。
        if (a.type === 'text') {
          a.eraseStrokes = a.eraseStrokes || [];
          a.eraseStrokes.push({
            kind: 'path',
            size,
            points: path.map(([px, py]) => {
              const l = annotToLocal(a, px, py);
              return [l.x - a.x, l.y - a.y];
            }),
          });
          changed = true;
          kept.push(a);
          continue;
        }
        changed = true;
        continue;
      }
      kept.push(a);
      continue;
    }
    const pts = shapePts(a);
    const runs = [];
    let run = null;
    for (let k = 1; k < pts.length; k++) {
      if (polylineHitPath([pts[k - 1], pts[k]], path, tol)) { run = null; continue; }
      if (run) run.push(pts[k]);
      else { run = [pts[k - 1], pts[k]]; runs.push(run); }
    }
    if (!runs.length) { changed = true; continue; } // 整条被擦光
    if (runs.length === 1 && runs[0].length === pts.length) {
      kept.push(a); // 一点没擦到：原对象原样保留，不做无谓重建
      continue;
    }
    changed = true;
    const tail = pts[pts.length - 1];
    for (const runPts of runs) {
      const last = runPts[runPts.length - 1];
      const endsAtTail = last[0] === tail[0] && last[1] === tail[1];
      const shape = (a.shape === 'arrow' || a.shape === 'curve') ? (endsAtTail ? a.shape : 'line') : a.shape;
      kept.push({
        ...a,
        shape,
        points: runPts,
        x1: runPts[0][0],
        y1: runPts[0][1],
        x2: last[0],
        y2: last[1],
      });
    }
  }
  if (!changed) return false;
  annotations = kept;
  hoverAnnotIndex = -1;
  renderAnnots();
  return true;
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
  const a = annotAt(dragAnnotIndex);
  const b = dragBase;
  if (!a || !b) return;
  // 钳制基准用**旋转后的世界包围盒**（与 nudgeAnnotBy 同一口径）：转过角的文字，
  // 未旋转的 annotBounds 与屏幕实际占位不符，会「压出选区 / 提前停住」。
  const bb = annotWorldBounds(b);
  const dx = clampAnnotAxis(bb.x, bb.w, mx - dragStartX, selX, selW);
  const dy = clampAnnotAxis(bb.y, bb.h, my - dragStartY, selY, selH);
  if (a.type === 'text') {
    a.x = b.x + dx;
    a.y = b.y + dy;
  } else {
    // 先复位到按下瞬间的位置，再整体平移（多点折线要连所有顶点一起走）
    a.x1 = b.x1; a.y1 = b.y1; a.x2 = b.x2; a.y2 = b.y2;
    if (Array.isArray(b.points) && b.points.length) a.points = b.points.map((p) => [p[0], p[1]]);
    translateShape(a, dx, dy);
  }
  // 拖动的是「正在编辑的文字」：编辑器锚点跟着走，textarea / hint / 光标同步挪位
  if (dragAnnotIndex === EDITING_TARGET) {
    textAnchorX = a.x;
    textAnchorY = a.y;
    refreshEditorCanvas();
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
  const snap = { data, x: selX, y: selY, w: selW, h: selH, annots: cloneAnnots(), strokes: cloneStrokes() };
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
      strokes = Array.isArray(snap.strokes) ? cloneStrokes(snap.strokes) : [];
    }
  } else {
    annotations = [];
    strokes = [];
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

function hexToRgb(hex) {
  const h = String(hex || '#FFFFFF').replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b); const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = Math.round(h * 60);
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : Math.round((d / max) * 100);
  const v = Math.round(max * 100);
  return { h, s, v };
}

function formatColor(hex) {
  if (colorFormat === 'rgb') {
    const { r, g, b } = hexToRgb(hex);
    return `rgb(${r}, ${g}, ${b})`;
  }
  if (colorFormat === 'hsv') {
    const { r, g, b } = hexToRgb(hex);
    const { h, s, v } = rgbToHsv(r, g, b);
    return `hsv(${h}, ${s}%, ${v}%)`;
  }
  return String(hex || '#FFFFFF').toUpperCase();
}

/** 左上角尺寸角标：贴在选区**外侧**上方（Shotera 196×27 样式，不压在框内） */
function updateSelectBar(mx, my) {
  if (!selectBar) return;
  if (state !== STATE.IDLE || !hoverWindowRect || CAPTURE_NO_HOVER) {
    selectBar.classList.remove('is-visible');
    return;
  }
  const levels = smartIpcRect.levels || [];
  const lv = levels[Math.min(smartLevel, Math.max(0, levels.length - 1))];
  // Shotera 式：角标只显示尺寸，不加类型前缀
  if (sbSize) sbSize.textContent = `${physPx(hoverWindowRect.width)} × ${physPx(hoverWindowRect.height)}`;
  const bw = selectBar.offsetWidth || 90;
  const bh = selectBar.offsetHeight || 24;
  const gap = 6;
  // 默认：选区左上角外侧（上方）；贴顶则改到内部上沿下方
  let left = hoverWindowRect.x;
  let top = hoverWindowRect.y - bh - gap;
  if (top < gap) top = hoverWindowRect.y + gap;
  if (left + bw > window.innerWidth - gap) left = Math.max(gap, window.innerWidth - bw - gap);
  left = Math.max(gap, left);
  // 单屏钳制（2026-09-25 修「跨屏」角标）：角标默认贴框左上角，框在屏缝附近时角标横跨
  // 两屏被系统分割成两半（与预览工具栏同款问题）。按角标位置所在屏整体钳进屏内。
  const scr = screenCssRectAt(left, top);
  if (scr) {
    if (left < scr.x + gap) left = scr.x + gap;
    if (left + bw > scr.x + scr.width - gap) left = Math.max(scr.x + gap, scr.x + scr.width - bw - gap);
    if (top < scr.y + gap) top = scr.y + gap;
    if (top + bh > scr.y + scr.height - gap) top = Math.max(scr.y + gap, scr.y + scr.height - bh - gap);
  }
  selectBar.style.left = `${Math.round(left)}px`;
  selectBar.style.top = `${Math.round(top)}px`;
  selectBar.classList.add('is-visible');
}

function hideSelectBar() {
  if (selectBar) selectBar.classList.remove('is-visible');
}

function updateSizeInfo(mx, my) {
  updateSelectBar(mx, my);
  // 角标信息由 magnifier + selectBar 承载
  sizeInfo.style.display = 'none';
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
  magnifierBoxW = magnifier.offsetWidth || 168;
  magnifierBoxH = magnifier.offsetHeight || 260;
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
  magnifierCtx.fillStyle = '#f3f4f6';
  magnifierCtx.fillRect(0, 0, physical, physical);

  // 采样：优先 bgCanvas（物理 backing）；为空则从 bgImage 整图按 dpr 映射
  const src = (bgCanvas.width > 0 && bgCanvas.height > 0) ? bgCanvas : null;
  const srcW = src ? src.width : Math.round(bgImage.naturalWidth);
  const srcH = src ? src.height : Math.round(bgImage.naturalHeight);
  const cxPhys = Math.round(mx * (src ? dpr : (srcW / Math.max(1, W))));
  const cyPhys = Math.round(my * (src ? dpr : (srcH / Math.max(1, H))));
  const srcPixels = MAGNIFIER_SIZE / MAGNIFIER_ZOOM;
  const srcSpan = Math.round(srcPixels * (src ? dpr : (srcW / Math.max(1, W))));
  const srcHalf = Math.floor(srcSpan / 2);
  let sx = cxPhys - srcHalf;
  let sy = cyPhys - srcHalf;
  let sw = srcSpan;
  let sh = srcSpan;
  const scale = physical / Math.max(1, srcSpan);
  let dx = 0;
  let dy = 0;
  if (sx < 0) { dx = -sx * scale; sw += sx; sx = 0; }
  if (sy < 0) { dy = -sy * scale; sh += sy; sy = 0; }
  if (sx + sw > srcW) sw = srcW - sx;
  if (sy + sh > srcH) sh = srcH - sy;
  if (sw < 1 || sh < 1) return;
  const dw = Math.max(1, sw * scale);
  const dh = Math.max(1, sh * scale);
  magnifierCtx.drawImage(src || bgImage, sx, sy, sw, sh, dx, dy, dw, dh);

  // Shotera 式：细蓝十字 + 中心像素高亮（不要粗黑十字）
  const hcx = physical / 2;
  const hcy = physical / 2;
  const cell = Math.max(2, Math.round(zoom * dpr));
  magnifierCtx.strokeStyle = 'rgba(64, 156, 255, 0.95)';
  magnifierCtx.lineWidth = Math.max(1.5, dpr);
  magnifierCtx.beginPath();
  magnifierCtx.moveTo(hcx, 0);
  magnifierCtx.lineTo(hcx, hcy - cell / 2);
  magnifierCtx.moveTo(hcx, hcy + cell / 2);
  magnifierCtx.lineTo(hcx, physical);
  magnifierCtx.moveTo(0, hcy);
  magnifierCtx.lineTo(hcx - cell / 2, hcy);
  magnifierCtx.moveTo(hcx + cell / 2, hcy);
  magnifierCtx.lineTo(physical, hcy);
  magnifierCtx.stroke();
  magnifierCtx.strokeStyle = 'rgba(64, 156, 255, 0.35)';
  magnifierCtx.lineWidth = 1;
  magnifierCtx.strokeRect(hcx - cell / 2, hcy - cell / 2, cell, cell);

  // 坐标 + 色号
  const hex = pickColorAt(mx, my) || '#FFFFFF';
  lastPickedColor = hex;
  if (magCoords) magCoords.textContent = `(${Math.round(mx)}, ${Math.round(my)})`;
  if (magHex) magHex.textContent = formatColor(hex);
  if (magSwatch) magSwatch.style.background = hex;

  // 卡片定位：默认光标右下，越界翻转
  const boxW = magnifierBoxW || 168;
  const boxH = magnifierBoxH || 260;
  let left = mx + 20;
  let top = my + 20;
  if (left + boxW > window.innerWidth - 8) left = mx - boxW - 20;
  if (top + boxH > window.innerHeight - 8) top = my - boxH - 20;
  left = Math.max(8, Math.min(left, window.innerWidth - boxW - 8));
  top = Math.max(8, Math.min(top, window.innerHeight - boxH - 8));
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

/**
 * 工具栏单屏钳制：把整条工具栏限制在「选区所在屏」内（工具栏若横跨屏缝，会被系统沿屏边界
 * 切成两半，半条落在另一块屏上）。
 * ⚠️ 原实现无论选区在哪块屏，一律把工具栏塞进主屏（primary）—— 在副屏靠屏缝处框选、
 * 或拖动时越界，工具栏会整个跳到主屏，表现就是「一拖/一框选，工具栏就跑到另一块屏去了」
 * （2026-09-25 用户反馈）。现改为跟随选区所在屏。CSS 系见 screenCssRectAt。
 */
function clampToolbarToSingleScreen(tx, tbW) {
  const cx = selX + selW / 2;
  const cy = selY + selH / 2;
  const scr = screenCssRectAt(cx, cy);
  if (!scr) return tx;
  const minX = scr.x + 8;
  const maxX = scr.x + scr.width - tbW - 8;
  return maxX <= minX ? minX : Math.max(minX, Math.min(tx, maxX));
}

function showToolbar() {
  toolbar.style.display = 'flex';
  if (document.body.classList.contains('is-longshot-edit')) {
    toolbar.style.left = '';
    toolbar.style.top = '';
    toolbar.style.transform = '';
    return;
  }
  const tbW = toolbar.offsetWidth || 520;
  const tbH = toolbar.offsetHeight || 48;
  // 用户拖过就钉在原处 —— 包括他**故意**把工具栏拖到另一块屏的情况（跨屏拖动已放开，
  // 不能因为「和选区不同屏」就把它拽回来）。要在新选区那块屏落位，由 finishSelection
  // 清掉这个标记实现（新画一块选区 = 新的落位语境）。
  if (toolbarUserMoved && toolbar.style.left) return;
  // 默认：选区**下方居中**（贴合习惯：工具栏在内容下方）；下方放不下才转上方
  let tx = Math.round(selX + selW / 2 - tbW / 2);
  let ty = Math.round(selY + selH + 10);
  if (ty + tbH > H - 8) ty = Math.round(selY - tbH - 10); // 下方放不下 → 转上方
  if (ty < 8) ty = Math.max(8, H - tbH - 8); // 上方也放不下 → 兜底贴底
  tx = Math.max(8, Math.min(tx, W - tbW - 8));
  tx = clampToolbarToSingleScreen(tx, tbW);
  toolbar.style.left = `${tx}px`;
  toolbar.style.top = `${ty}px`;
}

/* 工具栏拖拽：按住空白处直接拖动（六点把手已移除）；拖过后钉住不跟选区。
   跨屏（2026-09-25 用户实测反馈）：允许拖到另一块屏，但**整条吸附进目标屏** ——
   目标屏 = 光标当前所在的那块屏，把整条工具栏钳进它的范围，因此永远不骑屏缝
   （骑缝的浮层会被系统沿屏边界切成两半、半条还发虚）。光标跨过屏缝那一刻，整条换屏。
  流畅度：拖动过程只写 transform: translate3d（合成层位移，不触发布局），并用 rAF
   合并同一帧内的多次 pointermove；松手时才落回 left/top。 */
if (toolbar) {
  let tbDrag = false;
  let tbOx = 0;
  let tbOy = 0;
  let tbBoxW = 0;
  let tbBoxH = 0;
  let tbBaseX = 0;
  let tbBaseY = 0;
  let tbLastX = 0;
  let tbLastY = 0;
  let tbRaf = 0;
  toolbar.addEventListener('pointerdown', (e) => {
    // 长截图编辑态由 initEditorToolbarDrag 独占（那里按编辑器布局摆放工具栏），
    // 两处都写 style.left 会互相覆盖 —— 必须互斥。
    if (document.body.classList.contains('is-longshot-edit')) return;
    // 按钮/输入框/图标上的按下不触发整体拖动（交给按钮自己的事件）
    const t = e.target;
    if (t.closest && t.closest('button, input, select, textarea')) return;
    e.preventDefault();
    tbDrag = true;
    toolbarUserMoved = true;
    toolbar.classList.add('is-dragging');
    toolbar.setPointerCapture(e.pointerId);
    // 起点用 computed left/top（已在 px），顺手把可能残留的 transform 归零，
    // 保证「transform 位移」与「left/top 基线」同源。
    const cs = getComputedStyle(toolbar);
    const r = toolbar.getBoundingClientRect();
    const cl = parseFloat(cs.left);
    const ct = parseFloat(cs.top);
    tbBaseX = Number.isFinite(cl) ? cl : r.left;
    tbBaseY = Number.isFinite(ct) ? ct : r.top;
    toolbar.style.left = `${tbBaseX}px`;
    toolbar.style.top = `${tbBaseY}px`;
    toolbar.style.transform = 'none';
    tbLastX = tbBaseX;
    tbLastY = tbBaseY;
    tbOx = e.clientX - tbBaseX;
    tbOy = e.clientY - tbBaseY;
    tbBoxW = r.width;
    tbBoxH = r.height;
  });
  toolbar.addEventListener('pointermove', (e) => {
    if (!tbDrag) return;
    let x = e.clientX - tbOx;
    let y = e.clientY - tbOy;
    // 目标屏按光标所在屏判定 → 跨缝即整条换屏并吸附，永不骑缝
    const scr = screenCssRectAt(e.clientX, e.clientY);
    if (scr) {
      const loX = scr.x + 4;
      const hiX = scr.x + scr.width - tbBoxW - 4;
      const loY = scr.y + 4;
      const hiY = scr.y + scr.height - tbBoxH - 4;
      x = hiX >= loX ? Math.max(loX, Math.min(x, hiX)) : loX;
      y = hiY >= loY ? Math.max(loY, Math.min(y, hiY)) : loY;
    } else {
      x = Math.max(4, Math.min(x, window.innerWidth - tbBoxW - 4));
      y = Math.max(4, Math.min(y, window.innerHeight - tbBoxH - 4));
    }
    tbLastX = Math.round(x);
    tbLastY = Math.round(y);
    if (tbRaf) return;
    tbRaf = requestAnimationFrame(() => {
      tbRaf = 0;
      toolbar.style.transform = `translate3d(${tbLastX - tbBaseX}px, ${tbLastY - tbBaseY}px, 0)`;
    });
  });
  const tbEnd = (e) => {
    if (!tbDrag) return;
    tbDrag = false;
    toolbar.classList.remove('is-dragging');
    if (tbRaf) { cancelAnimationFrame(tbRaf); tbRaf = 0; }
    toolbar.style.transform = '';
    toolbar.style.left = `${tbLastX}px`;
    toolbar.style.top = `${tbLastY}px`;
    try { toolbar.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  };
  toolbar.addEventListener('pointerup', tbEnd);
  toolbar.addEventListener('pointercancel', tbEnd);
}

/* 粗细滚轮直接调节（无需 Alt）：在工具栏「颜色/粗细」行上滚动即改笔刷大小，
   与画布上的 Alt+滚轮、滑块三方双向同步 */
if (toolbar && sizeSlider) {
  const styleRow = toolbar.querySelector('.capture-toolbar-style');
  if (styleRow) {
    styleRow.addEventListener('wheel', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const step = e.shiftKey ? 5 : 1;
      const delta = -Math.sign(e.deltaY) * step;
      setDrawingSize(drawingSize + delta);
    }, { passive: false });
  }
}

function hideToolbar() {
  closeShapeMenu();
  closeMaskMenu();
  closeEraserMenu();
  closePickerOverlay();
  // 文字是实时画在画布上的，必须用「提交」收尾（先落历史栈再撤浮层），
  // 直接 destroy 会把文字留在画布上却不进历史，后续 undo 就乱了。
  // **例外（2026-09-29 自测实锤的根因）**：编辑中的对象手势（手柄缩放/旋转/拖框）
  // 开始时也会调 hideToolbar——此刻提交 = 编辑器当场销毁，RESIZING/MOVING 操作的
  // 是空对象 = 「编辑中拉伸/移动全部无效」。手势期间只收工具栏，文字保持编辑态。
  if (!(textEditor && (state === STATE.RESIZING || state === STATE.MOVING))) {
    commitTextEditor();
  }
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
  // 切工具 = 确认上一件「待确认」对象（先烘焙再收尾折线：折线收尾产生的新对象仍留在待确认态）
  if (tool !== activeTool) commitPendingAnnot();
  // 切工具时若还有未收尾的多点折线：自动收尾提交（当成「画完了」），不静默丢弃用户的成果
  if (polyPoints) finishPolyline(polyPoints.slice(), true);
  // 粗细按工具分组沿用（画笔/高亮/打码/橡皮各自记得上次用的大小）
  switchSizeGroup(activeTool, tool);
  activeTool = tool;
  hoverStrokeIndex = -1; // 切换工具即清除橡皮擦悬停笔画框
  if (hoverAnnotIndex >= 0) {
    hoverAnnotIndex = -1; // 切走移动工具后不留旧的对象悬停框（2026-09-25 对象画完即固定）
    renderAnnots();
  }
  Array.from(document.querySelectorAll('button.tool')).forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tool === tool);
  });
  // 换工具后收起笔刷预览圈并交还光标（圈可见期间 body cursor = none，切走必须还原）
  setBrushCursor(0, 0, false);
  document.body.style.cursor = '';
  // 统一工具面板：内容与显隐随工具切换（打码区 / 颜色粗细区 / 收起）
  syncToolPanel();
  syncTextStyleRowVisibility(); // 文字工具激活才露出加粗/斜体/字体样式条
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

/** 笔刷 / 框选 / 套索 三个模式按钮的高亮同步 */
function syncMaskModeUI() {
  if (!maskModeBtns || maskModeBtns.length === 0) return;
  maskModeBtns.forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.mode === maskMode);
  });
  // 非笔刷模式下不显示"跟随光标的笔刷圈"（此时是拖框/圈选，不是涂抹）
  if (maskMode !== 'brush' && brushCursor) {
    brushCursor.style.display = 'none';
  }
}

/** 切换涂抹方式（笔刷 / 框选 / 套索） */
function setMaskMode(mode) {
  if (!['brush', 'rect', 'lasso'].includes(mode)) return;
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
  closePenMenu();
  closeShapeMenu();
  closeMaskMenu();
  closeEraserMenu();
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
  closePenMenu();
  closeShapeMenu();
  closeMaskMenu();
  closeEraserMenu();
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

/** 哪些工具显示笔刷预览圈（pen + 高亮 + 打码四种 + 橡皮擦） */
const BRUSH_CURSOR_TOOLS = new Set(['pen', 'highlight', 'blur', 'mosaic', 'noise', 'solid', 'eraser']);
/** 哪些工具支持 Shift+滚轮 调粗细（笔刷类 + 图形类，两者共用 drawingSize） */
const SIZE_WHEEL_TOOLS = new Set([...BRUSH_CURSOR_TOOLS, 'line', 'rect', 'arrow', 'curve', 'ellipse']);

/**
 * 当前工具对应的笔刷**半径**（CSS px）。
 * pen / 四种打码 / 橡皮擦统一用工具栏「粗细」滑块（drawingSize）——打码面板里只剩"效果参数"，
 * 不再重复一个粗细调节（用户明确要求）。
 * ⚠️ 原实现把 drawingSize 当半径返回，预览圈直径 = 2×drawingSize，看起来是实际笔触的 2 倍
 * （2026-09-25 用户反馈「圈和笔刷不一样大、橡皮擦比圈小」）。实际落笔直径就是 drawingSize
 * （drawLine 的 lineWidth / 橡皮擦挖空直径），所以这里必须返回 drawingSize / 2。
 */
function currentBrushRadius() {
  if (BRUSH_CURSOR_TOOLS.has(activeTool)) return Math.max(1, drawingSize / 2);
  return 0;
}

/** 显示 / 移动 / 隐藏笔刷预览圈
 *  @param mx - 当前光标 CSS x
 *  @param my - 当前光标 CSS y
 *  @param visible - true 显示，false 隐藏 */
/** 笔刷预览圈当前是否显示（可见时系统十字光标要隐藏，见 brushAwareCursor） */
let brushCursorShown = false;

function setBrushCursor(mx, my, visible) {
  if (!brushCursor) return;
  // 打码的「框选 / 套索」模式是拖框/圈选，不跟光标显示笔刷圈（仅打码工具适用；高亮/橡皮擦无此模式）
  const maskRectMode = MASK_TOOLS.includes(activeTool) && maskMode !== 'brush';
  if (!visible || !BRUSH_CURSOR_TOOLS.has(activeTool) || maskRectMode || !isInsideSelection(mx, my)) {
    brushCursorShown = false;
    if (brushCursor.style.display !== 'none') brushCursor.style.display = 'none';
    return;
  }
  const radius = currentBrushRadius();
  if (radius <= 0) {
    brushCursorShown = false;
    brushCursor.style.display = 'none';
    return;
  }
  brushCursorShown = true;
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

/** 画笔/打码系光标：预览圈可见时隐藏系统十字（2026-09-25 用户反馈「圆圈中间还有个十字」）
 *  —— 圈本身已经标出落点与笔宽，再叠一个十字反而看不清笔触中心。 */
function brushAwareCursor() {
  return brushCursorShown ? 'none' : 'crosshair';
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

/** 默认字体栈（历史默认值）：样式条里「微软雅黑」一项就是它 */
const DEFAULT_TEXT_FAMILY = '"Microsoft YaHei", "PingFang SC", system-ui, -apple-system, "Segoe UI", sans-serif';
/** 文字样式（加粗 / 斜体 / 字体）持久化键：与「粗细」一样跨会话沿用上次选择 */
const TEXT_STYLE_KEY = 'petalsnap.textStyle';
let textBold = false;
let textItalic = false;
let textFamily = DEFAULT_TEXT_FAMILY;

/**
 * canvas 字体串：粗体 / 斜体 → font shorthand 的 style / weight 前缀。
 * 布局（measureText）与绘制（fillText）必须用同一串，否则折行位置和实际字宽会对不上。
 * 参数可以是编辑器配置，也可以是某个文字对象（对象自己带着 fontSize/fontFamily/bold/italic）。
 */
function annotFontString(s) {
  return `${s.italic ? 'italic ' : ''}${s.bold ? '700 ' : ''}${s.fontSize}px ${s.fontFamily}`;
}

/** 与 drawAnnotText（annotCanvas 渲染）完全一致的字体度量 */
function getEditorFontConfig() {
  return {
    fontFamily: textFamily,
    // 与工具栏「粗细」滑块(drawingSize 1~60px) 直接对应：放大到 drawingSize * 3+12，
    // 范围 15~192px，方便看清。
    // 编辑中若用户直接拉手柄改了字号，则用 editorFontOverride（否则会被滑块值弹回去）。
    fontSize: editorFontOverride > 0
      ? Math.round(editorFontOverride)
      : Math.max(16, Math.round((drawingSize || 4) * 3 + 12)),
    lineHeight: 1.32,
    bold: textBold,
    italic: textItalic,
  };
}

/** 编辑器几何覆盖值：编辑中直接拖动/缩放文字框时，几何由对象自身说了算，
 *  不再回头读工具栏滑块与选区宽度。0 = 未覆盖（用推导值）。销毁编辑器时清零。 */
let editorFontOverride = 0;
let editorWidthOverride = 0;

/** 文字排版可用宽度（选区内剩余宽度，CSS px；编辑中拉过宽度则用覆盖值） */
function editorMaxWidth() {
  if (editorWidthOverride > 0) return Math.round(editorWidthOverride);
  // 全屏画布语义：折行宽度到画布右边（选框只是导出预览，不限制文字）
  return Math.max(24, W - textAnchorX - 8);
}

/**
 * 按 maxWidth 折行，返回每行 { text, start, end, width }（start/end 为源串字符下标，
 * width 供命中检测 bbox 使用）。提交与实时渲染共用同一份结果，保证折行位置也绝不会变。
 */
function layoutEditorText(text, maxWidth, spec) {
  const cfg = spec || getEditorFontConfig();
  drawCtx.save();
  drawCtx.font = annotFontString(cfg);
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
  const cfg = getEditorFontConfig();
  const { fontSize, lineHeight } = cfg;
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
  annotCtx.font = annotFontString(cfg);
  const caretX = textAnchorX + annotCtx.measureText(lines[lineIdx].text.slice(0, col)).width;
  annotCtx.restore();

  const caretW = Math.max(2, Math.round(fontSize / 16));
  // 光标覆盖**字形高度**（行盒里的字号块，与提示框的纵向贴合口径一致）
  const caretY = Math.round(textAnchorY + lineIdx * lineHeightPx + (lineHeightPx - fontSize) / 2);
  // 光标颜色同样按底色取对比色（2026-09-26 用户要求「光标也是」）：白底黑光标、黑底白光标
  ensureAnnotLuma();
  const ink = frameInk(lumaAtLogical(caretX + caretW / 2, caretY + fontSize / 2));
  annotCtx.save();
  annotCtx.fillStyle = ink.solid;
  // 旋转编辑：光标绕同一枢轴转，才能贴在倾斜的文字上
  if (editingTextAnnot) applyRotAbout(annotCtx, annotPivot(editingTextAnnot), annotRot(editingTextAnnot));
  annotCtx.fillRect(Math.round(caretX), caretY, caretW, Math.round(fontSize));
  annotCtx.restore();
}

/** 同步编辑态到临时对象（样式随工具栏实时刷新），返回是否有可见文字 */
function syncEditingTextAnnot() {
  if (!textEditor || !editingTextAnnot) return false;
  const text = textEditor.value.replace(/\r/g, '');
  const cfg = getEditorFontConfig();
  const a = editingTextAnnot;
  a.text = text;
  a.color = drawingColor;
  a.fontFamily = cfg.fontFamily;
  a.fontSize = cfg.fontSize;
  a.lineHeight = cfg.lineHeight;
  a.bold = cfg.bold;
  a.italic = cfg.italic;
  a.maxWidth = editorMaxWidth();
  a.lines = layoutEditorText(text, a.maxWidth, a);
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
  // 2026-09-29 重构：编辑期文字由 textarea 原生显示（颜色随 drawingColor），canvas **不画**——
  // 旧"透明 textarea + canvas 每帧清空重画"是文字闪现消失的根因（重绘竞态 + IME 组词串不可见）。
  // 这里只同步数据模型与几何框；提交后由 canvas 接管渲染（同字体度量）。
  syncEditingTextAnnot();
  syncEditorBox();
  // renderAnnots() 里的那次同步发生在 syncEditingTextAnnot() 之前（几何还是上一帧的），
  // 这里用刚刷新的文字几何再同步一次 DOM 选框，输入时框线才跟得上。
  syncAnnotHandles();
}

/** 光标闪烁计时器 */
let textCaretTimer = null;
/** 光标当前是否处于"亮"相位（输入时强制常亮） */
let textCaretOn = true;

function startCaretBlink() {
  // 2026-09-29 重构：光标由 textarea 原生 caret 接管（caret-color 主题蓝），不再自绘闪烁——
  // 自绘 = 每 530ms 全画布清空重画一遍（文字闪现的帮凶）。
  stopCaretBlink();
  textCaretOn = true;
}

function stopCaretBlink() {
  if (textCaretTimer) {
    clearInterval(textCaretTimer);
    textCaretTimer = null;
  }
}

/** 文字编辑提示框的内边距（CSS px）：四周等量 → 文字在框里水平/垂直都居中。
 *  取接近「一个行间距」的留白（lineHeight 1.32 → 行间距约 0.32em，这里每侧 0.28em），
 *  框线和文字之间就有一段和行距相当的呼吸感（2026-09-26 用户反馈：贴着字不好看，
 *  间距应与行间距相当；对齐参考图的「文字四周有明显留白」）。 */
function textBoxPad(fontSize) {
  return Math.max(6, Math.min(22, Math.round(fontSize * 0.28)));
}

/** textarea 只覆盖文字实际占用的矩形，其余选区仍可点（点空白处 = 提交并另起一处） */
function syncEditorBox() {
  if (!textEditor) return;
  const cfg = getEditorFontConfig();
  const { fontFamily, fontSize, lineHeight } = cfg;
  const lineHeightPx = Math.round(fontSize * lineHeight);
  const lines = layoutEditorText(textEditor.value.replace(/\r/g, ''), editorMaxWidth());
  const n = Math.max(1, lines.length);
  const h = n * lineHeightPx;
  const rot = editingTextAnnot ? annotRot(editingTextAnnot) : 0;
  // 枢轴偏移（相对文字块左上角 = textAnchor）：textarea / hint 框都绕它转，
  // 与画布上的文字、DOM 选框同一个不动点（旧模型枢轴=左上角，这里才有 origin 0 0）。
  const pv = editingTextAnnot ? pivotOffset(editingTextAnnot) : { x: 0, y: 0 };
  // textarea 的几何也统一在这里落：编辑中拖动/缩放/旋转只改 textAnchorX/Y 与 rot，
  // 调一次本函数即可全部同步（left/top/width/height/旋转一处不漏）。
  textEditor.style.left = `${textAnchorX}px`;
  textEditor.style.top = `${textAnchorY}px`;
  textEditor.style.width = `${editorMaxWidth()}px`;
  textEditor.style.height = `${h}px`;
  textEditor.style.transformOrigin = `${pv.x}px ${pv.y}px`;
  textEditor.style.transform = rot ? `rotate(${rot}rad)` : 'none';
  if (textEditorHint) {
    // 提示框横向**贴合当前文字**（逐字变宽，最少留一个字的位置）：旧实现固定用「选区内剩余宽度」，
    // 短文字贴在框左边缘，看起来"没在框正中间"（2026-09-25 用户反馈）。
    // textarea 本体仍保持整段可用宽度 —— 它的换行/选区高亮/IME 候选框定位要和 layoutEditorText 同一套宽度。
    // 纵向只包住**字形块**：文字用 textBaseline:'middle' 画在每行行盒中线，故首行字形顶边 =
    // textAnchorY + (行盒−字号)/2，字形块总高 = (行数−1)*行高 + 字号。旧实现直接拿「行数×行高」
    // 当框高，把首行上方的行距也圈进框里 → 文字看着偏在框的上半部分（2026-09-26 用户反馈"没在框中间"）。
    const textW = Math.max(fontSize, ...lines.map((ln) => ln.width || 1));
    const caretW = Math.max(2, Math.round(fontSize / 16)); // 末尾自绘光标要留在框内
    const pad = textBoxPad(fontSize);
    const inset = (lineHeightPx - fontSize) / 2;
    // 尾部预留空位（与 annotBounds 同一条算法）：提交后框不会突然收窄
    const trail = textTrailPad(fontSize);
    const boxW = Math.min(editorMaxWidth(), textW + trail) + pad * 2 + Math.max(0, caretW - pad);
    textEditorHint.style.left = `${textAnchorX - pad}px`;
    textEditorHint.style.top = `${textAnchorY + inset - pad}px`;
    textEditorHint.style.width = `${boxW}px`;
    textEditorHint.style.minHeight = `${(n - 1) * lineHeightPx + fontSize + pad * 2}px`;
    // 框线也走「对比色」：白底黑框、黑底白框（原来 focus 后是主题蓝，用户要求改成对比色）
    textEditorHint.style.borderColor = frameInk(editingTextAnnot ? annotFrameLuma(editingTextAnnot) : -1).line;
    // 旋转态：提示框绕「旋转枢轴」一起转。枢轴世界坐标 = (textAnchorX + pv.x, textAnchorY + pv.y)，
    // 本框左上角在 (textAnchorX−pad, textAnchorY+inset−pad) → origin 补偿 (pad + pv.x, pad − inset + pv.y)，
    // 于是框线始终贴着倾斜的文字，且与画布/手柄层共用同一个不动点（否则「字斜框正」）。
    textEditorHint.style.transformOrigin = `${pad + pv.x}px ${pad - inset + pv.y}px`;
    textEditorHint.style.transform = rot ? `rotate(${rot}rad)` : 'none';
  }
  // 让浏览器（IME 候选框定位）用同一套字体度量（粗体/斜体一并带上，与画布渲染一致）
  textEditor.style.font = `${cfg.italic ? 'italic ' : ''}${cfg.bold ? '700 ' : ''}${fontSize}px / ${lineHeightPx}px ${fontFamily}`;
}

/** 打开文字编辑器
 *  @param mx - 选区内 CSS x（文字左边界）
 *  @param my - 选区内 CSS y（**首行文字的垂直中点**，Snipaste 手感：
 *              点击点对齐文本框左缘中部，文字落在光标正下方，
 *              而不是旧版“文字框左上角=点击点”导致文字整体偏到点击点右下）
 *  @param rot - 已有文字对象自带的旋转角（rad）；重新编辑时传进来，新文字为 0
 *  @param pv - 已有文字对象的枢轴偏移（相对文字块左上角）；重新编辑时传进来，
 *              这样「转着编辑」的时候枢轴仍然是原来那个不动点，打字不会让整段游走 */
function openTextEditor(mx, my, rot, pv) {
  if (textEditor) commitTextEditor();

  // 先落一个快照：本次文字编辑"之前"的状态，Esc 可直接回退到这里。
  // 文字是矢量对象：编辑前后位图都不变，快照复用栈顶 ImageData（零内存增长）。
  // 记下这条快照的下标：空提交 / 右键取消都要精确地对着它收尾（见 editorSnapIndex 注释）。
  const snapBefore = historyStack.length;
  commitHistory(false);
  editorSnapIndex = historyStack.length > snapBefore ? historyStack.length - 1 : -1;

  // 新开的编辑器一律从工具栏取值：清掉上一段文字留下的「几何覆盖」
  // （重新编辑已有文字时，editTextAnnot 已把它的字号写回工具栏，所以覆盖值不需要跨编辑器继承）
  editorFontOverride = 0;
  // 折行宽度在开框瞬间锁定（2026-09-28 用户反馈"框静止/移动时变化"根因）：
  // editorMaxWidth() 依赖锚点（= 选区右边 − 锚点），拖框移动时锚点变 → 宽度变 →
  // 文字重排 → 框高宽跳变。锁定后移动只平移、不重排（Snipaste 同语义）。
  editorWidthOverride = editorMaxWidth();
  const cfg = getEditorFontConfig();
  const { fontFamily, fontSize, lineHeight } = cfg;
  const lineHeightPx = Math.round(fontSize * lineHeight);

  textAnchorX = Math.round(Math.max(0, Math.min(mx, W - 24)));
  // 首行顶边 = 点击点 − 半行高；全屏画布语义：只钳制在屏幕范围内
  textAnchorY = Math.round(Math.max(0, Math.min(my - lineHeightPx / 2, H - lineHeightPx)));

  // 编辑中的临时对象：不进 annotations 数组，样式/折行随每次输入实时刷新；
  // commit 才克隆固化（颜色/字号取提交瞬间值），cancel 则连同这次历史步一起丢弃。
  editingTextAnnot = {
    type: 'text', x: textAnchorX, y: textAnchorY, text: '',
    color: drawingColor, fontFamily, fontSize, lineHeight,
    bold: cfg.bold, italic: cfg.italic,
    maxWidth: editorMaxWidth(), lines: [], editing: true,
    rot: rot || 0,
  };
  if (pv) { editingTextAnnot.pvx = pv.x; editingTextAnnot.pvy = pv.y; }

  const ta = document.createElement('textarea');
  ta.className = 'capture-text-editor';
  ta.spellcheck = false;
  ta.autocomplete = 'off';
  ta.maxLength = 5000;
  ta.rows = 1;
  ta.wrap = 'soft';
  ta.setAttribute('aria-label', tCapture('captureInputText') || '输入文字');
  // 完全透明：字符由画布渲染，textarea 只负责接键 / IME / 选区
  // 几何（left/top/width/旋转）统一交给 syncEditorBox() —— 之后拖动/缩放只改
  // textAnchorX/Y 与 rot，再调一次它即可，textarea 与 hint 不会各说各话。
  ta.style.setProperty('--cap-editor-size', `${fontSize}px`);
  ta.style.color = drawingColor; // 编辑期文字可见（原生渲染），颜色与最终 canvas 渲染一致

  // 极简 hint 框：提示"这里可以输入"，提交 / 取消时移除。
  // 位置与宽高统一由 syncEditorBox() 按当前文字贴合计算（见下方 open 末尾的调用），这里不再重复设几何。
  const hint = document.createElement('div');
  hint.className = 'capture-text-editor-hint';
  textEditorHint = hint;

  // 任何内容 / 选区变化都重画一次（输入、退格、粘贴、方向键、点选、中文组词中）
  const onChange = () => {
    if (textEditor !== ta) return;
    ta.style.color = drawingColor; // 换色实时跟（编辑期 textarea 即所见）
    refreshEditorCanvas();
  };
  ta.addEventListener('input', onChange);
  ta.addEventListener('click', onChange);
  ta.addEventListener('keyup', onChange);
  ta.addEventListener('compositionupdate', onChange);
  ta.addEventListener('compositionend', onChange);

  // textarea 盖在文字上（宽度 = 选区剩余宽度），会挡住右侧/下边的对象手柄。
  // 所以它自己也要把「按在手柄上」「按在框上」的按下转给对象手势；右键同样走步骤撤销。
  ta.addEventListener('mousedown', (ev) => {
    if (textEditor !== ta) return;
    if (ev.button === 2) {
      ev.preventDefault();
      handleRightClick();
      return;
    }
    if (ev.button !== 0) return;
    const pt = lsClientToLogical(ev);
    // 选框把手/边**最高优先**（2026-09-29 用户实测：编辑中按选框把手变成了新建文字框）：
    // textarea 覆盖区内的选框把手/边，先提交编辑器、再把按下转发给 tempCanvas 走
    // 选框拉伸/移动——「拉伸图标出现的地方，操作必须就是拉伸」。
    const selHandleHit = hitTestHandle(pt.x, pt.y);
    if (process.env.PETALSNAP_SMART_DEBUG === '1') console.error(`[TXT] ta-down pt=${pt.x},${pt.y} selH=${selHandleHit || '-'} nearBorder=${nearSelectionBorder(pt.x, pt.y)}`);
    if (selHandleHit || nearSelectionBorder(pt.x, pt.y)) {
      ev.preventDefault();
      commitTextEditor();
      tempCanvas.dispatchEvent(new MouseEvent('mousedown', {
        clientX: ev.clientX, clientY: ev.clientY, button: 0, bubbles: true,
      }));
      return;
    }
    // 手柄优先：按在缩放/旋转/删除手柄上转给对象手势（消费成功则**不**进拖框待定——
    // 否则两条手势并行，缩放时框还在被拖走）
    const consumed = tryBeginAnnotGesture(pt.x, pt.y, ev, false);
    if (process.env.PETALSNAP_SMART_DEBUG === '1') console.error(`[TXT] down consumed=${consumed} pt=${pt.x},${pt.y} anchor=${textAnchorX},${textAnchorY} state=${state}`);
    // 正文按下 = 「拖框待定」（2026-09-29 用户要求：文字框可拖动、悬停变移动光标）：
    // 移动超 4px = 拖动整个编辑框（textAnchor 跟随），原地点击 = 放光标（不 preventDefault）。
    if (!consumed) {
      editorDragPending = { startX: ev.clientX, startY: ev.clientY, anchorX: textAnchorX, anchorY: textAnchorY, active: false };
    }
  });
  // ★ 原生 drag 劫持修复（2026-09-29 真凶）：真实鼠标拖 textarea 时浏览器启动原生
  // 文本拖放——mousemove 事件流被 drag 取代，手势处理完全收不到 = 自测 PASS 而真实
  // 鼠标全部无效的系统性差异。合成事件不触发原生 drag，测试永远测不到这条。
  ta.addEventListener('dragstart', (ev) => {
    ev.preventDefault();
  });
  // 拖框手势中禁选（防止拖动变选字）
  ta.addEventListener('selectstart', (ev) => {
    if (editorDragPending || (state === STATE.RESIZING && annotResizeHandle) || state === STATE.MOVING) {
      ev.preventDefault();
    }
  });

  // 悬停光标（textarea 覆盖在框上，canvas 的 mousemove 逻辑收不到事件 → 光标停在旧样式）：
  // 在 textarea 上自己算手柄/本体命中，给出拉伸/旋转/移动光标（2026-09-29 用户要求）
  ta.addEventListener('mousemove', (ev) => {
    if (textEditor !== ta) return;
    const pt = lsClientToLogical(ev);
    // 手势进行中（按住手柄拉伸 / 拖框移动）：textarea 盖住了状态机的事件源
    // （tempCanvas）—— **把事件转发过去**，否则 RESIZING/MOVING 的逐帧处理
    // 从不执行 = 「光标是拉伸、操作却无效」（2026-09-29 审计实锤的断点）
    if ((state === STATE.RESIZING && annotResizeHandle) || state === STATE.MOVING) {
      tempCanvas.dispatchEvent(new MouseEvent('mousemove', {
        clientX: ev.clientX, clientY: ev.clientY, bubbles: true,
      }));
      return;
    }
    const h = annotHandleAt(pt.x, pt.y);
    if (h) {
      document.body.style.cursor = HANDLE_CURSOR[h] || 'default';
    } else {
      document.body.style.cursor = 'move';
    }
  });
  ta.addEventListener('mouseleave', () => {
    if (textEditor === ta) document.body.style.cursor = 'crosshair';
  });
  // 手势进行中松开：mouseup 同样被 textarea 挡住 → 转发（否则 RESIZING/MOVING 状态卡死）
  ta.addEventListener('mouseup', (ev) => {
    if (textEditor !== ta) return;
    if ((state === STATE.RESIZING && annotResizeHandle) || state === STATE.MOVING) {
      tempCanvas.dispatchEvent(new MouseEvent('mouseup', {
        clientX: ev.clientX, clientY: ev.clientY, bubbles: true,
      }));
    }
  });

  ta.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.ctrlKey && !ev.shiftKey && !ev.altKey) {
      ev.preventDefault();
      ev.stopPropagation();
      commitTextEditor();
    } else if (ev.key === 'Escape') {
      // Esc = 层级退出：收尾保留这段文字（丢弃请用右键 = 步骤撤销）
      ev.preventDefault();
      ev.stopPropagation();
      commitTextEditor();
    }
  });

  // 失焦 = 落地提交。例外：焦点移到「颜色 / 粗细」这类样式控件时不提交，
  // 让用户能边打字边换色换字号；点到别处（含工具栏其它按钮、画布、选区）一律提交。
  ta.addEventListener('blur', (ev) => {
    if (textEditor !== ta) return;
    const next = ev.relatedTarget;
    // 加粗 / 斜体 / 字体下拉同属「打字时随手调样式」的控件，一起豁免
    if (next && (next === colorPicker || next === sizeSlider
      || (colorPalette && colorPalette.contains(next))
      || (textStyleRow && textStyleRow.contains(next)))) return;
    commitTextEditor();
  });

  document.body.appendChild(hint);
  document.body.appendChild(ta);
  textEditor = ta;
  syncEditorBox();
  // 立刻把 DOM 选框切到「这个新编辑器」上（空文字对象 → 整层收起）。
  // 不在这里同步的话，刚提交的那段文字的选框会一直挂到下一次 syncAnnotHandles ——
  // 而它只由输入 / 光标闪烁（530ms 一次）/ 鼠标在对象上移动触发，于是「点了别处，
  // 边框过一会儿才消失」（2026-09-26 用户反馈）。syncEditorBox 只同步编辑器自己的几何，
  // 不管 #annotHandles，所以必须在这里补一刀。
  syncAnnotHandles();
  startCaretBlink();
  setTimeout(() => {
    try { ta.focus(); } catch (_) { /* 容忍 */ }
    if (textEditorHint) textEditorHint.classList.add('is-focus');
  }, 0);
}

/** 提交：撤掉光标，把文字固化成矢量对象（进 annotations + 一步对象历史） */
function commitTextEditor() {
  if (!textEditor) return;
  if (process.env.PETALSNAP_SMART_DEBUG === '1') {
    const st = (new Error().stack || '').split('\n')[2] || '';
    console.error('[TXT] commit from:', st);
  }
  lastTextCommitAt = Date.now();
  stopCaretBlink();
  const raw = textEditor.value;
  const pending = editingTextAnnot;
  destroyTextEditor();
  editingTextAnnot = null;
  const text = raw.replace(/\r/g, '');
  if (!text.trim()) {
    // 什么都没输入：这一趟编辑没有产生任何像素/对象变化，只需把 open 时压入的那条快照摘掉
    // （Undo 不该出现"空按一次"）。
    // **绝不能**再 restoreHistoryTop()：那是整层回滚到「下面那条快照」——位图 + 对象层一起倒退，
    // 会把这段时间里刚提交的文字改动一并抹掉（2026-09-26 实测：新建文字后连点两次空白，
    // 文字对象与墨迹一起归零；改完文字再点两次空白，退回改动前的内容）。
    renderAnnots();
    if (editorSnapIndex >= 0 && editorSnapIndex === historyStack.length - 1) {
      historyStack.pop();
      historyIndex = historyStack.length - 1;
    } else if (historyIndex >= historyStack.length) {
      historyIndex = historyStack.length - 1; // 快照被别处截断过：只把下标夹回合法范围
    }
    editorSnapIndex = -1;
    return;
  }
  if (pending) {
    // 提交瞬间再次同步样式与折行：与实时渲染同一套代码（layoutEditorText），像素零位移
    const cfg = getEditorFontConfig();
    pending.text = text;
    pending.color = drawingColor;
    pending.fontFamily = cfg.fontFamily;
    pending.fontSize = cfg.fontSize;
    pending.lineHeight = cfg.lineHeight;
    pending.bold = cfg.bold;
    pending.italic = cfg.italic;
    pending.maxWidth = editorMaxWidth();
    pending.lines = layoutEditorText(text, pending.maxWidth, pending);
    pending.editing = false;
    annotations.push(pending);
  }
  renderAnnots();
  // 立刻压一步历史快照：文字是**永久矢量对象**（isPersistentAnnot → 不进「待确认」队列、
  // 也永远不会被烘焙进位图），所以 commitPendingAnnot() 对它恒返回 false、不会替它压快照。
  // 不在这里压的话，栈顶仍是 openTextEditor 压的那条「编辑前」快照 —— 之后任意一次「步骤撤销」
  // （Esc / 右键 / Ctrl+Z 都是 discardPendingAnnot()→false→undoLast()）会再退一格到更早的快照：
  // 新建的文字整段消失、改过的文字直接没了（2026-09-26 实测「文字改动之后就就直接消失了」）。
  // 位图没变（文字只改对象层），bitmapChanged=false 复用栈顶 ImageData，零内存增长。
  commitHistory(false);
  editorSnapIndex = -1;
}

/** 取消（Esc / 右键）：丢弃本次输入，回到「打开编辑器之前」那一步 */
function cancelTextEditor() {
  if (!textEditor) return;
  stopCaretBlink();
  destroyTextEditor();
  editingTextAnnot = null;
  // 要回到的是 open 时压入的那条快照本身（它记录的正是「编辑前」），
  // 而不是它下面那条 —— 否则会把中间已提交的改动一起回退（与空提交分支同一处坑）。
  if (editorSnapIndex >= 0 && editorSnapIndex < historyStack.length) {
    historyIndex = editorSnapIndex;
    restoreHistoryTop();
    historyStack.length = editorSnapIndex; // 这条已经用掉，摘掉（Undo 不出现"空按一次"）
    historyIndex = historyStack.length - 1;
  } else {
    renderAnnots();
  }
  editorSnapIndex = -1;
}

/** 销毁文字编辑器浮层（textarea + hint 框）。
 *  摘除 textarea 会同步触发 blur，blur 处理器可能又走一次 commit → 重入本函数，
 *  于是「先判 parentNode、再 removeChild」之间节点已易主 → NotFoundError（2026-09-26 实测）。
 *  这里吞掉「节点已不在」这一种失败：本函数的目的「让它不在 DOM 里」已经达成。 */
function destroyTextEditor() {
  if (process.env.PETALSNAP_SMART_DEBUG === '1') {
    const st = (new Error().stack || '').split('\n')[2] || '';
    console.error('[TXT] destroy from:', st);
  }
  stopCaretBlink();
  if (textEditor) {
    const ta = textEditor;
    textEditor = null;
    try { if (ta.parentNode) ta.parentNode.removeChild(ta); } catch (_) { /* 已被 blur 重入摘掉 */ }
  }
  if (textEditorHint) {
    const hint = textEditorHint;
    textEditorHint = null;
    try { if (hint.parentNode) hint.parentNode.removeChild(hint); } catch (_) { /* 同上 */ }
  }
}

/* ── 文字样式条（Snipaste 式：加粗 / 斜体 / 字体）──
   字号复用左侧「粗细」滑块（drawingSize → fontSize），颜色复用色板；
   这里只管 bold / italic / fontFamily 三样，统一从 applyTextStyleChange() 下发生效。 */

/** 样式条显隐：文字工具激活，或在编辑文字时出现（文字是永久矢量，不靠选框提示可编辑） */
let textStyleRowOn = false;
function syncTextStyleRowVisibility() {
  if (!textStyleRow) return;
  const on = activeTool === 'text' || !!textEditor;
  if (on === textStyleRowOn) return; // 状态没变就早退（renderAnnots 调用很频繁）
  textStyleRowOn = on;
  textStyleRow.classList.toggle('is-on', on);
  // 样式条出现/收起会改变工具栏宽度 → 未手动拖过的工具栏按原规则重新落位（拖过的保持用户位置）
  if (toolbar && toolbar.style.display === 'flex' && !toolbarUserMoved) showToolbar();
}

/** 按钮/下拉回显当前样式（切工具、载入本地记录、对象改样式后都要同步一次） */
function syncTextStyleUI() {
  if (btnTextBold) btnTextBold.classList.toggle('is-active', textBold);
  if (btnTextItalic) btnTextItalic.classList.toggle('is-active', textItalic);
  if (textFontSelect) {
    const opts = Array.from(textFontSelect.options);
    // 按字体栈反查选项：本地存的是完整 font-family 串，选项 id 只是稳定标识
    const hit = opts.find((o) => o.dataset.fontStack === textFamily);
    textFontSelect.value = (hit || opts[0]).value;
  }
}

function persistTextStyle() {
  try {
    localStorage.setItem(TEXT_STYLE_KEY, JSON.stringify({ bold: textBold, italic: textItalic, family: textFamily }));
  } catch { /* 忽略写入失败 */ }
}

function loadTextStyle() {
  try {
    const saved = JSON.parse(localStorage.getItem(TEXT_STYLE_KEY) || 'null');
    if (saved && typeof saved === 'object') {
      textBold = saved.bold === true;
      textItalic = saved.italic === true;
      if (typeof saved.family === 'string' && saved.family) textFamily = saved.family;
    }
  } catch { /* 本地数据损坏时忽略，用默认值 */ }
  syncTextStyleUI();
}

/**
 * 样式改变的唯一下游：刷新按钮态 → 落盘 → 重绘正在输入的文字
 * （编辑中的文字不进 annotations，靠 refreshEditorCanvas 按新字体/字形重排；
 *   提交时 commitTextEditor 再固化一次，所以这里不需要改对象）
 */
function applyTextStyleChange() {
  syncTextStyleUI();
  persistTextStyle();
  if (textEditor) refreshEditorCanvas();
  syncTextStyleRowVisibility();
}

if (btnTextBold) {
  btnTextBold.addEventListener('click', () => {
    textBold = !textBold;
    applyTextStyleChange();
  });
}
if (btnTextItalic) {
  btnTextItalic.addEventListener('click', () => {
    textItalic = !textItalic;
    applyTextStyleChange();
  });
}
if (textFontSelect) {
  textFontSelect.addEventListener('change', () => {
    const opt = textFontSelect.selectedOptions[0] || textFontSelect.options[textFontSelect.selectedIndex];
    if (opt && opt.dataset.fontStack) textFamily = opt.dataset.fontStack;
    applyTextStyleChange();
  });
}
loadTextStyle();

/* ── 图形工具二级面板：直线 / 矩形 / 箭头 / 椭圆 共用一个按钮 ── */
const SHAPE_TOOLS = ['line', 'rect', 'arrow', 'curve', 'ellipse'];
/** 支持 Shift 多点连续画的工具：直线→折线、箭头→折线箭头、曲线箭头→多点平滑曲线（末端单箭头） */
const POLY_TOOLS = ['line', 'arrow', 'curve'];

/* ── Shift 多点折线（2026-09-25）：按住 Shift 单击落「中间点」，松开 Shift 单击 / 双击收尾 ──
   进行中的折线以 live:true 挂在对象层里，靠 renderAnnots 实时预览（含光标处的橡皮筋段）；
   只有收尾提交那一次才 commitHistory，所以 Ctrl+Z 是「整条折线一步撤销」。 */

/** 起手：Shift + 单击落下第一点（此时还没有可见线段，光标一动橡皮筋就出来了） */
function startPolyline(x, y) {
  polyPoints = [[x, y]];
  annotations.push({
    type: 'shape', shape: activeTool, x1: x, y1: y, x2: x, y2: y,
    color: drawingColor, size: drawingSize, points: [[x, y]], live: true,
  });
  polyLiveIdx = annotations.length - 1;
  renderAnnots();
}

/**
 * 同步 live 折线的顶点与端点。传了 rubber 坐标 = 光标处追加一个**临时**橡皮筋终点
 * （不写进 polyPoints，松手/加点时自然消失）。
 */
function syncPolyline(rubberX, rubberY) {
  if (!polyPoints || polyLiveIdx < 0) return;
  const a = annotations[polyLiveIdx];
  if (!a) return;
  const pts = rubberX === undefined ? polyPoints : polyPoints.concat([[rubberX, rubberY]]);
  a.points = pts.map((p) => [p[0], p[1]]);
  const n = a.points.length;
  a.x1 = a.points[0][0]; a.y1 = a.points[0][1];
  a.x2 = a.points[n - 1][0]; a.y2 = a.points[n - 1][1];
  renderAnnots();
}

/** 收尾提交：摘掉 live 标记、固定顶点、入历史栈；顶点不足 2 个直接丢弃（等于没画） */
function finishPolyline(pts, commit) {
  const idx = polyLiveIdx;
  polyPoints = null;
  polyLiveIdx = -1;
  const a = idx >= 0 ? annotations[idx] : null;
  if (a && Array.isArray(pts) && pts.length >= 2) {
    delete a.live;
    a.points = pts.map((p) => [p[0], p[1]]);
    const n = a.points.length;
    a.x1 = a.points[0][0]; a.y1 = a.points[0][1];
    a.x2 = a.points[n - 1][0]; a.y2 = a.points[n - 1][1];
    // 折线收尾后仍是「待确认」对象：不压历史，等确认（烘焙）时才压一次
  } else if (idx >= 0) {
    annotations.splice(idx, 1);
  }
  renderAnnots();
  state = STATE.SELECTED;
  showToolbar();
  drawMask();
  updateSizeInfo(pendingMouseX, pendingMouseY);
  updateGuideContent();
}

/** 放弃（Esc / 右键）：把未收尾的折线整条摘掉，不留痕迹、不留历史步骤 */
function abortPolyline() {
  if (polyPoints === null && polyLiveIdx < 0) return false;
  const idx = polyLiveIdx;
  polyPoints = null;
  polyLiveIdx = -1;
  if (idx >= 0 && annotations[idx]) annotations.splice(idx, 1);
  renderAnnots();
  state = STATE.SELECTED;
  showToolbar();
  drawMask();
  updateGuideContent();
  return true;
}

/* ── 画笔二级面板：画笔 / 高亮（半透明马克笔）合并为一个按钮 + 面板 ── */
const PEN_TOOLS = ['pen', 'highlight'];
const PEN_ICON_SVG = { pen: 'PAINTBRUSH', highlight: 'HIGHLIGHT' };
const PEN_LABEL_KEY = { pen: 'pen', highlight: 'highlight' };
/** 高亮默认色：用户未手动换色时切到黄（40% 透明度在 paintHighlightStroke 内固定） */
const HIGHLIGHT_DEFAULT_COLOR = '#ffd400';
/** 高亮整体透明度（与 Snipaste 马克笔观感一致；单笔一次性合成，不逐段叠加） */
const HIGHLIGHT_ALPHA = 0.4;

/** 让画笔按钮的图标/文案跟随当前默认画笔（data-tool 同步，便于 active 高亮） */
function syncPenButton() {
  if (!penBtn || !penIcon) return;
  penBtn.dataset.tool = penTool;
  penIcon.src = `./svg/${PEN_ICON_SVG[penTool] || 'PAINTBRUSH'}.svg`;
  const label = tCapture(PEN_LABEL_KEY[penTool] || penTool) || penTool;
  penBtn.title = label;
  penBtn.setAttribute('aria-label', label);
  syncPenMenuItems();
}

/** 画笔菜单内当前项高亮 */
function syncPenMenuItems() {
  penItems.forEach((item) => {
    item.classList.toggle('active', item.dataset.pen === penTool);
  });
}

function isPenMenuOpen() {
  return penMenu && penMenu.style.display !== 'none';
}

/** 关闭画笔二级面板 */
function closePenMenu() {
  if (!penMenu) return;
  penMenu.style.display = 'none';
}

/** 展开画笔二级面板：紧贴按钮（默认向上，贴近屏顶时向下） */
function openPenMenu() {
  if (!penMenu || !penBtn) return;
  closeEraserMenu();
  syncPenMenuItems();
  penMenu.style.visibility = 'hidden';
  penMenu.style.display = 'flex';
  const menuW = penMenu.offsetWidth || 120;
  const menuH = penMenu.offsetHeight || 84;
  const rect = penBtn.getBoundingClientRect();
  let left = rect.left;
  if (left + menuW > window.innerWidth - 6) left = window.innerWidth - menuW - 6;
  penMenu.classList.toggle('capture-shape-menu-down', rect.top < 170);
  if (rect.top < 170) {
    penMenu.style.top = `${Math.min(window.innerHeight - menuH - 6, rect.bottom + 8)}px`;
  } else {
    penMenu.style.top = `${Math.max(6, rect.top - menuH - 8)}px`;
  }
  penMenu.style.left = `${Math.max(6, left)}px`;
  penMenu.style.visibility = 'visible';
}

function togglePenMenu() {
  if (isPenMenuOpen()) {
    closePenMenu();
  } else {
    openPenMenu();
  }
}

/* ── 橡皮擦二级面板：细擦（像素级，默认）/ 框选擦 ── */

/** 橡皮擦菜单内当前方式高亮 */
function syncEraserMenuItems() {
  eraserModeBtns.forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.eraserMode === eraserMode);
  });
}

function isEraserMenuOpen() {
  return eraserMenu && eraserMenu.style.display !== 'none';
}

/** 关闭橡皮擦二级面板 */
function closeEraserMenu() {
  if (!eraserMenu) return;
  eraserMenu.style.display = 'none';
}

/** 展开橡皮擦二级面板：紧贴按钮（默认向上，贴近屏顶时向下） */
function openEraserMenu() {
  if (!eraserMenu || !eraserBtn) return;
  syncEraserMenuItems();
  eraserMenu.style.visibility = 'hidden';
  eraserMenu.style.display = 'flex';
  const menuW = eraserMenu.offsetWidth || 168;
  const menuH = eraserMenu.offsetHeight || 60;
  const rect = eraserBtn.getBoundingClientRect();
  let left = rect.left;
  if (left + menuW > window.innerWidth - 6) left = window.innerWidth - menuW - 6;
  eraserMenu.classList.toggle('capture-shape-menu-down', rect.top < 170);
  if (rect.top < 170) {
    eraserMenu.style.top = `${Math.min(window.innerHeight - menuH - 6, rect.bottom + 8)}px`;
  } else {
    eraserMenu.style.top = `${Math.max(6, rect.top - menuH - 8)}px`;
  }
  eraserMenu.style.left = `${Math.max(6, left)}px`;
  eraserMenu.style.visibility = 'visible';
}

function toggleEraserMenu() {
  if (isEraserMenuOpen()) {
    closeEraserMenu();
  } else {
    openEraserMenu();
  }
}

/** 切换橡皮擦方式（细擦 / 框选擦）：面板保持打开，方便连着切；Esc 或点外部才关闭 */
function setEraserMode(mode) {
  if (mode !== 'brush' && mode !== 'rect') return;
  eraserMode = mode;
  syncEraserMenuItems();
  updateGuideContent();
}

/** 切换到指定画笔（画笔/高亮）并立即激活（画布拖拽直接按该笔绘制） */
function setPenTool(tool) {
  if (!PEN_TOOLS.includes(tool)) return;
  penTool = tool;
  // 高亮首次激活：默认黄（用户手动换过色则尊重用户选择）
  if (tool === 'highlight' && !colorPickedByUser) {
    applyDrawingColor(HIGHLIGHT_DEFAULT_COLOR, false);
  }
  syncPenButton();
  setTool(tool);
}
/** 当前默认图形（按钮图标与点击后使用的工具）；未激活时点按钮直接用它，再次点击可弹出面板换其它图形 */
let shapeTool = 'rect';
/** 图形填充模式（2026-09-25 用户要求）：false=描边（默认），true=填充纯色块；仅矩形/椭圆受影响 */
let shapeFill = false;
const SHAPE_ICON_SVG = { line: 'LINE', rect: 'RECTANGLE', arrow: 'ARROW', curve: 'CURVEARROW', ellipse: 'ELLIPSE' };

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
  syncShapeFillUI();
}

/**
 * 「描边 / 填充」行状态：跟随当前生效图形（工具栏 activeTool 优先，否则用默认 shapeTool）。
 * 直线/箭头/曲线没有内部面积 → 整行置灰不可点。
 */
function syncShapeFillUI() {
  if (!shapeFillBtns.length) return;
  const shape = SHAPE_TOOLS.includes(activeTool) ? activeTool : shapeTool;
  const usable = shape === 'rect' || shape === 'ellipse';
  shapeFillBtns.forEach((btn) => {
    btn.classList.toggle('is-active', (btn.dataset.shapeFill === 'fill') === shapeFill);
    btn.disabled = !usable;
  });
  if (shapeFillRow) shapeFillRow.classList.toggle('is-disabled', !usable);
}

/** 切换图形填充模式（描边 ↔ 填充） */
function setShapeFill(on) {
  shapeFill = !!on;
  syncShapeFillUI();
  updateGuideContent();
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
  closePenMenu();
  closeEraserMenu();
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

/* ── 高亮（马克笔）：单笔缓冲一次合成（40% 透明度，来回涂抹不叠实） ── */
let highlightStroke = null;

function beginHighlightStroke() {
  const dpr = canvasDpr;
  const sx = Math.max(0, Math.round(selX * dpr));
  const sy = Math.max(0, Math.round(selY * dpr));
  const sw = Math.min(Math.round(W * dpr) - sx, Math.round(selW * dpr));
  const sh = Math.min(Math.round(H * dpr) - sy, Math.round(selH * dpr));
  if (sw < 1 || sh < 1) return;
  const cv = document.createElement('canvas');
  cv.width = sw;
  cv.height = sh;
  highlightStroke = {
    canvas: cv,
    ctx: cv.getContext('2d'),
    base: drawCtx.getImageData(sx, sy, sw, sh), // 本笔开始前的位图，整体合成时还原
    x: sx,
    y: sy,
    w: sw,
    h: sh,
    points: [],
  };
}

/** 用统一透明度把高亮整笔合成一次（base=笔开始前位图，避免逐段叠加变实） */
function paintHighlightStroke() {
  if (!highlightStroke) return;
  const dpr = canvasDpr;
  const hctx = highlightStroke.ctx;
  const pts = highlightStroke.points;
  hctx.clearRect(0, 0, highlightStroke.w, highlightStroke.h);
  if (pts.length) {
    hctx.strokeStyle = drawingColor;
    hctx.lineWidth = Math.max(1, drawingSize * dpr);
    hctx.lineCap = 'round';
    hctx.lineJoin = 'round';
    hctx.beginPath();
    hctx.moveTo((pts[0][0] - selX) * dpr, (pts[0][1] - selY) * dpr);
    for (let i = 1; i < pts.length; i++) hctx.lineTo((pts[i][0] - selX) * dpr, (pts[i][1] - selY) * dpr);
    if (pts.length === 1) hctx.lineTo((pts[0][0] - selX) * dpr + 0.01, (pts[0][1] - selY) * dpr);
    hctx.stroke();
  }
  drawCtx.putImageData(highlightStroke.base, highlightStroke.x, highlightStroke.y);
  drawCtx.save();
  clipToSelection(drawCtx);
  drawCtx.globalAlpha = HIGHLIGHT_ALPHA;
  drawCtx.drawImage(
    highlightStroke.canvas,
    highlightStroke.x / dpr,
    highlightStroke.y / dpr,
    highlightStroke.w / dpr,
    highlightStroke.h / dpr,
  );
  drawCtx.restore();
}

function endHighlightStroke() {
  highlightStroke = null;
}

/** 重放一笔高亮：base 取当前 drawCtx 选区（=此笔开始前的状态），画 s.points 后一次合成 */
function replayHighlightStroke(s) {
  const dpr = canvasDpr;
  const sx = Math.max(0, Math.round(selX * dpr));
  const sy = Math.max(0, Math.round(selY * dpr));
  const sw = Math.min(Math.round(W * dpr) - sx, Math.round(selW * dpr));
  const sh = Math.min(Math.round(H * dpr) - sy, Math.round(selH * dpr));
  if (sw < 1 || sh < 1) return;
  const cv = document.createElement('canvas');
  cv.width = sw;
  cv.height = sh;
  const hctx = cv.getContext('2d');
  const pts = s.points || [];
  if (pts.length) {
    hctx.strokeStyle = s.color;
    hctx.lineWidth = Math.max(1, s.size * dpr);
    hctx.lineCap = 'round';
    hctx.lineJoin = 'round';
    hctx.beginPath();
    hctx.moveTo((pts[0][0] - selX) * dpr, (pts[0][1] - selY) * dpr);
    for (let i = 1; i < pts.length; i++) hctx.lineTo((pts[i][0] - selX) * dpr, (pts[i][1] - selY) * dpr);
    if (pts.length === 1) hctx.lineTo((pts[0][0] - selX) * dpr + 0.01, (pts[0][1] - selY) * dpr);
    hctx.stroke();
  }
  const base = drawCtx.getImageData(sx, sy, sw, sh);
  drawCtx.putImageData(base, sx, sy);
  drawCtx.save();
  clipToSelection(drawCtx);
  drawCtx.globalAlpha = HIGHLIGHT_ALPHA;
  drawCtx.drawImage(cv, sx / dpr, sy / dpr, sw / dpr, sh / dpr);
  drawCtx.restore();
}

/* ── 打码：框选 / 套索（整块应用一次） ── */

/**
 * 把「当前打码效果」渲染到目标上下文的一块区域上。
 * 这是 mosaic / blur / noise / solid 的唯一实现，框选与套索共用：
 *  · 框选 → 目标 = drawCtx（putImageData 直贴，区域已按选区裁剪）；
 *  · 套索 → 目标 = 离屏层（随后按多边形遮罩裁形、drawImage 贴回）。
 * 注意 putImageData 不受 clip / globalAlpha 约束，所以套索必须先离屏处理好再合成。
 * @param {CanvasRenderingContext2D} ctx 目标上下文
 * @param {number} dx,dy 效果落点（ctx 自身坐标系，物理像素）
 * @param {number} sw,sh 区域尺寸（物理像素）
 * @param {number} sx,sy 采样原点（画布物理坐标；mosaic/noise 的图案相位与 blur 取边都在此）
 */
function renderMaskEffect(ctx, dx, dy, sw, sh, sx, sy) {
  const dpr = canvasDpr;
  if (activeTool === 'solid') {
    // 纯色块：整块按透明度铺一遍（不需读取下方像素）
    ctx.save();
    ctx.globalAlpha = Math.max(0.05, Math.min(1, (maskIntensity || 100) / 100));
    ctx.fillStyle = drawingColor;
    ctx.fillRect(dx, dy, sw, sh);
    ctx.restore();
    return;
  }
  if (activeTool === 'blur') {
    const blurCss = Math.max(1, maskIntensity || 12);
    const pad = Math.ceil(blurCss * dpr);
    // 向外多取一圈 pad，避免滤镜在边缘采样到透明像素而发暗
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
    ctx.putImageData(tctx.getImageData(sx - px, sy - py, sw, sh), dx, dy);
    return;
  }
  // 像素 / 噪点：块状重排，共用 fillBlockGrid
  const merged = getMergedRegion(sx, sy, sw, sh);
  const img = merged.getContext('2d').getImageData(0, 0, sw, sh);
  if (activeTool === 'mosaic') {
    fillBlockGrid(img.data, sw, sh, Math.max(2, Math.round((maskIntensity || 10) * dpr)), sx, sy, 'mosaic');
  } else if (activeTool === 'noise') {
    fillBlockGrid(img.data, sw, sh, Math.max(1, Math.round(((maskIntensity || 8) / 2) * dpr)), sx, sy, 'noise');
  }
  ctx.putImageData(img, dx, dy);
}

/** 框选打码：拖出的矩形整块应用一次（区域按当前选区裁掉越界部分） */
function applyMaskRect(x1, y1, x2, y2) {
  const box = clipRectToSelection(x1, y1, x2, y2);
  if (!box) return;
  const dpr = canvasDpr;
  const sx = Math.round(box.rx * dpr);
  const sy = Math.round(box.ry * dpr);
  const sw = Math.round(box.rw * dpr);
  const sh = Math.round(box.rh * dpr);
  if (sw < 2 || sh < 2) return;
  renderMaskEffect(drawCtx, sx, sy, sw, sh, sx, sy);
}

/**
 * 套索打码：对「自由圈出的多边形」内部一次性应用当前打码效果。
 * 先在包围盒大小的离屏层上跑效果，再用多边形做 destination-in 遮罩裁形，
 * 最后 drawImage 贴回（drawImage 才受 clip 约束；putImageData 不受）。
 * @param {Array<[number,number]>} points 多边形顶点（CSS 像素，自动首尾相连闭合）
 */
function applyMaskInPath(points) {
  const pts = (points || []).filter((p) => Array.isArray(p) && p.length >= 2);
  if (pts.length < 3) return;
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const [px, py] of pts) {
    if (px < minX) minX = px;
    if (py < minY) minY = py;
    if (px > maxX) maxX = px;
    if (py > maxY) maxY = py;
  }
  const box = clipRectToSelection(minX, minY, maxX, maxY);
  if (!box) return;
  const dpr = canvasDpr;
  const sx = Math.round(box.rx * dpr);
  const sy = Math.round(box.ry * dpr);
  const sw = Math.round(box.rw * dpr);
  const sh = Math.round(box.rh * dpr);
  if (sw < 2 || sh < 2) return;

  const layer = document.createElement('canvas');
  layer.width = sw;
  layer.height = sh;
  const lctx = layer.getContext('2d');
  renderMaskEffect(lctx, 0, 0, sw, sh, sx, sy);

  // 多边形遮罩：顶点换算到包围盒内的物理像素，闭合后填白
  const mask = document.createElement('canvas');
  mask.width = sw;
  mask.height = sh;
  const mctx = mask.getContext('2d');
  mctx.fillStyle = '#fff';
  mctx.beginPath();
  mctx.moveTo((pts[0][0] - box.rx) * dpr, (pts[0][1] - box.ry) * dpr);
  for (let i = 1; i < pts.length; i++) {
    mctx.lineTo((pts[i][0] - box.rx) * dpr, (pts[i][1] - box.ry) * dpr);
  }
  mctx.closePath();
  mctx.fill();
  lctx.globalCompositeOperation = 'destination-in';
  lctx.drawImage(mask, 0, 0);
  lctx.globalCompositeOperation = 'source-over';

  drawCtx.save();
  clipToSelection(drawCtx);
  drawCtx.drawImage(layer, sx / dpr, sy / dpr, sw / dpr, sh / dpr);
  drawCtx.restore();
}

/** 套索预览：虚线多边形（浅靛蓝填充 + 深晕/白芯双色描边），末段连到当前光标 */
function drawLassoPreview(pts, mx, my) {
  if (!pts || pts.length < 2) return;
  clipToSelection(tempCtx);
  tempCtx.beginPath();
  tempCtx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) tempCtx.lineTo(pts[i][0], pts[i][1]);
  tempCtx.lineTo(mx, my);
  tempCtx.closePath();
  tempCtx.save();
  tempCtx.fillStyle = 'rgba(61, 107, 229, .14)';
  tempCtx.fill();
  tempCtx.lineJoin = 'round';
  tempCtx.setLineDash([6, 4]);
  tempCtx.strokeStyle = 'rgba(0, 0, 0, .72)';
  tempCtx.lineWidth = 3.5;
  tempCtx.stroke();
  tempCtx.strokeStyle = 'rgba(255, 255, 255, .98)';
  tempCtx.lineWidth = 1.5;
  tempCtx.stroke();
  tempCtx.restore();
  restoreClip(tempCtx);
}

/** 按当前涂抹方式把一次操作分发到对应实现 */
function applyMaskAt(cx, cy) {
  if (activeTool === 'blur') applyBlur(cx, cy);
  else if (activeTool === 'mosaic') applyMosaic(cx, cy);
  else if (activeTool === 'noise') applyNoise(cx, cy);
  else if (activeTool === 'solid') applySolid(cx, cy);
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

/** 矩形：filled=true 画纯色块（填充模式），否则描边 */
function drawRect(ctx, x1, y1, x2, y2, color = drawingColor, width = drawingSize, filled = false) {
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  const w = Math.abs(x2 - x1);
  const h = Math.abs(y2 - y1);
  if (filled) {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
    return;
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.strokeRect(x, y, w, h);
}

/** Shift 正方向约束：矩形 → 正方形、椭圆 → 正圆（边长取 |dx|、|dy| 较大者，保留拖拽方向） */
function constrainSquare(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const s = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: x1 + (dx < 0 ? -s : s), y: y1 + (dy < 0 ? -s : s) };
}

/** 折线：按顶点顺序连线（多点直线 / 多点箭头的主线共用） */
function drawPolyline(ctx, pts, color = drawingColor, width = drawingSize) {
  if (!Array.isArray(pts) || pts.length < 2) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();
}

/** 箭头头部：画在末点、沿「上一顶点 → 末点」方向（单段与多点折线共用，避免两处重复） */
function drawArrowHead(ctx, prevX, prevY, x, y, color = drawingColor, width = drawingSize) {
  const angle = Math.atan2(y - prevY, x - prevX);
  const head = Math.max(10, width * 3);
  const a1 = angle + Math.PI * 0.75;
  const a2 = angle - Math.PI * 0.75;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + head * Math.cos(a1), y + head * Math.sin(a1));
  ctx.moveTo(x, y);
  ctx.lineTo(x + head * Math.cos(a2), y + head * Math.sin(a2));
  ctx.stroke();
}

/** 箭头：直线 + 末端双斜线箭头 */
function drawArrow(ctx, x1, y1, x2, y2, color = drawingColor, width = drawingSize) {
  drawLine(ctx, x1, y1, x2, y2, color, width);
  drawArrowHead(ctx, x1, y1, x2, y2, color, width);
}

/** 椭圆：filled=true 画纯色块（填充模式），否则描边 */
function drawEllipse(ctx, x1, y1, x2, y2, color = drawingColor, width = drawingSize, filled = false) {
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const rx = Math.abs(x2 - x1) / 2;
  const ry = Math.abs(y2 - y1) / 2;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  if (filled) {
    ctx.fillStyle = color;
    ctx.fill();
    return;
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

/**
 * 曲线箭头：从起点向终点画一条二次贝塞尔（控制点垂直偏置，弓形弧度 ∝ 长度），
 * 箭头画在终点、沿终点处切线方向。
 */
function drawCurveArrow(ctx, x1, y1, x2, y2, color = drawingColor, width = drawingSize) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 1) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2 + 0.01, y2);
    ctx.stroke();
    return;
  }
  // 控制点：中点 + 垂直偏置（弓高 ∝ 弧长，方向取向右旋，短箭头自动变微弯）
  const bend = Math.max(0.18 * len, 10);
  const cx = (x1 + x2) / 2 - (dy / len) * bend;
  const cy = (y1 + y2) / 2 + (dx / len) * bend;
  // 终点切线方向 = 贝塞尔 t=1 导数 (2·(P2-P1)) = 2·(x2-cx, y2-cy)
  const tx = x2 - cx;
  const ty = y2 - cy;
  const tl = Math.hypot(tx, ty) || 1;
  const ux = tx / tl;
  const uy = ty / tl;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.quadraticCurveTo(cx, cy, x2, y2);
  ctx.stroke();
  // 箭头：沿切线方向，头宽 ∝ 线宽
  const head = Math.max(10, width * 3);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - head * (ux * 0.7071 - uy * 0.7071), y2 - head * (ux * 0.7071 + uy * 0.7071));
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - head * (ux * 0.7071 + uy * 0.7071), y2 - head * (-ux * 0.7071 + uy * 0.7071));
  ctx.stroke();
}

/**
 * 多点曲线箭头（Shift 模式）：Catmull-Rom 转三次贝塞尔，平滑穿过所有顶点，末端只画一个箭头。
 * 只有两个顶点时退回单段 drawCurveArrow —— 保留原有「弓形弧」手感，不与单次拖拽画出的形态分叉。
 */
function drawPolyCurveArrow(ctx, pts, color = drawingColor, width = drawingSize) {
  if (!Array.isArray(pts) || pts.length < 2) return;
  if (pts.length === 2) {
    drawCurveArrow(ctx, pts[0][0], pts[0][1], pts[1][0], pts[1][1], color, width);
    return;
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    // Catmull-Rom → 贝塞尔控制点（张力 1/6）
    ctx.bezierCurveTo(
      p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
      p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6,
      p2[0], p2[1],
    );
  }
  ctx.stroke();
  const n = pts.length;
  drawArrowHead(ctx, pts[n - 2][0], pts[n - 2][1], pts[n - 1][0], pts[n - 1][1], color, width);
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
    strokes = [];
    curStroke = null;
    hideToolbar();
    drawMask();
    updateSizeInfo(mx, my);
    return;
  }
  state = STATE.SELECTED;
  setSmartHoverMode('active');
  console.error(`[cap] selection done t=${Date.now()} sel=${selX},${selY} ${selW}x${selH} state=SELECTED autoCopy=${captureAutoCopy}`);
  // 截图并复制热键：选区一完成立刻复制并退出，不进工具栏
  if (captureAutoCopy) {
    captureAutoCopy = false;
    const img = cropSelectionWithAnnotations();
    if (img) {
      sendCaptureComplete(img);
      return;
    }
  }
  // 新画一块选区 = 新的落位语境：清掉「用户拖过」的钉住标记，让工具栏按本次选区所在屏落位
  // （否则用户上次把工具栏拖到别块屏后，在这块屏框选时它还钉在上一块屏）。
  toolbarUserMoved = false;
  showToolbar();
  drawMask();
  updateSizeInfo(mx, my);
}

/** 按设置的默认识别动作分发：text / table / smart */
function runDefaultOcrAction() {
  const act = APP_SETTINGS.ocrDefaultAction || 'text';
  if (act === 'table') {
    const t = typeof ocrMenuTable !== 'undefined' ? ocrMenuTable : document.getElementById('ocrMenuTable');
    if (t) t.click();
    return;
  }
  if (act === 'smart') {
    const t = typeof ocrMenuSmart !== 'undefined' ? ocrMenuSmart : document.getElementById('ocrMenuSmart');
    if (t) t.click();
    return;
  }
  if (typeof btnOcr !== 'undefined' && btnOcr) btnOcr.click();
}

/** 智能识别输出按设置去掉 Markdown 标题标记 */
function maybeStripSmartHeadings(md) {
  if (APP_SETTINGS.smartHeadings !== false) return md;
  return String(md || '').replace(/^#{1,6}\s+/gm, '');
}

/**
 * 从「全虚拟物理帧」按每屏 DIP→物理换算 1:1 裁剪（2026-09-25 修混合 DPI 缩放）。
 * ⚠️ 问题：bgCanvas = W×dpr 全局缩放，双屏 125%+150% 时副屏(150%)内容被按 1.25× 绘制 →
 *  副屏区域缩到 0.833×（发虚/尺寸小/底部露出黑缝），跨屏结果图两屏密度不一致。
 * 本函数直接对 bgImage（如 5120×1440 全虚拟物理帧，天然两屏 1:1 物理）逐屏换算取像素拼接：
 *  选区 DIP ∩ 屏 DIP bounds → 换算该屏物理 → 以「全虚拟物理帧坐标」统一放置（跨屏天然连续）。
 * 输出 = 各屏原生物理分辨率，彻底消除副屏发虚/变形。
 * 标注层（drawCanvas/annotCanvas）按每屏窗口段各自比例放大叠加 → 与物理内容对齐
 * （跨屏直线在屏界处因 DPI 突变自然折角 = 物理正确，Snipaste 同此）。
 * @param includeDrawLayer - 是否叠加标注/编辑像素层（保存/复制路径 true，干净裁剪 false）
 */
function cropPhysicalFromVirtualFrame(includeDrawLayer) {
  if (!bgImage || selW < 2 || selH < 2 || !captureVirtualScreen || !capturePhysicalScreen) return null;
  const gd = { x: selX + captureVirtualScreen.x, y: selY + captureVirtualScreen.y, w: selW, h: selH };
  const dpr = canvasDpr;
  const parts = []; // {fx,fy,fw,fh 帧源 / cx,cy,cw,ch 窗口段(drawCanvas backing)}
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const d of captureDisplays) {
    const db = d.bounds, pb = d.physicalBounds;
    // ⚠️ 2026-09-25 修混合 DPI 棋盘格：旧式 (ix - db.x)*sf 把「gd（窗口/主屏 DIP 系，÷主屏
    //   dpr）」与「db.bounds（屏幕 DIP 系，÷各自 sf）」两种坐标系直接相减再乘 sf → 副屏段
    //   fx 算成 527（正确 865）、主屏段 fx=2560 落到画布外 → 主屏内容全透明 = 右侧棋盘格。
    //   修复：gd ×dpr 先换算到桌面物理，与每屏 physicalBounds 在**同一物理系**求交，
    //   帧源段（bgImage=全虚拟物理帧）直接 = 物理坐标 - 帧桌面原点，彻底消除 DIP 系混用。
    const px = gd.x * dpr, py = gd.y * dpr, pw = gd.w * dpr, ph = gd.h * dpr;
    const ixp = Math.max(px, pb.x), iyp = Math.max(py, pb.y);
    const ix2p = Math.min(px + pw, pb.x + pb.width), iy2p = Math.min(py + ph, pb.y + pb.height);
    if (ix2p <= ixp || iy2p <= iyp) continue;
    const fx = Math.round(ixp - capturePhysicalScreen.x);
    const fy = Math.round(iyp - capturePhysicalScreen.y);
    const fw = Math.round(ix2p - ixp);
    const fh = Math.round(iy2p - iyp);
    if (fw < 1 || fh < 1) continue;
    // 窗口段：drawCanvas/annotCanvas backing 与 bgImage 同为全帧物理 1:1 → 坐标直接 = 帧源段
    const cx = fx, cy = fy, cw = fw, ch = fh;
    x0 = Math.min(x0, fx); y0 = Math.min(y0, fy);
    x1 = Math.max(x1, fx + fw); y1 = Math.max(y1, fy + fh);
    parts.push({ fx, fy, fw, fh, cx, cy, cw, ch });
  }
  if (parts.length === 0) return null;
  const outW = x1 - x0, outH = y1 - y0;
  const outCanvas = document.createElement('canvas');
  outCanvas.width = outW;
  outCanvas.height = outH;
  const outCtx = outCanvas.getContext('2d');
  outCtx.imageSmoothingEnabled = false;
  for (const p of parts) {
    outCtx.drawImage(bgImage, p.fx, p.fy, p.fw, p.fh, p.fx - x0, p.fy - y0, p.fw, p.fh);
  }
  if (includeDrawLayer) {
    for (const p of parts) {
      if (p.cw < 1 || p.ch < 1) continue;
      outCtx.drawImage(drawCanvas, p.cx, p.cy, p.cw, p.ch, p.fx - x0, p.fy - y0, p.fw, p.fh);
    }
    if (annotCanvas && annotations.length > 0) {
      for (const p of parts) {
        if (p.cw < 1 || p.ch < 1) continue;
        outCtx.drawImage(annotCanvas, p.cx, p.cy, p.cw, p.ch, p.fx - x0, p.fy - y0, p.fw, p.fh);
      }
    }
  }
  if (SMART_DEBUG) console.error(
    `[cap] crop physical out=${outW}x${outH} parts=${parts.length} dpr=${dpr}`
    + ` vs=(${captureVirtualScreen.x},${captureVirtualScreen.y},${captureVirtualScreen.width}x${captureVirtualScreen.height})`
    + ` ps=(${capturePhysicalScreen.x},${capturePhysicalScreen.y},${capturePhysicalScreen.width}x${capturePhysicalScreen.height})`
    + ` gd=(${gd.x},${gd.y},${gd.w}x${gd.h})`
    + ` sel=(${selX},${selY},${selW}x${selH})`
    + ` displays=${captureDisplays.map((d) => `${d.id}:dip(${d.bounds.x},${d.bounds.y},${d.bounds.width}x${d.bounds.height})sf${d.scaleFactor}phy(${d.physicalBounds ? d.physicalBounds.x : '?'},${d.physicalBounds ? d.physicalBounds.y : '?'},${d.physicalBounds ? d.physicalBounds.width : '?'}x${d.physicalBounds ? d.physicalBounds.height : '?'})p${!!d.primary}`).join(' | ')}`
    + ` parts=${parts.map((p) => `f(${p.fx},${p.fy},${p.fw}x${p.fh})c(${p.cx},${p.cy},${p.cw}x${p.ch})`).join(' | ')}`,
  );
  return outCanvas;
}

function cropSelectionWithAnnotations() {
  if (!bgImage || selW < 2 || selH < 2) return null;
  // 合成背景（单窗全虚拟屏）：走物理 1:1 拼接，根治混合 DPI 副屏发虚
  if (captureVirtualScreen && capturePhysicalScreen && captureDisplays.length > 0) {
    const phys = cropPhysicalFromVirtualFrame(true);
    if (phys) return phys.toDataURL('image/png');
  }
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
  // 合成背景（单窗全虚拟屏）：走物理 1:1 拼接（不含标注层），供识别类取干净像素
  if (captureVirtualScreen && capturePhysicalScreen && captureDisplays.length > 0) {
    const phys = cropPhysicalFromVirtualFrame(false);
    if (phys) return phys;
  }
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
  strokes = [];
  curStroke = null;
  captureDisplays = [];
  captureVirtualScreen = null;
  capturePhysicalScreen = null;

  [bgCanvas, drawCanvas, annotCanvas, tempCanvas].forEach((cv) => {
    cv.width = 0;
    cv.height = 0;
  });
  if (captureMask) captureMask.style.display = 'none';
  if (captureHandles) captureHandles.style.display = 'none';
  if (annotHandles) {
    annotHandles.style.display = 'none';
    annotHandles.classList.remove('is-hover');
  }
  endAnnotResize();
}

// 窗口复用模式下，会话结束（隐藏窗口）前主进程发此信号：清掉画布与全部浮层，只留
// body 那层暗蒙版。不清的话，下次 show 的瞬间会闪出**上一张截图**（页面还在、canvas 上
// 仍是上次的画面）。注意这与 reload 不冲突 —— reload 负责重置 JS 状态，这里负责视觉清空。

// 多窗跨屏拖选（2026-09-24 Snipaste 模型）主进程驱动悬停/拖选在「单窗·全虚拟屏」重构后整体移除，
// 渲染端恢复本地整窗鼠标驱动（智能框/框选/裁剪在单窗内天然成立，无跨屏切窗广播）。

// 多窗跨屏拖选开始广播：每扇窗（含非发起窗）进入主进程驱动的绘制状态
ipcRenderer.on('capture-sel-drag-begin', () => {
  try {
    if (state !== STATE.IDLE) return;
    resetTranslationCache();
    pendingWindowClickRect = null;
    hoverWindowRect = null;
    state = STATE.DRAWING;
    hideToolbar();
    drawMask();
  } catch (_) { /* ignore */ }
});

// 多窗跨屏拖选：主进程轮询驱动（选区为屏幕坐标系，本窗只画交集；w/h 为 0 = 交集为空 = 纯蒙版）
ipcRenderer.on('capture-sel-update', (_e, r) => {
  try {
    if (state !== STATE.DRAWING || !r) return;
    if (r.w >= 1 && r.h >= 1) {
      selX = r.x; selY = r.y; selW = r.w; selH = r.h;
    } else {
      selX = 0; selY = 0; selW = 0; selH = 0;
    }
    console.error(`[cap] sel-update rect=(${selX},${selY}) ${selW}x${selH} W=${W} dpr=${canvasDpr}`);
    drawMask();
    updateSizeInfo(selX, selY);
  } catch (_) { /* ignore */ }
});

ipcRenderer.on('capture-sel-finish', (_e, p) => {
  try {
    if (state !== STATE.DRAWING || !p) return;
    if (!p.confirm) {
      state = STATE.IDLE;
      selX = 0; selY = 0; selW = 0; selH = 0;
      drawMask();
      return;
    }
    const rect = p.rect || { x: 0, y: 0, w: W, h: H };
    const moved = rect.w >= 3 && rect.h >= 3;
    if (!moved && pendingWindowClickRect) {
      // 单击（无拖动）= 选中悬停窗口，与本地路径同款语义
      selectWindowRect(pendingWindowClickRect);
      pendingWindowClickRect = null;
      return;
    }
    pendingWindowClickRect = null;
    startX = rect.x; startY = rect.y;
    finishSelection(rect.x + rect.w, rect.y + rect.h);
    console.error(`[cap] sel-finish OK rect=(${rect.x},${rect.y}) ${rect.w}x${rect.h} -> sel=(${selX},${selY}) ${selW}x${selH}`);
  } catch (_) { /* ignore */ }
});

ipcRenderer.on('capture-clear', () => {
  try {
    releaseCaptureResources();
  } catch (_) { /* 容忍 */ }
  try { document.body.classList.remove('is-longshot', 'is-longshot-edit'); } catch (_) { /* ignore */ }
  void loadAppSettings();

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
  hide(eraserMenu);
  hide(sizeInfo);
  hideSelectBar();

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
  guidesOn = false; // 准线常显属会话内状态，离场即归位
  polyPoints = null; // 未收尾的多点折线同样只属单次会话
  polyLiveIdx = -1;
  strokeStraight = false; // Shift 拉直线标记只属单次会话
  drawGuides();
});

ipcRenderer.on('capture-image', (_e, data) => {
  console.error(
    `[cap] capture-image recv t=${Date.now()} ${data.rawFrame ? `raw=${data.rawFrame.width}x${data.rawFrame.height}` : `bytes=${data.imageBytes ? data.imageBytes.length : 0}`} ` +
      `src=${data.captureSource} external=${data.externalCapture === true} rect=${data.cropRect ? `${data.cropRect.w}x${data.cropRect.h}` : 'none'} ` +
      `visibleWins=${data.visibleWindows ? data.visibleWindows.length : 0} noHover=${CAPTURE_NO_HOVER}`,
  );
  resetTranslationCache();
  scaleFactor = data.scaleFactor || 1;
  captureAutoCopy = data.autoCopy === true;
  smartRectCache = null;
  smartRectCacheKey = '';
  hoverStableRect = null;
  hoverTargetRect = null;
  hoverVisualRect = null;
  lastGoodTarget = null;
  smartLevel = 0;
  smartIpcRect = { window: null, element: null, levels: [] };
  lastDetectX = -9999;
  lastDetectY = -9999;
  toolbarUserMoved = false;
  // 多点折线状态必须先于 setTool 归零：setTool 见到未收尾折线会自动收尾提交，
  // 若沿用上一次会话的残留顶点，就会凭空多出一条折线。
  polyPoints = null;
  polyLiveIdx = -1;
  // 会话级工具复位（2026-09-25 用户要求）：每次打开截图都回到鼠标指针，
  // 不继承上一次会话选中的画笔/高亮/图形等；顺带收起所有二级面板。
  setTool('select');
  closeShapeMenu();
  closePenMenu();
  closeMaskMenu();
  closeEraserMenu();
  closeOcrMenu();
  closeTranslateMenu();
  setSmartHoverMode('idle');
  // 会话级标注复位（2026-09-25 用户反馈：上一张随手画的图形/箭头会残留在下一次截图里）。
  // 位图笔画（strokes + 画布重建）本来就会清，但**矢量对象数组 annotations 必须显式清**——
  // 不清的话 renderAnnots() 会在新会话把它整层重绘回来。历史栈同步归零。
  historyStack.length = 0;
  historyIndex = -1;
  resetAnnots();
  strokes = [];
  curStroke = null;
  strokeStraight = false; // 上一笔若没收尾，别把「Shift 拉直线」标记带进新会话
  guidesOn = false; // 准线常显只属单次会话，新会话默认关闭
  captureDisplays = Array.isArray(data.displays) ? data.displays : [];
  captureVirtualScreen = data.virtualScreen || null;
  capturePhysicalScreen = data.physicalScreen || null;
  smartFrameFromMain = data.framePrepared === true;
  smartFrameSentKey = '';
  sessionOpenedAt = performance.now(); // 会话时钟：开窗后 250ms 内框细化强制走平滑变形（防"框跳变"观感）

  // 种子查询不再在 recv 即发（2026-09-27 改）：recv 时 bgCanvas/W/canvasDpr 还是**上一场会话**
  // 的残留（initCanvases 在 img 解码/rawFrame 上屏后才跑），换屏会话（125%↔150%）sf 错 →
  // 种子查询打到错误物理点 = 「初次识别不准、动一下鼠标才对」。只武装标记，initCanvases
  // 末尾用本会话真实 sf 补发——仍在亮窗前（initCanvases → 2 帧 rAF → capture-ready → reveal）。
  if (data.externalCapture !== true && data.cursor && state === STATE.IDLE) {
    const ex = Math.max(0, Math.min(data.cursor.x, (data.virtualScreen ? data.virtualScreen.width : 4096) - 1));
    const ey = Math.max(0, Math.min(data.cursor.y, (data.virtualScreen ? data.virtualScreen.height : 4096) - 1));
    pendingMouseX = ex;
    pendingMouseY = ey;
    smartSeedPending = true;
  }
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

  // GDI 直抓帧（2026-09-23 阶段二）：主进程跳过 PNG 编码（2560×1440 实测 ~140ms），
  // 渲染端 BGRA→RGBA（u32 位交换）putImageData 上屏，canvas 充当 bgImage。
  // naturalWidth/naturalHeight getter 兼容下游 crop（bgImage.naturalWidth/W）与 drawImage 公式。
  if (data.rawFrame && data.rawFrame.width > 0 && data.rawFrame.height > 0) {
    const t0 = Date.now();
    const { bgra, width, height } = data.rawFrame;
    const src32 = new Uint32Array(bgra.buffer, bgra.byteOffset, bgra.byteLength >> 2);
    const dst = new Uint8ClampedArray(bgra.length);
    const dst32 = new Uint32Array(dst.buffer);
    for (let i = 0; i < src32.length; i++) {
      const px = src32[i];
      // LE u32: BGRA 字节序 0xAARRGGBB → RGBA 字节序 0xAABBGGRR（R/B 位交换，G/A 原位）
      dst32[i] = (px & 0xff00ff00) | ((px & 0x00ff0000) >>> 16) | ((px & 0x000000ff) << 16);
    }
    const cv = document.createElement('canvas');
    cv.width = width;
    cv.height = height;
    cv.getContext('2d').putImageData(new ImageData(dst, width, height), 0, 0);
    Object.defineProperty(cv, 'naturalWidth', { get: () => cv.width });
    Object.defineProperty(cv, 'naturalHeight', { get: () => cv.height });
    console.error(`[cap] raw frame ready t=${Date.now()} ${width}x${height} swap+put=${Date.now() - t0}ms`);
    // 帧抽样探测点（2026-09-25 跨屏部分选区棋盘格排查）：副屏/主屏区各抽样几点 RGBA，
    // 验证帧内容位置与 alpha —— 若主屏区缺失/alpha=0，crop 输出即棋盘格。
    try {
      const cctx = cv.getContext('2d');
      const sample = (x, y) => {
        const d = cctx.getImageData(x, y, 1, 1).data;
        return `${d[0]},${d[1]},${d[2]},a${d[3]}`;
      };
      console.error(
        `[cap] frame sample size=${width}x${height}`
        + ` TL=${sample(0, 0)} TR=${sample(width - 1, 0)} BL=${sample(0, height - 1)} BR=${sample(width - 1, height - 1)}`
        + ` subC=${sample(Math.round(width * 0.25), height >> 1)} priC=${sample(Math.round(width * 0.75), height >> 1)}`,
      );
    } catch (_) { /* ignore */ }
    mountCaptureSurface(cv, 'raw');
    return;
  }

  if (!imageSrc) {
    return;
  }

  const img = new Image();
  img.onload = () => mountCaptureSurface(img, 'png');
  img.onerror = () => {
    if (currentCaptureObjectUrl) {
      URL.revokeObjectURL(currentCaptureObjectUrl);
      currentCaptureObjectUrl = '';
    }
  };
  img.src = imageSrc;

  function mountCaptureSurface(surface, surfaceSrc) {
    bgImage = surface;
    smartFrameSentKey = '';  // 新会话新帧：尺寸可能与上次相同，必须强制重发（DLL 缓存的是旧帧）
    console.error(`[cap] img decode done t=${Date.now()} natural=${surface.naturalWidth}x${surface.naturalHeight} src=${surfaceSrc} W=${W} H=${H}`);
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
    // 兜底：双 rAF 在「屏外驻留（opacity 0）」的窗口上不触发（Chromium 对全遮挡窗暂停合成帧，
    // 实测 ready 永远走本定时器）→ 旧值 120ms 是纯空等，压到 50ms。若亮窗首帧出现旧画面闪回，回退此值。
    setTimeout(sendReady, 50);

    if (isExternal) {
      if (data.cropRect && data.cropRect.w > 0 && data.cropRect.h > 0) {
        selX = Math.max(0, Math.min(data.cropRect.x, W - 1));
        selY = Math.max(0, Math.min(data.cropRect.y, H - 1));
        selW = Math.max(1, Math.min(data.cropRect.w, W - selX));
        selH = Math.max(1, Math.min(data.cropRect.h, H - selY));
      } else {
        selX = 0;
        selY = 0;
        selW = W;
        selH = H;
      }
      state = STATE.SELECTED;
      showToolbar();
      drawMask();
      updateSizeInfo(selX, selY);
    } else if (data.cursor && state === STATE.IDLE) {
      // 打开即智能选中：画布/蒙版已在上方同步初始化完成 → **直接**按光标位置查询开洞。
      // 旧实现套 rAF：屏外驻留窗上 rAF 不触发（合成帧暂停），种子悬停被拖到亮窗之后才跑，
      // 框比蒙版晚一拍出现（2026-09-23 用户反馈）。查询是异步 IPC，回包画框不可见期完成。
      const cx = Math.max(0, Math.min(data.cursor.x, W - 1));
      const cy = Math.max(0, Math.min(data.cursor.y, H - 1));
      // 种子坐标写入调度器缓存：EFP 回包新鲜度守卫以 pendingMouse 为基准，
      // 不写的话（初始 0）种子回包会被判"光标已远离"直接丢弃
      pendingMouseX = cx;
      pendingMouseY = cy;
      try {
        console.error(`[cap] smart-hover seed cursor=(${cx},${cy}) win=${findWindowRectAt(cx, cy) ? 'yes' : 'none'} W=${W}x${H}`);
      } catch (_) { /* ignore */ }
      if (state === STATE.IDLE) handleMouseMove(cx, cy);
    }

    if (currentCaptureObjectUrl) {
      URL.revokeObjectURL(currentCaptureObjectUrl);
      currentCaptureObjectUrl = '';
    }
  }
});

tempCanvas.addEventListener('mousedown', (e) => {
  if (isCaptureBusy()) return;
  // PICKING 状态下忽略额外 mousedown（避免被「再次点击选其他色」截断；只能通过 mouseup 完成）
  if (state === STATE.PICKING) return;
  // 右键 = 步骤撤销 / 中断当前手势（详见 handleRightClick；纯 DOM 层无选区尺寸，故只传事件）
  if (e.button === 2) {
    e.preventDefault();
    handleRightClick();
    return;
  }
  if (e.button !== 0) return;
  pendingTextEdit = null; // 新按下：清掉上一手势的「文字待定」（防跨手势残留误编辑）
  modShiftDown = e.shiftKey; // 以事件自带的修饰键状态为准（自己维护的按键态可能因失焦而失真）
  const _lsPt = lsClientToLogical(e);
  const mx = _lsPt.x;
  const my = _lsPt.y;

  // 多点折线进行中（Shift 模式）：Shift 还按着 → 追加中间点；已松开 → 该点为终点并收尾提交。
  // 放在最前面判断：此时 state 是 ANNOTATING，其它分支都不该抢走这次点击。
  if (polyPoints) {
    const px = Math.max(selX, Math.min(mx, selX + selW));
    const py = Math.max(selY, Math.min(my, selY + selH));
    polyPoints.push([px, py]);
    if (modShiftDown) {
      syncPolyline(px, py);
    } else {
      finishPolyline(polyPoints.slice(), true);
    }
    return;
  }

  // 「活动对象」（待确认形状 / 常显选框的文字）的手柄与本体：点手柄 → 缩放 / 旋转 / 删除，
  // 点本体 → 整体拖动。判定与状态迁移统一在 tryBeginAnnotGesture()，与「文字编辑器中按下」
  // 共用同一份实现（textarea 宽度会盖住右侧手柄，那条入口也要走同一条路）。
  if (tryBeginAnnotGesture(mx, my, e)) return;

  // 选框自己的把手与边框：**任意工具**通用（2026-09-29 用户要求：拉伸图标出现的地方，
  // 操作必须就是拉伸）。顺序在注解手势之后（文字编辑框的手柄优先）、工具分支之前。
  if (state === STATE.SELECTED) {
    const selHandle = hitTestHandle(mx, my);
    if (selHandle) {
      resetTranslationCache();
      state = STATE.RESIZING;
      hoverAnnotIndex = -1;
      endAnnotResize(); // 互斥：清标注缩放状态（RESIZING 分支优先走 annotResizeHandle，
      //                   残留会让拉伸图标下执行错误操作——审计发现的根因）
      resizeHandle = selHandle;
      const anchors = {
        tl: [selX + selW, selY + selH], t: [selX, selY + selH],
        tr: [selX, selY + selH], r: [selX, selY],
        br: [selX, selY], b: [selX, selY],
        bl: [selX + selW, selY], l: [selX + selW, selY],
      };
      resizeAnchorX = anchors[selHandle][0];
      resizeAnchorY = anchors[selHandle][1];
      hideToolbar();
      return;
    }
    if (nearSelectionBorder(mx, my)) {
      state = STATE.MOVING;
      moveOffX = mx - selX;
      moveOffY = my - selY;
      endAnnotResize();
      hideToolbar();
      return;
    }
  }
  // 没被对象手势消费 → 先确认待确认的形状（烘焙进位图），本次点击继续按原流程处理（新框选 / 新绘制）。
  // 橡皮擦例外：它要能直接擦 / Shift 整删，保持原语义（不在这里顺手烘焙）。
  if (state === STATE.SELECTED && activeTool !== 'eraser') commitPendingAnnot();

  if (state === STATE.IDLE) {
    resetTranslationCache();
    // 单击选中 = 用户「看到的」框（所见即所得）：视觉框 hoverVisualRect 由 RAF 驱动，
    // 悬停静止时与 target 收敛一致。勿用 hoverWindowRect —— 它被异步回包（UIA/像素链）
    // 驱动，单击瞬间可能已被更新的小元素回包覆盖（用户看着整屏框、点出来却是小框，
    // 2026-09-25 副屏「识别不了整个屏幕」根因）。视觉框若尚未建立则退 target/窗口框。
    pendingWindowClickRect = hoverVisualRect || hoverTargetRect || hoverWindowRect;
    state = STATE.DRAWING;
    startX = mx;
    startY = my;
    hoverWindowRect = null;
    hideToolbar();
    console.error(`[cap] mousedown -> DRAWING t=${Date.now()} at=${mx},${my} pendingWin=${pendingWindowClickRect ? `${Math.round(pendingWindowClickRect.width)}x${Math.round(pendingWindowClickRect.height)}@${Math.round(pendingWindowClickRect.x)},${Math.round(pendingWindowClickRect.y)}` : 'no'}`);
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

  if (state === STATE.SELECTED && activeTool !== 'select') {
    // 2026-09-29 用户澄清（Snipaste 语义）：整个屏幕都是画布，选框只是导出预览——
    // 绘画/文字不再限制在选框内（选框外画的文字/图形可见但不进成品，导出按选框裁剪）。
    resetTranslationCache();
    // 任意工具：按中已提交文字的手柄 → 缩放/旋转该文字（2026-09-29 用户要求）
    if (activeTool !== 'select' && activeTool !== 'eraser') {
      const th = textAnnotAtBox(mx, my); // 框级初筛：字形级会把框角判成空白 → 新建（用户实测病灶）
      if (process.env.PETALSNAP_SMART_DEBUG === '1') console.error(`[TXT] canvas-down mx,my=${mx},${my} state=${state} boxIdx=${th} editor=${!!textEditor}`);
      if (th >= 0 && annotations[th] && annotations[th].type === 'text') {
        const h = textHandleAt(annotations[th], mx, my);
        if (process.env.PETALSNAP_SMART_DEBUG === '1') console.error(`[TXT] canvas-down handle=${h || 'NONE'}`);
        if (h) {
          if (h === 'del') {
            annotations.splice(th, 1);
            renderAnnots();
            commitHistory(false);
            return;
          }
          resetTranslationCache();
          annotResizeHandle = h;
          annotResizeIndex = th;
          annotResizeBase = cloneAnnots([annotations[th]])[0];
          annotResizeBox = annotBounds(annotations[th]);
          if (h === 'rot') {
            const b0 = annotResizeBox;
            const c = { x: annotations[th].x + b0.w / 2, y: annotations[th].y + b0.h / 2 };
            annotResizeStartAngle = Math.atan2(my - c.y, mx - c.x);
          }
          hoverAnnotIndex = -1;
          state = STATE.RESIZING;
          hideToolbar();
          return;
        }
      }
    }
    // 文字工具单击已有文字 → 继续编辑那一段（Snipaste 语义：确认后的文字仍可点开编辑）
    if (activeTool === 'text') {
      const hitText = textAnnotAtBox(mx, my); // 框级：框体任意处可拖/可编辑，框外才是新建
      if (process.env.PETALSNAP_SMART_DEBUG === '1') console.error(`[TXT] toolclick mx,my=${mx},${my} hit=${hitText} inside=${isInsideSelection(mx, my)}`);
      if (hitText >= 0 && annotations[hitText] && annotations[hitText].type === 'text') {
        // Snipaste 语义：按下文字后**拖动 = 移动**，**原地点击 = 进入编辑**——
        // 这里只记 pending，pointermove 超 4px 转 MOVING（见 move 分支），pointerup 未动才 editTextAnnot。
        pendingTextEdit = { index: hitText, mx, my };
        return;
      }
    }
    if (activeTool === 'eraser') {
      // 橡皮擦（2026-09-25 重做，三种用法）：
      //  ① 框选擦（eraserMode='rect'）：拖一个矩形，松手把该区域整块清除（像素 + 压线的图形对象）；
      //  ② Shift + 点击：整笔 / 整对象一次删除（Snipaste 语义）——先命中矢量对象，再命中位图笔画；
      //  ③ 细擦（默认）：按住拖动做像素级挖空，能擦掉笔迹的一部分。③ 不在这里收尾，
      //     而是继续往下走通用笔迹启动流程（复用 curStroke / preData / 历史那套）。
      if (eraserMode === 'rect') {
        state = STATE.ANNOTATING;
        annotStartX = mx;
        annotStartY = my;
        hideToolbar();
        return;
      }
      if (modShiftDown) {
        const hitAnnot = hitTestAnnot(mx, my);
        if (hitAnnot >= 0) {
          annotations.splice(hitAnnot, 1);
          hoverAnnotIndex = -1;
          renderAnnots();
          return;
        }
        const hitStroke = hitTestStroke(mx, my);
        if (hitStroke >= 0) {
          eraseStroke(hitStroke);
          return;
        }
        return;
      }
    }
    // 对象画完即固定（2026-09-25 用户要求）：绘图工具下点中已有对象不再「顺手拖走」，
    // 只能被本工具的正常绘制语义处理。要移动请切「移动」工具（见上方 select 分支）。
    if (activeTool === 'text') {
      // Snipaste 语义（用户纠正）：点空白 = 确认前一段 **并** 在点击处开新框。
      // openTextEditor 开头会先 commit 旧编辑器，无需特殊处理。
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
    // Shift + 单击（直线/箭头/曲线箭头）→ 进入多点折线模式：第一点落下，不提交
    if (POLY_TOOLS.includes(activeTool) && modShiftDown) {
      resetTranslationCache();
      commitPendingAnnot(); // 开始画新对象 = 确认上一件待确认对象
      startPolyline(mx, my);
      state = STATE.ANNOTATING;
      hideToolbar();
      updateSizeInfo(mx, my);
      updateGuideContent();
      return;
    }
    state = STATE.ANNOTATING;
    annotStartX = mx;
    annotStartY = my;
    penLastX = mx;
    penLastY = my;
    maskStrokePainted = false;
    hideToolbar();
    // 新笔画记录：preData 只读引用「本笔开始时」历史栈顶快照（橡皮擦整笔擦除时恢复用，
    // 零额外拷贝）；preRect = 该快照覆盖的矩形，供 putImageData 定位。
    const topSnap = historyIndex >= 0 ? historyStack[historyIndex] : null;
    curStroke = {
      tool: activeTool,
      color: drawingColor,
      size: drawingSize,
      maskTool: MASK_TOOLS.includes(activeTool) ? activeTool : undefined,
      maskIntensity: MASK_TOOLS.includes(activeTool) ? maskIntensity : undefined,
      maskMode: MASK_TOOLS.includes(activeTool) ? maskMode : undefined,
      clipRect: { x: selX, y: selY, w: selW, h: selH },
      preData: topSnap ? topSnap.data : null,
      preRect: topSnap ? { x: topSnap.x, y: topSnap.y, w: topSnap.w, h: topSnap.h } : { x: selX, y: selY, w: selW, h: selH },
      points: [],
    };
    // 纯色笔刷：开启一次描边缓冲（整笔只按透明度合成一次，避免半透明来回涂叠加变实）
    if (activeTool === 'solid' && maskMode === 'brush') beginSolidStroke();
    // Shift 拉直线：笔刷类工具在按下时就按住 Shift → 本笔锁成直线（拖动期间只预览，松手一次落笔）。
    // 一旦进入直线模式就不因中途松开 Shift 而回退，避免「已画一半又改直」的像素无法收回。
    // 打码类的「矩形模式」本来就是拖矩形，不参与 Shift 拉直线。
    strokeStraight = modShiftDown && BRUSH_CURSOR_TOOLS.has(activeTool)
      && activeTool !== 'eraser'
      && (!MASK_TOOLS.includes(activeTool) || maskMode === 'brush');
    if (activeTool === 'highlight') {
      // 高亮（马克笔）：开一笔缓冲，points 与 curStroke 共享同一数组
      beginHighlightStroke();
      highlightStroke.points = curStroke.points;
      highlightStroke.points.push([mx, my]);
      paintHighlightStroke();
    } else if (activeTool === 'pen' && !strokeStraight) {
      clipToSelection(drawCtx);
      drawLine(drawCtx, penLastX, penLastY, mx, my);
      restoreClip(drawCtx);
    } else if (activeTool === 'eraser') {
      // 细擦起笔：先挖一个圆点（单击不拖动也能擦掉一点），后续由 mousemove 逐段挖
      eraseSegmentAt(mx, my, mx, my);
      curStroke.points.push([mx, my]);
    } else if (MASK_TOOLS.includes(activeTool) && maskMode === 'lasso') {
      // 套索起笔：记第一个顶点；拖动期间由 mousemove 累积顶点并画虚线预览，
      // mouseup 才闭合成多边形整块打码（与「框选」同为一次性应用）
      curStroke.points.push([mx, my]);
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
    // 悬停态兜底：把「指针已离开选框」在这一帧立刻反映到 DOM（去重后几乎零成本）
    syncAnnotHoverIfChanged();
  });
}

function handleMouseMove(mx, my) {
  // 笔刷预览圈：不论在哪个 state，只要光标在选区内 + 工具是 pen/打码系，就跟随显示
  setBrushCursor(mx, my, true);

  if (state === STATE.IDLE) {
    // 检测节流：光标移开一段距离或隔一会儿才重跑像素检测；目标变了交给插值循环「水流」过渡
    const moved = Math.abs(mx - lastDetectX) > 6 || Math.abs(my - lastDetectY) > 6;
    const due = Date.now() - lastDetectAt > 40;
    // 帧速度（几何滞回光环的自适应依据）
    smartMoveSpeed = Math.abs(mx - lastDetectX) + Math.abs(my - lastDetectY);
    if (CAPTURE_NO_HOVER) {
      setHoverTarget(null);
    } else if (moved || due) {
      lastDetectX = mx;
      lastDetectY = my;
      lastDetectAt = Date.now();
      // 只发查询；框由 EFP 回包驱动（唯一驱动者 = 数据永远新鲜且最小）
      getSmartHoverRect(mx, my);
      // 框跟手（2026-09-27 二轮引入，多轮演进）：仅当 UIA 判死（>1s 无权威落笔）才用
      // 新鲜像素链重取——地图优先架构下 UIA 应答 ~0ms 级，移动中每拍都命中真实元素，
      // 像素切块不再在 UIA 应用里画框（"误窗口"根源）；UIA-dead 应用像素仍是唯一主力。
      const ht = hoverTargetRect;
      const insideCur = ht && mx >= ht.x - 6 && my >= ht.y - 6
        && mx <= ht.x + ht.width + 6 && my <= ht.y + ht.height + 6;
      if (!insideCur && Date.now() - lastUiaGoodAt > 1000) {
        const r = pickFollowRectAt(mx, my);
        if (SMART_DEBUG && Date.now() - lastFollowDbg > 500) {
          lastFollowDbg = Date.now();
          console.error(`[SMART-FOLLOW] px=${smartPixelLevels.length} uiaChain=${(smartIpcRect.levels || []).length}`
            + ` pick=${r ? `${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.x)},${Math.round(r.y)}` : 'null'} cur=${mx},${my}`);
        }
        if (r) {
          lastGoodTarget = r;
          setHoverTarget(r, mx, my, { skipGuard: true });
        }
      }
      // 画框诊断（500ms 限频，SMART_DEBUG 门控）：区分「目标没建立(查询/回包问题)」与「框画了但看不见(层序/遮罩)」
      if (SMART_DEBUG && Date.now() - lastHoverDbg > 500) {
        lastHoverDbg = Date.now();
        const h = hoverVisualRect;
        const t = hoverTargetRect;
        console.error(`[HOV-DBG] visual=${h ? `${Math.round(h.width)}x${Math.round(h.height)}@${Math.round(h.x)},${Math.round(h.y)}` : 'null'} target=${t ? `${Math.round(t.width)}x${Math.round(t.height)}@${Math.round(t.x)},${Math.round(t.y)}` : 'null'} lastGood=${lastGoodTarget ? `${Math.round(lastGoodTarget.width)}x${Math.round(lastGoodTarget.height)}` : 'null'}`);
      }
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
    if (dragAnnotIndex !== -1) {
      // 拖动单个矢量对象：对象坐标 = dragBase + 钳制位移，只重画对象层，位图与选区不动
      if (dragBase) moveAnnotByDrag(mx, my);
      // 编辑中的文字不在 annotations 数组里，moveAnnotByDrag 内部已 refreshEditorCanvas
      // 把它画回来；这里再 renderAnnots 会把刚画上去的编辑文字擦掉（只剩光标）。
      // 那条路径不走 renderAnnots，故手工补一次 DOM 选框同步（选框已移到 DOM 层绘制）。
      if (dragAnnotIndex !== EDITING_TARGET) renderAnnots();
      else syncAnnotHandles();
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
    // 拖的是「待确认对象」的缩放手柄（不是选区手柄）：缩放对象本身
    if (annotResizeHandle) {
      scaleActiveAnnot(mx, my);
      updateSizeInfo(mx, my);
      hideMagnifier();
      return;
    }
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
    // 多点折线：已放置顶点 + 光标处橡皮筋，交给对象层实时预览（不走 tempCanvas）
    if (polyPoints) {
      const px = Math.max(selX, Math.min(mx, selX + selW));
      const py = Math.max(selY, Math.min(my, selY + selH));
      syncPolyline(px, py);
      setBrushCursor(mx, my, false);
      updateSizeInfo(mx, my);
      return;
    }
    // Shift 拉直线：整笔锁成「起点 → 当前点」，不落像素，只在 tempCanvas 画一条预览线
    if (strokeStraight) {
      if (activeTool === 'highlight') {
        // 高亮本来就是整笔一次合成（points 变了重画即可），直接走真实路径比预览更准
        if (curStroke) {
          curStroke.points.length = 0;
          curStroke.points.push([annotStartX, annotStartY], [mx, my]);
        }
        if (highlightStroke) paintHighlightStroke();
      } else if (activeTool === 'pen') {
        clipToSelection(tempCtx);
        drawLine(tempCtx, annotStartX, annotStartY, mx, my);
        restoreClip(tempCtx);
        if (curStroke) curStroke.points = [[annotStartX, annotStartY], [mx, my]];
      } else {
        // 打码 / 纯色笔刷：真实效果无法廉价预览，用半透明同宽直线示意落点与粗细
        clipToSelection(tempCtx);
        tempCtx.globalAlpha = 0.45;
        drawLine(tempCtx, annotStartX, annotStartY, mx, my, '#5b8dff', drawingSize);
        tempCtx.globalAlpha = 1;
        restoreClip(tempCtx);
        if (curStroke) curStroke.points = [[annotStartX, annotStartY], [mx, my]];
      }
      setBrushCursor(mx, my, false);
      updateSizeInfo(mx, my);
      return;
    }
    if (activeTool === 'eraser') {
      // 细擦：逐段挖空（圆头线段，天然接续上一段），鼠标停住也能原地擦
      if (eraserMode === 'rect') {
        // 框选擦：拖矩形预览（双色两遍描边，深/浅底色都看得清）
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
        const last = curStroke && curStroke.points.length ? curStroke.points[curStroke.points.length - 1] : [mx, my];
        eraseSegmentAt(last[0], last[1], mx, my);
        if (curStroke) curStroke.points.push([mx, my]);
      }
      // 细擦时**保留**预览圈（圈 = 实际擦除口径），只有「框选擦」是拖矩形才收起圈
      // （2026-09-25 用户反馈「橡皮擦一按下去圈就没了，看不见自己擦多粗」）
      setBrushCursor(mx, my, eraserMode !== 'rect');
      updateSizeInfo(mx, my);
      return;
    }
    if (activeTool === 'pen') {
      clipToSelection(drawCtx);
      drawLine(drawCtx, penLastX, penLastY, mx, my);
      restoreClip(drawCtx);
      if (curStroke) curStroke.points.push([mx, my]);
      penLastX = mx;
      penLastY = my;
    } else if (activeTool === 'highlight') {
      // 高亮：点进缓冲，整笔按统一透明度重合成（不逐段叠加变实）
      if (curStroke) curStroke.points.push([mx, my]);
      if (highlightStroke) paintHighlightStroke();
    } else if (MASK_TOOLS.includes(activeTool) && maskMode === 'brush') {
      // 打码「笔刷」模式：每个 mousemove 立即涂一个点，mouseup 收整笔历史。
      maskStrokePainted = true;
      clipToSelection(drawCtx);
      applyMaskAt(mx, my);
      restoreClip(drawCtx);
      if (curStroke) curStroke.points.push([mx, my]);
    } else if (MASK_TOOLS.includes(activeTool) && maskMode === 'rect') {
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
    } else if (MASK_TOOLS.includes(activeTool) && maskMode === 'lasso') {
      // 打码「套索」：累积顶点（相邻点 <2px 丢弃，避免抖动产生海量顶点），
      // 实时画虚线多边形预览；末段连到当前光标，松手才闭合结算
      const pts = curStroke ? curStroke.points : null;
      if (pts) {
        const last = pts[pts.length - 1];
        if (!last || Math.hypot(mx - last[0], my - last[1]) >= 2) pts.push([mx, my]);
        drawLassoPreview(pts, mx, my);
      }
    } else {
      // Shift 正方向约束（矩形→正方形 / 椭圆→正圆）：预览与提交用同一个换算，所见即所得
      let ex = mx; let ey = my;
      if (modShiftDown && (activeTool === 'rect' || activeTool === 'ellipse')) {
        const q = constrainSquare(annotStartX, annotStartY, mx, my);
        ex = q.x; ey = q.y;
      }
      clipToSelection(tempCtx);
      if (activeTool === 'line') {
        drawLine(tempCtx, annotStartX, annotStartY, ex, ey);
      } else if (activeTool === 'rect') {
        // 填充模式：预览直接画纯色块（与提交后的对象表现一致）
        drawRect(tempCtx, annotStartX, annotStartY, ex, ey, drawingColor, drawingSize, shapeFill);
      } else if (activeTool === 'arrow') {
        drawArrow(tempCtx, annotStartX, annotStartY, ex, ey);
      } else if (activeTool === 'curve') {
        drawCurveArrow(tempCtx, annotStartX, annotStartY, ex, ey);
      } else if (activeTool === 'ellipse') {
        drawEllipse(tempCtx, annotStartX, annotStartY, ex, ey, drawingColor, drawingSize, shapeFill);
      }
      restoreClip(tempCtx);
    }
    updateSizeInfo(mx, my);
    return;
  }

  if (state === STATE.SELECTED && activeTool === 'select') {
    // 待确认对象的缩放手柄优先（它就压在对象框线上，比选区手柄更精确）
    const aHandle = annotations.length ? annotHandleAt(mx, my) : '';
    if (aHandle) {
      // 不清 hoverAnnotIndex：指针压在把手上仍属于「悬停在该对象上」，清掉会让指引板
      // 在「移动对象 / 移动选区」之间闪，也让 .is-hover 状态无谓重算。
      // 但这里必须主动刷一次选框：命中把手是「在框上」的最早时机，若直接早退，
      // 指针从角上进入框内时会「光标已变缩放、手柄却还没出现」（2026-09-26 实测）。
      syncAnnotHandles();
      document.body.style.cursor = HANDLE_CURSOR[aHandle] || 'crosshair';
      updateSizeInfo(mx, my);
      return;
    }
    const handle = hitTestHandle(mx, my);
    // 悬停待确认对象 → 画选中框（提示可直接拖动）；命中按选框判定，细线也能在框内任意处拖
    // 文字「按下待定」：移动超 4px = 转拖动（Snipaste 语义，2026-09-29 用户要求边框可拖动）
    if (pendingTextEdit) {
      const dx = mx - pendingTextEdit.mx, dy = my - pendingTextEdit.my;
      if (dx * dx + dy * dy > 16) {
        if (process.env.PETALSNAP_SMART_DEBUG === '1') console.error(`[TXT] pending->move idx=${pendingTextEdit.index} dx=${dx} dy=${dy}`);
        resizeHandle = null; // 互斥
        const base = cloneAnnots([annotations[pendingTextEdit.index]])[0];
        dragAnnotIndex = pendingTextEdit.index;
        dragBase = base;
        dragStartX = pendingTextEdit.mx;
        dragStartY = pendingTextEdit.my;
        hoverAnnotIndex = -1;
        pendingTextEdit = null;
        state = STATE.MOVING;
        hideToolbar();
      }
    }
    const hoverHit = (!handle && isInsideSelection(mx, my)) ? annotBodyHit(mx, my) : -1;
    if (hoverHit !== hoverAnnotIndex) {
      hoverAnnotIndex = hoverHit;
      renderAnnots();
    }
    if (handle) {
      document.body.style.cursor = HANDLE_CURSOR[handle] || 'crosshair';
    } else if (hoverAnnotIndex >= 0) {
      document.body.style.cursor = 'move';
    } else if (isInsideSelection(mx, my)) {
      document.body.style.cursor = 'move';
    } else {
      document.body.style.cursor = 'crosshair';
    }
    updateSizeInfo(mx, my);
    return;
  }

  if (state === STATE.SELECTED && activeTool !== 'select') {
    // 待确认对象：手柄优先（拉大小），其次本体（整体拖动）——用绘图工具时同样生效，
    // 否则「框还在却拖不动」只能靠切回移动工具（2026-09-25 用户反馈）。
    // 选框把手/边光标优先于注解手柄（与 pointerdown 优先级一致：外层容器把手最高）
    const selHandleCur = hitTestHandle(mx, my);
    if (selHandleCur) {
      document.body.style.cursor = HANDLE_CURSOR[selHandleCur] || 'default';
      updateSizeInfo(mx, my);
      return;
    }
    if (nearSelectionBorder(mx, my)) {
      document.body.style.cursor = 'move';
    } else if ((annotations.length || textEditor) && activeTool !== 'eraser') {
      // textEditor 非空 = 编辑中：editingTextAnnot 走 activeHandleObj 通道，
      // 手柄/框体光标与已提交对象同权（2026-09-29 用户反馈编辑中无任何光标反馈）
      const aHandle = annotHandleAt(mx, my);
      if (aHandle) {
        // 命中把手即「在框上」的最早时机，必须主动刷一次选框：否则指针从角上进入框内时
        // 会「光标已变缩放、手柄却还没出现」（2026-09-26 实测，与 select 分支同因）。
        syncAnnotHandles();
        setBrushCursor(mx, my, false);
        document.body.style.cursor = HANDLE_CURSOR[aHandle] || 'default';
        updateSizeInfo(mx, my);
        return;
      }
      // 文字「按下待定」→ 移动超 4px = 转拖动（2026-09-29 自测 FAIL 修复：这段原来
      // 只写在 select 工具分支里，文字工具下拖动已提交文字永远不生效）
      if (pendingTextEdit) {
        const dx = mx - pendingTextEdit.mx, dy = my - pendingTextEdit.my;
        if (dx * dx + dy * dy > 16) {
          resizeHandle = null; // 互斥
          dragAnnotIndex = pendingTextEdit.index;
          dragBase = cloneAnnots([annotations[pendingTextEdit.index]])[0];
          dragStartX = pendingTextEdit.mx;
          dragStartY = pendingTextEdit.my;
          hoverAnnotIndex = -1;
          pendingTextEdit = null;
          state = STATE.MOVING;
          hideToolbar();
        }
      }
      let pendHit = annotBodyHit(mx, my);
      // 任意工具：悬停已提交文字 → 手柄拉伸/旋转/删除光标（2026-09-29 用户要求：
      // 「选择其他工具的时候也能进行这些」——不再只有移动一种交互）
      if (activeTool !== 'select' && activeTool !== 'eraser') {
        const th = textAnnotAtBox(mx, my); // 框级初筛（与 pointerdown 同源：图标=操作）
        if (th >= 0 && annotations[th] && annotations[th].type === 'text') {
          const h = textHandleAt(annotations[th], mx, my);
          if (process.env.PETALSNAP_SMART_DEBUG === '1' && h) console.error(`[TXT] cursor-set mx,my=${mx},${my} handle=${h} state=${state}`);
          if (h) {
            syncAnnotHandles();
            setBrushCursor(mx, my, false);
            document.body.style.cursor = HANDLE_CURSOR[h] || 'default';
            updateSizeInfo(mx, my);
            return;
          }
          pendHit = (activeTool === 'text') ? th : -1; // 文字工具本体=移动；其他工具本体=继续绘制
        }
      }
      if (pendHit !== hoverAnnotIndex) {
        hoverAnnotIndex = pendHit;
        renderAnnots();
      }
      if (pendHit >= 0) {
        // 框内任意处 = 整体拖动：四向移动光标 + 收起笔刷圈（提示"这一下不会画出新东西"）
        setBrushCursor(mx, my, false);
        document.body.style.cursor = 'move';
        updateSizeInfo(mx, my);
        return;
      }
    }
    // 非移动工具：默认不画对象悬停框（2026-09-25 用户反馈「每一步操作都是一个选框」）。
    // 对象画完即固定、不可被误拖；仅橡皮擦例外 —— 命中对象/笔画时画虚线框，提示「这一笔会被擦掉」。
    let hoverHit = -1;
    let sHit = -1;
    if (activeTool === 'eraser' && isInsideSelection(mx, my)) {
      hoverHit = hitTestAnnot(mx, my);
      if (hoverHit < 0) sHit = hitTestStroke(mx, my);
    }
    if (hoverHit !== hoverAnnotIndex || sHit !== hoverStrokeIndex) {
      hoverAnnotIndex = hoverHit;
      hoverStrokeIndex = sHit;
      renderAnnots();
    }
    if (hoverAnnotIndex >= 0 || hoverStrokeIndex >= 0) {
      // 命中对象/笔画：隐藏笔刷预览圈（擦除优先），光标用普通箭头
      setBrushCursor(mx, my, false);
      document.body.style.cursor = 'default';
    } else {
      // 选框把手（任意工具）→ 拉伸光标；边框其余段 → 移动光标（Snipaste 语义）
      const selHandle = hitTestHandle(mx, my);
      if (selHandle) document.body.style.cursor = HANDLE_CURSOR[selHandle] || 'default';
      else if (nearSelectionBorder(mx, my)) document.body.style.cursor = 'move';
      else document.body.style.cursor = 'crosshair';
    }
    updateSizeInfo(mx, my);
    return;
  }

  updateSizeInfo(mx, my);
}

tempCanvas.addEventListener('mousemove', (e) => {
  modShiftDown = e.shiftKey; // scheduleMouseMove 只带坐标，修饰键状态必须在这里先落地
  const _lsPtMv = lsClientToLogical(e);
  scheduleMouseMove(_lsPtMv.x, _lsPtMv.y);
});

// 多点折线：双击左键收尾（除「松开 Shift 单击」外的第二个习惯入口）
tempCanvas.addEventListener('dblclick', (e) => {
  if (!polyPoints) return;
  e.preventDefault();
  finishPolyline(polyPoints.slice(), true);
});

/**
 * Shift+滚轮快速调整笔刷粗细 / 图形线宽（共用同一个 drawingSize，与工具栏「粗细」滑块双向同步；
 * 打码的效果参数在二级面板里调）。
 * 2026-09-25 由 Alt+滚轮 改为 Shift+滚轮 —— Alt 已让位给「Alt 点击切换准线」，避免同一修饰键两用。
 */
tempCanvas.addEventListener('wheel', (e) => {
  // IDLE：滚轮改层级（对齐 Shotera）
  // 上滑（deltaY<0）→ 层级变大；下滑 → 变小
  if (state === STATE.IDLE) {
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1 : -1;
    cycleSmartLevel(dir);
    return;
  }
  if (!e.shiftKey || state !== STATE.SELECTED) return;
  if (!SIZE_WHEEL_TOOLS.has(activeTool)) return;
  e.preventDefault();
  e.stopPropagation();
  // 滚轮 dy 1~2 微调；同时按住 Ctrl 步进大（原 Shift 大步进已让给 Shift 本体）
  const step = e.ctrlKey ? 5 : 1;
  const delta = -Math.sign(e.deltaY) * step;
  setDrawingSize(drawingSize + delta);
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
    renderAnnots(); // 手势收尾立刻重刷：手柄层与文字实际框最终对齐（单一图层）
    // 拖动/缩放**待确认形状**结束：**不产生历史** —— 它还是「待确认」矢量对象，
    // 等确认（烘焙）那一刻压一次位图快照，于是 Ctrl+Z 一步撤销「整个对象（含确认前的所有调整）」。
    // 但**持久对象（文字）永不烘焙**：它拖/缩/转后必须在这里收一步，否则下一次 Ctrl+Z 会退回
    // 「这段文字出现之前」的那一步 —— 表现就是「整段文字消失」（同 2026-09-26 那个已知 bug 同源）。
    const gIdx = dragAnnotIndex !== -1 ? dragAnnotIndex : annotResizeIndex;
    const gBase = dragAnnotIndex !== -1 ? dragBase : annotResizeBase;
    if (gIdx >= 0 && gBase && isPersistentAnnot(annotations[gIdx])
      && annotGeomSig(annotations[gIdx]) !== annotGeomSig(gBase)) {
      commitHistory(false);
    }
    if (dragAnnotIndex !== -1) {
      dragAnnotIndex = -1;
      dragBase = null;
    }
    endAnnotResize();
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
      applyDrawingColor(color, true);
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
    // 多点折线：单击只落点，收尾交给「松开 Shift 单击 / 双击」，这里绝不提交
    if (polyPoints) return;
    clearTemp();
    // Shift 拉直线收尾：拖动期间只预览，这里一次性把「起点 → 终点」真实落笔，
    // 之后交给下面各工具原有的收尾分支（推入 strokes + 压历史）——不重复造流程。
    if (strokeStraight) {
      strokeStraight = false;
      const ax = annotStartX;
      const ay = annotStartY;
      if (activeTool === 'pen') {
        clipToSelection(drawCtx);
        drawLine(drawCtx, ax, ay, mx, my);
        restoreClip(drawCtx);
        if (curStroke) curStroke.points = [[ax, ay], [mx, my]];
      } else if (activeTool === 'highlight') {
        if (curStroke) {
          curStroke.points.length = 0;
          curStroke.points.push([ax, ay], [mx, my]);
        }
        if (highlightStroke) paintHighlightStroke();
      } else if (MASK_TOOLS.includes(activeTool) && maskMode === 'brush') {
        // 打码 / 纯色笔刷：沿直线等距采样后逐点应用（与自由涂抹同一套像素逻辑）
        maskStrokePainted = true;
        const dist = Math.hypot(mx - ax, my - ay);
        const n = Math.max(1, Math.ceil(dist / Math.max(2, drawingSize / 3)));
        const pts = [];
        clipToSelection(drawCtx);
        for (let i = 0; i <= n; i++) {
          const px = ax + (mx - ax) * (i / n);
          const py = ay + (my - ay) * (i / n);
          applyMaskAt(px, py);
          pts.push([px, py]);
        }
        restoreClip(drawCtx);
        if (curStroke) curStroke.points = pts;
      }
    }
    if (activeTool === 'eraser' && eraserMode === 'rect') {
      // 框选擦：整块清除（像素 + 压线的矢量对象），有拖动才生效
      const rx = Math.min(annotStartX, mx);
      const ry = Math.min(annotStartY, my);
      const rw = Math.abs(mx - annotStartX);
      const rh = Math.abs(my - annotStartY);
      if (rw >= 1 || rh >= 1) {
        drawCtx.save();
        drawCtx.globalCompositeOperation = 'destination-out';
        drawCtx.fillStyle = '#000';
        drawCtx.fillRect(rx, ry, rw, rh);
        drawCtx.restore();
        // 压线（与擦除框相交）的矢量对象：形状部分擦除无法表达 → 整删（唯一一致的语义）；
        // 文字是永久矢量 → 把擦除框记进它的局部系（视觉上挖掉一块，之后点它即恢复完整样式）
        const kept = [];
        let annotChanged = false;
        for (const a of annotations) {
          const b = annotWorldBounds(a);
          const hit = !!b && rectsOverlap(b.x, b.y, b.w, b.h, rx, ry, rw, rh);
          if (!hit) { kept.push(a); continue; }
          if (a.type === 'text') {
            // 擦除框（与文字相交的那块）→ 文字局部系：四角各自反旋，取轴的 AABB
            const l0 = annotToLocal(a, rx, ry);
            const l1 = annotToLocal(a, rx + rw, ry + rh);
            const lx = Math.min(l0.x, l1.x) - a.x;
            const ly = Math.min(l0.y, l1.y) - a.y;
            const lw = Math.abs(l1.x - l0.x);
            const lh = Math.abs(l1.y - l0.y);
            a.eraseStrokes = a.eraseStrokes || [];
            a.eraseStrokes.push({ kind: 'rect', points: [lx, ly, lw, lh] });
            annotChanged = true;
            kept.push(a);
            continue;
          }
          annotChanged = true;
        }
        if (annotChanged) {
          annotations = kept;
          renderAnnots();
        }
        commitHistory(true);
      }
    } else if (SHAPE_TOOLS.includes(activeTool)) {
      // 图形工具（直线/矩形/箭头/曲线箭头/椭圆）→ 矢量对象：存入对象层（可被 MOVE 拖动/undo），
      // 不再直接写进 drawCanvas 位图。像素由 renderAnnots() 统一画到 annotCanvas。
      let ex = mx; let ey = my;
      if (modShiftDown && (activeTool === 'rect' || activeTool === 'ellipse')) {
        const q = constrainSquare(annotStartX, annotStartY, mx, my);
        ex = q.x; ey = q.y;
      }
      const half = Math.abs(ex - annotStartX) >= 0.5 || Math.abs(ey - annotStartY) >= 0.5;
      if (half) {
        annotations.push({
          type: 'shape',
          shape: activeTool,
          x1: annotStartX,
          y1: annotStartY,
          x2: ex,
          y2: ey,
          color: drawingColor,
          size: drawingSize,
          // 填充模式只对矩形/椭圆有意义（直线/箭头/曲线无内部面积）
          fill: shapeFill && (activeTool === 'rect' || activeTool === 'ellipse'),
        });
        renderAnnots();
        // 留在对象层「待确认」：点别处 / 切工具 / Enter 时才烘焙进位图（一步撤销整个对象）
      }
    } else if (MASK_TOOLS.includes(activeTool) && maskMode === 'rect') {
      // 打码「框选」：整块应用一次（位图操作，直接改 drawCanvas 像素）
      clipToSelection(drawCtx);
      applyMaskRect(annotStartX, annotStartY, mx, my);
      restoreClip(drawCtx);
      if (curStroke && (Math.abs(mx - annotStartX) >= 0.5 || Math.abs(my - annotStartY) >= 0.5)) {
        curStroke.rect = { x1: annotStartX, y1: annotStartY, x2: mx, y2: my };
        strokes.push(curStroke);
      }
      curStroke = null;
      commitHistory(true);
    } else if (MASK_TOOLS.includes(activeTool) && maskMode === 'lasso') {
      // 打码「套索」：轨迹不足 3 点（只是单击/抖动）视为无效，不做任何改动；
      // 否则闭合成多边形整块打码，并把顶点收进笔画记录（撤销/重放用）
      const pts = curStroke ? curStroke.points : [];
      if (pts.length >= 3) {
        applyMaskInPath(pts);
        strokes.push(curStroke);
        commitHistory(true);
      }
      curStroke = null;
    } else if (activeTool === 'pen') {
      // 画笔笔迹：mousemove 已实时画线，mouseup 收尾入笔画记录并压一次位图快照
      if (curStroke) strokes.push(curStroke);
      curStroke = null;
      commitHistory(true);
    } else if (activeTool === 'highlight') {
      // 高亮整笔收尾：入笔画记录（橡皮擦可整笔擦除），关闭单笔缓冲
      if (curStroke) strokes.push(curStroke);
      curStroke = null;
      endHighlightStroke();
      commitHistory(true);
    } else if (activeTool === 'eraser') {
      // 细擦整笔收尾：像素在 mousemove 已挖好；这里再把被本笔扫到的矢量对象一并吃掉
      //（细擦只作用于位图，矢量对象在 annotCanvas 上——必须显式判定，否则「擦不掉直线」），
      // 最后收一笔记录 + 压一次快照（一步撤销整合这次擦除）。
      if (curStroke) {
        eraseAnnotsAlongPath(curStroke.points, Math.max(1, curStroke.size));
        strokes.push(curStroke);
      }
      curStroke = null;
      commitHistory(true);
    } else if (MASK_TOOLS.includes(activeTool) && maskStrokePainted) {
      // 打码「笔刷」涂抹整笔：像素在 mousemove 已实时落在 drawCanvas，
      // 这里收一次位图快照 → 一步撤销一整笔（曾漏收：笔迹既不能撤销，
      // 后续任何 restoreHistoryTop（如文字编辑/翻译切换）还会把它整笔抹掉）。
      if (curStroke) strokes.push(curStroke);
      curStroke = null;
      commitHistory(true);
    } else {
      // 兜底：纯色/打码笔刷原地单击没落像素 → 丢弃空笔画记录
      curStroke = null;
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
 * 重新编辑一段已有的文字对象（Snipaste 语义：确认后的文字仍然可点开继续编辑）。
 * 入口两个：文字工具下**单击**已有文字、任意工具下**双击**已有文字。
 * 把这段文字**自己**的字号/颜色/加粗/斜体/字体恢复进工具栏，再开编辑器并把文字灌回去；
 * 原对象先摘出数组（编辑期间由 editingTextAnnot 临时接管），提交时按新样式写回。
 * 若它带着橡皮擦留下的擦除笔迹，这里顺手清掉 —— 「再点一下就变回擦除前的完整样式」。
 */
function editTextAnnot(hit) {
  const a = annotations[hit];
  if (!a || a.type !== 'text' || a.editing) return;
  if (textEditor) commitTextEditor();
  if (textEditor) return; // 上一段文字提交后仍处于编辑态（不该发生）→ 不冒险再开一个

  // 先按原字号恢复工具栏粗细/颜色（编辑器字体取自当前工具栏状态）
  const restoredSize = Math.max(1, Math.min(60, Math.round((a.fontSize - 12) / 3)));
  drawingSize = restoredSize;
  if (sizeSlider) sizeSlider.value = String(restoredSize);
  if (sizeValue) sizeValue.textContent = `${restoredSize}px`;
  applyDrawingColor(a.color, false);
  textBold = a.bold === true;
  textItalic = a.italic === true;
  if (a.fontFamily) textFamily = a.fontFamily;
  syncTextStyleUI();
  syncTextStyleRowVisibility();
  // 编辑即恢复完整样式：清掉擦除笔迹 —— 「再点一下就变回没被擦过的样子」（Snipaste 语义）
  a.eraseStrokes = [];

  const lineHeightPx = Math.max(1, Math.round(a.fontSize * a.lineHeight));
  // 点击点 = 首行中线 → textAnchorY 正好回到 a.y；rot 与枢轴偏移一并带进编辑器
  //（转着编辑时枢轴保持不动点，打字/折行都不会让整段游走）
  const pv = pivotOffset(a);
  openTextEditor(a.x, a.y + lineHeightPx / 2, a.rot || 0, pv);
  if (!textEditor) return;
  annotations.splice(hit, 1); // 摘除原对象：编辑期间由 editingTextAnnot 临时接管
  // 字号/折行宽度走 override（2026-09-29 用户反馈"从别处点回来框会变化"根因）：
  // 原实现从滑块反推字号（(fs-12)/3 有舍入损失）再重算折行 → 重新编辑时字号/折行都漂移。
  // override 通道让 layoutEditorText 用原始值，框纹丝不动；滑块仅作近似显示。
  editorFontOverride = a.fontSize;
  editorWidthOverride = a.maxWidth;
  textEditor.value = a.text;
  refreshEditorCanvas();
  startCaretBlink();
}

tempCanvas.addEventListener('dblclick', (e) => {
  if (isCaptureBusy() || state !== STATE.SELECTED) return;
  if (e.button !== 0) return;
  const _lsPt = lsClientToLogical(e);
  const mx = _lsPt.x;
  const my = _lsPt.y;
  if (!isInsideSelection(mx, my)) return;
  const hit = hitTestAnnot(mx, my);
  if (hit < 0) return;
  editTextAnnot(hit);
});

Array.from(document.querySelectorAll('button.tool')).forEach((btn) => {
  if (btn === shapeBtn || btn === maskBtn || btn === penBtn || btn === eraserBtn) return; // 复合按钮行为单独处理（见下方绑定）
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

if (penBtn) {
  penBtn.addEventListener('click', () => {
    if (isCaptureBusy() || state !== STATE.SELECTED) {
      closePenMenu();
      return;
    }
    if (activeTool === penTool) {
      // 已在使用当前画笔：再次点击 → 弹出面板在画笔/高亮间切换
      togglePenMenu();
      return;
    }
    // 未激活：直接用当前默认画笔（画笔或高亮）开始画
    setTool(penTool);
  });
}

if (penMenu) {
  penItems.forEach((item) => {
    item.addEventListener('click', () => {
      if (isCaptureBusy() || state !== STATE.SELECTED) return;
      setPenTool(item.dataset.pen || 'pen');
      closePenMenu();
    });
  });
}

if (eraserBtn) {
  eraserBtn.addEventListener('click', () => {
    if (isCaptureBusy() || state !== STATE.SELECTED) {
      closeEraserMenu();
      return;
    }
    if (activeTool === 'eraser') {
      // 已激活：再次点击 → 弹出面板在「细擦 / 框选擦」间切换
      toggleEraserMenu();
      return;
    }
    setTool('eraser');
  });
}

if (eraserMenu) {
  eraserModeBtns.forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const next = btn.dataset.eraserMode;
      if (!next) return;
      setEraserMode(next);
      // 切换后保持菜单打开，方便连着切；Esc 或点外部才关闭
    });
  });
  syncEraserMenuItems();
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
  // 描边 / 填充：切换后保持面板打开（空间上就在同一面板里，方便连着选）
  shapeFillBtns.forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (btn.disabled) return;
      setShapeFill(btn.dataset.shapeFill === 'fill');
    });
  });
  syncShapeFillUI();
}

// 点击菜单/输入浮层以外的任意位置（画布 / 工具栏其它按钮）都先收起浮层；
// 捕获阶段执行，保证后续按钮/画布逻辑按“浮层已关闭”的状态处理。
// 编辑态拖框：移动超 4px = textAnchor 跟随指针（整框平移），松开结束
document.addEventListener('mousemove', (e) => {
  if (!editorDragPending || !textEditor || state !== STATE.SELECTED) return;
  const dx = e.clientX - editorDragPending.startX;
  const dy = e.clientY - editorDragPending.startY;
  if (!editorDragPending.active && dx * dx + dy * dy <= 16) return;
  if (!editorDragPending.active && process.env.PETALSNAP_SMART_DEBUG === '1') console.error(`[TXT] framedrag activate dx=${dx} dy=${dy} state=${state}`);
  editorDragPending.active = true;
  textAnchorX = Math.round(editorDragPending.anchorX + dx);
  textAnchorY = Math.round(editorDragPending.anchorY + dy);
  if (editingTextAnnot) {
    editingTextAnnot.x = textAnchorX;
    editingTextAnnot.y = textAnchorY;
  }
  refreshEditorCanvas();
}, true);
document.addEventListener('mouseup', (e) => {
  if (editorDragPending && editorDragPending.active) {
    e.preventDefault(); // 拖完松手：不再把这次松开当"点击放光标"（避免光标跳到点击处）
    try { e.stopPropagation(); } catch (_) { /* ignore */ }
  }
  editorDragPending = null;
}, true);

document.addEventListener('mouseup', (e) => {
  // 文字「按下待定」收尾：没拖动（原地点击）→ 进入编辑（Snipaste 语义）
  if (pendingTextEdit && state !== STATE.MOVING) {
    const pe = pendingTextEdit;
    pendingTextEdit = null;
    if (activeTool === 'text' && annotations[pe.index] && annotations[pe.index].type === 'text') {
      if (process.env.PETALSNAP_SMART_DEBUG === '1') console.error(`[TXT] pending->edit idx=${pe.index}`);
      editTextAnnot(pe.index);
    }
  }
});

document.addEventListener('mousedown', (e) => {
  if (isShapeMenuOpen() && !shapeMenu.contains(e.target) && !shapeBtn.contains(e.target)) {
    closeShapeMenu();
  }
  if (isPenMenuOpen() && !penMenu.contains(e.target) && !penBtn.contains(e.target)) {
    closePenMenu();
  }
  if (isEraserMenuOpen() && !eraserMenu.contains(e.target) && !eraserBtn.contains(e.target)) {
    closeEraserMenu();
  }
  // 统一工具面板不参与「点外部收起」：它是绘制工具的常驻参数面板（颜色/强度要边画边调），
  // 显隐完全跟随 activeTool（setTool → syncToolPanel）；再点工具按钮可手动收起
  // 翻译语言二级面板：点击面板与按钮以外区域即收起
  if (isTranslateMenuOpen() && !translateMenu.contains(e.target) && !btnTranslate.contains(e.target)) {
    closeTranslateMenu();
  }
  if (textEditor && !textEditor.contains(e.target)) {
    const t = e.target;
    const exempt = t === colorPicker || t === sizeSlider
      || (colorPalette && colorPalette.contains(t))
      || (textStyleRow && textStyleRow.contains(t));
    if (!exempt) {
      if (process.env.PETALSNAP_SMART_DEBUG === '1') console.error(`[TXT] blank-commit at ${e.clientX},${e.clientY} target=${e.target && e.target.id}`);
      commitTextEditor();
    }
  }
  // 悬停态兜底：点一下别处（可能没产生 pointermove，例如点完就停），选框的显隐要当场跟着变。
  // 先把指针坐标对齐到这次按下，再判 —— 否则判的是「上一次移动」的旧位置（2026-09-26 用户反馈
  // 「点了周围地方，边框要等一会儿才消失」）。
  if (typeof e.clientX === 'number') {
    pendingMouseX = e.clientX;
    pendingMouseY = e.clientY;
  }
  syncAnnotHoverIfChanged();
}, true);

/**
 * 工具栏「功能 / 导出」按钮 = 确认待确认对象（Snipaste 式延迟烘焙收尾）：
 * 保存 / 复制 / 贴图 / OCR / 翻译 / 长截图 / 录屏 / 二维码 / 取消 之前先把对象烘焙进位图，
 * 这样导出结果里它是普通像素、撤销栈也只多一步「整个对象」。
 * 排除「继续编辑这个对象」的控件：颜色、粗细、工具按钮、撤销/重做（各有更精确的语义）。
 */
document.addEventListener('mousedown', (e) => {
  if (!annotations.length || state !== STATE.SELECTED) return;
  const el = e.target instanceof Element ? e.target : null;
  if (!el || !el.closest('#toolbar')) return;
  if (el.closest('#colorPicker, #colorPalette, .capture-toolbar-style, #btnUndo, #btnRedo, button.tool')) return;
  commitPendingAnnot();
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

/* ── 常驻色板（Snipaste 式 10×2）：点一下即换色，省掉每次都开系统取色对话框。
   上排 = 高对比常用色，下排 = 同色相的深色/柔和色；自定义色仍走左侧原生取色器。 ── */
const PALETTE_COLORS = [
  '#000000', '#3d4451', '#e5484d', '#f76808', '#f5a524',
  '#ffd400', '#30a46c', '#0091ff', '#8e4ec6', '#ffffff',
  '#7f1d1d', '#9a3412', '#854d0e', '#166534', '#075985',
  '#4c1d95', '#ec4899', '#14b8a6', '#8b5e34', '#e2e8f0',
];

/** 色板选中态：与当前绘制色同色的格子加环（十六进制忽略大小写） */
function syncPaletteActive() {
  if (!colorPalette) return;
  const cur = String(drawingColor || '').toLowerCase();
  colorPalette.querySelectorAll('.capture-swatch').forEach((el) => {
    el.classList.toggle('is-active', el.dataset.color === cur);
  });
}

/**
 * 统一写入当前绘制色：工具栏取色器 / 色板选中态 / 文字编辑实时上色 三处一起同步。
 * @param color 十六进制色
 * @param userPicked true = 用户手动选色（切高亮时不再强制回黄）
 */
function applyDrawingColor(color, userPicked) {
  if (!color) return;
  drawingColor = color;
  if (colorPicker) colorPicker.value = color;
  if (userPicked) colorPickedByUser = true;
  syncPaletteActive();
  // 文字编辑中换色：画布上的字实时变色（字符是我们自己画的，直接重绘即可）
  if (textEditor) refreshEditorCanvas();
  // 「待确认」的形状（选框还在）换色：直接改对象颜色并重绘 —— Snipaste 手感就是
  // 「没定稿前随便改色」。（2026-09-25 用户反馈：选框还在时点颜色切不了色）
  // 文字是永久矢量对象，颜色只在「编辑它」时生效（否则一次点色会把画面上所有文字一起染色）。
  const pi = pendingSettledIndex();
  if (pi >= 0) {
    annotations[pi].color = color;
    renderAnnots();
  }
}

if (colorPalette) {
  PALETTE_COLORS.forEach((hex) => {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'capture-swatch';
    sw.dataset.color = hex;
    sw.style.background = hex;
    sw.title = hex.toUpperCase();
    sw.setAttribute('aria-label', hex.toUpperCase());
    sw.addEventListener('click', () => applyDrawingColor(hex, true));
    colorPalette.appendChild(sw);
  });
  syncPaletteActive();
}

colorPicker.addEventListener('input', () => {
  applyDrawingColor(colorPicker.value, true);
});
if (sizeSlider) {
  // 初始数值：载入「当前工具分组」上次用的大小（画笔/高亮/打码/橡皮各自独立记忆）
  drawingSize = toolSizes[SIZE_GROUPS[activeTool]] ?? drawingSize;
  syncSizeSliderUI();
  sizeSlider.addEventListener('input', () => {
    setDrawingSize(Number(sizeSlider.value || 4));
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
let lsAutoScrollOn = true; // 初值；loadAppSettings 会按 store 覆盖
let lsAutoScrollActive = false; // 自动滚动运行中（r22）：此时抓帧策略切为「沉降抓帧」——只在滚动动画结束的静止点抓帧
let lsSettleRetries = 0;       // 沉降重试计数：lsFullStep 发现仍在动就推迟，超限放弃等待直接抓（防漏帧）
if (btnLongShotAuto) btnLongShotAuto.addEventListener('click', () => {
  lsAutoScrollOn = !lsAutoScrollOn;
  btnLongShotAuto.textContent = lsAutoScrollOn ? '自动滚动：开' : '自动滚动：关';
  if (SMART_DEBUG) console.error(`[LS] autoscroll toggle -> ${lsAutoScrollOn}`);
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
function lsVsOrigin() {
  // 截图窗左上角逻辑屏幕坐标（= 目标屏原点）：GDI BitBlt 源坐标按虚拟屏取，
  // 主进程 dipToScreenPoint 换算物理原点后叠加（副屏在主屏左侧/上方时为负）
  return {
    vsX: (captureVirtualScreen && captureVirtualScreen.x) || 0,
    vsY: (captureVirtualScreen && captureVirtualScreen.y) || 0,
  };
}
async function lsGdiFrame(gx, gy, gw, gh, dst) {
  try {
    // r55: 请求高度比选区少 2 物理行——GDI BitBlt 的最后 1~2 行与合成器更新存在竞争
    // （实测白色瀑布流会话：末行 MAD 29~51 vs 倒数第二行 1.2），撕裂行拼进结果 =
    // 每条拼接缝上一道贯穿全宽的细线。选区少 2 行对拼接无感知影响。
    const ghr = Math.max(8, Math.round(gh) - 2);
    const res = await ipcRenderer.invoke('capture-longshot-gdi', { gx: Math.round(gx), gy: Math.round(gy), gw: Math.round(gw), gh: ghr, ...lsVsOrigin() });
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
  if (SMART_DEBUG) console.error(`[LS] preview accum=${lsAccum.width}x${lsAccum.height} total=${(lsFlushedH + lsAccum.height)} draw=${drawW}x${drawH}`);
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
// r57: 编辑器工具栏可拖动（参考微信截图）：按住工具栏非按钮区域拖动，按钮交互不受影响。
// ⚠️ 仅长截图**编辑态**生效 —— 普通截图态由文件上部的工具栏拖拽块独占。此处原先不区分
// 状态，且用 `window.screen.width` 做钳制；跨屏单窗里它只等于窗口自身那块屏的 CSS 宽
// （实测 2049），于是普通截图态把工具栏从右屏写回 left=1307（左屏右缘），正是用户反馈的
// 「一拖就跑到另一块屏、还拖不回来」（2026-09-25）。现加状态守卫 + 改用 window.innerWidth。
(function initEditorToolbarDrag() {
  const bar = document.getElementById('toolbar');
  if (!bar) return;
  let drag = null;
  bar.addEventListener('pointerdown', (e) => {
    if (!document.body.classList.contains('is-longshot-edit')) return;
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
    // r58: clamp 到整个窗口（编辑器窗口可在虚拟桌面内任意位置），不被窗口边界困住。
    // ⚠️ 不能用 window.screen.width/height：单窗跨屏后它是「窗口所属那块屏」的 CSS 宽高
    // （2049×1152），比窗口实际内宽（4096）小一半，会把工具栏永久钳在左半边。
    const left = Math.max(4, Math.min(e.clientX - drag.dx, window.innerWidth - bar.offsetWidth - 4));
    const top = Math.max(4, Math.min(e.clientY - drag.dy, window.innerHeight - bar.offsetHeight - 4));
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
  if (longShotActive || selW < 4 || selH < 4) { if (SMART_DEBUG) console.error(`[LS] start blocked: active=${longShotActive} sel=${selW}x${selH}`); return; }
  const lsT0 = performance.now();
  if (SMART_DEBUG) console.error(`[LS] start(gdi mode) sel=(${selX},${selY}) ${selW}x${selH} dpr=${window.devicePixelRatio}`);
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
  if (SMART_DEBUG) console.error(`[LS] entry ui-ready in ${(performance.now() - lsT0).toFixed(0)}ms`);
  lsProbeStep();
}

function setLsActive(on) {
  if (SMART_DEBUG) console.error(`[LS] active -> ${on}`);
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
      if (SMART_DEBUG) console.error(`[LS] oversize s=${lsLastGoodS.toFixed(0)} > 0.7*fh=${(lsCh * 0.7).toFixed(0)} -> 收紧步长防跳变`);
      lsAutoDelta = -Math.max(18, Math.round(Math.abs(lsAutoDelta) * 0.6));
    }
    // r59: 周期锁死自愈——连续 2 步位移几乎相同（差 <5px）且都 >0.6×帧高：匹配器锁死在
    // 重复元素周期假谷上（23:10 会话连续 585±10 → 内容周期性重复+跳段）。重置速度先验，
    // 下一格回种子先验重新搜索，打破周期锁定。
    if (lsLastStepAppended && lsCh > 0 && lsLastGoodS > lsCh * 0.6) {
      if (lsPrevLockS > 0 && Math.abs(lsLastGoodS - lsPrevLockS) < 5) {
        if (SMART_DEBUG) console.error(`[LS] period-lock detected (s=${lsLastGoodS.toFixed(0)} twice) -> 重置匹配状态打破周期`);
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
        if (lsDiagDue()) if (SMART_DEBUG) console.error(`[LS] snap-mode wheels=${lsAutoMultiWheel} s=${lsLastGoodS.toFixed(0)} target=${fullTarget.toFixed(0)}`);
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
        if (SMART_DEBUG) console.error(`[LS] snap scroll detected -> multi-wheel=${lsAutoMultiWheel} (s=${lsLastGoodS.toFixed(0)} target=${fullTarget.toFixed(0)})`);
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
        if (lsDiagDue()) if (SMART_DEBUG) console.error(`[LS] calib coef=${coef.toFixed(3)}px/unit target=${target.toFixed(0)} -> delta=${-next}`);
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
      if (lsDiagDue()) if (SMART_DEBUG) console.error(`[LS] auto-delta s=${lsLastGoodS.toFixed(0)} target=${target.toFixed(0)} -> delta=${lsAutoDelta}`);
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
      const gres = await ipcRenderer.invoke('capture-longshot-gdi', { gx: Math.round(selX * dpr), gy: Math.round(selY * dpr), gw: Math.round(selW * dpr), gh: Math.round(selH * dpr), ...lsVsOrigin() });
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
      const gres = await ipcRenderer.invoke('capture-longshot-gdi', { gx: Math.round(selX * dpr), gy: Math.round(selY * dpr), gw: Math.round(selW * dpr), gh: Math.round(selH * dpr), ...lsVsOrigin() });
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
    if (SMART_DEBUG) console.error(`[LS] dump#${lsDebugDumps} ${lsMatchSrc || 'acc'}_${tag} ${frame.width}x${frame.height} t=${Date.now() - lsStartT}ms`);
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
      if (SMART_DEBUG) console.error(`[LS] diag live frameDiff=${lsLastFrameDiff.toFixed(2)} t=${nowDiag - lsStartT}ms`);
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
    if (lsDiagDue()) if (SMART_DEBUG) console.error(`[LS] diag no-evidence ref infRows=${gaInfTotal} t=${Date.now() - lsStartT}ms (参考区纯背景，跳过匹配)`);
    lsRejectStreak = 0;
    return 0;
  }
  const e0 = evalS(0);
  if (e0 < 0.3) {
    if (lsDiagDue()) if (SMART_DEBUG) console.error(`[LS] diag static e0=${e0.toFixed(2)} t=${Date.now() - lsStartT}ms (帧未变化/页面未滚动)`);
    if (lsLastFrameDiff > 3) lsDebugDump(frame, 'static_but_changed');
    lsRejectStreak = 0; // 静止不是拒链
    return 0;
  }
  // r28: GDI 帧静止判据——0.3 是视频帧时代遗产，GDI 同内容重抓 e0 实测 87~1061（噪声地板）。
  // 静止帧漏过此闸 → 粗搜在静止内容上找假谷（实测 bestSB=46/288）→ fine_miss 拒帧污染拒链
  // → guessMode 连锁错拼/断档（矮选区会话 1788757841115 拒 7/9 的直接根因）。
  // 双条件：帧间 diff 极小（步进制保证 prev 是静止帧）+ e0 低于滚动帧量级（滚动帧 e0≈4958+）。
  if (lsFrameIsGdi && e0 < 2500 && lsLastFrameDiff <= 0.5) {
    if (lsDiagDue()) if (SMART_DEBUG) console.error(`[LS] diag static-gdi e0=${Math.round(e0)} fdiff=${lsLastFrameDiff.toFixed(2)} t=${Date.now() - lsStartT}ms (GDI 静止帧跳过，不计拒链)`);
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
          if (lsDiagDue()) if (SMART_DEBUG) console.error(`[LS] best-guess no-evidence gbs=${gbs} infRows=${infRows} (reject)`);
          lsRejectStreak++; lsDebugDump(frame, 'guess_no_evidence'); return 0;
        }
        // 速度连续性：周期假谷会锁到远离真实位移的谷，偏离过大且非深谷判为假谷（防 best-guess 锁错周期错拼）
        // velBound 0.5×last：周期 P=42 时假谷偏离 42px，可拒；真实滚动 50% 变速仍可容。
        if (lsLastGoodS > 8 && lsAcceptCount >= 2) {
          const velBound = Math.max(20, lsLastGoodS * 0.5);
          if (Math.abs(gbs - lsLastGoodS) > velBound && gbe >= e0 * 0.45) {
            if (lsDiagDue()) if (SMART_DEBUG) console.error(`[LS] best-guess fine-miss vel-inconsist gbs=${gbs} lastGood=${lsLastGoodS} (reject)`);
            lsRejectStreak++; lsDebugDump(frame, 'vel_inconsist_guess'); return 0;
          }
        }
        const ccG = crossCheck(gbs);
        if (ccG.has && Math.abs(gbs - ccG.sPf) > 5) {
          if (effR(gbs) > effR(ccG.sPf)) {
            if (lsDiagDue()) if (SMART_DEBUG) console.error(`[LS] cross-mismatch(guess) gbs=${gbs} sPf=${ccG.sPf} (副链质疑且速度加权终审败，拒防错拼)`);
            lsRejectStreak++; lsDebugDump(frame, 'cross_mismatch'); return 0;
          }
          if (lsDiagDue()) if (SMART_DEBUG) console.error(`[LS] cross-disagree-dense-wins(guess) gbs=${gbs} sPf=${ccG.sPf}`);
        }
        if (lsDiagDue()) if (SMART_DEBUG) console.error(`[LS] best-guess fine-miss s=${gbs} err=${Math.round(gbe)} e0=${Math.round(e0)} streak=${lsRejectStreak}`);
        lsRejectStreak = 0;
        lsLastMatchRatio = e0 > 0 ? gbe / e0 : 1;
        lsLastGoodS = gbs; lsAcceptCount++;
        return gbs;
      }
    }
    const missHint = (e0 > 200 && bestSB === 0) ? ' 疑似单次滚动超量程(采样间隔内位移过大)' : '';
    if (lsDiagDue()) if (SMART_DEBUG) console.error(`[LS] diag fine-miss e0=${Math.round(e0)} bestSB=${bestSB} minErrB=${Math.round(minErrB)} (粗搜未锁定谷底)${missHint}`);
    lsDebugDump(frame, 'fine_miss');
    return 0;
  }
  const ratio = e0 > 0 ? minErr / e0 : 1;
  const guessMode = lsRejectStreak >= 2; // 连续拒帧 2 次即 best-guess（ShareX 黄色状态同款）：80ms 节拍下 4 次拒帧=320ms 内容断层风险，宁轻微错位不丢内容，后续精确 match 重锚修复
  if (guessMode && lsDiagDue()) if (SMART_DEBUG) console.error(`[LS] best-guess mode s=${bestS} minErr=${Math.round(minErr)} e0=${Math.round(e0)} streak=${lsRejectStreak}`);
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
  if (minErr >= e0 * ratioCap) { lsRejectStreak++; if (lsDiagDue()) if (SMART_DEBUG) console.error(`[LS] diag reject not-better${guessMode ? '(guess)' : ''} s=${bestS} minErr=${Math.round(minErr)} e0=${Math.round(e0)} cap=${ratioCap.toFixed(2)}`); lsDebugDump(frame, 'not_better'); return 0; }
  const noiseCap = lsFrameIsGdi ? 8000 : 2000; // GDI 帧精确但亚像素滚动仍有重采样噪声（实测真谷 err~1456）
  if (!guessMode && minErr > noiseCap) { lsRejectStreak++; if (lsDiagDue()) if (SMART_DEBUG) console.error(`[LS] diag reject too-noisy s=${bestS} minErr=${Math.round(minErr)}`); lsDebugDump(frame, 'too_noisy'); return 0; }
  if (bestS >= S_MAX - 2) { lsRejectStreak++; if (lsDiagDue()) if (SMART_DEBUG) console.error(`[LS] diag reject boundary s=${bestS} S_MAX=${S_MAX} (单次滚动接近整帧高，缩短 tick 可解)`); return 0; }
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
  if (overlapRows < minOverlap) { lsRejectStreak++; if (lsDiagDue()) if (SMART_DEBUG) console.error(`[LS] diag reject tiny-overlap s=${bestS} rows=${overlapRows} need=${minOverlap} strong=${isStrong} seed=${isSeeding} (重叠不足不可靠，交 prev 桥接)`); return 0; }
  // r25 防静止页污染：自动步进一格滚 ~200 物理 px，真实位移不可能 <15。bestS<15 说明这格滚轮没生效
  // （鼠标停在控制条上/目标忽略小 delta/已滚到底），帧与 accum 底部几乎相同——接受会叠加重复行
  // （实测 s=13 污染 accum 后整图错乱）。跳过累加、不计拒绝，循环下一格继续滚。
  if (lsAutoScrollActive && bestS < 15) {
    if (lsDiagDue()) if (SMART_DEBUG) console.error(`[LS] auto-step skip no-motion s=${bestS} (滚动未生效，防重复行)`);
    return 0;
  }
  // 重叠行少时相邻位移误差差异天然小 → 谷尖锐门槛按重叠量放宽
  const sharpK = overlapRows < 100 ? 0.85 : 0.5;
  const eBefore = evalS(bestS - 1);
  const eAfter = evalS(bestS + 1);
  // GDI 帧像素级精确：not-sharp 门槛是视频压缩帧时代的遗产，会误杀周期/平坦误差曲线上的真谷（等高列表行对齐误差天然平缓）→ GDI 全程跳过
  const skipSharp = lsFrameIsGdi;
  if (!skipSharp && !guessMode && eBefore > 0 && minErr > eBefore * sharpK) { lsRejectStreak++; if (lsDiagDue()) if (SMART_DEBUG) console.error(`[LS] diag reject not-sharp(-1) s=${bestS} minErr=${Math.round(minErr)} eBefore=${Math.round(eBefore)}`); lsDebugDump(frame, 'not_sharp_m1'); return 0; }
  if (!skipSharp && !guessMode && eAfter > 0 && minErr > eAfter * sharpK) { lsRejectStreak++; if (lsDiagDue()) if (SMART_DEBUG) console.error(`[LS] diag reject not-sharp(+1) s=${bestS} minErr=${Math.round(minErr)} eAfter=${Math.round(eAfter)}`); lsDebugDump(frame, 'not_sharp_p1'); return 0; }
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
          if (lsDiagDue()) if (SMART_DEBUG) console.error(`[LS] vel-inconsist -> adopt ${alt.s} (alt) 矮选区防周期假谷/漏帧`);
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
            if (lsDiagDue()) if (SMART_DEBUG) console.error(`[LS] vel-inconsist -> trust evidence-rich valley s=${bestS} infRows=${infAtBest} (速度先验让位)`);
            lsRejectStreak = 0; lsLastMatchRatio = e0 > 0 ? minErr / e0 : 1;
            lsLastGoodS = bestS; lsAcceptCount++;
            return bestS;
          }
        }
        if (minErr < e0 * 0.1) {
          if (lsDiagDue()) if (SMART_DEBUG) console.error(`[LS] vel-inconsist -> adopt predict ${Math.round(lsLastGoodS)} (强谷无 alt) 防漏帧`);
          lsRejectStreak = 0; lsLastMatchRatio = 1; lsAcceptCount++;
          return Math.round(lsLastGoodS);
        }
        // 否则落入下方硬拒（原逻辑）
      }
      lsRejectStreak++;
      if (lsDiagDue()) if (SMART_DEBUG) console.error(`[LS] diag reject vel-inconsist s=${bestS} lastGood=${lsLastGoodS} bound=${velBound.toFixed(0)} minErr=${Math.round(minErr)} e0=${Math.round(e0)}${guessMode ? ' (guess)' : ''}`);
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
      if (lsDiagDue()) if (SMART_DEBUG) console.error(`[LS] cross-trust-pf s=${bestS} -> pf=${ccM.sPf} dev=${Math.round(ccDev)} pfErr=${Math.round(ccM.ve)} (副链强对齐且符合位移先验，采信防周期假谷错拼)`);
      lsRejectStreak = 0;
      lsLastMatchRatio = ccM.e0p > 0 ? ccM.ve / ccM.e0p : 1;
      lsLastGoodS = ccM.sPf; lsAcceptCount++;
      return ccM.sPf;
    }
    // r26c 高密度仲裁：副链与主链同用主密度采样，自身也可能锁浅伪谷——不一致时以 stepX=4 终审，
    // 主链 bestS 高密度误差更低则放行（实测 E2E f1 真谷 422 eR=3767 < 伪谷 68 eR=3877）。
    if (effR(bestS) > effR(ccM.sPf)) {
      lsRejectStreak++;
      if (lsDiagDue()) if (SMART_DEBUG) console.error(`[LS] cross-mismatch s=${bestS} sPf=${ccM.sPf} effR(best)=${Math.round(effR(bestS))} effR(pf)=${Math.round(effR(ccM.sPf))} (副链质疑且速度加权终审败，拒防错拼)`);
      lsDebugDump(frame, 'cross_mismatch');
      return 0;
    }
    if (lsDiagDue()) if (SMART_DEBUG) console.error(`[LS] cross-disagree-dense-wins s=${bestS} sPf=${ccM.sPf} (副链质疑，高密度终审主链胜，放行)`);
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
    if (mx > 3 * mn + 50 && lsDiagDue()) if (SMART_DEBUG) console.error(`[LS] diag seg-warn s=${bestS} segs=${Math.round(e1)}/${Math.round(e2)}/${Math.round(e3)} (段间不齐，仅诊断不拒帧——真实内容变化会假阳性)`);
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
      if (lsDiagDue()) if (SMART_DEBUG) console.error(`[LS] strong-off-vel -> adopt ${alt.s} (周期假谷纠偏, 领速度一致真谷, err ${Math.round(alt.e)} vs ${Math.round(minErr)})`);
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
      if (lsDiagDue()) if (SMART_DEBUG) console.error(`[LS] near-valley refine ${bestS} -> ${near.s} (err ${Math.round(near.e)} vs ${Math.round(minErr)})`);
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
  if (SMART_DEBUG) console.error(`[LS] match s=${bestS}${sExact !== bestS ? ` (${sExact.toFixed(2)})` : ''} err=${Math.round(minErr)} e0=${Math.round(e0)} ratioCap=${ratioCap.toFixed(2)}`);
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
        if (SMART_DEBUG) console.error(`[LS] band-blank s=${(+sExact).toFixed(1)} (整带纯色/空白，不追加)`);
        return;
      }
      const keep = Math.min(bandRowsI, lastContent + 25);
      if (keep < bandRowsI) {
        if (SMART_DEBUG) console.error(`[LS] band truncated ${bandRowsI}->${keep} (uniform tail)`);
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
        if (retries > 0) if (SMART_DEBUG) console.error(`[LS] sharp-gate retries=${retries} lap=${Math.round(lap)} base=${Math.round(lsSharpBase)}`);
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
      if (SMART_DEBUG) console.error(`[LS] seed accum=${lsAccum.width}x${lsAccum.height}`);
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
        if (lsDiagDue()) if (SMART_DEBUG) console.error(`[LS] rescue prev-match sRel=${sRel.toFixed(1)} pageShift=${lsPageShift.toFixed(1)} append=${sExact.toFixed(1)}`);
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
      const gres = await ipcRenderer.invoke('capture-longshot-gdi', { gx: Math.round(gx), gy: Math.round(gy), gw: Math.round(gw), gh: Math.round(gh), ...lsVsOrigin() });
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
          if (SMART_DEBUG) console.error(`[LS] probe diff=${diff.toFixed(2)} changed=${changed} t=${nowDiag - lsStartT}ms`);
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
  if (SMART_DEBUG) console.error(`[LS] tile flushed #${lsTiles.length} flushedH=${lsFlushedH} seed=${seedH}`);
}

function stopLongScreenshot(save) {
  if (!longShotActive) return;
  if (SMART_DEBUG) console.error(`[LS] stop save=${save} accum=${lsAccum ? `${lsAccum.width}x${lsAccum.height}` : 'null'} tiles=${lsTiles.length}`);
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
    smartFrameSentKey = '';  // 长截图拼接结果为新帧：强制重发像素检测缓存
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
      if (SMART_DEBUG) console.error(`[LS] probe bg-vs-img (got|want): ${report} canvas=${bgCanvas.width}x${bgCanvas.height} css=${W}x${H} img=${iw}x${ih}`);
    } catch (e) { console.error('[LS] probe failed', e && e.message ? e.message : e); }
    state = STATE.SELECTED;
    selX = 0; selY = 0; selW = W; selH = H;
    historyStack.length = 0; historyIndex = -1; annotations = [];
    strokes = [];
    curStroke = null;
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
        try { if (SMART_DEBUG) console.error(`[LS] bodyBg applied=${getComputedStyle(document.body).backgroundColor} fillH=${fill.style.height}`); } catch (_) { }
      }, 100);
    } catch (e) { console.error('[LS] bg-fill failed', e && e.message ? e.message : e); }
    if (longShotOverlay) longShotOverlay.hidden = true;
    if (longShotPreview) longShotPreview.hidden = true;
    if (longShotControl) longShotControl.hidden = true;
    setTimeout(() => {
      try {
        const cv = bgCanvas.getBoundingClientRect();
        if (SMART_DEBUG) console.error(`[LS] editor geom win=${window.innerWidth}x${window.innerHeight} dpr=${window.devicePixelRatio} body=${document.body.offsetHeight} bodyBg=${getComputedStyle(document.body).backgroundColor} canvas=${Math.round(cv.width)}x${Math.round(cv.height)} top=${Math.round(cv.top)} bottom=${Math.round(cv.bottom)} scrollY=${Math.round(window.scrollY)}`);
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
    if (SMART_DEBUG) console.error(`[LS] editor entered ${W}x${H}`);
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
  // 倒计时（设置：0/1/3/5 秒）
  const cd = Number(APP_SETTINGS.recCountdown);
  const cdN = Number.isFinite(cd) && cd > 0 ? Math.min(5, Math.floor(cd)) : 0;
  if (cdN <= 0) {
    if (recCountdown) recCountdown.hidden = true;
  } else {
    await new Promise((resolve) => {
      let n = cdN;
      if (recCountdown) recCountdown.textContent = String(n);
      const tick = () => {
        n -= 1;
        if (n <= 0) { if (recCountdown) recCountdown.hidden = true; resolve(); }
        else if (recCountdown) { recCountdown.textContent = String(n); window.setTimeout(tick, 700); }
        else resolve();
      };
      window.setTimeout(tick, 700);
    });
  }
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
  // 画质档位（设置）：smooth≈4Mbps / balanced≈按分辨率 / sharp≈16Mbps
  const q = APP_SETTINGS.recQuality || 'balanced';
  const autoBps = Math.min(20_000_000, Math.max(4_000_000, Math.round(cw * ch * 30 * 0.12)));
  const recBitrate = q === 'smooth' ? 4_000_000 : q === 'sharp' ? 16_000_000 : autoBps;
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
      if (typeof saved === 'string' && saved) {
        showToastMessage(`录屏已保存：${saved}`, 3200);
      }
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
  // 与 Ctrl+Z 同语义：有待确认对象先丢它，否则撤销上一步
  if (!discardPendingAnnot()) undoLast();
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

/** 确认发送：截图质量=标准/轻量时由主进程 capture-save 转 JPEG；剪贴板/贴图始终 PNG 无损 */
function sendCaptureComplete(dataURL) {
  if (!dataURL) return;
  ipcRenderer.send('capture-complete', { dataURL });
}

/** r22 确认动作：普通截图=复制+关闭；长截图编辑态=复制+落盘并保留结果页面（用户要求不直接退出） */
function confirmCapture(dataURL) {
  if (!dataURL) return;
  if (document.body.classList.contains('is-longshot-edit')) {
    const full = cropLongShotFull() || dataURL;
    try { clipboard.writeImage(nativeImage.createFromDataURL(full)); ipcRenderer.send('capture-clipboard-image-write'); } catch (_) { }
    try {
      const base = (window.__lsSaveFilename || `长截图_${lsStamp()}`).replace(/_1$/, '');
      ipcRenderer.send('capture-longshot-save', { images: [full], baseName: base });
      showToastMessage('长截图已复制并保存到图片目录，可继续标注，✕/Esc 关闭');
    } catch (_) { showToastMessage('长截图已复制到剪贴板'); }
    return;
  }
  sendCaptureComplete(dataURL);
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
        showOcrResult(maybeStripSmartHeadings(result.text));
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
      // 设置：纯 TSV / 带边框 HTML（默认）
      if (APP_SETTINGS.tableCopyFormat === 'tsv') {
        clipboard.writeText(htmlTableToTsv(ocrTableHtml));
      } else {
        clipboard.write({ text: htmlTableToTsv(ocrTableHtml), html: ocrTableHtml });
      }
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
      // 双写：面板下拉与工具栏翻译菜单共用同一目标语言（此前只写文本键，
      // 图片翻译读的是另一个键 → 用户换语言后图片翻译永远是中文）
      void ipcRenderer.invoke('store:write', 'screenshot-text-translate-target-lang', ocrTargetLang.value);
      void ipcRenderer.invoke('store:write', 'screenshot-translate-target-lang', ocrTargetLang.value);
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
      void ipcRenderer.invoke('store:write', 'screenshot-text-translate-target-lang', translateTargetLang.value);
    } catch { /* 持久化失败不影响本次使用 */ }
    // 换语言 = 作废旧译文缓存：下一次「翻译」用新语言重翻原文（而非切换回旧译文）
    if (translationCache) {
      const original = translationCache.originalImage;
      translationCache = null;
      displayedImageVersion = 'original';
      if (original) renderSelectionImage(original).catch(() => {});
    }
    retranslatePanelIfAny();
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

  try {
    const [storedSourceLang, storedTargetLang, storedTextTargetLang] = await Promise.all([
      ipcRenderer.invoke('store:read', 'screenshot-translate-source-lang'),
      ipcRenderer.invoke('store:read', 'screenshot-translate-target-lang'),
      ipcRenderer.invoke('store:read', 'screenshot-text-translate-target-lang'),
    ]);
    const sourceLanguage = typeof storedSourceLang === 'string' && storedSourceLang ? storedSourceLang : 'auto';
    // 目标语言：图片键 → 文本键 → 默认中文（两处下拉已双写，此处兜底旧数据）
    const targetLanguage = typeof storedTargetLang === 'string' && storedTargetLang
      ? storedTargetLang
      : (typeof storedTextTargetLang === 'string' && storedTextTargetLang ? storedTextTargetLang : 'zh');
    // 提示带上目标语言 + UI 版本标记（v5 = 排版对齐版；无标记 = 跑的是 Xiyue 旧链路）
    const langNames = { zh: '中文', en: '英语', ja: '日语', ko: '韩语', fr: '法语', de: '德语', es: '西班牙语', ru: '俄语' };
    showTranslateOverlay(`[v5] ${tCapture('translating')}（${langNames[targetLanguage] || targetLanguage}）`);

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
    let translatedImage = typeof result.translatedImage === 'string' ? result.translatedImage : '';
    const translatedText = typeof result.translatedText === 'string' ? result.translatedText : '';
    // 设置：仅文本面板 → 不叠图，只进 OCR 浮窗
    if (APP_SETTINGS.translateRender === 'panel') translatedImage = '';
    // 两条路径都没数据 → 视为失败
    if (!translatedImage && !translatedText) {
      throw new Error(result?.message || tCapture('translateFailed'));
    }
    // 先把「原文」状态快照入历史栈（旧代码误调未定义的 pushHistory()，会导致
    // 翻译成功也抛 ReferenceError 走 catch → 永远提示失败），随后绘制译文。
    commitHistory();
    if (translatedImage) {
      await renderSelectionImage(translatedImage);
      translationCache = { originalImage, translatedImage };
    } else {
      translationCache = { originalImage, translatedImage: '' };
    }
    displayedImageVersion = 'translated';
    updateTranslateButtonLabel();
    showTranslateText(translatedText);
    // 纯文本模式：主动把 OCR 浮窗拉到前台
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

/* ── 左下角操作指引（Shotera 式键帽面板）：悬停/选中都显示；光标靠近淡出 ── */

function guideKbd(keys) {
  // keys: ['Tab'] 或 ['↑','←','↓','→'] —— 数组内用 / 分隔显示
  if (!Array.isArray(keys) || !keys.length) return '';
  return keys.map((k) => `<kbd>${k}</kbd>`).join('<span class="cg-sep">/</span>');
}

function guideRow(keys, desc) {
  return `<div class="cg-row"><div class="cg-keys">${guideKbd(keys)}</div><div class="cg-desc">${desc}</div></div>`;
}

/** 纯说明行（无键帽）：用于工具栏按钮的 hover 说明（图钉 = 贴图到桌面…） */
function guideTipRow(desc) {
  return `<div class="cg-row cg-row-tip"><div class="cg-desc">${desc}</div></div>`;
}

/** 当前 hover 的工具栏按钮说明（title 已随 i18n 切换）；空串 = 不显示 */
let guideHoverLabel = '';

function updateGuideContent() {
  if (!captureGuide) return;
  const rows = [];
  if (!isCaptureBusy() && ocrPanel.style.display !== 'flex') {
    if (polyPoints) {
      // 多点折线进行中优先：此时 state 是 ANNOTATING，其它分支都不匹配（原来会把指引板藏起来）
      rows.push(guideRow(['单击'], tCapture('guidePolyAdd')));
      rows.push(guideRow(['松开 Shift', '单击'], tCapture('guideDone')));
      rows.push(guideRow(['双击'], tCapture('guideDone')));
      rows.push(guideRow(['Esc', '右键'], tCapture('guidePolyAbort')));
    } else if (state === STATE.IDLE) {
      // Shotera 悬停时不弹大指引板：IDLE 只保留极简两行，选中后再展开
      rows.push(guideRow(['拖拽', '点击'], tCapture('guideDrag') + ' · ' + tCapture('guideClick')));
      rows.push(guideRow(['滚轮'], tCapture('guideCycleLevel')));
      rows.push(guideRow(['Esc'], tCapture('guideCancel')));
    } else if (state === STATE.SELECTED || state === STATE.MOVING || state === STATE.RESIZING) {
      const over = hoverAnnotIndex >= 0 && !!annotations[hoverAnnotIndex];
      rows.push(guideRow(['↑', '↓', '←', '→'], over ? tCapture('guideNudgeAnnot') : tCapture('guideNudge')));
      rows.push(guideRow(['Ctrl', '↑↓←→'], tCapture('guideExpandEdge')));
      rows.push(guideRow(['Shift', '↑↓←→'], tCapture('guideNudge10')));
      rows.push(guideRow(['Enter'], tCapture('guideDone')));
      rows.push(guideRow(['Ctrl', 'S'], tCapture('guideSave')));
      rows.push(guideRow(['Esc'], tCapture('guideCancel')));
      rows.push(guideRow(['右键'], tCapture('guideUndoStep')));
      // Shift 双语义提示：只在对应工具下显示，避免指引板在其它工具下无谓变长
      if (activeTool === 'rect' || activeTool === 'ellipse') {
        rows.push(guideRow(['Shift', '拖拽'], tCapture('guideSquare')));
      } else if (POLY_TOOLS.includes(activeTool)) {
        rows.push(guideRow(['Shift', '单击'], tCapture('guidePoly')));
      }
      // 笔刷类 Shift 拉直线（橡皮擦除外：它的 Shift 是「整笔擦」）
      if (BRUSH_CURSOR_TOOLS.has(activeTool) && activeTool !== 'eraser') {
        rows.push(guideRow(['Shift', '拖拽'], tCapture('guideStraight')));
      }
      // Shift+滚轮调粗细 / 线宽（Alt 已让位给准线，故用 Shift）
      if (SIZE_WHEEL_TOOLS.has(activeTool)) {
        rows.push(guideRow(['Shift', '滚轮'], tCapture('guideSize')));
      }
      // 橡皮擦：按当前方式给出用法提示 + Shift 整笔擦
      if (activeTool === 'eraser') {
        rows.push(guideRow(['拖拽'], eraserMode === 'rect' ? tCapture('guideEraseArea') : tCapture('guideEraseFine')));
        rows.push(guideRow(['Shift', '点击'], tCapture('guideEraseWhole')));
      }
      // 打码套索：自由圈画，松手自动首尾相连闭合成多边形
      if (MASK_TOOLS.includes(activeTool) && maskMode === 'lasso') {
        rows.push(guideRow(['拖拽'], tCapture('guideLasso')));
      }
    }
  }
  // 2026-09-28 分区更新（用户指出：hover 说明变化时整板重建完全没必要）——
  // cg-main（快捷键区）只在状态/工具变化时重建；cg-tip（hover 说明）是独立元素，
  // 只改 textContent，整板纹丝不动（高度槽锁定防跳，配合 .has-tip 分隔线）。
  ensureGuideParts();
  if (!guideMainEl || !guideTipEl) return;
  const mainHtml = rows.join('');
  const tip = guideHoverLabel || '';
  const mainChanged = mainHtml !== guideMainLastHtml;
  const tipChanged = tip !== guideTipLast;
  if (!mainChanged && !tipChanged) return;
  if (mainChanged) {
    guideMainLastHtml = mainHtml;
    guideMainEl.innerHTML = mainHtml;
  }
  if (tipChanged) {
    guideTipLast = tip;
    // 名称 + 简要说明（用户要求：变的部分放面板上方，格式 = 名称粗体 + 说明暗淡）：
    // title 按「：」拆分——"移动"这类纯名称无说明行；"表格识别：还原选区中的表格…"
    // 拆成名称+说明两行；"贴图到桌面 · …"无冒号的整串作说明、名称行隐藏。
    guideTipEl.style.display = tip ? 'flex' : 'none';
    if (tip) {
      const sep = tip.indexOf('：');
      const name = sep > 0 ? tip.slice(0, sep) : '';
      const desc = sep > 0 ? tip.slice(sep + 1) : tip;
      const nameEl = guideTipEl.querySelector('.cg-tip-name');
      const descEl = guideTipEl.querySelector('.cg-tip-desc');
      nameEl.textContent = name;
      nameEl.style.display = name ? 'block' : 'none';
      descEl.textContent = desc;
      descEl.style.display = desc ? 'block' : 'none';
    }
  }
  captureGuide.classList.toggle('has-tip', !!tip && !!mainHtml);
  const visible = !!(mainHtml || tip);
  if (visible) {
    if (mainChanged || tipChanged || captureGuide.style.display === 'none') {
      captureGuide.style.display = 'flex';
      positionGuide(); // 先贴到光标所在屏的左下角，再量最终矩形
      measureGuideBox();
    }
  } else {
    captureGuide.style.display = 'none';
    guideBox = null;
    guidePosKey = '';
  }
}

/** 分区缓存的子元素与上一次内容（分区更新，见 updateGuideContent） */
let guideMainEl = null;
let guideTipEl = null;
let guideMainLastHtml = '';
let guideTipLast = '';

/** 惰性取分区子元素（captureGuide 是启动时查的，子元素随 capture.html 静态结构） */
function ensureGuideParts() {
  if (!captureGuide) return;
  if (!guideMainEl) guideMainEl = captureGuide.querySelector('.cg-main');
  if (!guideTipEl) guideTipEl = captureGuide.querySelector('#captureGuideTip');
}

// 指引条矩形缓存：仅在内容/尺寸变化时重算
let guideBox = null;
function measureGuideBox() {
  if (!captureGuide || captureGuide.style.display === 'none') { guideBox = null; return; }
  const r = captureGuide.getBoundingClientRect();
  guideBox = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
}

/**
 * 指引板定位：贴「光标所在屏」的左下角，返回是否发生了位移。
 * 单窗全虚拟屏方案下窗口覆盖两屏，CSS 里固定的 left/bottom 永远落在最左侧那块屏 ——
 * 用户在右屏操作、提示却出现在左屏，故改由 JS 按光标所在屏定位。
 */
let guidePosKey = '';
function positionGuide() {
  if (!captureGuide || captureGuide.style.display === 'none') return false;
  const scr = screenCssRectAt(pendingMouseX, pendingMouseY) || { x: 0, y: 0, width: W, height: H };
  const w = captureGuide.offsetWidth || 0;
  const h = captureGuide.offsetHeight || 0;
  const left = Math.max(scr.x + 8, Math.min(scr.x + 16, scr.x + scr.width - w - 8));
  const top = Math.max(scr.y + 8, scr.y + scr.height - h - 16);
  const key = `${Math.round(left)},${Math.round(top)},${w}x${h}`;
  if (key === guidePosKey) return false;
  guidePosKey = key;
  captureGuide.style.left = `${Math.round(left)}px`;
  captureGuide.style.top = `${Math.round(top)}px`;
  captureGuide.style.bottom = 'auto'; // CSS 默认 bottom:16px，与 top 同时生效会把面板拉伸
  return true;
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
    // 光标换屏 → 指引板跟着换屏，并重算矩形缓存（否则淡出感应区还停在旧位置）
    if (positionGuide()) measureGuideBox();
    const r = guideBox;
    if (!r) return;
    const PAD = 72; // 靠近（含感应区）→ 淡出，避免挡住光标下的操作
    const near = guideLastPx >= r.left - PAD && guideLastPx <= r.right + PAD
      && guideLastPy >= r.top - PAD && guideLastPy <= r.bottom + PAD;
    captureGuide.classList.toggle('is-away', near);
  });
}, { passive: true });

/* 工具栏按钮说明进提示区（2026-09-25 用户要求「图钉的这个说明，可以添加到我们的提示区域当中」）：
   hover 任一按钮 → 左下提示区多显示一行该按钮的 title（title 随 i18n 切换，无需另建文案）。 */
if (toolbar) {
  // hover 清空宽限（2026-09-28 防闪现）：按钮间滑动会经历"离开 A（清空）→进入 B（设置）"
  // 的中间态，清空立即生效 = 指引行闪一下。延迟 80ms 提交清空，期间进入新按钮则取消。
  let hoverClearTimer = 0;
  toolbar.addEventListener('pointerover', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('button[title]') : null;
    const next = btn ? (btn.title || '') : '';
    if (next === guideHoverLabel) return;
    if (next) {
      if (hoverClearTimer) { clearTimeout(hoverClearTimer); hoverClearTimer = 0; }
      guideHoverLabel = next;
      updateGuideContent();
    } else if (guideHoverLabel) {
      if (hoverClearTimer) clearTimeout(hoverClearTimer);
      hoverClearTimer = setTimeout(() => {
        hoverClearTimer = 0;
        guideHoverLabel = '';
        updateGuideContent();
      }, 80);
    }
  });
  toolbar.addEventListener('pointerleave', () => {
    if (!guideHoverLabel) return;
    if (hoverClearTimer) clearTimeout(hoverClearTimer);
    hoverClearTimer = setTimeout(() => {
      hoverClearTimer = 0;
      guideHoverLabel = '';
      updateGuideContent();
    }, 80);
  });
}
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
  // 微调待确认对象不产生历史：等确认（烘焙）时统一压一次快照
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
  // 钳制用**旋转后的世界包围盒**：未旋转的 annotBounds 在文字转过角之后对不上屏幕上的实际占位，
  // 会造成「还没贴到边就停住 / 能压出选区」。
  const bb = annotWorldBounds(a);
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
    translateShape(a, adx, ady);
  }
  renderAnnots();
  if (nudgeTimer) clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(finishNudgeCommit, 650); // 连续按键合并为一次撤销步骤
  return true;
}

document.addEventListener('keydown', (e) => {
  // 文字编辑器（in-place textarea）打开时：Esc 只关掉编辑器，留在截图里（下面分支处理）
  const isTextEditorFocused = !!textEditor && document.activeElement === textEditor;
    if (e.key === 'Escape') {
      // Esc 逐步「撤销」当前进行中的状态，全部收干净后再次按才退出截图（2026-09-26 用户确认）
      // 优先级：长截图/录屏中（先停）→ 折线 → 文字编辑器 → 面板 → OCR → 取色器 → 拖动/缩放还原 → 丢弃待确认对象 → 退出
      if (longShotActive) { stopLongScreenshot(false); return; }
      if (isRecording) { stopRecording(); return; }
      // 多点折线未收尾：Esc 只放弃这条折线，不退截图、不动已有编辑
      if (polyPoints) { abortPolyline(); return; }
      // 文字编辑中：Esc = 退出这一层（收尾保留已输入的文字）—— 层级退出不丢内容，
      // 「丢弃这一段 / 撤销」交给右键（步骤撤销），与 Snipaste 的分工一致。
      if (textEditor) {
        commitTextEditor();
      } else if (isMaskMenuOpen()) {
      closeMaskMenu();
    } else if (isShapeMenuOpen()) {
      closeShapeMenu();
    } else if (isEraserMenuOpen()) {
      closeEraserMenu();
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
    } else if (state === STATE.MOVING && dragAnnotIndex !== -1) {
      // 拖动单个对象中按 Esc：还原到按下瞬间的位置，不留下这次移动
      restoreAnnotTo(dragBase, dragAnnotIndex);
      dragAnnotIndex = -1;
      dragBase = null;
      state = STATE.SELECTED;
      showToolbar();
      updateSizeInfo(selX, selY);
    } else if (state === STATE.RESIZING && annotResizeHandle) {
      // 缩放单个对象中按 Esc：还原到按下瞬间的大小，不留下这次缩放
      restoreAnnotTo(annotResizeBase, annotResizeIndex);
      endAnnotResize();
      state = STATE.SELECTED;
      showToolbar();
      updateSizeInfo(selX, selY);
    } else if (discardPendingAnnot()) {
      // 有「待确认」对象时：第一次按 Esc 只丢弃它（不烘焙、不退截图），再按一次才退出截图
    } else {
      ipcRenderer.send('capture-cancel');
    }
    return;
  }
  if (isTextEditorFocused) {
    return;
  }
  // Shotera 取色快捷键：C 复制色号；Shift 循环 HEX/RGB/HSV；Tab 切换检测层级
  if ((state === STATE.IDLE || state === STATE.DRAWING) && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (e.key === 'Tab' && state === STATE.IDLE) {
      e.preventDefault();
      cycleSmartLevel(1);
      return;
    }
    if (e.key === 'Shift') {
      colorFormat = colorFormat === 'hex' ? 'rgb' : colorFormat === 'rgb' ? 'hsv' : 'hex';
      if (magHex) magHex.textContent = formatColor(lastPickedColor);
      const hint = magnifier && magnifier.querySelector('.mag-hint');
      if (hint) hint.textContent = `按 C 复制色号 · Shift 切换 HEX/RGB/HSV（当前 ${colorFormat.toUpperCase()}）`;
      e.preventDefault();
      return;
    }
    if (e.key === 'c' || e.key === 'C') {
      try {
        if (clipboard && clipboard.writeText) clipboard.writeText(formatColor(lastPickedColor));
      } catch (_) { /* ignore */ }
      const hint = magnifier && magnifier.querySelector('.mag-hint');
      if (hint) {
        const prev = hint.textContent;
        hint.textContent = `已复制 ${formatColor(lastPickedColor)}`;
        window.setTimeout(() => { hint.textContent = prev; }, 1200);
      }
      e.preventDefault();
      return;
    }
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
      // 有待确认对象：Ctrl+Z 先「取消这一步」（丢弃对象），否则撤销上一步快照
      if (!discardPendingAnnot()) undoLast();
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
    if (dataURL) sendCaptureComplete(dataURL);
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

/* ── 文字工具自测钩子（PETALSNAP_SELFTEST=1 触发，验证后删除）──────────────
   合成 DOM 事件走真实手势链，逐步断言内部状态，结果打 [SELFTEST] 日志。 */
if (process.env.PETALSNAP_SELFTEST === '1') {
  setTimeout(() => {
    const log = (...a) => console.error('[SELFTEST]', ...a);
    const step = (name, ok, detail) => log(ok ? 'PASS' : 'FAIL', name, detail || '');
    try {
      log('start');
      initCanvases();
      state = STATE.SELECTED;
      selX = 100; selY = 100; selW = 600; selH = 400;
      activeTool = 'text';
      W = window.innerWidth || 2000; H = window.innerHeight || 1000;

      // 1) 开编辑器
      openTextEditor(150, 130);
      step('openTextEditor', !!textEditor);
      if (!textEditor) return;

      // 2) 打字（直接设值走同步链）
      textEditor.value = '你好';
      refreshEditorCanvas();
      step('type-sync', (editingTextAnnot && editingTextAnnot.text === '你好' && editingTextAnnot.lines.length >= 1));

      // 2.5) 原生 drag 阻断（真实鼠标拖动被 drag 劫持是自测/真实差异的系统性根因）
      const de = new Event('dragstart', { cancelable: true });
      textEditor.dispatchEvent(de);
      step('dragstart-blocked', de.defaultPrevented);

      // 3) 编辑态拖框：textarea mousedown → document mousemove（锚点应变化）
      const ab = annotBounds(editingTextAnnot);
      const cx = ab.x + ab.w / 2, cy = ab.y + ab.h / 2; // 框中心（避开手柄）
      const ax0 = textAnchorX, ay0 = textAnchorY;
      textEditor.dispatchEvent(new MouseEvent('mousedown', { clientX: cx, clientY: cy, button: 0, bubbles: true }));
      for (let i = 1; i <= 6; i++) {
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: cx + i * 10, clientY: cy + i * 5, bubbles: true }));
      }
      const moved = (textAnchorX !== ax0 || textAnchorY !== ay0);
      step('editframe-drag', moved, `anchor ${ax0},${ay0} -> ${textAnchorX},${textAnchorY}`);
      document.dispatchEvent(new MouseEvent('mouseup', { clientX: cx + 60, clientY: cy + 30, bubbles: true }));

      // 4) 提交
      commitTextEditor();
      step('commit', annotations.length === 1 && annotations[0].text === '你好', `annotations=${annotations.length}`);

      // 5) 已提交文字：按下待定 → 移动超阈值 → MOVING 且坐标变化
      const a0 = annotations[0];
      const px = a0.x + 12, py = a0.y + Math.max(4, Math.round(a0.fontSize * 0.5));
      tempCanvas.dispatchEvent(new MouseEvent('mousedown', { clientX: px, clientY: py, button: 0, bubbles: true }));
      step('pendingTextEdit-set', !!pendingTextEdit);
      const bx0 = annotations[0].x, by0 = annotations[0].y;
      for (let i = 1; i <= 6; i++) handleMouseMove(px + i * 12, py + i * 6);
      const conv = (state === STATE.MOVING && dragAnnotIndex === 0);
      step('pending->move', conv, `state=${state} dragAnnotIndex=${dragAnnotIndex}`);
      const moved2 = (annotations[0].x !== bx0 || annotations[0].y !== by0);
      step('committed-drag-moved', moved2, `${bx0},${by0} -> ${annotations[0].x},${annotations[0].y}`);
      tempCanvas.dispatchEvent(new MouseEvent('mouseup', { clientX: px + 72, clientY: py + 36, bubbles: true }));

      // 6) 编辑回归：原地点击重新编辑
      tempCanvas.dispatchEvent(new MouseEvent('mousedown', { clientX: px, clientY: py, button: 0, bubbles: true }));
      tempCanvas.dispatchEvent(new MouseEvent('mouseup', { clientX: px, clientY: py, bubbles: true }));
      step('click->edit', !!textEditor);
      if (textEditor) commitTextEditor();

      // 6.5) 编辑态手柄拉伸（真实事件路径：textarea 事件 → 转发 tempCanvas → 状态机）
      if (textEditor) commitTextEditor();
      openTextEditor(150, 130);
      textEditor.value = '你好';
      refreshEditorCanvas();
      const eb = annotBounds(editingTextAnnot);
      const hx = eb.x + eb.w + 4, hy = eb.y + eb.h + 4; // br 手柄位置（bounds+pad 角）
      const fs0 = editingTextAnnot.fontSize;
      textEditor.dispatchEvent(new MouseEvent('mousedown', { clientX: hx, clientY: hy, button: 0, bubbles: true }));
      step('edit-handle-down', state === STATE.RESIZING && annotResizeHandle === 'br', `state=${state} handle=${annotResizeHandle}`);
      // 走 ta 的 mousemove（真实路径：ta 监听器转发给 tempCanvas）
      for (let i = 1; i <= 5; i++) {
        console.error(`[SELFTEST] loop i=${i} editorNull=${!textEditor} editingNull=${!editingTextAnnot} state=${state}`);
        try {
          textEditor.dispatchEvent(new MouseEvent('mousemove', { clientX: hx + i * 12, clientY: hy + i * 8, bubbles: true }));
        } catch (e) {
          console.error('[SELFTEST] loop-throw i=' + i, (e && e.message) || e);
          throw e;
        }
        // 事件路由已由 dispatch 验证；缩放数学走 rAF（同步测试不跑）→ 直接调用补测
        handleMouseMove(hx + i * 12, hy + i * 8);
      }
      const fs1 = editingTextAnnot.fontSize;
      step('edit-handle-resize', fs1 !== fs0, `fontSize ${fs0} -> ${fs1}`);
      textEditor.dispatchEvent(new MouseEvent('mouseup', { clientX: hx + 60, clientY: hy + 40, bubbles: true }));
      step('edit-handle-up', state === STATE.SELECTED, `state=${state}`);
      commitTextEditor();

      // 7) 选框把手：右下角按下 → RESIZING
      tempCanvas.dispatchEvent(new MouseEvent('mousedown', { clientX: selX + selW, clientY: selY + selH, button: 0, bubbles: true }));
      step('selhandle-resize', state === STATE.RESIZING && !!resizeHandle, `state=${state} handle=${resizeHandle}`);
      tempCanvas.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

      // 8) 点空白 = 确认 + 新建
      const blankX = selX + 40, blankY = selY + selH - 30;
      tempCanvas.dispatchEvent(new MouseEvent('mousedown', { clientX: blankX, clientY: blankY, button: 0, bubbles: true }));
      const newEditor = !!textEditor;
      step('blank->new-editor', newEditor);
      if (textEditor) cancelTextEditor();

      // 9b) 编辑中按选框把手（textarea 覆盖区内，用户实测的精确场景）：
      // 应提交编辑器 + 进入选框 RESIZING，且**不**新建文字框
      openTextEditor(150, 130);
      textEditor.value = '你好';
      refreshEditorCanvas();
      const annBefore = annotations.length;
      textEditor.dispatchEvent(new MouseEvent('mousedown', { clientX: selX + selW, clientY: selY + selH, button: 0, bubbles: true }));
      step('editing+selhandle', state === STATE.RESIZING && !textEditor && annotations.length >= annBefore,
        `state=${state} editorOpen=${!!textEditor} ann=${annotations.length}/${annBefore} handle=${resizeHandle || 'null'}`);
      if (state === STATE.RESIZING) {
        tempCanvas.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      }

      // 9c) 已提交文字的**框角**（非字形处）：按下应进 RESIZING 拉伸，不新建（用户实测病灶）
      if (textEditor) cancelTextEditor();
      const ca = annotations[annotations.length - 1];
      const cab = annotBounds(ca);
      const cornerX = cab.x + cab.w + 3, cornerY = cab.y + cab.h + 3; // br 角（框边缘留白）
      const annCnt = annotations.length;
      tempCanvas.dispatchEvent(new MouseEvent('mousedown', { clientX: cornerX, clientY: cornerY, button: 0, bubbles: true }));
      step('committed-boxcorner', state === STATE.RESIZING && annotations.length === annCnt && !textEditor,
        `state=${state} ann=${annotations.length}/${annCnt} editor=${!!textEditor} handle=${annotResizeHandle || resizeHandle || 'null'}`);
      if (state === STATE.RESIZING) tempCanvas.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

      // 9d) 已提交文字缩放中：手柄层可见（display=block）+ 拖出框跟手（含鼠标位置）
      if (textEditor) cancelTextEditor();
      {
        const ta2 = annotations[annotations.length - 1];
        const tb = annotBounds(ta2);
        tempCanvas.dispatchEvent(new MouseEvent('mousedown', { clientX: tb.x + tb.w + 3, clientY: tb.y + tb.h + 3, button: 0, bubbles: true }));
        handleMouseMove(tb.x + tb.w + 80, tb.y + tb.h + 50);
        const disp = annotHandles.style.display;
        step('resizing-handles-visible', disp === 'block', `display=${disp}`);
        tempCanvas.dispatchEvent(new MouseEvent('mouseup', { clientX: tb.x + tb.w + 80, clientY: tb.y + tb.h + 50, bubbles: true }));
        // 松手后：手柄层必须贴文字**实际框**（单一图层铁律——拖出框双图层曾致点击错位）
        const fin = annotations[annotations.length - 1];
        const fb = annotBounds(fin);
        const hl = parseFloat(annotHandles.style.left) || 0;
        const hw = parseFloat(annotHandles.style.width) || 0;
        step('handles-on-actual-box', Math.abs(hl + ANNOT_BOX_PAD - fb.x) <= 1 && Math.abs(hw - ANNOT_BOX_PAD * 2 - fb.w) <= 1,
          `handleBox=${hl},${hw} actual=${fb.x},${fb.w}`);
        return;
        tempCanvas.dispatchEvent(new MouseEvent('mouseup', { clientX: tb.x + tb.w + 80, clientY: tb.y + tb.h + 50, bubbles: true }));
      }

      // 9) 文字工具 + 选框把手：按下 br 把手 → 应进入选框 RESIZING（用户实测变成新建文字框）
      if (textEditor) cancelTextEditor();
      tempCanvas.dispatchEvent(new MouseEvent('mousedown', { clientX: selX + selW, clientY: selY + selH, button: 0, bubbles: true }));
      step('texttool+selhandle', state === STATE.RESIZING && resizeHandle === 'br',
        `state=${state} resizeHandle=${resizeHandle || 'null'} textEditorOpen=${!!textEditor} editorWidthOverride=${editorWidthOverride}`);
      if (state === STATE.RESIZING) {
        handleMouseMove(selX + selW + 30, selY + selH + 20); // 同步测试：rAF 不跑，直接调
        tempCanvas.dispatchEvent(new MouseEvent('mouseup', { clientX: selX + selW + 30, clientY: selY + selH + 20, bubbles: true }));
        step('texttool+selhandle-resized', selW === 630 && selH === 420, `selW=${selW} selH=${selH}`);
      }
      if (textEditor) cancelTextEditor();

      log('done');
    } catch (err) {
      log('EXCEPTION', (err && err.stack) || String(err));
    }
  }, 2000);
}

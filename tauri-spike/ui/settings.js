/* 拾花设置窗 · 数据驱动渲染 + store 读写 */
/* eslint-disable no-undef */
const { ipcRenderer, shell } = require('electron');

const ICONS = {
  general: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  capture: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/>',
  longshot: '<path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"/><path d="M10 18h4"/>',
  record: '<path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
  ocr: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 12h10"/>',
  translate: '<path d="m5 8 6 6"/><path d="m4 14 6-6 2-3"/><path d="M2 5h12"/><path d="M7 2h1"/><path d="m22 22-5-10-5 10"/><path d="M14 18h6"/>',
  about: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  folder: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/>',
  link: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
};

/** 把值安全写进 data-*：禁止直接 JSON.stringify（字符串会多引号弄坏 HTML） */
function toAttr(v) {
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (v === null || v === undefined) return '';
  return String(v);
}
function fromAttr(s, sample) {
  if (typeof sample === 'boolean') return s === '1';
  if (typeof sample === 'number') return Number(s);
  return s == null ? '' : String(s);
}

const DEFS = [
  { id: 'i18n', page: 'general', type: 'select', key: 'i18n-language', def: 'system',
    title: '界面语言', desc: '截图面板与本设置窗的显示语言；「跟随系统」按系统区域自动选择，切换后立即生效',
    options: [
      { value: 'system', label: '跟随系统' },
      { value: 'zh', label: '简体中文' },
      { value: 'en', label: 'English' },
    ] },
  { id: 'autostart', page: 'general', type: 'seg', key: 'app-autostart', def: 'off', persist: false,
    title: '开机自启', desc: '登录 Windows 后在托盘静默启动，不弹出任何窗口',
    options: [
      { value: 'off', label: '不启动' },
      { value: 'on', label: '开机自启' },
    ] },
  // ── 保存（2026-11-23 单卡折叠版）：目录位置列表 + 一组按钮 + 设置备份 ──
  { id: 'saveGroup', page: 'general', type: 'saveCard', key: '', def: null,
    title: '保存',
    detail: '截图、录屏、下载资源与设置备份的存放位置。单击选中一项，用下方按钮更改/恢复默认/打开目录；下载资源目录更改后自动重启识别服务。备份为整体替换，导入前自动留一份可回退。' },
  { id: 'hotkey', page: 'capture', type: 'hotkey', key: 'screenshot-hotkey', def: 'Alt+Q',
    title: '截图热键', desc: '点击键帽后按新组合键，Esc 取消',
    detail: '全局生效；与其他程序冲突时自动改用备用键，以托盘菜单显示为准。' },
  { id: 'hotkeyCopy', page: 'capture', type: 'hotkey', key: 'screenshot-hotkey-copy', def: 'Alt+C', persist: false,
    title: '截图并复制', desc: '框选完成后直接复制到剪贴板并退出',
    detail: '默认 Alt+C；冲突时该键失效，不影响主截图热键。当前版本固定为 Alt+C，改键后续开放。' },
  { id: 'engine', page: 'capture', type: 'select', key: 'screenshot-engine', def: 'plugin',
    title: '抓帧引擎', desc: '抓屏方案；黑屏/偏色时改「兼容模式」',
    detail: '自动（推荐）：优先系统原生接口，失败自动换备用方案，速度最快；兼容模式：传统抓屏备用方案。切换后下一次截图生效。',
    options: [
      { value: 'plugin', label: '自动（推荐）' },
      { value: 'js', label: '兼容模式（备用）' },
    ] },
  { id: 'shotQ', page: 'capture', type: 'seg', key: 'screenshot.quality', def: 'high',
    title: '截图质量', desc: '仅作用于保存文件；复制与贴图始终无损',
    detail: '高清 = PNG 无损（推荐）；标准 = JPEG 92%，体积约省 10 倍；轻量 = JPEG 80%，体积最小。',
    options: [
      { value: 'lite', label: '轻量' },
      { value: 'standard', label: '标准' },
      { value: 'high', label: '高清' },
    ] },
  { id: 'multiMon', page: 'capture', type: 'seg', key: 'screenshot.multi-monitor-mode', def: 'cursor',
    title: '多显示器范围', desc: '多显示器时框选覆盖的范围',
    detail: '仅光标屏（推荐）：蒙版只盖鼠标所在屏幕，混合缩放最准；全部屏幕：蒙版铺满所有屏幕、可跨屏框选。切换后下一次截图生效。',
    options: [
      { value: 'cursor', label: '仅光标所在屏' },
      { value: 'all', label: '全部屏幕' },
    ] },
  { id: 'lsAuto', page: 'longshot', type: 'seg', key: 'screenshot.ls-autoscroll', def: true,
    title: '进入后默认自动滚动', desc: '开：点「长截图」即匀速滚轮翻页并跟帧拼接；关：你自己滚页面。会话中控制条仍可临时切换',
    options: [
      { value: true, label: '开' },
      { value: false, label: '关' },
    ] },
  { id: 'lsStep', page: 'longshot', type: 'seg', key: 'screenshot.ls-step', def: 'standard',
    title: '自动滚动步长', desc: '每格位移约占选区高度：标准最稳；更密更清晰更慢；更快省帧，复杂页可能断档。拼接失败时先退回「标准」',
    options: [
      { value: 'dense', label: '更密' },
      { value: 'standard', label: '标准' },
      { value: 'fast', label: '更快' },
    ] },
  { id: 'lsDone', page: 'longshot', type: 'seg', key: 'screenshot.ls-on-done', def: 'editor',
    title: '完成后默认动作', desc: '点「完成」或滚动到底自动结束时：进编辑器可继续标注；直接复制则写入剪贴板并退出',
    options: [
      { value: 'editor', label: '进入编辑器' },
      { value: 'clipboard', label: '直接复制' },
    ] },
  { id: 'recCd', page: 'record', type: 'seg', key: 'screenshot.rec-countdown', def: 3,
    title: '开始前倒计时', desc: '点录屏后先显示倒计时；0 秒 = 立即开始',
    options: [
      { value: 0, label: '0' },
      { value: 1, label: '1 秒' },
      { value: 3, label: '3 秒' },
      { value: 5, label: '5 秒' },
    ] },
  { id: 'recQ', page: 'record', type: 'seg', key: 'screenshot.rec-quality', def: 'balanced',
    title: '画质', desc: '影响 WebM 码率与体积：流畅约 4 Mbps，均衡约 8 Mbps，清晰约 16 Mbps',
    options: [
      { value: 'smooth', label: '流畅' },
      { value: 'balanced', label: '均衡' },
      { value: 'sharp', label: '清晰' },
    ] },
  { id: 'recMode', page: 'record', type: 'seg', key: 'screenshot.rec-save-mode', def: 'dialog',
    title: '保存方式', desc: '每次询问：弹出「另存为」；固定文件夹：直接写入「通用 → 保存」里配置的录屏目录并提示文件名',
    options: [
      { value: 'dialog', label: '每次询问' },
      { value: 'folder', label: '固定文件夹' },
    ] },
  { id: 'recPrefix', page: 'record', type: 'text', key: 'screenshot.rec-filename-prefix', def: '拾花录屏',
    title: '文件名前缀', desc: '固定文件夹模式：文件名 = 前缀 + 时间戳 + .webm' },
  { id: 'ocrSvc', page: 'ocr', type: 'status', key: '', def: null,
    title: '识别服务', desc: '本机识别服务运行状态；异常时点「重启」，约 3~6 秒恢复',
    detail: '常驻内存约 440MB（空闲时系统会自动回收部分）。识别失败时应用会自动拉起服务，一般无需手动重启。' },
  { id: 'ocrWarm', page: 'ocr', type: 'radio', key: 'screenshot-ocr-warmup', def: 'capture-prewarm', grid3: true,
    title: '识别性能档位', desc: '控制模型何时加载，切换后下次截图生效',
    options: [
      { value: 'resident', label: '常驻', badges: ['最快'], badgeTone: ['gray'], desc: '启动即加载',
        detail: '应用启动即加载模型（内存约 440MB），识别零等待。适合重度使用。' },
      { value: 'capture-prewarm', label: '截图时预热', badges: ['推荐'], badgeTone: ['pink'], desc: '框选时间覆盖加载',
        detail: '按下截图热键时后台加载（约 2 秒，框选时间足够覆盖），平时不占内存。' },
      { value: 'on-demand', label: '按需', badges: ['零占用'], badgeTone: ['gray'], desc: '点识别才加载',
        detail: '点「识别」才加载模型；不截图就不占内存，首次识别多等约 2 秒。' },
    ] },
  { id: 'ocrEngineChain', page: 'ocr', type: 'chain', key: 'screenshot-ocr-engine-chain',
    def: ['rapidocr', 'wxocr', 'wmocr', 'tesseract', 'paddle'],
    title: '识别引擎优先级', desc: '按顺序依次尝试，失败自动换下一个；不可用引擎自动排到最后，恢复后回到原位。云端识别只在排首位时显式使用，本地失败不会自动上云',
    options: [
      { value: 'rapidocr', label: 'RapidOCR', badges: ['内置', '离线', '推荐'], badgeTone: ['green', 'green', 'pink'], desc: '内置模型 · 离线可用',
        detail: '内置 PP-OCRv6-small 模型（约 31MB），GPU 加速。基准实测：常规文本约 190ms，综合最准。' },
      { value: 'wxocr', label: '微信 OCR', badges: ['离线', '小字准'], badgeTone: ['green', 'gray'], desc: '离线可用 · 中文与小字更准',
        detail: '微信内置 OCR 内核（组件随应用提供，不依赖微信运行）。离线可用；小字号文字最准；首次调用约 0.8s，之后复用进程很快。' },
      { value: 'wmocr', label: '系统 OCR', badges: ['离线', '最快'], badgeTone: ['green', 'gray'], desc: 'Windows 内置引擎 · 需系统中文语言包',
        detail: 'Windows 系统自带引擎（约 140ms，最快），离线可用。需系统安装中文 OCR 语言包；小字号错误率较高。' },
      { value: 'tesseract', label: 'Tesseract', badges: ['轻量'], badgeTone: ['gray'], desc: '进程内备用引擎 · 需下载语言包',
        detail: '进程内 WASM 引擎（识别时内存约 260MB，用完自动释放）。需在「识别资源」下载语言包（7.4MB）；小字较弱，适合其他引擎都不可用时使用。' },
      { value: 'paddle', label: 'PaddleOCR', badges: ['离线'], badgeTone: ['green'], desc: '精度与 RapidOCR 相当 · 内存占用更高',
        detail: '独立模型包（4.1GB），CUDA GPU 推理。精度与 RapidOCR 相当，但运行内存约 1.4GB、冷启动 7~10 秒，适合作为备选。' },
      { value: 'server', label: '云端识别', badges: ['需登录', '联网'], badgeTone: ['gray', 'gray'], desc: '服务端 OCR · 仅显式使用，绝不自动上云',
        detail: '把截图上传到服务端识别（需登录账号）。只在排在第一位时使用；本地引擎失败不会自动上传到云端。' },
    ] },
  { id: 'ocrAct', page: 'ocr', type: 'select', key: 'screenshot-ocr-default-action', def: 'text',
    title: '默认识别动作', desc: '工具栏识别主按钮执行的动作；其余仍可从 ▾ 菜单选择',
    options: [
      { value: 'text', label: '文字识别' },
      { value: 'table', label: '表格识别' },
      { value: 'smart', label: '智能识别' },
    ] },
  { id: 'tblFmt', page: 'ocr', type: 'seg', key: 'screenshot.table-copy-format', def: 'html',
    title: '表格复制格式', desc: '表格识别后「复制」的默认格式',
    options: [
      { value: 'html', label: '带边框 HTML' },
      { value: 'tsv', label: '纯 TSV' },
    ] },
  { id: 'smartH', page: 'ocr', type: 'seg', key: 'screenshot.smart-headings', def: true,
    title: '智能识别标题层级', desc: 'Markdown 输出时标题是否渲染为 ##',
    options: [
      { value: true, label: '保留 ##' },
      { value: false, label: '纯文本' },
    ] },
  { id: 'ocrModels', page: 'ocr', type: 'models', key: '', def: null,
    title: '识别资源', desc: '表格/智能版面模型与本机服务状态；缺失时在卡片内直接下载' },
  { id: 'fbFreeTr', page: 'translate', type: 'toggle', key: 'screenshot-fallback-freetranslate', def: true, f2Only: true,
    title: '免 key 翻译兜底', desc: '本地翻译引擎不可用时，改走 Edge / MyMemory 公共翻译接口（无需配置密钥）；关闭后翻译失败直接提示' },
  { id: 'askModes', page: 'ai', type: 'link', key: '', def: null, f2Only: true,
    title: '自定义识别模板', desc: '问 AI 的 6 个预设模板存于此文件，可增删改（保存后下一次识别即生效）' },
  { id: 'trEngine', page: 'translate', type: 'radio', key: 'screenshot-translate-engine', def: 'local',
    title: '翻译引擎', desc: '将截图文字原位翻译并擦写回填。本地 Hy-MT2 约 1.1GB，适合无网/隐私场景；只想偶尔翻译、不想占磁盘可改云端（免费额度）',
    options: [
      { value: 'local', label: '本地端侧', badges: ['离线', '需大模型'], badgeTone: ['green', 'gray'], desc: 'Hy-MT2 ~1.1GB · 无次数限制 · 需 D:\\llama 模型' },
      { value: 'cloud', label: '云端百度翻译', badges: ['轻量', '免费额度'], badgeTone: ['pink', 'green'], desc: '无需下载大模型 · 填密钥即用 · 失败可回退' },
    ] },
  { id: 'trRender', page: 'translate', type: 'seg', key: 'screenshot.translate-render', def: 'overlay',
    title: '译文呈现方式', desc: '叠回原图：本地把译文擦写画回截图；仅文本面板：只在识别结果里出译文，不改原图',
    options: [
      { value: 'overlay', label: '叠回原图' },
      { value: 'panel', label: '仅文本面板' },
    ] },
  { id: 'trAppId', page: 'translate', type: 'text', key: 'screenshot-cloud-translate-appid', def: '',
    title: '云端 App ID', desc: 'fanyi-api.baidu.com 申请；密钥仅保存在本机',
    cloudOnly: true, placeholder: '百度翻译 APP ID' },
  { id: 'trSecret', page: 'translate', type: 'password', key: 'screenshot-cloud-translate-secret', def: '',
    title: '云端密钥', desc: '与 App ID 配对；云端失败时自动回退本地引擎',
    cloudOnly: true, placeholder: '百度翻译密钥' },
  { id: 'trSrc', page: 'translate', type: 'select', key: 'screenshot-translate-source-lang', def: 'auto',
    title: '源语言', desc: '「自动检测」适合中英混排截图',
    options: [
      { value: 'auto', label: '自动检测' },
      { value: 'zh', label: '中文' },
      { value: 'en', label: 'English' },
      { value: 'ja', label: '日本語' },
    ] },
  { id: 'trTgt', page: 'translate', type: 'select', key: 'screenshot-translate-target-lang', def: 'zh',
    title: '目标语言', desc: '与截图面板语言下拉双向同步（同时写 screenshot-text-translate-target-lang）',
    options: [
      { value: 'zh', label: '中文' },
      { value: 'en', label: 'English' },
      { value: 'ja', label: '日本語' },
      { value: 'ko', label: '한국어' },
    ] },
  { id: 'aiBase', page: 'ai', type: 'text', key: 'screenshot-ask-ai-base-url', def: 'https://api.openai.com/v1',
    title: 'API 地址', desc: 'OpenAI 兼容接口根地址（到 /v1 为止）。官方、各家大模型中转、本地 Ollama 均可',
    placeholder: 'https://api.openai.com/v1' },
  { id: 'aiKey', page: 'ai', type: 'password', key: 'screenshot-ask-ai-key', def: '',
    title: 'API 密钥', desc: '仅保存在本机；截图与问题由主进程直连你填的服务商，不经第三方',
    placeholder: 'sk-…' },
  { id: 'aiModel', page: 'ai', type: 'text', key: 'screenshot-ask-ai-model', def: '',
    title: '模型名', desc: '需支持图片输入的视觉模型，如 gpt-4o-mini / glm-4v-flash / qwen-vl-plus',
    placeholder: 'gpt-4o-mini' },
];

const PAGES = [
  { id: 'general', label: '通用' },
  { id: 'capture', label: '截图' },
  { id: 'longshot', label: '长截图' },
  { id: 'record', label: '录屏' },
  { id: 'ocr', label: '识别' },
  { id: 'translate', label: '翻译' },
  { id: 'ai', label: 'AI 问答' },
  { id: 'about', label: '关于' },
];

const values = {};
let currentPage = 'general';
// 托盘「识别设置…」/「关于」直达：settings.html?page=ocr
(() => {
  try {
    const q = new URLSearchParams(location.search).get('page');
    if (q && PAGES.some((p) => p.id === q)) currentPage = q;
  } catch { /* ignore */ }
})();
let capturingHotkey = false;
let lastHotkey = 'Alt+Q';
let lastModels = null;
/** 宿主能力探测（settings:capabilities）：Tauri 宿主返回兜底/模板能力；
 *  Electron 主线无此通道 → null → f2Only 行全部隐藏（settings.js 双份同源的关键） */
let f2Caps = null;

async function storeRead(key) {
  try { return await ipcRenderer.invoke('store:read', key); } catch { return undefined; }
}
async function storeWrite(key, value) {
  try { return await ipcRenderer.invoke('store:write', key, value); }
  catch (err) { console.error('[Settings] store write', key, err); return false; }
}
function defById(id) { return DEFS.find((d) => d.id === id); }

async function loadAll() {
  try {
    f2Caps = (await ipcRenderer.invoke('settings:capabilities')) || null;
  } catch { f2Caps = null; } // Electron 主线：无此通道 → F2 专属行隐藏
  if (f2Caps && f2Caps.askModesPath) values.askModes = f2Caps.askModesPath;
  for (const d of DEFS) {
    if (!d.key || d.persist === false) { values[d.id] = d.def; continue; }
    const raw = await storeRead(d.key);
    values[d.id] = (raw === undefined || raw === null) ? d.def : raw;
  }
  try {
    const hk = await ipcRenderer.invoke('screenshot-hotkey:get');
    if (typeof hk === 'string' && hk) { values.hotkey = hk; lastHotkey = hk; }
  } catch { /* ignore */ }
  try {
    const on = await ipcRenderer.invoke('settings:getLoginItem');
    values.autostart = on ? 'on' : 'off';
  } catch { /* ignore */ }
}

async function persist(d, value) {
  values[d.id] = value;
  console.log('[Settings] persist', d.id, value);
  if (d.id === 'hotkey') {
    const ok = await ipcRenderer.invoke('screenshot-hotkey:set', value);
    if (ok) lastHotkey = value;
    return ok;
  }
  if (d.id === 'autostart') {
    await ipcRenderer.invoke('settings:setLoginItem', value === 'on');
    return true;
  }
  if (!d.key) return true;
  if (d.id === 'trTgt') await storeWrite('screenshot-text-translate-target-lang', value);
  if (d.id === 'ocrEngineChain') {
    // 同步旧单值键（迁移期兼容）：仍读 screenshot-ocr-engine 的旧路径语义保持一致
    const first = Array.isArray(value) && value.length ? value[0] : 'rapidocr';
    await storeWrite('screenshot-ocr-engine', first === 'server' ? 'server' : first === 'paddle' ? 'paddleocr' : 'local');
  }
  return storeWrite(d.key, value);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function badgeHtml(label, tone) {
  const cls = tone === 'green' ? 'badge-green' : tone === 'pink' ? 'badge-pink' : 'badge-gray';
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

/** 引擎优先级链编辑器（2026-11-22 第二批：状态化）：
 *  容器先渲染占位，loadChainList() 拉取 ocr:chain-status 后按状态渲染——
 *  可用引擎在前（绿点），不可用沉底显示（灰=可恢复/未下载，红=故障），未下载项带下载按钮。
 *  存储数组始终保持用户完整顺序；执行层会按同样规则把不可用引擎排后尝试。 */
let chainStatusCache = null;
let chainStatusAt = 0;

async function loadChainStatus(force) {
  if (!force && chainStatusCache && Date.now() - chainStatusAt < 15000) return chainStatusCache;
  try {
    chainStatusCache = await ipcRenderer.invoke('ocr:chain-status') || {};
  } catch {
    chainStatusCache = {};
  }
  chainStatusAt = Date.now();
  return chainStatusCache;
}

function chainStateBadge(st) {
  if (!st) return '';
  if (st.state === 'ready') return '<span class="badge badge-green">可用</span>';
  if (st.state === 'missing') return '<span class="badge badge-gray">未下载</span>';
  if (st.state === 'error') return '<span class="badge badge-red">异常</span>';
  return '<span class="badge badge-gray">暂不可用</span>';
}

function chainRowHtml(id, o, st, pos, total) {
  const disabled = st && st.state !== 'ready';
  const dl = st && st.downloadable && st.state !== 'ready'
    ? `<button type="button" class="chain-btn chain-dl" data-chain-dl="${esc(id === 'tesseract' ? 'tessdata' : id)}" title="下载所需资源">⬇</button>`
    : '';
  // 悬停补充：引擎详情 + 当前状态原因（无内容就不绑）
  const tipBits = [o.detail, st && st.reason].filter((x) => x && x !== o.desc);
  const tip = tipBits.length ? ` data-tip="${esc(tipBits.join('\n'))}"` : '';
  return `<div class="chain-row${disabled ? ' is-disabled' : ''}" data-engine="${esc(id)}">
    <span class="chain-order">${pos + 1}</span>
    <span class="chain-body"${tip}>
      <span class="radio-title">${esc(o.label)} ${(o.badges || []).map((b, i) => badgeHtml(b, (o.badgeTone || [])[i])).join('')}${chainStateBadge(st)}</span>
      <span class="radio-desc">${esc(o.desc || '')}${st && st.reason && st.reason !== o.desc ? `${o.desc ? ' · ' : ''}${esc(st.reason)}` : ''}</span>
    </span>
    <span class="chain-btns">
      ${dl}
      <button type="button" class="chain-btn" data-chain-up="${pos}"${pos === 0 ? ' disabled' : ''} title="上移（提高优先级）">↑</button>
      <button type="button" class="chain-btn" data-chain-down="${pos}"${pos === total - 1 ? ' disabled' : ''} title="下移（降低优先级）">↓</button>
    </span>
  </div>`;
}

/** 本壳可执行的引擎（设置页只显示这些；其余引擎保留在存储里供另一壳使用） */
function chainVisibleIds() {
  return f2Caps
    ? ['rapidocr', 'wxocr', 'wmocr', 'paddle']
    : ['rapidocr', 'tesseract', 'paddle', 'server'];
}

async function loadChainList(force) {
  const d = defById('ocrEngineChain');
  const box = document.getElementById('chainList');
  if (!d || !box) return;
  const status = await loadChainStatus(force);
  const visibleIds = chainVisibleIds();
  const stored = Array.isArray(values[d.id]) && values[d.id].length ? values[d.id] : d.def;
  const hiddenTail = stored.filter((id) => !visibleIds.includes(id)); // 本壳不可见的引擎：原顺序保留
  const visibleStored = stored.filter((id) => visibleIds.includes(id));
  // 显示分区：可用在前、不可用沉底（各自保持存储相对顺序）；存储数组不动
  const ready = visibleStored.filter((id) => !(status[id] && status[id].state !== 'ready'));
  const deferred = visibleStored.filter((id) => status[id] && status[id].state !== 'ready');
  const display = [...ready, ...deferred];
  let html = display.map((id, idx) => {
    const o = d.options.find((x) => x.value === id);
    if (!o) return '';
    return chainRowHtml(id, o, status[id], idx, display.length);
  }).join('');
  if (deferred.length) {
    html = html.replace(
      new RegExp(`(<div class="chain-row" data-engine="${esc(deferred[0])}")`),
      '<div class="chain-sep">以下引擎暂不可用，会自动排到最后尝试：</div>$1',
    );
  }
  box.innerHTML = html;
  bindChainList(d, display, hiddenTail);
}

function bindChainList(d, display, hiddenTail) {
  const box = document.getElementById('chainList');
  if (!box) return;
  box.querySelectorAll('[data-chain-up],[data-chain-down]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      const isUp = btn.dataset.chainUp !== undefined;
      const pos = Number(isUp ? btn.dataset.chainUp : btn.dataset.chainDown);
      const j = pos + (isUp ? -1 : 1);
      if (pos >= display.length || j < 0 || j >= display.length) return;
      const arr = [...display];
      [arr[pos], arr[j]] = [arr[j], arr[pos]];
      // 本壳不可见的引擎追加回尾部，另一壳的顺序不受影响
      await persist(d, [...arr, ...(hiddenTail || [])]);
      void loadChainList(true);
    });
  });
  box.querySelectorAll('[data-chain-dl]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.chainDl;
      btn.disabled = true;
      btn.textContent = '…';
      try {
        const res = id === 'tessdata'
          ? await ipcRenderer.invoke('ocr:langpack-download')
          : await ipcRenderer.invoke('ocr:model-download', id);
        if (res && res.ok === true) notify('下载完成', 'success', btn);
        else notify(`下载失败：${(res && res.message) || '未知错误'}`, 'error', btn);
      } catch (err) {
        console.warn('[Settings] chain asset download error:', id, err);
      }
      void loadChainList(true);
      void refreshModels(0);
    });
  });
  bindInfoDots(box);
}

function renderNav() {
  const nav = document.getElementById('sideNav');
  nav.innerHTML = PAGES.map((p) => `
    <li>
      <button class="side-item${p.id === currentPage ? ' is-active' : ''}" type="button" data-page="${p.id}">
        <svg viewBox="0 0 24 24" class="ico">${ICONS[p.id] || ICONS.general}</svg>
        <span>${esc(p.label)}</span>
      </button>
    </li>
  `).join('');
  nav.querySelectorAll('.side-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.page;
      if (next === currentPage) return;
      currentPage = next;
      renderNav();
      // 切换分区时滚回顶部，避免「识别页滚到底 → 切页仍停在底部」
      const main = document.getElementById('main');
      if (main) main.scrollTop = 0;
      renderMain();
    });
  });
}

function controlHtml(d) {
  const v = values[d.id];
  switch (d.type) {
    case 'seg':
      return `<div class="seg" data-id="${d.id}" role="group">${
        d.options.map((o) => `<button type="button" class="seg-item${v === o.value ? ' is-on' : ''}" data-raw="${toAttr(o.value)}" data-idx="${d.options.indexOf(o)}">${esc(o.label)}</button>`).join('')
      }</div>`;
    case 'select':
      return `<div class="select" tabindex="0" data-id="${d.id}" data-select>
        <span class="select-value">${esc((d.options.find((o) => o.value === v) || d.options[0]).label)}</span>
        <svg class="select-chevron" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
      </div>`;
    case 'toggle':
      return `<button type="button" class="toggle" role="switch" aria-checked="${v ? 'true' : 'false'}" data-id="${d.id}"></button>`;
    case 'hotkey': {
      const btnId = d.id === 'hotkeyCopy' ? 'hotkeyCopyBtn' : 'hotkeyBtn';
      const okId = d.id === 'hotkeyCopy' ? 'hotkeyCopyOk' : 'hotkeyOk';
      const editable = d.id !== 'hotkeyCopy';
      return `<div class="hotkey-wrap">
        <button type="button" class="hotkey${editable ? '' : ' is-readonly'}" id="${btnId}"${editable ? '' : ' disabled title="当前版本固定为 Alt+C"'}>${esc(v)}</button>
        <span class="hotkey-ok" id="${okId}"><svg viewBox="0 0 24 24" class="ico">${ICONS.check}</svg></span>
      </div>`;
    }
    case 'radio':
      return `<div class="radio-grid${d.grid3 ? ' radio-grid-3' : ''}" data-id="${d.id}">
        ${d.options.map((o, idx) => `
          <button type="button" class="radio-card${v === o.value ? ' is-on' : ''}" data-idx="${idx}"${o.detail ? ` data-tip="${esc(o.detail)}"` : ''}>
            <span class="radio-dot"></span>
            <span class="radio-body">
              <span class="radio-title">${esc(o.label)} ${(o.badges || []).map((b, i) => badgeHtml(b, (o.badgeTone || [])[i])).join('')}</span>
              ${o.desc ? `<span class="radio-desc">${esc(o.desc)}</span>` : ''}
            </span>
          </button>
        `).join('')}
      </div>`;
    case 'chain':
      return `<div class="chain-list" id="chainList" data-id="${d.id}"><div class="chain-row is-loading">检测引擎状态…</div></div>`;
    case 'text':
    case 'password':
      return `<input class="input" type="${d.type === 'password' ? 'password' : 'text'}" data-id="${d.id}"
        value="${esc(v)}" placeholder="${esc(d.placeholder || '')}" />`;
    case 'path':
      return `<div class="path-actions">
        <span class="path-text" data-path-text="${d.id}">${esc(v || '系统「视频」')}</span>
        <button type="button" class="btn" data-pick="${d.id}">更改…</button>
        <button type="button" class="btn" data-open="${d.id}">打开</button>
      </div>`;
    case 'status':
      return `<div class="svc-row">
        <span class="dot" id="svcDot"></span>
        <div class="svc-main">
          <div class="svc-title" id="svcText">检测中…</div>
          <div class="svc-sub" id="svcSub"></div>
        </div>
        <button type="button" class="btn" id="btnOpenLog">日志</button>
        <button type="button" class="btn" id="btnRestartOcr">重启</button>
      </div>`;
    case 'models':
      return `<div class="collapse" id="resCollapse">
        <div class="collapse-head" id="resHead">
          <span class="chev">▶</span>
          <span class="card-label" style="margin:0">模型与语言包</span>
          <span class="collapse-summary" id="resSummary"></span>
        </div>
        <div class="collapse-body">
          <div class="models-list" id="modelsList"><div class="model-row">检测中…</div></div>
        </div>
      </div>`;
    case 'saveCard':
      return `<div class="collapse" id="saveCollapse">
        <div class="collapse-head" id="saveHead">
          <span class="chev">▶</span>
          <span class="card-label" style="margin:0">保存</span>
          <span class="collapse-summary" id="saveCardSummary"></span>
        </div>
        <div class="collapse-body">
          <div id="saveCardBox"><div class="save-row is-loading">读取中…</div></div>
          <div class="save-btns">
            <button type="button" class="btn primary" id="btnSaveChange">更改…</button>
            <button type="button" class="btn" id="btnSaveReset">恢复默认</button>
            <button type="button" class="btn" id="btnSaveOpen">打开目录</button>
          </div>
          <div class="save-backup-label">设置备份</div>
          <div class="backup-actions">
            <button type="button" class="btn primary" id="btnBackupNow">立即备份</button>
            <button type="button" class="btn" id="btnBackupExport">导出设置…</button>
            <button type="button" class="btn" id="btnBackupImport">导入设置…</button>
          </div>
          <div class="backup-list-head">最近备份 <button type="button" class="btn" id="btnBackupRefresh" style="padding:2px 10px;font-size:12px">刷新</button></div>
          <div id="backupList"><div class="asset-note">读取中…</div></div>
          <div style="height:8px"></div>
        </div>
      </div>`;
    case 'link':
      // 打开一个宿主返回的文件/目录路径（values[id] 由 settings:capabilities 装载）
      return `<div class="path-actions"><button type="button" class="btn" data-open="${d.id}">打开</button></div>`;
    default:
      return '';
  }
}

function isCloud() { return values.trEngine === 'cloud'; }

/** 行：左说明 + 右控件 */
/** 说明浮层（2026-11-22 定稿）：desc 平铺（精简版），详细补充放 DEFS 的 detail 字段——
 *  悬停在功能区域（卡片/引擎行/单选卡，带 data-tip）停留约 0.4s 显示，移开即消失。 */
let infoTipEl = null;
let infoTipTimer = 0;

function showInfoTip(text, anchor) {
  if (!text) return;
  if (!infoTipEl) {
    infoTipEl = document.createElement('div');
    // 独立 id：与操作反馈 #stToast 分家（2026-11-25 修「两条浮层同时挂在屏幕上」）
    infoTipEl.id = 'stHoverTip';
    document.body.appendChild(infoTipEl);
  }
  infoTipEl.textContent = text;
  infoTipEl.classList.add('is-show');
  // 定位：锚点正下方，右缘与锚点对齐（贴窗口边缘时向左收）
  const r = anchor.getBoundingClientRect();
  requestAnimationFrame(() => {
    if (!infoTipEl) return;
    infoTipEl.style.top = `${Math.min(r.bottom + 8, window.innerHeight - 110)}px`;
    const left = Math.max(12, r.right - infoTipEl.offsetWidth);
    infoTipEl.style.left = `${Math.min(left, window.innerWidth - infoTipEl.offsetWidth - 12)}px`;
  });
}

function hideInfoTip() {
  clearTimeout(infoTipTimer);
  if (infoTipEl) infoTipEl.classList.remove('is-show');
}

/** 悬停绑定：停留 400ms 才显示（避免扫过时闪烁），移开立即隐藏；
 *  从子区域（如档位单选卡）移回父卡片时，立即切换显示父级补充，不闪断。 */
/** 操作反馈浮层（2026-11-25 改版）：success 绿✓ / error 红✗ / info 灰。
 *  位置固定在**面板下方居中**，不再锚定按钮（锚定版会盖住「最近备份」标题与列表首行）。
 *  第三参 anchor 保留只为兼容既有 16 处调用点，实际忽略。
 *  第四参 action = {label, onClick}：挂一个可点按钮（如删除后的「撤销」），此时整条可交互、停留 6s。 */
function notify(text, type = 'info', _anchor, action) {
  let t = document.getElementById('stToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'stToast';
    document.body.appendChild(t);
  }
  const icon = type === 'success' ? '✓ ' : type === 'error' ? '✗ ' : '';
  t.textContent = '';
  const span = document.createElement('span');
  span.className = 'st-toast-text';
  span.textContent = icon + text;
  t.appendChild(span);
  const hasAct = !!(action && action.label && typeof action.onClick === 'function');
  if (hasAct) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'st-toast-act';
    b.textContent = action.label;
    b.addEventListener('click', () => {
      clearTimeout(notify._t);
      t.classList.remove('is-show');
      try { action.onClick(); } catch (err) { console.warn('[Settings] toast action failed', err); }
    });
    t.appendChild(b);
  }
  t.className = `is-show st-toast-${type}${hasAct ? ' has-act' : ''}`;
  clearTimeout(notify._t);
  notify._t = setTimeout(() => t.classList.remove('is-show'), hasAct ? 6000 : (type === 'error' ? 4500 : 2500));
}

function bindHoverTip(el) {
  if (el.dataset.tipBound) return;
  el.dataset.tipBound = '1';
  el.addEventListener('mouseenter', () => {
    clearTimeout(infoTipTimer);
    infoTipTimer = setTimeout(() => showInfoTip(el.dataset.tip, el), 650);
  });
  el.addEventListener('mouseleave', (e) => {
    clearTimeout(infoTipTimer);
    const rt = e.relatedTarget;
    const parentTip = rt && rt.closest ? rt.closest('[data-tip]') : null;
    if (parentTip && parentTip !== el) showInfoTip(parentTip.dataset.tip, parentTip);
    else hideInfoTip();
  });
}

/** 保存单卡（2026-11-23）：目录行配置 + 一组按钮作用于选中行 */
const SAVE_ROWS = [
  { key: 'screenshot-save-dir', label: '截图保存目录', defLabel: '默认（图片）', restart: false, openDefault: 'screenshots',
    detail: '「保存」对话框的默认位置；长截图拆分保存也写到这里。仅作用于保存，复制与贴图不落盘。' },
  { key: 'screenshot.rec-save-dir', label: '录屏保存目录', defLabel: '默认（视频）', restart: false, openDefault: 'videos',
    detail: '仅录屏「固定文件夹」模式生效。' },
  { key: 'screenshot-assets-dir', label: '下载资源目录', defLabel: '默认（随应用）', restart: true,
    detail: '表格/版面模型与语言包的下载位置。更改后自动重启识别服务；自定义目录里已有的模型优先使用。' },
  { key: 'settings-backup-dir', label: '设置备份目录', defLabel: '', restart: false, backupDefault: true,
    detail: '「立即备份」的存放位置。备份滚动保留最近 10 份，不含账号凭据。' },
];
let saveCardSel = 0;

async function loadSaveCard() {
  const box = document.getElementById('saveCardBox');
  if (!box) return;
  const vals = [];
  for (const r of SAVE_ROWS) {
    try {
      const v = await storeRead(r.key);
      vals.push(typeof v === 'string' ? v.trim() : '');
    } catch { vals.push(''); }
  }
  const customCount = vals.filter((v) => v).length;
  const summary = document.getElementById('saveCardSummary');
  if (summary) {
    summary.innerHTML = customCount === 0
      ? '<span class="badge badge-gray">全部默认</span>'
      : `<span class="badge badge-accent">${customCount} 项自定义</span>`;
  }
  const collapse = document.getElementById('saveCollapse');
  if (collapse && !collapse.dataset.init) {
    collapse.dataset.init = '1';
    collapse.classList.toggle('open', customCount > 0);
  }
  box.innerHTML = SAVE_ROWS.map((r, i) => {
    const shown = vals[i] ? esc(vals[i]) : `<span style="color:var(--st-text-3)">${esc(r.defLabel || '默认')}</span>`;
    return `<div class="save-row${i === saveCardSel ? ' is-sel' : ''}" data-save-idx="${i}" data-tip="${esc(r.detail)}">
      <span class="save-dot"></span>
      <span class="save-label">${esc(r.label)}</span>
      <span class="save-val">${shown}</span>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-save-idx]').forEach((row) => {
    row.addEventListener('click', () => {
      saveCardSel = Number(row.dataset.saveIdx);
      void loadSaveCard();
    });
  });
  bindInfoDots(box);
}

/** 备份列表（最近 10 份）：查看 + 一键恢复（恢复=整体替换，导入前自动备份可回退） */
function backupFriendlyName(name) {
  const m = name.match(/^settings-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})(-pre-import)?\.json$/);
  if (!m) return name;
  const t = `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
  return m[7] ? `${t}（导入/恢复前）` : t;
}

/** 备份行时间：一律用文件 mtime（毫秒）转本地时间。
 *  不再解析文件名 —— 历史上 F2 生成过 settings-2001-12-06-… 这种错年份文件名，
 *  解析名字会把错误一直显示下去；文件名只留作 title 供排查。 */
function backupWhen(mtime, name) {
  const ms = Number(mtime) || 0;
  if (ms > 0) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  return backupFriendlyName(name);
}

async function loadBackupList() {
  const box = document.getElementById('backupList');
  if (!box) return;
  try {
    const items = await ipcRenderer.invoke('settings:backup-list');
    if (!Array.isArray(items) || items.length === 0) {
      box.innerHTML = '<div class="asset-note">还没有备份——点「立即备份」生成第一份</div>';
      return;
    }
    box.innerHTML = items.map((it) => {
      const size = it.size > 0 ? `${(it.size / 1024).toFixed(1)} KB` : '';
      return `<div class="backup-row">
        <span class="backup-name" title="${esc(it.name)}">${esc(backupWhen(it.mtime, it.name))}</span>
        <span class="backup-size">${esc(size)}</span>
        <button type="button" class="btn" data-backup-restore="${esc(it.name)}">恢复</button>
        <button type="button" class="btn" data-backup-delete="${esc(it.name)}">删除</button>
      </div>`;
    }).join('');
    box.querySelectorAll('[data-backup-restore]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.backupRestore;
        if (btn.dataset.busy === '1') return;
        btn.dataset.busy = '1';
        btn.disabled = true;
        btn.textContent = '恢复中…';
        try {
          const res = await ipcRenderer.invoke('settings:backup-restore', name);
          if (res?.ok) {
            notify(`已恢复 ${res.count ?? 0} 项设置（已自动留回退备份），重启应用后生效`, 'success');
          } else if (res?.needMerge) {
            // 跨壳/旧版备份：默认拦下，给「仍要恢复（合并）」而不是直接整体替换
            notify(res.message || '该备份来源不同，建议按键合并', 'error', null, {
              label: '仍要恢复（合并）',
              onClick: async () => {
                try {
                  const r2 = await ipcRenderer.invoke('settings:backup-restore', { name, merge: true });
                  if (r2?.ok) notify(`已合并 ${r2.count ?? 0} 项设置（保留原有其它设置），重启应用后生效`, 'success');
                  else notify(`合并失败：${r2?.message || '未知错误'}`, 'error');
                } catch (err) {
                  notify(`合并失败：${err instanceof Error ? err.message : String(err)}`, 'error');
                }
                void loadBackupList();
              },
            });
          } else {
            notify(`恢复失败：${res?.message || '未知错误'}`, 'error');
          }
        } catch (err) {
          notify(`恢复失败：${err instanceof Error ? err.message : String(err)}`, 'error');
        }
        void loadBackupList();
      });
    });
    // 手动删除（2026-11-25）：零弹窗，删完在底部浮层给 6s「撤销」
    box.querySelectorAll('[data-backup-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.backupDelete;
        if (btn.dataset.busy === '1') return;
        btn.dataset.busy = '1';
        btn.disabled = true;
        try {
          const res = await ipcRenderer.invoke('settings:backup-delete', name);
          if (res?.ok) {
            notify('已删除该备份', 'success', null, {
              label: '撤销',
              onClick: async () => {
                try {
                  const u = await ipcRenderer.invoke('settings:backup-undo', res.token);
                  if (u?.ok) notify('已还原该备份', 'success');
                  else notify(`撤销失败：${u?.message || '未知错误'}`, 'error');
                } catch (err) {
                  notify(`撤销失败：${err instanceof Error ? err.message : String(err)}`, 'error');
                }
                void loadBackupList();
              },
            });
          } else {
            notify(`删除失败：${res?.message || '未知错误'}`, 'error');
            btn.disabled = false;
            btn.dataset.busy = '';
          }
        } catch (err) {
          notify(`删除失败：${err instanceof Error ? err.message : String(err)}`, 'error');
          btn.disabled = false;
          btn.dataset.busy = '';
        }
        void loadBackupList();
      });
    });
  } catch {
    box.innerHTML = '<div class="asset-note">备份列表读取失败</div>';
  }
}

function bindSaveCard() {
  const head = document.getElementById('saveHead');
  if (head && !head.dataset.bound) {
    head.dataset.bound = '1';
    head.addEventListener('click', () => document.getElementById('saveCollapse')?.classList.toggle('open'));
  }
  const sel = () => SAVE_ROWS[saveCardSel] || SAVE_ROWS[0];
  // 连击防抖：1s 内忽略重复点击（配合 Rust 侧同路径去重）
  const debounced = (btn, fn) => {
    if (!btn || btn.dataset.busy === '1') return;
    btn.dataset.busy = '1';
    btn.disabled = true;
    // 禁用直到对话框返回（模态对话框期间保持禁用，返回后立刻恢复）
    Promise.resolve(fn()).catch(() => {}).finally(() => {
      btn.dataset.busy = '0';
      btn.disabled = false;
    });
  };
  const change = document.getElementById('btnSaveChange');
  if (change && !change.dataset.bound) {
    change.dataset.bound = '1';
    change.addEventListener('click', () => debounced(change, async () => {
      try {
        const dir = await ipcRenderer.invoke('settings:pickFolder');
        if (typeof dir === 'string' && dir) {
          await storeWrite(sel().key, dir);
          if (sel().restart) void ipcRenderer.invoke('ocr:restart').catch(() => {});
          void loadSaveCard();
          notify(`已更新：${sel().label}`, 'success', change);
        }
      } catch (err) { console.warn('[Settings] save dir pick', err); }
    }));
  }
  const reset = document.getElementById('btnSaveReset');
  if (reset && !reset.dataset.bound) {
    reset.dataset.bound = '1';
    reset.addEventListener('click', () => debounced(reset, async () => {
      try {
        await storeWrite(sel().key, '');
        if (sel().restart) void ipcRenderer.invoke('ocr:restart').catch(() => {});
        void loadSaveCard();
        notify(`已恢复默认：${sel().label}`, 'success', reset);
      } catch (err) { console.warn('[Settings] save dir reset', err); }
    }));
  }
  const open = document.getElementById('btnSaveOpen');
  if (open && !open.dataset.bound) {
    open.dataset.bound = '1';
    open.addEventListener('click', () => debounced(open, async () => {
      try {
        const r = sel();
        let target = '';
        try { const v = await storeRead(r.key); target = typeof v === 'string' ? v.trim() : ''; } catch { /* ignore */ }
        if (target) {
          void ipcRenderer.invoke('settings:openPath', target);
        } else if (r.backupDefault) {
          const dir = await ipcRenderer.invoke('settings:backup-dir');
          void ipcRenderer.invoke('settings:openPath', dir);
        } else if (r.openDefault) {
          void ipcRenderer.invoke('settings:openPath', r.openDefault);
        } else {
          showInfoTip('默认随应用内置；点「更改…」选择目录后可在此打开', open);
          setTimeout(() => hideInfoTip(), 3200);
        }
      } catch (err) { console.warn('[Settings] save dir open', err); }
    }));
  }
}

function bindInfoDots(scope) {
  (scope || document).querySelectorAll('[data-tip]').forEach(bindHoverTip);
}

function rowHtml(d) {
  return `<div class="row">
    <div class="row-text">
      <div class="row-title">${esc(d.title)}</div>
      ${d.desc ? `<div class="row-desc">${esc(d.desc)}</div>` : ''}
    </div>
    <div class="row-ctl">${controlHtml(d)}</div>
  </div>`;
}

/** 单选组：标题/说明 + 全宽卡片组（不塞进 row-ctl，避免挤爆） */
function radioBlockHtml(d) {
  return `<div class="card"${d.detail ? ` data-tip="${esc(d.detail)}"` : ''}>
    <div class="card-head">
      <div class="card-label">${esc(d.title)}</div>
      ${d.desc ? `<div class="card-sub">${esc(d.desc)}</div>` : ''}
    </div>
    ${controlHtml(d)}
    <div style="height:14px"></div>
  </div>`;
}

function renderMain() {
  const main = document.getElementById('main');
  if (currentPage === 'about') {
    main.innerHTML = `
      <section class="page is-active">
        <h1 class="page-title">关于</h1>
        <div class="card about-hero">
          <img class="about-logo" src="./icon/logo-256.png" alt="" width="64" height="64" />
          <div>
            <div class="about-name">拾花 PetalSnap <span class="badge badge-pink">开发版</span></div>
            <div class="about-line" id="aboutVer">版本 …</div>
            <div class="about-line" id="aboutOcr">OCR 服务 · …</div>
            <div class="about-copy">截图 · 贴图 · 识别 · 翻译 · 长截图 · 录屏</div>
          </div>
        </div>
        <div class="card">
          <button class="link-row" type="button" id="linkLogs">
            <span class="link-left"><svg viewBox="0 0 24 24" class="ico-16">${ICONS.folder}</svg><span>打开日志目录</span></span>
            <span class="link-right">userData\\logs</span>
          </button>
          <button class="link-row" type="button" id="linkHome">
            <span class="link-left"><svg viewBox="0 0 24 24" class="ico-16">${ICONS.link}</svg><span>项目主页</span></span>
            <span class="link-right link-url">github.com/huankun05/snapshot</span>
          </button>
        </div>
        <div class="card">
          <div class="card-label">隐私说明</div>
          <p class="privacy">截图、识别与翻译默认全部在本机完成，不上传、无遥测。云端翻译仅在你主动选择并配置密钥后，把识别出的文字发送给百度翻译接口。</p>
        </div>
        <p class="about-foot">Copyright © 2026 拾花 PetalSnap</p>
      </section>`;
    document.getElementById('linkLogs').addEventListener('click', () => {
      void ipcRenderer.invoke('settings:openPath', 'logs');
    });
    document.getElementById('linkHome').addEventListener('click', () => {
      void shell.openExternal('https://github.com/huankun05/snapshot');
    });
    void loadAbout();
    return;
  }

  const list = DEFS.filter((d) => d.page === currentPage);
  const page = PAGES.find((p) => p.id === currentPage);
  const lead = currentPage === 'longshot'
    ? '滚动拼接长页面。默认值直接决定拼接成功率。'
    : currentPage === 'record'
      ? '选区录制 WebM。改完后下一次点「录屏」生效。'
      : currentPage === 'ai'
        ? '把选区截图连同问题发给你自己的大模型接口（截图 ▾ 菜单 → 问 AI）。三项都填好后即可使用。'
        : '';

  main.innerHTML = `
    <section class="page is-active">
      <h1 class="page-title">${esc(page.label)}</h1>
      ${lead ? `<p class="page-lead">${esc(lead)}</p>` : ''}
      ${currentPage === 'translate' ? '<div class="card card-tip" id="localMtHint" hidden></div>' : ''}
      ${list.map((d) => {
        if (d.f2Only && !f2Caps) return ''; // 宿主能力探测：非 Tauri 壳隐藏 F2 专属行
        if (d.cloudOnly && !isCloud()) return '';
        try {
          if (d.type === 'saveCard') return `<div class="card"${d.detail ? ` data-tip="${esc(d.detail)}"` : ''}>${controlHtml(d)}</div>`;
          if (d.type === 'radio' || d.type === 'status' || d.type === 'models') return radioBlockHtml(d);
          return `<div class="card"${d.detail ? ` data-tip="${esc(d.detail)}"` : ''}>${rowHtml(d)}</div>`;
        } catch (err) {
          // 单卡渲染异常只降级该卡，绝不白整页
          console.warn('[Settings] card render fail:', d.id, err);
          return `<div class="card"><div class="row"><div class="row-text"><div class="row-title">${esc(d.title || d.id)}</div></div></div></div>`;
        }
      }).join('')}
    </section>`;

  bindControls();
  if (currentPage === 'ocr') {
    void refreshService();
    void refreshModels();
  }
  if (currentPage === 'translate') {
    if (lastModels) updateLocalMtHint(lastModels);
    else {
      void ipcRenderer.invoke('ocr:ensure').catch(() => {});
      void (async () => {
        try {
          const h = await ipcRenderer.invoke('ocr:health');
          if (h && h.models) {
            const map = {};
            Object.values(h.models).forEach((m) => { if (m && m.id) map[m.id] = m; });
            lastModels = map;
            updateLocalMtHint(map);
          }
        } catch { /* ignore */ }
      })();
    }
  }
  // 渐进入场：先 opacity 0，再下一帧移除，避免硬闪
  const pageEl = main.querySelector('.page');
  if (pageEl) {
    pageEl.classList.remove('page-in');
    // force reflow
    void pageEl.offsetWidth;
    pageEl.classList.add('page-in');
  }
  console.log('[Settings] renderMain', currentPage, 'controls=', main.querySelectorAll('[data-id],[data-select],[data-idx]').length);
}

function bindControls() {
  document.querySelectorAll('.seg[data-id]').forEach((seg) => {
    seg.addEventListener('click', (e) => {
      const item = e.target.closest('.seg-item');
      if (!item) return;
      const d = defById(seg.dataset.id);
      const sample = d.options[0] && d.options[0].value;
      const value = fromAttr(item.dataset.raw, sample);
      seg.querySelectorAll('.seg-item').forEach((el) => el.classList.remove('is-on'));
      item.classList.add('is-on');
      void persist(d, value);
      if (d.id === 'trEngine') renderMain();
    });
  });

  document.querySelectorAll('.toggle[data-id]').forEach((tg) => {
    tg.addEventListener('click', () => {
      const d = defById(tg.dataset.id);
      const next = tg.getAttribute('aria-checked') !== 'true';
      tg.setAttribute('aria-checked', next ? 'true' : 'false');
      void persist(d, next);
    });
  });

  document.querySelectorAll('.radio-grid[data-id]').forEach((grid) => {
    grid.addEventListener('click', (e) => {
      const card = e.target.closest('.radio-card');
      if (!card) return;
      const d = defById(grid.dataset.id);
      const idx = Number(card.dataset.idx);
      const opt = d.options[idx];
      if (!opt) return;
      grid.querySelectorAll('.radio-card').forEach((el) => el.classList.remove('is-on'));
      card.classList.add('is-on');
      void persist(d, opt.value);
      if (d.id === 'trEngine') renderMain();
    });
  });

  // 引擎优先级链：状态化渲染（loadChainList 负责行 HTML 与点击绑定，见 chainBlockHtml 一族）
  if (currentPage === 'ocr') void loadChainList();
  if (currentPage === 'general') {
    void loadSaveCard();
    bindSaveCard();
    void loadBackupList();
    const btnRefresh = document.getElementById('btnBackupRefresh');
    if (btnRefresh && !btnRefresh.dataset.bound) {
      btnRefresh.dataset.bound = '1';
      btnRefresh.addEventListener('click', () => void loadBackupList());
    }
  }
  bindInfoDots();

  document.querySelectorAll('[data-select]').forEach((sel) => {
    const d = defById(sel.dataset.id);
    const valueEl = sel.querySelector('.select-value');
    const open = () => {
      document.querySelectorAll('.select-menu').forEach((m) => m.remove());
      const menu = document.createElement('div');
      menu.className = 'select-menu';
      d.options.forEach((o) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'select-menu-item' + (values[d.id] === o.value ? ' is-on' : '');
        item.textContent = o.label;
        item.addEventListener('click', () => {
          valueEl.textContent = o.label;
          menu.remove();
          sel.classList.remove('is-open');
          void persist(d, o.value);
        });
        menu.appendChild(item);
      });
      document.body.appendChild(menu);
      const r = sel.getBoundingClientRect();
      const mh = menu.offsetHeight;
      const vw = window.innerHeight;
      const spaceBelow = vw - r.bottom - 8;
      const spaceAbove = r.top - 8;
      // 空间不够就向上开，避免被窗口底边裁切
      if (spaceBelow < mh && spaceAbove > spaceBelow) {
        menu.style.top = `${Math.max(8, r.top - mh - 4)}px`;
        menu.classList.add('is-up');
      } else {
        menu.style.top = `${r.bottom + 4}px`;
      }
      menu.style.left = `${r.left}px`;
      menu.style.minWidth = `${r.width}px`;
      sel.classList.add('is-open');
      const onDoc = (ev) => {
        if (!menu.contains(ev.target) && !sel.contains(ev.target)) {
          menu.remove();
          sel.classList.remove('is-open');
          document.removeEventListener('mousedown', onDoc, true);
        }
      };
      document.addEventListener('mousedown', onDoc, true);
      const onScroll = () => {
        menu.remove();
        sel.classList.remove('is-open');
        document.removeEventListener('mousedown', onDoc, true);
        document.getElementById('main').removeEventListener('scroll', onScroll);
      };
      document.getElementById('main').addEventListener('scroll', onScroll, { passive: true });
    };
    sel.addEventListener('click', open);
    sel.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
  });

  document.querySelectorAll('.input[data-id]').forEach((inp) => {
    inp.addEventListener('change', () => {
      void persist(defById(inp.dataset.id), inp.value);
    });
  });

  document.querySelectorAll('[data-pick]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const dir = await ipcRenderer.invoke('settings:pickFolder');
      if (typeof dir === 'string' && dir) {
        const d = defById(btn.dataset.pick);
        void persist(d, dir);
        const label = document.querySelector(`[data-path-text="${d.id}"]`);
        if (label) label.textContent = dir;
      }
    });
  });
  document.querySelectorAll('[data-open]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const d = defById(btn.dataset.open);
      void ipcRenderer.invoke('settings:openPath', values[d.id] || 'videos');
    });
  });

  // 设置备份（通用页「保存」分组）：立即备份 / 导出 / 导入 / 打开目录
  const btnBackupNow = document.getElementById('btnBackupNow');
  if (btnBackupNow && !btnBackupNow.dataset.bound) {
    btnBackupNow.dataset.bound = '1';
    btnBackupNow.addEventListener('click', async () => {
      btnBackupNow.disabled = true;
      try {
        const res = await ipcRenderer.invoke('settings:backup-now');
        if (res?.ok) {
          notify('备份成功', 'success', btnBackupNow);
        } else {
          notify(`备份失败：${res?.message || '未知错误'}`, 'error', btnBackupNow);
        }
        void loadBackupList();
      } finally {
        btnBackupNow.disabled = false;
      }
    });
  }
  const btnBackupExport = document.getElementById('btnBackupExport');
  if (btnBackupExport && !btnBackupExport.dataset.bound) {
    btnBackupExport.dataset.bound = '1';
    btnBackupExport.addEventListener('click', async () => {
      try {
        const res = await ipcRenderer.invoke('settings:export');
        if (res?.message !== 'canceled') {
          if (res?.ok) notify('导出成功', 'success', btnBackupExport);
          else notify(`导出失败：${res?.message || '未知错误'}`, 'error', btnBackupExport);
        }
      } catch { /* ignore */ }
    });
  }
  const btnBackupImport = document.getElementById('btnBackupImport');
  if (btnBackupImport && !btnBackupImport.dataset.bound) {
    btnBackupImport.dataset.bound = '1';
    btnBackupImport.addEventListener('click', async () => {
      try {
        const res = await ipcRenderer.invoke('settings:import');
        if (res?.message !== 'canceled') {
          if (res?.ok) {
            notify(`已导入 ${res.count ?? 0} 项设置（原设置已自动备份），重启应用后生效`, 'success');
          } else if (res?.needMerge) {
            // 跨壳/旧版备份：拦下整体替换，给合并入口（宿主记住了刚选的文件，不必再选一次）
            notify(res.message || '该备份来源不同，建议按键合并', 'error', null, {
              label: '仍要导入（合并）',
              onClick: async () => {
                try {
                  const r2 = await ipcRenderer.invoke('settings:import', { merge: true });
                  if (r2?.ok) notify(`已合并 ${r2.count ?? 0} 项设置（保留原有其它设置），重启应用后生效`, 'success');
                  else if (r2?.message !== 'canceled') notify(`合并失败：${r2?.message || '未知错误'}`, 'error');
                } catch (err) {
                  notify(`合并失败：${err instanceof Error ? err.message : String(err)}`, 'error');
                }
                void loadBackupList();
              },
            });
          } else {
            notify(`导入失败：${res?.message || '未知错误'}`, 'error');
          }
          void loadBackupList();
        }
      } catch { /* ignore */ }
    });
  }


  const hotkeyBtn = document.getElementById('hotkeyBtn');
  const hotkeyOk = document.getElementById('hotkeyOk');
  if (hotkeyBtn && !hotkeyBtn.disabled) {
    hotkeyBtn.addEventListener('click', () => {
      if (capturingHotkey) return;
      capturingHotkey = true;
      hotkeyBtn.classList.add('is-capture');
      hotkeyBtn.textContent = '按下组合键…';
    });
    window.addEventListener('keydown', async (e) => {
      if (!capturingHotkey) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        capturingHotkey = false;
        hotkeyBtn.classList.remove('is-capture');
        hotkeyBtn.textContent = lastHotkey;
        return;
      }
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
      const parts = [];
      if (e.ctrlKey) parts.push('Ctrl');
      if (e.altKey) parts.push('Alt');
      if (e.shiftKey) parts.push('Shift');
      if (e.metaKey) parts.push('Win');
      let key = e.key;
      if (key === ' ') key = 'Space';
      else if (key.length === 1) key = key.toUpperCase();
      parts.push(key);
      const combo = parts.join('+');
      capturingHotkey = false;
      const ok = await persist(defById('hotkey'), combo);
      hotkeyBtn.classList.remove('is-capture');
      hotkeyBtn.textContent = ok ? combo : lastHotkey;
      if (hotkeyOk) hotkeyOk.style.visibility = ok ? 'visible' : 'hidden';
    }, true);
  }

  const btnRestart = document.getElementById('btnRestartOcr');
  if (btnRestart) {
    btnRestart.addEventListener('click', async () => {
      btnRestart.disabled = true;
      btnRestart.textContent = '重启中…';
      try { await ipcRenderer.invoke('ocr:restart'); }
      finally {
        window.setTimeout(() => {
          btnRestart.disabled = false;
          btnRestart.textContent = '重启服务';
          void refreshService();
          void refreshModels();
        }, 1200);
      }
    });
  }
  const btnLog = document.getElementById('btnOpenLog');
  if (btnLog) btnLog.addEventListener('click', () => { void ipcRenderer.invoke('settings:openPath', 'logs'); });
}

async function refreshService() {
  const dot = document.getElementById('svcDot');
  const text = document.getElementById('svcText');
  const sub = document.getElementById('svcSub');
  if (!dot || !text) return;
  try {
    const h = await ipcRenderer.invoke('ocr:health');
    if (h && h.ok) {
      dot.className = 'dot dot-ok';
      text.textContent = '运行中';
      if (sub) sub.textContent = `${h.model || 'PP-OCRv6-small'} · ${h.backend || 'GPU'} 加速 · 端口 ${h.port || 18766}`;
    } else {
      dot.className = 'dot dot-busy';
      text.textContent = '未就绪（后台拉起中…）';
      if (sub) sub.textContent = '';
      void ipcRenderer.invoke('ocr:ensure').catch(() => {});
    }
  } catch {
    dot.className = 'dot';
    text.textContent = '状态未知';
    if (sub) sub.textContent = '';
  }
}

/** 可选资产行（模型/语言包）：未就绪时带「下载」按钮（2026-11-22 起手动下载，不再静默联网） */
function assetRowHtml(m) {
  const ok = !!m.ok;
  const size = m.sizeMb != null ? `${m.sizeMb} MB` : (m.size_mb != null ? `${m.size_mb} MB` : '');
  const badge = ok
    ? '<span class="badge badge-green">已就绪</span>'
    : '<span class="badge badge-pink">未下载</span>';
  const dl = ok ? '' : `<button type="button" class="btn" data-dl-asset="${esc(m.id)}">下载</button>`;
  // 路径可能很长（模型绝对路径），单独一行并省略号截断，title 保留全文；
  // 否则长路径会把右侧「大小 + 下载」整体挤出窗口右缘（用户反馈「模型没有提供下载」）。
  const pathLine = m.path ? `<div class="model-src model-path" title="${esc(m.path)}"><code>${esc(m.path)}</code></div>` : '';
  const src = m.source ? `<div class="model-src">${esc(m.source)}${m.url ? ` · ${esc(m.url)}` : ''}</div>` : '';
  const note = (m.message || m.note) ? `<div class="model-note">${esc(m.message || m.note)}</div>` : '';
  return `<div class="model-row${ok ? '' : ' is-missing'}">
    <div class="model-main">
      <div class="model-title">${esc(m.name || m.id || '')} ${badge}</div>
      ${src}${pathLine}${note}
    </div>
    <div class="model-size">${esc(size)}</div>
    <div class="model-act">${dl}</div>
  </div>`;
}

async function refreshModels(attempt = 0) {
  const box = document.getElementById('modelsList');
  if (!box) return;
  if (attempt === 0) box.innerHTML = '<div class="model-row">正在检测模型…</div>';

  // 后台拉起服务，不阻塞本轮 health 轮询（避免 ensure 卡住整页）
  void ipcRenderer.invoke('ocr:ensure').catch(() => {});

  try {
    // 资产状态 = 服务模型（表格/智能版面）+ Tesseract 语言包（仅 Electron 壳，F2 无此引擎）
    const h = await ipcRenderer.invoke('ocr:asset-status');
    const list = (h && h.models) ? (Array.isArray(h.models) ? h.models : Object.values(h.models)) : [];
    const langPack = h ? h.langPack : null;
    if (list.length) {
      const all = langPack && !f2Caps ? [...list, langPack] : list;
      // 折叠摘要：n 项就绪 / m 项未下载；有缺项时自动展开，齐了保持收起
      const okCount = all.filter((m) => m.ok).length;
      const missCount = all.length - okCount;
      const summary = document.getElementById('resSummary');
      const collapse = document.getElementById('resCollapse');
      if (summary) {
        summary.innerHTML = missCount === 0
          ? `<span class="badge badge-green">${all.length} 项就绪</span>`
          : `<span class="badge badge-green">${okCount} 项就绪</span><span class="badge badge-gray">${missCount} 项未下载</span>`;
      }
      if (collapse) collapse.classList.toggle('open', missCount > 0);
      const head = document.getElementById('resHead');
      if (head && !head.dataset.bound) {
        head.dataset.bound = '1';
        head.addEventListener('click', () => collapse.classList.toggle('open'));
      }
      let rows = all.map((m) => assetRowHtml(m)).join('');
      box.innerHTML = rows;
      box.querySelectorAll('[data-dl-asset]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.dlAsset;
          btn.disabled = true;
          btn.textContent = '下载中…';
          try {
            const res = id === 'tessdata'
              ? await ipcRenderer.invoke('ocr:langpack-download')
              : await ipcRenderer.invoke('ocr:model-download', id);
            if (res && res.ok === true) notify('下载完成', 'success', btn);
            else notify(`下载失败：${(res && res.message) || '未知错误'}`, 'error', btn);
          } catch (err) {
            console.warn('[Settings] asset download error:', id, err);
          }
          void refreshModels(0);
        });
      });
      try {
        const map = {};
        list.forEach((m) => { if (m && m.id) map[m.id] = m; });
        lastModels = map;
        updateLocalMtHint(map);
      } catch { /* ignore */ }
      return;
    }
    if (attempt < 12) {
      box.innerHTML = `<div class="model-row">服务启动中…（${attempt + 1}/12）</div>`;
      window.setTimeout(() => { void refreshModels(attempt + 1); }, 1000);
      return;
    }
    box.innerHTML = '<div class="model-row">未能读取模型清单。可点上方「重启服务」后重试；也可打开日志查看 rapidocr 启动错误。</div>';
  } catch (err) {
    console.error('[Settings] refreshModels', err);
    if (attempt < 12) {
      window.setTimeout(() => { void refreshModels(attempt + 1); }, 1000);
      return;
    }
    box.innerHTML = `<div class="model-row">读取失败：${esc(err && err.message ? err.message : err)}</div>`;
  }
}

/** 本地翻译依赖检测：无 llama 时在翻译页提示，避免用户以为必须打包 Hy-MT2 */
function updateLocalMtHint(models) {
  if (!models || !models.mt) return;
  const box = document.getElementById('localMtHint');
  if (!box) return;
  if (models.mt.ok) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.innerHTML = `<div class="tip-title">本地翻译模型未就绪</div>
    <div class="tip-body">打包/分发时可<strong>不附带</strong> Hy-MT2 与 llama-server。若未安装本地模型，
    请把翻译引擎切到「云端百度翻译」并填入密钥即可正常使用（无需任何本地大模型）。
    若需要离线翻译，将 <code>Hy-MT2-1.8B-Q4_K_M.gguf</code> 放到
    <code>${esc(String(models.mt.path || 'D:\\llama\\models\\'))}</code>，并安装
    <code>D:\\llama\\bin\\llama-server.exe</code>。</div>`;
}

async function loadAbout() {
  try {
    const info = await ipcRenderer.invoke('settings:appInfo');
    const ver = document.getElementById('aboutVer');
    const ocr = document.getElementById('aboutOcr');
    if (ver && info) ver.textContent = `版本 ${info.version || '0.0.0'}`;
    if (ocr && info) ocr.textContent = `OCR 服务 · ${info.ocr || '—'}`;
  } catch { /* ignore */ }
}

try {
  document.getElementById('winClose').addEventListener('click', () => window.close());
  document.getElementById('winMin').addEventListener('click', () => {
    try { ipcRenderer.send('settings:minimize'); } catch { window.close(); }
  });
  document.getElementById('winMax').addEventListener('click', () => {
    try { ipcRenderer.send('settings:toggle-max'); } catch { /* ignore */ }
  });
} catch (err) {
  console.error('[Settings] window buttons bind failed', err);
}

(async function boot() {
  try {
    console.log('[Settings] boot start');
    await loadAll();
    lastHotkey = values.hotkey;
    renderNav();
    renderMain();
    console.log('[Settings] boot ok', currentPage);
  } catch (err) {
    console.error('[Settings] boot failed', err);
  }
})();

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
  { id: 'hotkey', page: 'capture', type: 'hotkey', key: 'screenshot-hotkey', def: 'Alt+Q',
    title: '截图热键', desc: '全局生效。冲突时自动改用备用键，以托盘菜单显示为准；点击键帽后按新组合键，Esc 取消' },
  { id: 'hotkeyCopy', page: 'capture', type: 'hotkey', key: 'screenshot-hotkey-copy', def: 'Alt+C', persist: false,
    title: '截图并复制', desc: '框选完成后直接复制到剪贴板并退出，不打开标注工具栏。默认 Alt+C（冲突时该键失效，不影响主截图热键）；当前版本该键固定，改键后续开放' },
  { id: 'engine', page: 'capture', type: 'select', key: 'screenshot-engine', def: 'plugin',
    title: '抓帧引擎', desc: '「自动」优先原生插件、失败回退 GDI；黑屏或偏色时可强制 GDI，下一次截图生效',
    options: [
      { value: 'plugin', label: '自动（推荐）' },
      { value: 'js', label: 'GDI 兼容模式' },
    ] },
  { id: 'ocrAuto', page: 'capture', type: 'toggle', key: 'screenshot.ocr-auto', def: false,
    title: '截图后自动识别', desc: '框选确定后自动执行「默认识别动作」并打开结果面板；手动点识别不受影响' },
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
    title: '保存方式', desc: '每次询问：弹出「另存为」；固定文件夹：直接写入下方目录并提示文件名',
    options: [
      { value: 'dialog', label: '每次询问' },
      { value: 'folder', label: '固定文件夹' },
    ] },
  { id: 'recDir', page: 'record', type: 'path', key: 'screenshot.rec-save-dir', def: '',
    title: '保存文件夹', desc: '仅「固定文件夹」模式生效；留空使用系统「视频」文件夹' },
  { id: 'recPrefix', page: 'record', type: 'text', key: 'screenshot.rec-filename-prefix', def: '拾花录屏',
    title: '文件名前缀', desc: '固定文件夹模式：文件名 = 前缀 + 时间戳 + .webm' },
  { id: 'ocrEngine', page: 'ocr', type: 'radio', key: 'screenshot-ocr-engine', def: 'paddleocr',
    title: '识别引擎', desc: '识别截图中的文字并输出 Markdown / 表格 / 智能版面',
    options: [
      { value: 'paddleocr', label: '本地 RapidOCR', badges: ['内置', '离线', '推荐'], badgeTone: ['green', 'green', 'pink'], desc: 'PP-OCRv6 · 精度与速度最佳' },
      { value: 'local', label: '本地 Tesseract', badges: ['兼容'], badgeTone: ['gray'], desc: '秒开，复杂版面精度较低' },
    ] },
  { id: 'ocrWarm', page: 'ocr', type: 'radio', key: 'screenshot-ocr-warmup', def: 'capture-prewarm', grid3: true,
    title: '识别性能档位', desc: '控制本地模型何时加载，切换后下次截图/识别生效',
    options: [
      { value: 'resident', label: '常驻', badges: ['最快'], badgeTone: ['gray'], desc: '启动即加载，约占 420MB' },
      { value: 'capture-prewarm', label: '截图时预热', badges: ['推荐'], badgeTone: ['pink'], desc: '框选时间覆盖初始化' },
      { value: 'on-demand', label: '按需', badges: ['零占用'], badgeTone: ['gray'], desc: '点识别才加载，首次约 4~6 秒' },
    ] },
  { id: 'ocrAct', page: 'ocr', type: 'select', key: 'screenshot-ocr-default-action', def: 'text',
    title: '默认识别动作', desc: '工具栏识别主按钮执行的动作；其余仍可从 ▾ 菜单选择',
    options: [
      { value: 'text', label: '文字识别' },
      { value: 'table', label: '表格识别' },
      { value: 'smart', label: '智能识别' },
    ] },
  { id: 'tblFmt', page: 'ocr', type: 'seg', key: 'screenshot.table-copy-format', def: 'html',
    title: '表格复制格式', desc: '表格识别后「复制」的默认格式：带边框 HTML 可直接贴 Excel/WPS；纯 TSV 适合纯文本',
    options: [
      { value: 'html', label: '带边框 HTML' },
      { value: 'tsv', label: '纯 TSV' },
    ] },
  { id: 'smartH', page: 'ocr', type: 'seg', key: 'screenshot.smart-headings', def: true,
    title: '智能识别标题层级', desc: '输出 Markdown 时标题是否渲染为 ##；关闭则输出无标记纯段落',
    options: [
      { value: true, label: '保留 ##' },
      { value: false, label: '纯文本' },
    ] },
  { id: 'ocrSvc', page: 'ocr', type: 'status', key: '', def: null,
    title: '服务状态', desc: '识别服务运行状态；异常时可重启（约 3~6 秒恢复）' },
  { id: 'ocrModels', page: 'ocr', type: 'models', key: '', def: null,
    title: '模型清单', desc: '所需模型是否已在本机。带「按需下载」的会在你第一次使用对应功能时自动拉取，下载完成后即可用，无需再手工配置路径。' },
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
];

const PAGES = [
  { id: 'general', label: '通用' },
  { id: 'capture', label: '截图' },
  { id: 'longshot', label: '长截图' },
  { id: 'record', label: '录屏' },
  { id: 'ocr', label: '识别' },
  { id: 'translate', label: '翻译' },
  { id: 'about', label: '关于' },
];

const values = {};
let currentPage = 'general';
let capturingHotkey = false;
let lastHotkey = 'Alt+Q';
let lastModels = null;

async function storeRead(key) {
  try { return await ipcRenderer.invoke('store:read', key); } catch { return undefined; }
}
async function storeWrite(key, value) {
  try { return await ipcRenderer.invoke('store:write', key, value); }
  catch (err) { console.error('[Settings] store write', key, err); return false; }
}
function defById(id) { return DEFS.find((d) => d.id === id); }

async function loadAll() {
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
          <button type="button" class="radio-card${v === o.value ? ' is-on' : ''}" data-idx="${idx}">
            <span class="radio-dot"></span>
            <span class="radio-body">
              <span class="radio-title">${esc(o.label)} ${(o.badges || []).map((b, i) => badgeHtml(b, (o.badgeTone || [])[i])).join('')}</span>
              ${o.desc ? `<span class="radio-desc">${esc(o.desc)}</span>` : ''}
            </span>
          </button>
        `).join('')}
      </div>`;
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
      return `<div class="status-actions">
        <div class="status-line">
          <span class="dot" id="svcDot"></span>
          <span class="status-text" id="svcText">检测中…</span>
        </div>
        <div class="btn-row">
          <button type="button" class="btn" id="btnOpenLog">打开日志</button>
          <button type="button" class="btn btn-danger" id="btnRestartOcr">重启服务</button>
        </div>
      </div>`;
    case 'models':
      return `<div class="models-list" id="modelsList"><div class="model-row">检测中…</div></div>`;
    default:
      return '';
  }
}

function isCloud() { return values.trEngine === 'cloud'; }

/** 行：左说明 + 右控件 */
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
  return `<div class="card">
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
      : '';

  main.innerHTML = `
    <section class="page is-active">
      <h1 class="page-title">${esc(page.label)}</h1>
      ${lead ? `<p class="page-lead">${esc(lead)}</p>` : ''}
      ${currentPage === 'translate' ? '<div class="card card-tip" id="localMtHint" hidden></div>' : ''}
      ${list.map((d) => {
        if (d.cloudOnly && !isCloud()) return '';
        if (d.type === 'radio') return radioBlockHtml(d);
        return `<div class="card">${rowHtml(d)}</div>`;
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
  if (!dot || !text) return;
  try {
    const h = await ipcRenderer.invoke('ocr:health');
    if (h && h.ok) {
      dot.className = 'dot dot-ok';
      text.textContent = `运行中 · ${h.backend || 'GPU'} · :${h.port || 18766} · ${h.build || 'ready'}`;
    } else {
      dot.className = 'dot dot-busy';
      text.textContent = '未就绪（后台拉起中…）';
      void ipcRenderer.invoke('ocr:ensure').catch(() => {});
    }
  } catch {
    dot.className = 'dot';
    text.textContent = '未知';
  }
}

async function refreshModels(attempt = 0) {
  const box = document.getElementById('modelsList');
  if (!box) return;
  if (attempt === 0) box.innerHTML = '<div class="model-row">正在检测模型…</div>';

  // 后台拉起服务，不阻塞本轮 health 轮询（避免 ensure 卡住整页）
  void ipcRenderer.invoke('ocr:ensure').catch(() => {});

  try {
    const h = await ipcRenderer.invoke('ocr:health');
    const list = (h && h.models) ? Object.values(h.models) : [];
    console.log('[Settings] models poll', attempt, 'ok=', h && h.ok, 'n=', list.length);
    if (list.length) {
      box.innerHTML = list.map((m) => {
        const ok = !!m.ok;
        const size = m.size_mb != null ? `${m.size_mb} MB` : '';
        const badge = ok
          ? '<span class="badge badge-green">已就绪</span>'
          : (m.mode === 'ondemand'
            ? '<span class="badge badge-pink">按需下载</span>'
            : '<span class="badge badge-gray">缺失</span>');
        const pathLine = m.path ? `<div class="model-src"><code>${esc(m.path)}</code></div>` : '';
        const src = m.source ? `<div class="model-src">${esc(m.source)}${m.url ? ` · ${esc(m.url)}` : ''}</div>` : '';
        const note = m.note ? `<div class="model-note">${esc(m.note)}</div>` : '';
        return `<div class="model-row${ok ? '' : ' is-missing'}">
          <div class="model-main">
            <div class="model-title">${esc(m.name || m.id || '')} ${badge}</div>
            ${src}${pathLine}${note}
          </div>
          <div class="model-size">${esc(size)}</div>
        </div>`;
      }).join('');
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

// 渲染端双份同步检查（Tauri 迁移线专用守卫）
//
// 为什么需要：Tauri spike 的界面资源是 `resources/`（Electron 主线，单一事实源）
// 的**副本**（tauri-spike/ui/）。整个 spike 的前提就是「capture.js 一字不改跑在
// WebView2」——一旦两边漂移，Tauri 上的行为就和 Electron 对不上了，而且**不会报错**
// （只是行为悄悄不同），极难排查。
//
// 规则（与 Tauri迁移收尾方案.md §五.4 一致）：
//   1. capture.js / capture.css / pin.js / pin.css  —— 必须**逐字节一致**（零改动）；
//   2. capture.html / pin.html                        —— 只允许多出 shim.js 的引入行，
//      其余必须一致（shim 是 Electron→Tauri 兼容垫片，属于必要差异）。
//
// 用法：node tools/check-render-sync.js
// 退出码：0 = 同步；1 = 有漂移（打印差异）；2 = 文件缺失。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'resources');
const DST = path.join(ROOT, 'tauri-spike', 'ui');

// 必须逐字节一致的「零改动」文件
const IDENTICAL = ['capture.js', 'capture.css', 'pin.js', 'pin.css', 'settings.js', 'settings.css'];

// 只允许多出 shim 引入行的文件
const SHIM_ONLY = ['capture.html', 'pin.html', 'settings.html'];

const SHIM_TAG = '<script src="./shim.js"></script>';

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readLines(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/);
}

/** 去掉 shim 引入后，剩余内容是否与源一致（逐行 trim 比较，忽略缩进差异） */
function diffWithoutShim(srcFile, dstFile) {
  const strip = (line) => {
    if (!line.includes(SHIM_TAG)) return line.trim();
    const rest = line.split(SHIM_TAG).join('').trim();
    // 整行只有 shim 标签 → 该行是 spike 独有的，丢弃
    return rest === '' ? null : rest;
  };
  const src = readLines(srcFile).map((l) => l.trim());
  const dst = readLines(dstFile).map(strip).filter((l) => l !== null);
  if (src.length !== dst.length) {
    return `行数不同：源 ${src.length} 行 / 副本去掉 shim 后 ${dst.length} 行`;
  }
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== dst[i]) {
      return `第 ${i + 1} 行不同：\n  源:   ${src[i]}\n  副本: ${dst[i]}`;
    }
  }
  return null;
}

let failed = 0;
let missing = 0;

for (const name of IDENTICAL) {
  const a = path.join(SRC, name);
  const b = path.join(DST, name);
  if (!fs.existsSync(a) || !fs.existsSync(b)) {
    console.error(`[缺失] ${name}（源: ${fs.existsSync(a)} / 副本: ${fs.existsSync(b)}）`);
    missing++;
    continue;
  }
  if (sha256(a) === sha256(b)) {
    console.log(`[一致] ${name}`);
  } else {
    console.error(`[漂移] ${name}：${path.relative(ROOT, a)} ≠ ${path.relative(ROOT, b)}`);
    console.error('        → spike 的「一字不改」前提已破，请把 resources/ 的改动同步过来');
    failed++;
  }
}

for (const name of SHIM_ONLY) {
  const a = path.join(SRC, name);
  const b = path.join(DST, name);
  if (!fs.existsSync(a) || !fs.existsSync(b)) {
    console.error(`[缺失] ${name}（源: ${fs.existsSync(a)} / 副本: ${fs.existsSync(b)}）`);
    missing++;
    continue;
  }
  const diff = diffWithoutShim(a, b);
  if (!diff) {
    // ⚠️ 盲区补丁（2026-11-21）：本工具只剥副本的 shim 行、从不验证 shim 行**存在**——
    // 曾发生 `cp resources/capture.html tauri-spike/ui/capture.html` 把 shim 行抹掉后，
    // 剥行比较恰好等于源 → 判「一致」，而 WebView2 里 require('electron') 直接崩、
    // 整页 JS 停摆（症状=页面能渲染但零 [js] 日志，极难排查）。
    const dstRaw = fs.readFileSync(b, 'utf8');
    if (!dstRaw.includes(SHIM_TAG)) {
      console.error(`[漂移] ${name}：副本**缺失 shim 引入行**（shim.js 是 Tauri 壳的生命线，缺它 = 页面 JS 全崩）`);
      console.error('        → 请在 <script src="./capture.js"> 之前补一行 <script src="./shim.js"></script>');
      failed++;
      continue;
    }
    console.log(`[一致] ${name}（仅多出 shim 引入行，符合预期）`);
  } else {
    console.error(`[漂移] ${name}：${diff}`);
    console.error('        → 允许的差异只有 shim.js 引入行；其余改动请同步两边');
    failed++;
  }
}

if (missing) {
  console.error(`\n✗ 有 ${missing} 个文件缺失，无法判定同步状态`);
  process.exit(2);
}
if (failed) {
  console.error(`\n✗ 渲染端双份已漂移（${failed} 处）—— Tauri 与 Electron 行为将不一致`);
  process.exit(1);
}
console.log('\n✓ 渲染端双份同步（Electron 主线与 Tauri spike 一致）');

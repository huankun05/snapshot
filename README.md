# 拾花 PetalSnap

> **拾花 —— 简约的 Windows 截图工具：截图 · 贴图 · 识别 · 翻译**
> *Pluck blossoms from your screen.*
>
> 2026-09-10 从 `F:\Work\Create\Assa\Xiyue` 整体提取为独立工作区，2026-09-15 定名
> 「拾花 PetalSnap」转为正式独立应用（**Xiyue 仓库内的功能保持原样可用**，HEAD `f7d3630`，
> 待本应用完善后把新能力移回）。功能：区域截图 / 标注 / 贴图 / OCR+翻译 / 表格与智能识别 /
> 长截图滚动拼接。设计语言与开发流程见 `docs/`（UI设计方案、设置面板设计、工作规范、
> 功能状态清单为单一事实源）。

## 目录结构（与 Xiyue 原路径的映射）

| 本目录 | Xiyue 原路径 | 说明 |
|---|---|---|
| `resources/capture.js\|html\|css` | `resources/` | 截图主 UI：选区/蒙版/标注/长截图/编辑器（capture.js 6655 行，核心） |
| `resources/pin.js\|html\|css` | `resources/` | 贴图（钉在桌面上的截图）窗口 |
| `main/ipc/window/capture.ts` | `src/main/ipc/window/` | 截图全部 IPC：GDI 抓帧、滚轮注入（lsWheel）、贴图、OCR 分发（1220 行） |
| `main/ipc/system/screenshotHotkey.ts` | `src/main/ipc/system/` | 截图热键 IPC |
| `main/window/captureWindow.ts` | `src/main/window/` | 截图窗服务：创建/预热/reveal 时序、长截图入口 triggerScreenshot（789 行） |
| `main/window/capturePinWindow.ts` | `src/main/window/` | 贴图窗管理 |
| `main/window/screenshotHelper.ts` | `src/main/window/` | 原生截图插件加载器（@eisland/windows-screenshot-helper，缺省回退 desktopCapturer） |
| `main/window/dwmTransition.ts` | `src/main/window/` | DWM 开窗动画禁用（Win10 有效/Win11 失效） |
| `main/services/nativeCapture.ts` | `src/main/services/` | 外部原生截图引擎（xland 等）调用与回退 |
| `main/services/captureOcrService.ts` | `src/main/services/` | 云 OCR（PP-OCR API） |
| `main/services/captureLocalOcrService.ts` | `src/main/services/` | 本地 OCR（Tesseract.js） |
| `main/services/localOcrMtService.ts` | `src/main/services/` | 本地 OCR/MT Python 侧车（PaddleOCR，127.0.0.1:18765） |
| `main/storeConfig-screenshot-excerpt.ts` | `src/main/config/storeConfig.ts` | 截图相关配置函数摘录（热键/引擎选择），迁移时需并回 |
| `renderer/ScreenshotSettingsPage.tsx` | `src/renderer/.../app/components/` | 设置页截图区块 |
| `docs/长截图问题排查记录.md` | `docs/` | **r19~r60 完整排查史（最重要，先读这个）** |
| `tools/`、`frames/`、`logs/`、`reference/`、根 `capture.js` | — | 长截图独立调试工具链（详见下节） |

## 长截图研究资产（根目录）

- `tools/` —— 4 件回归工具（**已可独立运行**，路径指向本目录 `capture.js` 快照）：
  - `_ls_matcher_replay.js`：3 真实会话 42 项断言（`node _ls_matcher_replay.js`）
  - `_ls_loop_check.js`：步进循环沙盘 17 项（`node _ls_loop_check.js`）
  - `_ls_lapinfo_check.js`：清晰度门控单测 5 项
  - `verify_ls_truth.py`：帧间 SSD 真值校验（需 PIL+numpy，可用 Xiyue 的 `.venv`）
  - `_ls_pipeline_probe.js`：打分管线探针
- `frames/` —— 3 个真实会话原始帧（回放回归数据源；新会话取证在
  `%LOCALAPPDATA%\Temp\xiyue-ls-debug\`）
- `logs/` —— r49~r60 实测日志（`[LS]`/`[LS-MAIN]` 打点）
- `reference/` —— ShareX ScrollingCaptureManager 源码（"逐行全等连击"判据参照）
- 根 `capture.js` —— r60 快照（工具链提取源；改完 Xiyue 真身后同步一份过来即可跑回归）

## 模块外部依赖（移回/独立运行时需要注意）

- 主进程接线：`src/main/index.ts` 中 `createCaptureWindowService` / `registerCaptureIpcHandlers`
  / `registerScreenshotHotkeyIpcHandlers` / `disposeLocalOcrWorker` / 截图热键回调（L43~L761 多处）
- preload API：`screenshot` / `startRegionScreenshot` / `screenshotHotkeyGet|Set` / `pickFeedbackScreenshotFile`
- 配置：`storeConfig.ts` 的 `readScreenshotEngineConfig` / `readScreenshotOcrEngineConfig`
  / `readScreenshotHotkeyConfig` / `SCREENSHOT_HOTKEY_STORE_KEY`（excerpt 有摘录）
- OCR 侧车：`F:\Work\Create\OCR` 根目录的 `venv_ocr/` + `rapidocr_service.py`（主链路）+
  `local_capture_service.py`（旧侧车兜底）；根目录布局见该目录 `README.md`，历史迭代已归档到 `_archive/`
- 原生插件：`@eisland/windows-screenshot-helper`（可选，缺则自动回退 desktopCapturer）
- i18n：capture.js 内联字典（zh/en 各一套，键如 `captureHint` `lsStartHint`）

## 当前状态摘要（2026-09-10）

- **可用且稳定**：区域截图、标注、贴图、OCR/翻译、热键
- **长截图（滚动拼接）**：r19~r60 修了 40+ 项（详见 `docs/长截图问题排查记录.md`），
  基础流程可用，但体验未达预期（悬停干扰输入源、深浅色页面一致性）→ 暂时搁置。
  拾起时先跑 `tools/` 三套回归（42/17/5 全绿为基线），再读 docs 的 3.19 节与「五、残留风险」

---

## 独立应用运行方式（2026-09-13 起）

本目录已可直接作为独立应用运行（不依赖 Xiyue 仓库）：

```bash
# 1) 构建主进程（esbuild 借道 Xiyue 的 node_modules；或将 node_modules 联接/安装到本目录）
cd app && node build-host.js
# 2) 启动（工作目录必须是本目录，capture.html 按 cwd 定位）
F:/Work/Create/Assa/Xiyue/node_modules/electron/dist/electron.exe app/dist/main.js
```

- 入口：`app/main.ts`（托盘 + 全局热键（默认 Alt+Q，被占用自动降级） + 单实例锁）
- 触发：全局热键 / 托盘菜单 / 托盘双击
- userData 独立（`%APPDATA%\petalsnap`；旧 `%APPDATA%\eisland-screenshot` 首启自动迁移）

## OCR 识别服务（ocr-service/）

- `rapidocr_service.py` —— 识别内核：RapidOCR(飞桨 PP-OCRv6-small/ONNX) 文本+段落+格式化 Markdown，
  `/table` 表格结构还原（RapidTable/SLANet-plus，含表头并格几何修复）
- `ocr_test_server.py` —— 网页测试台（127.0.0.1:8766，粘贴/拖图对比 small/tiny/medium）

运行依赖 `F:/Work/Create/OCR/venv_ocr`（`pip install rapidocr rapid-table`）。
应用默认按 `XIYUE_RAPIDOCR_SCRIPT`/固定路径 `F:/Work/Create/OCR/rapidocr_service.py` 拉起，
该文件与本目录 `ocr-service/rapidocr_service.py` 保持同步，改动时两边各一份。

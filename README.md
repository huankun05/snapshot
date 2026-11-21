# 拾花 PetalSnap

> **拾花 —— 简约的 Windows 截图工具：截图 · 贴图 · 识别 · 翻译**
> *Pluck blossoms from your screen.*
>
> 2026-09-10 从 `F:\Work\Create\Assa\Xiyue` 整体提取为独立工作区（Xiyue 内功能保持原样，
> HEAD `f7d3630`）。**当前主线：Tauri/WebView2 双壳迁移**（2026-10-31 定调，Electron 逐步退役）。
> 功能状态与开发流程见 `docs/`（**功能状态清单.md 为单一事实源**）。

## 功能总览

| 板块 | 能力 |
|---|---|
| 截图 | 全屏蒙版框选、窗口级/元素级智能预览（UIA+像素双链，窗口级预览+滚轮下钻）、放大镜取色卡、多屏混合 DPI、8 向拉伸、上次选区记忆 |
| 标注 | 马赛克/模糊/噪点/纯色、矩形/直线/箭头/曲线箭头/椭圆、画笔/高亮、文字、**序号（自动递增）/说明气泡**、橡皮擦（细擦/框选/整笔）、Snipaste 式延迟烘焙 |
| 贴图 | 钉在桌面、拖动、滚轮缩放（Shift/Alt 单轴）、**Ctrl+滚轮透明度** |
| OCR | 文字识别 / 表格识别（RapidTable，HTML 直贴 Excel）/ 智能识别（版面分区 Markdown）/ **问 AI（6 模板一键发 + 自由提问）** |
| 翻译 | 图片翻译（OCR+擦写回填叠图）、面板板块翻译；引擎：本地 Hy-MT2（llama.cpp）/ 云端 |
| 兜底 | **识别三级兜底：18766 RapidOCR → wxocr（微信 4.x，211ms）→ wmocr（WinRT 系统 OCR）**；翻译兜底：兜底 OCR 文本 → Edge→MyMemory（免 key） |
| 设置 | 托盘 + 设置窗七分区（F1）；store 持久化（F1=eIsland_store / F2=store.json，问 AI 凭据 F2 只读继承 F1） |

## 双壳架构（2026-10-31 起）

| 壳 | 形态 | 说明 |
|---|---|---|
| **F1** | Electron（`app/main.ts` → `app/dist/main.js`） | 现役稳定版；全部 IPC 在 `main/ipc/window/capture.ts` |
| **F2** | Tauri/WebView2（`tauri-spike/`，热键 F2） | 迁移目标；exe 13MB 级 vs Electron 348MB。capture.html/js/css **逐字节复用 F1**（shim.js 垫 Electron API），智能内核 = F1 worker 原样跑独立 node 进程（`f1_worker.js` 独占 smart_uia.dll）。迁移方案与状态见 `docs/Tauri迁移收尾方案.md` |

**渲染端铁律**：`resources/capture.js|css`、`pin.js|css` 与 `tauri-spike/ui/` 副本必须逐字节一致
（`node tools/check-render-sync.js` 守卫；capture.html/pin.html 仅允许多 shim 引入行）。
`tauri-spike/ui/*` 内嵌于 release 构建——**改 ui/ 后必须 cargo 重编**。

**OCR/翻译服务**：识别走 Python 侧车 `OCR/rapidocr_service.py`（127.0.0.1:18766，PP-OCRv6 small +
RapidTable + 版面分区 + Hy-MT2 翻译；与 `ocr-service/rapidocr_service.py` 保持同步）。F2 宿主自管理
侧车生命周期（Job Object 连树陪葬 + 孤儿清扫）。识别/翻译的宿主内兜底链与免 key 翻译见
`docs/竞品借鉴-青蛙与天若.md` §4。

## 目录结构

| 路径 | 说明 |
|---|---|
| `resources/` | 截图主 UI 单一事实源（capture.js ~14k 行核心 / pin.* 贴图 / settings.* 设置窗 / ask-ai-modes.json 问 AI 模板 / svg 图标） |
| `app/` | F1 Electron 宿主（`main.ts` + `build-host.js` esbuild 构建 → `dist/main.js`；`settings.ts` 设置窗） |
| `main/` | F1 主进程模块（ipc / window / services / config——OCR 服务拉起、智能选框 worker、GDI worker、askAiService 等） |
| `tauri-spike/` | F2 Tauri 壳（`src-tauri/src/main.rs` 宿主：会话流/坐标/抓帧/OCR 翻译代理+兜底/问 AI；`f1_worker.js` 智能内核；`ui/` = resources 副本 + shim） |
| `ocr-service/` | `rapidocr_service.py` 副本（与仓库外 `OCR/rapidocr_service.py` 保持同步，diff 为空） |
| `docs/` | 全部方案/调研/排查文档（见下节索引） |
| `tools/` | 回归工具（长截图四件、check-render-sync、进程自测、停应用脚本等） |
| `native/` | `smart_uia.dll` 源码（C++，UIA/像素智能选框内核） |
| `renderer/`、`shared/`、`reference/`、`frames/`、`logs/` | 设置页组件 / store 键 / ShareX 参照 / 长截图帧数据 / 历史日志 / 截图工具链快照 |

## 启动 / 构建

```bash
# F1（Electron）
cd app && node build-host.js          # 构建主进程
# 启动：OCR/启动截图工具.bat（或 electron.exe app/dist/main.js）

# F2（Tauri，改 src/main.rs 或 ui/* 后必须重编）
export PATH="$HOME/.cargo/bin:$PATH"  # bash 会话常丢 cargo PATH
cd tauri-spike/src-tauri && cargo build --release
# 部署纪律：先杀旧实例（exe 锁=构建静默失败）→ build → 核对 exe mtime → 启动
```

- 自测钩子：`PETALSNAP_IPC_SELFTEST=1`（启动级 IPC 全链，日志 `%TEMP%\petalsnap-spike.log`）
  / `PETALSNAP_SELFTEST=1`（渲染端手势链 [SELFTEST]/[SELFTEST2]）
- 进程管理：`tools/_stop_app.ps1`（优雅停→树杀→孤儿清扫）、`tools/_process_selftest.py`

## 文档索引（docs/）

| 文档 | 内容 |
|---|---|
| **功能状态清单.md** | **单一事实源**：总览 / 已实现 / 待实现 / 变更日志（流水账） |
| **Tauri迁移收尾方案.md** | F2 迁移单一方案文档：缺口表、P0/P1 分期、实测故障定位史 |
| **竞品借鉴-青蛙与天若.md** | 竞品画像 + 7 项借鉴实施记录 + 微信 OCR 结论反转 + 不借清单 |
| Shotera竞品调研.md | 首个竞品（Tauri 类）设置面板/交互盘点与借鉴清单 |
| 智能选区-CppUIA改造计划.md / -技术方案对比.md | 智能选框两条路线的完整方案与取证 |
| 长截图问题排查记录.md | r19~r60 排查史（拾起长截图先读） |
| UI设计方案.md / 设置面板设计.md | 视觉令牌、工具栏两级结构、设置窗规格 |
| 市场调研-2026-10-27.md | 「问 AI」等新增需求来源 |
| 工作规范.md | 九步开发流程、文档/提交约定 |

## 模块外部依赖（独立运行注意）

- 主进程接线：`src/main/index.ts` 多处（`createCaptureWindowService` / `registerCaptureIpcHandlers` /
  `registerScreenshotHotkeyIpcHandlers` / 热键回调）；preload API `screenshot` / `startRegionScreenshot` /
  `screenshotHotkeyGet|Set`；配置 `storeConfig.ts` 各 `readScreenshot*Config`
- OCR 侧车：仓库外 `OCR/` 根的 `venv_ocr/` + `rapidocr_service.py`（主链路）+ `local_capture_service.py`
  （旧侧车）；`models/fonts/` 翻译擦写回填字体；布局见根目录 `README.md`
- 微信 OCR 兜底：仓库外 `OCR/wxocr-sdk/`（MaaXYZ SDK，**AGPLv3，不入 git 不分发**，需本机装微信）
- 原生插件：`@eisland/windows-screenshot-helper`（可选，缺则自动回退）；i18n 为 capture.js 内联字典（zh/en）

## 长截图研究资产

- `tools/` 四件回归（`_ls_matcher_replay.js` 42 断言 / `_ls_loop_check.js` 17 项 /
  `_ls_lapinfo_check.js` 5 项 / `verify_ls_truth.py`）+ `frames/` 真实会话帧 + `logs/` 实测日志
- 拾起长截图前先跑三套回归（42/17/5 全绿为基线），再读 `docs/长截图问题排查记录.md`

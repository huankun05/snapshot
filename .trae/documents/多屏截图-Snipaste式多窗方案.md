# 多屏截图（Snipaste 式·多窗正确实现）方案

> **⚠ 已废弃（2026-09-24）**：本「每屏一窗」多窗方案经两轮完整实施（`stage3-multiwindow-wip` 825146d、
> `stage3-rebuild` 6194b0b）与一次直接落地（重构 captureWindow.ts + capture.js）后**最终放弃**。
> 多窗方案在实机上存在不可接受的性能问题：每屏一窗各自重复智能识别（33MB getImageData + UIA），
> 主进程被反复阻塞 → 拖动/智能框单击/跨屏拖选全部卡死；且「真锁屏 + 所见即所得 + 混合 DPI 清晰」三者
> 在 Electron 多窗架构下难以同时成立。
>
> **当前方向改为「单窗·全虚拟屏」**：一扇窗覆盖所有屏幕的 DIP 外接矩形（vbox），逐屏物理 BitBlt 拼成
> **一张**全虚拟物理 BGRA 作背景，单次智能识别，`multiWindow:false` 走渲染端本地快速路径。
> 实施与进展见 [`single-window-virtual-screen-refactor.md`](./single-window-virtual-screen-refactor.md)。
> 下文所有多窗阶段（阶段 1~5）内容仅存档参考，不再执行。

## Context（为什么做）

用户要对标 Snipaste 实现真正的多显示器截图。目标行为（已与用户确认）：

1. **全虚拟屏一次性蒙版**：触发截图后所有屏幕同时暗化，鼠标可自由跨屏拖框。
2. **每屏缩放清晰**：混合 DPI（如 100%+150%）下每块屏原生清晰，不因单窗单 DPR 发虚。
3. **真输入锁定**：截图期间底层桌面不可交互（Snipaste 式系统级锁定）。
4. **所见即所得**：确认截图结果 = 画框所见，绝不一致。

两次「每屏一窗」尝试均失败并回退（`stage3-multiwindow-wip` 825146d、`stage3-rebuild` 6194b0b），但后者沉淀的「主进程全局输入轮询 + 每窗一屏 + 逐屏抓帧合成」是**已知正确方向**，保存在 git 分支中可复用。失败根因与修复思路：

- **假锁屏**：非活跃屏遮罩窗是 click-through（`setIgnoreMouseEvents(true)`），底层桌面仍可交互。
  → 修复：**所有遮罩窗会话期非 click-through**，输入完全由主进程全局轮询（GetCursorPos/GetAsyncKeyState）驱动，渲染端框选不依赖窗口鼠标事件。
- **所见非所得**：预览裁剪与确认裁剪坐标系不同源。
  → 修复：**选区矩形用单一规范坐标系（全局物理像素）**；各窗预览 = 物理矩形 ÷ 该屏 scaleFactor；确认裁剪 = 物理矩形 → 该屏 BGRA 原始帧（1:1）。预览与裁剪由同一物理矩形 + 同一 per-display scaleFactor 派生，天然同源。
- **确认无法完成**（v2 让各窗回传画布像素导致）：→ 保持主进程逐屏帧合成裁剪（复用 stage3 的 `parts[]` 拼接代码 + `startRegionScreenshot(external, cropOnly)` 进编辑器），不向窗口索要画布像素。

## 复用件与基座（已确认存在）

- **全局输入轮询现成模式**：`main/ipc/window/capture.ts` L930-956 `lsPollTick`（主进程每 30ms 轮询光标 + 动态切 click-through）；L269-285 koffi 已加载 `user32.dll` 的 `GetCursorPos`/`mouse_event`。
- **stage3 完整多窗核心**（`git show stage3-multiwindow-wip:main/window/captureWindow.ts`）：
  - `SessionWindow[] sessionWindows`：每屏一窗，各窗 `display` + 自带 `frame{bgra,w,h}`（原生缩放清晰）。
  - `startCursorSwitchPoll`：40ms 轮询光标落点屏 → 切换 activeSw（激活/停用 5ms）。
  - `getInputApi`：koffi `GetCursorPos` + `GetAsyncKeyState`。
  - `startSelectionDrag`：25ms 主进程轮询拖选，向各窗广播 `capture-sel-update`（按窗视口裁剪交集，屏界两侧同一条边=边缘拉杆）。
  - `finishSelectionDrag`：跨屏时从各屏 `frame` 按物理矩形切片拼接 → `nativeImage` → `startRegionScreenshot(cropPng, {rect, cropOnly})` 进编辑器。
  - `closeCaptureWindow`：各窗原地 opacity 0 驻留（DPR 环境恒定 → 混合缩放零闪动）。
- **抓帧**：`captureDisplayRectPng(px,py,pw,ph)` 已支持按物理矩形 BitBlt 抓单屏（`main/window/screenshotHelper.ts`）；`dipToScreenRect(null, bounds)` 取所在屏物理矩形。
- **编辑器全栈复用**：跨屏确认后走「外调图模式」（`startRegionScreenshot(external,...)`），标注/OCR/翻译/长截图/录屏/保存零改动。

## 实施方案（分阶段，每阶段可回退可验证）

> 目标文件：`main/window/captureWindow.ts`（核心重写）、`resources/capture.js`（新增 IPC 绘制）、`main/ipc/window/capture.ts`（长截图透传与"全窗非透传"协调）、`app/main.ts`（onGdiFrame 改逐屏帧、服务接口适配）。

### 阶段 0：基线核实
- 确认当前 `main` 无未提交改动（`git status` 干净）。
- 从 `stage3-multiwindow-wip` 导出多窗核心源码作为改后基线参考（不 checkout，`git show` 拷贝进新版）。

### 阶段 1：多窗蒙版 + 逐屏帧显示
- 将 `captureWindow.ts` 改为管理 `sessionWindows`（每屏一窗）。触发时对每个物理屏 `createCaptureWindowShell(display,bounds)` + `ensureCapturePage(sw)`。
- 每屏用 `captureDisplayRectPng(dipToScreenRect(null,display.bounds))` 抓原始 BGRA 作该窗背景 + 存 `sw.frame`；把该帧喂给对应窗与新版 onGdiFrame（逐屏）。
- 渲染端（capture.js）新增：收到本屏帧 → 画默认整屏暗蒙版（连帧边缘透明，内容就绪即清晰）。验证每屏内容与该屏分辨率 1:1 清晰。
- **验证**：双屏混合 DPI 建窗，进截图两屏同时蒙版、各自内容锐利、无发虚/无缝隙/无变形。

### 阶段 2：全局输入 + 自由跨屏拖选
- 移植 `getInputApi` / `startSelectionDrag` / `finishSelectionDrag` / `startCursorSwitchPoll`。
- 选区矩形全程用 **GetCursorPos 物理坐标**（拖选期不 `screenToDipPoint`，存物理；预览时才逐窗 `/scaleFactor`）。
- 渲染端 `capture-sel-drag-begin/update/finish`：各窗只画与自己的交集，`layoutHole` 复用现有蒙版开洞；本窗隐藏自身 DOM 拖选手势，改由主进程广播驱动。
- **验证**：单窗拖框、拖到屏界 → 邻屏同一条边续接、松键定稿；Esc/右键取消。

### 阶段 3：真输入锁定 + 修复假锁屏
- 会话期内**所有窗 `setIgnoreMouseEvents(false)` + `setFocusable(true)`**（包括非活跃屏），彻底挡住底层桌面输入。
- 活跃屏悬停/智能选框：仅 activeSw 接收鼠标事件转发 + 既有 UIA/像素链；非活跃窗纯蒙版零事件但**非透传**（锁住桌面）。
- 主进程轮询统一处理：悬停切换 / 左键起拖 / Enter 确认 / Esc / 右键取消。渲染端热键依赖用 globalShortcut 兜底。
- 与长截图透传协调：长截图仅在 activeSw 的选区洞内透传（复用 `lsPollTick`），其余屏保持锁定。
- **验证**：截图期间点非活跃屏桌面不再触发底层应用；Drag/Move/缩放句柄、工具栏、右键菜单在所属屏正常。

### 阶段 4：所见即所得确认 + 跨屏合成进编辑器
- 完成 `finishSelectionDrag` 物理矩形切片拼接（复用 stage3 `parts[]`），按**同一物理矩形 + 每屏 scaleFactor** 裁剪各 `sw.frame`，`nativeImage` → PNG → `startRegionScreenshot(external,{rect:{x:0,y:0,w:cssW,h:cssH},cropOnly})`。
- 全屏接管模式：外调图 + `external.rect` 对应跨屏裁剪结果，四周暗化 + 选中区高亮。
- **验证**：跨屏框选（含副屏 150%）确认后，编辑器内图像与画框所见逐像素一致（尤其屏幕边界处无偏移/无拉伸）。

### 阶段 5：回归
- 单屏 `仅光标屏` 模式保持原行为不变（作为轻量档保留）；多屏进入默认切 Snipaste 档。
- 长截图（仅在所在屏/选区洞）、录屏取源、OCR/翻译、贴图 pin 窗隐藏恢复、主窗隐藏/恢复，全部回归。
- 性能：触发→亮窗延迟、拖选 25ms 手感，日志级别 `[Screenshot]`/`[cap]` 打点保持一致。
- 崩溃路径：渲染崩溃、`render-process-gone`、单窗建/杀失败不拖累其它窗。

## 验证方式（端到端）

1. 构建：`cd app && node build-host.js`（产出 `app/dist/main.js`）；`capture.js node --check`；`tsc` 无新增错误。
2. 运行：双屏（建议 100%+150%）下 `electron app/dist/main.js`，托盘/热键触发。
3. 逐步做：阶段1 两屏同时清晰蒙版 → 阶段2 跨屏拖选续接 → 阶段3 非活跃屏点不了桌面（真锁屏）→ 阶段4 跨屏确认与所见一致 → 阶段5 回归清单。
4. 采集 `_diag` 日志（ELECTRON_ENABLE_LOGGING）核对 `[Screenshot]`/`[cap]`/`[SMART-*]` 打点。
5. 每阶段失败即回退到该阶段起始 commit，不堆叠（遵循既有「写方案→确认→写码→审查→测试→更新文档」规范，并同步更新 `docs/功能状态清单.md`）。
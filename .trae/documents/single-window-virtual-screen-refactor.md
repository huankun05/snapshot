# 单窗·全虚拟屏重构（根治拖动/智能框选卡死）

## ✅ 2026-09-25 晚间：混合 DPI 双屏全链路修复闭环（用户实测 OK）

放大窗口方案 + 四类跨屏/混合 DPI 问题全部修复，用户双屏（主屏 2560×1440@125% → DIP 2048×1152、
副屏 2560×1440@150% → DIP 1707×960，副屏在左物理 [-2560,0]）实测通过：

### 1. 放大窗口方案（根治预览副屏缩放/发虚）
- **旧 vbox**（各屏 DIP 外接框 -1707,0,3755,1152）→ backing = W×dpr = 4694×1440，只覆盖 4694/5120
  物理宽，DWM 按 1:1 摆布时副屏(150%)内容被按 1.25/1.5 = 0.833× 缩放 → 变小发虚 + 蒙版边缘露桌面。
- **修复**：`computeAllDisplaysWinBounds()` 窗口 DIP 外接框 = 全虚拟物理外接框 ÷ 主屏 sf =
  **(-2048,0,4096,1152)**，backing = W×dpr(1.25) = 物理帧 1:1（5120×1440）。窗口物理覆盖恰为
  [-2560,2560]×[0,1440]，「窗口原点==帧原点」恢复成立 → `smart:pixel-at` 的 x*sf、`smart:at-point`
  的 vsX 换算、裁剪 DIP→物理全部自动正确。渲染端 `drawBackgroundInner` 虚拟屏分支整帧 1:1 直绘。

### 2. 预览态工具栏跨屏分割（clampToolbarToSingleScreen）
- 工具栏默认「选区上方/下方居中」，跨屏选区时横跨屏缝被系统分割成两半。
- 修复：检测工具栏左/右缘所在屏，跨屏则整体移到主屏（primary），否则移到面积较大屏。

### 3. 单击智能框选中小框（竞态）
- 根因：`pendingWindowClickRect = hoverWindowRect`（异步回包驱动），单击瞬间回包已覆盖成小框
  （日志：悬停副屏整屏 1707x959@341,0，单击选中却是 381x509@25,51）。
- 修复：改取 `hoverVisualRect || hoverTargetRect || hoverWindowRect`（所见即所得）。

### 4. capture-longshot-gdi 屏外点换算
- 放大窗后 vsX=-2048 在所有屏 DIP 范围外（虚拟桌面最左 -1707），`dipToScreenPoint` 不可靠。
- 修复：vsX/vsY→物理 从 `dipToScreenPoint` 改为 **×主屏缩放率**。

### 5. 跨屏部分选区保存棋盘格（cropPhysicalFromVirtualFrame 坐标系混用）
- 现象：跨屏随手拉选保存，主屏区域透明（棋盘格集中在右 20% 列、顶 10%、底 20% 行）。
- 根因：帧源段换算 `fx = pb.x + (ix - db.x)*sf - ps.x` 把 **gd（窗口/主屏 DIP 系，÷主屏 dpr）**
  与 **db.bounds（屏幕 DIP 系，÷各自 sf）** 两种坐标系直接相减再乘 sf → 副屏段 fx 算成 527
  （正确 865）、fw 2034（正确 1695）；主屏段 fx=2560 超出画布宽 2556 → **主屏内容整个画不进
  画布 → 右侧棋盘格**。日志实锤：副屏段 f(527,369,2034x974) 与 c(865,308,1695x811) 数值对不上。
- 修复：gd ×dpr 先换算到桌面物理，与每屏 `physicalBounds` 在**同一物理系**求交，帧源段 =
  物理坐标 - 帧桌面原点；窗口段（drawCanvas/annotCanvas backing 与 bgImage 同为全帧物理 1:1）
  坐标直接等于帧源段。复算：输出 2218×811，副屏 f(865,308,1695x811) + 主屏 f(2560,308,523x811)
  无缝相邻。附带探测点：帧抽样（`[cap] frame sample` 四角+两屏中心 RGBA）与 crop 明细
  （`[cap] crop physical` displays/parts 全量打印）。

### 6. 智能选框缺「光标所在屏整屏」级（appendScreenLevels）
- 现象：副屏悬停滚轮切层，最大框是窗口级，再滚直接「两屏一起框」。
- 根因：层级链「屏幕级」只有全窗口（W×H=两屏），缺中间的单屏级。
- 修复：`currentScreenCssRect()`（屏幕 DIP bounds - 窗口 DIP 原点 = CSS rect）+ `appendScreenLevels`
  （尾链追加「光标所在屏整屏」→「全虚拟屏」两级，近重复去重），`getMergedSmartLevels` 与
  `getActiveChain`（含滚轮路径）统一走它。

### 7. 副屏智能识别错误（smart:at-point 坐标系混用）
- 现象：同一窗口主屏识别正常、副屏识别错/识别不了。
- 根因：渲染端传 `x + vsX` 是**窗口/主屏 DIP 系**（全虚拟物理 ÷ 主屏 dpr），主进程 else 分支
  `dipToScreenPoint` 期望**虚拟桌面 DIP 系**（各屏 ÷ 各自 sf）——两系在副屏（150% vs 125%）
  相差 ~262px，UIA 查询打在错误位置。主屏 DIP 系与虚拟桌面 DIP 系一致 → 碰巧正常。
- 修复：渲染端 `smart:at-point` 传 `coordSpace:'pdip'`（主进程 `dipX × 主屏dpr` 即物理，两屏
  统一正确），sf 改用帧实际 backing 比例（bgCanvas.width/W，与像素链一致）。

### 8. 单屏浮层钳制（selectBar 角标 / captureHint 顶部提示条）
- selectBar（悬停智能框尺寸角标）默认贴框左上角，框贴屏缝时角标横跨两屏被分割 → 按角标位置
  所在屏整体钳进屏内。
- captureHint（顶部操作提示条）CSS `top:18px; left:50%`，窗口横跨两屏时 left:50% 恰落在屏缝
  （CSS 2048）上被分割 → 改为在光标所在屏内水平居中（`currentScreenCssRect`），宽度缓存避免
  drawMask 每帧强制重排。

**遗留课题**：智能框像素链在双屏不同 DPI 下已随放大窗口方案自动正确（窗口原点==帧原点恢复）；
长截图滚动拼接、跨屏拖选长截图组合暂未回归。

## ✅ 2026-09-25 根因已定位并修复（按 F1 卡死）

- **根因实锤（日志）**：`capture.html` 加载失败 —— 09-24 预热与 14:55 按 F1 各一次
  `ERR_FILE_NOT_FOUND loading 'file:///F:/Work/Create/OCR/screenshot/app/resources/capture.html'`。
  `getCaptureHtmlPath()` 旧逻辑 `find(existsSync) ?? candidates[0]`：分离启动时 `cwd`=app 目录，
  三个候选（cwd / app.getAppPath / __dirname）运行时判为不存在 → 兜底返回 **cwd 路径（不存在）**
  → 页面从没加载成功 → 渲染端无 JS、无 `[cap]` 日志（连 recv 都没有）→ `capture-ready TIMEOUT 800ms`
  → 空白暗蒙版「什么也动不了」。CSP 警告第二次出现 = 加载失败后 F1 重试 loadFile，并非页面重载。
- **修复**（captureWindow.ts `getCaptureHtmlPath`）：候选改为 **`__dirname`（打包后=app/dist →
  `../../../resources`=工作区 resources）优先**，`app.getAppPath`、`cwd` 次之；全部缺失时打
  `capture.html NOT FOUND` 全量诊断（路径+存在性）便于一次定位。
- **探测点（新增）**：
  - 渲染端 capture.js 顶部 `[cap] capture.js script start t=... dpr=...`（页面 JS 是否执行的分水岭）。
  - 主进程 built-in 分支发送前 `[Screenshot] send capture-image t=... raw=WxH ...`（此前无发送打点）。
  - 收到 `capture-ready` 打 `[Screenshot] capture-ready ok t=...`（区分「到达即 ok」与「800ms 兜底」）。
- **验证**：`node build-host.js` + `node --check capture.js` 通过；分离启动后日志链完整——
  `warm-up done` → `capture.js script start`（**此前从未出现**）→ `capture page loaded (persistent)`，
  无 ERR_FILE_NOT_FOUND、无 render-process-gone。**等用户双屏（100%+150%）实机 F1 回归**。
- **遗留课题（本次未动，等基础流程实测确认后处理）**：智能框像素链混合 DPI 错位
  （`smart:pixel-at` sf 全局平均 → 需按所在屏 scaleFactor + vboxPhys 原点换算，见下方嫌疑①），
  及 ② 渲染端背景画布坐标系（bgCanvas=W×dpr 非每屏 1:1）、③ 大画布 PNG 编码同步阻塞。

## ⚠ 实测进展（2026-09-24 收工时）


- **已完成**：主进程 captureWindow.ts 已重构为单窗·全虚拟屏（`ensureVirtualCaptureWindow` +
  `captureVirtualScreenComposite` 单帧抓取 + 一次下发 `multiWindow:false`），多窗机制
  （startCursorSwitchPoll / activeSw / startSelectionDrag / finishSelectionDrag / capture-sel-* 等）全部删除；
  渲染端 capture.js 删除 screenDeactivated / capture-deactivate / capture-activate 及 multiDragMode 多窗分支。
  `node build-host.js` + `node --check capture.js` 通过；新实例已分离启动（单窗预热日志
  `warm-up done (single virtual window)`、F1/Alt+C 注册成功）。
- **教训**：用户早前实测到的是 11:13 启动的**旧多窗实例**（日志 `mode=multi windows=2`、每次
  SMART-CONFIRM 后渲染冻结 ~1.1s），并非新版 —— 确认「改完必须重启应用才生效」。
- **❌ 待解决（明天第一优先级）**：用户实测**新版按 F1 后整个应用卡死、什么也动不了**（非旧实例遗留）。
  卡死发生在截图蒙版出现/交互阶段。**已锁定三个嫌疑方向，明天按此排查**：
  1. **像素链坐标错位**（`smart:pixel-at` 主进程 app/main.ts L434-457）：公式 `physX=x*sf` 假设
     「窗口原点==帧原点」，单窗全虚拟屏下不成立（帧原点=vboxPhys 左上、有负屏偏移），且
     `sf=bgCanvas.width/W` 是全局平均，混合 DPI（100%+150%）下逐屏比例不同 → 智能框错位；
     错位框单击确认 → 越界 sel → drawMask/裁剪大区域 → 卡死。
     修复方向：渲染端把窗口 DIP 换算成「所在屏物理帧坐标」再查询（传 sf:1），回包物理框转回窗口 DIP。
  2. **渲染端背景画布坐标系**：bgCanvas = W×dpr（统一窗口 dpr），drawBackgroundInner 把各屏物理图
     按 DIP 目标缩放绘制，混合 DPI 下非每屏 1:1 物理 → 截图发虚/尺寸错。远景需物理系画布
     （backing=vboxPhys 尺寸 + CSS 拉伸），属大改，先修错位/卡死再评估。
  3. **大画布 PNG 编码**：单窗全虚拟画布（如 4800×1350）toDataURL 编码数兆像素 → 全屏拖选松键
     同步阻塞渲染线程数百 ms。若错位修复后仍卡，需限幅或改异步/分块。
- **排查方法（明天）**：按 F1 后用日志确认卡死点（[cap]/[SMART-*] 打点尾部）；复现路径：
  F1 → 蒙版 → 悬停/单击智能框/拖选 → 卡死。用 `_diag` 日志 + 分步二分定位。
- 工作树未提交（git 工作树脏，相对 main 为本次单窗重构改动）；单屏最佳基线仍为 366fc3e。

## Context（为什么改）
当前截图用的是「每屏一窗」多窗方案（`main/window/captureWindow.ts` 内 `sessionWindows`、`startCursorSwitchPoll`、`startSelectionDrag` 轮询、`capture-sel-*` 广播等）。实测性能灾难：
- 主进程把 `multiWindow:true` 传给渲染端，悬停/拖动走 `capture-sel-start` → 主进程每 25ms `GetCursorPos` 轮询并广播所有窗；每屏各发一张 33MB `smart:frame`（getImageData + UIA），主进程被反复阻塞。
- 表现：一拖动就卡死；智能框一单击就卡死；选框明显不如单屏流畅。
- 单屏档（`multiWindow:false`）走渲染端**本地 DRAWING 快速路径**（mousemove 自驱 + mouseup 从 `bgCanvas` 裁图进编辑器），所以飞快。

**方向已定**：改为「单窗·全虚拟屏」——一扇窗覆盖所有屏的外接矩形，逐屏物理 BitBlt 拼成 **一张** 全虚拟物理 BGRA 作背景，单次智能识别。如此渲染端 `multiWindow:false` 走回本地快速路径，跨屏拖动/裁剪在单窗合成图上天然完成，性能回到单屏级。

## 核心洞察（复用而非重建）
- helper 已有现成函数 `captureVirtualScreenComposite(layouts)`（[screenshotHelper.ts](file:///f:/Work/Create/OCR/screenshot/main/window/screenshotHelper.ts)），逐屏 `gdiGrabRect` 物理矩形行拷贝拼成整块虚拟屏 BGRA。`layouts` 用现成的 `screen.dipToScreenRect(null, d.bounds)` 逐屏构建即可（`getDisplayLayouts` 实际不存在，勿依赖其注释）。
- 渲染端 `drawBackgroundInner`（[capture.js](file:///f:/Work/Create/OCR/screenshot/resources/capture.js)）**已经支持**把一张全虚拟物理图按 `captureDisplays` 各自的 `physicalBounds→bounds` 映射画进单窗；hover/框选用**窗口内 DIP 坐标**（W/H=innerWidth）。只要单窗覆盖全虚拟屏，跨屏悬停/拖动/裁剪就是同一套本地逻辑。
- 渲染端 `multiDragMode` 由载荷 `multiWindow` 字段决定。单窗方案传 `multiWindow:false`，渲染端状态机自动回到快速路径（智能框单击本地 SELECTED、拖动本地 DRAWING）。

## 实施步骤（已完成部分标注）

### 1. 主进程：单窗生命周期（captureWindow.ts）— ✅ 已完成
- `sessionWindows` 收敛为单窗；窗口外接矩形 = 所有 `display.bounds` 的外接框 vbox。
- `ensureVirtualCaptureWindow(vbox)` 建/换/复用那端口窗；预热只建该单窗一个壳。
- `closeCaptureWindow()` 收敛为单窗收场（capture-clear → setIgnoreMouseEvents(true) → setFocusable(false) → setOpacity(0) 原地驻留）。

### 2. 主进程：单帧抓取 + 单次下发（startRegionScreenshot built-in 分支）— ✅ 已完成
- `captureVirtualScreenComposite(vbox 内各屏 physicalBounds)` 抓**一张**全虚拟物理 BGRA，存 `sw.frame`。
- `options.onGdiFrame?.(composite.bgra, width, height)` **只喂一次**。
- 只向该单窗发 **一次** `capture-image`：`rawFrame=composite`、`virtualScreen=vbox(DIP)`、
  `physicalScreen=`虚拟物理外接框、`displays=`全部屏（各带 bounds+physicalBounds+scaleFactor）、
  `visibleWindows=getVisibleWindows()`、`multiWindow:false`、`framePrepared:true`、
  `cursor`=窗口内 DIP 光标。
- 等待单窗 `capture-ready` 后 `revealMaskWindow`（bounds=vbox）、`finalizeCaptureWindow`。

### 3. 删除已死的多窗机制（captureWindow.ts）— ✅ 已完成
- 删除 startCursorSwitchPoll/stopCursorSwitchPoll、activeSw、startSelectionDrag/finishSelectionDrag、
  selDrag、getInputApi/cursorPos/VK_*、capture-sel-start 处理器、capture-smart-confirm 广播段、
  capture-deactivate/activate 发送、逐窗 revealMaskWindow/capture-image 循环。

### 4. 渲染端（capture.js）— ✅ 已完成多窗残留清理（❌ 坐标换算待修）
- 删除 screenDeactivated/capture-deactivate/activate handler、multiDragMode 多窗分支；
  核心业务逻辑（sendSmartFrame/drawBackgroundInner/layoutHole/detectTextBlockAt 等）未动。
- **❌ 待修**：像素链坐标换算（见顶部「实测进展」嫌疑 1）——`requestSmartPixel` 传全局 sf，
  单窗全虚拟屏下错位；需按所在屏 scaleFactor + vboxPhys 原点换算成帧内物理坐标。

### 5. 清理 — ✅ 已完成
- 主进程多窗代码直接删除；渲染端多窗 handler 删除；helper 的 koffi GetCursorPos 权威写法保留。

## 验证（部分完成）
1. 构建 + 语法：`node build-host.js`；`node --check resources/capture.js`；tsc — ✅ 通过。
2. 启动无崩溃：分离方式（`Start-Process -RedirectStandardOutput/-RedirectStandardError 到文件
   -WindowStyle Hidden`）避免 EPIPE → appLogger 无限 FATAL（权威踩坑，勿用后台管道）— ✅ 通过。
3. **❌ 实机双屏（100%+150%）回归：未通过** —— 用户实测按 F1 卡死，明天按「实测进展」三嫌疑排查。
   - 目标：一张暗蒙版瞬间盖满全部屏；悬停只出现一个流畅智能框；单击智能框一键定稿；
     手动跨屏拖选流畅、拼接正确；右键/Esc 退出正常；单屏场景与 366fc3e 基线一致（零退化）。

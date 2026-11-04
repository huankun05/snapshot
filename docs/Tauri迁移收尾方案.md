# Tauri 迁移收尾方案

> 定位：**Tauri/WebView2 是新主线，Electron 逐步退役**（用户 2026-10-31 定调）。
> 本文档是 tauri-spike 的收尾方案，按 `工作规范.md` 九步流程走——本文件即「步 1 写方案」，
> 用户确认后进入步 3 写代码。
>
> 创建：2026-10-31 | 最后更新：2026-10-31
> 关联：`docs/功能状态清单.md`（单一事实源）、`docs/工作规范.md`、
> `native/smart_uia/`（UIA 原生内核，共用不迁）、`tauri-spike/`（本方案的实现载体）

---

## 一、结论先行

spike 已经验证了两件关键的事，**方向不需要再论证**：

1. **「capture.js 一字不改跑在 WebView2」这条路成立**——`tauri-spike/ui/capture.js` 与
   `resources/capture.js` 的 SHA256 完全一致，12799 行渲染端逻辑零改动。
2. **智能选框在 Tauri 下能出框**——因为 `smart_uia.dll` 由独立 node 辅助进程独占
   （`tauri-spike/f1_worker.js`），绕开了「UIA 客户端在 WebView2 宿主进程内返回空树」
   这个致命问题（2026-10-28 实锤：同点同时刻 node 进程 n=4 / tauri 宿主 n=1）。

剩下的不是可行性问题，而是**收口问题**：一批坐标换算 bug、不可复现的构建方式、
一批未移植的功能通道、以及若干硬编码路径。

**总量判断：P0 约 2 天，P1 约 6~8 天，P2 约 1~2 天。**

---

## 二、spike 现状盘点

### 2.1 已迁移（可保留）

| 能力 | 实现位置 | 备注 |
|---|---|---|
| 全虚拟屏抓帧 | `main.rs: capture_virtual_screen()` | GDI BitBlt → BGRA，单帧 5120×1440 |
| 捕获窗（透明/置顶/无边框/隐藏态） | `main.rs: setup()` | 驻留隐藏，`capture-ready` 后亮，800ms 兜底 |
| 智能选框三件套 | `smart:at-point` / `smart:map-get` / `smart:pixel-at` | 走独立 node worker + `smart_uia.dll` |
| 焦点解锁 | `main.rs` reveal 分支 | ALT 脉冲 + `set_focus`（微信等 Qt 应用必需） |
| 贴图窗 | `create_pin_window()` + `pin-*` 通道 | 缩放/拖动/复制/保存全通 |
| OCR / 表格 / 智能版面 | `proxy_18766()` | 直接代理 Python 侧车，壳无关 |
| 翻译 | `proxy_18766("/translate")` | 壳无关 |
| store 读写 | `store_load/store_save` | **但路径与 Electron 不互通，见 §4.2** |
| 托盘 + 全局热键 | `setup()` | F1/F2 + Alt+C，**无用户可配热键** |
| 剪贴板写图/写文本 | `clip_write_image/text` | 走 tauri-plugin-clipboard-manager |

### 2.2 未迁移（stub 或 notPorted）

| 类别 | 通道 | Rust 现状 | 性质 |
|---|---|---|---|
| 长截图 | `capture-longshot-gdi` / `-frame` / `-save` / `-editor`、`capture-ls-autoscroll` / `-debug` / `-active` | `notPorted` | **本轮不迁**（用户 2026-10-31 决定，主线先跑通） |
| 翻译细分 | `capture-translate-text`（板块批量翻译依赖它） | `notPorted` | P1 待做 |
| 问 AI | `capture-ask-ai` | `notPorted` | P1 待做 |
| 版面通道 | `capture-ocr-local-layout` / `-layout-status` / `-layout-cancel` | `deprecated` | **已废弃**（用户 2026-10-31 决定；渲染端从未调用，Electron 侧已一并移除） |
| 录屏 | `capture-record-save` / `capture-record-ignore-mouse` | `notPorted` | **本轮不迁** |
| 桌面源枚举 | `capture-desktop-sources` / `-for-window` | `[]` / `null` | P1 待做（GDI 已有，desktopCapturer 回退可后置） |
| 设置窗 | `settings:openPath` / `getLoginItem` / `setLoginItem` / `pickFolder` / `appInfo` / `minimize` / `toggle-max` | 未实现 | P1 待做 |
| 识别设置 | `ocr:ensure` / `ocr:health` / `ocr:restart` | 未实现 | P1 待做 |
| 热键设置 | `screenshot-hotkey:get` / `:set` | 未实现 | P1 待做 |
| 外部触发 | `system:screenshot` / `system:screenshot:region:start` | 未实现 | 后置 |
| 校准工具 | `smart:calib-run` / `smart:calib-report` | `null` | 后置（调试工具） |

> ⚠️ **不属缺口**：像素兜底链（`smart:pixel-at`）恒返回空 levels 是**正确行为**，
> 不是"未移植"——渲染端总闸 `PIXEL_CHAIN_FOR_BOX=false`（2026-10-27 用户定调）。
> 「无 UIA 应用 → 窗级大块」由 `visibleWindows` + native `smart-bigbox.txt` 承担。

### 2.3 壳级能力缺口（非通道）

单实例锁（**2026-10-31 已补** ✅）、开机自启、OCR 预热策略（Electron 有 capture-prewarm/常驻/按需三档）、
日志落盘（Electron 写 `%APPDATA%\petalsnap\logs`，spike 只有 `%TEMP%\petalsnap-spike.log`）、
DWM 开窗动画禁用、原生截图插件引擎（spike 只有 GDI BitBlt 一条路）、
托盘菜单项补全、设置窗 UI（`tauri-spike/ui/settings.html` 只是 1.7KB 占位页，
**且没有 `settings.js`**——正式设置 UI 整体未迁移）。

---

## 三、P0：坐标同源与构建可复现（最高优先级）

> ✅ **本节六项已全部落地并验证（2026-10-31）**，逐项状态与实测数据见 **§八 P0 实施与验证结果**。
> 下面保留原始问题描述（对照"改前是什么"用）。

### P0-1 ★ `visibleWindows` 原点错配 512 CSS px —— 「无 UIA 树应用给大块」档位直接不达标

**事实链（已逐行核实）**

- `capture.js:1391 setVisibleWindowRects(windows, virtualScreen)` 要求 `windows` 与
  `virtualScreen` **同一坐标系**：它做 `item.x - vs.x` 得到窗口内坐标。
- `capture.js:2160-2165` 定调权威坐标系：
  > 窗口 CSS 系 = 桌面物理 ÷ canvasDpr 再减窗口原点；`px = (css + vs.x) × canvasDpr`；
  > `virtualScreen.x` 是**全局 CSS 原点**（用户机器上 = −2048）。
- Rust `main.rs:745`：`enum_visible_windows(dpr_est, vx as f64, vy as f64)`
  —— 传进去的 `vx` 是**物理**原点（用户机器上 = −2560），而函数参数名却是
  `vs_css_x`（CSS 原点）。函数内部 `css = v/dpr - vs` → `物理/1.25 + 2560`。
- 同一份 meta 里 `virtualScreen.x = vx/dpr_est = −2048`（`main.rs:737`）。
  → **一份 meta 内两套原点，偏差恒定 512 CSS px**（= 2560 − 2048）。

**后果**：`visibleWindows` 是「无 UIA 约束应用（Zcode/游戏等）→ 窗级大块」的**唯一数据源**
（像素链已按 2026-10-27 定调全局停用，`capture.js:1810 PIXEL_CHAIN_FOR_BOX = false`）。
这个档位当前**整体偏移 512 px**，等于验收标准的一档完全不达标。

**修法（与 Electron 同源，不引入新公式）**

```
// 统一用「CSS 原点」，三处同源：
let sf        = 窗口 scale_factor()        // 见 P0-2
let vs_css_x = vx as f64 / sf              // = −2048，与 meta.virtualScreen.x 同值
let vs_css_y = vy as f64 / sf
enum_visible_windows(sf, vs_css_x, vs_css_y)
```
并让 `meta.virtualScreen` 与 `cursor` 也复用同一个 `vs_css_x/vs_css_y` 变量，
杜绝「两个地方各算一次」再次分叉。

### P0-2 ★ dpr 硬编码 1.25

`main.rs:719 let dpr_est = 1.25;` 被用于 meta.virtualScreen、meta.cursor、
`enum_visible_windows` 三处。

- Electron 侧是 `screen.getPrimaryDisplay().scaleFactor` 动态取值
  （`captureWindow.ts:103`）。
- 用户机器恰好是主屏 125% → **当前巧合正确**，换机器 / 改主屏缩放即全线错位。
- Tauri 侧可以做得更好：`WebviewWindow::scale_factor()` 是**窗口真实 dpr**，
  比「猜主屏」更准（窗口跨屏时 WebView2 用单一 dpr）。

**修法**：`dpr_est` 改为从窗口取 `scale_factor()`（取不到才回退 1.0），
并与前端 `canvasDpr`（`bgCanvas.width / W`）对齐口径。

> ⚠️ 混合 DPI 红线（沿用既有教训）：窗口是**单一 dpr 表面**，
> `phys = (css + vsX) × winDpr` 对所有屏同时成立。**任何一环都不要再经 DIP 中转**，
> 也不要用 `d.bounds`（各屏自己的 DIP 系，副屏 ÷1.5 会整体缩水 0.833）。

### P0-3 `displays[]` 缺 `primary` 标记

Electron `captureWindow.ts:613` 发 `primary: d.id === screen.getPrimaryDisplay().id`；
Rust `enum_displays()`（`main.rs:648`）没有该字段 → 前端 `d.primary` 恒 undefined
（`capture.js:7904` 的诊断行已经在打 `p${!!d.primary}`）。

**修法**：`enum_displays()` 增加主屏判定（`MONITORINFOEXW` 的 `MONITORINFOF_PRIMARY`
或与 `GetSystemMetrics` 虚拟原点比对），补 `primary` 字段。

### P0-4 ★ 构建不可复现：`patch_*.js` 一次性打补丁

`tauri-spike/src-tauri/` 下有 4 个一次性补丁脚本（`patch_windows.js` / `patch_kernel.js` /
`patch_auto.js` / `patch_fallback.js`），它们用**字符串锚点**往 `main.rs` 里插代码：

```js
const anchor1 = '/// 枚举显示器（displayCssRect 用 physicalBounds 优先；bounds 给各屏 DIP 兜底用）';
if (!s.includes(anchor1)) { console.log('enum fn anchor fail'); process.exit(1); }
```

**问题**：① 锚点文案一改，脚本直接 exit(1)；② 重跑会**二次插入**同一函数 → 编译不过；
③ `main.rs` 里现在的 `enum_visible_windows` 就是这么插进去的（源码里留着"一次性补丁"注释）。
这是把源码变更藏在脚本里，无法 review、无法复现构建。

**修法**：把 4 个脚本插入的全部代码**并回 `main.rs` 本体**，删除脚本；
后续改动一律直接改 `main.rs`，用 git diff review。

### P0-5 硬编码绝对路径 → 不可分发

| 位置 | 现值 |
|---|---|
| `main.rs:130` | `F:\Work\Create\OCR\screenshot\tauri-spike\f1_worker.js` |
| `main.rs:404` | `F:\Work\Create\OCR\venv_ocr\Scripts\python.exe` |
| `main.rs:405` | `F:\Work\Create\OCR\rapidocr_service.py` |

**修法**：worker 脚本与 Python 侧车随包分发，路径从「可执行文件同级目录 / 资源目录」解析，
保留环境变量覆盖（`PETALSNAP_NODE` / `PETALSNAP_SMART_WORKER` 已有，先加
`PETALSNAP_PYTHON` / `PETALSNAP_RAPIDOCR_SCRIPT`）。

### P0-6 单实例锁缺失

Electron `app/main.ts` 有单实例锁；Rust 没有 → 可同时开多个实例抢全局热键。

**修法**：启动时用命名互斥体（Windows `CreateMutexW`，`windows` crate 已带
`Win32_System_Threading`）+ 已存在则激活已有窗口并退出。

---

## 四、P1：功能补齐

### 4.1 长截图（7 通道，工作量最大）

`capture-longshot-gdi` / `-frame` / `-save` / `-editor` + `capture-ls-autoscroll` /
`-debug` / `-active`。Electron 侧实现在 `main/ipc/window/capture.ts:445-630`、
`main/services/gdiGrabWorker.ts`，滚动注入靠 `lsWheel` PostMessage。

- **滚轮注入**：Electron 侧靠 `main/ipc/window/capture.ts` 里的 PostMessage 注入，
  需确认是否依赖 Electron 特有 API（若有，Tauri 侧用 `SendMessageW` 重写）。
- **编辑器窗**：`capture-longshot-editor` 要开一扇独立编辑窗（Electron 用 BrowserWindow），
  Tauri 侧需新增窗口类型 + 与 `capture.js` 的消息协议。
- **建议排期**：长截图整体搁置已久（`功能状态清单.md` §3.1 标「🔶 搁置中待拾起」），
  迁移时可**继续搁置**，先把主截图 + 选框 + OCR + 翻译 + 贴图 + 设置这条主线在 Tauri 下跑通。

### 4.2 设置窗整体迁移（阻塞"设置"这一整块）

- `tauri-spike/ui/settings.html` 现在是占位页，**且没有 `settings.js`**。
- 需要：搬 `resources/settings.js`（741 行）+ `settings.css`，并实现
  `settings:*`（7 个）+ `ocr:*`（3 个）+ `screenshot-hotkey:get/set`（2 个）通道。
- **store 路径必须先统一**（见 §4.3），否则设置写了读不回来。

### 4.3 store 路径互通 + 数据迁移

- Electron：`%APPDATA%\petalsnap`（eIsland_store）。
- Rust：`%APPDATA%\petalsnap-spike\store.json`。

→ 用户在 Electron 里配好的热键、识别引擎、翻译语言**在 Tauri 下全部"消失"**。

**修法**：Rust 侧改用与 Electron 相同的 store 路径与键格式，并写一次性迁移
（读 Electron 的 store → 写 Rust 的 store）。**这是迁移能否被用户接受的关键一步。**

### 4.4 其余通道

| 通道 | 说明 | 预估 |
|---|---|---|
| `capture-translate-text` | 板块批量翻译（10-02 上线的主线功能）依赖它 | 0.5 天 |
| `capture-ask-ai` | 直接搬 `main/services/askAiService.ts` 逻辑到 Rust（reqwest 已就位） | 0.5 天 |
| `capture-desktop-sources` | Rust 自己枚举显示器源，或直接走 GDI（已有） | 0.5 天 |
| `capture-ocr-local-layout` 三件 | 旧 PP-StructureV3 版面通道，**当前主线已改 RapidOCR**，可判定废弃 | 决策项 |
| `capture-record-save` 等录屏两件 | 录屏功能移植成本高，建议二期 | 二期 |
| `smart:calib-*` | 校准调试工具，可后置 | 后置 |

### 4.5 壳级能力

单实例锁（P0-6）之外：开机自启（`settings:setLoginItem`）、
OCR 预热三档策略（capture-prewarm / 常驻 / 按需）、
日志落盘到 `%APPDATA%\petalsnap\logs`（与 Electron 对齐）、
DWM 开窗动画禁用、托盘菜单项补全（贴图恢复 / 退出 / 关于）。

---

## 五、P2：一致性与收尾

1. **smart 内核双份漂移**：`main/services/smartUiaNative.ts`（Electron worker_threads 版）
   与 `tauri-spike/f1_worker.js`（独立进程版）是**同一套 UIA 决策逻辑的两份实现**
   （地图外发、EFP 交叉校验、rowMissing 重拍、激活戳…）。
   → 需要一份**权威实现** + 明确分工，否则 native cpp 每次改动都要双改。
   建议：把决策逻辑抽成独立的 JS 模块，两端各只写"进程通信层"。
2. **native cpp 的 `smart-bigbox.txt` 名单机制**：DVL 是共用资产，Tauri 侧自动生效，
   但**功能状态清单里没有这一条**，需补文档（无 UIA 应用 → 窗级大块的用户规则）。
3. **过期占位页清理**：`tauri-spike/ui/index.html`（11KB，早期独立 spike 页，
   引用了不存在的 `spike_log` 命令）已无用；`settings.html` 占位文案
   写着"标注/工具栏 未迁移"，实际 capture.js 已复用、标注是通的 → 文案过期需更正。
4. **Electron 退役路线**：P0+P1 完成后，Electron 侧停止新功能；
   保留 `native/smart_uia/`、`resources/`（渲染端单一事实源）、`rapidocr_service.py` 两侧同步约定。
5. **渲染端双份漂移守卫（2026-10-31 已落地 ✅）**：`tauri-spike/ui/` 是 `resources/`
   的副本，而整个 spike 的前提就是「capture.js 一字不改跑在 WebView2」——两边一旦漂移，
   Tauri 与 Electron 行为会**静默不一致**（不报错，只是行为悄悄不同，极难排查）。
   新增 `tools/check-render-sync.js`：断言 `capture.js`/`capture.css`/`pin.js`/`pin.css`
   **逐字节一致**，`capture.html`/`pin.html` 只允许多出 shim 引入行，其余必须一致。
   当前状态：**全部一致**（顺带把 spike 的 `pin.html` 缩进规范化，与源逐行对齐）。
   建议：改 `resources/` 渲染端后必跑一次（可挂 pre-commit）。

6. **入库体积守门**：`.gitignore` 原先没覆盖 Rust 的 `target/`——`tauri-spike/` 整目录
   实测 **2.04 GB**（含构建产物），直接 `git add` 会把 2GB 塞进仓库。
   已补 `tauri-spike/src-tauri/target/` 与 `tauri-spike/src-tauri/gen/` 两条规则
   → 实际纳入 **53 个文件 / 2.12 MB**（`gen/` 是 tauri 自动生成的 schema，可再生成）。

---

## 六、验证方式

| 项 | 方法 | 门槛 |
|---|---|---|
| 坐标同源 | 同一物理坐标下，对比 Electron 与 Tauri 的 `smart:at-point` 回包矩形 | 偏差 ≤ 1 CSS px |
| 窗级大块 | 在无 UIA 树应用（Zcode/游戏）上悬停 | 框住的是目标窗，不是偏移 512px 的框 |
| 混合 DPI | 主屏 125% + 副屏 150% 下，副屏坐标逐点核对 | 副屏无偏移/无缩放 |
| 通道覆盖 | 写 harness 遍历渲染端全部 `invoke`/`send` 通道，列出 Rust 未实现项 | 清单为空或全部标注为「有意 stub」 |
| 构建可复现 | 删除 `patch_*.js` 后全新 clone → `cargo build` | 一次通过，无脚本介入 |
| 回归 | `resources/capture.js` 与 `tauri-spike/ui/capture.js` SHA256 一致 | 渲染端零改动 |
| 体积收益 | 对比 Electron 打包体积 vs Tauri exe | 记录实测数字 |

---

## 七、用户拍板结果（2026-10-31）

| 议题 | 拍板 | 落地情况 |
|---|---|---|
| 方案整体 | **确认，按方案开工** | P0 全部落地并验证（见 §九）；P1 待下一轮 |
| 长截图 / 录屏 | **本次不迁**，主线先跑通 | Tauri 侧标注 `notPorted`；长截图/录屏通道逐条列出 |
| 旧版面通道 `capture-ocr-local-layout` 三件 | **直接废弃** | 全仓核实渲染端**从未调用**（capture.js 无任何 invoke）；Electron 侧移除三个 `ipcMain.handle` + 对应 import；Tauri 侧返回 `{code:"deprecated"}`（与 `notPorted` 区分） |
| store 数据迁移 | **首次启动弹窗让用户确认导入** | P1 待做（Rust 现读 `petalsnap-spike\store.json`，Electron 用 `petalsnap`） |

---

## 八、P0 实施与验证结果（2026-10-31）

### 8.1 逐项状态

| 项 | 状态 | 落地 | 验证 |
|---|---|---|---|
| P0-1 visibleWindows 原点 | ✅ | `enum_visible_windows` 改传 CSS 原点；`virtualScreen` / `cursor` / `visibleWindows` 三者共用同一对 `vs_css_x/vs_css_y` 变量，杜绝分叉 | 离线枚举实测：**每个窗框恰好偏 512 CSS px**（旧版）；修后物理 x=0 的窗落在 CSS 2048 = 副屏/主屏分界 ✓ |
| P0-2 dpr 硬编码 | ✅ | `let dpr_est = 1.25` → `win.scale_factor()`（回退 1.0，不猜） | 运行时日志：`[dpr] capture window scale_factor=1.250 → 全局 CSS 原点=(-2048,0)`；渲染端 `[shim] devicePixelRatio = 1.25` —— **两端一致** |
| P0-3 displays 字段 | ✅ | 补 `primary`；`scaleFactor` 改该屏真实值（原恒写 1）；`bounds` 改回 DIP 语义（原塞物理值） | 与 Electron `captureWindow.ts:608-614` 逐字段对齐 |
| P0-4 构建可复现 | ✅ | 删 4 个一次性 patch 脚本（已移回收站），代码并回 `main.rs` 本体；清掉它们留下的死代码（`worker_call`/`dll_*`/`rect_contains`/`map_inside`/`pick_chain`/`QUERY_TX`/`REBUILD_AT`/`PIXEL_FRAME`） | `cargo build --release` **零错误零警告**（13,511,680 B） |
| P0-5 路径去硬编码 | ✅ | 新增 `resolve_resource(env, rel)`：环境变量 → exe 同级（含 `resources/scripts/assets`）→ 向上逐级查找 8 级 | 运行时 `[worker] spawned pid=…` + `[f1_kernel] ready` → 向上查找命中 `tauri-spike/f1_worker.js` ✓ |
| P0-6 单实例锁 | ✅ | 命名互斥体 `Local\PetalSnapTauriSpike`（需给 windows crate 开 `Win32_Security` feature） | 运行时实测：第二实例打印 `[instance] another instance is running → exit` 并退出 ✓ |
| 附带：dpr 两端交叉校验 | ✅ | Rust 启动打 `[dpr] …`、渲染端打 `[shim] devicePixelRatio`（两行相邻）；`shim.js` 在会话期再比对 `winDpr` vs `devicePixelRatio`，不一致立刻报警 | 与 `shim.js` 的 dpr 校验同批上线 |
| 附带：layout 通道废弃 | ✅ | Electron 侧移除三 handler + import；Tauri 侧 `deprecated` | 全仓 grep 确认渲染端零调用 |
| 附带：像素链定性澄清 | ✅ | `smart:pixel-at` 恒返回空 levels 并注明「有意停用」而非「未移植」 | 与渲染端 `PIXEL_CHAIN_FOR_BOX=false` 对齐 |

### 8.2 ⚠️ 被实测推翻的一个初判（记录以免后人重复踩）

初判：「日志里 Electron 可见窗 29 个、Tauri 只有 3 个 → Rust 侧过滤过严，要修」。
**实测推翻**：用同一套 Win32 枚举按两套过滤条件并排计数（`Electron koffi 语义 9 个`
vs `Rust 当前语义 5 个` vs `宽松参照 10 个`），再逐项分解：

- 跳 **cloaked**（UWP 幽灵窗）：9 → 6，丢 3 个 —— 但幽灵窗本不可见，**跳过是净收益**；
- 阈值 **112 物理 px**：9 → 7，丢 2 个 —— 但 112 物理 ≈ 前端 `findWindowRectAt` 的
  90 CSS px 过滤线，**前端本来也会滤掉**；
- 跳 **WS_EX_TOOLWINDOW**：9 → 9，**零损失**。

结论：Rust 过滤与 Electron koffi 语义**等效**，29 vs 3 是**时段差异**（当时开着更多
应用），**不是 bug，不修**。唯一改动是把阈值写成 `90 × dpr`（跟随前端过滤线，任意 dpr 对齐）。

> 教训：**先量再改**。这次差点把一个「看起来像 bug 的计数差」当成缺陷去"修"，
> 而真正的缺陷（512px 原点错配）恰恰不在那 29 vs 3 上。

### 8.3 仍待用户手测的项（无法自动验证）

1. **无 UIA 应用上的窗级大块**（Zcode/游戏）：P0-1 的实际观感，需人眼确认框住的是目标窗。
2. **副屏坐标**：主屏 125% + 副屏 150% 下，副屏智能框与裁剪是否 1:1 无偏移。
3. **Electron ↔ Tauri 同点对照**：同一坐标下两边 `smart:at-point` 回包矩形偏差 ≤ 1 CSS px。

### 8.4 ★ F2 实测故障定位与修复（用户实测报障后的专项，2026-10-31）

用户报：**F2 不像 F1 一样秒出窗口，而是卡顿；卡顿之后也不出窗口；不出现智能选框，
需要自己滑动鼠标才有选框；出现的选框还是错位的**（F1 一切正常）。

**方法**（可复用）：新增 `tools/_ab_test.ps1` —— **先把光标钉死**再触发热键。
这一步是关键：capture.js 的新鲜度守卫是 `moved <= 64`（回包时光标偏离请求点即丢弃），
鼠标一动两版差异就被这个噪声淹没。每轮抓全虚拟屏截图 + 读各自日志做并排比对。

**根因三：node 内核进程不是 Per-Monitor-V2 感知 → UIA 矩形被 DPI 虚拟化**（选框错位的直接成因）

- 同点对照（静止光标，同一坐标）：

  | | 框尺寸 | 框位置 | 元素类型 |
  |---|---|---|---|
  | F1（Electron） | 1080×710 | @2424,256 | Tree |
  | F2（Tauri，修前） | **864×568** | **@2271,90** | Pane |

- 关键线索：尺寸比 `864/1080 = 568/710 = 0.800`，**恰好 = 1/1.25**（96/120 DPI 的虚拟化系数）；
  且位置严格等比 —— `F2.x = (F1.x − vs)/1.25 + vs`、`F2.y = F1.y/1.25`
  （`2327→2271`、`113→90` 逐项对得上）。
- 根因：`smart_uia.dll` 里的 UIA `BoundingRectangle` 在**非 PMv2 进程**中返回**逻辑(DIP)坐标**。
  Electron 主进程是 PMv2（Electron 自己设的）→ F1 正确；F2 的内核是**独立 node 进程**
  → 拿到虚拟化坐标，Rust 侧又按「物理 ÷ dpr」除了一遍 → **所有元素框缩成 0.8 倍并整体偏移**。
- 修法：`f1_worker.js` 在 `koffi.load(smart_uia.dll)` **之前**把本进程设为
  `DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2`（`SetProcessDpiAwarenessContext(-4)`；
  被 manifest 抢先则退到 `SetThreadDpiAwarenessContext(-4)`）。
  日志留痕：`[f1_kernel] DPI PMv2: SetProcess -> 1`。
- 验证：修后同点对照 **F1 与 F2 输出逐像素相同**的矩形
  `1080x710@2424,256`（type=Tree、areaPct=16.25%、`drop=0`，两版 `dll` 18ms / 40ms）。

> 教训：**「两版尺寸差一个固定比例」是 DPI 虚拟化的指纹**（1/1.25 = 96/120）。
> 坐标类 bug 要同时核对**尺寸**和**位置**——只核对位置会以为"偏了一点"，
> 看到 0.8 这种整齐比例才立刻指向 DPI。

**必须分清：「首帧无框、移动一下才有」是两版共有的既有特性，不是迁移缺陷**

- 目标应用（Chromium/Electron 类自绘应用）的 UIA 树**懒加载**：会话刚开时的第一次查询要
  **1~2.3 秒**，回来时鼠标已动 → 被 capture.js 的新鲜度守卫（`moved <= 64`）丢弃 → 首帧无框；
  移动一下触发新查询（命中已建好的地图，0~3ms）就有框。
- **实测两版都如此**：F1 日志 `total=1507ms / 2029ms src={} uiaLv=0`；
  F2 日志 `total=2276ms src="snap" uiaLv=0`。
- 迁移侧修掉的是**F2 独有**的三条：dpr 偏移（框缩 0.8 倍）、并行争用（UIA 查询 3 秒超时、
  完全无框）、诊断总闸常开（两版性能不可比）。「首帧秒出」要改善属**性能专项**
  （冷树预热 / `SmartUiaPoke` 时机 / 快照提前建），对 F1 与 F2 同时生效，不是 Tauri 收尾缺口。

**根因一：dpr 权威源错**（坐标链全线偏 512 CSS px → 选框错位）

- `win.scale_factor()` = 「窗口**当前所在显示器**」的 DPI。窗口落到副屏（150%）后返回 **1.5**，
  而 WebView2 实际渲染用 **1.25**（日志 `[shim] DPR MISMATCH rust=1.5 webview=1.25`）。
- 一处污染整条链：`virtualScreen` / `cursor` / `visibleWindows` 全偏 512 CSS px；
  `smart:at-point` 的物理查询点偏 426 物理 px（查到了别的元素）。
- 修法：权威源 = **主屏 DPI**（与 Electron `screen.getPrimaryDisplay().scaleFactor` 同源）；
  窗口 `scale_factor()` 只打印作对照（启动自检两行相邻，一眼可比）。

**根因二：`smart_uia.dll` 的「遮罩只认自家进程」**（智能选框完全出不来）

- 受控 A/B 实锤：

  | 场景 | F2 的 UIA 查询 | 智能框 |
  |---|---|---|
  | F2 单独跑 | `dll=12ms` `src=efp` `drop=0` | ✅ 立即出现 |
  | F1+F2 并行 | `[kernel] uia timeout 3000ms (abandoned)` `uiaLv=0` | ❌ 完全不出现 |

- 根因：`native/smart_uia/smart_uia.cpp` 的 `is_capture_mask_hwnd()` 用
  `pid == GetCurrentProcessId()` 判「自家截图遮罩」→ **只跳过调用进程自己的遮罩**。
  F1 的驻留遮罩（PID=electron）不属于 F2 的内核进程（PID=node）→ 不被跳过 →
  `find_target_window()` 的 z 序扫描与 `ElementFromPoint` 双双命中那张全屏 WebView2 遮罩 →
  DLL 走进一棵 Chromium 大树 → **3 秒超时** → 整条元素链死亡。
- 修法：判据放宽为「自家进程」**或**「别家的 **click-through（WS_EX_TRANSPARENT）全屏窗**」。
  click-through 是最强的语义信号——窗自己都声明「鼠标穿过我」，显然不是合法命中目标；
  非 click-through 的全屏窗仍按普通目标处理（**不动 2026-10-27「自家设置窗/贴图窗是合法目标」的语义**）。
  同步修 `own_element_is_mask()`：带 HWND 的元素统一交给 `is_capture_mask_hwnd` 判。
- 验证（根因二修后、根因三修前的中间态）：两版并行时 F2 `dll=82ms` `drop=0`
  `applied=1165x731@2271,90`，**框能出了**——但与 F1 同轮的 `1456x914@2327,113`
  仍不等（差 0.8 倍，见根因三）。

**根因四：29.5MB 智能帧走 JSON 通道 → 渲染端 + Rust 主线程各被堵数秒**（用户报「刚开始进去还是很卡、过几秒才顺滑」）

- 机制：`capture.js` 的 `sendSmartFrame()`（`:1014-1024`，由 `:961` 在 reveal 后 150ms 触发）
  把 `bgCtx.getImageData()` 的**全画布 29.5MB** 交给
  `ipcRenderer.send('smart:frame', Uint8Array, w, h)`。
  Electron 的 `ipcRenderer.send` 走**结构化克隆**（Uint8Array 是原生二进制，同帧仅 ~26ms）；
  而 **WebView2 的 `postMessage` 只接受「可 JSON 序列化」的对象** → `Uint8Array` 被摊平成
  **「每个元素一个键」的 JSON 对象**（两千万个键 ≈ 600MB 文本）：
  1. 渲染端主线程 marshaling 阻塞 ~3.1s；
  2. Rust 主线程 `serde_json` 反序列化再阻塞 ~2.2s
     （`ipc_send` 是**同步** command，参数反序列化就发生在**主线程**）。
- 实测闭环：用户实测日志里「最后一条正常日志 → 积压一次性刷出」= **6499ms**
  ≈ 3090ms（`longtask 3090ms`）+ 2193ms（`main-thread stall 2193ms`）+ ~1.2s 交接；
  ESC 的 keydown 排在长任务后面 → 「ESC 退不出」。
- **F1 为何没有**：F1 走 GDI 直抓，`capture-image` 的 meta 里 `framePrepared=true`
  → `sendSmartFrame()` **直接 return**，根本不发这 29.5MB。
  F2 的 meta 里 `framePrepared=false` → **这 29.5MB 是 F2 独有的死重**
  （像素链已按 2026-10-27 定调全局停用，Rust `smart:pixel-at` 恒返回空 levels
  → 没有消费方；Rust 侧 `smart:frame` 分支本来也只是收下就扔）。
- 修法（双保险）：
  1. Rust meta 改 `framePrepared: true`——F2 的 Rust 侧**已经**用原生抓屏持有同一张全帧，
     并经 `get_frame_raw` 的 `tauri::ipc::Response` **二进制通道**送到渲染端，
     渲染端手上已有帧，不必再从画布回读一遍；
  2. `tauri-spike/ui/shim.js` 的 `ipcRenderer.send/invoke` 包装加**二进制载荷拦截**
     （任一参数含 >1MB 的 TypedArray/ArrayBuffer 即拒发 + 打日志）→ 护栏被回退也不会再炸主线程。
     **护栏已做负向测试**：新增运行时开关 `PETALSNAP_FRAME_PREPARE=0` 可把 meta 的
     `framePrepared` 强制置回 false（让渲染端真的发出那 29.5MB）→ 实测日志出现
     `[shim] BLOCK oversized payload (29491200 bytes)`，且 longtask 仅 124ms、
     Rust 主线程 stall max 仅 71ms、**无** `[warn] smart:frame 意外到达`
     → 证明第二道防线**独立成立**。
- 修后实测（同场景对照）：

  | 指标 | 修前 | 修后 |
  |---|---|---|
  | 渲染端 longtask | 3090ms | **108ms**（只剩帧显示本身） |
  | Rust 主线程 stall max | 2193ms | **60ms** |
  | 卡顿静默期 | 6.5s | **0** |
  | ESC → capture-cancel | 延迟 6.5s | **1ms**（Rust 侧处理 22ms） |
  | 热键→出窗 | — | **409ms**（F1 参照 416ms） |

  三态对照（护栏的独立性）：修前（无护栏）3090/2193ms → 仅护栏（负向测试）124/71ms
  → 主修复+护栏 108/60ms。

**根因五：DLL 跑在独立 node 进程 → 判不出「自家截图遮罩」→ 智能框打在自家 WebView2 DOM 上**
（用户报「识别还是不够准」；2026-11-01 会话开着时外部探针实锤）

- 实测（会话开着、同一坐标）：外部探针打点 → `WindowFromPoint` 命中
  **`petalsnap-spike`（自家遮罩）**，`exStyle=0x40118` **不含 `WS_EX_TRANSPARENT(0x20)`**
  → 会话中遮罩是**可交互**的（与 F1 同款：F1 `finalizeCaptureWindow` 也是
  `setIgnoreMouseEvents(false)`，F1 的 click-through 只用于**驻留态**）；
  DLL 出链 → `EFP 路 win="petalsnap-spike" chain=1 → MenuItem 3413x960（占屏 69.44%）`，
  `MAP 路` 20 层全是自家 WebView2 DOM（`"拾花 PetalSnap - Web 内容"`）
  → **智能框圈的是我们自己的截图窗口**，不是光标下的应用。
- 根因（F1↔F2 的确切差异就在这一格）：

  | | UIA 查询跑在哪 | DLL 里 `GetCurrentProcessId()` | 与遮罩 PID |
  |---|---|---|---|
  | F1（Electron） | **worker_threads（同进程不同线程）** | Electron 的 PID | **相同** → 判得出「自家」→ 跳过 |
  | F2（Tauri） | **独立 node 进程** | node 的 PID | **不同** → 判不出 → 放行 |

  `smart_uia.cpp` 的 `is_capture_mask_hwnd()` 判据是「自家进程 **或** 别家 click-through 全屏窗」；
  F2 的遮罩既是「别家」又**不是 click-through** → 两条都不成立 →
  `find_target_window()` 的 z 序扫描**不跳过它** → 它成了命中目标。
- 修法（宿主 PID 注册，三处）：
  1. `native/smart_uia/smart_uia.cpp`：新增导出 `SmartUiaSetOwnerPid(int32_t pid)` +
     `g_owner_pid`；`is_own_process_hwnd()` / `element_in_own_process()` 统一走 `is_host_pid()`。
  2. `tauri-spike/f1_worker.js`（**宿主桩段**，F1 内核逻辑零改动）：读环境变量
     `PETALSNAP_OWNER_PID` 调用该导出。
  3. `tauri-spike/src-tauri/src/main.rs`：spawn worker 时
     `.env("PETALSNAP_OWNER_PID", std::process::id())`。
  - F1 走 worker_threads **不注册**（环境变量不存在）→ **F1 行为完全不变**；
  - 宿主 PID 只影响「是不是自家」，**不动 2026-10-27「自家设置窗/贴图窗是合法目标」的语义**
    （那仍由 `is_capture_mask_hwnd` 的「盖满虚拟屏」条件区分）。
- 验证：修后 F2 内核 `[f1_kernel] owner pid=18568`，同坐标目标窗从 `petalsnap-spike`
  变回 **`图形画板`**（下层应用），输出矩形 `1080x710@2424,256 type=Tree areaPct=16.25%`
  ——**与此前 F1 的同点对照结果逐字一致**；对照：未注册 owner pid 的外部探针仍报
  `petalsnap-spike` → 反证修复点精确。
- **修后同坐标 A/B（最能说明问题的一组）**：

  | | 目标窗 | 链上最小元素 | 面积地板选中 | 最终框 |
  |---|---|---|---|---|
  | 修前 | `petalsnap-spike`（自家遮罩） | `4096x1152:Window` | `4096x1152:Window` | **整屏（占屏 69%）** |
  | 修后 | `MiniMax Code`（下层应用） | `566x15:Edit` | `736x77:Tree` | **736x77（占屏 1.2%）** |

  同轮另两个佐证：① 无 UIA 树的 ZCode 现在正确返回 `n=0 src="snap" win="ZCode"`
  → 渲染端按用户定调走「窗级大块」档（而不是钻到别的应用的 DOM 上）；
  ② 修后 `longtask 127ms`、`mtStallMax=0ms`、ESC `handled in 21ms`（根因四的修复同时生效）。
- **教训**：两版共用同一份二进制/脚本时，「代码看起来一样」**推不出「运行时一样」**。
  必须逐项列出**运行环境差异**（同进程线程 vs 独立进程 / DPI 感知上下文 / 宿主 PID /
  窗口驻留态 / IPC 通道类型）再下「行为一致」的结论。

> 教训：**Electron ↔ Tauri 迁移里，大二进制必须走二进制通道**。
> WebView2 没有 shared-memory IPC，`tauri::ipc::Response` 是唯一不过 JSON 的通道；
> 任何 `Uint8Array`/`ArrayBuffer` 走 `invoke`/`send` 的参数都会被摊平成巨型 JSON 对象，
> 在渲染端和 Rust 主线程各堵数秒。护栏要放在**通道边界**（shim 拦截 + Rust meta 标志）。

**顺带修的两处性能/一致性缺口**

1. **诊断日志总闸**：Tauri 侧 `shim.js` 此前把 `PETALSNAP_SMART_DEBUG` **写死 '1'**
   → 每帧 PERF 探针 + 每次会话 5 次全画布 `getImageData`（≈55ms）常开，而 Electron 侧默认关
   → **两版性能不可比**。改为由 URL 参数 `?smart_debug=1` 决定（Rust 读同名环境变量决定是否加），
   默认关，与 Electron 一致。
2. **帧传输路径回退**：曾改「Rust 落盘 → 渲染端 `asset://` 直读」以绕开 29.5MB 的 IPC 序列化，
   **实测两端都不占优**（渲染端 `meta→buf` asset 249ms vs IPC 214ms、`buf→dispatch` 136 vs 62ms；
   Rust 侧额外写盘 13~232ms）→ 已回退纯 IPC（`tauri::ipc::Response` 二进制通道，不过 JSON 序列化），
   并去掉 `get_frame_raw` 里 29.5MB 的 clone（改 `take`）。
   效果：热键→出窗 **601ms → 527ms**（F1 参照 416ms）；Rust 抓帧+meta **172ms → 75ms**。

**剩余差距的性质（不是实现问题）**：WebView2 没有 Chromium 的 shared-memory IPC，
29.5MB 原始像素过桥 ~200ms 是架构性的（Electron 同帧 ~26ms）。
继续优化只能**减少数据量**（编码压缩）或换架构（Rust 侧全局鼠标钩子 + 常驻窗口）。

**新发现的一处两版差异（核查后判定：不需要改，勿照抄 F1）**

F1 的捕获窗**驻留态是「visible + opacity 0 + click-through」**（`captureWindow.ts:817`
`setIgnoreMouseEvents(true)` + `setOpacity(0)`，不 hide —— 合成表面保留 → 下次 reveal 无黑帧）；
Tauri 侧驻留态是 **`hide()`**（`main.rs` `win.hide()`）。于是：

- F1 的驻留窗虽然 opacity 0，但**仍占着 z 序顶端**——这正是本次「根因二」里
  F2 的 UIA 查询被 F1 挡住的载体（修法就是让 DLL 跳过别家的 click-through 全屏遮罩）。
- **Tauri 不应照抄 F1 的驻留态**：hidden 天然不干扰任何别的实例的 UIA 命中；
  改成 visible+click-through 反而会让 F2 去挡别人（如 Electron）的查询，
  正是本次刚修掉的那个坑的镜像。
- 会话**内**两版的 EFP 行为其实一致：自家遮罩可见且非 click-through → DLL 的
  `ownOpaque` 分支会跳过 EFP 通道 → 出元素级框靠的是「地图命中」那条路（F1 日志
  `src={"map":N}` `uiaLv=10`，F2 同轮 `src={"efp":1}` `uiaLv=1`，
  两者都能给出元素级矩形，已由同轮截图对齐验证）。

**结论**：驻留态 hidden vs visible+transparent 是**有意差异**，保持现状。

**「识别不够准」侧的定性（⚠️ 此处结论已被根因五推翻，见上文）**

- ~~核查结论：**准确度不存在 F1/F2 差异**~~ —— **这条结论是错的，已被根因五实锤推翻**：
  差异不在 JS/TS 逻辑层（那部分确实逐段同源），而在 **DLL 的进程身份语义**
  （F1 = worker_threads 同进程 / F2 = 独立 node 进程 → 判不出"自家遮罩"）。
  **教训**：两版共用同一份二进制/脚本时，「代码看起来一样」**推不出「运行时一样」**。
- **大框的机制（供后续提精度参考）**：渲染端 `capture.js` 有**面积地板**
  （`SMART_MIN_AUTO_AREA = 0.003`，本机双屏 ≈ 14156 px² ≈ 120×120），
  自动落笔只取**链上第一个面积 ≥ 地板**的元素，低级碎屑整级跳过（滚轮链不受影响）。
  链形如 `[文本 159x19, 整棵 Tree 1808x1058]` 时，地板会**跳过文本直落整棵容器**
  （实测 5/5 次 `areaPct=40.54%`）→ 要提精度只能从**链本身补中间层**（DLL 侧），
  不能改 `capture.js`（`resources/capture.js` 与 `tauri-spike/ui/capture.js`
  **逐字节一致**是 spike 的核心前提）。
- **树粒度实测够用**：Edge（抖音页）细元素齐全（`Tree 417x26` 侧栏项 / `TabItem 256x42` /
  `Text 483x21` 弹幕框；items 分布 `<2k` 177 / `2k~14k` 98 / `14k~200k` 14 / `>=200k` 23）；
  落在**页面空白处**时链里确无细元素 → 大框是**如实的**回答，不是 bug。
- **证伪一个伪结论**：曾疑「顶层无 UIA 树的窗会让 UIA 命中穿透到下层应用」，
  用 `WindowFromPoint` + `GetAncestor(GA_ROOT)` 核对后**证伪**：
  探针点最上层窗确实是 Edge（ZCode 在其下方）→ DLL 的目标窗判定正确，**无穿透 bug**。
- 新增可复用探针：`tools/_chain_probe.js`（并排复现 EFP 路 / MAP 路出链 + 面积地板决策
  + items 面积分布）、`tools/_hit_probe.js`（顶层窗命中核对）。

---

### 8.5 ★「延迟比 F1 高」的复核与根因收敛（2026-11-01）

**第一轮结论（受控 A/B）**：两版**基本持平**——热键→出窗 F1 428ms / F2 438ms；富元素区
`total` F1 1~21ms / F2 1~31ms。所以「F2 更慢」**不是壳的锅**，F2 多背的 219ms 帧过桥
（WebView2 无 shared-memory IPC，架构性）被其它开销抵消。

**但尖峰确实存在，且两版共有**。第二轮把尖峰拆开，结论从「两版持平」收敛到
**「共享的排队延迟 + 共享的兜底失效」**。

**关键数据（F1，粗粒度窗口「图形画板」内连续移动，渲染端 1s 聚合 `SMART-DIAG`）**

| n | `dll`（worker 内部耗时） | `total`（IPC 往返） | src |
|---|---|---|---|
| 18 | 0/1ms | 27/**482**ms | {"map":18} |
| 20 | 0/1ms | 22/**442**ms | {"map":20} |
| 13 | 0/0ms | 30/**389**ms | {"map":13} |
| 12 | 0/0ms | 37/**437**ms | {"map":12} |
| 2 | 325/340ms | 325/340ms | {"map":2} |

**`dll=0ms` 而 `total=480ms` ⇒ 慢的不是「识别」，是「排队」。**
worker 是**单线程串行队列**：任何同步 DLL 调用（整窗快照 300~600ms、EFP 240~400ms、
600ms 交叉校验探针）都会把**排队中的悬停查询**一起拖住；worker 侧探针
`blocked snapshot 299ms` / `blocked efp 306ms` / `loop-lag 231ms` 与 Rust 侧分段
`ensure=0ms write=0ms wait=251ms` 指向同一结论（时间 100% 在"等 worker 回包"，传输层 0ms）。

**为什么用户没被 500ms 直接打脸**：渲染端有一条 **0ms 本地查表**旁路
（`capture.js` `applyLocalMapRect`）——命中本地整窗图时**不经过 worker、不经 IPC**，
这正是注释里「worker 忙时照常跟手」的实现。
⇒ **用户感知的延迟 = 这条旁路失效的那一部分。**

**旁路为什么在关键场景失效：三个结构性缺口**（逐行核对源码，非推测）

| 缺口 | 位置 | 后果 |
|---|---|---|
| ① **拉图与回包耦合** | `capture.js` `requestLocalMap()` **只在 `r.diag.src === 'map'` 时**调用 | worker 在"瘦图/无细元素"时改用 EFP 应答（`src=='efp'`）→ **恰恰是最慢的场景永远不拉图** |
| ② **发布门槛** | worker `publishMap()` 要求 `items.length >= 3` | **整窗级窗口（实测 `items=1`）根本不会有图** → 主进程手里空 → 渲染端无图可用 |
| ③ **覆盖空洞** | 地图只收"控件元素"，光标落在空白处时命中集为空 | 本地查表必然 miss → 退回干等 worker |

⇒ 结论：**凡是「没有细元素」的应用（= 用户定调的"只要大块"那一档），它的 0ms 旁路是结构性失效的**，
用户直接吃到 300~500ms 的排队延迟。F2 还额外背 219ms 帧过桥 + ~50ms dispatch → 感知更差。

**实测佐证**（`tools/_chain_probe.js`，并排 EFP 路 vs MAP 路）：

| 目标窗口 | MAP `items` | 含光标点 | 旁路可用？ |
|---|---|---|---|
| 图形画板（画布） | 105 | 7 | ✅ 图够胖（≥3） |
| MiniMax Code | 139 | 13 | ✅ |
| **Windows 输入体验（整窗级）** | **1** | 1 | ❌ **低于发布门槛 → 结构性失效** |

**F1↔F2 在这条路径上逐行同构**（`publishMap` 门槛、「`src=='map'` 才拉图」、面积地板、
`rowMissing` 判定，在 F1 `main/services/smartUiaNative.ts` 与 F2 `tauri-spike/f1_worker.js`
中完全一致）⇒ **本节的修复两版同时受益**，且不构成"迁移缺陷"。

**修复方案（用户 2026-11-01 拍板：P0-a + P0-b，两份内核同步改；P1 暂不实施）**

| 档 | 改动 | 落点 | 风险 | 状态 |
|---|---|---|---|---|
| **P0-a 缺口②** | 发布门槛 `items>=3 一律不下发` → **`items<3 且 `rowMissingCount>3` 才下发`** | worker（F1 `smartUiaNative.ts` 内嵌脚本 **与** F2 `f1_worker.js` **两份都改**） | 低：判据与 worker 既有降级口径一致 | ✅ 已落地并验证 |
| **P0-b 缺口①** | ①回包处理无条件 `requestLocalMap()`；②本地 miss 时也主动拉图 | 渲染端 `capture.js`（**两份逐字节同步**） | 低：多一次 IPC/秒（主进程侧纯缓存读 0ms） | ✅ 已落地并验证 |
| **P1 缺口③** | 地图空洞时用**窗级大块**兜底（**仅当** worker 判定"该应用确实无细元素"时允许） | worker 加 `coarse` 标志 + 渲染端分支 | 中：判据错了会给 UIA 应用带来"大框闪烁" | ⏸ 待用户复测后再定 |

**P0-a 的判据为什么选 `rowMissingCount > 3`**：这正是 worker **既有的降级口径**——
同一条件下 worker 本来就用瘦图应答（「EFP 也无果/已过唤醒窗口」分支）。⇒ 渲染端画出的
窗级大框与 worker 的权威回包**是同一个答案**，不存在"粗图冒充精确元素"的回归；
唤醒期（`rowMissingCount<=3`，树还没醒）维持旧口径，不会把 UIA 应用的行框闪成大框。

**配套**：
- 负向测试开关 `PETALSNAP_SMART_THIN_MAP=0` → 退回旧口径（沿用根因四 `PETALSNAP_FRAME_PREPARE=0` 的惯例）；
- 渲染端新增 `[SMART-LOCAL] hit=N miss=M map=K`（仅 `SMART_DEBUG`）——SMART-DIAG 只在**有回包**时
  才打印，恰好在 worker 堵住（`total=482ms`）的窗口期一声不吭，只有这个计数能回答
  「用户看到的框是不是 0ms 旁路画的」；配套探针 `tools/_local_path.ps1`；
- 测试靶 `tools/_thin_win.ps1`（造一个没有任何子控件的窗口 → 必然 `items<3`）。

**验证（F1 与 F2 双双通过，同一靶点同一路径）**

| 证据 | F1（Electron） | F2（Tauri） |
|---|---|---|
| worker 瘦图外发 | `[f1_kernel] publish thin map items=1 key=89,206,1823,1225` | 同左 ✅ |
| 渲染端 0ms 旁路 | 累计 **hit=193** | 累计 **hit=80** ✅ |
| 同期 IPC 尖峰 | `total=381/847ms`（旁路已顶上，用户无感） | `total=0~1ms` |
| 负向对照 `THIN_MAP=0` | 瘦图外发 **0 条** ✅ | — |

修前同一场景是 `map=0` + `hit=0`（本地根本没图 → 旁路完全失效），
修后 `map=363/92` 且 `hit` 上百 ⇒ **0ms 旁路在「没有细元素」这一档真正接上了**。

> 教训：**"识别耗时"与"排队耗时"必须分开量**。`dll`（worker 内部）与 `total`（IPC 往返）
> 的差值就是排队时间；只看其中一个会得出完全错误的结论。
> 同理，"用户感知延迟"往往不是最慢的那条路径，而是**兜底路径是否生效**。
> 另注：`tauri-spike/f1_worker.js` 是**运行时读盘**（`resolve_resource` 从 exe 目录逐级上溯），
> 改它不必重编；改 `tauri-spike/ui/`（编译期内嵌）才必须 `cargo build --release`。

---

### 8.6 ★ 悬停跟随手感：「果冻感」修复（2026-11-02）

**用户报**：在资源管理器这类列表上滑动时，我们的跟随框有延迟感（"Q 弹 Q 弹"）；
而 Snipaste 定位很快，但偶尔「突然从小窗口变成大窗口」→ 闪动。**两个都要**。

**机制（外部探针实测 Explorer，非推测）**：光标每下移 30px 就换一个 `ListItem`
（DSC_3689→3690→3691，落笔框都是 810x30）→ **目标矩形每行都变** →
`capture.js` 的 150ms「水流」补间**每行重启一次** → 框永远在追赶，落后 1.5~3.5 行。

**关键认知**：「果冻」与「突然变大窗」**是同一个补间的两端**——位置滞后与尺寸突变。
所以解法不是二选一，而是**把位置与尺寸解耦**（用户 2026-11-02 拍板「自适应」）：

| 情形 | 判据 | 行为 | 解决什么 |
|---|---|---|---|
| 等尺寸移动（行→行） | 面积比 0.25~4 | **位置立即跟手**（尺寸插值此时是空操作） | 消除果冻感 |
| 尺寸显著跳变（小窗→大面板） | 面积比 <0.25 或 >4 | **整框补间**，走「亮度匀速」口径 260ms（见 §8.7） | 消除"突然变大"的闪动 |

**实测（同一台机器、同一路径、同一扫掠）**

| | 位置滞后 avg | max |
|---|---|---|
| F1 旧手感 | 46.0 / 74.4px | 88 / 105px |
| F1 新手感 | **0.0px** | **0px** |
| F2 旧手感（`HOVER_MODE=0`） | 56.8 / 77.5 / 66.8px | **107px** |
| F2 新手感 | **0.0px** | **0px** |

**配套**：
- 负向开关 `PETALSNAP_SMART_HOVER_MODE=0` → 退回旧口径；
- 新增探针 `[SMART-LAG] avg/max/n`（框落后目标的像素，**按区间累计**——抽样会错过
  移动中的那一瞬，量出来永远是 0）与 `[SMART-KEY]`（目标变化瞬间是否真在补间）；
- **★ 顺带修掉的埋雷**：F2 的渲染端 `process.env` 只认一个键（`shim.js` 里
  `window.process.env` 是写死的字面量）→ `capture.js` 读的其它环境变量在 Tauri 侧
  **静默失效**，两版行为不一致且毫无报错（负向开关在 F2 根本不生效 → A/B 假结论，
  本次实测先踩了这个坑）。修法：Rust 侧按**白名单**把渲染端要读的开关以
  `?env=K=V,K=V` 透传进页面，`shim.js` 解析后填回 `process.env`。

> 教训：**"两版同源"要连「运行时能读到哪些开关」一起核对**。共享一份 `capture.js`
> 不代表共享一份 `process.env`——壳侧的环境变量白名单也是行为的一部分，
> 漏一个键就会静默分叉。

---

### 8.7 ★ 悬停「闪亮」修复（2026-11-02）

**用户报**：识别精确、拖动跟手已达标；但**尺寸从小到大/从大到小突变时会出现一下「闪亮」**，
要求过渡观感更好。（用户 2026-11-02 拍板方案：**「亮度匀速铺开 + 大跳变延时拉长」**）

**先排除的伪因**（都是先量后改，不是推测）：
- 「洞消失（整屏变暗）」不是闪源——`[SMART-MORPH] null=` 实测恒为 0；
- 「识别错了」也不是——Explorer 上画出的确是精确的 `810x30 ListItem`（占屏 0.51%）。

**真因**：810x30（0.51%）→ 1535x806（26.2%）= **面积涨 73 倍**；而**线性尺寸插值让面积二次增长**
→ 亮区在末尾「唰」地铺开（实测峰值亮度速率 ~1.18 万 px²/ms，末尾 50ms 内屏幕从 10% 亮到 26%）。
**用户感知的是「亮起来的面积」，不是「宽高」**——这是本条修复的核心认知。

**解法**（`capture.js` `startHoverSmoothLoop` 的 `hoverSizeJump` 分支）：

| | 旧口径 | 新口径 |
|---|---|---|
| 尺寸插值 | 宽高各自线性 | 宽高沿线性混合走，但**解出 `g`** 使 `(w0+Δw·g)(h0+Δh·g) = a0+(a1−a0)·e` |
| 面积（观感） | **二次增长**（末尾冲） | **线性**（亮度匀速铺开） |
| 位置 | 与尺寸同步插值 | **中心滑移**（框"长成"新框，不半路飘） |
| 大跳变时长 | 150ms | **260ms**（`HOVER_JUMP_MS`） |

两端仍精确命中（`e=0 → g=0`、`e=1 → g=1`），中间态形状平滑不溢出、宽高比自然过渡；
等尺寸移动仍走「位置立即跟手」，**不受影响**。

**实测（同一台机器、同一条路径、同一探针；判据 = 面积曲线对 e 的线性度 maxDev）**

| 平台 | 口径 | 跳变 | maxDev | 判定 |
|---|---|---|---|---|
| F2 | 新 | 2048x1152 → 126x141 | **0.1~0.2pp** | 线性 ✅ |
| F2 | 旧（`HOVER_MODE=0`） | 同上 | 4.9pp | 二次 ❌ |
| F1 | 新 | 1034x37 → 2048x155（**变大**） | **0.0pp** | 线性 ✅ |
| F1 | 新 | 1851x185 → 126x141（变小） | **0.0pp** | 线性 ✅ |
| F1 | 旧（`HOVER_MODE=0`） | 2049x1152 → 126x141 | 4.6pp | 二次 ❌ |

**离线数学验证**（`tools/_morph_math.js`，与线上解算器逐字同源）：5 组用例
（变大/变小/只变宽/只变高）全部 PASS——`g∈[0,1]`、两端精确命中、面积偏差 **0.0000pp**；
峰值亮度速率 **旧 6821 → 新 4665 px²/ms**（新 = 平均速率，峰值/平均 = 1.00 → 完全匀速；
旧 1.46× → 末尾有"冲"）。

**配套**：
- 负向开关 `PETALSNAP_SMART_HOVER_MODE=0` → 退回旧的「位置+尺寸一起线性补间 150ms」，
  **两版均实测生效**（日志里 `dur=150` 与 `dur=260` 都出现过）；
- 新增探针 `[SMART-MORPH] e/area%/box/from/to/jump/dur/null`（形变曲线）；
- 新增工具 `tools/_morph_curve.ps1`（两段式采一次**完整**形变曲线：先在小元素沉降，
  再一次性跳到大元素区并留足 4s——worker 回包有 ~0.5s 滞后，停留太短会
  「目标还没切过去就 ESC」→ 只采到 `e=0` 一个点，曲线采不全）；
  `tools/_scan_targets.ps1`（物理坐标 → UIA 目标尺寸映射扫描，用于找「大块」靶点）；
  `tools/_morph_math.js`（解算器离线验证）。

> 教训：**线性插值「尺寸」不等于线性插值「观感」**。面积对尺寸是二次的，
> 要让亮度匀速，就得**反解尺寸参数**（解方程）而不是直接插值。

---

---

### 8.8 ★ 悬停「迟缓 + 剧烈抖动」修复（2026-11-02 晚）

**用户反馈**：①「窗口位置变化时特别迟缓、不跟手」；②「窗口剧烈变化时，加速移动它会剧烈抖动」；
并指出跟手/不闪/不抖「像个达不到的三角」，建议「**窗口正常变化 = 跟手的变化，
亮度变化不该突然闪，而应该是一个从灰色渐变的过程**」。

**用户的直觉是对的**——这不是三角，症结在动画层用了**二态分支**；但「亮度渐变」之外
还必须再加一层：**动画状态要对目标的抖动免疫**。

#### 实测定位（`tools/_follow_probe.ps1`）

| 根因 | 机制 | 证据 |
|---|---|---|
| ① 迟缓 | 动画是**二态分支**（尺寸跳变走「中心滑移」，否则走「位置立即跟手」）。目标一抖，分支整块换 → 同一个会话里位置滞后在 **0px 与 153~264px 之间横跳** | 快速扫掠：加权平均 **54.2px**、最差分段 264px、**21% 分段在拖** |
| ② 抖动 | 目标有两个竞争来源（**0ms 本地图命中** vs **UIA 实时回包**），快速移动时对「光标下是哪个元素」判断不一致 → 在「精确行框 0.5%」与「整屏大块 50%」间横跳 | 目标变化 **12~65 次/秒**；目标矩形分布里同时出现 `810x30` 与 `2048x1152` |

**根因 ② 的触发链**：快速移动时**每个 UIA 回包都必然「不新鲜」**（光标已跑远，`moved>64`）
→ `lastUiaChainAt` 不刷新 → 1s 后被判成「这个应用没有 UIA 树」→ 大块兜底接管、给出
**整屏大框**（0.5% → 50% 一跳）→ 紧接着 UIA 回包又切回精确行框 → **两者交替 = 剧烈抖动**。
实测同一帧内：`[SMART-FOLLOW] pick=2048x1152@0,0` → 6ms 后 `[SMART-KEY] tween … to=810x30`。

#### 解法：三通道分离（正是用户提的方向 + 一层鲁棒性）

| 通道 | 做法 | 解决 |
|---|---|---|
| ① 位置 | **无条件立即跟手**（无分支、无条件） | 迟缓根除（永远 0px 滞后） |
| ② 面积（亮度） | **限速器**指数逼近：速率 = `min(缺口/τ, 4665 px²/ms)`，τ=70ms | 亮度渐变不闪 + **对目标抖动免疫**（限速器不重启补间） |
| ③ 宽高比（形状） | 对数限速 12/s | 形状平滑，快移时不自己抖 |

- ②③ 是**限速器**而非「每次目标变化就重启补间」——目标怎么抖，视觉状态都只会朝最新目标渐近，
  **抖动被动画层吸收**；渐近收敛 ⇒ **末尾不会突然到位**（无「末尾猛冲」），观感即用户要的「灰色渐变」。
- **数据层修正**：`lastUiaChainAt`（UIA 树存活打点）原判据只有 `moved<=64`（回包新鲜），
  快速移动时永远判死。改为「**当前光标仍在这条链所属的窗口内**也算树活着」——
  「回包过时」≠「这个应用没有树」；「远处旧链」的顾虑仍成立（光标不在该窗口内 → 不打点）。

#### 实测（同靶同扫掠）

| 场景 | 口径 | 加权平均位置滞后 | 最差分段 | 滞后分段占比 |
|---|---|---|---|---|
| 快速扫掠（Explorer） | 2（旧线上） | **54.2px** | 264px | **21%** |
| 快速扫掠（Explorer） | 1（新） | **0px** | **0px** | **0%** |
| 跨边界扫掠（自造靶窗） | 2（旧线上） | **26.3px** | 39.5px | **33%** |
| 跨边界扫掠（自造靶窗） | 1（新） | **0px** | **0px** | **0%** |

面积曲线（新口径，小 0.54% → 大 8.14%）：
`0.54 → 2.12 → 5.27 → 7.53 → 7.85 → 8.05 → 8.13%` —— **渐近收敛、无末尾跳变**，
实测速率 max **1513 px²/ms**（上限 4665）。

#### 三档口径开关（可实时 A/B）

`PETALSNAP_SMART_HOVER_MODE`：`1`/未设 = **新口径（三通道分离）**；
`2` = 二态分支（= 本次之前的线上版本）；`0` = 最初口径（位置+尺寸一起线性补间 150ms）。

#### 期间修掉的 3 个「看起来在跑、其实没跑」型隐蔽 bug

1. `const p` 挪进分支后变成**块级作用域**，tick 末尾 `if (p < 1)` 在新口径下每帧抛
   `ReferenceError` → rAF 链断掉、动画完全不跑 —— **且日志里看不到任何异常**。
2. 限速器状态放在 `startHoverSmoothLoop` 的**闭包**里 —— 该函数在 `hoverVisualRaf` 归零后
   会被下一次 `setHoverTarget` **重新进入**，闭包变量随之重置 ⇒ 「当前面积」每次归零 ⇒
   限速器永远不生效（实测 `mrate=0`）。**跨帧历史状态必须放模块作用域**。
3. dt 取到了**停机间隔**（循环收敛后停帧，重启时把空闲时间算进动画）⇒ 一次帧走完整段差距
   = 还是闪。修法：启动时 `lastTickAt` 归零 + dt 上限 34ms。

**★ Rust 侧 env 白名单的坑**：白名单原本**只放行 `"1"`/`"0"`**，新增的 `HOVER_MODE=2`
会被**静默丢掉** ⇒ A/B 的对照组根本没生效 ⇒ 假结论。已改为**每键独立的允许值集合**。

#### 新增探针/工具

- `[SMART-FLUX] area/box/conv/tgt/mrate/dt/ticks`（新口径形变曲线；`mrate` 是实测速率、
  `conv` 是收敛度、`ticks` 用来确认 rAF 链是否活着）；
- `tools/_follow_probe.ps1`（**跟手性/抖动专项**：目标变化率、目标矩形分布、分支翻转率、
  位置滞后加权平均、面积实测速率）；
- `tools/_morph_target.ps1`（**自造稳定靶窗**：TopMost，一个 400x100 小元素 + 1000x600 大面板
  → 确定性的「小→大」跳变；**小元素必须大于面积地板 `SMART_MIN_AUTO_AREA=0.003`**，
  否则会被地板跳过、目标变成整个窗）。

### 8.9 ★「整机崩溃」事故：llama-server 孤儿占满显存（2026-11-02）

> 完整事故专章见 `docs/功能状态清单.md` §3.10；本节只记 **F2 侧**的改动与坑。

**事故**：用户报「电脑崩了」，怀疑是本项目改动导致 llama-server 一直重新启动、累积占满显存。

**根因链**：探针脚本 `Stop-Process -Force` 强杀应用（触发）→ 应用来不及跑退出清理、
宿主只杀 python 侧车一个进程（放大器；Windows 上 TerminateProcess **不跑 python 的
atexit** → `mt_engine.shutdown()` 不执行 → 它拉起的 `llama-server.exe` 变孤儿，
**~1.2GB 显存/个**）→ 显存挤占触发 `mt_engine` 看门狗反复重拉（正反馈）→ 本机
**RTX 4070 Laptop 仅 8GB**，6~7 个即打满 → CUDA 降级共享内存 → 系统内存雪崩 → 整机崩溃。
仓库外 `rapidocr_service.py` 的孤儿清理依赖 **`wmic`（本机 Win11 已移除 → 静默跳过）**，
F1 的 `local_capture_service.py` 则根本没有孤儿清理。

**F2 侧改动（`tauri-spike/src-tauri/src/main.rs`）**：
- ✅ **Job Object + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`（根治）**：侧车 spawn 后
  `AssignProcessToJobObject` 收进 Job → **宿主进程一消失（哪怕被 TerminateProcess 强杀）
  → OS 连树陪葬**（python + llama-server）。这是 Windows 上唯一能对抗「宿主被强杀」的手段
  ——依赖 python atexit 靠不住（atexit 只在正常退出时跑）。
- ✅ **回收改连树杀**：`kill_py_service()` 先 `TerminateJobObject`（杀整棵树），
  兜底 `taskkill /PID /T /F`。
- ✅ **启动前清扫历史残骸**：新增 `tools/_sweep_orphans.ps1`（**判据 = 父进程已不存在**，
  PowerShell CIM，**不用已被 Win11 移除的 wmic**）→ `.setup()` 与拉起侧车前各调一次；
  脚本**编译期内嵌**（`include_str!`）→ 不依赖运行目录布局。
- ✅ **不再重复拉起**：`/health` 探测超时仅 **400ms**，侧车加载模型期间必然误判 →
  会再拉一个侧车 → 第二个侧车再拉一个 llama-server。新增「端口有人监听但不健康
  → 等，而不是再拉」。

**手写 Win32 ABI 的原因**（`mod jobobj`）：依赖树里有**两份 `windows_core`**（0.58 与 0.62），
`PCWSTR` 在 0.58 是类型别名、0.62 是结构体 → `CreateJobObjectW<P0: Param<PCWSTR>>` 的
泛型参数**推不出类型**（E0271/E0277：expected CopyType, found InterfaceType）。
直接按 Win32 头文件手写结构体布局，避开整套 `windows-rs` 类型机制。

**验证**：`cargo test` **3/3**（①Job 机制：assign → 关句柄 → 树被带走；
②**生产路径**：`spawn_py_sidecar()` 真的把侧车收进 Job（dummy 脚本冒充
`rapidocr_service.py`，不加载模型秒起）；③端口监听判定）；
清扫脚本实测造 4 个真孤儿 → `killed=4`、残留 0（PS 5.1 与 pwsh 7 双跑）；
`_stop_app.ps1` 实测 `appLeft=0 llamaLeft=0`；启动日志 `[py] SWEEP orphan sidecars: …`。

**踩坑**：
- ① **PS 5.1 读无 BOM 的 `.ps1` 按 ANSI 解码** → 中文注释解码错乱 → **脚本解析异常
  → `taskkill` 根本没执行且无任何报错**（`killed=0` 但进程还活着）。本仓库 `.ps1`
  惯例是无 BOM（探针要求 pwsh 7），但该脚本会被**宿主直接调用**（宿主环境不保证有
  pwsh 7）→ **单独加 UTF-8 BOM**；宿主导出侧「优先 `pwsh.exe`，退回 `powershell.exe`」。
- ② `include_str!` 会把文件**自带的 BOM** 读成 U+FEFF → 临时文件成**双 BOM**
  → PowerShell 解析出错 → 拼接前必须 `strip_prefix('\u{feff}')`。

**★ 补做（仓库外侧车自身加固，已直接改好）**：`screenshot_tool/mt_engine.py` 的 `shutdown()`
改 `taskkill /F /T`；两个侧车脚本加**父进程死亡守护**（`_pid_alive` + `_parent_watchdog`）；
`rapidocr_service.py` 的孤儿清理 **wmic → PowerShell CIM**。

**★★★ 挖出一个此前没人知道的平台事实**：**本机 `venv_ocr\Scripts\python.exe` 是「转发器」**
——它自己会再拉起一个真正的解释器进程。实测 `Popen.pid`（转发器）≠ 子进程 `os.getpid()`
（真解释器），且真解释器的 `os.getppid()` = **转发器**的 PID。由此三条结论：
①**侧车的直接父进程不是宿主应用** → 盯 `getppid()` 的守护**永远触发不了** → 宿主必须
显式传 **`PETALSNAP_OWNER_PID`**（本次新增，F1/F2 均已注入）；
②Windows 上父进程死后子进程**不会被 reparent** → 判据只能是「父进程 PID 是否还活着」；
③**`os.kill(ppid, 0)` 在 Windows 上会 `TerminateProcess` 父进程** → 绝对不能用来探活。
**⇒ 连带修正 Job Object 的验收标准**：真正跑侧车逻辑的是**孙进程**，回归测试因此升级为
**必须断言孙进程也随 Job 一起死**（判据决定性：Windows 上父进程被 kill 不会连带杀子进程）。
实测通过。

**一键自测**：`tools/_process_selftest.py`（不加载模型、秒级）—— A 语法编译 / B `_pid_alive`
三态 / C 父进程消失 → 侧车自杀（端到端）/ D CIM 清理正负两测 / E 收尾无残留；
`--with-cargo` 可一并跑 Job Object 回归测试。

---

### 8.10 ★ 像素收边：UIA 定语义 + 像素定边界（2026-11-04）

**触发**：用户实测 F2 后发截图，质疑「**为什么还是有这种不存在的区域被选中**」——
Edge 答题编辑器的**答题卡片**被框成 `ListItem 1028x457`，但它**可见的白色编辑面板只占左边 ~69%**，
右边 31% 是 Chromium 报给这个 ListItem 的**列表行透明留白**（页面底色直接透过来）。

**★ 本节最该记的不是代码，是一次自我纠错**：我最初给用户的选项里写「保持现状（Snipaste 同款）」，
用户当场反问「**等一下，snipaste没有这个问题啊**」—— **我对，论证是错的**。
项目自己的 2026-09-17 取证档案（`docs/智能选区-技术方案对比与像素检测方案.md` §二/§六）写着：
**Snipaste = 纯像素边界检测**（框吸附在图像里真实的边/色块边界上，与任何 API 无关），
它压根不问 UIA ⇒ 天然没有「元素矩形宽于可见墨迹」这个代价。
**教训**：**不要拿「某竞品同款」当正确性证明**；竞品的实现路线必须先查清，
否则会用错依据推翻用户的决策。

**方案（用户重拍后选定）**：**UIA 定语义 + 像素收边**——UIA 继续负责「选中哪个元素 /
层级链 / 语义名」，**像素只负责把已选中的那个框的四条边向内收到元素的可见表面**。

**为什么这条路线对 Tauri 特别友好**：
- **零 native / 零新依赖 / 零新增 IPC** —— 纯渲染端改动，复用渲染端**本来就有的整帧
  `bgCanvas`**（F2 的帧经 `get_frame_raw` 的二进制通道早就到手，见根因四那节）；
- **F1/F2 逐字节同源** —— 改的是 `resources/capture.js`，同步到 `tauri-spike/ui/capture.js`
  后 `tools/check-render-sync.js` 仍然全绿（spike 的「一字不改」前提不受影响）；
- 不引入第二条数据源 ⇒ **不会重演 2026-09-18「像素链与 UIA 链双源抢驱动」的频闪/抖动**。

**判据**：逐列/逐行的**中位色**（不是均值——均值会被文字墨迹拖偏）；边界性质分
**表面边界**（收）与**内容边界**（不收）⇒ Explorer 列表行不会被收成文字级小框
（不重演 2026-10-27「框过小」）。完整判据与护栏见 `docs/功能状态清单.md` §3.9 对应条目。

**负向开关 `PETALSNAP_SMART_TRIM=0`（默认开）**：F2 侧需加进 Rust 的 env 白名单
（`main.rs` `env_allow`，每键独立允许值集合）——**并已实测启动日志确认开关真的传到了渲染端**
（`[setup] capture window url = capture.html?env=...,PETALSNAP_SMART_TRIM=0`）。
本项目吃过「白名单只放行 1/0 → 新档位被静默丢掉 → A/B 对照组根本没生效 → 假结论」的亏
（见 §8.8 的 env 白名单坑），所以**每次加开关都要先验对照组生效**。

**离线验证**：`tools/_trim_math.js`（从 `capture.js` 的 `TRIM-CORE` 标记块**抽取同一份算法**，
不在脚本里重写）+ `tools/_trim_frame.ps1`（从用户截图重建原始帧：反解蒙版压暗 ÷0.6 +
修补选框描边）。真实截图复算结果：**右边界 794 → 647**（白色面板右缘 645，误差 2px），
框宽 481→334，**那 31% 的透明留白被精确切掉**，左/上/下三边不动。

---

## 九、变更日志

| 日期 | 变更 |
|---|---|
| 2026-10-31 | 建档。盘点 spike 现状（已迁移/未迁移/壳级缺口），定位 6 个 P0（visibleWindows 原点错配 512px、dpr 硬编码、displays 缺 primary、patch 不可复现、硬编码路径、单实例锁缺失）与 P1/P2 清单；提出验证方式与三个待拍板点 |
| 2026-10-31 | **P0 全部落地并验证**（§八）：6 项 P0 + 3 项附带（dpr 交叉校验 / layout 废弃 / 像素链定性）全部完成；`cargo build --release` 零错误零警告；运行时验证 dpr 两端一致（1.25）、CSS 原点 −2048 与 Electron `winBox.x` 吻合、第二实例被单实例锁挡下；离线枚举实测 512px 偏差并已修正。同时**实测推翻「29 vs 3 窗」初判**（过滤等效，是时段差异，不修）。用户拍板：长截图/录屏本轮不迁、layout 通道废弃、store 首次启动弹窗导入 |
| 2026-10-31 | **★ F2 实测故障定位与修复**（§8.4）：用户报 F2 卡顿/不出窗口/不出智能选框/滑动鼠标才有框/框错位。新增 `tools/_ab_test.ps1`（**钉死光标**再触发——capture.js 新鲜度守卫 `moved<=64` 会把回包丢弃，鼠标一动差异就被噪声淹没）做并排 A/B。**根因一**：dpr 权威源错（`win.scale_factor()` 是窗口所在屏的 DPI，副屏 150% → 1.5，WebView2 实际 1.25 → 全链偏 512 CSS px）→ 改回主屏 DPI（与 Electron `getPrimaryDisplay().scaleFactor` 同源）。**根因二**：`smart_uia.dll` 的 `is_capture_mask_hwnd()` 用 `pid==GetCurrentProcessId()` 只跳自家遮罩 → F1+F2 并行时 F2 的 UIA 查询命中 F1 的全屏 WebView2 驻留遮罩 → 钻进 Chromium 大树 → **3 秒超时**（F2 单独跑 `dll=12ms` 正常，并行必挂）→ 判据放宽为「自家进程」**或**「别家 click-through（WS_EX_TRANSPARENT）全屏窗」。**修后两版并行 F2 `dll=82ms drop=0 applied=1165x731@2271,90`**，框已能出（中间态，见根因三）。顺带：诊断总闸对齐（`shim.js` 曾写死 `PETALSNAP_SMART_DEBUG='1'` → 与 F1 性能不可比，改由 `?smart_debug=1`）；**实测否决 asset protocol 帧路径**并回退纯 IPC + 去 clone（热键→出窗 601→527ms，Rust 抓帧+meta 172→75ms）。**根因三**（DPI 虚拟化）：node 内核进程非 PMv2 → UIA 返回 DIP 坐标 → 框缩成 0.8 倍偏移（尺寸比恰为 1/1.25）→ 在 `f1_worker.js` 加载 DLL 前设 `SetProcessDpiAwarenessContext(-4)`；**最终同点对照 F1 与 F2 输出逐像素相同** `1080x710@2424,256`。驻留态差异（hidden vs visible+transparent）经核查**不修**（hidden 天然不干扰别的实例，§8.4 末） |
| 2026-11-01 | **★ 根因四：29.5MB 智能帧走 JSON 通道（用户报「刚开始进去还是很卡、过几秒才顺滑」）**。`capture.js` 的 `sendSmartFrame()` 把全画布 29.5MB 交给 `ipcRenderer.send('smart:frame', Uint8Array, …)`：Electron 走**结构化克隆**（原生二进制，同帧 ~26ms），但 **WebView2 的 `postMessage` 只接受可 JSON 序列化对象** → `Uint8Array` 被摊平成**两千万个键**的 JSON 对象（≈600MB 文本）→ 渲染端主线程 marshaling 阻塞 ~3.1s（实测 `longtask 3090ms`）+ Rust 主线程 `serde_json` 反序列化再阻塞 ~2.2s（实测 `main-thread stall 2193ms`；`ipc_send` 是**同步** command，参数反序列化就在主线程）。**闭环**：用户实测日志「最后一条正常日志 → 积压一次性刷出」= 6499ms ≈ 3090+2193+1.2s；ESC 的 keydown 排在长任务后面 → 「ESC 退不出」。**F1 无此症状**：`framePrepared=true` → `sendSmartFrame()` 直接 return，**根本不发**；F2 是 `false` → 这 29.5MB 是 **F2 独有的死重**（像素链已全局停用、Rust `smart:pixel-at` 恒空 → 无消费方）。**修法（双保险）**：①Rust meta 改 `framePrepared: true`（F2 的 Rust 侧已用原生抓屏持有同一张全帧，并经 `get_frame_raw` 的 `tauri::ipc::Response` **二进制通道**送到渲染端，不必回读画布）②`shim.js` 的 `ipcRenderer.send/invoke` 包装加**二进制载荷拦截**（>1MB TypedArray/ArrayBuffer 即拒发 + 打日志）。**修后实测**：渲染端 longtask **3090→108ms**、Rust 主线程 stall max **2193→60ms**、**6.5 秒静默期归零**、ESC 响应 **6.5s→1ms**、热键→出窗 **409ms**（F1 参照 416ms，已追平）。同时完成**「识别不够准」侧的定性**：链逻辑 F1/F2 逐段同源 → **准确度不存在迁移差异**；大框的成因是渲染端**面积地板**（`SMART_MIN_AUTO_AREA=0.003`）+ Chromium 树在空白处本就无细元素（实测细元素齐全：`Tree 417x26`/`TabItem 256x42`/`Text 483x21`）；**证伪**「无 UIA 树窗导致 UIA 命中穿透到下层应用」的伪结论（`WindowFromPoint` 核对：最上层确实是 Edge，ZCode 在其下方）。新增可复用探针 `tools/_chain_probe.js`、`tools/_hit_probe.js` |
| 2026-11-01 | **★ 根因五：DLL 跑在独立 node 进程 → 判不出「自家截图遮罩」→ 智能框打在自家 WebView2 DOM 上**（用户报「识别还是不够准」）。会话开着时外部探针实锤：`WindowFromPoint` 命中**自家遮罩 `petalsnap-spike`**，`exStyle=0x40118` **不含 `WS_EX_TRANSPARENT(0x20)`** → 会话中遮罩是**可交互**的（与 F1 同款：F1 `finalizeCaptureWindow` 也是 `setIgnoreMouseEvents(false)`，click-through 只用于**驻留态**）；DLL 出链 `EFP 路 win="petalsnap-spike" chain=1 → MenuItem 3413x960（占屏 69.44%）`、`MAP 路` 20 层全是自家 WebView2 DOM（`"拾花 PetalSnap - Web 内容"`）→ **智能框圈的是我们自己的截图窗口**。**F1↔F2 的确切差异**：F1 的 UIA 查询跑在 **worker_threads（同进程不同线程）** → DLL 里 `GetCurrentProcessId()` 就是 Electron 的 PID = 遮罩的 PID → 「自家」判得出 → 跳过；F2 跑在**独立 node 进程** → PID 对不上 → `is_capture_mask_hwnd`（自家进程 **或** 别家 click-through 全屏窗）两条都不成立 → `find_target_window()` 的 z 序扫描不跳过它 → 它成了命中目标。**修法（宿主 PID 注册，三处）**：①`native/smart_uia/smart_uia.cpp` 新增导出 `SmartUiaSetOwnerPid(int32_t)` + `g_owner_pid`，`is_own_process_hwnd()`/`element_in_own_process()` 统一走 `is_host_pid()`；②`tauri-spike/f1_worker.js`（**宿主桩段**，F1 内核逻辑零改动）读环境变量 `PETALSNAP_OWNER_PID` 调用该导出；③`main.rs` spawn worker 时 `.env("PETALSNAP_OWNER_PID", std::process::id())`。F1 不注册 → 行为完全不变；宿主 PID 只影响「是不是自家」，不动 10-27「自家设置窗/贴图窗是合法目标」的语义。**验证**：修后 `[f1_kernel] owner pid=18568`，同坐标目标窗从 `petalsnap-spike` 变回 **`图形画板`**（下层应用），输出矩形 `1080x710@2424,256 type=Tree areaPct=16.25%` ——**与此前 F1 的同点对照逐字一致**；对照：未注册 owner pid 的外部探针仍报 `petalsnap-spike` → 反证修复点精确。**教训**：两版共用同一份二进制/脚本时，「代码看起来一样」**推不出「运行时一样」**——必须逐项列出**运行环境差异**（同进程线程 vs 独立进程 / DPI 感知上下文 / 宿主 PID / 窗口驻留态 / IPC 通道类型）再下「行为一致」的结论。同日另修**根因四**（29.5MB 智能帧走 JSON 通道导致进入即卡 + ESC 退不出）：Rust meta `framePrepared` 改 true + `shim.js` 二进制载荷拦截，渲染端 longtask 3090→108ms、Rust 主线程 stall 2193→60ms、6.5 秒静默期归零、ESC 延迟 6.5s→1ms、热键→出窗 409ms（F1 参照 416ms）；护栏已做负向测试（`PETALSNAP_FRAME_PREPARE=0` 强制回退 → `BLOCK oversized payload (29491200 bytes)`，longtask 仅 124ms）。用户复测确认「已经不卡了，进入即用」 |
| 2026-11-01 | **★「延迟比 F1 高」复核与根因收敛（§8.5）**：第一轮受控 A/B 判定两版**基本持平**（热键→出窗 F1 428ms / F2 438ms；富元素区 `total` 1~21 vs 1~31ms）→「F2 更慢」**不是壳的锅**（F2 多背的 219ms 帧过桥是 WebView2 无 shared-memory IPC 的**架构性代价**，已被其它开销抵消）。但**尖峰两版共有**。第二轮把尖峰拆开：F1 在粗粒度窗口内连续移动的 `SMART-DIAG` 出现 **`dll=0/1ms`（worker 内部几乎不耗时）而 `total=482ms`** ⇒ **慢的不是「识别」而是「排队」**（worker 单线程串行队列 + 同步 DLL 调用把排队的悬停查询一起拖住）。**用户没被 500ms 直接打脸，是因为渲染端有一条 0ms 本地查表旁路**（`applyLocalMapRect`）→ **用户感知的延迟 = 这条旁路失效的那部分**。**逐行核对源码定位到旁路的三个结构性缺口**：①`requestLocalMap()` 只在回包 `src==='map'` 时调用（worker 在瘦图时改用 EFP 应答 → **最慢的场景永远不拉图**）②`publishMap()` 要求 `items>=3`（**整窗级窗口实测 `items=1` → 根本不会有图**）③地图只收控件元素，光标落在空白处必然 miss。⇒ **凡是没有细元素的应用（= 用户定调的「只要大块」那一档），0ms 旁路结构性失效**。**F1↔F2 逐行同构** ⇒ 修复两版同吃，**不是迁移缺陷**。**方案（待拍板）**：P0-a 发布门槛 `items>=3`→`items>=1`（worker 两份都改）／P0-b 本地查表 miss 时也主动拉图（渲染端两份同步）／P1 地图空洞用窗级大块兜底（需 worker 判定该应用确实无细元素）。**建议先落 P0-a + P0-b** |
| 2026-11-01 | **★「延迟比 F1 高」的 P0-a / P0-b 落地并双版验证**（§8.5）。用户拍板「P0-a + P0-b，两份内核同步改」。**P0-a**：worker `publishMap()` 由「`items<3` 一律不下发」改为「**`items<3` 且 `rowMissingCount>3` 才下发**」——判据 `rowMissingCount>3` 正是 worker **既有的降级口径**（同一条件下 worker 本来就用瘦图应答），故渲染端画出的窗级大框与 worker 的权威回包**是同一个答案**，不引入"粗图冒充精确元素"回归；唤醒期维持旧口径。落点 `main/services/smartUiaNative.ts`（F1 内嵌 worker）+ `tauri-spike/f1_worker.js`（F2）。**P0-b**：渲染端解除「回包 `src=='map'` 才拉图」的耦合——回包处理改为无条件 `requestLocalMap()`（1s 限频在函数内，主进程侧纯缓存读 0ms），且 `handleMouseMoveInner` 里本地 miss 时也主动拉一次图；落点 `resources/capture.js` + `tauri-spike/ui/capture.js`（**两份逐字节同步**，`check-render-sync.js` 通过）。**配套**：负向开关 `PETALSNAP_SMART_THIN_MAP=0`（退回旧口径）；渲染端新增 `[SMART-LOCAL] hit=N miss=M map=K`（仅 `SMART_DEBUG`）——SMART-DIAG 只在有回包时才打印，恰好在 worker 堵住（`total=482ms`）的窗口期一声不吭，只有该计数能回答"用户看到的框是不是 0ms 旁路画的"；新增 `tools/_local_path.ps1`（一键量瘦图外发+旁路命中）与 `tools/_thin_win.ps1`（造 `items<3` 的测试靶窗口）。**验证**：F1/F2 双双出现 `[f1_kernel] publish thin map items=1 key=89,206,1823,1225`，渲染端 0ms 旁路累计 **hit=193（F1）/ hit=80（F2）**；修前同场景为 `map=0`+`hit=0`（本地根本没图→旁路完全失效）；负向对照 `THIN_MAP=0` 瘦图外发 0 条。`cargo build --release` 零错误零警告（43.91s），F1 宿主 `node app/build-host.js` 已重建。**P1（地图空洞用窗级大块兜底）暂不实施**，待用户复测后再定 |
| 2026-11-02 | **★ 悬停跟随手感：「果冻感」修复（§8.6，位置与尺寸解耦）**。用户报「列表滑动时框慢半拍像果冻；Snipaste 跟手但偶尔突然从小窗变大窗会闪」。**机制（外部探针实测 Explorer）**：光标每下移 30px 就换一个 `ListItem`（落笔框都是 810x30）→ 目标矩形每行都变 → `capture.js` 的 150ms「水流」补间**每行重启一次** → 框永远在追赶（落后 1.5~3.5 行）。**认知**：果冻与「突然变大」是同一个补间的两端（位置滞后 / 尺寸突变）→ **解耦**而非二选一：等尺寸移动（面积比 0.25~4）→ 位置立即跟手；尺寸显著跳变（<0.25 或 >4）→ 位置与尺寸一起补间 150ms。**实测**：F1 旧 avg 46.0/74.4px、max 105px → 新 **0.0px**；F2 旧 avg 56.8/77.5/66.8px、max 107px → 新 **0.0px**。负向开关 `PETALSNAP_SMART_HOVER_MODE=0`；新增探针 `[SMART-LAG]`（按区间累计的滞后量）与 `[SMART-KEY]`。**★ 顺带修掉的埋雷**：F2 的 `shim.js` 里 `window.process.env` 只认 `PETALSNAP_SMART_DEBUG` 一个键 → `capture.js` 读的其它环境变量在 Tauri 侧**静默失效**（负向开关在 F2 根本不生效 → A/B 假结论，本次实测先踩坑）；修法：Rust 侧按白名单以 `?env=K=V,K=V` 透传，`shim.js` 解析后填回 `process.env` |
| 2026-11-02 | **★ 悬停「闪亮」修复（§8.7，用户拍板「亮度匀速铺开 + 大跳变延时拉长」）**。用户反馈识别精确、跟手已达标，但尺寸突变时那一下「闪亮」观感不好。**先排除伪因**：洞消失（整屏变暗）实测 `null=0` 不是闪源；Explorer 上画出的确是精确的 `810x30 ListItem`（占屏 0.51%），识别也没错。**真因**：810x30（0.51%）→ 1535x806（26.2%）= **面积涨 73 倍**，而**线性尺寸插值让面积二次增长** → 亮区末尾「唰」地铺开（峰值亮度速率 ~1.18 万 px²/ms，末尾 50ms 内屏幕从 10% 亮到 26%）。用户感知的是「亮起来的面积」而不是「宽高」——这是本条修复的核心认知。**解法**：大跳变时解出 `g` 使 `(w0+Δw·g)(h0+Δh·g) = a0+(a1−a0)·e` → **面积随时间线性（亮度匀速）**而宽高仍沿线性混合走；位置用**中心滑移**；时长 150ms → **260ms**（`HOVER_JUMP_MS`）；等尺寸移动仍走「位置立即跟手」不受影响。**实测**：F2 新口径 2048x1152→126x141 **maxDev 0.1~0.2pp（线性）** vs 旧口径 4.9pp；F1 新口径 1034x37→2048x155（**变大**）**0.0pp**、1851x185→126x141（变小）0.0pp vs 旧口径 4.6pp。**离线数学验证**（`tools/_morph_math.js`，与线上解算器逐字同源）5 组用例全 PASS（`g∈[0,1]`、两端精确命中、面积偏差 0.0000pp；峰值亮度速率旧 6821 → 新 4665 px²/ms，新=平均速率即完全匀速，旧 1.46× 即末尾有冲）。**配套**：负向开关 `PETALSNAP_SMART_HOVER_MODE=0` 两版均实测生效；新增探针 `[SMART-MORPH]` 与工具 `tools/_morph_curve.ps1` / `tools/_scan_targets.ps1` / `tools/_morph_math.js`。**教训**：线性插值「尺寸」不等于线性插值「观感」——要让亮度匀速就得**反解尺寸参数** |
| 2026-11-02 | **★★ 悬停「迟缓 + 剧烈抖动」修复（§8.8，三通道分离 + UIA 存活判据修正）**。用户反馈①位置变化特别迟缓不跟手 ②剧烈变化时加速移动就剧烈抖动，并指出跟手/不闪/不抖「像个达不到的三角」，建议「窗口正常变化=跟手，亮度变化=从灰色渐变的过程」。**实测定位**：根因一=动画是**二态分支**（跳变走中心滑移/否则立即跟手），目标一抖分支整块换 ⇒ 同一会话位置滞后在 **0px 与 153~264px 之间横跳**（快速扫掠加权平均 **54.2px**、21% 分段在拖）；根因二=目标两个来源（0ms 本地图 vs UIA 实时回包）打架，快速移动时在「精确行框 0.5%」与「整屏大块 50%」间横跳（**12~65 次/秒**）；且快速移动时**每个 UIA 回包都必然"不新鲜"** → 1s 后被判成「这个应用没树」→ 大块兜底给出**整屏** → 6ms 后 UIA 回包又切回行框 ⇒ 交替 = 剧烈抖动。**解法（三通道分离）**：①**位置无条件立即跟手**（无分支）②**面积用限速器指数逼近**（速率=min(缺口/τ,4665 px²/ms)，τ=70ms）——限速器**不因目标变化而重启**，故**对目标抖动免疫**；③**宽高比对数限速**。渐近收敛 ⇒ 无末尾猛冲 = 用户要的「灰色渐变」。**数据层修正**：`lastUiaChainAt` 原判据只有 `moved<=64`（回包新鲜）⇒ 快速移动时永远判死；改为「**当前光标仍在这条链所属窗口内**也算树活着」（「回包过时」≠「这个应用没树」）。**实测**：旧口径加权平均 **26.3px/33% 分段在拖** → 新口径 **0px/0%**；Explorer 场景 54.2px/21% → **0px/0%**；面积曲线 0.54→2.12→5.27→7.53→7.85→8.13% 渐近收敛，实测速率 max 1513 px²/ms（上限 4665）。**三档口径开关** `PETALSNAP_SMART_HOVER_MODE`：1/未设=新、2=二态分支（旧线上）、0=最初线性补间 → 用户可实时 A/B 定夺。**期间修掉 3 个「看起来在跑、其实没跑」型隐蔽 bug**：①`const p` 挪进分支后成块级作用域 ⇒ 新口径每帧抛 `ReferenceError`（**日志无异常**）→ rAF 链断、动画完全不跑；②限速器状态放在 `startHoverSmoothLoop` **闭包**里 ⇒ 被 `setHoverTarget` 重新进入时重置 ⇒ 限速器永不生效（`mrate=0`）→ **跨帧历史状态必须放模块作用域**；③dt 取到停机间隔 ⇒ 一次帧走完差距 = 还是闪 → 启动时 `lastTickAt` 归零 + dt 上限 34ms。**★ Rust env 白名单坑**：只放行 `"1"/"0"` ⇒ 新增的 `HOVER_MODE=2` 被**静默丢掉** ⇒ A/B 对照组没生效 ⇒ 假结论 → 改为每键独立允许值集合。**新增** `[SMART-FLUX]` 探针 + `tools/_follow_probe.ps1`（跟手性/抖动专项）+ `tools/_morph_target.ps1`（自造稳定靶窗） |
| 2026-11-02 | **★★★「整机崩溃」事故定性与根治（§8.9）**。用户报「电脑崩了」，怀疑是本项目改动导致 llama-server 一直重新启动也没关闭、启动了一堆 → 显存占满 → 整机崩溃。**定性（三段实锤，责任在我）**：①**触发源是我的探针脚本**——`_local_path.ps1`/`_follow_probe.ps1`/`_morph_curve.ps1`/`_scan_targets.ps1`/`_latency_*.ps1` 每次运行都 `Get-Process ... | Stop-Process -Force` 杀应用 → Windows 强杀 = TerminateProcess → 应用**来不及跑退出清理**；②**放大器是产品缺陷**——宿主只杀 python 侧车一个进程，而 Windows 上 `proc.kill('SIGTERM')`/`Child::kill()` 同样是 TerminateProcess → **python 的 atexit 不执行** → `mt_engine.shutdown()` 不跑 → 它拉起的 `llama-server.exe`（Hy-MT2，~1.2GB 显存/个）变**孤儿**继续占显存；仓库外 `rapidocr_service.py` 的孤儿清理依赖 **`wmic`（本机 Win11 已移除该命令 → except 分支静默跳过 → 从未生效）**，F1 的 `local_capture_service.py` 则根本没有孤儿清理；③**正反馈**——显存被挤占 → `mt_engine` 看门狗「连续 5 次慢 → 重拉 llama-server」→ 用户看到的「一直重新启动」；本机 **RTX 4070 Laptop 仅 8GB**，6~7 个即打满 → CUDA 降级共享内存 → 系统内存雪崩 → 整机崩溃。**根治四道**：①**F2 Job Object + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`**（手写 Win32 ABI，绕开依赖树里两份 `windows_core` 的 `PCWSTR` 类型冲突）→ 宿主一消失（哪怕被强杀）**OS 连树陪葬**，这是唯一能对抗「宿主被强杀」的手段；②双端回收改 `taskkill /PID /T /F` **连树杀**；③新增 `tools/_sweep_orphans.ps1` **启动前清扫**「父进程已死」的残骸（PowerShell CIM，**不用已被 Win11 移除的 wmic**；F2 编译期内嵌该脚本）；④端口有人监听但不健康时**等**而不是再拉一个侧车（F2 原 `/health` 超时仅 400ms，模型加载期必然误判 → 重复拉起入口）。**探针脚本整改**：全部改走新增的 `tools/_stop_app.ps1`（优雅停 → 树杀 → 孤儿清扫）。**★ 补做仓库外侧车自身加固**（`F:\Work\Create\OCR\`，不在 git 内但 `edit` 工具可改 → 已直接改好）：`mt_engine.shutdown()` 改 `taskkill /F /T`；两个侧车加**父进程死亡守护**（`_pid_alive` 用 `OpenProcess(SYNCHRONIZE)+WaitForSingleObject`，纯 ctypes 不加依赖）；`rapidocr_service.py` 孤儿清理 **wmic → CIM**。**★★★ 挖出一个此前没人知道的平台事实**：**本机 `venv_ocr\Scripts\python.exe` 是「转发器」**——它自己会再拉起一个真正的解释器进程（实测 `Popen.pid`（转发器）≠ 子进程 `os.getpid()`（真解释器），且真解释器的 `os.getppid()` = 转发器 PID）⇒ ①**侧车的直接父进程不是宿主应用** → 盯 `getppid()` 的守护**永远触发不了** → 宿主必须显式传 **`PETALSNAP_OWNER_PID`**（本次新增，F1/F2 均注入）；②Windows 上父进程死后子进程**不会被 reparent** → 判据只能是「父进程 PID 是否还活着」；③**`os.kill(ppid,0)` 在 Windows 上会 `TerminateProcess` 父进程** → 绝对不能用来探活。**⇒ 连带修正 Job Object 验收标准**：真正跑侧车逻辑的是**孙进程**，回归测试升级为**必须断言孙进程也随 Job 一起死**（判据决定性：Windows 上父进程被 kill 不会连带杀子进程）→ 实测通过。**验证**：`cargo test` **3/3**；一键自测 `tools/_process_selftest.py` **ALL PASS**（A 语法编译 / B `_pid_alive` 三态 / C 父进程消失→侧车自杀端到端 / D CIM 清理正负两测 / E 收尾无残留，PS 5.1 与 pwsh 7 双跑通过）。**踩坑**：①PS 5.1 读**无 BOM** 的 `.ps1` 按 ANSI 解码 → 中文注释解码错乱 → **解析异常 → taskkill 根本没执行且无任何报错**（`killed=0` 但进程还活着）→ 该脚本单独加 UTF-8 BOM、宿主优先用 `pwsh.exe`；②`include_str!` 会把文件自带 BOM 读成 U+FEFF → 临时文件成**双 BOM** → 须先 `strip_prefix('\u{feff}')`。**教训**：进程类资源必须有**「宿主消失即陪葬」的硬机制**（Job Object / 进程组 / PDEATHSIG 类），不能依赖被删进程自己的 atexit——**atexit 只在正常退出时跑**；且**必须先确认「我 spawn 的那个 PID 是不是真正在跑我代码的那个」**（转发器/包装器会骗过 PID 语义） |
| 2026-11-04 | **★★ 像素收边：UIA 定语义 + 像素定边界（§8.10）**。用户实测报「为什么还是有这种不存在的区域被选中」——Edge 答题卡片的 `ListItem 1028x457` 里有 31% 是**元素矩形外的内容空白**（Chromium 把列表行的透明留白报给了这个 ListItem）。**★ 本轮最该记的是一次自我纠错**：我给用户的选项里写「保持现状（Snipaste 同款）」，用户当场反问「**等一下，snipaste没有这个问题啊**」——**我对，论证是错的**（项目 2026-09-17 取证：**Snipaste = 纯像素边界检测**，压根不问 UIA ⇒ 天然没这个代价；我们是 UIA 元素矩形路线 ⇒ 这个代价是结构性的）。**教训：不要拿「某竞品同款」当正确性证明**，竞品路线必须先查清，否则会用错依据推翻用户的决策。用户重拍后选定「**UIA 定语义 + 像素收边**」：UIA 继续管「选中哪个元素/层级/语义名」，像素只管把已选中的框的四条边**向内收到可见表面**。**对 Tauri 特别友好**：**零 native / 零新依赖 / 零新增 IPC**（复用渲染端本来就有的整帧 `bgCanvas`，F2 的帧经 `get_frame_raw` 二进制通道早就到手）；改的仍是 `resources/capture.js`，同步后 `check-render-sync.js` 全绿（spike 的「一字不改」前提不受影响）；**不引入第二条数据源** ⇒ 不会重演 2026-09-18「像素链与 UIA 链双源抢驱动」的频闪/抖动。**判据**：逐列/逐行**中位色**（均值会被文字墨迹拖偏）+ 边界性质分**表面边界（收）/内容边界（不收）** ⇒ Explorer 列表行不会被收成文字级小框（不重演 10-27「框过小」）。**负向开关** `PETALSNAP_SMART_TRIM=0`（默认开）+ Rust env 白名单，**已实测启动日志确认开关真传到渲染端**（本项目吃过「白名单只放行 1/0 → 新档位被静默丢掉 → A/B 对照组没生效 → 假结论」的亏）。**离线验证** `tools/_trim_math.js`（从 `capture.js` 的 `TRIM-CORE` 块抽同一份算法，不重写）+ `tools/_trim_frame.ps1`（从用户截图重建原始帧：反解蒙版压暗 ÷0.6 + 修补选框描边）⇒ **右边界 794→647**（白色面板右缘 645，误差 2px），框宽 481→334，那 31% 透明留白被精确切掉，左/上/下三边不动。重建时修掉两个坑：`LockBits` 必须显式转 `Format32bppArgb`（PNG 载入后可能 24bpp → stride 排布不同 → 读出来全错位）；修补描边时**从洞外取样要跟着反解变暗**，否则把压暗色拷进洞内污染参考带 |

# 智能选区 · C++ UIA 原生模块改造计划

> 目标：把 Shotera 级「悬停智能框 + 滚轮切层级」做到 **亚毫秒级**，去掉  
> Electron → IPC → Python HTTP → uiautomation 的长链路。  
> 状态：方案（未编码）| 2026-09-17

---

## 一、现状与差距

| 路径 | 实现 | 单次延迟（估） |
|---|---|---|
| **我们（现）** | capture.js → IPC `smart:at-point` → koffi 窗口 + fetch → Python `/uia` → `ControlFromPoint` | **20–80ms** |
| **Shotera（参照）** | 同进程 C/C++：`ElementFromPoint` / `GetAncestor` | **<1ms** |

差距不在算法思路，而在 **调用链长度**。

---

## 二、目标架构

```
capture.js (mousemove ~60Hz)
    │  同步/极短异步
    ▼
主进程 (Electron)
    │  N-API / koffi 调 C++ 或纯 koffi 调 Win32+UIA COM
    ▼
Native: UIA ElementFromPoint + 父级链 + GA_ROOT
    → 返回 levels: [{x,y,w,h,type}, ...]  （DIP 坐标）
```

**原则**
1. UIA **只在主进程**，不进渲染进程  
2. 坐标在 native 层统一：物理像素查询 → 返回前转 **DIP**  
3. 查询前 `setIgnoreMouseEvents(true)`，避免打到截图窗  
4. 渲染端只收 **levels 数组 + 当前 smartLevel 索引**，不再自己拼窗口

---

## 三、技术选型（推荐顺序）

### 方案 A：纯 koffi 调 UIA COM（零编译，工作量中）★ 推荐先做
- 已有 `koffi 2.16`，可加载 `UIAutomationCore.dll`
- 实现 `IUIAutomation::ElementFromPoint` 需 COM vtable，koffi 做过 `WindowFromPoint`/`GetAncestor`
- **优点**：不引入 MSVC/原生构建；与现有 `screenshotHelper.ts` 同风格  
- **风险**：COM 接口签名多，需仔细对 vtable；部分应用 UIA 仍粗

### 方案 B：小型 C++ DLL + N-API（与 Shotera 同级）
- `smart_uia.node` / `smart_uia.dll`：`ElementFromPoint` + 父级链 + `GetAncestor`
- 主进程 `require` 直接调  
- **优点**：性能最好、最稳、可打日志  
- **成本**：需要 Visual Studio 工具链 + 与 Electron ABI 对齐（或用独立 exe + 管道）

### 方案 C：独立 C++ 小服务（127.0.0.1 高频 JSON）
- 仍跨进程，但比 Python 快一个数量级  
- **优点**：隔离崩溃  
- **缺点**：仍有 IPC 开销，不如 A/B

**建议路径**：A 先落地验证手感 → 若仍不够再上 B。

---

## 四、方案 A 详细设计（koffi + UIA COM）

### 4.1 需要的 COM 接口（精简）

| 接口 | 用途 |
|---|---|
| `IUIAutomation` | 入口，`ElementFromPoint` |
| `IUIAutomationElement` | `get_CurrentBoundingRectangle` / `CurrentControlType` / `CurrentName` |
| `IUIAutomationControlType` | 过滤 Pane/Desktop |
| `IUIAutomationTreeWalker` 或 `IUIAutomationElement::FindAll` 父链 | 上溯（`uiautomation` 包内部用 TreeWalker） |

> 实用折中：若 COM 完整 vtable 太重，可 **只用 koffi 做 WindowFromPoint+GA_ROOT**，UIA 仍留 Python，但 **预启动 Python + 连接复用**，把延迟从「每帧 HTTP」压到「本地 Unix socket / named pipe」。

### 4.2 主进程 API（新增 `main/services/smartUia.ts`）

```ts
export interface SmartLevel {
  x: number; y: number; width: number; height: number; // DIP
  name?: string;
  controlType?: string;
}
export function getSmartLevelsAtDip(dipX, dipY, scaleFactor): {
  levels: SmartLevel[]; // 由小到大，末尾含 Screen
  window: SmartLevel | null;
}
```

- 同步返回（A/B）或 `async` 但 **不启 Python**  
- `smart:at-point` IPC 改为只调此函数  
- **删除** `fetch('http://127.0.0.1:18766/uia')` 在 hover 路径上的使用

### 4.3 坐标（必须一次做对）

```
DIP = screen 坐标（Electron）
物理 = DIP × scaleFactor（150% → ×1.5）
UIA/Win32 用物理；返回前 ÷ scale → DIP
```

与现有 `smart:at-point` 一致，避免再偏 1.5 倍。

### 4.4 窗口查询（已有，保留）

```
WindowFromPoint → GetAncestor(GA_ROOT=2 | GA_ROOTOWNER=3)
→ 跳过本进程 PID → GetWindowRect
```

并入 `getSmartLevelsAtDip`，作为层级链中的 Window 级。

---

## 五、渲染端改动（`capture.js`）

| 现 | 改后 |
|---|---|
| `requestSmartIpc` 20ms + busy 队列 | 可 **每 mousemove 同步 IPC**（若 A/B 同步）或 8–16ms 异步 |
| 自己拼 levels、冻结链逻辑 | **信任主进程 levels**；只维护 `smartLevel` 索引 |
| 像素投影兜底 | 仅当 `levels.length === 0` 时启用 |
| 插值 lerp | 保留；延迟下降后可 **降低 t**（更贴手）或关掉插值 |

滚轮：`deltaY < 0` → level++（放大），到 `levels.length-1` 停；`>0` → level--，到 0 停。

---

## 六、实施分期

### P0（1–2 天）：链路减负，先手感
1. Python `/uia` **常驻已预热**（已做 serviceReadyAt）  
2. 去掉 hover 路径上每次 `ensure`/`checkHealth`  
3. IPC 改 **named pipe 或仅保留 HTTP 但连接复用**  
4. 渲染端：回包立刻 `setHoverTarget`，**禁止 null 闪全屏**  
5. 滚轮方向：上=放大  

**验收**：微信列表滑动不闪、框跟手明显改善。

### P1（2–4 天）：koffi 直连 UIA（方案 A）
1. 在 `screenshotHelper` 或 `smartUia.ts` 实现 `ElementFromPoint` + 父链  
2. 单元：固定坐标返回与 Python `/uia` **同一 levels**  
3. 切换 `smart:at-point` 到 native，保留 Python 作 fallback  
4. 日志：`PETALSNAP_SMART_DEBUG=1` 对比两侧 rect  

**验收**：无 Python 进程时智能框仍可用；延迟 < 5ms。

### P2（可选，3–5 天）：C++ N-API（方案 B）
- 若 A 在复杂应用上 COM 不稳，再写 `smart_uia.node`  
- 与 Shotera 同级；需 CI/本机 MSVC  

---

## 七、风险与对策

| 风险 | 对策 |
|---|---|
| COM vtable 难调 | 先用 Python 对拍；失败则退 B |
| 微信自绘列表 UIA 不准 | 保留「父级上溯至含点」+ 像素兜底 |
| 截图窗挡查询 | 查询前 `setIgnoreMouseEvents(true)`（已有） |
| 多显示器 DPI | 统一 DIP↔物理换算（已有 ×sf） |
| 性能反而更差 | 热路径禁用 `console.error` 每帧日志 |

---

## 八、明确不做

- 不在渲染进程直接 COM  
- 不把 UIA 塞进 OCR Python 服务的热路径  
- 不用「隔 100ms 再算」代替跟手（用插值掩盖延迟）  

---

## 九、成功标准（对照 Shotera）

1. 微信/浏览器列表：框贴行，移动无「关掉再开」  
2. 滚轮：上放大到全屏、下缩小到控件，过程连续  
3. 鼠标停住时 Tab 切层，框只变大小、中心跟随光标  
4. 日志：`smart:at-point` 耗时 **p95 < 8ms**（P1）  

---

## 十、下一步（你确认后开工）

默认按 **P0 → P1（koffi UIA）** 推进；P2 仅在 A 失败时启动。

需要你拍板：
1. 是否接受 **P0+P1** 为正式方案（暂不写 C++ DLL）？  
2. 智能选区是否继续挂在现有截图会话（全屏 BrowserWindow）内，还是独立窗口？（当前挂会话内，与 Shotera 类似）  

---

## 十一、2026-09-17 实测诊断（方案 B 已编码：`native/smart_uia/smart_uia.dll` + `smartUiaNative.ts`）

> 现象：智能框基本不出现 / 出现也只有整窗大框，复刻不出 Shotera 的"贴控件"效果。
> 方法：`PETALSNAP_SMART_DEBUG=1` 跑应用抓 `smart:at-point` 日志 + `tools/scratch/uia_probe.js` 独立进程直调 DLL。

### 11.1 根因 A（必修，TS）：koffi 类型重复注册，窗口兜底链路每次都抛异常
`screenshotHelper.ts::getTopLevelWindowAtPoint` 把 `koffi.struct('POINT_W', …)` / `koffi.load` / `func(...)`
全写在函数体内——koffi 类型名是进程级全局，**第一次调用成功、之后每次调用都抛
`Duplicate type name 'POINT_W'`**（日志逐帧刷这条）。结果：DLL 返回空时的 Win32 兜底恒为 null。
修法：把 koffi 加载、结构体注册、函数绑定提为模块级懒初始化单例（只跑一次）。

### 11.2 根因 B（必修，C++）：DLL 命中的是我们自己的全屏截图遮罩
应用内日志恒为 `nativeOk:true, n:0`，而独立进程探测同一屏幕点能拿到 Edge 的 14 层 + 窗口——差别只在
**应用内有全屏遮罩窗压在最上层**：
- Win32 部分：`WindowFromPoint` → `GA_ROOT` → 发现 pid 是自己 → **直接 `winOk=false` 放弃**，
  没有像 TS 版那样沿 z 序 `GW_HWNDNEXT` 往下找真正的目标窗；
- UIA 部分：`ElementFromPoint` 返回我们自己 Chromium 页面的元素，尺寸全屏被 `>2400×1400` 过滤，
  再往自己页面里钻子元素（canvas 等）也全被过滤 → levels 空；
- 副作用：钻自己页面的无障碍树很慢——探测显示命中"空处/自身"时单次 **~500ms**（命中 Edge 只要 10ms），
  这就是悬停发卡的来源之一。
修法（让 DLL 不依赖遮罩是否 click-through）：
1. 目标窗定位改为「z 序向下扫描」：从 `WindowFromPoint` 起沿 `GW_HWNDNEXT` 找第一个 **可见、非本进程、
   含点** 的顶层窗（与 TS 兜底同逻辑）；
2. UIA 起点改为 `ElementFromHandle(目标窗)` 再按点钻取（现有 `drill_deepest_raw`），
   `ElementFromPoint` 只在其返回元素的 `CurrentProcessId != 本进程` 时才采用；
3. 任何情况下**不进入本进程元素树**（顺带消灭 500ms 慢路径）。

### 11.3 差距 C（复刻 Shotera 效果的真正门槛）：Chromium 类应用只给整页大框
独立探测 Edge：14 层全是 1699×841 / 1707×847 的容器（Tree / Document / "Chrome Legacy Window"），
没有视频、按钮、评论条目——**Chromium 的深层无障碍树尚未激活**（"Chrome Legacy Window" 即未激活态）。
Chromium/Edge 只在检测到 UIA 客户端持续查询后才展开完整树，首次查询拿不到。
方案（B 修完后单独迭代，需实测数据）：
1. 会话开始即对目标窗做一次 `ElementFromHandle + FindFirst` **预热**，触发 Chromium 激活无障碍；
2. 激活后 `ElementFromPoint` 自带提供方 hit-test（`ElementProviderFromPoint`），会直接返回最深元素，
   无需自己钻；探测脚本连续查同一点观察 levels 是否变细，用数据定预热时长；
3. 兜底：UIA 只给大容器时，用已有的 **投影轮廓法文字块**（像素级）作为最深一级，
   levels = [文字块, UIA 元素…, 主窗, 全屏]——保证任何应用（含微信自绘列表）都有"贴内容"的一级。

### 11.4 体验问题 D：层级链大量重复矩形
14 层里同尺寸的连续 3~4 层（1699×841 ×3 …），滚轮切层会"按了没变化"。修法：按矩形去重
（与上一层四边差 ≤2px 即丢弃），Shotera 的滚轮之所以"连续"，每一步框都在变大小。

### 11.5 实施顺序与验证
| 步 | 内容 | 验证 |
|---|---|---|
| 1 | A + B + D：改 `screenshotHelper.ts`、`smart_uia.cpp`，`build.bat` 重编 | `uia_probe` 在遮罩开着时仍返回 Edge；应用内日志 `n>0`、无 Duplicate 异常；p95 延迟 < 15ms |
| 2 | 用户实测：微信 / 浏览器 / 资源管理器悬停有框、滚轮切层每步变化 | 回归清单「区域截图」项 |
| 3 | C：Chromium 预热 + 文字块兜底，探测脚本量化 | Edge 上 deepest 从 1699×841 收敛到控件级 |

探测脚本 `tools/scratch/uia_probe.js` 转正到 `tools/uia_probe.js`（开发工具，随仓库）。
注意：node 进程非 DPI 感知，探测时坐标按**逻辑像素**给（1707×960）；应用内（Electron 感知 DPI）是物理像素。

### 11.6 实施记录（2026-09-17，步 1 完成，待用户实测）
- **A 已修**：`screenshotHelper.ts` 新增 `getWin32()` 模块级懒初始化单例（koffi 加载 / `RECT_W`·`POINT_W`
  注册 / 全部 user32·kernel32 绑定 / EnumProc 原型只做一次）；`enumVisibleWindowsKoffi` 与
  `getTopLevelWindowAtPoint` 改为取单例。**顺带修掉同源隐患**：`enumVisibleWindowsKoffi` 也在函数体里注册
  `RECT_W`，意味着第二次截图会话起窗口枚举必抛异常返回空。
- **B 已修**（`smart_uia.cpp` 重编）：`find_target_window` 沿 z 序 `GW_HWNDNEXT` 跳过本进程找可见含点顶层窗；
  UIA 起点 `ElementFromPoint` 命中本进程即弃用、改 `ElementFromHandle(目标窗)` 按点钻取；层级链遇本进程元素即停；
  全屏过滤改按 `SM_CXVIRTUALSCREEN/SM_CYVIRTUALSCREEN`。
- **D 已修**：层级按矩形去重（四边 ≤2px），Edge 14 层 → 5~7 层。
- **C 的实测结论**（改变原方案）：Chromium 无障碍树激活是**异步且按应用生命周期一次性**的——首次 UIA
  查询后 ~100–250ms 才展开（Edge：1699×841 整页 → 1107×726 播放器区域，正是光标所在视频，即正确的最深级），
  同一调用内重查拿不到、忙等 40ms 也拿不到；激活后首查即深。因此**不做 DLL 内预热**，靠悬停逐帧重查在
  几帧内自然收敛。ZCode（Electron）窗口实测可直接命中 `Button 781x21 "展开工具详情"`——控件级 + 名称，
  即 Shotera 效果。文字块像素兜底仍保留给自绘应用（微信列表）。
- 延迟：Edge 8~10ms/次、Electron 15ms/次（独立进程测，含 koffi 开销）；不再有钻自身树的 500ms 慢路径。
- 探测工具转正：`tools/uia_probe.js [x y] [rounds]`。
- **待用户实测**：微信 / 浏览器 / 资源管理器悬停有框且贴控件；滚轮切层每步变化；进入 Chromium 窗口后几帧内框收敛。

### 11.7 追加诊断与方案修正（2026-09-17，"识别不够准确"）
用户实测截图（微信聊天列表，框 479×77 在第一行）：排查确认框与光标一致——**那个框不是 UIA 给的，
而是像素投影 `detectUiElementAt`**。上一会话把 level 0 改成纯像素、放弃 UIA 的依据（"微信 UIA 框错一行"）
是误诊：

**真正根因：Python `/uia` 兜底进程不是 DPI 感知**（实测 `IsProcessDPIAware=False`，进程内屏幕是
1707×960 逻辑尺寸）。150% 缩放下 Electron 传物理坐标 → Python 当逻辑坐标命中 1.5 倍远处的元素 →
返回的逻辑矩形又被主进程按物理换算——两次错位部分抵消，框落在光标附近但**错一行**。原生 DLL 修好前
每次悬停都走这条坏链路，于是得出"UIA 不准"的错误结论，把整个默认级换成了启发式像素法（这正是
"识别不够准确"的直接原因：像素投影对"头像+两行字+时间"的复合行只能连成一块，粒度上限低）。

**修正（三处）**：
1. `rapidocr_service.py`（两份同步）：启动即 `SetProcessDpiAwareness(PER_MONITOR_AWARE_V2)`，
   `/uia` 坐标语义归一为物理像素进出；
2. `capture.js` `pickSmartRectAt`：level 0 恢复 **UIA 最深元素优先**（原生 DLL 已修好且物理/逻辑一致），
   仅当 UIA 不可用或最深元素 > 30% 屏幕面积（无障碍未激活/自绘 UI 只给整页容器）时才落像素文字块；
3. level ≥1 放大链路不变。
预期：微信列表悬停框到**行元素**（UIA ListItem），指针落在标题/预览文字上且该文字是独立 UIA 元素时
框到文字；像素法退居兜底。待用户实测验证。

### 11.8 微信会话列表识别不了 → 激活戳 + 钻取链路修复（2026-09-18）
**现象**：其他应用字段都能识别，唯独微信"未打开的会话"（会话列表行/消息气泡）只有整窗大框，而 Shotera 能框中。

**两层根因（缺一不可）**：
1. **微信侧按需树**：微信 4.x（Qt 5.15 自绘，顶层窗类 `Qt51514QWindowIcon`，渲染子窗 `MMUIRenderSubWindowHW`）
   默认只暴露"瘦身树"，检测到屏幕阅读器/无障碍客户端在线后才构建完整 UIA 树。Shotera 查询前走 MSAA
   通道（其导入表含 `AccessibleObjectFromWindow` = `WM_GETOBJECT`/`OBJID_CLIENT`）唤醒微信；我们纯 UIA
   查询不触发其检测。
2. **我们侧钻取断链（应用内真正的拦路虎）**：应用内点被自家全屏遮罩挡住，`ElementFromPoint` 命中自己后走
   `ElementFromHandle(目标窗)`+`drill_deepest_raw` 钻取。该路径此前对微信/部分 Electron **恒只返回窗级**：
   ① 微信（及部分 Electron）provider 对 `FindAllBuildCache(TreeScope_Children)` 返回空数组（托管 UIA 普通
   FindAll 同点可枚举 15 个 ListItem，树明明是满的）→ 钻取第一步就断；② 微信 HWND 根的第一个子元素即
   **全窗大小的 `MMUIRenderSubWindowHW` 遮罩 pane**（1314×1031，与真内容 Group 只差 1px²），
   "选最小面积含点子元素"在面积平局上钻进这个空子树卡死。此前探测器验证的 ListItem 走的是 EFP 直命中
   （无遮罩）路径，应用内根本不经过——验证无效。离线像素验证同时确认：微信白底+发丝分隔线场景像素检测
   给不出行级框（10×10 小块 → 直跳面板级），UIA 是唯一能出"行/气泡"粒度的通道。

**修复（smart_uia.cpp，全部通用逻辑非微信特判）**：
- `poke_accessibility(root)`：对目标根窗+前两层可见子窗（`MMUIRenderSubWindowHW`/`Chrome_RenderWidgetHostHWND`
  等渲染子窗类名优先，封顶 16）发 `WM_GETOBJECT` 双通道激活戳（`OBJID_CLIENT`+`UiaRootObjectId`），
  `SMTO_ABORTIFHUNG 60ms`；同窗 1.5s 节流；首戳后仅窗级时 `Sleep(140)` 同调用重查一次（每根窗一次）。
- `collect_raw_children`：`FindAllBuildCache` 产出为空 → 回退 **RawViewWalker 手动遍历**（Shotera 主路径）。
- `drill_deepest_raw`：候选按**缓存矩形面积**升序（rect 随过滤一次取回，排序零 COM 开销），**逐个递归**，
  空子树自动换下一候选；跳过遮罩类名（`MMUIRenderSubWindowHW`/`Chrome_RenderWidgetHostHWND`）；
  `g_drillBudget=250` 防巨型树（浏览器文档）爆炸。
- 调试设施：`SmartUiaProbeHwnd(hwnd,x,y,…)` 导出（绕 z 序直探指定窗的 poke+钻取路径）+
  `tools/uia_hwnd_probe.js`；`tools/uia_tree_dump.ps1`（托管 UIA 树转储）、`tools/uia_enum_test.ps1`
  （四种枚举方式对照）。教训：活桌面窗口遮挡会让一切"置顶+打点"验证失真，优先按 HWND/离线验证。

**遗留待验证**：微信多窗（主窗+弹出的聊天窗同名"Gentleman"）叠加时，未激活的弹窗树是否仍瘦——待用户实测。

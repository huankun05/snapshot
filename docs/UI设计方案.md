# UI 设计方案与产品命名

> 背景：独立应用化需要 ① 新名字（脱离 eIsland/Xiyue 附属感）② 整套 UI 设计语言
> （用户定调：简约美观，参考 Shotera）。本文给出命名（已定）、设计令牌、
> 各界面（工具栏/选区/取色/OCR 面板/贴图/设置/提示）的具体规格、图标系统与应用图标、
> P1 执行方案、分期计划。
> 参照：`Shotera竞品调研.md` §6（工具栏实拍盘点）；设置窗详设见 `设置面板设计.md`；
> 开发流程见 `工作规范.md`。
>
> 创建：2026-09-15 | 状态：设计已确认（§五 决策记录），P1 待开工

---

## 一、产品命名（已定：拾花 / PetalSnap，2026-09-15 用户拍板）

### 1.1 定名与释义
- **中文名「拾花」**（用户提议）：拾（拾取/截取）+ 花。「拾」正是截图这个动作的诗意说法；
  整个名字暗合「朝花夕拾」——截图就是**把刚出现的瞬间摘下来**。与「汐月」同属自然意象
  （汐月/拾花），家族感自然而不生硬；不直白说"截图"恰是留白，与简约气质一致。
- **英文名「PetalSnap」**（petal 花瓣 + snap 快照）：构词沿 Snipaste（snip+paste）、
  PixPin（pix+pin）的功能词缀传统，snap 是英文里最正的"截图"动词（Windows 自带工具即
  Snipping Tool）；已检索无同名截图产品（petalsnap.com 仅为一位设计师的个人作品集域名）。
- 备选（留档）：Pluck（单动词，与 Snip 同族，英文里有"拔毛/勇气"歧义）、PetalPin
  （花+贴图双核心，但 petal 不传达截取）、Snapbloom。

### 1.2 品牌语
- 中文定位语（About 页/README 首行）：**「拾花 —— 简约的 Windows 截图工具：截图 · 贴图 · 识别 · 翻译」**
- 英文 tagline：*Pluck blossoms from your screen.*

### 1.3 名称落地清单（P1 一次性 sweep）
| 位置 | 现值 → 改为 |
|---|---|
| `app/package.json` | name `eisland-screenshot` / productName `eIsland Screenshot` → `petalsnap` / `拾花 PetalSnap` |
| `app/main.ts` | `app.setName('eisland-screenshot')` → `petalsnap`；托盘 tooltip「拾花 PetalSnap」、控制台横幅 |
| userData 目录 | `%APPDATA%\eisland-screenshot` → `%APPDATA%\petalsnap`，**首启迁移**：旧目录存在则整体复制后切换（配置/热键/翻译凭据无损） |
| 窗口标题 | 设置窗「拾花 设置」；About 页 Logo + 拾花 + 版本徽章 |
| capture.js / pin.js i18n | 内联字典中出现的 eIsland 字样 |
| README.md | 标题「拾花 PetalSnap」+ 定位语重写 |
| 仓库/目录名 | `screenshot/` 目录与 github `snapshot` 仓库可保持不动（内部标识，非用户可见） |

---

## 二、设计语言：「白色亚克力 · Fluent 浅色」

### 2.1 现状诊断（为什么 Shotera 比我们好看）
我们现状是深色毛玻璃（`rgba(20,24,32,.82)` + blur24 + 白字 + 天蓝 #409cff），单论材质不差；
差距在**结构**：
1. 我们的工具栏是文字按钮 + select + 滑条混排一行（`capture.css:853`），宽窄不一、密度高；
   Shotera 是**统一 40px 纯图标方钮 + 分组分隔线**；
2. 我们把属性控件（粗细滑条、引擎下拉）和工具挤在同一行；Shotera 是**两级**：一级纯工具、
   二级上下文属性栏；
3. 我们的确认/取消是普通文字按钮；Shotera 是**红✕绿✓**双图标，状态语言一眼可读；
4. 表面：白色实底在截图内容上对比干脆；深色玻璃在浅色桌面上发灰、在深色桌面上消失。

### 2.2 决策：表面换浅色，结构抄 Shotera，玻璃工艺保留
- **表面**：白色亚克力（Fluent Acrylic）——`rgba(252,252,253,.9)` + 既有 `backdrop-filter:
  blur(24px) saturate(1.4)` 直接复用。既拿到 Shotera 的干净亮面，又保留我们已有的玻璃质感
  手艺（这是相对 Shotera 的差异化，不丢）。
- **深色主题**：不做（与设置面板设计一致，二期跟随系统）。
- **accent 从天蓝换成靛蓝** `#3D6BE5`：#409cff 在白底上对比度不足（文字/描边发飘），
  #3D6BE5 在白底与截图内容上均清晰，与 Shotera 观感同档。

### 2.3 设计令牌（capture.css / pin.css / settings.css 共用一套）
```css
:root {
  /* 表面 */
  --ui-surface:        rgba(252, 252, 253, .90);  /* 配 blur(24px) saturate(1.4) */
  --ui-surface-solid:  #FFFFFF;                    /* OCR 面板、色板弹层等不透明面 */
  --ui-surface-dim:    rgba(0, 0, 0, .28);         /* 截图蒙版（沿用现状） */
  --ui-border:         rgba(15, 23, 42, .10);
  --ui-border-soft:    rgba(15, 23, 42, .06);
  /* 文字 */
  --ui-text:      #1B1F27;
  --ui-text-2:    #6B7280;
  --ui-text-3:    #9AA1AC;   /* 说明/禁用 */
  /* 语义色 */
  --ui-accent:      #3D6BE5;  --ui-accent-soft:  #EAF0FF;
  --ui-danger:      #E5484D;  --ui-danger-soft:  #FDECEC;
  --ui-success:     #30A46C;  --ui-success-soft: #E8F6EF;
  --ui-warning-soft:#FFF6E0;
  /* 几何 */
  --ui-radius-lg: 12px;   /* 工具栏/面板 */
  --ui-radius-md: 8px;    /* 按钮/卡片 */
  --ui-shadow-float: 0 10px 32px rgba(15,23,42,.18), 0 2px 8px rgba(15,23,42,.08);
  --ui-shadow-pop:   0 4px 16px rgba(15,23,42,.14);
  --ui-font: "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif;
}
```
- 字号：正文 13px / 说明 12px / 尺寸标签与色号用 Consolas 等宽
- 动效：沿用现有入场 `cap-pop .18s cubic-bezier(.22,1,.36,1)`；按钮 hover 120ms；active scale(.96)

## 三、各界面规格

### 3.1 工具栏（核心重构，P2）
**一级栏**（白色亚克力胶囊，圆角 12，内边距 6，按钮 34×34）：

```
⠿ │ □↗ ✏ ▨ T │ 文A ⛶ │ 📌 │ ↶ ↷ ⬇ │ ✕ ✓
  └分隔  标注组    └分隔 AI组  └分隔 输出 └分隔 历史  └终止(红/绿)
```

| 组 | v1 内容 | 二期新增（对应借鉴清单） |
|---|---|---|
| 标注 | 形状（矩形，▾出变体：矩形/椭圆/直线）、箭头、画笔、马赛克、文字 | 荧光笔、自动序号、Emoji、局部放大、橡皮 |
| AI | 识别（⛶ 图标，主按钮执行「默认识别动作」设置，▾ 出表格/智能菜单）、翻译（文A） | — |
| 输出 | 贴图 📌、保存 ⬇（⇧ 点出另存/复制菜单） | — |
| 历史/终止 | 撤销、重做；**红✕（取消/退出）绿✓（确认/复制）** | — |

- 纯图标 + tooltip（中文名+快捷键），hover 底 `rgba(15,23,42,.06)`，激活态 accent-soft 底 +
  accent 图标；分隔线 1px `--ui-border-soft`
- **二级属性栏**（选中标注工具时在其下方浮出，同材质、高 40）：粗细滑条+数值、形状变体
  □/○/╱、填充/线框切换、双排色板（当前色描边圆环）+ 自定义色（开 3.3 取色面板）
- 位置：选区下方 8px 居中，越界自动翻转到上方；可拖动（六点把手，设置可关）

### 3.2 选区与蒙版
- 边框 1.5px accent，8 手柄（11px 白底方点 + accent 描边），四边中点可拉伸
- 尺寸标签：深色小胶囊 `rgba(15,23,42,.78)` 等宽白字（如 `1466 × 64`），悬于选区左上角外侧，
  避让屏幕边缘
- 蒙版维持 `rgba(0,0,0,.28)` 与「整屏一层暗」的既有实现（历史上闪黑问题的解法，不动）
- 悬停窗口高亮：accent 1.5px 描边 + 无填充（现状保留）；元素平滑跟随动画为二期开关项

### 3.3 取色
- **取色面板**（自定义色，v1 随二级栏上）：HSV 面积 + 色相条 + 透明度条（棋盘格）+
  HEXA 输入 + 16 预设格——规格同 Shotera §6.5
- **取色放大镜**（选区态按快捷键唤出，二期 P3）：Snipaste 式方形放大镜 + 十字线，下方
  坐标 + 色号，C 复制、Shift 切 HEX/RGB/HSV（借鉴清单 #17，替换现有色环）

### 3.4 OCR / 识别结果面板
- 白色实底卡（`--ui-surface-solid`，圆角 12，投影 pop），默认出现在选区下方，可拖
- 结构：顶部 tab（纯文本 / Markdown / 表格预览）+ 正文区（13px，Markdown 态渲染表格带边框）
  + 底部按钮行（复制、复制为 TSV/HTML、保存，icon+文字 12px）
- 「识别中」态：现有小胶囊 toast 保留（悬于选区上沿外，不遮挡原图），文案同现状

### 3.5 翻译浮层 / 贴图窗
- 翻译浮层：排版引擎不动（刚做过对齐升级），仅换 token（描边/阴影/accent）
- 贴图窗：现有缩放/拖动/尺寸标签保留；hover 浮出 **mini 工具条**（关闭/缩放 25-50-100%/-
  透明度滑条/置顶/销毁，34px 图标钮）为二期 P4；「可恢复贴图」随后端恢复栈一起上

### 3.6 设置窗
按 `设置面板设计.md` 执行，视觉 token 与本文 §2.3 对齐（那份文档里的 #3D6BE5/#F5F6F8 体系
即本文子集）；窗口标题「拾花 设置」。

## 四、分期（工作量粗估）

| 期 | 内容 | 规模 |
|---|---|---|
| **P1 打底** | 定名 sweep（§1.3）+ 令牌换肤 + 应用图标管线 | ~1 天 → **2026-09-16 代码完成，待用户实测（§八）** |
| **P2 设置窗** | 按 `设置面板设计.md`：**P2a 视觉稿（静态原型逐页截图确认）→ P2b 接线**（含识别性能三档、托盘「设置…」入口） | 视觉稿 0.5 天 + 接线 1.5~2 天 |
| **P3 工具栏重构** | icon 化 + 分组 + 二级属性栏 + 红绿终止键 + Lucide 图标库内联；**capture.js 6913 行内 UI/逻辑耦合，需配合工具链回归 + 实测清单**（十工具逐一绘制验证、长截图入口、OCR/翻译链路） | 2~3 天 |
| **P4 增强** | 荧光笔/序号/Emoji/局部放大/橡皮、取色放大镜替换色环、贴图 mini 工具条、OCR 面板 tab 改版 | 按借鉴清单优先级逐个 |
| **P5** | 深色主题（跟随系统）、元素跟随动画开关 | 二期 |

## 五、决策记录（2026-09-15 全部已定）

1. 名字 → 「拾花 PetalSnap」（§一）
2. 表面方向 → **白色亚克力**（§2.2）
3. accent → **#3D6BE5 靛蓝**（§2.3）
4. 图标库 → **Lucide 统一替换**（§六）
5. 应用图标 → 用户提供 1024 PNG 主稿，脚本派生全部尺寸（§七）

## 六、界面图标系统

### 6.1 现状与结论
`resources/svg/` 现有 27 个图标来自 iconfont 导出：**填充风格、硬编码 `fill="#ffffff"`**、
1024 viewBox、风格混杂（3 个描边 24 个填充）。换白色亚克力后白上白直接消失，
且 `<img src>` 方式无法继承颜色——**必须整套替换**，顺带统一风格。

### 6.2 方案：Lucide 内联子集
- 来源 Lucide（ISC 许可，可商用）；**只取用到的图标**，SVG path 抄进
  `resources/icons.js` 的字典（`ICONS = { crop: '<path d=…/>', … }`），三个页面共用
- 渲染：`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"
  stroke-linecap="round" stroke-linejoin="round">` + path；颜色随按钮 `color` 继承，
  激活/禁用态只改 CSS 变量
- 尺寸：工具栏按钮内 18px，设置导航 18px，行内/徽章 14~16px
- **Lucide 没有的画自定义**（同 24 网格、1.75 描边、圆头）：长截图、马赛克、噪点、PRO

### 6.3 旧图标 → Lucide 映射
| 旧（iconfont） | Lucide | 备注 |
|---|---|---|
| SELECT / CURSOR | `mouse-pointer-2` | |
| RECTANGLE / ELLIPSE / LINE | `square` / `circle` / `minus`（旋转 45°=`slash`） | 形状工具二级变体 |
| ARROW | `move-up-right` | |
| PAINTBRUSH | `pen-line` | 画笔 |
| TEXT | `type` | |
| MOSAIC / BLUR / NOISE / SOLID | 自绘马赛克 / `droplet`(模糊) / 自绘噪点 / `square`(填充) | 遮盖工具组 |
| PICKER | `pipette` | 取色 |
| OCR | `scan-text` | 识别 |
| TRANSLATION | `languages` | 翻译 |
| QR | `qr-code` | |
| PIN | `pin` | 贴图 |
| LONGSHOT | 自绘（长页 + 下箭头） | 长截图 |
| REC | `video` | 录屏 |
| COPY / SAVE | `copy` / `download` | |
| UNDO / REDO | `undo-2` / `redo-2` | |
| CANCEL / FINISH | `x` / `check` | 红✕绿✓ |
| MOVE | `grip-vertical` | 六点拖拽把手 |
| PRO | 自绘 | 暂留 |
| （新增）设置导航 | `settings` `crop` `scan-text` `languages` `info`（+二期 `pin` `download`） | |
| （新增）形状▾/菜单 | `chevron-down` | |

## 七、应用图标规格

### 7.1 用户提供什么（PNG 即可，不需要 SVG）
- **一张 1024×1024 透明背景 PNG 主稿**——全部尺寸由脚本派生，这是唯一必需项
- 可选加一张 **单色托盘字形**（同尺寸、纯白、透明底）：用于托盘"跟随系统"浅/深色任务栏
  自适应（Shotera 同款设置项）；不提供则由主稿 alpha 通道自动生成单色版
- SVG 可有可无：有则 About 页/设置窗 Logo 任意尺寸更锐利，没有用 256px PNG 也完全够

### 7.2 设计要求（为了 16px 托盘也能认）
- **单一强剪影**，一眼可辨；无细线、无文字、无渐变过多的小细节（16px 下全糊）
- 四周留 ≥8% 安全边距（Windows 会再套圆角/阴影）
- 配色 1~2 色为主：建议主色用产品 accent 靛蓝 `#3D6BE5`（可带一层浅→深渐变），
  花瓣可用浅色/白反衬；Win11 风可选圆角方形底板（圆角 ≈ 22%）
- 「拾花」意象建议：一片花瓣或简化五瓣花，可叠一个截图取景框角（□ 的一个角）点明用途；
  不必两者都上，剪影简洁优先

### 7.3 我这边派生（`tools/build_icons.py`，Pillow 用 venv_ocr 现成环境）
| 产物 | 尺寸 | 用途 |
|---|---|---|
| `resources/icon/app.ico` | 16/20/24/32/40/48/64/128/256 多尺寸 | 打包 exe、窗口图标、任务栏 |
| `resources/icon/tray.png` + `tray@2x.png` | 16 / 32 | 托盘（彩色） |
| `resources/icon/tray-mono.png` + `@2x` | 16 / 32 | 托盘单色（跟随系统） |
| `resources/icon/logo-256.png` | 256 | About 页、设置窗左上 |
- 图标未到位前用**程序化占位图标**（简单花瓣 SVG 渲染），P1 不被阻塞，主稿到了一键替换

## 八、P1 执行方案（定名 sweep + 换肤）—— 2026-09-16 完成并经用户实测确认

按 `工作规范.md` 九步全部走完；用户实测反馈"效果比原来进化挺多"，托盘图标方角问题已修（裁切后套圆角）。

**实际改动**（与原方案的差异用 ⚠ 标注）
1. 定名：`app/package.json`（name `petalsnap` / productName `拾花 PetalSnap`）、`app/main.ts`
   （setName、userData `%APPDATA%\petalsnap` + **旧目录 `eisland-screenshot` 首启 cpSync 迁移**、
   托盘 tooltip、日志横幅）、`capture.html`/`pin.html` `<title>`、`README.md` 头部。
   eIsland 的 GPL 版权头注释**保留**（许可合规，与产品名无关）
2. 令牌换肤：`capture.css` `:root` 保留 `--cap-*` 变量名只换值（白色亚克力 + #3d6be5），
   新增 `--cap-accent-soft` / `--cap-fill` / `--cap-fill-hover` / `--cap-fill-strong`；
   面板内约 60 处硬编码白色系逐处改为深色系或令牌；accent/红底上的白字显式声明 `color:#fff`。
   **刻意保留深色**的元素（压在截图/贴图内容之上，需要压住任意底色）：尺寸标签、顶部提示条、
   左下操作指引、翻译/识别进行中状态条、选区手柄、放大镜边框、文字编辑虚线框、`pin.css` 全部
3. ⚠ **图标改为滤镜翻转，Lucide 迁移整体推到 P3**：盘点发现 28 个工具栏图标全是
   `<img src="./svg/*.svg">` 靠 `filter: brightness(0) invert(1)` 刷白，pin 工具条也用同一套；
   只换 2 个会风格混杂，全换 28 个即 P3 工作量。P1 改为 `.capture-btn-icon` 用
   `brightness(0) opacity(.82)` 压深，激活/主按钮/红底内翻回白色。`resources/svg/` 因此保留
4. 应用图标：`tools/build_icons.py`（Pillow，主稿 → 圆角 22% 遮罩 → `app.ico` 9 尺寸 /
   `tray.png`+`@2x`（1.5× 紧凑取景）/ `logo-256.png`）；主稿 `resources/icon/petalsnap-master.png`
   来自用户提供的豆包生成水彩樱花（已裁去水印）。单色托盘字形未做（二期随「跟随系统」设置项）
5. 删除 `eisland_16x16.ico`；`resources/icon/_*.png` 预览产物与 `__pycache__` 进 .gitignore

**已验证**（2026-09-16）：构建通过；启动日志正常（拾花就绪 / Alt+Q 已注册 / userData 已切到
petalsnap 且旧配置 2 项迁移成功 / OCR 服务 DirectML 2.6s 就绪）；托盘 16/32px 目检可辨。
**待用户实测**：§四回归清单的截图 / 标注十工具 / 输出 / 识别 / 翻译各面在浅色主题下的可读性，
重点看工具栏图标深色是否清晰、激活态白图标、OCR 面板文字/表格/滚动条、下拉框选项。
**风险**：硬编码色分散，可能有漏改造成局部白上白——实测发现即补。

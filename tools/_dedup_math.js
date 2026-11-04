/*
 * 链内同区域去重 · 离线验证
 *
 * 背景（2026-11-05 用户报「同样的区域元素，同时存在于多个层级」）：
 * Chromium 的无障碍树会把**同一个区域**套成多层 role（Tree / Separator /
 * ProgressBar 盖在 ListItem 上），它们报的是**同一个矩形**。
 * 在「窗口级预览」的深度模型下，这会让**多个深度档位指向同一个框** ——
 * 滚轮按下去框纹丝不动，档位与视觉完全对不上。
 * 实测（微信会话窗）：链 19 项 → 去重后 9 档，**10 个档位是空转的**。
 *
 * 核心算法**不在这里重写** —— 从 resources/capture.js 的 DEDUP-CORE 标记块里
 * 抽出来直接跑（单一事实源：改了 capture.js 这里立刻跟着变）。
 *
 * 用法：
 *   node tools/_dedup_math.js --synthetic              # 只跑合成用例
 *   node tools/_dedup_math.js --chain _test/wechat_chain.json   # 真实链复算
 */
const fs = require('fs');
const path = require('path');

const CAPTURE_JS = path.join(__dirname, '..', 'resources', 'capture.js');

/** 从 capture.js 抽出 DEDUP-CORE 块并在当前作用域求值 */
function loadCore() {
  const src = fs.readFileSync(CAPTURE_JS, 'utf8');
  const a = src.indexOf('/* === DEDUP-CORE-START === */');
  const b = src.indexOf('/* === DEDUP-CORE-END === */');
  if (a < 0 || b < 0 || b <= a) throw new Error('capture.js 里找不到 DEDUP-CORE 标记块');
  const code = src.slice(a, b);
  const names = ['SMART_TYPE_RANK', 'SMART_WINDOW_EDGE_TOL'];
  const fns = ['smartSameRect', 'smartLevelScore', 'dedupeChainLevels', 'smartNearWindow', 'smartChainElements'];
  const f = new Function(code + `
    return { ${names.concat(fns).join(', ')} };
  `);
  return f();
}

const CORE = loadCore();

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  ← ' + detail : ''}`); }
}

/** 面积升序（线上链就是这个顺序） */
function byArea(a, b) { return (a.width * a.height) - (b.width * b.height); }

/** 链里是否还有「两档同矩形」 */
function hasDuplicateRect(list) {
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (CORE.smartSameRect(list[i], list[j])) return true;
    }
  }
  return false;
}

function fmt(lv) {
  return `${lv.controlType || '-'}${lv.name ? '「' + String(lv.name).slice(0, 10) + '」' : ''} ${lv.width}x${lv.height}`;
}

/* ── 合成用例 ─────────────────────────────────────────────────────── */
function synthetic() {
  console.log('\n── 合成用例 ──');

  // ① 微信式：同一区域被 Tree / Tree / ProgressBar 三个 role 覆盖
  {
    const list = [
      { x: 0, y: 0, width: 832, height: 381, controlType: 'Tree', name: '' },
      { x: 0, y: 0, width: 832, height: 381, controlType: 'Tree', name: '' },
      { x: 0, y: 0, width: 832, height: 381, controlType: 'ProgressBar', name: '消息' },
      { x: 0, y: 400, width: 832, height: 149, controlType: 'ListItem', name: '某条消息' },
    ];
    const out = CORE.dedupeChainLevels(list);
    check('① 同区域 3 个 role → 合并成 1 档', out.length === 2, `得到 ${out.length} 档`);
    check('① 合并后无重复矩形', !hasDuplicateRect(out));
    check('① 代表 = 有名字的那个（ProgressBar「消息」）',
      out[0].controlType === 'ProgressBar' && out[0].name === '消息', fmt(out[0]));
    check('① 位置不变（面积升序仍在）', out[1].controlType === 'ListItem');
  }

  // ② 不同区域不受影响
  {
    const list = [
      { x: 0, y: 0, width: 100, height: 20, controlType: 'Text', name: 'a' },
      { x: 0, y: 30, width: 300, height: 40, controlType: 'ListItem', name: 'b' },
      { x: 0, y: 90, width: 800, height: 600, controlType: 'Tree', name: '' },
    ];
    const out = CORE.dedupeChainLevels(list);
    check('② 三个不同区域 → 全部保留', out.length === 3, `得到 ${out.length} 档`);
    check('② 顺序保持面积升序', out[0].width * out[0].height < out[1].width * out[1].height
      && out[1].width * out[1].height < out[2].width * out[2].height);
  }

  // ③ ±1px 的取整误差也算同一区域
  {
    const list = [
      { x: 100, y: 200, width: 832, height: 381, controlType: 'Text', name: 'x' },
      { x: 101, y: 200, width: 832, height: 381, controlType: 'Tree', name: '' },
    ];
    const out = CORE.dedupeChainLevels(list);
    check('③ ±1px 取整误差 → 判为同一区域', out.length === 1, `得到 ${out.length} 档`);
  }

  // ④ 差 2px 的两个区域不合并（不能过度合并）
  {
    const list = [
      { x: 100, y: 200, width: 832, height: 381, controlType: 'Text', name: 'x' },
      { x: 102, y: 200, width: 832, height: 381, controlType: 'Tree', name: '' },
    ];
    const out = CORE.dedupeChainLevels(list);
    check('④ 差 2px → 不合并（避免过度合并）', out.length === 2, `得到 ${out.length} 档`);
  }

  // ⑤ 名字优先于类型具体度（放大镜那行要给用户认得出来的东西）
  {
    const list = [
      { x: 0, y: 0, width: 500, height: 300, controlType: 'Tree', name: '' },
      { x: 0, y: 0, width: 500, height: 300, controlType: 'ProgressBar', name: '聊天记录' },
    ];
    const out = CORE.dedupeChainLevels(list);
    check('⑤ 有名字的泛 role 胜过没名字的具体 role',
      out[0].name === '聊天记录', fmt(out[0]));
  }

  // ⑥ 窗口级与链内 Window 节点重复 → 元素让位给窗口级
  {
    const elems = [
      { x: 0, y: 0, width: 832, height: 149, controlType: 'ListItem', name: 'm' },
      { x: 0, y: 0, width: 1071, height: 654, controlType: 'Window', name: '微信' },
    ];
    const win = { x: 0, y: 0, width: 1071, height: 654, controlType: 'Window', name: '微信' };
    const r = CORE.smartChainElements(elems, win);
    check('⑥ 链内 Window 节点被剔除（窗口级独占一档）', r.list.length === 1, `剩 ${r.list.length} 项`);
    check('⑥ 剩下的是消息项', r.list[0].controlType === 'ListItem');
  }

  // ⑦ 窗口内容区（Windows 不可见缩放边框内缩 ~7px）→ 并入窗口级，不单独占一档
  {
    const elems = [
      { x: 0, y: 0, width: 832, height: 149, controlType: 'ListItem', name: 'm' },
      { x: 7, y: 3, width: 1057, height: 647, controlType: 'Control', name: 'MMUIRender' },
    ];
    const win = { x: 0, y: 0, width: 1071, height: 654, controlType: 'Window', name: '微信' };
    const r = CORE.smartChainElements(elems, win);
    check('⑦ 窗口内容区（每边差 7/3.5）并入窗口级', r.list.length === 1, `剩 ${r.list.length} 项`);
    check('⑦ 剩下的是消息项', r.list[0].controlType === 'ListItem');
  }

  // ⑧ 整宽标题栏（右边差得多）不被误并进窗口级
  {
    const elems = [
      { x: 0, y: 0, width: 1071, height: 30, controlType: 'ToolBar', name: '标题栏' },
      { x: 0, y: 40, width: 832, height: 149, controlType: 'ListItem', name: 'm' },
    ];
    const win = { x: 0, y: 0, width: 1071, height: 654, controlType: 'Window', name: '微信' };
    const r = CORE.smartChainElements(elems, win);
    check('⑧ 整宽标题栏不被并入窗口级', r.list.length === 2, `剩 ${r.list.length} 项`);
    check('⑧ 标题栏仍在链上', r.list.some((lv) => lv.controlType === 'ToolBar'));
  }
}

/* ── 真实链复算 ───────────────────────────────────────────────────── */
function realChain(file) {
  console.log(`\n── 真实链复算：${file} ──`);
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const picked = (d.picked || []).slice().sort(byArea);
  const win = d.win || null;

  console.log(`  原始链 ${picked.length} 项：`);
  picked.forEach((lv, i) => console.log(`    ${String(i).padStart(2)}  ${fmt(lv)}`));

  // 复刻线上 buildPreviewChain 的前置过滤 + 去重（**调用同一份实现**，不重写）
  const cleaned = CORE.smartChainElements(picked, win);
  const out = cleaned.list;
  const winIdx = win ? out.length : (out.length ? out.length - 1 : -1);
  const full = win ? out.concat([win]) : out;

  console.log(`\n  去重后 ${out.length} 档（+ 窗口级 = ${full.length} 档）：`);
  full.forEach((lv, i) => {
    const depth = winIdx >= 0 ? winIdx - i : i;
    const tag = win && i === winIdx ? '  ← 窗口级（默认预览）' : (depth >= 0 ? `  ← 深度 ${depth}` : '  ← 屏级');
    console.log(`    ${String(i).padStart(2)}  ${fmt(lv)}${tag}`);
  });

  check('真实链去重后无「两档同矩形」', !hasDuplicateRect(full));
  check('真实链档位数显著减少', out.length < picked.length, `${picked.length} → ${out.length}`);
  check('去重后每档都是不同的框（滚轮每按必变一次）', !hasDuplicateRect(full));
  // 窗口级与深度 1 不能是「同一个东西」（Windows 不可见缩放边框 ⇒ 内容区≈窗口）
  if (win && full.length > 1) {
    const d1 = full[full.length - 2];
    check('窗口级与深度 1 不是同一个区域（不可见边框不算一档）',
      !CORE.smartSameRect(d1, win) && !CORE.smartNearWindow(d1, win),
      `${fmt(d1)} vs ${fmt(win)}`);
  }
}

/* ── 入口 ─────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : null;
};
if (argv.includes('--synthetic')) synthetic();
const chain = arg('--chain');
if (chain) {
  if (!fs.existsSync(chain)) {
    console.error(`链文件不存在: ${chain}`);
    console.error('先用 tools/_chain_probe.js --dump <file> 抓一份真实链');
    process.exit(2);
  }
  realChain(chain);
}
if (!argv.includes('--synthetic') && !chain) {
  console.log('用法：node tools/_dedup_math.js --synthetic [--chain <真实链.json>]');
  process.exit(0);
}
console.log(`\n${fail ? '✗' : '✓'} PASS=${pass} FAIL=${fail}`);
process.exit(fail ? 1 : 0);

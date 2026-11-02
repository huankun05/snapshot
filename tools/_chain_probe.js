/*
 * 智能选框「链」双路对照探针
 *
 * 要回答的问题：同一点上，渲染端最终落笔的框为什么是「整棵 Tree 大框」而不是「行级框」？
 *
 * 两条出链的路（f1_worker.js）：
 *   EFP 路 → SmartUiaGetLevels(x,y)      = 光标处最深元素的**真祖先链**
 *   MAP 路 → SmartUiaSnapshot(x,y)       = 整窗元素表，worker 再用 pick() 取
 *                                           「所有矩形含光标点的元素」按面积升序
 * 渲染端 capture.js 再套一层「面积地板」（SMART_MIN_AUTO_AREA = 0.3% 屏）：
 *   自动落笔 = 链上第一个面积 ≥ 地板的元素；其后都是滚轮手动层。
 *
 * 已知病灶：链形如 [文本 159x19, 整棵 Tree 1808x1058] 时，地板把文本直接跳到
 * 整棵 Tree → 落笔框占屏 40% = 用户说的「识别不够准」。
 *
 * 用法：
 *   node tools/_chain_probe.js --list
 *   node tools/_chain_probe.js --win "<标题子串>" [--x N] [--y N]
 *   node tools/_chain_probe.js --x N --y N          # 不指定窗口，按光标点找顶层窗
 */
const path = require('path');
const koffi = require(process.env.KOFFI_PATH || 'F:/Work/Create/Assa/Xiyue/node_modules/koffi');
const lib = koffi.load(path.join(__dirname, '..', 'native', 'smart_uia', 'smart_uia.dll'));
const getLevels = lib.func('int SmartUiaGetLevels(int32_t physX, int32_t physY, char *outJson, int32_t outCap)');
const snapFn = lib.func('int SmartUiaSnapshot(int32_t physX, int32_t physY, char *outJson, int32_t outCap)');
const snapHwnd = lib.func('int SmartUiaSnapshotHwnd(int64_t hwnd, int32_t physX, int32_t physY, char *outJson, int32_t outCap)');

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? Number(argv[i + 1]) : dflt;
};
const flag = (name) => argv.includes(name);
const str = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : null;
};

// 窗口 CSS 尺寸（本机双屏 5120x1440 ÷ 主屏 dpr 1.25）——面积地板按这个算
const W = 4096, H = 1152;
const AREA_FLOOR_RATIO = 0.003;           // capture.js: SMART_MIN_AUTO_AREA
const areaFloor = W * H * AREA_FLOOR_RATIO;

// ── 枚举可见顶层窗（抄 screenshotHelper.ts 的 koffi EnumWindows 写法）──
function listWindows() {
  const u32 = koffi.load('user32.dll');
  koffi.struct('RECT_W', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
  const IsWindowVisible = u32.func('int IsWindowVisible(uint64_t hWnd)');
  const GetWindowRect = u32.func('int GetWindowRect(uint64_t hWnd, RECT_W *rect)');
  const GetWindowTextLengthW = u32.func('int GetWindowTextLengthW(uint64_t hWnd)');
  const GetWindowTextW = u32.func('int GetWindowTextW(uint64_t hWnd, uint16_t *buf, int max)');
  const EnumWindows = u32.func('int EnumWindows(void *lpEnumFunc, intptr_t lParam)');
  const cbType = koffi.pointer(koffi.proto('bool __stdcall (uint64_t, intptr_t)'));
  const out = [];
  const cb = koffi.register((h) => {
    try {
      if (!IsWindowVisible(h)) return true;
      const rbuf = Buffer.alloc(16);
      if (!GetWindowRect(h, rbuf)) return true;
      const left = rbuf.readInt32LE(0), top = rbuf.readInt32LE(4);
      const right = rbuf.readInt32LE(8), bottom = rbuf.readInt32LE(12);
      const len = GetWindowTextLengthW(h);
      let title = '';
      if (len > 0 && len < 512) {
        const b = Buffer.alloc((len + 1) * 2);
        GetWindowTextW(h, b, len + 1);
        title = b.toString('utf16le').replace(/\0+$/, '');
      }
      const w = right - left, ht = bottom - top;
      if (w < 80 || ht < 60) return true;
      if (!title) return true;
      out.push({ hwnd: h, title, x: left, y: top, w, h: ht });
    } catch (_) { /* ignore */ }
    return true;
  }, cbType);
  EnumWindows(cb, 0);
  koffi.unregister(cb);
  return out;
}

function readOut(call) {
  const buf = Buffer.alloc(262144);
  const t0 = process.hrtime.bigint();
  const n = call(buf);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (n <= 0) return { err: `n=${n}`, ms };
  try { return { json: JSON.parse(buf.toString('utf8', 0, n)), ms, n }; }
  catch (e) { return { err: 'json parse: ' + e.message, ms, n }; }
}

const inRect = (r, px, py, m) => px >= r.x - m && px <= r.x + r.width + m
  && py >= r.y - m && py <= r.y + r.height + m;

function report(tag, levels, win) {
  console.log(`\n── ${tag} ── chain=${levels.length}  win="${win || ''}"`);
  if (!levels.length) { console.log('   （空链）'); return null; }
  const floorIdx = (() => { const i = levels.findIndex((l) => l.width * l.height >= areaFloor); return i < 0 ? 0 : i; })();
  console.log(`   idx type        size        area     pct    name`);
  levels.forEach((l, i) => {
    const area = l.width * l.height;
    const mark = i === floorIdx ? '  <= auto[0] 渲染端落笔' : '';
    console.log('   ' + String(i).padEnd(3) + String(l.controlType || '-').padEnd(12)
      + `${l.width}x${l.height}`.padEnd(12) + String(Math.round(area)).padEnd(9)
      + ((area / (W * H) * 100).toFixed(2) + '%').padEnd(7)
      + String(l.name || '').slice(0, 28) + mark);
  });
  const a = levels[floorIdx], sm = levels[0];
  console.log(`   => 落笔框 ${a.width}x${a.height} (${(a.width * a.height / (W * H) * 100).toFixed(2)}% 屏)`
    + `  |  地板跳过 ${floorIdx} 层  |  最小→落笔 放大 ${(a.width * a.height / (sm.width * sm.height)).toFixed(1)}x`);
  return { applied: a, smallest: sm, floorIdx };
}

if (flag('--list')) {
  const ws = listWindows();
  console.log('idx hwnd      title / rect');
  ws.forEach((w, i) => console.log(String(i).padEnd(4) + String(w.hwnd).padEnd(11)
    + `"${w.title.slice(0, 40)}" @${w.x},${w.y} ${w.w}x${w.h}`));
  process.exit(0);
}

let x = arg('--x', null), y = arg('--y', null);
const winTitle = str('--win');
let hwnd = null;
if (winTitle) {
  const ws = listWindows();
  const hit = ws.find((w) => w.title.includes(winTitle));
  if (!hit) { console.log(`窗口未找到: "${winTitle}"`); process.exit(1); }
  hwnd = hit.hwnd;
  console.log(`目标窗 hwnd=${hwnd} "${hit.title}" @${hit.x},${hit.y} ${hit.w}x${hit.h}`);
  if (x === null) x = hit.x + Math.round(hit.w / 2);
  if (y === null) y = hit.y + Math.round(hit.h / 2);
}
if (x === null || y === null) { console.log('需要 --x/--y 或 --win'); process.exit(1); }
console.log(`探测点 物理=(${x},${y})  窗口CSS=${W}x${H}  面积地板=${Math.round(areaFloor)}px2 (${(AREA_FLOOR_RATIO * 100).toFixed(1)}%)`);

// ── EFP 路：SmartUiaGetLevels（真祖先链）──
const efp = readOut((buf) => getLevels(x, y, buf, 262144));
if (efp.err) console.log(`EFP 路失败: ${efp.err}`);
else {
  console.log(`EFP 路 ${efp.ms.toFixed(1)}ms ok=${efp.json.ok} src=${efp.json.diag ? JSON.stringify(efp.json.diag) : ''}`);
  report('EFP 路（SmartUiaGetLevels · 真祖先链）',
    (efp.json.levels || []).slice().sort((a, b) => a.width * a.height - b.width * b.height),
    efp.json.window && efp.json.window.name);
}

// ── MAP 路：SmartUiaSnapshot + worker pick() ──
const snap = readOut((buf) => (hwnd
  ? snapHwnd(hwnd, x, y, buf, 262144)
  : snapFn(x, y, buf, 262144)));
if (snap.err) console.log(`MAP 路失败: ${snap.err}`);
else {
  const j = snap.json;
  const items = j.items || [];
  const picked = items.filter((it) => inRect(it, x, y, 3))
    .sort((a, b) => (a.width * a.height) - (b.width * b.height));
  console.log(`MAP 路 ${snap.ms.toFixed(1)}ms items=${items.length} 含光标点=${picked.length} win="${j.window ? j.window.name : ''}"`);
  report('MAP 路（SmartUiaSnapshot + pick 几何集合）', picked, j.window && j.window.name);
}

// ── 全量 items 尺寸分布：看树里到底有没有中间层元素 ──
if (!snap.err) {
  const items = snap.json.items || [];
  const buckets = new Map();
  for (const it of items) {
    const a = it.width * it.height;
    const b = a >= 200000 ? '>=200k' : a >= 14156 ? '14k~200k(地板上)' : a >= 2000 ? '2k~14k(地板下)' : '<2k';
    buckets.set(b, (buckets.get(b) || 0) + 1);
  }
  console.log('\n── MAP 全量 items 面积分布（相对面积地板 14156）──');
  for (const [k, v] of buckets) console.log(`   ${k.padEnd(18)} ${v} 个`);

  // 细元素（地板下但够看的）长什么样、在哪 —— 判断「树够不够细」 vs 「光标落在空白处」
  const mid = items.filter((it) => it.width * it.height >= 2000 && it.width * it.height < 14156)
    .sort((a, b) => b.width * b.height - a.width * a.height);
  console.log(`\n── 细元素样本（面积 2k~14k，共 ${mid.length} 个；按面积降序取前 12）──`);
  console.log('   type        size        @x,y        name');
  for (const it of mid.slice(0, 12)) {
    console.log('   ' + String(it.controlType || '-').padEnd(12)
      + `${it.width}x${it.height}`.padEnd(12)
      + `@${it.x},${it.y}`.padEnd(13)
      + String(it.name || '').slice(0, 40));
  }
  if (mid.length) {
    const hit = mid.filter((it) => inRect(it, x, y, 3));
    console.log(`   其中含探测点(${x},${y})的: ${hit.length} 个`);
  }
}

/*
 * 像素收边 · 离线验证
 *
 * 目的：在**不动线上代码**的前提下，先证明「像素收边」这一步是对的：
 *   ① 真实场景：Edge 答题卡片的 ListItem 矩形比可见的白色编辑面板宽 31%
 *      → 收边后右边应当落到白色面板的右缘（截图 image x≈645）
 *   ② 反向回归：Explorer 风格的「整行同底色 + 左侧一个文件名」的行
 *      → **绝不能**被收成文字级小框（2026-10-27 用户骂的「框过小」）
 *
 * 核心算法**不在这里重写** —— 从 resources/capture.js 的 TRIM-CORE 标记块里
 * 抽出来直接跑（单一事实源：改了 capture.js 这里立刻跟着变）。
 *
 * 用法：
 *   node tools/_trim_math.js --frame _test/trim_frame.bin --spec _test/trim_frame.json
 *   node tools/_trim_math.js --synthetic          # 只跑合成用例（不需要图片）
 */
const fs = require('fs');
const path = require('path');

const CAPTURE_JS = path.join(__dirname, '..', 'resources', 'capture.js');

/** 从 capture.js 抽出 TRIM-CORE 块并在当前作用域求值 */
function loadCore() {
  const src = fs.readFileSync(CAPTURE_JS, 'utf8');
  const a = src.indexOf('/* === TRIM-CORE-START === */');
  const b = src.indexOf('/* === TRIM-CORE-END === */');
  if (a < 0 || b < 0 || b <= a) throw new Error('capture.js 里找不到 TRIM-CORE 标记块');
  const code = src.slice(a, b);
  // 核心块是纯计算（只用 Math / Float64Array），直接注入当前作用域
  const names = ['SMART_TRIM_T', 'SMART_TRIM_KEEP', 'SMART_TRIM_BAND', 'SMART_TRIM_GAP',
    'SMART_TRIM_SAMPLES', 'SMART_TRIM_MARGIN', 'SMART_TRIM_MAX_PX'];
  const fns = ['smartTrimSort', 'smartTrimColorDiff', 'smartTrimBandMedian',
    'smartTrimColumnProfile', 'smartTrimRowProfile', 'smartTrimScan', 'smartTrimCore'];
  const f = new Function(code + `
    return { ${names.concat(fns).join(', ')} };
  `);
  return f();
}

const CORE = loadCore();

function makeFrame(w, h, fill) {
  const data = new Uint8ClampedArray(w * h * 4);
  fill(data, w, h);
  return {
    w, h,
    read(x, y, rw, rh) {
      const out = new Uint8ClampedArray(rw * rh * 4);
      for (let j = 0; j < rh; j++) {
        const src = ((y + j) * w + x) * 4;
        out.set(data.subarray(src, src + rw * 4), j * rw * 4);
      }
      return { data: out, width: rw, height: rh };
    },
  };
}

function rect(x, y, w, h, color) {
  return { x, y, width: w, height: h, color };
}

function fillRect(data, w, x0, y0, x1, y1, c) {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * w + x) * 4;
      data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 合成用例
// ═══════════════════════════════════════════════════════════════════════════
const BG = [243, 244, 248];     // 页面底色（浅蓝灰）
const WHITE = [255, 255, 255];  // 白色编辑面板
const DARK = [40, 42, 46];      // 文字

function synthCard() {
  // 画布 600x400：白色面板 (60,50)-(380,350)，右侧 380..560 是页面底色（透明留白）
  const W = 600, H = 400;
  const frame = makeFrame(W, H, (d) => {
    fillRect(d, W, 0, 0, W, H, BG);
    fillRect(d, W, 60, 50, 380, 350, WHITE);
  });
  // 元素矩形 = 60..560 x 50..350（面板 + 右侧 180px 透明留白）
  const r = { x: 60, y: 50, width: 500, height: 300 };
  return { frame, rect: r, expect: { right: 380, left: 60, top: 50, bottom: 350 } };
}

function synthTextRow() {
  // Explorer 风格：一整行白底，左边一段文件名（深色字），行本身没有描边
  const W = 600, H = 60;
  const frame = makeFrame(W, H, (d) => {
    fillRect(d, W, 0, 0, W, H, WHITE);
    // 文件名块 20..160 x 20..40（占行高 1/3 ⇒ 不足以改变列中位色，但列内不平整）
    fillRect(d, W, 20, 20, 160, 40, DARK);
  });
  // 元素矩形 = 整行 0..600 x 10..50
  const r = { x: 0, y: 10, width: 600, height: 40 };
  return { frame, rect: r, expect: null }; // expect=null ⇒ 必须「不动」
}

function runCase(name, c, label) {
  const out = CORE.smartTrimCore(c.frame, c.rect, 1);
  const r = c.rect;
  console.log(`\n── ${name} ──`);
  console.log(`   输入 ${r.width}x${r.height}@${r.x},${r.y}`);
  if (!out) {
    console.log('   结果：不收边（返回 null）');
    if (c.expect) { console.log('   ✗ 期望收边到 ' + JSON.stringify(c.expect)); return false; }
    console.log('   ✓ 符合预期（不该收的一律不收）');
    return true;
  }
  const got = { left: out.left, top: out.top, right: out.right, bottom: out.bottom };
  console.log(`   结果 ${Math.round(got.right - got.left)}x${Math.round(got.bottom - got.top)}`
    + `@${Math.round(got.left)},${Math.round(got.top)}  (右边界 ${Math.round(got.right)})`);
  if (!c.expect) {
    console.log('   ✗ 期望「不收边」，但收成了 ' + JSON.stringify(got));
    return false;
  }
  let ok = true;
  for (const k of ['left', 'top', 'right', 'bottom']) {
    const d = Math.abs(got[k] - c.expect[k]);
    if (d > 2) { ok = false; console.log(`   ✗ ${k}: 得到 ${Math.round(got[k])} 期望 ${c.expect[k]}`); }
  }
  if (ok) console.log('   ✓ 符合预期');
  return ok;
}

// ═══════════════════════════════════════════════════════════════════════════
// 真实截图复算
// ═══════════════════════════════════════════════════════════════════════════
function runReal(specPath, binPath) {
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const buf = fs.readFileSync(binPath);
  const data = new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.byteLength);
  const frame = {
    w: spec.w, h: spec.h,
    read(x, y, rw, rh) {
      const out = new Uint8ClampedArray(rw * rh * 4);
      for (let j = 0; j < rh; j++) {
        const src = ((y + j) * spec.w + x) * 4;
        out.set(data.subarray(src, src + rw * 4), j * rw * 4);
      }
      return { data: out, width: rw, height: rh };
    },
  };
  console.log('\n── 真实截图复算 ──');
  console.log(`   帧 ${spec.w}x${spec.h}  元素矩形 ${spec.rect.width}x${spec.rect.height}@${spec.rect.x},${spec.rect.y}`);
  const t0 = Date.now();
  const out = CORE.smartTrimCore(frame, spec.rect, spec.sf || 1);
  const ms = Date.now() - t0;
  if (!out) {
    console.log('   结果：不收边');
    return spec.expectNoTrim !== false;
  }
  console.log(`   结果 ${Math.round(out.right - out.left)}x${Math.round(out.bottom - out.top)}`
    + `@${Math.round(out.left)},${Math.round(out.top)}  (${ms}ms)`);
  console.log(`   四边：left ${Math.round(out.left)} top ${Math.round(out.top)}`
    + ` right ${Math.round(out.right)} bottom ${Math.round(out.bottom)}`);
  if (spec.expect) {
    let ok = true;
    for (const k of ['left', 'top', 'right', 'bottom']) {
      const d = Math.abs(out[k] - spec.expect[k]);
      const tag = d <= 4 ? '✓' : '✗';
      if (d > 4) ok = false;
      console.log(`   ${tag} ${k}: 得到 ${Math.round(out[k])} 期望 ${spec.expect[k]}（差 ${Math.round(d)}）`);
    }
    return ok;
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// 回归守卫：收边必须是「元素的函数」，不能是「光标的函数」
// ═══════════════════════════════════════════════════════════════════════════
/**
 * 2026-11-05 用户实测报障：「同样的区域元素，同时存在于多个层级」——定位到
 * **像素收边的光标护栏**：像素分析按元素矩形缓存（稳定），但那条护栏在缓存
 * **之外每帧重算** ⇒ 同一个元素的框宽随光标跨过被裁边界而翻转
 * （实测微信 ListItem 832x149 ⇄ 810x149 来回跳）。
 * ⇒ 护栏整条删除。这里用**静态检查**把这条纪律钉死：收边函数里不允许再出现
 * 光标坐标参数（curX/curY/refX/refY/pendingMouse）。
 */
function checkTrimIsCursorFree() {
  const src = fs.readFileSync(CAPTURE_JS, 'utf8');
  const a = src.indexOf('function trimRectToContent');
  if (a < 0) { console.log('✗ capture.js 里找不到 trimRectToContent'); return false; }
  const b = src.indexOf('\n}', a);
  const body = src.slice(a, b);
  const bad = ['curX', 'curY', 'refX', 'refY', 'pendingMouseX', 'pendingMouseY']
    .filter((k) => body.includes(k));
  if (bad.length) {
    console.log('✗ 收边函数又引用了光标坐标：' + bad.join(', '));
    console.log('   ⇒ 框会随光标位置变（同一元素两种框宽）＝ 抖动。收边必须只依赖元素与帧。');
    return false;
  }
  console.log('✓ 收边函数不含光标坐标（框 = 元素的函数 ⇒ 同一元素恒定，不抖）');
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);

let allOk = true;
console.log('=== 回归守卫 ===');
allOk = checkTrimIsCursorFree() && allOk;
if (has('--synthetic') || !arg('--frame')) {
  console.log('\n=== 合成用例 ===');
  allOk = runCase('用例①：白色卡片 + 右侧透明留白（应收到面板右缘）', synthCard()) && allOk;
  allOk = runCase('用例②：Explorer 风格整行 + 左侧文件名（**不得**收成文字级小框）', synthTextRow()) && allOk;
}
if (arg('--frame')) {
  allOk = runReal(arg('--spec'), arg('--frame')) && allOk;
}
console.log('\n' + (allOk ? 'RESULT: ALL PASS' : 'RESULT: FAIL'));
process.exit(allOk ? 0 : 1);

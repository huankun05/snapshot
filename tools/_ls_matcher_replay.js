/* r52 匹配器真实帧回放回归：
 * 把 17:31 会话（ls_1788946273508，深色聊天窗）的落盘帧 f0002~f0007 逐对喂进
 * 从 capture.js 提取的生产版 lsMatchScroll，断言匹配结果等于 SSD 真值
 * （210/170/135/135/50），且不再落入当时的假谷（488/497/372/478）。
 * 用法: node _ls_matcher_replay.js  */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'capture.js'), 'utf8');
const framesDir = path.join(__dirname, '..', 'frames');

function extractFn(name) {
  let idx = src.indexOf(`async function ${name}`);
  if (idx < 0) idx = src.indexOf(`function ${name}`);
  if (idx < 0) throw new Error(`fn not found: ${name}`);
  let depth = 0, opened = false;
  for (let j = src.indexOf('{', idx); j < src.length; j++) {
    if (src[j] === '{') { depth++; opened = true; }
    else if (src[j] === '}') { depth--; if (opened && depth === 0) return src.slice(idx, j + 1); }
  }
  throw new Error('unbalanced braces');
}

/** 真值来自 OCR/verify_ls_truth.py 对各会话的全列 SSD 扫描 + delta 系数链（5px/unit）反推 */
const SESSIONS = [
  {
    id: '1788946273508 (深色聊天，17:31 错拼会话)',
    prefix: 'f',
    pairs: [
      { pair: 'f0002->f0003', a: 'f0002', b: 'f0003', expect: 210 },
      { pair: 'f0003->f0004', a: 'f0003', b: 'f0004', expect: 170 }, // 系数链 34delta*5；此前 498 为背景假谷
      { pair: 'f0004->f0005', a: 'f0004', b: 'f0005', expect: 135 },
      { pair: 'f0005->f0006', a: 'f0005', b: 'f0006', expect: 135 },
      { pair: 'f0006->f0007', a: 'f0006', b: 'f0007', expect: 50 },  // 此前 478 为假谷
    ],
    forbidden: [372, 478, 488, 497, 505],
  },
  {
    id: '1788940071796 (浅色聊天，15:47 正确会话——防修复回归)',
    prefix: 'ls2_f',
    pairs: [
      { pair: 'ls2_f0002->ls2_f0003', a: 'ls2_f0002', b: 'ls2_f0003', expect: 260 },
      { pair: 'ls2_f0003->ls2_f0004', a: 'ls2_f0003', b: 'ls2_f0004', expect: 260 },
      { pair: 'ls2_f0004->ls2_f0005', a: 'ls2_f0004', b: 'ls2_f0005', expect: 260 },
      { pair: 'ls2_f0005->ls2_f0006', a: 'ls2_f0005', b: 'ls2_f0006', expect: 260 },
    ],
    forbidden: [],
  },
  {
    id: '1788966609038 (深色对话流，23:10 错拼会话——r58 引入的周期假谷回归)',
    prefix: 'ls3_f',
    pairs: [
      // f2->f3 眬值 140（err=0）；当时错误接受 585（23 行重复头像伪谷）→ 内容周期重复
      { pair: 'ls3_f0002->ls3_f0003', a: 'ls3_f0002', b: 'ls3_f0003', expect: 140 },
      // f3->f4 眬值 90（err=0）；次谷 616/618 err 233
      { pair: 'ls3_f0003->ls3_f0004', a: 'ls3_f0003', b: 'ls3_f0004', expect: 90 },
      // f4->f5 眬值 90(0)；654(1) 为次谷
      { pair: 'ls3_f0004->ls3_f0005', a: 'ls3_f0004', b: 'ls3_f0005', expect: 90 },
      // f5->f6 眬值 90(0)；660(11) 次谷
      { pair: 'ls3_f0005->ls3_f0006', a: 'ls3_f0005', b: 'ls3_f0006', expect: 90 },
      // f6->f7 眬值 90(2)
      { pair: 'ls3_f0006->ls3_f0007', a: 'ls3_f0006', b: 'ls3_f0007', expect: 90 },
    ],
    forbidden: [484, 521, 576, 590, 616, 630], // 当时错误接受的周期假谷
  },
];

class FakeCanvas {
  constructor(binPath, w, h) {
    this.buf = new Uint8ClampedArray(fs.readFileSync(binPath));
    this.width = w; this.height = h;
  }
  getContext() {
    const self = this;
    return {
      getImageData(x, y, sw, sh) {
        const out = new Uint8ClampedArray(sw * sh * 4);
        for (let r = 0; r < sh; r++) {
          const srcOff = ((y + r) * self.width + x) * 4;
          out.set(self.buf.subarray(srcOff, srcOff + sw * 4), r * sw * 4);
        }
        return { data: out, width: sw, height: sh };
      },
    };
  }
}

(async () => {
  const meta = JSON.parse(fs.readFileSync(path.join(framesDir, 'meta.json'), 'utf8'));
  const frames = {};
  for (const [name, [w, h]] of Object.entries(meta)) frames[name] = new FakeCanvas(path.join(framesDir, name + '.bin'), w, h);

  const sb = {
    console: { error: () => { }, log: () => { } },
    Date: { now: () => 1788946273508 },
    Math, Promise, Float32Array, Infinity, Uint8Array, Uint8ClampedArray,
    lsAccum: null, lsPrevGray: null, lsLastFrameDiff: 0, lsFrameDiffAccum: 0,
    lsLiveLast: 0, lsStartT: 1788946273508, lsRejectStreak: 0, lsLastMatchRatio: 1,
    lsLastGoodS: 0, lsAcceptCount: 0, lsMatchSrc: '', lsFrameIsGdi: true,
    lsAutoScrollActive: true, lsAutoTargetFrac: 0.65,
    lsDiagDue: () => false,
    lsDebugDump: () => { },
  };
  vm.createContext(sb);
  vm.runInContext(extractFn('lsMatchScroll') + '\nthis.lsMatchScroll = lsMatchScroll;', sb);

  let pass = 0, fail = 0;
  const assert = (cond, msg) => { if (cond) { pass++; console.log(`  ok ${msg}`); } else { fail++; console.error(`  FAIL ${msg}`); } };

  for (const sess of SESSIONS) {
    console.log(`== 会话 ${sess.id} ==`);
    // 忠实模拟真实会话边界：startLongScreenshot 每次会话都重置匹配器状态（capture.js L4191）
    sb.lsLastGoodS = 0; sb.lsAcceptCount = 0; sb.lsRejectStreak = 0;
    sb.lsPrevGray = null; sb.lsLastFrameDiff = 0; sb.lsLastMatchRatio = 1;
    // 预置 prevGray：真实会话中匹配器只在种子帧之后被调用（种子帧已设置 lsPrevGray），
    // 若不预置，fdiff=0 + e0<2500 会被 static-gdi 误判为静止帧跳过（harness 伪影）。
    // 用参考帧 a 的灰度作 prevGray（等价于"上一帧就是它"）。
    const pre = frames[sess.pairs[0].a];
    {
      const w = pre.width, h = pre.height;
      const stepX = Math.max(1, Math.floor(w / 160));
      const colCount = Math.floor((w - 1) / stepX) + 1;
      const d = pre.getContext('2d').getImageData(0, 0, w, h).data;
      const g = new Float32Array(h * colCount);
      for (let r = 0; r < h; r++) { const base = r * w;
        for (let ci = 0, x = 0; ci < colCount; ci++, x += stepX) { const i = (base + x) * 4; g[r * colCount + ci] = (d[i] * 114 + d[i + 1] * 587 + d[i + 2] * 299) / 1000; } }
      sb.lsPrevGray = g;
    }
    for (const { pair, a, b, expect } of sess.pairs) {
      sb.lsAccum = frames[a];         // 参考图（救援模式语义：refCanvas=上一帧）
      sb.lsFrameIsGdi = true;
      const t0 = Date.now();
      const s = await Promise.race([
        Promise.resolve(sb.lsMatchScroll(frames[b], frames[a])),
        new Promise((_, rej) => setTimeout(() => rej(new Error('match timeout')), 30000)),
      ]);
      const ms = Date.now() - t0;
      const ok = typeof s === 'number' && Math.abs(s - expect) <= 2;
      assert(ok, `${pair}: 位移 ${s} ≈ 真值 ${expect} (${ms}ms)${ok ? '' : '  <-- 偏差'}`);
      assert(!(typeof s === 'number' && sess.forbidden.some((f) => Math.abs(s - f) <= 2)), `${pair}: 未落入历史假谷`);
      assert(ms < 500, `${pair}: 单次匹配耗时 ${ms}ms < 500ms`);
    }
  }

  console.log(`\n结果: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('REPLAY ERROR', e); process.exit(2); });

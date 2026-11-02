// 「闪亮」修复的数学验证（2026-11-02）
//
// 验证对象：capture.js `startHoverSmoothLoop` 里 `hoverSizeJump` 分支的面积匀速解算器。
//   目标：解出 g 使 (w0+Δw·g)(h0+Δh·g) = a0+(a1-a0)·e
//        → 面积随时间线性（亮度匀速铺开），而 w/h 仍沿线性混合走
//
// 判据：
//   ① 两端精确命中：e=0 → g=0 → 尺寸 == from；e=1 → g=1 → 尺寸 == to
//   ② 中间态面积线性：|area(e) - (a0+(a1-a0)e)| / 屏面积 极小
//   ③ g 始终落在 [0,1]（不越界 → 尺寸不会冲出目标框）
//   ④ 对照：旧口径（线性尺寸插值）的面积偏差量级 → 证明修复确实改变了曲线
//
// 用法：node tools/_morph_math.js
const SCREEN_CSS = 2048 * 1152;   // 副屏 CSS 尺寸（与线上 SMART-MORPH 的 W/H 同源）
const VIRTUAL_CSS = 4096 * 1152;  // 虚拟桌面 CSS（画布跨双屏）

// ── 与线上逐字对应的解算器（照抄 capture.js 的分支逻辑）──
function solveG(w0, h0, w1, h1, e) {
  const a0 = w0 * h0, a1 = w1 * h1;
  const aT = a0 + (a1 - a0) * e;
  const A = (w1 - w0) * (h1 - h0);
  const B = w0 * (h1 - h0) + h0 * (w1 - w0);
  const C = a0 - aT;
  let g = e;
  if (Math.abs(A) < 1e-6) {
    if (Math.abs(B) > 1e-6) { const gg = -C / B; if (gg >= -1e-6 && gg <= 1 + 1e-6) g = gg; }
  } else {
    const disc = B * B - 4 * A * C;
    if (disc >= 0) {
      const s = Math.sqrt(disc);
      const g1 = (-B + s) / (2 * A), g2 = (-B - s) / (2 * A);
      const cand = [g1, g2].filter((v) => v >= -1e-6 && v <= 1 + 1e-6);
      if (cand.length) g = cand.reduce((best, v) => (Math.abs(v - e) < Math.abs(best - e) ? v : best), cand[0]);
    }
  }
  return { g, w: w0 + (w1 - w0) * g, h: h0 + (h1 - h0) * g, aT };
}

// ── 旧口径：线性尺寸插值（负向对照）──
function oldRect(w0, h0, w1, h1, e) {
  return { w: w0 + (w1 - w0) * e, h: h0 + (h1 - h0) * e };
}

const CASES = [
  { name: '用户实测场景：文件行 → 空白面板', w0: 810, h0: 30, w1: 1535, h1: 806 },
  { name: '线上实测场景：整屏兜底 → 小元素', w0: 2048, h0: 1152, w1: 126, h1: 141 },
  { name: '线上实测场景：小元素 → 整屏兜底', w0: 126, h0: 141, w1: 2048, h1: 1152 },
  { name: '只变宽（等高）', w0: 200, h0: 40, w1: 1400, h1: 40 },
  { name: '只变高（等宽）', w0: 200, h0: 40, w1: 200, h1: 1200 },
];

let fail = 0;
for (const c of CASES) {
  const a0 = c.w0 * c.h0, a1 = c.w1 * c.h1;
  console.log(`\n── ${c.name}  ${c.w0}x${c.h0} (${(a0 / VIRTUAL_CSS * 100).toFixed(2)}%) → ${c.w1}x${c.h1} (${(a1 / VIRTUAL_CSS * 100).toFixed(2)}%)`);
  let maxDevNew = 0, maxDevOld = 0, minG = 1, maxG = 0, endpointOk = true, gNonFinite = false;
  for (let i = 0; i <= 20; i++) {
    const e = i / 20;
    const s = solveG(c.w0, c.h0, c.w1, c.h1, e);
    if (!isFinite(s.g)) gNonFinite = true;
    minG = Math.min(minG, s.g); maxG = Math.max(maxG, s.g);
    const area = s.w * s.h;
    const devNew = Math.abs(area - s.aT) / VIRTUAL_CSS * 100;   // 与「面积线性目标」的偏差（百分点）
    maxDevNew = Math.max(maxDevNew, devNew);
    const o = oldRect(c.w0, c.h0, c.w1, c.h1, e);
    const devOld = Math.abs(o.w * o.h - s.aT) / VIRTUAL_CSS * 100;
    maxDevOld = Math.max(maxDevOld, devOld);
    if (i === 0 && (Math.abs(s.w - c.w0) > 1e-6 || Math.abs(s.h - c.h0) > 1e-6)) endpointOk = false;
    if (i === 20 && (Math.abs(s.w - c.w1) > 1e-6 || Math.abs(s.h - c.h1) > 1e-6)) endpointOk = false;
  }
  const ok = endpointOk && minG >= -1e-6 && maxG <= 1 + 1e-6 && !gNonFinite && maxDevNew < 0.05;
  if (!ok) fail++;
  console.log(`   g 范围=[${minG.toFixed(4)}, ${maxG.toFixed(4)}]  两端命中=${endpointOk ? 'OK' : 'FAIL'}  g 有限=${!gNonFinite}`);
  console.log(`   新口径面积偏差(最大)=${maxDevNew.toFixed(4)}pp   旧口径面积偏差(最大)=${maxDevOld.toFixed(2)}pp   偏差减少 ${(maxDevOld - maxDevNew).toFixed(2)}pp`);
  console.log(`   结论: ${ok ? 'PASS' : 'FAIL'}`);
}

// ── 峰值亮度速率（px²/ms）：线性尺寸插值 vs 面积匀速 ──
console.log('\n── 峰值亮度速率对比（dur=260ms）──');
{
  const { w0, h0, w1, h1 } = CASES[0];
  const dur = 260;
  const steps = 260;
  const stepMs = dur / steps;          // 每步代表的毫秒数（用于算 px²/ms 的瞬时速率）
  let peakNew = 0, peakOld = 0;
  let prevNew = w0 * h0, prevOld = w0 * h0;
  for (let i = 1; i <= steps; i++) {
    const e = i / steps;
    const s = solveG(w0, h0, w1, h1, e);
    const o = oldRect(w0, h0, w1, h1, e);
    const rateNew = Math.abs(s.w * s.h - prevNew) / stepMs;
    const rateOld = Math.abs(o.w * o.h - prevOld) / stepMs;
    peakNew = Math.max(peakNew, rateNew); peakOld = Math.max(peakOld, rateOld);
    prevNew = s.w * s.h; prevOld = o.w * o.h;
  }
  console.log(`   旧口径峰值=${peakOld.toFixed(0)} px²/ms   新口径峰值=${peakNew.toFixed(0)} px²/ms   降幅=${((1 - peakNew / peakOld) * 100).toFixed(0)}%`);
  // 匀速解的速率应处处相同（面积线性）→ 峰值≈平均
  const avg = Math.abs(w1 * h1 - w0 * h0) / dur;
  console.log(`   新口径平均速率=${avg.toFixed(0)} px²/ms（峰值/平均=${(peakNew / avg).toFixed(2)}，越接近 1 越匀速）`);
  console.log(`   旧口径峰值/平均=${(peakOld / avg).toFixed(2)}`);
}

console.log(fail === 0 ? '\n全部用例 PASS' : `\n${fail} 个用例 FAIL`);
process.exit(fail === 0 ? 0 : 1);

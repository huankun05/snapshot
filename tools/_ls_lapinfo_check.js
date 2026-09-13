/* r54 lsLapVarInfo（内容归一化清晰度）单元测试：
 * 从 capture.js 提取生产源码，合成 canvas 验证：
 * 1) 纯背景帧返回 0（无法量化，不参与 EMA）
 * 2) 文字模糊可被检测（模糊帧 lap 显著低于锐利帧）
 * 3) 内容归一化：文字行占比 10% vs 50% 的锐利帧，整帧 lap 相差数倍，而 info-lap 接近
 * 用法: node _ls_lapinfo_check.js  */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'capture.js'), 'utf8');
function extractFn(name) {
  let idx = src.indexOf(`async function ${name}`);
  if (idx < 0) idx = src.indexOf(`function ${name}`);
  let depth = 0, opened = false;
  for (let j = src.indexOf('{', idx); j < src.length; j++) {
    if (src[j] === '{') { depth++; opened = true; }
    else if (src[j] === '}') { depth--; if (opened && depth === 0) return src.slice(idx, j + 1); }
  }
}

function makeCanvas(w, h, grayFn) {
  const buf = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const g = grayFn(x, y), i = (y * w + x) * 4;
    buf[i] = g; buf[i + 1] = g; buf[i + 2] = g; buf[i + 3] = 255;
  }
  return { width: w, height: h, getContext: () => ({ getImageData: (x, y, sw, sh) => ({ data: buf, width: sw, height: sh }) }) };
}
// 文字行纹理：4px 周期的硬边条纹（锐利）
const sharpText = (x, y) => (y >= 50 && y <= 60) || (y >= 150 && y <= 160) ? (((x >> 2) & 1) ? 220 : 30) : 240;
// 同布局但文字行占比 5 倍
const sharpDense = (x, y) => (y % 40 < 12) ? (((x >> 2) & 1) ? 220 : 30) : 240;
// 模糊版：条纹改 16px 周期 + 中间 6px 线性过渡（软边）
const blurText = (x, y) => {
  if (!((y >= 50 && y <= 60) || (y >= 150 && y <= 160))) return 240;
  const p = x % 16;
  if (p < 5) return 30;
  if (p < 11) return 30 + (p - 5) * (190 / 6);
  return 220;
};

(async () => {
  const sb = { console, Math, Float32Array, Uint8Array };
  vm.createContext(sb);
  vm.runInContext(extractFn('lsLapVar') + '\n' + extractFn('lsLapVarInfo') + '\nthis.lap = lsLapVar; this.info = lsLapVarInfo;', sb);

  let pass = 0, fail = 0;
  const assert = (cond, msg) => { if (cond) { pass++; console.log(`  ok ${msg}`); } else { fail++; console.error(`  FAIL ${msg}`); } };

  const flat = makeCanvas(400, 300, () => 240);
  assert(sb.info(flat) === 0, `纯背景帧 info=0（实际 ${sb.info(flat)}）`);

  const s = makeCanvas(400, 300, sharpText);
  const bl = makeCanvas(400, 300, blurText);
  const lapS = sb.info(s), lapB = sb.info(bl);
  assert(lapS > 0 && lapB > 0, `锐利/模糊文字都可量化（${lapS.toFixed(0)} / ${lapB.toFixed(0)}）`);
  assert(lapS / lapB >= 2, `模糊可检测：锐利/模糊 lap 比 ${ (lapS / lapB).toFixed(1) } >= 2`);
  const wholeS = sb.lap(s), wholeB = sb.lap(bl);
  console.log(`  [对照] 整帧 lap: 锐利 ${wholeS.toFixed(0)} vs 模糊 ${wholeB.toFixed(0)}（比 ${(wholeS / wholeB).toFixed(1)}）`);

  const sparse = makeCanvas(400, 300, sharpText);
  const dense = makeCanvas(400, 300, sharpDense);
  const i1 = sb.info(sparse), i2 = sb.info(dense);
  const w1 = sb.lap(sparse), w2 = sb.lap(dense);
  console.log(`  [对照] 整帧 lap 稀疏 ${w1.toFixed(0)} vs 密集 ${w2.toFixed(0)}（比 ${(w2 / w1).toFixed(1)}×） info: ${i1.toFixed(0)} vs ${i2.toFixed(0)}（比 ${(i2 / i1).toFixed(2)}×）`);
  assert(Math.max(i1, i2) / Math.min(i1, i2) <= 1.6, `info-lap 内容归一化：疏密比 ${(Math.max(i1, i2) / Math.min(i1, i2)).toFixed(2)} <= 1.6`);
  assert(w2 / w1 >= 2, `整帧 lap 确实被占比稀释（${(w2 / w1).toFixed(1)}× >= 2，证明旧口径的问题）`);

  console.log(`\n结果: ${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(2); });

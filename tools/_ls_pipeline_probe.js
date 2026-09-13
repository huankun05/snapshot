/* 探针：复现 r52 lsMatchScroll 的采样管线（gf/ga 160列、gfR/gaR 401列、gaRowInf、加权 evalS），
 * 打印 f6→f7 / f4→f5 在真值与误选偏移附近的粗搜曲线、谷列表与 evalR，定位 50/135 落选环节。 */
'use strict';
const fs = require('fs');
const path = require('path');
const framesDir = path.join(__dirname, '_replay_frames');
const meta = JSON.parse(fs.readFileSync(path.join(framesDir, 'meta.json'), 'utf8'));

function load(name) {
  const [w, h] = meta[name];
  const buf = new Uint8ClampedArray(fs.readFileSync(path.join(framesDir, name + '.bin')));
  return { buf, w, h };
}
function sampled(data, w, rowStart, rows, stepX) {
  const colCount = Math.floor((w - 1) / stepX) + 1;
  const out = new Float32Array(rows * colCount);
  for (let r = 0; r < rows; r++) {
    const base = (rowStart + r) * w;
    for (let ci = 0, x = 0; ci < colCount; ci++, x += stepX) {
      const i = (base + x) * 4;
      out[r * colCount + ci] = (data[i] * 114 + data[i + 1] * 587 + data[i + 2] * 299) / 1000;
    }
  }
  return out;
}
function probe(nameA, nameB, targets) {
  const a = load(nameA), b = load(nameB);
  const w = a.w, fh = a.h, ah = a.h;
  const stepX = Math.max(1, Math.floor(w / 160));
  const colCount = Math.floor((w - 1) / stepX) + 1;
  const gf = sampled(b.buf, w, 0, fh, stepX);
  const ga = sampled(a.buf, w, ah - fh, fh, stepX);
  const stepR = 4;
  const colsR = Math.floor((w - 1) / stepR) + 1;
  const gaR = sampled(a.buf, w, ah - fh, fh, stepR);
  const gfR = sampled(b.buf, w, 0, fh, stepR);
  const gaRowInf = new Uint8Array(fh);
  for (let r = 0; r < fh; r++) {
    let sum = 0, sum2 = 0;
    for (let ci = 0; ci < colsR; ci++) { const v = gaR[r * colsR + ci]; sum += v; sum2 += v * v; }
    gaRowInf[r] = (sum2 / colsR - (sum / colsR) ** 2) >= 64 ? 1 : 0;
  }
  const evalS = (s) => {
    const rows = fh - s;
    if (rows < 8) return Infinity;
    let err = 0, n = 0;
    for (let r = 0; r < rows; r++) {
      if (!gaRowInf[s + r]) continue;
      const gi = (s + r) * colCount, fi = r * colCount;
      for (let ci = 0; ci < colCount; ci++) { const d = gf[fi + ci] - ga[gi + ci]; err += d * d; }
      n++;
    }
    if (n < 10) return Infinity;
    return err / (n * colCount);
  };
  const evalR = (s) => {
    const rows = fh - s;
    if (rows < 8) return Infinity;
    let err = 0, n = 0;
    for (let r = 0; r < rows; r++) {
      if (!gaRowInf[s + r]) continue;
      const gi = (s + r) * colsR, fi = r * colsR;
      for (let ci = 0; ci < colsR; ci++) { const d = gfR[fi + ci] - gaR[gi + ci]; err += d * d; }
      n++;
    }
    if (n < 10) return Infinity;
    return err / (n * colsR);
  };
  console.log(`== ${nameA}->${nameB} ==`);
  for (const s of targets) console.log(`  evalS(${s}) = ${fmt(evalS(s))}  evalR(${s}) = ${fmt(evalR(s))}`);
  const S_MAX = fh - 8;
  const scanN = Math.floor(S_MAX / 2) + 1;
  const errs = [];
  for (let i = 0; i < scanN; i++) errs.push(evalS(i * 2));
  const valleys = [];
  for (let i = 1; i < scanN - 1; i++) if (errs[i] < errs[i - 1] && errs[i] <= errs[i + 1]) valleys.push({ s: i * 2, e: errs[i] });
  valleys.sort((x, y) => x.e - y.e);
  console.log('  粗搜谷 top6:', valleys.slice(0, 6).map((v) => `s=${v.s}(${isFinite(v.e) ? Math.round(v.e) : 'Inf'})`).join(' '));
  const cands = [];
  for (const v of valleys.slice(0, 4)) {
    const lo = Math.max(0, v.s - 3), hi = Math.min(S_MAX, v.s + 3);
    let bs = -1, be = Infinity;
    for (let s = lo; s <= hi; s++) { const e = evalS(s); if (e < be) { be = e; bs = s; } }
    if (bs > 0 && be < Infinity) cands.push({ s: bs, e: be, eR: evalR(bs) });
  }
  console.log('  候选(粗搜top4细搜):', cands.map((c) => `s=${c.s} eR=${fmt(c.eR)}`).join(' '));
  cands.sort((x, y) => x.eR - y.eR);
  console.log('  evalR 冠军:', cands.length ? `s=${cands[0].s} eR=${fmt(cands[0].eR)}` : '(无)');
}
function fmt(v) { return isFinite(v) ? v.toFixed(1) : 'Inf'; }
probe('f0006', 'f0007', [50, 111, 135]);
probe('f0004', 'f0005', [135, 155, 185]);

/*
 * 像素矩形层级检测探测器：读原始 RGBA 帧 → Prepare → 多点 Detect → 输出各级矩形。
 * 用法：node tools/pixel_probe.js <frame.rgba> <w> <h> "x1,y1 x2,y2 ..."
 */
const fs = require('fs');
const path = require('path');
const koffi = require('F:/Work/Create/Assa/Xiyue/node_modules/koffi');
const [,, framePath, wArg, hArg, ptsArg] = process.argv;
const w = +wArg, h = +hArg;
const data = fs.readFileSync(framePath);
const lib = koffi.load(path.join(__dirname, '..', 'native', 'smart_uia', 'smart_uia.dll'));
const prepare = lib.func('int SmartPixelFramePrepare(const uint8_t *rgba, int w, int h, int stride)');
const detect = lib.func('int SmartPixelDetectLevels(int px, int py, int bx, int by, int bw, int bh, char *out, int cap)');
const buf = Buffer.alloc(16384);
const t0 = process.hrtime.bigint();
const r = prepare(data, data.length / h, 1, data.length / h); // stride 占位，下面真正调用
const t1 = process.hrtime.bigint();
// 重新 prepare（第一次参数占位错了也没关系，直接用正确 stride）
const r2 = prepare(data, w, h, w * 4);
const t2 = process.hrtime.bigint();
console.log(`prepare ok=${r2} ${Number(t2 - t1) / 1e6 | 0}ms`);
const out = {};
for (const p of (ptsArg || '').split(/\s+/).filter(Boolean)) {
  const [x, y] = p.split(',').map(Number);
  const t = process.hrtime.bigint();
  const n = detect(x, y, 0, 0, w, h, buf, 16384);
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  const j = JSON.parse(buf.toString('utf8', 0, n));
  out[`${x},${y}`] = j.levels;
  console.log(`pt(${x},${y}) ${ms.toFixed(2)}ms levels=${j.levels.length}`);
  for (const lv of j.levels) console.log(`   ${lv.controlType.padEnd(7)} ${String(lv.width + 'x' + lv.height).padEnd(10)} @${lv.x},${lv.y}`);
}
fs.writeFileSync(path.join(__dirname, 'pixel_probe_out.json'), JSON.stringify(out));

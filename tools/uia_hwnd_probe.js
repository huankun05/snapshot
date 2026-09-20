/*
 * 按 HWND 直探 UIA 钻取链路：绕过 z 序定位（桌面窗口遮挡时 uia_probe.js 打不到目标），
 * 走与应用完全相同的 poke + ElementFromHandle + 钻取路径。
 * 用法：node tools/uia_hwnd_probe.js <hwnd十进制> <physX> <physY> [rounds]
 * 坐标为物理像素（DLL 内部按应用内同款语义处理；node 逻辑坐标 ≈ 物理/1.5，可直接传物理换算值）。
 */
const path = require('path');
const koffi = require(process.env.KOFFI_PATH || 'F:/Work/Create/Assa/Xiyue/node_modules/koffi');
const lib = koffi.load(path.join(__dirname, '..', 'native', 'smart_uia', 'smart_uia.dll'));
const fn = lib.func('int SmartUiaProbeHwnd(int64_t hwnd, int32_t x, int32_t y, char *out, int32_t cap)');
const [hwnd = 0, x = 0, y = 0, rounds = 3] = process.argv.slice(2).map(Number);
if (!hwnd) {
  console.error('usage: node tools/uia_hwnd_probe.js <hwnd> <physX> <physY> [rounds]');
  process.exit(1);
}

for (let i = 0; i < rounds; i++) {
  const buf = Buffer.alloc(16384);
  const t0 = process.hrtime.bigint();
  const n = fn(hwnd, x, y, buf, 16384);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const res = JSON.parse(buf.toString('utf8', 0, n));
  console.log(`#${i} ${ms.toFixed(1)}ms levels=${res.levels ? res.levels.length : 0}${res.error ? ' error=' + res.error : ''}`);
  if (res.levels) {
    for (const lv of res.levels) {
      console.log(`  ${String(lv.controlType).padEnd(10)} ${String(lv.width + 'x' + lv.height).padEnd(10)} @${lv.x},${lv.y} "${String(lv.name || '').slice(0, 40)}"`);
    }
  }
}

/*
 * 智能选区 DLL 探测器：独立进程直调 native/smart_uia/smart_uia.dll，打印光标点的 UIA 层级链与目标窗。
 * 用法：node tools/uia_probe.js [x y] [rounds]      （默认 700 450，连查 6 轮、间隔 250ms）
 * 注意：node 非 DPI 感知，坐标按逻辑像素给（如 150% 缩放的 2560×1440 屏 = 1707×960）；
 *       应用内（Electron 感知 DPI）传的是物理像素。
 * 用途：① 验证 DLL 在遮罩开着时仍返回目标应用而非自身；② 观察 Chromium 无障碍树激活（首查粗、后续细）；
 *       ③ 量化单次延迟。
 */
const path = require('path');
const koffi = require(process.env.KOFFI_PATH || 'F:/Work/Create/Assa/Xiyue/node_modules/koffi');
const lib = koffi.load(path.join(__dirname, '..', 'native', 'smart_uia', 'smart_uia.dll'));
const fn = lib.func('int SmartUiaGetLevels(int32_t x, int32_t y, char *out, int32_t cap)');
const [x = 700, y = 450, rounds = 6] = process.argv.slice(2).map(Number);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let last = null;
  for (let i = 0; i < rounds; i++) {
    const buf = Buffer.alloc(16384);
    const t0 = process.hrtime.bigint();
    const n = fn(x, y, buf, 16384);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    last = JSON.parse(buf.toString('utf8', 0, n));
    const d = last.levels[0];
    console.log(`#${String(i).padStart(2)} ${ms.toFixed(1).padStart(6)}ms levels=${last.levels.length} win="${last.window ? last.window.name.slice(0, 28) : 'null'}" deepest=${d ? `${d.controlType} ${d.width}x${d.height} "${(d.name || '').slice(0, 30)}"` : '-'}`);
    await sleep(250);
  }
  console.log('--- chain (small → large) ---');
  for (const lv of last.levels) console.log(`  ${lv.controlType.padEnd(9)} ${String(lv.width + 'x' + lv.height).padEnd(10)} @${lv.x},${lv.y} "${(lv.name || '').slice(0, 36)}"`);
})();

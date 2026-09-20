/*
 * SmartUiaSnapshot 隔离测试：独立进程直调快照导出，验证不崩、结构合理。
 * 用法：node tools/uia_snapshot_probe.js <physX> <physY>
 */
const path = require('path');
const koffi = require(process.env.KOFFI_PATH || 'F:/Work/Create/Assa/Xiyue/node_modules/koffi');
const lib = koffi.load(path.join(__dirname, '..', 'native', 'smart_uia', 'smart_uia.dll'));
const snapFn = lib.func('int SmartUiaSnapshot(int32_t physX, int32_t physY, char *out, int32_t cap)');
const [x = 1200, y = 600] = process.argv.slice(2).map(Number);

const buf = Buffer.alloc(262144);
const t0 = process.hrtime.bigint();
const n = snapFn(x, y, buf, buf.length);
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(`n=${n} ${ms.toFixed(1)}ms  (process alive)`);
if (n > 0) {
  const j = JSON.parse(buf.toString('utf8', 0, n));
  console.log(`ok=${j.ok} win="${j.window ? j.window.name : null}" ${j.window ? `${j.window.width}x${j.window.height}` : ''}`);
  const items = j.items || [];
  console.log(`items=${items.length}`);
  for (const it of items.slice(0, 8)) {
    console.log(`  ${String(it.controlType).padEnd(10)} ${String(it.width + 'x' + it.height).padEnd(10)} @${it.x},${it.y} "${String(it.name || '').slice(0, 24)}"`);
  }
}
console.log('SURVIVED');

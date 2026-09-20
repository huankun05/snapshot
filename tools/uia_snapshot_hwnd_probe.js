// snapshot-by-hwnd probe
const path = require('path');
const koffi = require(process.env.KOFFI_PATH || 'F:/Work/Create/Assa/Xiyue/node_modules/koffi');
const lib = koffi.load(path.join(__dirname, '..', 'native', 'smart_uia', 'smart_uia.dll'));
const fn = lib.func('int SmartUiaSnapshotHwnd(int64_t hwnd, int32_t x, int32_t y, char *out, int32_t cap)');
const [hwnd, x = 1000, y = 500] = process.argv.slice(2).map(Number);
if (!hwnd) { console.error('usage: node tools/uia_snapshot_hwnd_probe.js <hwnd> [x y]'); process.exit(1); }
const buf = Buffer.alloc(262144);
const t0 = process.hrtime.bigint();
const n = fn(hwnd, x, y, buf, buf.length);
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
console.log('n=' + n + ' ' + ms.toFixed(1) + 'ms');
if (n > 0) {
  const j = JSON.parse(buf.toString('utf8', 0, n));
  console.log('ok=' + j.ok + (j.error ? ' error=' + j.error : '') + ' win=' + JSON.stringify(j.window && j.window.name));
  const items = j.items || [];
  console.log('items=' + items.length);
  for (const it of items.slice(0, 12)) {
    console.log('  ' + String(it.controlType).padEnd(10) + ' ' + String(it.width + 'x' + it.height).padEnd(10) + ' @' + it.x + ',' + it.y + ' "' + String(it.name || '').slice(0, 26) + '"');
  }
}
console.log('SURVIVED');

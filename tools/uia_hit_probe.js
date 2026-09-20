// MSAA accHitTest probe
const path = require('path');
const koffi = require(process.env.KOFFI_PATH || 'F:/Work/Create/Assa/Xiyue/node_modules/koffi');
const lib = koffi.load(path.join(__dirname, '..', 'native', 'smart_uia', 'smart_uia.dll'));
const fn = lib.func('int SmartUiaHitLevels(int32_t x, int32_t y, char *out, int32_t cap)');
const pts = process.argv.slice(2);
for (const p of pts) {
  const [x, y] = p.split(',').map(Number);
  const buf = Buffer.alloc(16384);
  const t0 = process.hrtime.bigint();
  const n = fn(x, y, buf, buf.length);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (n <= 0) { console.log('pt(' + x + ',' + y + ') n=' + n); continue; }
  const j = JSON.parse(buf.toString('utf8', 0, n));
  const lvs = j.levels || [];
  const s = lvs[0];
  console.log('pt(' + x + ',' + y + ') ' + ms.toFixed(1) + 'ms levels=' + lvs.length
    + ' smallest=' + (s ? s.controlType + ' ' + s.width + 'x' + s.height + ' "' + String(s.name || '').slice(0, 24) + '"' : '-'));
}

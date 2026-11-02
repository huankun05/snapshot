// 顶层窗命中核对：WindowFromPoint 到底落在哪个顶层窗上
const koffi = require('F:/Work/Create/Assa/Xiyue/node_modules/koffi');
const u = koffi.load('user32.dll');
koffi.struct('PT_W', { x: 'int32', y: 'int32' });
const WFP = u.func('uint64_t WindowFromPoint(PT_W p)');
const GA = u.func('uint64_t GetAncestor(uint64_t h, uint32_t f)');
const GTW = u.func('int GetWindowTextW(uint64_t h, uint16_t *buf, int max)');
const GTWL = u.func('int GetWindowTextLengthW(uint64_t h)');
const GWR = u.func('int GetWindowRect(uint64_t h, PT_W *r)');
const GEX = u.func('int GetWindowLongW(uint64_t h, int i)');

function title(h) {
  const n = GTWL(h);
  if (n <= 0) return '(no title)';
  const b = Buffer.alloc((n + 1) * 2);
  GTW(h, b, n + 1);
  return b.toString('utf16le').replace(/\0+$/, '');
}
for (const [x, y] of [[700, 300], [1024, 576], [1000, 800], [200, 200]]) {
  const w = WFP({ x, y });
  const root = GA(w, 2);
  const r = Buffer.alloc(16); GWR(root, r);
  const ex = GEX(root, -20) >>> 0;   // GWL_EXSTYLE
  const flags = [];
  if (ex & 0x80000) flags.push('LAYERED');
  if (ex & 0x20) flags.push('TRANSPARENT');
  if (ex & 0x80) flags.push('TOOLWINDOW');
  if (ex & 0x80000) flags.push('NOACTIVATE');
  console.log(`(${x},${y})  WFP=0x${w.toString(16)} ROOT=0x${root.toString(16)} "${title(root)}"`
    + ` @${r.readInt32LE(0)},${r.readInt32LE(4)} ${Math.abs(r.readInt32LE(8) - r.readInt32LE(0))}x${Math.abs(r.readInt32LE(12) - r.readInt32LE(4))}`
    + ` exStyle=0x${ex.toString(16)} [${flags.join(',')}]`);
}

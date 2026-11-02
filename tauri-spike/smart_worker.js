// PetalSnap Tauri spike · 智能检测辅助进程
// 为什么存在：smart_uia.dll 的 UIA 客户端在宿主=WebView2/Tauri 进程内会返回空树
//（同点同时刻独立 node 进程正常，2026-10-28 实锤），故照搬 F1 的 worker 架构——
// DLL 由本进程独占（单线程 + koffi），宿主经 stdin/stdout JSON 行协议调用。
// 协议：{"id":n,"op":"get_levels|snapshot|poke","x":..,"y":..} → {"id":n,"json":...}
const path = require('path');
const koffi = require(path.join('F:/Work/Create/OCR/screenshot/node_modules/koffi'));
const lib = koffi.load('F:/Work/Create/OCR/screenshot/native/smart_uia/smart_uia.dll');
const fns = {
  get_levels: lib.func('int SmartUiaGetLevels(int32_t physX, int32_t physY, char *outJson, int32_t outCap)'),
  snapshot: lib.func('int SmartUiaSnapshot(int32_t physX, int32_t physY, char *outJson, int32_t outCap)'),
  poke: lib.func('int SmartUiaPoke(int32_t physX, int32_t physY)'),
};
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', function (line) {
  var req;
  try { req = JSON.parse(line); } catch (e) { return; }
  var id = req.id, op = req.op, x = req.x | 0, y = req.y | 0, json = null;
  try {
    if (op === 'get_levels' || op === 'snapshot') {
      var buf = Buffer.alloc(op === 'snapshot' ? 262144 : 65536);
      var n = fns[op](x, y, buf, buf.length);
      json = n > 0 ? JSON.parse(buf.toString('utf8', 0, n)) : null;
    } else if (op === 'poke') {
      fns.poke(x, y);
    }
  } catch (e) {
    process.stderr.write('[smart_worker] op ' + op + ' threw: ' + e + '\n');
  }
  process.stdout.write(JSON.stringify({ id: id, json: json }) + '\n');
});
process.stderr.write('[smart_worker] ready pid=' + process.pid + '\n');
process.on('disconnect', function () { process.exit(0); });

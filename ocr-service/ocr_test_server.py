# -*- coding: utf-8 -*-
r"""
RapidOCR(PP-OCRv6) 独立测试服务 —— 与主项目完全隔离，仅用于人工验证识别效果。

启动:  F:/Work/Create/OCR/venv_ocr/Scripts/python.exe F:/Work/Create/OCR/ocr_test_server.py
使用:  浏览器打开 http://127.0.0.1:8766 ，截图后 Ctrl+V 粘贴 / 拖入 / 选择图片，
       返回：耗时、文本框数、纯文本、段落分组、框选标注图。
       页面可切换 small / tiny 档对比识别质量。
协议:  POST /api/ocr?model=small|tiny  body=图片字节  → JSON
只依赖标准库 + rapidocr + PIL。
"""
import io
import json
import time
import base64
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

from PIL import Image, ImageDraw
from rapidocr import RapidOCR
from rapidocr.utils.typings import ModelType

from local_capture_service import _group_paragraphs

PORT = 8766
MAX_PREVIEW_W = 1100

_engines: dict[str, RapidOCR] = {}
_lock = threading.Lock()


def get_engine(model: str) -> RapidOCR:
    with _lock:
        if model not in _engines:
            mt = ModelType.TINY if model == "tiny" else ModelType.MEDIUM if model == "medium" else ModelType.SMALL
            _engines[model] = RapidOCR(params={
                "Global.use_cls": False,
                "Det.model_type": mt,
                "Rec.model_type": mt,
            })
        return _engines[model]


def annotate(img: Image.Image, lines: list[dict]) -> str:
    """画框+序号，返回 base64 PNG（预览宽度受限）。"""
    vis = img.convert("RGB")
    scale = 1.0
    if vis.width > MAX_PREVIEW_W:
        scale = MAX_PREVIEW_W / vis.width
        vis = vis.resize((MAX_PREVIEW_W, max(1, int(vis.height * scale))))
    draw = ImageDraw.Draw(vis)
    for i, l in enumerate(lines):
        x1, y1, x2, y2 = l["box"]
        if scale != 1.0:
            x1, y1, x2, y2 = x1 * scale, y1 * scale, x2 * scale, y2 * scale
        draw.rectangle([x1, y1, x2, y2], outline=(255, 64, 64), width=2)
        draw.rectangle([x1, max(0, y1 - 14), x1 + 18, y1], fill=(255, 64, 64))
    buf = io.BytesIO()
    vis.save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


def ocr_bytes(raw: bytes, model: str) -> dict:
    t0 = time.time()
    img = Image.open(io.BytesIO(raw))
    engine = get_engine(model)
    r = engine(img)
    ocr_ms = (time.time() - t0) * 1000

    txts = list(r.txts) if r.txts is not None else []
    boxes = list(r.boxes) if r.boxes is not None else []
    scores = list(r.scores) if r.scores is not None else []
    lines = []
    for txt, box, score in zip(txts, boxes, scores):
        xs = [pt[0] for pt in box]
        ys = [pt[1] for pt in box]
        lines.append({
            "text": txt,
            "box": [round(float(min(xs)), 1), round(float(min(ys)), 1), round(float(max(xs)), 1), round(float(max(ys)), 1)],
            "score": round(float(score), 3),
        })

    t1 = time.time()
    paras = _group_paragraphs([{"text": l["text"], "box": tuple(l["box"])} for l in lines])
    group_ms = (time.time() - t1) * 1000

    return {
        "model": model,
        "ocr_ms": round(ocr_ms),
        "group_ms": round(group_ms),
        "width": img.width,
        "height": img.height,
        "lines": lines,
        "paragraphs": [p["text"] for p in paras],
        "annotated": annotate(img, lines) if lines else "",
    }


PAGE = """<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<title>RapidOCR 截图识别测试</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; margin: 0; background:#14161a; color:#e8eaed; }
  header { padding:14px 22px; background:#1c1f26; display:flex; gap:16px; align-items:center; border-bottom:1px solid #2a2e37;}
  header h1 { font-size:16px; margin:0; font-weight:600; }
  select, button { background:#262a33; color:#e8eaed; border:1px solid #3a404d; border-radius:6px; padding:5px 10px; }
  #drop { margin:18px 22px; border:2px dashed #3a404d; border-radius:12px; padding:34px; text-align:center; color:#9aa0a6; }
  #drop.hot { border-color:#7c9cff; color:#c3cdff; }
  main { display:grid; grid-template-columns: 1fr 1fr; gap:16px; padding:0 22px 24px; }
  .card { background:#1c1f26; border:1px solid #2a2e37; border-radius:10px; padding:14px; }
  .card h2 { font-size:13px; margin:0 0 10px; color:#9aa0a6; font-weight:600; }
  #stats { font-size:13px; color:#9aa0a6; margin-bottom:8px; }
  #annotated img { max-width:100%; border-radius:6px; }
  pre { white-space:pre-wrap; word-break:break-all; font-size:13px; line-height:1.65; margin:0;
        font-family:inherit; max-height:46vh; overflow:auto; }
  .para { padding:7px 10px; border-left:3px solid #4a5060; margin-bottom:8px; background:#22262e; border-radius:0 6px 6px 0; font-size:13px; line-height:1.6;}
  .tabs { display:flex; gap:6px; margin-bottom:10px; }
  .tabs button.on { background:#3a4a7a; }
  #empty { color:#5f6368; padding:30px; text-align:center; }
</style></head><body>
<header>
  <h1>RapidOCR 截图识别测试</h1>
  <label>模型 <select id="model">
    <option value="small" selected>PP-OCRv6 small（推荐）</option>
    <option value="tiny">PP-OCRv6 tiny</option>
    <option value="medium">PP-OCRv6 medium（慢）</option>
  </select></label>
  <span style="color:#5f6368;font-size:12px">127.0.0.1:8766 · 与主项目隔离</span>
</header>
<div id="drop">截图后按 <b>Ctrl+V</b> 粘贴，或把图片拖到这里 / 点击选择文件</div>
<main>
  <div class="card" id="annotated"><h2>识别框</h2><div id="empty">尚未识别</div></div>
  <div class="card">
    <h2>结果 <span id="stats"></span></h2>
    <div class="tabs">
      <button id="t-para" class="on">段落</button>
      <button id="t-text">纯文本</button>
      <button id="t-lines">逐行(含置信度)</button>
    </div>
    <pre id="out">尚未识别</pre>
  </div>
</main>
<input type="file" id="file" accept="image/*" hidden>
<script>
let mode = 'para', last = null;
const $ = id => document.getElementById(id);
const drop = $('drop');
drop.onclick = () => $('file').click();
$('file').onchange = e => { if (e.target.files[0]) send(e.target.files[0]); };
document.onpaste = e => { for (const it of e.clipboardData.items) if (it.type.startsWith('image/')) send(it.getAsFile()); };
['dragover','dragenter'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('hot'); }));
['dragleave','drop'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('hot'); }));
document.addEventListener('drop', e => { if (e.dataTransfer.files[0]) send(e.dataTransfer.files[0]); });
['t-para','t-text','t-lines'].forEach(id => $(id).onclick = () => {
  mode = id.slice(2); document.querySelectorAll('.tabs button').forEach(b=>b.classList.remove('on'));
  $(id).classList.add('on'); render();
});
function render() {
  if (!last) return;
  const o = $('out');
  if (mode === 'text') o.textContent = last.paragraphs.join('\\n\\n');
  else if (mode === 'lines') o.textContent = last.lines.map(l => `[${l.score}] ${l.text}`).join('\\n');
  else o.innerHTML = last.paragraphs.map(p => `<div class="para">${p.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</div>`).join('') || '（无文本）';
}
async function send(file) {
  $('stats').textContent = '识别中…';
  const buf = await file.arrayBuffer();
  const t0 = performance.now();
  const res = await fetch('/api/ocr?model=' + $('model').value, { method:'POST', body: buf });
  last = await res.json();
  $('stats').textContent = `识别 ${last.ocr_ms}ms（分组 ${last.group_ms}ms）· ${last.width}×${last.height} · ${last.lines.length} 个文本框 · ${last.paragraphs.length} 段`;
  $('annotated').innerHTML = '<h2>识别框</h2><img src="data:image/png;base64,' + last.annotated + '">';
  render();
}
</script></body></html>"""


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, body: bytes, ctype: str):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/"):
            self._send(200, PAGE.encode("utf-8"), "text/html; charset=utf-8")

    def do_POST(self):
        if not self.path.startswith("/api/ocr"):
            self._send(404, b"{}", "application/json")
            return
        model = parse_qs(urlparse(self.path).query).get("model", ["small"])[0]
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)
        try:
            result = ocr_bytes(raw, model)
            self._send(200, json.dumps(result, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")
        except Exception as e:  # noqa: BLE001
            self._send(500, json.dumps({"error": str(e)}, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def log_message(self, fmt, *args):  # 静默访问日志
        pass


if __name__ == "__main__":
    print(f"[ocr-test] 预热 small 引擎…", flush=True)
    t0 = time.time()
    get_engine("small")
    print(f"[ocr-test] 就绪 ({time.time()-t0:.1f}s) → http://127.0.0.1:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()

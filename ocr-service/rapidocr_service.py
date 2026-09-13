# -*- coding: utf-8 -*-
r"""
RapidOCR(PP-OCRv6 small) 常驻服务 —— 截图功能独立应用的本机识别内核（试验期）。

协议（JSON over HTTP，127.0.0.1:18766）:
  GET  /health -> {"ok": true, "model": "PP-OCRv6-small"}
  POST /ocr    body {"image_b64": "<base64 或 dataURL>"}
            -> {"ok": true, "ms": N, "lines": [{"text","box","score"}], "paragraphs": ["..."]}
  POST /table  body {"image_b64": ...}
            -> {"ok": true, "ms": N, "html": "<table>...", "rows": N}   # 表格结构还原（RapidTable/SLANet-plus）
段落的阅读顺序/续行合并与 local_capture_service._group_paragraphs 同源（本文件内联副本，
避免该模块的 paddle 依赖）。

启动: F:/Work/Create/OCR/venv_ocr/Scripts/python.exe F:/Work/Create/OCR/rapidocr_service.py
由 Electron 侧 rapidOcrService.ts 拉起与健康检查；进程退出由主进程负责。
"""
import base64
import io
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from PIL import Image
from rapidocr import RapidOCR

PORT = 18766
MODEL_TAG = "PP-OCRv6-small"

_engine = None
_table_engine = None


def get_engine():
    global _engine
    if _engine is None:
        _engine = RapidOCR(params={"Global.use_cls": False})
    return _engine


def get_table_engine():
    """表格结构还原（SLANet-plus，首次调用时初始化/下载模型）"""
    global _table_engine
    if _table_engine is None:
        from rapid_table import RapidTable, RapidTableInput, ModelType
        _table_engine = RapidTable(RapidTableInput(model_type=ModelType.SLANETPLUS))
    return _table_engine


def table_recognize(image_b64: str) -> dict:
    if image_b64.startswith("data:"):
        _, image_b64 = image_b64.split(",", 1)
    raw = base64.b64decode(image_b64)
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    t0 = time.time()
    arr = np.array(img)
    result = get_table_engine()(arr)
    ms = int((time.time() - t0) * 1000)
    htmls = getattr(result, "pred_htmls", None) or []
    html = htmls[0] if htmls else ""
    logic = getattr(result, "logic_points", None) or []
    cell_bboxes = getattr(result, "cell_bboxes", None) or []
    if html:
        rows = _parse_table_rows(html)
        rows = _split_merged_rows(arr, rows, cell_bboxes, logic)
        html = _rebuild_html(rows)
        html = _border_table_html(html)
    # logic_points 每项 = [row_start, row_end, col_start, col_end]；行数 = 最大 row_end + 1
    try:
        rws = (max(int(p[1]) for p in logic) + 1) if logic else 0
    except Exception:
        rws = 0
    return {"ok": True, "ms": ms, "html": html, "rows": int(rws)}


def _group_paragraphs(lines: list[dict]) -> list[dict]:
    """与 local_capture_service._group_paragraphs 保持一致（内联副本）。"""
    if not lines:
        return []
    hs = sorted(b["box"][3] - b["box"][1] for b in lines)
    avg_h = max(10.0, float(hs[len(hs) // 2]))
    sorted_lines = sorted(lines, key=lambda b: (b["box"][1], b["box"][0]))

    paragraphs: list[dict] = []
    cur: dict | None = None
    for l in sorted_lines:
        x1, y1, x2, y2 = l["box"]
        if cur is not None:
            px1, py1, px2, py2 = cur["box"]
            v_gap = y1 - py2
            x_overlap = min(x2, px2) - max(x1, px1)
            min_w = max(1.0, min(x2 - x1, px2 - px1))
            open_ended = not cur["text"].rstrip().endswith((".", "!", "?", ":", ";", "。", "！", "？", "；", "："))
            gap_limit = max(2.0 * avg_h, 14.0) if open_ended else max(1.35 * avg_h, 8.0)
            if v_gap <= gap_limit and x_overlap > 0.15 * min_w:
                cur["text"] += " " + l["text"]
                cur["box"] = (min(px1, x1), min(py1, y1), max(px2, x2), max(py2, y2))
                cur["line_h"] = (cur["line_h"] + (y2 - y1)) / 2.0
                continue
        cur = {"text": l["text"], "box": (x1, y1, x2, y2), "line_h": float(y2 - y1)}
        paragraphs.append(cur)
    return paragraphs


def _border_table_html(html: str) -> str:
    """表格 HTML 加默认边框（内联样式，Excel/WPS/浏览器粘贴均可见）"""
    html = html.replace('<table>', '<table border="1" style="border-collapse:collapse;">', 1)
    html = html.replace('<td>', '<td style="border:1px solid #000; padding:4px 8px;">')
    html = html.replace('<th>', '<th style="border:1px solid #000; padding:4px 8px; background:#f0f0f0;">')
    return html


def _parse_table_rows(html: str) -> list[list[str]]:
    """pred_html → 行/单元格文本二维数组（只认 tr/td/th，够用且无外部依赖）"""
    import re
    rows: list[list[str]] = []
    for tr in re.findall(r"<tr>(.*?)</tr>", html, re.S):
        cells = [re.sub(r"<[^>]+>", "", c).strip() for c in re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", tr, re.S)]
        if cells:
            rows.append(cells)
    return rows


def _rebuild_html(rows: list[list[str]], header_is_first: bool = True) -> str:
    """行/单元格数组 → 表格 HTML（首行 th，其余 td）"""
    def esc(t: str) -> str:
        return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    parts = ["<html><body><table>"]
    for ri, row in enumerate(rows):
        tag = "th" if (ri == 0 and header_is_first) else "td"
        parts.append("<tr>" + "".join(f"<{tag}>{esc(c)}</{tag}>" for c in row) + "</tr>")
    parts.append("</table></body></html>")
    return "".join(parts)


def _split_merged_rows(img, rows: list[list[str]], cell_bboxes: list, logic_points: list) -> list[list[str]]:
    """修复"整行被并成一个单元格"（无竖线表头/分隔行通病，SLANet 系模型在无线表格上高发）。

    原理：若第 0 行只有 1 格、而数据行普遍有 N>=2 列，则取数据行单元格的 x 边界做列边界，
    对表头条带重新跑 RapidOCR 得到词级框，按词中心 x 落到哪一列就归哪列，重建表头。
    仅处理首行并格（数据行并格多含 colspan 语义，不动）。"""
    try:
        if len(rows) < 2 or len(rows[0]) != 1:
            return rows
        col_counts = [len(r) for r in rows[1:]]
        n = max(set(col_counts), key=col_counts.count)
        if n < 2:
            return rows
        # 找第一个恰好 N 列的数据行，取其单元格 x 边界
        flat = 1  # cell_bboxes 展平索引，跳过表头那 1 格
        ref_boxes = None
        for r in rows[1:]:
            if len(r) == n and flat - 1 + n <= len(cell_bboxes):
                ref_boxes = cell_bboxes[flat:flat + n]
                break
            flat += len(r)
        if not ref_boxes:
            return rows
        # 每列 x 范围（取各列在该行单元格的 min/max，cell_bboxes 为 8 坐标 4 点）
        col_x = []
        for b in ref_boxes:
            xs = [float(b[i]) for i in (0, 2, 4, 6)]
            col_x.append((min(xs), max(xs)))
        # 表头条带 y 范围
        hb = cell_bboxes[0]
        ys = [float(hb[i]) for i in (1, 3, 5, 7)]
        y0, y1 = max(0, int(min(ys)) - 4), int(max(ys)) + 4
        strip = img[y0:y1, :, :]
        if strip.size == 0:
            return rows
        words = []
        r2 = get_engine()(strip)
        txts = list(r2.txts) if r2.txts is not None else []
        boxes = list(r2.boxes) if r2.boxes is not None else []
        for t, b in zip(txts, boxes):
            xs = [float(pt[0]) for pt in b]
            words.append((t, (min(xs) + max(xs)) / 2 + 0))
        if not words:
            return rows
        # 词中心 x → 归列（离哪列列心近归哪列；词横跨多列时按中心）
        col_centers = [(lo + hi) / 2 for lo, hi in col_x]
        header = [""] * n
        for t, cx in words:
            ci = min(range(n), key=lambda i: abs(col_centers[i] - cx))
            header[ci] = (header[ci] + " " + t).strip()
        # 空列兜底：按顺序塞回没归到词的列心附近文本（罕见）；保持 N 列形状
        out = [header] + [r[:] for r in rows[1:]]
        return out
    except Exception:  # noqa: BLE001 修复失败就按原样返回
        return rows


def _build_markdown(lines: list[dict]) -> list[dict]:
    """行级格式启发式 v3：
    - 有序列表：行首 \d+[.、．)）] → 独立块；无序列表：•/·/- 前缀 → 独立块
    - 行内序号切分：仅当检测框是多行合并（行高 ≥1.6×中位数）时才做——单行高文本里的
      "1."/"2." 多半是内容本身（如讲 Markdown 语法的文档），切了反而打碎正文（v2 实测教训）
    - 标题：行高 ≥1.3×中位数，或"短行 + 非句末标点结尾"；v3 追加三个过滤：
      ① 与上一行贴得很近（段内换行）不算标题 ② 必须含实际文字内容 ③ 不以 Markdown 符号开头
    句末标点（。？！…等）结尾的行永不判标题。"""
    if not lines:
        return []
    import re
    hs = sorted(b["box"][3] - b["box"][1] for b in lines)
    med_h = max(8.0, float(hs[len(hs) // 2]))
    bullets = ("•", "·", "●", "○", "-", "–", "—")
    sent_end = ("。", "？", "！", "；", "：", ".", ",", ";", ":", "，", "…")
    num_re = re.compile(r"^(\d{1,3})\s*[.、．)）]\s*")
    inline_num_re = re.compile(r"(?:(?<=\s)|(?<=[;；。！？]))\d{1,2}\.\s")
    md_prefix = ("#", "-", "*", ">", "|", "```", "+")
    content_re = re.compile(r"[一-鿿A-Za-z0-9]")

    blocks: list[dict] = []
    cur: dict | None = None
    prev_bottom: float | None = None

    def close():
        nonlocal cur
        if cur:
            blocks.append(cur)
            cur = None

    for l in sorted(lines, key=lambda b: (b["box"][1], b["box"][0])):
        x1, y1, x2, y2 = l["box"]
        raw_text = l["text"].strip()
        if not raw_text:
            continue
        h = y2 - y1
        gap_above = (y1 - prev_bottom) if prev_bottom is not None else 999.0
        # 行内切分只对"多行合并框"生效（单行高里的序号多为内容本身）
        if h >= 1.6 * med_h:
            cuts = [0] + [m.start() for m in inline_num_re.finditer(raw_text)]
            segments = [raw_text[a:b].strip() for a, b in zip(cuts, cuts[1:] + [len(raw_text)])]
        else:
            segments = [raw_text]
        for text in segments:
            if not text:
                continue
            numbered = bool(num_re.match(text))
            starts_md = text.startswith(md_prefix)
            has_content = bool(content_re.search(text))
            tight_above = prev_bottom is not None and gap_above < 0.35 * med_h
            # 标题：显著更高（字号证据），或"短行 + 非句末标点结尾"（粗体同高兜底）；
            # 段内换行/纯符号/Markdown 语法定义行一律不算
            is_heading = (
                not numbered
                and not starts_md
                and has_content
                and not text.endswith(sent_end)
                and len(text) >= 2
                and not tight_above
                and (h >= 1.3 * med_h or len(text) <= 36)
            )
            if is_heading:
                close()
                blocks.append({"type": "h", "text": text})
                prev_bottom = y2
                continue
            if numbered:
                close()
                m = num_re.match(text)
                cur = {"type": "l", "text": f"{m.group(1)}. {text[m.end():]}", "box": (x1, y1, x2, y2)}
                prev_bottom = y2
                continue
            if text.startswith(bullets):
                close()
                cur = {"type": "l", "text": text.lstrip("".join(bullets)).strip(), "box": (x1, y1, x2, y2)}
                prev_bottom = y2
                continue
            # 普通行：垂直间距小 + 水平重叠 → 并段（列表块的续行也走这里并入）
            if cur is not None:
                px1, py1, px2, py2 = cur["box"]
                v_gap = y1 - py2
                x_overlap = min(x2, px2) - max(x1, px1)
                min_w = max(1.0, min(x2 - x1, px2 - px1))
                open_ended = not cur["text"].rstrip().endswith(sent_end)
                gap_limit = max(2.0 * med_h, 14.0) if open_ended else max(1.35 * med_h, 8.0)
                if v_gap <= gap_limit and x_overlap > 0.15 * min_w:
                    cur["text"] += " " + text
                    cur["box"] = (min(px1, x1), min(py1, y1), max(px2, x2), max(py2, y2))
                    prev_bottom = y2
                    continue
            close()
            cur = {"type": "p", "text": text, "box": (x1, y1, x2, y2)}
            prev_bottom = y2
    close()
    return blocks


def ocr_image(image_b64: str) -> dict:
    if image_b64.startswith("data:"):
        _, image_b64 = image_b64.split(",", 1)
    raw = base64.b64decode(image_b64)
    img = Image.open(io.BytesIO(raw))
    t0 = time.time()
    r = get_engine()(img)
    ms = int((time.time() - t0) * 1000)

    txts = list(r.txts) if r.txts is not None else []
    boxes = list(r.boxes) if r.boxes is not None else []
    scores = list(r.scores) if r.scores is not None else []
    lines = []
    for txt, box, score in zip(txts, boxes, scores):
        xs = [float(pt[0]) for pt in box]
        ys = [float(pt[1]) for pt in box]
        lines.append({
            "text": txt,
            "box": [round(min(xs), 1), round(min(ys), 1), round(max(xs), 1), round(max(ys), 1)],
            "score": round(float(score), 3),
        })
    paras = _group_paragraphs([{"text": l["text"], "box": tuple(l["box"])} for l in lines])
    blocks = _build_markdown([{"text": l["text"], "box": tuple(l["box"])} for l in lines])
    # 相邻列表块用单换行连接 → Markdown 渲染为同一个列表（空行分隔会拆成多个单元素列表）
    md_lines: list[str] = []
    for bi, b in enumerate(blocks):
        if b["type"] == "h":
            md_lines.append("## " + b["text"])
        elif b["type"] == "l":
            md_lines.append(b["text"] if b["text"][:1].isdigit() else "- " + b["text"])
        else:
            md_lines.append(b["text"])
        if bi + 1 < len(blocks) and not (b["type"] == "l" and blocks[bi + 1]["type"] == "l"):
            md_lines.append("")  # 块间空行；列表→列表不插（保持同一列表）
    markdown = "\n".join(md_lines)
    return {
        "ok": True,
        "ms": ms,
        "lines": lines,
        "paragraphs": [p["text"] for p in paras],
        "markdown": markdown,
    }


class Handler(BaseHTTPRequestHandler):
    def _json(self, code: int, obj: dict):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            self._json(200, {"ok": True, "model": MODEL_TAG})
        else:
            self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if self.path.startswith("/ocr"):
            try:
                length = int(self.headers.get("Content-Length", 0))
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                self._json(200, ocr_image(payload.get("image_b64", "")))
            except Exception as e:  # noqa: BLE001
                self._json(500, {"ok": False, "error": str(e)})
        elif self.path.startswith("/table"):
            try:
                length = int(self.headers.get("Content-Length", 0))
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                self._json(200, table_recognize(payload.get("image_b64", "")))
            except Exception as e:  # noqa: BLE001
                self._json(500, {"ok": False, "error": str(e)})
        else:
            self._json(404, {"ok": False, "error": "not found"})

    def log_message(self, fmt, *args):
        pass


if __name__ == "__main__":
    t0 = time.time()
    get_engine()
    print(f"[rapidocr-service] {MODEL_TAG} ready in {time.time()-t0:.1f}s, port {PORT}", file=sys.stderr, flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()

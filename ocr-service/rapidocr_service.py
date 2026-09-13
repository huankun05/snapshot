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
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from PIL import Image
from rapidocr import RapidOCR

PORT = 18766
MODEL_TAG = "PP-OCRv6-small"

_engine = None
_table_engine = None


_engine_backend = "cpu"


def get_engine():
    """识别引擎：优先 GPU(DirectML)，初始化失败自动降级 CPU（RTX4070 实测 DML 快 ~2.5 倍）"""
    global _engine, _engine_backend
    if _engine is None:
        base = {
            "Global.use_cls": False,
            "Global.use_preprocess_img": False,
            "Global.max_side_len": 4000,
        }
        try:
            _engine = RapidOCR(params={**base, "EngineConfig.onnxruntime.use_dml": True})
            _engine_backend = "dml"
            print("[rapidocr-service] 引擎后端: DirectML(GPU)", file=sys.stderr, flush=True)
        except Exception as e:  # noqa: BLE001
            print(f"[rapidocr-service] DML 不可用({e})，降级 CPU", file=sys.stderr, flush=True)
            _engine = RapidOCR(params=base)
            _engine_backend = "cpu"
    return _engine


_layout_engine = None


def get_layout_engine():
    """版面分析（PP-DocLayoutV3/ONNX）：DML 优先、失败降级 CPU"""
    global _layout_engine
    if _layout_engine is None:
        from rapid_layout import RapidLayout, RapidLayoutInput, ModelType
        try:
            _layout_engine = RapidLayout(RapidLayoutInput(
                model_type=ModelType.PP_DOC_LAYOUTV3, engine_cfg={"use_dml": True}))
            print("[rapidocr-service] 版面引擎后端: DirectML(GPU)", file=sys.stderr, flush=True)
        except Exception as e:  # noqa: BLE001
            print(f"[rapidocr-service] 版面 DML 不可用({e})，降级 CPU", file=sys.stderr, flush=True)
            _layout_engine = RapidLayout(RapidLayoutInput(model_type=ModelType.PP_DOC_LAYOUTV3))
    return _layout_engine


def get_table_engine():
    """表格结构还原（SLANet-plus）：固定 CPU。
    DML 实测该模型 session.run 抛 UnicodeDecodeError（DirectML 对其算子不兼容），
    OCR 引擎的 DML 不受影响（识别/几何兜底已覆盖提速）。"""
    global _table_engine
    if _table_engine is None:
        from rapid_table import RapidTable, RapidTableInput, ModelType
        _table_engine = RapidTable(RapidTableInput(model_type=ModelType.SLANETPLUS))
    return _table_engine


def _geometry_table(lines: list[dict]) -> list[list[str]] | None:
    """几何表格重建 v2（间隙检测法）：把 OCR 词框的 x 覆盖区间投影到一维，
    词高尺度的连续空隙 = 列分隔；再按 y 行带分行填格。
    对无线表格（像素列对齐但无竖线）比列中心聚类更稳。"""
    if len(lines) < 4:
        return None
    boxes = [dict(l) for l in lines]
    heights = sorted(b["box"][3] - b["box"][1] for b in boxes)
    med_h = max(10.0, float(heights[len(heights) // 2]))
    min_x = min(b["box"][0] for b in boxes)
    max_x = max(b["box"][2] for b in boxes)
    span = max_x - min_x
    if span < 200:  # 太窄不可能是多列表格
        return None

    # 1) x 覆盖区间合并，找空隙
    intervals = sorted((b["box"][0], b["box"][2]) for b in boxes)
    gaps: list[tuple[float, float]] = []
    cur_end = intervals[0][1]
    for lo, hi in intervals[1:]:
        if lo > cur_end + 0.6 * med_h:  # 空隙 ≥ 0.6×行高才算列分隔
            gaps.append((cur_end, lo))
        cur_end = max(cur_end, hi)
    if not gaps:
        return None
    # 空隙过多（>5 列）不可信
    if len(gaps) > 4:
        return None

    # 2) 列边界
    edges = [min_x] + [ (g[0] + g[1]) / 2 for g in gaps ] + [max_x]
    k = len(edges) - 1
    if k < 2:
        return None

    def col_of(x: float) -> int:
        for i in range(k):
            if x < edges[i + 1]:
                return i
        return k - 1

    # 3) 行带分行填格
    rows: list[list[str]] = []
    band: list[dict] = []
    for b in sorted(boxes, key=lambda b: b["box"][1]):
        if band:
            ref_h = max(band[0]["box"][3] - band[0]["box"][1], b["box"][3] - b["box"][1], 1)
            if abs(b["box"][1] - band[-1]["box"][1]) > 0.6 * ref_h:
                rows.append(_geometry_row(band, col_of, k))
                band = []
        band.append(b)
    if band:
        rows.append(_geometry_row(band, col_of, k))
    rows = [r for r in rows if any(c.strip() for c in r)]
    if len(rows) < 2:
        return None
    # 每列至少两行有内容（真表格的列不会只出现一次）
    for ci in range(k):
        if sum(1 for r in rows if ci < len(r) and r[ci].strip()) < 2:
            return None
    return rows


def _geometry_row(band: list[dict], col_of, k: int) -> list[str]:
    row = [""] * k
    for b in band:
        cx = (b["box"][0] + b["box"][2]) / 2.0
        ci = col_of(cx)
        row[ci] = (row[ci] + " " + b["text"]).strip()
    return row


def table_recognize(image_b64: str) -> dict:
    if image_b64.startswith("data:"):
        _, image_b64 = image_b64.split(",", 1)
    raw = base64.b64decode(image_b64)
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    t0 = time.time()
    arr = np.array(img)
    # 单次 OCR：结果同时喂给表格模型（免其内部二次 OCR）与几何兜底（提速 ~40%）
    r_ocr = get_engine()(img)
    txts_all = list(r_ocr.txts) if r_ocr.txts is not None else []
    boxes_all = list(r_ocr.boxes) if r_ocr.boxes is not None else []
    scores_all = list(r_ocr.scores) if r_ocr.scores is not None else []
    result = get_table_engine()(arr, ocr_results=[(np.array(boxes_all, dtype=float), tuple(txts_all), tuple(scores_all))])
    ms = int((time.time() - t0) * 1000)
    htmls = getattr(result, "pred_htmls", None) or []
    html = htmls[0] if htmls else ""
    logic = getattr(result, "logic_points", None) or []
    cell_bboxes = getattr(result, "cell_bboxes", None) or []
    if html:
        rows = _parse_table_rows(html)
        rows = _split_merged_rows(arr, rows, cell_bboxes, logic)
        # 选区常把表格上方的标题/正文一起框进来 → 模型把它们还原成单格行。
        # 只丢弃"长"单格行（标题/正文句子）；短单格行可能是被合并的表头，保留。
        def _is_pollution(r: list[str]) -> bool:
            txt = " ".join(c for c in r if c.strip())
            return sum(1 for c in r if c.strip()) == 1 and len(txt) >= 14
        first_multi = next((i for i, r in enumerate(rows) if not _is_pollution(r)), 0)
        if first_multi > 0:
            rows = rows[first_multi:]
        # 几何兜底：截图表格像素列严格对齐，OCR 框 x 聚类推断的列数可信。
        # 模型列数与几何不一致（空表头/多出的空列/错位）时，用几何重建整表。
        try:
            ocr_lines = []
            for t, b in zip(txts_all, boxes_all):
                xs = [float(pt[0]) for pt in b]; ys = [float(pt[1]) for pt in b]
                ocr_lines.append({"text": t, "box": (min(xs), min(ys), max(xs), max(ys))})
            # 结构退化（模型把整表预测成极少数 cell）时其 bbox 不可信，
            # 跳过范围过滤——否则表格外的标题会参与、表内行反被丢弃（本轮 2 列错位根因）
            if len(cell_bboxes) >= 4:
                # 只保留模型表格范围内的行（选区常含表格外内容，会被几何重建误当表格行）
                # bb 是 4×2 点阵 → flatten 成 8 坐标后取 y（此前按扁平索引 bb[5] 越界，
                # IndexError 被 except 吞掉导致几何兜底从未生效）
                flat_bbs = [np.array(bb).flatten() for bb in cell_bboxes]
                gy1 = min(float(fb[1]) for fb in flat_bbs) - 4
                gy2 = max(float(fb[3]) for fb in flat_bbs) + 4
                ocr_lines = [l for l in ocr_lines if l["box"][1] >= gy1 - 2 and l["box"][3] <= gy2 + 2]
            geo_rows = _geometry_table(ocr_lines)
            model_cols = max((len(r) for r in rows), default=0)
            geo_cols = max((len(r) for r in geo_rows), default=0) if geo_rows else 0
            header_bad = bool(rows) and any(not c.strip() for c in rows[0])
            merged_present = bool(rows) and any(
                sum(1 for c in r if c.strip()) == 1 and len(r) >= model_cols for r in rows[:-1]
            )
            if geo_rows and geo_cols >= 2 and (geo_cols != model_cols or header_bad or merged_present):
                rows = geo_rows
        except Exception:  # noqa: BLE001 几何兜底失败保留模型结果
            pass
        # 长单元格换行会在行带分组时产生"只有一列有内容"的伪行 → 并回上一行同列
        merged_rows: list[list[str]] = []
        for r in rows:
            filled = [ci for ci, c in enumerate(r) if c.strip()]
            if (len(filled) == 1 and merged_rows and len(merged_rows[-1]) == len(r)
                    and merged_rows[-1][filled[0]].strip()):
                merged_rows[-1][filled[0]] = (merged_rows[-1][filled[0]] + " " + r[filled[0]].strip()).strip()
            else:
                merged_rows.append(r)
        rows = merged_rows
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


def _html_to_md_table(html: str) -> str:
    """表格 HTML → Markdown 管道表（智能识别输出用；首行作表头）"""
    rows = _parse_table_rows(html)
    if not rows:
        return ""
    nl = chr(10)
    lines = []
    for ri, row in enumerate(rows):
        cells = [c.replace("|", "/").strip() for c in row]
        lines.append("| " + " | ".join(cells) + " |")
        if ri == 0:
            lines.append("|" + "".join(" --- |" for _ in cells))
    return nl.join(lines)


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
                ref_boxes = [np.array(bb).flatten() for bb in cell_bboxes[flat:flat + n]]
                break
            flat += len(r)
        if not ref_boxes:
            return rows
        # 每列 x 范围（取各列在该行单元格的 min/max，bb 为 4 点阵 flatten 后取 8 坐标）
        col_x = []
        for fb in ref_boxes:
            xs = [float(fb[i]) for i in (0, 2, 4, 6)]
            col_x.append((min(xs), max(xs)))
        # 表头条带 y 范围
        hb = np.array(cell_bboxes[0]).flatten()
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


def _sort_lines_bands(lines: list[dict]) -> list[dict]:
    """行带排序：y 相近（≤0.6×行高）的检测框视为同一视觉行，行内按 x 排序。
    直接按 (y,x) 排序时，同行两个框几像素的 y 抖动就会把后文排到前文前面（实测问题）。"""
    if len(lines) <= 1:
        return list(lines)
    rest = sorted(lines, key=lambda b: b["box"][1])
    ordered: list[dict] = []
    band: list[dict] = []
    for l in rest:
        if not band:
            band = [l]
            continue
        ref_h = max(band[0]["box"][3] - band[0]["box"][1], l["box"][3] - l["box"][1], 1)
        if abs(l["box"][1] - band[-1]["box"][1]) <= 0.6 * ref_h:
            band.append(l)
        else:
            ordered.extend(sorted(band, key=lambda b: b["box"][0]))
            band = [l]
    ordered.extend(_merge_band_fragments(sorted(band, key=lambda b: b["box"][0])))
    return ordered


def _merge_band_fragments(band: list[dict]) -> list[dict]:
    """同行内 x 相邻的检测碎片合并为一个视觉行（OCR 检测有时把一行切成
    左右两个框 —— 不并掉的话段落逻辑会把一行拆成两段）。"""
    if len(band) <= 1:
        return band
    heights = sorted(b["box"][3] - b["box"][1] for b in band)
    med_h = max(8.0, float(heights[len(heights) // 2]))
    merged = [dict(band[0])]
    for b in band[1:]:
        gap = b["box"][0] - merged[-1]["box"][2]
        if gap <= 0.8 * med_h:
            merged[-1]["text"] += (" " if gap > 0.25 * med_h else "") + b["text"]
            merged[-1]["box"] = (merged[-1]["box"][0], min(merged[-1]["box"][1], b["box"][1]),
                                 b["box"][2], max(merged[-1]["box"][3], b["box"][3]))
        else:
            merged.append(dict(b))
    return merged


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

    for l in _sort_lines_bands(lines):
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
            is_bullet = text.startswith(bullets)
            starts_md = text.startswith(md_prefix)
            has_content = bool(content_re.search(text))

            # v4 先做列表：• 前缀行永不被误判成标题（列表判定优先于标题）
            if numbered:
                close()
                m = num_re.match(text)
                cur = {"type": "l", "text": f"{m.group(1)}. {text[m.end():]}", "box": (x1, y1, x2, y2)}
                prev_bottom = y2
                continue
            if is_bullet:
                close()
                cur = {"type": "l", "text": text.lstrip("".join(bullets)).strip(), "box": (x1, y1, x2, y2)}
                prev_bottom = y2
                continue

            # 列表块的续行优先并入（"• xxx"换行后的第二行没有 • 前缀，几何上像标题，
            # 但它挂在列表块下且间距紧 —— 按续行处理，v4 实测修"列表项被拆成标题"）
            if cur is not None and cur["type"] == "l":
                px1, py1, px2, py2 = cur["box"]
                v_gap = y1 - py2
                x_overlap = min(x2, px2) - max(x1, px1)
                min_w = max(1.0, min(x2 - x1, px2 - px1))
                gap_limit = max(1.2 * med_h, 12.0)
                if v_gap <= gap_limit and x_overlap > 0.3 * min_w:
                    cur["text"] += " " + text
                    cur["box"] = (min(px1, x1), min(py1, y1), max(px2, x2), max(py2, y2))
                    prev_bottom = y2
                    continue

            # v6（文字识别定位简化）：不再猜标题 —— 加粗标题的几何特征与正文相同，
            # 猜测误判率高于收益（用户反馈"该换行的地方不换行/标题判定错误"）。
            # 文字识别 = 纯文字 + 段落结构 + 列表；标题/表格交给智能识别。
            # 段落断点（新段判定，命中任一即断）：
            #   a) 行距 > 1.9×本页典型行距
            #   b) 与上一行水平重叠不足 40%（缩进/居中短行）
            starts_new_para = False
            if cur is not None:
                px1, py1, px2, py2 = cur["box"]
                v_gap = y1 - py2
                x_overlap = min(x2, px2) - max(x1, px1)
                min_w = max(1.0, min(x2 - x1, px2 - px1))
                # 段落断点主信号：行间距 > 0.55×行高（行框含上下降部，
                # 段内 leading 挤在框内，段间 margin 必然超过此值；页间自适应）
                if v_gap > 0.55 * med_h:
                    starts_new_para = True
                if x_overlap < 0.4 * min_w:
                    starts_new_para = True
            if starts_new_para:
                close()
                cur = {"type": "p", "text": text, "box": (x1, y1, x2, y2)}
                prev_bottom = y2
                continue
            # 普通行：与当前段合并（间距/重叠兜底判定）
            if cur is not None:
                px1, py1, px2, py2 = cur["box"]
                v_gap = y1 - py2
                x_overlap = min(x2, px2) - max(x1, px1)
                min_w = max(1.0, min(x2 - x1, px2 - px1))
                open_ended = not cur["text"].rstrip().endswith(sent_end)
                gap_limit = 0.55 * med_h * (1.3 if open_ended else 1.0)
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


def _infer_with_fallback(fn):
    """DML 偶发不稳的兜底：推理抛错且当前是 GPU 后端 → 重建 CPU 引擎重试一次。"""
    global _engine, _engine_backend
    try:
        return fn(get_engine())
    except Exception as e:  # noqa: BLE001
        if _engine_backend != "dml":
            raise
        print(f"[rapidocr-service] DML 推理失败({e})，本次换 CPU 重试", file=sys.stderr, flush=True)
        import rapidocr
        _engine = rapidocr.RapidOCR(params={
            "Global.use_cls": False,
            "Global.use_preprocess_img": False,
            "Global.max_side_len": 4000,
        })
        _engine_backend = "cpu"
        return fn(_engine)


def ocr_image(image_b64: str) -> dict:
    if image_b64.startswith("data:"):
        _, image_b64 = image_b64.split(",", 1)
    raw = base64.b64decode(image_b64)
    img = Image.open(io.BytesIO(raw))
    t0 = time.time()
    r = _infer_with_fallback(lambda eng: eng(img))
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


TITLE_CLASSES = ("paragraph_title", "doc_title", "title", "heading")
TABLE_CLASSES = ("table",)
FIGURE_CLASSES = ("figure", "image")


def smart_recognize(image_b64: str) -> dict:
    """智能识别 v2：版面分析分区 + 单次全图 OCR + 行归属分配。

    v1 对每个区域单独跑完整 OCR（5 区域 = 5 次检测+识别，7-9s）；
    v2 全图只跑一次 OCR，版面区域仅决定行的格式处理方式（标题/正文/表格），
    行按中心点归属到区域 —— 总耗时 = 版面 0.6s + 全图 OCR 1.6s（+表格区各自的表格模型）。"""
    if image_b64.startswith("data:"):
        _, image_b64 = image_b64.split(",", 1)
    raw = base64.b64decode(image_b64)
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    arr = np.array(img)
    H, W = arr.shape[:2]
    t0 = time.time()

    # 1) 版面分区
    layout = get_layout_engine()(arr)
    names = list(getattr(layout, "class_names", None) or [])
    raw_boxes = list(getattr(layout, "boxes", None) or [])
    regions = []
    for i, b in enumerate(raw_boxes):
        try:
            flat = np.array(b, dtype=float).flatten()
        except Exception:
            continue
        if flat.size < 4:
            continue
        x1 = max(0, int(flat[0]) - 4); y1 = max(0, int(flat[1]) - 4)
        x2 = min(W, int(flat[2]) + 4); y2 = min(H, int(flat[3]) + 4)
        if x2 - x1 < 8 or y2 - y1 < 8:
            continue
        regions.append({"box": (x1, y1, x2, y2), "cls": (names[i] if i < len(names) else "text").lower()})

    # 2) 单次全图 OCR
    r2 = get_engine()(img)
    all_lines = []
    txts = list(r2.txts) if r2.txts is not None else []
    bxss = list(r2.boxes) if r2.boxes is not None else []
    for t, b in zip(txts, bxss):
        xs = [float(pt[0]) for pt in b]; ys = [float(pt[1]) for pt in b]
        all_lines.append({"text": t, "box": (min(xs), min(ys), max(xs), max(ys))})

    # 3) 行按中心点归属区域（版面没覆盖到的行归入伪区域，按 y 走阅读顺序）
    def contains(reg, line):
        cx = (line["box"][0] + line["box"][2]) / 2
        cy = (line["box"][1] + line["box"][3]) / 2
        return reg["box"][0] <= cx <= reg["box"][2] and reg["box"][1] <= cy <= reg["box"][3]

    assigned: dict[int, list] = {i: [] for i in range(len(regions))}
    leftovers = []
    for line in all_lines:
        hit = next((i for i, reg in enumerate(regions) if contains(reg, line)), None)
        if hit is None:
            leftovers.append(line)
        else:
            assigned[hit].append(line)

    # 4) 表格区域：裁剪走表格模型（含几何兜底）
    table_md: dict[int, str] = {}
    for i, reg in enumerate(regions):
        if not any(k in reg["cls"] for k in TABLE_CLASSES):
            continue
        x1, y1, x2, y2 = reg["box"]
        crop = img.crop((x1, y1, x2, y2))
        buf = io.BytesIO(); crop.save(buf, "PNG")
        try:
            tr = table_recognize("data:image/png;base64," + base64.b64encode(buf.getvalue()).decode())
            md_table = _html_to_md_table(tr.get("html") or "")
            if md_table:
                table_md[i] = md_table
        except Exception:  # noqa: BLE001 表格失败退回文本行
            pass

    # 5) 行带组装：表格区/文本区/未归属行统一按 (y,x) 排序合成
    items: list[dict] = []
    for i, reg in enumerate(regions):
        if i in table_md:
            items.append({"y": reg["box"][1], "x": reg["box"][0], "kind": "md", "text": table_md[i]})
            continue
        lines_i = assigned.get(i, [])
        if not lines_i:
            continue
        if any(k in reg["cls"] for k in TITLE_CLASSES):
            title_text = " ".join(l["text"].strip() for l in _sort_lines_bands(lines_i) if l["text"].strip())
            if title_text:
                items.append({"y": reg["box"][1], "x": reg["box"][0], "kind": "md", "text": "## " + title_text})
            continue
        if any(k in reg["cls"] for k in FIGURE_CLASSES) and not lines_i:
            items.append({"y": reg["box"][1], "x": reg["box"][0], "kind": "md", "text": "[图片]"})
            continue
        blocks = _build_markdown(lines_i)
        NL = chr(10)
        text = NL.join(
            ("## " + b["text"]) if b["type"] == "h" else ("- " + b["text"]) if b["type"] == "l" else b["text"]
            for b in blocks
        )
        items.append({"y": min(l["box"][1] for l in lines_i), "x": min(l["box"][0] for l in lines_i),
                      "kind": "text", "text": text})
    for line in leftovers:
        items.append({"y": line["box"][1], "x": line["box"][0], "kind": "text", "text": line["text"]})

    items.sort(key=lambda it: (it["y"], it["x"]))
    NL2 = chr(10) * 2
    markdown = NL2.join(it["text"] for it in items if it["text"])
    return {"ok": True, "ms": int((time.time() - t0) * 1000), "regions": len(regions),
            "markdown": markdown}



# ── 原位翻译：Hy-MT2(llama.cpp 端侧模型，无 paddle) + 背景采样擦写回填 ──

from pathlib import Path as _Path
PROJECT = _Path(__file__).resolve().parent

_FONT_CANDIDATES = [
    os.path.join(PROJECT, "models", "fonts", "PingFang-SC-Regular.ttf"),
    os.path.join(PROJECT, "models", "fonts", "simfang.ttf"),
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simsun.ttc",
]
_font_path_cache = None
_mt_engine = None


def _pick_font_path():
    global _font_path_cache
    if _font_path_cache is not None:
        return _font_path_cache or None
    for fp in _FONT_CANDIDATES:
        if os.path.exists(fp):
            _font_path_cache = fp
            return fp
    _font_path_cache = ""
    return None


def get_mt_engine():
    """Hy-MT2 端侧翻译（llama-server 子进程，首次调用时拉起）。
    CUDA 构建的 llama-server 走 GPU 卸载（失败时 llama.cpp 自回退 CPU）。"""
    global _mt_engine
    if _mt_engine is None:
        os.environ.setdefault("MT_NGL", "99")
        sys.path.insert(0, str(PROJECT))
        from screenshot_tool import mt_engine
        _mt_engine = mt_engine
    return _mt_engine


def _greedy_wrap(draw, text: str, font, max_w: float) -> str:
    """按宽度贪心换行：西文按词、超宽词/CJK 按字断行。"""
    import re as _re
    lines: list[str] = []
    text = " ".join(text.splitlines())

    def _push_chunk(chunk: str) -> str:
        cur = ""
        for ch in chunk:
            trial = cur + ch
            if draw.textlength(trial, font=font) <= max_w or not cur:
                cur = trial
            else:
                lines.append(cur)
                cur = ch
        return cur

    cur = ""
    for token in _re.split(r"(\s+)", text):
        if not token:
            continue
        if draw.textlength(cur + token, font=font) <= max_w:
            cur += token
            continue
        if token.isspace():
            lines.append(cur)
            cur = ""
            continue
        if not cur:
            cur = _push_chunk(token)
        else:
            lines.append(cur)
            cur = _push_chunk(token)
    if cur:
        lines.append(cur)
    return "\n".join(lines)


def _fit_paragraph(draw, text: str, font_path: str, max_w: float, start_h: float, max_h: float):
    """选一个能让整段文本在 max_w 内排下、且总高不超过 max_h 的字号。"""
    from PIL import ImageFont
    start = max(9, min(int(start_h), 64))
    best = None
    for size in range(start, 8, -1):
        font = ImageFont.truetype(font_path, size)
        wrapped = _greedy_wrap(draw, text, font, max_w)
        tb = draw.multiline_textbbox((0, 0), wrapped, font=font, spacing=4)
        w, h = tb[2] - tb[0], tb[3] - tb[1]
        if w <= max_w:
            if h <= max_h:
                return font, wrapped
            best = best or (font, wrapped)
    fallback_font = ImageFont.truetype(font_path, 9)
    return best if best else (fallback_font, _greedy_wrap(draw, text, fallback_font, max_w))


def _fit_paragraph_lines(draw, text: str, font_path: str, max_w: float, start_h: float, target_lines: int, max_h: float):
    """排版对齐（用户要求译文布局贴近原文）：
    从原字号往下找"换行后行数 ≤ 原文行数、行宽 ≤ 框宽、总高 ≈ 原框高"的最大字号，
    使译文块的位置/行数/占位与原文一致，而不是自由缩放+向下扩展。"""
    from PIL import ImageFont
    target_lines = max(1, int(target_lines))
    start = max(9, min(int(start_h), 64))
    best = None
    for size in range(start, 8, -1):
        font = ImageFont.truetype(font_path, size)
        wrapped = _greedy_wrap(draw, text, font, max_w)
        n = wrapped.count("\n") + 1
        if n > target_lines:
            continue
        tb = draw.multiline_textbbox((0, 0), wrapped, font=font, spacing=4)
        w, h = tb[2] - tb[0], tb[3] - tb[1]
        if w <= max_w and h <= max_h:
            return font, wrapped
        best = best or (font, wrapped)
    fallback_font = ImageFont.truetype(font_path, 9)
    return best if best else (fallback_font, _greedy_wrap(draw, text, fallback_font, max_w))


def _sample_bg_color(img, box, pad: int = 10):
    """取段落框四周边带的像素中位色，作为擦除底色（近似背景）。"""
    W, H = img.size
    x1, y1, x2, y2 = box
    x1, y1 = max(0, int(x1)), max(0, int(y1))
    x2, y2 = min(W, int(x2)), min(H, int(y2))
    strips = []
    if y1 - pad >= 0:
        strips.append(np.asarray(img.crop((x1, y1 - pad, x2, y1))))
    if y2 + pad <= H:
        strips.append(np.asarray(img.crop((x1, y2, x2, y2 + pad))))
    if x1 - pad >= 0:
        strips.append(np.asarray(img.crop((x1 - pad, y1, x1, y2))))
    if x2 + pad <= W:
        strips.append(np.asarray(img.crop((x2, y1, x2 + pad, y2))))
    if not strips:
        return (252, 252, 252)
    px = np.concatenate([st.reshape(-1, st.shape[-1]) for st in strips])
    med = np.median(px, axis=0).astype(int)
    return tuple(int(v) for v in med[:3])


def _inpaint_text(region, paragraphs: list[dict]) -> bool:
    """原位擦字：对每个段落框构建"文字笔画掩码"（与背景色差异显著的像素），
    cv2.inpaint 只修复笔画像素——背景渐变/图像保留，视觉上即"原文被擦掉"。
    任一段落修复失败返回 False（调用方回退色块填充）。"""
    try:
        import cv2
        arr = np.array(region.convert("RGB"))
        H, W = arr.shape[:2]
        for para in paragraphs:
            x1, y1, x2, y2 = para["box"]
            pad = 4
            cx1, cy1 = max(0, int(x1) - pad), max(0, int(y1) - pad)
            cx2, cy2 = min(W, int(x2) + pad), min(H, int(y2) + pad)
            if cx2 - cx1 < 4 or cy2 - cy1 < 4:
                continue
            crop = arr[cy1:cy2, cx1:cx2]
            # 背景估计 = 大核中值滤波（文字笔画被周围吞掉，保留渐变/卡片底），
            # 掩码 = 像素与背景估计的差异（比单一背景色更适配深浅混排/渐变）
            k = max(3, (min(crop.shape[:2]) // 2) * 2 + 1)
            bg_est = cv2.medianBlur(crop, min(k, 51))
            dist = np.sqrt(((crop.astype(np.int32) - bg_est.astype(np.int32)) ** 2).sum(axis=2))
            mask = (dist > 55).astype(np.uint8) * 255
            if mask.sum() == 0 or mask.mean() > 230:  # 无文字 / 掩码异常铺满 → 跳过该段
                continue
            mask = cv2.dilate(mask, np.ones((3, 3), np.uint8), iterations=2)
            repaired = cv2.inpaint(crop, mask, 3, cv2.INPAINT_TELEA)
            arr[cy1:cy2, cx1:cx2] = repaired
        out = Image.fromarray(arr)
        region.paste(out)
        return True
    except Exception as e:  # noqa: BLE001
        print(f"[rapidocr-service] inpaint 失败，回退色块: {e}", file=sys.stderr, flush=True)
        return False


def _annotate(region, paragraphs: list[dict], translations: list[str]):
    """段落级原位翻译：先 inpaint 擦除原文笔画（保留背景），再回填译文；
    inpaint 不可用时回退"背景色整块填充"（旧效果）。"""
    from PIL import ImageDraw
    img = region.convert("RGB").copy()
    drew_text = [False]
    font_path = _pick_font_path()
    for para, tr in zip(paragraphs, translations):
        if tr and tr.strip():
            drew_text[0] = True
            break
    # 先擦除（整批一次），再统一画译文
    need_erase = drew_text[0]
    erased = _inpaint_text(img, [pa for pa, tr in zip(paragraphs, translations) if tr and tr.strip()]) if need_erase else False
    if not erased:
        draw0 = ImageDraw.Draw(img)
        for para, tr in zip(paragraphs, translations):
            if not tr or not tr.strip():
                continue
            x1, y1, x2, y2 = para["box"]
            bg = _sample_bg_color(img, para["box"], pad=8)
            draw0.rectangle([x1 - 2, y1 - 2, x2 + 2, y2 + 2], fill=bg)
    draw = ImageDraw.Draw(img)
    for para, tr in zip(paragraphs, translations):
        if not tr or not tr.strip():
            continue
        x1, y1, x2, y2 = para["box"]
        pad = 6
        if not font_path:
            continue
        bg = _sample_bg_color(img, para["box"], pad=8)
        lum = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2]
        fg = (28, 28, 28) if lum >= 128 else (240, 240, 240)
        max_w = max((x2 - x1) + pad * 2, 24)
        # 排版对齐：译文限定在原文占位框内，行数对齐原文行结构
        box_h = max(12.0, y2 - y1)
        target_lines = max(1, round(box_h / max(para["line_h"], 6.0)))
        avail_h = min(box_h * 1.25 + 6, img.height - y1 - 4)
        font, wrapped = _fit_paragraph_lines(draw, tr, font_path, max_w, para["line_h"] * 0.95, target_lines, avail_h)
        draw.multiline_text((x1 - pad, y1), wrapped, font=font, fill=fg, spacing=4)
    return img


def translate_image(image_b64: str, target: str) -> dict:
    """轻量原位翻译：RapidOCR(DML) 认字 → Hy-MT2 端侧翻译 → PIL 擦写回填。
    全程无 paddle。"""
    if image_b64.startswith("data:"):
        _, image_b64 = image_b64.split(",", 1)
    raw = base64.b64decode(image_b64)
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    t0 = time.time()

    r = get_engine()(img)
    txts = list(r.txts) if r.txts is not None else []
    boxes = list(r.boxes) if r.boxes is not None else []
    lines = []
    for t, b in zip(txts, boxes):
        xs = [float(pt[0]) for pt in b]
        ys = [float(pt[1]) for pt in b]
        lines.append({"text": t, "box": (min(xs), min(ys), max(xs), max(ys))})
    if not lines:
        return {"ok": True, "image": "", "text": "", "lines": [],
                "fallback": "no_text", "ms": int((time.time() - t0) * 1000)}

    paragraphs = _group_paragraphs(lines)
    mt = get_mt_engine()
    SEP = chr(10) + "@@P@@" + chr(10)
    translations: list[str] = []
    if len(paragraphs) > 1:
        # 合批：一次 llama 调用翻所有段落（省 N-1 次提示处理开销）
        try:
            joined = mt.translate(SEP.join(pa["text"] for pa in paragraphs), target)
            parts = [x.strip() for x in joined.replace("@@ P @@", "@@P@@").split("@@P@@")]
            parts = [x for x in parts if x]
            if len(parts) == len(paragraphs):
                translations = parts
        except Exception as e:  # noqa: BLE001
            print(f"[rapidocr-service] MT 合批失败: {e}", file=sys.stderr, flush=True)
    for i, pa in enumerate(paragraphs):
        if i < len(translations):
            continue
        try:
            tr = mt.translate(pa["text"], target)
        except Exception as e:  # noqa: BLE001
            print(f"[rapidocr-service] MT 失败: {e}", file=sys.stderr, flush=True)
            tr = ""
        translations.append(tr)

    annotated = _annotate(img, paragraphs, translations)
    buf = io.BytesIO()
    annotated.save(buf, "PNG")
    ms = int((time.time() - t0) * 1000)
    print(f"[rapidocr-service] translate_image: {len(paragraphs)} 段 {ms}ms", file=sys.stderr, flush=True)
    return {
        "ok": True,
        "image": "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode(),
        "text": "\n".join(t for t in translations if t.strip()),
        "lines": [{"text": pa["text"], "box": [round(v, 1) for v in pa["box"]]} for pa in paragraphs],
        "ms": ms,
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
            self._json(200, {"ok": True, "model": MODEL_TAG, "backend": _engine_backend,
                             "build": "v4-align"})
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
        elif self.path.startswith("/translate_image"):
            try:
                length = int(self.headers.get("Content-Length", 0))
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                self._json(200, translate_image(payload.get("image_b64", ""),
                                                payload.get("target", "中文")))
            except Exception as e:  # noqa: BLE001
                self._json(500, {"ok": False, "error": str(e)})
        elif self.path.startswith("/smart"):
            try:
                length = int(self.headers.get("Content-Length", 0))
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                self._json(200, smart_recognize(payload.get("image_b64", "")))
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


def _prewarm_mt():
    """后台预热翻译引擎（拉起 llama-server + GPU 加载 Hy-MT2），首次点击翻译即热。"""
    def _run():
        try:
            mt = get_mt_engine()
            mt.translate("预热", "英语")
            print("[rapidocr-service] MT 预热完成", file=sys.stderr, flush=True)
        except Exception as e:  # noqa: BLE001
            print(f"[rapidocr-service] MT 预热失败（翻译时将重试）: {e}", file=sys.stderr, flush=True)
    threading.Thread(target=_run, daemon=True).start()


if __name__ == "__main__":
    t0 = time.time()
    eng = get_engine()
    # DML 运行时降级：构造成功 ≠ 推理可用（首推可能瞬时失败），
    # 预热一张小图验证；失败则换 CPU 引擎重建
    try:
        eng(np.zeros((32, 32, 3), dtype=np.uint8))
    except Exception as e:  # noqa: BLE001
        print(f"[rapidocr-service] DML 预热失败({e})，降级 CPU", file=sys.stderr, flush=True)
        import rapidocr
        _engine = rapidocr.RapidOCR(params={
            "Global.use_cls": False,
            "Global.use_preprocess_img": False,
            "Global.max_side_len": 4000,
        })
        _engine_backend = "cpu"
        _engine(np.zeros((32, 32, 3), dtype=np.uint8))
    get_table_engine()
    print(f"[rapidocr-service] {MODEL_TAG} ready in {time.time()-t0:.1f}s, port {PORT}", file=sys.stderr, flush=True)
    threading.Thread(target=_prewarm_mt, daemon=True).start()
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()

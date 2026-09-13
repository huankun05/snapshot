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
        # 截图场景提速：关方向分类（横排文字不需要）、放宽预处理尺寸上限
        # （截图多为高清大图，2000 上限会触发缩放-放大来回损失清晰度也费时）
        _engine = RapidOCR(params={
            "Global.use_cls": False,
            "Global.use_preprocess_img": False,
            "Global.max_side_len": 4000,
        })
    return _engine


_layout_engine = None


def get_layout_engine():
    """版面分析（PP-DocLayoutV3/ONNX）：区域分类 + 坐标，供智能识别分流"""
    global _layout_engine
    if _layout_engine is None:
        from rapid_layout import RapidLayout, RapidLayoutInput, ModelType
        _layout_engine = RapidLayout(RapidLayoutInput(model_type=ModelType.PP_DOC_LAYOUTV3))
    return _layout_engine


def get_table_engine():
    """表格结构还原（SLANet-plus，首次调用时初始化/下载模型）"""
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
            if cell_bboxes:
                # 只保留模型表格范围内的行（选区常含表格外内容，会被几何重建误当表格行）
                gy1 = min(min(float(bb[i]) for i in (1, 3, 5, 7)) for bb in cell_bboxes) - 4
                gy2 = max(max(float(bb[i]) for i in (1, 3, 5, 7)) for bb in cell_bboxes) + 4
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


if __name__ == "__main__":
    t0 = time.time()
    get_engine()
    print(f"[rapidocr-service] {MODEL_TAG} ready in {time.time()-t0:.1f}s, port {PORT}", file=sys.stderr, flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()

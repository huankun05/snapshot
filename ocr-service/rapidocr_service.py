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
import ctypes
import hashlib
import io
import json
import os
import sys
import time
import subprocess
import threading
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from PIL import Image
from rapidocr import RapidOCR

# /uia 的坐标语义：Electron 主进程按「物理像素」传点、按物理像素读回矩形。
# Python 默认不是 DPI 感知进程（150% 缩放下把物理坐标当逻辑坐标命中 1.5 倍远处的元素、
# 返回的逻辑矩形又被按物理处理——框落在光标附近但错一行，2026-09-17 智能选区诊断根因③）。
# 必须在任何窗口/坐标 API 之前声明 Per-Monitor V2。
try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)  # PER_MONITOR_AWARE_V2
except Exception:  # noqa: BLE001  旧系统退回 system aware
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:  # noqa: BLE001
        pass


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


# ── 可选模型手动下载（2026-11-22 缺口1）：/table /smart 对缺失模型报 modelMissing，
#    由设置窗「可选资产」显式下载（POST /models/download），不再静默联网拉取。──

def _assets_dir() -> "Path | None":
    """自定义资产目录（PETALSNAP_ASSETS_DIR，设置 → 识别 → 识别资源 → 存放位置）；空 = 包内默认"""
    from pathlib import Path as _P
    d = os.environ.get("PETALSNAP_ASSETS_DIR", "").strip()
    return _P(d) if d else None


def _optional_model_paths() -> dict:
    """可选模型落盘路径：自定义资产目录优先（存在即用），否则 venv 包内（与 _model_inventory 同源）"""
    from pathlib import Path as _P
    assets = _assets_dir()
    paths: dict = {}
    try:
        import rapid_layout as _rl
        pkg = _P(_rl.__file__).resolve().parent / "models" / "pp_doc_layoutv3.onnx"
        paths["layout"] = (assets / "pp_doc_layoutv3.onnx") if (assets and (assets / "pp_doc_layoutv3.onnx").exists()) else pkg
    except Exception:  # noqa: BLE001
        paths["layout"] = None
    try:
        import rapid_table as _rt
        pkg = _P(_rt.__file__).resolve().parent / "models" / "slanet-plus.onnx"
        paths["table"] = (assets / "slanet-plus.onnx") if (assets and (assets / "slanet-plus.onnx").exists()) else pkg
    except Exception:  # noqa: BLE001
        paths["table"] = None
    return paths


_MODEL_DOWNLOAD_URLS = {
    "layout": "https://www.modelscope.cn/models/RapidAI/RapidLayout/resolve/v1.2.0/onnx/pp_doc_layout/pp_doc_layoutv3.onnx",
    "table": "https://www.modelscope.cn/models/RapidAI/RapidTable/resolve/v2.0.0/slanet-plus.onnx",
}
_model_download_lock = threading.Lock()


def download_optional_model(model_id: str) -> dict:
    """手动下载可选模型；落盘位置 = 自定义资产目录（若设置）否则 venv 包内；白名单 URL，.part 原子替换"""
    path = _optional_model_paths().get(model_id)
    url = _MODEL_DOWNLOAD_URLS.get(model_id)
    if path is None or url is None:
        return {"ok": False, "message": f"未知模型 id: {model_id}"}
    if path.exists():
        return {"ok": True, "message": "模型已就绪", "size_mb": round(path.stat().st_size / 1024 / 1024, 1)}
    assets = _assets_dir()
    if assets is not None:
        # 自定义目录下还没有该模型 → 下载目标切换到自定义目录（包内旧文件不迁移，查找时自定义优先）
        path = assets / path.name
    if not _model_download_lock.acquire(blocking=False):
        return {"ok": False, "inProgress": True, "message": "已有下载在进行中，请稍后再试"}
    tmp = path.with_suffix(path.suffix + ".part")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        import urllib.request
        print(f"[model-download] {model_id} ← {url}", file=sys.stderr, flush=True)
        urllib.request.urlretrieve(url, tmp)  # noqa: S310 固定白名单 URL
        tmp.rename(path)
        size = round(path.stat().st_size / 1024 / 1024, 1)
        print(f"[model-download] {model_id} 完成 {size}MB", file=sys.stderr, flush=True)
        return {"ok": True, "message": "下载完成", "size_mb": size}
    except Exception as e:  # noqa: BLE001
        try:
            if tmp.exists():
                tmp.unlink()
        except Exception:  # noqa: BLE001
            pass
        return {"ok": False, "message": f"下载失败: {e}"}
    finally:
        _model_download_lock.release()


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
    return table_recognize_raw(base64.b64decode(image_b64))


def table_recognize_raw(raw: bytes) -> dict:
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


def _find_gutter(items: list[dict], axis: str, med_h: float, g_lo: float, g_hi: float, total_h: float):
    """在指定轴上找"完全无框"的沟带。axis='x' 纵缝(切左右)、'y' 横缝(切上下)。
    沟带 [s, s+gap_min] 内不允许任何框与之相交,唯一例外:整幅横贯的元素
    (x 向切时框横跨整个内容宽度,如标题横幅)——它们作为 cross 上升为独立块。
    返回 (起点, 沟宽) 或 None。两侧内容各 ≥10% 总高。"""
    gap_min = max(26.0, 1.2 * med_h) if axis == "x" else max(26.0, 2.2 * med_h)
    end_i = 2 if axis == "x" else 3
    start_i = 0 if axis == "x" else 1
    lo = min(b[start_i] for b in (it["box"] for it in items))
    hi = max(b[end_i] for b in (it["box"] for it in items))
    tol = 2.0
    best_s: float | None = None
    left_min = 0.10 * total_h
    for s in sorted({round(b[end_i], 1) for b in (it["box"] for it in items)}):
        ge = s + gap_min
        left_h = right_h = cross_h = 0.0
        valid = True
        for it in items:
            x1, y1, x2, y2 = it["box"]
            lo_v, hi_v = (x1, x2) if axis == "x" else (y1, y2)
            h = y2 - y1
            if hi_v <= s:
                left_h += h
            elif lo_v >= ge:
                right_h += h
            elif lo_v <= lo + tol and hi_v >= hi - tol:
                cross_h += h  # 整幅横贯(标题横幅)豁免
            else:
                valid = False
                break
        # 横幅豁免的权重校验:横贯元素只能占小头(≤1.5 行高,且 ≤ 两侧较小者的
        # 一半)——否则是"参差段落碰出的幻影沟",不是标题+双栏(2026-10-03 bench_text 误切)
        if not valid or cross_h > max(1.5 * med_h, 0.5 * min(left_h, right_h)):
            continue
        if left_h < left_min or (total_h - left_h) < left_min:
            continue
        best_s = s
        break  # 边缘序第一个可行沟即最靠上的,取它(配合两侧比例约束足够)
    if best_s is None:
        return None
    return best_s, gap_min


def _detect_column_groups(items: list[dict], depth: int = 0, med_h_g: float | None = None) -> list[list[dict]]:
    """板块(区块)检测 v3：XY 双向递归切割,沟带必须完全无框。
    v1 只切竖缝且分区判定会丢整行横跨的元素(气泡被静默丢弃);
    v2 沟带允许 15% 穿越导致碎板块。v3 规则:
      - 每层同时找纵缝/横缝,取更宽的;递归深度 ≤3;
      - 沟带 [s,s+gap] 内不允许任何框,唯一豁免 = 整幅横贯元素(标题横幅),
        它们作为独立 cross 块最先输出;
      - 其余行按"整体在沟左/沟右"严格分区,越界贴边行就近归属(零丢失);
      - med_h 全程用顶层中位数(子集行高变小会让阈值跟着缩,越切越碎)。"""
    if len(items) <= 1 or depth >= 3:
        return [items] if items else []
    boxes = [it["box"] for it in items]
    heights = sorted(b[3] - b[1] for b in boxes)
    med_h = max(8.0, float(heights[len(heights) // 2])) if med_h_g is None else med_h_g
    total_h = float(sum(heights)) or 1.0
    g_x1 = min(b[0] for b in boxes)
    g_x2 = max(b[2] for b in boxes)
    g_y1 = min(b[1] for b in boxes)
    g_y2 = max(b[3] for b in boxes)
    tol = 2.0
    gx = _find_gutter(items, "x", med_h, g_x1, g_x2, total_h)
    # 横缝只在栏内递归(depth ≥1)时启用:顶层段落间距与 UI 块缝无法区分,
    # 顶层横切会把单栏文档切成一段一块(2026-10-03 实测 bench_text 误切)
    gy = _find_gutter(items, "y", med_h, g_y1, g_y2, total_h) if depth >= 1 else None
    if gx and gy:
        if gx[1] >= gy[1]:
            gy = None
        else:
            gx = None

    def _split(axis: str, s: float, gap: float) -> list[list[dict]]:
        ge = s + gap
        start_i = 0 if axis == "x" else 1
        end_i = 2 if axis == "x" else 3
        lo = g_x1 if axis == "x" else g_y1
        hi = g_x2 if axis == "x" else g_y2
        left: list[dict] = []
        right: list[dict] = []
        cross: list[dict] = []
        for it in items:
            b = it["box"]
            lo_v, hi_v = b[start_i], b[end_i]
            if hi_v <= s:
                left.append(it)
            elif lo_v >= ge:
                right.append(it)
            elif lo_v <= lo + tol and hi_v >= hi - tol:
                cross.append(it)  # 整幅横贯(标题横幅)
            else:
                # 理论不可达(沟带已验证无相交框);兜底就近归属,保证零丢失
                mid = s + gap / 2
                (left if (lo_v + hi_v) / 2 <= mid else right).append(it)
        groups: list[list[dict]] = []
        if cross:
            groups.extend(_detect_column_groups(cross, depth + 1, med_h))
        if left:
            groups.extend(_detect_column_groups(left, depth + 1, med_h))
        if right:
            groups.extend(_detect_column_groups(right, depth + 1, med_h))
        return groups

    if gx is not None:
        return _split("x", gx[0], gx[1])
    if gy is not None:
        return _split("y", gy[0], gy[1])
    return [items]


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


# ── AI 超分（Real-ESRGAN x2，onnxruntime DML/CPU，2026-09-28）──────────────
ESR_MODEL_URL = "https://huggingface.co/SceneWorks/real-esrgan-onnx/resolve/main/real_esrgan_x2.onnx"
_ESR_SESS = None
_ESR_LAST_USE = 0.0        # monotonic timestamp for idle release
_ESR_IDLE_RELEASE_S = 300  # 5min no upscale -> release session (~350MB back; model file
                           # stays on disk, next use only ~2s session rebuild)
_ESR_INPUT_LIMIT = 1600

def _esr_idle_check():
    # lazy idle release: checked on each call, no resident thread
    global _ESR_SESS
    if _ESR_SESS is not None and _ESR_LAST_USE and (time.monotonic() - _ESR_LAST_USE) > _ESR_IDLE_RELEASE_S:
        print("[rapidocr-service] AI upscale session idle 5min, released", file=sys.stderr, flush=True)
        _ESR_SESS = None
_ESR_INPUT_LIMIT_UNUSED = None  # 输入最长边上限（小区域截图场景；大图显存/耗时不可控）

def _esr_model_path() -> str:
    root = os.environ.get("PADDLE_PDX_CACHE_HOME") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")
    d = os.path.join(root, "esrgan")
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, "real_esrgan_x2.onnx")

def get_esr_session():
    """懒加载 + 模型缺失自动下载（67MB，一次性）。DML 失败自动回退 CPU。"""
    global _ESR_SESS
    if _ESR_SESS is not None:
        return _ESR_SESS
    import onnxruntime as ort
    path = _esr_model_path()
    if not os.path.exists(path) or os.path.getsize(path) < 1024 * 1024:
        print(f"[rapidocr-service] 下载 AI 超分模型 (67MB): {ESR_MODEL_URL}", file=sys.stderr, flush=True)
        import urllib.request
        tmp = path + ".tmp"
        urllib.request.urlretrieve(ESR_MODEL_URL, tmp)
        os.replace(tmp, path)
        print("[rapidocr-service] AI 超分模型下载完成", file=sys.stderr, flush=True)
    try:
        _ESR_SESS = ort.InferenceSession(path, providers=["DmlExecutionProvider", "CPUExecutionProvider"])
        print(f"[rapidocr-service] AI 超分会话就绪 providers={_ESR_SESS.get_providers()}", file=sys.stderr, flush=True)
    except Exception:
        _ESR_SESS = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
    return _ESR_SESS

def upscale_image_raw(raw: bytes):
    """PNG 字节 → 2× PNG 字节。返回 (png_bytes, method)。"""
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    w, h = img.size
    if max(w, h) > _ESR_INPUT_LIMIT:
        raise ValueError(f"图像过大（{w}x{h}），超分要求最长边 ≤{_ESR_INPUT_LIMIT}px")
    global _ESR_LAST_USE
    _esr_idle_check()
    sess = get_esr_session()
    _ESR_LAST_USE = time.monotonic()
    arr = np.asarray(img, dtype=np.float32) / 255.0
    x = arr.transpose(2, 0, 1)[None]
    inp_name = sess.get_inputs()[0].name
    out = sess.run(None, {inp_name: x})[0][0]
    out = np.clip(out.transpose(1, 2, 0), 0.0, 1.0)
    up = Image.fromarray((out * 255.0).round().astype(np.uint8))
    buf = io.BytesIO()
    up.save(buf, "PNG")
    return buf.getvalue(), "esrgan"

def ocr_image(image_b64: str) -> dict:
    if image_b64.startswith("data:"):
        _, image_b64 = image_b64.split(",", 1)
    return ocr_image_raw(base64.b64decode(image_b64))


def ocr_image_raw(raw: bytes) -> dict:
    """二进制通道入口（2026-09-28）：body 即 PNG 字节，免 base64 解码。"""
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
    line_items = [{"text": l["text"], "box": tuple(l["box"])} for l in lines]
    col_groups = _detect_column_groups(line_items)
    # 碎片板块合并：文字总高 < ~2 行的迷你组并入 bbox 最近的组——右下角时间戳/
    # 撤销按钮这类零散小字不该自成一板块(2026-10-03 用户实测"模块识别不准")
    if len(col_groups) > 2:
        all_h = sorted(it["box"][3] - it["box"][1] for g in col_groups for it in g)
        med_h_all = max(8.0, float(all_h[len(all_h) // 2]))
        tiny_th = 3.2 * med_h_all

        def _gbox(g: list[dict]) -> tuple[float, float, float, float]:
            return (min(it["box"][0] for it in g), min(it["box"][1] for it in g),
                    max(it["box"][2] for it in g), max(it["box"][3] for it in g))

        changed = True
        while changed and len(col_groups) > 2:
            changed = False
            for gi, g in enumerate(col_groups):
                if sum(it["box"][3] - it["box"][1] for it in g) >= tiny_th:
                    continue
                gb = _gbox(g)
                best_j: int | None = None
                best_d: float | None = None
                for gj, g2 in enumerate(col_groups):
                    if gj == gi:
                        continue
                    gb2 = _gbox(g2)
                    dx = max(gb2[0] - gb[2], gb[0] - gb2[2], 0.0)
                    dy = max(gb2[1] - gb[3], gb[1] - gb2[3], 0.0)
                    d = dx + dy
                    if best_d is None or d < best_d:
                        best_d, best_j = d, gj
                if best_j is not None and best_d is not None and best_d <= 10.0 * med_h_all:
                    col_groups[best_j] = col_groups[best_j] + g
                    col_groups.pop(gi)
                    changed = True
                    break

    def _render_column(items: list[dict]) -> str:
        blocks = _build_markdown(items)
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
        return "\n".join(md_lines)

    # 多板块：每栏独立走段落/格式逻辑，栏间用分隔线，阅读序 = 栏序(2026-10-02 板块划分)
    # modules 供渲染端"按原排版分块展示、逐块复制"(box = 该栏所有行的包围盒)
    paras: list[dict] = []
    modules: list[dict] = []
    import re as _re_mod
    for g in col_groups:
        paras.extend(_group_paragraphs(g))
        md = _render_column(g)
        # 纯文本 = 去 Markdown 标记（标题/列表符号/分隔线），保留内容本身——
        # 注意是"剥标记"不是"丢行"：列表块可能整块是一行("- a b")，丢行会清空整栏
        plain_lines: list[str] = []
        for ln in md.splitlines():
            s = ln.strip()
            if not s or s == "---":
                continue
            s = _re_mod.sub(r"^#{1,6}\s+", "", s)
            s = _re_mod.sub(r"^[-*+]\s+", "", s)
            s = _re_mod.sub(r"^\d{1,3}[.、．)）]\s+", "", s)
            if s:
                plain_lines.append(s)
        plain = "\n".join(plain_lines)
        gbox = (
            min(it["box"][0] for it in g), min(it["box"][1] for it in g),
            max(it["box"][2] for it in g), max(it["box"][3] for it in g),
        )
        modules.append({"box": [round(v, 1) for v in gbox], "markdown": md, "text": plain})
    if len(col_groups) > 1:
        markdown = "\n\n---\n\n".join(m["markdown"] for m in modules)
    else:
        markdown = _render_column(line_items)
    return {
        "ok": True,
        "ms": ms,
        "lines": lines,
        "paragraphs": [p["text"] for p in paras],
        "modules": modules,
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
    return smart_recognize_raw(base64.b64decode(image_b64))


def smart_recognize_raw(raw: bytes) -> dict:
    """二进制通道入口（2026-09-28）：body 即 PNG 字节，免 base64 解码。"""
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


# ── 翻译/OCR 结果缓存 ────────────────────────────────────
# 翻译是 (文本,目标语言) 的纯函数：面板重开、Esc 重选同区域、translate_batch
# 与 translate_image 的重叠段落全部命中，实测 0ms。LRU 防长会话内存膨胀。
_mt_cache: OrderedDict = OrderedDict()
_MT_CACHE_CAP = 4096
_mt_stats = {"hits": 0}


def _mt_translate(mt, text: str, target: str) -> str:
    if not text or not text.strip():
        return ""
    key = hashlib.sha1(f"{target}\x00{text}".encode("utf-8", "ignore")).hexdigest()
    hit = _mt_cache.get(key)
    if hit is not None:
        _mt_cache.move_to_end(key)
        _mt_stats["hits"] += 1
        return hit
    out = mt.translate(text, target)
    _mt_cache[key] = out
    if len(_mt_cache) > _MT_CACHE_CAP:
        _mt_cache.popitem(last=False)
    return out


_ocr_cache: OrderedDict = OrderedDict()
_OCR_CACHE_CAP = 48


def _ocr_cached(raw: bytes) -> dict:
    """/ocr 纯字节缓存：同样截图（重选/回看）直接跳过推理。"""
    key = hashlib.sha1(raw).hexdigest()
    hit = _ocr_cache.get(key)
    if hit is not None:
        _ocr_cache.move_to_end(key)
        out = dict(hit)
        out["cached"] = True
        return out
    out = ocr_image_raw(raw)
    _ocr_cache[key] = out
    if len(_ocr_cache) > _OCR_CACHE_CAP:
        _ocr_cache.popitem(last=False)
    return out


def _greedy_wrap(draw, text: str, font, max_w: float) -> str:
    """按宽度贪心换行：西文按词、超宽词/CJK 按字断行。
    宽度增量累计（每 token/字符只测一次宽）——原实现每步对整行累计串
    调 textlength 是 O(n²)，长段落×字号循环时占 annotate 耗时大头。"""
    import re as _re
    lines: list[str] = []
    text = " ".join(text.splitlines())

    def _push_chunk(chunk: str) -> str:
        cur = ""
        cur_w = 0.0
        for ch in chunk:
            w = draw.textlength(ch, font=font)
            if cur_w + w <= max_w or not cur:
                cur += ch
                cur_w += w
            else:
                lines.append(cur)
                cur, cur_w = ch, w
        return cur

    cur = ""
    cur_w = 0.0
    for token in _re.split(r"(\s+)", text):
        if not token:
            continue
        tw = draw.textlength(token, font=font)
        if cur_w + tw <= max_w:
            cur += token
            cur_w += tw
            continue
        if token.isspace():
            lines.append(cur)
            cur = ""
            cur_w = 0.0
            continue
        if not cur:
            cur = _push_chunk(token)
        else:
            lines.append(cur)
            cur = _push_chunk(token)
        cur_w = draw.textlength(cur, font=font)
    if cur:
        lines.append(cur)
    return "\n".join(lines)


_font_cache: dict[tuple[str, int], object] = {}


def _load_font(font_path: str, size: int):
    """ImageFont.truetype 每次调用都重新解析字体文件（annotate 90% 耗时的来源），
    按 (path,size) 缓存——font 对象加载后不可变，复用安全。"""
    key = (font_path, int(size))
    f = _font_cache.get(key)
    if f is None:
        from PIL import ImageFont
        f = ImageFont.truetype(font_path, int(size))
        _font_cache[key] = f
    return f


def _fit_paragraph(draw, text: str, font_path: str, max_w: float, start_h: float, max_h: float):
    """选一个能让整段文本在 max_w 内排下、且总高不超过 max_h 的字号。"""
    start = max(9, min(int(start_h), 64))
    best = None
    for size in range(start - start % 2, 8, -2):  # 步长 2:视觉差异可忽略,迭代减半
        font = _load_font(font_path, size)
        wrapped = _greedy_wrap(draw, text, font, max_w)
        tb = draw.multiline_textbbox((0, 0), wrapped, font=font, spacing=4)
        w, h = tb[2] - tb[0], tb[3] - tb[1]
        if w <= max_w:
            if h <= max_h:
                return font, wrapped
            best = best or (font, wrapped)
    fallback_font = _load_font(font_path, 9)
    return best if best else (fallback_font, _greedy_wrap(draw, text, fallback_font, max_w))


def _fit_paragraph_lines(draw, text: str, font_path: str, max_w: float, start_h: float, target_lines: int, max_h: float, prefer: str = "largest"):
    """排版对齐（用户要求译文布局贴近原文）：
    在"换行后行数 ≤ 目标行数、行宽 ≤ 框宽、总高 ≤ 允许高"的可行字号里选择。
    prefer（2026-10-03 用户要求"有空的位置适当放大"）：
      'largest' —— 空隙充足时取最大字号（用足空白，读得清）；
      'fewest'  —— 空隙紧张时行数最少优先（≥12px 且 ≥最大字号一半：
                   按钮/短词缩一号排一行，"Revoke it" 不断词）。"""
    target_lines = max(1, int(target_lines))
    start = max(9, min(int(start_h), 64))
    # 可读性下限：字号不低于原文字高的 ~0.55 倍且 ≥12；放不下交给上层截行+省略号
    min_size = max(12, int(start_h * 0.55))
    cands: list[tuple[int, int, object, str]] = []  # (行数, 字号, font, wrapped)
    for size in range(start - start % 2, min_size - 1, -2):
        font = _load_font(font_path, size)
        wrapped = _greedy_wrap(draw, text, font, max_w)
        n = wrapped.count("\n") + 1
        if n > target_lines:
            continue
        tb = draw.multiline_textbbox((0, 0), wrapped, font=font, spacing=4)
        w, h = tb[2] - tb[0], tb[3] - tb[1]
        if w <= max_w and h <= max_h:
            cands.append((n, size, font, wrapped))
    if cands:
        fewest = min(cands, key=lambda c: (c[0], -c[1]))
        largest = max(cands, key=lambda c: c[1])
        if prefer == "fewest" and fewest[0] < largest[0] and fewest[1] >= max(12, largest[1] // 2):
            return fewest[2], fewest[3], max_h
        return largest[2], largest[3], max_h
    # 下限以上无解：用下限字号排版，交给防溢出护栏截行+省略号
    floor_font = _load_font(font_path, min_size)
    return floor_font, _greedy_wrap(draw, text, floor_font, max_w), max_h


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
            # 自适应阈值：模糊/发光/低对比背景上笔画-背景差常只有 20~50，
            # 固定 55 会漏检（原文透出来）；按 99 分位自适应、32 兜底，
            # 背景本身纹理强时分位数自然抬高，不会铺满
            thr = max(26.0, float(np.percentile(dist, 99.0)) * 0.45)
            mask = (dist > thr).astype(np.uint8) * 255
            if mask.sum() == 0 or mask.mean() > 230:  # 无文字 / 掩码异常铺满 → 跳过该段
                continue
            mask = cv2.dilate(mask, np.ones((3, 3), np.uint8), iterations=4)
            # 回填：平滑/渐变背景（蒙版外与背景估计几乎一致）直接用背景估计盖笔画，
            # 与 TELEA 视觉等价但快一个量级；有强边缘穿过的结构化背景才走 TELEA 重建
            bg_flat = float(dist[mask == 0].mean()) if bool((mask == 0).any()) else 0.0
            if bg_flat < 12.0:
                # 平滑/渐变背景：整框用背景估计覆盖（不只笔画像素）——代码底色 pill、
                # 描边框、阴影这类低对比残留一并盖掉；bg_est 在平滑背景上与原底几乎
                # 一致，肉眼无感。结构化背景才走 TELEA 只修笔画。
                arr[cy1:cy2, cx1:cx2] = bg_est
            else:
                repaired = cv2.inpaint(crop, mask, 3, cv2.INPAINT_TELEA)
                arr[cy1:cy2, cx1:cx2] = repaired
        out = Image.fromarray(arr)
        region.paste(out)
        return True
    except Exception as e:  # noqa: BLE001
        print(f"[rapidocr-service] inpaint 失败，回退色块: {e}", file=sys.stderr, flush=True)
        return False


def _avail_below(para: dict, paragraphs: list[dict], img_h: int) -> float:
    """段落框下方可用的空闲高度：到下一个 x 方向有重叠的文字块为止，
    上限 1.2×框高（避免长译文一路铺到页底）。中文短译文换长语言时，
    译文可利用这些空隙放大字号（用户要求：有空隙就允许字体大一些）。"""
    x1, y1, x2, y2 = para["box"]
    box_h = max(12.0, y2 - y1)
    limit = min(box_h * 1.2 + 10, img_h - y2 - 4)
    next_top = limit
    for other in paragraphs:
        if other is para:
            continue
        ox1, oy1, ox2, oy2 = other["box"]
        if oy1 < y2 - 2:
            continue  # 只关心位于下方的块
        x_ov = min(x2, ox2) - max(x1, ox1)
        if x_ov > 0.2 * min(x2 - x1, ox2 - ox1):
            next_top = min(next_top, max(0.0, oy1 - y2))
    return max(6.0, min(next_top, limit))


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
        # 排版：先原框适配；下方空隙大 → 扩展区域取最大字号（用足空白放大，2026-10-03
        # 用户要求"有空的位置适当放大"）；空隙小 → 行数最少优先（按钮短词缩一号排一行）
        box_h = max(12.0, y2 - y1)
        base_lines = max(1, round(box_h / max(para["line_h"], 6.0)))
        avail_h = min(box_h * 1.25 + 6, img.height - y1 - 4)
        expand_h = _avail_below(para, paragraphs, img.height)
        total_h = min(box_h + expand_h, img.height - y1 - 4)
        roomy = expand_h >= box_h * 0.6
        font, wrapped, _ = _fit_paragraph_lines(
            draw, tr, font_path, max_w, para["line_h"] * 0.95, base_lines, box_h * 1.1 + 6,
            "fewest" if not roomy else "largest")
        exp_lines = max(base_lines, round(total_h / max(para["line_h"], 6.0)))
        font2, wrapped2, _ = _fit_paragraph_lines(
            draw, tr, font_path, max_w, para["line_h"] * 0.95, exp_lines, total_h * 1.05 + 6,
            "largest" if roomy else "fewest")
        # 选字号更大的方案
        allowed_h = box_h * 1.1 + 6
        try:
            if font2.size > font.size:
                font, wrapped = font2, wrapped2
                allowed_h = total_h * 1.05 + 6
        except Exception:
            font, wrapped = font2, wrapped2
            allowed_h = total_h * 1.05 + 6
        # 防溢出硬护栏（2026-10-02 用户实测：译文超出板块压到别的内容/被无声截断）——
        # 允许高度 = 实际选中方案的可用高（原框 1.1 倍或带下方空隙的扩展高）；
        # 超出时逐行丢弃并补省略号：宁缺，不压别的板块/UI
        lines_w = wrapped.split("\n")
        max_text_h = max(min(allowed_h, img.height - y1 - 4), box_h)
        while len(lines_w) > 1:
            tb = draw.multiline_textbbox((0, 0), "\n".join(lines_w), font=font, spacing=4)
            if tb[3] - tb[1] <= max_text_h:
                break
            lines_w = lines_w[:-1]
        wrapped = "\n".join(lines_w)
        if len(wrapped) < len(tr) and not wrapped.endswith("…"):
            wrapped = wrapped.rstrip(" ,.;、。") + "…"
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
    t_ocr = time.time()
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

    # 板块划分：先分栏再逐栏聚合段落——译文模块与原图板块一一对应（2026-10-02）
    col_groups = _detect_column_groups([{"text": l["text"], "box": l["box"]} for l in lines])
    paragraphs: list[dict] = []
    module_spans: list[list[int]] = []
    for g in col_groups:
        ps = _group_paragraphs(g)
        start = len(paragraphs)
        paragraphs.extend(ps)
        module_spans.append(list(range(start, len(paragraphs))))
    mt = get_mt_engine()

    # 翻译任务拆分：段落 >120 字时按句子切块（句子是自然翻译单元，质量无损），
    # 所有块进 3 路线程池并发调用 llama-server（GPU 连续批处理消化并发）
    import re as _re
    jobs: list[tuple[int, str]] = []
    para_chunk_span: dict[int, list[int]] = {}
    for pi, pa in enumerate(paragraphs):
        text = pa["text"]
        if len(text) <= 120:
            para_chunk_span[pi] = [len(jobs)]
            jobs.append((pi, text))
            para_chunk_span[pi] = [len(jobs) - 1]
            continue
        sentences = [x for x in _re.split(r"(?<=[。！？；.!?])", text) if x.strip()]
        chunks: list[str] = []
        cur = ""
        for sent in sentences:
            if cur and len(cur) + len(sent) > 150:
                chunks.append(cur)
                cur = sent
            else:
                cur += sent
        if cur.strip():
            chunks.append(cur)
        start = len(jobs)
        para_chunk_span[pi] = list(range(start, start + len(chunks)))
        jobs.extend((pi, c) for c in chunks)

    chunk_results: list[str] = [""] * len(jobs)

    def _mt_one(ji: int) -> None:
        try:
            chunk_results[ji] = _mt_translate(mt, jobs[ji][1], target)
        except Exception as e:  # noqa: BLE001
            print(f"[rapidocr-service] MT 失败: {e}", file=sys.stderr, flush=True)

    t_mt0 = time.time()
    hits0 = _mt_stats["hits"]
    if len(jobs) > 1:
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=5) as pool:
            list(pool.map(_mt_one, range(len(jobs))))
    elif len(jobs) == 1:
        _mt_one(0)
    t_mt1 = time.time()

    # 块译文按段落拼回（空格连接，段落内原为连续文本）
    translations: list[str] = []
    for pi in range(len(paragraphs)):
        span = para_chunk_span.get(pi, [])
        translations.append(" ".join(chunk_results[ci].strip() for ci in span if chunk_results[ci].strip()))

    # 译文按板块聚合：box = 该板块段落包围盒（渲染端按原排版分块展示/复制）
    t_modules: list[dict] = []
    for span in module_spans:
        if not span:
            continue
        t_modules.append({
            "box": [round(v, 1) for v in (
                min(paragraphs[pi]["box"][0] for pi in span), min(paragraphs[pi]["box"][1] for pi in span),
                max(paragraphs[pi]["box"][2] for pi in span), max(paragraphs[pi]["box"][3] for pi in span))],
            "text": "\n".join(t for t in (translations[pi].strip() for pi in span) if t),
        })

    annotated = _annotate(img, paragraphs, translations)
    t_an = time.time()
    buf = io.BytesIO()
    annotated.save(buf, "PNG")
    t_en = time.time()
    ms = int((time.time() - t0) * 1000)
    print(f"[rapidocr-service] translate_image: {len(paragraphs)} 段 {ms}ms | "
          f"ocr={int((t_ocr - t0) * 1000)} mt={int((t_mt1 - t_mt0) * 1000)}({len(jobs)}任务,"
          f"缓存{_mt_stats['hits'] - hits0}命中) "
          f"annotate={int((t_an - t_mt1) * 1000)} encode={int((t_en - t_an) * 1000)}", file=sys.stderr, flush=True)
    return {
        "ok": True,
        "image": "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode(),
        "text": "\n\n".join(m["text"] for m in t_modules if m["text"].strip()) if len(t_modules) > 1 else "\n".join(t for t in translations if t.strip()),
        "modules": t_modules,
        "lines": [{"text": pa["text"], "box": [round(v, 1) for v in pa["box"]]} for pa in paragraphs],
        "ms": ms,
    }


def _model_inventory() -> dict:
    """模型清单：是否在本机、体积、来源说明（供设置窗「模型」展示）。
    OCR 小模型随 rapidocr wheel 内置；版面/表格缺文件时由库首次调用自动从 ModelScope 下载。"""
    from pathlib import Path as _P
    inv = {}

    def _size_mb(p):
        try:
            return round(_P(p).stat().st_size / 1024 / 1024, 1)
        except Exception:  # noqa: BLE001
            return None

    # 文字识别：随 rapidocr 包
    try:
        import rapidocr as _r
        mdir = _P(_r.__file__).resolve().parent / "models"
        det = mdir / "PP-OCRv6_det_small.onnx"
        rec = mdir / "PP-OCRv6_rec_small.onnx"
        inv["ocr"] = {
            "id": "ocr",
            "name": "文字识别 PP-OCRv6-small",
            "ok": det.exists() and rec.exists(),
            "size_mb": (_size_mb(det) or 0) + (_size_mb(rec) or 0),
            "mode": "builtin",
            "source": "随 rapidocr 安装包内置（约 31MB）",
            "note": "无需额外下载；应用安装 venv 后即可用",
        }
    except Exception as e:  # noqa: BLE001
        inv["ocr"] = {"id": "ocr", "name": "文字识别", "ok": False, "error": str(e)}

    # 版面：rapid_layout 缓存；缺失时首次「智能识别」自动下载
    try:
        import rapid_layout as _rl
        ldir = _P(_rl.__file__).resolve().parent / "models"
        lf = ldir / "pp_doc_layoutv3.onnx"
        inv["layout"] = {
            "id": "layout",
            "name": "智能版面 PP-DocLayoutV3",
            "ok": lf.exists(),
            "size_mb": _size_mb(lf),
            "mode": "ondemand",
            "source": "ModelScope RapidLayout（设置内手动下载）",
            "url": "https://www.modelscope.cn/models/RapidAI/RapidLayout",
            "note": "约 125MB；在设置「可选资产」手动下载，下载前智能识别不可用",
        }
    except Exception as e:  # noqa: BLE001
        inv["layout"] = {"id": "layout", "name": "智能版面", "ok": False, "error": str(e)}

    # 表格：rapid_table 缓存
    try:
        import rapid_table as _rt
        tdir = _P(_rt.__file__).resolve().parent / "models"
        tf = tdir / "slanet-plus.onnx"
        if not tf.exists():
            tf = tdir / "ch_ppstructure_mobile_v2_SLANet.onnx"
        inv["table"] = {
            "id": "table",
            "name": "表格结构 SLANet-plus",
            "ok": tf.exists(),
            "size_mb": _size_mb(tf),
            "mode": "ondemand",
            "source": "ModelScope / rapid_table 默认模型（设置内手动下载）",
            "note": "约 8MB；在设置「可选资产」手动下载，下载前表格识别不可用",
        }
    except Exception as e:  # noqa: BLE001
        inv["table"] = {"id": "table", "name": "表格结构", "ok": False, "error": str(e)}

    # 本地翻译 Hy-MT2
    mt_path = r"D:\llama\models\Hy-MT2-1.8B-Q4_K_M.gguf"
    inv["mt"] = {
        "id": "mt",
        "name": "本地翻译 Hy-MT2",
        "ok": os.path.exists(mt_path),
        "size_mb": _size_mb(mt_path),
        "mode": "external",
        "source": "Hy-MT2-1.8B GGUF（约 1.1GB）",
        "path": mt_path,
        "note": "放在 D:\\llama\\models\\ 后即可离线翻译；llama-server 在 D:\\llama\\bin\\",
    }
    return inv


def uia_element_at(x: int, y: int) -> dict:
    """UIA ElementFromPoint：返回光标处层级链（深→浅）。
    最深元素必须包含查询点，否则上溯，避免「框在别的行」。
    """
    import uiautomation as auto

    el = auto.ControlFromPoint(x, y)
    if el is None:
        return {"ok": False, "error": "null", "levels": []}

    def _rect(e):
        r = e.BoundingRectangle
        return {
            "left": int(r.left),
            "top": int(r.top),
            "right": int(r.right),
            "bottom": int(r.bottom),
            "width": int(r.right - r.left),
            "height": int(r.bottom - r.top),
        }

    def _contains(pr, px, py, margin=0):
        return (pr["left"] - margin <= px <= pr["right"] + margin
                and pr["top"] - margin <= py <= pr["bottom"] + margin)

    def _meta(e):
        d = _rect(e)
        d["ok"] = True
        try:
            d["name"] = str(e.Name or "")[:80]
            d["controlType"] = str(e.ControlTypeName or "")
        except Exception:  # noqa: BLE001
            pass
        return d

    # 最深元素若不含光标，向上找到第一个含光标的祖先（微信自绘列表常见）
    deep = el
    for _ in range(8):
        pr = _rect(deep)
        if _contains(pr, x, y, 1):
            break
        try:
            deep = deep.GetParentControl()
        except Exception:  # noqa: BLE001
            break
        if deep is None:
            deep = el
            break

    levels = []
    seen = set()
    cur = deep
    for _ in range(14):
        if cur is None:
            break
        try:
            pr = _rect(cur)
            key = (pr["left"], pr["top"], pr["width"], pr["height"])
            if key in seen:
                try:
                    cur = cur.GetParentControl()
                except Exception:  # noqa: BLE001
                    break
                continue
            if (pr["width"] >= 16 and pr["height"] >= 12
                    and not (pr["width"] > 2400 and pr["height"] > 1400)
                    and _contains(pr, x, y, 2)):
                levels.append(_meta(cur))
                seen.add(key)
        except Exception:  # noqa: BLE001
            pass
        try:
            cur = cur.GetParentControl()
        except Exception:  # noqa: BLE001
            break

    if levels and (levels[0]["width"] < 24 or levels[0]["height"] < 16):
        for lv in levels[1:]:
            if lv["width"] >= 28 and lv["height"] >= 18 and _contains(lv, x, y, 2):
                levels[0] = lv
                break

    if not levels:
        return {"ok": False, "error": "empty", "levels": []}
    levels[0]["ok"] = True
    return {"ok": True, "levels": levels}


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
            self._json(200, {
                "ok": True,
                "model": MODEL_TAG,
                "backend": _engine_backend,
                "build": "v4-align",
                "models": _model_inventory(),
            })
        else:
            self._json(404, {"ok": False, "error": "not found"})

    def _read_payload(self):
        """读 POST body：Content-Type=application/octet-stream 时 body 即 PNG 字节
        （二进制通道，省 base64 膨胀 33% + JSON 转义，2026-09-28）；否则按 JSON 解析。
        返回 (raw_bytes_or_None, payload_dict)。"""
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length > 0 else b""
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype == "application/octet-stream":
            return body, {}
        return None, json.loads(body.decode("utf-8"))

    def do_POST(self):
        if self.path.startswith("/ocr"):
            try:
                raw, payload = self._read_payload()
                if raw is not None:
                    self._json(200, _ocr_cached(raw))
                else:
                    self._json(200, ocr_image(payload.get("image_b64", "")))
            except Exception as e:  # noqa: BLE001
                self._json(500, {"ok": False, "error": str(e)})
        elif self.path.startswith("/translate_image"):
            try:
                raw, payload = self._read_payload()
                if raw is not None:
                    self._json(500, {"ok": False, "error": "translate_image requires JSON b64"})
                else:
                    self._json(200, translate_image(payload.get("image_b64", ""),
                                                    payload.get("target", "中文")))
            except Exception as e:  # noqa: BLE001
                self._json(500, {"ok": False, "error": str(e)})
        elif self.path.startswith("/smart"):
            try:
                _mp = _optional_model_paths().get("layout")
                if _mp is None or not _mp.exists():
                    self._json(200, {"ok": False, "code": "modelMissing",
                                     "message": "智能识别模型未下载——设置 → OCR → 可选资产 中下载（约 125MB）"})
                    return
                raw, payload = self._read_payload()
                if raw is not None:
                    self._json(200, smart_recognize_raw(raw))
                else:
                    self._json(200, smart_recognize(payload.get("image_b64", "")))
            except Exception as e:  # noqa: BLE001
                self._json(500, {"ok": False, "error": str(e)})
        elif self.path.startswith("/table"):
            try:
                _mp = _optional_model_paths().get("table")
                if _mp is None or not _mp.exists():
                    self._json(200, {"ok": False, "code": "modelMissing",
                                     "message": "表格识别模型未下载——设置 → OCR → 可选资产 中下载（约 7.4MB）"})
                    return
                raw, payload = self._read_payload()
                if raw is not None:
                    self._json(200, table_recognize_raw(raw))
                else:
                    self._json(200, table_recognize(payload.get("image_b64", "")))
            except Exception as e:  # noqa: BLE001
                self._json(500, {"ok": False, "error": str(e)})
        elif self.path.startswith("/models/download"):
            # 可选模型手动下载入口（2026-11-22 缺口1）：body {"id": "layout"|"table"}
            try:
                _raw, payload = self._read_payload()
                self._json(200, download_optional_model(str(payload.get("id", ""))))
            except Exception as e:  # noqa: BLE001
                self._json(500, {"ok": False, "message": str(e)})
        elif self.path.startswith("/upscale"):
            # AI 超分（2026-09-28）：body = PNG 字节；Real-ESRGAN x2，模型缺失自动下载。
            # 返回 JSON {ok, image_b64, ms, method}（输出仍走 b64——区域小，体积可控）。
            try:
                raw, _payload = self._read_payload()
                t0 = time.time()
                out_png, method = upscale_image_raw(raw)
                b64 = base64.b64encode(out_png).decode("ascii")
                self._json(200, {"ok": True, "image_b64": b64,
                                 "ms": int((time.time() - t0) * 1000), "method": method})
            except Exception as e:  # noqa: BLE001
                self._json(500, {"ok": False, "error": str(e)})
        elif self.path.startswith("/translate_batch"):
            # 面板"按板块翻译"批量入口：texts[] 各段并行翻译（3 路线程池 +
            # llama-server -np 3 连续批处理），保持与输入一一对应的顺序返回
            try:
                raw, payload = self._read_payload()
                texts = payload.get("texts") or []
                target = payload.get("target", "中文")
                t0 = time.time()
                mt = get_mt_engine()
                results: list[str] = [""] * len(texts)

                def _batch_one(i: int) -> None:
                    try:
                        results[i] = _mt_translate(mt, texts[i], target)
                    except Exception as e:  # noqa: BLE001
                        print(f"[rapidocr-service] MT 失败(段{i}): {e}", file=sys.stderr, flush=True)

                hits0 = _mt_stats["hits"]
                if len(texts) > 1:
                    from concurrent.futures import ThreadPoolExecutor
                    with ThreadPoolExecutor(max_workers=5) as pool:
                        list(pool.map(_batch_one, range(len(texts))))
                elif len(texts) == 1:
                    _batch_one(0)
                self._json(200, {"ok": True, "translations": results,
                                 "ms": int((time.time() - t0) * 1000),
                                 "cache_hits": _mt_stats["hits"] - hits0})
            except Exception as e:  # noqa: BLE001
                self._json(500, {"ok": False, "error": str(e)})
        elif self.path.startswith("/uia"):
            # Windows UI Automation：返回层级链（Shotera Tab 逐级上溯）
            try:
                length = int(self.headers.get("Content-Length", 0))
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                self._json(200, uia_element_at(int(payload.get("x", 0)), int(payload.get("y", 0))))
            except Exception as e:  # noqa: BLE001
                self._json(500, {"ok": False, "error": str(e), "levels": []})
        else:
            self._json(404, {"ok": False, "error": "not found"})

    def log_message(self, fmt, *args):
        pass


# ── 父进程死亡守护（2026-11-02 整机崩溃事故修复）────────────────────
# 宿主应用被强杀（Stop-Process -Force / 任务管理器结束任务）时，Windows 上是
# TerminateProcess → **本进程的 atexit 不执行** → mt_engine.shutdown() 不会跑
# → 它拉起的 llama-server.exe 变孤儿继续占显存（~1.2GB 显存/个），攒到 6~7 个
# 就把 8GB 显存的机器打满 → CUDA 降级共享内存 → 系统内存雪崩 → 整机崩溃。
# 这里在 python 侧兜底：父进程没了就主动回收 llama-server 再退出。
#
# ⚠️ 不能用「os.getppid() 是否变化」判断：Windows 上父进程死后本进程**不会**被
#    reparent（InheritedFromUniqueProcessId 保持原值），必须主动查父进程是否还活着。
# ⚠️ 更不能用 os.kill(ppid, 0)：Windows 上 os.kill 走 TerminateProcess → 会把父进程杀掉！
import ctypes as _ctypes


def _pid_alive(pid: int) -> bool:
    """判断进程是否还活着（纯 ctypes，不引入 psutil 依赖）。"""
    try:
        k32 = _ctypes.windll.kernel32
        k32.OpenProcess.restype = _ctypes.c_void_p
        k32.OpenProcess.argtypes = [_ctypes.c_uint32, _ctypes.c_int, _ctypes.c_uint32]
        k32.WaitForSingleObject.restype = _ctypes.c_uint32
        k32.WaitForSingleObject.argtypes = [_ctypes.c_void_p, _ctypes.c_uint32]
        h = k32.OpenProcess(0x1000 | 0x00100000, False, pid)  # QUERY_LIMITED_INFO|SYNCHRONIZE
        if not h:
            return False  # 进程不存在（ERROR_INVALID_PARAMETER）
        try:
            return k32.WaitForSingleObject(h, 0) != 0  # WAIT_OBJECT_0 = 已退出
        finally:
            k32.CloseHandle(h)
    except Exception as e:  # noqa: BLE001
        # 判定失败时保守当作"还活着"——宁可多留一会儿，也别误杀；但必须留痕，
        # 否则这个兜底会静默地把整条守护失效掉。
        print(f"[parent-watchdog] _pid_alive 判定失败（按存活处理）: {e}", file=sys.stderr, flush=True)
        return True


def _parent_watchdog():
    """宿主进程死亡 → 回收 llama-server → 自己退出（防显存孤儿堆积）。"""
    import os as _os
    import time as _time

    # ⚠️ 必须盯宿主**应用**的 PID，不能盯 os.getppid()：
    #    本机 venv 的 Scripts\python.exe 是**转发器**——它自己再拉起一个真正的解释器
    #    进程，所以本进程的直接父进程是那个转发器、**不是宿主应用**；而宿主应用被强杀时
    #    转发器仍然活着（它在等本进程退出）→ 盯 getppid() 永远不会触发。
    #    宿主应用 spawn 本服务时用 PETALSNAP_OWNER_PID 显式告知自己的 PID。
    try:
        ppid = int(_os.environ.get("PETALSNAP_OWNER_PID", "") or 0)
    except Exception:
        ppid = 0
    if ppid <= 1:
        try:
            ppid = _os.getppid()  # 手工启动（没有宿主环境变量）时退回盯直接父进程
        except Exception:
            return
        if ppid <= 1:
            return  # 本来就没有宿主（或已被 init 收养）
    print(f"[parent-watchdog] 盯宿主 pid={ppid}", file=sys.stderr, flush=True)
    while True:
        _time.sleep(5)
        if _pid_alive(ppid):
            continue
        print("[parent-watchdog] 宿主进程已退出 → 回收 llama-server 并退出", file=sys.stderr, flush=True)
        try:
            from screenshot_tool import mt_engine

            mt_engine.shutdown()
        except Exception as e:  # noqa: BLE001
            print(f"[parent-watchdog] mt_engine.shutdown 失败: {e}", file=sys.stderr, flush=True)
        _os._exit(0)


def _prewarm_mt():
    """后台预热翻译引擎（拉起 llama-server + GPU 加载 Hy-MT2），首次点击翻译即热。
    先等本服务端口进入监听——预热线程在 bind 之前启动，若本实例绑定端口失败
    （如已有另一实例在跑），线程会随进程退出，不会留 down 多余的 llama-server。"""
    def _run():
        import socket as _socket
        deadline = time.time() + 30
        while time.time() < deadline:
            try:
                with _socket.create_connection(("127.0.0.1", PORT), timeout=0.5):
                    break
            except OSError:
                if time.time() >= deadline:
                    return
                time.sleep(0.3)
        try:
            mt = get_mt_engine()
            mt.translate("预热", "英语")
            print("[rapidocr-service] MT 预热完成", file=sys.stderr, flush=True)
        except Exception as e:  # noqa: BLE001
            print(f"[rapidocr-service] MT 预热失败（翻译时将重试）: {e}", file=sys.stderr, flush=True)
    threading.Thread(target=_run, daemon=True).start()


if __name__ == "__main__":
    # 清理孤儿 llama-server：服务被强制结束时 mt_engine 的 atexit 不会执行，
    # 孤儿每个占 ~1.2GB 显存，累积后显存耗尽 → 翻译请求在残缺显存里"永远转圈"。
    # 2026-09-28 收窄打击面：按命令行里的 Hy-MT2 模型名匹配（本服务专用模型，
    # wmic 查询 + 按 PID 杀），不再 taskkill /IM 全杀——用户其他应用的
    # llama-server（端口随机无法区分）曾被误伤。
    def _kill_orphan_llama_servers():
        """清理「父进程已死」的 Hy-MT2 llama-server 孤儿。

        ⚠️ 原实现用 wmic —— **Win11 已移除 wmic.exe**，本机走 except 分支**静默跳过**，
        孤儿清理从未真正生效过（2026-11-02 整机崩溃事故的一环）。改用 PowerShell CIM
        （判据与仓库内 tools/_sweep_orphans.ps1 同源：父进程已不存在 = 孤儿）。
        """
        try:
            ps_lines = [
                "$ErrorActionPreference='SilentlyContinue'",
                "Get-CimInstance Win32_Process -Filter \"Name='llama-server.exe'\" | "
                "Where-Object { $_.CommandLine -match 'Hy-MT2' } | ForEach-Object {",
                "  $par = Get-CimInstance Win32_Process -Filter \"ProcessId=$($_.ParentProcessId)\"",
                "  if (-not $par) { taskkill /F /T /PID $_.ProcessId | Out-Null }",
                "}",
            ]
            subprocess.run(
                ["powershell", "-NoProfile", "-NonInteractive",
                 "-ExecutionPolicy", "Bypass", "-Command", "\n".join(ps_lines)],
                capture_output=True, text=True, timeout=30,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except Exception as e:  # noqa: BLE001
            print(f"[rapidocr-service] 孤儿 llama-server 清理跳过: {e}", file=sys.stderr, flush=True)

    _kill_orphan_llama_servers()

    # 单实例守卫：Windows 上 SO_REUSEADDR 允许双进程绑同一端口（2026-10-03 实测
    # 应用拉起的实例与手工实例并存,请求随机分流到旧代码实例→翻译巨慢）。
    # 端口已有健康实例时立刻退出,把服务让给先到者（引擎/模型都不重复加载）。
    try:
        import urllib.request as _ureq
        with _ureq.urlopen(f"http://127.0.0.1:{PORT}/health", timeout=1) as _r:
            if _r.status == 200:
                print(f"[rapidocr-service] port {PORT} already served → exit (single-instance guard)",
                      file=sys.stderr, flush=True)
                sys.exit(0)
    except SystemExit:
        raise
    except Exception:
        pass

    # MT 预热先于 OCR 引擎预热：llama-server 拉起+模型加载 ~10s，与 OCR 初始化
    # 并行跑，压缩"启动后立刻点翻译"的冷启动窗口（2026-10-03 用户反馈翻译启动慢）
    threading.Thread(target=_prewarm_mt, daemon=True).start()
    # 父进程死亡守护：宿主被强杀时本进程会留下来 → 连带 llama-server 变孤儿占显存
    threading.Thread(target=_parent_watchdog, daemon=True).start()

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
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()

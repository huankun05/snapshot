"""
拾花 PetalSnap —— 应用图标派生脚本

从 1024 级主稿（透明背景 PNG，建议自带圆角方形底板）派生全部图标产物：
  resources/icon/app.ico        16/20/24/32/40/48/64/128/256 多尺寸（exe/窗口/任务栏）
  resources/icon/tray.png       16px（托盘，紧凑取景）
  resources/icon/tray@2x.png    32px
  resources/icon/logo-256.png   256px（About/设置窗）

用法：python tools/build_icons.py [master.png]
主稿默认 resources/icon/petalsnap-master.png；若主稿不带圆角透明（整幅方图），
用 --radius 指定圆角半径（相对短边百分比，Win11 风格约 22）。

依赖：Pillow（venv_ocr 环境）
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "resources" / "icon"
ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]


def rounded_mask(size: int, radius_pct: float) -> Image.Image:
    """圆角方形 alpha 遮罩，radius_pct 为圆角半径占短边的百分比"""
    radius = int(min(size, size) * radius_pct / 100)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def make_square(im: Image.Image, radius_pct: float | None) -> Image.Image:
    """补成正方形；radius_pct 给定时套圆角透明遮罩（主稿已是透明圆角则给 None）"""
    w, h = im.size
    side = max(w, h)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(im, ((side - w) // 2, (side - h) // 2))
    if radius_pct:
        canvas.putalpha(rounded_mask(side, radius_pct))
    return canvas


def save_ico(master: Image.Image, path: Path) -> None:
    master.save(path, format="ICO", sizes=[(s, s) for s in ICO_SIZES])


def save_tray(master: Image.Image, path: Path, px: int, zoom: float = 1.0,
              radius_pct: float = 26) -> None:
    """托盘尺寸；zoom>1 时居中放大裁切（小尺寸下花更醒目）。
    圆角必须在裁切之后再套：先套再裁会把圆角裁掉变成方角（2026-09-16 用户反馈）。
    小尺寸下圆角比例比主稿略大（26%）才读得出"圆润"。"""
    if zoom > 1.0:
        w = master.width
        crop = int(w / zoom)
        off = (w - crop) // 2
        master = master.crop((off, off, off + crop, off + crop))
    im = master.resize((px, px), Image.LANCZOS)
    # 遮罩 4 倍超采样再缩回：16px 直接画圆角没有抗锯齿，边缘是锯齿状台阶
    mask = rounded_mask(px * 4, radius_pct).resize((px, px), Image.LANCZOS)
    im.putalpha(mask)
    im.save(path)


def main() -> int:
    master_path = Path(sys.argv[1]) if len(sys.argv) > 1 and not sys.argv[1].startswith("--") \
        else OUT / "petalsnap-master.png"
    radius = None
    if "--radius" in sys.argv:
        radius = float(sys.argv[sys.argv.index("--radius") + 1])
    if not master_path.exists():
        print(f"[icons] 主稿不存在: {master_path}")
        return 1

    OUT.mkdir(parents=True, exist_ok=True)
    im = Image.open(master_path).convert("RGBA")
    master = make_square(im, radius)

    save_ico(master, OUT / "app.ico")
    save_tray(master, OUT / "tray.png", 16, zoom=1.5)
    save_tray(master, OUT / "tray@2x.png", 32, zoom=1.5)
    master.resize((256, 256), Image.LANCZOS).save(OUT / "logo-256.png")

    # 预览对照表：16/32/48/256 逐级检查可读性（人工目检用，不干预产物）
    preview = Image.new("RGBA", (400, 340), (245, 246, 248, 255))
    x = 16
    for px in (16, 32, 48, 64, 256):
        icon = master.resize((px, px), Image.LANCZOS)
        preview.paste(icon, (x, 340 - px - 24), icon)
        x += px + 16
    preview.save(OUT / "_preview.png")
    print(f"[icons] 完成: app.ico {ICO_SIZES} / tray 16+32 / logo-256 / _preview.png")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

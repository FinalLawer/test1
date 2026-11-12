# -*- coding: utf-8 -*-
"""生成应用图标与安装器品牌资源（可复现，不依赖任何第三方素材）。

产出（全部写入 build/）：
  icon.ico          应用 / 安装器 / 卸载器图标，9 个尺寸（16~256）
  installerSidebar.bmp     NSIS 欢迎页 / 完成页侧栏（卸载器共用），164 x 314，24 位 BMP
  installerHeader.bmp      NSIS 页眉右侧图，150 x 57，24 位 BMP
  LICENSE.txt       MIT 许可 + 中文说明（UTF-8 BOM，NSIS 正确显示中文）

图标画的就是产品在屏幕上叠加的那两个标记，造型和取色与 src/overlay/overlay.js
保持一致：小地图圆盘上一支红色行进箭头 + 外圈一段带小尖的绿色视角弧。
没有使用 BetterGI、米哈游或任何第三方的图标、插画与字体文件；
文字用系统自带的微软雅黑渲染。

用法：
  python scripts/make-assets.py           生成 build/ 下全部资源
  python scripts/make-assets.py --preview=DIR    另外把预览 PNG 写到 DIR（不入库）
"""

import json
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
BUILD.mkdir(exist_ok=True)

VERSION = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]

LANCZOS = Image.Resampling.LANCZOS
BICUBIC = Image.Resampling.BICUBIC

# 底板：与启动器主视觉同一套冷灰蓝
TILE_TOP = (56, 63, 74)
TILE_BOTTOM = (22, 24, 30)
ACCENT = (73, 178, 252) # #49B2FC 启动器强调色
CYAN = (53, 212, 240)   # 游戏里青色玩家标记
# 叠加层标记：与 overlay.js 的常量逐一对应
RED_DEEP = (196, 18, 29)
RED = (255, 47, 47)
RED_TIP = (255, 90, 72)
GREEN_LIGHT = (147, 247, 180)
GREEN = (53, 217, 107)
GREEN_DEEP = (31, 174, 82)
GREEN_EDGE = (4, 36, 17)
WHITE = (255, 255, 255)

FG = (236, 238, 242)
FG_DIM = (150, 156, 166)

FONT_CANDIDATES = [
    "C:/Windows/Fonts/msyhbd.ttc",
    "C:/Windows/Fonts/msyh.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]


def font(size, bold=False):
    names = FONT_CANDIDATES if bold else FONT_CANDIDATES[1:] + FONT_CANDIDATES[:1]
    for name in names:
        try:
            return ImageFont.truetype(name, size, index=0)
        except OSError:
            continue
    return ImageFont.load_default()


# ------------------------------------------------------------------ 绘图小工具

def tint(mask, color, alpha=255):
    """把一张 L 蒙版染成纯色 RGBA 图层。"""
    layer = Image.new("RGBA", mask.size, color + (0,))
    layer.putalpha(mask if alpha >= 255 else mask.point(lambda v: v * alpha // 255))
    return layer


def grow(mask, px):
    """把蒙版向外均匀扩 px 像素（圆角），用来做描边。

    MaxFilter 是方核，斜向会比横竖粗 1.4 倍；先高斯模糊再卡阈值，各方向一样宽。
    """
    if px <= 0:
        return mask
    blurred = mask.filter(ImageFilter.GaussianBlur(px / 1.28))
    return blurred.point(lambda v: 0 if v < 20 else min(255, (v - 20) * 22))


def shadow(mask, blur, dy, alpha):
    moved = Image.new("L", mask.size, 0)
    moved.paste(mask, (0, int(round(dy))))
    return tint(moved.filter(ImageFilter.GaussianBlur(blur)), (0, 0, 0), alpha)


def lin_grad(w, h, angle=0.0):
    """L 渐变：angle=0 时上黑下白，angle 为逆时针旋转角。"""
    side = max(w, h) * 2
    g = Image.linear_gradient("L").resize((side, side), BICUBIC)
    if angle:
        g = g.rotate(angle, resample=BICUBIC)
    left, top = (side - w) // 2, (side - h) // 2
    return ImageOps.autocontrast(g.crop((left, top, left + w, top + h)))


# PIL 的 radial_gradient 在**角上**才到 255，边中点（距离 = 半径）只有 255/√2 ≈ 180
RADIAL_EDGE = 255 / math.sqrt(2)


def radial(w, h, cx, cy, r, power=1.0, peak=255):
    """L 径向光斑：圆心最亮，到半径 r 处衰减为 0。"""
    d = max(2, int(round(r * 2)))
    g = Image.radial_gradient("L").resize((d, d), BICUBIC)
    g = g.point(lambda v: int(peak * (1 - min(1.0, v / RADIAL_EDGE)) ** power))
    out = Image.new("L", (w, h), 0)
    out.paste(g, (int(round(cx - r)), int(round(cy - r))))
    return out


def blend(color_a, color_b, mask):
    """mask 为 0 处取 color_a，255 处取 color_b。"""
    a = Image.new("RGB", mask.size, color_a)
    b = Image.new("RGB", mask.size, color_b)
    return Image.composite(b, a, mask)


def ramp(mask, lo, hi):
    """把 mask 的 [lo, hi] 区间线性拉伸到 [0, 255]。"""
    span = max(1e-6, hi - lo)
    return mask.point(lambda v: max(0, min(255, int((v - lo) * 255 / span))))


def polar(c, r, bearing):
    """罗盘角（0°=上、顺时针）→ 画布坐标。"""
    rad = math.radians(bearing)
    return (c + r * math.sin(rad), c - r * math.cos(rad))


# ---------------------------------------------------------------- 标记：绿弧

def arc_mask(S, c, r, lw, half, bearing, tick_h, tick_w=1.5):
    """两端收细、正中带小尖的月牙。公式照搬 overlay.js 的 drawViewArc。"""
    half_rad = math.radians(half)
    tick_half = (lw * tick_w) / r

    def thick(t):
        k = max(0.0, min(1.0, (abs(t) / half_rad - 0.4) / 0.6))
        return lw * (1 - 0.55 * k * k * (3 - 2 * k))

    def outer(t):
        u = max(0.0, 1 - abs(t) / tick_half)
        return r + thick(t) / 2 + tick_h * u * u

    ts = [-half_rad + 2 * half_rad * i / 96 for i in range(97)]
    ts += [tick_half * i / 12 for i in range(-12, 13)]
    ts.sort()

    b0 = math.radians(bearing)
    pts = [(c + outer(t) * math.sin(b0 + t), c - outer(t) * math.cos(b0 + t)) for t in ts]
    pts += [(c + (r - thick(t) / 2) * math.sin(b0 + t), c - (r - thick(t) / 2) * math.cos(b0 + t))
            for t in reversed(ts)]

    mask = Image.new("L", (S, S), 0)
    d = ImageDraw.Draw(mask)
    d.polygon(pts, fill=255)
    cap = thick(half_rad) / 2
    for end in (-half, half):
        x, y = polar(c, r, bearing + end)
        d.ellipse((x - cap, y - cap, x + cap, y + cap), fill=255)
    return mask


def arc_fill(S, c, r, lw, tick_h):
    """沿径向由内缘高光过渡到外缘深绿。"""
    g = Image.radial_gradient("L").resize((S, S), BICUBIC)
    to_v = lambda dist: dist / (S / 2) * RADIAL_EDGE
    inner, outer = to_v(r - lw / 2), to_v(r + lw / 2 + tick_h)
    mid = inner + (outer - inner) * 0.45
    img = blend(GREEN_LIGHT, GREEN, ramp(g, inner, mid))
    img.paste(Image.new("RGB", (S, S), GREEN_DEEP), mask=ramp(g, mid, outer))
    return img


# ---------------------------------------------------------------- 标记：红箭头

def arrow_layers(S, c, bearing, tail, tip, head_l, head_w, neck_w, tail_w):
    """细尾 → 渐宽箭杆 → 后掠箭头的一整块轮廓，尾深尖亮。返回 (填充图层, 蒙版)。"""
    barb = tip - head_l
    neck = tip - head_l * 0.74
    pts = [(c - tail_w, c - tail), (c - neck_w, c - neck), (c - head_w, c - barb), (c, c - tip),
    (c + head_w, c - barb), (c + neck_w, c - neck), (c + tail_w, c - tail)]
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).polygon(pts, fill=255)

    # 竖直渐变：箭尖处 0、箭尾处 255
    g = Image.new("L", (S, S), 255)
    top, bottom = int(c - tip), int(c - tail)
    g.paste(Image.new("L", (S, top + 1), 0), (0, 0))
    g.paste(Image.linear_gradient("L").resize((S, max(1, bottom - top)), BICUBIC), (0, top))
    fill = blend(RED_TIP, RED, ramp(g, 0, 115))
    fill.paste(Image.new("RGB", (S, S), RED_DEEP), mask=ramp(g, 115, 255))

    # 中轴左半压一层淡高光，做成导航箭头那种两面折光
    shine = Image.new("L", (S, S), 0)
    ImageDraw.Draw(shine).rectangle((0, 0, int(c), S), fill=44)
    fill.paste(Image.new("RGB", (S, S), WHITE), mask=shine)

    layer = fill.convert("RGBA")
    layer.putalpha(mask)
    rot = dict(resample=BICUBIC, center=(c, c))
    return layer.rotate(-bearing, **rot), mask.rotate(-bearing, **rot)


# -------------------------------------------------------------------- 图标本体

def render_mark(px, bearing_arrow=44, bearing_arc=314):
    """渲染 px 见方的图标。

    小尺寸不是把大图缩小了事：16~32px 下细环、圆点、视野扇面只会糊成噪点，
    所以按尺寸分三档，越小越只保留「红箭头 + 绿弧」两个主体并把它们加粗。
    """
    tiny = px <= 24
    small = px <= 40
    S = max(256, px * 4) if px >= 64 else 512
    c = S / 2
    u = S  # 以下比例都相对图标边长

    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    # ---- 底板：圆角方块 + 斜向渐变 + 右上角一抹强调色 ----
    tile = Image.new("L", (S, S), 0)
    ImageDraw.Draw(tile).rounded_rectangle((0, 0, S - 1, S - 1), radius=u * 0.225, fill=255)
    base = blend(TILE_TOP, TILE_BOTTOM, lin_grad(S, S, 28)).convert("RGBA")
    base.alpha_composite(tint(radial(S, S, u * 0.80, u * 0.16, u * 0.78, power=1.7, peak=92), ACCENT))
    base.putalpha(tile)
    img.alpha_composite(base)

    if not small:
        # 底板边缘一圈极淡的亮线，深色壁纸上能把图标和背景分开
        rim = Image.new("L", (S, S), 0)
        ImageDraw.Draw(rim).rounded_rectangle((0, 0, S - 1, S - 1), radius=u * 0.225,
    outline=255, width=max(2, int(u * 0.008)))
        img.alpha_composite(tint(rim, WHITE, 30))

    # ---- 小地图圆盘 ----
    disc_r = u * (0.30 if not small else 0.31)
    if not tiny:
        disc = Image.new("L", (S, S), 0)
        ImageDraw.Draw(disc).ellipse((c - disc_r, c - disc_r, c + disc_r, c + disc_r), fill=255)
        img.alpha_composite(tint(disc, WHITE, 16))
        if not small:
            # 朝绿弧方向的视野扇面：呼应游戏小地图上的白色视锥
            cone = Image.new("L", (S, S), 0)
            ImageDraw.Draw(cone).pieslice((c - disc_r, c - disc_r, c + disc_r, c + disc_r),
              bearing_arc - 90 - 45, bearing_arc - 90 + 45, fill=255)
            fade = radial(S, S, c, c, disc_r * 1.15, power=0.9, peak=70)
            img.alpha_composite(tint(Image.composite(fade, Image.new("L", (S, S), 0), cone), WHITE))
        ring = Image.new("L", (S, S), 0)
        ImageDraw.Draw(ring).ellipse((c - disc_r, c - disc_r, c + disc_r, c + disc_r),
                outline=255, width=max(2, int(u * (0.012 if not small else 0.022))))
        img.alpha_composite(tint(ring, WHITE, 62 if not small else 80))

    # ---- 绿弧：贴在圆盘外圈 ----
    arc_r = u * (0.385 if not small else 0.39)
    arc_lw = u * (0.052 if not small else 0.078 if not tiny else 0.098)
    tick_h = arc_lw * (0.72 if not tiny else 0.0)
    a_mask = arc_mask(S, c, arc_r, arc_lw, 50 if not small else 46, bearing_arc, tick_h, 1.35)
    edge = u * (0.009 if not small else 0.014)
    img.alpha_composite(shadow(grow(a_mask, edge), u * 0.02, u * 0.008, 120))
    img.alpha_composite(tint(grow(a_mask, edge), GREEN_EDGE, 215))
    a_fill = arc_fill(S, c, arc_r, arc_lw, tick_h).convert("RGBA")
    a_fill.putalpha(a_mask)
    img.alpha_composite(a_fill)

    # ---- 红箭头：从圆心射向右上，尖端略微探出圆盘 ----
    if tiny:
        geo = dict(tail=u * 0.02, tip=u * 0.40, head_l=u * 0.26, head_w=u * 0.165, neck_w=u * 0.06, tail_w=u * 0.045)
        outline = u * 0.036
    elif small:
        geo = dict(tail=u * 0.05, tip=u * 0.40, head_l=u * 0.22, head_w=u * 0.135, neck_w=u * 0.048, tail_w=u * 0.03)
        outline = u * 0.026
    else:
        geo = dict(tail=u * 0.075, tip=u * 0.395, head_l=u * 0.19, head_w=u * 0.108, neck_w=u * 0.037, tail_w=u * 0.017)
        outline = u * 0.016
    r_layer, r_mask = arrow_layers(S, c, bearing_arrow, **geo)
    r_out = grow(r_mask, outline)
    img.alpha_composite(shadow(r_out, u * 0.028, u * 0.012, 150))
    img.alpha_composite(tint(r_out, WHITE, 246))
    img.alpha_composite(r_layer)

    # ---- 圆心的青色玩家点：箭头的起点 ----
    if not small:
        dot_r = u * 0.046
        dot = Image.new("L", (S, S), 0)
        ImageDraw.Draw(dot).ellipse((c - dot_r, c - dot_r, c + dot_r, c + dot_r), fill=255)
        dot_out = grow(dot, u * 0.014)
        img.alpha_composite(shadow(dot_out, u * 0.02, u * 0.008, 130))
        img.alpha_composite(tint(dot_out, WHITE, 246))
        img.alpha_composite(tint(dot, CYAN))

    # 阴影和描边可能溢出圆角，最后再按底板裁一次
    clipped = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    clipped.paste(img, mask=tile)
    return clipped.resize((px, px), LANCZOS)


ICON_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]


def make_icon():
    images = {s: render_mark(s) for s in ICON_SIZES}
    path = BUILD / "icon.ico"
    # append_images 让每个尺寸用各自单独渲染的那张，而不是由 256 缩出来
    images[256].save(path, format="ICO", sizes=[(s, s) for s in ICON_SIZES],
append_images=[images[s] for s in ICON_SIZES if s != 256])
    print(f"  {path.name:24s} {len(ICON_SIZES)} sizes      {path.stat().st_size} B")
    return images


# ------------------------------------------------------------------ 安装器位图

def save_bmp(img, name):
    path = BUILD / name
    img.convert("RGB").save(path, format="BMP")
    print(f"  {path.name:24s} {img.width}x{img.height}  {path.stat().st_size} B")


def centered(draw, y, text, fnt, fill, width):
    box = draw.textbbox((0, 0), text, font=fnt)
    draw.text(((width - (box[2] - box[0])) / 2 - box[0], y), text, font=fnt, fill=fill)


def make_sidebar():
    """欢迎页 / 完成页左侧竖图。图形 4 倍超采样后缩小，文字直接按 1 倍渲染保证锐利。"""
    w, h, k = 164, 314, 4
    W, H = w * k, h * k

    art = blend((46, 52, 62), (20, 22, 27), lin_grad(W, H)).convert("RGBA")
    art.alpha_composite(tint(radial(W, H, W * 0.92, H * 0.04, W * 1.25, power=1.8, peak=84), ACCENT))

    # 以图标为圆心的几圈同心环，像小地图向外扩散的波纹；越往外越淡，
    # 到标题文字上方完全淡出，不和文字抢
    cx, cy = W * 0.5, (34 + 46) * k
    fade = Image.new("L", (W, H), 0)
    fade.paste(lin_grad(W, 150 * k).point(lambda v: 255 - v), (0, 0))
    for r, a in ((66, 34), (90, 22), (116, 13)):
        ring = Image.new("L", (W, H), 0)
        ImageDraw.Draw(ring).ellipse((cx - r * k, cy - r * k, cx + r * k, cy + r * k), outline=255, width=k)
        art.alpha_composite(tint(Image.composite(ring, Image.new("L", (W, H), 0), fade), WHITE, a))

    mark = render_mark(92 * k)
    art.alpha_composite(shadow(mark.getchannel("A").point(lambda v: 255 if v > 8 else 0), 5 * k, 3 * k, 110)
                 .crop((0, 0, mark.width, mark.height)), (int((w - 92) / 2 * k), 34 * k))
    art.alpha_composite(mark, (int((w - 92) / 2 * k), 34 * k))

    img = art.convert("RGB").resize((w, h), LANCZOS)
    d = ImageDraw.Draw(img)
    centered(d, 146, "原神跟跑助手", font(19, True), FG, w)
    centered(d, 175, "GI-Follow-Assist", font(10), FG_DIM, w)
    d.line((42, 199, w - 42, 199), fill=(74, 80, 90), width=1)
    centered(d, 210, "B 站攻略视频悬浮窗", font(11), FG_DIM, w)
    centered(d, 228, "小地图方位跟跑", font(11), FG_DIM, w)

    # 版本号胶囊
    label = f"v{VERSION}"
    f9 = font(9)
    box = d.textbbox((0, 0), label, font=f9)
    tw = box[2] - box[0]
    px0 = (w - tw) / 2 - 8
    d.rounded_rectangle((px0, h - 31, px0 + tw + 16, h - 15), radius=8, fill=(34, 38, 46), outline=(84, 92, 104))
    centered(d, h - 29, label, f9, FG, w)
    save_bmp(img, "installerSidebar.bmp")
    return img


def make_header():
    """页眉右侧图。底色必须是纯白：MUI 页眉本身是白的，深色块会像贴了一张补丁。"""
    w, h, k = 150, 57, 4
    art = Image.new("RGBA", (w * k, h * k), (255, 255, 255, 255))
    size = 39
    mark = render_mark(size * k)
    pos = ((w - size - 9) * k, int((h - size) / 2) * k)
    art.alpha_composite(shadow(mark.getchannel("A").point(lambda v: 255 if v > 8 else 0), 3 * k, 1.5 * k, 60), pos)
    art.alpha_composite(mark, pos)
    img = art.convert("RGB").resize((w, h), LANCZOS)

    d = ImageDraw.Draw(img)
    right = w - size - 9 - 8
    for y, text, fnt, fill in ((14, "原神跟跑助手", font(12, True), (40, 44, 52)),
          (32, "GI-Follow-Assist", font(8), (128, 134, 144))):
        box = d.textbbox((0, 0), text, font=fnt)
        d.text((right - box[2], y), text, font=fnt, fill=fill)
    save_bmp(img, "installerHeader.bmp")
    return img


LICENSE = """原神跟跑助手 / GI-Follow-Assist

MIT License

Copyright (c) 2026 FinalLawer

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

--- 中文说明 ---

1. 本项目是非官方的个人辅助工具，与米哈游、哔哩哔哩无任何关联；
   不含游戏客户端文件、不修改游戏内存、不注入游戏进程。
2. 功能所需的管理员权限仅用于全局热键（Windows UIPI 机制），
   程序不采集、不上传任何账号信息与画面内容。
3. 第三方组件：Electron（MIT）、uiohook-napi（MIT）、NSIS（zlib）等，
   各自许可随对应发行包附带；图标、界面与安装页图片均为本项目原创。
4. 绿色版的数据保存在程序目录 data\\，安装版保存在
   %APPDATA%\\原神跟跑助手\\；卸载安装版默认保留设置与标定。
"""


def make_license():
    path = BUILD / "LICENSE.txt"
    # NSIS 的 Unicode 安装器需要 BOM 才能正确显示中文
    path.write_bytes(("\ufeff" + LICENSE.replace("\n", "\r\n")).encode("utf-8"))
    print(f"  {path.name:24s} UTF-8 BOM   {path.stat().st_size} B")


def write_preview(out_dir, icons, sidebar, header):
    """把图标各尺寸（深 / 浅两种底色）和两张安装器位图拼成一张预览图。"""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    sheet = Image.new("RGBA", (1180, 700), (32, 34, 40, 255))
    d = ImageDraw.Draw(sheet)
    d.rectangle((0, 350, 600, 700), fill=(236, 238, 242, 255))
    for row, y in enumerate((20, 370)):
        sheet.alpha_composite(icons[256], (20, y))
        x = 300
        for s in (128, 64, 48, 40, 32, 24, 20, 16):
            sheet.alpha_composite(icons[s], (x, y + 256 - s))
            if s <= 32:  # 小尺寸再放大 4 倍看像素
                sheet.alpha_composite(icons[s].resize((s * 4, s * 4), Image.Resampling.NEAREST),
                 (300 + {32: 0, 24: 136, 20: 240, 16: 328}[s] - (0 if row == 0 else 0), y))
            x += s + 10
    sheet.paste(sidebar.resize((328, 628), LANCZOS), (640, 20))
    sheet.paste(header.resize((300, 114), LANCZOS), (860, 20))
    sheet.paste(header, (860, 150))
    sheet.paste(sidebar, (990, 220))
    sheet.save(out / "assets-preview.png")
    icons[256].resize((512, 512), LANCZOS).save(out / "icon-256@2x.png")
    render_mark(1024).save(out / "icon-1024.png")
    print(f"  预览已写入 {out}")


if __name__ == "__main__":
    print(f"生成 build/ 品牌资源（v{VERSION}）：")
    icons = make_icon()
    sidebar = make_sidebar()
    header = make_header()
    make_license()
    for arg in sys.argv[1:]:
        if arg.startswith("--preview="):
            write_preview(arg.split("=", 1)[1], icons, sidebar, header)

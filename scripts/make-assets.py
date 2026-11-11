# -*- coding: utf-8 -*-
"""生成安装器品牌资源（可复现，不依赖任何第三方素材）。

产出（全部写入 build/）：
  icon.ico                 应用 / 安装器 / 卸载器图标，多尺寸 32 位 DIB ICO
  installerSidebar.bmp     NSIS 欢迎页 / 完成页侧栏，164 x 314，24 位 BMP
  installerHeader.bmp      NSIS 页眉，150 x 57，24 位 BMP
  LICENSE.txt              MIT 许可 + 中文说明（UTF-8 BOM，NSIS 正确显示中文）

图形是本项目的抽象标记：白色 90° 视野扇形 + 青色行进箭头 + 绿色方位弧，
配色取自启动器（#1E1E1E 中性灰 / #49B2FC 强调色）。没有使用 BetterGI、
米哈游或任何第三方的图标、插画与字体文件；文字用系统自带的微软雅黑渲染。

用法：python scripts/make-assets.py
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
BUILD.mkdir(exist_ok=True)

BG = (30, 30, 30)          # #1E1E1E 与启动器 chrome 一致
CARD = (38, 38, 38)        # #262626
ACCENT = (73, 178, 252)    # #49B2FC
CYAN = (86, 226, 232)      # 游戏里青色玩家箭头
GREEN = (126, 224, 138)    # 视角绿弧
FG = (230, 230, 230)
FG_DIM = (150, 150, 150)

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


def centered(draw, y, text, fnt, fill, width):
    box = draw.textbbox((0, 0), text, font=fnt)
    draw.text(((width - (box[2] - box[0])) / 2, y), text, font=fnt, fill=fill)


def make_mark(size=512, transparent=True):
    """90° 白色视野扇形（内浓外淡）+ 青色行进三角 + 绿色方位弧。"""
    s = 512
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if transparent:
        d.rounded_rectangle((0, 0, s - 1, s - 1), radius=104, fill=BG + (255,))
    else:
        d.rectangle((0, 0, s, s), fill=BG + (255,))

    cx = cy = s / 2
    r0 = 196
    # PIL 角度：0=右、90=下、270=上；225..315 正好是朝上的 90° 扇区
    for r in range(r0, 0, -4):
        alpha = int(96 * (1 - r / r0) ** 1.15)
        d.pieslice((cx - r, cy - r, cx + r, cy + r), 225, 315, fill=(255, 255, 255, alpha))
    # 两条半径边
    import math
    for deg in (225, 315):
        rad = math.radians(deg)
        d.line((cx, cy, cx + r0 * math.cos(rad), cy + r0 * math.sin(rad)),
               fill=(255, 255, 255, 120), width=5)
    d.arc((cx - r0, cy - r0, cx + r0, cy + r0), 225, 315, fill=GREEN + (255,), width=13)

    # 青色行进箭头（顶点在中心，指向上）
    d.polygon([(cx, cy - 118), (cx - 66, cy + 58), (cx, cy + 24), (cx + 66, cy + 58)],
              fill=CYAN + (255,))
    d.ellipse((cx - 13, cy - 13, cx + 13, cy + 13), fill=(255, 255, 255, 255))
    return img.resize((size, size), Image.Resampling.LANCZOS)


def save_bmp(img, name):
    path = BUILD / name
    img.convert("RGB").save(path, format="BMP")
    print(f"  {path.name:24s} {img.width}x{img.height}  {path.stat().st_size} B")


def make_sidebar():
    w, h = 164, 314
    img = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(img)
    # 左侧一条强调色细带，呼应启动器导航选中竖条
    d.rectangle((0, 0, 3, h - 1), fill=ACCENT)
    mark = make_mark(104, transparent=False)
    img.paste(mark.convert("RGB"), (30, 36))
    centered(d, 158, "原神跟跑助手", font(19, True), FG, w)
    centered(d, 188, "Genshin Route Buddy", font(10), FG_DIM, w)
    d.line((28, 216, w - 28, 216), fill=(70, 70, 70), width=1)
    centered(d, 230, "B 站攻略视频悬浮窗", font(11), FG_DIM, w)
    centered(d, 250, "小地图方位跟跑", font(11), FG_DIM, w)
    d.rectangle((28, h - 34, w - 28, h - 32), fill=ACCENT)
    centered(d, h - 24, "v0.2.4", font(9), FG_DIM, w)
    save_bmp(img, "installerSidebar.bmp")


def make_header():
    w, h = 150, 57
    img = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(img)
    mark = make_mark(40, transparent=False)
    img.paste(mark.convert("RGB"), (8, 8))
    d.text((56, 12), "原神跟跑助手", font=font(13, True), fill=FG)
    d.text((56, 33), "Genshin Route Buddy", font=font(8), fill=FG_DIM)
    d.rectangle((0, h - 2, w, h - 1), fill=ACCENT)
    save_bmp(img, "installerHeader.bmp")


def make_icon():
    icon = make_mark(256)
    path = BUILD / "icon.ico"
    icon.save(path, format="ICO",
              sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print(f"  {path.name:24s} 7 sizes      {path.stat().st_size} B")


LICENSE = """原神跟跑助手 / Genshin Route Buddy

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
    path.write_text("\ufeff" + LICENSE.replace("\n", "\r\n"), encoding="utf-8")
    print(f"  {path.name:24s} UTF-8 BOM   {path.stat().st_size} B")


if __name__ == "__main__":
    print("生成 build/ 品牌资源：")
    make_icon()
    make_sidebar()
    make_header()
    make_license()

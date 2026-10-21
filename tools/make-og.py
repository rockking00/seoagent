"""
生成 Open Graph 分享图（1200×630）。

改完首页文案后重新跑一次：

    python tools/make-og.py

需要 Pillow；字体用系统中文字体（Windows 自带微软雅黑）。
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# ---------------- 改这里 ----------------
BRAND = "增长前线"
HEADLINE = ["让 Google 每天给你带来客户，", "而不只是一份报表"]
KICKER = "GOOGLE SEO 顾问 · 出海与外贸"
SUBLINE = "关键词 · 内容结构 · 技术底子 · 数据监测"
FOOTER_LEFT = "example.com"
FOOTER_RIGHT = "只接 3 个项目 · 24 小时内回复"
# ---------------------------------------

W, H = 1200, 630
BG = "#f6f5f1"
INK = "#12141a"
MUTED = "#6a7180"
GREEN = "#0d6b4f"
GREEN_BRIGHT = "#4ade80"
LINE = "#e3e0d8"
MARGIN = 72

BOLD = Path(r"C:\Windows\Fonts\msyhbd.ttc")
REGULAR = Path(r"C:\Windows\Fonts\msyh.ttc")


def font(path: Path, size: int):
    return ImageFont.truetype(str(path), size, index=0)


img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

# 左上角 logo：深色圆角方块 + 绿色折线
d.rounded_rectangle((MARGIN, 62, MARGIN + 50, 112), radius=14, fill=INK)
d.line(
    [(MARGIN + 12, 100), (MARGIN + 22, 89), (MARGIN + 30, 95), (MARGIN + 39, 78)],
    fill=GREEN_BRIGHT,
    width=3,
    joint="curve",
)
d.ellipse((MARGIN + 36, 75, MARGIN + 42, 81), fill=GREEN_BRIGHT)

d.text((MARGIN + 68, 73), BRAND, font=font(BOLD, 30), fill=INK)

# 小标签
d.text((MARGIN, 196), KICKER, font=font(REGULAR, 20), fill=GREEN)

# 主标题：自动缩到不超宽
size = 64
while size > 36:
    f = font(BOLD, size)
    if max(d.textlength(line, font=f) for line in HEADLINE) <= W - 2 * MARGIN:
        break
    size -= 2

f = font(BOLD, size)
y = 244
for line in HEADLINE:
    d.text((MARGIN, y), line, font=f, fill=INK)
    y += int(size * 1.34)

# 副标题
d.text((MARGIN, y + 12), SUBLINE, font=font(REGULAR, 22), fill=MUTED)

# 底部分隔线 + 页脚
d.line([(MARGIN, 520), (W - MARGIN, 520)], fill=LINE, width=1)
d.text((MARGIN, 552), FOOTER_LEFT, font=font(REGULAR, 20), fill=MUTED)

right_font = font(REGULAR, 20)
right_w = d.textlength(FOOTER_RIGHT, font=right_font)
d.text((W - MARGIN - right_w, 552), FOOTER_RIGHT, font=right_font, fill=GREEN)

out = Path(__file__).resolve().parent.parent / "site" / "og.png"
img.save(out, optimize=True)
print(f"saved {out}  ({out.stat().st_size // 1024} KB)")

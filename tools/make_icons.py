"""Erzeugt die App-Icons (PNG) für iOS/Android. Einmalig ausführen: python tools/make_icons.py"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "icons"
OUT.mkdir(exist_ok=True)

BG = (31, 111, 74)       # Tintengrün
PAPER = (251, 248, 241)
INK = (28, 38, 33)
STAMP = (178, 58, 38)


def draw(size: int, pad_ratio: float = 0.0) -> Image.Image:
    S = 1024
    img = Image.new("RGB", (S, S), BG)
    d = ImageDraw.Draw(img)
    inset = int(S * pad_ratio)

    # Kassenbon mit Zickzack-Kante
    l, r = 300 + inset // 2, 724 - inset // 2
    t, b = 190 + inset // 2, 830 - inset // 2
    teeth = 8
    w = (r - l) / teeth
    poly = [(l, t), (r, t), (r, b)]
    for i in range(teeth):
        x1 = r - (i + 0.5) * w
        x2 = r - (i + 1) * w
        poly += [(x1, b - 34), (x2, b)]
    d.polygon(poly, fill=PAPER)

    # Zeilen
    for i, y in enumerate(range(t + 90, t + 90 + 4 * 70, 70)):
        d.rounded_rectangle((l + 55, y, r - (55 if i % 2 == 0 else 150), y + 22), 11, fill=(205, 196, 176))

    # Summenlinie doppelt
    ys = b - 160
    d.rectangle((l + 55, ys, r - 55, ys + 8), fill=INK)
    d.rectangle((l + 55, ys + 18, r - 55, ys + 26), fill=INK)

    # Euro-Stempel
    font = ImageFont.truetype("C:/Windows/Fonts/georgiab.ttf", 250)
    cx, cy, rad = r - 20, t + 40, 120
    d.ellipse((cx - rad, cy - rad, cx + rad, cy + rad), fill=STAMP)
    d.text((cx, cy + 8), "€", font=font, fill=PAPER, anchor="mm")

    return img.resize((size, size), Image.LANCZOS)


draw(180).save(OUT / "apple-touch-icon.png")
draw(192).save(OUT / "icon-192.png")
draw(512).save(OUT / "icon-512.png")
draw(512, pad_ratio=0.18).save(OUT / "icon-maskable-512.png")
print("Icons in", OUT)

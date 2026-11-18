#!/usr/bin/env python3
"""Лицо v2 рядом с официальными рендерами СберКота: 3/4 (design/refs/sbercat_1_jacket.png) и почти анфас (sbercat_2_rugby.png).
python3 tools/face-compare-v2.py <out.png> <cat> <before.png> <after.png>
before/after — PNG из tools/model-compare.mjs с v=face34m,face (две плитки T×T): ряд 1 — реф 3/4 | было 3/4 | стало 3/4,
ряд 2 — реф анфас | было анфас | стало анфас."""
import sys
from PIL import Image, ImageDraw, ImageFont
FONT = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 15)
out, cat, before, after = sys.argv[1:5]
b, a = Image.open(before).convert('RGB'), Image.open(after).convert('RGB')
T = b.height
r1 = Image.open('design/refs/sbercat_1_jacket.png').convert('RGB').crop((60, 100, 540, 580)).resize((T, T), Image.LANCZOS)
r2 = Image.open('design/refs/sbercat_2_rugby.png').convert('RGB').crop((40, 170, 330, 460)).resize((T, T), Image.LANCZOS)
sh = Image.new('RGB', (3 * T, 2 * T), 'white')
d = ImageDraw.Draw(sh)
for row, ref in enumerate((r1, r2)):
    sh.paste(ref, (0, row * T))
    sh.paste(b.crop((row * T, 0, row * T + T, T)), (T, row * T))
    sh.paste(a.crop((row * T, 0, row * T + T, T)), (2 * T, row * T))
for i, l in enumerate(['СберКот (design/refs)', f'было — {cat}', f'стало v2 — {cat}']):
    for row in range(2):
        w = d.textlength(l, font=FONT); d.rectangle((i * T, row * T, i * T + w + 12, row * T + 22), fill='white'); d.text((i * T + 6, row * T + 3), l, fill=(20, 20, 20), font=FONT)
sh.save(out, optimize=True)

#!/usr/bin/env python3
"""Лицо крупно рядом с официальным рендером СберКота (design/refs/sbercat_1_jacket.png):
python3 tools/face-compare.py <out.png> <cat> <render.png> [render2.png ...] [--labels a,b]
render — PNG из tools/model-compare.mjs с v=face34,face (две плитки, каждая H×H)."""
import sys
from PIL import Image, ImageDraw, ImageFont
FONT = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 15)
out, cat = sys.argv[1], sys.argv[2]
args = sys.argv[3:]
labels = args[args.index('--labels') + 1].split(',') if '--labels' in args else None
renders = [a for a in args if a.endswith('.png')]
first = Image.open(renders[0]); T = first.height
ref = Image.open('design/refs/sbercat_1_jacket.png').convert('RGB').crop((60, 100, 540, 580)).resize((T, T), Image.LANCZOS)
sheet = Image.new('RGB', (T * 3, T * len(renders)), 'white')
d = ImageDraw.Draw(sheet)
for i, r in enumerate(renders):
    sheet.paste(ref, (0, i * T)); sheet.paste(Image.open(r).convert('RGB').resize((T * 2, T)), (T, i * T))
    l = (labels[i] if labels else r) + f' — {cat}: 3/4, анфас'
    w = d.textlength(l, font=FONT); d.rectangle((T, i * T, T + w + 12, i * T + 22), fill='white'); d.text((T + 6, i * T + 3), l, fill=(20, 20, 20), font=FONT)
d.rectangle((0, 0, 200, 22), fill='white'); d.text((6, 3), 'референс design/refs', fill=(20, 20, 20), font=FONT)
sheet.save(out, optimize=True)

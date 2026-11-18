#!/usr/bin/env python3
"""Лист «референс | модель»: python3 tools/model-compare.py <cat> <render.png> <out.png> [render2.png ...] [--labels реф,до,после]
render — PNG из tools/model-compare.mjs (5 видов: front, three_quarter, side, back, face, каждый W×H).
Верхний ряд — design/cut/<cat>/turn/*.png (+ лицо, вырезанное из front), ниже — рендеры."""
import sys
from PIL import Image, ImageDraw, ImageFont
FONT = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 15)
cat, out = sys.argv[1], sys.argv[3]
renders = [sys.argv[2]] + [a for a in sys.argv[4:] if a.endswith('.png')]
VIEWS = ['front', 'three_quarter', 'side', 'back']
first = Image.open(renders[0]).convert('RGB')
W, H = first.width // 5, first.height
def fit(im, w, h, bg=(236, 236, 238)):
    im = im.convert('RGBA'); bb = im.getbbox() or (0, 0, im.width, im.height); im = im.crop(bb)
    k = min(w / im.width, h * 0.89 / im.height); im = im.resize((max(1, int(im.width * k)), max(1, int(im.height * k))), Image.LANCZOS)
    c = Image.new('RGB', (w, h), bg); c.paste(im, ((w - im.width) // 2, (h - im.height) // 2), im); return c
row = Image.new('RGB', (W * 5, H), (236, 236, 238))
for i, v in enumerate(VIEWS):
    row.paste(fit(Image.open(f'design/cut/{cat}/turn/{v}.png'), W, H), (i * W, 0))
fr = Image.open(f'design/cut/{cat}/turn/front.png').convert('RGBA'); bb = fr.getbbox(); fr = fr.crop(bb)
fw, fh = fr.size; face = fr.crop((int(fw * 0.18), 0, int(fw * 0.82), int(fh * 0.5)))
face = face.resize((W, int(face.height * W / face.width)), Image.LANCZOS); fc = Image.new('RGB', (W, H), (236, 236, 238))
fc.paste(face, (0, max(0, (H - face.height) // 2)), face); row.paste(fc, (4 * W, 0))
names = sys.argv[sys.argv.index('--labels') + 1].split(',') if '--labels' in sys.argv else None
if names:
    renders = renders[:len(names) - 1]
labels = ['референс (design/sheets)'] + (names[1:] if names else [r.split('/')[-1].rsplit('.', 1)[0] for r in renders])
sheet = Image.new('RGB', (W * 5, H * (1 + len(renders)) ), (255, 255, 255))
sheet.paste(row, (0, 0))
for j, r in enumerate(renders):
    sheet.paste(Image.open(r).convert('RGB').resize((W * 5, H)), (0, H * (j + 1)))
d = ImageDraw.Draw(sheet)
for j, l in enumerate(labels):
    w = d.textlength(l, font=FONT)
    d.rectangle((0, j * H, w + 12, j * H + 22), fill=(255, 255, 255)); d.text((6, j * H + 3), l, fill=(20, 20, 20), font=FONT)
sheet.save(out, optimize=True)

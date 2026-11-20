#!/usr/bin/env python3
"""Лист «реф персонажа | модели» (tools/persona-shot.mjs, виды pilot,front,tq,face,faceup по W×H):
python3 tools/persona-sheet.py <cat> <out.png> <render.png>... --labels "v1,v2"
Верхний ряд — design/cut/<cat>/turn (front как pilot и front, three_quarter, лицо из front дважды), ниже — рендеры.
--refrow "подпись|a.png,b.png,,d.png,e.png" (можно несколько) — свои ряды рефов вместо design/cut: по картинке на колонку,
пусто — пустая клетка (картинки вписываются целиком; прозрачность учитывается)."""
import os, sys
from PIL import Image, ImageDraw, ImageFont
FONT = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 16)
args = [a for a in sys.argv[1:]]
labels = None
if '--labels' in args:
    i = args.index('--labels'); labels = args[i + 1].split(','); del args[i:i + 2]
refrows = []
while '--refrow' in args:
    i = args.index('--refrow'); lab_, ims_ = args[i + 1].split('|', 1); refrows.append((lab_, ims_.split(','))); del args[i:i + 2]
cat, out, renders = args[0], args[1], args[2:]
N = 5
first = Image.open(renders[0]).convert('RGB')
W, H = first.width // N, first.height
BG = (236, 236, 238)
def fit(im, w, h):
    im = im.convert('RGBA'); im = im.crop(im.getbbox())
    k = min(w / im.width, h * 0.9 / im.height); im = im.resize((max(1, int(im.width * k)), max(1, int(im.height * k))), Image.LANCZOS)
    c = Image.new('RGB', (w, h), BG); c.paste(im, ((w - im.width) // 2, (h - im.height) // 2), im); return c
def face(path):
    fr = Image.open(path).convert('RGBA'); fr = fr.crop(fr.getbbox()); fw, fh = fr.size
    f = fr.crop((int(fw * 0.17), 0, int(fw * 0.83), int(fh * 0.47)))
    k = min(W / f.width, H / f.height); f = f.resize((int(f.width * k), int(f.height * k)), Image.LANCZOS)
    c = Image.new('RGB', (W, H), BG); c.paste(f, ((W - f.width) // 2, (H - f.height) // 2), f); return c
ref = Image.new('RGB', (W * N, H), BG)
d = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'design', 'cut', cat, 'turn') + '/'
for i, im in enumerate([fit(Image.open(d + 'front.png'), W, H), fit(Image.open(d + 'front.png'), W, H),
                        fit(Image.open(d + 'three_quarter.png'), W, H), face(d + 'front.png'), face(d + 'front.png')]):
    ref.paste(im, (i * W, 0))
refs, refnames = [ref], ['реф design/cut/' + cat]
if refrows:
    refs, refnames = [], []
    for lab_, ims_ in refrows:
        r_ = Image.new('RGB', (W * N, H), BG)
        for i, pth in enumerate(ims_[:N]):
            if pth:
                r_.paste(fit(Image.open(pth), W, H), (i * W, 0))
        refs.append(r_); refnames.append(lab_)
rows = refs + [Image.open(p).convert('RGB').resize((W * N, H)) for p in renders]
names = refnames + (labels or [p.split('/')[-1] for p in renders])
sheet = Image.new('RGB', (W * N, H * len(rows)), (255, 255, 255))
dr = ImageDraw.Draw(sheet)
for j, row in enumerate(rows):
    sheet.paste(row, (0, j * H))
    t = names[j]; w = dr.textlength(t, font=FONT)
    dr.rectangle((0, j * H, w + 12, j * H + 24), fill=(255, 255, 255)); dr.text((6, j * H + 3), t, fill=(20, 20, 20), font=FONT)
cols = ['пилот (сверху 30°)', 'анфас', '3/4', 'лицо', 'лицо сверху']
for i, t in enumerate(cols):
    w = dr.textlength(t, font=FONT); dr.text((i * W + W - w - 6, H - 22), t, fill=(90, 90, 90), font=FONT)
sheet.save(out, optimize=True)

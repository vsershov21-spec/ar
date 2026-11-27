"""Лист согласования лица Блёстки v5c (scripts/models/build_glitter_v5.sh, src/character/v5Face.ts): 9 эмоций крупно
«реф design/cut/glitter/face | v5c» одинаковым кадром + речь кадрами (обычная — рот Tripo, под эмоцией — нарисованный).

    npx vite --port 4396 &  export FACE_PORT=4396 D=/tmp/v5c/sheet; mkdir -p $D
    # первый кадр — разгон (голова ещё доворачивается), в лист не идёт
    PAGE=emo-preview node tools/face-shot.mjs $D/emo.png "p=glitter&models=v5&s=neutral,neutral,happy,laugh,surprised,sad,annoyed,offended,shy,wink_r&cols=10&tile=420&dist=8&dy=-0.1"
    PAGE=emo-preview node tools/face-shot.mjs $D/talk.png "p=glitter&models=v5&text=Привет! Я Блёстка, давай играть вместе?&s=neutral,blink:0.075,seq:0.25,seq:0.5,seq:0.75,seq:1.0,sad%2BA,sad%2BO,offended%2BE,annoyed%2BA&cols=10&tile=250&dist=8&dy=-0.1"
    python3 tools/glitter-v5c-sheet.py $D /home/claude/glitter_v5c_face.jpg
Живое лицо (GIF): PORT=4396 node tools/face-anim.mjs out.gif "p=glitter&models=v5&fps=12&idle=3&text=<реплика>&tile=320&dist=10"
"""
import sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont

D, OUT = sys.argv[1:3]
BG = (236, 236, 238)
F = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 20)
FB = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 24)


def lab(t, s):
    t = t.copy(); d = ImageDraw.Draw(t)
    d.rectangle((0, t.height - 28, t.width, t.height), fill=(255, 255, 255)); d.text((6, t.height - 26), s, fill=(20, 20, 30), font=F)
    return t


def tiles(path, n, T):
    im = Image.open(path).convert('RGB')
    return [im.crop((i * T, 0, (i + 1) * T, T)) for i in range(n)]


def ref(name, T):
    im = Image.open(f'design/cut/glitter/face/{name}.png').convert('RGBA')
    a = np.array(im)[..., 3]
    ys, xs = np.where(a > 20)
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    h = y1 - y0
    side = int(h * 0.78)
    cx = (x0 + x1) // 2
    box = (cx - side // 2, y0 + int(h * 0.02), cx + side // 2, y0 + int(h * 0.02) + side)
    bg = Image.new('RGBA', im.size, (*BG, 255)); bg.alpha_composite(im)
    return bg.convert('RGB').crop(box).resize((T, T), Image.LANCZOS)


T = 420
emo = [('neutral', 'покой'), ('excited', 'радость'), ('laugh', 'смех'), ('surprised', 'удивление'), ('sad', 'грусть'),
       ('offended', 'недовольство'), ('offended', 'обида'), ('shy', 'смущение'), ('wink', 'подмигнуть')]
mine = tiles(f'{D}/emo.png', 10, T)[1:]
pairs = []
for (r, n), t in zip(emo, mine):
    p = Image.new('RGB', (2 * T + 6, T + 40), BG)
    ImageDraw.Draw(p).text((8, 6), n, fill=(20, 20, 30), font=FB)
    p.paste(lab(ref(r, T), 'реф design/cut'), (0, 40)); p.paste(lab(t, 'v5c'), (T + 6, 40))
    pairs.append(p)
cols = 3
W = cols * (2 * T + 6) + (cols - 1) * 16
rows = []
for i in range(0, len(pairs), cols):
    row = Image.new('RGB', (W, T + 40), BG)
    for k, p in enumerate(pairs[i:i + cols]):
        row.paste(p, (k * (2 * T + 6 + 16), 0))
    rows.append(row)
T2 = 250
tk = tiles(f'{D}/talk.png', 10, T2)
la = ['покой', 'моргание', 'речь 0.25 с', 'речь 0.5 с', 'речь 0.75 с', 'речь 1.0 с', 'грусть + «а»', 'грусть + «о»', 'обида + «э»', 'недовольство + «а»']
talk = Image.new('RGB', (W, T2 + 40), BG)
ImageDraw.Draw(talk).text((8, 6), 'Речь кадрами: обычная — рот Tripo; под эмоцией — нарисованный рот приоткрывается', fill=(20, 20, 30), font=FB)
x = 0
for t, s in zip(tk, la):
    if x + T2 > W:
        break
    talk.paste(lab(t, s), (x, 40)); x += T2 + 4
rows.append(talk)
out = Image.new('RGB', (W, sum(r.height for r in rows) + 8 * len(rows)), BG)
y = 0
for r in rows:
    out.paste(r, (0, y)); y += r.height + 8
out.save(OUT, quality=88)
print('→', OUT, out.size)

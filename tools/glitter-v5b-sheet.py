"""Листы согласования Блёстки v5b (мех как у Хулигана/Добряка, живое лицо; scripts/models/build_glitter_v5.sh):
  fur  — лицо и спина крупно: Хулиган | Добряк | v5 без меха | v5 с мехом (телефонное число оболочек ?fur=6);
  face — покой, моргание, речь кадрами (реплика с липсинком), эмоции рядом с design/cut/glitter/face.

    npx vite --port 4395 &  export PORT=4395 FACE_PORT=4395 D=/tmp/v5b/sheet
    Q="fur=6&v=face,backc&w=360&h=420" node tools/persona-shot.mjs $D/fur h hooligan kind
    Q="models=v5&fur=0&v=face,backc&w=360&h=420" node tools/persona-shot.mjs $D/fur v5off glitter
    Q="models=v5&fur=6&v=face,backc&w=360&h=420" node tools/persona-shot.mjs $D/fur v5on glitter
    PAGE=emo-preview node tools/face-shot.mjs $D/face_a.png "p=glitter&models=v5&text=<реплика>&s=neutral,blink:0.04,blink:0.075,seq:0.25,…,seq:1.5&cols=9&tile=300&dist=8&dy=-0.1"
    PAGE=emo-preview node tools/face-shot.mjs $D/face_b.png "p=glitter&models=v5&s=neutral,happy,laugh,surprised,sad,annoyed,offended,shy,wink_r&cols=9&tile=300&dist=8&dy=-0.1"
    python3 tools/glitter-v5b-sheet.py $D fur.jpg face.jpg
Живое лицо (GIF): node tools/face-anim.mjs out.gif "p=glitter&models=v5&fps=12&idle=4&text=<реплика>&tile=320&dist=10"
"""
import sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont

D, OUT_FUR, OUT_FACE = sys.argv[1:4]
BG = (236, 236, 238)
F = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 17)
FB = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 22)


def lab(t, s):
    t = t.copy(); d = ImageDraw.Draw(t)
    d.rectangle((0, t.height - 24, t.width, t.height), fill=(255, 255, 255)); d.text((6, t.height - 22), s, fill=(20, 20, 30), font=F)
    return t


def row(title, ts, w):
    h = max(t.height for t in ts)
    out = Image.new('RGB', (max(w, sum(t.width for t in ts)), h + 34), BG)
    ImageDraw.Draw(out).text((8, 5), title, fill=(20, 20, 30), font=FB)
    x = 0
    for t in ts:
        out.paste(t, (x, 34)); x += t.width
    return out


def stack(rows, path):
    w = max(r.width for r in rows)
    out = Image.new('RGB', (w, sum(r.height for r in rows)), BG)
    y = 0
    for r in rows:
        out.paste(r, (0, y)); y += r.height
    out.save(path, quality=90)
    print('→', path, out.size)


# ── мех ──
TW, TH = 360, 420
cols = [('h_hooligan', 'Хулиган'), ('h_kind', 'Добряк'), ('v5off_glitter', 'v5 без меха'), ('v5on_glitter', 'v5 с мехом (новый)')]
ims = {k: Image.open(f'{D}/fur/{k}.png').convert('RGB') for k, _ in cols}
face = [lab(ims[k].crop((0, 0, TW, TH)), n) for k, n in cols]
back = [lab(ims[k].crop((TW, 0, 2 * TW, TH)), n) for k, n in cols]
stack([row('Мех: лицо крупно (телефон: 6 оболочек + пряди силуэта)', face, 4 * TW),
       row('Мех: спина крупно (затылок, хвост)', back, 4 * TW)], OUT_FUR)

# ── лицо ──
T = 300


def tiles(path, n):
    im = Image.open(path).convert('RGB')
    return [im.crop((i * T, 0, (i + 1) * T, T)) for i in range(n)]


def ref(name):
    im = Image.open(f'design/cut/glitter/face/{name}.png').convert('RGBA')
    a = np.array(im)[..., 3]
    ys, xs = np.where(a > 20)
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    h = y1 - y0
    # голова: верх банта … подбородок (≈ 75 % высоты выреза), квадрат по центру
    side = int(h * 0.78)
    cx = (x0 + x1) // 2
    box = (cx - side // 2, y0 + int(h * 0.02), cx + side // 2, y0 + int(h * 0.02) + side)
    bg = Image.new('RGBA', im.size, (*BG, 255)); bg.alpha_composite(im)
    return bg.convert('RGB').crop(box).resize((T, T), Image.LANCZOS)


fa = tiles(f'{D}/face_a.png', 9)
la = ['покой', 'моргание ½', 'моргание', 'речь 0.25 с', 'речь 0.5 с', 'речь 0.75 с', 'речь 1.0 с', 'речь 1.25 с', 'речь 1.5 с']
fb = tiles(f'{D}/face_b.png', 9)
emo = [('neutral', 'neutral', 'покой'), ('happy', 'excited', 'радость'), ('laugh', 'laugh', 'смех'), ('surprised', 'surprised', 'удивление'),
       ('sad', 'sad', 'грусть'), ('annoyed', 'offended', 'недовольство'), ('offended', 'offended', 'обида'), ('shy', 'shy', 'смущение'),
       ('wink_r', 'wink', 'подмигнуть')]
refs = [lab(ref(r), f'реф: {n}') for _, r, n in emo]
mine = [lab(t, f'v5: {n}') for t, (_, _, n) in zip(fb, emo)]
stack([row('Покой, моргание, речь кадрами («Привет! Я Блёстка, давай играть вместе?», липсинк + брови/щёки V5Life)', [lab(t, s) for t, s in zip(fa, la)], 9 * T),
       row('Эмоции: реф design/cut/glitter/face', refs, 9 * T),
       row('Эмоции: v5 (брови сильнее, хмурый рот закрывает улыбку Tripo, веки, румянец шейдером)', mine, 9 * T)], OUT_FACE)

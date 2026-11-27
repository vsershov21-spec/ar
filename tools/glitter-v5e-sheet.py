"""Лист согласования лица Блёстки v5e: 9 эмоций «реф design/cut/glitter/face | v5e» ОДИНАКОВЫМ кадром и в той же позе
головы, что реф. Кадр обоих — по силуэту (PNG с альфой): верх силуэта, ширина головы на высоте глаз → квадрат; поза — камера
повёрнута так, чтобы нос сидел на голове так же, как на рефе (поворот реф: смещение носа от середины силуэта). Снимать на
СЖАТОЙ модели (model-opt: KTX2 1024² + meshopt), как в приложении:

    node scripts/build/model-opt.mjs public/models/v2/glitter_v5.glb --out public/models/v2/zz_v5e_opt.glb   # не коммитить
    npx vite --port 4396 &
    python3 tools/glitter-v5e-sheet.py shoot /tmp/v5e/sheet          # кадры: по эмоции — с поворотом камеры по рефу
    python3 tools/glitter-v5e-sheet.py sheet /tmp/v5e/sheet /home/claude/glitter_v5e_face.jpg
Живое лицо (GIF, смена эмоций по очереди):
    PORT=4396 node tools/face-anim.mjs out.gif "p=glitter&m=/models/v2/zz_v5e_opt.glb&fps=12&idle=1.5&emos=excited@1.5,laugh@3,surprised@4.5,sad@6,offended@7.5,shy@9,wink_r@10.5,neutral@12&tile=300&dist=9&dy=0.05"
"""
import json
import os
import subprocess
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from scipy import ndimage as nd

BG = (236, 236, 238)
EMO = [('neutral', 'neutral', 'покой'), ('excited', 'excited', 'радость'), ('laugh', 'laugh', 'смех'),
       ('surprised', 'surprised', 'удивление'), ('sad', 'sad', 'грусть'), ('offended', 'offended', 'обида'),
       ('annoyed', 'offended', 'недовольство (реф — обида)'), ('shy', 'shy', 'смущение'), ('wink_r', 'wink', 'подмигнуть')]
M = os.environ.get('M', '/models/v2/zz_v5e_opt.glb')


def nose_at(a):
    """нос: верхний из розовых пятен у середины силуэта ниже ушей (уши, бант, рот — мимо)"""
    r, g, b, al = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    rows = np.where((al > 100).any(1))[0]
    top = int(rows.min())
    wid = [np.ptp(np.where(al[y] > 100)[0]) for y in rows[: max(1, len(rows) * 3 // 5)]]
    Wd = float(np.max(wid))
    pink = (r > g + 30) & (r > b + 5) & (al > 200) & (r > 150)
    lab, n = nd.label(pink)
    ym = rows[np.argmax([np.ptp(np.where(al[y] > 100)[0]) for y in rows[: max(1, len(rows) * 3 // 5)]])]
    xr = np.where(al[ym] > 100)[0]
    gmid = (xr.min() + xr.max()) / 2
    best = None
    for i in range(1, n + 1):
        if int((lab == i).sum()) < 60:
            continue
        cy, cx = nd.center_of_mass(pink, lab, i)
        rw = np.where(al[int(cy)] > 100)[0]
        if cy < top + 0.3 * Wd or min(cx - rw.min(), rw.max() - cx) < 0.18 * Wd:
            continue
        sc = abs(cx - gmid) + 0.5 * (cy - top)
        if best is None or sc < best[2]:
            best = (cy, cx, sc)
    return top, best[0], best[1]


def measure(a):
    """RGBA → nose: смещение носа от середины между глазами в долях расстояния между глазами (поворот головы; у закрытых
    глаз — None), ey — y глаз, top — верх силуэта, hwE/cE — полуширина и центр силуэта на высоте глаз (носа)"""
    a = a.astype(int)
    r, g, b, al = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    H = a.shape[0]
    top, ny, nx = nose_at(a)
    gr = (g > r + 30) & (g > b) & (al > 200)
    gr[int(ny):] = False
    nose = None; ey = int(ny - 0.08 * (H - top))
    if gr.sum() > 200:
        yl, xl = np.where(gr[:, :int(nx)]); yr, xr = np.where(gr[:, int(nx):])
        if len(xl) > 50 and len(xr) > 50:
            el, er = np.median(xl), np.median(xr) + int(nx)
            nose = (nx - (el + er) / 2) / (er - el)
            ey = int((np.median(yl) + np.median(yr)) / 2)
    rowe = np.where(al[ey] > 100)[0]
    return dict(nose=nose, ey=ey, top=top, hwE=(rowe.max() - rowe.min()) / 2, cE=(rowe.max() + rowe.min()) / 2)


def crop(im, T):
    """кадр по силуэту (одинаково для рефа и v5e): сторона — 1.3 ширины головы на высоте носа, верх — верх силуэта (бант),
    по горизонтали — середина силуэта на высоте носа"""
    a = np.array(im).astype(int)
    r, g, b, al = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    H = a.shape[0]
    top, ny, _ = nose_at(a)
    row = np.where(al[int(ny)] > 100)[0]
    side = 1.3 * (row.max() - row.min())
    cx = (row.min() + row.max()) / 2
    y0 = top - 0.04 * side
    box = (int(cx - side / 2), int(y0), int(cx + side / 2), int(y0 + side))
    bg = Image.new('RGBA', (im.width + 2000, im.height + 2000), (*BG, 255)); bg.alpha_composite(im, (1000, 1000))
    return bg.convert('RGB').crop(tuple(v + 1000 for v in box)).resize((T, T), Image.LANCZOS)


def ref_img(name):
    return Image.open(f'design/cut/glitter/face/{name}.png').convert('RGBA')


def shoot_one(D, st, yaw, pitch=0.0):
    out = f'{D}/{st}.png'
    q = f'p=glitter&m={M}&s=neutral,{st}&cols=2&tile=900&dist=13&dy=-0.12&yaw={yaw:.2f}&pitch={pitch:.2f}&bg=none'
    env = dict(os.environ, FACE_PORT=os.environ.get('FACE_PORT', '4396'), PAGE='emo-preview', ALPHA='1')
    subprocess.run(['node', 'tools/face-shot.mjs', f'{D}/_raw.png', q], env=env, check=True, capture_output=True)
    im = Image.open(f'{D}/_raw.png').convert('RGBA')
    im.crop((900, 0, 1800, 900)).save(out)
    return Image.open(out).convert('RGBA')


# поворот головы рефа (°, > 0 — нос вправо на картинке): смещение носа от середины между глазами, переведённое по наклону
# v5e (−20° камеры → 0.117 межглазья); грусть — с поправкой на опущенную голову; смех и подмигнуть (глаза закрыты) — как
# радость; смущение — по силуэту (голова отвёрнута влево)
REF_YAW = {'neutral': 16, 'excited': 20, 'laugh': 20, 'surprised': 27, 'sad': 28, 'offended': 31, 'annoyed': 31, 'shy': -12, 'wink_r': 20}


def shoot(D):
    """камера: поворот = поворот головы v5e по эмоции (V5_POSES.head, рысканье: голова + шея) − поворот рефа"""
    os.makedirs(D, exist_ok=True)
    src = open('src/character/v5Face.ts', encoding='utf-8').read()
    import re
    for st, rf, _ in EMO:
        m = re.search(r"\n  " + st + r": \{[^}]*?head: \[([-\d.]+),", src)
        hy = float(m.group(1)) * 180 / np.pi if m else 0.0
        yaw = hy - REF_YAW[st]
        shoot_one(D, st, yaw)
        print(st, f'голова {hy:.1f}°, камера {yaw:.1f}°')


def sheet(D, OUT):
    F = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 20)
    FB = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 24)
    T = 420

    def lab(t, s):
        t = t.copy(); d = ImageDraw.Draw(t)
        d.rectangle((0, t.height - 28, t.width, t.height), fill=(255, 255, 255)); d.text((6, t.height - 26), s, fill=(20, 20, 30), font=F)
        return t
    pairs = []
    for st, rf, n in EMO:
        p = Image.new('RGB', (2 * T + 6, T + 40), BG)
        ImageDraw.Draw(p).text((8, 6), n, fill=(20, 20, 30), font=FB)
        p.paste(lab(crop(ref_img(rf), T), 'реф design/cut'), (0, 40))
        p.paste(lab(crop(Image.open(f'{D}/{st}.png').convert('RGBA'), T), 'v5e'), (T + 6, 40))
        pairs.append(p)
    cols = 3
    W = cols * (2 * T + 6) + (cols - 1) * 16
    rows = (len(pairs) + cols - 1) // cols
    out = Image.new('RGB', (W, rows * (T + 56)), BG)
    for i, p in enumerate(pairs):
        out.paste(p, ((i % cols) * (2 * T + 22), (i // cols) * (T + 56)))
    out.save(OUT, quality=88)
    print(OUT, out.size)


if __name__ == '__main__':
    if sys.argv[1] == 'shoot':
        shoot(sys.argv[2])
    else:
        sheet(sys.argv[2], sys.argv[3])

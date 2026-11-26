"""База котов + скин (docs/models/BASE.md): кот в приложении поверх рефа персонажа — реф | модель | наложение 50 %,
4 ракурса (вид во весь рост — по силуэту) и лицо крупно (по радужкам); IoU силуэтов и метки лица (нос/рот в межглазьях).

    npx vite --port 4471 &
    PORT=4471 Q="v=front,tq,sider,back,face&w=600&h=880&models=base&bg=ffffff&fz=9" node tools/persona-shot.mjs D nb hooligan kind glitter
    python3 tools/base-overlay.py D/nb_<кот>.png <кот> out.jpg

Рефы: Блёстка — design/refs/glitter_views/{front,threequarter,right,back}_white.png (разворот 23.11), Хулиган и
Добряк — design/cut/<кот>/turn/{front,three_quarter,side,back}.png (вырезки с прозрачным фоном → на белом).
"""

import os, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
T = 420
F = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 17)
FB = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 22)
BG = (236, 236, 238)


def mask(a):
    a = a.astype(np.int16)
    return (a.min(2) < 228) | (a.max(2) - a.min(2) > 18)


def eyes(a):
    """центры зелёных радужек (левый, правый) — пиксели g ≫ r, b"""
    a = a.astype(np.int16)
    m = (a[..., 1] > a[..., 0] + 35) & (a[..., 1] > a[..., 2] + 35) & (a[..., 1] > 70)
    from scipy import ndimage as nd
    lab, k = nd.label(m)
    if k >= 2:  # две крупнейшие компоненты (радужки), без бирюзы худи
        sz = nd.sum(m, lab, range(1, k + 1))
        m = np.isin(lab, 1 + np.argsort(-sz)[:2])
    ys, xs = np.nonzero(m)
    if len(xs) < 20:
        return None
    # два кластера по x (k-средних в 1D)
    c = np.percentile(xs, [20, 80]).astype(float)
    for _ in range(10):
        k = np.abs(xs[:, None] - c[None]).argmin(1)
        c = np.array([xs[k == i].mean() for i in (0, 1)])
    pts = [np.array([xs[k == i].mean(), ys[k == i].mean()]) for i in (0, 1)]
    return sorted(pts, key=lambda p: p[0])


def face_marks(a, eye_pts):
    """нос (розовое пятно), рот (тёмно-красное), радужка — в долях межглазья от середины глаз"""
    from scipy import ndimage as nd
    a = a.astype(np.int16)
    io = eye_pts[1][0] - eye_pts[0][0]; c = (eye_pts[0] + eye_pts[1]) / 2
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    H, W = r.shape
    Y, X = np.mgrid[:H, :W]
    near = (np.abs(X - c[0]) < 0.45 * io) & (Y > c[1] + 0.02 * io) & (Y < c[1] + 1.0 * io)
    out = {}
    for nm, m in (('нос', (r > g + 25) & (r > b + 5) & (r > 150)), ('рот', (r > g + 25) & (r < 150))):
        lab, k = nd.label(m & near)
        if not k:
            continue
        sz = nd.sum(m & near, lab, range(1, k + 1))
        i = int(np.argmax(sz)) + 1 if nm == 'рот' else None
        if nm == 'нос':  # самое верхнее крупное розовое пятно
            big = [j + 1 for j in range(k) if sz[j] > 0.15 * sz.max()]
            i = min(big, key=lambda j: Y[lab == j].mean())
        ys, xs = np.nonzero(lab == i)
        out[nm] = ((xs.max() - xs.min()) / io, (ys.min() - c[1]) / io, (ys.max() - c[1]) / io, a[lab == i].mean(0).round().astype(int).tolist())
    return out


def fit_body(ref, mod):
    """масштаб и сдвиг mod → ref по силуэту (верх/низ, середина по x)"""
    mr, mm = mask(ref), mask(mod)
    def bb(m):
        ys, xs = np.nonzero(m)
        return ys.min(), ys.max(), xs.mean()
    r0, r1, rx = bb(mr); m0, m1, mx = bb(mm)
    s = (r1 - r0) / (m1 - m0)
    return s, rx - mx * s, r0 - m0 * s


def warp(img, s, tx, ty, size):
    return img.transform(size, Image.AFFINE, (1 / s, 0, -tx / s, 0, 1 / s, -ty / s), Image.BICUBIC, fillcolor=(255, 255, 255))


def tile(im, w=T, h=None):
    h = h or round(im.height * w / im.width)
    return im.resize((w, h), Image.LANCZOS)


def lab(t, s):
    t = t.copy(); d = ImageDraw.Draw(t)
    d.rectangle((0, t.height - 24, t.width, t.height), fill=(255, 255, 255)); d.text((6, t.height - 22), s, fill=(20, 20, 30), font=F)
    return t



REFS = {
    'glitter': [('front', 'design/refs/glitter_views/front_white.png'), ('threequarter', 'design/refs/glitter_views/threequarter_white.png'),
                ('right', 'design/refs/glitter_views/right_white.png'), ('back', 'design/refs/glitter_views/back_white.png')],
}
for _c in ('hooligan', 'kind'):
    REFS[_c] = [(n, f'design/cut/{_c}/turn/{f}.png') for n, f in (('front', 'front'), ('threequarter', 'three_quarter'), ('right', 'side'), ('back', 'back'))]
NAMES = {'glitter': 'Блёстка', 'hooligan': 'Хулиган', 'kind': 'Добряк'}


def load_ref(p):
    im = Image.open(os.path.join(ROOT, p))
    if im.mode == 'RGBA':
        bg = Image.new('RGB', im.size, (255, 255, 255)); bg.paste(im, (0, 0), im)
        im = bg
    im = im.convert('RGB')
    # поля вокруг силуэта, 800×960 как у разворота Блёстки
    m = mask(np.asarray(im)); ys, xs = np.nonzero(m)
    cx, cy = (xs.min() + xs.max()) / 2, (ys.min() + ys.max()) / 2
    h = (ys.max() - ys.min()) / 0.9
    w = h * 800 / 960
    box = (int(cx - w / 2), int(cy - h / 2), int(cx + w / 2), int(cy + h / 2))
    out = Image.new('RGB', (box[2] - box[0], box[3] - box[1]), (255, 255, 255))
    out.paste(im, (-box[0], -box[1]))
    return out.resize((800, 960), Image.LANCZOS)


def main():
    shot, cat, out = sys.argv[1:4]
    title = 'база+скин'
    S = Image.open(shot).convert('RGB')
    n = 5; w = S.width // n
    shots = [S.crop((i * w, 0, (i + 1) * w, S.height)) for i in range(n)]
    rows, stats = [], []
    for i, (nm, p) in enumerate(REFS[cat]):
        ref = load_ref(p)
        s, tx, ty = fit_body(np.asarray(ref), np.asarray(shots[i]))
        mod = warp(shots[i], s, tx, ty, ref.size)
        mr, mm = mask(np.asarray(ref)), mask(np.asarray(mod))
        iou = (mr & mm).sum() / max((mr | mm).sum(), 1)
        ov = Image.blend(ref, mod, 0.5)
        ed = mm ^ np.roll(mm, 1, 0) | mm ^ np.roll(mm, 1, 1)
        oa = np.asarray(ov).copy(); oa[ed] = (230, 40, 120); ov = Image.fromarray(oa)
        stats.append(f'{nm}: IoU {iou:.3f}')
        rows.append([lab(tile(ref), f'реф {nm}'), lab(tile(mod), title), lab(tile(ov), f'50 %  IoU {iou:.3f}')])
    ref = load_ref(REFS[cat][0][1])
    ra = np.asarray(ref)
    er = eyes(ra[150:520])
    if er:
        er = [p + (0, 150) for p in er]
        io = er[1][0] - er[0][0]
        c = (er[0] + er[1]) / 2
        box = (int(c[0] - 1.9 * io), int(c[1] - 2.0 * io), int(c[0] + 1.9 * io), int(c[1] + 1.5 * io))
        refc = ref.crop(box).resize((800, int(800 * (box[3] - box[1]) / (box[2] - box[0]))), Image.LANCZOS)
        k = 800 / (box[2] - box[0])
        er = [(p - box[:2]) * k for p in er]; io *= k; c = (er[0] + er[1]) / 2
        em = eyes(np.asarray(shots[4]))
        if em:
            s = (er[1][0] - er[0][0]) / (em[1][0] - em[0][0])
            cm = (em[0] + em[1]) / 2
            mod = warp(shots[4], s, c[0] - cm[0] * s, c[1] - cm[1] * s, refc.size)
            emw = eyes(np.asarray(mod))
            for who, img, pts in (('реф', refc, er), (title, mod, emw)):
                if pts:
                    fm = face_marks(np.asarray(img), pts)
                    stats.append(who + ': ' + ', '.join(f'{k_} ш {v[0]:.2f} y {v[1]:.2f}..{v[2]:.2f} цвет {v[3]}' for k_, v in fm.items()))
        else:
            mod = shots[4].resize(refc.size)
        ov = Image.blend(refc, mod, 0.5)
        rows.append([lab(tile(refc), 'реф лицо'), lab(tile(mod), f'{title} лицо'), lab(tile(ov), '50 % (по радужкам)')])
    hs = [max(t.height for t in r) for r in rows]
    sheet = Image.new('RGB', (3 * T, sum(hs) + 36), BG)
    ImageDraw.Draw(sheet).text((8, 6), f'{NAMES[cat]} {title}: реф | модель в приложении (?models=base) | наложение 50 %', fill=(20, 20, 30), font=FB)
    y = 36
    for r, h in zip(rows, hs):
        for k_, t in enumerate(r):
            sheet.paste(t, (k_ * T, y))
        y += h
    sheet.save(out, quality=88)
    print(out, sheet.size); print('\n'.join(stats))


if __name__ == '__main__':
    main()

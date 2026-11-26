"""Наложение Блёстки p4 на реф (разворот продакта): реф | p4 | 50 % — 4 ракурса и лицо крупно в одном масштабе.

    npx vite --port 4391 &
    D=/tmp/p4v3/shot; export PORT=4391
    Q="v=front,tq,sider,back,face&w=600&h=880&face=shader&models=p4&bg=ffffff&fz=9" node tools/persona-shot.mjs $D nv glitter
    python3 tools/glitter-p4-overlay.py $D/nv_glitter.png out.jpg [подпись]

Ракурсы рефа — design/refs/glitter_views/{front,threequarter,right,back}_white.png; лицо — крупно из front_white.
Совмещение: вид во весь рост — по силуэту (верх/низ и середина), лицо — по центрам радужек (зелёные пятна обоих
глаз: масштаб и сдвиг). Внизу каждого наложения — расхождение силуэтов (IoU) и глаз (доля межглазья).
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


def main():
    shot, out = sys.argv[1:3]
    title = sys.argv[3] if len(sys.argv) > 3 else 'p4'
    S = Image.open(shot).convert('RGB')
    n = 5; w = S.width // n
    shots = [S.crop((i * w, 0, (i + 1) * w, S.height)) for i in range(n)]
    rows = []
    stats = []
    for i, nm in enumerate(('front', 'threequarter', 'right', 'back')):
        ref = Image.open(os.path.join(ROOT, f'design/refs/glitter_views/{nm}_white.png')).convert('RGB').crop((112, 40, 912, 1000))
        s, tx, ty = fit_body(np.asarray(ref), np.asarray(shots[i]))
        mod = warp(shots[i], s, tx, ty, ref.size)
        mr, mm = mask(np.asarray(ref)), mask(np.asarray(mod))
        iou = (mr & mm).sum() / max((mr | mm).sum(), 1)
        ov = Image.blend(ref, mod, 0.5)
        # контур силуэта p4 поверх наложения (видно, где шире/уже)
        ed = mm ^ np.roll(mm, 1, 0) | mm ^ np.roll(mm, 1, 1)
        oa = np.asarray(ov).copy(); oa[ed] = (230, 40, 120); ov = Image.fromarray(oa)
        stats.append(f'{nm}: IoU {iou:.3f}')
        rows.append([lab(tile(ref), f'реф {nm}'), lab(tile(mod), title), lab(tile(ov), f'50 %  IoU {iou:.3f}')])
    # лицо: реф — front_white крупно, p4 — вид face; совмещение по радужкам
    ref = Image.open(os.path.join(ROOT, 'design/refs/glitter_views/front_white.png')).convert('RGB')
    er = eyes(np.asarray(ref.crop((330, 220, 700, 380))))
    er = [p + (330, 220) for p in er]
    io = er[1][0] - er[0][0]
    c = (er[0] + er[1]) / 2
    box = (int(c[0] - 1.9 * io), int(c[1] - 2.0 * io), int(c[0] + 1.9 * io), int(c[1] + 1.5 * io))
    refc = ref.crop(box)
    em = eyes(np.asarray(shots[4]))
    if em:
        s = (er[1][0] - er[0][0]) / (em[1][0] - em[0][0])
        cm = (em[0] + em[1]) / 2
        tx, ty = c[0] - cm[0] * s - box[0], c[1] - cm[1] * s - box[1]
        mod = warp(shots[4], s, tx, ty, refc.size)
        emw = eyes(np.asarray(mod))
        dy = ((emw[0][1] + emw[1][1]) / 2 - (c[1] - box[1])) / io if emw else 0
        stats.append(f'лицо: масштаб {s:.3f}')
        for who, img, pts in (('реф', refc, [p - box[:2] for p in er]), (title, mod, emw)):
            if pts:
                fm = face_marks(np.asarray(img), pts)
                stats.append(who + ': ' + ', '.join(f'{k} ш {v[0]:.2f} y {v[1]:.2f}..{v[2]:.2f} цвет {v[3]}' for k, v in fm.items()))
    else:
        mod = shots[4].resize(refc.size)
    ov = Image.blend(refc, mod, 0.5)
    rows.append([lab(tile(refc), 'реф лицо (front)'), lab(tile(mod), f'{title} лицо'), lab(tile(ov), '50 % (по радужкам)')])
    hs = [max(t.height for t in r) for r in rows]
    sheet = Image.new('RGB', (3 * T, sum(hs) + 36), BG)
    ImageDraw.Draw(sheet).text((8, 6), f'Блёстка {title}: реф | модель в приложении | наложение 50 %', fill=(20, 20, 30), font=FB)
    y = 36
    for r, h in zip(rows, hs):
        for k, t in enumerate(r):
            sheet.paste(t, (k * T, y))
        y += h
    sheet.save(out, quality=88)
    print(out, sheet.size); print('\n'.join(stats))


if __name__ == '__main__':
    main()

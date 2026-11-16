"""Поиск черт лица по фронтальному снимку (face_photo.py): нос (розовое пятно), глаза (зрачок → область глаза),
линия рта (гребень тёмного под носом, DP-трассировка). Всё — в мировых x/z (фронтальная проекция) + 3D-точки.
Usage: python3 face_detect.py photo.npz out.json [viz.png]"""
import json, sys
import numpy as np
from scipy import ndimage as nd

src, out = sys.argv[1], sys.argv[2]
viz = sys.argv[3] if len(sys.argv) > 3 else None
d = np.load(src)
C, L, xs, zs, step = d['C'], d['L'], d['xs'], d['zs'], float(d['step'])
H, W = C.shape[:2]
valid = ~np.isnan(L[..., 0])
r, g, b = C[..., 0], C[..., 1], C[..., 2]
lum = C.mean(-1)
mx, mn = C.max(-1), C.min(-1)
sat = (mx - mn) / (mx + 1e-6)
cx0 = W / 2


def to_world(i, j):
    """пиксель (строка i, столбец j, дробные) → мировые x, z"""
    return float(np.interp(j, np.arange(W), xs)), float(np.interp(i, np.arange(H), zs))


def surf(i, j):
    ii, jj = int(round(i)), int(round(j))
    return [float(v) for v in L[ii, jj]]


# --- нос: самое крупное розовое пятно у оси симметрии в средней части лица
pink = (r > b + 0.08) & (r > g + 0.12) & valid
lab, nl = nd.label(pink)
best, bs = None, 0
for k in range(1, nl + 1):
    ys, xs_ = np.where(lab == k)
    if len(ys) < 300 or abs(xs_.mean() - cx0) > W * 0.08 or not (H * 0.3 < ys.mean() < H * 0.85):
        continue
    # нос выше рта: из подходящих берём самое верхнее крупное
    score = len(ys) / (1 + ys.mean() / H)
    if best is None or ys.mean() < best[1]:
        best, bs = (k, ys.mean()), len(ys)
nose_m = lab == best[0]
ny, nx = np.where(nose_m)
nose = dict(c=to_world(ny.mean(), nx.mean()), top=to_world(ny.min(), nx.mean()), bottom=to_world(ny.max(), nx[ny == ny.max()].mean()),
            left=to_world(ny.mean(), nx.min()), right=to_world(ny.mean(), nx.max()))
nose_bottom_i = ny.max()
nose_w = nx.max() - nx.min()

# --- глаза: тёмные круглые пятна (зрачки) выше носа слева/справа
dark = (lum < 0.14) & valid
lab, nl = nd.label(nd.binary_opening(dark, iterations=2))
cands = []
for k in range(1, nl + 1):
    ys, xs_ = np.where(lab == k)
    if len(ys) < 150 or ys.mean() > ny.min() + nose_w * 0.3:
        continue
    hgt, wid = np.ptp(ys) + 1, np.ptp(xs_) + 1
    fill = len(ys) / (hgt * wid)
    if 0.5 < hgt / wid < 2 and fill > 0.55:
        cands.append((len(ys), ys.mean(), xs_.mean()))
eyes = {}
for side, sel in [('L', lambda x: x > cx0), ('R', lambda x: x < cx0)]:
    # L — левый глаз кота (на снимке справа: +x мира = левая сторона персонажа, смотрящего на −Y)
    cs = [c for c in cands if sel(c[2])]
    if not cs:
        continue
    _, py, px = max(cs)
    green = (g > r + 0.06) & (g > b - 0.02)
    white = (lum > 0.74) & (sat < 0.23)
    eyeish = ((lum < 0.32) | green | white) & valid
    lab2, _ = nd.label(eyeish)
    m = lab2 == lab2[int(py), int(px)]
    m = nd.binary_closing(m, iterations=4)
    m = nd.binary_fill_holes(m)
    m = nd.binary_opening(m, iterations=3)  # убрать ресницы/тонкие штрихи
    lab3, _ = nd.label(m)
    m = lab3 == lab3[int(py), int(px)]
    ys, xs_ = np.where(m)
    # контур: для каждого столбца — верх и низ
    cols = np.arange(xs_.min(), xs_.max() + 1)
    top = np.array([ys[xs_ == c].min() for c in cols]); bot = np.array([ys[xs_ == c].max() for c in cols])
    sm = lambda a: nd.uniform_filter1d(a.astype(float), 5, mode='nearest')
    top, bot = sm(top), sm(bot)
    k = max(1, len(cols) // 24)
    eyes[side] = dict(
        pupil=to_world(py, px), pupil_r=float(np.sqrt(_ / np.pi) * step),
        c=to_world(ys.mean(), xs_.mean()),
        top=[to_world(t, c) for t, c in zip(top[::k], cols[::k])] + [to_world(top[-1], cols[-1])],
        bottom=[to_world(t, c) for t, c in zip(bot[::k], cols[::k])] + [to_world(bot[-1], cols[-1])],
        area_px=int(m.sum()))
    eyes[side]['_mask'] = m

# --- линия рта: гребень «темнее окрестности» (DoG) под носом, DP по столбцам
dog = nd.gaussian_filter(lum, 6) - nd.gaussian_filter(lum, 1.5)
i0 = int(nose_bottom_i + nose_w * 0.12)
i1 = int(nose_bottom_i + nose_w * 1.6)
half = int(nose_w * 1.35)
j0, j1 = int(cx0 - half), int(cx0 + half)
R = dog[i0:i1, j0:j1].copy()
R[~valid[i0:i1, j0:j1]] = -1
nR, nC = R.shape
lam = 0.004
cost = np.full((nR, nC), np.inf); back = np.zeros((nR, nC), int)
cost[:, 0] = -R[:, 0]
dmax = 3
for c in range(1, nC):
    prev = cost[:, c - 1]
    best_v = np.full(nR, np.inf); best_k = np.zeros(nR, int)
    for dd in range(-dmax, dmax + 1):
        sh = np.full(nR, np.inf)
        if dd >= 0:
            sh[dd:] = prev[:nR - dd] if dd else prev
        else:
            sh[:dd] = prev[-dd:]
        v = sh + lam * abs(dd)
        upd = v < best_v
        best_v[upd] = v[upd]; best_k[upd] = np.arange(nR)[upd] - dd
    cost[:, c] = best_v - R[:, c]; back[:, c] = best_k
path = np.zeros(nC, int); path[-1] = int(np.argmin(cost[:, -1]))
for c in range(nC - 1, 0, -1):
    path[c - 1] = back[path[c], c]
strength = R[path, np.arange(nC)]
sm_s = nd.uniform_filter1d(strength, 9)
thr = max(0.004, 0.3 * np.percentile(sm_s, 90))
on = sm_s > thr
# самый длинный непрерывный кусок, содержащий центр
cc = nC // 2
lft = cc
while lft > 0 and on[lft - 1]:
    lft -= 1
rgt = cc
while rgt < nC - 1 and on[rgt + 1]:
    rgt += 1
rows = nd.uniform_filter1d(path.astype(float), 3, mode='nearest') + i0
mouth_pts = [to_world(rows[c], c + j0) for c in range(lft, rgt + 1, 2)]
cusp_c = lft + int(np.argmin(rows[lft:rgt + 1]))  # верхняя точка линии (под фильтрумом)
mouth = dict(line=mouth_pts, left=to_world(rows[rgt], rgt + j0), right=to_world(rows[lft], lft + j0),
             center=to_world(rows[cc], cc + j0), cusp=to_world(rows[cusp_c], cusp_c + j0),
             strength=float(np.median(strength[lft:rgt + 1])))

res = dict(nose=nose, eyes={k: {kk: vv for kk, vv in v.items() if kk != '_mask'} for k, v in eyes.items()},
           mouth=mouth, head=[float(v) for v in d['head']], step=step)
# 3D-точки ключевых мест
def p3(xz):
    j = np.interp(xz[0], xs, np.arange(W)); i = np.interp(xz[1], zs[::-1], np.arange(H)[::-1])
    return surf(i, j)
res['nose']['c3'] = p3(nose['c']); res['mouth']['center3'] = p3(mouth['center'])
for k in eyes:
    res['eyes'][k]['c3'] = p3(eyes[k]['c'])
json.dump(res, open(out, 'w'), indent=1)
print('nose', nose['c'], 'mouth corners', mouth['left'], mouth['right'], 'strength', mouth['strength'], 'eyes', list(eyes))

if viz:
    from PIL import Image, ImageDraw
    im = Image.fromarray((np.clip(C, 0, 1) * 255).astype(np.uint8)).convert('RGB')
    ov = np.array(im)
    for k, e in eyes.items():
        ov[e['_mask']] = (ov[e['_mask']] * 0.5 + np.array([255, 200, 0]) * 0.5).astype(np.uint8)
    ov[nose_m] = (ov[nose_m] * 0.5 + np.array([255, 0, 255]) * 0.5).astype(np.uint8)
    im = Image.fromarray(ov); dr = ImageDraw.Draw(im)
    pix = lambda xz: (float(np.interp(xz[0], xs, np.arange(W))), float(np.interp(xz[1], zs[::-1], np.arange(H)[::-1])))
    dr.line([pix(p) for p in mouth_pts], fill=(255, 0, 0), width=2)
    for p in [mouth['left'], mouth['right'], mouth['cusp']]:
        x, y = pix(p); dr.ellipse([x - 4, y - 4, x + 4, y + 4], outline=(0, 255, 0), width=2)
    for k, e in res['eyes'].items():
        dr.line([pix(p) for p in e['top']], fill=(0, 255, 255), width=2)
        dr.line([pix(p) for p in e['bottom']], fill=(0, 120, 255), width=2)
        x, y = pix(e['pupil']); dr.ellipse([x - 3, y - 3, x + 3, y + 3], fill=(255, 0, 0))
    dr.rectangle([j0, i0, j1, i1], outline=(255, 255, 255))
    im.save(viz)

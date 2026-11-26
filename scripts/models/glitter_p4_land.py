"""Блёстка p4: ориентиры лица для face_detail.py. Глаза и нос — face_detect.py (как у Хулигана/Добряка); рот —
по фронтальному снимку face_photo.py (у Tripo он открытый — розово-тёмная улыбка): линия рта = верхний край
открытого рта (губа) от уголка до уголка — по ней face_detail кладёт MouthD, face_rig.py режет губы.

    python3 scripts/models/glitter_p4_land.py /tmp/p4/photo.npz /tmp/p4/land.json scripts/models/face_landmarks/glitter_p4.json
"""
import sys, json
import numpy as np
from scipy import ndimage as nd

src, land, out = sys.argv[1:4]
d = np.load(src)
C, L, xs, zs, step = d['C'], d['L'], d['xs'], d['zs'], float(d['step'])
F = json.load(open(land))
H, W = C.shape[:2]
zr = zs  # строки снимка сверху вниз (zs в npz уже по убыванию)
r, g, b = C[..., 0], C[..., 1], C[..., 2]
lum = C.mean(-1)
X, Z = np.meshgrid(xs, zr)
# глаза: контур face_detect у Блёстки берёт и ресницы-лепестки (глаз шире и выше на 1–2 см) — разрез заново по белку
# и радужке (светлое или зелёное внутри рамки контура, дыры — зрачок/блик — заполнены)
for sd in ('L', 'R'):
    e = F['eyes'][sd]
    T, Bo = np.array(e['top']), np.array(e['bottom'])
    box = (X > T[:, 0].min() - 0.002) & (X < T[:, 0].max() + 0.002) & (Z > Bo[:, 1].min() - 0.002) & (Z < T[:, 1].max() + 0.002)
    lum_ = C.mean(-1)
    eye = box & ~np.isnan(L[..., 0]) & ((lum_ > 0.62) | ((C[..., 1] > C[..., 0] + 0.08) & (C[..., 1] > C[..., 2] - 0.02)))
    eye = nd.binary_opening(eye, iterations=2)
    lab_, k_ = nd.label(eye)
    eye = lab_ == (1 + int(np.argmax(nd.sum(eye, lab_, range(1, k_ + 1)))))
    eye = nd.binary_fill_holes(nd.binary_closing(eye, iterations=4))
    cs = np.where(eye.any(0))[0]
    cs = cs[2:-2]
    top = [[float(xs[c]), float(zr[np.where(eye[:, c])[0].min()])] for c in cs]
    bot = [[float(xs[c]), float(zr[np.where(eye[:, c])[0].max()])] for c in cs]
    sel = np.linspace(0, len(cs) - 1, 25).round().astype(int)
    e['top'] = [top[i] for i in sel]; e['bottom'] = [bot[i] for i in sel]
    ii_, jj_ = np.where(eye)
    e['c'] = [float(xs[jj_].mean()), float(zr[ii_].mean())]
    ci_, cj_ = int(round(ii_.mean())), int(round(jj_.mean()))
    e['c3'] = [float(x) for x in L[ci_, cj_]]
    e['area_px'] = int(eye.sum())
    print('глаз', sd, 'ширина %.4f высота %.4f (контур face_detect %.4f × %.4f)' % (np.ptp(xs[cs]), np.ptp(zr[ii_]), np.ptp(T[:, 0]), T[:, 1].max() - Bo[:, 1].min()))
valid = ~np.isnan(L[..., 0])
# розовые пятна по оси лица ниже глаз: верхнее — нос, нижнее — открытый рот (face_detect у Блёстки p4 принимает рот за нос)
eyez = min(F['eyes']['L']['c'][1], F['eyes']['R']['c'][1])
pink = valid & (r > g + 0.08) & (np.abs(X - xs.mean() * 0 - (F['eyes']['L']['c'][0] + F['eyes']['R']['c'][0]) / 2) < 0.05) & (Z < eyez - 0.02) & (Z > eyez - 0.16)
lab, k = nd.label(pink)
sz = nd.sum(pink, lab, range(1, k + 1))
blobs = [i + 1 for i in np.argsort(-sz)[:2]]
blobs.sort(key=lambda i: -Z[lab == i].mean())
nb = lab == blobs[0]
ii, jj = np.where(nb)
def P3(i, j):
    v = L[i, j]
    return [float(x) for x in v]
ci, cj = int(np.round(ii.mean())), int(np.round(jj.mean()))
nose = {'c': [float(xs[cj]), float(zr[ci])], 'top': [float(xs[cj]), float(zr[ii.min()])], 'bottom': [float(xs[jj[ii == ii.max()]].mean()), float(zr[ii.max()])],
        'left': [float(xs[jj.min()]), float(zr[ci])], 'right': [float(xs[jj.max()]), float(zr[ci])], 'c3': P3(ci, cj)}
F['nose'] = nose
print('нос: центр', np.round(nose['c'], 4), 'ширина %.4f' % (xs[jj.max()] - xs[jj.min()]))
nz = nose['bottom'][1]
cand = valid & (r > g + 0.12) & (lum < 0.55) & (Z < nz - 0.004) & (Z > nz - 0.07) & (np.abs(X - nose['c'][0]) < 0.06)
lab, k = nd.label(cand)
sizes = nd.sum(cand, lab, range(1, k + 1))
m = lab == (1 + int(np.argmax(sizes)))
cols = np.where(m.any(0))[0]
line = []
for c in cols:
    rows = np.where(m[:, c])[0]
    line.append([float(xs[c]), float(zr[rows.min()])])
line = np.array(line)
# сгладить и проредить до ~80 точек
from scipy.ndimage import gaussian_filter1d
line[:, 1] = gaussian_filter1d(line[:, 1], 2)
idx = np.linspace(0, len(line) - 1, min(82, len(line))).round().astype(int)
line = line[idx]
left = line[np.argmax(line[:, 0])].copy(); right = line[np.argmin(line[:, 0])].copy()
mid = len(line) // 2
c_ = np.abs(line[:, 0] - nose['c'][0]) < 0.006
cusp = line[c_][np.argmax(line[c_][:, 1])] if c_.any() else line[mid]
center = [float((left[0] + right[0]) / 2), float(line[:, 1].mean())]
ci = int(np.argmin(np.abs(xs - center[0]))); ri = int(np.argmin(np.abs(zr - center[1])))
c3 = L[ri, ci]
if np.isnan(c3[0]):
    vv = np.argwhere(valid); q = vv[np.argmin(np.hypot(vv[:, 0] - ri, vv[:, 1] - ci))]; c3 = L[q[0], q[1]]
low = np.array([zr[np.where(m[:, c])[0].max()] for c in cols])
# линия рта — посередине бывшего открытого рта (по заплатке glitter_p4.py): верхний край — шов заплатки с головой,
# разрез губ face_rig.py по шву протекал (вершины края и полосы вшивки)
drop = 0.45 * float(line[:, 1].mean() - low.mean())
# ширина — как у части-рта Tripo с губами (верхний край открытого рта уже: уголки губ дальше), ×1.35 от центра
cx_ = float(line[:, 0].mean()); line[:, 0] = cx_ + (line[:, 0] - cx_) * 1.35
left = line[np.argmax(line[:, 0])].copy(); right = line[np.argmin(line[:, 0])].copy()
line[:, 1] -= drop; left = left - [0, drop]; right = right - [0, drop]; cusp = cusp - [0, drop]; center[1] -= drop
F['mouth'] = {'line': line.round(6).tolist(), 'left': left.round(6).tolist(), 'right': right.round(6).tolist(),
              'center': center, 'cusp': cusp.round(6).tolist(), 'strength': float(m.sum() * step * step * 1e4),
              'center3': [float(x) for x in c3], 'open': float(line[:, 1].mean() - low.mean())}
json.dump(F, open(out, 'w'), indent=1)
print('рот: ширина %.4f, уголки %s %s, центр %s, раскрытие %.4f' % (left[0] - right[0], left.round(4), right.round(4), np.round(center, 4), F['mouth']['open']))

"""Блёстка v5: уши и хвост на сплошной сетке Tripo (одна цельная сетка — find_parts.py находит уши, а хвост-«булаву»
под пачкой берёт кусками) → /tmp/<n>_parts.npz для blender/rig_cat.py.

    python3 scripts/models/blender/find_parts.py glitter5      # уши (кончики над бантом)
    python3 scripts/models/v5/v5_parts.py glitter5 [viz.png]

Хвост — вершины у ломаной оси (стебель под пачкой → загиб вверх → «булава»), без цвета пачки; параметр t — проекция
на ось (веса Tail1..4 — rig_cat.py). Уши — find_parts.py без золота банта.
Вход — /tmp/<n>.npz от dump.py (координаты Blender: x, y — назад, z — вверх).
"""
import sys
import numpy as np

n = sys.argv[1]
d = np.load(f'/tmp/{n}.npz'); q = dict(np.load(f'/tmp/{n}_parts.npz'))
P, C = d['P'], d['C']
bn = list(d['bn']); bp = d['bp']
hips = bp[bn.index('mixamorig:Hips')]
x0 = hips[0]
# ось хвоста (по сетке v5, вид сбоку): корень у спины под пачкой, стебель назад, загиб вверх, кончик «булавы» сверху
J = np.array([[x0, 0.072, 0.292], [x0, 0.118, 0.292], [x0, 0.160, 0.300], [x0, 0.186, 0.335], [x0, 0.183, 0.400]])
R = np.array([0.026, 0.03, 0.06, 0.065, 0.03])  # допуск по расстоянию до оси (стебель тонкий, булава толстая)


def proj(p):
    best = (1e9, 0, 0.0)
    L = np.r_[0, np.cumsum(np.linalg.norm(np.diff(J, axis=0), axis=1))]
    for i in range(len(J) - 1):
        a, b = J[i], J[i + 1]; ab = b - a
        t = np.clip(np.dot(p - a, ab) / np.dot(ab, ab), 0, 1)
        dd = np.linalg.norm(p - (a + t * ab))
        if dd < best[0]:
            best = (dd, i, t, L[i] + t * (L[i + 1] - L[i]), R[i] + t * (R[i + 1] - R[i]))
    return best[0], best[3] / L[-1], best[4]


cand = np.where((P[:, 1] > 0.068) & (np.abs(P[:, 0] - x0) < 0.07) & (P[:, 2] > 0.2) & (P[:, 2] < 0.43))[0]
# цвет: хвост — сине-лиловый/бежевый кончик, пачка — мятно-серая
tail_ref = np.median(C[cand[(P[cand, 1] > 0.17) & (P[cand, 2] > 0.29)]], axis=0)
skirt = np.where((P[:, 1] < 0.05) & (P[:, 1] > -0.05) & (P[:, 2] > 0.22) & (P[:, 2] < 0.3) & (np.abs(P[:, 0]) > 0.15))[0]
skirt_ref = np.median(C[skirt], axis=0)
tail, tt = [], []
for i in cand:
    dd, t, r = proj(P[i])
    if dd > r:
        continue
    ds, dt = np.linalg.norm(C[i] - skirt_ref), np.linalg.norm(C[i] - tail_ref)
    if P[i, 1] < 0.13 and ds < dt:  # у стебля — край пачки
        continue
    tail.append(i); tt.append(t)
tail = np.array(tail); tt = np.array(tt)
print('tail', len(tail), 'ref', tail_ref.round(2), 'skirt', skirt_ref.round(2))
gold = (C[:, 0] > 0.6) & (C[:, 1] > 0.5) & (C[:, 2] < 0.55) & (C[:, 0] - C[:, 2] > 0.15)
for s in ('earL', 'earR'):
    e = q[s]; k = e[~gold[e]]
    # основание ниже: ухо гнётся от середины, а не только кончиком
    tip = q[s + 'j'][1]; base = q[s + 'j'][0].copy(); base[2] = tip[2] - 0.065
    q[s] = k; q[s + 'j'] = np.array([base, tip])
    print(s, len(e), '→', len(k), 'base', base.round(3), 'tip', tip.round(3))
q.update(tail=tail, tailg=tt, tailj=J)
np.savez(f'/tmp/{n}_parts.npz', **q)
if len(sys.argv) > 2:
    from PIL import Image, ImageDraw
    col = (np.clip(C, 0, 1) * 255).astype(int); col[tail] = [230, 30, 30]; col[q['earL']] = [30, 30, 230]; col[q['earR']] = [30, 160, 230]
    S = 600; ims = []
    for view in ('side', 'back'):
        im = Image.new('RGB', (S, S), 'white'); dr = ImageDraw.Draw(im)
        z0, z1 = P[:, 2].min(), P[:, 2].max(); sc = S / (z1 - z0) * 0.95
        h = P[:, 1] if view == 'side' else P[:, 0]; dep = -P[:, 0] if view == 'side' else -P[:, 1]
        for i in np.argsort(dep):
            x, y = S / 2 + h[i] * sc, S - 10 - (P[i, 2] - z0) * sc
            dr.ellipse((x - 1, y - 1, x + 1, y + 1), fill=tuple(col[i]))
        ims.append(im)
    c = Image.new('RGB', (2 * S, S)); [c.paste(r, (S * i, 0)) for i, r in enumerate(ims)]; c.save(sys.argv[2])

"""Блёстка v5: сетка гуще у уголков рта (до ключей мимики) — на «грусти» уголки вниз давали грани: у Tripo там
крупные треугольники, ключ сгибал их по одному ребру. Делим треугольники вокруг каждого уголка (красно-зелёное
деление: 3 ребра — на 4, 1 ребро — пополам, без Т-стыков; швы UV — по сваренным рёбрам, обе стороны шва делятся
вместе). Новые вершины — середины рёбер (позиция, нормаль, UV, веса), форма и вид в покое не меняются.

    python3 scripts/models/v5/v5_dense.py rigged.glb dense.glb
"""
import sys, os
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from v5_common import Glb, body, sample  # noqa: E402

LEVELS = [(0.022, 'уголки рта ±22 мм'), (0.012, 'уголки рта ±12 мм')]

src, dst = sys.argv[1:3]
g = Glb(src); j = g.j
B = body(g)
pr = B['pr']
P, N, UV, I = B['P'], B['N'], B['UV'], B['I']
J = B['J'].astype(np.int64); W = B['W'].astype(np.float64)
W /= 255 if W.max() > 1.5 else 1
mat0 = j['materials'][pr['material']]
tex = np.array(g.image(j['textures'][mat0['pbrMetallicRoughness']['baseColorTexture']['index']]['source']).convert('RGB')).astype(float)

# уголки рта: крайние по X вершины тёмно-красного (рот Tripo) спереди лица
C = sample(tex, UV)
lum = C.mean(1)
red = (C[:, 0] > C[:, 1] + 35) & (lum < 175) & (P[:, 2] > 0.1) & (P[:, 1] > 0.55) & (P[:, 1] < 0.72) & (np.abs(P[:, 0]) < 0.08)
R = P[red]
corners = [R[np.argmax(R[:, 0])], R[np.argmin(R[:, 0])]]
print('уголки рта:', np.round(corners, 4).tolist())


def merge_w(ja, wa, jb, wb):
    """веса середины ребра: среднее по объединению костей, 4 старших, нормировка"""
    out_j = np.zeros((len(ja), 4), np.int64); out_w = np.zeros((len(ja), 4))
    for r in range(len(ja)):
        d = {}
        for jj, ww in zip(ja[r], wa[r]):
            d[jj] = d.get(jj, 0) + 0.5 * ww
        for jj, ww in zip(jb[r], wb[r]):
            d[jj] = d.get(jj, 0) + 0.5 * ww
        top = sorted(d.items(), key=lambda kv: -kv[1])[:4]
        s = sum(w for _, w in top) or 1
        for c, (jj, ww) in enumerate(top):
            out_j[r, c] = jj; out_w[r, c] = ww / s
    return out_j, out_w


for rad, what in LEVELS:
    key = np.round(P * 1e5).astype(np.int64)
    _, wl = np.unique(key, axis=0, return_inverse=True); wl = wl.ravel()
    cen = P[I].mean(1)
    sel = np.zeros(len(I), bool)
    for c in corners:
        sel |= np.linalg.norm(cen - c, axis=1) < rad
    # рёбра по сваренным вершинам
    def ekey(a, b):
        a, b = wl[a], wl[b]
        return np.minimum(a, b) * (wl.max() + 1) + np.maximum(a, b)
    E3 = np.stack([ekey(I[:, 0], I[:, 1]), ekey(I[:, 1], I[:, 2]), ekey(I[:, 2], I[:, 0])], 1)
    split = set(E3[sel].ravel().tolist())
    # замыкание: треугольник с двумя делимыми рёбрами делится целиком (только 1 или 3)
    while True:
        cnt = np.isin(E3, list(split)).sum(1)
        two = cnt == 2
        if not two.any():
            break
        split |= set(E3[two].ravel().tolist())
    S = np.isin(E3, list(split))
    cnt = S.sum(1)
    # новые вершины: одна на (ребро, сторона шва) — ключ по несваренным индексам
    mid = {}
    newP, newN, newUV, newJa, newWa, newJb, newWb = [], [], [], [], [], [], []
    nV = len(P)

    def m(a, b):
        k_ = (min(a, b), max(a, b))
        if k_ not in mid:
            mid[k_] = nV + len(newP)
            newP.append((P[a] + P[b]) / 2); nn = N[a] + N[b]; newN.append(nn / max(np.linalg.norm(nn), 1e-9))
            newUV.append((UV[a] + UV[b]) / 2)
            newJa.append(J[a]); newWa.append(W[a]); newJb.append(J[b]); newWb.append(W[b])
        return mid[k_]
    out = []
    for t, (a, b, c) in enumerate(I):
        if cnt[t] == 0:
            out.append((a, b, c))
        elif cnt[t] == 3:
            ab, bc, ca = m(a, b), m(b, c), m(c, a)
            out += [(a, ab, ca), (ab, b, bc), (ca, bc, c), (ab, bc, ca)]
        else:
            e = int(np.argmax(S[t]))
            v = (a, b, c)
            p, q, r_ = v[e], v[(e + 1) % 3], v[(e + 2) % 3]
            x = m(p, q)
            out += [(p, x, r_), (x, q, r_)]
    jj_, ww_ = merge_w(np.array(newJa), np.array(newWa), np.array(newJb), np.array(newWb))
    P = np.vstack([P, newP]); N = np.vstack([N, newN]); UV = np.vstack([UV, newUV])
    J = np.vstack([J, jj_]); W = np.vstack([W, ww_]); I = np.array(out, np.int64)
    print(f'{what}: +{len(newP)} вершин, треугольников {len(I)}')

A = pr['attributes']
A['POSITION'] = g.add_acc(P.astype(np.float32), 5126, 'VEC3', 34962)
A['NORMAL'] = g.add_acc(N.astype(np.float32), 5126, 'VEC3', 34962)
A['TEXCOORD_0'] = g.add_acc(UV.astype(np.float32), 5126, 'VEC2', 34962)
A['JOINTS_0'] = g.add_acc(J.astype(np.uint8 if J.max() < 256 else np.uint16), 5121 if J.max() < 256 else 5123, 'VEC4', 34962)
A['WEIGHTS_0'] = g.add_acc(W.astype(np.float32), 5126, 'VEC4', 34962)
pr['indices'] = g.add_acc(I.ravel().astype(np.uint16 if len(P) < 65535 else np.uint32), 5123 if len(P) < 65535 else 5125, 'SCALAR', 34963)
size = g.save(dst)
print(f'→ {dst} ({size / 1e6:.2f} МБ), вершин {len(P)}')

"""Части сетки Tripo (тело, кепка, худи, наушники, шарф, бант, юбка…): связные компоненты сшитой сетки +
средний цвет альбедо. Общий модуль для penetration.py / colliders.py / fur_volume.py."""
import numpy as np


def weld(P, eps=1e5):
    key = np.round(P * eps).astype(np.int64)
    _, w = np.unique(key, axis=0, return_inverse=True)
    return w.ravel()


def components(nV, I):
    """связные компоненты по треугольникам (union-find) → метка на вершину"""
    par = np.arange(nV)

    def find(a):
        while par[a] != a:
            par[a] = par[par[a]]
            a = par[a]
        return a
    E = np.r_[I[:, [0, 1]], I[:, [1, 2]]]
    for a, b in E:
        ra, rb = find(a), find(b)
        if ra != rb:
            par[ra] = rb
    return np.array([find(i) for i in range(nV)])


PART_NAMES = ['тело', 'кепка', 'худи', 'наушники', 'шарф', 'бант/заколки', 'юбка', 'обувь']
BODY, CAP, HOODIE, PHONES, SCARF, BOW, SKIRT, SHOES = range(8)


def tri_colors(g, prim, I):
    """цвет альбедо в центре каждого треугольника (sRGB 0..255)"""
    j = g.j
    UV = g.acc(prim['attributes']['TEXCOORD_0']).astype(np.float64)
    mat = j['materials'][prim['material']]
    img = np.asarray(g.image(j['textures'][mat['pbrMetallicRoughness']['baseColorTexture']['index']]['source']).convert('RGB')).astype(np.float64)
    H, W = img.shape[:2]
    out = 0
    for wts in ((1 / 3, 1 / 3, 1 / 3), (0.6, 0.2, 0.2), (0.2, 0.6, 0.2), (0.2, 0.2, 0.6)):
        uv = (UV[I] * np.array(wts)[None, :, None]).sum(1)
        out = out + img[np.clip((uv[:, 1] % 1) * H, 0, H - 1).astype(int), np.clip((uv[:, 0] % 1) * W, 0, W - 1).astype(int)]
    return out / 4


def hsv(c):
    c = c / 255.0
    mx = c.max(1); mn = c.min(1); d = mx - mn
    h = np.zeros(len(c))
    r, g, b = c[:, 0], c[:, 1], c[:, 2]
    m = d > 1e-6
    hr = m & (mx == r); hg = m & (mx == g) & ~hr; hb = m & ~hr & ~hg
    h[hr] = (60 * ((g - b)[hr] / d[hr]) + 360) % 360
    h[hg] = 60 * ((b - r)[hg] / d[hg]) + 120
    h[hb] = 60 * ((r - g)[hb] / d[hb]) + 240
    s = np.where(mx > 0, d / np.maximum(mx, 1e-6), 0)
    return h, s, mx


def label_parts(cat, g, prim, P, I):
    """метка части на вершину (по треугольникам вокруг, большинство): 0 — тело (мех, нос, уши, подушечки)"""
    j = g.j
    marks = next(n for n in j['nodes'] if n.get('name') == 'Brows')['extras']['marks']
    eyeY = marks['eyeOuterL'][1]
    chinY = (marks['mouthL'][1] + marks['mouthR'][1]) / 2 - 0.5 * np.linalg.norm(np.array(marks['eyeOuterL']) - marks['eyeOuterR'])
    col = tri_colors(g, prim, I)
    h, s, v = hsv(col)
    C = P[I].mean(1)
    y = C[:, 1]
    fur = ((h > 198) & (h < 250) & (s < 0.5) & (v > 0.3)) | ((s < 0.09) & (v > 0.72) & ~((cat == 'kind') & (h > 15) & (h < 70) & (y < chinY))) \
        | (((h > 318) | (h < 2)) & (s > 0.15) & (s < 0.55) & (v > 0.5))  # розовое: уши, нос, подушечки
    lab = np.full(len(I), HOODIE)
    if cat == 'hooligan':
        lab[(y > eyeY - 0.02)] = CAP
        lab[(h > 160) & (h < 190) & (s > 0.4) & (y > chinY - 0.12) & (y < chinY + 0.06)] = PHONES
        lab[(y > chinY - 0.1) & (y < chinY + 0.06) & (s < 0.12) & (v < 0.75) & (v > 0.35)] = PHONES  # серые амбушюры
    elif cat == 'kind':
        coral = ((h < 25) | (h > 350)) & (s > 0.3)
        lab[coral & (y > 0.3)] = SCARF
    elif cat == 'glitter':
        lab[(y > eyeY - 0.02)] = BOW
        lab[(y > 0.16) & (y < 0.335)] = SKIRT
    lab[(y < 0.13) & ~fur] = SHOES
    lab[fur & ~((cat == 'hooligan') & (y > eyeY + 0.06) & (h > 60) & (h < 140))] = BODY
    # хвост (у Блёстки — с блёстками, не «меховой» цвет) — всегда тело
    sk = j['skins'][0]
    names = [j['nodes'][k]['name'] for k in sk['joints']]
    Jv = g.acc(prim['attributes']['JOINTS_0']).astype(np.int64); Wv = g.acc(prim['attributes']['WEIGHTS_0']).astype(np.float64)
    Wv /= 255 if Wv.max() > 1.5 else 1
    tail = (Wv * np.array([n.startswith('Tail') for n in names])[Jv]).sum(1)
    lab[(tail[I] > 0.5).all(1)] = BODY
    # сглаживание: метка вершины — большинство по треугольникам
    nV = len(P)
    votes = np.zeros((nV, len(PART_NAMES)))
    for k in range(3):
        np.add.at(votes, (I[:, k], lab), 1)
    wl = weld(P)
    vw = np.zeros((wl.max() + 1, len(PART_NAMES)))
    np.add.at(vw, wl, votes)
    return vw.argmax(1)[wl]


def tri_label(lab_v, T):
    """метка треугольника — большинство по вершинам (стык частей: 2 из 3)"""
    L = lab_v[T]
    m = np.where(L[:, 1] == L[:, 2], L[:, 1], L[:, 0])
    return np.where(L[:, 0] == L[:, 1], L[:, 0], m)

#!/usr/bin/env python3
"""Наушники Хулигана — настоящая отдельная деталь вместо спаянной с телом поверхности Tripo.

  python3 scripts/models/headphones.py hooligan in.glb out.glb

1. Старая поверхность наушников (метка «наушники», mesh_parts.label_parts) убирается без дыр: её вершины
   натягиваются гармонической мембраной между соседями (шея/мех сверху, капюшон снизу) — сетка тела замкнута,
   как была; тексели этих треугольников перекрашиваются цветом ближайшей не-наушниковой поверхности (мех/худи).
2. Новые наушники — процедурно, low-poly (~1.6k треугольников), меш Headphones_Hooligan из двух примитивов:
   корпус (глянцевый бирюзовый) и амбушюры (мягкий тёмный). Чашка — тело вращения (скруглённый цилиндр + подушка-тор),
   ось — нормаль диска старой чашки; дуга — трубка по эллипсу вокруг шеи сзади, концы упираются в верх чашек.
   Размер и место — по старой поверхности (центр и радиус чашек — окружность по точкам, дуга — эллипс).
3. Без проникновения: чашки отодвигаются по своей оси, дуга — наружу, пока ни один треугольник не режет тело/худи
   (penetration.tri_pairs_intersect), плюс зазор.
4. Скин: чашка — жёстко (веса ближайшей к центру вершины тела), дуга — веса ближайших вершин шеи вдоль пути
   (сглажены), кольцо трубки — одни веса на сечение.
"""
import sys
import numpy as np
from scipy.spatial import cKDTree
from glb_io import Glb, raster_uv
from mesh_parts import weld, label_parts, PHONES
from penetration import tri_pairs_intersect

SEG = 28          # сегментов по окружности чашки
BAND_N, BAND_S = 34, 10  # дуга: сечений, сторон трубки
# v2b (19.11): «детские» накладные наушники, лежащие на капюшоне (рефы design/refs, design/sheets): чашки крупнее и
# толще, смотрят вперёд-наружу (не вбок), дуга — толстая мягкая лента. v2 — чашки R 0.041, дуга 0.013: в приложении
# читались тонким кольцом.
CUP_R = (1.22, 0.05)      # множитель радиуса старой чашки, предел
CUP_D = (1.35, 0.03, 0.042)  # множитель толщины, пределы
CUP_FWD = 0.55            # наклон оси чашки вперёд (0 — по нормали старой поверхности, 1 — прямо вперёд)
BAND_R, BAND_FLAT = 0.019, 0.62  # полуширина ленты дуги и её сплющенность (толщина = R·flat)
SHELL = [0.2, 0.74, 0.68, 1.0]   # sRGB → в glTF линейный множитель ниже
PAD = [0.13, 0.14, 0.16, 1.0]


def srgb2lin(c):
    c = np.asarray(c[:3]); return list(np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)) + [1.0]


def frame(ax):
    ax = ax / np.linalg.norm(ax)
    t = np.array([0, 1.0, 0]) if abs(ax[1]) < 0.9 else np.array([1.0, 0, 0])
    u = np.cross(ax, t); u /= np.linalg.norm(u)
    v = np.cross(ax, u)
    return ax, u, v


def revolve(prof, c, ax, seg=SEG):
    """профиль [(r, h)] вокруг оси ax из точки c → вершины, нормали (по сетке), треугольники"""
    ax, u, v = frame(ax)
    V = []
    for (r, h) in prof:
        for k in range(seg):
            a = 2 * np.pi * k / seg
            V.append(c + ax * h + (u * np.cos(a) + v * np.sin(a)) * r)
    V = np.array(V)
    F = []
    for i in range(len(prof) - 1):
        for k in range(seg):
            a0 = i * seg + k; a1 = i * seg + (k + 1) % seg
            F += [[a0, a1 + seg, a1], [a0, a0 + seg, a1 + seg]]
    return V, np.array(F)


def vnormals(V, F):
    n = np.zeros_like(V)
    fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    for k in range(3):
        np.add.at(n, F[:, k], fn)
    return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)


def cup(c, ax, R, D):
    """корпус и амбушюра одной чашки; h = 0 — сторона шеи (амбушюра), h = D — наружная крышка"""
    b = 0.32 * D
    sh = [(0.0, D), (0.55 * R, D), (R - b * 0.6, D - b * 0.08)]
    for t in np.linspace(0.25, 1, 3) * np.pi / 2:
        sh.append((R - b + b * np.sin(t), D - b + b * np.cos(t)))
    sh += [(R, 0.3 * D), (R * 0.97, 0.22 * D)]
    pr = 0.24 * R
    pc = (R - pr * 1.05, 0.2 * D)
    pad = []
    for t in np.linspace(-0.15, 1.15, 7) * np.pi:
        pad.append((pc[0] + pr * np.cos(t), pc[1] - pr * np.sin(t) * 0.9))
    pad += [(0.0, pc[1] - 0.15 * pr)]
    Vs, Fs = revolve(sh, c, ax)
    Vp, Fp = revolve(pad, c, ax)
    return (Vs, Fs), (Vp, Fp)


def tube(path, r, sides=BAND_S):
    T = np.gradient(path, axis=0); T /= np.linalg.norm(T, axis=1, keepdims=True)
    V = []
    up = np.array([0, 1.0, 0])
    for p, t in zip(path, T):
        u = np.cross(t, up); u /= max(np.linalg.norm(u), 1e-9); v = np.cross(u, t)
        for k in range(sides):
            a = 2 * np.pi * k / sides
            # лента: широкая по высоте (прилегает к шее/капюшону), тонкая наружу — как дуга настоящих наушников на шее
            V.append(p + (u * np.cos(a) * BAND_FLAT + v * np.sin(a) * 1.0) * r)
    V = np.array(V); F = []
    for i in range(len(path) - 1):
        for k in range(sides):
            a0 = i * sides + k; a1 = i * sides + (k + 1) % sides
            F += [[a0, a1, a1 + sides], [a0, a1 + sides, a0 + sides]]
    # торцы — веером (концы спрятаны у верха чашки)
    for end, s0 in ((0, 0), (len(path) - 1, (len(path) - 1) * sides)):
        ci = len(V); V = np.vstack([V, path[end]])
        for k in range(sides):
            a, b_ = s0 + k, s0 + (k + 1) % sides
            F.append([ci, b_, a] if end == 0 else [ci, a, b_])
    return V, np.array(F)


def circle3(X, nrm):
    """окружность в плоскости с нормалью nrm по точкам X → центр, радиус"""
    _, u, v = frame(nrm)
    c0 = X.mean(0)
    L = np.c_[(X - c0) @ u, (X - c0) @ v]
    A = np.c_[L, np.ones(len(L))]
    s = np.linalg.lstsq(A, -(L ** 2).sum(1), rcond=None)[0]
    cx, cy = -s[0] / 2, -s[1] / 2
    return c0 + cx * u + cy * v, np.sqrt(max(cx * cx + cy * cy - s[2], 1e-8))


def main():
    cat, src, dst = sys.argv[1:4]
    g = Glb(src); j = g.j
    bi, b = g.main_mesh()
    A = lambda k: g.acc(b['attributes'][k])
    P = A('POSITION').astype(np.float64); N = A('NORMAL').astype(np.float64); UV = A('TEXCOORD_0').astype(np.float64)
    J = A('JOINTS_0').astype(np.int64); Wt = A('WEIGHTS_0').astype(np.float64)
    Wt /= 255 if Wt.max() > 1.5 else 1
    I = g.acc(b['indices']).reshape(-1, 3).astype(np.int64)
    lab = label_parts(cat, g, b, P, I)
    ph = lab == PHONES
    X0 = P[ph].copy(); NX = N[ph].copy()
    # --- 1. новая геометрия по старой поверхности
    side = []
    for s in (1, -1):
        m = (X0[:, 0] * s > 0.055) & (X0[:, 2] > 0.09)
        Xc = X0[m]
        _, _, vt = np.linalg.svd(Xc - Xc.mean(0), full_matrices=False)
        ax = vt[2] * np.sign(vt[2][0] * s)  # наружу (от шеи)
        c, R = circle3(Xc, ax)
        # центр по оси — середина толщины чашки
        hh = (Xc - c) @ ax
        c = c + ax * np.percentile(hh, 10)
        D = np.percentile(hh, 95) - np.percentile(hh, 10)
        # ось — вперёд-наружу: чашка лежит на капюшоне «лицом» к зрителю, как у настоящих наушников на шее
        ax2 = ax * (1 - CUP_FWD) + np.array([0.35 * s, 0.12, 1.0]) / np.linalg.norm([0.35, 0.12, 1.0]) * CUP_FWD
        ax2 /= np.linalg.norm(ax2)
        side.append(dict(s=s, c=c, ax=ax2, ax0=ax, R=min(R * CUP_R[0], CUP_R[1]), D=float(np.clip(D * CUP_D[0], CUP_D[1], CUP_D[2]))))
    band = X0[(X0[:, 2] < 0.08) & (X0[:, 1] > np.percentile(X0[:, 1], 40))]
    yb = np.median(band[:, 1])
    bc = np.array([0.0, yb, (band[:, 2].max() + band[:, 2].min()) / 2 - 0.01])
    bx = np.percentile(np.abs(band[:, 0]), 97); bz = bc[2] - band[:, 2].min()
    print(f'{cat}: старые наушники — {ph.sum()} вершин; чашки R={side[0]["R"]:.3f}/{side[1]["R"]:.3f}, D={side[0]["D"]:.3f}, '
          f'центры {np.round(side[0]["c"], 3)} {np.round(side[1]["c"], 3)}; дуга y={yb:.3f}, полуоси {bx:.3f}×{bz:.3f}')

    # старая деталь целиком: всё, что внутри объёма старых чашек и дуги (серые амбушюры, бирюзовые остатки), кроме
    # тёмного худи и меха головы выше дуги
    from mesh_parts import tri_colors, hsv
    vol = np.zeros(len(P), bool)
    for sd in side:
        q = P - sd['c']; h_ = q @ sd['ax0']; r_ = np.linalg.norm(q - h_[:, None] * sd['ax0'], axis=1)
        vol |= (r_ < sd['R'] / CUP_R[0] + 0.014) & (h_ > -0.045) & (h_ < sd['D'] / CUP_D[0] + 0.012)
    tb = cKDTree(band)
    db, _ = tb.query(P)
    vol |= db < 0.011
    # цвет вершины
    UVv = UV
    imgc = np.asarray(g.image(j['textures'][j['materials'][b['material']]['pbrMetallicRoughness']['baseColorTexture']['index']]['source']).convert('RGB')).astype(np.float64)
    Sz = imgc.shape[0]
    cv = imgc[np.clip((UVv[:, 1] % 1) * Sz, 0, Sz - 1).astype(int), np.clip((UVv[:, 0] % 1) * Sz, 0, Sz - 1).astype(int)]
    hh_, ss_, vv_ = hsv(cv)
    dark = vv_ < 0.22
    names_ = [j['nodes'][k]['name'].replace('mixamorig:', '') for k in j['skins'][0]['joints']]
    headw = (Wt * np.array([n.startswith('Head') for n in names_])[J]).sum(1)
    teal = (hh_ > 150) & (hh_ < 200) & (ss_ > 0.25)
    grayc = (ss_ < 0.16) & (vv_ > 0.4)
    # амбушюры у Tripo окрашены почти как мех (голубовато-белые) — внутри объёма чашки берём и их (кроме белой груди у центра)
    cupv = np.zeros(len(P), bool)
    for sd in side:
        q = P - sd['c']; h_ = q @ sd['ax0']; r_ = np.linalg.norm(q - h_[:, None] * sd['ax0'], axis=1)
        cupv |= (r_ < sd['R'] / CUP_R[0] + 0.01) & (h_ > -0.045) & (h_ < sd['D'] / CUP_D[0] + 0.008)
    ph = ph | (vol & ~dark & ~((headw > 0.7) & (P[:, 1] > yb + 0.012)) & (teal | grayc | ph | (cupv & (np.abs(P[:, 0]) > 0.05))))
    # подрастить на 1 кольцо (края старых чашек)
    for _ in range(1):
        tri_any = ph[I].any(1)
        grow = np.zeros(len(P), bool); grow[I[tri_any].ravel()] = True
        ph = ph | (grow & vol & ~dark)
    print(f'  старая деталь по объёму: {ph.sum()} вершин')
    # --- 2. старая поверхность → гармоническая мембрана (без дыр), тексели — цвет соседей
    wl = weld(P); nW = wl.max() + 1
    rep = np.zeros(nW, np.int64); rep[wl] = np.arange(len(wl))
    Q = P[rep].copy()
    phw = np.zeros(nW, bool); phw[wl[ph]] = True
    TW = wl[I]
    nb = [[] for _ in range(nW)]
    for t in TW:
        for a_, b_ in ((t[0], t[1]), (t[1], t[2]), (t[2], t[0])):
            nb[a_].append(b_); nb[b_].append(a_)
    idx = np.where(phw)[0]
    nbs = [np.unique(nb[v]) for v in idx]
    for _ in range(400):
        Q[idx] = np.array([Q[n_].mean(0) for n_ in nbs])
    # класс поверхности под старыми наушниками (мех 1 / худи 0) — гармонически от краёв мембраны, как и форма:
    # граница «мех/худи» проходит гладкой линией, без островков чужого цвета (v2: светлые лоскуты на худи, тёмные на меху)
    from mesh_parts import BODY as _BODY
    labw = np.zeros(nW, np.int64); labw[wl] = lab
    fcl = (labw == _BODY).astype(np.float64)
    isb = np.zeros(nW, bool)
    for n_ in nbs:
        isb[n_] = True
    isb &= ~phw
    fcl[idx] = 0.5
    for _ in range(600):
        fcl[idx] = np.array([fcl[n_].mean() for n_ in nbs])
    furv = fcl[wl]
    P1 = Q[wl]
    moved = np.linalg.norm(P1 - P, axis=1)
    print(f'  мембрана: {phw.sum()} вершин, сдвиг ≤ {moved.max() * 1000:.0f} мм')
    g.set_acc(b['attributes']['POSITION'], P1.astype(np.float32))
    # нормали мембраны — по сетке
    Nn = vnormals(P1, I)
    N2 = N.copy(); N2[ph] = Nn[ph]
    g.set_acc(b['attributes']['NORMAL'], N2.astype(np.float32))
    # тексели старых наушников: цвет ближайшей (в 3D) вершины не-наушников
    mat = j['materials'][b['material']]
    ti = j['textures'][mat['pbrMetallicRoughness']['baseColorTexture']['index']]['source']
    img = np.asarray(g.image(ti).convert('RGB')).copy()
    S = img.shape[0]
    tri_ph = np.where(ph[I].any(1) | (teal[I].sum(1) >= 2) & (np.linalg.norm(P[I].mean(1) - bc, axis=1) < 0.25))[0]
    pos, _, tid = raster_uv(P1, N2, UV, I[tri_ph], S)
    m = tid >= 0
    src_v = np.where(~ph & (np.linalg.norm(P - bc, axis=1) < 0.3))[0]
    col = img[np.clip((UV[src_v, 1] % 1) * S, 0, S - 1).astype(int), np.clip((UV[src_v, 0] % 1) * S, 0, S - 1).astype(int)].astype(np.float64)
    # v2b: класс соседей (худи / мех) — большинством из 16 ближайших, цвет — медиана своего класса (не смесь тёмного
    # худи и светлого меха: в v2 «грязные» серые пятна у ключиц); худи — общий тон худи рядом, без шума
    from mesh_parts import HOODIE
    cls = (lab[src_v] == HOODIE).astype(np.int64)
    # класс текселя — поле furv в ближайших вершинах старой детали (обратные расстояния)
    phv = np.where(ph)[0]
    dd, qv = cKDTree(P1[phv]).query(pos[m], k=4)
    wv = 1 / np.maximum(dd, 1e-5)
    hood = (furv[phv][qv] * wv).sum(1) / wv.sum(1) < 0.5
    _, q = cKDTree(P1[src_v]).query(pos[m], k=24)
    hood_col = np.median(col[cls == 1], axis=0) if (cls == 1).any() else col.mean(0)
    fur_all = col[cls == 0]
    out = np.empty((m.sum(), 3))
    for k_, (qq, hd) in enumerate(zip(q, hood)):
        same = qq[cls[qq] == int(hd)]
        out[k_] = np.median(col[same], axis=0) if len(same) >= 3 else (hood_col if hd else np.median(fur_all, axis=0))
    out[hood] = hood_col
    img[m] = np.clip(out, 0, 255).astype(np.uint8)
    # мягко: размытие перекрашенных текселей (нормированная свёртка внутри маски) — без зерна по UV-островам
    from scipy import ndimage as _nd
    fm = m.astype(np.float64)
    for ch in range(3):
        a_ = img[..., ch].astype(np.float64) * fm
        bl_ = _nd.gaussian_filter(a_, 2.5) / np.maximum(_nd.gaussian_filter(fm, 2.5), 1e-6)
        img[..., ch][m] = np.clip(bl_[m], 0, 255).astype(np.uint8)
    # остатки бирюзы на краях островов UV (тексели вне растра треугольников): в окрестности — цветом ближайшего не-бирюзового
    from scipy import ndimage
    near_ = ndimage.binary_dilation(m, iterations=8)
    hi, si_, vi = hsv(img.reshape(-1, 3).astype(np.float64))
    tq = ((hi > 150) & (hi < 205) & (si_ > 0.22)).reshape(m.shape) & near_
    if tq.any():
        _, (iy, ix) = ndimage.distance_transform_edt(tq, return_indices=True)
        img[tq] = img[iy[tq], ix[tq]]
    print(f'  бирюза на краях: {tq.sum()} текселей')
    from PIL import Image
    g.set_image(ti, Image.fromarray(img))
    print(f'  перекрашено {m.sum()} текселей')

    # --- 3. сборка новых наушников + зазор
    Ib = I  # всё тело
    tree = cKDTree(P1)

    def build(side, band_scale):
        parts_s, parts_p = [], []
        tops = []
        for sd in side:
            (Vs, Fs), (Vp, Fp) = cup(sd['c'], sd['ax'], sd['R'], sd['D'])
            parts_s.append((Vs, Fs)); parts_p.append((Vp, Fp))
            _, u, v = frame(sd['ax'])
            # крепление дуги — край чашки сверху-сзади (к шее), а не макушка чашки: дуга лежит на капюшоне, а не под подбородком
            wdir = np.array([0, 0.75, 0]) + np.array([sd['s'] * 0.25, 0, -0.62])
            wdir = wdir - sd['ax'] * (wdir @ sd['ax']); wdir /= np.linalg.norm(wdir)
            tops.append(sd['c'] + sd['ax'] * sd['D'] * 0.45 + wdir * (sd['R'] * 0.92))
        # дуга: от верха левой чашки назад вокруг шеи к правой (эллипс в наклонной плоскости через верхи чашек)
        aL = np.arctan2((tops[0][2] - bc[2]) / (bz * band_scale), (tops[0][0] - bc[0]) / (bx * band_scale))
        aR = np.arctan2((tops[1][2] - bc[2]) / (bz * band_scale), (tops[1][0] - bc[0]) / (bx * band_scale))
        if aR > aL:
            aR -= 2 * np.pi
        ts = np.linspace(aL, aR, BAND_N)
        # радиус по углу — тело на высоте дуги (шея/капюшон после мембраны) + трубка + зазор
        rr = []
        for t_ in ts:
            d_ = np.array([np.cos(t_) * bx, 0, np.sin(t_) * bz]); d_ /= np.linalg.norm(d_)
            m_ = (np.abs(P1[:, 1] - yb) < 0.014) & ((P1 - bc) @ d_ > 0)
            pr_ = P1[m_] - bc; pr_[:, 1] = 0
            along = pr_ @ d_
            perp = np.linalg.norm(pr_ - along[:, None] * d_, axis=1)
            sel = perp < 0.015
            rr.append((along[sel].max() if sel.any() else 0.0) + BAND_R * BAND_FLAT + 0.003)
        rr = np.maximum.accumulate(np.array(rr)) * 0 + np.array(rr)
        from scipy.ndimage import uniform_filter1d as _uf
        rr = _uf(np.array(rr), 5, mode='nearest') * band_scale
        dirs = np.c_[np.cos(ts) * bx, np.zeros(BAND_N), np.sin(ts) * bz]
        dirs /= np.linalg.norm(dirs, axis=1, keepdims=True)
        path = bc + dirs * rr[:, None]
        path[:, 1] = yb
        # высота: от верха чашек к дуге сзади
        wgt = np.sin(np.linspace(0, np.pi, BAND_N))
        path[:, 1] = (1 - wgt) * np.interp(np.linspace(0, 1, BAND_N), [0, 1], [tops[0][1], tops[1][1]]) + wgt * (yb + 0.004)
        path[0], path[-1] = tops[0], tops[1]
        Vb, Fb = tube(path, BAND_R)
        parts_s.append((Vb, Fb))
        return parts_s, parts_p, path

    def hits(parts):
        n = 0
        for V, F in parts:
            n += len(tri_pairs_intersect(V, F, P1, Ib))
        return n
    scale = 1.0
    for it in range(60):
        ps, pp, path = build(side, scale)
        hc = [hits([ps[k], pp[k]]) for k in range(2)]
        hb = hits([ps[2]])
        if not any(hc) and not hb:
            break
        for k in range(2):
            if hc[k]:
                side[k]['c'] = side[k]['c'] + side[k]['ax'] * 0.0015
        if hb:
            scale *= 1.006
    # зазор 1.5 мм сверх касания
    for k in range(2):
        side[k]['c'] = side[k]['c'] + side[k]['ax'] * 0.0015
    ps, pp, path = build(side, scale * 1.006)
    print(f'  без проникновения за {it} шагов: дуга ×{scale:.3f}, чашки сдвинуты на '
          f'{np.linalg.norm(side[0]["c"] - side[0]["c"]) :.3f}; пересечений {hits(ps) + hits(pp)}')

    # --- 4. скин
    def wfor(points):
        _, q = tree.query(points, k=6)
        out = []
        nj = len(j['skins'][0]['joints'])
        for row in q:
            full = np.zeros(nj)
            for v in row:
                np.add.at(full, J[v], Wt[v])
            out.append(full / full.sum())
        return np.array(out)
    nj = len(j['skins'][0]['joints'])
    prims = []
    allV = []
    for kind, plist in (('shell', ps), ('pad', pp)):
        Vs, Fs, Ws = [], [], []
        off = 0
        for pi, (V, F) in enumerate(plist):
            if kind == 'shell' and pi == 2:  # дуга: веса по сечениям
                wp = wfor(path)
                from scipy.ndimage import uniform_filter1d
                wp = uniform_filter1d(wp, 7, axis=0, mode='nearest')
                W = np.vstack([np.repeat(wp, BAND_S, axis=0), wp[[0, -1]]])
            else:
                c = V.mean(0)
                W = np.repeat(wfor(c[None]), len(V), axis=0)
            Vs.append(V); Fs.append(F + off); Ws.append(W); off += len(V)
        V = np.vstack(Vs); F = np.vstack(Fs); W = np.vstack(Ws)
        allV.append(V)
        top = np.argsort(-W, axis=1)[:, :4]
        tw = np.take_along_axis(W, top, 1); tw /= tw.sum(1, keepdims=True)
        q8 = np.round(tw * 255).astype(np.int64); q8[np.arange(len(q8)), q8.argmax(1)] += 255 - q8.sum(1)
        wq = g.add_acc(q8.astype(np.uint8), 5121, 'VEC4', 34962); j['accessors'][wq]['normalized'] = True
        Nv = vnormals(V, F)
        attrs = {'POSITION': g.add_acc(V.astype(np.float32), 5126, 'VEC3', 34962), 'NORMAL': g.add_acc(Nv.astype(np.float32), 5126, 'VEC3', 34962),
                 'JOINTS_0': g.add_acc(top.astype(np.uint8 if nj < 256 else np.uint16), 5121 if nj < 256 else 5123, 'VEC4', 34962), 'WEIGHTS_0': wq}
        matd = {'name': f'Headphones_{kind}_mat', 'pbrMetallicRoughness': {'baseColorFactor': srgb2lin(SHELL if kind == 'shell' else PAD),
                'metallicFactor': 0.0, 'roughnessFactor': 0.28 if kind == 'shell' else 0.92}}
        j['materials'].append(matd)
        prims.append({'attributes': attrs, 'indices': g.add_acc(F.ravel().astype(np.uint16), 5123, 'SCALAR', 34963), 'material': len(j['materials']) - 1})
        print(f'  {kind}: {len(V)} вершин, {len(F)} треугольников')
    j['meshes'].append({'name': 'Headphones_Hooligan', 'primitives': prims})
    bnode = next(i for i, n in enumerate(j['nodes']) if n.get('mesh') == bi)
    j['nodes'].append({'name': 'Headphones_Hooligan', 'mesh': len(j['meshes']) - 1, 'skin': j['nodes'][bnode]['skin'],
                       'extras': {'headphones': {'cups': [{'c': [round(float(x), 5) for x in sd['c']], 'axis': [round(float(x), 5) for x in sd['ax']],
                                                           'r': round(sd['R'], 5), 'depth': round(sd['D'], 5)} for sd in side],
                                                 'band': [[round(float(x), 5) for x in p] for p in path[::3]], 'band_r': BAND_R}}})
    parent = next((n for n in j['nodes'] if bnode in n.get('children', [])), None)
    (parent['children'] if parent is not None else j['scenes'][0]['nodes']).append(len(j['nodes']) - 1)
    g.save(dst)


if __name__ == '__main__':
    main()

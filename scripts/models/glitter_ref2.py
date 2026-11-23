#!/usr/bin/env python3
"""Блёстка по развороту 23.11, второй проход (design/refs/glitter_turnaround_1123.png): пачка в три яруса, длинный хвост.
Капюшон сзади (лиловый, мятная подкладка у шеи, золотая окантовка) проверен на листе — виден, геометрию не трогали. Без генераций, numpy; кости и их имена не меняются (анимации, tailRig, footPin — как были).

  python3 scripts/models/glitter_ref2.py in.glb out.glb [--all | --tail --tutu]

Вход — p1 после glitter_ref.py (ece63b2), выход — новая p1; затем face_rig.py → p2 и colliders.py (README моделей).
Повторный запуск отказывается (пометка extras.ref1124 узла Brows).
  --tail  хвост: прежний «помпон» (луковица на костях Tail1…4, 871 вершина тела + пряди-карточки) вытянут вдоль новой
          оси — назад и вверх с загибом, ≈ 2.3× длиннее, толще к кончику; та же сетка, UV и шов со «стеблем» (вес Hips),
          веса — плавно по длине Tail1 → Tail4 (кончик дальше Tail4 — на Tail4); мех оболочек на хвосте длиннее.
  --tutu  пачка: меш Skirt_Glitter заново — три яруса колоколом от пояса (внутренний — до середины бедра, внешний —
          короткий), у каждого яруса свои фестоны подола (UV0.y — t яруса: золотая кайма tulleFx у каждого),
          UV1.y — t от пояса до нижнего подола (качание пачки одно на все ярусы). Скин — поле весов прежней пачки
          (сектор × высота, ниже прежнего подола — как у подола: бока на бёдрах, перед и зад на тазу), у ярусов
          в одной точке — одинаковые веса; не ближе 5 мм к телу с мехом; прорезь под хвост.
"""
import sys
import numpy as np
from glb_io import Glb
from penetration import tri_pairs_intersect


def sstep(a, b, x):
    t = np.clip((np.asarray(x, float) - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def node_by_name(j, name):
    return next(i for i, n in enumerate(j['nodes']) if n.get('name') == name)


def joint_names(j):
    return [j['nodes'][x]['name'].replace('mixamorig:', '') for x in j['skins'][0]['joints']]


def weights(g, pr):
    J = g.acc(pr['attributes']['JOINTS_0']).astype(np.int64)
    W = g.acc(pr['attributes']['WEIGHTS_0']).astype(np.float64)
    W /= 255.0 if W.max() > 1.5 else 1.0
    W /= np.maximum(W.sum(1, keepdims=True), 1e-9)
    return J, W


def dense(J, W, nj):
    full = np.zeros((len(J), nj))
    for k in range(4):
        np.add.at(full, (np.arange(len(J)), J[:, k]), W[:, k])
    return full


def top4(full):
    top = np.argsort(-full, axis=1)[:, :4]
    tw = np.take_along_axis(full, top, 1)
    tw /= np.maximum(tw.sum(1, keepdims=True), 1e-9)
    q8 = np.round(tw * 255).astype(np.int64)
    q8[np.arange(len(q8)), q8.argmax(1)] += 255 - q8.sum(1)
    return top, q8.astype(np.uint8)


def body_prim(g):
    bi, b = g.main_mesh()
    return b


def fur_prim(g):
    j = g.j
    n = j['nodes'][node_by_name(j, 'BD_FurShell')]
    return j['meshes'][n['mesh']]['primitives'][0]


def cards_prim(g):
    j = g.j
    n = j['nodes'][node_by_name(j, 'BD_FurCards')]
    return j['meshes'][n['mesh']]['primitives'][0]


def compact(g, pr, I):
    """примитив только с вершинами из I (атрибуты и морфы — заново): лишние вершины не попадают в габарит
    (Box3.setFromObject(precise) в рантайме идёт по всем вершинам буфера)"""
    j = g.j
    used = np.unique(I)
    remap = np.full(int(I.max()) + 1 if len(I) else 1, -1, np.int64)
    remap[used] = np.arange(len(used))

    def sub(ai):
        a = j['accessors'][ai]
        arr = g.acc(ai)
        arr = arr.reshape(a['count'], -1)[used]
        ni = g.add_acc(arr, a['componentType'], a['type'], 34962)
        if a.get('normalized'):
            j['accessors'][ni]['normalized'] = True
        return ni
    pr['attributes'] = {k: sub(v) for k, v in pr['attributes'].items()}
    def sub_sparse(ai):
        d = np.asarray(g.acc(ai), np.float32).reshape(-1, 3)[used]
        idx = np.where(np.abs(d).max(1) > 1e-7)[0].astype(np.uint32)
        if not len(idx):
            idx = np.array([0], np.uint32)
        vals = np.ascontiguousarray(d[idx])
        views = []
        for data in (idx.tobytes(), vals.tobytes()):
            j['bufferViews'].append({'buffer': 0, 'byteLength': len(data)})
            g.extra[len(j['bufferViews']) - 1] = data
            views.append(len(j['bufferViews']) - 1)
        j['accessors'].append({'componentType': 5126, 'count': int(len(used)), 'type': 'VEC3',
                               'min': np.minimum(vals.min(0), 0).tolist(), 'max': np.maximum(vals.max(0), 0).tolist(),
                               'sparse': {'count': int(len(idx)), 'indices': {'bufferView': views[0], 'componentType': 5125},
                                          'values': {'bufferView': views[1]}}})
        return len(j['accessors']) - 1
    if 'targets' in pr:
        pr['targets'] = [{k: sub_sparse(v) for k, v in t.items()} for t in pr['targets']]
    ct = 5123 if len(used) < 65535 else 5125
    pr['indices'] = g.add_acc(remap[I].ravel(), ct, 'SCALAR', 34963)


# ───────────────────────── хвост ─────────────────────────
def catmull(pts, n):
    """гладкая кривая через точки (Catmull–Rom, центростремительная) → n точек, равномерно по длине"""
    P = np.asarray(pts, float)
    Q = np.vstack([2 * P[0] - P[1], P, 2 * P[-1] - P[-2]])
    out = []
    for i in range(1, len(Q) - 2):
        p0, p1, p2, p3 = Q[i - 1:i + 3]
        for t in np.linspace(0, 1, 40, endpoint=False):
            t2, t3 = t * t, t * t * t
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
    out.append(P[-1])
    C = np.array(out)
    L = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(C, axis=0), axis=1))])
    s = np.linspace(0, L[-1], n)
    return np.stack([np.interp(s, L, C[:, k]) for k in range(3)], 1), L[-1]


def frames(C):
    """касательные и параллельный перенос нормали вдоль кривой"""
    T = np.gradient(C, axis=0)
    T /= np.linalg.norm(T, axis=1, keepdims=True)
    N = np.zeros_like(C)
    n0 = np.array([1.0, 0, 0])
    n0 -= T[0] * (T[0] @ n0)
    N[0] = n0 / np.linalg.norm(n0)
    for i in range(1, len(C)):
        v = N[i - 1] - T[i] * (T[i] @ N[i - 1])
        N[i] = v / np.linalg.norm(v)
    B = np.cross(T, N)
    return T, N, B


# новая ось хвоста (y, z; x = 0) в позе привязки: от «стебля» назад-вверх, к кончику загиб вверх (реф, профиль)
# (z не дальше −0.245 по оси: габарит модели по z почти прежний — рантайм центрирует кота по габариту)
TAIL_AXIS = [(0.291, -0.161), (0.297, -0.200), (0.318, -0.231), (0.353, -0.245), (0.393, -0.244), (0.430, -0.232), (0.461, -0.212)]
# радиус по длине (доля s): у стебля как прежняя луковица у основания, тоньше, к кончику пышнее, кончик круглый
TAIL_R = [(0.0, 0.036), (0.18, 0.03), (0.5, 0.034), (0.75, 0.036), (0.9, 0.031), (1.0, 0.0)]
TAIL_FUR = 0.016


def tail(g):
    j = g.j
    jn = joint_names(j)
    tid = [jn.index(f'Tail{i}') for i in range(1, 5)]
    hips = jn.index('Hips')
    b = body_prim(g)
    a = b['attributes']
    P = g.acc(a['POSITION']).astype(np.float64)
    N = g.acc(a['NORMAL']).astype(np.float64)
    J, W = weights(g, b)
    tw = (np.isin(J, tid) * W).sum(1)
    tv = np.where(tw > 0.5)[0]
    I = g.acc(b['indices']).reshape(-1, 3)
    mixed = (tw[I].max(1) > 0.5) & (tw[I].min(1) < 0.5)
    ring = np.unique(I[mixed].ravel())
    ring = ring[tw[ring] < 0.5]
    B0 = P[ring].mean(0)
    # старая ось луковицы: от кольца шва к самой дальней точке
    X = P[tv]
    far = X[np.argmax(np.linalg.norm(X - B0, axis=1))]
    ax0 = (far - B0) / np.linalg.norm(far - B0)
    s_old = (X - B0) @ ax0
    L_old = s_old.max()
    u_old = np.clip(s_old / L_old, 0, 1)
    D_old = (X - B0) - np.outer(s_old, ax0)
    r_old = np.linalg.norm(D_old, axis=1)
    # средний радиус луковицы по s (огибающая), чтобы перенести «рельеф» на новый профиль
    bins = np.linspace(0, 1, 21)
    bi_ = np.clip(np.digitize(u_old, bins) - 1, 0, 19)
    rm = np.array([np.percentile(r_old[bi_ == k], 80) if (bi_ == k).sum() > 3 else np.nan for k in range(20)])
    rm = np.interp(np.arange(20), np.where(~np.isnan(rm))[0], rm[~np.isnan(rm)])
    rmean = np.interp(u_old, (bins[:-1] + bins[1:]) / 2, rm)
    # старый базис поперёк оси
    e1 = np.array([1.0, 0, 0]); e1 -= ax0 * (ax0 @ e1); e1 /= np.linalg.norm(e1)
    e2 = np.cross(ax0, e1)
    c1, c2 = D_old @ e1, D_old @ e2
    # новая ось: точно от центра кольца шва
    pts = [(B0[0], B0[1], B0[2])] + [(0.0, y, z) for y, z in TAIL_AXIS[1:]]
    C, L_new = catmull(pts, 200)
    T, Nn, Bn = frames(C)
    # e1 старого ~ Nn[0] (x), e2 ~ Bn[0]: знак — по совпадению с ним
    if Bn[0] @ e2 < 0:
        Bn = -Bn
    # s: старая доля → новая (основание у шва не двигается: первые 6 % — плавный переход)
    us = np.array([p[0] for p in TAIL_R]); rs = np.array([p[1] for p in TAIL_R])
    ui = np.clip(np.round(u_old * 199).astype(int), 0, 199)
    Rn = np.interp(u_old, us, rs)
    # у кончика старая луковица закругляется — рельеф там к нулю вместе с профилем; отношение r/rmean
    k = np.clip(r_old / np.maximum(rmean, 1e-4), 0, 1.12)
    newP = C[ui] + (Nn[ui] * c1[:, None] + Bn[ui] * c2[:, None]) / np.maximum(r_old, 1e-6)[:, None] * (k * Rn)[:, None]
    # кончик: точки старой «шапки» (u > 0.97) — в купол
    blend = sstep(0.0, 0.08, u_old)[:, None]
    P2 = P.copy()
    P2[tv] = X * (1 - blend) + newP * blend
    # веса по длине: шов — Hips→Tail1, дальше Tail1→2→3→4 (кончик дальше Tail4 — на Tail4)
    knots = [(0.0, hips), (0.13, tid[0]), (0.27, tid[1]), (0.41, tid[2]), (0.57, tid[3])]
    nj = len(jn)
    full = np.zeros((len(tv), nj))
    xs = np.array([q[0] for q in knots])
    for i, (x0, jj) in enumerate(knots):
        lo = xs[i - 1] if i else -1.0
        hi = xs[i + 1] if i + 1 < len(xs) else 9.0
        w = np.where(u_old <= x0, np.clip((u_old - lo) / (x0 - lo), 0, 1), np.clip((hi - u_old) / (hi - x0), 0, 1))
        if i == len(knots) - 1:
            w = np.where(u_old >= x0, 1.0, w)
        if i == 0:
            w = np.where(u_old <= x0, 1.0, w)
        full[:, jj] += w
    full /= full.sum(1, keepdims=True)
    top, q8 = top4(full)
    Jall = g.acc(a['JOINTS_0']).copy(); Wall = g.acc(a['WEIGHTS_0']).copy()
    if Wall.dtype != np.uint8:
        Wall = Wall.astype(np.float32)
        Wall[tv] = q8 / 255.0
    else:
        Wall[tv] = q8
    Jall[tv] = top.astype(Jall.dtype)
    g.set_acc(a['JOINTS_0'], Jall)
    g.set_acc(a['WEIGHTS_0'], Wall)
    # нормали хвоста — по граням (сетка тела и оболочек — общие буферы)
    T_ = I[np.isin(I, tv).any(1)]
    fn = np.cross(P2[T_[:, 1]] - P2[T_[:, 0]], P2[T_[:, 2]] - P2[T_[:, 0]])
    from mesh_parts import weld
    w = weld(P2)
    Nw = np.zeros((w.max() + 1, 3))
    for q in range(3):
        np.add.at(Nw, w[T_[:, q]], fn)
    N2 = N.copy()
    nn = Nw[w[tv]]
    nn /= np.maximum(np.linalg.norm(nn, axis=1, keepdims=True), 1e-12)
    N2[tv] = N[tv] * (1 - blend) + nn * blend
    N2[tv] /= np.linalg.norm(N2[tv], axis=1, keepdims=True)
    g.set_acc(a['POSITION'], P2.astype(np.float32))
    g.set_acc(a['NORMAL'], N2.astype(np.float32))
    # морфы тела (лицо) у хвоста нулевые — проверка
    for t_ in b.get('targets', []):
        d = g.acc(t_['POSITION'])
        assert np.abs(d[tv]).max() < 1e-6, 'морф двигает хвост'
    # мех оболочек на хвосте — длиннее к кончику (пышный хвост рефа)
    f = fur_prim(g)
    FL = g.acc(f['attributes']['_FURLEN']).astype(np.float64)
    FL[tv] = np.maximum(FL[tv], TAIL_FUR * (0.75 + 0.25 * sstep(0.1, 0.7, u_old)) * (1 - sstep(0.96, 1.0, u_old) * 0.4))
    g.set_acc(f['attributes']['_FURLEN'], FL.astype(np.float32))
    print(f'  хвост: {len(tv)} вершин; ось {L_old:.3f} → {L_new:.3f} м (×{L_new / L_old:.2f}), кончик {np.round(C[-1], 3)}, '
          f'z min {P2[tv][:, 2].min():.3f} (было {X[:, 2].min():.3f}); мех {TAIL_FUR}')
    # пряди-карточки хвоста (помпон): тем же переносом, но по корню пряди; ориентация пряди — вдоль новой оси
    cp = cards_prim(g)
    ca = cp['attributes']
    Pc = g.acc(ca['POSITION']).astype(np.float64)
    Jc, Wc = weights(g, cp)
    twc = (np.isin(Jc, tid) * Wc).sum(1)
    cv = np.where(twc > 0.5)[0]
    Ic = g.acc(cp['indices']).reshape(-1, 3).astype(np.int64)
    # карточки хвоста прочь: на длинном хвосте — мех оболочек (помпон-шар из прядей не нужен)
    keep = ~np.isin(Ic, cv).any(1)
    compact(g, cp, Ic[keep])
    print(f'  пряди хвоста (помпон): {(~keep).sum()} треугольников прочь')
    # «стебель» (вес Hips): от кольца шва к спине — ось и радиус для прорези в пачке
    st = np.where((tw < 0.5) & (P[:, 2] < B0[2] + 0.06) & (np.linalg.norm(P - B0, axis=1) < 0.07))[0]
    A_ = np.array([0.0, B0[1] - 0.01, B0[2] + 0.06])
    rr = np.linalg.norm((P[ring] - B0)[:, :2], axis=1).max()
    return {'C': C, 'R': (us, rs), 'tv': tv, 'stalk': (A_, B0.copy()), 'stalk_r': rr + 0.012}


# ───────────────────────── пачка ─────────────────────────
NT, NS = 96, 12
TIERS = [  # (подол y, вынос подола наружу м, фаза фестонов, альфа-множитель)
    (0.170, 0.012, 0.0, 0.9),
    (0.212, 0.018, 1.9, 0.95),
    (0.254, 0.022, 3.7, 1.0),
]
GAP = 0.006
FEST = 0.0065   # глубина фестонов подола
NFEST = 14


def tutu(g, tail_info=None):
    j = g.j
    jn = joint_names(j)
    nj = len(jn)
    si_ = node_by_name(j, 'Skirt_Glitter')
    sn = j['nodes'][si_]
    sp = j['meshes'][sn['mesh']]['primitives'][0]
    c = np.array(sn['extras']['c'])
    V0 = g.acc(sp['attributes']['POSITION']).astype(np.float64)
    J0, W0 = weights(g, sp)
    nt0, ns0 = 80, 13
    per0 = nt0 * ns0
    assert len(V0) == 3 * per0, 'ожидалась пачка tulle.py (3 слоя × 13 × 80)'
    F0 = dense(J0[:per0], W0[:per0], nj).reshape(ns0, nt0, nj)
    L0 = V0[:per0].reshape(ns0, nt0, 3)
    yt = float(L0[0, :, 1].mean())
    yb0 = float(L0[-1, :, 1].mean())
    rad = lambda Q: np.hypot(Q[..., 0] - c[0], Q[..., 2] - c[2])
    r_waist0 = rad(L0[0])          # по секторам (80)
    r_hem0 = rad(L0[-1])
    th0 = np.arctan2(L0[0, :, 2] - c[2], L0[0, :, 0] - c[0])
    order = np.argsort(th0)
    th = np.linspace(-np.pi, np.pi, NT, endpoint=False)
    per = lambda arr: np.interp(th, th0[order], arr[order], period=2 * np.pi)
    rw = per(r_waist0)
    rh = per(r_hem0)
    # тело с мехом: радиус по сектору и высоте (без рук, кистей и хвоста)
    b = body_prim(g)
    P = g.acc(b['attributes']['POSITION']).astype(np.float64)
    Nb = g.acc(b['attributes']['NORMAL']).astype(np.float64)
    Jb, Wb = weights(g, b)
    FL = g.acc(fur_prim(g)['attributes']['_FURLEN']).astype(np.float64)
    armw = (Wb * np.array([('Arm' in n or 'Hand' in n or n.startswith('Tail')) for n in jn])[Jb]).sum(1)
    Pf = P + Nb * FL[:, None]
    y_low = min(t[0] for t in TIERS)
    sel = (armw < 0.2) & (Pf[:, 1] > y_low - 0.02) & (Pf[:, 1] < yt + 0.01) & (rad(Pf) < 0.25)
    Q = Pf[sel]
    qa = ((np.arctan2(Q[:, 2] - c[2], Q[:, 0] - c[0]) + np.pi) / (2 * np.pi) * NT).astype(int) % NT
    YG = np.linspace(yt + 0.004, y_low - 0.02, 48)
    rb = np.zeros((NT, len(YG)))
    for k in range(NT):
        m = np.abs(((qa - k + NT // 2) % NT) - NT // 2) <= 2
        for yi, y in enumerate(YG):
            mm = m & (np.abs(Q[:, 1] - y) < 0.008)
            rb[k, yi] = rad(Q[mm]).max() if mm.any() else 0.0

    # профиль: колокол от пояса (как прежняя пачка у пояса) к подолу нижнего яруса; радиус подола — прежний ×1.04
    R_low = rh * 1.04

    def base_r(k, y):
        t = np.clip((yt - y) / (yt - y_low), 0, 1)
        prof = 1 - (1 - t) ** 3.2
        return rw[k] + (R_low[k] - rw[k]) * prof

    def tier_r(L, k, y, s):
        """радиус яруса L в секторе k на высоте y; s — доля по ярусу 0 (пояс) … 1 (подол)"""
        r = base_r(k, y) + GAP * L
        # вынос подола яруса наружу (пышные оборки ярусов), складки
        r += TIERS[L][1] * sstep(0.45, 1.0, s)
        r += 0.0016 * np.sin(18 * th[k] + 2.1 * L) * s
        r += 0.0025 * np.sin(NFEST * th[k] + TIERS[L][2]) * s ** 2
        return r

    extra = np.zeros((NT, len(YG)))  # добавка радиуса там, где тело прошло бы сквозь фатин

    def build():
        V, U0, U1, COL, F, KS = [], [], [], [], [], []
        Rt = np.zeros((len(TIERS), NS, NT))
        for L, (yh, out, ph, am) in enumerate(TIERS):
            base = len(V)
            y_top = yt - 0.003 * L
            for si in range(NS):
                # ряды гуще у пояса (там колокол круче — хорды ярусов не сходятся)
                s = (si / (NS - 1)) ** 1.5
                for k in range(NT):
                    a = th[k]
                    fest = FEST * (0.5 + 0.5 * np.cos(NFEST * a + ph)) ** 1.6
                    y_hem = yh + fest
                    y = y_top + (y_hem - y_top) * s
                    r = tier_r(L, k, y, s) + np.interp(-y, -YG, extra[k])
                    if L:  # снаружи предыдущего яруса на той же высоте (порядок слоёв цел)
                        yy = Vy[L - 1][:, k]
                        r = max(r, np.interp(-y, -yy, Rt[L - 1, :, k]) + GAP)
                    Rt[L, si, k] = r
                    V.append([c[0] + r * np.cos(a), y, c[2] + r * np.sin(a)])
                    # t каймы — в долях длины нижнего яруса: золотая кайма у всех ярусов одной ширины
                    U0.append([(k / NT), 1 - (1 - s) * (y_top - yh) / (yt - y_low)])
                    U1.append([0.0, (yt - y) / (yt - y_low)])
                    COL.append([0.93 + 0.07 * s, 0.93 + 0.07 * s, 0.93 + 0.07 * s, (0.84 - 0.14 * s) * am])
                    KS.append((L, si, k))
            Vy.append(np.array(V[base:])[:, 1].reshape(NS, NT))
            for si in range(NS - 1):
                for k in range(NT):
                    a0 = base + si * NT + k
                    a1 = base + si * NT + (k + 1) % NT
                    F += [[a0, a0 + NT, a1 + NT], [a0, a1 + NT, a1]]
        return np.array(V), np.array(U0), np.array(U1), np.array(COL), np.array(F), np.array(KS)

    Ib_all = g.acc(b['indices']).reshape(-1, 3).astype(np.int64)
    tw_b = (Wb * np.array([n.startswith('Tail') for n in jn])[Jb]).sum(1)
    tail_t = (tw_b[Ib_all] > 0.3).any(1)
    Ibody, Itail = Ib_all[~tail_t], Ib_all[tail_t]
    for it in range(30):
        Vy = []
        V, U0, U1, COL, F, KS = build()
        pp = tri_pairs_intersect(V, F, P, Ibody)
        if not len(pp):
            break
        hv = np.unique(F[pp[:, 0]].ravel())
        for v in hv:
            L, si, k = KS[v]
            yi = int(np.argmin(np.abs(YG - V[v, 1])))
            for dk in (-1, 0, 1):
                extra[(k + dk) % NT, max(0, yi - 2):yi + 3] += 0.0015
        from scipy.ndimage import gaussian_filter1d
        extra = gaussian_filter1d(gaussian_filter1d(extra, 1.2, axis=1, mode='nearest'), 1.0, axis=0, mode='wrap')
    print(f'  пачка: {it} шагов подгонки к телу, пересечений осталось {len(pp)}; прибавка радиуса до {extra.max() * 1000:.1f} мм')
    # прорезь под хвост: треугольники фатина, которые режет хвост (с соседями)
    cut = np.zeros(len(F), bool)
    for _ in range(2):
        pt = tri_pairs_intersect(V, F[~cut], P, Itail)
        idx = np.where(~cut)[0][pt[:, 0]] if len(pt) else []
        if not len(idx):
            break
        vv = np.unique(F[idx].ravel())
        cut |= np.isin(F, vv).any(1)
    # и вокруг «стебля» хвоста (вес Hips, от спины к хвосту): в позах спина и пачка гнутся иначе, чем таз
    if tail_info is not None:
        A_, B_ = tail_info['stalk']
        d_ = B_ - A_
        tq = np.clip(((V - A_) @ d_) / (d_ @ d_), 0, 1)
        near = np.linalg.norm(V - (A_ + tq[:, None] * d_), axis=1) < tail_info['stalk_r']
        c2 = near[F].any(1) & ~cut
        cut |= c2
    F = F[~cut]
    # скин: поле весов прежней пачки (сектор × высота), ниже прежнего подола — как у подола
    tg = np.clip((yt - V[:, 1]) / (yt - yb0), 0, 1) * (ns0 - 1)
    ang = (np.arctan2(V[:, 2] - c[2], V[:, 0] - c[0]))
    # сектор прежней пачки: по её углам (th0 не равномерен по построению tulle.py: linspace от −π)
    th0u = np.linspace(-np.pi, np.pi, nt0, endpoint=False)
    kf = (ang + np.pi) / (2 * np.pi) * nt0
    k0 = np.floor(kf).astype(int) % nt0; k1 = (k0 + 1) % nt0; fk = (kf - np.floor(kf))[:, None]
    r0 = np.floor(tg).astype(int); r1 = np.minimum(r0 + 1, ns0 - 1); fr = (tg - r0)[:, None]
    full = (F0[r0, k0] * (1 - fk) + F0[r0, k1] * fk) * (1 - fr) + (F0[r1, k0] * (1 - fk) + F0[r1, k1] * fk) * fr
    top, q8 = top4(full)
    # нормали: наружу и чуть вверх к подолу (как у прежней пачки)
    Nn = np.stack([np.cos(ang), 0.1 + 0.35 * U0[:, 1], np.sin(ang)], 1)
    Nn /= np.linalg.norm(Nn, axis=1, keepdims=True)
    # заменить данные меша (тот же узел, материал и разметка extras.tulle / tulleUV)
    for a_ in list(sp['attributes'].values()) + [sp['indices']]:
        g.extra[j['accessors'][a_]['bufferView']] = b''
    attrs = {'POSITION': g.add_acc(V.astype(np.float32), 5126, 'VEC3', 34962),
             'NORMAL': g.add_acc(Nn.astype(np.float32), 5126, 'VEC3', 34962),
             'TEXCOORD_0': g.add_acc(U0.astype(np.float32), 5126, 'VEC2', 34962),
             'TEXCOORD_1': g.add_acc(U1.astype(np.float32), 5126, 'VEC2', 34962),
             'COLOR_0': g.add_acc(np.round(np.clip(COL, 0, 1) * 255).astype(np.uint8), 5121, 'VEC4', 34962),
             'JOINTS_0': g.add_acc(top.astype(np.uint8), 5121, 'VEC4', 34962),
             'WEIGHTS_0': g.add_acc(q8, 5121, 'VEC4', 34962)}
    j['accessors'][attrs['COLOR_0']]['normalized'] = True
    j['accessors'][attrs['WEIGHTS_0']]['normalized'] = True
    sp['attributes'] = attrs
    sp['indices'] = g.add_acc(F.astype(np.uint16).ravel(), 5123, 'SCALAR', 34963)
    sn['extras']['tiers'] = [t[0] for t in TIERS]
    print(f'  пачка: {len(TIERS)} яруса × {NS} × {NT} = {len(V)} вершин, {len(F)} треугольников (прорезь под хвост — {cut.sum()}); '
          f'пояс y={yt:.3f}, подолы {[t[0] for t in TIERS]} (было {yb0:.3f}); радиус нижнего подола {R_low.min():.3f}…{R_low.max():.3f}, '
          f'наружный габарит {np.hypot(V[:, 0] - c[0], V[:, 2] - c[2]).max():.3f}')


def main():
    src, dst = sys.argv[1:3]
    fl = set(sys.argv[3:])
    if '--all' in fl:
        fl |= {'--tutu', '--tail'}
    g = Glb(src)
    br = g.j['nodes'][node_by_name(g.j, 'Brows')]
    if 'ref1124' in br.get('extras', {}):
        sys.exit('glitter_ref2: уже применено (extras.ref1124)')
    ti = None
    if '--tail' in fl:
        ti = tail(g)
    if '--tutu' in fl:
        tutu(g, ti)
    br['extras']['ref1124'] = sorted(f.strip('-') for f in fl)
    n = g.save(dst)
    print(f'glitter_ref2: {dst} — {n} байт')


if __name__ == '__main__':
    main()

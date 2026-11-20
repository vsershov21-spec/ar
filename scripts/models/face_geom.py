#!/usr/bin/env python3
"""Правки лица и одежды основ p1 по рефам без новых генераций (20.11): нос меньше, без заколок Tripo у ушей Блёстки,
логотип «СБЕР» на худи Добряка.

  python3 scripts/models/face_geom.py <hooligan|kind|glitter> in.glb out.glb [--nose 0.78] [--clips] [--logo]

Вход — p1 после persona_tune.py --clean (docs/models/README.md); повторный запуск каждой правки отказывается
(пометки в extras узла Brows: noseScale, clipsRemoved, sberLogo).

--nose K — нос ×K вокруг своего центра с плавным спадом. Нос — розовые треугольники альбедо у точки лица `nose`;
  поле: внутри эллипсоида носа (полуоси по его вершинам ×1.15) — сжатие к центру ×K, дальше до 2× полуосей — плавный
  спад (smoothstep) до нуля. Отображение радиальное и монотонное вдоль каждого луча из центра — без складок (якобиан > 0,
  печатается). Применяется тем же кодом, что head_shape.py (apply_field): тело и оболочки меха (общий буфер позиций),
  все ключи (f(p+δ) − f(p): рот, щёки, морщинка у носа работают как раньше), нормали по якобиану, пряди, усы, MouthD,
  точки лица (nose, noseHalfW — маска носа в furTone.ts) и рамка рта (mouthRig).

--clips (Блёстка) — золотые полоски-заколки Tripo по краю головы у ушей (4 куска по 35–60 треугольников, золото
  альбедо выше глаз, кроме связного куска банта; звёзды BD_Metal_Stars — отдельный меш, не трогаются). Сетка Tripo —
  одна спаянная оболочка: заколки — часть поверхности головы, удаление оставило бы дыру. Поэтому кусок заменяется
  латкой той же топологии: внутренние вершины — бигармоническая поверхность по кольцу соседей (рельеф заколки уходит,
  кривизна головы продолжается), нормали — по новой сетке, ключи — тем же решением по дельтам; в атласе тексели
  латки (+2 px) — цвет меха с кольца вокруг (гармоническое продолжение по вершинам + шум), карта нормалей — плоская;
  латка добавляется в оболочки меха (BD_FurShell), длина меха — с кольца вокруг.

--logo (Добряк) — на груди худи вместо зелёного круга с галочкой (cat_look.py EMBLEM) — как на рефе design/cut/kind:
  зелёный контурный значок Сбера (кольцо с галочкой) и под ним надпись «СБЕР». Рисуется в пространстве модели
  (glb_io.raster_uv: тексель → точка на груди), круг закрашивается тканью вокруг; геометрия не меняется.

Текстуры, которые правка не трогает, не перекодируются; изменённый JPEG — с качеством, при котором файл не больше
исходного (+2 %).
"""
import io
import os
import sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from glb_io import Glb, raster_uv  # noqa: E402
from mesh_parts import tri_colors, hsv, weld, components  # noqa: E402


def sstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def brows_node(g):
    return next(n for n in g.j['nodes'] if n.get('name') == 'Brows')


# ───────────────────────── нос ─────────────────────────
class NoseField:
    """p → c + (p − c)·(1 − (1 − k)·w(r)), r — эллипсоидальное расстояние до центра носа (1 — край носа)"""

    def __init__(self, c, ax, k, fall=2.0):
        self.c, self.ax, self.k, self.fall = np.asarray(c, float), np.asarray(ax, float), k, fall

    def __call__(self, P):
        P = np.asarray(P, dtype=np.float64)
        one = P.ndim == 1
        P2 = P[None] if one else P
        q = P2 - self.c
        r = np.linalg.norm(q / self.ax, axis=1)
        w = 1 - sstep(1.0, self.fall, r)
        out = self.c + q * (1 - (1 - self.k) * w)[:, None]
        return out[0] if one else out

    def jac(self, P, h=1e-5):
        J = np.zeros((len(P), 3, 3))
        for k in range(3):
            e = np.zeros(3); e[k] = h
            J[:, :, k] = (self(P + e) - self(P - e)) / (2 * h)
        return J


def nose(g, cat, k):
    from head_shape import apply_field
    br = brows_node(g)
    if 'noseScale' in br['extras']:
        sys.exit(f'face_geom --nose: нос уже уменьшен (×{br["extras"]["noseScale"]})')
    mk = br['extras']['marks']
    D = float(np.linalg.norm(np.array(mk['eyeOuterL']) - np.array(mk['eyeOuterR'])))
    bi, b = g.main_mesh()
    P = g.acc(b['attributes']['POSITION']).astype(np.float64)
    I = g.acc(b['indices']).reshape(-1, 3).astype(np.int64)
    h, s, v = hsv(tri_colors(g, b, I))
    pink = ((h > 318) | (h < 12)) & (s > 0.12) & (s < 0.6) & (v > 0.45)
    n0 = np.array(mk['nose']); hw = mk['noseHalfW']
    C = P[I].mean(1)
    near = np.linalg.norm((C - n0) / np.array([2.2 * hw, 1.8 * hw, 2.2 * hw]), axis=1) < 1
    T = I[pink & near]
    if len(T) < 10:
        sys.exit(f'face_geom --nose: розовых треугольников носа {len(T)} — разметка лица не та')
    X = P[np.unique(T)]
    lo, hi = X.min(0), X.max(0)
    c = (lo + hi) / 2
    # центр — немного вглубь головы (за поверхностью носа): нос «втягивается», а не только сжимается по фронту
    c[2] -= 0.25 * (hi[2] - lo[2])
    ax = np.maximum((hi - lo) / 2 * 1.15, 0.5 * hw)
    ax[2] = max(ax[2], 0.8 * hw) + 0.25 * (hi[2] - lo[2])
    F = NoseField(c, ax, k)
    near_v = np.linalg.norm((P - c) / ax, axis=1) < 2.2
    Jd = np.linalg.det(F.jac(P[near_v]))
    print(f'{cat}: нос — {len(T)} треугольников, центр {np.round(c, 4)}, полуоси {np.round(ax, 4)} (≈ {np.round(ax / D, 3)} D), '
          f'×{k}; вершин в поле {near_v.sum()}, якобиан {Jd.min():.3f}…{Jd.max():.3f}')
    assert Jd.min() > 0.2
    apply_field(g, F, D, 1.0, ('noseScale', k))
    print(f'  noseHalfW {hw:.4f} → {br["extras"]["marks"]["noseHalfW"]:.4f}')


# ───────────────────────── общее: решения на графе сетки ─────────────────────────
def lap_matrix(nW, T):
    from scipy.sparse import coo_matrix, diags
    e = np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]])
    e = np.concatenate([e, e[:, ::-1]])
    A = coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(nW, nW)).tocsr()
    A.data[:] = 1
    d = np.asarray(A.sum(1)).ravel()
    return diags(d) - A, d


def solve_patch(L2, inner, fixed, vals):
    """значения на inner из L2 x = 0 при заданных на fixed (vals: nW × k)"""
    from scipy.sparse.linalg import spsolve
    A = L2[inner][:, inner].tocsc()
    rhs = -L2[inner][:, fixed] @ vals[fixed]
    out = vals.copy()
    sol = spsolve(A, rhs)
    out[inner] = sol.reshape(len(inner), -1) if sol.ndim == 1 and vals.ndim > 1 else sol
    return out


def set_target(g, ai, arr):
    """дельты ключа: sparse остаётся sparse (только ненулевые вершины), как head_shape.apply_field"""
    j = g.j
    acc = j['accessors'][ai]
    if 'sparse' not in acc and 'bufferView' in acc:
        g.set_acc(ai, arr.astype(np.float32)); return
    arr = arr.astype(np.float32)
    nz = np.where(np.abs(arr).max(1) > 1e-7)[0]
    new = {'componentType': 5126, 'count': int(acc['count']), 'type': acc['type'], 'min': arr.min(0).tolist(), 'max': arr.max(0).tolist()}
    if len(nz):
        ii = g.add_acc(nz.astype(np.uint32), 5125, 'SCALAR'); vv = g.add_acc(arr[nz], 5126, acc['type'])
        new['sparse'] = {'count': int(len(nz)), 'indices': {'bufferView': j['accessors'][ii]['bufferView'], 'componentType': 5125},
                         'values': {'bufferView': j['accessors'][vv]['bufferView']}}
        j['accessors'].pop(); j['accessors'].pop()
    j['accessors'][ai] = new


def flatten_patches(PW, WI, inner_mask, L):
    """рельеф латок прочь: по каждой связной латке — локальная система (центр, нормаль по кольцу), высота головы —
    квадрика по вершинам вокруг (до 1.8 радиуса латки, без латки); внутренние вершины: касательные координаты сглажены
    (Лаплас с закреплённым кольцом, 30 шагов — без вырожденных треугольников стенок), высота — по квадрике"""
    from scipy.sparse.csgraph import connected_components
    nW = len(PW)
    inner = np.where(inner_mask)[0]
    A = (L != 0).astype(np.int8).tocsr()
    sub = A[inner][:, inner]
    nc, lab = connected_components(sub, directed=False)
    out = PW.copy()
    deg = np.asarray(A.sum(1)).ravel() - 1  # L: диагональ — степень, вне — −1
    for k in range(nc):
        vi = inner[lab == k]
        # кольцо: соседи латки вне её
        nb = np.unique(A[vi].indices)
        ring = np.setdiff1d(nb, vi)
        c = PW[vi].mean(0)
        rad = np.percentile(np.linalg.norm(PW[ring] - c, axis=1), 75)
        far = np.where(~inner_mask & (np.linalg.norm(PW - c, axis=1) < 1.6 * rad))[0]
        # нормаль — главная ось наименьшей дисперсии точек вокруг
        X = PW[far] - c
        _, _, Vt = np.linalg.svd(X - X.mean(0), full_matrices=False)
        n = Vt[2]
        if np.dot(n, c - PW.mean(0)) < 0:
            n = -n
        t1 = Vt[0]; t2 = np.cross(n, t1)
        def loc(Y):
            d = Y - c
            return d @ t1, d @ t2, d @ n
        x, y, z = loc(PW[far])
        M = np.stack([np.ones_like(x), x, y, x * x, x * y, y * y], 1)
        ok = np.ones(len(z), bool)
        for _ in range(4):  # без выбросов (ухо, бант, глаз рядом)
            coef, *_ = np.linalg.lstsq(M[ok], z[ok], rcond=None)
            r_ = np.abs(z - M @ coef)
            ok = r_ < max(3 * np.median(r_[ok]), 0.0015)
        # касательные координаты: сглаживание с закреплённым кольцом
        xy = np.zeros((nW, 2))
        allv = np.union1d(vi, ring)
        lx, ly, _ = loc(PW[allv])
        xy[allv, 0] = lx; xy[allv, 1] = ly
        for _ in range(30):
            S_ = A[vi] @ xy - xy[vi]  # сумма соседей (A с диагональю: вычесть себя)
            xy[vi] = 0.5 * xy[vi] + 0.5 * S_ / np.maximum(deg[vi], 1)[:, None]
        xx, yy = xy[vi, 0], xy[vi, 1]
        zz = np.stack([np.ones_like(xx), xx, yy, xx * xx, xx * yy, yy * yy], 1) @ coef
        out[vi] = c + xx[:, None] * t1 + yy[:, None] * t2 + zz[:, None] * n
        res = (z - M @ coef)[ok]
        print(f'    латка {k}: {len(vi)} вершин, радиус {rad * 1000:.0f} мм, квадрика головы по {ok.sum()}/{len(z)} точкам — '
              f'отклонение {np.median(np.abs(res)) * 1000:.1f}…{np.abs(res).max() * 1000:.1f} мм')
    return out


def jpeg_fit(g, ii, img, ref_bytes):
    """изменённая картинка JPEG: качество, при котором байтов не больше исходного (+2 %)"""
    for q in (92, 90, 88, 86, 85, 84, 82, 80):
        buf = io.BytesIO(); img.convert('RGB').save(buf, 'JPEG', quality=q, optimize=True)
        if buf.tell() <= ref_bytes * 1.02:
            break
    g.set_image(ii, img.convert('RGB'))
    g.j['images'][ii]['mimeType'] = 'image/jpeg'
    g.j['images'][ii].setdefault('extras', {})['requant'] = q
    return q, buf.tell()


def img_bytes(g, ii):
    return g.j['bufferViews'][g.j['images'][ii]['bufferView']]['byteLength']


# ───────────────────────── заколки Блёстки ─────────────────────────
def clips(g, cat):
    from scipy.ndimage import binary_dilation
    j = g.j
    br = brows_node(g)
    if br['extras'].get('clipsRemoved'):
        sys.exit('face_geom --clips: заколки уже убраны')
    bi, b = g.main_mesh()
    A = b['attributes']
    P = g.acc(A['POSITION']).astype(np.float64)
    N = g.acc(A['NORMAL']).astype(np.float64)
    UV = g.acc(A['TEXCOORD_0']).astype(np.float64)
    I = g.acc(b['indices']).reshape(-1, 3).astype(np.int64)
    eyeY = br['extras']['marks']['eyeOuterL'][1]
    h, s, v = hsv(tri_colors(g, b, I))
    C = P[I].mean(1)
    gold = (h > 25) & (h < 65) & (s > 0.25) & (v > 0.45) & (C[:, 1] > eyeY - 0.03)
    w = weld(P)
    WI = w[I]
    comp = components(w.max() + 1, WI[gold])
    tg = np.where(gold)[0]
    tc = comp[WI[tg, 0]]
    ids, cnt = np.unique(tc, return_counts=True)
    # бант — самый большой связный кусок золота; заколки — мелкие куски по бокам головы
    keep = [i for i, c in zip(ids, cnt) if c < 0.5 * cnt.max() and abs(C[tg[tc == i]].mean(0)[0]) > 0.08]
    clip_t = tg[np.isin(tc, keep)]
    # вместе с соседними треугольниками, золотыми хотя бы частично (край заколки в альбедо)
    gv = np.zeros(w.max() + 1, bool); gv[WI[clip_t].ravel()] = True
    ring_t = np.where(gv[WI].any(1) & ~np.isin(np.arange(len(I)), clip_t) & (h > 20) & (h < 70) & (s > 0.15))[0]
    clip_t = np.union1d(clip_t, ring_t)
    # рельеф заколки (бортики звезды, тени у основания) — ещё --clip-grow колец треугольников вокруг: латка целиком
    # покрывает выпуклость, кольцо фиксированных вершин лежит уже на голове
    grow = int(sys.argv[sys.argv.index('--clip-grow') + 1]) if '--clip-grow' in sys.argv else 2
    for _ in range(grow):
        gv = np.zeros(w.max() + 1, bool); gv[WI[clip_t].ravel()] = True
        clip_t = np.where(gv[WI].any(1))[0]
    print(f'{cat}: заколки — {len(keep)} кусков, {len(clip_t)} треугольников ({", ".join(str(c) for i, c in zip(ids, cnt) if i in keep)})')
    nW = w.max() + 1
    inner_mask = np.zeros(nW, bool)
    cv = np.unique(WI[clip_t])
    other = np.setdiff1d(np.arange(len(I)), clip_t)
    on_other = np.zeros(nW, bool); on_other[WI[other].ravel()] = True
    inner_mask[cv] = ~on_other[cv]
    # у банта (1.5 см от его треугольников) сетка не двигается: бант и мех под ним как были
    from scipy.spatial import cKDTree
    bow_t = tg[tc == ids[cnt.argmax()]]
    first0 = np.full(nW, -1); first0[w[::-1]] = np.arange(len(w))[::-1]
    db0, _ = cKDTree(P[I[bow_t]].mean(1)).query(P[first0])
    inner_mask &= db0 > 0.015
    inner = np.where(inner_mask)[0]
    # фиксированы — все прочие (в т.ч. кольцо вокруг): бигармоника по графу сетки
    L, deg = lap_matrix(nW, WI)
    L2 = (L @ L).tocsr()
    fixed = np.where(~inner_mask)[0]
    # позиции по спаянным вершинам (первая копия)
    first = np.full(nW, -1); first[w[::-1]] = np.arange(len(w))[::-1]
    PW = P[first]
    PW2 = flatten_patches(PW, WI, inner_mask, L)
    disp = np.linalg.norm(PW2[inner] - PW[inner], axis=1)
    print(f'  латка: {len(inner)} внутренних вершин, рельеф заколок снят — сдвиг до {disp.max() * 1000:.1f} мм (медиана {np.median(disp) * 1000:.1f})')
    P2 = PW2[w]
    g.set_acc(A['POSITION'], P2.astype(np.float32))
    # нормали латки и кольца — по новой сетке (площадные)
    fn = np.cross(P2[I[:, 1]] - P2[I[:, 0]], P2[I[:, 2]] - P2[I[:, 0]])
    NW = np.zeros((nW, 3))
    for kk in range(3):
        np.add.at(NW, WI[:, kk], fn)
    NW /= np.maximum(np.linalg.norm(NW, axis=1, keepdims=True), 1e-12)
    upd = np.zeros(nW, bool); upd[cv] = True
    sel = upd[w]
    N[sel] = NW[w[sel]]
    g.set_acc(A['NORMAL'], N.astype(np.float32))
    # ключи: дельты латки — тем же решением (у Tripo у висков они нулевые — останутся нулями)
    nt = 0
    for t in b.get('targets', []):
        dl = g.acc(t['POSITION']).astype(np.float64)
        if np.abs(dl[np.isin(w, cv)]).max() < 1e-7:
            continue
        DW = solve_patch(L2, inner, fixed, dl[first])
        dl[np.isin(w, inner)] = DW[w[np.isin(w, inner)]]
        set_target(g, t['POSITION'], dl)
        nt += 1
    print(f'  ключей с дельтами у заколок: {nt}')
    # ── атлас: альбедо латки — цвет меха с кольца вокруг, карта нормалей — плоская ──
    mat = j['materials'][b['material']]
    ib = j['textures'][mat['pbrMetallicRoughness']['baseColorTexture']['index']]['source']
    inn = j['textures'][mat['normalTexture']['index']]['source']
    base = np.asarray(g.image(ib).convert('RGB')).astype(np.float32)
    S = base.shape[0]
    # цвет латки — мех вокруг в 3D: тексели меха (синий тон альбедо) соседних треугольников в 3 см от заколок;
    # тексель латки = смесь среднего 16 ближайших (тон) и одного из них (зерно меха)
    from scipy.spatial import cKDTree
    from scipy.ndimage import distance_transform_edt
    cc0 = P2[I[clip_t]].mean(1)
    tc_ = cKDTree(cc0)
    dn, _ = tc_.query(P2[I].mean(1))
    around = np.where((dn < 0.03) & ~np.isin(np.arange(len(I)), clip_t))[0]
    pos_a, _, tid_a = raster_uv(P2, N, UV, I[around], S)
    ma = tid_a >= 0
    ha, sa, va = hsv(base[ma])
    furm = (ha > 195) & (ha < 265) & (sa > 0.12) & (sa < 0.6) & (va > 0.35)
    fpos = pos_a[ma][furm]; fcol = base[ma][furm]
    print(f'  мех у заколок: {len(fcol)} текселей вокруг, тон {np.round(np.median(fcol, 0)).astype(int)}')
    ftree = cKDTree(fpos)
    pos2, _, tid2 = raster_uv(P2, N, UV, I[clip_t], S)
    m0 = tid2 >= 0
    m = binary_dilation(m0, iterations=2)
    # дилатация: позиция ближайшего заполненного текселя латки
    _, (iy, ix) = distance_transform_edt(~m0, return_indices=True)
    pp = pos2[iy, ix][m]
    dd, qq = ftree.query(pp, k=16)
    rng = np.random.default_rng(7)
    avg = np.median(fcol[qq], axis=1)
    one = fcol[qq[np.arange(len(qq)), rng.integers(0, 16, len(qq))]]
    cc = 0.85 * avg + 0.15 * one
    edge = binary_dilation(m, iterations=2) & ~m
    base[m] = np.clip(cc, 0, 255)
    # мягкий шов: кромка 2 px — среднее с соседями
    if edge.any():
        from scipy.ndimage import uniform_filter
        bl = np.stack([uniform_filter(base[..., c], 5) for c in range(3)], -1)
        base[edge] = 0.5 * base[edge] + 0.5 * bl[edge]
    qb, nb = jpeg_fit(g, ib, Image.fromarray(np.clip(base, 0, 255).astype(np.uint8)), img_bytes(g, ib))
    nmap = np.asarray(g.image(inn).convert('RGB')).astype(np.float32)
    Sn = nmap.shape[0]
    mn = np.asarray(Image.fromarray((m * 255).astype(np.uint8)).resize((Sn, Sn), Image.BILINEAR)).astype(np.float32)[..., None] / 255
    nmap = nmap * (1 - mn) + np.array([128, 128, 255], np.float32) * mn
    qn, nn = jpeg_fit(g, inn, Image.fromarray(np.clip(nmap, 0, 255).astype(np.uint8)), img_bytes(g, inn))
    # металличность/шероховатость: у заколок — металл (без карты окружения — тёмное пятно), латке — как у меха вокруг
    imr = j['textures'][mat['pbrMetallicRoughness']['metallicRoughnessTexture']['index']]['source']
    mr = np.asarray(g.image(imr).convert('RGB')).astype(np.float32)
    Sm = mr.shape[0]
    mfur = np.asarray(Image.fromarray((ma * 255).astype(np.uint8)).resize((Sm, Sm), Image.NEAREST)) > 0
    hfur = np.zeros((S, S), bool); hfur[np.where(ma)] = furm
    hfur = np.asarray(Image.fromarray((hfur * 255).astype(np.uint8)).resize((Sm, Sm), Image.NEAREST)) > 0
    mr_fur = np.median(mr[mfur & hfur], axis=0)
    mm = mn[..., 0] if Sm == Sn else np.asarray(Image.fromarray((m * 255).astype(np.uint8)).resize((Sm, Sm), Image.BILINEAR)).astype(np.float32) / 255
    mr = mr * (1 - mm[..., None]) + mr_fur[None, None, :] * mm[..., None]
    qm, nmr = jpeg_fit(g, imr, Image.fromarray(np.clip(mr, 0, 255).astype(np.uint8)), img_bytes(g, imr))
    print(f'  атлас: {int(m.sum())} текселей латки; альбедо JPEG q{qb} ({nb} байт), нормали q{qn} ({nn} байт), '
          f'металл/шероховатость → как у меха {mr_fur.round().astype(int)} q{qm} ({nmr} байт)')
    # оболочки меха: латка — в BD_FurShell (общий буфер позиций), длина — с кольца
    sh = next((n for n in j['nodes'] if 'mesh' in n and j['meshes'][n['mesh']]['name'] == 'BD_FurShell'), None)
    if sh is not None:
        pr = j['meshes'][sh['mesh']]['primitives'][0]
        Ish = g.acc(pr['indices']).reshape(-1, 3).astype(np.int64)
        Lf = g.acc(pr['attributes']['_FURLEN']).astype(np.float64).reshape(len(P), -1)
        add = I[clip_t]
        have = {tuple(sorted(t)) for t in Ish.tolist()}
        add = np.array([t for t in add.tolist() if tuple(sorted(t)) not in have], np.int64).reshape(-1, 3)
        # длина меха латки — как у меха головы вокруг (вершины оболочек в 4 см, длина > 2 мм; у самих заколок было 0)
        shv = np.unique(Ish)
        okv = shv[(~np.isin(w[shv], cv)) & (Lf[shv].max(1) > 0.002)]
        tl = cKDTree(P2[okv])
        sel = np.isin(w, cv)
        dl_, ql_ = tl.query(P2[sel], k=12, distance_upper_bound=0.04)
        val = np.where(np.isfinite(dl_), 1, 0)
        ql_ = np.minimum(ql_, len(okv) - 1)
        wl_ = val / np.maximum(dl_, 1e-4) * np.isfinite(dl_)
        wl_ = np.nan_to_num(wl_)
        Lnew = (Lf[okv][ql_] * wl_[..., None]).sum(1) / np.maximum(wl_.sum(1, keepdims=True), 1e-9)
        # у банта (2 см от его треугольников) — как было: мех не врастает в бант; кольцо латки — не меньше прежней длины
        db, _ = cKDTree(P2[I[bow_t]].mean(1)).query(P2[sel])
        Lnew[db < 0.02] = 0
        Lf[sel] = np.maximum(Lf[sel], Lnew)
        g.set_acc(pr['attributes']['_FURLEN'], Lf.astype(np.float32).reshape(g.acc(pr['attributes']['_FURLEN']).shape))
        ct = j['accessors'][pr['indices']]['componentType']
        newI = np.concatenate([Ish, add]).ravel()
        pr['indices'] = g.add_acc(newI.astype(np.uint16 if ct == 5123 else np.uint32), ct, 'SCALAR', 34963)
        print(f'  мех: латка в оболочках (+{len(add)} треугольников), длина меха {np.round(Lf[np.isin(w, cv)].mean(0), 4)}')
    # звёзды-заколки (persona_tune.add_stars) стоят над прежней поверхностью — сдвиг вместе с ней (каждая звезда целиком)
    st = next((n for n in j['nodes'] if n.get('name') == 'BD_Metal_Stars'), None)
    if st is not None:
        pr = j['meshes'][st['mesh']]['primitives'][0]
        SV = g.acc(pr['attributes']['POSITION']).astype(np.float64)
        dP = P2 - P
        tb = cKDTree(P)
        mv = []
        for k0 in range(0, len(SV), 60):  # звезда — 20 треугольников по 3 своих вершины
            _, q = tb.query(SV[k0:k0 + 60].mean(0), k=6)
            d = dP[q].mean(0)
            SV[k0:k0 + 60] += d
            mv.append(np.linalg.norm(d) * 1000)
        g.set_acc(pr['attributes']['POSITION'], SV.astype(np.float32))
        print(f'  звёзды: сдвиг с поверхностью {", ".join(f"{x:.1f}" for x in mv)} мм')
    br['extras']['clipsRemoved'] = int(len(clip_t))


# ───────────────────────── логотип Сбера на худи Добряка ─────────────────────────
SBER_GREEN = np.array([33, 160, 56], np.float32)
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
# центр старой эмблемы (cat_look.py EMBLEM['kind']) и её радиус; закраска — круг R_ERASE
LOGO = {'kind': {'c': (0.0725, 0.4525), 'r_old': 0.025, 'r_erase': 0.032,
                 'icon_r': 0.0135, 'icon_dy': 0.0095, 'text_h': 0.0125, 'text_w': 0.052, 'gap': 0.003, 'lw': 0.0029}}


def logo_image(spec, px=4000):
    """значок и надпись в плоскости груди: картинка px×px на квадрат 2·r_erase вокруг центра (y вверх → строка 0)"""
    R = spec['r_erase']
    sc = px / (2 * R)
    im = Image.new('L', (px, px), 0)
    dr = ImageDraw.Draw(im)
    cx = cy = px / 2
    to = lambda x, y: (cx + x * sc, cy - y * sc)
    # значок: кольцо (разрыв справа сверху — туда выходит галочка, как у логотипа Сбера) + галочка
    ir = spec['icon_r']; iy = spec['icon_dy']; lw = spec['lw'] * sc
    x0, y0 = to(-ir, iy + ir); x1, y1 = to(ir, iy - ir)
    dr.arc([x0, y0, x1, y1], start=-20, end=300, fill=255, width=int(lw))
    pts = [to(-0.48 * ir, iy + 0.02 * ir), to(-0.08 * ir, iy - 0.36 * ir), to(0.95 * ir, iy + 0.55 * ir)]
    dr.line(pts, fill=255, width=int(lw * 1.05), joint='curve')
    for p in (pts[0], pts[-1]):
        dr.ellipse([p[0] - lw / 2, p[1] - lw / 2, p[0] + lw / 2, p[1] + lw / 2], fill=255)
    # надпись: подбор кегля по ширине и высоте
    txt = 'СБЕР'
    ty = iy - ir - spec['gap'] - spec['text_h'] / 2
    for size in range(400, 20, -4):
        f = ImageFont.truetype(FONT, size)
        bb = dr.textbbox((0, 0), txt, font=f)
        if bb[2] - bb[0] <= spec['text_w'] * sc and bb[3] - bb[1] <= spec['text_h'] * sc:
            break
    tx, tyy = to(0, ty)
    dr.text((tx - (bb[2] + bb[0]) / 2, tyy - (bb[3] + bb[1]) / 2), txt, font=f, fill=255)
    return np.asarray(im).astype(np.float32) / 255, sc


def logo(g, cat):
    from glb_io import raster_uv
    j = g.j
    br = brows_node(g)
    if br['extras'].get('sberLogo'):
        sys.exit('face_geom --logo: логотип уже нарисован')
    spec = LOGO[cat]
    bi, b = g.main_mesh()
    A = b['attributes']
    P = g.acc(A['POSITION']).astype(np.float64)
    N = g.acc(A['NORMAL']).astype(np.float64)
    UV = g.acc(A['TEXCOORD_0']).astype(np.float64)
    I = g.acc(b['indices']).reshape(-1, 3).astype(np.int64)
    cx, cy = spec['c']
    R = spec['r_erase']
    # только треугольники груди у эмблемы (растеризация всего атласа не нужна)
    C = P[I].mean(1)
    near = (np.abs(C[:, 0] - cx) < R * 1.6) & (np.abs(C[:, 1] - cy) < R * 1.6) & (C[:, 2] > 0.05)
    mat = j['materials'][b['material']]
    ib = j['textures'][mat['pbrMetallicRoughness']['baseColorTexture']['index']]['source']
    base = np.asarray(g.image(ib).convert('RGB')).astype(np.float32)
    S = base.shape[0]
    pos, nrm, tid = raster_uv(P, N, UV, I[near], S)
    has = tid >= 0
    front = has & (pos[..., 2] > 0.08) & ((nrm[..., 2] > 0.2) | (pos[..., 2] > 0.11))
    x, y = pos[..., 0], pos[..., 1]
    dc = np.hypot(x - cx, y - cy)
    aa = 0.0008
    erase = (1 - sstep(R - aa, R + aa, dc)) * front
    # закраска круга — настоящей тканью: тексель круга (точка p на груди) берёт альбедо и карту нормалей у текселя груди
    # в точке p + сдвиг к середине груди на 2.1 R (та же панель худи, тот же масштаб плетения в атласе) (та же ткань худи, с плетением; под старой эмблемой нормали были плоские)
    from scipy.spatial import cKDTree
    green = (base[..., 1] > base[..., 0] + 25) & (base[..., 1] > base[..., 2] + 10)
    inn = j['textures'][mat['normalTexture']['index']]['source']
    nmap = np.asarray(g.image(inn).convert('RGB')).astype(np.float32)
    Sn = nmap.shape[0]
    # тексели-доноры: перед груди левее круга, только ткань (без шнурков и швов — по цвету), вне круга и без зелёного (растеризация треугольников ниже)
    near2 = (C[:, 0] < cx - R * 0.6) & (C[:, 0] > cx - R * 3.6) & (np.abs(C[:, 1] - cy) < R * 1.6) & (C[:, 2] > 0.05)
    pos_d, nrm_d, tid_d = raster_uv(P, N, UV, I[near2], S)
    don = (tid_d >= 0) & (nrm_d[..., 2] > 0.2) & ~green
    don &= np.hypot(pos_d[..., 0] - cx, pos_d[..., 1] - cy) > R * 1.1
    ring0 = front & (dc > R * 1.03) & (dc < R * 1.35) & ~green
    don &= np.linalg.norm(base - np.median(base[ring0], axis=0), axis=-1) < 14
    dy_, dx_ = np.where(don)
    tree = cKDTree(pos_d[don][:, :2])
    tgt = np.where(erase > 0)
    q_ = np.stack([x[tgt] - 2.1 * R, y[tgt]], 1)
    _, k_ = tree.query(q_)
    src_y, src_x = dy_[k_], dx_[k_]
    e_ = erase[tgt][:, None]
    # тон доноров — к тону ткани вокруг круга (сбоку ткань светлее: запечённый свет Tripo)
    ring = ring0
    don_c = base[src_y, src_x]
    don_c = don_c - np.median(don_c, axis=0) + np.median(base[ring], axis=0)
    base[tgt] = base[tgt] * (1 - e_) + don_c * e_
    fy_ = Sn / S
    ny_, nx_ = (tgt[0] * fy_).astype(int), (tgt[1] * fy_).astype(int)
    nmap[ny_, nx_] = nmap[ny_, nx_] * (1 - e_) + nmap[(src_y * fy_).astype(int), (src_x * fy_).astype(int)] * e_
    cloth = np.median(base[src_y, src_x], axis=0)
    # металл/шероховатость под старым кругом (глянцевая эмблема) — тоже от ткани-донора
    imr = j['textures'][mat['pbrMetallicRoughness']['metallicRoughnessTexture']['index']]['source']
    mr = np.asarray(g.image(imr).convert('RGB')).astype(np.float32)
    fm = mr.shape[0] / S
    my_, mx_ = (tgt[0] * fm).astype(int), (tgt[1] * fm).astype(int)
    mr[my_, mx_] = mr[my_, mx_] * (1 - e_) + mr[(src_y * fm).astype(int), (src_x * fm).astype(int)] * e_
    # значок и надпись
    L, sc = logo_image(spec)
    px = L.shape[0]
    u = np.clip(((x - cx) * sc + px / 2).astype(int), 0, px - 1)
    vv = np.clip((-(y - cy) * sc + px / 2).astype(int), 0, px - 1)
    # суперсэмплинг: картинка в 4000 px на 57 мм ≈ 14 px на тексель — берём среднее окна вокруг
    from scipy.ndimage import uniform_filter
    tex_px = 1 / max(np.median(np.hypot(np.gradient(x, axis=1), np.gradient(y, axis=1))[front & (erase > 0.5)]), 1e-6)
    win = max(1, int(sc / tex_px))
    Lb = uniform_filter(L, win)
    a = Lb[vv, u] * front * (dc < R)
    col = SBER_GREEN[None, None, :] * (1.04 - 0.1 * np.clip((y - cy) / R, -1, 1))[..., None]
    base = base * (1 - a[..., None]) + col * a[..., None]
    # нормали вершин: у Tripo под эмблемой — плоская площадка (нормали «в лоб», светлее груди вокруг — круг виден и
    # без эмблемы); сглаживание нормалей груди в 1.4 R (Лаплас по сетке, 20 шагов, снаружи закреплено)
    w = weld(P)
    WI = w[I]
    nW = w.max() + 1
    from scipy.sparse import coo_matrix
    e = np.concatenate([WI[:, [0, 1]], WI[:, [1, 2]], WI[:, [2, 0]]]); e = np.concatenate([e, e[:, ::-1]])
    Adj = coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(nW, nW)).tocsr(); Adj.data[:] = 1
    first = np.full(nW, -1); first[w[::-1]] = np.arange(len(w))[::-1]
    NW = N[first].copy(); PWp = P[first]
    dW = np.hypot(PWp[:, 0] - cx, PWp[:, 1] - cy)
    mov = (dW < 1.4 * R) & (PWp[:, 2] > 0.05)
    degW = np.asarray(Adj.sum(1)).ravel()
    for _ in range(20):
        avg = (Adj @ NW) / np.maximum(degW, 1)[:, None]
        NW[mov] = avg[mov]
        NW /= np.maximum(np.linalg.norm(NW, axis=1, keepdims=True), 1e-9)
    selv = mov[w]
    N2 = N.copy(); N2[selv] = NW[w[selv]]
    g.set_acc(A['NORMAL'], N2.astype(np.float32))
    print(f'  нормали груди под эмблемой сглажены: {int(mov.sum())} вершин')
    q, nb = jpeg_fit(g, ib, Image.fromarray(np.clip(base, 0, 255).astype(np.uint8)), img_bytes(g, ib))
    qn, nn = jpeg_fit(g, inn, Image.fromarray(np.clip(nmap, 0, 255).astype(np.uint8)), img_bytes(g, inn))
    qm, nm_ = jpeg_fit(g, imr, Image.fromarray(np.clip(mr, 0, 255).astype(np.uint8)), img_bytes(g, imr))
    print(f'  карта нормалей: плетение ткани под старым кругом, JPEG q{qn} ({nn} байт); металл/шероховатость q{qm} ({nm_} байт)')
    print(f'{cat}: логотип СБЕР — значок R {spec["icon_r"] * 1000:.1f} мм, надпись {spec["text_w"] * 1000:.0f}×{spec["text_h"] * 1000:.1f} мм, '
          f'круг-галочка закрашен (R {R * 1000:.1f} мм, ткань {cloth.round().astype(int)}), текселей {int((erase > 0.5).sum())}; '
          f'альбедо JPEG q{q} ({nb} байт)')
    br['extras']['sberLogo'] = 1


def main():
    cat, src, dst = sys.argv[1:4]
    g = Glb(src)
    if '--nose' in sys.argv:
        nose(g, cat, float(sys.argv[sys.argv.index('--nose') + 1]))
    if '--clips' in sys.argv:
        clips(g, cat)
    if '--logo' in sys.argv:
        logo(g, cat)
    n = g.save(dst)
    if '--clips' in sys.argv:
        # оболочки меха латки у банта: задевающие одежду/бант в покое — длина 0 (как persona_tune --clean)
        from persona_tune import prune_cards
        prune_cards(cat, dst, dst)
        n = os.path.getsize(dst)
    print(f'{cat}: {dst} — {n} байт (было {os.path.getsize(src)})')


if __name__ == '__main__':
    main()

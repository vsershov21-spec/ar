#!/usr/bin/env python3
"""Развести проникновения в позе покоя (сплошная сетка Tripo: одежда спаяна с телом, местами режет его или себя).

  python3 scripts/models/untangle.py <cat> in.glb out.glb [--iters 40]

Порядок слоёв (кто снаружи): тело < худи, обувь < юбка, кепка < шарф, бант < наушники. Для каждой пары
пересекающихся треугольников (penetration.tri_pairs_intersect, без смежных):
  • разные слои — вершины внутреннего, оказавшиеся перед плоскостью наружного, уходят за неё (−n·ε), вершины
    наружного за плоскостью внутреннего — вперёд (+n·ε);
  • один слой (складка сама в себя) — вершины каждой стороны за плоскостью другой — вперёд (раскрыть складку).
Сдвиг размазывается по соседям (гаусс по расстоянию в позе покоя, радиус ~6 мм) — без зубцов; повтор до нуля.
Меняются только позиции (и нормали не трогаем: сдвиги < 3 мм); ключи — дельты, остаются как есть; кости, веса — те же.
"""
import sys
import numpy as np
from scipy.spatial import cKDTree
from glb_io import Glb
from mesh_parts import weld, label_parts, tri_label, PART_NAMES, BODY, CAP, HOODIE, PHONES, SCARF, BOW, SKIRT, SHOES
from penetration import tri_pairs_intersect

RANK = {BODY: 0, HOODIE: 1, SHOES: 1, SKIRT: 2, CAP: 2, SCARF: 3, BOW: 3, PHONES: 4}
EPS = 0.0008
STEP = 0.0015
MAXD = 0.010


def tri_normals(V, T):
    n = np.cross(V[T[:, 1]] - V[T[:, 0]], V[T[:, 2]] - V[T[:, 0]])
    return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)


def untangle(cat, g, prim, iters=120, log=print):
    P = g.acc(prim['attributes']['POSITION']).astype(np.float64)
    I = g.acc(prim['indices']).reshape(-1, 3).astype(np.int64)
    wl = weld(P)
    nW = wl.max() + 1
    rep = np.zeros(nW, np.int64); rep[wl] = np.arange(len(wl))
    lab_v = label_parts(cat, g, prim, P, I)
    TW = wl[I]
    lab_t = tri_label(lab_v[rep], TW)
    lab_w = lab_v[rep]

    Q = P[rep].copy()  # сшитые вершины
    Q0 = Q.copy()
    # голова (щёки, «баки», подбородок) лежит поверх воротника/капюшона и дуги наушников: для пар голова↔худи/наушники
    # снаружи — голова (ранг 5), иначе щёку пришлось бы вдавливать под воротник
    j = g.j
    sk = j['skins'][0]
    names = [j['nodes'][k]['name'].replace('mixamorig:', '') for k in sk['joints']]
    Jv = g.acc(prim['attributes']['JOINTS_0']).astype(np.int64); Wv = g.acc(prim['attributes']['WEIGHTS_0']).astype(np.float64)
    Wv /= 255 if Wv.max() > 1.5 else 1
    hw = (Wv * np.array([n.startswith('Head') for n in names])[Jv]).sum(1)
    head_t = (lab_t == BODY) & (hw[rep[TW]].mean(1) > 0.6)
    rank_t = np.array([RANK[l] for l in lab_t], dtype=np.float64)
    rank_t[head_t] = 5
    # юбка-пачка и бёдра под фатином (Блёстка) — складки раскрываем смелее
    maxd = np.where((lab_w == SKIRT) | ((cat == 'glitter') & (Q[:, 1] < 0.34) & (Q[:, 1] > 0.15)), 0.014, MAXD)
    # кромка воротника под щеками — можно опустить до 2 см
    maxd = np.where(np.isin(lab_w, [HOODIE, PHONES, SCARF]) & (hw[rep] > 0.05), 0.02, maxd)  # юбка-пачка — свободная ткань, складки раскрываем смелее
    E = np.r_[TW[:, [0, 1]], TW[:, [1, 2]], TW[:, [2, 0]]]
    nb = [[] for _ in range(nW)]
    for x, y in E:
        nb[x].append(y); nb[y].append(x)
    nb = [np.unique(v) for v in nb]

    def adj(a, b):
        A, B = TW[a], TW[b]
        return (A[:, :, None] == B[:, None, :]).any((1, 2))

    def find():
        pr = tri_pairs_intersect(Q, TW, Q, TW, adj)
        return pr[pr[:, 0] < pr[:, 1]]
    first = len(find())
    pairs = find()
    best = (len(pairs), Q.copy())
    for it in range(iters):
        if not len(pairs):
            break
        Nt = tri_normals(Q, TW)
        D = np.zeros((nW, 3)); K = np.zeros(nW)
        fold = set()
        for a, b in pairs:
            ra, rb = rank_t[a], rank_t[b]
            if ra == rb:
                # складка сама в себя — сгладить (раскрыть) кольцо вершин вокруг
                fold.update(np.r_[TW[a], TW[b]].tolist())
                continue
            inner, outer = (a, b) if ra < rb else (b, a)
            n = Nt[outer]; p0 = Q[TW[outer]].mean(0)
            if rank_t[outer] == 5 and lab_t[inner] in (HOODIE, PHONES, SCARF):
                # кромка воротника/дуга под щекой — опустить (вниз, не вдоль нормали щеки)
                for v in TW[inner]:
                    D[v] += np.array([0, -STEP, 0]); K[v] += 1
                continue
            for v in TW[inner]:
                sv = (Q[v] - p0) @ n
                if sv > -EPS:
                    D[v] -= n * min(sv + EPS, STEP); K[v] += 1
            n2 = Nt[inner]; p2 = Q[TW[inner]].mean(0)
            for v in TW[outer]:
                sv = (Q[v] - p2) @ n2
                if sv < EPS and (lab_w[v] != BODY or rank_t[outer] == 5):
                    D[v] += n2 * min(EPS - sv, STEP) * 0.5; K[v] += 1
        mv = np.where(K > 0)[0]
        Q[mv] += D[mv] / K[mv, None]
        # соседям — половина сдвига (без зубцов)
        for v in mv:
            for u in nb[v]:
                if K[u] == 0 and lab_w[u] == lab_w[v]:
                    Q[u] += 0.4 * D[v] / K[v] / max(1, len(nb[u]) / 6)
        fold = np.array(sorted(fold), dtype=np.int64)
        if len(fold):
            avg = np.array([Q[nb[v]].mean(0) for v in fold])
            st = 0.5 * (avg - Q[fold])
            ln = np.linalg.norm(st, axis=1, keepdims=True)
            Q[fold] += st * np.minimum(1, STEP / np.maximum(ln, 1e-12))
        # общий предел сдвига от исходного — 8 мм (дальше — не «развести», а перемоделировать)
        dd = Q - Q0
        ln = np.linalg.norm(dd, axis=1, keepdims=True)
        Q = Q0 + dd * np.minimum(1, maxd[:, None] / np.maximum(ln, 1e-12))
        pairs = find()
        if len(pairs) < best[0]:
            best = (len(pairs), Q.copy())
        elif len(pairs) > 1.5 * best[0] + 10 and it > 20:
            log(f'    шаг {it}: расходится ({len(pairs)}), беру лучший ({best[0]})')
            break
        if it % 5 == 0:
            log(f'    шаг {it}: пересечений {len(pairs)}, сдвиг слоёв {len(mv)}, складки {len(fold)}')
    if best[0] < len(pairs):
        Q = best[1]; pairs = find()
    # остаток — сгладить как складку (Лаплас по вершинам пар и их соседям), пока уменьшается
    for it2 in range(40):
        if not len(pairs):
            break
        fv = set()
        for a, b in pairs:
            for v in np.r_[TW[a], TW[b]]:
                fv.add(v); fv.update(nb[v].tolist())
        fv = np.array(sorted(fv))
        Qs = Q.copy()
        avg = np.array([Q[nb[v]].mean(0) for v in fv])
        st = 0.5 * (avg - Q[fv]); ln = np.linalg.norm(st, axis=1, keepdims=True)
        Q[fv] += st * np.minimum(1, 0.001 / np.maximum(ln, 1e-12))
        p2 = find()
        if len(p2) <= len(pairs):
            pairs = p2
        else:
            Q = Qs
            break
    # остаток «тело ↔ кромка худи/наушников» (щека или шея над воротником): кромку плавно опустить и чуть утопить
    cl_ = {HOODIE, PHONES, SCARF}
    for amt in (0.003, 0.006, 0.009, 0.012, 0.015):
        sp = [(a, b) for a, b in pairs if (lab_t[a] in cl_) != (lab_t[b] in cl_) and BODY in (lab_t[a], lab_t[b])]
        if not sp:
            break
        Cs = np.array([Q[TW[[a, b]]].mean((0, 1)) for a, b in sp])
        from scipy.cluster.hierarchy import fcluster, linkage
        lb = fcluster(linkage(Cs, 'single'), 0.02, 'distance') if len(Cs) > 1 else np.array([1])
        Qn = Q.copy()
        for u in np.unique(lb):
            c0 = Cs[lb == u].mean(0)
            d = np.linalg.norm(Q - c0, axis=1)
            w = np.clip(1 - d / 0.03, 0, 1) ** 2 * np.isin(lab_w, list(cl_))
            Qn[:, 1] -= amt * w
            Qn[:, [0, 2]] -= amt * 0.3 * w[:, None] * (Q[:, [0, 2]] - c0[[0, 2]]) / np.maximum(d[:, None], 1e-6)
        Qt, Q = Q, Qn
        p2 = find()
        if len(p2) < len(pairs):
            pairs = p2
        else:
            Q = Qt
    log(f'  untangle: {first} → {len(pairs)}')
    return Q[wl], first, len(pairs), pairs, TW


def drop_hidden(cat, g, prim, pairs, TW, log=print):
    """Блёстка: складки бёдер/остатков юбки под тремя слоями фатина (не видны) — треугольники-«щепки» убрать"""
    if not len(pairs):
        return 0
    I = g.acc(prim['indices']).reshape(-1, 3).astype(np.int64)
    P = g.acc(prim['attributes']['POSITION']).astype(np.float64)
    C = P[I].mean(1)
    tri = np.unique(pairs.ravel())
    if cat == 'glitter' and any(n.get('extras', {}).get('tulle') for n in g.j['nodes']):
        hid = (C[:, 1] > 0.17) & (C[:, 1] < 0.335) & (np.hypot(C[:, 0], C[:, 2]) < 0.2)
    else:
        hid = np.zeros(len(I), bool)
    # мелкие «щепки» (≤ 5 мм) на стыке щеки и воротника, оставшиеся после разведения: внутренняя из пары — прочь
    area = 0.5 * np.linalg.norm(np.cross(P[I[:, 1]] - P[I[:, 0]], P[I[:, 2]] - P[I[:, 0]]), axis=1)
    hid[tri[area[tri] < 1.2e-5]] = True
    tri = tri[hid[tri]]
    if not len(tri):
        return 0
    keep = np.ones(len(I), bool); keep[tri] = False
    newI = I[keep].ravel().astype(np.uint16 if len(P) < 65535 else np.uint32)
    ai = prim['indices']
    ni = g.add_acc(newI, 5123 if newI.dtype == np.uint16 else 5125, 'SCALAR', 34963)
    g.j['accessors'][ai] = g.j['accessors'][ni]; g.j['accessors'].pop()
    log(f'  под фатином убрано {len(tri)} треугольников-складок (не видны)')
    return len(tri)


def main():
    cat, src, dst = sys.argv[1:4]
    iters = int(sys.argv[sys.argv.index('--iters') + 1]) if '--iters' in sys.argv else 120
    g = Glb(src)
    bi, b = g.main_mesh()
    P0 = g.acc(b['attributes']['POSITION']).astype(np.float64)
    P1, n0, n1, pairs, TW = untangle(cat, g, b, iters)
    dmax = np.linalg.norm(P1 - P0, axis=1).max()
    print(f'{cat}: пересечений {n0} → {n1}, сдвиг ≤ {dmax * 1000:.1f} мм, вершин сдвинуто {(np.linalg.norm(P1 - P0, axis=1) > 1e-6).sum()}')
    g.set_acc(b['attributes']['POSITION'], P1.astype(np.float32))
    n1 -= drop_hidden(cat, g, b, pairs, TW) and 0
    if cat == 'glitter':
        from penetration import tri_pairs_intersect
        I2 = g.acc(b['indices']).reshape(-1, 3).astype(np.int64)
        from mesh_parts import weld as _w
        TW2 = _w(P1)[I2]
        pr = tri_pairs_intersect(P1, I2, P1, I2, lambda a, b_: (TW2[a][:, :, None] == TW2[b_][:, None, :]).any((1, 2)))
        n1 = int((pr[:, 0] < pr[:, 1]).sum())
    for n in g.j['nodes']:
        if n.get('name') == 'Brows':
            n['extras']['untangle'] = {'before': int(n0), 'after': int(n1)}
    g.save(dst)


if __name__ == '__main__':
    main()

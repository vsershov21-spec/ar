#!/usr/bin/env python3
"""Прокси столкновений для рантайма (src/character/bodyCollide.ts, формат — docs/animations/COLLISION.md):
руки останавливаются у поверхности головы, кепки, ушей, наушников, капюшона, шарфа, банта, юбки; «руки в карманах» — у входа.

  python3 scripts/models/colliders.py <cat> model.glb public/models/<cat>_colliders.json

Координаты — пространство модели в позе покоя (как GLB), кость — имя без mixamorig. Типы: ellipsoid (полуоси по осям
модели), capsule (a, b, r), hull (точки выпуклой оболочки). `mesh` — прокси активен, пока меш виден. `blend` — скин прокси
[[кость, вес], …] (шарф, наушники, запечённые в сетку тела: средние веса вершин детали у капсулы) — рантайм ведёт прокси
линейным скином, как ткань.
Голова — 2…98-й перцентиль вершин головы + 6 мм меха; кепка, бант, юбка-фатин — выпуклая оболочка (≤ 48 точек);
наушники — точно по детали headphones.py (чашки — капсулы по оси, дуга — цепочка капсул); шарф — кольцо капсул + хвост;
ноги — капсулы бедра/голени; карманы — сферы у боковых входов «кенгуру».
"""
import sys, json
import numpy as np
from glb_io import Glb
from mesh_parts import label_parts, BODY, CAP, HOODIE, PHONES, SCARF, BOW, SKIRT, SHOES


# запас сверх поверхности: точки руки в рантайме — оси костей (кисть/предплечье толщиной ~1.5 см с мехом),
# поэтому твёрдые детали у лица раздуты: наушники +8 мм, голова +10 мм (мех), остальное — по поверхности
PAD_HP, PAD_HEAD = 0.008, 0.010


def r5(a):
    return [round(float(x), 5) for x in np.ravel(a)]


def capsule(X, q=90):
    c = X.mean(0)
    u, s, vt = np.linalg.svd(X - c, full_matrices=False)
    ax = vt[0]
    t = (X - c) @ ax
    perp = np.linalg.norm((X - c) - t[:, None] * ax, axis=1)
    r = np.percentile(perp, q)
    t0, t1 = np.percentile(t, 3) + r * 0.6, np.percentile(t, 97) - r * 0.6
    if t1 < t0:
        t0 = t1 = (t0 + t1) / 2
    return c + ax * t0, c + ax * t1, r


def obb(X, lo=2, hi=98):
    c = X.mean(0)
    _, _, vt = np.linalg.svd(X - c, full_matrices=False)
    L = (X - c) @ vt.T
    a, b = np.percentile(L, lo, axis=0), np.percentile(L, hi, axis=0)
    cc = c + ((a + b) / 2) @ vt
    return cc, vt, (b - a) / 2


def ring(X, n=8):
    c = X.mean(0)
    _, _, vt = np.linalg.svd(X - c, full_matrices=False)
    e1, e2, nrm = vt[0], vt[1], vt[2]
    L = np.c_[(X - c) @ e1, (X - c) @ e2]
    # окружность (наименьшие квадраты): x² + y² + Dx + Ey + F = 0
    A = np.c_[L, np.ones(len(L))]
    sol = np.linalg.lstsq(A, -(L ** 2).sum(1), rcond=None)[0]
    cx, cy = -sol[0] / 2, -sol[1] / 2
    R = np.sqrt(max(cx * cx + cy * cy - sol[2], 1e-8))
    cc = c + cx * e1 + cy * e2
    # толщина трубки — 90-й перцентиль расстояния вершин до окружности в 3D (раньше: в плоскости + ½ разброса по нормали —
    # тоньше вязаного шарфа v1 на ~1,3 см: лапа у подбородка уходила в шарф, docs/qa/hands)
    hgt = (X - c) @ nrm
    tube = np.percentile(np.hypot(np.linalg.norm(L - [cx, cy], axis=1) - R, hgt - np.median(hgt)), 90)
    pts = [cc + R * (np.cos(a) * e1 + np.sin(a) * e2) for a in np.linspace(0, 2 * np.pi, n + 1)]
    return cc, nrm, R, tube, pts


def main():
    cat, path, out = sys.argv[1:4]
    g = Glb(path); j = g.j
    b, I = g.merged_body()  # тело + части одежды
    P = g.acc(b['attributes']['POSITION']).astype(np.float64)
    J = g.acc(b['attributes']['JOINTS_0']).astype(np.int64); Wt = g.acc(b['attributes']['WEIGHTS_0']).astype(np.float64)
    if Wt.max() > 1.5:
        Wt /= 255
    lab = label_parts(cat, g, b, P, I)
    # база котов + скин (skin_build.py compose): у одежды свой атлас — метки частей по имени меша, не по цвету
    if (j.get('asset', {}).get('extras') or {}).get('catSkin'):
        by = [('Cap_', CAP), ('Hoodie_', HOODIE), ('Headphones_', PHONES), ('Scarf_', SCARF), ('Bow_', BOW), ('Skirt_', SKIRT),
              ('Shoes_', SHOES), ('Boots_', SHOES)]
        bi_, bm_ = g.main_mesh()
        off = j['accessors'][bm_['attributes']['POSITION']]['count']
        lab[:off] = BODY
        for n in j['nodes']:
            if 'mesh' in n and n.get('extras', {}).get('part'):
                pr_ = j['meshes'][n['mesh']]['primitives'][0]
                cnt = j['accessors'][pr_['attributes']['POSITION']]['count']
                lab[off:off + cnt] = next((v for k, v in by if n['name'].startswith(k)), BODY)
                off += cnt
    sk = j['skins'][0]
    names = [j['nodes'][k]['name'].replace('mixamorig:', '') for k in sk['joints']]
    meshes = {n.get('name') for n in j['nodes'] if 'mesh' in n}

    def wsum(pred):
        sel = np.array([pred(n) for n in names])
        return (Wt * sel[J]).sum(1)
    V = []

    def ell(name, bone, X, lo=3, hi=97, mesh=None, pad=0.0, dev=None):
        if dev is not None:  # как рантайм (bodyCollide, прокси из меша): центр — среднее, полуоси — перцентиль отклонения
            c_ = X.mean(0); r_ = np.percentile(np.abs(X - c_), dev, axis=0) + pad
            d = {'name': name, 'bone': bone, 'type': 'ellipsoid', 'center': r5(c_), 'radii': r5(r_)}
        else:
            a_, b_ = np.percentile(X, lo, axis=0), np.percentile(X, hi, axis=0)
            d = {'name': name, 'bone': bone, 'type': 'ellipsoid', 'center': r5((a_ + b_) / 2), 'radii': r5((b_ - a_) / 2 + pad)}
        if mesh:
            d['mesh'] = mesh
        V.append(d)

    def cap_(name, bone, a_, b_, r, mesh=None):
        d = {'name': name, 'bone': bone, 'type': 'capsule', 'a': r5(a_), 'b': r5(b_), 'r': round(float(r), 5)}
        if mesh:
            d['mesh'] = mesh
        V.append(d)

    def hull(name, bone, X, mesh=None, n=48, pad=0.0):
        from scipy.spatial import ConvexHull
        h = ConvexHull(X)
        pts = X[h.vertices]
        if len(pts) > n:  # прореживание: самые дальние друг от друга
            keep = [int(np.argmax(np.linalg.norm(pts - pts.mean(0), axis=1)))]
            d2 = np.linalg.norm(pts - pts[keep[0]], axis=1)
            while len(keep) < n:
                k = int(np.argmax(d2)); keep.append(k); d2 = np.minimum(d2, np.linalg.norm(pts - pts[k], axis=1))
            pts = pts[keep]
        if pad:  # наружу по горизонтали от оси: прореженная оболочка лежит внутри сетки — без запаса кисть уходит в неё
            c_ = pts.mean(0); dxz = pts[:, [0, 2]] - c_[[0, 2]]
            rr = np.linalg.norm(dxz, axis=1, keepdims=True)
            pts = pts.copy(); pts[:, [0, 2]] = c_[[0, 2]] + dxz * (rr + pad) / np.maximum(rr, 1e-6)
        d = {'name': name, 'bone': bone, 'type': 'hull', 'points': [r5(p) for p in pts]}
        if mesh:
            d['mesh'] = mesh
        V.append(d)

    used = np.zeros(len(P), bool); used[I.ravel()] = True
    headw = wsum(lambda n: n.startswith('Head'))
    earL = wsum(lambda n: n == 'LeftEar1'); earR = wsum(lambda n: n == 'RightEar1')
    head = used & (headw > 0.5) & (earL < 0.4) & (earR < 0.4) & (lab == BODY)
    ell('head', 'Head', P[head & (P[:, 1] > np.percentile(P[head, 1], 6))], 2, 98, pad=PAD_HEAD)  # + мех щёк
    for nm_, m, bone in (('ear_L', earL > 0.5, 'LeftEar1'), ('ear_R', earR > 0.5, 'RightEar1')):
        if (m & used).sum() > 10:
            a_, b_, r = capsule(P[m & used], 80)
            cap_(nm_, bone, a_, b_, r)
    for part, name, bone in ((CAP, 'Cap_Hooligan', 'Head'), (BOW, 'Bow_Glitter', 'Head')):
        X = P[used & (lab == part)]
        if len(X) > 50:
            hull(name.split('_')[0].lower(), bone, X, mesh=name if name in meshes else None)
    neckw = wsum(lambda n: n == 'Neck')
    # шея: тело/худи между подбородком и плечами (весов Neck у Tripo мало), без наушников и капюшона сзади
    hb = P[head]
    y1 = np.percentile(hb[:, 1], 6); y0 = y1 - 0.07
    neck = used & (P[:, 1] > y0) & (P[:, 1] < y1) & (np.hypot(P[:, 0], P[:, 2] - np.median(hb[:, 2])) < 0.11) & np.isin(lab, [BODY, HOODIE])
    if neck.sum() > 20:
        ell('neck', 'Neck', P[neck], 5, 95)
    sp = wsum(lambda n: n.startswith('Spine') or n == 'Hips')
    torso = used & (sp > 0.6) & np.isin(lab, [BODY, HOODIE, SCARF, SKIRT])
    # туловище — как рантайм (85-й перцентиль отклонения): руки вдоль тела в покое не выталкиваются
    ell('torso', 'Spine1', P[torso], dev=85)
    hoodw = wsum(lambda n: n in ('Neck', 'Spine2'))
    hood = used & (lab == HOODIE) & (hoodw > 0.5) & (P[:, 2] < np.median(P[torso, 2]))
    hm = f'Hoodie_{cat.capitalize()}'
    if hood.sum() > 30:
        ell('hood', 'Spine2', P[hood], mesh=hm if hm in meshes else None, dev=85)
    # наушники — точно по детали (headphones.py): чашки — капсулы по оси, дуга — цепочка капсул
    hn = next((n for n in j['nodes'] if n.get('extras', {}).get('headphones')), None)
    if hn is not None:
        hp = hn['extras']['headphones']
        for k, c in enumerate(hp['cups']):
            cc, ax = np.array(c['c']), np.array(c['axis'])
            cap_(f'headphones_cup_{"LR"[k]}', 'Neck', cc + ax * min(c['r'], c['depth']) * 0.45, cc + ax * (c['depth'] - min(c['r'], c['depth']) * 0.45), c['r'] + PAD_HP, mesh='Headphones_Hooligan')
        bp = np.array(hp['band'])
        for k in range(len(bp) - 1):
            cap_(f'headphones_band_{k}', 'Neck', bp[k], bp[k + 1], hp['band_r'] + PAD_HP, mesh='Headphones_Hooligan')
    elif (lab[used] == PHONES).sum() > 200:
        # v1 (наушники запечены в сетку тела, детали нет): по вершинам с меткой «наушники» (цвет альбедо) — чашки спереди
        # по бокам шеи (капсулы по своей оси) + дуга-кольцо вокруг шеи (цепочка капсул по окружности наименьших квадратов)
        X = P[used & (lab == PHONES)]
        cc, nrm, R, _tube, _pts = ring(X, 12)
        zc = np.median(X[:, 2])
        cupm = (np.abs(X[:, 0]) > 0.075) & (X[:, 2] > zc)
        for s_, nm_ in ((1, 'L'), (-1, 'R')):
            cup = X[cupm & (X[:, 0] * s_ > 0)]
            if len(cup) > 40:
                a_, b_, r = capsule(cup, 92)
                cap_(f'headphones_cup_{nm_}', 'Neck', a_, b_, r + PAD_HP)
        # дуга — цепочка капсул по средней линии: вершины вне чашек по углу вокруг центра кольца (12 секторов) → центр
        # сектора; толщина — 90-й перцентиль расстояния вершин до своего отрезка (окружность была бы толще самой дуги)
        e1 = np.cross(nrm, [1.0, 0, 0]); e1 /= np.linalg.norm(e1); e2 = np.cross(nrm, e1)
        B = X[~cupm]
        ang = np.arctan2((B - cc) @ e2, (B - cc) @ e1)
        nb = 12
        sec = np.floor((ang + np.pi) / (2 * np.pi) * nb).astype(int) % nb
        mids = [B[sec == k].mean(0) if (sec == k).sum() > 8 else None for k in range(nb)]
        for k in range(nb):
            a_, b_ = mids[k], mids[(k + 1) % nb]
            if a_ is None or b_ is None:
                continue
            Y = B[(sec == k) | (sec == (k + 1) % nb)]
            ab = b_ - a_
            t = np.clip(((Y - a_) @ ab) / max(ab @ ab, 1e-12), 0, 1)
            dist = np.linalg.norm(Y - (a_ + t[:, None] * ab), axis=1)
            cap_(f'headphones_band_{k}', 'Neck', a_, b_, float(np.percentile(dist, 90)) + PAD_HP)
    if (lab[used] == SCARF).sum() > 50:
        X = P[used & (lab == SCARF)]
        nk = X[X[:, 1] > np.percentile(X[:, 1], 45)]
        cc, nrm, R, tube_, pts = ring(nk)
        for k in range(len(pts) - 1):
            cap_(f'scarf_{k}', 'Neck', pts[k], pts[k + 1], tube_, mesh='Scarf_Kind')
        tail = X[X[:, 1] < np.percentile(X[:, 1], 40)]
        if len(tail) > 20:
            a_, b_, r = capsule(tail, 85)
            cap_('scarf_tail', 'Spine2', a_, b_, r, mesh='Scarf_Kind')
    tn = next((n for n in j['nodes'] if n.get('extras', {}).get('tulle')), None)
    if tn is not None:
        pr = j['meshes'][tn['mesh']]['primitives'][0]
        X = g.acc(pr['attributes']['POSITION']).astype(np.float64)
        # фатин (Блёстка p1, 20.11): запас 20 мм — кисть и манжета ложатся на пачку, а не в неё
        hull('skirt', 'Hips', X, mesh=tn['name'], pad=0.02)
    # ноги: бедро и голень — капсулы по вершинам кости
    for side, S_ in (('L', 'Left'), ('R', 'Right')):
        for nm_, bone in (('thigh', f'{S_}UpLeg'), ('shin', f'{S_}Leg')):
            m = used & (wsum(lambda n, b_=bone: n == b_) > 0.6)
            if m.sum() > 20:
                a_, b_, r = capsule(P[m], 70)
                cap_(f'{nm_}_{side}', bone, a_, b_, r * (0.8 if nm_ == 'thigh' else 1.0))  # бедро — «сердцевина», как рантайм
    # карманы: вход — по краям «кенгуру» спереди внизу худи (или боковые у Блёстки)
    pockets = []
    hood_all = P[used & (lab == HOODIE)]
    if len(hood_all) > 100:
        hem = np.percentile(hood_all[:, 1], 3); top = np.percentile(hood_all[:, 1], 97)
        y0, y1 = hem + 0.03, hem + 0.03 + 0.28 * (top - hem)
        front = used & (lab == HOODIE) & (P[:, 1] > y0) & (P[:, 1] < y1) & (np.abs(P[:, 0]) < 0.13)
        if front.sum() > 30:
            X = P[front]; X = X[X[:, 2] > np.percentile(X[:, 2], 90) - 0.03]
            cc = X.mean(0); hx = float(np.percentile(np.abs(X[:, 0] - cc[0]), 92)) * 0.9
            for s_ in (1, -1):
                pockets.append({'name': f'pocket_{"L" if s_ > 0 else "R"}', 'bone': 'Spine1',
                                'center': r5(cc + np.array([s_ * hx, (y1 - y0) * 0.1, -0.012])), 'r': round(float((y1 - y0) * 0.42), 5)})
    # скин одежды у шеи (шарф, наушники — запечены в сетку тела, веса скина у ключицы/плеча/головы): прокси едет как
    # вершины ткани рядом — blend = средние веса вершин детали у капсулы (≥ 4 %, до 4 костей); bone — только система
    for v in V:
        part = SCARF if v['name'].startswith('scarf') else PHONES if v['name'].startswith('headphones') else None
        if part is None or v['type'] != 'capsule':
            continue
        a_, b_ = np.array(v['a']), np.array(v['b']); ab = b_ - a_
        t = np.clip(((P - a_) @ ab) / max(ab @ ab, 1e-12), 0, 1)
        near = used & (lab == part) & (np.linalg.norm(P - (a_ + t[:, None] * ab), axis=1) < v['r'] + 0.01)
        if near.sum() < 8:
            continue
        acc = np.zeros(len(names))
        np.add.at(acc, J[near].ravel(), (Wt[near] / np.maximum(Wt[near].sum(1, keepdims=True), 1e-9)).ravel())
        acc /= acc.sum()
        top = [k for k in np.argsort(-acc)[:4] if acc[k] >= 0.04]
        w = acc[top] / acc[top].sum()
        if len(top) == 1 and names[top[0]] == v['bone']:
            continue
        v['blend'] = [[names[k], round(float(x), 3)] for k, x in zip(top, w)]
    res = {'version': 1, 'cat': cat, 'source': 'scripts/models/colliders.py (поза покоя, координаты модели)', 'volumes': V, 'pockets': pockets}
    json.dump(res, open(out, 'w'), ensure_ascii=False, indent=1)
    print(f'{cat}: прокси {len(V)} ({", ".join(sorted(set(v["name"].split("_")[0] for v in V)))}), карманов {len(pockets)} → {out}')


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Глаза по рефам персонажей (design/cut/<кот>/turn, face): широко открытые, круглые, с тёмной подводкой.

  python3 scripts/models/persona_tune.py <cat> in.glb out.glb

Хулиган, Добряк, Блёстка (у Блёстки ресницы-лепестки у внешнего уголка — крупнее и длиннее, как на рефе). Геометрию, кости, текстуры не трогает (байт-в-байт), меняет:
  • extras.restUp узлов Eye_L/R — верхнее веко в покое (Добряк — глаз открыт до радужки, Хулиган — чуть ниже: дерзкий,
    но не сонный);
  • COLOR_0 век (face_detail.lid_mesh: 11 рядов по nu вершин, ряд 0 — кромка): подводка верхнего века шире и чернее,
    у нижнего — тонкая линия (рефы: тёмный контур по всему верхнему краю глаза).
Повторный запуск идемпотентен: цвет ряда считается от цвета меха в дальнем ряду (он не меняется).

  --clean (для основы v1): без просвечиваний в покое — после правки глаз сетка проходит untangle.py (одежда не режет
  тело и себя, сдвиг ≤ 3 мм), затем пучки прядей v1 (BD_FurCards), режущие одежду в покое, убираются целиком
  (связные куски сетки прядей). Проверка — penetration.py.
"""
import os
import subprocess
import tempfile
import sys
import numpy as np
from glb_io import Glb

ROWS = 11
LASH = np.array([0.008, 0.008, 0.014])
# доля подводки по рядам от кромки
TUNE = {
    'kind': {'restUp': 0.1, 'up': [1.0, 1.0, 1.0, 0.9, 0.35], 'lo': [0.75, 0.5, 0.15]},
    'hooligan': {'restUp': 0.22, 'up': [1.0, 1.0, 1.0, 0.7, 0.15], 'lo': [0.7, 0.42, 0.1]},
    'glitter': {'restUp': 0.1, 'up': [1.0, 1.0, 1.0, 0.95, 0.45], 'lo': [0.8, 0.55, 0.18], 'lash': (1.25, 1.6, 1.25),
                # по рефу (design/sheets/glitter_turnaround.jpg, кадр КотоТом 17-11): по две маленькие звезды у каждого
                # виска — над внешним уголком глаза, ближе к основанию уха; лоб чистый — (азимут от «вперёд», град;
                # высота; радиус). 20.11 v1 было: по три R 0.022 по краю лба (азимут 49…64) — читалось короной
                # бант: звезда в центре крупнее (реф — крупная объёмная звезда между бантами), см. bow_star
                'bow_star': {'k': 1.2, 'r0': 0.035, 'r1': 0.062},
                'stars': {'R': 0.011, 'lift': 0.008, 'at': [(60, 0.79, 0.012), (55, 0.818, 0.01)]}},
}
LASH_SEG = 12  # вершин в лепестке ресницы (face_detail: 6 сечений × 2)


def main():
    cat, src, dst = sys.argv[1:4]
    if cat not in TUNE:
        print(f'{cat}: без изменений'); return
    t = TUNE[cat]
    g = Glb(src); j = g.j
    for n in j['nodes']:
        if n.get('name') in ('Eye_L', 'Eye_R') and 'restUp' in n.get('extras', {}):
            print(f"{cat}: {n['name']} restUp {n['extras']['restUp']} → {t['restUp']}")
            n['extras']['restUp'] = t['restUp']
    for n in j['nodes']:
        nm = n.get('name', '')
        if not (nm.startswith('LidUp_') or nm.startswith('LidLo_')) or 'mesh' not in n:
            continue
        pr = j['meshes'][n['mesh']]['primitives'][0]
        ai = pr['attributes']['COLOR_0']
        c = g.acc(ai).astype(np.float64)
        nv = len(c)
        # ряды века — первые ROWS·nu вершин; у Блёстки после них — лепестки ресниц (по LASH_SEG вершин)
        nu = next((nv // ROWS - k for k in range(0, 4) if (nv - (nv // ROWS - k) * ROWS) % LASH_SEG == 0 and nv // ROWS - k > 0), None)
        if nu is None or (nv - nu * ROWS) % LASH_SEG:
            print(f'{cat}: {nm} — {nv} вершин: ряды не найдены, пропуск'); continue
        extra = nv - nu * ROWS
        if extra and nm.startswith('LidUp_') and t.get('lash'):
            pa = pr['attributes']['POSITION']
            P = g.acc(pa).astype(np.float64)
            k0 = np.array(j['meshes'][n['mesh']].get('extras', {}).get('lashScale', [1.0, 1.0, 1.0]), np.float64)
            ks_ = np.array(t['lash'], np.float64) / k0
            for b0 in range(nu * ROWS, nv, LASH_SEG):
                seg = P[b0:b0 + LASH_SEG]
                root = seg[:2].mean(0)
                d = seg - root
                # длиннее вдоль лепестка, шире у корня — крупные загнутые ресницы
                seg[:] = root + d * ks_  # (x, y, z) в пространстве глаза: y — вверх, ресницы загибаются выше
            g.set_acc(pa, P.astype(np.float32))
            j['meshes'][n['mesh']].setdefault('extras', {})['lashScale'] = list(t['lash'])
            c[nu * ROWS:, :3] = LASH
            print(f'{cat}: {nm} ресницы ×{t["lash"]} ({extra // LASH_SEG} лепестка)')
        fur = c[5 * nu:6 * nu, :3].copy()  # ряд 5 — чистый мех (подводка не доходит)
        ks = t['up'] if nm.startswith('LidUp_') else t['lo']
        for r in range(5):
            k = ks[r] if r < len(ks) else 0.0
            c[r * nu:(r + 1) * nu, :3] = LASH * k + fur * (1 - k) * (0.97 if nm.startswith('LidUp_') else 1.0)
        g.set_acc(ai, c.astype(np.float32))
        print(f'{cat}: {nm} подводка {ks}')
    tulle_uv(g)
    if t.get('bow_star'):
        bow_star(g, cat, t['bow_star'])
    if t.get('stars'):
        add_stars(g, cat, t['stars'])
    g.save(dst)
    if '--clean' in sys.argv:
        here = os.path.dirname(os.path.abspath(__file__))
        tmp = tempfile.mktemp(suffix='.glb')
        subprocess.run([sys.executable, os.path.join(here, 'untangle.py'), cat, dst, tmp], check=True)
        prune_cards(cat, tmp, dst)
        os.remove(tmp)
    fit_budget(dst)


LIMIT = 4.5 * 1024 * 1024


def bow_star(g, cat, cfg):
    """звезда в центре банта крупнее: вершины банта (самый большой кусок части «бант/заколки») вокруг центра звезды
    раздвигаются от него в k раз, с плавным спадом по расстоянию в плоскости XY (r0 — целиком, r1 — нет) — крылья банта
    и низ у головы на месте. Оболочки меха делят POSITION с телом — двигаются вместе. Повторный запуск — не трогает
    (extras.bowStar у меша)."""
    from mesh_parts import label_parts, BOW, weld, components
    j = g.j
    bi, b = g.main_mesh()
    if j['meshes'][bi].get('extras', {}).get('bowStar'):
        print('звезда банта уже увеличена'); return
    pa = b['attributes']['POSITION']
    P = g.acc(pa).astype(np.float64)
    I = g.acc(b['indices']).reshape(-1, 3).astype(np.int64)
    lab = label_parts(cat, g, b, P, I)
    w = weld(P)
    T = w[I][(lab[I] == BOW).all(1)]
    comp = components(w.max() + 1, T)
    vv = np.unique(T)
    ids, cnt = np.unique(comp[vv], return_counts=True)
    big = ids[cnt.argmax()]
    bv = np.where((lab == BOW) & (comp[w] == big))[0]
    top = P[bv, 1].max()
    core = bv[(np.abs(P[bv, 0] - np.median(P[bv, 0])) < 0.04) & (P[bv, 1] > top - 0.08)]
    c = P[core].mean(0)
    d = np.hypot(P[bv, 0] - c[0], P[bv, 1] - c[1])
    s = np.clip((cfg['r1'] - d) / (cfg['r1'] - cfg['r0']), 0, 1)
    s = s * s * (3 - 2 * s)
    P[bv] += (cfg['k'] - 1) * s[:, None] * (P[bv] - c)
    g.set_acc(pa, P.astype(np.float32))
    j['meshes'][bi].setdefault('extras', {})['bowStar'] = cfg['k']
    print(f'бант: звезда ×{cfg["k"]} вокруг {np.round(c, 3)} ({(s > 0).sum()} вершин)')


def add_stars(g, cat, cfg):
    """золотые звёздочки-заколки (реф design/cut/glitter: крупные, блестящие, по краю головы): поверх заколок Tripo
    (мелкие компоненты части «бант/заколки», кроме самого банта) и ещё в точках cfg.extra — у поверхности головы,
    над мехом (lift), лучом вверх; объёмные (выпуклый перед), металл; скин — как у ближайшей вершины головы.
    Меш BD_Metal_Stars (не тонируется мехом); повторный запуск — заменяет."""
    from mesh_parts import label_parts, BOW, weld, components
    j = g.j
    if any(n.get('name') == 'BD_Metal_Stars' for n in j['nodes']):
        print('звёзды уже есть'); return
    bi, b = g.main_mesh()
    P = g.acc(b['attributes']['POSITION']).astype(np.float64)
    Nb = g.acc(b['attributes']['NORMAL']).astype(np.float64)
    Jb = g.acc(b['attributes']['JOINTS_0']); Wb = g.acc(b['attributes']['WEIGHTS_0'])
    I = g.acc(b['indices']).reshape(-1, 3).astype(np.int64)
    lab = label_parts(cat, g, b, P, I)
    w = weld(P)
    T = w[I][(lab[I] == BOW).all(1)]
    comp = components(w.max() + 1, T)
    vv = np.unique(T)
    ids, cnt = np.unique(comp[vv], return_counts=True)
    big = ids[cnt.argmax()]
    # опорные точки: по краю лба (азимут, высота) — самая «смотрящая» в эту сторону вершина головы у этой высоты
    head = np.where((lab != BOW) & (P[:, 1] > 0.7))[0]
    hc = P[head].mean(0)
    centers = []
    radii = []
    for st in cfg['at']:
        az, y = st[:2]
        for sg in (1, -1):
            radii.append(st[2] if len(st) > 2 else cfg['R'])
            d = np.array([sg * np.sin(np.radians(az)), 0, np.cos(np.radians(az))])
            m = head[np.abs(P[head, 1] - y) < 0.008]
            sc = (P[m] - hc) @ d
            centers.append(P[m[sc.argmax()]])
    from scipy.spatial import cKDTree
    tree = cKDTree(P[head])
    lift = cfg['lift']
    V, NN, F, JJ, WW = [], [], [], [], []
    for c0, R in zip(centers, radii):
        _, q = tree.query(c0, k=12)
        vi = head[q]
        n = Nb[vi].mean(0); n /= np.linalg.norm(n)
        base = P[vi].mean(0) + n * lift
        # лицом чуть больше к зрителю (как на рефе — звёзды видны спереди)
        n = n + np.array([0, 0, 0.6]); n /= np.linalg.norm(n)
        up = np.array([0, 1.0, 0]) - n * n[1]; up /= max(np.linalg.norm(up), 1e-6)
        rt = np.cross(up, n)
        ring = []
        for i in range(10):
            a = np.pi / 2 + i * np.pi / 5
            r = R if i % 2 == 0 else R * 0.45
            ring.append(base + (rt * np.cos(a) + up * np.sin(a)) * r)
        top = base + n * R * 0.38
        bot = base - n * R * 0.12
        for i in range(10):
            a_, b_ = ring[i], ring[(i + 1) % 10]
            for tri in ((top, a_, b_), (bot, b_, a_)):
                fn = np.cross(tri[1] - tri[0], tri[2] - tri[0]); fn /= max(np.linalg.norm(fn), 1e-12)
                k0 = len(V)
                V += list(tri); NN += [fn] * 3; F.append([k0, k0 + 1, k0 + 2])
                JJ += [Jb[vi[0]]] * 3; WW += [Wb[vi[0]]] * 3
    V = np.array(V, np.float32); NN = np.array(NN, np.float32)
    mat = {'name': 'BD_Metal_Stars_mat', 'pbrMetallicRoughness': {'baseColorFactor': [0.86, 0.62, 0.24, 1], 'metallicFactor': 0.3, 'roughnessFactor': 0.3},
           'emissiveFactor': [0.12, 0.08, 0.02]}
    j['materials'].append(mat)
    WWa = np.array(WW)
    attrs = {'POSITION': g.add_acc(V, 5126, 'VEC3', 34962), 'NORMAL': g.add_acc(NN, 5126, 'VEC3', 34962),
             'JOINTS_0': g.add_acc(np.array(JJ).astype(np.uint8 if np.array(JJ).max() < 256 else np.uint16), 5121 if np.array(JJ).max() < 256 else 5123, 'VEC4', 34962),
             'WEIGHTS_0': g.add_acc(WWa.astype(np.uint8 if WWa.max() > 1.5 else np.float32), 5121 if WWa.max() > 1.5 else 5126, 'VEC4', 34962)}
    if WWa.max() > 1.5:
        j['accessors'][attrs['WEIGHTS_0']]['normalized'] = True
    prim = {'attributes': attrs, 'indices': g.add_acc(np.array(F, np.uint16).ravel(), 5123, 'SCALAR', 34963), 'material': len(j['materials']) - 1}
    j['meshes'].append({'name': 'BD_Metal_Stars', 'primitives': [prim]})
    bnode = next(i for i, n in enumerate(j['nodes']) if n.get('mesh') == bi)
    j['nodes'].append({'name': 'BD_Metal_Stars', 'mesh': len(j['meshes']) - 1, 'skin': j['nodes'][bnode]['skin'], 'extras': {'stars': len(centers)}})
    parent = next((n for n in j['nodes'] if bnode in n.get('children', [])), None)
    (parent['children'] if parent is not None else j['scenes'][0]['nodes']).append(len(j['nodes']) - 1)
    print(f'звёзды-заколки: {len(centers)} шт., R={sorted(set(radii))}')


def tulle_uv(g):
    """фатин (tulle.py: слои × NS рядов × NT секторов): UV0 = (сектор/NT, ряд/(NS−1)) — рантайм (character/tulleFx.ts)
    рисует по ним сетку, блёстки и золотую полосу у подола; узлу — extras.tulleUV"""
    from tulle import NT, NS
    j = g.j
    n = next((n for n in j['nodes'] if n.get('extras', {}).get('tulle')), None)
    if n is None:
        return
    pr = j['meshes'][n['mesh']]['primitives'][0]
    cnt = j['accessors'][pr['attributes']['POSITION']]['count']
    q = np.arange(cnt) % (NS * NT)
    uv = np.stack([(q % NT) / NT, (q // NT) / (NS - 1)], 1).astype(np.float32)
    pr['attributes']['TEXCOORD_0'] = g.add_acc(uv, 5126, 'VEC2', 34962)
    n['extras']['tulleUV'] = 1
    print(f'фатин: разметка UV ({cnt} вершин)')


def fit_budget(path):
    """бюджет файла ≤ 4.5 МиБ: карта нормалей тела — JPEG q85 (как outfit_tone.py у v2), альбедо не трогаем"""
    if os.path.getsize(path) <= LIMIT:
        return
    g = Glb(path); j = g.j
    bi, b = g.main_mesh()
    nt = j['materials'][b['material']].get('normalTexture')
    if not nt:
        return
    ni = j['textures'][nt['index']]['source']
    if j['images'][ni].get('extras', {}).get('requant'):
        return
    g.set_image(ni, g.image(ni).convert('RGB'))
    j['images'][ni].setdefault('extras', {})['requant'] = 85
    j['images'][ni]['mimeType'] = 'image/jpeg'
    g.save(path)
    print(f'бюджет: карта нормалей → JPEG q85, {os.path.getsize(path)} байт')


def prune_cards(cat, src, dst):
    """пучки прядей (связные куски BD_FurCards), режущие одежду в покое, — прочь (только индексы, вершины остаются)"""
    from penetration import Model, tri_pairs_intersect
    from mesh_parts import tri_label
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    md = Model(cat, src)
    g = md.g; j = g.j
    cloth = np.where(tri_label(md.lab, md.I) > 0)[0]
    for n in j['nodes']:
        if 'mesh' not in n or j['meshes'][n['mesh']]['name'] != 'BD_FurCards':
            continue
        pr = j['meshes'][n['mesh']]['primitives'][0]
        P2 = g.acc(pr['attributes']['POSITION']).astype(float)
        I2 = g.acc(pr['indices']).reshape(-1, 3).astype(np.int64)
        pp = tri_pairs_intersect(P2, I2, md.P, md.I[cloth])
        # фатин (Блёстка) — отдельный меш: пряди сквозь него тоже прочь
        for (nm2, Pt, It_, _, _, kind2) in md.over:
            if kind2 == 'tulle':
                pt = tri_pairs_intersect(P2, I2, Pt, It_)
                if len(pt):
                    pp = np.concatenate([pp.reshape(-1, 2), pt]) if len(pp) else pt
        if not len(pp):
            print(f'{cat}: пряди не режут одежду'); continue
        nv = len(P2)
        e = np.concatenate([I2[:, [0, 1]], I2[:, [1, 2]]])
        _, comp = connected_components(coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(nv, nv)), directed=False)
        bad = np.unique(comp[I2[np.unique(pp[:, 0]), 0]])
        keep = ~np.isin(comp[I2[:, 0]], bad)
        ct = j['accessors'][pr['indices']]['componentType']
        pr['indices'] = g.add_acc(I2[keep].ravel(), ct, 'SCALAR', 34963)
        print(f'{cat}: пряди — убрано {len(bad)} пучков ({(~keep).sum()} треугольников), режущих одежду в покое')
    # оболочки меха, задевающие одежду в покое (у пояса после снятия юбки Tripo), — длина меха там 0
    for (nm2, Po, Ish, _, _, kind2) in md.over:
        if kind2 != 'shell':
            continue
        pp = tri_pairs_intersect(Po, Ish, md.P, md.I[cloth])
        if not len(pp):
            continue
        sh = next(n for n in j['nodes'] if 'mesh' in n and j['meshes'][n['mesh']]['name'] == 'BD_FurShell')
        pr = j['meshes'][sh['mesh']]['primitives'][0]
        L = g.acc(pr['attributes']['_FURLEN']).astype(np.float32)
        vv = np.unique(Ish[np.unique(pp[:, 0])].ravel())
        near = np.unique(Ish[np.isin(Ish, vv).any(1)].ravel())
        L[near] = 0
        g.set_acc(pr['attributes']['_FURLEN'], L)
        print(f'{cat}: оболочки меха у одежды — длина 0 у {len(near)} вершин')
    g.save(dst)


if __name__ == '__main__':
    main()

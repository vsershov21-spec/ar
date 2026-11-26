"""Блёстка p4, стадия 1 (без Blender): ригнутая Tripo-модель «по частям» после p4_join.py + rig_cat.py (уши, хвост) →
одна сетка тела с общим атласом — такой же вход, какой у Хулигана и Добряка был у стадий лица и тела
(одна сетка Tripo, одна текстура, скин Mixamo + LeftEar1/RightEar1/Tail1..4).

    python3 scripts/models/glitter_p4.py /tmp/p4/rigged.glb /tmp/p4/base.glb [--keep-face] [--atlas 2048]

Части Tripo (35 мешей tripo_part_*, у каждой своя базовая текстура и карта нормалей) — роли по имени (таблица ROLES,
печатается с центром и цветом для проверки):
  • глаза Tripo (с ресницами) и рот-улыбка — прочь: их место займут глаза рига (face_detail.py: яблоко, веки, eyeRig) и
    рот MouthD / рот рига p2 (face_rig.py), как у Хулигана и Добряка. Дыры головы под ними — заплатки: глазница
    вогнутая (за яблоком), рот — по поверхности морды. --keep-face оставляет их (снимок лица для face_photo/face_detect).
  • нос, «морда» (светлая выпуклость у рта) и брови — вшиты в голову полосой треугольников между краем дыры головы и
    краем части: морда — одна связная поверхность (face_rig.py режет губы по рёбрам, ему нужна сплошная сетка).
  • крошки (< 100 вершин) — прочь.
Атлас: базовый цвет и нормали всех частей в 2048² (голова крупнее остальных), поля с растяжкой краёв.
Роли частей с их прямоугольниками в атласе — в asset.extras.glitterP4 (split_p4 в glitter_p4_finish.py по ним отделяет
пачку и золото в свои меши).
"""
import sys, os, json, argparse
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from face_detail import G2, gc  # noqa: E402
from glitter_p3_parts import boundary_loops, cap_loop, bleed, pack  # noqa: E402

# роли частей модели design/models/glitter_tripo_rigged.glb (центры в осях glTF: y вверх, z вперёд, рост ≈ 0.98)
ROLES = {
    'tripo_part_0': 'head', 'tripo_part_5': 'fur', 'tripo_part_6': 'fur',  # голова, уши
    'tripo_part_3': 'fur', 'tripo_part_4': 'fur', 'tripo_part_7': 'fur', 'tripo_part_8': 'fur',  # ноги, кисти
    'tripo_part_18': 'tail',
    'tripo_part_1': 'tutu',
    'tripo_part_2': 'cloth', 'tripo_part_10': 'cloth', 'tripo_part_11': 'cloth', 'tripo_part_9': 'cloth',
    'tripo_part_13': 'cloth', 'tripo_part_14': 'cloth', 'tripo_part_23': 'cloth', 'tripo_part_29': 'cloth',
    'tripo_part_32': 'cloth',  # худи, рукава, манжеты, карман, значок, шнурки
    'tripo_part_12': 'gold',  # кант пояса
    'tripo_part_15': 'gold', 'tripo_part_19': 'gold', 'tripo_part_20': 'gold', 'tripo_part_21': 'gold',  # бант
    'tripo_part_24': 'gold', 'tripo_part_26': 'gold', 'tripo_part_27': 'gold',  # звёзды у висков
    'tripo_part_16': 'eye', 'tripo_part_17': 'eye', 'tripo_part_22': 'mouth',
    'tripo_part_25': 'muzzle', 'tripo_part_28': 'nose', 'tripo_part_30': 'brow', 'tripo_part_31': 'brow',
    'tripo_part_33': 'junk', 'tripo_part_34': 'junk',
}
ZIP = ('muzzle', 'nose', 'brow')
# заплатка рта ровной сеткой (cap_grid) вместо веера — попытка дать face_rig.py разрез губ; разрез всё равно протекает
# (docs/models/README.md, «Блёстка p4»), поэтому по умолчанию — веер (меньше вершин)
GRID_MOUTH = os.environ.get('P4_GRID_MOUTH') == '1'
# масштаб картинок части в атласе (×общий коэффициент): голова — крупнее (лицо, мех морды), пачка — мельче (полупрозрачная)
SCALE = {'head': 1.45, 'tutu': 0.8}
# шероховатость / металл по роли (карта metallicRoughness атласа: G — шероховатость, B — металл)
ROUGH = {'gold': 0.34, 'nose': 0.5, 'tail': 0.62, 'tutu': 0.6, 'cloth': 0.8, 'mouthcap': 0.6}
METAL = {'gold': 0.55}


def load_parts(g):
    j = g.j
    out = []
    for p in j['meshes'][0]['primitives']:
        mat = j['materials'][p['material']]
        name = mat['name'].split('_material')[0]
        A = p['attributes']
        img = g.image(j['textures'][mat['pbrMetallicRoughness']['baseColorTexture']['index']]['source']).convert('RGB')
        nimg = g.image(j['textures'][mat['normalTexture']['index']]['source']).convert('RGB') if 'normalTexture' in mat else None
        q = {'name': name, 'role': ROLES.get(name, 'cloth'), 'V': g.acc(A['POSITION']).astype(np.float64),
             'N': g.acc(A['NORMAL']).astype(np.float64), 'UV': g.acc(A['TEXCOORD_0']).astype(np.float64),
             'J': g.acc(A['JOINTS_0']).astype(np.int64), 'W': g.acc(A['WEIGHTS_0']).astype(np.float64),
             'F': g.acc(p['indices']).reshape(-1, 3).astype(np.int64), 'img': img, 'nimg': nimg}
        a = np.asarray(img).astype(np.float32); h, w = a.shape[:2]
        c = q['UV'][q['F']].mean(1)
        q['col'] = a[np.clip((c[:, 1] * h).astype(int), 0, h - 1), np.clip((c[:, 0] * w).astype(int), 0, w - 1)].mean(0)
        out.append(q)
    return out


def orient(V, loop, n):
    """цикл против часовой вокруг нормали n"""
    L = V[loop]; c = L.mean(0)
    e1 = np.cross(n, [0, 1.0, 0]) if abs(n[1]) < 0.9 else np.cross(n, [1.0, 0, 0]); e1 /= np.linalg.norm(e1); e2 = np.cross(n, e1)
    a = np.unwrap(np.arctan2((L - c) @ e2, (L - c) @ e1))
    return loop if a[-1] > a[0] else loop[::-1]


def zip_loops(PA, PB, n):
    """полоса треугольников между циклами A и B (оба против часовой вокруг n): индексы (0..na-1 — A, na.. — B)"""
    na, nb = len(PA), len(PB)
    j0 = int(np.argmin(np.linalg.norm(PB - PA[0], axis=1)))
    B = np.roll(np.arange(nb), -j0)
    i = j = 0
    T = []
    while i < na or j < nb:
        a0, a1 = i % na, (i + 1) % na
        b0, b1 = B[j % nb], B[(j + 1) % nb]
        if j >= nb or (i < na and np.linalg.norm(PA[a1] - PB[b0]) < np.linalg.norm(PA[a0] - PB[b1])):
            T.append([a0, a1, na + b0]); i += 1
        else:
            T.append([a0, na + b1, na + b0]); j += 1
    T = np.array(T)
    P = np.r_[PA, PB]
    tn = np.cross(P[T[:, 1]] - P[T[:, 0]], P[T[:, 2]] - P[T[:, 0]]).sum(0)
    return T if tn @ n > 0 else T[:, [0, 2, 1]]


def stitch(head, part):
    """вшить часть в голову: полоса между дырой головы и краем части. Вершины края части дублируются с UV головы
    (ближайшая вершина края дыры) — полоса целиком в текстуре головы (иначе треугольник через два острова атласа)"""
    lb = boundary_loops(part['V'], part['F'])
    lb = max(lb, key=len)
    c = part['V'][lb].mean(0)
    hl = boundary_loops(head['V'], head['F'])
    hole = min(hl, key=lambda l: np.linalg.norm(head['V'][l].mean(0) - c))
    n = part['N'][lb].mean(0); n /= np.linalg.norm(n)
    lb = orient(part['V'], lb, n); hole = orient(head['V'], hole, n)
    T = zip_loops(head['V'][hole], part['V'][lb], n)
    # у каждого треугольника полосы — свои 3 вершины (позиция, нормаль, скин — от вершин краёв) с одним UV на весь
    # треугольник: тексель головы у вершины края дыры. Край дыры идёт через швы UV головы — треугольник с UV из двух
    # островов растянулся бы через атлас (и закраски face_detail.py легли бы на чужие острова)
    hole = np.array(hole); lb = np.array(lb)
    src = {k: np.r_[head[k][hole], part[k][lb]] for k in ('V', 'N', 'J', 'W')}
    tv = T.ravel()
    nh = len(head['V'])
    for k in ('V', 'N', 'J', 'W'):
        head[k] = np.r_[head[k], src[k][tv]]
    head['UV'] = np.r_[head['UV'], np.repeat(head['UV'][hole[T[:, 0]]], 3, axis=0)]
    head['F'] = np.r_[head['F'], nh + np.arange(len(tv)).reshape(-1, 3)]
    print(f"  вшита {part['name']} ({part['role']}): край {len(lb)}, дыра головы {len(hole)}, полоса {len(T)} треуг.")


def close_slits(head, max_w=0.004):
    """щель Tripo по середине подбородка: две колонки вершин в 1.6–2.5 мм друг от друга не сшиты (отдельная тонкая дыра
    головы) — сквозь неё видна изнанка, на лице тёмная вертикальная черта (и в рендере Tripo). Тонкие дыры у центра морды
    ниже рта (по x ≤ max_w, вдоль — длиннее) сшиваем: вершины левого края — в ближайшие вершины правого (все копии
    позиции), нормали — средние"""
    V, N = head['V'], head['N']
    key = np.round(V * 1e5).astype(np.int64)
    _, w = np.unique(key, axis=0, return_inverse=True); w = w.ravel()
    done = 0
    for loop in boundary_loops(V, head['F']):
        P = V[loop]; c = P.mean(0)
        if not (abs(c[0]) < 0.01 and c[2] > 0.05 and 0.5 < c[1] < 0.62):
            continue
        across = P[:, 0] - np.median(P[:, 0])
        if np.ptp(across) > max_w or np.ptp(P[:, 1]) < 4 * max_w:
            continue
        left = [i for i, a in zip(loop, across) if a < 0]; right = [i for i, a in zip(loop, across) if a >= 0]
        Pr = V[right]
        for i in left:
            k = right[int(np.argmin(np.linalg.norm(Pr - V[i], axis=1)))]
            n = N[i] + N[k]; n /= np.linalg.norm(n)
            for ids in (w == w[i], w == w[k]):
                V[ids] = V[k]; N[ids] = n
        done += 1
        print(f"  щель головы у подбородка сшита: {len(left)}+{len(right)} вершин, ширина {np.ptp(across) * 1000:.1f} мм, "
              f"y {P[:, 1].min():.3f}…{P[:, 1].max():.3f}")
    return done


def cap_grid(V, loop, bulge, step=0.0016):
    """заплатка рта: ровная сетка рядами вдоль x (линия рта горизонтальна) — разрез губ face_rig.py идёт по рёбрам без
    зигзагов (у веерной заплатки путь уходил с линии, и губы не разделялись). Высота z — квадрика по краю дыры +
    выпуклость; → вершины (первые len(loop) — край), треугольники, плоские UV 0..1"""
    from scipy.spatial import Delaunay
    L = V[loop]
    # плоскость по краю дыры (главные оси): в осях x/y край у уголков рта складывается (уходит вглубь) — контур
    # самопересекался, треугольники у уголков выпадали (дыры, разрез губ протекал)
    c3 = L.mean(0)
    _, _, vt = np.linalg.svd(L - c3)
    if vt[2] @ np.array([0, 0, 1.0]) < 0:
        vt = -vt
    ex, ey = vt[0] if abs(vt[0][0]) > abs(vt[1][0]) else vt[1], vt[1] if abs(vt[0][0]) > abs(vt[1][0]) else vt[0]
    ez = np.cross(ex, ey)
    if ez @ vt[2] < 0:
        ey = -ey; ez = -ez
    Q = (L - c3) @ np.stack([ex, ey, ez], 1)
    xy = Q[:, :2]
    A_ = np.c_[np.ones(len(L)), xy, xy ** 2, xy[:, :1] * xy[:, 1:]]
    coef = np.linalg.lstsq(A_, Q[:, 2], rcond=None)[0]
    c = xy.mean(0); r = np.linalg.norm(xy - c, axis=1).mean()
    gx = np.arange(xy[:, 0].min(), xy[:, 0].max(), step); gy = np.arange(xy[:, 1].min(), xy[:, 1].max(), step * 0.87)
    G = np.array([[x + (k % 2) * step / 2, y] for k, y in enumerate(gy) for x in gx])
    from matplotlib.path import Path
    poly = Path(xy)
    inside = poly.contains_points(G)
    # не ближе полшага к краю
    from scipy.spatial import cKDTree
    d, _ = cKDTree(xy).query(G)
    G = G[inside & (d > 0.6 * step)]
    P2 = np.r_[xy, G]
    T = Delaunay(P2).simplices
    cen = P2[T].mean(1)
    T = T[poly.contains_points(cen)]
    # треугольники только из вершин края (через вогнутость контура) — прочь, если выходят за контур
    def z_of(p):
        a = np.c_[np.ones(len(p)), p, p ** 2, p[:, :1] * p[:, 1:]]
        rr = np.linalg.norm(p - c, axis=1) / r
        return a @ coef + bulge * r * np.clip(1 - rr ** 2, 0, 1)
    # рёбра края, выпавшие из триангуляции Делоне (контур невыпуклый у уголков): треугольник ребро + ближайшая вершина
    nL = len(L)
    E = {tuple(sorted(e)) for t in T for e in ((t[0], t[1]), (t[1], t[2]), (t[2], t[0]))}
    add = []
    for i in range(nL):
        e = tuple(sorted((i, (i + 1) % nL)))
        if e in E:
            continue
        mid = P2[list(e)].mean(0)
        dd = np.linalg.norm(P2 - mid, axis=1); dd[list(e)] = 1e9
        add.append([e[0], e[1], int(np.argmin(dd))])
    if add:
        T = np.r_[T, np.array(add)]
    loc = np.c_[P2, np.r_[Q[:, 2], z_of(G)]]
    tn = np.cross(loc[T[:, 1]] - loc[T[:, 0]], loc[T[:, 2]] - loc[T[:, 0]])
    T[tn[:, 2] < 0] = T[tn[:, 2] < 0][:, [0, 2, 1]]
    newV = c3 + loc @ np.stack([ex, ey, ez], 0)
    newV[:len(L)] = L
    # все рёбра края — в триангуляции (иначе дыра)
    E = {tuple(sorted(e)) for t in T for e in ((t[0], t[1]), (t[1], t[2]), (t[2], t[0]))}
    miss = sum((min(i, (i + 1) % len(L)), max(i, (i + 1) % len(L))) not in E for i in range(len(L)))
    if miss:
        print(f'  ВНИМАНИЕ: {miss} рёбер края дыры рта вне триангуляции')
    q = (P2 - P2.min(0)) / np.maximum(np.ptp(P2, 0), 1e-9)
    print(f"  заплатка рта сеткой: {len(G)} внутренних вершин, {len(T)} треуг.")
    return newV, T, q


def cap_hole(head, center, bulge, name, rings=3, grid=False):
    """заплатка дыры головы у точки center → своя плитка атласа (ровный цвет каймы). Кольцо границы — копии вершин
    края дыры (та же позиция и скин, UV плитки): face_rig.py сваривает их с головой по позиции — сетка морды сплошная"""
    hl = boundary_loops(head['V'], head['F'])
    loop = np.array(min(hl, key=lambda l: np.linalg.norm(head['V'][l].mean(0) - center)))
    nv, nt, q = (cap_grid(head['V'], loop, bulge) if grid else cap_loop(head['V'], head['F'], list(loop), bulge, rings))
    n = len(loop)
    a = np.asarray(head['img']).astype(np.float32); hh, ww = a.shape[:2]
    c0 = head['V'][loop].mean(0); r0 = np.linalg.norm(head['V'][loop] - c0, axis=1).mean()
    dd = np.linalg.norm(head['V'] - c0, axis=1)
    ring = (dd > 1.25 * r0) & (dd < 1.8 * r0) & (head['V'][:, 2] > c0[2] - 0.015)
    uvr = head['UV'][ring]
    cols = a[np.clip((uvr[:, 1] * hh).astype(int), 0, hh - 1), np.clip((uvr[:, 0] * ww).astype(int), 0, ww - 1)]
    lum = cols.mean(1)
    col = np.median(cols[lum >= np.percentile(lum, 40)], 0)
    from scipy.spatial import cKDTree
    _, nn = cKDTree(head['V'][loop]).query(nv)
    fn = np.cross(nv[nt[:, 1]] - nv[nt[:, 0]], nv[nt[:, 2]] - nv[nt[:, 0]])
    vn = np.zeros_like(nv)
    for k in range(3):
        np.add.at(vn, nt[:, k], fn)
    vn /= np.linalg.norm(vn, axis=1, keepdims=True) + 1e-12
    vn[:n] = head['N'][loop]
    print(f"  заплатка {name}: граница {n}, центр {np.round(c0, 3).tolist()}, цвет {np.round(col).astype(int).tolist()}, выпуклость {bulge}")
    return {'name': name, 'role': 'cap', 'img': Image.new('RGB', (64, 64), tuple(int(x) for x in col)),
            'nimg': Image.new('RGB', (64, 64), (128, 128, 255)), 'col': col, 'V': nv, 'N': vn, 'UV': 0.1 + 0.8 * q,
            'J': head['J'][loop[nn]], 'W': head['W'][loop[nn]], 'F': nt}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src'); ap.add_argument('out')
    ap.add_argument('--atlas', type=int, default=2048)
    ap.add_argument('--keep-face', action='store_true')
    a = ap.parse_args()
    g = G2(a.src); j = g.j
    parts = load_parts(g)
    for p in parts:
        print(f"{p['name']:14s} {p['role']:7s} верш. {len(p['V']):5d} центр {np.round(p['V'].mean(0), 3).tolist()} цвет {np.round(p['col']).astype(int).tolist()} текстура {p['img'].size[0]}")
    head = next(p for p in parts if p['role'] == 'head')
    drop = {'junk'} if a.keep_face else {'junk', 'eye', 'mouth'}
    caps = []
    close_slits(head)
    if not a.keep_face:
        for p in parts:
            if p['role'] in ZIP:
                stitch(head, p)
        for p in parts:
            if p['role'] == 'eye':
                caps.append(cap_hole(head, p['V'].mean(0), 0.2, 'cap_' + p['name']))  # как поверхность нарисованного глаза у Хулигана/Добряка: яблоко face_detail встаёт по ней
            elif p['role'] == 'mouth':
                caps.append(cap_hole(head, p['V'].mean(0), 0.12, 'cap_' + p['name'], grid=GRID_MOUTH))
    keep = [p for p in parts if p['role'] not in drop] + caps
    # ── атлас ──
    PAD = 4
    S = a.atlas
    sc = 0.6
    while True:
        sizes = []
        for p in keep:
            k = sc * SCALE.get(p['role'], 1.0) if p['img'].size[0] > 64 else 1.0
            sizes.append((max(16, int(p['img'].size[0] * k)) + 2 * PAD, max(16, int(p['img'].size[1] * k)) + 2 * PAD))
        pos = pack(sizes, S)
        if pos:
            break
        sc *= 0.97
    base = Image.new('RGB', (S, S), (128, 128, 128)); nrm = Image.new('RGB', (S, S), (128, 128, 255))
    rm = Image.new('RGB', (S, S), (255, int(0.72 * 255), 0))
    Vs, Ns, UVs, Js, Ws, Fs = [], [], [], [], [], []
    info = {}
    off = 0
    head_off = None
    for p, (x, y), (w, h) in zip(keep, pos, sizes):
        iw, ih = w - 2 * PAD, h - 2 * PAD
        Fu = p['F'] if p['F'] is not None else np.zeros((0, 3), int)
        for key, dst in (('img', base), ('nimg', nrm)):
            src = p[key] if p[key] is not None else Image.new('RGB', p['img'].size, (128, 128, 255))
            if src.size != p['img'].size:
                src = src.resize(p['img'].size, Image.LANCZOS)
            im = (bleed(src, p['UV'][:len(p['UV'])], Fu) if len(Fu) else src).resize((iw, ih), Image.LANCZOS)
            big = im.resize((w, h), Image.NEAREST); big.paste(im, (PAD, PAD))
            dst.paste(big, (x, y))
        rm.paste((255, int(ROUGH.get(p['role'], 0.72) * 255), int(METAL.get(p['role'], 0) * 255)), (x, y, x + w, y + h))
        uv = p['UV'].copy()
        uv[:, 0] = (x + PAD + uv[:, 0] * iw) / S
        uv[:, 1] = (y + PAD + uv[:, 1] * ih) / S
        if p is head:
            head_off = off
        if p.get('Fraw') is not None:
            # заплатка: граница — вершины головы (head_off + loop), внутренние — свои
            n = p['n']
            mp = np.r_[head_off + p['loop'], off + np.arange(len(p['V']))]
            Fs.append(mp[p['Fraw']])
        else:
            Fs.append(p['F'] + off)
        Vs.append(p['V']); Ns.append(p['N']); UVs.append(uv); Js.append(p['J']); Ws.append(p['W'])
        info[p['name']] = {'role': p['role'], 'uv': [x / S, y / S, (x + w) / S, (y + h) / S], 'v': [off, off + len(p['V'])]}
        off += len(p['V'])
    V = np.concatenate(Vs); N = np.concatenate(Ns); UV = np.concatenate(UVs); J = np.concatenate(Js); W = np.concatenate(Ws)
    F = np.concatenate(Fs)
    N /= np.linalg.norm(N, axis=1, keepdims=True) + 1e-12
    W /= W.sum(1, keepdims=True)
    print(f'атлас {S}² (×{sc:.3f}, голова ×{sc * SCALE["head"]:.3f}); частей {len(keep)}, вершин {len(V)}, треуг. {len(F)}')
    # ── GLB: одна сетка, один материал ──
    pr0 = j['meshes'][0]['primitives'][0]
    jt = j['accessors'][pr0['attributes']['JOINTS_0']]['componentType']
    prim = {'attributes': {
        'POSITION': g.add_acc(V.astype(np.float32), 5126, 'VEC3', 34962),
        'NORMAL': g.add_acc(N.astype(np.float32), 5126, 'VEC3', 34962),
        'TEXCOORD_0': g.add_acc(UV.astype(np.float32), 5126, 'VEC2', 34962),
        'JOINTS_0': g.add_acc(J.astype(np.uint8 if jt == 5121 else np.uint16), jt, 'VEC4', 34962),
        'WEIGHTS_0': g.add_acc(W.astype(np.float32), 5126, 'VEC4', 34962)},
        'indices': g.add_acc(F.reshape(-1).astype(np.uint32), 5125, 'SCALAR', 34963), 'material': 0}
    j['meshes'][0]['primitives'] = [prim]
    j['images'] = []; g.images = {}; j['textures'] = []
    j['samplers'] = [{'magFilter': 9729, 'minFilter': 9987, 'wrapS': 10497, 'wrapT': 10497}]
    ib = g.add_image(base, 'glitter_p4_base'); inr = g.add_image(nrm, 'glitter_p4_normal')
    irm = g.add_image(rm.resize((S // 2, S // 2), Image.NEAREST), 'glitter_p4_rm')
    j['materials'] = [{'name': 'tripo_mat_glitter_p4', 'pbrMetallicRoughness': {
        'baseColorTexture': {'index': g.add_texture(ib)}, 'metallicRoughnessTexture': {'index': g.add_texture(irm)},
        'metallicFactor': 1.0, 'roughnessFactor': 1.0},
        'normalTexture': {'index': g.add_texture(inr)}}]
    j.setdefault('asset', {}).setdefault('extras', {})['glitterP4'] = {'version': 1, 'atlas': S, 'parts': info,
                                                                       'keepFace': bool(a.keep_face)}
    # Blender-стадии (face_rig.py старый) теряют asset.extras — роли частей ещё и рядом файлом (glitter_p4_finish.py --parts)
    json.dump(j['asset']['extras']['glitterP4'], open(os.path.splitext(a.out)[0] + '_parts.json', 'w'))
    gc(g)
    g.jpeg_q = {0: 92, 1: 92, 2: 90}
    total = g.save(a.out)
    print(f'→ {a.out} {total / 1e6:.2f} MB')


if __name__ == '__main__':
    main()

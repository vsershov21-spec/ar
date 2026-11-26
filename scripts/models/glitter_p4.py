"""Блёстка p4, стадия 1 (без Blender): ригнутая Tripo-модель «по частям» после p4_join.py + rig_cat.py (уши, хвост) →
одна сетка тела с общим атласом — такой же вход, какой у Хулигана и Добряка был у стадий лица и тела
(одна сетка Tripo, одна текстура, скин Mixamo + LeftEar1/RightEar1/Tail1..4).

    python3 scripts/models/glitter_p4.py /tmp/p4/rigged.glb /tmp/p4/base.glb [--keep-face] [--atlas 2048]

Части Tripo (35 мешей tripo_part_*, у каждой своя базовая текстура и карта нормалей) — роли по имени (таблица ROLES,
печатается с центром и цветом для проверки):
  • глаза Tripo (с ресницами) и рот-улыбка — прочь: их место займут глаза рига (face_detail.py: яблоко, веки, eyeRig) и
    рот MouthD / рот рига p2 (face_rig.py), как у Хулигана и Добряка. Дыры головы под ними — заплатки: глазница
    вогнутая (за яблоком), рот — по поверхности морды. --keep-face оставляет их (снимок лица для face_photo/face_detect).
  • нос — вшит в голову полосой треугольников между краем дыры головы и краем части (морда — одна связная поверхность).
    v3: «морда» Tripo (блок с длинной складкой и раздвоенной губой — «заяц») и полость рта — прочь, на их месте своя
    кошачья мордочка (cap_muzzle: подушечки «ω», короткий фильтрум рисует шейдер MouthD); брови Tripo — прочь, дыры —
    мягкие заплатки (soft_brow); нос — розовый (NOSE_RGB); атлас — retouch (мех спины светлее, пачка с блёстками).
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
# v3: брови Tripo (выпуклые дуги с тёмным краем-тенью) — прочь; дыры — гладкие заплатки с мягкой дугой меха темнее
# (реф: брови — мех, без контура)
BROW_DARK = 0.13
# цвет носа (sRGB, середина текстуры): нос рефа в приложении ≈ (179, 144, 159) — Tripo (169, 119, 131) темнее и лиловее
NOSE_RGB = np.array(json.loads(os.environ.get('P4_NOSE_RGB', '[207, 166, 191]')), np.float32)
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
        if q['role'] == 'nose':
            # нос v3: нежно-розовый, как на рефе (у Tripo — тёмно-лиловый): тон к NOSE_RGB, тёмный низ светлее
            m = a.reshape(-1, 3).mean(0)
            a = np.clip(NOSE_RGB * (0.55 + 0.45 * a / np.maximum(m, 1)), 0, 255)
            q['img'] = img = Image.fromarray(a.astype(np.uint8))
        if q['role'] == 'brow':
            # брови v3: мягкая дуга мехом чуть темнее (реф), без тёмного контура Tripo
            from scipy.ndimage import gaussian_filter
            r_ = max(2.0, a.shape[0] * 0.03)
            a = np.stack([gaussian_filter(a[..., k], r_) for k in range(3)], -1)
            q['img'] = img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
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
            'J': head['J'][loop[nn]], 'W': head['W'][loop[nn]], 'F': nt, 'nloop': n}


def soft_brow(cap):
    """заплатка брови: тон каймы, к середине дуги — темнее (BROW_DARK), мягко, с зерном меха"""
    from scipy.spatial import cKDTree
    from scipy.ndimage import gaussian_filter
    q = (cap['UV'] - 0.1) / 0.8
    S = 96
    yy, xx = (np.mgrid[:S, :S] + 0.5) / S
    P = np.c_[xx.ravel(), yy.ravel()]
    # граница: первые nloop вершин заплатки — край дыры (cap_loop: кольцо копий вершин края)
    from matplotlib.path import Path
    d, _ = cKDTree(q[:cap['nloop']]).query(P)
    ins = Path(q[:cap['nloop']]).contains_points(P)
    w = np.clip(d / max(d[ins].max() if ins.any() else d.max(), 1e-6), 0, 1).reshape(S, S) ** 0.8
    rng = np.random.default_rng(5)
    nz = gaussian_filter(rng.normal(0, 1, (S, S)), (0.7, 1.5)); nz /= nz.std() + 1e-9
    col = np.array(cap['col'], np.float32)
    img = col[None, None] * (1 - BROW_DARK * w)[..., None] + 2.5 * nz[..., None]
    cap['img'] = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8))
    cap['role'] = 'browcap'
    return cap


def compact(head):
    used = np.unique(head['F'])
    mp = -np.ones(len(head['V']), np.int64); mp[used] = np.arange(len(used))
    for k in ('V', 'N', 'UV', 'J', 'W'):
        head[k] = head[k][used]
    head['F'] = mp[head['F']]


# мордочка v3 (продакт: «заяц»): вместо части-морды Tripo (вытянутый блок с длинной вертикальной складкой и раздвоенной
# губой) и открытого рта — своя кошачья мордочка: короткая, две пухлые подушечки по бокам под носом, маленький подбородок.
# Рот рисует шейдер MouthD (линия «ω», фильтрум, открытый рот), как у Хулигана/Добряка.
MUZZLE = dict(rx=0.062, y0=0.6445, ry=0.026, pad_x=0.0175, pad_y=0.652, pad_sx=0.0135, pad_sy=0.0105, pad_h=0.0038,
              chin_y=0.618, chin_h=0.0015, groove=0.0012, step=0.0016)
MUZZLE.update(json.loads(os.environ.get('P4_MUZZLE', '{}')))


def biharmonic_fill(V, F, xy, G, h=0.0005, pad=0.012):
    """высота z поверхности головы над дырой (вид спереди): растр головы шагом h вокруг дыры, клетки дыры — решение
    бигармонического уравнения (гладкое продолжение поверхности вокруг, без складки у края) → z в точках G"""
    import scipy.sparse as sp
    from scipy.sparse.linalg import spsolve
    from matplotlib.path import Path
    from face_detail import Front
    fr = Front(V, np.zeros_like(V), np.zeros((len(V), 2)), F, ymin=0.45)
    x0, y0 = xy.min(0) - pad; x1, y1 = xy.max(0) + pad
    xs = np.arange(x0, x1, h); ys = np.arange(y0, y1, h)
    X, Y = np.meshgrid(xs, ys)
    Z = fr.hit(np.c_[X.ravel(), Y.ravel()])[0][:, 2].reshape(X.shape)
    hole = Path(xy).contains_points(np.c_[X.ravel(), Y.ravel()]).reshape(X.shape) | np.isnan(Z)
    ny, nx = X.shape
    idx = np.arange(nx * ny).reshape(ny, nx)
    r, c, v = [], [], []
    for i in range(1, ny - 1):
        for j in range(1, nx - 1):
            k = idx[i, j]
            r += [k] * 5; c += [k, idx[i - 1, j], idx[i + 1, j], idx[i, j - 1], idx[i, j + 1]]; v += [-4, 1, 1, 1, 1]
    Lp = sp.csr_matrix((v, (r, c)), shape=(nx * ny, nx * ny))
    Q = (Lp.T @ Lp).tocsr()
    u = hole.ravel(); kn = ~u
    zk = np.nan_to_num(Z.ravel()[kn])
    zu = spsolve(Q[u][:, u].tocsc(), -Q[u][:, kn] @ zk)
    Zf = Z.ravel().copy(); Zf[u] = zu; Zf = Zf.reshape(ny, nx)
    from scipy.interpolate import RegularGridInterpolator
    return RegularGridInterpolator((ys, xs), Zf, bounds_error=False, fill_value=None)(np.c_[G[:, 1], G[:, 0]])


def muzzle_from_land(path):
    """эллипс выреза и подушечки — от ориентиров (линия рта, низ носа), стадия 3: face_landmarks/glitter_p4.json"""
    if not os.path.exists(path):
        return
    F = json.load(open(path))
    my = float(np.mean([p[1] for p in F['mouth']['line']])); nb = F['nose']['bottom'][1]
    y0 = my + 0.006
    MUZZLE.update(y0=y0, ry=max(0.016, nb - 0.006 - y0), pad_y=my + 0.011, chin_y=my - 0.017)
    print(f"  морда v3 по ориентирам: рот y {my:.4f}, низ носа {nb:.4f} → центр {MUZZLE['y0']:.4f}, ry {MUZZLE['ry']:.4f}, подушечки y {MUZZLE['pad_y']:.4f}")


def cap_muzzle(head):
    """вырезать морду головы (полость рта Tripo, полоса между дырами морды и рта) эллипсом и закрыть своей поверхностью:
    гладкая поверхность головы вокруг (полином по кольцу, у края — точно по краю) + подушечки + подбородок.
    → заплатка своей плиткой атласа (тон каймы, светлее на подушечках)"""
    from scipy.spatial import Delaunay, cKDTree
    from matplotlib.path import Path
    M = MUZZLE
    V, F = head['V'], head['F']
    c = V[F].mean(1)
    def ell(p):
        return (p[:, 0] / M['rx']) ** 2 + ((p[:, 1] - M['y0']) / M['ry']) ** 2
    # треугольник с любой вершиной внутри эллипса — прочь (по центру — край зубцами внутрь, заплатка не покрывала
    # выемки); затем «шипы» — треугольники с двумя рёбрами на краю дыры
    ev = ell(V)
    cut = (ev[F].min(1) < 1) & (c[:, 2] > 0.08)
    for _ in range(4):
        Fk = F[~cut]
        e_all = np.sort(np.r_[Fk[:, [0, 1]], Fk[:, [1, 2]], Fk[:, [2, 0]]], 1)
        key = e_all[:, 0] * len(V) + e_all[:, 1]
        u, cnt = np.unique(key, return_counts=True)
        bnd = set(u[cnt == 1].tolist())
        nb = np.zeros(len(F), int)
        for a_, b_ in ((0, 1), (1, 2), (2, 0)):
            ee = np.sort(F[:, [a_, b_]], 1)
            nb += np.isin(ee[:, 0] * len(V) + ee[:, 1], list(bnd))
        spike = ~cut & (nb >= 2) & (ell(c) < 1.5) & (c[:, 2] > 0.08)
        if not spike.any():
            break
        cut |= spike
    head['F'] = F[~cut]
    compact(head)
    V, F = head['V'], head['F']
    hl = boundary_loops(V, F)
    loop = np.array(max([l for l in hl if ell(V[l].mean(0)[None])[0] < 1 and V[l][:, 2].mean() > 0.12], key=len))
    L = V[loop]
    print(f"  морда v3: вырезано {int(cut.sum())} треуг., край {len(loop)} верш., x {L[:, 0].min():.3f}…{L[:, 0].max():.3f}, "
          f"y {L[:, 1].min():.3f}…{L[:, 1].max():.3f}")
    xy = L[:, :2]
    step = M['step']
    gx = np.arange(xy[:, 0].min(), xy[:, 0].max(), step); gy = np.arange(xy[:, 1].min(), xy[:, 1].max(), step * 0.87)
    G = np.array([[x + (k % 2) * step / 2, y] for k, y in enumerate(gy) for x in gx])
    poly = Path(xy)
    d, _ = cKDTree(xy).query(G)
    G = G[poly.contains_points(G) & (d > 0.6 * step)]
    P2 = np.r_[xy, G]
    T = Delaunay(P2).simplices
    T = T[poly.contains_points(P2[T].mean(1))]
    nL = len(L)
    E = {tuple(sorted(e_)) for t in T for e_ in ((t[0], t[1]), (t[1], t[2]), (t[2], t[0]))}
    add = []
    for i in range(nL):
        e_ = tuple(sorted((i, (i + 1) % nL)))
        if e_ in E:
            continue
        mid = P2[list(e_)].mean(0)
        dd = np.linalg.norm(P2 - mid, axis=1); dd[list(e_)] = 1e9
        add.append([e_[0], e_[1], int(np.argmin(dd))])
    if add:
        T = np.r_[T, np.array(add)]
    x, y = G[:, 0], G[:, 1]
    db, _ = cKDTree(xy).query(G)
    z = biharmonic_fill(V, F, xy, G)
    e = ell(V)
    taper = np.clip(db / 0.008, 0, 1) ** 1.5 * (3 - 2 * np.clip(db / 0.008, 0, 1))
    pads = sum(np.exp(-(((x - s * M['pad_x']) / M['pad_sx']) ** 2 + ((y - M['pad_y']) / M['pad_sy']) ** 2)) for s in (-1, 1))
    chin = np.exp(-((x / 0.02) ** 2 + ((y - M['chin_y']) / 0.008) ** 2))
    groove = np.exp(-((x / 0.004) ** 2)) * np.clip((y - (M['pad_y'] - 0.008)) / 0.02, 0, 1)
    z = z + taper * (M['pad_h'] * pads + M['chin_h'] * chin - M['groove'] * groove)
    newV = np.r_[L, np.c_[G, z]]
    tn = np.cross(newV[T[:, 1]] - newV[T[:, 0]], newV[T[:, 2]] - newV[T[:, 0]])
    T[tn[:, 2] < 0] = T[tn[:, 2] < 0][:, [0, 2, 1]]
    E = {tuple(sorted(e_)) for t in T for e_ in ((t[0], t[1]), (t[1], t[2]), (t[2], t[0]))}
    miss = sum((min(i, (i + 1) % nL), max(i, (i + 1) % nL)) not in E for i in range(nL))
    if miss:
        print(f'  ВНИМАНИЕ: {miss} рёбер края морды вне триангуляции')
    fn = np.cross(newV[T[:, 1]] - newV[T[:, 0]], newV[T[:, 2]] - newV[T[:, 0]])
    vn = np.zeros_like(newV)
    for k in range(3):
        np.add.at(vn, T[:, k], fn)
    vn /= np.linalg.norm(vn, axis=1, keepdims=True) + 1e-12
    vn[:nL] = head['N'][loop]
    # тон: кайма вокруг (светлая морда Tripo), подушечки чуть светлее, лёгкий шум меха
    a = np.asarray(head['img']).astype(np.float32); hh, ww = a.shape[:2]
    rr = (e > 1.0) & (e < 1.8) & (V[:, 2] > 0.12) & (V[:, 1] < M['y0'] + 0.01)
    uvr = head['UV'][rr]
    cols = a[np.clip((uvr[:, 1] * hh).astype(int), 0, hh - 1), np.clip((uvr[:, 0] * ww).astype(int), 0, ww - 1)]
    lum = cols.mean(1)
    col = np.median(cols, 0)  # v3: середина — тон всего кольца (светлая середина растягивалась челюстью mouth_A в белое пятно под ртом)
    q = (P2 - P2.min(0)) / np.maximum(np.ptp(P2, 0), 1e-9)
    S = 128
    yy, xx = np.mgrid[:S, :S] / (S - 1)
    X = P2[:, 0].min() + xx * np.ptp(P2[:, 0]); Y = P2[:, 1].min() + yy * np.ptp(P2[:, 1])
    pd = sum(np.exp(-(((X - s * M['pad_x']) / M['pad_sx']) ** 2 + ((Y - M['pad_y']) / M['pad_sy']) ** 2)) for s in (-1, 1))
    rng = np.random.default_rng(7)
    nz = rng.normal(0, 1, (S, S)); from scipy.ndimage import gaussian_filter
    nz = gaussian_filter(nz, (0.6, 1.6)); nz /= nz.std() + 1e-9
    # к краю — цвет головы рядом (IDW по кольцу вокруг дыры): шов с мехом не читается
    near = (e > 1.0) & (e < 1.5) & (V[:, 2] > 0.1)
    un = head['UV'][near]
    cn = a[np.clip((un[:, 1] * hh).astype(int), 0, hh - 1), np.clip((un[:, 0] * ww).astype(int), 0, ww - 1)]
    XY = np.c_[X.ravel(), Y.ravel()]
    dd, ii = cKDTree(V[near][:, :2]).query(XY, k=8)
    wi = 1 / (dd ** 2 + 1e-8)
    edge_c = ((cn[ii] * wi[..., None]).sum(1) / wi.sum(1)[:, None]).reshape(S, S, 3)
    db_, _ = cKDTree(xy).query(XY)
    we = np.exp(-db_ / 0.005).reshape(S, S, 1)
    tile = (col[None, None] * (1 - we) + edge_c * we) * (1 + 0.035 * np.clip(pd, 0, 1)[..., None]) + 3.0 * nz[..., None]
    img = Image.fromarray(np.clip(tile, 0, 255).astype(np.uint8))
    _, nn = cKDTree(L).query(newV)
    print(f"  морда v3: {len(G)} внутр. верш., {len(T)} треуг., тон {np.round(col).astype(int).tolist()}")
    return {'name': 'cap_muzzle_v3', 'role': 'cap', 'img': img, 'nimg': Image.new('RGB', (64, 64), (128, 128, 255)),
            'col': col, 'V': newV, 'N': vn, 'UV': 0.02 + 0.96 * q, 'J': head['J'][loop[nn]], 'W': head['W'][loop[nn]], 'F': T}


# v3: мех светлее и мягче (продакт: спина и затылок темнее и грубее рефа), пачка пышнее — ярусы, блёстки к подолу,
# золотая кайма (реф design/refs/glitter_turnaround_1123.png)
RETOUCH = dict(back=0.26, top=0.06, soft=0.35, flare=0.2, hem=0.9, spark=0.16)
RETOUCH.update(json.loads(os.environ.get('P4_RETOUCH', '{}')))


def flare_tutu(p):
    """пачка шире к подолу (колокол, как на рефе): радиус от оси тела ×(1 + flare·t^1.2), t — 0 у пояса, 1 у подола"""
    V = p['V']
    yt, yb = np.percentile(V[:, 1], 99), V[:, 1].min()
    top = V[V[:, 1] > yt - 0.01]
    c = np.array([top[:, 0].mean(), 0, top[:, 2].mean()])
    t = np.clip((yt - V[:, 1]) / (yt - yb), 0, 1)
    d = V - c; d[:, 1] = 0
    k = 1 + RETOUCH['flare'] * t ** 1.2
    p['V'] = V + d * (k - 1)[:, None]
    print(f"  пачка: шире к подолу ×{k.max():.2f} (ось x {c[0]:.3f} z {c[2]:.3f}, пояс y {yt:.3f}, подол {yb:.3f})")


def retouch(base, items, S):
    """атлас: мех головы/тела/хвоста — спина и затылок светлее (свет приложения спереди; у рефа спина светлая), рисунок
    шерсти мягче (плюш); пачка — блёстки гуще к подолу и золотая кайма по подолу"""
    from glb_io import raster_uv
    from scipy.ndimage import gaussian_filter
    R = RETOUCH
    a = np.asarray(base).astype(np.float32)
    soft = np.stack([gaussian_filter(a[..., k], 1.6) for k in range(3)], -1)
    rng = np.random.default_rng(11)
    for p, uv in items:
        role = p['role']
        if role not in ('head', 'fur', 'tail', 'tutu'):
            continue
        pos, nrm, tid = raster_uv(p['V'], p['N'], uv, p['F'], S)
        m = tid >= 0
        if role != 'tutu':
            nz, ny = nrm[..., 2], nrm[..., 1]
            back = np.clip((0.2 - nz) / 0.8, 0, 1)
            f = 1 + R['back'] * back * back * (3 - 2 * back) + R['top'] * np.clip(ny, 0, 1)
            out = (a * (1 - R['soft']) + soft * R['soft']) * f[..., None]
            a[m] = out[m]
            if role == 'head':
                # светлые тексели морды/подбородка Tripo почти белые (синее красного < 0.1): маска меха FurTone их не берёт —
                # в приложении белое пятно «резцами» под ртом. Тон — к голубизне меха (синий − красный ≥ 26)
                q_ = a[m]
                lack = np.clip(26 - (q_[:, 2] - q_[:, 0]), 0, 40)[:, None] * (q_.mean(1, keepdims=True) > 150)
                a[m] = q_ + lack * np.array([-0.45, -0.1, 0.55], np.float32)
                print(f"  мех головы: {int((lack[:, 0] > 0).sum())} светлых текселей — к голубизне меха")
                # низ подбородка (остров UV под челюстью светлее): при открытом рте (челюсть mouth_A) он поворачивается к
                # камере — светлое пятно «резцами» под ртом. Тон — как у подбородка спереди
                px, py, pz = pos[..., 0], pos[..., 1], pos[..., 2]
                front = m & (np.abs(px) < 0.04) & (py > 0.56) & (py < 0.62) & (nrm[..., 2] > 0.6)
                under = m & (np.abs(px) < 0.07) & (py > 0.5) & (py < 0.63) & (pz > 0.03) & (nrm[..., 1] < -0.15)
                if front.any() and under.any():
                    k_ = np.median(a[front], 0) / np.maximum(np.median(a[under], 0), 1)
                    a[under] = a[under] * k_
                    print(f"  низ подбородка: {int(under.sum())} текселей ×{np.round(k_, 3).tolist()}")
                # шов Tripo по середине подбородка (сшитая щель, close_slits): светлая черта в текстуре — медианой
                from scipy.ndimage import median_filter
                px, py, pz = pos[..., 0], pos[..., 1], pos[..., 2]
                ch = m & (np.abs(px) < 0.007) & (py > 0.5) & (py < 0.63) & (pz > 0.08)
                if ch.any():
                    ys_, xs_ = np.nonzero(ch)
                    y0_, y1_, x0_, x1_ = ys_.min() - 12, ys_.max() + 13, xs_.min() - 12, xs_.max() + 13
                    sub = a[y0_:y1_, x0_:x1_]
                    med = np.stack([median_filter(sub[..., k], 13) for k in range(3)], -1)
                    mm = ch[y0_:y1_, x0_:x1_]
                    sub[mm] = med[mm]
                    print(f"  шов подбородка: {int(ch.sum())} текселей — медиана")
            print(f"  мех {p['name']}: {int(m.sum())} текселей, спина ×{1 + R['back']:.2f}, мягче {R['soft']}")
        else:
            y = pos[..., 1]
            yt, yb = np.percentile(p['V'][:, 1], 99), p['V'][:, 1].min()
            t = np.clip((yt - y) / (yt - yb), 0, 1)
            gold = np.array([226, 196, 120], np.float32)
            # кайма по подолу: золото с зерном
            hem = np.clip((t - R['hem']) / (1 - R['hem']) * 1.6, 0, 1) * m
            grain = 0.75 + 0.5 * rng.random(t.shape)
            a = a * (1 - 0.85 * hem[..., None]) + (gold * grain[..., None]) * 0.85 * hem[..., None]
            # блёстки: точки 1–2 px, гуще к подолу
            dens = (0.015 + R['spark'] * t ** 2) * m
            sp = rng.random(t.shape) < dens
            sp |= np.roll(sp, 1, 1) & (rng.random(t.shape) < 0.4)
            bright = np.array([250, 230, 160], np.float32) * (0.85 + 0.3 * rng.random(t.shape))[..., None]
            a[sp] = a[sp] * 0.15 + bright[sp] * 0.85
            print(f"  пачка: кайма {int((hem > 0.5).sum())} текселей, блёсток {int(sp.sum())}")
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))


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
    drop = {'junk'} if a.keep_face else {'junk', 'eye', 'mouth', 'muzzle', 'brow'}
    caps = []
    close_slits(head)
    if not a.keep_face:
        for p in parts:
            if p['role'] in ZIP and p['role'] not in ('muzzle', 'brow'):
                stitch(head, p)
        for p in parts:
            if p['role'] == 'eye':
                caps.append(cap_hole(head, p['V'].mean(0), 0.2, 'cap_' + p['name']))  # как поверхность нарисованного глаза у Хулигана/Добряка: яблоко face_detail встаёт по ней
            elif p['role'] == 'brow':
                caps.append(soft_brow(cap_hole(head, p['V'].mean(0), 0.06, 'cap_' + p['name'])))
        muzzle_from_land(os.path.join(HERE, 'face_landmarks', 'glitter_p4.json'))
        caps.append(cap_muzzle(head))
    keep = [p for p in parts if p['role'] not in drop] + caps
    if not a.keep_face:
        for p in keep:
            if p['role'] == 'tutu':
                flare_tutu(p)
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
    items = []
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
        items.append((p, uv))
        info[p['name']] = {'role': p['role'], 'uv': [x / S, y / S, (x + w) / S, (y + h) / S], 'v': [off, off + len(p['V'])]}
        off += len(p['V'])
    V = np.concatenate(Vs); N = np.concatenate(Ns); UV = np.concatenate(UVs); J = np.concatenate(Js); W = np.concatenate(Ws)
    F = np.concatenate(Fs)
    if not a.keep_face:
        base = retouch(base, items, S)
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

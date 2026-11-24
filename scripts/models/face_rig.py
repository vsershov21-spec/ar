"""Мимика v3: настоящий рот геометрией и морфы лица (Blender headless) поверх основы p1.

    python face_rig.py <persona> public/models/v2/<кот>_p1.glb public/models/v2/<кот>_p2.glb [--report docs/qa/face]

Нужен Python с модулем bpy (pip install bpy==5.3.0 numpy pillow; в песочнице — /tmp/bpyenv/bin/python). Всё
воспроизводимо из p1 (p1 собирают persona_tune.py → face_geom.py, docs/models/README.md), ручных шагов нет;
повторный запуск по p2 отказывается (пометка asset.extras.faceRig).

Что делает:
  1. Морда (передняя часть головы, вес кости Head ≥ 0.5) выносится из тела в свой меш FaceSkin (тот же материал, скин,
     UV) и свои оболочки меха BD_FurShellFace (те же буферы, что у FaceSkin, + _FURLEN). Морфы — только у них: тело и
     его мех морфов больше не несут (было 13 ключей на всём теле 18 тыс. вершин — текстура морфов втрое больше).
  2. Blender (bmesh): морда у рта дважды подразбивается (UV, веса скина, нормали, ключи прошлых стадий
     интерполируются), по линии рта «ω» (рамка MouthD) прокладывается путь по рёбрам, вершины ставятся на линию, рёбра
     разрезаются — верхняя и нижняя губа становятся отдельными. В покое губы чуть разведены (тёмная линия рта
     геометрией), край губ скруглён внутрь, фильтрум — лёгкая складка.
  3. Ротовая полость MouthCavity (тёмная, к губам — тёмно-розовая кромка; «мешок» от края губ вглубь головы),
     верхние клычки Teeth и язык Tongue — отдельные меши на том же скине, края полости совпадают с краем губ во всех
     ключах (одни и те же смещения), низ полости и язык идут за челюстью.
  4. Ключи (морфы) — поля смещений в рамке рта (u — поперёк, v — вверх, единица — ширина рта W), челюсть — поворот
     вокруг шарнира за ртом: виземы Rhubarb vis_A…vis_H (X — покой), smile, smile_open, smirk, frown, surprise, pout,
     tongue_out, кожа век blink_L/R, squint, wide, брови brow_up/down/sad (прошлые стадии, перенесены) и brow_angry,
     cheek_up, cheeks_gum, nose_wrinkle (перенесены). Деформация — только вершины морды: маска по весу головы и
     расстоянию до рта/глаз, у границы FaceSkin ровно 0.
  5. Карточки меха (BD_FurCards), усы, пучки щёк и брови-накладка получают те же ключи (привязка к ближайшей точке
     морды; у карточки — по корню), мех у губ — длина 0 (пряди не лезут в рот).
  6. Накладка MouthD (рот шейдером) убирается — в p2 рот только геометрией.
Проверка: --report <dir> пишет face_rig_<кот>.md (размеры, проникновения по всем ключам).
"""
import sys, os, json, math, argparse
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from face_detail import G2, acc_dense, norm, gc  # noqa: E402

TAG = 'faceRig'
VERSION = 1

# ───────────── параметры рта по коту (в долях W) ─────────────
# gap — щель между губами в покое (тёмная линия рта), depth — глубина полости, fang — клычки (длина, u),
# tongue — язык (полуширина, длина), jaw — угол челюсти визем D (рад), rim_drop — доля спуска первого кольца
# полости под нижней губой (у Добряка губа у кромки завёрнута внутрь круче: кольцо, уходя вниз на 45°, выходило перед
# кожей губы на ~0.03 W — зубцы по нижней губе и в уголках открытого рта), rim_back — то же кольцо в каждом ключе
# не ближе этого к коже над ним (W), corner_smooth — итераций сглаживания ключей рта в уголках (smooth_corners)
PERSONA = {
    'hooligan': {'gap': 0.012, 'depth': 0.42, 'fang': (0.085, 0.2), 'tongue': (0.2, 0.2), 'jaw': 0.36},
    'kind': {'gap': 0.013, 'depth': 0.44, 'fang': (0.08, 0.2), 'tongue': (0.21, 0.21), 'jaw': 0.36, 'rim_drop': 0.0, 'rim_back': 0.03, 'corner_smooth': 24},
    'glitter': {'gap': 0.014, 'depth': 0.42, 'fang': (0.075, 0.19), 'tongue': (0.18, 0.18), 'jaw': 0.24},
}

# ключи прошлых стадий, которые переезжают на FaceSkin как есть (интерполируются при подразбиении)
W_REF = 0.1458  # ширина рта Хулигана (масштаб глубины рамки)
REST_FANG = 0.003  # длина клычка в покое (W): не виден в щели губ
TONGUE_DROP = 0.05  # язык ниже: в покое не виден в щели губ (W)
EPS = 0.006  # смещения ключа меньше EPS·W не пишутся (≈ 0.9 мм у Хулигана)
# зоны подразбиения у рта (rx, ry по u/v, центр v, глубина): два уровня — с одним у грубой сетки Tripo разрез по линии
# не отделяет губы целиком (верх «протекает» в низ, челюсть тянет кожу занавеской)
SUBDIV = [(0.85, 0.45, -0.08, 0.5), (0.7, 0.24, -0.02, 0.35)]
# маска ключей прошлых стадий у глаза (eye_guard): в эллипсе глаза r < 1.1 — 0, к r = 1.7 — полностью
EYE_GUARD = (1.1, 1.7)
KEEP_KEYS = ['brow_up', 'brow_down', 'brow_sad', 'cheek_up', 'cheeks_gum', 'nose_wrinkle']
# набор ключей p2 (порядок = порядок морфов; рантайм — src/character/faceMorphs.ts FACE_MORPHS)
VISEMES = ['vis_A', 'vis_B', 'vis_C', 'vis_D', 'vis_E', 'vis_F', 'vis_G', 'vis_H']
EMOS = ['smile', 'smile_open', 'smirk', 'frown', 'surprise', 'pout', 'tongue_out']
LIDS = ['blink_L', 'blink_R', 'squint', 'wide']
BROWS = ['brow_up', 'brow_down', 'brow_angry', 'brow_sad']
EXTRA = ['cheek_up', 'cheeks_gum', 'nose_wrinkle']
KEYS = VISEMES + EMOS + LIDS + BROWS + EXTRA

# состав ключей рта: jaw — доля угла челюсти; остальное — веса элементарных полей
# open — полуширина проёма (u, доли W) по рефу design/sheets/mouths.jpg: губы расходятся только в её пределах, дальше
# сомкнуты (и щель покоя закрыта) — «о» круглое маленькое, «у» трубочка, «а» уже и выше; arch — подъём середины
# верхней губы (доля опускания нижней)
MOUTH = {
    'vis_A': {'press': 1.0},
    'vis_B': {'jaw': 0.16, 'wide': 0.2, 'lift': 0.2, 'open': 0.34, 'arch': 0.1},
    'vis_C': {'jaw': 0.45, 'wide': 0.3, 'lift': 0.2, 'open': 0.36, 'arch': 0.12},
    'vis_D': {'jaw': 0.95, 'lift': 0.25, 'open': 0.34, 'arch': 0.15},
    'vis_E': {'jaw': 0.3, 'round': 0.8, 'open': 0.25, 'arch': 0.25, 'flat': 1.0},
    'vis_F': {'jaw': 0.16, 'pucker': 1.0, 'open': 0.14, 'arch': 0.25, 'flat': 1.0},
    'vis_G': {'jaw': 0.08, 'tuck': 1.0, 'open': 0.3},
    'vis_H': {'jaw': 0.42, 'lift': 0.2, 'tongue_up': 1.0, 'open': 0.32, 'arch': 0.12},
    'smile': {'smile': 1.0, 'press': 0.5},
    'smile_open': {'smile': 0.9, 'jaw': 0.42, 'lift': 0.6, 'open': 0.4, 'arch': 0.1},
    'smirk': {'smirk': 1.3, 'press': 0.5},
    'frown': {'frown': 1.0, 'press': 0.8},
    'surprise': {'jaw': 0.34, 'round': 0.9, 'pucker': 0.2, 'open': 0.24, 'arch': 0.3, 'flat': 1.0},
    'pout': {'pout': 1.0, 'press': 0.6},
    'tongue_out': {'jaw': 0.34, 'open': 0.3, 'tongue_out': 1.0, 'arch': 0.1},
}


def sm(e0, e1, x):
    t = np.clip((np.asarray(x, np.float64) - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def node_by(j, name):
    return next((i for i, n in enumerate(j['nodes']) if n.get('name') == name), None)


# ───────────────────────────── рамка лица ─────────────────────────────
class Frame:
    """рамка рта и глаз в координатах меша (glTF: x — влево кота, y — вверх, z — вперёд)"""

    def __init__(self, g, persona):
        j = g.j
        marks = j['nodes'][node_by(j, 'Brows')]['extras']['marks']
        md = j['nodes'][node_by(j, 'MouthD')]['extras']['mouth']
        sk = j['skins'][0]
        hn = node_by(j, 'mixamorig:Head')
        self.head_j = sk['joints'].index(hn)
        IBM = g.acc(sk['inverseBindMatrices']).reshape(-1, 4, 4)[self.head_j].T.astype(np.float64)
        self.IBM = IBM
        inv = np.linalg.inv(IBM)
        o = inv[:3, :3] @ np.array(md['o']) + inv[:3, 3]
        self.W = W = float(md['W'])
        self.O = np.array([o[0], o[1], marks['mouth'][2]])
        # глубина рамки — точка рта на поверхности (у Блёстки — в складке под подушечками усов, ≈ 0.9 W за ними)
        L = np.array(md['line'], np.float64)
        self.L = L[np.argsort(L[:, 0])]
        self.nose = float(md['nose'])
        self.subdiv = [tuple(z) for z in md['subdiv']] if 'subdiv' in md else SUBDIV
        self.marks = marks
        self.persona = persona
        self.cfg = PERSONA[persona]
        # шарнир челюсти: за ртом и чуть выше линии (у основания ушей)
        # глубина в рамке — в единицах «W Хулигана»: у Блёстки рот уже (W меньше), а голова той же величины —
        # пороги «спереди/вглубь», шарнир и полость по глубине считаются в абсолютной мере
        self.zd = W_REF / W
        self.H = self.O + np.array([0, 0.12 * W, -0.95 * W * self.zd])
        eyes = {}
        for s in 'LR':
            inn, out, bot = (np.array(marks[f'eye{k}{s}']) for k in ('Inner', 'Outer', 'Bottom'))
            top = marks[f'eyeTop{s}']
            c = np.array([(inn[0] + out[0]) / 2, (bot[1] + top) / 2, (inn[2] + out[2]) / 2])
            eyes[s] = {'c': c, 'A': abs(out[0] - inn[0]) / 2, 'B': (top - bot[1]) / 2, 'inner': inn, 'outer': out}
        self.eyes = eyes

    def uvw(self, P):
        d = (np.asarray(P, np.float64) - self.O) / self.W
        return d[:, 0], d[:, 1], d[:, 2] / self.zd

    def line(self, u):
        """v линии рта (ω) при u; за уголками — продолжение по наклону края"""
        L = self.L
        u = np.asarray(u, np.float64)
        v = np.interp(u, L[:, 0], L[:, 1])
        k0 = (L[1, 1] - L[0, 1]) / (L[1, 0] - L[0, 0])
        k1 = (L[-1, 1] - L[-2, 1]) / (L[-1, 0] - L[-2, 0])
        v = np.where(u < L[0, 0], L[0, 1] + (u - L[0, 0]) * k0 * 0.5, v)
        v = np.where(u > L[-1, 0], L[-1, 1] + (u - L[-1, 0]) * k1 * 0.5, v)
        return v

    @property
    def cu(self):
        return float(self.L[-1, 0])  # уголок рта (u)


# ─────────────────────────── Blender: топология ───────────────────────────
def blender_topology(fr, P, Fc, UVv, Nv, vfloat, vvec, ffur):
    """подразбить морду у рта, проложить разрез по линии рта и разрезать.
    P (n,3), Fc (m,3) треугольники, UVv/Nv — по вершинам, vfloat {имя: (n,)}, vvec {имя: (n,3)}, ffur (m,) флаг меха.
    → словарь массивов новой сетки (вершины раздельны по UV) + пары вершин разреза (верх, низ)."""
    import bpy  # noqa: F401  (bmesh доступен только после bpy)
    import bmesh
    from mathutils.bvhtree import BVHTree
    from mathutils import Vector

    W = fr.W
    if os.environ.get('FACE_DEBUG'):
        d_ = (P - fr.O) / W
        print('   вход: в эллипсе', int((((d_[:, 0] / 0.85) ** 2 + ((d_[:, 1] + 0.08) / 0.45) ** 2) < 1).sum()), 'из', len(P), 'треуг', len(Fc))
    # сварка по позиции: швы UV glTF — разные вершины, в bmesh — одна вершина с разными UV углов
    # шов симметрии Tripo (x = 0) и швы атласа: копии вершин расходятся до ~1e-5 — свариваем с допуском 3e-4 W
    from scipy.spatial import cKDTree
    pairs_ = cKDTree(P).query_pairs(3e-4 * W, output_type='ndarray')
    rootv = np.arange(len(P))
    for a_, b_ in sorted(map(tuple, pairs_.tolist())):
        ra, rb = rootv[a_], rootv[b_]
        while rootv[ra] != ra:
            ra = rootv[ra]
        while rootv[rb] != rb:
            rb = rootv[rb]
        if ra != rb:
            rootv[max(ra, rb)] = min(ra, rb)
    for i in range(len(P)):
        r = i
        while rootv[r] != r:
            r = rootv[r]
        rootv[i] = r
    weld, inv = np.unique(rootv, return_inverse=True)
    inv = inv.reshape(-1)
    bm = bmesh.new()
    lf = {k: bm.verts.layers.float.new(k) for k in vfloat}
    lv = {k: bm.verts.layers.float_vector.new(k) for k in vvec}
    luv = bm.loops.layers.uv.new('uv')
    ln = bm.loops.layers.float_vector.new('n')
    lfur = bm.faces.layers.int.new('fur')
    verts = []
    for wi, oi in enumerate(weld):
        v = bm.verts.new(P[oi])
        for k, a in vfloat.items():
            v[lf[k]] = float(a[oi])
        for k, a in vvec.items():
            v[lv[k]] = Vector(a[oi])
        verts.append(v)
    bm.verts.index_update()
    for fi, (a, b, c) in enumerate(Fc):
        try:
            f = bm.faces.new((verts[inv[a]], verts[inv[b]], verts[inv[c]]))
        except ValueError:
            continue  # вырожденный / дубль
        f[lfur] = int(ffur[fi])
        for loop, oi in zip(f.loops, (a, b, c)):
            loop[luv].uv = UVv[oi]
            loop[ln] = Vector(Nv[oi])
    bm.normal_update()

    def fuvw(co):
        d = (np.array(co) - fr.O) / W
        return d[0], d[1], d[2] / fr.zd

    # щель фильтрума у Блёстки (Tripo: две стороны верхней губы не сшиты, края в 0.02 W друг от друга) — сшить, иначе
    # сквозь неё видна полость рта
    crack = []
    for v in bm.verts:
        if any(e.is_boundary for e in v.link_edges):
            uu, vv_, ww = fuvw(v.co)
            if abs(uu) < 0.06 and -0.05 < vv_ < fr.nose + 0.08 and ww > -1.2:
                crack.append(v)
    if crack:
        nv0 = len(bm.verts)
        bmesh.ops.remove_doubles(bm, verts=crack, dist=0.035 * W)
        print(f'  щель фильтрума: сшито {nv0 - len(bm.verts)} вершин')
    bm.verts.ensure_lookup_table()
    bm.normal_update()
    # исходная поверхность — для посадки точек разреза на морду
    bvh = BVHTree.FromBMesh(bm)

    def zone(rx, ry, cy, back):
        out = []
        for f in bm.faces:
            ok = True
            for v in f.verts:
                u, vv, w = fuvw(v.co)
                if (u / rx) ** 2 + ((vv - cy) / ry) ** 2 > 1 or w < -back:
                    ok = False
                    break
            if ok:
                out.append(f)
        return out

    # зоны подразбиения: по умолчанию SUBDIV; рамка рта может задать свои (Блёстка p3 — морда уже мелкой сеткой)
    for (rx, ry, cy, back) in fr.subdiv:
        fs = zone(rx, ry, cy, back)
        if os.environ.get('FACE_DEBUG'):
            uvw_ = np.array([fuvw(v.co) for v in bm.verts])
            inz = ((uvw_[:, 0] / rx) ** 2 + ((uvw_[:, 1] - cy) / ry) ** 2 <= 1)
            print('   O', fr.O, 'W', W, 'bm bbox', np.array([v.co[:] for v in bm.verts]).min(0), np.array([v.co[:] for v in bm.verts]).max(0))
            print(f'  зона подразбиения {rx}×{ry}: {len(fs)} граней; вершин в эллипсе {int(inz.sum())}, из них w<-back {int((inz & (uvw_[:, 2] < -back)).sum())}, всего {len(bm.verts)}')
        es = list({e for f in fs for e in f.edges})
        bmesh.ops.subdivide_edges(bm, edges=es, cuts=1, use_grid_fill=True)
        bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
        bm.verts.ensure_lookup_table()
    bm.verts.index_update()
    bm.edges.index_update()

    # разрез точно по линии рта: ломаная «ω» из рамки MouthD, на каждом звене — bisect_plane плоскостью через звено
    # (перпендикулярно морде) по граням этого участка; новые вершины ложатся на линию и на поверхность (по рёбрам)
    cu = fr.cu
    Lp = fr.L
    for k in range(len(Lp) - 1):
        (ua, va), (ub, vb) = Lp[k], Lp[k + 1]
        pa = fr.O + np.array([ua, va, 0]) * W
        d = np.array([ub - ua, vb - va])
        nrm = Vector((-d[1], d[0], 0)).normalized()
        lo_u, hi_u = (ua - 0.004, ub + 0.004)
        fs = []
        for f in bm.faces:
            c = f.calc_center_median()
            uu, vv_, ww = fuvw(c)
            if lo_u <= uu <= hi_u and abs(vv_ - float(fr.line(uu))) < 0.15 and ww > -0.45:
                fs.append(f)
        if not fs:
            continue
        geom = list(fs) + list({e for f in fs for e in f.edges}) + list({v for f in fs for v in f.verts})
        bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-7, plane_co=Vector(pa), plane_no=nrm)
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
    bm.verts.ensure_lookup_table()
    bm.verts.index_update()
    bm.edges.index_update()
    import heapq
    co = np.array([v.co[:] for v in bm.verts])
    u, vv, w = fr.uvw(co)
    dline = vv - fr.line(u)
    oncurve = (np.abs(dline) < 2e-3) & (np.abs(u) <= cu + 2e-3) & (w > -0.5)
    cand = np.where(oncurve)[0]
    a_i = int(cand[np.argmin(np.abs(u[cand] + cu))])
    b_i = int(cand[np.argmin(np.abs(u[cand] - cu))])
    adj = {}
    for e in bm.edges:
        i, k = e.verts[0].index, e.verts[1].index
        adj.setdefault(i, []).append((k, e))
        adj.setdefault(k, []).append((i, e))

    def cost(i, k):
        L = np.linalg.norm(co[i] - co[k]) / W
        return L * (1 + 1e4 * (abs(dline[i]) + abs(dline[k])) + 1e3 * (not oncurve[k]))

    dist = {a_i: 0.0}
    prev = {}
    pq = [(0.0, a_i)]
    while pq:
        d0, i = heapq.heappop(pq)
        if i == b_i:
            break
        if d0 > dist.get(i, 1e9):
            continue
        for k, e in adj.get(i, []):
            nd = d0 + cost(i, k)
            if nd < dist.get(k, 1e9):
                dist[k] = nd
                prev[k] = (i, e)
                heapq.heappush(pq, (nd, k))
    path_v, path_e = [b_i], []
    while path_v[-1] != a_i:
        i, e = prev[path_v[-1]]
        path_e.append(e)
        path_v.append(i)
    path_v = path_v[::-1]
    off = int((~oncurve[path_v]).sum())
    if off:
        print(f'  разрез: {off} вершин пути вне линии')
    res = bmesh.ops.split_edges(bm, edges=path_e)
    bm.verts.ensure_lookup_table()
    bm.verts.index_update()
    # пары (верх, низ): у копии разреза грани сверху или снизу линии
    groups = {}
    for v in bm.verts:
        if any(e.is_boundary for e in v.link_edges):
            k = tuple(np.round(np.array(v.co) / (W * 1e-4)).astype(np.int64))
            groups.setdefault(k, []).append(v)
    pairs = []
    corners = []
    for k, vs in groups.items():
        uu, vv_, _ = fuvw(vs[0].co)
        if abs(uu) > cu + 0.05 or abs(vv_ - float(fr.line(uu))) > 0.05:
            continue
        if len(vs) >= 2:
            # копии по сторонам (центры граней выше/ниже линии); в одной точке бывает и две пары (вершина пути
            # вне линии на соседней посажена в ту же точку)
            cy = [np.mean([np.mean([x.co[1] for x in f.verts]) for f in v.link_faces]) if v.link_faces else 0.0 for v in vs]
            order = np.argsort(cy)[::-1]  # сверху вниз: верхняя половина — верхняя губа
            h = len(vs) // 2
            for k_ in range(h):
                pairs.append((uu, vs[order[k_]].index, vs[order[len(vs) - 1 - k_]].index))
        elif len(vs) == 1:
            corners.append((uu, vs[0].index))
    pairs.sort()
    if os.environ.get('FACE_DEBUG'):
        on_path = set(path_v)
        got = {p[1] for p in pairs} | {p[2] for p in pairs}
        for k, vs in groups.items():
            uu, vv_, _ = fuvw(vs[0].co)
            if abs(uu) <= cu + 0.05 and abs(vv_ - float(fr.line(uu))) <= 0.05 and len(vs) != 2:
                print('   group', len(vs), round(uu, 3), round(vv_ - float(fr.line(uu)), 4))
        print('   path', len(path_v), 'pairs', len(pairs))
    # уголки — концы пути (не разрезаны)
    corners = [(-cu, path_v[0]), (cu, path_v[-1])]

    # экспорт: вершина glTF = (вершина bmesh, UV угла)
    bm.faces.ensure_lookup_table()
    outV, key2 = [], {}
    tris, fur = [], []
    loopN = {}
    for f in bm.faces:
        t = []
        for loop in f.loops:
            vi = loop.vert.index
            uvk = (vi, round(loop[luv].uv[0], 6), round(loop[luv].uv[1], 6))
            if uvk not in key2:
                key2[uvk] = len(outV)
                outV.append((vi, loop[luv].uv[0], loop[luv].uv[1]))
            idx = key2[uvk]
            loopN.setdefault(idx, []).append(np.array(loop[ln]))
            t.append(idx)
        tris.append(t)
        fur.append(f[lfur])
    src = np.array([o[0] for o in outV])
    out = {
        'P': np.array([bm.verts[i].co[:] for i in src], np.float64),
        'UV': np.array([[o[1], o[2]] for o in outV], np.float64),
        'N': norm(np.array([np.mean(loopN[i], 0) for i in range(len(outV))])),
        'F': np.array(tris, np.int64),
        'fur': np.array(fur, np.int8),
        'src': src,
        'f': {k: np.array([bm.verts[i][lf[k]] for i in src]) for k in vfloat},
        'v': {k: np.array([bm.verts[i][lv[k]][:] for i in src]) for k in vvec},
    }
    # пары разреза → индексы экспорта (все копии по UV)
    by_bm = {}
    for gi, b in enumerate(src):
        by_bm.setdefault(int(b), []).append(gi)
    out['pairs'] = [(uu, by_bm[a], by_bm[b], a, b) for uu, a, b in pairs]
    out['corners'] = [(uu, by_bm[c], c) for uu, c in corners]
    out['nbm'] = len(bm.verts)
    print(f'  bmesh: {len(weld)} → {len(bm.verts)} вершин, разрез {len(path_e)} рёбер, пар {len(pairs)}')
    bm.free()
    return out


def topo_side(fr, S, slit):
    """+1 — верхняя губа и морда над разрезом, −1 — нижняя (по связности сетки), 0 — дальше от рта"""
    from collections import deque
    P = S['P']
    u, v, w = fr.uvw(P)
    dv = v - fr.line(np.clip(u, -fr.cu, fr.cu))
    src = S['src']
    nb = int(src.max()) + 1
    zone_bm = np.zeros(nb, bool)
    # обход — только между крайними парами разреза (за ними верх и низ связаны через уголок)
    umax = np.abs(u[slit != 0]).max() - 0.01
    ok = (np.abs(u) < min(umax, fr.cu - 0.015)) & (np.abs(dv) < 0.45) & (w > -0.6)
    zone_bm[src[ok]] = True
    adj = [[] for _ in range(nb)]
    F = src[S['F']]
    for a, b in ((0, 1), (1, 2), (2, 0)):
        for x, y in zip(F[:, a], F[:, b]):
            adj[x].append(y)
            adj[y].append(x)
    lab = np.zeros(nb)
    par = -np.ones(nb, np.int64)
    for sgn in (1, -1):
        q = deque(int(x) for x in np.unique(src[slit == sgn]))
        for x in q:
            lab[x] = sgn
        while q:
            x = q.popleft()
            for y in adj[x]:
                if zone_bm[y] and lab[y] == 0:
                    lab[y] = sgn
                    par[y] = x
                    q.append(y)
    if os.environ.get('FACE_DEBUG'):
        # где верх «протёк» вниз: путь до первой вершины ниже линии
        dvb = np.zeros(nb); ub = np.zeros(nb)
        dvb[src] = dv; ub[src] = u
        bad = np.where((lab > 0) & (dvb < -0.15) & (np.abs(ub) < 0.2))[0]
        if len(bad):
            x = bad[0]; chain = []
            while x >= 0 and len(chain) < 200:
                chain.append((round(float(ub[x]), 3), round(float(dvb[x]), 3), int(x in set(src[slit != 0].tolist()))))
                x = par[x]
            print('   leak chain', chain[-12:])
    out = lab[src]
    out[slit != 0] = slit[slit != 0]
    return out


# ─────────────────────────── поля смещений ───────────────────────────
class Rig:
    """поля смещений рта, век и бровей (единица — W; side: +1 верхняя губа, -1 нижняя, 0 — не разрез)"""

    def __init__(self, fr):
        self.fr = fr

    def jaw_weight(self, P, side):
        fr = self.fr
        u, v, w = fr.uvw(P)
        cu = fr.cu
        s = v - fr.line(np.clip(u, -cu * 1.6, cu * 1.6))
        tau = 0.004 + 1.4 * np.maximum(0, np.abs(u) - cu * 0.95)  # за уголками — растяжение щеки на ~0.2 W, без «разрыва»
        S = sm(tau, -tau, s)
        S = np.where(side < 0, 1.0, np.where(side > 0, 0.0, S))
        lat = sm(1.05, 0.4, np.abs(u))
        # подбородок снизу: к шее гаснет; вглубь головы — тоже
        down = sm(-1.55, -1.0, v) * sm(-1.7, -1.05, w)
        return S * lat * down

    def bow(self, P, side, k):
        """нижняя губа при открытом рте — дугой «D», а не по «ω»: середина ниже, ямки ω выровнены"""
        fr = self.fr
        u, v, w = fr.uvw(P)
        cu = fr.cu
        lv = fr.line(np.clip(u, -cu, cu))
        dv = v - lv
        lo = (side < 0) | ((side == 0) & (dv < 0))
        q = np.clip(1 - (u / cu) ** 2, 0, 1)
        g = lo * np.exp(-(np.minimum(dv, 0) / 0.3) ** 2) * sm(cu + 0.05, cu - 0.1, np.abs(u)) * sm(-0.6, -0.25, w)
        dy = -0.14 * q ** 0.8 - 0.85 * (lv - float(fr.line(0.0))) * q
        D = np.zeros_like(P)
        D[:, 1] = k * dy * g * fr.W
        return D

    def jaw(self, P, side, ang):
        if ang == 0:
            return np.zeros_like(P)
        wj = self.jaw_weight(P, side)
        return self.rigid(P, ang) * wj[:, None]

    def rigid(self, P, ang):
        H = self.fr.H
        c, s = math.cos(ang), math.sin(ang)
        d = P - H
        # поворот вокруг оси x: подбородок вниз и чуть назад
        y = d[:, 1] * c - d[:, 2] * s
        z = d[:, 1] * s + d[:, 2] * c
        return np.stack([np.zeros(len(P)), y - d[:, 1], z - d[:, 2]], 1)

    def lips(self, P, side, comp):
        """губы и уголки (без челюсти): wide, round, pucker, press, tuck, lift, smile, smirk, frown, pout"""
        fr = self.fr
        W = fr.W
        u, v, w = fr.uvw(P)
        cu = fr.cu
        lv = fr.line(np.clip(u, -cu, cu))
        dv = v - lv
        under_nose = sm(fr.nose + 0.02, fr.nose - 0.06, v)
        front = sm(-0.6, -0.2, w)
        # область рта: эллипс вокруг рта; уголки — гауссианы
        r = np.sqrt((u / (cu * 1.7)) ** 2 + ((v + 0.08) / 0.55) ** 2)
        g = sm(1.0, 0.35, r) * front
        gm = g * under_nose
        sgn = np.sign(u)
        gc = np.exp(-(((np.abs(u) - cu) / 0.3) ** 2 + (dv / 0.24) ** 2)) * front
        lipzone = np.exp(-(dv / 0.12) ** 2) * sm(cu + 0.15, cu - 0.15, np.abs(u)) * front  # сами губы
        up = (side > 0) | ((side == 0) & (dv > 0))
        lo = ~up
        cosu = np.cos(np.clip(u / cu, -1, 1) * math.pi / 2)
        D = np.zeros_like(P)
        c = comp.get
        if c('wide'):
            k = c('wide')
            D[:, 0] += k * 0.12 * u * gm
            D[:, 2] += k * -0.035 * np.abs(u) * gm
            D[:, 1] += k * 0.015 * gc
        if c('round'):
            k = c('round')
            D[:, 0] += k * -0.42 * u * g * under_nose
            D[:, 2] += k * 0.07 * lipzone * cosu
            D[:, 1] += k * (0.05 * up - 0.03 * lo) * lipzone * cosu
        if c('pucker'):
            k = c('pucker')
            D[:, 0] += k * -0.55 * u * g * under_nose
            D[:, 2] += k * 0.11 * lipzone * cosu + k * 0.03 * gm
            D[:, 1] += k * (0.03 * up - 0.03 * lo) * lipzone * cosu
        if c('press'):
            k = c('press')
            gap = fr.cfg['gap']
            D[:, 1] += k * (-0.55 * gap * up + 0.55 * gap * lo) * lipzone * cosu
            D[:, 2] += k * -0.02 * lipzone
            D[:, 0] += k * -0.03 * u * gm
        if c('tuck'):
            k = c('tuck')
            z = lo * lipzone * cosu
            D[:, 1] += k * 0.045 * z
            D[:, 2] += k * -0.04 * z
            D[:, 1] += k * 0.01 * up * lipzone
        if c('lift'):
            k = c('lift')
            D[:, 1] += k * 0.05 * up * lipzone * cosu * under_nose
            D[:, 2] += k * 0.01 * up * lipzone
        if c('smile') or c('smirk'):
            for kk, sel in (('smile', np.ones_like(u)), ('smirk', (u < 0).astype(float))):
                k = c(kk)
                if not k:
                    continue
                gcs = gc * sel
                D[:, 1] += k * 0.13 * gcs
                D[:, 0] += k * 0.06 * sgn * gcs
                D[:, 2] += k * -0.04 * gcs
                # щёки над уголками приподняты и округлены
                cheek = np.exp(-(((np.abs(u) - cu * 1.15) / 0.35) ** 2 + ((v - 0.22) / 0.3) ** 2)) * front * sel
                D[:, 1] += k * 0.035 * cheek
                D[:, 2] += k * 0.03 * cheek
        if c('frown'):
            k = c('frown')
            D[:, 1] += k * -0.1 * gc
            D[:, 0] += k * -0.02 * sgn * gc
            D[:, 1] += k * 0.025 * cosu * lipzone * lo  # «∩»: середина нижней губы вверх
            D[:, 2] += k * 0.02 * cosu * lipzone * lo
        if c('pout'):
            k = c('pout')
            D[:, 2] += k * 0.1 * lipzone * cosu + k * 0.03 * gm
            D[:, 0] += k * -0.3 * u * g * under_nose
            D[:, 1] += k * (-0.05 * gc + 0.02 * lo * lipzone * cosu)
        return D * W

    def eye_field(self, P, s, kind):
        fr = self.fr
        e = fr.eyes[s]
        c, A, B = e['c'], e['A'], e['B']
        x = (P[:, 0] - c[0]) / A
        y = (P[:, 1] - c[1]) / B
        r = np.sqrt(x ** 2 + y ** 2)
        front = sm(c[2] - 2.2 * B, c[2] - 0.6 * B, P[:, 2])
        # кольцо вокруг глаза (снаружи разреза, к самому глазу — 0: яблоко и веки — отдельные меши)
        ring = sm(1.0, 1.25, r) * sm(2.6, 1.6, r) * front
        D = np.zeros_like(P)
        above = sm(0.0, 0.6, y)
        below = sm(0.0, -0.6, y)
        if kind == 'blink':
            D[:, 1] += -0.12 * B * ring * above + 0.06 * B * ring * below
        elif kind == 'squint':
            D[:, 1] += -0.06 * B * ring * above + 0.16 * B * ring * below
            D[:, 2] += 0.04 * B * ring * below
        elif kind == 'wide':
            D[:, 1] += 0.12 * B * ring * above - 0.05 * B * ring * below
        return D

    def brow_angry(self, P):
        fr = self.fr
        D = np.zeros_like(P)
        for s in 'LR':
            e = fr.eyes[s]
            c, A, B = e['c'], e['A'], e['B']
            inn = e['inner']
            x = (P[:, 0] - c[0]) / A
            # внутренний край брови вниз и к носу, внешний — чуть вверх
            t = (P[:, 0] - inn[0]) / (e['outer'][0] - inn[0])  # 0 — внутренний, 1 — внешний
            y = (P[:, 1] - (c[1] + 1.6 * B)) / (0.9 * B)
            g = np.exp(-y ** 2) * sm(1.9, 1.2, np.abs(x)) * sm(c[2] - 2.5 * B, c[2] - 0.8 * B, P[:, 2])
            D[:, 1] += g * B * (-0.32 * (1 - np.clip(t, 0, 1)) + 0.12 * np.clip(t, 0, 1))
            D[:, 0] += g * B * 0.1 * (1 - np.clip(t, 0, 1)) * -np.sign(c[0])
        return D


def eye_guard(fr, P):
    """маска «не трогать глазницу»: 0 в отверстии глаза и на его кромке (эллипс r ≤ EYE_GUARD[0]), 1 — дальше
    EYE_GUARD[1]; вглубь головы за глазом — 1 (там нечего прятать)"""
    m = np.ones(len(P))
    for s in 'LR':
        e = fr.eyes[s]
        c, A, B = e['c'], e['A'], e['B']
        r = np.sqrt(((P[:, 0] - c[0]) / A) ** 2 + ((P[:, 1] - c[1]) / B) ** 2)
        front = sm(c[2] - 2.6 * B, c[2] - 1.4 * B, P[:, 2])
        m = np.minimum(m, 1 - (1 - sm(EYE_GUARD[0], EYE_GUARD[1], r)) * front)
    return m


def profile_fix(fr, T, P, side, pairs):
    """Форма проёма по рефу: нижняя губа опускается дугой только в пределах open (полуширина, u), за ней губы сомкнуты
    (и щель покоя закрыта); верхняя губа в середине чуть поднимается (arch). Поправка — по вертикали, к краю губ
    полная, вниз по подбородку и вверх к носу гаснет: подбородок идёт за челюстью как был, уголки мягкие."""
    W = fr.W
    u, v, w = fr.uvw(P)
    cu = fr.cu
    dv = v - fr.line(np.clip(u, -cu, cu))
    up_i = np.array([p[1][0] for p in pairs])
    lo_i = np.array([p[2][0] for p in pairs])
    pu_ = np.array([p[0] for p in pairs])
    order = np.argsort(pu_)
    pu_, up_i, lo_i = pu_[order], up_i[order], lo_i[order]
    gap = fr.cfg['gap']
    qrest = np.cos(np.clip(u / cu, -1, 1) * math.pi / 2)
    near = sm(cu + 0.12, cu - 0.02, np.abs(u)) * sm(-0.6, -0.25, w)
    lo = (side < 0) | ((side == 0) & (dv < 0))
    fall_lo = np.exp(-(np.minimum(dv, 0) / 0.28) ** 2) * lo * near
    fall_up = np.exp(-(np.maximum(dv, 0) / 0.16) ** 2) * (~lo) * near * sm(fr.nose + 0.02, fr.nose - 0.05, v)
    for k, comp in MOUTH.items():
        h = comp.get('open')
        if not h:
            continue
        d = T[k]
        ylo = np.interp(u, pu_, d[lo_i, 1])  # текущее смещение края нижней губы над этой u
        yup = np.interp(u, pu_, d[up_i, 1])
        c = int(np.argmin(np.abs(pu_)))
        drop = min(0.0, float(d[lo_i[c], 1] - d[up_i[c], 1]))  # раскрытие в середине (< 0)
        prof = sm(h * 1.15, 0.0, np.abs(u)) ** 0.7  # купол без излома на краю — мягкие уголки
        # цель: край нижней губы = верхняя губа + раскрытие·профиль; за проёмом — сомкнуто (щель покоя тоже)
        close = 0.5 * gap * qrest * W * (1 - prof)
        tgt_lo = yup + drop * prof + close
        corr_lo = tgt_lo - ylo
        arch = comp.get('arch', 0) * (-drop) * prof
        # круглые формы: «ω» верхней губы в проёме разглажена в дугу (без острого пика под носом)
        flat = comp.get('flat', 0) * (float(fr.line(0.0)) - fr.line(np.clip(u, -cu, cu))) * W * prof
        flat = np.where(flat > 0, flat * 0.0, flat) + np.where(flat > 0, flat, 0)
        corr_up = arch + flat - close
        d[:, 1] += corr_lo * fall_lo + corr_up * fall_up
        # по глубине — край нижней губы за проёмом тоже к верхней (нет «ступеньки» в уголках)
        zlo = np.interp(u, pu_, d[lo_i, 2])
        zup = np.interp(u, pu_, d[up_i, 2])
        d[:, 2] += (zup - zlo) * (1 - prof) * fall_lo


def smooth_corners(fr, T, P, F, keys, iters, lam=0.5, r=0.14):
    """Сглаживание смещений ключей рта в уголках (лапласиан по сетке; копии вершин по UV сварены по положению): в
    уголке разрез кончается, верх и низ связаны — у Добряка там «ступенька»-язычок кожи в открытых формах. Зона —
    круг ~r·W у каждого уголка, к краю сила гаснет; кромка губ между уголками не трогается."""
    import scipy.sparse as sps
    W = fr.W
    key = np.round(P / (1e-5 * W)).astype(np.int64)
    _, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
    inv = inv.ravel()
    n = len(first)
    E = np.concatenate([F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]])
    E = inv[E]
    E = E[E[:, 0] != E[:, 1]]
    A = sps.coo_matrix((np.ones(len(E) * 2), (np.r_[E[:, 0], E[:, 1]], np.r_[E[:, 1], E[:, 0]])), shape=(n, n)).tocsr()
    A.data[:] = 1
    An = sps.diags(1 / np.maximum(np.asarray(A.sum(1)).ravel(), 1)) @ A
    u, v, w = fr.uvw(P[first])
    cu = fr.cu
    vc = float(fr.line(cu))
    m = np.exp(-(((np.abs(u) - cu) / r) ** 2 + ((v - vc) / r) ** 2)) * sm(-0.6, -0.3, w)
    m = (lam * m)[:, None]
    for k in keys:
        D = T[k][first].copy()
        for _ in range(iters):
            D += m * (An @ D - D)
        T[k] = D[inv]


def build_targets(fr, rig, P, side, ang_d):
    """словарь ключ → смещения для точек P (side — губа)"""
    T = {}
    for k, comp in MOUTH.items():
        d = rig.lips(P, side, comp)
        if comp.get('jaw'):
            d = d + rig.jaw(P, side, comp['jaw'] * ang_d) + rig.bow(P, side, comp['jaw'])
        T[k] = d
    T['blink_L'] = rig.eye_field(P, 'L', 'blink')
    T['blink_R'] = rig.eye_field(P, 'R', 'blink')
    T['squint'] = rig.eye_field(P, 'L', 'squint') + rig.eye_field(P, 'R', 'squint')
    T['wide'] = rig.eye_field(P, 'L', 'wide') + rig.eye_field(P, 'R', 'wide')
    T['brow_angry'] = rig.brow_angry(P)
    return T


# ─────────────────────────── полость, клычки, язык ───────────────────────────
def cavity(fr, rig, S, T_skin, ang_d, head_j, body=None):
    """MouthCavity: кольца от края губ вглубь. Возвращает меши (V, N, F, col, skinJ, skinW, targets)"""
    W = fr.W
    cfg = fr.cfg
    P = S['P']
    pairs = S['pairs']
    corners = S['corners']
    # контур: уголок L → верх по u → уголок R → низ обратно
    cl, cr = corners[0][1][0], corners[1][1][0]
    upper = [p[1][0] for p in pairs]
    lower = [p[2][0] for p in pairs]
    us = [p[0] for p in pairs]
    contour = [cl] + upper + [cr] + lower[::-1]
    cu_ = [-fr.cu] + us + [fr.cu] + us[::-1]
    sides = [0] + [1] * len(upper) + [0] + [-1] * len(lower)
    n = len(contour)
    ts = [0.0, 0.07, 0.2, 0.45, 0.75, 1.0]
    depth = cfg['depth']
    V, cols, colsrc, tt, sd = [], [], [], [], []
    surf = front_surface(fr, P)
    # кромка и первое кольцо — по всем вершинам края губ, глубже — каждая третья (уголки всегда): меньше вершин и ключей
    keep_cols = sorted(set(range(0, n, 3)) | {0, len(upper) + 1})
    cols_of = [list(range(n)) if r < 2 else keep_cols for r in range(len(ts))]
    ring_at = []
    for r, t in enumerate(ts):
        ring_at.append({})
        for i in cols_of[r]:
            ring_at[r][i] = len(V)
            p0 = P[contour[i]]
            uu = cu_[i]
            s = sides[i]
            q = np.sqrt(max(0.0, 1 - (uu / fr.cu) ** 2))
            # каждое кольцо — от края губ к общей «задней стенке» (центр рта, глубина depth): уголки сходятся к оси,
            # верх поднимается сводом, низ (дно) уходит вниз быстро — языку есть место
            lv = float(fr.line(np.clip(uu, -fr.cu, fr.cu)))
            if s > 0:
                vt = lv + 0.07 * q
            elif s < 0:
                vt = lv - 0.2 * q
            else:
                vt = lv
            tgt = fr.O + np.array([uu * 0.5, vt, -depth * fr.zd]) * W
            fy = t ** (0.4 if s < 0 else 0.9)
            if s < 0 and t < 0.2:
                fy *= cfg.get('rim_drop', 1.0)
            fxz = t ** 0.9
            p = np.array([p0[0] + (tgt[0] - p0[0]) * fxz, p0[1] + (tgt[1] - p0[1]) * fy, p0[2] + (tgt[2] - p0[2]) * fxz])
            if t > 0:
                p[2] -= 0.012 * W
            V.append(p)
            colsrc.append(contour[i])
            tt.append(t)
            sd.append(s)
    # задняя стенка — центр
    back = fr.O + np.array([0, -0.08, -depth * 1.02 * fr.zd]) * W
    V.append(back)
    colsrc.append(contour[0])
    tt.append(1.0)
    sd.append(0)
    V = np.array(V)
    tt = np.array(tt)
    sd = np.array(sd)
    # не дальше кожи: глубже края губ полость всегда за поверхностью морды (≥ 0.05 W) — щёки, подбородок
    zs = surf(V[:, 0], V[:, 1])
    deep = (tt >= 0.2) & np.isfinite(zs)
    V[deep, 2] = np.minimum(V[deep, 2], zs[deep] - 0.05 * W)
    # и не ближе 0.035 W к коже сверху (подушечки усов нависают над ртом — у Блёстки свод торчал сквозь них), снизу,
    # спереди и по бокам; кромка губ (t = 0) и первое кольцо остаются у края губ
    bvh = skin_bvh(S)
    dirs = [(0, 1, 0), (0, -1, 0), (0, 0, 1), (1, 0, 0), (-1, 0, 0), (0, 0.7071, 0.7071), (0, -0.7071, 0.7071)]
    inner = tt >= 0.2
    if body is not None:
        cb = closed_bvh(S, body, S['pairs'])
        V[tt > 0.05], nmv = push_inside(V[tt > 0.05], cb, W)
        if nmv:
            print(f'  полость: {nmv} вершин внутрь головы')
    V[inner] = keep_inside(V[inner], bvh, 0.035 * W, dirs)
    F = []
    for r in range(len(ts) - 1):
        A_, B_ = cols_of[r], cols_of[r + 1]
        if A_ == B_:
            for k_ in range(len(A_)):
                i, i2 = A_[k_], A_[(k_ + 1) % len(A_)]
                a, b = ring_at[r][i], ring_at[r][i2]
                c, d = ring_at[r + 1][i], ring_at[r + 1][i2]
                F += [[a, b, d], [a, d, c]]
        else:
            # B ⊂ A: между соседними столбцами B — веер из столбцов A
            for k_ in range(len(B_)):
                b0, b1 = B_[k_], B_[(k_ + 1) % len(B_)]
                seg = [b0]
                j_ = b0
                while j_ != b1:
                    j_ = (j_ + 1) % n
                    seg.append(j_)
                for x0, x1 in zip(seg[:-1], seg[1:]):
                    F.append([ring_at[r][x0], ring_at[r][x1], ring_at[r + 1][b0]])
                F.append([ring_at[r + 1][b0], ring_at[r][b1], ring_at[r + 1][b1]])
    bi = len(V) - 1
    lastc = cols_of[-1]
    for k_ in range(len(lastc)):
        F.append([ring_at[-1][lastc[k_]], ring_at[-1][lastc[(k_ + 1) % len(lastc)]], bi])
    F = np.array(F)
    # цвет: кромка губ — тёмно-розовая, глубже — почти чёрная, низ (у языка) — теплее
    lip = np.array([0.46, 0.27, 0.32])  # кромка: тонкая линия «ω» в покое — не чёрная щель
    deep = np.array([0.06, 0.012, 0.02])
    floor = np.array([0.3, 0.07, 0.09])
    k = sm(0.0, 0.2, tt)[:, None]
    col = lip * (1 - k) + deep * k
    fl = (sd < 0)[:, None] * sm(0.1, 0.5, tt)[:, None] * sm(1.0, 0.6, tt)[:, None]
    col = col * (1 - fl * 0.7) + floor * fl * 0.7
    # нормали — внутрь полости (к оси рта)
    axis = np.column_stack([np.full(len(V), fr.O[0]), np.full(len(V), fr.O[1] - 0.06 * W), V[:, 2] + 0.2 * W])
    # ориентация треугольников: нормаль грани к оси
    fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    cen = V[F].mean(1)
    ax_c = np.column_stack([np.full(len(F), fr.O[0]), np.full(len(F), fr.O[1] - 0.06 * W), cen[:, 2] + 0.2 * W])
    flip = (fn * (ax_c - cen)).sum(1) < 0
    F[flip] = F[flip][:, [0, 2, 1]]
    N = vertex_normals(V, F)
    bad = (N * (axis - V)).sum(1) < 0
    N[bad] *= -1
    # ключи: край = смещения кожи губ; глубже — верх гаснет, низ идёт за челюстью
    a_lo = sm(0.0, 0.45, tt)[:, None]
    a_up = sm(0.0, 0.7, tt)[:, None]
    targets = {}
    side_eval = np.where(sd < 0, -1, np.where(sd > 0, 1, 0))
    for key, d_skin in T_skin.items():
        rim = d_skin[np.array(colsrc)]
        comp = MOUTH.get(key, {})
        ang = comp.get('jaw', 0) * ang_d
        rig_d = (rig.jaw(V, -np.ones(len(V)), ang) + rig.bow(V, -np.ones(len(V)), comp.get('jaw', 0))) if ang else np.zeros_like(V)  # как кожа подбородка в этой точке
        d = np.where(sd[:, None] < 0, (1 - a_lo) * rim + a_lo * rig_d, (1 - a_up) * rim)
        d[sd == 0] = (rim * (1 - a_up) + 0.5 * a_lo * rig_d)[sd == 0]
        if key in MOUTH:
            targets[key] = d
        elif np.abs(rim).max() > 0:
            targets[key] = d * (1 - a_up)  # щёки, нос: край губ, глубже — нет
    # первое кольцо низа и уголков в каждом ключе — за кожей губы, что над ним (луч вдоль z), с запасом rim_back·W:
    # иначе лента «кромка → кольцо» выходит перед завёрнутой внутрь нижней губой зубцами (Добряк)
    rb = cfg.get('rim_back')
    if rb:
        ring1 = np.where((tt > 0) & (tt < 0.2) & (sd <= 0))[0]
        cen = V[tt == 0].mean(0)
        Fm = S['F'][(np.linalg.norm(P - cen, axis=1) < 1.2 * W)[S['F']].all(1)]
        nfix = 0
        for key in list(targets) + [None]:
            Q = P + (T_skin[key] if key else 0)
            d = targets[key] if key else np.zeros_like(V)
            pts = V[ring1] + d[ring1]
            zs = skin_z_under(Q, Fm, pts, W)
            over = np.where(np.isfinite(zs), pts[:, 2] - (zs - rb * W), -1)
            m = over > 0
            nfix += int(m.sum())
            if key:
                targets[key][ring1[m], 2] -= over[m]
            else:
                V[ring1[m], 2] -= over[m]
        if nfix:
            print(f'  полость: первое кольцо за губой — {nfix} поправок')
    return {'V': V, 'N': N, 'F': F, 'col': col, 'src': np.array(colsrc), 'targets': targets, 't': tt, 'side': sd}


def skin_z_under(Q, F, pts, W):
    """z ближайшей к камере (+z) кожи над каждой точкой (луч вдоль z, только поверхности не дальше 0.5 W за точкой);
    nan — кожи нет (проём рта)"""
    A, B, C = Q[F[:, 0]], Q[F[:, 1]], Q[F[:, 2]]
    v0, v1 = B[:, :2] - A[:, :2], C[:, :2] - A[:, :2]
    den = v0[:, 0] * v1[:, 1] - v1[:, 0] * v0[:, 1]
    ok = np.abs(den) > 1e-14
    den = np.where(ok, den, 1)
    out = np.full(len(pts), np.nan)
    for i, p in enumerate(pts):
        v2 = p[:2] - A[:, :2]
        a = (v2[:, 0] * v1[:, 1] - v1[:, 0] * v2[:, 1]) / den
        b = (v0[:, 0] * v2[:, 1] - v2[:, 0] * v0[:, 1]) / den
        m = ok & (a >= 0) & (b >= 0) & (a + b <= 1)
        if m.any():
            z = A[m, 2] + a[m] * (B[m, 2] - A[m, 2]) + b[m] * (C[m, 2] - A[m, 2])
            z = z[z > p[2] - 0.5 * W]
            if len(z):
                out[i] = z.max()
    return out


def front_surface(fr, P):
    """z передней поверхности морды над точкой (x, y): максимум z вершин FaceSkin в круге 0.07 W; нет — nan"""
    from scipy.spatial import cKDTree
    tree = cKDTree(P[:, :2])
    r = 0.07 * fr.W

    def f(x, y):
        x = np.atleast_1d(x)
        y = np.atleast_1d(y)
        out = np.full(len(x), np.nan)
        for i, nb in enumerate(tree.query_ball_point(np.column_stack([x, y]), r)):
            if nb:
                out[i] = P[nb, 2].max()
        return out
    return f


def skin_bvh(S):
    import bpy  # noqa: F401
    from mathutils.bvhtree import BVHTree
    return BVHTree.FromPolygons([tuple(p) for p in S['P']], [tuple(int(x) for x in f) for f in S['F']])


def keep_inside(Q, bvh, margin, dirs, iters=3):
    """точки полости/языка — не ближе margin к коже морды по направлениям dirs (вверх — под подушечками усов,
    вниз — над подбородком, вперёд, в стороны): если кожа ближе, точка отходит назад по этому направлению"""
    from mathutils import Vector
    Q = np.array(Q, np.float64)
    for _ in range(iters):
        moved = False
        for i in range(len(Q)):
            o = Vector(Q[i])
            for d in dirs:
                dv = Vector(d)
                hit = bvh.ray_cast(o - dv * 1e-6, dv, margin)
                if hit[0] is not None:
                    Q[i] -= np.array(d) * (margin - hit[3])
                    o = Vector(Q[i])
                    moved = True
        if not moved:
            break
    return Q


def closed_bvh(S, body, rim_pairs):
    """морда + тело + «лента» щели рта (в покое) — замкнутая поверхность для проверки «внутри головы»"""
    import bpy  # noqa: F401
    from mathutils.bvhtree import BVHTree
    Ps = S['P']
    Pb, Fb = body
    cl, cr = S['corners'][0][1][0], S['corners'][1][1][0]
    up_ = [cl] + [p[1][0] for p in rim_pairs] + [cr]
    lo_ = [cl] + [p[2][0] for p in rim_pairs] + [cr]
    cap = []
    for i in range(len(up_) - 1):
        cap += [[up_[i], up_[i + 1], lo_[i + 1]], [up_[i], lo_[i + 1], lo_[i]]]
    cap = [c for c in cap if len(set(c)) == 3]
    V = np.concatenate([Ps, Pb])
    F = np.concatenate([S['F'], Fb + len(Ps), np.array(cap)])
    return BVHTree.FromPolygons([tuple(p) for p in V], [tuple(int(x) for x in f) for f in F])


def is_inside(bvh, p, W):
    """чётность пересечений по трём лучам (большинство)"""
    from mathutils import Vector
    votes = 0
    for d in ((1, 0, 0), (0, 1, 0.3), (0, -0.2, -1)):
        dv = Vector(d).normalized()
        o = Vector(p)
        n = 0
        for _ in range(64):
            hit = bvh.ray_cast(o + dv * (1e-5 * W), dv, 10.0)
            if hit[0] is None:
                break
            n += 1
            o = hit[0]
        votes += n % 2
    return votes >= 2


def push_inside(Q, bvh, W, step=0.02, back=(0, 0, -1), limit=1.5):
    """точки снаружи головы — назад (−z), пока не окажутся внутри (у Блёстки под нависающими подушечками усов)"""
    Q = np.array(Q, np.float64)
    b = np.array(back, np.float64)
    moved = 0
    for i in range(len(Q)):
        k = 0
        while not is_inside(bvh, Q[i], W) and k * step < limit:
            Q[i] += b * step * W
            k += 1
        moved += k > 0
    return Q, moved


def vertex_normals(V, F):
    fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    N = np.zeros_like(V)
    for k in range(3):
        np.add.at(N, F[:, k], fn)
    return norm(N)


def fangs(fr, rig, S, cav, T_skin, ang_d, body=None):
    """два верхних клычка: конусы от кромки верхней губы вниз (чуть назад)"""
    W = fr.W
    L, du = fr.cfg['fang']
    P = S['P']
    V, F, src = [], [], []
    seg = 8
    for sgn in (-1, 1):
        u0 = sgn * du
        # ближайшая верхняя пара разреза
        pi = min(range(len(S['pairs'])), key=lambda i: abs(S['pairs'][i][0] - u0))
        top_i = S['pairs'][pi][1][0]
        base = P[top_i] + np.array([0, 0.012, -0.05]) * W  # над кромкой губы: в покое не виден в щели
        tip = base + np.array([sgn * -0.008, -REST_FANG, -0.008]) * W
        b0 = len(V)
        for k in range(seg):
            a = 2 * math.pi * k / seg
            V.append(base + np.array([math.cos(a) * 0.034, 0.006, math.sin(a) * 0.02]) * W)
            src.append(top_i)
        V.append(tip)
        src.append(top_i)
        V.append(base + np.array([0, 0.01, 0]) * W)
        src.append(top_i)
        ti, ci = b0 + seg, b0 + seg + 1
        for k in range(seg):
            a, b = b0 + k, b0 + (k + 1) % seg
            F.append([a, b, ti])
            F.append([b, a, ci])
    V = np.array(V)
    F = np.array(F)
    if body is not None:
        # клычок целиком внутри головы (у Блёстки губа под подушечками тонкая — основание выходило сквозь неё)
        cb = closed_bvh(S, body, S['pairs'])
        V, nmv = push_inside(V, cb, W, step=0.01)
        V = keep_inside(V, skin_bvh(S), 0.01 * W, [(0, 1, 0), (0, 0, 1), (0, 0.7071, 0.7071)])
        # и не видны спереди мимо кожи/щели губ: каждый клычок целиком назад, пока луч вперёд упирается в кожу
        from mathutils import Vector
        per = len(V) // 2
        for f0 in (0, per):
            z0 = V[f0:f0 + per, 2].copy()
            vis = True
            for _ in range(8):
                vis = any(cb.ray_cast(Vector(V[i]) + Vector((0, 0, 1e-5)), Vector((0, 0, 1)), 10.0)[0] is None for i in range(f0, f0 + per))
                if not vis:
                    break
                V[f0:f0 + per, 2] -= 0.01 * W
            if vis:  # не помогло (луч уходит мимо губ под подушечками) — оставить на месте, в отчёте видно
                V[f0:f0 + per, 2] = z0
    # наружу от оси конуса
    N = vertex_normals(V, F)
    targets = {}
    tipm = np.zeros(len(V), bool)
    tipm[seg::seg + 2] = True  # кончики (индексы seg и 2·seg+2)
    for key, d in T_skin.items():
        dd = d[np.array(src)].copy()
        jk = MOUTH.get(key, {}).get('jaw', 0) + 0.6 * MOUTH.get(key, {}).get('lift', 0)
        # в покое клычок короткий (не виден в щели губ), с раскрытием рта — во всю длину
        dd[tipm, 1] -= (L - REST_FANG) * W * min(1.0, 2.2 * jk)
        if np.abs(dd).max() > 0:
            targets[key] = dd
    return {'V': V, 'N': N, 'F': F, 'src': np.array(src), 'targets': targets}


def tongue(fr, rig, S, cav, ang_d, body=None):
    """язык: плоский снизу (лежит на дне полости), купол сверху с бороздкой; кончик — у нижней губы"""
    W = fr.W
    rx, rz = fr.cfg['tongue']
    depth = fr.cfg['depth']
    cz = fr.O[2] - (0.07 + rz) * W
    nu, nv = 16, 18
    V = []
    for i in range(nv + 1):
        th = math.pi * i / nv  # от кончика (спереди) к корню
        for k in range(nu):
            ph = 2 * math.pi * k / nu
            x = math.sin(th) * math.cos(ph)
            y = math.sin(th) * math.sin(ph)
            z = math.cos(th)
            V.append([x, y, z])
    V = np.array(V)
    x, y, z = V[:, 0], V[:, 1], V[:, 2]
    X = fr.O[0] + x * rx * W * (1 + 0.08 * z)
    Z = cz + z * rz * W
    t = np.clip((fr.O[2] - Z) / (depth * W * fr.zd), 0, 1)
    u = (X - fr.O[0]) / W
    q = np.sqrt(np.clip(1 - (u / fr.cu) ** 2, 0, 1))
    floor_v = fr.line(np.clip(u, -fr.cu, fr.cu)) - 0.2 * q * t ** 0.4
    s = np.sqrt(np.clip(1 - x ** 2 - z ** 2, 0, 1))  # «толщина» эллипсоида в точке
    top = np.where(y > 0, y, 0) / np.maximum(s, 1e-6)  # 0..1 по верху
    groove = 0.018 * np.exp(-(x / 0.22) ** 2) * (y > 0)
    th_ = (0.12 * s ** 0.7) * np.where(y > 0, np.clip(top, 0, 1) * 1.0, 0) + 0.012 * np.clip(-y, 0, 1)
    Y = fr.O[1] + (floor_v + 0.012 + 0.02 * s + th_ - groove * s - TONGUE_DROP) * W
    V = np.column_stack([X, Y, Z])
    # язык целиком за кожей морды (≥ 0.05 W): у узкой выпуклой морды (Блёстка) — глубже
    zs = front_surface(fr, S['P'])(V[:, 0], V[:, 1])
    viol = np.nanmax(V[:, 2] - (zs - 0.05 * W)) if np.isfinite(zs).any() else 0
    if viol > 0:
        V[:, 2] -= viol
    if body is not None:
        V, nmv = push_inside(V, closed_bvh(S, body, S['pairs']), W)
        if nmv:
            print(f'  язык: {nmv} вершин внутрь головы')
    V = keep_inside(V, skin_bvh(S), 0.03 * W, [(0, -1, 0), (0, 1, 0), (0, 0, 1), (1, 0, 0), (-1, 0, 0), (0, -0.7071, 0.7071)])
    F = []
    for i in range(nv):
        for k in range(nu):
            a = i * nu + k
            b = i * nu + (k + 1) % nu
            c = (i + 1) * nu + k
            d = (i + 1) * nu + (k + 1) % nu
            F += [[a, c, d], [a, d, b]]
    F = np.array(F)
    N = vertex_normals(V, F)
    cen = V.mean(0)
    if ((N * (V - cen)).sum(1) < 0).mean() > 0.5:
        F = F[:, [0, 2, 1]]
        N = vertex_normals(V, F)
    # цвет: розовый, к корню темнее, бороздка темнее
    zr = (V[:, 2] - cz) / (rz * W)
    col = np.array([0.88, 0.38, 0.45])[None, :] * (0.65 + 0.35 * sm(-1, 0.6, zr))[:, None]
    tip_k = sm(0.2, 1.0, zr)  # передняя часть
    targets = {}
    for key, comp in MOUTH.items():
        ang = comp.get('jaw', 0) * ang_d
        d = (rig.jaw(V, -np.ones(len(V)), ang) + rig.bow(V, -np.ones(len(V)), comp.get('jaw', 0))) if ang else np.zeros_like(V)  # за челюстью, как кожа под ним
        if comp.get('tongue_out'):
            k = comp['tongue_out']
            fwd = (0.24 * (0.45 + 0.55 * tip_k)) * W
            d = d + np.stack([np.zeros(len(V)), 0.06 * W * np.ones(len(V)) - 0.07 * W * tip_k ** 2, fwd], 1) * k
            d[:, 0] += (V[:, 0] - fr.O[0]) * 0.12 * tip_k * k
        if comp.get('tongue_up'):
            k = comp['tongue_up']
            d = d + np.stack([np.zeros(len(V)), 0.1 * W * tip_k ** 1.5, 0.01 * W * tip_k], 1) * k
        if comp.get('pucker') or comp.get('round'):
            d[:, 2] += -0.03 * W * (comp.get('pucker', 0) + comp.get('round', 0))
        targets[key] = d
    return {'V': V, 'N': N, 'F': F, 'col': col, 'targets': targets}


# ─────────────────────────── привязка к морде ───────────────────────────
def bind_nearest(Pq, Ps, Fs, k=1):
    """ближайшая точка поверхности (по вершинам и центрам граней — грубо, но устойчиво): (индексы вершин, веса)"""
    from scipy.spatial import cKDTree
    tree = cKDTree(Ps)
    d, i = tree.query(Pq, k=4)
    w = 1 / (d + 1e-6) ** 2
    w /= w.sum(1, keepdims=True)
    return i, w, d[:, 0]


def components(I, n):
    """связные куски сетки по треугольникам → метка куска у вершины"""
    par = np.arange(n)

    def find(x):
        while par[x] != x:
            par[x] = par[par[x]]
            x = par[x]
        return x
    for t_ in I:
        r0 = find(int(t_[0]))
        for x in t_[1:]:
            rx = find(int(x))
            if rx != r0:
                par[rx] = r0
    return np.array([find(i) for i in range(n)])


def apply_bind(T, idx, w):
    return (T[idx] * w[:, :, None]).sum(1)


def add_sparse_q(g, n, disp, W):
    """sparse-ключ: малые смещения (< EPS) не пишем, индексы — uint16, если хватает"""
    d = np.asarray(disp, np.float64)
    keep = np.abs(d).max(1) > EPS * max(W, W_REF)  # порог в абсолютной мере (у Блёстки W меньше)
    idx = np.where(keep)[0]
    if not len(idx):
        idx = np.array([0])
    # значения — int16 normalized (KHR_mesh_quantization, шаг 1/32767 ≈ 0.03 мм при росте кота 1). Сборка
    # (scripts/build/model-opt.mjs) раскрывает такие sparse в плотные int16 — их сжимает meshopt (gltf-transform
    # писал sparse int16 нулями)
    vals = np.clip(np.round(d[idx] * 32767), -32767, 32767).astype(np.int16)
    it = (np.uint16, 5123) if n < 65536 else (np.uint32, 5125)
    vi_i = g._raw(idx.astype(it[0]).tobytes() + (b'\0\0' if it[1] == 5123 and len(idx) % 2 else b''))
    vi_v = g._raw(np.ascontiguousarray(vals).tobytes() + (b'\0\0' if (len(idx) * 6) % 4 else b''))
    real = vals.astype(np.float64) / 32767
    acc = {'componentType': 5122, 'normalized': True, 'count': int(n), 'type': 'VEC3',
           'min': np.minimum(real.min(0), 0).tolist(), 'max': np.maximum(real.max(0), 0).tolist(),
           'sparse': {'count': int(len(idx)), 'indices': {'bufferView': vi_i, 'componentType': it[1]}, 'values': {'bufferView': vi_v}}}
    g.j['accessors'].append(acc)
    ext = g.j.setdefault('extensionsUsed', [])
    if 'KHR_mesh_quantization' not in ext:
        ext.append('KHR_mesh_quantization')
        g.j.setdefault('extensionsRequired', []).append('KHR_mesh_quantization')
    return len(g.j['accessors']) - 1


# ─────────────────────────── основная сборка ───────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('persona')
    ap.add_argument('src')
    ap.add_argument('dst')
    ap.add_argument('--report', default=None)
    a = ap.parse_args()
    g = G2(a.src)
    j = g.j
    if j.get('asset', {}).get('extras', {}).get(TAG):
        sys.exit('уже с ригом лица (faceRig) — запускать по p1')
    fr = Frame(g, a.persona)
    rig = Rig(fr)
    W = fr.W
    ang_d = fr.cfg['jaw']

    # ── тело и его мех
    body_mi = next(i for i, m in enumerate(j['meshes']) if m['name'].startswith('tripo_mesh'))
    fur_mi = next(i for i, m in enumerate(j['meshes']) if m['name'] == 'BD_FurShell')
    bp = j['meshes'][body_mi]['primitives'][0]
    fp = j['meshes'][fur_mi]['primitives'][0]
    A = bp['attributes']
    P = g.acc(A['POSITION']).astype(np.float64)
    N = g.acc(A['NORMAL']).astype(np.float64)
    UV = g.acc(A['TEXCOORD_0']).astype(np.float64)
    Jt = g.acc(A['JOINTS_0']).astype(np.int64)
    Wt = g.acc(A['WEIGHTS_0']).astype(np.float64)
    if Wt.max() > 1.5:
        Wt = Wt / 255.0
    FL = g.acc(fp['attributes']['_FURLEN']).astype(np.float64)
    Ib = g.acc(bp['indices']).reshape(-1, 3).astype(np.int64)
    If = g.acc(fp['indices']).reshape(-1, 3).astype(np.int64)
    nP = len(P)
    names = j['meshes'][body_mi]['extras']['targetNames']
    oldT = {k: acc_dense(g, bp['targets'][names.index(k)]['POSITION'], nP) for k in KEEP_KEYS if k in names}
    hj = fr.head_j
    hw = (Wt * (Jt == hj)).sum(1)

    # ── морда: треугольники с весом головы ≥ 0.5 и спереди (за шарниром челюсти)
    reg_v = (hw >= 0.5) & (P[:, 2] > fr.O[2] - 1.0 * W * fr.zd) & (P[:, 1] > fr.O[1] - 1.5 * W)
    reg_t = reg_v[Ib].all(1)
    furset = {tuple(sorted(t)) for t in If.tolist()}
    Fc = Ib[reg_t]
    ffur = np.array([tuple(sorted(t)) in furset for t in Fc.tolist()], np.int8)
    used = np.unique(Fc)
    remap = -np.ones(nP, np.int64)
    remap[used] = np.arange(len(used))
    Fl = remap[Fc]
    js = sorted(set(np.unique(Jt[used][Wt[used] > 0]).tolist()) | {hj})
    vfloat = {f'j{k}': (Wt[used] * (Jt[used] == k)).sum(1) for k in js}
    vfloat['furlen'] = FL[used]
    vfloat['orig'] = used.astype(np.float64)  # исходный индекс (у новых вершин — смесь, не нужен)
    vvec = {k: d[used] for k, d in oldT.items()}
    print(f'{a.persona}: морда {len(used)} вершин / {len(Fc)} треугольников (мех {ffur.sum()}), кости {len(js)}')
    S = blender_topology(fr, P[used], Fl, UV[used], N[used], vfloat, vvec, ffur)
    Ps = S['P']
    n_s = len(Ps)
    # граница FaceSkin (рёбра одного треугольника) — там смещения ровно 0
    E = np.concatenate([S['F'][:, [0, 1]], S['F'][:, [1, 2]], S['F'][:, [2, 0]]])
    srcE = np.sort(S['src'][E], 1)
    uq, cnt = np.unique(srcE, axis=0, return_counts=True)
    bnd_bm = np.unique(uq[cnt == 1])
    # разрез тоже граница (по bmesh) — исключить вершины разреза
    cut_bm = {p[3] for p in S['pairs']} | {p[4] for p in S['pairs']} | {c[2] for c in S['corners']}
    bnd_bm = np.array([b for b in bnd_bm if b not in cut_bm])
    is_b = np.isin(S['src'], bnd_bm)
    # края разреза (и случайные копии на нём) — не граница морды
    u_, v_, _ = fr.uvw(Ps)
    is_b &= ~((np.abs(v_ - fr.line(np.clip(u_, -fr.cu, fr.cu))) < 0.06) & (np.abs(u_) < fr.cu + 0.06))
    from scipy.spatial import cKDTree
    dB = cKDTree(Ps[is_b]).query(Ps)[0] / W
    border = sm(0.05, 0.5, dB)
    # сторона губы у вершин разреза
    slit = np.zeros(n_s)
    for _, ups, los, _, _ in S['pairs']:
        slit[ups] = 1
        slit[los] = -1
    # сторона губы у всей морды у рта — по связности (разрез делит верх и низ): обход от копий разреза,
    # не заходя за уголки; дальше от рта — по положению относительно линии (side = 0)
    side = topo_side(fr, S, slit)
    # разрез обязан делить губы: вершина «сверху» далеко под линией — значит, верх протёк в низ (челюсть потянет кожу
    # занавеской поверх рта)
    _u, _v, _ = fr.uvw(S['P'])
    _leak = int(((side > 0) & (_v - fr.line(np.clip(_u, -fr.cu, fr.cu)) < -0.15) & (np.abs(_u) < 0.3)).sum())
    if _leak and os.environ.get('FACE_DEBUG'):
        lk = (side > 0) & (_v - fr.line(np.clip(_u, -fr.cu, fr.cu)) < -0.15) & (np.abs(_u) < 0.3)
        print('   утечка: u', np.round(np.percentile(_u[lk], [0, 50, 100]), 3), 'v', np.round(np.percentile(_v[lk], [0, 50, 100]), 3),
              'w', np.round(np.percentile(fr.uvw(S['P'])[2][lk], [0, 50, 100]), 3), 'пары u', np.round([fr.uvw(S['P'][[p_[1][0] for p_ in S['pairs']]])[0].min(), fr.uvw(S['P'][[p_[1][0] for p_ in S['pairs']]])[0].max()], 3), 'cu', fr.cu)
    if _leak:
        sys.exit(f'разрез губ не замкнут: {_leak} вершин верхней губы ниже линии рта — проверь SUBDIV/линию рта')

    # ── покой: щель губ, скругление губ внутрь, фильтрум
    u, v, w = fr.uvw(Ps)
    cu = fr.cu
    q = np.cos(np.clip(u / cu, -1, 1) * math.pi / 2)
    gap = fr.cfg['gap']
    dv = v - fr.line(np.clip(u, -cu, cu))
    near = np.exp(-(dv / 0.07) ** 2) * sm(cu + 0.1, cu - 0.05, np.abs(u)) * sm(-0.5, -0.2, w)
    # щель — плавным полем по своей стороне (не только вершины разреза: иначе соседи у кромки «перехлёстываются» пилой)
    near_s = np.exp(-(np.abs(dv) / 0.06) ** 2) * (np.abs(u) < cu + 0.02)
    Ps[:, 1] += np.sign(side) * 0.5 * gap * q * near_s * W
    Ps[:, 2] += -0.018 * W * np.exp(-(dv / 0.06) ** 2) * sm(cu + 0.05, cu - 0.1, np.abs(u)) * sm(-0.5, -0.2, w)
    phil = np.exp(-(u / 0.025) ** 2) * sm(0.0, 0.03, dv) * sm(fr.nose, fr.nose - 0.04, v) * sm(-0.5, -0.2, w)
    Ps[:, 2] += -0.02 * W * phil
    S['P'] = Ps
    # мех у губ — 0 (пряди не лезут в рот), плавно к прежней длине
    furlen = S['f']['furlen'] * sm(0.05, 0.16, np.abs(dv) + np.maximum(0, np.abs(u) - cu)) ** 1.0
    furlen = np.where(near > 0.5, 0, furlen)

    # ── ключи FaceSkin
    T = build_targets(fr, rig, Ps, side, ang_d)
    profile_fix(fr, T, Ps, side, S['pairs'])
    if fr.cfg.get('corner_smooth'):
        smooth_corners(fr, T, Ps, S['F'], VISEMES + EMOS, fr.cfg['corner_smooth'])
    for k in KEEP_KEYS:
        if k in S['v']:
            T[k] = S['v'][k]
    # ключи прошлых стадий (щёки, брови, нос) не трогают глазницу: у Хулигана cheeks_gum выдвигал край глазницы вперёд
    # поверх яблока на 0.4 B (глаз «срезан»), brow_up поднимал верхний край — щель между веком и кожей
    eyem = eye_guard(fr, Ps)
    for k in KEEP_KEYS:
        if k in T:
            T[k] = T[k] * eyem[:, None]
    for k in T:
        T[k] = T[k] * border[:, None]
    # губы не перехлёстываются: в паре разреза нижняя не выше верхней
    pu = np.array([p[1][0] for p in S['pairs']])
    pl = np.array([p[2][0] for p in S['pairs']])
    for k in VISEMES + EMOS:
        yu = Ps[pu, 1] + T[k][pu, 1]
        yl = Ps[pl, 1] + T[k][pl, 1]
        over = np.maximum(0, yl - yu + 0.002 * W)
        if over.max() > 0:
            for _, ups, los, _, _ in S['pairs']:
                pass
            fix = np.zeros(n_s)
            for (pp, o) in zip(S['pairs'], over):
                fix[pp[2]] = o
            T[k][:, 1] -= fix
    if os.environ.get('FACE_DUMP'):
        np.savez(os.environ['FACE_DUMP'], P=Ps, F=S['F'], side=side, W=W, cu=cu,
                 pu=np.array([p[0] for p in S['pairs']]), up=pu, lo=pl,
                 **{'T_' + k: T[k] for k in VISEMES + EMOS})
    if os.environ.get('FACE_DEBUG'):
        Eb = np.sort(np.concatenate([S['src'][S['F'][:, [0, 1]]], S['src'][S['F'][:, [1, 2]]], S['src'][S['F'][:, [2, 0]]]]), 1)
        uqb, cb_ = np.unique(Eb, axis=0, return_counts=True)
        bvb = np.unique(uqb[cb_ == 1])
        gi = np.array([np.where(S['src'] == b)[0][0] for b in bvb])
        uu_, vv_, ww_ = fr.uvw(Ps[gi])
        m_ = (np.abs(uu_) < 0.6) & (vv_ > -0.5) & (vv_ < 0.2) & (np.abs(vv_ - fr.line(np.clip(uu_, -fr.cu, fr.cu))) > 0.03)
        print('   holes near mouth (boundary off the slit):', np.round(np.c_[uu_[m_], vv_[m_], ww_[m_]], 3).tolist()[:20])
        lo_ = np.array([p[2][0] for p in S['pairs']]); up_ = np.array([p[1][0] for p in S['pairs']])
        print('   lower lip dD/W', np.round(T['vis_D'][lo_[::4]] / W, 3).tolist())
        print('   upper lip dD/W', np.round(T['vis_D'][up_[::4]] / W, 3).tolist())
        uu_, vv_, ww_ = fr.uvw(Ps); dv_ = vv_ - fr.line(np.clip(uu_, -fr.cu, fr.cu))
        print('   side counts', int((side > 0).sum()), int((side < 0).sum()), 'leak up-below', int(((side > 0) & (dv_ < -0.08)).sum()), 'leak lo-above', int(((side < 0) & (dv_ > 0.08)).sum()))
        print('   jaw w lower', np.round(rig.jaw_weight(Ps[lo_], side[lo_]), 2).tolist())
        _, nbi = cKDTree(Ps[is_b]).query(Ps[lo_])
        print('   nearest boundary to lower lip', np.round(np.c_[fr.uvw(Ps[is_b][nbi])][:, ::8].T, 3).tolist())
        print('   border lower', np.round(border[lo_], 2).tolist(), 'uvw', np.round(np.c_[fr.uvw(Ps[lo_])][:, ::4], 3).tolist())
    missing = [k for k in KEYS if k not in T]
    assert not missing, missing

    # ── веса скина FaceSkin: top-4 из интерполированных
    WJ = np.stack([S['f'][f'j{k}'] for k in js], 1)
    order = np.argsort(-WJ, 1)[:, :4]
    J4 = np.array(js)[order]
    W4 = np.take_along_axis(WJ, order, 1)
    W4 = np.clip(W4, 0, None)
    W4 /= W4.sum(1, keepdims=True)

    # ── полость, клычки, язык
    keep_b = ~reg_t
    C = cavity(fr, rig, S, T, ang_d, hj, body=(P, Ib[keep_b]))
    if os.environ.get('FACE_DUMP'):
        np.savez(os.environ['FACE_DUMP'] + '.cav.npz', V=C['V'], F=C['F'], t=C['t'], side=C['side'], src=C['src'],
                 **{'T_' + k: v for k, v in C['targets'].items()})
    Tf = fangs(fr, rig, S, C, T, ang_d, body=(P, Ib[keep_b]))
    Tg = tongue(fr, rig, S, C, ang_d, body=(P, Ib[keep_b]))

    # ── запись в GLB
    def skin_of(src_idx, n):
        return J4[src_idx], W4[src_idx]

    nodes = j['nodes']
    body_node = next(i for i, nd in enumerate(nodes) if nd.get('mesh') == body_mi)
    fur_node = next(i for i, nd in enumerate(nodes) if nd.get('mesh') == fur_mi)
    parent = next((i for i, nd in enumerate(nodes) if body_node in nd.get('children', [])), None)
    mat_body = bp['material']
    mat_fur = fp['material']

    def acc_f(arr, typ):
        return g.add_acc(np.ascontiguousarray(arr, np.float32), 5126, typ, 34962)

    def acc_i(F, n):
        ind = np.asarray(F, np.uint32).reshape(-1)
        if n < 65536:
            return g.add_acc(ind.astype(np.uint16), 5123, 'SCALAR', 34963)
        return g.add_acc(ind, 5125, 'SCALAR', 34963)

    def targets_of(n, Td, keys):
        return [{'POSITION': add_sparse_q(g, n, Td.get(k, np.zeros((n, 3))), W)} for k in keys]

    def add_skinned(name, V, Nn, F, mat, J, Wg, uv=None, col=None, keys=None, Td=None, extra_attrs=None, share=None):
        if share is not None:
            attrs = dict(share['attributes'])
            tg = share.get('targets')
        else:
            attrs = {'POSITION': acc_f(V, 'VEC3'), 'NORMAL': acc_f(norm(Nn), 'VEC3')}
            if uv is not None:
                attrs['TEXCOORD_0'] = acc_f(uv, 'VEC2')
            if col is not None:
                attrs['COLOR_0'] = acc_f(np.concatenate([col, np.ones((len(col), 1))], 1), 'VEC4')
            attrs['JOINTS_0'] = g.add_acc(np.ascontiguousarray(J, np.uint8), 5121, 'VEC4', 34962) if np.max(J) < 256 else g.add_acc(np.ascontiguousarray(J, np.uint16), 5123, 'VEC4', 34962)
            attrs['WEIGHTS_0'] = acc_f(Wg, 'VEC4')
            tg = targets_of(len(V), Td, keys) if keys else None
        if extra_attrs:
            attrs.update(extra_attrs)
        nv_ = len(V) if V is not None else len(Ps)
        prim = {'attributes': attrs, 'indices': acc_i(F, nv_), 'material': mat}
        if tg:
            prim['targets'] = tg
        mesh = {'name': name, 'primitives': [prim], 'extras': {TAG: VERSION}}
        if keys:
            mesh['extras']['targetNames'] = list(keys)
            mesh['weights'] = [0.0] * len(keys)
        j['meshes'].append(mesh)
        mi = len(j['meshes']) - 1
        nd = {'name': name, 'mesh': mi, 'skin': 0, 'extras': {TAG: VERSION}}
        nodes.append(nd)
        ni = len(nodes) - 1
        if parent is not None:
            nodes[parent].setdefault('children', []).append(ni)
        else:
            j['scenes'][0]['nodes'].append(ni)
        return mi, ni, prim

    # FaceSkin (тело морды)
    mi_s, ni_s, prim_s = add_skinned('FaceSkin', Ps, S['N'], S['F'], mat_body, J4, W4, uv=S['UV'], keys=KEYS, Td=T)
    j['meshes'][mi_s]['extras']['faceRig'] = {
        'W': W, 'O': fr.O.round(6).tolist(), 'H': fr.H.round(6).tolist(), 'jaw': ang_d, 'cu': cu,
        'line': fr.L.round(4).tolist(), 'persona': a.persona,
    }
    nodes[ni_s]['extras']['faceRig'] = j['meshes'][mi_s]['extras']['faceRig']
    # мех морды — те же буферы и ключи + _FURLEN
    fur_tris = S['F'][S['fur'] > 0]
    fl_acc = g.add_acc(np.ascontiguousarray(furlen, np.float32), 5126, 'SCALAR', 34962)
    mi_f, ni_f, _ = add_skinned('BD_FurShellFace', None, None, fur_tris, mat_fur, None, None, keys=KEYS, share=prim_s, extra_attrs={'_FURLEN': fl_acc})
    nodes[ni_f]['extras'].update({k: v for k, v in nodes[fur_node].get('extras', {}).items() if k != TAG})
    # полость, клычки, язык
    mat_cav = len(j['materials'])
    j['materials'].append({'name': 'MouthCavity_mat', 'doubleSided': True, 'extras': {TAG: VERSION},
                           'pbrMetallicRoughness': {'baseColorFactor': [1, 1, 1, 1], 'metallicFactor': 0, 'roughnessFactor': 0.9}})
    mat_teeth = len(j['materials'])
    j['materials'].append({'name': 'Teeth_mat', 'extras': {TAG: VERSION},
                           'pbrMetallicRoughness': {'baseColorFactor': [0.96, 0.94, 0.9, 1], 'metallicFactor': 0, 'roughnessFactor': 0.35}})
    mat_tg = len(j['materials'])
    j['materials'].append({'name': 'Tongue_mat', 'doubleSided': True, 'extras': {TAG: VERSION},
                           'pbrMetallicRoughness': {'baseColorFactor': [1, 1, 1, 1], 'metallicFactor': 0, 'roughnessFactor': 0.45}})
    cJ, cW = J4[C['src']], W4[C['src']]
    mouth_keys = [k for k in KEYS if k in C['targets']]
    add_skinned('MouthCavity', C['V'], C['N'], C['F'], mat_cav, cJ, cW, col=C['col'], keys=mouth_keys, Td=C['targets'])
    fJ, fW = J4[Tf['src']], W4[Tf['src']]
    fk = [k for k in KEYS if k in Tf['targets']]
    add_skinned('Teeth', Tf['V'], Tf['N'], Tf['F'], mat_teeth, fJ, fW, keys=fk, Td=Tf['targets'])
    # язык — скин нижней губы по середине
    mid_lo = min(S['pairs'], key=lambda p: abs(p[0]))[2][0]
    tJ = np.repeat(J4[mid_lo][None], len(Tg['V']), 0)
    tW = np.repeat(W4[mid_lo][None], len(Tg['V']), 0)
    tk = [k for k in KEYS if k in Tg['targets']]
    add_skinned('Tongue', Tg['V'], Tg['N'], Tg['F'], mat_tg, tJ, tW, col=Tg['col'], keys=tk, Td=Tg['targets'])

    # ── тело и его мех: без морды и без ключей
    keep_b = ~reg_t
    bp['indices'] = acc_i(Ib[keep_b], nP)
    regset = {tuple(sorted(t)) for t in Fc.tolist()}
    fur_keep = np.array([tuple(sorted(t)) not in regset for t in If.tolist()])
    fp['indices'] = acc_i(If[fur_keep], nP)
    # вершины морды в буферах тела больше не нужны (их копии — в FaceSkin): буферы тела и его меха ужаты
    keepv = np.unique(np.concatenate([Ib[keep_b].ravel(), If[fur_keep].ravel()]))
    newi = -np.ones(nP, np.int64)
    newi[keepv] = np.arange(len(keepv))
    shared = {}
    for prim in (bp, fp):
        for k_, ai in list(prim['attributes'].items()):
            if ai not in shared:
                A_ = j['accessors'][ai]
                arr = g.acc(ai)
                arr = arr.reshape(len(arr), -1)[keepv]
                na = g.add_acc(arr, A_['componentType'], A_['type'], 34962)
                if A_.get('normalized'):
                    j['accessors'][na]['normalized'] = True
                shared[ai] = na
            prim['attributes'][k_] = shared[ai]
    bp['indices'] = acc_i(newi[Ib[keep_b]], len(keepv))
    fp['indices'] = acc_i(newi[If[fur_keep]], len(keepv))
    print(f'  тело: {nP} → {len(keepv)} вершин')
    for mi in (body_mi, fur_mi):
        m = j['meshes'][mi]
        for p in m['primitives']:
            p.pop('targets', None)
        m.get('extras', {}).pop('targetNames', None)
        m.pop('weights', None)

    # ── карточки меха: ключи по корню карточки (ближайшие точки морды)
    cards_mi = next((i for i, m in enumerate(j['meshes']) if m['name'] == 'BD_FurCards'), None)
    Tall = {k: T[k] for k in KEYS}
    if cards_mi is not None:
        cp = j['meshes'][cards_mi]['primitives'][0]
        CP = g.acc(cp['attributes']['POSITION']).astype(np.float64)
        UV1 = g.acc(cp['attributes']['TEXCOORD_1']).astype(np.float64)
        CI = g.acc(cp['indices']).reshape(-1, 3)
        # компоненты (карточки) — по треугольникам
        par = np.arange(len(CP))

        def find(x):
            while par[x] != x:
                par[x] = par[par[x]]
                x = par[x]
            return x
        for t_ in CI:
            r0 = find(t_[0])
            for x in t_[1:]:
                rx = find(x)
                if rx != r0:
                    par[rx] = r0
        comp = np.array([find(i) for i in range(len(CP))])
        root = {}
        for i, c in enumerate(comp):
            if c not in root or UV1[i, 1] < UV1[root[c], 1]:
                root[c] = i
        ridx = np.array([root[c] for c in comp])
        idx, wts, d0 = bind_nearest(CP[ridx], Ps, S['F'])
        fall = sm(0.12 * fr.zd, 0.04 * fr.zd, d0 / W)
        Tc = {k: apply_bind(Tall[k], idx, wts) * fall[:, None] for k in KEYS}
        # только ключи, что заметно двигают карточки (текстура морфов — на все карточки тела, хвост тоже)
        ck = [k for k in KEYS if np.abs(Tc[k]).max() > 3 * EPS * W]
        if ck:
            cp['targets'] = targets_of(len(CP), Tc, ck)
            j['meshes'][cards_mi].setdefault('extras', {})['targetNames'] = ck
            j['meshes'][cards_mi]['weights'] = [0.0] * len(ck)
        else:
            cp.pop('targets', None)
            j['meshes'][cards_mi].get('extras', {}).pop('targetNames', None)
            j['meshes'][cards_mi].pop('weights', None)
        print(f'  карточки меха: {len(root)} шт., у морды {int((fall > 0).sum())} вершин')
    # ── накладки головы (в пространстве кости Head): усы, пучки, брови
    IR, It = fr.IBM[:3, :3], fr.IBM[:3, 3]
    inv = np.linalg.inv(fr.IBM)
    for nm in ('Whiskers', 'FaceTufts', 'Brows'):
        ni = node_by(j, nm)
        if ni is None or 'mesh' not in nodes[ni]:  # у Блёстки p3 Brows — только разметка marks (брови — мех и ключи кожи)
            continue
        mi = nodes[ni]['mesh']
        pr = j['meshes'][mi]['primitives'][0]
        Vh = g.acc(pr['attributes']['POSITION']).astype(np.float64)
        Vm = Vh @ inv[:3, :3].T + inv[:3, 3]
        ex = j['meshes'][mi].setdefault('extras', {})
        oldn = ex.get('targetNames', [])
        old = {k: acc_dense(g, pr['targets'][i]['POSITION'], len(Vh)) for i, k in enumerate(oldn)}
        if nm == 'Brows':
            new = dict(old)
            new['brow_angry'] = rig.brow_angry(Vm) @ IR.T
            keys = [k for k in BROWS if k in new]
        else:
            idx, wts, d0 = bind_nearest(Vm, Ps, S['F'])
            # прядь (ус, пучок) целиком — за своим корнем (ближайшей к морде вершиной): не гнётся у корня
            comp = components(g.acc(pr['indices']).reshape(-1, 3), len(Vm))
            root = {}
            for i, c in enumerate(comp):
                if c not in root or d0[i] < d0[root[c]]:
                    root[c] = i
            ri = np.array([root[c] for c in comp])
            idx, wts, d0 = idx[ri], wts[ri], d0[ri]
            fall = sm(0.1 * fr.zd, 0.03 * fr.zd, d0 / W)
            new = {k: (apply_bind(Tall[k], idx, wts) * fall[:, None]) @ IR.T for k in KEYS}
            new = {k: d for k, d in new.items() if np.abs(d).max() > 1e-6}
            keys = list(new)
        if not keys:
            continue
        pr['targets'] = targets_of(len(Vh), new, keys)
        ex['targetNames'] = keys
        j['meshes'][mi]['weights'] = [0.0] * len(keys)
    # ── рот шейдером больше не нужен
    md = node_by(j, 'MouthD')
    if md is not None:
        for nd in nodes:
            if md in nd.get('children', []):
                nd['children'].remove(md)
        from face_detail import remap_nodes
        remap_nodes(g, {md})
    j.setdefault('asset', {}).setdefault('extras', {})[TAG] = VERSION
    gc(g)
    total = g.save(a.dst)
    src_size = os.path.getsize(a.src)
    print(f'  → {a.dst}: {total / 1e6:.3f} МБ (p1 {src_size / 1e6:.3f}, {100 * (total / src_size - 1):+.1f} %)')
    if a.report:
        report(a, fr, rig, S, T, C, Tf, Tg, furlen, total, src_size, (P, Ib[keep_b]), side)


def report(a, fr, rig, S, T, C, Tf, Tg, furlen, total, src_size, body, side_dbg=None):
    """Проникновения по видимости: вершина зубов/языка/полости, до которой с камеры (5 направлений: анфас, ±30° по
    сторонам, сверху и снизу 20°) долетает луч, не встретив ни кожи (морда в этом ключе + тело), ни «крышки» проёма
    рта (веер по краю губ), — торчит наружу сквозь кожу. Губы: нижняя выше верхней (перехлёст). Мех: длина у кромки губ."""
    import bpy  # noqa: F401
    from mathutils.bvhtree import BVHTree
    from mathutils import Vector
    W = fr.W
    Ps = S['P']
    Pb, Fb = body
    cams = []
    for yaw, pitch in ((0, 0), (30, 0), (-30, 0), (0, 20), (0, -20)):
        y, p = math.radians(yaw), math.radians(pitch)
        cams.append(Vector((math.sin(y) * math.cos(p), math.sin(p), math.cos(y) * math.cos(p))))
    lines = [f'# Риг лица {a.persona} (scripts/models/face_rig.py)', '',
             f'Файл: {total:,} байт (p1 {src_size:,}, {100 * (total / src_size - 1):+.1f} %). FaceSkin {len(Ps)} вершин, '
             f'полость {len(C["V"])}, клычки {len(Tf["V"])}, язык {len(Tg["V"])}; ключей {len(KEYS)}.', '',
             'Вершины, видимые с камеры мимо кожи и мимо проёма рта (= торчат сквозь кожу), по ключам при весе 1 и в покое:', '',
             '| ключ | клычки | язык | полость | губы перехлёст, мм | мех на кромке губ |', '|---|---|---|---|---|---|']
    pu = np.array([p[1][0] for p in S['pairs']])
    pl = np.array([p[2][0] for p in S['pairs']])
    rim_src = C['src'][C['t'] == 0]
    bad_total = 0
    for k in ['rest'] + VISEMES + EMOS:
        d0 = (lambda m: np.zeros_like(m['V'])) if k == 'rest' else None
        Pk = Ps + (T[k] if k != 'rest' else 0)
        # крышка проёма — сама «щель»: лента между верхней и нижней губой (по парам разреза, от уголка до уголка)
        cl, cr = S['corners'][0][1][0], S['corners'][1][1][0]
        up_ = [cl] + list(pu) + [cr]
        lo_ = [cl] + list(pl) + [cr]
        Vall = np.concatenate([Pk, Pb])
        nS = len(Pk)
        cap = []
        for i in range(len(up_) - 1):
            cap += [[up_[i], up_[i + 1], lo_[i + 1]], [up_[i], lo_[i + 1], lo_[i]]]
        cap = [c for c in cap if len(set(c)) == 3]
        polys = np.concatenate([S['F'], Fb + nS, np.array(cap)])
        bvh = BVHTree.FromPolygons([tuple(v) for v in Vall], [tuple(int(x) for x in f) for f in polys])

        dbg = []

        def poke(Q):
            n = 0
            for q in Q:
                o = Vector(q)
                for ci, d in enumerate(cams):
                    if bvh.ray_cast(o + d * (1e-4 * W), d, 10.0)[0] is None:
                        n += 1
                        dbg.append((np.round(np.ravel(fr.uvw(np.array(q)[None])), 3), ci))
                        break
            return n
        tgt = lambda m: m['targets'].get(k, 0) if k != 'rest' else 0
        fq = Tf['V'] + tgt(Tf)
        tq = Tg['V'] + tgt(Tg)
        if k == 'tongue_out':
            tq = tq[tq[:, 2] < fr.O[2] - 0.08 * W]  # кончик снаружи — так задумано; проверяем корень
        cq = (C['V'] + tgt(C))[C['t'] > 0.1]
        ot, og, oc = poke(fq), poke(tq), poke(cq)
        if os.environ.get('FACE_DEBUG') and k == os.environ.get('FACE_DEBUG'):
            ci = int(np.argmin(np.abs(Pk[pl, 0] - fr.O[0])))
            print('   lower lip center uvw', np.round(np.ravel(fr.uvw(Pk[pl][ci:ci + 1])), 3), 'upper', np.round(np.ravel(fr.uvw(Pk[pu][ci:ci + 1])), 3))
            uu_, vv_, ww_ = fr.uvw(Pk)
            col = np.where((np.abs(uu_) < 0.03))[0]
            for z in col[np.argsort(vv_[col])][::3]:
                if -0.7 < vv_[z] < 0.1:
                    print('     skin u0', round(float(vv_[z]), 3), round(float(ww_[z]), 3), 'side', int(side_dbg[z]) if side_dbg is not None else '')
            for x in dbg[::max(1, len(dbg) // 15)]:
                print('   poke', x)
        if os.environ.get('FACE_DEBUG') and k == 'rest':
            ct, cs = C['t'][C['t'] > 0.1], C['side'][C['t'] > 0.1]
            for z, q in enumerate(cq):
                if poke([q]):
                    print('   cav', round(float(ct[z]), 2), int(cs[z]), np.round(np.ravel(fr.uvw(q[None])), 3))
            for q in tq:
                if poke([q]):
                    print('   tg', np.round(np.ravel(fr.uvw(q[None])), 3))
        over = float(np.maximum(0, Pk[pl, 1] - Pk[pu, 1]).max() * 1000)
        fur_open = int((furlen[np.concatenate([pu, pl])] > 1e-5).sum())
        bad_total += ot + og + oc
        lines.append(f'| {k} | {ot} | {og} | {oc} | {over:.2f} | {fur_open} |')
    lines += ['', f'Итого вершин, торчащих сквозь кожу: {bad_total}. Перехлёст губ — в мм при росте кота 1 м (единица модели).',
              'Язык в tongue_out проверяется только глубже 0.08 W за линией рта (кончик снаружи — так задумано).']
    os.makedirs(a.report, exist_ok=True)
    open(os.path.join(a.report, f'face_rig_{a.persona}.md'), 'w').write('\n'.join(lines) + '\n')
    print('\n'.join(lines[6:]))


if __name__ == '__main__':
    main()

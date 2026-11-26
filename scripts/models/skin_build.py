#!/usr/bin/env python3
"""Скины котов на базе (docs/models/BASE.md): одежда отдельными мешами на скелет базы + вид (extras).

    python3 scripts/models/skin_build.py <cat> <p4m.glb> <base_parts.json> <cat_base.glb> <skin_<cat>.glb> [--work W]
    python3 scripts/models/skin_build.py compose <cat_base.glb> <skin.glb> <full.glb>     # база + скин одним GLB (прокси, QA)

Скин — GLB с тем же скелетом (узлы и inverseBindMatrices базы, байт в байт), без тела: только меши одежды на скине 0 и
asset.extras.catSkin (персонаж, файл базы, вид: лицо в покое, веки, ресницы, тон меха, эффекты). Рантайм
(src/character/catSkin.ts) грузит базу (кэш один раз) и скин, привязывает меши скина к костям базы по имени.

Одежда:
  • glitter — из p4m (форма базы, ничего подгонять не надо): худи и рукава Tripo (роль cloth), пачка Skirt_P4, бант и
    золото Bow_Glitter; атлас — плитки атласа p4 этих частей;
  • hooligan, kind — из p1 (public/models/v2/<кот>_p1.glb, утверждённые продактом): части по mesh_parts.label_parts
    (худи, кепка, наушники, кеды / худи, шарф, сапожки) + детали Emblem, BD_Metal, BD_Cloth. Перенос на скелет базы:
    вершина едет с костями (LBS: Σ w·B_база·B_p1⁻¹), кепка — ещё и масштаб по голове базы, затем выталкивание из тела
    базы (зазор MARGIN по нормали, сглаженное по сетке одежды). Веса скина — p1 (кости те же по имени). Атлас — острова UV
    этих частей из текстуры p1 (база цвета + нормали).
"""
import sys, os, json, math, argparse
import numpy as np
from PIL import Image
from scipy.spatial import cKDTree

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from face_detail import G2, gc  # noqa: E402
from glitter_p3 import weld_map, edges_of, smooth_field, remove_nodes  # noqa: E402
from glitter_p4_finish import roles_by_uv  # noqa: E402

VERSION = 1
ATLAS = 2048
PAD = 6
P1 = os.path.join(HERE, '../../public/models/v2/{}_p1.glb')
# части p1 → меш скина (имена — content/src/<кот>.meta.json outfit.meshes, BodyCollider: Cap_*, Headphones_*, Scarf_*)
# худи Хулигана и Добряка — не из p1 (у p1 худи с дырами под наушниками/шерстью груди), а худи Tripo базы (как у
# Блёстки: та же форма, сидит на торсе без подгонки) перекрашенное и длиннее (template_hoodie)
P1_PARTS = {
    'hooligan': {1: 'Cap_Hooligan', 7: 'Shoes_Hooligan'},
    'kind': {4: 'Scarf_Kind', 7: 'Boots_Kind'},
}
P1_DETAILS = {'hooligan': ('BD_Cloth',), 'kind': ()}
# наушники Хулигана — процедурные v2 (headphones.py: дуга и чашки своими мешами, без текстур)
V2_EXTRA = {'hooligan': ('Headphones_Hooligan',)}
# худи по шаблону: основной цвет, кант (манжеты, пояс, шнурки), значок; длиннее на LEN (подол ниже), шире к подолу
HOODIE = {
    'hooligan': {'main': (34, 34, 38), 'trim': (150, 214, 58), 'gold': (150, 214, 58), 'badge': ((40, 150, 70), (235, 245, 235)), 'len': 0.07, 'flare': 0.012},
    'kind': {'main': (238, 230, 214), 'trim': (150, 216, 190), 'gold': (150, 216, 190), 'badge': ((40, 160, 80), (245, 245, 240)), 'len': 0.06, 'flare': 0.012},
}
# зазор одежды над телом базы (ед. модели), по мешу
MARGIN = {'Hoodie': 0.004, 'Cap': 0.003, 'Headphones': 0.004, 'Shoes': 0.004, 'Boots': 0.003, 'Scarf': 0.004,
          'Emblem': 0.0, 'BD_Metal': 0.0, 'BD_Cloth': 0.0}

# вид персонажа (рантайм src/character/catSkin.ts): лицо в покое (ключи FacePreset), множители век, ресницы-лепестки,
# скрытые меши базы, эффекты; см. design/cut/<кот>, design/sheets/*_turnaround.jpg
FEET = ['LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase', 'LeftToe_End', 'RightToe_End']
LOOK = {
    'glitter': {'rest': {'smile': 0.6, 'mouth_A': 0.2}, 'eyes': {'eyes_smug': 0.15, 'eyes_sleepy': 0.2, 'eyes_squint': 0.45, 'blush': 0},
                'petals': 1, 'lash': 2.3, 'fx': ['tailSparkle'], 'hide': ['BodyTorso'], 'brow': None},
    'hooligan': {'rest': {'smirk': 0.55, 'smile': 0.2}, 'eyes': {'eyes_smug': 1.0, 'blush': 0}, 'restUp': 0.22,
                 'petals': 0, 'lash': 1.4, 'fx': [], 'hide': ['BodyTorso'], 'brow': [0.42, 0.44, 0.55], 'furOff': FEET},
    'kind': {'rest': {'smile': 0.45}, 'eyes': {'eyes_smug': 0.3, 'blush': 0}, 'restUp': 0.1,
             'petals': 0, 'lash': 1.5, 'fx': [], 'hide': ['BodyTorso'], 'brow': [0.46, 0.48, 0.6], 'furOff': FEET},
}


# краска одежды — то, что у p1/p4 делал рантайм (furTone.ts FUR_TONE_V2/P4 cloth), запечено в атлас скина (одежда скина
# не тонируется как мех): тексели в радиусе r от src (sRGB) → dst с контрастом k
CLOTH = {
    'glitter': [((185, 162, 206), 0.2, (206, 190, 236), 0.6)],
    'hooligan': [((128, 210, 46), 0.3, (150, 200, 92), 0.75)],
    'kind': [((220, 142, 126), 0.26, (228, 172, 155), 0.7)],
}


def bake_cloth(img, tones):
    a = np.asarray(img.convert('RGBA')).astype(np.float64) / 255
    c = a[..., :3]
    for src, r, dst, k in tones:
        src = np.array(src) / 255; dst = np.array(dst) / 255
        d = np.linalg.norm(c - src, axis=-1)
        t = np.clip((d - 0.55 * r) / (r - 0.55 * r), 0, 1)
        w = 1 - t * t * (3 - 2 * t)
        cc = np.clip(dst + (c - src) * k, 0, 1)
        c = c * (1 - w[..., None]) + cc * w[..., None]
    a[..., :3] = c
    return Image.fromarray(np.clip(a * 255 + 0.5, 0, 255).astype(np.uint8), 'RGBA')


# ───────────────────────────── скелет ─────────────────────────────
def skel(g):
    j = g.j
    sk = j['skins'][0]
    names = [j['nodes'][k]['name'].replace('mixamorig:', '') for k in sk['joints']]
    IBM = g.acc(sk['inverseBindMatrices']).reshape(-1, 4, 4).astype(np.float64)
    B = np.array([np.linalg.inv(m.T) for m in IBM])  # мир ← кость (поза привязки), столбцы
    return names, B


def retarget(V, N, J, W, src_names, Bs, dst_names, Bd):
    """LBS-перенос из позы привязки p1 в позу привязки базы; J — индексы суставов p1 → индексы базы"""
    idx = np.array([dst_names.index(n) if n in dst_names else dst_names.index('Hips') for n in src_names])
    M = np.einsum('kij,kjl->kil', Bd[idx], np.linalg.inv(Bs))  # (njs,4,4)
    Vh = np.c_[V, np.ones(len(V))]
    out = np.zeros((len(V), 3)); nout = np.zeros((len(V), 3))
    for c in range(J.shape[1]):
        Mc = M[J[:, c]]
        out += W[:, c:c + 1] * np.einsum('nij,nj->ni', Mc, Vh)[:, :3]
        nout += W[:, c:c + 1] * np.einsum('nij,nj->ni', Mc[:, :3, :3], N)
    nout /= np.maximum(np.linalg.norm(nout, axis=1, keepdims=True), 1e-12)
    return out, nout, idx[J]


def vnormals(V, F):
    wm = weld_map(V)
    fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    acc = np.zeros((wm.max() + 1, 3))
    for k in range(3):
        np.add.at(acc, wm[F[:, k]], fn)
    n = acc[wm]
    return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)


class Body:
    """тело базы для выталкивания: вершины + нормали (сварка, площадные)"""

    def __init__(self, g):
        j = g.j
        Ps, Ns, ears = [], [], []
        sk = j['skins'][0]
        en = [i for i, k in enumerate(sk['joints']) if 'Ear' in j['nodes'][k]['name']]
        for n in j['nodes']:
            if n.get('name') in ('tripo_mesh_glitter_p4', 'FaceSkin', 'BodyTorso'):
                p = j['meshes'][n['mesh']]['primitives'][0]
                V = g.acc(p['attributes']['POSITION']).astype(np.float64)
                F = g.acc(p['indices']).reshape(-1, 3).astype(np.int64)
                u, inv = np.unique(F.ravel(), return_inverse=True)
                Fu = inv.reshape(-1, 3); Vu = V[u]
                Ps.append(Vu); Ns.append(vnormals(Vu, Fu))
                # уши (кости LeftEar1/RightEar1): для мерки головы под кепку
                Jv = g.acc(p['attributes']['JOINTS_0'])[u]; Wv = g.acc(p['attributes']['WEIGHTS_0']).astype(np.float64)[u]
                ears.append((np.isin(Jv, en) * Wv).sum(1) > 0.3)
        self.P = np.concatenate(Ps); self.N = np.concatenate(Ns)
        self.ear = np.concatenate(ears)
        # нормали наружу: у частей Tripo (и торса базы из них) обход бывает вывернут — сверка с направлением от оси
        # ближайшей кости (позвоночник, руки, ноги, голова, хвост)
        names, B = skel(g)
        bp = {n: B[i][:3, 3] for i, n in enumerate(names)}
        chains = [['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'HeadTop_End']] + \
                 [[s_ + b for b in ('Shoulder', 'Arm', 'ForeArm', 'Hand')] for s_ in ('Left', 'Right')] + \
                 [[s_ + b for b in ('UpLeg', 'Leg', 'Foot', 'ToeBase')] for s_ in ('Left', 'Right')] + [['Tail1', 'Tail2', 'Tail3', 'Tail4']]
        segs = [(bp[c[i]], bp[c[i + 1]]) for c in chains for i in range(len(c) - 1) if c[i] in bp and c[i + 1] in bp]
        best = np.full(len(self.P), np.inf); cpt = np.zeros_like(self.P)
        for a_, b_ in segs:
            ab = b_ - a_
            t = np.clip(((self.P - a_) @ ab) / max(ab @ ab, 1e-12), 0, 1)
            q = a_ + t[:, None] * ab
            d = np.linalg.norm(self.P - q, axis=1)
            m = d < best
            best[m] = d[m]; cpt[m] = q[m]
        flip = ((self.P - cpt) * self.N).sum(1) < 0
        self.N[flip] *= -1
        print(f'тело базы: {len(self.P)} вершин, нормалей вывернуто {int(flip.sum())}')
        self.tree = cKDTree(self.P)

    def depth(self, Q, k=6):
        """знаковое расстояние над телом (по нормалям ближайших, взвешенно) и нормаль"""
        d, i = self.tree.query(Q, k=k)
        w = 1 / (d + 1e-5)
        w /= w.sum(1, keepdims=True)
        n = (self.N[i] * w[..., None]).sum(1)
        n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
        s = (((Q[:, None] - self.P[i]) * self.N[i]).sum(2) * w).sum(1)
        return s, n


def push_out(V, F, body, margin, iters=6, smooth=4):
    """вершины ближе margin к телу (или внутри) — наружу по нормали тела; поле сдвига сглажено по сетке (без вмятин)"""
    if margin <= 0:
        return V, 0
    V = V.copy()
    wm = weld_map(V); nW = wm.max() + 1
    E = wm[edges_of(F)]
    moved = np.zeros(len(V), bool)
    for _ in range(iters):
        s, n = body.depth(V)
        need = np.maximum(0, margin - s)
        if need.max() < 1e-5:
            break
        moved |= need > 1e-5
        D = need[:, None] * n
        Dw = np.zeros((nW, 3)); c = np.zeros(nW)
        np.add.at(Dw, wm, D); np.add.at(c, wm, 1)
        Dw /= np.maximum(c, 1)[:, None]
        Ds = smooth_field(Dw, E, nW, smooth)
        # сглаженное не меньше нужного по нормали
        Ds = np.where((np.linalg.norm(Ds, axis=1) < np.linalg.norm(Dw, axis=1))[:, None], Dw, Ds)
        V += Ds[wm]
    return V, int(moved.sum())


# ───────────────────────────── атлас ─────────────────────────────
def islands(UV, F):
    """связные куски по треугольникам (вершины с одинаковым индексом) → метка вершины"""
    par = np.arange(len(UV))

    def find(a):
        while par[a] != a:
            par[a] = par[par[a]]
            a = par[a]
        return a
    for a, b, c in F:
        for x, y in ((a, b), (b, c)):
            rx, ry = find(x), find(y)
            if rx != ry:
                par[rx] = ry
    return np.array([find(i) for i in range(len(UV))])


def pack(rects, W=ATLAS):
    """полочная упаковка: rects [(w,h)] → масштаб s и позиции [(x,y)] (все размеры ×s)"""
    s = 1.0
    for _ in range(40):
        order = sorted(range(len(rects)), key=lambda i: -rects[i][1])
        x = y = rowh = 0
        pos = [None] * len(rects)
        ok = True
        for i in order:
            w, h = math.ceil(rects[i][0] * s) + 2 * PAD, math.ceil(rects[i][1] * s) + 2 * PAD
            if x + w > W:
                x = 0; y += rowh; rowh = 0
            if y + h > W or w > W:
                ok = False
                break
            pos[i] = (x + PAD, y + PAD)
            x += w; rowh = max(rowh, h)
        if ok:
            return s, pos
        s *= 0.95
    raise RuntimeError('атлас не упаковать')


def build_atlas(garments, nrm=True):
    """garments: список словарей с UV (в своей картинке), F, img, nimg, rects (кусочки: (маска вершин, (u0,v0,u1,v1) в долях))
    → общий атлас (база цвета, нормали), UV переписаны"""
    items = []
    for gi, G in enumerate(garments):
        img = G['img']; Wp, Hp = img.size
        for m, (u0, v0, u1, v1) in G['rects']:
            x0, y0 = max(0, int(u0 * Wp) - 1), max(0, int(v0 * Hp) - 1)
            x1, y1 = min(Wp, int(math.ceil(u1 * Wp)) + 1), min(Hp, int(math.ceil(v1 * Hp)) + 1)
            items.append((gi, m, (x0, y0, x1, y1)))
    s, pos = pack([(it[2][2] - it[2][0], it[2][3] - it[2][1]) for it in items])
    atl = Image.new('RGBA', (ATLAS, ATLAS), (128, 128, 128, 255))
    natl = Image.new('RGB', (ATLAS, ATLAS), (128, 128, 255))
    for (gi, m, (x0, y0, x1, y1)), (px, py) in zip(items, pos):
        G = garments[gi]
        w, h = max(1, math.ceil((x1 - x0) * s)), max(1, math.ceil((y1 - y0) * s))
        crop = G['img'].convert('RGBA').crop((x0, y0, x1, y1)).resize((w, h), Image.LANCZOS)
        # поля: растянуть край (без швов при mip)
        big = crop.resize((w + 2 * PAD, h + 2 * PAD), Image.BILINEAR)
        atl.paste(big, (px - PAD, py - PAD)); atl.paste(crop, (px, py))
        if G.get('nimg') is not None and nrm:
            nc = G['nimg'].convert('RGB').resize(G['img'].size).crop((x0, y0, x1, y1)).resize((w, h), Image.LANCZOS)
            natl.paste(nc.resize((w + 2 * PAD, h + 2 * PAD), Image.BILINEAR), (px - PAD, py - PAD)); natl.paste(nc, (px, py))
        Wp, Hp = G['img'].size
        uv = G['UV'][m]
        X = (uv[:, 0] * Wp - x0) * s + px
        Y = (uv[:, 1] * Hp - y0) * s + py
        G.setdefault('UVn', G['UV'].copy())
        G['UVn'][m] = np.c_[X / ATLAS, Y / ATLAS]
    for G in garments:
        G['UV'] = G.pop('UVn')
    print(f'атлас {ATLAS}²: {len(items)} кусков, масштаб {s:.2f}')
    return atl, natl


def uv_rects(UV, F, vmask=None):
    """острова UV (по связности треугольников) → [(маска вершин, bbox)]"""
    lab = islands(UV, F)
    out = []
    for l in np.unique(lab[F[:, 0]]):
        m = lab == l
        if vmask is not None:
            m &= vmask
        if m.sum() < 3:
            continue
        q = UV[m]
        out.append((m, (q[:, 0].min(), q[:, 1].min(), q[:, 0].max(), q[:, 1].max())))
    # мелкие острова, лежащие внутри больших, — одним прямоугольником с ними
    out.sort(key=lambda r: -(r[1][2] - r[1][0]) * (r[1][3] - r[1][1]))
    merged = []
    for m, b in out:
        for k, (m2, b2) in enumerate(merged):
            if b[0] >= b2[0] and b[1] >= b2[1] and b[2] <= b2[2] and b[3] <= b2[3]:
                merged[k] = (m2 | m, b2)
                break
        else:
            merged.append((m, b))
    return merged


# ───────────────────────────── источники одежды ─────────────────────────────
def sub(V, F, tris, *arrs):
    sv, inv = np.unique(F[tris].ravel(), return_inverse=True)
    return (inv.reshape(-1, 3),) + tuple(a[sv] for a in arrs)


def glitter_garments(p4m, parts):
    g = G2(p4m); j = g.j
    out = []
    for n in j['nodes']:
        nm = n.get('name')
        if nm not in ('tripo_mesh_glitter_p4', 'Skirt_P4', 'Bow_Glitter'):
            continue
        mesh = j['meshes'][n['mesh']]
        p = mesh['primitives'][0]; A = p['attributes']
        V = g.acc(A['POSITION']).astype(np.float64); N = g.acc(A['NORMAL']).astype(np.float64)
        UV = g.acc(A['TEXCOORD_0']).astype(np.float64)
        Jt = g.acc(A['JOINTS_0']).astype(np.int64); Wt = g.acc(A['WEIGHTS_0']).astype(np.float64)
        F = g.acc(p['indices']).reshape(-1, 3).astype(np.int64)
        mat = j['materials'][p['material']]
        img = g.image(j['textures'][mat['pbrMetallicRoughness']['baseColorTexture']['index']]['source'])
        nimg = g.image(j['textures'][mat['normalTexture']['index']]['source']) if 'normalTexture' in mat else None
        if nm == 'tripo_mesh_glitter_p4':
            role = roles_by_uv(UV, parts)
            cl = (role[F] == 'cloth').sum(1) >= 2
            F2, V2, N2, UV2, J2, W2 = sub(V, F, cl, V, N, UV, Jt, Wt)
            name = 'Hoodie_Glitter'
            gm = {'name': 'Hoodie_Glitter_mat', 'doubleSided': True,
                  'pbrMetallicRoughness': {'metallicFactor': 0.0, 'roughnessFactor': 0.8},
                  'extensions': {'KHR_materials_sheen': {'sheenColorFactor': [0.5, 0.48, 0.55], 'sheenRoughnessFactor': 0.5}}}
            ex = {'part': 'hoodie'}
        else:
            F2, V2, N2, UV2, J2, W2 = F, V, N, UV, Jt, Wt
            name = nm
            gm = {k: v for k, v in mat.items() if k not in ('pbrMetallicRoughness', 'normalTexture')}
            pm = {k: v for k, v in mat['pbrMetallicRoughness'].items() if k != 'baseColorTexture'}
            gm['pbrMetallicRoughness'] = pm
            ex = dict(n.get('extras', {}))
        # кусочки атласа — прямоугольники частей p4, в которые попадают вершины
        rects = []
        for pn, q in parts.items():
            x0, y0, x1, y1 = q['uv']
            m = (UV2[:, 0] >= x0) & (UV2[:, 0] <= x1) & (UV2[:, 1] >= y0) & (UV2[:, 1] <= y1)
            if m.sum() >= 3:
                rects.append((m, (x0, y0, x1, y1)))
        out.append({'name': name, 'V': V2, 'N': N2, 'UV': UV2, 'J': J2, 'W': W2, 'F': F2, 'img': img, 'nimg': nimg,
                    'mat': gm, 'extras': ex, 'rects': rects})
        print(f'{name}: {len(V2)} вершин, {len(F2)} треуг.')
    return out


def hsv_img(a):
    from mesh_parts import hsv
    h, s_, v = hsv(a.reshape(-1, 3))
    return h.reshape(a.shape[:2]), s_.reshape(a.shape[:2]), v.reshape(a.shape[:2])


def recolor_tiles(img, parts, cfg):
    """плитки худи атласа p4: лиловое → основной цвет, мята → кант, золото → кант пояса; рисунок (яркость) сохраняется"""
    a = np.asarray(img.convert('RGB')).astype(np.float64)
    H, W = a.shape[:2]
    for pn, q in parts.items():
        if q['role'] not in ('cloth', 'gold') or (q['role'] == 'gold' and pn != 'tripo_part_12'):
            continue
        x0, y0, x1, y1 = q['uv']
        r0, r1, c0, c1 = int(y0 * H), int(np.ceil(y1 * H)), int(x0 * W), int(np.ceil(x1 * W))
        t = a[r0:r1, c0:c1]
        h, s_, v = hsv_img(t)
        lum = t.mean(2)
        lil = (h > 195) & (h < 330) & (s_ > 0.04)
        mint = (h > 130) & (h < 195) & (s_ > 0.12)
        gold = (h > 25) & (h < 70) & (s_ > 0.15)
        other = ~(lil | mint | gold)
        out = t.copy()
        for m, col in ((lil, cfg['main']), (mint, cfg['trim']), (gold, cfg['gold'])):
            if m.sum() < 10:
                continue
            ref = np.median(lum[m])
            k = np.clip(lum / max(ref, 1), 0.55, 1.35)[..., None]
            if sum(col) < 150:  # тёмная ткань: рисунок мягче, складки — чуть светлее
                k = 1 + (k - 1) * 0.8
            out[m] = (np.array(col)[None] * k[m]).clip(0, 255)
        # прочее (белое/тёмное — значок, шнурки): к основному, если ярче — к светлому значку
        if pn == 'tripo_part_23':
            bc, fc = cfg['badge']
            ring = lil | mint | gold
            out[ring] = np.array(bc) * np.clip(lum[ring] / max(np.median(lum[ring]), 1), 0.7, 1.2)[:, None]
            out[other] = np.array(fc) * np.clip(lum[other] / max(np.median(lum[other]), 1), 0.7, 1.1)[:, None]
        elif pn in ('tripo_part_29', 'tripo_part_32'):  # шнурки — кант
            out[:] = np.array(cfg['trim']) * np.clip(lum / max(np.median(lum), 1), 0.6, 1.3)[..., None]
        else:
            if other.sum():
                out[other] = np.array(cfg['main']) * np.clip(lum[other] / max(np.median(lum[lil]) if lil.any() else 128, 1), 0.5, 1.4)[:, None]
        a[r0:r1, c0:c1] = out
    return Image.fromarray(a.clip(0, 255).astype(np.uint8))


def template_hoodie(cat, p4m, parts, body):
    """худи Tripo базы (как у Блёстки) + пояс (часть 12 золота), перекрашено и длиннее для Хулигана/Добряка"""
    cfg = HOODIE[cat]
    gs = glitter_garments(p4m, parts)
    hood = next(G for G in gs if G['name'] == 'Hoodie_Glitter')
    bow = next(G for G in gs if G['name'] == 'Bow_Glitter')
    x0, y0, x1, y1 = parts['tripo_part_12']['uv']
    m12 = (bow['UV'][:, 0] >= x0) & (bow['UV'][:, 0] <= x1) & (bow['UV'][:, 1] >= y0) & (bow['UV'][:, 1] <= y1)
    t12 = m12[bow['F']].all(1)
    F12, V12, N12, UV12, J12, W12 = sub(bow['V'], bow['F'], t12, bow['V'], bow['N'], bow['UV'], bow['J'], bow['W'])
    n0 = len(hood['V'])
    V = np.r_[hood['V'], V12]; N = np.r_[hood['N'], N12]; UV = np.r_[hood['UV'], UV12]
    J = np.r_[hood['J'], J12]; W = np.r_[hood['W'], W12]; F = np.r_[hood['F'], F12 + n0]
    # длиннее: ниже груди — растяжение вниз (подол на LEN ниже) и шире к подолу от оси тела
    y_hem = V12[:, 1].min() if len(V12) else V[:, 1].min()
    y_top = y_hem + 0.12
    t = np.clip((y_top - V[:, 1]) / (y_top - y_hem), 0, 1)
    sleeve = np.abs(V[:, 0]) > 0.15
    t[sleeve] = 0
    V = V.copy()
    V[:, 1] -= cfg['len'] * t
    r = V[:, [0, 2]] - np.array([0.0, np.median(V[:, 2])])
    rl = np.linalg.norm(r, axis=1, keepdims=True)
    V[:, [0, 2]] += r / np.maximum(rl, 1e-9) * (cfg['flare'] * t ** 1.5)[:, None]
    V, nm_ = push_out(V, F, body, 0.004)
    N = vnormals(V, F)
    img = recolor_tiles(hood['img'], parts, cfg)
    rects = []
    for pn, q in parts.items():
        a0, b0, a1, b1 = q['uv']
        m = (UV[:, 0] >= a0) & (UV[:, 0] <= a1) & (UV[:, 1] >= b0) & (UV[:, 1] <= b1)
        if m.sum() >= 3:
            rects.append((m, (a0, b0, a1, b1)))
    name = 'Hoodie_' + cat.capitalize()
    print(f'{name}: худи-шаблон {len(V)} вершин, длиннее на {cfg["len"] * 1000:.0f} мм, вытолкнуто {nm_}')
    mat = json.loads(json.dumps(hood['mat'])); mat['name'] = name + '_mat'
    if sum(cfg['main']) > 500:  # светлая пушистая ткань (Добряк) — мягче
        mat['pbrMetallicRoughness']['roughnessFactor'] = 0.95
    return {'name': name, 'V': V, 'N': N, 'UV': UV, 'J': J, 'W': W, 'F': F, 'img': img, 'nimg': hood['nimg'], 'mat': mat,
            'extras': {'part': 'hoodie'}, 'rects': rects}


def v2_extras(cat, base_g, body):
    """готовые отдельные меши v2 (наушники Хулигана, headphones.py) — перенос на скелет базы и жёсткая подгонка"""
    out = []
    names_ = V2_EXTRA.get(cat, ())
    if not names_:
        return out
    g = G2(os.path.join(HERE, f'../../public/models/v2/{cat}_v2.glb')); j = g.j
    sn, Bs = skel(g); dn, Bd = skel(base_g)
    for n in j['nodes']:
        if n.get('name') not in names_ or 'mesh' not in n:
            continue
        for pi, p in enumerate(j['meshes'][n['mesh']]['primitives']):
            a = p['attributes']
            V = g.acc(a['POSITION']).astype(np.float64); N = g.acc(a['NORMAL']).astype(np.float64)
            J = g.acc(a['JOINTS_0']).astype(np.int64); W = g.acc(a['WEIGHTS_0']).astype(np.float64)
            if W.max() > 1.5:
                W /= 255.0
            F = g.acc(p['indices']).reshape(-1, 3).astype(np.int64)
            Vr, Nr, Jr = retarget(V, N, J, W, sn, Bs, dn, Bd)
            out.append({'V': Vr, 'N': Nr, 'J': Jr, 'W': W, 'F': F, 'mat': j['materials'][p['material']], 'name': n['name'] + ('' if pi == 0 else f'_{pi}')})
    # одна жёсткая подгонка на все части (дуга и чашки вместе): сначала меньше (PHONES_K) вокруг шеи
    allV = np.concatenate([o['V'] for o in out])
    nk = Bd[dn.index('Neck')][:3, 3]
    c0 = np.array([nk[0], allV[:, 1].mean(), nk[2]])
    for o in out:
        o['V'] = c0 + (o['V'] - c0) * PHONES_K + np.array([0, 0.012, 0])
    allV = np.concatenate([o['V'] for o in out])
    allJ = np.concatenate([o['J'] for o in out]); allW = np.concatenate([o['W'] for o in out])
    fit = rigid_fit(allV, body, 0.004, RIGID['Headphones'], dn, Bd, allJ, allW)
    k = 0
    res = []
    for o in out:
        n_ = len(o['V'])
        Vn = fit[k:k + n_]; k += n_
        Vn, _ = push_out(Vn, o['F'], body, 0.003, smooth=12)
        res.append({'name': o['name'], 'V': Vn, 'N': vnormals(Vn, o['F']), 'UV': None, 'J': o['J'], 'W': o['W'], 'F': o['F'], 'img': None, 'nimg': None,
                    'mat': o['mat'], 'extras': {'headphones': 1}, 'rects': [], 'own_tex': False})
        print(f"{o['name']}: {n_} вершин (v2, перенос)")
    return res


def p1_garments(cat, base_g, body):
    from mesh_parts import label_parts, tri_label
    g = G2(P1.format(cat)); j = g.j
    sn, Bs = skel(g)
    dn, Bd = skel(base_g)
    mi, pr = g.main_mesh()
    A = pr['attributes']
    V = g.acc(A['POSITION']).astype(np.float64); N = g.acc(A['NORMAL']).astype(np.float64)
    UV = g.acc(A['TEXCOORD_0']).astype(np.float64)
    Jt = g.acc(A['JOINTS_0']).astype(np.int64); Wt = g.acc(A['WEIGHTS_0']).astype(np.float64)
    if Wt.max() > 1.5:
        Wt /= 255.0
    F = g.acc(pr['indices']).reshape(-1, 3).astype(np.int64)
    lab = label_parts(cat, g, pr, V, F)
    tl = tri_label(lab, F)
    mat = j['materials'][pr['material']]
    img = g.image(j['textures'][mat['pbrMetallicRoughness']['baseColorTexture']['index']]['source'])
    nimg = g.image(j['textures'][mat['normalTexture']['index']]['source']) if 'normalTexture' in mat else None
    out = []
    srcs = [(P1_PARTS[cat][k], tl == k, V, N, UV, Jt, Wt, F, img, nimg, None) for k in P1_PARTS[cat]]
    for n in j['nodes']:
        if n.get('name') in P1_DETAILS[cat] and 'mesh' in n:
            p = j['meshes'][n['mesh']]['primitives'][0]; a = p['attributes']
            Fd = g.acc(p['indices']).reshape(-1, 3).astype(np.int64)
            Vd = g.acc(a['POSITION']).astype(np.float64)
            Wd = g.acc(a['WEIGHTS_0']).astype(np.float64)
            if Wd.max() > 1.5:
                Wd /= 255.0
            m = j['materials'][p['material']]
            dimg = None
            if 'baseColorTexture' in m.get('pbrMetallicRoughness', {}):
                dimg = g.image(j['textures'][m['pbrMetallicRoughness']['baseColorTexture']['index']]['source'])
            col = g.acc(a['COLOR_0']) if 'COLOR_0' in a else None
            srcs.append((n['name'] + '_' + cat.capitalize() if n['name'] == 'Emblem' else n['name'], np.ones(len(Fd), bool), Vd,
                         g.acc(a['NORMAL']).astype(np.float64), g.acc(a['TEXCOORD_0']).astype(np.float64) if 'TEXCOORD_0' in a else None,
                         g.acc(a['JOINTS_0']).astype(np.int64), Wd, Fd, dimg, None, (m, col)))
    for name, tris, V0, N0, UV0, J0, W0, F0, im, nim, det in srcs:
        if not tris.any():
            continue
        sv, inv = np.unique(F0[tris].ravel(), return_inverse=True)
        Fg = inv.reshape(-1, 3)
        Vg, Ng, Jg, Wg = V0[sv], N0[sv], J0[sv], W0[sv]
        UVg = UV0[sv] if UV0 is not None else None
        Wg = Wg / np.maximum(Wg.sum(1, keepdims=True), 1e-9)
        Vr, Nr, Jr = retarget(Vg, Ng, Jg, Wg, sn, Bs, dn, Bd)
        key = name.split('_')[0]
        if key == 'Cap':
            hb = np.zeros(len(V), bool)
            hj = sn.index('Head')
            hb[np.unique(F[tl == 0].ravel())] = True
            hw = (Wt * (Jt == hj)).sum(1)
            src_head = V[hb & (hw > 0.8)] + (Bd[dn.index('Head')][:3, 3] - Bs[hj][:3, 3])
            Vr = fit_cap(Vr, src_head, body)
        if key in RIGID:
            # жёсткие вещи (наушники, кепка, кеды): без вмятин — растяжение от оси кости, пока зазор не ≥ margin
            Vr = rigid_fit(Vr, body, MARGIN.get(key, 0.003), RIGID[key], dn, Bd, Jr, Wg)
        if key == 'Cap':
            # уши базы — сквозь кепку (реф: уши торчат из-под кепки): треугольники кепки внутри/у уха — прочь
            dd, ii = body.tree.query(Vr, k=4)
            near_ear = body.ear[ii].mean(1) > 0.5
            s_, _ = body.depth(Vr)
            hole = near_ear & (s_ < 0.006)
            th = hole[Fg].any(1)
            if th.any():
                Fg = Fg[~th]
                print(f'кепка: дыры под уши — {int(th.sum())} треуг.')
        Vp, nm_ = push_out(Vr, Fg, body, MARGIN.get(key, 0.003) * (0.5 if key in RIGID else 1))
        Np = vnormals(Vp, Fg) if nm_ else Nr
        if det is None:
            gmat = {'name': name + '_mat', 'doubleSided': True, 'pbrMetallicRoughness': {'metallicFactor': 0.0, 'roughnessFactor': 0.85}}
            if key in ('Hoodie', 'Scarf', 'Boots'):
                gmat['extensions'] = {'KHR_materials_sheen': {'sheenColorFactor': [0.5, 0.5, 0.55], 'sheenRoughnessFactor': 0.5}}
            G = {'name': name, 'V': Vp, 'N': Np, 'UV': UVg, 'J': Jr, 'W': Wg, 'F': Fg, 'img': im, 'nimg': nim, 'mat': gmat,
                 'extras': {'part': key.lower()}, 'rects': uv_rects(UVg, Fg)}
        else:
            m, col = det
            gmat = {k: v for k, v in m.items() if k != 'pbrMetallicRoughness'}
            gmat['pbrMetallicRoughness'] = {k: v for k, v in m['pbrMetallicRoughness'].items() if k != 'baseColorTexture'}
            G = {'name': name, 'V': Vp, 'N': Np, 'UV': UVg, 'J': Jr, 'W': Wg, 'F': Fg, 'img': im, 'nimg': None, 'mat': gmat,
                 'extras': {'part': 'detail'}, 'rects': uv_rects(UVg, Fg) if (im is not None and UVg is not None) else [],
                 'color': col[sv] if col is not None else None, 'own_tex': im is not None}
        out.append(G)
        print(f'{name}: {len(Vp)} вершин, {len(Fg)} треуг., вытолкнуто {nm_}')
    return out


# жёсткая подгонка: кость-ось и оси растяжения (x, y, z в системе модели)
KMAX = {'Neck': 1.04, 'Head': 1.1, None: 1.4}
# наушники v2 на базе: чашки меньше (реф — чашка ≈ четверть ширины головы), выше к шее
PHONES_K = 0.8
RIGID = {'Headphones': ('Neck', (1, 0, 1)), 'Cap': ('Head', (1, 0.6, 1)), 'Shoes': (None, (1, 0.5, 1)), 'BD': (None, (1, 1, 1))}


def rigid_fit(V, body, margin, spec, names, Bd, J, W):
    bone, ax = spec
    ax = np.array(ax, np.float64)
    out = V.copy()
    if bone is None:
        # по доминирующей кости вершины (кеды — левая/правая стопа отдельно)
        dom = J[np.arange(len(J)), np.argmax(W, 1)]
        groups = [np.where(dom == d)[0] for d in np.unique(dom)]
        # стопа и пальцы одной ноги — вместе (по знаку x)
        groups = [np.where(V[:, 0] >= 0)[0], np.where(V[:, 0] < 0)[0]]
    else:
        groups = [np.arange(len(V))]
    for gi in groups:
        if len(gi) < 3:
            continue
        P = V[gi]
        c = P.mean(0) if bone is None else Bd[names.index(bone)][:3, 3]
        c = np.array([c[0], P[:, 1].mean(), c[2]]) if bone == 'Neck' else c
        k = 1.0
        for _ in range(30):
            Q = c + (P - c) * (1 + (k - 1) * ax)
            s_, _n = body.depth(Q)
            if np.percentile(s_, 3) >= margin * 0.8 or k > KMAX.get(bone, 1.35):
                break
            k += 0.01
        out[gi] = c + (P - c) * (1 + (k - 1) * ax)
        print(f'  жёсткая подгонка: ×{k:.2f} ({len(gi)} верш.)')
    return out


def fit_cap(V, src_head, body):
    """кепка p1 на голову базы: масштаб по отношению ширины/глубины головы базы к голове p1 на высотах кепки (без ушей)"""
    y0 = np.percentile(V[:, 1], 5); y1 = np.percentile(V[:, 1], 70)
    bh = body.P[~body.ear & (body.P[:, 2] < 0.2)]
    kx, kz = [], []
    for y in np.linspace(y0, y1, 6):
        a = bh[np.abs(bh[:, 1] - y) < 0.01]; b = src_head[np.abs(src_head[:, 1] - y) < 0.01]
        if len(a) > 20 and len(b) > 20:
            kx.append(np.ptp(a[:, 0]) / max(np.ptp(b[:, 0]), 1e-6)); kz.append(np.ptp(a[:, 2]) / max(np.ptp(b[:, 2]), 1e-6))
    if not kx:
        return V
    k = np.clip([np.median(kx), np.median(kz)], 0.85, 1.3)
    c = np.array([0.0, y0, np.median(src_head[:, 2]) if len(src_head) else V[:, 2].mean()])
    Vn = V.copy()
    Vn[:, 0] = c[0] + (V[:, 0] - c[0]) * k[0]
    Vn[:, 2] = c[2] + (V[:, 2] - c[2]) * k[1]
    Vn[:, 1] = c[1] + (V[:, 1] - c[1]) * (0.5 * (k[0] + k[1]))
    print(f'кепка: масштаб x {k[0]:.3f}, z {k[1]:.3f} (по голове без ушей на высотах кепки)')
    return Vn


# ───────────────────────────── запись скина ─────────────────────────────
def write_skin(base_path, garments, cat, dst, atlas, natlas):
    g = G2(base_path); j = g.j
    drop = {i for i, n in enumerate(j['nodes']) if 'mesh' in n}
    remove_nodes(j, drop)
    from glitter_p3 import add_skinned_node
    ii = g.add_image(atlas.convert('RGBA') if atlas.getextrema()[3][0] < 255 else atlas.convert('RGB'), f'skin_{cat}_base')
    ti = g.add_texture(ii)
    ni_ = g.add_image(natlas, f'skin_{cat}_normal')
    tn = g.add_texture(ni_)
    for G in garments:
        A = {'POSITION': g.add_acc(G['V'].astype(np.float32), 5126, 'VEC3', 34962),
             'NORMAL': g.add_acc(G['N'].astype(np.float32), 5126, 'VEC3', 34962),
             'JOINTS_0': g.add_acc(G['J'].astype(np.uint16), 5123, 'VEC4', 34962),
             'WEIGHTS_0': g.add_acc(G['W'].astype(np.float32), 5126, 'VEC4', 34962)}
        m = json.loads(json.dumps(G['mat']))
        if G.get('UV') is not None and (G.get('own_tex', True)):
            A['TEXCOORD_0'] = g.add_acc(G['UV'].astype(np.float32), 5126, 'VEC2', 34962)
            m.setdefault('pbrMetallicRoughness', {})['baseColorTexture'] = {'index': ti}
            if G.get('nimg') is not None:
                m['normalTexture'] = {'index': tn}
            sh = m.get('extensions', {}).get('KHR_materials_sheen')
            if sh is not None:
                sh['sheenColorTexture'] = {'index': ti}
        if G.get('color') is not None:
            c = G['color']
            A['COLOR_0'] = g.add_acc(c, j['accessors'][0]['componentType'] if False else (5126 if c.dtype.kind == 'f' else 5123 if c.dtype == np.uint16 else 5121), 'VEC4' if c.shape[1] == 4 else 'VEC3', 34962)
            if c.dtype.kind != 'f':
                j['accessors'][A['COLOR_0']]['normalized'] = True
        j['materials'].append(m)
        prim = {'attributes': A, 'indices': g.add_acc(G['F'].ravel().astype(np.uint32), 5125, 'SCALAR', 34963), 'material': len(j['materials']) - 1}
        j['meshes'].append({'name': G['name'], 'primitives': [prim]})
        add_skinned_node(j, G['name'], len(j['meshes']) - 1, G.get('extras', {}))
    used = set(j.get('extensionsUsed', []))
    if any('KHR_materials_sheen' in json.dumps(G['mat']) for G in garments):
        used.add('KHR_materials_sheen')
    j['extensionsUsed'] = sorted(used)
    j['asset']['extras'] = {'catSkin': {'version': VERSION, 'persona': cat, 'base': 'cat_base.glb', **LOOK[cat]}}
    j.pop('animations', None)
    gc(g)
    total = g.save(dst)
    print(f'→ {dst} {total / 1e6:.2f} MB')


def compose(base, skin, dst):
    """база + скин одним GLB (для colliders.py, penetration.py, листов): меши скина с теми же индексами суставов"""
    gb = G2(base); gs = G2(skin)
    jb, js = gb.j, gs.j
    from glitter_p3 import add_skinned_node
    # картинки/текстуры/материалы скина → в базу
    off_img = len(jb.get('images', []))
    for i, im in enumerate(js.get('images', [])):
        gb.add_image(gs.image(i), im.get('name', f'skin{i}'))
    off_tex = len(jb.get('textures', []))
    for t in js.get('textures', []):
        jb['textures'].append({'source': t['source'] + off_img, **({'sampler': 0} if jb.get('samplers') else {})})
    def retex(o):
        if isinstance(o, dict):
            return {k: (v + off_tex if k == 'index' else retex(v)) for k, v in o.items()}
        if isinstance(o, list):
            return [retex(x) for x in o]
        return o
    for n in js['nodes']:
        if 'mesh' not in n:
            continue
        mesh = js['meshes'][n['mesh']]
        prims = []
        for p in mesh['primitives']:
            A = {k: gb.add_acc(gs.acc(a), js['accessors'][a]['componentType'], js['accessors'][a]['type'], 34962) for k, a in p['attributes'].items()}
            for k, a in p['attributes'].items():
                if js['accessors'][a].get('normalized'):
                    jb['accessors'][A[k]]['normalized'] = True
            jb['materials'].append(retex(js['materials'][p['material']]))
            prims.append({'attributes': A, 'indices': gb.add_acc(gs.acc(p['indices']).astype(np.uint32), 5125, 'SCALAR', 34963), 'material': len(jb['materials']) - 1})
        jb['meshes'].append({'name': mesh['name'], 'primitives': prims})
        add_skinned_node(jb, n['name'], len(jb['meshes']) - 1, n.get('extras', {}))
    used = set(jb.get('extensionsUsed', [])) | set(js.get('extensionsUsed', []))
    jb['extensionsUsed'] = sorted(used)
    jb['asset']['extras']['catSkin'] = js['asset']['extras']['catSkin']
    gb.save(dst)
    print(f'→ {dst}')


def main():
    if sys.argv[1] == 'compose':
        compose(*sys.argv[2:5])
        return
    ap = argparse.ArgumentParser()
    ap.add_argument('cat'); ap.add_argument('p4m'); ap.add_argument('parts'); ap.add_argument('base'); ap.add_argument('dst')
    ap.add_argument('--work', default='/tmp/cat_base')
    a = ap.parse_args()
    parts = json.load(open(a.parts))['parts']
    base_g = G2(a.base)
    if a.cat == 'glitter':
        garments = glitter_garments(a.p4m, parts)
    else:
        body = Body(base_g)
        garments = [template_hoodie(a.cat, a.p4m, parts, body)] + p1_garments(a.cat, base_g, body) + v2_extras(a.cat, base_g, body)
    tex = [G for G in garments if G.get('rects')]
    atlas, natlas = build_atlas(tex)
    atlas = bake_cloth(atlas, CLOTH.get(a.cat, []))
    write_skin(a.base, garments, a.cat, a.dst, atlas, natlas)


if __name__ == '__main__':
    main()

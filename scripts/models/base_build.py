#!/usr/bin/env python3
"""База котов (docs/models/BASE.md): одна модель кота — тело + голова, единый скелет Mixamo 65 + уши/хвост, риг лица на
морфах (face_rig.py) — из Блёстки p4 с ригом лица (p4m, build_glitter_p4.sh). Одежды в базе нет — она в скинах
(skin_build.py), на тот же скелет.

    python3 scripts/models/base_build.py <p4m.glb> <base_parts.json> public/models/base/cat_base.glb

Что делает (без Blender):
  • одежда Tripo (худи, рукава, карман, значок, шнурки — роль cloth), пачка (Skirt_P4) и золото (Bow_Glitter) — прочь из
    базы: их забирает скин Блёстки (skin_build.py glitter) из того же p4m;
  • под худи у Tripo тела нет: торс и руки — оболочка худи и рукавов, сдвинутая внутрь на TORSO_IN (капюшон — к спине),
    мех ног (тон и UV — плитка ноги), низ закрыт «трусиками» (веер к промежности). Его не видно ни в одном скине —
    нужен, чтобы база без одежды была котом, а прокси/выталкивание одежды скинов шли от тела;
  • BD_FurShell — на новых буферах тела (_FURLEN того же меха, у торса 0);
  • атлас: плитки одежды/пачки/золота — тоном меха (сжимаются почти даром), хвост без блёсток — мех (блёстки хвоста
    рисует скин Блёстки в рантайме: tailSparkle);
  • asset.extras.catBase — версия, роли частей (прямоугольники атласа) для furTone (FUR_TONE_P4 — по extras.glitterP4).
"""
import sys, os, json
import numpy as np
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from face_detail import G2, gc  # noqa: E402
from glitter_p3 import weld_map, edges_of, smooth_field, remove_nodes  # noqa: E402
from glitter_p4_finish import roles_by_uv  # noqa: E402

VERSION = 1
# торс: оболочка худи внутрь (ед. модели = рост 1)
TORSO_IN = 0.012
# ворот и капюшон торса — уже к оси шеи (у худи Tripo там толстый капюшон: одежда Хулигана/Добряка выталкивалась им)
COLLAR_K = 0.3
TORSO_PARTS = ('tripo_part_2', 'tripo_part_9', 'tripo_part_10', 'tripo_part_11', 'tripo_part_13')
# одежда базы, которую уносит скин Блёстки
CLOTH_MESHES = ('Skirt_P4', 'Bow_Glitter')
FUR_PATCH = 'tripo_part_3'  # плитка ноги — тон меха торса
CHEST_TILE = 'tripo_part_2'
UPPER_Y = 0.76  # выше глаз (рост 1) — макушка и виски для закраски пятен Tripo  # плитка худи — градиент торса


def part_of(UV, parts):
    lab = np.full(len(UV), '', dtype=object)
    for nm, q in parts.items():
        x0, y0, x1, y1 = q['uv']
        m = (UV[:, 0] >= x0) & (UV[:, 0] <= x1) & (UV[:, 1] >= y0) & (UV[:, 1] <= y1)
        lab[m] = nm
    return lab


def vnormals(V, F):
    """нормали по сварке позиций (площадные)"""
    wm = weld_map(V)
    fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    acc = np.zeros((wm.max() + 1, 3))
    for k in range(3):
        np.add.at(acc, wm[F[:, k]], fn)
    n = acc[wm]
    return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)


def boundary_loops(F):
    """замкнутые граничные петли (по индексам вершин)"""
    E = np.sort(np.r_[F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]], 1)
    u, c = np.unique(E, axis=0, return_counts=True)
    be = u[c == 1]
    # ориентированные граничные рёбра
    Eo = np.r_[F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]]
    bset = {tuple(e) for e in be}
    nxt = {}
    for a, b in Eo:
        if (min(a, b), max(a, b)) in bset:
            nxt[a] = b
    loops, seen = [], set()
    for s in list(nxt):
        if s in seen:
            continue
        lp = [s]; seen.add(s); x = nxt[s]
        while x != s and x in nxt and x not in seen:
            lp.append(x); seen.add(x); x = nxt[x]
        if x == s and len(lp) > 4:
            loops.append(lp)
    return loops


HEAD_C = [None]


def dent_fix(V, sel, c):
    """радиус от центра головы не меньше 70-го перцентиля соседей по углу (вмятины наружу, бугры как есть)"""
    from scipy.spatial import cKDTree
    d = V - c
    r = np.linalg.norm(d, axis=1)
    u = d / np.maximum(r[:, None], 1e-9)
    idx = np.where(sel)[0]
    if len(idx) < 10:
        return V, 0
    tr = cKDTree(u[idx])
    nb = tr.query_ball_point(u[idx], 0.16)
    r_new = r.copy()
    for k, lst in enumerate(nb):
        p70 = np.percentile(r[idx[lst]], 70)
        if r[idx[k]] < p70 - 0.003:
            r_new[idx[k]] = p70
    return c + u * r_new[:, None], int((r_new - r > 1e-6).sum())


def fix_head(V, F, N, UV, Jt, Wt, pv, role):
    """макушка и виски Tripo: вмятины-звёзды (звёзды и бант Блёстки врезаны в голову) и дыры у банта. Вмятины —
    радиус от центра головы не меньше 70-го перцентиля соседей (по углу); малые дыры — веер к центру петли."""
    head = (role == 'head')
    up = head & (V[:, 1] > UPPER_Y)
    if up.sum() < 50:
        return V, F, N, UV, Jt, Wt, pv, role
    c = V[head].mean(0); c[1] = np.percentile(V[head][:, 1], 40)
    moved = 0
    # дыры: граничные петли головы выше глаз (сварка по позиции), малые — веер
    wm = weld_map(V, 1e-4)
    Fw = wm[F]
    E = np.sort(np.r_[Fw[:, [0, 1]], Fw[:, [1, 2]], Fw[:, [2, 0]]], 1)
    uq, cnt = np.unique(E, axis=0, return_counts=True)
    rep = {}
    for i, w_ in enumerate(wm):
        rep.setdefault(w_, i)
    loops = boundary_loops(Fw)
    addV, addF, addSrc = [], [], []
    nV = len(V)
    for lp in loops:
        q = np.array([V[rep[w_]] for w_ in lp])
        if len(lp) > 60 or q[:, 1].min() < UPPER_Y or not head[[rep[w_] for w_ in lp]].all():
            continue
        cc = q.mean(0)
        uc = (cc - c) / np.linalg.norm(cc - c)
        rc = np.median(np.linalg.norm(q - c, axis=1))
        ci = nV + len(addV)
        addV.append(c + uc * rc)
        addSrc.append([rep[w_] for w_ in lp])
        for a_, b_ in zip(lp, lp[1:] + lp[:1]):
            addF.append([rep[b_], rep[a_], ci])
    if addV:
        av = np.array(addV)
        src = addSrc
        V = np.r_[V, av]
        N = np.r_[N, np.array([(a - c) / np.linalg.norm(a - c) for a in av])]
        UV = np.r_[UV, np.array([UV[s_].mean(0) for s_ in src])]
        Jt = np.r_[Jt, np.array([Jt[s_[0]] for s_ in src])]
        Wt = np.r_[Wt, np.array([Wt[s_[0]] for s_ in src])]
        pv = np.r_[pv, np.array(['tripo_part_0'] * len(av), dtype=object)]
        role = np.r_[role, np.array(['head'] * len(av), dtype=object)]
        F = np.r_[F, np.array(addF)]
    print(f'голова: вмятины — {moved} вершин наружу, дыр закрыто {len(addV)}')
    return V, F, N, UV, Jt, Wt, pv, role


def main():
    src, parts_json, dst = sys.argv[1:4]
    info = json.load(open(parts_json))
    parts = info['parts']
    g = G2(src); j = g.j
    ni_main = next(i for i, n in enumerate(j['nodes']) if n.get('name') == 'tripo_mesh_glitter_p4')
    mi = j['nodes'][ni_main]['mesh']
    pr = j['meshes'][mi]['primitives'][0]
    A = pr['attributes']
    V = g.acc(A['POSITION']).astype(np.float64)
    N = g.acc(A['NORMAL']).astype(np.float64)
    UV = g.acc(A['TEXCOORD_0']).astype(np.float64)
    Jt = g.acc(A['JOINTS_0']); Wt = g.acc(A['WEIGHTS_0']).astype(np.float64)
    if Wt.max() > 1.5:
        Wt /= 255.0
    F = g.acc(pr['indices']).reshape(-1, 3).astype(np.int64)
    pv = part_of(UV, parts)
    role = roles_by_uv(UV, parts)
    # вмятины на макушке/висках — на сетке тела и морды вместе (шов между ними двигается одинаково — без трещин)
    marks = next(n['extras']['marks'] for n in j['nodes'] if n.get('name') == 'Brows')
    eyes_c = [(np.array(marks[f'eyeOuter{s_}']) + np.array(marks[f'eyeInner{s_}'])) / 2 for s_ in 'LR']
    fsn = next(n for n in j['nodes'] if n.get('name') == 'FaceSkin')
    fpr = j['meshes'][fsn['mesh']]['primitives'][0]
    Pf = g.acc(fpr['attributes']['POSITION']).astype(np.float64)
    head = role == 'head'
    c = V[head].mean(0); c[1] = np.percentile(V[head][:, 1], 40)
    U = np.r_[V, Pf]
    sel = np.r_[head, np.ones(len(Pf), bool)] & (U[:, 1] > UPPER_Y)
    for ec in eyes_c:
        sel &= np.linalg.norm(U - ec, axis=1) > 0.085
    # (выключено: радиус от центра у неровной головы Tripo «надувал» и здоровые места; звезда у виска — в части уха)
    mv = 0
    V = U[:len(V)]
    g.set_acc(fpr['attributes']['POSITION'], U[len(V):].astype(np.float32))
    print(f'голова: вмятины — {mv} вершин наружу')
    V, F, N, UV, Jt, Wt, pv, role = fix_head(V, F, N, UV, Jt, Wt, pv, role)
    tri_part = pv[F]
    tri_role = role[F]
    cloth_t = (tri_role == 'cloth').sum(1) >= 2
    # ── торс: оболочка худи и рукавов внутрь
    tor_t = np.isin(tri_part, TORSO_PARTS).sum(1) >= 2
    tor_t &= cloth_t
    tv, tinv = np.unique(F[tor_t].ravel(), return_inverse=True)
    Ft = tinv.reshape(-1, 3)
    Vt = V[tv].copy()
    # внутрь — к оси ближайшей кости (позвоночник, руки): у частей Tripo обход треугольников бывает вывернут, нормаль
    # смотрит внутрь — по ней торс выходил наружу худи. Ворот и капюшон (выше плеч) — ещё и уже к оси (COLLAR_K)
    sk = j['skins'][0]
    jn = [j['nodes'][k]['name'].replace('mixamorig:', '') for k in sk['joints']]
    IBM = g.acc(sk['inverseBindMatrices']).reshape(-1, 4, 4).astype(np.float64)
    bp = {n: np.linalg.inv(IBM[i].T)[:3, 3] for i, n in enumerate(jn)}
    chains = [['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head']] + [[s_ + b for b in ('Shoulder', 'Arm', 'ForeArm', 'Hand')] for s_ in ('Left', 'Right')]
    segs = [(bp[c[i]], bp[c[i + 1]]) for c in chains for i in range(len(c) - 1)]
    best = np.full(len(Vt), np.inf); cpt = np.zeros_like(Vt)
    for a_, b_ in segs:
        ab = b_ - a_
        t = np.clip(((Vt - a_) @ ab) / max(ab @ ab, 1e-12), 0, 1)
        q = a_ + t[:, None] * ab
        d = np.linalg.norm(Vt - q, axis=1)
        m = d < best
        best[m] = d[m]; cpt[m] = q[m]
    r = Vt - cpt
    rl = np.linalg.norm(r, axis=1, keepdims=True)
    shoulder_y = (bp['LeftArm'][1] + bp['Neck'][1]) / 2
    collar = np.clip((Vt[:, 1] - shoulder_y) / 0.04, 0, 1) * (np.abs(Vt[:, 0]) < bp['LeftArm'][0])
    newl = np.maximum(0.25 * rl[:, 0], rl[:, 0] - TORSO_IN) * (1 - COLLAR_K * collar)
    Vt = cpt + r / np.maximum(rl, 1e-9) * newl[:, None]
    wm = weld_map(Vt); E = wm[edges_of(Ft)]
    Vw = np.zeros((wm.max() + 1, 3)); cw = np.zeros(wm.max() + 1)
    np.add.at(Vw, wm, Vt); np.add.at(cw, wm, 1)
    Vt = smooth_field(Vw / cw[:, None], E, wm.max() + 1, 4)[wm]
    # UV и тон: плитка худи атласа (в базе свободна) — градиент «мех → светлая грудка» (спереди у шеи видна в вырезе
    # худи Хулигана/Добряка), рукава — мех
    x0, y0, x1, y1 = parts[CHEST_TILE]['uv']
    zs = np.interp(Vt[:, 1], [bp['Hips'][1], bp['Spine2'][1], bp['Neck'][1]], [bp['Hips'][2], bp['Spine2'][2], bp['Neck'][2]])
    front = np.clip((Vt[:, 2] - zs) / 0.07, 0, 1) * (np.abs(Vt[:, 0]) < 0.11)
    hgt = np.clip((Vt[:, 1] - bp['Spine1'][1]) / max(bp['Neck'][1] - bp['Spine1'][1], 1e-6), 0, 1)
    UVt = np.c_[x0 + (0.1 + 0.8 * front) * (x1 - x0), y0 + (0.9 - 0.8 * hgt) * (y1 - y0)]
    Nt = vnormals(Vt, Ft)
    Jtt, Wtt = Jt[tv], Wt[tv]
    # «трусики»: нижние петли торса (у пояса) — веер к промежности
    hips_j = None
    sk = j['skins'][0]
    jn = [j['nodes'][k]['name'].replace('mixamorig:', '') for k in sk['joints']]
    hips_j = jn.index('Hips')
    add_V, add_F = [], []
    nV = len(Vt)
    for lp in boundary_loops(Ft):
        q = Vt[lp]
        print(f'  петля торса: {len(lp)} верш., y {q[:, 1].mean():.3f}, ширина {np.ptp(q[:, 0]):.3f}')
        if q[:, 1].mean() > 0.37 or np.ptp(q[:, 0]) < 0.15:
            continue
        c = q.mean(0); c[1] -= 0.05
        ci = nV + len(add_V)
        add_V.append(c)
        for a, b in zip(lp, lp[1:] + lp[:1]):
            add_F.append([b, a, ci])
    if add_V:
        av = np.array(add_V)
        Vt = np.r_[Vt, av]
        Ft = np.r_[Ft, np.array(add_F)]
        Nt = vnormals(Vt, Ft)
        UVt = np.r_[UVt, np.tile(UVt[:1], (len(av), 1))]
        ja = np.zeros((len(av), 4), Jtt.dtype); ja[:, 0] = hips_j
        wa = np.zeros((len(av), 4)); wa[:, 0] = 1
        Jtt = np.r_[Jtt, ja]; Wtt = np.r_[Wtt, wa]
    print(f'торс: {len(Vt)} вершин, {len(Ft)} треуг. (внутрь {TORSO_IN * 1000:.0f} мм, низ — {len(add_V)} веер)')

    # ── тело базы: всё, кроме одежды Tripo, + торс; компактные буферы
    keep_t = ~cloth_t
    kv, kinv = np.unique(F[keep_t].ravel(), return_inverse=True)
    Fk = kinv.reshape(-1, 3)
    old2new = -np.ones(len(V), np.int64); old2new[kv] = np.arange(len(kv))
    nb = len(kv)
    Vn = np.r_[V[kv], Vt]; Nn = np.r_[N[kv], Nt]; UVn = np.r_[UV[kv], UVt]
    Jn = np.r_[Jt[kv], Jtt].astype(np.uint16); Wn = np.r_[Wt[kv], Wtt].astype(np.float32)
    Wn /= np.maximum(Wn.sum(1, keepdims=True), 1e-9)
    Fn = np.r_[Fk, Ft + nb]
    na = {'POSITION': g.add_acc(Vn.astype(np.float32), 5126, 'VEC3', 34962),
          'NORMAL': g.add_acc(Nn.astype(np.float32), 5126, 'VEC3', 34962),
          'TEXCOORD_0': g.add_acc(UVn.astype(np.float32), 5126, 'VEC2', 34962),
          'JOINTS_0': g.add_acc(Jn, 5123, 'VEC4', 34962),
          'WEIGHTS_0': g.add_acc(Wn, 5126, 'VEC4', 34962)}
    # прочие атрибуты основы (COLOR_0 и т.п.) — копией
    for k_, a_ in A.items():
        if k_ not in na:
            arr = g.acc(a_)
            arr = arr.reshape(len(V), -1)
            acc = j['accessors'][a_]
            ext = np.zeros((len(Vt), arr.shape[1]), arr.dtype)
            if k_.startswith('COLOR'):
                ext[:] = arr[kv].mean(0).astype(arr.dtype)
            new = np.r_[arr[kv], ext]
            ai = g.add_acc(new if new.shape[1] > 1 else new[:, 0], acc['componentType'], acc['type'], 34962)
            if acc.get('normalized'):
                j['accessors'][ai]['normalized'] = True
            na[k_] = ai
    old_attr = dict(A)
    pr['attributes'] = na
    # тело — без торса; торс — свой узел BodyTorso на тех же буферах (скины в худи его прячут: catSkin hide)
    pr['indices'] = g.add_acc(Fk.ravel().astype(np.uint32), 5125, 'SCALAR', 34963)
    pr.pop('targets', None)
    tp = {'attributes': dict(na), 'indices': g.add_acc((Ft + nb).ravel().astype(np.uint32), 5125, 'SCALAR', 34963), 'material': pr['material']}
    j['meshes'].append({'name': 'BodyTorso', 'primitives': [tp]})
    from glitter_p3 import add_skinned_node
    add_skinned_node(j, 'BodyTorso', len(j['meshes']) - 1, {'torso': 1})
    # ── морда (FaceSkin): вмятины-звёзды у висков — те же правки радиуса (без новых вершин: у FaceSkin морфы), дыры —
    # веером из вершин петли; у глаз (глазницы) не трогаем
    marks = next(n['extras']['marks'] for n in j['nodes'] if n.get('name') == 'Brows')
    eyes_c = [(np.array(marks[f'eyeOuter{s_}']) + np.array(marks[f'eyeInner{s_}'])) / 2 for s_ in 'LR']
    for n in j['nodes']:
        if n.get('name') != 'FaceSkin':
            continue
        fpr = j['meshes'][n['mesh']]['primitives'][0]
        Pf = g.acc(fpr['attributes']['POSITION']).astype(np.float64)
        Ff = g.acc(fpr['indices']).reshape(-1, 3).astype(np.int64)
        sel = Pf[:, 1] > UPPER_Y
        for ec in eyes_c:
            sel &= np.linalg.norm(Pf - ec, axis=1) > 0.085
        Pn, mv = Pf, 0
        wmf = weld_map(Pn, 1e-4); rep = {}
        for i, w_ in enumerate(wmf):
            rep.setdefault(w_, i)
        addF = []
        for lp in boundary_loops(wmf[Ff]):
            q = Pn[[rep[w_] for w_ in lp]]
            if len(lp) > 60 or q[:, 1].min() < UPPER_Y or min(np.linalg.norm(q.mean(0) - ec) for ec in eyes_c) < 0.09:
                continue
            ids = [rep[w_] for w_ in lp]
            for k in range(1, len(ids) - 1):
                addF.append([ids[0], ids[k + 1], ids[k]])
        if addF:
            fpr['indices'] = g.add_acc(np.r_[Ff, np.array(addF)].ravel().astype(np.uint32), 5125, 'SCALAR', 34963)
        print(f'морда: вмятины — {mv} вершин наружу, дыр закрыто треугольниками {len(addF)}')
    # ── мех-оболочки на новых буферах
    for n in j['nodes']:
        if n.get('name') != 'BD_FurShell':
            continue
        fp = j['meshes'][n['mesh']]['primitives'][0]
        if fp['attributes'].get('POSITION') != old_attr['POSITION']:
            continue
        L = g.acc(fp['attributes']['_FURLEN']).astype(np.float32)
        Ff = g.acc(fp['indices']).reshape(-1, 3).astype(np.int64)
        Ff = old2new[Ff]
        Ff = Ff[(Ff >= 0).all(1)]
        Ln = np.r_[L[kv], np.zeros(len(Vt), np.float32)]
        fa = dict(na); fa['_FURLEN'] = g.add_acc(Ln, 5126, 'SCALAR', 34962)
        fp['attributes'] = fa
        fp['indices'] = g.add_acc(Ff.ravel().astype(np.uint32), 5125, 'SCALAR', 34963)
        fp.pop('targets', None)
        print(f'мех: {len(Ff)} треуг.')
    # ── одежда — прочь из базы (её забирает скин Блёстки)
    drop = [i for i, n in enumerate(j['nodes']) if n.get('name') in CLOTH_MESHES]
    remove_nodes(j, set(drop))
    # ── атлас: плитки одежды/пачки/золота — тон меха; хвост — мех без блёсток
    mat = j['materials'][pr['material']]
    bct = mat['pbrMetallicRoughness']['baseColorTexture']['index']
    src_i = j['textures'][bct]['source']
    im = np.asarray(g.image(src_i).convert('RGB')).astype(np.float64)
    H, Wd = im.shape[:2]

    def tile(q):
        x0, y0, x1, y1 = q['uv']
        return int(y0 * H), int(np.ceil(y1 * H)), int(x0 * Wd), int(np.ceil(x1 * Wd))
    a0, a1, b0, b1 = tile(parts[FUR_PATCH])
    fur_rgb = np.median(im[a0:a1, b0:b1].reshape(-1, 3), 0)
    for nm, q in parts.items():
        if q['role'] in ('cloth', 'tutu', 'gold'):
            r0, r1, c0, c1 = tile(q)
            im[r0:r1, c0:c1] = fur_rgb
    # градиент торса в плитке худи: u — «спереди», v — высота (низ плитки — у шеи)
    r0, r1, c0, c1 = tile(parts[CHEST_TILE])
    mz = parts.get('cap_muzzle_v3')
    if mz:
        m0, m1, n0, n1 = tile(mz)
        white = np.median(im[m0:m1, n0:n1].reshape(-1, 3), 0)
    else:
        white = fur_rgb * 1.25
    hh, ww = r1 - r0, c1 - c0
    fu = np.clip((np.arange(ww) / max(ww - 1, 1) - 0.1) / 0.8, 0, 1)
    fv = np.clip((0.9 - np.arange(hh) / max(hh - 1, 1)) / 0.8, 0, 1)
    wgt = (fu[None, :] ** 1.5) * (fv[:, None] ** 1.2)
    im[r0:r1, c0:c1] = fur_rgb * (1 - wgt[..., None]) + white * wgt[..., None]
    # звёзды и бант Блёстки нарисованы и в текстуре головы Tripo (под золотыми частями) — закрасить мехом вокруг
    from scipy import ndimage as nd
    from mesh_parts import hsv
    for pn in [k for k, q in parts.items() if q['role'] in ('head', 'fur')]:
        r0, r1, c0, c1 = tile(parts[pn])
        t = im[r0:r1, c0:c1]
        h_, s_, v_ = hsv(t.reshape(-1, 3))
        yel = ((h_ > 30) & (h_ < 75) & (s_ > 0.18) & (v_ > 0.45)).reshape(t.shape[:2])
        yel = nd.binary_dilation(nd.binary_opening(yel), iterations=3)
        if yel.sum() < 4:
            continue
        w = (~yel).astype(np.float64)
        num = np.stack([nd.gaussian_filter(t[..., c] * w, 6) for c in range(3)], -1)
        den = nd.gaussian_filter(w, 6)[..., None]
        fill = num / np.maximum(den, 1e-6)
        t[yel] = fill[yel]
        im[r0:r1, c0:c1] = t
        print(f'  {pn}: закрашено золото {int(yel.sum())} px')
    # серые/светлые пятна Tripo на макушке и висках (под бантом и звёздами текстура не мех): тексели треугольников
    # головы выше глаз с цветом «не мех» (синий не преобладает) — закрасить мехом вокруг
    mask_up = np.zeros(im.shape[:2], bool)
    up_t = (role[F] == 'head').sum(1) >= 2
    up_t &= V[F].mean(1)[:, 1] > UPPER_Y
    for t_ in F[up_t]:
        uv = UV[t_] * [Wd, H]
        x0_, y0_ = np.floor(uv.min(0)).astype(int); x1_, y1_ = np.ceil(uv.max(0)).astype(int)
        if x1_ - x0_ > 200 or y1_ - y0_ > 200:
            continue
        gx, gy = np.meshgrid(np.arange(x0_, x1_ + 1) + 0.5, np.arange(y0_, y1_ + 1) + 0.5)
        a_, b_, c_ = uv
        d_ = (b_[1] - c_[1]) * (a_[0] - c_[0]) + (c_[0] - b_[0]) * (a_[1] - c_[1])
        if abs(d_) < 1e-9:
            continue
        l0 = ((b_[1] - c_[1]) * (gx - c_[0]) + (c_[0] - b_[0]) * (gy - c_[1])) / d_
        l1 = ((c_[1] - a_[1]) * (gx - c_[0]) + (a_[0] - c_[0]) * (gy - c_[1])) / d_
        ins = (l0 >= -0.05) & (l1 >= -0.05) & (1 - l0 - l1 >= -0.05)
        yy, xx = gy[ins].astype(int), gx[ins].astype(int)
        ok_ = (yy >= 0) & (yy < H) & (xx >= 0) & (xx < Wd)
        mask_up[yy[ok_], xx[ok_]] = True
    rgb = im / 255
    notfur = (rgb[..., 2] - rgb[..., 0] < 0.07)
    bad = mask_up & notfur
    bad = nd.binary_dilation(nd.binary_opening(bad), iterations=2) & mask_up
    if bad.sum():
        w = (mask_up & ~bad).astype(np.float64)
        for c in range(3):
            num = nd.gaussian_filter(im[..., c] * w, 8); den = nd.gaussian_filter(w, 8)
            ch = im[..., c]
            ch[bad] = (num / np.maximum(den, 1e-6))[bad]
        print(f'  макушка/виски: закрашено не-меха {int(bad.sum())} px')
    q = next(q for q in parts.values() if q['role'] == 'tail')
    r0, r1, c0, c1 = tile(q)
    t = im[r0:r1, c0:c1]
    lum = t.mean(2, keepdims=True)
    lum_s = np.asarray(Image.fromarray(np.clip(lum[..., 0], 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.2))).astype(np.float64)[..., None]
    k = np.clip(lum_s / max(np.median(lum), 1), 0.85, 1.12)
    im[r0:r1, c0:c1] = fur_rgb * k
    g.set_image(src_i, Image.fromarray(np.clip(im, 0, 255).astype(np.uint8)))
    # нормали в плитках одежды — плоские
    if 'normalTexture' in mat:
        ni_ = j['textures'][mat['normalTexture']['index']]['source']
        nm_im = np.asarray(g.image(ni_).convert('RGB')).copy()
        for nm, q in parts.items():
            if q['role'] in ('cloth', 'tutu', 'gold', 'tail'):
                r0, r1, c0, c1 = tile(q)
                nm_im[r0:r1, c0:c1] = (128, 128, 255) if q['role'] != 'tail' else nm_im[r0:r1, c0:c1]
        g.set_image(ni_, Image.fromarray(nm_im))
    ex = j.setdefault('asset', {}).setdefault('extras', {})
    ex['catBase'] = {'version': VERSION, 'torsoIn': TORSO_IN}
    ex.setdefault('glitterP4', {'parts': parts})
    gc(g)
    total = g.save(dst)
    print(f'→ {dst} {total / 1e6:.2f} MB; тело {len(Fn)} треуг., {len(Vn)} вершин')


if __name__ == '__main__':
    main()

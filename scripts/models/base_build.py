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
TORSO_IN = 0.009
TORSO_PARTS = ('tripo_part_2', 'tripo_part_9', 'tripo_part_10', 'tripo_part_11', 'tripo_part_13')
# одежда базы, которую уносит скин Блёстки
CLOTH_MESHES = ('Skirt_P4', 'Bow_Glitter')
FUR_PATCH = 'tripo_part_3'  # плитка ноги — тон меха торса


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
    tri_part = pv[F]
    tri_role = role[F]
    cloth_t = (tri_role == 'cloth').sum(1) >= 2
    # ── торс: оболочка худи и рукавов внутрь
    tor_t = np.isin(tri_part, TORSO_PARTS).sum(1) >= 2
    tor_t &= cloth_t
    tv, tinv = np.unique(F[tor_t].ravel(), return_inverse=True)
    Ft = tinv.reshape(-1, 3)
    Vt = V[tv].copy()
    nt = vnormals(Vt, Ft)
    # нормали Tripo у края частей — наружу: сдвиг внутрь по сглаженной нормали
    wm = weld_map(Vt); E = wm[edges_of(Ft)]
    ns = np.zeros((wm.max() + 1, 3)); np.add.at(ns, wm, nt)
    ns = smooth_field(ns, E, wm.max() + 1, 6)[wm]
    ns /= np.maximum(np.linalg.norm(ns, axis=1, keepdims=True), 1e-12)
    Vt -= ns * TORSO_IN
    # капюшон: оболочка внутрь повторяла бы горб — спина торса не дальше гладкой линии спины (z по высоте)
    back = Vt[:, 2] < np.percentile(Vt[:, 2], 30)
    ys = np.linspace(Vt[:, 1].min(), Vt[:, 1].max(), 24)
    zb = np.array([np.percentile(Vt[(np.abs(Vt[:, 1] - y) < 0.02) & (np.abs(Vt[:, 0]) < 0.08), 2], 15) if ((np.abs(Vt[:, 1] - y) < 0.02) & (np.abs(Vt[:, 0]) < 0.08)).sum() > 8 else np.nan for y in ys])
    ok = ~np.isnan(zb)
    zb_lo = np.interp(Vt[:, 1], ys[ok], zb[ok])
    # гладкая спина: нижняя огибающая без горба — минимум по окрестности высоты заменён линейной подгонкой нижней трети
    yl = ys[ok]; zl = zb[ok]
    lowmask = yl < np.percentile(yl, 55)
    if lowmask.sum() >= 3:
        k = np.polyfit(yl[lowmask], zl[lowmask], 1)
        zfit = np.polyval(k, Vt[:, 1])
        hood = back & (Vt[:, 1] > np.percentile(yl, 55)) & (Vt[:, 2] < zfit)
        Vt[hood, 2] = zfit[hood] + (Vt[hood, 2] - zfit[hood]) * 0.25
    _ = zb_lo
    # UV и тон — плитка ноги (мех)
    x0, y0, x1, y1 = parts[FUR_PATCH]['uv']
    UVt = np.tile([[(x0 + x1) / 2, (y0 + y1) / 2]], (len(Vt), 1))
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
    pr['indices'] = g.add_acc(Fn.ravel().astype(np.uint32), 5125, 'SCALAR', 34963)
    pr.pop('targets', None)
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

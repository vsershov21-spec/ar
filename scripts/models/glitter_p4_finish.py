"""Блёстка p4, последняя стадия основы (после face_detail.py и persona_tune.py): мех-оболочки, пачка и золото
отдельными мешами, материал тела как у Хулигана/Добряка (sheen). Без Blender.

    python3 scripts/models/glitter_p4_finish.py /tmp/p4/pt.glb public/models/v2/glitter_p4.glb --parts /tmp/p4/base_parts.json

  • BD_FurShell — треугольники меха (голова, уши, кисти, ноги, хвост — по прямоугольникам частей в атласе,
    asset.extras.glitterP4) на буферах тела + _FURLEN: короткий плюш (голова ≈ 2.3 мм, тело 5 мм, хвост 7 мм),
    у глаз, носа, рта, бровей и на морде у губ — 0, кисти — без меха; кончики не светлее меха (без белой бахромы).
    Ключи тела (рот, брови, щёки) — те же, мех едет с мордой. Оболочки строит рантайм (furShell.ts).
  • Skirt_P4 — пачка Tripo своим мешем: полупрозрачная (alpha 0.8), двусторонняя, текстура Tripo (блёстки, кайма).
  • Bow_Glitter — бант, звёзды у висков, кант пояса: золото (metallic 0.55, roughness 0.32, лёгкая подсветка).
Оба меша — свои буферы (только их вершины) на том же скине; из тела их треугольники убраны.
"""
import sys, os, json
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from face_detail import G2, gc  # noqa: E402
from glitter_p3 import add_skinned_node, weld_map, edges_of, smooth_field  # noqa: E402

FUR_ROLES = {'head', 'fur', 'tail', 'muzzle'}
VERSION = 1


def roles_by_uv(UV, parts):
    """роль вершины — по прямоугольнику её части в атласе"""
    role = np.full(len(UV), '', dtype=object)
    for nm, q in parts.items():
        x0, y0, x1, y1 = q['uv']
        m = (UV[:, 0] >= x0) & (UV[:, 0] <= x1) & (UV[:, 1] >= y0) & (UV[:, 1] <= y1)
        role[m] = q['role']
    return role


def main():
    src, dst = sys.argv[1:3]
    g = G2(src); j = g.j
    ex = j.setdefault('asset', {}).setdefault('extras', {})
    if '--parts' in sys.argv:  # роли частей от glitter_p4.py (Blender-стадии теряют asset.extras)
        ex['glitterP4'] = json.load(open(sys.argv[sys.argv.index('--parts') + 1]))
    info = ex['glitterP4']
    mi, pr = g.main_mesh()
    mesh = j['meshes'][mi]
    A = pr['attributes']
    V = g.acc(A['POSITION']).astype(np.float64)
    UV = g.acc(A['TEXCOORD_0']).astype(np.float64)
    Jt = g.acc(A['JOINTS_0']); Wt = g.acc(A['WEIGHTS_0']).astype(np.float64)
    F = g.acc(pr['indices']).reshape(-1, 3).astype(np.int64)
    role = roles_by_uv(UV, info['parts'])
    sk = j['skins'][0]
    jname = [j['nodes'][k]['name'].replace('mixamorig:', '') for k in sk['joints']]
    tri_role = role[F]
    # треугольник — роль большинства (полосы вшивки лежат в текстуре головы)
    def tri_is(r):
        return (tri_role == r).sum(1) >= 2
    sk_tri = tri_is('tutu'); gold_tri = tri_is('gold')

    # ── мех ──
    def bw(pred):
        ids = [i for i, n in enumerate(jname) if pred(n)]
        return (np.isin(Jt, ids) * Wt).sum(1)
    head = bw(lambda n: 'Head' in n or 'Ear' in n)
    hand = bw(lambda n: 'Hand' in n)
    foot = bw(lambda n: 'Foot' in n or 'Toe' in n)
    tail = bw(lambda n: n.startswith('Tail'))
    fur = np.isin(role, list(FUR_ROLES)).astype(float)
    wm = weld_map(V); nW = wm.max() + 1
    E = wm[edges_of(F)]
    s = np.zeros(nW); c = np.zeros(nW); np.add.at(s, wm, fur); np.add.at(c, wm, 1)
    fw = s / np.maximum(c, 1)
    lo = (fw > 0.99).astype(float)
    for _ in range(2):  # край меха (у одежды, лица) → 0
        m = lo.copy(); np.minimum.at(m, E[:, 0], lo[E[:, 1]]); np.minimum.at(m, E[:, 1], lo[E[:, 0]]); lo = m
    lo = smooth_field(lo, E, nW, 3)[wm]
    L = 0.005 * lo * (1 - 0.55 * np.clip(head, 0, 1)) * (1 + 0.4 * np.clip(tail, 0, 1)) * (1 - 0.35 * np.clip(foot, 0, 1))
    L *= 1 - np.clip((hand - 0.1) / 0.4, 0, 1)
    # лицо: у глаз, носа, рта, бровей — без меха; морда у губ — коротко (точки лица — extras.marks узла Brows)
    marks = next(n['extras']['marks'] for n in j['nodes'] if n.get('name') == 'Brows')
    def near(p, r0, r1):
        d = np.linalg.norm(V - np.array(p), axis=1)
        return np.clip((d - r0) / (r1 - r0), 0, 1)
    k = np.ones(len(V))
    for sd in 'LR':
        ec = (np.array(marks[f'eyeOuter{sd}']) + np.array(marks[f'eyeInner{sd}'])) / 2
        k *= near(ec, 0.052, 0.07)
    for key in ('nose', 'mouth'):
        if key in marks:
            k *= near(marks[key], 0.03 if key == 'nose' else 0.045, 0.055 if key == 'nose' else 0.07)
    L *= k * (role != 'muzzle') * (role != 'brow') * (role != 'nose')
    L[~np.isin(role, list(FUR_ROLES))] = 0
    L = L.astype(np.float32)
    body_tris = np.where(~sk_tri & ~gold_tri)[0]
    ftri = F[body_tris][(L[F[body_tris]] > 0.0012).all(1)]
    fur_node = {'name': 'BD_FurShell', 'skin': 0, 'extras': {'fur': {'layers': 3, 'density': 220, 'tip': [0.97, 0.97, 0.99], 'head': 1}}}
    fp = {'attributes': dict(A), 'indices': g.add_acc(ftri.ravel().astype(np.uint32), 5125, 'SCALAR', 34963)}
    fp['attributes']['_FURLEN'] = g.add_acc(L, 5126, 'SCALAR', 34962)
    if pr.get('targets'):
        fp['targets'] = [dict(t) for t in pr['targets']]
    j['materials'].append({'name': 'BD_FurShell_mat', 'alphaMode': 'MASK', 'alphaCutoff': 0.5,
                           'pbrMetallicRoughness': {'baseColorFactor': [1, 1, 1, 0], 'metallicFactor': 0}})
    fp['material'] = len(j['materials']) - 1
    fm = {'name': 'BD_FurShell', 'primitives': [fp]}
    if 'extras' in mesh and 'targetNames' in mesh['extras']:
        fm['extras'] = {'targetNames': list(mesh['extras']['targetNames'])}
    if 'weights' in mesh:
        fm['weights'] = list(mesh['weights'])
    j['meshes'].append(fm)
    add_skinned_node(j, 'BD_FurShell', len(j['meshes']) - 1, fur_node['extras'])
    print(f'мех: {len(ftri)} треуг., длина до {L.max() * 1000:.1f} мм (голова — медиана {np.median(L[(head > 0.5) & (L > 0)]) * 1000:.1f} мм)')

    # ── пачка и золото — свои меши ──
    N = g.acc(A['NORMAL']).astype(np.float32)
    mat = j['materials'][pr['material']]
    bct = mat['pbrMetallicRoughness']['baseColorTexture']['index']
    nrt = mat['normalTexture']['index']

    def sub_mesh(name, tris, m, extras):
        sv, inv = np.unique(F[tris].ravel(), return_inverse=True)
        sa = {'POSITION': g.add_acc(V[sv].astype(np.float32), 5126, 'VEC3', 34962), 'NORMAL': g.add_acc(N[sv], 5126, 'VEC3', 34962),
              'TEXCOORD_0': g.add_acc(UV[sv].astype(np.float32), 5126, 'VEC2', 34962),
              'JOINTS_0': g.add_acc(Jt[sv].astype(np.uint16), 5123, 'VEC4', 34962), 'WEIGHTS_0': g.add_acc(Wt[sv].astype(np.float32), 5126, 'VEC4', 34962)}
        j['materials'].append(m)
        sp = {'attributes': sa, 'indices': g.add_acc(inv.astype(np.uint16), 5123, 'SCALAR', 34963), 'material': len(j['materials']) - 1}
        j['meshes'].append({'name': name, 'primitives': [sp]})
        add_skinned_node(j, name, len(j['meshes']) - 1, extras)
        print(f'{name}: {len(sv)} вершин, {int(tris.sum())} треуг.')
    sub_mesh('Skirt_P4', sk_tri, {'name': 'Skirt_P4_mat', 'alphaMode': 'BLEND', 'doubleSided': True,
             'pbrMetallicRoughness': {'baseColorTexture': {'index': bct}, 'baseColorFactor': [1, 1, 1, 0.8], 'metallicFactor': 0.0, 'roughnessFactor': 0.55},
             'normalTexture': {'index': nrt}}, {'skirtP4': 1, 'tulle': 1})
    sub_mesh('Bow_Glitter', gold_tri, {'name': 'Gold_P4_mat', 'pbrMetallicRoughness': {'baseColorTexture': {'index': bct},
             'metallicFactor': 0.55, 'roughnessFactor': 0.32}, 'normalTexture': {'index': nrt}, 'emissiveFactor': [0.10, 0.08, 0.03]},
             {'part': 'bow', 'goldP4': 1})
    keep = np.where(~sk_tri & ~gold_tri)[0]
    pr['indices'] = g.add_acc(F[keep].ravel().astype(np.uint32), 5125, 'SCALAR', 34963)
    # тело: как у Хулигана/Добряка — двустороннее, мягкий блеск меха (sheen, cat_look.py)
    mat['doubleSided'] = True
    mat.setdefault('extensions', {})['KHR_materials_sheen'] = {'sheenColorFactor': [0.55, 0.55, 0.6], 'sheenColorTexture': {'index': bct}, 'sheenRoughnessFactor': 0.45}
    used = set(j.get('extensionsUsed', [])); used.add('KHR_materials_sheen'); j['extensionsUsed'] = sorted(used)
    info['finish'] = VERSION
    info.pop('parts_v', None)
    gc(g)
    total = g.save(dst)
    print(f'→ {dst} {total / 1e6:.2f} MB; тело {len(keep)} треуг.')


if __name__ == '__main__':
    main()

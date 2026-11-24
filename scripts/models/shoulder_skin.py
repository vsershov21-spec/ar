#!/usr/bin/env python3
"""Шарф Добряка и дуга наушников Хулигана — веса скина у плеча (anim-audit 24.11, п. 2: лапа с предметом у рта проходит
сквозь шарф/наушники). Без Blender: правятся только JOINTS_0/WEIGHTS_0 (тот же размер буферов), геометрия, морфы,
текстуры и кости — байт в байт.

    python3 scripts/models/shoulder_skin.py kind     public/models/v2/kind_p1.glb     public/models/v2/kind_p1.glb
    python3 scripts/models/shoulder_skin.py hooligan public/models/v2/hooligan_p1.glb public/models/v2/hooligan_p1.glb
    # затем: face_rig.py (p2 из p1) и colliders.py (прокси p1 с blend — едут как вершины ткани)

Что делает (вершины детали — метка mesh_parts.label_parts: шарф / наушники; соседние вершины тела и меха — с плавным
спадом за FALL по расстоянию до детали):
  1. Голова → шея (кроме вершин морды, Head ≥ 0.45): у Tripo-рига ткань у плеч на 25–50 % идёт за костью Head — наклон головы к предмету (клипы
     hold_*_low) тянет шарф/дугу вниз-вперёд, в лапу. Доля HEAD веса Head переходит к Neck.
  2. Ключица → плечо: у плечевого сустава (ближе SH_R к суставу Arm) доля ARM веса ключицы переходит к кости плеча —
     ткань над суставом подаётся вместе с поднятой лапой, а не протыкается ею.
Оболочки меха BD_FurShell — те же буферы, что у тела; карточки меха и накладки (BD_*) — тот же пересчёт по метке
ближайшей вершины тела. Повтор по уже правленой модели отказывается (asset.extras.shoulderSkin).
"""
import sys, argparse
import numpy as np
from scipy.spatial import cKDTree
from glb_io import Glb
from mesh_parts import label_parts, PHONES, SCARF

TAG = 'shoulderSkin'
PART = {'kind': SCARF, 'hooligan': PHONES}
FALL = 0.015  # спад на соседние вершины тела, доли роста
HEAD_KEEP = 0.45  # см. remap
SH_R = {'kind': 0.22, 'hooligan': 0.16}  # радиус влияния плечевого сустава, доли роста


def remap(J, W, f, g, ids, head, arm):
    """J, W — (n, 4); f — вес детали 0..1; g — (n,) близость к суставу 0..1 и сторона (+1 L / −1 R) в знаке"""
    n = len(J)
    full = np.zeros((n, ids['n']))
    np.add.at(full, (np.repeat(np.arange(n), 4), J.ravel()), W.ravel())
    s = full.sum(1, keepdims=True)
    full /= np.maximum(s, 1e-9)
    # вершины с весом головы ≥ HEAD_KEEP не трогаем: face_rig.py выносит в морду (FaceSkin, морфы) вершины с Head ≥ 0.5 —
    # набор вершин морды и её морфы остаются прежними
    hk = full[:, ids['Head']] < HEAD_KEEP
    f = f * hk
    mv = full[:, ids['Head']] * head * f
    full[:, ids['Head']] -= mv
    full[:, ids['Neck']] += mv
    for side, sg in (('Left', 1), ('Right', -1)):
        k = np.clip(g * sg, 0, 1) * f * arm
        c = ids[side + 'Shoulder']; a = ids[side + 'Arm']
        mv = full[:, c] * k
        full[:, c] -= mv
        full[:, a] += mv
    top = np.argsort(-full, axis=1)[:, :4]
    w = np.take_along_axis(full, top, 1)
    w /= np.maximum(w.sum(1, keepdims=True), 1e-9)
    keep = f <= 0  # нетронутые строки — байт в байт
    top[keep] = J[keep]; w[keep] = W[keep]
    return top, w


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('cat'); ap.add_argument('src'); ap.add_argument('dst')
    ap.add_argument('--head', type=float, default=1.0, help='доля веса Head → Neck у детали')
    ap.add_argument('--arm', type=float, default=1.0, help='доля веса ключицы → плечо у сустава')
    ap.add_argument('--shr', type=float, default=None, help='радиус влияния плечевого сустава, доли роста')
    a = ap.parse_args()
    if a.shr is None:
        a.shr = SH_R[a.cat]
    g = Glb(a.src); j = g.j
    if j.get('asset', {}).get('extras', {}).get(TAG):
        sys.exit(f'{a.src}: уже правлено ({TAG}) — берите исходную модель')
    names = [j['nodes'][k]['name'].replace('mixamorig:', '') for k in j['skins'][0]['joints']]
    ids = {n: i for i, n in enumerate(names)}; ids['n'] = len(names)
    bi, b = g.main_mesh()
    I = g.acc(b['indices']).reshape(-1, 3).astype(np.int64)
    P = g.acc(b['attributes']['POSITION']).astype(np.float64)
    lab = label_parts(a.cat, g, b, P, I)
    part = lab == PART[a.cat]
    tree = cKDTree(P[part])
    # сустав плеча в позе покоя (мир модели)
    def node_pos(name):
        par = {}
        for i, n in enumerate(j['nodes']):
            for c in n.get('children', []):
                par[c] = i
        idx = next(i for i, n in enumerate(j['nodes']) if n.get('name', '').replace('mixamorig:', '') == name)
        M = np.eye(4)
        while True:
            n = j['nodes'][idx]; m = np.eye(4)
            if 'matrix' in n:
                m = np.array(n['matrix']).reshape(4, 4).T
            else:
                x, y, z, w = n.get('rotation', [0, 0, 0, 1])
                R = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)], [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)], [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
                m[:3, :3] = R * np.array(n.get('scale', [1, 1, 1])); m[:3, 3] = n.get('translation', [0, 0, 0])
            M = m @ M
            if idx not in par:
                break
            idx = par[idx]
        return M[:3, 3]
    shL, shR = node_pos('LeftArm'), node_pos('RightArm')

    def weights_for(X, own_part=None):
        d, _ = tree.query(X)
        f = np.clip(1 - d / FALL, 0, 1)
        if own_part is not None:
            f[own_part] = 1.0
        gL = np.clip(1 - np.linalg.norm(X - shL, axis=1) / a.shr, 0, 1)
        gR = np.clip(1 - np.linalg.norm(X - shR, axis=1) / a.shr, 0, 1)
        return f, np.where(X[:, 0] > 0, gL, -gR)

    done = set()
    stats = []
    for m in j['meshes']:
        for p in m['primitives']:
            at = p['attributes']
            if 'JOINTS_0' not in at or (at['JOINTS_0'], at['WEIGHTS_0']) in done:
                continue
            done.add((at['JOINTS_0'], at['WEIGHTS_0']))
            X = g.acc(at['POSITION']).astype(np.float64)
            f, gs = weights_for(X, part if at['POSITION'] == b['attributes']['POSITION'] else None)
            sel = f > 0
            if not sel.any():
                continue
            J = g.acc(at['JOINTS_0']).astype(np.int64); Wa = g.acc(at['WEIGHTS_0']).astype(np.float64)
            wacc = j['accessors'][at['WEIGHTS_0']]
            scale = 1.0
            if wacc['componentType'] == 5121:
                scale = 255.0
            elif wacc['componentType'] == 5123:
                scale = 65535.0
            Wf = Wa / scale
            nJ, nW = remap(J[sel], Wf[sel], f[sel], gs[sel], ids, a.head, a.arm)
            J2 = J.copy(); W2 = Wf.copy()
            J2[sel] = nJ; W2[sel] = nW
            if scale != 1.0:
                W2 = np.round(W2 * scale)
            g.set_acc(at['JOINTS_0'], J2)
            g.set_acc(at['WEIGHTS_0'], W2)
            stats.append(f'{m["name"]}: {int(sel.sum())} вершин')
    j.setdefault('asset', {}).setdefault('extras', {})[TAG] = {'version': 1, 'head': a.head, 'arm': a.arm, 'fall': FALL, 'shR': a.shr}
    g.save(a.dst)
    print(f'{a.cat}: {"; ".join(stats)} → {a.dst}')


if __name__ == '__main__':
    main()

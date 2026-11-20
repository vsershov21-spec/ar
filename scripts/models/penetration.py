#!/usr/bin/env python3
"""Статическая проверка взаимопроникновений: тело, голова, одежда/аксессуары, мех-оболочки и пряди.

  python3 scripts/models/penetration.py <cat> model.glb anims.glb out.md [--img dir] [--poses rest|all]

Сетка Tripo у всех трёх котов — одна сплошная оболочка (тело + кепка/худи/наушники/шарф/бант/юбка спаяны), поэтому
части размечаются по цвету альбедо и месту (mesh_parts.label_parts), а проникновение — это пересечение двух
несмежных треугольников (не имеющих общей сшитой вершины): часть сквозь часть или складка сама в себя.
Плюс накладки: BD_FurCards (пряди), внешняя мех-оболочка (тело + нормаль·_FURLEN, провисание — как в furShell.ts),
Blush/BD_Pads/BD_Cloth/BD_Metal/Emblem — против одежды.
Позы: покой + крайние кадры из anims_v1 (руки к лицу, руки вверх, присед, сидя, обнять), скин — LBS как в three.js
(морфы не учитываются). Соседство по скелету в позе: пересечения кисть↔голова/тело в позах — ожидаемые касания
(рука лежит на щеке), их отчёт перечисляет отдельно («контакт ладони»), а не как дефект модели.
Пересечение отрезок–треугольник: Möller–Trumbore, кандидаты — cKDTree по центрам треугольников.
"""
import sys, os, re
import numpy as np
from scipy.spatial import cKDTree
from glb_io import Glb
from mesh_parts import weld, label_parts, tri_label, PART_NAMES, BODY

POSES = [  # (клип, доли длительности) — крайние позы
    ('cover_ears', (0.3, 0.5)), ('poke_cheek', (0.4,)), ('cry', (0.5,)), ('shy', (0.5,)),
    ('cheer', (0.3, 0.6)), ('celebrate', (0.4,)), ('idle_stretch', (0.5,)),
    ('sit', (0.6, 0.9)), ('scared_01', (0.5,)), ('frightened', (0.5,)), ('fold_arms', (0.6,)), ('hug', (0.5,)),
    ('idle_hooligan_headphones', (0.4,)), ('think', (0.5,)), ('scratch', (0.5,)),
]


def quat_mat(q):
    x, y, z, w = q[..., 0], q[..., 1], q[..., 2], q[..., 3]
    return np.stack([np.stack([1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)], -1),
                     np.stack([2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)], -1),
                     np.stack([2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)], -1)], -2)


class Rig:
    def __init__(self, g):
        self.g = g; j = g.j
        self.par = {}
        for i, n in enumerate(j['nodes']):
            for c in n.get('children', []):
                self.par[c] = i
        self.T = [np.array(n.get('translation', [0, 0, 0]), float) for n in j['nodes']]
        self.R = [np.array(n.get('rotation', [0, 0, 0, 1]), float) for n in j['nodes']]
        self.S = [np.array(n.get('scale', [1, 1, 1]), float) for n in j['nodes']]
        self.byname = {n.get('name'): i for i, n in enumerate(j['nodes'])}
        sk = j['skins'][0]
        self.joints = sk['joints']
        self.ibm = g.acc(sk['inverseBindMatrices']).reshape(-1, 4, 4).transpose(0, 2, 1).astype(float)

    def world(self, over=None):
        over = over or {}
        W = {}

        def w(i):
            if i in W:
                return W[i]
            t, r, s = self.T[i], self.R[i], self.S[i]
            if i in over:
                t = over[i].get('translation', t); r = over[i].get('rotation', r)
            M = np.eye(4); M[:3, :3] = quat_mat(np.asarray(r)) * s; M[:3, 3] = t
            W[i] = w(self.par[i]) @ M if i in self.par else M
            return W[i]
        for i in range(len(self.T)):
            w(i)
        return W

    def skin_mats(self, over=None):
        W = self.world(over)
        return np.stack([W[jn] @ self.ibm[k] for k, jn in enumerate(self.joints)])


def sample_clip(ga, name, frac, rig):
    """кадр клипа anims_v1 → переопределения узлов модели по имени кости"""
    j = ga.j
    a = next((x for x in j['animations'] if x['name'] == name), None)
    if a is None:
        return None
    tmax = max(ga.acc(s['input']).max() for s in a['samplers'])
    t = tmax * frac
    over = {}
    for ch in a['channels']:
        s = a['samplers'][ch['sampler']]
        nname = j['nodes'][ch['target']['node']]['name']
        ni = rig.byname.get(nname)
        if ni is None:
            continue
        ti = ga.acc(s['input']); vo = ga.acc(s['output']).astype(float)
        oa = j['accessors'][s['output']]
        if oa.get('normalized'):
            vo /= {5120: 127, 5121: 255, 5122: 32767, 5123: 65535}[oa['componentType']]
        k = int(np.clip(np.searchsorted(ti, t), 1, len(ti) - 1))
        u = float(np.clip((t - ti[k - 1]) / max(ti[k] - ti[k - 1], 1e-9), 0, 1))
        path = ch['target']['path']
        if path == 'rotation':
            q0, q1 = vo[k - 1].astype(float), vo[k].astype(float)
            if np.dot(q0, q1) < 0:
                q1 = -q1
            q = q0 * (1 - u) + q1 * u; q /= np.linalg.norm(q)
            over.setdefault(ni, {})['rotation'] = q
        elif path == 'translation' and 'Hips' in nname:
            pass  # корень не двигаем: важна поза, не место
    return over


def lbs(M, P, J, Wt):
    S = np.einsum('nk,nkij->nij', Wt, M[J])
    return np.einsum('nij,nj->ni', S[:, :3, :3], P) + S[:, :3, 3]


def seg_tri(o, d, a, b, c):
    """отрезок o + t·d, t∈[0,1] пересекает треугольник abc (векторно)"""
    e1 = b - a; e2 = c - a
    p = np.cross(d, e2)
    det = (e1 * p).sum(1)
    ok = np.abs(det) > 1e-14
    inv = np.where(ok, 1 / np.where(ok, det, 1), 0)
    s = o - a
    u = (s * p).sum(1) * inv
    q = np.cross(s, e1)
    v = (d * q).sum(1) * inv
    t = (e2 * q).sum(1) * inv
    return ok & (u >= 0) & (v >= 0) & (u + v <= 1) & (t > 1e-6) & (t < 1 - 1e-6)


def tri_pairs_intersect(V1, T1, V2, T2, adj=None):
    """пары (i, j) пересекающихся треугольников T1[i] и T2[j]; adj(i, j) → bool — смежные (не считать)"""
    C1 = V1[T1].mean(1); C2 = V2[T2].mean(1)
    r1 = np.linalg.norm(V1[T1] - C1[:, None], axis=2).max(1); r2 = np.linalg.norm(V2[T2] - C2[:, None], axis=2).max(1)
    # широкая фаза: обычные треугольники — одним запросом с малым радиусом, крупные — каждый своим
    q = max(np.percentile(r1, 97), np.percentile(r2, 97))
    t2 = cKDTree(C2)
    small = np.where(r1 <= q)[0]
    lst = cKDTree(C1[small]).query_ball_tree(t2, q + min(q, r2.max()))
    I = [small[i] for i, l in enumerate(lst) for _ in l]
    Jj = [k for l in lst for k in l]
    for i in np.where(r1 > q)[0]:
        l = t2.query_ball_point(C1[i], r1[i] + r2.max())
        I += [i] * len(l); Jj += l
    big2 = np.where(r2 > q)[0]
    if len(big2):
        t1 = cKDTree(C1)
        for k in big2:
            l = t1.query_ball_point(C2[k], r2[k] + q)
            I += l; Jj += [k] * len(l)
    I = np.array(I, dtype=np.int64); Jj = np.array(Jj, dtype=np.int64)
    if not len(I):
        return np.zeros((0, 2), np.int64)
    key = np.unique(I * (len(T2) + 1) + Jj)
    I, Jj = key // (len(T2) + 1), key % (len(T2) + 1)
    dd = np.linalg.norm(C1[I] - C2[Jj], axis=1)
    m = dd < r1[I] + r2[Jj]
    I, Jj = I[m], Jj[m]
    if adj is not None:
        m = ~adj(I, Jj)
        I, Jj = I[m], Jj[m]
    hit = np.zeros(len(I), bool)
    A1, B1, Cc1 = V1[T1[I, 0]], V1[T1[I, 1]], V1[T1[I, 2]]
    A2, B2, Cc2 = V2[T2[Jj, 0]], V2[T2[Jj, 1]], V2[T2[Jj, 2]]
    for (o, e) in ((A1, B1), (B1, Cc1), (Cc1, A1)):
        hit |= seg_tri(o, e - o, A2, B2, Cc2)
    for (o, e) in ((A2, B2), (B2, Cc2), (Cc2, A2)):
        hit |= seg_tri(o, e - o, A1, B1, Cc1)
    return np.stack([I[hit], Jj[hit]], 1)


class Model:
    def __init__(self, cat, path):
        self.cat = cat
        g = self.g = Glb(path); j = g.j
        self.rig = Rig(g)
        bi, b0 = g.main_mesh()
        b, self.I = g.merged_body()  # тело + части одежды (split_parts) одной сеткой
        A = lambda k: g.acc(b['attributes'][k])
        self.P = A('POSITION').astype(float); self.N = A('NORMAL').astype(float)
        self.J = A('JOINTS_0').astype(np.int64); self.W = A('WEIGHTS_0').astype(float)
        if self.W.max() > 1.5:
            self.W /= 255
        self.wl = weld(self.P)
        self.lab = label_parts(cat, g, b, self.P, self.I)
        self.over = []  # (name, P, I, J, W, kind)
        for n in j['nodes']:
            if 'mesh' not in n or 'skin' not in n:
                continue
            m = j['meshes'][n['mesh']]; nm = m['name']
            if n.get('extras', {}).get('part') or (m['primitives'][0]['attributes']['POSITION'] == b0['attributes']['POSITION'] and nm != 'BD_FurShell'):
                continue
            solid = bool(n.get('extras', {}).get('tulle') or n.get('extras', {}).get('headphones'))
            prs = m['primitives']
            pr = prs[0]
            if nm == 'BD_FurShell':
                if '_FURLEN' not in pr['attributes']:
                    continue
                L = g.acc(pr['attributes']['_FURLEN']).astype(float)
                Ish = g.acc(pr['indices']).reshape(-1, 3).astype(np.int64)
                nL = len(L)  # оболочки — на буферах тела (первые вершины объединённой сетки)
                Po = self.P[:nL] + self.N[:nL] * L[:, None]
                Po[:, 1] -= 0.45 * L
                # внешняя оболочка — «отрезки шерсти» от корня до кончика проверяются как тонкие треугольники
                self.over.append(('мех-оболочка', Po, Ish, self.J[:nL], self.W[:nL], 'shell'))
                continue
            if nm in ('Blush',):
                continue  # плоская накладка на щеке (поверх тела по построению)
            Ps, Is, Js, Ws, off = [], [], [], [], 0
            for pr in prs:  # несколько примитивов (наушники: корпус + амбушюры) — одной сеткой
                P2 = g.acc(pr['attributes']['POSITION']).astype(float)
                Ps.append(P2); Is.append(g.acc(pr['indices']).reshape(-1, 3).astype(np.int64) + off); off += len(P2)
                Js.append(g.acc(pr['attributes']['JOINTS_0']).astype(np.int64))
                W2 = g.acc(pr['attributes']['WEIGHTS_0']).astype(float)
                Ws.append(W2 / 255 if W2.max() > 1.5 else W2)
            P2, I2, J2, W2 = np.vstack(Ps), np.vstack(Is), np.vstack(Js), np.vstack(Ws)
            label = 'пряди меха' if nm == 'BD_FurCards' else 'фатин' if n.get('extras', {}).get('tulle') else 'наушники (деталь)' if n.get('extras', {}).get('headphones') else nm
            self.over.append((label, P2, I2, J2, W2, 'cards' if nm == 'BD_FurCards' else ('tulle' if n.get('extras', {}).get('tulle') else 'solid') if solid else 'overlay'))
        # кисти: треугольники с весом кисти/пальцев (контакт ладони в позах)
        names = [j['nodes'][k]['name'].replace('mixamorig:', '') for k in self.rig.joints]
        hand = np.array(['Hand' in n for n in names])
        self.handv = (self.W * hand[self.J]).sum(1) > 0.5
        head = np.array([n.startswith('Head') or 'Ear' in n for n in names])
        self.headv = (self.W * head[self.J]).sum(1) > 0.5
        # группа кости вершины: голова, туловище, руки (плечо/предплечье), кисти, ноги, хвост (по сторонам)
        def grp(n):
            if n.startswith('Head') or 'Ear' in n or n == 'Neck' or n == 'Jaw':
                return 'head'
            if n.startswith('Tail'):
                return 'tail'
            side = 'L' if n.startswith('Left') else 'R' if n.startswith('Right') else ''
            if 'Hand' in n:
                return 'hand' + side
            if 'ForeArm' in n:
                return 'fore' + side
            if 'Arm' in n or 'Shoulder' in n:
                return 'arm' + side
            if 'Leg' in n or 'Foot' in n or 'Toe' in n:
                return 'leg' + side
            return 'torso'
        G = sorted(set(grp(n) for n in names))
        gi = np.array([G.index(grp(n)) for n in names])
        acc = np.zeros((len(self.P), len(G)))
        for k in range(4):
            np.add.at(acc, (np.arange(len(self.P)), gi[self.J[:, k]]), self.W[:, k])
        self.vgrp = acc.argmax(1); self.G = G

    NEAR = {frozenset(x) for x in (('torso', 'armL'), ('torso', 'armR'), ('armL', 'foreL'), ('armR', 'foreR'), ('foreL', 'handL'), ('foreR', 'handR'), ('torso', 'legL'), ('torso', 'legR'),
                                    ('torso', 'head'), ('torso', 'tail'), ('legL', 'legR'), ('legL', 'tail'), ('legR', 'tail'))}

    def kind(self, p):
        """класс пары в позе: 'складка' — скин (LBS) мнёт сетку у сустава (одна группа костей или соседние), 'контакт' —
        конечность касается другой части тела (кисть у лица, руки скрещены): в статичной сетке неизбежно,
        в рантайме — коллайдеры"""
        ga = np.bincount(self.vgrp[self.I[p[0]]], minlength=len(self.G)).argmax()
        gb = np.bincount(self.vgrp[self.I[p[1]]], minlength=len(self.G)).argmax()
        A, B = self.G[ga], self.G[gb]
        return 'складка' if A == B or frozenset((A, B)) in self.NEAR else 'контакт'

    def check(self, over=None):
        M = self.rig.skin_mats(over)
        # покой = поза привязки: исходные позиции (без шума float от W·IBM)
        L_ = (lambda M_, P_, J_, W_: P_) if over is None else lbs
        V = L_(M, self.P, self.J, self.W)
        wl = self.wl
        T = self.I
        TW = wl[T]

        def adj(a, b_):
            A_, B_ = TW[a], TW[b_]
            return (A_[:, :, None] == B_[:, None, :]).any((1, 2))
        res = {}
        pairs = tri_pairs_intersect(V, T, V, T, adj)
        pairs = pairs[pairs[:, 0] < pairs[:, 1]]
        lt = tri_label(self.lab, T)
        la = lt[pairs[:, 0]], lt[pairs[:, 1]]
        hand = self.handv[T[pairs[:, 0], 0]] | self.handv[T[pairs[:, 1], 0]]
        out = []
        for (p, a, b_, h) in zip(pairs, la[0], la[1], hand):
            key = tuple(sorted((PART_NAMES[a], PART_NAMES[b_])))
            out.append((key, self.kind(p) if over is not None else False, p))
        res['body'] = out
        ov = []
        lt = tri_label(self.lab, T)
        cloth = np.where(lt > 0)[0]
        for (nm, P2, I2, J2, W2, kind) in self.over:
            V2 = L_(M, P2, J2, W2)
            tgt = cloth if kind in ('shell', 'cards') else np.arange(len(T))  # деталь/фатин — против всего тела
            if kind == 'overlay':
                continue  # накладки лежат на своей части по построению (body_detail)
            pp = tri_pairs_intersect(V2, I2, V, T[tgt])
            hand2 = self.handv[T[tgt[pp[:, 1]], 0]] if len(pp) else []
            for p, h in zip(pp, hand2):
                ov.append(((nm, PART_NAMES[lt[tgt[p[1]]]]), bool(h), (p[0], tgt[p[1]])))
            if kind == 'tulle':
                w2 = weld(P2)
                TW2 = w2[I2]
                adj2 = lambda a, b_: (TW2[a][:, :, None] == TW2[b_][:, None, :]).any((1, 2))
                ps = tri_pairs_intersect(V2, I2, V2, I2, adj2)
                for p in ps[ps[:, 0] < ps[:, 1]]:
                    ov.append(((nm, nm), False, tuple(p)))
        res['over'] = ov
        return V, res


def summarize(res):
    agg = {}
    for (key, cls, _p) in res['body'] + res['over']:
        k = key + ((cls,) if isinstance(cls, str) else ('ладонь',) if cls else ())
        agg[k] = agg.get(k, 0) + 1
    return agg


def render_spot(V, T, pairs_tri, path, title):
    """ортопроекции (анфас и профиль) участка вокруг худшего места: серые треугольники, красные — пересекаются"""
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from matplotlib.collections import PolyCollection
    hitc = V[T[pairs_tri]].mean(1)
    tree = cKDTree(hitc)
    cnt = np.array([len(x) for x in tree.query_ball_point(hitc, 0.03)])
    c = hitc[cnt.argmax()]
    C = V[T].mean(1)
    near = np.linalg.norm(C - c, axis=1) < 0.07
    fig, axs = plt.subplots(1, 2, figsize=(8, 4))
    for ax, (a, b_) in zip(axs, ((0, 1), (2, 1))):
        tri = T[near]
        z = V[tri].mean(1)[:, 2 if a == 0 else 0] * (1 if a == 0 else -1)
        o = np.argsort(z)
        polys = V[tri[o]][:, :, [a, b_]]
        hit = np.isin(np.where(near)[0][o], pairs_tri)
        ax.add_collection(PolyCollection(polys, facecolors=np.where(hit[:, None], [[0.9, 0.15, 0.1, 1]], [[0.75, 0.77, 0.82, 1]]), edgecolors=(0.3, 0.3, 0.35, 0.4), linewidths=0.2))
        ax.set_xlim(c[a] - 0.07, c[a] + 0.07); ax.set_ylim(c[b_] - 0.07, c[b_] + 0.07); ax.set_aspect('equal'); ax.axis('off')
        ax.set_title(['анфас', 'профиль'][a == 2])
    fig.suptitle(title, fontsize=9)
    fig.savefig(path, dpi=90); plt.close(fig)


def pose_over(rig, pose):
    """позы из tools/collide-probe.html (имена костей three.js — без «:») → переопределения узлов"""
    by = {n.replace(':', ''): i for n, i in rig.byname.items() if n}
    over = {}
    for name, v in pose.items():
        i = by.get(name)
        if i is not None:
            over[i] = {'rotation': np.array(v['r'], float), 'translation': np.array(v['t'], float)}
    return over


def arm_contacts(md, over):
    """пары «рука/предплечье/кисть ↔ голова, уши, кепка, наушники, капюшон, шарф, бант» (сетка против сетки)"""
    V, res = md.check(over)
    G = md.G
    armg = {G.index(x) for x in G if x.startswith('fore') or x.startswith('hand')}
    torsog = G.index('torso') if 'torso' in G else -1
    headg = G.index('head') if 'head' in G else -1
    T = md.I
    lt = tri_label(md.lab, T)
    def grp(t):
        return np.bincount(md.vgrp[T[t]], minlength=len(G)).argmax()
    hoodw = None
    cnt = {}
    for (key, cls, p) in res['body']:
        ga, gb = grp(p[0]), grp(p[1])
        for x, y, ty in ((ga, gb, p[1]), (gb, ga, p[0])):
            if x in armg and y not in armg:
                tgt = 'голова/уши' if y == headg and lt[ty] == BODY else PART_NAMES[lt[ty]]
                if tgt == 'худи' and y != headg:
                    continue  # худи туловища/рукава — касание рукой корпуса, не лицо/капюшон
                if tgt == 'худи':
                    tgt = 'капюшон'
                if tgt in ('тело', 'обувь', 'юбка'):
                    continue
                k = ('кисть' if G[x].startswith('hand') else 'предплечье') + '↔' + tgt
                cnt[k] = cnt.get(k, 0) + 1
                break
    for (key, cls, p) in res['over']:
        if key[0] in ('наушники (деталь)',):
            # треугольник тела p[1]: рука?
            if grp(p[1]) in armg:
                k = ('кисть' if G[grp(p[1])].startswith('hand') else 'предплечье') + '↔наушники'
                cnt[k] = cnt.get(k, 0) + 1
    return cnt


def main_probe(cat, path, pj, out):
    import json
    md = Model(cat, path)
    d = json.load(open(pj))
    lines = [f'# Руки ↔ голова и одежда после рантайм-коррекции: {cat}', '',
             f'Позы клипов из рантайма (tools/collide-probe.html: GlbCharacter + BodyCollider с прокси `{cat}_colliders.json`), '
             f'8 кадров на клип; «до» — клип как есть, «после» — после `collider.apply()`. Пересечение — сетка руки (плечо, предплечье, кисть) '
             f'против сетки головы/ушей, кепки, наушников (деталь), капюшона, шарфа, банта — пары треугольников '
             f'(касание рукава/кисти корпуса худи и складки плеча сюда не входят — они в penetration_<кот>.md).', '',
             '| клип | до (пар) | после (пар) | после: что с чем | глубина по прокси после, мм |', '|---|---|---|---|---|']
    tot_b = tot_a = 0
    for clip, frames in d['clips'].items():
        if not frames:
            lines.append(f'| {clip} | нет клипа | | | |'); continue
        nb = na = 0; agg = {}; dmax = 0
        for f in frames:
            cb = arm_contacts(md, pose_over(md.rig, f['before'])); ca = arm_contacts(md, pose_over(md.rig, f['after']))
            nb += sum(cb.values()); na += sum(ca.values())
            for k, v in ca.items():
                agg[k] = agg.get(k, 0) + v
            arm = {k: v for k, v in f['pairs'].items() if re.match(r'^(L|R)(Hand|Fore|Elbow|Arm|Wrist|Paw|Tip)', k) or 'Hand' in k or 'Arm' in k}
            if arm:
                dmax = max(dmax, max(arm.values()) * 77)
        tot_b += nb; tot_a += na
        lines.append(f'| {clip} | {nb} | {na} | {"; ".join(f"{k}: {v}" for k, v in sorted(agg.items(), key=lambda x: -x[1])[:4]) or "—"} | {dmax:.1f} |')
        print(f'{cat} {clip}: до {nb}, после {na} {agg}')
    lines += ['', f'Итого: до **{tot_b}**, после **{tot_a}** пар.']
    open(out, 'w').write('\n'.join(lines) + '\n')


def main():
    if '--pose-json' in sys.argv:
        a = sys.argv
        return main_probe(a[1], a[2], a[a.index('--pose-json') + 1], a[a.index('--out') + 1])
    cat, path, anims, out = sys.argv[1:5]
    imgdir = sys.argv[sys.argv.index('--img') + 1] if '--img' in sys.argv else None
    which = sys.argv[sys.argv.index('--poses') + 1] if '--poses' in sys.argv else 'all'
    md = Model(cat, path)
    ga = Glb(anims)  # без EXT_meshopt_compression: node scripts/models/decompress_glb.mjs
    lines = [f'# Проникновения: {cat}', '', f'Модель `{os.path.basename(path)}`, скрипт `scripts/models/penetration.py` (сетка — одна оболочка Tripo, части по цвету: '
             + ', '.join(sorted(set(PART_NAMES[k] for k in np.unique(md.lab)))) + ').', '',
             'Пересечение — два несмежных треугольника (без общей вершины) режут друг друга; «ладонь» — в паре треугольник кисти '
             '(рука касается лица/тела в позе — ожидаемый контакт, рантайм останавливает кисть по коллайдерам `public/models/<cat>_colliders.json`).', '']
    poses = [('покой', 0, None)] + ([(f'{c} @{f:.1f}', c, f) for c, fs in POSES for f in fs] if which == 'all' else [])
    total_rest = None
    worst = None
    lines += ['| поза | всего | складки скина (LBS у суставов) | контакт конечностей | прочие | пары частей (больше всего) |', '|---|---|---|---|---|---|']
    for (label, clip, frac) in poses:
        over = None
        if clip:
            over = sample_clip(ga, clip, frac, md.rig)
            if over is None:
                continue
        V, res = md.check(over)
        agg = summarize(res)
        n = sum(agg.values())
        nf = sum(v for k, v in agg.items() if 'складка' in k); nc = sum(v for k, v in agg.items() if 'контакт' in k or 'ладонь' in k)
        nh = n - nf - nc
        if total_rest is None:
            total_rest = n
        desc = '; '.join(f'{" ↔ ".join(k)}: {v}' for k, v in sorted(agg.items(), key=lambda x: -x[1])[:5]) or '—'
        lines.append(f'| {label} | {n} | {nf} | {nc} | {nh} | {desc} |')
        bad = [p for (k, h, p) in res['body'] if h != 'контакт']
        if imgdir and bad and (worst is None or len(bad) > worst[0]):
            worst = (len(bad), label, V, bad)
        ntl = sum(v for k, v in agg.items() if 'фатин' in k)
        print(f'{cat} {label}: {n} (складки {nf}, контакт {nc}, прочие {nh}{f", с фатином {ntl}" if ntl else ""}) {desc}')
    if imgdir and worst:
        os.makedirs(imgdir, exist_ok=True)
        tris = np.unique(np.array(worst[3]).ravel())
        f = os.path.join(imgdir, f'penetration_{cat}.png')
        render_spot(worst[2], md.I, tris, f, f'{cat}: худшее место ({worst[1]}, {worst[0]} пар)')
        lines += ['', f'Худшее место: поза «{worst[1]}», {worst[0]} пар — `{os.path.basename(f)}`', '', f'![]({os.path.basename(f)})']
    lines += ['', f'Покой: **{total_rest}** пересечений.', '',
              'Позы: «складка скина» — линейный скин (LBS) сминает сетку у плеча/локтя/колена (подмышка в руках вверх, сгиб в присяде); '
              'без корректирующих ключей это неизбежно в любой статичной сетке. «Контакт конечностей» — рука касается лица/тела/другой руки '
              '(закрыть уши, скрестить руки, обнять): поза так задумана; в рантайме кисть останавливают коллайдеры `public/models/<cat>_colliders.json`. '
              '«Прочие» — всё остальное (одежда сквозь тело, мех/пряди сквозь одежду): в позах должно быть 0 или единицы на стыках.']
    open(out, 'w').write('\n'.join(lines) + '\n')


if __name__ == '__main__':
    main()

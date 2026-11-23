#!/usr/bin/env python3
"""Пачка и хвост Блёстки в позах: пары треугольников «фатин ↔ тело» (без хвоста; ноги отдельно), «фатин ↔ фатин» (ярусы
режут друг друга), «хвост ↔ тело/фатин». Скин — LBS как в three.js, кадры клипов anims_v1 (корень на месте).

  node scripts/models/decompress_glb.mjs public/models/anims_v1.glb /tmp/anims_raw.glb
  python3 scripts/models/tutu_poses.py model.glb /tmp/anims_raw.glb [out.md] [--label X]

Клипы: сидя (sit), сальто (flip), лёжа/сон (sleep_loop), падение (fall), танцы (dance_01…06; dance_03 — танец Блёстки),
обнять, приветствие — по 3 кадра (0.3, 0.6, 0.9 длительности).
"""
import sys
import numpy as np
from glb_io import Glb
from mesh_parts import weld
from penetration import Rig, sample_clip, lbs, tri_pairs_intersect

CLIPS = ['idle', 'sit', 'flip', 'sleep_loop', 'fall', 'dance_01', 'dance_02', 'dance_03', 'dance_04', 'dance_05', 'dance_06',
         'hug', 'cheer', 'jump', 'idle_glitter_mirror']
FR = (0.3, 0.6, 0.9)


def prim_of(g, name):
    j = g.j
    for n in j['nodes']:
        if n.get('name') == name and 'mesh' in n:
            return j['meshes'][n['mesh']]['primitives'][0]
    return None


def load(g, pr):
    P = g.acc(pr['attributes']['POSITION']).astype(np.float64)
    J = g.acc(pr['attributes']['JOINTS_0']).astype(np.int64)
    W = g.acc(pr['attributes']['WEIGHTS_0']).astype(np.float64)
    W /= 255.0 if W.max() > 1.5 else 1.0
    W /= np.maximum(W.sum(1, keepdims=True), 1e-9)
    I = g.acc(pr['indices']).reshape(-1, 3).astype(np.int64)
    return P, J, W, I


def main():
    path, anims = sys.argv[1:3]
    out = sys.argv[3] if len(sys.argv) > 3 and not sys.argv[3].startswith('--') else None
    g = Glb(path); ga = Glb(anims)
    rig = Rig(g)
    j = g.j
    jn = [j['nodes'][k]['name'].replace('mixamorig:', '') for k in j['skins'][0]['joints']]
    bi, b = g.main_mesh()
    P, J, W, I = load(g, b)
    tailw = (W * np.array([n.startswith('Tail') for n in jn])[J]).sum(1)
    legw = (W * np.array([('Leg' in n or 'Foot' in n or 'Toe' in n) for n in jn])[J]).sum(1)
    armw = (W * np.array([('Arm' in n or 'Hand' in n) for n in jn])[J]).sum(1)
    tt = (tailw[I] > 0.5).any(1)
    It, Ib = I[tt], I[~tt]
    lt = (legw[Ib] > 0.5).any(1)
    at = (armw[Ib] > 0.5).any(1)
    S = load(g, prim_of(g, 'Skirt_Glitter'))
    TW = weld(S[0])[S[3]]
    adj = lambda a, b_: (TW[a][:, :, None] == TW[b_][:, None, :]).any((1, 2))
    rows = []
    tot = np.zeros(5, int)
    for clip in CLIPS:
        for f in FR:
            over = sample_clip(ga, clip, f, rig)
            if over is None:
                continue
            M = rig.skin_mats(over)
            V = lbs(M, P, J, W)
            Vs = lbs(M, S[0], S[1], S[2])
            pb = tri_pairs_intersect(Vs, S[3], V, Ib)
            nleg = int(lt[pb[:, 1]].sum()) if len(pb) else 0
            narm = int(at[pb[:, 1]].sum()) if len(pb) else 0
            ps = tri_pairs_intersect(Vs, S[3], Vs, S[3], adj)
            ps = ps[ps[:, 0] < ps[:, 1]] if len(ps) else ps
            ptl = tri_pairs_intersect(V, It, Vs, S[3])
            # хвост ↔ тело (без стебля: треугольники тела у основания хвоста — смежны)
            ptb = tri_pairs_intersect(V, It, V, Ib)
            r = (len(pb), nleg, narm, len(ps), len(ptl), len(ptb))
            tot += np.array([len(pb), nleg, len(ps), len(ptl), len(ptb)])
            rows.append((f'{clip} @{f}', *r))
            print(f'{clip:22s} @{f}: фатин↔тело {len(pb):4d} (ноги {nleg:4d}, руки {narm:4d}), ярусы {len(ps):4d}, хвост↔фатин {len(ptl):3d}, хвост↔тело {len(ptb):3d}')
    print(f'ИТОГО: фатин↔тело {tot[0]} (ноги {tot[1]}), ярусы {tot[2]}, хвост↔фатин {tot[3]}, хвост↔тело {tot[4]}')
    if out:
        lab = sys.argv[sys.argv.index('--label') + 1] if '--label' in sys.argv else path
        L = [f'### {lab}', '', '| кадр | фатин↔тело | из них ноги | руки | ярус↔ярус | хвост↔фатин | хвост↔тело |', '|---|---|---|---|---|---|---|']
        L += [f'| {r[0]} | {r[1]} | {r[2]} | {r[3]} | {r[4]} | {r[5]} | {r[6]} |' for r in rows]
        L += [f'| **итого** | {tot[0]} | {tot[1]} | | {tot[2]} | {tot[3]} | {tot[4]} |', '']
        open(out, 'a').write('\n'.join(L) + '\n')


if __name__ == '__main__':
    main()

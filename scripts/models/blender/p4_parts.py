"""Блёстка p4: хвост и уши по частям Tripo (у модели «по частям» они — отдельные сетки: find_parts.py ищет их по
форме на сплошной сетке Хулигана/Добряка, здесь берём часть целиком) → /tmp/<n>_parts.npz для rig_cat.py.

    python3 scripts/models/blender/p4_parts.py glitter4 [tail_part=tripo_part_18] [ears=tripo_part_5,tripo_part_6]
Вход — /tmp/<n>.npz от dump.py (координаты Blender: x, y — назад, z — вверх).
"""
import sys
import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import dijkstra

n = sys.argv[1]
tail_name = sys.argv[2] if len(sys.argv) > 2 else 'tripo_part_18'
ear_names = (sys.argv[3] if len(sys.argv) > 3 else 'tripo_part_5,tripo_part_6').split(',')
d = np.load(f'/tmp/{n}.npz')
P, E, vm = d['P'], d['E'], d['vm']
mats = [m.split('_material')[0] for m in d['mats']]
bn = list(d['bn']); bp = d['bp']
B = lambda k: bp[bn.index('mixamorig:' + k)]
hips, head = B('Hips'), B('Head')
N = len(P)
L = np.linalg.norm(P[E[:, 0]] - P[E[:, 1]], axis=1)
key = np.round(P / 1e-5).astype(np.int64); _, inv = np.unique(key, axis=0, return_inverse=True); inv = inv.ravel()
o = np.argsort(inv); same = inv[o][1:] == inv[o][:-1]; SA, SB = o[:-1][same], o[1:][same]
EA = np.r_[E[:, 0], SA]; EB = np.r_[E[:, 1], SB]; LL = np.r_[L, np.full(len(SA), 1e-9)]
G = coo_matrix((np.r_[LL, LL], (np.r_[EA, EB], np.r_[EB, EA])), shape=(N, N)).tocsr()

# --- хвост: вся часть; корень — вершины, ближайшие к тазу (у спины), суставы — центры колец по геодезике
tail = np.where(vm == mats.index(tail_name))[0]
dh = np.linalg.norm(P[tail] - hips, axis=1)
root = tail[dh <= np.percentile(dh, 4)]
g = dijkstra(G, indices=root, min_only=True)
gt = g[tail]; gt[~np.isfinite(gt)] = gt[np.isfinite(gt)].max()
qs = np.linspace(0, gt.max(), 5)  # равные отрезки длины (у части Tripo вершины гуще к кончику)
joints = []
for q in qs:
    w = np.abs(gt - q) < max(0.01, (qs[-1] - qs[0]) * 0.06)
    joints.append(P[tail[w]].mean(0))
joints[0] = P[tail[gt < qs[0] + 0.012]].mean(0)
joints[-1] = P[tail[np.argmax(gt)]]
print(n, 'tail', tail_name, 'n', len(tail), 'len', round(float(qs[-1]), 3), 'joints', np.round(joints, 3).tolist())

ears, ej = {}, {}
for side, sg in [('Left', 1), ('Right', -1)]:
    cand = [k for k in ear_names if sg * (P[vm == mats.index(k), 0].mean() - head[0]) > 0]
    e = np.where(vm == mats.index(cand[0]))[0]
    tip = P[e[np.argmax(P[e, 2])]]
    # основание — нижняя треть уха по высоте
    z = P[e, 2]; base = P[e[z < np.percentile(z, 20)]].mean(0)
    ears[side] = e; ej[side] = [base, tip]
    print(side, 'ear', cand[0], 'n', len(e), 'base', base.round(3), 'tip', tip.round(3))
np.savez(f'/tmp/{n}_parts.npz', tail=tail, tailg=gt, tailj=np.array(joints), earL=ears['Left'], earR=ears['Right'],
         earLj=np.array(ej['Left']), earRj=np.array(ej['Right']))

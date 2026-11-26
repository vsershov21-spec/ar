"""Блёстка v5, мех-оболочки ниже головы (как body_detail.fur_shell у Хулигана/Добряка/Блёстки p1): BD_FurShell на
буферах тела + _FURLEN; голову, щёки и пряди-карточки силуэта (BD_FurCards) дальше делает общий fur_volume.py glitter
(точки лица — asset.extras.glitterV5.marks). Вид Tripo не меняется: оболочки рисуют ту же текстуру, кончики — её цвет.

    python3 scripts/models/v5/v5_fur.py face.glb fur0.glb

Маска: мех — сине-лиловые тексели тела (тот же порог цвета, что у body_detail/fur_volume) и метка «тело» mesh_parts
(не худи, не пачка, не бант/звёзды, не обувь); кисти — 0 (подушечки), стопы короче, хвост длиннее.
Длины — как у Блёстки p1 в линейке (body_detail: тело 9 мм, хвост ×1.25); плотность прядей — как у Хулигана.
"""
import sys, os
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from v5_common import Glb, body, sample  # noqa: E402
from mesh_parts import label_parts, BODY  # noqa: E402

BASE_LEN = 0.009   # тело (body_detail: glitter 0.009, hooligan 0.010)
TAIL_K = 1.25      # хвост (body_detail: glitter 1.25)
FUR_EX = {'layers': 4, 'density': 210, 'tip': [1.0, 1.0, 1.0], 'rim': 0.12, 'head': 1}


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


src, dst = sys.argv[1:3]
g = Glb(src); j = g.j
B = body(g)
P, UV, I = B['P'], B['UV'], B['I']
pr = B['pr']
mat0 = j['materials'][pr['material']]
tex = np.array(g.image(j['textures'][mat0['pbrMetallicRoughness']['baseColorTexture']['index']]['source']).convert('RGB')).astype(float)
# цвет у вершины — среднее по треугольникам вокруг (у вершины тексель бывает чертой рисунка)
nV = len(P)
cs = np.zeros((nV, 3)); kk = np.zeros(nV)
for wts in ((1 / 3, 1 / 3, 1 / 3), (0.6, 0.2, 0.2), (0.2, 0.6, 0.2), (0.2, 0.2, 0.6)):
    uv = (UV[I] * np.array(wts)[None, :, None]).sum(1)
    c = sample(tex, uv)
    for k in range(3):
        np.add.at(cs, I[:, k], c); np.add.at(kk, I[:, k], 1)
c = cs / np.maximum(kk, 1)[:, None]
r, gg, b = c[:, 0], c[:, 1], c[:, 2]
mx = c.max(1); mn = c.min(1); sat = (mx - mn) / np.maximum(mx, 1)
furc = (b > r + 8) & (b > gg + 4) & (sat < 0.5) & (mx > 60)
lab = label_parts('glitter', g, pr, P.astype(np.float32), I)
sk = j['skins'][0]; names = [j['nodes'][k]['name'].replace('mixamorig:', '') for k in sk['joints']]
Wt = B['W'].astype(float); Wt /= 255 if Wt.max() > 1.5 else 1
Jt = B['J'].astype(np.int64)


def wsum(pred):
    sel = np.array([pred(n) for n in names]); return (Wt * sel[Jt]).sum(1)


tail, hand, foot = wsum(lambda n: n.startswith('Tail')), wsum(lambda n: 'Hand' in n), wsum(lambda n: 'Foot' in n or 'Toe' in n)
fur = ((lab == BODY) & furc) | ((tail > 0.5) & (lab == BODY))
# сшитые вершины и рёбра
key = np.round(P * 1e5).astype(np.int64)
_, weld = np.unique(key, axis=0, return_inverse=True); weld = weld.ravel(); nW = weld.max() + 1
E = weld[np.r_[I[:, [0, 1]], I[:, [1, 2]], I[:, [2, 0]]]]


def to_w(v):
    a = np.zeros(nW); k = np.zeros(nW); np.add.at(a, weld, v); np.add.at(k, weld, 1); return a / np.maximum(k, 1)


def smooth(x, it):
    for _ in range(it):
        s_ = np.zeros(nW); k = np.zeros(nW)
        np.add.at(s_, E[:, 0], x[E[:, 1]]); np.add.at(k, E[:, 0], 1)
        np.add.at(s_, E[:, 1], x[E[:, 0]]); np.add.at(k, E[:, 1], 1)
        x = 0.5 * x + 0.5 * s_ / np.maximum(k, 1)
    return x


f = smooth(to_w(fur.astype(float)), 1) > 0.5
lo = f.astype(float)
for _ in range(2):  # край меха (манжеты, подол, кромка худи) → 0
    m = lo.copy(); np.minimum.at(m, E[:, 0], lo[E[:, 1]]); np.minimum.at(m, E[:, 1], lo[E[:, 0]]); lo = m
lo = smooth(lo, 3)
L = lo[weld] * (1 - smoothstep(0.1, 0.5, hand))
L = BASE_LEN * L * (1 + (TAIL_K - 1) * np.clip(tail, 0, 1)) * (1 - 0.35 * np.clip(foot, 0, 1))
L[L < 0.0012] = 0
tri = np.where((L[I] > 0.0012).all(1))[0]
fp = {'attributes': {k: v for k, v in pr['attributes'].items() if k in ('POSITION', 'NORMAL', 'TEXCOORD_0', 'JOINTS_0', 'WEIGHTS_0')},
      'indices': g.add_acc(I[tri].ravel().astype(np.uint16 if nV < 65535 else np.uint32), 5123 if nV < 65535 else 5125, 'SCALAR', 34963)}
fp['attributes']['_FURLEN'] = g.add_acc(L.astype(np.float32), 5126, 'SCALAR', 34962)
j['materials'].append({'name': 'BD_FurShell_mat', 'alphaMode': 'MASK', 'alphaCutoff': 0.5,
                       'pbrMetallicRoughness': {'baseColorFactor': [1, 1, 1, 0], 'metallicFactor': 0}})
fp['material'] = len(j['materials']) - 1
j['meshes'].append({'name': 'BD_FurShell', 'primitives': [fp]})
j['nodes'].append({'name': 'BD_FurShell', 'mesh': len(j['meshes']) - 1, 'skin': 0, 'extras': {'fur': dict(FUR_EX)}})
arm = next(i for i, n in enumerate(j['nodes']) if n.get('name') == 'Armature')
j['nodes'][arm]['children'].append(len(j['nodes']) - 1)
size = g.save(dst)
print(f'мех тела: {len(tri)} треуг., длина ≤ {L.max() * 1000:.1f} мм → {dst} ({size / 1e6:.2f} МБ)')

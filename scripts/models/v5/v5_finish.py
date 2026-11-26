"""Блёстка v5, последняя стадия: текстуры Tripo 4K → 2048² (сборка model-opt всё равно ужимает до 1024²/2048² KTX2;
исходник в public легче), по желанию — мех-оболочки для сравнения (--fur; по умолчанию без меха — как у Tripo).

    python3 scripts/models/v5/v5_finish.py face.glb out.glb [--fur]

--fur: BD_FurShell на буферах тела + _FURLEN (короткий плюш как у Блёстки p4: голова ≈ 2.3 мм, тело 5, хвост 7) только на
меху (сине-лиловый тон текстуры), у глаз, носа, рта — 0; одежда, пачка, бант — без меха.
"""
import sys, os, io
import numpy as np
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from v5_common import Glb, body, sample  # noqa: E402

src, dst = sys.argv[1:3]
FUR = '--fur' in sys.argv
TEX = int(os.environ.get("V5_TEX", 2048))
g = Glb(src); j = g.j
B = body(g)
for ii, im in enumerate(j['images']):
    if im.get('name', '').startswith('glitter_v5_rigged'):
        pic = g.image(ii)
        if max(pic.size) > TEX:
            g.set_image(ii, pic.resize((TEX, TEX), Image.LANCZOS))
            if im['mimeType'] == 'image/jpeg':
                im.setdefault('extras', {})['requant'] = 92
if FUR:
    P, UV, I = B['P'], B['UV'], B['I']
    mat0 = j['materials'][B['pr']['material']]
    tex = np.array(g.image(j['textures'][mat0['pbrMetallicRoughness']['baseColorTexture']['index']]['source']).convert('RGB')).astype(float) / 255
    C = sample(tex, UV)
    r, gg, b = C[:, 0], C[:, 1], C[:, 2]
    fur = (b - r > 0.12) & (np.abs(gg - r) < 0.12) & (C.mean(1) > 0.3)
    sk = j['skins'][0]; names = [j['nodes'][k]['name'] for k in sk['joints']]
    Wt = B['W'].astype(float); Wt /= 255 if Wt.max() > 1.5 else 1
    def bw(pred):
        sel = np.array([pred(n) for n in names]); return (Wt * sel[B['J']]).sum(1)
    head, tail, hand = bw(lambda n: 'Head' in n or 'Ear' in n), bw(lambda n: n.startswith('Tail')), bw(lambda n: 'Hand' in n)
    L = 0.005 * fur * (1 - 0.55 * np.clip(head, 0, 1)) * (1 + 0.4 * np.clip(tail, 0, 1)) * (1 - np.clip((hand - 0.1) / 0.4, 0, 1))
    mk = j['asset']['extras']['glitterV5']['marks']
    for sd in 'LR':
        ec = (np.array(mk[f'eyeOuter{sd}']) + np.array(mk[f'eyeInner{sd}'])) / 2
        d = np.linalg.norm(P - ec, axis=1); L *= np.clip((d - 0.05) / 0.02, 0, 1)
    for key, r0, r1 in (('nose', 0.026, 0.045), ('mouth', 0.06, 0.08)):
        d = np.linalg.norm(P - np.array(mk[key]), axis=1); L *= np.clip((d - r0) / (r1 - r0), 0, 1)
    L = L.astype(np.float32)
    ftri = I[(L[I] > 0.0012).all(1)]
    pr = B['pr']
    fp = {'attributes': dict(pr['attributes']), 'indices': g.add_acc(ftri.ravel().astype(np.uint32), 5125, 'SCALAR', 34963)}
    fp['attributes']['_FURLEN'] = g.add_acc(L, 5126, 'SCALAR', 34962)
    if pr.get('targets'):
        fp['targets'] = [dict(t) for t in pr['targets']]
    j['materials'].append({'name': 'BD_FurShell_mat', 'alphaMode': 'MASK', 'alphaCutoff': 0.5,
                           'pbrMetallicRoughness': {'baseColorFactor': [1, 1, 1, 0], 'metallicFactor': 0}})
    fp['material'] = len(j['materials']) - 1
    bm = j['meshes'][B['mi']]
    fm = {'name': 'BD_FurShell', 'primitives': [fp], 'extras': dict(bm.get('extras', {})), 'weights': list(bm.get('weights', []))}
    j['meshes'].append(fm)
    j['nodes'].append({'name': 'BD_FurShell', 'mesh': len(j['meshes']) - 1, 'skin': 0,
                       'extras': {'fur': {'layers': 3, 'density': 220, 'tip': [0.97, 0.97, 0.99], 'head': 1}}})
    arm = next(i for i, n in enumerate(j['nodes']) if n.get('name') == 'Armature')
    j['nodes'][arm]['children'].append(len(j['nodes']) - 1)
    print(f'мех: {len(ftri)} треуг.')
size = g.save(dst)
print(f'→ {dst} ({size / 1e6:.2f} МБ)')

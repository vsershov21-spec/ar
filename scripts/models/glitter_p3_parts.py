"""Блёстка p3, стадия 1: GLB Tripo «по частям» (веб-студия, 4 вида, H3.1, quad ~14k, 35 мешей tripo_part_*) → одна
сетка с ролями частей и общий атлас текстур — вход для scripts/models/glitter_p3.py --parts.

    python3 scripts/models/glitter_p3_parts.py design/models/glitter_tripo_quad14k.glb /tmp/p3/parts.npz [--atlas 2048] [--sheet /tmp/p3/parts_roles.png]

Роль части — по месту и среднему цвету её текстуры (правила ниже, печатаются для проверки):
  eye (глаза с ресницами — их место займут глаза рига p1), mouth и muzzle (рот и выпуклая «морда» вокруг — рот у нас
  шейдером MouthD, накладка на поверхности головы; выпуклость его закрывала),
  brow (брови-накладки Tripo — у нас Brows p1 с морфами), junk (крошки < 40 вершин) — в сетку не идут, но дают метки
  лица (углы глаз, рот); gold (бант, звёзды) — отдельный меш, металл; tutu — пачка (alpha); tail — хвост;
  fur (голова, уши, кисти, ноги — мех оболочками); cloth (худи, рукава, манжеты, кант, карман, шнурки); nose, muzzle.
Атлас: картинки частей ×½ (голова и пачка 2048 → 1024, худи/ноги 1024 → 512, …), упаковка полками, поля 4 px
с растяжкой краёв; UV частей пересчитываются в атлас.
"""
import sys, os, json, argparse
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from glb_io import Glb  # noqa: E402

ROLES = ['fur', 'cloth', 'tutu', 'tail', 'gold', 'nose', 'muzzle', 'eye', 'mouth', 'brow', 'junk']
DROP = {'junk'}
# --face kit (по умолчанию с 24.11, третий проход): глаза, брови, рот и «морда» Tripo — прочь (по ним только метки лица),
# лицо — свои меши: глаза/веки/брови p1 под разрез Tripo + рот геометрией (face_rig.py); --face tripo — второй проход
DROP_KIT = {'junk', 'eye', 'mouth', 'brow', 'muzzle'}
# лицо Tripo (глаза с ресницами, брови, нос, рот-улыбка, морда) остаётся сеткой и текстурой Tripo: моргание и рот —
# морфами (glitter_p3.py face_morphs); глазницы под глазами закрываются вогнутой заплаткой цвета меха — «веко» при моргании


def classify(parts):
    """роль каждой части: по среднему цвету текстуры под сеткой, положению и размеру"""
    H = max(p['V'][:, 1].max() for p in parts)
    tutu = max((p for p in parts if p['V'][:, 1].max() < 0.36 * H and np.ptp(p['V'][:, 0]) > 0.3 * H), key=lambda p: len(p['F']), default=None)
    tail = min(parts, key=lambda p: p['V'][:, 2].mean())
    for p in parts:
        r, g, b = p['col']
        c, ext = p['V'].mean(0), np.ptp(p['V'], 0)
        lum = 0.3 * r + 0.59 * g + 0.11 * b
        if len(p['V']) < 40:
            role = 'junk'
        elif p is tutu:
            role = 'tutu'
        elif p is tail:
            role = 'tail'
        elif r > b + 40 and g > b + 25:
            role = 'gold'
        elif r > g + 40 and lum < 120 and c[2] > 0.08:
            role = 'mouth'
        elif lum < 95 and c[1] > 0.6 * H and c[2] > 0.08 and abs(c[0]) > 0.02:
            role = 'eye'
        elif r > g + 20 and c[2] > 0.15 and ext[0] < 0.08:
            role = 'nose'
        elif c[1] > 0.6 * H and c[2] > 0.1 and ext[1] < 0.06 and b > r + 50:
            role = 'brow'
        elif c[1] > 0.6 * H and c[2] > 0.15 and abs(c[0]) < 0.02:
            role = 'muzzle'
        elif b > r + 45 and r < 140:
            role = 'fur'
        elif c[1] > 0.85 * H:  # куски банта в тени (желто-серые) — тоже золото
            role = 'gold'
        else:
            role = 'cloth'
        p['role'] = role
    return parts


def bleed(img, UV, F):
    """острова UV наружу: тексели вне треугольников получают цвет ближайшего покрытого (иначе при уменьшении
    в атлас фон Tripo между островами просачивается полосами по швам — шов на подбородке, пятна на худи)"""
    from PIL import ImageDraw
    from scipy import ndimage as ndi
    w, h = img.size
    m = Image.new('L', (w, h), 0); d = ImageDraw.Draw(m)
    P = UV * [w, h]
    for t in F:
        d.polygon([tuple(P[k]) for k in t], fill=255, outline=255)
    cov = np.asarray(m) > 0
    if cov.all() or not cov.any():
        return img
    _, (iy, ix) = ndi.distance_transform_edt(~cov, return_indices=True)
    arr = np.asarray(img)
    return Image.fromarray(arr[iy, ix])


def boundary_loops(V, F):
    """замкнутые границы сетки (по сшитым позициям): список циклов индексов вершин (первое вхождение позиции)"""
    key = np.round(V * 1e5).astype(np.int64)
    _, w = np.unique(key, axis=0, return_inverse=True); w = w.ravel()
    rep = {}
    for i, k in enumerate(w):
        rep.setdefault(int(k), i)
    E = np.r_[F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]]
    We = w[E]
    und = np.sort(We, 1)
    u, inv, c = np.unique(und, axis=0, return_inverse=True, return_counts=True)
    bd = We[c[inv.ravel()] == 1]
    nxt = {int(a_): int(b_) for a_, b_ in bd}
    loops, seen = [], set()
    for st in list(nxt):
        if st in seen:
            continue
        loop = [st]; seen.add(st); cur = nxt[st]
        while cur != st and cur in nxt and cur not in seen:
            loop.append(cur); seen.add(cur); cur = nxt[cur]
        if cur == st and len(loop) > 4:
            loops.append([rep[k] for k in loop])
    return loops


def cap_loop(V, F, loop, bulge=0.25, rings=3):
    """заплатка дыры: кольцо копий вершин границы + rings−1 внутренних колец + центр (купол наружу);
    → вершины, треугольники, плоские координаты (0..1) для UV латки"""
    L = V[loop]
    c = L.mean(0)
    fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    near = np.linalg.norm(V[F].mean(1) - c, axis=1) < 2 * np.linalg.norm(L - c, axis=1).max()
    nrm = fn[near].sum(0); nrm /= np.linalg.norm(nrm)
    r = np.linalg.norm(L - c, axis=1).mean()
    n = len(L)
    vs = []
    for k in range(rings):
        t = k / rings  # 0 — граница, к центру
        vs.append(L * (1 - t) + c * t + nrm * r * bulge * np.sin(t * np.pi / 2))
    vs.append((c + nrm * r * bulge)[None])
    newV = np.concatenate(vs)
    T = []
    for k in range(rings - 1):
        a0, b0 = k * n, (k + 1) * n
        for i in range(n):
            i2 = (i + 1) % n
            T += [[a0 + i, a0 + i2, b0 + i2], [a0 + i, b0 + i2, b0 + i]]
    a0, cc = (rings - 1) * n, rings * n
    for i in range(n):
        T.append([a0 + i, a0 + (i + 1) % n, cc])
    T = np.array(T)
    tn = np.cross(newV[T[:, 1]] - newV[T[:, 0]], newV[T[:, 2]] - newV[T[:, 0]]).sum(0)
    if tn @ nrm < 0:
        T = T[:, [0, 2, 1]]
    e1 = np.cross(nrm, [0, 1.0, 0]); e1 /= np.linalg.norm(e1) + 1e-9; e2 = np.cross(nrm, e1)
    q = np.stack([(newV - c) @ e1, (newV - c) @ e2], 1)
    q = (q - q.min(0)) / np.maximum(np.ptp(q, 0), 1e-9)
    return newV, T, q


def pack(sizes, A):
    """полки: (w, h) → позиции (x, y) в квадрате A или None"""
    order = sorted(range(len(sizes)), key=lambda i: -sizes[i][1])
    pos = [None] * len(sizes)
    x = y = sh = 0
    for i in order:
        w, h = sizes[i]
        if x + w > A:
            x = 0; y += sh; sh = 0
        if y + h > A:
            return None
        pos[i] = (x, y); x += w; sh = max(sh, h)
    return pos


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src'); ap.add_argument('out')
    ap.add_argument('--atlas', type=int, default=2048)
    ap.add_argument('--scale', type=float, default=0.5)
    ap.add_argument('--face', choices=('kit', 'tripo'), default='kit')
    a = ap.parse_args()
    global DROP
    if a.face == 'kit':
        DROP = DROP_KIT
    g = Glb(a.src); j = g.j
    parts = []
    for n in j['nodes']:
        if 'mesh' not in n:
            continue
        pr = j['meshes'][n['mesh']]['primitives'][0]
        mat = j['materials'][pr['material']]
        ti = mat['pbrMetallicRoughness']['baseColorTexture']['index']
        img = g.image(j['textures'][ti]['source']).convert('RGB')
        V = g.acc(pr['attributes']['POSITION']).astype(np.float64)
        F = g.acc(pr['indices']).reshape(-1, 3).astype(np.int64)
        UV = g.acc(pr['attributes']['TEXCOORD_0']).astype(np.float64)
        arr = np.asarray(img).astype(np.float32)
        h, w = arr.shape[:2]
        uvc = UV[F].mean(1)
        col = arr[np.clip((uvc[:, 1] * h).astype(int), 0, h - 1), np.clip((uvc[:, 0] * w).astype(int), 0, w - 1)].mean(0)
        parts.append({'name': n['name'], 'V': V, 'F': F, 'UV': UV, 'img': img, 'col': col})
    classify(parts)
    for p in parts:
        print(f"{p['name']:14s} {p['role']:7s} верш. {len(p['V']):5d} цвет {np.round(p['col']).astype(int).tolist()} центр {np.round(p['V'].mean(0), 3).tolist()} текстура {p['img'].size[0]}")
    # метки лица — по выброшенным частям (до деформации; glitter_p3.py ведёт их тем же сплайном)
    land = {}
    for side, s in (('L', 1), ('R', -1)):
        e = [p for p in parts if p['role'] == 'eye' and s * p['V'][:, 0].mean() > 0]
        if e:
            # без ресниц и подводки: только светлые/цветные вершины (белок, радужка)
            arr = np.asarray(e[0]['img']).astype(np.float32); hh, ww = arr.shape[:2]
            uvv = e[0]['UV']
            cv_ = arr[np.clip((uvv[:, 1] * hh).astype(int), 0, hh - 1), np.clip((uvv[:, 0] * ww).astype(int), 0, ww - 1)]
            E = e[0]['V'][cv_.max(1) > 90]
            ax = s * E[:, 0]
            land[f'eyeOuter{side}'] = E[ax > np.percentile(ax, 97)].mean(0).tolist()
            land[f'eyeInner{side}'] = E[ax < np.percentile(ax, 3)].mean(0).tolist()
            land[f'eyeBottom{side}'] = E[E[:, 1] < np.percentile(E[:, 1], 3)].mean(0).tolist()
            land[f'eyeTop{side}'] = E[E[:, 1] > np.percentile(E[:, 1], 97)].mean(0).tolist()
            land[f'iris{side}'] = E.mean(0).tolist()
    m = [p for p in parts if p['role'] == 'mouth']
    if m:
        M = m[0]['V']
        M = M[M[:, 2] > np.percentile(M[:, 2], 50)]  # передняя кромка (без глубины полости)
        land['mouthL'] = M[M[:, 0] > np.percentile(M[:, 0], 98)].mean(0).tolist()
        land['mouthR'] = M[M[:, 0] < np.percentile(M[:, 0], 2)].mean(0).tolist()
        land['mouthTop'] = M[M[:, 1] >= np.percentile(M[:, 1], 97)].mean(0).tolist()
        land['mouthBottom'] = M[M[:, 1] <= np.percentile(M[:, 1], 3)].mean(0).tolist()
        land['mouthC'] = M.mean(0).tolist()
    n_ = [p for p in parts if p['role'] == 'nose']
    if n_:
        N = n_[0]['V']
        land['nose'] = N[N[:, 2] > np.percentile(N[:, 2], 95)].mean(0).tolist()
        land['noseTop'] = N[N[:, 1] > np.percentile(N[:, 1], 95)].mean(0).tolist()
    # дыры: под выброшенными частями (глаза, рот, брови) и щели сетки (подбородок) — заплатки одноцветным краем дыры.
    # Дыра, которую закрывает соседняя оставленная часть (нос, морда, бант, шея под худи), не трогается
    from scipy.spatial import cKDTree
    kept = [p for p in parts if p['role'] not in DROP]
    caps = []
    for p in kept:
        if p['role'] != 'fur' or p['V'][:, 1].mean() < 0.5:  # только голова (у кистей/манжет — запястья внутри рукава)
            continue
        others = np.concatenate([q['V'] for q in kept if q is not p])
        tq = cKDTree(others)
        for loop in boundary_loops(p['V'], p['F']):
            L = p['V'][loop]
            c = L.mean(0); r = np.linalg.norm(L - c, axis=1).max()
            if len(loop) > 60 or r > 0.075:
                continue
            d, _ = tq.query(L)
            eye = any(k in land and np.linalg.norm(c - np.array(land[k])) < 0.06 for k in ('irisL', 'irisR'))
            if np.median(d) < 0.004 and not eye:  # край прилегает к другой части — она и закрывает
                continue
            # глазница — вогнутая (у kit — за новым яблоком; край дыры = разрез глаза), щель подбородка — чуть наружу
            nv, nt, q = cap_loop(p['V'], p['F'], loop, -0.45 if eye else 0.04)
            if eye:
                sd = 'L' if c[0] > 0 else 'R'
                for k_, v_ in enumerate(L):
                    land[f'eyeRim{sd}{k_:02d}'] = v_.tolist()
            arr = np.asarray(p['img']).astype(np.float32)
            hh, ww = arr.shape[:2]
            uvl = p['UV'][loop]
            cols = arr[np.clip((uvl[:, 1] * hh).astype(int), 0, hh - 1), np.clip((uvl[:, 0] * ww).astype(int), 0, ww - 1)]
            ok = (cols[:, 2] >= cols[:, 0]) & (cols.mean(1) > 90)
            cs = cols[ok] if ok.sum() > 3 else cols
            lum = cs.mean(1)
            col = np.median(cs[lum >= np.percentile(lum, 60)], 0)  # светлая часть каймы, без губ и теней
            # UV — плоская проекция заплатки на свой блок атласа (цвет края; glitter_p3.py перекрашивает блок мехом вокруг в 3D)
            caps.append({'name': f"cap_{p['name']}_{len(caps)}", 'V': nv, 'F': nt, 'UV': 0.1 + 0.8 * q,
                         'img': Image.new('RGB', (64, 64), tuple(int(x) for x in col)), 'col': col, 'role': p['role']})
            print(f"заплатка {p['name']}: граница {len(loop)} вершин, центр {np.round(c, 3).tolist()}, цвет {np.round(col).astype(int).tolist()}")
    parts += caps
    keep = [p for p in parts if p['role'] not in DROP]
    # атлас: масштаб подбирается, пока всё не влезет (поля 4 px)
    PAD = 4
    sc = a.scale
    while True:
        sizes = [(max(16, int(p['img'].size[0] * sc)) + 2 * PAD, max(16, int(p['img'].size[1] * sc)) + 2 * PAD) for p in keep]
        pos = pack(sizes, a.atlas)
        if pos:
            break
        sc *= 0.9
    atlas = Image.new('RGB', (a.atlas, a.atlas), (128, 128, 128))
    Vs, Fs, UVs, roles, names = [], [], [], [], []
    off = 0
    for p, (x, y), (w, h) in zip(keep, pos, sizes):
        iw, ih = w - 2 * PAD, h - 2 * PAD
        im = bleed(p['img'], p['UV'], p['F']).resize((iw, ih), Image.LANCZOS)
        big = Image.new('RGB', (w, h))
        # поля: растянутые края (фильтрация на швах островов не тянет серый фон атласа)
        big.paste(im.resize((w, h), Image.NEAREST), (0, 0)); big.paste(im, (PAD, PAD))
        atlas.paste(big, (x, y))
        uv = p['UV'].copy()
        uv[:, 0] = (x + PAD + uv[:, 0] * iw) / a.atlas
        uv[:, 1] = (y + PAD + uv[:, 1] * ih) / a.atlas
        Vs.append(p['V']); Fs.append(p['F'] + off); UVs.append(uv)
        roles += [p['role']] * len(p['F']); names += [p['name']] * len(p['F'])
        off += len(p['V'])
    tex = os.path.splitext(a.out)[0] + '_atlas.png'
    atlas.save(tex)
    np.savez_compressed(a.out, V=np.concatenate(Vs).astype(np.float32), F=np.concatenate(Fs), UV=np.concatenate(UVs).astype(np.float32),
                        tex=tex, texsize=np.array(atlas.size), role=np.array(roles), part=np.array(names), land=json.dumps(land))
    print(f'атлас {a.atlas}² (×{sc:.2f}) → {tex}; частей {len(keep)} из {len(parts)}, треуг. {sum(len(p["F"]) for p in keep)}')
    print('метки лица:', ', '.join(k for k in land if not k.startswith('eyeRim')), f'+ край глазниц {sum(k.startswith("eyeRim") for k in land)} точек')


if __name__ == '__main__':
    main()

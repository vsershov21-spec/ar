#!/usr/bin/env python3
"""Форма головы по официальным рендерам СберКота (design/refs): гладкая объёмная деформация без пересборки сетки.

  python3 scripts/models/head_shape.py <hooligan|kind|glitter> in.glb out.glb [--k 1.0]

Вход — GLB после body_detail.py (до fur_volume.py). Порядок: body_detail → head_shape → fur_volume.
Поле смещений d(p) задано в долях межглазья D от точек лица (extras.marks узла Brows — те же, что
scripts/models/face_landmarks/<cat>.json после face_detail), каждая составляющая — гладкий компактный «пузырь»:
  • щёки-«баки»: голова шире ниже глаз (до подбородка), плюс выпуклость под ушами наружу-вниз;
  • череп: чуть шире и ниже (рефы — круглая широкая голова, наша — уже и выше);
  • морда: светлая «подушка» под носом вперёд и в стороны (пухлые вибриссовые подушечки);
  • нос: меньше (сжатие к центру носа);
  • глаза: разрез меньше и чуть ниже (сжатие к центру глаза), яблоко и веки масштабируются так же.
Применяется одинаково ко всему, что лежит в координатах покоя: тело (POSITION, NORMAL по якобиану), все ключи
(дельты пересчитываются как f(p+δ) − f(p) — рот, брови, щёки работают как раньше), скинованные накладки
(Blush, подушечки, металл, ткань, эмблема), дочерние к кости Head сетки (брови, усы, FaceTufts, MouthD — через
мировую матрицу), узлы глаз (центр, масштаб эллипсоида и extras A/B/C), кости ушей (сдвиг + inverseBindMatrices),
точки лица (extras.marks) и рамка рта (extras.mouth.o, W). Веса скина и имена костей не меняются.
Проверка: минимальный якобиан поля > 0 (без самопересечений) — печатается.
"""
import sys
import numpy as np
from glb_io import Glb

# доли межглазья D; k — общий множитель (--k)
PRM = {
    #            щёки  баки  череп-шир  череп-низ  морда-вперёд  подушки  нос   глаз  глаз-вниз
    'hooligan': dict(jowl=0.105, burn=0.075, crw=0.05, crh=0.07, muz=0.055, pad=0.035, nose=0.46, eye=0.19, eyed=0.03),
    'kind': dict(jowl=0.105, burn=0.075, crw=0.05, crh=0.07, muz=0.055, pad=0.035, nose=0.46, eye=0.18, eyed=0.03),
    'glitter': dict(jowl=0.10, burn=0.07, crw=0.05, crh=0.06, muz=0.05, pad=0.03, nose=0.4, eye=0.13, eyed=0.022),
}


IRIS = {'hooligan': 1.13, 'kind': 1.12, 'glitter': 1.08}


def trs(n):
    if 'matrix' in n:
        return np.array(n['matrix'], dtype=np.float64).reshape(4, 4).T
    M = np.eye(4)
    t = n.get('translation', [0, 0, 0]); q = n.get('rotation', [0, 0, 0, 1]); s = n.get('scale', [1, 1, 1])
    x, y, z, w = q
    R = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                  [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                  [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
    M[:3, :3] = R * np.array(s); M[:3, 3] = t
    return M


def world_mats(j):
    par = {}
    for i, n in enumerate(j['nodes']):
        for c in n.get('children', []):
            par[c] = i
    W = {}

    def w(i):
        if i not in W:
            m = trs(j['nodes'][i])
            W[i] = w(par[i]) @ m if i in par else m
        return W[i]
    for i in range(len(j['nodes'])):
        w(i)
    return W, par


def bump(r):
    """гладкий компактный пузырь: 1 в центре, 0 при r ≥ 1 (C¹)"""
    r = np.clip(r, 0, 1)
    return (1 - r * r) ** 2


def sstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


class Field:
    def __init__(self, marks, eyes, prm, k=1.0):
        A = lambda n: np.array(marks[n], dtype=np.float64)
        self.D = D = np.linalg.norm(A('eyeOuterL') - A('eyeOuterR'))
        nose = A('nose')
        self.nose = nose
        eyeY = (A('eyeOuterL')[1] + A('eyeOuterR')[1] + A('eyeBottomL')[1] + A('eyeBottomR')[1]) / 4 + 0.01 * D
        eyeZ = (A('eyeOuterL')[2] + A('eyeOuterR')[2]) / 2
        self.c = np.array([nose[0], eyeY, eyeZ])
        ml, mr = A('mouthL'), A('mouthR')
        mz = max((ml[2] + mr[2]) / 2, nose[2] - 0.06)
        self.mouth = np.array([(ml[0] + mr[0]) / 2, (ml[1] + mr[1]) / 2, mz])
        self.eyes = eyes  # центры яблок (мир) и радиусы
        self.p = {kk: v * k for kk, v in prm.items()}

    def _d(self, P):
        """смещение (единицы модели): составляющие 1–4 — в долях D, 5–6 — уже в единицах модели"""
        D, c, p = self.D, self.c, self.p
        u = (P - c) / D
        ax = np.abs(u[:, 0]); sx = np.sign(u[:, 0])
        d = np.zeros_like(P)
        # вся голова: ниже подбородка (воротник, наушники) и далеко в стороны — ноль
        below = sstep(-0.98, -0.72, u[:, 1])
        side = 1 - sstep(1.25, 1.6, ax)
        # 1) щёки: шире ниже глаз — растяжение по x, сильнее к бокам (лоб и морда почти на месте)
        gj = np.exp(-((u[:, 1] + 0.36) / 0.3) ** 2) * below * side
        d[:, 0] += sx * p['jowl'] * gj * sstep(0.12, 0.75, ax)
        # 2) «баки»: выпуклость под ушами — наружу и чуть вниз
        for s in (-1, 1):
            b = np.array([0.8 * s, -0.33, -0.15])
            r = np.linalg.norm((u - b) / np.array([0.36, 0.34, 0.5]), axis=1)
            w = bump(r) * below
            dirv = np.array([s, -0.35, -0.1]); dirv /= np.linalg.norm(dirv)
            d += p['burn'] * w[:, None] * dirv
        # 3) череп: шире и ниже (всё, что выше глаз, — уши, кепка, бант — опускается вместе)
        t = sstep(0.05, 0.85, u[:, 1]) * side
        d[:, 0] += p['crw'] * t * np.clip(u[:, 0], -0.9, 0.9)
        v = u[:, 1] - 0.18
        d[:, 1] -= p['crh'] * 0.5 * (v + np.sqrt(v * v + 0.02)) * side
        # 4) морда: «подушка» под носом — вперёд и чуть вниз, подушечки — в стороны
        m0 = (np.array([self.nose[0], (self.nose[1] + self.mouth[1]) / 2, self.nose[2] - 0.12 * D]) - c) / D
        r = np.linalg.norm((u - m0) / np.array([0.48, 0.3, 0.36]), axis=1)
        w = bump(r)
        d[:, 2] += p['muz'] * w
        d[:, 1] -= 0.3 * p['muz'] * w
        d[:, 0] += p['pad'] * w * np.clip((u[:, 0] - m0[0]) / 0.3, -1, 1)
        # 5) нос меньше: сжатие к центру носа
        n0 = (self.nose - c) / D
        q = u - n0
        r = np.linalg.norm(q / np.array([0.17, 0.15, 0.17]), axis=1)
        d -= p['nose'] * bump(r)[:, None] * q
        d *= D
        # 6) глаза: разрез меньше и ниже — сжатие к центру яблока (внутри 1.05 R — целиком), спад до 2.1 R
        for e, R in self.eyes:
            q = P - e
            r = np.linalg.norm(q, axis=1) / R
            w = 1 - sstep(1.05, 2.1, r)
            d -= p['eye'] * w[:, None] * q
            d[:, 1] -= p['eyed'] * D * w
        return d

    def set_guard(self, X, r0=0.006, r1=0.04):
        """одежда ниже головы (худи, капюшон, наушники, шарф): поле затухает к ней — голова не врезается в воротник"""
        from scipy.spatial import cKDTree
        self.guard = (cKDTree(X), r0, r1)

    def _mask(self, P):
        if getattr(self, 'guard', None) is None:
            return 1.0
        t, r0, r1 = self.guard
        d, _ = t.query(P, distance_upper_bound=r1 + 0.01)
        return sstep(r0, r1, np.minimum(d, r1 + 0.01))[:, None]

    def __call__(self, P):
        P = np.asarray(P, dtype=np.float64)
        one = P.ndim == 1
        P2 = P[None] if one else P
        out = P2 + self._d(P2) * self._mask(P2)
        return out[0] if one else out

    def jac(self, P, h=1e-4):
        J = np.zeros((len(P), 3, 3))
        for k in range(3):
            e = np.zeros(3); e[k] = h
            J[:, :, k] = (self(P + e) - self(P - e)) / (2 * h)
        return J


def main():
    persona, src, dst = sys.argv[1], sys.argv[2], sys.argv[3]
    kk = float(sys.argv[sys.argv.index('--k') + 1]) if '--k' in sys.argv else 1.0
    g = Glb(src)
    j = g.j
    W, par = world_mats(j)
    nm = {n.get('name'): i for i, n in enumerate(j['nodes'])}
    brows = j['nodes'][nm['Brows']]
    marks = brows['extras']['marks']
    if brows['extras'].get('headShape'):
        sys.exit('head_shape: вход уже деформирован (extras.headShape) — нужен GLB после body_detail')
    eyes = []
    for s in ('L', 'R'):
        en = j['nodes'][nm['Eye_' + s]]
        ex = en['extras']
        eyes.append((W[nm['Eye_' + s]][:3, 3].copy(), float(np.mean([ex['A'], ex['B']]))))
    F = Field(marks, eyes, PRM[persona], kk)
    D = F.D
    from mesh_parts import label_parts, HOODIE, PHONES, SCARF
    bi_, b_ = g.main_mesh()
    P_ = g.acc(b_['attributes']['POSITION']).astype(np.float64)
    lab_ = label_parts(persona, g, b_, P_, g.acc(b_['indices']).reshape(-1, 3).astype(np.int64))
    gx = P_[np.isin(lab_, [HOODIE, PHONES, SCARF]) & (P_[:, 1] > F.c[1] - 1.4 * D)]
    if len(gx):
        F.set_guard(gx)

    # проверка: якобиан на облаке точек головы
    bi, body = g.main_mesh()
    P = g.acc(body['attributes']['POSITION']).astype(np.float64)
    near = np.linalg.norm((P - F.c) / D, axis=1) < 2.2
    Jd = np.linalg.det(F.jac(P[near]))
    disp = np.linalg.norm(F(P[near]) - P[near], axis=1)
    print(f'{persona}: D={D:.3f}, вершин в зоне {near.sum()}, якобиан min {Jd.min():.3f} max {Jd.max():.3f}, смещение ≤ {disp.max() / D:.3f} D')
    pm = P[near][Jd.argmin()]
    print(f'  min якобиана в {np.round((pm - F.c) / D, 2)} D от центра глаз')
    assert Jd.min() > 0.12, 'поле складывается — уменьшите --k'

    done = set()

    def deform_positions(ai, M=None):
        """accessor позиций (в координатах узла с матрицей M) → деформировать на месте"""
        X = g.acc(ai).astype(np.float64)
        Xw = X if M is None else X @ M[:3, :3].T + M[:3, 3]
        Yw = F(Xw)
        Y = Yw if M is None else (Yw - M[:3, 3]) @ np.linalg.inv(M[:3, :3]).T
        return X, Xw, Y

    def do_prim(pr, M=None):
        a = pr['attributes']
        pa = a['POSITION']
        if pa in done:
            return
        done.add(pa)
        X, Xw, Y = deform_positions(pa, M)
        # ключи: дельта в координатах узла → f(p+δ) − f(p)
        for t in pr.get('targets', []):
            ta = t['POSITION']
            if ta in done:
                continue
            done.add(ta)
            dl = g.acc(ta).astype(np.float64)
            nz = np.abs(dl).max(1) > 0
            out = np.zeros_like(dl)
            if nz.any():
                Xd = X[nz] + dl[nz]
                Xdw = Xd if M is None else Xd @ M[:3, :3].T + M[:3, 3]
                Ydw = F(Xdw)
                Yd = Ydw if M is None else (Ydw - M[:3, 3]) @ np.linalg.inv(M[:3, :3]).T
                out[nz] = Yd - Y[nz]
            write(ta, out)
        if 'NORMAL' in a and a['NORMAL'] not in done:
            done.add(a['NORMAL'])
            Nn = g.acc(a['NORMAL']).astype(np.float64)
            moved = np.linalg.norm(Y - X, axis=1) > 1e-7
            if moved.any():
                Jm = F.jac(Xw[moved])
                R = np.eye(3) if M is None else M[:3, :3] / np.cbrt(abs(np.linalg.det(M[:3, :3])))
                nw = Nn[moved] @ R.T
                nw = np.einsum('nij,nj->ni', np.linalg.inv(Jm).transpose(0, 2, 1), nw)
                nw /= np.maximum(np.linalg.norm(nw, axis=1, keepdims=True), 1e-12)
                Nn[moved] = nw @ R
            write(a['NORMAL'], Nn)
        write(pa, Y)

    def write(ai, arr):
        acc = j['accessors'][ai]
        if 'sparse' in acc or 'bufferView' not in acc:
            # sparse остаётся sparse (только сдвинутые вершины): иначе ключи раздувают файл на мегабайты
            arr = arr.astype(np.float32)
            nz = np.where(np.abs(arr).max(1) > 1e-7)[0] if arr.ndim > 1 else np.where(np.abs(arr) > 1e-7)[0]
            new = {'componentType': 5126, 'count': int(acc['count']), 'type': acc['type']}
            if acc['type'] == 'VEC3':
                new['min'] = arr.min(0).tolist(); new['max'] = arr.max(0).tolist()
            if len(nz):
                ii = g.add_acc(nz.astype(np.uint32), 5125, 'SCALAR'); vv = g.add_acc(arr[nz], 5126, acc['type'])
                new['sparse'] = {'count': int(len(nz)), 'indices': {'bufferView': j['accessors'][ii]['bufferView'], 'componentType': 5125},
                                 'values': {'bufferView': j['accessors'][vv]['bufferView']}}
                j['accessors'].pop(); j['accessors'].pop()
            for k_ in ('bufferView',):
                pass
            if 'sparse' in acc:
                for bv in (acc['sparse']['indices']['bufferView'], acc['sparse']['values']['bufferView']):
                    g.extra[bv] = b''
            j['accessors'][ai] = new
            return
        g.set_acc(ai, arr.astype(np.float32))

    skip_mesh = set()
    for s in ('L', 'R'):  # глаза — узлами (масштаб эллипсоида), не вершинами
        for k in ('EyeBall_', 'LidUp_', 'LidLo_', 'Tear_'):
            n = j['nodes'][nm[k + s]]
            if 'mesh' in n:
                skip_mesh.add(n['mesh'])
    for i, n in enumerate(j['nodes']):
        if 'mesh' not in n or n['mesh'] in skip_mesh:
            continue
        M = None if 'skin' in n else W[i]
        for pr in j['meshes'][n['mesh']]['primitives']:
            do_prim(pr, M)

    # глаза: центр по полю, эллипсоид — масштаб по локальному якобиану поля (кубический корень определителя)
    Hn = nm['mixamorig:Head']
    for s in ('L', 'R'):
        ei = nm['Eye_' + s]
        e0 = W[ei][:3, 3]
        e1 = F(e0)
        loc = np.linalg.inv(W[par[ei]]) @ np.r_[e1, 1]
        j['nodes'][ei]['translation'] = loc[:3].tolist()
        ks = float(np.cbrt(np.linalg.det(F.jac(e0[None])[0])))
        ex = j['nodes'][ei]['extras']
        for kx in ('A', 'B', 'C'):
            ex[kx] = ex[kx] * ks
        # радужка крупнее (на рефах белка почти не видно — не «кукольный» глаз)
        ex['irisUV'] = [round(v * IRIS[persona], 5) for v in ex['irisUV']]
        sn = j['nodes'][nm['EyeS_' + s]]
        sn['scale'] = [v * ks for v in sn['scale']]
        tn = j['nodes'][nm['Tear_' + s]]
        if 'translation' in tn:
            tn['translation'] = [v * ks for v in tn['translation']]
        print(f'  глаз {s}: сдвиг {np.round((e1 - e0) / D, 3)} D, масштаб {ks:.3f}')

    # кости ушей: сдвиг вместе с ушами (поворот тот же), inverseBindMatrices по новой позе
    sk = j['skins'][j['nodes'][next(i for i, n in enumerate(j['nodes']) if n.get('mesh') == bi)]['skin']]
    ibm = g.acc(sk['inverseBindMatrices']).reshape(-1, 4, 4).transpose(0, 2, 1).astype(np.float64)
    for k, jn in enumerate(sk['joints']):
        name = j['nodes'][jn].get('name', '')
        if 'Ear' not in name:
            continue
        p0 = W[jn][:3, 3]
        p1 = F(p0)
        Wn = W[jn].copy(); Wn[:3, 3] = p1
        loc = np.linalg.inv(W[par[jn]]) @ np.r_[p1, 1]
        j['nodes'][jn]['translation'] = loc[:3].tolist()
        ibm[k] = np.linalg.inv(Wn)
        print(f'  кость {name}: сдвиг {np.round((p1 - p0) / D, 3)} D')
    g.set_acc(sk['inverseBindMatrices'], ibm.transpose(0, 2, 1).reshape(-1, 16).astype(np.float32))

    # точки лица и рамка рта
    mk = dict(marks)
    for key, v in marks.items():
        if isinstance(v, list) and len(v) == 3:
            mk[key] = [round(float(x), 5) for x in F(np.array(v))]
    for s in ('L', 'R'):
        o, i_ = np.array(marks['eyeOuter' + s]), np.array(marks['eyeInner' + s])
        top = np.array([(o[0] + i_[0]) / 2, marks['eyeTop' + s], (o[2] + i_[2]) / 2])
        mk['eyeTop' + s] = float(F(top)[1])
    nl = np.array(marks['nose']) + [marks['noseHalfW'], 0, 0]; nr = np.array(marks['nose']) - [marks['noseHalfW'], 0, 0]
    mk['noseHalfW'] = float(np.linalg.norm(F(nl) - F(nr)) / 2)
    brows['extras']['marks'] = mk
    brows['extras']['headShape'] = {'k': kk, **{k_: round(v, 4) for k_, v in F.p.items()}}
    mi = nm.get('MouthD')
    if mi is not None and 'mouth' in j['nodes'][mi].get('extras', {}):
        mo = j['nodes'][mi]['extras']['mouth']
        M = W[mi]
        ow = M[:3, :3] @ np.array(mo['o']) + M[:3, 3]
        ow1 = F(ow)
        mo['o'] = [round(float(x), 6) for x in (np.linalg.inv(M[:3, :3]) @ (ow1 - M[:3, 3]))]
        ml, mr = np.array(marks['mouthL']), np.array(marks['mouthR'])
        mo['W'] = float(mo['W'] * np.linalg.norm(F(ml) - F(mr)) / np.linalg.norm(ml - mr))
    print(f'  нос: полуширина {marks["noseHalfW"]:.4f} → {mk["noseHalfW"]:.4f}; рот W ×{np.linalg.norm(F(np.array(marks["mouthL"])) - F(np.array(marks["mouthR"]))) / np.linalg.norm(np.array(marks["mouthL"]) - np.array(marks["mouthR"])):.3f}')
    g.save(dst)


if __name__ == '__main__':
    main()

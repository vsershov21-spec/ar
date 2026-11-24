"""Блёстка p3: сетка генерации по развороту продакта 23.11 на скелет, лицо-накладки и мех glitter_p1.

Основной путь (24.11) — модель Tripo «по частям» из веб-студии (4 вида, H3.1, quad ~14k, 35 мешей):

    python3 scripts/models/glitter_p3_parts.py design/models/glitter_tripo_quad14k.glb /tmp/p3/parts.npz
    python3 scripts/models/glitter_p3.py /tmp/p3/parts.npz public/models/v2/glitter_p1.glb public/models/v2/glitter_p3.glb
    python3 scripts/models/colliders.py glitter public/models/v2/glitter_p3.glb public/models/v2/glitter_p3_colliders.json

(одна сплошная сетка, например Meshy, — через blender/p3_prep.py: тогда роли частей, глаза и рот ищутся по цвету
текстуры, открытый рот «заливается», нарисованные глаза закрашиваются — ветки ниже, по умолчанию не нужны).

Шаблон — glitter_p1: скелет (имена, иерархия и поза покоя — байт в байт: клипы, footPin, aliveIdle играют как есть),
накладки лица (EyeBall/LidUp/LidLo/Tear в узлах Eye_*, Brows с разметкой marks, рот шейдером MouthD), материалы рантайма.
Узел тела p1 получает новую сетку (атлас частей), BD_FurShell строится заново; Blush, подушечки, пряди, звёзды p1,
усы, пучки и фатин p1 — убираются.

1. Поворот и масштаб: вверх +Y, линия глаз — вдоль X, пол y = 0, рост — как у p1.
2. Метки тела (одни правила на новой сетке и на теле p1: кончики кистей, сечения рук и ног, стопы) → подобие с
   масштабом по осям, потом thin-plate сплайн с опорами на голове и корпусе: руки и ноги встают на кости p1, голова,
   худи, пачка и хвост — форма Tripo.
3. Веса — с ближайшей точки поверхности p1; пачка — с фатина p1 (мягко: таз/бёдра); хвост — по цепочке Tail1..4;
   бант и звёзды — жёстко к голове.
4. Морфы тела p1 (13 ключей: ими рот шейдером двигает кожу) — переносом смещений с ближайшей точки морды.
5. Лицо: глаза p1 (яблоко, веки, слеза) сдвигаются и масштабируются под разрез глаз Tripo (углы, верх, низ),
   глубина — как выступали у p1; брови — тем же переносом; MouthD — подобием по уголкам рта; обе накладки
   проецируются на новую поверхность; разметка marks — новая. Нарисованные губы и края глазниц — мехом вокруг (в 3D).
6. Части: Skirt_P3 — пачка (alpha BLEND, свои буферы), Bow_Glitter — бант, звёзды, кант пояса (металл), тело — всё
   остальное одним материалом атласа. Мех оболочек — на меховых частях, у глаз и рта — 0.
Пометка asset.extras.glitterP3 — повтор по p3 отказывается.
"""
import sys, os, json, argparse, math
import numpy as np
from PIL import Image, ImageFilter
from scipy.spatial import cKDTree
from scipy.spatial.transform import Rotation as Rot

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from glb_io import Glb, raster_uv  # noqa: E402

TAG = 'glitterP3'
DROP = ('Blush', 'BD_Pads', 'BD_FurCards', 'BD_Metal_Stars', 'Whiskers', 'FaceTufts', 'Skirt_Glitter')


# ───────────────────────── общее ─────────────────────────
def node_mat(n):
    if 'matrix' in n:
        return np.array(n['matrix']).reshape(4, 4).T
    T = np.eye(4); T[:3, 3] = n.get('translation', [0, 0, 0])
    R = np.eye(4); R[:3, :3] = Rot.from_quat(n.get('rotation', [0, 0, 0, 1])).as_matrix()
    return T @ R @ np.diag(list(n.get('scale', [1, 1, 1])) + [1])


class World:
    def __init__(self, j):
        self.j = j; self.par = {}; self.W = {}
        for i, n in enumerate(j['nodes']):
            for c in n.get('children', []):
                self.par[c] = i
        self.idx = {n.get('name'): i for i, n in enumerate(j['nodes'])}

    def m(self, i):
        if isinstance(i, str):
            i = self.idx[i]
        if i not in self.W:
            m = node_mat(self.j['nodes'][i])
            self.W[i] = self.m(self.par[i]) @ m if i in self.par else m
        return self.W[i]

    def p(self, i):
        return self.m(i)[:3, 3].copy()


def vnormals(V, F):
    fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    N = np.zeros_like(V)
    for k in range(3):
        np.add.at(N, F[:, k], fn)
    return N / np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-12)


def vnormals_welded(V, F):
    """нормали по сшитым позициям: на швах UV (одна точка — несколько вершин) нормаль общая, без светлых линий"""
    w = weld_map(V)
    fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    N = np.zeros((w.max() + 1, 3))
    for k in range(3):
        np.add.at(N, w[F[:, k]], fn)
    N = N[w]
    return N / np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-12)


def weld_map(V, tol=1e-5):
    key = np.round(V / tol).astype(np.int64)
    _, w = np.unique(key, axis=0, return_inverse=True)
    return w.ravel()


def edges_of(F):
    return np.r_[F[:, [0, 1]], F[:, [1, 2]], F[:, [2, 0]]]


def smooth_field(x, E, n, it, k=0.5, fixed=None):
    """лапласово сглаживание значения на вершинах (x: (n,) или (n,c))"""
    x = x.astype(np.float64).copy()
    for _ in range(it):
        s = np.zeros_like(x); c = np.zeros(n)
        np.add.at(s, E[:, 0], x[E[:, 1]]); np.add.at(c, E[:, 0], 1)
        np.add.at(s, E[:, 1], x[E[:, 0]]); np.add.at(c, E[:, 1], 1)
        avg = s / np.maximum(c, 1).reshape((-1,) + (1,) * (x.ndim - 1))
        nx = (1 - k) * x + k * avg
        if fixed is not None:
            nx[fixed] = x[fixed]
        x = nx
    return x


def surface_samples(V, F, per_area=4e5, attrs=()):
    """плотная выборка поверхности: точки, id треугольника, барицентры (для переноса атрибутов)"""
    A = 0.5 * np.linalg.norm(np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]]), axis=1)
    cnt = np.maximum(1, np.round(A * per_area)).astype(int)
    tid = np.repeat(np.arange(len(F)), cnt)
    rng = np.random.default_rng(7)
    r1 = rng.random(len(tid)); r2 = rng.random(len(tid))
    s = np.sqrt(r1)
    bc = np.stack([1 - s, s * (1 - r2), s * r2], 1)
    # плюс сами вершины треугольника (точные значения у вершин)
    tid = np.r_[tid, np.arange(len(F)), np.arange(len(F)), np.arange(len(F))]
    e = np.eye(3)
    bc = np.r_[bc, np.repeat(e[[0]], len(F), 0), np.repeat(e[[1]], len(F), 0), np.repeat(e[[2]], len(F), 0)]
    P = (V[F[tid]] * bc[:, :, None]).sum(1)
    return P, tid, bc


# ───────────────────────── цвет ─────────────────────────
def color_classes(c):
    """c: (...,3) 0..255 → маски классов по цвету текстуры Tripo (тон рефа)"""
    c = c.astype(np.float32)
    r, g, b = c[..., 0], c[..., 1], c[..., 2]
    mx = c.max(-1); mn = c.min(-1); sat = (mx - mn) / np.maximum(mx, 1); lum = 0.3 * r + 0.59 * g + 0.11 * b
    out = {}
    out['iris'] = (g > r + 25) & (g > b + 5) & (g > 50) & (lum < 170)
    out['dark'] = lum < 55
    out['white'] = (lum > 215) & (sat < 0.12)
    out['pink'] = (r > g + 35) & (r > b + 10) & (lum > 90)
    out['mouth'] = (r > g + 40) & (r > b + 20) & (lum < 120)
    out['gold'] = (r > b + 45) & (g > b + 25) & (mx > 120)
    out['mint'] = (g > r + 18) & (b > r + 5) & (lum > 120) & ~out['iris']
    out['lavender'] = (b > g + 18) & (r > g + 8) & (lum > 140)
    out['fur'] = (b >= r + 4) & (b >= g - 2) & (sat < 0.34) & (lum > 60) & (lum < 215) & ~out['lavender'] & ~out['mint']
    out['purple'] = (b > g + 25) & (r > g + 15) & (lum <= 140) & (lum > 40)
    return out


def sample_tex(img, UV):
    h, w = img.shape[:2]
    x = np.clip(UV[:, 0] * w - 0.5, 0, w - 1); y = np.clip(UV[:, 1] * h - 0.5, 0, h - 1)
    x0 = np.floor(x).astype(int); y0 = np.floor(y).astype(int); x1 = np.minimum(x0 + 1, w - 1); y1 = np.minimum(y0 + 1, h - 1)
    fx = (x - x0)[:, None]; fy = (y - y0)[:, None]
    return (img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x1] * fx * (1 - fy) + img[y1, x0] * (1 - fx) * fy + img[y1, x1] * fx * fy)


# ───────────────────────── метки ─────────────────────────
def body_landmarks(V, H, tag):
    """геометрические метки, одинаковые для обеих сеток (поза A/T, вперёд +Z, вверх +Y, пол 0, центр x≈0)"""
    L = {}
    mid = (V[:, 1] > 0.22 * H) & (V[:, 1] < 0.62 * H)
    # полуширина корпуса — по высоте груди, медиана |x| у центральной полосы спереди/сзади
    chest = (V[:, 1] > 0.42 * H) & (V[:, 1] < 0.5 * H) & (np.abs(V[:, 2] - np.median(V[mid, 2])) < 0.05 * H)
    xt = np.percentile(np.abs(V[chest, 0]), 70) if chest.any() else 0.15 * H
    for s, side in ((1, 'L'), (-1, 'R')):
        arm = mid & (s * V[:, 0] > xt)
        if arm.sum() < 20:
            continue
        A = V[arm]
        tipx = (s * A[:, 0]).max()
        L[f'hand{side}'] = A[s * A[:, 0] > tipx - 0.02 * H].mean(0)
        for f in (0.3, 0.55, 0.8):
            x = xt + f * (tipx - xt)
            sl = A[np.abs(s * A[:, 0] - x) < 0.012 * H]
            if len(sl) > 5:
                L[f'arm{side}{int(f * 100)}'] = sl.mean(0)
        legs = (s * V[:, 0] > 0.005 * H)
        bot = legs & (V[:, 1] < 0.035 * H)
        if bot.sum() > 5:
            B = V[bot]
            L[f'foot{side}'] = B.mean(0)
            L[f'toe{side}'] = B[B[:, 2] > np.percentile(B[:, 2], 95)].mean(0)
            L[f'heel{side}'] = B[B[:, 2] < np.percentile(B[:, 2], 5)].mean(0)
        for f in (0.08, 0.14):
            sl = V[legs & (np.abs(V[:, 1] - f * H) < 0.01 * H) & (s * V[:, 0] < 0.2 * H)]
            if len(sl) > 5:
                L[f'leg{side}{int(f * 100)}'] = sl.mean(0)
    return L


def front_image(V, F, UV, img, box, S=800, density=7e6):
    """ортопроекция спереди (z-буфер по плотной выборке поверхности): цвет и глубина z на пиксель"""
    x0, x1, y0, y1 = box
    ct = V[F].mean(1)
    sub = np.nonzero((ct[:, 1] > y0 - 0.02) & (ct[:, 1] < y1 + 0.02) & (ct[:, 0] > x0 - 0.02) & (ct[:, 0] < x1 + 0.02))[0]
    P, tid, bc = surface_samples(V, F[sub], density)
    tid = sub[tid]
    m = (P[:, 1] > y0) & (P[:, 1] < y1) & (P[:, 0] > x0) & (P[:, 0] < x1)
    P, tid, bc = P[m], tid[m], bc[m]
    uv = (UV[F[tid]] * bc[:, :, None]).sum(1)
    C = sample_tex(img.astype(np.float32), uv)
    px = np.clip(((P[:, 0] - x0) / (x1 - x0) * S).astype(int), 0, S - 1)
    py = np.clip(((1 - (P[:, 1] - y0) / (y1 - y0)) * S).astype(int), 0, S - 1)
    o = np.argsort(-P[:, 2])  # ближайшая к зрителю точка пикселя — первая в порядке убывания z
    pid = (py * S + px)[o]
    _, first = np.unique(pid, return_index=True)
    sel = o[first]
    im = np.full((S, S, 3), 236, np.float32); zb = np.full((S, S), np.nan)
    im[py[sel], px[sel]] = C[sel]; zb[py[sel], px[sel]] = P[sel, 2]
    # пиксель, куда попала только задняя поверхность (передняя недовыбрана), — дырка
    from scipy import ndimage as ndi
    zmax = ndi.maximum_filter(np.nan_to_num(zb, nan=-9), size=5)
    zb[zb < zmax - 0.02] = np.nan
    # дырки выборки (пиксель без точки внутри силуэта) — из соседей
    for _ in range(4):
        hole = np.isnan(zb)
        acc = np.zeros_like(im); za = np.zeros(zb.shape); cnt = np.zeros(zb.shape)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ok = ~np.isnan(np.roll(np.roll(zb, dy, 0), dx, 1))
            acc += np.roll(np.roll(im, dy, 0), dx, 1) * ok[..., None]; za += np.nan_to_num(np.roll(np.roll(zb, dy, 0), dx, 1)) * ok; cnt += ok
        f = hole & (cnt >= 2)
        im[f] = acc[f] / cnt[f][:, None]; zb[f] = za[f] / cnt[f]
    return im, zb


def face_landmarks(V, F, UV, img, debug=None):
    """углы глаз, нос и уголки рта новой сетки по цвету текстуры — на ортопроекции лица спереди (вперёд +Z):
    глаз — связная область «белок + радужка» вокруг радужки (без ресниц и подводки), нос — верхнее розовое пятно
    между глазами, рот — розово-тёмное пятно под ним; точки возвращаются в 3D по z-буферу."""
    from scipy import ndimage as ndi
    H = V[:, 1].max()
    box = (-0.22 * H, 0.22 * H, 0.5 * H, 0.94 * H)
    S = 800
    im, zb = front_image(V, F, UV, img, box, S)
    x0, x1, y0, y1 = box
    to3 = lambda r, c: np.array([x0 + (c + 0.5) / S * (x1 - x0), y1 - (r + 0.5) / S * (y1 - y0), zb[int(r), int(c)]])
    cl = color_classes(im)
    c = im
    lum = 0.3 * c[..., 0] + 0.59 * c[..., 1] + 0.11 * c[..., 2]
    sat = (c.max(-1) - c.min(-1)) / np.maximum(c.max(-1), 1)
    white = (lum > 228) & (sat < 0.08) & ~np.isnan(zb)
    out = {}
    lab, n = ndi.label(cl['iris'])
    sizes = ndi.sum(np.ones_like(lab), lab, range(1, n + 1))
    big = np.argsort(-sizes)[:2] + 1
    for k in big:
        r, cc = ndi.center_of_mass(lab == k)
        side = 'L' if x0 + cc / S * (x1 - x0) > 0 else 'R'
        el, _ = ndi.label(ndi.binary_closing(white, iterations=2) | (lab == k))
        ir0 = np.nonzero(lab == k)
        e = el == el[ir0[0][0], ir0[1][0]]
        e = ndi.binary_fill_holes(e)
        rr, cs = np.nonzero(e)
        s = 1 if side == 'L' else -1
        xs = s * cs
        o = np.argmax(xs); i = np.argmin(xs)
        out[f'eyeOuter{side}'] = to3(rr[o], cs[o]); out[f'eyeInner{side}'] = to3(rr[i], cs[i])
        b = np.argmax(rr); t = np.argmin(rr)
        out[f'eyeBottom{side}'] = to3(rr[b], cs[b]); out[f'eyeTop{side}'] = to3(rr[t], cs[t])
        out[f'iris{side}'] = to3(r, cc)
        ir = np.nonzero(lab == k)
        out[f'irisRad{side}'] = np.array([(ir[1].max() - ir[1].min()) / 2 / S * (x1 - x0), (ir[0].max() - ir[0].min()) / 2 / S * (y1 - y0), 0])
        if debug:
            im[e] = im[e] * 0.5 + np.array([0, 255, 0]) * 0.5
    if 'irisL' in out and 'irisR' in out:
        eb = max(int((y1 - out['eyeBottomL'][1]) / (y1 - y0) * S), int((y1 - out['eyeBottomR'][1]) / (y1 - y0) * S))
        cxp = int(((out['irisL'][0] + out['irisR'][0]) / 2 - x0) / (x1 - x0) * S)
        rosy = (c[..., 0] > c[..., 1] + 15) & (c[..., 0] > c[..., 2] + 2) & (lum < 185)
        pk = (rosy | cl['mouth']) & ~white
        pk[:eb] = False
        pk[:, :cxp - int(0.12 * S)] = False; pk[:, cxp + int(0.12 * S):] = False
        pk = ndi.binary_opening(pk, iterations=2)
        pl, n = ndi.label(pk)
        comps = []
        for k in range(1, n + 1):
            rr, cs = np.nonzero(pl == k)
            if len(rr) > 80:
                comps.append((rr.min(), rr, cs))
        comps.sort(key=lambda t: t[0])
        if comps:
            _, rr, cs = comps[0]
            # кончик носа — ближайшая к зрителю точка пятна
            zz = zb[rr, cs]; t = np.nanargmax(zz)
            out['nose'] = to3(rr[t], cs[t]); out['noseTop'] = to3(rr.min(), int(np.median(cs)))
            if debug:
                im[rr, cs] = [255, 0, 255]
        if len(comps) > 1:
            _, rr, cs = max(comps[1:], key=lambda t: len(t[1]))
            o = np.argmax(cs); i = np.argmin(cs)
            out['mouthL'] = to3(rr[o], cs[o]); out['mouthR'] = to3(rr[i], cs[i])
            out['mouthTop'] = to3(rr.min(), int(np.median(cs))); out['mouthBottom'] = to3(rr.max(), int(np.median(cs)))
            out['mouthC'] = to3(int(rr.mean()), int(cs.mean()))
            if debug:
                im[rr, cs] = [255, 0, 0]
    if debug:
        Image.fromarray(np.clip(im, 0, 255).astype(np.uint8)).save(os.path.join(debug, 'face_front.png'))
    return out


def tps_fit(src, dst, reg=1e-4):
    """thin-plate сплайн R3→R3: f(x) = A x + b + Σ w_i φ(|x − s_i|), φ(r) = r"""
    n = len(src)
    K = np.linalg.norm(src[:, None] - src[None], axis=2)
    P = np.c_[np.ones(n), src]
    M = np.zeros((n + 4, n + 4)); M[:n, :n] = K + reg * np.eye(n); M[:n, n:] = P; M[n:, :n] = P.T
    rhs = np.zeros((n + 4, 3)); rhs[:n] = dst
    sol = np.linalg.solve(M, rhs)
    w, a = sol[:n], sol[n:]

    def f(x):
        out = np.empty_like(x)
        for i in range(0, len(x), 20000):
            xx = x[i:i + 20000]
            out[i:i + 20000] = np.linalg.norm(xx[:, None] - src[None], axis=2) @ w + np.c_[np.ones(len(xx)), xx] @ a
        return out
    return f


def similarity_axes(src, dst, w=None):
    """масштаб по осям + сдвиг (МНК): dst ≈ s ⊙ src + t"""
    w = np.ones(len(src)) if w is None else w
    s = np.ones(3); t = np.zeros(3)
    for k in range(3):
        A = np.c_[src[:, k], np.ones(len(src))] * w[:, None]
        sol = np.linalg.lstsq(A, dst[:, k] * w, rcond=None)[0]
        s[k], t[k] = sol
    return s, t


# ───────────────────────── p1 ─────────────────────────
def load_p1(path):
    g = Glb(path)
    j = g.j
    if TAG in j['asset'].get('extras', {}):
        sys.exit('шаблон уже p3 — нужен glitter_p1')
    wd = World(j)
    bi, b = g.main_mesh()
    A = b['attributes']
    body = dict(P=g.acc(A['POSITION']).astype(np.float64), N=g.acc(A['NORMAL']), J=g.acc(A['JOINTS_0']).astype(np.int64),
                W=g.acc(A['WEIGHTS_0']).astype(np.float64), I=g.acc(b['indices']).reshape(-1, 3).astype(np.int64), mesh=bi, prim=b)
    if 'normalized' in j['accessors'][A['WEIGHTS_0']] and body['W'].max() > 1.5:
        body['W'] /= 255.0 if body['W'].max() <= 255 else 65535.0
    body['targets'] = [{k: g.acc(v) for k, v in t.items()} for t in b.get('targets', [])]
    body['tnames'] = j['meshes'][bi].get('extras', {}).get('targetNames', [])
    skirt = None
    for n in j['nodes']:
        if n.get('name') == 'Skirt_Glitter':
            p = j['meshes'][n['mesh']]['primitives'][0]
            skirt = dict(P=g.acc(p['attributes']['POSITION']).astype(np.float64), J=g.acc(p['attributes']['JOINTS_0']).astype(np.int64),
                         W=g.acc(p['attributes']['WEIGHTS_0']).astype(np.float64), I=g.acc(p['indices']).reshape(-1, 3).astype(np.int64))
    joints = j['skins'][0]['joints']
    jname = [j['nodes'][k]['name'] for k in joints]
    marks = j['nodes'][wd.idx['Brows']]['extras']['marks']
    return g, wd, body, skirt, jname, marks


def dense_weights(J, W, nb):
    D = np.zeros((len(J), nb))
    for k in range(4):
        np.add.at(D, (np.arange(len(J)), J[:, k]), W[:, k])
    return D


def top4(D):
    J = np.argsort(-D, axis=1)[:, :4]
    W = np.take_along_axis(D, J, 1)
    W[W < 0.01] = 0
    W /= np.maximum(W.sum(1, keepdims=True), 1e-9)
    return J.astype(np.uint16), W.astype(np.float32)


# ───────────────────────── закраска лица ─────────────────────────
def inpaint(img, mask, it=400):
    """диффузионная закраска маски цветом соседей (без OpenCV): пирамида — грубо, потом уточнение"""
    out = img.astype(np.float32).copy()
    m = mask.copy()
    known = ~m
    # заполнение от краёв внутрь: среднее известных соседей, слой за слоем
    for _ in range(it):
        if not m.any():
            break
        acc = np.zeros_like(out); cnt = np.zeros(m.shape, np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, -1), (1, -1), (-1, 1)):
            k = np.roll(np.roll(known, dy, 0), dx, 1)
            v = np.roll(np.roll(out, dy, 0), dx, 1)
            acc += v * k[..., None]; cnt += k
        new = m & (cnt > 0)
        out[new] = acc[new] / cnt[new][:, None]
        known = known | new; m = m & ~new
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('npz'); ap.add_argument('p1'); ap.add_argument('out')
    ap.add_argument('--debug'); ap.add_argument('--tex', type=int, default=2048)
    ap.add_argument('--tps-reg', type=float, default=2e-4)
    ap.add_argument('--no-face', action='store_true', help='без меток лица (проверка на синтетике)')
    a = ap.parse_args()
    if a.debug:
        os.makedirs(a.debug, exist_ok=True)
    d = np.load(a.npz, allow_pickle=True)
    V = d['V'].astype(np.float64); UV = d['UV'].astype(np.float64); F = d['F'].astype(np.int64)
    img = np.asarray(Image.open(str(d['tex'])).convert('RGB'))
    # режим частей (glitter_p3_parts.py): роль треугольника, метки лица — по выброшенным частям (глаза, рот, нос)
    role = d['role'] if 'role' in d.files else None
    capt = np.char.startswith(d['part'].astype(str), 'cap_') if 'part' in d.files else None
    land = json.loads(str(d['land'])) if 'land' in d.files else {}
    lk = sorted(land)
    nv0 = len(V)
    if lk:  # метки едут вместе с сеткой через все преобразования (лишние точки в конце V)
        V = np.r_[V, np.array([land[k] for k in lk], float)]
        UV = np.r_[UV, np.zeros((len(lk), 2))]
    g, wd, body, skirt, jname, marks = load_p1(a.p1)
    H1 = body['P'][:, 1].max()
    eye1 = (np.array(marks['eyeOuterL']) + np.array(marks['eyeInnerL']) + np.array(marks['eyeOuterR']) + np.array(marks['eyeInnerR'])) / 4

    # ── 1. поворот (вверх +Y — у Tripo так), вперёд по глазам ──
    col = sample_tex(img, UV)
    cv = color_classes(col)
    Hn = V[:, 1].max() - V[:, 1].min()
    V[:, 1] -= V[:, 1].min()
    head = V[:, 1] > 0.6 * Hn
    yaw = 0.0
    if role is not None and 'irisL' in land:
        # линия между глазами — вдоль +X (у Tripo фигура уже смотрит в +Z; центроид головы смещён ушами/бантом)
        eL, eR = V[nv0 + lk.index('irisL')], V[nv0 + lk.index('irisR')]
        yaw = -math.atan2(eL[2] - eR[2], eL[0] - eR[0])
    elif cv['iris'][head].sum() > 10:
        hc = V[head].mean(0); ic = V[head & cv['iris']].mean(0)
        dv = ic - hc
        yaw = math.atan2(dv[0], dv[2])  # повернуть так, чтобы dv смотрел в +Z
    else:
        print('радужка по вершинам не найдена — вперёд считаю +Z')
    R = Rot.from_euler('y', -yaw).as_matrix()
    V = V @ R.T
    print(f'поворот вокруг Y: {math.degrees(-yaw):.1f}°')
    # центр по x/z — по стопам; масштаб — общий рост, дальше — подобие по меткам тела
    s0 = H1 / Hn
    V *= s0
    feet = V[:, 1] < 0.04 * H1
    p1feet = body['P'][body['P'][:, 1] < 0.04 * H1]
    V[:, 0] += p1feet[:, 0].mean() - V[feet, 0].mean(); V[:, 2] += p1feet[:, 2].mean() - V[feet, 2].mean()

    # ── 2. метки тела и деформация: суставы новой сетки → кости p1 (лицо не трогаем — накладки встают на него) ──
    Lp = body_landmarks(body['P'], H1, 'p1')
    Ln = body_landmarks(V, H1, 'new')
    pairs = [(k, Ln[k], Lp[k], 1.0) for k in Lp if k in Ln]
    names = [p[0] for p in pairs]
    S = np.array([p[1] for p in pairs]); D = np.array([p[2] for p in pairs]); Wt = np.array([p[3] for p in pairs])
    print('метки:', len(pairs), names)
    sc, tr = similarity_axes(S, D, Wt)
    sc = np.clip(sc, 0.9, 1.1)
    tr = (D - S * sc).mean(0) if True else tr
    V1 = V * sc + tr
    S1 = S * sc + tr
    # голова, худи и пачка — жёстко (опоры без сдвига в середине тела), сплайн гнёт только руки и ноги
    anchors = V1[np.random.default_rng(1).choice(len(V1), 400, replace=False)]
    keep = (anchors[:, 1] > 0.55 * H1) | ((np.abs(anchors[:, 0]) < 0.12) & (anchors[:, 1] > 0.2 * H1))
    A = anchors[keep]
    src = np.r_[S1, A]; dst = np.r_[D, A]
    f = tps_fit(src, dst, a.tps_reg)
    Vw = f(V1)
    disp = np.linalg.norm(Vw - V1, axis=1)
    print(f'масштаб по осям {np.round(sc, 3)}, сплайн: сдвиг медиана {np.median(disp) * 1000:.1f} мм, макс {disp.max() * 1000:.1f} мм')
    for nm, s_, d_ in zip(names, S1, D):
        print(f'  {nm:12s} {np.linalg.norm(s_ - d_) * 1000:6.1f} мм')
    face = {}
    if lk:
        face = {k: Vw[nv0 + i].copy() for i, k in enumerate(lk)}
        Vw = Vw[:nv0]; V1 = V1[:nv0]; UV = UV[:nv0]
        cv = {k: v[:nv0] for k, v in cv.items()}
        print('лицо (по частям):', ' '.join(f'{k}={np.round(v, 3).tolist()}' for k, v in face.items()))
    elif not a.no_face:
        face = face_landmarks(Vw, F, UV, img, a.debug)
        print('лицо:', ' '.join(f'{k}={np.round(v, 3).tolist()}' for k, v in face.items()))
    if a.debug:
        np.savez_compressed(os.path.join(a.debug, 'p3_aligned.npz'), V=Vw, F=F, UV=UV, face=json.dumps({k: list(map(float, v)) for k, v in face.items()}),
                            Ln=json.dumps({k: list(map(float, f(v[None] * sc + tr)[0])) for k, v in Ln.items()}), Lp=json.dumps({k: list(map(float, v)) for k, v in Lp.items()}))
    V = Vw
    patch = None
    if capt is not None and capt.any():
        # заплатки: внутренность сгладить (край — общий с головой, на месте) — без граней на крупном плане
        cv_ = np.zeros(len(V), bool); cv_[F[capt].ravel()] = True
        wm = weld_map(V, 1e-6)
        shared = np.zeros(wm.max() + 1, int); np.add.at(shared, wm[~cv_], 1)
        fixed = ~cv_ | (shared[wm] > 0)
        V = smooth_field(V, edges_of(F[capt]), len(V), 10, 0.5, fixed=fixed)
    if role is not None:
        # роли частей вместо цвета: мех (голова, уши, кисти, ноги, морда), хвост, худи
        rv = np.full(len(V), '', dtype=object)
        for k in range(3):
            rv[F[:, k]] = role
        cv = dict(cv)
        cv['fur'] = np.isin(rv, ['fur', 'muzzle']); cv['purple'] = rv == 'tail'; cv['lavender'] = rv == 'cloth'
        cv['role'] = rv
    if face and role is None:
        V, mouthv, ringv = close_mouth(V, face)
        # залитое место и кольцо вокруг — сгладить (иначе грани латки видны крупным планом); края — на месте
        wm = weld_map(V); nW = wm.max() + 1
        reg = np.zeros(nW, bool); np.logical_or.at(reg, wm, mouthv | ringv)
        Vw_ = np.zeros((nW, 3)); cnt = np.zeros(nW); np.add.at(Vw_, wm, V); np.add.at(cnt, wm, 1); Vw_ /= cnt[:, None]
        Vw_ = smooth_field(Vw_, wm[edges_of(F)], nW, 8, 0.5, fixed=~reg)
        V = Vw_[wm]
        # треугольники рта — на свои копии вершин с UV одноцветной «латки» меха (место в атласе — в paint_face):
        # перекладка UV на общих вершинах растянула бы соседние треугольники через весь атлас
        tm = mouthv[F].any(1)
        vs = np.unique(F[tm])
        remap = {int(v): len(V) + k for k, v in enumerate(vs)}
        V = np.r_[V, V[vs]]; UV = np.r_[UV, UV[vs]]
        F = F.copy(); F[tm] = np.vectorize(remap.get)(F[tm])
        patch = (np.arange(len(V) - len(vs), len(V)), ringv)
        cv = {k: np.r_[v, v[vs]] for k, v in cv.items()}
        print(f'рот: {mouthv.sum()} вершин залиты, {tm.sum()} треуг. — на латку меха')
    N = vnormals_welded(V, F)

    np.savez_compressed(os.path.join(a.debug or '/tmp', 'p3_warped.npz'), V=V, F=F, UV=UV)
    a.capt = capt
    build(a, g, wd, body, skirt, jname, marks, V, N, F, UV, img, cv, face, patch, role)


def mem(tag):
    if os.environ.get('P3_MEM'):
        import resource
        print(f'[mem] {tag}: {resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024} МБ', flush=True)


def build(a, g, wd, body, skirt, jname, marks, V, N, F, UV, img, cv, face, patch=None, role=None):
    j = g.j
    nb = len(jname)
    H1 = body['P'][:, 1].max()
    # ── пачка: в поясе между низом худи и подолом — всё, что не мех (ноги, хвост) и не худи; цвет — по 4 точкам треугольника ──
    lav = cv['lavender']
    waist = np.percentile(V[lav, 1], 3) if lav.any() else 0.38 * H1  # низ худи
    imgf = img.astype(np.float32)
    notk = np.zeros(len(F))
    for bw in ((1 / 3, 1 / 3, 1 / 3), (0.6, 0.2, 0.2), (0.2, 0.6, 0.2), (0.2, 0.2, 0.6)):
        uvs = (UV[F] * np.array(bw)[None, :, None]).sum(1)
        c = color_classes(sample_tex(imgf, uvs))
        notk += (c['fur'] | c['lavender'] | c['purple'] | c['pink']).astype(float)
    ty = V[F].mean(1)[:, 1]
    hipsy = wd.p('mixamorig:Hips')[1]
    sk_tri = (notk < 2) & (ty < waist + 0.012) & (ty > hipsy - 0.17)
    gold_tri = np.zeros(len(F), bool)
    if role is not None:
        sk_tri = role == 'tutu'
        gold_tri = role == 'gold'
    # связность: оставить только крупный кусок (а не мятные манжеты)
    print(f'пачка: {sk_tri.sum()} треуг. (низ худи y={waist:.3f})')

    mem('веса')
    # ── 3. веса ──
    D1 = dense_weights(body['J'], body['W'], nb)
    Ps, tid, bc = surface_samples(body['P'], body['I'], 1.2e5)
    D1 = D1.astype(np.float32)
    Ds = np.zeros((len(tid), nb), np.float32)
    for k in range(3):
        Ds += D1[body['I'][tid, k]] * bc[:, k:k + 1].astype(np.float32)
    tree = cKDTree(Ps)
    dist, nn = tree.query(V, k=4)
    wq = 1.0 / np.maximum(dist, 1e-4) ** 2
    Dn = (Ds[nn] * wq[:, :, None]).sum(1) / wq.sum(1, keepdims=True)
    # пачка — веса фатина p1 (мягкие: таз/бёдра)
    sk_v = np.zeros(len(V), bool); sk_v[F[sk_tri].ravel()] = True
    if skirt is not None and sk_v.any():
        Dk = dense_weights(skirt['J'], skirt['W'], nb)
        Pk, tk, bk = surface_samples(skirt['P'], skirt['I'], 1.2e5)
        Dks = sum(Dk[skirt['I'][tk, k]] * bk[:, k:k + 1] for k in range(3)).astype(np.float32)
        tk_ = cKDTree(Pk)
        dd, nk = tk_.query(V[sk_v], k=8)
        wk = 1.0 / np.maximum(dd, 1e-4) ** 2
        Dn[sk_v] = (Dks[nk] * wk[:, :, None]).sum(1) / wk.sum(1, keepdims=True)
    # хвост: вершины, ближе к хвосту p1, чем к телу, — по цепочке Tail1..4 (проекция на отрезки)
    tail_ids = [jname.index(f'Tail{i}') for i in range(1, 5)]
    tw = Dn[:, tail_ids].sum(1)
    tails = tw > 0.3
    if role is not None:
        tails = cv['role'] == 'tail'
        # бант и звёзды на голове — жёстко к голове
        gv = np.zeros(len(V), bool); gv[F[gold_tri].ravel()] = True
        gh = gv & (V[:, 1] > wd.p('mixamorig:Neck')[1] + 0.05)
        Dn[gh] = 0; Dn[gh, jname.index('mixamorig:Head')] = 1
    Dn = assign_tail(V, Dn, tails, wd, jname, tail_ids)
    # сглаживание весов по сетке (сшитые швы UV)
    wm = weld_map(V)
    nW = wm.max() + 1
    Ew = wm[edges_of(F)]
    Dw = np.zeros((nW, nb)); cw = np.zeros(nW)
    np.add.at(Dw, wm, Dn); np.add.at(cw, wm, 1); Dw /= cw[:, None]
    Dw = smooth_field(Dw, Ew, nW, 2, 0.5)
    Dn = Dw[wm]
    Jn, Wn = top4(Dn)

    mem('морфы')
    # ── 4. морфы тела p1 → новая сетка (только морда) ──
    targets = []
    tnames = body['tnames']
    if body['targets']:
        dd, nn1 = cKDTree(body['P']).query(V, k=4)
        w1 = 1.0 / np.maximum(dd, 1e-4) ** 2; w1 /= w1.sum(1, keepdims=True)
        near = dd[:, 0] < 0.02
        fall = np.clip(1 - (dd[:, 0] - 0.006) / 0.014, 0, 1) * near
        for t in body['targets']:
            dP = (t['POSITION'][nn1] * w1[:, :, None]).sum(1) * fall[:, None]
            dN = (t['NORMAL'][nn1] * w1[:, :, None]).sum(1) * fall[:, None] if 'NORMAL' in t else None
            targets.append((dP.astype(np.float32), None if dN is None else dN.astype(np.float32)))

    mem('текстура')
    # ── 5. текстура: закрасить нарисованные глаза и рот ──
    mk3 = new_marks(marks, face)
    tex = paint_face(img, V, F, UV, face, mk3, a, patch)
    if role is None:
        tex = tail_tint(tex, V, F, UV, Jn, Wn, jname)

    mem('глаза')
    # ── глаза p1: та же глубина над новой поверхностью ──
    fit_face_kit(g, wd, body, V, F, a, marks, mk3)

    mem('сборка')
    # ── сборка GLB ──
    # без меха у глаз и рта (оболочки торчали бы сквозь веки и рот шейдером): эллипсы глаз ×1.6, рот ×1.8
    nf = np.ones(len(V))
    for side in 'LR':
        c3, w3, h3 = eye_frame(mk3, side)
        r = np.linalg.norm((V - c3) / [w3 * 0.5 * 1.6, h3 * 0.5 * 1.8, w3 * 0.8], axis=1)
        nf = np.minimum(nf, np.clip((r - 1) / 0.5, 0, 1))
    if 'mouthL' in mk3:
        L_, R_ = np.array(mk3['mouthL']), np.array(mk3['mouthR']); c = (L_ + R_) / 2; rx = np.linalg.norm(L_ - R_) / 2 * 1.8
        r = np.linalg.norm((V - c) / [rx, rx * 0.8, rx * 1.2], axis=1)
        nf = np.minimum(nf, np.clip((r - 1) / 0.5, 0, 1))
    cv = dict(cv); cv['furk'] = nf
    write_glb(g, wd, body, a, V, N, F, UV, Jn, Wn, targets, tnames, tex, sk_tri, cv, jname, tails, gold_tri)


def assign_tail(V, Dn, tails, wd, jname, tail_ids):
    """хвост по цепочке костей: доля вдоль ломаной Tail1→Tail4→кончик, линейная смесь соседних"""
    if not tails.any():
        return Dn
    pts = [wd.p(f'Tail{i}') for i in range(1, 5)]
    tip = pts[3] + (pts[3] - pts[2]) * 1.0
    chain = np.array(pts + [tip])
    seg = chain[1:] - chain[:-1]
    L = np.linalg.norm(seg, axis=1); cum = np.r_[0, np.cumsum(L)]
    P = V[tails]
    best = np.full(len(P), 1e9); tpar = np.zeros(len(P))
    for i in range(4):
        u = np.clip(((P - chain[i]) @ seg[i]) / L[i] ** 2, 0, 1)
        q = chain[i] + u[:, None] * seg[i]
        dd = np.linalg.norm(P - q, axis=1)
        m = dd < best
        best[m] = dd[m]; tpar[m] = (cum[i] + u[m] * L[i]) / L.sum()
    # позиция по длине → кости (центры сегментов)
    x = tpar * 4 - 0.5
    D = np.zeros((len(P), Dn.shape[1]))
    k0 = np.clip(np.floor(x), 0, 3).astype(int); k1 = np.clip(k0 + 1, 0, 3)
    fr = np.clip(x - k0, 0, 1)
    for i in range(len(P)):
        D[i, tail_ids[k0[i]]] += 1 - fr[i]; D[i, tail_ids[k1[i]]] += fr[i]
    # у корня — плавно в таз (как rig_cat.py)
    hips = jname.index('mixamorig:Hips')
    rootk = np.clip(tpar / 0.12, 0, 1)
    D *= rootk[:, None]; D[:, hips] += 1 - rootk
    old = Dn[tails]
    tw = old[:, tail_ids].sum(1, keepdims=True)
    Dn = Dn.copy()
    Dn[tails] = D * np.clip(tw * 1.5, 0, 1) + old * (1 - np.clip(tw * 1.5, 0, 1))
    return Dn


def paint_face(img, V, F, UV, face, marks, a, patch=None):
    """нарисованные Tripo глаза (вместе с ресницами) и рот закрасить мехом вокруг → новая картинка a.tex²"""
    size = a.tex
    im = Image.fromarray(img).resize((size, size), Image.LANCZOS)
    arr = np.asarray(im).astype(np.float32)
    if not face:
        return Image.fromarray(arr.astype(np.uint8))
    pos, nrm, tid = raster_uv(V, vnormals(V, F), UV, F, size)
    cl = color_classes(arr)
    has = tid >= 0
    front = has & (nrm[..., 2] > -0.2)
    m = np.zeros((size, size), bool)
    for side in 'LR':
        o, i_, b = (np.array(marks[f'eye{k}{side}'], float) for k in ('Outer', 'Inner', 'Bottom'))
        c = (o + i_) / 2; c[1] = (marks[f'eyeTop{side}'] + b[1]) / 2
        rx = np.linalg.norm(o - i_) / 2; ry = (marks[f'eyeTop{side}'] - b[1]) / 2
        sgn = 1 if side == 'L' else -1
        r = np.linalg.norm((pos - c) / [rx * 1.32, ry * 1.45, rx * 1.4], axis=-1)
        # ресницы Meshy торчат вверх-наружу: второй эллипс, сдвинутый к внешнему краю и вверх
        c2 = c + [sgn * 0.45 * rx, 0.35 * ry, -0.2 * rx]
        r2 = np.linalg.norm((pos - c2) / [rx * 1.15, ry * 1.25, rx * 1.4], axis=-1)
        m |= front & ((r < 1) | (r2 < 1))
    capt = getattr(a, 'capt', None)
    if capt is not None and capt.any():
        # заплатки дыр (glitter_p3_parts.py) — целиком: цвет из меха вокруг в 3D, без шва по краю
        m |= has & capt[np.maximum(tid, 0)]
    if patch is None and 'mouthL' in face:
        # нарисованные губы вокруг рта (части рта Tripo уже нет): розово-красное и тёмное у рта → мех морды
        L_, R_ = np.array(face['mouthL']), np.array(face['mouthR'])
        c = (L_ + R_) / 2
        rx = np.linalg.norm(L_ - R_) / 2 * 1.9; ry = rx * 0.75
        r = np.linalg.norm((pos - c) / [rx, ry, rx * 1.2], axis=-1)
        lipc = (arr[..., 0] > arr[..., 2] + 2) | cl['dark'] | cl['mouth'] | cl['pink']
        m |= has & (r < 1) & (pos[..., 1] < marks['nose'][1] - 0.006) & (lipc | (r < 0.45))
    mask = m
    # закраска в 3D: цвет — среднее известных текселей морды вокруг (по поверхности, не по UV: атлас Meshy дробный)
    ring = has & ~mask & (np.linalg.norm(pos - pos[mask].mean(0), axis=-1) < 0.16) & (nrm[..., 2] > -0.2)
    rp = pos[ring]; rc = arr[ring]
    tr = cKDTree(rp)
    out = arr.copy()
    mi = np.argwhere(mask)
    for s0 in range(0, len(mi), 50000):
        part = mi[s0:s0 + 50000]
        dd, ii = tr.query(pos[part[:, 0], part[:, 1]], k=32)
        w = (1 / np.maximum(dd, 1e-4) ** 2).astype(np.float32)
        out[part[:, 0], part[:, 1]] = (rc[ii] * w[..., None]).sum(1) / w.sum(1, keepdims=True)
    # зерно меха поверх закраски (иначе гладкое пятно)
    rng = np.random.default_rng(3)
    out[mask] += rng.normal(0, 3.5, (int(mask.sum()), 3)).astype(np.float32)
    if patch is not None:
        # латка рта: свободный блок атласа 24×24, цвет — медиана меха морды вокруг рта
        pv, ringv = patch
        free = ~np.asarray(Image.fromarray(has.astype(np.uint8) * 255).filter(ImageFilter.MaxFilter(7))).astype(bool)
        B = 24
        fb = None
        for y in range(0, size - B, B):
            for x in range(0, size - B, B):
                if free[y:y + B, x:x + B].all():
                    fb = (y, x); break
            if fb:
                break
        rc_ = sample_tex(arr, UV[np.nonzero(ringv)[0]])
        okc = (rc_[:, 2] >= rc_[:, 0]) & (rc_.mean(1) > 150)  # мех морды: голубовато-светлый, без розового губ
        rcol = np.median(rc_[okc] if okc.sum() > 10 else rc_, 0)
        y, x = fb
        out[y:y + B, x:x + B] = rcol
        UV[pv] = [(x + B / 2) / size, (y + B / 2) / size]
        print(f'латка рта: блок {fb}, цвет {np.round(rcol).tolist()}')
    # кайма островов UV вокруг закрашенного (фильтрация текстуры берёт соседние тексели вне треугольников)
    grow = np.asarray(Image.fromarray(mask.astype(np.uint8) * 255).filter(ImageFilter.MaxFilter(9))) > 0
    edge = grow & ~has
    if edge.any():
        known = out.copy()
        fill = inpaint(known, edge, it=8)
        out[edge] = fill[edge]
    if a.debug:
        dbg = arr.copy(); dbg[mask] = [255, 0, 255]
        Image.fromarray(dbg.astype(np.uint8)).save(os.path.join(a.debug, 'paint_mask.png'))
    print(f'закраска лица: {mask.sum()} текселей')
    res = Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))
    if a.debug:
        res.save(os.path.join(a.debug, 'painted.png'))
    return res


def tail_tint(tex, V, F, UV, Jn, Wn, jname):
    """хвост по рефу: от лавандового у основания к фиолетовому к кончику, золотые блёстки гуще к кончику
    (у Meshy хвост вышел серым мехом). Доля «кончика» — по весам костей Tail1..Tail4."""
    rank = {i: int(n[4]) for i, n in enumerate(jname) if n.startswith('Tail')}
    t = np.zeros(len(V))
    for k in range(4):
        r = np.vectorize(lambda j: rank.get(int(j), 0))(Jn[:, k])
        t += Wn[:, k] * r / 4.0
    if t.max() < 0.2:
        return tex
    arr = np.asarray(tex).astype(np.float32)
    size = arr.shape[0]
    pos, nrm, tid = raster_uv(V, vnormals(V, F), UV, F, size)
    has = tid >= 0
    tt = np.zeros(tid.shape, np.float32)
    tt[has] = t[F[tid[has]]].mean(1)
    k = np.clip((tt - 0.12) / 0.75, 0, 1)
    m = has & (k > 0)
    lum = arr[m].mean(1, keepdims=True)
    base = np.array([182, 166, 222], np.float32); tip = np.array([128, 84, 190], np.float32)
    kk = k[m][:, None]
    col = base * (1 - kk) + tip * kk
    tint = col * (lum / max(float(np.median(lum)), 1))
    w = np.clip(k[m] * 1.6, 0, 0.85)[:, None]
    arr[m] = arr[m] * (1 - w) + tint * w
    rng = np.random.default_rng(11)
    sp = m & (rng.random(m.shape) < 0.035 * k)
    arr[sp] = arr[sp] * 0.3 + np.array([236, 200, 120], np.float32) * 0.7
    print(f'хвост: тон к кончику на {int(m.sum())} текселях')
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def ray_hit(V, F, O, Dd):
    """ближайшее пересечение луча с сеткой (Möller–Trumbore, все треугольники)"""
    v0 = V[F[:, 0]]; e1 = V[F[:, 1]] - v0; e2 = V[F[:, 2]] - v0
    p = np.cross(Dd, e2); det = (e1 * p).sum(1)
    ok = np.abs(det) > 1e-12
    inv = np.where(ok, 1 / np.where(ok, det, 1), 0)
    s = O - v0
    u = (s * p).sum(1) * inv
    q = np.cross(s, e1)
    v = (q @ Dd) * inv
    t = (e2 * q).sum(1) * inv
    hit = ok & (u >= 0) & (v >= 0) & (u + v <= 1) & (t > 0)
    return t[hit].min() if hit.any() else None


def close_mouth(V, face):
    """открытый рот Meshy — полость в голове; рот у нас шейдером (MouthD), поэтому полость «заливается»: вершины
    за поверхностью морды у рта встают на квадрику, натянутую на кольцо вершин вокруг рта"""
    if 'mouthTop' not in face:
        return V, 0
    L, R = np.array(face['mouthL']), np.array(face['mouthR'])
    c = (L + R) / 2; c[1] = (face['mouthTop'][1] + face['mouthBottom'][1]) / 2
    rx = np.linalg.norm(L - R) / 2; ry = max((face['mouthTop'][1] - face['mouthBottom'][1]) / 2, 0.4 * rx)
    q = np.sqrt(((V[:, 0] - c[0]) / rx) ** 2 + ((V[:, 1] - c[1]) / ry) ** 2)
    near = np.abs(V[:, 2] - c[2]) < 0.09
    ring = near & (q > 1.25) & (q < 2.2) & (V[:, 2] > c[2] - 0.03)
    x, y = V[ring, 0] - c[0], V[ring, 1] - c[1]
    A = np.c_[np.ones_like(x), x, y, x * x, x * y, y * y]
    coef = np.linalg.lstsq(A, V[ring, 2], rcond=None)[0]
    dx = np.abs(V[:, 0] - c[0]) / rx; dy = (V[:, 1] - c[1]) / ry
    inside = (V[:, 2] > c[2] - 0.1) & (dx < 1.3) & (dy > -2.0) & (dy < 2.6)
    xi, yi = V[inside, 0] - c[0], V[inside, 1] - c[1]
    zf = np.c_[np.ones_like(xi), xi, yi, xi * xi, xi * yi, yi * yi] @ coef
    V = V.copy()
    idx = np.nonzero(inside)[0]
    low = V[idx, 2] < zf - 0.003
    V[idx[low], 2] = zf[low] - 0.0005
    # те же вершины + сама прорезь рта — UV ближайшей вершины кольца (мех морды): нарисованные губы/язык уходят,
    # даже если тексели полости делят атлас с другими местами
    mouthv = np.zeros(len(V), bool); mouthv[idx[low]] = True
    mouthv |= near & (dx < 1.1) & (dy > -1.5) & (dy < 1.6) & (V[:, 2] > c[2] - 0.1)
    ringv = near & (q > 1.35) & (q < 1.9) & (V[:, 2] > c[2] - 0.02)
    return V, mouthv, ringv


def new_marks(marks, face):
    """разметка лица (Brows.extras.marks: мировые точки, их читают furTone/faceWrinkles/mouthRig) — по новой сетке"""
    m = dict(marks)
    if 'irisL' not in face:
        return m
    for side in 'LR':
        for k in ('Outer', 'Inner', 'Bottom'):
            m[f'eye{k}{side}'] = [round(float(x), 5) for x in face[f'eye{k}{side}']]
        m[f'eyeTop{side}'] = float(face[f'eyeTop{side}'][1])
    for k in ('nose', 'noseTop', 'mouthL', 'mouthR'):
        if k in face:
            m[k] = [round(float(x), 5) for x in face[k]]
    if 'mouthC' in face:  # 'mouth' у p1 — точка внутри головы за ртом: тот же сдвиг, что у уголков
        d = (np.array(face['mouthL']) + np.array(face['mouthR'])) / 2 - (np.array(marks['mouthL']) + np.array(marks['mouthR'])) / 2
        m['mouth'] = [round(float(x), 5) for x in np.array(marks['mouth']) + d]
    if 'nose' in face:
        m['noseHalfW'] = float(marks['noseHalfW'])
    return m


def eye_frame(mk, side):
    o, i, b = (np.array(mk[f'eye{k}{side}'], float) for k in ('Outer', 'Inner', 'Bottom'))
    c = (o + i) / 2
    c[1] = (mk[f'eyeTop{side}'] + b[1]) / 2
    return c, np.linalg.norm(o - i), mk[f'eyeTop{side}'] - b[1]


def fit_face_kit(g, wd, body, V, F, a, marks, mk3):
    """глаза p1 → на нарисованные глаза новой сетки (центр, ширина и высота разреза; глубина — как выступали у p1),
    брови — тем же переносом по стороне, MouthD — подобием по уголкам рта; затем Brows и MouthD — на поверхность"""
    j = g.j
    # отступ накладок над поверхностью p1 — до любых сдвигов
    P1s, _, _ = surface_samples(body['P'], body['I'], 8e5)
    t1k = cKDTree(P1s)
    off0 = {}
    for name in ('Brows', 'MouthD'):
        if name in wd.idx:
            n = j['nodes'][wd.idx[name]]; M = wd.m(wd.idx[name])
            P = g.acc(j['meshes'][n['mesh']]['primitives'][0]['attributes']['POSITION']).astype(np.float64)
            off0[name] = t1k.query(P @ M[:3, :3].T + M[:3, 3])[0]
    eye_map = {}
    for side in 'LR':
        ni = wd.idx[f'Eye_{side}']
        c1, w1, h1 = eye_frame(marks, side)
        c3, w3, h3 = eye_frame(mk3, side)
        sx, sy = w3 / w1, h3 / h1
        sz = (sx + sy) / 2
        eye_map[side] = (c1, c3, np.array([sx, sy, sz]))
        M = wd.m(ni)
        o = M[:3, 3]; fw = M[:3, :3] @ np.array([0, 0, 1.0]); fw /= np.linalg.norm(fw)
        t1 = ray_hit(body['P'], body['I'], o - fw * 0.15, fw)
        o3 = o + (c3 - c1)
        t3 = ray_hit(V, F, o3 - fw * 0.15, fw)
        dz = 0.0
        if t1 is not None and t3 is not None:
            dz = float(np.clip((t3 - 0.15) - (t1 - 0.15) * sz, -0.03, 0.03))
        dw = (c3 - c1) + fw * dz
        Pinv = np.linalg.inv(wd.m(wd.par[ni]))
        n = j['nodes'][ni]
        n['translation'] = (np.array(n.get('translation', [0, 0, 0])) + Pinv[:3, :3] @ dw).tolist()
        es = j['nodes'][wd.idx[f'EyeS_{side}']]
        es['scale'] = (np.array(es.get('scale', [1, 1, 1])) * [sx, sy, sz]).tolist()
        print(f'Eye_{side}: сдвиг {np.round((c3 - c1) * 1000, 1).tolist()} мм, по оси {dz * 1000:+.1f} мм, масштаб {np.round([sx, sy, sz], 3).tolist()}')
    # MouthD: подобие по уголкам рта (узел — масштаб и сдвиг; разметка рта в extras — в системе узла, остаётся верной)
    if 'MouthD' in wd.idx and 'mouthL' in mk3:
        L1, R1 = np.array(marks['mouthL']), np.array(marks['mouthR'])
        L3, R3 = np.array(mk3['mouthL']), np.array(mk3['mouthR'])
        k = np.linalg.norm(L3 - R3) / np.linalg.norm(L1 - R1)
        k = float(np.clip(k, 0.8, 1.25))
        ni = wd.idx['MouthD']
        M = wd.m(ni)
        c1 = (L1 + R1) / 2; c3 = (L3 + R3) / 2
        # мир: x' = c3 + k (x − c1) → в системе родителя
        par = wd.m(wd.par[ni]); Pinv = np.linalg.inv(par)
        newW = np.eye(4); newW[:3, :3] = k * M[:3, :3]; newW[:3, 3] = c3 + k * (M[:3, 3] - c1)
        loc = Pinv @ newW
        n = j['nodes'][ni]
        n.pop('matrix', None)
        sc = np.linalg.norm(loc[:3, :3], axis=0)
        n['translation'] = loc[:3, 3].tolist(); n['scale'] = sc.tolist()
        n['rotation'] = Rot.from_matrix(loc[:3, :3] / sc).as_quat().tolist()
        print(f'MouthD: масштаб ×{k:.3f}, сдвиг {np.round((c3 - c1) * 1000, 1).tolist()} мм')
    # брови: перенос глаза своей стороны (сдвиг + масштаб вокруг центра глаза) по вершинам
    if 'Brows' in wd.idx:
        ni = wd.idx['Brows']; n = j['nodes'][ni]; M = wd.m(ni)
        pr = j['meshes'][n['mesh']]['primitives'][0]
        P = g.acc(pr['attributes']['POSITION']).astype(np.float64)
        Pw = P @ M[:3, :3].T + M[:3, 3]
        for side, sgn in (('L', 1), ('R', -1)):
            c1, c3, sv = eye_map[side]
            m = sgn * Pw[:, 0] > 0
            Pw[m] = c3 + (Pw[m] - c1) * [sv[0], 1.0, 1.0]
        Pl = (Pw - M[:3, 3]) @ np.linalg.inv(M[:3, :3]).T
        g.set_acc(pr['attributes']['POSITION'], Pl.astype(np.float32))
        n.setdefault('extras', {})['marks'] = mk3
    wd = World(j)  # узлы сдвинуты — мировые матрицы заново
    # накладки: проекция на новую поверхность (отступ над p1 сохраняется)
    Ps, tid, bc = surface_samples(V, F, 8e5)
    Ns = vnormals(V, F)[F[tid]].mean(1)
    tn = cKDTree(Ps)
    for name in ('Brows', 'MouthD'):
        if name not in off0:
            continue
        ni = wd.idx[name]
        n = j['nodes'][ni]
        M = wd.m(ni)
        pr = j['meshes'][n['mesh']]['primitives'][0]
        P = g.acc(pr['attributes']['POSITION']).astype(np.float64)
        Pw = P @ M[:3, :3].T + M[:3, 3]
        off = off0[name] * (np.linalg.norm(M[:3, 0]))  # отступ над p1 (× масштаб узла)
        dn, inn = tn.query(Pw)
        q = Ps[inn] + Ns[inn] / np.maximum(np.linalg.norm(Ns[inn], axis=1, keepdims=True), 1e-9) * off[:, None]
        delta = q - Pw
        # плавно: сдвиг сглажен по накладке (без «ступенек»), выбросы (ближайшей оказалась чужая поверхность) — по медиане
        I = g.acc(pr['indices']).reshape(-1, 3).astype(np.int64)
        med = np.median(delta, 0)
        bad = np.linalg.norm(delta - med, axis=1) > 0.008
        delta[bad] = med
        delta = smooth_field(delta, edges_of(I), len(P), 6, 0.5)
        Pn = Pw + delta
        Pl = (Pn - M[:3, 3]) @ np.linalg.inv(M[:3, :3]).T
        g.set_acc(pr['attributes']['POSITION'], Pl.astype(np.float32))
        print(f'{name}: проекция, сдвиг медиана {np.median(np.linalg.norm(delta, axis=1)) * 1000:.1f} мм, макс {np.linalg.norm(delta, axis=1).max() * 1000:.1f}')


def fur_length(V, F, cv, Jn, Wn, jname):
    """_FURLEN: мех по цвету (не одежда), край меха → 0, голова короче, хвост длиннее, кисти — без меха"""
    wm = weld_map(V); nW = wm.max() + 1
    E = wm[edges_of(F)]

    def to_w(x):
        s = np.zeros(nW); c = np.zeros(nW); np.add.at(s, wm, x); np.add.at(c, wm, 1); return s / np.maximum(c, 1)

    def bw(pred):
        ids = [i for i, n in enumerate(jname) if pred(n)]
        return (np.isin(Jn, ids) * Wn).sum(1)
    fur = cv['fur'] | cv['purple']
    tail = bw(lambda n: n.startswith('Tail'))
    fur = fur | (tail > 0.5)
    f = smooth_field(to_w(fur.astype(float)), E, nW, 1) > 0.5
    lo = f.astype(float)
    for _ in range(2):
        m = lo.copy(); np.minimum.at(m, E[:, 0], lo[E[:, 1]]); np.minimum.at(m, E[:, 1], lo[E[:, 0]]); lo = m
    lo = smooth_field(lo, E, nW, 3)[wm]
    head = bw(lambda n: 'Head' in n or 'Ear' in n)
    hand = bw(lambda n: 'Hand' in n)
    foot = bw(lambda n: 'Foot' in n or 'Toe' in n)
    L = 0.0075 * lo * (1 - 0.3 * np.clip(head, 0, 1)) * (1 + 0.4 * np.clip(tail, 0, 1)) * (1 - 0.35 * np.clip(foot, 0, 1))
    L *= 1 - np.clip((hand - 0.1) / 0.4, 0, 1)
    if 'furk' in cv:
        L *= cv['furk']
    return L.astype(np.float32)


def write_glb(g, wd, body, a, V, N, F, UV, Jn, Wn, targets, tnames, tex, sk_tri, cv, jname, tails, gold_tri=None):
    j = g.j
    bi = body['mesh']
    mesh = j['meshes'][bi]
    prim = mesh['primitives'][0]
    nv = len(V)
    itype = (5123, np.uint16) if nv < 65535 else (5125, np.uint32)
    attrs = {
        'POSITION': g.add_acc(V.astype(np.float32), 5126, 'VEC3', 34962),
        'NORMAL': g.add_acc(N.astype(np.float32), 5126, 'VEC3', 34962),
        'TEXCOORD_0': g.add_acc(UV.astype(np.float32), 5126, 'VEC2', 34962),
        'JOINTS_0': g.add_acc(Jn, 5123, 'VEC4', 34962),
        'WEIGHTS_0': g.add_acc(Wn, 5126, 'VEC4', 34962),
    }
    tg = []
    for dP, dN in targets:
        t = {'POSITION': g.add_acc(dP, 5126, 'VEC3')}
        if dN is not None:
            t['NORMAL'] = g.add_acc(dN, 5126, 'VEC3')
        tg.append(t)
    body_tris = F[~sk_tri & ~(gold_tri if gold_tri is not None else np.zeros(len(F), bool))]
    prim['attributes'] = attrs
    prim['indices'] = g.add_acc(body_tris.ravel().astype(itype[1]), itype[0], 'SCALAR', 34963)
    if tg:
        prim['targets'] = tg
    else:
        prim.pop('targets', None)
    # материал тела: новая текстура, без карт нормалей/шероховатости Tripo p1
    mat = j['materials'][prim['material']]
    bct = mat['pbrMetallicRoughness']['baseColorTexture']['index']
    src = j['textures'][bct]['source']
    j['images'][src]['mimeType'] = 'image/jpeg'
    j['images'][src]['name'] = 'glitter_p3_base'
    g.set_image(src, tex)
    mat.pop('normalTexture', None)
    mat.pop('emissiveTexture', None); mat.pop('emissiveFactor', None)  # блёстки p1 (BD_sparkle) — в UV p1
    mat['pbrMetallicRoughness'].pop('metallicRoughnessTexture', None)
    mat['pbrMetallicRoughness']['metallicFactor'] = 0.0
    mat['pbrMetallicRoughness']['roughnessFactor'] = 0.78
    mat['name'] = 'glitter_p3_body'

    # пачка — отдельный меш на тех же буферах, полупрозрачный
    def sub_mesh(name, tris, mat, extras):
        # свои буферы (только вершины части): общий буфер со всем телом рантайм скинил бы целиком второй раз,
        # а коррекция рук (bodyCollide) брала бы из «пачки» точки кистей
        sv, inv = np.unique(F[tris].ravel(), return_inverse=True)
        sa = {'POSITION': g.add_acc(V[sv].astype(np.float32), 5126, 'VEC3', 34962), 'NORMAL': g.add_acc(N[sv].astype(np.float32), 5126, 'VEC3', 34962),
              'TEXCOORD_0': g.add_acc(UV[sv].astype(np.float32), 5126, 'VEC2', 34962), 'JOINTS_0': g.add_acc(Jn[sv], 5123, 'VEC4', 34962),
              'WEIGHTS_0': g.add_acc(Wn[sv], 5126, 'VEC4', 34962)}
        j['materials'].append(mat)
        sp = {'attributes': sa, 'indices': g.add_acc(inv.astype(np.uint16 if len(sv) < 65535 else np.uint32), 5123 if len(sv) < 65535 else 5125, 'SCALAR', 34963),
              'material': len(j['materials']) - 1}
        j['meshes'].append({'name': name, 'primitives': [sp]})
        add_skinned_node(j, name, len(j['meshes']) - 1, extras)

    if sk_tri.any():
        sub_mesh('Skirt_P3', sk_tri, {'name': 'Skirt_P3_mat', 'alphaMode': 'BLEND', 'doubleSided': True,
                 'pbrMetallicRoughness': {'baseColorTexture': {'index': bct}, 'baseColorFactor': [1, 1, 1, 0.82], 'metallicFactor': 0.0, 'roughnessFactor': 0.55}},
                 {'skirtP3': 1, 'tulle': 1})
    if gold_tri is not None and gold_tri.any():
        # бант, звёзды, кант пояса — золото по рефу (металл; без карты окружения металл темнеет — 0.55 и подсветка)
        sub_mesh('Bow_Glitter', gold_tri, {'name': 'Gold_P3_mat', 'pbrMetallicRoughness': {'baseColorTexture': {'index': bct},
                 'metallicFactor': 0.55, 'roughnessFactor': 0.32}, 'emissiveFactor': [0.10, 0.08, 0.03]}, {'goldP3': 1})

    # мех
    L = fur_length(V, F, cv, Jn, Wn, jname)
    fi = wd.idx['BD_FurShell']
    fn = j['nodes'][fi]
    fm = j['meshes'][fn['mesh']]
    fp = fm['primitives'][0]
    ftri = body_tris[(L[body_tris] > 0.0012).all(1)]
    fa = dict(attrs); fa['_FURLEN'] = g.add_acc(L, 5126, 'SCALAR', 34962)
    fp['attributes'] = fa
    fp['indices'] = g.add_acc(ftri.ravel().astype(itype[1]), itype[0], 'SCALAR', 34963)
    if tg:
        fp['targets'] = [dict(t) for t in tg]
        fm.setdefault('extras', {})['targetNames'] = list(tnames)
    else:
        fp.pop('targets', None)
    print(f'мех: {len(ftri)} треуг., длина до {L.max() * 1000:.1f} мм')
    mesh.setdefault('extras', {})['targetNames'] = list(tnames)

    # убрать лишние узлы p1
    drop = {wd.idx[n] for n in DROP if n in wd.idx}
    remove_nodes(j, drop)
    from body_detail import gc
    gc(g)
    j['asset'].setdefault('extras', {})[TAG] = {'version': 1, 'tris': int(len(F)), 'skirt': int(sk_tri.sum())}
    size = g.save(a.out)
    print(f'→ {a.out}: {size / 1e6:.2f} МБ, вершин {nv}, треуг. {len(F)} (тело {len(body_tris)}, пачка {int(sk_tri.sum())})')


def add_skinned_node(j, name, mesh, extras):
    j['nodes'].append({'name': name, 'mesh': mesh, 'skin': 0, 'extras': extras})
    ni = len(j['nodes']) - 1
    arm = next(i for i, n in enumerate(j['nodes']) if n.get('name') == 'Armature')
    j['nodes'][arm].setdefault('children', []).append(ni)


def remove_nodes(j, drop):
    """удалить узлы (без детей) и перенумеровать ссылки"""
    keep = [i for i in range(len(j['nodes'])) if i not in drop]
    remap = {o: n for n, o in enumerate(keep)}
    for n in j['nodes']:
        if 'children' in n:
            n['children'] = [remap[c] for c in n['children'] if c in remap]
    j['nodes'] = [j['nodes'][i] for i in keep]
    for s in j['scenes']:
        s['nodes'] = [remap[c] for c in s['nodes'] if c in remap]
    for sk in j['skins']:
        sk['joints'] = [remap[c] for c in sk['joints']]
        if 'skeleton' in sk:
            sk['skeleton'] = remap[sk['skeleton']]
    for an in j.get('animations', []):
        for ch in an['channels']:
            ch['target']['node'] = remap[ch['target']['node']]


if __name__ == '__main__':
    main()

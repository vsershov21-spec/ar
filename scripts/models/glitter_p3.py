"""Блёстка p3: сетка Tripo multiview (по развороту продакта 23.11) на скелет, лицо-накладки и мех glitter_p1.

    /tmp/bpyenv/bin/python scripts/models/blender/p3_prep.py tripo.glb /tmp/p3/g.npz --tris 30000
    python3 scripts/models/glitter_p3.py /tmp/p3/g.npz public/models/v2/glitter_p1.glb public/models/v2/glitter_p3.glb [--debug /tmp/p3/dbg]
    python3 scripts/models/colliders.py glitter public/models/v2/glitter_p3.glb public/models/v2/glitter_p3_colliders.json

Шаблон — glitter_p1: скелет (имена, иерархия и поза покоя — байт в байт, клипы, footPin, aliveIdle играют как есть),
накладки лица (EyeBall/LidUp/LidLo/Tear в узлах Eye_*, Brows с разметкой marks, рот шейдером MouthD), материалы рантайма.
Меняется тело: узел тела p1 получает новую сетку (UV и текстура Tripo), BD_FurShell строится заново по цвету меха.

1. Поворот и масштаб: вверх +Y, вперёд — от центра головы к глазам (радужка по цвету текстуры), пол y = 0, высота
   глаз = как у p1.
2. Метки: одни и те же правила на новой сетке и на теле p1 (кончики кистей, сечения рук и ног, стопы), лицо —
   углы глаз, нос, уголки рта (новая — по цвету текстуры, p1 — marks). Сначала подобие с масштабом по осям (МНК), потом
   гладкий сплайн (thin-plate) остатков: суставы новой сетки встают на кости p1, лицо — под накладки p1, а остальная
   форма (голова, худи, пачка, хвост) — как у Tripo.
3. Веса скина — с ближайшей точки поверхности p1 (барицентрически, плотная выборка); пачка — мягко с фатина p1
   (таз/бёдра), хвост — по цепочке Tail1..Tail4, подогнанной под хвост Tripo; голова/уши/бант — по p1 (Head, уши).
4. Морфы рта/щёк/бровей тела p1 (13 ключей, ими двигает кожу рот шейдером) — переносом смещений с ближайшей точки.
5. Нарисованные Tripo глаза и рот закрашиваются мехом вокруг (их место занимают глазные яблоки, веки и MouthD);
   глаза p1 сдвигаются по своей оси так, чтобы выступали из новой поверхности как у p1; Brows и MouthD
   проецируются на новую поверхность с тем же отступом.
6. Пачка Tripo — отдельный меш Skirt_P3 (alpha BLEND, двусторонний), блёстки — из текстуры Tripo.
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


def face_landmarks_tex(V, F, UV, img, eye_y, debug=None):
    """углы глаз, нос и уголки рта новой сетки по цвету текстуры (тексели → 3D через растеризацию UV)"""
    size = 1024
    pos, nrm, tid = raster_uv(V, vnormals(V, F), UV, F, size)
    im = np.asarray(Image.fromarray(img).resize((size, size), Image.BILINEAR)).astype(np.float32)
    cl = color_classes(im)
    has = tid >= 0
    # лицо: перед головы, полоса по высоте вокруг глаз
    front = has & (nrm[..., 2] > 0.25) & (pos[..., 1] > eye_y - 0.16) & (pos[..., 1] < eye_y + 0.07) & (np.abs(pos[..., 0]) < 0.2)
    out = {}
    eye = front & (cl['iris'] | cl['white'] | (cl['dark'] & (pos[..., 1] > eye_y - 0.05)))
    eye &= np.abs(pos[..., 1] - eye_y) < 0.07
    for s, side in ((1, 'L'), (-1, 'R')):
        m = eye & (s * pos[..., 0] > 0.012)
        iris = m & cl['iris']
        if iris.sum() < 30:
            continue
        P = pos[m]
        ic = pos[iris].mean(0)
        P = P[np.linalg.norm(P - ic, axis=1) < 0.075]  # одна связная область вокруг радужки
        ax = s * P[:, 0]
        out[f'eyeOuter{side}'] = P[ax > np.percentile(ax, 98)].mean(0)
        out[f'eyeInner{side}'] = P[ax < np.percentile(ax, 2)].mean(0)
        out[f'eyeBottom{side}'] = P[P[:, 1] < np.percentile(P[:, 1], 2)].mean(0)
        out[f'eyeTop{side}'] = P[P[:, 1] > np.percentile(P[:, 1], 98)].mean(0)
        out[f'iris{side}'] = ic
    if 'irisL' in out and 'irisR' in out:
        ey = (out['irisL'][1] + out['irisR'][1]) / 2
        cx = (out['irisL'][0] + out['irisR'][0]) / 2
        nose = front & cl['pink'] & (np.abs(pos[..., 0] - cx) < 0.04) & (pos[..., 1] < ey) & (pos[..., 1] > ey - 0.08)
        if nose.sum() > 10:
            P = pos[nose]
            out['nose'] = P[P[:, 2] > np.percentile(P[:, 2], 90)].mean(0)
            ny = P[:, 1].min()
            mo = front & (cl['mouth'] | cl['dark'] | (cl['white'] & (pos[..., 1] < ny - 0.01))) & (pos[..., 1] < ny - 0.004) & (pos[..., 1] > ny - 0.1) & (np.abs(pos[..., 0] - cx) < 0.09)
            if mo.sum() > 10:
                P = pos[mo]
                out['mouthL'] = P[P[:, 0] > np.percentile(P[:, 0], 98)].mean(0)
                out['mouthR'] = P[P[:, 0] < np.percentile(P[:, 0], 2)].mean(0)
                out['mouthC'] = P.mean(0)
        if debug:
            dbg = (im * 0.5).astype(np.uint8)
            dbg[eye] = [0, 255, 0]; dbg[nose] = [255, 0, 255]
            if 'mo' in dir():
                dbg[mo] = [255, 0, 0]
            Image.fromarray(dbg).save(os.path.join(debug, 'face_tex.png'))
    return out, (pos, nrm, tid, cl, im)


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
    if cv['iris'][head].sum() > 10:
        hc = V[head].mean(0); ic = V[head & cv['iris']].mean(0)
        dv = ic - hc
        yaw = math.atan2(dv[0], dv[2])  # повернуть так, чтобы dv смотрел в +Z
    else:
        print('радужка по вершинам не найдена — вперёд считаю +Z')
    R = Rot.from_euler('y', -yaw).as_matrix()
    V = V @ R.T
    print(f'поворот вокруг Y: {math.degrees(-yaw):.1f}°')
    # центр по x/z — по стопам; масштаб — высота глаз (или общий рост)
    s0 = H1 / Hn
    V *= s0
    feet = V[:, 1] < 0.04 * H1
    V[:, 0] -= V[feet, 0].mean(); V[:, 2] -= V[feet, 2].mean()
    p1feet = body['P'][body['P'][:, 1] < 0.04 * H1]
    V[:, 0] += p1feet[:, 0].mean(); V[:, 2] += p1feet[:, 2].mean()
    F_ = F
    face = {}
    if not a.no_face:
        face, _ = face_landmarks_tex(V, F_, UV, img, eye1[1], a.debug)
        if 'irisL' in face and 'irisR' in face:
            ey = (face['eyeOuterL'][1] + face['eyeInnerL'][1] + face['eyeOuterR'][1] + face['eyeInnerR'][1]) / 4
            k = eye1[1] / ey
            V *= k
            for kk in face:
                face[kk] = face[kk] * k
            fx = V[feet, 0].mean(); fz = V[feet, 2].mean()
            V[:, 0] += p1feet[:, 0].mean() - fx; V[:, 2] += p1feet[:, 2].mean() - fz
            for kk in face:
                face[kk] = face[kk] + np.array([p1feet[:, 0].mean() - fx, 0, p1feet[:, 2].mean() - fz])
            print(f'масштаб по глазам: ×{k:.3f} (рост {V[:, 1].max():.3f}, у p1 {H1:.3f})')
        else:
            print('лицо по текстуре не найдено:', sorted(face))
    print('рост новой', round(V[:, 1].max(), 4), 'p1', round(H1, 4))

    # ── 2. метки и деформация ──
    Lp = body_landmarks(body['P'], H1, 'p1')
    Ln = body_landmarks(V, H1, 'new')
    pairs = []
    for k in Lp:
        if k in Ln:
            pairs.append((k, Ln[k], Lp[k], 1.0))
    fmap = {'eyeOuterL': 'eyeOuterL', 'eyeInnerL': 'eyeInnerL', 'eyeBottomL': 'eyeBottomL', 'eyeOuterR': 'eyeOuterR',
            'eyeInnerR': 'eyeInnerR', 'eyeBottomR': 'eyeBottomR', 'nose': 'nose', 'mouthL': 'mouthL', 'mouthR': 'mouthR'}
    for k, mk in fmap.items():
        if k in face and mk in marks:
            pairs.append((k, face[k], np.array(marks[mk], float), 2.0))
    for side in 'LR':
        if f'eyeTop{side}' in face:
            t = np.array(marks[f'eyeInner{side}'], float) * 0.5 + np.array(marks[f'eyeOuter{side}'], float) * 0.5
            t[1] = marks[f'eyeTop{side}']
            pairs.append((f'eyeTop{side}', face[f'eyeTop{side}'], t, 2.0))
    names = [p[0] for p in pairs]
    S = np.array([p[1] for p in pairs]); D = np.array([p[2] for p in pairs]); Wt = np.array([p[3] for p in pairs])
    print('метки:', len(pairs), names)
    sc, tr = similarity_axes(S, D, Wt)
    sc = np.clip(sc, 0.85, 1.18)
    sc[1] = 1.0 if face else sc[1]
    V1 = V * sc + tr
    S1 = S * sc + tr
    f = tps_fit(S1, D, a.tps_reg)
    Vw = f(V1)
    disp = np.linalg.norm(Vw - V1, axis=1)
    print(f'масштаб по осям {np.round(sc, 3)}, сплайн: сдвиг медиана {np.median(disp) * 1000:.1f} мм, макс {disp.max() * 1000:.1f} мм')
    for nm, s_, d_ in zip(names, S1, D):
        print(f'  {nm:12s} {np.linalg.norm(s_ - d_) * 1000:6.1f} мм')
    V = Vw
    N = vnormals(V, F)

    np.savez_compressed(os.path.join(a.debug or '/tmp', 'p3_warped.npz'), V=V, F=F, UV=UV)
    build(a, g, wd, body, skirt, jname, marks, V, N, F, UV, img, cv, face)


def build(a, g, wd, body, skirt, jname, marks, V, N, F, UV, img, cv, face):
    j = g.j
    nb = len(jname)
    H1 = body['P'][:, 1].max()
    # ── пачка: мятный/золотой ниже худи, у пояса и бёдер ──
    tc = (cv['mint'] | cv['gold'] | cv['white'])
    lav = cv['lavender']
    waist = np.percentile(V[lav, 1], 3) if lav.any() else 0.38 * H1  # низ худи
    tri_c = tc[F].mean(1) > 0.5
    ty = V[F].mean(1)[:, 1]
    hipsy = wd.p('mixamorig:Hips')[1]
    sk_tri = tri_c & (ty < waist + 0.02) & (ty > hipsy - 0.16)
    # связность: оставить только крупный кусок (а не мятные манжеты)
    print(f'пачка: {sk_tri.sum()} треуг. (низ худи y={waist:.3f})')

    # ── 3. веса ──
    D1 = dense_weights(body['J'], body['W'], nb)
    Ps, tid, bc = surface_samples(body['P'], body['I'], 3e5)
    Ds = (D1[body['I'][tid]] * bc[:, :, None]).sum(1)
    tree = cKDTree(Ps)
    dist, nn = tree.query(V, k=8)
    wq = 1.0 / np.maximum(dist, 1e-4) ** 2
    Dn = (Ds[nn] * wq[:, :, None]).sum(1) / wq.sum(1, keepdims=True)
    # пачка — веса фатина p1 (мягкие: таз/бёдра)
    sk_v = np.zeros(len(V), bool); sk_v[F[sk_tri].ravel()] = True
    if skirt is not None and sk_v.any():
        Dk = dense_weights(skirt['J'], skirt['W'], nb)
        Pk, tk, bk = surface_samples(skirt['P'], skirt['I'], 3e5)
        Dks = (Dk[skirt['I'][tk]] * bk[:, :, None]).sum(1)
        tk_ = cKDTree(Pk)
        dd, nk = tk_.query(V[sk_v], k=8)
        wk = 1.0 / np.maximum(dd, 1e-4) ** 2
        Dn[sk_v] = (Dks[nk] * wk[:, :, None]).sum(1) / wk.sum(1, keepdims=True)
    # хвост: вершины, ближе к хвосту p1, чем к телу, — по цепочке Tail1..4 (проекция на отрезки)
    tail_ids = [jname.index(f'Tail{i}') for i in range(1, 5)]
    tw = Dn[:, tail_ids].sum(1)
    tails = tw > 0.3
    Dn = assign_tail(V, Dn, tails, wd, jname, tail_ids)
    # сглаживание весов по сетке (сшитые швы UV)
    wm = weld_map(V)
    nW = wm.max() + 1
    Ew = wm[edges_of(F)]
    Dw = np.zeros((nW, nb)); cw = np.zeros(nW)
    np.add.at(Dw, wm, Dn); np.add.at(cw, wm, 1); Dw /= cw[:, None]
    Dw = smooth_field(Dw, Ew, nW, 4, 0.5)
    Dn = Dw[wm]
    Jn, Wn = top4(Dn)

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

    # ── 5. текстура: закрасить нарисованные глаза и рот ──
    tex = paint_face(img, V, F, UV, face, marks, a)

    # ── глаза p1: та же глубина над новой поверхностью ──
    fit_face_kit(g, wd, body, V, F, a)

    # ── сборка GLB ──
    write_glb(g, wd, body, a, V, N, F, UV, Jn, Wn, targets, tnames, tex, sk_tri, cv, jname, tails)


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


def paint_face(img, V, F, UV, face, marks, a):
    """нарисованные Tripo глаза (вместе с ресницами) и рот закрасить мехом вокруг → новая картинка a.tex²"""
    size = a.tex
    im = Image.fromarray(img).resize((size, size), Image.LANCZOS)
    arr = np.asarray(im).astype(np.float32)
    if not face:
        return Image.fromarray(arr.astype(np.uint8))
    pos, nrm, tid = raster_uv(V, vnormals(V, F), UV, F, size)
    cl = color_classes(arr)
    has = tid >= 0
    m = np.zeros((size, size), bool)
    for side in 'LR':
        c = (np.array(marks[f'eyeOuter{side}']) + np.array(marks[f'eyeInner{side}'])) / 2
        rx = np.linalg.norm(np.array(marks[f'eyeOuter{side}']) - np.array(marks[f'eyeInner{side}'])) / 2
        r = np.linalg.norm((pos - c) / [rx * 1.55, rx * 1.35, rx * 1.6], axis=-1)
        m |= has & (r < 1) & (nrm[..., 2] > 0)
    mc = (np.array(marks['mouthL']) + np.array(marks['mouthR'])) / 2
    mw = np.linalg.norm(np.array(marks['mouthL']) - np.array(marks['mouthR'])) / 2
    nose_y = marks['nose'][1]
    r = np.linalg.norm((pos - mc) / [mw * 1.35, mw * 1.1, mw * 2.0], axis=-1)
    mouth = has & (r < 1) & (pos[..., 1] < nose_y - 0.012) & (nrm[..., 2] > 0)
    # в области — только «не мех» (радужка, белок, ресницы, рот, зубы); мех вокруг остаётся
    bad = (cl['iris'] | cl['dark'] | cl['white'] | cl['mouth'] | (cl['pink'] & mouth) | ~(cl['fur'] | cl['lavender']))
    mask = (m | mouth) & bad
    mask = np.asarray(Image.fromarray(mask.astype(np.uint8) * 255).filter(ImageFilter.MaxFilter(5))) > 0
    mask &= (m | mouth)
    # закраска по островам UV: мех берём только из текселей той же области поверхности
    fill = inpaint(arr, mask | ~has, it=300)
    out = arr.copy()
    out[mask] = fill[mask]
    # зерно меха поверх закраски (иначе гладкое пятно)
    rng = np.random.default_rng(3)
    noise = rng.normal(0, 4, out.shape).astype(np.float32)
    out[mask] += noise[mask]
    if a.debug:
        dbg = arr.copy(); dbg[mask] = [255, 0, 255]
        Image.fromarray(dbg.astype(np.uint8)).save(os.path.join(a.debug, 'paint_mask.png'))
    print(f'закраска лица: {mask.sum()} текселей')
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))


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


def fit_face_kit(g, wd, body, V, F, a):
    """глаза: та же выступающая глубина, что у p1; Brows и MouthD — на новую поверхность с тем же отступом"""
    j = g.j
    for side in 'LR':
        ni = wd.idx[f'Eye_{side}']
        M = wd.m(ni)
        o = M[:3, 3]; fw = M[:3, :3] @ np.array([0, 0, 1.0]); fw /= np.linalg.norm(fw)
        back = o - fw * 0.15
        t1 = ray_hit(body['P'], body['I'], back, fw)
        t3 = ray_hit(V, F, back, fw)
        if t1 is None or t3 is None:
            print(f'Eye_{side}: луч не попал — не двигаю'); continue
        dz = t3 - t1  # новая поверхность дальше вперёд на dz
        dz = float(np.clip(dz, -0.02, 0.02))
        # сдвиг в системе родителя (Head)
        par = wd.par[ni]
        Pinv = np.linalg.inv(wd.m(par))
        dl = Pinv[:3, :3] @ (fw * dz)
        n = j['nodes'][ni]
        n['translation'] = (np.array(n.get('translation', [0, 0, 0])) + dl).tolist()
        print(f'Eye_{side}: сдвиг вдоль оси глаза {dz * 1000:+.1f} мм')
    # накладки: проекция на новую поверхность (отступ над p1 сохраняется)
    Ps, tid, bc = surface_samples(V, F, 2e6)
    Ns = vnormals(V, F)[F[tid]].mean(1)
    tn = cKDTree(Ps)
    P1s, t1d, b1c = surface_samples(body['P'], body['I'], 2e6)
    t1 = cKDTree(P1s)
    for name in ('Brows', 'MouthD'):
        if name not in wd.idx:
            continue
        ni = wd.idx[name]
        n = j['nodes'][ni]
        M = wd.m(ni)
        pr = j['meshes'][n['mesh']]['primitives'][0]
        P = g.acc(pr['attributes']['POSITION']).astype(np.float64)
        Pw = P @ M[:3, :3].T + M[:3, 3]
        d1, i1 = t1.query(Pw)
        off = d1  # отступ над p1
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
    return L.astype(np.float32)


def write_glb(g, wd, body, a, V, N, F, UV, Jn, Wn, targets, tnames, tex, sk_tri, cv, jname, tails):
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
    body_tris = F[~sk_tri]
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
    if sk_tri.any():
        j['materials'].append({'name': 'Skirt_P3_mat', 'alphaMode': 'BLEND', 'doubleSided': True,
                               'pbrMetallicRoughness': {'baseColorTexture': {'index': bct}, 'baseColorFactor': [1, 1, 1, 0.86], 'metallicFactor': 0.0, 'roughnessFactor': 0.6}})
        sp = {'attributes': dict(attrs), 'indices': g.add_acc(F[sk_tri].ravel().astype(itype[1]), itype[0], 'SCALAR', 34963), 'material': len(j['materials']) - 1}
        j['meshes'].append({'name': 'Skirt_P3', 'primitives': [sp]})
        add_skinned_node(j, 'Skirt_P3', len(j['meshes']) - 1, {'skirtP3': 1})

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

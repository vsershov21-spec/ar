"""Стадия «лицо» поверх готовой модели кота (идемпотентная, без Blender): настоящие 3D-глаза, веки, брови, усы,
мимические ключи (брови, щёки, нахмуренный рот, морщинка у носа) и закраска нарисованных Tripo глаз.

Работает прямо с public/models/<n>_v1.glb (через glb_io): всё, что добавляет, помечено extras.faceStage и при
повторном запуске сначала удаляется — стадию можно гонять сколько угодно раз поверх свежей модели (тело/одежду
меняет другая стадия, их не трогаем). Скелет, поза покоя и скин тела не меняются.

  • Глаза: на каждый глаз узел Eye_L/Eye_R (дочерний к кости Head, ось +Z — вперёд), под ним EyeS_* с масштабом
    эллипсоида (A, B, C) и три меша в «единичном» пространстве: EyeBall_* (сфера с текстурой белок/радужка/зрачок),
    LidUp_* и LidLo_* (оболочки век радиусом 1.07/1.05 с тёмной линией ресниц). Рантайм вращает яблоко (взгляд) и
    веки вокруг оси X (моргание, прищур, смех), блики и размер зрачка — в шейдере (src/character/eyeRig.ts).
    Параметры (углы закрытия, радиус радужки) — в extras узла Eye_*.
  • Брови: накладка Brows (дочерняя к Head) с ключами brow_up / brow_down / brow_sad.
  • Ключи тела (sparse): brow_up/brow_down/brow_sad (мех лба), cheek_up (щёки вверх при улыбке/смехе), frown (уголки
    рта вниз), nose_wrinkle (морщинка над носом); frown/cheek_up — и у накладок Mouth/Blush.
  • Усы: Whiskers — тонкие ленты от морды (дочерние к Head).
  • Старая накладка EyeLids (веки поверх нарисованных глаз) убирается; нарисованные глаза закрашиваются мехом/тенью
    глазницы (цвет — из кольца вокруг, поэтому повторная закраска даёт тот же результат).

Usage: python3 scripts/models/face_detail.py <persona> in.glb out.glb [--preview prefix]
Ориентиры лица — scripts/models/face_landmarks/<persona>.json (координаты Blender: x, глубина y (−y — вперёд), z вверх).
"""
import io, json, math, os, sys
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from glb_io import Glb, raster_uv

TAG = 'faceStage'
VERSION = 1

# насколько открыть глаза относительно нарисованных (доля высоты разреза): Хулиган нарисован прищуренным
OPEN = {'hooligan': 0.45, 'kind': 0.12, 'glitter': 0.12}
# верхнее веко в покое (доля закрытия): Хулиган смотрит чуть свысока
REST_UP = {'hooligan': 0.2, 'kind': 0.06, 'glitter': 0.08}
# радужка: оттенки (sRGB) — обод, середина, светлая часть у зрачка
IRIS = {
    'hooligan': ((22, 74, 34), (58, 150, 62), (150, 214, 92)),
    'kind': ((24, 78, 40), (64, 156, 70), (156, 216, 104)),
    'glitter': ((18, 70, 40), (46, 150, 78), (140, 220, 120)),
}
BROW = {'hooligan': {'dark': 0.52, 'thick': 1.15}, 'kind': {'dark': 0.62, 'thick': 1.0}, 'glitter': {'dark': 0.66, 'thick': 0.8}}


def norm(v):
    v = np.asarray(v, np.float64)
    return v / (np.linalg.norm(v, axis=-1, keepdims=True) + 1e-12)


def srgb2lin(c):
    c = np.clip(np.asarray(c, np.float64), 0, 1)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


# ───────────────────────── GLB: запись, удаление прошлой стадии, сборка мусора ─────────────────────────
class G2(Glb):
    def _encode(self, ii):
        img = self.images[ii]
        buf = io.BytesIO()
        if img.mode == 'RGBA' and img.getextrema()[3][0] < 255:
            img.save(buf, 'PNG', optimize=True)
            self.j['images'][ii]['mimeType'] = 'image/png'
        else:
            img.convert('RGB').save(buf, 'JPEG', quality=self.jpeg_q.get(ii, 90), optimize=True)
            self.j['images'][ii]['mimeType'] = 'image/jpeg'
        return buf.getvalue()

    jpeg_q = {}

    def add_sparse(self, n, disp):
        """sparse-accessor смещений (n вершин, ненулевые — только изменённые)"""
        disp = np.asarray(disp, np.float32)
        idx = np.where(np.abs(disp).max(1) > 1e-7)[0].astype(np.uint32)
        if not len(idx):
            idx = np.array([0], np.uint32)
        vals = disp[idx]
        vi_i = self._raw(idx.tobytes())
        vi_v = self._raw(np.ascontiguousarray(vals).tobytes())
        acc = {'componentType': 5126, 'count': int(n), 'type': 'VEC3',
               'min': np.minimum(vals.min(0), 0).tolist(), 'max': np.maximum(vals.max(0), 0).tolist(),
               'sparse': {'count': int(len(idx)), 'indices': {'bufferView': vi_i, 'componentType': 5125}, 'values': {'bufferView': vi_v}}}
        self.j['accessors'].append(acc)
        return len(self.j['accessors']) - 1

    def _raw(self, data):
        self.j['bufferViews'].append({'buffer': 0, 'byteLength': len(data)})
        vi = len(self.j['bufferViews']) - 1
        self.extra[vi] = data
        return vi


def tagged(o):
    return bool((o or {}).get('extras', {}).get(TAG))


def strip_stage(g):
    """убрать всё, что добавила прошлая стадия (и старую накладку EyeLids), затем собрать мусор"""
    j = g.j
    nodes = j['nodes']
    drop = {i for i, n in enumerate(nodes) if tagged(n) or n.get('name') == 'EyeLids'}
    # поддеревья
    stack = list(drop)
    while stack:
        i = stack.pop()
        for c in nodes[i].get('children', []):
            if c not in drop:
                drop.add(c); stack.append(c)
    # ключи, добавленные к чужим мешам
    for m in j['meshes']:
        ex = m.get('extras', {})
        mine = ex.pop(TAG + 'Targets', None)
        if not mine:
            continue
        names = ex.get('targetNames', [])
        keep = [k for k, nm in enumerate(names) if nm not in mine]
        for p in m['primitives']:
            if 'targets' in p:
                p['targets'] = [p['targets'][k] for k in keep]
                if not p['targets']:
                    del p['targets']
        ex['targetNames'] = [names[k] for k in keep]
        if 'weights' in m:
            m['weights'] = [m['weights'][k] for k in keep if k < len(m['weights'])]
    remap_nodes(g, drop)
    gc(g)
    return len(drop)


def remap_nodes(g, drop):
    j = g.j
    old = j['nodes']
    newidx = {}
    out = []
    for i, n in enumerate(old):
        if i in drop:
            continue
        newidx[i] = len(out)
        out.append(n)
    for n in out:
        if 'children' in n:
            n['children'] = [newidx[c] for c in n['children'] if c in newidx]
            if not n['children']:
                del n['children']
    for s in j.get('scenes', []):
        s['nodes'] = [newidx[c] for c in s['nodes'] if c in newidx]
    for sk in j.get('skins', []):
        sk['joints'] = [newidx[c] for c in sk['joints']]
        if 'skeleton' in sk:
            sk['skeleton'] = newidx[sk['skeleton']]
    for a in j.get('animations', []):
        for ch in a['channels']:
            ch['target']['node'] = newidx[ch['target']['node']]
    j['nodes'] = out


def _tex_refs(obj, fn):
    """все {'index': t} текстур в материале (включая расширения)"""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k.endswith('Texture') and isinstance(v, dict) and 'index' in v:
                v['index'] = fn(v['index'])
            else:
                _tex_refs(v, fn)
    elif isinstance(obj, list):
        for v in obj:
            _tex_refs(v, fn)


def gc(g):
    """выкинуть неиспользуемые меши, материалы, текстуры, картинки, accessors, bufferViews"""
    j = g.j

    def compact(lst, used):
        m = {}
        out = []
        for i, x in enumerate(lst):
            if i in used:
                m[i] = len(out); out.append(x)
        return out, m

    used_m = {n['mesh'] for n in j['nodes'] if 'mesh' in n}
    j['meshes'], mm = compact(j['meshes'], used_m)
    for n in j['nodes']:
        if 'mesh' in n:
            n['mesh'] = mm[n['mesh']]
    used_mat = {p['material'] for m in j['meshes'] for p in m['primitives'] if 'material' in p}
    j['materials'], mmat = compact(j.get('materials', []), used_mat)
    for m in j['meshes']:
        for p in m['primitives']:
            if 'material' in p:
                p['material'] = mmat[p['material']]
    used_t = set()
    _tex_refs(j['materials'], lambda t: (used_t.add(t), t)[1])
    j['textures'], mt = compact(j.get('textures', []), used_t)
    _tex_refs(j['materials'], lambda t: mt[t])
    used_i = {t['source'] for t in j['textures']}
    imgs_old = j.get('images', [])
    j['images'], mi = compact(imgs_old, used_i)
    for t in j['textures']:
        t['source'] = mi[t['source']]
    g.images = {mi[k]: v for k, v in g.images.items() if k in mi}
    g.jpeg_q = {mi[k]: v for k, v in g.jpeg_q.items() if k in mi}
    # accessors
    used_a = set()
    for m in j['meshes']:
        for p in m['primitives']:
            used_a.update(p['attributes'].values())
            if 'indices' in p:
                used_a.add(p['indices'])
            for t in p.get('targets', []):
                used_a.update(t.values())
    for sk in j.get('skins', []):
        if 'inverseBindMatrices' in sk:
            used_a.add(sk['inverseBindMatrices'])
    for a in j.get('animations', []):
        for s in a['samplers']:
            used_a.update([s['input'], s['output']])
    j['accessors'], ma = compact(j['accessors'], used_a)
    for m in j['meshes']:
        for p in m['primitives']:
            p['attributes'] = {k: ma[v] for k, v in p['attributes'].items()}
            if 'indices' in p:
                p['indices'] = ma[p['indices']]
            if 'targets' in p:
                p['targets'] = [{k: ma[v] for k, v in t.items()} for t in p['targets']]
    for sk in j.get('skins', []):
        if 'inverseBindMatrices' in sk:
            sk['inverseBindMatrices'] = ma[sk['inverseBindMatrices']]
    for a in j.get('animations', []):
        for s in a['samplers']:
            s['input'] = ma[s['input']]; s['output'] = ma[s['output']]
    # bufferViews
    used_v = set()
    for a in j['accessors']:
        if 'bufferView' in a:
            used_v.add(a['bufferView'])
        if 'sparse' in a:
            used_v.add(a['sparse']['indices']['bufferView']); used_v.add(a['sparse']['values']['bufferView'])
    for im in j['images']:
        if im.get('bufferView', -1) >= 0:
            used_v.add(im['bufferView'])
    datas = {vi: g.view(vi) for vi in used_v}
    j['bufferViews'], mv = compact(j['bufferViews'], used_v)
    g.extra = {mv[vi]: d for vi, d in datas.items()}
    for a in j['accessors']:
        if 'bufferView' in a:
            a['bufferView'] = mv[a['bufferView']]
        if 'sparse' in a:
            a['sparse']['indices']['bufferView'] = mv[a['sparse']['indices']['bufferView']]
            a['sparse']['values']['bufferView'] = mv[a['sparse']['values']['bufferView']]
    for im in j['images']:
        if im.get('bufferView', -1) >= 0:
            im['bufferView'] = mv[im['bufferView']]


# ───────────────────────── поверхность морды: «луч спереди» ─────────────────────────
class Front:
    """пересечение с лицом лучом вдоль −Z (точка (x, y) в координатах модели: y вверх, z вперёд)"""

    def __init__(self, P, N, UV, I, ymin=0.5):
        c = P[I].mean(1)
        sel = (c[:, 1] > ymin) & (c[:, 2] > -0.02)
        self.P, self.N, self.UV = P, N, UV
        self.T = I[sel]
        self.a = P[self.T[:, 0], :2]; self.b = P[self.T[:, 1], :2]; self.c = P[self.T[:, 2], :2]
        self.bmin = np.minimum(np.minimum(self.a, self.b), self.c) - 1e-6
        self.bmax = np.maximum(np.maximum(self.a, self.b), self.c) + 1e-6

    def hit(self, xy):
        xy = np.atleast_2d(np.asarray(xy, np.float64))
        n = len(xy)
        pos = np.full((n, 3), np.nan); nrm = np.zeros((n, 3)); uv = np.zeros((n, 2))
        for s in range(0, n, 256):
            q = xy[s:s + 256]
            inb = (q[:, None, 0] >= self.bmin[None, :, 0]) & (q[:, None, 0] <= self.bmax[None, :, 0]) & \
                  (q[:, None, 1] >= self.bmin[None, :, 1]) & (q[:, None, 1] <= self.bmax[None, :, 1])
            for k in range(len(q)):
                ti = np.where(inb[k])[0]
                if not len(ti):
                    continue
                a, b, c = self.a[ti], self.b[ti], self.c[ti]
                v0 = b - a; v1 = c - a; v2 = q[k] - a
                den = v0[:, 0] * v1[:, 1] - v1[:, 0] * v0[:, 1]
                den = np.where(np.abs(den) < 1e-14, 1e-14, den)
                l1 = (v2[:, 0] * v1[:, 1] - v1[:, 0] * v2[:, 1]) / den
                l2 = (v0[:, 0] * v2[:, 1] - v2[:, 0] * v0[:, 1]) / den
                l0 = 1 - l1 - l2
                ok = (l0 >= -1e-6) & (l1 >= -1e-6) & (l2 >= -1e-6)
                if not ok.any():
                    continue
                T = self.T[ti[ok]]
                L = np.stack([l0[ok], l1[ok], l2[ok]], 1)
                zs = (L[:, :, None] * self.P[T]).sum(1)
                best = int(np.argmax(zs[:, 2]))
                pos[s + k] = zs[best]
                nn = (L[best][:, None] * self.N[T[best]]).sum(0)
                nrm[s + k] = nn / (np.linalg.norm(nn) + 1e-12)
                uv[s + k] = (L[best][:, None] * self.UV[T[best]]).sum(0)
        return pos, nrm, uv


def sample_tex(img, uv):
    h, w = img.shape[:2]
    x = np.clip((uv[:, 0] % 1) * w, 0, w - 1).astype(int)
    y = np.clip((uv[:, 1] % 1) * h, 0, h - 1).astype(int)
    return img[y, x]


# ───────────────────────── геометрия ─────────────────────────
def grid_faces(nu, nv, base=0, wrap_u=False):
    f = []
    cols = nu if wrap_u else nu - 1
    for j in range(nv - 1):
        for i in range(cols):
            a = base + j * nu + i
            b = base + j * nu + (i + 1) % nu
            f += [(a, b, b + nu), (a, b + nu, a + nu)]
    return f


def orient(V, F, Nv):
    """развернуть треугольники так, чтобы их нормаль смотрела как нормали вершин"""
    F = np.array(F, np.int64)
    a, b, c = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    fn = np.cross(b - a, c - a)
    s = (fn * (Nv[F[:, 0]] + Nv[F[:, 1]] + Nv[F[:, 2]])).sum(1)
    F[s < 0] = F[s < 0][:, [0, 2, 1]]
    return F


def add_mesh(g, name, V, N, F, mat, uv=None, col=None, targets=None):
    attrs = {'POSITION': g.add_acc(np.asarray(V, np.float32), 5126, 'VEC3', 34962),
             'NORMAL': g.add_acc(norm(N).astype(np.float32), 5126, 'VEC3', 34962)}
    if uv is not None:
        attrs['TEXCOORD_0'] = g.add_acc(np.asarray(uv, np.float32), 5126, 'VEC2', 34962)
    if col is not None:
        c = np.asarray(col, np.float32)
        if c.shape[1] == 3:
            c = np.concatenate([c, np.ones((len(c), 1), np.float32)], 1)
        attrs['COLOR_0'] = g.add_acc(c, 5126, 'VEC4', 34962)
    ind = np.asarray(F, np.uint32).reshape(-1)
    ia = g.add_acc(ind.astype(np.uint16) if len(V) < 65536 else ind, 5123 if len(V) < 65536 else 5125, 'SCALAR', 34963)
    prim = {'attributes': attrs, 'indices': ia, 'material': mat}
    mesh = {'name': name, 'primitives': [prim], 'extras': {TAG: VERSION}}
    if targets:
        prim['targets'] = [{'POSITION': g.add_sparse(len(V), d)} for d in targets.values()]
        mesh['extras']['targetNames'] = list(targets.keys())
        mesh['weights'] = [0.0] * len(targets)
    g.j['meshes'].append(mesh)
    return len(g.j['meshes']) - 1


def add_material(g, name, **kw):
    m = {'name': name, 'extras': {TAG: VERSION}, 'pbrMetallicRoughness': {'metallicFactor': 0.0, 'roughnessFactor': kw.get('rough', 0.6)}}
    if 'tex' in kw:
        m['pbrMetallicRoughness']['baseColorTexture'] = {'index': kw['tex']}
    if kw.get('double'):
        m['doubleSided'] = True
    g.j['materials'].append(m)
    return len(g.j['materials']) - 1


def add_node(g, parent, name, mesh=None, t=None, r=None, s=None, extras=None):
    n = {'name': name, 'extras': {TAG: VERSION, **(extras or {})}}
    if mesh is not None:
        n['mesh'] = mesh
    if t is not None:
        n['translation'] = [float(x) for x in t]
    if r is not None:
        n['rotation'] = [float(x) for x in r]
    if s is not None:
        n['scale'] = [float(x) for x in s]
    g.j['nodes'].append(n)
    i = len(g.j['nodes']) - 1
    g.j['nodes'][parent].setdefault('children', []).append(i)
    return i


def mat2quat(R):
    """3×3 (ортонормированная) → кватернион glTF [x, y, z, w]"""
    m = R
    tr = m[0, 0] + m[1, 1] + m[2, 2]
    if tr > 0:
        s = math.sqrt(tr + 1.0) * 2
        w = 0.25 * s; x = (m[2, 1] - m[1, 2]) / s; y = (m[0, 2] - m[2, 0]) / s; z = (m[1, 0] - m[0, 1]) / s
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = math.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        w = (m[2, 1] - m[1, 2]) / s; x = 0.25 * s; y = (m[0, 1] + m[1, 0]) / s; z = (m[0, 2] + m[2, 0]) / s
    elif m[1, 1] > m[2, 2]:
        s = math.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        w = (m[0, 2] - m[2, 0]) / s; x = (m[0, 1] + m[1, 0]) / s; y = 0.25 * s; z = (m[1, 2] + m[2, 1]) / s
    else:
        s = math.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        w = (m[1, 0] - m[0, 1]) / s; x = (m[0, 2] + m[2, 0]) / s; y = (m[1, 2] + m[2, 1]) / s; z = 0.25 * s
    q = np.array([x, y, z, w]); return q / np.linalg.norm(q)


# ───────────────────────── глаза ─────────────────────────
def bl2m(p2):
    """(x, z_blender) → (x, y) модели"""
    return np.asarray(p2, np.float64)


def eye_texture(persona, rx, ry, pr0, S=512):
    """белок, радужка с градиентом и прожилками, зрачок; uv: u = 0.5 + 0.5·X, v = 0.5 − 0.5·Y (единичная сфера спереди)"""
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float64)
    X = (xx + 0.5) / S * 2 - 1
    Y = 1 - (yy + 0.5) / S * 2
    rho = np.hypot(X, Y)
    d = np.hypot(X / rx, Y / ry)  # 1 — край радужки
    ang = np.arctan2(Y / ry, X / rx)
    rim, mid, hi = (np.array(c, np.float64) for c in IRIS[persona])
    # белок: чуть голубоватый к краю, тень сверху (от века)
    scl = np.array([246, 247, 250.0])
    edge = np.array([196, 202, 218.0])
    s_k = smooth(0.35, 1.0, rho)
    sclera = scl * (1 - s_k[..., None]) + edge * s_k[..., None]
    top_sh = smooth(0.0, 0.9, Y) * 0.16
    sclera *= (1 - top_sh)[..., None]
    # радужка
    t = np.clip((d - pr0) / (1 - pr0), 0, 1)
    low = np.clip(-Y / ry * 0.8 + 0.3, 0, 1)  # нижняя половина светлее
    c_in = mid * (1 - low[..., None]) + hi * low[..., None]
    iris = c_in * (1 - t[..., None] ** 1.4) + rim * (t[..., None] ** 1.4)
    rng = np.random.default_rng(7)
    ph = rng.uniform(0, 2 * np.pi, 6)
    streak = sum(np.sin(ang * k + p) for k, p in zip([23, 37, 51, 61, 79, 97], ph)) / 6
    iris *= (1 + 0.12 * streak * smooth(0.0, 0.3, t))[..., None]
    # кольцо-лимб и тень сверху на радужке
    limb = smooth(0.86, 1.0, d)
    iris = iris * (1 - 0.55 * limb[..., None])
    iris *= (1 - 0.25 * smooth(0.2, 1.0, Y / ry))[..., None]
    pupil = np.array([10, 12, 14.0])
    aa = 2.5 / S / min(rx, ry)
    k_p = 1 - smooth(pr0 - aa, pr0 + aa, d)
    k_i = 1 - smooth(1 - aa, 1 + aa, d)
    col = sclera * (1 - k_i[..., None]) + iris * k_i[..., None]
    col = col * (1 - k_p[..., None]) + pupil * k_p[..., None]
    return Image.fromarray(np.clip(col, 0, 255).astype(np.uint8))


def lid_mesh(alphas, th_edge, upper, lashes=None):
    """оболочка века в единичном пространстве глаза: X = r·sinα, (Z, Y) = r·cosα·(cosθ, sinθ)"""
    sgn = 1 if upper else -1
    R = 1.035 if upper else 1.015
    r0 = 1.02 if upper else 1.0  # край верхнего века ложится поверх нижнего — линия ресниц видна и у закрытого глаза
    rows = [(0.0, r0), (0.05, R - (0.006 if upper else 0.006)), (0.12, R), (0.26, R)] + [(x, R) for x in np.linspace(0.44, 2.75, 7)]
    V, N, C = [], [], []
    for (dth, r) in rows:
        for a, te in zip(alphas, th_edge):
            th = te + sgn * dth
            v = np.array([r * math.sin(a), r * math.cos(a) * math.sin(th), r * math.cos(a) * math.cos(th)])
            V.append(v)
            N.append(v / np.linalg.norm(v))
    V = np.array(V); N = np.array(N)
    nu = len(alphas)
    F = grid_faces(nu, len(rows))
    # кромка века: нормаль от яблока к наружной поверхности (закруглённый край)
    lip = np.array([0, sgn * 1.0, 0.25])
    for i in range(nu):
        a = alphas[i]; te = th_edge[i]
        out = N[i]
        tang = np.array([0, math.cos(te), -math.sin(te)]) * sgn  # вверх по веку (от края)
        N[i] = norm(out * 0.4 - tang * 0.9)
    return V, N, F


def build_eyes(g, persona, F, fr, base_lin, head_node, IBM):
    out = {}
    tex_cache = None
    eyes = {}
    for side in ['L', 'R']:
        e = F['eyes'][side]
        top = bl2m(e['top']); bot = bl2m(e['bottom'])
        o = np.argsort(top[:, 0]); top = top[o]; bot = bot[np.argsort(bot[:, 0])]
        c2 = np.array(e['c'])
        p0, n0, _ = fr.hit(c2[None]); p0 = p0[0]; n0 = n0[0]
        f = norm(0.75 * n0 + 0.25 * np.array([0, 0, 1.0]))  # по нормали лица: разрез глаза лежит на скошенной щеке
        r = norm(np.array([1.0, 0, 0]) - f * f[0])
        u = np.cross(f, r)
        R = np.stack([r, u, f], 1)
        T3, _, _ = fr.hit(top); B3, _, _ = fr.hit(bot)
        ok = ~np.isnan(T3[:, 0]) & ~np.isnan(B3[:, 0])
        T3, B3 = T3[ok], B3[ok]
        qt = (T3 - p0) @ R; qb = (B3 - p0) @ R
        H = qt[:, 1] - qb[:, 1]
        # открыть шире нарисованного: верх поднимается больше низа, по профилю sin
        prof = np.sin(np.pi * np.clip((qt[:, 0] - qt[0, 0]) / (qt[-1, 0] - qt[0, 0]), 0, 1)) ** 0.8
        op = OPEN.get(persona, 0.1) * H.max() * prof
        qt[:, 1] += 0.8 * op; qb[:, 1] -= 0.2 * op
        H = qt[:, 1] - qb[:, 1]
        xs = np.concatenate([qt[:, 0], qb[:, 0]])
        x0 = (xs.min() + xs.max()) / 2
        W = xs.max() - xs.min()
        midm = np.abs(qt[:, 0] - x0) < W * 0.2
        z0 = ((qt[midm, 1] + qb[midm, 1]) / 2).mean()
        A = 0.5 * W * 1.18
        B = max(0.5 * H.max() * 1.3, 0.74 * A)
        # глубина яблока C и выступ P: средняя часть разреза должна лежать на яблоке (иначе видна глазница);
        # самые уголки (по 12 %) прячет мех — выступ не больше 0.3·B, иначе глаза навыкате
        C = 0.62 * A
        need = []
        span = qt[-1, 0] - qt[0, 0]
        for q in list(qt) + list(qb):
            u_ = (q[0] - qt[0, 0]) / span
            if u_ < 0.12 or u_ > 0.88:
                continue
            s = min(((q[0] - x0) / A) ** 2 + ((q[1] - z0) / B) ** 2, 0.97)
            need.append(q[2] + 0.001 + C * (1 - math.sqrt(1 - s)))
        P = float(np.clip(max(need), 0.16 * B, 0.3 * B))
        Ol = np.array([x0, z0, P - C])
        O = p0 + R @ Ol
        # углы края век
        def ang(q):
            U = (q - Ol) / np.array([A, B, C])
            Ln = np.linalg.norm(U, axis=1)
            return np.arcsin(np.clip(U[:, 0] / Ln, -1, 1)), np.arctan2(U[:, 1], U[:, 2])
        at, tt = ang(qt); ab, tb = ang(qb)
        a_lo = max(at.min(), ab.min()); a_hi = min(at.max(), ab.max())
        ag = np.concatenate([np.linspace(-1.5, a_lo, 5)[:-1], np.linspace(a_lo, a_hi, 26), np.linspace(a_hi, 1.5, 5)[1:]])
        o1 = np.argsort(at); o2 = np.argsort(ab)
        th_t = np.interp(ag, at[o1], tt[o1]); th_b = np.interp(ag, ab[o2], tb[o2])
        # уголки: края сходятся
        e_lo = (np.interp(a_lo, at[o1], tt[o1]) + np.interp(a_lo, ab[o2], tb[o2])) / 2
        e_hi = (np.interp(a_hi, at[o1], tt[o1]) + np.interp(a_hi, ab[o2], tb[o2])) / 2
        for k, a in enumerate(ag):
            if a < a_lo:
                th_t[k] = th_b[k] = e_lo
            elif a > a_hi:
                th_t[k] = th_b[k] = e_hi
        # сглаживание краёв (нарисованный контур рваный)
        for arr in (th_t, th_b):
            sm = arr.copy()
            for _ in range(3):
                sm[1:-1] = 0.25 * sm[:-2] + 0.5 * sm[1:-1] + 0.25 * sm[2:]
            arr[:] = sm
        inside = (ag >= a_lo) & (ag <= a_hi)
        gap = (th_t - th_b)[inside].max()
        close_up = 0.68 * gap + 0.07
        close_lo = 0.32 * gap + 0.07
        # радужка: физический радиус ~ 0.47 высоты разреза у центра, не меньше 0.4·A
        Hc = H[midm].mean()
        Ri = max(0.5 * Hc * 0.98, 0.42 * A)
        Ri = min(Ri, 0.62 * B)
        eyes[side] = dict(O=O, R=R, A=A, B=B, C=C, ag=ag, th_t=th_t, th_b=th_b, close_up=close_up, close_lo=close_lo,
                          Ri=Ri, p0=p0, P=P, top3=T3, bot3=B3, W=W, H=Hc)
    # общие для пары: текстура глаза
    A_ = np.mean([eyes[s]['A'] for s in eyes]); B_ = np.mean([eyes[s]['B'] for s in eyes])
    Ri = np.mean([eyes[s]['Ri'] for s in eyes])
    rx, ry = Ri / A_, Ri / B_
    pr0 = 0.5
    img = eye_texture(persona, rx, ry, pr0)
    ii = g.add_image(img, 'eye_iris')
    g.j['images'][ii]['extras'] = {TAG: VERSION}
    g.jpeg_q[ii] = 92
    ti = g.add_texture(ii)
    g.j['textures'][ti]['extras'] = {TAG: VERSION}
    m_eye = add_material(g, 'EyeBall_mat', tex=ti, rough=0.12)
    m_lid = add_material(g, 'EyeLid_mat', rough=0.82, double=True)
    # сфера глаза (полюс +Z), uv — ортографическая проекция спереди
    NA_, NP = 32, 20
    V, Nn, UV = [], [], []
    for pi_ in range(NP + 1):
        ph = math.pi * pi_ / NP
        for ai in range(NA_):
            la = 2 * math.pi * ai / NA_
            v = np.array([math.sin(ph) * math.cos(la), math.sin(ph) * math.sin(la), math.cos(ph)])
            V.append(v); Nn.append(v)
            rr = math.sin(min(ph, math.pi / 2))
            UV.append((0.5 + 0.5 * rr * math.cos(la), 0.5 - 0.5 * rr * math.sin(la)))
    V = np.array(V); Nn = np.array(Nn)
    Fb = orient(V, grid_faces(NA_, NP + 1, wrap_u=True), Nn)
    m_ball = add_mesh(g, 'EyeBall', V, Nn, Fb, m_eye, uv=np.array(UV))
    IR = IBM[:3, :3]; It = IBM[:3, 3]
    for side, E in eyes.items():
        # цвет меха над и под глазом (линейный)
        up_pts = E['top3'][:, :2] + np.array([0, 0.012])
        lo_pts = E['bot3'][:, :2] - np.array([0, 0.010])
        cu = np.median(sample_tex(base_lin, fr.hit(up_pts[::3])[2]), 0)
        cl = np.median(sample_tex(base_lin, fr.hit(lo_pts[::3])[2]), 0)
        lash = np.array([0.012, 0.012, 0.02])
        # верхнее веко
        V, Nl, Fl = lid_mesh(E['ag'], E['th_t'], True)
        nu = len(E['ag'])
        col = np.zeros((len(V), 3))
        for j in range(len(V) // nu):
            k = [1.0, 0.92, 0.45, 0.0][j] if j < 4 else 0.0
            col[j * nu:(j + 1) * nu] = lash * k + cu * (1 - k) * 0.97
        extraV, extraF, extraC, extraN = [], [], [], []
        if persona == 'glitter':
            # ресницы у внешнего уголка: три загнутых лепестка
            outer = 1 if side == 'L' else -1
            for k, (a_rel, ln, lift) in enumerate([(0.55, 0.42, 0.2), (0.72, 0.5, 0.05), (0.88, 0.44, -0.12)]):
                ai = np.argmin(np.abs(E['ag'] - outer * a_rel * E['ag'].max()))
                a = E['ag'][ai]; te = E['th_t'][ai]
                base = len(V) + len(extraV)
                pts = []
                for s in np.linspace(0, 1, 6):
                    th = te + 0.05 + s * 0.35
                    r = 1.07 + s * ln * 0.55
                    aa = a + outer * s * (0.25 + lift)
                    p = np.array([r * math.sin(aa), r * math.cos(aa) * math.sin(th), r * math.cos(aa) * math.cos(th)])
                    p[1] += s * s * ln * 0.25  # загиб вверх
                    pts.append(p)
                pts = np.array(pts)
                for si, p in enumerate(pts):
                    w = 0.07 * (1 - si / 5) + 0.008
                    tng = pts[min(si + 1, 5)] - pts[max(si - 1, 0)]
                    side_v = norm(np.cross(tng, p))
                    extraV += [p - side_v * w, p + side_v * w]
                    extraN += [norm(p), norm(p)]
                    extraC += [lash, lash]
                for si in range(5):
                    a0 = base + si * 2
                    extraF += [(a0, a0 + 1, a0 + 3), (a0, a0 + 3, a0 + 2)]
        if extraV:
            V = np.concatenate([V, np.array(extraV)]); Nl = np.concatenate([Nl, np.array(extraN)])
            col = np.concatenate([col, np.array(extraC)]); Fl = list(Fl) + extraF
        Fl = orient(V, Fl, Nl)
        m_up = add_mesh(g, f'LidUp_{side}', V, Nl, Fl, m_lid, col=col)
        V2, N2, F2 = lid_mesh(E['ag'], E['th_b'], False)
        col2 = np.zeros((len(V2), 3))
        for j in range(len(V2) // nu):
            k = [0.55, 0.35, 0.1, 0.0][j] if j < 4 else 0.0
            col2[j * nu:(j + 1) * nu] = lash * k + cl * (1 - k)
        F2 = orient(V2, F2, N2)
        m_lo = add_mesh(g, f'LidLo_{side}', V2, N2, F2, m_lid, col=col2)
        # узлы: Eye_* (центр и оси глаза в пространстве кости Head) → EyeS_* (масштаб) → яблоко, веки
        Rl = IR @ E['R']
        tl = IR @ E['O'] + It
        ex = {'side': side, 'A': E['A'], 'B': E['B'], 'C': E['C'], 'closeUp': E['close_up'], 'closeLo': E['close_lo'],
              'irisUV': [0.5 * rx, 0.5 * ry], 'pupil': pr0, 'persona': persona, 'restUp': REST_UP.get(persona, 0.05)}
        ne = add_node(g, head_node, f'Eye_{side}', t=tl, r=mat2quat(Rl), extras=ex)
        ns = add_node(g, ne, f'EyeS_{side}', s=[E['A'], E['B'], E['C']])
        add_node(g, ns, f'EyeBall_{side}', mesh=m_ball)
        add_node(g, ns, f'LidUp_{side}', mesh=m_up)
        add_node(g, ns, f'LidLo_{side}', mesh=m_lo)
        print(f'  глаз {side}: P={E["P"]/E["B"]:.2f}B A={E["A"]:.4f} B={E["B"]:.4f} C={E["C"]:.4f} закрытие {E["close_up"]:.2f}/{E["close_lo"]:.2f} радужка {E["Ri"]:.4f}')
    return eyes


# ───────────────────────── брови ─────────────────────────
def build_brows(g, persona, F, fr, base_lin, eyes, head_node, IBM):
    cfg = BROW.get(persona, BROW['kind'])
    V, Nn, C, Fs = [], [], [], []
    keys = {'brow_up': [], 'brow_down': [], 'brow_sad': []}
    NU, NV = 18, 5
    colors = []
    for side, E in eyes.items():
        top = E['top3']
        W = E['W']; s = W / 0.085
        inner = -1 if side == 'L' else 1  # к переносице
        xs = top[:, 0]; ys = top[:, 1]
        # плавная дуга: парабола по контуру верха глаза
        cf = np.polyfit(xs, ys, 2)
        x_in = xs.max() if inner > 0 else xs.min()
        x_out = xs.min() if inner > 0 else xs.max()
        x_in -= inner * -0.004 * s  # чуть ближе к переносице
        lift = 0.55 * E['B'] + 0.010 * s
        T0 = 0.0062 * s * cfg['thick']
        fur = []
        base = len(V)
        allpts = {k: [] for k in ['base', *keys]}
        for j in range(NV):
            v = -1 + 2 * j / (NV - 1)
            for i in range(NU):
                t = i / (NU - 1)  # 0 — внутренний конец, 1 — внешний
                x = x_in + (x_out - x_in) * (0.08 + 0.92 * t)
                y = np.polyval(cf, x) + lift + 0.004 * s * math.sin(math.pi * t) - 0.002 * s * t
                th = T0 * (min(1.0, t / 0.12) ** 0.5) * (1 - t) ** 0.75 + 0.0006
                # поперёк дуги
                dy = np.polyval(np.polyder(cf), x)
                nrm2 = norm(np.array([-dy, 1.0]))
                p = np.array([x, y]) + nrm2 * v * th / 2
                allpts['base'].append(p)
                wi = (1 - t) ** 1.3
                allpts['brow_up'].append(p + np.array([inner * 0.0015 * s * wi, 0.012 * s * (1 - 0.3 * t)]))
                allpts['brow_down'].append(p + np.array([inner * 0.004 * s * wi, -0.009 * s * wi - 0.0015 * s]))
                allpts['brow_sad'].append(p + np.array([inner * 0.002 * s * wi, 0.011 * s * wi - 0.004 * s * t ** 1.5]))
                C.append((v, t))
        pos = {}
        for k, pts in allpts.items():
            P3, N3, UV3 = fr.hit(np.array(pts))
            pos[k] = P3 + N3 * 0.0016
            if k == 'base':
                Nn += list(N3)
                furc = sample_tex(base_lin, UV3)
        for k in keys:
            keys[k] += list(pos[k] - pos['base'])
        V += list(pos['base'])
        dark = furc * cfg['dark']
        for idx, (v, t) in enumerate(C[-NU * NV:]):
            k = (1 - abs(v)) ** 0.8
            fur.append(dark[idx] * k + furc[idx] * (1 - k))
        colors += fur
        Fs += grid_faces(NU, NV, base)
    V = np.array(V); Nn = np.array(Nn)
    Fs = orient(V, Fs, Nn)
    IR = IBM[:3, :3]; It = IBM[:3, 3]
    Vl = V @ IR.T + It
    Nl = Nn @ IR.T
    tg = {k: np.array(d) @ IR.T for k, d in keys.items()}
    mat = add_material(g, 'Brows_mat', rough=0.85)
    mi = add_mesh(g, 'Brows', Vl, Nl, Fs, mat, col=np.array(colors), targets=tg)
    add_node(g, head_node, 'Brows', mesh=mi)
    print(f'  брови: {len(V)} вершин')


# ───────────────────────── усы ─────────────────────────
def build_whiskers(g, persona, F, fr, head_node, IBM):
    m = F['mouth']; nose = F['nose']
    mw = abs(m['left'][0] - m['right'][0]); s = mw / 0.13
    ny = nose['c'][1]; my = m['center'][1]
    V, Nn, Fs, C = [], [], [], []
    for sg in (1, -1):
        for k, (ang, ln, dy) in enumerate([(0.2, 1.0, 0.004), (0.02, 1.1, 0.0), (-0.17, 0.95, -0.004)]):
            rx = sg * (0.36 * mw + 0.004 * s)
            ry = (ny + my) / 2 + dy * s
            P3, N3, _ = fr.hit(np.array([[rx, ry]]))
            p = P3[0] - N3[0] * 0.0012
            L = 0.085 * s * ln
            d = norm(np.array([sg * math.cos(ang), math.sin(ang), 0.32]))
            base = len(V)
            pts = []
            for t in np.linspace(0, 1, 9):
                q = p + d * L * t + np.array([0, -0.18 * L * t * t, -0.05 * L * t * t])
                pts.append(q)
            pts = np.array(pts)
            for i, q in enumerate(pts):
                t = i / 8
                tng = norm(pts[min(i + 1, 8)] - pts[max(i - 1, 0)])
                side_v = norm(np.cross(tng, np.array([0, 0, 1.0])))
                w = 0.0011 * s * (1 - t) ** 0.7 + 0.00015
                V += [q - side_v * w, q + side_v * w]
                Nn += [np.array([0, 0, 1.0])] * 2
                c = np.array([0.93, 0.93, 0.96]) * (0.85 + 0.15 * t)
                C += [c, c]
            for i in range(8):
                a = base + i * 2
                Fs += [(a, a + 1, a + 3), (a, a + 3, a + 2)]
    V = np.array(V); Nn = np.array(Nn)
    Fs = orient(V, Fs, Nn)
    IR = IBM[:3, :3]; It = IBM[:3, 3]
    mat = add_material(g, 'Whiskers_mat', rough=0.35, double=True)
    mi = add_mesh(g, 'Whiskers', V @ IR.T + It, Nn @ IR.T, Fs, mat, col=srgb2lin(np.array(C)))
    add_node(g, head_node, 'Whiskers', mesh=mi)


# ───────────────────────── мимика тела (поле смещений) ─────────────────────────
def fields(F, eyes):
    """имя ключа → функция P (n,3) → смещения (n,3) в координатах модели"""
    m = F['mouth']; nose = F['nose']
    ML = np.array(m['line']); ML = ML[np.argsort(ML[:, 0])]
    mw = abs(m['left'][0] - m['right'][0]); s = mw / 0.13
    ny = nose['c'][1]; ntop = nose['top'][1]

    def g2(P, c, rx, ry):
        return np.exp(-(((P[:, 0] - c[0]) / rx) ** 2 + ((P[:, 1] - c[1]) / ry) ** 2))

    def brow_up(P):
        d = np.zeros_like(P)
        for side, E in eyes.items():
            c = (E['O'][0], E['top3'][:, 1].max() + 0.6 * E['B'] + 0.008 * s)
            w = g2(P, c, 0.05 * s, 0.032 * s)
            d[:, 1] += 0.006 * s * w
        return d

    def brow_down(P):
        d = np.zeros_like(P)
        for side, E in eyes.items():
            inner = -1 if side == 'L' else 1
            c = (E['O'][0] + inner * 0.25 * E['W'], E['top3'][:, 1].max() + 0.5 * E['B'] + 0.005 * s)
            w = g2(P, c, 0.035 * s, 0.022 * s)
            d[:, 1] -= 0.0045 * s * w
            d[:, 0] += inner * 0.0015 * s * w
        return d

    def brow_sad(P):
        d = np.zeros_like(P)
        for side, E in eyes.items():
            inner = -1 if side == 'L' else 1
            c = (E['O'][0] + inner * 0.3 * E['W'], E['top3'][:, 1].max() + 0.5 * E['B'] + 0.006 * s)
            w = g2(P, c, 0.03 * s, 0.022 * s)
            d[:, 1] += 0.005 * s * w
        return d

    def cheek_up(P):
        d = np.zeros_like(P)
        for side, E in eyes.items():
            c = (E['O'][0] * 1.05, E['bot3'][:, 1].min() - 0.03 * s)
            w = g2(P, c, 0.042 * s, 0.026 * s)
            d[:, 1] += 0.0045 * s * w
            d[:, 2] += 0.003 * s * w
        return d

    def frown(P):
        d = np.zeros_like(P)
        for corner in (m['left'], m['right']):
            w = g2(P, corner, 0.4 * mw, 0.35 * mw)
            d[:, 1] -= 0.12 * mw * w
        # нижняя губа чуть вверх-вперёд (надутость)
        w = g2(P, (m['center'][0], m['center'][1] - 0.18 * mw), 0.3 * mw, 0.2 * mw)
        d[:, 1] += 0.025 * mw * w; d[:, 2] += 0.03 * mw * w
        return d

    def nose_wrinkle(P):
        d = np.zeros_like(P)
        c = (nose['c'][0], ntop + 0.016 * s)
        w = g2(P, c, 0.026 * s, 0.016 * s)
        d[:, 1] -= 0.003 * s * w
        d[:, 2] += 0.0015 * s * w
        w2 = g2(P, (nose['c'][0], ny), 0.02 * s, 0.012 * s)
        d[:, 1] += 0.0018 * s * w2  # нос чуть вверх
        return d

    return {'brow_up': brow_up, 'brow_down': brow_down, 'brow_sad': brow_sad, 'cheek_up': cheek_up, 'frown': frown, 'nose_wrinkle': nose_wrinkle}


def add_body_keys(g, fields_, head_j):
    """ключи тела (только лицо: вес кости Head, перед головы) + frown/cheek_up у накладок Mouth и Blush"""
    j = g.j
    for mi, mesh in enumerate(j['meshes']):
        if tagged(mesh):
            continue
        pr = mesh['primitives'][0]
        A = pr['attributes']
        name = mesh.get('name', '')
        is_main = mi == g.main_mesh()[0]
        if not is_main and name not in ('Mouth', 'Blush'):
            continue
        P = g.acc(A['POSITION']).astype(np.float64)
        Jt = g.acc(A['JOINTS_0']); Wt = g.acc(A['WEIGHTS_0']).astype(np.float64)
        hw = (Wt * (Jt == head_j)).sum(1)
        front = np.clip((P[:, 2] - 0.02) / 0.06, 0, 1)
        mask = hw * front if is_main else np.ones(len(P))
        want = list(fields_) if is_main else (['frown'] if name == 'Mouth' else ['cheek_up'])
        names = mesh.setdefault('extras', {}).setdefault('targetNames', [])
        mine = []
        for k in want:
            d = fields_[k](P) * mask[:, None]
            if np.abs(d).max() < 1e-6:
                continue
            pr.setdefault('targets', []).append({'POSITION': g.add_sparse(len(P), d)})
            names.append(k); mine.append(k)
            if 'weights' in mesh:
                mesh['weights'].append(0.0)
        mesh['extras'][TAG + 'Targets'] = mine
        print(f'  ключи {name[:20]}: {mine}')


# ───────────────────────── закраска нарисованных глаз ─────────────────────────
def paint_eyes(g, persona, F, eyes, P, N, UV, I, fr):
    mi, pr = g.main_mesh()
    mat = g.j['materials'][pr['material']]
    tsrc = lambda t: g.j['textures'][t['index']]['source']
    i_base = tsrc(mat['pbrMetallicRoughness']['baseColorTexture'])
    i_rm = tsrc(mat['pbrMetallicRoughness']['metallicRoughnessTexture'])
    i_n = tsrc(mat['normalTexture'])
    base = np.asarray(g.image(i_base).convert('RGB')).astype(np.float32)
    S = base.shape[0]
    key = f'/tmp/face_detail_{persona}_{S}_{len(P)}_{float(np.abs(P).sum()):.4f}.npz'
    if os.path.exists(key):
        d = np.load(key); pos, tid = d['pos'], d['tid']
    else:
        pos, nrm, tid = raster_uv(P, N, UV, I, S)
        np.savez_compressed(key, pos=pos, tid=tid)
    has = tid >= 0
    region = np.zeros(base.shape[:2], np.float32)
    socket = np.zeros(base.shape[:2], np.float32)
    ring_c, ring_p = [], []
    px, py, pz = pos[..., 0], pos[..., 1], pos[..., 2]
    for side in ['L', 'R']:
        e = F['eyes'][side]
        top = np.array(e['top']); bot = np.array(e['bottom'])
        top = top[np.argsort(top[:, 0])]; bot = bot[np.argsort(bot[:, 0])]
        x0, x1 = top[0, 0], top[-1, 0]
        W = x1 - x0
        m = 0.004 * W / 0.085
        mt = (0.014 if persona == 'glitter' else 0.005) * W / 0.085
        near = has & (px > x0 - 3 * mt) & (px < x1 + 3 * mt) & (py > bot[:, 1].min() - 0.03) & (py < top[:, 1].max() + 0.04)
        # только передняя поверхность: глубина как у луча спереди
        idx = np.where(near)
        fpos, _, _ = fr.hit(np.stack([px[idx], py[idx]], 1))
        front = np.abs(fpos[:, 2] - pz[idx]) < 0.004
        yy, xx = idx[0][front], idx[1][front]
        X, Y = px[yy, xx], py[yy, xx]
        xc = np.clip(X, x0, x1)
        tz = np.interp(xc, top[:, 0], top[:, 1]); bz = np.interp(xc, bot[:, 0], bot[:, 1])
        dx = np.maximum(x0 - X, X - x1)
        # расстояние «за контур»: >0 — снаружи
        out_top = Y - tz; out_bot = bz - Y
        dout = np.maximum(np.maximum(out_top, out_bot), dx)
        # область: контур + поле m (у Блёстки — сверху и снаружи шире: нарисованные ресницы)
        outer_sgn = 1 if side == 'L' else -1
        lim = np.where(out_top > 0, mt, m)
        lim = np.where((dx > 0) & (np.sign(X - (x0 + x1) / 2) == outer_sgn), mt, lim)
        r_in = dout < lim
        k = 1 - smooth(lim * 0.7, lim, dout)
        region[yy[r_in], xx[r_in]] = np.maximum(region[yy[r_in], xx[r_in]], k[r_in])
        socket[yy, xx] = np.maximum(socket[yy, xx], 1 - smooth(-0.002, 0.0015, dout))
        ring = (dout > lim * 1.15) & (dout < lim * 1.15 + 0.006)
        ring_c.append(base[yy[ring], xx[ring]]); ring_p.append(np.stack([X[ring], Y[ring]], 1))
    ring_c = np.concatenate(ring_c); ring_p = np.concatenate(ring_p)
    # медианный фильтр кольца (выкинуть тёмные пятна ресниц/контура)
    lum = ring_c.mean(1)
    okr = lum > np.percentile(lum, 25)
    ring_c, ring_p = ring_c[okr], ring_p[okr]
    yy, xx = np.where(region > 0)
    q = np.stack([px[yy, xx], py[yy, xx]], 1)
    fill = np.zeros((len(q), 3))
    for s0 in range(0, len(q), 2048):
        d2 = ((q[s0:s0 + 2048, None, :] - ring_p[None, :, :]) ** 2).sum(-1)
        w = 1 / (d2 + 1e-6) ** 1.5
        fill[s0:s0 + 2048] = (w[..., None] * ring_c[None]).sum(1) / w.sum(1, keepdims=True)
    sk = socket[yy, xx]
    fill *= (1 - 0.3 * sk)[:, None]
    k = region[yy, xx][:, None]
    base[yy, xx] = base[yy, xx] * (1 - k) + fill * k
    g.set_image(i_base, Image.fromarray(np.clip(base, 0, 255).astype(np.uint8)))
    g.jpeg_q[i_base] = 92
    rm = np.asarray(g.image(i_rm).convert('RGB')).astype(np.float32)
    rm[yy, xx, 1] = rm[yy, xx, 1] * (1 - k[:, 0]) + 205 * k[:, 0]
    rm[yy, xx, 2] = rm[yy, xx, 2] * (1 - k[:, 0])
    g.set_image(i_rm, Image.fromarray(rm.astype(np.uint8)))
    nm = np.asarray(g.image(i_n).convert('RGB')).astype(np.float32)
    nm[yy, xx] = nm[yy, xx] * (1 - k) + np.array([128, 128, 255.0]) * k
    g.set_image(i_n, Image.fromarray(nm.astype(np.uint8)))
    print(f'  закраска глаз: {len(yy)} текселей')


def main():
    persona, src, dst = sys.argv[1:4]
    F = json.load(open(os.path.join(HERE, 'face_landmarks', f'{persona}.json')))
    g = G2(src)
    n0 = strip_stage(g)
    if n0:
        print(f'  убрано от прошлой стадии/старых век: {n0} узлов')
    j = g.j
    mi, pr = g.main_mesh()
    A = pr['attributes']
    P = g.acc(A['POSITION']).astype(np.float64)
    N = g.acc(A['NORMAL']).astype(np.float64)
    UV = g.acc(A['TEXCOORD_0']).astype(np.float64)
    I = g.acc(pr['indices']).reshape(-1, 3).astype(np.int64)
    head_node = next(i for i, n in enumerate(j['nodes']) if n.get('name') == 'mixamorig:Head')
    sk = j['skins'][0]
    head_j = sk['joints'].index(head_node)
    IBM = g.acc(sk['inverseBindMatrices']).reshape(-1, 4, 4)[head_j].T.astype(np.float64)
    fr = Front(P, N, UV, I)
    mat = j['materials'][pr['material']]
    i_base = j['textures'][mat['pbrMetallicRoughness']['baseColorTexture']['index']]['source']
    base_img = np.asarray(g.image(i_base).convert('RGB')).astype(np.float64) / 255
    base_lin = srgb2lin(base_img)
    eyes = build_eyes(g, persona, F, fr, base_lin, head_node, IBM)
    build_brows(g, persona, F, fr, base_lin, eyes, head_node, IBM)
    build_whiskers(g, persona, F, fr, head_node, IBM)
    add_body_keys(g, fields(F, eyes), head_j)
    paint_eyes(g, persona, F, eyes, P, N, UV, I, fr)
    j.setdefault('asset', {}).setdefault('extras', {})[TAG] = VERSION
    total = g.save(dst)
    print(f'{persona}: → {dst} {total / 1e6:.2f} MB')


if __name__ == '__main__':
    main()

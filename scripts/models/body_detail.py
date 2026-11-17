"""Стадия «тело и одежда» (всё ниже головы): лапы, мех по силуэту, хвост, детали одежды. Идемпотентна.

Применяется к ТЕКУЩЕМУ GLB из main (лицо делает другая стадия — его не трогаем):
  python3 scripts/models/body_detail.py <persona> public/models/<n>_v1.glb public/models/<n>_v1.glb

Что делает:
  1. Удаляет всё своё прошлое (узлы/меши/материалы/картинки с префиксом BD_) и собирает мусор в буфере.
  2. Атлас (общий с лицом): тексели, где вершины треугольника принадлежат голове (кости Head/уши/глаза),
     и картинки, которых мы не касаемся, остаются как в main; тексели тела пересчитываются ЗАНОВО от чистой базы
     (cat_look от facew/<n>_face.glb, 2048 px) — поэтому повторный запуск даёт тот же результат.
     Атлас поднимается до 2048 (голова — апскейл текущих текселей main, без потерь).
  3. Добавляет меши BD_*: подушечки лап, наконечники шнурков, кнопка кепки, кисточки шарфа и т.п.,
     со скином по ближайшей вершине тела. Поза покоя и имена 65 костей не меняются.
  4. BD_FurShell — подмножество треугольников меха (руки, ноги, хвост) поверх тех же accessors тела
     + атрибут _FURLEN; оболочки меха строит рантайм (src/character/furShell.ts).

База: python3 scripts/models/cat_look.py <n> ~/facew/<n>_face.glb /tmp/bd/<n>_look2048.glb  (делается сама, если нет)
"""
import io, os, sys, json, hashlib, subprocess
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from glb_io import Glb, raster_uv  # noqa: E402
from cat_look import vnoise, grad3, tri_tangents, smoothstep  # noqa: E402

PFX = 'BD_'
S = 2048
FACEW = os.environ.get('FACEW', '/home/claude/facew')
HEAD_BONES = {'Head', 'HeadTop_End', 'LeftEar1', 'RightEar1', 'Jaw', 'LeftEye', 'RightEye'}


# ───────────────────────── GLB: удалить своё и собрать мусор ─────────────────────────
def _tex_refs(o, out):
    """все {'index': t} в материале (включая расширения)"""
    if isinstance(o, dict):
        for k, v in o.items():
            if isinstance(v, dict) and 'index' in v and k.lower().endswith('texture'):
                out.append(v)
            _tex_refs(v, out)
    elif isinstance(o, list):
        for v in o:
            _tex_refs(v, out)


def prune_own(g):
    j = g.j
    # материал тела мог получить нашу карту эмиссии — снять
    for m in j.get('materials', []):
        et = m.get('emissiveTexture')
        if et is not None:
            img = j['images'][j['textures'][et['index']]['source']]
            if img.get('name', '').startswith(PFX):
                m.pop('emissiveTexture'); m.pop('emissiveFactor', None)
    # узлы
    dead = {i for i, n in enumerate(j['nodes']) if n.get('name', '').startswith(PFX)}
    keep = [i for i in range(len(j['nodes'])) if i not in dead]
    nmap = {o: k for k, o in enumerate(keep)}
    nodes = []
    for i in keep:
        n = j['nodes'][i]
        if 'children' in n:
            n['children'] = [nmap[c] for c in n['children'] if c in nmap]
            if not n['children']:
                n.pop('children')
        nodes.append(n)
    j['nodes'] = nodes
    for sc in j.get('scenes', []):
        sc['nodes'] = [nmap[c] for c in sc['nodes'] if c in nmap]
    for sk in j.get('skins', []):
        sk['joints'] = [nmap[c] for c in sk['joints']]
        if 'skeleton' in sk:
            sk['skeleton'] = nmap[sk['skeleton']]
    for an in j.get('animations', []):
        an['channels'] = [c for c in an['channels'] if c['target'].get('node') in nmap]
        for c in an['channels']:
            c['target']['node'] = nmap[c['target']['node']]
    gc(g)


def gc(g):
    j = g.j

    def remap(used, arr_key):
        used = sorted(used)
        m = {o: k for k, o in enumerate(used)}
        j[arr_key] = [j[arr_key][o] for o in used]
        return m

    mesh_used = {n['mesh'] for n in j['nodes'] if 'mesh' in n}
    mm = remap(mesh_used, 'meshes')
    for n in j['nodes']:
        if 'mesh' in n:
            n['mesh'] = mm[n['mesh']]
    mat_used = {p['material'] for m in j['meshes'] for p in m['primitives'] if 'material' in p}
    mtm = remap(mat_used, 'materials')
    for m in j['meshes']:
        for p in m['primitives']:
            if 'material' in p:
                p['material'] = mtm[p['material']]
    refs = []
    _tex_refs(j['materials'], refs)
    tm = remap({r['index'] for r in refs}, 'textures')
    for r in refs:
        r['index'] = tm[r['index']]
    img_used = {t['source'] for t in j['textures'] if 'source' in t}
    old_imgs = dict(g.images)
    im = remap(img_used, 'images')
    g.images = {im[o]: v for o, v in old_imgs.items() if o in im}
    for t in j['textures']:
        t['source'] = im[t['source']]
    if j.get('samplers'):
        sm = remap({t.get('sampler', 0) for t in j['textures']} | {0}, 'samplers')
        for t in j['textures']:
            if 'sampler' in t:
                t['sampler'] = sm[t['sampler']]
    acc_used = set()
    for m in j['meshes']:
        for p in m['primitives']:
            acc_used |= set(p['attributes'].values())
            if 'indices' in p:
                acc_used.add(p['indices'])
            for t in p.get('targets', []):
                acc_used |= set(t.values())
    for sk in j.get('skins', []):
        if 'inverseBindMatrices' in sk:
            acc_used.add(sk['inverseBindMatrices'])
    for an in j.get('animations', []):
        for s in an['samplers']:
            acc_used |= {s['input'], s['output']}
    am = remap(acc_used, 'accessors')
    for m in j['meshes']:
        for p in m['primitives']:
            p['attributes'] = {k: am[v] for k, v in p['attributes'].items()}
            if 'indices' in p:
                p['indices'] = am[p['indices']]
            p['targets'] = [{k: am[v] for k, v in t.items()} for t in p.get('targets', [])]
            if not p['targets']:
                p.pop('targets')
    for sk in j.get('skins', []):
        if 'inverseBindMatrices' in sk:
            sk['inverseBindMatrices'] = am[sk['inverseBindMatrices']]
    for an in j.get('animations', []):
        for s in an['samplers']:
            s['input'] = am[s['input']]; s['output'] = am[s['output']]
    an_s = [an for an in j.get('animations', [])]
    for an in an_s:  # сэмплеры без каналов не чистим — анимаций в моделях персонажей нет
        pass
    bv_used = {a['bufferView'] for a in j['accessors'] if 'bufferView' in a}
    for a in j['accessors']:  # sparse (морфы лица)
        if 'sparse' in a:
            bv_used |= {a['sparse']['indices']['bufferView'], a['sparse']['values']['bufferView']}
    bv_used |= {i['bufferView'] for i in j['images'] if i.get('bufferView', -1) >= 0}
    data = {vi: g.view(vi) for vi in bv_used}
    bm = remap(bv_used, 'bufferViews')
    g.extra = {bm[o]: d for o, d in data.items()}
    for a in j['accessors']:
        if 'bufferView' in a:
            a['bufferView'] = bm[a['bufferView']]
        if 'sparse' in a:
            for k in ('indices', 'values'):
                a['sparse'][k]['bufferView'] = bm[a['sparse'][k]['bufferView']]
    for i in j['images']:
        if i.get('bufferView', -1) >= 0:
            i['bufferView'] = bm[i['bufferView']]


def save(g, path, jpeg):
    """как Glb.save, но заменённые картинки — JPEG/PNG по словарю jpeg {image: (size, quality|None)}"""
    j = g.j
    enc = {}
    for ii, img in g.images.items():
        size, q = jpeg.get(ii, (None, None))
        if size and max(img.size) != size:
            img = img.resize((size, size), Image.LANCZOS)
        b = io.BytesIO()
        if q:
            img.convert('RGB').save(b, 'JPEG', quality=q, optimize=True)
            j['images'][ii]['mimeType'] = 'image/jpeg'
        else:
            img.save(b, 'PNG', optimize=True)
            j['images'][ii]['mimeType'] = 'image/png'
        enc[ii] = b.getvalue()
    for ii, im in enumerate(j['images']):
        if im.get('bufferView', -1) == -1:
            j['bufferViews'].append({'buffer': 0, 'byteLength': 0})
            im['bufferView'] = len(j['bufferViews']) - 1
    img_of_view = {im['bufferView']: ii for ii, im in enumerate(j['images'])}
    out = bytearray()
    for vi, v in enumerate(j['bufferViews']):
        ii = img_of_view.get(vi)
        data = enc[ii] if ii in enc else g.view(vi)
        while len(out) % 4:
            out.append(0)
        v['byteOffset'] = len(out); v['byteLength'] = len(data)
        out += data
    while len(out) % 4:
        out.append(0)
    j['buffers'][0]['byteLength'] = len(out)
    js = json.dumps(j, separators=(',', ':'), ensure_ascii=False).encode()
    js += b' ' * ((4 - len(js) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(out)
    import struct
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, total))
        f.write(struct.pack('<I', len(js)) + b'JSON' + js)
        f.write(struct.pack('<I', len(out)) + b'BIN\x00' + out)
    return total


# ───────────────────────── геометрия-накладки ─────────────────────────
class Body:
    """тело Tripo в позе покоя + кости"""

    def __init__(self, g):
        self.g = g
        self.mi, self.pr = g.main_mesh()
        A = self.A = self.pr['attributes']
        self.P = g.acc(A['POSITION']).astype(np.float64)
        self.N = g.acc(A['NORMAL']).astype(np.float64)
        self.UV = g.acc(A['TEXCOORD_0']).astype(np.float64)
        self.I = g.acc(self.pr['indices']).reshape(-1, 3).astype(np.int64)
        self.J = g.acc(A['JOINTS_0']).astype(np.int64)
        self.W = g.acc(A['WEIGHTS_0']).astype(np.float64)
        sk = g.j['skins'][0]
        self.names = [g.j['nodes'][i]['name'].replace('mixamorig:', '') for i in sk['joints']]
        ibm = g.acc(sk['inverseBindMatrices']).reshape(-1, 4, 4).transpose(0, 2, 1)
        self.bp = np.linalg.inv(ibm)[:, :3, 3]
        self.node = next(i for i, nd in enumerate(g.j['nodes']) if nd.get('mesh') == self.mi)

    def B(self, name):
        return self.bp[self.names.index(name)]

    def wsum(self, pred):
        """вес вершины на костях, для которых pred(имя) истинно"""
        sel = np.array([pred(n) for n in self.names])
        return (self.W * sel[self.J]).sum(1)

    def dom(self):
        return np.array(self.names)[self.J[np.arange(len(self.J)), self.W.argmax(1)]]

    def skin_near(self, V, pool=None):
        """кожа накладки: веса ближайшей вершины тела (из pool — индексы вершин-кандидатов)"""
        idx = np.arange(len(self.P)) if pool is None else np.asarray(pool)
        Q = self.P[idx]
        out = np.empty(len(V), np.int64)
        for k in range(0, len(V), 512):
            d = ((V[k:k + 512, None, :] - Q[None]) ** 2).sum(-1)
            out[k:k + 512] = idx[d.argmin(1)]
        return self.J[out], self.W[out]

    def ray(self, O, D, tris=None):
        """пересечение лучей O+tD (t>0) с телом: ближайшая точка, нормаль треугольника; NaN — мимо"""
        T = self.I if tris is None else self.I[tris]
        a, b, c = self.P[T[:, 0]], self.P[T[:, 1]], self.P[T[:, 2]]
        e1, e2 = b - a, c - a
        res = np.full((len(O), 3), np.nan); nrm = np.full((len(O), 3), np.nan)
        for k in range(len(O)):
            o, d = O[k], D[k]
            p = np.cross(d, e2); det = (e1 * p).sum(1)
            ok = np.abs(det) > 1e-12
            inv = np.where(ok, 1 / np.where(ok, det, 1), 0)
            tv = o - a
            u = (tv * p).sum(1) * inv
            q = np.cross(tv, e1)
            v = (d * q).sum(1) * inv
            t = (e2 * q).sum(1) * inv
            hit = ok & (u >= 0) & (v >= 0) & (u + v <= 1) & (t > 1e-6)
            if hit.any():
                i = np.where(hit)[0][t[hit].argmin()]
                res[k] = o + d * t[i]
                n = np.cross(e1[i], e2[i]); nrm[k] = n / np.linalg.norm(n)
        return res, nrm


class Overlay:
    """набор мелких мешей-накладок одного материала → один примитив BD_<name>"""

    def __init__(self, name):
        self.name = name
        self.V, self.Nn, self.C, self.F = [], [], [], []
        self.n = 0

    def add(self, V, F, C, Nn=None):
        V = np.asarray(V, np.float64)
        if Nn is None:
            Nn = vertex_normals(V, F)
        self.V.append(V); self.Nn.append(Nn); self.C.append(np.asarray(C, np.float64))
        self.F.append(np.asarray(F, np.int64) + self.n)
        self.n += len(V)

    def emit(self, g, body, mat, pool=None):
        if not self.n:
            return
        V = np.concatenate(self.V).astype(np.float32); Nn = np.concatenate(self.Nn).astype(np.float32)
        C = np.concatenate(self.C).astype(np.float32); F = np.concatenate(self.F)
        if C.shape[1] == 3:
            C = np.c_[C, np.ones(len(C))].astype(np.float32)
        J, W = body.skin_near(V.astype(np.float64), pool)
        jt = g.j['accessors'][body.A['JOINTS_0']]['componentType']
        g.j['materials'].append(dict(mat, name=PFX + self.name + '_mat'))
        attrs = {
            'POSITION': g.add_acc(V, 5126, 'VEC3', 34962),
            'NORMAL': g.add_acc(Nn, 5126, 'VEC3', 34962),
            'COLOR_0': g.add_acc(C, 5126, 'VEC4', 34962),
            'JOINTS_0': g.add_acc(J, jt, 'VEC4', 34962),
            'WEIGHTS_0': g.add_acc(W.astype(np.float32), 5126, 'VEC4', 34962),
        }
        ind = g.add_acc(F.astype(np.uint16 if self.n < 65535 else np.uint32).ravel(), 5123 if self.n < 65535 else 5125, 'SCALAR', 34963)
        g.j['meshes'].append({'name': PFX + self.name, 'primitives': [{'attributes': attrs, 'indices': ind, 'material': len(g.j['materials']) - 1}]})
        add_node(g, body, PFX + self.name, len(g.j['meshes']) - 1)
        print(f'  {PFX}{self.name}: {self.n} вершин, {len(F)} треуг.')


def add_node(g, body, name, mesh, extras=None):
    nd = {'name': name, 'mesh': mesh, 'skin': g.j['nodes'][body.node]['skin']}
    if extras:
        nd['extras'] = extras
    g.j['nodes'].append(nd)
    ni = len(g.j['nodes']) - 1
    parent = next((n for n in g.j['nodes'] if body.node in n.get('children', [])), None)
    if parent is not None:
        parent['children'].append(ni)
    else:
        g.j['scenes'][0]['nodes'].append(ni)


def vertex_normals(V, F):
    F = np.asarray(F)
    n = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    out = np.zeros_like(V)
    for k in range(3):
        np.add.at(out, F[:, k], n)
    return out / (np.linalg.norm(out, axis=1, keepdims=True) + 1e-12)


def frame(nz, hint):
    nz = nz / np.linalg.norm(nz)
    x = hint - nz * (hint @ nz); x /= np.linalg.norm(x)
    return x, np.cross(nz, x), nz


def grid_disc(nr=5, na=20):
    """единичный диск: центр + кольца; (uv в −1..1, грани)"""
    pts = [(0.0, 0.0)]
    for r in range(1, nr + 1):
        for a in range(na):
            t = 2 * np.pi * a / na
            pts.append((np.cos(t) * r / nr, np.sin(t) * r / nr))
    F = []
    for a in range(na):
        F.append([0, 1 + a, 1 + (a + 1) % na])
    for r in range(1, nr):
        b0 = 1 + (r - 1) * na; b1 = 1 + r * na
        for a in range(na):
            a1 = (a + 1) % na
            F += [[b0 + a, b1 + a, b1 + a1], [b0 + a, b1 + a1, b0 + a1]]
    return np.array(pts), np.array(F)


def pad_on_surface(body, tris, c, nrm_out, ax_u, rx, ry, height, shape=None):
    """выпуклая подушечка, «налитая» на поверхность: вершины диска проецируются лучом на тело и приподнимаются"""
    uv, F = grid_disc()
    if shape is not None:
        uv = shape(uv)
    ex, ey, ez = frame(nrm_out, ax_u)
    P0 = c[None] + uv[:, :1] * rx * ex + uv[:, 1:] * ry * ey
    hit, hn = body.ray(P0 + ez * 0.03, np.tile(-ez, (len(P0), 1)), tris)
    miss = np.isnan(hit[:, 0])
    if miss.mean() > 0.3:
        return None
    if miss.any():  # дотянуть промахи по соседям: проекция на плоскость центра
        hit[miss] = P0[miss]
    r2 = (uv ** 2).sum(1)
    dome = height * np.clip(1 - r2, 0, 1) ** 0.6 + 0.0009
    V = hit + ez[None] * dome[:, None]
    return V, F, r2


# ───────────────────────── лапы ─────────────────────────
PINK = np.array([0.93, 0.56, 0.62])
PINK_DEEP = np.array([0.80, 0.42, 0.50])


def hand_frame(body, side):
    H = body.B(side + 'Hand')
    a = body.B(side + 'HandMiddle4') - H
    L = np.linalg.norm(a); a /= L
    l = body.B(side + 'HandIndex1') - body.B(side + 'HandPinky1'); l -= a * (l @ a); l /= np.linalg.norm(l)
    pn = np.cross(a, l)
    d1 = body.B(side + 'HandIndex2') - body.B(side + 'HandIndex1'); d2 = body.B(side + 'HandIndex3') - body.B(side + 'HandIndex2')
    curl = d2 / np.linalg.norm(d2) - d1 / np.linalg.norm(d1)
    if curl @ pn < 0:
        pn = -pn
    return H, a, l, pn, L


def hand_verts(body, side):
    w = body.wsum(lambda n: n.startswith(side + 'Hand'))
    return np.where(w > 0.35)[0]


def paw_pads(body, ov, persona):
    """подушечки: большая на ладони + 4 «бобика» на кончиках пальцев (геометрия, розовые)"""
    for side in ('Left', 'Right'):
        H, a, l, pn, L = hand_frame(body, side)
        hv = hand_verts(body, side)
        vs = set(hv.tolist())
        tris = np.where(np.isin(body.I, hv).all(1))[0]
        # реальная длина лапы — по вершинам (дальше всего вдоль оси)
        t_all = (body.P[hv] - H) @ a
        tip = np.percentile(t_all, 99.5)
        s_all = (body.P[hv] - H) @ l
        sw = np.percentile(s_all, 97) - np.percentile(s_all, 3)
        s0 = (np.percentile(s_all, 97) + np.percentile(s_all, 3)) / 2
        pads = [(0.48, 0.0, 0.16, 0.24, 0.016, 'palm')]
        for k, s in enumerate((-0.36, -0.12, 0.12, 0.36)):
            pads.append((0.86 - 0.04 * abs(s) / 0.36, s, 0.075, 0.085, 0.006, 'toe'))
        for t, s, rx, ry, h, kind in pads:
            c = H + a * t * tip + l * (s0 + s * sw)
            heart = None
            if kind == 'palm':
                # «сердечко»: снизу у́же, сверху три лепестка
                def heart(uv):
                    # к запястью (u<0) уже — «капля», к пальцам шире
                    u, v = uv[:, 0], uv[:, 1]
                    return np.c_[u, v * (1 - 0.3 * np.clip(-u, 0, 1) ** 1.5)]
            r = pad_on_surface(body, tris, c, pn, a, rx * tip, ry * sw, h * tip / 0.083 * 0.83, heart)
            if r is None:
                print('   промах подушечки', side, kind)
                continue
            V, F, r2 = r
            col = PINK[None] * (1 - 0.25 * r2[:, None] ** 2) + PINK_DEEP[None] * 0.25 * r2[:, None] ** 2
            ov.add(V, F, col)


def foot_pads(body, ov):
    """подошвы босых лап (Блёстка): подушечка пятки + 3 пальцевых, снизу"""
    for side in ('Left', 'Right'):
        fw = body.wsum(lambda n: n.startswith(side + 'Foot') or n.startswith(side + 'Toe'))
        fv = np.where(fw > 0.4)[0]
        tris = np.where(np.isin(body.I, fv).all(1))[0]
        P = body.P[fv]
        y0 = P[:, 1].min()
        sole = P[P[:, 1] < y0 + 0.01]
        cx = sole[:, 0].mean()
        z0, z1 = np.percentile(sole[:, 2], 3), np.percentile(sole[:, 2], 97)
        w = np.percentile(sole[:, 0], 95) - np.percentile(sole[:, 0], 5)
        L = z1 - z0
        down = np.array([0.0, -1.0, 0.0])
        items = [(0.42, 0.0, 0.26 * w, 0.2 * L, 0.006)]
        for s in (-0.3, 0.0, 0.3):
            items.append((0.80 - 0.04 * abs(s) / 0.3, s, 0.12 * w, 0.09 * L, 0.004))
        for t, s, rx, ry, h in items:
            c = np.array([cx + s * w, y0 + 0.02, z0 + t * L])
            r = pad_on_surface(body, tris, c, down, np.array([1.0, 0, 0]), rx, ry, h)
            if r is None:
                continue
            V, F, r2 = r
            ov.add(V, F, PINK[None] * (1 - 0.25 * r2[:, None] ** 2) + PINK_DEEP[None] * 0.25 * r2[:, None] ** 2)


# ───────────────────────── мех: данные для оболочек ─────────────────────────
def fur_shell(g, body, at, persona, head_v):
    """треугольники меха ниже головы + _FURLEN (длина шерсти, ед. модели); оболочки строит рантайм"""
    # мех по текселям (как в cat_look: голубовато-серый, неяркий) → доля меха в треугольнике → в вершине
    c = at.base
    r, gg, b = c[..., 0], c[..., 1], c[..., 2]
    mx = c.max(-1); mn = c.min(-1); sat = (mx - mn) / np.maximum(mx, 1)
    ft = at.has & (b > r + 8) & (b > gg + 4) & (sat < 0.5) & (mx > 60)
    nt = len(body.I)
    t = at.tid[at.has]
    frac = np.bincount(t, weights=ft[at.has].astype(np.float64), minlength=nt) / np.maximum(np.bincount(t, minlength=nt), 1)
    vs = np.zeros(len(body.P)); vk = np.zeros(len(body.P))
    for k in range(3):
        np.add.at(vs, body.I[:, k], frac); np.add.at(vk, body.I[:, k], 1)
    fur = vs / np.maximum(vk, 1) > 0.5
    if persona == 'glitter':  # хвост Блёстки — сиреневые блёстки, тоже мех
        tailw = body.wsum(lambda n: n.startswith('Tail'))
        fur |= tailw > 0.5
    hand = body.wsum(lambda n: 'Hand' in n)
    tail = body.wsum(lambda n: n.startswith('Tail'))
    foot = body.wsum(lambda n: 'Foot' in n or 'Toe' in n)
    # рёбра сетки со сшитыми швами UV (совпадающие позиции — одна вершина)
    key = np.round(body.P * 1e5).astype(np.int64)
    _, weld = np.unique(key, axis=0, return_inverse=True)
    weld = weld.ravel()
    E = weld[np.r_[body.I[:, [0, 1]], body.I[:, [1, 2]], body.I[:, [2, 0]]]]
    nW = weld.max() + 1

    def to_w(v):
        a = np.zeros(nW); k = np.zeros(nW)
        np.add.at(a, weld, v); np.add.at(k, weld, 1)
        return a / np.maximum(k, 1)

    def smooth(x, it):
        for _ in range(it):
            s_ = np.zeros(nW); k = np.zeros(nW)
            np.add.at(s_, E[:, 0], x[E[:, 1]]); np.add.at(k, E[:, 0], 1)
            np.add.at(s_, E[:, 1], x[E[:, 0]]); np.add.at(k, E[:, 1], 1)
            x = 0.5 * x + 0.5 * s_ / np.maximum(k, 1)
        return x

    # цвет у вершин шумный (пряди, тени) — сначала большинством по соседям
    f = smooth(to_w(fur.astype(np.float64)), 1) > 0.5
    f &= to_w(head_v) < 0.5
    lo = f.astype(np.float64)
    for _ in range(2):  # эрозия: край меха (манжеты, кеды, подол) → 0
        m = lo.copy()
        np.minimum.at(m, E[:, 0], lo[E[:, 1]]); np.minimum.at(m, E[:, 1], lo[E[:, 0]])
        lo = m
    lo = smooth(lo, 3)
    L = lo[weld] * (1 - smoothstep(0.1, 0.5, hand))  # на кистях мех мешал бы подушечкам
    base_len = {'hooligan': 0.011, 'kind': 0.013, 'glitter': 0.012}[persona]
    tail_k = {'hooligan': 1.9, 'kind': 2.0, 'glitter': 1.5}[persona]
    length = base_len * L * (1 + (tail_k - 1) * np.clip(tail, 0, 1)) * (1 - 0.35 * np.clip(foot, 0, 1))
    tri = np.where((length[body.I] > 0.0012).all(1))[0]
    if not len(tri):
        return
    idx = body.I[tri].ravel()
    ind = g.add_acc(idx.astype(np.uint16 if len(body.P) < 65535 else np.uint32), 5123 if len(body.P) < 65535 else 5125, 'SCALAR', 34963)
    fl = g.add_acc(length.astype(np.float32), 5126, 'SCALAR', 34962)
    attrs = {k: v for k, v in body.A.items() if k in ('POSITION', 'NORMAL', 'TEXCOORD_0', 'JOINTS_0', 'WEIGHTS_0')}
    attrs['_FURLEN'] = fl
    # в чужом просмотрщике оболочка невидима (alpha 0, MASK); рантайм ставит свой материал
    g.j['materials'].append({'name': PFX + 'FurShell_mat', 'alphaMode': 'MASK', 'alphaCutoff': 0.5,
                             'pbrMetallicRoughness': {'baseColorFactor': [1, 1, 1, 0], 'metallicFactor': 0}})
    g.j['meshes'].append({'name': PFX + 'FurShell', 'primitives': [{'attributes': attrs, 'indices': ind, 'material': len(g.j['materials']) - 1}]})
    fx = {'hooligan': {'layers': 4, 'density': 150, 'tip': [1.06, 1.06, 1.08]},
          'kind': {'layers': 4, 'density': 140, 'tip': [1.08, 1.08, 1.1]},
          'glitter': {'layers': 4, 'density': 150, 'tip': [1.08, 1.06, 1.1]}}[persona]
    add_node(g, body, PFX + 'FurShell', len(g.j['meshes']) - 1, {'fur': fx})
    print(f'  {PFX}FurShell: {len(tri)} треуг., длина {length.max():.4f}')


# ───────────────────────── атлас ─────────────────────────
def look_base(persona):
    p = f'/tmp/bd/{persona}_look2048.glb'
    src = os.path.join(FACEW, f'{persona}_face.glb')
    if not os.path.exists(p) or os.path.getmtime(p) < os.path.getmtime(src):
        os.makedirs('/tmp/bd', exist_ok=True)
        subprocess.check_call([sys.executable, os.path.join(HERE, 'cat_look.py'), persona, src, p])
    return Glb(p)


def raster(body, persona):
    h = hashlib.md5(body.P.tobytes() + body.UV.tobytes() + body.I.tobytes()).hexdigest()[:10]
    cache = f'/tmp/bd/raster_{persona}_{S}_{h}.npz'
    if os.path.exists(cache):
        d = np.load(cache)
        return d['pos'], d['nrm'], d['tid']
    pos, nrm, tid = raster_uv(body.P, body.N, body.UV, body.I, S)
    np.savez_compressed(cache, pos=pos, nrm=nrm, tid=tid)
    return pos, nrm, tid


class Atlas:
    """тексели тела: позиция, нормаль, касательные; копилка деталей нормали, цвет, шероховатость"""

    def __init__(self, body, pos, nrm, tid, base, nmap, rm):
        self.body = body
        self.pos, self.nrm, self.tid = pos, nrm, tid
        self.has = tid >= 0
        self.base = base.astype(np.float32)
        self.nmap = nmap.astype(np.float32)
        self.rm = rm.astype(np.float32)
        self.det = np.zeros(base.shape[:2] + (2,), np.float32)
        self.Tt, self.Bt = tri_tangents(body.P, body.UV, body.I)
        self.emis = None
        self.base0 = self.base.copy()

    def bump_mask(self, mask, amp, blur=1.6):
        """выпуклость по маске в UV (для нарисованных деталей: шнурки) — градиент картинки"""
        from PIL import ImageFilter
        Hm = Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(blur))
        Hh = np.asarray(Hm).astype(np.float32) / 255
        gy, gx = np.gradient(Hh)
        sel = (Hh > 0.02) & self.has
        self.det[..., 0] -= np.where(sel, gx * amp, 0)
        self.det[..., 1] -= np.where(sel, gy * amp, 0)

    def vert_attr(self, v):
        """вершинное значение → тексели (среднее по треугольнику)"""
        out = np.zeros(self.tid.shape, np.float32)
        t = self.tid[self.has]
        out[self.has] = v[self.body.I[t]].mean(1)
        return out

    def bump(self, mask, fn, amp, eps=0.0004):
        """карта высот fn(p) (в 3D, ед. модели) → добавка к нормали в касательном пространстве"""
        idx = np.where(mask & self.has)
        if not len(idx[0]):
            return
        p = self.pos[idx].astype(np.float64)
        _, gr = grad3(fn, p, eps)
        n = self.nrm[idx].astype(np.float64)
        gr = gr - n * (gr * n).sum(1, keepdims=True)
        t = self.tid[idx]
        T = self.Tt[t]; B = self.Bt[t]
        T = T - n * (T * n).sum(1, keepdims=True); T /= np.linalg.norm(T, axis=1, keepdims=True) + 1e-12
        B = B - n * (B * n).sum(1, keepdims=True); B /= np.linalg.norm(B, axis=1, keepdims=True) + 1e-12
        a = amp if np.isscalar(amp) else amp[idx]
        self.det[idx[0], idx[1], 0] += -(gr * T).sum(1) * a
        self.det[idx[0], idx[1], 1] += -(gr * B).sum(1) * a

    def shade(self, mask, k):
        """умножить цвет (k — массив по текселям или число)"""
        kk = k if np.isscalar(k) else k[mask]
        self.base[mask] *= np.asarray(kk, np.float32)[..., None] if not np.isscalar(k) else k

    def normal_image(self):
        d = np.clip(self.det, -0.9, 0.9)
        n0 = self.nmap / 127.5 - 1
        nx = n0[..., 0] + d[..., 0]; ny = n0[..., 1] + d[..., 1]
        nz = n0[..., 2] * np.sqrt(np.clip(1 - d[..., 0] ** 2 - d[..., 1] ** 2, 0.05, 1))
        nl = np.sqrt(nx * nx + ny * ny + nz * nz) + 1e-9
        return np.clip((np.stack([nx / nl, ny / nl, nz / nl], -1) + 1) * 127.5, 0, 255)


def hand_texture(at, body):
    """лапы: «булочки» пальцев (борозды между пальцами сверху и снизу) и мягкая тень в бороздах"""
    for side in ('Left', 'Right'):
        H, a, l, pn, L = hand_frame(body, side)
        hv = hand_verts(body, side)
        t_all = (body.P[hv] - H) @ a
        tip = np.percentile(t_all, 99.5)
        s_all = (body.P[hv] - H) @ l
        sw = np.percentile(s_all, 97) - np.percentile(s_all, 3)
        s0 = (np.percentile(s_all, 97) + np.percentile(s_all, 3)) / 2
        wv = np.zeros(len(body.P)); wv[hv] = 1
        m = (at.vert_attr(wv) > 0.5) & at.has

        def groove(p):
            q = p - H
            t = (q @ a) / tip
            s = ((q @ l) - s0) / sw
            g = 0
            for sk in (-0.24, 0.0, 0.24):
                g = g + np.exp(-((s - sk) / 0.045) ** 2)
            return -g * smoothstep(0.55, 0.78, t)

        idx = np.where(m)
        ggv = groove(at.pos[idx].astype(np.float64))
        at.base[idx] *= (1 + 0.28 * ggv)[:, None]  # тень в бороздах
        at.bump(m, groove, 0.0011, eps=0.0005)


def tail_tip(at, body, persona):
    """кончик хвоста светлее (как на рефе), у Блёстки — сиреневый с блеском"""
    t4 = at.vert_attr(body.wsum(lambda n: n == 'Tail4'))
    t3 = at.vert_attr(body.wsum(lambda n: n == 'Tail3'))
    k = np.clip(t4 + 0.35 * t3, 0, 1) * at.has
    # по длине хвоста: кончик — дальний конец от Tail1
    T1 = body.B('Tail1'); T4 = body.B('Tail4')
    ax = T4 - T1; Lx = np.linalg.norm(ax); ax /= Lx
    tt = ((at.pos - T1) @ ax) / Lx
    tailw = at.vert_attr(body.wsum(lambda n: n.startswith('Tail')))
    k = np.maximum(k * 0, smoothstep(0.75, 1.25, tt)) * (tailw > 0.5)
    if persona == 'glitter':
        return
    light = np.array([228, 232, 245], np.float32)
    at.base = at.base * (1 - 0.55 * k[..., None]) + light * 0.55 * k[..., None]


# ───────────────────────── одежда ─────────────────────────
def cls(at, persona):
    """классы ткани по цвету чистой базы (до наших деталей)"""
    c = at.base0
    r, g, b = c[..., 0], c[..., 1], c[..., 2]
    mx = c.max(-1); mn = c.min(-1); sat = (mx - mn) / np.maximum(mx, 1)
    y = at.pos[..., 1]
    h = at.has
    k = {}
    if persona == 'hooligan':
        k['trim'] = h & (g > 140) & (g > r + 35) & (g > b + 60) & (y < 0.75)
        k['teal'] = h & (g > 110) & (b > 90) & (g > r + 45) & (np.abs(g - b) < 70) & (y > 0.4) & (y < 0.62)
        k['hoodie'] = h & (mx < 70) & (y > 0.2) & (y < 0.58) & ~k['teal']
        k['shoe'] = h & (y < 0.1)
        k['cap'] = h & (g > 140) & (g > r + 35) & (g > b + 60) & (y > 0.75)
    elif persona == 'kind':
        k['trim'] = h & (g > r + 25) & (b > r + 15) & (g > 140) & (np.abs(g - b) < 45) & (y < 0.6)
        k['hoodie'] = h & (r > 175) & (g > 165) & (b > 150) & (r >= b) & (sat < 0.2) & (y > 0.2) & (y < 0.6)
        peach = h & (r > 170) & (r > g + 45) & (r > b + 55)
        k['scarf'] = peach & (y > 0.3)
        k['sock'] = peach & (y < 0.2)
    else:
        k['trim'] = h & (g > r + 25) & (b > r + 15) & (g > 150) & (y < 0.6) & (y > 0.33)
        k['skirt'] = h & (g > r + 5) & (b > r) & (y < 0.34) & (y > 0.12) & (sat < 0.45)
        k['gold'] = h & (r > 165) & (g > 0.72 * r) & (b < 0.86 * r) & (sat > 0.15) & (y < 0.6)
        k['hoodie'] = h & (b > r) & (r > 130) & (b > 180) & (g < r) & (y > 0.3) & (y < 0.6)
    return k


def axis_frame(ax):
    ax = ax / np.linalg.norm(ax)
    e1 = np.cross(ax, [0.0, 0.0, 1.0] if abs(ax[2]) < 0.9 else [1.0, 0, 0]); e1 /= np.linalg.norm(e1)
    return ax, e1, np.cross(ax, e1)


def stitch(d, along, w=0.0011, gap=0.0028, dash=1100.0):
    """шов: канавка по d=0 и пунктир строчки по обе стороны"""
    groove = -np.exp(-(d / w) ** 2)
    dashes = (np.sin(along * dash) > -0.2).astype(np.float64)
    st = 0.55 * (np.exp(-((np.abs(d) - gap) / (0.45 * w)) ** 2)) * dashes
    return groove + st


def ribbing(at, mask, center, axis, n, amp=0.0011):
    ax, e1, e2 = axis_frame(np.asarray(axis, np.float64))
    c = np.asarray(center, np.float64)

    def h(p):
        q = p - c
        th = np.arctan2(q @ e2, q @ e1)
        return np.sin(th * n) * 0.5
    at.bump(mask, h, amp, eps=0.0003)
    idx = np.where(mask & at.has)
    th = h(at.pos[idx].astype(np.float64))
    at.base[idx] *= (1 + 0.10 * th)[:, None]


def cuffs_and_hem(at, body, k, ribs_cuff=34, ribs_hem=120):
    trim = k['trim']
    sides = {}
    for side in ('Left', 'Right'):
        wv = body.wsum(lambda n: n.startswith(side + 'ForeArm') or n.startswith(side + 'Hand'))
        sides[side] = at.vert_attr(wv) > 0.5
        E, H = body.B(side + 'ForeArm'), body.B(side + 'Hand')
        ribbing(at, trim & sides[side], H, H - E, ribs_cuff)
    hem = trim & ~sides['Left'] & ~sides['Right'] & (at.pos[..., 1] < 0.36)
    ribbing(at, hem, body.B('Hips'), [0, 1, 0], ribs_hem)
    return hem


def sleeve_folds(at, body, cloth):
    """складки на сгибе локтя (спереди) и «напуск» над резинкой"""
    for side in ('Left', 'Right'):
        A, E, H = body.B(side + 'Arm'), body.B(side + 'ForeArm'), body.B(side + 'Hand')
        ax = (H - A); ax /= np.linalg.norm(ax)
        a_, e1, e2 = axis_frame(ax)
        inner = np.array([0.0, 0.0, 1.0]); inner -= ax * (inner @ ax); inner /= np.linalg.norm(inner)

        def h(p):
            q = p - E
            t = q @ ax
            rr = q - np.outer(t, ax)
            rn = rr / (np.linalg.norm(rr, axis=1, keepdims=True) + 1e-9)
            front = np.clip(rn @ inner, -1, 1)
            wv = 0.5 + 0.5 * front
            wob = 0.004 * np.sin((rn @ e1) * 5.0)
            return np.sin((t + wob) * 260.0) * np.exp(-(t / 0.03) ** 2) * wv ** 1.5
        m = cloth & (np.linalg.norm(at.pos - E, axis=-1) < 0.06)
        at.bump(m, h, 0.0016, eps=0.0004)
        idx = np.where(m)
        hv = h(at.pos[idx].astype(np.float64))
        at.base[idx] *= (1 + 0.10 * hv)[:, None]


def blouse(at, cloth, y0, y1):
    """мягкие вертикальные складки ткани над резинкой подола"""
    def h(p):
        th = np.arctan2(p[:, 0], p[:, 2])
        f = smoothstep(y1, y0, p[:, 1]) * smoothstep(y0 - 0.01, y0 + 0.01, p[:, 1])
        return (np.sin(th * 9 + 1.3 * np.sin(th * 3)) + 0.4 * np.sin(th * 17 + 2)) * f
    m = cloth & (at.pos[..., 1] > y0 - 0.01) & (at.pos[..., 1] < y1)
    at.bump(m, h, 0.0035, eps=0.0006)
    idx = np.where(m)
    hv = h(at.pos[idx].astype(np.float64))
    at.base[idx] *= (1 + 0.07 * hv)[:, None]


def armhole_seams(at, body, cloth):
    for side in ('Left', 'Right'):
        A, E = body.B(side + 'Arm'), body.B(side + 'ForeArm')
        ax = (E - A) / np.linalg.norm(E - A)
        c = A + ax * 0.012
        _, e1, e2 = axis_frame(ax)

        def h(p):
            q = p - c
            d = q @ ax
            along = np.arctan2(q @ e2, q @ e1) * 0.05
            return stitch(d, along)
        m = cloth & (np.linalg.norm(at.pos - c, axis=-1) < 0.08)
        at.bump(m, h, 0.0012, eps=0.0003)


def polyline_dist(x, y, pts):
    d = np.full(x.shape, 1e9); along = np.zeros(x.shape); acc = 0
    for (ax, ay), (bx, by) in zip(pts[:-1], pts[1:]):
        vx, vy = bx - ax, by - ay
        L2 = vx * vx + vy * vy
        t = np.clip(((x - ax) * vx + (y - ay) * vy) / L2, 0, 1)
        dd = np.hypot(x - ax - t * vx, y - ay - t * vy)
        better = dd < d
        d = np.where(better, dd, d); along = np.where(better, acc + t * np.sqrt(L2), along)
        acc += np.sqrt(L2)
    return d, along


def pocket(at, cloth, pts, zmin=0.05):
    """карман-кенгуру: строчка по контуру и тень под краем входа"""
    def h(p):
        d, al = polyline_dist(p[:, 0], p[:, 1], pts)
        return stitch(d, al)
    m = cloth & (at.pos[..., 2] > zmin) & (at.nrm[..., 2] > 0.2)
    at.bump(m, h, 0.0014, eps=0.0003)
    # тень у входа (наклонные края): внутри кармана чуть темнее у кромки
    idx = np.where(m)
    p = at.pos[idx].astype(np.float64)
    d, _ = polyline_dist(p[:, 0], p[:, 1], pts)
    at.base[idx] *= (1 - 0.18 * np.exp(-(d / 0.004) ** 2))[:, None]


def hood_seam(at, cloth):
    def h(p):
        return stitch(p[:, 0], p[:, 1])
    m = cloth & (at.pos[..., 2] < -0.02) & (at.pos[..., 1] > 0.43)
    at.bump(m, h, 0.0012, eps=0.0003)


def aglets(at, body, ov, smask, color, length=0.014, rad=0.0042):
    """наконечники шнурков: цилиндрики на нижних концах нарисованных шнурков"""
    p = at.pos[smask]
    out = []
    for sgn in (-1, 1):
        q = p[(p[:, 0] * sgn > 0.003)]
        if len(q) < 20:
            continue
        i = q[:, 1].argmin()
        e = q[i].astype(np.float64)
        near = q[(np.abs(q[:, 1] - e[1]) < 0.006)]
        e[0] = near[:, 0].mean(); e[2] = near[:, 2].max() + 0.001
        V, F = cylinder(e + np.array([0, 0.004, 0]), np.array([0, -1.0, 0]), rad, length)
        ov.add(V, F, np.tile(color, (len(V), 1)))
        out.append(e)
    return out


def cylinder(p0, d, r, L, seg=10, cap=True):
    ax, e1, e2 = axis_frame(np.asarray(d, np.float64))
    V = []; F = []
    for ring, t in enumerate((0.0, L * 0.15, L * 0.85, L)):
        rr = r * (0.85 if ring in (0, 3) else 1.0)
        for a in range(seg):
            th = 2 * np.pi * a / seg
            V.append(p0 + ax * t + (np.cos(th) * e1 + np.sin(th) * e2) * rr)
    for ring in range(3):
        for a in range(seg):
            a1 = (a + 1) % seg
            i0 = ring * seg + a; i1 = ring * seg + a1; j0 = i0 + seg; j1 = i1 + seg
            F += [[i0, j0, j1], [i0, j1, i1]]
    if cap:
        V.append(p0 + ax * (L + r * 0.4)); c = len(V) - 1
        for a in range(seg):
            F.append([3 * seg + a, c, 3 * seg + (a + 1) % seg][::-1])
    return np.array(V), np.array(F)


def dome(c, nz, r, h, color, ov, seg=16, rings=5):
    _, e1, e2 = axis_frame(nz)
    V = [c + nz * h]; F = []
    for k in range(1, rings + 1):
        a = k / rings * (np.pi / 2)
        for s in range(seg):
            th = 2 * np.pi * s / seg
            V.append(c + nz * h * np.cos(a) + (np.cos(th) * e1 + np.sin(th) * e2) * r * np.sin(a))
    for s in range(seg):
        F.append([0, 1 + s, 1 + (s + 1) % seg])
    for k in range(1, rings):
        b0 = 1 + (k - 1) * seg; b1 = 1 + k * seg
        for s in range(seg):
            s1 = (s + 1) % seg
            F += [[b0 + s, b1 + s, b1 + s1], [b0 + s, b1 + s1, b0 + s1]]
    V = np.array(V)
    ov.add(V, np.array(F), np.tile(color, (len(V), 1)))


def headphones(at, teal):
    """чашки наушников: кольцевые канавки, сеточка в центре, мягкая амбушюра"""
    for sgn in (-1, 1):
        m = teal & (at.pos[..., 0] * sgn > 0.07)
        if m.sum() < 500:
            continue
        p = at.pos[m]; n = at.nrm[m]
        outer = p[:, 0] * sgn > np.percentile(p[:, 0] * sgn, 75)
        c = p[outer].mean(0).astype(np.float64)
        ax = n[outer].mean(0).astype(np.float64); ax /= np.linalg.norm(ax)
        q = p[outer] - c
        R = np.percentile(np.linalg.norm(q - np.outer(q @ ax, ax), axis=1), 92)

        def h(pp):
            q = pp - c
            rr = np.linalg.norm(q - np.outer(q @ ax, ax), axis=1) / R
            ring = -np.exp(-((rr - 0.62) / 0.035) ** 2) - 0.7 * np.exp(-((rr - 0.86) / 0.03) ** 2)
            grill = 0.25 * np.sin(q @ np.cross(ax, [0, 1, 0]) * 2200) * np.sin(q[:, 1] * 2200) * (rr < 0.55)
            return ring + grill
        mm = teal & (np.linalg.norm(at.pos - c, axis=-1) < R * 1.6)
        at.bump(mm, h, 0.0012, eps=0.0003)
        idx = np.where(mm)
        qq = at.pos[idx].astype(np.float64) - c
        rr = np.linalg.norm(qq - np.outer(qq @ ax, ax), axis=1) / R
        at.base[idx] *= (1 - 0.22 * np.exp(-((rr - 0.62) / 0.05) ** 2) - 0.12 * np.exp(-((rr - 0.86) / 0.04) ** 2))[:, None]
        # центр чашки — глянцевый пластик
        g = idx[0][rr < 0.6], idx[1][rr < 0.6]
        at.rm[g[0], g[1], 1] = 95


def cap_detail(at, body, cap, ov):
    p = at.pos[cap]
    top = p[p[:, 1] > np.percentile(p[:, 1], 99.7)].mean(0).astype(np.float64)
    ctr = np.array([top[0], 0, top[2]])
    ymax = top[1]
    crown = cap & (at.pos[..., 1] > ymax - 0.11) & ~((np.abs(at.nrm[..., 1]) > 0.88) & (at.pos[..., 1] < ymax - 0.05))
    phis = np.deg2rad([0, 60, 120])

    def h(pp):
        q = pp - ctr
        out = 0
        for ph in phis:
            n = np.array([np.cos(ph), 0, np.sin(ph)])
            out = out + stitch(q @ n, q[:, 1]) * smoothstep(0.004, 0.012, ymax - pp[:, 1] + 0.006)
        return out
    at.bump(crown, h, 0.0013, eps=0.0003)
    brim = cap & ~crown
    rb = np.hypot(at.pos[..., 0] - ctr[0], at.pos[..., 2] - ctr[2])
    rmax = np.percentile(rb[brim], 99) if brim.any() else 0.2

    def hb(pp):
        r = np.hypot(pp[:, 0] - ctr[0], pp[:, 2] - ctr[2])
        out = 0
        for k in range(4):
            out = out + stitch(r - (rmax - 0.006 - k * 0.0055), np.arctan2(pp[:, 0] - ctr[0], pp[:, 2] - ctr[2]) * 0.1, w=0.0008, gap=0.0018)
        return out * 0.6
    at.bump(brim, hb, 0.001, eps=0.0003)
    # кнопка на макушке
    col = np.median(at.base[cap], 0) / 255 * 0.85
    hit, hn = body.ray(np.array([top + np.array([0, 0.05, 0])]), np.array([[0, -1.0, 0]]))
    if not np.isnan(hit[0, 0]):
        dome(hit[0] - np.array([0, 0.0015, 0]), np.array([0, 1.0, 0]), 0.012, 0.0065, col, ov)


def sneakers(at, shoe):
    """кеды: рифление подошвы по бокам, рант"""
    c = at.base0
    white = shoe & (c.min(-1) > 150)
    sole = white & (at.pos[..., 1] < 0.035) & (np.abs(at.nrm[..., 1]) < 0.6)

    def h(p):
        return np.sin((p[:, 0] * 0.6 + p[:, 2]) * 700) * 0.5 - 1.0 * np.exp(-((p[:, 1] - 0.021) / 0.0012) ** 2)
    at.bump(sole, h, 0.0012, eps=0.0003)
    # шнурки: белое на подъёме — выпуклые (по маске в UV)
    lace = white & (at.pos[..., 1] > 0.04) & (at.nrm[..., 1] > 0.25)
    at.bump_mask(lace, 1.0)


def scarf_knit(at, body, scarf, ov):
    """шарф: вязка косичкой (две пряди, перекрещиваются) + лицевая гладь по бокам; кисточки на концах"""
    nk = body.B('Neck')
    wrap = scarf & (at.pos[..., 1] > 0.47)
    hang = scarf & ~wrap

    def knit(u, v, w):
        # u — вдоль шарфа, v — поперёк (ед. модели), w — ширина
        K = 700.0
        col = v * K / 2.2
        xp = np.mod(col, 1.0) - 0.5
        yp = np.mod(u * K / 2.6 + np.abs(xp) * 0.9, 1.0)
        st = np.sin(np.pi * yp) * (1 - (2 * xp) ** 2) ** 0.5
        # косичка в середине
        cv = v / w
        s1 = np.abs(cv - 0.13 * np.sin(u * 160)); s2 = np.abs(cv + 0.13 * np.sin(u * 160))
        front = np.sin(u * 160) > 0
        cab = np.maximum(np.exp(-(s1 / 0.07) ** 2) * (1.15 if True else 1), np.exp(-(s2 / 0.07) ** 2)) * np.where(front, 1, 0.9)
        incable = np.abs(cv) < 0.28
        return np.where(incable, 0.35 * st + 1.2 * cab, st) - 0.6 * np.exp(-((np.abs(cv) - 0.3) / 0.03) ** 2)

    def h_wrap(p):
        q = p - nk
        th = np.arctan2(q[:, 0], q[:, 2])
        return knit(th * 0.1, p[:, 1] - 0.505, 0.07)
    at.bump(wrap, h_wrap, 0.0017, eps=0.00025)
    if hang.any():
        cx = np.median(at.pos[hang][:, 0])

        def h_hang(p):
            return knit(p[:, 1], p[:, 0] - cx, 0.07)
        at.bump(hang, h_hang, 0.0017, eps=0.00025)
        # кисточки на нижнем крае свисающего конца
        P = at.pos[hang]
        ymin = P[:, 1].min()
        edge = P[P[:, 1] < ymin + 0.006]
        x0, x1 = np.percentile(edge[:, 0], 4), np.percentile(edge[:, 0], 96)
        col = np.median(at.base[hang], 0) / 255 * 0.95
        for i, x in enumerate(np.linspace(x0 + 0.004, x1 - 0.004, 7)):
            e = edge[np.abs(edge[:, 0] - x) < 0.006]
            if not len(e):
                continue
            z = e[:, 2].mean()
            ang = (i - 3) * 0.05
            d = np.array([np.sin(ang), -1.0, 0.15]); d /= np.linalg.norm(d)
            V, F = cylinder(np.array([x, ymin + 0.004, z]), d, 0.0032, 0.026 + 0.004 * ((i * 7) % 3), seg=6)
            ov.add(V, F, np.tile(col * (0.92 + 0.08 * (i % 2)), (len(V), 1)))
        return True


def socks(at, body, sock):
    for side in ('Left', 'Right'):
        F = body.B(side + 'Foot')
        m = sock & (np.sign(at.pos[..., 0]) == np.sign(F[0]))
        if not m.any():
            continue
        top = np.percentile(at.pos[m][:, 1], 99)
        cuff = m & (at.pos[..., 1] > top - 0.035)
        ribbing(at, cuff, np.array([F[0], 0, F[2]]), [0, 1, 0], 44, amp=0.0016)

        def fold(p):
            return -np.exp(-((p[:, 1] - (top - 0.036)) / 0.002) ** 2)
        at.bump(m, fold, 0.002, eps=0.0003)


def glitter_skirt(at, body, skirt, gold):
    """юбка Блёстки: убрать тёмные «разрезы» Tripo, блёстки (эмиссия), золото — металл"""
    c = at.base
    lum = c.mean(-1)
    y = at.pos[..., 1]
    # медианный цвет юбки по высоте (тюль светлее к низу)
    out = c.copy()
    bands = np.linspace(0.12, 0.34, 12)
    for y0, y1 in zip(bands[:-1], bands[1:]):
        m = skirt & (y >= y0) & (y < y1)
        if m.sum() < 50:
            continue
        med = np.median(c[m], 0); ml = med.mean()
        bad = m & (lum < ml * 0.78)
        k = np.clip((ml * 0.78 - lum) / (ml * 0.25), 0, 1)[bad]
        n = (vnoise(at.pos[bad].astype(np.float64) * 300) - 0.5) * 12
        out[bad] = c[bad] * (1 - k[:, None]) + (med[None] + n[:, None]) * k[:, None]
    # «разрезы» у хвоста: всё тёмное сзади юбки
    back = skirt & (at.pos[..., 2] < 0.0)
    at.base = out
    print(f'  юбка: подкрашено текселей {int((np.abs(out - c).sum(-1) > 3).sum())}')
    # золото: металл, глянец
    at.rm[gold, 2] = 210
    at.rm[gold, 1] = 85
    # блёстки: редкие точки в 3D на юбке, хвосте и золоте
    tail = at.vert_attr(body.wsum(lambda n: n.startswith('Tail'))) > 0.5
    sp = (skirt | gold | (tail & at.has))
    idx = np.where(sp)
    p = at.pos[idx].astype(np.float64)
    cell = 0.0035
    q = p / cell
    ci = np.floor(q)
    hsh = lambda a, b, c_: ((a * 73856093) ^ (b * 19349663) ^ (c_ * 83492791)) & 0xFFFFFF
    hv = hsh(ci[:, 0].astype(np.int64), ci[:, 1].astype(np.int64), ci[:, 2].astype(np.int64)) / 0xFFFFFF
    off = np.stack([(hv * 7.31) % 1, (hv * 13.7) % 1, (hv * 3.1) % 1], 1)
    d = np.linalg.norm(q - ci - (0.2 + 0.6 * off), axis=1)
    live = hv < (0.55 if True else 0)
    e = np.clip(1 - d / 0.22, 0, 1) * live
    em = np.zeros(at.base.shape, np.float32)
    tint = np.where(tail[idx][:, None], np.array([[255, 225, 255]]), np.array([[255, 248, 225]]))
    em[idx] = e[:, None] * tint * (0.7 + 0.3 * ((hv * 5.3) % 1))[:, None]
    at.emis = em
    # блёстки чуть ярче и в базовом цвете (видно и без эмиссии)
    at.base[idx] += (e[:, None] * 60)

# ───────────────────────── main ─────────────────────────
def main():
    persona, src, dst = sys.argv[1:4]
    g = Glb(src)
    prune_own(g)
    body = Body(g)
    headw_v = body.wsum(lambda n: n in HEAD_BONES)
    # голова: вершины, где кости головы > 0.5 (с тем же сглаживанием, что у меха)
    head_v = (headw_v > 0.5).astype(np.float64)

    pos, nrm, tid = raster(body, persona)
    has = tid >= 0
    lb = look_base(persona)
    mat = g.j['materials'][body.pr['material']]
    pbr = mat['pbrMetallicRoughness']
    tsrc = lambda t: g.j['textures'][t['index']]['source']
    i_base, i_nrm, i_rm = tsrc(pbr['baseColorTexture']), tsrc(mat['normalTexture']), tsrc(pbr['metallicRoughnessTexture'])
    lmat = lb.j['materials'][lb.main_mesh()[1]['material']]
    ltsrc = lambda t: lb.j['textures'][t['index']]['source']
    L_base = np.asarray(lb.image(ltsrc(lmat['pbrMetallicRoughness']['baseColorTexture'])).convert('RGB').resize((S, S), Image.LANCZOS))
    L_nrm = np.asarray(lb.image(ltsrc(lmat['normalTexture'])).convert('RGB').resize((S, S), Image.LANCZOS))
    L_rm = np.asarray(lb.image(ltsrc(lmat['pbrMetallicRoughness']['metallicRoughnessTexture'])).convert('RGB').resize((S, S), Image.LANCZOS))
    cur = {i: np.asarray(g.image(i).convert('RGB').resize((S, S), Image.BICUBIC)).astype(np.float32) for i in (i_base, i_nrm, i_rm)}

    at = Atlas(body, pos, nrm, tid, L_base, L_nrm, L_rm)
    head_t = at.vert_attr(head_v)
    mine = has & (head_t < 0.5)
    # кепка Хулигана (на голове, но одежда — наша): ярко-зелёные тексели выше лба
    if persona == 'hooligan':
        c = at.base
        cap = has & (pos[..., 1] > 0.78) & (c[..., 1] > 150) & (c[..., 1] > c[..., 0] + 40) & (c[..., 1] > c[..., 2] + 60)
        mine |= cap
    print(persona, 'texels mine', int(mine.sum()), 'head', int((has & ~mine).sum()))

    # ── детали ──
    hand_texture(at, body)
    tail_tip(at, body, persona)
    k = cls(at, persona)
    hem = cuffs_and_hem(at, body, k)
    cloth = k['hoodie']
    sleeve_folds(at, body, cloth)
    hy = at.pos[..., 1][hem]
    if len(hy):
        blouse(at, cloth, float(np.percentile(hy, 97)) + 0.002, float(np.percentile(hy, 97)) + 0.06)
    armhole_seams(at, body, cloth)
    hood_seam(at, cloth)
    metal = Overlay('Metal')
    soft = Overlay('Cloth')
    if persona == 'hooligan':
        pocket(at, cloth, [(-0.118, 0.245), (-0.112, 0.27), (-0.075, 0.355), (0.075, 0.355), (0.112, 0.27), (0.118, 0.245)])
        aglets(at, body, metal, k['trim'] & (np.abs(at.pos[..., 0]) < 0.07) & (at.pos[..., 2] > 0.06) & (at.pos[..., 1] > 0.33) & (at.pos[..., 1] < 0.52), np.array([0.82, 0.84, 0.86]))
        headphones(at, k['teal'])
        cap_detail(at, body, k['cap'], soft)
        sneakers(at, k['shoe'])
    elif persona == 'kind':
        pocket(at, cloth, [(-0.12, 0.27), (-0.115, 0.29), (-0.085, 0.37), (0.085, 0.37), (0.115, 0.29), (0.12, 0.27)])
        aglets(at, body, metal, k['trim'] & (np.abs(at.pos[..., 0]) < 0.07) & (at.pos[..., 2] > 0.06) & (at.pos[..., 1] > 0.38) & (at.pos[..., 1] < 0.52), np.array([0.85, 0.86, 0.86]))
        scarf_knit(at, body, k['scarf'], soft)
        socks(at, body, k['sock'])
        # след старой надписи «SBEP» вокруг эмблемы: ровный цвет худи
        x, y = at.pos[..., 0], at.pos[..., 1]
        box = cloth & (x > 0.03) & (x < 0.112) & (y > 0.412) & (y < 0.466) & (np.hypot(x - 0.0725, y - 0.4525) > 0.0265) & (at.pos[..., 2] > 0.06)
        ref = cloth & (x > 0.03) & (x < 0.112) & (y > 0.37) & (y < 0.405) & (at.pos[..., 2] > 0.06)
        if box.any() and ref.any():
            med = np.median(at.base[ref], 0)
            nn = (vnoise(at.pos[box].astype(np.float64) * 300) - 0.5) * 8
            at.base[box] = med[None] + nn[:, None]
    else:
        glitter_skirt(at, body, k['skirt'], k['gold'])

    # ── сборка атласа: своё — тело, остальное — как в main ──
    M = mine[..., None].astype(np.float32)
    out_base = cur[i_base] * (1 - M) + at.base * M
    out_nrm = cur[i_nrm] * (1 - M) + at.normal_image() * M
    out_rm = cur[i_rm] * (1 - M) + at.rm * M
    g.set_image(i_base, Image.fromarray(np.clip(out_base, 0, 255).astype(np.uint8)))
    g.set_image(i_nrm, Image.fromarray(np.clip(out_nrm, 0, 255).astype(np.uint8)))
    g.set_image(i_rm, Image.fromarray(np.clip(out_rm, 0, 255).astype(np.uint8)))

    # ── накладки ──
    pads = Overlay('Pads')
    paw_pads(body, pads, persona)
    if persona == 'glitter':
        foot_pads(body, pads)
    pads.emit(g, body, {'pbrMetallicRoughness': {'baseColorFactor': [1, 1, 1, 1], 'metallicFactor': 0, 'roughnessFactor': 0.5}})

    fur_shell(g, body, at, persona, head_v)
    metal.emit(g, body, {'pbrMetallicRoughness': {'baseColorFactor': [1, 1, 1, 1], 'metallicFactor': 0.85, 'roughnessFactor': 0.32}})
    soft.emit(g, body, {'pbrMetallicRoughness': {'baseColorFactor': [1, 1, 1, 1], 'metallicFactor': 0, 'roughnessFactor': 0.85}})
    if at.emis is not None:
        em = at.emis * M
        ii = g.add_image(Image.fromarray(np.clip(em, 0, 255).astype(np.uint8)), PFX + 'sparkle')
        mat['emissiveTexture'] = {'index': g.add_texture(ii)}
        mat['emissiveFactor'] = [1.0, 1.0, 1.0]
        jpeg_extra = {ii: (S, 90)}
    else:
        jpeg_extra = {}

    g.j.setdefault('asset', {}).setdefault('extras', {})['body_detail'] = 1
    jpeg = {i_base: (S, 88), i_nrm: (S, 90), i_rm: (1024, 88), **jpeg_extra}
    total = save(g, dst, jpeg)
    print(f'  → {dst} {total / 1e6:.2f} MB')


if __name__ == '__main__':
    main()

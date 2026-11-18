"""Мини-чтение/запись GLB без Blender: JSON, бинарный буфер, accessors → numpy, замена картинок.
Геометрию и скелет не трогаем — поза покоя костей Mixamo остаётся байт-в-байт (библиотека движений anims_v1.glb играет)."""
import io, json, struct
import numpy as np
from PIL import Image

CT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


class Glb:
    def __init__(self, path):
        b = open(path, 'rb').read()
        jl = struct.unpack('<I', b[12:16])[0]
        self.j = json.loads(b[20:20 + jl])
        o = 20 + jl
        bl = struct.unpack('<I', b[o:o + 4])[0]
        self.bin = b[o + 8:o + 8 + bl]
        self.images = {}  # index -> PIL (заменённые)
        self.extra = {}  # bufferView -> bytes (добавленные данные)

    def view(self, vi):
        if vi in self.extra:
            return self.extra[vi]
        v = self.j['bufferViews'][vi]
        o = v.get('byteOffset', 0)
        return self.bin[o:o + v['byteLength']]

    def acc(self, ai):
        a = self.j['accessors'][ai]
        if 'sparse' in a or 'bufferView' not in a:
            return self._sparse(a)
        v = self.j['bufferViews'][a['bufferView']]
        n = NC[a['type']]
        dt = np.dtype(CT[a['componentType']])
        stride = v.get('byteStride', dt.itemsize * n)
        raw = self.view(a['bufferView'])
        off = a.get('byteOffset', 0)
        arr = np.ndarray((a['count'], n), dtype=dt, buffer=raw, offset=off, strides=(stride, dt.itemsize)).copy()
        return arr if n > 1 else arr[:, 0]

    def _sparse(self, a):
        """accessor без bufferView (нули) и/или sparse (glTF 2.0 §3.6.2.3)"""
        n = NC[a['type']]
        dt = np.dtype(CT[a['componentType']])
        if 'bufferView' in a:
            b = dict(a); b.pop('sparse')
            out = self.acc_dict(b)
        else:
            out = np.zeros((a['count'], n), dtype=dt)
        sp = a.get('sparse')
        if sp:
            ii, vv = sp['indices'], sp['values']
            idt = np.dtype(CT[ii['componentType']])
            idx = np.frombuffer(self.view(ii['bufferView']), dtype=idt, count=sp['count'], offset=ii.get('byteOffset', 0))
            val = np.frombuffer(self.view(vv['bufferView']), dtype=dt, count=sp['count'] * n, offset=vv.get('byteOffset', 0)).reshape(-1, n)
            out[idx.astype(np.int64)] = val
        return out if n > 1 else out[:, 0]

    def acc_dict(self, a):
        self.j['accessors'].append(a)
        try:
            return self.acc(len(self.j['accessors']) - 1).reshape(a['count'], -1)
        finally:
            self.j['accessors'].pop()

    def add_acc(self, arr, ctype, typ, target=None):
        """новый accessor (свой bufferView) → индекс"""
        dt = np.dtype(CT[ctype])
        a = np.ascontiguousarray(np.asarray(arr, dtype=dt))
        n = NC[typ]
        a2 = a.reshape(-1, n)
        bv = {'buffer': 0, 'byteLength': a.nbytes}
        if target:
            bv['target'] = target
        self.j['bufferViews'].append(bv)
        vi = len(self.j['bufferViews']) - 1
        self.extra[vi] = a.tobytes()
        acc = {'bufferView': vi, 'componentType': ctype, 'count': len(a2), 'type': typ}
        if typ == 'VEC3' and ctype == 5126:
            acc['min'] = a2.min(0).tolist(); acc['max'] = a2.max(0).tolist()
        self.j['accessors'].append(acc)
        return len(self.j['accessors']) - 1

    def set_acc(self, ai, arr):
        """записать значения accessor на место (тот же тип и число элементов)"""
        a = self.j['accessors'][ai]
        v = self.j['bufferViews'][a['bufferView']]
        n = NC[a['type']]
        dt = np.dtype(CT[a['componentType']])
        stride = v.get('byteStride', dt.itemsize * n)
        if not isinstance(self.bin, bytearray):
            self.bin = bytearray(self.bin)
        o = v.get('byteOffset', 0) + a.get('byteOffset', 0)
        view = np.ndarray((a['count'], n), dtype=dt, buffer=self.bin, offset=o, strides=(stride, dt.itemsize))
        view[:] = np.asarray(arr, dtype=dt).reshape(a['count'], n)
        if 'min' in a:
            a['min'] = view.min(0).tolist()
            a['max'] = view.max(0).tolist()

    def image(self, ii):
        if ii in self.images:
            return self.images[ii]
        im = self.j['images'][ii]
        return Image.open(io.BytesIO(self.view(im['bufferView'])))

    def set_image(self, ii, img):
        self.images[ii] = img

    def add_image(self, img, name):
        self.j['images'].append({'name': name, 'mimeType': 'image/png', 'bufferView': -1})
        ii = len(self.j['images']) - 1
        self.images[ii] = img
        return ii

    def add_texture(self, ii, sampler=0):
        t = {'source': ii}
        if self.j.get('samplers'):
            t['sampler'] = sampler
        self.j['textures'].append(t)
        return len(self.j['textures']) - 1

    def main_mesh(self):
        """самый большой меш (тело Tripo): (mesh_index, primitive)"""
        best = max(range(len(self.j['meshes'])), key=lambda i: self.j['accessors'][self.j['meshes'][i]['primitives'][0]['attributes']['POSITION']]['count'])
        return best, self.j['meshes'][best]['primitives'][0]

    def save(self, path, fmt='PNG'):
        out = bytearray()
        img_views = {im['bufferView']: i for i, im in enumerate(self.j['images'])}
        new_views = []
        for vi, v in enumerate(self.j['bufferViews']):
            data = self.view(vi)
            if vi in img_views and img_views[vi] in self.images:
                data = self._encode(img_views[vi])
            new_views.append(data)
        # картинки без своего bufferView (добавленные)
        for ii, im in enumerate(self.j['images']):
            if im['bufferView'] == -1:
                self.j['bufferViews'].append({'buffer': 0, 'byteLength': 0})
                im['bufferView'] = len(self.j['bufferViews']) - 1
                new_views.append(self._encode(ii))
        for vi, data in enumerate(new_views):
            while len(out) % 4:
                out.append(0)
            self.j['bufferViews'][vi]['byteOffset'] = len(out)
            self.j['bufferViews'][vi]['byteLength'] = len(data)
            out += data
        while len(out) % 4:
            out.append(0)
        self.j['buffers'][0]['byteLength'] = len(out)
        js = json.dumps(self.j, separators=(',', ':')).encode()
        js += b' ' * ((4 - len(js) % 4) % 4)
        total = 12 + 8 + len(js) + 8 + len(out)
        with open(path, 'wb') as f:
            f.write(struct.pack('<III', 0x46546C67, 2, total))
            f.write(struct.pack('<I', len(js)) + b'JSON' + js)
            f.write(struct.pack('<I', len(out)) + b'BIN\x00' + out)
        return total

    def _encode(self, ii):
        buf = io.BytesIO()
        self.images[ii].convert('RGB').save(buf, 'PNG')
        self.j['images'][ii]['mimeType'] = 'image/png'
        return buf.getvalue()


def raster_uv(P, N, UV, tris, size):
    """Растеризация треугольников в UV: для каждого текселя — 3D-точка, нормаль, id треугольника (−1 — пусто).
    Острова UV у Tripo местами перекрываются (один тексель — на двух поверхностях): выигрывает поверхность,
    обращённая вперёд (больше z + 0.05·n.z) — её видно, по ней и рисуем эмблему."""
    H = W = size
    pos = np.zeros((H, W, 3), np.float32)
    nrm = np.zeros((H, W, 3), np.float32)
    tid = np.full((H, W), -1, np.int32)
    zk = np.zeros((H, W), np.float32)
    uvp = np.stack([UV[:, 0] * W - 0.5, UV[:, 1] * H - 0.5], 1)  # glTF: v=0 — верх картинки
    for t, (a, b, c) in enumerate(tris):
        pa, pb, pc = uvp[a], uvp[b], uvp[c]
        x0 = int(max(0, np.floor(min(pa[0], pb[0], pc[0])) - 1)); x1 = int(min(W - 1, np.ceil(max(pa[0], pb[0], pc[0])) + 1))
        y0 = int(max(0, np.floor(min(pa[1], pb[1], pc[1])) - 1)); y1 = int(min(H - 1, np.ceil(max(pa[1], pb[1], pc[1])) + 1))
        if x1 < x0 or y1 < y0:
            continue
        xs, ys = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
        v0 = pb - pa; v1 = pc - pa
        den = v0[0] * v1[1] - v1[0] * v0[1]
        if abs(den) < 1e-12:
            continue
        dx = xs - pa[0]; dy = ys - pa[1]
        l1 = (dx * v1[1] - v1[0] * dy) / den
        l2 = (v0[0] * dy - dx * v0[1]) / den
        l0 = 1 - l1 - l2
        e = -0.6 / max(abs(den) ** 0.5, 1e-6)  # чуть шире треугольника — без щелей на швах
        m = (l0 >= e) & (l1 >= e) & (l2 >= e)
        if not m.any():
            continue
        yy, xx = ys[m], xs[m]
        L = np.stack([l0[m], l1[m], l2[m]], 1)
        pp = L @ P[[a, b, c]]
        nn = L @ N[[a, b, c]]
        key = pp[:, 2] + 0.05 * nn[:, 2]
        win = (tid[yy, xx] < 0) | (key > zk[yy, xx])
        yy, xx = yy[win], xs[m][win]
        pos[yy, xx] = pp[win]
        nrm[yy, xx] = nn[win]
        zk[yy, xx] = key[win]
        tid[yy, xx] = t
    n = np.linalg.norm(nrm, axis=2, keepdims=True)
    nrm /= np.maximum(n, 1e-9)
    return pos, nrm, tid

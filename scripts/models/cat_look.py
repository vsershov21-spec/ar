"""«Внешний вид» кота Tripo без Blender: эмблема на худи, мех и ткань в карте нормалей, шероховатость, sheen.

Работает только с картинками и материалом GLB — геометрия, скин и поза покоя костей не меняются (anims_v1.glb играет как раньше).
Каждый тексель атласа растеризуется в 3D (glb_io.raster_uv) — поэтому узоры считаются в пространстве модели и не рвутся
на сотнях мелких UV-островов Tripo:
  • эмблема — чистый зелёный круг с белой галочкой вместо кривого «⊘»/«SBEP» (закраска + плоские нормали под ней);
  • мех — волокнистый шум, вытянутый вниз по телу (3D-градиент → касательное пространство текселя), смешан с картой нормалей Tripo;
  • ткань — мелкое плетение (худи, шарф, юбка, кепка), слабее меха;
  • металличность 0 на мехе и ткани (у Tripo ~0.15 — отсюда «пластик»), шероховатость меха с прядями 0.62–0.95;
  • KHR_materials_sheen — мягкий бархатный ободок по краю силуэта (three.js MeshPhysicalMaterial).

Usage: python3 cat_look.py <persona> in.glb out.glb [preview.png]
Дальше: python3 glb_textures.py out.glb public/models/<persona>_v1.glb
"""
import os, sys
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from glb_io import Glb, raster_uv

# эмблема: центр (x, y) на груди в координатах модели (рост ≈ 1, лицо к +Z), радиус; заливка старого лого/надписи
EMBLEM = {
    # flatten: выпуклый «⊘» у Хулигана вылеплен геометрией (рельеф ~2 см) — разглаживаем до плоскости груди
    'hooligan': {'c': (0.0723, 0.4446), 'r': 0.025, 'erase': [((0.0723, 0.4446), 0.031)], 'flatten': 0.034},
    'kind': {'c': (0.0725, 0.4525), 'r': 0.025, 'erase': [((0.0736, 0.4662), 0.022), ('box', (0.034, 0.416, 0.108, 0.462))]},
    'glitter': None,
}
SBER_GREEN = np.array([33, 160, 56], np.float32)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


# ───────────── шум (value noise 3D, векторный) ─────────────
def _hash(ix, iy, iz):
    h = (ix * 374761393 + iy * 668265263 + iz * 1274126177) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    return ((h ^ (h >> 16)) & 0xFFFF) / 65535.0


def vnoise(p):
    """p: (n, 3) → (n,) в 0..1, гладкий (квинтика)"""
    f = np.floor(p)
    i = f.astype(np.int64)
    t = p - f
    t = t * t * t * (t * (t * 6 - 15) + 10)
    out = 0
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                w = (t[:, 0] if dx else 1 - t[:, 0]) * (t[:, 1] if dy else 1 - t[:, 1]) * (t[:, 2] if dz else 1 - t[:, 2])
                out = out + w * _hash(i[:, 0] + dx, i[:, 1] + dy, i[:, 2] + dz)
    return out


def fur_height(p):
    """пряди: тонко поперёк (x, z), длинно вдоль роста (y); два масштаба + редкие «клочки»"""
    a = vnoise(p * np.array([260.0, 34.0, 260.0]))
    b = vnoise(p * np.array([520.0, 70.0, 520.0]) + 17.3)
    c = vnoise(p * np.array([60.0, 14.0, 60.0]) + 5.1)
    return 0.55 * a + 0.3 * b + 0.25 * c


def fabric_height(p):
    """мелкое плетение: два ряда синусов + шум (не идеально регулярно)"""
    k = 700.0
    w = np.sin(p[:, 0] * k + p[:, 2] * k * 0.6) * np.sin(p[:, 1] * k)
    return 0.5 + 0.25 * w + 0.35 * (vnoise(p * 380.0) - 0.5)


def grad3(fn, p, eps):
    h0 = fn(p)
    g = np.stack([(fn(p + np.array([eps, 0, 0])) - h0), (fn(p + np.array([0, eps, 0])) - h0), (fn(p + np.array([0, 0, eps])) - h0)], 1) / eps
    return h0, g


def tri_tangents(P, UV, tris):
    """касательные T = dP/du, B = dP/dv для каждого треугольника"""
    p0, p1, p2 = P[tris[:, 0]], P[tris[:, 1]], P[tris[:, 2]]
    u0, u1, u2 = UV[tris[:, 0]], UV[tris[:, 1]], UV[tris[:, 2]]
    e1, e2 = p1 - p0, p2 - p0
    d1, d2 = u1 - u0, u2 - u0
    r = d1[:, 0] * d2[:, 1] - d2[:, 0] * d1[:, 1]
    r = np.where(np.abs(r) < 1e-12, 1e-12, r)
    T = (e1 * d2[:, 1:2] - e2 * d1[:, 1:2]) / r[:, None]
    B = (e2 * d1[:, 0:1] - e1 * d2[:, 0:1]) / r[:, None]
    return T, B


def flatten_patch(g, A, P, N, c, R):
    """вершины спереди в радиусе R от c (x, y) → на плоскость, вписанную по кольцу R…1.6R; нормали — нормаль плоскости"""
    d = np.hypot(P[:, 0] - c[0], P[:, 1] - c[1])
    front = P[:, 2] > 0.08
    ring = front & (d > R) & (d < 1.6 * R)
    X = np.c_[np.ones(ring.sum()), P[ring, 0], P[ring, 1]]
    k = np.linalg.lstsq(X, P[ring, 2], rcond=None)[0]
    zp = k[0] + k[1] * P[:, 0] + k[2] * P[:, 1]
    w = front * (1 - smoothstep(0.75 * R, R, d))
    sel = w > 0
    print(f'  разглажено вершин {int(sel.sum())}, рельеф был {np.ptp(P[sel, 2] - zp[sel]):.3f}')
    P[:, 2] = P[:, 2] * (1 - w) + zp * w
    n = np.array([-k[1], -k[2], 1.0]); n /= np.linalg.norm(n)
    N[:] = N * (1 - w[:, None]) + n * w[:, None]
    N /= np.linalg.norm(N, axis=1, keepdims=True)
    g.set_acc(A['POSITION'], P)
    g.set_acc(A['NORMAL'], N)
    return k


def emblem_image(size=256):
    """чистая эмблема: зелёный круг с объёмом и белая галочка (суперсэмплинг ×4)"""
    from PIL import ImageDraw
    S = size * 4
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float32)
    u = (xx + 0.5) / S * 2 - 1; v = 1 - (yy + 0.5) / S * 2
    d = np.hypot(u, v)
    shade = np.clip(1.1 - 0.3 * ((u + 0.3) ** 2 + (v - 0.3) ** 2), 0.75, 1.12)
    img = SBER_GREEN[None, None, :] * shade[..., None]
    rim = smoothstep(0.86, 0.97, d)
    img = img * (1 - 0.35 * rim[..., None])
    im = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8))
    dr = ImageDraw.Draw(im)
    pts = [(-0.46, 0.02), (-0.12, -0.32), (0.47, 0.34)]
    xy = [((x + 1) / 2 * S, (1 - (y + 1) / 2) * S) for x, y in pts]
    w = int(0.26 * S / 2)
    dr.line(xy, fill=(250, 252, 248), width=w, joint='curve')
    for x, y in xy:
        dr.ellipse((x - w / 2, y - w / 2, x + w / 2, y + w / 2), fill=(250, 252, 248))
    return im.resize((size, size), Image.LANCZOS)


def add_emblem_disc(g, A, P, c, R, k):
    """отдельная накладка-эмблема (диск над грудью, кожа — как у ближайших вершин тела): чётко и без дыр в геометрии Tripo"""
    NR, NA = 3, 48
    n = np.array([-k[1], -k[2], 1.0]); n /= np.linalg.norm(n)
    verts, uvs = [], []
    for ri in range(NR + 1):
        rr = ri / NR
        for ai in range(NA if ri else 1):
            a = 2 * np.pi * ai / NA
            x = c[0] + np.cos(a) * rr * R; y = c[1] + np.sin(a) * rr * R
            z = k[0] + k[1] * x + k[2] * y
            verts.append(np.array([x, y, z]) + n * 0.0015)
            uvs.append(((np.cos(a) * rr * 0.98 + 1) / 2, (1 - np.sin(a) * rr * 0.98) / 2))
    verts = np.array(verts, np.float32); uvs = np.array(uvs, np.float32)
    idx = []
    for ai in range(NA):
        idx += [0, 1 + ai, 1 + (ai + 1) % NA]
    for ri in range(1, NR):
        b0 = 1 + (ri - 1) * NA; b1 = 1 + ri * NA
        for ai in range(NA):
            a0, a1 = ai, (ai + 1) % NA
            idx += [b0 + a0, b1 + a0, b1 + a1, b0 + a0, b1 + a1, b0 + a1]
    J = g.acc(A['JOINTS_0']); W = g.acc(A['WEIGHTS_0'])
    near = np.argmin(((P[None, :, :] - verts[:, None, :]) ** 2).sum(-1), axis=1)
    nrm = np.tile(n.astype(np.float32), (len(verts), 1))
    ii = g.add_image(emblem_image(), 'emblem')
    ti = g.add_texture(ii)
    g.j['materials'].append({'name': 'Emblem_mat', 'pbrMetallicRoughness': {'baseColorTexture': {'index': ti}, 'metallicFactor': 0, 'roughnessFactor': 0.6}})
    attrs = {
        'POSITION': g.add_acc(verts, 5126, 'VEC3', 34962),
        'NORMAL': g.add_acc(nrm, 5126, 'VEC3', 34962),
        'TEXCOORD_0': g.add_acc(uvs, 5126, 'VEC2', 34962),
        'JOINTS_0': g.add_acc(J[near], g.j['accessors'][A['JOINTS_0']]['componentType'], 'VEC4', 34962),
        'WEIGHTS_0': g.add_acc(W[near], 5126, 'VEC4', 34962),
    }
    ind = g.add_acc(np.array(idx, np.uint16), 5123, 'SCALAR', 34963)
    g.j['meshes'].append({'name': 'Emblem', 'primitives': [{'attributes': attrs, 'indices': ind, 'material': len(g.j['materials']) - 1}]})
    body = next(i for i, nd in enumerate(g.j['nodes']) if nd.get('mesh') == g.main_mesh()[0])
    g.j['nodes'].append({'name': 'Emblem', 'mesh': len(g.j['meshes']) - 1, 'skin': g.j['nodes'][body]['skin']})
    ni = len(g.j['nodes']) - 1
    parent = next((nd for nd in g.j['nodes'] if body in nd.get('children', [])), None)
    if parent is not None:
        parent['children'].append(ni)
    else:
        g.j['scenes'][0]['nodes'].append(ni)
    print(f'  эмблема-накладка: {len(verts)} вершин')


def unpin_skirt(g, A, base):
    """юбка Блёстки: вершины ткани (бирюзовые), попавшие в веса хвоста, отдаём тазу — хвост больше не рвёт юбку"""
    names = [g.j['nodes'][i]['name'] for i in g.j['skins'][0]['joints']]
    tail = [i for i, n in enumerate(names) if 'Tail' in n]
    hips = next(i for i, n in enumerate(names) if n.endswith('Hips'))
    J = g.acc(A['JOINTS_0']); W = g.acc(A['WEIGHTS_0']).astype(np.float64); UV = g.acc(A['TEXCOORD_0'])
    h, w = base.shape[:2]
    c = base[(UV[:, 1] * h).astype(int).clip(0, h - 1), (UV[:, 0] * w).astype(int).clip(0, w - 1)].astype(int)
    cloth = c[:, 1] > c[:, 0] + 15
    is_tail = np.isin(J, tail)
    sel = cloth & ((W * is_tail).sum(1) > 0)
    for v in np.where(sel)[0]:
        tw = W[v][is_tail[v]].sum()
        W[v][is_tail[v]] = 0
        hj = np.where(J[v] == hips)[0]
        if len(hj):
            W[v, hj[0]] += tw
        else:
            k = int(np.argmin(W[v])); J[v, k] = hips; W[v, k] += tw
    W /= W.sum(1, keepdims=True)
    g.set_acc(A['JOINTS_0'], J); g.set_acc(A['WEIGHTS_0'], W)
    print(f'  юбка: снято с хвоста вершин {int(sel.sum())}')


def main():
    persona, src, dst = sys.argv[1:4]
    preview = sys.argv[4] if len(sys.argv) > 4 else None
    g = Glb(src)
    mi, pr = g.main_mesh()
    A = pr['attributes']
    P = g.acc(A['POSITION']).astype(np.float64)
    N = g.acc(A['NORMAL']).astype(np.float64)
    UV = g.acc(A['TEXCOORD_0']).astype(np.float64)
    I = g.acc(pr['indices']).reshape(-1, 3).astype(np.int64)
    em0 = EMBLEM.get(persona)
    if em0 and em0.get('flatten'):
        k = flatten_patch(g, A, P, N, em0['c'], em0['flatten'])
        add_emblem_disc(g, A, P, em0['c'], em0['r'], k)
    mat = g.j['materials'][pr['material']]
    pbr = mat['pbrMetallicRoughness']
    tsrc = lambda t: g.j['textures'][t['index']]['source']
    i_base, i_nrm, i_rm = tsrc(pbr['baseColorTexture']), tsrc(mat['normalTexture']), tsrc(pbr['metallicRoughnessTexture'])
    base = np.asarray(g.image(i_base).convert('RGB')).astype(np.float32)
    if persona == 'glitter':
        unpin_skirt(g, A, base)
    S = base.shape[0]
    nmap = np.asarray(g.image(i_nrm).convert('RGB').resize((S, S), Image.BICUBIC)).astype(np.float32)
    rm = np.asarray(g.image(i_rm).convert('RGB').resize((S, S), Image.BICUBIC)).astype(np.float32)

    cache = f'/tmp/cat_look_{persona}_{S}.npz'
    if os.path.exists(cache) and os.path.getmtime(cache) > os.path.getmtime(src):
        d = np.load(cache); pos, nrm, tid = d['pos'], d['nrm'], d['tid']
    else:
        pos, nrm, tid = raster_uv(P, N, UV, I, S)
        np.savez_compressed(cache, pos=pos, nrm=nrm, tid=tid)
    has = tid >= 0
    print(persona, 'texels', int(has.sum()), 'atlas', S)

    # ───── классы поверхности по цвету ─────
    r, gch, b = base[..., 0], base[..., 1], base[..., 2]
    mx = base.max(-1); mn = base.min(-1)
    sat = (mx - mn) / np.maximum(mx, 1)
    fur = has & (b > r + 12) & (b > gch + 8) & (r < gch + 18) & (sat < 0.45) & (mx > 70)
    # лицо (глаза, нос, рот нарисованы) — без меха в радиусе морды, чтобы не рябило
    gold = has & (r > 170) & (gch > 0.75 * r) & (b < 0.7 * r) & (sat > 0.25)
    # глянцевое у Tripo (глаза, нос, пуговицы — шероховатость < 0.6) не трогаем вовсе
    glossy = rm[..., 1] < 150
    fur &= ~glossy
    fabric = has & ~fur & ~gold & ~glossy & (mx > 25)
    head_front = (pos[..., 1] > 0.62) & (pos[..., 2] > 0.12) & (np.abs(pos[..., 0]) < 0.17) & (pos[..., 1] < 0.8)
    # мягкий вес морды (1 — центр лица): мех там слабее, шероховатость Tripo; без резкой границы
    fy = np.clip(1 - np.abs(pos[..., 1] - 0.70) / 0.09, 0, 1)
    fx = np.clip(1 - np.abs(pos[..., 0]) / 0.17, 0, 1)
    fz = np.clip((pos[..., 2] - 0.08) / 0.06, 0, 1)
    face_w = (np.minimum(1, fy * 2.2) * np.minimum(1, fx * 2.2) * fz).astype(np.float32) * has
    # глаза, нос, рот на морде — не ткань: их блеск и цвет остаются как у Tripo
    fabric &= ~head_front
    fur &= ~(head_front & (mx > 200))  # белки и блики глаз

    # ───── эмблема ─────
    em = EMBLEM.get(persona)
    flat = np.zeros(base.shape[:2], np.float32)  # 1 — нормаль плоская (под эмблемой и закраской)
    if em:
        # перед груди; часть треугольников рельефа Tripo с вывернутыми нормалями — берём их тоже по глубине
        front = has & (pos[..., 2] > 0.08) & ((nrm[..., 2] > 0.2) | (pos[..., 2] > 0.11))
        x, y = pos[..., 0], pos[..., 1]
        erase = np.zeros_like(flat)
        aa = 0.0012
        for e in em['erase']:
            if e[0] == 'box':
                x0, y0, x1, y1 = e[1]
                dd = np.maximum(np.maximum(x0 - x, x - x1), np.maximum(y0 - y, y - y1))
                erase = np.maximum(erase, 1 - smoothstep(-aa, aa, dd))
            else:
                (cx, cy), rr = e
                erase = np.maximum(erase, 1 - smoothstep(rr - aa, rr + aa, np.hypot(x - cx, y - cy)))
        erase *= front
        # цвет ткани вокруг (медиана кольца) — закраска старого лого/надписи
        ring = front & (erase < 0.01) & (np.hypot(x - em['c'][0], y - em['c'][1]) < em['r'] * 2.6)
        cloth = np.median(base[ring & ~fur], axis=0) if (ring & ~fur).any() else np.median(base[ring], axis=0)
        print('  ткань под лого', cloth.round())
        # лёгкий шум, чтобы закраска не была мёртвой
        nn = np.zeros(flat.shape, np.float32)
        nn[front] = (vnoise(pos[front] * 300.0) - 0.5) * 10
        fill = cloth[None, None, :] + nn[..., None]
        base = base * (1 - erase[..., None]) + fill * erase[..., None]
        # круг + галочка
        cx, cy = em['c']; R = em['r']
        dc = np.hypot(x - cx, y - cy)
        circ = (1 - smoothstep(R - aa, R + aa, dc)) * front
        # галочка: ломаная в долях радиуса
        pts = np.array([(-0.46, 0.02), (-0.12, -0.32), (0.47, 0.34)]) * R + np.array([cx, cy])
        dt = np.full(x.shape, 1e9, np.float32)
        for (ax, ay), (bx, by) in zip(pts[:-1], pts[1:]):
            vx, vy = bx - ax, by - ay
            t = np.clip(((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy), 0, 1)
            dt = np.minimum(dt, np.hypot(x - ax - t * vx, y - ay - t * vy))
        tick = (1 - smoothstep(0.13 * R - aa * 0.7, 0.13 * R + aa * 0.7, dt)) * circ
        # зелёный с мягким объёмом (светлее вверху-слева) и тонким тёмным кантом
        shade = np.clip(1.08 - 0.25 * ((x - cx + R * 0.3) ** 2 + (y - cy - R * 0.3) ** 2) / R ** 2, 0.8, 1.1)
        green = SBER_GREEN[None, None, :] * shade[..., None]
        rim = smoothstep(R - 0.004, R - aa, dc) * circ
        green = green * (1 - 0.35 * rim[..., None])
        col = green * (1 - tick[..., None]) + np.array([250, 252, 248], np.float32) * tick[..., None]
        base = base * (1 - circ[..., None]) + col * circ[..., None]
        flat = np.maximum(erase, (1 - smoothstep(R + 0.001, R + 0.004, dc)) * front)
        fur &= flat < 0.5
        fabric &= flat < 0.5

    # ───── детали нормалей ─────
    Tt, Bt = tri_tangents(P, UV, I)
    det = np.zeros(base.shape[:2] + (2,), np.float32)
    rough = rm[..., 1].copy()

    def apply(mask, fn, eps, amp, rough_lo, rough_hi, amp_w=None):
        idx = np.where(mask)
        p = pos[idx].astype(np.float64)
        h, gr = grad3(fn, p, eps)
        n = nrm[idx].astype(np.float64)
        gr = gr - n * (gr * n).sum(1, keepdims=True)  # градиент вдоль поверхности
        t = tid[idx]
        T = Tt[t]; B = Bt[t]
        T = T - n * (T * n).sum(1, keepdims=True); T /= np.linalg.norm(T, axis=1, keepdims=True) + 1e-12
        B = B - n * (B * n).sum(1, keepdims=True); B /= np.linalg.norm(B, axis=1, keepdims=True) + 1e-12
        a = amp * (amp_w[idx] if amp_w is not None else 1)
        det[idx[0], idx[1], 0] = -(gr * T).sum(1) * a
        det[idx[0], idx[1], 1] = -(gr * B).sum(1) * a
        rough[idx] = (rough_lo + (rough_hi - rough_lo) * np.clip(h, 0, 1)) * 255
        return h

    fur_amp = 0.0015
    # на морде мех вдвое мягче (нарисованные глаза/нос не рябят), переход плавный
    apply(fur, fur_height, 0.0006, fur_amp, 0.62, 0.95, amp_w=1 - 0.55 * face_w)
    apply(fabric, fabric_height, 0.0004, 0.00045, 0.78, 0.97)
    det = np.clip(det, -0.9, 0.9)

    # смешение с картой Tripo (whiteout): xy складываются, z перемножаются
    n0 = nmap / 127.5 - 1
    n0[flat > 0.01] = n0[flat > 0.01] * (1 - flat[flat > 0.01, None]) + np.array([0, 0, 1]) * flat[flat > 0.01, None]
    nx = n0[..., 0] + det[..., 0]
    ny = n0[..., 1] + det[..., 1]
    nz = n0[..., 2] * np.sqrt(np.clip(1 - det[..., 0] ** 2 - det[..., 1] ** 2, 0.05, 1))
    nl = np.sqrt(nx * nx + ny * ny + nz * nz) + 1e-9
    nout = np.stack([nx / nl, ny / nl, nz / nl], -1)
    nout = np.where(has[..., None], nout, n0)
    nimg = np.clip((nout + 1) * 127.5, 0, 255).astype(np.uint8)

    # металличность: 0 на мехе и ткани (золото Блёстки оставляем)
    metal = rm[..., 2].copy()
    metal[fur | fabric] = 0
    # морда: шероховатость и металличность Tripo как были (блики глаз, нос)
    rough = rough * (1 - face_w) + rm[..., 1] * face_w
    metal = metal * (1 - face_w) + rm[..., 2] * face_w
    # под эмблемой — ровная ткань с принтом: не металл (без карты окружения металл чернеет)
    metal = metal * (1 - flat)
    rough = rough * (1 - flat) + 0.7 * 255 * flat
    rmo = np.stack([rm[..., 0], np.clip(rough, 0, 255), metal], -1).astype(np.uint8)

    g.set_image(i_base, Image.fromarray(np.clip(base, 0, 255).astype(np.uint8)))
    g.set_image(i_nrm, Image.fromarray(nimg))
    g.set_image(i_rm, Image.fromarray(rmo))

    # sheen: мягкий ободок «бархата» цветом самой поверхности
    ext = mat.setdefault('extensions', {})
    ext['KHR_materials_sheen'] = {
        'sheenColorFactor': [0.55, 0.55, 0.6],
        'sheenColorTexture': {'index': pbr['baseColorTexture']['index']},
        'sheenRoughnessFactor': 0.45,
    }
    used = g.j.setdefault('extensionsUsed', [])
    if 'KHR_materials_sheen' not in used:
        used.append('KHR_materials_sheen')
    total = g.save(dst)
    print(f'  → {dst} {total / 1e6:.2f} MB; мех {int(fur.sum())} тк {int(fabric.sum())} золото {int(gold.sum())}')
    if preview:
        cls = np.zeros(base.shape, np.uint8)
        cls[fur] = (90, 120, 230); cls[fabric] = (230, 160, 80); cls[gold] = (250, 220, 40)
        Image.fromarray(cls).resize((768, 768)).save(preview)


if __name__ == '__main__':
    main()

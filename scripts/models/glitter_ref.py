#!/usr/bin/env python3
"""Блёстка по развороту продакта 23.11 (design/refs/glitter_turnaround_1123.png): без генераций, numpy, кости и веса скина
не меняются (анимации Mixamo, footPin, прокси — как были; прокси пересчитать colliders.py).

  python3 scripts/models/glitter_ref.py in.glb out.glb [--all | --cards --furlen --liner --head --eyes --legs --badge]

Вход — основа p1 (public/models/v2/glitter_p1.glb до этой стадии), выход — новая p1; затем face_rig.py → p2 и colliders.py.
Повторный запуск отказывается (пометка extras.ref1123 узла Brows).
  --cards   пряди-карточки на голове (щёки, бока, подбородок, макушка: «воротник»/бакенбарды и иглы) — прочь; остаются
            хвост и кисти; на голове — только короткий плюш оболочек.
  --furlen  длина меха оболочек на голове ровная и короткая (щёки ×1.5 → как лоб), у шеи плавно.
  --liner   подводка верхнего века тоньше (была широкая чёрная «стрелка»), ресницы — три отдельных штриха наружу-вверх.
  --head    голова круглее: щёки-«баки» ниже глаз мягко внутрь, виски и темя чуть шире (реф — круг, у нас — треугольник).
  --eyes    глаза меньше (×EYE_K к центру глаза, с веками и кожей вокруг): на рефе межглазье ≈ 0.35 ширины головы, глаз ≈ 0.19.
  --legs    ноги — толстые короткие столбики: бёдра/голени шире по радиусу от оси кости, лапы круглее.
  --badge   значок на груди слева — маленький лиловый круг с золотым ободком и мятной галочкой (был мятный «шар»).
"""
import sys
import numpy as np
from glb_io import Glb
from head_shape import world_mats, apply_field

EYE_K = 0.84


def sstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def node_by_name(j, name):
    return next(i for i, n in enumerate(j['nodes']) if n.get('name') == name)


def mesh_prim(j, name):
    for n in j['nodes']:
        if 'mesh' in n and j['meshes'][n['mesh']].get('name') == name:
            return j['meshes'][n['mesh']]['primitives'][0]
    return None


def joint_names(j):
    sk = j['skins'][0]
    return [j['nodes'][x]['name'] for x in sk['joints']]


def marks_of(g):
    return g.j['nodes'][node_by_name(g.j, 'Brows')]['extras']['marks']


def head_frame(g):
    """центр головы (между глаз, глубже), межглазье D"""
    mk = marks_of(g)
    eL, eR = np.array(mk['eyeOuterL']), np.array(mk['eyeOuterR'])
    D = float(np.linalg.norm(eL - eR))
    return mk, D


# ───────────────────────── пряди ─────────────────────────
def cards(g):
    j = g.j
    pr = mesh_prim(j, 'BD_FurCards')
    a = pr['attributes']
    P = g.acc(a['POSITION']).astype(np.float64)
    J = g.acc(a['JOINTS_0']); Wt = g.acc(a['WEIGHTS_0'])
    jn = joint_names(j)
    dom = np.array([jn[k] for k in J[np.arange(len(J)), Wt.argmax(1)]])
    I = g.acc(pr['indices']).reshape(-1, 3).astype(np.int64)
    head = np.isin(dom, ['mixamorig:Head', 'mixamorig:HeadTop_End', 'mixamorig:Neck', 'LeftEar1', 'RightEar1'])
    keep = ~head[I].any(1)
    ct = j['accessors'][pr['indices']]['componentType']
    pr['indices'] = g.add_acc(I[keep].ravel(), ct, 'SCALAR', 34963)
    print(f'  пряди: на голове убрано {(~keep).sum()} треугольников ({(~keep).sum() // 4} пучков-полосок), осталось {keep.sum()} (хвост, кисти)')


# ───────────────────────── мех оболочек ─────────────────────────
def furlen(g):
    j = g.j
    mk, D = head_frame(g)
    pr = mesh_prim(j, 'BD_FurShell')
    a = pr['attributes']
    P = g.acc(a['POSITION']).astype(np.float64)
    L = g.acc(a['_FURLEN']).astype(np.float64)
    J = g.acc(a['JOINTS_0']); Wt = g.acc(a['WEIGHTS_0'])
    jn = joint_names(j)
    hid = [k for k, n in enumerate(jn) if n in ('mixamorig:Head', 'mixamorig:HeadTop_End', 'LeftEar1', 'RightEar1')]
    wh = (np.isin(J, hid) * Wt).sum(1)
    # голова: короткий ровный плюш — потолок 0.0065 (было до 0.0149 на щеках), ниже подбородка — плавно к телу
    cap = 0.0065
    L2 = L * (1 - wh) + np.minimum(L, cap) * wh
    # щёки (ниже глаз, сбоку) — ещё короче: силуэт головы круглый, без бахромы
    ey = (mk['eyeOuterL'][1] + mk['eyeOuterR'][1]) / 2
    cheek = sstep(0.25 * D, 0.6 * D, np.abs(P[:, 0])) * sstep(ey + 0.1 * D, ey - 0.2 * D, P[:, 1]) * wh
    L2 = L2 * (1 - 0.35 * cheek)
    print(f'  мех головы: макс {L[wh > 0.5].max():.4f} → {L2[wh > 0.5].max():.4f}, медиана {np.median(L[wh > 0.5]):.4f} → {np.median(L2[wh > 0.5]):.4f}')
    g.set_acc(a['_FURLEN'], L2.astype(np.float32))


# ───────────────────────── подводка и ресницы ─────────────────────────
ROWS = 11
LASH_SEG = 12
LASH = np.array([0.008, 0.008, 0.014])


def liner(g):
    j = g.j
    for n in j['nodes']:
        nm = n.get('name', '')
        if not (nm.startswith('LidUp_') or nm.startswith('LidLo_')) or 'mesh' not in n:
            continue
        pr = j['meshes'][n['mesh']]['primitives'][0]
        c = g.acc(pr['attributes']['COLOR_0']).astype(np.float64)
        nv = len(c)
        nu = next((nv // ROWS - k for k in range(0, 4) if (nv - (nv // ROWS - k) * ROWS) % LASH_SEG == 0 and nv // ROWS - k > 0), None)
        fur = c[5 * nu:6 * nu, :3].copy()
        up = nm.startswith('LidUp_')
        ks = [1.0, 0.85, 0.35, 0.08, 0.0] if up else [0.55, 0.2, 0.0]
        for r in range(5):
            k = ks[r] if r < len(ks) else 0.0
            c[r * nu:(r + 1) * nu, :3] = LASH * k + fur * (1 - k)
        g.set_acc(pr['attributes']['COLOR_0'], c.astype(np.float32))
        extra = nv - nu * ROWS
        if up and extra:
            pa = pr['attributes']['POSITION']
            P = g.acc(pa).astype(np.float64)
            segs = list(range(nu * ROWS, nv, LASH_SEG))
            # три штриха: тоньше у корня и к кончику, длиннее, веером (каждый следующий — дальше наружу)
            for si, b0 in enumerate(segs):
                seg = P[b0:b0 + LASH_SEG]
                root = seg[:2].mean(0)
                d = seg - root
                # сечения по 2 вершины: ширина пары — к 0.55, длина — ×1.15
                pairs = d.reshape(-1, 2, 3)
                mid = pairs.mean(1, keepdims=True)
                pairs = mid * 1.15 + (pairs - mid) * 0.55
                seg[:] = root + pairs.reshape(-1, 3)
            g.set_acc(pa, P.astype(np.float32))
            print(f'  {nm}: подводка {ks}, ресницы — {len(segs)} штриха тоньше и длиннее')
        else:
            print(f'  {nm}: подводка {ks}')


# ───────────────────────── форма головы и глаза ─────────────────────────
class Field:
    """сумма гладких полей: f(p) = p + Σ dᵢ(p)"""

    def __init__(self, parts):
        self.parts = parts

    def __call__(self, P):
        P = np.asarray(P, np.float64)
        one = P.ndim == 1
        Q = P[None] if one else P
        out = Q.copy()
        for f in self.parts:
            out = out + f(Q)
        return out[0] if one else out

    def jac(self, P, h=1e-5):
        P = np.asarray(P, np.float64)
        Jm = np.zeros((len(P), 3, 3))
        for k in range(3):
            e = np.zeros(3); e[k] = h
            Jm[:, :, k] = (self(P + e) - self(P - e)) / (2 * h)
        return Jm


def head_field(g, eyes=True, head=True):
    mk, D = head_frame(g)
    eL, eR = np.array(mk['eyeOuterL']), np.array(mk['eyeOuterR'])
    iL, iR = np.array(mk['eyeInnerL']), np.array(mk['eyeInnerR'])
    ey = (eL[1] + eR[1]) / 2
    nose = np.array(mk['nose'])
    parts = []
    if head:
        # центр головы: под межглазьем, глубже морды
        c = np.array([0.0, ey - 0.12 * D, nose[2] - 0.75 * D])

        def jowls(Q):
            # ниже глаз и сбоку: к оси головы (|x| меньше), сильнее у края силуэта; по высоте — от уровня рта до глаз
            q = Q - c
            ax = np.abs(q[:, 0])
            wy = np.exp(-((Q[:, 1] - (ey - 0.42 * D)) / (0.34 * D)) ** 2)
            wx = sstep(0.42 * D, 0.82 * D, ax)
            wz = sstep(nose[2] - 1.6 * D, nose[2] - 1.0 * D, Q[:, 2])  # не затылок
            d = np.zeros_like(Q)
            d[:, 0] = -np.sign(q[:, 0]) * 0.085 * D * wx * wy * wz
            return d

        def temples(Q):
            # виски и темя над глазами: чуть шире — круг
            q = Q - c
            ax = np.abs(q[:, 0])
            # не выше ~0.3 D над глазами: там бант и звёзды-заколки (иначе голова входит в бант)
            wy = np.exp(-((Q[:, 1] - (ey + 0.08 * D)) / (0.2 * D)) ** 2) * sstep(ey + 0.32 * D, ey + 0.2 * D, Q[:, 1])
            wx = sstep(0.3 * D, 0.62 * D, ax) * (1 - sstep(0.75 * D, 0.95 * D, ax))
            d = np.zeros_like(Q)
            d[:, 0] = np.sign(q[:, 0]) * 0.035 * D * wx * wy
            return d
        parts += [jowls, temples]
    if eyes:
        for o, i in ((eL, iL), (eR, iR)):
            ce = (o + i) / 2
            s_ = 'L' if o is eL else 'R'
            ce[1] = (mk['eyeTop' + s_] + mk['eyeBottom' + s_][1]) / 2
            ce[2] -= 0.12 * D
            rad = np.linalg.norm(o - i) / 2

            def eye(Q, ce=ce, rad=rad):
                q = Q - ce
                r = np.linalg.norm(q / np.array([1.0, 1.1, 1.3]), axis=1) / rad
                w = 1 - sstep(1.05, 2.1, r)
                return -q * ((1 - EYE_K) * w)[:, None]
            parts.append(eye)
    return Field(parts), D


def smooth_head(g, iters=24):
    """«иглы» сетки Tripo по силуэту щёк и боков головы (вылепленные пучки) — сгладить (Taubin, без усадки) только там:
    вес Head, сбоку/сзади, ниже ушей и банта, в стороне от глаз, носа, рта. Сетка тела и оболочек меха — общие буферы."""
    from mesh_parts import weld
    from scipy.sparse import coo_matrix, diags
    j = g.j
    mk, D = head_frame(g)
    bi, b = g.main_mesh()
    a = b['attributes']
    P = g.acc(a['POSITION']).astype(np.float64)
    N = g.acc(a['NORMAL']).astype(np.float64)
    I = g.acc(b['indices']).reshape(-1, 3).astype(np.int64)
    J = g.acc(a['JOINTS_0']); Wt = g.acc(a['WEIGHTS_0'])
    jn = joint_names(j)
    hid = [k for k, n in enumerate(jn) if n in ('mixamorig:Head', 'mixamorig:HeadTop_End')]
    wh = (np.isin(J, hid) * Wt).sum(1)
    w = weld(P)
    nW = w.max() + 1
    Pw = np.zeros((nW, 3)); np.add.at(Pw, w, P); cnt = np.bincount(w, minlength=nW); Pw /= cnt[:, None]
    whw = np.zeros(nW); np.maximum.at(whw, w, wh)
    T = w[I]
    T = T[(T[:, 0] != T[:, 1]) & (T[:, 1] != T[:, 2]) & (T[:, 0] != T[:, 2])]
    e = np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]]); e = np.concatenate([e, e[:, ::-1]])
    A = coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(nW, nW)).tocsr(); A.data[:] = 1
    deg = np.asarray(A.sum(1)).ravel()
    Dinv = diags(1 / np.maximum(deg, 1))
    ey = (mk['eyeOuterL'][1] + mk['eyeOuterR'][1]) / 2
    nose = np.array(mk['nose'])
    feats = [np.array(mk[k]) for k in ('eyeOuterL', 'eyeOuterR', 'eyeInnerL', 'eyeInnerR', 'nose', 'mouthL', 'mouthR')]
    dfe = np.min([np.linalg.norm(Pw - f, axis=1) for f in feats], axis=0)
    reg = sstep(0.9, 1.0, whw) * sstep(0.25 * D, 0.5 * D, dfe) * sstep(ey + 0.35 * D, ey + 0.2 * D, Pw[:, 1])
    side = np.maximum(sstep(0.3 * D, 0.55 * D, np.abs(Pw[:, 0])), sstep(nose[2] - 0.7 * D, nose[2] - 1.0 * D, Pw[:, 2]))
    reg *= side
    X = Pw.copy()
    for it in range(iters):
        for lam in (0.55, -0.58):
            L = Dinv @ (A @ X) - X
            X = X + lam * reg[:, None] * L
    d = X - Pw
    print(f'  силуэт головы: сглажено {int((reg > 0.05).sum())} вершин, сдвиг до {np.linalg.norm(d, axis=1).max() * 1000:.1f} мм '
          f'(медиана в зоне {np.median(np.linalg.norm(d[reg > 0.5], axis=1)) * 1000:.2f} мм)')
    P2 = P + d[w]
    # нормали: по граням сваренной сетки в зоне, остальные — как были
    fn = np.cross(X[T[:, 1]] - X[T[:, 0]], X[T[:, 2]] - X[T[:, 0]])
    Nw = np.zeros((nW, 3))
    for k in range(3):
        np.add.at(Nw, T[:, k], fn)
    Nw /= np.maximum(np.linalg.norm(Nw, axis=1, keepdims=True), 1e-12)
    kk = np.clip(reg[w] * 1.5, 0, 1)[:, None]
    N2 = N * (1 - kk) + Nw[w] * kk
    N2 /= np.maximum(np.linalg.norm(N2, axis=1, keepdims=True), 1e-12)
    g.set_acc(a['POSITION'], P2.astype(np.float32))
    g.set_acc(a['NORMAL'], N2.astype(np.float32))


def reshape(g, eyes, head):
    F, D = head_field(g, eyes, head)
    bi, b = g.main_mesh()
    P = g.acc(b['attributes']['POSITION']).astype(np.float64)
    hsel = P[:, 1] > 0.5
    Jd = np.linalg.det(F.jac(P[hsel]))
    print(f'  поле головы (щёки внутрь, виски шире{", глаза ×" + str(EYE_K) if eyes else ""}): якобиан {Jd.min():.3f}…{Jd.max():.3f}, '
          f'сдвиг до {np.linalg.norm(F(P[hsel]) - P[hsel], axis=1).max() * 1000:.1f} мм')
    assert Jd.min() > 0.3
    apply_field(g, F, D, 1.0, ('headRound1123', {'eyes': EYE_K if eyes else 1, 'head': int(head)}))


def badge(g):
    """значок на груди слева: был мятный «шар» с кольцом (cat_look.py) → по рефу маленький лиловый круг, мятное кольцо,
    золотой ободок и мятная галочка. Только альбедо (цвета — в тонах атласа: худи, мята и золото тонирует furTone)."""
    from glb_io import raster_uv
    from PIL import Image, ImageDraw
    from mesh_parts import tri_colors
    from face_geom import jpeg_fit, img_bytes
    j = g.j
    bi, b = g.main_mesh()
    A = b['attributes']
    P = g.acc(A['POSITION']).astype(np.float64)
    N = g.acc(A['NORMAL']).astype(np.float64)
    UV = g.acc(A['TEXCOORD_0']).astype(np.float64)
    I = g.acc(b['indices']).reshape(-1, 3).astype(np.int64)
    C = P[I].mean(1)
    col = tri_colors(g, b, I)
    box = (C[:, 2] > 0.08) & (C[:, 1] > 0.42) & (C[:, 1] < 0.495) & (C[:, 0] > 0.035) & (C[:, 0] < 0.1)
    gr = box & (col[:, 1] > col[:, 0] + 0.08)
    c = C[gr].mean(0)
    R = 0.0285
    near = (np.hypot(C[:, 0] - c[0], C[:, 1] - c[1]) < R * 1.5) & (C[:, 2] > 0.07)
    mat = j['materials'][b['material']]
    ib = j['textures'][mat['pbrMetallicRoughness']['baseColorTexture']['index']]['source']
    base = np.asarray(g.image(ib).convert('RGB')).astype(np.float32)
    S = base.shape[0]
    pos, nrm, tid = raster_uv(P, N, UV, I[near], S)
    front = (tid >= 0) & (nrm[..., 2] > 0.1)
    x, y = pos[..., 0] - c[0], pos[..., 1] - c[1]
    d = np.hypot(x, y)
    # картинка значка в плоскости груди (суперсэмплинг)
    px = 1200; sc = px / (2 * R)
    im = Image.new('RGB', (px, px), (175, 138, 210))
    dr = ImageDraw.Draw(im)
    o = px / 2
    circ = lambda r, fill: dr.ellipse([o - r * sc, o - r * sc, o + r * sc, o + r * sc], fill=fill)
    circ(0.0215, (226, 200, 140))        # золотой ободок
    circ(0.0188, (139, 185, 185))        # мятное кольцо
    circ(0.0150, (160, 124, 198))        # лиловая середина (чуть темнее худи)
    to = lambda u, v: (o + u * sc, o - v * sc)
    pts = [to(-0.0075, 0.0005), to(-0.0022, -0.0052), to(0.0082, 0.0062)]
    dr.line(pts, fill=(139, 185, 185), width=int(0.0034 * sc), joint='curve')
    for p in (pts[0], pts[-1]):
        rr = 0.0017 * sc
        dr.ellipse([p[0] - rr, p[1] - rr, p[0] + rr, p[1] + rr], fill=(139, 185, 185))
    im = im.resize((300, 300), Image.LANCZOS)
    L = np.asarray(im).astype(np.float32)
    s2 = 300 / (2 * R)
    u = np.clip((x * s2 + 150).astype(int), 0, 299)
    v = np.clip((-y * s2 + 150).astype(int), 0, 299)
    a = (1 - sstep(R - 0.0015, R, d)) * front
    # фон значка за кругом — ткань худи вокруг (медиана кольца снаружи), а не ровный цвет атласа
    ring = front & (d > R * 1.05) & (d < R * 1.35)
    cloth = np.median(base[ring], axis=0)
    paint = L[v, u]
    bg = np.all(np.abs(paint - np.array([175, 138, 210])) < 2, axis=-1)
    paint[bg] = cloth
    # лёгкая фактура ткани поверх
    paint = paint * (0.97 + 0.06 * (base.mean(-1, keepdims=True) / max(cloth.mean(), 1) - 1).clip(-0.5, 0.5))
    base = base * (1 - a[..., None]) + paint * a[..., None]
    q, nb = jpeg_fit(g, ib, Image.fromarray(np.clip(base, 0, 255).astype(np.uint8)), img_bytes(g, ib))
    print(f'  значок: центр {np.round(c, 4)}, R {R * 1000:.1f} мм, текселей {int((a > 0.5).sum())}; альбедо JPEG q{q} ({nb} байт)')


def main():
    src, dst = sys.argv[1:3]
    fl = set(sys.argv[3:])
    if '--all' in fl:
        fl |= {'--cards', '--furlen', '--liner', '--head', '--eyes', '--legs', '--badge'}
    g = Glb(src)
    br = g.j['nodes'][node_by_name(g.j, 'Brows')]
    if 'ref1123' in br.get('extras', {}):
        sys.exit('glitter_ref: уже применено (extras.ref1123)')
    if '--cards' in fl:
        cards(g)
    if '--furlen' in fl:
        furlen(g)
    if '--liner' in fl:
        liner(g)
    if '--badge' in fl:
        badge(g)
    if '--head' in fl:
        smooth_head(g)
    if '--head' in fl or '--eyes' in fl:
        reshape(g, '--eyes' in fl, '--head' in fl)
    br['extras']['ref1123'] = sorted(f.strip('-') for f in fl)
    n = g.save(dst)
    print(f'glitter_ref: {dst} — {n} байт')


if __name__ == '__main__':
    main()

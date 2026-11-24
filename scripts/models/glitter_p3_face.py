"""Блёстка p3, третий проход (24.11): лицо заново по рефу продакта — свои глаза, брови, рамка рта под риг face_rig.py.

Вызывается из glitter_p3.py, когда части собраны с `glitter_p3_parts.py --face kit` (глаза, брови, рот и «морда»
Tripo выброшены, в голове — дыры глазниц с краем = разрез глаза Tripo; рот, морда и брови — заплатки):

  resurface()   — морда: ровная поверхность (поле высот по меху головы вокруг, без впадины рта и заплаток) на месте рта,
                  морды и бровей; глазницы — крупнее (разрез ×EYE_K к центру глаза), щёки-подушечки усов по рефу.
  build_face()  — глаза: Eye_L/R → EyeS_* (масштаб эллипсоида A, B, C) → EyeBall_* (белок, зелёная радужка, зрачок —
                  текстура по рефу), LidUp_* (мягкое веко: 11 рядов LID_ROWS + 4 лепестка ресниц у внешнего уголка,
                  подводка), LidLo_*, Tear_* — те же имена и extras, что ждёт src/character/eyeRig.ts; узел Brows — разметка
                  лица marks (без сетки: брови — мех текстуры и ключи кожи); узел MouthD — только рамка рта (extras.mouth:
                  линия губ «ω» по design/sheets/mouths.jpg) для scripts/models/face_rig.py.
  body_keys()   — ключи кожи, которые face_rig переносит на FaceSkin: brow_up/down/sad, cheek_up, cheeks_gum, nose_wrinkle.
  paint_ref()   — текстура морды по рефу: брови — мягкие тёмные дуги меха, белая морда и подушечки усов, без светлой
                  вертикальной линии на подбородке.
Ничего из лица p1 не берётся (от p1 — только скелет и узлы-родители).
"""
import math
import os
import numpy as np
from PIL import Image
from scipy.spatial import cKDTree

from face_detail import (lid_mesh, eye_texture, add_mesh, add_material, add_node, mat2quat, orient, tear_mesh,
                         norm, IRIS)
from glb_io import raster_uv

PERSONA = 'glitter'
# веки p3 — свой тон и ресницы в eyeRig.ts (LID_FUR/LID_LASH 'glitter_p3')
EYE_PERSONA = 'glitter_p3'
# радужка по рефу (sRGB): обод, середина, светлая часть у зрачка — пробы design/refs/glitter_turnaround_1123.png
IRIS['glitter_p3'] = ((34, 84, 50), (70, 150, 78), (128, 196, 100))
# разрез глаза относительно дыры Tripo: по рефу глаз меньше (ширина глаза ≈ 0.22 ширины головы, у Tripo ≈ 0.25);
# четвёртое — сдвиг к переносице (м): по наложению анфас на реф (тот же масштаб) радужки p3 на 34 % дальше друг от друга
EYE_K = (0.8, 1.0, -0.22, 0.022)
# ось глаза: нормаль плоскости края дыры с долей EYE_FWD «вперёд» (+Z). Меньше — край разреза ровнее по яблоку (у
# внешнего уголка он уходит за голову): моргание сходится по всему разрезу одним углом, линия ресниц — посередине глаза
EYE_FWD = 0.1
# яблоко: полуоси A (доля ширины разреза), B (доля высоты, не меньше 0.8 A), глубина C (доля A) — крупнее разреза,
# чтобы край дыры лежал на яблоке без глаз «навыкате»
EYE_BALL = (0.62, 0.72, 0.45)
# веко ярче пробы меха над глазом (у кожи вокруг — оболочки меха и подсветка, у века их нет): закрытый глаз = мех
LID_GAIN = (0.7, 1.4)
# насыщенность меха к рефу
FUR_SAT = 0.72
# брови: дуга над верхним краем глаза на BROW_Y·B (реф — высоко, мягкая тёмная дуга меха, не тёмная полоса)
BROW_Y = 0.6
# форма головы: ширина ×(1 + Σ доля·exp(−((y − y0)/σ)²)) — по наложению анфас на реф в одном масштабе
# (tools/glitter-p3-face-sheet.py): щёки на уровне глаз и над ними шире (только у края силуэта), «брыли» у подбородка уже (подбородок выше)
HEAD_X = ((0.13, 0.715, 0.035), (0.09, 0.79, 0.05), (-0.15, 0.578, 0.035), (-0.03, 0.645, 0.025))
# верхнее веко в покое (доля закрытия): по рефу касается радужки сверху, не закрывая её (наложение анфас); подводка и
# лепестки ресниц — ниже кромки кожи, видны целиком
REST_UP = 0.1
# радужка: радиус в долях полувысоты разреза (реф — радужка ≈ 0.6 высоты открытого глаза, по наложению), зрачок — доля радужки
IRIS_K, PUPIL = 1.0, 0.5
# подводка и ресницы (линейный цвет): реф ≈ #29313F
LASH = np.array([0.022, 0.03, 0.05])
# ширина рта (W) в долях расстояния между центрами глаз: реф mouths.jpg/разворот ≈ 0.7
MOUTH_W = 0.5
# подразбиение у рта в face_rig.py (морда уже ≈ 3 мм у рта): одна узкая зона вдоль губ
SUBDIV_P3 = [[0.66, 0.2, -0.03, 0.35]]
# линия губ «ω» в долях W (u, v): уголки вверх, у фильтрума — бугорок вверх (реф mouths.jpg, сомкнутая улыбка)
def mouth_line(n=29):
    u = np.linspace(-0.5, 0.5, n)
    v = 0.11 * (2 * np.abs(u)) ** 2.2 - 0.075 + 0.05 * np.exp(-(u / 0.07) ** 2)
    return np.stack([u, v], 1)


def sm(e0, e1, x):
    t = np.clip((np.asarray(x, np.float64) - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def srgb2lin(c):
    c = np.asarray(c, np.float64) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


# ───────────────────────── поверхность морды ─────────────────────────
def rims(face):
    out = {}
    for s in 'LR':
        ks = sorted(k for k in face if k.startswith(f'eyeRim{s}'))
        if ks:
            out[s] = np.array([face[k] for k in ks], np.float64)
    return out


def eye_center(rim):
    return rim.mean(0)


def resurface(V, F, role, capt, face, nv_land=None):
    """V (n,3) сетки после выравнивания (лишние точки меток — в конце, их тоже двигаем) → новая V и face.
    1) глазницы крупнее (EYE_K) — радиальное поле вокруг центра каждой дыры (край дыры = разрез);
    2) морда: z = поле высот, подогнанное по меху головы вокруг (без впадины рта, заплаток и носа), плавно к краю;
    3) подушечки усов — две мягкие выпуклости над уголками рта (реф: белые щёчки «ω»)."""
    V = V.copy()
    R = rims(face)
    fur = np.zeros(len(V), bool)
    if role is not None:
        rv = np.full(len(V), '', dtype=object)
        for k in range(3):
            rv[F[:, k]] = role
        fur = rv == 'fur'
    head = fur & (V[:, 1] > 0.5)
    allp = np.r_[V, np.array([face[k] for k in sorted(face)])]
    keys = sorted(face)
    nV = len(V)
    # 0) голова по рефу: щёки на уровне глаз шире, «брыли» у подбородка уже (у Tripo голова грушей)
    hv = np.r_[head, np.zeros(len(allp) - nV, bool)] | (np.arange(len(allp)) >= nV)
    y_ = allp[:, 1]
    # расширение — только к краю силуэта (|x| > 0.1): глаза и рот на месте
    side = sm(0.1, 0.2, np.abs(allp[:, 0]))
    sx = 1 + sum(a * np.exp(-((y_ - y0) / sg) ** 2) * (side if a > 0 else 1) for a, y0, sg in HEAD_X)
    allp[hv, 0] *= sx[hv]
    # 1) глазницы: сдвиг в плоскости xy от центра дыры (край дыры → ×k), спад к 2.2 радиуса
    kx, ky, up = EYE_K[:3]
    for s, rim in R.items():
        c = rim.mean(0)
        rx = np.abs(rim[:, 0] - c[0]).max(); ry = np.abs(rim[:, 1] - c[1]).max()
        d = (allp[:, :2] - c[:2]) / [rx, ry]
        r = np.linalg.norm(d, axis=1)
        f = 1 - sm(1.0, 2.4, r)  # 1 внутри разреза, к 2.4 радиуса — 0
        front = allp[:, 2] > c[2] - 0.05
        f = f * front
        H = 2 * ry
        allp[:, 0] += ((allp[:, 0] - c[0]) * (kx - 1) - np.sign(c[0]) * EYE_K[3]) * f
        allp[:, 1] += ((allp[:, 1] - c[1]) * (ky - 1) + up * H) * f
    V = allp[:nV]
    face = {k: allp[nV + i] for i, k in enumerate(keys)}
    R = rims(face)
    # 2) поле высот морды
    nose = np.array(face['nose']); mc = np.array(face['mouthC'])
    ec = {s: R[s].mean(0) for s in R}
    eyeC = (ec['L'] + ec['R']) / 2
    capv = np.zeros(nV, bool)
    if capt is not None:
        capv[F[capt].ravel()] = True
    # область: эллипс от бровей до подбородка, |x| до внешних уголков глаз
    cx, cy = 0.0, (eyeC[1] + mc[1]) / 2 - 0.015
    ax_, ay_ = 0.175, 0.17
    rr = np.hypot((V[:, 0] - cx) / ax_, (V[:, 1] - cy) / ay_)
    reg = head & (rr < 1.0) & (V[:, 2] > 0.06)
    # глазницы и кольцо вокруг них не трогаем (край дыры — разрез глаза)
    eye_keep = np.zeros(nV, bool)
    eye_w = np.ones(nV)
    for s, rim in R.items():
        c = rim.mean(0)
        rx = np.abs(rim[:, 0] - c[0]).max(); ry = np.abs(rim[:, 1] - c[1]).max()
        r = np.hypot((V[:, 0] - c[0]) / rx, (V[:, 1] - c[1]) / ry)
        eye_keep |= r < 1.08
        eye_w = np.minimum(eye_w, sm(1.05, 1.9, r))
    # опоры поля: мех головы в области, не заплатки, не впадина рта (вокруг дыры рта), не под носом
    near_mouth = np.hypot((V[:, 0] - mc[0]) / 0.05, (V[:, 1] - mc[1]) / 0.035) < 1.0
    near_nose = np.hypot((V[:, 0] - nose[0]) / 0.03, (V[:, 1] - nose[1]) / 0.03) < 1.0
    sup = reg & ~capv & ~near_mouth & ~eye_keep & (eye_w > 0.5)
    from scipy.interpolate import RBFInterpolator
    P = V[sup]
    for it in range(3):
        f = RBFInterpolator(P[:, :2], P[:, 2], kernel='thin_plate_spline', smoothing=2e-4 * len(P))
        res = P[:, 2] - f(P[:, :2])
        keep = res > -0.003  # впадины (рот Tripo, складки) — прочь, поле идёт поверху
        if keep.all():
            break
        P = P[keep]
    zf = f(V[reg][:, :2])
    w = (1 - sm(0.72, 1.0, rr[reg])) * eye_w[reg]
    w = np.where(near_nose[reg], w * sm(0.6, 1.0, np.hypot((V[reg, 0] - nose[0]) / 0.03, (V[reg, 1] - nose[1]) / 0.03)), w)
    # заплатки рта/морды/бровей и впадина рта — целиком на поле
    w = np.where((capv | near_mouth)[reg] & ~eye_keep[reg], np.maximum(w, 0.999 * eye_w[reg]), w)
    z = V[reg, 2] + w * (zf - V[reg, 2])
    # 3) подушечки усов: две выпуклости над уголками рта, у фильтрума — ложбинка
    Wm = MOUTH_W * np.linalg.norm(ec['L'] - ec['R'])
    pads = np.zeros(reg.sum())
    for s_ in (1, -1):
        c = np.array([s_ * 0.24 * Wm, mc[1] + 0.12 * Wm])
        pads += np.exp(-(((V[reg, 0] - c[0]) / (0.3 * Wm)) ** 2 + ((V[reg, 1] - c[1]) / (0.2 * Wm)) ** 2))
    z += 0.035 * Wm * np.clip(pads, 0, 1.25) * (1 - sm(0.55, 0.85, rr[reg])) * eye_w[reg]
    V[reg, 2] = z
    face_new = {k: v for k, v in face.items()}

    def zfield(xy):
        xy = np.atleast_2d(xy)
        pd = np.zeros(len(xy))
        for s_ in (1, -1):
            c = np.array([s_ * 0.24 * Wm, mc[1] + 0.12 * Wm])
            pd += np.exp(-(((xy[:, 0] - c[0]) / (0.3 * Wm)) ** 2 + ((xy[:, 1] - c[1]) / (0.2 * Wm)) ** 2))
        rr_ = np.hypot((xy[:, 0] - cx) / ax_, (xy[:, 1] - cy) / ay_)
        ew = np.ones(len(xy))
        for s_, rim in R.items():
            c = rim.mean(0)
            rx = np.abs(rim[:, 0] - c[0]).max(); ry = np.abs(rim[:, 1] - c[1]).max()
            ew = np.minimum(ew, sm(1.05, 1.9, np.hypot((xy[:, 0] - c[0]) / rx, (xy[:, 1] - c[1]) / ry)))
        return f(xy) + 0.035 * Wm * np.clip(pd, 0, 1.25) * (1 - sm(0.55, 0.85, rr_)) * ew
    face_new['_field'] = zfield
    face_new['_region'] = (cx, cy, ax_, ay_)
    print(f'морда: поле высот по {len(P)} точкам, вершин {reg.sum()}, сдвиг медиана '
          f'{np.median(np.abs(zf - allp[:nV][reg, 2])) * 1000:.1f} мм; глазницы ×{kx}/{ky}')
    return V, face_new


# ───────────────────────── глаза ─────────────────────────
def eye_frames(face):
    """по краю дыры глазницы: центр, оси (r — вдоль X, f — нормаль разреза к лицу), разрез в координатах глаза"""
    out = {}
    for s, rim in rims(face).items():
        c = rim.mean(0)
        Q = rim - c
        _, _, vt = np.linalg.svd(Q)
        n = vt[2] if vt[2][2] > 0 else -vt[2]
        f = norm((1 - EYE_FWD) * n + EYE_FWD * np.array([0, 0, 1.0]))
        r = norm(np.array([1.0, 0, 0]) - f * f[0])
        u = np.cross(f, r)
        Rm = np.stack([r, u, f], 1)
        q = Q @ Rm
        out[s] = dict(c=c, R=Rm, q=q)
    return out


def arcs(q, n=40):
    """контур (петля) → верхняя и нижняя дуги как функции x: (xs, y_top, y_bot, z_top, z_bot)"""
    i0, i1 = int(np.argmin(q[:, 0])), int(np.argmax(q[:, 0]))
    L = len(q)
    a = [q[(i0 + k) % L] for k in range(((i1 - i0) % L) + 1)]
    b = [q[(i1 + k) % L] for k in range(((i0 - i1) % L) + 1)]
    a, b = np.array(a), np.array(b)
    top, bot = (a, b) if a[:, 1].mean() > b[:, 1].mean() else (b, a)
    xs = np.linspace(q[i0, 0], q[i1, 0], n)
    ot, ob = np.argsort(top[:, 0]), np.argsort(bot[:, 0])
    yt = np.interp(xs, top[ot, 0], top[ot, 1]); yb = np.interp(xs, bot[ob, 0], bot[ob, 1])
    zt = np.interp(xs, top[ot, 0], top[ot, 2]); zb = np.interp(xs, bot[ob, 0], bot[ob, 2])
    return xs, yt, yb, zt, zb


def build_eyes(g, head_node, IBM, face, color_at):
    """новые глаза в дыры глазниц: эллипсоид A×B×C, край век = край дыры; см. шапку модуля"""
    eyes = {}
    for s, E in eye_frames(face).items():
        xs, yt, yb, zt, zb = arcs(E['q'])
        # сгладить (у Tripo край дыры — 27 вершин)
        for arr in (yt, yb, zt, zb):
            for _ in range(4):
                arr[1:-1] = 0.25 * arr[:-2] + 0.5 * arr[1:-1] + 0.25 * arr[2:]
        W = xs[-1] - xs[0]
        x0 = (xs[0] + xs[-1]) / 2
        H = yt - yb
        midm = np.abs(xs - x0) < 0.2 * W
        z0 = ((yt + yb) / 2)[midm].mean()
        A = EYE_BALL[0] * W
        B = max(EYE_BALL[1] * H.max(), 0.8 * A)
        C = EYE_BALL[2] * A
        need = []
        for xv, yv, zv in list(zip(xs, yt, zt)) + list(zip(xs, yb, zb)):
            uu = (xv - xs[0]) / W
            if uu < 0.12 or uu > 0.88:
                continue
            ss = min(((xv - x0) / A) ** 2 + ((yv - z0) / B) ** 2, 0.97)
            need.append(zv + 0.0012 + C * (1 - math.sqrt(1 - ss)))
        P = float(max(need))
        Ol = np.array([x0, z0, P - C])
        O = E['c'] + E['R'] @ Ol

        def ang(x, y, z):
            U = (np.stack([x, y, z], 1) - Ol) / np.array([A, B, C])
            Ln = np.linalg.norm(U, axis=1)
            return np.arcsin(np.clip(U[:, 0] / Ln, -1, 1)), np.arctan2(U[:, 1], U[:, 2])
        at, tt = ang(xs, yt, zt); ab, tb = ang(xs, yb, zb)
        a_lo = max(at.min(), ab.min()); a_hi = min(at.max(), ab.max())
        ag = np.concatenate([np.linspace(-1.5, a_lo, 5)[:-1], np.linspace(a_lo, a_hi, 30), np.linspace(a_hi, 1.5, 5)[1:]])
        th_t = np.interp(ag, at, tt); th_b = np.interp(ag, ab, tb)
        e_lo = (np.interp(a_lo, at, tt) + np.interp(a_lo, ab, tb)) / 2
        e_hi = (np.interp(a_hi, at, tt) + np.interp(a_hi, ab, tb)) / 2
        for k, a in enumerate(ag):
            if a < a_lo:
                th_t[k] = th_b[k] = e_lo
            elif a > a_hi:
                th_t[k] = th_b[k] = e_hi
        for arr in (th_t, th_b):
            for _ in range(2):
                arr[1:-1] = 0.25 * arr[:-2] + 0.5 * arr[1:-1] + 0.25 * arr[2:]
        inside = (ag >= a_lo) & (ag <= a_hi)
        gap = (th_t - th_b)[inside].max()
        Hc = H[midm].mean()
        Ri = min(max(0.5 * Hc * IRIS_K, 0.46 * A), 0.74 * B)
        top3 = E['c'] + np.stack([xs, yt, zt], 1) @ E['R'].T
        bot3 = E['c'] + np.stack([xs, yb, zb], 1) @ E['R'].T
        eyes[s] = dict(O=O, R=E['R'], A=A, B=B, C=C, ag=ag, th_t=th_t, th_b=th_b, close_up=0.68 * gap + 0.07,
                       close_lo=0.32 * gap + 0.07, Ri=Ri, P=P, W=W, H=Hc, top3=top3, bot3=bot3)
    A_ = np.mean([eyes[s]['A'] for s in eyes]); B_ = np.mean([eyes[s]['B'] for s in eyes])
    Ri = np.mean([eyes[s]['Ri'] for s in eyes])
    rx, ry = Ri / A_, Ri / B_
    img = eye_texture('glitter_p3', rx, ry, PUPIL)
    ii = g.add_image(img, 'eye_iris_p3')
    ti = g.add_texture(ii)
    m_eye = add_material(g, 'EyeBall_mat', tex=ti, rough=0.12)
    # веко p3 — текстура морды (атлас тела, UV — блок морды по месту закрытого века): закрытый глаз = мех вокруг, тот же
    # тон и шум; атлас и шин тела подставляет glitter_p3.py (extras.lidUV); вершинный цвет — 1 (мех) и подводка
    m_lid = add_material(g, 'EyeLid_mat', rough=0.78, double=True)
    g.j['materials'][m_lid]['extras']['lidUV'] = 1
    NA_, NP = 40, 24
    V, Nn, UV = [], [], []
    for pi_ in range(NP + 1):
        ph = math.pi * pi_ / NP
        for ai in range(NA_):
            la = 2 * math.pi * ai / NA_
            v = np.array([math.sin(ph) * math.cos(la), math.sin(ph) * math.sin(la), math.cos(ph)])
            V.append(v); Nn.append(v)
            rr = math.sin(min(ph, math.pi / 2))
            UV.append((0.5 + 0.5 * rr * math.cos(la), 0.5 - 0.5 * rr * math.sin(la)))
    from face_detail import grid_faces
    V = np.array(V); Nn = np.array(Nn)
    Fb = orient(V, grid_faces(NA_, NP + 1, wrap_u=True), Nn)
    m_ball = add_mesh(g, 'EyeBall', V, Nn, Fb, m_eye, uv=np.array(UV))
    IR = IBM[:3, :3]; It = IBM[:3, 3]
    for side, E in eyes.items():
        outer = 1 if side == 'L' else -1
        cu = color_at(E['top3'] + np.array([0, 0.006, 0.003])) * LID_GAIN[0]
        cl = color_at(E['bot3'] - np.array([0, 0.01, -0.004])) * LID_GAIN[1]
        Vl, Nl, Fl = lid_mesh(E['ag'], E['th_t'], True)
        nu = len(E['ag'])
        # мех века — из текстуры морды (вершинный цвет 1); кромочные ряды рантайм (softLidGeometry) берёт с ряда 4
        col = np.ones((len(Vl), 3))
        # ресницы: 4 загнутых лепестка у внешней половины (реф: длинные, вверх-наружу, кончики загнуты)
        exV, exF, exC, exN = [], [], [], []
        amax = E['ag'][(E['ag'] > -1.4) & (E['ag'] < 1.4)]
        # (третий проход, 24.11: длиннее и наружу от кожи — у прежних из-под кромки кожи торчали только кончики)
        for k, (a_rel, ln, wd_) in enumerate([(0.42, 0.55, 0.075), (0.6, 0.72, 0.095), (0.76, 0.82, 0.1), (0.9, 0.7, 0.09)]):
            target = outer * a_rel * np.abs(amax).max()
            ai = int(np.argmin(np.abs(E['ag'] - target)))
            a = E['ag'][ai]; te = E['th_t'][ai]
            base = len(Vl) + len(exV)
            pts = []
            for s_ in np.linspace(0, 1, 7):
                th = te + 0.04 + s_ * 0.42
                r = 1.08 + s_ * ln * 0.85
                aa = a + outer * s_ * (0.22 + 0.25 * a_rel)
                p = np.array([r * math.sin(aa), r * math.cos(aa) * math.sin(th), r * math.cos(aa) * math.cos(th)])
                p[1] += s_ * s_ * ln * 0.32
                pts.append(p)
            pts = np.array(pts)
            for si, p in enumerate(pts):
                w = wd_ * (1 - si / 6) ** 0.8 + 0.006
                tng = pts[min(si + 1, 6)] - pts[max(si - 1, 0)]
                sv = norm(np.cross(tng, p))
                exV += [p - sv * w, p + sv * w]; exN += [norm(p), norm(p)]; exC += [LASH, LASH]
            for si in range(6):
                a0 = base + si * 2
                exF += [(a0, a0 + 1, a0 + 3), (a0, a0 + 3, a0 + 2)]
        Vl = np.concatenate([Vl, np.array(exV)]); Nl = np.concatenate([Nl, np.array(exN)])
        col = np.concatenate([col, np.array(exC)]); Fl = orient(Vl, list(Fl) + exF, Nl)
        m_up = add_mesh(g, f'LidUp_{side}', Vl, Nl, Fl, m_lid, col=col, uv=lid_uv(E, Vl, E['close_up']))
        V2, N2, F2 = lid_mesh(E['ag'], E['th_b'], False)
        col2 = np.ones((len(V2), 3))
        F2 = orient(V2, F2, N2)
        m_lo = add_mesh(g, f'LidLo_{side}', V2, N2, F2, m_lid, col=col2, uv=lid_uv(E, V2, -E['close_lo']))
        Rl = IR @ E['R']
        tl = IR @ E['O'] + It
        ex = {'side': side, 'A': E['A'], 'B': E['B'], 'C': E['C'], 'closeUp': E['close_up'], 'closeLo': E['close_lo'],
              'irisUV': [0.5 * rx, 0.5 * ry], 'pupil': PUPIL, 'persona': EYE_PERSONA, 'restUp': REST_UP, 'p3': 1}
        ne = add_node(g, head_node, f'Eye_{side}', t=tl, r=mat2quat(Rl), extras=ex)
        ns = add_node(g, ne, f'EyeS_{side}', s=[E['A'], E['B'], E['C']])
        add_node(g, ns, f'EyeBall_{side}', mesh=m_ball)
        add_node(g, ns, f'LidUp_{side}', mesh=m_up)
        add_node(g, ns, f'LidLo_{side}', mesh=m_lo)
        ai = int(np.argmin(np.abs(E['ag'] - outer * 0.3)))
        a_, th_ = E['ag'][ai], E['th_b'][ai] - 0.2
        pt = np.array([math.sin(a_), math.cos(a_) * math.sin(th_), math.cos(a_) * math.cos(th_)]) * 1.06 * np.array([E['A'], E['B'], E['C']])
        pt[2] += 0.45 * E['C']
        add_node(g, ne, f'Tear_{side}', mesh=tear_mesh(g, E['A']), t=pt, extras={'tear': True})
        print(f'  глаз {side}: углы {E["ag"][[0,-1]].round(2)}, край верх {E["th_t"].min():.2f}..{E["th_t"].max():.2f} низ {E["th_b"].min():.2f}..{E["th_b"].max():.2f}; A={E["A"]:.4f} B={E["B"]:.4f} C={E["C"]:.4f} выступ {E["P"] * 1000:.1f} мм, '
              f'закрытие {E["close_up"]:.2f}/{E["close_lo"]:.2f}, радужка {E["Ri"]:.4f}')
    return eyes


def lid_uv(E, Vl, ang):
    """UV века: вершина в положении «глаз закрыт» (поворот вокруг X на ang, как EyeRig: верхнее +closeUp, нижнее
    −closeLo) → меш (O + R·diag(A, B, C)·v) → блок морды в атласе (вид спереди)"""
    c, s_ = math.cos(ang), math.sin(ang)
    Rx = np.array([[1, 0, 0], [0, c, -s_], [0, s_, c]])
    P = E['O'] + ((Vl @ Rx.T) * np.array([E['A'], E['B'], E['C']])) @ E['R'].T
    return block_uv(P)


# ───────────────────────── разметка, рамка рта ─────────────────────────
def face_marks(eyes, face, marks1, surf_z):
    """Brows.extras.marks (их читают furTone, faceWrinkles, face_rig): углы глаз — по векам, рот — по новой ширине"""
    m = {k: v for k, v in marks1.items() if k in ('s', 'noseHalfW')}
    for s, E in eyes.items():
        t3, b3 = E['top3'], E['bot3']
        ends = np.r_[t3[[0, -1]], b3[[0, -1]]]
        ox = ends[np.argmax(np.abs(ends[:, 0]))]; ix = ends[np.argmin(np.abs(ends[:, 0]))]
        m[f'eyeOuter{s}'] = [round(float(x), 5) for x in ox]
        m[f'eyeInner{s}'] = [round(float(x), 5) for x in ix]
        m[f'eyeBottom{s}'] = [round(float(x), 5) for x in b3[np.argmin(b3[:, 1])]]
        m[f'eyeTop{s}'] = float(t3[:, 1].max())
    m['nose'] = [round(float(x), 5) for x in face['nose']]
    m['noseTop'] = [round(float(x), 5) for x in face['noseTop']]
    ec = (np.array(face['irisL']) + np.array(face['irisR'])) / 2
    Wm = MOUTH_W * abs(eyes['L']['O'][0] - eyes['R']['O'][0])
    my = float(face['mouthC'][1]) - 0.002
    for s, sx in (('L', 1), ('R', -1)):
        x = sx * 0.5 * Wm
        y = my + mouth_line()[-1, 1] * Wm
        m[f'mouth{s}'] = [round(x, 5), round(y, 5), round(float(surf_z(x, y)), 5)]
    zc = float(surf_z(0.0, my))
    m['mouth'] = [0.0, round(my + 0.005, 5), round(zc - 0.62 * Wm, 5)]
    return m, Wm, my, zc


def mouth_frame(j, md_node, head_node, IBM, Wm, my, nose_y, persona_jaw):
    """рамка рта для face_rig.py (extras.mouth узла MouthD): o — центр рта в системе кости Head, line — «ω» в долях W"""
    o_mesh = np.array([0.0, my, 0.0])
    o = IBM[:3, :3] @ o_mesh + IBM[:3, 3]
    exv = IBM[:3, :3] @ np.array([1.0, 0, 0]); eyv = IBM[:3, :3] @ np.array([0, 1.0, 0])
    n = j['nodes'][md_node]
    n.pop('mesh', None)
    n['extras'] = {'mouth': {'o': [round(float(x), 6) for x in o], 'ex': [round(float(x), 6) for x in exv],
                             'ey': [round(float(x), 6) for x in eyv], 'W': float(Wm),
                             'nose': round(float((nose_y - my) / Wm), 4), 'jaw': persona_jaw,
                             'line': [[round(float(u), 4), round(float(v), 4)] for u, v in mouth_line()],
                             'persona': PERSONA, 'p3': 1, 'subdiv': SUBDIV_P3}}


# ───────────────────────── ключи кожи (переносит face_rig на FaceSkin) ─────────────────────────
def body_keys(V, eyes, marks, Wm, headw):
    """brow_up/down/sad (мех бровей), cheek_up, cheeks_gum (щёки надуты — «обиделась»), nose_wrinkle; только голова спереди"""
    def g2(c, rx, ry):
        return np.exp(-(((V[:, 0] - c[0]) / rx) ** 2 + ((V[:, 1] - c[1]) / ry) ** 2))
    front = sm(0.03, 0.09, V[:, 2]) * np.clip(headw, 0, 1)
    out = {}
    brow_y = {s: E['top3'][:, 1].max() + BROW_Y * E['B'] for s, E in eyes.items()}
    d = np.zeros_like(V)
    for s, E in eyes.items():
        w = g2((E['O'][0], brow_y[s]), 0.06, 0.035)
        d[:, 1] += 0.007 * w
    out['brow_up'] = d
    d = np.zeros_like(V)
    for s, E in eyes.items():
        inner = -1 if s == 'L' else 1
        w = g2((E['O'][0] + inner * 0.25 * E['W'], brow_y[s] - 0.01), 0.04, 0.028)
        d[:, 1] -= 0.0055 * w; d[:, 0] += inner * 0.002 * w; d[:, 2] += 0.0015 * w
    out['brow_down'] = d
    d = np.zeros_like(V)
    for s, E in eyes.items():
        inner = -1 if s == 'L' else 1
        w = g2((E['O'][0] + inner * 0.3 * E['W'], brow_y[s] - 0.005), 0.032, 0.026)
        d[:, 1] += 0.0065 * w
    out['brow_sad'] = d
    d = np.zeros_like(V)
    for s, E in eyes.items():
        c = (E['O'][0] * 1.02, E['bot3'][:, 1].min() - 0.028)
        w = g2(c, 0.045, 0.026)
        d[:, 1] += 0.005 * w; d[:, 2] += 0.003 * w
    out['cheek_up'] = d
    d = np.zeros_like(V)
    mc = (np.array(marks['mouthL']) + np.array(marks['mouthR'])) / 2
    for sx in (1, -1):
        c = (sx * 0.62 * Wm, mc[1] + 0.05 * Wm)
        w = g2(c, 0.42 * Wm, 0.36 * Wm)
        d[:, 0] += sx * 0.07 * Wm * w; d[:, 2] += 0.09 * Wm * w; d[:, 1] += 0.02 * Wm * w
    out['cheeks_gum'] = d
    d = np.zeros_like(V)
    nz = np.array(marks['nose']); nt = np.array(marks['noseTop'])
    w = g2((nz[0], nt[1] + 0.014), 0.024, 0.014)
    d[:, 1] -= 0.003 * w; d[:, 2] += 0.0015 * w
    w2 = g2((nz[0], nz[1]), 0.02, 0.012)
    d[:, 1] += 0.002 * w2
    out['nose_wrinkle'] = d
    return {k: (v * front[:, None]).astype(np.float32) for k, v in out.items()}


# ───────────────────────── текстура морды по рефу ─────────────────────────
def paint_ref(tex, V, F, UV, eyes, marks, Wm, role=None):
    """брови — мягкие дуги темнее меха; морда и подушечки усов светлее (реф #CAD3DE), подбородок без светлой линии"""
    size = tex.size[0]
    arr = np.asarray(tex).astype(np.float32)
    from glitter_p3 import vnormals
    pos, nrm, tid = raster_uv(V, vnormals(V, F), UV, F, size)
    has = (tid >= 0) & (nrm[..., 2] > 0.1)
    out = arr.copy()
    if role is not None and not getattr(tex, '_desat', False):
        # мех по рефу серо-голубой (лоб ≈ #A7B2C5, ноги ≈ #96A0BE), у Tripo — сиреневее: насыщенность ×FUR_SAT, синий ниже
        furpx = (tid >= 0) & (role[np.maximum(tid, 0)] == 'fur')
        c = out[furpx]
        lum = c @ np.array([0.3, 0.59, 0.11])
        c = lum[:, None] + (c - lum[:, None]) * FUR_SAT
        out[furpx] = c * np.array([1.0, 1.0, 0.97])
    # брови: дуга над глазом (реф: от над внутренним уголком к над внешним, приподнята к середине-наружу)
    brow = np.array([80, 90, 120.0])
    for s, E in eyes.items():
        outer = 1 if s == 'L' else -1
        x0, x1 = E['O'][0] - outer * 0.5 * E['W'], E['O'][0] + outer * 0.55 * E['W']
        yb = E['top3'][:, 1].max() + BROW_Y * E['B']
        xs = np.linspace(x0, x1, 40); t = np.linspace(0, 1, 40)
        ys = yb + 0.014 * np.sin(np.pi * (0.15 + 0.8 * t)) - 0.006 * t
        tree = cKDTree(np.stack([xs, ys], 1))
        d, k = tree.query(pos[..., :2].reshape(-1, 2))
        d = d.reshape(pos.shape[:2]); k = k.reshape(pos.shape[:2])
        th = 0.013 * (0.75 + 0.5 * np.sin(np.pi * np.clip(k / 39, 0, 1)))  # толще в середине
        a = np.exp(-(d / th) ** 2) * ((tid >= 0) & (nrm[..., 2] > -0.3) & (np.abs(pos[..., 0] - E['O'][0]) < 0.09)) * 0.5 * sm(0, 0.12, k / 39) * (1 - sm(0.85, 1.0, k / 39))
        out = out * (1 - a[..., None]) + brow * a[..., None]
    # морда: светлее вокруг рта и носа (подушечки усов, подбородок)
    mz = np.array([196, 203, 216.0])
    mc = (np.array(marks['mouthL']) + np.array(marks['mouthR'])) / 2
    nz = np.array(marks['nose'])
    r = np.hypot((pos[..., 0] - mc[0]) / (0.75 * Wm), (pos[..., 1] - (mc[1] + 0.12 * Wm)) / (0.5 * Wm))
    a = (1 - sm(0.5, 1.15, r)) * has * 0.55 * (pos[..., 1] < nz[1] + 0.004)
    out = out * (1 - a[..., None]) + mz * a[..., None]
    # шум меха поверх
    rng = np.random.default_rng(5)
    out += rng.normal(0, 2.5, out.shape).astype(np.float32) * has[..., None]
    # блок морды: тексели без треугольников (дыры глазниц — там лежит закрытое веко, UV век — блок морды) — мех
    # вокруг после всех правок (насыщенность, брови, светлая морда), а не сиреневая заливка Tripo до desaturate
    if BLOCK:
        b = BLOCK
        y0, x0, n = b['by'], b['bx'], b['B']
        blk = out[y0:y0 + n, x0:x0 + n]
        known = (tid[y0:y0 + n, x0:x0 + n] >= 0).astype(np.float32)
        from scipy.ndimage import gaussian_filter
        fill = blk.copy(); got = known.copy()
        for sg in (2, 4, 8, 16):
            w = gaussian_filter(known, sg)
            c = np.stack([gaussian_filter(blk[..., k] * known, sg) for k in range(3)], -1) / np.maximum(w, 1e-6)[..., None]
            new = (got < 0.5) & (w > 0.02)
            fill[new] = c[new]; got[new] = 1
        hole = known < 0.5
        fill[hole] += rng.normal(0, 2.5, (int(hole.sum()), 3)).astype(np.float32)
        out[y0:y0 + n, x0:x0 + n] = np.where(hole[..., None], fill, blk)
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))


# ───────────────────────── морда: новая сетка ─────────────────────────
BLOCK = {}


def block_uv(P):
    """точки лица (x, y меша) → UV блока морды в атласе (вид спереди, см. remesh_face); вне блока — к краю"""
    b = BLOCK
    u = (b['bx'] + 2 + np.clip((P[:, 0] - b['lo'][0]) / b['span'], 0, 1) * (b['B'] - 4)) / b['S']
    v = (b['by'] + 2 + (1 - np.clip((P[:, 1] - b['lo'][1]) / b['span'], 0, 1)) * (b['B'] - 4)) / b['S']
    return np.c_[u, v]


def remesh_face(V, F, UV, role, capt, img, face, step=0.0042):
    """Морда (мех головы спереди в эллипсе области, без глазниц) — заново: ограниченная триангуляция Делоне (triangle,
    `pip install triangle`) с шагом step по контуру выреза (вершины контура — те же, края глазниц — тоже), высота — поле
    морды + гармоническая поправка к контуру. Свой блок атласа (вид спереди), цвет — из меха Tripo вокруг (без заплаток,
    впадины рта и нарисованных губ), тот же шум меха. → V, F, UV, role, capt, img, keep (старые вершины, что остались)."""
    import triangle as tr
    from glitter_p3 import weld_map, vnormals_welded, sample_tex
    zfield = face['_field']; cx, cy, ax_, ay_ = face['_region']
    nV = len(V)
    wm = weld_map(V, 1e-6); nW = wm.max() + 1
    Pw = np.zeros((nW, 3)); np.add.at(Pw, wm, V); cnt = np.bincount(wm, minlength=nW); Pw /= cnt[:, None]
    Nv = vnormals_welded(V, F)
    Nw = np.zeros((nW, 3)); np.add.at(Nw, wm, Nv); Nw /= np.maximum(np.linalg.norm(Nw, axis=1, keepdims=True), 1e-9)
    R = rims(face)
    eyecap = np.zeros(len(F), bool)
    if capt is not None:
        cc = V[F].mean(1)
        for rim in R.values():
            eyecap |= capt & (np.linalg.norm(cc - rim.mean(0), axis=1) < 0.06)
    fur_t = role == 'fur'
    rr = np.hypot((Pw[:, 0] - cx) / ax_, (Pw[:, 1] - cy) / ay_)
    regw = (rr < 1.0) & (Pw[:, 2] > 0.06) & ((Nw[:, 2] > 0.35) | (rr < 0.75))
    regw[wm[F[eyecap].ravel()]] = False
    Fw = wm[F]
    rem = fur_t & ~eyecap & regw[Fw].all(1)
    from matplotlib.path import Path as MPath
    keep_holes = [rim.mean(0)[:2] for rim in R.values()]  # дыру под носом — залить (нос сверху)
    cc2 = Pw[Fw].mean(1)[:, :2]
    for it in range(20):
        # контур: рёбра, входящие в один вырезанный треугольник; «перемычки» (вершина контура с 4 рёбрами) — вырезать
        # все меховые треугольники вокруг неё; островки внутри (заплатки бровей, щель подбородка) — тоже
        E = np.sort(np.r_[Fw[rem][:, [0, 1]], Fw[rem][:, [1, 2]], Fw[rem][:, [2, 0]]], 1)
        ue, ec = np.unique(E, axis=0, return_counts=True)
        be = ue[ec == 1]
        adj = {}
        for a_, b_ in be:
            adj.setdefault(a_, []).append(b_); adj.setdefault(b_, []).append(a_)
        bad = [v for v, l in adj.items() if len(l) != 2]
        if bad:
            rem |= fur_t & ~eyecap & np.isin(Fw, bad).any(1)
            continue
        loops, seen = [], set()
        for v0 in adj:
            if v0 in seen:
                continue
            lp = [v0]; seen.add(v0); prev, cur = None, v0
            while True:
                nxt = [w for w in adj[cur] if w != prev][0]
                if nxt == v0:
                    break
                lp.append(nxt); seen.add(nxt); prev, cur = cur, nxt
            loops.append(lp)
        ar_ = [abs(0.5 * np.sum(Pw[lp, 0] * np.roll(Pw[lp, 1], -1) - np.roll(Pw[lp, 0], -1) * Pw[lp, 1])) for lp in loops]
        loops = [loops[i] for i in np.argsort(ar_)[::-1]]
        grew = False
        for lp in loops[1:]:
            path = MPath(Pw[lp][:, :2])
            cen = Pw[lp][:, :2].mean(0)
            if min(np.linalg.norm(cen - k) for k in keep_holes) < 0.03:
                continue
            inside_ = path.contains_points(cc2)
            if os.environ.get('P3_DEBUG'):
                print('   остров', np.round(cen, 3), 'роли', dict(zip(*np.unique(role[~rem & inside_], return_counts=True))), 'заплатки', int((capt[~rem & inside_]).sum()) if capt is not None else 0, 'глазн', int(eyecap[inside_].sum()), 'z', np.round(Pw[lp][:, 2].mean(), 3))
            ins = ~rem & fur_t & ~eyecap & inside_ & (Pw[Fw][:, :, 2] > 0.06).all(1)
            if ins.any():
                rem |= ins; grew = True
        if not grew:
            break
    if bad:
        raise SystemExit(f'контур морды не простой: {len(bad)} вершин с ≠2 рёбрами')
    # дробить длинные рёбра контура (вершины в середине ребра: у соседних старых треугольников — Т-стык без щели:
    # точка лежит на их ребре)
    pts, segs, bsrc, holes = [], [], [], []
    # контуры: внешний, глазницы, нос; прочие (дыры сетки Tripo под бровями и в подбородке, складки) — без
    # ограничений: их вершины ни к чему больше не относятся и уходят вместе с вырезанным
    loops = [loops[0]] + [lp for lp in loops[1:] if min(np.linalg.norm(Pw[lp][:, :2].mean(0) - k) for k in keep_holes) < 0.03]
    def despike(lp):
        # петля в проекции возвращается назад (складка края глазницы Tripo) — вершину-шип прочь
        lp = list(lp)
        for _ in range(len(lp)):
            P2 = Pw[lp][:, :2]
            a = P2 - np.roll(P2, 1, 0); b = np.roll(P2, -1, 0) - P2
            cs = (a * b).sum(1) / np.maximum(np.linalg.norm(a, axis=1) * np.linalg.norm(b, axis=1), 1e-12)
            k = int(np.argmin(cs))
            if cs[k] > -0.5:
                break
            lp.pop(k)
        return lp
    loops = [despike(lp) for lp in loops]
    for li, lp in enumerate(loops):
        st = len(pts)
        for k, v in enumerate(lp):
            w = lp[(k + 1) % len(lp)]
            n = max(1, int(np.ceil(np.linalg.norm(Pw[w] - Pw[v]) / (step * 1.15))))
            for t in range(n):
                pts.append(Pw[v] * (1 - t / n) + Pw[w] * (t / n)); bsrc.append((v, w, t / n))
        m = len(pts) - st
        segs += [(st + k, st + (k + 1) % m) for k in range(m)]
        cen = np.array(pts[st:]).mean(0)[:2]
        if li > 0 and min(np.linalg.norm(cen - k) for k in keep_holes) < 0.03:  # глазницы и нос — дыры; прочие — залить
            holes.append(cen)
    pts = np.array(pts)
    tri_in = {'vertices': pts[:, :2], 'segments': np.array(segs)}
    if holes:
        tri_in['holes'] = np.array(holes)
    print(f'  контуры морды: {[len(lp) for lp in loops]}, точек {len(pts)}', flush=True)
    S_ = np.array(segs); A_, B_ = pts[S_[:, 0], :2], pts[S_[:, 1], :2]
    def orient2(p, q, r):
        return np.sign((q[..., 0] - p[..., 0]) * (r[..., 1] - p[..., 1]) - (q[..., 1] - p[..., 1]) * (r[..., 0] - p[..., 0]))
    X = (orient2(A_[:, None], B_[:, None], A_[None]) * orient2(A_[:, None], B_[:, None], B_[None]) < 0) & \
        (orient2(A_[None], B_[None], A_[:, None]) * orient2(A_[None], B_[None], B_[:, None]) < 0)
    if X.any():
        ii_ = np.argwhere(X)[:4]
        raise SystemExit(f'контур морды пересекает себя в проекции: {int(X.sum()) // 2} пар, напр. {np.round(A_[ii_[:, 0]], 3).tolist()} / {np.round(B_[ii_[:, 0]], 3).tolist()} × {np.round(A_[ii_[:, 1]], 3).tolist()} / {np.round(B_[ii_[:, 1]], 3).tolist()}; сегменты {ii_.tolist()}, длины контуров {[len(l) for l in loops]}')
    # грубо по всей морде (≈ 2.2 шага), мельче — у рта (до носа) и у глазниц (≈ шаг)
    out = tr.triangulate(tri_in, f'pq30Ya{2.4 * step * step:.10f}')
    Q = out['vertices']; T = out['triangles']
    cT = Q[T].mean(1)
    mcx = np.array(face['mouthC'])
    near = np.hypot((cT[:, 0] - mcx[0]) / 0.075, (cT[:, 1] - mcx[1] - 0.01) / 0.05) < 1
    for rim in R.values():
        c = rim.mean(0)
        near |= np.hypot((cT[:, 0] - c[0]) / 0.075, (cT[:, 1] - c[1]) / 0.06) < 1
    out['triangle_max_area'] = np.where(near, 0.5 * step * step, 2.4 * step * step)
    out = tr.triangulate(out, 'rpq30Ya')
    Q = out['vertices']; T = out['triangles']
    nb = len(pts)
    z = np.r_[pts[:, 2], zfield(Q[nb:])]
    # гармоническая поправка: у контура — точная высота, внутри — поле + сглаженная разница
    resid = np.r_[pts[:, 2] - zfield(pts[:, :2]), np.zeros(len(Q) - nb)]
    Et = np.r_[T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]]
    for _ in range(300):
        acc = np.zeros(len(Q)); c = np.zeros(len(Q))
        np.add.at(acc, Et[:, 0], resid[Et[:, 1]]); np.add.at(c, Et[:, 0], 1)
        np.add.at(acc, Et[:, 1], resid[Et[:, 0]]); np.add.at(c, Et[:, 1], 1)
        resid[nb:] = acc[nb:] / np.maximum(c[nb:], 1)
    z[nb:] += resid[nb:]
    Pn = np.c_[Q, z]
    Pn[:nb] = pts
    # Т-стыки: вершины в серединах старых рёбер контура — старые треугольники рядом делим тоже
    # (иначе тонкая щель при деформации ключами): треугольник со стороной (v, w) → веер через точки на стороне
    mids = {}
    for i, (v, w, t) in enumerate(bsrc):
        if t > 0:
            mids.setdefault((v, w), []).append((t, i))
    # блок атласа: вид спереди, свободный квадрат
    S = img.shape[0]
    used = np.zeros((S, S), bool)
    from PIL import ImageDraw, ImageFilter
    im_ = Image.new('L', (S, S), 0); dr = ImageDraw.Draw(im_)
    for t_ in F:
        dr.polygon([(float(UV[i, 0] * S), float(UV[i, 1] * S)) for i in t_], fill=255)
    used = np.asarray(im_.filter(ImageFilter.MaxFilter(9))) > 0
    free = ~used
    dp = np.zeros((S + 1, S + 1), np.int32); best = (0, 0, 0)
    for y in range(S):
        row = free[y]; d0 = dp[y]; d1 = dp[y + 1]
        for x in np.nonzero(row)[0]:
            v_ = min(d0[x + 1], d1[x], d0[x]) + 1; d1[x + 1] = v_
            if v_ > best[0]:
                best = (v_, y, x)
    B = int(best[0]) - 8; by, bx = int(best[1]) - best[0] + 5, int(best[2]) - best[0] + 5
    lo_ = Pn[:, :2].min(0); span = (Pn[:, :2].max(0) - lo_).max() * 1.02
    UVn = np.c_[(bx + 2 + (Pn[:, 0] - lo_[0]) / span * (B - 4)) / S, (by + 2 + (1 - (Pn[:, 1] - lo_[1]) / span) * (B - 4)) / S]
    # то же отображение «вид спереди → блок атласа» — для век (закрытый глаз = мех морды, build_eyes)
    BLOCK.update(bx=bx, by=by, B=B, lo=lo_.copy(), span=span, S=S)
    # цвет блока: 3D-точка текселя → среднее k ближайших «хороших» текселей меха Tripo (не заплатки, не рот, не губы)
    from glb_io import raster_uv
    from glitter_p3 import vnormals
    keepT = ~rem
    pos, nrm, tid = raster_uv(V, vnormals(V, F), UV, F, S)
    good = (tid >= 0) & (nrm[..., 2] > 0.2)
    if capt is not None:
        good &= ~capt[np.maximum(tid, 0)]
    mc = np.array(face['mouthC'])
    arrf = img.astype(np.float32)
    lip = (arrf[..., 0] > arrf[..., 2] + 2) | (arrf.mean(-1) < 110)
    good &= role[np.maximum(tid, 0)] == 'fur'  # только мех (не бант, не нос, не худи)
    good &= ~(np.hypot((pos[..., 0] - mc[0]) / 0.065, (pos[..., 1] - mc[1]) / 0.045) < 1)  # нарисованный рот Tripo
    for rim in R.values():  # глазницы
        c = rim.mean(0)
        good &= np.hypot((pos[..., 0] - c[0]) / 0.07, (pos[..., 1] - c[1]) / 0.055) > 1
    good &= (arrf[..., 2] > arrf[..., 0] + 6) & (arrf[..., 1] < arrf[..., 2])  # голубовато-сиреневый мех
    good &= np.hypot((pos[..., 0] - cx) / (ax_ * 1.3), (pos[..., 1] - cy) / (ay_ * 1.3)) < 1
    gp = pos[good]; gc_ = arrf[good]
    tq = cKDTree(gp[:, :2] * [1, 1])
    yy, xx = np.mgrid[0:B, 0:B]
    bxy = np.c_[lo_[0] + (xx.ravel() + 0.5 - 2) / (B - 4) * span, lo_[1] + (1 - (yy.ravel() + 0.5 - 2) / (B - 4)) * span]
    dd, ii = tq.query(bxy, k=24)
    ww = 1 / np.maximum(dd, 1e-4) ** 2
    col = (gc_[ii] * ww[..., None]).sum(1) / ww.sum(1, keepdims=True)
    col += np.random.default_rng(4).normal(0, 2.5, col.shape)
    img = img.copy()
    img[by:by + B, bx:bx + B] = np.clip(col.reshape(B, B, 3), 0, 255).astype(img.dtype)
    # сборка: старые без вырезанных + новые
    Fk = F[keepT]
    nN = len(Pn)
    Vn = np.r_[V, Pn]; UVa = np.r_[UV, UVn]
    Tn = T + nV
    # Т-стыки у старых треугольников контура
    rk = role[keepT]; ck = capt[keepT] if capt is not None else None
    extraF, extraR, extraC, drop = [], [], [], np.zeros(len(Fk), bool)
    if mids:
        Fkw = wm[Fk]
        for ti_, (fw, fo) in enumerate(zip(Fkw, Fk)):
            for e in range(3):
                a_, b_ = fw[e], fw[(e + 1) % 3]
                key = (a_, b_) if (a_, b_) in mids else ((b_, a_) if (b_, a_) in mids else None)
                if key is None:
                    continue
                ms = sorted(mids[key]) if key == (a_, b_) else sorted(mids[key], key=lambda x: -x[0])
                # новые вершины на старом ребре — копии с UV старого треугольника (интерполяция по ребру)
                oa, ob, oc = fo[e], fo[(e + 1) % 3], fo[(e + 2) % 3]
                chain = [oa]
                for t, i in ms:
                    tt = t if key == (a_, b_) else 1 - t
                    Vn = np.r_[Vn, [Pn[i]]]; UVa = np.r_[UVa, [UV[oa] * (1 - tt) + UV[ob] * tt]]
                    chain.append(len(Vn) - 1)
                chain.append(ob)
                for k in range(len(chain) - 1):
                    extraF.append([chain[k], chain[k + 1], oc]); extraR.append(rk[ti_])
                    if ck is not None:
                        extraC.append(ck[ti_])
                drop[ti_] = True
                break
    Fk2 = np.r_[Fk[~drop], np.array(extraF, np.int64).reshape(-1, 3)] if extraF else Fk
    roleN = np.r_[rk[~drop], np.array(extraR, dtype=rk.dtype), np.full(len(Tn), 'fur', dtype=rk.dtype)] if extraF else np.r_[rk, np.full(len(Tn), 'fur', dtype=rk.dtype)]
    captN = None
    if capt is not None:
        captN = np.r_[ck[~drop], np.array(extraC, bool), np.zeros(len(Tn), bool)] if extraF else np.r_[ck, np.zeros(len(Tn), bool)]
    Fall = np.r_[Fk2, Tn]
    used_v = np.zeros(len(Vn), bool); used_v[Fall.ravel()] = True
    remap = -np.ones(len(Vn), np.int64); remap[used_v] = np.arange(used_v.sum())
    print(f'морда заново: вырезано {rem.sum()} треуг., контуров {len(loops)}, новых треуг. {len(T)} '
          f'(вершин {nN}, шаг {step * 1000:.1f} мм), Т-стыков {int(drop.sum())}, блок атласа {B}px @({bx},{by})')
    return Vn[used_v], remap[Fall], UVa[used_v], roleN, captN, img, used_v, nV


def desaturate(tex, V, F, UV, role):
    """мех к рефу (до проб цвета век): насыщенность ×FUR_SAT, синий чуть ниже"""
    size = tex.size[0]
    arr = np.asarray(tex).astype(np.float32).copy()
    from glitter_p3 import vnormals
    pos, nrm, tid = raster_uv(V, vnormals(V, F), UV, F, size)
    furpx = (tid >= 0) & (role[np.maximum(tid, 0)] == 'fur')
    c = arr[furpx]
    lum = c @ np.array([0.3, 0.59, 0.11])
    arr[furpx] = (lum[:, None] + (c - lum[:, None]) * FUR_SAT) * np.array([1.0, 1.0, 0.97])
    out = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    out._desat = True
    return out

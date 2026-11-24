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
EYE_K = (0.8, 1.0, -0.1, 0.022)
# ось глаза: нормаль плоскости края дыры с долей EYE_FWD «вперёд» (+Z). Меньше — край разреза ровнее по яблоку (у
# внешнего уголка он уходит за голову): моргание сходится по всему разрезу одним углом, линия ресниц — посередине глаза
EYE_FWD = 0.1
# яблоко: полуоси A (доля ширины разреза), B (доля высоты, не меньше 0.8 A), глубина C (доля A) — крупнее разреза,
# чтобы край дыры лежал на яблоке без глаз «навыкате»
EYE_BALL = (0.62, 0.72, 0.32)
# веко ярче пробы меха над глазом (у кожи вокруг — оболочки меха и подсветка, у века их нет): закрытый глаз = мех
LID_GAIN = (0.7, 1.4)
# насыщенность меха к рефу
FUR_SAT = 0.72
# брови: дуга над верхним краем глаза на BROW_Y·B (реф — высоко, мягкая тёмная дуга меха, не тёмная полоса)
BROW_Y = 0.6
# брови текстуры: толщина (м), доля, цвет (реф — тонкие мягкие серые дуги, чуть темнее меха); сглаживание блока морды (σ — доля стороны блока, сила)
BROW_TEX_Y = 1.0  # дуга текстуры над верхом глаза (доли B): реф — высоко, ≈ 1.5 высоты подводки
BROW = (0.006, 0.75, (72, 80, 110))
BLOCK_SMOOTH, BLOCK_SMOOTH_K = 0.02, 0.8
# сглаживание лба (доля на точку у сплайна)
BROW_RIDGE = (0.005, 0.045, 0.025)  # валик лба: глубина среза (м), высота над верхом глаз (м), σ (м)
# полоса над глазами — к меху лба (доля)
FOREHEAD_TINT = 0.85
# область морды заново (эллипс): сдвиг центра вверх и прибавка полуоси y (м) — гнёзда бровей Tripo целиком внутри
FACE_REG = (0.008, 0.02)
# светлая маска морды: полуоси (доли W рта) и сила
MUZZLE = (1.25, 0.95, 0.5)
# выступ морды (доли W рта): подушечки под носом — высота, полуоси x, y; подбородок — высота
MUZZLE_Z = (0.1, 0.6, 0.45, 0.08)
# нос назад (м): в профиль рефа нос сидит на морде
NOSE_BACK = 0.009
# форма головы: ширина ×(1 + Σ доля·exp(−((y − y0)/σ)²)) — по наложению анфас на реф в одном масштабе
# (tools/glitter-p3-face-sheet.py): щёки на уровне глаз и над ними шире (только у края силуэта), «брыли» у подбородка уже (подбородок выше)
HEAD_X = ((0.13, 0.715, 0.035), (0.09, 0.79, 0.05), (-0.15, 0.578, 0.035), (-0.03, 0.645, 0.025))
# верхнее веко в покое (доля закрытия): по рефу касается радужки сверху, не закрывая её (наложение анфас); подводка и
# лепестки ресниц — ниже кромки кожи, видны целиком
REST_UP = 0.22
# радужка: радиус в долях полувысоты разреза (реф — радужка ≈ 0.6 высоты открытого глаза, по наложению), зрачок — доля радужки
IRIS_K, PUPIL = 1.2, 0.5
# подводка и ресницы (линейный цвет): реф ≈ #29313F
LASH = np.array([0.022, 0.03, 0.05])
# лепестки ресниц (пятый проход, по рефу): (доля полуширины от центра к внешнему уголку, длина — доля ширины разреза,
# ширина у основания — доля полуширины, угол к горизонтали наружу, °); загиб кончика и вынос вперёд (единицы C)
LASH_PETALS = [(0.42, 0.62, 0.075, 76), (0.58, 0.78, 0.085, 60), (0.72, 0.9, 0.09, 44), (0.85, 0.92, 0.09, 28), (0.96, 0.74, 0.085, 12)]
LASH_CURL, LASH_FWD = 0.45, 0.25
# ширина рта (W) в долях расстояния между центрами глаз: реф mouths.jpg/разворот ≈ 0.7
MOUTH_W = 0.64
# пятый проход: рот выше (ближе к носу, м) и открытая улыбка покоя по развороту — уголки вверх, нижняя губа «D» с
# плоским дном (было «V»: купол раскрытия от середины к уголкам); состав ключей — поверх MOUTH в face_rig.py
MOUTH_UP = 0.016
# язык крупнее и выше (реф: розовый язычок внизу открытой улыбки), уточнение PERSONA['glitter'] в face_rig.py
MOUTH_CFG = {'tongue': [0.24, 0.2], 'tongue_drop': -0.04}
MOUTH_KEYS = {'smile_open': {'smile': 1.0, 'jaw': 0.3, 'lift': 0.7, 'open': 0.44, 'arch': 0.04, 'flatb': 0.45},
              # «о» удивления — круглое (реф surprised), а не «V» по дуге улыбки
              'surprise': {'open': 0.26, 'flatb': 0.55, 'arch': 0.5, 'round': 1.0}}
# подразбиение у рта в face_rig.py (морда уже ≈ 3 мм у рта): одна узкая зона вдоль губ
SUBDIV_P3 = [[0.66, 0.2, -0.03, 0.35]]
# линия губ «ω» в долях W (u, v): уголки вверх, у фильтрума — бугорок вверх (реф mouths.jpg, сомкнутая улыбка)
def mouth_line(n=29):
    u = np.linspace(-0.5, 0.5, n)
    # пятый проход: бугорок у фильтрума меньше (верхняя губа открытой улыбки рефа — ровная дуга с едва заметной «ω»)
    v = 0.1 * (2 * np.abs(u)) ** 2.2 - 0.07 + 0.025 * np.exp(-(u / 0.07) ** 2)
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
    nose = np.array(face['nose']); mc = np.array(face['mouthC']) + np.array([0, MOUTH_UP, 0])
    ec = {s: R[s].mean(0) for s in R}
    eyeC = (ec['L'] + ec['R']) / 2
    capv = np.zeros(nV, bool)
    if capt is not None:
        capv[F[capt].ravel()] = True
    # область: эллипс от бровей до подбородка, |x| до внешних уголков глаз
    cx, cy = 0.0, (eyeC[1] + mc[1]) / 2 - 0.015 + FACE_REG[0]
    ax_, ay_ = 0.175, 0.17 + FACE_REG[1]
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
    # морда вперёд (пятый проход, профиль рефа): подушечки и подбородок выступают — нос сидит на морде, а не висит
    # перед ней, подбородок круглый, а не плоский; с тем же спадом к краю области, что у подушечек
    def muzzle(xy, rr_, ew_):
        g1 = np.exp(-((xy[:, 0] / (MUZZLE_Z[1] * Wm)) ** 2 + ((xy[:, 1] - (mc[1] + 0.3 * Wm)) / (MUZZLE_Z[2] * Wm)) ** 2))
        g2 = np.exp(-((xy[:, 0] / (0.5 * Wm)) ** 2 + ((xy[:, 1] - (mc[1] - 0.42 * Wm)) / (0.3 * Wm)) ** 2))
        return (MUZZLE_Z[0] * g1 + MUZZLE_Z[3] * g2) * Wm * (1 - sm(0.55, 0.85, rr_)) * ew_
    z += muzzle(V[reg][:, :2], rr[reg], eye_w[reg])
    V[reg, 2] = z
    # 4) лоб (пятый проход): у Tripo над глазами валик (лоб выступает над глазницами на ≈ 2 см, гнёзда бровей) —
    #    полоса под ним смотрит вниз и на свету темнела «уступами» по форме бровей. Валик срезан мягким горбом вниз
    #    (по x, y — одна функция: копии вершин сдвигаются одинаково, швы не расходятся), у разреза глаза — без изменений
    e_top = max(float(rim[:, 1].max()) for rim in R.values())
    rims_ = [(rim.mean(0), np.abs(rim[:, 0] - rim.mean(0)[0]).max(), np.abs(rim[:, 1] - rim.mean(0)[1]).max()) for rim in R.values()]

    def ridge(xy):
        xy = np.atleast_2d(xy)
        ew_ = np.ones(len(xy))
        for c, rx, ry in rims_:
            ew_ = np.minimum(ew_, sm(1.05, 1.5, np.hypot((xy[:, 0] - c[0]) / rx, (xy[:, 1] - c[1]) / ry)))
        g_ = np.exp(-((xy[:, 1] - (e_top + BROW_RIDGE[1])) / BROW_RIDGE[2]) ** 2) * (1 - sm(0.11, 0.15, np.abs(xy[:, 0])))
        return BROW_RIDGE[0] * g_ * ew_
    frontv = head & (V[:, 2] > 0.06)
    dz_ = ridge(V[frontv, :2])
    V[frontv, 2] -= dz_
    print(f'  лоб: валик над глазами срезан до {dz_.max() * 1000:.1f} мм ({int((dz_ > 0.001).sum())} вершин)')
    # 5) нос (пятый проход): в профиль висел на ≈ 2.3 см перед мордой — назад на NOSE_BACK (основание — в мех)
    if role is not None and NOSE_BACK:
        nsv = np.zeros(nV, bool)
        for k in range(3):
            nsv[F[role == 'nose', k]] = True
        V[nsv, 2] -= NOSE_BACK
    face_new = {k: v for k, v in face.items()}
    for k_ in ('nose', 'noseTop'):
        if k_ in face_new and NOSE_BACK:
            face_new[k_] = np.array(face_new[k_], np.float64) - np.array([0, 0, NOSE_BACK])

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
        return f(xy) + 0.035 * Wm * np.clip(pd, 0, 1.25) * (1 - sm(0.55, 0.85, rr_)) * ew - ridge(xy)
    face_new['_field'] = zfield

    def zbump(xy):
        # выступ морды — поверх гармонической поправки remesh_face (иначе её тянут вниз края глазниц)
        xy = np.atleast_2d(xy)
        rr_ = np.hypot((xy[:, 0] - cx) / ax_, (xy[:, 1] - cy) / ay_)
        ew = np.ones(len(xy))
        for s_, rim in R.items():
            c = rim.mean(0)
            rx = np.abs(rim[:, 0] - c[0]).max(); ry = np.abs(rim[:, 1] - c[1]).max()
            ew = np.minimum(ew, sm(1.05, 1.9, np.hypot((xy[:, 0] - c[0]) / rx, (xy[:, 1] - c[1]) / ry)))
        return muzzle(xy, rr_, ew)
    face_new['_bump'] = zbump
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
    img = eye_texture('glitter_p3', rx, ry, PUPIL, flat=True)
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
        # ресницы: 4 длинных загнутых лепестка вдоль внешней половины верхнего века (реф: вверх-наружу, кончик загнут
        # наружу-вниз). Пятый проход: лепесток строится в плоскости вида (x — доли A, y — доли B → изотропно на экране),
        # от кромки века, чуть вперёд к камере (поверх оболочек меха); прежние шли по сфере века назад в голову
        exV, exF, exC, exN = [], [], [], []
        amax = E['ag'][(E['ag'] > -1.4) & (E['ag'] < 1.4)]
        NS = 9
        for k, (a_rel, ln, wd_, phi) in enumerate(LASH_PETALS):
            target = outer * a_rel * np.abs(amax).max()
            ai = int(np.argmin(np.abs(E['ag'] - target)))
            a = E['ag'][ai]; te = E['th_t'][ai]
            b0 = np.array([math.sin(a), math.cos(a) * math.sin(te), math.cos(a) * math.cos(te)])
            base = len(Vl) + len(exV)
            L = ln * E['W'] * 0.5      # длина на экране, м
            ph = math.radians(phi)
            d = np.array([outer * math.cos(ph), math.sin(ph)]); nrm2 = np.array([-d[1], d[0]]) * outer
            pts = []
            for s_ in np.linspace(0, 1, NS):
                q = L * (s_ * d - LASH_CURL * s_ * s_ * nrm2)          # м, экран; загиб наружу-вниз
                pts.append(b0 + np.array([q[0] / E['A'], q[1] / E['B'], LASH_FWD * s_ + 0.03]))
            pts = np.array(pts)
            for si, p in enumerate(pts):
                s_ = si / (NS - 1)
                w = wd_ * (1 - s_) ** 0.75 * (0.75 + 0.25 * math.sin(math.pi * min(1, s_ * 1.6))) + 0.004
                tng = pts[min(si + 1, NS - 1)] - pts[max(si - 1, 0)]
                tng2 = np.array([tng[0] * E['A'], tng[1] * E['B']]); tng2 /= max(np.linalg.norm(tng2), 1e-9)
                sv = np.array([-tng2[1] / E['A'], tng2[0] / E['B'], 0.0]) * E['W'] * 0.5
                exV += [p - sv * w, p + sv * w]; exN += [np.array([0, 0.3, 1.0])] * 2; exC += [LASH, LASH]
            for si in range(NS - 1):
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
    my = float(face['mouthC'][1]) - 0.002 + MOUTH_UP
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
                             'persona': PERSONA, 'p3': 1, 'subdiv': SUBDIV_P3, 'mouthKeys': MOUTH_KEYS, 'cfg': MOUTH_CFG}}


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
    rng = np.random.default_rng(5)
    from scipy.ndimage import gaussian_filter, label, binary_dilation, binary_erosion
    # блок морды (пятый проход): 1) дыры глазниц (там закрытое веко, UV век — блок морды) — медиана меха кольцом
    # вокруг дыры (раньше — размытие соседей: светлая морда снизу затекала, веко выходило светлой заплаткой);
    # 2) мех блока сглажен (остатки бровей Tripo, пятна) — мягкий градиент, зерно меха — шумом ниже
    if BLOCK:
        bb = BLOCK
        y0, x0, n = bb['by'], bb['bx'], bb['B']
        blk = out[y0:y0 + n, x0:x0 + n].copy()
        known = tid[y0:y0 + n, x0:x0 + n] >= 0
        lab, nl = label(~known)
        for li in range(1, nl + 1):
            h = lab == li
            ys_, xs_ = np.nonzero(h)
            if ys_.min() == 0 or xs_.min() == 0 or ys_.max() == n - 1 or xs_.max() == n - 1 or len(ys_) < 50:
                continue
            ring = binary_dilation(h, iterations=max(4, n // 40)) & known
            if ring.sum() < 10:
                continue
            rc = blk[ring]
            lum = rc @ np.array([0.3, 0.59, 0.11])
            blk[h] = np.median(rc[lum <= np.percentile(lum, 60)], 0)
            known = known | h
        sg = max(2.0, n * BLOCK_SMOOTH)
        kf = known.astype(np.float32)
        sm_ = np.stack([gaussian_filter(blk[..., k] * kf, sg) for k in range(3)], -1) / np.maximum(gaussian_filter(kf, sg), 1e-6)[..., None]
        w = gaussian_filter(binary_erosion(known, iterations=int(sg)).astype(np.float32), sg / 2) * BLOCK_SMOOTH_K
        blk = np.where(known[..., None], blk * (1 - w[..., None]) + sm_ * w[..., None], blk)
        out[y0:y0 + n, x0:x0 + n] = blk
    # тёмные пятна меха головы спереди (брови Tripo на текстуре головы вне блока морды — тёмные «уступы» на лбу):
    # тексель темнее светлой части меха в радиусе ≈ 25 мм (по 3D-положению) — к среднему
    if role is not None:
        e_top = max(float(E['top3'][:, 1].max()) for E in eyes.values())
        zone = (tid >= 0) & (role[np.maximum(tid, 0)] == 'fur') & (nrm[..., 2] > -0.2) & (pos[..., 1] > e_top - 0.03) & \
            (pos[..., 1] < e_top + 0.13) & (np.abs(pos[..., 0]) < 0.16)
        yy_, xx_ = np.nonzero(zone)
        if len(yy_) > 100:
            P3 = pos[yy_, xx_]
            C3 = out[yy_, xx_]
            L3 = C3 @ np.array([0.3, 0.59, 0.11])
            sub = np.random.default_rng(3).choice(len(P3), min(len(P3), 40000), replace=False)
            tr_ = cKDTree(P3[sub])
            dd, ii = tr_.query(P3, k=96, distance_upper_bound=0.025)
            ok = np.isfinite(dd)
            ii = np.where(ok, ii, 0)
            Ls = L3[sub][ii]
            Ls = np.where(ok, Ls, np.nan)
            ref = np.nanpercentile(Ls, 80, axis=1)
            Cm = np.nanmean(np.where(ok[..., None], C3[sub][ii], np.nan), axis=1)
            wgt = np.clip((ref - L3 - 2) / 8, 0, 1)[:, None]
            out[yy_, xx_] = C3 * (1 - wgt) + Cm * (C3.sum(1, keepdims=True) * 0 + 1) * wgt * (ref / np.maximum(Cm @ np.array([0.3, 0.59, 0.11]), 1))[:, None]
    # полоса над глазами (там у Tripo были брови: тёмные дуги в цвете меха морды) — к меху лба выше, мягко по краям
    if role is not None:
        e_top = max(float(E['top3'][:, 1].max()) for E in eyes.values())
        frm = (tid >= 0) & (role[np.maximum(tid, 0)] == 'fur') & (nrm[..., 2] > 0.2) & (np.abs(pos[..., 0]) < 0.15)
        up_ = frm & (pos[..., 1] > e_top + 0.065) & (pos[..., 1] < e_top + 0.1)
        if up_.sum() > 50:
            fc = np.median(out[up_], 0)
            wy = sm(e_top - 0.012, e_top + 0.004, pos[..., 1]) * (1 - sm(e_top + 0.05, e_top + 0.075, pos[..., 1]))
            wx = 1 - sm(0.12, 0.15, np.abs(pos[..., 0]))
            ring_ = np.ones(pos.shape[:2])
            for E in eyes.values():  # у самого разреза — как было (кромка века)
                ring_ = np.minimum(ring_, sm(0.5, 0.75, np.hypot((pos[..., 0] - E['O'][0]) / E['W'], (pos[..., 1] - E['O'][1]) / E['H'])))
            wf = (FOREHEAD_TINT * wy * wx * ring_ * frm)[..., None]
            out = out * (1 - wf) + fc * wf
    # морда: светлая маска вокруг рта и щёк (реф: подушечки усов, подбородок, низ щёк), плавный градиент без границы
    mz = np.array([204, 211, 226.0])
    mc = (np.array(marks['mouthL']) + np.array(marks['mouthR'])) / 2
    nz = np.array(marks['nose'])
    r = np.hypot((pos[..., 0] - mc[0]) / (MUZZLE[0] * Wm), (pos[..., 1] - (mc[1] + 0.15 * Wm)) / (MUZZLE[1] * Wm))
    top = 1 - sm(nz[1] - 0.012, nz[1] + 0.02, pos[..., 1])
    a = (1 - sm(0.15, 1.0, r)) ** 1.5 * has * MUZZLE[2] * top
    out = out * (1 - a[..., None]) + mz * a[..., None]
    # брови (пятый проход): тонкие мягкие серые дуги высоко над глазом (реф), без тёмных пятен
    for s, E in eyes.items():
        outer = 1 if s == 'L' else -1
        x0_, x1_ = E['O'][0] - outer * 0.45 * E['W'], E['O'][0] + outer * 0.5 * E['W']
        yb = E['top3'][:, 1].max() + BROW_TEX_Y * E['B']
        xs = np.linspace(x0_, x1_, 40); t = np.linspace(0, 1, 40)
        ys = yb + 0.012 * np.sin(np.pi * (0.15 + 0.8 * t)) - 0.005 * t
        tree = cKDTree(np.stack([xs, ys], 1))
        d, k = tree.query(pos[..., :2].reshape(-1, 2))
        d = d.reshape(pos.shape[:2]); k = k.reshape(pos.shape[:2])
        th = BROW[0] * (0.7 + 0.5 * np.sin(np.pi * np.clip(k / 39, 0, 1)))
        a = np.exp(-(d / th) ** 2) * ((tid >= 0) & (nrm[..., 2] > -0.3) & (np.abs(pos[..., 0] - E['O'][0]) < 0.09)) * BROW[1] * sm(0, 0.15, k / 39) * (1 - sm(0.8, 1.0, k / 39))
        out = out * (1 - a[..., None]) + np.array(BROW[2], np.float32) * a[..., None]
    # шум меха поверх
    out += rng.normal(0, 2.5, out.shape).astype(np.float32) * (has | blockmask(out.shape[:2]))[..., None]
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))


# ───────────────────────── морда: новая сетка ─────────────────────────
BLOCK = {}


def blockmask(shape):
    m = np.zeros(shape, bool)
    if BLOCK:
        m[BLOCK['by']:BLOCK['by'] + BLOCK['B'], BLOCK['bx']:BLOCK['bx'] + BLOCK['B']] = True
    return m


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
            # заплатка глазницы — внутри разреза (эллипс края дыры ×1.25), а не всё в 6 см от глаза (иначе края
            # заплаток бровей над глазом считались глазницей и не вырезались)
            c_ = rim.mean(0); rx_ = np.abs(rim[:, 0] - c_[0]).max(); ry_ = np.abs(rim[:, 1] - c_[1]).max()
            eyecap |= capt & (np.hypot((cc[:, 0] - c_[0]) / rx_, (cc[:, 1] - c_[1]) / ry_) < 1.25)
    fur_t = role == 'fur'
    rr = np.hypot((Pw[:, 0] - cx) / ax_, (Pw[:, 1] - cy) / ay_)
    regw = (rr < 1.0) & (Pw[:, 2] > 0.06) & ((Nw[:, 2] > 0.35) | (rr < 0.75))
    if capt is not None:
        # заплатки бровей Tripo в области морды — вырезать целиком, как бы ни смотрела их нормаль (пятый проход:
        # оставались островками по краю и светились над глазами тёмными «уступами»)
        capw = np.zeros(nW, bool); capw[wm[F[capt & ~eyecap].ravel()]] = True
        regw |= capw & (rr < 1.05) & (Pw[:, 2] > 0.04)
    regw[wm[F[eyecap].ravel()]] = False
    # не до банта/заколок: вершины не-меховых частей — вне области (контур остаётся простым)
    regw[wm[F[(role != 'fur') & (role != 'nose')].ravel()]] &= rr[wm[F[(role != 'fur') & (role != 'nose')].ravel()]] < 0.8
    Fw = wm[F]
    rem = fur_t & ~eyecap & regw[Fw].all(1)
    pin = np.zeros(len(F), bool)
    from matplotlib.path import Path as MPath
    keep_holes = [rim.mean(0)[:2] for rim in R.values()]  # дыру под носом — залить (нос сверху)
    cc2 = Pw[Fw].mean(1)[:, :2]
    for it in range(40):
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
            touch = np.isin(Fw, bad).any(1)
            new_ = fur_t & ~eyecap & touch & ~rem & ~pin
            if new_.any():
                rem |= new_
            else:
                # всё вокруг уже вырезано, а вершина — на краю сетки Tripo (шов, дыра): вокруг неё не вырезать
                pin |= touch; rem &= ~pin
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
            ins = ~rem & ~pin & fur_t & ~eyecap & inside_ & (Pw[Fw][:, :, 2] > 0.06).all(1)
            if ins.any():
                rem |= ins; grew = True
        if not grew:
            break
    if bad and os.environ.get('P3_DEBUG'):
        for b_ in bad:
            ti = np.nonzero((Fw == b_).any(1))[0]
            print('  плохая', np.round(Pw[b_], 3), [(int(t), role[t], bool(rem[t]), bool(eyecap[t]), bool(capt[t]) if capt is not None else None, np.round(Pw[Fw[t]][:, 2].min(), 3), bool(regw[Fw[t]].all())) for t in ti])
    if bad:
        raise SystemExit(f'контур морды не простой: {len(bad)} вершин с ≠2 рёбрами: {np.round(Pw[bad], 3).tolist()}')
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
    mcx = np.array(face['mouthC']) + np.array([0, MOUTH_UP, 0])
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
    if '_bump' in face:
        z[nb:] += face['_bump'](Q[nb:])
    if os.environ.get('P3_DEBUG'):
        for yy in (0.6, 0.62, 0.64, 0.645):
            k_ = int(np.argmin(np.hypot(Q[:, 0], Q[:, 1] - yy)))
            print('   z@', yy, round(float(zfield(np.array([[0.0, yy]]))[0]), 4), 'итог', round(float(z[k_]), 4), 'поправка', round(float(resid[k_]), 4))
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

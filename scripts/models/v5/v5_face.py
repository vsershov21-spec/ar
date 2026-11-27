"""Блёстка v5, стадия «мимика поверх лица Tripo» (v5d: у кромки верхнего века — полоса ресниц Tripo, lidStrip; ключ
cheeks_puff — надутые щёки обиды) (без Blender): лицо, текстура и форма в покое — как у Tripo 1:1.

    python3 scripts/models/v5/v5_face.py rigged.glb out.glb [--src tripo.glb] [--viz dir]

Что добавляется (всё — нулевое в покое):
  • Lids_V5 — веки-«шторки» (свой маленький материал: мех вокруг глаза Tripo, у кромки — тонкая тёмная линия из полосы
    ресниц Tripo). Верх века — нижний край нарисованной дуги ресниц (дуга Tripo остаётся на месте), в покое все ряды
    века стянуты в эту линию (нулевая площадь — не видно). Закрытое — до нижнего контура глаза. Путь закрытия —
    4 ключа lid{L,R}_1..4 (шаг от предыдущего положения): веко идёт по куполу нарисованного глаза (одной хордой
    уходило в глаз до 4 мм). Наклонов века (злость/грусть) нет: косое веко одним ключом от покоя резало радужку
    (белок проступал пятнами) — злость и грусть передают брови, рот и общее прикрытие века.
  • ключи тела (имена — веса лица, их ведёт прежний цикл GlbCharacter по MORPH_TARGETS): mouth_A/E/O/U/M — челюсть
    (поворот низа морды, губы и дна полости Tripo вокруг шарнира в глубине рта), O/U — уголки к центру и губы вперёд,
    E — шире; smile / frown / smirk — уголки рта; cheek_up — щёки под глазами; brow_up / brow_down / brow_sad — мягкие
    брови Tripo над глазами (полоса ресниц и глаз не двигаются). Нормали ключей — разность пересчитанных нормалей.
Ориентиры — по снимку спереди (растр тела с UV → цвет текстуры): белок + радужка → разрез глаза, тёмная полоса над
ним → ресницы; тёмно-красное → рот. Печатаются и кладутся в asset.extras.glitterV5.marks (прокси colliders.py, листы).
"""
import sys, os, json
import numpy as np
from scipy import ndimage as nd
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from v5_common import Glb, body, raster_front, interp, sample  # noqa: E402

src, dst = sys.argv[1:3]
VIZ = sys.argv[sys.argv.index('--viz') + 1] if '--viz' in sys.argv else None
if VIZ:
    os.makedirs(VIZ, exist_ok=True)

g = Glb(src); j = g.j
B = body(g)
# концевые кости (HeadTop_End, *Toe_End, пальцы *4): у Tripo они есть узлами, но не в скине — места берём у исходника
if '--src' in sys.argv:
    s0 = Glb(sys.argv[sys.argv.index('--src') + 1]).j
    byname = {n.get('name'): n for n in s0['nodes']}
    k = 0
    for n_ in j['nodes']:
        nm = n_.get('name', '')
        if (nm.endswith('_End') or nm[-1:] == '4') and nm.startswith('mixamorig') and nm in byname:
            o = dict(byname[nm])
            if 'matrix' in o:  # у Tripo — матрицей: в TRS
                from scipy.spatial.transform import Rotation
                M = np.array(o.pop('matrix')).reshape(4, 4).T
                sc_ = np.linalg.norm(M[:3, :3], axis=0)
                o['translation'] = M[:3, 3].tolist()
                o['rotation'] = Rotation.from_matrix(M[:3, :3] / sc_).as_quat().tolist()
            for key in ('translation', 'rotation', 'scale', 'matrix'):
                n_.pop(key, None)
                if key in o:
                    n_[key] = o[key]
            k += 1
    print('концевые кости — как у Tripo:', k)
P, N, UV, I = B['P'], B['N'], B['UV'], B['I']
Nn = N / np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-9)
mat0 = j['materials'][B['pr']['material']]
tex = np.array(g.image(j['textures'][mat0['pbrMetallicRoughness']['baseColorTexture']['index']]['source']).convert('RGB'))
mrtex = np.array(g.image(j['textures'][mat0['pbrMetallicRoughness']['metallicRoughnessTexture']['index']]['source']).convert('RGB'))

# ── снимок лица спереди ──
head = P[:, 1] > np.percentile(P[:, 1], 55)
BOX = (-0.22, 0.22, 0.58, 0.92); PX = 0.0004
tri, bary, depth = raster_front(P, I, BOX, PX)
H_, W_ = tri.shape
img_uv = interp(UV, I, tri, bary)
img = sample(tex, img_uv).astype(float); img[tri < 0] = 255
img_P = interp(P, I, tri, bary)
img_N = interp(Nn, I, tri, bary); img_N /= np.maximum(np.linalg.norm(img_N, axis=-1, keepdims=True), 1e-9)
Lum = img.mean(-1)


def to_px(p):
    return (p[..., 0] - BOX[0]) / PX, (BOX[3] - p[..., 1]) / PX


def surf(x, y):
    """точка поверхности и нормаль по координатам снимка (билинейно по пикселям растра)"""
    xi = np.clip(np.floor(x - 0.5).astype(int), 0, W_ - 2); yi = np.clip(np.floor(y - 0.5).astype(int), 0, H_ - 2)
    fx = np.clip(x - 0.5 - xi, 0, 1)[..., None]; fy = np.clip(y - 0.5 - yi, 0, 1)[..., None]

    def bl(A):
        return (A[yi, xi] * (1 - fx) * (1 - fy) + A[yi, xi + 1] * fx * (1 - fy) + A[yi + 1, xi] * (1 - fx) * fy + A[yi + 1, xi + 1] * fx * fy)
    p = bl(img_P); n = bl(img_N)
    return p, n / np.maximum(np.linalg.norm(n, axis=-1, keepdims=True), 1e-9)


# видимые спереди вершины (кожа лица; полость рта и изнанка — нет)
vx, vy = to_px(P)
inb = (vx >= 0) & (vx < W_ - 1) & (vy >= 0) & (vy < H_ - 1)
front = np.zeros(len(P), bool)
front[inb] = np.abs(depth[vy[inb].astype(int), vx[inb].astype(int)] - P[inb, 2]) < 0.0025

# ── глаза: белок + радужка (+ зрачок внутри) → разрез; над ним — полоса ресниц ──
mx, mn = img.max(-1), img.min(-1)
r_, g_, b_ = img[..., 0], img[..., 1], img[..., 2]
white = (Lum > 190) & (mx - mn < 45) & (tri >= 0)
green = (g_ > r_ + 20) & (g_ > b_ - 15) & (tri >= 0)
blob = white | green
dark = (Lum < 100) & (tri >= 0)
eyes = {}
for side, (x0, x1) in (('R', (150, 540)), ('L', (560, 950))):  # L — левый глаз кота (+X, справа на снимке)
    m = np.zeros_like(blob); m[350:620, x0:x1] = blob[350:620, x0:x1]
    lab, n = nd.label(m); k = np.argmax(nd.sum(m, lab, range(1, n + 1))) + 1
    eye = nd.binary_fill_holes(nd.binary_closing(nd.binary_fill_holes(lab == k), iterations=4))
    ys, xs = np.where(eye)
    cols = np.arange(xs.min(), xs.max() + 1)
    top = np.array([np.where(eye[:, x])[0].min() for x in cols], float)
    bot = np.array([np.where(eye[:, x])[0].max() for x in cols], float)
    lt = []
    for x, t in zip(cols, top.astype(int)):
        y = t - 1; skip = 0
        while y > 0 and not dark[y, x] and skip < 4:
            y -= 1; skip += 1
        while y > 0 and dark[y, x] and t - y < 60:
            y -= 1
        lt.append(y + 1)
    lt = np.array(lt, float)
    sm = lambda a: nd.uniform_filter1d(nd.median_filter(a, 5), 5)
    eyes[side] = dict(eye=eye, x=cols.astype(float), top=sm(top), bot=sm(bot), lt=sm(np.minimum(lt, top)))
    e = eyes[side]
    print(f'глаз {side}: x {cols[0]}…{cols[-1]} px, верх {e["top"].min():.0f}, низ {e["bot"].max():.0f}, '
          f'полоса ресниц {np.median(e["top"] - e["lt"]):.1f} px ({np.median(e["top"] - e["lt"]) * PX * 1000:.1f} мм)')

# ── рот: тёмно-красное под носом ──
red = (r_ > g_ + 35) & (Lum < 175) & (tri >= 0)
m = np.zeros_like(red); m[640:790, 380:720] = red[640:790, 380:720]
lab, n = nd.label(m); k = np.argmax(nd.sum(m, lab, range(1, n + 1))) + 1
mouth = nd.binary_fill_holes(nd.binary_closing(lab == k, iterations=3))
ys, xs = np.where(mouth)
mcols = np.arange(xs.min(), xs.max() + 1)
mU = np.array([np.where(mouth[:, x])[0].min() if mouth[:, x].any() else np.nan for x in mcols])
mD = np.array([np.where(mouth[:, x])[0].max() if mouth[:, x].any() else np.nan for x in mcols])
cxm = (xs.min() + xs.max()) / 2
cornerL = np.array([xs.max(), ys[xs >= xs.max() - 3].mean()]); cornerR = np.array([xs.min(), ys[xs <= xs.min() + 3].mean()])
Wm = (xs.max() - xs.min()) * PX
yMid_px = np.nanmedian((mU + mD) / 2)
Hm = (np.nanmax(mD) - np.nanmin(mU)) * PX
print(f'рот: x {xs.min()}…{xs.max()} px (ширина {Wm * 1000:.0f} мм), y {np.nanmin(mU):.0f}…{np.nanmax(mD):.0f} (высота {Hm * 1000:.0f} мм)')
# нос — розовое над ртом
pink = (r_ > b_ + 10) & (r_ > g_ + 25) & (Lum > 120) & (tri >= 0)
m = np.zeros_like(pink); m[520:660, 450:650] = pink[520:660, 450:650]
ys_n, xs_n = np.where(m)
nose_px = (xs_n.mean(), ys_n.mean())


def P3(x, y):
    return surf(np.array([x], float), np.array([y], float))[0][0]


cav = (~front) & (np.abs(P[:, 0] - (cxm * PX + BOX[0])) < Wm * 0.62) & (P[:, 1] > BOX[3] - (np.nanmax(mD) + 30) * PX) \
    & (P[:, 1] < BOX[3] - (np.nanmin(mU) - 10) * PX) & (P[:, 2] > 0.06)
zc = P[cav, 2]
hinge = np.array([0.0, BOX[3] - yMid_px * PX, np.percentile(zc, 3) if len(zc) else 0.1])
marks = {
    'eyeOuterL': P3(eyes['L']['x'][-1], (eyes['L']['top'][-1] + eyes['L']['bot'][-1]) / 2).round(5).tolist(),
    'eyeInnerL': P3(eyes['L']['x'][0], (eyes['L']['top'][0] + eyes['L']['bot'][0]) / 2).round(5).tolist(),
    'eyeOuterR': P3(eyes['R']['x'][0], (eyes['R']['top'][0] + eyes['R']['bot'][0]) / 2).round(5).tolist(),
    'eyeInnerR': P3(eyes['R']['x'][-1], (eyes['R']['top'][-1] + eyes['R']['bot'][-1]) / 2).round(5).tolist(),
    'eyeBottomL': P3(eyes['L']['x'][len(eyes['L']['x']) // 2], eyes['L']['bot'].max()).round(5).tolist(),
    'eyeBottomR': P3(eyes['R']['x'][len(eyes['R']['x']) // 2], eyes['R']['bot'].max()).round(5).tolist(),
    'eyeTopL': float(BOX[3] - eyes['L']['lt'].min() * PX), 'eyeTopR': float(BOX[3] - eyes['R']['lt'].min() * PX),
    'nose': P3(*nose_px).round(5).tolist(), 'noseTop': P3(nose_px[0], ys_n.min()).round(5).tolist(),
    'mouthL': P3(*cornerL).round(5).tolist(), 'mouthR': P3(*cornerR).round(5).tolist(),
    'mouth': P3(cxm, yMid_px).round(5).tolist(), 'noseHalfW': float((xs_n.max() - xs_n.min()) / 2 * PX),
    'hinge': hinge.round(5).tolist(), 's': 1.0,
}
print('шарнир челюсти', hinge.round(3), 'вершин полости', int(cav.sum()))

# v5d: снимок 0.1 мм у глаз — полоса ресниц Tripo для века (на 0.4 мм тонкие лепестки ресниц размываются в мех)
PXH = 0.0001
_xa = BOX[0] + (min(eyes['R']['x'][0], eyes['L']['x'][0]) - 60) * PX; _xb = BOX[0] + (max(eyes['R']['x'][-1], eyes['L']['x'][-1]) + 60) * PX
_ya = BOX[3] - (max(eyes['R']['bot'].max(), eyes['L']['bot'].max()) + 10) * PX
_yb = BOX[3] - (min(eyes['R']['lt'].min(), eyes['L']['lt'].min()) - 70) * PX
BOXH = (_xa, _xb, _ya, _yb)
trih, baryh, _ = raster_front(P, I, BOXH, PXH)
imgh = sample(tex, interp(UV, I, trih, baryh)).astype(float)


def hires(x, y):
    """цвет снимка 0.1 мм в точке снимка 0.4 мм (билинейно)"""
    X = ((BOX[0] + x * PX) - BOXH[0]) / PXH - 0.5; Y = (BOXH[3] - (BOX[3] - y * PX)) / PXH - 0.5
    return np.stack([nd.map_coordinates(imgh[..., q], [np.atleast_1d(Y), np.atleast_1d(X)], order=1, mode='nearest') for q in range(3)], -1)


# ════════════════ веки ════════════════
NC, NR = 30, 16
NF, VS, PET = 6, 0.3, 30.0  # v5d: рядов меха над полосой ресниц, доля текстуры меха, запас над полосой ресниц (px)
DT, DM = 0.0008, 0.0024  # отступ века от поверхности: у верха (покой) и к кромке (м); радужка Tripo выпуклее белка
TW, TH = 384, 96  # текстура века одного глаза (v5d: крупнее — ресницы на веке; < 1024 px — model-opt не жмёт в KTX2)
LID_X, LID_Y = 13.0, 11.0  # запас закрытого века за разрез: по бокам и снизу (px снимка, 0.4 мм)
lid_img = np.zeros((2 * TH, TW * 2, 3), np.uint8)  # верх — верхние веки, низ — нижние (v5c)
lid_a = np.full((2 * TH, TW * 2), 255, np.uint8)  # v5d: альфа — верх века (мех над ресницами) растворяется в мех тела
NRL = 8  # рядов нижнего века
DLO = 0.0010  # отступ нижнего века (под верхним: у кромки верхнего 1.8 мм)
lid_base = {}
lid_strip = {}  # v5d: полоса ресниц в покое по столбцам века (x, верх, низ — px снимка)
skin_pos = []  # положение для скина (закрытое веко / поднятое нижнее)
LV, LUV, LF, LN = [], [], [], []
keys = {}  # имя → смещения (позиции) и нормалей
rest_pos, rest_n = [], []
side_of = []


def fur_col(x, ys_):
    """медиана меха (без тёмных ресниц) по столбцу x в диапазоне строк"""
    xi = int(np.clip(round(x), 0, W_ - 1))
    c = img[np.clip(ys_, 0, H_ - 1).astype(int), xi]
    ok = c.mean(-1) > 95
    return np.median(c[ok], 0) if ok.any() else np.median(img[int(ys_[0]), max(xi - 20, 0):xi + 20], 0)


for ei, side in enumerate(('L', 'R')):
    e = eyes[side]
    # на LID_X px шире разреза: закрытое веко накрывает и тёмный контур глаза Tripo в уголках (27.11: при 6 px контур
    # читался тёмной обводкой вокруг закрытого века)
    xs_e = np.linspace(e['x'][0] - LID_X, e['x'][-1] + LID_X, NC)
    t = np.interp(xs_e, e['x'], e['top']); bt = np.interp(xs_e, e['x'], e['bot']); lt_ = np.interp(xs_e, e['x'], e['lt'])
    # v5d: в покое веко — полоса ресниц Tripo на своём месте (копия; на теле ресницы закрашены мехом — v5_eyes.py), кромка —
    # у верха глаза; закрываясь, полоса едет с кромкой, над ней тянется мех века
    yT = t - 1.5
    yE = np.maximum(bt + LID_Y, yT + 3.0)  # кромка закрытого века — ниже нижнего контура глаза (и его тёмной обводки)
    Lg = yE - yT
    band = np.clip(t - lt_, 3, 40)
    # ── текстура века: мех сверху (над полосой ресниц) → мех снизу (под глазом), у кромки — тонкая тёмная линия ──
    # мех по столбцам — медиана без ресниц, затем сглаживание вдоль глаза (лепестки ресниц у внешнего уголка не
    # дают тёмных полос)
    def fur_row(y_of_x, d0, d1):
        cs = []
        for x, y0 in zip(xs_e, y_of_x):
            xi = int(np.clip(round(x), 0, W_ - 1))
            c = img[np.clip(np.arange(int(y0 + d0), int(y0 + d1)), 0, H_ - 1), xi]
            cs.append(c)
        allc = np.concatenate(cs)
        ref = np.median(allc[allc.mean(-1) > 95], 0)
        out = []
        for c in cs:
            ok = np.linalg.norm(c - ref, axis=1) < 40
            out.append(np.median(c[ok], 0) if ok.sum() >= 2 else ref)
        out = np.array(out)
        return np.stack([nd.uniform_filter1d(nd.median_filter(out[:, q], 9, mode='nearest'), 7, mode='nearest') for q in range(3)], -1)
    FT = fur_row(lt_, -34, -8)
    # цвет линии у кромки — медиана тёмных пикселей полосы ресниц по столбцу (без белка и бликов)
    LC = []
    for x, y0, y1 in zip(xs_e, lt_, t):
        xi = int(np.clip(round(x), 0, W_ - 1))
        c = img[np.clip(np.arange(int(y0), int(y1) + 1), 0, H_ - 1), xi]
        dk = c[c.mean(-1) < 70]
        LC.append(np.median(dk, 0) if len(dk) else np.array([20.0, 28, 55]))
    LC = np.array(LC)
    LC = np.stack([nd.uniform_filter1d(LC[:, q], 5, mode='nearest') for q in range(3)], -1)
    FB = fur_row(yE, 4, 16)
    # v5d: текстура верхнего века — мех (верх растворяется альфой в мех тела) и полоса ресниц Tripo (копия снимка от PET
    # px над полосой до верха глаза; альфа — ресницы, мех между ними прозрачен в покое, шейдер делает его непрозрачным,
    # когда веко закрывается)
    for i in range(TW):
        x = xs_e[0] + (i + 0.5) / TW * (xs_e[-1] - xs_e[0])
        k = np.interp(x, xs_e, np.arange(NC))
        ftop = np.array([np.interp(k, np.arange(NC), FT[:, q]) for q in range(3)])
        l0 = np.interp(k, np.arange(NC), lt_) - PET; l1 = np.interp(k, np.arange(NC), yT)
        ltk = np.interp(k, np.arange(NC), lt_)
        for jj in range(TH):
            v = (jj + 0.5) / TH
            if v < VS:
                c = ftop; a = np.clip(v / (VS / NF), 0, 1) ** 1.5
            else:
                f = (v - VS) / (1 - VS)
                yy = l0 + (l1 - l0) * f
                c = hires(x, yy)[0]
                # ресница — тёмное; полоса (ниже верха полосы ресниц) — целиком
                a = 1.0 if yy >= ltk - 1 else float(np.clip((150 - c.mean()) / 50, 0, 1))
                # мех между ресницами — к меху века (виден, когда веко закрыто)
                c = ftop + (c - ftop) * a
            lid_img[jj, ei * TW + i] = np.clip(c, 0, 255)
            lid_a[jj, ei * TW + i] = int(round(255 * a))
        # нижнее веко (v5c): мех под глазом, к верхней кромке — чуть темнее и мягкая линия (нижние ресницы)
        fbot = np.array([np.interp(k, np.arange(NC), FB[:, q]) for q in range(3)])
        lc = np.array([np.interp(k, np.arange(NC), LC[:, q]) for q in range(3)])
        for jj in range(TH):
            s = (jj + 0.5) / TH  # 0 — низ, 1 — кромка
            c = fbot * (1 - 0.1 * s ** 3)
            dpx = (1 - s) * 40
            if dpx < 3.2:
                a = 0.55 * np.clip((3.2 - dpx) / 1.6, 0, 1)
                c = c * (1 - a) + lc * a
            lid_img[TH + jj, ei * TW + i] = np.clip(c, 0, 255)
    # ── сетка века: ряды по s (кромка — s=1), ключи пути закрытия c = k/4 ──
    base = len(LV)
    S = np.linspace(0, 1, NR + 1)

    yTop0 = lt_ - PET  # верх века (неподвижен): верх полосы ресниц в покое
    HS = yT - yTop0  # высота полосы ресниц, px снимка
    lid_strip[side] = (xs_e.copy(), yTop0.copy(), yT.copy())

    def pos_at(c, shape=None):
        """позиции и нормали века при закрытии c (shape — своё c по столбцам: наклоны, «^»)"""
        cc = np.full(NC, c) if shape is None else shape
        yE_ = yT + cc * Lg
        yS = yE_ - HS
        Y = np.zeros((NR + 1, NC))
        hf = yS - yTop0  # высота меха века над полосой ресниц
        for r in range(NR + 1):
            if r == 0:
                Y[r] = yTop0
            elif r <= NF:
                # первый ряд — тонкая кайма (≤ 6 px), где верх века растворяется альфой в мех тела
                y1_ = yTop0 + np.minimum(6.0, 0.5 * hf)
                Y[r] = y1_ + (yS - y1_) * ((r - 1) / (NF - 1))
            else:
                Y[r] = yS + (yE_ - yS) * ((r - NF) / (NR - NF))
        X = np.repeat(xs_e[None, :], NR + 1, 0)
        p, n_ = surf(X, Y)
        fr = np.clip((Y - yTop0[None, :]) / np.maximum(yE_ - yTop0, 1e-6)[None, :], 0, 1)
        dlt = DT + (DM - DT) * np.sqrt(fr) * np.clip(4 * cc, 0, 1)[None, :]
        return (p + n_ * dlt[..., None]).reshape(-1, 3), n_.reshape(-1, 3)

    p0, n0 = pos_at(0.0)
    rest_pos.append(p0); rest_n.append(n0)
    U = ei * 0.5 + (0.5 / TW) + np.linspace(0, 1, NC) * (0.5 - 1.0 / TW)
    for r in range(NR + 1):
        vr = (VS / NF if r == 1 else VS * r / NF) if r <= NF else VS + (1 - VS) * (r - NF) / (NR - NF)
        for c_ in range(NC):
            LUV.append((U[c_], 0.5 * (0.5 / TH + vr * (1 - 1.0 / TH))))
            side_of.append(side)
    LV.extend(p0)
    for r in range(NR):
        for c_ in range(NC - 1):
            a = base + r * NC + c_; b = a + 1; cdn = a + NC; d = cdn + 1
            LF.extend([(a, cdn, b), (b, cdn, d)])  # снаружи — к камере (+Z)
    prev = (p0, n0)
    for k in range(1, 5):
        pk, nk = pos_at(k / 4)
        keys.setdefault(f'lid{side}_{k}', []).append((base, pk - prev[0], nk - prev[1]))
        prev = (pk, nk)
    skin_pos.append(pk)
    lid_base[side] = base
    # ── v5c: косое веко и смех — своя форма кромки по столбцам (ключ от покоя; веко-оболочка по куполу глаза) ──
    Hh = float(e['bot'].max() - e['top'].min())
    u = np.clip((xs_e - e['x'][0]) / (e['x'][-1] - e['x'][0]), 0, 1)
    uin = u if side == 'L' else 1 - u  # 0 — внутренний уголок (у переносицы), 1 — внешний
    tmin = float(e['top'].min())
    arc = tmin + Hh * (0.66 - 0.36 * np.sin(np.pi * u))  # «^» смеха: дуга вверх
    EDGES = {
        # грусть: внешний край века ниже (опущенные уголки), внутренний — почти открыт
        'sad': t + Hh * (0.04 + 0.28 * uin ** 1.3),
        # недовольство/обида: тяжёлое веко, ниже у переносицы
        'mad': np.maximum(t, tmin + Hh * (0.50 - 0.28 * uin)),
        'laugh': arc,
    }
    for nm, ye in EDGES.items():
        cc = np.clip((ye - yT) / Lg, 0, 1)
        pk, nk = pos_at(0.0, shape=cc)
        keys.setdefault(f'lid{side}_{nm}', []).append((base, pk - p0, nk - n0))
    # ── v5c: нижнее веко — ряды от линии под глазом (покой: стянуты в линию) вверх ──
    baseL = base + (NR + 1) * NC
    yB = yE.copy()
    SL = np.linspace(0, 1, NRL + 1)

    def pos_lo(ytop):
        ytop = np.minimum(ytop, yB)
        X = np.repeat(xs_e[None, :], NRL + 1, 0)
        Y = yB[None, :] - SL[:, None] * (yB - ytop)[None, :]
        p, n_ = surf(X, Y)
        dlt = DT + (DLO - DT) * np.clip(SL * 3, 0, 1)[:, None] * np.ones(NC)[None, :]
        return (p + n_ * dlt[..., None]).reshape(-1, 3), n_.reshape(-1, 3)
    q0, m0 = pos_lo(yB)
    rest_n.append(m0)
    for r in range(NRL + 1):
        for c_ in range(NC):
            LUV.append((U[c_], 0.5 + 0.5 * (0.5 / TH + SL[r] * (1 - 1.0 / TH))))
            side_of.append(side)
    LV.extend(q0)
    for r in range(NRL):
        for c_ in range(NC - 1):
            a = baseL + r * NC + c_; b = a + 1; cup = a + NC; d = cup + 1
            LF.extend([(a, b, cup), (b, d, cup)])
    LOS = {
        # прищур снизу (радость): щёки поднимают нижнее веко, кромка — мягкая дуга
        'lo': bt - Hh * 0.30 * (0.65 + 0.35 * np.sin(np.pi * u)),
        # смех: до дуги «^» (под кромкой верхнего века)
        'lolaugh': arc - 2.0,
    }
    for nm, ye in LOS.items():
        pk, nk = pos_lo(ye)
        keys.setdefault(f'lid{side}_{nm}', []).append((baseL, pk - q0, nk - m0))
    skin_pos.append(pos_lo(LOS['lolaugh'])[0])
    print(f'веко {side}: {NC}×{NR + 1} вершин, ход кромки {Lg.max() * PX * 1000:.0f} мм, полоса ресниц {np.median(band):.0f} px')

LV = np.array(LV, np.float32); LUV = np.array(LUV, np.float32); LF = np.array(LF, np.uint32)
LN = np.concatenate(rest_n).astype(np.float32)
nL = len(LV)
# скин век — у всех рядов столбца один (ближайшая вершина тела к середине пути века по столбцу): в покое ряды стянуты в
# линию и остаются линией при любом повороте головы относительно шеи (v5d: при разных весах рядов — шея/голова — линия
# покоя расходилась полосой меха между ресницами и глазом)
from scipy.spatial import cKDTree  # noqa: E402
closed = np.concatenate(skin_pos)  # верхние — закрытые, нижние — поднятые до «^»
assert len(closed) == nL
kd = cKDTree(P)
anchor = np.zeros_like(closed)
o_ = 0
for blk in (NR + 1, NRL + 1, NR + 1, NRL + 1):  # верх L, низ L, верх R, низ R — ряды × NC
    seg = closed[o_:o_ + blk * NC].reshape(blk, NC, 3)
    anchor[o_:o_ + blk * NC] = np.repeat(seg[blk // 2][None], blk, 0).reshape(-1, 3)
    o_ += blk * NC
_, nn = kd.query(anchor)
LJ = B['J'][nn]; LW = B['W'][nn]

# ════════════════ ключи тела ════════════════
cx = cxm * PX + BOX[0]
my = BOX[3] - yMid_px * PX
cR3 = np.array(marks['mouthR']); cL3 = np.array(marks['mouthL'])
eyeL3 = np.array(marks['eyeOuterL']); eyeR3 = np.array(marks['eyeOuterR'])
D_eye = abs((np.array(marks['eyeInnerL'])[0] + eyeL3[0]) / 2 - (np.array(marks['eyeInnerR'])[0] + eyeR3[0]) / 2)
ss = lambda a, b, x: np.clip((x - a) / (b - a), 0, 1) ** 2 * (3 - 2 * np.clip((x - a) / (b - a), 0, 1))

# низ морды (челюсть): кожа ниже середины рта и дно полости (нормаль вверх), спереди от шарнира
dx = np.abs(P[:, 0] - cx)
# v5c: по глубине — плавно (раньше резкая граница z > шарнир: под подбородком на «а» тянулись тёмные треугольники)
face_zone = (P[:, 2] > hinge[2] - 0.03) & (P[:, 1] > my - 0.2) & (P[:, 1] < my + 0.03)
zf = ss(hinge[2] - 0.03, hinge[2] + 0.004, P[:, 2])
mU_y = BOX[3] - np.interp(P[:, 0], mcols * PX + BOX[0], np.nan_to_num(mU, nan=np.nanmin(mU))) * PX
mD_y = BOX[3] - np.interp(P[:, 0], mcols * PX + BOX[0], np.nan_to_num(mD, nan=np.nanmax(mD))) * PX
mid_y = (mU_y + mD_y) / 2
lower = np.where(front, P[:, 1] < mid_y, (Nn[:, 1] > 0.05) & (P[:, 1] < hinge[1] + 0.006))
# сбоку от уголков — кожа щёк (ниже уголков тоже немного едет)
wx = 1 - ss(Wm * 0.5, Wm * 0.95, dx)
wy = ss(my - 0.155, my - 0.085, P[:, 1])
jaw_w = (lower & face_zone).astype(float) * wx * wy
# у самого шва губ сверху (уголки) — плавно: вершины чуть выше середины рта, но у уголков — половина
jaw_w = np.where(front & (P[:, 1] >= mid_y) & (P[:, 1] < mid_y + 0.006) & face_zone, 0.5 * wx * wy * (1 - (P[:, 1] - mid_y) / 0.006), jaw_w)
jaw_w[~face_zone] = 0
jaw_w *= zf
print(f'челюсть: вершин {int((jaw_w > 0.01).sum())} (полная — {int((jaw_w > 0.99).sum())})')


def rot_x(p, h, ang):
    """поворот вокруг оси X через h на ang (рад; > 0 — низ вниз-назад: открыть)"""
    q = p - h
    ca, sa = np.cos(ang), np.sin(ang)
    y = q[:, 1] * ca - q[:, 2] * sa; z = q[:, 1] * sa + q[:, 2] * ca
    return np.c_[p[:, 0], y + h[1], z + h[2]]


near_mouth = np.exp(-((P[:, 0] - cx) / (Wm * 0.62)) ** 2 - ((P[:, 1] - my) / (Hm * 2.4)) ** 2) * (P[:, 2] > hinge[2] - 0.004)


def jaw(ang, squeeze=0.0, fwd=0.0, wide=0.0, up=0.0):
    w = jaw_w
    Q = P.copy()
    sel = w > 1e-4
    for i in np.where(sel)[0]:
        Q[i] = rot_x(P[i:i + 1], hinge, ang * w[i])[0]
    g_ = near_mouth
    Q[:, 0] = cx + (Q[:, 0] - cx) * (1 - squeeze * g_ + wide * g_)
    Q[:, 2] += fwd * g_ * (front | (P[:, 2] > hinge[2] + 0.03))
    Q[:, 1] += up * g_ * ss(Wm * 0.15, Wm * 0.45, dx)
    return Q - P


def corners(dy, dxo=0.0, dz=0.0, sides=('L', 'R'), soft=1.0):
    """уголки рта: гауссиана вокруг уголка; soft > 1 — шире (хмурый рот: щека тянется плавно, без складки)"""
    D = np.zeros_like(P)
    for sd, c in (('L', cL3), ('R', cR3)):
        if sd not in sides:
            continue
        r2 = ((P[:, 0] - c[0]) / (Wm * 0.3 * soft)) ** 2 + ((P[:, 1] - c[1]) / (Wm * 0.25 * soft)) ** 2
        w = np.exp(-r2 * 1.6) * (P[:, 2] > hinge[2] - 0.004)
        D[:, 1] += dy * w; D[:, 0] += np.sign(c[0] - cx) * dxo * w; D[:, 2] += dz * w
    return D


def onto_surface(D):
    """сдвиг кожи лица спереди — вдоль поверхности (z — глубина растра в новом месте); полость — как есть"""
    Q = P + D
    m_ = front & (np.abs(D[:, :2]).sum(1) > 1e-6) & (np.abs(D[:, 2]) < 1e-9)
    if m_.any():
        qx, qy = to_px(Q[m_])
        ok = (qx > 0) & (qx < W_ - 1) & (qy > 0) & (qy < H_ - 1)
        idx = np.where(m_)[0][ok]
        p_, _ = surf(qx[ok], qy[ok])
        dz = p_[:, 2] - P[idx, 2]
        # над краем полости или силуэтом растр даёт чужую глубину — там вершина едет в плоскости снимка
        dxy = np.linalg.norm(D[idx, :2], axis=1)
        D[idx, 2] = np.where(np.abs(dz) <= np.maximum(0.0015, 1.5 * dxy), dz, 0.0)
    return D


# брови Tripo: мягкие тёмные дуги над глазами — область над полосой ресниц
brow_c = {}
for sd in 'LR':
    e = eyes[sd]
    xc = (e['x'][0] + e['x'][-1]) / 2
    brow_c[sd] = np.array([xc * PX + BOX[0], BOX[3] - (e['lt'].min() - 0.55 * (e['bot'].max() - e['top'].min())) * PX])
for sd in 'LR':  # v5c: дуга брови для шейдера (src/character/v5Face.ts — тёмная мягкая дуга меха): центр и полуширина
    e = eyes[sd]
    marks['brow' + sd] = [round(float(brow_c[sd][0]), 5), round(float(brow_c[sd][1]), 5),
                          round(float((e['x'][-1] - e['x'][0]) / 2 * PX), 5)]
lash_top_y = {sd: BOX[3] - np.interp(P[:, 0], eyes[sd]['x'] * PX + BOX[0], eyes[sd]['lt'], left=np.nan, right=np.nan) * PX for sd in 'LR'}


def brow(dy_in, dy_out, dx_in=0.0, sides='LR'):
    D = np.zeros_like(P)
    for sd in sides:
        e = eyes[sd]
        c = brow_c[sd]
        r2 = ((P[:, 0] - c[0]) / (D_eye * 0.62)) ** 2 + ((P[:, 1] - c[1]) / (D_eye * 0.42)) ** 2
        w = np.exp(-r2 * 1.3) * front
        # не трогать полосу ресниц и глаз: вес к нулю у верха ресниц
        lt_y = np.nan_to_num(lash_top_y[sd], nan=-1)
        w *= np.where(lt_y > 0, ss(0.0, 0.012, P[:, 1] - lt_y), ss(0.0, 0.012, P[:, 1] - (BOX[3] - e['lt'].min() * PX)))
        sgn_in = -np.sign(c[0])  # к переносице
        u = np.clip((P[:, 0] - c[0]) * np.sign(c[0]) / (D_eye * 0.5), -1, 1)  # −1 внутренний край, +1 внешний
        dy = dy_in * (1 - u) / 2 + dy_out * (1 + u) / 2
        D[:, 1] += dy * w; D[:, 0] += sgn_in * dx_in * w
    return D


def cheeks(dy):
    D = np.zeros_like(P)
    for sd in 'LR':
        e = eyes[sd]
        c = np.array([(e['x'][0] + e['x'][-1]) / 2 * PX + BOX[0], BOX[3] - (e['bot'].max() + 40) * PX])
        r2 = ((P[:, 0] - c[0]) / (D_eye * 0.5)) ** 2 + ((P[:, 1] - c[1]) / (D_eye * 0.3)) ** 2
        w = np.exp(-r2 * 1.5) * front
        bot_y = BOX[3] - np.interp(P[:, 0], e['x'] * PX + BOX[0], e['bot'], left=np.nan, right=np.nan) * PX
        w *= np.where(np.isnan(bot_y), 1, ss(0.0, 0.01, np.nan_to_num(bot_y) - P[:, 1]))
        D[:, 1] += dy * w
    return D


# сварка и рёбра — сглаживание ключей уголков (без граней на «грусти»: сдвиг соседей плавный, сетка у уголков гуще —
# v5_dense.py)
_key = np.round(P * 1e5).astype(np.int64)
_, WL = np.unique(_key, axis=0, return_inverse=True); WL = WL.ravel(); nWL = WL.max() + 1
EW = WL[np.r_[I[:, [0, 1]], I[:, [1, 2]], I[:, [2, 0]]]]


def smooth_key(D, it=6, mask=None):
    """лапласиан сдвига по сваренным соседям — кожа и край полости рта вместе (по отдельности край полости отставал
    от кожи: зазубрина в уголке)"""
    Dw = np.zeros((nWL, 3)); kw = np.zeros(nWL)
    np.add.at(Dw, WL, D); np.add.at(kw, WL, 1); Dw /= np.maximum(kw, 1)[:, None]
    for _ in range(it):
        S_ = np.zeros((nWL, 3)); k_ = np.zeros(nWL)
        np.add.at(S_, EW[:, 0], Dw[EW[:, 1]]); np.add.at(k_, EW[:, 0], 1)
        np.add.at(S_, EW[:, 1], Dw[EW[:, 0]]); np.add.at(k_, EW[:, 1], 1)
        Dn = 0.5 * Dw + 0.5 * S_ / np.maximum(k_, 1)[:, None]
        Dw = Dn
    return Dw[WL] if mask is None else D * (1 - mask[:, None]) + Dw[WL] * mask[:, None]


# челюсть у уголков: вершины уголка (полный поворот) и щеки рядом (меньше) расходились складкой — сбоку от середины рта
# сдвиг челюсти сглажен (между губами в середине рта — как есть, рот раскрывается)
LAT = ss(0.3 * Wm, 0.46 * Wm, np.abs(P[:, 0] - cx))


Hs = Hm
BODY_KEYS = {
    'mouth_A': smooth_key(jaw(0.21, squeeze=0.04), 5, LAT),
    'mouth_E': smooth_key(jaw(0.07, wide=0.07, up=0.002), 5, LAT),
    'mouth_O': smooth_key(jaw(0.15, squeeze=0.22, fwd=0.004), 5, LAT),
    'mouth_U': smooth_key(jaw(0.05, squeeze=0.32, fwd=0.006), 5, LAT),
    # M: у уголков — вполовину (уголок нижней губы, поднятый целиком, открывал тёмную стенку полости — зазубрина)
    'mouth_M': smooth_key(jaw(-0.11, squeeze=0.02) * (1 - 0.55 * LAT)[:, None], 10, LAT),
    'smile': onto_surface(smooth_key(corners(0.32 * Hs, 0.05 * Wm)) + cheeks(0.0025)),
    'frown': onto_surface(smooth_key(corners(-0.2 * Hs, -0.015 * Wm, soft=1.7))),
    'smirk': onto_surface(smooth_key(corners(0.36 * Hs, 0.04 * Wm, sides=('L',)))),
    'cheek_up': onto_surface(cheeks(0.004)),
}
# v5c: брови по сторонам (асимметрия: недовольство, подмигнуть) — ведёт v5Face.ts (v5BodyWeights), не цикл MORPH_TARGETS
for sd in 'LR':
    BODY_KEYS[f'brow_up_{sd}'] = onto_surface(brow(0.006, 0.005, sides=sd))
    BODY_KEYS[f'brow_down_{sd}'] = onto_surface(brow(-0.0055, 0.002, dx_in=0.0025, sides=sd))
    BODY_KEYS[f'brow_sad_{sd}'] = onto_surface(brow(0.0065, -0.002, dx_in=0.001, sides=sd))


# v5c: широко раскрытые глаза (удивление) — область нарисованного глаза с ресницами растягивается от центра
# (круг радужки остаётся кругом), к краю области — плавно в ноль
def eye_scale_D(Q, k=0.12, front_m=None):
    D = np.zeros_like(Q)
    for sd in 'LR':
        e = eyes[sd]
        cxp = (e['x'][0] + e['x'][-1]) / 2; cyp = (e['top'].min() + e['bot'].max()) / 2
        c = np.array([cxp * PX + BOX[0], BOX[3] - cyp * PX])
        rx = (e['x'][-1] - e['x'][0]) / 2 * PX
        ry_up = (cyp - e['lt'].min()) * PX; ry_dn = (e['bot'].max() - cyp) * PX
        q = Q[:, :2] - c
        r = np.sqrt((q[:, 0] / rx) ** 2 + (q[:, 1] / np.where(q[:, 1] > 0, ry_up, ry_dn)) ** 2)
        w = 1 - ss(1.12, 1.9, r)
        if front_m is not None:
            w = w * front_m
        D[:, :2] += q * (k * w)[:, None]
    return D


BODY_KEYS['eyes_wide'] = onto_surface(eye_scale_D(P, front_m=front.astype(float)))


# v5d: надутые щёки (обида): щёки под глазами и сбоку от рта — наружу по нормали и в стороны, у рта и глаз — ноль
def cheeks_puff(amt=0.0075):
    D = np.zeros_like(P)
    for sd, c3 in (('L', cL3), ('R', cR3)):
        e = eyes[sd]
        cxk = 0.5 * c3[0] + 0.5 * ((e['x'][0] + e['x'][-1]) / 2 * PX + BOX[0])
        cyk = 0.55 * c3[1] + 0.45 * (BOX[3] - e['bot'].max() * PX)
        r2 = ((P[:, 0] - cxk) / (D_eye * 0.55)) ** 2 + ((P[:, 1] - cyk) / (D_eye * 0.42)) ** 2
        w = np.exp(-r2 * 1.4) * (P[:, 2] > hinge[2] - 0.02)
        w *= 1 - np.exp(-(((P[:, 0] - cx) / (Wm * 0.35)) ** 2 + ((P[:, 1] - my) / (Hm * 1.2)) ** 2))  # губы не раздувать
        D += Nn * (amt * w)[:, None]
        D[:, 0] += np.sign(cxk - cx) * amt * 0.5 * w
    return smooth_key(D, 4)


BODY_KEYS['cheeks_puff'] = cheeks_puff()
# веки едут вместе с растянутым глазом (иначе линия покоя века осталась бы на белке)
for sd in 'LR':
    b0 = lid_base[sd]; nU = (NR + 1) * NC; nLo = (NRL + 1) * NC
    seg = LV[b0:b0 + nU + nLo].astype(np.float64)
    Dl = eye_scale_D(seg)
    keys[f'lid{sd}_wide'] = [(b0, Dl.astype(np.float32), np.zeros_like(Dl, np.float32))]


def vnormals(V, F):
    fn = np.cross(V[F[:, 1]] - V[F[:, 0]], V[F[:, 2]] - V[F[:, 0]])
    vn = np.zeros_like(V)
    for k in range(3):
        np.add.at(vn, F[:, k], fn)
    # по сваренным вершинам (швы UV)
    key = np.round(P * 1e5).astype(np.int64)
    _, wl = np.unique(key, axis=0, return_inverse=True); wl = wl.ravel()
    acc = np.zeros((wl.max() + 1, 3)); np.add.at(acc, wl, vn)
    vn = acc[wl]
    return vn / np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-12)


n_base = vnormals(P, I)
body_targets = []
for nm, D in BODY_KEYS.items():
    # < 0.12 мм — ноль (ключ разреженный; v5c: сетка лица вдвое гуще, хвосты лапласиана — не в файл)
    D[np.abs(D).max(1) < 1.2e-4] = 0
    moved = np.abs(D).max(1) > 1e-7
    dn = np.zeros_like(P)
    if moved.any():
        dn = vnormals(P + D, I) - n_base
        # нормали меняются и у соседей сдвинутых вершин — остальное ноль (шум округления)
        dn[np.abs(dn).max(1) < 4e-3] = 0
    body_targets.append((nm, D.astype(np.float32), dn.astype(np.float32)))
    print(f'ключ {nm}: вершин {int(moved.sum())}, макс. сдвиг {np.abs(D).max() * 1000:.1f} мм')

# ════════════════ запись GLB ════════════════
pr = B['pr']
pr['targets'] = []


def add_sparse(arr):
    """ключ разреженным accessor (glTF 2.0 §3.6.2.3): только ненулевые вершины"""
    arr = np.asarray(arr, np.float32)
    idx = np.where(np.abs(arr).max(1) > 0)[0].astype(np.uint32)
    acc = {'componentType': 5126, 'count': len(arr), 'type': 'VEC3',
           'min': arr.min(0).tolist(), 'max': arr.max(0).tolist()}
    if len(idx):
        def bv(data):
            j['bufferViews'].append({'buffer': 0, 'byteLength': len(data)})
            vi = len(j['bufferViews']) - 1; g.extra[vi] = data
            return vi
        acc['sparse'] = {'count': int(len(idx)), 'indices': {'bufferView': bv(idx.tobytes()), 'componentType': 5125},
                         'values': {'bufferView': bv(np.ascontiguousarray(arr[idx]).tobytes())}}
    j['accessors'].append(acc)
    return len(j['accessors']) - 1


for nm, D, dn in body_targets:
    pr['targets'].append({'POSITION': add_sparse(D), 'NORMAL': add_sparse(dn)})
bm = j['meshes'][B['mi']]
bm['name'] = 'Body_Glitter_V5'
bm['extras'] = {'targetNames': [t[0] for t in body_targets]}
bm['weights'] = [0.0] * len(body_targets)
for n_ in j['nodes']:
    if n_.get('mesh') == B['mi']:
        n_['name'] = 'Body_Glitter_V5'

# веки: свой материал (мех вокруг глаза — текстура века, без карты нормалей), шероховатость — как у меха рядом
eye_uv = img_uv[(tri >= 0) & ~blob & ~dark & (np.arange(H_)[:, None] > 330) & (np.arange(H_)[:, None] < 620)]
mrv = sample(mrtex, eye_uv[::50]).astype(float) / 255
rough = float(np.median(mrv[:, 1])); metal = float(np.median(mrv[:, 2]))
li = g.add_image(Image.fromarray(np.dstack([(lid_img // 4) * 4 + 2, lid_a]), 'RGBA'), 'glitter_v5_lids')  # 6 бит — размер
lt_i = g.add_texture(li, 0)
j['materials'].append({'name': 'Lids_V5', 'alphaMode': 'BLEND', 'pbrMetallicRoughness': {'baseColorTexture': {'index': lt_i}, 'metallicFactor': round(metal, 3), 'roughnessFactor': round(rough, 3)}})
lm = len(j['materials']) - 1
lid_names = sorted(keys.keys(), key=lambda s: (s[3], s))  # lidL_1..4, lidL_laugh, lidL_lo, …
ltargets = []
for nm in lid_names:
    dp = np.zeros((nL, 3), np.float32); dn = np.zeros((nL, 3), np.float32)
    for base, a, b in keys[nm]:
        dp[base:base + len(a)] = a; dn[base:base + len(b)] = b
    ltargets.append({'POSITION': add_sparse(dp), 'NORMAL': add_sparse(dn)})
Wn = LW.astype(np.float32)
if Wn.dtype != np.float32 or Wn.max() > 1.5:
    Wn = Wn / 255.0
lprim = {'attributes': {'POSITION': g.add_acc(LV, 5126, 'VEC3', 34962), 'NORMAL': g.add_acc(LN, 5126, 'VEC3', 34962),
                        'TEXCOORD_0': g.add_acc(LUV, 5126, 'VEC2', 34962),
                        'JOINTS_0': g.add_acc(LJ.astype(np.uint16), 5123, 'VEC4', 34962),
                        'WEIGHTS_0': g.add_acc(Wn.astype(np.float32), 5126, 'VEC4', 34962)},
         'indices': g.add_acc(LF.ravel(), 5125, 'SCALAR', 34963), 'material': lm, 'targets': ltargets}
j['meshes'].append({'name': 'Lids_V5', 'primitives': [lprim], 'extras': {'targetNames': lid_names}, 'weights': [0.0] * len(lid_names)})
j['nodes'].append({'name': 'Lids_V5', 'mesh': len(j['meshes']) - 1, 'skin': 0})
arm = next(i for i, n_ in enumerate(j['nodes']) if n_.get('name') == 'Armature')
j['nodes'][arm].setdefault('children', []).append(len(j['nodes']) - 1)
j['asset'].setdefault('extras', {})['glitterV5'] = {
    'face': 'tripo', 'lids': 'Lids_V5', 'marks': marks,
    # v5d: полоса ресниц Tripo, перенесённая на веко (на теле её закрашивает мехом v5_eyes.py): x, верх, низ (м модели)
    'lidStrip': {sd: [[round(float(BOX[0] + x * PX), 5), round(float(BOX[3] - a * PX), 5), round(float(BOX[3] - b * PX), 5)]
                      for x, a, b in zip(*lid_strip[sd])] for sd in lid_strip},
    'source': 'design/models/glitter_v5_rigged.glb (Tripo 4 вида, H3.1, Ultra, 4K PBR, одна сетка; Auto Rig Mixamo)',
}
size = g.save(dst)
print(f'→ {dst} ({size / 1e6:.2f} МБ): ключей тела {len(body_targets)}, век {len(lid_names)}, вершин век {nL}')

if VIZ:
    Image.fromarray(lid_img).resize((TW * 4, TH * 8), Image.NEAREST).save(f'{VIZ}/lid_tex.png')
    v = Image.fromarray(img.astype(np.uint8)).convert('RGB'); dr = ImageDraw.Draw(v)
    for sd in 'LR':
        e = eyes[sd]
        for arr, col in (('top', (255, 0, 0)), ('bot', (0, 0, 255)), ('lt', (255, 255, 0))):
            dr.line(list(zip(e['x'], e[arr])), fill=col, width=1)
    for x_, u_, d_ in zip(mcols, mU, mD):
        if not np.isnan(u_):
            dr.point((x_, u_), (0, 255, 0)); dr.point((x_, d_), (0, 255, 255))
    for c in (cornerL, cornerR):
        dr.ellipse((c[0] - 4, c[1] - 4, c[0] + 4, c[1] + 4), outline=(255, 0, 255))
    v.save(f'{VIZ}/landmarks.png')
    json.dump(marks, open(f'{VIZ}/marks.json', 'w'), indent=1)

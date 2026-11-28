"""Блёстка v5d, стадия «настоящие глаза поверх нарисованных»: глаз Tripo в покое — 1:1, но радужка двигается (взгляд),
зрачок сужается/расширяется, влажный блик едет со взглядом.

    python3 scripts/models/v5/v5_eyes.py face.glb out.glb [--viz dir]

Как:
  • снимок глаз спереди 0.1 мм/px (растр тела с UV → цвет текстуры Tripo 4K): белок (светлое) — разрез, радужка — эллипс
    по лучам из зрачка до первого белого (обводка, ресницы и свет внизу — мимо), зрачок — тёмное ядро радужки;
  • текстура EyeV5 (512², PNG — model-opt KTX2 не трогает текстуры < 1024 px: альфа без артефактов ETC1S):
    верх — «плашки» глаз (белок Tripo, на месте радужки — закрашен inpaint по белку; альфа — разрез внутри обводки,
    край 1.5 px), низ — радужки (круг Tripo в своих координатах эллипса; где радужку резала обводка — достроена по кругу);
  • сетка EyeV5 — поверхность тела в разрезе (+0.25 мм по нормали, под веками Lids_V5 — у них 0.5…1.8 мм), ключи — сдвиги
    кожи под вершиной (eyes_wide, щёки…), скин — от ближайшей вершины кожи;
  • в текстуре тела разрез глаза закрашен белком (под накладкой радужки Tripo больше нет — при взгляде в сторону не
    просвечивает).
Рисует шейдер (src/character/v5Face.ts, attachV5Eyes): белок с плашки, радужка — со сдвигом взгляда (мм) и
перерасчётом зрачка, блики. Параметры — asset.extras.glitterV5.eyes.
"""
import sys, os
import numpy as np
import cv2
from scipy import ndimage as nd
from scipy.spatial import cKDTree
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from v5_common import Glb, body, raster_front, interp, sample, uv_cover, bleed  # noqa: E402

src, dst = sys.argv[1:3]
VIZ = sys.argv[sys.argv.index('--viz') + 1] if '--viz' in sys.argv else None
g = Glb(src); j = g.j
B = body(g)
P, UV, I, N = B['P'], B['UV'], B['I'], B['N']
Nn = N / np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-9)
pr = B['pr']
mat0 = j['materials'][pr['material']]
tex_i = j['textures'][mat0['pbrMetallicRoughness']['baseColorTexture']['index']]['source']
tex_pil = g.image(tex_i).convert('RGB')
tex = np.array(tex_pil)
mrtex = np.array(g.image(j['textures'][mat0['pbrMetallicRoughness']['metallicRoughnessTexture']['index']]['source']).convert('RGB'))
names = j['meshes'][B['mi']]['extras']['targetNames']
TG = {nm: g.acc(t['POSITION']).astype(np.float64) for nm, t in zip(names, pr['targets'])}
ex5 = j['asset']['extras']['glitterV5']
marks = ex5['marks']

PX = 0.0001
# v5h: шире (±28 мм): веко продлено за внешний уголок (v5_face.py LID_XO) — полоса ресниц там тоже закрашивается
xa = min(marks['eyeOuterR'][0], marks['eyeInnerR'][0]) - 0.028
xb = max(marks['eyeOuterL'][0], marks['eyeInnerL'][0]) + 0.028
ya = min(marks['eyeBottomL'][1], marks['eyeBottomR'][1]) - 0.012
yb = max(marks['eyeTopL'], marks['eyeTopR']) + 0.024
BOX = (xa, xb, ya, yb)
tri, bary, depth = raster_front(P, I, BOX, PX)
H_, W_ = tri.shape
img_uv = interp(UV, I, tri, bary)
img = sample(tex, img_uv).astype(float); img[tri < 0] = 255
img_P = interp(P, I, tri, bary)
img_N = interp(Nn, I, tri, bary); img_N /= np.maximum(np.linalg.norm(img_N, axis=-1, keepdims=True), 1e-9)
Lum = img.mean(-1); mx, mn = img.max(-1), img.min(-1)
print(f'снимок глаз {W_}×{H_} px ({PX * 1000:.1f} мм/px)')

white = (Lum > 175) & (mx - mn < 60) & (tri >= 0)
whiteS = (Lum > 195) & (mx - mn < 50) & (tri >= 0)
green = (img[..., 1] > img[..., 0] + 20) & (img[..., 1] > img[..., 2] - 15) & (tri >= 0)
mid = W_ // 2
EYES = {}
for side in 'RL':  # R — справа у кота (−X, слева на снимке)
    m = np.zeros_like(white)
    sl = slice(0, mid) if side == 'R' else slice(mid, W_)
    m[:, sl] = (white | green)[:, sl]
    lab, n = nd.label(m); k = np.argmax(nd.sum(m, lab, range(1, n + 1))) + 1
    eye0 = nd.binary_fill_holes(lab == k)
    # зрачок — самое тёмное ядро внутри
    core = nd.binary_opening(eye0 & (Lum < 40), iterations=3)
    core |= nd.binary_opening(nd.binary_fill_holes(eye0) & (Lum < 40), iterations=3)
    lab3, n3 = nd.label(core); k3 = np.argmax(nd.sum(core, lab3, range(1, n3 + 1))) + 1
    pp = np.argwhere(nd.binary_fill_holes(lab3 == k3))[:, ::-1].astype(np.float32)
    (pcx, pcy), (pa, pb), pang = cv2.fitEllipse(pp)
    # радужка: лучи из зрачка до первого белого
    pts = []
    for a in np.linspace(0, 2 * np.pi, 720, endpoint=False):
        dx, dy = np.cos(a), np.sin(a)
        for r in np.arange(0.4 * max(pa, pb), 1.8 * max(pa, pb), 0.5):
            x, y = int(pcx + dx * r), int(pcy + dy * r)
            if not (0 <= x < W_ and 0 <= y < H_):
                break
            if whiteS[y, x]:
                pts.append((pcx + dx * (r - 1), pcy + dy * (r - 1)))
                break
    pts = np.array(pts, np.float32)
    rr = np.hypot(pts[:, 0] - pcx, pts[:, 1] - pcy); pts = pts[rr < 1.15 * np.median(rr)]
    for _ in range(3):
        (ex, ey), (ea, eb), eang = cv2.fitEllipse(pts)
        t = np.deg2rad(eang); c_, s_ = np.cos(t), np.sin(t)
        q = pts - (ex, ey); u = (q[:, 0] * c_ + q[:, 1] * s_) / (ea / 2); w = (-q[:, 0] * s_ + q[:, 1] * c_) / (eb / 2)
        res = np.abs(np.sqrt(u * u + w * w) - 1)
        pts = pts[res < max(0.015, np.percentile(res, 85))]
    t = np.deg2rad(eang)
    Rm = np.array([[np.cos(t), -np.sin(t)], [np.sin(t), np.cos(t)]])
    A = Rm @ np.diag([ea / 2, eb / 2])  # единичный круг → px снимка
    Ai = np.linalg.inv(A)
    yy, xx = np.mgrid[0:H_, 0:W_]
    qq = np.einsum('ij,hwj->hwi', Ai, np.stack([xx + 0.5 - ex, yy + 0.5 - ey], -1))
    rq = np.linalg.norm(qq, axis=-1)
    # разрез: белок + радужка (внутри эллипса) — внутри тёмной обводки
    # верх и низ разреза — кромка белка по столбцам; над/под радужкой (белка нет — радужку резали ресницы или обводка)
    # — гладкая кривая (многочлен по столбцам с белком у кромки), кайма радужки — по эллипсу
    wc = (lab == k) & white
    cols = np.where(wc.any(0))[0]
    topw = np.array([np.where(wc[:, x])[0].min() for x in cols], float)
    botw = np.array([np.where(wc[:, x])[0].max() for x in cols], float)
    okT = rq[topw.astype(int), cols] > 1.06
    okB = rq[botw.astype(int), cols] > 1.06
    xs_n = (cols - cols.mean()) / (np.ptp(cols) / 2)
    fitT = np.polyval(np.polyfit(xs_n[okT], topw[okT], 4), xs_n)
    fitB = np.polyval(np.polyfit(xs_n[okB], botw[okB], 4), xs_n)
    top_c = np.where(okT, topw, np.minimum(fitT, topw)); bot_c = np.where(okB, botw, np.maximum(fitB, botw))
    top_c = nd.uniform_filter1d(top_c, 5); bot_c = nd.uniform_filter1d(bot_c, 5)
    Eb = np.zeros_like(wc)
    for x, t0, b0 in zip(cols, top_c, bot_c):
        Eb[int(np.ceil(t0)):int(np.floor(b0)) + 1, x] = True
    E = nd.binary_fill_holes(nd.binary_closing(Eb | wc, iterations=2))
    lab4, n4 = nd.label(E); k4 = np.argmax(nd.sum(E, lab4, range(1, n4 + 1))) + 1
    E = lab4 == k4
    ys, xs = np.where(E)
    # зрачок в единицах радужки (радиус по среднему)
    pq = Ai @ np.array([pcx - ex, pcy - ey])
    pr0 = float(np.sqrt((pa / 2) * (pb / 2)) / np.sqrt((ea / 2) * (eb / 2)))
    EYES[side] = dict(E=E, c=(ex, ey), A=A, Ai=Ai, rq=rq, qq=qq, pr0=pr0, pq=pq, bbox=(xs.min(), xs.max(), ys.min(), ys.max()))
    print(f'глаз {side}: разрез x {xs.min()}…{xs.max()} y {ys.min()}…{ys.max()} px; радужка ({ex:.0f}, {ey:.0f}) '
          f'{ea * PX * 1000:.1f}×{eb * PX * 1000:.1f} мм {eang:.0f}°; зрачок {pr0:.2f} радиуса (сдвиг {pq.round(3)})')

# ── текстура тела: ресницы Tripo в полосе века закрашены мехом (их несёт веко Lids_V5 — v5_face.py, lidStrip) ──
th, tw = tex.shape[:2]
tex2 = tex.copy()
strip = ex5.get('lidStrip', {})
LP_UV = []
lpaint = np.zeros((th, tw), bool); lcol = np.zeros((th, tw, 3), float)
MSK = {}
for side, rows in strip.items():
    rows = np.array(rows)
    xs_p = (rows[:, 0] - BOX[0]) / PX; top_p = (BOX[3] - rows[:, 1]) / PX; bot_p = (BOX[3] - rows[:, 2]) / PX
    xa_, xb_ = int(np.ceil(xs_p.min())), int(np.floor(xs_p.max()))
    xx = np.arange(xa_, xb_ + 1)
    tp = np.interp(xx, xs_p, top_p); bp = np.interp(xx, xs_p, bot_p)
    # закраска: inpaint снимка 0.1 мм по меху вокруг (ресницы и полоса — тёмное в полосе века, с запасом)
    R = np.zeros((H_, W_), bool)
    for x, t0, b0 in zip(xx, tp, bp):
        R[max(int(np.floor(t0)) - 2, 0):int(np.ceil(b0)) + 1, x] = True
    # вся полоса (ресницы с их светлой каймой — иначе по краю лепестков оставались бледные контуры), без белка
    # v5e: светлое исключается только в разрезе глаза (белок): светлая кайма лепестков ресниц над глазом закрашивается
    # тоже — иначе при закрытом веке на теле оставались бледные «призраки» лепестков
    msk = nd.binary_dilation(R, iterations=3) & ~(((Lum > 175) & (mx - mn < 60)) & nd.binary_dilation(EYES[side]['E'], iterations=3))
    MSK[side] = msk
# v5f: цвет — гармоническое продолжение меха вокруг (inpaint снимка, 4× мельче; маска — полоса ресниц и глаз с каймой RB:
# белок и обводка не «затекают»): без светлой полосы с дугой-ступенькой над глазом (раньше — медиана меха по столбцу)
RB = 47  # кожа под накладкой глаза закрашена мехом до RB px от разреза (v5_eyes: накладка шире разреза)
MALL = np.zeros((H_, W_), bool)
for side in MSK:
    MALL |= MSK[side]
for side in 'LR':
    MALL |= nd.distance_transform_edt(~EYES[side]['E']) <= RB
# тёмное рядом (лепестки ресниц у уголков, обводка) — не источник цвета
MALL_SRC = MALL | (nd.binary_dilation(MALL, iterations=60) & (Lum < 125))
DS = 4
_sub = cv2.resize(img.clip(0, 255).astype(np.uint8), (W_ // DS, H_ // DS), interpolation=cv2.INTER_AREA)
_ms = nd.binary_dilation(cv2.resize(MALL_SRC.astype(np.uint8), (W_ // DS, H_ // DS), interpolation=cv2.INTER_NEAREST) > 0, iterations=2)
_fs = cv2.inpaint(_sub, _ms.astype(np.uint8) * 255, 14, cv2.INPAINT_TELEA).astype(np.float32)
_fs = np.stack([nd.gaussian_filter(_fs[..., q], 2.5) * _ms + _fs[..., q] * (1 - _ms) for q in range(3)], -1)
FILL = cv2.resize(_fs, (W_, H_), interpolation=cv2.INTER_LINEAR).astype(float)
for side, msk in MSK.items():
    ys_, xs_ = np.where(msk)
    uv = img_uv[ys_, xs_]
    ok = tri[ys_, xs_] >= 0
    tx = np.clip((uv[ok, 0] % 1) * tw, 0, tw - 1).astype(int); ty = np.clip((uv[ok, 1] % 1) * th, 0, th - 1).astype(int)
    lpaint[ty, tx] = True; lcol[ty, tx] = FILL[ys_[ok], xs_[ok]]
    LP_UV.extend(uv[ok].tolist())
# карта нормалей и шероховатость в полосе — ровный мех (рельеф лепестков Tripo давал блики-контуры ресниц)
lpm = nd.binary_closing(lpaint, iterations=2)
hl = lpm & ~lpaint
if hl.any():
    idx = nd.distance_transform_edt(~lpaint, return_distances=False, return_indices=True)
    lcol[hl] = lcol[idx[0][hl], idx[1][hl]]
# край закраски — мягко (2 текселя)
wl = nd.gaussian_filter(lpm.astype(float), 1.2) * lpm
wl = np.maximum(wl, nd.binary_erosion(lpm, iterations=2))
tex2 = (tex2 * (1 - wl[..., None]) + lcol * wl[..., None]).astype(np.uint8)
print(f'текстура тела: ресницы в полосе века закрашены мехом ({int(lpm.sum())} текселей)')
# v5h: лепестки ресниц Tripo (прижатые к коже и убранные за кожу, v5_face.py) — в UV целиком, все их тексели: снимок
# спереди видит только верхний слой, и у прижатых лепестков оставались светлые контуры, а у больших внешних ресниц —
# тёмные «ромбы», которые висели на месте при моргании (их теперь несёт веко)
Mz = np.zeros((H_, W_), bool)
for m_ in MSK.values():
    Mz |= m_
# и тёмные кончики ресниц рядом с полосой (над внешним уголком полоса ниже ресниц)
_Ed = np.zeros((H_, W_), bool)
for _sd in 'LR':
    _Ed |= nd.binary_dilation(EYES[_sd]['E'], iterations=4)
Mz = nd.binary_dilation(Mz, iterations=6) | (nd.binary_dilation(Mz, iterations=50) & nd.binary_dilation(Lum < 100, iterations=3) & ~_Ed)
cen = P[I].mean(1)
ccx = (cen[:, 0] - BOX[0]) / PX; ccy = (BOX[3] - cen[:, 1]) / PX
okc = (ccx >= 0) & (ccx < W_ - 1) & (ccy >= 0) & (ccy < H_ - 1)
cxi = np.clip(ccx.astype(int), 0, W_ - 1); cyi = np.clip(ccy.astype(int), 0, H_ - 1)
selt = np.where(okc & Mz[cyi, cxi] & (cen[:, 2] > depth[cyi, cxi] - 0.012) & (cen[:, 2] > 0.05))[0]
_ty, _tx, _uvl, _pp = [], [], [], []
for t_ in selt:
    uvt = UV[I[t_]] % 1.0
    if np.ptp(UV[I[t_]][:, 0]) > 0.5 or np.ptp(UV[I[t_]][:, 1]) > 0.5:
        continue
    pxy = uvt * np.array([tw, th])
    x0_, y0_ = np.floor(pxy.min(0) - 1).astype(int); x1_, y1_ = np.ceil(pxy.max(0) + 1).astype(int)
    gx, gy = np.meshgrid(np.arange(max(x0_, 0), min(x1_, tw - 1) + 1), np.arange(max(y0_, 0), min(y1_, th - 1) + 1))
    gx = gx.ravel(); gy = gy.ravel()
    a_, b_, c_ = pxy
    den = (b_[1] - c_[1]) * (a_[0] - c_[0]) + (c_[0] - b_[0]) * (a_[1] - c_[1])
    if abs(den) < 1e-9:
        continue
    qx, qy = gx + 0.5, gy + 0.5
    w0 = ((b_[1] - c_[1]) * (qx - c_[0]) + (c_[0] - b_[0]) * (qy - c_[1])) / den
    w1 = ((c_[1] - a_[1]) * (qx - c_[0]) + (a_[0] - c_[0]) * (qy - c_[1])) / den
    w2 = 1 - w0 - w1
    tol = -0.6 / max(np.sqrt(abs(den)), 1.0)  # и тексели у края (полтекселя)
    ins = (w0 >= tol) & (w1 >= tol) & (w2 >= tol)
    if not ins.any():
        continue
    W3 = np.stack([w0[ins], w1[ins], w2[ins]], 1).clip(0, 1)
    W3 /= W3.sum(1, keepdims=True)
    _ty.append(gy[ins]); _tx.append(gx[ins]); _pp.append(W3 @ P[I[t_]])
    _uvl.append(np.stack([(gx[ins] + 0.5) / tw, (gy[ins] + 0.5) / th], 1))
if _ty:
    _ty = np.concatenate(_ty); _tx = np.concatenate(_tx); _pp = np.concatenate(_pp)
    fx_ = (_pp[:, 0] - BOX[0]) / PX - 0.5; fy_ = (BOX[3] - _pp[:, 1]) / PX - 0.5
    fc = np.stack([nd.map_coordinates(FILL[..., q], [fy_, fx_], order=1, mode='nearest') for q in range(3)], -1)
    tex2[_ty, _tx] = fc.clip(0, 255).astype(np.uint8)
    lpm[_ty, _tx] = True
    LP_UV.extend(np.concatenate(_uvl).tolist())
    print(f'лепестки ресниц в UV целиком: {len(selt)} треуг., {len(_ty)} текселей')

# v5f: накладка шире разреза — кайма RING px (пиксели тела ПОСЛЕ закраски ресниц: обводка Tripo, мех), под ней кожа тела —
# мех (inpaint): закрытое веко — эта кожа, накладка под ним прячется целиком (шейдер, линия кромки века)
RIN, RING = 44, 54  # кайма непрозрачна до RIN px (3 мм: обводка и тень у разреза), RIN…RING — растворяется в тело
img2 = sample(tex2, img_uv).astype(float); img2[tri < 0] = 255
# ── текстура: плашки (белок) и радужки ──
AT = 512; PT = 256  # атлас; плашка глаза — квадрат PT (верхняя половина), радужка — квадрат PT (нижняя)
atlas = np.zeros((AT, AT, 4), np.uint8)
info = {}
IR = 1.10  # радужка в своём квадрате: ±IR единиц радиуса
for si, side in enumerate('LR'):
    e = EYES[side]
    E, rq, qq = e['E'], e['rq'], e['qq']
    x0, x1, y0, y1 = e['bbox']
    pad = RING + 6
    x0 -= pad; x1 += pad; y0 -= pad; y1 += pad
    side_px = max(x1 - x0, y1 - y0)
    cxp, cyp = (x0 + x1) / 2, (y0 + y1) / 2
    X0, Y0 = int(round(cxp - side_px / 2)), int(round(cyp - side_px / 2))
    S = int(side_px)
    crop = img[Y0:Y0 + S, X0:X0 + S].astype(np.uint8).copy()
    Ec = E[Y0:Y0 + S, X0:X0 + S]
    rqc = rq[Y0:Y0 + S, X0:X0 + S]
    # белок: на месте радужки (с каймой) и вне разреза — гладкое продолжение белка (нормированная свёртка по видимому
    # белку: тень под ресницами сверху и светлый низ сохраняются)
    cw = crop.astype(float)
    whit = (cw.mean(-1) > 150) & (cw.max(-1) - cw.min(-1) < 70)
    keep = Ec & (rqc >= 1.12) & nd.binary_erosion(Ec, iterations=4) & nd.binary_opening(whit, iterations=2)
    kf = keep.astype(np.float32)
    fill = crop.astype(np.float32)
    acc = np.zeros_like(fill); wsum = np.zeros(kf.shape, np.float32)
    for sg, wg in ((12, 1.0), (40, 0.35), (120, 0.12)):
        num = cv2.GaussianBlur(fill * kf[..., None], (0, 0), sg); den = cv2.GaussianBlur(kf, (0, 0), sg)
        okd = den > 1e-3
        est = np.where(okd[..., None], num / np.maximum(den, 1e-6)[..., None], 0)
        wgt = wg * np.clip(den / 0.25, 0, 1)
        acc += est * wgt[..., None]; wsum += wgt
    med = np.median(fill[keep], 0)
    acc += med * 0.02; wsum += 0.02
    smooth = acc / np.maximum(wsum, 1e-6)[..., None]
    # белок закрашивается только на месте радужки (с каймой); у края разреза — пиксели Tripo как есть (тёмный край к
    # ресницам и обводке — тот же, что на теле: без светлой каймы и «пилы» по краю)
    zone = (rqc < 1.10) & Ec
    zd = nd.distance_transform_edt(~zone)
    bl = np.clip(1 - (zd - 2) / 6.0, 0, 1)[..., None]
    fill = (fill * (1 - bl) + smooth * bl).clip(0, 255).astype(np.uint8)
    # v5f: вне разреза — тело после закраски ресниц (их несёт веко)
    fill = np.where(Ec[..., None], fill, img2[Y0:Y0 + S, X0:X0 + S].clip(0, 255).astype(np.uint8))
    # альфа: разрез, край ~1.5 px снимка (мягко)
    dist_in = nd.distance_transform_edt(Ec) - nd.distance_transform_edt(~Ec)
    # альфа в два уровня: 0…0.75 — 4 px за краем разреза (край — пиксели Tripo, накладка там уже непрозрачна),
    # 0.75…1 — внутри разреза (шейдер: радужка видна только там — её режут обводка и ресницы)
    # v5f: снаружи — кайма RING px: до RIN непрозрачна (0.75), дальше растворяется в тело
    alpha = np.where(dist_in < 0, 0.75 * np.clip((dist_in + RING) / (RING - RIN), 0, 1), 0.75 + 0.25 * np.clip(dist_in / 2.0, 0, 1))
    plate = np.dstack([fill, (alpha * 255).astype(np.uint8)])
    ps = Image.fromarray(plate[..., :3]).resize((PT, PT), Image.LANCZOS)
    pa_ = Image.fromarray(plate[..., 3]).resize((PT, PT), Image.LANCZOS)
    atlas[0:PT, si * PT:(si + 1) * PT, :3] = np.array(ps); atlas[0:PT, si * PT:(si + 1) * PT, 3] = np.array(pa_)
    # радужка: квадрат PT×PT покрывает единичные координаты ±IR; цвет — снимок через A; где радужки не видно (обводка,
    # вне разреза) — по кругу из видимого на том же радиусе
    gu = (np.arange(PT) + 0.5) / PT * 2 * IR - IR
    QX, QY = np.meshgrid(gu, gu)
    pxy = np.einsum('ij,hwj->hwi', e['A'], np.stack([QX, QY], -1)) + np.array(e['c'])
    samp = np.stack([nd.map_coordinates(img[..., q], [pxy[..., 1] - 0.5, pxy[..., 0] - 0.5], order=1, mode='nearest') for q in range(3)], -1)
    vis = nd.map_coordinates(nd.binary_erosion(E, iterations=2).astype(float), [pxy[..., 1] - 0.5, pxy[..., 0] - 0.5], order=0, mode='constant') > 0.5
    rU = np.hypot(QX, QY); aU = np.arctan2(QY, QX)
    # полярная развёртка: строки — радиус 0…IR, столбцы — угол
    NRp, NAp = 160, 512
    rr_ = (np.arange(NRp) + 0.5) / NRp * IR; aa_ = (np.arange(NAp) + 0.5) / NAp * 2 * np.pi - np.pi
    RR, AA = np.meshgrid(rr_, aa_, indexing='ij')
    pq_ = np.einsum('ij,hwj->hwi', e['A'], np.stack([RR * np.cos(AA), RR * np.sin(AA)], -1)) + np.array(e['c'])
    pol = np.stack([nd.map_coordinates(img[..., q], [pq_[..., 1] - 0.5, pq_[..., 0] - 0.5], order=1, mode='nearest') for q in range(3)], -1)
    pv = nd.map_coordinates(nd.binary_erosion(E, iterations=2).astype(float), [pq_[..., 1] - 0.5, pq_[..., 0] - 0.5], order=0) > 0.5
    pv |= RR < 0.9 * 0  # (центр всегда виден — радужка внутри разреза)
    for ri in range(NRp):
        ok = pv[ri]
        if ok.all() or not ok.any():
            if not ok.any() and ri > 0:
                pol[ri] = pol[ri - 1]
            continue
        a_ok = aa_[ok]
        for q in range(3):
            pol[ri, ~ok, q] = np.interp(aa_[~ok], a_ok, pol[ri, ok, q], period=2 * np.pi)
    # снаружи круга (кайма → белок) — белок плашки не нужен: альфа радужки к 1.0 → 0
    # обратно в квадрат
    ir = np.clip(rU / IR * NRp - 0.5, 0, NRp - 1); ia = ((aU + np.pi) / (2 * np.pi) * NAp - 0.5) % NAp
    iris = np.stack([nd.map_coordinates(np.concatenate([pol[..., q], pol[:, :1, q]], 1), [ir, ia], order=1, mode='nearest') for q in range(3)], -1)
    iris = np.where(vis[..., None], samp, iris)
    ia_ = np.clip((1.035 - rU) / 0.03, 0, 1)
    atlas[PT:AT, si * PT:(si + 1) * PT, :3] = iris.clip(0, 255).astype(np.uint8)
    atlas[PT:AT, si * PT:(si + 1) * PT, 3] = (ia_ * 255).astype(np.uint8)
    # параметры шейдера: px снимка ↔ uv атласа (плашка), круг радужки
    su = PT / S / AT
    info[side] = {
        'plate': [round((si * PT) / AT - X0 * su, 6), round(-Y0 * su, 6), round(su, 8)],  # uv = (u0 + x·s, v0 + y·s)
        'c': [round(float(e['c'][0]), 2), round(float(e['c'][1]), 2)],
        'ai': [round(float(v), 7) for v in e['Ai'].ravel()],  # px − c → единичный круг
        'iris': [round((si * PT + PT / 2) / AT, 6), round((PT + PT / 2) / AT, 6), round(PT / 2 / IR / AT, 6)],  # центр uv и uv на единицу
        'pupil': round(e['pr0'], 4), 'pq': [round(float(v), 4) for v in e['pq']],
    }

# ── сетка: поверхность тела в разрезе (+0.25 мм) ──
OFF = 0.0003
V, UVs, F, PXY = [], [], [], []
for si, side in enumerate('LR'):
    e = EYES[side]
    x0, x1, y0, y1 = e['bbox']
    GP = RING + 3
    NXg, NYg = 56, int(round(56 * (y1 - y0 + 2 * GP) / (x1 - x0 + 2 * GP)))
    gx = np.linspace(x0 - GP, x1 + GP, NXg); gy = np.linspace(y0 - GP, y1 + GP, NYg)
    GX, GY = np.meshgrid(gx, gy)
    base = len(V)

    def bil(Aa):
        return nd.map_coordinates(Aa, [GY.ravel() - 0.5, GX.ravel() - 0.5], order=1, mode='nearest')
    Pg = np.stack([bil(img_P[..., q]) for q in range(3)], -1)
    Ng = np.stack([bil(img_N[..., q]) for q in range(3)], -1); Ng /= np.linalg.norm(Ng, axis=1, keepdims=True)
    # x, y — точно по снимку (глубина — поверхность)
    Pg[:, 0] = BOX[0] + GX.ravel() * PX; Pg[:, 1] = BOX[3] - GY.ravel() * PX
    V.extend(Pg + Ng * OFF)
    pl = info[side]['plate']
    UVs.extend(np.c_[pl[0] + GX.ravel() * pl[2], pl[1] + GY.ravel() * pl[2]])
    PXY.extend(np.c_[GX.ravel(), GY.ravel()])
    Ed = nd.distance_transform_edt(~e['E']) <= RING + 1
    ins = nd.map_coordinates(Ed.astype(float), [GY.ravel() - 0.5, GX.ravel() - 0.5], order=0) > 0.5
    for r in range(NYg - 1):
        for c in range(NXg - 1):
            a = r * NXg + c; b = a + 1; d = a + NXg; f_ = d + 1
            if ins[[a, b, d, f_]].any():
                F += [(base + a, base + d, base + b), (base + b, base + d, base + f_)]
V = np.array(V); UVs = np.array(UVs); F = np.array(F, np.uint32); PXY = np.array(PXY)
used = np.unique(F)
remap = -np.ones(len(V), np.int64); remap[used] = np.arange(len(used))
F = remap[F].astype(np.uint32); V = V[used]; UVs = UVs[used]; PXY = PXY[used]
Nv = np.stack([nd.map_coordinates(img_N[..., q], [PXY[:, 1] - 0.5, PXY[:, 0] - 0.5], order=1, mode='nearest') for q in range(3)], -1)
Nv /= np.linalg.norm(Nv, axis=1, keepdims=True)

# ключи: сдвиг кожи под вершиной (mouth_* — мимо: у глаз их нет)
keys = []
for nm, D in TG.items():
    if nm.startswith('mouth_'):
        continue
    Dp = interp(D, I, tri, bary)
    Dv = np.stack([nd.map_coordinates(Dp[..., q], [PXY[:, 1] - 0.5, PXY[:, 0] - 0.5], order=1, mode='nearest') for q in range(3)], -1)
    if np.abs(Dv).max() < 4e-4:  # < 0.4 мм — без ключа (размер; брови у разреза почти не двигают кожу)
        continue
    keys.append((nm, Dv.astype(np.float32)))
    print(f'глаза: ключ {nm}, макс. {np.abs(Dv).max() * 1000:.1f} мм')

# скин — ближайшая вершина кожи
vx, vy = (P[:, 0] - BOX[0]) / PX, (BOX[3] - P[:, 1]) / PX
inb = (vx >= 0) & (vx < W_ - 1) & (vy >= 0) & (vy < H_ - 1)
front = np.zeros(len(P), bool)
front[inb] = np.abs(depth[vy[inb].astype(int), vx[inb].astype(int)] - P[inb, 2]) < 0.0025
fi = np.where(front)[0]
_, nn = cKDTree(P[fi]).query(V)
J = B['J'][fi[nn]]; Wt = B['W'][fi[nn]].astype(np.float32)
if Wt.max() > 1.5:
    Wt = Wt / 255.0


# ── v5f: кожа под накладкой (разрез + кайма RB px) — мех: inpaint снимка по меху вокруг (4× мельче) + зерно меха ──
# (раньше разрез закрашивался белком; закрытое веко — кожа тела, накладка под ним прячется — v5Face.ts)
paint = np.zeros((th, tw), bool); col = np.zeros((th, tw, 3), float)
Mfp = np.zeros((H_, W_), bool)
for side in 'LR':
    Mfp |= nd.distance_transform_edt(~EYES[side]['E']) <= RB
ffull = FILL.copy()
# зерно: шум со спектром и силой высоких частот меха вокруг (кольцо 45…90 px)
ringz = np.zeros((H_, W_), bool)
for side in 'LR':
    dd = nd.distance_transform_edt(~EYES[side]['E'])
    ringz |= (dd > 45) & (dd < 90)
hp = img2.mean(-1) - nd.gaussian_filter(img2.mean(-1), 4)
sd = float(np.std(hp[ringz & (tri >= 0)]))
rng = np.random.default_rng(5)
nz = nd.gaussian_filter(rng.standard_normal((H_, W_)), 1.2)
nz *= sd / max(float(np.std(nz)), 1e-6)
ffull = ffull + nz[..., None] * 0.3
print(f'кожа под накладкой глаз: {int(Mfp.sum())} px снимка, зерно {sd:.1f}')
ys, xs = np.where(Mfp & (tri >= 0))
uv = img_uv[ys, xs]
tx = np.clip((uv[:, 0] % 1) * tw, 0, tw - 1).astype(int); ty = np.clip((uv[:, 1] % 1) * th, 0, th - 1).astype(int)
paint[ty, tx] = True; col[ty, tx] = ffull[ys, xs]
LP_UV.extend(uv.tolist())
# швы UV и края треугольников: соседние тексели (до 4) — тоже, если там радужка Tripo или белок (обводку не трогаем)
tf = tex.astype(int)
irisish = ((tf[..., 1] > tf[..., 0] + 15) & (tf[..., 1] > tf[..., 2] - 25)) | ((tf.mean(-1) > 170) & (tf.max(-1) - tf.min(-1) < 70))
pm = nd.binary_closing(paint, iterations=2) | (nd.binary_dilation(paint, iterations=4) & irisish)
holes = pm & ~paint
if holes.any():
    idx = nd.distance_transform_edt(~paint, return_distances=False, return_indices=True)
    col[holes] = col[idx[0][holes], idx[1][holes]]
tex2[pm] = col[pm].clip(0, 255).astype(np.uint8)
# v5f: закрытое веко (ключи eyeskin): тёмное, что открывает кожа закрытого века (изнанка лепестков ресниц Tripo) — мехом
if 'eyeskin_L' in TG:
    Desk = TG['eyeskin_L'] + TG['eyeskin_R']
    tric, baryc, _ = raster_front(P + Desk, I, BOX, PX)
    uvc = interp(UV, I, tric, baryc)
    imc = sample(tex2, uvc).astype(float)
    mvd = (interp(np.linalg.norm(Desk, axis=1)[:, None], I, tric, baryc)[..., 0] > 2e-4) & (tric >= 0)
    dk = nd.binary_dilation((imc.mean(-1) < 125) & mvd, iterations=3) & mvd
    ys, xs = np.where(dk)
    uv = uvc[ys, xs]
    tx = np.clip((uv[:, 0] % 1) * tw, 0, tw - 1).astype(int); ty = np.clip((uv[:, 1] % 1) * th, 0, th - 1).astype(int)
    tex2[ty, tx] = ffull[ys, xs].clip(0, 255).astype(np.uint8)
    pm[ty, tx] = True
    LP_UV.extend(uv.tolist())
    print(f'закрытое веко: тёмное под кожей века — мехом ({len(ys)} px снимка)')
# v5f: поля островов у швов — тем же цветом (у внутреннего уголка глаза оставалась вертикальная тёмная черта)
_cov = uv_cover(UV, I, th, tw)
print(f'швы UV: поля острова закрашены ({bleed(tex2, pm | lpm, _cov)} текселей)')
g.set_image(tex_i, Image.fromarray(tex2))
if LP_UV:
    uvs_ = np.array(LP_UV)
    for key_, flat in (('normalTexture', None), ('metallicRoughnessTexture', 'mr')):
        tinfo = mat0.get(key_) or mat0['pbrMetallicRoughness'].get(key_)
        if not tinfo:
            continue
        si_ = j['textures'][tinfo['index']]['source']
        arr = np.array(g.image(si_).convert('RGB'))
        hh, ww = arr.shape[:2]
        m_ = np.zeros((hh, ww), bool)
        m_[np.clip((uvs_[:, 1] % 1) * hh, 0, hh - 1).astype(int), np.clip((uvs_[:, 0] % 1) * ww, 0, ww - 1).astype(int)] = True
        m_ = nd.binary_dilation(nd.binary_closing(m_, iterations=2), iterations=1)
        if flat is None:
            val = np.array([128, 128, 255], np.uint8)
        else:
            ring = nd.binary_dilation(m_, iterations=12) & ~nd.binary_dilation(m_, iterations=4)
            val = np.median(arr[ring], 0).astype(np.uint8)
        arr[m_] = val
        g.set_image(si_, Image.fromarray(arr))
        print(f'{key_}: полоса ресниц — ровный мех ({int(m_.sum())} текселей)')
print(f'текстура тела: под накладкой глаз — мех ({int(pm.sum())} текселей)')

def add_sparse(arr):
    """ключ разреженным accessor (как v5_face.py): только вершины со сдвигом > 0.02 мм"""
    arr = np.asarray(arr, np.float32).copy()
    arr[np.abs(arr).max(1) < 2e-5] = 0
    idx = np.where(np.abs(arr).max(1) > 0)[0].astype(np.uint32)
    acc = {'componentType': 5126, 'count': len(arr), 'type': 'VEC3', 'min': arr.min(0).tolist(), 'max': arr.max(0).tolist()}
    if len(idx):
        def bv(data):
            j['bufferViews'].append({'buffer': 0, 'byteLength': len(data)})
            vi = len(j['bufferViews']) - 1; g.extra[vi] = data
            return vi
        acc['sparse'] = {'count': int(len(idx)), 'indices': {'bufferView': bv(idx.tobytes()), 'componentType': 5125},
                         'values': {'bufferView': bv(np.ascontiguousarray(arr[idx]).tobytes())}}
    j['accessors'].append(acc)
    return len(j['accessors']) - 1


rough = float(np.median(sample(mrtex, img_uv[EYES['L']['E']][::40])[:, 1]) / 255)
# размер (бюджет ≲ 2.5 МБ после model-opt): прозрачное — без цвета, цвет — 6 бит на канал (белок и радужка гладкие)
atlas_s = atlas.copy()
atlas_s[atlas_s[..., 3] == 0, :3] = 0
atlas_s[..., :3] = (atlas_s[..., :3] // 4) * 4 + 2
ti = g.add_texture(g.add_image(Image.fromarray(atlas_s, 'RGBA'), 'glitter_v5_eyes'), 0)
j['materials'].append({'name': 'Eyes_V5', 'alphaMode': 'BLEND', 'doubleSided': False,
                       'pbrMetallicRoughness': {'baseColorTexture': {'index': ti}, 'metallicFactor': 0.0, 'roughnessFactor': round(rough, 3)}})
mi_ = len(j['materials']) - 1
prim = {'attributes': {'POSITION': g.add_acc(V.astype(np.float32), 5126, 'VEC3', 34962),
                       'NORMAL': g.add_acc(Nv.astype(np.float32), 5126, 'VEC3', 34962),
                       'TEXCOORD_0': g.add_acc(UVs.astype(np.float32), 5126, 'VEC2', 34962),
                       'JOINTS_0': g.add_acc(J.astype(np.uint16), 5123, 'VEC4', 34962),
                       'WEIGHTS_0': g.add_acc(Wt.astype(np.float32), 5126, 'VEC4', 34962)},
        'indices': g.add_acc(F.ravel(), 5125, 'SCALAR', 34963), 'material': mi_,
        'targets': [{'POSITION': add_sparse(D)} for _, D in keys]}
j['meshes'].append({'name': 'Eyes_V5', 'primitives': [prim], 'extras': {'targetNames': [k_ for k_, _ in keys]},
                    'weights': [0.0] * len(keys)})
j['nodes'].append({'name': 'Eyes_V5', 'mesh': len(j['meshes']) - 1, 'skin': 0})
arm = next(i for i, n_ in enumerate(j['nodes']) if n_.get('name') == 'Armature')
j['nodes'][arm].setdefault('children', []).append(len(j['nodes']) - 1)
ex5['eyes'] = {'mmPerPx': PX * 1000, **info}
size = g.save(dst)
print(f'→ {dst} ({size / 1e6:.2f} МБ): глаза {len(V)} вершин, {len(F)} треуг., ключей {len(keys)}, шероховатость {rough:.2f}')
if VIZ:
    os.makedirs(VIZ, exist_ok=True)
    Image.fromarray(atlas, 'RGBA').save(f'{VIZ}/eyes_atlas.png')
    bg = Image.new('RGBA', (AT, AT), (255, 0, 255, 255)); bg.alpha_composite(Image.fromarray(atlas, 'RGBA'))
    bg.convert('RGB').save(f'{VIZ}/eyes_atlas_bg.png')
    v = Image.fromarray(img.astype(np.uint8)).convert('RGB')
    ov = np.array(v)
    for sd in 'LR':
        Ee = EYES[sd]['E']
        ed = Ee & ~nd.binary_erosion(Ee)
        ov[ed] = (255, 0, 0)
    Image.fromarray(ov).resize((W_ // 2, H_ // 2)).save(f'{VIZ}/eyes_mask.png')

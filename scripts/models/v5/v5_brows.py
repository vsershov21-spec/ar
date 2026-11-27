"""Блёстка v5e: брови Tripo (мягкие тёмные мазки над глазами в текстуре тела) закрашены мехом — их рисует шейдер лица
(src/character/v5Face.ts, attachV5Paint) с позой по эмоции: сдвиг 10–25 мм, наклон «домиком» / к переносице, дуга.
В покое шейдер рисует бровь на месте и в форме Tripo (центр, полуширина, толщина, наклон, цвет — из снимка), вид Tripo
не меняется.

    python3 v5/v5_brows.py in.glb out.glb [--viz dir]

Снимок спереди 0.25 мм/px над глазами; фон меха — серое закрытие (closing) крупным окном (тёмный мазок брови уходит),
бровь — где снимок заметно темнее фона; по маске — средняя линия (столбцы: центр тяжести темноты), толщина, цвет.
Текстура тела в маске (с каймой) — цвет фона (как закраска ресниц в v5_eyes.py). → asset.extras.glitterV5.brows:
{L|R: {x, y, z, hw, th, slope, bend, col, dk}} — метры (координаты покоя), slope — dy/dx к внешнему краю, bend — подъём
середины над хордой, col — цвет sRGB 0..1, dk — средняя глубина затемнения 0..1.
"""
import sys, os
import numpy as np
from scipy import ndimage as nd
import cv2
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from v5_common import Glb, body, raster_front, interp, sample  # noqa: E402

src, dst = sys.argv[1:3]
VIZ = sys.argv[sys.argv.index('--viz') + 1] if '--viz' in sys.argv else None
g = Glb(src); j = g.j
B = body(g)
P, UV, I = B['P'], B['UV'], B['I']
mat0 = j['materials'][B['pr']['material']]
tex_i = j['textures'][mat0['pbrMetallicRoughness']['baseColorTexture']['index']]['source']
tex = np.array(g.image(tex_i).convert('RGB'))
ex5 = j['asset']['extras']['glitterV5']
mk = ex5['marks']

PX = 0.00025
top = max(mk['eyeTopL'], mk['eyeTopR'])
BOX = (min(mk['eyeOuterR'][0], mk['eyeInnerR'][0]) - 0.03, max(mk['eyeOuterL'][0], mk['eyeInnerL'][0]) + 0.03, top + 0.004, top + 0.075)
tri, bary, _ = raster_front(P, I, BOX, PX)
H_, W_ = tri.shape
img_uv = interp(UV, I, tri, bary)
img_P = interp(P, I, tri, bary)
img = sample(tex, img_uv).astype(float)
valid = tri >= 0
Lum = img.mean(-1)
Lf = np.where(valid, Lum, np.nan)
# фон меха: серое закрытие (тёмные детали < окна уходят), затем сглаживание
Lfill = np.where(valid, Lum, np.nanmedian(Lf))
bgL = nd.uniform_filter(nd.grey_closing(Lfill, size=(161, 161)), 41)
dark = np.clip((bgL - Lum) / 40.0, 0, 1) * valid
print('темнота перцентили', np.percentile(dark[valid], [50, 90, 99]).round(2))
print(f'снимок бровей {W_}×{H_} px ({PX * 1000:.2f} мм/px), темнее фона макс. {dark.max():.2f}')
out = {}
masks = []
paint = np.zeros(tex.shape[:2], bool); pcol = np.zeros(tex.shape, float)
mid = W_ // 2
for side, sl in (('R', slice(0, mid)), ('L', slice(mid, W_))):
    blue = img[..., 2] > img[..., 0] + 20
    dmax = dark[:, sl][blue[:, sl]].max()
    m = np.zeros_like(dark, bool); m[:, sl] = (dark[:, sl] > 0.55 * dmax) & blue[:, sl]
    m = nd.binary_opening(m, iterations=2)
    lab, n = nd.label(m)
    if n == 0:
        print(f'бровь {side}: не найдена'); continue
    k = np.argmax(nd.sum(m, lab, range(1, n + 1))) + 1
    bm = lab == k
    ys, xs = np.where(bm)
    cols = np.arange(xs.min(), xs.max() + 1)
    wsum = np.array([dark[:, x][bm[:, x]].sum() for x in cols])
    cy = np.array([(np.arange(H_)[bm[:, x]] * dark[:, x][bm[:, x]]).sum() / max(dark[:, x][bm[:, x]].sum(), 1e-6) for x in cols])
    thk = np.array([bm[:, x].sum() for x in cols], float)
    ok = wsum > 0.25 * wsum.max()
    cols, cy, thk = cols[ok], cy[ok], thk[ok]
    # координаты модели: x, y покоя (снимок орто), z — по поверхности
    xm = BOX[0] + (cols + 0.5) * PX
    ym = BOX[3] - (cy + 0.5) * PX
    x0, x1 = xm.min(), xm.max()
    cx = (x0 + x1) / 2; hw = (x1 - x0) / 2
    # к внешнему краю: u = (x − cx)·sign(cx)/hw ∈ −1…1 → y = c + slope·u·hw + bend·(1 − u²)
    u = (xm - cx) * np.sign(cx) / hw
    A = np.stack([np.ones_like(u), u * hw, 1 - u * u], 1)
    c0, slope, bend = np.linalg.lstsq(A, ym, rcond=None)[0]
    zi = img_P[int(np.median(cy)), int(np.median(cols))][2]
    col = np.median(img[bm & (dark > 0.5 * dark[bm].max())], 0) / 255.0
    out[side] = {'x': round(float(cx), 5), 'y': round(float(c0), 5), 'z': round(float(zi), 5), 'hw': round(float(hw), 5),
                 'th': round(float(np.median(thk) * PX), 5), 'slope': round(float(slope), 4), 'bend': round(float(bend), 5),
                 'col': [round(float(v), 3) for v in col], 'dk': round(float(dark[bm].mean()), 3)}
    print(f'бровь {side}: центр x {cx * 1000:.1f} y {c0 * 1000:.1f} мм, полуширина {hw * 1000:.1f}, толщина '
          f'{np.median(thk) * PX * 1000:.1f} мм, наклон {slope:.2f}, дуга {bend * 1000:.1f} мм, цвет {np.round(col * 255)}')
    # закраска: маска с каймой (мягкая тень брови — тоже), цвет — фон меха (закрытие по каналам)
    msk = nd.binary_dilation(bm, iterations=24) & valid & (dark > 0.06) & blue
    msk = nd.binary_closing(msk, iterations=3) & valid
    masks.append(msk)
    yy, xx = np.where(msk)
    uv = img_uv[yy, xx]
    th_, tw_ = tex.shape[:2]
    tx = np.clip((uv[:, 0] % 1) * tw_, 0, tw_ - 1).astype(int); ty = np.clip((uv[:, 1] % 1) * th_, 0, th_ - 1).astype(int)
    paint[ty, tx] = True; pcol[ty, tx] = 0  # цвет — после inpaint обеих бровей
# закраска: гармоническое продолжение меха вокруг (cv2 inpaint по снимку) — без светлой «заплатки» и контура
Mall = np.zeros((H_, W_), np.uint8)
for m_ in masks:
    Mall |= m_.astype(np.uint8)
fill = cv2.inpaint(np.clip(img, 0, 255).astype(np.uint8), Mall * 255, 25, cv2.INPAINT_TELEA).astype(float)
fill = np.stack([nd.gaussian_filter(fill[..., q], 6) * Mall + fill[..., q] * (1 - Mall) for q in range(3)], -1)
yy, xx = np.where(Mall > 0)
uv = img_uv[yy, xx]
th_, tw_ = tex.shape[:2]
tx = np.clip((uv[:, 0] % 1) * tw_, 0, tw_ - 1).astype(int); ty = np.clip((uv[:, 1] % 1) * th_, 0, th_ - 1).astype(int)
pcol[ty, tx] = fill[yy, xx]
# дыры между текселями — ближайшим
pm = nd.binary_closing(paint, iterations=2)
holes = pm & ~paint
if holes.any():
    idx = nd.distance_transform_edt(~paint, return_distances=False, return_indices=True)
    pcol[holes] = pcol[idx[0][holes], idx[1][holes]]
# мягкий край (3 текселя) и зерно меха исходника (высокие частоты) сохраняются
w = nd.gaussian_filter(pm.astype(float), 2.0) * pm
w = np.maximum(w, nd.binary_erosion(pm, iterations=3))
hi = tex.astype(float) - np.stack([nd.gaussian_filter(tex[..., q].astype(float), 3) for q in range(3)], -1)
new = np.clip(pcol + 0.6 * hi, 0, 255)
tex2 = (tex * (1 - w[..., None]) + new * w[..., None]).astype(np.uint8)
g.set_image(tex_i, Image.fromarray(tex2))
ex5['brows'] = out
print(f'текстура тела: брови закрашены мехом ({int(pm.sum())} текселей)')
size = g.save(dst)
print(f'→ {dst} ({size / 1e6:.2f} МБ)')
if VIZ:
    os.makedirs(VIZ, exist_ok=True)
    v = img.copy()
    v[dark > 0.18] = v[dark > 0.18] * 0.5 + np.array([255, 0, 0]) * 0.5
    after = sample(tex2, img_uv).astype(float)
    Image.fromarray(np.concatenate([v, after], 0).astype(np.uint8)).save(f'{VIZ}/brows.png')

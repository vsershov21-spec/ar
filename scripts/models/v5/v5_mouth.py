"""Блёстка v5c, стадия «рот-накладка»: лицо Tripo в покое — как есть (открытая улыбка), а для закрытых и своих форм рта
(надутый «ω» грусти/обиды, кривая ухмылка, круглое «о» удивления, смех с клычками и язычком) — накладка Mouth_V5 поверх
морды. Накладка — гладкая поверхность кожи морды над ртом (вне рта — сама кожа Tripo, в проёме рта — сплайн по коже
вокруг, +0.8 мм), текстура — цвет морды Tripo с закрашенным ртом (inpaint), в альфе — маска (1 над ртом и губами,
к краю — плавно в 0). Форму рта рисует шейдер (src/character/v5Face.ts, attachV5Mouth) в мм плоскости рта — линия
губ следует за деформацией накладки. Ключи накладки — те же, что у тела (кроме mouth_*: под накладкой рот Tripo
закрыт драйвером), сдвиги — по коже под вершиной; скин — от ближайшей вершины кожи.

    python3 scripts/models/v5/v5_mouth.py face.glb out.glb [--viz dir]
"""
import sys, os
import numpy as np
from scipy import ndimage as nd
from scipy.interpolate import RBFInterpolator
from scipy.spatial import cKDTree
from PIL import Image
import cv2

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from v5_common import Glb, body, raster_front, interp, sample  # noqa: E402

src, dst = sys.argv[1:3]
VIZ = sys.argv[sys.argv.index('--viz') + 1] if '--viz' in sys.argv else None
g = Glb(src); j = g.j
B = body(g)
P, UV, I = B['P'], B['UV'], B['I']
pr = B['pr']
mat0 = j['materials'][pr['material']]
tex = np.array(g.image(j['textures'][mat0['pbrMetallicRoughness']['baseColorTexture']['index']]['source']).convert('RGB'))
mrtex = np.array(g.image(j['textures'][mat0['pbrMetallicRoughness']['metallicRoughnessTexture']['index']]['source']).convert('RGB'))
names = j['meshes'][B['mi']]['extras']['targetNames']
TG = {nm: g.acc(t['POSITION']).astype(np.float64) for nm, t in zip(names, pr['targets'])}
marks = j['asset']['extras']['glitterV5']['marks']

BOX = (-0.22, 0.22, 0.58, 0.92); PX = 0.0004  # как v5_face.py
tri, bary, depth = raster_front(P, I, BOX, PX)
H_, W_ = tri.shape
img = sample(tex, interp(UV, I, tri, bary)).astype(np.uint8)
r_, g_, b_ = (img[..., k].astype(int) for k in range(3))
Lum = img.mean(-1)

# рот Tripo (тёмно-красное под носом) и нос (розовое)
red = (r_ > g_ + 35) & (Lum < 175) & (tri >= 0)
m = np.zeros_like(red); m[640:790, 380:720] = red[640:790, 380:720]
lab, n = nd.label(m); k = np.argmax(nd.sum(m, lab, range(1, n + 1))) + 1
hole = nd.binary_fill_holes(nd.binary_closing(lab == k, iterations=4))
hole |= nd.binary_dilation(hole, iterations=2) & (Lum < 120)
ys, xs = np.where(hole)
pink = (r_ > b_ + 10) & (r_ > g_ + 25) & (Lum > 120) & (tri >= 0)
pm = np.zeros_like(pink); pm[520:660, 450:650] = pink[520:660, 450:650]
yn, xn = np.where(pm)
nose_bot = int(np.percentile(yn, 99)); nose_x = float(xn.mean())
print(f'рот Tripo: x {xs.min()}…{xs.max()}, y {ys.min()}…{ys.max()} px; низ носа {nose_bot} px')

x0, x1 = xs.min() - 48, xs.max() + 48
y0, y1 = nose_bot + 2, ys.max() + 56
sl = (slice(y0, y1), slice(x0, x1))
hb = hole[sl]
dist = nd.distance_transform_edt(~hb)
# альфа: над ртом и губами — 1, дальше по коже — плавно в 0; у носа — 0
ny_ = np.arange(y0, y1)[:, None] - nose_bot
alpha = np.clip(1 - (dist - 13) / 22, 0, 1) * np.clip((ny_ - 3) / 10, 0, 1)
alpha = alpha * alpha * (3 - 2 * alpha)

# поверхность: кожа вне рта — глубина растра, в проёме — сплайн по кольцу кожи вокруг
dep = depth[sl].copy()
skin = (dist > 3) & (tri[sl] >= 0)
ring = skin & (dist < 40)
yy, xx = np.mgrid[y0:y1, x0:x1]
pts = np.c_[xx[ring], yy[ring]][::7].astype(float)
rbf = RBFInterpolator(pts, dep[ring][::7], kernel='thin_plate_spline', smoothing=2e-3)
inner = ~skin
z = dep.copy()
z[inner] = rbf(np.c_[xx[inner], yy[inner]].astype(float))
z = np.where(inner, np.maximum(z, dep - 1.0), z)
z = nd.gaussian_filter(z, 2.0)
z[skin] = np.maximum(z[skin], dep[skin])
OFF = 0.0008

# текстура: цвет морды, рот закрашен
crop = img[sl].copy()
cr = crop.astype(int)
odd = ((cr[..., 0] > cr[..., 2] + 2) | (cr.mean(-1) < 175)) & (dist < 30)  # розовое/тёмное у губ и уголков
paint = nd.binary_dilation(hb | odd, iterations=10).astype(np.uint8) * 255
fill = cv2.inpaint(np.ascontiguousarray(crop[..., ::-1]), paint, 18, cv2.INPAINT_TELEA)[..., ::-1]
blur = cv2.GaussianBlur(fill, (0, 0), 3.0)
pm_ = nd.gaussian_filter((paint > 0).astype(float), 3)[..., None]
fill = (fill * (1 - pm_) + blur * pm_).astype(np.uint8)
TWm, THm = 256, int(round(256 * (y1 - y0) / (x1 - x0)))
# цвет и альфа — по отдельности (resize RGBA умножает цвет на альфу: по краю накладки — чёрная кайма)
rgb_s = Image.fromarray(fill).resize((TWm, THm), Image.LANCZOS)
a_s = Image.fromarray((alpha * 255).astype(np.uint8)).resize((TWm, THm), Image.LANCZOS)
timg = Image.merge('RGBA', (*rgb_s.split(), a_s))

# сетка накладки
NX, NY = 56, int(round(56 * (y1 - y0) / (x1 - x0)))
gx = np.linspace(0, x1 - x0 - 1, NX); gy = np.linspace(0, y1 - y0 - 1, NY)
GX, GY = np.meshgrid(gx, gy)


def bil(A, X, Y):
    return nd.map_coordinates(A, [Y.ravel(), X.ravel()], order=1, mode='nearest').reshape(X.shape)


Z = bil(z, GX, GY)
Xw = (GX + x0 + 0.5) * PX + BOX[0]; Yw = BOX[3] - (GY + y0 + 0.5) * PX
V = np.stack([Xw, Yw, Z], -1)
# нормали по сетке
dx_ = np.gradient(V, axis=1); dy_ = np.gradient(V, axis=0)
Nm = np.cross(dx_, -dy_); Nm /= np.linalg.norm(Nm, axis=-1, keepdims=True)
Nm[Nm[..., 2] < 0] *= -1
# вне проёма рта — нормали кожи Tripo (освещение накладки как у тела), в проёме — по сплайну, к краю проёма — плавно
NB = interp(B['N'] / np.maximum(np.linalg.norm(B['N'], axis=1, keepdims=True), 1e-9), I, tri, bary)[sl]
NB = np.stack([nd.gaussian_filter(NB[..., q], 1.5) for q in range(3)], -1)
wsk = np.clip((dist - 3) / 8, 0, 1)
NBg = np.stack([bil(NB[..., q], GX, GY) for q in range(3)], -1); wg = bil(wsk, GX, GY)[..., None]
V = V + Nm * OFF
Nm = Nm * (1 - wg) + NBg * wg
Nm /= np.linalg.norm(Nm, axis=-1, keepdims=True)
UVm = np.stack([GX / (x1 - x0 - 1), GY / (y1 - y0 - 1)], -1)
F = []
for r in range(NY - 1):
    for c in range(NX - 1):
        a = r * NX + c; b = a + 1; d = a + NX; e = d + 1
        F += [(a, d, b), (b, d, e)]  # к камере (+Z)
F = np.array(F, np.uint32)
# грани с полностью прозрачными вершинами — не нужны
A_v = bil(alpha, GX, GY).ravel()
F = F[A_v[F].max(1) > 0.002]
used = np.unique(F)
remap = -np.ones(NX * NY, np.int64); remap[used] = np.arange(len(used))
F = remap[F].astype(np.uint32)
V = V.reshape(-1, 3)[used]; Nm = Nm.reshape(-1, 3)[used]; UVm = UVm.reshape(-1, 2)[used]
GXu, GYu = GX.ravel()[used], GY.ravel()[used]

# ключи: сдвиги кожи под вершиной (в проёме — от ближайшей кожи), mouth_* — нет
tri_c, bary_c = tri[sl], bary[sl]
keys = []
near = nd.distance_transform_edt(~skin, return_distances=False, return_indices=True)
for nm, D in TG.items():
    if nm.startswith('mouth_'):
        continue
    Dp = interp(D, I, tri_c, bary_c)
    Dp = Dp[near[0], near[1]]
    Dp = np.stack([nd.gaussian_filter(Dp[..., q], 3) for q in range(3)], -1)
    Dv = np.stack([nd.map_coordinates(Dp[..., q], [GYu, GXu], order=1, mode='nearest') for q in range(3)], -1)
    if np.abs(Dv).max() < 5e-5:
        continue
    keys.append((nm, Dv.astype(np.float32)))
    print(f'накладка: ключ {nm}, макс. {np.abs(Dv).max() * 1000:.1f} мм')

# скин — от ближайшей вершины кожи спереди
vx, vy = (P[:, 0] - BOX[0]) / PX, (BOX[3] - P[:, 1]) / PX
inb = (vx >= 0) & (vx < W_ - 1) & (vy >= 0) & (vy < H_ - 1)
front = np.zeros(len(P), bool)
front[inb] = np.abs(depth[vy[inb].astype(int), vx[inb].astype(int)] - P[inb, 2]) < 0.0025
fi = np.where(front)[0]
_, nn = cKDTree(P[fi]).query(V)
J = B['J'][fi[nn]]; Wt = B['W'][fi[nn]].astype(np.float32)
if Wt.max() > 1.5:
    Wt = Wt / 255.0

# плоскость рта: мм от середины рта Tripo (x вправо = +X модели, y вверх) ↔ UV накладки
mxp = (marks['mouth'][0] - BOX[0]) / PX - x0; myp = (BOX[3] - marks['mouth'][1]) / PX - y0
info = {
    'uv0': [round(float(mxp / (x1 - x0 - 1)), 5), round(float(myp / (y1 - y0 - 1)), 5)],
    'mm': [round(float((x1 - x0 - 1) * PX * 1000), 3), round(float((y1 - y0 - 1) * PX * 1000), 3)],
    'noseY': round(float((myp - (nose_bot - y0)) * PX * 1000), 2),  # низ носа над серединой рта, мм
    'halfW': round(float((xs.max() - xs.min()) / 2 * PX * 1000), 2),
}
print('плоскость рта:', info)

rough = float(np.median(sample(mrtex, UV[front][::5])[:, 1]) / 255)
ti = g.add_texture(g.add_image(timg, 'glitter_v5_mouth'), 0)
j['materials'].append({'name': 'Mouth_V5', 'alphaMode': 'BLEND', 'doubleSided': False,
                       'pbrMetallicRoughness': {'baseColorTexture': {'index': ti}, 'metallicFactor': 0.0, 'roughnessFactor': round(rough, 3)}})
mm_ = len(j['materials']) - 1
prim = {'attributes': {'POSITION': g.add_acc(V.astype(np.float32), 5126, 'VEC3', 34962),
                       'NORMAL': g.add_acc(Nm.astype(np.float32), 5126, 'VEC3', 34962),
                       'TEXCOORD_0': g.add_acc(UVm.astype(np.float32), 5126, 'VEC2', 34962),
                       'JOINTS_0': g.add_acc(J.astype(np.uint16), 5123, 'VEC4', 34962),
                       'WEIGHTS_0': g.add_acc(Wt.astype(np.float32), 5126, 'VEC4', 34962)},
        'indices': g.add_acc(F.ravel(), 5125, 'SCALAR', 34963), 'material': mm_,
        'targets': [{'POSITION': g.add_acc(D, 5126, 'VEC3', 34962)} for _, D in keys]}
j['meshes'].append({'name': 'Mouth_V5', 'primitives': [prim], 'extras': {'targetNames': [k_ for k_, _ in keys]},
                    'weights': [0.0] * len(keys)})
j['nodes'].append({'name': 'Mouth_V5', 'mesh': len(j['meshes']) - 1, 'skin': 0})
arm = next(i for i, n_ in enumerate(j['nodes']) if n_.get('name') == 'Armature')
j['nodes'][arm].setdefault('children', []).append(len(j['nodes']) - 1)
j['asset']['extras']['glitterV5']['mouth'] = info
size = g.save(dst)
print(f'→ {dst} ({size / 1e6:.2f} МБ): накладка рта {len(V)} вершин, {len(F)} треуг., ключей {len(keys)}, текстура {TWm}×{THm}')
if VIZ:
    os.makedirs(VIZ, exist_ok=True)
    timg.save(f'{VIZ}/mouth_tex.png')
    Image.fromarray(crop).save(f'{VIZ}/mouth_crop.png')

"""Лицевой риг кота Tripo: настоящий рот, веки, румянец и мимика лица — шейп-ки (морфы) для three.js.

Черты лица находит face_photo.py + face_detect.py (фронтальный «снимок» → нос, глаза, линия рта).
Дальше — накладки, повторяющие поверхность головы (проекция лучом спереди + сдвиг по нормали), на кости Head:
  • Mouth — полость рта (тёмная, язык снизу, полоска зубов сверху). В покое сжата в нарисованную линию рта —
    не видна; ключи mouth_A/E/O/U/M, tongue_out раскрывают её по-разному.
  • EyeLids — веки цвета меха над нарисованными глазами: blink_L/R, wink_L/R, eyes_squint.
  • Blush — румянец на щеках (ключ blush).
  • Основной меш: челюсть опускается вместе со ртом (mouth_*), уголки вверх — smile/smirk, щёки — cheeks_gum.
Имена ключей — content/face.json morphTargets (runtime: src/character/glbCharacter.ts).

Usage: python face_rig.py -- in.glb face.json out.glb [preview_prefix]"""
import sys, os, json, math
import numpy as np
sys.path.insert(0, os.path.dirname(__file__))
import bpy, mathutils
from face_common import load_glb, base_image, image_array, Surface

args = sys.argv[sys.argv.index('--') + 1:]
src, fjson, out = args[:3]
preview = args[3] if len(args) > 3 else None
F = json.load(open(fjson))
arm, mesh = load_glb(src)
tex = image_array(base_image(mesh))
S = Surface(mesh, tex)
head_bone = 'mixamorig:Head'

mouth = F['mouth']
ML = np.array(mouth['line'])  # точки линии рта (x, z)
ML = ML[np.argsort(ML[:, 0])]
W = abs(mouth['left'][0] - mouth['right'][0])  # ширина рта
SC = W / 0.13  # масштаб относительно Хулигана


# ───────────── основной меш: челюсть, уголки рта, щёки ─────────────
me = mesh.data
M = mesh.matrix_world
Minv = M.inverted()
gi = mesh.vertex_groups[head_bone].index if head_bone in mesh.vertex_groups else None
hy = F['head'][1]
P = np.array([tuple(M @ v.co) for v in me.vertices])
hw = np.zeros(len(P))
for v in me.vertices:
    for g in v.groups:
        if g.group == gi:
            hw[v.index] = g.weight
mz = mouth['center'][1]
cx = (ML[0, 0] + ML[-1, 0]) / 2
front = (P[:, 1] < hy) & (hw > 0.3)
if not me.shape_keys:
    mesh.shape_key_add(name='Basis')


def add_key(name, disp):
    sk = mesh.shape_key_add(name=name)
    for i in np.where(np.linalg.norm(disp, axis=1) > 1e-7)[0]:
        sk.data[int(i)].co = Minv @ mathutils.Vector(tuple(P[i] + disp[i]))


def jaw(amount):
    """нижняя часть морды под линией рта опускается (затухание к щекам и к шее)"""
    d = np.zeros_like(P)
    lz = np.interp(P[:, 0], ML[:, 0], ML[:, 1])
    below = front & (P[:, 2] < lz)
    dx = (P[:, 0] - cx) / (W * 0.85)
    dz = (lz - P[:, 2]) / (W * 0.9)
    w = np.exp(-dx ** 2 * 1.6) * np.clip(1 - np.maximum(0, dz - 0.6) / 0.9, 0, 1)
    d[below, 2] = -amount * w[below]
    return d


def corners(up, out_amt, right_only=False):
    d = np.zeros_like(P)
    for sx, corner in [(1, mouth['left']), (-1, mouth['right'])]:
        if right_only and sx > 0:
            continue
        r2 = ((P[:, 0] - corner[0]) / (0.32 * W)) ** 2 + ((P[:, 2] - corner[1]) / (0.28 * W)) ** 2
        w = np.exp(-r2) * front
        d[:, 2] += up * w
        d[:, 0] += sx * out_amt * w
    return d


def cheeks(amount):
    d = np.zeros_like(P)
    for side in ['L', 'R']:
        e = F['eyes'][side]
        c = np.array([e['c'][0] * 1.05, mz + 0.4 * (e['c'][1] - mz)])
        r2 = ((P[:, 0] - c[0]) / (0.42 * W)) ** 2 + ((P[:, 2] - c[1]) / (0.38 * W)) ** 2
        w = np.exp(-r2) * front
        n = np.array([np.sign(c[0]) * 0.6, -1.0, 0.0]); n /= np.linalg.norm(n)
        d += np.outer(w, n) * amount
    return d



def line_at(u):
    """точка линии рта по параметру u 0..1 (слева направо по x)"""
    x = ML[0, 0] + (ML[-1, 0] - ML[0, 0]) * u
    return np.array([x, np.interp(x, ML[:, 0], ML[:, 1])])


from mathutils.bvhtree import BVHTree
_BVH = {}


def surf(x, z, off, key=None):
    """точка поверхности спереди + сдвиг по нормали; key — поверхность с применённым ключом основного меша"""
    d = DISP.get(key) if key else None
    if d is not None:
        if key not in _BVH:
            _BVH[key] = BVHTree.FromPolygons([tuple(p) for p in S.P + d], [tuple(t) for t in S.tris])
        loc, nrm, ti, dist = _BVH[key].ray_cast(mathutils.Vector((x, -1.0, z)), mathutils.Vector((0, 1, 0)))
        if loc is not None:
            n = np.array(nrm)
            if n[1] > 0:
                n = -n
            return np.array(loc) + n * off, ti, np.array(loc)
    p, ti = S.ray_front(x, z)
    if p is None:
        p, ti = S.nearest((x, -0.3, z))
    n = S.normal_at(ti, p)
    return p + n * off, ti, p


def color_at(x, z):
    p, ti = S.ray_front(x, z)
    if p is None:
        return np.array([0.5, 0.5, 0.6])
    c = np.clip(S.color_uv(S.uv_at(ti, p)), 0, 1)
    # текстура в sRGB, цвет вершин — линейный
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def make_obj(name, verts2d_keys, faces, colors, off):
    """verts2d_keys: dict key -> list of (x, z); первый ключ — Basis"""
    keys = list(verts2d_keys.keys())
    base = [surf(x, z, off)[0] for x, z in verts2d_keys[keys[0]]]
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in base], [], faces)
    me.update()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    # цвет вершин
    ca = me.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
    for i, c in enumerate(colors):
        ca.data[i].color = (c[0], c[1], c[2], 1.0)
    mat = bpy.data.materials.new(name + '_mat')
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes['Principled BSDF']
    cn = nt.nodes.new('ShaderNodeVertexColor')
    cn.layer_name = 'Col'
    nt.links.new(cn.outputs['Color'], bsdf.inputs['Base Color'])
    bsdf.inputs['Roughness'].default_value = 0.55
    me.materials.append(mat)
    for poly in me.polygons:
        poly.use_smooth = True
    # шейп-ки
    ob.shape_key_add(name='Basis')
    for k in keys[1:]:
        sk = ob.shape_key_add(name=k)
        for i, (x, z) in enumerate(verts2d_keys[k]):
            sk.data[i].co = mathutils.Vector(tuple(surf(x, z, off, k)[0]))
    # кожа: всё на голову
    vg = ob.vertex_groups.new(name=head_bone)
    vg.add(list(range(len(base))), 1.0, 'REPLACE')
    ob.parent = arm
    mod = ob.modifiers.new('Armature', 'ARMATURE')
    mod.object = arm
    return ob


DISP = {
    'mouth_A': jaw(0.42 * W), 'mouth_E': jaw(0.2 * W), 'mouth_O': jaw(0.34 * W), 'mouth_U': jaw(0.16 * W),
    'tongue_out': jaw(0.12 * W), 'smile': corners(0.14 * W, 0.04 * W),
    'cheeks_gum': cheeks(0.09 * W),
}

# ───────────── рот ─────────────
NU, NV = 26, 9  # вдоль рта × поперёк (v: +1 верхняя губа … −1 нижняя)
us = np.linspace(0, 1, NU)
vs = np.linspace(1, -1, NV)
cx = (ML[0, 0] + ML[-1, 0]) / 2


def mouth_pts(up, down, xs=1.0, prof=0.7, extra_down=None):
    pts = []
    for v in vs:
        for u in us:
            b = line_at(u)
            pr = math.sin(math.pi * u) ** prof
            x = cx + (b[0] - cx) * xs
            z = b[1] + (up * pr if v > 0 else 0) * v + (down * pr if v < 0 else 0) * v
            if extra_down is not None and v < 0:
                z += extra_down(u) * v
            pts.append((x, z))
    return pts


EPS = 0.00025 * SC
mouth_keys = {
    'Basis': mouth_pts(EPS, EPS),
    'mouth_A': mouth_pts(0.08 * W, 0.42 * W, xs=0.96),
    'mouth_E': mouth_pts(0.05 * W, 0.2 * W, xs=1.06, prof=0.45),
    'mouth_O': mouth_pts(0.12 * W, 0.34 * W, xs=0.58, prof=1.0),
    'mouth_U': mouth_pts(0.06 * W, 0.16 * W, xs=0.38, prof=1.2),
    'mouth_M': mouth_pts(EPS, EPS, xs=0.9),
    'tongue_out': mouth_pts(0.05 * W, 0.12 * W, xs=0.8, extra_down=lambda u: 0.32 * W * math.sin(math.pi * u) ** 3),
    'smile': [(x, z + 0.16 * W * ((x - cx) / (W / 2)) ** 2) for x, z in mouth_pts(EPS, EPS, xs=1.04)],
    'smirk': [(x, z + 0.2 * W * max(0.0, -(x - cx) / (W / 2)) ** 2) for x, z in mouth_pts(EPS, EPS)],
}
faces = []
for j in range(NV - 1):
    for i in range(NU - 1):
        a = j * NU + i
        faces.append((a, a + 1, a + NU + 1, a + NU))
cols = []
for v in vs:
    for u in us:
        if abs(v) > 0.86:
            c = (0.16, 0.04, 0.06)  # контур губ
        elif v > 0.55:
            c = (0.93, 0.92, 0.88)  # зубы
        elif v < -0.3:
            k = min(1.0, (-v - 0.3) / 0.4)
            c = (0.32 + 0.5 * k, 0.07 + 0.25 * k, 0.1 + 0.27 * k)  # язык
        else:
            c = (0.3, 0.06, 0.09)  # полость
        cols.append(c)
mouth_ob = make_obj('Mouth', mouth_keys, faces, cols, 0.0016 * SC)

# ───────────── веки ─────────────
lid_keys = {k: [] for k in ['Basis', 'blink_L', 'blink_R', 'wink_L', 'wink_R', 'eyes_squint']}
lid_cols, lid_faces = [], []
NLU, NLV = 22, 7
for side in ['L', 'R']:
    e = F['eyes'][side]
    top = np.array(e['top']); bot = np.array(e['bottom'])
    top = top[np.argsort(top[:, 0])]; bot = bot[np.argsort(bot[:, 0])]
    x0 = max(top[0, 0], bot[0, 0]); x1 = min(top[-1, 0], bot[-1, 0])
    fur = color_at(e['c'][0], top[:, 1].max() + 0.010 * SC) * 0.95
    lash = fur * 0.35
    base_index = len(lid_keys['Basis'])
    for j in range(NLV):
        v = j / (NLV - 1)  # 0 — верхний край века, 1 — нижний (ресницы)
        for i in range(NLU):
            u = i / (NLU - 1)
            x = x0 + (x1 - x0) * u
            tz = np.interp(x, top[:, 0], top[:, 1])
            bz = np.interp(x, bot[:, 0], bot[:, 1])
            pr = math.sin(math.pi * u) ** 0.6

            def lid(s):
                upper = tz + (0.0008 + 0.0028 * min(1.0, s * 3)) * SC * pr
                lower = tz + 0.0006 * SC * pr + (bz - tz - 0.0012 * SC) * s
                return (x, upper + (lower - upper) * v)
            closed_L = side == 'L'
            lid_keys['Basis'].append(lid(0.0))
            lid_keys['blink_L'].append(lid(1.04 if side == 'L' else 0.0))
            lid_keys['blink_R'].append(lid(1.04 if side == 'R' else 0.0))
            lid_keys['wink_L'].append(lid(1.04 if side == 'L' else 0.0))
            lid_keys['wink_R'].append(lid(1.04 if side == 'R' else 0.0))
            lid_keys['eyes_squint'].append(lid(0.4))
            k = max(0.0, (v - 0.65) / 0.35)
            lid_cols.append(tuple(fur * (1 - k) + lash * k))
    for j in range(NLV - 1):
        for i in range(NLU - 1):
            a = base_index + j * NLU + i
            lid_faces.append((a, a + 1, a + NLU + 1, a + NLU))
lids_ob = make_obj('EyeLids', lid_keys, lid_faces, lid_cols, 0.0034 * SC)

# ───────────── румянец ─────────────
bl_keys = {'Basis': [], 'blush': []}
bl_cols, bl_faces = [], []
NR, NA = 5, 18
for side in ['L', 'R']:
    e = F['eyes'][side]
    bxz = (e['c'][0] * 1.08, mouth['center'][1] + 0.55 * (e['c'][1] - mouth['center'][1]))
    skin = color_at(*bxz)
    pink = np.array([0.98, 0.5, 0.58])
    start = len(bl_keys['Basis'])
    for r in range(NR + 1):
        for a in range(NA):
            ang = 2 * math.pi * a / NA
            rr = r / NR
            bl_keys['Basis'].append((bxz[0] + math.cos(ang) * rr * 0.0003, bxz[1] + math.sin(ang) * rr * 0.0003))
            bl_keys['blush'].append((bxz[0] + math.cos(ang) * rr * 0.024 * SC, bxz[1] + math.sin(ang) * rr * 0.016 * SC))
            k = rr ** 1.6
            bl_cols.append(tuple(pink * (1 - k) * 0.85 + skin * (k + 0.15 * (1 - k))))
    for r in range(NR):
        for a in range(NA):
            p0 = start + r * NA + a; p1 = start + r * NA + (a + 1) % NA
            bl_faces.append((p0, p1, p1 + NA, p0 + NA))
blush_ob = make_obj('Blush', bl_keys, bl_faces, bl_cols, 0.0012 * SC)

for k, d in DISP.items():
    add_key(k, d)
print('keys main', [k.name for k in me.shape_keys.key_blocks])

bpy.ops.object.select_all(action='DESELECT')
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_animations=False, export_skins=True, export_morph=True,
                          export_morph_normal=False, export_yup=True, export_image_format='AUTO')
print('exported', out)

if preview:
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'; sc.cycles.device = 'CPU'; sc.cycles.samples = 12; sc.cycles.use_denoising = False
    w = bpy.data.worlds.new('w'); sc.world = w; w.use_nodes = True; w.node_tree.nodes['Background'].inputs[1].default_value = 3
    sc.render.resolution_x = 320; sc.render.resolution_y = 320
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); sc.collection.objects.link(cam); sc.camera = cam
    cam.data.type = 'ORTHO'; cam.data.ortho_scale = 0.34 * max(1.0, SC)
    fc = mouth['center3']
    cam.location = (fc[0], -2.0, (fc[2] + F['eyes']['L']['c3'][2]) / 2); cam.rotation_euler = (math.radians(90), 0, 0)
    all_obs = [mesh, mouth_ob, lids_ob, blush_ob]
    states = {'neutral': {}, 'A': {'mouth_A': 1}, 'O': {'mouth_O': 1}, 'E': {'mouth_E': 1}, 'smile': {'smile': 1, 'eyes_squint': 0.3},
              'blink': {'blink_L': 1, 'blink_R': 1}, 'tongue': {'tongue_out': 1, 'smirk': 0.6}, 'blush': {'blush': 1, 'smile': 0.6}}
    for nm, ws in states.items():
        for ob in all_obs:
            if ob.data.shape_keys:
                for kb in ob.data.shape_keys.key_blocks[1:]:
                    kb.value = ws.get(kb.name, 0.0)
        sc.render.filepath = f'{preview}_{nm}.png'
        bpy.ops.render.render(write_still=True)

"""Запекание нормалей и AO головы с high-poly Tripo на текущую сетку кота (Cycles, headless).

  bl/bin/python scripts/models/blender/bake_head.py -- <low.glb> <hipoly.glb> <out_prefix> [size=2048] [ao_samples=24]

low.glb — текущая модель (public/models/<n>_v1.glb: поза покоя = поза привязки, атлас TEXCOORD_0);
hipoly.glb — исходник Tripo высокой плотности (без скелета). Выравнивание — по габаритам (центр и рост), как у Tripo
обе модели смотрят в одну сторону. Пекутся только треугольники головы (вес кости Head ≥ 0.5) — тело не трогаем.
Выход: <out_prefix>_normal.png (касательное пространство, OpenGL +Y), <out_prefix>_ao.png (маску текселей головы
считает face_detail по весам кости Head). Дальше: python3 scripts/models/face_detail.py <n> in.glb out.glb --bake <out_prefix>
— смешивает запечённое с процедурным мехом (добавочный слой) только в текселях головы.
"""
import sys, os, math
import bpy, bmesh
import numpy as np

args = sys.argv[sys.argv.index('--') + 1:]
low_p, hi_p, out = args[:3]
SIZE = int(args[3]) if len(args) > 3 else 2048
AO_S = int(args[4]) if len(args) > 4 else 24

bpy.ops.wm.read_factory_settings(use_empty=True)


def import_glb(p):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=p)
    return [o for o in bpy.data.objects if o not in before]


lo_objs = import_glb(low_p)
low = max([o for o in lo_objs if o.type == 'MESH'], key=lambda o: len(o.data.vertices))
# только тело: накладки (глаза, брови, рот…) не участвуют
for o in lo_objs:
    if o.type == 'MESH' and o != low:
        bpy.data.objects.remove(o)
for m in list(low.modifiers):
    low.modifiers.remove(m)  # поза привязки
if low.data.shape_keys:
    low.shape_key_clear()
low.parent = None
head_g = low.vertex_groups.get('mixamorig:Head')
hi_objs = [o for o in import_glb(hi_p) if o.type == 'MESH']
for o in hi_objs:
    for m in list(o.modifiers):
        o.modifiers.remove(m)
    o.parent = None
bpy.context.view_layer.update()
# high-poly: самый плотный меш (мелкие накладки исходника не нужны)
hi = max(hi_objs, key=lambda o: len(o.data.polygons))
for o in hi_objs:
    if o != hi:
        bpy.data.objects.remove(o)
for o in [o for o in bpy.data.objects if o.type != 'MESH']:
    bpy.data.objects.remove(o)


def bbox(o):
    M = o.matrix_world
    P = np.array([tuple(M @ v.co) for v in o.data.vertices])
    return P.min(0), P.max(0)


lmin, lmax = bbox(low)
hmin, hmax = bbox(hi)
k = (lmax[2] - lmin[2]) / (hmax[2] - hmin[2])
hc = (hmin + hmax) / 2; lc = (lmin + lmax) / 2
from mathutils import Matrix
hi.matrix_world = Matrix.Translation(tuple(lc)) @ Matrix.Scale(k, 4) @ Matrix.Translation(tuple(-hc)) @ hi.matrix_world
bpy.context.view_layer.update()
print(f'[bake] high-poly: {len(hi.data.polygons)} граней, масштаб {k:.4f}; low: {len(low.data.polygons)}')

# голова: оставляем в low только треугольники с весом Head ≥ 0.5 (отдельный объект для запекания)
if head_g is not None:
    gi = head_g.index
    bm = bmesh.new(); bm.from_mesh(low.data)
    dl = bm.verts.layers.deform.active
    kill = [f for f in bm.faces if sum(v[dl].get(gi, 0.0) for v in f.verts) / len(f.verts) < 0.5]
    bmesh.ops.delete(bm, geom=kill, context='FACES')
    bm.to_mesh(low.data); bm.free()

img_n = bpy.data.images.new('bake_n', SIZE, SIZE, alpha=False, float_buffer=True)
img_n.colorspace_settings.name = 'Non-Color'
img_ao = bpy.data.images.new('bake_ao', SIZE, SIZE, alpha=False, float_buffer=True)
img_ao.colorspace_settings.name = 'Non-Color'
mat = bpy.data.materials.new('bake_mat'); mat.use_nodes = True
low.data.materials.clear(); low.data.materials.append(mat)
node = mat.node_tree.nodes.new('ShaderNodeTexImage')
mat.node_tree.nodes.active = node

sc = bpy.context.scene
sc.render.engine = 'CYCLES'
sc.cycles.device = 'CPU'
sc.render.bake.use_selected_to_active = True
sc.render.bake.cage_extrusion = 0.006
sc.render.bake.max_ray_distance = 0.015
sc.render.bake.margin = 4
bpy.ops.object.select_all(action='DESELECT')
hi.select_set(True); low.select_set(True)
bpy.context.view_layer.objects.active = low

node.image = img_n
sc.cycles.samples = 1
sc.render.bake.normal_space = 'TANGENT'

bpy.ops.object.bake(type='NORMAL')
node.image = img_ao
sc.cycles.samples = AO_S
bpy.ops.object.bake(type='AO')


def save(img, path, chans=3):
    a = np.empty(SIZE * SIZE * 4, np.float32)
    img.pixels.foreach_get(a)
    a = a.reshape(SIZE, SIZE, 4)[::-1, :, :chans]  # Blender: строка 0 внизу → PNG/glTF: сверху
    from PIL import Image
    Image.fromarray(np.clip(a * 255 + 0.5, 0, 255).astype(np.uint8).squeeze()).save(path)
    return a


n = save(img_n, out + '_normal.png')
save(img_ao, out + '_ao.png', 1)
print('[bake] →', out + '_normal.png', out + '_ao.png')

"""Запекание деталей с high-poly исходника Tripo на лёгкую сетку (Blender 5 как модуль, Cycles, CPU).

  /home/claude/bl/bin/python scripts/models/blender/bake_hipoly.py <low.glb> <high.glb> <out_prefix> [size=2048] [ao_samples=24]

→ <out_prefix>_normal.png (касательное пространство, OpenGL +Y, как glTF), <out_prefix>_ao.png (серый),
  <out_prefix>_mask.png (белое — луч попал в high-poly; там, где промах, body_detail оставляет старую карту).

Low — текущий GLB из main (берём самый большой меш — тело Tripo, атлас TEXCOORD_0, поза покоя, шейпкеи = базис).
High — исходник до ретопологии: все его меши склеиваются; выравнивание по габаритам (рост, центр по X/горизонтали,
низ по подошвам) — у Tripo high и low из одной генерации, совпадают с точностью до масштаба и сдвига.
Cage: extrusion 1% роста, max ray 2% роста. Результат забирает scripts/models/body_detail.py (только ниже головы,
процедурный мех и ткань ложатся сверху добавочным слоем).
"""
import sys
import bpy
import mathutils

args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:]
low_p, high_p, out = args[:3]
SIZE = int(args[3]) if len(args) > 3 else 2048
AO_S = int(args[4]) if len(args) > 4 else 24

bpy.ops.wm.read_factory_settings(use_empty=True)


def import_meshes(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    for a in list(bpy.data.actions):
        bpy.data.actions.remove(a)
    for o in new:
        if o.type == 'ARMATURE' and o.animation_data:
            o.animation_data.action = None
    return new


def bbox(objs):
    pts = [o.matrix_world @ mathutils.Vector(c) for o in objs for c in o.bound_box]
    mn = mathutils.Vector([min(p[i] for p in pts) for i in range(3)])
    mx = mathutils.Vector([max(p[i] for p in pts) for i in range(3)])
    return mn, mx


low_objs = import_meshes(low_p)
low = max([o for o in low_objs if o.type == 'MESH'], key=lambda o: len(o.data.vertices))
for o in low_objs:
    if o.type == 'MESH' and o != low:
        bpy.data.objects.remove(o)
# поза покоя, без морфов и скина — запекаем статично
for m in list(low.modifiers):
    low.modifiers.remove(m)
if low.data.shape_keys:
    low.shape_key_clear()
low.parent = None

high_objs = [o for o in import_meshes(high_p) if o.type == 'MESH']
print('[bake] high parts', [(o.name, len(o.data.vertices)) for o in high_objs])
for o in [o for o in bpy.data.objects if o.type == 'ARMATURE' or (o.type == 'MESH' and o not in high_objs and o != low)]:
    bpy.data.objects.remove(o)
bpy.ops.object.select_all(action='DESELECT')
for o in high_objs:
    for m in list(o.modifiers):
        o.modifiers.remove(m)
    if o.data.shape_keys:
        o.shape_key_clear()
    o.parent = None
    o.select_set(True)
# служебные мелочи импорта (Icosphere — форма кости и т.п.) — вон
big = [o for o in high_objs if len(o.data.vertices) >= 500]
for o in high_objs:
    if o not in big:
        bpy.data.objects.remove(o)
high_objs = sorted(big, key=lambda o: -len(o.data.vertices))
high = high_objs[0]
bpy.context.view_layer.objects.active = high
if len(high_objs) > 1:
    with bpy.context.temp_override(active_object=high, selected_editable_objects=high_objs):
        bpy.ops.object.join()
bpy.ops.object.select_all(action='DESELECT')
high.select_set(True)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# выравнивание по габаритам (Blender: Z — вверх)
lmn, lmx = bbox([low])
hmn, hmx = bbox([high])
k = (lmx.z - lmn.z) / max(hmx.z - hmn.z, 1e-9)
high.scale = (k, k, k)
bpy.ops.object.transform_apply(scale=True)
hmn, hmx = bbox([high])
high.location += mathutils.Vector(((lmn.x + lmx.x) / 2 - (hmn.x + hmx.x) / 2, (lmn.y + lmx.y) / 2 - (hmn.y + hmx.y) / 2, lmn.z - hmn.z))
bpy.ops.object.transform_apply(location=True)
H = lmx.z - lmn.z
print(f'[bake] low {len(low.data.polygons)} tris-ish, high {len(high.data.polygons)}; scale {k:.4f}; рост {H:.3f}')

sc = bpy.context.scene
sc.render.engine = 'CYCLES'
sc.cycles.device = 'CPU'
sc.render.bake.use_selected_to_active = True
sc.render.bake.use_cage = False
sc.render.bake.cage_extrusion = 0.01 * H
sc.render.bake.max_ray_distance = 0.02 * H
sc.render.bake.margin = 6

# у low — один материал с картинкой-целью (UV первого канала = TEXCOORD_0)
mat = bpy.data.materials.new('bake_target')
mat.use_nodes = True
low.data.materials.clear()
low.data.materials.append(mat)
nodes = mat.node_tree.nodes
tex = nodes.new('ShaderNodeTexImage')
nodes.active = tex
if not high.data.materials:
    high.data.materials.append(bpy.data.materials.new('hp'))


def bake(kind, name, samples, colorspace):
    img = bpy.data.images.new(name, SIZE, SIZE, alpha=False, float_buffer=False)
    img.colorspace_settings.name = colorspace
    tex.image = img
    sc.cycles.samples = samples
    bpy.ops.object.select_all(action='DESELECT')
    high.select_set(True)
    low.select_set(True)
    bpy.context.view_layer.objects.active = low
    if kind == 'NORMAL':
        sc.render.bake.normal_space = 'TANGENT'
        bpy.ops.object.bake(type='NORMAL')
    elif kind == 'AO':
        bpy.ops.object.bake(type='AO')
    else:  # маска попадания: эмиссия high = белый, фон low (промах) = чёрный
        bpy.ops.object.bake(type='EMIT')
    img.filepath_raw = f'{out}_{name}.png'
    img.file_format = 'PNG'
    img.save()
    print('[bake]', img.filepath_raw)


bake('NORMAL', 'normal', 1, 'Non-Color')
bake('AO', 'ao', AO_S, 'Non-Color')
# маска: high светится белым
for m in high.data.materials:
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    em = nt.nodes.new('ShaderNodeEmission'); em.inputs[0].default_value = (1, 1, 1, 1)
    o = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(em.outputs[0], o.inputs[0])
sc.render.bake.margin = 0
bake('EMIT', 'mask', 1, 'Non-Color')

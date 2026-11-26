"""Блёстка p4, стадия 0 (Blender headless): Tripo Auto Rig (35 мешей tripo_part_*, у каждого свой материал) → одна сетка
со скином (материалы-слоты сохраняются: при экспорте — примитив на часть), поза покоя и 65 костей Mixamo как у Tripo.
Дальше — как у Хулигана/Добряка: dump.py → find_parts.py → rig_cat.py (уши/хвост), затем glitter_p4.py (атлас).

    /tmp/bpyenv/bin/python scripts/models/blender/p4_join.py -- design/models/glitter_tripo_rigged.glb /tmp/p4/joined.glb
"""
import sys
import bpy

src, out = sys.argv[sys.argv.index('--') + 1:][:2]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
arm = [o for o in bpy.data.objects if o.type == 'ARMATURE'][0]
# Tripo Auto Rig кладёт арматуру под пустые узлы (Node_0 → node_0 с поворотом → RootNode): снять их с сохранением
# положения и применить поворот/масштаб — арматура в начале координат без поворота, как у Хулигана/Добряка
# (у их исходников этих узлов не было): иначе узлы-обёртки уходят в GLB и рантайм видит кота лёжа
for o in [arm] + [o for o in bpy.data.objects if o.type == 'MESH']:
    mw = o.matrix_world.copy(); o.parent = None; o.matrix_world = mw
for o in [o for o in bpy.data.objects if o.type == 'EMPTY']:
    bpy.data.objects.remove(o)
bpy.ops.object.select_all(action='DESELECT')
for o in bpy.data.objects:
    o.select_set(True)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
for o in bpy.data.objects:
    if o.type == 'MESH':
        o.parent = arm
        o.matrix_parent_inverse.identity()
meshes = [o for o in bpy.data.objects if o.type == 'MESH']
main = max(meshes, key=lambda o: len(o.data.vertices))
# имя части → в имя материала уже входит (tripo_part_N_material.002); join сохраняет слоты и группы вершин
bpy.ops.object.select_all(action='DESELECT')
for o in meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = main
bpy.ops.object.join()
main.name = 'tripo_mesh_glitter_p4'
main.data.name = 'tripo_mesh_glitter_p4'
for a in list(bpy.data.actions):
    bpy.data.actions.remove(a)
print('joined', len(main.data.vertices), 'verts', len(main.data.polygons), 'faces', len(main.data.materials), 'materials',
      len(arm.data.bones), 'bones')
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_yup=True, export_animations=False)

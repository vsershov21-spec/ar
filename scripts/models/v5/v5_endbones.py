"""Блёстка v5 (Blender headless): концевые кости Mixamo, которых нет в Auto Rig Tripo этой выгрузки (52 кости против 65
у Хулигана): HeadTop_End, Left/RightToe_End, пальцы *4 (Index/Middle/Ring/Pinky/Thumb). Без весов — как у Хулигана
(рантайм берёт HeadTop_End для капсулы головы, Toe_End — для опоры стопы, Middle4 — кончик кисти).
Кость — продолжение родителя на 0.8 его длины (HeadTop_End — до макушки сетки).

    /tmp/bpyenv/bin/python scripts/models/v5/v5_endbones.py -- in.glb out.glb
"""
import sys
import bpy
import mathutils

src, out = sys.argv[sys.argv.index('--') + 1:][:2]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
arm = [o for o in bpy.data.objects if o.type == 'ARMATURE'][0]
mesh = max([o for o in bpy.data.objects if o.type == 'MESH'], key=lambda o: len(o.data.vertices))
for a in list(bpy.data.actions):
    bpy.data.actions.remove(a)
top_z = max((mesh.matrix_world @ v.co).z for v in mesh.data.vertices)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode='EDIT')
eb = arm.data.edit_bones
added = []


def ext(parent, name, k=0.8, up=None):
    if name in eb:
        return
    p = eb[parent]
    b = eb.new(name)
    d = (p.tail - p.head)
    if up is not None:  # над головой кости на up (м), как ставит Auto Rig Tripo (у Хулигана — 0.145 над Head)
        b.head = p.head + mathutils.Vector((0, 0, up))
        b.tail = b.head + mathutils.Vector((0, 0, 0.05))
        b.parent = p; b.use_connect = False
    else:
        b.head = p.tail.copy()
        b.tail = p.tail + d * k
        b.parent = p; b.use_connect = True
    b.roll = p.roll
    added.append(name)


for s in ('Left', 'Right'):
    ext(f'mixamorig:{s}ToeBase', f'mixamorig:{s}Toe_End')
    for f in ('Index', 'Middle', 'Ring', 'Pinky', 'Thumb'):
        ext(f'mixamorig:{s}Hand{f}3', f'mixamorig:{s}Hand{f}4')
# макушка: как у Хулигана (Auto Rig Tripo — 0.145 над Head; кадр «лицо» инструментов и капсула головы — от неё)
ext('mixamorig:Head', 'mixamorig:HeadTop_End', up=0.145)
bpy.ops.object.mode_set(mode='OBJECT')
print('end bones', len(added), 'total', len(arm.data.bones))
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_animations=False, export_skins=True, export_morph=True,
                          export_yup=True, export_image_format='AUTO')

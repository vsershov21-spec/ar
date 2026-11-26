"""Tripo-оригинал Блёстки p4 (design/models/glitter_tripo_rigged.glb) — 4 вида и лицо (Cycles, headless), колонка
«Tripo-оригинал» листа p4 (tools/glitter-p4-sheet.py):
    /tmp/bpyenv/bin/python tools/glitter-p4-tripo-views.py -- design/models/glitter_tripo_rigged.glb <outdir>
→ <outdir>/tripo_{front,tq,side,back,face}.png (300×440)
"""
import bpy, sys, math, mathutils, os
src, out = sys.argv[sys.argv.index('--') + 1:][:2]
os.makedirs(out, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
sc = bpy.context.scene
sc.render.engine = 'CYCLES'; sc.cycles.samples = 24; sc.cycles.device = 'CPU'
sc.render.resolution_x = 300; sc.render.resolution_y = 440
w = bpy.data.worlds.new('w'); sc.world = w; w.use_nodes = True
w.node_tree.nodes['Background'].inputs[0].default_value = (0.93, 0.93, 0.94, 1); w.node_tree.nodes['Background'].inputs[1].default_value = 1.0
sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN')); sun.data.energy = 2.5; sc.collection.objects.link(sun)
sun.rotation_euler = (math.radians(50), 0, math.radians(20))
cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); sc.collection.objects.link(cam); sc.camera = cam
cam.data.lens = 85
# лицо Tripo смотрит в −Y Blender; вид спереди — камера на −Y
for name, yaw, tgt, dist in (('front', 0, (0, 0, 0.5), 2.75), ('tq', 35, (0, 0, 0.5), 2.75), ('side', -90, (0, 0, 0.5), 2.75),
                             ('back', 180, (0, 0, 0.5), 2.75), ('face', 0, (0, -0.13, 0.71), 1.3)):
    t = mathutils.Vector(tgt); r = math.radians(yaw)
    cam.location = t + mathutils.Vector((dist * math.sin(r), -dist * math.cos(r), 0.12 if name != 'face' else 0.03))
    d = t - cam.location; cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    sc.render.filepath = f'{out}/tripo_{name}.png'; bpy.ops.render.render(write_still=True)

"""Лицо модели Tripo крупно (Cycles, headless) — колонка «Tripo-оригинал» листа p3 (tools/glitter-p3-sheet.py):
    /tmp/bpyenv/bin/python tools/glitter-p3-tripo-face.py -- design/models/glitter_tripo_quad14k.glb out.png face
"""
import bpy, sys, math, mathutils
src, out, mode = sys.argv[sys.argv.index('--')+1:][:3]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
sc=bpy.context.scene
sc.render.engine='CYCLES'; sc.cycles.samples=24; sc.cycles.device='CPU'
sc.render.resolution_x=300; sc.render.resolution_y=300 if mode=='face' else 440
w=bpy.data.worlds.new('w'); sc.world=w; w.use_nodes=True; w.node_tree.nodes['Background'].inputs[0].default_value=(0.93,0.93,0.94,1); w.node_tree.nodes['Background'].inputs[1].default_value=1.0
sun=bpy.data.objects.new('sun', bpy.data.lights.new('sun','SUN')); sun.data.energy=2.5; sc.collection.objects.link(sun); sun.rotation_euler=(math.radians(50),0,math.radians(20))
cam=bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); sc.collection.objects.link(cam); sc.camera=cam
cam.data.lens=85
# glTF Y-up → Blender Z-up: лицо у Tripo смотрит в +Z glTF = −Y Blender
if mode=='face':
    tgt=mathutils.Vector((0,-0.13,0.70)); cam.location=tgt+mathutils.Vector((0,-1.0,0.04))
else:
    tgt=mathutils.Vector((0,0,0.5)); cam.location=tgt+mathutils.Vector((0,-4.2,0.15))
d=tgt-cam.location; cam.rotation_euler=d.to_track_quat('-Z','Y').to_euler()
sc.render.filepath=out; bpy.ops.render.render(write_still=True)

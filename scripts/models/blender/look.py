import bpy, sys, math, mathutils
src, out = sys.argv[sys.argv.index('--')+1:][:2]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
arm=[o for o in bpy.data.objects if o.type=='ARMATURE'][0]
mesh=max([o for o in bpy.data.objects if o.type=='MESH'],key=lambda o:len(o.data.vertices))
for o in bpy.data.objects:
    if o.type=='MESH' and o!=mesh: print('extra mesh',o.name,len(o.data.vertices)); o.hide_render=True
print('ARM', arm.name, len(arm.data.bones), 'MESH', mesh.name, len(mesh.data.vertices))
bb=[mesh.matrix_world@mathutils.Vector(c) for c in mesh.bound_box]
mn=mathutils.Vector([min(v[i] for v in bb) for i in range(3)]); mx=mathutils.Vector([max(v[i] for v in bb) for i in range(3)])
print('BB',mn,mx)
for b in ['mixamorig:Hips','mixamorig:Head','mixamorig:HeadTop_End','mixamorig:Spine','mixamorig:Neck']:
    bo=arm.data.bones.get(b); print(b, arm.matrix_world@bo.head_local if bo else None)
for a in bpy.data.actions: bpy.data.actions.remove(a)
if arm.animation_data: arm.animation_data.action=None
# renders: front, side, back
sc=bpy.context.scene; sc.render.engine='CYCLES'; sc.cycles.device='CPU'; sc.cycles.samples=8; sc.cycles.use_denoising=False
w=bpy.data.worlds.new('w'); sc.world=w; w.use_nodes=True; w.node_tree.nodes['Background'].inputs[1].default_value=1.5
sc.render.resolution_x=360; sc.render.resolution_y=480
cam=bpy.data.objects.new('cam',bpy.data.cameras.new('cam')); sc.collection.objects.link(cam); sc.camera=cam
cam.data.type='ORTHO'; c=(mn+mx)/2; h=(mx-mn); cam.data.ortho_scale=max(h)*1.1
import os
for name,ang in [('front',0),('side',90),('back',180),('q',135)]:
    r=math.radians(ang); d=max(h)*3
    cam.location=(c.x+d*math.sin(r), c.y-d*math.cos(r), c.z)
    cam.rotation_euler=(math.radians(90),0,r)
    sc.render.filepath=f'{out}_{name}.png'; bpy.ops.render.render(write_still=True)

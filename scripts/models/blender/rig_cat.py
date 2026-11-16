"""Достраивает скелет кота Tripo: хвост (Tail1..Tail4 от Hips) и уши (LeftEar1/RightEar1 от Head), веса, экспорт GLB.
Usage: python rig_cat.py -- in.glb parts.npz out.glb [test_render_prefix]"""
import bpy, sys, math, numpy as np, mathutils
args=sys.argv[sys.argv.index('--')+1:]
src, parts, out = args[:3]; test = args[3] if len(args)>3 else None
q=np.load(parts)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
arm=[o for o in bpy.data.objects if o.type=='ARMATURE'][0]
meshes=[o for o in bpy.data.objects if o.type=='MESH']
mesh=max(meshes,key=lambda o:len(o.data.vertices))
for o in meshes:
    if o!=mesh: bpy.data.objects.remove(o)
for a in list(bpy.data.actions): bpy.data.actions.remove(a)
if arm.animation_data: arm.animation_data.action=None
AW=arm.matrix_world.inverted()
V=lambda p: AW@mathutils.Vector(p)

bpy.context.view_layer.objects.active=arm
bpy.ops.object.mode_set(mode='EDIT')
eb=arm.data.edit_bones
def add(name,h,t,parent,roll_ref=None):
    b=eb.new(name); b.head=V(h); b.tail=V(t); b.parent=eb[parent]; b.use_connect=False; return b
J=q['tailj']
names=['Tail1','Tail2','Tail3','Tail4']
prev='mixamorig:Hips'
for i,nm in enumerate(names):
    b=add(nm,J[i],J[i+1],prev); 
    if i>0: b.use_connect=True
    prev=nm
for side,key in [('Left','earLj'),('Right','earRj')]:
    base,tip=q[key]; add(side+'Ear1',base,tip,'mixamorig:Head')
bpy.ops.object.mode_set(mode='OBJECT')

me=mesh.data
def vg(name): return mesh.vertex_groups.get(name) or mesh.vertex_groups.new(name=name)
def smooth(x): x=min(max(x,0),1); return x*x*(3-2*x)
# --- хвост
tail=q['tail']; g=q['tailg']; g0,g1=g.min(),g.max(); t=(g-g0)/(g1-g0+1e-9)
segs=[vg(n) for n in names]
hips=vg('mixamorig:Hips')
for vi,tv in zip(tail,t):
    v=me.vertices[int(vi)]
    root_blend=smooth(tv/0.12)          # у самого корня остаётся вес таза/спины
    for gr in list(v.groups):
        mesh.vertex_groups[gr.group].add([int(vi)], gr.weight*(1-root_blend), 'REPLACE')
    s=tv*4-0.5                          # центр сегмента i в (i+0.5)/4
    ws=np.array([max(0,1-abs(s-i)) for i in range(4)])
    if s<0: ws[0]=1
    if s>3: ws[3]=1
    ws/=ws.sum()
    for i in range(4):
        if ws[i]>1e-3: segs[i].add([int(vi)], float(ws[i]*root_blend), 'REPLACE')
# --- уши
for side,key in [('Left','earL'),('Right','earR')]:
    grp=vg(side+'Ear1'); base,tip=q[key+'j']
    for vi in q[key]:
        v=me.vertices[int(vi)]; p=np.array(mesh.matrix_world@v.co)
        k=smooth((p[2]-base[2])/(tip[2]-base[2]+1e-9)*1.4+0.15)
        for gr in list(v.groups): mesh.vertex_groups[gr.group].add([int(vi)], gr.weight*(1-k),'REPLACE')
        grp.add([int(vi)], float(k),'REPLACE')
# нормализация
bpy.context.view_layer.objects.active=mesh; mesh.select_set(True)
bpy.ops.object.mode_set(mode='WEIGHT_PAINT'); bpy.ops.object.vertex_group_normalize_all(lock_active=False); bpy.ops.object.mode_set(mode='OBJECT')
# ограничение 4 влияний (glTF)
bpy.ops.object.vertex_group_limit_total(limit=4); bpy.ops.object.mode_set(mode='WEIGHT_PAINT'); bpy.ops.object.vertex_group_normalize_all(lock_active=False); bpy.ops.object.mode_set(mode='OBJECT')
print('bones',len(arm.data.bones))

bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_animations=False, export_skins=True, export_morph=True, export_yup=True, export_image_format='AUTO')
print('exported',out)

if test:
    pb=arm.pose.bones
    for i,nm in enumerate(names): pb[nm].rotation_mode='XYZ'; pb[nm].rotation_euler=(0,0,math.radians(float(__import__('os').environ.get('TA','25'))))
    pb['LeftEar1'].rotation_mode='XYZ'; pb['LeftEar1'].rotation_euler=(math.radians(-40),0,0)
    pb['RightEar1'].rotation_mode='XYZ'; pb['RightEar1'].rotation_euler=(math.radians(40),0,math.radians(30))
    bpy.context.view_layer.update()
    sc=bpy.context.scene; sc.render.engine='CYCLES'; sc.cycles.device='CPU'; sc.cycles.samples=8; sc.cycles.use_denoising=False
    w=bpy.data.worlds.new('w'); sc.world=w; w.use_nodes=True; w.node_tree.nodes['Background'].inputs[1].default_value=3
    sc.render.resolution_x=360; sc.render.resolution_y=480
    cam=bpy.data.objects.new('cam',bpy.data.cameras.new('cam')); sc.collection.objects.link(cam); sc.camera=cam
    cam.data.type='ORTHO'; cam.data.ortho_scale=1.1
    for nm,ang in [('back',180),('q',135)]:
        r=math.radians(ang); cam.location=(3*math.sin(r),-3*math.cos(r),0.5); cam.rotation_euler=(math.radians(90),0,r)
        sc.render.filepath=f'{test}_{nm}.png'; bpy.ops.render.render(write_still=True)

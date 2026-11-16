import bpy, sys, numpy as np, mathutils
src, out = sys.argv[sys.argv.index('--')+1:][:2]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
arm=[o for o in bpy.data.objects if o.type=='ARMATURE'][0]
mesh=max([o for o in bpy.data.objects if o.type=='MESH'],key=lambda o:len(o.data.vertices))
me=mesh.data; M=mesh.matrix_world
P=np.array([tuple(M@v.co) for v in me.vertices])
# uv per vertex (first loop)
uv=np.zeros((len(me.vertices),2)); uvl=me.uv_layers.active.data
for l in me.loops: uv[l.vertex_index]=uvl[l.index].uv
mat=me.materials[0]; img=None
for n in mat.node_tree.nodes:
    if n.type=='TEX_IMAGE' and any(lk.to_socket.name=='Base Color' for lk in n.outputs[0].links): img=n.image
w,h=img.size; px=np.array(img.pixels[:]).reshape(h,w,img.channels)
xi=np.clip((uv[:,0]%1)*w,0,w-1).astype(int); yi=np.clip((uv[:,1]%1)*h,0,h-1).astype(int)
C=px[yi,xi,:3]
names=[g.name for g in mesh.vertex_groups]
top=np.array([max(v.groups,key=lambda g:g.weight).group if v.groups else -1 for v in me.vertices])
bones={b.name:tuple(arm.matrix_world@b.head_local) for b in arm.data.bones}
E=np.array([tuple(e.vertices) for e in me.edges])
np.savez(out,E=E,P=P,C=C,top=top,names=np.array(names),bn=np.array(list(bones.keys())),bp=np.array(list(bones.values())))
print('ok',len(P))

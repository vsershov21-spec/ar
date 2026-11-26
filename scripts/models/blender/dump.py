import bpy, sys, numpy as np, mathutils
src, out = sys.argv[sys.argv.index('--')+1:][:2]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
arm=[o for o in bpy.data.objects if o.type=='ARMATURE'][0]
mesh=max([o for o in bpy.data.objects if o.type=='MESH'],key=lambda o:len(o.data.vertices))
me=mesh.data; M=mesh.matrix_world
P=np.array([tuple(M@v.co) for v in me.vertices])
# uv per vertex (first loop) и картинка базового цвета по материалу полигона (сетка из нескольких частей — p4_join.py)
uv=np.zeros((len(me.vertices),2)); uvl=me.uv_layers.active.data; vm=np.zeros(len(me.vertices),int)
for poly in me.polygons:
    for li in poly.loop_indices:
        vi=me.loops[li].vertex_index; uv[vi]=uvl[li].uv; vm[vi]=poly.material_index
def base_px(mat):
    for n in mat.node_tree.nodes:
        if n.type=='TEX_IMAGE' and any(lk.to_socket.name=='Base Color' for lk in n.outputs[0].links):
            w,h=n.image.size; return np.array(n.image.pixels[:]).reshape(h,w,n.image.channels)
C=np.zeros((len(me.vertices),3))
for mi,mat in enumerate(me.materials):
    sel=vm==mi
    if not sel.any(): continue
    px=base_px(mat); h,w=px.shape[:2]
    xi=np.clip((uv[sel,0]%1)*w,0,w-1).astype(int); yi=np.clip((uv[sel,1]%1)*h,0,h-1).astype(int)
    C[sel]=px[yi,xi,:3]
names=[g.name for g in mesh.vertex_groups]
top=np.array([max(v.groups,key=lambda g:g.weight).group if v.groups else -1 for v in me.vertices])
bones={b.name:tuple(arm.matrix_world@b.head_local) for b in arm.data.bones}
E=np.array([tuple(e.vertices) for e in me.edges])
np.savez(out,E=E,P=P,C=C,top=top,vm=vm,mats=np.array([m.name for m in me.materials]),names=np.array(names),bn=np.array(list(bones.keys())),bp=np.array(list(bones.values())))
print('ok',len(P))

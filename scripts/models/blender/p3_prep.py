"""Стадия 1 Блёстки p3 (Blender headless): GLB Tripo → одна сетка, упрощение, массивы для glitter_p3.py.

    /tmp/bpyenv/bin/python scripts/models/blender/p3_prep.py <tripo.glb> <out.npz> [--tris 32000]

В npz: V (n,3) в осях glTF (Y вверх), N, UV (вершины расщеплены по швам UV), F (m,3), tex — путь к PNG базового цвета
(рядом с out), texsize. Масштаб и поворот не трогаем — их ставит glitter_p3.py.
"""
import sys, os, argparse
import numpy as np
import bpy, bmesh

ap = argparse.ArgumentParser()
ap.add_argument('src'); ap.add_argument('out'); ap.add_argument('--tris', type=int, default=32000)
a = ap.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[1:])

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=os.path.abspath(a.src))
objs = [o for o in bpy.context.scene.objects if o.type == 'MESH']
for o in bpy.context.scene.objects:
    o.select_set(o in objs)
bpy.context.view_layer.objects.active = objs[0]
if len(objs) > 1:
    bpy.ops.object.join()
ob = bpy.context.view_layer.objects.active
bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
me = ob.data
n0 = len(me.polygons)
# швы сшиты по позиции (Tripo часто отдаёт расщеплённые вершины) — иначе упрощение рвёт сетку
bm = bmesh.new(); bm.from_mesh(me)
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
bmesh.ops.triangulate(bm, faces=bm.faces)
bm.to_mesh(me); bm.free()
nt = len(me.polygons)
if nt > a.tris:
    m = ob.modifiers.new('dec', 'DECIMATE'); m.ratio = a.tris / nt; m.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier='dec')
bm = bmesh.new(); bm.from_mesh(me); bmesh.ops.triangulate(bm, faces=bm.faces); bm.to_mesh(me); bm.free()
print(f'треугольников: исходно {n0}, после упрощения {len(me.polygons)}')

uvl = me.uv_layers.active.data
co = np.array([v.co[:] for v in me.vertices])
F, keys = [], {}
V, UV = [], []
for p in me.polygons:
    tri = []
    for li in p.loop_indices:
        vi = me.loops[li].vertex_index
        uv = tuple(np.round(uvl[li].uv[:], 6))
        k = (vi, uv)
        if k not in keys:
            keys[k] = len(V); V.append(co[vi]); UV.append(uv)
        tri.append(keys[k])
    F.append(tri)
V = np.array(V); UV = np.array(UV); F = np.array(F, dtype=np.int64)
# Blender Z-up → glTF Y-up: (x, y, z) → (x, z, -y); UV Blender → glTF: v → 1 - v
V = np.stack([V[:, 0], V[:, 2], -V[:, 1]], 1)
UV = np.stack([UV[:, 0], 1 - UV[:, 1]], 1)

# базовый цвет: самая большая картинка у материала с Base Color
img = None
for mat in me.materials:
    if not mat or not mat.use_nodes:
        continue
    for n in mat.node_tree.nodes:
        if n.type == 'TEX_IMAGE' and n.image and any(l.to_socket.name == 'Base Color' for l in n.outputs[0].links):
            img = n.image
if img is None:
    imgs = sorted(bpy.data.images, key=lambda i: -i.size[0] * i.size[1]); img = imgs[0]
tex = os.path.splitext(a.out)[0] + '_base.png'
img.filepath_raw = tex; img.file_format = 'PNG'; img.save()
np.savez_compressed(a.out, V=V.astype(np.float32), UV=UV.astype(np.float32), F=F, tex=tex, texsize=np.array(img.size))
print('→', a.out, len(V), 'вершин', len(F), 'треуг.', 'текстура', img.size[:], tex)

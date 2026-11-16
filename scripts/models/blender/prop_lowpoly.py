"""Реквизит Tripo (миллионы треугольников) → лёгкий GLB для телефона. Usage: prop_lowpoly.py -- in.glb out.glb [tris=4000]"""
import bpy, sys
a = sys.argv[sys.argv.index('--') + 1:]
src, out = a[0], a[1]
target = int(a[2]) if len(a) > 2 else 4000
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
for o in [o for o in bpy.data.objects if o.type == 'MESH']:
    tris = sum(len(p.vertices) - 2 for p in o.data.polygons)
    bpy.context.view_layer.objects.active = o
    # швы UV режут сетку на острова — сначала сшиваем, иначе Decimate упирается в границы
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.remove_doubles(threshold=1e-5); bpy.ops.object.mode_set(mode='OBJECT')
    for _ in range(4):
        cur = sum(len(p.vertices) - 2 for p in o.data.polygons)
        if cur <= target * 1.1: break
        m = o.modifiers.new('dec', 'DECIMATE'); m.ratio = max(target / cur, 0.02); m.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier='dec')
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.shade_smooth_by_angle(angle=0.6)
    print(o.name, tris, '->', sum(len(p.vertices) - 2 for p in o.data.polygons))
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_yup=True)

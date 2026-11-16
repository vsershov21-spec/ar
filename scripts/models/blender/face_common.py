"""Общие функции лицевого рига (Blender as module): загрузка GLB, BVH поверхности, UV/цвет в точке поверхности."""
import bpy, numpy as np, mathutils
from mathutils.bvhtree import BVHTree


def load_glb(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)
    arm = [o for o in bpy.data.objects if o.type == 'ARMATURE'][0]
    meshes = [o for o in bpy.data.objects if o.type == 'MESH']
    mesh = max(meshes, key=lambda o: len(o.data.vertices))
    for o in meshes:
        if o != mesh:
            bpy.data.objects.remove(o)
    for a in list(bpy.data.actions):
        bpy.data.actions.remove(a)
    if arm.animation_data:
        arm.animation_data.action = None
    return arm, mesh


def base_image(mesh):
    for m in mesh.data.materials:
        for n in m.node_tree.nodes:
            if n.type == 'TEX_IMAGE' and any(l.to_socket.name == 'Base Color' for l in n.outputs[0].links):
                return n.image
    return None


def image_array(img):
    w, h = img.size
    a = np.empty(w * h * img.channels, dtype=np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(h, w, img.channels)[:, :, :3]


class Surface:
    """Поверхность меша в мировых координатах: луч/ближайшая точка → треугольник, UV, нормаль, цвет текстуры."""

    def __init__(self, mesh, tex=None):
        me = mesh.data
        me.calc_loop_triangles()
        M = mesh.matrix_world
        self.P = np.array([tuple(M @ v.co) for v in me.vertices])
        self.tris = np.array([tuple(t.vertices) for t in me.loop_triangles])
        self.tri_loops = np.array([tuple(t.loops) for t in me.loop_triangles])
        self.tri_poly = np.array([t.polygon_index for t in me.loop_triangles])
        uvl = me.uv_layers.active.data
        self.loop_uv = np.array([tuple(uvl[i].uv) for i in range(len(me.loops))])
        self.bvh = BVHTree.FromPolygons([tuple(p) for p in self.P], [tuple(t) for t in self.tris])
        self.tex = tex
        nrm = np.array([tuple((M.to_3x3() @ v.normal).normalized()) for v in me.vertices])
        self.N = nrm

    def bary(self, ti, p):
        a, b, c = self.P[self.tris[ti]]
        v0, v1, v2 = b - a, c - a, p - a
        d00, d01, d11 = v0 @ v0, v0 @ v1, v1 @ v1
        d20, d21 = v2 @ v0, v2 @ v1
        den = d00 * d11 - d01 * d01 + 1e-20
        v = (d11 * d20 - d01 * d21) / den
        w = (d00 * d21 - d01 * d20) / den
        return np.array([1 - v - w, v, w])

    def uv_at(self, ti, p):
        return self.bary(ti, p) @ self.loop_uv[self.tri_loops[ti]]

    def normal_at(self, ti, p):
        n = self.bary(ti, p) @ self.N[self.tris[ti]]
        return n / (np.linalg.norm(n) + 1e-12)

    def color_uv(self, uv, img=None):
        img = self.tex if img is None else img
        h, w = img.shape[:2]
        x = (uv[..., 0] % 1) * w - 0.5
        y = (uv[..., 1] % 1) * h - 0.5
        x0 = np.clip(np.floor(x).astype(int), 0, w - 1); y0 = np.clip(np.floor(y).astype(int), 0, h - 1)
        x1 = np.clip(x0 + 1, 0, w - 1); y1 = np.clip(y0 + 1, 0, h - 1)
        fx = np.clip(x - x0, 0, 1)[..., None]; fy = np.clip(y - y0, 0, 1)[..., None]
        return (img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x1] * fx * (1 - fy) + img[y1, x0] * (1 - fx) * fy + img[y1, x1] * fx * fy)

    def ray_front(self, x, z, y0=-1.0):
        """луч спереди (из -Y в +Y) → (точка, треугольник) или (None, None)"""
        loc, nrm, ti, dist = self.bvh.ray_cast(mathutils.Vector((x, y0, z)), mathutils.Vector((0, 1, 0)))
        if loc is None:
            return None, None
        return np.array(loc), ti

    def nearest(self, p):
        loc, nrm, ti, dist = self.bvh.find_nearest(mathutils.Vector(tuple(p)))
        return np.array(loc), ti

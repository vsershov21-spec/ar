"""Фронтальный «снимок» лица: лучи спереди (−Y→+Y) по сетке x/z вокруг головы → цвет текстуры, точка, нормаль.
Usage: python face_photo.py -- in.glb out.npz [step_m=0.0006]"""
import sys, os, numpy as np
sys.path.insert(0, os.path.dirname(__file__))
from face_common import load_glb, base_image, image_array, Surface
args = sys.argv[sys.argv.index('--') + 1:]
src, out = args[:2]
step = float(args[2]) if len(args) > 2 else 0.0006
arm, mesh = load_glb(src)
tex = image_array(base_image(mesh))
S = Surface(mesh, tex)
head = np.array(arm.matrix_world @ arm.data.bones['mixamorig:Head'].head_local)
xs = np.arange(-0.2, 0.2, step) + head[0]
zs = np.arange(head[2] - 0.05, head[2] + 0.33, step)
H, W = len(zs), len(xs)
C = np.zeros((H, W, 3), np.float32); L = np.full((H, W, 3), np.nan, np.float32); Nn = np.zeros((H, W, 3), np.float32)
for i, z in enumerate(zs[::-1]):
    for j, x in enumerate(xs):
        p, ti = S.ray_front(x, z)
        if p is None:
            continue
        uv = S.uv_at(ti, p)
        C[i, j] = S.color_uv(uv)
        L[i, j] = p
        Nn[i, j] = S.normal_at(ti, p)
np.savez_compressed(out, C=C, L=L, N=Nn, xs=xs, zs=zs[::-1], head=head, step=step)
from PIL import Image
Image.fromarray((np.clip(C, 0, 1) * 255).astype(np.uint8)).save(out.replace('.npz', '.png'))
print('photo', H, W)

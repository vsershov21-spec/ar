"""Блёстка v5: общие вещи стадий лица — чтение тела, растр «спереди» (орто, +Z к камере) с номером треугольника и
барицентрическими координатами, цвет текстуры по UV."""
import numpy as np
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from glb_io import Glb  # noqa: E402


def body(g):
    mi, pr = g.main_mesh()
    A = pr['attributes']
    return dict(mi=mi, pr=pr, P=g.acc(A['POSITION']).astype(np.float64), N=g.acc(A['NORMAL']).astype(np.float64),
                UV=g.acc(A['TEXCOORD_0']).astype(np.float64), J=g.acc(A['JOINTS_0']), W=g.acc(A['WEIGHTS_0']),
                I=g.acc(pr['indices']).reshape(-1, 3).astype(np.int64))


def raster_front(P, I, box, px):
    """орто спереди: box = (x0, x1, y0, y1), px — метров на пиксель → (tri, bary, depth) H×W; x вправо = +X модели
    (левая сторона кота — справа на картинке не: камера смотрит в −Z, +X — справа на снимке)"""
    x0, x1, y0, y1 = box
    Wd, Ht = int(round((x1 - x0) / px)), int(round((y1 - y0) / px))
    depth = np.full((Ht, Wd), -1e9); tri = np.full((Ht, Wd), -1, np.int64); bary = np.zeros((Ht, Wd, 3))
    X = (P[:, 0] - x0) / px; Y = (y1 - P[:, 1]) / px; Z = P[:, 2]
    T = I[(np.maximum.reduce([X[I[:, 0]], X[I[:, 1]], X[I[:, 2]]]) >= 0) & (np.minimum.reduce([X[I[:, 0]], X[I[:, 1]], X[I[:, 2]]]) < Wd)
          & (np.maximum.reduce([Y[I[:, 0]], Y[I[:, 1]], Y[I[:, 2]]]) >= 0) & (np.minimum.reduce([Y[I[:, 0]], Y[I[:, 1]], Y[I[:, 2]]]) < Ht)]
    idx = np.where((np.maximum.reduce([X[I[:, 0]], X[I[:, 1]], X[I[:, 2]]]) >= 0) & (np.minimum.reduce([X[I[:, 0]], X[I[:, 1]], X[I[:, 2]]]) < Wd)
                   & (np.maximum.reduce([Y[I[:, 0]], Y[I[:, 1]], Y[I[:, 2]]]) >= 0) & (np.minimum.reduce([Y[I[:, 0]], Y[I[:, 1]], Y[I[:, 2]]]) < Ht))[0]
    for ti in idx:
        a, b, c = I[ti]
        xa, ya, xb, yb, xc, yc = X[a], Y[a], X[b], Y[b], X[c], Y[c]
        det = (yb - yc) * (xa - xc) + (xc - xb) * (ya - yc)
        if abs(det) < 1e-12:
            continue
        mx0, mx1 = max(int(np.floor(min(xa, xb, xc))), 0), min(int(np.ceil(max(xa, xb, xc))), Wd - 1)
        my0, my1 = max(int(np.floor(min(ya, yb, yc))), 0), min(int(np.ceil(max(ya, yb, yc))), Ht - 1)
        if mx1 < mx0 or my1 < my0:
            continue
        gx, gy = np.meshgrid(np.arange(mx0, mx1 + 1) + 0.5, np.arange(my0, my1 + 1) + 0.5)
        l1 = ((yb - yc) * (gx - xc) + (xc - xb) * (gy - yc)) / det
        l2 = ((yc - ya) * (gx - xc) + (xa - xc) * (gy - yc)) / det
        l3 = 1 - l1 - l2
        ins = (l1 >= -1e-6) & (l2 >= -1e-6) & (l3 >= -1e-6)
        if not ins.any():
            continue
        z = l1 * Z[a] + l2 * Z[b] + l3 * Z[c]
        sub = depth[my0:my1 + 1, mx0:mx1 + 1]
        upd = ins & (z > sub)
        sub[upd] = z[upd]
        tri[my0:my1 + 1, mx0:mx1 + 1][upd] = ti
        bb = bary[my0:my1 + 1, mx0:mx1 + 1]
        bb[upd] = np.stack([l1[upd], l2[upd], l3[upd]], -1)
    return tri, bary, depth


def interp(attr, I, tri, bary):
    """атрибут вершин в пикселях растра (tri < 0 → 0)"""
    t = np.maximum(tri, 0)
    v = attr[I[t]]  # H, W, 3, k
    out = (v * bary[..., None]).sum(-2)
    out[tri < 0] = 0
    return out


def sample(tex, uv):
    """цвет текстуры (H×W×3 uint8) по UV glTF (v вниз от верха картинки), ближайший тексель"""
    h, w = tex.shape[:2]
    x = np.clip((uv[..., 0] % 1) * w, 0, w - 1).astype(int); y = np.clip((uv[..., 1] % 1) * h, 0, h - 1).astype(int)
    return tex[y, x]

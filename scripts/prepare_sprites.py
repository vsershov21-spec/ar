#!/usr/bin/env python3
"""Готовит PNG-позы персонажа для спрайт-режима.

Вход:  assets-src/sprites/<поза>.png            — общий образ (сейчас заглушка: старый кот в голубом худи)
       assets-src/sprites/<персона>/<поза>.png  — если есть, берётся как готовый финальный арт персоны
Выход: public/sprites/<персона>/<поза>.webp (высота до 512 px, прозрачность сохраняется)

Пока финального арта нет, образы персон делаются перекраской худи/кепки заглушки:
hooligan — чёрное худи с бирюзовым отливом, лаймовая кепка; glitter — лавандовое худи, мятная кепка.
Когда придут финальные позы — положите их в assets-src/sprites/<персона>/ с теми же именами
(или поправьте public/sprites/manifest.json) и запустите `npm run prepare-sprites`.
"""
import os, colorsys
import numpy as np
from PIL import Image

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
SRC = os.path.join(ROOT, 'assets-src', 'sprites')
OUT = os.path.join(ROOT, 'public', 'sprites')
MAX_H = 512

PERSONAS = {
    # (hue_from_min, hue_from_max) -> функция перекраски HSV
    'hooligan': {'hoodie': lambda h, s, v: (0.48, 0.35 * s, v * 0.22 + 0.04), 'cap': None},
    'glitter': {'hoodie': lambda h, s, v: (0.74, s * 0.45, np.minimum(1, v * 1.05 + 0.08)),
                'cap': lambda h, s, v: (0.43, s * 0.55, np.minimum(1, v * 1.05))},
}


def rgb_to_hsv(a):
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    mx = a.max(-1); mn = a.min(-1); d = mx - mn
    h = np.zeros_like(mx)
    m = d > 1e-6
    rc = np.where(m, (mx - r) / np.where(m, d, 1), 0)
    gc = np.where(m, (mx - g) / np.where(m, d, 1), 0)
    bc = np.where(m, (mx - b) / np.where(m, d, 1), 0)
    h = np.where(r == mx, bc - gc, np.where(g == mx, 2.0 + rc - bc, 4.0 + gc - rc))
    h = (h / 6.0) % 1.0
    s = np.where(mx > 1e-6, d / np.where(mx > 1e-6, mx, 1), 0)
    return h, s, mx


def hsv_to_rgb(h, s, v):
    i = np.floor(h * 6).astype(int) % 6
    f = h * 6 - np.floor(h * 6)
    p = v * (1 - s); q = v * (1 - s * f); t = v * (1 - s * (1 - f))
    conds = [i == k for k in range(6)]
    r = np.select(conds, [v, q, p, p, t, v]); g = np.select(conds, [t, v, v, q, p, p]); b = np.select(conds, [p, p, t, v, v, q])
    return np.stack([r, g, b], -1)


def recolor(img, spec):
    a = np.asarray(img).astype(np.float64) / 255
    rgb = a[..., :3]
    h, s, v = rgb_to_hsv(rgb)
    out_h, out_s, out_v = h.copy(), s.copy(), v.copy()
    hoodie = (h > 0.47) & (h < 0.58) & (s > 0.35) & (v > 0.25)
    cap = (h > 0.17) & (h < 0.30) & (s > 0.35) & (v > 0.3)
    for mask, fn in ((hoodie, spec['hoodie']), (cap, spec['cap'])):
        if fn is None:
            continue
        nh, ns, nv = fn(h[mask], s[mask], v[mask])
        out_h[mask] = nh; out_s[mask] = ns; out_v[mask] = nv
    rgb2 = hsv_to_rgb(out_h, out_s, out_v)
    res = np.concatenate([rgb2, a[..., 3:4]], -1)
    return Image.fromarray((res * 255).clip(0, 255).astype(np.uint8), 'RGBA')


def main():
    poses = sorted(f for f in os.listdir(SRC) if f.endswith('.png'))
    for persona, spec in PERSONAS.items():
        od = os.path.join(OUT, persona)
        os.makedirs(od, exist_ok=True)
        for f in poses:
            custom = os.path.join(SRC, persona, f)
            img = Image.open(custom if os.path.exists(custom) else os.path.join(SRC, f)).convert('RGBA')
            if img.height > MAX_H:
                img = img.resize((round(img.width * MAX_H / img.height), MAX_H), Image.LANCZOS)
            if not os.path.exists(custom):
                img = recolor(img, spec)
            img.save(os.path.join(od, f[:-4] + '.webp'), 'WEBP', quality=88, method=6)
        print(persona, len(poses), 'поз')


if __name__ == '__main__':
    main()

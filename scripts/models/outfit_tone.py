#!/usr/bin/env python3
"""Тон одежды по рефам (одежда Tripo запечена в общую текстуру тела — перекраска материала меша, как
content/src/*.meta.json glb.tint, перекрасила бы и мех; поэтому правим тексели одежды прямо в альбедо).

  python3 scripts/models/outfit_tone.py <cat> in.glb out.glb

Маска — тексели треугольников нужной части (mesh_parts.label_parts → растеризация UV) с запасом 2 px.
Добряк: шарф и сапожки — коралл мягче (рефы: лососевый, не красно-оранжевый); Блёстка: худи — пастельная лаванда
(рефы светлее и мягче); Хулиган: кепка — салатовый чуть мягче.
"""
import sys
import numpy as np
from PIL import Image, ImageFilter
from glb_io import Glb, raster_uv
from mesh_parts import label_parts, HOODIE, SCARF, SHOES, CAP, BODY

# часть → (насыщенность ×, яркость ×, сдвиг к цвету rgb, доля)
TONE = {
    'kind': {SCARF: (0.72, 1.04, (236, 156, 136), 0.25), SHOES: (0.72, 1.04, (236, 156, 136), 0.25)},
    'glitter': {HOODIE: (0.62, 1.07, (204, 186, 232), 0.3)},
    'hooligan': {CAP: (0.86, 0.98, None, 0)},
}


def main():
    cat, src, dst = sys.argv[1:4]
    g = Glb(src); j = g.j
    bi, b = g.main_mesh()
    P = g.acc(b['attributes']['POSITION']).astype(np.float64)
    N = g.acc(b['attributes']['NORMAL']).astype(np.float64)
    UV = g.acc(b['attributes']['TEXCOORD_0']).astype(np.float64)
    I = g.acc(b['indices']).reshape(-1, 3).astype(np.int64)
    lab = label_parts(cat, g, b, P, I)
    lt = np.array([np.bincount(lab[t], minlength=8).argmax() for t in I])
    ti = j['textures'][j['materials'][b['material']]['pbrMetallicRoughness']['baseColorTexture']['index']]['source']
    img = g.image(ti).convert('RGB')
    S = img.size[0]
    _, _, tid = raster_uv(P, N, UV, I, S)
    a = np.asarray(img).astype(np.float64)
    hsvimg = np.asarray(img.convert('HSV')).astype(np.float64)
    for part, (ks, kv, tgt, mix) in TONE.get(cat, {}).items():
        m = (tid >= 0) & (lt[np.maximum(tid, 0)] == part)
        m = np.asarray(Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(5))) > 0
        # фур-тексели (голубовато-серые) не трогаем, даже если попали в маску на шве
        h, s_ = hsvimg[..., 0] * 360 / 255, hsvimg[..., 1] / 255
        m &= ~((h > 198) & (h < 250) & (s_ < 0.5))
        hs = hsvimg.copy()
        hs[..., 1] = hs[..., 1] * ks
        hs[..., 2] = np.clip(hs[..., 2] * kv, 0, 255)
        rgb = np.asarray(Image.fromarray(hs.astype(np.uint8), 'HSV').convert('RGB')).astype(np.float64)
        if not m.any():
            continue
        if tgt is not None and mix > 0:
            mean = rgb[m].mean(0)
            rgb = rgb + (np.array(tgt) - mean) * mix
        a[m] = np.clip(rgb[m], 0, 255)
        print(f'{cat}: часть {part} — {m.sum()} текселей, средний цвет {np.asarray(img)[m].mean(0).astype(int)} → {a[m].mean(0).astype(int)}')
    g.set_image(ti, Image.fromarray(a.astype(np.uint8)))
    # карта нормалей — перекодировать JPEG q85 (ничего не меняя): −25 % файла, бюджет ≤ 4.5 МБ с прядями и фатином
    nt = j['materials'][b['material']].get('normalTexture')
    if nt and not j['images'][j['textures'][nt['index']]['source']].get('extras', {}).get('requant'):
        ni = j['textures'][nt['index']]['source']
        g.set_image(ni, g.image(ni).convert('RGB'))
        j['images'][ni].setdefault('extras', {})['requant'] = 85
    g.save(dst)


if __name__ == '__main__':
    main()

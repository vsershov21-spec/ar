#!/usr/bin/env python3
"""Нарезка листов из AI Studio на отдельные PNG с прозрачным фоном.

Использование:
  python3 scripts/design/cut_sheets.py design/sheets/manifest.json design/cut
manifest.json: [{"file": "hooligan_turnaround.jpg", "cols": 4, "rows": 1, "names": ["front","34","side","back"], "prefix": "hooligan/turn"}]

Шаги: равная сетка → вырезка фона rembg (isnet-general-use) → оставляем самую крупную связную
область (отрезает куски соседних поз) → обрезка по содержимому с полями 4% → PNG с альфой.
"""
import json, sys
from pathlib import Path

import numpy as np
from PIL import Image
from rembg import new_session, remove
from scipy import ndimage

def largest_component(alpha: np.ndarray) -> np.ndarray:
    mask = alpha > 24
    lab, n = ndimage.label(mask)
    if n <= 1:
        return alpha
    sizes = ndimage.sum(mask, lab, range(1, n + 1))
    keep = 1 + int(np.argmax(sizes))
    # маленькие детали рядом с главной (блёстки, пузырь) оставляем, если они ближе 3% от размера кадра
    main = lab == keep
    grown = ndimage.binary_dilation(main, iterations=max(4, alpha.shape[0] // 30))
    keep_mask = np.isin(lab, [i for i in range(1, n + 1) if (grown & (lab == i)).any()])
    out = alpha.copy()
    out[~keep_mask] = 0
    return out

def main(manifest_path: str, out_dir: str):
    src_dir = Path(manifest_path).parent
    out = Path(out_dir)
    sess = new_session("isnet-general-use")
    for item in json.loads(Path(manifest_path).read_text(encoding="utf-8")):
        im = Image.open(src_dir / item["file"]).convert("RGB")
        W, H = im.size
        cols, rows = item["cols"], item["rows"]
        names = item["names"]
        k = 0
        for r in range(rows):
            for c in range(cols):
                if k >= len(names):
                    break
                box = (round(c * W / cols), round(r * H / rows), round((c + 1) * W / cols), round((r + 1) * H / rows))
                cell = im.crop(box)
                cut = remove(cell, session=sess)
                a = np.array(cut)
                a[..., 3] = largest_component(a[..., 3])
                ys, xs = np.nonzero(a[..., 3] > 8)
                if len(xs) == 0:
                    print("пусто:", item["file"], names[k]); k += 1; continue
                pad = int(0.04 * max(cell.size))
                x0, x1 = max(0, xs.min() - pad), min(a.shape[1], xs.max() + pad)
                y0, y1 = max(0, ys.min() - pad), min(a.shape[0], ys.max() + pad)
                res = Image.fromarray(a).crop((x0, y0, x1, y1))
                dst = out / item["prefix"] / f"{names[k]}.png"
                dst.parent.mkdir(parents=True, exist_ok=True)
                res.save(dst, optimize=True)
                print(dst, res.size)
                k += 1

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])

#!/usr/bin/env python3
"""Нарезка листов из AI Studio / ElevenLabs на отдельные PNG с прозрачным фоном.

Использование:
  python3 scripts/design/cut_sheets.py design/sheets/manifest.json public/sprites

manifest.json — список листов:
  {"file": "poses_kind_2.jpg", "prefix": "kind", "names": ["bubbles", "cocoa", ...], "min_area": 0.01}
Фигуры находятся автоматически: фон убирается rembg (isnet-general-use) по всему листу,
затем связные области (с небольшим расширением, чтобы блёстки/пузыри прилипли к фигуре)
сортируются по строкам сверху вниз и слева направо и получают имена из names по порядку.
Мелочь меньше min_area от площади листа отбрасывается.
"""
import json, sys
from pathlib import Path

import numpy as np
from PIL import Image
from rembg import new_session, remove
from scipy import ndimage

def blobs(alpha: np.ndarray, min_area: float, grow: int):
    mask = alpha > 24
    merged = ndimage.binary_dilation(mask, iterations=grow)
    lab, n = ndimage.label(merged)
    H, W = alpha.shape
    out = []
    for i, sl in enumerate(ndimage.find_objects(lab), 1):
        region = (lab[sl] == i) & mask[sl]
        if region.sum() < min_area * H * W:
            continue
        out.append((sl, i))
    # сортировка по строкам: центр по Y, группируем, затем по X
    def cy(s): return (s[0][0].start + s[0][0].stop) / 2
    def cx(s): return (s[0][1].start + s[0][1].stop) / 2
    out.sort(key=cy)
    rows, row = [], []
    for b in out:
        if row and abs(cy(b) - cy(row[0])) > 0.25 * H:
            rows.append(sorted(row, key=cx)); row = []
        row.append(b)
    if row:
        rows.append(sorted(row, key=cx))
    return [b for r in rows for b in r], lab

def main(manifest_path: str, out_dir: str):
    src = Path(manifest_path).parent
    out = Path(out_dir)
    sess = new_session("isnet-general-use")
    report = {}
    for item in json.loads(Path(manifest_path).read_text(encoding="utf-8")):
        im = Image.open(src / item["file"]).convert("RGB")
        cut = np.array(remove(im, session=sess))
        if "grid" in item:  # равная сетка: для листов, где фигуры касаются друг друга
            cols, rows = item["grid"]; H, W = cut.shape[:2]
            lab = np.zeros((H, W), int); found = []
            for r in range(rows):
                for c in range(cols):
                    y0, y1, x0, x1 = r*H//rows, (r+1)*H//rows, c*W//cols, (c+1)*W//cols
                    k = len(found) + 1
                    lab[y0:y1, x0:x1] = k
                    ys, xs = np.nonzero(cut[y0:y1, x0:x1, 3] > 24)
                    found.append(((slice(y0+ys.min(), y0+ys.max()+1), slice(x0+xs.min(), x0+xs.max()+1)), k))
        else:
            found, lab = blobs(cut[..., 3], item.get("min_area", 0.008), max(6, im.size[0] // 200))
        names = item["names"]
        if len(found) != len(names):
            print(f"!! {item['file']}: найдено {len(found)} фигур, имён {len(names)} — проверь превью")
        pad = int(0.02 * max(im.size))
        for k, (sl, i) in enumerate(found):
            name = names[k] if k < len(names) else f"extra_{k+1}"
            ys, xs = sl
            y0, y1 = max(0, ys.start - pad), min(cut.shape[0], ys.stop + pad)
            x0, x1 = max(0, xs.start - pad), min(cut.shape[1], xs.stop + pad)
            piece = cut[y0:y1, x0:x1].copy()
            keep = lab[y0:y1, x0:x1] == i if "grid" in item else ndimage.binary_dilation(lab[y0:y1, x0:x1] == i, iterations=2)
            piece[..., 3] = np.where(keep, piece[..., 3], 0)
            dst = out / item["prefix"] / f"{name}.png"
            dst.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(piece).save(dst, optimize=True)
            report.setdefault(item["prefix"], []).append(name)
            print(dst, piece.shape[1], "x", piece.shape[0])
    (out / "index.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])

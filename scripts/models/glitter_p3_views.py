"""Нарезка разворота Блёстки (design/refs/glitter_turnaround_1123.png) на 4 вида для генерации p3.

python3 scripts/models/glitter_p3_views.py → design/refs/glitter_views/{front,threequarter,right,left,back}.png
Фон убирается заливкой от краёв (серый фон разворота почти однотонный), квадрат 1024, общий масштаб и общая
линия пола для всех видов (для multiview важно, чтобы рост и положение совпадали). left — зеркало профиля
(в развороте только правый бок). *_white.png — те же виды на белом (для листа и Meshy).
"""
import sys
from collections import deque
import numpy as np
from PIL import Image, ImageFilter

SRC = 'design/refs/glitter_turnaround_1123.png'
OUT = 'design/refs/glitter_views'
# x-диапазоны видов в развороте (между ними — чистый фон; хвост профиля и спина разделены по x=996)
VIEWS = {'front': (20, 392), 'threequarter': (392, 735), 'right': (735, 996), 'back': (996, 1360)}
SIZE, FILL = 1024, 0.86


def alpha_mask(rgb: np.ndarray) -> np.ndarray:
    """фон = связная с краями область, близкая к серому фону (заливка по 4-соседям)"""
    h, w, _ = rgb.shape
    bg = np.median(np.concatenate([rgb[:8].reshape(-1, 3), rgb[-8:].reshape(-1, 3)]), axis=0)
    near = np.abs(rgb.astype(int) - bg).sum(2) < 26
    seen = np.zeros((h, w), bool)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if near[y, x] and not seen[y, x]: seen[y, x] = True; q.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if near[y, x] and not seen[y, x]: seen[y, x] = True; q.append((y, x))
    while q:
        y, x = q.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and near[ny, nx] and not seen[ny, nx]:
                seen[ny, nx] = True; q.append((ny, nx))
    a = Image.fromarray(np.where(seen, 0, 255).astype(np.uint8))
    a = a.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.8))  # убрать серую кайму
    return np.asarray(a)


def main() -> None:
    im = np.asarray(Image.open(SRC).convert('RGB'))
    top, bottom = 108, 652  # общий рост всех видов (уши/бант … лапы)
    scale = SIZE * FILL / (bottom - top)
    floor = int(SIZE * (0.5 + FILL / 2))  # одна линия пола
    for name, (x0, x1) in VIEWS.items():
        crop = im[:, x0:x1]
        a = alpha_mask(crop)
        rows = np.where(a[top:bottom].max(1) > 0)[0]
        legs = a[bottom - 80:bottom]  # центр по лапам (хвост профиля не сдвигает фигуру)
        lx = np.where(legs.max(0) > 0)[0]
        cx = (lx.min() + lx.max()) / 2
        rgba = np.dstack([crop, a])
        img = Image.fromarray(rgba, 'RGBA')
        img = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
        canvas = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
        ox = round(SIZE / 2 - cx * scale)
        oy = round(floor - bottom * scale)
        canvas.alpha_composite(img, (max(ox, 0), oy) if ox >= 0 else (0, oy)) if ox >= 0 else canvas.alpha_composite(img.crop((-ox, 0, img.width, img.height)), (0, oy))
        canvas.save(f'{OUT}/{name}.png', optimize=True)
        white = Image.new('RGBA', (SIZE, SIZE), (255, 255, 255, 255)); white.alpha_composite(canvas)
        white.convert('RGB').save(f'{OUT}/{name}_white.png', optimize=True)
        print(name, 'rows', rows.min() + top, rows.max() + top, 'cx', cx)
        if name == 'right':
            m = canvas.transpose(Image.FLIP_LEFT_RIGHT); m.save(f'{OUT}/left.png', optimize=True)
            w2 = Image.new('RGBA', (SIZE, SIZE), (255, 255, 255, 255)); w2.alpha_composite(m)
            w2.convert('RGB').save(f'{OUT}/left_white.png', optimize=True)


if __name__ == '__main__':
    sys.exit(main())

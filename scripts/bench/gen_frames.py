#!/usr/bin/env python3
"""Синтетические кадры камеры с картой для проверки распознавания.

Usage: python3 gen_frames.py <card.png> <out_dir> [--n 12] [--size 640x480]
Пишет <out_dir>/<condition>_<i>.jpg и manifest.json (условие, углы, параметры).
Условия: перспектива/наклон до 60°, масштаб, поворот в плоскости, размытие, блик, тень, шум,
тусклый свет, перекрытие пальцем.
"""
import json, math, os, sys, random
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageEnhance

args = sys.argv[1:]
card_path, out = args[0], args[1]
N = int(args[args.index('--n') + 1]) if '--n' in args else 12
W, H = map(int, (args[args.index('--size') + 1] if '--size' in args else '640x480').split('x'))
os.makedirs(out, exist_ok=True)
rng = random.Random(42)
card = Image.open(card_path).convert('RGB')
# скругление углов как у настоящей карты
mask = Image.new('L', card.size, 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, card.width - 1, card.height - 1], radius=int(card.width * 0.04), fill=255)
F = 0.9 * W  # фокусное ~ 60° по горизонтали


def background():
    base = np.zeros((H, W, 3), np.float32)
    tone = np.array(rng.choice([(120, 90, 60), (200, 200, 195), (60, 60, 65), (170, 140, 110)]), np.float32)
    x = np.linspace(0, 1, W)[None, :]
    y = np.linspace(0, 1, H)[:, None]
    grain = np.sin((x * rng.uniform(20, 60) + np.sin(y * 6) * 0.5) * math.pi) * 10
    base[:] = tone
    base += grain[..., None] + np.random.default_rng(rng.randint(0, 999)).normal(0, 4, (H, W, 1))
    return Image.fromarray(base.clip(0, 255).astype(np.uint8))


def project(width_frac, tilt_deg, yaw_deg, roll_deg, cx, cy):
    """углы карты в пикселях кадра: карта шириной width_frac*W при фронтальном виде, наклон tilt вокруг X."""
    w = 1.0; h = card.height / card.width
    pts = np.array([[-w / 2, h / 2, 0], [w / 2, h / 2, 0], [w / 2, -h / 2, 0], [-w / 2, -h / 2, 0]])
    t, yw, r = map(math.radians, (tilt_deg, yaw_deg, roll_deg))
    Rz = np.array([[math.cos(r), -math.sin(r), 0], [math.sin(r), math.cos(r), 0], [0, 0, 1]])
    Rx = np.array([[1, 0, 0], [0, math.cos(t), -math.sin(t)], [0, math.sin(t), math.cos(t)]])
    Ry = np.array([[math.cos(yw), 0, math.sin(yw)], [0, 1, 0], [-math.sin(yw), 0, math.cos(yw)]])
    P = pts @ Rz.T @ Rx.T @ Ry.T
    Z = F / (width_frac * W)  # дистанция, при которой фронтальная ширина = width_frac*W
    P[:, 2] += Z
    u = cx + F * P[:, 0] / P[:, 2]
    v = cy - F * P[:, 1] / P[:, 2]
    return list(zip(u, v))


def persp_coeffs(dst, src):
    A, B = [], []
    for (x, y), (X, Y) in zip(dst, src):
        A.append([x, y, 1, 0, 0, 0, -X * x, -X * y]); B.append(X)
        A.append([0, 0, 0, x, y, 1, -Y * x, -Y * y]); B.append(Y)
    return np.linalg.solve(np.array(A, float), np.array(B, float)).tolist()


def compose(width_frac=0.6, tilt=0, yaw=0, roll=0):
    bg = background()
    cx = W / 2 + rng.uniform(-0.08, 0.08) * W
    cy = H / 2 + rng.uniform(-0.08, 0.08) * H
    dst = project(width_frac, tilt, yaw, roll, cx, cy)
    src = [(0, 0), (card.width, 0), (card.width, card.height), (0, card.height)]
    c = persp_coeffs(dst, src)
    warped = card.transform((W, H), Image.PERSPECTIVE, c, Image.BICUBIC)
    m = mask.transform((W, H), Image.PERSPECTIVE, c, Image.BICUBIC)
    bg.paste(warped, (0, 0), m)
    return bg, dst


def glare(img, dst):
    o = Image.new('L', (W, H), 0)
    d = ImageDraw.Draw(o)
    xs = [float(p[0]) for p in dst]; ys = [float(p[1]) for p in dst]
    gx = rng.uniform(min(xs), max(xs)); gy = rng.uniform(min(ys), max(ys))
    r = (max(xs) - min(xs)) * rng.uniform(0.15, 0.3)
    d.ellipse([gx - r * 1.6, gy - r, gx + r * 1.6, gy + r], fill=235)
    o = o.filter(ImageFilter.GaussianBlur(r * 0.35))
    return Image.composite(Image.new('RGB', (W, H), (255, 255, 250)), img, o)


def shadow(img):
    g = np.linspace(0, 1, W)[None, :] * np.ones((H, 1))
    k = 0.35 + 0.65 * (g > rng.uniform(0.35, 0.6))
    a = np.asarray(img).astype(np.float32) * np.where(k < 1, 0.4, 1.0)[..., None]
    return Image.fromarray(a.clip(0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1))


def finger(img, dst, frac):
    d = ImageDraw.Draw(img)
    xs = [float(p[0]) for p in dst]; ys = [float(p[1]) for p in dst]
    w = (max(xs) - min(xs)); h = (max(ys) - min(ys))
    side = rng.choice(['bottom', 'right', 'left'])
    fw = w * 0.16
    if side == 'bottom':
        x = rng.uniform(min(xs) + w * 0.2, max(xs) - w * 0.2)
        d.rounded_rectangle([x - fw / 2, max(ys) - h * frac * 2.2, x + fw / 2, H + 20], radius=fw / 2, fill=(224, 172, 140))
    else:
        y = rng.uniform(min(ys) + h * 0.2, max(ys) - h * 0.2)
        if side == 'right':
            d.rounded_rectangle([max(xs) - w * frac * 1.4, y - fw / 2, W + 20, y + fw / 2], radius=fw / 2, fill=(224, 172, 140))
        else:
            d.rounded_rectangle([-20, y - fw / 2, min(xs) + w * frac * 1.4, y + fw / 2], radius=fw / 2, fill=(224, 172, 140))
    return img.filter(ImageFilter.GaussianBlur(0.8))


CONDS = {
    'base_front': lambda: compose(0.6),
    'tilt_30': lambda: compose(0.6, tilt=30),
    'tilt_45': lambda: compose(0.6, tilt=45),
    'tilt_60': lambda: compose(0.6, tilt=60),
    'tilt_45_yaw_30': lambda: compose(0.6, tilt=45, yaw=30),
    'scale_small_25': lambda: compose(0.25, tilt=30),
    'scale_large_90': lambda: compose(0.9, tilt=20),
    'roll_45': lambda: compose(0.55, tilt=30, roll=45),
    'blur_2px': lambda: (lambda r: (r[0].filter(ImageFilter.GaussianBlur(2)), r[1]))(compose(0.6, tilt=35)),
    'blur_4px': lambda: (lambda r: (r[0].filter(ImageFilter.GaussianBlur(4)), r[1]))(compose(0.6, tilt=35)),
    'glare': lambda: (lambda r: (glare(r[0], r[1]), r[1]))(compose(0.6, tilt=35)),
    'shadow': lambda: (lambda r: (shadow(r[0]), r[1]))(compose(0.6, tilt=35)),
    'noise_15': lambda: (lambda r: (Image.fromarray((np.asarray(r[0]).astype(np.float32) + np.random.default_rng(rng.randint(0, 9999)).normal(0, 15, (H, W, 3))).clip(0, 255).astype(np.uint8)), r[1]))(compose(0.6, tilt=35)),
    'dim_light': lambda: (lambda r: (ImageEnhance.Brightness(r[0]).enhance(0.35), r[1]))(compose(0.6, tilt=35)),
    'finger_15': lambda: (lambda r: (finger(r[0], r[1], 0.15), r[1]))(compose(0.6, tilt=35)),
    'finger_30': lambda: (lambda r: (finger(r[0], r[1], 0.3), r[1]))(compose(0.6, tilt=35)),
}

manifest = []
for name, fn in CONDS.items():
    for i in range(N):
        img, dst = fn()
        f = f'{name}_{i:02d}.jpg'
        img.save(os.path.join(out, f), quality=88)
        manifest.append({'file': f, 'cond': name, 'corners': [[round(x, 1), round(y, 1)] for x, y in dst]})
json.dump({'width': W, 'height': H, 'frames': manifest}, open(os.path.join(out, 'manifest.json'), 'w'), ensure_ascii=False)
print(f'{len(manifest)} кадров → {out}')

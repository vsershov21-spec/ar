#!/usr/bin/env python3
"""Синтетическое видео камеры с картой для стенда энергобюджета (scripts/bench/energy.mjs).

Usage: python3 scripts/bench/gen_card_video.py [out_dir=/tmp/ebench]
Пишет table.png (стол без карты, кадр 1280×720), still.y4m (телефон на столе: кадр стоит, шум сенсора) и move.y4m (медленное движение) 1280×720, 30 к/с.
Карта — public/targets/card.png в честной перспективе (угол обзора как у детектора), чтобы трекер её посадил.
"""
import math, os, re, subprocess, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
out = sys.argv[1] if len(sys.argv) > 1 else '/tmp/ebench'
os.makedirs(out, exist_ok=True)
hf = float(re.search(r'DEFAULT_HFOV = ([\d.]+)', open(os.path.join(root, 'src/tracker/card/detector.ts')).read()).group(1))
W, H, FW, FH, ox, oy = 1400, 800, 1280, 720, 60, 40
f = FW / 2 / math.tan(math.radians(hf) / 2)
cx, cy = ox + FW / 2, oy + FH / 2
A = 85.6 / 53.98
tilt = math.radians(40)


def proj(X, Y):
    x = X + 0.15; y = Y * math.cos(tilt); z = 3.0 + Y * math.sin(tilt)
    return (cx + f * x / z, cy - f * y / z)


dst = [proj(*p) for p in [(-0.5, 0.5 / A), (0.5, 0.5 / A), (0.5, -0.5 / A), (-0.5, -0.5 / A)]]
rng = np.random.default_rng(1)
yy = np.linspace(0, 1, H)[:, None]; xx = np.linspace(0, 1, W)[None, :]
bg = np.zeros((H, W, 3), np.float32)
bg[..., 0] = 120 + 25 * np.sin(xx * 40 + yy * 3); bg[..., 1] = 95 + 18 * np.sin(xx * 40 + yy * 3); bg[..., 2] = 65
bg += rng.normal(0, 5, (H, W, 1))
img = Image.fromarray(np.clip(bg, 0, 255).astype(np.uint8))
# стол без карты (стенд QA: «карта пропала» — камера видит тот же стол)
img.crop((ox, oy, ox + FW, oy + FH)).save(os.path.join(out, 'table.png'))
card = Image.open(os.path.join(root, 'public/targets/card.png')).convert('RGB').resize((856, 540))
mask = Image.new('L', card.size, 0); ImageDraw.Draw(mask).rounded_rectangle([0, 0, 855, 539], radius=30, fill=255)
src4 = [(0, 0), (856, 0), (856, 540), (0, 540)]
m = []
for p1, p2 in zip(dst, src4):
    m.append([p1[0], p1[1], 1, 0, 0, 0, -p2[0] * p1[0], -p2[0] * p1[1]])
    m.append([0, 0, 0, p1[0], p1[1], 1, -p2[1] * p1[0], -p2[1] * p1[1]])
c = tuple(np.linalg.solve(np.array(m, float), np.array(src4, float).reshape(8)))
cw = card.transform((W, H), Image.PERSPECTIVE, c, Image.BICUBIC)
mw = mask.transform((W, H), Image.PERSPECTIVE, c, Image.BICUBIC)
sh = Image.new('L', (W, H), 0); ImageDraw.Draw(sh).polygon([(p[0] + 8, p[1] + 10) for p in dst], fill=80); sh = sh.filter(ImageFilter.GaussianBlur(8))
img = Image.composite(Image.new('RGB', (W, H), (30, 20, 10)), img, sh)
img = Image.composite(cw, img, mw)
scene = os.path.join(out, 'scene.png')
img.save(scene)
ff = ['ffmpeg', '-loglevel', 'error', '-y', '-loop', '1', '-i', scene, '-r', '30']
subprocess.run(ff + ['-t', '3', '-vf', 'crop=1280:720:60:40,noise=alls=5:allf=t,format=yuv420p', os.path.join(out, 'still.y4m')], check=True)
subprocess.run(ff + ['-t', '4', '-vf', "crop=1280:720:'60+40*sin(t*3.14159)':'40+25*sin(t*1.5708)',noise=alls=5:allf=t,format=yuv420p", os.path.join(out, 'move.y4m')], check=True)
print('ok:', out)

"""Лист Блёстки v5g: слёзы (грусть) и умиление (caring; реф — purr) «реф | v5f | v5g» крупно + 3 кадра капли слезы.
Сжатая модель, vite на FACE_PORT (как tools/glitter-v5f-sheet.py):

    node scripts/build/model-opt.mjs public/models/v2/glitter_v5.glb --out public/models/v2/zz_v5f_opt.glb   # не коммитить
    # кадры v5f — кодом лица v5f (git show 2d71637:src/character/v5Face.ts), затем текущим:
    python3 tools/glitter-v5g-sheet.py shoot /tmp/v5g v5f ; python3 tools/glitter-v5g-sheet.py shoot /tmp/v5g v5g
    python3 tools/glitter-v5g-sheet.py sheet /tmp/v5g /home/claude/glitter_v5g_emote.jpg
9 эмоций «реф | v5g» — tools/glitter-v5f-sheet.py shoot/sheet (подпись v5f → v5g: LABEL=v5g).
"""
import importlib.util
import os
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

_sp = importlib.util.spec_from_file_location('v5f', os.path.join(os.path.dirname(__file__), 'glitter-v5f-sheet.py'))
V = importlib.util.module_from_spec(_sp); _sp.loader.exec_module(V)
M = V.M
ROWS = [('sad', 'sad', 'слёзы (грусть)'), ('caring', 'purr', 'умиление (реф — purr)')]


def shot(out, st, t=1.6):
    q = f'p=glitter&m={M}&s=neutral,{st}&cols=2&tile=900&dist=13&dy=-0.12&yaw=-14&bg=none&t={t}'
    env = dict(os.environ, FACE_PORT=os.environ.get('FACE_PORT', '4396'), PAGE='emo-preview', ALPHA='1')
    subprocess.run(['node', 'tools/face-shot.mjs', out + '.raw.png', q], env=env, check=True, capture_output=True)
    Image.open(out + '.raw.png').convert('RGBA').crop((900, 0, 1800, 900)).save(out)


def shoot(D, tag):
    os.makedirs(D, exist_ok=True)
    for st, _, _ in ROWS:
        shot(f'{D}/{tag}_{st}.png', st)
    if tag == 'v5g':
        for k, t in enumerate((0.9, 1.7, 2.5)):
            shot(f'{D}/tear{k}.png', 'sad', t)


def sheet(D, OUT):
    F = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 20)
    FB = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 24)
    T = 460

    def lab(t, s):
        t = t.copy(); d = ImageDraw.Draw(t)
        d.rectangle((0, t.height - 28, t.width, t.height), fill=(255, 255, 255)); d.text((6, t.height - 26), s, fill=(20, 20, 30), font=F)
        return t
    out = Image.new('RGB', (3 * T + 24, 3 * (T + 40)), V.BG)
    for r, (st, rf, n) in enumerate(ROWS):
        ImageDraw.Draw(out).text((8, r * (T + 40) + 6), n, fill=(20, 20, 30), font=FB)
        tiles = [(V.crop(V.ref_img(rf), T), 'реф design/cut'), (V.crop(Image.open(f'{D}/v5f_{st}.png').convert('RGBA'), T), 'v5f'),
                 (V.crop(Image.open(f'{D}/v5g_{st}.png').convert('RGBA'), T), 'v5g')]
        for k, (im, s) in enumerate(tiles):
            out.paste(lab(im, s), (k * (T + 12), r * (T + 40) + 40))
    ImageDraw.Draw(out).text((8, 2 * (T + 40) + 6), 'капля слезы: нарастает у века → катится по щеке → гаснет (v5g)', fill=(20, 20, 30), font=FB)
    for k in range(3):
        im = V.crop(Image.open(f'{D}/tear{k}.png').convert('RGBA'), T)
        out.paste(lab(im, f'{["0.9", "1.7", "2.5"][k]} с'), (k * (T + 12), 2 * (T + 40) + 40))
    out.save(OUT, quality=88)
    print(OUT, out.size)


if __name__ == '__main__':
    if sys.argv[1] == 'shoot':
        shoot(sys.argv[2], sys.argv[3])
    else:
        sheet(sys.argv[2], sys.argv[3])

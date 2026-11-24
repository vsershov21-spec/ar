"""Лист «реф | p1 (пилот) | p3 (новая)» для Блёстки p3 (design/refs/glitter_turnaround_1123.png → Meshy → glitter_p3.py).

    npx vite --port 4291 &
    D=/tmp/p3/sheet; export PORT=4291 FACE_PORT=4291
    for M in /models/v2/glitter_p1.glb:o /models/v2/glitter_p3.glb:n; do m=${M%%:*}; p=${M##*:}
      Q="v=front,tq,side,back,face&w=300&h=440&face=shader&m=$m" node tools/persona-shot.mjs $D ${p}v glitter
      PAGE=emo-preview node tools/face-shot.mjs $D/${p}f.png "p=glitter&m=$m&face=shader&s=neutral,blink:0.075,talk:A,talk:O,talk:U&cols=5&tile=300&dist=4.6"
      for c in "dance_glitter&ct=1.3" "sit&ct=1.6" "sleep_loop&ct=1.0"; do
        Q="v=tq&w=300&h=440&face=shader&m=$m&clip=$c" node tools/persona-shot.mjs $D ${p}a_${c%%&*} glitter; done
    done
    python3 tools/glitter-p3-sheet.py $D docs/qa/glitter/glitter_p3_sheet.jpg
"""
import os, sys
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
T, H = 300, 440
BG = (236, 236, 238)
F = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 17)
FB = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 22)


def ref_views():
    """4 вида и лицо из разворота — те же кропы, что для генерации (design/refs/glitter_views, scripts/models/glitter_p3_views.py)"""
    out = []
    for n in ('front', 'threequarter', 'right', 'back'):
        im = Image.open(os.path.join(ROOT, f'design/refs/glitter_views/{n}_white.png')).convert('RGB')
        im = im.crop((112, 60, 912, 1000)).resize((T, round(T * 940 / 800)))
        t = Image.new('RGB', (T, H), BG); t.paste(im, (0, (H - im.height) // 2)); out.append(t)
    im = Image.open(os.path.join(ROOT, 'design/refs/glitter_turnaround_1123.png')).convert('RGB')
    face = im.crop((95, 95, 395, 395)).resize((T, T))
    t = Image.new('RGB', (T, H), BG); t.paste(face, (0, 40)); out.append(t)
    return out


def ref_face_states():
    im = Image.open(os.path.join(ROOT, 'design/refs/glitter_turnaround_1123.png')).convert('RGB')
    return [im.crop((95, 95, 395, 395)).resize((T, T))]


def tiles(path, n, w=T, h=H):
    im = Image.open(path).convert('RGB')
    return [im.crop((i * w, 0, (i + 1) * w, h)) for i in range(n)]


def lab(t, s):
    t = t.copy(); d = ImageDraw.Draw(t)
    d.rectangle((0, t.height - 24, t.width, t.height), fill=(255, 255, 255)); d.text((6, t.height - 22), s, fill=(20, 20, 30), font=F)
    return t


def row(title, ts, ncol=6):
    h = max(t.height for t in ts)
    out = Image.new('RGB', (ncol * T, h + 32), BG)
    ImageDraw.Draw(out).text((8, 4), title, fill=(20, 20, 30), font=FB)
    for i, t in enumerate(ts):
        out.paste(t, (i * T, 32))
    return out


def main():
    d, out = sys.argv[1:3]
    V = ['анфас', '3/4', 'профиль', 'спина', 'лицо']
    S = ['покой', 'моргание', '«а»', '«о»', '«у»']
    A = [('dance_glitter', 'танец'), ('sit', 'сидит'), ('sleep_loop', 'лежит (сон)')]
    rows = [row('реф: design/refs/glitter_turnaround_1123.png (разворот продакта 23.11)', [lab(t, v) for t, v in zip(ref_views(), V)]),
            row('p1 — пилот сейчас (glitter_p1.glb, рот шейдером)', [lab(t, v) for t, v in zip(tiles(f'{d}/ov_glitter.png', 5), V)]),
            row('p3 — новая (Tripo по 4 видам, части → скелет, глаза и рот p1; ?models=p3)', [lab(t, v) for t, v in zip(tiles(f'{d}/nv_glitter.png', 5), V)]),
            row('лицо p1: покой, моргание, рот а/о/у', [lab(t, s) for t, s in zip(tiles(f'{d}/of.png', 5, T, T), S)]),
            row('лицо p3: покой, моргание, рот а/о/у', [lab(t, s) for t, s in zip(tiles(f'{d}/nf.png', 5, T, T), S)])]
    an = []
    for c, nm in A:
        for p, who in (('o', 'p1'), ('n', 'p3')):
            f = f'{d}/{p}a_{c}_glitter.png'
            if os.path.exists(f):
                an.append(lab(Image.open(f).convert('RGB').crop((0, 0, T, H)), f'{nm} · {who}'))
    rows.append(row('анимации (3/4): p1 | p3', an))
    W = max(r.width for r in rows)
    sheet = Image.new('RGB', (W, sum(r.height for r in rows)), BG)
    y = 0
    for r in rows:
        sheet.paste(r, (0, y)); y += r.height
    sheet.save(out, quality=85)
    print(out, sheet.size)


if __name__ == '__main__':
    main()

"""Лист Блёстки p4 «реф | Tripo-оригинал | p4» (4 вида + лицо), лицо p4 крупно (покой, моргание, виземы), эмоции p4
рядом с рефами design/cut/glitter/face, лицо Хулигана (как мерило мимики), кадры анимаций.

    npx vite --port 4391 &
    D=/tmp/p4/sheet; export PORT=4391 FACE_PORT=4391
    /tmp/bpyenv/bin/python tools/glitter-p4-tripo-views.py -- design/models/glitter_tripo_rigged.glb $D
    Q="v=front,tq,side,back,face&w=300&h=440&face=shader&models=p4" node tools/persona-shot.mjs $D nv glitter
    PAGE=emo-preview node tools/face-shot.mjs $D/nf.png "p=glitter&models=p4&face=shader&s=neutral,blink:0.075,talk:A,talk:E,talk:O,talk:U,talk:M&cols=7&tile=300&dist=6"
    PAGE=emo-preview node tools/face-shot.mjs $D/ne.png "p=glitter&models=p4&face=shader&s=happy,laugh,surprised,sad,shy,offended,wink&cols=7&tile=300&dist=6"
    PAGE=emo-preview node tools/face-shot.mjs $D/hf.png "p=hooligan&face=shader&s=neutral,blink:0.075,talk:A,talk:O,happy,sad&cols=6&tile=300&dist=6"
    for c in "idle_glitter_alive&ct=2.0" "dance_glitter&ct=1.3" "sit&ct=1.6" "wave&ct=1.0"; do
      Q="v=tq&w=300&h=440&face=shader&models=p4&clip=$c" node tools/persona-shot.mjs $D na_${c%%&*} glitter; done
    # кровать: кадр пилота ?flow=home&zone=bedroom&bed=sleep&models=p4 → $D/bed.png (по желанию)
    python3 tools/glitter-p4-sheet.py $D docs/qa/glitter/glitter_p4_sheet.jpg
"""
import os, sys
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
T, H = 300, 440
BG = (236, 236, 238)
F = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 17)
FB = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 22)


def ref_views():
    out = []
    for n in ('front', 'threequarter', 'right', 'back'):
        im = Image.open(os.path.join(ROOT, f'design/refs/glitter_views/{n}_white.png')).convert('RGB')
        im = im.crop((112, 60, 912, 1000)).resize((T, round(T * 940 / 800)))
        t = Image.new('RGB', (T, H), BG); t.paste(im, (0, (H - im.height) // 2)); out.append(t)
    im = Image.open(os.path.join(ROOT, 'design/refs/glitter_turnaround_1123.png')).convert('RGB')
    t = Image.new('RGB', (T, H), BG); t.paste(im.crop((95, 95, 395, 395)).resize((T, T)), (0, 40)); out.append(t)
    return out


def tiles(path, n, w=T, h=H):
    if not os.path.exists(path):
        return [Image.new('RGB', (w, h), BG)] * n
    im = Image.open(path).convert('RGB')
    return [im.crop((i * w, 0, (i + 1) * w, h)) for i in range(n)]


def fit(path, w=T, h=T):
    t = Image.new('RGB', (w, h), BG)
    if os.path.exists(path):
        im = Image.open(path).convert('RGBA'); im.thumbnail((w, h))
        t.paste(im, ((w - im.width) // 2, (h - im.height) // 2), im)
    return t


def lab(t, s):
    t = t.copy(); d = ImageDraw.Draw(t)
    d.rectangle((0, t.height - 24, t.width, t.height), fill=(255, 255, 255)); d.text((6, t.height - 22), s, fill=(20, 20, 30), font=F)
    return t


def row(title, ts, ncol=7):
    h = max(t.height for t in ts)
    out = Image.new('RGB', (ncol * T, h + 32), BG)
    ImageDraw.Draw(out).text((8, 4), title, fill=(20, 20, 30), font=FB)
    for i, t in enumerate(ts):
        out.paste(t, (i * T, 32))
    return out


def main():
    d, out = sys.argv[1:3]
    V = ['анфас', '3/4', 'профиль', 'спина', 'лицо']
    tripo = [Image.open(f'{d}/tripo_{n}.png').convert('RGB') if os.path.exists(f'{d}/tripo_{n}.png') else Image.new('RGB', (T, H), BG)
             for n in ('front', 'tq', 'side', 'back', 'face')]
    S = ['покой', 'моргание', '«а»', '«э»', '«о»', '«у»', '«м»']
    E = ['happy', 'laugh', 'surprised', 'sad', 'shy', 'offended', 'wink']
    A = [('idle_glitter_alive', 'покой'), ('dance_glitter', 'танец'), ('sit', 'сидит'), ('wave', 'машет')]
    rows = [row('реф: design/refs/glitter_turnaround_1123.png (разворот продакта)', [lab(t, v) for t, v in zip(ref_views(), V)]),
            row('Tripo-оригинал: design/models/glitter_tripo_rigged.glb (Cycles)', [lab(t, v) for t, v in zip(tripo, V)]),
            row('p4 в приложении (?models=p4, glitter_p4.glb, лицо шейдером)', [lab(t, v) for t, v in zip(tiles(f'{d}/nv_glitter.png', 5), V)]),
            row('лицо p4: покой, моргание, виземы', [lab(t, s) for t, s in zip(tiles(f'{d}/nf.png', 7, T, T), S)]),
            row('эмоции: реф design/cut/glitter/face', [lab(fit(os.path.join(ROOT, f'design/cut/glitter/face/{e}.png')), e) for e in E]),
            row('эмоции p4', [lab(t, s) for t, s in zip(tiles(f'{d}/ne.png', 7, T, T), E)]),
            row('для сравнения — Хулиган (p1, пилот): покой, моргание, «а», «о», радость, грусть',
                [lab(t, s) for t, s in zip(tiles(f'{d}/hf.png', 6, T, T), ['покой', 'моргание', '«а»', '«о»', 'happy', 'sad'])])]
    an = [lab(Image.open(f'{d}/na_{c}_glitter.png').convert('RGB').crop((0, 0, T, H)), nm) for c, nm in A if os.path.exists(f'{d}/na_{c}_glitter.png')]
    if os.path.exists(f'{d}/bed.png'):
        an.append(lab(fit(f'{d}/bed.png', T, H), 'кровать (пилот)'))
    rows.append(row('анимации p4 (3/4)', an))
    W = max(r.width for r in rows)
    sheet = Image.new('RGB', (W, sum(r.height for r in rows)), BG)
    y = 0
    for r in rows:
        sheet.paste(r, (0, y)); y += r.height
    sheet.save(out, quality=85)
    print(out, sheet.size)


if __name__ == '__main__':
    main()

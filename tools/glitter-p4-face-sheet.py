"""Лист лица Блёстки p4 v3: покой, моргание, виземы; эмоции рядом с рефами design/cut/glitter/face; Хулиган и Добряк
(мерило «кошка, а не заяц»); кадры анимаций (покой, танец, сидит, машет; кровать — e2e:pilot и аудит анимаций).

    npx vite --port 4391 &
    D=/tmp/p4v3/face; export PORT=4391 FACE_PORT=4391
    PAGE=emo-preview node tools/face-shot.mjs $D/nf.png "p=glitter&models=p4&face=shader&s=neutral,blink:0.075,talk:A,talk:E,talk:O,talk:U,talk:M&cols=7&tile=300&dist=6"
    PAGE=emo-preview node tools/face-shot.mjs $D/ne.png "p=glitter&models=p4&face=shader&s=neutral,laugh,surprised,sad,shy,offended,wink&cols=7&tile=300&dist=6"
    PAGE=emo-preview node tools/face-shot.mjs $D/hf.png "p=hooligan&face=shader&s=neutral,talk:A,happy&cols=3&tile=300&dist=6"
    PAGE=emo-preview node tools/face-shot.mjs $D/kf.png "p=kind&face=shader&s=neutral,talk:A,happy&cols=3&tile=300&dist=6"
    for c in "idle_glitter_alive&ct=2.0" "dance_glitter&ct=1.3" "sit&ct=1.6" "wave&ct=1.0"; do
      Q="v=tq&w=300&h=440&face=shader&models=p4&clip=$c" node tools/persona-shot.mjs $D na_${c%%&*} glitter; done
    python3 tools/glitter-p4-face-sheet.py $D out.jpg
"""
import os, sys
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
T = 300
BG = (236, 236, 238)
F = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 17)
FB = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 22)


def tiles(path, n, w=T, h=T):
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
    S = ['покой', 'моргание', '«а»', '«э»', '«о»', '«у»', '«м»']
    E = ['neutral', 'laugh', 'surprised', 'sad', 'shy', 'offended', 'wink']
    A = [('idle_glitter_alive', 'покой'), ('dance_glitter', 'танец'), ('sit', 'сидит'), ('wave', 'машет')]
    rows = [row('Блёстка p4 v3: покой, моргание, виземы (?models=p4, лицо шейдером)', [lab(t, s) for t, s in zip(tiles(f'{d}/nf.png', 7), S)]),
            row('эмоции: реф design/cut/glitter/face', [lab(fit(os.path.join(ROOT, f'design/cut/glitter/face/{e}.png')), e) for e in E]),
            row('эмоции p4 v3', [lab(t, s) for t, s in zip(tiles(f'{d}/ne.png', 7), E)]),
            row('мерило «кошка»: Хулиган и Добряк (покой, «а», радость)',
                [lab(t, 'Хулиган ' + s) for t, s in zip(tiles(f'{d}/hf.png', 3), ['покой', '«а»', 'happy'])] +
                [lab(t, 'Добряк ' + s) for t, s in zip(tiles(f'{d}/kf.png', 3), ['покой', '«а»', 'happy'])])]
    an = [lab(Image.open(f'{d}/na_{c}_glitter.png').convert('RGB').crop((0, 0, T, 440)), nm) for c, nm in A if os.path.exists(f'{d}/na_{c}_glitter.png')]
    if an:
        rows.append(row('анимации p4 v3 (3/4)', an))
    W = max(r.width for r in rows)
    sheet = Image.new('RGB', (W, sum(r.height for r in rows)), BG)
    y = 0
    for r in rows:
        sheet.paste(r, (0, y)); y += r.height
    sheet.save(out, quality=86)
    print(out, sheet.size)


if __name__ == '__main__':
    main()

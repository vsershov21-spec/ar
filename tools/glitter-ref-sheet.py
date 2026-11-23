"""Лист «реф vs было vs стало» для Блёстки по развороту продакта 23.11 (design/refs/glitter_turnaround_1123.png).

Второй проход (24.11, scripts/models/glitter_ref2.py: пачка в три яруса, длинный хвост) — --pass2: строки видов,
спина и профиль крупно (реф | было | стало), кадры клипов «сидит» и «танец» (было | стало):
    Q="v=backc,sider&w=450&h=600&face=shader&m=/_tmp/p1o.glb" … ob   (стало — nb, без m= или m=/models/v2/glitter_p1.glb)
    Q="v=front,side,back34&w=300&h=440&m=…&clip=sit&ct=1.6" … os / ns;  clip=dance_glitter&ct=1.3 … od / nd
    python3 tools/glitter-ref-sheet.py <dir> out.jpg --pass2

    npx vite --port 4191 &
    # было: копии прежних GLB в public/_tmp/p1o.glb, p2o.glb (не коммитить)
    PORT=4191 Q="v=front,tq,side,back,face&w=300&h=440&face=shader&m=/_tmp/p1o.glb" node tools/persona-shot.mjs <dir> o1 glitter
    PORT=4191 Q="v=front,tq,side,back,face&w=300&h=440&face=shader" node tools/persona-shot.mjs <dir> n1 glitter
    PORT=4191 Q="v=front,tq,side,back,face&w=300&h=440&face=morph"  node tools/persona-shot.mjs <dir> n2 glitter
    FACE_PORT=4191 PAGE=emo-preview node tools/face-shot.mjs <dir>/fo2.png "p=glitter&m=/_tmp/p2o.glb&face=morph&s=neutral,blink:0.075,vis:D,vis:E,vis:F,happy,laugh&cols=7&tile=300&dist=4.6"
    … fn2 (face=morph), fo1 / fn1 (face=shader, s=neutral,blink:0.075,talk:A,talk:O,talk:U,happy,laugh)
    python3 tools/glitter-ref-sheet.py <dir> out.jpg
"""
import os, sys
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
T, H = 300, 440
BG = (236, 236, 238)
F = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 17)
FB = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 22)


def ref_views():
    im = Image.open(os.path.join(ROOT, 'design/refs/glitter_turnaround_1123.png')).convert('RGB')
    xs = [(30, 410), (375, 755), (720, 1030), (985, 1360)]
    out = []
    for x0, x1 in xs:
        c = im.crop((x0, 90, x1, 660))
        c.thumbnail((T, H))
        t = Image.new('RGB', (T, H), BG); t.paste(c, ((T - c.width) // 2, (H - c.height) // 2)); out.append(t)
    face = im.crop((95, 95, 395, 395)).resize((T, T))
    t = Image.new('RGB', (T, H), BG); t.paste(face, (0, 40)); out.append(t)
    return out


def tiles(path, n, w=T, h=H):
    im = Image.open(path).convert('RGB')
    return [im.crop((i * w, 0, (i + 1) * w, h)) for i in range(n)]


def lab(t, s):
    t = t.copy(); d = ImageDraw.Draw(t)
    d.rectangle((0, t.height - 24, t.width, t.height), fill=(255, 255, 255)); d.text((6, t.height - 22), s, fill=(20, 20, 30), font=F)
    return t


def row(title, ts):
    h = max(t.height for t in ts)
    out = Image.new('RGB', (max(7, len(ts)) * T, h + 32), BG)
    ImageDraw.Draw(out).text((8, 4), title, fill=(20, 20, 30), font=FB)
    for i, t in enumerate(ts):
        out.paste(t, (i * T, 32))
    return out


def ref_big():
    im = Image.open(os.path.join(ROOT, 'design/refs/glitter_turnaround_1123.png')).convert('RGB')
    out = []
    for x0, x1 in ((985, 1360), (720, 1030)):
        c = im.crop((x0, 90, x1, 660)); c.thumbnail((450, 600))
        t = Image.new('RGB', (450, 600), BG); t.paste(c, ((450 - c.width) // 2, (600 - c.height) // 2)); out.append(t)
    return out


def pass2(d, out):
    V = ['анфас', '3/4', 'профиль', 'спина', 'лицо']
    rows = [row('реф: design/refs/glitter_turnaround_1123.png', [lab(t, v) for t, v in zip(ref_views(), V)]),
            row('было: glitter_p1 ece63b2 (пилот, рот шейдером)', [lab(t, v) for t, v in zip(tiles(f'{d}/o1_glitter.png', 5), V)]),
            row('стало: glitter_p1 (пачка в 3 яруса, длинный хвост)', [lab(t, v) for t, v in zip(tiles(f'{d}/n1_glitter.png', 5), V)]),
            row('стало: glitter_p2 (lab, риг лица морфами)', [lab(t, v) for t, v in zip(tiles(f'{d}/n2_glitter.png', 5), V)])]
    rb = ref_big(); ob = tiles(f'{d}/ob_glitter.png', 2, 450, 600); nb = tiles(f'{d}/nb_glitter.png', 2, 450, 600)
    big = [lab(rb[0], 'реф: спина'), lab(ob[0], 'было: спина'), lab(nb[0], 'стало: спина')]
    big2 = [lab(rb[1], 'реф: профиль'), lab(ob[1], 'было: профиль справа'), lab(nb[1], 'стало: профиль справа')]
    for title, ts in (('спина крупно: капюшон, хвост, пачка сзади', big), ('профиль крупно: хвост', big2)):
        r = Image.new('RGB', (1500, 600 + 32), BG); ImageDraw.Draw(r).text((8, 4), title, fill=(20, 20, 30), font=FB)
        for i, t in enumerate(ts):
            r.paste(t, (i * 500, 32))
        rows.append(r)
    A = ['анфас', 'профиль', 'сзади 3/4']
    for nm, k in (('сидит (sit, 1.6 с)', 's'), ('танец Блёстки (dance_glitter, 1.3 с)', 'd')):
        ts = [lab(t, 'было: ' + a) for t, a in zip(tiles(f'{d}/o{k}_glitter.png', 3), A)] + \
             [lab(t, 'стало: ' + a) for t, a in zip(tiles(f'{d}/n{k}_glitter.png', 3), A)]
        rows.append(row(nm + ': было | стало', ts))
    W = max(r.width for r in rows)
    sheet = Image.new('RGB', (W, sum(r.height for r in rows)), BG)
    y = 0
    for r in rows:
        sheet.paste(r, (0, y)); y += r.height
    sheet.save(out, quality=85)
    print(out, sheet.size)


def main():
    d, out = sys.argv[1:3]
    if '--pass2' in sys.argv:
        return pass2(d, out)
    V = ['анфас', '3/4', 'профиль', 'спина', 'лицо']
    rows = [row('реф: design/refs/glitter_turnaround_1123.png (разворот продакта 23.11)', [lab(t, v) for t, v in zip(ref_views(), V)]),
            row('было: glitter_p1 до правок (пилот, рот шейдером)', [lab(t, v) for t, v in zip(tiles(f'{d}/o1_glitter.png', 5), V)]),
            row('стало: glitter_p1 (пилот /mvp, рот шейдером)', [lab(t, v) for t, v in zip(tiles(f'{d}/n1_glitter.png', 5), V)]),
            row('стало: glitter_p2 (lab, риг лица морфами)', [lab(t, v) for t, v in zip(tiles(f'{d}/n2_glitter.png', 5), V)])]
    S2 = ['покой', 'моргание', '«а»', '«о»', '«у»', 'улыбка', 'смех']
    S1 = ['покой', 'моргание', '«а»', '«о»', '«у»', 'улыбка', 'смех']
    rows += [row('лицо p2 (морфы) — было', [lab(t, s) for t, s in zip(tiles(f'{d}/fo2.png', 7, T, T), S2)]),
             row('лицо p2 (морфы) — стало', [lab(t, s) for t, s in zip(tiles(f'{d}/fn2.png', 7, T, T), S2)]),
             row('лицо p1 (шейдер, пилот) — было', [lab(t, s) for t, s in zip(tiles(f'{d}/fo1.png', 7, T, T), S1)]),
             row('лицо p1 (шейдер, пилот) — стало', [lab(t, s) for t, s in zip(tiles(f'{d}/fn1.png', 7, T, T), S1)])]
    W = max(r.width for r in rows)
    sheet = Image.new('RGB', (W, sum(r.height for r in rows)), BG)
    y = 0
    for r in rows:
        sheet.paste(r, (0, y)); y += r.height
    sheet.save(out, quality=85)
    print(out, sheet.size)


if __name__ == '__main__':
    main()

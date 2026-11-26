"""Листы согласования Блёстки v5 (модель Tripo «как есть», scripts/models/build_glitter_v5.sh):
  vs — «Tripo-вьюер (рендер исходника, Blender Cycles) | в приложении (рантайм, свет приложения)»: анфас, 3/4, профиль,
       спина и лицо крупно (в приложении — поза покоя idle, у исходника — поза привязки Tripo);
  face — мимика (покой, моргание, виземы, эмоции) и кадры анимаций (+ кровать, если есть снимки).

    /tmp/bpyenv/bin/python tools/glitter-p4-tripo-views.py -- design/models/glitter_v5_rigged.glb $D/tripo
    npx vite --port 4391 &  export PORT=4391 FACE_PORT=4391
    Q="models=v5&v=front,tq,side,back,face&w=300&h=440" node tools/persona-shot.mjs $D/shots app glitter
    PAGE=emo-preview node tools/face-shot.mjs $D/face_a.png "p=glitter&models=v5&s=neutral,blink:0.04,blink:0.075,talk:A,talk:O,talk:U,talk:M&cols=7&tile=300&dist=8&dy=-0.1"
    PAGE=emo-preview node tools/face-shot.mjs $D/face_b.png "p=glitter&models=v5&s=happy,laugh,surprised,sad,annoyed,shy,wink&cols=7&tile=300&dist=8&dy=-0.1"
    for c in "clip=idle_glitter_alive&ct=2.0" "clip=dance_glitter&ct=1.3" "clip=sit&ct=1.6" "clip=wave&ct=1.0" "act=cocoa&at=2.2" "act=mirror&at=2.0"; do
      Q="v=tq&w=300&h=440&models=v5&$c" node tools/persona-shot.mjs $D/anim $(echo $c|cut -d'&' -f1|cut -d= -f2) glitter; done
    # кровать (по желанию): scripts/bed-shots.mjs с &models=v5 → $D/bed/bed_{beside,climb,covered,wake}.png
    python3 tools/glitter-v5-sheet.py $D vs.jpg face.jpg
"""
import os, sys
from PIL import Image, ImageDraw, ImageFont

D, OUT_VS, OUT_FACE = sys.argv[1:4]
T, H = 300, 440
BG = (236, 236, 238)
F = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 17)
FB = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 22)


def lab(t, s):
    t = t.copy(); d = ImageDraw.Draw(t)
    d.rectangle((0, t.height - 24, t.width, t.height), fill=(255, 255, 255)); d.text((6, t.height - 22), s, fill=(20, 20, 30), font=F)
    return t


def row(title, ts, ncol):
    h = max(t.height for t in ts)
    out = Image.new('RGB', (ncol * T, h + 34), BG)
    ImageDraw.Draw(out).text((8, 5), title, fill=(20, 20, 30), font=FB)
    for i, t in enumerate(ts):
        out.paste(t, (i * T, 34))
    return out


def stack(rows, path):
    w = max(r.width for r in rows)
    out = Image.new('RGB', (w, sum(r.height for r in rows)), BG)
    y = 0
    for r in rows:
        out.paste(r, (0, y)); y += r.height
    out.save(path, quality=88)
    print('→', path, out.size)


views = ['front', 'tq', 'side', 'back', 'face']
names = ['анфас', '3/4', 'профиль', 'спина', 'лицо']
tri = [lab(Image.open(f'{D}/tripo/tripo_{v}.png').convert('RGB').resize((T, H)), n) for v, n in zip(views, names)]
app = Image.open(f'{D}/shots/app_glitter.png').convert('RGB')
apps = [lab(app.crop((i * T, 0, (i + 1) * T, H)), n) for i, n in enumerate(names)]
stack([row('Tripo-вьюер: исходник design/models/glitter_v5_rigged.glb (Blender Cycles, поза привязки)', tri, 5),
       row('В приложении: ?models=v5 (рантайм, свет приложения, покой idle) — без меха, без тона', apps, 5)], OUT_VS)


def tiles(path, labels):
    im = Image.open(path).convert('RGB')
    return [lab(im.crop((i * T, 0, (i + 1) * T, T)), s) for i, s in enumerate(labels)]


fa = tiles(f'{D}/face_a.png', ['покой (= Tripo)', 'моргание ½', 'моргание', 'а', 'о', 'у', 'м'])
fb = tiles(f'{D}/face_b.png', ['радость', 'смех', 'удивление', 'грусть', 'недовольство', 'смущение', 'подмигнуть'])
an = [('idle_glitter_alive', 'покой'), ('dance_glitter', 'танец'), ('sit', 'сидит'), ('wave', 'машет'), ('cocoa', 'какао'), ('mirror', 'зеркальце')]
anims = [lab(Image.open(f'{D}/anim/{f}_glitter.png').convert('RGB').resize((T, H)), s) for f, s in an]
rows = [row('Мимика поверх лица Tripo: покой, моргание (веко в тон меха), виземы', fa, 7),
        row('Эмоции — пресеты из этих морфов (брови, рот, щёки, прикрытие века)', fb, 7),
        row('Анимации (anims_v1 + Meshy, предмет в лапе)', anims, 7)]
bed = [f'{D}/bed/bed_{n}.png' for n in ('beside', 'climb', 'covered', 'wake')]
if all(os.path.exists(b) for b in bed):
    bt = [lab(Image.open(b).convert('RGB').crop((0, 140, 390, 700)).resize((T, int(560 * T / 390))), s) for b, s in zip(bed, ('у кровати', 'ложится', 'спит', 'проснулась'))]
    rows.append(row('Кровать (спальня, lab ?models=v5)', bt, 7))
stack(rows, OUT_FACE)

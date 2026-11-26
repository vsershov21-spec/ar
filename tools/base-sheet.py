"""Листы базы котов (docs/models/BASE.md) по снимкам tools/base-shots.sh:

    python3 tools/base-sheet.py <out> <кот> <лист_сравнения.jpg> <лист_лица.jpg>

  • сравнение с рефом — tools/base-overlay.py (4 ракурса реф | база+скин | 50 % и лицо крупно);
  • лицо и движения: виземы рига (vis_X…H) рядом с рефом ртов design/cut/base/mouth (design/sheets/mouths.jpg), эмоции
    рядом с design/cut/glitter/face (Блёстка) или design/sheets/expr_hooligan_kind.jpg (Хулиган, Добряк), веки/щёки,
    липсинк по кадрам реплики, анимации (покой, танец, сидит, кровать, машет) и предметы в лапах.
"""
import os, sys, json, subprocess
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
T = 260
BG = (236, 236, 238)
F = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 15)
FB = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 20)
NAMES = {'glitter': 'Блёстка', 'hooligan': 'Хулиган', 'kind': 'Добряк'}
EMO = ['neutral', 'excited', 'laugh', 'proud', 'wink_l', 'surprised', 'pout', 'shy', 'sad', 'purr', 'dizzy', 'sleep']
EMO_REF = ['neutral', 'excited', 'laugh', 'proud', 'wink', 'surprised', 'offended', 'shy', 'sad', 'purr', 'dizzy', 'sleep']
VIS = ['X', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']
# рефы ртов (вырезки mouths.jpg) под виземы Rhubarb: X — покой, A — сомкнуто (M), B — «и/э», C — «э», D — «а», E — «о»,
# F — «у», G — «ф», H — «л»
VIS_REF = {'X': 'rest', 'A': 'M', 'B': 'E', 'C': 'E', 'D': 'A', 'E': 'O', 'F': 'U', 'G': 'F', 'H': 'L'}
LIDS = ['моргание', 'сонно', 'радость', 'забота', 'слушает', 'сплющен', 'щёки-жвачка', 'улыбка+а']


def tiles(path, n, w=T, h=T):
    if not os.path.exists(path):
        return [Image.new('RGB', (w, h), BG)] * n
    im = Image.open(path).convert('RGB')
    cols = im.width // w
    rows = max(1, im.height // h)
    out = []
    for i in range(n):
        r, c = divmod(i, cols)
        # face-shot: первая строка — сверху (canvas), состояния слева направо, сверху вниз
        out.append(im.crop((c * w, r * h, (c + 1) * w, (r + 1) * h)))
    return out


def fit(path, w=T, h=T, bg=BG):
    t = Image.new('RGB', (w, h), bg)
    if os.path.exists(path):
        im = Image.open(path)
        if im.mode == 'RGBA':
            b = Image.new('RGB', im.size, (255, 255, 255)); b.paste(im, (0, 0), im); im = b
        im = im.convert('RGB'); im.thumbnail((w, h))
        t.paste(im, ((w - im.width) // 2, (h - im.height) // 2))
    return t


def lab(t, s):
    t = t.copy(); d = ImageDraw.Draw(t)
    d.rectangle((0, t.height - 20, t.width, t.height), fill=(255, 255, 255)); d.text((5, t.height - 19), s, fill=(20, 20, 30), font=F)
    return t


def row(title, ts, width):
    h = max(t.height for t in ts) if ts else T
    out = Image.new('RGB', (width, h + 28), BG)
    ImageDraw.Draw(out).text((8, 3), title, fill=(20, 20, 30), font=FB)
    x = 0
    for t in ts:
        out.paste(t, (x, 28)); x += t.width
    return out


def main():
    D, cat, out_vs, out_face = sys.argv[1:5]
    O = os.path.join(D, cat)
    subprocess.run([sys.executable, os.path.join(ROOT, 'tools/base-overlay.py'), os.path.join(O, f'ov_{cat}.png'), cat, out_vs], check=True)
    W = 12 * T
    rows = []
    vis = tiles(os.path.join(O, 'vis.png'), 9)
    rows.append(row('Виземы рига базы (vis_X…H, морфы FaceSkin: рот геометрией, клычки, язык)', [lab(t, f'vis_{v}') for t, v in zip(vis, VIS)], W))
    rows.append(row('реф: рты design/sheets/mouths.jpg (design/cut/base/mouth) под ту же визему',
                    [lab(fit(os.path.join(ROOT, f'design/cut/base/mouth/{VIS_REF[v]}.png')), f'{v} ← {VIS_REF[v]}') for v in VIS], W))
    emo = tiles(os.path.join(O, 'emo.png'), 12)
    rows.append(row('Эмоции (пресеты лица, один набор настроек на всех котов)', [lab(t, e) for t, e in zip(emo, EMO)], W))
    if cat == 'glitter':
        rows.append(row('реф: design/cut/glitter/face', [lab(fit(os.path.join(ROOT, f'design/cut/glitter/face/{e}.png')), e) for e in EMO_REF], W))
    else:
        ex = Image.open(os.path.join(ROOT, 'design/sheets/expr_hooligan_kind.jpg')).convert('RGB')
        ex.thumbnail((W, 2 * T))
        rows.append(row('реф: design/sheets/expr_hooligan_kind.jpg', [ex], W))
    lids = tiles(os.path.join(O, 'lids.png'), 8)
    rows.append(row('Веки, щёки, рот+эмоция', [lab(t, n) for t, n in zip(lids, LIDS)], W))
    lip = tiles(os.path.join(O, 'lip.png'), 10)
    seq = []
    try:
        seq = json.loads(open(os.path.join(O, 'lip.json')).read().split('\n')[0]).get('seq', [])
    except Exception:
        pass
    labels = [f"{s['t']:.2f} с: {s.get('cue', '')}" for s in seq] if seq else [f'{0.15 * (i + 1):.2f} с' for i in range(10)]
    rows.append(row('Липсинк по кадрам реплики «Привет! Давай дружить, я покажу тебе фокус» (визема Rhubarb из текста)', [lab(t, l) for t, l in zip(lip, labels)], W))
    an = []
    for a, nm in (('idle_breathe', 'покой'), (f'dance_{cat}', 'танец'), ('sit_idle', 'сидит'), ('sleep_loop_bed', 'кровать (сон)'), ('wave', 'машет')):
        p = os.path.join(O, f'anim_{a}_{cat}.png')
        an += [lab(t, f'{nm} {v}') for t, v in zip(tiles(p, 2, 300, 440), ('3/4', 'анфас'))]
    rows.append(row('Анимации (общая библиотека движений, скелет базы)', an[:10], W))
    ac = []
    acts = ['cocoa', 'mirror', 'treat', 'gum'] + (['skate'] if cat == 'hooligan' else [])
    for a in acts:
        p = os.path.join(O, f'act_{a}_{cat}.png')
        ac += [lab(t, f'{a} {v}') for t, v in zip(tiles(p, 2, 300, 440), ('3/4', 'анфас'))]
    rows.append(row('Предметы в лапах (хват gripSolver/propPen, без настроек по коту)', ac[:10], W))
    if len(ac) > 10:
        rows.append(row('', ac[10:], W))
    H = sum(r.height for r in rows) + 40
    sheet = Image.new('RGB', (W, H), BG)
    ImageDraw.Draw(sheet).text((8, 8), f'{NAMES[cat]}: база котов + скин — мимика, липсинк, движения (?models=base)', fill=(20, 20, 30), font=FB)
    y = 40
    for r in rows:
        sheet.paste(r, (0, y)); y += r.height
    sheet.thumbnail((2600, 99999))
    sheet.save(out_face, quality=86)
    print(out_face, sheet.size)


if __name__ == '__main__':
    main()

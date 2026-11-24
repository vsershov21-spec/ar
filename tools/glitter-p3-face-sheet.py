"""Листы Блёстки p3 (лицо по рефу, scripts/models/glitter_p3_face.py) — настоящий рантайм (emo-preview / persona-shot):

    npx vite --port 4391 &
    FACE_PORT=4391 PORT=4391 python3 tools/glitter-p3-face-sheet.py [--m /models/v2/glitter_p3.glb] [--out docs/qa/glitter]

→ glitter_p3_face.jpg — все ключи лица (виземы X, A–H рядом со ртами design/sheets/mouths.jpg, эмоции рядом с
  design/cut/glitter/face, веки, брови, реплика с липсинком покадрово);
→ glitter_p3_vs_ref.jpg — 4 ракурса разворота и лицо крупно: реф | p3 | наложение 50 %.
"""
import json, os, subprocess, sys
from PIL import Image, ImageDraw, ImageFont, ImageChops

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
T = 300
BG = (232, 232, 236)
FONT = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 16)
FONT_B = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 21)
LINE = 'Ой, привет! Посмотри, как я блещу!'
# виземы Rhubarb → тайл mouths.jpg (2×4: 0 сомкнутая улыбка, 1 «и», 2 «а», 3 «о», 4 «у», 5 «ф/в», 6 «э/л», 7 покой «ω»)
VIS = [('vis:X', 'X покой', 7), ('vis:A', 'A м б п', 0), ('vis:B', 'B и, согл.', 1), ('vis:C', 'C э', 6), ('vis:D', 'D а', 2),
       ('vis:E', 'E о', 3), ('vis:F', 'F у', 4), ('vis:G', 'G ф в', 5), ('vis:H', 'H л', 6)]
EMO = [('neutral', 'покой', 'neutral'), ('excited', 'excited', 'excited'), ('laugh', 'laugh «^»', 'laugh'), ('proud', 'proud', 'proud'),
       ('sad', 'sad', 'sad'), ('surprised', 'surprised', 'surprised'), ('offended', 'offended', 'offended'), ('wink_r', 'wink', 'wink'),
       ('shy', 'shy', 'shy'), ('sleep', 'sleep', 'sleep')]
LIDS = [('blink:0.03', 'моргание 30 мс'), ('blink:0.075', '75 мс (закрыт)'), ('blink:0.12', '120 мс'), ('listen', 'широко'),
        ('pain_ears', 'прищур'), ('sleepy', 'сонный'), ('think', 'brow_up'), ('annoyed', 'brow_angry'), ('cheeks_gum', 'cheeks_gum'),
        ('smirk', 'smirk'), ('pout', 'pout'), ('cheeky', 'tongue_out')]


def arg(k, d):
    return sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d


M = arg('--m', '/models/v2/glitter_p3.glb')
OUT = arg('--out', os.path.join(ROOT, 'docs/qa/glitter'))


def shot(states, cols, extra=''):
    out = f'/tmp/p3sheet_{abs(hash((tuple(states), extra))) % 10**8}.png'
    q = f'p=glitter&m={M}&face=morph&s={",".join(states)}&cols={cols}&tile={T}&dist=7{extra}'
    r = subprocess.run(['node', os.path.join(ROOT, 'tools/face-shot.mjs'), out, q], env={**os.environ, 'PAGE': 'emo-preview'},
                       capture_output=True, text=True, timeout=900)
    info = {}
    try:
        info = json.JSONDecoder().raw_decode(r.stdout[r.stdout.index('{"labels"'):])[0]
    except Exception:
        pass
    im = Image.open(out).convert('RGB')
    return [im.crop(((i % cols) * T, (i // cols) * T, (i % cols) * T + T, (i // cols) * T + T)) for i in range(len(states))], info


def label(tile, text):
    t = tile.copy(); d = ImageDraw.Draw(t)
    d.rectangle((0, T - 24, T, T), fill=(255, 255, 255)); d.text((6, T - 22), text, fill=(20, 20, 30), font=FONT)
    return t


def row(title, tiles):
    out = Image.new('RGB', (max(12, len(tiles)) * T, T + 32), BG)
    ImageDraw.Draw(out).text((8, 4), title, fill=(20, 20, 30), font=FONT_B)
    for i, t in enumerate(tiles):
        out.paste(t, (i * T, 32))
    return out


def stack(rows):
    out = Image.new('RGB', (max(r.width for r in rows), sum(r.height for r in rows)), BG)
    y = 0
    for r in rows:
        out.paste(r, (0, y)); y += r.height
    return out


def mouth_ref(i):
    im = Image.open(os.path.join(ROOT, 'design/sheets/mouths.jpg')).convert('RGB')
    w, h = im.size
    cw, ch = w / 4, h / 2
    x, y = (i % 4) * cw, (i // 4) * ch
    return im.crop((int(x + cw * 0.08), int(y + ch * 0.12), int(x + cw * 0.92), int(y + ch * 0.92))).resize((T, T))


def cut_ref(name):
    im = Image.open(os.path.join(ROOT, 'design/cut/glitter/face', name + '.png')).convert('RGBA')
    bg = Image.new('RGBA', im.size, BG + (255,)); bg.alpha_composite(im); im = bg.convert('RGB')
    w, h = im.size
    return im.crop((int(w * 0.12), int(h * 0.12), int(w * 0.88), int(h * 0.76))).resize((T, T))


# крупно «лицо реф | лицо p3»: покой (вид спереди разворота) и 4 ключевые эмоции (design/cut/glitter/face)
PAIRS = [('laugh', 'laugh'), ('wink_r', 'wink'), ('surprised', 'surprised'), ('sad', 'sad')]
TB = 440


def face_pairs():
    """строка пар реф | p3 крупно (тайл TB): покой — голова анфас того же масштаба, эмоции — emo-preview"""
    port = os.environ.get('PORT', '4391')
    out = '/tmp/p3sheet_pairs'
    subprocess.run(['node', os.path.join(ROOT, 'tools/persona-shot.mjs'), out, 'f', 'glitter'], timeout=900, capture_output=True,
                   env={**os.environ, 'PORT': port, 'Q': f'v=front&w=1200&h=1410&m={M}&face=morph&bg=ffffff'})
    HB = (330, 150, 870, 690)
    p3 = Image.open(f'{out}/f_glitter.png').convert('RGB').crop(HB).resize((TB, TB))
    rf = Image.open(os.path.join(ROOT, 'design/refs/glitter_views/front_white.png')).convert('RGB').crop((112, 60, 912, 1000)).resize((1200, 1410)).crop(HB).resize((TB, TB))
    pairs = [(rf, 'реф: покой (разворот)'), (p3, 'p3: покой')]
    tmp = f'/tmp/p3sheet_pairs/e.png'
    subprocess.run(['node', os.path.join(ROOT, 'tools/face-shot.mjs'), tmp, f'p=glitter&m={M}&face=morph&s={",".join(s_ for s_, _ in PAIRS)}&cols={len(PAIRS)}&tile={TB}&dist=7'],
                   env={**os.environ, 'PAGE': 'emo-preview'}, capture_output=True, text=True, timeout=900)
    em = Image.open(tmp).convert('RGB')
    for i, (st, c) in enumerate(PAIRS):
        im = Image.open(os.path.join(ROOT, 'design/cut/glitter/face', c + '.png')).convert('RGBA')
        bg = Image.new('RGBA', im.size, BG + (255,)); bg.alpha_composite(im); im = bg.convert('RGB')
        w, h = im.size
        pairs += [(im.crop((int(w * 0.12), int(h * 0.12), int(w * 0.88), int(h * 0.76))).resize((TB, TB)), f'реф: {c}'),
                  (em.crop((i * TB, 0, i * TB + TB, TB)), f'p3: {c}')]
    outim = Image.new('RGB', (len(pairs) * TB, TB + 32), BG)
    d = ImageDraw.Draw(outim)
    d.text((8, 4), 'лицо крупно: реф | p3 (покой и 4 ключевые эмоции)', fill=(20, 20, 30), font=FONT_B)
    for i, (im, lab) in enumerate(pairs):
        t = im.copy(); dd = ImageDraw.Draw(t)
        dd.rectangle((0, TB - 26, TB, TB), fill=(255, 255, 255)); dd.text((6, TB - 23), lab, fill=(20, 20, 30), font=FONT_B)
        outim.paste(t, (i * TB, 32))
        if i % 2 == 1:
            d.line((i * TB + TB - 1, 32, i * TB + TB - 1, TB + 32), fill=(90, 90, 100), width=3)
    return outim


def face_sheet():
    rows = [face_pairs()]
    t, _ = shot([s for s, _, _ in VIS], 9)
    rows.append(row('виземы Rhubarb (vis_X…vis_H, faceMorphs.ts) — p3', [label(x, n) for x, (_, n, _) in zip(t, VIS)]))
    rows.append(row('рты рефа design/sheets/mouths.jpg (ближайший тайл)', [mouth_ref(i) for _, _, i in VIS]))
    t, _ = shot([s for s, _, _ in EMO], 10)
    rows.append(row('эмоции — p3', [label(x, n) for x, (_, n, _) in zip(t, EMO)]))
    rows.append(row('эмоции рефа design/cut/glitter/face', [label(cut_ref(c), c) for _, _, c in EMO]))
    t, _ = shot([s for s, _ in LIDS], 12)
    rows.append(row('веки, брови, щёки, рот (ключи blink/squint/wide, brow_*, cheeks_gum, smirk, pout, tongue_out)', [label(x, n) for x, (_, n) in zip(t, LIDS)]))
    seq = [round(0.12 * k, 2) for k in range(1, 13)]
    t, info = shot([f'seq:{s}' for s in seq], 12, '&text=' + LINE)
    cues = {round(x['t'], 2): x.get('cue') for x in info.get('seq', [])}
    rows.append(row(f'реплика с липсинком «{LINE}» (кадр / визема)', [label(x, f'{s:.2f} с · {cues.get(s, "")}') for x, s in zip(t, seq)]))
    p = os.path.join(OUT, 'glitter_p3_face.jpg')
    stack(rows).save(p, quality=86)
    print(p)


def vs_ref():
    port = os.environ.get('PORT', '4391')
    out = '/tmp/p3sheet_views'
    subprocess.run(['node', os.path.join(ROOT, 'tools/persona-shot.mjs'), out, 'v', 'glitter'], timeout=900, capture_output=True,
                   env={**os.environ, 'PORT': port, 'Q': f'v=front,tq,side,back&w=400&h=470&m={M}&face=morph&bg=ffffff'})
    vv = Image.open(f'{out}/v_glitter.png').convert('RGB')
    # голова крупно в том же масштабе, что реф: анфас ×3 (тот же кадр, что у ракурсов) и вид спереди рефа ×3, одна рамка
    subprocess.run(['node', os.path.join(ROOT, 'tools/persona-shot.mjs'), out, 'f', 'glitter'], timeout=900, capture_output=True,
                   env={**os.environ, 'PORT': port, 'Q': f'v=front&w=1200&h=1410&m={M}&face=morph&bg=ffffff'})
    HB = (225, 0, 975, 880)
    ff = Image.open(f'{out}/f_glitter.png').convert('RGB').crop(HB).resize((400, 470))
    refs = [Image.open(os.path.join(ROOT, f'design/refs/glitter_views/{n}_white.png')).convert('RGB').crop((112, 60, 912, 1000)).resize((400, 470))
            for n in ('front', 'threequarter', 'right', 'back')]
    mine = [vv.crop((i * 400, 0, i * 400 + 400, 470)) for i in range(4)]
    rf = Image.open(os.path.join(ROOT, 'design/refs/glitter_views/front_white.png')).convert('RGB').crop((112, 60, 912, 1000)).resize((1200, 1410)).crop(HB).resize((400, 470))
    W = 5 * 400
    sheet = Image.new('RGB', (W, 3 * 470 + 3 * 34), BG)
    d = ImageDraw.Draw(sheet)
    for ri, (title, ims) in enumerate((('реф: разворот 23.11 + голова (тот же масштаб)', refs + [rf]), ('p3 (?models=p3): анфас, 3/4, профиль, спина, голова', mine + [ff]),
                                        ('наложение 50 % (реф + p3)', [Image.blend(a, b.resize(a.size), 0.5) for a, b in zip(refs + [rf], mine + [ff])]))):
        y = ri * (470 + 34)
        d.text((8, y + 6), title, fill=(20, 20, 30), font=FONT_B)
        for i, im in enumerate(ims):
            sheet.paste(im, (i * 400, y + 34))
    p = os.path.join(OUT, 'glitter_p3_vs_ref.jpg')
    sheet.save(p, quality=86)
    print(p)


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    if '--vs' not in sys.argv[1:] or '--face' in sys.argv:
        face_sheet()
    if '--face' not in sys.argv[1:] or '--vs' in sys.argv:
        vs_ref()

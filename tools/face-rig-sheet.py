"""Листы лица рига p2 (docs/qa/face): виземы A–H, эмоции, моргание, реплика с липсинком — крупным планом, рядом реф лица
и прежний рот шейдером (p1, ?face=shader) для сравнения. Кадры — настоящий рантайм (tools/emo-preview.html: GlbCharacter,
драйвер faceMorphs.ts, мех, глаза, свет приложения).

    npx vite --port 4177 &   # dev-сервер
    python3 tools/face-rig-sheet.py [hooligan kind glitter] [--out docs/qa/face]
    python3 tools/face-rig-sheet.py --lids   # только лист век всех трёх котов: lids.jpg
"""
import json, os, subprocess, sys, urllib.parse
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
T = 300
BG = (232, 232, 236)
FONT = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 17)
FONT_B = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 22)
LINE = {
    'hooligan': 'Привет! Я Хулиган. Погнали играть, а?',
    'kind': 'Привет, дружок! Хочешь, угощу тебя какао?',
    'glitter': 'Ой, привет! Посмотри, как я блещу!',
}
VIS = [('vis:X', 'X покой'), ('vis:A', 'A м б п'), ('vis:B', 'B и, согл.'), ('vis:C', 'C э'), ('vis:D', 'D а'),
       ('vis:E', 'E о'), ('vis:F', 'F у'), ('vis:G', 'G ф в'), ('vis:H', 'H л')]
EMO = [('happy', 'smile (happy)'), ('laugh', 'smile_open (laugh)'), ('smug', 'smirk (smug)'), ('sad', 'frown (sad)'),
       ('surprised', 'surprise'), ('pout', 'pout'), ('cheeky', 'tongue_out (cheeky)'), ('annoyed', 'brow_angry (annoyed)'),
       ('sleepy', 'sleepy')]
LIDS = [('blink:0.03', 'моргание 30 мс'), ('blink:0.075', '75 мс (закрыт)'), ('blink:0.12', '120 мс'), ('listen', 'wide (listen)'),
        ('pain_ears', 'squint'), ('wink_r', 'wink_R'), ('shy', 'brow_sad (shy)'), ('think', 'brow_up (think)'), ('offended', 'cheeks_gum')]
# реф лица: design/cut/glitter/face (Блёстка), design/sheets/expr_hooligan_kind.jpg (Хулиган, Добряк) — как tools/emo-sheet.py
CUT = {'neutral': 0, 'excited': 1, 'laugh': 2, 'proud': 3, 'wink': 4, 'surprised': 5, 'offended': 6, 'shy': 7, 'sad': 8, 'purr': 9, 'dizzy': 10, 'sleep': 11}


def ref(persona, name, size=T):
    if persona == 'glitter':
        im = Image.open(os.path.join(ROOT, 'design/cut/glitter/face', name + '.png')).convert('RGBA')
        bg = Image.new('RGBA', im.size, BG + (255,)); bg.alpha_composite(im); im = bg.convert('RGB')
        w, h = im.size
        im = im.crop((int(w * 0.18), int(h * 0.2), int(w * 0.82), int(h * 0.72)))
    else:
        i = CUT[name]
        sh = Image.open(os.path.join(ROOT, 'design/sheets/expr_hooligan_kind.jpg')).convert('RGB')
        col, row = i % 4, i // 4
        x0 = (22 + col * 163) if persona == 'hooligan' else (718 + col * 161)
        y0 = 66 + row * 226
        im = sh.crop((x0 + 20, y0 + 40, x0 + 140, y0 + 160))
    return im.resize((size, size), Image.LANCZOS)


def mouths_ref(i, size=T):
    """design/sheets/mouths.jpg — формы рта СберКота (4×2): покой, улыбка, «а», «о», «у», «ф», смех, ω"""
    sh = Image.open(os.path.join(ROOT, 'design/sheets/mouths.jpg')).convert('RGB')
    W, H = sh.size
    c, r = i % 4, i // 4
    cx, cy = (c + 0.5) * W / 4, (0.27 + r * 0.47) * H
    s = W / 4 * 0.5
    return sh.crop((int(cx - s / 2), int(cy - s * 0.2), int(cx + s / 2), int(cy + s * 0.8))).resize((size, size), Image.LANCZOS)


def shot(persona, states, cols, extra=''):
    out = f'/tmp/face_rig_{persona}_{abs(hash((tuple(states), extra))) % 10**8}.png'
    q = f'p={persona}&s={",".join(states)}&cols={cols}&tile={T}&dist=4.6{extra}'
    r = subprocess.run(['node', os.path.join(ROOT, 'tools/face-shot.mjs'), out, q], env={**os.environ, 'PAGE': 'emo-preview'},
                       capture_output=True, text=True, timeout=600)
    info = {}
    try:
        info = json.JSONDecoder().raw_decode(r.stdout[r.stdout.index('{"labels"'):])[0]
    except Exception:
        pass
    im = Image.open(out).convert('RGB')
    tiles = []
    for i in range(len(states)):
        x, y = (i % cols) * T, (i // cols) * T
        tiles.append(im.crop((x, y, x + T, y + T)))
    return tiles, info


def label(tile, text, sub=None):
    t = tile.copy()
    d = ImageDraw.Draw(t)
    d.rectangle((0, T - 26, T, T), fill=(255, 255, 255))
    d.text((6, T - 23), text, fill=(20, 20, 30), font=FONT)
    if sub:
        d.rectangle((0, 0, T, 22), fill=(40, 40, 50))
        d.text((6, 2), sub, fill=(255, 255, 255), font=FONT)
    return t


def row(title, tiles):
    W = max(9, len(tiles)) * T
    out = Image.new('RGB', (W, T + 34), BG)
    ImageDraw.Draw(out).text((8, 4), title, fill=(20, 20, 30), font=FONT_B)
    for i, t in enumerate(tiles):
        out.paste(t, (i * T, 34))
    return out


def stack(rows):
    W = max(r.width for r in rows)
    H = sum(r.height for r in rows)
    out = Image.new('RGB', (W, H), BG)
    y = 0
    for r in rows:
        out.paste(r, (0, y)); y += r.height
    return out


LID_SHEET = [('neutral', 'покой'), ('blink:0.03', 'моргание 30 мс'), ('blink:0.075', '75 мс (закрыт)'),
             ('blink:0.12', '120 мс'), ('wink_r', 'wink_R'), ('laugh', 'смех «^»'), ('sleepy', 'сонный'),
             ('surprised', 'широко'), ('annoyed', 'злость')]


def lids_sheet(outdir):
    """веки крупно (мягкая кромка, ресницы, тон = мех вокруг): три кота, одни и те же кадры"""
    rows = []
    for persona in ['hooligan', 'kind', 'glitter']:
        t, _ = shot(persona, [s for s, _ in LID_SHEET], 9, '&dy=0.45')
        rows.append(row(f'{persona}: веки (eyeRig.ts, мягкие веки)', [label(x, n) for x, (_, n) in zip(t, LID_SHEET)]))
    stack(rows).save(os.path.join(outdir, 'lids.jpg'), quality=86)
    print('lids ok')


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    outdir = sys.argv[sys.argv.index('--out') + 1] if '--out' in sys.argv else os.path.join(ROOT, 'docs/qa/face')
    if '--out' in sys.argv:
        args = [a for a in args if a != outdir]
    os.makedirs(outdir, exist_ok=True)
    if '--lids' in sys.argv:
        lids_sheet(outdir)
        return
    for persona in args or ['hooligan', 'kind', 'glitter']:
        rows = []
        v, _ = shot(persona, [s for s, _ in VIS], 9)
        rows.append(row(f'{persona}: виземы Rhubarb (риг p2, ?face=morph)', [label(t, n) for t, (_, n) in zip(v, VIS)]))
        vs, _ = shot(persona, ['neutral', 'talk:M', 'talk:E', 'talk:A', 'talk:A', 'talk:O', 'talk:U', 'talk:F', 'talk:A'], 9, '&face=shader')
        rows.append(row('было: рот шейдером (p1, ?face=shader), те же формы', [label(t, n) for t, (_, n) in zip(vs, VIS)]))
        rows.append(row('реф: формы рта СберКота (design/sheets/mouths.jpg) и лицо персонажа (design/cut)',
                        [label(ref(persona, 'neutral'), 'реф: покой')] + [label(mouths_ref(i), n) for i, n in
                                                                          enumerate(['покой', 'улыбка', '«а»', '«о»', '«у»', 'ф/в', 'смех', 'ω'])]))
        e, _ = shot(persona, [s for s, _ in EMO], 9)
        rows.append(row('эмоции', [label(t, n) for t, (_, n) in zip(e, EMO)]))
        rows.append(row('реф эмоций (design/cut)', [label(ref(persona, n), n) for n in ['excited', 'laugh', 'proud', 'sad', 'surprised', 'offended', 'wink', 'shy', 'sleep']]))
        l, _ = shot(persona, [s for s, _ in LIDS], 9)
        rows.append(row('веки и брови', [label(t, n) for t, (_, n) in zip(l, LIDS)]))
        sheet = stack(rows)
        sheet.save(os.path.join(outdir, f'{persona}_face.jpg'), quality=86)
        # реплика с липсинком: кадры через 1/15 с
        text = LINE[persona]
        ts = [round(0.1 + i / 15, 3) for i in range(27)]
        seq, info = shot(persona, [f'seq:{t}' for t in ts], 9, '&text=' + urllib.parse.quote(text))
        cues = {x['t']: x['cue'] for x in (info.get('seq') or [])}
        tiles = [label(t, f'{tt:.2f} с  визема {cues.get(tt, "?")}') for t, tt in zip(seq, ts)]
        rows2 = [row(f'{persona}: «{text}» — кадры через 1/15 с (cues — русские буквы → Rhubarb, кроссфейд 75 мс)', tiles[:9]),
                 row('', tiles[9:18]), row('', tiles[18:27])]
        stack(rows2).save(os.path.join(outdir, f'{persona}_lipsync.jpg'), quality=86)
        print(persona, 'ok')


if __name__ == '__main__':
    main()

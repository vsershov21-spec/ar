"""Контактный лист эмоций «референс | было | стало» → docs/look/emotions_<persona>.jpg
python3 tools/emo-sheet.py <persona> before.png after.png out.jpg
before/after — кадры tools/emo-preview.html (12 эмоций в порядке EMO, 6 колонок, плитка T), рефы — design/cut и design/sheets."""
import os, sys
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EMO = ['neutral', 'happy', 'laugh', 'smug', 'wink_r', 'surprised', 'pout', 'shy', 'sad', 'sleepy', 'dizzy', 'sleep']
LABEL = ['нейтрально', 'улыбка', 'смех', 'ухмылка', 'подмигивание', 'удивление', 'надулся', 'смущение', 'грусть', 'сонный', 'головокружение', 'сон']
CUT = ['neutral', 'excited', 'laugh', 'proud', 'wink', 'surprised', 'offended', 'shy', 'sad', 'purr', 'dizzy', 'sleep']
BG = (232, 232, 236)


def ref_cells(persona, T):
    out = []
    for i, c in enumerate(CUT):
        if persona == 'glitter':
            im = Image.open(os.path.join(ROOT, 'design/cut/glitter/face', c + '.png')).convert('RGBA')
            bg = Image.new('RGBA', im.size, BG + (255,)); bg.alpha_composite(im); im = bg.convert('RGB')
        else:
            sh = Image.open(os.path.join(ROOT, 'design/sheets/expr_hooligan_kind.jpg')).convert('RGB')
            col, row = i % 4, i // 4
            x0 = (22 + col * 163) if persona == 'hooligan' else (718 + col * 161)
            y0 = 66 + row * 226
            im = sh.crop((x0, y0, x0 + 160, y0 + 202))
        w, h = im.size
        k = T / max(w, h)
        im = im.resize((int(w * k), int(h * k)), Image.LANCZOS)
        cell = Image.new('RGB', (T, T), BG); cell.paste(im, ((T - im.width) // 2, (T - im.height) // 2))
        out.append(cell)
    return out


def tiles(path, T):
    im = Image.open(path).convert('RGB')
    t = im.width // 6
    return [im.crop(((i % 6) * t, (i // 6) * t, (i % 6 + 1) * t, (i // 6 + 1) * t)).resize((T, T), Image.LANCZOS) for i in range(12)]


def main():
    persona, before, after, out = sys.argv[1:5]
    T = 260
    R, B, A = ref_cells(persona, T), tiles(before, T), tiles(after, T)
    try:
        font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 18)
        small = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 14)
    except OSError:
        font = small = ImageFont.load_default()
    gw, gh = 3 * T + 16, T + 34
    W, H = 4 * gw + 20, 3 * gh + 50
    sheet = Image.new('RGB', (W, H), (250, 250, 250))
    d = ImageDraw.Draw(sheet)
    d.text((12, 10), f'{persona}: эмоции — референс | было | стало (рантайм GlbCharacter, свет приложения, headless Chrome)', fill=(20, 20, 20), font=font)
    for i in range(12):
        x, y = 10 + (i % 4) * gw, 44 + (i // 4) * gh
        d.text((x, y), LABEL[i], fill=(20, 20, 20), font=font)
        for k, (im, tag) in enumerate(((R[i], 'реф'), (B[i], 'было'), (A[i], 'стало'))):
            sheet.paste(im, (x + k * (T + 4), y + 26))
            d.text((x + k * (T + 4) + 6, y + 26 + T - 20), tag, fill=(200, 30, 30), font=small)
    sheet.save(out, quality=86, optimize=True)
    print(out, sheet.size)


if __name__ == '__main__':
    main()

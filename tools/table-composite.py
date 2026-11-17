"""Кот на фоне фото стола (кадр с камеры телефона): прозрачные PNG из tools/emo-preview.html (bg=none, ALPHA=1
node tools/face-shot.mjs …) кладутся ногами на карту, ряд кадров с подписями.
python3 tools/table-composite.py out.jpg photo.jpg "подпись:cat.png" […] [--feet 0.546,0.875] [--h 0.36]
--feet — точка карты в долях фото, --h — рост кота в долях высоты фото (на телефоне ≈ 0.3–0.4)."""
import sys
from PIL import Image, ImageDraw, ImageFont

args = sys.argv[1:]
opt = {}
for k in ('--feet', '--h'):
    if k in args:
        i = args.index(k)
        opt[k] = args[i + 1]
        del args[i:i + 2]
out, photo, cats = args[0], args[1], args[2:]
fx, fy = map(float, opt.get('--feet', '0.546,0.875').split(','))
hk = float(opt.get('--h', '0.36'))
bg = Image.open(photo).convert('RGB')
bg = bg.resize((bg.width * 2, bg.height * 2), Image.LANCZOS)
W, H = bg.size
try:
    font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 30)
except OSError:
    font = ImageFont.load_default()
tiles = []
for c in cats:
    label, path = c.split(':', 1)
    cat = Image.open(path).convert('RGBA')
    bb = cat.split()[-1].getbbox()
    cat = cat.crop(bb)
    s = H * hk / cat.height
    cat = cat.resize((max(1, int(cat.width * s)), max(1, int(cat.height * s))), Image.LANCZOS)
    t = bg.copy()
    # мягкая контактная тень под ногами
    sh = Image.new('L', (int(cat.width * 0.9), int(cat.width * 0.22)), 0)
    ImageDraw.Draw(sh).ellipse((0, 0, sh.width - 1, sh.height - 1), fill=90)
    from PIL import ImageFilter
    sh = sh.filter(ImageFilter.GaussianBlur(8))
    t.paste((40, 40, 50), (int(fx * W - sh.width / 2), int(fy * H - sh.height / 2)), sh)
    t.paste(cat, (int(fx * W - cat.width / 2), int(fy * H - cat.height)), cat)
    d = ImageDraw.Draw(t)
    d.rectangle((0, 0, W, 46), fill=(255, 255, 255))
    d.text((12, 8), label, fill=(20, 20, 20), font=font)
    tiles.append(t)
sheet = Image.new('RGB', (W * len(tiles), H), 'white')
for i, t in enumerate(tiles):
    sheet.paste(t, (i * W, 0))
sheet.save(out, quality=88)
print(out, sheet.size)

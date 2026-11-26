"""Блёстка v5, последняя стадия: текстуры Tripo 4K → 2048² (сборка model-opt всё равно ужимает до 1024²/2048² KTX2;
исходник в public легче). Мех — стадии v5_fur.py + fur_volume.py (прежний --fur с коротким плюшем p4 давал зернистый
шум и рваный силуэт — docs/qa/glitter/glitter_v5_fur_cmp.jpg — убран).

    python3 scripts/models/v5/v5_finish.py fur.glb out.glb
"""
import sys, os, io
import numpy as np
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from v5_common import Glb  # noqa: E402

src, dst = sys.argv[1:3]
TEX = int(os.environ.get("V5_TEX", 2048))
g = Glb(src); j = g.j
for ii, im in enumerate(j['images']):
    if im.get('name', '').startswith('glitter_v5_rigged'):
        pic = g.image(ii)
        if max(pic.size) > TEX:
            g.set_image(ii, pic.resize((TEX, TEX), Image.LANCZOS))
            if im['mimeType'] == 'image/jpeg':
                im.setdefault('extras', {})['requant'] = 92
size = g.save(dst)
print(f'→ {dst} ({size / 1e6:.2f} МБ)')

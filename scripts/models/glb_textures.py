"""Пережать текстуры GLB: PNG без прозрачности → JPEG, всё ≤ max px. Usage: glb_textures.py in.glb out.glb [max=1536] [q=85]"""
import io, json, struct, sys
from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
MAX = int(sys.argv[3]) if len(sys.argv) > 3 else 1536
Q = int(sys.argv[4]) if len(sys.argv) > 4 else 85
b = open(src, 'rb').read()
jl = struct.unpack('<I', b[12:16])[0]
j = json.loads(b[20:20 + jl])
bin_off = 20 + jl + 8
binb = b[bin_off:bin_off + struct.unpack('<I', b[20 + jl:24 + jl])[0]]

views = j['bufferViews']
img_views = {im['bufferView']: i for i, im in enumerate(j.get('images', [])) if 'bufferView' in im}
out = bytearray()
for vi, v in enumerate(views):
    data = binb[v.get('byteOffset', 0):v.get('byteOffset', 0) + v['byteLength']]
    if vi in img_views:
        im = Image.open(io.BytesIO(data))
        if max(im.size) > MAX:
            im.thumbnail((MAX, MAX), Image.LANCZOS)
        opaque = im.mode not in ('RGBA', 'LA', 'P') or im.convert('RGBA').getextrema()[3][0] == 255
        buf = io.BytesIO()
        if opaque:
            im.convert('RGB').save(buf, 'JPEG', quality=Q, optimize=True)
            j['images'][img_views[vi]]['mimeType'] = 'image/jpeg'
        else:
            im.save(buf, 'PNG', optimize=True)
        data = buf.getvalue()
    while len(out) % 4:
        out.append(0)
    v['byteOffset'] = len(out)
    v['byteLength'] = len(data)
    out += data
while len(out) % 4:
    out.append(0)
j['buffers'][0]['byteLength'] = len(out)
js = json.dumps(j, separators=(',', ':')).encode()
js += b' ' * ((4 - len(js) % 4) % 4)
total = 12 + 8 + len(js) + 8 + len(out)
with open(dst, 'wb') as f:
    f.write(struct.pack('<III', 0x46546C67, 2, total))
    f.write(struct.pack('<I', len(js)) + b'JSON' + js)
    f.write(struct.pack('<I', len(out)) + b'BIN\x00' + out)
print(f'{src}: {len(b)/1e6:.2f} MB → {total/1e6:.2f} MB')

"""GLB Tripo с анимациями → библиотека движений: только скелет и клипы (без меша/текстур), имена клипов → id каталога.
Usage: make_anim_lib.py in.glb out.glb   (потом: npx @gltf-transform/cli prune out.glb out.glb)"""
import json, re, struct, sys

# описания из Text-to-Motion (начало строки) → id content/animations.json
PROMPT_IDS = [
    ('gets tickled on the belly', 'poke_belly'),
    ('talks expressively', 'talk_casual'),
    ('thinks: puts one hand', 'think'),
    ('yawns widely', 'idle_yawn'),
    ('curls up and l', 'sleep_loop'),
    ('presses both palms', 'press_glass'),
    ('knocks t', 'knock_glass'),
]
src, dst = sys.argv[1], sys.argv[2]
b = open(src, 'rb').read()
jl = struct.unpack('<I', b[12:16])[0]
j = json.loads(b[20:20 + jl])
binb = b[20 + jl + 8:]
for a in j['animations']:
    n = a.get('name', '')
    for frag, cid in PROMPT_IDS:
        if frag in n:
            a['name'] = cid
# кости не тянутся и не масштабируются: оставляем вращения всех + смещение только у Hips
for a in j['animations']:
    keep = []
    for c in a['channels']:
        t = c['target']; nm = j['nodes'][t['node']].get('name', '')
        if re.search(r'Hand(Thumb|Index|Middle|Ring|Pinky)|_End$|HeadTop', nm):
            continue  # пальцы у мультяшных лап не нужны
        if t['path'] == 'rotation' or (t['path'] == 'translation' and nm.endswith('Hips')):
            keep.append(c)
    sm, remap = [], {}
    for c in keep:
        i = c['sampler']
        if i not in remap:
            remap[i] = len(sm); sm.append(a['samplers'][i])
        c['sampler'] = remap[i]
    a['channels'], a['samplers'] = keep, sm
for n in j['nodes']:
    n.pop('mesh', None); n.pop('skin', None)
for k in ('meshes', 'materials', 'textures', 'images', 'samplers', 'skins'):
    j.pop(k, None)
js = json.dumps(j, separators=(',', ':')).encode(); js += b' ' * ((4 - len(js) % 4) % 4)
binlen = struct.unpack('<I', b[20 + jl:24 + jl])[0]
binb = b[20 + jl + 8:20 + jl + 8 + binlen]
total = 12 + 8 + len(js) + 8 + len(binb)
with open(dst, 'wb') as f:
    f.write(struct.pack('<III', 0x46546C67, 2, total))
    f.write(struct.pack('<I', len(js)) + b'JSON' + js)
    f.write(struct.pack('<I', len(binb)) + b'BIN\x00' + binb)
print([a['name'] for a in j['animations']])

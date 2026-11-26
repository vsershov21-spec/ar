#!/bin/sh
# Блёстка p4 — тем же конвейером, что Хулиган и Добряк (docs/models/README.md, раздел «Блёстка p4»):
#   sh scripts/models/build_glitter_p4.sh [work=/tmp/p4]
# Вход — design/models/glitter_tripo_rigged.glb (Tripo: 4 вида, по частям, quad ~14k, Auto Rig Mixamo).
# Нужны: /tmp/bpyenv/bin/python (pip install bpy==5.3.0 numpy scipy pillow) и python3 с numpy/scipy/pillow.
set -e
cd "$(dirname "$0")"
W=${1:-/tmp/p4}; BPY=${BPY:-/tmp/bpyenv/bin/python}
OUT=../../public/models/v2
mkdir -p "$W"
q() { grep -v "INFO\|^$\|Draco\|MeshOptimizer\|Deprecation\|use_nodes\|WARNING" || true; }
if [ -z "$FROM4" ]; then  # FROM4=1 — с шага 4 (ригнутая сетка и ориентиры уже есть)
# 1. 35 частей → одна сетка (слоты материалов), арматура без узлов-обёрток Tripo
$BPY blender/p4_join.py -- ../../design/models/glitter_tripo_rigged.glb "$W/joined0.glb" 2>&1 | q
# 1б. форма головы по наложению на разворот (v3): голова больше при том же лице, нос выше и меньше
python3 glitter_p4_sculpt.py "$W/joined0.glb" "$W/joined.glb" | tail -1
# 2. уши и хвост (LeftEar1/RightEar1, Tail1..4) — как у Хулигана/Добряка (docs/RIG.md); части — целиком по сетке Tripo
$BPY blender/dump.py -- "$W/joined.glb" /tmp/glitter4.npz 2>&1 | q
python3 blender/p4_parts.py glitter4
$BPY blender/rig_cat.py -- "$W/joined.glb" /tmp/glitter4_parts.npz "$W/rigged.glb" 2>&1 | q
# 3. ориентиры лица по снимку спереди (лицо Tripo на месте) → face_landmarks/glitter_p4.json
python3 glitter_p4.py "$W/rigged.glb" "$W/base_face.glb" --keep-face | tail -1
$BPY blender/face_photo.py -- "$W/base_face.glb" "$W/photo.npz" 2>&1 | q
python3 blender/face_detect.py "$W/photo.npz" "$W/land.json" "$W/land_viz.png"
python3 glitter_p4_land.py "$W/photo.npz" "$W/land.json" face_landmarks/glitter_p4.json
fi
# 4. одна сетка с атласом: глаза и рот Tripo → заплатки, нос/морда/брови вшиты в голову
python3 glitter_p4.py "$W/rigged.glb" "$W/base.glb" > "$W/base.log"; grep -v "^tripo_part" "$W/base.log"
# 5. лицо как у Хулигана/Добряка: ключи рта (Blender), глаза/веки eyeRig, брови, усы, MouthD, закраска
$BPY blender/face_rig.py -- "$W/base.glb" face_landmarks/glitter_p4.json "$W/fr.glb" 2>&1 | q
# глаза: разрез — по белку Tripo (glitter_p4_land.py); v3 — крупнее (наложение на реф: белок и радужка больше на ~20 %)
EYE_OVR='{"EYE_SCALE": {"glitter": [1.25, 1.22]}, "ROUND": {"glitter": 0.35}, "IRIS_K": {"glitter": 1.18}}' \
python3 face_detail.py glitter "$W/fr.glb" "$W/fd.glb" --land face_landmarks/glitter_p4.json | tail -3
python3 persona_tune.py glitter_p4 "$W/fd.glb" "$W/pt.glb" | tail -2
# 6. мех-оболочки, пачка и золото своими мешами → p4 (рот шейдером), прокси, риг лица p2 → p4m
python3 glitter_p4_finish.py "$W/pt.glb" $OUT/glitter_p4.glb --parts "$W/base_parts.json"
python3 colliders.py glitter $OUT/glitter_p4.glb $OUT/glitter_p4_colliders.json
# риг лица p2 (рот геометрией): у сетки Блёстки p4 разрез губ пока не замыкается (face_rig.py выходит с ошибкой) —
# p4m не собирается, рантайм при ?face=morph берёт p4m только если файл есть (иначе — p4, лицо шейдером)
# v3: с новой мордочкой разрез замыкается, но риг p2 не проверен глазами — p4m кладётся в рабочую папку, не в public
# (рантайм при ?face=morph берёт p4m, только если файл лежит в public/models/v2)
$BPY face_rig.py glitter $OUT/glitter_p4.glb "$W/glitter_p4m.glb" --report "$W" || echo "face_rig: p4m не собран"


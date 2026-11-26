#!/bin/sh
# База котов + скины (docs/models/BASE.md) одной командой:
#   sh scripts/models/build_base.sh [work=/tmp/cat_base]        (FROM4=1 — без стадий 1–3 p4, SKINS_ONLY=1 — только скины)
# Вход — design/models/glitter_tripo_rigged.glb (форма Блёстки p4 v3) и public/models/v2/{hooligan,kind}_p1.glb
# (одежда Хулигана и Добряка). Выход — public/models/base/cat_base.glb + skin_{glitter,hooligan,kind}.glb + прокси.
# Нужны: /tmp/bpyenv/bin/python (pip install bpy==5.3.0 numpy scipy pillow) и python3 с numpy/scipy/pillow/matplotlib.
set -e
cd "$(dirname "$0")"
W=${1:-/tmp/cat_base}; BPY=${BPY:-/tmp/bpyenv/bin/python}
OUT=../../public/models/base
mkdir -p "$W/p4" "$OUT"
q() { grep -v "INFO\|^$\|Draco\|MeshOptimizer\|Deprecation\|use_nodes\|WARNING" || true; }
# риг лица базы: рот шире (ширина ≈ 0.68 межглазья, design/sheets/mouths.jpg), челюсть и проём «D» шире, язык за
# челюстью слабее (у плоской морды кончик выходил сквозь подбородок), мордочка реже (размер файла)
export P4_MOUTH_W=${P4_MOUTH_W:-2.6}
export P4_MUZZLE=${P4_MUZZLE:-'{"step": 0.0026}'}
export P4_MOUTH_SMOOTH=${P4_MOUTH_SMOOTH:-0.8}
export FR_OVR=${FR_OVR:-'{"glitter": {"jaw": 0.22, "open_k": 1.5, "prof_p": 0.4, "tongue_jaw": 0.8}}'}
# «о» и «у» у узкой челюсти базы — шире и круглее (реф design/cut/base/mouth O, U)
export MOUTH_OVR=${MOUTH_OVR:-'{"vis_E": {"jaw": 0.6, "open": 0.3}, "vis_F": {"jaw": 0.35, "open": 0.18}, "surprise": {"jaw": 0.6, "open": 0.28}}'}
if [ -z "$SKINS_ONLY" ]; then
# 1. форма и лицо — конвейер Блёстки p4 v3 (build_glitter_p4.sh) в рабочую папку, свои ориентиры лица
OUT="$W/p4" LAND=face_landmarks/cat_base.json sh build_glitter_p4.sh "$W/p4"
test -f "$W/p4/glitter_p4m.glb"
# 2. база: без одежды, торс под худи, атлас без одежды
python3 base_build.py "$W/p4/glitter_p4m.glb" "$W/p4/base_parts.json" $OUT/cat_base.glb
fi
# 3. скины: одежда на тот же скелет + вид (extras)
for c in glitter hooligan kind; do
  python3 skin_build.py $c "$W/p4/glitter_p4m.glb" "$W/p4/base_parts.json" $OUT/cat_base.glb $OUT/skin_$c.glb --work "$W"
done
# 4. прокси столкновений — по базе со скином (colliders.py по собранной модели)
for c in glitter hooligan kind; do
  python3 skin_build.py compose $OUT/cat_base.glb $OUT/skin_$c.glb "$W/full_$c.glb"
  python3 colliders.py $c "$W/full_$c.glb" $OUT/skin_${c}_colliders.json
done

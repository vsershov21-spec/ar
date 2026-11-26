#!/bin/sh
# Блёстка v5 — модель продакта из Tripo «как есть» (docs/models/README.md, раздел «Блёстка v5»):
#   sh scripts/models/build_glitter_v5.sh [work=/tmp/v5]
# Вход — design/models/glitter_v5_rigged.glb (Tripo: 4 вида, H3.1, Ultra, 4K PBR, одна цельная сетка ~19.8k треугольников,
# Auto Rig Humanoid/Mixamo — 52 кости). Вид Tripo не меняется: ни лица, ни текстуры, ни формы; добавляются скелет как у
# Хулигана, веки и морфы. Нужны /tmp/bpyenv/bin/python (pip install bpy==5.3.0 numpy scipy pillow) и python3 с numpy/scipy/pillow.
set -e
cd "$(dirname "$0")"
W=${1:-/tmp/v5}; BPY=${BPY:-/tmp/bpyenv/bin/python}
SRC=../../design/models/glitter_v5_rigged.glb
OUT=../../public/models/v2
mkdir -p "$W"
q() { grep -v "INFO\|^$\|Draco\|MeshOptimizer\|Deprecation\|use_nodes\|WARNING" || true; }
# 1. узлы-обёртки Tripo сняты (иначе кот лежит), арматура в начале координат
$BPY blender/p4_join.py -- $SRC "$W/joined.glb" 2>&1 | q
# 2. уши (find_parts.py, без золота банта) и хвост-«булава» (ось под пачкой → загиб вверх) → LeftEar1/RightEar1, Tail1..4
$BPY blender/dump.py -- "$W/joined.glb" /tmp/glitter5.npz 2>&1 | q
python3 blender/find_parts.py glitter5 > /dev/null
python3 v5/v5_parts.py glitter5 "$W/parts.png"
$BPY blender/rig_cat.py -- "$W/joined.glb" /tmp/glitter5_parts.npz "$W/rig0.glb" 2>&1 | q
# 3. концевые кости Mixamo (в скине Tripo их нет): HeadTop_End, *Toe_End, пальцы *4 — 71 кость, как у Хулигана
$BPY v5/v5_endbones.py -- "$W/rig0.glb" "$W/rigged.glb" 2>&1 | q
# 4. мимика поверх лица Tripo: веки Lids_V5, ключи рта/бровей/щёк (места концевых костей — как у исходника Tripo)
python3 v5/v5_face.py "$W/rigged.glb" "$W/face.glb" --src $SRC --viz "$W/viz"
# 5. текстуры 4K → 2048² (сборка — KTX2 1024²), без меха (мех — только для сравнения: v5_finish.py … --fur)
python3 v5/v5_finish.py "$W/face.glb" $OUT/glitter_v5.glb
python3 colliders.py glitter $OUT/glitter_v5.glb $OUT/glitter_v5_colliders.json

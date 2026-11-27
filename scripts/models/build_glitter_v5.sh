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
# 4. мимика поверх лица Tripo: сетка гуще на лице и у уголков рта (v5_dense — гладкие деформации), веки Lids_V5 (закрытое
#    накрывает и контур глаза Tripo; v5c — косые, «^», нижние), ключи рта/бровей по сторонам/щёк/глаз (места концевых
#    костей — как у исходника Tripo)
python3 v5/v5_dense.py "$W/rigged.glb" "$W/dense.glb"
python3 v5/v5_face.py "$W/dense.glb" "$W/face0.glb" --src $SRC --viz "$W/viz"
# 4b. v5c: накладка рта Mouth_V5 (кожа морды без рта + формы рта шейдером — src/character/v5Face.ts)
python3 v5/v5_mouth.py "$W/face0.glb" "$W/face1.glb" --viz "$W/viz"
# 4c. v5d: настоящие глаза поверх нарисованных — накладка Eyes_V5 (белок Tripo, радужка двигается шейдером, зрачок, блики);
#     в текстуре тела разрез глаза закрашен белком, ресницы в полосе века — мехом (их несёт веко Lids_V5); до меха —
#     цвет оболочек и прядей берётся с уже закрашенной текстуры
python3 v5/v5_eyes.py "$W/face1.glb" "$W/face.glb" --viz "$W/viz"
# 5. мех как у Хулигана/Добряка: оболочки тела (v5_fur), голова, щёки и пряди силуэта — общий fur_volume.py
#    (точки лица — asset.extras.glitterV5.marks); кончики — цвет текстуры Tripo, без тона меха
python3 v5/v5_fur.py "$W/face.glb" "$W/fur0.glb"
python3 fur_volume.py glitter "$W/fur0.glb" "$W/fur.glb"
# 6. текстуры 4K → 2048² (сборка — KTX2 1024²)
python3 v5/v5_finish.py "$W/fur.glb" $OUT/glitter_v5.glb
python3 colliders.py glitter $OUT/glitter_v5.glb $OUT/glitter_v5_colliders.json

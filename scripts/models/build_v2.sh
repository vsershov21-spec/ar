#!/bin/sh
# Сборка котов v2 (после body_detail): форма головы → наушники (Хулиган) / фатин (Блёстка) → развести проникновения →
# тон одежды → мех → одежда отдельными мешами → проверка проникновений → коллайдеры.
#   sh scripts/models/build_v2.sh <base_dir> <out_dir> [cat…]
# base_dir/<cat>.glb — GLB после body_detail.py (для текущих моделей: git show bb768e9^:public/models/<cat>_v1.glb).
# Результат — out_dir/<cat>_v2.glb + <cat>_colliders.json → public/models/v2/ (только ?models=v2, lab и /test;
# по умолчанию приложение грузит v1 — public/models/<cat>_v1.glb).
set -e
cd "$(dirname "$0")"
BASE=$1; OUT=$2; shift 2
CATS=${*:-hooligan kind glitter}
mkdir -p "$OUT"
[ -f "$OUT/anims_raw.glb" ] || node decompress_glb.mjs ../../public/models/anims_v1.glb "$OUT/anims_raw.glb"
for c in $CATS; do
  python3 head_shape.py $c "$BASE/$c.glb" "$OUT/${c}_1hs.glb"
  if [ $c = hooligan ]; then python3 headphones.py $c "$OUT/${c}_1hs.glb" "$OUT/${c}_1hs.glb"; fi
  if [ $c = glitter ]; then python3 tulle.py $c "$OUT/${c}_1hs.glb" "$OUT/${c}_1hs.glb"; fi
  python3 untangle.py $c "$OUT/${c}_1hs.glb" "$OUT/${c}_2un.glb"
  if [ $c = glitter ]; then python3 tulle.py $c "$OUT/${c}_2un.glb" "$OUT/${c}_2un.glb" --fit; fi
  python3 outfit_tone.py $c "$OUT/${c}_2un.glb" "$OUT/${c}_2un.glb"
  python3 fur_volume.py $c "$OUT/${c}_2un.glb" "$OUT/${c}_3fur.glb" --anims "$OUT/anims_raw.glb"
  python3 split_parts.py $c "$OUT/${c}_3fur.glb" "$OUT/${c}_v2.glb"
  python3 penetration.py $c "$OUT/${c}_v2.glb" "$OUT/anims_raw.glb" "$OUT/penetration_$c.md" --img "$OUT" ${POSES:+--poses $POSES}
  python3 colliders.py $c "$OUT/${c}_v2.glb" "$OUT/${c}_colliders.json" || true
done

#!/usr/bin/env bash
# Библиотека движений из нескольких выгрузок Tripo (один скелет Mixamo) → public/models/anims_v1.glb
# Usage: scripts/models/build_anim_lib.sh raw1.glb [raw2.glb ...]
set -euo pipefail
cd "$(dirname "$0")/../.."
G="npx -y @gltf-transform/cli@4"
tmp=$(mktemp -d); parts=()
i=0
for f in "$@"; do
  i=$((i+1)); python3 scripts/models/make_anim_lib.py "$f" "$tmp/p$i.glb" >/dev/null; parts+=("$tmp/p$i.glb")
done
if [ ${#parts[@]} -gt 1 ]; then $G merge "${parts[@]}" "$tmp/m.glb" >/dev/null; else cp "${parts[0]}" "$tmp/m.glb"; fi
$G prune "$tmp/m.glb" "$tmp/pr.glb" >/dev/null
$G resample "$tmp/pr.glb" "$tmp/rs.glb" >/dev/null
$G meshopt "$tmp/rs.glb" public/models/anims_v1.glb >/dev/null
python3 - <<'PY'
import json,struct
b=open('public/models/anims_v1.glb','rb').read(); l=struct.unpack('<I',b[12:16])[0]; j=json.loads(b[20:20+l])
n=sorted(set(a['name'] for a in j['animations'])); print(len(n),'клипов', round(len(b)/1e6,2),'МБ'); print([x for x in n if ' ' in x])
PY
rm -rf "$tmp"

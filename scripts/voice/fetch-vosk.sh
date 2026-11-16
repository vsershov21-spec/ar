#!/bin/bash
# Скачать офлайн-модель распознавания vosk-model-small-ru-0.22 (~45 МБ, Apache-2.0) и перепаковать в tar.gz,
# как ждёт vosk-browser (внутри — одна папка модели).
#   bash scripts/voice/fetch-vosk.sh [куда; по умолчанию public]  → <куда>/models/vosk-ru-small-0.22/model.tar.gz
# Нужны curl и python3 (unzip не обязателен). Если alphacephei.com закрыт — зеркало на HuggingFace (VOSK_URL=…).
set -euo pipefail
DEST=${1:-public}
URL=${VOSK_URL:-https://alphacephei.com/vosk/models/vosk-model-small-ru-0.22.zip}
MIRROR=https://huggingface.co/alphacep/vosk-model-small-ru/resolve/main/vosk-model-small-ru-0.22.zip
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fSL --retry 2 -o "$TMP/m.zip" "$URL" || curl -fSL --retry 2 -o "$TMP/m.zip" "$MIRROR"
mkdir -p "$DEST/models/vosk-ru-small-0.22"
python3 - "$TMP/m.zip" "$DEST/models/vosk-ru-small-0.22/model.tar.gz" <<'PY'
import io, sys, tarfile, zipfile
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
if bad: sys.exit('битый архив: ' + bad)
with tarfile.open(sys.argv[2] + '.tmp', 'w:gz') as t:
    for i in z.infolist():
        if i.is_dir(): continue
        d = z.read(i); ti = tarfile.TarInfo(i.filename); ti.size = len(d); ti.mtime = 1700000000; ti.mode = 0o644
        t.addfile(ti, io.BytesIO(d))
import os; os.replace(sys.argv[2] + '.tmp', sys.argv[2])
print('готово:', sys.argv[2], os.path.getsize(sys.argv[2]), 'байт')
PY

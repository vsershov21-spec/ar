#!/usr/bin/env bash
# Озвучка ElevenLabs на сервере swe — в фоне, возобновляемо, с логом.
#
#   bash scripts/voice/el-run.sh                 — свежий main во временную папку → пакет → синтез в фоне
#   bash scripts/voice/el-run.sh --plan          — только посчитать, сколько осталось (без сети к ElevenLabs)
#   bash scripts/voice/el-run.sh --only kind     — только один характер (или подстрока id)
#   tail -f /var/lib/vershov-commander/ar/el-run.log
#   EL_REF=<sha> EL_WORK=… EL_LOG=… — конкретный коммит вместо main, своя рабочая папка и лог (так зовёт ar-auto)
#
# Ключ — из /var/lib/vershov-commander/.elevenlabs_key (читает node внутри процесса, в лог и консоль не попадает).
# Вывод — /srv/ar-extra/voice-el (если папка доступна на запись), иначе /var/lib/vershov-commander/ar/voice-el;
# сборка сайта (scripts/voice/pull-server-voice.mjs) подхватит файлы при следующем push в main или пересборке.
# Уже озвученное (тот же текст, голос, модель) пропускается — повторный запуск продолжает с места остановки.
set -euo pipefail

BASE=/var/lib/vershov-commander/ar
LOG="${EL_LOG:-$BASE/el-run.log}"
WORK="${EL_WORK:-$BASE/el-work}"
REPO="${EL_REPO:-https://github.com/vsershov21-spec/ar.git}"
REF="${EL_REF:-main}"
mkdir -p "$BASE"

[ -f "$WORK/.git/HEAD" ] || { rm -rf "$WORK" && git clone -q --depth 1 -b main "$REPO" "$WORK"; }
git -C "$WORK" fetch -q --depth 1 origin "$REF" && git -C "$WORK" reset -q --hard FETCH_HEAD
cd "$WORK"
# три зависимости синтеза (wasm, без нативной сборки — домашняя папка может быть noexec)
if [ ! -d node_modules/mpg123-decoder ] || [ ! -d node_modules/wasm-media-encoders ] || [ ! -d node_modules/amaro ]; then
  npm install --no-save --no-audit --no-fund --ignore-scripts mpg123-decoder wasm-media-encoders amaro >/dev/null
fi
# espeak-ng для русских фонем липсинка — из комплекта Piper (домашняя папка noexec, поэтому копия в /tmp)
if [ ! -e /tmp/piper/espeak-ng ] && [ -d /var/lib/vershov-commander/piper ]; then
  mkdir -p /tmp/piper && cp -a /var/lib/vershov-commander/piper/. /tmp/piper/ 2>/dev/null || true
fi
# пакет должен совпадать с репликами (его коммитят вместе с ними; пересобрать — дёшево и без сети)
node scripts/voice/el-batch.mjs >/dev/null

if [[ " $* " == *" --plan "* ]]; then
  exec node scripts/voice/eleven.mjs --batch voice-src/el_batch_all.jsonl --plan "$@"
fi
if pgrep -f "eleven.mjs --batch" >/dev/null; then
  echo "Уже идёт озвучка (pgrep eleven.mjs). Лог: $LOG"
  exit 0
fi
echo "=== $(date -Is) el-run $* ===" >>"$LOG"
nohup setsid node scripts/voice/eleven.mjs --batch voice-src/el_batch_all.jsonl --run "$@" >>"$LOG" 2>&1 < /dev/null &
echo "Озвучка запущена в фоне (pid $!). Лог: tail -f $LOG"

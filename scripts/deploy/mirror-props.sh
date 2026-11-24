#!/usr/bin/env bash
# Без трат кредитов: зеркало пропсов сервера (/srv/ar-extra/models/props/*.glb, *.png) → ветка server-out, out/latest/props/.
# Зачем: часть пропсов (bed.glb от Meshy и др.) лежит только на сервере, в git их нет — для локальной проверки на стенде.
# Запуск задачей ar-auto (root): node scripts/automation/enqueue.mjs script scripts/deploy/mirror-props.sh --id mirror-props-<…> [-- bed sofa]
#   аргументы (необязательно) — имена без расширения: только они, дописываются к уже выгруженным; без аргументов — все
#   файлы заново. Файл > 30 МБ пропускается (см. _mirror.json — что скопировано последним запуском).
# Пишет прямо в выгрузку ar-auto ($AUTO_VAR/out/latest/props, по умолчанию /var/lib/ar-auto/out) и помечает её «dirty» —
# ar-auto выгрузит вместе с итогом задачи. Можно вручную: sudo bash mirror-props.sh && sudo ar-auto push
set -u
umask 022 # выгрузка читаема всеми, даже если исходник root:root 600 (ar-auto работает с umask 077)
SRC=${PROPS_SRC:-/srv/ar-extra/models/props}
VAR=${AUTO_VAR:-/var/lib/ar-auto}
DST="$VAR/out/latest/props"
MAX=$((30 * 1024 * 1024))
echo "=== $(date -Is) mirror-props: $SRC → $DST ==="
[ -d "$SRC" ] || { echo "нет $SRC"; exit 1; }
[ -d "$VAR/out" ] || { echo "нет $VAR/out (ar-auto не установлен?)"; exit 1; }
for a in "$@"; do [[ "$a" =~ ^[a-z0-9_]+$ ]] || { echo "плохое имя: $a (нужно [a-z0-9_])"; exit 2; }; done

tmp=$(mktemp -d "$VAR/props-XXXXXX") || exit 1
trap 'rm -rf "$tmp"' EXIT
n=0; skipped=""; list=""
shopt -s nullglob
for p in "$SRC"/*.glb "$SRC"/*.png; do
  f=$(basename "$p"); base=${f%.*}
  [[ "$f" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo "пропуск (имя): $f"; continue; }
  if [ $# -gt 0 ]; then ok=0; for a in "$@"; do [ "$a" = "$base" ] && ok=1; done; [ $ok = 1 ] || continue; fi
  sz=$(stat -c %s "$p")
  if [ "$sz" -gt "$MAX" ]; then echo "пропуск (> 30 МБ): $f $sz"; skipped="$skipped{\"file\":\"$f\",\"bytes\":$sz},"; continue; fi
  cp --preserve=timestamps "$p" "$tmp/$f" || continue # без -p: режим 600 исходника не тащим
  sha=$(sha256sum "$p" | cut -c1-64); mt=$(date -u -d "@$(stat -c %Y "$p")" +%FT%TZ)
  echo "$f $sz $sha $mt"
  list="$list{\"file\":\"$f\",\"bytes\":$sz,\"sha256\":\"$sha\",\"mtime\":\"$mt\"},"
  n=$((n + 1))
done
printf '{"updated":"%s","src":"%s","copied":%d,"files":[%s],"skipped":[%s]}\n' "$(date -u +%FT%TZ)" "$SRC" "$n" "${list%,}" "${skipped%,}" > "$tmp/_mirror.json"
if [ $# -gt 0 ] && [ -d "$DST" ]; then
  # с именами — дописать к уже выгруженному (не стирать пропсы, выгруженные раньше без фильтра)
  cp --preserve=timestamps "$tmp"/* "$DST"/ && rm -rf "$tmp" || { echo "не удалось записать $DST"; exit 1; }
else
  rm -rf "$DST" && mkdir -p "$(dirname "$DST")" && mv "$tmp" "$DST" && chmod 755 "$DST" || { echo "не удалось записать $DST"; exit 1; }
fi
trap - EXIT
date -Is > "$VAR/dirty"
echo "готово: $n файлов → out/latest/props/ (выгрузка в server-out — вместе с итогом задачи)"

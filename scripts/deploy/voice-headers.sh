#!/usr/bin/env bash
# Проверка заголовков озвучки на сайте (только чтение, можно с любого компьютера с curl):
#   curl -fsSL https://raw.githubusercontent.com/vsershov21-spec/ar/main/scripts/deploy/voice-headers.sh | bash
#   H=https://ar.vershov.com P=kind N=5 bash scripts/deploy/voice-headers.sh     # кот (kind — Добряк), сколько mp3
#   ALL=1 bash scripts/deploy/voice-headers.sh                                   # + HEAD на каждый mp3 манифеста
# Что проверяет (iPhone 22.11: «звук зависал и не грузился»):
#   манифест voice/el/manifest.json — 200, JSON, Cache-Control no-cache (после пересборки хэши файлов новые);
#   mp3 — 200, audio/mpeg, БЕЗ Content-Encoding (mp3 не жмётся повторно), Content-Length = скачанному, начало файла —
#   MP3 (ID3 / кадр), Cache-Control immutable; Range bytes=0-99 → 206 и 100 байт (Safari <audio> и докачка);
#   ALL=1 — каждый файл манифеста отвечает 200 (рассинхрон манифеста и файлов после пересборки).
# Итог: OK / ВНИМАНИЕ (кэш не настроен — работает, но медленнее) / ПЛОХО (звук сломан); код выхода 1 при ПЛОХО.
set -u
H=${H:-https://ar.vershov.com}
P=${P:-kind}
N=${N:-5}
AE='Accept-Encoding: gzip, deflate, br, zstd'
UA='User-Agent: Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'
bad=0; warn=0
hdr() { tr -d '\r' | awk -F': ' -v k="$1" 'tolower($1)==k{print $2}' | head -1; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT

echo "=== озвучка $H (кот $P) ==="
code=$(curl -s -o "$T/man.json" -D "$T/man.h" -H "$AE" -H "$UA" --compressed -w '%{http_code}' "$H/voice/el/manifest.json")
ct=$(hdr content-type < "$T/man.h"); cc=$(hdr cache-control < "$T/man.h"); ce=$(hdr content-encoding < "$T/man.h")
echo "manifest: $code  type=$ct  encoding=${ce:-нет}  cache=${cc:-нет}  $(wc -c < "$T/man.json") байт"
[ "$code" = 200 ] && printf '%s' "$ct" | grep -qi json || { echo "  ПЛОХО: манифест не отдаётся как JSON"; exit 1; }
printf '%s' "$cc" | grep -qi 'no-cache\|no-store\|max-age=0' || { echo "  ВНИМАНИЕ: у манифеста нет no-cache (приложение всё равно спрашивает с cache:no-cache, но прокси/CDN могут держать старый)"; warn=1; }

FILES=$(grep -o '"f":"el/[^"]*\.mp3"' "$T/man.json" | cut -d'"' -f4)
TOTAL=$(printf '%s\n' "$FILES" | grep -c . || true)
SAMPLE=$(printf '%s\n' "$FILES" | grep "^el/$P/" | head -n "$N")
[ -n "$SAMPLE" ] || SAMPLE=$(printf '%s\n' "$FILES" | head -n "$N")
echo "в манифесте mp3: $TOTAL; проверяю $(printf '%s\n' "$SAMPLE" | grep -c .)"
for f in $SAMPLE; do
  u="$H/voice/$f"
  code=$(curl -s -o "$T/a.mp3" -D "$T/a.h" -H "$AE" -H "$UA" -w '%{http_code}' "$u")
  ct=$(hdr content-type < "$T/a.h"); ce=$(hdr content-encoding < "$T/a.h"); cl=$(hdr content-length < "$T/a.h"); cc=$(hdr cache-control < "$T/a.h")
  got=$(wc -c < "$T/a.mp3"); magic=$(head -c 3 "$T/a.mp3" | od -An -tx1 | tr -d ' \n')
  rcode=$(curl -s -o "$T/r.bin" -D "$T/r.h" -H "$UA" -H 'Range: bytes=0-99' -w '%{http_code}' "$u"); rlen=$(wc -c < "$T/r.bin"); cr=$(hdr content-range < "$T/r.h")
  echo "$(basename "$f"): $code $ct enc=${ce:-нет} len=${cl:-нет}/$got magic=$magic cache=${cc:-нет} | range $rcode ${cr:-} ($rlen б)"
  [ "$code" = 200 ] || { echo "  ПЛОХО: $code (файла из манифеста нет — манифест и файлы рассинхронизированы?)"; bad=1; continue; }
  printf '%s' "$ct" | grep -qi 'audio/mpeg' || { echo "  ВНИМАНИЕ: Content-Type не audio/mpeg"; warn=1; }
  [ -z "$ce" ] || [ "$ce" = identity ] || { echo "  ПЛОХО: mp3 сжат повторно (Content-Encoding: $ce) — убрать audio/* и octet-stream из encode"; bad=1; }
  [ -n "$cl" ] && [ "$cl" = "$got" ] || { echo "  ВНИМАНИЕ: Content-Length (${cl:-нет}) ≠ скачано ($got)"; warn=1; }
  case "$magic" in 494433*|fff*|ffe*) ;; *) echo "  ПЛОХО: начало файла не MP3 ($magic)"; bad=1 ;; esac
  printf '%s' "$cc" | grep -qi immutable || { echo "  ВНИМАНИЕ: нет Cache-Control immutable (имена с хэшем — можно кэшировать на год; scripts/deploy/caddy-encode.sh)"; warn=1; }
  [ "$rcode" = 206 ] && [ "$rlen" = 100 ] || { echo "  ВНИМАНИЕ: Range → $rcode / $rlen байт (ждём 206 / 100)"; warn=1; }
done

if [ "${ALL:-0}" = 1 ]; then
  echo "--- HEAD на все $TOTAL mp3 ---"
  miss=$(printf '%s\n' $FILES | xargs -P 8 -I{} sh -c 'c=$(curl -s -o /dev/null -I -w "%{http_code}" "$0/voice/{}"); [ "$c" = 200 ] || echo "$c {}"' "$H")
  if [ -n "$miss" ]; then echo "  ПЛОХО: не отвечают $(printf '%s\n' "$miss" | grep -c .):"; printf '%s\n' "$miss" | head -10; bad=1; else echo "  все 200"; fi
fi
if [ "$bad" = 1 ]; then echo "ИТОГ: ПЛОХО"; exit 1; fi
[ "$warn" = 1 ] && echo "ИТОГ: ВНИМАНИЕ (звук работает, кэш/заголовки не идеальны)" || echo "ИТОГ: OK"

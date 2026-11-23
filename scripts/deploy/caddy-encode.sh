#!/usr/bin/env bash
# Caddy на swe (root): сжатие ответов сайта ar.vershov.com — и текста, и моделей/движений кота (docs/qa/ui/quick/SPEED.md).
# `encode` Caddy по умолчанию жмёт только свой список типов (text/*, json, js, wasm, svg…): .glb (model/gltf-binary или
# application/octet-stream), .bin, .ktx2, .mind уходили как есть. Модели и движения уже сжаты meshopt — его вывод
# рассчитан на gzip/zstd поверх: движения 1,4 → 0,6 МБ, модель кота 2,1 → 1,5 МБ.
#
# Что делает (с бэкапом и откатом, как progress-handle.sh / pilot-setup.sh):
#   1) в блоке `ar.vershov.com { … }` прежние директивы `encode` (строкой или блоком, на любом уровне) — в комментарий
#      с пометкой `# caddy-encode.sh:` (иначе ответ мог бы сжиматься дважды); свой блок — между метками
#      `# >>> caddy-encode` / `# <<< caddy-encode` сразу после строки `ar.vershov.com {` (повторный запуск — заменяет его);
#   2) `caddy validate` → `systemctl reload caddy`; не прошло — откат на бэкап;
#   3) проверки curl с Accept-Encoding: модель кота, пакет движений, транскодер (wasm), js, index.html пилота — сжаты;
#      /mvp/ — 200 и no-cache, /lab/ — 200, /api/progress/health — ok, Range-запрос модели — 206. Что-то сломалось
#      (страница, API) — откат и reload.
# Блоки /mvp, /lab, /api/progress (handle, rewrite, header) не трогаются.
# Озвучка (тот же свой блок): /voice/el/*.mp3 — имена с хэшем содержимого → immutable на год; /voice/el/manifest.json —
# no-cache (после пересборки — новые хэши; старый манифест в кэше ссылался бы на удалённые файлы). mp3 (audio/mpeg) в
# список сжатия НЕ входит: повторно не жмётся, Content-Length и Range (206) — как у file_server. Проверка — voice-headers.sh.
#
# Запуск в фоне (reload Caddy не рвёт сессию), REF — коммит или ветка:
#   REF=<коммит>; curl -fsSL https://raw.githubusercontent.com/vsershov21-spec/ar/$REF/scripts/deploy/caddy-encode.sh -o /tmp/caddy-encode.sh \
#     && nohup bash /tmp/caddy-encode.sh >/tmp/caddy-encode.log 2>&1 &
#   sleep 20; cat /tmp/caddy-encode.log
# DRY=1 — только показать, что получится (без записи и reload).
set -u
CF=${CF:-/etc/caddy/Caddyfile}
H=${H:-https://ar.vershov.com}
SITE='ar.vershov.com'
echo "=== $(date -Is) caddy-encode ($(caddy version 2>/dev/null | head -1)) ==="
[ -f "$CF" ] || { echo "нет $CF — ничего не делаю"; exit 1; }
if ! grep -q "^${SITE//./\\.} {" "$CF"; then echo "не нашёл строку '$SITE {' в $CF — ничего не делаю"; exit 1; fi
NEW=$(mktemp)

# свой блок: текст (как по умолчанию у Caddy) + модели, движения, wasm, ktx2, бинарные ассеты
SNIP=$(mktemp)
cat > "$SNIP" <<'EOF'
	# >>> caddy-encode (scripts/deploy/caddy-encode.sh): сжатие ответов — текст + модели/движения кота (.glb), wasm, ktx2
	encode {
		zstd
		gzip 6
		minimum_length 1024
		match {
			header Content-Type text/*
			header Content-Type application/json*
			header Content-Type application/manifest+json*
			header Content-Type application/javascript*
			header Content-Type application/x-javascript*
			header Content-Type application/xml*
			header Content-Type application/wasm*
			header Content-Type image/svg+xml*
			header Content-Type font/*
			header Content-Type model/gltf-binary*
			header Content-Type model/gltf+json*
			header Content-Type image/ktx2*
			header Content-Type application/octet-stream*
		}
	}
	@voiceMp3 path /voice/el/*.mp3 /voice/el/*/*.mp3
	header @voiceMp3 Cache-Control "public, max-age=31536000, immutable"
	@voiceManifest path /voice/el/manifest.json
	header @voiceManifest Cache-Control "no-cache"
	# <<< caddy-encode
EOF

# 1) прежний свой блок — прочь; чужие encode в блоке сайта — в комментарий; свой — сразу после строки сайта
awk -v site="$SITE {" -v snip="$SNIP" '
  function emit_snip(   l) { while ((getline l < snip) > 0) print l; close(snip) }
  BEGIN { insite = 0; depth = 0; mine = 0; enc = 0 }
  {
    line = $0
    if (!insite && line == site) { print line; emit_snip(); insite = 1; depth = 1; next }
    if (!insite) { print line; next }
    if (line ~ /# >>> caddy-encode/) { mine = 1; next }
    if (mine) { if (line ~ /# <<< caddy-encode/) mine = 0; next }
    t = line; sub(/^[ \t]+/, "", t)
    # чужой encode: строкой (`encode zstd gzip`) или блоком (`encode {` … `}`)
    if (enc > 0 || t ~ /^encode([ \t]|$)/) {
      print "# caddy-encode.sh: " line
      o = gsub(/\{/, "{", t); c = gsub(/\}/, "}", t)
      if (enc == 0 && o > c) enc = o - c
      else if (enc > 0) enc += o - c
      if (enc < 0) enc = 0
      next
    }
    o = gsub(/\{/, "{", t); c = gsub(/\}/, "}", t)
    depth += o - c
    print line
    if (depth <= 0) insite = 0
  }' "$CF" > "$NEW"
rm -f "$SNIP"

echo "--- блок $SITE (новый) ---"; awk -v site="$SITE {" '$0==site{p=1} p{print} p&&/^\}/{exit}' "$NEW"
if [ "${DRY:-0}" = 1 ]; then echo "DRY=1 — без записи"; rm -f "$NEW"; exit 0; fi
BAK="$CF.bak.$(date +%s)"; cp "$CF" "$BAK"; echo "бэкап: $BAK"

rollback() {
  echo "ОТКАТ на $BAK: $1"
  cp "$BAK" "$CF"
  caddy validate --adapter caddyfile --config "$CF" >/dev/null 2>&1 && systemctl reload caddy && echo "откат: CADDY OK"
}

# 2) проверка и reload
if ! caddy validate --adapter caddyfile --config "$NEW" >/dev/null 2>&1; then
  echo "CADDY FAIL (validate) — файл не меняю:"; caddy validate --adapter caddyfile --config "$NEW" 2>&1 | tail -5
  rm -f "$NEW"; exit 1
fi
cat "$NEW" > "$CF"; rm -f "$NEW"
sleep 1
if ! systemctl reload caddy; then rollback "reload не прошёл"; exit 1; fi
echo "CADDY OK"
sleep 3

# 3) проверки
ACC='Accept-Encoding: zstd, gzip'
enc_of() { curl -s -o /dev/null -D - -H "$ACC" "$1" | tr -d '\r' | awk -F': ' 'tolower($1)=="content-encoding"{print $2}' | head -1; }
size_of() { curl -s -o /dev/null -w '%{size_download}' ${2:+-H "$2"} "$1"; }
check() { # url метка
  local u="$1" e raw z
  e=$(enc_of "$u"); raw=$(size_of "$u"); z=$(size_of "$u" "$ACC")
  printf '%-14s %-6s %8s → %8s байт  %s\n' "$2" "${e:-нет}" "$raw" "$z" "$u"
  [ -n "$e" ]
}
fail=0
HTML=$(curl -s "$H/mvp/")
JS=$(printf '%s' "$HTML" | grep -o '/mvp/assets/main-[^"]*\.js' | head -1)
[ -n "$JS" ] || { echo "ВНИМАНИЕ: в /mvp/ не нашёл main-*.js"; fail=1; }
BODY=$([ -n "$JS" ] && curl -s "$H$JS")
START=$(printf '%s' "$BODY" | grep -o 'models/opt/anims_v1\.start\.[0-9a-f]*\.glb' | head -1)
CAT=$(printf '%s' "$BODY" | grep -o 'models/v2/opt/hooligan_p1\.[0-9a-f]*\.glb' | head -1)
WASM=$(curl -s "$H/mvp/" | grep -o '/mvp/assets/[^"]*\.js' | while read -r a; do curl -s "$H$a" | grep -o 'basis_transcoder-[A-Za-z0-9_-]*\.wasm' ; done | head -1)
echo "--- сжатие (заголовок Content-Encoding, байт без сжатия → со сжатием) ---"
check "$H/mvp/" "index пилота" || echo "  (index.html короткий или без сжатия)"
[ -n "$JS" ] && { check "$H$JS" "main.js" || fail=1; }
check "$H/models/anims_v1.glb" "движения (вся)" || fail=1
[ -n "$START" ] && { check "$H/$START" "движения старт" || fail=1; } || echo "пакет движений ещё не опубликован (ar-update) — проверка позже"
[ -n "$CAT" ] && { check "$H/$CAT" "модель кота" || fail=1; } || check "$H/models/v2/hooligan_p1.glb" "модель (исх.)" || fail=1
[ -n "$WASM" ] && { check "$H/mvp/assets/$WASM" "транскодер" || fail=1; }
echo "--- не сломалось ---"
code=$(curl -s -o /dev/null -w '%{http_code}' "$H/mvp/"); cc=$(curl -sI "$H/mvp/" | tr -d '\r' | grep -i '^cache-control' | head -1)
echo "mvp/:        $code  $cc"; [ "$code" = 200 ] || fail=2
echo "mvp deep:    $(curl -s "$H/mvp/x/y" | grep -o '/mvp/assets/main-[^"]*' | head -1)"
code=$(curl -s -o /dev/null -w '%{http_code}' "$H/lab/"); echo "lab/:        $code"; [ "$code" = 200 ] || fail=2
api=$(curl -s "$H/api/progress/health"); echo "api health:  $api"; printf '%s' "$api" | grep -q '"ok"\|ok' || fail=2
rng=$(curl -s -o /dev/null -w '%{http_code}' -H 'Range: bytes=0-99' "$H/models/anims_v1.glb"); echo "range:       $rng (ждём 206)"
echo "root /:      $(curl -s -o /dev/null -w '%{http_code}' "$H/")"
echo "--- озвучка (scripts/deploy/voice-headers.sh) ---"
[ -f "$(dirname "$0")/voice-headers.sh" ] && H="$H" bash "$(dirname "$0")/voice-headers.sh" || echo "(voice-headers.sh рядом нет — curl -fsSL …/scripts/deploy/voice-headers.sh | bash)"
if [ "$fail" = 2 ]; then rollback "сайт или API не отвечают как раньше"; exit 1; fi
[ "$fail" = 1 ] && echo "ВНИМАНИЕ: не всё сжимается (см. выше: типы Content-Type) — блок оставлен, сайт работает"
echo "=== done ==="

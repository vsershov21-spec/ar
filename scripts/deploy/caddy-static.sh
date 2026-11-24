#!/usr/bin/env bash
# Caddy на swe (root): статика ar.vershov.com терминальная, кэш — по существованию файла (PERF-02, аудит пилота 24.11).
#
# Было: неизвестный /mvp/assets/*.js, /models/*.glb и т. п. уходил в `try_files {path} /index.html` — отдавался HTML
# корня с 200 и `Cache-Control: immutable` на год (правила @assets / @pilotAssets / @labAssets ставили его по пути,
# не глядя, есть ли файл). Старая страница получала HTML вместо JS и висела на «Будим…» (BOOT-01).
# Стало (свой блок между `# >>> caddy-static` и `# <<< caddy-static` сразу после строки `ar.vershov.com {`):
#   · статика (папки ассетов, моделей, звука, озвучки и любые *.js/*.glb/*.wasm/… по расширению) — `handle` с
#     `file_server` без фолбэка: нет файла → 404 с `Cache-Control: no-store`, никакого HTML;
#   · `immutable` на год — только существующим файлам с хэшем в имени: /assets, /mvp/assets, /lab/assets,
#     /test/assets (vite), /models/opt (сжатые модели), /voice/el/*.mp3;
#   · существующие файлы без хэша (/models/*.glb, Vosk, звуки, видео, маркеры) — `max-age=86400` (ревалидация по ETag);
#   · HTML (всё, что не статика и не /api) — `no-cache`: телефон ревалидирует страницу при каждом открытии;
#   · в @pilot / @lab (SPA-фолбэк редакций, pilot-setup.sh / lab-setup.sh) — исключение путей с расширениями статики,
#     иначе /mvp/<что-то>.js переписывался бы в /mvp/index.html до handle.
#   Прежние строки @assets / @pilotAssets / @labAssets (и их header) — в комментарий с пометкой `# caddy-static.sh: `.
#   Повторный запуск: сначала всё своё откатывается (комментарии раскрываются, вставки и блок — прочь), потом ставится заново.
# Окно совместимости (старый HTML грузит свои чанки): scripts/build/keep-assets.mjs (шаг npm run build) — ассеты
# прошлых релизов симлинками в пул /srv/ar/asset-pool, 48 ч. Здесь — только проверка, что они отдаются.
#
#   caddy validate → systemctl reload caddy; не прошло — файл не меняется / откат на бэкап. Проверки curl (ниже):
#   сломалась страница или API — откат и reload; не выполнена политика кэша/404 — блок оставлен, код выхода 1.
#
# Запуск — задачей ar-auto (scripts/automation/enqueue.mjs script scripts/deploy/caddy-static.sh [--env DRY=1]).
# DRY=1 — показать блок сайта и проверить новый файл `caddy validate`, без записи и reload (DRY_OUT=<файл> — сохранить его).
set -u
CF=${CF:-/etc/caddy/Caddyfile}
H=${H:-https://ar.vershov.com}
SITE='ar.vershov.com'
POOL=${POOL:-/srv/ar/asset-pool}
CUR=${CUR:-/srv/ar/current}
TAG='caddy-static.sh'
echo "=== $(date -Is) caddy-static ($(caddy version 2>/dev/null | head -1)) ==="
[ -f "$CF" ] || { echo "нет $CF — ничего не делаю"; exit 1; }
if ! grep -q "^${SITE//./\\.} {" "$CF"; then echo "не нашёл строку '$SITE {' в $CF — ничего не делаю"; exit 1; fi

# пути статики и расширения (одни и те же в handle, в @arHtml и в исключениях SPA-фолбэка)
DIRS='/assets/* /mvp/assets/* /lab/assets/* /test/assets/* /models/* /sounds/* /video/* /targets/* /stickers/* /voice/* /personas/*'
EXTS='*.js *.mjs *.css *.map *.glb *.gltf *.bin *.wasm *.ktx2 *.mind *.gz *.mp3 *.m4a *.wav *.webp *.png *.jpg'
EXT_RE='[.](js|mjs|css|map|glb|gltf|bin|wasm|ktx2|mind|gz|mp3|m4a|wav|webp|png|jpg)$'
HASHED_RE='^/((mvp|lab|test)/)?assets/|^/models/opt/|^/voice/el/.+[.]mp3$'
PLAIN_SKIP_RE='^/((mvp|lab|test)/)?assets/|^/models/opt/|^/voice/|^/personas/'

SNIP=$(mktemp)
cat > "$SNIP" <<EOF
	# >>> caddy-static (scripts/deploy/caddy-static.sh): статика терминальная, кэш по существованию файла (PERF-02)
	@arStatic path $DIRS $EXTS
	handle @arStatic {
		@arHashed {
			path_regexp arHashed $HASHED_RE
			file
		}
		header @arHashed Cache-Control "public, max-age=31536000, immutable"
		@arPlain {
			not path_regexp $PLAIN_SKIP_RE
			file
		}
		header @arPlain Cache-Control "public, max-age=86400"
		@arMissing not file
		header @arMissing Cache-Control "no-store"
		file_server
	}
	@arHtml {
		not path /api/*
		not path $DIRS $EXTS
	}
	header @arHtml Cache-Control "no-cache"
	# <<< caddy-static
EOF

NEW=$(mktemp)
# 0) откат прежнего своего (идемпотентность) → 1) свой блок после строки сайта; старые правила кэша — в комментарий;
#    в @pilot/@lab после `not path /<ред>/assets/*` — исключение расширений статики
awk -v site="$SITE {" -v snip="$SNIP" -v tag="$TAG" -v extre="$EXT_RE" '
  function emit_snip(   l) { while ((getline l < snip) > 0) print l; close(snip) }
  BEGIN { insite = 0; depth = 0; mine = 0; pre = "# " tag ": " }
  {
    line = $0
    # раскрыть свои прежние комментарии
    if (index(line, pre) == 1) line = substr(line, length(pre) + 1)
    # свои прежние вставки — прочь
    if (line ~ ("# " tag "\\+$")) next
    if (!insite && line == site) { print line; emit_snip(); insite = 1; depth = 1; next }
    if (!insite) { print line; next }
    if (line ~ /# >>> caddy-static/) { mine = 1; next }
    if (mine) { if (line ~ /# <<< caddy-static/) mine = 0; next }
    t = line; sub(/^[ \t]+/, "", t)
    if (t ~ /^@(assets|pilotAssets|labAssets)[ \t]+path[ \t]/ || t ~ /^header[ \t]+@(assets|pilotAssets|labAssets)[ \t]/) { print pre line; next }
    o = gsub(/\{/, "{", t); c = gsub(/\}/, "}", t)
    depth += o - c
    print line
    if (t ~ /^not path \/(mvp|lab)\/assets\/\*$/) { ind = line; sub(/[^ \t].*$/, "", ind); print ind "not path_regexp " extre " # " tag "+" }
    if (depth <= 0) insite = 0
  }' "$CF" > "$NEW"
rm -f "$SNIP"

echo "--- блок $SITE (новый) ---"; awk -v site="$SITE {" '$0==site{p=1} p{print} p&&/^\}/{exit}' "$NEW"
if ! caddy validate --adapter caddyfile --config "$NEW" >/tmp/caddy-static.validate 2>&1; then
  echo "CADDY FAIL (validate) — файл не меняю:"; tail -8 /tmp/caddy-static.validate
  rm -f "$NEW"; exit 1
fi
echo "validate: OK"
if [ "${DRY:-0}" = 1 ]; then echo "DRY=1 — без записи и reload"; [ -n "${DRY_OUT:-}" ] && cp "$NEW" "$DRY_OUT"; rm -f "$NEW"; exit 0; fi
BAK="$CF.bak.$(date +%s)"; cp "$CF" "$BAK"; echo "бэкап: $BAK"
rollback() {
  echo "ОТКАТ на $BAK: $1"
  cp "$BAK" "$CF"
  caddy validate --adapter caddyfile --config "$CF" >/dev/null 2>&1 && systemctl reload caddy && echo "откат: CADDY OK"
}
cat "$NEW" > "$CF"; rm -f "$NEW"
sleep 1
if ! systemctl reload caddy; then rollback "reload не прошёл"; exit 1; fi
echo "CADDY OK"
sleep 3

# ── проверки ──
hdr() { curl -sI "$@" | tr -d '\r'; }   # HEAD: архив Vosk (46 МБ) не качаем
code_of() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
hval() { awk -F': ' -v k="$1" 'tolower($1)==k{print $2; exit}'; }
broke=0; policy=0
show() { # url метка → печать «код type cache-control»
  local h c t cc
  h=$(hdr "$1"); c=$(printf '%s' "$h" | awk 'NR==1{print $2}'); t=$(printf '%s' "$h" | hval content-type); cc=$(printf '%s' "$h" | hval cache-control)
  printf '%-22s %s  %-34s %-40s %s\n' "$2" "$c" "${t:-—}" "${cc:-—}" "$1"
  R_CODE=$c; R_TYPE=$t; R_CC=$cc
}
echo "--- curl -I: код, Content-Type, Cache-Control (существующие / несуществующие) ---"
HTML=$(curl -s "$H/mvp/")
JS=$(printf '%s' "$HTML" | grep -o '/mvp/assets/main-[^"]*\.js' | head -1)
show "$H/mvp/" "mvp/ (HTML)"; [ "$R_CODE" = 200 ] || broke=1; printf '%s' "$R_CC" | grep -q 'no-cache' || { echo "  ✗ HTML пилота без no-cache"; policy=1; }
show "$H/" "корень (HTML)"; [ "$R_CODE" = 200 ] || broke=1; printf '%s' "$R_CC" | grep -q 'no-cache' || { echo "  ✗ HTML корня без no-cache"; policy=1; }
show "$H/mvp/x/y" "mvp deep (HTML)"; [ "$R_CODE" = 200 ] || broke=1
echo "mvp deep → $(curl -s "$H/mvp/x/y" | grep -o '/mvp/assets/main-[^"]*' | head -1)"
show "$H/lab/" "lab/ (HTML)"; [ "$R_CODE" = 200 ] || broke=1
if [ -n "$JS" ]; then
  show "$H$JS" "main.js (есть)"; [ "$R_CODE" = 200 ] && printf '%s' "$R_TYPE" | grep -qi javascript || broke=1
  printf '%s' "$R_CC" | grep -q immutable || { echo "  ✗ существующий хэш-ассет без immutable"; policy=1; }
else echo "ВНИМАНИЕ: в /mvp/ не нашёл main-*.js"; broke=1; fi
GLB=$(cd "$CUR" 2>/dev/null && ls models/opt/*.glb 2>/dev/null | head -1)
[ -n "$GLB" ] && { show "$H/$GLB" "models/opt (есть)"; [ "$R_CODE" = 200 ] || broke=1; printf '%s' "$R_CC" | grep -q immutable || policy=1; }
show "$H/models/anims_v1.glb" "модель без хэша"; [ "$R_CODE" = 200 ] || broke=1
printf '%s' "$R_CC" | grep -q immutable && { echo "  ✗ файл без хэша — immutable"; policy=1; }
echo "range:                 $(code_of -H 'Range: bytes=0-99' "$H/models/anims_v1.glb") (ждём 206)"
show "$H/models/vosk-ru-small-0.22/model.tar.gz" "Vosk (есть?)"
show "$H/voice/el/manifest.json" "манифест озвучки"
for u in /mvp/assets/main-NOPE0000.js /assets/nope-0000.js /lab/assets/nope-0000.js /models/opt/nope.0000000000.glb /models/nope.glb /mvp/assets/basis_transcoder-NOPE.wasm /mvp/nope.js /voice/el/nope.0000.mp3 /models/vosk-nope/model.tar.gz; do
  show "$H$u" "нет файла"
  if [ "$R_CODE" != 404 ] || printf '%s' "$R_TYPE" | grep -qi 'text/html' || printf '%s' "$R_CC" | grep -q immutable; then echo "  ✗ ждём 404 без HTML и без immutable"; policy=1; fi
done
echo "--- окно совместимости (scripts/build/keep-assets.mjs, пул $POOL) ---"
if [ -d "$POOL" ]; then
  OLD=$(cd "$POOL" && ls mvp/assets 2>/dev/null | while read -r f; do [ -f "$CUR/mvp/assets/$f" ] && [ ! -L "$CUR/mvp/assets/$f" ] || { echo "mvp/assets/$f"; break; }; done)
  echo "пул: $(find "$POOL" -type f ! -name '.index.json' | wc -l) файлов, $(du -sh "$POOL" | cut -f1); в текущем релизе симлинков: $(find "$CUR"/ -type l 2>/dev/null | wc -l)"
  if [ -n "$OLD" ]; then
    show "$H/$OLD" "ассет прошлого релиза"
    if [ "$R_CODE" != 200 ] || printf '%s' "$R_TYPE" | grep -qi 'text/html'; then echo "  ✗ старый HTML не получит свой JS"; policy=1; fi
  else echo "в пуле нет ассетов прошлых релизов (ещё не было сборки после keep-assets)"; fi
else echo "пула нет — сборка с keep-assets ещё не прошла (ar-update)"; fi
echo "--- не сломалось ---"
api=$(curl -s "$H/api/progress/health"); echo "api health:  $api"; printf '%s' "$api" | grep -q 'ok' || broke=1
echo "voice-headers.sh:"; [ -f "$(dirname "$0")/voice-headers.sh" ] && H="$H" bash "$(dirname "$0")/voice-headers.sh" 2>&1 | tail -6 || echo "(нет рядом)"
if [ "$broke" = 1 ]; then rollback "сайт, ассеты или API не отвечают как раньше"; exit 1; fi
if [ "$policy" = 1 ]; then echo "ВНИМАНИЕ: политика кэша/404 выполнена не полностью (см. ✗) — блок оставлен, сайт работает"; echo "=== done (policy) ==="; exit 1; fi
echo "ИТОГ: статика терминальная, 404 без immutable, HTML — no-cache"
echo "=== done ==="

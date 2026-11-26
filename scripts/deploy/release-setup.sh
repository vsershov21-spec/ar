#!/usr/bin/env bash
# Ветка release → /mvp (docs/RELEASE.md). Root на swe, задачей ar-auto:
#   { "kind": "script", "path": "scripts/deploy/release-setup.sh", "ref": "<коммит main>", "timeoutMin": 90 }
# 1) скачивает server/ar-update/ar-update.sh ровно с коммита REF, проверяет bash -n и ставит в /usr/local/bin/ar-update.sh
#    (прежний — в .bak.<время>);
# 2) запускает ar-update (сборка main → корень и /lab; ветка release → /mvp; первая сборка release — до ~10–15 мин);
# 3) проверяет: сервис не упал, релиз /srv/ar/current = <main>-r<release>, в HTML /mvp метка ar-build = коммит release
#    (редакция pilot), в /lab и корне — коммит main, main.js /mvp и /lab отвечают 200;
# 4) ошибка на любом шаге после установки — прежний скрипт обратно и пересборка им (сайт как до задачи).
# DRY=1 — только скачать, проверить и показать diff, ничего не менять. Ключей и токенов скрипт не читает.
set -u
REF=${REF:-main}
RAW=https://raw.githubusercontent.com/vsershov21-spec/ar/$REF
DST=/usr/local/bin/ar-update.sh
H=${H:-https://ar.vershov.com}
BASE=/srv/ar
echo "=== $(date -Is) release-setup (ref $REF) ==="
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT

curl -fsSL "$RAW/server/ar-update/ar-update.sh" -o "$T/ar-update.sh" || { echo "ПЛОХО: не скачался server/ar-update/ar-update.sh"; exit 1; }
bash -n "$T/ar-update.sh" || { echo "ПЛОХО: bash -n"; exit 1; }
grep -q 'RELEASE_BRANCH' "$T/ar-update.sh" || { echo "ПЛОХО: это не новый ar-update.sh"; exit 1; }
echo "--- diff $DST ← ref $REF ---"
diff -u "$DST" "$T/ar-update.sh" | head -250
[ "${DRY:-0}" = 1 ] && { echo "DRY=1 — ничего не менял"; exit 0; }

wait_idle() { # дождаться, пока идущая сборка (таймер) закончится — до 30 мин
  local i
  for i in $(seq 1 180); do
    case "$(systemctl is-active ar-update.service 2>/dev/null)" in activating|active|reloading) sleep 10 ;; *) return 0 ;; esac
  done
  return 1
}
rebuild() { # запустить ar-update и дождаться; 0 — сервис отработал без ошибки
  wait_idle || { echo "ar-update занят > 30 мин"; return 1; }
  systemctl reset-failed ar-update.service 2>/dev/null || true
  systemctl start ar-update.service
  local code=$?
  wait_idle
  [ "$code" = 0 ] && [ "$(systemctl is-failed ar-update.service 2>/dev/null)" != failed ]
}
mark() { # метка сборки из HTML: «<коммит> <редакция>»
  curl -s -H 'Cache-Control: no-cache' "$H$1" | grep -o '<meta name="ar-build" content="[^"]*"' | head -1 | sed 's/.*content="//; s/"$//'
}
asset() { # main.js страницы → код ответа
  local js
  js=$(curl -s "$H$1" | grep -o "$1assets/main-[^\"]*\.js" | head -1)
  [ -n "$js" ] && curl -s -o /dev/null -w '%{http_code}' "$H$js" || echo "нет main.js"
}

BAK=$DST.bak.$(date +%s)
cp -a "$DST" "$BAK" || { echo "ПЛОХО: бэкап не сделан"; exit 1; }
install -m 0755 -o root -g root "$T/ar-update.sh" "$DST" || { echo "ПЛОХО: install"; exit 1; }
echo "установлен $DST (прежний — $BAK)"
LOG0=$(stat -c %s "$BASE/update.log" 2>/dev/null || echo 0)

ok=1
rebuild || { echo "ПЛОХО: ar-update завершился с ошибкой"; ok=0; }
echo "--- update.log (эта сборка) ---"
tail -c +"$((LOG0 + 1))" "$BASE/update.log" 2>/dev/null | grep -v '^npm WARN\|^\s*$' | tail -60

source /etc/ar/ar.env
RFULL=$(git ls-remote "$REPO_URL" "refs/heads/${RELEASE_BRANCH:-release}" | awk '{print $1}')
CUR=$(basename "$(readlink "$BASE/current")")
echo "текущий релиз: $CUR    release: ${RFULL:-нет ветки}"
if [ "$ok" = 1 ]; then
  M_ROOT=$(mark /); M_LAB=$(mark /lab/); M_MVP=$(mark /mvp/)
  echo "ar-build: / «$M_ROOT»   /lab/ «$M_LAB»   /mvp/ «$M_MVP»"
  echo "main.js: /lab/ $(asset /lab/)   /mvp/ $(asset /mvp/)"
  CM=${CUR%%-r*}
  case "$M_ROOT" in "$CM"*" mvp") ;; *) echo "ПЛОХО: корень не из main $CM"; ok=0 ;; esac
  case "$M_LAB" in "$CM"*" lab") ;; *) echo "ПЛОХО: /lab не из main $CM"; ok=0 ;; esac
  if [ -n "$RFULL" ]; then
    case "$CUR" in *-r"${RFULL:0:7}") ;; *) echo "ПЛОХО: релиз $CUR — не с release ${RFULL:0:7} (сборка release упала? см. лог)"; ok=0 ;; esac
    S=${M_MVP%% *}
    { [ -n "$S" ] && [ "${RFULL#"$S"}" != "$RFULL" ] && [ "${M_MVP##* }" = pilot ]; } || { echo "ПЛОХО: /mvp не из release ${RFULL:0:7}"; ok=0; }
  fi
  [ "$(asset /mvp/)" = 200 ] || { echo "ПЛОХО: main.js /mvp"; ok=0; }
  [ "$(asset /lab/)" = 200 ] || { echo "ПЛОХО: main.js /lab"; ok=0; }
fi

if [ "$ok" != 1 ]; then
  echo "=== ОТКАТ: прежний $DST и пересборка ==="
  cp -a "$BAK" "$DST"
  rebuild && echo "откат: пересобрано прежним скриптом ($(basename "$(readlink "$BASE/current")"))" || echo "откат: пересборка с ошибкой — смотреть $BASE/update.log"
  echo "ИТОГ: ПЛОХО (откатил)"
  exit 1
fi
echo "ИТОГ: OK — /mvp из release ${RFULL:0:7}, корень и /lab из main ${CUR%%-r*}"

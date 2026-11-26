#!/usr/bin/env bash
# Что сейчас на сайте (только чтение, docs/RELEASE.md): метки сборки <meta name="ar-build"> в HTML корня, /lab и /mvp,
# main.js страниц, текущий релиз /srv/ar/current и коммиты веток main / release на GitHub.
#   bash scripts/deploy/release-check.sh                 — снимок
#   bash scripts/deploy/release-check.sh release=abc1234 — ждать (до 25 мин), пока /mvp соберётся из этого коммита
# Задачей ar-auto: { "kind": "script", "path": "scripts/deploy/release-check.sh", "args": ["release=abc1234"], "timeoutMin": 40 }
# Итог: OK — /mvp из release, /lab и корень из main; ПЛОХО — код выхода 1.
set -u
H=${H:-https://ar.vershov.com}
REPO=${REPO:-https://github.com/vsershov21-spec/ar.git}
WANT=""; for a in "$@"; do case "$a" in release=[0-9a-f]*) WANT=${a#release=} ;; esac; done
mark() { curl -s -H 'Cache-Control: no-cache' "$H$1" | grep -o '<meta name="ar-build" content="[^"]*"' | head -1 | sed 's/.*content="//; s/"$//'; }
asset() { local js; js=$(curl -s "$H$1" | grep -o "$1assets/main-[^\"]*\.js" | head -1); [ -n "$js" ] && echo "$(curl -s -o /dev/null -w '%{http_code}' "$H$js") $js" || echo "нет main.js"; }
echo "=== $(date -Is) release-check ${WANT:+(ждём /mvp = $WANT)} ==="
if [ -n "$WANT" ]; then
  for i in $(seq 1 25); do
    M=$(mark /mvp/)
    echo "попытка $i: /mvp «$M»"
    case "$M" in "$WANT"*|"${WANT:0:7}"*) break ;; esac
    [ "$i" = 25 ] && { echo "ИТОГ: ПЛОХО (/mvp не собрался из $WANT за 25 мин — см. /srv/ar/update.log)"; tail -n 30 /srv/ar/update.log 2>/dev/null | grep -v '^npm WARN'; exit 1; }
    sleep 60
  done
fi
MAIN=$(git ls-remote "$REPO" refs/heads/main | cut -c1-12)
REL=$(git ls-remote "$REPO" refs/heads/release | cut -c1-12)
CUR=$(basename "$(readlink /srv/ar/current 2>/dev/null)" 2>/dev/null)
M_ROOT=$(mark /); M_LAB=$(mark /lab/); M_MVP=$(mark /mvp/)
echo "GitHub: main ${MAIN:-?}  release ${REL:-нет}   релиз на сервере: ${CUR:-?}"
echo "/      «$M_ROOT»   main.js $(asset /)"
echo "/lab/  «$M_LAB»   main.js $(asset /lab/)"
echo "/mvp/  «$M_MVP»   main.js $(asset /mvp/)"
bad=0
S=${M_MVP%% *}
if [ -n "$REL" ]; then
  { [ -n "$S" ] && [ "${REL#"$S"}" != "$REL" ] || [ "${S#"${REL:0:7}"}" != "$S" ]; } || { echo "ПЛОХО: /mvp не с ветки release (${REL:0:7})"; bad=1; }
  [ "${M_MVP##* }" = pilot ] || { echo "ПЛОХО: /mvp — не редакция pilot"; bad=1; }
fi
[ "${M_LAB##* }" = lab ] || { echo "ПЛОХО: /lab — не редакция lab"; bad=1; }
[ "${M_ROOT%% *}" = "${M_LAB%% *}" ] || { echo "ПЛОХО: корень и /lab из разных коммитов"; bad=1; }
case "$(asset /mvp/)" in 200*) ;; *) echo "ПЛОХО: main.js /mvp"; bad=1 ;; esac
case "$(asset /lab/)" in 200*) ;; *) echo "ПЛОХО: main.js /lab"; bad=1 ;; esac
[ "$bad" = 1 ] && { echo "ИТОГ: ПЛОХО"; exit 1; }
echo "ИТОГ: OK — /mvp из release ${S:-?}, /lab и корень из main ${M_LAB%% *} (последний main на GitHub ${MAIN:0:7}: если новее — ar-update соберёт через 2–5 мин)"

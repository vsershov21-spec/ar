#!/usr/bin/env bash
# Разовая настройка на swe (root) для редакции pilot (https://ar.vershov.com/mvp, docs/EDITIONS.md «Пилот»):
#   1) свежий сервис прогресса (/opt/ar-progress/{server,store}.mjs: события воронки POST /api/progress/event,
#      сводка GET /api/progress/stats) и перезапуск ar-progress;
#   2) Caddy: /mvp → /mvp/, SPA-фолбэк /mvp/* → /mvp/index.html (кроме /mvp/assets/*), html без кэша,
#      assets — immutable. Директивы — на верхнем уровне блока ar.vershov.com (как у lab), до handle-блоков:
#      rewrite Caddy выполняет раньше handle, поэтому `handle /api/progress/*` и `handle { try_files … }` не меняются;
#   3) проверки.
# Запуск в фоне, чтобы reload Caddy не рвал сессию (REF — коммит или ветка, по умолчанию main):
#   REF=<коммит>; curl -fsSL https://raw.githubusercontent.com/vsershov21-spec/ar/$REF/scripts/deploy/pilot-setup.sh -o /tmp/pilot-setup.sh \
#     && REF=$REF nohup bash /tmp/pilot-setup.sh >/tmp/pilot-setup.log 2>&1 &
#   sleep 25; cat /tmp/pilot-setup.log
set -u
REF=${REF:-main}
RAW=https://raw.githubusercontent.com/vsershov21-spec/ar/$REF
CF=/etc/caddy/Caddyfile
echo "=== $(date -Is) pilot-setup (ref $REF) ==="

# 1) сервис прогресса (с бэкапом: не скачалось — остаётся старый код)
P=/opt/ar-progress
PB="$P/bak.$(date +%s)"; mkdir -p "$PB"; cp -a "$P"/server.mjs "$P"/store.mjs "$PB"/ 2>/dev/null
okp=1
for f in server.mjs store.mjs; do
  if curl -fsSL "$RAW/server/progress/$f" -o "$P/$f.new"; then :; else echo "curl $f FAIL"; okp=0; fi
done
if [ "$okp" = 1 ] && node --check "$P/server.mjs.new" && node --check "$P/store.mjs.new"; then
  mv "$P/server.mjs.new" "$P/server.mjs"; mv "$P/store.mjs.new" "$P/store.mjs"
  systemctl restart ar-progress; sleep 2
  if ! curl -fs http://127.0.0.1:8787/api/progress/health >/dev/null; then
    echo "PROGRESS: не поднялся — откатил на $PB"; cp -a "$PB"/server.mjs "$PB"/store.mjs "$P"/; systemctl restart ar-progress; sleep 2
  fi
else
  echo "PROGRESS: код не обновлён (скачивание или node --check) — оставил прежний"; rm -f "$P"/*.new
fi
echo "PROGRESS local: $(curl -s http://127.0.0.1:8787/api/progress/health)"

# 2) Caddy
BAK="$CF.bak.$(date +%s)"; cp "$CF" "$BAK"
if grep -q 'редакция pilot' "$CF"; then echo "CADDY: /mvp уже прописан"
else
  SNIP=$(mktemp)
  printf '%s\n' \
'    # редакция pilot (docs/EDITIONS.md «Пилот»): статика dist/mvp/, ассеты моделей и звука — из корня' \
'    redir /mvp /mvp/ 308' \
'    @pilot {' \
'        path /mvp/*' \
'        not path /mvp/assets/*' \
'    }' \
'    rewrite @pilot /mvp/index.html' \
'    header @pilot Cache-Control "no-cache"' \
'    @pilotAssets path /mvp/assets/*' \
'    header @pilotAssets Cache-Control "public, max-age=31536000, immutable"' > "$SNIP"
  if grep -q '^ar\.vershov\.com {' "$CF"; then sed -i "/^ar\.vershov\.com {/r $SNIP" "$CF"
  else echo "CADDY: не нашёл строку 'ar.vershov.com {' — ничего не менял"; fi
  rm -f "$SNIP"
fi
echo "--- блок ar.vershov.com ---"; awk '/^ar\.vershov\.com \{/{p=1} p{print} p&&/^\}/{exit}' "$CF"
if caddy validate --config "$CF" >/dev/null 2>&1; then
  sleep 1; systemctl reload caddy && echo "CADDY OK"
else
  echo "CADDY FAIL — откатил на $BAK"; caddy validate --config "$CF" 2>&1 | tail -3; cp "$BAK" "$CF"
fi
sleep 3

# 3) проверки
H=https://ar.vershov.com
echo "mvp/ cache:  $(curl -sI $H/mvp/ | grep -i '^cache-control' | tr -d '\r')"
echo "mvp redir:   $(curl -s -o /dev/null -w '%{http_code} → %{redirect_url}' $H/mvp)"
echo "mvp deep:    $(curl -s $H/mvp/x/y | grep -o '/mvp/assets/main-[^"]*' | head -1)   (ждём /mvp/assets/main-…)"
A=$(curl -s $H/mvp/ | grep -o '/mvp/assets/main-[^"]*\.js' | head -1)
[ -n "$A" ] && echo "mvp asset:   $(curl -sI $H$A | grep -i '^cache-control' | tr -d '\r')"
echo "health:      $(curl -s $H/api/progress/health)   (ждём \"events\":true — новый код сервиса)"
echo "stats:       $(curl -s -o /dev/null -w '%{http_code}' $H/api/progress/stats)   (ждём 401 без токена)"
echo "event:       $(curl -s -X POST -H 'Origin: https://ar.vershov.com' -d '{}' $H/api/progress/event)   (ждём {\"error\":\"device: uuid v4\"} — без записи)"
echo "root /:      $(curl -s -o /dev/null -w '%{http_code}' $H/)   lab: $(curl -s $H/lab/any/deep | grep -o '/lab/assets/main-[^"]*' | head -1)"
[ -n "$A" ] || echo "ВНИМАНИЕ: dist/mvp ещё не опубликован — дождитесь ar-update (npm run build собирает три редакции)"
echo "=== done ==="

#!/usr/bin/env bash
# Разовая настройка на swe (root): lab в Caddy, свежий сервис прогресса, проверка озвучки.
# Запуск в фоне, чтобы reload Caddy не рвал сессию:
#   curl -fsSL <raw>/scripts/deploy/lab-setup.sh -o /tmp/lab-setup.sh && nohup bash /tmp/lab-setup.sh >/tmp/lab-setup.log 2>&1 &
#   sleep 20; cat /tmp/lab-setup.log
set -u
RAW=https://raw.githubusercontent.com/vsershov21-spec/ar/main
CF=/etc/caddy/Caddyfile
echo "=== $(date -Is) lab-setup ==="

# 1) сервис прогресса
for f in server.mjs store.mjs; do curl -fsSL "$RAW/server/progress/$f" -o "/opt/ar-progress/$f" || echo "curl $f FAIL"; done
systemctl restart ar-progress; sleep 2
echo "PROGRESS local: $(curl -s http://127.0.0.1:8787/api/progress/health)"

# 2) озвучка
V=/srv/ar-extra/voice-el; [ -d "$V" ] || V=/var/lib/vershov-commander/ar/voice-el
echo "VOICE mp3: $(find "$V" -name '*.mp3' | wc -l)  ($V)"
chown -R vershov-commander:caddy "$V" && chmod -R g+rX "$V"
tail -n 6 /var/lib/vershov-commander/ar/el-run.log 2>/dev/null
pgrep -f eleven.mjs >/dev/null && echo "VOICE: синтез ещё идёт" || echo "VOICE: синтез завершён"

# 3) Caddy
BAK="$CF.bak.$(date +%s)"; cp "$CF" "$BAK"
if grep -q 'редакция lab' "$CF"; then echo "CADDY: lab уже прописан"
else
  SNIP=$(mktemp)
  printf '%s\n' \
'    # редакция lab (docs/EDITIONS.md)' \
'    redir /lab /lab/ 308' \
'    @lab {' \
'        path /lab/*' \
'        not path /lab/assets/*' \
'    }' \
'    rewrite @lab /lab/index.html' \
'    header @lab Cache-Control "no-cache"' \
'    @labAssets path /lab/assets/*' \
'    header @labAssets Cache-Control "public, max-age=31536000, immutable"' > "$SNIP"
  if grep -q '^ar\.vershov\.com {' "$CF"; then sed -i "/^ar\.vershov\.com {/r $SNIP" "$CF"
  else echo "CADDY: не нашёл строку 'ar.vershov.com {' — ничего не менял"; fi
  rm -f "$SNIP"
fi
if caddy validate --config "$CF" >/dev/null 2>&1; then
  sleep 1; systemctl reload caddy && echo "CADDY OK"
else
  echo "CADDY FAIL — откатил на $BAK"; caddy validate --config "$CF" 2>&1 | tail -3; cp "$BAK" "$CF"
fi
sleep 3

# 4) проверки
echo "PROGRESS https: $(curl -s https://ar.vershov.com/api/progress/health)"
curl -sI https://ar.vershov.com/lab/ | grep -i cache-control
curl -s https://ar.vershov.com/lab/any/deep | grep -o '/lab/assets/main-[^"]*' | head -1
echo "=== done ==="

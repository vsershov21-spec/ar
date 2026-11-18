#!/usr/bin/env bash
# Чинит прокси /api/progress/* в Caddy: SPA-фолбэк try_files переписывал /api/... на /index.html раньше reverse_proxy.
# Запуск в фоне: nohup bash /tmp/progress-route.sh >/tmp/progress-route.log 2>&1 &
set -u
CF=/etc/caddy/Caddyfile
BAK="$CF.bak.$(date +%s)"; cp "$CF" "$BAK"
echo "=== $(date -Is) progress-route ==="
echo "--- до: строки про try_files / progress / api ---"
grep -n -E 'try_files|progress|/api|@notapi|^ar\.vershov\.com' "$CF"
# 1) матчер, исключающий /api/*
grep -q '@notapi' "$CF" || sed -i '/^ar\.vershov\.com {/a\    @notapi not path /api/*' "$CF"
# 2) try_files в блоке ar.vershov.com — только не для /api
awk '
  /^ar\.vershov\.com \{/ {inb=1}
  inb && /^\}/ {inb=0}
  inb && $1=="try_files" && $2!="@notapi" {sub(/try_files /,"try_files @notapi ")}
  {print}' "$CF" > "$CF.tmp" && cat "$CF.tmp" > "$CF" && rm -f "$CF.tmp"
# 3) прокси — если его нет совсем, добавить
grep -q '127.0.0.1:8787' "$CF" || sed -i '/^ar\.vershov\.com {/a\    reverse_proxy /api/progress/* 127.0.0.1:8787' "$CF"
echo "--- после ---"
grep -n -E 'try_files|progress|/api|@notapi' "$CF"
if caddy validate --config "$CF" >/dev/null 2>&1; then sleep 1; systemctl reload caddy && echo "CADDY OK"
else echo "CADDY FAIL — откатил"; caddy validate --config "$CF" 2>&1 | tail -3; cp "$BAK" "$CF"; fi
sleep 3
echo "local: $(curl -s http://127.0.0.1:8787/api/progress/health)"
echo "https: $(curl -s https://ar.vershov.com/api/progress/health | head -c 120)"
curl -sI https://ar.vershov.com/lab/ | grep -i cache-control
echo "=== done ==="

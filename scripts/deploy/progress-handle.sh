#!/usr/bin/env bash
# Caddy: /api/progress/* и статика — в разных handle (взаимоисключающие), чтобы SPA-фолбэк не съедал API.
# nohup bash /tmp/ph.sh >/tmp/ph.log 2>&1 &
set -u
CF=/etc/caddy/Caddyfile
BAK="$CF.bak.$(date +%s)"; cp "$CF" "$BAK"
echo "=== $(date -Is) progress-handle ==="
if grep -q 'handle /api/progress/\*' "$CF"; then echo "уже стоит handle — не трогаю"
else
awk '
  /^ar\.vershov\.com \{/ {inb=1; print; next}
  inb && /^\}/ {
    print "        handle /api/progress/* {"
    print "                reverse_proxy 127.0.0.1:8787"
    print "        }"
    print "        handle {"
    print "                try_files {path} /index.html"
    print "                file_server"
    print "        }"
    inb=0; print; next }
  inb && $1=="@notapi" {next}
  inb && $1=="reverse_proxy" && $2=="/api/progress/*" {next}
  inb && $1=="try_files" {next}
  inb && $1=="file_server" && NF==1 {next}
  {print}' "$CF" > "$CF.tmp" && cat "$CF.tmp" > "$CF" && rm -f "$CF.tmp"
fi
echo "--- блок ar.vershov.com ---"; awk '/^ar\.vershov\.com \{/{p=1} p{print} p&&/^\}/{exit}' "$CF"
if caddy validate --config "$CF" >/dev/null 2>&1; then sleep 1; systemctl reload caddy && echo "CADDY OK"
else echo "CADDY FAIL — откатил"; caddy validate --config "$CF" 2>&1 | tail -3; cp "$BAK" "$CF"; fi
sleep 3
echo "api:  $(curl -s --resolve ar.vershov.com:443:127.0.0.1 https://ar.vershov.com/api/progress/health | head -c 80)"
echo "mvp:  $(curl -s -o /dev/null -w '%{http_code}' https://ar.vershov.com/)"
echo "deep: $(curl -s https://ar.vershov.com/some/deep | grep -o '<title>[^<]*' )"
echo "lab:  $(curl -s https://ar.vershov.com/lab/any/deep | grep -o '/lab/assets/main-[^"]*' | head -1)"
echo "test: $(curl -s -o /dev/null -w '%{http_code}' https://ar.vershov.com/test/)"
echo "=== done ==="

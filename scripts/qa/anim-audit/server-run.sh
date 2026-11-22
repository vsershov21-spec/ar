#!/usr/bin/env bash
# Разовый прогон стенда аудита анимаций на swe с настоящими клипами Meshy (docs/qa/anim-audit/README.md).
# Запуск (root): curl -fsSL https://raw.githubusercontent.com/vsershov21-spec/ar/main/scripts/qa/anim-audit/server-run.sh | bash
# Работает в фоне ~1–1,5 ч; лог: tail -f /root/ar-qa/anim-audit.log; итог: /root/ar-qa/bench-out/anim-audit/table_srv_meshy.md
# REF=<sha> — прогон кода из этого коммита (по умолчанию main); AUDIT_OUT=<папка> — итог туда, начисто (так зовёт ar-auto,
# задача kind "audit", docs/automation/README.md)
set -u
Q=/root/ar-qa; LOG=$Q/anim-audit.log; MESHY=/srv/ar-extra/models/anims/meshy
REF=${REF:-main}; AUDIT_OUT=${AUDIT_OUT:-}
[[ "$REF" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo "REF: недопустимое значение"; exit 3; }
mkdir -p "$Q"
if pgrep -f "anim-audit/audit.mjs" >/dev/null; then echo "Уже идёт. Лог: tail -f $LOG"; exit 0; fi
nohup setsid bash -c '
set -e
Q='"$Q"'; MESHY='"$MESHY"'; REF='"$REF"'; AUDIT_OUT='"$AUDIT_OUT"'
echo "=== $(date -Is) anim-audit server-run ==="
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git fonts-dejavu-core libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 >/dev/null
apt-get install -y -qq libasound2t64 >/dev/null 2>&1 || apt-get install -y -qq libasound2 >/dev/null
node -v
[ -d $Q/repo/.git ] || { mkdir -p $Q/repo && git -C $Q/repo init -q && git -C $Q/repo remote add origin https://github.com/vsershov21-spec/ar.git; }
git -C $Q/repo fetch -q --depth 1 origin "$REF" && git -C $Q/repo reset -q --hard FETCH_HEAD
cd $Q/repo && git log --oneline -1
[ -z "$AUDIT_OUT" ] || rm -rf bench-out/anim-audit
npm ci --no-audit --no-fund >/dev/null
npx -y @puppeteer/browsers install chrome@stable --path $Q/chrome >/dev/null
export CHROME=$(ls -d $Q/chrome/chrome/linux-*/chrome-linux64/chrome | tail -1); echo "CHROME=$CHROME"
echo "клипов Meshy: $(ls $MESHY/*.glb 2>/dev/null | wc -l)"
nice -n 10 node scripts/qa/anim-audit/audit.mjs --tag srv_base --no-sheets
nice -n 10 node scripts/qa/anim-audit/audit.mjs --no-build --tag srv_meshy --meshy $MESHY
node scripts/qa/anim-audit/audit-report.mjs srv_base
node scripts/qa/anim-audit/audit-report.mjs srv_meshy
node scripts/qa/anim-audit/table.mjs srv_meshy srv_base
mkdir -p $Q/bench-out && cp -a bench-out/anim-audit $Q/bench-out/ 2>/dev/null || true
[ -z "$AUDIT_OUT" ] || { rm -rf "$AUDIT_OUT" && mkdir -p "$AUDIT_OUT" && cp -a bench-out/anim-audit "$AUDIT_OUT/"; }
echo "=== $(date -Is) готово: $Q/bench-out/anim-audit/table_srv_meshy.md ==="
' >"$LOG" 2>&1 < /dev/null &
echo "Прогон запущен в фоне (pid $!). Лог: tail -f $LOG"

#!/usr/bin/env bash
# Разовый прогон стенда аудита анимаций на swe с настоящими клипами Meshy (docs/qa/anim-audit/README.md).
# Запуск (root): curl -fsSL https://raw.githubusercontent.com/vsershov21-spec/ar/main/scripts/qa/anim-audit/server-run.sh | bash
# Работает в фоне ~1–1,5 ч; лог: tail -f /root/ar-qa/anim-audit.log; итог: /root/ar-qa/bench-out/anim-audit/table_srv_meshy.md
set -u
Q=/root/ar-qa; LOG=$Q/anim-audit.log; MESHY=/srv/ar-extra/models/anims/meshy
mkdir -p "$Q"
if pgrep -f "anim-audit/audit.mjs" >/dev/null; then echo "Уже идёт. Лог: tail -f $LOG"; exit 0; fi
nohup setsid bash -c '
set -e
Q='"$Q"'; MESHY='"$MESHY"'
echo "=== $(date -Is) anim-audit server-run ==="
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git fonts-dejavu-core libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 >/dev/null
apt-get install -y -qq libasound2t64 >/dev/null 2>&1 || apt-get install -y -qq libasound2 >/dev/null
node -v
if [ -d $Q/repo/.git ]; then git -C $Q/repo fetch -q --depth 1 origin main && git -C $Q/repo reset -q --hard FETCH_HEAD; else git clone -q --depth 1 https://github.com/vsershov21-spec/ar.git $Q/repo; fi
cd $Q/repo && git log --oneline -1
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
echo "=== $(date -Is) готово: $Q/bench-out/anim-audit/table_srv_meshy.md ==="
' >"$LOG" 2>&1 < /dev/null &
echo "Прогон запущен в фоне (pid $!). Лог: tail -f $LOG"

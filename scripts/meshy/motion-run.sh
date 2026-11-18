#!/usr/bin/env bash
# Недостающие клипы СберКота через Meshy Text-to-Motion (docs/animations/MESHY.md). Сервер swe, root.
# Ключ — только в /etc/ar-meshy.env (MESHY_API_KEY=…, chmod 600); его читает node внутри процесса, в лог не пишет.
#
#   curl -fsSL https://raw.githubusercontent.com/vsershov21-spec/ar/main/scripts/meshy/motion-run.sh -o /tmp/meshy.sh
#   bash /tmp/meshy.sh                         — план: клипы P0, кредиты, баланс (ничего не тратит)
#   bash /tmp/meshy.sh --set p1                — план P1 (или --set p0,p1 / all)
#   bash /tmp/meshy.sh --go                    — генерация в фоне; лог: tail -f /var/lib/vershov-commander/ar/meshy.log
#   bash /tmp/meshy.sh --go --only wave,sit_down
#   bash /tmp/meshy.sh --go --redo wave        — заново (снова тратит кредиты) — только если клип не понравился
#
# Готовое: /srv/ar-extra/models/anims/meshy/<id>.glb + manifest.json → на сайт со следующей сборкой (attach-extra):
# https://ar.vershov.com/models/anims/meshy/manifest.json. Состояние (id задач, сырые GLB) — /var/lib/vershov-commander/ar/meshy.
# Повторный запуск продолжает с места: готовое пропускает, начатые задачи дожидается, оплаченное не переотправляет.
set -u
RAW=${MESHY_RAW:-https://raw.githubusercontent.com/vsershov21-spec/ar/main}
BASE=/var/lib/vershov-commander/ar
WORK=$BASE/meshy
OUT=/srv/ar-extra/models/anims/meshy
LOG=$BASE/meshy.log
ENVF=/etc/ar-meshy.env
mkdir -p "$WORK" "$OUT"
GO=0
for a in "$@"; do [ "$a" = "--go" ] && GO=1; done

command -v node >/dev/null || { echo "нет node (нужен 22+)"; exit 3; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || { echo "node $(node -v): нужен 22+"; exit 3; }
if [ ! -s "$ENVF" ] && [ $GO = 1 ]; then
  echo "нет ключа: $ENVF — сначала положить ключ (docs/animations/MESHY.md)"; exit 3
elif [ ! -s "$ENVF" ]; then
  echo "нет ключа: $ENVF (см. docs/animations/MESHY.md — read -rsp … && chmod 600). План без баланса:"
elif [ "$(stat -c %a "$ENVF")" != "600" ]; then
  echo "внимание: права $ENVF $(stat -c %a "$ENVF") — нужно chmod 600 $ENVF"
fi
# свежие скрипт и промпты из main (как props-run.sh)
curl -fsSL "$RAW/scripts/meshy/motion.mjs" -o "$WORK/motion.mjs" || { echo "не скачал motion.mjs"; exit 1; }
curl -fsSL "$RAW/scripts/models/t2m_prompts_v2.json" -o "$WORK/prompts.json" || { echo "не скачал промпты"; exit 1; }

run() { node "$WORK/motion.mjs" --prompts "$WORK/prompts.json" --env "$ENVF" --state "$WORK" --out "$OUT" "$@"; }
fix() { chown -R vershov-commander:caddy "$OUT" 2>/dev/null; chmod -R g+rX,o+r "$OUT" 2>/dev/null; chmod 700 "$WORK" 2>/dev/null; }

if [ $GO = 0 ]; then
  run "$@"
  fix
  exit 0
fi
if pgrep -f "$WORK/motion.mjs" >/dev/null; then
  echo "Уже идёт генерация (pgrep motion.mjs). Лог: tail -f $LOG"
  exit 0
fi
echo "=== $(date -Is) meshy $* ===" >>"$LOG"
export -f run fix
export WORK OUT ENVF
nohup setsid bash -c 'run "$@"; code=$?; fix; echo "=== $(date -Is) код $code ==="; exit $code' _ "$@" >>"$LOG" 2>&1 </dev/null &
echo "Генерация в фоне (pid $!). Лог: tail -f $LOG"
echo "Готовые клипы — $OUT; на сайт — со следующей сборкой (любой push в main)."

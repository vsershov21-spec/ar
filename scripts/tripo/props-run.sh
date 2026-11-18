#!/usr/bin/env bash
# Предметы для кота через Tripo CLI (text-to-3D, P2). Запускать на swe под root, где выполнен `tripo login`.
# Ключ живёт только в ~/.tripo на сервере — в репозитории его нет.
#   curl -fsSL https://raw.githubusercontent.com/vsershov21-spec/ar/main/scripts/tripo/props-run.sh -o /tmp/props.sh
#   bash /tmp/props.sh                 — план: что сгенерируется и сколько кредитов (ничего не тратит)
#   nohup bash /tmp/props.sh --go >/tmp/props.log 2>&1 &   — генерация в фоне; лог: tail -f /tmp/props.log
#   bash /tmp/props.sh --go --only bed,skateboard           — только выбранные
#   bash /tmp/props.sh --go --max-credits 250               — потолок прогона по оценке (dry-run) перед каждым предметом
#   TRIPO_RAW=https://raw.githubusercontent.com/vsershov21-spec/ar/<sha> — промпты из конкретного коммита (ar-auto)
# Готовое кладётся в /srv/ar-extra/models/props/<имя>.glb + <имя>.png (превью) и попадает на сайт со следующей
# сборкой (attach-extra): https://ar.vershov.com/models/props/<имя>.glb. Уже готовые пропускаются (resume).
set -u
GO=0; ONLY=""; MAXCR=""
while [ $# -gt 0 ]; do case "$1" in --go) GO=1;; --only) ONLY="$2"; shift;; --max-credits) MAXCR="$2"; shift;; esac; shift; done
export TRIPO_CLIENT_APP=claude
RAW=${TRIPO_RAW:-https://raw.githubusercontent.com/vsershov21-spec/ar/main}
WORK=/var/lib/vershov-commander/ar/tripo; OUT=/srv/ar-extra/models/props
mkdir -p "$WORK" "$OUT"
command -v tripo >/dev/null || { echo "нет tripo: npm install -g tripo-cli && tripo login --region ov"; exit 3; }
curl -fsSL "$RAW/scripts/models/t2m_prompts_v2.json" -o "$WORK/prompts.json" || { echo "не скачал промпты"; exit 1; }
# список предметов: всё из props, что ещё не готово; стиль общий для мира кота
node -e '
const d=require(process.argv[1]); const only=(process.argv[2]||"").split(",").filter(Boolean);
const style=" Soft rounded toy-like shapes, bright Sber palette (green #21A038, lime #B5E36A, teal, cream), matte clay look, no text, no logos, single object on its own, centered, game-ready.";
for (const [k,v] of Object.entries(d.props||{})) { if(!v||!v.prompt) continue; if(only.length&&!only.includes(k)) continue;
  if(!only.length && /готов|есть/.test(v.status||"") && !/по желанию/.test(v.status||"")) continue;
  console.log(k+"\t"+(v.prompt+style).replace(/\s+/g," ")); }' "$WORK/prompts.json" "$ONLY" > "$WORK/list.tsv"
N=$(wc -l < "$WORK/list.tsv"); TODO=0; TOTAL=0; SPENT=0
echo "=== $(date -Is) props-run $([ $GO = 1 ] && echo GO || echo PLAN) ==="
tripo balance --json 2>/dev/null | sed 's/^/баланс: /'
while IFS=$'\t' read -r name prompt; do
  if [ -s "$OUT/$name.glb" ]; then echo "✓ $name — уже есть"; continue; fi
  TODO=$((TODO+1))
  est=$(tripo make "$prompt" --model tripo-p2 -p face_limit=8000 --dry-run --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const v=Number(JSON.parse(s).generation_credits_estimate);console.log(v>0?Math.ceil(v):"?")}catch{console.log("?")}})')
  case "$est" in ''|*[!0-9]*) estn=110;; *) estn=$est;; esac
  TOTAL=$((TOTAL+estn))
  if [ $GO = 0 ]; then
    echo "• $name — ~${est} кредитов"
    continue
  fi
  if [ -n "$MAXCR" ] && [ $((SPENT+estn)) -gt "$MAXCR" ]; then echo "■ лимит --max-credits $MAXCR: $name (~$estn) не запускаю"; break; fi
  SPENT=$((SPENT+estn))
  echo "▶ $name · ~$estn кр."
  res=$(tripo make "$prompt" --model tripo-p2 -p face_limit=8000 --json --yes --no-open -o "$WORK/$name" --name "prop_$name" 2>>"$WORK/$name.err")
  code=$?
  echo "$res" > "$WORK/$name.json"
  if [ $code -eq 4 ]; then echo "✗ кредиты кончились — стоп (tripo topup)"; break; fi
  if [ $code -ne 0 ]; then echo "✗ $name — код $code, см. $WORK/$name.err; повтор не делаю (может быть списано: tripo history)"; continue; fi
  glb=$(echo "$res" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const j=JSON.parse(s);console.log(j.source_model_file||j.model_file||"")})')
  prev=$(echo "$res" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{console.log(JSON.parse(s).preview||"")})')
  [ -s "$glb" ] && cp "$glb" "$OUT/$name.glb" && echo "✓ $name.glb $(du -h "$OUT/$name.glb" | cut -f1)"
  [ -s "$prev" ] && cp "$prev" "$OUT/$name.png"
done < "$WORK/list.tsv"
chown -R vershov-commander:caddy "$OUT" 2>/dev/null; chmod -R g+rX "$OUT" 2>/dev/null
[ $GO = 0 ] && echo "оценка ≈ $TOTAL кредитов"
[ $GO = 0 ] && echo "к генерации: $TODO из $N (≈110 кредитов за предмет). Запуск: nohup bash /tmp/props.sh --go >/tmp/props.log 2>&1 &"
[ $GO = 1 ] && echo "потрачено по оценке ≈ $SPENT кредитов"
[ $GO = 1 ] && { tripo balance --json 2>/dev/null | sed 's/^/баланс после: /'; echo "готово; на сайт — со следующей сборкой (любой push в main)"; }
echo "=== done ==="

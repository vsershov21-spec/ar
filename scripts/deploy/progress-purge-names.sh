#!/usr/bin/env bash
# Разово на swe (root): имя ребёнка больше не хранится на сервере прогресса (docs/PRIVACY.md).
#   1) свежий код сервиса (/opt/ar-progress/{server,store}.mjs — вырезает name при записи и чтении), с бэкапом кода;
#   2) остановка ar-progress и бэкап данных (sqlite + wal/shm или JSON-файлы) в /opt/ar-progress/bak-names.<время>/;
#   3) удаление name (и полей, похожих на имя) из всех сохранённых записей — тем же stripName, что в store.mjs;
#   4) запуск сервиса и проверка: health, ни одной записи с name, GET не отдаёт имя.
# Запуск (REF — коммит или ветка, по умолчанию main):
#   REF=main; curl -fsSL https://raw.githubusercontent.com/vsershov21-spec/ar/$REF/scripts/deploy/progress-purge-names.sh -o /tmp/progress-purge-names.sh \
#     && sudo REF=$REF bash /tmp/progress-purge-names.sh 2>&1 | tee /tmp/progress-purge-names.log
# Откат: systemctl stop ar-progress; cp -a /opt/ar-progress/bak-names.<время>/data/. /srv/ar-extra/progress/; systemctl start ar-progress
set -u
REF=${REF:-main}
RAW=https://raw.githubusercontent.com/vsershov21-spec/ar/$REF
P=/opt/ar-progress
DATA=${PROGRESS_DATA:-/srv/ar-extra/progress}
TS=$(date +%Y%m%d-%H%M%S)
BAK="$P/bak-names.$TS"
NODE=$(command -v node || echo /usr/bin/node)
echo "=== $(date -Is) progress-purge-names (ref $REF, data $DATA) ==="
[ "$(id -u)" = 0 ] || { echo "нужен root (sudo)"; exit 1; }
[ -d "$DATA" ] || { echo "нет $DATA — нечего чистить"; exit 1; }

# 1) код сервиса
mkdir -p "$BAK/code" "$BAK/data"
cp -a "$P"/server.mjs "$P"/store.mjs "$BAK/code/" 2>/dev/null
okp=1
for f in server.mjs store.mjs; do curl -fsSL "$RAW/server/progress/$f" -o "$P/new.$f" || { echo "curl $f FAIL"; okp=0; }; done
if [ "$okp" = 1 ] && "$NODE" --check "$P/new.server.mjs" && "$NODE" --check "$P/new.store.mjs" && grep -q 'export function stripName' "$P/new.store.mjs"; then
  mv "$P/new.server.mjs" "$P/server.mjs"; mv "$P/new.store.mjs" "$P/store.mjs"; echo "CODE: обновлён"
else
  rm -f "$P"/new.*.mjs; echo "CODE: не обновлён (скачивание/проверка) — стоп, ничего не трогал"; exit 1
fi

# 2) стоп и бэкап данных (sqlite без работающего процесса — консистентная копия вместе с -wal/-shm)
systemctl stop ar-progress; sleep 1
cp -a "$DATA"/. "$BAK/data/" || { echo "BACKUP FAIL — запускаю сервис как был"; systemctl start ar-progress; exit 1; }
chmod -R go-rwx "$BAK"
echo "BACKUP: $BAK/data ($(du -sh "$BAK/data" | cut -f1))"

# 3) чистка: тот же store.mjs (sqlite или файлы — как выберет сервис), stripDocNames по каждой записи
cat > "$BAK/purge.mjs" <<'JS'
const [, , dir, storeFile, mode] = process.argv;
const { openStore, stripDocNames } = await import(storeFile);
const kind = process.env.PROGRESS_STORE || 'auto';
const store = await openStore(dir, kind);
let total = 0, changed = 0, left = 0;
for (const d of store.list()) {
  const doc = store.get(d);
  if (!doc) continue;
  total++;
  const [clean, ch] = stripDocNames(doc);
  if (ch && mode === 'fix') {
    store.put(clean);
    changed++;
  }
  if (stripDocNames(mode === 'fix' ? store.get(d) : doc)[1]) left++;
}
// sqlite: старые версии строк могут остаться в свободных страницах и WAL — сжать файл
if (mode === 'fix' && store.db) store.db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;');
store.close?.();
console.log(JSON.stringify({ store: store.kind, total, changed, withName: left }));
process.exit(left && mode === 'fix' ? 2 : 0);
JS
echo "DATA до:    $("$NODE" --disable-warning=ExperimentalWarning "$BAK/purge.mjs" "$DATA" "$P/store.mjs" check)"
if "$NODE" --disable-warning=ExperimentalWarning "$BAK/purge.mjs" "$DATA" "$P/store.mjs" fix > "$BAK/purge.out"; then
  echo "DATA после: $(cat "$BAK/purge.out")"
else
  echo "PURGE FAIL: $(cat "$BAK/purge.out") — данные остались как в бэкапе? проверь вручную"
fi
# владелец файлов — как у сервиса (cp/sqlite могли создать файлы от root)
chown -R vershov-commander:vershov-commander "$DATA" 2>/dev/null
# в бэкапе имя осталось — это осознанно (откат); удалить после проверки: rm -rf "$BAK"
echo "NOTE: бэкап с именами — $BAK (удали после проверки: rm -rf $BAK)"

# 4) запуск и проверки
systemctl start ar-progress; sleep 2
H=$(curl -fs http://127.0.0.1:8787/api/progress/health)
echo "HEALTH: ${H:-FAIL}"
if [ -z "$H" ]; then
  echo "сервис не поднялся — откат кода"; cp -a "$BAK/code"/. "$P"/; systemctl restart ar-progress; sleep 2
  echo "HEALTH после отката: $(curl -fs http://127.0.0.1:8787/api/progress/health || echo FAIL)"
  exit 1
fi
echo "CHECK: $("$NODE" --disable-warning=ExperimentalWarning "$BAK/purge.mjs" "$DATA" "$P/store.mjs" check)  (withName должно быть 0)"
# PUT с именем от старого клиента — сервер должен вырезать (тестовое устройство, потом стираем)
T=00000000-0000-4000-8000-$(date +%s%N | tail -c 13)
R=$(curl -s -X PUT -H 'Content-Type: application/json' -H 'Origin: https://ar.vershov.com' --data '{"data":{"sber-ar-cat:v1":"{\"name\":\"Тест\",\"met\":true}"}}' "http://127.0.0.1:8787/api/progress/$T")
G=$(curl -s "http://127.0.0.1:8787/api/progress/$T")
curl -s -X DELETE -H 'Origin: https://ar.vershov.com' "http://127.0.0.1:8787/api/progress/$T?all=1" >/dev/null
if echo "$R$G" | grep -q 'Тест\|\\u0422\|name'; then echo "PUT/GET: FAIL — имя вернулось: $G"; else echo "PUT/GET: OK — имя вырезано ($G)"; fi
echo "=== done ==="

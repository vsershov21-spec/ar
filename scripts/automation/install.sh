#!/usr/bin/env bash
# Разовая установка ar-auto на swe (root). Повторный запуск — обновление кода до REF (env-файл не трогает).
#   REF=<sha>; curl -fsSL https://raw.githubusercontent.com/vsershov21-spec/ar/$REF/scripts/automation/install.sh -o /tmp/ar-auto-install.sh && sudo REF=$REF bash /tmp/ar-auto-install.sh
# Что делает: /opt/ar-auto (код из коммита REF), /etc/ar-auto.env (токен GitHub спрашивает скрыто, лимиты по умолчанию),
# /var/lib/ar-auto (состояние), юниты ar-auto.service + ar-auto.timer (раз в 5 мин), первый прогон, статус.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "нужен root: sudo REF=… bash $0"; exit 3; }
REF=${REF:-${1:-}}
[[ "$REF" =~ ^[0-9a-f]{40}$ ]] || { echo "нужен REF=<полный sha коммита> (40 символов)"; exit 3; }
RAW=https://raw.githubusercontent.com/vsershov21-spec/ar/$REF
ENVF=/etc/ar-auto.env
for c in node git curl systemctl systemd-run; do command -v $c >/dev/null || { echo "нет $c"; exit 3; }; done
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || { echo "node $(node -v): нужен 22+"; exit 3; }

echo "1/5 код из $REF → /opt/ar-auto"
install -d -m 700 /opt/ar-auto /var/lib/ar-auto
for f in ar-auto.sh ar-auto.mjs ar-auto.service ar-auto.timer; do
  curl -fsSL "$RAW/scripts/automation/$f" -o "/opt/ar-auto/$f.new"
done
cp /opt/ar-auto/ar-auto.mjs.new /opt/ar-auto/check.mjs && node --check /opt/ar-auto/check.mjs && rm -f /opt/ar-auto/check.mjs
for f in ar-auto.sh ar-auto.mjs ar-auto.service ar-auto.timer; do mv -f "/opt/ar-auto/$f.new" "/opt/ar-auto/$f"; done
chmod 700 /opt/ar-auto/ar-auto.sh
printf 'PATH=%q\n' "$PATH" > /opt/ar-auto/runtime.env
echo "$REF" > /opt/ar-auto/REF
ln -sfn /opt/ar-auto/ar-auto.sh /usr/local/bin/ar-auto

echo "2/5 $ENVF"
if ! grep -q '^GH_TOKEN=.' "$ENVF" 2>/dev/null; then
  echo "Нужен fine-grained токен GitHub: только репозиторий vsershov21-spec/ar, Contents: Read and write."
  read -rsp 'GH_TOKEN (ввод не виден): ' T; echo
  [ -n "$T" ] || { echo "пустой токен"; exit 3; }
  # заголовок — через stdin, чтобы токен не был виден в списке процессов
  code=$(printf 'Authorization: Bearer %s\n' "$T" | curl -s -o /dev/null -w '%{http_code}' -H @- https://api.github.com/repos/vsershov21-spec/ar)
  [ "$code" = 200 ] || { unset T; echo "токен не подошёл (GitHub ответил $code)"; exit 3; }
  ( umask 077
    { printf 'GH_TOKEN=%s\n' "$T"
      if [ -s "$ENVF" ]; then grep -v '^GH_TOKEN=' "$ENVF" || true; else
        echo '# дневные лимиты (UTC-сутки): кредиты Meshy, кредиты Tripo, символы ElevenLabs'
        echo 'AUTO_DAILY_MESHY=400'
        echo 'AUTO_DAILY_TRIPO=400'
        echo 'AUTO_DAILY_EL_CHARS=20000'
        echo '# размер файлов в выгрузке, КБ'
        echo 'AUTO_MESHY_MAX_KB=200'
        echo 'AUTO_TRIPO_MAX_KB=2048'
        echo '# если ar-update не пересобирает без нового коммита — команда пересборки (bash -c):'
        echo '#AUTO_REBUILD_CMD='
      fi
    } > "$ENVF.new" )
  unset T
  mv -f "$ENVF.new" "$ENVF"
else
  echo "   уже есть (токен не меняю; сменить — удалить строку GH_TOKEN и запустить снова)"
fi
chown root:root "$ENVF"; chmod 600 "$ENVF"

echo "3/5 первый прогон (очередь из main; mirror-meshy выгружает клипы в server-out)"
/opt/ar-auto/ar-auto.sh tick --wait || echo "   прогон завершился с ошибкой — см. выше"

echo "4/5 юниты (таймер раз в 5 мин)"
cp /opt/ar-auto/ar-auto.service /opt/ar-auto/ar-auto.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now ar-auto.timer >/dev/null

echo "5/5 статус"
/opt/ar-auto/ar-auto.sh status
systemctl cat ar-update.service >/dev/null 2>&1 && echo "ar-update.service найден — пересборка после генераций: systemctl start ar-update" \
  || echo "ВНИМАНИЕ: ar-update.service не найден — задайте AUTO_REBUILD_CMD в $ENVF"
echo "Готово. Результаты: https://github.com/vsershov21-spec/ar/tree/server-out/out · статус: sudo ar-auto status · лог таймера: journalctl -u ar-auto -n 50"

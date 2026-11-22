#!/usr/bin/env bash
# Установка / обновление ar-auto на swe (root). Идемпотентно: повторный запуск с новым REF — обновление кода,
# токен и лимиты в /etc/ar-auto.env не трогает (сменить токен — ROTATE=1).
#   REF=<sha>; curl -fsSL https://raw.githubusercontent.com/vsershov21-spec/ar/$REF/scripts/automation/install.sh -o /root/ar-auto-install.sh && sudo REF=$REF bash /root/ar-auto-install.sh
# Проверка после установки (отдельно, ничего не выполняет и не выгружает): sudo ar-auto selftest
# Что делает: /opt/ar-auto (код ровно из коммита REF), /etc/ar-auto.env (токен GitHub — скрытый ввод, лимиты по умолчанию),
# /var/lib/ar-auto (состояние, отметки выполненных задач), юниты ar-auto.service + ar-auto.timer (раз в 5 мин),
# первый прогон, статус. Документация: automation/README.md, docs/automation/README.md.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "нужен root: sudo REF=… bash $0"; exit 3; }
REF=${REF:-${1:-}}
[[ "$REF" =~ ^[0-9a-f]{40}$ ]] || { echo "нужен REF=<полный sha коммита> (40 символов)"; exit 3; }
REPO=vsershov21-spec/ar
RAW=https://raw.githubusercontent.com/$REPO/$REF
ENVF=/etc/ar-auto.env
D=/opt/ar-auto
FILES="ar-auto.sh ar-auto.mjs ar-auto.service ar-auto.timer"
for c in node git curl tar nice systemctl systemd-run; do command -v $c >/dev/null || { echo "нет $c"; exit 3; }; done
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || { echo "node $(node -v): нужен 22+"; exit 3; }
command -v ionice >/dev/null || echo "   (нет ionice — тяжёлые задачи пойдут только с nice)"

echo "1/5 код из $REF → $D"
install -d -m 700 "$D" /var/lib/ar-auto
STG=$(mktemp -d "$D/.stage.XXXXXX")
trap 'rm -rf "$STG"' EXIT
for f in $FILES; do curl -fsSL "$RAW/scripts/automation/$f" -o "$STG/$f"; done
# проверка синтаксиса до подмены: node --check смотрит на расширение — проверяем именно .mjs (не .new)
for f in $FILES; do
  case "$f" in
    *.mjs) node --check "$STG/$f" ;;
    *.sh) bash -n "$STG/$f" ;;
  esac
done
for f in $FILES; do install -m 600 "$STG/$f" "$D/$f"; done
chmod 700 "$D/ar-auto.sh"
printf 'PATH=%q\n' "$PATH" > "$D/runtime.env"
echo "$REF" > "$D/REF"
ln -sfn "$D/ar-auto.sh" /usr/local/bin/ar-auto

echo "2/5 $ENVF"
if [ "${ROTATE:-0}" = 1 ] || ! grep -q '^GH_TOKEN=.' "$ENVF" 2>/dev/null; then
  echo "Нужен fine-grained токен GitHub: только репозиторий $REPO, Contents: Read and write (см. docs/automation/README.md)."
  read -rsp 'GH_TOKEN (ввод не виден): ' T; echo
  T=$(printf '%s' "$T" | tr -d '[:space:]')
  [ -n "$T" ] || { echo "пустой токен"; exit 3; }
  # заголовок — через stdin (-H @-), чтобы токен не был виден в списке процессов
  code=$(printf 'Authorization: Bearer %s\n' "$T" | curl -s -o /dev/null -w '%{http_code}' -H @- "https://api.github.com/repos/$REPO")
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
  echo "   токен сохранён"
else
  echo "   уже есть (токен не меняю; сменить — ROTATE=1 и та же команда)"
fi
chown root:root "$ENVF"; chmod 600 "$ENVF"

echo "3/5 первый прогон (очередь из main)"
"$D/ar-auto.sh" tick --wait || echo "   прогон завершился с ошибкой — см. выше"

echo "4/5 юниты (таймер раз в 5 мин)"
install -m 644 "$D/ar-auto.service" "$D/ar-auto.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now ar-auto.timer >/dev/null

echo "5/5 статус"
"$D/ar-auto.sh" status
systemctl cat ar-update.service >/dev/null 2>&1 && echo "ar-update.service найден — пересборка после генераций: systemctl start ar-update" \
  || echo "ВНИМАНИЕ: ar-update.service не найден — задайте AUTO_REBUILD_CMD в $ENVF"
echo "Готово. Проверка: sudo ar-auto selftest · результаты: https://github.com/$REPO/tree/server-out/out · лог: journalctl -u ar-auto -n 50"

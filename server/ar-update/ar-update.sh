#!/bin/bash
# Автообновление ar.vershov.com — /usr/local/bin/ar-update.sh (сервис ar-update, таймер раз в 2 мин, пользователь
# vershov-commander). Ставит scripts/deploy/release-setup.sh задачей ar-auto (с бэкапом и откатом); docs/RELEASE.md.
#
#   main    → корень (/), /lab, /test — как раньше: push в main → через 2–5 мин на сайте;
#   release → /mvp (редакция pilot, к детям): только из ветки release. Своя рабочая копия $RSRC, сборка
#             AR_EDITIONS=mvp,pilot, готовый результат — кэш $RCACHE/<sha> (пересобирается только при новом коммите
#             release; push в main /mvp не трогает).
#
# Имя релиза: /srv/ar/releases/<main>-r<release>; ветки release нет — <main>, /mvp из main (как было до 26.11).
# Ассеты /mvp (модели, звук, озвучка, Vosk) общие — из корня, то есть из main. Хэшированные файлы сборки release,
# которых в main нет (models/opt/<модель>.<хэш>.glb, пакеты движений, чанки), докладываются в корень без перезаписи
# (cp -an) — /mvp находит свои модели, даже если main их уже поменял. Озвучка (voice/el/manifest.json) — из корня:
# новые записи доходят до /mvp с ближайшей пересборкой main.
# Сборка release упала — /mvp остаётся прежним (из кэша или текущего релиза), sha помечается $RCACHE/<sha>.failed
# (повторов каждые 2 мин нет; новый коммит release — новая попытка). Прежнего нет — /mvp из main, ВНИМАНИЕ в логе.
set -euo pipefail
source "${AR_ENV:-/etc/ar/ar.env}"            # REPO_URL, BRANCH, [RELEASE_BRANCH]
BASE=${AR_BASE:-/srv/ar}                       # AR_ENV / AR_BASE — только для проверки на стенде (tests)
export HOME=$BASE npm_config_cache=$BASE/.npm
SRC=$BASE/repo; RSRC=$BASE/repo-release; RCACHE=$BASE/release-dist; LOG=$BASE/update.log
RB=${RELEASE_BRANCH:-release}
exec >>"$LOG" 2>&1
mkdir -p "$RCACHE"

# ── main ──
if [ ! -d "$SRC/.git" ]; then git clone --depth 50 -b "${BRANCH:-main}" "$REPO_URL" "$SRC"; fi
cd "$SRC"
git fetch -q origin "${BRANCH:-main}"
NEW=$(git rev-parse --short FETCH_HEAD)

# ── release: есть ли ветка (сеть упала — ждём следующего раза, не публикуем /mvp из main) ──
RHEADS=$(git ls-remote --heads origin "$RB") || { echo "$(date -Is) ls-remote $RB: ошибка сети — пропуск"; exit 1; }
RSHA=""
if [ -n "$RHEADS" ]; then
  [ -d "$RSRC/.git" ] || git clone -q --depth 50 -b "$RB" "$REPO_URL" "$RSRC"
  git -C "$RSRC" fetch -q origin "$RB"
  RSHA=$(git -C "$RSRC" rev-parse --short=7 FETCH_HEAD)
fi

CUR=$(readlink "$BASE/current" 2>/dev/null | xargs -r basename || true)
CUR_MAIN=${CUR%%-r*}
OLDR=""; case "$CUR" in *-r*) OLDR=${CUR##*-r} ;; esac
# release этого sha уже не собрался — /mvp остаётся прежним
EFF=$RSHA
if [ -n "$RSHA" ] && [ -f "$RCACHE/$RSHA.failed" ]; then EFF=$OLDR; fi
NAME=$NEW; [ -n "$EFF" ] && NAME="$NEW-r$EFF"
[ "$NAME" = "$CUR" ] && exit 0
echo "$(date -Is) сборка $NAME (main $NEW, release ${RSHA:-нет})"

rm -rf "$BASE"/releases/.build-* 2>/dev/null || true
TMP=$BASE/releases/.build-$$
mkdir -p "$TMP"

# ── корень, /lab, /test — из main (main не менялся — берём из текущего релиза, без пересборки) ──
if [ "$NEW" = "$CUR_MAIN" ] && [ -f "$BASE/current/index.html" ]; then
  echo "main $NEW без изменений — корень и /lab из текущего релиза"
  cp -a "$BASE/current/." "$TMP/"
else
  git reset -q --hard FETCH_HEAD
  if [ -f package.json ]; then
    if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
    npm run build
    cp -a dist/. "$TMP/"
  else
    printf '<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><title>AR</title><body style="font:20px system-ui;display:grid;place-items:center;height:100vh;margin:0">AR-кот скоро будет здесь (%s)</body>' "$NEW" > "$TMP/index.html"
  fi
fi

# ── /mvp из release ──
build_release() { # $1 = sha → $RCACHE/$1 (dist сборки mvp,pilot); код возврата ≠ 0 — не собралось
  local sha=$1 out=$RCACHE/$1
  [ -f "$out/.ok" ] && { echo "release $sha — из кэша"; return 0; }
  echo "$(date -Is) сборка release $sha"
  cd "$RSRC" || return 1
  git reset -q --hard FETCH_HEAD || return 1
  [ "$(git rev-parse --short=7 HEAD)" = "$sha" ] || { echo "release: HEAD не $sha"; return 1; }
  npm ci --no-audit --no-fund || return 1
  # кэш сжатых моделей — общий с main (по содержимому): модели, которых release не менял, не кодируются заново
  AR_EDITIONS=mvp,pilot AR_MODEL_CACHE="$SRC/.cache/model-opt" npm run build || return 1
  [ -f dist/mvp/index.html ] || { echo "release: нет dist/mvp/index.html"; return 1; }
  rm -rf "$out.tmp" && mkdir -p "$out.tmp" && cp -a dist/. "$out.tmp/" || return 1
  touch "$out.tmp/.ok" && rm -rf "$out" && mv "$out.tmp" "$out" || return 1
  # кэш: 3 последних сборки (и метки неудач старше 14 дней)
  ls -1dt "$RCACHE"/*/ 2>/dev/null | tail -n +4 | xargs -r rm -rf
  find "$RCACHE" -maxdepth 1 -name '*.failed' -mtime +14 -delete 2>/dev/null || true
  echo "$(date -Is) release $sha собран"
}
put_release() { # $1 = sha из кэша → $TMP/mvp + недостающие хэшированные ассеты в корень
  local src=$RCACHE/$1
  [ -f "$src/mvp/index.html" ] || return 1
  rm -rf "$TMP/mvp" && cp -a "$src/mvp" "$TMP/mvp" || return 1
  cp -an "$src/." "$TMP/" 2>/dev/null || true
  rm -f "$TMP/.ok"
  echo "/mvp ← release $1"
}
USED=""
if [ -n "$RSHA" ] && [ "$EFF" = "$RSHA" ]; then
  if build_release "$RSHA" && put_release "$RSHA"; then USED=$RSHA
  else
    echo "$(date -Is) ВНИМАНИЕ: release $RSHA не собрался — /mvp остаётся прежним (${OLDR:-нет}); новый коммит release — новая попытка"
    touch "$RCACHE/$RSHA.failed"
  fi
fi
if [ -n "$RSHA" ] && [ -z "$USED" ] && [ -n "$OLDR" ]; then
  if put_release "$OLDR"; then USED=$OLDR
  elif [ -f "$BASE/current/mvp/index.html" ]; then rm -rf "$TMP/mvp"; cp -a "$BASE/current/mvp" "$TMP/mvp"; USED=$OLDR; echo "/mvp ← текущий релиз ($OLDR)"
  fi
fi
[ -n "$RSHA" ] && [ -z "$USED" ] && echo "$(date -Is) ВНИМАНИЕ: прежнего /mvp из release нет — /mvp из main $NEW"
NAME=$NEW; [ -n "$USED" ] && NAME="$NEW-r$USED"

cd "$BASE"
# release не собрался, а /mvp и main — те же, что сейчас на сайте: ничего не переключаем
if [ "$NAME" = "$CUR" ]; then rm -rf "$TMP"; echo "$(date -Is) без изменений: $NAME"; exit 0; fi
REL=$BASE/releases/$NAME
rm -rf "$REL"; mv "$TMP" "$REL"
ln -sfn "$REL" "$BASE/current.tmp" && mv -Tf "$BASE/current.tmp" "$BASE/current"
ls -1dt $BASE/releases/* | tail -n +6 | xargs -r rm -rf     # храним 5 последних
echo "$(date -Is) готово: $NAME"

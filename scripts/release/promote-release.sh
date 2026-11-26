#!/usr/bin/env bash
# Выпуск пилота (docs/RELEASE.md): fast-forward ветки release до проверенного коммита main → ar-update публикует /mvp.
#
#   npm run release:promote                      — последний origin/main: полные проверки → push release
#   npm run release:promote -- <коммит>          — конкретный коммит из истории main
#   npm run release:promote -- --dry             — только проверки и план, без push
#   npm run release:promote -- --skip-checks     — без проверок (только если этот коммит уже проверен — сказать продакту)
#
# Проверки — в отдельном git worktree на этом коммите (локальные правки не влияют), node_modules — симлинком на
# корневой: tsc → полный vitest последовательно → npm run build → npm run e2e:pilot. Любая красная — стоп, без push.
# Push — обычный (без --force): release может только догонять main. Release ушёл вбок (hotfix прямо в release) —
# скрипт откажет: сначала влить этот коммит в main.
# Запускать на машине разработчика / в песочнице Claude (нужен push в GitHub). На сервере не запускается: в
# scripts/deploy/ его нет — ar-auto его не выполнит.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
DRY=0; SKIP=0; TARGET=""
for a in "$@"; do
  case "$a" in
    --dry) DRY=1 ;;
    --skip-checks) SKIP=1 ;;
    -h|--help) sed -n 2,14p "$0"; exit 0 ;;
    -*) echo "неизвестный флаг $a"; exit 2 ;;
    *) TARGET=$a ;;
  esac
done
RB=release
git fetch -q origin main
git fetch -q origin "+refs/heads/$RB:refs/remotes/origin/$RB" 2>/dev/null || true
SHA=$(git rev-parse --verify "${TARGET:-origin/main}^{commit}")
SHORT=$(git rev-parse --short=7 "$SHA")
git merge-base --is-ancestor "$SHA" origin/main || { echo "СТОП: $SHORT не в истории origin/main — выпускать можно только коммиты main"; exit 1; }
if git rev-parse -q --verify "refs/remotes/origin/$RB" >/dev/null; then
  CUR=$(git rev-parse "refs/remotes/origin/$RB")
  if [ "$CUR" = "$SHA" ]; then echo "release уже на $SHORT — выпускать нечего"; exit 0; fi
  git merge-base --is-ancestor "$CUR" "$SHA" || { echo "СТОП: release ($(git rev-parse --short=7 "$CUR")) не предок $SHORT — fast-forward невозможен (hotfix в release? влейте его в main)"; exit 1; }
  echo "release: $(git rev-parse --short=7 "$CUR") → $SHORT ($(git rev-list --count "$CUR..$SHA") коммитов)"
  git log --oneline --no-decorate "$CUR..$SHA" | head -40
else
  echo "ветки release ещё нет — создаю на $SHORT"
fi

if [ "$SKIP" = 0 ]; then
  WT=$(mktemp -d "${TMPDIR:-/tmp}/ar-release-XXXX")
  cleanup() { git worktree remove --force "$WT" >/dev/null 2>&1 || rm -rf "$WT"; git worktree prune; }
  trap cleanup EXIT
  git worktree add -q --detach "$WT" "$SHA"
  [ -d node_modules ] && ln -s "$(pwd)/node_modules" "$WT/node_modules"
  (
    cd "$WT"
    echo "=== tsc ===" && npx tsc --noEmit
    echo "=== vitest (последовательно) ===" && npx vitest run --no-file-parallelism
    echo "=== build ===" && npm run build
    echo "=== e2e:pilot ===" && npm run e2e:pilot
  ) || { echo "СТОП: проверки красные — release не трогаю"; exit 1; }
  echo "проверки зелёные на $SHORT"
fi

if [ "$DRY" = 1 ]; then echo "--dry: push не делаю (git push origin $SHA:refs/heads/$RB)"; exit 0; fi
git push origin "$SHA:refs/heads/$RB"
echo "release → $SHORT. Через 2–15 мин /mvp соберётся из release (первая сборка нового коммита — дольше)."
echo "Проверка: node scripts/automation/enqueue.mjs script scripts/deploy/release-check.sh -- release=$SHORT  (затем push main)"

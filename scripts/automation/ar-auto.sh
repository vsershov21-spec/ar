#!/usr/bin/env bash
# Обёртка ar-auto (ставит install.sh в /opt/ar-auto; /usr/local/bin/ar-auto → сюда).
#   ar-auto status | tick [--wait] | push | mirror | run-job <id>
# PATH на момент установки (где нашлись node, tripo, git) — /opt/ar-auto/runtime.env: у systemd свой короткий PATH.
set -u
DIR=$(dirname "$(readlink -f "$0")")
[ -r "$DIR/runtime.env" ] && . "$DIR/runtime.env" && export PATH
[ "$(id -u)" = 0 ] || { echo "ar-auto: нужен root (sudo ar-auto $*)"; exit 3; }
command -v node >/dev/null || { echo "ar-auto: нет node (нужен 22+)"; exit 3; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || { echo "ar-auto: node $(node -v), нужен 22+"; exit 3; }
umask 077
exec node "$DIR/ar-auto.mjs" "$@"

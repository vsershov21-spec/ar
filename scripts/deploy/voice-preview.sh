#!/usr/bin/env bash
# Образцы голосов (ElevenLabs Voice Design) на странице https://ar.vershov.com/test/voice/ — для прослушки из РФ
# (elevenlabsusercontent.com из РФ отдаёт 403). Аргументы: пары <имя> <url>; url только с elevenlabsusercontent.com.
# Пишет /srv/ar-extra/test/voice/{<имя>.mp3,index.html} и запускает ar-update (attach-extra кладёт их в сайт).
set -euo pipefail
D=/srv/ar-extra/test/voice
mkdir -p "$D"
list=""
while [ $# -ge 2 ]; do
  name=$1; url=$2; shift 2
  url=${url//%3F/?}; url=${url//%26/&}   # очередь ar-auto не пускает ? и & в аргументах — передаём %3F/%26
  [[ $name =~ ^[a-z0-9_-]{1,40}$ ]] || { echo "плохое имя: $name"; exit 2; }
  [[ $url =~ ^https://elevenlabsusercontent\.com/ ]] || { echo "url не elevenlabsusercontent.com: $name"; exit 2; }
  curl -fsS --max-time 60 -o "$D/$name.mp3.tmp" "$url" && mv "$D/$name.mp3.tmp" "$D/$name.mp3"
  echo "ok $name $(stat -c %s "$D/$name.mp3") байт"
  list="$list $name"
done
{
  echo '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Голоса</title>'
  echo '<style>body{font:17px system-ui;margin:20px;max-width:560px}div{margin:14px 0;padding:12px;border:1px solid #ddd;border-radius:12px}audio{width:100%}</style><h2>Образцы голосов</h2>'
  for f in $(ls "$D"/*.mp3 | sort); do n=$(basename "$f" .mp3); echo "<div><b>$n</b><br><audio controls preload=none src=\"$n.mp3?v=$(stat -c %Y "$f")\"></audio></div>"; done
} > "$D/index.html"
chmod -R a+rX /srv/ar-extra/test
echo "страница: https://ar.vershov.com/test/voice/ (после пересборки ~3–5 мин)"
systemctl start --no-block ar-update && echo "ar-update запущен"

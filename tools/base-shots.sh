#!/bin/sh
# Снимки для листов базы котов (docs/models/BASE.md): sh tools/base-shots.sh <out> [коты]   (vite dev на $PORT, 4471)
#   → <out>/<кот>/{ov,vis,emo,lids,lip,anim_*,act_*}.png ; листы — python3 tools/base-sheet.py <out> <кот> …
set -e
cd "$(dirname "$0")/.."
D=$1; shift; CATS=${*:-glitter hooligan kind}
export PORT=${PORT:-4471} FACE_PORT=${PORT:-4471}
TEXT=${TEXT:-"Привет! Давай дружить, я покажу тебе фокус"}
for c in $CATS; do
  O=$D/$c; mkdir -p $O
  Q="v=front,tq,sider,back,face&w=600&h=880&models=base&bg=ffffff&fz=11" node tools/persona-shot.mjs $O ov $c > /dev/null
  PAGE=emo-preview node tools/face-shot.mjs $O/vis.png "p=$c&models=base&s=vis:X,vis:A,vis:B,vis:C,vis:D,vis:E,vis:F,vis:G,vis:H&cols=9&tile=260&dist=7" > /dev/null
  PAGE=emo-preview node tools/face-shot.mjs $O/emo.png "p=$c&models=base&s=neutral,excited,laugh,proud,wink_l,surprised,pout,shy,sad,purr,dizzy,sleep&cols=12&tile=260&dist=7" > /dev/null
  PAGE=emo-preview node tools/face-shot.mjs $O/lids.png "p=$c&models=base&s=blink:0.075,sleepy,happy,caring,listen,squished,cheeks_gum,smile+A&cols=8&tile=260&dist=7" > /dev/null
  PAGE=emo-preview node tools/face-shot.mjs $O/lip.png "p=$c&models=base&text=$TEXT&s=seq:0.15,seq:0.3,seq:0.45,seq:0.6,seq:0.75,seq:0.9,seq:1.05,seq:1.2,seq:1.35,seq:1.5&cols=10&tile=260&dist=7" > $O/lip.json
  for a in "idle_breathe&ct=1.0" "dance_$c&ct=1.3" "sit_idle&ct=1.0" "sleep_loop_bed&ct=1.0" "wave&ct=1.0"; do
    Q="v=tq,front&w=300&h=440&models=base&bg=ffffff&clip=$a" node tools/persona-shot.mjs $O anim_${a%%&*} $c > /dev/null
  done
  ACTS="cocoa:2.0 mirror:2.2 treat:2.0 gum:1.6"
  [ $c = hooligan ] && ACTS="$ACTS skate:1.6"
  for a in $ACTS; do
    Q="v=tq,front&w=300&h=440&models=base&bg=ffffff&act=${a%%:*}&at=${a##*:}" node tools/persona-shot.mjs $O act_${a%%:*} $c > /dev/null
  done
  echo "$c: снимки → $O"
done

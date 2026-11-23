# Блёстка: разворот продакта 23.11

`glitter_ref_sheet.jpg` — реф (`design/refs/glitter_turnaround_1123.png`) | было (p1 до правок) | стало p1 (пилот, рот шейдером) |
стало p2 (lab, риг лица); ниже — лицо крупно: покой, моргание, «а», «о», «у», улыбка, смех (p2 и p1, было/стало).
Как собрано и что осталось — docs/models/README.md, раздел «Блёстка по развороту продакта 23.11».

`legs_g1123.md` — anim-audit (пилот, `audit.mjs --cats glitter --only rest,act_dance,act_hug,act_pet,idleclip_idle_breathe,sig_mirror`):
стопы и колени в покое как в отчёте docs/qa/anim-audit/2026-11-23_legs_eyes (fv95 1.3–1.8 мм/с, дрожь ≤ 0.03 мм, обратного
сгиба нет); полуприкрытых век в покое 0 % хвоста кадров (было 76 %).

## Второй проход 24.11 (пачка в три яруса, длинный хвост)

`glitter_ref_sheet2.jpg` — реф | было (ece63b2) | стало p1 и p2; спина и профиль крупно; кадры «сидит» и «танец Блёстки»
(было | стало) — `tools/glitter-ref-sheet.py <dir> out.jpg --pass2` (съёмка — `tools/persona-shot.html` с `clip=`/`ct=`).
`tutu_poses_1124.md` — пачка и хвост в позах (`scripts/models/tutu_poses.py`, было/стало).

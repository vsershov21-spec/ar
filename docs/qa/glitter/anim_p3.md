# Блёстка p3: аудит анимаций (10 сценариев) — p1 vs p3

Стенд `scripts/qa/anim-audit/audit.mjs` (пилотная сборка, 30 к/с, без клипов Meshy — они только на сервере):

    node scripts/qa/anim-audit/audit.mjs --tag p3x --cats glitter --only rest,act_dance,act_flip,act_hug,act_paw,act_pet,doze_wake,home_bed,zone_head,stroke --params models=p3 --no-sheets
    node scripts/qa/anim-audit/audit.mjs --no-build --tag p1x --cats glitter --only … (то же без --params)

ok / tol (терпимо) / bad — пороги стенда (docs/qa/anim-audit/README.md). «нет видимой реакции» и lat — следствие отсутствия клипов
Meshy локально, у p1 и p3 одинаково. Важное для модели — лапы (slide), проникновение (кисть ↔ пачка), щелчки.

| сценарий | p1 (пилот) | p3 (?models=p3) |
|---|---|---|
| rest | bad · lat — мс, pop 12.8, slide 2.5 мм, нет видимой реакции; тело не отвечает (только лицо/эффект); щелчок 12.8 рад/с (LeftArm@idle_breathe); не вернулся в покой (idle_breathe) | bad · lat — мс, pop 12.1, slide 3.1 мм, нет видимой реакции; тело не отвечает (только лицо/эффект); щелчок 12.1 рад/с (LeftArm@idle_breathe); не вернулся в покой (idle_breathe) |
| zone_head | ok · lat 33 мс, pop 9.8, slide 1.4 мм, | tol · lat 100 мс, pop 11.1, slide 1.8 мм, щелчок 11.1 рад/с (RightHand@poke_head) |
| stroke | ok · lat 67 мс, pop 7.7, slide 2.2 мм, | ok · lat 67 мс, pop 9.5, slide 2.6 мм, |
| act_pet | bad · lat 33 мс, pop 17.1, slide 3 мм, щелчок 17.1 рад/с (RightArm@purr_stroke) | bad · lat 33 мс, pop 17.8, slide 4.1 мм, щелчок 17.8 рад/с (RightArm@purr_stroke) |
| act_paw | bad · lat 33 мс, pop 13.2, slide 6.9 мм, щелчок 13.2 рад/с (RightHand@wave); лапы едут 7 мм; проникновение 1.3 мм (LHand:skirt@wave) | tol · lat 33 мс, pop 14, slide 7.9 мм, щелчок 14.0 рад/с (RightHand@wave); лапы едут 8 мм |
| act_hug | tol · lat 0 мс, pop 11.9, slide 3.4 мм, щелчок 11.9 рад/с (RightUpLeg@purr_stroke) | tol · lat 0 мс, pop 11.9, slide 4 мм, щелчок 11.9 рад/с (RightUpLeg@purr_stroke) |
| act_dance | bad · lat 0 мс, pop 20.4, slide 18.7 мм, щелчок 20.4 рад/с (RightArm@dance_glitter); лапы едут 19 мм; проникновение 3.1 мм (RHand:skirt@dance_glitter) | bad · lat 0 мс, pop 14.4, slide 19.3 мм, щелчок 14.4 рад/с (RightForeArm@dance_glitter); лапы едут 19 мм |
| act_flip | tol · lat 0 мс, pop 13.9, slide 1.5 мм, щелчок 13.9 рад/с (LeftForeArm@flip) | tol · lat 0 мс, pop 12.3, slide 2.2 мм, щелчок 12.3 рад/с (LeftHand@flip) |
| doze_wake | tol · lat 33 мс, pop 11.9, slide 0.7 мм, щелчок 11.9 рад/с (LeftHand@sleep_loop); лечь/встать — переход смешиванием (нужен клип fall_asleep / wake_up) | tol · lat 33 мс, pop 9.9, slide 2.1 мм, лечь/встать — переход смешиванием (нужен клип fall_asleep / wake_up) |
| home_bed | bad · lat — мс, pop 14.5, slide 2.1 мм, нет видимой реакции; щелчок 14.5 рад/с (LeftArm@idle_breathe) | bad · lat — мс, pop 12, slide 2.6 мм, нет видимой реакции; щелчок 12.0 рад/с (LeftHand@idle_breathe); проникновение 2.8 мм (LHand:skirt@idle_breathe) |

Итог: скелет тот же — клипы, footPin и коррекция рук работают без правок; щелчки и скольжение лап — как у p1;
проникновение кисти в пачку ≤ 2.8 мм (у p1 до 3.1 мм в танце). Пачка p3 — сплошная оболочка Tripo, рукам она «твёрже»,
чем фатин p1: прокси `skirt` из `glitter_p3_colliders.json`.

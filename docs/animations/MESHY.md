# Клипы через Meshy Text-to-Motion

Недостающие клипы из [TZ.md](TZ.md) генерирует Meshy: **Text to Motion** (движение по тексту) → **Animation**
(движение на риге Хулигана, скелет Mixamo) → GLB. У трёх котов один скелет, поэтому клип один на всех.
Скрипт — `scripts/meshy/motion-run.sh` (+ `motion.mjs`, только node 22, без зависимостей), запускается на сервере
swe под root. Приложение (lab) подхватывает готовые клипы само, поверх `anims_v1.glb`.

## 1. Ключ

1. https://www.meshy.ai → войти → меню профиля → **API Keys** (раздел API в настройках) → *Create API key*.
   Ключ вида `msy_…` показывается один раз.
2. **Нужен платный план** (Pro и выше): на бесплатном API отвечает `402`, и риг, и анимация недоступны.
   Кредиты — в том же кабинете (Credits / Billing).
3. На сервере (ключ не попадает в историю команд и на экран):

```bash
read -rsp 'MESHY_API_KEY: ' K && printf 'MESHY_API_KEY=%s\n' "$K" > /etc/ar-meshy.env && chmod 600 /etc/ar-meshy.env && chown root:root /etc/ar-meshy.env; unset K; echo
```

Ключ читает только `motion.mjs` внутри процесса; в лог, консоль и репозиторий он не пишется. Сменить — та же команда.

## 2. Запуск

```bash
curl -fsSL https://raw.githubusercontent.com/vsershov21-spec/ar/main/scripts/meshy/motion-run.sh -o /tmp/meshy.sh
bash /tmp/meshy.sh                       # план P0: список, оценка кредитов, баланс — ничего не тратит
bash /tmp/meshy.sh --go                  # генерация P0 в фоне
tail -f /var/lib/vershov-commander/ar/meshy.log
```

| что | команда |
|---|---|
| план другого набора | `bash /tmp/meshy.sh --set p1` · `--set p0,p1` · `--set all` |
| только выбранные | `bash /tmp/meshy.sh --go --only wave,sit_down,sit_idle,stand_up` (любой id из `specs`, даже без `meshy` — тогда промпт Tripo) |
| переделать клип (снова тратит) | `bash /tmp/meshy.sh --go --redo wave` |
| другая модель для рига | `… --go --model-url https://…/x.glb --new-rig` |
| сколько параллельно | `--jobs 3` (1–5; по умолчанию 3) |

Скрипт каждый раз берёт свежие `motion.mjs` и `t2m_prompts_v2.json` из `main`.

**Возобновляемо.** Состояние — `/var/lib/vershov-commander/ar/meshy/state.json` (id задач Meshy, статусы, кредиты).
Повторный запуск: готовое (есть в манифесте и на диске) пропускает, начатые задачи дожидается, оплаченное **не
переотправляет**. Если ответ на создание задачи потерялся (сеть, 5xx) — клип помечается, скрипт его не трогает;
проверить в кабинете Meshy (Tasks) и, если задачи нет, `--redo id`. `402` (кредиты кончились) — стоп всего; `429` —
пауза и повтор. Неудачные задачи Meshy (`FAILED`) кредиты не списывают, но и их повторяет только `--redo`.

**Без ручного запуска:** задача в `automation/queue.json` (`kind: meshy`, `args: ["--only", "wave"]`, `maxCredits`) —
сервер выполнит её сам и выложит клипы в ветку `server-out` ([automation/README.md](../../automation/README.md)).

## 3. Стоимость

| шаг | кредиты |
|---|---|
| риг (`/rigging`, `skeleton_template: mixamo`) — один раз на все клипы | 5 |
| движение (`/text-to-motion`, `mode: prime`, FBX) | 10 за клип (`swift` — 3, хуже) |
| анимация на риге (`/animations`, `motion_task_id`) | 3 за клип |

**P0 (по умолчанию) — 33 клипа: 5 + 33 × 13 = 434 кредита.** P1 — 21 клип, 273. План печатает точную оценку с учётом
уже сделанного и баланс (`GET /openapi/v1/balance`).

Длительность в запросе — `durationS` из ТЗ вверх до 0,5 с, но не меньше 2 с (ограничение API: 2–10 с). Короткие
реакции (0,9–1,5 с по ТЗ) генерируются по 2 с: действие в начале, дальше «стоит неподвижно» — `animPrep` срежет хвост.

## 4. Промпты

`scripts/models/t2m_prompts_v2.json` → `specs[id].meshy = { prompt, duration, mode }` (P0 и P1, 54 клипа; прежние поля
`prompts` / `specs` для Tripo не тронуты). Правила (как в TZ §3, плюс особенности Meshy):

- один персонаж, только движение тела; без хвоста, ушей, лица, предметов как объектов («as if holding a mug»);
- «in place», «no turning», «no forward travel» — горизонталь и поворот кота делает сцена, `animPrep` обнуляет X/Z корня;
- старт и финиш — стойка («Starts standing upright facing forward with arms relaxed at the sides … returns to the same
  relaxed standing pose»), кроме цепочек: сидеть (`sit_down` → `sit_idle` → `stand_up`), сон (`fall_asleep`, `wake_up`),
  кровать (`get_into_bed` → `lie_down_side` → `sleep_loop_bed` ⇄ `turn_over_sleep` → `wake_stretch_in_bed` →
  `hop_out_of_bed`) — там первый кадр описан как последний кадр предыдущего клипа;
- кровать для Meshy — «knee-high platform / ledge»; лёжа — на левом боку, голова к своей левой (+X, вправо для
  зрителя), живот к зрителю — так ждёт `bedFlow` (`REAL_LIE`).

## 5. Модель для рига

По умолчанию — `https://ar.vershov.com/models/hooligan_v1.glb` (публичный, 4,2 МБ, 29 тыс. треугольников, с текстурами,
лицом к +Z — левая лапа на +X, стоит на Y = 0, рост 0,98). В нём уже есть свой скин (Tripo, 71 кость) и
блендшейпы — Meshy строит свой скелет Mixamo заново, наш ему не мешает. Если риг вернёт ошибку (`400` — модель не
подошла), запасной путь: выгрузить из Blender только тело (`tripo_mesh_…` + текстура) в GLB, положить в
`/srv/ar-extra/models/rig_src/hooligan_body.glb` (после сборки — `https://ar.vershov.com/models/rig_src/hooligan_body.glb`)
и запустить с `--model-url … --new-rig`.

Отдельного файла `hooligan_rig_v1.glb` в `public/models` нет: TZ ссылается на исходник; в сайте риг Хулигана — это
`hooligan_v1.glb` (Добряк `kind_v1.glb` и Блёстка `glitter_v1.glb` — тот же скелет).

## 6. Где файлы

| что | где |
|---|---|
| клипы для сайта (облегчённые: кости + анимация, ~30–100 КБ) | `/srv/ar-extra/models/anims/meshy/<id>.glb` |
| манифест | `/srv/ar-extra/models/anims/meshy/manifest.json` — `{id, file, loop, duration, durationGlb, prompt, rig_task_id, motion_task_id, animation_task_id, credits, created}` |
| сырые GLB Meshy (меш + скин + клип) и риг | `/var/lib/vershov-commander/ar/meshy/raw/`, `…/meshy/rig/hooligan_meshy_rig.glb` |
| состояние | `/var/lib/vershov-commander/ar/meshy/state.json` |
| лог | `/var/lib/vershov-commander/ar/meshy.log` |

Владелец выходной папки — `vershov-commander:caddy`. На сайт файлы попадают **со следующей сборкой** (любой push в
`main` или перезапуск `ar-update`): `scripts/voice/attach-extra.mjs` копирует `/srv/ar-extra/**` в `dist/`.
Проверка: `curl -s https://ar.vershov.com/models/anims/meshy/manifest.json | head`.

Облегчение (`motion.mjs slimGlb`): из GLB анимации выбрасываются меши, материалы и текстуры; поза привязки каждого
сустава (обратная inverseBindMatrix) пишется в `extras.bindWorld` узла. Проверить вручную:
`node /var/lib/vershov-commander/ar/meshy/motion.mjs --slim raw.glb out.glb`.

## 7. Как клип попадает в кота (lab и пилот)

`feature('anims.meshy')` (lab и **пилот** — вкл. с 18.11, MVP — выкл.) → `GlbCharacter.load()` после загрузки кота лениво:

1. `/models/anims/meshy/manifest.json` (нет — ничего, без ошибок: пилот играет как раньше);
2. каждый GLB → клип → `src/character/meshyClips.ts retargetClip`: кости по имени без `mixamorig:` (регистр не важен),
   пальцы / `_End` / `HeadTop` / глаза / челюсть выброшены; поворот переносится через мир относительно позы привязки
   (у нашего рига Tripo Hips повёрнут на −90°, у Meshy — нет: прямое копирование кватернионов перекосило бы кота);
   смещение таза × (высота таза у нас / у Meshy: человек 1,7 м → кот, `tests/meshyMap.test.ts`);
3. **проверка** (`checkClip`): NaN/∞, длительность 0,3–15 с, таз уезжает больше 3 высот таза по горизонтали или 2 по
   вертикали (ошибка единиц), поворот сустава от позы покоя за предел (шея/голова/стопа 100°, спина 110°, кисть 120°),
   скачок больше 90° за кадр. Не прошёл — клип отвергается (лог `[meshy] id: отвергнут — …`), играет прежний клип;
4. неподвижный хвост одноразового клипа срезается по скорости (`animPrep.trimStill`: Meshy генерирует ≥ 2 с), дальше
   `animPrep` как у всех клипов: сглаживание, шов петли, горизонталь корня = 0, высота по самой низкой опоре, темп;
5. **проникновение** (`GlbCharacter.penetration`, docs/animations/COLLISION.md): 8 кадров клипа → коррекция BodyCollider
   → глубже 5 мм — отвергается;
6. регистрация под id ТЗ — **своё имя важнее всего**: заменяет клип-опору (`fallback`), псевдоним Tripo, старый клип
   `anims_v1` и монтаж `cut` с тем же id; определение клипа — `clips.meshyDef`: без `cut`/`fallback`, петля и переходы
   (`blendInMs`, `blendOutMs` — мягкий возврат в покой) из правила `meshy` в `content/animations.json`;
7. сцена снимает поправки для опор: кровать (`bedFlow`: крен на бок, дуги прыжков, покачивание «ворочается», ноги
   вдоль тела — только для шага, который играет опорой), удержание лап (`footPin`) — как было: выкл. в ходьбе,
   акробатике, лёжа, кровати, сидя, повороте на месте, скейте.

`?meshy=0` — без них (сравнить с опорами). В консоли: `[meshy] клипы: …`, `🎞 Meshy: celebrate → treat_eat_kind (treat)`.

### Где какой клип играет

Правило `meshy` у клипа в `content/animations.json` (`loop`, `blendInMs`, `blendOutMs`, `on`, `from`, `then`, `holdS`).
Клипы с тем же id, что уже играет (тычки, `wave`, `sit_*`, кровать, раскраска, `tumble`, `dizzy`, `press_glass`,
`listen`, `appear_jump_in`…), встают на своё место сами. Новые id (18 клипов «только Meshy») заменяют клип реакции по
`meshy.on` (`clips.meshyUpgrade`, `director.playVisual`), **только когда клип пришёл**; иначе играет прежний клип:

| клип Meshy | где | вместо |
|---|---|---|
| `treat_eat_hooligan` / `_kind` / `_glitter` | событие `treat` («Угостить»), свой у каждого кота | `celebrate` |
| `scratch_enjoy` | кнопка «Почесать» (`action:scratch`) | `poke_head` (тап по голове пальцем — по-прежнему тычок) |
| `surprise_trick_*` | `surprise` («Удиви») | `surprised` |
| `tease_*` | `tease` («Подразни») | `offended` |
| `sad_sigh` | `emo_is_sad` (игра «угадай эмоцию») | `ears_back` (только уши) |
| `rps_throw` | `rps_is_rock / paper / scissors` | `proud` |
| `hug_receive_hooligan` / `_glitter` | `stroke_long` («Обнять»; у Добряка — свой клип) | `purr_stroke` |
| `skate_ride` | `skate` («Скейт», Хулиган) | `idle_hooligan_skate` |
| `fall_asleep` → `sleep_loop` | `sleep` («Усыпи», дрёма) | сразу `sleep_loop` |
| `wake_up` | `wake_up` (касание во сне) | `wake_startle` |
| `turn_step` | поворот к зрителю на месте > 25° (`stage.turnErr`, `director.turnStep`) | idle |
| `dive_out` | команда `goodbye` (`code:goodbye`) | `run_home` |
| `sit_down` → `sit_idle` (5 с) → `stand_up` | «Сидеть» | `sit_down` и сразу покой |

Цепочки (`then`) — только если оба клипа настоящие.

## 8. Проверка

**Отчёт:** `https://ar.vershov.com/lab/?desktop&meshyreport` (пилот — `https://ar.vershov.com/mvp/?from=test&desktop&meshyreport`)
→ вкладка **«Тест»** → **«Отчёт Meshy»**: каждый ожидаемый id → загружен / нет / отвергнут (причина), длительность,
остаток проникновения, где играет, что играет без него. Кнопка «Обновить · в консоль» печатает таблицу Markdown.

**Локально, до выкладки:** скачать клипы (`scp swe:/srv/ar-extra/models/anims/meshy/* ~/meshy/`) →
`node scripts/qa/meshy-check.mjs ~/meshy` — стенд реакций пилота (scripts/qa/reactions.mjs) с этими клипами (`--meshy`):
в логе состояния клипов, в docs/qa/REACTIONS.md — сравнение с прогоном `before` (щелчки, лапы, заглушки, проникновение).
`--dry` — только проверить папку; `--cats kind --only act_treat,act_hug` — часть сценариев.


Десктоп: `https://ar.vershov.com/lab/?desktop` → панель справа → вкладка **«Тест»** → раздел **«Клипы Meshy»**: список
загруженных клипов с длительностью, кнопка — сыграть.

Кровать (P0 «Сон и кровать»), подождать 2–3 с после появления кота (клипы грузятся после него):

- уложить: `https://ar.vershov.com/lab/?nocard&flow=home&zone=bedroom&bed=night` → «Уложить спать»
  (`get_into_bed` → `lie_down_side` → `sleep_loop_bed`);
- сон: `…/lab/?nocard&flow=home&zone=bedroom&bed=sleep` (тап — `turn_over_sleep`);
- подъём: `…/lab/?nocard&flow=home&zone=bedroom&bed=wake` (`wake_stretch_in_bed` → `hop_out_of_bed`);
- сравнить с опорами — те же ссылки с `&meshy=0`.

Тычки и команды: `https://ar.vershov.com/lab/?nocard` — тапы по голове/щеке/животу/лапе/хвосту, «Сидеть», «Помаши».
На что смотреть: лапы не скользят и не проваливаются в карту, корпус в конце смотрит туда же, куда в начале, нет
«щелчка» на стыке с idle, руки не проходят сквозь худи/шарф/юбку, петли (`sit_idle`, `sleep_loop_bed`, `turn_step`)
без рывка на шве. Не понравился клип — `bash /tmp/meshy.sh --go --redo <id>` (поправив промпт в `specs[id].meshy`).

## 9. В MVP

После проверки на iPhone по docs/DEVICE_TEST.md: `src/config/edition.ts` → `'anims.meshy': { mvp: true, … }` и «да» в
колонке «проверено на iPhone» в docs/EDITIONS.md. Больше ничего менять не нужно — те же файлы с сервера отдаются обеим
редакциям.

# QA-стенд: отчёт прогона

2026-11-17 23:19 UTC · коммит `4501da6` · 10.9 мин · headless Chrome 390×844, UA iPhone, CPU ×4, SwiftShader · тишина ×6

**Итог: шагов 23, ок 23, с замечаниями 0, с ошибками 0; ошибок сквозных проверок 0.**

Запуск: `npm run qa` (подробности — `scripts/qa/run.mjs`, пороги — `BUDGET` в `scripts/qa/checks.mjs`). Найденные баги — `docs/qa/BUGS.md`.

Ограничения стенда: GPU программный (FPS — ориентир, не телефон); голос кота — тишина длиной как реплика (fake-voice, набор озвученного `voice-src/el_batch_all.jsonl`);
фразы ребёнка — текстом через `window.__voice.text` (тот же путь, что после Vosk); микрофон — тихая комната (VAD, хлопки, громкость не проверяются); камера — синтетическое видео карты (`scripts/bench/gen_card_video.py`), «карта пропала» — подмена видео кадром стола без карты.

## Первый запуск (новый ребёнок)

| # | Шаг | Итог | Замечания | Время, с | Главный поток | Снимки |
|---|---|---|---|---|---|---|
| 1 | Первый запуск (?fresh): онбординг | ✅ ок | — | 5.1 | 90%, длинных задач 12 | [onboarding_1](shots/first_01_onboarding_1.jpg) [onboarding_2](shots/first_02_onboarding_2.jpg) [onboarding](shots/first_03_onboarding.jpg) |
| 2 | Разрешения: камера + микрофон одним нажатием | ✅ ок | — | 6.4 | 83%, длинных задач 5 | [permissions](shots/first_04_permissions.jpg) |
| 3 | Посадка кота на карту | ✅ ок | <sub>кот на карте через 7.0 с после «Открыть камеру» (CPU ×4, headless)</sub> | 10.8 | 98%, длинных задач 13 | [landing](shots/first_05_landing.jpg) |
| 4 | Знакомство целиком: поздравление → «как тебя зовут?» → имя → «я — …» → обучалка | ✅ ок | <sub>реплики знакомства: hooligan.meet_card.02, hooligan.meet_congrats.02, hooligan.ask_name.03, hooligan.nice_name.03, hooligan.meet_self.01, hooligan.meet_skills.03</sub> | 20.8 | 84%, длинных задач 55 | [ask_name](shots/first_06_ask_name.jpg) [meet](shots/first_07_meet.jpg) |
| 5 | Панель кнопок действий (если есть в этой сборке) | ✅ ок | <sub>панели кнопок нет (экран «вариант А»: действия — в каталоге по лапке и в чипах кота)</sub> | 3.1 | 45% | [actions](shots/first_08_actions.jpg) |
| 6 | Каталог «Что умеет кот»: каждый пункт каждого раздела | ✅ ок | <sub>разделов 7, пунктов 48</sub><br><sub>pet → hooligan.stroke.03; scratch → hooligan.tap_cat_head.01; tickle → hooligan.tap_cat_belly.01; cheek → hooligan.tap_cat_cheek.01; paw → hooligan.tap_cat_paw.04; treat → hooligan.treat.01; hug → hooligan.stroke_long.02; flip → hooligan.flip.05; dance → hooligan.dance.01; trick → hooligan.double_tap.05; jump → hooligan.jump.03; sit → hooligan.sit.02; wave → hooligan.wave.02; sing → hooligan.sing.02; riddle → hooligan.riddle.03; echo → hooligan.echo_start.01; rps → hooligan.rps_start.02; emo → hooligan.emo_start.02; simon → hooligan.simon_start.01; laugh → hooligan.joke.01; surprise → hooligan.surprise.01; shy → hooligan.compliment.01; tease → hooligan.tease.02; dizzy → hooligan.shake.02; sleep → hooligan.sleep.01; bubbles → hooligan.gum.01; draw → hooligan.swipe.01; glass → hooligan.longpress.03; knock → hooligan.tap_screen.01; sticker → hooligan.stickers.02; say:hello → hooligan.hello.03; say:name_ask → hooligan.name_ask.03; say:age_ask → hooligan.age_ask.02; say:help → hooligan.help.02; say:flip → hooligan.flip.02; say:jump → hooligan.jump.02; say:dance → hooligan.dance.04; say:sing → hooligan.sing.01; say:wave → hooligan.wave.01; say:riddle → hooligan.riddle.01; say:joke → hooligan.joke.02; say:echo_start → hooligan.echo_start.03; say:compliment → hooligan.compliment.02; say:thanks → hooligan.thanks.02; say:brother_ask → hooligan.brother_ask.01</sub> | 302 | 79%, длинных задач 938 | [catalog](shots/first_09_catalog.jpg) [catalog](shots/first_10_catalog.jpg) |
| 7 | Чипы-предложения от кота | ✅ ок | <sub>Танец → hooligan.dance.05; Другой кот → hooligan.switch_start.01</sub> | 22 | 95%, длинных задач 74 | [chips](shots/first_11_chips.jpg) [chips](shots/first_12_chips.jpg) |
| 8 | Голосовые фразы ребёнка | ✅ ок | <sub>«привет» → kind.hello.01; «как тебя зовут» → kind.name_ask.02; «сколько тебе лет» → kind.age_ask.01; «ты классный» → kind.compliment.03; «абырвалг» → kind.unknown.01; «мне грустно» → kind.sad.02</sub> | 43.8 | 81%, длинных задач 134 | [speech](shots/first_13_speech.jpg) |
| 9 | Мини-игра «загадка»: неверно → сдаюсь → «ещё?» → нет | ✅ ок | <sub>чипы во время загадки: Сдаюсь</sub> | 23.4 | 63%, длинных задач 21 | [riddle](shots/first_14_riddle.jpg) |
| 10 | Мини-игра «повторялка»: фраза → «хватит» | ✅ ок | <sub>чипы в повторялке: Хватит</sub> | 8.7 | 89%, длинных задач 12 | [echo](shots/first_15_echo.jpg) |
| 11 | Кнопка посреди загадки: игра кончается, команда выполняется | ✅ ок | — | 13.1 | 71%, длинных задач 30 | [riddle_button](shots/first_16_riddle_button.jpg) |
| 12 | Касания: тап по коту, поглаживание, тап мимо | ✅ ок | <sub>тап мимо: {"speak":"kind.tap_screen.03"}</sub> | 11.5 | 61%, длинных задач 3 | [touch](shots/first_17_touch.jpg) |
| 13 | «Без звука»: реплика идёт молча, пузырь успевают прочитать | ✅ ок | — | 10.5 | 83%, длинных задач 17 | [muted_bubble](shots/first_18_muted_bubble.jpg) [mute](shots/first_19_mute.jpg) |
| 14 | Карта пропала → «где карта?» → вернулась | ✅ ок | <sub>потеря: kind.silence.03, kind.card_lost.01</sub><br><sub>возврат: kind.card_found.02</sub> | 19 | 60%, длинных задач 18 | [card_lost](shots/first_20_card_lost.jpg) [card_lost](shots/first_21_card_lost.jpg) |
| 15 | Долгое нажатие на кота → «Пересадить на другую карту» → кот снова на карте | ✅ ок | — | 10.4 | 87%, длинных задач 24 | [press_menu](shots/first_22_press_menu.jpg) [reanchor](shots/first_23_reanchor.jpg) |
| 16 | Смена кота: «Другой кот» → наклейки → встряска → новый образ | ✅ ок | <sub>kind → glitter</sub><br><sub>текстуры GPU: 18 → 19, геометрии: 21 → 18, программы: 15 → 14</sub> | 38.1 | 98%, длинных задач 105 | [stickers](shots/first_24_stickers.jpg) [switch](shots/first_25_switch.jpg) |
| 17 | 3 мин тишины (время ×6): лестница → дрёма | ✅ ок | <sub>лестница: тишина 30 с → offer · тишина 55 с → filler · тишина 86 с → offer · тишина 118 с → doze · энергия: кот дремлет (60 с без касаний, речи и движения) — минимальные частоты</sub><br><sub>чипы в дрёме: Разбуди меня</sub> | 37.2 | 95%, длинных задач 168 | [doze](shots/first_26_doze.jpg) [silence](shots/first_27_silence.jpg) |
| 18 | Пробуждение касанием | ✅ ок | — | 7.2 | 91%, длинных задач 8 | [wake_up](shots/first_28_wake_up.jpg) |
| 19 | Итог сессии: память, утечки | ✅ ок | — | 8.1 | 100%, длинных задач 3 | [end](shots/first_29_end.jpg) |

**Сквозные проверки сессии**

| Проверка | Результат |
|---|---|
| Реплики (озвучены ли) | 118 реплик, без записи: 0 |
| Пузырь гаснет с голосом | пузырь гаснет через 276 мс после голоса (медиана; без зависаний потока — 48…699 мс) |
| Подсказки кота в пузыре (без голоса, UI) | 2: «Погладь меня или скажи «танцуй»», «Скажи мне «повторяй за мной»» |
| Куча JS (после GC: посадка → конец) | 8.8 → 11.4 МБ (+2.7) |
| Слушатели событий | 51 → 65 |
| Узлы DOM | 500 → 631 |
| Текстуры GPU | 16 → 19 |
| Программы шейдеров | 14 → 14 |
| Частота кадров в игре | медиана 26.0 к/с при цели 60 (кадров ниже ½ цели: 36%) |
| Режимы энергобюджета в игре | boost 64%, normal 19%, calm 16%, doze 1% |
| Длинные задачи главного потока | 1547 задач > 50 мс, 1 > 500 мс (макс. 2509 мс); на снимках стенда ещё 225 — не в счёт |
| Самые длинные задачи | 2509 мс на 537.0 с (после «качество: уровень 3 (pixelRatio 1.00, мех ×0.25, трекер 20 Г»); 454 мс на 365.9 с (после «шаг: Голосовые фразы ребёнка»); 399 мс на 365.5 с (после «шаг: Голосовые фразы ребёнка»); 371 мс на 524.8 с (после «persona → glitter (голос ru_RU-irina-medium, +3 пт)»); 338 мс на 554.6 с (после «ускорение ×6»); 322 мс на 523.7 с (после «covered → switching») |
| Предупреждения консоли | 5 |

Замечания:

- ⚠️ консоль error: Unrecognized archive format

## Повторный визит (тот же телефон)

| # | Шаг | Итог | Замечания | Время, с | Главный поток | Снимки |
|---|---|---|---|---|---|---|
| 1 | Повторный визит: стартовый экран | ✅ ок | — | 5.2 | 89%, длинных задач 12 | [onboarding_1](shots/return_01_onboarding_1.jpg) [onboarding_2](shots/return_02_onboarding_2.jpg) [ret_onboarding](shots/return_03_ret_onboarding.jpg) |
| 2 | Повторный визит: посадка и «с возвращением» | ✅ ок | <sub>посадка через 2.3 с</sub><br><sub>приветствие: glitter.welcome_back.05 «Привет-привет! Я так рада тебя видеть.»</sub> | 14.1 | 96%, длинных задач 47 | [ret_landing](shots/return_04_ret_landing.jpg) |
| 3 | Повторный визит: кнопка и фраза | ✅ ок | — | 26.1 | 74%, длинных задач 14 | [ret_play](shots/return_05_ret_play.jpg) |

**Сквозные проверки сессии**

| Проверка | Результат |
|---|---|
| Реплики (озвучены ли) | 6 реплик, без записи: 0 |
| Пузырь гаснет с голосом | пузырь гаснет через 3512 мс после голоса (медиана; без зависаний потока — 338…338 мс) |
| Подсказки кота в пузыре (без голоса, UI) | 1: «Скажи мне «загадай загадку»» |
| Частота кадров в игре | медиана 24.8 к/с при цели 60 (кадров ниже ½ цели: 46%) |
| Режимы энергобюджета в игре | boost 64%, calm 8%, normal 28% |
| Длинные задачи главного потока | 66 задач > 50 мс, 0 > 500 мс (макс. 337 мс); на снимках стенда ещё 23 — не в счёт |
| Самые длинные задачи | 337 мс на 3.1 с (после «card_found → appear»); 317 мс на 3.5 с (после «фаза play»); 301 мс на 4.7 с (после «качество: уровень 1 (pixelRatio 1.50, мех ×1, трекер 30 Гц)»); 280 мс на 5.5 с (после «качество: уровень 1 (pixelRatio 1.50, мех ×1, трекер 30 Гц)»); 263 мс на -4.1 с (после «загрузки»); 204 мс на 5.9 с (после «качество: уровень 1 (pixelRatio 1.50, мех ×1, трекер 30 Гц)») |
| Предупреждения консоли | 1 |

Замечания:

- ⚠️ консоль error: Unrecognized archive format

## Камера запрещена

| # | Шаг | Итог | Замечания | Время, с | Главный поток | Снимки |
|---|---|---|---|---|---|---|
| 1 | Камера запрещена: понятный экран и кнопка «повторить» | ✅ ок | — | 3.2 | 50%, длинных задач 2 | [onboarding_1](shots/denied_01_onboarding_1.jpg) [onboarding_2](shots/denied_02_onboarding_2.jpg) [denied](shots/denied_03_denied.jpg) |

**Сквозные проверки сессии**

| Проверка | Результат |
|---|---|
| Реплики (озвучены ли) | 0 реплик, без записи: 0 |
| Длинные задачи главного потока | 0 задач > 50 мс, 0 > 500 мс (макс. 0 мс); на снимках стенда ещё 0 — не в счёт |
| Самые длинные задачи |  |
| Предупреждения консоли | 1 |

Ошибок и замечаний нет.

## Пороги

| Порог | Значение |
|---|---|
| `landingSec` | 20 |
| `heapGrowMB` | 25 |
| `listenersGrow` | 300 |
| `nodesGrow` | 2000 |
| `texGrowPerSwitch` | 6 |
| `slowFrameShare` | 0.5 |
| `longTasks500` | 6 |
| `bubbleLagMs` | 900 |
| `gameSilentSec` | 12 |
| `clipStuckSec` | 25 |
| `talkNoVoiceSec` | 3 |
| `bubbleNoVoiceSec` | 4 |

# QA-стенд: отчёт прогона

2026-11-18 01:23 UTC · коммит `ec62bee` · 10.9 мин · headless Chrome 390×844, UA iPhone, CPU ×4, SwiftShader · тишина ×6

**Итог: шагов 23, ок 21, с замечаниями 2, с ошибками 0; ошибок сквозных проверок 0.**

Запуск: `npm run qa` (подробности — `scripts/qa/run.mjs`, пороги — `BUDGET` в `scripts/qa/checks.mjs`). Найденные баги — `docs/qa/BUGS.md`.

Ограничения стенда: GPU программный (FPS — ориентир, не телефон); голос кота — тишина длиной как реплика (fake-voice, набор озвученного `voice-src/el_batch_all.jsonl`);
фразы ребёнка — текстом через `window.__voice.text` (тот же путь, что после Vosk); микрофон — тихая комната (VAD, хлопки, громкость не проверяются); камера — синтетическое видео карты (`scripts/bench/gen_card_video.py`), «карта пропала» — подмена видео кадром стола без карты.

## Первый запуск (новый ребёнок)

| # | Шаг | Итог | Замечания | Время, с | Главный поток | Снимки |
|---|---|---|---|---|---|---|
| 1 | Первый запуск (?fresh): онбординг | ✅ ок | — | 5.5 | 92%, длинных задач 17 | [onboarding_1](shots/first_01_onboarding_1.jpg) [onboarding_2](shots/first_02_onboarding_2.jpg) [onboarding](shots/first_03_onboarding.jpg) |
| 2 | Разрешения: камера + микрофон одним нажатием | ✅ ок | — | 7.5 | 83%, длинных задач 7 | [permissions](shots/first_04_permissions.jpg) |
| 3 | Посадка кота на карту | ✅ ок | <sub>кот на карте через 8.0 с после «Открыть камеру» (CPU ×4, headless)</sub> | 20.4 | 99%, длинных задач 14 | [landing](shots/first_05_landing.jpg) |
| 4 | Знакомство целиком: поздравление → «как тебя зовут?» → имя → «я — …» → обучалка | ⚠️ замечания | «bubble» закрывает морду кота на 26%<br><sub>реплики знакомства: hooligan.meet_card.02, hooligan.meet_congrats.02, hooligan.ask_name.02, hooligan.ask_name_again.03, hooligan.nice_name.02, hooligan.meet_self.03, hooligan.meet_skills.03, hooligan.help.01</sub> | 22.6 | 73%, длинных задач 36 | [ask_name](shots/first_06_ask_name.jpg) [meet](shots/first_07_meet.jpg) |
| 5 | Панель кнопок действий (если есть в этой сборке) | ⚠️ замечания | «bubble» закрывает морду кота на 30%<br><sub>панели кнопок нет (экран «вариант А»: действия — в каталоге по лапке и в чипах кота)</sub> | 3 | 86% | [actions](shots/first_08_actions.jpg) |
| 6 | Каталог «Что умеет кот»: каждый пункт каждого раздела | ✅ ок | <sub>разделов 7, пунктов 48</sub><br><sub>pet → hooligan.stroke.01; scratch → hooligan.tap_cat_head.01; tickle → hooligan.tap_cat_belly.03; cheek → hooligan.tap_cat_cheek.03; paw → hooligan.tap_cat_paw.03; treat → hooligan.treat.05; hug → hooligan.stroke_long.04; flip → hooligan.flip.02; dance → hooligan.dance.02; trick → hooligan.double_tap.04; jump → hooligan.jump.01; sit → hooligan.sit.02; wave → hooligan.wave.02; sing → hooligan.sing.02; riddle → hooligan.riddle.01; echo → hooligan.echo_start.01; rps → hooligan.rps_start.01; emo → hooligan.emo_start.01; simon → hooligan.simon_start.02; laugh → hooligan.joke.01; surprise → hooligan.surprise.02; shy → hooligan.compliment.01; tease → hooligan.tease.01; dizzy → hooligan.shake.03; sleep → hooligan.sleep.01; bubbles → wake_startle; draw → hooligan.swipe.04; glass → hooligan.longpress.01; knock → hooligan.tap_screen.04; sticker → hooligan.stickers.02; say:hello → hooligan.hello.01; say:name_ask → hooligan.name_ask.01; say:age_ask → hooligan.age_ask.02; say:help → hooligan.help.02; say:flip → hooligan.flip.01; say:jump → hooligan.jump.03; say:dance → hooligan.dance.04; say:sing → hooligan.sing.01; say:wave → hooligan.wave.01; say:riddle → hooligan.riddle.02; say:joke → hooligan.joke.03; say:echo_start → hooligan.echo_start.03; say:compliment → hooligan.compliment.03; say:thanks → hooligan.thanks.03; say:brother_ask → hooligan.brother_ask.01</sub> | 288.9 | 72%, длинных задач 394 | [catalog](shots/first_09_catalog.jpg) [catalog](shots/first_10_catalog.jpg) |
| 7 | Чипы-предложения от кота | ✅ ок | <sub>Танец → hooligan.dance.01; Другой кот → hooligan.switch_ask.01</sub> | 16.8 | 96%, длинных задач 60 | [chips](shots/first_11_chips.jpg) [chips](shots/first_12_chips.jpg) |
| 8 | Голосовые фразы ребёнка | ✅ ок | <sub>«привет» → hooligan.hello.02; «как тебя зовут» → hooligan.name_ask.02; «сколько тебе лет» → hooligan.age_ask.01; «ты классный» → hooligan.compliment.02; «абырвалг» → hooligan.unknown.02; «мне грустно» → hooligan.sad.03</sub><br><sub>после «мне грустно» → «Погладить»: hooligan.stroke.02</sub> | 31.5 | 83%, длинных задач 44 | [speech](shots/first_13_speech.jpg) |
| 9 | Мини-игра «загадка»: неверно → сдаюсь → «ещё?» → нет | ✅ ок | <sub>чипы во время загадки: Сдаюсь</sub> | 24.8 | 80%, длинных задач 32 | [riddle](shots/first_14_riddle.jpg) |
| 10 | Мини-игра «повторялка»: фраза → «хватит» | ✅ ок | <sub>чипы в повторялке: Хватит</sub> | 11.2 | 94%, длинных задач 16 | [echo](shots/first_15_echo.jpg) |
| 11 | Кнопка посреди загадки: игра кончается, команда выполняется | ✅ ок | — | 10.8 | 76%, длинных задач 10 | [riddle_button](shots/first_16_riddle_button.jpg) |
| 12 | Касания: тап по коту, поглаживание, тап мимо | ✅ ок | <sub>тап мимо: {"speak":"hooligan.tap_screen.03","clip":"knock_glass"}</sub> | 13.4 | 93%, длинных задач 34 | [touch](shots/first_17_touch.jpg) |
| 13 | «Без звука»: реплика идёт молча, пузырь успевают прочитать | ✅ ок | — | 12.4 | 88%, длинных задач 8 | [muted_bubble](shots/first_18_muted_bubble.jpg) [mute](shots/first_19_mute.jpg) |
| 14 | Карта пропала → «где карта?» → вернулась | ✅ ок | <sub>потеря: hooligan.silence.03, hooligan.card_lost.01</sub><br><sub>возврат: hooligan.card_found.01</sub> | 21.1 | 78%, длинных задач 42 | [card_lost](shots/first_20_card_lost.jpg) [card_lost](shots/first_21_card_lost.jpg) |
| 15 | Долгое нажатие на кота → «Пересадить на другую карту» → кот снова на карте | ✅ ок | — | 14 | 95%, длинных задач 21 | [press_menu](shots/first_22_press_menu.jpg) [reanchor](shots/first_23_reanchor.jpg) |
| 16 | Смена кота: «Другой кот» → наклейки → встряска → новый образ | ✅ ок | <sub>подтверждение: Давай! / Не надо</sub><br><sub>hooligan → kind</sub><br><sub>текстуры GPU: 16 → 15, геометрии: 21 → 19, программы: 15 → 13</sub> | 40 | 98%, длинных задач 81 | [stickers](shots/first_24_stickers.jpg) [switch](shots/first_25_switch.jpg) |
| 17 | 3 мин тишины (время ×6): лестница → дрёма | ✅ ок | <sub>лестница: тишина 30 с → offer · тишина 58 с → filler · тишина 84 с → offer · тишина 111 с → doze · энергия: кот дремлет (60 с без касаний, речи и движения) — минимальные частоты</sub><br><sub>чипы в дрёме: Разбуди меня</sub> | 34.7 | 87%, длинных задач 78 | [doze](shots/first_26_doze.jpg) [silence](shots/first_27_silence.jpg) |
| 18 | Пробуждение касанием | ✅ ок | — | 5.7 | 72%, длинных задач 5 | [wake_up](shots/first_28_wake_up.jpg) |
| 19 | Итог сессии: память, утечки | ✅ ок | — | 19.1 | 98%, длинных задач 6 | [end](shots/first_29_end.jpg) |

**Сквозные проверки сессии**

| Проверка | Результат |
|---|---|
| Реплики (озвучены ли) | 120 реплик, без записи: 0 |
| Пузырь гаснет с голосом | пузырь гаснет через 260 мс после голоса (медиана; без зависаний потока — 46…443 мс) |
| Куча JS (после GC: посадка → конец) | 14.2 → 11.1 МБ (-3.2) |
| Слушатели событий | 52 → 66 |
| Узлы DOM | 503 → 620 |
| Текстуры GPU | 16 → 18 |
| Программы шейдеров | 14 → 14 |
| Частота кадров в игре | медиана 31.3 к/с при цели 60 (кадров ниже ½ цели: 24%) |
| Режимы энергобюджета в игре | boost 68%, normal 16%, calm 16%, doze 1% |
| Длинные задачи главного потока | 810 задач > 50 мс, 0 > 500 мс (макс. 296 мс); на снимках стенда ещё 199 — не в счёт |
| Самые длинные задачи | 296 мс на 511.1 с (после «🗨 hooligan.switch_start.02: Секунду, достаю другой образ.»); 292 мс на 516.9 с (после «persona → kind (голос ru_RU-ruslan-medium, +2 пт)»); 282 мс на 510.8 с (после «🗨 hooligan.switch_start.02: Секунду, достаю другой образ.»); 261 мс на 63.7 с (после «шаг: Каталог «Что умеет кот»: каждый пункт каждого раздела»); 246 мс на 237.9 с (после «каталог: glass»); 236 мс на 485.2 с (после «шаг: Долгое нажатие на кота → «Пересадить на другую карту» →») |
| Предупреждения консоли | 5 |

Замечания:

- ⚠️ консоль error: Unrecognized archive format

## Повторный визит (тот же телефон)

| # | Шаг | Итог | Замечания | Время, с | Главный поток | Снимки |
|---|---|---|---|---|---|---|
| 1 | Повторный визит: стартовый экран | ✅ ок | — | 5.8 | 94%, длинных задач 21 | [onboarding_1](shots/return_01_onboarding_1.jpg) [onboarding_2](shots/return_02_onboarding_2.jpg) [ret_onboarding](shots/return_03_ret_onboarding.jpg) |
| 2 | Повторный визит: посадка и «с возвращением» | ✅ ок | <sub>посадка через 1.7 с</sub><br><sub>приветствие: kind.welcome_back.05 «Привет! А я как раз какао сварил.»</sub> | 10.9 | 96%, длинных задач 42 | [ret_landing](shots/return_04_ret_landing.jpg) |
| 3 | Повторный визит: кнопка и фраза | ✅ ок | — | 27.1 | 71%, длинных задач 4 | [ret_play](shots/return_05_ret_play.jpg) |

**Сквозные проверки сессии**

| Проверка | Результат |
|---|---|
| Реплики (озвучены ли) | 7 реплик, без записи: 0 |
| Пузырь гаснет с голосом | пузырь гаснет через 4596 мс после голоса (медиана; без зависаний потока — — мс) |
| Частота кадров в игре | медиана 29.4 к/с при цели 60 (кадров ниже ½ цели: 37%) |
| Режимы энергобюджета в игре | boost 54%, normal 43%, calm 3% |
| Длинные задачи главного потока | 64 задач > 50 мс, 0 > 500 мс (макс. 232 мс); на снимках стенда ещё 11 — не в счёт |
| Самые длинные задачи | 232 мс на -4.4 с (после «загрузки»); 216 мс на -4.7 с (после «загрузки»); 183 мс на -1.2 с (после «загрузки»); 166 мс на 2.3 с (после «card_found → appear»); 165 мс на 2.8 с (после «фаза play»); 148 мс на -2.6 с (после «загрузки») |
| Предупреждения консоли | 1 |

Замечания:

- ⚠️ консоль error: Unrecognized archive format

## Камера запрещена

| # | Шаг | Итог | Замечания | Время, с | Главный поток | Снимки |
|---|---|---|---|---|---|---|
| 1 | Камера запрещена: понятный экран и кнопка «повторить» | ✅ ок | — | 2.4 | 71%, длинных задач 3 | [onboarding_1](shots/denied_01_onboarding_1.jpg) [onboarding_2](shots/denied_02_onboarding_2.jpg) [denied](shots/denied_03_denied.jpg) |

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

# Аналитика воронки (пилот /mvp и lab)

Зачем: понять на пилоте, где дети отваливаются — от открытия ссылки до игры с котом, дома и сна.
Функция `analytics` (`src/config/edition.ts`): **pilot и lab — да, MVP — нет**. `?noanalytics` выключает в любой
редакции (события не уходят вовсе).

## Как устроено

- Клиент — `src/analytics/index.ts`: `bootAnalytics()` в `main.ts` (после `bootProgress`), `track(name, props)` в
  точках входа. Каждое событие — отдельный `navigator.sendBeacon('/api/progress/event', text/plain JSON)`; не ждёт
  ответа, переживает закрытие вкладки. Не больше 400 событий за сессию.
- Сервер — тот же сервис прогресса (`server/progress/server.mjs`): `POST /api/progress/event` → 204. Таблица
  `events(ts, device, edition, name, props)` в `progress.sqlite` (файловое хранилище — `events.jsonl`), только
  дописывается; удаляется по тому же сроку, что и прогресс (`PROGRESS_TTL_DAYS`, 90 дней).
  Не больше 60 событий в минуту на устройство (429), тело ≤ 1 КБ (413), неизвестное событие / редакция /
  устройство — 400. `ts` ставит сервер.
- Сводка — `GET /api/progress/stats?token=…&days=14` (или `Authorization: Bearer …`; без токена — 401):
  `{ funnel: [...], rows: [{ day, edition, events: { name: { n, devices } } }], bySrc: [{ day, edition, src, events }], srcs: [{ src, devices }] }`,
  дни UTC, новые сверху. `bySrc` и `srcs` — разрез по метке источника из QR (добавлены 22.11, `rows` не менялись);
  `&src=<метка>` — `rows`/`bySrc` только по ней, `&src=none` — события без метки.
  Страница **/test/admin** → «Воронка пилота»: таблица «событие × день/редакция», в ячейке «раз / устройств».

## Метка источника из QR (`?src=`)

Ссылка в QR отделения: `https://ar.vershov.com/mvp/?src=<банк/точка>` (например `?src=lipetsk39`). Клиент
(`src/analytics readSrc`) берёт метку только из латиницы и цифр, до 32 символов (иначе — без метки), и запоминает её
в `localStorage` (`ar.src`, 30 дней): открыли ссылку из истории без метки — сессия всё равно «из точки». Метка уходит
полем `src` в **каждом** событии; сервер проверяет её тем же правилом и кладёт в `props.src` (формат строк `events` —
прежний: `ts, device, edition, name, props`). Метка — это точка раздачи QR, одна на всех детей: не персональные данные.

## Персональные данные — нет

Уходит только: id устройства (тот же случайный UUID, что у серверного прогресса, cookie `pilot_ar_device` /
`lab_ar_device`), редакция, имя события из списка ниже, его свойства из белого списка. Белый список — дважды:
клиент (`sanitize`) и сервер (`cleanProps`): числа — целые 0…10⁷, строки — латинские id `[a-z0-9_:.-]` до 32
символов; всё прочее выбрасывается. **Никогда**: имя ребёнка (событие `named` — только факт), речь и тексты, данные
карты (номер, имя, срок, кадры), IP в таблице. Проверяют `tests/analytics.test.ts`.

## События

| Событие | Свойства | Когда (точка входа) |
|---|---|---|
| `open` | — | страница открыта (`bootAnalytics`), раз за сессию |
| `onboarding_done` | — | прошёл онбординг, нажал «Открыть камеру» (`app.ts wake`), раз |
| `camera_granted` | — | камера включилась (`app.ts wake`, после `startVideo`), раз |
| `card_landed` | `ms` — от открытия страницы | карта Сбера найдена впервые (`tracker.onFound`), раз |
| `awake_done` | — | сцена пробуждения доиграла (`src/awake finish`), раз |
| `named` | — | ребёнок назвал имя (`director` → `remember` с именем), раз; имени нет |
| `action` | `id` — кнопка каталога / чипа (`pet`, `skate`, `riddle`…) | `director.action` |
| `game_start` / `game_end` | `id` — диалог (`riddle`, `echo`, `offer`, `switch`…) | начало / конец диалога сценария (`director` событие `game`) |
| `cat_switch` | `to` — новый кот | смена кота (событие `persona`, кроме первого выбора) |
| `home_enter` | `reason`: `lost` (карта потеряна > 6 с), `quiet`, `memory`, `chip`, `button`, `flow` | вход в «Мир кота» (`homeMode.enter`) |
| `sleep` / `wake` | — | кота уложили в кровать / разбудили (`home/bedFlow.ts`) |
| `card_lost` | `count` — какая по счёту потеря | карта пропала из кадра (`tracker.onLost`) |
| `sberkids_click` | `kind`: `open` (кнопка «В СберKids»), `go` («Открыть СберKids»), `close` («Потом») | `app.ts onKids`, `ui.ts` |
| `paint_offer` | — | кот сам предложил раскрасить карту (`src/card/paint.ts offerTick`, раз за сессию) |
| `paint_start` | `color` — id цвета палитры (`lime`, `pink`, `purple`, `mint`, `peach`, `sky`, `lilac`, `gold`, `turquoise`) | выбран цвет, кот начал рисовать (`CardPaint.start`) |
| `paint_done` | — | рисунок готов (или дорисован сразу, если карта ушла посреди) |
| `paint_erase` | — | «Стереть рисунок» в каталоге |
| **Воронка входа** (быстрый вход `intro.quick`, `src/quick`; `ms` — мс от начала навигации; раз за сессию) | | |
| `page_open` | `ms` — когда стартовал JS | вместе с `open` (`bootAnalytics`) |
| `splash_shown` | `ms` | заставка нарисована — **до бандла** (встроенный скрипт `src/quick/splash.ts`; события копятся в `window.__quick.ev` и уходят при старте аналитики) |
| `cta_tap` | `ms`, `early` — 1, если нажали до готовности приложения | «Узнать, кто там» |
| `camera_granted` / `camera_denied` | `ms` | камера дана / отказ (в т. ч. до бандла); `camera_denied` — на каждый отказ |
| `camera_retry` | `ms` | «Попробовать ещё раз» на экране отказа |
| `mic_granted` / `mic_denied` | `ms` | микрофон в том же запросе дан / нет (играем без голоса) |
| `terms_open` | `ms` | открыт лист «Условия и конфиденциальность» |
| `card_search_start` | `ms` | поиск карты начался (`app.ts wake`, `tracker.start`) |
| `card_found` | `ms` | = `card_landed` (под именем воронки входа) |
| `cat_awake` | `ms` | = `awake_done`: кот проснулся, тайна раскрыта |
| `first_action` | `ms`, `id` | первое действие кота за сессию (= первое `action`) |
| `session_end` | `sec` — длина сессии | вкладка скрыта / закрыта (`visibilitychange` / `pagehide`); после возврата — снова при следующем уходе, `sec` растёт |

Воронка по порядку: `open → onboarding_done → camera_granted → card_landed → awake_done → named → action / game_start →
home_enter → sleep → session_end`. Вход (с 22.11): `page_open → splash_shown → cta_tap → camera_granted (camera_denied →
camera_retry) → mic_granted/mic_denied → card_search_start → card_found → cat_awake → first_action → sberkids_click`;
`ms` у шагов — время до шага (медиана по устройствам — скорость входа на реальных телефонах). Конверсия шага — `devices` шага / `devices` предыдущего в тот же день и редакцию.

## Проверка руками

```bash
# локально: сервис + событие + сводка
PROGRESS_DATA=/tmp/p PROGRESS_ADMIN_TOKEN=t PROGRESS_ORIGINS=http://localhost:5173 node server/progress/server.mjs &
curl -s -XPOST -d '{"device":"0f8fad5b-d9cb-469f-a165-70867728950e","edition":"pilot","name":"open"}' localhost:8787/api/progress/event -w '%{http_code}\n'
curl -s 'localhost:8787/api/progress/stats?token=t'
```

В браузере: `window.__analytics` (есть, только если аналитика включена), события — во вкладке Network
(`event`, тип beacon).

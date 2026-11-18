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
  `{ funnel: [...], rows: [{ day, edition, events: { name: { n, devices } } }] }`, дни UTC, новые сверху.
  Страница **/test/admin** → «Воронка пилота»: таблица «событие × день/редакция», в ячейке «раз / устройств».

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
| `session_end` | `sec` — длина сессии | вкладка скрыта / закрыта (`visibilitychange` / `pagehide`); после возврата — снова при следующем уходе, `sec` растёт |

Воронка по порядку: `open → onboarding_done → camera_granted → card_landed → awake_done → named → action / game_start →
home_enter → sleep → session_end`. Конверсия шага — `devices` шага / `devices` предыдущего в тот же день и редакцию.

## Проверка руками

```bash
# локально: сервис + событие + сводка
PROGRESS_DATA=/tmp/p PROGRESS_ADMIN_TOKEN=t PROGRESS_ORIGINS=http://localhost:5173 node server/progress/server.mjs &
curl -s -XPOST -d '{"device":"0f8fad5b-d9cb-469f-a165-70867728950e","edition":"pilot","name":"open"}' localhost:8787/api/progress/event -w '%{http_code}\n'
curl -s 'localhost:8787/api/progress/stats?token=t'
```

В браузере: `window.__analytics` (есть, только если аналитика включена), события — во вкладке Network
(`event`, тип beacon).

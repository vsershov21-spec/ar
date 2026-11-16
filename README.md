# Кот в детской карте — веб-AR прототип

Сегмент «Дети» (10–13 лет). Ребёнок наводит телефон на свою карту Сбера — из неё выскакивает кот-близнец СберКота
с характером (Хулиган / Блёстка), реагирует на касания, свайпы, встряску и голос, клеит наклейки на «стекло» экрана
и в конце зовёт «домой» в СберKids.

Боевой адрес: **https://ar.vershov.com** (сервер сам забирает `main`, см. [docs/DEPLOY.md](docs/DEPLOY.md)).
Режим разработки без камеры: **`/?debug`**.

## Быстрый старт

```bash
npm ci            # .npmrc содержит ignore-scripts=true — так и задумано (см. ниже)
npm run dev       # http://localhost:5173/?debug  (камера требует HTTPS — для телефона см. DEVICE_TEST.md)
npm run typecheck && npm test && npm run build
```

| Команда | Что делает |
|---|---|
| `npm run compile-target -- path/card.png` | PNG карты → `public/targets/card.mind` (+ копия PNG) |
| `npm run bench` | стенд распознавания → `docs/TRACKING_REPORT.md` (через bench-out/report.md) |
| `npm run voice:lines` | реплики из `public/personas/*.json` → `voice/lines/<persona>.json` |
| `npm run voice:build` | `voice-src/**.wav` → −16 LUFS → m4a+ogg + Rhubarb cues → `public/sounds/voice/` |
| `npm run gen-sounds` | процедурные звуки-заглушки → `public/sounds/sfx.*` |
| `npm run prepare-sprites` | позы из `assets-src/sprites` → `public/video/sprites/<persona>/` |
| `npm run screens` | headless-скриншоты `?debug` в 4 вьюпортах → `docs/screens/` (после `build`) |
| `npm run setup-8thwall` | опционально: 8th Wall engine binary → `public/external/xr/` |

Параметры URL: `?debug` · `?char=sprite|rig|glb` · `?tracker=mindar|8thwall|webxr|debug` · `?asr=vosk`.

## Документация

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — модули, шина событий, поток данных, как заменить технологию
- [MECHANICS.md](docs/MECHANICS.md) — координаты, кот на карте, стекло, потеря карты, режимы трекинга, маркер
- [CHARACTER_SPEC.md](docs/CHARACTER_SPEC.md) — ТЗ на 3D-модель и видео-спрайты
- [VOICE.md](docs/VOICE.md) — реплики, Piper, актёр, липсинк, распознавание
- [TRACKING_REPORT.md](docs/TRACKING_REPORT.md) — синтетический стенд распознавания карт
- [TRACKER_8THWALL.md](docs/TRACKER_8THWALL.md) — 8th Wall: что есть, лицензии, как подключить
- [DEVICE_TEST.md](docs/DEVICE_TEST.md) — ручная проверка на iPhone и Android
- [DEPLOY.md](docs/DEPLOY.md) — сервер, CI, откат

## Почему `ignore-scripts=true`

`mind-ar@1.2.5` тянет `canvas` (нативная сборка, нужна только офлайн-компилятору маркеров в Node). Без
системных библиотек он не собирается и ломает `npm ci`. Нам он не нужен: маркер компилируется браузерным
компилятором в headless Chromium (`scripts/compile-target.mjs`). Остальные зависимости postinstall-скриптов не требуют.

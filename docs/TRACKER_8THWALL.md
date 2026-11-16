# 8th Wall: что доступно и как подключить

Проверено 16.11.2026 из среды разработки (доступ только к npm/GitHub):

| Что | Где | Лицензия | Что умеет | Вывод |
|---|---|---|---|---|
| Открытый движок | github.com/8thwall/8thwall (`packages/engine`), npm `@8thwall/engine` 0.1.0 | **MIT** | Image Targets, Face Effects, Sky, без SLAM | можно заменить им MindAR для карты |
| Distributed Engine Binary | npm **`@8thwall/engine-binary` 1.0.0** (≈30 МБ: `xr.js`, `xr-slam.js`, `xr-face.js`, воркеры) | **проприетарная** («XR Engine License Agreement», Niantic Spatial) — ограничения использования | **World Effects (SLAM)**, Image Targets, Face, Sky, Absolute Scale | единственный вариант SLAM от 8th Wall. Нужна **юр. проверка** до прод-использования |
| Генератор целей | npm `@8thwall/image-target-cli` 1.0.0 | MIT | PNG → `<имя>.json` + обрезка + luminance-изображение | для подготовки карты |

Пакеты скачиваются через npm, в проект **не добавлены** (лицензия + размер). Адаптер написан и собирается,
но **на устройстве не проверен** — камеры в среде разработки нет.

## Адаптер

`src/tracker/eighthWallTracker.ts`, включение: `?tracker=8thwall`.

Режим «**карта задаёт якорь → дальше мировой трекинг**»:
1. `XR8.XrController.configure({ imageTargetData: [card.json], disableWorldTracking: false })` — включены и SLAM, и цели.
2. Пока карта в кадре — события `reality.imagefound/imageupdated` → якорь = поза карты в мире
   (поворот −90° по X: у 8th Wall нормаль изображения — +Y, у нас — +Z; **проверить на устройстве**).
3. Карта ушла (`reality.imagelost`) — якорь остаётся в мире, камера продолжает двигаться (SLAM) → кот стоит на столе.
   `capabilities.worldTracking = true` → Stage снимает ограничение «гулять только по карте» (радиус 3 ширины карты).
4. Видео камеры рисует `XR8.GlTextureRenderer` в свой canvas под нашим; наш three.js рендерит поверх, позу камеры
   берём из `processCpuResult.reality` (position/rotation/intrinsics).

## Как включить

```bash
npm i --no-save @8thwall/engine-binary        # прочитать dist/LICENSE!
npm run setup-8thwall                          # → public/external/xr/ (в .gitignore)
npx @8thwall/image-target-cli@latest           # интерактивно: путь к PNG карты, обрезка, имя «card»
# положить результат: public/targets/8thwall/card.json (+ изображения, на которые ссылается imagePath)
npm run dev  →  https://<ip>:5173/?tracker=8thwall
```

Для деплоя на сервер (`npm ci && npm run build` из чистого клона) бинарник нужно будет либо закоммитить в
`public/external/xr/` (≈30 МБ, если лицензия позволяет распространение в составе сайта), либо отдавать отдельным
путём Caddy вне релизов (как модель Vosk, см. DEPLOY.md).

## Альтернатива без 8th Wall

- **MindAR + 3DoF** (по умолчанию): кот удерживается при поворотах телефона, при сдвиге — уходит «к стеклу».
- **WebXR hit-test** (`?tracker=webxr`, только Android Chrome с ARCore): полноценный 6DoF на поверхности, без распознавания карты.

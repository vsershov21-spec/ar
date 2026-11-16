# Деплой

**push в `main` → примерно через 2 минуты изменения на https://ar.vershov.com**

## Как это устроено

- Сервер **swe** (Caddy, статика). Раз в 2 минуты сервер сам забирает ветку `main` из GitHub,
  выполняет `npm ci && npm run build` (Node 22) и публикует содержимое `dist/` в корень сайта.
- Сборка обязана проходить из **чистого клона** одной командой, без дополнительных шагов и без сетевых обращений,
  кроме npm. Поэтому все рантайм-ассеты лежат в репозитории в `public/`.
- `vite base = '/'` (сайт в корне домена; переопределяется `BASE_PATH`, если понадобится подпапка).
- HTTPS обязателен (камера и микрофон работают только по HTTPS) — сертификат выпускает Caddy.

### Ассеты и кэш

| Путь | Что | Кэш |
|---|---|---|
| `/targets/` | маркеры `.mind`, PNG карт | долгий |
| `/models/` | GLB, Vosk-модель `models/vosk-ru-small-0.22/model.tar.gz` (с сервера сборки, см. ниже) | долгий |
| `/sounds/` | `sfx.*` | долгий |
| `/voice/` | озвучка Piper: `manifest.json` (индекс) + `<характер>.<хэш>.json` + `<характер>/*.<хэш>.mp3` (с сервера сборки) | обычный; файлы с хэшем в имени |
| `/video/` | спрайты, позы, видео с альфой, формы рта | долгий |
| `/assets/` | JS/CSS Vite (имена с хэшем) | долгий |
| `/personas/` | JSON характеров | обычный |
| `index.html` | | **без кэша** |

**Меняете ассет в долгокэшируемой папке — меняйте имя файла** (`card-v2.mind`, `character-2026-12.glb`) и путь
в `src/config.ts`/манифесте. Иначе телефоны будут показывать старую версию.

## Логи и откат

- Лог сборок на сервере: `/srv/ar/update.log`.
- Релизы: `/srv/ar/releases/<…>`, текущий — симлинк `/srv/ar/current`.
- **Откат** — переключить симлинк на прошлый релиз:
  ```bash
  ls -1t /srv/ar/releases | head                # найти прошлый
  ln -sfn /srv/ar/releases/<прошлый> /srv/ar/current
  ```
  (Сервер при следующем опросе снова соберёт `main` — для отката надолго сделайте `git revert` в `main`.)

## CI

`.github/workflows/ci.yml` — только проверка на push/PR: `npm ci → typecheck → test → build`. Деплоя в нём нет.

## Подключить remote и запушить (делает владелец репозитория)

```bash
cd ar-proto
git remote add origin git@github.com:<org-или-user>/<repo>.git
git push -u origin main
```

## Тяжёлые ассеты вне репозитория: `public-extra` на сервере сборки

Озвучка (~10 МБ MP3) и офлайн-модель распознавания (~45 МБ) в git не хранятся (Git LFS не используем).
Они лежат на swe в постоянной папке **`/var/lib/vershov-commander/ar/public-extra/`** (структура повторяет `public/`):

```
public-extra/
  models/vosk-ru-small-0.22/model.tar.gz   ← vosk-model-small-ru-0.22 (alphacephei.com), перепакован в tar.gz
  voice/manifest.json, voice/<характер>.<хэш>.json, voice/<характер>/*.mp3   ← npm run voice:piper
```

`npm run build` = `vite build && node scripts/voice/attach-extra.mjs`: после сборки скрипт копирует эту папку в `dist/`
(путь меняется переменной `AR_EXTRA_PUBLIC`). Если папки нет (CI, ноутбук) — ничего не делает, сборка не падает,
приложение работает без них: реплики — синтезом речи браузера, распознавание — сообщением «офлайн-модель не найдена»
и чипами. Значит, **никаких ручных копирований в `/srv/ar` не нужно**: следующий релиз (любой push в `main`) подхватит
файлы сам. Обновили озвучку — сделайте любой коммит (или подождите следующего), чтобы пересобрался релиз.

Как обновить:
- **озвучку** — на swe: `bash /var/lib/vershov-commander/ar/voice-run.sh` (клонирует `main` в
  `/var/lib/vershov-commander/ar/voice-build`, ставит зависимости, копирует Piper в `/tmp` — домашняя папка noexec —
  и запускает `npm run voice:piper`; готовые файлы не пересобираются, лог — `voice-run.log`). Подробно — docs/VOICE.md;
- **модель Vosk** — `bash scripts/voice/fetch-vosk.sh /var/lib/vershov-commander/ar/public-extra` (скачивает zip,
  перепаковывает в tar.gz). Новая версия модели — новая папка (`vosk-ru-small-0.23/`) и путь `VOSK_MODEL_URL`
  в `src/voice/asr.ts`: `/models/*` кэшируется у телефонов навсегда (`immutable`).

Если хочется отдавать модель напрямую Caddy, а не копировать в каждый релиз (5 релизов × 45 МБ), — добавить в блок
`ar.vershov.com` (нужен root): `handle_path /models/vosk-ru-small-0.22/* { root * /var/lib/vershov-commander/ar/public-extra/models/vosk-ru-small-0.22; file_server }`
и выдать группе `caddy` право чтения на эту папку. Пока копия в релиз проще и не требует root.

## Что не входит в репозиторий

- `public/external/xr/` — 8th Wall engine binary (проприетарная лицензия, `npm run setup-8thwall` вручную);
- озвучка и модель Vosk — см. выше (`public-extra`);
- `bench-out/` — артефакты стенда распознавания.

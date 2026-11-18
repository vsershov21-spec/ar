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
| `/models/` | GLB, Vosk-модель `models/vosk-ru-small-0.22/model.tar.gz` (из `/srv/ar-extra`, см. ниже) | долгий |
| `/models/opt/` | сжатые при сборке копии моделей `<имя>.<хэш>.glb` (meshopt + KTX2), см. ниже | долгий (хэш в имени) |
| `/sounds/` | `sfx.*` | долгий |
| `/voice/` | озвучка Piper: `manifest.json` (индекс) + `<характер>.<хэш>.json` + `<характер>/*.<хэш>.mp3` (из `/srv/ar-extra`) | обычный; файлы с хэшем в имени |
| `/video/` | спрайты, позы, видео с альфой, формы рта | долгий |
| `/assets/` | JS/CSS Vite (имена с хэшем) | долгий |
| `/personas/` | JSON характеров | обычный |
| `index.html` | | **без кэша** |

**Меняете ассет в долгокэшируемой папке — меняйте имя файла** (`card-v2.mind`, `character-2026-12.glb`) и путь
в `src/config.ts`/манифесте. Иначе телефоны будут показывать старую версию.

### Сжатие моделей при сборке

`vite build` (плагин `scripts/build/vite-model-opt.mjs`) пережимает персонажей и реквизит из `public/models/` в
`dist/models/opt/<имя>.<хэш>.glb`: геометрия — EXT_meshopt_compression (без квантования, вершины те же), текстуры от
1024 px — KTX2/Basis ETC1S (на телефоне остаются сжатыми и в видеопамяти). Исходники в `public/models/` не меняются
(их правят python-стадии `scripts/models`). Рантайм берёт сжатый путь из карты в бандле (`src/core/modelUrl.ts`),
декодеры — `src/character/gltfLoad.ts` (транскодер Basis — ассет vite в `/assets/` с хэшем).

- Первый раз после изменения модели — ~30–40 с на модель (кодер Basis, wasm), дальше — кэш по содержимому
  `.cache/model-opt/` в рабочей папке сборки (или `$AR_MODEL_CACHE`). Сеть и root не нужны.
- Ошибка сжатия не роняет сборку — модель остаётся исходной. `AR_MODEL_OPT=0 npm run build` — выключить.
- Вручную: `node scripts/build/model-opt.mjs public/models/kind_v1.glb --out /tmp/kind.glb`.

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

## Тяжёлые ассеты вне репозитория: `/srv/ar-extra` на сервере сборки

Озвучка (~10 МБ MP3) и офлайн-модель распознавания (~45 МБ) в git не хранятся (Git LFS не используем).
Структура папки повторяет `public/`:

```
models/vosk-ru-small-0.22/model.tar.gz   ← vosk-model-small-ru-0.22 (alphacephei.com), перепакован в tar.gz
voice/manifest.json, voice/<характер>.<хэш>.json, voice/<характер>/*.mp3   ← npm run voice:piper
```

`npm run build` = `vite build && node scripts/voice/attach-extra.mjs`: после сборки скрипт копирует первую доступную
из папок `$AR_EXTRA_PUBLIC`, **`/srv/ar-extra`**, `/var/lib/vershov-commander/ar/public-extra` в `dist/`.
Нет ни одной (CI, ноутбук) — ничего не делает, сборка не падает, приложение работает без них: реплики — синтезом речи
браузера, распознавание — «офлайн-модель не найдена» + чипы.

Сейчас всё готово в `/var/lib/vershov-commander/ar/public-extra/` (её видит только удалённый терминал: сервис сборки
`ar-update` не может зайти в `/var/lib/private`). **Один раз от root** — перенести в место, которое видит сборка:

```bash
sudo install -d -o vershov-commander -g caddy -m 750 /srv/ar-extra
sudo cp -a /var/lib/private/vershov-commander/ar/public-extra/. /srv/ar-extra/
sudo chown -R vershov-commander:caddy /srv/ar-extra && sudo chmod -R g+rX /srv/ar-extra
```

Дальше ручных копирований не нужно: `voice-run.sh` пишет прямо в `/srv/ar-extra/voice`, если папка есть, а любой
следующий релиз (push в `main`) подхватит файлы сам. Обновили озвучку — сделайте любой коммит.

Как обновить:
- **озвучку** — на swe: `bash /var/lib/vershov-commander/ar/voice-run.sh` (клонирует `main` в
  `/var/lib/vershov-commander/ar/voice-build`, ставит зависимости, копирует Piper в `/tmp` — домашняя папка noexec —
  и запускает `npm run voice:piper`; готовые файлы не пересобираются, лог — `voice-run.log`). Подробно — docs/VOICE.md;
- **модель Vosk** — `bash scripts/voice/fetch-vosk.sh /srv/ar-extra` (скачивает zip,
  перепаковывает в tar.gz). Новая версия модели — новая папка (`vosk-ru-small-0.23/`) и путь `VOSK_MODEL_URL`
  в `src/voice/asr.ts`: `/models/*` кэшируется у телефонов навсегда (`immutable`).

Если хочется отдавать модель напрямую Caddy, а не копировать в каждый релиз (5 релизов × 45 МБ), — добавить в блок
`ar.vershov.com` (нужен root): `handle_path /models/vosk-ru-small-0.22/* { root * /srv/ar-extra/models/vosk-ru-small-0.22; file_server }`
(группа `caddy` читает `/srv/ar-extra` — см. `install` выше). Пока копия в релиз проще и не требует root.

## Что не входит в репозиторий

- `public/external/xr/` — 8th Wall engine binary (проприетарная лицензия, `npm run setup-8thwall` вручную);
- озвучка и модель Vosk — см. выше (`/srv/ar-extra`);
- `bench-out/` — артефакты стенда распознавания.

## Сервис прогресса (`server/progress`, порт 127.0.0.1:8787)

Прогресс кота (знакомство, имя-прозвище, выбранный кот, что ребёнок пробовал, калибровка камеры) хранится и на телефоне
(localStorage), и на сервере — по случайному id устройства. Это даёт продакту сброс прогресса любого телефона по коду.
Сервис без npm-зависимостей: Node 20.11+ (на 22.5+ — SQLite через `node:sqlite`, иначе JSON-файлы с атомарной записью).
Сайт работает и без сервиса: запрос к `/api/progress` не ответил за 1,5 с — только localStorage, как раньше.

**Установка (один раз, под root на swe):**

```bash
sudo -i
# 1) код сервиса — копия server/progress из main
install -d -m 755 /opt/ar-progress
for f in server.mjs store.mjs ar-progress.service; do
  curl -fsSL "https://raw.githubusercontent.com/vsershov21-spec/ar/main/server/progress/$f" -o "/opt/ar-progress/$f"
done
# 2) папка данных (сборка сайта папку progress/ в dist не копирует — scripts/voice/attach-extra.mjs)
install -d -o vershov-commander -g vershov-commander -m 700 /srv/ar-extra/progress
# 3) токен админ-сброса: генерируется в файл, на экран не выводится
( umask 077; [ -f /etc/ar-progress.env ] || printf 'PROGRESS_ADMIN_TOKEN=%s\n' "$(openssl rand -hex 24)" > /etc/ar-progress.env )
# 4) node: нужен 20.11+; если он не в /usr/bin/node — подставить путь в юнит
node --version; command -v node
[ "$(command -v node)" = /usr/bin/node ] || sed -i "s#/usr/bin/node#$(command -v node)#" /opt/ar-progress/ar-progress.service
# 5) юнит
cp /opt/ar-progress/ar-progress.service /etc/systemd/system/ar-progress.service
systemctl daemon-reload && systemctl enable --now ar-progress
systemctl status ar-progress --no-pager | head -5
curl -s http://127.0.0.1:8787/api/progress/health        # {"ok":true,"store":"sqlite"}
# 6) Caddy: в блок ar.vershov.com { … } добавить (до file_server) — см. server/progress/Caddyfile.snippet
#      handle /api/progress/* {
#          reverse_proxy 127.0.0.1:8787
#      }
nano /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
curl -s https://ar.vershov.com/api/progress/health
```

Токен для страницы `/test/admin/` продакт смотрит сам, когда нужно: `sudo cat /etc/ar-progress.env`. Сменить токен —
удалить файл, повторить шаг 3, `systemctl restart ar-progress`. Без файла админ-сброс выключен (ответ 503), остальное работает.

**Обновить код сервиса** (после изменений в `server/progress` — сервер сам их не подтягивает):
повторить шаг 1 и `systemctl restart ar-progress`. Логи: `journalctl -u ar-progress -n 50`.

**API** (подробно — шапка `server/progress/server.mjs`): `GET|PUT|DELETE /api/progress/:device`,
`POST /api/progress/:device` (то же, что PUT, для sendBeacon), `GET /api/progress/:device/sessions`,
`POST /api/progress/:device/session`, `GET|DELETE /api/progress/admin/code/:code` (Bearer-токен), `GET /api/progress/health`.
Ограничения: прогресс ≤ 16 КБ и ≤ 40 ключей на устройство, 30 последних сессий × 80 коротких событий,
120 запросов/мин с IP, 30 записей/мин на устройство, 10 неверных токенов за 10 мин с IP; CORS — только
`PROGRESS_ORIGINS` (по умолчанию `https://ar.vershov.com`); документы, не менявшиеся 90 дней (`PROGRESS_TTL_DAYS`), удаляются.

**Как сбросить прогресс телефона:**
- на самом телефоне — `https://ar.vershov.com/?reset=1` (или кнопка «Сбросить прогресс этого устройства» на `/test`,
  или `?debug` → вкладка «Прогресс»);
- по коду — `https://ar.vershov.com/test/admin/`: токен + код из 6 символов (код видно на `/test` и в `?debug` → «Прогресс»).
  Телефон узнаёт о сбросе при следующем запуске (если игра открыта — перестаёт записывать до перезапуска).

Локально: `PROGRESS_DATA=/tmp/progress PROGRESS_ORIGINS=http://localhost:5173 node server/progress/server.mjs` и `npm run dev`
(в vite настроен прокси `/api/progress` → 8787). Тесты — `tests/progress/`.

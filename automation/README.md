# ar-auto: генерации на сервере без ручных команд

Claude (облачная песочница) видит только GitHub и npm: до api.meshy.ai, Tripo, ElevenLabs и ar.vershov.com он не
достаёт. Поэтому схема «тянущая»: Claude коммитит задачу в `automation/queue.json` в `main`, сервер swe раз в 5 минут
забирает очередь, запускает уже существующие скрипты и выкладывает результат в ветку **`server-out`**, которую Claude
читает через GitHub.

```
Claude ── commit queue.json ──▶ main ──(GitHub API: sha main, raw по sha)──▶ swe: ar-auto.timer (5 мин)
                                                                                  │ motion-run.sh / props-run.sh / el-run.sh
Claude ◀── git fetch server-out ◀── push out/<id>/… (токен contents:write) ◀──────┘ + systemctl start ar-update
```

Код: `scripts/automation/` (`ar-auto.mjs` — node 22 без зависимостей, `ar-auto.sh`, `ar-auto.service`/`.timer`,
`install.sh`, `enqueue.mjs` — постановка задачи и чтение результатов для Claude). Тесты — `tests/automation.test.ts`,
`tests/automationOps.test.ts`.

**Служебные задачи** `script` (скрипт из репо по белому списку, на коммите `ref`), `audit` (стенд аудита анимаций) и
`status` (снимок сервера), а также модель безопасности — в [docs/automation/README.md](../docs/automation/README.md).

## Установка (один раз, владелец, root на swe)

1. Токен: GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → *Generate new
   token*. Resource owner — владелец репозитория, Repository access — **Only select repositories → `vsershov21-spec/ar`**,
   Permissions → Repository → **Contents: Read and write** (Metadata: Read подставится сам). Срок — на выбор (истечёт —
   повторить установку с новым токеном).
2. На swe:

```bash
REF=<sha коммита>; curl -fsSL https://raw.githubusercontent.com/vsershov21-spec/ar/$REF/scripts/automation/install.sh -o /root/ar-auto-install.sh && sudo REF=$REF bash /root/ar-auto-install.sh
sudo ar-auto selftest     # проверка: токен, право записи, очередь, dry-run задачи status (ничего не выгружает)
```

Скрипт спросит токен (ввод не виден, проверит его запросом к GitHub), создаст `/etc/ar-auto.env` (600, root),
положит код в `/opt/ar-auto` (ровно из коммита `REF` — сам себя из `main` не обновляет), выполнит первый прогон
(задача `mirror-meshy` выгружает все готовые клипы), включит таймер и покажет статус. Повторный запуск с новым `REF` —
обновление кода; токен и лимиты не трогает. Сменить токен — удалить строку `GH_TOKEN=` в `/etc/ar-auto.env` и запустить
установку снова (или `ROTATE=1` в той же команде).

Команды на сервере: `sudo ar-auto status` (последние задачи, траты за сегодня), `sudo ar-auto tick` (не ждать таймер),
`journalctl -u ar-auto -n 50`, `journalctl -u ar-auto-job-meshy -n 100`. Остановить всё — `systemctl disable --now ar-auto.timer`.

## Как Claude ставит задачу

Добавить объект в `jobs` в `automation/queue.json`, закоммитить и запушить в `main`:

```json
{ "id": "meshy-wave-2026-11-19", "kind": "meshy", "args": ["--only", "wave,sit_down"], "maxCredits": 30, "note": "P0: два клипа" }
```

| поле | что |
|---|---|
| `id` | уникальный, `[a-z0-9][a-z0-9._-]{0,63}`; выполняется **один раз** — повтор = новая задача с новым id |
| `kind` | `meshy` → `scripts/meshy/motion-run.sh --go …`; `tripo` → `scripts/tripo/props-run.sh --go …`; `eleven` → `scripts/voice/el-run.sh …`; `script` / `audit` / `status` — см. [docs/automation](../docs/automation/README.md) |
| `args` | только пары «флаг значение» из белого списка: meshy `--only`, `--redo`, `--set`; tripo `--only`; eleven `--only`. Значения — id через запятую (`[a-z0-9_]`), `--set` — `p0`/`p1`/`p2`/`all` |
| `maxCredits` | потолок задачи: кредиты Meshy/Tripo, **символы** для ElevenLabs |
| `note` | комментарий (в summary) |

Особый случай: **`kind: meshy` без `args`** — ничего не генерирует, только обновляет зеркало клипов (0 кредитов).
Задачи выполняются по порядку очереди; одновременно — не больше одной каждого вида (meshy, tripo и eleven могут идти
параллельно). Скрипты и промпты берутся из **того же коммита main**, что и очередь (`MESHY_RAW`/`TRIPO_RAW`/`EL_REF` = sha).

## Результаты: ветка `server-out`

```bash
git fetch origin server-out && git show origin/server-out:out/status.json
git show origin/server-out:out/<id>/summary.json ; git show origin/server-out:out/<id>/log.txt
git archive origin/server-out out/latest/meshy | tar -x -C /tmp/review     # все клипы для просмотра
```

| путь | что |
|---|---|
| `out/status.json` | траты за сегодня, лимиты, последние 60 задач со статусами, что идёт |
| `out/_queue/errors.json` | ошибки проверки очереди (задача с ошибкой не выполняется, остальные — да) |
| `out/<id>/summary.json` | `status` (`done`/`failed`/`rejected`/`deferred`), `credits`, `estimate`, `reason`, `files`, `rebuild` |
| `out/<id>/log.txt` | хвост лога (300 строк, ключи и токены замаскированы) |
| `out/<id>/meshy/` | новые клипы задачи (slim GLB ≤ 200 КБ) + `manifest.json` с ними |
| `out/<id>/tripo/` | превью PNG и GLB ≤ 2 МБ, появившиеся за задачу |
| `out/<id>/new-mp3.txt` | имена новых mp3 ElevenLabs (самих файлов нет) |
| `out/latest/meshy/` | зеркало `/srv/ar-extra/models/anims/meshy`: все slim GLB ≤ 200 КБ + `manifest.json`; `_mirror.json` — что не влезло |

Ветка — **один коммит без истории** (перезаписывается с `--force-with-lease`), хранит 100 последних папок задач.
Статус `deferred` — задача ждёт (дневной лимит — до следующих суток UTC; ручной запуск того же вида — до следующего tick).
`rejected` — не запускалась (оценка больше `maxCredits` или дневного лимита) — поставить новую задачу.

## Лимиты и защита

- **Оценка до запуска.** Для meshy/tripo ar-auto сначала запускает план (тот же скрипт без `--go`, ничего не тратит),
  берёт оценку и сравнивает с `maxCredits` и остатком дневного лимита. Затем передаёт скрипту жёсткий потолок:
  `motion.mjs --max-credits` (оценка выше — не начинает), `props-run.sh --max-credits` (проверка перед каждым
  предметом), `eleven.mjs --max-chars` (стоп по символам).
- **Дневные лимиты** на провайдера (UTC-сутки), `/etc/ar-auto.env`: `AUTO_DAILY_MESHY=400`, `AUTO_DAILY_TRIPO=400`
  (кредиты), `AUTO_DAILY_EL_CHARS=20000` (символы). Учитываются факт (баланс до/после у Meshy, оценки начатых
  предметов у Tripo, символы прогона у ElevenLabs) и резерв идущих задач. Потолок одной задачи — 2000 кредитов / 200 000 символов.
- **Оплаченное не повторяется.** Задача выполняется один раз; прерванная перезагрузкой помечается `failed`. Скрипты
  сами не переотправляют начатые задачи провайдеров (resume).
- **Белый список аргументов**, никаких произвольных команд, `--go`, `--model-url`, `--new-rig`.
- **Не мешает ручным запускам:** если уже идёт `motion.mjs` / `tripo make` / `eleven.mjs --batch`, задача откладывается.
- **Токен** читается из `/etc/ar-auto.env` (600, root), git получает его только через переменные окружения
  (`GIT_CONFIG_*`, заголовок), не в URL и не в аргументах; логи и выгрузка проходят маскировку (GitHub/Meshy/ElevenLabs).
  В `server-out` уходят только файлы под `out/` (проверка путей перед коммитом, иначе отказ), размер — до 300 МБ.
- **Пересборка сайта:** после задачи, изменившей `/srv/ar-extra`, — `systemctl start ar-update`; в summary
  `rebuild.changed` показывает, сменился ли релиз `/srv/ar/current`. Если ar-update без нового коммита не собирает —
  задать `AUTO_REBUILD_CMD=…` в `/etc/ar-auto.env`.

**Остаточный риск:** скрипты провайдеров берутся из `main` и выполняются от root (как и при ручном
`curl … motion-run.sh`). Кто может пушить в `main`, тот может запустить код на swe и тратить кредиты в пределах дневных
лимитов. Защита `main` (branch protection) и лимиты — обязательны; `ar-auto.mjs` сам из `main` не обновляется.

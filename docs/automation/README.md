# ar-auto: служебные задачи на swe (script / audit / status) и безопасность

Базовая схема (очередь `automation/queue.json` в `main` → таймер на swe раз в 5 мин → результаты в ветку `server-out`)
и генерации Meshy / Tripo / ElevenLabs описаны в [automation/README.md](../../automation/README.md). Здесь — три
служебных вида задач, с которыми Claude может сам выполнять работу на сервере, и честное описание того, что это значит
для безопасности.

Зачем: у Claude на swe есть только неинтерактивный Desktop Commander под `vershov-commander` (нет sudo, домашняя
папка noexec, `/tmp` приватный, долгие процессы гибнут вместе с сервисом через ~30 с). Всё, что требует root или
идёт дольше минуты, Claude ставит в очередь, а выполняет ar-auto от root.

## Виды задач

| kind | что делает | обязательные поля | таймаут (мин) |
|---|---|---|---|
| `script` | запускает скрипт **из репозитория** по белому списку, на коммите `ref` | `ref`, `path` | 30 по умолчанию, ≤ 120 |
| `audit` | `scripts/qa/anim-audit/server-run.sh` на коммите `ref` (стенд аудита анимаций с клипами Meshy) | `ref` | 120 (≤ 120) |
| `status` | снимок состояния сервера, без секретов | — | 5 |

Общие правила:

- **Один раз.** `id` уникален (`[a-z0-9][a-z0-9._-]{0,63}`); отметка о выполнении — `/var/lib/ar-auto/jobs/<id>.json`
  на сервере. `done` / `failed` / `rejected` не повторяются никогда — повтор = новая задача с новым id. Задача,
  прерванная перезагрузкой, помечается `failed`.
- **Параллелизм 1.** `script`, `audit`, `status` идут в одной полосе `ops` (юнит `ar-auto-job-ops`) строго по
  очереди: пока идёт аудит (до 2 ч), следующая ops-задача ждёт. Генерации Meshy/Tripo/ElevenLabs — в своих полосах.
- **Низкий приоритет.** Юнит ops — `Nice=10`, IO best-effort 7; сами скрипты — через `nice -n 10 ionice -c2 -n7`.
- **Таймаут** гасит всю группу процессов скрипта (и то, что он увёл в фон через `setsid nohup`).
- **Итог** — в `out/status.json` (последние 60 задач) и `out/<id>/summary.json` (`status`, `reason`, `refSha`, файлы).

### script

```json
{ "id": "caddy-encode-dry-1", "kind": "script", "ref": "71cbef4", "path": "scripts/deploy/caddy-encode.sh",
  "env": { "DRY": "1" }, "args": [], "timeoutMin": 10, "note": "посмотреть, что поменяется в Caddy" }
```

- **Белый список путей** (`SCRIPT_WHITELIST` в `scripts/automation/ar-auto.mjs`):
  `scripts/deploy/*.sh`, `scripts/qa/**/server-run.sh`, `scripts/voice/el-run.sh`, `scripts/meshy/motion-run.sh`,
  `scripts/meshy/props-run.sh` (такого файла пока нет — скрипт предметов лежит в `scripts/tripo/props-run.sh`, он
  тоже в списке). Сегменты пути — только `[a-z0-9][a-z0-9_-]*`: ни `..`, ни скрытых файлов, ни абсолютных путей.
- **`ref` обязателен** — sha 7–40 символов. Сервер раскрывает его через GitHub API в полный sha и проверяет
  `compare/<ref>...<main>`: коммит обязан быть **в истории main** (`ahead`/`identical`). Коммит из форка или чужой
  ветки (GitHub отдаёт их по sha через общую сеть форков) → `rejected`. Скрипт скачивается ровно с этого sha.
- **`args`** — массив строк, до 40, каждая `[A-Za-z0-9._,:=/@+%-]{0,200}`. Запуск — `execve` (`bash <скрипт> args…`),
  без shell: подстановок, `$()`, `;`, кавычек нет.
- **`env`** — только `DRY` (`0|1`), `VERBOSE` (`0|1`), `REF` (только равный `ref`). Окружение скрипта чистое
  (окружение ar-auto не наследуется): `PATH`, `HOME=/root`, `LANG`, плюс `REF=<полный sha>` и
  `MESHY_RAW`/`TRIPO_RAW`/`EL_REF` на тот же коммит — скрипты, которые качают свои файлы с GitHub, берут их из того
  же коммита (скрипт, который `REF` не читает и тянет `main`, получит `main` — это видно в его коде).
- **Скрипты провайдеров — только без трат.** `motion-run.sh` / `props-run.sh` без `--go` (план), `el-run.sh` только с
  `--plan`. Генерация — только видами `meshy` / `tripo` / `eleven` (оценка до запуска, `maxCredits`, дневные лимиты).
- Лог — `out/<id>/log.txt` (до 2000 строк / 1 МБ; у скриптов, ушедших в фон, сюда же дописывается их собственный лог).

### audit

```json
{ "id": "anim-audit-2026-11-22", "kind": "audit", "ref": "71cbef4", "note": "аудит после пакета движений" }
```

Запускает `scripts/qa/anim-audit/server-run.sh` с `REF=<sha>` (код стенда — из этого коммита) и `AUDIT_OUT` (итог —
начисто в рабочую папку задачи), ждёт фонового прогона (apt, `npm ci`, Chrome, два прогона аудита, ~1–1,5 ч) до
таймаута. В `out/<id>/`:

| файл | что |
|---|---|
| `table_*.md`, `idle_*.md` | таблицы «действие × кот» и idle |
| `REPORT.md` | отчёт стенда (`REACTIONS_audit.md`) |
| `summary_*.json` | сводки прогонов |
| `sheets.tar.gz` | контактные листы (PNG) одним архивом — если ≤ 20 МБ; иначе в summary путь на сервере |
| `log.txt` | лог ar-auto + лог прогона |

Если на сервере уже идёт ручной аудит — задача откладывается (`deferred`, повтор на следующем tick).

### status

```json
{ "id": "status-2026-11-22-1", "kind": "status" }
```

`out/<id>/status.md` + `status.json`: ОС и аптайм, версии (node, npm, git, caddy, systemd, sha ar-auto), `df -h`,
память, `systemctl is-active caddy ar-progress ar-update ar-auto.timer`, релиз `/srv/ar/current`, хвост
`/srv/ar/update.log` (40 строк), счётчики манифестов Meshy / голоса / предметов, `curl -I` ключевых URL
(`/`, `/mvp/`, `/lab/`, `/api/progress/health`, манифест Meshy) — из заголовков только статус, тип, длина, сжатие,
кэш, etag, location (без cookie). Ничего не меняет. `reason` перечисляет сервисы не в `active`.

## Как ставит задачу Claude

```bash
node scripts/automation/enqueue.mjs status
node scripts/automation/enqueue.mjs script scripts/deploy/caddy-encode.sh --env DRY=1 --timeout 10
node scripts/automation/enqueue.mjs audit
node scripts/automation/enqueue.mjs script scripts/meshy/motion-run.sh -- --set p1     # план Meshy, без трат
# --dry — только показать; --id — свой id; --ref — другой коммит (по умолчанию HEAD)
```

`enqueue.mjs` проверяет задачу той же функцией, что сервер (`validateJob`), ставит `ref = HEAD`, проверяет, что
скрипт есть в этом коммите, предупреждает, если коммит ещё не в `origin/main`, и дописывает задачу в
`automation/queue.json`. Дальше — обычный порядок репо: коммит `queue.json` → rebase → tsc + vitest + build → push в
`main`. Сервер возьмёт задачу в течение 5 минут.

Результаты:

```bash
node scripts/automation/enqueue.mjs wait <id>         # ждать итог (fetch раз в минуту, 30 мин)
node scripts/automation/enqueue.mjs result <id>       # summary.json + хвост log.txt + список файлов
node scripts/automation/enqueue.mjs list              # out/status.json
# вручную:
git fetch origin server-out && git show origin/server-out:out/<id>/summary.json
git archive origin/server-out out/<id> | tar -x -C /tmp/ar-out
```

## Секреты

- Токен GitHub — только в `/etc/ar-auto.env` (600, root); git получает его через `GIT_CONFIG_*` в окружении своего
  процесса (не URL, не аргументы, не `.git/config`). Скриптам задач токен не передаётся (чистое окружение).
- Ключи Meshy (`/etc/ar-meshy.env`), ElevenLabs (`/var/lib/vershov-commander/.elevenlabs_key`), Tripo (`~/.tripo`
  у root) и токен GitHub читаются ar-auto только чтобы **маскировать** их: точные значения + типовые форматы
  (`ghp_…`, `github_pat_…`, `msy_…`, `sk_…`, `tsk_…`, `Authorization:`, `xi-api-key:`, `*_API_KEY=`, `*_TOKEN=`,
  `"api_key": "…"`, `user:pass@` в URL) заменяются на `***` в логах, summary, status и во всех текстовых файлах
  выгрузки ещё раз прямо перед push.
- Маскирование — страховка, а не гарантия: скрипт из белого списка, который сам напечатает ключ в нестандартном
  виде (например, по одной букве), может его выдать. Поэтому скрипты в репо не должны печатать ключи — так они и
  написаны (ключи читает node внутри процесса).

## Безопасность — честно

**Кто может пушить в `main`, тот фактически выполняет код от root на swe.** Белый список ограничивает *какой файл*
запустить, но не *что в нём написано*: скрипт берётся из коммита репозитория, а коммит в `main` может изменить любой
`scripts/deploy/*.sh`. Белый список, обязательный `ref` и проверка «в истории main» защищают от опечаток, от
произвольных команд в `queue.json`, от коммитов форков и посторонних веток — но не от того, у кого есть право записи
в `main`. Это та же модель доверия, что и ручной `curl …/scripts/deploy/…sh | sudo bash`, только без человека в цикле.

Обязательно:

1. **Защитить `main`** (Settings → Branches / Rulesets): запрет force-push и удаления; по возможности — PR с
   обязательным ревью и проверками для всех, кроме владельца. Писать в `main` должны только владелец и Claude
   (который и так работает по правилу «push только при зелёных tsc + vitest + build»).
2. **Токен сервера — минимальный**: fine-grained, только репозиторий `vsershov21-spec/ar`, `Contents: Read and write`
   (Metadata: Read подставится сам), срок — 90 дней или меньше. **Ограничение:** fine-grained токен не умеет давать
   запись только в одну ветку — `Contents: write` действует на весь репозиторий. Токен действует от имени того, кто
   его создал, поэтому ruleset на `main` с обходом (bypass) для владельца токен владельца **не остановит**.
   Варианты по убыванию надёжности:
   - создать токен от **отдельного аккаунта-бота** (коллаборатор с ролью Write только в этом репо), а на `main`
     (Rulesets → Target: default branch → Restrict updates/deletions, Block force pushes) bypass дать только владельцу
     и тому, через что пушит Claude; тогда утёкший с сервера токен пишет только в `server-out` и прочие ветки, но не
     в `main`;
   - если бота нет — токен владельца со сроком ≤ 30–90 дней, и помнить: его утечка с swe = право записи в `main`
     (а swe и так root-доступ к сайту — то есть это не расширяет круг, но и не сужает).
   ar-auto сам пишет только в `server-out` и только файлы под `out/` (проверка путей перед коммитом).
3. **Белый список** — менять только осознанно (`SCRIPT_WHITELIST`, тесты `tests/automationOps.test.ts`). Не добавлять
   туда скрипты, принимающие произвольные команды, URL или пути.
4. **Обязательный `ref`** — задача без него не принимается; что именно выполнится, видно по sha в `queue.json`.
5. ar-auto **сам себя не обновляет** из `main`: код в `/opt/ar-auto` меняется только установщиком от root с явным `REF`.

Остановить всё: `sudo systemctl disable --now ar-auto.timer` (идущая задача: `sudo systemctl stop ar-auto-job-ops`).

## Установка и проверка (root на swe)

```bash
REF=<полный sha>; curl -fsSL https://raw.githubusercontent.com/vsershov21-spec/ar/$REF/scripts/automation/install.sh -o /root/ar-auto-install.sh && sudo REF=$REF bash /root/ar-auto-install.sh
sudo ar-auto selftest
```

Установщик идемпотентен: повторный запуск с другим `REF` — обновление кода; токен и лимиты в `/etc/ar-auto.env` не
трогает (сменить токен: `ROTATE=1` в той же команде). Токен спрашивается скрыто (`read -rs`) и проверяется запросом к
GitHub API. Перед подменой кода — `node --check` для `.mjs` и `bash -n` для `.sh`.

`ar-auto selftest` — проверка без выполнения задач и без выгрузки: node 22+, токен на месте, GitHub API отвечает,
очередь из `main` проходит проверку, скрипт из белого списка читается по sha, `ref` раскрывается и проверяется по
истории main, **право записи** (`git push --dry-run` — ветка не меняется), dry-run задачи `status` (печатает снимок и
проверяет, что в нём нет ни одного известного секрета), таймер активен. Итог: `ИТОГ: всё в порядке` или число ошибок.

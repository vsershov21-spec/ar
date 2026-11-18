# Утро: что сделать руками (≈5 минут)

## 1. Озвучить все реплики ElevenLabs (под root на сервере swe)

Ключ уже лежит в `/var/lib/vershov-commander/.elevenlabs_key`. Скрипт его не выводит.
Пакет: 1 350 заданий, ~35 тыс. символов (на балансе ~91 тыс.). Уже озвученное пропускается.

```bash
sudo -i
# папку первого прогона создавал root — отдаём её сервису, чтобы сборка и озвучка писали/читали одно и то же
chown -R vershov-commander:caddy /srv/ar-extra/voice-el
# прогноз без сети (сколько осталось и сколько символов):
curl -sL https://raw.githubusercontent.com/vsershov21-spec/ar/main/scripts/voice/el-run.sh -o /tmp/el-run.sh && bash /tmp/el-run.sh --plan
# запуск в фоне:
bash /tmp/el-run.sh
tail -f /var/lib/vershov-commander/ar/el-run.log      # ждать строку «готово» (~30–60 мин)
# после окончания — снова права сервису:
chown -R vershov-commander:caddy /srv/ar-extra/voice-el
```

## 2. Пересобрать сайт с новой озвучкой
Сайт собирается сам на каждый новый коммит в main. Напиши Claude «озвучка готова» — он запушит пустой коммит; или:
```bash
cd /tmp && git clone -q https://github.com/vsershov21-spec/ar && cd ar && git commit --allow-empty -m "Пересборка: озвучка" && git push
```

## 3. Проверить на телефоне
`https://ar.vershov.com/` → «Разбудить кота» → любая карта Сбера на стол → камера под углом 30–60°, 20–40 см.
Рамка появляется сама, когда карта найдена. Что попробовать: выбрать каждого из трёх, сказать «привет», «сделай сальто», «загадку»,
тапнуть по стеклу (жвачка у Хулигана, пузыри у Добряка, блёстки у Блёстки), провести пальцем (стекло запотевает — рисуй),
потрясти телефон, долгое нажатие, тычки в голову/живот/хвост.
Отладка: `?debug` (без камеры), `?tracker=mindar` (старый маркер), `?char=sprite` (2D-кот).

## После пилота
- Перевыпустить ключ ElevenLabs (он был в чате).
- Удалить лишние голоса в ElevenLabs (оставить Хулиган 1, Добряк моложе 4, Блёстка 3).

## Сервис прогресса (≈3 минуты, под root, один раз)
Прогресс кота теперь пишется и на сервер (по случайному id устройства) — чтобы сбрасывать его телефону по коду.
Команды — docs/DEPLOY.md, раздел «Сервис прогресса»: скопировать `server/progress` в `/opt/ar-progress`, создать
`/srv/ar-extra/progress`, сгенерировать токен в `/etc/ar-progress.env`, `systemctl enable --now ar-progress`, добавить в Caddyfile
`handle /api/progress/* { reverse_proxy 127.0.0.1:8787 }` и `systemctl reload caddy`. Пока не сделано — сайт работает как раньше (только localStorage).
Сброс: `https://ar.vershov.com/?reset=1` на телефоне или `https://ar.vershov.com/test/admin/` по коду устройства.

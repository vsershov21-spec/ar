# Голос: реплики, липсинк, распознавание, звук

## Как устроено

```
public/personas/<id>.json   — тексты реплик (истина для сценария)
        │ npm run voice:lines
voice/lines/<id>.json       — список для озвучки: id, text, emotion, event
        │ (запись) voice-src/<persona>/<id>.wav  — Piper TTS или актёр
        │ npm run voice:build
public/sounds/voice/<persona>/<id>.m4a|.ogg|.cues.json + manifest.json
        │ рантайм
VoicePlayer → DialogQueue → LipSync → character.setMouth(виземa)
```

- Запись есть → играем файл (Web Audio, категория `voice`), рот — по **готовым cues** Rhubarb.
- Записи нет (или в реплике `{name}`) → **speechSynthesis** ru-RU с pitch/rate персоны, рот — по виземам из текста.
  Это только фоллбэк до записи.
- Запись без cues → рантайм-анализ **wawa-lipsync**.
- Во время реплики звуки (sfx) приглушаются на −8 дБ.

## Добавить реплику

1. Впишите текст в `public/personas/<persona>.json` (в `lines.<ключ>` или `reactions.<событие>.lines`, ≥3 варианта на событие).
2. `npm run voice:lines` — появится запись в `voice/lines/<persona>.json` с новым `id` (старые id не меняются).
   Эмоцию (`emotion`) можно поправить руками — это подсказка актёру/TTS.
3. Запишите/сгенерируйте `voice-src/<persona>/<id>.wav` (любой sample rate, моно/стерео).
4. `npm run voice:build` — нормализация −16 LUFS (ffmpeg loudnorm, 2 прохода), m4a (AAC 96k) + ogg (Opus 64k),
   cues, манифест. Пересобираются только изменённые файлы (`--force` — все).
5. Закоммитьте `voice/lines`, `voice-src` (исходники) и `public/sounds/voice`.

Реплики с `{name}` пока синтезируются. Варианты: записать без имени («Норм имя. Запомню.»), или записать 30–50 популярных
имён отдельными файлами и склеивать (план на следующую итерацию).

Сейчас в `voice-src/` лежат **5 тестовых WAV**, синтезированных офлайн eSpeak NG (роботизированный голос, только чтобы
проверить пайплайн и липсинк): hooligan/intro_1, tap_screen_1, swipe_2; glitter/intro_1, tap_cat_2. eSpeak (GPL) в проект
не входит — был запущен разово вне репозитория.

## Сгенерировать голос Piper (офлайн TTS, MIT)

Русские голоса Piper: `ru_RU-denis-medium`, `ru_RU-dmitri-medium`, `ru_RU-irina-medium`, `ru_RU-ruslan-medium`
(скачиваются с huggingface.co/rhasspy/piper-voices: файлы `.onnx` + `.onnx.json`).

```bash
# macOS / Linux
python3 -m pip install piper-tts
mkdir -p ~/piper && cd ~/piper
# скачайте ru_RU-dmitri-medium.onnx и .onnx.json в ~/piper (браузером или curl -L)
cd /path/to/ar-proto
node -e '
const l=require("./voice/lines/hooligan.json");
for (const x of l) if(!x.text.includes("{")) console.log(x.id+"\t"+x.text)' |
while IFS=$'\t' read -r id text; do
  echo "$text" | piper --model ~/piper/ru_RU-dmitri-medium.onnx \
     --length_scale 0.92 --noise_scale 0.6 --output_file "voice-src/hooligan/$id.wav"
done
npm run voice:build
```

Для Блёстки — `ru_RU-irina-medium` и, при желании, сдвиг тона: `ffmpeg -i in.wav -af "asetrate=22050*1.12,aresample=22050,atempo=0.9" out.wav`.
Голос Piper — заглушка «приличного качества»; для запуска нужен актёр (детский/молодёжный тембр, характер).

## Перезаписать актёром

- Выдайте актёру `voice/lines/<persona>.json` (id, текст, эмоция, событие) — это и есть сценарий записи.
- Формат: WAV 48 кГц/24 бит моно, тишина 150–300 мс до и после, без обработки (нормализуем сами), без музыки.
- Имена файлов строго `<id>.wav` в `voice-src/<persona>/`. Дальше `npm run voice:build`.
- По 2–3 дубля важных реплик — положите лучший; варианты для разнообразия оформляйте **отдельными репликами** в JSON.

## Липсинк

- Формы рта Rhubarb: **A** (М/Б/П), **B** (большинство согласных, «и»), **C** («э»), **D** («а»), **E** («о»),
  **F** («у»), **G** («ф/в»), **H** («л»), **X** (покой).
- Офлайн-cues: `voice:build` вызывает нативный `rhubarb -r phonetic` (языконезависимый распознаватель — для русского
  он правильный выбор), если бинарник есть в PATH или в `RHUBARB_BIN`
  (релизы: github.com/DanielSWolf/rhubarb-lip-sync/releases). Иначе — `rhubarb-lip-sync-wasm` (внутри PocketSphinx
  с **английской** моделью: для русского формы приблизительные, но тайминг открытия/закрытия рта верный).
  В манифесте поле `lipsync` показывает, каким движком сделаны cues.
- Сглаживание: веса визем стремятся к цели с постоянной времени 70 мс (коартикуляция, `LipSync.tau`).
- 3D: виземы → блендшейпы `mouth_A/E/O/U/M` (или челюсть `Jaw`); риг-заглушка — открытие челюсти и ширина рта.
- Спрайт: PNG-оверлей формы рта поверх позы `listen` (`public/video/sprites/mouth/`, сейчас заглушки).
- Во время речи — моргание чаще и микродвижения головы.

### Проверить липсинк в `?debug`

Панель (кнопка **D**) → секция **«Реплики и липсинк»**: кнопки `▶ persona/id` проигрывают каждую записанную реплику,
список ниже — любую реплику синтезом. Над кнопками — визуализация: столбики весов визем A–H, X (текущая — лаймовая),
схематичный рот и источник (`file`/`synth`). Там же — громкости sfx / voice / ambience.

## Распознавание речи (ASR)

| Движок | Включение | Приватность | Примечание |
|---|---|---|---|
| Web Speech API | по умолчанию | распознаёт браузер/ОС (Chrome — Google, Safari — Apple) | нет на Firefox; на iOS работает в Safari 14.5+ |
| Vosk (vosk-browser) | `?asr=vosk` | **полностью офлайн** | модель `vosk-model-small-ru-0.22` (~45 МБ), грузится лениво |

Установка модели Vosk: скачайте `vosk-model-small-ru-0.22.zip` с alphacephei.com/vosk/models, распакуйте и упакуйте
в tar.gz так, чтобы внутри была папка модели: `tar -czf model.tar.gz vosk-model-small-ru-0.22`, положите в
`public/models/vosk-ru-small/model.tar.gz` (см. DEPLOY.md — где хранить на сервере). Отсюда скачать модель нельзя
(сеть закрыта) — в репозитории её нет.

Интерфейс: «держи и говори» (кнопка-микрофон), авто-стоп через 8 с, индикатор уровня (у Vosk — реальный уровень
микрофона; у Web Speech доступа к звуку нет — индикатор по событиям распознавания), промежуточный текст под кнопкой,
**чипы-подсказки** как запасной ввод. Текст → `parseIntent` (ключевые слова, без LLM).

⚠️ iOS: когда открыт микрофон (Vosk), iOS переключает аудиосессию в режим «запись+воспроизведение» — звук может
стать тише/уйти в разговорный динамик. Для Web Speech этого нет. Проверять на устройстве (DEVICE_TEST.md).

## Звук

- Howler.js, один аудиоспрайт `public/sounds/sfx.{mp3,webm}` + `sfx.json` (минимальная задержка).
- Категории `sfx`, `voice`, `ambience` — своя громкость (`audio.setVolume`), ducking реплик −8 дБ.
- Вариации: `glass_knock_1..3`, `glitter_1..3`, `sticker_slap_1..3` и др. — `play('glass_knock')` выбирает
  случайный (не повторяя предыдущий) и меняет pitch ±5%.
- iOS: аудио разблокируется в жесте «Разбудить кота»; Safari 17+ — `navigator.audioSession.type = 'playback'`
  (звук идёт и при беззвучном режиме). На старых iOS при включённом переключателе «Без звука» Web Audio молчит —
  через 2.5 с после старта показываем подсказку «Проверь переключатель „Без звука“».
- Заменить звук: положить WAV с тем же именем в `assets-src/audio/` → `npm run gen-sounds -- --keep-existing`.

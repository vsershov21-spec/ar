#!/usr/bin/env python3
"""Сборка контента AR-кота.

Читает content/src/<persona>.meta.json + <persona>.lines.txt и каталоги
(events, animations, face, fx, sounds, intents, dialogs), проверяет ссылки и тексты и пишет:
  content/personas/<persona>.json   — то, что грузит приложение
  gen/voice_lines.csv               — все реплики для озвучки (Piper / ElevenLabs / актёр)
  gen/animations.csv                — список клипов для Tripo / Mixamo / Blender
  gen/sfx_prompts.csv               — звуки для генерации
  gen/fx_list.csv                   — экранные эффекты для разработки
  docs/CONTENT.md                   — читаемая «библия» контента
  voice-src/el_batch_all.jsonl      — пакет озвучки ElevenLabs (через node scripts/voice/el-batch.mjs)
Запуск: python3 content/build.py  (код возврата 1 при ошибках — годится для CI)
"""
import csv, json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
C = ROOT / "content"
PERSONAS = ["hooligan", "kind", "glitter"]
EMOTIONS = {"neutral", "happy", "cheeky", "surprised", "annoyed", "shy", "proud", "sad", "excited", "caring", "sleepy", "whisper", "offended"}
NAME_OK = {"nice_name", "welcome_back"}
# переменные в репликах: {name} — только где разрешено, {answer} — только ответ загадки
VAR_OK = {"name": NAME_OK, "answer": {"riddle_answer"}}
MAX_CHARS = 150
CHARS_PER_SEC = 14   # ≈ темп речи кота; реплика длиннее 8 с — предупреждение
MAX_SEC = 8
# сказка и песенка — длиннее обычной реплики (до 12 с)
LONG_OK = {"tale": 12, "sing": 12}
# на «грустно/страшно» кот поддерживает и ничего не спрашивает
SAFETY_EVENTS = {"sad", "scared"}
# кот не спрашивает личных данных (кроме имени)
PERSONAL = re.compile(r"(сколько тебе лет|где ты живёшь|где живёшь|твой адрес|адрес|номер телефона|телефон мамы|в какой школе|в какой класс|в каком классе|фамили|как зовут (маму|папу)|пароль|пин-?код|код из смс|номер карты)", re.I)
# про деньги — только «это к брату»
MONEY_WORDS = re.compile(r"\b(деньг|денег|денежк|копи|накоп|потрат|купи|рубл|монет|кэшбэк|баланс)", re.I)
BAD_WORDS = ["дурак", "дура", "тупой", "идиот", "заткнись", "дебил", "урод", "убью", "сдохни"]
# обращение к ребёнку с родом: «ты пришёл», «ты вернулась», «ты сам», «ты готова», «ты такой», «Видал?»
GENDERED = [
    re.compile(r"\b[Тт]ы\s+(?:меня\s+|уже\s+|так\s+|же\s+|сегодня\s+|точно\s+|не\s+)?[а-яё]+(?:л|ла|лся|лась)\b"),
    re.compile(r"\b[Тт]ы\s+(?:\S+\s+){0,2}?(?:сам|сама|готов|готова|рад|рада|один|одна|такой|такая|крутой|крутая|умный|умная|умница|молодец[а-я]*|хороший|хорошая|красивый|красивая|смелый|смелая|устал|устала|должен|должна|уверен|уверена|согласен|согласна)\b"),
    re.compile(r"(?:^|[.!?…]\s+)(?:Ну\s+|А\s+|Ой,\s+)?(?:Видал|Видала|Слыхал|Слыхала|Понял|Поняла|Готов|Готова|Устал|Устала|Не ждал|Не ждала|Ждал|Ждала|Сам|Сама|Уверен|Уверена)\b[^.!]*\?"),
    re.compile(r"\b(?:[Кк]уда|[Гг]де|[Зз]ачем|[Пп]очему|[Чч]то|[Чч]ё)\s+(?:ты\s+)?(?:\S+\s+)?[а-яё]+(?:ал|ял|ел|ил|ла)\?"),
]
# кот о себе — в своём роде: Хулиган/Добряк — «я рад», Блёстка — «я рада»
SELF_WRONG = {
    "m": re.compile(r"\b[Яя]\s+(?:не\s+|уже\s+|так\s+|аж\s+|сама\s+)?(?:[а-яё]+(?:ла|лась)|рада|готова|сама|одна)\b"),
    "f": re.compile(r"\b[Яя]\s+(?:не\s+|уже\s+|так\s+|аж\s+|сам\s+)?(?:[а-яё]+(?:[^аеиоуыэюя\s]л|ал|ял|ел|ил|ул|ался|ился)|рад|готов|сам|один)\b"),
}


def text_checks(where, t, ev, self_gender):
    """Общие проверки текста реплики: длина, слова, род, безопасность, личные данные."""
    sec = len(t) / CHARS_PER_SEC
    lim = LONG_OK.get(ev, MAX_SEC)
    if sec > lim:
        warns.append(f"{where}: ≈{sec:.1f} с (>{lim} с) — сократить")
    if len(t) > MAX_CHARS:
        warns.append(f"{where}: длинная реплика ({len(t)} симв.)")
    for var in re.findall(r"\{(\w+)\}", t):
        if var not in VAR_OK:
            errors.append(f"{where}: неизвестная переменная {{{var}}}")
        elif ev not in VAR_OK[var]:
            errors.append(f"{where}: {{{var}}} разрешён только в {sorted(VAR_OK[var])}")
    low = t.lower()
    for w in BAD_WORDS:
        if re.search(rf"\b{w}\b", low):
            errors.append(f"{where}: запрещённое слово «{w}»")
    for g in GENDERED:
        m = g.search(t)
        if m:
            warns.append(f"{where}: обращение к ребёнку с родом? «{m.group(0).strip()}»")
    m = SELF_WRONG[self_gender].search(t)
    if m:
        warns.append(f"{where}: кот о себе не в своём роде ({self_gender})? «{m.group(0)}»")
    if PERSONAL.search(t):
        errors.append(f"{where}: вопрос о личных данных «{PERSONAL.search(t).group(0)}» — можно спрашивать только имя")
    if ev in SAFETY_EVENTS:
        if "?" in t:
            errors.append(f"{where}: на {ev} кот поддерживает и ничего не спрашивает — уберите вопрос")
        if not re.search(r"взросл|мам|пап", low):
            errors.append(f"{where}: на {ev} нужно предложить позвать взрослого")
    if MONEY_WORDS.search(t) and "брат" not in low and "сберkids" not in low:
        warns.append(f"{where}: про деньги — только «это к брату»")
    if ev == "money" and "к брату" not in low:
        errors.append(f"{where}: на money кот отвечает «это к брату»")

errors, warns = [], []

def load(name):
    return json.loads((C / name).read_text(encoding="utf-8"))

events = load("events.json")["events"]
event_ids = [e["id"] for e in events]
clips = {c["id"]: c for c in load("animations.json")["clips"]}
face = load("face.json")
faces = {p["id"] for p in face["presets"]}
fxs = {f["id"]: f for f in load("fx.json")["fx"]}
sounds = {s["id"]: s for s in load("sounds.json")["sounds"]}
intents = load("intents.ru.json")["intents"]
dialogs = load("dialogs.json")
# события диалогов, где нужно 3+ варианта
NEED3 = {e["id"] for e in events if e["group"] == "dialog"} | {"bye", "sberkids", "money", "riddle", "sad", "scared", "echo_start", "ask_name", "nice_name", "no_name", "welcome_back", "choose"}

def check_ref(kind, val, where):
    if val in (None, "", "none"):
        return
    table = {"clip": clips, "fx": fxs, "sound": sounds, "face": faces}[kind]
    if val not in table:
        errors.append(f"{where}: неизвестный {kind} «{val}»")

def parse_kv(s):
    return dict(kv.split("=", 1) for kv in s.split() if "=" in kv)

def parse_lines(pid):
    path = C / "src" / f"{pid}.lines.txt"
    out, cur, defaults = {}, None, {}
    for n, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line or (line.startswith("#") and not line.startswith("##")):
            continue
        if line.startswith("##"):
            head = line[2:].strip()
            ev, _, rest = head.partition("|")
            cur = ev.strip()
            defaults = parse_kv(rest)
            if cur in out:
                errors.append(f"{path.name}:{n}: событие {cur} повторяется")
            out[cur] = {"defaults": defaults, "lines": []}
            continue
        if cur is None:
            errors.append(f"{path.name}:{n}: реплика вне события"); continue
        m = re.match(r"^([a-z]+):\s*(.+?)\s*(\[(.*)\])?$", line)
        if not m:
            errors.append(f"{path.name}:{n}: не разобрал строку «{line}»"); continue
        emo, text, _, extra = m.groups()
        item = {"emotion": emo, "text": text, **parse_kv(extra or "")}
        out[cur]["lines"].append((n, item))
    return out

all_lines = []
for pid in PERSONAS:
    meta = json.loads((C / "src" / f"{pid}.meta.json").read_text(encoding="utf-8"))
    parsed = parse_lines(pid)
    lines, reactions = {}, {}
    for ev in parsed:
        if ev not in event_ids:
            errors.append(f"{pid}: событие «{ev}» нет в events.json")
    for ev in event_ids:
        if ev not in parsed:
            errors.append(f"{pid}: нет реплик для события «{ev}»"); continue
        block = parsed[ev]
        d = block["defaults"]
        for k in ("clip", "fx", "sound", "face"):
            check_ref(k, d.get(k), f"{pid}.{ev}")
        variants = []
        for i, (n, it) in enumerate(block["lines"], 1):
            where = f"{pid}.lines.txt:{n}"
            lid = f"{pid}.{ev}.{i:02d}"
            if it["emotion"] not in EMOTIONS:
                errors.append(f"{where}: эмоция «{it['emotion']}» не из списка")
            for k in ("clip", "fx", "sound", "face"):
                check_ref(k, it.get(k), where)
            t = it["text"]
            text_checks(where, t, ev, meta.get("selfGender", "m"))
            v = {"id": lid, "text": t, "emotion": it["emotion"]}
            for k in ("clip", "fx", "sound", "face"):
                if it.get(k):
                    v[k] = it[k]
            if "face" not in v:
                # лицо: из строки → из умолчаний события → по эмоции
                v["face"] = d.get("face") or face["emotionToFace"].get(it["emotion"], "neutral")
            variants.append(v)
            all_lines.append({"id": lid, "persona": pid, "event": ev, **v})
        # «это была радость», «у меня камень», «это был прыжок» — по одному варианту на загаданный вариант
        minv = 1 if ev in ("intro_once",) or re.match(r"^(emo|rps|simon)_is_", ev) else 2
        if len(variants) < minv and ev not in ("first_time_today", "choose_hooligan", "choose_kind", "choose_glitter"):
            warns.append(f"{pid}.{ev}: всего {len(variants)} вариант(а) — будут повторы")
        if ev in NAME_OK and variants and all("{name}" in v["text"] for v in variants):
            errors.append(f"{pid}.{ev}: нужен хотя бы один вариант без {{name}} — имя знают не всегда")
        if ev in NEED3 and len(variants) < 3:
            errors.append(f"{pid}.{ev}: реплика диалога — нужно 3+ варианта (сейчас {len(variants)})")
        lines[ev] = variants
        reactions[ev] = {k: d[k] for k in ("clip", "fx", "sound", "face") if k in d}
    for c in [i["clip"] for i in meta["idles"]] + [meta["signature"]["clip"]]:
        check_ref("clip", c, f"{pid}.meta")
    for f in meta["signature"].get("fx", []):
        check_ref("fx", f, f"{pid}.meta.signature")
    for f in meta.get("fxTuning", {}):
        check_ref("fx", f, f"{pid}.meta.fxTuning")
    check_ref("sound", meta.get("ambience"), f"{pid}.meta.ambience")
    riddles = []
    for r in dialogs.get("riddles", {}).get(pid, []):
        for k in ("id", "q", "answer", "keywords", "hint"):
            if not r.get(k):
                errors.append(f"dialogs.riddles.{pid}: у загадки {r.get('id')} нет поля {k}")
        for part in ("q", "hint"):
            text_checks(f"dialogs.riddles.{pid}.{r.get('id')}.{part}", r.get(part, ""), f"riddle_{part}", meta.get("selfGender", "m"))
        riddles.append(r)
        for part in ("q", "hint"):
            all_lines.append({"id": f"{pid}.riddle.{r['id']}.{part}", "persona": pid, "event": f"riddle_{part}", "text": r[part], "emotion": "neutral"})
    if len(riddles) < 8:
        errors.append(f"dialogs.riddles.{pid}: нужно 8 загадок, сейчас {len(riddles)}")
    if len({r["id"] for r in riddles}) != len(riddles):
        errors.append(f"dialogs.riddles.{pid}: повторяются id")
    persona = {**meta, "reactions": reactions, "lines": lines, "riddles": riddles, "contentVersion": 1}
    (C / "personas").mkdir(exist_ok=True)
    (C / "personas" / f"{pid}.json").write_text(json.dumps(persona, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

# клипы, на которые никто не ссылается
used = set()
for l in all_lines:
    used.add(l.get("clip"))
for pid in PERSONAS:
    p = json.loads((C / "personas" / f"{pid}.json").read_text(encoding="utf-8"))
    used |= {r.get("clip") for r in p["reactions"].values()} | {i["clip"] for i in p["idles"]} | {p["signature"]["clip"]}
for cid, c in clips.items():
    # клип Meshy с правилом meshy.on играет вместо клипа реакции, когда пришёл (src/character/clips.ts meshyUpgrade)
    if c.get("meshy", {}).get("on"):
        continue
    if cid not in used and not any(u.startswith(("*", "code:")) for u in c["usedBy"]) and c["layer"] == "body":
        warns.append(f"клип {cid} не используется ни одной репликой — проверь usedBy")

# интенты ↔ события
for it in intents:
    if it["intent"] not in event_ids and not it.get("noEvent"):
        errors.append(f"intents: «{it['intent']}» нет в events.json")
intent_ids = {it["intent"] for it in intents}

# диалоги: ссылки на события, узлы, интенты
SPECIAL_KEYS = {"name", "right", "wrong", "giveup", "timeout", "*", "done", "win", "lose", "draw"}
for intent, t in dialogs["triggers"].items():
    did, _, node = t.partition(":")
    if intent not in intent_ids:
        errors.append(f"dialogs.triggers: интента «{intent}» нет в intents.ru.json")
    if did not in dialogs["dialogs"]:
        errors.append(f"dialogs.triggers.{intent}: нет диалога {did}")
    elif node and node not in dialogs["dialogs"][did]["nodes"]:
        errors.append(f"dialogs.triggers.{intent}: нет узла {did}:{node}")
for did, dd in dialogs["dialogs"].items():
    nodes = dd["nodes"]
    if dd["start"] not in nodes:
        errors.append(f"dialogs.{did}: нет стартового узла {dd['start']}")
    for nid, n in nodes.items():
        says = n.get("say", [])
        for sv in ([says] if isinstance(says, str) else says):
            if not sv.startswith("$") and sv not in event_ids:
                errors.append(f"dialogs.{did}.{nid}: события «{sv}» нет в events.json")
        for key, target in n.get("on", {}).items():
            if key not in SPECIAL_KEYS and key not in intent_ids:
                errors.append(f"dialogs.{did}.{nid}: ответ «{key}» — нет такого интента")
            if not target.startswith("@") and target not in nodes:
                errors.append(f"dialogs.{did}.{nid}: переход в несуществующий узел «{target}»")
        if n.get("next") and not n["next"].startswith("@") and n["next"] not in nodes:
            errors.append(f"dialogs.{did}.{nid}: next в несуществующий узел «{n['next']}»")
        if n.get("on") and not n.get("listen"):
            errors.append(f"dialogs.{did}.{nid}: есть on, но нет listen")
        if n.get("listen") and "timeout" not in n.get("on", {}):
            warns.append(f"dialogs.{did}.{nid}: нет перехода по timeout — будет @end")

# мини-игры с выбором: варианты, реплики «<игра>_is_<вариант>», ссылки лица/клипа/события
for gid, g in dialogs.get("games", {}).items():
    ids = [it.get("id") for it in g.get("items", [])]
    if len(ids) < 2 or len(set(ids)) != len(ids):
        errors.append(f"dialogs.games.{gid}: нужно 2+ варианта с разными id")
    for it in g.get("items", []):
        if not it.get("label"):
            errors.append(f"dialogs.games.{gid}.{it.get('id')}: нет label")
        if not it.get("keywords") and not it.get("intents"):
            errors.append(f"dialogs.games.{gid}.{it.get('id')}: нужен keywords или intents")
        check_ref("face", it.get("face"), f"dialogs.games.{gid}.{it.get('id')}")
        check_ref("clip", it.get("clip"), f"dialogs.games.{gid}.{it.get('id')}")
        if it.get("event") and it["event"] not in event_ids:
            errors.append(f"dialogs.games.{gid}.{it['id']}: события «{it['event']}» нет")
        for i in it.get("intents", []):
            if i not in intent_ids:
                errors.append(f"dialogs.games.{gid}.{it['id']}: интента «{i}» нет")
        if it.get("beats") and it["beats"] not in ids:
            errors.append(f"dialogs.games.{gid}.{it['id']}: beats «{it['beats']}» — нет такого варианта")
        if f"{gid}_is_{it['id']}" not in event_ids:
            errors.append(f"dialogs.games.{gid}.{it['id']}: нет события {gid}_is_{it['id']} (реплика «это был …»)")
    if gid not in dialogs["dialogs"]:
        errors.append(f"dialogs.games.{gid}: нет диалога {gid}")

# ---------- выходные файлы ----------
G = ROOT / "gen"; G.mkdir(exist_ok=True)
metas = {pid: json.loads((C / "src" / f"{pid}.meta.json").read_text(encoding="utf-8")) for pid in PERSONAS}
with open(G / "voice_lines.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["id", "persona", "event", "emotion", "text", "has_name", "piper_voice", "pitch_semitones", "rate", "direction"])
    for l in all_lines:
        v = metas[l["persona"]]["voice"]
        w.writerow([l["id"], l["persona"], l["event"], l["emotion"], l["text"], int("{" in l["text"]),
                    v["piperVoice"], v["pitchSemitones"], v["rate"], v["actorDirection"]])
with open(G / "animations.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["id", "priority", "persona", "duration_s", "loop", "root_motion", "layer", "used_by", "notes"])
    for c in sorted(clips.values(), key=lambda c: (c["priority"], c["id"])):
        w.writerow([c["id"], c["priority"], c["persona"], c["durationS"], int(c["loop"]), int(c["rootMotion"]), c["layer"], " ".join(c["usedBy"]), c["notes"]])
with open(G / "sfx_prompts.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["id", "category", "variants", "duration_s", "loop", "loudness_lufs", "prompt"])
    for s in sounds.values():
        w.writerow([s["id"], s["category"], s["variants"], s.get("durationS", ""), int(s.get("loop", False)), s["loudnessLUFS"], s["prompt"]])
with open(G / "fx_list.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["id", "layer", "persona", "duration_ms", "sound", "params", "notes"])
    for x in fxs.values():
        w.writerow([x["id"], x["layer"], x["persona"], x["durationMs"], x["sound"], json.dumps(x["params"], ensure_ascii=False), x["notes"]])

# ---------- docs/CONTENT.md ----------
md = ["# Контент AR-кота: характеры, реплики, анимации, эффекты, звуки", "",
      "Файл собирается скриптом `python3 content/build.py` из `content/`. Править исходники в `content/src/` и каталоги, не этот файл.", ""]
md += ["## Сводка", "", "| | Количество |", "|---|---|",
       f"| События | {len(events)} |", f"| Реплики (всего, со строками загадок) | {len(all_lines)} |",
       *[f"| — {metas[p]['name']} | {sum(1 for l in all_lines if l['persona']==p)} |" for p in PERSONAS],
       f"| Клипы тела | {len(clips)} (P0: {sum(c['priority']=='P0' for c in clips.values())}) |",
       f"| Пресеты лица | {len(faces)} |", f"| Экранные эффекты | {len(fxs)} |", f"| Звуки | {len(sounds)} |",
       f"| Голосовые интенты | {len(intents)} |", f"| Диалоги | {len(dialogs['dialogs'])} |",
       f"| Загадки | {sum(len(v) for v in dialogs.get('riddles', {}).values())} |", ""]
md += ["## Характеры", ""]
for p in PERSONAS:
    m = metas[p]
    md += [f"### {m['name']}", "", m["summary"], "",
           f"- Голос: Piper `{m['voice']['piperVoice']}`, тон +{m['voice']['pitchSemitones']} пт, темп ×{m['voice']['rate']}; повтор голоса +{m['voice']['echoPitchSemitones']} пт.",
           f"- Актёру: {m['voice']['actorDirection']}",
           f"- Одежда: {m['outfit']['description']}",
           f"- Фирменный трюк: клип `{m['signature']['clip']}`, эффекты {', '.join(m['signature']['fx'])}.",
           f"- Idle: {', '.join(i['clip'] + '×' + str(i['weight']) for i in m['idles'])}.",
           f"- Правила речи: {'; '.join(m['speechRules'])}.", ""]
groups = {"scenario": "Сценарий", "input": "Касания и камера", "voice": "Голос ребёнка", "dialog": "Диалоги (ветки, docs/DIALOGS.md)", "game": "Мини-игры с выбором (угадай эмоцию, камень-ножницы-бумага, повтори движение)", "context": "Время и возвращения"}
md += ["## Реплики по событиям", ""]
for g, gname in groups.items():
    md += [f"### {gname}", ""]
    for e in [e for e in events if e["group"] == g]:
        md += [f"#### `{e['id']}` — {e['trigger']}", ""]
        for p in PERSONAS:
            pj = json.loads((C / "personas" / f"{p}.json").read_text(encoding="utf-8"))
            r = pj["reactions"].get(e["id"], {})
            extra = ", ".join(f"{k}: `{v}`" for k, v in r.items())
            md.append(f"**{metas[p]['name']}**" + (f" ({extra})" if extra else ""))
            for v in pj["lines"].get(e["id"], []):
                md.append(f"- _{v['emotion']}_ — {v['text']}")
            md.append("")
md += ["## Загадки", "", "Проверка ответа — по ключевым словам (основы, `*` — любое окончание). Схема диалога — docs/DIALOGS.md.", ""]
for p in PERSONAS:
    md += [f"### {metas[p]['name']}", "", "| # | Загадка | Ответ | Ключевые слова | Подсказка |", "|---|---|---|---|---|"]
    for r in dialogs.get("riddles", {}).get(p, []):
        md.append(f"| {r['id']} | {r['q']} | {r['answer']} | {', '.join(r['keywords'])} | {r['hint']} |")
    md.append("")
md += ["## Клипы тела", "", "| Клип | Приор. | Характер | Длит., с | Петля | Root motion | Где | Описание |", "|---|---|---|---|---|---|---|---|"]
for c in sorted(clips.values(), key=lambda c: (c["priority"], c["id"])):
    md.append(f"| `{c['id']}` | {c['priority']} | {c['persona']} | {c['durationS']} | {'да' if c['loop'] else ''} | {'да' if c['rootMotion'] else ''} | {', '.join(c['usedBy'])} | {c['notes']} |")
md += ["", "## Пресеты лица", "", "| Пресет | Блендшейпы | Уши | Зрачки |", "|---|---|---|---|"]
for pr in face["presets"]:
    md.append(f"| `{pr['id']}` | {', '.join(f'{k} {v}' for k, v in pr['weights'].items()) or '—'} | {pr['ears']} | {pr['pupils']} |")
md += ["", "## Экранные эффекты", "", "| Эффект | Слой | Характер | Мс | Звук | Описание |", "|---|---|---|---|---|---|"]
for x in fxs.values():
    md.append(f"| `{x['id']}` | {x['layer']} | {x['persona']} | {x['durationMs']} | {x['sound']} | {x['notes']} |")
md += ["", "## Звуки", "", "| Звук | Тип | Вариантов | LUFS | Промпт для генерации |", "|---|---|---|---|---|"]
for s in sounds.values():
    md.append(f"| `{s['id']}` | {s['category']} | {s['variants']} | {s['loudnessLUFS']} | {s['prompt']} |")
md += ["", "## Голосовые интенты", "", "| Интент | Фразы |", "|---|---|"]
for it in intents:
    md.append(f"| `{it['intent']}` | {', '.join(it['phrases'])} |")
(ROOT / "docs").mkdir(exist_ok=True)
(ROOT / "docs" / "CONTENT.md").write_text("\n".join(md) + "\n", encoding="utf-8")

# пакет для озвучки ElevenLabs (voice-src/el_batch_all.jsonl) — всегда вместе с репликами; нет node — пропускаем
if not errors:
    import shutil, subprocess
    if shutil.which("node"):
        r = subprocess.run(["node", str(ROOT / "scripts/voice/el-batch.mjs")], capture_output=True, text=True)
        if r.returncode != 0:
            warns.append(f"el-batch: {r.stderr.strip()[:200]}")
        else:
            print(r.stdout.strip().splitlines()[0])
    else:
        warns.append("нет node — voice-src/el_batch_all.jsonl не пересобран (node scripts/voice/el-batch.mjs)")

for wv in warns:
    print("ВНИМАНИЕ:", wv)
for er in errors:
    print("ОШИБКА:", er)
n_riddle = sum(1 for l in all_lines if l["event"].startswith("riddle_") and ".riddle." in l["id"])
print(f"Реплик: {len(all_lines) - n_riddle} (+{n_riddle} строк загадок), событий: {len(events)}, клипов: {len(clips)}, эффектов: {len(fxs)}, звуков: {len(sounds)}. Ошибок: {len(errors)}, предупреждений: {len(warns)}.")
sys.exit(1 if errors else 0)

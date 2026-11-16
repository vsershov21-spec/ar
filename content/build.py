#!/usr/bin/env python3
"""Сборка контента AR-кота.

Читает content/src/<persona>.meta.json + <persona>.lines.txt и каталоги
(events, animations, face, fx, sounds, intents), проверяет ссылки и пишет:
  content/personas/<persona>.json   — то, что грузит приложение
  gen/voice_lines.csv               — все реплики для озвучки (Piper / ElevenLabs / актёр)
  gen/animations.csv                — список клипов для Tripo / Mixamo / Blender
  gen/sfx_prompts.csv               — звуки для генерации
  gen/fx_list.csv                   — экранные эффекты для разработки
  docs/CONTENT.md                   — читаемая «библия» контента
Запуск: python3 content/build.py  (код возврата 1 при ошибках — годится для CI)
"""
import csv, json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
C = ROOT / "content"
PERSONAS = ["hooligan", "kind", "glitter"]
EMOTIONS = {"neutral", "happy", "cheeky", "surprised", "annoyed", "shy", "proud", "sad", "excited", "caring", "sleepy", "whisper", "offended"}
NAME_OK = {"nice_name", "welcome_back"}
MAX_CHARS = 150
BAD_WORDS = ["дурак", "дура", "тупой", "идиот", "заткнись", "дебил", "урод", "убью", "сдохни"]
# обращение к ребёнку в прошедшем времени с родом: «ты пришёл», «ты вернулась»
GENDERED = re.compile(r"\b[Тт]ы\s+(?:меня\s+|уже\s+|так\s+)?[а-яё]+(?:л|ла|лся|лась)\b")

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
            if len(t) > MAX_CHARS:
                warns.append(f"{where}: длинная реплика ({len(t)} симв.) — может не уложиться в 8 с")
            if "{name}" in t and ev not in NAME_OK:
                errors.append(f"{where}: {{name}} разрешён только в {sorted(NAME_OK)}")
            low = t.lower()
            for w in BAD_WORDS:
                if re.search(rf"\b{w}\b", low):
                    errors.append(f"{where}: запрещённое слово «{w}»")
            if GENDERED.search(t):
                warns.append(f"{where}: обращение к ребёнку с родом? «{GENDERED.search(t).group(0)}»")
            v = {"id": lid, "text": t, "emotion": it["emotion"]}
            for k in ("clip", "fx", "sound", "face"):
                if it.get(k):
                    v[k] = it[k]
            if "face" not in v:
                v["face"] = face["emotionToFace"].get(it["emotion"], "neutral")
            variants.append(v)
            all_lines.append({"id": lid, "persona": pid, "event": ev, **v})
        minv = 1 if ev in ("intro_once",) else 2
        if len(variants) < minv and ev not in ("first_time_today", "choose_hooligan", "choose_kind", "choose_glitter"):
            warns.append(f"{pid}.{ev}: всего {len(variants)} вариант(а) — будут повторы")
        lines[ev] = variants
        reactions[ev] = {k: d[k] for k in ("clip", "fx", "sound", "face") if k in d}
    for c in [i["clip"] for i in meta["idles"]] + [meta["signature"]["clip"]]:
        check_ref("clip", c, f"{pid}.meta")
    for f in meta["signature"].get("fx", []):
        check_ref("fx", f, f"{pid}.meta.signature")
    for f in meta.get("fxTuning", {}):
        check_ref("fx", f, f"{pid}.meta.fxTuning")
    check_ref("sound", meta.get("ambience"), f"{pid}.meta.ambience")
    persona = {**meta, "reactions": reactions, "lines": lines, "contentVersion": 1}
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
    if cid not in used and not any(u.startswith(("*", "code:")) for u in c["usedBy"]) and c["layer"] == "body":
        warns.append(f"клип {cid} не используется ни одной репликой — проверь usedBy")

# интенты ↔ события
for it in intents:
    if it["intent"] not in event_ids:
        errors.append(f"intents: «{it['intent']}» нет в events.json")

# ---------- выходные файлы ----------
G = ROOT / "gen"; G.mkdir(exist_ok=True)
metas = {pid: json.loads((C / "src" / f"{pid}.meta.json").read_text(encoding="utf-8")) for pid in PERSONAS}
with open(G / "voice_lines.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["id", "persona", "event", "emotion", "text", "has_name", "piper_voice", "pitch_semitones", "rate", "direction"])
    for l in all_lines:
        v = metas[l["persona"]]["voice"]
        w.writerow([l["id"], l["persona"], l["event"], l["emotion"], l["text"], int("{name}" in l["text"]),
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
       f"| События | {len(events)} |", f"| Реплики (всего) | {len(all_lines)} |",
       *[f"| — {metas[p]['name']} | {sum(1 for l in all_lines if l['persona']==p)} |" for p in PERSONAS],
       f"| Клипы тела | {len(clips)} (P0: {sum(c['priority']=='P0' for c in clips.values())}) |",
       f"| Пресеты лица | {len(faces)} |", f"| Экранные эффекты | {len(fxs)} |", f"| Звуки | {len(sounds)} |",
       f"| Голосовые интенты | {len(intents)} |", ""]
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
groups = {"scenario": "Сценарий", "input": "Касания и камера", "voice": "Голос ребёнка", "context": "Время и возвращения"}
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

for wv in warns:
    print("ВНИМАНИЕ:", wv)
for er in errors:
    print("ОШИБКА:", er)
print(f"Реплик: {len(all_lines)}, событий: {len(events)}, клипов: {len(clips)}, эффектов: {len(fxs)}, звуков: {len(sounds)}. Ошибок: {len(errors)}, предупреждений: {len(warns)}.")
sys.exit(1 if errors else 0)

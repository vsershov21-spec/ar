/**
 * Загрузчик контента из content/ (собирается `python3 content/build.py`).
 * Vite кладёт каждый файл отдельным чанком с хэшем в имени (assets/kind-3f2a1c.js) —
 * на сервере такие файлы кэшируются надолго, а при правке реплик меняется хэш.
 * В тестах тот же разбор делается через makeBundle() из уже прочитанных JSON.
 */
import type { EventDef, FacePreset, Persona, PersonaId } from './types';
import { PERSONA_IDS } from './types';
import type { DialogsFile } from '../scenario/dialogs';
import type { IntentDef } from '../scenario/intentMatch';
import { normalizeName } from '../scenario/names';
import { feature, NEW_GAMES } from '../config/edition';

export interface FaceFile { presets: FacePreset[]; emotionToFace: Record<string, string> }

export interface ContentBundle {
  personas: Map<PersonaId, Persona>;
  events: Map<string, EventDef>;
  dialogs: DialogsFile;
  intents: IntentDef[];
  /** словарь имён: нормализованное → как писать */
  names: Map<string, string>;
  face: FaceFile;
}

export interface RawContent {
  personas: Persona[];
  events: { events: EventDef[] };
  dialogs: DialogsFile;
  intents: { intents: IntentDef[] };
  names: string;
  face: FaceFile;
}

export function parseNames(txt: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const raw of txt.split(/\r?\n/)) {
    const s = raw.trim();
    if (!s || s.startsWith('#')) continue;
    m.set(normalizeName(s), s);
  }
  return m;
}

export function makeBundle(raw: RawContent): ContentBundle {
  const personas = new Map<PersonaId, Persona>();
  for (const p of raw.personas) personas.set(p.id, { ...p, riddles: p.riddles ?? [] });
  for (const id of PERSONA_IDS) if (!personas.has(id)) throw new Error(`content: нет характера ${id}`);
  return {
    personas,
    events: new Map(raw.events.events.map((e) => [e.id, e])),
    dialogs: raw.dialogs,
    intents: raw.intents.intents,
    names: parseNames(raw.names),
    face: raw.face,
  };
}

/* ───────── браузер: ленивые чанки с хэшем ───────── */
const personaMods = import.meta.glob<Persona>('../../content/personas/*.json', { import: 'default' });
const jsonMods = import.meta.glob<unknown>(['../../content/events.json', '../../content/dialogs.json', '../../content/intents.ru.json', '../../content/face.json'], { import: 'default' });
const textMods = import.meta.glob<string>('../../content/names.ru.txt', { query: '?raw', import: 'default' });

const byName = <T>(mods: Record<string, () => Promise<T>>, name: string) => {
  const k = Object.keys(mods).find((p) => p.endsWith('/' + name));
  if (!k) throw new Error(`content: нет файла ${name}`);
  return mods[k]();
};

export async function loadContent(): Promise<ContentBundle> {
  const [personas, events, dialogs, intents, face, names] = await Promise.all([
    Promise.all(PERSONA_IDS.map((id) => byName(personaMods, `${id}.json`))),
    byName(jsonMods, 'events.json'),
    byName(jsonMods, 'dialogs.json'),
    byName(jsonMods, 'intents.ru.json'),
    byName(jsonMods, 'face.json'),
    byName(textMods, 'names.ru.txt'),
  ]);
  return makeBundle({
    personas: personas.map((p) => noCareLines(p)),
    events: events as RawContent['events'],
    dialogs: editionDialogs(dialogs as DialogsFile),
    intents: intents as RawContent['intents'],
    face: face as FaceFile,
    names,
  });
}

/**
 * Редакция (src/config/edition.ts): выключенные новые мини-игры (games.new: emo/rps/simon) убираются из диалогов —
 * без триггера их нет ни в каталоге, ни в чипах, ни голосом; без узла offer.<игра> кот их не предлагает.
 */
export function editionDialogs(f: DialogsFile, on = feature('games.new')): DialogsFile {
  if (on) return f;
  const off = new Set<string>(NEW_GAMES);
  const dialogs = Object.fromEntries(Object.entries(f.dialogs).filter(([id]) => !off.has(id)));
  const offer = dialogs.offer;
  if (offer) dialogs.offer = { ...offer, nodes: Object.fromEntries(Object.entries(offer.nodes).filter(([n]) => !off.has(n))) };
  const triggers = Object.fromEntries(Object.entries(f.triggers).filter(([, t]) => !off.has(t.split(':')[0])));
  const games = f.games ? Object.fromEntries(Object.entries(f.games).filter(([id]) => !off.has(id))) : f.games;
  return { ...f, dialogs, triggers, ...(games ? { games } : {}) };
}

/**
 * «Без ласки» (feature 'pilot.noCare', продакт 26.11): реплики, которые зовут погладить, пощекотать, обнять или
 * говорят про ласку, — убираются (у события остаются другие варианты; «щекотно!» на тычок в живот — реакция, остаётся).
 * Событие, у которого не осталось ни одной (meet_skills — «Погладь меня пальцем…»), берёт первый вариант подсказки help
 * без этих слов — с его id, то есть с готовой озвучкой («Я умею сальто, танцы и загадки. Нажми кнопку внизу»).
 */
export const CARE_RE = /(^|[^а-яё])(по)?глад(ь|ить|ят|ишь|ит)(?![а-яё])|(по)?щекоч|щекотать|щекотк|обним|обнять|обнима|ласк|почеш|почесать/i;
/** событие без вариантов после фильтра → чьи варианты взять */
const NO_CARE_FALLBACK: Record<string, string> = { meet_skills: 'help' };
export function noCareLines(p: Persona, on = feature('pilot.noCare')): Persona {
  if (!on) return p;
  const lines: Persona['lines'] = {};
  for (const [ev, ls] of Object.entries(p.lines)) lines[ev] = ls.filter((l) => !CARE_RE.test(l.text));
  // событие без вариантов берёт первый вариант «донора»; у донора он убирается — иначе кот скажет ту же фразу дважды
  // подряд (знакомство «Я умею сальто…» и через 8 с подсказка help — e2e 26.11). Донор без вариантов — подсказка пальцем
  for (const [ev, from] of Object.entries(NO_CARE_FALLBACK))
    if (p.lines[ev]?.length && !lines[ev]?.length && lines[from]?.length) {
      lines[ev] = lines[from].slice(0, 1);
      lines[from] = lines[from].slice(1);
    }
  for (const ev of Object.keys(lines)) if (!lines[ev].length) delete lines[ev];
  return { ...p, lines };
}

/** Подстановка {name}, {answer} и т.п. */
export const fill = (text: string, vars: Record<string, string> = {}) => text.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');

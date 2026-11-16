/**
 * Выбор реплики для события:
 *  - только из активного характера (никаких общих реплик);
 *  - без повтора последних 3 вариантов в событии (если вариантов меньше — без повтора последнего);
 *  - cooldownMs из events.json: событие не срабатывает чаще (force — для сценария);
 *  - {name} только если имя есть в словаре names.ru.txt, иначе берутся варианты без имени;
 *  - эмоция → пресет лица (face.json), clip/fx/sound — из строки или умолчаний события.
 */
import type { ContentBundle } from './content';
import { fill } from './content';
import type { ContentLine, EventDef, Persona, PersonaId } from './types';
import { normalizeName } from '../scenario/names';

export const NO_REPEAT = 3;

export interface PickedLine {
  persona: PersonaId;
  event: string;
  line: ContentLine;
  /** готовый текст (подставлены {name}, {answer}) */
  text: string;
  face: string;
  clip?: string;
  fx?: string;
  sound?: string;
  priority: EventDef['priority'];
  interruptible: boolean;
}

export interface PickOptions {
  name?: string | null;
  vars?: Record<string, string>;
  /** игнорировать cooldown (реплики сценария и диалогов) */
  force?: boolean;
  now?: number;
}

const DEFAULT_EVENT: Omit<EventDef, 'id'> = { group: 'dialog', priority: 1, cooldownMs: 0, interruptible: true, trigger: '' };

export class LinePicker {
  private history = new Map<string, string[]>();
  private lastFired = new Map<string, number>();

  constructor(private c: Pick<ContentBundle, 'events' | 'names' | 'face'>, private random: () => number = Math.random) {}

  event(id: string): EventDef {
    return this.c.events.get(id) ?? { id, ...DEFAULT_EVENT };
  }

  /** имя можно произносить: есть в словаре */
  nameAllowed(name?: string | null): string | null {
    if (!name) return null;
    return this.c.names.get(normalizeName(name)) ?? null;
  }

  /** событие ещё «остывает» */
  coolingDown(event: string, now = Date.now()): boolean {
    const cd = this.event(event).cooldownMs;
    const last = this.lastFired.get(event);
    return cd > 0 && last !== undefined && now - last < cd;
  }

  /** варианты, которые сейчас допустимы (без учёта истории) */
  candidates(p: Persona, event: string, name?: string | null): ContentLine[] {
    const all = p.lines[event] ?? [];
    const okName = this.nameAllowed(name);
    return all.filter((l) => !l.text.includes('{name}') || !!okName);
  }

  pick(p: Persona, event: string, o: PickOptions = {}): PickedLine | null {
    const now = o.now ?? Date.now();
    if (!o.force && this.coolingDown(event, now)) return null;
    const cands = this.candidates(p, event, o.name);
    if (!cands.length) return null;
    const key = `${p.id}:${event}`;
    const hist = this.history.get(key) ?? [];
    // история могла набраться при другом наборе вариантов (с именем / без) — считаем только текущие
    const candIds = new Set(cands.map((l) => l.id));
    const recent = hist.filter((id) => candIds.has(id));
    const banned = new Set(recent.slice(-Math.min(NO_REPEAT, cands.length - 1)));
    const free = cands.filter((l) => !banned.has(l.id));
    const allowed = free.length ? free : cands;
    const line = allowed[Math.min(allowed.length - 1, Math.floor(this.random() * allowed.length))];
    hist.push(line.id);
    if (hist.length > 8) hist.shift();
    this.history.set(key, hist);
    this.lastFired.set(event, now);
    const def = p.reactions[event] ?? {};
    const ev = this.event(event);
    const okName = this.nameAllowed(o.name);
    const face = line.face ?? def.face ?? this.c.face.emotionToFace[line.emotion] ?? 'neutral';
    return {
      persona: p.id,
      event,
      line,
      text: fill(line.text, { ...(okName ? { name: okName } : {}), ...(o.vars ?? {}) }).replace(/\s+/g, ' ').trim(),
      face,
      clip: line.clip ?? def.clip,
      fx: line.fx ?? def.fx,
      sound: line.sound ?? def.sound,
      priority: ev.priority,
      interruptible: ev.interruptible,
    };
  }

  /** конкретная реплика по id («kind.intro.02») — для debug */
  byId(personas: Map<PersonaId, Persona>, id: string, o: PickOptions = {}): PickedLine | null {
    const [pid, ...rest] = id.split('.');
    const event = rest.slice(0, -1).join('.');
    const p = personas.get(pid as PersonaId);
    const line = p?.lines[event]?.find((l) => l.id === id);
    if (!p || !line) return null;
    const def = p.reactions[event] ?? {};
    const ev = this.event(event);
    const okName = this.nameAllowed(o.name) ?? 'Маша';
    return {
      persona: p.id, event, line,
      text: fill(line.text, { name: okName, ...(o.vars ?? {}) }),
      face: line.face ?? this.c.face.emotionToFace[line.emotion] ?? 'neutral',
      clip: line.clip ?? def.clip, fx: line.fx ?? def.fx, sound: line.sound ?? def.sound,
      priority: ev.priority, interruptible: ev.interruptible,
    };
  }

  reset() {
    this.history.clear();
  }
}

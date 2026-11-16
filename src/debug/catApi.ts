/**
 * Консольный API для проверки контента (и для вкладки «Контент» debug-панели):
 *   __cat.persona('kind')        — сменить характер (без наклеек)
 *   __cat.event('riddle')        — реплика события активным характером (или диалог, если событие его запускает: __cat.event('riddle', true))
 *   __cat.say('kind.intro.02')   — конкретная реплика по id
 *   __cat.text('мне грустно')    — как будто ребёнок сказал
 *   __cat.lines('kind', 'intro') — список реплик
 *   __cat.outro()                — завершить сессию (outro)
 *   __cat.state()                — состояние сценария
 */
import type { App } from '../app';
import type { PersonaId } from '../persona/types';
import { PERSONA_IDS } from '../persona/types';
import { registerContentTab } from './contentTab';

export interface CatApi {
  persona(id?: PersonaId): PersonaId;
  event(id: string, asDialog?: boolean): boolean;
  say(lineId: string): boolean;
  text(t: string): void;
  lines(persona?: PersonaId, event?: string): { id: string; text: string; emotion: string }[];
  events(): string[];
  outro(): void;
  state(): unknown;
}

export function installCatApi(app: App): CatApi {
  const d = () => app.director;
  const api: CatApi = {
    persona(id) {
      if (id && PERSONA_IDS.includes(id)) d().setPersona(id);
      return d().personas.id;
    },
    event(id, asDialog = false) {
      if (asDialog) {
        d().dispatch({ type: 'intent', intent: { type: id, text: id } });
        return true;
      }
      return d().playEvent(id);
    },
    say: (lineId) => d().sayLine(lineId),
    text: (t) => d().text(t),
    lines(persona = d().personas.id, event) {
      const p = d().personas.get(persona);
      if (!p) return [];
      return Object.entries(p.lines)
        .filter(([e]) => !event || e === event)
        .flatMap(([, ls]) => ls.map((l) => ({ id: l.id, text: l.text, emotion: l.emotion })));
    },
    events: () => [...d().personas.content.events.keys()],
    outro: () => d().dispatch({ type: 'outro_request' }),
    state: () => ({ ...d().state, persona: d().personas.id }),
  };
  (window as unknown as { __cat: CatApi }).__cat = api;
  registerContentTab(api); // вкладка «Контент» в ?debug
  return api;
}

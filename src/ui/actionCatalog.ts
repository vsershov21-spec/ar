/**
 * Каталог «Что умеет кот»: разделы и действия, которые реально работают у текущего характера.
 * Без DOM: строит список по персонажу (реплики/реакции content/personas/*.json), интентам и диалогам; рисует его ui.ts.
 * Тап по действию → Director.action(id) (scenario/actions.ts) или фраза в VoiceEngine.handleText — как будто сказали голосом.
 */
import type { Persona } from '../persona/types';
import { ACTION_ROUTE, type ActionId } from '../scenario/actions';
import { matchIntent } from '../voice/intents';
import { feature } from '../config/edition';
import { limitCatalog } from '../config/pilot';

export type SectionId = 'care' | 'tricks' | 'games' | 'emotions' | 'magic' | 'say' | 'more';

export interface CatalogItem {
  /** уникальный id (для точки «новое»): id действия или say:<интент> */
  id: string;
  label: string;
  icon: string;
  /** ui — пункт раздела «Ещё» (пересадить на другую карту, режим микрофона): не умение кота, в «открыто N из M» не считается */
  run: { action: ActionId } | { say: string } | { ui: UiRun };
}
/** служебные пункты: пересадить, микрофон, дом; unstick — «Сдёрнуть наклейки», zone — комната дома (десктоп-панель, лист); onb — онборд сервиса (svc:samokat, svc:kids — ui/serviceOnboard.ts) */
export type UiRun = 'reanchor' | 'micmode' | 'home' | 'unstick' | 'zone' | 'paint' | 'paint_erase' | 'onb';
export interface CatalogSection { id: SectionId; title: string; icon: string; items: CatalogItem[] }

interface ActionSpec { id: ActionId; label: string; icon: string; /** подпись и иконка по эффекту реакции характера */ byFx?: { event: string; map: Record<string, [string, string]> } }

const ACT_SECTIONS: { id: Exclude<SectionId, 'say' | 'more'>; title: string; icon: string; items: ActionSpec[] }[] = [
  {
    id: 'care', title: 'Забота', icon: 'heart', items: [
      { id: 'pet', label: 'Погладить', icon: 'hand' },
      { id: 'scratch', label: 'Почесать', icon: 'scratch' },
      { id: 'tickle', label: 'Щекотка', icon: 'feather' },
      { id: 'cheek', label: 'Щёчки', icon: 'cheek' },
      { id: 'paw', label: 'Дай лапу', icon: 'paw' },
      { id: 'treat', label: 'Угостить', icon: 'fish' },
      { id: 'hug', label: 'Обнять', icon: 'heart' },
    ],
  },
  {
    id: 'tricks', title: 'Трюки', icon: 'star', items: [
      { id: 'flip', label: 'Сальто', icon: 'flip' },
      { id: 'dance', label: 'Танец', icon: 'note' },
      { id: 'trick', label: 'Фокус', icon: 'star' },
      { id: 'jump', label: 'Прыжок', icon: 'jump' },
      { id: 'sit', label: 'Сидеть', icon: 'sit' },
      { id: 'wave', label: 'Помаши', icon: 'wave' },
      { id: 'sing', label: 'Песенка', icon: 'sing' },
      // фирменное характера (feature catalog.signature): у каждого кота — только своё (реакция есть только у него)
      { id: 'skate', label: 'Скейт', icon: 'skate' },
      { id: 'cocoa', label: 'Какао', icon: 'home_mug' },
      { id: 'mirror', label: 'Зеркальце', icon: 'mirror' },
    ],
  },
  {
    id: 'games', title: 'Игры', icon: 'quest', items: [
      { id: 'riddle', label: 'Загадка', icon: 'quest' },
      { id: 'echo', label: 'Повторяй', icon: 'parrot' },
      // мини-игры ночи 18.11 (content/dialogs.json): пока не озвучены — прячет app.ts (director.hasVoiced('<игра>_start'))
      { id: 'rps', label: 'Камень-ножницы', icon: 'rps' },
      { id: 'emo', label: 'Угадай рожицу', icon: 'wow' },
      { id: 'simon', label: 'Делай как я', icon: 'jump' },
      { id: 'other', label: 'Другой кот', icon: 'swap' },
    ],
  },
  {
    id: 'emotions', title: 'Эмоции', icon: 'smile', items: [
      { id: 'laugh', label: 'Рассмеши', icon: 'smile' },
      { id: 'surprise', label: 'Удиви', icon: 'wow' },
      { id: 'shy', label: 'Засмущай', icon: 'blush' },
      { id: 'tease', label: 'Подразни', icon: 'pout' },
      { id: 'dizzy', label: 'Закружи', icon: 'spiral' },
      { id: 'sleep', label: 'Усыпи', icon: 'moon' },
    ],
  },
  {
    id: 'magic', title: 'Чудеса', icon: 'sparkle', items: [
      { id: 'bubbles', label: 'Пузыри', icon: 'bubbles', byFx: { event: 'gum', map: { soap_bubbles: ['Пузыри', 'bubbles'], gum_bubble: ['Жвачка', 'gum'], glitter_burst: ['Блёстки', 'sparkle'] } } },
      { id: 'draw', label: 'Рисунок', icon: 'draw', byFx: { event: 'swipe', map: { steam_heart: ['Сердечко', 'draw'], claws: ['Граффити', 'claws'], glitter_trail: ['Узор', 'draw'] } } },
      { id: 'glass', label: 'К стеклу', icon: 'glass', byFx: { event: 'longpress', map: { steam: ['Подыши', 'glass'], glass_cat: ['К стеклу', 'glass'], kiss_print: ['Чмок', 'kiss'] } } },
      { id: 'knock', label: 'Тук-тук', icon: 'knock' },
      { id: 'sticker', label: 'Наклейки', icon: 'sticker' },
    ],
  },
];

/** «Скажи мне»: фразы, которые кот понимает голосом (content/intents.ru.json) */
export const SAY_PHRASES: { text: string; intent: string }[] = [
  { text: 'Привет!', intent: 'hello' },
  { text: 'Как тебя зовут?', intent: 'name_ask' },
  { text: 'Сколько тебе лет?', intent: 'age_ask' },
  { text: 'Что ты умеешь?', intent: 'help' },
  { text: 'Сделай сальто', intent: 'flip' },
  { text: 'Прыгни', intent: 'jump' },
  { text: 'Танцуй', intent: 'dance' },
  { text: 'Спой песенку', intent: 'sing' },
  { text: 'Помаши лапой', intent: 'wave' },
  { text: 'Загадай загадку', intent: 'riddle' },
  { text: 'Пошути', intent: 'joke' },
  { text: 'Повторяй за мной', intent: 'echo_start' },
  { text: 'Ты классный!', intent: 'compliment' },
  { text: 'Спасибо', intent: 'thanks' },
  { text: 'Кто твой брат?', intent: 'brother_ask' },
];

export interface CatalogEnv {
  /** интенты словаря (intents.ru.json) */
  intents: Set<string>;
  /** интент → диалог (dialogs.json → triggers) */
  triggers: Record<string, string>;
}

/** у характера есть что показать на событие: реплика или реакция с клипом/эффектом/звуком */
export function hasEvent(p: Persona, event: string): boolean {
  if (p.lines?.[event]?.length) return true;
  const r = p.reactions?.[event];
  return !!r && !!(r.clip || r.fx || r.sound);
}

/** интент-команда работает: есть в словаре и у характера на неё есть реакция или диалог */
function intentWorks(p: Persona, intent: string, env: CatalogEnv): boolean {
  if (!env.intents.has(intent)) return false;
  if (env.triggers[intent]) return intent !== 'riddle' || (p.riddles?.length ?? 0) > 0;
  return hasEvent(p, intent === 'change_persona' ? 'switch_start' : intent);
}

export function actionWorks(p: Persona, id: ActionId, env: CatalogEnv): boolean {
  const r = ACTION_ROUTE[id];
  if ('say' in r) return intentWorks(p, r.say, env);
  if (r.touch === 'double_tap') return !!p.signature || hasEvent(p, 'double_tap');
  if (r.touch === 'sleep') return hasEvent(p, 'sleep') && hasEvent(p, 'wake_up');
  return hasEvent(p, r.touch);
}

/** интент фразы «Скажи мне» так, как его поймёт голосовой разбор (switch → change_persona) */
export const phraseIntent = (text: string) => {
  const m = matchIntent(text, {});
  return m.intent === 'switch' ? 'change_persona' : m.intent;
};

/** фирменные действия характера — пункты каталога только при feature('catalog.signature') */
export const SIGNATURE_ACTIONS: readonly ActionId[] = ['skate', 'cocoa', 'mirror'];

/**
 * Срез редакции: signature — фирменные действия (catalog.signature), pilot — набор пилота (pilot.catalog:
 * 8 общих + 2 фирменных, игры, «Другой кот»; «Фразы» и «Эмоции» не показываются — config/pilot.ts).
 */
/** noCare — пилот без «ласки» (pilot.noCare): без погладить/почесать/щекотки/обнять */
export interface CatalogCut { signature: boolean; pilot: boolean; noCare?: boolean }
export const editionCut = (): CatalogCut => ({ signature: feature('catalog.signature'), pilot: feature('pilot.catalog'), noCare: feature('pilot.noCare') });

/** разделы каталога для характера: только работающие действия, пустые разделы — не показываем */
export function buildCatalog(p: Persona, env: CatalogEnv, cut: CatalogCut = editionCut()): CatalogSection[] {
  const out = buildAll(p, env, cut);
  return cut.pilot ? limitCatalog(p.id, out, cut.noCare ?? feature('pilot.noCare')) : out;
}

function buildAll(p: Persona, env: CatalogEnv, cut: CatalogCut): CatalogSection[] {
  const out: CatalogSection[] = [];
  for (const s of ACT_SECTIONS) {
    const items: CatalogItem[] = [];
    for (const a of s.items) {
      if (!cut.signature && SIGNATURE_ACTIONS.includes(a.id)) continue;
      if (!actionWorks(p, a.id, env)) continue;
      let { label, icon } = a;
      const fx = a.byFx ? p.reactions?.[a.byFx.event]?.fx : undefined;
      if (fx && a.byFx!.map[fx]) [label, icon] = a.byFx!.map[fx];
      items.push({ id: a.id, label, icon, run: { action: a.id } });
    }
    if (items.length) out.push({ id: s.id, title: s.title, icon: s.icon, items });
  }
  const say = SAY_PHRASES.filter((f) => phraseIntent(f.text) === f.intent && intentWorks(p, f.intent, env)).map(
    (f): CatalogItem => ({ id: `say:${f.intent}`, label: f.text, icon: 'chat', run: { say: f.text } }),
  );
  if (say.length) out.push({ id: 'say', title: 'Скажи мне', icon: 'chat', items: say });
  return out;
}

/** окружение каталога из контента */
export function catalogEnv(intents: { intent: string }[], triggers: Record<string, string>): CatalogEnv {
  return { intents: new Set(intents.map((i) => i.intent)), triggers };
}

/** тап по пункту → куда отправить: в режиссёр (действие) или в голосовой вход (фраза) */
export function routeItem(item: CatalogItem, to: { action(id: ActionId): void; say(text: string): void; ui?(id: UiRun): void }) {
  if ('action' in item.run) to.action(item.run.action);
  else if ('say' in item.run) to.say(item.run.say);
  else to.ui?.(item.run.ui);
}

/** раздел «Ещё» в конце каталога: пересадить кота на другую карту, режим микрофона (спрятан с экрана) */
export function moreSection(o: { reanchor: boolean; mic: 'auto' | 'ptt' | null }): CatalogSection | null {
  const items: CatalogItem[] = [];
  if (o.mic) items.push({ id: 'ui:micmode', label: o.mic === 'auto' ? 'Слушать по кнопке' : 'Слушать всегда', icon: 'mic', run: { ui: 'micmode' } });
  if (o.reanchor) items.push({ id: 'ui:reanchor', label: 'Пересадить на другую карту', icon: 'repin', run: { ui: 'reanchor' } });
  return items.length ? { id: 'more', title: 'Ещё', icon: 'gear', items } : null;
}

/** что ребёнок уже пробовал (точки «новое» и «открыто N из M»): localStorage, без него — только в памяти */
export class TriedStore {
  private set: Set<string>;
  constructor(private store: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage(), private key = 'ar.catalog.tried') {
    let ids: string[] = [];
    try {
      ids = JSON.parse(store?.getItem(key) ?? '[]');
    } catch {
      /* битое значение — с нуля */
    }
    this.set = new Set(Array.isArray(ids) ? ids : []);
  }
  has(id: string) {
    return this.set.has(id);
  }
  mark(id: string): boolean {
    if (this.set.has(id)) return false;
    this.set.add(id);
    try {
      this.store?.setItem(this.key, JSON.stringify([...this.set]));
    } catch {
      /* приватный режим */
    }
    return true;
  }
  /** открыто / всего по разделам каталога */
  count(sections: CatalogSection[]) {
    const all = sections.flatMap((s) => s.items);
    return { tried: all.filter((i) => this.set.has(i.id)).length, total: all.length };
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

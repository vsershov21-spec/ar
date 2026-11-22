/**
 * Срез пилота (редакция pilot, https://ar.vershov.com/mvp; docs/EDITIONS.md «Пилот»): наборы и лимиты одной таблицей,
 * без форков логики. Проверки — в точках входа по флагам из edition.ts:
 *   pilot.catalog        — каталог (actionCatalog.buildCatalog → limitCatalog), чипы кота (из того же каталога) и
 *                          голосовые команды вырезанных действий (director.intentGate → cutRedirect: «Давай лучше …» пузырём с голосом + чипы);
 *   pilot.fx             — белый список эффектов (director.runFx → fxAllowed);
 *   pilot.switchCooldown — смена кота не чаще раза в SWITCH_COOLDOWN_MS (director.switchGate → SwitchCooldown).
 *   card.paint           — «Раскрасить карту» / «Стереть рисунок» в каталоге пилота (PILOT_PAINT, src/card/paint.ts).
 * Чистая логика без DOM — тесты tests/pilot.test.ts.
 */
import type { PersonaId } from '../persona/types';
import type { ActionId } from '../scenario/actions';
import { ACTION_ROUTE } from '../scenario/actions';

/** 8 общих действий у каждого кота */
export const PILOT_COMMON: readonly ActionId[] = ['pet', 'scratch', 'tickle', 'treat', 'paw', 'hug', 'dance', 'flip'];

/**
 * 2 фирменных действия характера (id каталога). Хулиган: скейт + «К стеклу» (прижимается к стеклу, glass_cat — в каталоге
 * так и подписан; граффити-клякса как отдельного действия нет); Добряк: какао + мыльные пузыри; Блёстка: зеркальце + блёстки
 * (bubbles у Блёстки — glitter_burst, подпись «Блёстки»). skate / cocoa / mirror — клипы-«idle» характера, вызванные кнопкой
 * (scenario/actions.ts, реакции skate / cocoa / mirror в content/src/*.lines.txt).
 */
export const PILOT_SIGNATURE: Record<PersonaId, readonly ActionId[]> = {
  hooligan: ['skate', 'glass'],
  kind: ['cocoa', 'bubbles'],
  glitter: ['mirror', 'bubbles'],
};

/** игры пилота + «Другой кот» */
export const PILOT_GAMES: readonly ActionId[] = ['riddle', 'other'];

/** все действия кота в пилоте: 8 общих + 2 фирменных (без игр и «Другого кота») */
export const pilotActions = (p: PersonaId): ActionId[] => [...PILOT_COMMON, ...PILOT_SIGNATURE[p]];
/** раскраска карты (card.paint, src/card/paint.ts): «Раскрасить карту» и «Стереть рисунок» — во вкладке «Образ» у всех котов */
export const PILOT_PAINT: readonly string[] = ['ui:paint', 'ui:paint_erase'];

/** что можно нажать в каталоге (действия): 10 + загадка, повторялка, «Другой кот» */
export const pilotAllowed = (p: PersonaId): Set<string> => new Set<string>([...pilotActions(p), ...PILOT_GAMES]);

/** пункт каталога пилота: разрешённое действие или служебный пункт (мир, комнаты, микрофон, пересадка) */
export function pilotItemAllowed(p: PersonaId, id: string): boolean {
  if (/^(home:|zone:)/.test(id)) return true;
  if (id === 'ui:micmode' || id === 'ui:reanchor' || id === 'ui:unstick') return true;
  if (PILOT_PAINT.includes(id)) return true;
  return pilotAllowed(p).has(id);
}

/** разделы каталога → только пункты пилота (пустые разделы — прочь); «Скажи мне» (фразы) в пилоте нет */
export function limitCatalog<S extends { id: string; items: { id: string }[] }>(p: PersonaId, secs: S[]): S[] {
  return secs.map((s) => ({ ...s, items: s.items.filter((i) => pilotItemAllowed(p, i.id)) })).filter((s) => s.items.length);
}

/**
 * Разговорные интенты — не «действия»: на них кот отвечает репликой и в пилоте (привет, как зовут, спасибо, пошути,
 * «ты классный», грустно…). Вырезаются только команды действий, которых нет в наборе кота.
 */
const SAY_INTENT_ACTION: Record<string, ActionId> = Object.fromEntries(
  (Object.entries(ACTION_ROUTE) as [ActionId, (typeof ACTION_ROUTE)[ActionId]][]).filter(([, r]) => 'say' in r).map(([id, r]) => [(r as { say: string }).say, id]),
);
const CONVERSATION = new Set(['joke', 'compliment']);

/** интент → вырезанное действие (или null — интент разрешён или это не команда) */
export function cutAction(p: PersonaId, intent: string): ActionId | null {
  if (CONVERSATION.has(intent)) return null;
  const id = SAY_INTENT_ACTION[intent];
  if (!id) return null;
  return pilotAllowed(p).has(id) ? null : id;
}

/** озвученная реплика «Это я пока не умею…» (content/src/<кот>.lines.txt, событие pilot_cut; запись ElevenLabs 20.11) */
export const PILOT_CUT_EVENT = 'pilot_cut';
/** текст записи pilot_cut — с фирменным действием кота (PILOT_SIGNATURE[кот][0]); тест сверяет с content */
export const PILOT_CUT_TEXT: Record<PersonaId, string> = {
  hooligan: 'Это я пока не умею. Давай лучше на скейте покатаюсь!',
  kind: 'Это я пока не умею. Давай лучше какао попьём!',
  glitter: 'Это я пока не умею. Давай лучше в зеркальце посмотримся!',
};

/**
 * «Давай лучше …»: что кот предлагает вместо вырезанного действия (2 чипа из набора кота). Первый чип — фирменное:
 * текст = запись pilot_cut (event — пузырь с голосом, director.voicedBubble). Если фирменное само вырезано (чипы
 * без него) — прежний текст по подписи чипа, event null (немой пузырь: такой записи нет).
 */
export function cutRedirect(p: PersonaId, intent: string, label: (id: ActionId) => string | undefined): { cut: ActionId; text: string; chips: ActionId[]; event: string | null } | null {
  const cut = cutAction(p, intent);
  if (!cut) return null;
  // сначала фирменное (его ребёнок мог не знать), потом танец/сальто — похожие на «трюк»
  const chips = [PILOT_SIGNATURE[p][0], 'dance', 'flip', PILOT_SIGNATURE[p][1]].filter((id, i, a) => a.indexOf(id) === i && id !== cut).slice(0, 2) as ActionId[];
  if (chips[0] === PILOT_SIGNATURE[p][0]) return { cut, text: PILOT_CUT_TEXT[p], chips, event: PILOT_CUT_EVENT };
  const first = (label(chips[0]) ?? 'потанцуем').toLowerCase();
  return { cut, text: `Это я пока не умею. Давай лучше ${first}!`, chips, event: null };
}

// ───────────── эффекты ─────────────

/**
 * Эффекты кота в пилоте: 2–3 самых зрелищных на характер (+ части одного эффекта, как пятна к пузырю жвачки).
 * Хулиган — пузырь жвачки (с пятнами), искры скейта, «к стеклу»; Добряк — мыльные пузыри, сердечки, сердечко на стекле;
 * Блёстка — взрыв блёсток, след блёсток, сердечки.
 */
export const PILOT_FX: Record<PersonaId, readonly string[]> = {
  hooligan: ['gum_bubble', 'gum_splat', 'skate_sparks', 'glass_cat'],
  kind: ['soap_bubbles', 'hearts_float', 'steam_heart'],
  glitter: ['glitter_burst', 'glitter_trail', 'hearts_float'],
};
/**
 * Служебные и «ребёнок пальцем» — у всех: смена кота (наклейки), дрёма, подсказка кнопки, волна повторялки, праздник;
 * стекло пальцем (feature glass.gestures): царапины, стук, запотевшее стекло и рисунок по нему.
 */
export const SYSTEM_FX: readonly string[] = ['zzz', 'stickers_cover', 'stickers_blow', 'spotlight_button', 'echo_wave', 'confetti', 'claws', 'knock', 'steam', 'steam_draw', 'none'];

export const fxAllowed = (p: PersonaId, fx: string): boolean => SYSTEM_FX.includes(fx) || PILOT_FX[p].includes(fx);

// ───────────── смена кота ─────────────

export const SWITCH_COOLDOWN_MS = 180_000;
/** «Чуть позже» — озвученная реплика pilot_switch_later (content/src/<кот>.lines.txt, запись ElevenLabs 20.11): пузырь с голосом */
export const SWITCH_LATER_EVENT = 'pilot_switch_later';
export const SWITCH_LATER_TEXT = 'Чуть позже! Давай ещё немного поиграем со мной.';

/** смена кота не чаще раза в ms: allow() — можно ли начать сейчас; mark() — смена началась; undo() — её отменили */
export class SwitchCooldown {
  private last = -Infinity;
  private prev = -Infinity;
  constructor(readonly ms = SWITCH_COOLDOWN_MS) {}
  allow(now: number): boolean {
    return now - this.last >= this.ms;
  }
  mark(now: number) {
    this.prev = this.last;
    this.last = now;
  }
  /** смену отменили («нет» на наклейках) — кот прежний, кулдаун не тратится */
  undo() {
    this.last = this.prev;
  }
  /** сколько ждать (мс), 0 — можно */
  wait(now: number): number {
    return Math.max(0, this.ms - (now - this.last));
  }
}

/** ?cooldown=<с> — кулдаун смены кота для lab и страницы /test (config/edition.ts PARAMS): 0 — без кулдауна */
export function cooldownMs(search: string): number {
  const v = new URLSearchParams(search).get('cooldown');
  if (v === null || v === '' || !Number.isFinite(Number(v))) return SWITCH_COOLDOWN_MS;
  return Math.max(0, Number(v)) * 1000;
}

/** оставшееся время на кнопке «Другой кот»: «2:41», меньше минуты — «0:09» */
export function waitLabel(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * «Чуть позже!» с понятным сроком: «Другой кот — через 3 мин» / «через 40 с» — немой пузырь, пока записи
 * pilot_switch_later нет на сервере (с записью пузырь = SWITCH_LATER_TEXT, срок — таймером на кнопке «Другой кот»).
 */
export function laterText(ms: number): string {
  const s = Math.ceil(ms / 1000);
  const when = s >= 60 ? `через ${Math.ceil(s / 60)} мин` : `через ${Math.max(1, s)} с`;
  return `Чуть позже! Другой кот — ${when}. Давай ещё поиграем со мной.`;
}

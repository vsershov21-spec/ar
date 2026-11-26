/**
 * Онборды в сервисы (feature 'onb.services', docs/scenario/ONBOARDS.md): что и как кот показывает ребёнку в
 * Самокате и СберKids. Тексты, наборы и адреса — ЕДИНСТВЕННОЕ место; логика и DOM — src/ui/serviceOnboard.ts.
 *
 * TODO(Самокат): SAMOKAT_DEEPLINK — ссылка, которая открывает у родителя корзину «перекус от ребёнка» на оплату
 *   (универсальная ссылка iOS/Android или схема приложения), и какие метки источника принимает Самокат
 *   (без персональных данных: только «ar_cat», место «onb» и метка точки ?src). Пока плейсхолдер: кнопка
 *   «Отправить маме на оплату» ничего не открывает — лист честно просит показать экран маме (заглушка).
 * СберKids — существующий переход src/config/sberkids.ts (kidsTargets) с меткой точки (kidsLink).
 *
 * Реплики — голосом ElevenLabs (26.11): события onb_* в content/src/<кот>.lines.txt (у каждого кота свой текст в его
 * характере), ONB_EVENTS — какое событие у какого шага; director.serviceLine играет запись, а нет записи — пузырь
 * текстом кота. ONB_LINES — запасной текст (у события нет реплик) и список ONB_VOICE_LINES для сверки в тестах.
 */
import type { PersonaId } from '../persona/types';

export const SAMOKAT_DEEPLINK = 'TODO_SAMOKAT_DEEPLINK'; // TODO: у команды Самоката — корзина «на оплату родителю»

export type SvcId = 'samokat' | 'kids';

/** пункты меню (левая колонка «Сюрпризы», ui/tomLayout.ts LEFT_ORDER): значок сервиса с «?» — загадка */
export const SVC_ITEMS: { id: `svc:${SvcId}`; svc: SvcId; label: string; icon: string }[] = [
  { id: 'svc:samokat', svc: 'samokat', label: 'Самокат', icon: 'svc_samokat' },
  { id: 'svc:kids', svc: 'kids', label: 'СберKids', icon: 'svc_kids' },
];

/** перекус, который кот собирает в корзину Самоката: 6 простых иконок (SVG в serviceOnboard.ts SNACK_SVG) */
export const SNACKS: { id: string; label: string }[] = [
  { id: 'apple', label: 'Яблоко' },
  { id: 'banana', label: 'Банан' },
  { id: 'yogurt', label: 'Йогурт' },
  { id: 'juice', label: 'Сок' },
  { id: 'cheese', label: 'Сырок' },
  { id: 'cookie', label: 'Печенье' },
];

/** «Перекус от Хулигана / Добряка / Блёстки» */
export const FROM_CAT: Record<PersonaId, string> = { hooligan: 'Хулигана', kind: 'Добряка', glitter: 'Блёстки' };

/** реплики кота — запасной текст пузыря (основной — событие ONB_EVENTS у кота в content) */
export const ONB_LINES = {
  samokat: {
    hello: 'Ой! Это Самокат, у них столько вкусняшек!',
    collect: 'Смотри, собираю нам перекус после школы!',
    sheet: 'Готово! Отправим маме — пусть оплатит?',
    sent: 'Ура! Мама посмотрит и оплатит.',
    stub: 'Покажи этот экран маме — она закажет!',
    later: 'Ладно, перекус подождёт.',
  },
  kids: {
    hello: 'А это СберKids. Тут живут твои деньги и копилка!',
    piggy: 'Дзынь-дзынь! Копим на мечту.',
    tour: [
      'В копилке СберKids копят на мечту — по монетке.',
      'А ещё там задания — и награды за них!',
      'И твоя детская карта — всё видно в телефоне.',
    ],
    go: 'Заходи в СберKids — я и там с тобой!',
    later: 'Хорошо, заглянем в СберKids потом.',
  },
} as const;

/** события content (content/events.json, content/src/<кот>.lines.txt) для шагов онборда — те же ключи, что ONB_LINES */
export const ONB_EVENTS = {
  samokat: {
    hello: 'onb_samokat_hello',
    collect: 'onb_samokat_collect',
    sheet: 'onb_samokat_sheet',
    sent: 'onb_samokat_sent',
    stub: 'onb_samokat_stub',
    later: 'onb_samokat_later',
  },
  kids: {
    hello: 'onb_kids_hello',
    piggy: 'onb_kids_piggy',
    tour: ['onb_kids_tour_1', 'onb_kids_tour_2', 'onb_kids_tour_3'],
    go: 'onb_kids_go',
    later: 'onb_kids_later',
  },
} as const;

/** все события онборда (13) — тест сверяет, что у каждого кота на каждое есть реплика */
export const ONB_VOICE_EVENTS: string[] = [
  ...Object.values(ONB_EVENTS.samokat),
  ONB_EVENTS.kids.hello, ONB_EVENTS.kids.piggy, ...ONB_EVENTS.kids.tour, ONB_EVENTS.kids.go, ONB_EVENTS.kids.later,
];

/** экскурс СберKids: 3 шага (что можно в СберKids) — иконка и подпись карточки */
export const KIDS_TOUR: { id: string; icon: string; title: string; text: string }[] = [
  { id: 'piggy', icon: 'piggy', title: 'Копилка', text: 'Копи на мечту и смотри, сколько осталось' },
  { id: 'tasks', icon: 'tasks', title: 'Задания', text: 'Задания от родителей — и награда за них' },
  { id: 'card', icon: 'card', title: 'Карта', text: 'Твоя карта: траты и копилка в телефоне' },
];

/** сколько процентов мечты наполняют монетки в копилке (5 монеток) */
export const PIGGY = { coins: 5, from: 10, to: 60 } as const;

/** тайминги, мс (×1 — как увидит ребёнок; e2e ускоряет время целиком) */
export const ONB_MS = {
  hello: 2600,
  /** между продуктами, которые летят в корзину */
  snack: 520,
  /** полёт продукта / монетки */
  fly: 640,
  /** после последнего продукта — лист «Перекус от …» */
  toSheet: 900,
  coin: 560,
  /** шаг экскурса сам листается через столько, если ребёнок не нажал «Дальше» */
  tourAuto: 5200,
} as const;

/** все реплики онбордов (запасной текст) — смысл тот же, что у озвученных реплик котов (13 шт.) */
export const ONB_VOICE_LINES: string[] = [
  ...Object.values(ONB_LINES.samokat),
  ONB_LINES.kids.hello, ONB_LINES.kids.piggy, ...ONB_LINES.kids.tour, ONB_LINES.kids.go, ONB_LINES.kids.later,
];

export const isPlaceholderUrl = (url: string) => !url || /^TODO/i.test(url);

/**
 * Метка источника к ссылке (без персональных данных): utm_source=ar_cat, utm_content=<место>, utm_campaign=<точка ?src>.
 * Имена параметров — TODO у команд Самоката и СберKids (config/sberkids.ts); ссылка без «?» и с «?» — обе.
 */
export function withMark(url: string, where: string, src: string | null): string {
  try {
    const u = new URL(url);
    u.searchParams.set('utm_source', 'ar_cat');
    u.searchParams.set('utm_content', where);
    if (src) u.searchParams.set('utm_campaign', src);
    return u.toString();
  } catch {
    // схема приложения без хоста (sberkids://…): дописываем как есть
    const q = `utm_source=ar_cat&utm_content=${encodeURIComponent(where)}${src ? `&utm_campaign=${encodeURIComponent(src)}` : ''}`;
    return url + (url.includes('?') ? '&' : '?') + q;
  }
}

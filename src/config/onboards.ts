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
 * Новые реплики пока без записи ElevenLabs — пузырём без голоса (director.bubble). Список для озвучки —
 * ONB_VOICE_LINES (тест сверяет, что каждая реплика онборда в нём есть).
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

/** реплики кота (пузырём; запись ElevenLabs — потом, по списку ONB_VOICE_LINES) */
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

/** все новые реплики онбордов — для озвучки (ElevenLabs не тратим, пока продакт не скажет «да») */
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

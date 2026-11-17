/**
 * Действия с котом (панель действий и каталог «Что умеет кот»): id кнопки → чем это обрабатывает режиссёр.
 *  touch — как жест по коту (событие interaction: реакция, эмоция, клип характера),
 *  say   — как сказанная команда (интент из content/intents.ru.json; text — как сказал бы ребёнок, для лога).
 * Без DOM и three.js: таблицу читают Director.action(), каталог (src/ui/actionCatalog.ts) и тесты.
 */
export type ActionRoute = { touch: string } | { say: string; text: string };

export const ACTION_ROUTE = {
  // забота
  pet: { touch: 'stroke' },
  scratch: { touch: 'tap_cat_head' },
  tickle: { touch: 'tap_cat_belly' },
  cheek: { touch: 'tap_cat_cheek' },
  paw: { touch: 'tap_cat_paw' },
  treat: { touch: 'treat' },
  hug: { touch: 'stroke_long' },
  // трюки
  flip: { say: 'flip', text: 'сделай сальто' },
  dance: { say: 'dance', text: 'танцуй' },
  trick: { touch: 'double_tap' },
  jump: { say: 'jump', text: 'прыгни' },
  sit: { say: 'sit', text: 'сядь' },
  wave: { say: 'wave', text: 'помаши лапой' },
  sing: { say: 'sing', text: 'спой песенку' },
  // игры
  riddle: { say: 'riddle', text: 'загадай загадку' },
  echo: { say: 'echo_start', text: 'повторяй за мной' },
  other: { say: 'change_persona', text: 'давай другого' },
  // эмоции
  laugh: { say: 'joke', text: 'рассмеши' },
  surprise: { touch: 'surprise' }, // не clap: «Кто хлопнул?» — только на настоящий хлопок в микрофон
  tease: { touch: 'tease' }, // не poke_combo: «Три раза в одно место?» — только на три тапа подряд
  shy: { say: 'compliment', text: 'ты классный' },
  sleep: { touch: 'sleep' },
  dizzy: { touch: 'shake' },
  // чудеса (эффекты на стекле — только по нажатию)
  bubbles: { say: 'gum', text: 'надуй пузырь' },
  draw: { touch: 'swipe' },
  glass: { touch: 'longpress' },
  knock: { touch: 'tap_screen' },
  sticker: { say: 'stickers', text: 'наклейку' },
} as const satisfies Record<string, ActionRoute>;

export type ActionId = keyof typeof ACTION_ROUTE;
export const ACTIONS = Object.keys(ACTION_ROUTE) as ActionId[];
export const isActionId = (s: string): s is ActionId => s in ACTION_ROUTE;

/** «Усыпи»: через столько мс кот сам просыпается (если ребёнок за это время ничего не сделал) */
export const SLEEP_WAKE_MS = 6500;

/**
 * Локальный разбор намерений по ключевым словам. Никаких сетевых вызовов и LLM.
 * Текст нормализуется (нижний регистр, ё→е, без пунктуации), ищутся основы слов.
 */
export type Intent =
  | { type: 'flip' }
  | { type: 'riddle' }
  | { type: 'dance' }
  | { type: 'hello' }
  | { type: 'money' }
  | { type: 'switch' }
  | { type: 'name'; name: string }
  | { type: 'skip' }
  | { type: 'yes' }
  | { type: 'no' }
  | { type: 'joke' }
  | { type: 'unknown'; text: string };

export const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const has = (text: string, stems: string[]) => {
  const words = text.split(' ');
  return stems.some((st) => (st.includes(' ') ? text.includes(st) : words.some((w) => w.startsWith(st))));
};

const RULES: Array<[Intent['type'], string[]]> = [
  // порядок важен: деньги и смена характера — приоритетнее остального
  ['money', ['деньг', 'денег', 'баланс', 'сколько', 'рубл', 'копил', 'карманн', 'накоп', 'купи', 'потрат', 'счет', 'кэшбэк', 'кешбек', 'спасибо бонус']],
  ['switch', ['другого', 'другой', 'другим', 'смени', 'поменяй', 'измени', 'переоден', 'новый образ']],
  ['flip', ['сальто', 'кувыр', 'переворот', 'флип', 'трюк']],
  ['riddle', ['загадк', 'загадай']],
  ['dance', ['танц', 'станц', 'потанц', 'пляш', 'спляши', 'диско']],
  ['joke', ['шутк', 'пошути', 'анекдот', 'смешн']],
  ['hello', ['привет', 'здравств', 'здорово', 'хай', 'салют', 'добрый', 'приве']],
  ['skip', ['пропуст', 'не скажу', 'неважно', 'дальше']],
  ['yes', ['да', 'ага', 'конечно', 'хочу', 'давай']],
  ['no', ['нет', 'неа', 'не хочу']],
];

const NAME_PATTERNS = [/меня зовут ([а-яa-z-]+)/, /мое имя ([а-яa-z-]+)/, /^я ([а-яa-z-]+)$/, /зови меня ([а-яa-z-]+)/];
const STOP_NAMES = new Set(['не', 'никак', 'тебя', 'кот', 'хочу', 'знаю', 'здесь', 'тут']);

export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** expectName=true — в шаге «как тебя зовут» одиночное слово считаем именем. */
export function parseIntent(raw: string, opts: { expectName?: boolean } = {}): Intent {
  const text = normalize(raw);
  if (!text) return { type: 'unknown', text: '' };
  for (const re of NAME_PATTERNS) {
    const m = text.match(re);
    if (m && !STOP_NAMES.has(m[1])) return { type: 'name', name: capitalize(m[1]) };
  }
  for (const [type, stems] of RULES) {
    if (type === 'yes' || type === 'no') continue;
    if (has(text, stems)) return { type } as Intent;
  }
  if (opts.expectName) {
    const words = text.split(' ').filter((w) => w.length > 1 && !STOP_NAMES.has(w));
    if (words.length >= 1 && words.length <= 2 && /^[а-яa-z-]+$/.test(words[0])) return { type: 'name', name: capitalize(words[0]) };
  }
  const words = text.split(' ');
  if (words.some((w) => w === 'нет' || w === 'неа')) return { type: 'no' };
  if (words.some((w) => ['да', 'ага', 'конечно', 'хочу', 'давай'].includes(w))) return { type: 'yes' };
  return { type: 'unknown', text };
}

/**
 * Разбор намерений ребёнка — локально, без сети и LLM. Словарь — content/intents.ru.json (правит продукт).
 *
 *  1. Нормализация: нижний регистр, ё→е, без знаков.
 *  2. Сравнение слов: точно → по основе (стемминг-lite: срезаем частые окончания) → по префиксу
 *     (в словаре можно писать основу: «жвачк») → Левенштейн ≤ 1 для слов длиннее 4 букв («сальта», «таньцуй»).
 *  3. Фраза из нескольких слов должна встретиться по порядку (между словами допускается одно лишнее).
 *  4. Порядок = приоритет: безопасность (sad, scared) проверяется первой и выигрывает при любом совпадении.
 *  5. context: only_after_question — интент работает только в окне ответа на вопрос кота
 *     (окно открывает VoiceEngine.listen() или реплика кота, заканчивающаяся на «?»).
 *  6. Уверенность < 0.6 → unknown.
 * Имя: «меня зовут …», «зови меня …», «моё имя …»; когда кот спросил имя — ещё «я …», «это …» и одиночное слово
 * (только из словаря имён; другое слово — confirmName: VoiceEngine переспросит «Тебя зовут X?»).
 * Имя из словаря names.ru.txt помечается known=true (кот произносит вслух только такие).
 */
import data from '../../content/intents.ru.json';
import dialogsData from '../../content/dialogs.json';
import namesRaw from '../../content/names.ru.txt?raw';

export type IntentId =
  | 'sad' | 'scared' | 'echo_stop' | 'echo_start' | 'bye' | 'hello' | 'money' | 'sberkids' | 'brother_ask' | 'name_ask'
  | 'age_ask' | 'choose_hooligan' | 'choose_kind' | 'choose_glitter' | 'switch' | 'flip' | 'jump' | 'dance' | 'sit'
  | 'wave' | 'sing' | 'gum' | 'stickers' | 'riddle' | 'joke' | 'help' | 'bored' | 'compliment' | 'rude' | 'thanks' | 'yes' | 'no' | 'skip'
  // мини-игры и частые детские вопросы (ночь 18.11, docs/scenario/CONTENT_NIGHT.md)
  | 'emo_game' | 'rps' | 'simon' | 'where_live' | 'likes' | 'friends' | 'tale' | 'friend' | 'how_are_you';

/** Совместимый с автоматом сценария тип: change_persona из словаря → 'switch' */
export type Intent =
  | { type: 'name'; name: string; known?: boolean; confidence?: number }
  | { type: 'unknown'; text: string; confidence?: number }
  | { type: IntentId; confidence?: number };

export interface IntentContext {
  /** окно ответа на вопрос кота открыто (yes/no и прочие only_after_question) */
  question?: boolean;
  /** кот спросил имя */
  expectName?: boolean;
  /** ожидаемые интенты — небольшой бонус уверенности */
  expect?: string[];
}

export interface IntentMatch {
  intent: IntentId | 'name' | 'unknown';
  confidence: number;
  /** какая фраза словаря сработала */
  phrase?: string;
  name?: string;
  known?: boolean;
  /** окно имени: одно слово не из словаря — возможно имя; переспросить «Тебя зовут X?» */
  confirmName?: string;
  text: string;
}

interface Rule { intent: string; phrases: string[][]; raw: string[]; context?: string }

export const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9\s-]/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const ENDINGS = ['ться', 'тесь', 'ешься', 'ется', 'ются', 'ами', 'ями', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими', 'ешь', 'ишь', 'ете', 'ите',
  'ся', 'сь', 'ют', 'ут', 'ат', 'ят', 'ой', 'ей', 'ий', 'ый', 'ая', 'яя', 'ое', 'ее', 'ую', 'юю', 'ом', 'ем', 'ам', 'ям', 'ах', 'ях', 'ть',
  'а', 'я', 'о', 'е', 'ы', 'и', 'у', 'ю', 'й', 'ь'];
/** Стемминг-lite: срезать одно-два частых окончания, основа не короче 3 букв */
export function stem(w: string): string {
  let s = w;
  for (let pass = 0; pass < 2; pass++) {
    const e = ENDINGS.find((e) => s.length - e.length >= 3 && s.endsWith(e));
    if (!e) break;
    s = s.slice(0, -e.length);
  }
  return s;
}

/** расстояние Левенштейна с ранним выходом (> max → max+1) */
export function lev(a: string, b: string, max = 1): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** насколько слово ребёнка tw похоже на слово словаря pw: 0..1 */
export function wordScore(pw: string, tw: string): number {
  if (pw === tw) return 1;
  const sp = stem(pw), st = stem(tw);
  if (sp === st && sp.length >= 3) return 0.92;
  if (pw.length >= 4 && tw.startsWith(pw)) return 0.88; // в словаре — основа («жвачк»)
  if (st.length >= 4 && sp.length >= 4 && (st.startsWith(sp) || sp.startsWith(st))) return 0.85;
  if (pw.length > 4 && tw.length >= 4 && (lev(pw, tw) <= 1 || lev(sp, st) <= 1)) return 0.78;
  // мягкий знак и «тс/ц» — частые детские/распознавательные ошибки («таньцуй»)
  const soft = (s: string) => s.replace(/ь/g, '').replace(/тс/g, 'ц');
  if (pw.length > 4 && soft(pw) !== pw && lev(soft(pw), soft(tw)) <= 1) return 0.76;
  if (tw.length > 4 && soft(tw) !== tw && lev(stem(soft(pw)), stem(soft(tw))) <= 1) return 0.74;
  return 0;
}

/** фраза словаря (слова) против слов ребёнка: по порядку, допускается одно лишнее слово между ними */
export function phraseScore(p: string[], words: string[]): number {
  let best = 0;
  for (let s = 0; s < words.length; s++) {
    let i = s, sum = 0, ok = true;
    for (let k = 0; k < p.length; k++) {
      let got = 0, at = -1;
      for (let j = i; j < Math.min(words.length, i + (k === 0 ? 1 : 2)); j++) {
        const sc = wordScore(p[k], words[j]);
        if (sc > got) (got = sc), (at = j);
      }
      if (!got) {
        ok = false;
        break;
      }
      sum += got;
      i = at + 1;
    }
    // отрицание перед фразой («не танцуй», «не повторяй за мной») — это не она
    if (ok) best = Math.max(best, sum / p.length - (s > 0 && words[s - 1] === 'не' && p[0] !== 'не' ? 0.45 : 0));
  }
  if (!best) return 0;
  // длинные фразы специфичнее: «не хочу» сильнее «хочу», «давай другого» сильнее «давай»
  return best + 0.04 * (p.length - 1); // может быть > 1 — для ранжирования; наружу отдаём ≤ 1
}

const RULES: Rule[] = (data as { intents: { intent: string; phrases: string[]; context?: string }[] }).intents.map((r) => ({
  intent: r.intent === 'change_persona' ? 'switch' : r.intent,
  raw: r.phrases,
  phrases: r.phrases.map((p) => normalize(p).split(' ')),
  context: r.context,
}));
// Дополнения к словарю (то, что уже понимал прототип): смена характера и деньги
const EXTRA: Rule[] = [
  { intent: 'switch', raw: [], phrases: [['давай', 'другого'], ['другого'], ['смени'], ['поменяй'], ['другой'], ['новый', 'образ']] },
  { intent: 'money', raw: [], phrases: [['баланс'], ['сколько', 'денег'], ['сколько', 'на', 'карте'], ['рубл'], ['кэшбэк'], ['кешбек']] },
];
const REFUSALS = ((data as any).nameRefusals as string[]).map((p) => normalize(p).split(' '));
const SAFETY = new Set(['sad', 'scared']);

/** Словарь имён: нормализованная форма → как писать */
export const NAMES = new Map<string, string>();
for (const l of namesRaw.split('\n')) {
  const n = l.trim();
  if (n && !n.startsWith('#')) NAMES.set(normalize(n), n);
}

const NAME_PATTERNS = [/(?:^| )меня зовут ([а-яa-z]+)/, /(?:^| )мое имя ([а-яa-z]+)/, /(?:^| )зови меня ([а-яa-z]+)/];
/** «я Маша», «это Петя» — имя только в окне имени (иначе «я устал», «это круто» становились бы именами) */
const NAME_PATTERNS_ASKED = [/^я ([а-яa-z]+)$/, /^это ([а-яa-z]+)$/];
const STOP_NAMES = new Set(['не', 'никак', 'тебя', 'кот', 'котик', 'хочу', 'знаю', 'здесь', 'тут', 'боюсь', 'устал', 'устала', 'пошел', 'пошла', 'грустно', 'скажу', 'девочка', 'мальчик', 'тоже',
  'меня', 'зовут', 'ну', 'да', 'ага', 'это', 'нет', 'неа', 'а', 'э', 'мм', 'ой', 'вот', 'я', 'мое', 'имя', 'зови']);

/** «меня зовут», «я», «это», «ну меня зовут» — начало ответа без самого имени (окно имени слушает дальше) */
const NAME_LEADS = new Set(['меня зовут', 'мое имя', 'зови меня', 'я', 'это', 'меня', 'зовут', 'меня зовут это', 'я это']);
export function isNameLead(raw: string): boolean {
  const t = normalize(raw).split(' ').filter((w) => w && !['ну', 'а', 'э', 'мм', 'вот', 'ой'].includes(w)).join(' ');
  return NAME_LEADS.has(t);
}

function nameOf(w: string): { name: string; known: boolean } | null {
  if (!w || STOP_NAMES.has(w) || w.length < 2) return null;
  const known = NAMES.get(w);
  return { name: known ?? capitalize(w), known: !!known };
}

/** Главная функция: текст → интент с уверенностью */
export function matchIntent(raw: string, ctx: IntentContext = {}): IntentMatch {
  const text = normalize(raw);
  const none: IntentMatch = { intent: 'unknown', confidence: 0, text };
  if (!text) return none;
  const words = text.split(' ');
  // имя по фразе — самый явный сигнал
  for (const re of ctx.expectName ? [...NAME_PATTERNS, ...NAME_PATTERNS_ASKED] : NAME_PATTERNS) {
    const m = text.match(re);
    const n = m && nameOf(m[1]);
    if (n && !RULES.some((r) => SAFETY.has(r.intent) && r.phrases.some((p) => phraseScore(p, words) >= 0.9))) return { intent: 'name', confidence: n.known ? 0.95 : 0.8, ...n, text };
  }
  if (ctx.expectName && REFUSALS.some((p) => phraseScore(p, words) >= 0.85)) return { intent: 'skip', confidence: 0.9, phrase: 'nameRefusals', text };
  let best: IntentMatch = none;
  for (const r of [...RULES, ...EXTRA]) {
    if (r.context === 'only_after_question' && !ctx.question) continue;
    let sc = 0, ph = '';
    r.phrases.forEach((p, i) => {
      const s = phraseScore(p, words);
      if (s > sc) (sc = s), (ph = r.raw[i] ?? p.join(' '));
    });
    if (!sc) continue;
    if (ctx.expect?.includes(r.intent)) sc += 0.08;
    // безопасность — первой: любое уверенное совпадение сразу
    if (SAFETY.has(r.intent) && sc >= 0.74) return { intent: r.intent as IntentId, confidence: Math.min(1, sc), phrase: ph, text };
    if (sc > best.confidence + 1e-9) best = { intent: r.intent as IntentId, confidence: sc, phrase: ph, text };
  }
  // кот спросил имя: одно-два слова без явного интента — имя, но только из словаря имён; другое слово —
  // «Тебя зовут X?» (VoiceEngine.nameStep), а не «Здравствуй, Ничего!»
  if (ctx.expectName && best.confidence < 0.85) {
    const ws = words.filter((w) => !STOP_NAMES.has(w));
    if (ws.length >= 1 && ws.length <= 2) {
      const n = nameOf(ws[0]);
      if (n?.known) return { intent: 'name', confidence: 0.9, ...n, text };
      if (n && best.confidence < 0.6) return { ...none, confidence: best.confidence, confirmName: n.name };
    }
  }
  if (best.confidence < 0.6) return { ...none, confidence: best.confidence };
  return { ...best, confidence: Math.min(1, best.confidence) };
}

// ───────────── контекст разговора (ставит VoiceEngine) ─────────────
let current: IntentContext & { until?: number } = {};
/** Окно ответа на вопрос кота: until — performance.now() конца окна */
export function setIntentContext(c: IntentContext & { until?: number }) {
  current = c;
}
export function intentContext(): IntentContext {
  if (current.until !== undefined && typeof performance !== 'undefined' && performance.now() > current.until) current = {};
  return current;
}

/**
 * Совместимый вход для director/scenario: текст → Intent.
 * Контекст: явный opts + текущее окно вопроса (VoiceEngine/реплика кота с «?»).
 */
export function parseIntent(raw: string, opts: IntentContext = {}): Intent {
  const c = { ...intentContext(), ...opts };
  const m = matchIntent(raw, c);
  if (m.intent === 'name') return { type: 'name', name: m.name!, known: m.known, confidence: m.confidence };
  if (m.intent === 'unknown') return { type: 'unknown', text: m.text, confidence: m.confidence };
  return { type: m.intent, confidence: m.confidence };
}

/**
 * То, что дети 6–13 лет говорят коту чаще всего, но что не команда: без этих фраз в грамматике Vosk
 * всё сказанное становится [unk] — и ребёнок не видит, что его услышали. Интента у них нет: кот отвечает
 * «не понял / я пока умею…», а распознанный текст показывается в подсказке.
 */
export const CHAT_PHRASES = [
  'как дела', 'как ты', 'что делаешь', 'ты где', 'где ты', 'ты меня слышишь', 'слышишь', 'ты слышишь', 'ау',
  'мяу', 'мур', 'смотри', 'посмотри', 'смотри на меня', 'а ты', 'почему', 'зачем', 'что это', 'это кто',
  'я тебя люблю', 'ты мой друг', 'давай дружить', 'мой кот', 'котик', 'котенок', 'киса', 'кис кис',
  'ты умеешь', 'ты можешь', 'покажи', 'сделай', 'расскажи', 'еще', 'еще раз', 'снова', 'опять', 'ну',
  'а', 'ой', 'ура', 'круто', 'класс', 'прикольно', 'смешно', 'вау', 'ого', 'супер', 'хорошо', 'плохо',
  'я', 'ты', 'мы', 'мама', 'папа', 'мне', 'тебе', 'меня', 'тебя', 'что', 'кто', 'как', 'где', 'когда',
  'давай', 'хочу', 'не хочу', 'можно', 'пожалуйста', 'можешь', 'ещё', 'хватит', 'кот', 'кошка',
];

/** «огурец», «елка»/«ёлка», «мишка» — слова-ответы загадок всех характеров (content/dialogs.json → riddles) */
export function riddleWords(riddles: Record<string, { answer: string; keywords: string[] }[]> = (dialogsData as any).riddles ?? {}): string[] {
  const out = new Set<string>();
  const add = (w: string) => {
    const t = w.toLowerCase().trim();
    if (!t) return;
    out.add(t);
    out.add(normalize(t));
  };
  for (const list of Object.values(riddles))
    for (const r of list) {
      add(r.answer);
      for (const k of r.keywords) {
        if (!k.endsWith('*')) {
          add(k);
          continue;
        }
        // основа «мишк*» → самые частые формы; слов, которых нет в словаре модели, Vosk просто не учтёт
        const b = k.slice(0, -1).toLowerCase();
        if (/[бвгджзклмнпрстфхцчшщ]$/.test(b)) for (const e of ['а', 'и', 'у', 'ы']) out.add(b + e);
      }
    }
  return [...out].filter((w) => !w.endsWith('*'));
}

/**
 * Слова-ответы мини-игр (content/dialogs.json → games): подпись варианта, words (как скажет ребёнок: «весёлый»,
 * «радостный», «камень») и ключевые слова без «*».
 */
export function gameWords(games: Record<string, { items: { label: string; words?: string[]; keywords?: string[] }[] }> = (dialogsData as any).games ?? {}): string[] {
  const out = new Set<string>();
  for (const g of Object.values(games))
    for (const it of g.items) for (const w of [it.label, ...(it.words ?? []), ...(it.keywords ?? []).filter((k) => !k.endsWith('*'))]) out.add(normalize(w));
  return [...out].filter(Boolean);
}

/**
 * Фразы для грамматики Vosk: все фразы словаря (основы вроде «жвачк» пропускаем — их нет в словаре модели),
 * имена, ответы загадок, частые детские фразы, связки. Ограниченный словарь заметно повышает точность
 * на детской речи. Слова с «ё» — и с «е», и с «ё» (как записано в модели, не знаем; лишнее Vosk пропустит).
 */
export function grammarPhrases(): string[] {
  const set = new Set<string>();
  // основа в словаре — слово без окончания, оканчивается на «согласная + к» (жвачк, наклейк) или это «рубл»
  const isWord = (w: string) => !/[бвгджзклмнпрстфхцчшщй]к$/.test(w) && w !== 'рубл';
  for (const r of [...RULES, ...EXTRA]) {
    for (const p of r.phrases) if (p.every(isWord)) set.add(p.join(' '));
    for (const raw of r.raw) if (/ё/i.test(raw) && !raw.includes('*')) set.add(raw.toLowerCase().replace(/[^а-яё\s]/g, ' ').replace(/\s+/g, ' ').trim());
  }
  for (const p of REFUSALS) set.add(p.join(' '));
  // имена — и с «е», и с «ё» (Пётр, Алёна, Артём, Сёма): в словаре модели может быть любая форма
  for (const [n, orig] of NAMES) {
    set.add(n);
    if (/ё/i.test(orig)) set.add(orig.toLowerCase());
  }
  for (const w of riddleWords()) set.add(w);
  for (const w of gameWords()) set.add(w);
  for (const f of CHAT_PHRASES) set.add(normalize(f));
  for (const f of ['меня зовут', 'я', 'зови меня', 'мое имя', 'ну', 'а', 'котик', 'кот', 'пожалуйста', 'можешь', 'сделай', 'ещё', 'еще', 'хватит', 'покажи', 'расскажи', 'давай'])
    set.add(f);
  set.add('[unk]');
  return [...set].filter(Boolean);
}

/** только связки и междометия («ну», «а», «я») — так Vosk часто «слышит» шум; это не фраза ребёнка */
const FILLERS = new Set(['ну', 'а', 'я', 'ой', 'ой ой', 'э', 'мм', 'ты', 'мы', 'и', 'да ну', 'вот']);
export function isFillerOnly(raw: string): boolean {
  const t = normalize(raw);
  if (!t) return true;
  return t.split(' ').every((w) => FILLERS.has(w));
}

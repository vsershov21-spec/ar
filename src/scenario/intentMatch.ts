/**
 * Проверка ответа на загадку по ключевым словам (content/dialogs.json → riddles[].keywords).
 * Интенты ребёнка разбирает src/voice/intents.ts (агент «Голос»); здесь — только слова-ответы.
 * Слово совпадает точно, по основе («огур*» — любое окончание; без звёздочки — до 3 букв окончания
 * для слов от 5 букв), и для слов от 5 букв допускается одна опечатка распознавания.
 */
export interface IntentDef {
  intent: string;
  phrases: string[];
  /** only_after_question — только в окне ответа на вопрос кота; choose_or_any — всегда */
  context?: 'only_after_question' | 'choose_or_any';
}

export const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9\s-]/g, ' ')
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** как normalize, но сохраняет «*» — маркер основы слова */
const normPhrase = (s: string) =>
  s.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9\s*-]/g, ' ').replace(/-/g, ' ').replace(/\s+/g, ' ').trim();

export function lev1(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (la > lb) i++;
    else if (lb > la) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (la - i) + (lb - j) <= 1;
}

/** совпадение слова речи `w` со словом фразы `p` */
export function wordMatch(w: string, p: string): boolean {
  if (p.endsWith('*')) return w.startsWith(p.slice(0, -1)); // явная основа: «монет*»
  if (w === p) return true;
  // основа/окончание: «жвачк» → «жвачку», «привет» → «приветик»; короткие слова («пока») — только точно,
  // иначе «пока» ловилось бы в «покажи»
  if (p.length >= 5 && w.startsWith(p) && w.length - p.length <= 3) return true;
  if (p.length >= 5 && w.length >= 5 && lev1(w, p)) return true;
  return false;
}

export function phraseIn(words: string[], phrase: string): boolean {
  const pw = normPhrase(phrase).split(' ').filter(Boolean);
  if (!pw.length) return false;
  for (let i = 0; i + pw.length <= words.length; i++) {
    let ok = true;
    for (let k = 0; k < pw.length && ok; k++) ok = wordMatch(words[i + k], pw[k]);
    if (ok) return true;
  }
  return false;
}

/** Ответ на загадку: содержит ли фраза любое ключевое слово (основу). */
export function answerMatches(raw: string, keywords: string[]): boolean {
  const words = normalize(raw).split(' ').filter(Boolean);
  return keywords.some((k) => phraseIn(words, k));
}

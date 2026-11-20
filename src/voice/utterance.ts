/**
 * Что делать с фразой, которую услышал микрофон (чистая функция — тестируется в Node).
 *
 * Правило: каждая настоящая фраза ребёнка получает ответ.
 *  - понятая команда (интент с уверенностью ≥ 0.6) → действие, даже короткая («да», «стоп»);
 *  - непонятая, но это речь: голос ≥ MIN_SPEECH_MS и есть слова (или Vosk услышал слова вне грамматики — [unk])
 *    → 'unknown': кот переспрашивает / говорит «я пока умею…» (scenario/machine.ts);
 *  - шум: короче MIN_SPEECH_MS, только междометия/связки («а», «ну» — так Vosk слышит шорох), пусто без [unk]
 *    → молчим (в подсказке — «не расслышал»), кот не болтает в ответ на хлопки, телевизор и себя.
 *  - кнопка (ptt) и чипы — всегда ответ: ребёнок явно обратился к коту;
 *  - открыт диалог (ctx.question): «да», «нет», «сдаюсь» — интенты (первая ветка), ответ загадки/игры из её ключей
 *    (ctx.answers) — по длине не отбрасывается.
 *  - «слушаю всегда»: непонятые фразы подряд — отвечаем не чаще раза в UNKNOWN_GAP_MS (разговор взрослых рядом
 *    не превращается в «чё? не расслышал» каждые 2 секунды).
 */
import { isAnswer, isFillerOnly, matchIntent, type IntentContext, type IntentMatch } from './intents';

export const MIN_SPEECH_MS = 500;
export const UNKNOWN_GAP_MS = 4000;

export type ListenReason = 'ptt' | 'window' | 'barge' | 'vad' | null;

export interface Utterance {
  /** текст распознавателя (без [unk]) */
  text: string;
  /** сколько слов вне грамматики услышал Vosk */
  unk: number;
  /** длительность голоса в фразе по VAD, мс (0 — неизвестно) */
  speechMs: number;
  reason: ListenReason;
  ctx: IntentContext;
  now: number;
  /** когда кот последний раз отвечал на непонятое (из «слушаю всегда») */
  lastUnknownAt: number;
}

export type Verdict =
  | { kind: 'intent'; match: IntentMatch }
  | { kind: 'unknown'; match: IntentMatch }
  | { kind: 'noise'; why: 'short' | 'filler' | 'empty' | 'rate' };

export function classifyUtterance(u: Utterance): Verdict {
  const text = u.text.trim();
  const match = matchIntent(text, u.ctx);
  // понятая команда — всегда (длительность не важна: «да» короче полсекунды)
  if (text && match.intent !== 'unknown') return { kind: 'intent', match };
  // кнопка — явно; в загадке/мини-игре короткий ответ из ключей («кот», «ёж») — тоже ответ, а не шум по длине
  // окно имени: слово, похожее на имя («Ян»), — переспросим «Тебя зовут Ян?», а не выбросим как обрывок
  const deliberate = u.reason === 'ptt' || (!!text && isAnswer(text, u.ctx.answers)) || (!!u.ctx.expectName && !!match.confirmName);
  const asked = !!u.ctx.question || u.reason === 'window';
  if (!text && !u.unk) return { kind: 'noise', why: 'empty' };
  if (!deliberate) {
    // в окне ответа ребёнок мог сказать короткое «э-э… огурец» — порог ниже
    const min = asked ? MIN_SPEECH_MS * 0.6 : MIN_SPEECH_MS;
    if (u.speechMs > 0 && u.speechMs < min) return { kind: 'noise', why: 'short' };
    if (text && isFillerOnly(text) && !u.unk && u.speechMs < 900) return { kind: 'noise', why: 'filler' };
    if (!text && u.unk && u.speechMs === 0) return { kind: 'noise', why: 'empty' };
    if (!asked && u.reason !== 'barge' && u.now - u.lastUnknownAt < UNKNOWN_GAP_MS) return { kind: 'noise', why: 'rate' };
  }
  return { kind: 'unknown', match: { ...match, intent: 'unknown', text: match.text } };
}

/**
 * «Кот слушает и отвечает, а не болтает сам с собой»:
 *  - фраза ребёнка → вердикт (команда / непонятая речь / шум) → действие автомата сценария;
 *  - грамматика Vosk покрывает то, что реально скажет ребёнок (ответы загадок, «что ты умеешь», болтовня);
 *  - правила тишины: когда кот может заговорить сам.
 */
import { describe, it, expect } from 'vitest';
import { classifyUtterance, MIN_SPEECH_MS, UNKNOWN_GAP_MS, type Utterance } from '../src/voice/utterance';
import { grammarPhrases, matchIntent, riddleWords, isFillerOnly } from '../src/voice/intents';
import { initialState, step, makeScenarioConfig, unknownReply, type Action, type ScenarioState, type ScenarioEvent } from '../src/scenario/machine';
import { InitiativeGate, INITIATIVE_DEFAULTS, type InitiativeEnv } from '../src/scenario/initiative';
import { dialogsFile } from './helpers/content';

const cfg = makeScenarioConfig(dialogsFile, { random: () => 0.5 });

const utt = (o: Partial<Utterance>): Utterance => ({ text: '', unk: 0, speechMs: 900, reason: 'vad', ctx: {}, now: 100_000, lastUnknownAt: -1e9, ...o });
const verdict = (o: Partial<Utterance>) => classifyUtterance(utt(o));

/** состояние «играем» с Хулиганом */
function playing(): ScenarioState {
  let s = initialState();
  const evs: ScenarioEvent[] = [{ type: 'wake' }, { type: 'card_found' }, { type: 'timer', id: 'appear_done' }, { type: 'skip_name' }, { type: 'choose', persona: 'hooligan' }];
  for (const e of evs) s = step(s, e, cfg).state;
  expect(s.phase).toBe('play');
  return s;
}

/** как director.text: распознанный текст → интент → автомат (свободная игра, вопроса нет) */
function route(s: ScenarioState, text: string, question = false) {
  const m = matchIntent(text, { question });
  const type = m.intent === 'switch' ? 'change_persona' : m.intent;
  const intent = m.intent === 'name' ? { type: 'name', name: m.name, known: !!m.known, text } : { type, text };
  return step(s, { type: 'intent', intent }, cfg);
}
const reacts = (a: Action[]) => a.filter((x) => x.type === 'react').map((x) => (x as Extract<Action, { type: 'react' }>).event);
const says = (a: Action[]) => a.filter((x) => x.type === 'say').map((x) => (x as Extract<Action, { type: 'say' }>).key);

describe('фраза ребёнка → вердикт', () => {
  it.each([
    ['сделай сальто', 'flip'],
    ['потанцуй со мной', 'dance'],
    ['расскажи шутку', 'joke'],
    ['загадай загадку', 'riddle'],
    ['как тебя зовут', 'name_ask'],
    ['а тебя как звать', 'name_ask'],
    ['что ты умеешь', 'help'],
    ['давай поиграем', 'help'],
    ['привет котик', 'hello'],
    ['пока пока', 'bye'],
    ['мне грустно', 'sad'],
    ['спасибо большое', 'thanks'],
    ['я тебя люблю', 'compliment'],
    ['спой песенку', 'sing'],
    ['повторяй за мной', 'echo_start'],
  ])('«%s» → команда %s', (text, intent) => {
    const v = verdict({ text });
    expect(v.kind).toBe('intent');
    if (v.kind === 'intent') expect(v.match.intent).toBe(intent);
  });

  it('короткая команда (< 0,5 с) всё равно выполняется', () => {
    expect(verdict({ text: 'стоп', speechMs: 250 }).kind).toBe('intent');
    expect(verdict({ text: 'да', speechMs: 200, ctx: { question: true } }).kind).toBe('intent');
  });

  it('непонятая фраза с голосом ≥ 0,5 с → ответ «не понял»', () => {
    expect(verdict({ text: 'мяу мяу', speechMs: 800 }).kind).toBe('unknown');
    expect(verdict({ text: 'мяу мяу', speechMs: 700 }).kind).toBe('unknown');
  });

  it('слова вне грамматики ([unk]) без текста — тоже речь, ответ «не понял»', () => {
    expect(verdict({ text: '', unk: 2, speechMs: 1200 }).kind).toBe('unknown');
  });

  it('шум: коротко, только «а/ну», пусто — без ответа', () => {
    expect(verdict({ text: 'мяу мяу', speechMs: MIN_SPEECH_MS - 100 })).toEqual({ kind: 'noise', why: 'short' });
    expect(verdict({ text: 'ну', speechMs: 600 })).toEqual({ kind: 'noise', why: 'filler' });
    expect(verdict({ text: '', unk: 0 })).toEqual({ kind: 'noise', why: 'empty' });
    expect(isFillerOnly('а ну')).toBe(true);
    expect(isFillerOnly('ну давай')).toBe(false);
  });

  it('кнопка «держи и говори»: любая фраза получает ответ, даже короткая', () => {
    expect(verdict({ text: 'кря', speechMs: 200, reason: 'ptt' }).kind).toBe('unknown');
    expect(verdict({ text: '', unk: 1, speechMs: 0, reason: 'ptt' }).kind).toBe('unknown');
  });

  it('после вопроса кота короткий ответ не считается шумом', () => {
    expect(verdict({ text: 'огурец', speechMs: 350, reason: 'window', ctx: { question: true } }).kind).toBe('unknown'); // director проверит ответ загадки
  });

  it('«слушаю всегда»: непонятое подряд — не чаще раза в 4 с (разговор взрослых рядом)', () => {
    const now = 100_000;
    expect(verdict({ text: 'мяу мяу', now, lastUnknownAt: now - 1000 })).toEqual({ kind: 'noise', why: 'rate' });
    expect(verdict({ text: 'мяу мяу', now, lastUnknownAt: now - UNKNOWN_GAP_MS - 1 }).kind).toBe('unknown');
    // команда — без ограничения
    expect(verdict({ text: 'сальто', now, lastUnknownAt: now - 100 }).kind).toBe('intent');
  });
});

describe('маршрутизация в действия кота', () => {
  it.each([
    ['сделай сальто', 'flip'],
    ['танцуй', 'dance'],
    ['расскажи шутку', 'joke'],
    ['что ты умеешь', 'help'],
    ['как тебя зовут', 'name_ask'],
    ['привет', 'hello'],
  ])('«%s» → реакция %s', (text, ev) => {
    expect(reacts(route(playing(), text).actions)).toEqual([ev]);
  });

  it('загадка → диалог: кот загадывает и слушает ответ', () => {
    const r = route(playing(), 'загадай загадку');
    expect(says(r.actions)).toContain('riddle');
    expect(r.state.dialog?.id).toBe('riddle');
    expect(r.actions.some((a) => a.type === 'listen')).toBe(true);
  });

  it('непонятое: переспросить → «я пока умею…» + подсказки → снова переспросить', () => {
    let s = playing();
    const seq: string[] = [];
    let chips = false;
    for (const t of ['мяу мяу', 'бла бла кря', 'абырвалг']) {
      const r = route(s, t);
      s = r.state;
      seq.push(...reacts(r.actions));
      chips ||= r.actions.some((a) => a.type === 'ui' && a.ui === 'chips' && a.show);
    }
    expect(seq).toEqual(['unknown', 'help', 'unknown']);
    expect(chips).toBe(true);
    expect([1, 2, 3, 4].map(unknownReply)).toEqual(['unknown', 'help', 'unknown', 'help']);
  });

  it('понятая команда сбрасывает серию непонятого', () => {
    let s = route(playing(), 'мяу мяу').state;
    s = route(s, 'сальто').state;
    expect(s.unknownStreak).toBe(0);
    expect(reacts(route(s, 'мяу мяу').actions)).toEqual(['unknown']);
  });

  it('«давай» на вопрос кота вне диалога — короткий ответ, а не молчание', () => {
    expect(reacts(route(playing(), 'давай', true).actions)).toEqual(['yes']);
    expect(reacts(route(playing(), 'нет', true).actions)).toEqual(['no']);
  });
});

describe('грамматика Vosk: что реально скажет ребёнок', () => {
  const g = new Set(grammarPhrases());
  it('ответы загадок всех характеров (иначе «огурец» → [unk] и ответ не засчитывается)', () => {
    for (const w of ['огурец', 'лампочка', 'капуста', 'медведь', 'мишка', 'ножницы', 'кошка', 'лук', 'река', 'часы']) expect(g.has(w)).toBe(true);
    expect(riddleWords().length).toBeGreaterThan(40);
  });
  it('синонимы команд и частые фразы', () => {
    for (const p of ['что ты умеешь', 'давай поиграем', 'как тебя звать', 'сделай сальто', 'расскажи шутку', 'как дела', 'мяу', 'да', 'нет', 'не знаю', '[unk]']) expect(g.has(p)).toBe(true);
  });
  it('слова с «ё» — в обоих написаниях', () => {
    expect(g.has('блестка')).toBe(true);
    expect(g.has('блёстка')).toBe(true);
    expect(g.has('ёлка')).toBe(true);
  });
  it('без основ слов (их нет в словаре модели)', () => {
    expect(g.has('жвачк')).toBe(false);
    expect([...g].some((p) => p.includes('*'))).toBe(false);
  });
});

describe('правила тишины: когда кот говорит сам', () => {
  const O = INITIATIVE_DEFAULTS;
  const env = (o: Partial<InitiativeEnv>): InitiativeEnv => ({ now: 0, userSpeaking: false, lastUserAt: -1e9, lastQuestionAt: -1e9, busy: false, blocked: false, ...o });
  const gate = () => new InitiativeGate(O, () => 0, 0); // без случайной добавки: интервал ровно minGapMs

  it('в покое — не чаще раза в 15–20 с', () => {
    const g = gate();
    expect(g.allowed(env({ now: O.minGapMs - 1 }))).toBe(false);
    expect(g.allowed(env({ now: O.minGapMs }))).toBe(true);
    g.fired(O.minGapMs);
    expect(g.allowed(env({ now: O.minGapMs * 2 - 1 }))).toBe(false);
    expect(g.allowed(env({ now: O.minGapMs * 2 }))).toBe(true);
    const r = new InitiativeGate(O, () => 0.999, 0);
    expect(r.allowed(env({ now: O.minGapMs + 1000 }))).toBe(false);
    expect(r.allowed(env({ now: O.minGapMs + O.jitterMs }))).toBe(true);
    expect(O.minGapMs).toBeGreaterThanOrEqual(12_000);
    expect(O.minGapMs + O.jitterMs).toBeLessThanOrEqual(20_000);
  });

  it('ребёнок говорит — кот не начинает', () => {
    expect(gate().allowed(env({ now: 60_000, userSpeaking: true }))).toBe(false);
  });

  it('после фразы или касания ребёнка — пауза', () => {
    const g = gate();
    expect(g.allowed(env({ now: 60_000, lastUserAt: 60_000 - O.afterUserMs + 500 }))).toBe(false);
    expect(g.allowed(env({ now: 60_000, lastUserAt: 60_000 - O.afterUserMs }))).toBe(true);
  });

  it('после вопроса кота ждём ответ дольше, чем после обычной реплики', () => {
    expect(O.afterQuestionMs).toBeGreaterThan(O.afterCatMs);
    const g = gate();
    g.catLine(50_000);
    expect(g.allowed(env({ now: 50_000 + O.afterCatMs }))).toBe(true);
    expect(g.allowed(env({ now: 50_000 + O.afterCatMs, lastQuestionAt: 50_000 }))).toBe(false);
    expect(g.allowed(env({ now: 50_000 + O.afterQuestionMs, lastQuestionAt: 50_000 }))).toBe(true);
  });

  it('пока кот говорит, идёт диалог или поддержка — нельзя', () => {
    expect(gate().allowed(env({ now: 60_000, busy: true }))).toBe(false);
    expect(gate().allowed(env({ now: 60_000, blocked: true }))).toBe(false);
    expect(gate().waitMs(env({ now: 60_000, blocked: true }))).toBe(Infinity);
  });
});

describe('очередь слова (turn)', () => {
  it('голос по VAD блокирует кота, но не навсегда; фраза/касание откладывают инициативу', async () => {
    const { turn } = await import('../src/voice/turn');
    turn.reset();
    turn.userStart(1000);
    expect(turn.get(2000).userSpeaking).toBe(true);
    expect(turn.get(1000 + 9000).userSpeaking).toBe(false); // конец фразы потерялся — не держим
    turn.userStart(20_000);
    turn.userEnd();
    expect(turn.get(20_500).userSpeaking).toBe(false);
    expect(turn.get().lastUserAt).toBe(-1e9); // шум/голос без фразы не считается разговором
    turn.userActivity(30_000);
    expect(turn.get(30_001).lastUserAt).toBe(30_000);
    expect(turn.get(30_001).lastTouchAt).toBe(30_000);
    turn.reset();
  });
});

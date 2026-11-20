import { classifyUtterance } from '../src/voice/utterance';
import { isBad } from '../src/voice/badWords';
import { describe, it, expect } from 'vitest';
import { matchIntent, parseIntent, stem, lev, grammarPhrases, NAMES, isNameLead, answerWords } from '../src/voice/intents';

const m = (s: string, c = {}) => matchIntent(s, c).intent;

// по 3 фразы на каждый интент словаря content/intents.ru.json — как скажет ребёнок, не дословно
const CASES: Record<string, string[]> = {
  sad: ['мне так грустно', 'я плачу', 'меня обидели в школе'],
  scared: ['мне страшно', 'я боюсь темноты', 'мне жутко'],
  echo_stop: ['хватит повторять', 'не повторяй за мной', 'стоп'],
  echo_start: ['повторяй за мной', 'повтори что я скажу', 'давай ты будешь попугай'],
  bye: ['пока котик', 'до свидания', 'мне пора'],
  hello: ['привет', 'приветик котик', 'доброе утро'],
  money: ['как накопить денег', 'хочу копилку', 'сколько стоит велосипед'],
  sberkids: ['отведи к брату', 'хочу в сбер кидс', 'пошли в приложение'],
  brother_ask: ['кто твой брат', 'у тебя есть брат', 'где сберкот'],
  name_ask: ['как тебя зовут', 'ты кто такой', 'как твоё имя'],
  age_ask: ['сколько тебе лет', 'ты взрослый', 'ты маленький или большой'],
  choose_hooligan: ['будь хулиганом', 'хулиган', 'хочу дерзкого'],
  choose_kind: ['будь добряком', 'добряк', 'хочу добрым'],
  choose_glitter: ['будь блёсткой', 'блестяшка', 'хочу принцессу'],
  switch: ['переоденься', 'смени образ', 'стань другим'],
  flip: ['сделай сальто', 'кувыркнись', 'перевернись'],
  jump: ['прыгни', 'попрыгай', 'подпрыгни высоко'],
  dance: ['танцуй', 'потанцуй со мной', 'давай танцевать'],
  sit: ['сядь', 'присядь', 'садись'],
  wave: ['помаши лапой', 'дай пять', 'дай лапу'],
  sing: ['спой песенку', 'спой песню', 'пой'],
  gum: ['надуй пузырь', 'покажи фишку', 'мыльные пузыри'],
  stickers: ['наклейку хочу', 'дай стикер', 'заклей экран'],
  riddle: ['загадай загадку', 'загадку', 'давай загадку'],
  joke: ['расскажи шутку', 'пошути', 'рассмеши меня'],
  bored: ['мне скучно', 'скукота', 'нечего делать'],
  compliment: ['ты классный', 'я люблю тебя', 'ты самый лучший'],
  rude: ['ты дурак', 'тупой кот', 'заткнись'],
  thanks: ['спасибо', 'спасибки', 'благодарю'],
  skip: ['дальше', 'пропусти', 'следующий'],
};

describe('интенты: по 3 фразы на интент', () => {
  for (const [intent, phrases] of Object.entries(CASES))
    it.each(phrases)(`«%s» → ${intent}`, (p) => expect(m(p)).toBe(intent));
});

describe('интенты: детские ошибки и ошибки распознавания', () => {
  it.each([
    ['сделай сальта', 'flip'],
    ['таньцуй', 'dance'],
    ['потонцуй', 'dance'],
    ['прыгай прыгай', 'jump'],
    ['загадай загадку', 'riddle'],
    ['расскажи шуку', 'joke'],
    ['привед', 'hello'],
    ['спой пестню', 'sing'],
    ['покажи жвачку', 'gum'],
    ['хачу накпить', 'money'], // «накопить» с одной ошибкой
    ['бла бла кря', 'unknown'],
  ])('«%s» → %s', (p, i) => expect(m(p)).toBe(i));
});

describe('интенты: контекст и приоритеты', () => {
  it('да/нет — только после вопроса кота', () => {
    expect(m('да')).toBe('unknown');
    expect(m('да', { question: true })).toBe('yes');
    expect(m('неа', { question: true })).toBe('no');
    expect(m('не хочу', { question: true })).toBe('no');
    expect(m('угу давай', { question: true })).toBe('yes');
  });
  it('безопасность первой: грусть важнее танца', () => {
    expect(m('мне грустно давай потанцуем')).toBe('sad');
    expect(m('я боюсь но сделай сальто')).toBe('scared');
  });
  it('отрицание: «не танцуй» — не dance', () => {
    expect(m('не танцуй')).not.toBe('dance');
  });
  it('ожидаемый интент выигрывает при равенстве', () => {
    expect(matchIntent('давай', { question: true, expect: ['yes'] }).confidence).toBe(1);
    expect(m('танцуй сальто', { expect: ['flip'] })).toBe('flip');
  });
  it('низкая уверенность → unknown', () => {
    const r = matchIntent('абракадабра');
    expect(r.intent).toBe('unknown');
    expect(r.confidence).toBeLessThan(0.6);
  });
  it('имя: по фразе, из словаря, отказ', () => {
    expect(matchIntent('меня зовут тема')).toMatchObject({ intent: 'name', name: 'Тёма', known: true });
    // «я X» / «это X» — имя только в окне имени
    expect(matchIntent('я Гоша', { expectName: true })).toMatchObject({ intent: 'name', name: 'Гоша', known: true });
    expect(matchIntent('я Гоша').intent).not.toBe('name');
    expect(matchIntent('это Гоша').intent).not.toBe('name');
    // одиночное слово не из словаря — не имя, а «Тебя зовут Зигфрид?» (VoiceEngine.nameStep)
    expect(matchIntent('Зигфрид', { expectName: true })).toMatchObject({ intent: 'unknown', confirmName: 'Зигфрид' });
    expect(m('не скажу', { expectName: true })).toBe('skip');
    expect(m('секрет', { expectName: true })).toBe('skip');
    expect(m('мне грустно', { expectName: true })).toBe('sad');
  });
  it('parseIntent: change_persona → switch для автомата сценария', () => {
    expect(parseIntent('переоденься').type).toBe('switch');
  });
});

describe('окно имени (аудит голоса 20.11)', () => {
  const ctx = { expectName: true, question: true };
  it.each(['меня', 'зовут', 'ну', 'да', 'ага', 'это'])('«%s» — не имя', (w) => {
    const r = matchIntent(w, ctx);
    expect(r.intent).not.toBe('name');
    expect(r.confirmName).toBeUndefined();
  });
  it('«меня зовут» без имени — начало ответа (слушаем дальше)', () => {
    expect(isNameLead('меня зовут')).toBe(true);
    expect(isNameLead('ну меня зовут')).toBe(true);
    expect(isNameLead('я')).toBe(true);
    expect(isNameLead('меня зовут Маша')).toBe(false);
    expect(matchIntent('меня зовут', ctx).intent).not.toBe('name');
  });
  it('«да» в окне имени — да, а не имя «Да»', () => expect(matchIntent('да', ctx).intent).toBe('yes'));
  it('имя из словаря — сразу; с «ё» в грамматике обе формы', () => {
    expect(matchIntent('Пётр', ctx)).toMatchObject({ intent: 'name', name: 'Пётр', known: true });
    expect(matchIntent('Алена', ctx)).toMatchObject({ intent: 'name', name: 'Алёна', known: true });
    const g = grammarPhrases();
    for (const n of ['петр', 'пётр', 'алена', 'алёна', 'лева', 'лёва']) expect(g).toContain(n);
  });
});

describe('отрицание в середине фразы (sad/scared)', () => {
  it.each(['мне не грустно', 'мне не страшно', 'мне совсем не грустно'])('«%s» — не безопасность', (s) => {
    expect(['sad', 'scared']).not.toContain(matchIntent(s).intent);
  });
  it.each([['мне грустно', 'sad'], ['мне очень грустно', 'sad'], ['мне страшно', 'scared']])('«%s» → %s', (s, i) => expect(matchIntent(s).intent).toBe(i));
});

describe('короткие ответы в открытом диалоге (utterance.ts)', () => {
  const base = { unk: 0, now: 100_000, lastUnknownAt: -1e9 } as const;
  it('«да», «нет», «сдаюсь» короче 300 мс в окне ответа — интент, не шум', () => {
    for (const text of ['да', 'нет', 'сдаюсь'])
      expect(classifyUtterance({ ...base, text, speechMs: 180, reason: 'vad', ctx: { question: true } }).kind, text).toBe('intent');
  });
  it('ответ загадки из ключей короче порога — не шум', () => {
    const ctx = { question: true, answers: answerWords() };
    const w = [...answerWords()][0];
    expect(classifyUtterance({ ...base, text: w, speechMs: 150, reason: 'window', ctx }).kind).not.toBe('noise');
    // без ключей — по-прежнему шум по длине
    expect(classifyUtterance({ ...base, text: 'абв', speechMs: 150, reason: 'window', ctx: { question: true } }).kind).toBe('noise');
  });
});

describe('мат в повторялке (badWords.ts)', () => {
  it('корни ловятся, обычные слова — нет', () => {
    for (const w of ['блять', 'сука', 'нахуй', 'пиздец', 'жопа', 'дурак']) expect(isBad(w), w).toBe(true);
    for (const w of ['тебе', 'привет', 'кот', 'мудрый', 'страна', 'дурачиться весело'.split(' ')[1]]) expect(isBad(w), w).toBe(false);
  });
});

describe('утилиты', () => {
  it('stem/lev', () => {
    expect(stem('танцуй')).toBe(stem('танцуйте').slice(0, stem('танцуй').length));
    expect(lev('сальто', 'сальта')).toBe(1);
    expect(lev('сальто', 'кувырок')).toBeGreaterThan(1);
  });
  it('грамматика Vosk: фразы, имена, [unk], без основ', () => {
    const g = grammarPhrases();
    expect(g).toContain('сделай трюк');
    expect(g).toContain('[unk]');
    expect(g).toContain('саша');
    expect(g).not.toContain('жвачк');
    expect(NAMES.size).toBeGreaterThan(100);
  });
});

import { describe, it, expect } from 'vitest';
import { matchIntent, parseIntent, stem, lev, grammarPhrases, NAMES } from '../src/voice/intents';

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
    expect(matchIntent('я Гоша')).toMatchObject({ intent: 'name', name: 'Гоша', known: true });
    expect(matchIntent('Зигфрид', { expectName: true })).toMatchObject({ intent: 'name', name: 'Зигфрид', known: false });
    expect(m('не скажу', { expectName: true })).toBe('skip');
    expect(m('секрет', { expectName: true })).toBe('skip');
    expect(m('мне грустно', { expectName: true })).toBe('sad');
  });
  it('parseIntent: change_persona → switch для автомата сценария', () => {
    expect(parseIntent('переоденься').type).toBe('switch');
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

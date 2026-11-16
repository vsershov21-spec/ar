import { describe, it, expect } from 'vitest';
import { parseIntent } from '../src/voice/intents';

const t = (s: string, o?: { expectName?: boolean; question?: boolean }) => parseIntent(s, o).type;

describe('разбор намерений', () => {
  it.each([
    ['Сделай сальто!', 'flip'],
    ['а можешь кувыркнуться', 'flip'],
    ['Загадай загадку', 'riddle'],
    ['загадку!', 'riddle'],
    ['Танцуй', 'dance'],
    ['давай потанцуем', 'dance'],
    ['Привет, котик', 'hello'],
    ['Здравствуй', 'hello'],
    ['Сколько у меня денег?', 'money'],
    ['какой баланс', 'money'],
    ['сколько на карте', 'money'],
    ['Давай другого', 'switch'],
    ['смени характер', 'switch'],
    ['расскажи шутку', 'joke'],
    ['пропустить', 'skip'],
    ['абракадабра', 'unknown'],
  ])('«%s» → %s', (s, type) => expect(t(s)).toBe(type));

  it('имя по фразе', () => {
    expect(parseIntent('Меня зовут Маша')).toMatchObject({ type: 'name', name: 'Маша', known: true });
    expect(parseIntent('моё имя Тимур')).toMatchObject({ type: 'name', name: 'Тимур' });
  });
  it('одиночное слово — имя только когда ждём имя', () => {
    // имя из словаря возвращается в словарном написании (с «ё»)
    expect(parseIntent('Лёва', { expectName: true })).toMatchObject({ type: 'name', name: 'Лёва', known: true });
    expect(t('Лёва')).toBe('unknown');
  });
  it('«давай другого» не путается с «давай» = да', () => {
    expect(t('давай другого')).toBe('switch');
    // «да/давай» — только в окне ответа на вопрос кота (context: only_after_question)
    expect(t('давай', { question: true })).toBe('yes');
    expect(t('давай')).toBe('unknown');
  });
  it('пустая строка', () => expect(t('   ')).toBe('unknown'));
});

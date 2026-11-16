import { describe, it, expect } from 'vitest';
import { parseIntent } from '../src/voice/intents';

const t = (s: string, o?: { expectName?: boolean }) => parseIntent(s, o).type;

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
    expect(parseIntent('Меня зовут Маша')).toEqual({ type: 'name', name: 'Маша' });
    expect(parseIntent('моё имя Тимур')).toEqual({ type: 'name', name: 'Тимур' });
  });
  it('одиночное слово — имя только когда ждём имя', () => {
    expect(parseIntent('Лёва', { expectName: true })).toEqual({ type: 'name', name: 'Лева' });
    expect(t('Лёва')).toBe('unknown');
  });
  it('«давай другого» не путается с «давай» = да', () => {
    expect(t('давай другого')).toBe('switch');
    expect(t('давай')).toBe('yes');
  });
  it('пустая строка', () => expect(t('   ')).toBe('unknown'));
});

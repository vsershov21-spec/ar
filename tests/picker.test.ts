import { describe, it, expect } from 'vitest';
import { NoRepeatPicker } from '../src/persona/linePicker';

describe('неповторяющиеся реплики', () => {
  it('никогда не повторяет вариант подряд (n=3)', () => {
    const p = new NoRepeatPicker();
    let prev = -1;
    for (let i = 0; i < 500; i++) {
      const idx = p.pickIndex('tap', 3);
      expect(idx).not.toBe(prev);
      prev = idx;
    }
  });
  it('при n=3 и памяти 2 — строгая ротация, каждый раз в 3 шага', () => {
    const p = new NoRepeatPicker(2);
    const seq = Array.from({ length: 30 }, () => p.pickIndex('k', 3));
    for (let i = 3; i < seq.length; i++) expect(seq[i]).toBe(seq[i - 3]);
  });
  it('n=2 — чередование', () => {
    const p = new NoRepeatPicker();
    const seq = Array.from({ length: 10 }, () => p.pickIndex('k', 2));
    for (let i = 1; i < seq.length; i++) expect(seq[i]).not.toBe(seq[i - 1]);
  });
  it('ключи независимы, n=1 и n=0', () => {
    const p = new NoRepeatPicker();
    expect(p.pickIndex('a', 1)).toBe(0);
    expect(p.pickIndex('a', 1)).toBe(0);
    expect(p.pickIndex('b', 0)).toBe(-1);
    expect(p.pick('c', ['x'])).toBe('x');
  });
  it('все варианты используются', () => {
    const p = new NoRepeatPicker();
    const seen = new Set(Array.from({ length: 60 }, () => p.pickIndex('k', 5)));
    expect(seen.size).toBe(5);
  });
});

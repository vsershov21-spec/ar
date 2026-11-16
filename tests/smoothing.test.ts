import { describe, it, expect } from 'vitest';
import { OneEuro } from '../src/tracker/smoothing';

describe('One Euro', () => {
  it('гасит дрожание на неподвижной карте', () => {
    const f = new OneEuro(1, 0.02);
    let maxDev = 0;
    for (let i = 0; i < 200; i++) {
      const v = f.filter(10 + (i % 2 ? 0.5 : -0.5), i / 30);
      if (i > 30) maxDev = Math.max(maxDev, Math.abs(v - 10));
    }
    expect(maxDev).toBeLessThan(0.25);
  });
  it('догоняет быстрое движение', () => {
    const f = new OneEuro(1, 0.05);
    let v = 0;
    for (let i = 0; i < 30; i++) v = f.filter(i * 50, i / 30);
    expect(Math.abs(v - 29 * 50)).toBeLessThan(150);
  });
});

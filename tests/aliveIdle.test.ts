/** «Живой» покой Блёстки (aliveIdle.ts): перенос веса, позы рук по кругу, плавность. */
import { describe, it, expect } from 'vitest';
import { ARM_POSES, alivePose, poseDur } from '../src/character/aliveIdle';

describe('живой покой', () => {
  it('веса поз рук в сумме 1, позы сменяются по кругу и все встречаются', () => {
    const seen = new Set<string>();
    for (let t = 0; t < 40; t += 1 / 30) {
      const f = alivePose(t);
      const sum = Object.values(f.arms).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1, 5);
      for (const [k, v] of Object.entries(f.arms)) if (v > 0.99) seen.add(k);
    }
    expect([...seen].sort()).toEqual([...new Set(ARM_POSES)].sort());
    for (let i = 0; i < 20; i++) expect(poseDur(i)).toBeGreaterThanOrEqual(3.5);
  });
  it('перенос веса с ноги на ногу: таз заметно уходит в обе стороны, без рывков (кадр 1/30 с)', () => {
    let prev = alivePose(0), mn = 0, mx = 0;
    for (let t = 1 / 30; t < 12; t += 1 / 30) {
      const f = alivePose(t);
      mn = Math.min(mn, f.hipX);
      mx = Math.max(mx, f.hipX);
      expect(Math.abs(f.hipX - prev.hipX)).toBeLessThan(0.004);
      expect(Math.abs(f.headRoll - prev.headRoll)).toBeLessThan(0.03);
      for (const k of Object.keys(f.arms) as (keyof typeof f.arms)[]) expect(Math.abs(f.arms[k] - prev.arms[k])).toBeLessThan(0.1);
      prev = { ...f, arms: { ...f.arms } };
    }
    // заметно, но без «желе» в коленях (23.11): таз вбок ≈ 0,8 % роста и не опускается — колени держит клип
    expect(mx).toBeGreaterThan(0.006);
    expect(mn).toBeLessThan(-0.006);
    expect(mx).toBeLessThan(0.01);
    for (let t = 0; t < 12; t += 0.1) expect(alivePose(t).hipDown).toBe(0);
  });
});

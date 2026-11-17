import { describe, it, expect } from 'vitest';
import { EnergyBudget, defaultPixelRatio } from '../src/core/energy';
import { AdaptiveQuality } from '../src/core/perf';

const base = { catVisible: true, action: false, talking: false, locked: true, trouble: false };

/** прогнать бюджет по кадрам 60 Гц, вернуть, сколько кадров он пропустил к исполнению */
function runFrames(e: EnergyBudget, ms: number, t0: number, inp: Partial<typeof base> = {}) {
  let n = 0;
  for (let t = t0; t < t0 + ms; t += 1000 / 60) {
    e.update({ ...base, ...inp, now: t });
    if (e.due(t)) n++;
  }
  return n;
}

describe('энергобюджет', () => {
  it('по умолчанию 30 к/с; быстрое действие — 60; покой — 20; после 60 с простоя — дрёма 12', () => {
    const e = new EnergyBudget({ enabled: true, now: 0 });
    e.gyroSample(10, 0); // рука чуть дрожит
    expect(e.update({ ...base, now: 10 }).mode).toBe('normal');
    expect(runFrames(e, 1000, 20)).toBeGreaterThanOrEqual(29);
    expect(runFrames(e, 1000, 1020)).toBeLessThanOrEqual(31);
    expect(runFrames(e, 1000, 2020, { action: true })).toBeGreaterThanOrEqual(58);
    // телефон лёг на стол
    for (let i = 0; i < 40; i++) e.gyroSample(0.5, 3000 + i * 16);
    e.update({ ...base, now: 3100 });
    expect(e.update({ ...base, now: 4700 }).mode).toBe('calm');
    expect(runFrames(e, 1000, 4700)).toBeLessThanOrEqual(21);
    expect(e.update({ ...base, now: 70000 }).mode).toBe('doze');
    expect(e.out.renderFps).toBe(12);
    expect(e.out.trackerHz).toBe(5);
    e.activity(70010);
    expect(e.update({ ...base, now: 70020 }).mode).toBe('boost');
  });

  it('речь кота не даёт уйти в покой (рот — не реже 30 к/с)', () => {
    const e = new EnergyBudget({ enabled: true, now: 0 });
    e.gyroSample(0, 0);
    e.update({ ...base, now: 0 });
    expect(e.update({ ...base, now: 5000, talking: true }).mode).toBe('normal');
  });

  it('трекер: до посадки — без потолка; посажен и ровно — 15 Гц; движение/проблемы — снова полная частота', () => {
    const e = new EnergyBudget({ enabled: true, now: 0 });
    e.gyroSample(10, 0);
    expect(e.update({ ...base, locked: false, now: 100 }).trackerHz).toBe(0);
    expect(e.update({ ...base, now: 200 }).trackerHz).toBe(15);
    e.gyroSample(60, 300);
    expect(e.update({ ...base, now: 310 }).trackerHz).toBe(0);
    // через секунду после рывка (гироскоп успокоился) — снова 15
    for (let i = 0; i < 60; i++) e.gyroSample(8, 320 + i * 16);
    expect(e.update({ ...base, now: 1400 }).trackerHz).toBe(15);
    expect(e.update({ ...base, now: 1500, trouble: true }).trackerHz).toBe(0);
  });

  it('быстрое движение карты по экрану поднимает трекер даже без гироскопа', () => {
    const e = new EnergyBudget({ enabled: true, now: 0 });
    e.quadSample(1.2);
    expect(e.update({ ...base, now: 100 }).trackerHz).toBe(0);
  });

  it('выключен (ПК, ?energy=0) — как раньше: каждый кадр, трекер без потолка; ?fps=N — фиксированно', () => {
    const off = new EnergyBudget({ enabled: false, now: 0 });
    expect(runFrames(off, 1000, 0)).toBeGreaterThanOrEqual(59);
    expect(off.out.trackerHz).toBe(0);
    const f = new EnergyBudget({ enabled: false, fixedFps: 30, now: 0 });
    expect(runFrames(f, 1000, 0)).toBeLessThanOrEqual(31);
  });

  it('шаг анимаций не обрезается ниже интервала кадра (дрёма 12 к/с — не замедленная съёмка)', () => {
    const e = new EnergyBudget({ enabled: true, now: 0 });
    e.update({ ...base, now: 70000 });
    expect(e.maxDt).toBeGreaterThanOrEqual(1 / 12);
    e.update({ ...base, now: 70001, action: true });
    expect(e.maxDt).toBe(0.05);
  });

  it('pixelRatio: iPhone (dpr 3) — 1,5…2 по размеру экрана, ПК — до 2', () => {
    const p15 = defaultPixelRatio(390, 844, 3, true);
    expect(p15).toBeGreaterThanOrEqual(1.5);
    expect(p15).toBeLessThan(2);
    expect(defaultPixelRatio(430, 932, 3, true)).toBeGreaterThanOrEqual(1.5);
    expect(defaultPixelRatio(375, 667, 2, true)).toBe(2);
    expect(defaultPixelRatio(1440, 900, 2, false)).toBe(2);
    expect(defaultPixelRatio(390, 844, 1, true)).toBe(1);
  });
});

describe('адаптивное качество под потолком энергобюджета', () => {
  it('30 к/с по бюджету — не «тормоза»: уровень не снижается', () => {
    const q = new AdaptiveQuality(null);
    for (let i = 0; i < 30 * 12; i++) q.tick(1 / 30, 30);
    expect(q.level).toBe(0);
  });
  it('под потолком 30 реально 18 к/с — снижает', () => {
    const q = new AdaptiveQuality(null);
    for (let i = 0; i < 18 * 12; i++) q.tick(1 / 18, 30);
    expect(q.level).toBeGreaterThan(0);
  });
});

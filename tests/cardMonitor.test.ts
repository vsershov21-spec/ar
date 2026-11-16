import { describe, it, expect } from 'vitest';
import { CardMonitor } from '../src/tracker/cardMonitor';

describe('карта и свет', () => {
  it('card_far: < 12% ширины дольше 2 с — один раз, снова после возврата', () => {
    const ev: string[] = [];
    const m = new CardMonitor((e) => ev.push(e));
    for (let i = 0; i < 19; i++) m.card(0.1, 100);
    expect(ev).toEqual([]);
    for (let i = 0; i < 30; i++) m.card(0.1, 100);
    expect(ev).toEqual(['card_far']);
    m.card(0.3, 100);
    for (let i = 0; i < 21; i++) m.card(0.08, 100);
    expect(ev).toEqual(['card_far', 'card_far']);
  });
  it('card_close: > 90% дольше 2 с; потеря карты сбрасывает счёт', () => {
    const ev: string[] = [];
    const m = new CardMonitor((e) => ev.push(e));
    for (let i = 0; i < 15; i++) m.card(0.95, 100);
    m.card(null, 100);
    for (let i = 0; i < 15; i++) m.card(0.95, 100);
    expect(ev).toEqual([]);
    for (let i = 0; i < 6; i++) m.card(0.95, 100);
    expect(ev).toEqual(['card_close']);
  });
  it('low_light: темно 3 с (замеры раз в 500 мс)', () => {
    const ev: string[] = [];
    const m = new CardMonitor((e) => ev.push(e));
    for (let i = 0; i < 5; i++) m.light(20, 500);
    expect(ev).toEqual([]);
    m.light(20, 500);
    expect(ev).toEqual(['low_light']);
    m.light(45, 500); // в гистерезисе — не сброс
    for (let i = 0; i < 6; i++) m.light(20, 500);
    expect(ev).toEqual(['low_light']);
  });
});

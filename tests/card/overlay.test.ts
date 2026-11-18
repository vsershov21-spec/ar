// @vitest-environment jsdom
/**
 * Кот уже стоит на экране — никакого поискового интерфейса поверх него (запись продакта 18.11: кольцо,
 * пунктир, «Держи телефон ровно…» и зелёная рамка «нашёл» поверх морды кота при повторной посадке).
 */
import { describe, expect, it } from 'vitest';
import { CardOverlay } from '../../src/tracker/card/overlay';
import type { CardView } from '../../src/tracker/cardTracker';

const pts = [{ x: 100, y: 100 }, { x: 260, y: 100 }, { x: 260, y: 200 }, { x: 100, y: 200 }];
const view = (): CardView => ({ quad: pts as never, pose: { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, -3], err: 0 }, project: (x, y) => ({ x: 180 + x * 160, y: 150 - y * 160 }) });
type Peek = { cand: unknown; notCard: unknown; state: string; busy(): boolean };

describe('оверлей карты: кот на экране — без поискового интерфейса', () => {
  it('до первой посадки — кандидат с кольцом рисуется', () => {
    const o = new CardOverlay(document.createElement('div'));
    o.candidate(pts, 'sber');
    o.guide('candidate', 0.5, 'found');
    expect((o as unknown as Peek).cand).not.toBeNull();
    expect((o as unknown as Peek).busy()).toBe(true);
  });
  it('кот посажен (catPlaced) — кандидат, «не карта» и кольцо не рисуются', () => {
    const o = new CardOverlay(document.createElement('div'));
    o.catPlaced = true;
    o.candidate(pts, 'sber');
    o.candidate(pts, 'notcard');
    o.guide('candidate', 0.7, 'steady');
    const p = o as unknown as Peek;
    expect(p.cand).toBeNull();
    expect(p.notCard).toBeNull();
    expect(p.busy()).toBe(false);
  });
  it('повторная посадка, когда кот уже стоял, — без анимации «нашёл» (рамки поверх кота)', () => {
    const o = new CardOverlay(document.createElement('div'));
    o.track(view());
    expect((o as unknown as Peek).state).toBe('snap'); // первая посадка — с анимацией
    o.lost();
    o.forgetRecent();
    o.track(view(), true);
    expect((o as unknown as Peek).state).toBe('locked');
    expect((o as unknown as Peek).busy()).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { TouchInterpreter, defaultInterpreterConfig, type TouchEvent } from '../src/input/interpreter';
import { zoneFromUv } from '../src/character/zones';
import type { TouchZone } from '../src/character/types';

/** кот — прямоугольник 100..200 × 100..300; голова — верх (y<160), щёки — края головы, живот — середина */
const zoneAt = (x: number, y: number): TouchZone | null => {
  if (x < 100 || x > 200 || y < 100 || y > 300) return null;
  if (y < 160) return x < 120 || x > 180 ? 'cheek' : 'head';
  if (y > 270) return x > 180 ? 'tail' : 'paw';
  if (y > 190 && y < 250) return 'belly';
  return 'body';
};

const mk = () => {
  const ev: TouchEvent[] = [];
  const it = new TouchInterpreter((e) => ev.push(e), zoneAt);
  const tap = (x: number, y: number, t: number) => {
    it.down(x, y, t);
    it.up(x, y, t + 60);
    it.tick(t + 61);
  };
  const types = () => ev.filter((e) => e.type !== 'drag').map((e) => (e.type === 'tap_cat' ? e.event : e.type));
  return { ev, it, tap, types };
};

describe('зоны касания', () => {
  it('тап по голове, щеке, животу, лапе, хвосту, телу', () => {
    const { tap, types } = mk();
    tap(150, 120, 0); // голова
    tap(105, 130, 700); // щека
    tap(150, 220, 1400); // живот
    tap(130, 290, 2100); // лапа
    tap(190, 290, 2800); // хвост
    tap(150, 175, 3500); // тело
    expect(types()).toEqual(['tap_cat_head', 'tap_cat_cheek', 'tap_cat_belly', 'tap_cat_paw', 'tap_cat_tail', 'tap_cat']);
  });

  it('прямоугольники спрайта: щека раньше головы, вне зон — тело', () => {
    expect(zoneFromUv(0.2, 0.3)).toBe('cheek');
    expect(zoneFromUv(0.5, 0.2)).toBe('head');
    expect(zoneFromUv(0.5, 0.65)).toBe('belly');
    expect(zoneFromUv(0.9, 0.8)).toBe('tail');
    expect(zoneFromUv(0.05, 0.5)).toBe('paw');
    expect(zoneFromUv(0.5, 0.5)).toBe('body');
  });
});

describe('тычки', () => {
  it('3 тапа в одну зону за 2 с → poke_combo вместо третьего тычка', () => {
    const { tap, types } = mk();
    tap(150, 120, 0);
    tap(150, 120, 500);
    tap(150, 120, 1000);
    expect(types()).toEqual(['tap_cat_head', 'tap_cat_head', 'poke_combo']);
  });

  it('тапы в разные зоны — не комбо; пауза > 2 с сбрасывает счёт', () => {
    const { tap, types } = mk();
    tap(150, 120, 0);
    tap(150, 220, 400);
    tap(150, 120, 800);
    tap(150, 120, 3500);
    expect(types()).not.toContain('poke_combo');
  });

  it('резкий свайп по коту → poke_hard, потом 2 с тапы по коту игнорируются', () => {
    const { ev, it, tap, types } = mk();
    it.down(110, 200, 0);
    it.move(150, 200, 30);
    it.up(195, 200, 60); // 85 px за 60 мс ≈ 1400+ px/с
    expect(types()).toEqual(['poke_hard']);
    tap(150, 120, 500);
    expect(ev.at(-1)).toEqual({ type: 'ignored', reason: 'sulk' });
    tap(150, 120, 2200);
    expect(types().at(-1)).toBe('tap_cat_head');
  });
});

describe('глажка', () => {
  it('медленный свайп по коту > 80 px → stroke; > 4 с → stroke_long; отпустили → stroke_end', () => {
    const { it, types } = mk();
    it.down(110, 200, 0);
    let t = 0;
    // 20 px за 100 мс = 200 px/с — медленно; туда-сюда по коту 5 с
    for (let i = 1; i <= 50; i++) {
      t = i * 100;
      const x = 110 + ((i % 8) < 4 ? (i % 4) * 20 : (4 - (i % 4)) * 20);
      it.move(x, 200, t);
      it.tick(t);
    }
    it.up(110, 200, t + 10);
    expect(types()).toEqual(['stroke', 'stroke_long', 'stroke_end']);
  });

  it('медленно, но меньше 80 px — не глажка', () => {
    const { it, types } = mk();
    it.down(110, 200, 0);
    it.move(130, 200, 200);
    it.move(150, 200, 400);
    it.up(160, 200, 600);
    expect(types()).not.toContain('stroke');
  });

  it('глажка не превращается в свайп', () => {
    const { it, types } = mk();
    it.down(105, 200, 0);
    for (let i = 1; i <= 10; i++) it.move(105 + i * 9, 200, i * 60);
    it.up(195, 200, 620);
    expect(types()).not.toContain('swipe');
    expect(types()).toContain('stroke');
  });
});

describe('тапы мимо кота', () => {
  it('одиночный тап мимо кота → tap_screen после окна двойного тапа', () => {
    const { it, ev } = mk();
    it.down(20, 20, 0);
    it.up(20, 20, 50);
    it.tick(100);
    expect(ev.filter((e) => e.type === 'tap_screen')).toHaveLength(0);
    it.tick(400);
    expect(ev.filter((e) => e.type === 'tap_screen')).toHaveLength(1);
  });

  it('два тапа ≤ 300 мс и ≤ 40 px → double_tap (без tap_screen)', () => {
    const { it, types } = mk();
    it.down(20, 20, 0);
    it.up(20, 20, 50);
    it.down(30, 25, 200);
    it.up(30, 25, 250);
    it.tick(700);
    expect(types()).toEqual(['double_tap']);
  });

  it('два тапа далеко друг от друга — два tap_screen', () => {
    const { it, types } = mk();
    it.down(20, 20, 0);
    it.up(20, 20, 50);
    it.down(300, 500, 200);
    it.up(300, 500, 250);
    it.tick(700);
    expect(types()).toEqual(['tap_screen', 'tap_screen']);
  });

  it('долгое нажатие 0,6 с: onCat по зоне', () => {
    const { it, ev } = mk();
    it.down(150, 220, 0);
    it.tick(650);
    expect(ev.find((e) => e.type === 'longpress')).toMatchObject({ onCat: true });
  });
});

describe('антиспам', () => {
  it('5 тапов за 2 с → spam, следующие 3 с тапы игнорируются', () => {
    const { tap, types, ev } = mk();
    // чередуем зоны, чтобы не было комбо
    const pts: [number, number][] = [[150, 120], [150, 220], [130, 290], [150, 120], [150, 220]];
    pts.forEach(([x, y], i) => tap(x, y, i * 300));
    expect(types().at(-1)).toBe('spam');
    tap(150, 120, 2000);
    expect(ev.at(-1)).toEqual({ type: 'ignored', reason: 'spam' });
    tap(150, 120, 4400);
    expect(types().at(-1)).toBe('tap_cat_head');
  });

  it('пороги по ТЗ', () => {
    const c = defaultInterpreterConfig;
    expect([c.strokeMinPx, c.strokeLongMs, c.comboTaps, c.comboWindowMs, c.sulkMs, c.spamTaps, c.spamWindowMs, c.spamIgnoreMs]).toEqual([80, 4000, 3, 2000, 2000, 5, 2000, 3000]);
  });
});

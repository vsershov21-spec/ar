import { describe, it, expect } from 'vitest';
import { GestureRecognizer, SpamGuard, SilenceTimer, ShakeDetector, type GestureEvent } from '../src/input/gestures';

const rec = () => {
  const ev: GestureEvent[] = [];
  return { ev, g: new GestureRecognizer((e) => ev.push(e)) };
};

describe('жесты', () => {
  it('короткое касание без движения — тап', () => {
    const { ev, g } = rec();
    g.down(100, 100, 0);
    g.up(102, 101, 120);
    expect(ev.map((e) => e.type)).toEqual(['tap']);
  });

  it('удержание 0,6 с — долгое нажатие (срабатывает без отпускания)', () => {
    const { ev, g } = rec();
    g.down(50, 50, 0);
    g.tick(500);
    expect(ev).toHaveLength(0);
    g.tick(600);
    expect(ev.map((e) => e.type)).toEqual(['longpress']);
    g.up(50, 50, 1500);
    expect(ev.map((e) => e.type)).toEqual(['longpress', 'longpress_end']);
  });

  it('0,59 с — ещё не долгое, и не тап (слишком долго)', () => {
    const { ev, g } = rec();
    g.down(50, 50, 0);
    g.up(50, 50, 590);
    expect(ev.find((e) => e.type === 'longpress')).toBeUndefined();
  });

  it('движение отменяет долгое нажатие', () => {
    const { ev, g } = rec();
    g.down(0, 0, 0);
    g.move(40, 0, 100);
    g.tick(700);
    expect(ev.find((e) => e.type === 'longpress')).toBeUndefined();
  });

  it('свайп вправо: направление, скорость', () => {
    const { ev, g } = rec();
    g.down(10, 200, 0);
    for (let i = 1; i <= 10; i++) g.move(10 + i * 20, 200 + i, i * 15);
    g.up(210, 210, 150);
    const sw = ev.find((e) => e.type === 'swipe') as Extract<GestureEvent, { type: 'swipe' }>;
    expect(sw).toBeTruthy();
    expect(sw.dir).toBe('right');
    expect(sw.speed).toBeGreaterThan(1000);
  });

  it('свайп вверх', () => {
    const { ev, g } = rec();
    g.down(100, 400, 0);
    g.move(100, 300, 50);
    g.up(102, 200, 100);
    const sw = ev.find((e) => e.type === 'swipe') as any;
    expect(sw.dir).toBe('up');
  });

  it('медленное ведение пальцем — не свайп', () => {
    const { ev, g } = rec();
    g.down(0, 0, 0);
    g.move(50, 0, 1000);
    g.up(100, 0, 2000);
    expect(ev.find((e) => e.type === 'swipe')).toBeUndefined();
    expect(ev.some((e) => e.type === 'drag')).toBe(true);
  });
});

describe('антиспам', () => {
  it('5 тапов за 2 с → spam, затем 1 с игнора', () => {
    const s = new SpamGuard();
    expect([0, 300, 600, 900].map((t) => s.hit(t))).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(s.hit(1200)).toBe('spam');
    expect(s.hit(1500)).toBe('ignored');
    expect(s.hit(2150)).toBe('ignored');
    expect(s.hit(2250)).toBe('ok');
  });
  it('5 тапов за 2,5 с — не спам', () => {
    const s = new SpamGuard();
    const r = [0, 600, 1200, 1800, 2500].map((t) => s.hit(t));
    expect(r).not.toContain('spam');
  });
});

describe('тишина', () => {
  it('10 с без действий → один раз silence', () => {
    const t = new SilenceTimer(0);
    expect(t.check(9999)).toBe(false);
    expect(t.check(10000)).toBe(true);
    expect(t.check(15000)).toBe(false);
    t.activity(16000);
    expect(t.check(25999)).toBe(false);
    expect(t.check(26000)).toBe(true);
  });
});

describe('встряска', () => {
  it('три резких рывка подряд → shake, затем пауза', () => {
    const d = new ShakeDetector();
    let r = false;
    const seq = [0, 20, -5, 20, -5, 20, -5];
    seq.forEach((v, i) => (r = d.sample(v, 9.8, 0, i * 80) || r));
    expect(r).toBe(true);
    // сразу после — кулдаун
    expect(d.sample(20, 9.8, 0, 600)).toBe(false);
  });
  it('обычное покачивание телефона — нет', () => {
    const d = new ShakeDetector();
    let r = false;
    for (let i = 0; i < 50; i++) r = d.sample(Math.sin(i / 5) * 2, 9.8, 0, i * 16) || r;
    expect(r).toBe(false);
  });
});

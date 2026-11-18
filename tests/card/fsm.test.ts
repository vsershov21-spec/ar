import { describe, expect, it } from 'vitest';
import { CardFsm, CHECK_PATIENCE_MS, HOLD_AFTER_MS, HOLD_MS, LOST_MS, type Obs } from '../../src/tracker/card/fsm';

const good = (t: number, o: Partial<Obs> = {}): Obs => ({ t, found: true, mode: 'detect', err: 1, jitter: 0.01, size: 0.5, inFrame: 1, glare: 0, still: true, kind: 'sber', ...o });
const miss = (t: number): Obs => ({ t, found: false, mode: 'none' });

/** гоняет наблюдения каждые 66 мс (15 Гц) */
function run(f: CardFsm, from: number, to: number, o: (t: number) => Obs) {
  for (let t = from; t <= to; t += 66) f.observe(o(t));
}

describe('машина состояний трекера карты', () => {
  it('SEARCH → CANDIDATE → LOCKED: карта Сбера, телефон ровно ≈ 0,35–0,5 с', () => {
    const f = new CardFsm(true);
    expect(f.state).toBe('search');
    f.observe(good(0));
    expect(f.state).toBe('candidate');
    run(f, 66, 600, good);
    expect(f.state).toBe('locked');
    expect(f.verified).toBe(true);
    expect(f.log.map((e) => e.to)).toEqual(['candidate', 'locked']);
  });

  it('один плохой кадр не обнуляет прогресс (гистерезис)', () => {
    const f = new CardFsm(true);
    run(f, 0, 200, good);
    const p0 = f.progress;
    f.observe(good(266, { jitter: 0.2 }));
    expect(f.progress).toBeGreaterThan(p0 * 0.6);
    run(f, 332, 700, good);
    expect(f.state).toBe('locked');
  });

  it('короткий пропуск кандидата (< 0,45 с) — остаёмся кандидатом', () => {
    const f = new CardFsm(true);
    run(f, 0, 132, good);
    f.observe(miss(200));
    f.observe(miss(400));
    expect(f.state).toBe('candidate');
    f.observe(miss(700));
    expect(f.state).toBe('search');
    // медленный телефон (2–4 к/с): один пропущенный кадр через 0,9 с — ещё не «пропал»
    const g = new CardFsm(true);
    run(g, 0, 132, good);
    g.observe(miss(1000));
    expect(g.state).toBe('candidate');
  });

  it('знак не пойман — сажаем по форме после терпения, такого кота переверификация пересаживает', () => {
    const f = new CardFsm(true);
    run(f, 0, CHECK_PATIENCE_MS + 1200, (t) => good(t, { kind: 'checking' }));
    expect(f.state).toBe('locked');
    expect(f.verified).toBe(false);
    f.observe(good(CHECK_PATIENCE_MS + 1300, { mode: 'key', postNotCard: true }));
    expect(f.state).toBe('search');
  });

  it('кота на подтверждённой карте Сбера переверификация НЕ пересаживает (ложный reanchor)', () => {
    const f = new CardFsm(true);
    run(f, 0, 600, good);
    expect(f.verified).toBe(true);
    f.observe(good(700, { mode: 'key', postNotCard: true }));
    expect(f.state).toBe('locked');
  });

  it('чужая карта / оборот — не садимся, подсказка по причине', () => {
    const f = new CardFsm(true);
    run(f, 0, 3000, (t) => good(t, { kind: 'other' }));
    expect(f.state).toBe('candidate');
    expect(f.hint).toBe('other');
    expect(f.progress).toBeLessThan(0.2);
  });

  it('подсказки: ближе / дальше / блик / ровно — и не мигают', () => {
    const f = new CardFsm(true);
    run(f, 0, 1000, (t) => good(t, { size: 0.15, kind: 'checking' }));
    expect(f.hint).toBe('closer');
    // 1 кадр «блик» не перебивает подсказку
    f.observe(good(1066, { size: 0.15, glare: 0.3, kind: 'checking' }));
    expect(f.hint).toBe('closer');
    const g = new CardFsm(true);
    run(g, 0, 2000, (t) => good(t, { glare: 0.2, kind: 'checking' }));
    expect(g.hint).toBe('glare');
    const h = new CardFsm(true);
    run(h, 0, 2000, (t) => good(t, { inFrame: 0.75, kind: 'checking' }));
    expect(h.hint).toBe('farther');
    expect(h.state).toBe('candidate');
    const s = new CardFsm(true);
    run(s, 0, 2000, (t) => good(t, { still: false, kind: 'checking' }));
    expect(s.hint).toBe('steady');
  });

  it('LOCKED → HOLD → RELOCALIZE → LOST по времени; карта вернулась — снова LOCKED', () => {
    const f = new CardFsm(true);
    run(f, 0, 600, good);
    const t0 = f.seenAt;
    f.tick(t0 + HOLD_AFTER_MS - 50);
    expect(f.state).toBe('locked');
    f.tick(t0 + HOLD_AFTER_MS + 50);
    expect(f.state).toBe('hold');
    expect(f.anchored).toBe(true);
    f.tick(t0 + HOLD_MS + 50);
    expect(f.state).toBe('relocalize');
    expect(f.hintRadius(t0 + HOLD_MS + 50)).toBeGreaterThan(f.hintRadius(t0));
    f.observe(good(t0 + 3000, { mode: 'key' }));
    expect(f.state).toBe('locked');
    f.tick(t0 + 3000 + LOST_MS + 10);
    expect(f.state).toBe('lost');
    expect(f.anchored).toBe(false);
    // после потери — снова через кандидата (карта Сбера и ровно)
    run(f, t0 + 10000, t0 + 10600, good);
    expect(f.state).toBe('locked');
  });

  it('экранный прогресс: вверх быстро, вниз медленно', () => {
    const f = new CardFsm(true);
    run(f, 0, 200, (t) => good(t, { kind: 'checking' }));
    for (let i = 0; i < 30; i++) f.animate(1 / 60);
    const up = f.shown;
    expect(up).toBeGreaterThan(0.1);
    f.observe(good(266, { kind: 'checking', jitter: 0.3 }));
    f.animate(1 / 60);
    expect(f.shown).toBeGreaterThan(up - 0.02);
  });

  it('чередование «кадр поиска / пропуск» (тёмный стол) — посадка всё равно наступает', () => {
    const f = new CardFsm(true);
    let k = 0;
    run(f, 0, 1500, (t) => (k++ % 2 ? miss(t) : good(t)));
    expect(f.state).toBe('locked');
  });

  it('по форме (терпение) — только при намёке на знак Сбера: чужая карта без чипа не сажает кота', () => {
    const a = new CardFsm(true);
    run(a, 0, CHECK_PATIENCE_MS + 1500, (t) => good(t, { kind: 'checking', maybeSber: false }));
    expect(a.state).toBe('candidate');
    const b = new CardFsm(true);
    run(b, 0, CHECK_PATIENCE_MS + 1500, (t) => good(t, { kind: 'checking', maybeSber: true }));
    expect(b.state).toBe('locked');
    expect(b.verified).toBe(false);
  });
});

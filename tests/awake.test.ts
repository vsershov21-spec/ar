import { describe, expect, it } from 'vitest';
import { awakePlan } from '../src/awake/timeline';
import { MAX_PARTS, Salute, volleyPlan } from '../src/fx/salute';
import { PERSONA_IDS } from '../src/persona/types';

describe('пробуждение кота из карты: хореография', () => {
  for (const p of PERSONA_IDS) {
    it(`${p}: первая встреча 4–6 с, повтор ≈ 1,5 с`, () => {
      const f = awakePlan(p, 'first');
      expect(f.dur).toBeGreaterThanOrEqual(4);
      expect(f.dur).toBeLessThanOrEqual(6);
      expect(f.appearDoneMs / 1000).toBeLessThanOrEqual(f.dur);
      const s = awakePlan(p, 'short');
      expect(s.dur).toBeCloseTo(1.5, 1);
      expect(s.appearDoneMs).toBe(1500);
    });

    it(`${p}: порядок — свечение → ПУФ → приземление → салют и фанфары → глаза → машет`, () => {
      const f = awakePlan(p, 'first');
      const at = (pred: (e: (typeof f.events)[number]) => boolean) => f.events.find(pred)?.t ?? NaN;
      expect(f.glow(0.5)).toBeGreaterThan(0.9);
      expect(at((e) => e.type === 'pop')).toBe(f.tPop);
      expect(at((e) => e.type === 'land')).toBe(f.tLand);
      expect(at((e) => e.type === 'salute')).toBe(f.tLand);
      const fan = at((e) => e.type === 'sound' && e.id === `fanfare_${p}`);
      expect(Math.abs(fan - f.tLand)).toBeLessThan(0.1);
      const sleepy = at((e) => e.type === 'emotion' && e.name === 'sleepy');
      const surprised = at((e) => e.type === 'emotion' && e.name === 'surprised');
      const happy = at((e) => e.type === 'emotion' && e.name === 'happy');
      expect(sleepy).toBeGreaterThan(f.tLand);
      expect(surprised).toBeGreaterThan(sleepy);
      expect(happy).toBeGreaterThan(surprised);
      expect(at((e) => e.type === 'clip' && e.clip === 'wave')).toBe(happy);
      // события по времени
      for (let i = 1; i < f.events.length; i++) expect(f.events[i].t).toBeGreaterThanOrEqual(f.events[i - 1].t);
    });

    it(`${p}: кот невидим до ПУФ, выходит из-под карты с перелётом и стоит на карте после`, () => {
      const f = awakePlan(p, 'first');
      expect(f.pose(f.tPop - 0.01).scale).toBe(0);
      expect(f.pose(f.tPop + 0.001).lift).toBeLessThan(-0.5);
      let maxS = 0, maxL = 0;
      for (let t = f.tPop; t < f.tLand; t += 0.01) {
        maxS = Math.max(maxS, f.pose(t).scale);
        maxL = Math.max(maxL, f.pose(t).lift);
      }
      expect(maxS).toBeGreaterThan(1.02); // перелёт масштаба
      expect(maxL).toBeGreaterThan(0.2);
      const end = f.pose(f.dur);
      expect(end.lift).toBe(0);
      expect(end.scale).toBe(1);
      expect(Math.abs(end.squash)).toBeLessThan(0.01);
      expect(end.roll).toBe(0);
      // всё 3D погасло к концу
      expect(f.glow(f.dur)).toBe(0);
      expect(f.pillar(f.dur).k).toBe(0);
      expect(f.portal(f.dur)).toBeLessThan(0.01);
    });
  }

  it('образы различаются: Хулиган — сальто и скейт, Блёстка — вращение, Добряк — покачивание', () => {
    const h = awakePlan('hooligan', 'first'), g = awakePlan('glitter', 'first'), k = awakePlan('kind', 'first');
    const mid = (p: typeof h) => p.pose(p.tPop + (p.tLand - p.tPop) * 0.5);
    expect(Math.abs(mid(h).flip)).toBeGreaterThan(1);
    expect(h.skate(h.tPop + 0.1)).toBe(1);
    expect(Math.abs(mid(g).spin)).toBeGreaterThan(3);
    expect(g.skate(g.tPop + 0.1)).toBe(0);
    let sway = 0;
    for (let t = k.tPop; t < k.tLand; t += 0.02) sway = Math.max(sway, Math.abs(k.pose(t).roll));
    expect(sway).toBeGreaterThan(0.05);
  });
});

describe('салют', () => {
  it('3–5 залпов в большом, ≤ 600 частиц в пуле, ≈ 3 с и потом чисто', () => {
    const v = volleyPlan('big');
    expect(v.length).toBeGreaterThanOrEqual(3);
    expect(v.length).toBeLessThanOrEqual(5);
    const s = new Salute(null);
    s.resize(390, 844);
    s.faceFn = () => ({ x: 195, y: 420, r: 60 });
    s.start({ size: 'big', shapes: ['star', 'ring', 'heart', 'peony'] });
    let t = 0;
    while (s.active && t < 10) {
      s.update(1 / 60);
      t += 1 / 60;
    }
    expect(s.peak).toBeLessThanOrEqual(MAX_PARTS);
    expect(s.peak).toBeGreaterThan(200);
    expect(t).toBeGreaterThan(2.5);
    expect(t).toBeLessThan(3.8);
    expect(s.active).toBe(false);
    expect(s.live).toBe(0);
  });

  it('кот близко (морда на пол-экрана) — разрывы меньше и мимо морды', () => {
    const s = new Salute(null);
    s.resize(390, 844);
    const face = { x: 210, y: 380, r: 190 };
    s.faceFn = () => face;
    for (let n = 0; n < 20; n++) {
      s.stop();
      s.start({ size: 'big', shapes: ['peony'] });
      for (const v of (s as unknown as { volleys: { x: number; y: number; r: number }[] }).volleys)
        expect(Math.hypot(v.x - face.x, v.y - face.y)).toBeGreaterThan(face.r * 1.1 + v.r * 0.8);
    }
  });

  it('разрывы — не над мордой кота', () => {
    const s = new Salute(null);
    s.resize(390, 844);
    const face = { x: 195, y: 330, r: 70 };
    s.faceFn = () => face;
    for (let n = 0; n < 20; n++) {
      s.stop();
      s.start({ size: 'big', shapes: ['ring'] });
      for (const v of (s as unknown as { volleys: { x: number; y: number; r: number }[] }).volleys) {
        // круг разрыва не ложится на морду
        expect(Math.hypot(v.x - face.x, v.y - face.y)).toBeGreaterThan(face.r + v.r * 0.85);
      }
    }
  });
});

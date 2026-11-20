import { describe, expect, it } from 'vitest';
import { awakePlan } from '../../src/awake/timeline';
import { PERSONA_IDS } from '../../src/persona/types';

/**
 * Конец сцены пробуждения (записи 20.11: «кота трясёт в конце появления»): после приземления поза Stage.intro должна
 * плавно прийти к обычной (lift 0, scale 1, без крена) — без дрожи. Метрика рывка: наибольшая угловая скорость
 * крена и скорость сквоша после приземления + разрыв позы в момент конца сцены (intro → null).
 */
function jerk(p: ReturnType<typeof awakePlan>) {
  const dt = 1 / 60;
  let maxRollV = 0, maxRoll = 0;
  let prev = p.pose(p.tLand + 0.2);
  for (let t = p.tLand + 0.2 + dt; t <= p.dur; t += dt) {
    const q = p.pose(t);
    maxRollV = Math.max(maxRollV, Math.abs(q.roll - prev.roll) / dt);
    maxRoll = Math.max(maxRoll, Math.abs(q.roll));
    prev = q;
  }
  const end = p.pose(p.dur);
  const gap = Math.abs(end.lift) + Math.abs(end.scale - 1) + Math.abs(end.squash) + Math.abs(end.roll) + Math.abs(end.spin) + Math.abs(end.flip);
  return { maxRollV, maxRoll, gap };
}

describe('конец пробуждения без тряски', () => {
  for (const id of PERSONA_IDS)
    for (const kind of ['first', 'short'] as const) {
      it(`${id} ${kind}: крен после приземления ≤ 0,08 рад и ≤ 2,5 рад/с; поза в конце = обычная`, () => {
        const j = jerk(awakePlan(id, kind));
        // было (первая встреча): 0,17 рад и ≈ 9 рад/с — 8,5 Гц «дрожь»
        expect(j.maxRoll).toBeLessThanOrEqual(0.08);
        expect(j.maxRollV).toBeLessThanOrEqual(2.5);
        expect(j.gap).toBeLessThan(0.01);
      });
    }
});

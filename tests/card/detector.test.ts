import { describe, expect, it } from 'vitest';
import { CardDetector, focalFromFov } from '../../src/tracker/card/detector';
import { labelCard, poseFromQuad } from '../../src/tracker/card/geometry';
import { renderCardScene, cornerError } from '../helpers/synthCard';

const COLORS: [[number, number, number], 'doodle' | 'gradient' | 'plain' | 'stripes'][] = [
  [[33, 160, 56], 'doodle'], [[20, 30, 70], 'gradient'], [[18, 18, 20], 'plain'], [[120, 60, 200], 'stripes'],
];
function run(o: NonNullable<Parameters<typeof renderCardScene>[0]>, n = 4) {
  let ok = 0, wrong = 0;
  for (let s = 0; s < n; s++) {
    const c = COLORS[s % COLORS.length];
    const fr = renderCardScene({ w: 320, h: 240, tilt: 20 + (s * 7) % 30, yaw: s * 37, dist: 2.4, noise: 3, blur: 1, card: { rgb: c[0], design: c[1] }, ...o, seed: s + 1 });
    const r = new CardDetector().process(fr.rgba, fr.w, fr.h, { focal: fr.focal, forceDetect: true });
    if (r.quad && r.score >= 0.5) {
      if (o.noCard || cornerError(r.quad, fr.corners).max >= 5) wrong++;
      else ok++;
    }
  }
  return { ok, wrong };
}

describe('детектор карты (синтетика)', () => {
  it('находит карту на столе разного цвета и под наклоном', () => {
    const r = run({ bg: 'wood' });
    expect(r.wrong).toBe(0);
    expect(r.ok).toBeGreaterThanOrEqual(3);
  }, 60000);
  it('сильный наклон, тёмный стол, блик', () => {
    for (const o of [{ tilt: 55 }, { bg: 'dark' as const }, { glare: true }]) {
      const r = run(o);
      expect(r.wrong).toBe(0);
      expect(r.ok).toBeGreaterThanOrEqual(3);
    }
  }, 60000);
  it('без карты — ничего не находит', () => {
    for (const bg of ['wood', 'clutter', 'paper'] as const) expect(run({ noCard: true, bg }).wrong).toBe(0);
  }, 60000);
  it('поза: нормаль карты к камере, дальний край — «верх»', () => {
    const f = renderCardScene({ w: 480, h: 854, hfov: 63, tilt: 62, dist: 2.6, oy: 0.22, card: { rgb: [33, 160, 56], design: 'doodle' }, bg: 'wood', seed: 7 });
    const r = new CardDetector().process(f.rgba, f.w, f.h, { forceDetect: true });
    const K = { f: focalFromFov(480, 854), cx: 240, cy: 427 };
    const p = poseFromQuad(labelCard(r.quad!, K), K)!;
    expect(p.err).toBeLessThan(1);
    expect(p.R[5]).toBeGreaterThan(0.5); // нормаль вверх по экрану
    expect(p.R[8]).toBeGreaterThan(0); // и к камере
    expect(p.t[2]).toBeLessThan(-1);
  });
});

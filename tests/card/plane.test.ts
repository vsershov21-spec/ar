import { describe, expect, it } from 'vitest';
import { CardDetector } from '../../src/tracker/card/detector';
import { quadDiag } from '../../src/tracker/card/geometry';
import { renderCardScene } from '../helpers/synthCard';

/** камера уводится в сторону и отдаляется/приближается: карта уходит из кадра — ведём по столу */
function sequence(n: number, f: (i: number) => { ox: number; dist: number; tilt?: number }) {
  const det = new CardDetector();
  const out: { mode: string; err: number; inFrame: boolean }[] = [];
  for (let i = 0; i < n; i++) {
    const o = f(i);
    const fr = renderCardScene({ w: 320, h: 240, tilt: o.tilt ?? 35, yaw: 10, dist: o.dist, ox: o.ox, oy: 0, bg: 'wood', tableOnPlane: true, card: { rgb: [33, 160, 56], design: 'doodle' }, noise: 2, blur: 1, seed: 3, noiseSeed: i });
    const r = det.process(fr.rgba, fr.w, fr.h, { focal: fr.focal });
    const inFrame = fr.corners.every((c) => c.x >= 0 && c.x < 320 && c.y >= 0 && c.y < 240);
    let err = Infinity;
    if (r.quad) {
      // ближайшее совпадение по порядку углов
      for (let k = 0; k < 4; k++) {
        let m = 0;
        for (let j = 0; j < 4; j++) m = Math.max(m, Math.hypot(r.quad[(j + k) % 4].x - fr.corners[j].x, r.quad[(j + k) % 4].y - fr.corners[j].y));
        err = Math.min(err, m / quadDiag(fr.corners as never));
      }
    }
    out.push({ mode: r.mode, err, inFrame });
  }
  return out;
}

describe('карта держится за поверхность', () => {
  it('карта уходит за край кадра — позиция по столу, без потери', () => {
    const s = sequence(40, (i) => ({ ox: Math.min(1.6, i * 0.06), dist: 2.4 }));
    const out = s.filter((x) => !x.inFrame);
    expect(out.length).toBeGreaterThan(8);
    const kept = out.filter((x) => x.err < 0.15);
    expect(kept.length / out.length).toBeGreaterThan(0.8);
    expect(out.some((x) => x.mode === 'plane')).toBe(true);
  }, 120000);
  it('приближение и отдаление — карта и кот масштабируются', () => {
    const s = sequence(30, (i) => ({ ox: 0, dist: 2.4 - 1.0 * Math.sin((i / 29) * Math.PI) }));
    const ok = s.filter((x) => x.err < 0.08);
    expect(ok.length).toBeGreaterThan(26);
  }, 120000);
  it('увели камеру и вернули — кот снова на карте', () => {
    const s = sequence(50, (i) => ({ ox: 1.4 * Math.sin((i / 49) * Math.PI), dist: 2.4 }));
    const lost = s.filter((x) => x.err > 0.15).length;
    expect(lost).toBeLessThan(5);
    expect(s.slice(-5).every((x) => x.err < 0.08)).toBe(true);
  }, 180000);
});

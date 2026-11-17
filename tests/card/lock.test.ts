import { describe, expect, it } from 'vitest';
import { CardDetector } from '../../src/tracker/card/detector';
import { quadDiag } from '../../src/tracker/card/geometry';
import { renderCardScene } from '../helpers/synthCard';

const frame = (ox: number, i: number) =>
  renderCardScene({ w: 320, h: 240, tilt: 35, yaw: 10, dist: 2.4, ox, oy: 0, bg: 'wood', card: { rgb: [33, 160, 56], design: 'doodle' }, noise: 2, blur: 1, seed: 3, noiseSeed: i });

describe('посаженный кот не перепрыгивает на другой прямоугольник', () => {
  it('карта «появилась» в другом месте кадра — без пересадки детектор её не берёт; после reset — берёт', () => {
    const det = new CardDetector();
    let i = 0;
    for (; i < 6; i++) {
      const f = frame(-0.22, i);
      det.process(f.rgba, f.w, f.h, { focal: f.focal });
    }
    det.locked = true;
    // скачок: карта в другом месте (как если бы в кадр попала другая карта/книга), старой не видно
    let jumped = 0;
    for (let k = 0; k < 8; k++, i++) {
      const f = frame(0.22, i);
      const r = det.process(f.rgba, f.w, f.h, { focal: f.focal });
      if (r.quad) {
        const c = r.quad.reduce((s, p) => s + p.x, 0) / 4, t = f.corners.reduce((s, p) => s + p.x, 0) / 4;
        if (Math.abs(c - t) < 0.2 * quadDiag(f.corners as never)) jumped++;
      }
    }
    expect(jumped).toBe(0);
    det.reset();
    let found = 0;
    for (let k = 0; k < 6; k++, i++) {
      const f = frame(0.22, i);
      const r = det.process(f.rgba, f.w, f.h, { focal: f.focal });
      if (r.quad) found++;
    }
    expect(found).toBeGreaterThan(3);
  }, 120000);
});

import { describe, expect, it } from 'vitest';
import { renderCardScene } from '../helpers/synthCard';
import { labelCard } from '../../src/tracker/card/geometry';

/** кот не должен разворачиваться скачком: нумерация углов карты меняется плавно при вращении телефона */
describe('ориентация карты непрерывна', () => {
  it('полный оборот вокруг карты под разными наклонами — без скачков на 90°/180°', () => {
    for (const tilt of [5, 35, 60]) {
      let prev: ReturnType<typeof labelCard> | null = null;
      for (let yaw = 0; yaw <= 360; yaw += 8) {
        const fr = renderCardScene({ w: 160, h: 120, tilt, yaw, dist: 2.4 });
        // перемешанный порядок углов, как от детектора
        const q = [fr.corners[2], fr.corners[0], fr.corners[3], fr.corners[1]];
        const K = { f: fr.focal, cx: 80, cy: 60 };
        const r = labelCard(q, K, prev);
        if (prev) {
          const step = Math.max(...r.map((p, i) => Math.hypot(p.x - prev![i].x, p.y - prev![i].y)));
          expect(step).toBeLessThan(20);
        }
        prev = r;
      }
    }
  }, 120000);
});

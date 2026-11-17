import { describe, expect, it } from 'vitest';
import { renderCardScene } from '../helpers/synthCard';
import { focalFromQuad } from '../../src/tracker/card/geometry';

describe('фокус камеры по карте', () => {
  it('восстанавливается по наклонённой карте, почти сверху — отказ', () => {
    for (const [tilt, yaw] of [[35, 10], [50, 40], [60, -20], [40, 90]]) {
      const fr = renderCardScene({ w: 160, h: 120, tilt, yaw, dist: 2.4 });
      const f = focalFromQuad(fr.corners as never, 80, 60);
      expect(f, `tilt ${tilt} yaw ${yaw}`).not.toBeNull();
      expect(Math.abs(f! - fr.focal) / fr.focal).toBeLessThan(0.05);
    }
    const top = renderCardScene({ w: 160, h: 120, tilt: 3, yaw: 0, dist: 2.4 });
    expect(focalFromQuad(top.corners as never, 80, 60)).toBeNull();
  }, 60000);
});

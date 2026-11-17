import { describe, expect, it } from 'vitest';
import { KeyframeTracker, grayPyramid } from '../../src/tracker/card/keyframe';
import { renderCardScene, type SynthOptions } from '../helpers/synthCard';
import type { Quad } from '../../src/tracker/card/geometry';

const base: SynthOptions = { w: 320, h: 240, tilt: 35, yaw: 8, dist: 2.4, bg: 'wood', tableOnPlane: true, card: { rgb: [33, 160, 56], design: 'doodle' }, noise: 2.5, blur: 1, seed: 3 };
const err = (a: { x: number; y: number }[], b: { x: number; y: number }[]) => Math.max(...a.map((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y)));

describe('ключевой кадр карты', () => {
  const f0 = renderCardScene({ ...base, noiseSeed: 1 });
  const kt = new KeyframeTracker();
  const P0 = grayPyramid(f0.rgba, 320, 240);
  it('снимается и выравнивается сам на себя', () => {
    expect(kt.capture(P0.pyr[0], 320, 240, f0.corners as Quad, 0)).toBe(true);
    const H = kt.homographyFor(f0.corners)!;
    const r = kt.align(P0.pyr, P0.dims, H)!;
    expect(r).not.toBeNull();
    expect(err(r.quad, f0.corners)).toBeLessThan(0.3);
    expect(r.zncc).toBeGreaterThan(0.95);
  });
  it('поворот камеры 4°, старт со старой позы — сходится к новой карте', () => {
    const f1 = renderCardScene({ ...base, camRot: [2, 4, 1], noiseSeed: 2, light: 0.85 });
    const P1 = grayPyramid(f1.rgba, 320, 240);
    const r = kt.align(P1.pyr, P1.dims, kt.homographyFor(f0.corners)!)!;
    expect(r).not.toBeNull();
    expect(err(r.quad, f1.corners)).toBeLessThan(0.6);
  });
  it('рука закрывает часть карты — поза не уезжает', () => {
    const f2 = renderCardScene({ ...base, camRot: [1, 2, 0], noiseSeed: 3, fingerAt: { x: 0.5, y: 0.52, r: 0.08 } });
    const P2 = grayPyramid(f2.rgba, 320, 240);
    const r = kt.align(P2.pyr, P2.dims, kt.homographyFor(f0.corners)!)!;
    expect(r).not.toBeNull();
    expect(err(r.quad, f2.corners)).toBeLessThan(0.8);
  });
  it('карты в кадре нет (другое место) — не «находит»', () => {
    const f3 = renderCardScene({ ...base, camRot: [0, 40, 0], noiseSeed: 4 });
    const P3 = grayPyramid(f3.rgba, 320, 240);
    const r = kt.align(P3.pyr, P3.dims, kt.homographyFor(f0.corners)!);
    expect(!r || r.zncc < 0.7 || r.inl < 0.5).toBe(true);
  });
});

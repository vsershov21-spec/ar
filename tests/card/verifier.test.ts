/**
 * Детектор + проверка «это карта Сбера?» в потоке кадров, как в воркере: кадр детектора 320 × 240 и фрагмент
 * в большем разрешении (здесь — весь кадр 640 × 480, как камера 2× к кадру детектора).
 */
import { describe, expect, it } from 'vitest';
import { CardDetector } from '../../src/tracker/card/detector';
import { CardVerifier } from '../../src/tracker/card/verifier';
import type { CardKind } from '../../src/tracker/card/verify';
import { renderCardScene, type Tex } from '../helpers/synthCard';
import { design, NOT_CARD_SHAPE } from '../helpers/cardDesigns';

function half(f: { rgba: Uint8ClampedArray; w: number; h: number }) {
  const w = f.w >> 1, h = f.h >> 1, o = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let k = 0; k < 4; k++) {
        const a = (2 * y * f.w + 2 * x) * 4 + k;
        o[(y * w + x) * 4 + k] = (f.rgba[a] + f.rgba[a + 4] + f.rgba[a + f.w * 4] + f.rgba[a + f.w * 4 + 4]) / 4;
      }
  return { rgba: o, w, h };
}

function run(tex: Tex, shape?: { aspect: number; radius: number }, frames = 8, crop = true) {
  const det = new CardDetector({ detectEvery: 2 }); // как в воркере до посадки
  const ver = new CardVerifier();
  const states: CardKind[] = [];
  for (let i = 0; i < frames; i++) {
    const hi = renderCardScene({ w: 640, h: 480, tilt: 30 + i, yaw: 12 + i * 0.5, dist: 2.3, bg: 'wood', tex, shape, noise: 3, seed: 4, noiseSeed: i + 1 });
    const lo = half(hi);
    const r = det.process(lo.rgba, lo.w, lo.h, { focal: hi.focal / 2 });
    const rep = ver.step(det, r, lo, { f: hi.focal / 2, cx: lo.w / 2, cy: lo.h / 2 }, i * 100, crop ? { img: hi, x0: 0, y0: 0, w: lo.w, h: lo.h } : null);
    states.push(rep.state);
  }
  return states;
}

describe('проверка карты в потоке кадров (как в воркере)', () => {
  it('карта Сбера: «Сбер» за несколько кадров (с фрагментом в большем разрешении)', () => {
    const st = run(design('sber-red', 2));
    expect(st.indexOf('sber')).toBeGreaterThanOrEqual(1);
    expect(st.indexOf('sber')).toBeLessThanOrEqual(5);
    expect(st[st.length - 1]).toBe('sber');
  }, 60000);
  it('ноутбук и коробка — никогда не «Сбер» и не «карта»', () => {
    for (const k of ['laptop', 'box'] as const) {
      const st = run(design(k, 1), NOT_CARD_SHAPE[k]);
      expect(st.includes('sber')).toBe(false);
      expect(st.includes('card')).toBe(false);
    }
  }, 60000);
  it('карта другого банка — не «Сбер»', () => {
    const st = run(design('other-blue', 1), undefined, 12);
    expect(st.includes('sber')).toBe(false);
  }, 60000);
});

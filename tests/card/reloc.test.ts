/**
 * Кот посажен, карта потеряна, телефон сдвинули — карта теперь в другом месте кадра (дальше радиуса поиска у прогноза).
 * Раньше её не находили вовсе: 6 с удержания, потом «Где карта?» при карте в кадре (запись продакта 18.11).
 * Теперь воркер узнаёт ту же карту Сбера по знаку среди кандидатов полного поиска (CardPipeline.relocalize).
 * Чужой прямоугольник (карта другого банка) кота по-прежнему не утаскивает.
 */
import { describe, expect, it } from 'vitest';
import { CardPipeline } from '../../src/tracker/card/pipeline';
import { quadDiag, type Quad } from '../../src/tracker/card/geometry';
import { renderCardScene, type Tex } from '../helpers/synthCard';
import { design } from '../helpers/cardDesigns';

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

const scene = (tex: Tex, ox: number, i: number) => {
  const hi = renderCardScene({ w: 640, h: 480, tilt: 32, yaw: 10, dist: 2.4, ox, oy: 0, bg: 'wood', tex, noise: 3, seed: 4, noiseSeed: i + 1 });
  const lo = half(hi);
  return { hi, lo, focal: hi.focal / 2, truth: hi.corners.map((p) => ({ x: p.x / 2, y: p.y / 2 })) as Quad };
};
const center = (q: { x: number; y: number }[]) => q.reduce((s, p) => s + p.x, 0) / 4;

function run(tex: Tex) {
  const pipe = new CardPipeline();
  let i = 0;
  let last: Quad | null = null;
  // до посадки: карта слева, проверка «Сбер» (как CardTracker: фрагмент в большем разрешении)
  for (; i < 10; i++) {
    const s = scene(tex, -0.24, i);
    const out = pipe.process({ rgba: s.lo.rgba, w: s.lo.w, h: s.lo.h, focal: s.focal, lock: false, verify: true, crop: { img: s.hi, x0: 0, y0: 0, w: s.lo.w, h: s.lo.h } });
    if (out?.quad) last = out.quad as Quad;
  }
  // посадка (lock) — ещё пара кадров на месте
  for (let k = 0; k < 3; k++, i++) {
    const s = scene(tex, -0.24, i);
    const out = pipe.process({ rgba: s.lo.rgba, w: s.lo.w, h: s.lo.h, focal: s.focal, lock: true, verify: true });
    if (out?.quad) last = out.quad as Quad;
  }
  expect(last).not.toBeNull();
  const hint = last!;
  // телефон сдвинули: карта справа, старого места больше нет; трекер ищет у прогноза (hint) и шлёт «потеряна N мс»
  let relocated = -1, nearTruth = false;
  for (let k = 0; k < 14; k++, i++) {
    const s = scene(tex, 0.24, i);
    const out = pipe.process({ rgba: s.lo.rgba, w: s.lo.w, h: s.lo.h, focal: s.focal, lock: true, hint, hintRadius: 0.6, lostMs: 600 + k * 66, verify: true, crop: { img: s.hi, x0: 0, y0: 0, w: s.lo.w, h: s.lo.h } });
    if (out?.relocated && relocated < 0) {
      relocated = k;
      nearTruth = Math.abs(center(out.quad!) - center(s.truth)) < 0.15 * quadDiag(s.truth);
    }
  }
  return { relocated, nearTruth };
}

describe('карта потеряна, телефон сдвинули — та же карта Сбера находится по знаку', () => {
  it('карта Сбера в другом месте кадра — снова ведём её за несколько кадров', () => {
    const r = run(design('sber-red', 2));
    expect(r.relocated).toBeGreaterThanOrEqual(0);
    expect(r.relocated).toBeLessThanOrEqual(8);
    expect(r.nearTruth).toBe(true);
  }, 120000);
  it('карта другого банка в другом месте — кота не утаскивает', () => {
    const r = run(design('other-green', 2));
    expect(r.relocated).toBe(-1);
  }, 120000);
});

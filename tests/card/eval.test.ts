/**
 * Стенд записей (tests/card/eval, `npm run card:eval`) и то, что он нашёл 18.11 (docs/CARD_DETECTION.md, «Стенд
 * записей»): синтетические клипы с истинными углами и гироскопом — приближение 45→25 см, наклон 25→70°, встряска;
 * полный конвейер (CardPipeline + CardSession), воркер 45 мс, камера 33 мс. Регрессии:
 *  - кот на карте в пределах ±5 мм на наклоне/приближении (было p90 23–37 мм: показ «на сейчас» вместо кадра на
 *    экране и OneEuro без скорости);
 *  - масштаб кота при приближении — p90 < 3 % (было 5–12 %);
 *  - задержка камеры оценивается по самой карте (80 мс при «зашитых» 33);
 *  - неточный угол при посадке исправляется полным поиском (ключевой кадр по краям);
 *  - карта другого банка — 0 посадок.
 */
import { describe, expect, it } from 'vitest';
import { replayClip, planeError } from './eval/replay';
import { compare } from './eval/cli';
import { MOTIONS, synthClip } from './eval/synthClip';
import { design } from '../helpers/cardDesigns';
import { numberZone, pixelatePolygon } from '../../src/tracker/card/blurNumbers';
import { PosKalman, focalFromQuads } from '../../src/tracker/card/session';
import { poseFromQuad, type Quad } from '../../src/tracker/card/geometry';
import * as THREE from 'three';

const sber = design('sber-green');
const run = (name: keyof typeof MOTIONS, extra: Parameters<typeof synthClip>[0] extends infer T ? Partial<T> : never = {}) =>
  replayClip(synthClip({ name, ...MOTIONS[name], tex: sber, ...extra }), { workerMs: 45 });

describe('стенд записей: кот на карте при движении телефона (синтетика с истинными углами)', () => {
  it('наклон 25→70° (облёт над картой): p90 ≤ 6 мм, масштаб p90 < 3 %, без потерь и ложных посадок', async () => {
    const m = await run('tilt');
    expect(m.timeToLand).toBeLessThan(3);
    expect(m.falseLandings).toBe(0);
    expect(m.visibleLosses).toBe(0);
    expect(m.errMm.p90).toBeLessThan(6);
    expect(m.scaleErr.p90).toBeLessThan(3);
    expect(m.headMm.p90).toBeLessThan(5);
  }, 120_000);

  it('приближение 42→25 см и всё сразу: p90 ≤ 5 мм, масштаб p90 < 3 %', async () => {
    for (const name of ['approach', 'combo'] as const) {
      const m = await run(name);
      expect(m.landings, name).toBeGreaterThan(0);
      expect(m.errMm.p90, name).toBeLessThan(5);
      expect(m.scaleErr.p90, name).toBeLessThan(3);
      expect(m.jitterMm, name).toBeLessThan(3.5);
    }
  }, 240_000);

  it('задержка камеры 80 мс (трекер начинает с 33) — оценивается по карте', async () => {
    const m = await run('shake', { camLat: 0.08 });
    expect(m.camLatEnd).toBeGreaterThan(65);
    expect(m.camLatEnd).toBeLessThan(95);
    expect(m.visibleLosses).toBe(0);
  }, 120_000);

  it('угол обзора камеры 56° при фокусе по умолчанию (63°): угол при посадке исправляется, кот ведётся', async () => {
    const m = await run('tilt', { hfov: 56 });
    expect(m.lockedFrac).toBeGreaterThan(0.9);
    expect(m.errMm.p90).toBeLessThan(6);
  }, 120_000);

  it('карта другого банка: 0 посадок', async () => {
    const m = await replayClip(synthClip({ name: 'neg', duration: 6, pose: MOTIONS.combo.pose, tex: design('other-green') }), { workerMs: 45 });
    expect(m.landings).toBe(0);
  }, 120_000);
});

describe('стенд записей: части', () => {
  it('ошибка на плоскости карты: сдвиг на 1 % ширины = 0,86 мм, масштаб — корень площади', () => {
    const ref: Quad = [{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 163 }, { x: 100, y: 163 }];
    const sh = ref.map((p) => ({ x: p.x + 1, y: p.y })) as Quad;
    expect(planeError(sh, ref)!.mm).toBeCloseTo(0.856, 2);
    const big = ref.map((p) => ({ x: 150 + (p.x - 150) * 1.1, y: 131.5 + (p.y - 131.5) * 1.1 })) as Quad;
    expect(planeError(big, ref)!.scale).toBeCloseTo(0.1, 2);
  });

  it('фильтр Калмана: при постоянной скорости прогноз без запаздывания, при удержании — не улетает', () => {
    const kf = new PosKalman();
    const R = [1e-4, 0, 0, 0, 1e-4, 0, 0, 0, 1e-4];
    kf.reset(new THREE.Vector3(0, 0, -3), 0, R);
    for (let i = 1; i <= 30; i++) kf.update(new THREE.Vector3(0.5 * (i / 30), 0, -3), R, i / 30);
    const p = kf.at(1 + 0.08, new THREE.Vector3());
    expect(p.x).toBeGreaterThan(0.5 + 0.5 * 0.08 * 0.7); // прогноз вперёд по скорости 0,5 ед/с
    const far = kf.at(1 + 5, new THREE.Vector3());
    expect(far.x).toBeLessThan(0.5 + 0.5 * 0.25); // насыщение: не дальше ~horizon·v
  });

  it('фокус по набору четырёхугольников — истинный при точных углах', () => {
    const f = 240;
    const quads: Quad[] = [];
    for (let i = 0; i < 12; i++) {
      const c = synthClip({ name: 'f', duration: 0.1, pose: () => ({ cm: 25 + i, tilt: 25 + 4 * i, az: 10 * i }), hfov: (2 * Math.atan(320 / (2 * f)) * 180) / Math.PI, focal: f });
      quads.push(c.gt!(0)!.map((p) => ({ x: p.x + 0.5, y: p.y + 0.5 })) as Quad);
    }
    const r = focalFromQuads(quads, 90, 160, 150, 420)!;
    expect(Math.abs(r.f - 240) / 240).toBeLessThan(0.02);
    expect(poseFromQuad(quads[5], { f: r.f, cx: 90, cy: 160 })!.err).toBeLessThan(0.3);
  });

  it('зона номера — нижние 60 % карты; пикселизация трогает только её', () => {
    const w = 200, h = 140;
    const q: Quad = [{ x: 40, y: 30 }, { x: 160, y: 30 }, { x: 160, y: 106 }, { x: 40, y: 106 }];
    const zone = numberZone(q, 0.6, 0)!;
    const ys = zone.map((p) => p.y);
    expect(Math.min(...ys)).toBeCloseTo(30 + 0.4 * 76, 0);
    expect(Math.max(...ys)).toBeCloseTo(106, 0);
    const img = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) img[i * 4] = (i * 37) % 255;
    const before = img.slice();
    pixelatePolygon(img, w, h, zone);
    const px = (x: number, y: number, a: Uint8ClampedArray) => a[(y * w + x) * 4];
    expect(px(100, 40, img)).toBe(px(100, 40, before)); // знак и чип сверху — как были
    let changed = 0;
    for (let x = 45; x < 155; x++) if (px(x, 95, img) !== px(x, 95, before)) changed++;
    expect(changed).toBeGreaterThan(80);
  });

  it('регрессия относительно базы: хуже допуска — список, не хуже — пусто', () => {
    const m = { clip: 'a', timeToLand: 1, falseLandings: 0, wrongPlace: 0, visibleLosses: 0, errMm: { p90: 4 }, jitterMm: 1, scaleErr: { p90: 1 }, headMm: { p90: 2 }, lockedFrac: 0.95, cpu: { mean: 10 } } as never;
    expect(compare([m], [m], 0.15)).toEqual([]);
    const worse = { ...(m as object), errMm: { p90: 9 }, falseLandings: 1 } as never;
    expect(compare([worse], [m], 0.15).length).toBe(2);
  });
});

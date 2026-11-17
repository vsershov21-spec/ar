/**
 * Ядро трекера на главном потоке (session.ts) без картинок: углы карты из эталонной геометрии synthCard,
 * задержка «камера + воркер», гироскоп. Проверяем: кот не отстаёт при повороте телефона, нет скачка на
 * HOLD ↔ LOCKED, неверный гироскоп сам выключается.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CardSession } from '../../src/tracker/card/session';
import { focalFromFov } from '../../src/tracker/card/detector';
import { camMatrix, sceneCorners, type SynthOptions } from '../helpers/synthCard';
import { anchorQuad } from '../helpers/cardBench';
import type { PipelineOut } from '../../src/tracker/card/pipeline';

const base: SynthOptions = { w: 320, h: 240, tilt: 35, yaw: 8, dist: 2.4 };
const K = { f: focalFromFov(320, 240), cx: 160, cy: 120 };
const qOf = (a: [number, number, number]) => {
  const R = camMatrix(a);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().set(R[0], R[1], R[2], 0, R[3], R[4], R[5], 0, R[6], R[7], R[8], 0, 0, 0, 0, 1));
};
const err = (a: { x: number; y: number }[], b: { x: number; y: number }[]) => {
  let best = Infinity;
  for (let k = 0; k < 4; k++) best = Math.min(best, Math.max(...b.map((p, j) => Math.hypot(a[(j + k) % 4].x - p.x, a[(j + k) % 4].y - p.y))));
  return best;
};

/** прогон: rot(t) — поворот телефона, visible(t) — видна ли карта; задержка 80 мс; гироскоп с ошибкой оси (bad) */
function sim(rot: (t: number) => [number, number, number], visible: (t: number) => boolean, opts: { gyro?: boolean; bad?: boolean; T?: number } = {}) {
  const s = new CardSession(false);
  s.K = K;
  s.w = 320;
  s.h = 240;
  const gq = (t: number) => {
    if (opts.gyro === false) return null;
    const a = rot(t);
    return qOf(opts.bad ? [a[1], -a[0], a[2]] : a);
  };
  const lat = 0.08;
  const errs: { t: number; e: number; state: string }[] = [];
  let pending: { due: number; out: PipelineOut; q: THREE.Quaternion | null } | null = null;
  let next = 0;
  for (let t = 0; t < (opts.T ?? 3); t += 1 / 60) {
    if (pending && t >= pending.due) {
      s.onResult(pending.out, pending.q, t * 1000, 0);
      pending = null;
    }
    if (!pending && t >= next) {
      const q = sceneCorners({ ...base, camRot: rot(t) });
      const vis = visible(t);
      s.request(t * 1000, gq(t));
      pending = { due: t + lat, out: { quad: vis ? q : null, score: vis ? 0.9 : 0, mode: vis ? 'key' : 'none', ms: 5 }, q: gq(t) };
      next = t + lat;
    }
    s.tick(t * 1000);
    const m = s.frame(1 / 60, gq(t));
    if (m) {
      const d = anchorQuad(m, K)!;
      errs.push({ t, e: err(d, sceneCorners({ ...base, camRot: rot(t) })), state: s.state });
    }
  }
  return { s, errs };
}

const shake = (t: number): [number, number, number] => (t < 1 ? [0, 0, 0] : [3 * Math.sin((t - 1) * 6), 6 * Math.sin((t - 1) * 5), 0]);

describe('ядро трекера: гироскоп, задержка, фильтр', () => {
  it('телефон качают (до 30°/с), задержка 80 мс — с гироскопом кот на карте (< 2 px), без — отстаёт', () => {
    const g = sim(shake, () => true);
    const n = sim(shake, () => true, { gyro: false });
    const tail = (r: typeof g) => r.errs.filter((x) => x.t > 1.5);
    const mg = Math.max(...tail(g).map((x) => x.e)), mn = Math.max(...tail(n).map((x) => x.e));
    expect(mg).toBeLessThan(2);
    expect(mn).toBeGreaterThan(4 * mg);
  });

  it('карта пропала (рука) — HOLD по гироскопу без скачка, вернулась — без скачка', () => {
    const r = sim(shake, (t) => !(t > 1.8 && t < 2.6), { T: 3.2 });
    const hold = r.errs.filter((x) => x.state === 'hold' || x.state === 'relocalize');
    expect(hold.length).toBeGreaterThan(10);
    expect(Math.max(...hold.map((x) => x.e))).toBeLessThan(2.5);
    // шаг между соседними кадрами — без рывков
    let jump = 0;
    for (let i = 1; i < r.errs.length; i++) if (r.errs[i].t > 1.2) jump = Math.max(jump, Math.abs(r.errs[i].e - r.errs[i - 1].e));
    expect(jump).toBeLessThan(1.5);
  });

  it('гироскоп «не тот» (оси перепутаны) — компенсация выключается сама', () => {
    const r = sim(shake, () => true, { bad: true, T: 5 });
    expect(r.s.gyroOk).toBe(false);
  });
});

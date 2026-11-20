import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { cardModel, mirrorPose, poseFromQuad, poseNormal, projectPoint, type Quad } from '../../src/tracker/card/geometry';
import { CardSession } from '../../src/tracker/card/session';
import type { PipelineOut } from '../../src/tracker/card/pipeline';

/**
 * Кот вверх ногами (запись с iPhone 20.11, 12:35:05–12:35:20): у далёкой карты под наклоном поза по 4 углам
 * неоднозначна — вторая, «зеркальная», с нормалью вниз по экрану. Проверяем: зеркальная поза находится, а сессия
 * выбирает позу с нормалью «вверх от стола» (по гироскопу, без него — вверх по экрану) и не прыгает между ними.
 */
const K = { f: 260, cx: 90, cy: 160 };

/** карта на столе, камера над ней под углом tilt от вертикали, на расстоянии dist ширин карты, поворот yaw */
function scene(tilt: number, dist: number, yaw = 0) {
  const a = (tilt * Math.PI) / 180;
  // камера three: смотрит в −Z, +Y вверх. Карта лежит в плоскости, нормаль к камере повернута вверх по экрану на tilt.
  const Rx = new THREE.Matrix4().makeRotationX(-a);
  const Rz = new THREE.Matrix4().makeRotationZ((yaw * Math.PI) / 180);
  const M = new THREE.Matrix4().multiplyMatrices(Rx, Rz);
  const e = M.elements;
  const R = [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]];
  const t: [number, number, number] = [0, 0, -dist];
  return { R, t };
}

function project(R: number[], t: number[], noise = 0, rnd = Math.random): Quad {
  return cardModel().map((p) => {
    const q = projectPoint(R, t, p.x, p.y, 0, K)!;
    return { x: q.x + (rnd() - 0.5) * 2 * noise, y: q.y + (rnd() - 0.5) * 2 * noise };
  }) as Quad;
}

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe('зеркальная поза карты', () => {
  it('у далёкой наклонной карты есть вторая поза с нормалью вниз по экрану и почти той же ошибкой', () => {
    const { R, t } = scene(55, 10);
    const q = project(R, t);
    const p = poseFromQuad(q, K)!;
    expect(poseNormal(p)[1]).toBeGreaterThan(0.5);
    const m = mirrorPose(p, q, K)!;
    expect(m).toBeTruthy();
    expect(poseNormal(m)[1]).toBeLessThan(-0.3);
    expect(m.err).toBeLessThan(1);
  });

  it('шум углов в 0,7 px у карты 26 px иногда даёт зеркальную позу (поэтому и нужен выбор)', () => {
    const { R, t } = scene(55, 10);
    const rnd = lcg(7);
    let flipped = 0;
    for (let i = 0; i < 400; i++) {
      const p = poseFromQuad(project(R, t, 0.7, rnd), K);
      if (p && poseNormal(p)[1] < 0) flipped++;
    }
    expect(flipped).toBeGreaterThan(0);
  });

  it('сессия: нормаль всегда вверх (без гироскопа — вверх по экрану), без переворотов', () => {
    const { R, t } = scene(55, 10);
    const s = new CardSession(false);
    s.K = { ...K };
    s.w = 180;
    s.h = 320;
    const rnd = lcg(3);
    let down = 0, n = 0;
    let shown: THREE.Vector3 | null = null;
    let flips = 0;
    for (let i = 0; i < 300; i++) {
      const now = 1000 + i * 40;
      const out = { quad: project(R, t, 0.7, rnd), score: 1, mode: i % 3 ? 'key' : 'detect', ms: 5 } as unknown as PipelineOut;
      s.onResult(out, null, now, 0, now);
      const m = s.frame(0.04, null);
      if (!m) continue;
      const e = m.elements;
      const nv = new THREE.Vector3(e[8], e[9], e[10]);
      n++;
      if (nv.y < 0) down++;
      if (shown && shown.dot(nv) < 0.5) flips++;
      shown = nv;
    }
    expect(n).toBeGreaterThan(200);
    expect(down).toBe(0);
    expect(flips).toBe(0);
  });

  it('сессия с гироскопом: нормаль — вверх в мире, даже если телефон держат «вниз головой»', () => {
    // телефон наклонён: в мире камера смотрит вниз на стол под 55°; ориентация камеры capQ — поворот вокруг X
    const { R, t } = scene(55, 10);
    const capQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -(35 * Math.PI) / 180);
    const s = new CardSession(false);
    s.K = { ...K };
    s.w = 180;
    s.h = 320;
    const rnd = lcg(11);
    let bad = 0, n = 0;
    for (let i = 0; i < 200; i++) {
      const now = 1000 + i * 40;
      const out = { quad: project(R, t, 0.7, rnd), score: 1, mode: 'key', ms: 5 } as unknown as PipelineOut;
      s.onResult(out, capQ, now, 0, now);
      const m = s.frame(0.04, capQ);
      if (!m) continue;
      const e = m.elements;
      const nw = new THREE.Vector3(e[8], e[9], e[10]).applyQuaternion(capQ);
      n++;
      if (nw.y < 0.3) bad++;
    }
    expect(n).toBeGreaterThan(150);
    expect(bad).toBe(0);
  });
});

describe('гироскоп выключается без прыжка кота', () => {
  it('датчик врёт (не та ось) → компенсация выключается, кот на экране не перескакивает', () => {
    const s = new CardSession(false);
    s.K = { ...K };
    s.w = 180;
    s.h = 320;
    const base = scene(35, 3);
    let prev: THREE.Vector3 | null = null;
    let maxJump = 0;
    const logs: string[] = [];
    for (let i = 0; i < 160; i++) {
      const now = 1000 + i * 40;
      // телефон поворачивается вокруг вертикали (карта едет по экрану), гироскоп сообщает поворот вокруг X
      const a = Math.sin(i / 12) * 0.25;
      const Ry = new THREE.Matrix4().makeRotationY(a);
      const Rm = new THREE.Matrix4().set(base.R[0], base.R[1], base.R[2], 0, base.R[3], base.R[4], base.R[5], 0, base.R[6], base.R[7], base.R[8], 0, 0, 0, 0, 1).premultiply(Ry);
      const e = Rm.elements;
      const R = [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]];
      const t = new THREE.Vector3(...base.t).applyMatrix4(Ry);
      const capQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.6 + a * 1.5);
      const out = { quad: project(R, [t.x, t.y, t.z]), score: 1, mode: 'key', ms: 5 } as unknown as PipelineOut;
      s.onResult(out, capQ, now, 0.5, now);
      const m = s.frame(0.04, capQ);
      if (!m) continue;
      const p = new THREE.Vector3().setFromMatrixPosition(m);
      if (prev) maxJump = Math.max(maxJump, p.distanceTo(prev));
      prev = p;
      logs.push(...s.log.splice(0));
    }
    expect(logs.some((l) => /гироскоп выключен|НЕ совпадает/.test(l))).toBe(true);
    expect(maxJump).toBeLessThan(0.3);
  });
});

describe('самокалибровка фокуса без рывка кота', () => {
  it('фокус уточнился посреди ведения — кот на экране не прыгает (фильтр масштабируется, а не сбрасывается)', () => {
    const s = new CardSession(false);
    s.K = { ...K, f: 200 }; // настоящий 260
    s.w = 180;
    s.h = 320;
    let changed = 0;
    s.onFocal = () => changed++;
    let prev: { x: number; y: number } | null = null;
    let maxJump = 0;
    for (let i = 0; i < 400; i++) {
      const now = 1000 + i * 33;
      // плавный облёт: наклон 25–60°, поворот ±40°
      const { R, t } = scene(42 + 17 * Math.sin(i / 25), 3.2, 40 * Math.sin(i / 37));
      const out = { quad: project(R, t), score: 1, mode: 'key', ms: 5 } as unknown as PipelineOut;
      s.onResult(out, null, now, 0, now);
      const m = s.frame(0.033, null);
      if (!m) continue;
      // голова кота (0,7 ширины над центром) на экране, px
      const e = m.elements;
      const X = e[8] * 0.7 + e[12], Y = e[9] * 0.7 + e[13], Z = e[10] * 0.7 + e[14];
      // экран — с фокусом сессии (приложение меняет угол обзора камеры вместе с ним: CardTracker.onFocal → resize)
      const p = { x: K.cx + (s.K.f * X) / -Z, y: K.cy - (s.K.f * Y) / -Z };
      if (prev) maxJump = Math.max(maxJump, Math.hypot(p.x - prev.x, p.y - prev.y));
      prev = p;
    }
    expect(changed).toBeGreaterThan(0);
    expect(maxJump).toBeLessThan(6);
  });
});

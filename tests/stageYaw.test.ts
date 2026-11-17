import { describe, expect, it, beforeAll } from 'vitest';
import * as THREE from 'three';

beforeAll(() => {
  // Stage рисует тень на canvas — в node хватает заглушки
  const ctx = { createRadialGradient: () => ({ addColorStop() {} }), fillRect() {}, fillStyle: '' };
  (globalThis as unknown as { document: unknown }).document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
});

async function makeStage() {
  const { Stage } = await import('../src/stage');
  const { defaultStage } = await import('../src/config');
  const camera = new THREE.PerspectiveCamera(60, 0.5, 0.01, 100);
  const anchor = new THREE.Object3D();
  const scene = new THREE.Scene();
  scene.add(anchor, camera);
  const tracker = { anchor, camera, aspect: 0.7 } as never;
  const cfg = { ...defaultStage, footX: 0, footY: 0, yawFollow: true } as never;
  const st = new Stage(scene, tracker, cfg);
  const yaw = () => (st as unknown as { yaw: number }).yaw;
  // камера над картой на расстоянии 2, под углом a вокруг нормали
  const camAt = (a: number) => {
    camera.position.set(2 * Math.sin(a), -2 * Math.cos(a), 1.5);
    camera.updateMatrixWorld(true);
  };
  return { st, yaw, camAt };
}

describe('Stage: поворот к зрителю', () => {
  it('разворот на 180° — с ограничением скорости, без «волчка» и перелёта', async () => {
    const { st, yaw, camAt } = await makeStage();
    camAt(0);
    for (let i = 0; i < 120; i++) st.update(1 / 60);
    const y0 = yaw();
    camAt(Math.PI * 0.95);
    let prev = yaw();
    let maxV = 0;
    for (let i = 0; i < 240; i++) {
      st.update(1 / 60);
      maxV = Math.max(maxV, Math.abs(yaw() - prev) * 60);
      prev = yaw();
    }
    expect(maxV).toBeLessThanOrEqual(2.61);
    const d = Math.atan2(Math.sin(yaw() - y0), Math.cos(yaw() - y0));
    expect(Math.abs(Math.abs(d) - Math.PI * 0.95)).toBeLessThan(0.12);
  });

  it('дрожание камеры ±3° кота не крутит', async () => {
    const { st, yaw, camAt } = await makeStage();
    camAt(0.3);
    for (let i = 0; i < 180; i++) st.update(1 / 60);
    const y0 = yaw();
    let maxD = 0;
    for (let i = 0; i < 180; i++) {
      camAt(0.3 + 0.05 * Math.sin(i * 1.7));
      st.update(1 / 60);
      maxD = Math.max(maxD, Math.abs(yaw() - y0));
    }
    expect(maxD).toBeLessThan(0.01);
  });

  it('не зависит от частоты кадров', async () => {
    const a = await makeStage();
    const b = await makeStage();
    a.camAt(1.2);
    b.camAt(1.2);
    for (let i = 0; i < 60; i++) a.st.update(1 / 60);
    for (let i = 0; i < 30; i++) b.st.update(1 / 30);
    expect(Math.abs(a.yaw() - b.yaw())).toBeLessThan(0.05);
  });
});

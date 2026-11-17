import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { lidPose, EyeRig } from '../src/character/eyeRig';
import { emotionFor, EVENT_EMOTION } from '../src/character/emotions';
import { facePreset } from '../src/character/face';

describe('3D-глаза и эмоции', () => {
  it('веки: моргание и смех закрывают, удивление открывает шире, злость/грусть наклоняют', () => {
    expect(lidPose({}, 'L').up).toBeCloseTo(0.05, 2);
    const b = lidPose({ blink_L: 1 }, 'L');
    expect(b.up).toBe(1);
    expect(b.lo).toBe(1);
    expect(lidPose({ blink_L: 1 }, 'R').up).toBeLessThan(0.1);
    expect(lidPose({ eyes_laugh: 1 }, 'R').up).toBe(1);
    expect(lidPose({ eyes_wide: 1 }, 'L').up).toBeLessThan(0);
    expect(lidPose({ eyes_sleepy: 1 }, 'L').up).toBeGreaterThan(0.5);
    expect(lidPose({ brow_down: 1 }, 'L').tilt).toBeGreaterThan(0);
    expect(lidPose({ brow_sad: 1 }, 'L').tilt).toBeLessThan(0);
  });

  it('эмоции событий — известные пресеты лица', () => {
    for (const [ev, [preset]] of Object.entries(EVENT_EMOTION)) expect(facePreset(preset), `${ev} → ${preset}`).toBeTruthy();
    expect(emotionFor('shake', 'kind')![0]).toBe('dizzy');
    expect(emotionFor('card_found', 'glitter')![0]).toBe('surprised');
    expect(emotionFor('tap_cat_head', 'hooligan')![0]).toBe('smug');
    for (const id of ['happy', 'laugh', 'smug', 'wink_l', 'wink_r', 'surprised', 'pout', 'shy', 'sad', 'sleepy', 'dizzy', 'sleep']) expect(facePreset(id), id).toBeTruthy();
  });

  it('рант: глаз смотрит на цель, веки поворачиваются, зрачок и спираль — в униформах', () => {
    const root = new THREE.Group();
    for (const side of ['L', 'R'] as const) {
      const pivot = new THREE.Object3D();
      pivot.name = `Eye_${side}`;
      pivot.position.x = side === 'L' ? 0.1 : -0.1;
      pivot.userData = { side, A: 0.05, B: 0.04, C: 0.03, closeUp: 1.2, closeLo: 0.6, irisUV: [0.2, 0.25], pupil: 0.5 };
      const s = new THREE.Object3D();
      s.name = `EyeS_${side}`;
      s.scale.set(0.05, 0.04, 0.03);
      pivot.add(s);
      for (const n of ['EyeBall', 'LidUp', 'LidLo']) {
        const m = new THREE.Mesh(new THREE.SphereGeometry(1), new THREE.MeshStandardMaterial());
        m.name = `${n}_${side}`;
        s.add(m);
      }
      root.add(pivot);
    }
    const rig = EyeRig.find(root, () => 0.5)!;
    expect(rig).toBeTruthy();
    const target = new THREE.Vector3(2, 0, 5);
    for (let i = 0; i < 30; i++) rig.update(1 / 30, { weights: { eyes_spiral: 0, blink_L: 1 }, pupils: 1.4, target, idle: false });
    const ballL = root.getObjectByName('EyeBall_L')!;
    const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(ballL.quaternion);
    expect(dir.x).toBeGreaterThan(0.1); // смотрит вправо, к цели
    const upL = root.getObjectByName('LidUp_L')!;
    const upR = root.getObjectByName('LidUp_R')!;
    expect(new THREE.Euler().setFromQuaternion(upL.quaternion).x).toBeGreaterThan(1.0); // моргнул левым
    expect(Math.abs(new THREE.Euler().setFromQuaternion(upR.quaternion).x)).toBeLessThan(0.3);
    expect(rig.uniforms.uPupil.value).toBeGreaterThan(1.2);
    rig.update(0.1, { weights: { eyes_spiral: 1 }, pupils: 1, target, idle: false });
    expect(rig.uniforms.uSpiral.value).toBe(1);
  });
});

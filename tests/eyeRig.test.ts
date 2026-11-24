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

describe('лицо v3: глаза «^», рот-накладка, тон меха', () => {
  it('смех и подмигивание — дуга (закрывает нижнее веко), моргание — нет', () => {
    expect(lidPose({ eyes_laugh: 1 }, 'L').arc).toBe(1);
    expect(lidPose({ wink_R: 1 }, 'R').arc).toBe(1);
    expect(lidPose({ wink_R: 1 }, 'L').arc).toBe(0);
    expect(lidPose({ blink_L: 1 }, 'L').arc).toBe(0);
  });

  it('рот: челюсть открывает полость, «о» — округлость, покой — закрыт', async () => {
    const { mouthParams } = await import('../src/character/mouthRig');
    const jaw = { mouth_A: 0.4, mouth_O: 0.3 };
    expect(mouthParams({}, jaw).drop).toBe(0);
    const a = mouthParams({ mouth_A: 1 }, jaw);
    expect(a.drop).toBeCloseTo(0.4, 5);
    expect(a.round).toBeLessThan(0.1);
    const o = mouthParams({ mouth_O: 1 }, jaw);
    expect(o.round).toBeGreaterThan(0.9);
    const pout = facePreset('pout')!.weights;
    expect(mouthParams(pout, jaw).frown).toBe(1);
    expect(mouthParams(pout, jaw).drop).toBe(0); // надулся — рот закрыт
  });

  it('эмоции по референсу заметны: надулся — щёки, грусть — слёзка, удивление — рот «о»', () => {
    expect(facePreset('pout')!.weights.cheeks_gum).toBeGreaterThan(0.5);
    expect(facePreset('sad')!.weights.tear).toBe(1);
    expect(facePreset('surprised')!.weights.mouth_O).toBeGreaterThan(1);
    expect(facePreset('shy')!.gaze).toBeTruthy();
  });

  it('тон меха не трогает глаза, рот, слёзку и румянец', async () => {
    const { FurTone } = await import('../src/character/furTone');
    expect(FurTone.isFur('tripo_node_x')).toBe(true);
    expect(FurTone.isFur('FaceTufts')).toBe(true);
    for (const n of ['EyeBall_L', 'MouthD', 'Tear_L', 'Blush', 'Whiskers', 'BD_Pads']) expect(FurTone.isFur(n), n).toBe(false);
  });
});

describe('мягкие веки: разрез глаза и растворение в мех (eyeRig.ts)', () => {
  it('поле разреза: внутри < 0, снаружи > 0; сошедшиеся уголки не тянут полосу', async () => {
    const { lidCutPolygon, polyDist } = await import('../src/character/eyeRig');
    // кромки по столбцам: середина открыта, крайние столбцы сошлись
    const nu = 7;
    const mk = (ys: number[]) => {
      const g = new THREE.BufferGeometry();
      const p = new Float32Array(nu * 3);
      for (let k = 0; k < nu; k++) {
        const x = (k - 3) * 0.3;
        p.set([x, ys[k], Math.sqrt(Math.max(0.01, 1 - x * x - ys[k] * ys[k]))], k * 3);
      }
      g.setAttribute('position', new THREE.BufferAttribute(p, 3));
      return g;
    };
    const up = mk([0, 0, 0.4, 0.5, 0.4, 0, 0]);
    const lo = mk([0, 0, -0.3, -0.4, -0.3, 0, 0]);
    const poly = lidCutPolygon(up, lo, nu);
    expect(poly.length).toBe(2 * 5); // по одному сошедшемуся столбцу с краёв
    expect(polyDist(poly, 0, 0)).toBeLessThan(-0.2);
    expect(polyDist(poly, 0, 0.8)).toBeGreaterThan(0.2);
    expect(polyDist(poly, 0.85, 0)).toBeGreaterThan(0.1); // за уголком — снаружи, а не на «хвосте»
  });
});

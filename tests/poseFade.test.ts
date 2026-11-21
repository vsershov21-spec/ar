import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { PoseFade } from '../src/character/poseFade';

/** цепочка «таз — плечо — предплечье» */
function rig() {
  const hips = new THREE.Bone();
  hips.name = 'Hips';
  const arm = new THREE.Bone();
  arm.name = 'RightArm';
  const fore = new THREE.Bone();
  fore.name = 'RightForeArm';
  hips.add(arm);
  arm.add(fore);
  return { hips, arm, fore };
}
const ang = (a: THREE.Quaternion, b: THREE.Quaternion) => 2 * Math.acos(Math.min(1, Math.abs(a.dot(b))));

describe('PoseFade: снятый слой позы уходит к клипу плавно', () => {
  it('без release — только снимок, поза не меняется', () => {
    const { hips, arm } = rig();
    const pf = new PoseFade(hips);
    arm.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.3);
    pf.apply(1 / 30);
    expect(ang(arm.quaternion, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.3))).toBeLessThan(1e-6);
  });

  it('IK-поза (1,6 рад) снята за кадр: скорость ≤ 13 рад/с, к клипу за ≤ 0,5 с', () => {
    const { hips, arm } = rig();
    const pf = new PoseFade(hips);
    const dt = 1 / 30;
    const ik = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.6);
    // слой держит лапу
    for (let i = 0; i < 5; i++) {
      arm.quaternion.copy(ik);
      pf.apply(dt);
    }
    pf.release();
    let last = arm.quaternion.clone(), peak = 0, t = 0;
    for (let i = 0; i < 30; i++) {
      arm.quaternion.identity(); // клип без слоя
      pf.apply(dt);
      t += dt;
      peak = Math.max(peak, ang(last, arm.quaternion) / dt);
      last = arm.quaternion.clone();
    }
    expect(peak).toBeLessThan(13);
    expect(ang(arm.quaternion, new THREE.Quaternion())).toBeLessThan(1e-4);
    expect(pf.dbg.dur).toBeLessThanOrEqual(0.5);
    expect(pf.dbg.jump).toBeCloseTo(1.6, 2);
  });

  it('таз (позиция) тоже уходит плавно', () => {
    const { hips } = rig();
    const pf = new PoseFade(hips);
    hips.position.set(0.05, 0, 0);
    pf.apply(1 / 30);
    pf.release();
    hips.position.set(0, 0, 0);
    pf.apply(1 / 30);
    expect(hips.position.x).toBeGreaterThan(0.045);
  });
});

/**
 * BodyCollider: руки и голени не проходят сквозь тело и одежду (прокси), коррекция без скачков, карманы, нога о ногу,
 * прокси из экспорта модельщика (<кот>_colliders.json).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BodyCollider, CAT_MM, proxyDepth, worstPair, type Proxy } from '../src/character/bodyCollide';

const bone = (name: string, parent: THREE.Object3D, pos: [number, number, number]) => {
  const b = new THREE.Bone();
  b.name = name;
  b.position.set(...pos);
  parent.add(b);
  return b;
};

/** кот ростом 1: торс-эллипсоид у Spine1, левая рука вбок, ноги вниз */
function rig() {
  const root = new THREE.Group();
  const hips = bone('Hips', root, [0, 0.45, 0]);
  const spine1 = bone('Spine1', hips, [0, 0.15, 0]);
  const head = bone('Head', spine1, [0, 0.25, 0]);
  const arm = bone('LeftArm', spine1, [0.17, 0.1, 0]);
  const fore = bone('LeftForeArm', arm, [0.12, 0, 0]);
  const hand = bone('LeftHand', fore, [0.1, 0, 0]);
  const legs: Record<string, THREE.Bone> = {};
  for (const [S, x] of [['Left', 0.07], ['Right', -0.07]] as const) {
    legs[S + 'UpLeg'] = bone(S + 'UpLeg', hips, [x, -0.02, 0]);
    legs[S + 'Leg'] = bone(S + 'Leg', legs[S + 'UpLeg'], [0, -0.2, 0]);
    legs[S + 'Foot'] = bone(S + 'Foot', legs[S + 'Leg'], [0, -0.2, 0]);
  }
  root.updateMatrixWorld(true);
  const by: Record<string, THREE.Object3D> = { Hips: hips, Spine1: spine1, Head: head, LeftArm: arm, LeftForeArm: fore, LeftHand: hand, ...legs };
  const col = new BodyCollider(root, (n) => by[n]);
  const ell = (name: string, b: THREE.Object3D, c: [number, number, number], r: [number, number, number]): Proxy => ({ name, kind: 'ellipsoid', bone: b, center: new THREE.Vector3(...c), radii: new THREE.Vector3(...r), a: new THREE.Vector3(), b: new THREE.Vector3(), r: 0, src: 'mesh' });
  const cap = (name: string, b: THREE.Object3D, e: [number, number, number], r: number, skip: RegExp): Proxy => ({ name, kind: 'capsule', bone: b, center: new THREE.Vector3(), radii: new THREE.Vector3(), a: new THREE.Vector3(), b: new THREE.Vector3(...e), r, skip, src: 'bones' });
  col.proxies = [
    ell('torso', spine1, [0, 0, 0], [0.15, 0.2, 0.12]),
    ell('head', head, [0, 0.1, 0], [0.16, 0.14, 0.14]),
    ell('cap', head, [0, 0.02, 0], [0.17, 0.1, 0.16]),
    cap('thigh_L', legs.LeftUpLeg, [0, -0.2, 0], 0.05, /^L(Shin|Knee)$/),
    cap('shin_L', legs.LeftLeg, [0, -0.2, 0], 0.045, /^L(Shin|Knee)$/),
    cap('thigh_R', legs.RightUpLeg, [0, -0.2, 0], 0.05, /^R(Shin|Knee)$/),
    cap('shin_R', legs.RightLeg, [0, -0.2, 0], 0.045, /^R(Shin|Knee)$/),
  ];
  return { root, col, arm, fore, hand, legs, spine1 };
}
const mm = (d: number) => d * CAT_MM;

describe('BodyCollider', () => {
  it('рука в торсе (обнимает себя сквозь худи) → выталкивается на поверхность', () => {
    const r = rig();
    // плечо вперёд-внутрь, локоть согнут: кисть уходит в живот
    r.arm.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 2.6);
    r.fore.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.6);
    r.root.updateMatrixWorld(true);
    const before = worstPair(r.col.measurePairs());
    expect(mm(before.depth)).toBeGreaterThan(2);
    expect(before.pair).toMatch(/^L(Hand|ForeArm|Elbow|UpperArm):torso$/);
    r.col.apply(0);
    expect(r.col.hits).toBeGreaterThan(0);
    expect(mm(r.col.measure())).toBeLessThan(2);
  });

  it('кисть над головой сквозь кепку → наружу', () => {
    const r = rig();
    r.arm.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 1.9);
    r.fore.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.9);
    r.root.updateMatrixWorld(true);
    const p = worstPair(r.col.measurePairs());
    expect(p.pair).toMatch(/:(head|cap)$/);
    const d0 = mm(p.depth);
    r.col.apply(0);
    // кисть зажата между кепкой и торсом (у шеи) — выходит вбок; остаток в пределах порога стенда (2 мм)
    expect(mm(r.col.measure())).toBeLessThan(2);
    expect(mm(r.col.measure())).toBeLessThan(d0 / 3);
  });

  it('уходящая поправка гаснет плавно (без щелчка), растущая — сразу', () => {
    const r = rig();
    const deep = () => {
      r.arm.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 2.6);
      r.fore.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.6);
    };
    deep();
    r.root.updateMatrixWorld(true);
    r.col.apply(1 / 30);
    const corrected = r.fore.quaternion.clone().premultiply(r.arm.quaternion);
    // следующий кадр: клип вышел из тела (рука вбок) — поправка не пропадает за кадр
    r.arm.quaternion.identity();
    r.fore.quaternion.identity();
    r.root.updateMatrixWorld(true);
    r.col.apply(1 / 30);
    const angle = (q: THREE.Quaternion) => 2 * Math.acos(Math.min(1, Math.abs(q.w)));
    const a1 = angle(r.arm.quaternion) + angle(r.fore.quaternion);
    expect(a1).toBeGreaterThan(0.05);
    for (let i = 0; i < 30; i++) {
      r.arm.quaternion.identity();
      r.fore.quaternion.identity();
      r.root.updateMatrixWorld(true);
      r.col.apply(1 / 30);
    }
    expect(angle(r.arm.quaternion) + angle(r.fore.quaternion)).toBeLessThan(0.01);
    expect(corrected.w).toBeLessThan(1);
  });

  it('карман — разрешённая зона: кисть у входа без зазора, глубже — выталкивается', () => {
    const r = rig();
    const pocketC = new THREE.Vector3(0.1, -0.12, 0.1);
    r.col.pockets = [{ bone: r.spine1, center: pocketC, r: 0.06 }];
    // кисть ровно на поверхности торса в зоне кармана: с зазором толкали бы, в кармане — нет
    r.arm.quaternion.identity();
    r.fore.quaternion.identity();
    r.root.updateMatrixWorld(true);
    const surf = new THREE.Vector3(0.1, -0.12, 0.1);
    const e = r.col.proxies[0];
    const k = 1 / Math.sqrt((surf.x / e.radii.x) ** 2 + (surf.y / e.radii.y) ** 2 + (surf.z / e.radii.z) ** 2);
    const onSurf = surf.multiplyScalar(k * 1.01).applyMatrix4(r.spine1.matrixWorld);
    expect(proxyDepth(e, onSurf, 0)).toBe(0);
    expect(proxyDepth(e, onSurf, 0.028)).toBeGreaterThan(0); // вне кармана зазор бы толкнул
    const inner = new THREE.Vector3(0.05, -0.06, 0.05).applyMatrix4(r.spine1.matrixWorld);
    expect(proxyDepth(e, inner, 0)).toBeGreaterThan(0.02); // «рука в кармане» внутри торса — проникновение
  });

  it('нога сквозь ногу (скрестил) → бедро отводится; своя нога себе не мешает', () => {
    const r = rig();
    expect(r.col.measure()).toBe(0); // стойка: ничего
    r.legs.LeftUpLeg.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -0.5);
    r.root.updateMatrixWorld(true);
    const p = worstPair(r.col.measurePairs());
    expect(p.pair).toMatch(/^(L(Shin|Knee):(thigh|shin)_R|R(Shin|Knee):(thigh|shin)_L)$/);
    r.col.apply(0);
    expect(r.col.measurePairs()).toEqual({});
    expect(mm(r.col.measure())).toBeLessThan(2);
  });

  it('прокси одежды прячутся вместе с мешем (чужой характер)', () => {
    const r = rig();
    const mesh = new THREE.Object3D();
    r.col.proxies[2].mesh = mesh; // кепка
    r.arm.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 1.9);
    r.fore.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.9);
    r.root.updateMatrixWorld(true);
    const withCap = Object.keys(r.col.measurePairs()).some((k) => k.endsWith(':cap'));
    mesh.visible = false;
    const noCap = Object.keys(r.col.measurePairs()).some((k) => k.endsWith(':cap'));
    expect(withCap).toBe(true);
    expect(noCap).toBe(false);
  });

  it('прокси из <кот>_colliders.json: капсула и эллипсоид в пространстве модели', () => {
    const r = rig();
    const n = r.col.build(r.root, {
      version: 1,
      volumes: [
        { name: 'torso', bone: 'Spine1', type: 'ellipsoid', center: [0, 0.6, 0], radii: [0.15, 0.2, 0.12] },
        { name: 'headphones', bone: 'Head', type: 'capsule', a: [-0.1, 0.82, 0], b: [0.1, 0.82, 0], r: 0.04 },
        { name: 'skirt', bone: 'Hips', type: 'hull', points: [[0.15, 0.4, 0.15], [-0.15, 0.4, -0.15], [0, 0.3, 0]] },
      ],
      pockets: [{ bone: 'Spine1', center: [0.1, 0.5, 0.1], r: 0.05 }],
    });
    expect(r.col.source).toBe('json');
    expect(n).toEqual(['torso', 'headphones', 'skirt']);
    expect(r.col.pockets.length).toBe(1);
    // центр торса из модели (0, 0,6, 0) — в системе Spine1 (0,6 над полом) это (0, 0, 0)
    expect(r.col.proxies[0].center.length()).toBeCloseTo(0, 5);
  });
});

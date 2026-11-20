/**
 * Позы поверх клипа: IK двух костей, самая низкая точка тела (ground clamp), шаблон «держать предмет», скейт.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { lowestPoint, twoBoneIK, curlFingers, type GroundVolume } from '../src/character/limbIK';
import { BITES, HOLD_SPECS, PHASES, SIPS, holdDuration, holdPose } from '../src/character/holdAction';
import { BOARD, FEET_ON_DECK, SKATE_T, SKATE_TOTAL, RIDE_FROM, RIDE_TO, makeSkateboard, setSkateFit, skatePose } from '../src/character/skateRig';
import { canonQ, principalAxes } from '../src/character/props';

function arm() {
  const root = new THREE.Group();
  const s = new THREE.Bone(), e = new THREE.Bone(), h = new THREE.Bone(), tip = new THREE.Bone();
  root.add(s);
  s.position.set(0, 1, 0);
  s.add(e);
  e.position.set(0.3, 0, 0);
  e.add(h);
  h.position.set(0.3, 0, 0);
  h.add(tip);
  tip.position.set(0.05, 0, 0);
  root.updateMatrixWorld(true);
  return { root, s, e, h };
}

describe('twoBoneIK', () => {
  it('дотягивается до цели в пределах длины, локоть в сторону полюса', () => {
    const { s, e, h } = arm();
    const T = new THREE.Vector3(0.25, 0.75, 0.2);
    const miss = twoBoneIK(s, e, h, T, new THREE.Vector3(0, -1, 0), 1);
    expect(miss).toBeLessThan(0.002);
    const ep = e.getWorldPosition(new THREE.Vector3());
    // локоть ниже прямой плечо–цель (полюс вниз)
    const sp = s.getWorldPosition(new THREE.Vector3());
    const mid = sp.clone().lerp(T, 0.5);
    expect(ep.y).toBeLessThan(mid.y + 1e-3);
  });
  it('дальняя цель — тянется по прямой, без NaN', () => {
    const { s, e, h } = arm();
    const miss = twoBoneIK(s, e, h, new THREE.Vector3(2, 1, 0), null, 1);
    expect(Number.isFinite(miss)).toBe(true);
    expect(h.getWorldPosition(new THREE.Vector3()).x).toBeGreaterThan(0.55);
  });
});

describe('lowestPoint (ground clamp)', () => {
  it('эллипсоид с поворотом кости: низ = центр − высота по Y', () => {
    const space = new THREE.Group();
    const b = new THREE.Bone();
    space.add(b);
    b.position.set(0, 0.5, 0);
    b.rotation.z = Math.PI / 2; // ось X кости стала вертикальной
    space.updateMatrixWorld(true);
    const v: GroundVolume = { bone: b, kind: 'ellipsoid', center: new THREE.Vector3(0, 0, 0), radii: new THREE.Vector3(0.3, 0.1, 0.1), r: 0, name: 'head' };
    expect(lowestPoint([v], space).y).toBeCloseTo(0.2, 5);
    b.position.y = 0.1;
    space.updateMatrixWorld(true);
    const lp = lowestPoint([v, { bone: b, kind: 'sphere', r: 0.02, name: 'hand' }], space);
    expect(lp.y).toBeCloseTo(-0.2, 5);
    expect(lp.name).toBe('head');
  });
});

describe('curlFingers', () => {
  it('фаланги сгибаются к ладони', () => {
    const root = new THREE.Group();
    const f1 = new THREE.Bone(), f2 = new THREE.Bone(), f3 = new THREE.Bone();
    root.add(f1);
    f1.add(f2);
    f2.position.set(0, 0.03, 0);
    f2.add(f3);
    f3.position.set(0, 0.03, 0);
    root.updateMatrixWorld(true);
    curlFingers([[f1, f2]], new THREE.Vector3(0, 0, 1), 1);
    expect(f3.getWorldPosition(new THREE.Vector3()).z).toBeGreaterThan(0.02);
  });
});

describe('шаблон «держать предмет»', () => {
  it('фазы по порядку, предмет появляется и убирается, лапа возвращается к клипу', () => {
    for (const [id, s] of Object.entries(HOLD_SPECS)) {
      const T = holdDuration(s);
      const seen: string[] = [];
      let prevScale = 0;
      for (let t = 0; t < T + 0.2; t += 1 / 30) {
        const f = holdPose(s, t);
        if (seen[seen.length - 1] !== f.phase) seen.push(f.phase);
        // без скачков масштаба
        expect(Math.abs(f.scale - prevScale), `${id} ${t.toFixed(2)}`).toBeLessThan(0.25);
        prevScale = f.scale;
      }
      expect(seen).toEqual([...PHASES, 'done']);
      expect(holdPose(s, 0).w).toBeLessThan(0.05);
      expect(holdPose(s, T - 0.01).w).toBeLessThan(0.05);
      // во время «use» лапа у рта/лица
      expect(holdPose(s, s.t.take + s.t.raise + s.t.use / 2).toMouth).toBe(1);
    }
  });
  it('какао: два глотка с прищуром «^^», потом «ах»; пар всё время в лапе', () => {
    const s = HOLD_SPECS.cocoa;
    const u0 = s.t.take + s.t.raise;
    for (const [a, b] of SIPS) {
      const f = holdPose(s, u0 + (a + b) / 2);
      expect(f.tilt).toBeGreaterThan(0.4);
      expect(f.face.eyes_laugh).toBeGreaterThan(0.6);
    }
    const ah = holdPose(s, u0 + s.t.use - 0.4);
    expect(ah.face.mouth_A).toBeGreaterThan(0.4);
    expect(ah.headPitch).toBeLessThan(0.05);
    expect(holdPose(s, u0 + 0.1).steam).toBeGreaterThan(0.5);
  });
  it('рыбка: два укуса — откушенное растёт, между укусами жуёт; зеркальце: бант, подмигнуть, «чмок»', () => {
    const s = HOLD_SPECS.treat;
    const u0 = s.t.take + s.t.raise;
    const e1 = holdPose(s, u0 + BITES[0] + 0.3).eaten, e2 = holdPose(s, u0 + BITES[1] + 0.3).eaten;
    expect(e1).toBeGreaterThan(0.2);
    expect(e2).toBeGreaterThan(e1 + 0.2);
    expect(holdPose(s, u0 + (BITES[0] + BITES[1]) / 2).face.cheeks_gum).toBeGreaterThan(0.3);
    const m = HOLD_SPECS.mirror, m0 = m.t.take + m.t.raise;
    expect(holdPose(m, m0 + 1.4).bow).toBeGreaterThan(0.9);
    expect(holdPose(m, m0 + 2.3).face.wink_R).toBeGreaterThan(0.9);
    expect(holdPose(m, m0 + 2.8).face.mouth_U).toBeGreaterThan(0.9);
    // искра — при появлении и уходе
    expect(holdPose(m, 0.25).spark).toBeGreaterThan(0);
    expect(holdPose(m, holdDuration(m) - 0.2).spark).toBeGreaterThan(0);
  });
  it('какао: глоток — кружка наклоняется, голова к кружке', () => {
    const s = HOLD_SPECS.cocoa;
    const f = holdPose(s, s.t.take + s.t.raise + s.t.use / 2);
    expect(f.tilt).toBeGreaterThan(0.4);
    expect(f.headPitch).toBeGreaterThan(0);
  });
});

describe('скейт', () => {
  it('порядок фаз и длительность', () => {
    const seen: string[] = [];
    for (let t = 0; t < SKATE_TOTAL + 0.1; t += 1 / 30) {
      const p = skatePose(t).phase;
      if (seen[seen.length - 1] !== p) seen.push(p);
    }
    expect(seen).toEqual(['conjure', 'place', 'hop', 'push', 'ride', 'ollie', 'flip', 'roll', 'hopoff', 'kickup', 'vanish', 'done']);
    expect(RIDE_TO - RIDE_FROM).toBeCloseTo(SKATE_T.push + SKATE_T.ride + SKATE_T.ollie + SKATE_T.flip + SKATE_T.roll, 5);
    expect(SKATE_TOTAL).toBeLessThan(7.5);
  });
  it('доска не отлетает: положение и масштаб меняются плавно (кадр 1/30 с)', () => {
    let prev = skatePose(0);
    let pb = prev.board.clone(), ps = prev.boardScale;
    for (let t = 1 / 30; t < SKATE_TOTAL; t += 1 / 30) {
      const f = skatePose(t);
      // подлёт доски из-под стопы (kickup) — быстрый, но непрерывный: до 5 см за кадр
      if (f.carry < 0.01 && prev.carry < 0.01) expect(f.board.distanceTo(pb), `t=${t.toFixed(2)} ${f.phase}`).toBeLessThan(f.phase === 'kickup' ? 0.05 : 0.03);
      expect(Math.abs(f.boardScale - ps)).toBeLessThan(0.2);
      pb = f.board.clone();
      ps = f.boardScale;
      prev = f;
    }
  });
  it('на деке стопы — IK (вес 1), тело поднято на высоту деки; олли и кикфлип — в воздухе, оборот доски', () => {
    const f = skatePose(RIDE_FROM + SKATE_T.push + SKATE_T.ride / 2);
    expect(f.phase).toBe('ride');
    expect(f.feetW).toBe(1);
    expect(f.standOn).toBeCloseTo(BOARD.deck, 6);
    expect(f.leanK).toBe(1);
    const o = skatePose(RIDE_FROM + SKATE_T.push + SKATE_T.ride + SKATE_T.ollie * 0.55);
    expect(o.phase).toBe('ollie');
    expect(o.lift).toBeGreaterThan(0.08);
    expect(o.board.y).toBeGreaterThan(0.08);
    const flipEnd = skatePose(RIDE_FROM + SKATE_T.push + SKATE_T.ride + SKATE_T.ollie + SKATE_T.flip * 0.95);
    expect(flipEnd.roll).toBeCloseTo(Math.PI * 2, 3);
    const mid = skatePose(RIDE_FROM + SKATE_T.push + SKATE_T.ride + SKATE_T.ollie + SKATE_T.flip * 0.55);
    expect(mid.feetUp).toBeGreaterThan(0.03);
  });
  it('появление и уход — из лапы с искрой; kickup — доска встаёт и в лапу', () => {
    expect(skatePose(0.2).carry).toBe(1);
    expect(skatePose(0.2).spark).toBeGreaterThan(0);
    const t0 = SKATE_TOTAL - SKATE_T.vanish - SKATE_T.kickup;
    expect(skatePose(t0 + SKATE_T.kickup * 0.2).kick).toBeGreaterThan(0.5);
    expect(skatePose(t0 + SKATE_T.kickup * 0.99).carry).toBeGreaterThan(0.95);
    expect(skatePose(t0 + SKATE_T.kickup * 0.6).pitch).toBeGreaterThan(1);
    expect(skatePose(SKATE_TOTAL - 0.01).boardScale).toBeLessThan(0.05);
  });
  it('размер доски по лапам: длина ≈ стойка + стопа с запасом, стопы на деке', () => {
    setSkateFit(0.1, 0.15);
    expect(BOARD.len).toBeCloseTo(0.3375, 3);
    expect(FEET_ON_DECK.front.z + 0.05).toBeLessThan(BOARD.len / 2);
    expect(-FEET_ON_DECK.back.z).toBeLessThan(BOARD.len / 2);
    const g = makeSkateboard();
    const box = new THREE.Box3().setFromObject(g);
    expect(box.min.y).toBeGreaterThan(-1e-3);
    expect(box.max.y).toBeGreaterThan(BOARD.deck - 1e-3);
    expect(box.getSize(new THREE.Vector3()).z).toBeCloseTo(BOARD.len, 2);
    let wheels = 0;
    g.traverse((o) => o.name === 'wheel' && wheels++);
    expect(wheels).toBe(4);
  });
});

describe('канон модели под углом (зеркальце Tripo)', () => {
  it('длинная ось → +Y, узкий конец (ручка) — вниз, тонкая ось → Z', () => {
    // «зеркальце»: диск r=0.4 + ручка 0.6 вдоль диагонали
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < 400; i++) {
      const a = (i / 400) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * 0.4 * Math.random(), 0.8 + Math.sin(a) * 0.4 * Math.random(), 0.01 * (i % 2)));
    }
    for (let i = 0; i < 200; i++) pts.push(new THREE.Vector3(0.01 * (i % 3), (i / 200) * 0.45, 0));
    const R = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.7, 0.4, -0.6));
    const geo = new THREE.BufferGeometry().setFromPoints(pts.map((p) => p.clone().applyQuaternion(R)));
    const obj = new THREE.Mesh(geo);
    const pa = principalAxes(pts);
    expect(Math.abs(pa.axes[0].y)).toBeGreaterThan(0.9);
    obj.quaternion.copy(canonQ(obj));
    obj.updateMatrixWorld(true);
    const handle = new THREE.Vector3(0, 0.05, 0).applyQuaternion(R).applyMatrix4(obj.matrixWorld);
    const head = new THREE.Vector3(0, 0.9, 0).applyQuaternion(R).applyMatrix4(obj.matrixWorld);
    expect(head.y - handle.y).toBeGreaterThan(0.6);
  });
});

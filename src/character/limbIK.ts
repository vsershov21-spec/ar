/**
 * Общие помощники позы поверх клипа: поворот кости вокруг мировой оси, IK двух костей (плечо→локоть→кисть,
 * бедро→колено→стопа) с полюсом, сжатие пальцев в кулак (хват за ручку), самая низкая точка тела по прокси.
 * Используют holdAction.ts (держать предмет), skateRig.ts (ноги на деке), glbCharacter.ts (ground clamp).
 * Без DOM: работает на THREE.Object3D — tests/limbIK.test.ts.
 */
import * as THREE from 'three';

const qa = new THREE.Quaternion();
const qb = new THREE.Quaternion();
const qc = new THREE.Quaternion();
const va = new THREE.Vector3();
const vb = new THREE.Vector3();
const vc = new THREE.Vector3();
const vd = new THREE.Vector3();
const ve = new THREE.Vector3();
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** повернуть кость b вокруг оси axis (мир, единичная) на angle — с учётом родителя */
export function rotWorld(b: THREE.Object3D, axis: THREE.Vector3, angle: number) {
  if (!angle || !b.parent) return;
  b.parent.updateWorldMatrix(true, false);
  const pq = b.parent.getWorldQuaternion(qa);
  const d = qb.setFromAxisAngle(axis, angle);
  const local = qc.copy(pq).invert().multiply(d).multiply(pq);
  b.quaternion.premultiply(local);
  b.updateMatrixWorld(true);
}

/** повернуть кость так, чтобы направление from (мир) стало to (мир), с весом w */
export function aimBone(b: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3, w = 1) {
  const f = va.copy(from).normalize(), t = vb.copy(to).normalize();
  const ang = Math.acos(clamp(f.dot(t), -1, 1));
  if (ang < 1e-5) return;
  const ax = vc.copy(f).cross(t);
  if (ax.lengthSq() < 1e-12) return;
  rotWorld(b, ax.normalize(), ang * w);
}

/**
 * IK двух костей: root (плечо/бедро) → mid (локоть/колено) → end (кисть/стопа) к цели target (мир).
 * pole (мир, направление от root) — куда смотрит сгиб (локоть вниз-наружу, колено вперёд). w — вес 0…1.
 * Возвращает недолёт до цели (мир), 0 — дотянулся.
 */
export function twoBoneIK(root: THREE.Object3D, mid: THREE.Object3D, end: THREE.Object3D, target: THREE.Vector3, pole: THREE.Vector3 | null, w = 1): number {
  if (w <= 0.001) return 0;
  root.updateWorldMatrix(true, true);
  const s = root.getWorldPosition(new THREE.Vector3());
  const e = mid.getWorldPosition(new THREE.Vector3());
  const h = end.getWorldPosition(new THREE.Vector3());
  const a = s.distanceTo(e), b = e.distanceTo(h);
  if (a < 1e-6 || b < 1e-6) return 0;
  const reach = (a + b) * 0.999;
  const T = new THREE.Vector3().copy(target);
  const st = vd.copy(T).sub(s);
  if (st.length() > reach) T.copy(s).addScaledVector(st.normalize(), reach);
  const d = clamp(s.distanceTo(T), Math.abs(a - b) + 1e-5, reach);
  // 1) сгиб среднего сустава: угол между звеньями по теореме косинусов
  const u = new THREE.Vector3().copy(e).sub(s).normalize();
  const l = new THREE.Vector3().copy(h).sub(e).normalize();
  const bend = Math.acos(clamp(u.dot(l), -1, 1));
  const want = Math.PI - Math.acos(clamp((a * a + b * b - d * d) / (2 * a * b), -1, 1));
  const n = u.clone().cross(l);
  if (n.lengthSq() < 1e-10) {
    // прямая конечность: ось сгиба — поперёк полюса
    if (pole) n.copy(u).cross(pole);
    if (n.lengthSq() < 1e-10) n.set(1, 0, 0);
  }
  n.normalize();
  rotWorld(mid, n, (want - bend) * w);
  // 2) корень: направление корень→конец на цель
  const h2 = end.getWorldPosition(new THREE.Vector3());
  aimBone(root, h2.sub(s), ve.copy(T).sub(s), w);
  // 3) полюс: поворот вокруг оси корень→цель, чтобы средний сустав смотрел в сторону полюса
  if (pole && pole.lengthSq() > 1e-10) {
    const axis = new THREE.Vector3().copy(T).sub(s).normalize();
    const m = mid.getWorldPosition(new THREE.Vector3()).sub(s);
    m.addScaledVector(axis, -m.dot(axis));
    const p = pole.clone().addScaledVector(axis, -pole.dot(axis));
    if (m.lengthSq() > 1e-10 && p.lengthSq() > 1e-10) {
      m.normalize();
      p.normalize();
      const ang = Math.acos(clamp(m.dot(p), -1, 1));
      const sgn = Math.sign(m.clone().cross(p).dot(axis)) || 1;
      rotWorld(root, axis, sgn * ang * w);
    }
  }
  return end.getWorldPosition(new THREE.Vector3()).distanceTo(target);
}

/**
 * Хват: пальцы сжимаются к ладони (k 0…1). palmN — нормаль ладони в мире (куда смотрит подушечка), fingers —
 * фаланги [1,2,3] по каждому пальцу. Ось сгиба каждой фаланги — поперёк направления пальца к ладони.
 */
export function curlFingers(fingers: THREE.Object3D[][], palmN: THREE.Vector3, k: number, maxRad = 1.25) {
  if (k <= 0.001) return;
  for (const chain of fingers) {
    for (let i = 0; i < chain.length; i++) {
      const b = chain[i];
      const c = b.children.find((x) => (x as THREE.Bone).isBone);
      if (!c) continue;
      b.updateWorldMatrix(true, true);
      const p0 = b.getWorldPosition(new THREE.Vector3()), p1 = c.getWorldPosition(new THREE.Vector3());
      const dir = p1.sub(p0);
      if (dir.lengthSq() < 1e-12) continue;
      dir.normalize();
      const ax = dir.clone().cross(palmN);
      if (ax.lengthSq() < 1e-10) continue;
      rotWorld(b, ax.normalize(), k * maxRad * (i === 0 ? 0.8 : 1));
    }
  }
}

/** объём тела для «пола»: эллипсоид (полуоси) или капсула в системе кости */
export interface GroundVolume {
  bone: THREE.Object3D;
  kind: 'ellipsoid' | 'capsule' | 'sphere';
  center?: THREE.Vector3;
  radii?: THREE.Vector3;
  a?: THREE.Vector3;
  b?: THREE.Vector3;
  r: number;
  name: string;
}

const m4 = new THREE.Matrix4();
const m4b = new THREE.Matrix4();

/**
 * Самая низкая точка объёмов в системе space (персонаж: рост 1, опора y = 0): эллипсоид — центр минус «высота»
 * эллипсоида вдоль оси Y space (точно, с поворотом и масштабом кости), капсула — нижний конец минус радиус.
 * Возвращает y и имя объёма.
 */
export function lowestPoint(vols: readonly GroundVolume[], space: THREE.Object3D): { y: number; name: string } {
  space.updateWorldMatrix(true, false);
  const inv = m4b.copy(space.matrixWorld).invert();
  let best = Infinity, name = '';
  for (const v of vols) {
    v.bone.updateWorldMatrix(true, false);
    const M = m4.multiplyMatrices(inv, v.bone.matrixWorld);
    const e = M.elements; // столбцы: e[0..2] — ось X, e[4..6] — Y, e[8..10] — Z; строка Y: e[1], e[5], e[9]
    let y: number;
    if (v.kind === 'ellipsoid' && v.center && v.radii) {
      const c = va.copy(v.center).applyMatrix4(M);
      const hy = Math.hypot(e[1] * v.radii.x, e[5] * v.radii.y, e[9] * v.radii.z);
      y = c.y - hy;
    } else if (v.kind === 'capsule' && v.a && v.b) {
      const s = Math.cbrt(Math.abs(M.determinant())) || 1;
      y = Math.min(va.copy(v.a).applyMatrix4(M).y, vb.copy(v.b).applyMatrix4(M).y) - v.r * s;
    } else {
      // sphere: центр — начало кости, радиус в долях роста (уже в space)
      y = va.set(0, 0, 0).applyMatrix4(M).y - v.r;
    }
    if (y < best) {
      best = y;
      name = v.name;
    }
  }
  return { y: best, name };
}

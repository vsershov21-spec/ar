/**
 * Проникновение предмета в кота (QA, продакт 26.11: «предметы держат очень криво, они проникают в руки»): точки сетки
 * кота (тело, подушечки лап, одежда — без меха-оболочек и глаз) после скиннинга, оказавшиеся внутри предмета, и их
 * глубина до поверхности предмета. Внутри — по чётности пересечений луча с треугольниками предмета (три оси,
 * большинство: модели Tripo не всегда замкнуты), глубина — до ближайшего треугольника.
 *
 * Часть: «палец» (кости Hand{Thumb,Index,Middle,Ring,Pinky}*), «кисть» (Hand), «тело» — всё остальное (предплечье,
 * торс, голова, одежда). Цифры — в долях роста кота (QA переводит в мм карты).
 * mouthOk — действие «ко рту» (какао, рыбка, жвачка): точки головы в предмете — это рот, считаются отдельно (mouth).
 * Не для каждого кадра на телефоне: стенд (anim-audit, props-grip) зовёт GlbCharacter.propPen() на снимках.
 */
import * as THREE from 'three';

export type PenPart = 'finger' | 'hand' | 'body';
export interface PropPen {
  /** наибольшая глубина (доли роста кота); 0 — нет проникновения */
  depth: number;
  part: PenPart | '';
  bone: string;
  /** сколько точек кота внутри предмета */
  n: number;
  /** то же по частям: глубина */
  byPart: Record<PenPart, number>;
  /** предмет в голове у рта (глоток, укус) — по замыслу, не считается (mouthOk) */
  mouth: number;
}

interface BodyMesh {
  mesh: THREE.SkinnedMesh;
  idx: Uint32Array;
  part: PenPart[];
  bone: string[];
}

/** меши кота, которые считаются «телом»: основной меш, подушечки, одежда, юбка; без меха, глаз, век, рта */
const SKIP = /fur|shell|card|blush|eye|lid|tear|brow|whisk|tuft|mouth|emotion|emblem/i;

export function bodyMeshes(model: THREE.Object3D): BodyMesh[] {
  const out: BodyMesh[] = [];
  model.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh || SKIP.test(m.name) || SKIP.test(m.parent?.name ?? '')) return;
    const si = m.geometry.getAttribute('skinIndex') as THREE.BufferAttribute | undefined;
    const sw = m.geometry.getAttribute('skinWeight') as THREE.BufferAttribute | undefined;
    const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!si || !sw || !pos) return;
    const idx: number[] = [];
    const part: PenPart[] = [];
    const bone: string[] = [];
    for (let i = 0; i < pos.count; i++) {
      let best = 0, bw = -1;
      for (let k = 0; k < 4; k++) {
        const w = sw.getComponent(i, k);
        if (w > bw) [bw, best] = [w, si.getComponent(i, k)];
      }
      const name = (m.skeleton.bones[best]?.name ?? '').replace(/^mixamorig:?/, '');
      idx.push(i);
      part.push(/Hand(Thumb|Index|Middle|Ring|Pinky)/.test(name) ? 'finger' : /Hand$/.test(name) ? 'hand' : 'body');
      bone.push(name);
    }
    out.push({ mesh: m, idx: Uint32Array.from(idx), part, bone });
  });
  return out;
}

/** треугольники предмета в мире (видимые меши) */
function propTris(prop: THREE.Object3D): THREE.Triangle[] {
  const tris: THREE.Triangle[] = [];
  prop.updateWorldMatrix(true, true);
  prop.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.visible) return;
    const g = m.geometry;
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const ix = g.getIndex();
    const n = ix ? ix.count : pos.count;
    const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    for (let i = 0; i + 2 < n; i += 3) {
      for (let k = 0; k < 3; k++) v[k].fromBufferAttribute(pos, ix ? ix.getX(i + k) : i + k).applyMatrix4(m.matrixWorld);
      tris.push(new THREE.Triangle(v[0].clone(), v[1].clone(), v[2].clone()));
    }
  });
  return tris;
}

const DIRS = [new THREE.Vector3(1, 0.0013, 0.0007).normalize(), new THREE.Vector3(0.0011, 1, 0.0017).normalize(), new THREE.Vector3(0.0019, 0.0005, 1).normalize()];
const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), pv = new THREE.Vector3(), tv = new THREE.Vector3(), qv = new THREE.Vector3();

/** луч o + t·d (t > 0) пересекает треугольник */
function hits(o: THREE.Vector3, d: THREE.Vector3, t: THREE.Triangle): boolean {
  e1.subVectors(t.b, t.a);
  e2.subVectors(t.c, t.a);
  pv.crossVectors(d, e2);
  const det = e1.dot(pv);
  if (Math.abs(det) < 1e-14) return false;
  const inv = 1 / det;
  tv.subVectors(o, t.a);
  const u = tv.dot(pv) * inv;
  if (u < 0 || u > 1) return false;
  qv.crossVectors(tv, e1);
  const v = d.dot(qv) * inv;
  if (v < 0 || u + v > 1) return false;
  return e2.dot(qv) * inv > 0;
}

/** точка внутри замкнутой (почти) сетки: большинство из трёх лучей с нечётным числом пересечений */
export function insideMesh(p: THREE.Vector3, tris: THREE.Triangle[]): boolean {
  let odd = 0;
  for (const d of DIRS) {
    let c = 0;
    for (const t of tris) if (hits(p, d, t)) c++;
    if (c & 1) odd++;
  }
  return odd >= 2;
}

/**
 * Проникновение предмета prop в кота: body — bodyMeshes(model) (кэшировать), unit — длина «роста кота» в мире
 * (масштаб объекта кота). Шаг stride — каждая n-я точка сетки (стенд: 1–2).
 */
export function propPenetration(prop: THREE.Object3D, body: BodyMesh[], unit: number, stride = 1, mouthOk = false): PropPen {
  const res: PropPen = { depth: 0, part: '', bone: '', n: 0, byPart: { finger: 0, hand: 0, body: 0 }, mouth: 0 };
  const tris = propTris(prop);
  if (!tris.length) return res;
  const box = new THREE.Box3();
  for (const t of tris) box.expandByPoint(t.a).expandByPoint(t.b).expandByPoint(t.c);
  const v = new THREE.Vector3(), cp = new THREE.Vector3();
  for (const b of body) {
    if (!b.mesh.visible) continue;
    b.mesh.updateWorldMatrix(true, false);
    for (let j = 0; j < b.idx.length; j += stride) {
      b.mesh.getVertexPosition(b.idx[j], v);
      v.applyMatrix4(b.mesh.matrixWorld);
      if (!box.containsPoint(v) || !insideMesh(v, tris)) continue;
      let d = Infinity;
      for (const t of tris) {
        t.closestPointToPoint(v, cp);
        d = Math.min(d, cp.distanceToSquared(v));
      }
      const depth = Math.sqrt(d) / unit;
      // предмет у рта по замыслу (глоток, укус, «в рот»): голова — отдельно, в проникновение не идёт
      if (mouthOk && b.bone[j] === 'Head') {
        res.mouth = Math.max(res.mouth, depth);
        continue;
      }
      res.n++;
      const part = b.part[j];
      res.byPart[part] = Math.max(res.byPart[part], depth);
      if (depth > res.depth) [res.depth, res.part, res.bone] = [depth, part, b.bone[j]];
    }
  }
  return res;
}

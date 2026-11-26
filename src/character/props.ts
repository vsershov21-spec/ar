/**
 * Реквизит в лапе на время клипа: мыльные пузыри, какао, зеркальце, снежный шар; кисть и баллончик раскраски карты.
 * Модели — public/models/props/*.glb (Tripo), грузятся лениво при первом клипе; кисть и баллончик — процедурные
 * (make, src/card/paintProps.ts). hold(id) — держать реквизит, пока его не отпустят, при любом клипе (кот идёт по
 * карте с кистью в лапе).
 * Крепление к кости кисти Mixamo: начало кости — запястье, ось +Y кости идёт к пальцам.
 */
import * as THREE from 'three';
import { makeBrush, makeSpray } from '../card/paintProps';
import { makeFish, makeGum } from './holdProps';
import { makeSkateboard } from './skateRig';

export interface PropDef {
  /** GLB-модель (или make — процедурная) */
  url?: string;
  /** процедурный реквизит: части с материалом по имени 'paint' перекрашиваются в hold(id, tint) */
  make?: () => THREE.Object3D;
  /** кость кисти без префикса mixamorig: */
  bone: 'RightHand' | 'LeftHand';
  /** держит двумя лапами — точка хвата посередине между кистями */
  both?: boolean;
  /** высота реквизита в долях роста кота */
  size: number;
  /** смещение от кисти в долях роста кота, в осях персонажа: [вбок, вверх, вперёд к зрителю] */
  offset: [number, number, number];
  /** поворот в осях персонажа, градусы (реквизит стоит вертикально, не крутится вместе с кистью) */
  rot: [number, number, number];
  /** точка хвата по высоте реквизита, доля от низа (по умолчанию 0 — за донышко) */
  grip?: number;
  /**
   * размер от кисти: высота = handK × длина кисти (запястье → кончик среднего пальца, PropRig.handLen); size — запас,
   * пока кисть не измерена. Шаблон «держать предмет» (holdAction.ts): кружка с ладонь, зеркальце — две с половиной кисти.
   */
  handK?: number;
  /**
   * 'pca' — модель Tripo лежит под углом (зеркальце по диагонали): длинная ось → +Y (ручка внизу — более узкий конец),
   * самая «тонкая» ось (нормаль стекла) → +Z
   */
  canon?: 'pca';
  /** не крепить к кисти (доска скейта стоит под лапами — её ставит place) */
  free?: boolean;
  /**
   * ручка кружки: дальний по горизонтали край модели (ручка) поворачивается в −X узла — к ладони (шаблон «держать
   * предмет» ставит узел осью +X от ладони к кружке)
   */
  handle?: boolean;
}

export const PROPS: Record<string, PropDef> = {
  kind_bubbles: { url: 'models/props/bubble_wand.glb', bone: 'RightHand', size: 0.17, offset: [0, -0.02, 0.07], rot: [-15, 0, 10] },
  idle_kind_cocoa: { url: 'models/props/cocoa_mug.glb', bone: 'RightHand', size: 0.08, offset: [0.02, -0.03, 0.08], rot: [0, -30, 0] },
  idle_glitter_mirror: { url: 'models/props/hand_mirror.glb', bone: 'LeftHand', size: 0.16, offset: [0, -0.02, 0.07], rot: [-20, 160, 0] },
  snowglobe_shake: { url: 'models/props/snow_globe.glb', bone: 'RightHand', both: true, size: 0.13, offset: [0, -0.04, 0.05], rot: [0, 0, 0] },
  // раскраска карты (src/card/paint.ts): кисть Добряка и Блёстки, баллончик Хулигана — процедурные
  paint_brush: { make: makeBrush, bone: 'RightHand', size: 0.3, offset: [0, 0.01, 0.05], rot: [140, 0, -15], grip: 0.22 },
  paint_spray: { make: makeSpray, bone: 'RightHand', size: 0.17, offset: [0, 0, 0.05], rot: [12, 0, -10], grip: 0.42 },
  // шаблон «держать предмет» (holdAction.ts): положение и поворот задаёт place() — от ладони, не от клипа
  hold_cocoa: { url: 'models/props/cocoa_mug.glb', bone: 'RightHand', size: 0.1, handK: 1.15, handle: true, offset: [0, 0, 0], rot: [0, 0, 0], grip: 0.45 },
  hold_mirror: { url: 'models/props/hand_mirror.glb', bone: 'LeftHand', size: 0.2, handK: 2.6, canon: 'pca', offset: [0, 0, 0], rot: [0, 0, 0], grip: 0.14 },
  hold_fish: { make: makeFish, bone: 'RightHand', size: 0.17, handK: 2.9, offset: [0, 0, 0], rot: [0, 0, 0], grip: 0.12 },
  hold_gum: { make: makeGum, bone: 'RightHand', size: 0.06, handK: 0.75, offset: [0, 0, 0], rot: [0, 0, 0], grip: 0.15 },
  skateboard: { make: makeSkateboard, bone: 'RightHand', size: 0.068, free: true, offset: [0, 0, 0], rot: [0, 0, 0], grip: 0 },
};

/** ось предмета (после канона/поворота make) и его размеры в системе кота — для хвата (holdAction) */
export interface PropDims {
  /** высота (по Y) и полуширина поперёк (по X/Z), в долях роста кота */
  h: number;
  r: number;
}

/** главные оси облака точек: [длинная, средняя, тонкая] (единичные), центр */
export function principalAxes(pts: THREE.Vector3[]): { axes: THREE.Vector3[]; c: THREE.Vector3 } {
  const c = new THREE.Vector3();
  for (const p of pts) c.add(p);
  c.multiplyScalar(1 / Math.max(1, pts.length));
  const C = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const p of pts) {
    const d = [p.x - c.x, p.y - c.y, p.z - c.z];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i * 3 + j] += d[i] * d[j];
  }
  // степенной метод с исчерпанием — 3×3, хватает
  const axes: THREE.Vector3[] = [];
  const M = C.slice();
  for (let n = 0; n < 3; n++) {
    let v = new THREE.Vector3(1, 0.7 + n * 0.1, 0.3 - n * 0.2).normalize();
    for (const a of axes) v.addScaledVector(a, -v.dot(a));
    v.normalize();
    let lam = 0;
    for (let it = 0; it < 80; it++) {
      const w = new THREE.Vector3(M[0] * v.x + M[1] * v.y + M[2] * v.z, M[3] * v.x + M[4] * v.y + M[5] * v.z, M[6] * v.x + M[7] * v.y + M[8] * v.z);
      for (const a of axes) w.addScaledVector(a, -w.dot(a));
      lam = w.length();
      if (lam < 1e-12) break;
      v = w.multiplyScalar(1 / lam);
    }
    axes.push(v.clone());
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[i * 3 + j] -= lam * v.getComponent(i) * v.getComponent(j);
  }
  return { axes, c };
}

type Loader = (url: string) => Promise<THREE.Object3D>;

export class PropRig {
  private cache = new Map<string, Promise<THREE.Object3D | null>>();
  private active: { clip: string; obj: THREE.Object3D; def: PropDef; hand: THREE.Object3D } | null = null;
  private want = '';
  private v = new THREE.Vector3();
  /** реквизит «в руках» поверх клипа (hold) и его цвет */
  private held: string | null = null;
  private tint: string | null = null;
  private lastClip = '';
  /** раскраска карты (character/toolIK.ts): сопло / кончик кисти смотрит в точку (мир), вес 0…1 */
  private aimP = new THREE.Vector3();
  private aimW = 0;
  private qa = new THREE.Quaternion();
  private qb = new THREE.Quaternion();
  private ma = new THREE.Matrix4();
  private mb = new THREE.Matrix4();
  private va = new THREE.Vector3();
  private vb = new THREE.Vector3();
  private vc = new THREE.Vector3();
  /** длина кисти (запястье → кончик среднего пальца) в системе кота; 0 — не измерена (size из PropDef) */
  handLen = 0;
  /** положение реквизита задано снаружи (holdAction / скейт): позиция и поворот в системе root, масштаб 0…1 */
  private placed: { p: THREE.Vector3; q: THREE.Quaternion; s: number; sy: number } | null = null;
  /** размеры текущего реквизита (после масштаба) */
  dims: PropDims | null = null;

  /** поставить реквизит (holdAction, скейт): null — снова по кисти и клипу; sy — доля длины по оси Y (откушенная рыбка) */
  place(p: THREE.Vector3 | null, q?: THREE.Quaternion, s = 1, sy = 1) {
    if (!p) {
      this.placed = null;
      return;
    }
    this.placed ??= { p: new THREE.Vector3(), q: new THREE.Quaternion(), s: 1, sy: 1 };
    this.placed.p.copy(p);
    if (q) this.placed.q.copy(q);
    this.placed.s = s;
    this.placed.sy = sy;
  }
  /** положение, заданное снаружи сейчас (null — по кисти и клипу) */
  get placedNow(): { s: number } | null {
    return this.placed;
  }
  /** пересобрать процедурный реквизит (размер доски поменялся под кота) */
  rebuild(id: string) {
    const d = PROPS[id];
    if (d?.make) this.cache.delete(`make:${id}`);
    if (this.active?.clip === id) {
      this.active.obj.removeFromParent();
      this.active = null;
      this.want = '';
    }
  }
  /** узел реквизита в сцене (тесты, стенд) */
  get object(): THREE.Object3D | null {
    return this.active?.obj ?? null;
  }
  /** id реквизита на сцене (PROPS) — хват по поверхности (gripSolver.ts) */
  get activeId(): string | null {
    return this.active?.clip ?? null;
  }

  /** навести реквизит: point — куда смотрит сопло (кончик), null — держать как в клипе */
  aim(point: THREE.Vector3 | null, w = 1) {
    if (point) this.aimP.copy(point);
    this.aimW = point ? Math.max(0, Math.min(1, w)) : 0;
  }

  /** сопло баллончика / кончик кисти: точка и направление в мире (нет реквизита с меткой tip — null) */
  tip(): { o: THREE.Vector3; d: THREE.Vector3 } | null {
    const t = this.active?.obj.getObjectByName('tip');
    if (!t) return null;
    t.updateWorldMatrix(true, false);
    const o = t.getWorldPosition(new THREE.Vector3());
    const dl = (t.userData.dir as number[] | undefined) ?? [0, 1, 0];
    const d = new THREE.Vector3(dl[0], dl[1], dl[2]).applyQuaternion(t.getWorldQuaternion(new THREE.Quaternion())).normalize();
    return { o, d };
  }

  /** держать реквизит id при любом клипе (null — отпустить, дальше — по клипу); tint — цвет частей 'paint' */
  hold(id: string | null, tint: string | null = null) {
    this.held = id && PROPS[id] ? id : null;
    this.tint = tint;
    if (this.active) this.paint(this.active.obj);
    this.update(this.lastClip);
  }
  get holding() {
    return this.held;
  }
  private paint(obj: THREE.Object3D) {
    if (!this.tint) return;
    obj.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (m && m.name === 'paint') m.color.set(this.tint!);
    });
  }

  constructor(
    private load: Loader,
    private bone: (name: string) => THREE.Object3D | undefined,
    /** система персонажа: рост ≈ 1, лицо смотрит в +Z */
    private root: THREE.Object3D,
  ) {}

  /** каждый кадр после позы: текущий клип → показать/убрать реквизит и держать его у кисти */
  update(clipNow: string) {
    this.lastClip = clipNow;
    const clip = this.held ?? clipNow;
    if (clip !== this.want) {
      this.want = clip;
      if (this.active && this.active.clip !== clip) {
        this.active.obj.removeFromParent();
        this.active = null;
      }
      const def = PROPS[clip];
      if (def)
        this.get(def, clip).then((proto) => {
          if (!proto || this.want !== clip || this.active) return;
          const hand = this.bone(def.bone);
          if (!hand) return;
          this.active = { clip, obj: this.make(proto, def), def, hand };
          this.paint(this.active.obj);
          this.root.add(this.active.obj);
        });
    }
    const a = this.active;
    if (!a) return;
    if (this.placed) {
      a.obj.position.copy(this.placed.p);
      a.obj.quaternion.copy(this.placed.q);
      const sc = Math.max(1e-4, this.placed.s);
      a.obj.scale.set(sc, sc * Math.max(0.05, this.placed.sy), sc);
      a.obj.visible = this.placed.s > 0.01;
      return;
    }
    a.obj.scale.setScalar(1);
    a.obj.visible = !a.def.free;
    a.hand.updateWorldMatrix(true, false);
    const p = this.root.worldToLocal(a.hand.getWorldPosition(this.v));
    const other = a.def.both ? this.bone(a.def.bone === 'RightHand' ? 'LeftHand' : 'RightHand') : undefined;
    if (other) p.lerp(this.root.worldToLocal(other.getWorldPosition(new THREE.Vector3())), 0.5);
    a.obj.position.set(p.x + a.def.offset[0], p.y + a.def.offset[1], p.z + a.def.offset[2]);
    const base = a.obj.userData.baseQ as THREE.Quaternion | undefined;
    if (base) {
      a.obj.quaternion.copy(base);
      if (this.aimW > 0.001) this.orient(a.obj, this.aimW);
    }
  }

  /** повернуть реквизит так, чтобы ось метки tip смотрела на aimP (две итерации: сопло сбоку от хвата) */
  private orient(pivot: THREE.Object3D, w: number) {
    const t = pivot.getObjectByName('tip');
    if (!t) return;
    const dl = (t.userData.dir as number[] | undefined) ?? [0, 1, 0];
    const ul = (t.userData.up as number[] | undefined) ?? [0, 0, 1];
    const a = this.va.set(dl[0], dl[1], dl[2]).normalize();
    const u = this.vb.set(ul[0], ul[1], ul[2]);
    u.addScaledVector(a, -u.dot(a)).normalize();
    this.ma.makeBasis(a, u, this.vc.copy(a).cross(u));
    const parentQ = this.root.getWorldQuaternion(this.qb);
    const upW = new THREE.Vector3(0, 1, 0).applyQuaternion(parentQ);
    const fwdW = new THREE.Vector3(0, 0, 1).applyQuaternion(parentQ);
    const base = pivot.quaternion.clone();
    for (let it = 0; it < 2; it++) {
      pivot.updateWorldMatrix(true, true);
      const from = it ? t.getWorldPosition(new THREE.Vector3()) : pivot.getWorldPosition(new THREE.Vector3());
      const A = this.aimP.clone().sub(from);
      if (A.lengthSq() < 1e-10) return;
      A.normalize();
      const U = upW.clone().addScaledVector(A, -upW.dot(A));
      if (U.lengthSq() < 1e-6) U.copy(fwdW).addScaledVector(A, -fwdW.dot(A));
      U.normalize();
      this.mb.makeBasis(A, U, A.clone().cross(U));
      // мир: R = Mw · Ml⁻¹; локально у родителя: q = Qродителя⁻¹ · R
      const R = this.qa.setFromRotationMatrix(this.mb.clone().multiply(this.ma.clone().invert()));
      pivot.quaternion.copy(parentQ).invert().multiply(R);
    }
    pivot.quaternion.copy(base.slerp(pivot.quaternion, w));
  }

  private make(proto: THREE.Object3D, d: PropDef) {
    const obj = proto.clone(true);
    // стекло (transmission) в three без отдельного прохода невидимо — делаем лёгкое полупрозрачное
    obj.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const m = (mesh.material as THREE.MeshPhysicalMaterial).clone();
      mesh.material = m;
      if ((m.transmission ?? 0) > 0 || (m.opacity ?? 1) < 0.99 || /glass/i.test(m.name)) {
        m.transmission = 0;
        m.transparent = true;
        m.opacity = Math.min(m.opacity ?? 1, 0.35);
        m.depthWrite = false;
        m.roughness = 0.05;
      }
    });
    if (d.canon === 'pca') obj.quaternion.copy(canonQ(obj));
    if (d.handle) obj.quaternion.premultiply(handleQ(obj));
    obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    const sz = box.getSize(new THREE.Vector3());
    const h = sz.y || 1;
    const size = d.free ? h : d.handK && this.handLen > 0 ? d.handK * this.handLen : d.size;
    const k = size / h;
    this.dims = { h: size, r: (Math.max(sz.x, sz.z) / 2) * k };
    obj.scale.multiplyScalar(k);
    // хват — за низ (ручку/донышко) или на доле grip высоты (баллончик — за корпус)
    if (d.free) {
      // свой размер и начало (доска: колёса на y = 0) — как сделано
      const pv = new THREE.Group();
      pv.name = 'prop';
      pv.add(obj);
      return pv;
    }
    obj.position.set(-((box.min.x + box.max.x) / 2) * k, -(box.min.y + h * (d.grip ?? 0)) * k, -((box.min.z + box.max.z) / 2) * k);
    const pivot = new THREE.Group();
    pivot.name = 'prop';
    pivot.add(obj);
    pivot.rotation.set(THREE.MathUtils.degToRad(d.rot[0]), THREE.MathUtils.degToRad(d.rot[1]), THREE.MathUtils.degToRad(d.rot[2]));
    pivot.userData.baseQ = pivot.quaternion.clone();
    return pivot;
  }

  private get(d: PropDef, id: string) {
    const key = d.url ?? `make:${id}`;
    let p = this.cache.get(key);
    if (!p) {
      p = d.make
        ? Promise.resolve(d.make())
        : this.load(d.url!).catch((e) => {
            console.warn('[props] не загрузился', d.url, e);
            return null;
          });
      this.cache.set(key, p);
    }
    return p;
  }

  dispose() {
    this.active?.obj.removeFromParent();
    this.active = null;
  }
}

/**
 * Ручка кружки → −X: самая дальняя от вертикальной оси точка в средней по высоте части модели (ручка торчит вбок);
 * поворот вокруг Y (поверх собственного obj.quaternion, premultiply).
 */
export function handleQ(obj: THREE.Object3D): THREE.Quaternion {
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  const c = box.getCenter(new THREE.Vector3());
  const h = box.max.y - box.min.y;
  let best = 0, dir = new THREE.Vector3(-1, 0, 0);
  const v = new THREE.Vector3();
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    const pos = m.isMesh ? (m.geometry.getAttribute('position') as THREE.BufferAttribute | undefined) : undefined;
    if (!pos) return;
    const step = Math.max(1, Math.floor(pos.count / 3000));
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      if (v.y < box.min.y + h * 0.2 || v.y > box.min.y + h * 0.85) continue;
      const r = Math.hypot(v.x - c.x, v.z - c.z);
      if (r > best) {
        best = r;
        dir = new THREE.Vector3(v.x - c.x, 0, v.z - c.z).normalize();
      }
    }
  });
  // поворот вокруг Y: dir → (−1, 0, 0)
  const a = Math.atan2(-dir.z, dir.x), b = Math.atan2(0, -1);
  return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), b - a);
}

/**
 * Канон модели под углом: длинная главная ось → +Y, тонкая (нормаль плоскости) → +Z; узкий конец длинной оси
 * (ручка) — вниз. Поворот для obj.quaternion (поверх его собственного).
 */
export function canonQ(obj: THREE.Object3D): THREE.Quaternion {
  obj.updateMatrixWorld(true);
  const pts: THREE.Vector3[] = [];
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    const pos = m.isMesh ? (m.geometry.getAttribute('position') as THREE.BufferAttribute | undefined) : undefined;
    if (!pos) return;
    const step = Math.max(1, Math.floor(pos.count / 1500));
    for (let i = 0; i < pos.count; i += step) pts.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld));
  });
  if (pts.length < 10) return new THREE.Quaternion();
  const { axes, c } = principalAxes(pts);
  const Y = axes[0].clone(), Z = axes[2].clone();
  // узкий конец — ручка: сравнить разброс поперёк оси у концов
  let lo = 0, hi = 0, nlo = 0, nhi = 0, mn = Infinity, mx = -Infinity;
  for (const p of pts) {
    const t = p.clone().sub(c).dot(Y);
    mn = Math.min(mn, t);
    mx = Math.max(mx, t);
  }
  for (const p of pts) {
    const d = p.clone().sub(c);
    const t = d.dot(Y);
    const rad = d.addScaledVector(Y, -t).length();
    if (t < mn + (mx - mn) * 0.3) (lo += rad), nlo++;
    else if (t > mn + (mx - mn) * 0.7) (hi += rad), nhi++;
  }
  if (nlo && nhi && lo / nlo > hi / nhi) Y.negate();
  const X = new THREE.Vector3().crossVectors(Y, Z).normalize();
  Z.crossVectors(X, Y).normalize();
  // базис (X, Y, Z) в координатах модели → поворот, переводящий его в оси (1,0,0), (0,1,0), (0,0,1)
  const m = new THREE.Matrix4().makeBasis(X, Y, Z);
  return new THREE.Quaternion().setFromRotationMatrix(m).invert().multiply(obj.quaternion);
}

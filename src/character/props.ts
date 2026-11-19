/**
 * Реквизит в лапе на время клипа: мыльные пузыри, какао, зеркальце, снежный шар; кисть и баллончик раскраски карты.
 * Модели — public/models/props/*.glb (Tripo), грузятся лениво при первом клипе; кисть и баллончик — процедурные
 * (make, src/card/paintProps.ts). hold(id) — держать реквизит, пока его не отпустят, при любом клипе (кот идёт по
 * карте с кистью в лапе).
 * Крепление к кости кисти Mixamo: начало кости — запястье, ось +Y кости идёт к пальцам.
 */
import * as THREE from 'three';
import { makeBrush, makeSpray } from '../card/paintProps';

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
}

export const PROPS: Record<string, PropDef> = {
  kind_bubbles: { url: 'models/props/bubble_wand.glb', bone: 'RightHand', size: 0.17, offset: [0, -0.02, 0.07], rot: [-15, 0, 10] },
  idle_kind_cocoa: { url: 'models/props/cocoa_mug.glb', bone: 'RightHand', size: 0.08, offset: [0.02, -0.03, 0.08], rot: [0, -30, 0] },
  idle_glitter_mirror: { url: 'models/props/hand_mirror.glb', bone: 'LeftHand', size: 0.16, offset: [0, -0.02, 0.07], rot: [-20, 160, 0] },
  snowglobe_shake: { url: 'models/props/snow_globe.glb', bone: 'RightHand', both: true, size: 0.13, offset: [0, -0.04, 0.05], rot: [0, 0, 0] },
  // раскраска карты (src/card/paint.ts): кисть Добряка и Блёстки, баллончик Хулигана — процедурные
  paint_brush: { make: makeBrush, bone: 'RightHand', size: 0.3, offset: [0, 0.01, 0.05], rot: [140, 0, -15], grip: 0.22 },
  paint_spray: { make: makeSpray, bone: 'RightHand', size: 0.17, offset: [0, 0, 0.05], rot: [12, 0, -10], grip: 0.42 },
};

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
    const box = new THREE.Box3().setFromObject(obj);
    const h = box.getSize(new THREE.Vector3()).y || 1;
    const k = d.size / h;
    obj.scale.setScalar(k);
    // хват — за низ (ручку/донышко) или на доле grip высоты (баллончик — за корпус)
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

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
}

export const PROPS: Record<string, PropDef> = {
  kind_bubbles: { url: 'models/props/bubble_wand.glb', bone: 'RightHand', size: 0.17, offset: [0, -0.02, 0.07], rot: [-15, 0, 10] },
  idle_kind_cocoa: { url: 'models/props/cocoa_mug.glb', bone: 'RightHand', size: 0.08, offset: [0.02, -0.03, 0.08], rot: [0, -30, 0] },
  idle_glitter_mirror: { url: 'models/props/hand_mirror.glb', bone: 'LeftHand', size: 0.16, offset: [0, -0.02, 0.07], rot: [-20, 160, 0] },
  snowglobe_shake: { url: 'models/props/snow_globe.glb', bone: 'RightHand', both: true, size: 0.13, offset: [0, -0.04, 0.05], rot: [0, 0, 0] },
  // раскраска карты (src/card/paint.ts): кисть Добряка и Блёстки, баллончик Хулигана — процедурные
  paint_brush: { make: makeBrush, bone: 'RightHand', size: 0.3, offset: [0, 0.02, 0.08], rot: [140, 0, -15] },
  paint_spray: { make: makeSpray, bone: 'RightHand', size: 0.17, offset: [0, -0.06, 0.08], rot: [35, 0, -10] },
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
    // хват — за низ (ручку/донышко)
    obj.position.set(-((box.min.x + box.max.x) / 2) * k, -box.min.y * k, -((box.min.z + box.max.z) / 2) * k);
    const pivot = new THREE.Group();
    pivot.name = 'prop';
    pivot.add(obj);
    pivot.rotation.set(THREE.MathUtils.degToRad(d.rot[0]), THREE.MathUtils.degToRad(d.rot[1]), THREE.MathUtils.degToRad(d.rot[2]));
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

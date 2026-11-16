/**
 * Реквизит в лапе на время клипа: мыльные пузыри, какао, зеркальце, снежный шар.
 * Модели — public/models/props/*.glb (Tripo), грузятся лениво при первом клипе.
 * Крепление к кости кисти Mixamo: начало кости — запястье, ось +Y кости идёт к пальцам.
 */
import * as THREE from 'three';

export interface PropDef {
  url: string;
  /** кость кисти без префикса mixamorig: */
  bone: 'RightHand' | 'LeftHand';
  /** высота реквизита в долях роста кота */
  size: number;
  /** смещение от запястья в долях роста кота: [вбок, к пальцам, от ладони] в осях кости */
  offset: [number, number, number];
  /** поворот в осях кости, градусы */
  rot: [number, number, number];
}

export const PROPS: Record<string, PropDef> = {
  kind_bubbles: { url: 'models/props/bubble_wand.glb', bone: 'RightHand', size: 0.16, offset: [0, 0.05, 0.02], rot: [0, 0, 0] },
  idle_kind_cocoa: { url: 'models/props/cocoa_mug.glb', bone: 'RightHand', size: 0.08, offset: [0, 0.05, 0.03], rot: [0, 0, 90] },
  idle_glitter_mirror: { url: 'models/props/hand_mirror.glb', bone: 'LeftHand', size: 0.16, offset: [0, 0.05, 0.02], rot: [0, 0, 0] },
  snowglobe_shake: { url: 'models/props/snow_globe.glb', bone: 'RightHand', size: 0.1, offset: [0, 0.06, 0.04], rot: [0, 0, 0] },
};

type Loader = (url: string) => Promise<THREE.Object3D>;

export class PropRig {
  private cache = new Map<string, Promise<THREE.Object3D | null>>();
  private active: { clip: string; obj: THREE.Object3D } | null = null;
  private want = '';

  constructor(
    private load: Loader,
    private bone: (name: string) => THREE.Object3D | undefined,
    private root: THREE.Object3D,
  ) {}

  /** вызывать каждый кадр с текущим клипом */
  update(clip: string) {
    if (clip === this.want) return;
    this.want = clip;
    if (this.active && this.active.clip !== clip) {
      this.active.obj.removeFromParent();
      this.active = null;
    }
    const def = PROPS[clip];
    if (!def) return;
    this.get(def).then((proto) => {
      if (!proto || this.want !== clip || this.active) return;
      const hand = this.bone(def.bone);
      if (!hand) return;
      const obj = proto.clone(true);
      this.place(obj, hand, def);
      this.active = { clip, obj };
    });
  }

  private place(obj: THREE.Object3D, hand: THREE.Object3D, d: PropDef) {
    // масштаб кости относительно персонажа (модель нормирована к росту 1)
    hand.updateWorldMatrix(true, false);
    const hs = hand.getWorldScale(new THREE.Vector3()).x / this.root.getWorldScale(new THREE.Vector3()).x || 1;
    const box = new THREE.Box3().setFromObject(obj);
    const h = box.getSize(new THREE.Vector3()).y || 1;
    const k = d.size / h / hs;
    const pivot = new THREE.Group();
    obj.scale.setScalar(k);
    // ставим за низ (ручку) в точку хвата
    obj.position.set(-((box.min.x + box.max.x) / 2) * k, -box.min.y * k, -((box.min.z + box.max.z) / 2) * k);
    pivot.add(obj);
    pivot.position.set(d.offset[0] / hs, d.offset[1] / hs, d.offset[2] / hs);
    pivot.rotation.set(THREE.MathUtils.degToRad(d.rot[0]), THREE.MathUtils.degToRad(d.rot[1]), THREE.MathUtils.degToRad(d.rot[2]));
    hand.add(pivot);
    this.active = null;
    this.active = { clip: this.want, obj: pivot };
  }

  private get(d: PropDef) {
    let p = this.cache.get(d.url);
    if (!p) {
      p = this.load(d.url).catch((e) => {
        console.warn('[props] не загрузился', d.url, e);
        return null;
      });
      this.cache.set(d.url, p);
    }
    return p;
  }

  dispose() {
    this.active?.obj.removeFromParent();
    this.active = null;
  }
}

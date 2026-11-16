/**
 * Заглушка-риг «СберКот-близнец» из простых форм — чтобы гонять механику до финальной модели.
 * Пропорции по СберКоту (молодой взрослый кот, рост по гайду ≈65 см):
 *  голова ≈39% роста и шире тела, пушистые щёки, короткий хвост, 4 пальца, зелёные глаза,
 *  серо-голубой мех, белая мордочка. Рост нормирован к 1.
 * Скелет — имена Mixamo + Tail1..4, LeftEar1/2, RightEar1/2, Jaw, LeftEyelid/RightEyelid, Root.
 * Формы жёстко привязаны к костям (без скиннинга) — для механики этого достаточно.
 * Клипы процедурные, оси костей: +Z — вперёд (куда смотрит кот), +Y — вверх, +X — влево кота.
 */
import * as THREE from 'three';
import { CLIPS, type Character, type ClipName, type Emote, type PlayOptions } from './types';
import type { Persona } from '../persona/types';
import { clamp } from '../core/util';

const FUR = 0xa9b6cc;
const FUR_DARK = 0x8593ad;
const WHITE = 0xf6f7fb;
const EYE = 0x34c759;

type V3 = [number, number, number];
const S = Math.sin;
const tri = (k: number) => S(clamp(k, 0, 1) * Math.PI);
const smooth = (k: number) => {
  k = clamp(k, 0, 1);
  return k * k * (3 - 2 * k);
};

export const RIG_PROPORTIONS = {
  height: 1,
  headHeightFrac: 0.39,
  headWidth: 0.5,
  bodyWidth: 0.34,
  legLength: 0.17,
  tailLength: 0.22,
  fingers: 4,
};

interface Pose {
  b: Record<string, V3>;
  root?: { x?: number; y?: number; z?: number; rx?: number; ry?: number; rz?: number; s?: number };
  jaw?: number;
  lids?: number;
}

/** Клипы: k — 0..1 (для петель — фаза), t — секунды */
const CLIPFN: Record<ClipName, (k: number, t: number) => Pose> = {
  idle: (_k, t) => ({
    b: {
      Spine1: [0.03 * S(t * 1.8), 0, 0.02 * S(t * 0.9)],
      Head: [0.04 * S(t * 1.3), 0.15 * S(t * 0.6), 0.04 * S(t * 0.5)],
      LeftArm: [0.05 * S(t * 2), 0, 0.12 + 0.04 * S(t * 2)],
      RightArm: [0.05 * S(t * 2 + 1), 0, -0.12 - 0.04 * S(t * 2 + 1)],
      Tail1: [0.2, 0.5 * S(t * 1.5), 0],
      Tail2: [0.2, 0.3 * S(t * 1.5 - 0.6), 0],
      Tail3: [0.2, 0.3 * S(t * 1.5 - 1.2), 0],
      LeftEar1: [0, 0, S(t * 0.7) > 0.97 ? 0.4 : 0],
    },
    root: { y: 0.004 * S(t * 3.6) },
  }),
  walk: (k) => {
    const p = k * Math.PI * 2;
    return {
      b: {
        LeftUpLeg: [0.6 * S(p), 0, 0], RightUpLeg: [-0.6 * S(p), 0, 0],
        LeftLeg: [Math.max(0, -0.7 * S(p + 0.6)), 0, 0], RightLeg: [Math.max(0, 0.7 * S(p + 0.6)), 0, 0],
        LeftArm: [-0.5 * S(p), 0, 0.15], RightArm: [0.5 * S(p), 0, -0.15],
        Spine1: [0.08, 0.1 * S(p), 0], Head: [-0.05, -0.08 * S(p), 0],
        Tail1: [0.3, 0.3 * S(p), 0], Tail2: [0.2, 0.3 * S(p - 0.5), 0],
      },
      root: { y: 0.025 * Math.abs(S(p)) },
    };
  },
  run: (k) => {
    const p = k * Math.PI * 2;
    return {
      b: {
        LeftUpLeg: [1.0 * S(p), 0, 0], RightUpLeg: [-1.0 * S(p), 0, 0],
        LeftLeg: [Math.max(0, -1.1 * S(p + 0.6)), 0, 0], RightLeg: [Math.max(0, 1.1 * S(p + 0.6)), 0, 0],
        LeftArm: [-0.9 * S(p), 0, 0.2], RightArm: [0.9 * S(p), 0, -0.2],
        LeftForeArm: [-0.8, 0, 0], RightForeArm: [-0.8, 0, 0],
        Spine1: [0.25, 0.12 * S(p), 0], Head: [-0.2, 0, 0],
        Tail1: [0.9, 0.2 * S(p), 0],
      },
      root: { y: 0.05 * Math.abs(S(p)) },
    };
  },
  jump: (k) => {
    // присед → толчок → полёт → приземление (сквош)
    const crouch = tri(k / 0.25) * (k < 0.25 ? 1 : 0) + (k > 0.85 ? tri((k - 0.85) / 0.15) : 0);
    const air = k > 0.2 && k < 0.88 ? S(((k - 0.2) / 0.68) * Math.PI) : 0;
    return {
      b: {
        LeftUpLeg: [-0.9 * crouch + 0.3 * air, 0, 0], RightUpLeg: [-0.9 * crouch + 0.3 * air, 0, 0],
        LeftLeg: [1.4 * crouch, 0, 0], RightLeg: [1.4 * crouch, 0, 0],
        LeftArm: [-0.3 * crouch, 0, 1.2 * air + 0.1], RightArm: [-0.3 * crouch, 0, -1.2 * air - 0.1],
        Spine1: [0.3 * crouch - 0.15 * air, 0, 0], Head: [-0.2 * air, 0, 0],
        Tail1: [1.0 * air, 0, 0],
      },
      root: { y: 0.45 * air - 0.08 * crouch, s: 1 },
    };
  },
  flip: (k) => {
    // сальто назад: толчок, оборот вокруг центра тела, приземление
    const air = k > 0.15 && k < 0.85 ? (k - 0.15) / 0.7 : k >= 0.85 ? 1 : 0;
    const tuck = tri(air);
    return {
      b: {
        LeftUpLeg: [-1.4 * tuck, 0, 0], RightUpLeg: [-1.4 * tuck, 0, 0],
        LeftLeg: [1.8 * tuck, 0, 0], RightLeg: [1.8 * tuck, 0, 0],
        LeftArm: [-1.0 * tuck, 0, 0.3], RightArm: [-1.0 * tuck, 0, -0.3],
        Spine1: [0.4 * tuck, 0, 0], Head: [0.3 * tuck, 0, 0],
      },
      root: { y: 0.55 * S(air * Math.PI), rx: -smooth(air) * Math.PI * 2 },
    };
  },
  tumble: (k) => {
    // кувырок вперёд, низко
    const roll = smooth((k - 0.15) / 0.7);
    const curl = tri((k - 0.1) / 0.8);
    return {
      b: {
        Spine1: [0.8 * curl, 0, 0], Neck: [0.5 * curl, 0, 0], Head: [0.4 * curl, 0, 0],
        LeftUpLeg: [-1.5 * curl, 0, 0], RightUpLeg: [-1.5 * curl, 0, 0], LeftLeg: [1.8 * curl, 0, 0], RightLeg: [1.8 * curl, 0, 0],
        LeftArm: [-1.2 * curl, 0, 0], RightArm: [-1.2 * curl, 0, 0],
      },
      root: { y: 0.12 * S(roll * Math.PI) - 0.15 * curl, z: 0.35 * roll, rx: roll * Math.PI * 2 },
    };
  },
  turn_left: (k) => ({ b: { Head: [0, 0.4 * tri(k), 0], LeftUpLeg: [0.4 * S(k * 12), 0, 0], RightUpLeg: [-0.4 * S(k * 12), 0, 0] }, root: { ry: smooth(k) * Math.PI / 2 } }),
  turn_right: (k) => ({ b: { Head: [0, -0.4 * tri(k), 0], LeftUpLeg: [0.4 * S(k * 12), 0, 0], RightUpLeg: [-0.4 * S(k * 12), 0, 0] }, root: { ry: -smooth(k) * Math.PI / 2 } }),
  sit: (k) => {
    const d = smooth(k / 0.25) * (1 - smooth((k - 0.85) / 0.15));
    return {
      b: { LeftUpLeg: [-1.5 * d, 0, 0.15 * d], RightUpLeg: [-1.5 * d, 0, -0.15 * d], LeftLeg: [0.2 * d, 0, 0], RightLeg: [0.2 * d, 0, 0], Spine1: [-0.15 * d, 0, 0], Tail1: [1.2 * d, 0, 0] },
      root: { y: -0.14 * d },
    };
  },
  wave: (k, t) => ({
    b: { RightArm: [-0.3 * tri(k), 0, -2.4 * tri(k / 0.3 > 1 ? 1 : k / 0.3) * (k > 0.85 ? 1 - (k - 0.85) / 0.15 : 1)], RightForeArm: [0, 0, -0.5 * S(t * 12)], Head: [0, 0, -0.15 * tri(k)] },
  }),
  appear: (k) => {
    const j = CLIPFN.jump(clamp(k * 1.1, 0, 1), 0);
    return { ...j, root: { ...j.root, s: Math.min(1, 0.15 + k * 2.5), ry: (1 - smooth(k * 1.3)) * Math.PI * 2 } };
  },
  knock_glass: (k, t) => ({
    b: { RightArm: [-1.4 * tri(k), 0, -0.1], RightForeArm: [-0.6 * tri(k) - 0.5 * Math.max(0, S(t * 16)) * tri(k), 0, 0], Spine1: [0.15 * tri(k), 0, 0], Head: [-0.1 * tri(k), 0, 0] },
    root: { z: 0.06 * tri(k) },
  }),
  press_glass: (k) => ({
    b: { Spine1: [0.3 * tri(k), 0, 0], Head: [0.15 * tri(k), 0, 0.35 * tri(k)], LeftArm: [-1.5 * tri(k), 0, 0.2], RightArm: [-1.5 * tri(k), 0, -0.2] },
    root: { z: 0.12 * tri(k) },
    lids: 0.7 * tri(k),
  }),
  scratch: (k, t) => ({
    b: { RightArm: [-1.5 * tri(k), 0, -0.4 * S(t * 14)], LeftArm: [-1.5 * tri(k), 0, 0.4 * S(t * 14 + 1)], Spine1: [0.2 * tri(k), 0, 0] },
    root: { z: 0.05 * tri(k) },
    jaw: 0.3 * tri(k),
  }),
  sticker: (k) => ({ b: { RightArm: [-1.6 * tri(k), 0, -0.2], RightForeArm: [-0.3 * tri(k), 0, 0], Spine1: [0.12 * tri(k), 0, 0] }, root: { z: 0.08 * tri(k) } }),
  talk: (_k, t) => ({ b: { Head: [0.05 * S(t * 6), 0.06 * S(t * 2), 0], RightArm: [-0.35 - 0.15 * S(t * 3), 0, -0.25], RightForeArm: [-0.4 * S(t * 3) - 0.3, 0, 0] } }),
  listen: (_k, t) => ({ b: { Head: [0.05, 0, 0.28 + 0.03 * S(t * 1.3)], Spine1: [0.05, 0, 0.04], LeftEar1: [0.3, 0, 0], RightEar1: [0.3, 0, 0] } }),
  laugh: (k, t) => ({
    b: { Spine1: [-0.15 * tri(k) + 0.08 * S(t * 25) * tri(k), 0, 0], Head: [-0.3 * tri(k), 0, 0], LeftArm: [-0.6 * tri(k), 0, 0.3], RightArm: [-0.6 * tri(k), 0, -0.3], LeftForeArm: [-1.2 * tri(k), 0, 0], RightForeArm: [-1.2 * tri(k), 0, 0] },
    root: { y: 0.02 * Math.abs(S(t * 25)) * tri(k) },
    jaw: 0.8 * tri(k), lids: 0.8 * tri(k),
  }),
  bored: (k, t) => ({
    b: { Spine1: [0.25 * tri(k), 0, 0], Head: [0.3 * tri(k), 0.2 * S(t), 0], LeftArm: [0, 0, 0.05], RightArm: [0, 0, -0.05], LeftEar1: [-0.5 * tri(k), 0, 0], RightEar1: [-0.5 * tri(k), 0, 0] },
    root: { y: -0.02 * tri(k) },
    jaw: 0.6 * tri((k - 0.3) / 0.4), lids: 0.6 * tri(k),
  }),
  run_home: (k, t) => ({ ...CLIPFN.run((t / 0.6) % 1, t), root: { ry: Math.PI * smooth(k * 3), z: -1.0 * k, s: 1 - 0.6 * k } }),
  dance: (k, t) => ({
    b: { Hips: [0, 0, 0.15 * S(t * 8)], Spine1: [0, 0.25 * S(t * 4), -0.15 * S(t * 8)], LeftArm: [0, 0, 1.6 + 0.4 * S(t * 8)], RightArm: [0, 0, -1.6 + 0.4 * S(t * 8)], Head: [0, 0, 0.2 * S(t * 8)], LeftUpLeg: [0.3 * Math.max(0, S(t * 8)), 0, 0], RightUpLeg: [0.3 * Math.max(0, -S(t * 8)), 0, 0] },
    root: { y: 0.03 * Math.abs(S(t * 8)) * tri(k) },
  }),
  bubble_gum: (k, t) => ({ b: { Head: [-0.35 * tri(k), 0, 0.05 * S(t * 3)], Spine1: [-0.12 * tri(k), 0, 0], RightArm: [0, 0, -0.25 * tri(k)], LeftArm: [0, 0, 0.25 * tri(k)] }, jaw: 0.25 * tri(k), lids: 0.4 * tri(k) }),
  glitter_burst: (k) => ({ b: { LeftArm: [0, 0, 2.3 * tri(k)], RightArm: [0, 0, -2.3 * tri(k)], Head: [-0.3 * tri(k), 0, 0] }, root: { y: 0.25 * tri(k) }, jaw: 0.5 * tri(k) }),
  heart_draw: (k) => ({
    b: { RightArm: [-1.5 + 0.35 * Math.cos(k * Math.PI * 2), 0, -0.35 * S(k * Math.PI * 2)], RightForeArm: [-0.3, 0, 0], Spine1: [0.12, 0, 0] },
    root: { z: 0.1 * tri(k) },
  }),
};

export class RigCat implements Character {
  readonly kind = 'rig' as const;
  readonly object = new THREE.Group();
  private root = new THREE.Bone();
  private bones = new Map<string, THREE.Bone>();
  private clip: ClipName = 'idle';
  private prev: ClipName = 'idle';
  private t = 0;
  private prevT = 0;
  private blend = 1;
  private opts: PlayOptions = {};
  private time = 0;
  private mouth = 0;
  private look: THREE.Vector3 | null = null;
  private hitBox: THREE.Mesh;
  private outfit = new THREE.Group();
  private mats = new Map<string, THREE.MeshStandardMaterial>();
  private lids: THREE.Mesh[] = [];
  private blinkT = 2;
  private emoteUntil = 0;
  private emoteName: Emote = 'neutral';
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  readonly skeleton: THREE.Skeleton;

  constructor() {
    this.object.name = 'character-rig';
    this.root.name = 'Root';
    this.object.add(this.root);
    this.build();
    this.skeleton = new THREE.Skeleton([...this.bones.values()]);
    this.hitBox = new THREE.Mesh(new THREE.BoxGeometry(0.55, 1, 0.45), new THREE.MeshBasicMaterial({ visible: false }));
    this.hitBox.position.y = 0.5;
    this.object.add(this.hitBox);
  }

  get currentClip() {
    return this.clip;
  }

  async load() {
    /* всё строится в конструкторе */
  }

  private mat(key: string, color: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) {
    let m = this.mats.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, ...opts });
      this.mats.set(key, m);
    }
    return m;
  }

  private bone(name: string, parent: THREE.Object3D, pos: V3) {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(...pos);
    parent.add(b);
    this.bones.set(name, b);
    return b;
  }

  private blob(parent: THREE.Object3D, mat: THREE.Material, scale: V3, pos: V3 = [0, 0, 0], seg = 20) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.5, seg, Math.round(seg * 0.75)), mat);
    m.scale.set(...scale);
    m.position.set(...pos);
    parent.add(m);
    return m;
  }

  private build() {
    const fur = this.mat('fur', FUR);
    const furD = this.mat('furDark', FUR_DARK);
    const white = this.mat('white', WHITE);
    const pink = this.mat('pink', 0xf3a6b6);
    const eye = this.mat('eye', EYE, { roughness: 0.3 });
    const black = this.mat('black', 0x15171c, { roughness: 0.4 });
    const shine = new THREE.MeshBasicMaterial({ color: 0xffffff });

    const hips = this.bone('Hips', this.root, [0, 0.2, 0]);
    // ноги (короткие)
    for (const side of [1, -1]) {
      const L = side > 0 ? 'Left' : 'Right';
      const up = this.bone(`${L}UpLeg`, hips, [0.085 * side, 0, 0]);
      this.blob(up, fur, [0.13, 0.14, 0.13], [0, -0.05, 0]);
      const leg = this.bone(`${L}Leg`, up, [0, -0.1, 0]);
      this.blob(leg, fur, [0.1, 0.1, 0.1], [0, -0.03, 0]);
      const foot = this.bone(`${L}Foot`, leg, [0, -0.07, 0.01]);
      this.blob(foot, white, [0.12, 0.06, 0.16], [0, -0.0, 0.03]);
    }
    // корпус: грушевидный, уже головы
    const spine = this.bone('Spine', hips, [0, 0.05, 0]);
    this.blob(spine, fur, [0.34, 0.26, 0.28], [0, 0.04, 0]);
    this.blob(spine, white, [0.2, 0.2, 0.08], [0, 0.06, 0.11]); // белая грудка
    const spine1 = this.bone('Spine1', spine, [0, 0.14, 0]);
    this.blob(spine1, fur, [0.3, 0.2, 0.25], [0, 0.03, 0]);
    // хвост: короткий, 4 кости
    let tp: THREE.Object3D = hips;
    for (let i = 1; i <= 4; i++) {
      const b = this.bone(`Tail${i}`, tp, i === 1 ? [0, 0.02, -0.12] : [0, 0.045, -0.02]);
      if (i === 1) b.rotation.x = -0.9;
      this.blob(b, i === 4 ? furD : fur, [0.075 - i * 0.008, 0.08, 0.075 - i * 0.008], [0, 0.025, 0]);
      tp = b;
    }
    // руки, 4 пальца
    for (const side of [1, -1]) {
      const L = side > 0 ? 'Left' : 'Right';
      const sh = this.bone(`${L}Shoulder`, spine1, [0.12 * side, 0.08, 0]);
      const arm = this.bone(`${L}Arm`, sh, [0.03 * side, 0, 0]);
      this.blob(arm, fur, [0.085, 0.13, 0.085], [0, -0.05, 0]);
      const fore = this.bone(`${L}ForeArm`, arm, [0, -0.1, 0]);
      this.blob(fore, fur, [0.075, 0.1, 0.075], [0, -0.04, 0]);
      const hand = this.bone(`${L}Hand`, fore, [0, -0.085, 0]);
      this.blob(hand, white, [0.085, 0.07, 0.085], [0, -0.01, 0.005]);
      for (let f = 0; f < 4; f++) this.blob(hand, white, [0.025, 0.028, 0.03], [(-0.03 + f * 0.02), -0.04, 0.025], 8);
    }
    // голова ≈39% роста, шире тела; щёки-пух
    const neck = this.bone('Neck', spine1, [0, 0.14, 0]);
    const head = this.bone('Head', neck, [0, 0.03, 0]);
    const hc = 0.19; // центр головы над костью Head
    this.blob(head, fur, [0.46, 0.36, 0.4], [0, hc, 0], 28);
    for (const side of [1, -1]) {
      this.blob(head, fur, [0.17, 0.15, 0.17], [0.19 * side, hc - 0.07, 0.03]); // щёки
      this.blob(head, fur, [0.08, 0.06, 0.08], [0.25 * side, hc - 0.1, 0.0]); // пух
      this.blob(head, white, [0.14, 0.1, 0.12], [0.06 * side, hc - 0.08, 0.15]); // мордочка
    }
    this.blob(head, white, [0.1, 0.1, 0.06], [0, hc - 0.02, 0.18]);
    this.blob(head, pink, [0.045, 0.03, 0.03], [0, hc - 0.04, 0.215]); // нос
    // глаза + веки
    for (const side of [1, -1]) {
      const L = side > 0 ? 'Left' : 'Right';
      this.blob(head, eye, [0.1, 0.11, 0.05], [0.085 * side, hc + 0.03, 0.175]);
      this.blob(head, black, [0.045, 0.075, 0.03], [0.085 * side, hc + 0.03, 0.195]);
      this.blob(head, shine as unknown as THREE.Material, [0.02, 0.02, 0.01], [0.075 * side + 0.012, hc + 0.06, 0.205], 8);
      const lidBone = this.bone(`${L}Eyelid`, head, [0.085 * side, hc + 0.03, 0.17]);
      const lid = this.blob(lidBone, fur, [0.115, 0.12, 0.06], [0, 0.0, 0.012]);
      lid.scale.y = 0.001;
      this.lids.push(lid);
      // уши: 2 кости
      const e1 = this.bone(`${L}Ear1`, head, [0.13 * side, hc + 0.14, -0.01]);
      e1.rotation.z = -0.35 * side;
      const ear = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.1, 12), fur);
      ear.position.y = 0.04;
      e1.add(ear);
      const e2 = this.bone(`${L}Ear2`, e1, [0, 0.07, 0]);
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.06, 10), furD);
      tip.position.y = 0.01;
      e2.add(tip);
      const inner = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.07, 10), pink);
      inner.position.set(0, 0.035, 0.02);
      e1.add(inner);
    }
    // челюсть / рот
    const jaw = this.bone('Jaw', head, [0, hc - 0.08, 0.16]);
    this.blob(jaw, this.mat('mouth', 0x7a2a3a), [0.07, 0.04, 0.03], [0, -0.01, 0.02]);
    this.blob(jaw, white, [0.09, 0.04, 0.06], [0, -0.03, 0.0]);

    this.root.add(this.outfit);
  }

  /** одежда/аксессуары персоны — «скины» на том же скелете */
  setPersona(p: Persona) {
    this.bones.forEach((b) => b.children.filter((c) => c.userData.outfit).forEach((c) => b.remove(c)));
    const add = (bone: string, mesh: THREE.Mesh) => {
      mesh.userData.outfit = true;
      this.bones.get(bone)!.add(mesh);
      return mesh;
    };
    const ell = (mat: THREE.Material, s: V3, pos: V3) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.5, 20, 14), mat);
      m.scale.set(...s);
      m.position.set(...pos);
      return m;
    };
    const ring = (mat: THREE.Material, r: number, tube: number, pos: V3, sx = 1, sz = 0.85) => {
      const m = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 8, 28), mat);
      m.rotation.x = Math.PI / 2;
      m.scale.set(sx, sz, 1);
      m.position.set(...pos);
      return m;
    };
    const hoodieColor = p.id === 'glitter' ? 0xb9a3ff : 0x161616;
    const trimColor = p.id === 'glitter' ? 0x8ff0d0 : 0x1ee3cf;
    const hoodie = new THREE.MeshStandardMaterial({ color: hoodieColor, roughness: 0.9 });
    const trim = new THREE.MeshStandardMaterial({ color: trimColor, roughness: 0.6 });
    add('Spine', ell(hoodie, [0.37, 0.28, 0.31], [0, 0.04, 0]));
    add('Spine1', ell(hoodie, [0.33, 0.22, 0.28], [0, 0.03, 0]));
    add('Spine', ring(trim, 0.16, 0.012, [0, -0.07, 0], 1.12, 0.95));
    add('Spine1', ring(trim, 0.11, 0.025, [0, 0.12, -0.01])); // капюшон-воротник
    for (const L of ['Left', 'Right']) {
      add(`${L}Arm`, ell(hoodie, [0.095, 0.14, 0.095], [0, -0.05, 0]));
      add(`${L}ForeArm`, ell(hoodie, [0.083, 0.1, 0.083], [0, -0.04, 0]));
      add(`${L}ForeArm`, ring(trim, 0.04, 0.008, [0, -0.085, 0], 1, 1));
    }
    // нашивка Сбера — левая грудь (у кота левая сторона = +X)
    const patch = new THREE.Mesh(new THREE.CircleGeometry(0.03, 20), new THREE.MeshStandardMaterial({ color: 0x21a038, roughness: 0.5 }));
    patch.position.set(0.075, 0.06, 0.15);
    add('Spine', patch);
    if (p.id === 'glitter') {
      const gold = new THREE.MeshStandardMaterial({ color: 0xffd36e, metalness: 0.6, roughness: 0.3 });
      // бантик и звёздочка-заколка
      add('Head', ell(this.mat('mint', 0x8ff0d0), [0.09, 0.06, 0.05], [-0.13, 0.36, 0.05]));
      add('Head', ell(this.mat('mint', 0x8ff0d0), [0.09, 0.06, 0.05], [-0.05, 0.37, 0.05]));
      const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.03), gold);
      star.position.set(-0.09, 0.365, 0.075);
      add('Head', star);
    } else {
      // кепка козырьком назад (лайм)
      const cap = new THREE.MeshStandardMaterial({ color: 0xb6ff3b, roughness: 0.7 });
      const dome = new THREE.Mesh(new THREE.SphereGeometry(0.5, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), cap);
      dome.scale.set(0.42, 0.22, 0.38);
      dome.position.set(0, 0.3, -0.01);
      add('Head', dome);
      const brim = ell(cap, [0.26, 0.02, 0.2], [0, 0.31, -0.2]);
      add('Head', brim);
    }
  }

  play(clip: ClipName, opts: PlayOptions = {}) {
    this.prev = this.clip;
    this.prevT = this.t;
    this.clip = clip;
    this.t = 0;
    this.blend = 0;
    this.opts = opts;
  }

  lookAt(world: THREE.Vector3 | null) {
    this.look = world ? world.clone() : null;
  }

  emote(e: Emote, ms = 1200) {
    this.emoteName = e;
    this.emoteUntil = this.time + ms / 1000;
    if (e === 'blink') this.blinkT = 0;
  }

  setMouth(open: number) {
    this.mouth = clamp(open, 0, 1);
  }

  private apply(p: Pose, w: number, acc: { root: Record<string, number>; jaw: number; lids: number }) {
    for (const [n, [x, y, z]] of Object.entries(p.b)) {
      const b = this.bones.get(n);
      if (!b) continue;
      b.quaternion.multiply(this.q.setFromEuler(this.e.set(x * w, y * w, z * w)));
    }
    const r = p.root ?? {};
    for (const k of ['x', 'y', 'z', 'rx', 'ry', 'rz'] as const) acc.root[k] = (acc.root[k] ?? 0) + (r[k] ?? 0) * w;
    acc.root.s = (acc.root.s ?? 1) * (1 + ((r.s ?? 1) - 1) * w);
    acc.jaw += (p.jaw ?? 0) * w;
    acc.lids = Math.max(acc.lids, (p.lids ?? 0) * w);
  }

  update(dt: number, camera: THREE.Camera) {
    this.time += dt;
    this.t += dt;
    this.prevT += dt;
    this.blend = Math.min(1, this.blend + dt / 0.2);
    const spec = CLIPS[this.clip];
    const loop = this.opts.loop ?? spec.loop;
    if (!loop && this.t >= spec.dur) {
      const cb = this.opts.onEnd;
      this.play('idle');
      cb?.();
    }
    // сброс к rest (кроме фиксированных наклонов хвоста/ушей)
    this.bones.forEach((b) => {
      const rest = (b.userData.rest ??= b.quaternion.clone()) as THREE.Quaternion;
      b.quaternion.copy(rest);
    });
    const kOf = (c: ClipName, t: number) => (CLIPS[c].loop ? (t / CLIPS[c].dur) % 1 : Math.min(1, t / CLIPS[c].dur));
    const acc = { root: {} as Record<string, number>, jaw: 0, lids: 0 };
    if (this.blend < 1) this.apply(CLIPFN[this.prev](kOf(this.prev, this.prevT), this.prevT), 1 - this.blend, acc);
    this.apply(CLIPFN[this.clip](kOf(this.clip, this.t), this.t), this.blend, acc);
    if (this.clip !== 'idle' && this.clip !== 'walk' && this.clip !== 'run') this.apply(CLIPFN.idle(0, this.time), 0.3, acc);

    // root: смещение и повороты вокруг центра тела (y=0.5)
    const r = acc.root;
    this.root.position.set(r.x ?? 0, r.y ?? 0, r.z ?? 0);
    this.root.rotation.set(r.rx ?? 0, r.ry ?? 0, r.rz ?? 0);
    this.root.scale.setScalar(r.s ?? 1);
    if (r.rx) {
      this.root.position.y += 0.5 - 0.5 * Math.cos(r.rx);
      this.root.position.z += -0.5 * Math.sin(r.rx);
    }

    // челюсть (липсинк + клипы)
    const jaw = this.bones.get('Jaw')!;
    const open = clamp(acc.jaw + this.mouth * 0.9, 0, 1);
    jaw.position.y = 0.11 - open * 0.03;
    jaw.scale.y = 1 + open * 1.4;
    // моргание
    this.blinkT += dt;
    if (this.blinkT > 3 + Math.random() * 2) this.blinkT = 0;
    const blink = this.blinkT < 0.15 ? tri(this.blinkT / 0.15) : 0;
    let lids = Math.max(blink, acc.lids);
    if (this.time < this.emoteUntil) {
      if (this.emoteName === 'happy') lids = Math.max(lids, 0.55);
      if (this.emoteName === 'wink') this.lids[1].scale.y = 0.12;
    }
    this.lids.forEach((l, i) => (l.scale.y = i === 1 && this.emoteName === 'wink' && this.time < this.emoteUntil ? 0.12 : Math.max(0.001, lids * 0.12)));

    // взгляд к камере / точке
    const head = this.bones.get('Head')!;
    if (this.clip !== 'flip' && this.clip !== 'tumble') {
      const target = this.look ?? camera.getWorldPosition(new THREE.Vector3());
      this.object.updateMatrixWorld(true);
      const local = this.object.worldToLocal(target.clone());
      const yaw = clamp(Math.atan2(local.x, local.z), -0.7, 0.7);
      const pitch = clamp(Math.atan2(local.y - 0.8, Math.hypot(local.x, local.z)), -0.45, 0.45);
      head.quaternion.premultiply(this.q.setFromEuler(this.e.set(-pitch * 0.6, yaw * 0.7, 0)));
    }
  }

  hitTest(ray: THREE.Raycaster) {
    return ray.intersectObject(this.hitBox, false).length > 0;
  }

  posterImage() {
    return null;
  }

  dispose() {
    this.object.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
  }
}

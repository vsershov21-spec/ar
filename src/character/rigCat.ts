/**
 * Заглушка-риг «СберКот-близнец» из простых форм — чтобы гонять механику до финальной модели.
 * Пропорции по СберКоту (молодой взрослый кот, рост по гайду ≈65 см):
 *  голова ≈39% роста и шире тела, пушистые щёки, короткий хвост, 4 пальца, зелёные глаза,
 *  серо-голубой мех, белая мордочка. Рост нормирован к 1.
 * Скелет — имена Mixamo + Tail1..4, LeftEar1/2, RightEar1/2, Jaw, LeftEyelid/RightEyelid, Root.
 * Формы жёстко привязаны к костям (без скиннинга) — для механики этого достаточно.
 * Клипы — процедурные заглушки всех 71 клипа content/animations.json (rigClips.ts), лицо — пресеты face.json.
 * Скины — по content/src/<id>.meta.json (palette + outfit): Хулиган, Добряк, Блёстка.
 */
import * as THREE from 'three';
import type { Character, ClipName, Emote, PlayOptions, TouchZone } from './types';
import type { Persona } from '../persona/types';
import { clamp } from '../core/util';
import type { MouthShape, Viseme } from '../lipsync/visemes';
import { ClipState } from './clipState';
import { RIG_CLIPS, tri, type Pose, type V3 } from './rigClips';
import { FaceMixer, EMOTE_FACE } from './face';
import { personaMeta } from './personaMeta';
import type { AnchorName } from '../fx/core';

const FUR = 0xa9b6cc;
const FUR_DARK = 0x8593ad;
const WHITE = 0xf6f7fb;
const EYE = 0x34c759;

export const RIG_PROPORTIONS = {
  height: 1,
  headHeightFrac: 0.39,
  headWidth: 0.5,
  bodyWidth: 0.34,
  legLength: 0.17,
  tailLength: 0.22,
  fingers: 4,
};

/** хитбоксы зон касания: кость, форма (сфера r / коробка), смещение в кости */
const ZONES: { zone: TouchZone; bone: string; r?: number; box?: V3; pos: V3 }[] = [
  { zone: 'cheek', bone: 'Head', r: 0.085, pos: [0.19, 0.12, 0.06] },
  { zone: 'cheek', bone: 'Head', r: 0.085, pos: [-0.19, 0.12, 0.06] },
  { zone: 'head', bone: 'Head', box: [0.46, 0.36, 0.4], pos: [0, 0.2, 0] },
  { zone: 'paw', bone: 'LeftHand', r: 0.07, pos: [0, -0.02, 0] },
  { zone: 'paw', bone: 'RightHand', r: 0.07, pos: [0, -0.02, 0] },
  { zone: 'paw', bone: 'LeftFoot', r: 0.08, pos: [0, 0, 0.03] },
  { zone: 'paw', bone: 'RightFoot', r: 0.08, pos: [0, 0, 0.03] },
  { zone: 'belly', bone: 'Spine', box: [0.26, 0.22, 0.12], pos: [0, 0.03, 0.12] },
  { zone: 'tail', bone: 'Tail1', r: 0.085, pos: [0, 0.03, 0] },
  { zone: 'tail', bone: 'Tail3', r: 0.085, pos: [0, 0.03, 0] },
  { zone: 'body', bone: 'Spine', box: [0.4, 0.42, 0.34], pos: [0, 0.06, 0] },
  { zone: 'body', bone: 'Hips', box: [0.36, 0.22, 0.3], pos: [0, -0.05, 0] },
];

export class RigCat implements Character {
  readonly kind = 'rig' as const;
  readonly object = new THREE.Group();
  private root = new THREE.Bone();
  private bones = new Map<string, THREE.Bone>();
  readonly clips = new ClipState();
  readonly faceMix = new FaceMixer();
  private time = 0;
  private mouth = 0;
  private mouthShape: MouthShape = { open: 0, wide: 0, round: 0 };
  private look: THREE.Vector3 | null = null;
  private hitBox: THREE.Mesh;
  private zoneMeshes: THREE.Mesh[] = [];
  private mats = new Map<string, THREE.MeshStandardMaterial>();
  private lids: THREE.Mesh[] = [];
  private pupils: THREE.Mesh[] = [];
  private brows: THREE.Mesh[] = [];
  private cheeks: THREE.Mesh[] = [];
  private blush: THREE.Mesh[] = [];
  private tongue!: THREE.Mesh;
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v = new THREE.Vector3();
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
    // невидимые хитбоксы зон — дети костей (двигаются с анимацией)
    const inv = new THREE.MeshBasicMaterial({ visible: false });
    for (const z of ZONES) {
      const geo = z.r ? new THREE.SphereGeometry(z.r, 8, 6) : new THREE.BoxGeometry(...z.box!);
      const m = new THREE.Mesh(geo, inv);
      m.position.set(...z.pos);
      m.userData.zone = z.zone;
      m.name = 'zone-' + z.zone;
      this.bones.get(z.bone)?.add(m);
      this.zoneMeshes.push(m);
    }
  }

  get currentClip(): ClipName {
    return this.clips.requested;
  }
  get currentClipId() {
    return this.clips.cur.id;
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
    for (const side of [1, -1]) {
      const L = side > 0 ? 'Left' : 'Right';
      const up = this.bone(`${L}UpLeg`, hips, [0.085 * side, 0, 0]);
      this.blob(up, fur, [0.13, 0.14, 0.13], [0, -0.05, 0]);
      const leg = this.bone(`${L}Leg`, up, [0, -0.1, 0]);
      this.blob(leg, fur, [0.1, 0.1, 0.1], [0, -0.03, 0]);
      const foot = this.bone(`${L}Foot`, leg, [0, -0.07, 0.01]);
      this.blob(foot, white, [0.12, 0.06, 0.16], [0, -0.0, 0.03]);
    }
    const spine = this.bone('Spine', hips, [0, 0.05, 0]);
    this.blob(spine, fur, [0.34, 0.26, 0.28], [0, 0.04, 0]);
    const chest = this.blob(spine, white, [0.2, 0.2, 0.08], [0, 0.06, 0.11]);
    chest.name = 'chest';
    const spine1 = this.bone('Spine1', spine, [0, 0.14, 0]);
    this.blob(spine1, fur, [0.3, 0.2, 0.25], [0, 0.03, 0]);
    let tp: THREE.Object3D = hips;
    for (let i = 1; i <= 4; i++) {
      const b = this.bone(`Tail${i}`, tp, i === 1 ? [0, 0.02, -0.12] : [0, 0.045, -0.02]);
      if (i === 1) b.rotation.x = -0.9;
      this.blob(b, i === 4 ? furD : fur, [0.075 - i * 0.008, 0.08, 0.075 - i * 0.008], [0, 0.025, 0]);
      tp = b;
    }
    for (const side of [1, -1]) {
      const L = side > 0 ? 'Left' : 'Right';
      const sh = this.bone(`${L}Shoulder`, spine1, [0.12 * side, 0.08, 0]);
      const arm = this.bone(`${L}Arm`, sh, [0.03 * side, 0, 0]);
      this.blob(arm, fur, [0.085, 0.13, 0.085], [0, -0.05, 0]);
      const fore = this.bone(`${L}ForeArm`, arm, [0, -0.1, 0]);
      this.blob(fore, fur, [0.075, 0.1, 0.075], [0, -0.04, 0]);
      const hand = this.bone(`${L}Hand`, fore, [0, -0.085, 0]);
      this.blob(hand, white, [0.085, 0.07, 0.085], [0, -0.01, 0.005]);
      for (let f = 0; f < 4; f++) this.blob(hand, white, [0.025, 0.028, 0.03], [-0.03 + f * 0.02, -0.04, 0.025], 8);
    }
    const neck = this.bone('Neck', spine1, [0, 0.1, 0]);
    this.blob(neck, fur, [0.2, 0.12, 0.18], [0, 0.02, 0]);
    const head = this.bone('Head', neck, [0, 0.03, 0]);
    const hc = 0.19;
    this.blob(head, fur, [0.46, 0.36, 0.4], [0, hc, 0], 28);
    for (const side of [1, -1]) {
      this.cheeks.push(this.blob(head, fur, [0.17, 0.15, 0.17], [0.19 * side, hc - 0.07, 0.03]));
      this.blob(head, fur, [0.08, 0.06, 0.08], [0.25 * side, hc - 0.1, 0.0]);
      this.blob(head, white, [0.14, 0.1, 0.12], [0.06 * side, hc - 0.08, 0.15]);
      const bl = this.blob(head, new THREE.MeshBasicMaterial({ color: 0xff8fa8, transparent: true, opacity: 0, depthWrite: false }), [0.07, 0.035, 0.02], [0.14 * side, hc - 0.045, 0.19], 12);
      this.blush.push(bl);
    }
    this.blob(head, white, [0.1, 0.1, 0.06], [0, hc - 0.02, 0.18]);
    this.blob(head, pink, [0.045, 0.03, 0.03], [0, hc - 0.04, 0.215]);
    for (const side of [1, -1]) {
      const L = side > 0 ? 'Left' : 'Right';
      this.blob(head, eye, [0.1, 0.11, 0.05], [0.085 * side, hc + 0.03, 0.175]);
      const pupil = this.blob(head, black, [0.045, 0.07, 0.02], [0.085 * side, hc + 0.03, 0.203]);
      this.pupils.push(pupil);
      this.blob(pupil, shine as unknown as THREE.Material, [0.45, 0.3, 0.5], [-0.2, 0.35, 0.45], 8);
      const lidBone = this.bone(`${L}Eyelid`, head, [0.085 * side, hc + 0.03, 0.17]);
      const lid = this.blob(lidBone, fur, [0.115, 0.12, 0.06], [0, 0.0, 0.012]);
      lid.scale.y = 0.001;
      this.lids.push(lid);
      // брови — тонкие тёмные «капли» над глазами (двигаются по пресетам лица)
      const brow = this.blob(head, furD, [0.07, 0.014, 0.02], [0.085 * side, hc + 0.105, 0.19], 10);
      brow.userData.side = side;
      this.brows.push(brow);
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
    const jaw = this.bone('Jaw', head, [0, hc - 0.08, 0.16]);
    this.blob(jaw, this.mat('mouth', 0x7a2a3a), [0.05, 0.03, 0.02], [0, -0.012, 0.012]);
    this.blob(jaw, white, [0.09, 0.035, 0.06], [0, -0.03, 0.0]);
    this.tongue = this.blob(jaw, pink, [0.035, 0.03, 0.02], [0.012, -0.03, 0.03], 10);
    this.tongue.visible = false;
  }

  /** скин характера: одежда на тех же костях, цвета — палитра meta; Добряк: молочное худи + персиковый шарф */
  setPersona(p: Persona) {
    const meta = personaMeta(p.id);
    this.clips.setIdles(meta.idles, p.id);
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
    const col = (hex: string) => new THREE.Color(hex);
    // цвета одежды — из палитры характера (glitter: primary — лаванда, kind: primary — молочный)
    const hoodieHex = p.id === 'hooligan' ? '#161616' : meta.palette.primary;
    const trimHex = p.id === 'hooligan' ? '#1EE3CF' : meta.palette.secondary;
    const hoodie = new THREE.MeshStandardMaterial({ color: col(hoodieHex), roughness: 0.92 });
    const trim = new THREE.MeshStandardMaterial({ color: col(trimHex), roughness: 0.6 });
    this.object.getObjectByName('chest')!.visible = false;
    add('Spine', ell(hoodie, [0.37, 0.28, 0.33], [0, 0.04, 0]));
    add('Spine1', ell(hoodie, [0.33, 0.22, 0.29], [0, 0.03, 0]));
    add('Spine', ring(trim, 0.165, 0.01, [0, -0.08, 0], 1.08, 0.95));
    add('Spine1', ell(hoodie, [0.26, 0.1, 0.12], [0, 0.11, -0.1]));
    add('Spine1', ring(trim, 0.08, 0.008, [0, 0.12, 0.0], 1.2, 0.8));
    for (const L of ['Left', 'Right']) {
      add(`${L}Arm`, ell(hoodie, [0.095, 0.14, 0.095], [0, -0.05, 0]));
      add(`${L}ForeArm`, ell(hoodie, [0.083, 0.1, 0.083], [0, -0.04, 0]));
      add(`${L}ForeArm`, ring(trim, 0.04, 0.008, [0, -0.085, 0], 1, 1));
    }
    const patch = new THREE.Mesh(new THREE.CircleGeometry(0.03, 20), new THREE.MeshStandardMaterial({ color: 0x21a038, roughness: 0.5 }));
    patch.position.set(0.075, 0.07, 0.163);
    add('Spine', patch);
    if (p.id === 'glitter') {
      const gold = new THREE.MeshStandardMaterial({ color: col(meta.palette.accent), metalness: 0.6, roughness: 0.3 });
      const mint = this.mat('mint', 0x9ff0d6);
      add('Head', ell(mint, [0.09, 0.06, 0.05], [-0.13, 0.36, 0.05]));
      add('Head', ell(mint, [0.09, 0.06, 0.05], [-0.05, 0.37, 0.05]));
      const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.03), gold);
      star.position.set(-0.09, 0.365, 0.075);
      add('Head', star);
      // юбка-пачка
      const tutu = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.25, 0.06, 20, 1, true), new THREE.MeshStandardMaterial({ color: col(meta.palette.fx[1] ?? '#FF8FCB'), roughness: 0.7, side: THREE.DoubleSide, transparent: true, opacity: 0.85 }));
      tutu.position.set(0, -0.09, 0);
      add('Spine', tutu);
    } else if (p.id === 'kind') {
      // вязаный персиковый шарф: кольцо на шее + хвостик спереди
      const scarf = new THREE.MeshStandardMaterial({ color: col(meta.palette.accent), roughness: 1 });
      add('Neck', ring(scarf, 0.1, 0.035, [0, 0.0, 0.01], 1.15, 1));
      const tail = ell(scarf, [0.07, 0.16, 0.04], [0.06, -0.08, 0.13]);
      tail.rotation.z = 0.15;
      add('Spine1', tail);
      // помпоны-завязки худи
      for (const s of [-1, 1]) add('Spine1', ell(this.mat('mintTrim', 0x8bc6a8), [0.018, 0.05, 0.018], [0.03 * s, 0.03, 0.15]));
    } else {
      // Хулиган: кепка козырьком назад (лайм) + бирюзовые наушники на шее
      const cap = new THREE.MeshStandardMaterial({ color: col(meta.palette.secondary), roughness: 0.7 });
      const dome = new THREE.Mesh(new THREE.SphereGeometry(0.5, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), cap);
      dome.scale.set(0.36, 0.17, 0.33);
      dome.position.set(0, 0.32, -0.01);
      add('Head', dome);
      add('Head', ell(cap, [0.22, 0.02, 0.16], [0, 0.325, -0.17]));
      const phones = new THREE.MeshStandardMaterial({ color: 0x1ee3cf, roughness: 0.4 });
      add('Neck', ring(phones, 0.105, 0.012, [0, 0.0, 0.0], 1.1, 1));
      for (const s of [-1, 1]) add('Neck', ell(phones, [0.05, 0.06, 0.035], [0.1 * s, 0.0, 0.05]));
    }
  }

  play(clip: ClipName, opts: PlayOptions = {}) {
    if (clip !== 'knock_glass') this.reachT = null;
    this.clips.play(clip, opts);
  }

  /** то же, что face() — так зовёт director (эмоция реплики → пресет) */
  setFace(preset: string) {
    this.face(preset);
  }

  face(preset: string, ms = 0) {
    this.faceMix.set(preset, ms);
  }

  lookAt(world: THREE.Vector3 | null) {
    this.look = world ? world.clone() : null;
  }

  emote(e: Emote, ms = 1200) {
    if (e === 'blink') return this.faceMix.blink();
    this.faceMix.set(EMOTE_FACE[e] ?? 'neutral', ms);
  }

  setMouth(_v: Viseme, _w: number, shape: MouthShape) {
    this.mouth = clamp(shape.open, 0, 1);
    this.mouthShape = shape;
  }

  private apply(p: Pose, w: number, acc: { root: Record<string, number>; jaw: number; lids: number; sc: Record<string, number> }) {
    for (const n in p.b) {
      const b = this.bones.get(n);
      if (!b) continue;
      const [x, y, z] = p.b[n];
      b.quaternion.multiply(this.q.setFromEuler(this.e.set(x * w, y * w, z * w)));
    }
    const r = p.root;
    if (r) {
      for (const k of ['x', 'y', 'z', 'rx', 'ry', 'rz'] as const) acc.root[k] = (acc.root[k] ?? 0) + (r[k] ?? 0) * w;
      acc.root.s = (acc.root.s ?? 1) * (1 + ((r.s ?? 1) - 1) * w);
    }
    if (p.sc) for (const n in p.sc) acc.sc[n] = (acc.sc[n] ?? 1) * (1 + (p.sc[n] - 1) * w);
    acc.jaw += (p.jaw ?? 0) * w;
    acc.lids = Math.max(acc.lids, (p.lids ?? 0) * w);
  }

  private poseOf(id: string, k: number, t: number): Pose {
    const p = (RIG_CLIPS[id] ?? RIG_CLIPS.idle_breathe)(k, t);
    return id === 'knock_glass' && this.reachT ? this.reachPose(p, k, t) : p;
  }

  private reachT: { dx: number; dy: number } | null = null;
  /** стук в точку тапа: выбор руки (точка левее на экране — правая лапа кота) + подъём/опускание к точке */
  reach(target: { dx: number; dy: number } | null) {
    this.reachT = target;
  }
  private reachPose(p: Pose, k: number, t: number): Pose {
    const r = this.reachT!;
    // кот смотрит в камеру: левая часть экрана — его правая сторона
    const right = r.dx < 0;
    const side = right ? -1 : 1;
    const arm = right ? 'RightArm' : 'LeftArm', fore = right ? 'RightForeArm' : 'LeftForeArm';
    const other = right ? 'LeftArm' : 'RightArm', otherFore = right ? 'LeftForeArm' : 'RightForeArm';
    const w = tri(k);
    // угол к точке: 0 — вбок, + вверх; рука тянется вперёд к стеклу и в сторону точки
    const elev = clamp(Math.atan2(-r.dy, Math.max(0.05, Math.abs(r.dx))), -1.0, 1.3);
    const outward = clamp(Math.abs(r.dx) * 2.2, 0.15, 1.2);
    const knock = 0.5 * Math.max(0, Math.sin(t * 16));
    const b = { ...p.b };
    b[arm] = [(-1.2 + 0.5 * outward) * w, 0, side * ((Math.PI / 2) * Math.min(1, outward) + elev * 0.9) * w];
    b[fore] = [(-0.4 - knock) * w, 0, 0];
    delete b[other];
    delete b[otherFore];
    b.Spine1 = [0.12 * w, side * 0.15 * w * outward, side * 0.08 * w];
    b.Head = [-0.1 * w - elev * 0.15 * w, side * 0.25 * w * outward, 0];
    return { ...p, b };
  }

  update(dt: number, camera: THREE.Camera) {
    this.time += dt;
    const cs = this.clips;
    cs.update(dt);
    this.bones.forEach((b) => {
      const rest = (b.userData.rest ??= b.quaternion.clone()) as THREE.Quaternion;
      b.quaternion.copy(rest);
      b.scale.setScalar(1);
    });
    const acc = { root: {} as Record<string, number>, jaw: 0, lids: 0, sc: {} as Record<string, number> };
    if (cs.prev && cs.blend < 1) this.apply(this.poseOf(cs.prev.id, ClipState.k(cs.prev), cs.prev.t), 1 - cs.blend, acc);
    this.apply(this.poseOf(cs.cur.id, ClipState.k(cs.cur), cs.cur.t), cs.prev ? cs.blend : 1, acc);
    // лёгкое дыхание поверх любых клипов, кроме движения
    if (!cs.idleMode && !/^(walk|run|flip|tumble|sleep)/.test(cs.cur.id)) this.apply(RIG_CLIPS.idle_breathe(0, this.time), 0.3, acc);
    // additive: уши, хвост
    for (const a of cs.additive) this.apply(this.poseOf(a.id, ClipState.k(a), a.t), Math.min(1, a.t / Math.max(0.01, a.def.blendInMs / 1000)), acc);
    for (const n in acc.sc) this.bones.get(n)?.scale.setScalar(acc.sc[n]);

    const r = acc.root;
    this.root.position.set(r.x ?? 0, r.y ?? 0, r.z ?? 0);
    this.root.rotation.set(r.rx ?? 0, r.ry ?? 0, r.rz ?? 0);
    this.root.scale.setScalar(r.s ?? 1);
    if (r.rx) {
      this.root.position.y += 0.5 - 0.5 * Math.cos(r.rx);
      this.root.position.z += -0.5 * Math.sin(r.rx);
    }

    // ───── лицо: пресет + моргание + липсинк ─────
    const f = this.faceMix.update(dt);
    const W = f.weights;
    const head = this.bones.get('Head')!;
    const jaw = this.bones.get('Jaw')!;
    const open = clamp(acc.jaw + this.mouth * 0.9 + (W.mouth_A ?? 0) * 0.6 + (W.mouth_O ?? 0) * 0.5 + (W.mouth_U ?? 0) * 0.2, 0, 1);
    jaw.position.y = 0.11 - open * 0.03;
    jaw.scale.y = 1 + open * 0.8;
    const smile = (W.smile ?? 0) + (W.smirk ?? 0) * 0.6;
    jaw.scale.x = 1 + this.mouthShape.wide * 0.35 - this.mouthShape.round * 0.35 + smile * 0.35 - (W.mouth_O ?? 0) * 0.3 - (W.mouth_M ?? 0) * 0.2;
    jaw.rotation.z = (W.smirk ?? 0) * 0.25;
    this.tongue.visible = (W.tongue_out ?? 0) > 0.2;
    if (this.mouth > 0.05) head.quaternion.multiply(this.q.setFromEuler(this.e.set(-0.06 * this.mouth, 0.03 * Math.sin(this.time * 5), 0)));
    // веки: клип, моргание, прищур, сон/мурчание, подмигивание
    const squint = (W.eyes_squint ?? 0) * 0.45;
    const base = Math.max(acc.lids, f.blink, squint);
    const lidL = Math.max(base, W.blink_L ?? 0, W.wink_L ?? 0), lidR = Math.max(base, W.blink_R ?? 0, W.wink_R ?? 0);
    const wide = W.eyes_wide ?? 0;
    [lidL, lidR].forEach((v, i) => {
      const l = this.lids[i];
      const vv = v * (1 - wide * 0.5) * 0.12;
      l.visible = vv > 0.004;
      l.scale.y = Math.max(0.001, vv);
    });
    // зрачки: размер из пресета, спирали — вращаются
    const spiral = W.eyes_spiral ?? 0;
    this.pupils.forEach((pp, i) => {
      const s = f.pupils * (1 + wide * 0.15);
      pp.scale.set(0.045 * s, 0.07 * s * (1 - spiral * 0.35), 0.02);
      pp.rotation.z = spiral * this.time * 8 * (i ? -1 : 1);
    });
    // брови
    for (const b of this.brows) {
      const side = b.userData.side as number;
      b.position.y = 0.19 + 0.105 + (W.brow_up ?? 0) * 0.035 - (W.brow_down ?? 0) * 0.02 + (W.brow_sad ?? 0) * 0.01;
      b.rotation.z = side * ((W.brow_down ?? 0) * 0.35 - (W.brow_sad ?? 0) * 0.4);
    }
    // щёки (жвачка за щеками), румянец
    const gum = W.cheeks_gum ?? 0;
    this.cheeks.forEach((c) => c.scale.set(0.17 * (1 + gum * 0.35), 0.15 * (1 + gum * 0.2), 0.17 * (1 + gum * 0.3)));
    this.blush.forEach((b) => ((b.material as THREE.MeshBasicMaterial).opacity = (W.blush ?? 0) * 0.8));
    // уши из пресета: −1 прижаты, 1 торчком
    for (const L of ['Left', 'Right']) this.bones.get(`${L}Ear1`)!.quaternion.multiply(this.q.setFromEuler(this.e.set(f.ears >= 0 ? f.ears * 0.3 : f.ears * 0.9, 0, 0)));

    // взгляд к камере / точке
    if (!/^(flip|tumble|sleep|dive)/.test(cs.cur.id)) {
      const target = this.look ?? camera.getWorldPosition(this.v);
      this.object.updateMatrixWorld(true);
      const local = this.object.worldToLocal(target.clone());
      const yaw = clamp(Math.atan2(local.x, local.z), -0.7, 0.7);
      const pitch = clamp(Math.atan2(local.y - 0.8, Math.hypot(local.x, local.z)), -0.45, 0.45);
      head.quaternion.premultiply(this.q.setFromEuler(this.e.set(-pitch * 0.6, yaw * 0.7, 0)));
    }
  }

  hitTest(ray: THREE.Raycaster) {
    return ray.intersectObject(this.hitBox, false).length > 0 || this.hitZone(ray) !== null;
  }

  /** зона касания по хитбоксам на костях (щёки раньше головы, лапы раньше тела) */
  hitZone(ray: THREE.Raycaster): TouchZone | null {
    this.object.updateMatrixWorld(true);
    const hits = ray.intersectObjects(this.zoneMeshes, false);
    if (!hits.length) return ray.intersectObject(this.hitBox, false).length ? 'body' : null;
    // ближайшее попадание; при почти равной глубине — более «мелкая» зона важнее
    const prio: Record<TouchZone, number> = { cheek: 0, paw: 1, tail: 2, belly: 3, head: 4, body: 5 };
    const d0 = hits[0].distance;
    const near = hits.filter((h) => h.distance - d0 < 0.04);
    near.sort((a, b) => prio[a.object.userData.zone as TouchZone] - prio[b.object.userData.zone as TouchZone]);
    return near[0].object.userData.zone as TouchZone;
  }

  /** точки для эффектов — по костям (двигаются с анимацией) */
  anchorLocal(name: AnchorName): THREE.Vector3 | null {
    const map: Partial<Record<AnchorName, [string, V3]>> = {
      head: ['Head', [0, 0.19, 0.05]], mouth: ['Jaw', [0, -0.01, 0.04]], earL: ['LeftEar1', [0, 0.05, 0]], earR: ['RightEar1', [0, 0.05, 0]],
      pawR: ['RightHand', [0, -0.03, 0.03]], body: ['Spine', [0, 0.05, 0.1]], feet: ['Hips', [0, -0.2, 0.05]],
    };
    const m = map[name];
    const b = m && this.bones.get(m[0]);
    if (!b) return null;
    this.object.updateMatrixWorld(true);
    const p = new THREE.Vector3(...m[1]).applyMatrix4(b.matrixWorld);
    return this.object.worldToLocal(p);
  }

  posterImage() {
    return null;
  }

  dispose() {
    this.object.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
  }
}

export { tri };

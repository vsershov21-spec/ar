/**
 * 3D-режим: GLB + AnimationMixer. Клипы — по id каталога content/animations.json (имена анимаций в GLB
 * должны совпадать с id, регистр не важен); переход — blendInMs из каталога; additive-клипы (уши, хвост)
 * — отдельными действиями поверх. Нет клипа в GLB — процедурная поза-заглушка (procedural.ts).
 * Лицо — блендшейпы с именами из content/face.json (morphTargets) + кости ушей + масштаб зрачков.
 * Скин — показ/скрытие мешей по meta.glb (show/hide — подстроки имён).
 * Модуль грузится лениво (?char=glb): GLTFLoader и Draco не попадают в основной бандл.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Character, ClipName, Emote, PlayOptions, TouchZone } from './types';
import { procFor, type ProcPose } from './procedural';
import type { Persona } from '../persona/types';
import { asset, clamp } from '../core/util';
import { VISEME_TO_BLENDSHAPES, type MouthShape, type Viseme } from '../lipsync/visemes';
import { ClipState } from './clipState';
import { TailRig, type TailOutput } from './tailRig';
import { FaceMixer, EMOTE_FACE, MORPH_TARGETS } from './face';
import { personaMeta } from './personaMeta';
import type { AnchorName } from '../fx/core';

const BONES = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm', 'LeftHand', 'RightHand', 'LeftUpLeg', 'RightUpLeg', 'LeftFoot', 'RightFoot', 'LeftShoulder', 'RightShoulder', 'Jaw', 'Tail1', 'Tail2', 'Tail3', 'Tail4', 'LeftEar1', 'RightEar1', 'LeftEye', 'RightEye'];

/** кость → зона касания (ближайшая к точке попадания) */
const BONE_ZONE: Record<string, TouchZone> = {
  Head: 'head', Neck: 'head', LeftHand: 'paw', RightHand: 'paw', LeftForeArm: 'paw', RightForeArm: 'paw', LeftFoot: 'paw', RightFoot: 'paw',
  Spine: 'belly', Spine1: 'body', Spine2: 'body', Hips: 'body', Tail1: 'tail', Tail2: 'tail', Tail3: 'tail', Tail4: 'tail',
};


/**
 * Пресеты Tripo (скелет Mixamo) → id каталога content/animations.json. Клип из GLB с таким именем
 * регистрируется под нашим id (если под этим id ещё ничего нет). Первый подходящий выигрывает.
 */
export const TRIPO_ALIAS: Record<string, string[]> = {
  idle: ['idle_breathe'],
  standing_relax: ['sit_idle'],
  look_around: ['idle_look_around'],
  stretch: ['idle_stretch'],
  warm_up: ['idle_hooligan_skate'],
  walk: ['walk'],
  run: ['run'],
  jump: ['jump', 'celebrate'],
  jump_down: ['appear_jump_in'],
  flip: ['flip'],
  turn: ['turn_left', 'turn_right'],
  sit: ['sit_down'],
  fall: ['fall_off_card', 'tumble'],
  dive: ['dive_out'],
  greet_01: ['wave'],
  greet_02: ['point_button'],
  wave_goodbye_01: ['wave_goodbye'],
  laugh_01: ['laugh'],
  laugh_02: ['talk_excited'],
  cheer: ['celebrate', 'proud'],
  clap: ['clap'],
  scared_01: ['surprised', 'wake_startle'],
  frightened: ['flinch', 'cover_ears'],
  cry: ['cry'],
  depressed: ['sad'],
  hug: ['comfort', 'idle_kind_hug_self', 'hug_screen'],
  fold_arms: ['offended'],
  swagger: ['idle_hooligan_headphones'],
  complain_01: ['talk_casual'],
  agree: ['listen'],
  bow: ['bow'],
  heart_pose: ['idle_glitter_mirror'],
  sing_01: ['sing'],
  dance_01: ['dance_hooligan'],
  dance_02: ['dance_kind'],
  dance_03: ['dance_glitter', 'idle_glitter_twirl'],
  dance_04: ['dance_04'],
  dance_05: ['dance_05'],
  dance_06: ['dance_06'],
  play_mobile_game: ['card'],
  wait: ['think'],
  frustrated_01: ['dizzy'],
  defeat_02: ['tumble'],
  scratch: ['shy'],
  afraid: ['shy'],
  'knock on glass': ['knock_glass'],
};

export class GlbCharacter implements Character {
  readonly kind = 'glb' as const;
  readonly object = new THREE.Group();
  private model: THREE.Object3D | null = null;
  private inner = new THREE.Group();
  private mixer: THREE.AnimationMixer | null = null;
  private actions = new Map<string, THREE.AnimationAction>();
  private aliased = new Set<string>();
  readonly tailRig = new TailRig();
  /** последний результат хвоста/ушей (для debug и тестов) */
  tailOut: TailOutput | null = null;
  private personaId = 'kind';
  private hipsPrev: { yaw: number; y: number } | null = null;
  private tq = new THREE.Quaternion();
  private tq2 = new THREE.Quaternion();
  private tv = new THREE.Vector3();
  private bones = new Map<string, THREE.Bone>();
  private rest = new Map<string, THREE.Quaternion>();
  readonly clips = new ClipState();
  readonly faceMix = new FaceMixer();
  private playing = '';
  private mouth = 0;
  private look: THREE.Vector3 | null = null;
  private hitBox = new THREE.Mesh(new THREE.BoxGeometry(0.55, 1, 0.4), new THREE.MeshBasicMaterial({ visible: false }));
  private faces = new Map<string, THREE.Object3D>();
  private morphMeshes: THREE.Mesh[] = [];
  private time = 0;
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private visemeW: Record<string, number> = {};

  constructor(private url = 'models/character.glb', private animsUrl?: string) {
    this.object.name = 'character-glb';
    this.hitBox.position.y = 0.5;
    this.object.add(this.inner, this.hitBox);
  }

  get currentClip(): ClipName {
    return this.clips.requested;
  }

  async load() {
    const loader = new GLTFLoader();
    // Draco — только если GLB реально сжат (финальная модель ≤5 МБ): декодер грузится по требованию
    const raw = await fetch(asset(this.url)).then((r) => r.arrayBuffer());
    if (new TextDecoder().decode(new Uint8Array(raw, 0, Math.min(raw.byteLength, 4096))).includes('KHR_draco_mesh_compression')) {
      const { DRACOLoader } = await import('three/examples/jsm/loaders/DRACOLoader.js');
      loader.setDRACOLoader(new DRACOLoader());
    }
    const gltf = await loader.parseAsync(raw, asset(this.url).replace(/[^/]*$/, ''));
    const model = gltf.scene;
    this.model = model;
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model, true);
    const size = box.getSize(new THREE.Vector3());
    const k = 1 / (size.y || 1);
    model.scale.setScalar(k);
    model.position.set(-((box.min.x + box.max.x) / 2) * k, -box.min.y * k, -((box.min.z + box.max.z) / 2) * k);
    this.inner.add(model);

    model.traverse((o) => {
      const name = o.name.replace(/^mixamorig:?/, '');
      if ((o as THREE.Bone).isBone && BONES.includes(name)) {
        this.bones.set(name, o as THREE.Bone);
        this.rest.set(name, o.quaternion.clone());
      }
      if (/emotion_(happy|angry|usual)/i.test(o.name)) this.faces.set(o.name.match(/emotion_(\w+?)_/i)![1].toLowerCase(), o);
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.frustumCulled = false;
        if (m.morphTargetDictionary) this.morphMeshes.push(m);
      }
    });

    let anims = gltf.animations;
    // общая библиотека движений (тот же скелет Mixamo): Добряк и Блёстка берут клипы Хулигана
    if (this.animsUrl && this.animsUrl !== this.url) {
      try {
        const libLoader = new GLTFLoader();
        const { MeshoptDecoder } = await import('three/examples/jsm/libs/meshopt_decoder.module.js');
        libLoader.setMeshoptDecoder(MeshoptDecoder);
        const lib = await libLoader.loadAsync(asset(this.animsUrl));
        anims = [...anims, ...lib.animations];
      } catch (e) {
        console.warn('[glb] библиотека анимаций не загрузилась', e);
      }
    }
    if (anims.length) {
      this.mixer = new THREE.AnimationMixer(model);
      for (const clip of anims) this.addClip(clip);
    }
    this.setFaceObj('usual');
  }

  setPersona(p: Persona) {
    this.personaId = p.id;
    const meta = personaMeta(p.id);
    this.clips.setIdles(meta.idles, p.id);
    if (!this.model) return;
    const glb = { ...meta.glb, ...(p.glb ?? {}) };
    const show = glb.show ?? [];
    const hide = glb.hide ?? [];
    this.model.traverse((o) => {
      if (!(o as THREE.Mesh).isMesh && !o.children.some((c) => (c as THREE.Mesh).isMesh)) return;
      if (/emotion/i.test(o.name)) return;
      if (hide.some((h) => o.name.includes(h))) o.visible = false;
      else if (show.length && show.some((s) => o.name.includes(s))) o.visible = true;
    });
    const tint = glb.tint ?? {};
    this.model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const key = Object.keys(tint).find((k) => m.name.includes(k) || m.parent?.name.includes(k));
      const mat = m.material as THREE.MeshStandardMaterial;
      if (!mat || !('color' in mat)) return;
      if (!m.userData.origMat) m.userData.origMat = mat;
      if (key) {
        const c = (m.userData.origMat as THREE.MeshStandardMaterial).clone();
        c.color = new THREE.Color(tint[key]);
        m.material = c;
      } else m.material = m.userData.origMat;
    });
  }

  /** клип под своим именем + под нашими id по TRIPO_ALIAS; корневое смещение по X/Z убираем — место кота держит сцена */
  private addClip(clip: THREE.AnimationClip) {
    if (!this.mixer) return;
    clip.tracks = clip.tracks.filter((t) => !/hips\.position$/i.test(t.name) || this.keepY(t));
    const key = clip.name.toLowerCase().replace(/^.*\|/, '');
    const action = this.mixer.clipAction(clip);
    // своё имя (уже id каталога) важнее псевдонима; псевдонимы заполняют только пустые места
    this.actions.set(key, action);
    this.aliased.delete(key);
    for (const n of TRIPO_ALIAS[key] ?? []) {
      if (!this.actions.has(n) || this.aliased.has(n)) {
        if (this.aliased.has(n)) continue; // первый псевдоним выигрывает
        this.actions.set(n, action);
        this.aliased.add(n);
      }
    }
  }

  /** у Hips оставляем только вертикаль (прыжки, приседания) */
  private keepY(t: THREE.KeyframeTrack) {
    const v = t.values;
    for (let i = 0; i < v.length; i += 3) {
      v[i] = v[0];
      v[i + 2] = v[2];
    }
    return true;
  }

  play(clip: ClipName, opts: PlayOptions = {}) {
    this.clips.play(clip, opts);
  }

  /** синхронизация действий миксера с ClipState (кроссфейд blendInMs) */
  private syncMixer() {
    if (!this.mixer) return;
    const cs = this.clips;
    const id = cs.cur.id;
    if (id !== this.playing) {
      const next = this.actions.get(id);
      const prev = this.actions.get(this.playing);
      const fade = cs.cur.def.blendInMs / 1000;
      if (next) {
        next.reset();
        next.setLoop(cs.cur.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
        next.clampWhenFinished = !cs.cur.loop;
        next.fadeIn(fade).play();
      }
      prev?.fadeOut(fade);
      this.playing = id;
    }
    for (const a of cs.additive) {
      const act = this.actions.get(a.id);
      if (act && !act.isRunning()) {
        act.blendMode = THREE.AdditiveAnimationBlendMode;
        act.reset().setLoop(a.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity).fadeIn(a.def.blendInMs / 1000).play();
      }
    }
  }

  private setFaceObj(name: string) {
    if (!this.faces.size) return;
    const target = this.faces.has(name) ? name : 'usual';
    this.faces.forEach((o, k) => (o.visible = k === target));
  }

  /** то же, что face() — так зовёт director (эмоция реплики → пресет) */
  setFace(preset: string) {
    this.face(preset);
  }

  face(preset: string, ms = 0) {
    this.faceMix.set(preset, ms);
    // старая модель-заглушка: три объекта-эмоции
    this.setFaceObj(/happy|smile|excited|proud|celebr/.test(preset) ? 'happy' : /annoyed|offended/.test(preset) ? 'angry' : 'usual');
  }

  emote(e: Emote, ms = 1200) {
    if (e === 'blink') return this.faceMix.blink();
    this.face(EMOTE_FACE[e] ?? 'neutral', ms);
  }

  lookAt(world: THREE.Vector3 | null) {
    this.look = world ? world.clone() : null;
  }

  setMouth(v: Viseme, w: number, shape: MouthShape) {
    this.mouth = clamp(shape.open, 0, 1);
    const bs = VISEME_TO_BLENDSHAPES[v];
    this.visemeW = {};
    for (const key of ['mouth_A', 'mouth_E', 'mouth_O', 'mouth_U', 'mouth_M']) this.visemeW[key] = (bs[key] ?? 0) * w;
  }

  private applyPose(pose: ProcPose, w: number, root: THREE.Vector3, rootRot: THREE.Vector3, s: { v: number }) {
    for (const [name, [x, y, z]] of Object.entries(pose.bones)) {
      const b = this.bones.get(name);
      if (!b) continue;
      b.quaternion.multiply(this.q.setFromEuler(this.e.set(x * w, y * w, z * w)));
    }
    const r = pose.root;
    root.x += (r.x ?? 0) * w;
    root.y += (r.y ?? 0) * w;
    root.z += (r.z ?? 0) * w;
    rootRot.x += (r.rx ?? 0) * w;
    rootRot.y += (r.ry ?? 0) * w;
    rootRot.z += (r.rz ?? 0) * w;
    s.v *= 1 + ((r.s ?? 1) - 1) * w;
  }

  update(dt: number, camera: THREE.Camera) {
    this.time += dt;
    const cs = this.clips;
    cs.update(dt);
    this.syncMixer();
    const f = this.faceMix.update(dt);

    if (this.mixer && this.actions.has(cs.cur.id)) {
      this.mixer.update(dt);
    } else {
      this.mixer?.update(dt);
      this.rest.forEach((q, n) => this.bones.get(n)!.quaternion.copy(q));
      const root = new THREE.Vector3();
      const rot = new THREE.Vector3();
      const sc = { v: 1 };
      if (cs.prev && cs.blend < 1) this.applyPose(procFor(cs.prev.id)(ClipState.k(cs.prev), cs.prev.t), 1 - cs.blend, root, rot, sc);
      this.applyPose(procFor(cs.cur.id)(ClipState.k(cs.cur), cs.cur.t), cs.prev ? cs.blend : 1, root, rot, sc);
      if (!cs.idleMode) this.applyPose(procFor('idle')(0, this.time), 0.4, root, rot, sc);
      const head = this.bones.get('Head');
      if (head && this.mouth > 0 && !this.morphMeshes.length) head.quaternion.multiply(this.q.setFromEuler(this.e.set(-0.12 * this.mouth, 0, 0)));
      this.inner.position.copy(root);
      this.inner.rotation.set(rot.x, rot.y, rot.z);
      this.inner.scale.setScalar(sc.v);
      if (rot.x) this.inner.position.y += 0.5 - 0.5 * Math.cos(rot.x);
    }

    // лицо: блендшейпы пресета + моргание + липсинк (mouth_* поверх)
    for (const m of this.morphMeshes) {
      const d = m.morphTargetDictionary!;
      const inf = m.morphTargetInfluences!;
      for (const key of MORPH_TARGETS) {
        const i = d[key];
        if (i === undefined) continue;
        let v = f.weights[key] ?? 0;
        if (key === 'blink_L' || key === 'blink_R') v = Math.max(v, f.blink);
        if (key in this.visemeW) v = Math.max(v * 0.5, this.visemeW[key]);
        inf[i] = v;
      }
    }
    this.applyTailEars(dt, f.ears);
    for (const E of ['LeftEye', 'RightEye']) this.bones.get(E)?.scale.setScalar(f.pupils);

    const head = this.bones.get('Head');
    if (head) {
      const target = this.look ?? camera.getWorldPosition(new THREE.Vector3());
      const local = this.object.worldToLocal(target.clone());
      const yaw = clamp(Math.atan2(local.x, local.z), -0.6, 0.6);
      const pitch = clamp(Math.atan2(local.y - 0.85, Math.hypot(local.x, local.z)), -0.4, 0.4);
      head.quaternion.multiply(this.q.setFromEuler(this.e.set(-pitch * 0.5, yaw * 0.6, 0)));
    }
  }

  /** хвост и уши: сброс к покою и вторичная анимация TailRig поверх тела */
  private applyTailEars(dt: number, faceEars: number) {
    const names = ['Tail1', 'Tail2', 'Tail3', 'Tail4', 'LeftEar1', 'RightEar1'];
    for (const n of names) {
      const b = this.bones.get(n);
      const r = this.rest.get(n);
      if (b && r) b.quaternion.copy(r);
    }
    if (!this.bones.has('Tail1') && !this.bones.has('LeftEar1')) return;
    // скорость таза в пространстве персонажа (дрожание трекинга не трогает хвост)
    let yawVel = 0;
    let upVel = 0;
    const hips = this.bones.get('Hips');
    if (hips && dt > 0) {
      hips.updateWorldMatrix(true, false);
      const objQ = this.object.getWorldQuaternion(this.tq2).invert();
      const hq = hips.getWorldQuaternion(this.tq).premultiply(objQ);
      const fwd = this.tv.set(0, 0, 1).applyQuaternion(hq);
      const yaw = Math.atan2(fwd.x, fwd.z);
      const y = this.object.worldToLocal(hips.getWorldPosition(new THREE.Vector3())).y;
      if (this.hipsPrev) {
        let dy = yaw - this.hipsPrev.yaw;
        if (dy > Math.PI) dy -= 2 * Math.PI;
        if (dy < -Math.PI) dy += 2 * Math.PI;
        yawVel = clamp(dy / dt, -12, 12);
        upVel = clamp((y - this.hipsPrev.y) / dt, -4, 4);
      }
      this.hipsPrev = { yaw, y };
    }
    const out = this.tailRig.update(dt, {
      clip: this.clips.cur.id,
      face: this.faceMix.preset,
      faceEars: faceEars,
      additive: this.clips.additive.map((a) => a.id),
      persona: this.personaId,
      speaking: this.mouth,
      hipsYawVel: yawVel,
      hipsUpVel: upVel,
    });
    this.tailOut = out;
    const mq = (this.model ?? this.object).getWorldQuaternion(this.tq2);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(mq);
    const side = new THREE.Vector3(1, 0, 0).applyQuaternion(mq);
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(mq);
    ['Tail1', 'Tail2', 'Tail3', 'Tail4'].forEach((n, i) => {
      const b = this.bones.get(n);
      if (!b) return;
      this.rotWorld(b, up, out.tail[i][0]);
      this.rotWorld(b, side, out.tail[i][1]);
    });
    const eL = this.bones.get('LeftEar1');
    if (eL) {
      this.rotWorld(eL, side, out.earL[0]);
      this.rotWorld(eL, fwd, -out.earL[1]);
    }
    const eR = this.bones.get('RightEar1');
    if (eR) {
      this.rotWorld(eR, side, out.earR[0]);
      this.rotWorld(eR, fwd, out.earR[1]);
    }
  }

  /** поворот кости вокруг оси в мировых координатах (ось — уже в мире) */
  private rotWorld(b: THREE.Object3D, axis: THREE.Vector3, angle: number) {
    if (!angle || !b.parent) return;
    b.parent.updateWorldMatrix(true, false);
    const pq = b.parent.getWorldQuaternion(this.tq);
    const d = new THREE.Quaternion().setFromAxisAngle(axis, angle);
    const local = pq.clone().invert().multiply(d).multiply(pq);
    b.quaternion.premultiply(local);
    b.updateMatrixWorld(false);
  }

  hitTest(ray: THREE.Raycaster) {
    return ray.intersectObject(this.hitBox, false).length > 0;
  }

  /** зона: ближайшая к точке попадания кость (щека — голова сбоку от морды) */
  hitZone(ray: THREE.Raycaster): TouchZone | null {
    const hit = this.model ? ray.intersectObject(this.model, true)[0] : undefined;
    const p = hit?.point ?? ray.intersectObject(this.hitBox, false)[0]?.point;
    if (!p) return null;
    let best: TouchZone = 'body', bd = Infinity;
    const wp = new THREE.Vector3();
    for (const [name, zone] of Object.entries(BONE_ZONE)) {
      const b = this.bones.get(name);
      if (!b) continue;
      b.getWorldPosition(wp);
      const d = wp.distanceTo(p);
      if (d < bd) {
        bd = d;
        best = zone;
      }
    }
    if (best === 'head') {
      // щека: сбоку от морды и не выше глаз (в координатах кота: рост 1)
      const po = this.object.worldToLocal(p.clone());
      const ho = this.object.worldToLocal(this.bones.get('Head')!.getWorldPosition(new THREE.Vector3()));
      if (Math.abs(po.x - ho.x) > 0.12 && po.y < ho.y + 0.12) best = 'cheek';
    }
    return best;
  }

  anchorLocal(name: AnchorName): THREE.Vector3 | null {
    const bone = ({ head: 'Head', mouth: 'Jaw', earL: 'LeftEar1', earR: 'RightEar1', pawR: 'RightHand', body: 'Spine', feet: 'Hips' } as Record<AnchorName, string>)[name];
    const b = this.bones.get(bone) ?? (name === 'mouth' ? this.bones.get('Head') : undefined);
    if (!b) return null;
    const p = b.getWorldPosition(new THREE.Vector3());
    const l = this.object.worldToLocal(p);
    if (name === 'feet') l.y = 0.02;
    if (name === 'head' && bone === 'Head') l.y += 0.12;
    return l;
  }

  posterImage() {
    return null;
  }

  dispose() {
    this.model?.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
    });
  }
}

/**
 * 3D-режим: GLB + AnimationMixer + автомат состояний (через play()).
 * Если в GLB есть клипы с именами из CLIPS — играем их миксером с кроссфейдом;
 * иначе — процедурные костные анимации (procedural.ts).
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { CLIPS, type Character, type ClipName, type Emote, type PlayOptions } from './types';
import { PROC, type ProcPose } from './procedural';
import type { Persona } from '../persona/types';
import { asset, clamp } from '../core/util';
import { VISEME_TO_BLENDSHAPES, type MouthShape, type Viseme } from '../lipsync/visemes';

const BONES = ['Hips', 'Spine', 'Spine1', 'Neck', 'Head', 'LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm', 'LeftUpLeg', 'RightUpLeg', 'LeftShoulder', 'RightShoulder', 'Jaw', 'Tail1', 'Tail2', 'Tail3', 'Tail4'];

export class GlbCharacter implements Character {
  readonly kind = 'glb' as const;
  readonly object = new THREE.Group();
  private model: THREE.Object3D | null = null;
  private inner = new THREE.Group();
  private mixer: THREE.AnimationMixer | null = null;
  private actions = new Map<string, THREE.AnimationAction>();
  private bones = new Map<string, THREE.Bone>();
  private rest = new Map<string, THREE.Quaternion>();
  private clip: ClipName = 'idle';
  private prevClip: ClipName = 'idle';
  private clipT = 0;
  private prevT = 0;
  private blend = 1;
  private opts: PlayOptions = {};
  private mouth = 0;
  private look: THREE.Vector3 | null = null;
  private hitBox = new THREE.Mesh(new THREE.BoxGeometry(0.55, 1, 0.4), new THREE.MeshBasicMaterial({ visible: false }));
  private faces = new Map<string, THREE.Object3D>();
  private morphMeshes: THREE.Mesh[] = [];
  private emoteUntil = 0;
  private time = 0;
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();

  constructor(private url = 'models/character.glb') {
    this.object.name = 'character-glb';
    this.hitBox.position.y = 0.5;
    this.object.add(this.inner, this.hitBox);
  }

  get currentClip() {
    return this.clip;
  }

  async load() {
    const loader = new GLTFLoader();
    // Draco — для финальной сжатой модели (≤5 МБ). Декодер three (r187) подключается сборщиком сам
    // (new URL(..., import.meta.url)) и скачивается только если GLB реально сжат Draco.
    loader.setDRACOLoader(new DRACOLoader());
    const gltf = await loader.loadAsync(asset(this.url));
    const model = gltf.scene;
    this.model = model;
    // нормализация: ноги в 0, рост 1, центр по X/Z
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
        m.frustumCulled = false; // скин-меши иначе пропадают при анимации корня
        if (m.morphTargetDictionary) this.morphMeshes.push(m);
      }
    });

    if (gltf.animations.length) {
      this.mixer = new THREE.AnimationMixer(model);
      for (const clip of gltf.animations) this.actions.set(clip.name.toLowerCase(), this.mixer.clipAction(clip));
    }
    this.setFace('usual');
    this.play('idle');
  }

  setPersona(p: Persona) {
    if (!this.model) return;
    const show = p.glb?.show ?? [];
    const hide = p.glb?.hide ?? [];
    this.model.traverse((o) => {
      if (!(o as THREE.Mesh).isMesh && !o.children.some((c) => (c as THREE.Mesh).isMesh)) return;
      if (/emotion/i.test(o.name)) return;
      if (hide.some((h) => o.name.includes(h))) o.visible = false;
      else if (show.length && show.some((s) => o.name.includes(s))) o.visible = true;
    });
    const tint = p.glb?.tint ?? {};
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

  play(clip: ClipName, opts: PlayOptions = {}) {
    this.prevClip = this.clip;
    this.prevT = this.clipT;
    this.clip = clip;
    this.clipT = 0;
    this.blend = 0;
    this.opts = opts;
    const action = this.actions.get(clip);
    if (this.mixer && action) {
      const loop = opts.loop ?? CLIPS[clip].loop;
      action.reset();
      action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
      action.clampWhenFinished = !loop;
      action.fadeIn(0.25).play();
      this.actions.get(this.prevClip)?.fadeOut(0.25);
    }
    if (clip === 'laugh' || clip === 'appear' || clip === 'glitter_burst') this.emote('happy', 1500);
    if (clip === 'bored') this.emote('angry', 1200);
  }

  private setFace(name: string) {
    if (!this.faces.size) return;
    const target = this.faces.has(name) ? name : 'usual';
    this.faces.forEach((o, k) => (o.visible = k === target));
  }

  emote(e: Emote, ms = 1200) {
    const map: Record<Emote, string> = { neutral: 'usual', happy: 'happy', angry: 'angry', wink: 'happy', blink: 'usual', smirk: 'happy' };
    this.setFace(map[e]);
    this.emoteUntil = this.time + ms / 1000;
    // блендшейпы финальной модели (если есть): blink, smile, smirk, wink
    for (const m of this.morphMeshes) {
      const d = m.morphTargetDictionary!;
      const inf = m.morphTargetInfluences!;
      for (const key of Object.keys(d)) inf[d[key]] = key.toLowerCase().includes(e) ? 1 : 0;
    }
  }

  lookAt(world: THREE.Vector3 | null) {
    this.look = world ? world.clone() : null;
  }

  setMouth(v: Viseme, w: number, shape: MouthShape) {
    this.mouth = clamp(shape.open, 0, 1);
    // блендшейпы финальной модели: mouth_A/E/O/U/M (см. CHARACTER_SPEC.md)
    const bs = VISEME_TO_BLENDSHAPES[v];
    for (const m of this.morphMeshes) {
      const d = m.morphTargetDictionary!;
      for (const key of ['mouth_A', 'mouth_E', 'mouth_O', 'mouth_U', 'mouth_M']) {
        const i = d[key];
        if (i !== undefined) m.morphTargetInfluences![i] = (bs[key] ?? 0) * w;
      }
    }
  }

  private applyPose(pose: ProcPose, w: number, root: THREE.Vector3, rootRot: THREE.Vector3, s: { v: number }) {
    for (const [name, [x, y, z]] of Object.entries(pose.bones)) {
      const b = this.bones.get(name);
      if (!b) continue;
      this.e.set(x * w, y * w, z * w);
      this.q.setFromEuler(this.e);
      b.quaternion.multiply(this.q);
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
    this.clipT += dt;
    this.prevT += dt;
    this.blend = Math.min(1, this.blend + dt / 0.25);
    const spec = CLIPS[this.clip];
    const loop = this.opts.loop ?? spec.loop;
    if (!loop && this.clipT >= spec.dur) {
      const cb = this.opts.onEnd;
      this.play('idle');
      cb?.();
    }
    if (this.emoteUntil && this.time > this.emoteUntil) {
      this.emoteUntil = 0;
      this.setFace('usual');
    }

    if (this.mixer && this.actions.has(this.clip)) {
      this.mixer.update(dt);
    } else {
      // процедурная анимация: сброс к rest, затем наложение (с кроссфейдом от прошлого клипа)
      this.rest.forEach((q, n) => this.bones.get(n)!.quaternion.copy(q));
      const root = new THREE.Vector3();
      const rot = new THREE.Vector3();
      const sc = { v: 1 };
      const kOf = (c: ClipName, t: number) => (CLIPS[c].loop ? (t / CLIPS[c].dur) % 1 : Math.min(1, t / CLIPS[c].dur));
      if (this.blend < 1) this.applyPose(PROC[this.prevClip](kOf(this.prevClip, this.prevT), this.prevT), 1 - this.blend, root, rot, sc);
      this.applyPose(PROC[this.clip](kOf(this.clip, this.clipT), this.clipT), this.blend, root, rot, sc);
      if (this.clip !== 'idle') this.applyPose(PROC.idle(0, this.time), 0.4, root, rot, sc);
      // липсинк без блендшейпов: кивок головой по амплитуде
      const head = this.bones.get('Head');
      if (head && this.mouth > 0) head.quaternion.multiply(this.q.setFromEuler(this.e.set(-0.12 * this.mouth, 0, 0)));
      this.inner.position.copy(root);
      // поворот корня вокруг центра тела
      this.inner.rotation.set(rot.x, rot.y, rot.z);
      this.inner.scale.setScalar(sc.v);
      if (rot.x) this.inner.position.y += 0.5 - 0.5 * Math.cos(rot.x);
    }

    // взгляд: поворачиваем голову к точке (по умолчанию — к камере)
    const head = this.bones.get('Head');
    if (head) {
      const target = this.look ?? camera.getWorldPosition(new THREE.Vector3());
      const local = this.object.worldToLocal(target.clone());
      const yaw = clamp(Math.atan2(local.x, local.z), -0.6, 0.6);
      const pitch = clamp(Math.atan2(local.y - 0.85, Math.hypot(local.x, local.z)), -0.4, 0.4);
      head.quaternion.multiply(this.q.setFromEuler(this.e.set(-pitch * 0.5, yaw * 0.6, 0)));
    }
  }

  hitTest(ray: THREE.Raycaster) {
    return ray.intersectObject(this.hitBox, false).length > 0;
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

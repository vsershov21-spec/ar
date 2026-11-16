/**
 * Спрайт/видео-режим: плоскость-billboard на карте. Порядок источников для клипа:
 *  1) видео с альфой public/video/<persona>/<clip>.{mov,webm} — по public/video/manifest.json
 *     (HEVC .mov для Safari, VP9 .webm для Chrome/Android; манифест: npm run video-manifest);
 *  2) PNG/WebP-позы из video/sprites/manifest.json (смена кадров + твины);
 *  3) нет ни видео, ни поз для характера (например, Добряк) — риг-заглушка (RigCat) вместо плоскости.
 * Клипы — id каталога content/animations.json; для поз есть сопоставление со старыми именами.
 */
import * as THREE from 'three';
import type { Character, ClipName, Emote, PlayOptions, TouchZone } from './types';
import { ClipState } from './clipState';
import { LEGACY_CLIP } from './clips';
import { NEAREST } from './procedural';
import { RigCat } from './rigCat';
import { personaMeta } from './personaMeta';
import { DEFAULT_ZONES, zoneFromUv, type ZoneRects } from './zones';
import type { AnchorName } from '../fx/core';
import type { Persona } from '../persona/types';
import { asset, clamp, easeOutBack } from '../core/util';
import type { MouthShape, Viseme } from '../lipsync/visemes';

export interface SpriteManifest {
  /** точка опоры ног в кадре (0..1 от левого верхнего угла) */
  anchor: { x: number; y: number };
  /** PNG-формы рта (Rhubarb A–H, X) для оверлея на лицо */
  mouth?: { dir: string; shapes: Record<string, string> };
  personas: Record<string, {
    dir: string;
    poses: Record<string, { file: string; h?: number; anchorY?: number; mouth?: [number, number, number] }>;
    /** клип → поза(ы) (несколько = смена кадров) или видео */
    clips: Record<string, { poses?: string[]; fps?: number; video?: { hevc?: string; webm?: string; loop?: boolean }; atlas?: { file: string; cols: number; rows: number; frames: number; fps: number } }>;
    press?: string;
  }>;
}

interface Tween { name: string; t: number; dur: number }

/** public/video/manifest.json: какие видео-клипы с альфой есть у характера */
export interface VideoManifest {
  personas: Record<string, Record<string, { hevc?: string; webm?: string }>>;
}

/** id каталога → старое имя клипа спрайт-манифеста */
const LEGACY_BY_ID: Record<string, string> = Object.fromEntries(Object.entries(LEGACY_CLIP).map(([k, v]) => [v, k]));
/** твины (оживляют статичную позу) по старому имени клипа */
const TWEEN: Record<string, string> = {
  appear: 'pop', tumble: 'flip', laugh: 'shake', knock_glass: 'lunge', scratch: 'lunge', glitter_burst: 'jump',
  bubble_gum: 'inflate', heart_draw: 'sway', run_home: 'run', dance: 'dance', bored: 'droop', sticker: 'lunge', press_glass: 'lunge',
  flip: 'flip', jump: 'jump', walk: 'walk', run: 'walk', wave: 'sway', sit: 'droop',
};
/** твины для клипов каталога, у которых нет близкого старого */
const TWEEN_ID: Record<string, string> = {
  poke_head: 'nudge', poke_cheek: 'nudge', poke_belly: 'shake', poke_paw: 'nudge', poke_tail: 'jump', flinch: 'nudge', dizzy: 'sway',
  celebrate: 'jump', surprised: 'nudge', purr_stroke: 'sway', offended: 'droop', shy: 'droop', dive_out: 'hide', fall_off_card: 'shake',
  hug_screen: 'lunge', comfort: 'lunge', lean_in: 'lunge', snowglobe_shake: 'shake', idle_glitter_twirl: 'sway', sticker_slap: 'lunge',
};

export class SpriteCharacter implements Character {
  readonly kind = 'sprite' as const;
  readonly object = new THREE.Group();
  private pivot = new THREE.Group();
  private mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private hitMesh: THREE.Mesh;
  private manifest!: SpriteManifest;
  private persona = 'hooligan';
  private tex = new Map<string, THREE.Texture>();
  private imgs = new Map<string, HTMLImageElement>();
  private alphaCache = new Map<string, ImageData>();
  readonly clips = new ClipState();
  private shownId = '';
  private poseKey = '';
  private videos: VideoManifest = { personas: {} };
  /** характер без поз и видео → риг-заглушка */
  private rig: RigCat | null = null;
  private usingRig = false;
  private mouth = 0;
  private viseme: Viseme = 'X';
  private mouthW = 0;
  private mouthMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private mouthTex = new Map<string, THREE.Texture>();
  private pose = '';
  private tweens: Tween[] = [];
  private video: HTMLVideoElement | null = null;
  private time = 0;
  private lookTarget: THREE.Vector3 | null = null;

  constructor(private manifestUrl = 'video/sprites/manifest.json') {
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, alphaTest: 0.02 }),
    );
    this.mesh.name = 'sprite-plane';
    this.hitMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }));
    this.mouthMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.75), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, depthTest: false }));
    this.mouthMesh.visible = false;
    this.mouthMesh.renderOrder = 5;
    this.pivot.add(this.mesh, this.hitMesh, this.mouthMesh);
    this.object.add(this.pivot);
    this.object.name = 'character-sprite';
  }

  get currentClip(): ClipName {
    return this.usingRig && this.rig ? this.rig.currentClip : this.clips.requested;
  }

  async load() {
    const r = await fetch(asset(this.manifestUrl));
    this.manifest = await r.json();
    try {
      const v = await fetch(asset('video/manifest.json'));
      if (v.ok) this.videos = await v.json();
    } catch {
      /* видео-клипов нет */
    }
    // предзагрузка всех поз (небольшие webp) — смена позы без задержки
    const jobs: Promise<void>[] = [];
    for (const [pid, p] of Object.entries(this.manifest.personas)) {
      for (const [k, pose] of Object.entries(p.poses)) jobs.push(this.loadPose(`${pid}/${k}`, asset(p.dir + pose.file)));
    }
    if (this.manifest.mouth) {
      const md = this.manifest.mouth;
      for (const [v, f] of Object.entries(md.shapes))
        jobs.push(new Promise<void>((res) => {
          new THREE.TextureLoader().load(asset(md.dir + f), (t) => {
            t.colorSpace = THREE.SRGBColorSpace;
            this.mouthTex.set(v, t);
            res();
          }, undefined, () => res());
        }));
    }
    await Promise.all(jobs);
    this.applyPose();
  }

  private loadPose(key: string, url: string) {
    return new Promise<void>((resolve) => {
      const img = new Image();
      img.onload = () => {
        const t = new THREE.Texture(img);
        t.colorSpace = THREE.SRGBColorSpace;
        t.needsUpdate = true;
        this.tex.set(key, t);
        this.imgs.set(key, img);
        resolve();
      };
      img.onerror = () => {
        console.warn('[sprite] нет позы', url);
        resolve();
      };
      img.src = url;
    });
  }

  setPersona(p: Persona) {
    this.clips.setIdles(personaMeta(p.id).idles, p.id);
    const hasPoses = !!this.manifest?.personas[p.id];
    const hasVideo = Object.keys(this.videos.personas[p.id] ?? {}).length > 0;
    this.usingRig = !hasPoses && !hasVideo;
    if (this.usingRig) {
      if (!this.rig) {
        this.rig = new RigCat();
        this.object.add(this.rig.object);
      }
      this.rig.setPersona(p);
      this.rig.play(this.clips.requested);
    } else this.persona = p.id;
    if (this.rig) this.rig.object.visible = this.usingRig;
    this.pivot.visible = !this.usingRig;
    this.poseKey = '';
    this.shownId = '';
    this.applyPose();
  }

  private def() {
    return this.manifest.personas[this.persona] ?? Object.values(this.manifest.personas)[0];
  }

  play(clip: ClipName, opts: PlayOptions = {}) {
    if (this.usingRig && this.rig) {
      this.rig.play(clip, opts);
      this.clips.requested = this.rig.clips.requested;
      return;
    }
    this.clips.play(clip, opts);
  }

  /** клип каталога → имя клипа в спрайт-манифесте (тот же id, старое имя, ближайший) */
  private spriteClip(id: string): string {
    const clips = this.def()?.clips ?? {};
    if (clips[id]) return id;
    const legacy = LEGACY_BY_ID[id];
    if (legacy && clips[legacy]) return legacy;
    if (id.startsWith('idle')) return 'idle';
    if (id.startsWith('dance')) return 'dance';
    const near = NEAREST[id];
    return near && clips[near] ? near : 'idle';
  }

  /** смена клипа тела (из ClipState) → видео или позы + твин */
  private onClipChanged() {
    const tr = this.clips.cur;
    this.shownId = tr.id;
    this.stopVideo();
    const vid = this.videos.personas[this.persona]?.[tr.id];
    const name = this.spriteClip(tr.id);
    const c = this.def()?.clips[name];
    if (vid) this.startVideo(vid, tr.loop);
    else if (c?.video && name === tr.id) this.startVideo(c.video, tr.loop);
    const tw = TWEEN_ID[tr.id] ?? TWEEN[name] ?? TWEEN[LEGACY_BY_ID[tr.id] ?? ''];
    if (tw && !this.video) this.tween(tw, tr.def.durationS);
    this.poseKey = '';
    this.applyPose();
  }

  /** squash-stretch прыжок (вызывается и извне — при тапе по коту) */
  tween(name: string, dur = 0.6) {
    this.tweens = this.tweens.filter((t) => t.name !== name);
    this.tweens.push({ name, t: 0, dur });
  }

  private startVideo(v: { hevc?: string; webm?: string }, loop: boolean) {
    // Safari: HEVC с альфой (.mov, hvc1); Chrome/Android: VP9 с альфой (.webm)
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.loop = loop;
    video.crossOrigin = 'anonymous';
    const canHevc = video.canPlayType('video/mp4; codecs="hvc1"') !== '';
    const src = canHevc && v.hevc ? v.hevc : v.webm ?? v.hevc;
    if (!src) return;
    video.src = asset(src);
    video.play().catch(() => undefined);
    const t = new THREE.VideoTexture(video);
    t.colorSpace = THREE.SRGBColorSpace;
    this.video = video;
    this.mesh.material.map = t;
    this.mesh.material.needsUpdate = true;
  }

  private stopVideo() {
    if (!this.video) return;
    this.video.pause();
    this.video.removeAttribute('src');
    this.video = null;
  }

  private poseForTime(): string {
    const d = this.def();
    if (!d) return '';
    const name = this.spriteClip(this.clips.cur.id);
    const c = d.clips[name] ?? d.clips.idle;
    const poses = c?.poses ?? ['idle'];
    const fps = c?.fps ?? 2;
    let i = Math.floor(this.clips.cur.t * fps) % poses.length;
    // липсинк в спрайт-режиме: при громком звуке — поза с открытым ртом (если задана 2-й в talk)
    if (name === 'talk' && poses.length > 1 && !this.manifest.mouth) i = this.mouth > 0.35 ? 1 : 0;
    return poses[i];
  }

  private applyPose() {
    if (!this.manifest || this.video) return;
    const pose = this.poseForTime();
    const key = `${this.persona}/${pose}`;
    if (key === this.poseKey) return;
    const tex = this.tex.get(key);
    const img = this.imgs.get(key);
    if (!tex || !img) return;
    this.poseKey = key;
    this.pose = pose;
    this.mesh.material.map = tex;
    this.mesh.material.needsUpdate = true;
    const pd = this.def().poses[pose];
    const h = pd?.h ?? 1;
    const w = (h * img.width) / img.height;
    const ay = pd?.anchorY ?? this.manifest.anchor.y;
    this.mesh.scale.set(w, h, 1);
    // точка опоры ног (ay — доля высоты кадра от верха) попадает в y=0
    this.mesh.position.set(0, h * (ay - 0.5), 0);
    this.hitMesh.scale.copy(this.mesh.scale).multiplyScalar(0.8);
    this.hitMesh.position.copy(this.mesh.position);
  }

  lookAt(world: THREE.Vector3 | null) {
    this.lookTarget = world;
  }

  emote(e: Emote, ms?: number) {
    if (this.usingRig) return this.rig?.emote(e, ms);
    // в спрайт-режиме эмоции заложены в позах; короткий «вздрог» как обратная связь
    if (e !== 'blink') this.tween('nudge', 0.25);
  }

  face(preset: string, ms = 0) {
    if (this.usingRig) return this.rig?.face(preset, ms);
    // лица в позах/видео; пресет даёт только мимический «вздрог»
    if (preset !== 'neutral') this.tween('nudge', 0.2);
  }

  setMouth(v: Viseme, w: number, shape: MouthShape) {
    this.rig?.setMouth(v, w, shape);
    this.mouth = clamp(shape.open, 0, 1);
    this.viseme = v;
    this.mouthW = w;
  }

  /** оверлей рта: PNG формы поверх лица, если у позы задана точка рта */
  private updateMouthOverlay() {
    const pd = this.def()?.poses[this.pose];
    const tex = this.mouthTex.get(this.viseme);
    const speaking = this.viseme !== 'X' || this.mouthW < 0.9;
    if (!pd?.mouth || !tex || !speaking || this.video) {
      this.mouthMesh.visible = false;
      return;
    }
    const [mx, my, mw] = pd.mouth;
    const sw = this.mesh.scale.x, sh = this.mesh.scale.y;
    this.mouthMesh.visible = true;
    this.mouthMesh.material.map = tex;
    this.mouthMesh.material.needsUpdate = true;
    this.mouthMesh.scale.set(mw * sw, mw * sw, 1);
    this.mouthMesh.position.set(this.mesh.position.x + (mx - 0.5) * sw, this.mesh.position.y + (0.5 - my) * sh, 0.002);
  }

  update(dt: number, camera: THREE.Camera) {
    this.time += dt;
    if (this.usingRig && this.rig) {
      this.rig.object.userData.tilt = this.object.userData.tilt;
      this.rig.update(dt, camera);
      this.clips.requested = this.rig.clips.requested;
      return;
    }
    this.clips.update(dt);
    if (this.clips.cur.id !== this.shownId) this.onClipChanged();
    this.applyPose();
    this.updateMouthOverlay();

    // базовая жизнь: дыхание и лёгкое покачивание
    let sx = 1 + 0.012 * Math.sin(this.time * 2.4);
    let sy = 1 - 0.012 * Math.sin(this.time * 2.4);
    let y = 0, rz = 0.025 * Math.sin(this.time * 1.1), x = 0, rx = 0, z = 0;
    // липсинк — вертикальный «пульс»
    sy += this.mouth * 0.035;
    sx -= this.mouth * 0.015;

    for (const tw of this.tweens) {
      tw.t += dt;
      const k = clamp(tw.t / tw.dur, 0, 1);
      const s = Math.sin(k * Math.PI);
      switch (tw.name) {
        case 'pop': {
          const e = easeOutBack(clamp(k * 1.6, 0, 1));
          sx *= e;
          sy *= e * (1 + 0.25 * Math.sin(clamp(k * 1.6, 0, 1) * Math.PI));
          y += 0.35 * Math.sin(clamp(k * 1.25, 0, 1) * Math.PI);
          break;
        }
        case 'jump': {
          const squash = k < 0.15 ? Math.sin((k / 0.15) * Math.PI) : 0;
          y += 0.28 * Math.sin(clamp((k - 0.12) / 0.88, 0, 1) * Math.PI);
          sy *= 1 - 0.18 * squash + 0.1 * s;
          sx *= 1 + 0.15 * squash - 0.05 * s;
          break;
        }
        case 'flip': {
          // сальто вокруг центра тела, а не вокруг лап
          const a = -easeOutBack(k) * Math.PI * 2;
          y += 0.45 * s + 0.5 - 0.5 * Math.cos(a);
          x += 0.5 * Math.sin(a);
          rz += a;
          break;
        }
        case 'shake':
          rz += 0.08 * Math.sin(k * 40) * (1 - k);
          sy *= 1 + 0.04 * Math.sin(k * 30);
          break;
        case 'lunge':
          z += 0.18 * s;
          rx += 0.15 * s;
          break;
        case 'inflate':
          sx *= 1 + 0.06 * s;
          sy *= 1 - 0.03 * s;
          break;
        case 'sway':
          rz += 0.12 * Math.sin(k * Math.PI * 4);
          break;
        case 'dance':
          rz += 0.15 * Math.sin(k * Math.PI * 8);
          y += 0.06 * Math.abs(Math.sin(k * Math.PI * 8));
          break;
        case 'run':
          x += k * 1.2;
          y += 0.08 * Math.abs(Math.sin(k * 30));
          break;
        case 'droop':
          sy *= 1 - 0.06 * s;
          rz += 0.08 * s;
          break;
        case 'walk':
          y += 0.03 * Math.abs(Math.sin(tw.t * 10));
          rz += 0.05 * Math.sin(tw.t * 10);
          break;
        case 'nudge':
          sy *= 1 - 0.08 * s;
          sx *= 1 + 0.06 * s;
          break;
        case 'hide': // исчезнуть и вернуться
          sx *= 1 - s;
          sy *= 1 - s;
          break;
      }
    }
    this.tweens = this.tweens.filter((t) => t.t < t.dur);

    this.pivot.position.set(x, y, z);
    this.pivot.scale.set(sx, sy, 1);
    this.pivot.rotation.set(rx, 0, rz);

    // billboard по наклону: плоскость чуть заваливается к камере (доля задаётся Stage через userData.tilt)
    const tilt = (this.object.userData.tilt as number) ?? 0.35;
    const camLocal = this.object.worldToLocal(camera.getWorldPosition(new THREE.Vector3()));
    const pitch = Math.atan2(camLocal.y - 0.5, Math.hypot(camLocal.x, camLocal.z));
    this.pivot.rotation.x += -pitch * tilt;
    void this.lookTarget;
  }

  hitTest(ray: THREE.Raycaster): boolean {
    if (this.usingRig && this.rig) return this.rig.hitTest(ray);
    return this.hitUv(ray) !== null;
  }

  /** зона касания: по прямоугольникам позы (manifest poses.<pose>.zones) или по умолчанию */
  hitZone(ray: THREE.Raycaster): TouchZone | null {
    if (this.usingRig && this.rig) return this.rig.hitZone(ray);
    const uv = this.hitUv(ray);
    if (!uv) return null;
    const pd = this.def()?.poses[this.pose] as { zones?: ZoneRects } | undefined;
    return zoneFromUv(uv.x, 1 - uv.y, pd?.zones ?? DEFAULT_ZONES);
  }

  anchorLocal(name: AnchorName): THREE.Vector3 | null {
    if (this.usingRig && this.rig) {
      const p = this.rig.anchorLocal(name);
      return p ? this.object.worldToLocal(this.rig.object.localToWorld(p)) : null;
    }
    return null;
  }

  /** точка попадания на плоскость (uv), если там непрозрачный кот */
  private hitUv(ray: THREE.Raycaster): THREE.Vector2 | null {
    const hits = ray.intersectObject(this.mesh, false);
    if (!hits.length) return null;
    // проверка альфы в точке попадания: прозрачные поля спрайта — не кот
    const uv = hits[0].uv;
    const img = this.imgs.get(this.poseKey);
    if (!uv || !img) return uv ?? new THREE.Vector2(0.5, 0.5);
    let data = this.alphaCache.get(this.poseKey);
    if (!data) {
      const c = document.createElement('canvas');
      c.width = 64;
      c.height = 64;
      const g = c.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(img, 0, 0, 64, 64);
      data = g.getImageData(0, 0, 64, 64);
      this.alphaCache.set(this.poseKey, data);
    }
    // небольшой допуск: смотрим окрестность 3×3
    const px = Math.floor(uv.x * 63), py = Math.floor((1 - uv.y) * 63);
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const xx = clamp(px + dx, 0, 63), yy = clamp(py + dy, 0, 63);
        if (data.data[(yy * 64 + xx) * 4 + 3] > 40) return uv;
      }
    return null;
  }

  posterImage() {
    if (this.usingRig) return null;
    const d = this.def();
    const key = `${this.persona}/${d?.press ?? 'listen'}`;
    return this.imgs.get(key) ?? this.imgs.get(this.poseKey) ?? null;
  }

  dispose() {
    this.stopVideo();
    this.rig?.dispose();
    this.tex.forEach((t) => t.dispose());
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

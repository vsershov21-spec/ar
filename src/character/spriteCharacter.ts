/**
 * Спрайт/видео-режим: плоскость-billboard на карте.
 * Источник кадров (по manifest.json): PNG/WebP-позы со сменой и твинами (сейчас),
 * прозрачное видео (.mov HEVC alpha для Safari, .webm VP9 alpha для Chrome) или атлас-секвенция.
 */
import * as THREE from 'three';
import { CLIPS, type Character, type ClipName, type Emote, type PlayOptions } from './types';
import type { Persona } from '../persona/types';
import { asset, clamp, easeOutBack } from '../core/util';

export interface SpriteManifest {
  /** точка опоры ног в кадре (0..1 от левого верхнего угла) */
  anchor: { x: number; y: number };
  personas: Record<string, {
    dir: string;
    poses: Record<string, { file: string; h?: number; anchorY?: number }>;
    /** клип → поза(ы) (несколько = смена кадров) или видео */
    clips: Record<string, { poses?: string[]; fps?: number; video?: { hevc?: string; webm?: string; loop?: boolean }; atlas?: { file: string; cols: number; rows: number; frames: number; fps: number } }>;
    press?: string;
  }>;
}

interface Tween { name: string; t: number; dur: number }

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
  private clip: ClipName = 'idle';
  private clipT = 0;
  private opts: PlayOptions = {};
  private poseKey = '';
  private mouth = 0;
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
    this.pivot.add(this.mesh, this.hitMesh);
    this.object.add(this.pivot);
    this.object.name = 'character-sprite';
  }

  get currentClip() {
    return this.clip;
  }

  async load() {
    const r = await fetch(asset(this.manifestUrl));
    this.manifest = await r.json();
    // предзагрузка всех поз (небольшие webp) — смена позы без задержки
    const jobs: Promise<void>[] = [];
    for (const [pid, p] of Object.entries(this.manifest.personas)) {
      for (const [k, pose] of Object.entries(p.poses)) jobs.push(this.loadPose(`${pid}/${k}`, asset(p.dir + pose.file)));
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
    if (this.manifest?.personas[p.id]) this.persona = p.id;
    this.poseKey = '';
    this.applyPose();
  }

  private def() {
    return this.manifest.personas[this.persona] ?? Object.values(this.manifest.personas)[0];
  }

  play(clip: ClipName, opts: PlayOptions = {}) {
    this.clip = clip;
    this.clipT = 0;
    this.opts = opts;
    this.stopVideo();
    const c = this.def()?.clips[clip];
    if (c?.video) this.startVideo(c.video, opts.loop ?? CLIPS[clip].loop);
    // твины по клипам — оживляют статичные позы
    const tw: Record<string, string> = {
      appear: 'pop', tumble: 'flip', laugh: 'shake', knock_glass: 'lunge', scratch: 'lunge', glitter_burst: 'jump',
      bubble_gum: 'inflate', heart_draw: 'sway', run_home: 'run', dance: 'dance', bored: 'droop', sticker: 'lunge', press_glass: 'lunge',
      flip: 'flip', jump: 'jump', walk: 'walk', run: 'walk', wave: 'sway', sit: 'droop',
    };
    if (tw[clip]) this.tween(tw[clip], CLIPS[clip].dur);
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
    const c = d.clips[this.clip] ?? d.clips.idle;
    const poses = c?.poses ?? ['idle'];
    const fps = c?.fps ?? 2;
    let i = Math.floor(this.clipT * fps) % poses.length;
    // липсинк в спрайт-режиме: при громком звуке — поза с открытым ртом (если задана 2-й в talk)
    if (this.clip === 'talk' && poses.length > 1) i = this.mouth > 0.35 ? 1 : 0;
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

  emote(_e: Emote) {
    // в спрайт-режиме эмоции заложены в позах; короткий «вздрог» как обратная связь
    this.tween('nudge', 0.25);
  }

  setMouth(open: number) {
    this.mouth = clamp(open, 0, 1);
  }

  update(dt: number, camera: THREE.Camera) {
    this.time += dt;
    this.clipT += dt;
    const spec = CLIPS[this.clip];
    const loop = this.opts.loop ?? spec.loop;
    if (!loop && this.clipT >= spec.dur) {
      const cb = this.opts.onEnd;
      this.play('idle');
      cb?.();
    }
    this.applyPose();

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
    const hits = ray.intersectObject(this.mesh, false);
    if (!hits.length) return false;
    // проверка альфы в точке попадания: прозрачные поля спрайта — не кот
    const uv = hits[0].uv;
    const img = this.imgs.get(this.poseKey);
    if (!uv || !img) return true;
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
        if (data.data[(yy * 64 + xx) * 4 + 3] > 40) return true;
      }
    return false;
  }

  posterImage() {
    const d = this.def();
    const key = `${this.persona}/${d?.press ?? 'listen'}`;
    return this.imgs.get(key) ?? this.imgs.get(this.poseKey) ?? null;
  }

  dispose() {
    this.stopVideo();
    this.tex.forEach((t) => t.dispose());
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

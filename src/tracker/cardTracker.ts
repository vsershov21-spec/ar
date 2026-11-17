/**
 * Трекер «любая банковская карта»: камера → уменьшенный кадр (320 px по длинной стороне) → Web Worker с
 * детектором (src/tracker/card/detector.ts) → 4 угла → поза карты (гомография → R, t) → якорь кота.
 * Никакой картинки-маркера: подходит любая карта ID-1 (85.60 × 53.98 мм), в том числе любая карта Сбера.
 *
 * Рамка на экране не висит статично: CardOverlay рисует контур по реальным углам карты, когда она найдена
 * (см. ./card/overlay.ts). Найдена — после 2 кадров подряд (случайный прямоугольник не «моргнёт» котом),
 * потеряна — после 5 промахов подряд (≈ 0,3 с) + общий дебаунс TrackerBase.
 */
import * as THREE from 'three';
import { TrackerBase } from './base';
import type { Tracker } from './types';
import { CARD_ASPECT, labelCard, poseFromQuad, type Intrinsics, type Pose, type Pt, type Quad } from './card/geometry';
import { focalFromFov } from './card/detector';
import type { CardWorkerIn, CardWorkerOut } from './card/worker';
import { CardOverlay } from './card/overlay';

export interface CardView {
  /** углы карты (TL, TR, BR, BL) в px экрана */
  quad: Quad;
  pose: Pose;
  /** проекция точки модели карты (X, Y — ширины карты) в px экрана */
  project: (x: number, y: number) => Pt | null;
}

export class CardTracker extends TrackerBase implements Tracker {
  readonly capabilities = { imageTarget: true, worldTracking: false, orientationFallback: true };
  readonly name = 'card';
  readonly aspect = CARD_ASPECT;
  video: HTMLVideoElement | null = null;
  readonly overlay: CardOverlay;
  /** последнее, что видел детектор (для оверлея и debug) */
  view: CardView | null = null;
  stats = { ms: 0, fps: 0, score: 0, mode: 'none' };
  /** последняя нумерация углов: держим ориентацию кота и после короткой потери карты */
  private orientRef: Quad | null = null;
  private orientAt = -1e9;

  private worker: Worker | null = null;
  private busy = false;
  private running = false;
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
  private dw = 320;
  private dh = 180;
  private K: Intrinsics = { f: 300, cx: 160, cy: 90 };
  private prevQuad: Quad | null = null;
  private hits = 0;
  private misses = 0;
  private w = 1;
  private h = 1;
  /** видео на экране (object-fit: cover): размер и сдвиг */
  private vw = 1;
  private vh = 1;
  private frames = 0;
  private fpsT = 0;

  constructor(private container: HTMLElement) {
    super();
    // кот держится по поверхности и гироскопу; «карта потеряна» (кот спрашивает, где карта) — только после 2,5 с
    this.lostDebounceMs = 2500;
    this.overlay = new CardOverlay(container);
  }

  /** Камера: вызывать прямо из обработчика жеста (iOS требует user gesture для getUserMedia/play). */
  async startVideo(): Promise<void> {
    const video = document.createElement('video');
    video.setAttribute('autoplay', '');
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.muted = true;
    video.playsInline = true;
    video.className = 'camera-video';
    // экран заполняет сам браузер (object-fit: cover); геометрию той же обрезки считаем в resize()
    Object.assign(video.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', objectFit: 'cover', zIndex: '0' });
    this.container.prepend(video);
    // iOS: размер кадра становится известен (и меняется при повороте) после старта — пересчитать всё
    video.addEventListener('resize', () => this.onVideoSize());
    video.addEventListener('loadedmetadata', () => this.onVideoSize());
    this.video = video;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('no-getusermedia');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    await new Promise<void>((resolve) => {
      video.addEventListener('loadedmetadata', () => resolve(), { once: true });
      video.srcObject = stream;
    });
    await video.play().catch(() => undefined);
  }

  async start(): Promise<void> {
    if (!this.video) await this.startVideo();
    this.hold.start();
    this.worker = new Worker(new URL('./card/worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<CardWorkerOut>) => this.onResult(e.data);
    this.worker.onerror = (e) => console.warn('[card] worker', e.message);
    this.running = true;
    this.setupFrame();
    this.resize(this.w, this.h);
    this.pump();
  }

  stop() {
    this.running = false;
    this.worker?.terminate();
    this.worker = null;
    const s = this.video?.srcObject as MediaStream | null;
    s?.getTracks().forEach((t) => t.stop());
    this.video?.remove();
    this.video = null;
    this.overlay.hide(true);
  }

  private lastVW = 0;
  private lastVH = 0;
  private onVideoSize() {
    const v = this.video;
    if (!v || !v.videoWidth || !v.videoHeight) return;
    if (v.videoWidth === this.lastVW && v.videoHeight === this.lastVH) return;
    this.lastVW = v.videoWidth;
    this.lastVH = v.videoHeight;
    this.setupFrame();
    this.resize(this.w, this.h);
    this.prevQuad = null;
    this.worker?.postMessage({ rgba: new ArrayBuffer(4), w: 1, h: 1, focal: 1, reset: true });
  }

  private setupFrame() {
    const v = this.video!;
    const vw = v.videoWidth || 1280, vh = v.videoHeight || 720;
    const k = 320 / Math.max(vw, vh);
    this.dw = Math.round(vw * k);
    this.dh = Math.round(vh * k);
    this.canvas.width = this.dw;
    this.canvas.height = this.dh;
    this.K = { f: focalFromFov(this.dw, this.dh), cx: this.dw / 2, cy: this.dh / 2 };
  }

  /** следующий кадр — в воркер, как только он освободился */
  private pump = () => {
    if (!this.running) return;
    const v = this.video;
    if (!this.busy && v && v.readyState >= 2 && this.worker) {
      if (v.videoWidth !== this.lastVW || v.videoHeight !== this.lastVH) this.onVideoSize();
      this.ctx.drawImage(v, 0, 0, this.dw, this.dh);
      const img = this.ctx.getImageData(0, 0, this.dw, this.dh);
      this.busy = true;
      const msg: CardWorkerIn = { rgba: img.data.buffer as ArrayBuffer, w: this.dw, h: this.dh, focal: this.K.f };
      this.worker.postMessage(msg, [msg.rgba]);
    }
    requestAnimationFrame(this.pump);
  };

  private onResult(r: CardWorkerOut) {
    this.busy = false;
    this.stats.ms = r.ms;
    this.stats.score = r.score;
    this.stats.mode = r.mode;
    this.frames++;
    const now = performance.now();
    if (now - this.fpsT > 1000) {
      this.stats.fps = (this.frames * 1000) / (now - this.fpsT || 1);
      this.frames = 0;
      this.fpsT = now;
    }
    let pose: Pose | null = null;
    let quad: Quad | null = null;
    if (r.quad && r.score >= 0.5) {
      quad = labelCard(r.quad, this.K, this.prevQuad ?? (performance.now() - this.orientAt < 8000 ? this.orientRef : null));
      pose = poseFromQuad(quad, this.K, CARD_ASPECT);
      if (pose && (pose.err > 4 || pose.t[2] > -0.5)) pose = null; // перепроецирование плохое или «карта за камерой»
    }
    if (pose && quad) {
      this.prevQuad = quad;
      this.orientRef = quad;
      this.orientAt = performance.now();
      this.misses = 0;
      this.hits++;
      this.target = poseMatrix(pose);
      this.view = { quad: quad.map((p) => this.toScreen(p)) as Quad, pose, project: (x, y) => this.projectModel(pose!, x, y) };
      if (this.hits >= 2) this.setFound(true);
      if (this.isTracking) this.overlay.track(this.view);
    } else {
      this.hits = 0;
      this.misses++;
      if (this.misses >= 8) {
        this.prevQuad = null;
        this.view = null;
        if (this.isTracking) this.setFound(false);
        this.overlay.lost();
      }
    }
  }

  /** px кадра детектора → px экрана (видео растянуто object-fit: cover и отцентровано) */
  private toScreen(p: Pt): Pt {
    return { x: (p.x / this.dw) * this.vw - (this.vw - this.w) / 2, y: (p.y / this.dh) * this.vh - (this.vh - this.h) / 2 };
  }

  private projectModel(pose: Pose, X: number, Y: number): Pt | null {
    const R = pose.R, t = pose.t;
    const x = R[0] * X + R[1] * Y + t[0];
    const y = R[3] * X + R[4] * Y + t[1];
    const z = R[6] * X + R[7] * Y + t[2];
    if (z > -1e-6) return null;
    // камера three: смотрит в −Z, +Y вверх; пиксели детектора: +y вниз
    return this.toScreen({ x: this.K.cx + (this.K.f * x) / -z, y: this.K.cy - (this.K.f * y) / -z });
  }

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.overlay.resize(w, h);
    const v = this.video;
    const vidW = v?.videoWidth || 1280, vidH = v?.videoHeight || 720;
    const ratio = vidW / vidH;
    if (ratio > w / h) {
      this.vh = h;
      this.vw = h * ratio;
    } else {
      this.vw = w;
      this.vh = w / ratio;
    }
    // вертикальный угол обзора экрана: фокус детектора в px экрана = f * (vh / dh)
    const fScreen = this.K.f * (this.vh / this.dh);
    this.camera.fov = (2 * Math.atan(h / 2 / fScreen) * 180) / Math.PI;
    this.camera.near = 0.01;
    this.camera.far = 1000;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  update(dt: number, t: number) {
    super.update(dt, t);
    this.overlay.update(dt);
  }
}

/** поза (R — столбцы осей карты в системе камеры, t — центр, единица = ширина карты) → матрица якоря */
export function poseMatrix(p: Pose): THREE.Matrix4 {
  const R = p.R, t = p.t;
  return new THREE.Matrix4().set(R[0], R[1], R[2], t[0], R[3], R[4], R[5], t[1], R[6], R[7], R[8], t[2], 0, 0, 0, 1);
}

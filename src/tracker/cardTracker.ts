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
import { CARD_ASPECT, focalFromQuad, labelCard, poseFromQuad, quadDiag, type Intrinsics, type Pose, type Pt, type Quad } from './card/geometry';
import { focalFromFov } from './card/detector';
import type { CardWorkerIn, CardWorkerOut } from './card/worker';
import { CardOverlay } from './card/overlay';
import { perf } from '../core/perf';

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
    // кот посажен и держится по поверхности и гироскопу; «карта потеряна» (кот спрашивает, где карта) — только после 6 с
    this.lostDebounceMs = 6000;
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
    this.watchFrames(video);
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
    this.rvfcAt = performance.now();
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
    // фокус: сохранённая калибровка этого телефона (доля от длинной стороны кадра) или типичный угол обзора
    let saved = NaN;
    try {
      saved = parseFloat(localStorage.getItem(FOCAL_KEY) ?? '');
    } catch {
      /* приватный режим */
    }
    const fDef = focalFromFov(this.dw, this.dh);
    this.K = { f: saved > 0 ? saved * Math.max(this.dw, this.dh) : fDef, cx: this.dw / 2, cy: this.dh / 2 };
    this.fSamples = [];
  }

  /** самокалибровка фокуса по карте: медиана оценок с наклонённых устойчивых кадров */
  private fSamples: number[] = [];
  private calibrate(quad: Quad) {
    if (this.fSamples.length >= 60) return;
    const f = focalFromQuad(quad, this.K.cx, this.K.cy, CARD_ASPECT);
    if (!f) return;
    const L = Math.max(this.dw, this.dh);
    // правдоподобный диапазон: горизонтальный угол обзора 45–85°
    const fMin = L / 2 / Math.tan((85 * Math.PI) / 360), fMax = L / 2 / Math.tan((45 * Math.PI) / 360);
    if (f < fMin || f > fMax) return;
    this.fSamples.push(f);
    if (this.fSamples.length % 10 !== 0) return;
    const sorted = [...this.fSamples].sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1];
    if (Math.abs(med - this.K.f) / this.K.f < 0.02) return;
    this.K = { ...this.K, f: med };
    this.resize(this.w, this.h);
    try {
      localStorage.setItem(FOCAL_KEY, String(med / L));
    } catch {
      /* приватный режим */
    }
  }

  /**
   * Производительность: в воркер идут только новые кадры камеры (requestVideoFrameCallback: камера даёт 30 к/с,
   * экран — 60; повтор того же кадра ничего не добавляет, а грел телефон вдвое). maxHz — потолок частоты
   * (адаптивное качество на слабых телефонах, 0 — без потолка).
   */
  maxHz = 0;
  private frameSeq = 0;
  private sentSeq = -1;
  private rvfc = false;
  private rvfcAt = 0;
  private sentAt = 0;
  /** кадр в воркер как VideoFrame (Chrome/Android); Safari и отказ воркера — по-старому, ?grab=main|frame — вручную */
  private frameGrab = useFrameGrab();

  private watchFrames(v: HTMLVideoElement) {
    const vv = v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
    if (typeof vv.requestVideoFrameCallback !== 'function') return;
    this.rvfc = true;
    const cb = () => {
      this.frameSeq++;
      this.rvfcAt = performance.now();
      if (this.video === v) vv.requestVideoFrameCallback!(cb);
    };
    vv.requestVideoFrameCallback(cb);
  }

  /** следующий кадр — в воркер, как только он освободился */
  private pump = () => {
    if (!this.running) return;
    const v = this.video;
    if (!this.busy && v && v.readyState >= 2 && this.worker && this.frameDue()) {
      if (v.videoWidth !== this.lastVW || v.videoHeight !== this.lastVH) this.onVideoSize();
      this.sentSeq = this.frameSeq;
      this.sentAt = performance.now();
      this.busy = true;
      const t0 = performance.now();
      const frame = this.frameGrab ? grabFrame(v) : null;
      if (frame) {
        // кадр уходит в воркер без копирования: уменьшение и чтение пикселей там (на главном потоке ~0,1 мс вместо 4–17)
        const msg = this.message(new ArrayBuffer(0));
        msg.frame = frame;
        this.worker.postMessage(msg, [frame as unknown as Transferable]);
      } else {
        this.ctx.drawImage(v, 0, 0, this.dw, this.dh);
        const img = this.ctx.getImageData(0, 0, this.dw, this.dh);
        const msg = this.message(img.data.buffer as ArrayBuffer);
        this.worker.postMessage(msg, [msg.rgba]);
      }
      perf.add('tracker.grab', performance.now() - t0);
    }
    requestAnimationFrame(this.pump);
  };

  /** пора ли слать кадр: новый кадр камеры и не чаще maxHz */
  private frameDue() {
    const now = performance.now();
    if (this.maxHz > 0 && now - this.sentAt < 1000 / this.maxHz - 4) return false;
    if (!this.rvfc) return true;
    if (now - this.rvfcAt > 400) {
      // requestVideoFrameCallback так и не заработал — по кадрам экрана, как раньше
      if (this.frameSeq === 0) this.rvfc = false;
      // браузер временно перестал его звать (скрытое/свёрнутое видео) — не реже 20 раз в секунду
      return now - this.sentAt > 50;
    }
    return this.frameSeq !== this.sentSeq;
  }

  private message(rgba: ArrayBuffer): CardWorkerIn {
    const msg: CardWorkerIn = { rgba, w: this.dw, h: this.dh, focal: this.K.f, lock: this.locked };
    // карты не видно, кот держится по гироскопу: подсказываем детектору, где её ждать (только там её и примем)
    if (this.locked) msg.hint = this.isTracking ? null : this.heldQuad();
    return msg;
  }

  private onResult(r: CardWorkerOut) {
    this.busy = false;
    if (r.mode === 'no-frame') {
      this.frameGrab = false; // воркер не смог прочитать VideoFrame — дальше кадры читаем на главном потоке
      return;
    }
    perf.add('tracker.worker', r.ms);
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
      // качество перед посадкой: несколько кадров подряд с маленькой ошибкой и без дрожания углов
      const jitter = this.prevQuad ? Math.max(...quad.map((p, i) => Math.hypot(p.x - this.prevQuad![i].x, p.y - this.prevQuad![i].y))) / quadDiag(quad) : 1;
      this.prevQuad = quad;
      this.orientRef = quad;
      this.orientAt = performance.now();
      this.misses = 0;
      if (pose.err < 2) this.calibrate(quad);
      if (!this.locked) {
        this.stable = pose.err < 2.5 && jitter < 0.04 ? this.stable + 1 : 0;
        if (this.stable < LOCK_FRAMES) return;
        this.locked = true;
      }
      this.hits++;
      this.target = poseMatrix(pose);
      this.view = { quad: quad.map((p) => this.toScreen(p)) as Quad, pose, project: (x, y) => this.projectModel(pose!, x, y) };
      this.setFound(true);
      if (this.isTracking) this.overlay.track(this.view);
    } else {
      this.hits = 0;
      this.stable = 0;
      this.misses++;
      if (this.misses >= 8) {
        this.prevQuad = null;
        this.view = null;
        if (this.isTracking) this.setFound(false);
        this.overlay.lost();
      }
    }
  }

  /** кот посажен на карту — новые прямоугольники его не утаскивают */
  private locked = false;
  private stable = 0;
  get isLocked() {
    return this.locked;
  }

  /** «Пересадить кота»: забыть карту и посадить заново на ту, что сейчас в кадре (кот держится на месте, пока не найдём) */
  reanchor() {
    this.locked = false;
    this.stable = 0;
    this.prevQuad = null;
    this.orientRef = null;
    if (this.isTracking) this.setFound(false);
    this.overlay.lost();
    this.overlay.forgetRecent();
    this.worker?.postMessage({ rgba: new ArrayBuffer(4), w: 1, h: 1, focal: 1, reset: true, lock: false });
  }

  /** где карта сейчас по удерживаемой (гироскоп) позе якоря — в пикселях кадра детектора */
  private heldQuad(): Pt[] | null {
    const m = this.anchor.matrix.elements;
    const hw = 0.5, hh = 0.5 / CARD_ASPECT;
    const out: Pt[] = [];
    for (const [X, Y] of [[-hw, hh], [hw, hh], [hw, -hh], [-hw, -hh]]) {
      const x = m[0] * X + m[4] * Y + m[12], y = m[1] * X + m[5] * Y + m[13], z = m[2] * X + m[6] * Y + m[14];
      if (z > -1e-3) return null;
      out.push({ x: this.K.cx + (this.K.f * x) / -z, y: this.K.cy - (this.K.f * y) / -z });
    }
    return out;
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

function useFrameGrab(): boolean {
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('grab') : null;
  if (q === 'main') return false;
  if (typeof VideoFrame === 'undefined' || typeof OffscreenCanvas === 'undefined') return false;
  if (q === 'frame') return true;
  // WebKit (iPhone): поворот кадра камеры в VideoFrame не проверен на устройствах — оставляем проверенный путь
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return !/AppleWebKit/.test(ua) || /Chrome\/|Android/.test(ua);
}

function grabFrame(v: HTMLVideoElement): VideoFrame | null {
  try {
    return new VideoFrame(v);
  } catch {
    return null;
  }
}

/** поза (R — столбцы осей карты в системе камеры, t — центр, единица = ширина карты) → матрица якоря */
/** сколько устойчивых кадров подряд нужно, чтобы посадить кота (~0,3 с) */
const LOCK_FRAMES = 6;
const FOCAL_KEY = 'ar.focal.v1';

export function poseMatrix(p: Pose): THREE.Matrix4 {
  const R = p.R, t = p.t;
  return new THREE.Matrix4().set(R[0], R[1], R[2], t[0], R[3], R[4], R[5], t[1], R[6], R[7], R[8], t[2], 0, 0, 0, 1);
}

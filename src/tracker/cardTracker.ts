/**
 * Трекер «карта Сбера»: камера → уменьшенный кадр (320 px по длинной стороне) → Web Worker с
 * детектором (src/tracker/card/detector.ts) → 4 угла → поза карты (гомография → R, t) → якорь кота.
 * Никакой картинки-маркера: форма — любая карта ID-1 (85.60 × 53.98 мм), а по содержимому (чип, знак Сбера,
 * src/tracker/card/verify.ts) кот садится только на карту Сбера любого дизайна (ACCEPT_OTHER_BANKS, ?anycard).
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
import { CardOverlay, type CandidateKind } from './card/overlay';
import type { CardKind } from './card/verify';
import { perf } from '../core/perf';
import { ACCEPT_OTHER_BANKS } from '../config';

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
  stats = { ms: 0, fps: 0, score: 0, mode: 'none', ver: '' as CardKind | '', verLine: '' };
  /**
   * Проверка «это карта Сбера?» по содержимому кандидата (чип, знак Сбера, оборот — src/tracker/card/verify.ts).
   * ?anycard — выключить: кот садится на любой прямоугольник с пропорциями карты (старое поведение).
   */
  readonly verify = !hasParam('anycard');
  private verState: CardKind = 'unknown';
  private verDebug = hasParam('debug');
  /** последняя нумерация углов: держим ориентацию кота и после короткой потери карты */
  private orientRef: Quad | null = null;
  private orientAt = -1e9;

  private worker: Worker | null = null;
  private busy = false;
  private running = false;
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
  /** фрагмент кадра вокруг карты в большем разрешении — для чипа и знака Сбера */
  private cropCanvas = document.createElement('canvas');
  private cropCtx = this.cropCanvas.getContext('2d', { willReadFrequently: true })!;
  private cropAt = -1e9;
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
    await this.openCamera(video);
    this.watchCamera();
  }

  private async openCamera(video: HTMLVideoElement) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      // 720p и 30 к/с: больше трекеру (320 px) и экрану не нужно, а камера 60 к/с / 4K греет телефон
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    });
    await new Promise<void>((resolve) => {
      video.addEventListener('loadedmetadata', () => resolve(), { once: true });
      video.srcObject = stream;
    });
    await video.play().catch(() => undefined);
    const track = stream.getVideoTracks()[0];
    if (track) track.onended = () => this.reviveCamera('ended');
  }

  /**
   * iOS иногда обрывает камеру (звонок, Siri, уведомление, смена аудиосессии) — фон становится чёрным, кот висит на нём.
   * Сторож: нет новых кадров дольше 1,5 с при видимой вкладке или дорожка завершилась → тихо переоткрываем камеру.
   */
  private camTimer = 0;
  private rvfcGen = 0;
  private reviving = false;
  private watchCamera() {
    clearInterval(this.camTimer);
    this.camTimer = window.setInterval(() => {
      const v = this.video;
      if (!v || !this.running || document.visibilityState !== 'visible') return;
      const s = v.srcObject as MediaStream | null;
      const t = s?.getVideoTracks()[0];
      const stale = this.rvfc && performance.now() - this.rvfcAt > 1500;
      if (!t || t.readyState === 'ended' || t.muted || v.paused || stale) void this.reviveCamera(stale ? 'stale' : 'track');
    }, 1000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.video?.paused) void this.video.play().catch(() => undefined);
    });
  }

  private async reviveCamera(why: string) {
    const v = this.video;
    if (!v || this.reviving || document.visibilityState !== 'visible') return;
    this.reviving = true;
    try {
      // сначала просто «пнуть» видео — часто этого хватает после паузы iOS
      if (v.paused) await v.play().catch(() => undefined);
      const t = (v.srcObject as MediaStream | null)?.getVideoTracks()[0];
      if (t && t.readyState === 'live' && !t.muted && !v.paused && !(this.rvfc && performance.now() - this.rvfcAt > 1500)) return;
      console.warn('[card] камера переоткрывается:', why);
      (v.srcObject as MediaStream | null)?.getTracks().forEach((x) => x.stop());
      await this.openCamera(v);
      this.rvfcAt = performance.now();
      this.watchFrames(v);
    } catch (e) {
      console.warn('[card] камеру не переоткрыть', e);
    } finally {
      this.reviving = false;
    }
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
    clearInterval(this.camTimer);
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
  /** энергобюджет: полный поиск карты раз в N кадров трекера (0 — по умолчанию детектора) */
  detectEvery = 0;
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
    const gen = ++this.rvfcGen;
    const cb = () => {
      if (gen !== this.rvfcGen) return; // цепочка заменена (после переоткрытия камеры)
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
      const crop = this.cropRect(v);
      if (frame) {
        // кадр уходит в воркер без копирования: уменьшение и чтение пикселей там (на главном потоке ~0,1 мс вместо 4–17)
        const msg = this.message(new ArrayBuffer(0));
        msg.frame = frame;
        msg.crop = crop; // фрагмент вырежет воркер из того же кадра
        this.worker.postMessage(msg, [frame as unknown as Transferable]);
      } else {
        this.ctx.drawImage(v, 0, 0, this.dw, this.dh);
        const img = this.ctx.getImageData(0, 0, this.dw, this.dh);
        const msg = this.message(img.data.buffer as ArrayBuffer);
        const tr: Transferable[] = [msg.rgba];
        if (crop) {
          // тот же кадр видео (рисуем подряд в одном обработчике) — углы из кадра детектора ложатся на фрагмент
          const k = (v.videoWidth || this.dw) / this.dw;
          if (this.cropCanvas.width !== crop.cw || this.cropCanvas.height !== crop.ch) {
            this.cropCanvas.width = crop.cw;
            this.cropCanvas.height = crop.ch;
          }
          this.cropCtx.drawImage(v, crop.x0 * k, crop.y0 * k, crop.w * k, crop.h * k, 0, 0, crop.cw, crop.ch);
          crop.rgba = this.cropCtx.getImageData(0, 0, crop.cw, crop.ch).data.buffer as ArrayBuffer;
          tr.push(crop.rgba);
          msg.crop = crop;
        }
        this.worker.postMessage(msg, tr);
      }
      perf.add('tracker.grab', performance.now() - t0);
    }
    requestAnimationFrame(this.pump);
  };

  /**
   * Фрагмент кадра вокруг карты (по прошлому положению) в разрешении камеры: карта в нём ≈ 280 px шириной —
   * чип и знак Сбера видны лучше, чем на 320-px кадре детектора. До посадки — к каждому кадру (не чаще 12 Гц),
   * после — раз в секунду (переверификация). Без карты в прошлом кадре — не нужен.
   */
  private cropRect(v: HTMLVideoElement): CardWorkerIn['crop'] {
    if (!this.verify || !this.prevQuad) return null;
    const now = performance.now();
    if (now - this.cropAt < (this.locked ? 1000 : 80)) return null;
    const vw = v.videoWidth || this.dw;
    const k = vw / this.dw; // px видео на px детектора
    if (k < 1.3) return null; // камера не больше кадра детектора — фрагмент ничего не даст
    const q = this.prevQuad;
    let x0 = Math.min(...q.map((p) => p.x)), x1 = Math.max(...q.map((p) => p.x));
    let y0 = Math.min(...q.map((p) => p.y)), y1 = Math.max(...q.map((p) => p.y));
    const mx = (x1 - x0) * 0.25 + 4, my = (y1 - y0) * 0.25 + 4;
    x0 = Math.max(0, Math.floor(x0 - mx));
    y0 = Math.max(0, Math.floor(y0 - my));
    x1 = Math.min(this.dw, Math.ceil(x1 + mx));
    y1 = Math.min(this.dh, Math.ceil(y1 + my));
    const w = x1 - x0, h = y1 - y0;
    if (w < 8 || h < 8) return null;
    const long = Math.max(quadSide(q, 0), quadSide(q, 1));
    let s = Math.min(k, Math.max(1, 280 / Math.max(1, long)));
    s = Math.min(s, 420 / Math.max(w, h)); // не больше 420 px по стороне: чтение пикселей ~1 мс
    if (s < 1.3) return null;
    this.cropAt = now;
    return { x0, y0, w, h, cw: Math.round(w * s), ch: Math.round(h * s) };
  }

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
    const msg: CardWorkerIn = { rgba, w: this.dw, h: this.dh, focal: this.K.f, lock: this.locked, verify: this.verify };
    if (this.detectEvery > 0) msg.detectEvery = this.detectEvery;
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
    perf.count('tracker');
    this.stats.ms = r.ms;
    this.stats.score = r.score;
    this.stats.mode = r.mode;
    if (r.ver) {
      this.verState = r.ver.state;
      this.stats.ver = r.ver.state;
      this.stats.verLine = r.ver.line;
      if (this.verDebug) this.overlay.debugLine = r.ver.line;
      // кот сидит, а под ним 5 проверок подряд «не карта» (посадили по ошибке) — ищем карту заново
      if (r.ver.postNotCard && this.locked) {
        console.info('[card] переверификация: под котом не карта — пересадка');
        this.reanchor();
        return;
      }
    } else if (!this.verify) this.verState = 'sber';
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
        // телефон должен почти не двигаться (гироскоп), иначе кот сядет «с опозданием» мимо карты
        const w = this.hold.angularSpeed;
        const still = !(w > 0.6);
        this.stable = pose.err < 2.5 && jitter < 0.04 && still ? this.stable + 1 : Math.max(0, this.stable - 2);
        // посадка — только на карту Сбера (несколько кадров подряд с признаками, см. CardEvidence)
        const kind = this.candidateKind();
        // «проверяем» не должно тянуться вечно (на iPhone знак иногда не ловится из-за бликов/угла): если прямоугольник
        // стабилен 2,5 с, и он не опознан как чужая карта/оборот/не карта — сажаем (ребёнок не ждёт 15 с с кольцом на половине)
        if (kind === 'checking' && this.stable >= LOCK_FRAMES) this.checkingSince ||= performance.now();
        else if (kind !== 'checking' || this.stable < LOCK_FRAMES / 2) this.checkingSince = 0;
        const patient = kind === 'checking' && this.checkingSince > 0 && performance.now() - this.checkingSince > CHECK_PATIENCE_MS;
        const ok = kind === 'sber' || patient;
        // пока проверяем — кольцо заполняется только наполовину; «не карта» — ничего не рисуем
        const k = kind === 'sber' ? this.stable / LOCK_FRAMES : kind === 'checking' && this.checkingSince ? 0.5 + (0.5 * (performance.now() - this.checkingSince)) / CHECK_PATIENCE_MS : Math.min(this.stable / LOCK_FRAMES, 0.5);
        this.overlay.candidate({ quad: quad.map((p) => this.toScreen(p)) as Quad, pose, project: () => null }, k, kind);
        if (this.stable < LOCK_FRAMES || !ok) return;
        if (patient) console.info('[card] знак Сбера не пойман за 2,5 с — сажаем по форме карты');
        this.locked = true;
        this.checkingSince = 0;
      }
      this.hits++;
      this.target = poseMatrix(pose);
      this.view = { quad: quad.map((p) => this.toScreen(p)) as Quad, pose, project: (x, y) => this.projectModel(pose!, x, y) };
      this.setFound(true);
      if (this.isTracking) this.overlay.track(this.view);
    } else {
      this.hits = 0;
      this.stable = 0;
      this.checkingSince = 0;
      this.misses++;
      if (this.misses >= 8) {
        this.prevQuad = null;
        this.view = null;
        if (this.isTracking) this.setFound(false);
        this.overlay.lost();
      }
    }
  }

  /** что показать над кандидатом: карта Сбера / проверяем / чужая карта / оборот / не карта */
  private candidateKind(): CandidateKind {
    const st = this.verState;
    if (!this.verify || st === 'sber') return 'sber';
    if (st === 'card') return ACCEPT_OTHER_BANKS ? 'sber' : 'other';
    if (st === 'back') return ACCEPT_OTHER_BANKS ? 'sber' : 'back';
    if (st === 'notcard') return 'notcard';
    return 'checking';
  }

  /** кот посажен на карту — новые прямоугольники его не утаскивают */
  private locked = false;
  private stable = 0;
  private checkingSince = 0;
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

function hasParam(name: string): boolean {
  return typeof location !== 'undefined' && new URLSearchParams(location.search).has(name);
}

/** длина стороны i → i+1 четырёхугольника */
function quadSide(q: Quad, i: number) {
  const a = q[i], b = q[(i + 1) % 4];
  return Math.hypot(a.x - b.x, a.y - b.y);
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
const LOCK_FRAMES = 10;
const FOCAL_KEY = 'ar.focal.v1';
/** сколько ждём знак Сбера на стабильной карте, прежде чем посадить кота по форме */
const CHECK_PATIENCE_MS = 2500;

export function poseMatrix(p: Pose): THREE.Matrix4 {
  const R = p.R, t = p.t;
  return new THREE.Matrix4().set(R[0], R[1], R[2], t[0], R[3], R[4], R[5], t[1], R[6], R[7], R[8], t[2], 0, 0, 0, 1);
}

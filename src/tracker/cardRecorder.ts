/**
 * Запись чистой камеры для стенда `npm run card:eval` (docs/qa/CARD_MATRIX.md): `?rec` или `?rec=имя`.
 *
 * Пишется КАДР КАМЕРЫ (не экран: без кота, интерфейса и наклеек) в разрешении трекера ×2 (кадр детектора 320 px →
 * 640 px по длинной стороне — как источник на стенде: кадр детектора и фрагмент под проверку «Сбер»), 30 к/с,
 * MediaRecorder (iPhone — mp4/H.264, Chrome — webm). Рядом — JSON-сайдкар: время каждого кадра, ориентация телефона
 * (гироскоп, ~60 Гц), фокус и задержка камеры трекера, состояния трекера. Номер карты размывается ДО записи:
 * нижние 60 % карты (по углам трекера, с запасом, держится 1 с после потери) пикселизуются на холсте записи.
 * Готовую запись — «Поделиться» (AirDrop/Файлы/Telegram) или скачать.
 *
 * Только lab и страница /test (в mvp/pilot — со ссылки /test, метка from=test). В таблицу PARAMS (src/config/edition.ts)
 * параметр не внесён — проверка здесь; владельцу редакций: можно добавить `rec: { feature: …, test: true }`.
 */
import type * as THREE from 'three';
import { IS_LAB, fromTestPage } from '../config/edition';
import { numberZone } from './card/blurNumbers';
import type { Quad } from './card/geometry';

export interface RecorderSource {
  video: HTMLVideoElement;
  container: HTMLElement;
  /** кадр детектора, px */
  dw: number;
  dh: number;
  /** последние углы карты в кадре детектора (или null) и когда видели, мс */
  quad(): { q: Quad; at: number } | null;
  focal(): number;
  camLatMs(): number;
  state(): string;
}

export function recRequested(): string | null {
  if (typeof location === 'undefined') return null;
  const p = new URLSearchParams(location.search);
  if (!p.has('rec')) return null;
  const allowed = IS_LAB || fromTestPage(location.search, typeof document !== 'undefined' ? document.referrer : '');
  if (!allowed) {
    console.info('[rec] запись камеры — только lab и страница /test');
    return null;
  }
  return (p.get('rec') || 'card').replace(/[^\w.-]+/g, '_').slice(0, 60);
}

function pickMime(): string {
  const c = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  for (const m of c) if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(m)) return m;
  return '';
}

export class CardRecorder {
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;
  private small = document.createElement('canvas');
  private sctx = this.small.getContext('2d')!;
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private t0 = 0;
  private frames: number[] = [];
  private gyro: number[][] = [];
  private states: [number, string][] = [];
  private on = false;
  private ui: HTMLDivElement;
  private gen = 0;

  constructor(private src: RecorderSource, private name: string) {
    this.ui = document.createElement('div');
    Object.assign(this.ui.style, { position: 'absolute', top: 'calc(env(safe-area-inset-top, 0px) + 56px)', left: '50%', transform: 'translateX(-50%)', zIndex: '60', display: 'flex', gap: '8px', font: '600 14px system-ui', pointerEvents: 'auto' });
    src.container.appendChild(this.ui);
    this.idle();
  }

  /** отсчёт гироскопа (OrientationHold.onSample): время performance.now и ориентация камеры */
  sample(t: number, q: THREE.Quaternion) {
    if (this.on) this.gyro.push([+t.toFixed(2), +q.x.toFixed(6), +q.y.toFixed(6), +q.z.toFixed(6), +q.w.toFixed(6)]);
  }

  private button(label: string, bg: string, fn: () => void) {
    const b = document.createElement('button');
    b.textContent = label;
    Object.assign(b.style, { padding: '8px 14px', borderRadius: '18px', border: 'none', color: '#fff', background: bg, font: 'inherit', boxShadow: '0 2px 8px rgba(0,0,0,.25)' });
    b.onclick = (e) => {
      e.stopPropagation();
      fn();
    };
    this.ui.appendChild(b);
    return b;
  }

  private idle() {
    this.ui.textContent = '';
    this.button('● Запись камеры', '#c62828', () => this.start());
  }

  start() {
    const v = this.src.video;
    const k = 640 / Math.max(this.src.dw, this.src.dh);
    const W = Math.round((this.src.dw * k) / 2) * 2, H = Math.round((this.src.dh * k) / 2) * 2;
    this.canvas.width = W;
    this.canvas.height = H;
    this.small.width = Math.max(8, Math.round(W / 14));
    this.small.height = Math.max(8, Math.round(H / 14));
    const stream = (this.canvas as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }).captureStream(30);
    const mime = pickMime();
    try {
      this.rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 3_000_000 });
    } catch (e) {
      alert('Запись не поддерживается этим браузером: ' + (e as Error).message);
      return;
    }
    this.chunks = [];
    this.frames = [];
    this.gyro = [];
    this.states = [];
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.onstop = () => this.finish(mime);
    this.on = true;
    this.t0 = performance.now();
    this.draw(); // первый кадр до старта — медиа-время 0 ≈ t0
    this.rec.start(1000);
    const gen = ++this.gen;
    const vv = v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
    const tick = () => {
      if (!this.on || gen !== this.gen) return;
      this.draw();
      if (vv.requestVideoFrameCallback) vv.requestVideoFrameCallback(tick);
      else requestAnimationFrame(tick);
    };
    if (vv.requestVideoFrameCallback) vv.requestVideoFrameCallback(tick);
    else requestAnimationFrame(tick);
    this.ui.textContent = '';
    const b = this.button('■ Стоп 0:00', '#c62828', () => this.stop());
    const timer = setInterval(() => {
      if (!this.on) return clearInterval(timer);
      const s = Math.floor((performance.now() - this.t0) / 1000);
      b.textContent = `■ Стоп ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }, 500);
  }

  /** кадр камеры на холст записи + пикселизация зоны номера */
  private draw() {
    const { ctx, canvas } = this;
    const v = this.src.video;
    if (v.readyState < 2) return;
    const W = canvas.width, H = canvas.height;
    ctx.drawImage(v, 0, 0, W, H);
    const now = performance.now();
    this.frames.push(+now.toFixed(2));
    const st = this.src.state();
    if (this.states.at(-1)?.[1] !== st) this.states.push([+now.toFixed(1), st]);
    const cq = this.src.quad();
    if (!cq || now - cq.at > 1000) return;
    const s = W / this.src.dw;
    const age = now - cq.at;
    const q = cq.q.map((p) => ({ x: (p.x + 0.5) * s, y: (p.y + 0.5) * s })) as Quad;
    // запас растёт со временем без карты (карта могла сдвинуться) и с задержкой трекера
    const zone = numberZone(q, 0.62, 0.08 + 0.25 * Math.min(1, age / 1000));
    if (!zone) return;
    this.sctx.imageSmoothingEnabled = true;
    this.sctx.drawImage(canvas, 0, 0, this.small.width, this.small.height);
    ctx.save();
    ctx.beginPath();
    zone.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.clip();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.small, 0, 0, W, H);
    ctx.restore();
    ctx.imageSmoothingEnabled = true;
  }

  stop() {
    this.on = false;
    this.rec?.stop();
  }

  private finish(mime: string) {
    const ext = mime.includes('mp4') ? 'mp4' : 'webm';
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
    const base = `${this.name}_${stamp}`;
    const video = new File(this.chunks, `${base}.${ext}`, { type: mime || 'video/webm' });
    const side = {
      v: 1,
      kind: 'card-rec',
      w: this.canvas.width,
      h: this.canvas.height,
      t0: +this.t0.toFixed(2),
      frames: this.frames,
      gyro: this.gyro,
      fNorm: this.src.focal() / Math.max(this.src.dw, this.src.dh),
      camLatMs: this.src.camLatMs(),
      states: this.states,
      ua: navigator.userAgent,
      screen: { w: screen.width, h: screen.height, dpr: devicePixelRatio, orient: screen.orientation?.angle ?? 0 },
      blur: 'нижние 62 % карты пикселизованы по углам трекера (src/tracker/cardRecorder.ts)',
    };
    const json = new File([JSON.stringify(side)], `${base}.json`, { type: 'application/json' });
    this.ui.textContent = '';
    const files = [video, json];
    const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
    if (nav.canShare?.({ files })) this.button('Поделиться записью', '#1a7f37', () => void navigator.share({ files, title: base }).catch(() => undefined));
    this.button('Скачать', '#455a64', () => {
      for (const f of files) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(f);
        a.download = f.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
      }
    });
    this.button('Ещё запись', '#c62828', () => this.start());
    console.info(`[rec] ${base}: ${(video.size / 1e6).toFixed(1)} МБ, кадров ${this.frames.length}, отсчётов гироскопа ${this.gyro.length}`);
  }
}

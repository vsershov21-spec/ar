/**
 * Привязка жестов к DOM: pointer-события на «стекле» (слой эффектов), DeviceMotion (встряска),
 * антиспам, таймер тишины. Сама логика распознавания — в gestures.ts (покрыта тестами).
 */
import { Emitter } from '../core/emitter';
import { GestureRecognizer, ShakeDetector, SilenceTimer, SpamGuard, type GestureEvent } from './gestures';

export type InputEvents = {
  tap_cat: { x: number; y: number };
  tap_screen: { x: number; y: number };
  longpress: { x: number; y: number; onCat: boolean };
  longpress_end: { x: number; y: number };
  swipe: Extract<GestureEvent, { type: 'swipe' }>;
  drag: { x: number; y: number; px: number; py: number };
  shake: void;
  spam: void;
  silence: void;
  activity: void;
  /** тап по наклейке-выбору / отклеивание */
  sticker_tap: { x: number; y: number };
  peel_start: { x: number; y: number };
  peel_move: { x: number; y: number };
  peel_end: { vx: number; vy: number };
};

export interface InputHooks {
  isOnCat(x: number, y: number): boolean;
  /** true — палец начал отклеивать наклейку (жест забирает слой наклеек) */
  tryPeel(x: number, y: number): boolean;
  /** true — тап попал в наклейку-выбор */
  isChoiceSticker(x: number, y: number): boolean;
}

export class Input extends Emitter<InputEvents> {
  private rec: GestureRecognizer;
  private spam = new SpamGuard(5, 2000, 1000);
  private silence: SilenceTimer;
  private shake = new ShakeDetector();
  private peeling = false;
  private last = { x: 0, y: 0, t: 0 };
  private vel = { x: 0, y: 0 };
  private pointerId: number | null = null;
  motionGranted: boolean | null = null;
  enabled = true;

  constructor(surface: HTMLElement, private hooks: InputHooks, now = performance.now()) {
    super();
    this.silence = new SilenceTimer(now, 10000);
    this.rec = new GestureRecognizer((e) => this.onGesture(e));
    surface.addEventListener('pointerdown', (e) => this.down(e));
    surface.addEventListener('pointermove', (e) => this.move(e));
    surface.addEventListener('pointerup', (e) => this.up(e));
    surface.addEventListener('pointercancel', () => {
      this.rec.cancel();
      this.pointerId = null;
    });
    surface.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private down(e: PointerEvent) {
    if (!this.enabled || this.pointerId !== null) return;
    this.pointerId = e.pointerId;
    this.activity(e.timeStamp);
    this.last = { x: e.clientX, y: e.clientY, t: e.timeStamp };
    this.vel = { x: 0, y: 0 };
    if (this.hooks.tryPeel(e.clientX, e.clientY)) {
      this.peeling = true;
      this.emit('peel_start', { x: e.clientX, y: e.clientY });
      return;
    }
    this.rec.down(e.clientX, e.clientY, e.timeStamp);
  }

  private move(e: PointerEvent) {
    if (e.pointerId !== this.pointerId) return;
    const dt = Math.max(1, e.timeStamp - this.last.t) / 1000;
    this.vel = { x: (e.clientX - this.last.x) / dt, y: (e.clientY - this.last.y) / dt };
    const prev = this.last;
    this.last = { x: e.clientX, y: e.clientY, t: e.timeStamp };
    if (this.peeling) {
      this.emit('peel_move', { x: e.clientX, y: e.clientY });
      return;
    }
    this.rec.move(e.clientX, e.clientY, e.timeStamp);
    this.emit('drag', { x: e.clientX, y: e.clientY, px: prev.x, py: prev.y });
  }

  private up(e: PointerEvent) {
    if (e.pointerId !== this.pointerId) return;
    this.pointerId = null;
    this.activity(e.timeStamp);
    if (this.peeling) {
      this.peeling = false;
      this.emit('peel_end', { vx: this.vel.x, vy: this.vel.y });
      return;
    }
    this.rec.up(e.clientX, e.clientY, e.timeStamp);
  }

  private onGesture(e: GestureEvent) {
    switch (e.type) {
      case 'tap': {
        if (this.hooks.isChoiceSticker(e.x, e.y)) {
          this.emit('sticker_tap', { x: e.x, y: e.y });
          return;
        }
        const r = this.spam.hit(performance.now());
        if (r === 'ignored') return;
        if (r === 'spam') {
          this.emit('spam', undefined);
          return;
        }
        this.emit(this.hooks.isOnCat(e.x, e.y) ? 'tap_cat' : 'tap_screen', { x: e.x, y: e.y });
        break;
      }
      case 'longpress':
        this.emit('longpress', { x: e.x, y: e.y, onCat: this.hooks.isOnCat(e.x, e.y) });
        break;
      case 'longpress_end':
        this.emit('longpress_end', { x: e.x, y: e.y });
        break;
      case 'swipe':
        this.emit('swipe', e);
        break;
    }
  }

  /** вызывать каждый кадр */
  tick(t = performance.now()) {
    this.rec.tick(t);
    if (this.silence.check(t)) this.emit('silence', undefined);
  }

  activity(t = performance.now()) {
    this.silence.activity(t);
    this.emit('activity', undefined);
  }

  /** Разрешение на датчики (iOS 13+) — ТОЛЬКО синхронно из обработчика жеста. */
  requestSensors(): Promise<boolean> {
    const DME = (window as any).DeviceMotionEvent;
    const DOE = (window as any).DeviceOrientationEvent;
    const reqs: Promise<string>[] = [];
    // оба запроса создаются синхронно в одном жесте
    if (DME?.requestPermission) reqs.push(DME.requestPermission().catch(() => 'denied'));
    if (DOE?.requestPermission) reqs.push(DOE.requestPermission().catch(() => 'denied'));
    const p = reqs.length ? Promise.all(reqs).then((r) => r[0] === 'granted') : Promise.resolve(typeof DME !== 'undefined');
    return p.then((ok) => {
      this.motionGranted = ok;
      if (ok) this.listenMotion();
      return ok;
    });
  }

  private listening = false;
  private listenMotion() {
    if (this.listening) return;
    this.listening = true;
    window.addEventListener('devicemotion', (e) => {
      const a = e.accelerationIncludingGravity;
      if (!a || a.x == null) return;
      if (this.shake.sample(a.x, a.y ?? 0, a.z ?? 0, performance.now())) {
        this.activity();
        this.emit('shake', undefined);
      }
    });
  }

  /** программная встряска (кнопка «Сдёрнуть наклейки», debug) */
  simulateShake() {
    this.activity();
    this.emit('shake', undefined);
  }
}

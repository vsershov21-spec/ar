/**
 * Привязка жестов к DOM: pointer-события на «стекле» (слой эффектов), DeviceMotion (встряска),
 * таймер тишины. Распознавание — в interpreter.ts / gestures.ts (чистая логика, покрыта тестами).
 * Порядок на касании: эффект на стекле (пузырь, туман, жвачка) → отклеивание наклейки → жест.
 */
import { Emitter } from '../core/emitter';
import { ShakeDetector, SilenceTimer, type Pt } from './gestures';
import { TouchInterpreter, type TouchEvent } from './interpreter';
import type { TouchZone } from '../character/types';

export type InputEvents = {
  /** тап по коту: zone и событие tap_cat_head / … / tap_cat */
  tap_cat: { x: number; y: number; zone: TouchZone; event: string };
  poke_combo: { x: number; y: number; zone: TouchZone };
  poke_hard: { x: number; y: number };
  stroke: { x: number; y: number };
  stroke_long: { x: number; y: number };
  stroke_end: void;
  double_tap: { x: number; y: number };
  tap_screen: { x: number; y: number };
  longpress: { x: number; y: number; onCat: boolean };
  longpress_end: { x: number; y: number };
  swipe: { x: number; y: number; path: Pt[]; speed: number; dir: string };
  drag: { x: number; y: number; px: number; py: number };
  shake: void;
  spam: void;
  silence: void;
  activity: void;
  /** тап по наклейке-выбору */
  sticker_tap: { x: number; y: number };
  peel_start: { x: number; y: number };
  peel_move: { x: number; y: number };
  peel_end: { vx: number; vy: number };
};

export interface InputHooks {
  /** зона кота в точке экрана (null — мимо кота); coarse — дешёвая проверка «на коте ли палец» (движение пальца) */
  zoneAt(x: number, y: number, coarse?: boolean): TouchZone | null;
  /** true — палец начал отклеивать наклейку (жест забирает слой наклеек) */
  tryPeel(x: number, y: number): boolean;
  /** true — тап попал в наклейку-выбор */
  isChoiceSticker(x: number, y: number): boolean;
  /** эффекты на стекле могут забрать касание (лопнуть пузырь, рисовать по туману, стирать жвачку) */
  fxDown?(x: number, y: number): boolean;
  fxMove?(x: number, y: number, px: number, py: number): boolean;
  fxUp?(x: number, y: number): boolean;
}

export class Input extends Emitter<InputEvents> {
  readonly touch: TouchInterpreter;
  private silence: SilenceTimer;
  private shake = new ShakeDetector();
  private peeling = false;
  private fxCapture = false;
  private choiceTap = false;
  private last = { x: 0, y: 0, t: 0 };
  private vel = { x: 0, y: 0 };
  private pointerId: number | null = null;
  motionGranted: boolean | null = null;
  enabled = true;

  constructor(surface: HTMLElement, private hooks: InputHooks, now = performance.now()) {
    super();
    this.silence = new SilenceTimer(now, 10000);
    this.touch = new TouchInterpreter((e) => this.onTouch(e), (x, y, coarse) => this.hooks.zoneAt(x, y, coarse));
    surface.addEventListener('pointerdown', (e) => this.down(e));
    surface.addEventListener('pointermove', (e) => this.move(e));
    surface.addEventListener('pointerup', (e) => this.up(e));
    surface.addEventListener('pointercancel', () => {
      this.touch.cancel();
      this.pointerId = null;
      this.fxCapture = this.peeling = false;
    });
    surface.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private down(e: PointerEvent) {
    if (!this.enabled || this.pointerId !== null) return;
    this.pointerId = e.pointerId;
    this.activity(e.timeStamp);
    this.last = { x: e.clientX, y: e.clientY, t: e.timeStamp };
    this.vel = { x: 0, y: 0 };
    if (this.hooks.isChoiceSticker(e.clientX, e.clientY)) {
      this.choiceTap = true;
      return;
    }
    if (this.hooks.fxDown?.(e.clientX, e.clientY)) {
      this.fxCapture = true;
      return;
    }
    if (this.hooks.tryPeel(e.clientX, e.clientY)) {
      this.peeling = true;
      this.emit('peel_start', { x: e.clientX, y: e.clientY });
      return;
    }
    this.touch.down(e.clientX, e.clientY, e.timeStamp);
  }

  private move(e: PointerEvent) {
    if (e.pointerId !== this.pointerId) return;
    const dt = Math.max(1, e.timeStamp - this.last.t) / 1000;
    this.vel = { x: (e.clientX - this.last.x) / dt, y: (e.clientY - this.last.y) / dt };
    const prev = this.last;
    this.last = { x: e.clientX, y: e.clientY, t: e.timeStamp };
    if (this.choiceTap) return;
    if (this.fxCapture) {
      this.hooks.fxMove?.(e.clientX, e.clientY, prev.x, prev.y);
      return;
    }
    if (this.peeling) {
      this.emit('peel_move', { x: e.clientX, y: e.clientY });
      return;
    }
    this.touch.move(e.clientX, e.clientY, e.timeStamp);
    this.emit('drag', { x: e.clientX, y: e.clientY, px: prev.x, py: prev.y });
  }

  private up(e: PointerEvent) {
    if (e.pointerId !== this.pointerId) return;
    this.pointerId = null;
    this.activity(e.timeStamp);
    if (this.choiceTap) {
      this.choiceTap = false;
      this.emit('sticker_tap', { x: e.clientX, y: e.clientY });
      return;
    }
    if (this.fxCapture) {
      this.fxCapture = false;
      this.hooks.fxUp?.(e.clientX, e.clientY);
      return;
    }
    if (this.peeling) {
      this.peeling = false;
      this.emit('peel_end', { vx: this.vel.x, vy: this.vel.y });
      return;
    }
    this.touch.up(e.clientX, e.clientY, e.timeStamp);
  }

  private onTouch(e: TouchEvent) {
    switch (e.type) {
      case 'tap_cat':
        return this.emit('tap_cat', { x: e.x, y: e.y, zone: e.zone, event: e.event });
      case 'poke_combo':
        return this.emit('poke_combo', { x: e.x, y: e.y, zone: e.zone });
      case 'poke_hard':
        return this.emit('poke_hard', { x: e.x, y: e.y });
      case 'stroke':
        return this.emit('stroke', { x: e.x, y: e.y });
      case 'stroke_long':
        return this.emit('stroke_long', { x: e.x, y: e.y });
      case 'stroke_end':
        return this.emit('stroke_end', undefined);
      case 'double_tap':
        return this.emit('double_tap', { x: e.x, y: e.y });
      case 'tap_screen':
        return this.emit('tap_screen', { x: e.x, y: e.y });
      case 'longpress':
        return this.emit('longpress', { x: e.x, y: e.y, onCat: e.onCat });
      case 'longpress_end':
        return this.emit('longpress_end', { x: e.x, y: e.y });
      case 'swipe':
        return this.emit('swipe', { x: e.x, y: e.y, path: e.path, speed: e.speed, dir: e.dir });
      case 'spam':
        return this.emit('spam', undefined);
    }
  }

  /** вызывать каждый кадр */
  tick(t = performance.now()) {
    this.touch.tick(t);
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

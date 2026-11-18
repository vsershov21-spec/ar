/**
 * Толкователь касаний (чистая логика, без DOM): поверх распознавателя жестов знает, где кот и его зоны.
 * На выходе — события для режиссёра:
 *  tap_cat (+ zone) → tap_cat_head | cheek | belly | paw | tail | tap_cat;
 *  poke_combo — 3 тапа в одну зону за 2 с;
 *  poke_hard — быстрый резкий свайп по коту → кот 2 с «дуется», тапы по коту игнорируются;
 *  stroke — медленный свайп по коту > 80 px (начало глажки), stroke_long — гладят > 4 с, stroke_end;
 *  double_tap — два тапа мимо кота (≤ 300 мс, ≤ 40 px) → фирменный трюк; одиночный тап мимо кота
 *  откладывается на это окно (tap_screen), тапы по коту — без задержки (тычки и комбо);
 *  longpress (0,6 с), swipe (мимо кота), spam (5 тапов за 2 с → 3 с игнор).
 * Пороги — InterpreterConfig, подробно — docs/MECHANICS.md.
 */
import { GestureRecognizer, SpamGuard, defaultGestureConfig, type GestureConfig, type GestureEvent, type Pt } from './gestures';
import type { TouchZone } from '../character/types';

export interface InterpreterConfig {
  doubleTapMs: number;
  doubleTapPx: number;
  comboTaps: number;
  comboWindowMs: number;
  /** поглаживание: путь по коту, px */
  strokeMinPx: number;
  /** поглаживание: скорость не выше, px/с */
  strokeMaxSpeed: number;
  strokeLongMs: number;
  /** разрыв касания кота дольше — глажка закончилась */
  strokeGapMs: number;
  /** резкий свайп по коту: скорость от, px/с */
  pokeHardSpeed: number;
  pokeHardMinPx: number;
  sulkMs: number;
  spamTaps: number;
  spamWindowMs: number;
  spamIgnoreMs: number;
}

export const defaultInterpreterConfig: InterpreterConfig = {
  doubleTapMs: 300,
  doubleTapPx: 40,
  comboTaps: 3,
  comboWindowMs: 2000,
  strokeMinPx: 45,
  strokeMaxSpeed: 650,
  strokeLongMs: 4000,
  strokeGapMs: 400,
  pokeHardSpeed: 1400,
  pokeHardMinPx: 70,
  sulkMs: 2000,
  spamTaps: 5,
  spamWindowMs: 2000,
  spamIgnoreMs: 3000,
};

export type TouchEvent =
  | { type: 'tap_cat'; x: number; y: number; zone: TouchZone; event: string }
  | { type: 'poke_combo'; x: number; y: number; zone: TouchZone }
  | { type: 'poke_hard'; x: number; y: number }
  | { type: 'stroke'; x: number; y: number }
  | { type: 'stroke_long'; x: number; y: number }
  | { type: 'stroke_end' }
  | { type: 'double_tap'; x: number; y: number }
  | { type: 'tap_screen'; x: number; y: number }
  | { type: 'longpress'; x: number; y: number; onCat: boolean }
  | { type: 'longpress_end'; x: number; y: number }
  | { type: 'swipe'; x: number; y: number; path: Pt[]; speed: number; dir: string }
  | { type: 'drag'; x: number; y: number }
  | { type: 'spam' }
  /** палец опустился на кота: жест ещё не распознан — кот уже замечает касание (взгляд, уши) */
  | { type: 'touch_down'; x: number; y: number; zone: TouchZone }
  | { type: 'ignored'; reason: 'spam' | 'sulk' };

/** зона → событие тапа по коту */
export const zoneEvent = (z: TouchZone) => (z === 'body' ? 'tap_cat' : `tap_cat_${z}`);

export class TouchInterpreter {
  private rec: GestureRecognizer;
  private spam: SpamGuard;
  private pendingTap: { x: number; y: number; t: number } | null = null;
  private combos: { zone: TouchZone; t: number }[] = [];
  private sulkUntil = -1;
  // текущее касание
  private downZone: TouchZone | null = null;
  private strokePx = 0;
  private stroking = false;
  private strokeStart = 0;
  private strokeLongSent = false;
  private lastOnCat = 0;
  private last: { x: number; y: number; t: number } | null = null;
  private recent: { x: number; y: number; t: number }[] = [];
  private now = 0;

  constructor(
    private emit: (e: TouchEvent) => void,
    /**
     * зона кота в точке экрана (null — мимо кота). coarse — «палец всё ещё на коте?» на каждом движении пальца:
     * хватает грубой проверки (габарит кота); точная — по сетке скинованной модели — стоит 15–20 мс на телефоне
     */
    private zoneAt: (x: number, y: number, coarse?: boolean) => TouchZone | null,
    readonly cfg: InterpreterConfig = defaultInterpreterConfig,
    gcfg: GestureConfig = defaultGestureConfig,
  ) {
    this.spam = new SpamGuard(cfg.spamTaps, cfg.spamWindowMs, cfg.spamIgnoreMs);
    this.rec = new GestureRecognizer((e) => this.onGesture(e), gcfg);
  }

  get sulking() {
    return this.now < this.sulkUntil;
  }

  get isStroking() {
    return this.stroking;
  }

  down(x: number, y: number, t: number) {
    this.now = t;
    this.downZone = this.zoneAt(x, y);
    this.strokePx = 0;
    this.strokeLongSent = false;
    this.last = { x, y, t };
    this.recent = [{ x, y, t }];
    if (this.downZone) {
      this.lastOnCat = t;
      this.emit({ type: 'touch_down', x, y, zone: this.downZone });
    }
    this.rec.down(x, y, t);
  }

  move(x: number, y: number, t: number) {
    this.now = t;
    const prev = this.last;
    this.last = { x, y, t };
    this.recent.push({ x, y, t });
    while (this.recent.length > 2 && t - this.recent[0].t > 150) this.recent.shift();
    this.rec.move(x, y, t);
    if (!prev) return;
    const onCat = this.downZone !== null && this.zoneAt(x, y, true) !== null;
    if (onCat) {
      this.lastOnCat = t;
      // скорость по последним ~150 мс: медленно — это глажка
      const r0 = this.recent[0];
      const dtw = Math.max(1, t - r0.t) / 1000;
      const speed = Math.hypot(x - r0.x, y - r0.y) / dtw;
      if (speed <= this.cfg.strokeMaxSpeed) this.strokePx += Math.hypot(x - prev.x, y - prev.y);
      if (!this.stroking && this.strokePx >= this.cfg.strokeMinPx && !this.sulking) {
        this.stroking = true;
        this.strokeStart = t;
        this.emit({ type: 'stroke', x, y });
      }
    }
    this.checkStroke(t, x, y);
  }

  private checkStroke(t: number, x = 0, y = 0) {
    if (!this.stroking) return;
    if (t - this.lastOnCat > this.cfg.strokeGapMs) return this.endStroke();
    if (!this.strokeLongSent && t - this.strokeStart >= this.cfg.strokeLongMs) {
      this.strokeLongSent = true;
      this.emit({ type: 'stroke_long', x, y });
    }
  }

  private endStroke() {
    if (!this.stroking) return;
    this.stroking = false;
    this.emit({ type: 'stroke_end' });
  }

  up(x: number, y: number, t: number) {
    this.now = t;
    this.last = null;
    const wasStroking = this.stroking;
    this.rec.up(x, y, t);
    if (wasStroking) this.endStroke();
    this.downZone = null;
  }

  cancel() {
    this.rec.cancel();
    this.endStroke();
    this.downZone = null;
  }

  /** каждый кадр: долгое нажатие, отложенный одиночный тап, разрыв глажки */
  tick(t: number) {
    this.now = t;
    this.rec.tick(t);
    if (this.pendingTap && t - this.pendingTap.t > this.cfg.doubleTapMs) {
      const p = this.pendingTap;
      this.pendingTap = null;
      this.emit({ type: 'tap_screen', x: p.x, y: p.y });
    }
    if (this.stroking && this.last === null) this.endStroke();
    if (this.stroking && this.last) this.checkStroke(t, this.last.x, this.last.y);
  }

  private onGesture(e: GestureEvent) {
    const t = this.now;
    switch (e.type) {
      case 'tap': {
        const zone = this.zoneAt(e.x, e.y);
        const sp = this.spam.hit(t);
        if (sp === 'ignored') return this.emit({ type: 'ignored', reason: 'spam' });
        if (sp === 'spam') {
          this.pendingTap = null;
          this.combos = [];
          return this.emit({ type: 'spam' });
        }
        if (zone) {
          if (this.sulking) return this.emit({ type: 'ignored', reason: 'sulk' });
          this.combos = this.combos.filter((c) => t - c.t <= this.cfg.comboWindowMs && c.zone === zone);
          this.combos.push({ zone, t });
          if (this.combos.length >= this.cfg.comboTaps) {
            this.combos = [];
            return this.emit({ type: 'poke_combo', x: e.x, y: e.y, zone });
          }
          return this.emit({ type: 'tap_cat', x: e.x, y: e.y, zone, event: zoneEvent(zone) });
        }
        // мимо кота: ждём второй тап
        const p = this.pendingTap;
        if (p && t - p.t <= this.cfg.doubleTapMs && Math.hypot(e.x - p.x, e.y - p.y) <= this.cfg.doubleTapPx) {
          this.pendingTap = null;
          return this.emit({ type: 'double_tap', x: e.x, y: e.y });
        }
        if (p) this.emit({ type: 'tap_screen', x: p.x, y: p.y });
        this.pendingTap = { x: e.x, y: e.y, t };
        return;
      }
      case 'longpress':
        return this.emit({ type: 'longpress', x: e.x, y: e.y, onCat: this.zoneAt(e.x, e.y) !== null });
      case 'longpress_end':
        return this.emit({ type: 'longpress_end', x: e.x, y: e.y });
      case 'swipe': {
        if (this.stroking) return; // глажка — не свайп
        const startZone = this.downZone;
        if (startZone && e.speed >= this.cfg.pokeHardSpeed && Math.hypot(e.dx, e.dy) >= this.cfg.pokeHardMinPx) {
          if (this.sulking) return this.emit({ type: 'ignored', reason: 'sulk' });
          this.sulkUntil = t + this.cfg.sulkMs;
          return this.emit({ type: 'poke_hard', x: e.x, y: e.y });
        }
        if (startZone && this.strokePx > this.cfg.strokeMinPx * 0.5) return; // медленное ведение по коту
        return this.emit({ type: 'swipe', x: e.x, y: e.y, path: e.path, speed: e.speed, dir: e.dir });
      }
      case 'drag':
        return this.emit({ type: 'drag', x: e.x, y: e.y });
    }
  }
}

/**
 * Чистая логика распознавания жестов (без DOM) — тестируется в vitest.
 * На вход: down/move/up с координатами и временем; на выход: события жестов.
 */
export interface Pt { x: number; y: number; t: number }

export type GestureEvent =
  | { type: 'tap'; x: number; y: number }
  | { type: 'longpress'; x: number; y: number }
  | { type: 'longpress_end'; x: number; y: number; duration: number }
  | { type: 'swipe'; x: number; y: number; dx: number; dy: number; vx: number; vy: number; speed: number; dir: 'left' | 'right' | 'up' | 'down'; path: Pt[] }
  | { type: 'drag'; x: number; y: number; startX: number; startY: number };

export interface GestureConfig {
  longPressMs: number;     // 600 мс по ТЗ
  tapMaxMove: number;      // px — больше уже не тап
  tapMaxMs: number;        // дольше — не тап (но и не долгое, если двигали)
  swipeMinDist: number;    // px
  swipeMinSpeed: number;   // px/с
}

export const defaultGestureConfig: GestureConfig = {
  longPressMs: 600,
  tapMaxMove: 14,
  tapMaxMs: 450,
  swipeMinDist: 60,
  swipeMinSpeed: 300,
};

export class GestureRecognizer {
  private start: Pt | null = null;
  private path: Pt[] = [];
  private longFired = false;
  private moved = false;
  constructor(private emit: (e: GestureEvent) => void, private cfg: GestureConfig = defaultGestureConfig) {}

  down(x: number, y: number, t: number) {
    this.start = { x, y, t };
    this.path = [{ x, y, t }];
    this.longFired = false;
    this.moved = false;
  }

  move(x: number, y: number, t: number) {
    if (!this.start) return;
    this.path.push({ x, y, t });
    if (this.path.length > 64) this.path.splice(1, this.path.length - 64);
    if (Math.hypot(x - this.start.x, y - this.start.y) > this.cfg.tapMaxMove) this.moved = true;
    if (this.moved && !this.longFired) this.emit({ type: 'drag', x, y, startX: this.start.x, startY: this.start.y });
  }

  /** Вызывать регулярно (rAF/таймер) — для срабатывания долгого нажатия без отпускания. */
  tick(t: number) {
    if (this.start && !this.longFired && !this.moved && t - this.start.t >= this.cfg.longPressMs) {
      this.longFired = true;
      this.emit({ type: 'longpress', x: this.start.x, y: this.start.y });
    }
  }

  up(x: number, y: number, t: number) {
    const s = this.start;
    if (!s) return;
    this.tick(t);
    this.path.push({ x, y, t });
    const dx = x - s.x, dy = y - s.y;
    const dist = Math.hypot(dx, dy);
    const dt = Math.max(1, t - s.t);
    if (this.longFired) {
      this.emit({ type: 'longpress_end', x, y, duration: t - s.t });
    } else if (dist <= this.cfg.tapMaxMove && dt <= this.cfg.tapMaxMs) {
      this.emit({ type: 'tap', x, y });
    } else if (dist >= this.cfg.swipeMinDist) {
      // скорость по последним ~120 мс — так свайп «с оттягом» не теряет резкость
      let i = this.path.length - 1;
      while (i > 0 && t - this.path[i].t < 120) i--;
      const p0 = this.path[i];
      const ddt = Math.max(1, t - p0.t) / 1000;
      const vx = (x - p0.x) / ddt, vy = (y - p0.y) / ddt;
      const avg = dist / (dt / 1000);
      const speed = Math.max(Math.hypot(vx, vy), avg);
      if (speed >= this.cfg.swipeMinSpeed) {
        const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
        this.emit({ type: 'swipe', x, y, dx, dy, vx, vy, speed, dir, path: this.path.slice() });
      }
    }
    this.start = null;
  }

  cancel() {
    this.start = null;
  }
}

/** Антиспам: N тапов за окно → событие spam и игнор на cooldown мс. */
export class SpamGuard {
  private taps: number[] = [];
  private ignoreUntil = 0;
  constructor(private limit = 5, private windowMs = 2000, private cooldownMs = 1000) {}
  /** Возвращает 'ok' | 'spam' (сработал) | 'ignored' (в паузе). */
  hit(t: number): 'ok' | 'spam' | 'ignored' {
    if (t < this.ignoreUntil) return 'ignored';
    this.taps.push(t);
    this.taps = this.taps.filter((x) => t - x <= this.windowMs);
    if (this.taps.length >= this.limit) {
      this.taps = [];
      this.ignoreUntil = t + this.cooldownMs;
      return 'spam';
    }
    return 'ok';
  }
}

/** Таймер тишины: нет взаимодействий silenceMs → один раз 'silence' (до следующей активности). */
export class SilenceTimer {
  private last: number;
  private fired = false;
  constructor(now: number, private silenceMs = 10000) {
    this.last = now;
  }
  activity(t: number) {
    this.last = t;
    this.fired = false;
  }
  check(t: number): boolean {
    if (!this.fired && t - this.last >= this.silenceMs) {
      this.fired = true;
      return true;
    }
    return false;
  }
}

/**
 * Детектор встряски по DeviceMotion (accelerationIncludingGravity).
 * Встряска = peaks пиков рывка (изменения ускорения) > threshold за windowMs; после — cooldown.
 */
export class ShakeDetector {
  private prev: [number, number, number] | null = null;
  private peaks: number[] = [];
  private coolUntil = 0;
  constructor(private threshold = 14, private peaksNeeded = 3, private windowMs = 900, private cooldownMs = 1200) {}
  sample(ax: number, ay: number, az: number, t: number): boolean {
    const p = this.prev;
    this.prev = [ax, ay, az];
    if (!p || t < this.coolUntil) return false;
    const jerk = Math.hypot(ax - p[0], ay - p[1], az - p[2]);
    if (jerk > this.threshold) {
      this.peaks.push(t);
      this.peaks = this.peaks.filter((x) => t - x <= this.windowMs);
      if (this.peaks.length >= this.peaksNeeded) {
        this.peaks = [];
        this.coolUntil = t + this.cooldownMs;
        return true;
      }
    }
    return false;
  }
}

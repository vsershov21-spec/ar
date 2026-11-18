/**
 * «Десктоп-просмотр» кота без карты (?nocard, ?desktop): кота на виртуальной площадке можно повернуть и приблизить.
 *  мышь: тянуть (≥ 6 px — иначе это клик-тап по коту) — поворот площадки и наклон; правая/средняя кнопка — сразу
 *  поворот; Shift + тянуть — как палец (глажка кота мышью); колесо / щипок трекпада — зум; двойной клик — сброс
 *  (если вид уже меняли; иначе двойной клик — как раньше, фирменный трюк);
 *  касание: двумя пальцами — поворот и щипок-зум (один палец — тапы и глажка как раньше);
 *  клавиатура: ← → — поворот, ↑ ↓ — наклон, + / − — зум, R — сброс (не в поле ввода и не с Cmd/Ctrl).
 * Чистая логика (OrbitView, DragGate, OrbitPointers) — без DOM, покрыта тестами (tests/orbit.test.ts);
 * привязка к DOM — bindOrbitKeys/bindOrbitWheel, к указателю — через Input.orbit (src/input/input.ts).
 */

export const ORBIT = {
  /** порог перетаскивания: меньше — клик (тап по коту) */
  dragPx: 6,
  /** рад на пиксель: поворот площадки / наклон */
  spinPerPx: 0.008,
  tiltPerPx: 0.005,
  /** наклон: 0 — смотрим сверху, π/2 — сбоку на уровне стола */
  tiltMin: 0.3,
  tiltMax: 1.5,
  distMin: 1.4,
  distMax: 7,
  keySpin: 0.18,
  keyTilt: 0.08,
  keyZoom: 1.12,
  /** двойной клик: окно и разброс */
  dblMs: 350,
  dblPx: 40,
};

export interface ViewPose {
  /** поворот площадки вокруг нормали (рад) */
  spin: number;
  tilt: number;
  distance: number;
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** вид на площадку: поворот, наклон, расстояние в разумных пределах; target — куда писать (трекер) */
export class OrbitView {
  readonly home: ViewPose;
  constructor(
    private target: ViewPose,
    private onChange: (v: OrbitView) => void = () => {},
  ) {
    this.home = { spin: target.spin, tilt: target.tilt, distance: target.distance };
  }
  get pose(): ViewPose {
    return { spin: this.target.spin, tilt: this.target.tilt, distance: this.target.distance };
  }
  /** вид отличается от начального */
  get changed() {
    const t = this.target, h = this.home;
    return Math.abs(t.spin - h.spin) > 1e-3 || Math.abs(t.tilt - h.tilt) > 1e-3 || Math.abs(t.distance - h.distance) > 1e-3;
  }
  /** повёрнута ли площадка (кот перестаёт сам разворачиваться к зрителю) */
  get spun() {
    return Math.abs(Math.atan2(Math.sin(this.target.spin - this.home.spin), Math.cos(this.target.spin - this.home.spin))) > 0.01;
  }
  /** перетаскивание на dx, dy px: вправо — площадка вправо, вниз — смотрим выше (как OrbitControls) */
  drag(dx: number, dy: number) {
    this.rotate(dx * ORBIT.spinPerPx, -dy * ORBIT.tiltPerPx);
  }
  rotate(dSpin: number, dTilt: number) {
    const t = this.target;
    t.spin = Math.atan2(Math.sin(t.spin + dSpin), Math.cos(t.spin + dSpin));
    t.tilt = clamp(t.tilt + dTilt, ORBIT.tiltMin, ORBIT.tiltMax);
    this.onChange(this);
  }
  /** f > 1 — ближе */
  zoom(f: number) {
    if (!(f > 0)) return;
    const t = this.target;
    t.distance = clamp(t.distance / f, ORBIT.distMin, ORBIT.distMax);
    this.onChange(this);
  }
  reset() {
    Object.assign(this.target, this.home);
    this.onChange(this);
  }
}

/** порог «клик или перетаскивание» для одного указателя */
export class DragGate {
  private x0 = 0;
  private y0 = 0;
  private lx = 0;
  private ly = 0;
  state: 'idle' | 'pending' | 'drag' = 'idle';
  constructor(readonly thresholdPx = ORBIT.dragPx) {}
  down(x: number, y: number) {
    this.x0 = this.lx = x;
    this.y0 = this.ly = y;
    this.state = 'pending';
  }
  /** null — ещё не перетаскивание; иначе смещение с прошлого move (первый раз — от точки нажатия) */
  move(x: number, y: number): { dx: number; dy: number } | null {
    if (this.state === 'idle') return null;
    if (this.state === 'pending') {
      if (Math.hypot(x - this.x0, y - this.y0) < this.thresholdPx) return null;
      this.state = 'drag';
    }
    const d = { dx: x - this.lx, dy: y - this.ly };
    this.lx = x;
    this.ly = y;
    return d;
  }
  /** чем закончилось нажатие */
  up(): 'tap' | 'drag' | 'none' {
    const s = this.state;
    this.state = 'idle';
    return s === 'drag' ? 'drag' : s === 'pending' ? 'tap' : 'none';
  }
  cancel() {
    this.state = 'idle';
  }
}

/** указатель (подмножество PointerEvent) */
export interface OrbitPointer {
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
  button?: number;
  shiftKey?: boolean;
  timeStamp: number;
}

/**
 * Что делать Input с событием указателя:
 *  pass — как обычно (тап, глажка, свайп);
 *  take — вращение забрало указатель: текущий жест отменить (тап/глажка не срабатывают);
 *  swallow — событие проглотить (двойной клик-сброс).
 */
export type OrbitVerdict = 'pass' | 'take' | 'swallow';

/** мышь: перетаскивание с порогом; касание: два пальца — поворот и щипок */
export class OrbitPointers {
  private gate = new DragGate();
  private mouse: 'none' | 'gate' | 'drag' | 'swallow' = 'none';
  private mouseId = -1;
  private lastClick: { x: number; y: number; t: number } | null = null;
  private touches = new Map<number, { x: number; y: number }>();
  private multi = false;
  private prev: { cx: number; cy: number; d: number } | null = null;
  /** начато вращение (подсказку можно прятать) */
  onStart: () => void = () => {};

  constructor(readonly view: OrbitView) {}

  private isMouse(e: OrbitPointer) {
    return e.pointerType === 'mouse' || e.pointerType === 'pen' || e.pointerType === '';
  }

  /** canTake — Input сейчас не держит особый жест (пузырь, туман, наклейка, долгое нажатие) */
  down(e: OrbitPointer, canTake = true): OrbitVerdict {
    if (this.isMouse(e)) {
      this.mouseId = e.pointerId;
      const c = this.lastClick;
      if (c && e.timeStamp - c.t <= ORBIT.dblMs && Math.hypot(e.clientX - c.x, e.clientY - c.y) <= ORBIT.dblPx && this.view.changed) {
        // двойной клик при изменённом виде — сброс, второй клик не тап
        this.lastClick = null;
        this.mouse = 'swallow';
        this.view.reset();
        return 'swallow';
      }
      if ((e.button ?? 0) !== 0 && canTake) {
        this.gate.down(e.clientX, e.clientY);
        this.gate.state = 'drag';
        this.mouse = 'drag';
        this.onStart();
        return 'take';
      }
      // Shift — мышь как палец (глажка, свайп)
      if (e.shiftKey) {
        this.mouse = 'none';
        return 'pass';
      }
      this.gate.down(e.clientX, e.clientY);
      this.mouse = 'gate';
      return 'pass';
    }
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.multi) return 'take';
    if (this.touches.size >= 2 && canTake) {
      this.multi = true;
      this.prev = this.pair();
      this.onStart();
      return 'take';
    }
    return 'pass';
  }

  move(e: OrbitPointer, canTake = true): OrbitVerdict {
    if (this.isMouse(e)) {
      if (e.pointerId !== this.mouseId) return 'pass';
      if (this.mouse === 'swallow') return 'swallow';
      if (this.mouse === 'gate') {
        if (!canTake) {
          this.gate.cancel();
          this.mouse = 'none';
          return 'pass';
        }
        const d = this.gate.move(e.clientX, e.clientY);
        if (!d) return 'pass';
        this.mouse = 'drag';
        this.lastClick = null;
        this.onStart();
        this.view.drag(d.dx, d.dy);
        return 'take';
      }
      if (this.mouse === 'drag') {
        const d = this.gate.move(e.clientX, e.clientY);
        if (d) this.view.drag(d.dx, d.dy);
        return 'take';
      }
      return 'pass';
    }
    if (!this.touches.has(e.pointerId)) return 'pass';
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!this.multi) return 'pass';
    const p = this.pair();
    if (p && this.prev) {
      this.view.drag(p.cx - this.prev.cx, p.cy - this.prev.cy);
      if (this.prev.d > 10 && p.d > 10) this.view.zoom(p.d / this.prev.d);
    }
    this.prev = p;
    return 'take';
  }

  up(e: OrbitPointer): OrbitVerdict {
    if (this.isMouse(e)) {
      if (e.pointerId !== this.mouseId) return 'pass';
      const m = this.mouse;
      this.mouse = 'none';
      const g = this.gate.up();
      if (m === 'swallow') return 'swallow';
      if (m === 'drag') return 'take';
      if (m === 'gate' && g === 'tap') this.lastClick = { x: e.clientX, y: e.clientY, t: e.timeStamp };
      return 'pass';
    }
    if (!this.touches.delete(e.pointerId)) return 'pass';
    if (!this.multi) return 'pass';
    this.prev = this.pair();
    if (this.touches.size === 0) {
      this.multi = false;
      this.prev = null;
    }
    return 'take';
  }

  cancel(e: OrbitPointer) {
    if (this.isMouse(e)) {
      this.mouse = 'none';
      this.gate.cancel();
      return;
    }
    this.touches.delete(e.pointerId);
    if (this.touches.size === 0) this.multi = false;
    this.prev = this.pair();
  }

  /** центр и расстояние первых двух пальцев */
  private pair() {
    const [a, b] = [...this.touches.values()];
    if (!a || !b) return null;
    return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
  }
}

/** клавиша → действие с видом; true — обработано (не в поле ввода, без Cmd/Ctrl/Alt) */
export function orbitKey(view: OrbitView, e: { key: string; code?: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; target?: EventTarget | null }): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (isTextInput(e.target ?? null)) return false;
  switch (e.key) {
    case 'ArrowLeft':
      view.rotate(-ORBIT.keySpin, 0);
      return true;
    case 'ArrowRight':
      view.rotate(ORBIT.keySpin, 0);
      return true;
    case 'ArrowUp':
      view.rotate(0, -ORBIT.keyTilt);
      return true;
    case 'ArrowDown':
      view.rotate(0, ORBIT.keyTilt);
      return true;
    case '+':
    case '=':
      view.zoom(ORBIT.keyZoom);
      return true;
    case '-':
    case '_':
      view.zoom(1 / ORBIT.keyZoom);
      return true;
  }
  if (e.code === 'NumpadAdd') return view.zoom(ORBIT.keyZoom), true;
  if (e.code === 'NumpadSubtract') return view.zoom(1 / ORBIT.keyZoom), true;
  // R на любой раскладке (на русской — «К»)
  if (e.code === 'KeyR' || e.key === 'r' || e.key === 'R') return view.reset(), true;
  return false;
}

function isTextInput(t: EventTarget | null): boolean {
  const el = (t as HTMLElement | null) ?? (typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null);
  const a = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
  return [el, a].some((x) => !!x && (/^(INPUT|TEXTAREA|SELECT)$/.test(x.tagName ?? '') || !!x.isContentEditable));
}

/** колесо мыши / щипок трекпада (Chrome: ctrl+wheel; Safari: gesturechange) → зум; без прокрутки и зума страницы */
export function bindOrbitWheel(surface: HTMLElement, view: OrbitView, onUse: () => void = () => {}) {
  surface.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      // щипок трекпада приходит как ctrl+wheel с мелкими шагами — чувствительнее
      const k = e.ctrlKey ? 0.01 : 0.0015;
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      view.zoom(Math.exp(-dy * k));
      onUse();
    },
    { passive: false },
  );
  let s0 = 1;
  surface.addEventListener('gesturestart', (e) => {
    e.preventDefault();
    s0 = (e as unknown as { scale: number }).scale || 1;
  });
  surface.addEventListener('gesturechange', (e) => {
    e.preventDefault();
    const s = (e as unknown as { scale: number }).scale || 1;
    view.zoom(s / s0);
    s0 = s;
    onUse();
  });
  surface.addEventListener('gestureend', (e) => e.preventDefault());
}

export function bindOrbitKeys(view: OrbitView, onUse: () => void = () => {}) {
  window.addEventListener('keydown', (e) => {
    if (orbitKey(view, e)) {
      e.preventDefault();
      onUse();
    }
  });
}

/** устройство с касанием (телефон, планшет, iPad «как Mac») — без подсказки про мышь */
export function isTouchDevice(): boolean {
  if (typeof navigator !== 'undefined' && (navigator.maxTouchPoints ?? 0) > 0) return true;
  try {
    return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

/** десктоп-просмотр: ?desktop или ?nocard=off на устройстве без касания — без ожидания камеры и датчиков */
export function isDesktopView(search: string, touch = isTouchDevice()): boolean {
  return noCardCameraOff(search) && !touch;
}

/** без карты и без камеры: ?nocard=off или ?desktop (псевдоним; ?desktop&nocard=cam — с камерой) */
export function noCardCameraOff(search: string): boolean {
  const q = new URLSearchParams(search);
  return q.get('nocard') === 'off' || (q.has('desktop') && q.get('nocard') !== 'cam');
}

export const ORBIT_HINT = 'Тяни — повернуть · колесо — приблизить · двойной клик — сброс';
const HINT_KEY = 'ar.orbitHint';

/** подсказка-плашка один раз (на устройстве без касания) */
export function showOrbitHint(root: HTMLElement): (() => void) | null {
  try {
    if (localStorage.getItem(HINT_KEY)) return null;
    localStorage.setItem(HINT_KEY, '1');
  } catch {
    /* приватный режим — покажем */
  }
  const el = document.createElement('div');
  el.className = 'orbit-hint';
  el.textContent = ORBIT_HINT;
  el.setAttribute('role', 'status');
  Object.assign(el.style, {
    position: 'absolute', left: '50%', top: 'calc(env(safe-area-inset-top, 0px) + 14px)', transform: 'translateX(-50%)', zIndex: '40',
    pointerEvents: 'none', whiteSpace: 'nowrap', maxWidth: 'calc(100% - 24px)', overflow: 'hidden', textOverflow: 'ellipsis',
    font: '600 13px/1.2 -apple-system, BlinkMacSystemFont, "SB Sans Text", system-ui, sans-serif', color: '#fff',
    background: 'rgba(16, 40, 30, .72)', backdropFilter: 'blur(8px)', borderRadius: '999px', padding: '8px 14px',
    boxShadow: '0 4px 14px rgba(0,0,0,.18)', transition: 'opacity .4s', opacity: '1',
  });
  root.appendChild(el);
  let gone = false;
  const hide = () => {
    if (gone) return;
    gone = true;
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 450);
  };
  setTimeout(hide, 9000);
  return hide;
}

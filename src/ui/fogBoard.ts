/**
 * Запотевшее стекло на весь экран, по которому рисуют пальцем (feature 'glass.fogDraw').
 * Кот «дышит» на стекло («К стеклу» / «Подыши», долгое нажатие мимо кота): туман расходится от его носа на весь экран,
 * палец стирает туман мягкой кистью (несколько пальцев сразу — у каждого свой след), через ~12 с (или по кнопке
 * «Протереть») туман уходит, и кот отвечает на рисунок репликой (onDone → app.ts).
 *
 * Свой холст поверх слоя эффектов и под интерфейсом: кнопки дока остаются нажимаемыми, а касания по стеклу не
 * превращаются в царапины/глажку. iPhone Safari: touch-события пальцев (у каждого свой identifier) + touch-action: none + preventDefault —
 * страница не скроллится и не масштабируется. Холст — в половину разрешения (дёшево на старых iPhone).
 */

export interface FogBoardOpts {
  /** туман держится столько мс (продлевается, пока рисуют, но не дольше maxMs) */
  lifeMs?: number;
  maxMs?: number;
  /** кисть, px экрана */
  brushPx?: number;
}

export interface FogResult {
  /** сколько пикселей пути нарисовал палец (экранные px) */
  drawn: number;
  /** штрихов (касаний) */
  strokes: number;
  /** ушёл по кнопке */
  byButton: boolean;
}

const SCALE = 0.5;

export class FogBoard {
  readonly el: HTMLDivElement;
  private cv: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private btn: HTMLButtonElement;
  private pts = new Map<number, { x: number; y: number }>();
  private active = false;
  private startAt = 0;
  private lastDrawAt = 0;
  private timer = 0;
  private drawn = 0;
  private strokes = 0;
  private brush: HTMLCanvasElement;
  private o: Required<FogBoardOpts>;
  /** туман ушёл: что нарисовали */
  onDone: (r: FogResult) => void = () => undefined;
  /** палец рисует (не чаще 4 раз в секунду): кот смотрит на палец */
  onStroke: (p: { x: number; y: number }) => void = () => undefined;
  /** скрип пальца по стеклу */
  onSqueak: () => void = () => undefined;
  private lastStrokeCb = 0;
  private lastSqueak = 0;

  constructor(parent: HTMLElement, opts: FogBoardOpts = {}) {
    this.o = { lifeMs: 12000, maxMs: 20000, brushPx: 46, ...opts };
    const el = document.createElement('div');
    el.className = 'fogb hidden';
    el.innerHTML = `<canvas class="fogb-cv" aria-label="Запотевшее стекло: рисуй пальцем"></canvas>
      <button type="button" class="btn btn-light fogb-wipe">Протереть стекло</button>`;
    parent.appendChild(el);
    this.el = el;
    this.cv = el.querySelector('canvas') as HTMLCanvasElement;
    this.g = this.cv.getContext('2d')!;
    this.btn = el.querySelector('.fogb-wipe') as HTMLButtonElement;
    this.brush = makeBrush(Math.round(this.o.brushPx * SCALE));
    const cv = this.cv;
    // пальцы — touch-события (на iOS Safari надёжнее pointer: каждый палец со своим identifier, preventDefault
    // не даёт странице скроллиться/масштабироваться); мышь и перо — pointer-события
    const touchIds = (id: number) => 100000 + id;
    cv.addEventListener('touchstart', (e) => {
      if (!this.active) return;
      e.preventDefault();
      for (const t of e.changedTouches) this.down({ id: touchIds(t.identifier), x: t.clientX, y: t.clientY });
    }, { passive: false });
    cv.addEventListener('touchmove', (e) => {
      if (!this.active) return;
      e.preventDefault();
      for (const t of e.changedTouches) this.move(touchIds(t.identifier), [{ clientX: t.clientX, clientY: t.clientY }]);
    }, { passive: false });
    const tend = (e: TouchEvent) => {
      for (const t of e.changedTouches) this.pts.delete(touchIds(t.identifier));
    };
    cv.addEventListener('touchend', tend);
    cv.addEventListener('touchcancel', tend);
    cv.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') return;
      e.preventDefault();
      try {
        cv.setPointerCapture(e.pointerId);
      } catch {
        /* указатель уже отпущен */
      }
      this.down({ id: e.pointerId, x: e.clientX, y: e.clientY });
    });
    cv.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
      this.move(e.pointerId, list.length ? list : [e]);
    });
    const up = (e: PointerEvent) => this.pts.delete(e.pointerId);
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('lostpointercapture', up);
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    this.btn.addEventListener('click', () => this.finish(true));
  }

  get on() {
    return this.active;
  }

  /** туман расходится от точки (нос кота) на весь экран */
  start(from?: { x: number; y: number }) {
    const W = this.el.parentElement!.clientWidth, H = this.el.parentElement!.clientHeight;
    const cw = Math.max(1, Math.round(W * SCALE)), ch = Math.max(1, Math.round(H * SCALE));
    this.cv.width = cw;
    this.cv.height = ch;
    paintFog(this.g, cw, ch);
    this.pts.clear();
    this.drawn = 0;
    this.strokes = 0;
    this.active = true;
    this.startAt = this.lastDrawAt = performance.now();
    const fx = from?.x ?? W / 2, fy = from?.y ?? H * 0.4;
    this.el.style.setProperty('--fx', `${Math.round(fx)}px`);
    this.el.style.setProperty('--fy', `${Math.round(fy)}px`);
    this.el.classList.remove('hidden', 'out', 'in');
    void this.el.offsetWidth;
    this.el.classList.add('in');
    clearInterval(this.timer);
    this.timer = window.setInterval(() => this.tick(), 250);
  }

  /** убрать сразу, без реакции (смена режима, уход со страницы) */
  cancel() {
    if (!this.active) return;
    this.active = false;
    clearInterval(this.timer);
    this.el.classList.add('hidden');
  }

  private tick() {
    if (!this.active) return;
    const now = performance.now();
    const end = Math.min(this.startAt + this.o.maxMs, Math.max(this.startAt + this.o.lifeMs, this.lastDrawAt + 3000));
    if (now >= end && !this.pts.size) this.finish(false);
  }

  private finish(byButton: boolean) {
    if (!this.active) return;
    this.active = false;
    clearInterval(this.timer);
    this.pts.clear();
    this.el.classList.add('out');
    window.setTimeout(() => {
      if (!this.active) this.el.classList.add('hidden');
    }, 900);
    this.onDone({ drawn: Math.round(this.drawn), strokes: this.strokes, byButton });
  }

  private down(e: { id: number; x: number; y: number }) {
    if (!this.active) return;
    const p = this.local({ clientX: e.x, clientY: e.y });
    this.pts.set(e.id, p);
    this.strokes++;
    this.stamp(p.x, p.y, p.x, p.y);
    this.lastDrawAt = performance.now();
  }
  /** палец id прошёл через точки list (склеенные события — все, линия без «бусин») */
  private move(id: number, list: { clientX: number; clientY: number }[]) {
    const prev = this.pts.get(id);
    if (!this.active || !prev) return;
    let last = prev;
    for (const ce of list) {
      const p = this.local(ce);
      this.stamp(p.x, p.y, last.x, last.y);
      this.drawn += Math.hypot(p.x - last.x, p.y - last.y);
      last = p;
    }
    this.pts.set(id, last);
    const now = performance.now();
    this.lastDrawAt = now;
    if (now - this.lastStrokeCb > 250) {
      this.lastStrokeCb = now;
      this.onStroke(last);
    }
    if (now - this.lastSqueak > 380) {
      this.lastSqueak = now;
      this.onSqueak();
    }
  }
  private local(e: { clientX: number; clientY: number }) {
    const r = this.cv.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** мягкая кисть по линии: отпечатки радиального градиента с шагом в треть кисти */
  private stamp(x: number, y: number, px: number, py: number) {
    const g = this.g, b = this.brush, k = SCALE;
    const d = Math.hypot(x - px, y - py) * k;
    const step = Math.max(1, b.width / 5);
    const n = Math.max(1, Math.ceil(d / step));
    g.save();
    g.globalCompositeOperation = 'destination-out';
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const cx = (px + (x - px) * t) * k, cy = (py + (y - py) * t) * k;
      g.drawImage(b, cx - b.width / 2, cy - b.height / 2);
    }
    g.restore();
  }
}

/** туман: молочная пелена с неровной плотностью и каплями (рисуется один раз на старте) */
function paintFog(g: CanvasRenderingContext2D, w: number, h: number) {
  g.globalCompositeOperation = 'source-over';
  g.clearRect(0, 0, w, h);
  g.fillStyle = 'rgba(226, 236, 240, 0.78)';
  g.fillRect(0, 0, w, h);
  // пятна плотнее/реже — стекло запотело неровно
  for (let i = 0; i < 14; i++) {
    const x = Math.random() * w, y = Math.random() * h, r = (0.2 + Math.random() * 0.35) * Math.max(w, h);
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    const a = 0.08 + Math.random() * 0.12;
    gr.addColorStop(0, `rgba(250, 253, 255, ${a})`);
    gr.addColorStop(1, 'rgba(250, 253, 255, 0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);
  }
  // мелкие капельки
  for (let i = 0; i < Math.round((w * h) / 900); i++) {
    const x = Math.random() * w, y = Math.random() * h, r = 0.6 + Math.random() * 1.8;
    g.fillStyle = `rgba(255,255,255,${0.25 + Math.random() * 0.35})`;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
}

/** кисть: круг с мягким краем (центр стирает полностью, край — плавно) */
function makeBrush(px: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  const s = Math.max(4, px);
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  gr.addColorStop(0, 'rgba(0,0,0,0.9)');
  gr.addColorStop(0.55, 'rgba(0,0,0,0.75)');
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, s, s);
  return c;
}

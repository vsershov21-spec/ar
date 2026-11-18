/**
 * Салют на весь экран (пробуждение кота, src/awake): свой холст поверх камеры и кота, под интерфейсом.
 * 3–5 залпов цветами Сбера (зелёный, лайм, бирюза, золото, белый): ракета с хвостом → разрыв звездой, кольцом,
 * сердечком или шаром; гравитация, сопротивление воздуха, затухание и лёгкое мерцание.
 *
 * Морду кота не закрывает: центры разрывов выбираются вне круга вокруг головы (с запасом на радиус разрыва),
 * ракеты взлетают по краям; что упадёт через морду — уже гаснет (≤ 0,5 с). Длительность ≈ 3 с (маленький — ≈ 1,5 с),
 * после — холст очищен и спрятан (display: none), кадры не рисуются.
 *
 * Производительность: один холст 2D, частицы — объектный пул (≤ 600, без new в кадре), каждая — drawImage
 * готового «светлячка» своего цвета (спрайт рисуется один раз при создании); хвосты — не по частицам,
 * а полупрозрачным стиранием прошлого кадра (destination-out). DPR ≤ 1,5.
 */

export type BurstShape = 'star' | 'ring' | 'heart' | 'peony';
export type SaluteSize = 'big' | 'small';

/** палитра Сбера для салюта */
export const SBER_SALUTE = ['#21A038', '#B5E36A', '#2FD3C8', '#FFD35C', '#FFFFFF'];

export interface SaluteOpts {
  size: SaluteSize;
  /** формы разрывов по кругу (образ кота) */
  shapes: BurstShape[];
  colors?: string[];
  /** мерцание-«треск» на хвосте жизни (Блёстка — сильнее) */
  crackle?: number;
}

export const MAX_PARTS = 600;

interface P {
  on: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  size: number;
  sprite: number;
  /** 0 — искра разрыва, 1 — ракета, 2 — искра хвоста ракеты */
  kind: number;
  flick: number;
  /** ракета: куда взорваться */
  burst: Volley | null;
}

interface Volley {
  at: number;
  x: number;
  y: number;
  r: number;
  shape: BurstShape;
  c1: number;
  c2: number;
  n: number;
  fired: boolean;
  exploded: boolean;
}

/** план залпов: время от старта, сколько ракет, сила (детерминированно от seed — тесты) */
export function volleyPlan(size: SaluteSize): { at: number; rockets: number; n: number }[] {
  return size === 'big'
    ? [
        { at: 0.0, rockets: 1, n: 100 },
        { at: 0.4, rockets: 1, n: 96 },
        { at: 0.8, rockets: 2, n: 84 },
        { at: 1.3, rockets: 1, n: 104 },
      ]
    : [
        { at: 0.0, rockets: 1, n: 70 },
        { at: 0.3, rockets: 1, n: 60 },
      ];
}

export class Salute {
  readonly canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private w = 1;
  private h = 1;
  private dpr = 1;
  private pool: P[] = [];
  private volleys: Volley[] = [];
  private t = 0;
  private running = false;
  private sprites: HTMLCanvasElement[] = [];
  private colorIdx = new Map<string, number>();
  private opts: SaluteOpts = { size: 'big', shapes: ['peony'] };
  private shapeI = 0;
  /** морда кота на экране (px) и её радиус — разрывы не над ней */
  faceFn: () => { x: number; y: number; r: number } | null = () => null;
  /** залп разорвался (звук хлопка) */
  onBurst: (x: number, w: number) => void = () => {};
  /** частиц сейчас (debug, тесты) */
  live = 0;
  peak = 0;

  constructor(parent: HTMLElement | null) {
    this.canvas = typeof document !== 'undefined' ? document.createElement('canvas') : ({} as HTMLCanvasElement);
    this.g = (this.canvas.getContext?.('2d') ?? null) as CanvasRenderingContext2D;
    if (parent) {
      this.canvas.className = 'salute-layer';
      // поверх кота и эффектов (fx-layer — 2), под интерфейсом (ui — 3); касания проходят насквозь
      Object.assign(this.canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '2', display: 'none' });
      parent.appendChild(this.canvas);
    }
    for (let i = 0; i < MAX_PARTS; i++)
      this.pool.push({ on: false, x: 0, y: 0, vx: 0, vy: 0, age: 0, life: 1, size: 1, sprite: 0, kind: 0, flick: 0, burst: null });
    this.ensureSprites(SBER_SALUTE);
  }

  get active() {
    return this.running;
  }

  resize(w: number, h: number) {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    this.dpr = Math.min(1.5, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
    if (this.g) {
      this.canvas.width = Math.round(this.w * this.dpr);
      this.canvas.height = Math.round(this.h * this.dpr);
    }
  }

  /** «светлячок» каждого цвета — один раз (прогрев до сцены: в кадре салюта ничего не рисуется заново) */
  private ensureSprites(colors: string[]) {
    if (typeof document === 'undefined') {
      colors.forEach((c) => this.colorIdx.has(c) || this.colorIdx.set(c, this.colorIdx.size));
      return;
    }
    for (const c of colors) {
      if (this.colorIdx.has(c)) continue;
      const s = document.createElement('canvas');
      s.width = s.height = 32;
      const g = s.getContext('2d')!;
      const gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
      gr.addColorStop(0, '#ffffff');
      gr.addColorStop(0.18, c);
      gr.addColorStop(0.45, hexA(c, 0.45));
      gr.addColorStop(1, hexA(c, 0));
      g.fillStyle = gr;
      g.fillRect(0, 0, 32, 32);
      this.colorIdx.set(c, this.sprites.length);
      this.sprites.push(s);
    }
  }

  /** запустить салют (прошлый, если идёт, — продолжается: новые залпы добавятся) */
  start(opts: SaluteOpts) {
    this.opts = opts;
    const colors = opts.colors?.length ? opts.colors : SBER_SALUTE;
    this.ensureSprites(colors);
    if (!this.running) {
      this.t = 0;
      this.volleys.length = 0;
    }
    const plan = volleyPlan(opts.size);
    const R = Math.min(this.w, this.h) * (opts.size === 'big' ? 0.3 : 0.22);
    const placed: { x: number; y: number; r: number }[] = [];
    for (const v of plan)
      for (let k = 0; k < v.rockets; k++) {
        const p = this.place(R, placed);
        placed.push(p);
        const c1 = this.colorIdx.get(colors[(this.volleys.length * 2) % colors.length])!;
        const c2 = this.colorIdx.get(colors[(this.volleys.length * 2 + 3) % colors.length])!;
        this.volleys.push({ at: this.t + v.at + k * 0.12, x: p.x, y: p.y, r: p.r * (0.88 + Math.random() * 0.12), shape: opts.shapes[this.shapeI++ % opts.shapes.length], c1, c2, n: v.n, fired: false, exploded: false });
      }
    this.running = true;
    this.canvas.style && (this.canvas.style.display = '');
  }

  /**
   * Центр и радиус разрыва: лучше в верхней половине, но всегда так, чтобы круг разрыва не лёг на морду кота.
   * Кот близко (морда на пол-экрана) — разрывы уходят в углы и по бокам и становятся меньше (до 0,5 R).
   */
  private place(R: number, placed: { x: number; y: number }[]) {
    const f = this.faceFn();
    let best = { x: this.w / 2, y: this.h * 0.2, r: R }, bestS = -1e9;
    for (let i = 0; i < 40; i++) {
      // половина кандидатов — вверху (как салют в небе), остальные — по всему экрану над нижней панелью
      const top = i % 2 === 0;
      const x = this.w * (0.14 + Math.random() * 0.72), y = this.h * (top ? 0.1 + Math.random() * 0.32 : 0.1 + Math.random() * 0.62);
      let r = R, s = top ? 30 : 0;
      if (f) {
        const room = Math.hypot(x - f.x, y - f.y) - f.r * 1.15;
        r = Math.max(R * 0.5, Math.min(R, room));
        const over = room - r; // < 0 — разрыв задевает морду
        s += over < 0 ? over * 8 - 200 : Math.min(over, R) * 0.4;
        s += (r / R) * 40;
      }
      for (const q of placed) s += Math.min(Math.hypot(x - q.x, y - q.y), R * 1.5) * 0.6;
      s += Math.random() * 10;
      if (s > bestS) {
        bestS = s;
        best = { x, y, r };
      }
    }
    return best;
  }

  /** прогрев: холст 2D выделяет буфер при первом рисовании — заранее, а не в кадре первого залпа */
  warm() {
    if (!this.g) return;
    const g = this.g;
    g.globalCompositeOperation = 'destination-out';
    g.fillRect(0, 0, 1, 1);
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = 0.01;
    for (const s of this.sprites) g.drawImage(s, 0, 0, 2, 2);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** остановить сразу (экран чистый) */
  stop() {
    for (const p of this.pool) p.on = false;
    this.volleys.length = 0;
    this.finish();
  }

  private finish() {
    this.running = false;
    this.live = 0;
    if (this.g) this.g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.canvas.style) this.canvas.style.display = 'none';
  }

  private spawn(): P | null {
    for (let i = 0; i < this.pool.length; i++) {
      const p = this.pool[(this.cursor + i) % this.pool.length];
      if (!p.on) {
        this.cursor = (this.cursor + i + 1) % this.pool.length;
        p.on = true;
        p.age = 0;
        p.burst = null;
        return p;
      }
    }
    return null; // пул полон — лишняя искра не рождается
  }
  private cursor = 0;

  /** шаг по времени; длинный кадр (тормоза, 12–20 к/с) — подшагами по ≤ 33 мс: салют идёт по часам, не отстаёт */
  update(dt: number) {
    if (!this.running) return;
    dt = Math.min(dt, 0.25);
    while (dt > 1e-6 && this.running) {
      const h = Math.min(dt, 1 / 30);
      this.step(h);
      dt -= h;
    }
  }

  private step(dt: number) {
    this.t += dt;
    // ракеты: вылет снизу у края, ~0,55 с до точки разрыва
    for (const v of this.volleys) {
      if (v.fired || this.t < v.at) continue;
      v.fired = true;
      const r = this.spawn();
      if (!r) continue;
      const fromX = v.x + (v.x < this.w / 2 ? -1 : 1) * this.w * 0.06;
      const T = 0.55;
      r.kind = 1;
      r.x = fromX;
      r.y = this.h + 10;
      // баллистика: vy0 так, чтобы на T быть в v.y при гравитации G_R
      r.vx = (v.x - fromX) / T;
      r.vy = (v.y - r.y - 0.5 * G_R * T * T) / T;
      r.life = T;
      r.size = 3.2;
      r.sprite = v.c1;
      r.flick = 0; // у ракеты — накопитель искр хвоста
      r.burst = v;
    }
    let live = 0;
    const G = this.h * 0.32;
    for (const p of this.pool) {
      if (!p.on) continue;
      p.age += dt;
      if (p.kind === 1) {
        p.vy += G_R * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        // хвост ракеты: ~70 искр в секунду (не «за кадр» — иначе на 120 Гц или в замедлении пул кончается)
        p.flick += dt * 70;
        for (; p.flick >= 1; p.flick -= 1) {
          const s = this.spawn();
          if (s) {
            s.kind = 2;
            s.x = p.x + (Math.random() - 0.5) * 2;
            s.y = p.y + 4;
            s.vx = (Math.random() - 0.5) * 30;
            s.vy = 40 + Math.random() * 40;
            s.life = 0.25 + Math.random() * 0.2;
            s.size = 1.6 + Math.random();
            s.sprite = this.colorIdx.get('#FFD35C') ?? p.sprite;
            s.flick = 0.5;
          }
        }
        if (p.age >= p.life && p.burst) {
          this.explode(p.burst, p.x, p.y);
          p.on = false;
        }
      } else {
        const drag = p.kind === 0 ? 1.6 : 3;
        p.vx -= p.vx * drag * dt;
        p.vy -= p.vy * drag * dt;
        p.vy += G * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.age >= p.life) p.on = false;
      }
      if (p.on) live++;
    }
    this.live = live;
    this.peak = Math.max(this.peak, live);
    if (!live && this.volleys.every((v) => v.exploded)) this.finish();
  }

  private explode(v: Volley, x: number, y: number) {
    v.exploded = true;
    this.onBurst(x, this.w);
    const n = v.n;
    const R = v.r;
    const crackle = this.opts.crackle ?? 0.3;
    // сопротивление 1,6/с: скорость v0 = R·2,4 за ~0,5 с пролетит ≈ R (и почти останавливается — «шапка» разрыва)
    const k = 2.4;
    for (let i = 0; i < n; i++) {
      const p = this.spawn();
      if (!p) return;
      const a = (i / n) * Math.PI * 2;
      let dx = Math.cos(a), dy = Math.sin(a), m = 1;
      switch (v.shape) {
        case 'ring':
          m = 0.95 + Math.random() * 0.1;
          break;
        case 'star': {
          // 5 лучей: длина по углу
          const ph = (((a + Math.PI / 2) / (Math.PI * 2)) * 5) % 1;
          m = 0.45 + 0.55 * Math.pow(1 - Math.abs(ph - 0.5) * 2, 2.2);
          break;
        }
        case 'heart': {
          // сердечко: x = 16 sin³, y = 13 cos − 5 cos2 − 2 cos3 − cos4 (вверх — минус)
          const s = Math.sin(a), c = Math.cos(a);
          dx = (16 * s * s * s) / 17;
          dy = -(13 * c - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a)) / 17;
          m = 1;
          break;
        }
        default: {
          // шар: случайное направление, скорость — проекция сферы
          const b = Math.random() * Math.PI * 2;
          dx = Math.cos(b);
          dy = Math.sin(b);
          m = Math.sqrt(Math.random()) * 0.95 + 0.05;
        }
      }
      p.kind = 0;
      p.x = x;
      p.y = y;
      p.vx = dx * m * R * k + (Math.random() - 0.5) * 8;
      p.vy = dy * m * R * k + (Math.random() - 0.5) * 8;
      p.life = 0.95 + Math.random() * 0.35;
      p.size = 2.1 + Math.random() * 1.3;
      p.sprite = i % 3 === 0 ? v.c2 : v.c1;
      p.flick = Math.random() < crackle ? 1 : 0.25;
    }
  }

  draw() {
    if (!this.running || !this.g) return;
    const g = this.g, d = this.dpr;
    // хвосты: прошлый кадр не стираем целиком, а «гасим» (destination-out) — частицы оставляют след
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'destination-out';
    g.globalAlpha = 0.38;
    g.fillStyle = '#000';
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    g.globalCompositeOperation = 'lighter';
    for (const p of this.pool) {
      if (!p.on) continue;
      const k = p.age / p.life;
      let a = p.kind === 1 ? 1 : k < 0.08 ? k / 0.08 : 1 - Math.pow((k - 0.08) / 0.92, 1.6);
      // мерцание: на второй половине жизни часть искр «трещит»
      if (p.kind !== 1 && p.flick && k > 0.45) a *= 1 - p.flick * 0.75 * (Math.random() < 0.5 ? 1 : 0);
      if (a <= 0.01) continue;
      const s = p.size * (p.kind === 0 ? 2.6 - k : 2.4) * d;
      g.globalAlpha = a;
      g.drawImage(this.sprites[p.sprite], p.x * d - s, p.y * d - s, s * 2, s * 2);
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
  }
}

/** гравитация ракеты, px/с² */
const G_R = 520;

function hexA(hex: string, a: number) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

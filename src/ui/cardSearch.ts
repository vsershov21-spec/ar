/**
 * Детский поиск карты (feature 'intro.search'): вместо пунктирной рамки, кольца-спиннера и «Держи телефон ровно…»
 *   · лапки бегут по краю найденной карты — сколько лапок, столько прогресса посадки (FSM: progress 0..1);
 *   · над картой — плашка с весёлой подсказкой детским языком и звёздочка, которая наполняется;
 *   · ближе к посадке к краю карты слетаются искры; «нашёл!» — лапки вспыхивают, мягкий звон, дальше — пробуждение (src/awake);
 *   · «карта другого банка», «оборот», «не карта» — мягко, с юмором, серыми лапками, без оранжевого «ошибка».
 * Карту не перекрываем: лапки — по самому краю, плашка — над картой. Один холст, рисуем только пока есть что рисовать;
 * prefers-reduced-motion — без прыжков и искр.
 *
 * Логику трекера не трогаем: данные — те же вызовы FSM, что получает card/overlay.ts (guide / candidate / track / lost),
 * точка интеграции — app.ts wireCardSearch (обёртка методов оверлея; сухие кольцо и пунктир оверлея там выключены).
 */
import type { Hint, TrackState } from '../tracker/card/fsm';

type Pt = { x: number; y: number };
export type SearchKind = 'sber' | 'checking' | 'other' | 'back' | 'notcard';

/** подсказки ребёнку (детским языком, коротко — влезают в одну строку на 360 px) */
export const KID_HINT: Record<Exclude<Hint, null>, string> = {
  aim: 'Где карта? Покажи мне её!',
  closer: 'Ближе-ближе! Я плохо вижу',
  farther: 'Ой, близко! Чуть-чуть дальше',
  glare: 'Блик слепит! Наклони карту',
  steady: 'Замри… я почти выхожу!',
  checking: 'Нюх-нюх… это моя карта?',
  found: 'Нашёл! Выхожу!',
  other: 'Это не мой домик!',
  back: 'Это спинка карты',
  notcard: 'Хи-хи, это не карта',
};
/** вторая строка для мягких отказов */
const KID_SUB: Partial<Record<SearchKind, string>> = {
  other: 'Я живу в картах Сбера',
  back: 'Переверни — я с той стороны',
};
/** фразы нижней плашки, пока карты нет в кадре (меняются раз в 4 с) */
export const SEARCH_LINES = ['Где моя карта? Покажи её!', 'Положи карту на стол — я выгляну', 'Нюх-нюх… чую карту!'];

const PAWS = 14;
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export interface CardSearchHost {
  container: HTMLElement;
  sound(id: string, vol?: number): void;
}

export class CardSearch {
  readonly canvas = document.createElement('canvas');
  private g: CanvasRenderingContext2D;
  private dpr = Math.min(1.5, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
  private w = 1;
  private h = 1;
  private cand: { pts: Pt[]; at: number; kind: SearchKind } | null = null;
  private notCard: { pts: Pt[]; at: number } | null = null;
  private state: TrackState = 'search';
  private progress = 0;
  /** показываемый прогресс (догоняет настоящий плавно — без скачков) */
  private shownK = 0;
  private hint: Hint = 'aim';
  private catPlaced = false;
  private raf = 0;
  private last = 0;
  private lit = 0;
  private litAt: number[] = [];
  private sparks: { x: number; y: number; tx: number; ty: number; age: number; life: number; c: string }[] = [];
  private burst: { pts: Pt[]; age: number } | null = null;
  private wasEmpty = true;
  private paw: HTMLCanvasElement;
  private pawGrey: HTMLCanvasElement;

  constructor(private host: CardSearchHost) {
    const c = this.canvas;
    c.className = 'card-search';
    Object.assign(c.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '3' });
    host.container.appendChild(c);
    this.g = c.getContext('2d')!;
    this.paw = pawSprite('#ffffff', '#21A038');
    this.pawGrey = pawSprite('rgba(255,255,255,.7)', 'rgba(40,55,60,.45)');
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  private resize() {
    const r = this.host.container.getBoundingClientRect();
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.wasEmpty = false;
  }

  // ───────────── данные FSM (те же вызовы, что у card/overlay.ts) ─────────────
  guide(state: TrackState, progress: number, hint: Hint, catPlaced: boolean) {
    this.state = state;
    this.progress = Math.max(0, Math.min(1, progress));
    this.hint = hint;
    this.catPlaced = catPlaced;
    if (catPlaced) this.cand = this.notCard = null;
    this.kick();
  }
  candidate(pts: Pt[], kind: SearchKind, catPlaced: boolean) {
    if (catPlaced) return;
    const now = performance.now();
    if (kind === 'notcard') {
      this.cand = null;
      if (!this.notCard || now - this.notCard.at > 5000) this.notCard = { pts, at: now };
    } else this.cand = { pts, at: now, kind };
    this.kick();
  }
  /** карта захвачена; silent — кот уже стоял (повторная посадка тихая) */
  found(silent: boolean) {
    const c = this.cand;
    this.cand = null;
    this.shownK = 0;
    this.lit = 0;
    this.litAt = [];
    if (silent || !c || c.kind === 'other' || c.kind === 'back') return;
    this.burst = { pts: c.pts, age: 0 };
    this.host.sound('chime_soft', 0.8);
    this.kick();
  }
  lost() {
    this.cand = null;
    this.lit = 0;
    this.litAt = [];
  }

  private kick() {
    if (this.raf) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  private frame(t: number) {
    this.raf = 0;
    const dt = Math.min(0.05, (t - this.last) / 1000);
    this.last = t;
    const busy = this.draw(dt);
    if (busy) this.raf = requestAnimationFrame((tt) => this.frame(tt));
  }

  /** true — в следующем кадре есть что рисовать */
  private draw(dt: number): boolean {
    const g = this.g, now = performance.now();
    const c = this.cand && this.state === 'candidate' && now - this.cand.at < 700 && !this.catPlaced ? this.cand : null;
    const nc = this.notCard && now - this.notCard.at < 1800 && !this.catPlaced ? this.notCard : null;
    const busy = !!(c || nc || this.burst || this.sparks.length);
    if (!busy && this.wasEmpty) return false;
    this.wasEmpty = !busy;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    const calm = reduced();
    if (c) {
      const age = now - c.at;
      const fade = age < 300 ? 1 : 1 - (age - 300) / 400;
      const good = c.kind === 'sber' || c.kind === 'checking';
      // прогресс — плавно и только вперёд, пока карта та же (FSM может чуть откатить на плохом кадре)
      const target = good ? this.progress : 0;
      this.shownK += (target - this.shownK) * Math.min(1, dt * 6);
      g.save();
      g.globalAlpha = Math.max(0, fade);
      this.drawPaws(c.pts, good ? this.shownK : 0.35, good, calm, now);
      if (good && this.shownK > 0.55 && !calm) this.spawnSparks(c.pts, dt);
      const hint = !good ? (c.kind as Exclude<Hint, null>) : this.hint && this.hint !== 'aim' ? this.hint : c.kind === 'checking' ? 'checking' : 'steady';
      this.pill(c.pts, KID_HINT[hint], good ? null : KID_SUB[c.kind] ?? null, good ? this.shownK : -1, good ? '#157a2c' : '#4b5b63');
      g.restore();
    } else this.shownK = Math.max(0, this.shownK - dt);
    if (nc) {
      const age = now - nc.at;
      g.save();
      g.globalAlpha = age < 200 ? age / 200 : age > 1400 ? Math.max(0, (1800 - age) / 400) : 1;
      this.pill(nc.pts, KID_HINT.notcard, null, -1, '#4b5b63');
      g.restore();
    }
    this.drawSparks(dt);
    this.drawBurst(dt, calm);
    return true;
  }

  /** лапки по периметру карты: пройденные — яркие и «прыгают» при появлении, остальные — бледный след */
  private drawPaws(pts: Pt[], k: number, good: boolean, calm: boolean, now: number) {
    const g = this.g;
    const per = perimeter(pts);
    const n = Math.round(k * PAWS);
    if (good) for (let i = this.lit; i < n; i++) this.litAt[i] = now;
    if (good) this.lit = Math.max(this.lit, n);
    const size = Math.max(20, Math.min(32, per.len / 28));
    for (let i = 0; i < PAWS; i++) {
      // шаг по кругу от верхнего левого угла; лапки чередуются чуть внутрь/наружу — «следы»
      const p = per.at((i + 0.5) / PAWS);
      const off = (i % 2 ? 1 : -1) * size * 0.28;
      const x = p.x + p.nx * (size * 0.55 + off), y = p.y + p.ny * (size * 0.55 + off);
      const on = i < n;
      // только что «наступили» — лапка подпрыгивает (0,25 с)
      const pop = on && !calm ? 1 + 0.4 * Math.max(0, 1 - (now - (this.litAt[i] ?? 0)) / 250) : 1;
      g.save();
      g.translate(x, y);
      g.rotate(p.a + Math.PI / 2);
      g.globalAlpha *= on ? 1 : good ? 0.4 : 0.6;
      const s = size * pop;
      g.drawImage(on ? this.paw : this.pawGrey, -s / 2, -s / 2, s, s);
      g.restore();
    }
  }

  private spawnSparks(pts: Pt[], dt: number) {
    if (this.sparks.length > 40 || Math.random() > dt * 22) return;
    const per = perimeter(pts);
    const p = per.at(Math.random());
    const a = Math.random() * Math.PI * 2, r = 60 + Math.random() * 90;
    this.sparks.push({ x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r, tx: p.x, ty: p.y, age: 0, life: 0.7 + Math.random() * 0.4, c: Math.random() < 0.5 ? '#FFE27A' : '#ffffff' });
  }
  private drawSparks(dt: number) {
    if (!this.sparks.length) return;
    const g = this.g;
    this.sparks = this.sparks.filter((s) => (s.age += dt) < s.life);
    for (const s of this.sparks) {
      const k = s.age / s.life, e = 1 - Math.pow(1 - k, 2);
      const x = s.x + (s.tx - s.x) * e, y = s.y + (s.ty - s.y) * e;
      g.save();
      g.globalAlpha = k < 0.2 ? k / 0.2 : 1 - (k - 0.2) / 0.8;
      g.translate(x, y);
      g.rotate(k * 3);
      g.fillStyle = s.c;
      star(g, 4 + 3 * (1 - k));
      g.fill();
      g.restore();
    }
  }
  /** «нашёл!»: лапки вспыхивают и разбегаются от карты */
  private drawBurst(dt: number, calm: boolean) {
    const b = this.burst;
    if (!b) return;
    b.age += dt;
    const k = b.age / 0.7;
    if (k >= 1) {
      this.burst = null;
      return;
    }
    const g = this.g, per = perimeter(b.pts);
    const cx = b.pts.reduce((s, p) => s + p.x, 0) / b.pts.length, cy = b.pts.reduce((s, p) => s + p.y, 0) / b.pts.length;
    g.save();
    g.globalAlpha = 1 - k;
    for (let i = 0; i < PAWS; i++) {
      const p = per.at((i + 0.5) / PAWS);
      const out = calm ? 0 : k * 40;
      const dx = p.x - cx, dy = p.y - cy, d = Math.hypot(dx, dy) || 1;
      const s = Math.max(20, Math.min(32, per.len / 28)) * (1 + (calm ? 0 : k * 0.5));
      g.save();
      g.translate(p.x + (dx / d) * out, p.y + (dy / d) * out);
      g.rotate(p.a + Math.PI / 2);
      g.drawImage(this.paw, -s / 2, -s / 2, s, s);
      g.restore();
    }
    g.restore();
  }

  /** плашка над картой (не на ней): звёздочка-прогресс + подсказка; если сверху некуда — под картой */
  private pill(pts: Pt[], text: string, sub: string | null, k: number, color: string) {
    const g = this.g;
    g.font = '800 16px "SB Sans Text", system-ui, sans-serif';
    const subW = sub ? (g.font = '600 13px "SB Sans Text", system-ui, sans-serif', g.measureText(sub).width) : 0;
    g.font = '800 16px "SB Sans Text", system-ui, sans-serif';
    const tw = Math.max(g.measureText(text).width, subW);
    const star = k >= 0 ? 30 : 0;
    const wdt = tw + 32 + star, hgt = sub ? 50 : 40;
    const cx0 = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const top = Math.min(...pts.map((p) => p.y)), bot = Math.max(...pts.map((p) => p.y));
    let y0 = top - 14 - hgt;
    if (y0 < 70) y0 = Math.min(this.h - 170 - hgt, bot + 14);
    const x0 = Math.max(10, Math.min(this.w - 10 - wdt, cx0 - wdt / 2));
    g.save();
    g.fillStyle = 'rgba(0,0,0,.14)';
    g.beginPath();
    g.roundRect(x0, y0 + 3, wdt, hgt, hgt / 2);
    g.fill();
    g.fillStyle = '#fff';
    g.beginPath();
    g.roundRect(x0, y0, wdt, hgt, hgt / 2);
    g.fill();
    if (star) {
      const sx = x0 + 14 + 12, sy = y0 + hgt / 2;
      g.translate(sx, sy);
      g.fillStyle = '#e4ece7';
      starPath(g, 13);
      g.fill();
      // наполнение звёздочки снизу вверх
      g.save();
      starPath(g, 13);
      g.clip();
      g.fillStyle = '#FFC93C';
      g.fillRect(-14, 14 - 28 * k, 28, 28 * k);
      g.restore();
      g.strokeStyle = '#E3A400';
      g.lineWidth = 1.5;
      starPath(g, 13);
      g.stroke();
      g.translate(-sx, -sy);
    }
    g.fillStyle = color;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillText(text, x0 + 16 + star, y0 + (sub ? 17 : hgt / 2 + 1));
    if (sub) {
      g.font = '600 13px "SB Sans Text", system-ui, sans-serif';
      g.fillStyle = '#5b6670';
      g.fillText(sub, x0 + 16 + star, y0 + 36);
    }
    g.restore();
  }
}

// ───────────── геометрия и спрайты ─────────────

/** периметр четырёхугольника: точка, направление и нормаль наружу по доле длины */
function perimeter(pts: Pt[]) {
  const segs: { a: Pt; b: Pt; len: number }[] = [];
  let len = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    segs.push({ a, b, len: l });
    len += l;
  }
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length, cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  return {
    len,
    at(t: number) {
      let d = (((t % 1) + 1) % 1) * len;
      for (const s of segs) {
        if (d <= s.len || s === segs[segs.length - 1]) {
          const u = s.len ? Math.min(1, d / s.len) : 0;
          const x = s.a.x + (s.b.x - s.a.x) * u, y = s.a.y + (s.b.y - s.a.y) * u;
          const a = Math.atan2(s.b.y - s.a.y, s.b.x - s.a.x);
          let nx = Math.sin(a), ny = -Math.cos(a);
          // нормаль — от центра карты наружу
          if ((x - cx) * nx + (y - cy) * ny < 0) (nx = -nx), (ny = -ny);
          return { x, y, a, nx, ny };
        }
        d -= s.len;
      }
      return { x: cx, y: cy, a: 0, nx: 0, ny: -1 };
    },
  };
}

/** лапка: подушечка и 4 пальчика с белой обводкой (видно и на светлом столе, и на тёмном) */
function pawSprite(fill: string, stroke: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const blobs: [number, number, number, number][] = [[32, 40, 13, 11], [15, 25, 6, 7.5], [25, 15, 6, 7.5], [39, 15, 6, 7.5], [49, 25, 6, 7.5]];
  for (const pass of [0, 1]) {
    g.fillStyle = pass ? fill : stroke;
    for (const [x, y, rx, ry] of blobs) {
      g.beginPath();
      g.ellipse(x, y, rx + (pass ? 0 : 3), ry + (pass ? 0 : 3), 0, 0, Math.PI * 2);
      g.fill();
    }
  }
  return c;
}

function star(g: CanvasRenderingContext2D, r: number) {
  g.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4, k = i % 2 ? r * 0.35 : r;
    g.lineTo(Math.cos(a) * k, Math.sin(a) * k);
  }
  g.closePath();
}
function starPath(g: CanvasRenderingContext2D, r: number) {
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5, k = i % 2 ? r * 0.45 : r;
    g.lineTo(Math.cos(a) * k, Math.sin(a) * k);
  }
  g.closePath();
}

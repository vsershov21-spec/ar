/**
 * Рамка карты, которая не висит на экране статично: пока карты нет — ничего (только подсказка снизу),
 * карта нашлась — контур «прилетает» из центра экрана и прилипает к реальным углам карты (со скруглениями
 * и перспективой), светится зелёным, подпись «Нашёл карту!», потом растворяется — на карте уже кот.
 * Карта ушла из кадра — контур гаснет; вернулась — всё повторяется.
 */
import { roundedCardOutline, type Pt } from './geometry';
import type { CardView } from '../cardTracker';

type State = 'search' | 'snap' | 'glow' | 'locked';

const MODEL = roundedCardOutline(85.6 / 53.98, 3.18 / 85.6, 6);
const SNAP_S = 0.38;
const GLOW_S = 1.1;
const FADE_S = 0.7;

export class CardOverlay {
  readonly canvas = document.createElement('canvas');
  private g: CanvasRenderingContext2D;
  private state: State = 'search';
  private t = 0;
  private w = 1;
  private h = 1;
  private dpr = Math.min(2, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
  private view: CardView | null = null;
  private from: Pt[] = [];
  private shown = 0;
  /** «сюрприз»: вспышка и искры из карты в момент, когда она найдена */
  private sparks: { x: number; y: number; vx: number; vy: number; life: number; age: number; size: number; color: string; rot: number; vr: number }[] = [];
  private flash: { x: number; y: number; r: number; age: number } | null = null;
  /** колбэк «карта захвачена» (после анимации прилипания) */
  onLocked: (() => void) | null = null;

  constructor(container: HTMLElement) {
    this.canvas.className = 'card-overlay';
    Object.assign(this.canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '3' });
    container.appendChild(this.canvas);
    this.g = this.canvas.getContext('2d')!;
  }

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
  }

  /** детектор видит карту (уже подтверждённую трекером) */
  track(v: CardView) {
    this.view = v;
    // карта вернулась через пару секунд — без повторной анимации «нашёл» и искр, кот просто стоит дальше
    if (this.state === 'search' && performance.now() - this.lostAt < 5000) {
      this.state = 'locked';
      this.t = FADE_S;
      return;
    }
    if (this.state === 'search') {
      this.state = 'snap';
      this.t = 0;
      this.from = this.guide();
    }
  }

  private lostAt = -1e9;
  lost() {
    if (this.state !== 'search') this.lostAt = performance.now();
    this.view = null;
    if (this.state !== 'search') {
      this.state = 'search';
      this.t = 0;
    }
  }

  hide(_immediate = false) {
    this.view = null;
    this.state = 'search';
    this.shown = 0;
    this.g.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** контур-«прицел» по центру экрана, откуда прилетает рамка */
  private guide(): Pt[] {
    const W = Math.min(this.w * 0.74, 340);
    const cx = this.w / 2, cy = this.h * 0.46;
    return MODEL.map((p) => ({ x: cx + p.x * W, y: cy - p.y * W }));
  }

  private outline(): Pt[] | null {
    const v = this.view;
    if (!v) return null;
    const pts: Pt[] = [];
    for (const p of MODEL) {
      const s = v.project(p.x, p.y);
      if (!s) return null;
      pts.push(s);
    }
    return pts;
  }

  private burst(o: Pt[]) {
    const cx = o.reduce((s, p) => s + p.x, 0) / o.length, cy = o.reduce((s, p) => s + p.y, 0) / o.length;
    const r = Math.max(...o.map((p) => Math.hypot(p.x - cx, p.y - cy)));
    this.flash = { x: cx, y: cy, r, age: 0 };
    for (let i = 0; i < 46; i++) {
      // искры вылетают с краёв карты вверх и в стороны — «оттуда кто-то выходит»
      const e = o[Math.floor(Math.random() * o.length)];
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.4;
      const sp = 140 + Math.random() * 320;
      this.sparks.push({ x: e.x + (cx - e.x) * Math.random() * 0.6, y: e.y + (cy - e.y) * Math.random() * 0.6, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0.9 + Math.random() * 0.8, age: 0, size: 4 + Math.random() * 9, color: SPARK_COLORS[i % SPARK_COLORS.length], rot: Math.random() * 6, vr: (Math.random() - 0.5) * 8 });
    }
  }

  private drawBurst(dt: number) {
    const g = this.g;
    const f = this.flash;
    if (f) {
      f.age += dt;
      const k = f.age / 0.9;
      if (k >= 1) this.flash = null;
      else {
        // свет из карты: мягкое сияние + расходящееся кольцо
        g.save();
        const glow = g.createRadialGradient(f.x, f.y, 0, f.x, f.y, f.r * (1.2 + k));
        glow.addColorStop(0, `rgba(255,255,230,${0.55 * (1 - k)})`);
        glow.addColorStop(0.5, `rgba(181,227,106,${0.3 * (1 - k)})`);
        glow.addColorStop(1, 'rgba(181,227,106,0)');
        g.fillStyle = glow;
        g.fillRect(f.x - f.r * 3, f.y - f.r * 3, f.r * 6, f.r * 6);
        g.globalAlpha = 1 - k;
        g.strokeStyle = '#fff';
        g.lineWidth = 3 * (1 - k) + 1;
        g.beginPath();
        g.ellipse(f.x, f.y, f.r * (0.6 + k * 1.6), f.r * (0.35 + k * 0.9), 0, 0, Math.PI * 2);
        g.stroke();
        g.restore();
      }
    }
    if (!this.sparks.length) return;
    g.save();
    this.sparks = this.sparks.filter((p) => (p.age += dt) < p.life);
    for (const p of this.sparks) {
      p.vy += 420 * dt;
      p.vx *= 1 - 1.2 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      const k = p.age / p.life;
      g.globalAlpha = k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85;
      g.setTransform(this.dpr, 0, 0, this.dpr, p.x * this.dpr, p.y * this.dpr);
      g.rotate(p.rot);
      g.shadowColor = p.color;
      g.shadowBlur = 8;
      g.fillStyle = p.color;
      star(g, p.size * (1 - k * 0.4));
      g.fill();
    }
    g.restore();
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  update(dt: number) {
    this.t += dt;
    const g = this.g;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    if (this.state === 'snap' && this.t >= SNAP_S) {
      this.state = 'glow';
      this.t = 0;
      const o = this.outline();
      if (o) this.burst(o);
      this.onLocked?.();
    } else if (this.state === 'glow' && this.t >= GLOW_S) {
      this.state = 'locked';
      this.t = 0;
    }
    this.drawBurst(dt);
    let alpha = 0;
    let pts = this.outline();
    if (this.state === 'snap' && pts) {
      const k = ease(Math.min(1, this.t / SNAP_S));
      pts = pts.map((p, i) => ({ x: this.from[i].x + (p.x - this.from[i].x) * k, y: this.from[i].y + (p.y - this.from[i].y) * k }));
      alpha = 0.35 + 0.65 * k;
    } else if (this.state === 'glow') alpha = 1;
    else if (this.state === 'locked') alpha = Math.max(0, 1 - this.t / FADE_S);
    else alpha = Math.max(0, this.shown - dt * 4);
    this.shown = alpha;
    if (!pts || alpha <= 0.01) return;
    const pulse = this.state === 'glow' ? 0.5 + 0.5 * Math.sin(this.t * 9) : 0;
    // свечение
    g.save();
    g.globalAlpha = alpha;
    g.lineJoin = 'round';
    g.shadowColor = 'rgba(181, 227, 106, 0.95)';
    g.shadowBlur = 18 + 14 * pulse;
    g.strokeStyle = '#B5E36A';
    g.lineWidth = 4 + 2 * pulse;
    path(g, pts);
    g.stroke();
    g.shadowBlur = 0;
    g.strokeStyle = '#21A038';
    g.lineWidth = 2;
    path(g, pts);
    g.stroke();
    // лёгкая заливка — карта «подсвечена»
    g.globalAlpha = alpha * (this.state === 'glow' ? 0.16 + 0.1 * pulse : 0.08);
    g.fillStyle = '#B5E36A';
    path(g, pts);
    g.fill();
    // подпись над картой
    if (this.state === 'glow' || (this.state === 'locked' && alpha > 0.05)) {
      const top = pts.reduce((a, p) => (p.y < a.y ? p : a), pts[0]);
      const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      const y = Math.max(28, top.y - 22);
      const text = 'Ого, вот она!';
      g.globalAlpha = alpha;
      g.font = '800 15px "SB Sans Text", system-ui, sans-serif';
      const tw = g.measureText(text).width;
      g.fillStyle = '#c5d6cc';
      g.beginPath();
      g.roundRect(cx - tw / 2 - 16, y - 15 + 4, tw + 32, 32, 16);
      g.fill();
      g.fillStyle = '#fff';
      g.beginPath();
      g.roundRect(cx - tw / 2 - 16, y - 15, tw + 32, 32, 16);
      g.fill();
      g.fillStyle = '#157a2c';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(text, cx, y + 1);
    }
    g.restore();
  }
}

const SPARK_COLORS = ['#ffffff', '#B5E36A', '#FFE27A', '#7EE2A8', '#ffffff'];

function star(g: CanvasRenderingContext2D, r: number) {
  g.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4, k = i % 2 ? r * 0.32 : r;
    g.lineTo(Math.cos(a) * k, Math.sin(a) * k);
  }
  g.closePath();
}

function path(g: CanvasRenderingContext2D, pts: Pt[]) {
  g.beginPath();
  g.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
  g.closePath();
}
const ease = (k: number) => 1 - Math.pow(1 - k, 3);

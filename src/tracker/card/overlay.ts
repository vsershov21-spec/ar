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
    if (this.state === 'search') {
      this.state = 'snap';
      this.t = 0;
      this.from = this.guide();
    }
  }

  lost() {
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

  update(dt: number) {
    this.t += dt;
    const g = this.g;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    if (this.state === 'snap' && this.t >= SNAP_S) {
      this.state = 'glow';
      this.t = 0;
      this.onLocked?.();
    } else if (this.state === 'glow' && this.t >= GLOW_S) {
      this.state = 'locked';
      this.t = 0;
    }
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
      const text = 'Нашёл карту!';
      g.globalAlpha = alpha;
      g.font = '600 15px "SB Sans Text", system-ui, sans-serif';
      const tw = g.measureText(text).width;
      g.fillStyle = 'rgba(11, 94, 107, 0.86)';
      g.beginPath();
      g.roundRect(cx - tw / 2 - 14, y - 15, tw + 28, 30, 15);
      g.fill();
      g.fillStyle = '#fff';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(text, cx, y + 1);
    }
    g.restore();
  }
}

function path(g: CanvasRenderingContext2D, pts: Pt[]) {
  g.beginPath();
  g.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
  g.closePath();
}
const ease = (k: number) => 1 - Math.pow(1 - k, 3);

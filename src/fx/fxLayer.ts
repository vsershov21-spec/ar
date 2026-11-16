/**
 * 2D-слой эффектов поверх камеры («стекло» телефона). Canvas 2D, без зависимостей:
 * PixiJS добавил бы ~450 КБ и второй WebGL-контекст рядом с three.js и tfjs (MindAR),
 * а на iPhone число/память WebGL-контекстов — узкое место. Наши эффекты — сотни частиц
 * и несколько градиентов: Canvas 2D на A13+ держит это в 60 fps. DPR ограничен 2.
 */
import type { StickerSpec } from '../persona/types';
import { renderSticker } from './stickers';
import { clamp, easeOutBack, rand } from '../core/util';

type Palette = { primary: string; secondary: string; accent: string; fx: string[] };

interface Particle {
  x: number; y: number; vx: number; vy: number; age: number; life: number; size: number;
  color: string; kind: 'spark' | 'dot' | 'flake' | 'shred' | 'ring'; rot: number; vr: number; g: number; drag: number;
}
interface Scratch { pts: { x: number; y: number }[]; age: number; life: number }
interface Splat { x: number; y: number; r: number; blobs: { a: number; d: number; r: number }[]; drips: { x: number; len: number; speed: number }[]; age: number; life: number; color: string }
export interface Sticker {
  id: number; x: number; y: number; size: number; rot: number; spec: StickerSpec;
  face: HTMLCanvasElement; back: HTMLCanvasElement;
  age: number; peel: number; peelCorner: { x: number; y: number } | null;
  flying: boolean; vx: number; vy: number; vr: number; alpha: number;
  choice?: string; label?: string; slapT: number;
}

export class FxLayer {
  readonly canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  w = 0;
  h = 0;
  private dpr = 1;
  private parts: Particle[] = [];
  private scratches: Scratch[] = [];
  private splats: Splat[] = [];
  stickers: Sticker[] = [];
  private stickerId = 0;
  private bubble: { x: number; y: number; r: number; R: number; t: number; phase: 'grow' | 'hold' | 'pop'; color: string; resolve: () => void } | null = null;
  private glitchT = 0;
  private glitchDur = 0;
  private fog: HTMLCanvasElement;
  private fg: CanvasRenderingContext2D;
  private fogAlpha = 0;
  private fogState: 'off' | 'in' | 'draw' | 'hold' | 'out' = 'off';
  private fogT = 0;
  private heart: { pts: { x: number; y: number }[]; drawn: number; resolve: () => void } | null = null;
  private glassCat: { img: HTMLImageElement; t: number; dur: number } | null = null;
  private trails: { pts: { x: number; y: number }[]; age: number; color: string }[] = [];
  private peeling: Sticker | null = null;
  private peelStart = { x: 0, y: 0 };
  onGlitch: (on: boolean) => void = () => {};
  onSlap: () => void = () => {};
  palette: Palette = { primary: '#111', secondary: '#B6FF3B', accent: '#FF6FB5', fx: ['#fff'] };

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'fx-layer';
    parent.appendChild(this.canvas);
    this.g = this.canvas.getContext('2d')!;
    this.fog = document.createElement('canvas');
    this.fg = this.fog.getContext('2d')!;
  }

  resize(w: number, h: number) {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = w;
    this.h = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    // туман считаем в половинном разрешении — он мягкий
    this.fog.width = Math.max(1, Math.round(w / 2));
    this.fog.height = Math.max(1, Math.round(h / 2));
  }

  get busy() {
    return !!this.bubble || this.fogState !== 'off' || !!this.glassCat;
  }

  // ───────────── частицы ─────────────
  private add(p: Partial<Particle> & { x: number; y: number }) {
    if (this.parts.length > 700) this.parts.shift();
    this.parts.push({ vx: 0, vy: 0, age: 0, life: 1, size: 6, color: '#fff', kind: 'spark', rot: rand(0, 6), vr: rand(-4, 4), g: 0, drag: 0.98, ...p });
  }

  burst(x: number, y: number, colors = this.palette.fx, n = 36) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, Math.PI * 2), sp = rand(80, 520);
      this.add({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 120, life: rand(0.6, 1.3), size: rand(4, 11), color: colors[i % colors.length], kind: i % 3 ? 'spark' : 'dot', g: 500, drag: 0.94 });
    }
  }

  trail(path: { x: number; y: number }[], colors = this.palette.fx) {
    this.trails.push({ pts: path.map((p) => ({ x: p.x, y: p.y })), age: 0, color: colors[0] });
    path.forEach((p, i) => {
      for (let k = 0; k < 3; k++)
        this.add({ x: p.x + rand(-8, 8), y: p.y + rand(-8, 8), vx: rand(-40, 40), vy: rand(-60, 20), life: rand(0.5, 1.2) + i * 0.01, size: rand(3, 9), color: colors[(i + k) % colors.length], kind: 'spark', g: 60, drag: 0.97 });
    });
  }

  snowGlobe(colors = this.palette.fx) {
    for (let i = 0; i < 240; i++)
      this.add({ x: rand(0, this.w), y: rand(-this.h * 0.3, this.h), vx: rand(-90, 90), vy: rand(-200, 60), life: rand(2.2, 4), size: rand(3, 9), color: colors[i % colors.length], kind: i % 2 ? 'flake' : 'spark', g: 70, drag: 0.985 });
  }

  knock(x: number, y: number) {
    for (let i = 0; i < 2; i++) this.add({ x, y, life: 0.5 + i * 0.15, size: 18 + i * 10, color: 'rgba(255,255,255,0.9)', kind: 'ring', vr: 0 });
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      this.add({ x, y, vx: Math.cos(a) * 160, vy: Math.sin(a) * 160, life: 0.35, size: 4, color: '#fff', kind: 'dot', drag: 0.9 });
    }
  }

  // ───────────── когти ─────────────
  claws(from: { x: number; y: number }, to: { x: number; y: number }) {
    const dx = to.x - from.x, dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const L = Math.max(len, Math.min(this.w, this.h) * 0.45);
    const ux = dx / len, uy = dy / len;
    const cx = (from.x + to.x) / 2, cy = (from.y + to.y) / 2;
    for (let k = -1.5; k <= 1.5; k++) {
      const off = k * 26;
      const pts: { x: number; y: number }[] = [];
      const steps = 14;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps - 0.5;
        const j = i === 0 || i === steps ? 0 : rand(-3, 3);
        pts.push({ x: cx + ux * L * t + nx * (off + j) + nx * Math.sin(t * 3) * 10, y: cy + uy * L * t + ny * (off + j) + ny * Math.sin(t * 3) * 10 });
      }
      this.scratches.push({ pts, age: -Math.abs(k) * 0.03, life: 2 });
    }
  }

  // ───────────── пузырь жвачки ─────────────
  gumBubble(x: number, y: number, color = '#FF6FB5'): Promise<void> {
    return new Promise((resolve) => {
      this.bubble = { x, y, r: 6, R: Math.hypot(this.w, this.h) * 0.62, t: 0, phase: 'grow', color, resolve };
    });
  }

  private popBubble() {
    const b = this.bubble!;
    // ошмётки + «заляпывание» стекла
    for (let i = 0; i < 40; i++) {
      const a = rand(0, Math.PI * 2), sp = rand(300, 1100);
      this.add({ x: b.x + Math.cos(a) * b.r * 0.4, y: b.y + Math.sin(a) * b.r * 0.4, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(0.4, 0.9), size: rand(10, 26), color: b.color, kind: 'shred', g: 300, drag: 0.9 });
    }
    const n = 9;
    for (let i = 0; i < n; i++) {
      const edge = i < 6;
      const a = (i / 6) * Math.PI * 2 + rand(-0.3, 0.3);
      const x = edge ? this.w / 2 + Math.cos(a) * this.w * rand(0.42, 0.55) : rand(this.w * 0.2, this.w * 0.8);
      const y = edge ? this.h / 2 + Math.sin(a) * this.h * rand(0.38, 0.5) : rand(this.h * 0.2, this.h * 0.8);
      const r = edge ? rand(55, 110) : rand(25, 55);
      this.splats.push({
        x, y, r, age: 0, life: rand(3.2, 4.2), color: b.color,
        blobs: Array.from({ length: 7 }, () => ({ a: rand(0, Math.PI * 2), d: rand(0.4, 1.0), r: rand(0.25, 0.55) })),
        drips: Array.from({ length: 2 + Math.floor(rand(0, 3)) }, () => ({ x: rand(-0.6, 0.6), len: 0, speed: rand(8, 26) })),
      });
    }
    this.onGlitch(false);
  }

  // ───────────── глитч ─────────────
  glitch(ms = 500) {
    this.glitchT = 0;
    this.glitchDur = ms / 1000;
    this.onGlitch(true);
  }

  // ───────────── пар на стекле + сердечко ─────────────
  steamHeart(): Promise<void> {
    return new Promise((resolve) => {
      const W = this.fog.width, H = this.fog.height;
      this.fg.clearRect(0, 0, W, H);
      this.fogAlpha = 0;
      this.fogState = 'in';
      this.fogT = 0;
      const cx = W / 2, cy = H * 0.5, s = Math.min(W, H) * 0.28;
      const pts: { x: number; y: number }[] = [];
      for (let i = 0; i <= 80; i++) {
        const t = (i / 80) * Math.PI * 2;
        // параметрическое сердце
        const x = 16 * Math.pow(Math.sin(t), 3);
        const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
        pts.push({ x: cx + (x / 17) * s, y: cy + (y / 17) * s });
      }
      this.heart = { pts, drawn: 0, resolve };
    });
  }

  private paintFog() {
    const W = this.fog.width, H = this.fog.height;
    const g = this.fg;
    g.globalCompositeOperation = 'source-over';
    for (let i = 0; i < 6; i++) {
      const x = rand(0, W), y = rand(H * 0.1, H * 0.95), r = rand(W * 0.2, W * 0.5);
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, 'rgba(235,242,248,0.34)');
      grd.addColorStop(1, 'rgba(235,242,248,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, W, H);
    }
  }

  /** стереть туман пальцем (screen px) */
  wipeFog(x: number, y: number, px?: number, py?: number) {
    if (this.fogState === 'off') return false;
    const g = this.fg;
    g.globalCompositeOperation = 'destination-out';
    g.lineCap = 'round';
    g.lineWidth = 16;
    g.strokeStyle = 'rgba(0,0,0,0.9)';
    g.beginPath();
    g.moveTo((px ?? x) / 2, (py ?? y) / 2);
    g.lineTo(x / 2 + 0.01, y / 2);
    g.stroke();
    g.globalCompositeOperation = 'source-over';
    if (this.fogState === 'hold') this.fogT = Math.min(this.fogT, 1); // пока рисуют — не тает
    return true;
  }

  get fogActive() {
    return this.fogState !== 'off';
  }

  // ───────────── кот у стекла ─────────────
  glassCatShow(img: HTMLImageElement, ms = 2600) {
    this.glassCat = { img, t: 0, dur: ms / 1000 };
  }

  // ───────────── наклейки ─────────────
  addSticker(spec: StickerSpec, x: number, y: number, opts: { size?: number; rot?: number; mirrored?: boolean; choice?: string; label?: string; palette?: Palette } = {}): Sticker {
    const size = opts.size ?? Math.min(this.w, this.h) * rand(0.22, 0.3);
    const px = Math.round(size * this.dpr);
    const { face, back } = renderSticker(spec, px, opts.palette ?? this.palette, opts.mirrored ?? true);
    const st: Sticker = {
      id: ++this.stickerId, x, y, size, rot: opts.rot ?? rand(-0.35, 0.35), spec, face, back, age: 0, peel: 0, peelCorner: null,
      flying: false, vx: 0, vy: 0, vr: 0, alpha: 1, choice: opts.choice, label: opts.label, slapT: 0,
    };
    this.stickers.push(st);
    this.onSlap();
    return st;
  }

  /** заклеить экран наклейками за ms */
  async cover(specs: StickerSpec[], palette: Palette, ms = 3200): Promise<void> {
    const n = 15;
    const cols = 3, rows = 5;
    const cells = Array.from({ length: cols * rows }, (_, i) => i).sort(() => Math.random() - 0.5);
    for (let i = 0; i < n; i++) {
      const c = cells[i % cells.length];
      const cx = ((c % cols) + 0.5) / cols, cy = (Math.floor(c / cols) + 0.5) / rows;
      this.addSticker(specs[i % specs.length], cx * this.w + rand(-30, 30), cy * this.h + rand(-30, 30), { size: Math.max(this.w, this.h) * rand(0.24, 0.32), palette });
      await new Promise((r) => setTimeout(r, ms / n));
    }
  }

  blowStickers() {
    for (const s of this.stickers) {
      const dx = s.x - this.w / 2, dy = s.y - this.h / 2;
      const d = Math.hypot(dx, dy) || 1;
      s.flying = true;
      s.vx = (dx / d) * rand(900, 1600);
      s.vy = (dy / d) * rand(900, 1600) - 300;
      s.vr = rand(-8, 8);
    }
  }

  clearStickers() {
    this.stickers = [];
  }

  stickerAt(x: number, y: number): Sticker | null {
    for (let i = this.stickers.length - 1; i >= 0; i--) {
      const s = this.stickers[i];
      if (s.flying) continue;
      const c = Math.cos(-s.rot), sn = Math.sin(-s.rot);
      const lx = (x - s.x) * c - (y - s.y) * sn, ly = (x - s.x) * sn + (y - s.y) * c;
      if (Math.abs(lx) < s.size * 0.48 && Math.abs(ly) < s.size * 0.48) return s;
    }
    return null;
  }

  /** начать отклеивание: палец у угла наклейки (в пределах 35% от угла) */
  beginPeel(x: number, y: number): boolean {
    const s = this.stickerAt(x, y);
    if (!s || s.choice) return false;
    const c = Math.cos(-s.rot), sn = Math.sin(-s.rot);
    const lx = (x - s.x) * c - (y - s.y) * sn, ly = (x - s.x) * sn + (y - s.y) * c;
    const h = s.size / 2;
    if (Math.abs(lx) < h * 0.3 || Math.abs(ly) < h * 0.3) return false; // не угол
    s.peelCorner = { x: Math.sign(lx) * h, y: Math.sign(ly) * h };
    this.peeling = s;
    this.peelStart = { x, y };
    return true;
  }

  dragPeel(x: number, y: number) {
    const s = this.peeling;
    if (!s || !s.peelCorner) return;
    const c = Math.cos(-s.rot), sn = Math.sin(-s.rot);
    const dx = x - this.peelStart.x, dy = y - this.peelStart.y;
    const lx = dx * c - dy * sn, ly = dx * sn + dy * c;
    const d = norm(-s.peelCorner.x, -s.peelCorner.y);
    const along = lx * d.x + ly * d.y;
    s.peel = clamp(along / (s.size * 1.2), 0, 1);
  }

  /** true — наклейку сорвали */
  endPeel(vx = 0, vy = 0): boolean {
    const s = this.peeling;
    this.peeling = null;
    if (!s) return false;
    if (s.peel > 0.35) {
      s.flying = true;
      s.vx = vx || rand(-600, 600);
      s.vy = vy || -800;
      s.vr = rand(-6, 6);
      return true;
    }
    s.peel = 0;
    s.peelCorner = null;
    return false;
  }

  get isPeeling() {
    return !!this.peeling;
  }

  // ───────────── цикл ─────────────
  update(dt: number) {
    dt = Math.min(dt, 0.05);
    for (const p of this.parts) {
      p.age += dt;
      p.vx *= Math.pow(p.drag, dt * 60);
      p.vy = p.vy * Math.pow(p.drag, dt * 60) + p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      if (p.kind === 'flake') p.vx += Math.sin(p.age * 3 + p.rot) * 30 * dt;
    }
    this.parts = this.parts.filter((p) => p.age < p.life);
    this.scratches.forEach((s) => (s.age += dt));
    this.scratches = this.scratches.filter((s) => s.age < s.life);
    this.trails.forEach((t) => (t.age += dt));
    this.trails = this.trails.filter((t) => t.age < 1);
    for (const s of this.splats) {
      s.age += dt;
      s.drips.forEach((d) => (d.len = Math.min(2.2, d.len + (d.speed * dt) / s.r)));
    }
    this.splats = this.splats.filter((s) => s.age < s.life);

    const b = this.bubble;
    if (b) {
      b.t += dt;
      if (b.phase === 'grow') {
        const k = clamp(b.t / 1.5, 0, 1);
        b.r = 6 + (b.R - 6) * (k * k * (3 - 2 * k));
        // центр пузыря уходит к центру экрана
        b.x += (this.w / 2 - b.x) * dt * 1.5;
        b.y += (this.h / 2 - b.y) * dt * 1.5;
        if (k >= 1) {
          b.phase = 'hold';
          b.t = 0;
        }
      } else if (b.phase === 'hold' && b.t > 0.35) {
        b.phase = 'pop';
        this.popBubble();
        const r = b.resolve;
        this.bubble = null;
        r();
      }
    }

    if (this.glitchDur > 0) {
      this.glitchT += dt;
      if (this.glitchT >= this.glitchDur) {
        this.glitchDur = 0;
        this.onGlitch(false);
      }
    }

    // туман
    if (this.fogState !== 'off') {
      this.fogT += dt;
      if (this.fogState === 'in') {
        if (Math.random() < 0.6) this.paintFog();
        this.fogAlpha = clamp(this.fogT / 0.8, 0, 1);
        if (this.fogT > 0.9) {
          this.fogState = 'draw';
          this.fogT = 0;
        }
      } else if (this.fogState === 'draw' && this.heart) {
        const h = this.heart;
        const target = Math.floor(clamp(this.fogT / 1.6, 0, 1) * (h.pts.length - 1));
        while (h.drawn < target) {
          const a = h.pts[h.drawn], c = h.pts[h.drawn + 1];
          this.fg.globalCompositeOperation = 'destination-out';
          this.fg.lineCap = 'round';
          this.fg.lineWidth = 13;
          this.fg.beginPath();
          this.fg.moveTo(a.x, a.y);
          this.fg.lineTo(c.x, c.y);
          this.fg.stroke();
          this.fg.globalCompositeOperation = 'source-over';
          h.drawn++;
        }
        if (target >= h.pts.length - 1) {
          this.fogState = 'hold';
          this.fogT = 0;
          const r = h.resolve;
          this.heart = null;
          r();
        }
      } else if (this.fogState === 'hold' && this.fogT > 3.5) {
        this.fogState = 'out';
        this.fogT = 0;
      } else if (this.fogState === 'out') {
        this.fogAlpha = clamp(1 - this.fogT / 2.5, 0, 1);
        if (this.fogAlpha <= 0) this.fogState = 'off';
      }
    }

    if (this.glassCat) {
      this.glassCat.t += dt;
      if (this.glassCat.t > this.glassCat.dur) this.glassCat = null;
    }

    for (const s of this.stickers) {
      s.age += dt;
      if (s.flying) {
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        s.vy += 1400 * dt;
        s.rot += s.vr * dt;
        s.alpha -= dt * 1.2;
      }
    }
    this.stickers = this.stickers.filter((s) => s.alpha > 0 && s.y < this.h + s.size * 2);
  }

  draw() {
    const g = this.g;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);

    // туман на стекле (под остальным)
    if (this.fogState !== 'off' && this.fogAlpha > 0) {
      g.globalAlpha = this.fogAlpha;
      g.drawImage(this.fog, 0, 0, this.w, this.h);
      g.globalAlpha = 1;
    }

    // «кот у стекла»: прижатый спрайт, щека расплющена
    if (this.glassCat) this.drawGlassCat();

    // царапины
    for (const s of this.scratches) {
      if (s.age < 0) continue;
      const k = s.age / s.life;
      const a = k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4;
      const grow = clamp(s.age / 0.12, 0, 1);
      const n = Math.max(2, Math.floor(s.pts.length * grow));
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.beginPath();
      for (let i = 0; i < n; i++) (i ? g.lineTo : g.moveTo).call(g, s.pts[i].x + 2, s.pts[i].y + 3);
      g.strokeStyle = `rgba(0,0,0,${0.35 * a})`;
      g.lineWidth = 7;
      g.stroke();
      g.beginPath();
      for (let i = 0; i < n; i++) (i ? g.lineTo : g.moveTo).call(g, s.pts[i].x, s.pts[i].y);
      g.strokeStyle = `rgba(255,255,255,${0.95 * a})`;
      g.lineWidth = 4;
      g.stroke();
      g.strokeStyle = `rgba(200,230,255,${0.6 * a})`;
      g.lineWidth = 1.2;
      g.stroke();
    }

    // шлейфы
    for (const t of this.trails) {
      const a = 1 - t.age;
      g.beginPath();
      t.pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
      g.strokeStyle = t.color;
      g.globalAlpha = 0.6 * a;
      g.lineWidth = 10 * a + 2;
      g.lineCap = 'round';
      g.shadowColor = t.color;
      g.shadowBlur = 18;
      g.stroke();
      g.shadowBlur = 0;
      g.globalAlpha = 1;
    }

    // наклейки
    for (const s of this.stickers) this.drawSticker(s);

    // пятна жвачки на стекле
    for (const s of this.splats) {
      const a = clamp((s.life - s.age) / 1.0, 0, 1);
      const pop = easeOutBack(clamp(s.age / 0.18, 0, 1));
      g.save();
      g.translate(s.x, s.y);
      g.globalAlpha = 0.88 * a;
      g.fillStyle = s.color;
      g.beginPath();
      g.arc(0, 0, s.r * pop * 0.7, 0, Math.PI * 2);
      for (const b of s.blobs) {
        g.moveTo(Math.cos(b.a) * s.r * b.d * pop + s.r * b.r * pop, Math.sin(b.a) * s.r * b.d * pop);
        g.arc(Math.cos(b.a) * s.r * b.d * pop, Math.sin(b.a) * s.r * b.d * pop, s.r * b.r * pop, 0, Math.PI * 2);
      }
      g.fill();
      for (const d of s.drips) {
        g.beginPath();
        g.roundRect(d.x * s.r - 6, 0, 12, s.r * 0.5 + d.len * s.r, 6);
        g.fill();
      }
      // блик
      g.globalAlpha = 0.5 * a;
      g.fillStyle = '#fff';
      g.beginPath();
      g.ellipse(-s.r * 0.25, -s.r * 0.25, s.r * 0.18, s.r * 0.09, -0.6, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }

    // пузырь жвачки
    const b = this.bubble;
    if (b) {
      const wob = b.phase === 'hold' ? 1 + 0.02 * Math.sin(b.t * 60) : 1;
      const r = b.r * wob;
      g.save();
      const grd = g.createRadialGradient(b.x - r * 0.3, b.y - r * 0.35, r * 0.05, b.x, b.y, r);
      grd.addColorStop(0, 'rgba(255,220,240,0.55)');
      grd.addColorStop(0.7, hexA(b.color, 0.5));
      grd.addColorStop(0.97, hexA(b.color, 0.85));
      grd.addColorStop(1, hexA(b.color, 0.95));
      g.fillStyle = grd;
      g.beginPath();
      g.arc(b.x, b.y, r, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = 'rgba(255,255,255,0.65)';
      g.beginPath();
      g.ellipse(b.x - r * 0.42, b.y - r * 0.45, r * 0.16, r * 0.07, -0.7, 0, Math.PI * 2);
      g.fill();
      g.beginPath();
      g.arc(b.x - r * 0.22, b.y - r * 0.58, r * 0.03, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }

    // частицы
    for (const p of this.parts) {
      const a = 1 - p.age / p.life;
      g.globalAlpha = clamp(a * 1.4, 0, 1);
      g.fillStyle = p.color;
      g.strokeStyle = p.color;
      if (p.kind === 'spark' || p.kind === 'flake') {
        const tw = p.kind === 'spark' ? 0.6 + 0.4 * Math.sin(p.age * 25 + p.rot * 10) : 1;
        drawSparkle(g, p.x, p.y, p.size * tw, p.rot);
      } else if (p.kind === 'ring') {
        const k = p.age / p.life;
        g.lineWidth = 3 * (1 - k) + 0.5;
        g.beginPath();
        g.arc(p.x, p.y, p.size * (0.6 + k * 1.8), 0, Math.PI * 2);
        g.stroke();
      } else if (p.kind === 'shred') {
        g.save();
        g.translate(p.x, p.y);
        g.rotate(p.rot);
        g.beginPath();
        g.ellipse(0, 0, p.size, p.size * 0.45, 0, 0, Math.PI * 2);
        g.fill();
        g.restore();
      } else {
        g.beginPath();
        g.arc(p.x, p.y, p.size / 2, 0, Math.PI * 2);
        g.fill();
      }
    }
    g.globalAlpha = 1;

    if (this.glitchDur > 0) this.drawGlitch();
  }

  private drawGlitch() {
    const g = this.g;
    const k = this.glitchT / this.glitchDur;
    const cols = ['rgba(0,255,230,0.35)', 'rgba(255,0,170,0.35)', 'rgba(182,255,59,0.35)'];
    for (let i = 0; i < 9; i++) {
      const y = Math.random() * this.h;
      const hh = rand(4, 40);
      g.fillStyle = cols[i % 3];
      g.fillRect(rand(-40, 40), y, this.w, hh);
    }
    g.fillStyle = 'rgba(0,0,0,0.12)';
    for (let y = 0; y < this.h; y += 4) g.fillRect(0, y, this.w, 1);
    if (k < 0.7) {
      for (let i = 0; i < 14; i++) {
        g.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)';
        g.fillRect(rand(0, this.w), rand(0, this.h), rand(8, 60), rand(3, 12));
      }
    }
  }

  private drawGlassCat() {
    const gc = this.glassCat!;
    const g = this.g;
    const k = gc.t / gc.dur;
    const inK = easeOutBack(clamp(gc.t / 0.35, 0, 1));
    const outK = clamp((gc.dur - gc.t) / 0.3, 0, 1);
    const img = gc.img;
    const H = this.h * 0.95;
    const W = (H * img.naturalWidth) / img.naturalHeight;
    const squash = 1 + 0.06 * Math.sin(Math.min(1, k * 3) * Math.PI * 0.5);
    g.save();
    g.globalAlpha = outK;
    g.translate(this.w / 2, this.h + H * 0.12 + (1 - inK) * H * 0.6);
    g.scale(squash * 1.04, 1 / squash);
    g.drawImage(img, -W / 2, -H, W, H);
    g.restore();
    // прижатые щёки/нос: светлые «пятна контакта» + запотевание вокруг
    const fy = this.h - H * 0.68 + (1 - inK) * H * 0.6;
    g.globalAlpha = 0.45 * outK;
    const grd = g.createRadialGradient(this.w / 2, fy, 10, this.w / 2, fy, this.w * 0.55);
    grd.addColorStop(0, 'rgba(255,255,255,0.0)');
    grd.addColorStop(0.55, 'rgba(240,248,255,0.0)');
    grd.addColorStop(0.75, 'rgba(240,248,255,0.55)');
    grd.addColorStop(1, 'rgba(240,248,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, this.w, this.h);
    g.fillStyle = 'rgba(255,255,255,0.6)';
    for (const dx of [-0.22, 0.22]) {
      g.beginPath();
      g.ellipse(this.w / 2 + dx * this.w, fy + 30, this.w * 0.09, this.w * 0.05, 0, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
  }

  private drawSticker(s: Sticker) {
    const g = this.g;
    const slap = s.age < 0.25 ? easeOutBack(s.age / 0.25) : 1;
    const sc = (1.6 - 0.6 * slap) * (s.flying ? 1 : 1);
    g.save();
    g.globalAlpha = clamp(s.alpha, 0, 1) * clamp(s.age / 0.08, 0, 1);
    g.translate(s.x, s.y);
    g.rotate(s.rot);
    g.scale(sc, sc);
    const h = s.size / 2;
    if (s.peel > 0 && s.peelCorner) {
      const d = norm(-s.peelCorner.x, -s.peelCorner.y);
      const L = s.peel * s.size * 1.4;
      const k = (s.peelCorner.x * d.x + s.peelCorner.y * d.y) + L / 2; // проекция линии сгиба
      // приклеенная часть
      g.save();
      g.beginPath();
      halfPlane(g, d, k, s.size * 2, false);
      g.clip();
      g.drawImage(s.face, -h, -h, s.size, s.size);
      g.restore();
      // загнутый уголок: отражение отклеенной части относительно линии сгиба
      g.save();
      g.transform(1 - 2 * d.x * d.x, -2 * d.x * d.y, -2 * d.x * d.y, 1 - 2 * d.y * d.y, 2 * k * d.x, 2 * k * d.y);
      g.beginPath();
      halfPlane(g, d, k, s.size * 2, true);
      g.clip();
      g.shadowColor = 'rgba(0,0,0,0.3)';
      g.shadowBlur = 8;
      g.drawImage(s.back, -h, -h, s.size, s.size);
      g.restore();
    } else {
      g.drawImage(s.face, -h, -h, s.size, s.size);
      // блик: диагональная полоса пробегает по наклейке
      const ph = ((s.age * 0.6 + s.id * 0.37) % 2.2) - 0.6;
      g.save();
      g.globalCompositeOperation = 'source-atop';
      g.restore();
      g.save();
      g.beginPath();
      g.rect(-h, -h, s.size, s.size);
      g.clip();
      const grd = g.createLinearGradient(-h + ph * s.size, -h, -h + ph * s.size + s.size * 0.5, h);
      grd.addColorStop(0, 'rgba(255,255,255,0)');
      grd.addColorStop(0.5, 'rgba(255,255,255,0.45)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha *= 0.55;
      // маска блика — сама наклейка (через временный канвас дорого; используем форму-силуэт)
      g.drawImage(maskedGloss(s, grd), -h, -h, s.size, s.size);
      g.restore();
    }
    if (s.label) {
      g.font = `800 ${Math.round(s.size * 0.13)}px -apple-system, system-ui, sans-serif`;
      g.textAlign = 'center';
      g.fillStyle = '#fff';
      g.strokeStyle = 'rgba(0,0,0,0.6)';
      g.lineWidth = 4;
      g.strokeText(s.label, 0, h + s.size * 0.12);
      g.fillText(s.label, 0, h + s.size * 0.12);
    }
    g.restore();
  }
}

const glossCanvas = document.createElement('canvas');
/** блик, обрезанный по форме наклейки */
function maskedGloss(s: Sticker, grd: CanvasGradient) {
  const c = glossCanvas;
  if (c.width !== s.face.width) {
    c.width = s.face.width;
    c.height = s.face.height;
  }
  const g = c.getContext('2d')!;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, c.width, c.height);
  g.drawImage(s.face, 0, 0);
  g.globalCompositeOperation = 'source-in';
  // переносим градиент из координат наклейки в пиксели канваса
  const k = c.width / s.size;
  g.setTransform(k, 0, 0, k, (s.size / 2) * k, (s.size / 2) * k);
  g.fillStyle = grd;
  g.fillRect(-s.size, -s.size, s.size * 2, s.size * 2);
  g.globalCompositeOperation = 'source-over';
  return c;
}

function halfPlane(g: CanvasRenderingContext2D, d: { x: number; y: number }, k: number, R: number, negative: boolean) {
  // полуплоскость {p: p·d > k} (или < k) как большой прямоугольник
  const px = -d.y, py = d.x;
  const sx = d.x * k, sy = d.y * k;
  const dir = negative ? -1 : 1;
  g.moveTo(sx + px * R, sy + py * R);
  g.lineTo(sx - px * R, sy - py * R);
  g.lineTo(sx - px * R + d.x * R * dir, sy - py * R + d.y * R * dir);
  g.lineTo(sx + px * R + d.x * R * dir, sy + py * R + d.y * R * dir);
  g.closePath();
}

function norm(x: number, y: number) {
  const l = Math.hypot(x, y) || 1;
  return { x: x / l, y: y / l };
}

function drawSparkle(g: CanvasRenderingContext2D, x: number, y: number, s: number, rot: number) {
  g.save();
  g.translate(x, y);
  g.rotate(rot);
  g.beginPath();
  g.moveTo(0, -s);
  g.quadraticCurveTo(0, 0, s, 0);
  g.quadraticCurveTo(0, 0, 0, s);
  g.quadraticCurveTo(0, 0, -s, 0);
  g.quadraticCurveTo(0, 0, 0, -s);
  g.fill();
  g.restore();
}

function hexA(hex: string, a: number) {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

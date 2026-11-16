/**
 * Ядро слоя эффектов: общие типы, частицы (пул + кэш спрайтов), «поверхности» стекла (туман, жвачка).
 * Всё на Canvas 2D. Частицы рисуются drawImage из заранее отрисованных спрайтов (быстрее path-ов в 3–5 раз
 * на мобильных), поверхности — в половинном разрешении (туман и жвачка мягкие, разница не видна).
 */
import type { FxDef, FxParams } from './catalog';
import { clamp, rand } from '../core/util';

export interface Pt { x: number; y: number }
export type Palette = { primary: string; secondary: string; accent: string; fx: string[] };
export type AnchorName = 'head' | 'mouth' | 'feet' | 'body' | 'earL' | 'earR' | 'pawR';

export interface FxArgs {
  x?: number;
  y?: number;
  /** траектория свайпа (claws, glitter_trail) */
  path?: Pt[];
  from?: Pt;
  /** селектор / элемент кнопки (spotlight_button) */
  target?: string | HTMLElement;
  /** картинка позы кота (glass_cat в спрайт-режиме) */
  image?: HTMLImageElement | null;
  /** доп. параметры поверх fx.json + fxTuning */
  params?: FxParams;
  /** переопределить длительность из fx.json */
  durationMs?: number;
  /** проиграть звук эффекта из fx.json (по умолчанию нет — звук реакции играет director) */
  sound?: boolean;
}

/** Окружение, которое слой даёт эффектам */
export interface FxEnv {
  w: number;
  h: number;
  dpr: number;
  /** секунды с создания слоя */
  t: number;
  palette: Palette;
  /** экранная точка части кота; s — рост кота на экране, px */
  anchor(name: AnchorName): Pt & { s: number };
  /** наклон телефона −1..1 (x — влево/вправо, y — к себе/от себя), сглажен */
  tilt: Pt;
  /** «вниз» в координатах экрана (по акселерометру/ориентации), единичный вектор */
  gravity: Pt;
  parts: Particles;
  fog: Surface;
  gum: Surface;
  sound(id: string, vol?: number): void;
  shake(px: number, ms: number): void;
  /** RGB-сдвиг/дрожание 3D-слоя (глитч) */
  sceneGlitch(on: boolean, shiftPx?: number): void;
  /** уровень микрофона 0..1 (echo_wave) */
  level(): number;
  /** есть ли сейчас живой эффект с таким id */
  active(id: string): boolean;
  /** качество 0.35..1 — снижается, если эффекты не укладываются в бюджет кадра */
  lod: number;
}

export interface FxInstance {
  readonly id: string;
  /** порядок отрисовки: 0 — туман/подложка, 1 — стекло, 2 — мир (у кота), 3 — интерфейс */
  z: number;
  /** false — эффект закончился */
  update(dt: number, env: FxEnv): boolean;
  draw(g: CanvasRenderingContext2D, env: FxEnv): void;
  /** касание: true — эффект забирает жест (дальше move/up идут только ему) */
  pointer?(type: 'down' | 'move' | 'up', x: number, y: number, px: number, py: number, env: FxEnv): boolean;
  /** остановить досрочно (петли) */
  stop?(): void;
  /** вызывается один раз, когда эффект снят со слоя */
  end?(env: FxEnv): void;
}

export type FxFactory = (def: FxDef, args: FxArgs, env: FxEnv) => FxInstance;

// ───────────── частицы ─────────────
export type Shape = 'spark' | 'dot' | 'heart' | 'star' | 'flake' | 'shred' | 'ring' | 'rect' | 'glow';

export interface Particle {
  x: number; y: number; vx: number; vy: number;
  age: number; life: number; size: number; color: string; shape: Shape;
  rot: number; vr: number;
  /** ускорение вниз, px/с² (по экранной вертикали) */
  g: number;
  /** ускорение по «гравитации телефона» (снежный шар) */
  gg: number;
  drag: number;
  /** оседать у края экрана (снежный шар) */
  settle: boolean;
  settled: boolean;
  /** покачивание (конфетти, снежинки) */
  flutter: number;
  /** мерцание */
  twinkle: number;
  alpha: number;
}

const SPR = 48;
const sprites = new Map<string, HTMLCanvasElement>();

/** спрайт формы заданного цвета (кэш) */
export function sprite(shape: Shape, color: string): HTMLCanvasElement {
  const key = shape + color;
  let c = sprites.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = c.height = SPR;
  const g = c.getContext('2d')!;
  g.translate(SPR / 2, SPR / 2);
  g.fillStyle = color;
  g.strokeStyle = color;
  const r = SPR / 2 - 2;
  switch (shape) {
    case 'spark':
    case 'flake': {
      g.shadowColor = color;
      g.shadowBlur = 6;
      g.beginPath();
      const s = r * 0.9;
      g.moveTo(0, -s);
      g.quadraticCurveTo(0, 0, s, 0);
      g.quadraticCurveTo(0, 0, 0, s);
      g.quadraticCurveTo(0, 0, -s, 0);
      g.quadraticCurveTo(0, 0, 0, -s);
      g.fill();
      g.fillStyle = 'rgba(255,255,255,0.9)';
      g.beginPath();
      g.arc(0, 0, r * 0.14, 0, Math.PI * 2);
      g.fill();
      break;
    }
    case 'star':
      g.shadowColor = color;
      g.shadowBlur = 5;
      starPath(g, 0, 0, r * 0.85, r * 0.38, 5);
      g.fill();
      break;
    case 'heart':
      g.shadowColor = color;
      g.shadowBlur = 4;
      heartPath(g, 0, 2, r * 0.82);
      g.fill();
      g.fillStyle = 'rgba(255,255,255,0.55)';
      g.beginPath();
      g.ellipse(-r * 0.32, -r * 0.18, r * 0.16, r * 0.09, -0.6, 0, Math.PI * 2);
      g.fill();
      break;
    case 'glow': {
      const grd = g.createRadialGradient(0, 0, 0, 0, 0, r);
      grd.addColorStop(0, color);
      grd.addColorStop(0.25, color);
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd;
      g.globalAlpha = 0.9;
      g.fillRect(-r, -r, r * 2, r * 2);
      break;
    }
    case 'shred':
      g.beginPath();
      g.ellipse(0, 0, r, r * 0.45, 0, 0, Math.PI * 2);
      g.fill();
      break;
    default:
      g.beginPath();
      g.arc(0, 0, r * 0.7, 0, Math.PI * 2);
      g.fill();
  }
  sprites.set(key, c);
  return c;
}

export class Particles {
  list: Particle[] = [];
  private pool: Particle[] = [];
  cap = 900;

  spawn(o: Partial<Particle> & { x: number; y: number }): Particle | null {
    if (this.list.length >= this.cap) return null;
    const p = this.pool.pop() ?? ({} as Particle);
    p.x = o.x;
    p.y = o.y;
    p.vx = o.vx ?? 0;
    p.vy = o.vy ?? 0;
    p.age = o.age ?? 0;
    p.life = o.life ?? 1;
    p.size = o.size ?? 8;
    p.color = o.color ?? '#fff';
    p.shape = o.shape ?? 'spark';
    p.rot = o.rot ?? rand(0, 6.28);
    p.vr = o.vr ?? rand(-4, 4);
    p.g = o.g ?? 0;
    p.gg = o.gg ?? 0;
    p.drag = o.drag ?? 0.98;
    p.settle = o.settle ?? false;
    p.settled = false;
    p.flutter = o.flutter ?? 0;
    p.twinkle = o.twinkle ?? 0;
    p.alpha = o.alpha ?? 1;
    this.list.push(p);
    return p;
  }

  update(dt: number, env: FxEnv) {
    const L = this.list;
    let j = 0;
    const gx = env.gravity.x, gy = env.gravity.y;
    for (let i = 0; i < L.length; i++) {
      const p = L[i];
      p.age += dt;
      if (p.age >= p.life || p.age < -5) {
        this.pool.push(p);
        continue;
      }
      if (p.age > 0 && !p.settled) {
        const dr = Math.pow(p.drag, dt * 60);
        p.vx = p.vx * dr + p.gg * gx * dt;
        p.vy = p.vy * dr + (p.g + p.gg * gy) * dt;
        if (p.flutter) p.vx += Math.sin(p.age * 4 + p.rot * 3) * p.flutter * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += p.vr * dt;
        if (p.settle) {
          // оседают у «нижнего» края по гравитации телефона
          const m = p.size * 0.4;
          if ((gy > 0.3 && p.y > env.h - m) || (gy < -0.3 && p.y < m) || (gx > 0.3 && p.x > env.w - m) || (gx < -0.3 && p.x < m)) {
            p.x = clamp(p.x, m, env.w - m);
            p.y = clamp(p.y, m, env.h - m);
            p.settled = true;
            p.vr = 0;
          }
        }
      }
      L[j++] = p;
    }
    L.length = j;
  }

  draw(g: CanvasRenderingContext2D, env: FxEnv) {
    const dpr = env.dpr;
    for (const p of this.list) {
      if (p.age < 0) continue;
      const k = p.age / p.life;
      let a = p.alpha * clamp((1 - k) * 2.2, 0, 1);
      if (p.twinkle) a *= 0.55 + 0.45 * Math.sin(p.age * p.twinkle + p.rot * 7);
      if (a <= 0.01) continue;
      g.globalAlpha = a;
      if (p.shape === 'ring') {
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.strokeStyle = p.color;
        g.lineWidth = 3.5 * (1 - k) + 0.6;
        g.beginPath();
        g.arc(p.x, p.y, p.size * (0.3 + k * 1.0), 0, Math.PI * 2);
        g.stroke();
        continue;
      }
      const c = Math.cos(p.rot) * dpr, s = Math.sin(p.rot) * dpr;
      if (p.shape === 'rect') {
        // конфетти: «переворачивается» по одной оси
        const fl = Math.cos(p.age * 9 + p.rot * 5);
        g.setTransform(c, s, -s * fl, c * fl, p.x * dpr, p.y * dpr);
        g.fillStyle = p.color;
        g.fillRect(-p.size / 2, -p.size * 0.3, p.size, p.size * 0.6);
        continue;
      }
      g.setTransform(c, s, -s, c, p.x * dpr, p.y * dpr);
      const sz = p.size * 2;
      g.drawImage(sprite(p.shape, p.color), -sz / 2, -sz / 2, sz, sz);
    }
    g.globalAlpha = 1;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  clear() {
    this.pool.push(...this.list);
    this.list = [];
  }
}

// ───────────── поверхности стекла ─────────────
/**
 * Слой «на стекле» в половинном разрешении: туман, жвачка. Живёт, пока его поддерживают (keep),
 * потом гаснет за fadeMs. Стирается пальцем (wipe).
 */
export class Surface {
  readonly canvas = document.createElement('canvas');
  readonly g: CanvasRenderingContext2D;
  /** общая прозрачность 0..1 */
  level = 0;
  private target = 0;
  private holdUntil = 0;
  private fadeSec = 2.5;
  private t = 0;
  active = false;
  readonly scale = 0.5;

  constructor() {
    this.g = this.canvas.getContext('2d', { willReadFrequently: true })!;
  }

  resize(w: number, h: number) {
    const W = Math.max(1, Math.round(w * this.scale)), H = Math.max(1, Math.round(h * this.scale));
    if (W === this.canvas.width && H === this.canvas.height) return;
    // сохраняем содержимое при повороте экрана
    const old = this.active ? this.snapshot() : null;
    this.canvas.width = W;
    this.canvas.height = H;
    if (old) this.g.drawImage(old, 0, 0, W, H);
  }

  private snapshot() {
    const c = document.createElement('canvas');
    c.width = this.canvas.width;
    c.height = this.canvas.height;
    c.getContext('2d')!.drawImage(this.canvas, 0, 0);
    return c;
  }

  /** держать видимым ещё ms, затем гаснуть за fadeMs */
  keep(ms: number, fadeMs = 2500, inMs = 400) {
    if (!this.active) {
      this.active = true;
      this.level = 0;
    }
    this.target = 1;
    this.holdUntil = Math.max(this.holdUntil, this.t + ms / 1000);
    this.fadeSec = Math.max(0.2, fadeMs / 1000);
    this.inSec = Math.max(0.05, inMs / 1000);
  }
  private inSec = 0.4;

  get visible() {
    return this.active && this.level > 0.003;
  }

  /** точка (экранные px) покрыта слоем? (жвачку стирают, только если палец на ней) */
  covered(x: number, y: number, minAlpha = 40): boolean {
    if (!this.visible) return false;
    const d = this.g.getImageData(Math.round(x * this.scale), Math.round(y * this.scale), 1, 1).data;
    return d[3] > minAlpha;
  }

  /** стереть линию (экранные px) */
  wipe(x: number, y: number, px: number, py: number, brushPx: number, soft = 0.9) {
    if (!this.active) return;
    const g = this.g, k = this.scale;
    g.save();
    g.globalCompositeOperation = 'destination-out';
    g.lineCap = 'round';
    g.lineWidth = brushPx * k;
    g.strokeStyle = `rgba(0,0,0,${soft})`;
    g.beginPath();
    g.moveTo(px * k, py * k);
    g.lineTo(x * k + 0.01, y * k);
    g.stroke();
    g.restore();
  }

  update(dt: number) {
    this.t += dt;
    if (!this.active) return;
    if (this.t > this.holdUntil) this.target = 0;
    const rate = this.target > this.level ? 1 / this.inSec : 1 / this.fadeSec;
    this.level = clamp(this.level + Math.sign(this.target - this.level) * rate * dt, 0, 1);
    if (this.level <= 0 && this.target === 0) {
      this.active = false;
      this.g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  draw(g: CanvasRenderingContext2D, w: number, h: number) {
    if (!this.visible) return;
    g.globalAlpha = this.level;
    g.drawImage(this.canvas, 0, 0, w, h);
    g.globalAlpha = 1;
  }

  clear() {
    this.active = false;
    this.level = 0;
    this.target = 0;
    this.holdUntil = 0;
    this.g.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
}

/** «дыхнуть» на стекло: пятно тумана (экранные px) */
export function breathFog(s: Surface, x: number, y: number, r: number, opacity: number) {
  const g = s.g, k = s.scale;
  const X = x * k, Y = y * k, R = r * k;
  const grd = g.createRadialGradient(X, Y, R * 0.1, X, Y, R);
  grd.addColorStop(0, `rgba(236,243,249,${opacity})`);
  grd.addColorStop(0.6, `rgba(236,243,249,${opacity * 0.7})`);
  grd.addColorStop(1, 'rgba(236,243,249,0)');
  g.fillStyle = grd;
  g.beginPath();
  g.arc(X, Y, R, 0, Math.PI * 2);
  g.fill();
  // капельки конденсата
  g.fillStyle = `rgba(255,255,255,${opacity * 0.6})`;
  for (let i = 0; i < 10; i++) {
    const a = rand(0, Math.PI * 2), d = rand(0, R * 0.85);
    g.beginPath();
    g.arc(X + Math.cos(a) * d, Y + Math.sin(a) * d, rand(0.6, 1.8), 0, Math.PI * 2);
    g.fill();
  }
}

// ───────────── формы ─────────────
export function heartPath(g: CanvasRenderingContext2D | Path2D, x: number, y: number, s: number) {
  const p = g as CanvasRenderingContext2D;
  if ('beginPath' in p) p.beginPath();
  p.moveTo(x, y + s * 0.75);
  p.bezierCurveTo(x - s * 1.3, y - s * 0.1, x - s * 0.55, y - s * 1.05, x, y - s * 0.38);
  p.bezierCurveTo(x + s * 0.55, y - s * 1.05, x + s * 1.3, y - s * 0.1, x, y + s * 0.75);
  p.closePath();
}

export function starPath(g: CanvasRenderingContext2D, x: number, y: number, R: number, r: number, n: number) {
  g.beginPath();
  for (let i = 0; i < n * 2; i++) {
    const a = (i / (n * 2)) * Math.PI * 2 - Math.PI / 2;
    const rr = i % 2 ? r : R;
    g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  g.closePath();
}

/** точки параметрического сердца (центр, размер); mirror — рисуется как изнутри (зеркально) */
export function heartPoints(cx: number, cy: number, s: number, n = 80, tiltRad = 0, mirror = false): Pt[] {
  const pts: Pt[] = [];
  const c = Math.cos(tiltRad), sn = Math.sin(tiltRad);
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2;
    let x = (16 * Math.pow(Math.sin(t), 3)) / 17;
    const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) / 17;
    if (mirror) x = -x;
    pts.push({ x: cx + (x * c - y * sn) * s, y: cy + (x * sn + y * c) * s });
  }
  return pts;
}

export function hexA(hex: string, a: number) {
  if (!hex.startsWith('#')) return hex;
  const h = hex.length === 4 ? hex.slice(1).split('').map((c) => c + c).join('') : hex.slice(1, 7);
  const n = parseInt(h, 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

export const pickColor = (pal: Palette, i: number) => pal.fx[i % pal.fx.length] ?? '#fff';

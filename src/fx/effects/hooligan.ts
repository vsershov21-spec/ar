/** Эффекты Хулигана: когти, пузырь и пятна жвачки, глитч, искры от скейта, граффити. */
import { num, bool, str, type FxDef } from '../catalog';
import { hexA, type FxArgs, type FxEnv, type FxFactory, type Pt } from '../core';
import { Timed, at } from './common';
import { clamp, easeOutBack, rand } from '../../core/util';

// ───────────── claws: царапины по траектории свайпа ─────────────
class Claws extends Timed {
  lines: Pt[][] = [];
  fade: number;
  constructor(def: FxDef, args: FxArgs, env: FxEnv) {
    super('claws', def);
    const n = Math.round(num(def.params, 'lines', 3));
    const spacing = num(def.params, 'spacingPx', 14);
    this.fade = num(def.params, 'fadeMs', 1200) / 1000;
    let path = args.path && args.path.length > 1 && bool(def.params, 'followSwipe', true) ? args.path : null;
    if (!path) {
      // без траектории — диагональ через точку
      const c = at(args, env, { x: env.w / 2, y: env.h * 0.45 });
      const from = args.from ?? { x: c.x - env.w * 0.25, y: c.y - env.h * 0.08 };
      const L = 14;
      path = Array.from({ length: L + 1 }, (_, i) => ({ x: from.x + ((c.x - from.x) * 2 * i) / L, y: from.y + ((c.y - from.y) * 2 * i) / L }));
    }
    // ресэмплинг + нормали
    const pts = resample(path, 14);
    for (let k = 0; k < n; k++) {
      const off = (k - (n - 1) / 2) * spacing * 1.8;
      const line: Pt[] = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
        const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
        const j = i === 0 || i === pts.length - 1 ? 0 : rand(-2, 2);
        line.push({ x: pts[i].x + (-dy / l) * (off + j), y: pts[i].y + (dx / l) * (off + j) });
      }
      this.lines.push(line);
    }
  }
  draw(g: CanvasRenderingContext2D) {
    const a = clamp((this.life - this.t) / this.fade, 0, 1);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    this.lines.forEach((line, k) => {
      const grow = clamp((this.t - k * 0.03) / 0.14, 0, 1);
      const n = Math.max(2, Math.floor(line.length * grow));
      // тень, белая царапина, голубоватый блик
      const stroke = (dx: number, dy: number, col: string, w: number) => {
        g.beginPath();
        for (let i = 0; i < n; i++) (i ? g.lineTo : g.moveTo).call(g, line[i].x + dx, line[i].y + dy);
        g.strokeStyle = col;
        g.lineWidth = w;
        g.stroke();
      };
      stroke(1.5, 2.5, `rgba(0,0,0,${0.3 * a})`, 6);
      stroke(0, 0, `rgba(255,255,255,${0.95 * a})`, 3.5);
      stroke(-0.5, -0.5, `rgba(200,230,255,${0.6 * a})`, 1.2);
    });
  }
}

function resample(path: Pt[], step: number): Pt[] {
  const out: Pt[] = [path[0]];
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    acc += d;
    if (acc >= step) {
      out.push(b);
      acc = 0;
    }
  }
  if (out.length < 2) out.push(path[path.length - 1]);
  return out;
}

// ───────────── gum_bubble: пузырь растёт у рта и лопается ─────────────
class GumBubble extends Timed {
  x: number;
  y: number;
  r = 4;
  R: number;
  color: string;
  popAt: number;
  popped = false;
  constructor(def: FxDef, args: FxArgs, env: FxEnv) {
    super('gum_bubble', def);
    this.z = 2;
    const m = args.x !== undefined ? at(args, env) : env.anchor('mouth');
    this.x = m.x;
    this.y = m.y;
    this.color = (def.params.color as string) ?? env.palette.accent;
    this.R = num(def.params, 'maxScale', 1.4) * Math.min(env.w, env.h) * 0.5;
    this.popAt = num(def.params, 'popAt', 0.8) * this.life;
  }
  update(dt: number, env: FxEnv) {
    this.t += dt;
    if (this.popped) return false;
    const grow = clamp(this.t / (this.popAt * 0.85), 0, 1);
    this.r = 4 + (this.R - 4) * grow * grow * (3 - 2 * grow);
    // пока маленький — держится у рта, потом центр уходит к центру экрана
    const m = env.anchor('mouth');
    const follow = clamp(1 - grow * 2, 0, 1);
    this.x += ((follow ? m.x : env.w / 2) - this.x) * Math.min(1, dt * (follow ? 20 : 1.6));
    this.y += ((follow ? m.y + this.r * 0.8 : env.h / 2) - this.y) * Math.min(1, dt * (follow ? 20 : 1.6));
    if (this.t >= this.popAt || this.stopped) {
      this.popped = true;
      env.sound('gum_pop');
      for (let i = 0; i < 34 * env.lod; i++) {
        const a = rand(0, Math.PI * 2), sp = rand(300, 1100);
        env.parts.spawn({ x: this.x + Math.cos(a) * this.r * 0.4, y: this.y + Math.sin(a) * this.r * 0.4, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rand(0.35, 0.8), size: rand(10, 24), color: this.color, shape: 'shred', g: 300, drag: 0.9 });
      }
      return false;
    }
    return true;
  }
  draw(g: CanvasRenderingContext2D) {
    const r = this.r * (this.t > this.popAt * 0.85 ? 1 + 0.02 * Math.sin(this.t * 60) : 1);
    const { x, y } = this;
    const grd = g.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.05, x, y, r);
    grd.addColorStop(0, 'rgba(255,220,240,0.5)');
    grd.addColorStop(0.7, hexA(this.color, 0.48));
    grd.addColorStop(0.97, hexA(this.color, 0.85));
    grd.addColorStop(1, hexA(this.color, 0.95));
    g.fillStyle = grd;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(255,255,255,0.65)';
    g.beginPath();
    g.ellipse(x - r * 0.42, y - r * 0.45, r * 0.16, r * 0.07, -0.7, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.arc(x - r * 0.22, y - r * 0.58, r * 0.03, 0, Math.PI * 2);
    g.fill();
  }
}

// ───────────── gum_splat: жвачка на стекле, стирается пальцем ─────────────
interface Splat { x: number; y: number; r: number; blobs: { a: number; d: number; r: number }[]; drips: { x: number; len: number; speed: number; drawn: number }[] }
class GumSplat extends Timed {
  splats: Splat[] = [];
  color: string;
  baked = false;
  started = -1;
  afterBubble = false;
  wiping = false;
  lastSquish = 0;
  constructor(def: FxDef, readonly args: FxArgs, env: FxEnv) {
    super('gum_splat', def);
    this.z = 1;
    this.color = (def.params.color as string) ?? env.palette.accent;
  }
  private place(env: FxEnv) {
    const n = Math.round(num(this.def.params, 'blobs', 5));
    const spread = num(this.def.params, 'spreadPx', 220);
    const c = this.args.x !== undefined ? at(this.args, env) : { x: env.w / 2, y: env.h / 2 };
    const drip = bool(this.def.params, 'drip', true);
    for (let i = 0; i < n + 3; i++) {
      // крупные — по краям «лопнувшего пузыря», мелкие — ближе к центру
      const big = i < n;
      const a = (i / n) * Math.PI * 2 + rand(-0.3, 0.3);
      const d = big ? spread * rand(0.75, 1.2) : spread * rand(0.1, 0.5);
      this.splats.push({
        x: clamp(c.x + Math.cos(a) * d * (env.w / Math.max(env.w, env.h) + 0.3), 10, env.w - 10),
        y: clamp(c.y + Math.sin(a) * d * 1.3, 10, env.h - 10),
        r: big ? rand(48, 95) : rand(20, 42),
        blobs: Array.from({ length: 7 }, () => ({ a: rand(0, Math.PI * 2), d: rand(0.4, 1.0), r: rand(0.25, 0.55) })),
        drips: drip ? Array.from({ length: 1 + Math.floor(rand(0, 3)) }, () => ({ x: rand(-0.6, 0.6), len: 0, speed: rand(10, 28), drawn: 0 })) : [],
      });
    }
  }
  update(dt: number, env: FxEnv) {
    this.t += dt;
    if (this.started < 0) {
      // в паре с gum_bubble — прилипает, когда пузырь лопнет
      if (env.active('gum_bubble') && this.t < 4) {
        this.afterBubble = true;
        return true;
      }
      this.started = this.t;
      this.place(env);
      env.gum.keep(Math.max(0, this.def.durationMs - 1000), 1000, 60);
      if (!this.afterBubble && this.args.sound) env.sound('gum_pop', 0.6);
    }
    const lt = this.t - this.started;
    if (!this.baked && lt > 0.18) {
      this.baked = true;
      for (const s of this.splats) drawSplat(env.gum.g, s, 1, this.color, env.gum.scale);
    }
    if (this.baked) {
      // подтёки удлиняются — дорисовываем приращение прямо в поверхность
      const g = env.gum.g, k = env.gum.scale;
      g.fillStyle = this.color;
      for (const s of this.splats)
        for (const d of s.drips) {
          d.len = Math.min(2.2, d.len + (d.speed * dt) / s.r);
          const y0 = s.r * 0.5 + d.drawn * s.r, y1 = s.r * 0.5 + d.len * s.r;
          if (y1 - y0 > 1) {
            g.beginPath();
            g.roundRect((s.x + d.x * s.r - 6) * k, (s.y + y0 - 6) * k, 12 * k, (y1 - y0 + 6) * k, 6 * k);
            g.fill();
            d.drawn = d.len;
          }
        }
    }
    return lt < this.life && (env.gum.visible || !this.baked);
  }
  pointer(type: 'down' | 'move' | 'up', x: number, y: number, px: number, py: number, env: FxEnv) {
    if (!bool(this.def.params, 'wipeByFinger', true) || !this.baked) return false;
    if (type === 'down') this.wiping = env.gum.covered(x, y);
    if (!this.wiping) return false;
    if (type === 'move') {
      env.gum.wipe(x, y, px, py, 46, 0.95);
      env.gum.keep(800, 1000);
      if (this.t - this.lastSquish > 0.4) {
        this.lastSquish = this.t;
        env.sound('finger_squeak', 0.4);
      }
    }
    if (type === 'up') this.wiping = false;
    return true;
  }
  draw(g: CanvasRenderingContext2D) {
    if (this.started < 0 || this.baked) return;
    const pop = easeOutBack(clamp((this.t - this.started) / 0.18, 0, 1));
    for (const s of this.splats) drawSplat(g, s, pop, this.color, 1);
  }
}

function drawSplat(g: CanvasRenderingContext2D, s: Splat, pop: number, color: string, k: number) {
  g.save();
  g.scale(k, k);
  g.translate(s.x, s.y);
  g.globalAlpha = 0.9;
  g.fillStyle = color;
  g.beginPath();
  g.arc(0, 0, s.r * pop * 0.7, 0, Math.PI * 2);
  for (const b of s.blobs) {
    const bx = Math.cos(b.a) * s.r * b.d * pop, by = Math.sin(b.a) * s.r * b.d * pop;
    g.moveTo(bx + s.r * b.r * pop, by);
    g.arc(bx, by, s.r * b.r * pop, 0, Math.PI * 2);
  }
  g.fill();
  g.globalAlpha = 0.45;
  g.fillStyle = '#fff';
  g.beginPath();
  g.ellipse(-s.r * 0.25, -s.r * 0.25, s.r * 0.18, s.r * 0.09, -0.6, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

// ───────────── glitch: полосы-сдвиги и RGB-раздвоение (не чаще 3 смен в секунду) ─────────────
/** минимальный интервал смены картинки глитча, с — фотосенситивность: ≤ 3 вспышек в секунду */
export const GLITCH_MIN_PERIOD = 0.34;
class Glitch extends Timed {
  bands: { y: number; h: number; dx: number; col: number }[] = [];
  nextChange = 0;
  slices: number;
  shift: number;
  intensity: number;
  constructor(def: FxDef, _args: FxArgs, env: FxEnv) {
    super('glitch', def);
    this.z = 3;
    this.slices = Math.round(num(def.params, 'slices', 8));
    this.shift = num(def.params, 'rgbShiftPx', 10);
    this.intensity = clamp(num(def.params, 'intensity', 0.8), 0, 1);
    env.sceneGlitch(true, this.shift * this.intensity);
  }
  tick(_dt: number, env: FxEnv) {
    if (this.t >= this.nextChange) {
      this.nextChange = this.t + GLITCH_MIN_PERIOD;
      this.bands = Array.from({ length: this.slices }, (_, i) => ({ y: rand(0, env.h), h: rand(4, 36), dx: rand(-1, 1) * this.shift * 3, col: i % 3 }));
    }
  }
  end(env: FxEnv) {
    env.sceneGlitch(false);
  }
  draw(g: CanvasRenderingContext2D, env: FxEnv) {
    // мягкое появление/угасание: без резких вспышек яркости
    const env01 = clamp(Math.min(this.t / 0.08, (this.life - this.t) / 0.15), 0, 1) * this.intensity;
    const cols = ['0,255,230', '255,0,170', '182,255,59'];
    for (const b of this.bands) {
      g.fillStyle = `rgba(${cols[b.col]},${0.28 * env01})`;
      g.fillRect(b.dx, b.y, env.w, b.h);
    }
    g.fillStyle = `rgba(0,0,0,${0.1 * env01})`;
    for (let y = 0; y < env.h; y += 4) g.fillRect(0, y, env.w, 1);
  }
}

// ───────────── skate_sparks: искры из-под лап ─────────────
function skateSparks(def: FxDef, args: FxArgs, env: FxEnv) {
  const p = args.x !== undefined ? at(args, env) : env.anchor('feet');
  const n = Math.round(num(def.params, 'count', 24) * env.lod);
  const color = (def.params.color as string) ?? env.palette.secondary;
  for (let i = 0; i < n; i++) {
    const side = i % 2 ? 1 : -1;
    const a = -Math.PI / 2 + side * rand(0.5, 1.4);
    const sp = rand(250, 650);
    env.parts.spawn({ x: p.x + side * rand(0, 12), y: p.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, g: 1400, drag: 0.96, life: rand(0.35, def.durationMs / 1000), size: rand(2.5, 5), color: i % 3 ? color : '#FFF6B0', shape: i % 4 ? 'dot' : 'spark', twinkle: 30, age: -rand(0, 0.15) });
  }
  return new (class extends Timed {
    draw() {}
  })('skate_sparks', def);
}

// ───────────── tag_spray: граффити баллончиком на стекле ─────────────
class TagSpray extends Timed {
  paint: HTMLCanvasElement;
  pg: CanvasRenderingContext2D;
  pts: Pt[] = [];
  done = 0;
  x: number;
  y: number;
  fade: number;
  color: string;
  lastHiss = -1;
  constructor(def: FxDef, args: FxArgs, env: FxEnv) {
    super('tag_spray', def);
    const text = str(def.params, 'text', 'КОТ');
    this.fade = num(def.params, 'fadeMs', 2000) / 1000;
    this.color = (def.params.color as string) ?? env.palette.secondary;
    const fs = Math.round(Math.min(env.w * 0.24, 120));
    const W = Math.round(fs * text.length * 0.75 + fs * 0.4), H = Math.round(fs * 1.5);
    this.paint = document.createElement('canvas');
    this.paint.width = W;
    this.paint.height = H;
    this.pg = this.paint.getContext('2d')!;
    // маска букв → точки распыления (слева направо)
    const m = document.createElement('canvas');
    m.width = W;
    m.height = H;
    const mg = m.getContext('2d', { willReadFrequently: true })!;
    mg.font = `900 ${fs}px "Arial Black", Impact, system-ui, sans-serif`;
    mg.textAlign = 'center';
    mg.textBaseline = 'middle';
    mg.fillText(text, W / 2, H / 2);
    const data = mg.getImageData(0, 0, W, H).data;
    const step = Math.max(3, Math.round(fs / 22));
    for (let x = 0; x < W; x += step) for (let y = 0; y < H; y += step) if (data[(y * W + x) * 4 + 3] > 128) this.pts.push({ x: x + rand(-1, 1), y: y + rand(-1, 1) });
    const c = args.x !== undefined ? at(args, env) : { x: env.w * rand(0.4, 0.6), y: env.h * rand(0.22, 0.3) };
    this.x = c.x - W / 2;
    this.y = c.y - H / 2;
  }
  tick(_dt: number, env: FxEnv) {
    const drawSec = Math.min(0.9, this.life * 0.4);
    const target = Math.floor(clamp(this.t / drawSec, 0, 1) * this.pts.length);
    const g = this.pg;
    g.fillStyle = this.color;
    for (; this.done < target; this.done++) {
      const p = this.pts[this.done];
      g.globalAlpha = 0.5;
      g.beginPath();
      g.arc(p.x, p.y, rand(3, 5.5), 0, Math.PI * 2);
      g.fill();
      if (Math.random() < 0.25) {
        g.globalAlpha = 0.35;
        g.fillRect(p.x + rand(-9, 9), p.y + rand(-9, 9), 1.6, 1.6);
      }
      // редкие подтёки
      if (Math.random() < 0.012) {
        g.globalAlpha = 0.6;
        g.fillRect(p.x - 1.5, p.y, 3, rand(8, 22));
      }
    }
    g.globalAlpha = 1;
    if (this.done < this.pts.length && this.t - this.lastHiss > 0.5) {
      this.lastHiss = this.t;
      if (this.t > 0.05) env.sound('spray', 0.3);
    }
  }
  draw(g: CanvasRenderingContext2D) {
    const a = clamp((this.life - this.t) / this.fade, 0, 1);
    g.globalAlpha = a;
    g.drawImage(this.paint, this.x, this.y);
    g.globalAlpha = 1;
  }
}

export const HOOLIGAN: Record<string, FxFactory> = {
  claws: (d, a, e) => new Claws(d, a, e),
  gum_bubble: (d, a, e) => new GumBubble(d, a, e),
  gum_splat: (d, a, e) => new GumSplat(d, a, e),
  glitch: (d, a, e) => new Glitch(d, a, e),
  skate_sparks: skateSparks,
  tag_spray: (d, a, e) => new TagSpray(d, a, e),
};

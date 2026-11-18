/** Эффекты Добряка: пар на стекле, рисование по туману, сердечко изнутри, мыльные пузыри, огоньки, сердечки, лапка. */
import { num, bool, type FxDef } from '../catalog';
import { breathFog, heartPoints, pickColor, type FxArgs, type FxEnv, type FxFactory, type Pt } from '../core';
import { Timed, at } from './common';
import { clamp, rand } from '../../core/util';

// ───────────── steam: кот дышит — стекло запотевает пятном ─────────────
class Steam extends Timed {
  p: Pt;
  r: number;
  op: number;
  constructor(def: FxDef, args: FxArgs, env: FxEnv) {
    super('steam', def);
    this.z = 0;
    this.p = at(args, env, env.anchor('mouth'));
    this.r = num(def.params, 'radiusPx', 160);
    this.op = num(def.params, 'opacity', 0.55);
    const fade = num(def.params, 'fadeMs', 3000);
    env.fog.keep(Math.max(0, def.durationMs - fade), fade, 500);
  }
  tick(_dt: number, env: FxEnv) {
    // выдох ~0.6 с: пятно растёт несколькими «затяжками»
    if (this.t < 0.6) breathFog(env.fog, this.p.x + rand(-12, 12), this.p.y + rand(-8, 8), this.r * (0.6 + this.t * 0.7), this.op * 0.22);
  }
  draw() {}
}

// ───────────── steam_draw: ребёнок рисует пальцем по запотевшему стеклу ─────────────
class SteamDraw extends Timed {
  brush: number;
  fade: number;
  lastSqueak = 0;
  constructor(def: FxDef, _args: FxArgs, env: FxEnv) {
    super('steam_draw', def);
    this.z = 0;
    this.brush = num(def.params, 'brushPx', 18);
    this.fade = num(def.params, 'fadeMs', 4000);
    if (!env.fog.visible) {
      // всё стекло запотевает
      for (let i = 0; i < 8; i++) breathFog(env.fog, rand(0, env.w), rand(env.h * 0.1, env.h * 0.95), Math.max(env.w, env.h) * rand(0.25, 0.45), 0.3);
    }
    env.fog.keep(def.durationMs, this.fade, 600);
  }
  pointer(type: 'down' | 'move' | 'up', x: number, y: number, px: number, py: number, env: FxEnv) {
    if (this.stopped || !env.fog.visible) return false;
    if (type === 'move' || type === 'down') {
      env.fog.wipe(x, y, type === 'down' ? x : px, type === 'down' ? y : py, this.brush);
      env.fog.keep(1500, this.fade);
      if (type === 'move' && this.t - this.lastSqueak > 0.35 && Math.hypot(x - px, y - py) > 6) {
        this.lastSqueak = this.t;
        env.sound('finger_squeak', 0.5);
      }
    }
    return true; // пока туман — палец рисует, а не жестикулирует
  }
  draw() {}
}

// ───────────── steam_heart: кот изнутри рисует сердечко на запотевшем стекле (зеркально) ─────────────
class SteamHeart extends Timed {
  pts: Pt[] = [];
  drawn = 0;
  drawMs: number;
  constructor(def: FxDef, args: FxArgs, env: FxEnv) {
    super('steam_heart', def);
    this.z = 0;
    this.drawMs = num(def.params, 'drawMs', 1200);
    const s = Math.min(env.w, env.h) * 0.2;
    // сбоку от головы кота, а не по центру экрана: туман на полэкрана делал кота полупрозрачным на 3–4 с (запись 18.11)
    const c = args.x !== undefined ? at(args, env) : besideHead(env, s);
    // изнутри: сердце наклонено «от себя» и обведено справа налево — снаружи видно зеркальным
    this.pts = heartPoints(c.x, c.y, s, 70, 0.18, true);
    for (let i = 0; i < 7; i++) breathFog(env.fog, c.x + rand(-s, s) * 0.6, c.y + rand(-s, s * 0.8) * 0.6, s * rand(0.55, 0.8), 0.3);
    env.fog.keep(def.durationMs, 2200, 500);
  }
  tick(_dt: number, env: FxEnv) {
    const start = 0.45;
    const target = Math.floor(clamp((this.t - start) / (this.drawMs / 1000), 0, 1) * (this.pts.length - 1));
    while (this.drawn < target) {
      const a = this.pts[this.drawn], b = this.pts[this.drawn + 1];
      env.fog.wipe(b.x, b.y, a.x, a.y, 15);
      this.drawn++;
    }
  }
  draw(g: CanvasRenderingContext2D, env: FxEnv) {
    // «палец» кота изнутри — мягкое пятно в точке рисования
    if (this.drawn > 0 && this.drawn < this.pts.length - 1) {
      const p = this.pts[this.drawn];
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.beginPath();
      g.arc(p.x, p.y, 9, 0, Math.PI * 2);
      g.fill();
    }
    void env;
  }
}

// ───────────── soap_bubbles: пузыри летят к экрану, лопаются по тапу ─────────────
interface Bubble { x: number; y: number; vx: number; vy: number; r: number; R: number; t: number; life: number; hue: number; popped: number }
const bubbleSprite = (() => {
  let c: HTMLCanvasElement | null = null;
  return () => {
    if (c) return c;
    c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    const grd = g.createRadialGradient(64, 64, 40, 64, 64, 63);
    grd.addColorStop(0, 'rgba(255,255,255,0.02)');
    grd.addColorStop(0.75, 'rgba(200,240,255,0.10)');
    grd.addColorStop(0.92, 'rgba(255,200,240,0.45)');
    grd.addColorStop(1, 'rgba(255,255,255,0.0)');
    g.fillStyle = grd;
    g.beginPath();
    g.arc(64, 64, 63, 0, Math.PI * 2);
    g.fill();
    // радужная плёнка
    const lg = g.createLinearGradient(10, 10, 118, 118);
    ['rgba(255,120,200,0.35)', 'rgba(255,230,120,0.3)', 'rgba(120,255,200,0.3)', 'rgba(120,180,255,0.35)'].forEach((col, i) => lg.addColorStop(i / 3, col));
    g.strokeStyle = lg;
    g.lineWidth = 3;
    g.beginPath();
    g.arc(64, 64, 60, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.8)';
    g.beginPath();
    g.ellipse(42, 38, 14, 6, -0.7, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.arc(86, 92, 3.5, 0, Math.PI * 2);
    g.fill();
    return c;
  };
})();

class SoapBubbles extends Timed {
  bubbles: Bubble[] = [];
  tapToPop: boolean;
  constructor(def: FxDef, args: FxArgs, env: FxEnv) {
    super('soap_bubbles', def);
    this.z = 2;
    this.tapToPop = bool(def.params, 'tapToPop', true);
    const n = Math.round(num(def.params, 'count', 12) * Math.max(0.5, env.lod));
    const minR = num(def.params, 'minPx', 20) / 2, maxR = num(def.params, 'maxPx', 70) / 2;
    const m = args.x !== undefined ? at(args, env) : env.anchor('mouth');
    for (let i = 0; i < n; i++) {
      const R = rand(minR, maxR) * 1.6; // растут, приближаясь к стеклу
      this.bubbles.push({
        x: m.x + rand(-8, 8), y: m.y + rand(-6, 6), vx: rand(-90, 90), vy: rand(-150, -40), r: 2, R,
        t: -i * 0.12, life: rand(2.2, def.durationMs / 1000), hue: rand(0, 6), popped: -1,
      });
    }
  }
  update(dt: number, env: FxEnv) {
    this.t += dt;
    for (const b of this.bubbles) {
      b.t += dt;
      if (b.t < 0) continue;
      if (b.popped >= 0) {
        b.popped += dt;
        continue;
      }
      const grow = clamp(b.t / 1.2, 0, 1);
      b.r = 2 + (b.R - 2) * (1 - Math.pow(1 - grow, 3));
      b.vx += Math.sin(b.t * 2 + b.hue) * 30 * dt;
      b.vy += -8 * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (b.t > b.life || b.y < -b.r) this.pop(b, env, false);
    }
    this.bubbles = this.bubbles.filter((b) => b.popped < 0.35);
    return this.bubbles.length > 0 && !this.stopped;
  }
  private pop(b: Bubble, env: FxEnv, byTap: boolean) {
    b.popped = 0;
    if (byTap) env.sound('bubble_pop_small', 0.7);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      env.parts.spawn({ x: b.x + Math.cos(a) * b.r, y: b.y + Math.sin(a) * b.r, vx: Math.cos(a) * 120, vy: Math.sin(a) * 120, g: 300, life: 0.35, size: 2.5, color: 'rgba(220,240,255,0.9)', shape: 'dot', drag: 0.9 });
    }
  }
  pointer(type: 'down' | 'move' | 'up', x: number, y: number, _px: number, _py: number, env: FxEnv) {
    if (type !== 'down' || !this.tapToPop) return false;
    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const b = this.bubbles[i];
      if (b.t < 0 || b.popped >= 0) continue;
      if (Math.hypot(x - b.x, y - b.y) < Math.max(b.r * 1.15, 22)) {
        this.pop(b, env, true);
        return true;
      }
    }
    return false;
  }
  draw(g: CanvasRenderingContext2D) {
    const spr = bubbleSprite();
    for (const b of this.bubbles) {
      if (b.t < 0) continue;
      if (b.popped >= 0) {
        // лопнул: тонкое кольцо расходится
        const k = b.popped / 0.35;
        g.strokeStyle = `rgba(255,255,255,${0.7 * (1 - k)})`;
        g.lineWidth = 1.5;
        g.beginPath();
        g.arc(b.x, b.y, b.r * (1 + k * 0.5), 0, Math.PI * 2);
        g.stroke();
        continue;
      }
      const wob = 1 + 0.04 * Math.sin(b.t * 7 + b.hue);
      g.drawImage(spr, b.x - b.r * wob, b.y - b.r / wob, b.r * 2 * wob, (b.r * 2) / wob);
    }
  }
}

// ───────────── warm_lights: тёплые светлячки вокруг кота ─────────────
class WarmLights extends Timed {
  flies: { a: number; r: number; sp: number; y: number; ph: number; s: number }[] = [];
  color: string;
  drift: number;
  constructor(def: FxDef, _args: FxArgs, env: FxEnv) {
    super('warm_lights', def);
    this.z = 2;
    this.color = (def.params.color as string) ?? env.palette.accent;
    this.drift = num(def.params, 'drift', 0.3);
    const n = Math.round(num(def.params, 'count', 20) * env.lod);
    for (let i = 0; i < n; i++) this.flies.push({ a: rand(0, 6.28), r: rand(0.35, 0.75), sp: rand(0.3, 0.9) * (Math.random() < 0.5 ? -1 : 1), y: rand(0.1, 1.1), ph: rand(0, 6.28), s: rand(0.6, 1.3) });
  }
  draw(g: CanvasRenderingContext2D, env: FxEnv) {
    const b = env.anchor('body');
    const fade = clamp(Math.min(this.t * 1.5, (this.life - this.t) * 1.2), 0, 1);
    const spr = pickSprite(this.color);
    g.globalCompositeOperation = 'lighter';
    for (const f of this.flies) {
      const a = f.a + this.t * f.sp * this.drift * 2;
      const x = b.x + Math.cos(a) * f.r * b.s * 0.7;
      const y = b.y + (0.5 - f.y) * b.s * 0.9 + Math.sin(this.t * 1.3 + f.ph) * b.s * 0.04 * (1 + this.drift);
      const tw = 0.5 + 0.5 * Math.sin(this.t * 3 + f.ph);
      const sz = b.s * 0.07 * f.s * (0.7 + 0.3 * tw);
      g.globalAlpha = fade * (0.35 + 0.65 * tw) * (Math.sin(a) > 0 ? 1 : 0.6);
      g.drawImage(spr, x - sz, y - sz, sz * 2, sz * 2);
    }
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
  }
}
const glowCache = new Map<string, HTMLCanvasElement>();
function pickSprite(color: string) {
  let c = glowCache.get(color);
  if (!c) {
    c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, '#FFFFFF');
    grd.addColorStop(0.18, color);
    grd.addColorStop(0.45, color + '55');
    grd.addColorStop(1, color + '00');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    glowCache.set(color, c);
  }
  return c;
}

// ───────────── hearts_float: сердечки поднимаются над котом ─────────────
function heartsFloat(def: FxDef, args: FxArgs, env: FxEnv) {
  const n = Math.round(num(def.params, 'count', 6));
  const h = args.x !== undefined ? { ...at(args, env), s: env.anchor('head').s } : env.anchor('head');
  const cols = ['#FF6F91', '#FF8FCB', '#FFB3C1', ...env.palette.fx.slice(0, 2)];
  for (let i = 0; i < n; i++)
    env.parts.spawn({
      x: h.x + rand(-h.s * 0.18, h.s * 0.18), y: h.y - h.s * 0.12, vx: rand(-25, 25), vy: rand(-110, -70), g: -10, drag: 0.995,
      life: def.durationMs / 1000 * rand(0.75, 1), size: h.s * rand(0.035, 0.06), color: cols[i % cols.length], shape: 'heart', rot: 0, vr: 0, flutter: 50, age: -i * 0.18,
    });
  return new (class extends Timed {
    draw() {}
  })('hearts_float', def);
}

// ───────────── paw_print: отпечаток лапки на стекле изнутри ─────────────
class PawPrint extends Timed {
  p: Pt;
  fade: number;
  rot = rand(-0.4, 0.4);
  s: number;
  constructor(def: FxDef, args: FxArgs, env: FxEnv) {
    super('paw_print', def);
    this.p = at(args, env, env.anchor('pawR'));
    this.fade = num(def.params, 'fadeMs', 2500) / 1000;
    this.s = Math.max(26, env.anchor('head').s * 0.12);
    env.fog.keep(400, 1200);
  }
  draw(g: CanvasRenderingContext2D) {
    const press = clamp(this.t / 0.15, 0, 1);
    const a = clamp((this.life - this.t) / this.fade, 0, 1) * press;
    const s = this.s;
    g.save();
    g.translate(this.p.x, this.p.y);
    g.rotate(this.rot);
    // изнутри: туманный отпечаток + светлые подушечки
    g.globalAlpha = 0.6 * a;
    g.fillStyle = 'rgba(240,248,255,0.85)';
    g.beginPath();
    g.ellipse(0, s * 0.25, s * 0.5, s * 0.4, 0, 0, Math.PI * 2);
    g.fill();
    for (let i = 0; i < 4; i++) {
      const ang = -Math.PI / 2 + (i - 1.5) * 0.55;
      g.beginPath();
      g.ellipse(Math.cos(ang) * s * 0.62, s * 0.05 + Math.sin(ang) * s * 0.62, s * 0.17, s * 0.21, ang + Math.PI / 2, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 0.35 * a;
    g.strokeStyle = '#ffffff';
    g.lineWidth = 2;
    g.beginPath();
    g.ellipse(0, s * 0.25, s * 0.5, s * 0.4, 0, 0, Math.PI * 2);
    g.stroke();
    g.restore();
  }
}

export const KIND: Record<string, FxFactory> = {
  steam: (d, a, e) => new Steam(d, a, e),
  steam_draw: (d, a, e) => new SteamDraw(d, a, e),
  steam_heart: (d, a, e) => new SteamHeart(d, a, e),
  soap_bubbles: (d, a, e) => new SoapBubbles(d, a, e),
  warm_lights: (d, a, e) => new WarmLights(d, a, e),
  hearts_float: heartsFloat,
  paw_print: (d, a, e) => new PawPrint(d, a, e),
};
void pickColor;

/** точка сбоку от головы кота (с той стороны, где больше места), чтобы эффект на «стекле» не закрывал кота */
function besideHead(env: FxEnv, s: number): Pt {
  const h = env.anchor('head');
  const off = Math.max(s * 1.15, h.s * 0.32 + s * 0.8);
  const right = h.x < env.w / 2;
  const x = clamp(h.x + (right ? off : -off), s * 1.05, env.w - s * 1.05);
  return { x, y: clamp(h.y, env.h * 0.18 + s, env.h * 0.6) };
}

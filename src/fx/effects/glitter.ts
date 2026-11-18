/** Эффекты Блёстки: взрыв и след блёсток, снежный шар по гироскопу, голографический перелив, поцелуй. */
import { num, list, bool, type FxDef } from '../catalog';
import { heartPath, pickColor, type FxArgs, type FxEnv, type FxFactory, type Pt, type Shape } from '../core';
import { Timed, at } from './common';
import { clamp, rand } from '../../core/util';

const SHAPES: Record<string, Shape> = { star: 'star', dot: 'dot', heart: 'heart', spark: 'spark' };

// ───────────── glitter_burst ─────────────
export function glitterBurst(def: FxDef, args: FxArgs, env: FxEnv) {
  const p = at(args, env, env.anchor('head'));
  const n = Math.round(num(def.params, 'count', 90) * env.lod);
  const g = num(def.params, 'gravity', 0.4) * 1200;
  const shapes = list(def.params, 'shapes', ['star', 'dot', 'heart']).map((s) => SHAPES[s] ?? 'spark');
  const life = def.durationMs / 1000;
  for (let i = 0; i < n; i++) {
    const a = rand(0, Math.PI * 2), sp = rand(60, 320); // меньше разлёт: блёстки у точки, а не по всему коту
    const sh = i % 4 === 0 ? 'spark' : shapes[i % shapes.length];
    env.parts.spawn({
      x: p.x, y: p.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 140, g, drag: 0.93,
      life: life * rand(0.45, 1), size: sh === 'dot' ? rand(2.5, 5) : rand(5, 11), color: pickColor(env.palette, i), shape: sh, twinkle: sh === 'spark' ? 22 : 0,
    });
  }
  // вспышка в центре
  env.parts.spawn({ x: p.x, y: p.y, life: 0.25, size: 46, color: '#ffffff', shape: 'glow', vr: 0 });
  return new (class extends Timed {
    draw() {}
  })('glitter_burst', def);
}

// ───────────── glitter_trail: блестящий след за пальцем ─────────────
class GlitterTrail extends Timed {
  pts: Pt[];
  color: string;
  fade: number;
  constructor(def: FxDef, args: FxArgs, env: FxEnv) {
    super('glitter_trail', def);
    const path = args.path?.length ? args.path : [at(args, env)];
    this.pts = path.map((p) => ({ x: p.x, y: p.y }));
    this.color = env.palette.fx[0] ?? '#fff';
    this.fade = num(def.params, 'fadeMs', 1200) / 1000;
    const per = num(def.params, 'perPx', 0.5) * env.lod;
    let acc = 0, ci = 0;
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      acc += d * per;
      while (acc >= 1) {
        acc -= 1;
        const k = Math.random();
        env.parts.spawn({
          x: a.x + (b.x - a.x) * k + rand(-7, 7), y: a.y + (b.y - a.y) * k + rand(-7, 7), vx: rand(-30, 30), vy: rand(-50, 15), g: 70, drag: 0.97,
          life: this.fade * rand(0.6, 1.2), size: rand(3, 8), color: pickColor(env.palette, ci++), shape: ci % 3 ? 'spark' : 'dot', twinkle: 18, age: -i * 0.008,
        });
      }
    }
  }
  draw(g: CanvasRenderingContext2D) {
    const a = clamp(1 - this.t / this.fade, 0, 1);
    if (a <= 0 || this.pts.length < 2) return;
    g.save();
    g.beginPath();
    this.pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.globalCompositeOperation = 'lighter';
    g.strokeStyle = this.color;
    g.globalAlpha = 0.35 * a;
    g.lineWidth = 16 * a + 2;
    g.stroke();
    g.strokeStyle = '#ffffff';
    g.globalAlpha = 0.7 * a;
    g.lineWidth = 3 * a + 1;
    g.stroke();
    g.restore();
  }
}

// ───────────── snow_globe: блёстки кружат и оседают по гироскопу ─────────────
class SnowGlobe extends Timed {
  constructor(def: FxDef, _args: FxArgs, env: FxEnv) {
    super('snow_globe', def);
    const n = Math.round(num(def.params, 'count', 160) * env.lod);
    const settle = num(def.params, 'settleMs', 3500) / 1000;
    for (let i = 0; i < n; i++) {
      const a = rand(0, Math.PI * 2);
      const sp = rand(150, 520);
      const sh: Shape = i % 5 === 0 ? 'star' : i % 2 ? 'flake' : 'dot';
      env.parts.spawn({
        x: rand(0, env.w), y: rand(0, env.h), vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        gg: 160, drag: 0.965, settle: true, flutter: 90, twinkle: sh === 'flake' ? 10 : 0,
        life: settle + rand(0.3, 1.2) + (def.durationMs / 1000 - settle), size: sh === 'dot' ? rand(2, 4) : rand(4, 8), color: pickColor(env.palette, i), shape: sh,
      });
    }
  }
  draw() {}
}

// ───────────── holo_shine: голографический перелив от наклона телефона ─────────────
class HoloShine extends Timed {
  fromGyro: boolean;
  constructor(def: FxDef) {
    super('holo_shine', def);
    this.z = 1.5;
    this.fromGyro = bool(def.params, 'angleFromGyro', true);
  }
  draw(g: CanvasRenderingContext2D, env: FxEnv) {
    const fade = clamp(Math.min(this.t * 5, (this.life - this.t) * 4), 0, 1);
    // положение полосы: по наклону телефона (или просто пробегает, если гироскопа нет)
    const tilt = this.fromGyro && (env.tilt.x || env.tilt.y) ? clamp(0.5 + env.tilt.x * 0.8 + env.tilt.y * 0.4, -0.2, 1.2) : this.k * 1.4 - 0.2;
    const W = env.w, H = env.h;
    const cx = tilt * (W + H) - H * 0.5;
    const grd = g.createLinearGradient(cx - W * 0.45, 0, cx + W * 0.45, H * 0.6);
    const cols = ['255,120,200', '255,230,120', '120,255,200', '120,180,255', '200,140,255'];
    grd.addColorStop(0, 'rgba(255,255,255,0)');
    cols.forEach((c, i) => grd.addColorStop(0.15 + i * 0.15, `rgba(${c},0.32)`));
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.save();
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = fade;
    g.fillStyle = grd;
    g.fillRect(0, 0, W, H);
    g.restore();
  }
}

// ───────────── kiss_print: блестящий отпечаток-сердечко на стекле ─────────────
class KissPrint extends Timed {
  p: Pt;
  color: string;
  s: number;
  rot = rand(-0.3, 0.3);
  sparkT = 0;
  constructor(def: FxDef, args: FxArgs, env: FxEnv) {
    super('kiss_print', def);
    this.p = args.x !== undefined ? at(args, env) : env.anchor('mouth');
    this.color = (def.params.color as string) ?? '#FF8FCB';
    this.s = Math.max(34, env.anchor('head').s * 0.16);
  }
  tick(dt: number, env: FxEnv) {
    this.sparkT += dt;
    if (this.sparkT > 0.12 && this.t < this.life * 0.7) {
      this.sparkT = 0;
      env.parts.spawn({ x: this.p.x + rand(-this.s, this.s) * 0.7, y: this.p.y + rand(-this.s, this.s) * 0.6, life: 0.5, size: rand(3, 6), color: '#ffffff', shape: 'spark', vr: 2, twinkle: 20 });
    }
  }
  draw(g: CanvasRenderingContext2D) {
    const press = clamp(this.t / 0.12, 0, 1);
    const a = clamp((this.life - this.t) / 1.2, 0, 1) * press;
    const s = this.s * (1.15 - 0.15 * press);
    g.save();
    g.translate(this.p.x, this.p.y);
    g.rotate(this.rot);
    g.globalAlpha = 0.75 * a;
    g.fillStyle = this.color;
    // губки: две дуги-«подушечки», сверху сердечком
    g.beginPath();
    g.ellipse(0, -s * 0.12, s * 0.55, s * 0.24, 0, Math.PI, 0);
    g.ellipse(0, -s * 0.06, s * 0.55, s * 0.32, 0, 0, Math.PI);
    g.fill();
    g.globalAlpha = 0.9 * a;
    g.strokeStyle = 'rgba(255,255,255,0.6)';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(-s * 0.5, -s * 0.08);
    g.quadraticCurveTo(0, s * 0.04, s * 0.5, -s * 0.08);
    g.stroke();
    // сердечко-блик сверху
    g.globalAlpha = 0.85 * a;
    g.fillStyle = '#fff';
    heartPath(g, s * 0.55, -s * 0.55, s * 0.18);
    g.fill();
    g.restore();
  }
}

export const GLITTER: Record<string, FxFactory> = {
  glitter_burst: glitterBurst,
  glitter_trail: (d, a, e) => new GlitterTrail(d, a, e),
  snow_globe: (d, a, e) => new SnowGlobe(d, a, e),
  holo_shine: (d) => new HoloShine(d),
  kiss_print: (d, a, e) => new KissPrint(d, a, e),
};

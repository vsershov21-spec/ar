/** Общие эффекты: стук, конфетти, Zzz, звёздочки, волны у ушей, индикаторы интерфейса, кот у стекла. */
import { num, bool, type FxDef } from '../catalog';
import { breathFog, hexA, pickColor, starPath, type FxArgs, type FxEnv, type FxFactory, type FxInstance, type Pt } from '../core';
import { clamp, easeOutBack, rand } from '../../core/util';

/** базовый эффект с временем жизни из durationMs (0 — бессрочно, пока не остановят) */
export abstract class Timed implements FxInstance {
  t = 0;
  stopped = false;
  readonly life: number;
  z = 1;
  constructor(readonly id: string, readonly def: FxDef) {
    this.life = def.durationMs > 0 ? def.durationMs / 1000 : Infinity;
  }
  get k() {
    return clamp(this.t / this.life, 0, 1);
  }
  update(dt: number, env: FxEnv): boolean {
    this.t += dt;
    this.tick(dt, env);
    return !this.stopped && this.t < this.life;
  }
  tick(_dt: number, _env: FxEnv) {}
  abstract draw(g: CanvasRenderingContext2D, env: FxEnv): void;
  stop() {
    this.stopped = true;
  }
}

const at = (args: FxArgs, env: FxEnv, fallback: Pt = env.anchor('head')): Pt => (args.x !== undefined ? { x: args.x, y: args.y ?? env.h / 2 } : fallback);

// ───────────── knock: круги + вмятина + дрожание (без трещин) ─────────────
class Knock extends Timed {
  p: Pt;
  rings: number;
  ringMax: number;
  dent: number;
  constructor(def: FxDef, args: FxArgs, env: FxEnv) {
    super('knock', def);
    this.p = at(args, env, { x: env.w * 0.5, y: env.h * 0.4 });
    this.rings = Math.round(num(def.params, 'rings', 2));
    this.ringMax = num(def.params, 'ringMaxPx', 90);
    this.dent = num(def.params, 'dentDepth', 0.35);
    env.shake(num(def.params, 'shakePx', 3), Math.min(260, def.durationMs * 0.4));
    // два удара костяшками: второй через 0.16 с
    for (let i = 0; i < 2; i++)
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2 + rand(-0.3, 0.3);
        env.parts.spawn({ x: this.p.x, y: this.p.y, vx: Math.cos(a) * 140, vy: Math.sin(a) * 140, life: 0.3, size: 2.5, color: '#fff', shape: 'dot', drag: 0.88, age: -i * 0.16 });
      }
  }
  draw(g: CanvasRenderingContext2D) {
    const { x, y } = this.p;
    // вмятина: стекло чуть «продавлено» — тень по краю и блик в центре, пружинит обратно
    const d = this.dent * Math.max(0, Math.sin(Math.min(1, this.t / 0.5) * Math.PI)) * (1 + 0.3 * Math.sin(this.t * 40) * Math.exp(-this.t * 6));
    if (d > 0.01) {
      const R = 34 + 20 * this.dent;
      const grd = g.createRadialGradient(x - R * 0.2, y - R * 0.2, R * 0.1, x, y, R);
      grd.addColorStop(0, `rgba(255,255,255,${0.35 * d})`);
      grd.addColorStop(0.55, `rgba(255,255,255,${0.05 * d})`);
      grd.addColorStop(0.85, `rgba(0,0,0,${0.28 * d})`);
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd;
      g.beginPath();
      g.arc(x, y, R, 0, Math.PI * 2);
      g.fill();
    }
    for (let i = 0; i < this.rings; i++) {
      for (let hit = 0; hit < 2; hit++) {
        const tt = this.t - i * 0.09 - hit * 0.16;
        if (tt < 0) continue;
        const kk = clamp(tt / (this.life * 0.75), 0, 1);
        if (kk >= 1) continue;
        g.strokeStyle = `rgba(255,255,255,${0.85 * (1 - kk) * (hit ? 0.7 : 1)})`;
        g.lineWidth = 3 * (1 - kk) + 0.5;
        g.beginPath();
        g.arc(x, y, 10 + this.ringMax * (1 - Math.pow(1 - kk, 2.2)), 0, Math.PI * 2);
        g.stroke();
      }
    }
  }
}

// ───────────── confetti ─────────────
class Confetti extends Timed {
  constructor(def: FxDef, _args: FxArgs, env: FxEnv) {
    super('confetti', def);
    const n = Math.round(num(def.params, 'count', 80) * env.lod);
    const cols = [...env.palette.fx, '#21A038', '#FFFFFF'];
    for (let i = 0; i < n; i++) {
      const fromLeft = i % 2 === 0;
      env.parts.spawn({
        // с краёв экрана и не к центру: кот посередине, конфетти не закрывает морду (QA: было 80 штук через весь экран)
        x: fromLeft ? rand(-10, env.w * 0.1) : rand(env.w * 0.9, env.w + 10), y: rand(env.h * 0.6, env.h * 0.88),
        vx: (fromLeft ? 1 : -1) * rand(50, 200), vy: -rand(600, 950), g: 900, drag: 0.955,
        life: def.durationMs / 1000 * rand(0.8, 1.15), size: rand(8, 14), color: cols[i % cols.length], shape: 'rect', vr: rand(-8, 8), flutter: 160,
      });
    }
  }
  draw() {}
}

// ───────────── zzz над спящим котом ─────────────
class Zzz extends Timed {
  zs: { t: number; dx: number; s: number }[] = [];
  next = 0;
  loop: boolean;
  constructor(def: FxDef) {
    super('zzz', def);
    this.z = 2;
    this.loop = bool(def.params, 'loop', true);
  }
  update(dt: number, env: FxEnv) {
    this.t += dt;
    if (!this.stopped && (this.loop || this.t < this.life) && this.t >= this.next) {
      this.zs.push({ t: 0, dx: rand(-0.05, 0.05), s: rand(0.8, 1.2) });
      this.next = this.t + 0.8;
    }
    // остановили (кот проснулся, ушли из комнаты) — буквы, что уже летят, тают за ~0,4 с, а не висят 2,4 с
    this.zs.forEach((z) => (z.t += this.stopped ? dt * 6 : dt));
    this.zs = this.zs.filter((z) => z.t < 2.4);
    void env;
    return this.zs.length > 0 || (!this.stopped && (this.loop || this.t < this.life));
  }
  draw(g: CanvasRenderingContext2D, env: FxEnv) {
    const h = env.anchor('head');
    const s = h.s;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const z of this.zs) {
      const k = z.t / 2.4;
      const x = h.x + s * (0.18 + z.dx + k * 0.25) + Math.sin(z.t * 3) * s * 0.03;
      const y = h.y - s * (0.2 + k * 0.5);
      g.globalAlpha = clamp(Math.min(z.t * 3, (1 - k) * 2), 0, 1);
      g.font = `900 ${Math.round(s * 0.09 * (0.6 + k) * z.s)}px -apple-system, system-ui, sans-serif`;
      g.lineWidth = 4;
      g.strokeStyle = 'rgba(20,30,60,0.55)';
      g.strokeText('Z', x, y);
      g.fillStyle = '#fff';
      g.fillText('Z', x, y);
    }
    g.globalAlpha = 1;
  }
}

// ───────────── звёздочки вокруг головы ─────────────
class DizzyStars extends Timed {
  n: number;
  constructor(def: FxDef) {
    super('dizzy_stars', def);
    this.z = 2;
    this.n = Math.round(num(def.params, 'count', 4));
  }
  draw(g: CanvasRenderingContext2D, env: FxEnv) {
    const h = env.anchor('head');
    const R = h.s * 0.22;
    const fade = clamp(Math.min(this.t * 5, (this.life - this.t) * 3), 0, 1);
    for (let i = 0; i < this.n; i++) {
      const a = this.t * 5 + (i / this.n) * Math.PI * 2;
      const x = h.x + Math.cos(a) * R, y = h.y - h.s * 0.17 + Math.sin(a) * R * 0.3;
      const front = Math.sin(a) > 0;
      g.globalAlpha = fade * (front ? 1 : 0.6);
      g.fillStyle = i % 2 ? '#FFD36B' : '#FFFFFF';
      g.strokeStyle = 'rgba(80,60,0,0.5)';
      g.lineWidth = 1.5;
      starPath(g, x, y, h.s * (front ? 0.045 : 0.035), h.s * 0.018, 5);
      g.fill();
      g.stroke();
    }
    g.globalAlpha = 1;
  }
}

// ───────────── волны у ушей (крик) ─────────────
class EarRing extends Timed {
  constructor(def: FxDef) {
    super('ear_ring', def);
    this.z = 2;
  }
  draw(g: CanvasRenderingContext2D, env: FxEnv) {
    for (const side of ['earL', 'earR'] as const) {
      const e = env.anchor(side);
      const dir = side === 'earL' ? -1 : 1;
      for (let i = 0; i < 3; i++) {
        const k = ((this.t * 2.2 + i / 3) % 1);
        g.strokeStyle = `rgba(255,255,255,${0.8 * (1 - k) * (1 - this.k)})`;
        g.lineWidth = 2.5;
        g.beginPath();
        const r = e.s * (0.04 + k * 0.12);
        g.arc(e.x, e.y, r, dir > 0 ? -0.8 : Math.PI - 0.8, dir > 0 ? 0.8 : Math.PI + 0.8);
        g.stroke();
      }
    }
  }
}

// ───────────── echo_wave: индикатор записи у уха (пока не остановят) ─────────────
class EchoWave extends Timed {
  bars: number;
  lv = 0;
  constructor(def: FxDef) {
    super('echo_wave', def);
    this.z = 3;
    this.bars = Math.round(num(def.params, 'bars', 5));
  }
  tick(dt: number, env: FxEnv) {
    this.lv += (env.level() - this.lv) * Math.min(1, dt * 12);
  }
  draw(g: CanvasRenderingContext2D, env: FxEnv) {
    const e = env.anchor('earR');
    const s = e.s;
    const x0 = e.x + s * 0.08, y0 = e.y;
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.beginPath();
    g.roundRect(x0 - 6, y0 - s * 0.07, this.bars * s * 0.03 + 12, s * 0.14, 10);
    g.fill();
    for (let i = 0; i < this.bars; i++) {
      const v = 0.25 + 0.75 * clamp(this.lv * (0.6 + 0.4 * Math.sin(this.t * 13 + i * 1.7)), 0, 1);
      const bh = s * 0.11 * v;
      g.fillStyle = env.palette.fx[i % env.palette.fx.length];
      g.beginPath();
      g.roundRect(x0 + i * s * 0.03, y0 - bh / 2, s * 0.018, bh, 3);
      g.fill();
    }
  }
}

/** прямоугольник видимого элемента интерфейса (или null) */
function uiRect(target: FxArgs['target'], fallbacks: string[]): DOMRect | null {
  const els: (Element | null)[] = [];
  if (target instanceof HTMLElement) els.push(target);
  else if (typeof target === 'string') els.push(document.querySelector(target));
  for (const s of fallbacks) els.push(document.querySelector(s));
  for (const el of els) {
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && !(el as HTMLElement).classList.contains('hidden')) return r;
  }
  return null;
}

// ───────────── listen_ears: «ушки» у кнопки микрофона ─────────────
class ListenEars extends Timed {
  constructor(def: FxDef, readonly args: FxArgs) {
    super('listen_ears', def);
    this.z = 3;
  }
  draw(g: CanvasRenderingContext2D) {
    const r = uiRect(this.args.target, ['.mic']);
    if (!r) return;
    const cx = r.left + r.width / 2, top = r.top;
    const s = r.width * 0.32;
    const wob = Math.sin(this.t * 6) * 0.12;
    g.fillStyle = '#A9B6CC';
    g.strokeStyle = '#fff';
    g.lineWidth = 2;
    for (const side of [-1, 1]) {
      g.save();
      g.translate(cx + side * r.width * 0.28, top + 4);
      g.rotate(side * (0.35 + wob));
      g.beginPath();
      g.moveTo(-s * 0.5, 0);
      g.lineTo(0, -s * 1.1);
      g.lineTo(s * 0.5, 0);
      g.closePath();
      g.fill();
      g.stroke();
      g.fillStyle = '#F3A6B6';
      g.beginPath();
      g.moveTo(-s * 0.25, -2);
      g.lineTo(0, -s * 0.75);
      g.lineTo(s * 0.25, -2);
      g.fill();
      g.fillStyle = '#A9B6CC';
      g.restore();
    }
  }
}

// ───────────── spotlight_button: пульсирующая подсветка кнопки ─────────────
class Spotlight extends Timed {
  pulses: number;
  constructor(def: FxDef, readonly args: FxArgs) {
    super('spotlight_button', def);
    this.z = 3;
    this.pulses = num(def.params, 'pulse', 3);
  }
  draw(g: CanvasRenderingContext2D, env: FxEnv) {
    const r = uiRect(this.args.target, ['.kids:not(.hidden)', '.shakebtn:not(.hidden)', '.mic']);
    if (!r) return;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const R = Math.hypot(r.width, r.height) / 2;
    // затемнение вокруг (лёгкое), светлое окно
    const fade = clamp(Math.min(this.t * 4, (this.life - this.t) * 3), 0, 1);
    const grd = g.createRadialGradient(cx, cy, R * 0.9, cx, cy, Math.max(env.w, env.h));
    grd.addColorStop(0, 'rgba(0,0,0,0)');
    grd.addColorStop(0.15, `rgba(0,0,0,${0.35 * fade})`);
    grd.addColorStop(1, `rgba(0,0,0,${0.45 * fade})`);
    g.fillStyle = grd;
    g.fillRect(0, 0, env.w, env.h);
    const ph = (this.t * this.pulses) / (this.life || 1);
    for (let i = 0; i < 2; i++) {
      const k = (ph + i * 0.5) % 1;
      g.strokeStyle = hexA(env.palette.secondary, (1 - k) * fade);
      g.lineWidth = 4 * (1 - k) + 1;
      g.beginPath();
      g.roundRect(cx - r.width / 2 - k * 22, cy - r.height / 2 - k * 22, r.width + k * 44, r.height + k * 44, Math.min(r.height, r.width) / 2 + k * 22);
      g.stroke();
    }
  }
}

// ───────────── glass_cat: кот прижат к стеклу ─────────────
class GlassCat extends Timed {
  img: HTMLImageElement | null;
  squash: number;
  fogged = false;
  constructor(def: FxDef, args: FxArgs, env: FxEnv) {
    super('glass_cat', def);
    this.img = args.image ?? null;
    this.squash = num(def.params, 'squash', 0.3);
    if (bool(def.params, 'fogAroundNose', true)) env.fog.keep(def.durationMs, 1800, 300);
  }
  tick(_dt: number, env: FxEnv) {
    // запотевание вокруг носа нарастает, пока кот прижат
    if (bool(this.def.params, 'fogAroundNose', true) && this.t < this.life * 0.7 && Math.random() < 0.5) {
      const nose = this.img ? { x: env.w / 2, y: env.h * 0.42 } : env.anchor('mouth');
      breathFog(env.fog, nose.x + rand(-20, 20), nose.y + rand(-10, 20), Math.min(env.w, env.h) * 0.18, 0.08);
    }
  }
  draw(g: CanvasRenderingContext2D, env: FxEnv) {
    const k = this.t / this.life;
    const inK = easeOutBack(clamp(this.t / 0.35, 0, 1));
    const outK = clamp((this.life - this.t) / 0.3, 0, 1);
    const cx = env.w / 2;
    let fy: number;
    if (this.img && this.img.naturalWidth) {
      const img = this.img;
      const H = env.h * 0.95;
      const W = (H * img.naturalWidth) / img.naturalHeight;
      const sq = 1 + this.squash * 0.2 * Math.sin(Math.min(1, k * 3) * Math.PI * 0.5);
      g.save();
      g.globalAlpha = outK;
      g.translate(cx, env.h + H * 0.12 + (1 - inK) * H * 0.6);
      g.scale(sq * 1.04, 1 / sq);
      g.drawImage(img, -W / 2, -H, W, H);
      g.restore();
      fy = env.h - H * 0.68 + (1 - inK) * H * 0.6;
    } else fy = env.anchor('mouth').y;
    // пятна контакта: нос и подушечки лап, прижатые к стеклу изнутри (светлые, с туманным краем)
    const a = 0.55 * outK * inK;
    if (a <= 0.01) return;
    const s = this.img ? env.w * 0.7 : env.anchor('head').s;
    const nose = this.img ? { x: cx, y: fy + 8 } : env.anchor('mouth');
    const spot = (x: number, y: number, rx: number, ry: number) => {
      const grd = g.createRadialGradient(x, y, 0, x, y, rx);
      grd.addColorStop(0, `rgba(255,255,255,${a})`);
      grd.addColorStop(0.6, `rgba(240,248,255,${a * 0.6})`);
      grd.addColorStop(1, 'rgba(240,248,255,0)');
      g.fillStyle = grd;
      g.beginPath();
      g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
      g.fill();
    };
    const sq = 1 + this.squash;
    spot(nose.x, nose.y - s * 0.02, s * 0.05 * sq, s * 0.035 * sq);
    for (const dx of [-1, 1]) spot(nose.x + dx * s * 0.24, nose.y + s * 0.2, s * 0.06 * sq, s * 0.06 * sq);
  }
}

export const COMMON: Record<string, FxFactory> = {
  knock: (d, a, e) => new Knock(d, a, e),
  confetti: (d, a, e) => new Confetti(d, a, e),
  zzz: (d) => new Zzz(d),
  dizzy_stars: (d) => new DizzyStars(d),
  ear_ring: (d) => new EarRing(d),
  echo_wave: (d) => new EchoWave(d),
  listen_ears: (d, a) => new ListenEars(d, a),
  spotlight_button: (d, a) => new Spotlight(d, a),
  glass_cat: (d, a, e) => new GlassCat(d, a, e),
};

export { at, pickColor };

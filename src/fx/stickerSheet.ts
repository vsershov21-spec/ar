/**
 * Наклейки на стекле.
 * Шлепок: наклейка падает на стекло из-под пальца/лапы — большая и в воздухе (тень далеко и мягкая), касается стекла
 * с подпрыгиванием и лёгким доворотом, прогибается (сплющивается и пружинит), тень прижимается. Блик пробегает один раз,
 * дальше стоит и сдвигается только наклоном телефона.
 * Отклеивание: за палец (загибается уголок, обратная сторона серая) или тапом — уголок сам загибается и наклейка улетает.
 * Смена образа: экран заклеивается сериями (кот хлопает лапой), при встряске наклейки рассыпаются волной от центра —
 * у каждой отгибается уголок, и она улетает с вращением к зрителю.
 * На стекле не больше MAX_ON_GLASS; в покое (всё прилипло, телефон не наклоняют) слой не перерисовывается.
 */
import type { StickerSpec } from '../persona/types';
import { renderSticker, stickerImagePending, SHADOW_PAD } from './stickers';
import { collect, MAX_ON_GLASS } from './stickerPack';
import { clamp, easeOutBack, rand } from '../core/util';
import type { Palette, Pt } from './core';

/** длительность шлепка, с */
const SLAP = 0.34;
/** после этого возраста наклейка «в покое» (блик пробежал) */
const SETTLE = 1.4;

interface Detach { t: number; delay: number; dur: number; vx: number; vy: number; vr: number }

export interface Sticker {
  id: number; x: number; y: number; size: number; rot: number; spec: StickerSpec;
  face: HTMLCanvasElement; back: HTMLCanvasElement; shadow: HTMLCanvasElement;
  age: number; peel: number; peelCorner: Pt | null;
  flying: boolean; vx: number; vy: number; vr: number; alpha: number;
  choice?: string; label?: string; slapT: number;
  /** часть «заклеивания» (для stickers_all_gone) */
  cover?: boolean;
  /** авто-отклеивание (эффект sticker_peel без пальца) — секунды с начала */
  autoPeel?: number;
  /** доворот при шлепке, рад (уходит в 0) */
  spin: number;
  /** время полёта, с */
  flyT: number;
  /** отгибается уголок перед полётом (тап, встряска, лишняя наклейка) */
  detach?: Detach;
}

export interface AddOpts { size?: number; rot?: number; mirrored?: boolean; choice?: string; label?: string; palette?: Palette; cover?: boolean; scale?: number }

export class StickerSheet {
  list: Sticker[] = [];
  private nextId = 0;
  private peeling: Sticker | null = null;
  private peelStart = { x: 0, y: 0, t: 0 };
  /** звук/реакция на каждый шлепок */
  onSlap: () => void = () => {};
  /** серия шлепков (кот хлопает лапой) */
  onSeries: () => void = () => {};
  /** все наклейки «заклеивания» отклеены пальцем (без встряски) */
  onAllGone: () => void = () => {};
  w = 0;
  h = 0;
  dpr = 1;
  private coverToken = 0;
  /** картинка догрузилась / состояние сменилось — нужен кадр */
  private dirty = true;
  private drawnTilt = { x: 0, y: 0 };

  add(spec: StickerSpec, x: number, y: number, pal: Palette, o: AddOpts = {}): Sticker {
    const size = (o.size ?? Math.min(this.w, this.h) * rand(0.22, 0.3)) * (o.scale ?? 1);
    const px = Math.round(size * this.dpr);
    const pl = o.palette ?? pal;
    const mirrored = o.mirrored ?? false;
    const art = renderSticker(spec, px, pl, mirrored);
    const st: Sticker = {
      id: ++this.nextId, x, y, size, rot: o.rot ?? rand(-0.3, 0.3), spec, ...art, age: 0, peel: 0, peelCorner: null,
      flying: false, vx: 0, vy: 0, vr: 0, alpha: 1, choice: o.choice, label: o.label, slapT: 0, cover: o.cover,
      spin: rand(0.18, 0.4) * (Math.random() < 0.5 ? -1 : 1), flyT: 0,
    };
    // SVG пака ещё грузится — перерисовать, когда придёт
    stickerImagePending(spec)?.then(() => {
      Object.assign(st, renderSticker(spec, px, pl, mirrored));
      this.dirty = true;
    });
    // лишние (самые старые) уходят: на стекле не больше MAX_ON_GLASS
    const on = this.list.filter((s) => !s.flying && !s.detach && !s.choice);
    for (const s of on.slice(0, Math.max(0, on.length - (MAX_ON_GLASS - 1)))) this.detach(s, 0, 0.18, rand(-500, 500), -700);
    this.list.push(st);
    if (!o.choice) collect(spec);
    this.dirty = true;
    this.onSlap();
    return st;
  }

  /**
   * Заклеить экран изнутри: count (≤ MAX_ON_GLASS) наклеек сериями по 3 (кот хлопает лапой), интервал intervalMs.
   * Сетка 2×4 (в альбомной 4×2) со сдвигом, наклейки крупные — экран закрыт почти без «дыр».
   */
  async cover(specs: StickerSpec[], pal: Palette, count: number, intervalMs: number, rotDeg: [number, number], scale: [number, number]) {
    const token = ++this.coverToken;
    count = clamp(Math.round(count), 1, MAX_ON_GLASS);
    const portrait = this.h >= this.w;
    const cols = portrait ? 2 : 4, rows = portrait ? 4 : 2;
    const cw = this.w / cols, ch = this.h / rows;
    const size = Math.max(cw, ch) * 1.42;
    const cells = Array.from({ length: cols * rows }, (_, i) => i).sort(() => Math.random() - 0.5);
    for (let i = 0; i < count; i++) {
      if (token !== this.coverToken) return;
      if (i % 3 === 0) {
        this.onSeries();
        if (i) await wait(intervalMs * 0.8); // пауза между сериями
        if (token !== this.coverToken) return;
      }
      const c = cells[i % cells.length];
      const cx = ((c % cols) + 0.5) * cw, cy = (Math.floor(c / cols) + 0.5) * ch;
      this.add(specs[i % specs.length], cx + rand(-0.12, 0.12) * cw, cy + rand(-0.12, 0.12) * ch, pal, {
        size, rot: (rand(rotDeg[0], rotDeg[1]) * Math.PI) / 180, scale: rand(scale[0], scale[1]), cover: true,
      });
      await wait(intervalMs);
    }
  }

  /** встряска: наклейки рассыпаются волной от центра — уголок отгибается, наклейка улетает с вращением */
  blow(spin = true) {
    this.coverToken++;
    const cx = this.w / 2, cy = this.h / 2;
    const R = Math.hypot(cx, cy) || 1;
    for (const s of this.list) {
      if (s.flying || s.detach) continue;
      s.cover = false;
      const dx = s.x - cx, dy = s.y - cy;
      const d = Math.hypot(dx, dy) || 1;
      const v = rand(900, 1500);
      this.detach(s, (d / R) * 0.16 + rand(0, 0.06), rand(0.1, 0.16), (dx / d) * v, (dy / d) * v - 300, spin ? rand(-8, 8) : 0, { x: cx, y: cy });
    }
  }

  clear() {
    this.coverToken++;
    this.list = [];
    this.peeling = null;
    this.dirty = true;
  }

  at(x: number, y: number): Sticker | null {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const s = this.list[i];
      if (s.flying || s.detach) continue;
      const { lx, ly } = toLocal(s, x, y);
      if (Math.abs(lx) < s.size * 0.44 && Math.abs(ly) < s.size * 0.44) return s;
    }
    return null;
  }

  /** начать отклеивание: палец на наклейке — тянем за ближний уголок */
  beginPeel(x: number, y: number): boolean {
    const s = this.at(x, y);
    if (!s || s.choice) return false;
    const { lx, ly } = toLocal(s, x, y);
    const h = s.size / 2;
    s.peelCorner = { x: (lx < 0 ? -1 : 1) * h, y: (ly < 0 ? -1 : 1) * h };
    this.peeling = s;
    this.peelStart = { x, y, t: performance.now() };
    this.dirty = true;
    return true;
  }

  dragPeel(x: number, y: number) {
    const s = this.peeling;
    if (!s || !s.peelCorner) return;
    const c = Math.cos(-s.rot), sn = Math.sin(-s.rot);
    const dx = x - this.peelStart.x, dy = y - this.peelStart.y;
    const lx = dx * c - dy * sn, ly = dx * sn + dy * c;
    const d = norm(-s.peelCorner.x, -s.peelCorner.y);
    s.peel = clamp((lx * d.x + ly * d.y) / (s.size * 1.2), 0, 1);
    this.dirty = true;
  }

  /** true — наклейку сорвали (или тапнули: уголок загнётся сам, и она улетит) */
  endPeel(vx = 0, vy = 0): boolean {
    const s = this.peeling;
    this.peeling = null;
    this.dirty = true;
    if (!s) return false;
    if (s.peel > 0.35) {
      this.fly(s, vx || rand(-600, 600), vy || -800);
      return true;
    }
    // короткий тап без протяжки — отклеить за тот же уголок
    if (s.peel < 0.06 && performance.now() - this.peelStart.t < 400 && s.peelCorner) {
      const c = cornerDir(s);
      this.detach(s, 0, 0.22, c.x * rand(450, 700), Math.min(-500, c.y * 600 - 500));
      return true;
    }
    s.peel = 0;
    s.peelCorner = null;
    return false;
  }

  /** отклеить верхнюю наклейку без пальца (эффект sticker_peel) */
  autoPeel(ms = 600) {
    const s = [...this.list].reverse().find((x) => !x.flying && !x.detach && !x.choice && x !== this.peeling);
    if (!s) return false;
    s.peelCorner = { x: s.size / 2, y: s.size / 2 };
    s.autoPeel = 0;
    s.slapT = ms / 1000;
    this.dirty = true;
    return true;
  }

  /** отогнуть уголок (дальний от from, иначе — уже выбранный или правый нижний) и через dur улететь */
  private detach(s: Sticker, delay: number, dur: number, vx: number, vy: number, vr = rand(-6, 6), from?: Pt) {
    if (from) {
      const { lx, ly } = toLocal(s, from.x, from.y);
      s.peelCorner = { x: (lx > 0 ? -1 : 1) * (s.size / 2), y: (ly > 0 ? -1 : 1) * (s.size / 2) };
    } else s.peelCorner ??= { x: s.size / 2, y: s.size / 2 };
    s.detach = { t: 0, delay, dur, vx, vy, vr };
    this.dirty = true;
  }

  private fly(s: Sticker, vx: number, vy: number, vr = rand(-6, 6)) {
    s.detach = undefined;
    s.flying = true;
    s.vx = vx;
    s.vy = vy;
    s.vr = vr;
    s.peel = Math.max(s.peel, 0.3);
    s.peelCorner ??= { x: s.size / 2, y: s.size / 2 };
    if (s.cover) {
      s.cover = false;
      if (!this.list.some((x) => x.cover && !x.flying && !x.detach)) this.onAllGone();
    }
  }

  get isPeeling() {
    return !!this.peeling;
  }

  get coverCount() {
    return this.list.filter((s) => s.cover && !s.flying && !s.detach).length;
  }

  /** всё прилипло, никто не тянет, блик пробежал, наклон тот же — кадр не нужен */
  still(tilt: Pt): boolean {
    if (this.dirty || this.peeling) return false;
    if (Math.abs(tilt.x - this.drawnTilt.x) > 0.004) return false;
    for (const s of this.list) if (s.flying || s.detach || s.autoPeel !== undefined || s.peel > 0 || s.age < SETTLE) return false;
    return true;
  }

  update(dt: number) {
    for (const s of this.list) {
      s.age += dt;
      if (s.autoPeel !== undefined && !s.flying) {
        s.autoPeel += dt;
        s.peel = clamp(s.autoPeel / s.slapT, 0, 1) * 0.5;
        if (s.autoPeel >= s.slapT) {
          s.autoPeel = undefined;
          this.fly(s, rand(-500, 500), -900);
        }
      }
      const d = s.detach;
      if (d && !s.flying) {
        d.t += dt;
        const k = clamp((d.t - d.delay) / d.dur, 0, 1);
        s.peel = Math.max(s.peel, easeOut(k) * 0.42);
        if (k >= 1) this.fly(s, d.vx, d.vy, d.vr);
      }
      if (s.flying) {
        s.flyT += dt;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        s.vy += 1400 * dt;
        s.rot += s.vr * dt;
        s.alpha -= dt * 1.25;
      }
    }
    const n = this.list.length;
    this.list = this.list.filter((s) => s.alpha > 0 && s.y < this.h + s.size * 2);
    if (this.list.length !== n) this.dirty = true;
  }

  draw(g: CanvasRenderingContext2D, tilt: Pt) {
    for (const s of this.list) drawSticker(g, s, tilt);
    this.dirty = false;
    this.drawnTilt = { x: tilt.x, y: tilt.y };
  }
}

const easeOut = (t: number) => 1 - (1 - t) * (1 - t);

const toLocal = (s: Sticker, x: number, y: number) => {
  const c = Math.cos(-s.rot), sn = Math.sin(-s.rot);
  return { lx: (x - s.x) * c - (y - s.y) * sn, ly: (x - s.x) * sn + (y - s.y) * c };
};

/** направление уголка на экране (куда наклейка улетит) */
function cornerDir(s: Sticker): Pt {
  const c = s.peelCorner ?? { x: 1, y: 1 };
  const cs = Math.cos(s.rot), sn = Math.sin(s.rot);
  return norm(c.x * cs - c.y * sn, c.x * sn + c.y * cs);
}

const isHolo = (s: Sticker) => s.spec.kind === 'holo' || /^(g_|w_vau)/.test(s.spec.id ?? '');

function drawSticker(g: CanvasRenderingContext2D, s: Sticker, tilt: Pt) {
  const t = s.age;
  const e = t < SLAP ? easeOutBack(t / SLAP) : 1;
  // высота над стеклом: 1 — в воздухе, 0 — прилипла; отрицательная на отскоке — вдавлена в стекло
  const z = 1 - e;
  // прогиб после касания: сплющивается и пружинит (затухающее колебание)
  const u = t - SLAP * 0.55;
  const wob = u > 0 && u < 0.6 ? 0.075 * Math.exp(-u * 9) * Math.cos(u * 34) : 0;
  const fly = s.flying ? Math.min(1, s.flyT / 0.45) : 0;
  const det = s.detach ? clamp((s.detach.t - s.detach.delay) / s.detach.dur, 0, 1) : 0;
  const lift = Math.max(Math.max(0, z), det * 0.35, s.flying ? 0.35 + 0.65 * fly : 0, s.peel * 0.3);
  const sc = (1 + 0.55 * z) * (1 + 0.28 * fly);
  const rot = s.rot + s.spin * (1 - e);
  const a = clamp(s.alpha, 0, 1) * clamp(t / 0.06, 0, 1);
  const h = s.size / 2;
  const k = s.size / 250;

  // тень на «стене» за стеклом: чем выше наклейка, тем дальше, крупнее и прозрачнее
  const pad = s.size * SHADOW_PAD;
  g.save();
  g.globalAlpha = a * (0.5 - 0.28 * lift);
  g.translate(s.x + (3 + 26 * lift) * k, s.y + (5 + 38 * lift) * k);
  g.rotate(rot);
  g.scale(sc * (1 + 0.1 * lift), sc * (1 + 0.1 * lift));
  g.drawImage(s.shadow, -h - pad, -h - pad, s.size + pad * 2, s.size + pad * 2);
  g.restore();

  g.save();
  g.globalAlpha = a;
  g.translate(s.x, s.y);
  g.rotate(rot);
  g.scale(sc * (1 + wob), sc * (1 - wob));
  if (s.peel > 0 && s.peelCorner) {
    const d = norm(-s.peelCorner.x, -s.peelCorner.y);
    const L = s.peel * s.size * 1.4;
    const kk = s.peelCorner.x * d.x + s.peelCorner.y * d.y + L / 2; // проекция линии сгиба
    g.save();
    g.beginPath();
    halfPlane(g, d, kk, s.size * 2, false);
    g.clip();
    g.drawImage(s.face, -h, -h, s.size, s.size);
    g.restore();
    // загнутый уголок: отражение отклеенной части относительно линии сгиба
    g.save();
    g.transform(1 - 2 * d.x * d.x, -2 * d.x * d.y, -2 * d.x * d.y, 1 - 2 * d.y * d.y, 2 * kk * d.x, 2 * kk * d.y);
    g.beginPath();
    halfPlane(g, d, kk, s.size * 2, true);
    g.clip();
    g.shadowColor = 'rgba(6,40,22,0.35)';
    g.shadowBlur = 10;
    g.drawImage(s.back, -h, -h, s.size, s.size);
    g.restore();
  } else {
    g.drawImage(s.face, -h, -h, s.size, s.size);
    drawGloss(g, s, tilt, a);
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

/**
 * Блик: после шлепка полоса пробегает по наклейке один раз, потом стоит и сдвигается наклоном телефона
 * (голографические — сильнее). Дешёво: белая маска наклейки, обрезанная двумя косыми полосами.
 */
function drawGloss(g: CanvasRenderingContext2D, s: Sticker, tilt: Pt, base: number) {
  const holo = isHolo(s);
  const sweep = s.age > 0.3 && s.age < 1.3;
  const ph = sweep ? -0.7 + (s.age - 0.3) * 2.3 : 0.12 + ((s.id * 0.37) % 0.3) + tilt.x * (holo ? 0.9 : 0.45);
  const amp = sweep ? 1 : holo ? 0.9 : 0.55;
  const h = s.size / 2;
  const mask = whiteMask(s);
  g.globalCompositeOperation = 'lighter';
  for (const [wk, al] of [[0.26, 0.15], [0.1, 0.22]] as const) {
    const x0 = -h + ph * s.size;
    g.save();
    g.beginPath();
    g.moveTo(x0 - s.size * wk, -h);
    g.lineTo(x0 + s.size * wk, -h);
    g.lineTo(x0 + s.size * wk + s.size * 0.5, h);
    g.lineTo(x0 - s.size * wk + s.size * 0.5, h);
    g.closePath();
    g.clip();
    g.globalAlpha = base * al * amp * (holo ? 1.5 : 1);
    g.drawImage(mask, -h, -h, s.size, s.size);
    g.restore();
  }
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = base;
}

const masks = new WeakMap<HTMLCanvasElement, HTMLCanvasElement>();
/** белый силуэт наклейки (для блика), считается один раз */
function whiteMask(s: Sticker) {
  let m = masks.get(s.face);
  if (!m) {
    m = document.createElement('canvas');
    m.width = s.face.width;
    m.height = s.face.height;
    const g = m.getContext('2d')!;
    g.drawImage(s.face, 0, 0);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = '#fff';
    g.fillRect(0, 0, m.width, m.height);
    masks.set(s.face, m);
  }
  return m;
}

function halfPlane(g: CanvasRenderingContext2D, d: Pt, k: number, R: number, negative: boolean) {
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

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

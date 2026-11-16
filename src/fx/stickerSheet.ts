/**
 * Наклейки на стекле: шлепок изнутри (рисунок зеркальный), блик от наклона телефона, отклеивание с угла
 * за палец (загибается уголок, обратная сторона серая), заклеивание экрана сериями, сдувание при встряске.
 */
import type { StickerSpec } from '../persona/types';
import { renderSticker } from './stickers';
import { clamp, easeOutBack, rand } from '../core/util';
import type { Palette, Pt } from './core';

export interface Sticker {
  id: number; x: number; y: number; size: number; rot: number; spec: StickerSpec;
  face: HTMLCanvasElement; back: HTMLCanvasElement;
  age: number; peel: number; peelCorner: Pt | null;
  flying: boolean; vx: number; vy: number; vr: number; alpha: number;
  choice?: string; label?: string; slapT: number;
  /** часть «заклеивания» (для stickers_all_gone) */
  cover?: boolean;
  /** авто-отклеивание (эффект sticker_peel без пальца) */
  autoPeel?: number;
}

export interface AddOpts { size?: number; rot?: number; mirrored?: boolean; choice?: string; label?: string; palette?: Palette; cover?: boolean; scale?: number }

export class StickerSheet {
  list: Sticker[] = [];
  private nextId = 0;
  private peeling: Sticker | null = null;
  private peelStart = { x: 0, y: 0 };
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

  add(spec: StickerSpec, x: number, y: number, pal: Palette, o: AddOpts = {}): Sticker {
    const size = (o.size ?? Math.min(this.w, this.h) * rand(0.22, 0.3)) * (o.scale ?? 1);
    const px = Math.round(size * this.dpr);
    const { face, back } = renderSticker(spec, px, o.palette ?? pal, o.mirrored ?? true);
    const st: Sticker = {
      id: ++this.nextId, x, y, size, rot: o.rot ?? rand(-0.35, 0.35), spec, face, back, age: 0, peel: 0, peelCorner: null,
      flying: false, vx: 0, vy: 0, vr: 0, alpha: 1, choice: o.choice, label: o.label, slapT: 0, cover: o.cover,
    };
    this.list.push(st);
    this.onSlap();
    return st;
  }

  /**
   * Заклеить экран изнутри: count наклеек сериями по 3 (кот хлопает лапой), интервал intervalMs.
   * Ячейки сетки 3×5 со сдвигом — экран закрыт без «дыр».
   */
  async cover(specs: StickerSpec[], pal: Palette, count: number, intervalMs: number, rotDeg: [number, number], scale: [number, number]) {
    const token = ++this.coverToken;
    const cols = 3, rows = 5;
    const cells = Array.from({ length: cols * rows }, (_, i) => i).sort(() => Math.random() - 0.5);
    for (let i = 0; i < count; i++) {
      if (token !== this.coverToken) return;
      if (i % 3 === 0) {
        this.onSeries();
        if (i) await wait(intervalMs * 0.8); // пауза между сериями
      }
      const c = cells[i % cells.length];
      const cx = ((c % cols) + 0.5) / cols, cy = (Math.floor(c / cols) + 0.5) / rows;
      this.add(specs[i % specs.length], cx * this.w + rand(-30, 30), cy * this.h + rand(-30, 30), pal, {
        size: Math.max(this.w, this.h) * 0.28, rot: (rand(rotDeg[0], rotDeg[1]) * Math.PI) / 180, scale: rand(scale[0], scale[1]), cover: true,
      });
      await wait(intervalMs);
    }
  }

  blow(spin = true) {
    this.coverToken++;
    for (const s of this.list) {
      const dx = s.x - this.w / 2, dy = s.y - this.h / 2;
      const d = Math.hypot(dx, dy) || 1;
      s.flying = true;
      s.cover = false;
      s.vx = (dx / d) * rand(900, 1600);
      s.vy = (dy / d) * rand(900, 1600) - 300;
      s.vr = spin ? rand(-8, 8) : 0;
    }
  }

  clear() {
    this.coverToken++;
    this.list = [];
    this.peeling = null;
  }

  at(x: number, y: number): Sticker | null {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const s = this.list[i];
      if (s.flying) continue;
      const { lx, ly } = toLocal(s, x, y);
      if (Math.abs(lx) < s.size * 0.48 && Math.abs(ly) < s.size * 0.48) return s;
    }
    return null;
  }

  /** начать отклеивание: палец у угла наклейки (в пределах 35% от угла) */
  beginPeel(x: number, y: number): boolean {
    const s = this.at(x, y);
    if (!s || s.choice) return false;
    const { lx, ly } = toLocal(s, x, y);
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
    s.peel = clamp((lx * d.x + ly * d.y) / (s.size * 1.2), 0, 1);
  }

  /** true — наклейку сорвали */
  endPeel(vx = 0, vy = 0): boolean {
    const s = this.peeling;
    this.peeling = null;
    if (!s) return false;
    if (s.peel > 0.35) {
      this.fly(s, vx || rand(-600, 600), vy || -800);
      return true;
    }
    s.peel = 0;
    s.peelCorner = null;
    return false;
  }

  /** отклеить верхнюю наклейку без пальца (эффект sticker_peel) */
  autoPeel(ms = 600) {
    const s = [...this.list].reverse().find((x) => !x.flying && !x.choice && x !== this.peeling);
    if (!s) return false;
    s.peelCorner = { x: s.size / 2, y: s.size / 2 };
    s.autoPeel = 0;
    s.slapT = ms / 1000;
    return true;
  }

  private fly(s: Sticker, vx: number, vy: number) {
    s.flying = true;
    s.vx = vx;
    s.vy = vy;
    s.vr = rand(-6, 6);
    if (s.cover) {
      s.cover = false;
      if (!this.list.some((x) => x.cover && !x.flying)) this.onAllGone();
    }
  }

  get isPeeling() {
    return !!this.peeling;
  }

  get coverCount() {
    return this.list.filter((s) => s.cover && !s.flying).length;
  }

  update(dt: number) {
    for (const s of this.list) {
      s.age += dt;
      if (s.autoPeel !== undefined && !s.flying) {
        s.autoPeel += dt;
        s.peel = clamp(s.autoPeel / s.slapT, 0, 1) * 0.5;
        if (s.autoPeel >= s.slapT) this.fly(s, rand(-500, 500), -900);
      }
      if (s.flying) {
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        s.vy += 1400 * dt;
        s.rot += s.vr * dt;
        s.alpha -= dt * 1.2;
      }
    }
    this.list = this.list.filter((s) => s.alpha > 0 && s.y < this.h + s.size * 2);
  }

  draw(g: CanvasRenderingContext2D, tilt: Pt) {
    for (const s of this.list) drawSticker(g, s, tilt);
  }
}

const toLocal = (s: Sticker, x: number, y: number) => {
  const c = Math.cos(-s.rot), sn = Math.sin(-s.rot);
  return { lx: (x - s.x) * c - (y - s.y) * sn, ly: (x - s.x) * sn + (y - s.y) * c };
};

function drawSticker(g: CanvasRenderingContext2D, s: Sticker, tilt: Pt) {
  const slap = s.age < 0.25 ? easeOutBack(s.age / 0.25) : 1;
  const sc = 1.6 - 0.6 * slap;
  g.save();
  g.globalAlpha = clamp(s.alpha, 0, 1) * clamp(s.age / 0.08, 0, 1);
  g.translate(s.x, s.y);
  g.rotate(s.rot);
  g.scale(sc, sc);
  const h = s.size / 2;
  if (s.peel > 0 && s.peelCorner) {
    const d = norm(-s.peelCorner.x, -s.peelCorner.y);
    const L = s.peel * s.size * 1.4;
    const k = s.peelCorner.x * d.x + s.peelCorner.y * d.y + L / 2; // проекция линии сгиба
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
    // блик: полоса бежит сама + сдвигается наклоном телефона (голограмма сильнее).
    // Дешёвый вариант без градиентов: белая маска наклейки, обрезанная двумя полосами (мягкий край).
    const holo = s.spec.kind === 'holo';
    const ph = ((s.age * 0.6 + s.id * 0.37) % 2.2) - 0.6 + tilt.x * (holo ? 0.9 : 0.4);
    const mask = whiteMask(s);
    const base = g.globalAlpha;
    g.globalCompositeOperation = 'lighter';
    for (const [wk, a] of [[0.28, 0.16], [0.12, 0.22]] as const) {
      const x0 = -h + ph * s.size;
      g.save();
      g.beginPath();
      g.moveTo(x0 - s.size * wk, -h);
      g.lineTo(x0 + s.size * wk, -h);
      g.lineTo(x0 + s.size * wk + s.size * 0.5, h);
      g.lineTo(x0 - s.size * wk + s.size * 0.5, h);
      g.closePath();
      g.clip();
      g.globalAlpha = base * a * (holo ? 1.6 : 1);
      g.drawImage(mask, -h, -h, s.size, s.size);
      g.restore();
    }
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = base;
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

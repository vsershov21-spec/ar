/**
 * 2D-слой эффектов поверх камеры («стекло» телефона). Canvas 2D, без зависимостей:
 * PixiJS добавил бы ~450 КБ и второй WebGL-контекст рядом с three.js и tfjs (MindAR),
 * а на iPhone число/память WebGL-контекстов — узкое место. DPR ограничен 2.
 *
 * Эффекты — по каталогу content/fx.json (src/fx/catalog.ts): fx.play(id, { x, y, path, … }).
 * Параметры = fx.json → fxTuning характера → args.params. Неизвестный id — заглушка + строка в лог.
 * Бюджет кадра на эффекты ~4 мс: при превышении слой сам снижает число частиц (lod).
 */
import type { StickerSpec } from '../persona/types';
import { resolveFx, setFxCatalogLogger, num, range, bool, type FxTuning, type FxParams } from './catalog';
import { Particles, Surface, breathFog, type AnchorName, type FxArgs, type FxEnv, type FxFactory, type FxInstance, type Palette, type Pt } from './core';
import { StickerSheet, type AddOpts, type Sticker } from './stickerSheet';
import { coverSet, nextRandom, editionStickers, LEGACY, PACK, packSpec, MAX_ON_GLASS } from './stickerPack';
import { feature } from '../config/edition';
import { preloadStickerImage } from './stickers';
import { COMMON } from './effects/common';
import { KIND } from './effects/kind';
import { GLITTER } from './effects/glitter';
import { HOOLIGAN } from './effects/hooligan';
import { clamp, rand } from '../core/util';
import { isMobileDevice } from '../core/energy';

export type { Sticker } from './stickerSheet';
export type { FxArgs } from './core';

const FACTORIES: Record<string, FxFactory> = { ...COMMON, ...KIND, ...GLITTER, ...HOOLIGAN };
/** эффекты «от кота» (дыхание, поцелуй, лапка) — место берут у кота, а не в точке касания */
const CAT_ANCHORED = new Set(['steam', 'kiss_print', 'paw_print', 'steam_heart']);
/** эффекты, которые делает лист наклеек (не FxInstance) */
const STICKER_FX = new Set(['sticker', 'sticker_peel', 'stickers_cover', 'stickers_blow']);

export interface FxHandle {
  id: string;
  /** закончился (или сразу, если заглушка) */
  done: Promise<void>;
  stop(): void;
}

interface Live { inst: FxInstance; resolve: () => void }

export class FxLayer {
  readonly canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  w = 0;
  h = 0;
  private dpr = 1;
  private live: Live[] = [];
  private capture: FxInstance | null = null;
  private time = 0;
  readonly parts = new Particles();
  readonly fog = new Surface();
  readonly gum = new Surface();
  readonly sheet = new StickerSheet();
  private scene: HTMLElement | null = null;
  private shakeT = 0;
  private shakeDur = 0;
  private shakePx = 0;
  private tilt = { x: 0, y: 0 };
  private tiltRaw = { x: 0, y: 0 };
  private grav = { x: 0, y: 1 };
  private sensors = false;
  /** среднее время кадра слоя, мс (debug) */
  frameMs = 0;
  /** качество 0.35..1 */
  lod = 1;
  palette: Palette = { primary: '#111', secondary: '#B6FF3B', accent: '#FF6FB5', fx: ['#fff'] };
  tuning: FxTuning = {};
  /** тематические наклейки текущего кота (meta.json → stickers, пак СберКота) */
  stickerSpecs: StickerSpec[] = feature('stickers.pack') ? PACK.slice(0, 3).map(packSpec) : LEGACY.kind;
  /** экранная точка части кота (задаёт app по Stage); по умолчанию — центр экрана */
  anchorFn: (name: AnchorName) => Pt & { s: number } = () => ({ x: this.w / 2, y: this.h * 0.45, s: this.h * 0.4 });
  /**
   * «Кот у стекла» (glass_cat): app отдаёт картинку позы (спрайт-режим, кот на карте прячется)
   * или сам переносит 3D-кота к стеклу на ms и возвращает null.
   */
  glassCatHook: (ms: number) => HTMLImageElement | null = () => null;
  /** уровень микрофона 0..1 */
  levelFn: () => number = () => 0;
  onGlitch: (on: boolean) => void = () => {};
  onSound: (id: string, vol?: number) => void = () => {};
  onLog: (s: string) => void = (s) => console.warn(s);
  private env: FxEnv;

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'fx-layer';
    parent.appendChild(this.canvas);
    this.g = this.canvas.getContext('2d')!;
    setFxCatalogLogger((m) => this.onLog(m));
    const self = this;
    this.env = {
      get w() { return self.w; },
      get h() { return self.h; },
      get dpr() { return self.dpr; },
      get t() { return self.time; },
      get palette() { return self.palette; },
      get tilt() { return self.tilt; },
      get gravity() { return self.grav; },
      get lod() { return self.lod; },
      anchor: (n) => this.anchorFn(n),
      parts: this.parts,
      fog: this.fog,
      gum: this.gum,
      sound: (id, v) => this.onSound(id, v),
      shake: (px, ms) => this.shake(px, ms),
      sceneGlitch: (on, px) => this.sceneGlitch(on, px),
      level: () => this.levelFn(),
      active: (id) => this.live.some((l) => l.inst.id === id),
    };
    this.sheet.onAllGone = () => this.onAllStickersGone();
    // SVG пака — заранее: первая наклейка шлёпается сразу с рисунком
    if (feature('stickers.pack') && typeof Image !== 'undefined') for (const p of PACK) preloadStickerImage(p.src);
  }

  // ───────────── совместимость со старым API ─────────────
  set onSlap(fn: () => void) {
    this.sheet.onSlap = fn;
  }
  get onSlap() {
    return this.sheet.onSlap;
  }
  /** серия шлепков при заклеивании — кот хлопает лапой (app → character.play('sticker_slap')) */
  set onStickerSeries(fn: () => void) {
    this.sheet.onSeries = fn;
  }
  /** все наклейки отклеены пальцем → событие stickers_all_gone */
  onAllStickersGone: () => void = () => {};

  /** 3D-слой (canvas three.js): дрожание и глитч применяются и к нему */
  attachScene(el: HTMLElement) {
    this.scene = el;
  }

  /** характер: палитра, fxTuning, наклейки */
  setPersona(p: { palette?: Palette; fxTuning?: FxTuning; stickers?: StickerSpec[] }) {
    if (p.palette) this.palette = p.palette;
    this.tuning = p.fxTuning ?? {};
    // MVP: пак выключен — прежние наклейки кота (без грубых надписей)
    if (p.stickers?.length) this.stickerSpecs = editionStickers(p.stickers, feature('stickers.pack'));
  }

  resize(w: number, h: number) {
    // телефон: 1,5 (как видео камеры и 3D-слой) — полноэкранный холст на 44% меньше (390×844: 0,74 Мп вместо 1,3 Мп)
    this.dpr = Math.min(isMobileDevice() ? 1.5 : 2, window.devicePixelRatio || 1);
    this.w = w;
    this.h = h;
    this.wasEmpty = false;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.fog.resize(w, h);
    this.gum.resize(w, h);
    Object.assign(this.sheet, { w, h, dpr: this.dpr });
    this.listenSensors();
  }

  get busy() {
    return this.live.some((l) => l.inst.id === 'gum_bubble' || l.inst.id === 'glass_cat') || this.fog.visible;
  }

  /** живые эффекты (debug) */
  get activeIds(): string[] {
    return this.live.map((l) => l.inst.id);
  }

  /** есть живой эффект, подходящий под условие (без массива на каждый кадр, как activeIds) */
  hasLive(pred: (id: string) => boolean): boolean {
    for (const l of this.live) if (pred(l.inst.id)) return true;
    return false;
  }

  // ───────────── главный вход ─────────────
  /**
   * Проиграть эффект по id из content/fx.json. Параметры: fx.json → fxTuning характера → args.params.
   * Неизвестный id — заглушка (handle.done сразу), предупреждение в лог.
   */
  /**
   * Фильтр эффектов: false — эффект не играет (кот спит в кровати «Мира кота»: над спящим только Zzz,
   * без сердечек и пузырей реакций; src/home/bedFlow.ts). null — всё как обычно.
   */
  filter: ((id: string) => boolean) | null = null;

  play(id: string, args: FxArgs = {}): FxHandle {
    if (!id || id === 'none') return doneHandle(id);
    if (this.filter && !this.filter(id)) return doneHandle(id);
    if (args.at && args.x === undefined) args = { ...args, x: args.at.x, y: args.at.y };
    const def = resolveFx(id, this.tuning, args.tuning ? { ...args.tuning, ...args.params } : args.params);
    if (args.durationMs !== undefined) def.durationMs = args.durationMs;
    // мировой слой — всегда у кота (пузыри изо рта, Zzz над головой, искры из-под лап)
    if ((def.layer === 'world' || CAT_ANCHORED.has(id)) && !args.params?.atPoint) args = { ...args, x: undefined, y: undefined, at: undefined };
    if (id === 'glitch') def.durationMs = Math.min(def.durationMs, 1000); // фотосенситивность: не дольше 1 с
    if (args.sound && def.sound && def.sound !== 'none') this.onSound(def.sound);
    if (STICKER_FX.has(id)) return this.playSticker(id, def.params, args, def.durationMs);
    if (id === 'glass_cat' && args.image === undefined) args = { ...args, image: this.glassCatHook(def.durationMs) };
    // пузырь жвачки и реакция могут оба попросить пятна — второй раз не нужен
    if (id === 'gum_splat') {
      const dup = this.live.find((l) => l.inst.id === 'gum_splat' && (l.inst as unknown as { t: number }).t < 0.6);
      if (dup) return { id, done: Promise.resolve(), stop: () => dup.inst.stop?.() };
    }
    const f = FACTORIES[id];
    if (!f) {
      if (!def.stub) this.onLog(`[fx] «${id}» есть в каталоге, но не реализован — заглушка`);
      return doneHandle(id);
    }
    let inst: FxInstance | null = null;
    const make = () => {
      try {
        inst = f(def, args, this.env);
      } catch (e) {
        this.onLog(`[fx] ошибка «${id}»: ${String(e)}`);
      }
    };
    if (args.palette) this.withPalette(args.palette.fx, make);
    else make();
    if (!inst) return doneHandle(id);
    const live: FxInstance = inst;
    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));
    this.live.push({ inst: live, resolve });
    this.live.sort((a, b) => a.inst.z - b.inst.z);
    return { id, done, stop: () => live.stop?.() };
  }

  /** убрать эффекты сразу, без затухания (Zzz при пробуждении, сердечки над засыпающим котом); keep — оставить */
  kill(pred: (id: string) => boolean) {
    const gone = this.live.filter((l) => pred(l.inst.id));
    if (!gone.length) return;
    this.live = this.live.filter((l) => !gone.includes(l));
    if (this.capture && gone.some((l) => l.inst === this.capture)) this.capture = null;
    for (const l of gone) {
      l.inst.stop?.();
      l.resolve();
    }
  }

  /** убрать все частицы (сердечки, искры, пузырьки реакций) — кот засыпает в кровати */
  clearParticles() {
    this.parts.clear();
  }

  /** остановить все экземпляры эффекта (петли: zzz, echo_wave, listen_ears) */
  stop(id: string) {
    for (const l of this.live) if (l.inst.id === id) l.inst.stop?.();
  }

  private playSticker(id: string, p: FxParams, args: FxArgs, durMs: number): FxHandle {
    const s = this.stickerSpecs;
    switch (id) {
      case 'sticker': {
        const x = args.x ?? rand(this.w * 0.25, this.w * 0.75), y = args.y ?? rand(this.h * 0.25, this.h * 0.7);
        const [r0, r1] = range(p, 'rotateDeg', [-18, 18]);
        const [s0, s1] = range(p, 'scale', [0.8, 1.2]);
        // «Чудеса → Наклейки» и реакции кота: случайная из всего пака, не та же, что в прошлый раз
        this.sheet.add(feature('stickers.pack') ? nextRandom() : s[Math.floor(Math.random() * s.length)], x, y, this.palette, { mirrored: bool(p, 'mirrored', false), rot: (rand(r0, r1) * Math.PI) / 180, scale: rand(s0, s1) });
        return doneHandle(id, 400);
      }
      case 'sticker_peel':
        this.sheet.autoPeel(durMs || 600);
        return doneHandle(id, durMs || 600);
      case 'stickers_cover': {
        const n = Math.round(num(p, 'count', MAX_ON_GLASS));
        const done = this.sheet.cover(feature('stickers.pack') ? coverSet(s, n) : s, this.palette, n, num(p, 'intervalMs', 180), range(p, 'rotateDeg', [-18, 18]), range(p, 'scale', [0.9, 1.15]));
        return { id, done, stop: () => this.sheet.blow() };
      }
      case 'stickers_blow':
        this.sheet.blow(bool(p, 'spin', true));
        return doneHandle(id, 1000);
    }
    return doneHandle(id);
  }

  // ───────────── касания: эффекты могут забрать жест ─────────────
  /** true — касание забрал эффект (пузырь лопнул, рисуем по туману, стираем жвачку) */
  pointerDown(x: number, y: number): boolean {
    this.capture = null;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const inst = this.live[i].inst;
      if (inst.pointer?.('down', x, y, x, y, this.env)) {
        this.capture = inst;
        return true;
      }
    }
    return false;
  }
  pointerMove(x: number, y: number, px: number, py: number): boolean {
    if (!this.capture) return false;
    this.capture.pointer?.('move', x, y, px, py, this.env);
    return true;
  }
  pointerUp(x: number, y: number): boolean {
    const c = this.capture;
    this.capture = null;
    c?.pointer?.('up', x, y, x, y, this.env);
    return !!c;
  }

  /** стереть туман/жвачку пальцем (любой drag) */
  wipeFog(x: number, y: number, px?: number, py?: number) {
    if (!this.fog.visible) return false;
    this.fog.wipe(x, y, px ?? x, py ?? y, 16);
    return true;
  }

  get fogActive() {
    return this.fog.visible;
  }

  // ───────────── старые методы (director) — теперь через каталог ─────────────
  burst(x: number, y: number, colors?: string[], n?: number) {
    this.withPalette(colors, () => this.play('glitter_burst', { x, y, params: n ? { count: n } : undefined }));
  }
  trail(path: Pt[], colors?: string[]) {
    this.withPalette(colors, () => this.play('glitter_trail', { path }));
  }
  snowGlobe(colors?: string[]) {
    this.withPalette(colors, () => this.play('snow_globe'));
  }
  knock(x: number, y: number) {
    this.play('knock', { x, y });
  }
  claws(from: Pt, to: Pt) {
    this.play('claws', { x: to.x, y: to.y, from });
  }
  glitch(ms = 500) {
    this.play('glitch', { durationMs: ms });
  }
  /** splat: жвачка прилипает к стеклу — только когда ребёнок сам тыкал в экран (иначе пятна закрывают кота без повода) */
  gumBubble(x: number, y: number, color?: string, splat = true): Promise<void> {
    const h = this.play('gum_bubble', { x, y, params: color ? { color } : undefined });
    if (splat) this.play('gum_splat');
    return h.done;
  }
  steamHeart(): Promise<void> {
    return this.play('steam_heart').done;
  }
  glassCatShow(img: HTMLImageElement, ms = 2600) {
    this.play('glass_cat', { image: img, durationMs: ms });
  }
  private withPalette(colors: string[] | undefined, fn: () => void) {
    if (!colors) return fn();
    const p = this.palette;
    this.palette = { ...p, fx: colors };
    fn();
    this.palette = p;
  }

  // ───────────── наклейки ─────────────
  get stickers(): Sticker[] {
    return this.sheet.list;
  }
  addSticker(spec: StickerSpec, x: number, y: number, opts: AddOpts = {}): Sticker {
    return this.sheet.add(spec, x, y, this.palette, opts);
  }
  /**
   * Заклеить экран при смене образа: specs — тематические наклейки нового кота, к ним 2–3 общих из пака
   * (параметры — fx.json stickers_cover; ms игнорируется, оставлен для совместимости)
   */
  cover(specs: StickerSpec[], palette: Palette, _ms?: number): Promise<void> {
    const p = resolveFx('stickers_cover', this.tuning).params;
    const n = Math.round(num(p, 'count', MAX_ON_GLASS));
    const set = feature('stickers.pack') ? coverSet(specs, n) : editionStickers(specs, false);
    return this.sheet.cover(set, palette, n, num(p, 'intervalMs', 180), range(p, 'rotateDeg', [-18, 18]), range(p, 'scale', [0.9, 1.15]));
  }
  blowStickers() {
    this.sheet.blow(bool(resolveFx('stickers_blow', this.tuning).params, 'spin', true));
  }
  clearStickers() {
    this.sheet.clear();
  }
  stickerAt(x: number, y: number) {
    return this.sheet.at(x, y);
  }
  beginPeel(x: number, y: number) {
    return this.sheet.beginPeel(x, y);
  }
  dragPeel(x: number, y: number) {
    this.sheet.dragPeel(x, y);
  }
  endPeel(vx = 0, vy = 0) {
    return this.sheet.endPeel(vx, vy);
  }
  get isPeeling() {
    return this.sheet.isPeeling;
  }

  /** убрать все эффекты (debug, смена сцены) */
  reset() {
    for (const l of this.live) {
      l.inst.end?.(this.env);
      l.resolve();
    }
    this.live = [];
    this.capture = null;
    this.parts.clear();
    this.fog.clear();
    this.gum.clear();
    this.sheet.clear();
    this.sceneGlitch(false);
  }

  // ───────────── дрожание, глитч, датчики ─────────────
  private shake(px: number, ms: number) {
    if (px <= 0) return;
    this.shakePx = Math.max(this.shakePx * (1 - this.shakeT / (this.shakeDur || 1)), px);
    this.shakeDur = ms / 1000;
    this.shakeT = 0;
  }

  private sceneGlitch(on: boolean, px = 8) {
    this.onGlitch(on);
    if (!this.scene) return;
    this.scene.classList.toggle('glitch', on);
    this.scene.style.setProperty('--gshift', `${Math.round(px)}px`);
  }

  private listenSensors() {
    if (this.sensors || typeof window === 'undefined') return;
    this.sensors = true;
    // наклон: для блика наклеек, голограммы. Разрешение (iOS) запрашивает Input.requestSensors()
    window.addEventListener('deviceorientation', (e) => {
      if (e.beta == null || e.gamma == null) return;
      const ang = screenAngle();
      let gx = clamp(e.gamma / 45, -1, 1), gy = clamp((e.beta - 45) / 45, -1, 1);
      if (ang === 90) [gx, gy] = [gy, -gx];
      else if (ang === 270 || ang === -90) [gx, gy] = [-gy, gx];
      this.tiltRaw = { x: gx, y: gy };
    });
    // «низ» для снежного шара — по акселерометру с гравитацией
    window.addEventListener('devicemotion', (e) => {
      const a = e.accelerationIncludingGravity;
      if (!a || a.x == null || a.y == null) return;
      // экран: x вправо, y вниз; у устройства y вверх
      let x = -a.x, y = a.y;
      const ang = screenAngle();
      if (ang === 90) [x, y] = [y, -x];
      else if (ang === 270 || ang === -90) [x, y] = [-y, x];
      const l = Math.hypot(x, y);
      // телефон лежит плашмя — «вниз» к нижнему краю
      if (l > 2) this.grav = { x: x / l, y: y / l };
    });
  }

  // ───────────── цикл ─────────────
  update(dt: number) {
    const t0 = performance.now();
    dt = Math.min(dt, 0.05);
    this.time += dt;
    this.tilt.x += (this.tiltRaw.x - this.tilt.x) * Math.min(1, dt * 8);
    this.tilt.y += (this.tiltRaw.y - this.tilt.y) * Math.min(1, dt * 8);
    const keep: Live[] = [];
    for (const l of this.live) {
      let alive = false;
      try {
        alive = l.inst.update(dt, this.env);
      } catch (e) {
        this.onLog(`[fx] ошибка «${l.inst.id}»: ${String(e)}`);
      }
      if (alive) keep.push(l);
      else {
        l.inst.end?.(this.env);
        if (this.capture === l.inst) this.capture = null;
        l.resolve();
      }
    }
    this.live = keep;
    this.parts.update(dt, this.env);
    this.fog.update(dt);
    this.gum.update(dt);
    this.sheet.update(dt);
    // дрожание стекла (и кота за ним)
    if (this.shakeDur > 0) {
      this.shakeT += dt;
      const k = 1 - this.shakeT / this.shakeDur;
      const tr = k > 0 ? `translate(${(rand(-1, 1) * this.shakePx * k).toFixed(1)}px,${(rand(-1, 1) * this.shakePx * k).toFixed(1)}px)` : '';
      this.canvas.style.transform = tr;
      if (this.scene) this.scene.style.transform = tr;
      if (k <= 0) this.shakeDur = 0;
    }
    this.cost += performance.now() - t0;
  }
  private cost = 0;

  /** прошлый кадр слоя был пуст (холст уже чистый) */
  private wasEmpty = false;
  /** прошлый кадр — только наклейки в покое (следующий такой же можно не рисовать) */
  private sheetStill = false;

  draw() {
    const t0 = performance.now();
    const g = this.g;
    // нечего рисовать и холст уже чистый — не трогаем его: браузер не перекомпонует полноэкранный слой каждый кадр
    const onlySheet = !this.live.length && !this.parts.list.length && !this.fog.visible && !this.gum.visible;
    const empty = onlySheet && !this.sheet.list.length;
    // на стекле только наклейки и они в покое (прилипли, блик пробежал, наклон тот же) — кадр уже нарисован
    if ((empty && this.wasEmpty) || (onlySheet && !empty && this.sheetStill && this.sheet.still(this.tilt))) {
      this.cost = 0;
      this.frameMs += (0 - this.frameMs) * 0.1;
      if (this.frameMs < 2.5 && this.lod < 1) this.lod = Math.min(1, this.lod + 0.005);
      this.parts.cap = Math.round(900 * this.lod);
      return;
    }
    this.wasEmpty = empty;
    this.sheetStill = onlySheet && !empty && this.sheet.still(this.tilt);
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    const env = this.env;
    // туман и жвачка — прямо на стекле, под остальным
    let i = 0;
    const L = this.live;
    for (; i < L.length && L[i].inst.z < 1; i++) L[i].inst.draw(g, env);
    this.fog.draw(g, this.w, this.h);
    this.gum.draw(g, this.w, this.h);
    for (; i < L.length && L[i].inst.z < 1.5; i++) L[i].inst.draw(g, env);
    this.sheet.draw(g, this.tilt);
    for (; i < L.length && L[i].inst.z < 3; i++) L[i].inst.draw(g, env);
    this.parts.draw(g, env);
    for (; i < L.length; i++) L[i].inst.draw(g, env);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    // бюджет: EMA времени кадра слоя → качество
    const ms = this.cost + (performance.now() - t0);
    this.cost = 0;
    this.frameMs += (ms - this.frameMs) * 0.1;
    if (this.frameMs > 4 && this.lod > 0.35) this.lod = Math.max(0.35, this.lod - 0.02);
    else if (this.frameMs < 2.5 && this.lod < 1) this.lod = Math.min(1, this.lod + 0.005);
    this.parts.cap = Math.round(900 * this.lod);
  }

  /** «дыхнуть» на стекло (используется glass_cat / steam) */
  breathe(x: number, y: number, r: number, opacity = 0.3) {
    breathFog(this.fog, x, y, r, opacity);
    this.fog.keep(1500, 2000);
  }
}

function doneHandle(id: string, ms = 0): FxHandle {
  return { id, done: ms ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve(), stop: () => undefined };
}

function screenAngle(): number {
  return (screen.orientation?.angle ?? (window as any).orientation ?? 0) as number;
}

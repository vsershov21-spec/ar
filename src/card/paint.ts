/**
 * Раскраска карты (feature 'card.paint': pilot и lab — да, mvp — нет; документ «конструкция MVP для пилота»).
 *
 * Вход: кот сам предлагает «Хочешь, раскрашу твою карту?» (раз за сессию, после ≥ 90 с игры или после игры, не в первую
 * минуту; чипы «Раскрась! / Не сейчас»), пункт каталога «Раскрасить карту» (вкладка «Образ»), голос «раскрась /
 * нарисуй на карте». Только когда кот стоит на карте (AR, карта захвачена); дома или без карты — «Сначала покажи мне карту».
 * Выбор: лист с тремя кружками палитры кота (миниатюра рисунка) и «Не надо».
 * Рисование: поверх плоскости карты (чуть выше, без z-fight) — сетка размером с карту, рисунок кота (paintArt.ts) под
 * маской; маска проявляется змейкой из трёх рядов (paintPlan.ts paintRows) за 5–8 с, кончик мазка — у лапы кота, который
 * идёт по карте с кистью (Хулиган — с баллончиком; реквизит PropRig.hold), на концах рядов — клип paint_brush /
 * paint_spray (опоры breath_draw / scratch_glass до Meshy). Брызги, капли и блёстки — частицы на плоскости карты.
 * Финиш: «Та-да!» (paint_done) и маленький салют. Рисунок остаётся на сессию и возвращается на следующем визите
 * (память {pattern, color, seed}: sber-ar-cat:paint → прогресс на сервере), виден сразу при посадке на карту.
 * Новый рисунок закрывает старый; «Стереть рисунок» — в каталоге. Рисунок непрозрачный: номер карты и имя не видны.
 *
 * Данные карты не читаются и не сохраняются: рисунок строится только из зерна и цвета.
 * Аналитика: paint_offer, paint_start{color}, paint_done, paint_erase. Отладка: ?flow=paint[&swatch=0..2], вкладка «Тест».
 */
import * as THREE from 'three';
import type { Tracker } from '../tracker/types';
import type { Stage } from '../stage';
import type { Character } from '../character/types';
import type { Director } from '../director';
import type { UI } from '../ui/ui';
import type { Audio } from '../audio/audio';
import type { Chip } from '../scenario/suggest';
import type { PersonaId } from '../persona/types';
import { track } from '../analytics';
import { Salute, type BurstShape } from '../fx/salute';
import { drawPattern, patternCanvas } from './paintArt';
import {
  OFFER_SHOW_MS, PAINT_STYLE, PaintOfferRule, catWaypoints, erasePaint, findSwatch, headFromCat, loadPaint, paintBlocked, paintCatalogItems, paintRows, savePaint,
  type PaintRow, type PaintStyle, type PaintWhere, type SavedPaint, type Swatch,
} from './paintPlan';

export interface CardPaintHost {
  root: HTMLElement;
  tracker: Tracker;
  stage: Stage;
  director: Director;
  ui: UI;
  audio: Audio;
  character(): Character | null;
  /** «Мир кота»: active — кот дома (или переход), inRoom — комната на экране */
  home(): { active: boolean; inRoom: boolean } | null;
  /** сцена пробуждения идёт */
  awakeActive(): boolean;
  kickSuggest(): void;
  log(s: string): void;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
}

/** точка входа (app.ts applyEdition, feature('card.paint')) */
export function startCardPaint(h: CardPaintHost): CardPaint {
  return new CardPaint(h);
}

/** игры, после которых кот предлагает раскрасить карту */
const GAMES = new Set(['riddle', 'echo', 'emo', 'rps', 'simon']);
const TEX_W = 1024, TEX_H = 646;
const MASK_W = 512, MASK_H = 323;
/** ряд: не дольше (кот застрял — мазок идёт по времени) */
const ROW_MAX_S = 1.9;
/** разворот на конце ряда: клип «рисует», мазок доходит до края */
const TURN_S = 0.6;
const WALK_IN_MAX_S = 2.2;
const FILL_S = 0.35;
const REACH = 0.36;
const SPAN = 1.12;

type Phase = 'walkIn' | 'row' | 'turn' | 'fill' | 'home';
interface Run {
  style: PaintStyle;
  swatch: Swatch;
  others: Swatch[];
  saved: SavedPaint;
  rows: PaintRow[];
  radius: number;
  half: number;
  way: { x: number; y: number }[][];
  row: number;
  phase: Phase;
  t: number;
  /** всего с начала */
  total: number;
  head: number;
  lastStamp: number | null;
  actT: number;
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L} ]/gu, ' ').replace(/\s+/g, ' ').trim();
const YES = /^(да|давай|ага|хочу|конечно|угу|ок|окей|раскрась|раскрашивай)( |$)/;
const NO = /^(нет|не надо|не хочу|неа|потом|не сейчас|не)( |$)/;

export class CardPaint {
  readonly offer = new PaintOfferRule();
  saved: SavedPaint | null;
  private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  private group = new THREE.Group();
  private overlay: THREE.Mesh | null = null;
  private under: THREE.Mesh | null = null;
  private patCanvas: HTMLCanvasElement | null = null;
  private maskCanvas: HTMLCanvasElement | null = null;
  private maskG: CanvasRenderingContext2D | null = null;
  private maskTex: THREE.CanvasTexture | null = null;
  private fade = 0;
  private erasing = false;
  private run: Run | null = null;
  private sheet: HTMLElement | null = null;
  private sheetTimer = 0;
  private offerUntil = 0;
  private offerCheckT = 0;
  private salute: Salute | null = null;
  private sparks: PaintParticles;
  /** QA и снимки: прогресс текущей раскраски 0…1 */
  progress = 0;

  constructor(private h: CardPaintHost) {
    this.storage = h.storage === undefined ? safeStorage() : h.storage;
    this.saved = loadPaint(this.storage);
    this.group.name = 'card-paint';
    h.tracker.anchor.add(this.group);
    this.sparks = new PaintParticles();
    this.group.add(this.sparks.points);
    if (this.saved) this.showSaved(this.saved);
    const d = h.director;
    d.on('phase', (ph) => {
      if (ph === 'play' || ph === 'free') this.offer.begin(performance.now());
    });
    d.on('game', (g) => {
      if (!g.start && GAMES.has(g.id)) this.offer.gameEnd();
    });
    // голос: «раскрась карту»; «да / нет» на предложение кота и на лист цветов
    const prev = d.intentGate;
    d.intentGate = (heard, st) => this.onIntent(heard.type, heard.text ?? '') || (prev ? prev(heard, st) : false);
    // карта ушла посреди раскраски — дорисовываем сразу (кот не висит с кистью над пустотой)
    h.tracker.onLost(() => {
      if (this.run) this.finishNow('карта потеряна');
    });
    if (typeof window !== 'undefined') (window as unknown as { __paint?: CardPaint }).__paint = this;
    h.log(`раскраска карты: готова${this.saved ? ` (сохранённый рисунок ${this.saved.pattern}/${this.saved.color})` : ''}`);
  }

  /** идёт раскраска или салют — энергобюджет «действие» (app.ts) */
  get busy() {
    return !!this.run || !!this.salute?.active || this.sparks.active;
  }
  get painting() {
    return !!this.run;
  }
  get sheetOpen() {
    return !!this.sheet;
  }

  // ───────────── вход ─────────────

  where(): PaintWhere {
    const h = this.h, tr = h.tracker as Tracker & { isLocked?: boolean };
    const home = h.home();
    return {
      home: !!home?.active,
      tracking: tr.isTracking,
      locked: tr.isLocked ?? tr.isTracking,
      catOnCard: h.stage.root.visible && !h.stage.atGlass && !h.awakeActive() && h.director.state.appeared,
    };
  }

  /** каталог, голос, чип «Раскрась!», флоу: открыть лист цветов (или «Сначала покажи мне карту») */
  request(source: string): boolean {
    if (this.run) return false;
    this.offerUntil = 0;
    this.offer.done();
    if (paintBlocked(this.where())) {
      this.h.log(`раскраска (${source}): нельзя — кот не на карте ${JSON.stringify(this.where())}`);
      this.closeSheet();
      if (!this.line('paint_need_card')) this.bubble('Сначала покажи мне карту!');
      return false;
    }
    this.h.log(`раскраска (${source}): выбираем цвет`);
    this.openSheet();
    this.line(this.saved ? 'paint_again' : 'paint_choose');
    return true;
  }

  /** чипы предложения: paint:yes / paint:no */
  act(id: string): boolean {
    if (id === 'paint:yes') return this.request('chip');
    if (id === 'paint:no') {
      this.offerUntil = 0;
      this.h.kickSuggest();
      return true;
    }
    return false;
  }

  chips(base: Chip[]): Chip[] {
    if (this.run || this.sheet) return [];
    if (performance.now() > this.offerUntil) return base;
    return [
      { id: 'paint:yes', label: 'Раскрась!', icon: 'paint', run: { say: '' } },
      { id: 'paint:no', label: 'Не сейчас', icon: 'no', run: { say: '' } },
    ];
  }

  /** пункты каталога (вкладка «Образ») */
  catalogItems() {
    return paintCatalogItems(!!this.saved);
  }

  private onIntent(type: string, text: string): boolean {
    if (type === 'paint_card') {
      this.request('voice');
      return true;
    }
    const t = norm(text);
    if (this.sheet) {
      if (type === 'no' || NO.test(t)) {
        this.closeSheet();
        return true;
      }
      return false;
    }
    if (performance.now() < this.offerUntil) {
      if (type === 'yes' || YES.test(t)) {
        this.request('voice-yes');
        return true;
      }
      if (type === 'no' || NO.test(t)) return this.act('paint:no');
    }
    return false;
  }

  /** касание кота посреди раскраски — съедено (кот не бросает кисть ради «ой, щекотно») */
  onTouch(): boolean {
    return !!this.run;
  }

  // ───────────── предложение кота ─────────────

  private offerTick(now: number) {
    const d = this.h.director, st = d.state;
    const free =
      (st.phase === 'play' || st.phase === 'free') && !st.dialog && !st.paused && !d.dozing && !d.queue.busy && !this.h.stage.walking &&
      !this.sheet && !this.run && paintBlocked(this.where()) === null && d.ladder.quietFor(now) > 3500 && !this.h.ui.isCatalogOpen;
    if (!this.offer.due(now, free)) return;
    this.offer.mark();
    this.offerUntil = now + OFFER_SHOW_MS;
    track('paint_offer', {});
    this.line(this.saved ? 'paint_again' : 'paint_offer');
    this.h.log('раскраска: кот предлагает раскрасить карту');
    this.h.kickSuggest();
  }

  // ───────────── лист цветов ─────────────

  private openSheet() {
    this.closeSheet();
    injectCss();
    const style = this.style();
    this.h.ui.closeCatalog();
    const el = document.createElement('div');
    el.className = 'paint-sheet';
    el.setAttribute('role', 'dialog');
    el.innerHTML = `<div class="ps-head"><span class="ps-title">Выбери цвет</span><button type="button" class="ps-no">Не надо</button></div><div class="ps-row"></div>`;
    const row = el.querySelector('.ps-row')!;
    const seed = (Math.random() * 2 ** 32) >>> 0;
    style.swatches.forEach((sw, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ps-sw';
      b.dataset.i = String(i);
      b.style.setProperty('--sw', sw.main);
      const img = document.createElement('img');
      img.alt = '';
      try {
        img.src = patternCanvas(220, 139, style.pattern, sw, style.swatches.filter((s) => s !== sw), seed + i).toDataURL('image/png');
      } catch {
        /* холст недоступен — просто цветной кружок */
      }
      b.appendChild(img);
      const lb = document.createElement('span');
      lb.textContent = sw.label;
      b.appendChild(lb);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.start(i, seed + i);
      });
      row.appendChild(b);
    });
    el.querySelector('.ps-no')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeSheet();
    });
    for (const t of ['pointerdown', 'pointerup', 'touchstart']) el.addEventListener(t, (e) => e.stopPropagation());
    this.h.root.appendChild(el);
    this.sheet = el;
    this.h.kickSuggest();
    clearTimeout(this.sheetTimer);
    this.sheetTimer = window.setTimeout(() => this.closeSheet(), 20_000);
  }

  closeSheet() {
    clearTimeout(this.sheetTimer);
    if (!this.sheet) return;
    const el = this.sheet;
    this.sheet = null;
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
    this.h.kickSuggest();
  }

  private style(): PaintStyle {
    return PAINT_STYLE[this.h.director.persona.id as PersonaId] ?? PAINT_STYLE.hooligan;
  }

  // ───────────── рисование ─────────────

  /** начать раскраску цветом i палитры кота (лист, флоу ?flow=paint&swatch=i, вкладка «Тест») */
  start(i: number, seed = (Math.random() * 2 ** 32) >>> 0): boolean {
    this.closeSheet();
    if (this.run) return false;
    if (paintBlocked(this.where())) {
      this.request('start');
      return false;
    }
    const style = this.style();
    const swatch = style.swatches[Math.max(0, Math.min(2, i | 0))];
    const others = style.swatches.filter((s) => s !== swatch);
    const saved: SavedPaint = { pattern: style.pattern, color: swatch.id, seed: seed >>> 0 };
    // старый рисунок остаётся под новым, пока новый не закроет карту
    if (this.overlay && this.saved && !this.erasing) this.keepUnder();
    this.buildOverlay(saved, swatch, others, 0);
    const { rows, radius, half } = paintRows(this.h.tracker.aspect);
    this.run = {
      style, swatch, others, saved, rows, radius, half, way: catWaypoints(this.h.tracker.aspect, REACH),
      row: 0, phase: 'walkIn', t: 0, total: 0, head: -rows[0].dir * (SPAN / 2), lastStamp: null, actT: 0,
    };
    this.progress = 0;
    this.erasing = false;
    this.offer.done();
    track('paint_start', { color: swatch.id });
    this.h.log(`раскраска: ${style.pattern} / ${swatch.id}, зерно ${saved.seed}`);
    this.h.character()?.holdProp?.(style.clip, swatch.main);
    this.h.audio.play('pop_appear', 0.4);
    this.line('paint_start');
    this.quiet(performance.now());
    this.walkTo(this.run.way[0][0]);
    this.h.kickSuggest();
    return true;
  }

  /** пройти по карте; дошёл раньше, чем кончился ряд, — стоит и рисует (клип кисти), а не шагает на месте */
  private walkTo(p: { x: number; y: number }, paintOnArrive = true): boolean {
    const arrive = () => {
      const r = this.run;
      if (r && paintOnArrive) this.h.character()?.play(r.style.clip, { loop: true });
    };
    if (this.h.stage.walkTo(new THREE.Vector2(p.x, p.y), arrive)) {
      this.h.character()?.play('walk', { loop: true });
      return true;
    }
    return false;
  }

  private rowStart(r: Run) {
    r.phase = 'row';
    r.t = 0;
    const row = r.rows[r.row];
    r.head = -row.dir * (SPAN / 2);
    r.lastStamp = null;
    if (!this.walkTo(r.way[r.row][1])) this.h.character()?.play(r.style.clip, { loop: true });
    // звук инструмента на каждом ряду
    const a = this.h.audio;
    if (r.style.tool === 'spray') a.play('steam', 0.42);
    else a.play('whoosh', 0.3);
    if (r.style.pattern === 'stars') a.play('sparkle_trail', 0.4);
  }

  private step(r: Run, dt: number) {
    r.t += dt;
    r.total += dt;
    const st = this.h.stage;
    const row = r.rows[r.row];
    if (r.phase === 'walkIn') {
      if (!st.walking || r.t > WALK_IN_MAX_S) this.rowStart(r);
      return;
    }
    if (r.phase === 'row') {
      const fromCat = headFromCat(st.pos.x, REACH);
      const byTime = -row.dir * (SPAN / 2) + row.dir * SPAN * Math.min(1, r.t / ROW_MAX_S);
      const want = row.dir > 0 ? Math.max(r.head, fromCat, byTime) : Math.min(r.head, fromCat, byTime);
      this.paintTo(r, want, dt);
      // ряд кончился: кисть у края карты (кот дошёл) или по времени (кот застрял / не ходит)
      if (row.dir * r.head >= 0.5 || r.t > ROW_MAX_S) {
        r.phase = 'turn';
        r.t = 0;
        if (!st.walking) this.h.character()?.play(r.style.clip, { loop: true });
        if (r.style.tool === 'spray') this.h.audio.play('gum_splat', 0.3);
        this.sparks.burst(r);
      }
      return;
    }
    if (r.phase === 'turn') {
      const edge = row.dir * (SPAN / 2);
      const k = Math.min(1, r.t / (TURN_S * 0.8));
      this.paintTo(r, r.head + (edge - r.head) * k, dt);
      if (r.t >= TURN_S) {
        if (r.row < r.rows.length - 1) {
          r.row++;
          this.rowStart(r);
        } else {
          r.phase = 'fill';
          r.t = 0;
        }
      }
      return;
    }
    if (r.phase === 'fill') {
      // добираем огрехи по краям — карта закрыта целиком
      const g = this.maskG;
      if (g) {
        g.globalAlpha = Math.min(1, (dt / FILL_S) * 1.6);
        g.fillStyle = '#fff';
        g.fillRect(0, 0, MASK_W, MASK_H);
        g.globalAlpha = 1;
        this.maskTex!.needsUpdate = true;
      }
      if (r.t >= FILL_S) {
        this.fullMask();
        r.phase = 'home';
        r.t = 0;
        // кот отходит к краю карты и показывает рисунок («Та-да!»), а не стоит посередине на нём
        const last = r.rows[r.rows.length - 1];
        if (!this.walkTo({ x: last.dir * 0.3, y: Math.min(st.cfg.footY, -0.12) }, false)) r.t = 99;
      }
      return;
    }
    if (r.phase === 'home' && (!st.walking || r.t > 2)) this.finish(r);
  }

  /** довести мазок ряда до x (штампы кистью или баллончиком по маске) */
  private paintTo(r: Run, x: number, dt: number) {
    const g = this.maskG;
    const row = r.rows[r.row];
    if (g && this.maskTex) {
      const from = r.lastStamp ?? r.head - row.dir * 0.02;
      const rpx = (r.radius / (r.half * 2)) * MASK_H;
      const stepX = (rpx * 0.22) / MASK_W;
      if (Math.abs(x - from) > 1e-4 || r.lastStamp === null) {
        const n = Math.max(1, Math.ceil(Math.abs(x - from) / stepX));
        for (let i = 1; i <= n; i++) {
          const cx = from + ((x - from) * i) / n;
          const wob = Math.sin(cx * 11 + r.row * 1.7) * 0.1 + Math.sin(cx * 23 + r.row) * 0.05;
          const cy = row.y + wob * r.radius;
          stamp(g, (cx + 0.5) * MASK_W, ((r.half - cy) / (r.half * 2)) * MASK_H, rpx, r.style.tool);
        }
        this.maskTex.needsUpdate = true;
      }
    }
    r.lastStamp = x;
    r.head = x;
    // кончик мазка — источник брызг/капель/блёсток
    this.sparks.emit(r, x, row.y, dt);
    const along = row.dir > 0 ? (x + SPAN / 2) / SPAN : (SPAN / 2 - x) / SPAN;
    this.progress = Math.max(this.progress, Math.min(1, (r.row + Math.max(0, Math.min(1, along))) / r.rows.length));
  }

  private finish(r: Run) {
    this.run = null;
    this.progress = 1;
    this.fullMask();
    this.dropUnder();
    this.commit(r.saved);
    const ch = this.h.character();
    ch?.holdProp?.(null);
    ch?.play('celebrate');
    this.h.audio.play('chime', 0.7);
    this.celebrate(r);
    this.line('paint_done');
    this.quiet(performance.now());
    track('paint_done', {});
    this.h.log('раскраска: готово — «Та-да!»');
    this.h.kickSuggest();
  }

  /** карта потерялась / кот ушёл домой: дорисовать без праздника */
  finishNow(why: string) {
    const r = this.run;
    if (!r) return;
    this.run = null;
    this.progress = 1;
    this.fullMask();
    this.dropUnder();
    this.commit(r.saved);
    this.h.stage.cancelWalk();
    const ch = this.h.character();
    ch?.holdProp?.(null);
    ch?.play('idle');
    track('paint_done', {});
    this.h.log(`раскраска: дорисовано сразу (${why})`);
    this.h.kickSuggest();
  }

  private commit(s: SavedPaint) {
    this.saved = s;
    savePaint(s, this.storage);
  }

  private celebrate(r: Run) {
    try {
      this.startSalute(r);
    } catch {
      /* без холста 2D (тесты, старый браузер) — без салюта */
    }
  }
  private startSalute(r: Run) {
    if (!this.salute) {
      this.salute = new Salute(this.h.root);
      this.salute.resize(this.h.root.clientWidth || innerWidth, this.h.root.clientHeight || innerHeight);
      this.salute.faceFn = () => {
        const st = this.h.stage;
        if (!st.root.visible) return null;
        const w = this.h.root.clientWidth, hh = this.h.root.clientHeight;
        const head = st.anchorScreen('head', w, hh);
        return { x: head.x, y: head.y, r: head.s * 0.42 };
      };
      this.salute.onBurst = () => this.h.audio.play('pop_appear', 0.25);
    }
    const shapes: Record<string, BurstShape[]> = { graffiti: ['star', 'peony'], hearts: ['heart', 'ring'], stars: ['star', 'ring'] };
    this.salute.start({ size: 'small', shapes: shapes[r.style.pattern], colors: [r.swatch.main, ...r.others.map((o) => o.main), '#FFFFFF'], crackle: r.style.pattern === 'stars' ? 0.8 : 0.3 });
  }

  /** «Стереть рисунок» (каталог) */
  erase(): boolean {
    if (this.run) return false;
    if (!this.saved && !this.overlay) return false;
    erasePaint(this.storage);
    this.saved = null;
    this.erasing = true;
    this.h.audio.play('whoosh', 0.4);
    track('paint_erase', {});
    this.h.log('раскраска: рисунок стёрт');
    this.h.kickSuggest();
    return true;
  }

  /** ?flow=paint[&swatch=0..2]: лист цветов или сразу раскраска (отладка, src/debug/flows.ts) */
  flow(search = location.search) {
    const s = new URLSearchParams(search).get('swatch');
    if (s !== null && /^[0-2]$/.test(s)) this.start(Number(s), 20261118 + Number(s));
    else this.request('flow');
  }

  // ───────────── сетка на карте ─────────────

  private showSaved(s: SavedPaint) {
    const f = findSwatch(s.pattern, s.color);
    if (f) this.buildOverlay(s, f.swatch, f.others, 1);
  }

  private buildOverlay(s: SavedPaint, swatch: Swatch, others: Swatch[], reveal: 0 | 1) {
    if (typeof document === 'undefined') return;
    const aspect = this.h.tracker.aspect;
    if (!this.patCanvas) {
      this.patCanvas = document.createElement('canvas');
      this.patCanvas.width = TEX_W;
      this.patCanvas.height = TEX_H;
      this.maskCanvas = document.createElement('canvas');
      this.maskCanvas.width = MASK_W;
      this.maskCanvas.height = MASK_H;
      this.maskG = this.maskCanvas.getContext('2d');
    }
    const g = this.patCanvas.getContext('2d');
    if (g) drawPattern(g, TEX_W, TEX_H, s.pattern, swatch, others, s.seed);
    if (this.maskG) {
      this.maskG.fillStyle = reveal ? '#fff' : '#000';
      this.maskG.fillRect(0, 0, MASK_W, MASK_H);
    }
    if (!this.overlay) {
      const map = new THREE.CanvasTexture(this.patCanvas);
      map.colorSpace = THREE.SRGBColorSpace;
      map.anisotropy = 4;
      this.maskTex = new THREE.CanvasTexture(this.maskCanvas!);
      const mat = new THREE.MeshBasicMaterial({ map, alphaMap: this.maskTex, transparent: true, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      // чуть больше карты: дрожание трекера не открывает край карты
      this.overlay = new THREE.Mesh(new THREE.PlaneGeometry(1.02, 1.02 / aspect), mat);
      this.overlay.name = 'card-paint-overlay';
      this.overlay.position.z = 0.0015;
      this.overlay.renderOrder = -0.5;
      this.group.add(this.overlay);
    } else (this.overlay.material as THREE.MeshBasicMaterial).map!.needsUpdate = true;
    this.maskTex!.needsUpdate = true;
  }

  private fullMask() {
    if (!this.maskG) return;
    this.maskG.globalAlpha = 1;
    this.maskG.fillStyle = '#fff';
    this.maskG.fillRect(0, 0, MASK_W, MASK_H);
    this.maskTex!.needsUpdate = true;
  }

  /** старый рисунок — копией под новым (новый проявляется поверх) */
  private keepUnder() {
    this.dropUnder();
    if (!this.patCanvas || !this.overlay) return;
    const c = document.createElement('canvas');
    c.width = TEX_W;
    c.height = TEX_H;
    c.getContext('2d')?.drawImage(this.patCanvas, 0, 0);
    const map = new THREE.CanvasTexture(c);
    map.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    this.under = new THREE.Mesh(this.overlay.geometry, m);
    this.under.position.z = 0.001;
    this.under.renderOrder = -0.6;
    this.group.add(this.under);
  }
  private dropUnder() {
    if (!this.under) return;
    this.under.removeFromParent();
    const m = this.under.material as THREE.MeshBasicMaterial;
    m.map?.dispose();
    m.dispose();
    this.under = null;
  }

  // ───────────── кадр ─────────────

  update(dt: number) {
    const now = performance.now();
    const home = this.h.home();
    if (this.run && home?.active) this.finishNow('кот ушёл домой');
    if ((this.offerCheckT += dt) > 0.5) {
      this.offerCheckT = 0;
      this.offerTick(now);
      if (this.offerUntil && now > this.offerUntil) {
        this.offerUntil = 0;
        this.h.kickSuggest();
      }
    }
    const r = this.run;
    if (r) {
      this.step(r, dt);
      // лестница тишины (и зов домой «по тишине») не перебивает художника: кот занят делом
      if ((r.actT += dt) > 1) {
        r.actT = 0;
        this.quiet(now);
      }
    }
    // видимость: рисунок на карте, пока карта в кадре (дома — нет)
    const want = !!this.overlay && !this.erasing && this.h.tracker.isTracking && !home?.inRoom;
    this.fade = Math.max(0, Math.min(1, this.fade + (want ? dt / 0.25 : -dt / (this.erasing ? 0.6 : 0.2))));
    if (this.overlay) {
      (this.overlay.material as THREE.MeshBasicMaterial).opacity = this.fade;
      this.overlay.visible = this.fade > 0.001;
      if (this.under) {
        (this.under.material as THREE.MeshBasicMaterial).opacity = this.fade;
        this.under.visible = this.overlay.visible;
      }
      if (this.erasing && this.fade <= 0) this.removeOverlay();
    }
    this.sparks.update(dt);
    if (this.salute?.active) {
      this.salute.update(dt);
      this.salute.draw();
    }
  }

  resize(w: number, h: number) {
    this.salute?.resize(w, h);
  }

  private removeOverlay() {
    this.erasing = false;
    this.dropUnder();
    if (!this.overlay) return;
    this.overlay.removeFromParent();
    const m = this.overlay.material as THREE.MeshBasicMaterial;
    m.map?.dispose();
    m.alphaMap?.dispose();
    m.dispose();
    this.overlay.geometry.dispose();
    this.overlay = null;
    this.patCanvas = null;
    this.maskCanvas = null;
    this.maskG = null;
    this.maskTex = null;
  }

  private quiet(now: number) {
    const d = this.h.director;
    d.activity();
    d.ladder.reset(now);
  }

  // ───────────── реплики ─────────────

  /** реплика кота: озвученная — голосом, без записи — только пузырём (Director.showLine) */
  private line(event: string): boolean {
    return this.h.director.showLine(event);
  }
  private bubble(text: string) {
    const p = this.h.director.persona;
    this.h.ui.say(text, p.name, p.id, 3200);
  }
}

// ───────────── мазок по маске ─────────────

/** штамп маски: кисть — плотный край с волосками, баллончик — мягкий край и крап за ним */
function stamp(g: CanvasRenderingContext2D, u: number, v: number, r: number, tool: 'spray' | 'brush') {
  if (tool === 'spray') {
    const gr = g.createRadialGradient(u, v, r * 0.55, u, v, r * 1.12);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.beginPath();
    g.arc(u, v, r * 1.12, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fff';
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * Math.PI * 2, d = r * (1 + Math.random() * 0.35);
      g.fillRect(u + Math.cos(a) * d, v + Math.sin(a) * d, 1.6, 1.6);
    }
    return;
  }
  g.fillStyle = '#fff';
  g.beginPath();
  g.arc(u, v, r * (0.96 + Math.random() * 0.06), 0, Math.PI * 2);
  g.fill();
  // волоски кисти — неровный край мазка
  g.strokeStyle = 'rgba(255,255,255,.9)';
  g.lineWidth = 1.4;
  for (let i = 0; i < 3; i++) {
    const s = (Math.random() * 2 - 1) * r * 1.05;
    g.beginPath();
    g.moveTo(u - r * 0.3, v + s);
    g.lineTo(u + r * 0.3, v + s + (Math.random() - 0.5) * 2);
    g.stroke();
  }
}

// ───────────── частицы: брызги, капли, блёстки ─────────────

const MAX_P = 160;
class PaintParticles {
  readonly points: THREE.Points;
  private pos = new Float32Array(MAX_P * 3);
  private col = new Float32Array(MAX_P * 4);
  private vel = new Float32Array(MAX_P * 3);
  private life = new Float32Array(MAX_P);
  private age = new Float32Array(MAX_P);
  private kind = new Uint8Array(MAX_P);
  private base = new Float32Array(MAX_P * 3);
  private cursor = 0;
  private acc = 0;
  private c = new THREE.Color();

  constructor() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.PointsMaterial({ size: 0.03, sizeAttenuation: true, vertexColors: true, transparent: true, depthWrite: false, map: dotTexture(), alphaTest: 0.01 });
    this.points = new THREE.Points(geo, mat);
    this.points.name = 'card-paint-sparks';
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    this.points.visible = false;
  }

  get active() {
    return this.points.visible;
  }

  private spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, color: string, kind: number) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % MAX_P;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.c.set(color);
    this.base[i * 3] = this.c.r;
    this.base[i * 3 + 1] = this.c.g;
    this.base[i * 3 + 2] = this.c.b;
    this.life[i] = life;
    this.age[i] = 0;
    this.kind[i] = kind;
  }

  /** у кончика мазка: баллончик — облачко краски, кисть — капли, звёзды — блёстки */
  emit(r: Run, x: number, y: number, dt: number) {
    this.acc += Math.min(dt, 0.1) * (r.style.tool === 'spray' ? 70 : 26);
    const cols = [r.swatch.main, r.swatch.main, ...r.others.map((o) => o.main), '#ffffff'];
    while (this.acc >= 1) {
      this.acc--;
      const col = cols[Math.floor(Math.random() * cols.length)];
      const a = Math.random() * Math.PI * 2, d = Math.random() * r.radius * 0.8;
      const px = x + Math.cos(a) * d, py = y + Math.sin(a) * d;
      if (r.style.tool === 'spray') this.spawn(px, py, 0.05 + Math.random() * 0.08, (Math.random() - 0.5) * 0.25, (Math.random() - 0.5) * 0.25, -0.15, 0.35 + Math.random() * 0.3, col, 0);
      else if (r.style.pattern === 'stars') this.spawn(px, py, 0.01, (Math.random() - 0.5) * 0.08, (Math.random() - 0.5) * 0.08, 0.12 + Math.random() * 0.12, 0.6 + Math.random() * 0.5, Math.random() < 0.5 ? '#ffffff' : '#FFE38A', 2);
      else this.spawn(px, py, 0.01, (Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.3, 0.25 + Math.random() * 0.25, 0.9, col, 1);
    }
    this.points.visible = true;
  }

  /** конец ряда: всплеск */
  burst(r: Run) {
    const row = r.rows[r.row];
    const x = row.dir * 0.42, y = row.y;
    const cols = [r.swatch.main, ...r.others.map((o) => o.main), '#ffffff'];
    for (let i = 0; i < 22; i++) {
      const a = Math.random() * Math.PI * 2, s = 0.15 + Math.random() * 0.35;
      this.spawn(x, y, 0.02, Math.cos(a) * s, Math.sin(a) * s, 0.3 + Math.random() * 0.4, 0.9, cols[i % cols.length], r.style.pattern === 'stars' ? 2 : 1);
    }
    this.points.visible = true;
  }

  update(dt: number) {
    if (!this.points.visible) return;
    let live = 0;
    for (let i = 0; i < MAX_P; i++) {
      if (this.life[i] <= 0) {
        this.col[i * 4 + 3] = 0;
        continue;
      }
      this.age[i] += dt;
      const k = this.age[i] / this.life[i];
      if (k >= 1) {
        this.life[i] = 0;
        this.col[i * 4 + 3] = 0;
        continue;
      }
      live++;
      const j = i * 3;
      const kind = this.kind[i];
      if (kind === 1) this.vel[j + 2] -= 1.6 * dt; // капли падают на карту
      if (kind === 0) {
        this.vel[j] *= 0.9;
        this.vel[j + 1] *= 0.9;
      }
      this.pos[j] += this.vel[j] * dt;
      this.pos[j + 1] += this.vel[j + 1] * dt;
      this.pos[j + 2] = Math.max(0.003, this.pos[j + 2] + this.vel[j + 2] * dt);
      if (kind === 1 && this.pos[j + 2] <= 0.003) this.life[i] = Math.min(this.life[i], this.age[i] + 0.15);
      const tw = kind === 2 ? 0.55 + 0.45 * Math.sin(this.age[i] * 28 + i) : 1;
      this.col[i * 4] = this.base[j];
      this.col[i * 4 + 1] = this.base[j + 1];
      this.col[i * 4 + 2] = this.base[j + 2];
      this.col[i * 4 + 3] = (1 - k) * tw;
    }
    const geo = this.points.geometry;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    if (!live) this.points.visible = false;
  }
}

function dotTexture(): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  if (!g) return null;
  const gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.45, 'rgba(255,255,255,.9)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

let cssDone = false;
function injectCss() {
  if (cssDone || typeof document === 'undefined') return;
  cssDone = true;
  const s = document.createElement('style');
  s.id = 'paint-css';
  s.textContent = `
.paint-sheet { position: absolute; z-index: 8; left: 50%; bottom: calc(env(safe-area-inset-bottom, 0px) + 100px); transform: translateX(-50%);
  width: min(340px, calc(100% - 24px)); box-sizing: border-box; padding: 10px 12px 8px; border-radius: 24px; pointer-events: auto;
  background: rgba(255, 255, 255, .96); color: #13233a; box-shadow: 0 12px 36px rgba(8, 30, 40, .28), 0 2px 6px rgba(8, 30, 40, .12);
  font: 600 15px/1.2 -apple-system, system-ui, 'SB Sans Text', sans-serif; text-align: center; animation: ps-in .32s cubic-bezier(.2, 1.3, .4, 1); }
.paint-sheet.out { animation: ps-out .2s ease forwards; }
.paint-sheet .ps-head { display: flex; align-items: center; justify-content: space-between; margin: 0 2px 4px 6px; }
.paint-sheet .ps-title { font-size: 16px; font-weight: 800; letter-spacing: .01em; }
.paint-sheet .ps-row { display: flex; justify-content: space-around; gap: 8px; }
.paint-sheet .ps-sw { display: flex; flex-direction: column; align-items: center; gap: 6px; border: 0; background: none; padding: 6px 2px 2px; cursor: pointer;
  font: inherit; font-size: 13px; color: #13233a; -webkit-tap-highlight-color: transparent; }
.paint-sheet .ps-sw img { display: block; width: 60px; height: 60px; border-radius: 50%; object-fit: cover; background: var(--sw);
  box-shadow: 0 0 0 4px #fff, 0 0 0 7px var(--sw), 0 6px 14px rgba(0, 0, 0, .18); transition: transform .18s cubic-bezier(.2, 1.4, .4, 1); }
.paint-sheet .ps-sw:active img { transform: scale(.9); }
.paint-sheet .ps-sw:nth-child(1) img { animation: ps-bob 2.4s ease-in-out infinite; }
.paint-sheet .ps-sw:nth-child(2) img { animation: ps-bob 2.4s ease-in-out .3s infinite; }
.paint-sheet .ps-sw:nth-child(3) img { animation: ps-bob 2.4s ease-in-out .6s infinite; }
.paint-sheet .ps-no { border: 0; background: rgba(19, 35, 58, .07); color: #13233a; font: inherit; font-size: 13px; padding: 7px 14px;
  border-radius: 999px; cursor: pointer; }
@keyframes ps-in { from { opacity: 0; transform: translate(-50%, 24px) scale(.94); } to { opacity: 1; transform: translate(-50%, 0) scale(1); } }
@keyframes ps-out { to { opacity: 0; transform: translate(-50%, 16px) scale(.96); } }
@keyframes ps-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }
`;
  document.head.appendChild(s);
}

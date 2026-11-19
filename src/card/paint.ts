/**
 * Раскраска карты (feature 'card.paint': pilot и lab — да, mvp — нет; документ «конструкция MVP для пилота»).
 *
 * Вход: кот сам предлагает «Хочешь, раскрашу твою карту?» (раз за сессию, после ≥ 90 с игры или после игры, не в первую
 * минуту; чипы «Раскрась! / Не сейчас»), пункт каталога «Раскрасить карту» (вкладка «Образ»), голос «раскрась /
 * нарисуй на карте». Только когда кот стоит на карте (AR, карта захвачена); дома или без карты — «Сначала покажи мне карту».
 * Выбор: лист с тремя кружками палитры кота (миниатюра рисунка) и «Не надо».
 *
 * Рисование — как настоящее граффити / рисунок кистью (paintPlan.ts choreograph):
 *   Хулиган: берёт баллончик → трясёт (звон шарика, 0,8 с) → встаёт у дальнего края карты, приседает и брызгает:
 *     краска летит из сопла конусом брызг, рисунок проявляется ровно там, куда попадает луч сопла (каждый кадр — по
 *     реальному положению сопла после позы, а не рядами); элементы по очереди — тег и обводка, фон и заливка, кляксы,
 *     потёки стекают сами после заливки; переходит ко второй половине (снова трясёт) → отходит, смотрит → звёзды
 *     «пшик-пшик» и стрелки — последний штрих → показывает баллончик, «Та-да!». Шипение — громче и выше на быстром
 *     движении.
 *   Добряк / Блёстка: макают кисть в банку у края карты → волнистые широкие мазки фона по пути кончика кисти →
 *     сердечки / звёзды штампом, где кисть касается карты → точки-конфетти → отошёл, посмотрел → большое сердце /
 *     звезда последним → показывает.
 * Поза: клипы Meshy paint_spray / spray_shake / spray_low_sweep / admire_artwork / paint_brush / brush_dip_stroke,
 * если пришли; поверх — character/toolIK.ts (присед, наклон, лапа к точке), а баллончик / кисть наводит PropRig.aim.
 * Нет клипов — та же поза на опорах (idle, snowglobe_shake, think, proud) + IK: всё равно видно, что рисует.
 * Рисунок — слоями (paintArt.ts ART_LAYERS), у каждого своя маска; маски открывает штамп баллончика (мягкий край
 * и крап за краем) или кисти. Финиш: все маски целиком — номер карты и имя не видны (privacy), слои сливаются в один.
 * Рисунок остаётся на сессию и возвращается на следующем визите (память {pattern, color, seed}: sber-ar-cat:paint →
 * прогресс на сервере), виден сразу при посадке на карту. Новый рисунок закрывает старый; «Стереть рисунок» — в каталоге.
 *
 * Данные карты не читаются и не сохраняются: рисунок строится только из зерна и цвета.
 * Аналитика: paint_offer, paint_start{color}, paint_done, paint_erase. Отладка: ?flow=paint[&swatch=0..2], вкладка «Тест».
 */
import * as THREE from 'three';
import type { Tracker } from '../tracker/types';
import type { Stage } from '../stage';
import type { Character } from '../character/types';
import type { AimMode, AimRequest } from '../character/toolIK';
import type { Director } from '../director';
import type { UI } from '../ui/ui';
import type { Audio } from '../audio/audio';
import type { Chip } from '../scenario/suggest';
import type { PersonaId } from '../persona/types';
import { track } from '../analytics';
import { Salute, type BurstShape } from '../fx/salute';
import { ART_LAYERS, drawLayers, patternCanvas } from './paintArt';
import { makePaintPot } from './paintProps';
import { ToolSound, rattle } from './paintSound';
import {
  ART_SPAN, DOT_HOLD, OFFER_SHOW_MS, PAINT_STYLE, PaintOfferRule, cardToUv, choreograph, erasePaint, findSwatch, loadPaint, nozzleHit, paintBlocked,
  paintCatalogItems, pathLen, pointAt, savePaint, sprayRadius,
  type Choreo, type PaintStyle, type PaintWhere, type PlanStroke, type Pt, type SavedPaint, type Step, type Swatch,
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

/** игры, после которых кот предлагает раскрасить карту */
const GAMES = new Set(['riddle', 'echo', 'emo', 'rps', 'simon']);
const TEX_W = 1024, TEX_H = 646;
const MASK_W = 512, MASK_H = 323;
/** скорость короткого шага между точками у края карты (ширин карты в секунду) */
const WALK_SPEED = 1.0;
const BACK_SPEED = 0.42;
/** после конца мазка сопло ещё мгновение брызгает: поза отстаёт от цели на кадр, хвост мазка не теряется */
const TAIL_S = 0.06;
/** кисть «касается» карты, если кончик ниже (ширин карты) */
const BRUSH_TOUCH = 0.14;

interface Drip {
  s: PlanStroke;
  at: number;
  t: number;
  last: Pt | null;
}

interface Run {
  style: PaintStyle;
  swatch: Swatch;
  others: Swatch[];
  saved: SavedPaint;
  plan: Choreo;
  /** индекс шага и время в нём */
  i: number;
  t: number;
  begun: boolean;
  /** всего с начала */
  total: number;
  /** куда смотрит сопло (карта) */
  P: Pt;
  /** откуда шёл перевод сопла к мазку */
  from: Pt;
  /** последняя точка, куда попала краска */
  last: Pt | null;
  tail: number;
  drips: Drip[];
  dripsLive: Drip[];
  mode: AimMode;
  crouch: number;
  actT: number;
  /** IK-вес лапы (клип Meshy двигает лапу сам — меньше) */
  ikW: number;
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L} ]/gu, ' ').replace(/\s+/g, ' ').trim();
const YES = /^(да|давай|ага|хочу|конечно|угу|ок|окей|раскрась|раскрашивай)( |$)/;
const NO = /^(нет|не надо|не хочу|неа|потом|не сейчас|не)( |$)/;

interface PaintLayer {
  id: string;
  canvas: HTMLCanvasElement;
  mask: HTMLCanvasElement;
  mg: CanvasRenderingContext2D | null;
  map: THREE.CanvasTexture;
  maskTex: THREE.CanvasTexture;
  mesh: THREE.Mesh;
  dirty: boolean;
}

export class CardPaint {
  readonly offer = new PaintOfferRule();
  saved: SavedPaint | null;
  private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  private group = new THREE.Group();
  private layers: PaintLayer[] = [];
  private under: THREE.Mesh | null = null;
  private pot: THREE.Object3D | null = null;
  private potK = 0;
  private fade = 0;
  private erasing = false;
  private run: Run | null = null;
  private sheet: HTMLElement | null = null;
  private sheetTimer = 0;
  private offerUntil = 0;
  private offerCheckT = 0;
  private salute: Salute | null = null;
  private sparks: PaintParticles;
  private mist: PaintParticles;
  private sound: ToolSound | null = null;
  /** QA и снимки: прогресс текущей раскраски 0…1 */
  progress = 0;
  /** QA: шаг хореографии, точка прицела и попадания краски (карта), промах сопла */
  qa = { step: '', aim: { x: 0, y: 0 }, hit: null as Pt | null, miss: 0, spraying: false, sprayFrames: 0 };
  private tmpV = new THREE.Vector3();
  private tmpW = new THREE.Vector3();
  /** мазок этого кадра: краска считается после позы кота (lateUpdate) */
  private pending: { s: PlanStroke; on: boolean; dt: number; k: number } | null = null;

  constructor(private h: CardPaintHost) {
    this.storage = h.storage === undefined ? safeStorage() : h.storage;
    this.saved = loadPaint(this.storage);
    this.group.name = 'card-paint';
    h.tracker.anchor.add(this.group);
    this.sparks = new PaintParticles(480, 0.022);
    this.mist = new PaintParticles(140, 0.07, 0.6);
    this.group.add(this.sparks.points, this.mist.points);
    if (this.saved) this.showSaved(this.saved);
    const d = h.director;
    d.on('phase', (ph) => {
      if (ph === 'play' || ph === 'free') this.offer.begin(performance.now());
    });
    d.on('game', (g) => {
      if (!g.start && GAMES.has(g.id)) this.offer.gameEnd();
    });
    // голос: «раскрась карту»; «да / нет» на предложение кота и на лист цветов
    // присел с баллончиком — реплики не ставят «говорящую» позу
    const busyPrev = d.bodyBusy;
    d.bodyBusy = () => !!this.run || (busyPrev ? busyPrev() : false);
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
    return !!this.run || !!this.salute?.active || this.sparks.active || this.mist.active;
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
    if (this.layers.length && this.saved && !this.erasing) this.keepUnder();
    const art = this.buildLayers(saved, swatch, others, 0);
    const aspect = this.h.tracker.aspect;
    const plan = choreograph(art, TEX_W, TEX_H, aspect, style.tool, WALK_SPEED);
    const ch = this.h.character();
    const meshyArm = ch?.clipSource?.(style.tool === 'spray' ? 'paint_spray' : 'paint_brush') === 'meshy';
    this.run = {
      style, swatch, others, saved, plan, i: 0, t: 0, begun: false, total: 0,
      P: { x: 0, y: 0 }, from: { x: 0, y: 0 }, last: null, tail: 0,
      drips: plan.drips.map((d) => ({ s: d.s, at: -1, t: 0, last: null })), dripsLive: [],
      mode: 'carry', crouch: 0, actT: 0, ikW: meshyArm ? 0.85 : 1,
    };
    this.progress = 0;
    this.erasing = false;
    this.offer.done();
    track('paint_start', { color: swatch.id });
    this.h.log(`раскраска: ${style.pattern} / ${swatch.id}, зерно ${saved.seed}, ${plan.steps.length} шагов ≈ ${plan.total.toFixed(1)} с${meshyArm ? ', клип Meshy' : ''}`);
    ch?.holdProp?.(style.clip, swatch.main);
    this.h.audio.play('pop_appear', 0.4);
    this.sound?.dispose();
    this.sound = new ToolSound((v) => this.h.audio.synthOut?.(v) ?? null, style.tool, style.tool === 'spray' ? 0.55 : 0.4);
    if (style.tool === 'brush') this.placePot(plan.pot, swatch.main, style.pattern === 'stars');
    this.line('paint_start');
    this.quiet(performance.now());
    this.h.kickSuggest();
    return true;
  }

  private world(p: Pt, z = 0, out = this.tmpV): THREE.Vector3 {
    return this.h.tracker.anchor.localToWorld(out.set(p.x, p.y, z));
  }

  private aim(r: Run, mode: AimMode, crouch: number, z = 0) {
    r.mode = mode;
    r.crouch = crouch;
    const req: AimRequest = { mode, crouch, tool: r.style.tool, weight: r.ikW, target: mode === 'aim' || mode === 'dip' ? this.world(r.P, z).clone() : null };
    this.h.character()?.aimTool?.(req);
  }

  /** клип id, если пришёл настоящий (Meshy), иначе опора */
  private clipOr(id: string, fallback: string): string {
    return this.h.character()?.clipSource?.(id) === 'meshy' ? id : fallback;
  }

  /** клип художника — сразу (force): «номер» в защищённом окне (жвачка, idle-трюк) не держит кота */
  private play(clip: string, loop = true) {
    this.h.character()?.play(clip, { loop, force: true });
  }

  private stepName(s: Step | undefined) {
    return s ? (s.k === 'stroke' ? `stroke:${s.s.phase}` : s.k) : 'done';
  }

  /** начало шага */
  private begin(r: Run, s: Step) {
    const st = this.h.stage, ch = this.h.character(), tool = r.style.tool;
    r.t = 0;
    r.begun = true;
    this.qa.step = this.stepName(s);
    switch (s.k) {
      case 'shake': {
        st.faceTo = null;
        const real = ch?.clipSource?.('spray_shake') === 'meshy';
        this.play(real ? 'spray_shake' : 'idle_breathe');
        r.mode = 'shake';
        ch?.aimTool?.({ mode: 'shake', crouch: 0, weight: real ? 0.35 : 1 });
        rattle((v) => this.h.audio.synthOut?.(v) ?? null, s.dur);
        if (!this.h.audio.synthOut) this.h.audio.play('shake_1', 0.5);
        break;
      }
      case 'dip': {
        this.play(this.clipOr('brush_dip_stroke', 'idle_breathe'));
        r.P = { ...this.h.stage.pos, ...this.potPoint() };
        this.aim(r, 'dip', 0.6, 0.06);
        break;
      }
      case 'walk': {
        st.faceTo = null;
        this.aim(r, 'carry', 0);
        ch?.lookAt?.(null);
        const ok = st.walkTo(new THREE.Vector2(s.to.x, s.to.y), undefined, { free: true, back: s.back, speed: s.back ? BACK_SPEED : WALK_SPEED });
        if (ok) this.play('walk');
        else r.t = 99;
        break;
      }
      case 'crouch': {
        if (s.on) {
          // сопло — сразу на начало ближайшего мазка
          const next = r.plan.steps.slice(r.i + 1).find((x) => x.k === 'stroke');
          if (next && next.k === 'stroke') r.P = { ...next.s.pts[0] };
          this.play(tool === 'spray' ? this.clipOr('spray_low_sweep', this.clipOr('paint_spray', 'idle_breathe')) : this.clipOr('paint_brush', 'idle_breathe'));
          this.aim(r, 'aim', 1);
        } else {
          this.sound?.set(false);
          this.aim(r, 'carry', 0);
        }
        break;
      }
      case 'stroke':
        r.from = { ...r.P };
        if (r.mode !== 'aim') this.aim(r, 'aim', 1);
        break;
      case 'admire': {
        this.sound?.set(false);
        this.aim(r, 'carry', 0);
        st.faceTo = new THREE.Vector2(s.at.x, s.at.y);
        ch?.lookAt?.(this.world(s.at).clone());
        this.play(this.clipOr('admire_artwork', 'think'), false);
        break;
      }
      case 'show': {
        this.sound?.set(false);
        st.faceTo = null;
        ch?.lookAt?.(null);
        this.aim(r, 'raise', 0);
        this.play('proud', false);
        this.h.audio.play('whoosh', 0.25);
        break;
      }
    }
  }

  /** шаг идёт; true — закончен */
  private tick(r: Run, s: Step, dt: number): boolean {
    const st = this.h.stage;
    switch (s.k) {
      case 'shake':
      case 'admire':
      case 'show':
      case 'crouch':
        if (s.k === 'crouch' && s.on) this.aim(r, 'aim', 1);
        return r.t >= s.dur;
      case 'dip': {
        // кисть в банку и обратно — два раза; Блёстка — искры из банки
        const k = r.t / s.dur, dipZ = 0.075 - 0.05 * Math.max(0, Math.sin(k * Math.PI * 4));
        const pp = this.potPoint();
        r.P = pp;
        this.aim(r, 'dip', 0.6, dipZ);
        if (Math.sin(k * Math.PI * 4) > 0.95 && (r.actT * 10) % 1 < 0.5) this.h.audio.play('gum_splat', 0.12);
        if (r.style.pattern === 'stars') this.sparks.emitAt(pp.x, pp.y, 0.08, dt, [r.swatch.main, '#ffffff', '#FFE38A'], 2, 30);
        if (r.t >= s.dur) {
          r.P = { x: st.pos.x * 0.6, y: st.pos.y - 0.25 };
          return true;
        }
        return false;
      }
      case 'walk': {
        const done = !st.walking || r.t > s.max;
        if (done) {
          if (st.walking) st.cancelWalk();
          st.faceTo = new THREE.Vector2(s.face.x, s.face.y);
          this.play('idle_breathe');
        }
        return done;
      }
      case 'stroke':
        return this.strokeTick(r, s.s, s.gap, dt);
    }
  }

  /** мазок: сопло переводится к началу (краска не идёт), потом ведёт по пути; краска — там, куда попал луч сопла */
  private strokeTick(r: Run, s: PlanStroke, gap: number, dt: number): boolean {
    const t = r.t;
    let on = false;
    if (t < gap) {
      const k = t / gap, e = k * k * (3 - 2 * k);
      r.P = { x: r.from.x + (s.pts[0].x - r.from.x) * e, y: r.from.y + (s.pts[0].y - r.from.y) * e };
      // хвост прошлого мазка: поза отстаёт на кадр
      on = r.tail > 0;
      r.tail -= dt;
    } else {
      const k = Math.min(1, (t - gap) / s.dur);
      if (s.kind === 'burst') {
        // пшик в точку: сопло чуть кружит — пятно растёт
        const a = k * Math.PI * 5, rr = s.r * 0.25 * k;
        r.P = { x: s.pts[0].x + Math.cos(a) * rr, y: s.pts[0].y + Math.sin(a) * rr };
      } else if (s.dots) {
        // пунктир: у каждой точки — остановка DOT_HOLD
        const n = s.pts.length, move = Math.max(1e-3, s.dur - n * DOT_HOLD);
        const tt = k * s.dur, total = Math.max(1e-6, pathLen(s.pts));
        let acc = 0, done = false;
        for (let i = 0; i < n && !done; i++) {
          if (tt <= acc + DOT_HOLD) {
            r.P = { ...s.pts[i] };
            on = true;
            done = true;
            break;
          }
          acc += DOT_HOLD;
          if (i < n - 1) {
            const seg = Math.hypot(s.pts[i + 1].x - s.pts[i].x, s.pts[i + 1].y - s.pts[i].y);
            const segT = (seg / total) * move;
            if (tt <= acc + segT) {
              const q = (tt - acc) / segT;
              r.P = { x: s.pts[i].x + (s.pts[i + 1].x - s.pts[i].x) * q, y: s.pts[i].y + (s.pts[i + 1].y - s.pts[i].y) * q };
              done = true;
              break;
            }
            acc += segT;
          }
        }
        if (!done) r.P = { ...s.pts[n - 1] };
      } else r.P = pointAt(s.pts, k, { x: 0, y: 0 });
      if (!s.dots) on = true;
      r.tail = TAIL_S;
    }
    this.aim(r, 'aim', 1);
    // краска — после позы кота в этом кадре (lateUpdate: сопло там, где его нарисуют)
    this.pending = { s, on, dt, k: t >= gap ? Math.min(1, (t - gap) / s.dur) : 0 };
    return t >= gap + s.dur;
  }

  /**
   * Краска: луч сопла (кончика кисти) из позы прошлого кадра → точка на карте; штампы маски слоя от прошлой точки до
   * этой; брызги конусом из сопла; шипение по скорости.
   */
  private spray(r: Run, s: PlanStroke, on: boolean, dt: number, k: number) {
    const ch = this.h.character();
    const ray = ch?.toolRay?.() ?? null;
    let H: Pt | null = null, N: THREE.Vector3 | null = null, dist = 0.2;
    if (ray) {
      const a = this.h.tracker.anchor;
      a.updateWorldMatrix(true, false);
      N = a.worldToLocal(this.tmpW.copy(ray.o));
      const d = a.worldToLocal(this.tmpV.copy(ray.o).add(ray.d)).sub(N);
      const hit = nozzleHit(N, d);
      if (hit) {
        H = { x: hit.x, y: hit.y };
        dist = hit.dist;
        // кисть красит, только когда кончик у карты
        if (r.style.tool === 'brush' && N.z > BRUSH_TOUCH) on = false;
      }
    } else {
      // без 3D-кота (спрайт, заглушка): краска там, куда целимся, сопло — у лапы
      H = { ...r.P };
      const p = this.h.stage.pos;
      N = this.tmpW.set(p.x + (r.P.x - p.x) * 0.45, p.y + (r.P.y - p.y) * 0.45, r.style.tool === 'spray' ? 0.3 : 0.04);
      dist = Math.hypot(N.x - H.x, N.y - H.y, N.z);
    }
    this.qa.aim = { ...r.P };
    this.qa.hit = H;
    this.qa.miss = H ? Math.hypot(H.x - r.P.x, H.y - r.P.y) : 1;
    this.qa.spraying = on && !!H;
    if (!on || !H) {
      r.last = null;
      this.sound?.set(false);
      return;
    }
    this.qa.sprayFrames++;
    const spray = r.style.tool === 'spray';
    const rad = s.kind === 'burst' ? s.r * (spray ? 0.45 + 0.55 * k : 0.3 + 0.7 * Math.sqrt(k)) : spray ? sprayRadius(s.r, dist) : s.r;
    const from = r.last ?? H;
    const speed = r.last ? Math.hypot(H.x - r.last.x, H.y - r.last.y) / Math.max(1e-3, dt) : 0;
    const L = this.layers.find((l) => l.id === s.layer) ?? this.layers[0];
    if (L) this.stampLine(L, from, H, rad, spray ? 'spray' : s.kind === 'burst' ? 'dab' : 'brush', s.phase === 'base' ? 1 : 0.8);
    r.last = H;
    this.sound?.set(true, s.kind === 'burst' ? 0.6 : speed);
    // брызги
    const cols = [r.swatch.main, r.swatch.main, r.swatch.main, ...r.others.map((o) => o.main), '#ffffff'];
    if (spray && N) this.sparks.cone(N, H, rad, dt, cols, this.mist);
    else if (r.style.pattern === 'stars') this.sparks.emitAt(H.x, H.y, 0.01, dt, ['#ffffff', '#FFE38A', r.swatch.main], 2, 34);
    else this.sparks.emitAt(H.x, H.y, 0.01, dt, cols, 1, 14);
    if (s.kind === 'burst' && k < 0.2 && !spray) this.h.audio.play(r.style.pattern === 'stars' ? 'glitter' : 'pop_appear', 0.14);
  }

  /** потёки: стекают сами, кот уже рисует дальше */
  private drips(r: Run, dt: number) {
    for (const d of r.drips) {
      if (d.at < 0) {
        const p = r.plan.drips[r.drips.indexOf(d)];
        if (r.i > p.after) d.at = r.total + p.delay;
        continue;
      }
      if (d.t < 0 || r.total < d.at) continue;
      d.t += dt;
      const k = Math.min(1, d.t / d.s.dur);
      // стекает с замедлением, как краска
      const e = 1 - (1 - k) * (1 - k);
      const P = pointAt(d.s.pts, e, { x: 0, y: 0 });
      const L = this.layers.find((l) => l.id === d.s.layer);
      if (L) this.stampLine(L, d.last ?? P, P, d.s.r, 'drip', 1);
      d.last = P;
      if (k >= 1) d.t = -1;
    }
  }

  private step(r: Run, dt: number) {
    this.qa.spraying = false;
    r.t += dt;
    r.total += dt;
    const steps = r.plan.steps;
    let s = steps[r.i];
    if (s && !r.begun) this.begin(r, s);
    if (s && this.tick(r, s, dt)) {
      r.i++;
      r.begun = false;
      s = steps[r.i];
      if (s) this.begin(r, s);
    }
    // голова — туда, где рисует (кроме «показывает» и ходьбы)
    if (s && (s.k === 'stroke' || (s.k === 'crouch' && s.on) || s.k === 'dip')) this.h.character()?.lookAt?.(this.world(r.P).clone());
    if (!this.late && this.pending) {
      const p = this.pending;
      this.pending = null;
      this.spray(r, p.s, p.on, p.dt, p.k);
    }
    this.drips(r, dt);
    this.progress = Math.max(this.progress, Math.min(0.99, r.total / Math.max(1, r.plan.total)));
    if (!s) this.finish(r);
  }

  private release() {
    const ch = this.h.character();
    ch?.aimTool?.(null);
    ch?.holdProp?.(null);
    ch?.lookAt?.(null);
    this.h.stage.faceTo = null;
    this.sound?.dispose();
    this.sound = null;
  }

  private finish(r: Run) {
    this.run = null;
    this.progress = 1;
    this.qa.step = 'done';
    this.completeLayers();
    this.dropUnder();
    this.commit(r.saved);
    this.release();
    this.potK = -1;
    const ch = this.h.character();
    ch?.play('celebrate', { force: true });
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
    this.qa.step = 'done';
    this.completeLayers();
    this.dropUnder();
    this.commit(r.saved);
    this.h.stage.cancelWalk();
    this.release();
    this.removePot();
    this.h.character()?.play('idle');
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

  // ───────────── банка краски (кисть) ─────────────

  private placePot(p: Pt, color: string, glitter: boolean) {
    this.removePot();
    this.pot = makePaintPot(color, glitter);
    this.pot.position.set(p.x, p.y, 0);
    this.pot.scale.setScalar(0.001);
    this.potK = 0.001;
    this.group.add(this.pot);
  }
  private potPoint(): Pt {
    const p = this.pot?.position;
    return p ? { x: p.x, y: p.y } : { x: 0, y: 0.45 };
  }
  private removePot() {
    if (!this.pot) return;
    this.pot.removeFromParent();
    this.pot.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose?.();
    });
    this.pot = null;
    this.potK = 0;
  }
  private potTick(dt: number) {
    if (!this.pot) return;
    if (this.potK >= 0) this.potK = Math.min(1, this.potK + dt / 0.3);
    else this.potK -= dt / 0.35;
    const k = this.potK >= 0 ? this.potK : 1 + this.potK;
    if (k <= 0.001) return this.removePot();
    // появление с перелётом, уход — сжимается
    const e = this.potK >= 0 ? 1 + Math.sin(k * Math.PI) * 0.18 * (1 - k) : k;
    this.pot.scale.setScalar(Math.max(0.001, e * Math.min(1, k * 1.4)));
  }

  /** «Стереть рисунок» (каталог) */
  erase(): boolean {
    if (this.run) return false;
    if (!this.saved && !this.layers.length) return false;
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


  // ───────────── слои рисунка на карте ─────────────

  private showSaved(s: SavedPaint) {
    const f = findSwatch(s.pattern, s.color);
    if (f) {
      this.buildLayers(s, f.swatch, f.others, 1);
      this.flatten();
    }
  }

  /**
   * Слои рисунка (ART_LAYERS) — каждый своей сеткой поверх карты (чуть выше, без z-fight) со своей маской.
   * reveal 1 — сразу целиком (сохранённый рисунок). Возвращает мазки элементов (для хореографии).
   */
  private buildLayers(s: SavedPaint, swatch: Swatch, others: Swatch[], reveal: 0 | 1) {
    this.disposeLayers();
    if (typeof document === 'undefined') return drawLayers(() => null, TEX_W, TEX_H, s.pattern, swatch, others, s.seed);
    const aspect = this.h.tracker.aspect;
    const ids = ART_LAYERS[s.pattern];
    const geo = new THREE.PlaneGeometry(ART_SPAN, ART_SPAN / aspect);
    const made = new Map<string, PaintLayer>();
    ids.forEach((id, i) => {
      const canvas = document.createElement('canvas');
      canvas.width = TEX_W;
      canvas.height = TEX_H;
      const mask = document.createElement('canvas');
      mask.width = MASK_W;
      mask.height = MASK_H;
      const mg = mask.getContext('2d');
      if (mg) {
        mg.fillStyle = reveal ? '#fff' : '#000';
        mg.fillRect(0, 0, MASK_W, MASK_H);
      }
      const map = new THREE.CanvasTexture(canvas);
      map.colorSpace = THREE.SRGBColorSpace;
      map.anisotropy = 4;
      const maskTex = new THREE.CanvasTexture(mask);
      const mat = new THREE.MeshBasicMaterial({
        map, alphaMap: maskTex, transparent: true, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2 - i, polygonOffsetUnits: -2 - i,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `card-paint-${id}`;
      mesh.position.z = 0.0015 + i * 0.0002;
      mesh.renderOrder = -0.5 + i * 0.01;
      this.group.add(mesh);
      const L: PaintLayer = { id, canvas, mask, mg, map, maskTex, mesh, dirty: true };
      made.set(id, L);
      this.layers.push(L);
    });
    const art = drawLayers((id) => made.get(id)?.canvas.getContext('2d') ?? null, TEX_W, TEX_H, s.pattern, swatch, others, s.seed);
    for (const L of this.layers) {
      L.map.needsUpdate = true;
      L.maskTex.needsUpdate = true;
    }
    return art;
  }

  /** штампы маски слоя от a до b (точки карты): баллончик — мягкое пятно и крап, кисть — плотный мазок с волосками */
  private stampLine(L: PaintLayer, a: Pt, b: Pt, r: number, tool: 'spray' | 'brush' | 'dab' | 'drip', alpha: number) {
    const g = L.mg;
    if (!g) return;
    const aspect = this.h.tracker.aspect;
    const ua = cardToUv(a, aspect), ub = cardToUv(b, aspect);
    const rpx = Math.max(1.5, (r / ART_SPAN) * MASK_W);
    const ax = ua.u * MASK_W, ay = ua.v * MASK_H, bx = ub.u * MASK_W, by = ub.v * MASK_H;
    const d = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.ceil(d / (rpx * (tool === 'spray' ? 0.3 : 0.22))));
    for (let i = 1; i <= n; i++) stamp(g, ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n, rpx, tool, alpha);
    L.dirty = true;
  }

  /** все маски — целиком: рисунок закрывает карту (номер и имя не видны) */
  private completeLayers() {
    for (const L of this.layers) {
      if (L.mg) {
        L.mg.globalAlpha = 1;
        L.mg.fillStyle = '#fff';
        L.mg.fillRect(0, 0, MASK_W, MASK_H);
      }
      L.maskTex.needsUpdate = true;
    }
    this.flatten();
  }

  /** слить слои в один (готовый рисунок): меньше памяти и текстур */
  private flatten() {
    if (this.layers.length < 2) return;
    const [bg, ...rest] = this.layers;
    const g = bg.canvas.getContext('2d');
    if (g) for (const L of rest) g.drawImage(L.canvas, 0, 0);
    bg.map.needsUpdate = true;
    for (const L of rest) this.disposeLayer(L, false);
    this.layers = [bg];
  }

  private disposeLayer(L: PaintLayer, geo: boolean) {
    L.mesh.removeFromParent();
    L.map.dispose();
    L.maskTex.dispose();
    (L.mesh.material as THREE.Material).dispose();
    if (geo) L.mesh.geometry.dispose();
  }
  private disposeLayers() {
    const geo = this.layers[0]?.mesh.geometry;
    for (const L of this.layers) this.disposeLayer(L, false);
    if (geo && geo !== this.under?.geometry) geo.dispose();
    this.layers = [];
  }

  /** старый рисунок — копией под новым (новый проявляется поверх) */
  private keepUnder() {
    this.dropUnder();
    const top = this.layers[0];
    if (!top) return;
    const c = document.createElement('canvas');
    c.width = TEX_W;
    c.height = TEX_H;
    const g = c.getContext('2d');
    if (g) for (const L of this.layers) g.drawImage(L.canvas, 0, 0);
    const map = new THREE.CanvasTexture(c);
    map.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    this.under = new THREE.Mesh(new THREE.PlaneGeometry(ART_SPAN, ART_SPAN / this.h.tracker.aspect), m);
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
    this.under.geometry.dispose();
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
    for (const L of this.layers)
      if (L.dirty) {
        L.dirty = false;
        L.maskTex.needsUpdate = true;
      }
    // видимость: рисунок на карте, пока карта в кадре (дома — нет)
    const want = this.layers.length > 0 && !this.erasing && this.h.tracker.isTracking && !home?.inRoom;
    this.fade = Math.max(0, Math.min(1, this.fade + (want ? dt / 0.25 : -dt / (this.erasing ? 0.6 : 0.2))));
    for (const L of this.layers) {
      (L.mesh.material as THREE.MeshBasicMaterial).opacity = this.fade;
      L.mesh.visible = this.fade > 0.001;
    }
    if (this.under) {
      (this.under.material as THREE.MeshBasicMaterial).opacity = this.fade;
      this.under.visible = this.fade > 0.001;
    }
    if (this.erasing && this.fade <= 0) this.removeOverlay();
    this.potTick(dt);
    this.sparks.update(dt);
    this.mist.update(dt);
    if (this.salute?.active) {
      this.salute.update(dt);
      this.salute.draw();
    }
  }

  /**
   * После позы кота (app.ts: после character.update): луч сопла этого кадра → краска на карту. Без вызова (тесты,
   * старый цикл) — краска идёт со следующего update по позе прошлого кадра.
   */
  lateUpdate() {
    this.late = true;
    const r = this.run, p = this.pending;
    this.pending = null;
    if (r && p) this.spray(r, p.s, p.on, p.dt, p.k);
  }
  private late = false;

  resize(w: number, h: number) {
    this.salute?.resize(w, h);
  }

  private removeOverlay() {
    this.erasing = false;
    this.dropUnder();
    this.disposeLayers();
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

// ───────────── штамп маски ─────────────

/**
 * Штамп маски (белое — краска видна): spray — мягкое пятно (ядро плотнее, край тает) и крап брызг за краем: от
 * прохода к проходу краска «набирается»; brush — плотный круг с волосками по краю; dab — штамп кончиком кисти
 * (ровный круг); drip — потёк (плотный узкий).
 */
function stamp(g: CanvasRenderingContext2D, u: number, v: number, r: number, tool: 'spray' | 'brush' | 'dab' | 'drip', alpha: number) {
  if (tool === 'spray') {
    const gr = g.createRadialGradient(u, v, r * 0.2, u, v, r * 1.15);
    gr.addColorStop(0, `rgba(255,255,255,${0.62 * alpha})`);
    gr.addColorStop(0.55, `rgba(255,255,255,${0.42 * alpha})`);
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.beginPath();
    g.arc(u, v, r * 1.15, 0, Math.PI * 2);
    g.fill();
    // крап за краем — overspray
    g.fillStyle = 'rgba(255,255,255,.85)';
    for (let i = 0; i < 7; i++) {
      const a = Math.random() * Math.PI * 2, d = r * (0.9 + Math.random() * 0.9), s = 0.8 + Math.random() * 1.4;
      g.fillRect(u + Math.cos(a) * d, v + Math.sin(a) * d, s, s);
    }
    return;
  }
  g.fillStyle = '#fff';
  g.beginPath();
  g.arc(u, v, r * (tool === 'brush' ? 0.96 + Math.random() * 0.06 : 1), 0, Math.PI * 2);
  g.fill();
  if (tool !== 'brush') return;
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

// ───────────── частицы: конус брызг, туман, капли, блёстки ─────────────

/** kind: 0 — капля брызг летит из сопла на карту; 1 — капля краски (падает); 2 — блёстка; 3 — туман (висит, тает) */
class PaintParticles {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private col: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private age: Float32Array;
  private kind: Uint8Array;
  private base: Float32Array;
  private cursor = 0;
  private acc = 0;
  private c = new THREE.Color();

  constructor(private max: number, size: number, private alphaK = 1) {
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.age = new Float32Array(max);
    this.kind = new Uint8Array(max);
    this.base = new Float32Array(max * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.PointsMaterial({ size, sizeAttenuation: true, vertexColors: true, transparent: true, depthWrite: false, map: dotTexture(), alphaTest: 0.01 });
    this.points = new THREE.Points(geo, mat);
    this.points.name = 'card-paint-sparks';
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    this.points.visible = false;
  }

  get active() {
    return this.points.visible;
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, color: string, kind: number) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
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
    this.points.visible = true;
  }

  /** конус брызг из сопла N (координаты карты, z — высота) в пятно радиуса r вокруг H; туман — в mist */
  cone(N: { x: number; y: number; z: number }, H: Pt, r: number, dt: number, cols: string[], mist: PaintParticles) {
    this.acc += Math.min(dt, 0.1) * 340;
    while (this.acc >= 1) {
      this.acc--;
      const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * r * 1.05;
      const tx = H.x + Math.cos(a) * d, ty = H.y + Math.sin(a) * d;
      const tt = 0.09 + Math.random() * 0.08;
      const col = cols[Math.floor(Math.random() * cols.length)];
      this.spawn(N.x, N.y, N.z, (tx - N.x) / tt, (ty - N.y) / tt, (0.002 - N.z) / tt, tt, col, 0);
      if (Math.random() < 0.22) {
        const b = Math.random() * Math.PI * 2, e = r * (0.4 + Math.random() * 0.9);
        mist.spawn(H.x + Math.cos(b) * e, H.y + Math.sin(b) * e, 0.006 + Math.random() * 0.025, Math.cos(b) * 0.06, Math.sin(b) * 0.06, 0.02, 0.3 + Math.random() * 0.35, col, 3);
      }
    }
  }

  /** у точки карты: капли (1) или блёстки (2), rate в секунду */
  emitAt(x: number, y: number, z: number, dt: number, cols: string[], kind: 1 | 2, rate: number) {
    this.acc += Math.min(dt, 0.1) * rate;
    while (this.acc >= 1) {
      this.acc--;
      const a = Math.random() * Math.PI * 2, d = Math.random() * 0.03;
      const col = cols[Math.floor(Math.random() * cols.length)];
      if (kind === 2) this.spawn(x + Math.cos(a) * d, y + Math.sin(a) * d, z, (Math.random() - 0.5) * 0.08, (Math.random() - 0.5) * 0.08, 0.1 + Math.random() * 0.14, 0.5 + Math.random() * 0.5, col, 2);
      else this.spawn(x + Math.cos(a) * d, y + Math.sin(a) * d, z + 0.01, Math.cos(a) * 0.2, Math.sin(a) * 0.2, 0.22 + Math.random() * 0.2, 0.6, col, 1);
    }
  }

  update(dt: number) {
    if (!this.points.visible) return;
    let live = 0;
    for (let i = 0; i < this.max; i++) {
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
      if (kind === 3) {
        this.vel[j] *= 0.94;
        this.vel[j + 1] *= 0.94;
      }
      this.pos[j] += this.vel[j] * dt;
      this.pos[j + 1] += this.vel[j + 1] * dt;
      this.pos[j + 2] = Math.max(0.003, this.pos[j + 2] + this.vel[j + 2] * dt);
      if (kind === 1 && this.pos[j + 2] <= 0.003) this.life[i] = Math.min(this.life[i], this.age[i] + 0.15);
      const tw = kind === 2 ? 0.55 + 0.45 * Math.sin(this.age[i] * 28 + i) : 1;
      // капля брызг ярче в полёте, туман — мягкий подъём и угасание
      const a = kind === 3 ? Math.sin(Math.PI * k) * 0.55 : kind === 0 ? 0.95 : (1 - k) * tw;
      this.col[i * 4] = this.base[j];
      this.col[i * 4 + 1] = this.base[j + 1];
      this.col[i * 4 + 2] = this.base[j + 2];
      this.col[i * 4 + 3] = a * this.alphaK;
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

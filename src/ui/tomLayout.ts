/**
 * Меню «как у Говорящего Тома» (feature 'ui.tomLayout', docs/ui/TOM_LAYOUT.md): чистая логика без DOM.
 *
 *   tomModel  — что где лежит: левая колонка «Ласка», правая «Трюки/Образ», снизу — «Мой дом»/«На карту», «Игры»
 *               (поповер), «Ещё» (служебное), дома — действия комнаты. Источник — те же группы каталога
 *               (ui/catalogGroups.ts): пункты только раскладываются, ничего не добавляется и не теряется.
 *   tomLayout — геометрия: колонки у краёв экрана (зона большого пальца), под ними — ряд чипов кота, комната, док.
 *               Колонка не закрывает кота (catRect): по очереди пробуем «колонка по центру» → «колонка сверху» →
 *               «сетка 2×N сверху» → «язычок у края». Учитываются safe-area и альбомная ориентация.
 *
 * Тесты — tests/tomLayout.test.ts (каждое действие пилота ≤ 2 касаний, колонки не налезают на кота на 4 экранах,
 * автоскрытие).
 */
import type { CatalogItem } from './actionCatalog';
import type { CatalogGroup } from './catalogGroups';
import { ZONES, type ZoneId } from '../home/zones';

// ───────────── что где лежит ─────────────

/**
 * левая колонка «Ласка» / «Сюрпризы» (pilot.noCare): сначала значки сервисов с «?» (онборды, config/onboards.ts),
 * потом порядок продакта (pilot.ts: погладить, почесать, щекотка, обнять, дай лапу, угостить)
 */
export const LEFT_ORDER = ['svc:samokat', 'svc:kids', 'pet', 'scratch', 'tickle', 'hug', 'paw', 'treat', 'cheek'];
/** правая колонка «Трюки/Образ»: танец, сальто, фирменные характера, раскраска, «Другой кот»; остальное — после */
export const RIGHT_ORDER = ['dance', 'flip', 'skate', 'cocoa', 'mirror', 'glass', 'bubbles', 'ui:paint', 'other', 'ui:paint_erase'];
/** короткие подписи под круглыми кнопками (≤ 10 знаков — в одну строку под кнопкой 56 px) */
export const SHORT_LABEL: Record<string, string> = {
  'ui:paint': 'Раскрась',
  'ui:paint_erase': 'Стереть',
  'ui:micmode': 'Микрофон',
  'ui:reanchor': 'Пересадить',
  'home:sleep': 'Уложить',
  'home:wake': 'Разбудить',
  'home:dance': 'Танец',
  'home:back': 'На карту',
  'home:go': 'Мой дом',
  'svc:samokat': 'Самокат',
  'svc:kids': 'СберKids',
};
export const shortLabel = (it: { id: string; label: string }) => SHORT_LABEL[it.id] ?? it.label;

export interface TomCtx {
  /** кот дома — в какой комнате; null — на карте */
  home: ZoneId | null;
  /** кот спит (кровать или дрёма) */
  sleeping?: boolean;
  /** раскраска сейчас невозможна (нет карты под котом) */
  paintBlocked?: boolean;
}

export interface TomModel {
  left: CatalogItem[];
  right: CatalogItem[];
  /** поповер «Игры»: игры (и «Фразы» в lab) */
  games: CatalogItem[];
  /** поповер «Ещё» (шестерёнка): микрофон, пересадить */
  service: CatalogItem[];
  /** «Мой дом» / «На карту»; null — сейчас нельзя (кнопка видна неактивной) */
  home: CatalogItem | null;
  /** дома: действия комнаты внизу (кухня: угостить/какао; спальня: уложить/разбудить; гостиная: мячик/танец) */
  room: CatalogItem[];
}

const byOrder = (order: string[]) => (a: CatalogItem, b: CatalogItem) => {
  const ia = order.indexOf(a.id), ib = order.indexOf(b.id);
  return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
};
const stable = (items: CatalogItem[], order: string[]) =>
  items.map((it, k) => ({ it, k })).sort((a, b) => byOrder(order)(a.it, b.it) || a.k - b.k).map((x) => x.it);

/** действия комнаты: из таблицы зон (home/zones.ts); спальня — «Уложить» и «Разбудить» */
export function roomItems(zone: ZoneId | null): CatalogItem[] {
  const z = zone ? ZONES.find((x) => x.id === zone) : null;
  if (!z) return [];
  const acts = z.actions.map((a): CatalogItem => ({ id: a.id, label: a.label, icon: a.icon, run: { ui: 'home' } }));
  if (z.id === 'bedroom' && !acts.some((a) => a.id === 'home:wake')) acts.push({ id: 'home:wake', label: 'Разбудить', icon: 'sun', run: { ui: 'home' } });
  // гостиная: мячик первым (продакт: «мячик / танец»)
  if (z.id === 'living') acts.sort((a, b) => (a.id === 'home:ball' ? -1 : b.id === 'home:ball' ? 1 : 0));
  return acts;
}

/** группы каталога → места на экране */
export function tomModel(groups: CatalogGroup[], ctx: TomCtx): TomModel {
  const g = (id: string) => groups.find((x) => x.id === id)?.items ?? [];
  const homeIt = [...g('games'), ...g('world')].find((i) => i.id === 'home:go' || i.id === 'home:back') ?? null;
  const left = stable(g('care'), LEFT_ORDER);
  const right = stable([...g('tricks'), ...g('look')], RIGHT_ORDER);
  const games = [...g('games'), ...g('say')].filter((i) => !i.id.startsWith('home:'));
  // комнаты дома переключаются стрелками у ряда комнаты — в «Ещё» их нет
  // дома пересаживать на карту нечего
  const service = [...g('world'), ...g('service')].filter((i) => !i.id.startsWith('home:') && !i.id.startsWith('zone:') && !(ctx.home && i.id === 'ui:reanchor'));
  return { left, right, games, service, home: homeIt, room: roomItems(ctx.home) };
}

/** неактивный пункт: почему (подсказка вместо действия) */
export function disabledReason(it: { id: string }, ctx: TomCtx): string | null {
  if ((it.id === 'ui:paint' || it.id === 'ui:paint_erase') && (ctx.paintBlocked || ctx.home)) return 'Сначала покажи мне карту';
  if (it.id === 'home:sleep' && ctx.sleeping) return 'Я уже сплю…';
  if (it.id === 'home:wake' && !ctx.sleeping) return 'Я и так не сплю!';
  return null;
}

/** сколько касаний до пункта (колонка с «Ещё» в последней ячейке, поповеры) — для теста «≤ 2 касаний» */
export function tapsTo(model: TomModel, plan: Pick<TomPlan, 'left' | 'right'>, id: string): number {
  const inCol = (items: CatalogItem[], cap: number) => {
    const k = items.findIndex((i) => i.id === id);
    if (k < 0) return 0;
    return items.length <= cap || k < cap - 1 ? 1 : 2;
  };
  const c = inCol(model.left, plan.left.cap) || inCol(model.right, plan.right.cap);
  if (c) return c;
  if (model.home?.id === id || model.room.some((i) => i.id === id)) return 1;
  if (model.games.some((i) => i.id === id) || model.service.some((i) => i.id === id)) return 2;
  return Infinity;
}

// ───────────── геометрия ─────────────

export interface Rect { x: number; y: number; w: number; h: number }
export interface Insets { t: number; b: number; l: number; r: number }
export interface CatBox { top: number; bottom: number; cx: number; half: number }
/** col — колонка по центру высоты, coltop — прижата кверху, colsm/colsmtop — то же с кнопками поменьше, grid — сетка 2×N сверху */
export type ColMode = 'col' | 'coltop' | 'colsm' | 'colsmtop' | 'grid' | 'tab';

export interface ColumnPlan {
  side: 'l' | 'r';
  mode: ColMode;
  /** рамка колонки (для 'tab' — язычок) */
  rect: Rect;
  cols: number;
  /** диаметр кнопки и размер ячейки в этой колонке */
  btn: number;
  slotW: number;
  slotH: number;
  /** ячейки кнопок (кружок + подпись), по порядку пунктов */
  slots: Rect[];
  /** сколько ячеек влезает: пунктов больше — последняя ячейка «Ещё» */
  cap: number;
  /** язычок у края (виден, когда колонка спрятана) */
  tab: Rect;
}

export interface TomPlan {
  w: number;
  h: number;
  land: boolean;
  /** диаметр круглой кнопки колонки */
  btn: number;
  slotW: number;
  slotH: number;
  /** верх дока (микрофон и соседи) */
  dockTop: number;
  /** ряд чипов кота */
  chips: Rect;
  /** ряд комнаты (дома) */
  room: Rect | null;
  left: ColumnPlan;
  right: ColumnPlan;
  /** область между колонками (пузырь, подсказки) */
  free: { top: number; bottom: number; left: number; right: number };
}

export interface TomLayoutInput {
  w: number;
  h: number;
  safe?: Partial<Insets>;
  /** пунктов в колонках */
  left: number;
  right: number;
  /** дома: ряд действий комнаты */
  room?: boolean;
  /** верх дока, если его уже измерили (DOM); без него — по формуле стилей */
  dockTop?: number;
  /** ребёнок сам вытащил колонку из язычка — она стоит, даже если кот рядом (до автоскрытия) */
  ignoreCat?: { l?: boolean; r?: boolean };
  /** прошлые режимы колонок — держим, пока они не налезают на кота (без дрожания) */
  prefer?: { l?: ColMode; r?: ColMode };
}

export const isLand = (w: number, h: number) => w > h && h <= 520;
/** отступ между кнопкой и котом */
export const CAT_GAP = 4;
const TOP_BAR = 56;
const CHIPS_H = 58;
const ROOM_H = 76;
const TAB = { w: 22, h: 72 };

/** высота дока по стилям (styles.css: --mic + отступы + safe-area) */
export function dockTopFor(w: number, h: number, safeB = 0): number {
  const land = isLand(w, h);
  const mic = land || h <= 700 ? 64 : 72;
  return h - safeB - mic - 24;
}

const hit = (a: Rect, c: CatBox | null, gap = CAT_GAP) =>
  !!c && a.x < c.cx + c.half + gap && a.x + a.w > c.cx - c.half - gap && a.y < c.bottom + gap && a.y + a.h > c.top - gap;
export const rectsHit = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
export const catHit = (r: Rect, c: CatBox | null, gap = 0) => hit(r, c, gap);

export function tomLayout(o: TomLayoutInput, catIn: CatBox | null): TomPlan {
  const { w, h } = o;
  const s: Insets = { t: 0, b: 0, l: 0, r: 0, ...o.safe };
  const land = isLand(w, h);
  const btn = land ? 46 : h <= 700 ? 50 : 56;
  const slotW = btn + (land ? 18 : 12);
  const slotH = btn + 20;
  const dockTop = o.dockTop ?? dockTopFor(w, h, s.b);
  const edgeL = Math.max(6, s.l + 4), edgeR = Math.max(6, s.r + 4);
  // книжная: ряд комнаты над доком, чипы — над ним; альбомная — ниже, после колонок
  let room: Rect | null = o.room && !land ? { x: 0, y: dockTop - ROOM_H - 4, w, h: ROOM_H } : null;
  const chipsBottom = (room ? room.y : dockTop) - 4;
  const chips: Rect = { x: 0, y: chipsBottom - CHIPS_H, w, h: CHIPS_H };
  const regTop = s.t + TOP_BAR + (land ? 0 : 8);
  // альбомная: колонки идут до низа экрана (док и чипы — между ними); книжная: колонки над рядом чипов,
  // дома — до ряда комнаты (чипы кота там редки и стоят между колонками)
  const regBottom = land ? h - s.b - 8 : room ? room.y - 6 : chips.y - 6;

  const plan = (side: 'l' | 'r', n: number): ColumnPlan => {
    const cat = o.ignoreCat?.[side] ? null : catIn;
    const x0 = (cw: number) => (side === 'l' ? edgeL : w - edgeR - cw);
    const tabY = (y: number) => Math.max(regTop, Math.min(regBottom - TAB.h, y));
    const tabX = side === 'l' ? 0 : w - TAB.w;
    const mk = (mode: ColMode, cols: number, align: 'center' | 'top', b = btn): ColumnPlan | null => {
      const sw = b + (land ? 18 : 12), sh = b + 20;
      const regH = regBottom - regTop;
      const rowsMax = Math.max(1, Math.floor(regH / sh));
      const cap = Math.min(n, rowsMax * cols);
      if (cap < Math.min(n, 3)) return null; // меньше трёх кнопок — не колонка
      const rows = Math.ceil(cap / cols);
      const cw = cols * sw, ch = rows * sh;
      const y = align === 'center' ? regTop + (regH - ch) / 2 : regTop;
      const rect = { x: x0(cw), y, w: cw, h: ch };
      const slots: Rect[] = [];
      for (let i = 0; i < cap; i++) {
        // в сетке пункты идут по строкам, слева направо (читается как текст)
        const r = cols === 1 ? i : Math.floor(i / cols), c = cols === 1 ? 0 : i % cols;
        const cx = rect.x + c * sw;
        slots.push({ x: cx, y: rect.y + r * sh, w: sw, h: sh });
      }
      return { side, mode, rect, cols, btn: b, slotW: sw, slotH: sh, slots, cap, tab: { x: tabX, y: tabY(y + ch / 2 - TAB.h / 2), w: TAB.w, h: TAB.h } };
    };
    const sm = btn - 8;
    const variants: (ColumnPlan | null)[] = land
      ? [mk('grid', 2, 'center'), mk('coltop', 2, 'top'), mk('colsm', 2, 'center', sm), mk('colsmtop', 2, 'top', sm)]
      : [mk('col', 1, 'center'), mk('coltop', 1, 'top'), mk('colsm', 1, 'center', sm), mk('colsmtop', 1, 'top', sm), mk('grid', 2, 'top')];
    const ok = (v: ColumnPlan | null, gap = CAT_GAP): v is ColumnPlan => !!v && !v.slots.some((r) => hit(r, cat, gap));
    // без дрожания: на лучший режим переходим, только когда кот отошёл с запасом; иначе держим прежний, пока он мимо кота
    const pref = o.prefer?.[side];
    const roomy = variants.find((v) => ok(v, CAT_GAP + 14));
    const keep = variants.find((v) => ok(v) && v.mode === pref);
    const pick = keep ? (roomy && variants.indexOf(roomy) < variants.indexOf(keep) ? roomy : keep) : variants.find((v) => ok(v));
    if (pick) return pick;
    // никуда не влезает — колонка прячется в язычок; язычок — туда, где кота нет
    const base = variants.find((v) => !!v) ?? mk('col', 1, 'top')!;
    const tabs = [base.tab.y, regTop, regBottom - TAB.h].map((y) => ({ x: tabX, y: tabY(y), w: TAB.w, h: TAB.h }));
    const tab = tabs.find((t) => !hit(t, catIn, 0)) ?? tabs[0];
    return { ...base, mode: 'tab', rect: tab, slots: [], tab };
  };
  const left = plan('l', o.left);
  const right = plan('r', o.right);
  const fl = left.mode === 'tab' ? 0 : left.rect.x + left.rect.w;
  const fr = right.mode === 'tab' ? w : right.rect.x;
  // чипы между колонками, если колонки опускаются до их ряда (альбомная, дом)
  if (land || room) Object.assign(chips, { x: fl, w: fr - fl });
  // альбомная: ряд комнаты — на месте чипов (между колонками над доком); пока кот о чём-то спрашивает, вместо него — чипы
  if (land && o.room) room = { x: fl, y: chips.y + chips.h - ROOM_H, w: fr - fl, h: ROOM_H };
  return {
    w, h, land, btn, slotW, slotH, dockTop, chips, room, left, right,
    free: { top: regTop, bottom: land ? dockTop : chips.y, left: fl, right: fr },
  };
}

// ───────────── автоскрытие ─────────────

/** колонки уезжают к краю после 6 с без касаний; во время сцен (пробуждение, раскраска, сон, переход) — сразу */
export const TOM_IDLE_MS = 6000;
export type TomBusy = 'awake' | 'paint' | 'sleep' | 'cutscene' | 'onb' | null;

export class TomAutoHide {
  private last = 0;
  private hiddenByIdle = false;
  constructor(private idleMs = TOM_IDLE_MS) {}
  /** касание где угодно: таймер заново (спрятанные колонки сами не выезжают — только касание у края) */
  touch(now: number) {
    this.last = now;
  }
  /** касание у края или по язычку: колонки выезжают */
  reveal(now: number) {
    this.last = now;
    this.hiddenByIdle = false;
  }
  /** спрятаны ли колонки сейчас; hold — открыт поповер / долгое нажатие: не прятать */
  hidden(now: number, busy: TomBusy, hold = false): boolean {
    if (busy) {
      // после сцены колонки возвращаются сами (и таймер — заново)
      this.last = now;
      this.hiddenByIdle = false;
      return true;
    }
    if (hold) {
      this.last = now;
      return false;
    }
    if (!this.hiddenByIdle && now - this.last >= this.idleMs) this.hiddenByIdle = true;
    return this.hiddenByIdle;
  }
}

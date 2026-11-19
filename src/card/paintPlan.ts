/**
 * Раскраска карты (feature 'card.paint'): чистая логика без DOM и three — палитры котов, путь мазка по карте и его
 * покрытие, когда кот предлагает раскрасить, где можно рисовать, память о рисунке. Тесты — tests/cardPaint.test.ts.
 *
 * Координаты карты — как у трекера (tracker/types.ts): центр карты в 0, ширина 1, высота 1/aspect, +X вправо,
 * +Y к верхнему краю картинки. Холст рисунка: верх холста = +Y карты.
 */
import type { PersonaId } from '../persona/types';
import type { ArtStroke, StrokeKind, StrokePhase } from './paintArt';

export type PatternId = 'graffiti' | 'hearts' | 'stars';
export type PaintTool = 'spray' | 'brush';

export interface Swatch {
  /** латинский id (аналитика paint_start{color}) */
  id: string;
  /** подпись под кружком */
  label: string;
  /** основной цвет рисунка */
  main: string;
}

export interface PaintStyle {
  pattern: PatternId;
  tool: PaintTool;
  /** клип «рисует» (опора — content/animations.json fallback, позже Meshy) */
  clip: 'paint_brush' | 'paint_spray';
  swatches: [Swatch, Swatch, Swatch];
}

/** фирменный рисунок и палитра каждого кота */
export const PAINT_STYLE: Record<PersonaId, PaintStyle> = {
  hooligan: {
    pattern: 'graffiti',
    tool: 'spray',
    clip: 'paint_spray',
    swatches: [
      { id: 'lime', label: 'Лайм', main: '#A8F03A' },
      { id: 'pink', label: 'Розовый', main: '#FF4FA8' },
      { id: 'purple', label: 'Фиолет', main: '#8B5CFF' },
    ],
  },
  kind: {
    pattern: 'hearts',
    tool: 'brush',
    clip: 'paint_brush',
    swatches: [
      { id: 'mint', label: 'Мята', main: '#7FE3C4' },
      { id: 'peach', label: 'Персик', main: '#FFB48F' },
      { id: 'sky', label: 'Небо', main: '#8FCBFF' },
    ],
  },
  glitter: {
    pattern: 'stars',
    tool: 'brush',
    clip: 'paint_brush',
    swatches: [
      { id: 'lilac', label: 'Сирень', main: '#C7A2FF' },
      { id: 'gold', label: 'Золото', main: '#FFCC4A' },
      { id: 'turquoise', label: 'Бирюза', main: '#33D9CC' },
    ],
  },
};

export const PATTERN_PERSONA: Record<PatternId, PersonaId> = { graffiti: 'hooligan', hearts: 'kind', stars: 'glitter' };

/** цвет по id (любого кота) — для восстановления рисунка из памяти */
export function findSwatch(pattern: PatternId, color: string): { style: PaintStyle; swatch: Swatch; others: Swatch[] } | null {
  const style = PAINT_STYLE[PATTERN_PERSONA[pattern]];
  const swatch = style?.swatches.find((s) => s.id === color);
  if (!style || !swatch) return null;
  return { style, swatch, others: style.swatches.filter((s) => s !== swatch) };
}

// ───────────── хореография: где стоит кот и что рисует ─────────────
//
// Кот не ходит по карте: он стоит у дальнего края карты (на столе за картой, лицом к зрителю), приседает и рисует
// перед собой — баллончиком (Хулиган) или кистью (Добряк, Блёстка). Карта — как пол перед котом; переходит между
// 2–3 точками у края (короткий шаг), а не идёт через карту. Порядок — как у настоящего райтера: тег и обводка →
// фон и заливка → кляксы → (потёки стекают сами) → отошёл, посмотрел → звёзды и последний штрих → показывает.

export interface Pt {
  x: number;
  y: number;
}

/** мазок в координатах карты (центр 0, ширина 1, +Y — к верхнему краю картинки) */
export interface PlanStroke {
  layer: string;
  /** base — фон рисунка широкими рядами (закрывает карту целиком) */
  phase: StrokePhase | 'base';
  kind: StrokeKind;
  pts: Pt[];
  /** радиус штампа маски, ширин карты */
  r: number;
  /** длительность, с */
  dur: number;
  /** пунктир: путь через точки штампов, краска идёт только у точек (пшик-пшик по звёздам, точки конфетти) */
  dots?: boolean;
}

export type Step =
  | { k: 'shake'; dur: number }
  | { k: 'dip'; dur: number }
  | { k: 'walk'; to: Pt; face: Pt; back?: boolean; max: number }
  | { k: 'crouch'; on: boolean; dur: number }
  /** gap — сопло/кисть переводится к началу мазка (краска не идёт) */
  | { k: 'stroke'; s: PlanStroke; gap: number }
  | { k: 'admire'; dur: number; at: Pt }
  | { k: 'show'; dur: number };

export interface Choreo {
  steps: Step[];
  /** потёки: стекают сами через delay с после конца шага after */
  drips: { s: PlanStroke; after: number; delay: number }[];
  /** где стоит банка краски (кисть): у дальнего края, между точками */
  pot: Pt;
  /** оценка длительности, с (шаги ходьбы — по скорости walkSpeed) */
  total: number;
}

/** рисунок шире карты на 2 % (дрожание трекера не открывает край): сетка overlay 1.02 × 1.02/aspect */
export const ART_SPAN = 1.02;

/** пиксель холста рисунка W×H → точка карты */
export function canvasToCard(u: number, v: number, W: number, H: number, aspect: number): Pt {
  return { x: (u / W - 0.5) * ART_SPAN, y: (0.5 - v / H) * (ART_SPAN / aspect) };
}
/** точка карты → доли холста (0…1, v — вниз) */
export function cardToUv(p: Pt, aspect: number): { u: number; v: number } {
  return { u: p.x / ART_SPAN + 0.5, v: 0.5 - p.y / (ART_SPAN / aspect) };
}

export const pathLen = (pts: Pt[]) => {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return L;
};

/** точка на пути по доле длины 0…1 */
export function pointAt(pts: Pt[], k: number, out: Pt = { x: 0, y: 0 }): Pt {
  if (pts.length === 1 || k <= 0) return Object.assign(out, pts[0]);
  const L = pathLen(pts);
  let want = Math.min(1, k) * L;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (want <= d || i === pts.length - 1) {
      const t = d > 1e-9 ? Math.min(1, want / d) : 1;
      out.x = pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t;
      out.y = pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t;
      return out;
    }
    want -= d;
  }
  return Object.assign(out, pts[pts.length - 1]);
}

/** скорости и длительности (ширин карты в секунду / секунды) */
export const PACE = {
  spray: { outline: 2.0, base: 2.7, fill: 3.6, flourish: 1.5, path: 3.6, burst: { splat: 0.18, star: 0.1, item: 0.12, dab: 0.06, flourish: 0.3, fill: 0.2, outline: 0.2, drip: 0.2 } },
  brush: { outline: 1.0, base: 2.1, fill: 1.8, flourish: 1.2, path: 3.6, burst: { splat: 0.2, star: 0.14, item: 0.11, dab: 0.06, flourish: 0.32, fill: 0.2, outline: 0.2, drip: 0.2 } },
  /** потёк стекает, ширин карты в секунду */
  drip: 0.13,
  /** перевод сопла между мазками */
  gapSpeed: 3.0,
  gapMin: 0.05,
  gapMax: 0.26,
} as const;

/**
 * Где стоит кот: на столе у боковых краёв карты (за краем на 0,1), лицом к середине карты — зритель видит его в
 * профиль: лапа с баллончиком / кистью вытянута к карте, а не на камеру. L — левая половина, R — правая (и последний
 * штрих); back — шаг назад «посмотреть»; pot — банка краски (кисть) у левого края, ближе к зрителю.
 */
export function paintSpots(aspect: number): { L: Pt; R: Pt; C: Pt; pot: Pt; back: number } {
  const x = 0.5 + 0.1, y = 0.04;
  return { L: { x: -x, y }, R: { x, y }, C: { x, y }, pot: { x: -0.53, y: -0.5 / aspect + 0.05 }, back: 0.13 };
}

/** фон широкими полосами по половине x0…x1 (через всю высоту рисунка) — столбцами от кота вглубь: баллончик — ровно, кисть — волной */
export function baseSweep(x0: number, x1: number, aspect: number, tool: PaintTool, cols = 3, fromRight = false): { pts: Pt[]; r: number } {
  const half = ART_SPAN / aspect / 2;
  const step = (x1 - x0) / cols;
  const r = step * 0.76;
  const pts: Pt[] = [];
  const over = 0.035;
  for (let i = 0; i < cols; i++) {
    const c = fromRight ? cols - 1 - i : i;
    const x = x0 + step * (c + 0.5);
    const a = i % 2 ? -half - over : half + over, b = -a;
    const n = tool === 'brush' ? 10 : 2;
    for (let k = 0; k <= n; k++) {
      const t = k / n, y = a + (b - a) * t;
      const wx = tool === 'brush' ? Math.sin(t * Math.PI * 2 + i * 1.3) * step * 0.16 : 0;
      pts.push({ x: x + wx, y });
    }
  }
  return { pts, r };
}

/** ближайший сосед: обход точек без длинных перелётов (начиная от from) */
function nearestOrder<T>(items: T[], at: (t: T) => Pt, from: Pt): T[] {
  const left = [...items], out: T[] = [];
  let cur = from;
  while (left.length) {
    let bi = 0, bd = Infinity;
    left.forEach((it, i) => {
      const p = at(it), d = Math.hypot(p.x - cur.x, p.y - cur.y);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    });
    const [it] = left.splice(bi, 1);
    out.push(it);
    const pts = (it as unknown as PlanStroke).pts;
    cur = pts ? pts[pts.length - 1] : at(it);
  }
  return out;
}

/** длительность мазка по виду и скорости инструмента */
export function strokeDur(s: Pick<PlanStroke, 'kind' | 'phase' | 'pts'>, tool: PaintTool): number {
  const p = PACE[tool];
  if (s.kind === 'drip') return Math.max(0.5, Math.min(1.6, pathLen(s.pts) / PACE.drip));
  if (s.kind === 'burst') return p.burst[s.phase as keyof typeof p.burst] ?? 0.15;
  const v = (p as unknown as Record<string, number>)[s.phase] ?? p.path;
  return Math.max(0.12, pathLen(s.pts) / v);
}

/** пунктир: остановка у каждой точки, с */
export const DOT_HOLD = 0.04;

const centroid = (pts: Pt[]): Pt => ({ x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length });

/** путь через все точки мелких штампов (крестики, конфетти): слой пуст между ними — открываются только они */
function chain(list: PlanStroke[], from: Pt, phase: PlanStroke['phase'], tool: PaintTool): PlanStroke | null {
  if (!list.length) return null;
  const ord = nearestOrder(list, (s) => s.pts[0], from);
  const s: PlanStroke = { layer: ord[0].layer, phase, kind: 'path', pts: ord.map((o) => o.pts[0]), r: Math.max(...ord.map((o) => o.r)), dur: 0, dots: true };
  s.dur = Math.max(0.15, pathLen(s.pts) / PACE[tool].path + ord.length * DOT_HOLD);
  return s;
}

/**
 * План раскраски: art — мазки элементов рисунка (paintArt.artStrokes / drawLayers, пиксели холста W×H).
 * Половины карты: левая — от точки L, правая — от R; звёзды и последний штрих — после «отошёл, посмотрел».
 */
export function choreograph(art: ArtStroke[], W: number, H: number, aspect: number, tool: PaintTool, walkSpeed = 0.8): Choreo {
  const sp = paintSpots(aspect);
  const all: PlanStroke[] = art.map((a) => {
    const s: PlanStroke = { layer: a.layer, phase: a.phase, kind: a.kind, pts: a.pts.map(([u, v]) => canvasToCard(u, v, W, H, aspect)), r: (a.r / W) * ART_SPAN, dur: 0 };
    s.dur = strokeDur(s, tool);
    return s;
  });
  const steps: Step[] = [];
  const drips: Choreo['drips'] = [];
  const sideOf = (s: PlanStroke) => (centroid(s.pts).x < 0 ? 'L' : 'R');
  const face = (p: Pt): Pt => ({ x: p.x * 0.25, y: p.y - 0.02 });
  let at: Pt = { x: 0, y: 0 };
  const addStroke = (s: PlanStroke) => {
    const d = Math.hypot(s.pts[0].x - at.x, s.pts[0].y - at.y);
    steps.push({ k: 'stroke', s, gap: Math.max(PACE.gapMin, Math.min(PACE.gapMax, d / PACE.gapSpeed)) });
    at = s.pts[s.pts.length - 1];
  };
  const spray = tool === 'spray';
  const late = (s: PlanStroke) => s.phase === 'star' || s.phase === 'flourish';
  let first = true;
  for (const side of ['L', 'R'] as const) {
    const spot = sp[side];
    // ко второй половине — вокруг карты, по дальнему краю (не по рисунку)
    if (side === 'R') steps.push({ k: 'walk', to: { x: 0, y: 0.5 / aspect + 0.13 }, face: spot, max: 1.6 });
    steps.push({ k: 'walk', to: spot, face: face(spot), max: 2.4 });
    if (spray) steps.push({ k: 'shake', dur: first ? 0.8 : 0.35 });
    else if (first) steps.push({ k: 'dip', dur: 0.75 });
    steps.push({ k: 'crouch', on: true, dur: 0.24 });
    first = false;
    at = { x: spot.x * 0.8, y: spot.y };
    const mine = all.filter((s) => s.phase !== 'drip' && !late(s) && sideOf(s) === side);
    const by = (ph: PlanStroke['phase']) => nearestOrder(mine.filter((s) => s.phase === ph), (s) => s.pts[0], at);
    // 1. тег и обводка (баллончик)
    for (const s of by('outline')) addStroke(s);
    // 2. фон половины — широкими рядами от лап к ближнему краю
    // от края у лап — вглубь, к середине карты
    const half = side === 'L' ? baseSweep(-ART_SPAN / 2, 0.02, aspect, tool, 3, false) : baseSweep(-0.02, ART_SPAN / 2, aspect, tool, 3, true);
    const base: PlanStroke = { layer: 'bg', phase: 'base', kind: 'path', pts: half.pts, r: half.r, dur: 0 };
    base.dur = strokeDur(base, tool);
    addStroke(base);
    const afterBase = steps.length - 1;
    // 3. заливка кусков, кляксы; кисть — сердечки / звёзды штампами, потом точки-конфетти одним проходом
    for (const s of by('fill')) addStroke(s);
    for (const s of by('splat')) addStroke(s);
    for (const s of by('item')) addStroke(s);
    const dab = chain(mine.filter((s) => s.phase === 'dab'), at, 'dab', tool);
    if (dab) addStroke(dab);
    // потёки этой половины — стекают после заливки (сверху — после фона)
    const myDrips = all.filter((s) => s.phase === 'drip' && sideOf(s) === side);
    myDrips.forEach((s, i) => drips.push({ s, after: s.pts[0].y > 0.3 ? afterBase : steps.length - 1, delay: 0.25 + i * 0.22 }));
    steps.push({ k: 'crouch', on: false, dur: 0.18 });
  }
  // отошёл, посмотрел
  const last = sp.R;
  steps.push({ k: 'walk', to: { x: last.x + Math.sign(last.x) * sp.back, y: last.y - 0.04 }, face: { x: 0, y: 0 }, back: true, max: 1.2 });
  steps.push({ k: 'admire', dur: 0.85, at: { x: 0, y: 0 } });
  // и последний штрих: звёзды (баллончик — пшик в каждую, крестики — одним проходом) и стрелки / большое сердце
  steps.push({ k: 'walk', to: sp.C, face: face(sp.C), max: 1.6 });
  steps.push({ k: 'crouch', on: true, dur: 0.24 });
  at = { x: sp.C.x * 0.8, y: sp.C.y };
  const stars = all.filter((s) => s.phase === 'star');
  // пшик-пшик: пунктир по всем звёздам и крестикам, у каждой точки — короткая остановка
  const st = chain(stars, at, 'star', tool);
  if (st) addStroke(st);
  for (const s of nearestOrder(all.filter((s) => s.phase === 'flourish'), (s) => s.pts[0], at)) addStroke(s);
  steps.push({ k: 'crouch', on: false, dur: 0.18 });
  steps.push({ k: 'show', dur: 1.0 });
  // длительность: ходьба — по расстоянию
  let total = 0, pos: Pt = { x: 0, y: -0.1 };
  for (const st of steps) {
    if (st.k === 'walk') {
      total += Math.min(st.max, Math.hypot(st.to.x - pos.x, st.to.y - pos.y) / walkSpeed + 0.15);
      pos = st.to;
    } else if (st.k === 'stroke') total += st.gap + st.s.dur;
    else total += st.dur;
  }
  return { steps, drips, pot: sp.pot, total };
}

/**
 * Доля карты, закрытая фоном (мазки base): сетка n×n точек карты; jitter — неровность края штампа в долях радиуса.
 * 1 — закрыто всё: номер карты и имя не видны на скриншоте (в конце маска фона ещё и заливается целиком).
 */
export function baseCoverage(c: Choreo, aspect: number, n = 40, jitter = 0.1): number {
  const base = c.steps.flatMap((s) => (s.k === 'stroke' && s.s.phase === 'base' ? [s.s] : []));
  const half = 0.5 / aspect;
  let hit = 0;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const x = -0.5 + (i + 0.5) / n, y = -half + ((j + 0.5) / n) * half * 2;
      if (base.some((s) => segDist(x, y, s.pts) <= s.r * (1 - jitter))) hit++;
    }
  return hit / (n * n);
}

/** расстояние от точки до ломаной */
export function segDist(x: number, y: number, pts: Pt[]): number {
  if (pts.length === 1) return Math.hypot(x - pts[0].x, y - pts[0].y);
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / L2)) : 0;
    best = Math.min(best, Math.hypot(x - a.x - dx * t, y - a.y - dy * t));
  }
  return best;
}

/**
 * Куда попадает краска: луч из сопла (кончика кисти) o по направлению d → точка на плоскости карты (z = 0, координаты
 * карты). null — луч не идёт к карте (сопло смотрит вверх / вдоль карты).
 */
export function nozzleHit(o: { x: number; y: number; z: number }, d: { x: number; y: number; z: number }): (Pt & { dist: number }) | null {
  if (d.z > -1e-4) return null;
  const t = -o.z / d.z;
  if (t < 0) return null;
  const len = Math.hypot(d.x, d.y, d.z);
  return { x: o.x + d.x * t, y: o.y + d.y * t, dist: t * len };
}

/** баллончик: пятно краски шире с расстояния (конус ~22°), не уже радиуса мазка */
export function sprayRadius(r: number, dist: number): number {
  return Math.max(r, Math.min(r * 1.6, r * (0.75 + dist * 1.2)));
}

// ───────────── где можно рисовать ─────────────

export interface PaintWhere {
  /** кот дома («Мир кота»), а не на карте */
  home: boolean;
  /** карта в кадре */
  tracking: boolean;
  /** карта захвачена (cardTracker: locked); у трекеров без захвата — как tracking */
  locked: boolean;
  /** кот на экране и стоит на карте (не «у стекла», не в сцене пробуждения) */
  catOnCard: boolean;
}

/** null — можно; иначе почему нет: 'need_card' — «Сначала покажи мне карту» */
export function paintBlocked(w: PaintWhere): 'need_card' | null {
  if (w.home || !w.tracking || !w.locked || !w.catOnCard) return 'need_card';
  return null;
}

// ───────────── когда кот предлагает ─────────────

export const OFFER_FIRST_MS = 60_000;
export const OFFER_PLAY_MS = 90_000;
/** сколько держатся чипы «Раскрась! / Не сейчас» */
export const OFFER_SHOW_MS = 12_000;

/**
 * «Хочешь, раскрашу твою карту?» — один раз за сессию: после ≥ 90 с игры или после игры (загадка, повторялка),
 * но никогда в первую минуту. ok — кот свободен (на карте, молчит, без диалога и дрёмы, ребёнок не занят).
 */
export class PaintOfferRule {
  offered = false;
  private gameEnded = false;
  private start = -1;
  constructor(readonly firstMs = OFFER_FIRST_MS, readonly playMs = OFFER_PLAY_MS) {}
  /** начало игры (кот вышел на карту) */
  begin(now: number) {
    if (this.start < 0) this.start = now;
  }
  gameEnd() {
    this.gameEnded = true;
  }
  /** ребёнок сам начал раскраску — предлагать уже незачем */
  done() {
    this.offered = true;
  }
  due(now: number, ok: boolean): boolean {
    if (this.offered || !ok || this.start < 0) return false;
    const t = now - this.start;
    if (t < this.firstMs) return false;
    return t >= this.playMs || this.gameEnded;
  }
  mark() {
    this.offered = true;
  }
  /** отладка (вкладка «Тест»): как будто играем уже playMs и ещё не предлагали */
  rewind(now: number) {
    this.offered = false;
    this.start = now - this.playMs;
  }
}

// ───────────── память ─────────────

/** ключ с префиксом sber-ar-cat: — синхронизируется с сервером прогресса (progress/sync.ts isProgressKey) */
export const PAINT_KEY = 'sber-ar-cat:paint';

export interface SavedPaint {
  pattern: PatternId;
  color: string;
  seed: number;
}

const PATTERNS: readonly PatternId[] = ['graffiti', 'hearts', 'stars'];

export function loadPaint(storage: Pick<Storage, 'getItem'> | null): SavedPaint | null {
  try {
    const raw = storage?.getItem(PAINT_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!PATTERNS.includes(o?.pattern) || typeof o.color !== 'string' || !Number.isFinite(o.seed)) return null;
    if (!findSwatch(o.pattern, o.color)) return null;
    return { pattern: o.pattern, color: o.color, seed: o.seed >>> 0 };
  } catch {
    return null;
  }
}

export function savePaint(p: SavedPaint, storage: Pick<Storage, 'setItem'> | null) {
  try {
    storage?.setItem(PAINT_KEY, JSON.stringify({ pattern: p.pattern, color: p.color, seed: p.seed >>> 0 }));
  } catch {
    /* хранилище недоступно — рисунок живёт до конца сессии */
  }
}

export function erasePaint(storage: Pick<Storage, 'removeItem'> | null) {
  try {
    storage?.removeItem(PAINT_KEY);
  } catch {
    /* ignore */
  }
}

// ───────────── каталог ─────────────

export const PAINT_ITEM = { id: 'ui:paint', label: 'Раскрасить карту', icon: 'paint' } as const;
export const ERASE_ITEM = { id: 'ui:paint_erase', label: 'Стереть рисунок', icon: 'eraser' } as const;

/** пункты раздела «Образ»: «Раскрасить карту» всегда (вне карты — «Сначала покажи мне карту»), «Стереть» — если есть рисунок */
export function paintCatalogItems(hasPainting: boolean): { id: string; label: string; icon: string; run: { ui: 'paint' | 'paint_erase' } }[] {
  const out: { id: string; label: string; icon: string; run: { ui: 'paint' | 'paint_erase' } }[] = [{ ...PAINT_ITEM, run: { ui: 'paint' } }];
  if (hasPainting) out.push({ ...ERASE_ITEM, run: { ui: 'paint_erase' } });
  return out;
}

/** генератор случайных чисел по зерну (mulberry32): тот же seed — тот же рисунок на следующем визите */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

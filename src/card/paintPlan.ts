/**
 * Раскраска карты (feature 'card.paint'): чистая логика без DOM и three — палитры котов, путь мазка по карте и его
 * покрытие, когда кот предлагает раскрасить, где можно рисовать, память о рисунке. Тесты — tests/cardPaint.test.ts.
 *
 * Координаты карты — как у трекера (tracker/types.ts): центр карты в 0, ширина 1, высота 1/aspect, +X вправо,
 * +Y к верхнему краю картинки. Холст рисунка: верх холста = +Y карты.
 */
import type { PersonaId } from '../persona/types';

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

// ───────────── путь мазка ─────────────

export interface PaintRow {
  /** y ряда в координатах карты */
  y: number;
  /** направление: +1 слева направо, -1 справа налево */
  dir: 1 | -1;
}

/** запас мазка за край карты (доли ширины): трекер дрожит, рисунок не должен открывать край карты */
export const ROW_OVERHANG = 0.06;
/**
 * Змейка из трёх рядов: дальний край → середина → ближний; полуширина мазка — так, чтобы ряды перекрывались
 * и закрывали карту целиком (номер и имя на любом месте карты), с запасом на неровный край кисти.
 */
export function paintRows(aspect: number): { rows: PaintRow[]; radius: number; half: number } {
  const half = 0.5 / aspect; // полувысота карты
  const step = (half * 2) / 3;
  const rows: PaintRow[] = [
    { y: step, dir: 1 },
    { y: 0, dir: -1 },
    { y: -step, dir: 1 },
  ];
  return { rows, radius: step * 0.68, half };
}

/** расстояние от точки до ряда (отрезок по всей ширине карты с запасом) */
const rowDist = (x: number, y: number, r: PaintRow) => {
  const x0 = -0.5 - ROW_OVERHANG, x1 = 0.5 + ROW_OVERHANG;
  const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
  return Math.hypot(dx, y - r.y);
};

/**
 * Доля карты, закрытая готовым мазком (сетка n×n точек; jitter — неровность края кисти в долях радиуса).
 * 1 — закрыто всё: номер карты и имя не видны на скриншоте.
 */
export function strokeCoverage(aspect: number, n = 40, jitter = 0.1): number {
  const { rows, radius, half } = paintRows(aspect);
  const r = radius * (1 - jitter);
  let hit = 0;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const x = -0.5 + (i + 0.5) / n, y = -half + ((j + 0.5) / n) * half * 2;
      if (rows.some((row) => rowDist(x, y, row) <= r)) hit++;
    }
  return hit / (n * n);
}

/** x кончика кисти по позиции кота: кот ходит в пределах ±0,36, кисть дотягивается до края с запасом */
export function headFromCat(catX: number, reach = 0.36): number {
  const k = (0.5 + ROW_OVERHANG) / reach;
  return Math.max(-0.5 - ROW_OVERHANG, Math.min(0.5 + ROW_OVERHANG, catX * k));
}

/** точки ходьбы кота по рядам (концы рядов, клампится Stage.clampTarget) */
export function catWaypoints(aspect: number, reach = 0.36): { x: number; y: number }[][] {
  const { rows } = paintRows(aspect);
  // кот чуть ближе к зрителю, чем середина ряда: кисть — перед ним, не под лапами
  return rows.map((r) => [
    { x: -r.dir * reach, y: r.y - 0.03 },
    { x: r.dir * reach, y: r.y - 0.03 },
  ]);
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

/**
 * Группы каталога для листа на телефоне (feature 'catalog.sheet') и десктоп-панели (feature 'desktop.panel').
 * Источник — тот же каталог (actionCatalog.buildCatalog + «Ещё» + пункт дома из app.ts): здесь пункты только
 * перекладываются по разделам «Ласка · Трюки · Игры · Фразы · Образ · Мир · Служебное», ничего не добавляется и не теряется
 * (тест tests/catalogGroups.test.ts). Пункт, которого нет в таблице ITEM_GROUP, попадает в группу по своему разделу.
 * Без DOM.
 */
import type { CatalogItem, CatalogSection } from './actionCatalog';

export type GroupId = 'often' | 'care' | 'tricks' | 'games' | 'say' | 'look' | 'world' | 'service';

export interface CatalogGroup {
  id: GroupId;
  title: string;
  icon: string;
  items: CatalogItem[];
}

export const GROUP_META: Record<GroupId, { title: string; icon: string }> = {
  often: { title: 'Часто', icon: 'star' },
  care: { title: 'Ласка', icon: 'heart' },
  tricks: { title: 'Трюки', icon: 'flip' },
  games: { title: 'Игры', icon: 'quest' },
  say: { title: 'Фразы', icon: 'chat' },
  look: { title: 'Образ', icon: 'sparkle' },
  world: { title: 'Мир', icon: 'home_house' },
  service: { title: 'Служебное', icon: 'gear' },
};

/** порядок групп (без «Часто» — его собирает oftenGroup) */
export const GROUP_ORDER: GroupId[] = ['care', 'tricks', 'games', 'say', 'look', 'world', 'service'];

/** раздел каталога → группа по умолчанию */
const SECTION_GROUP: Record<string, GroupId> = { care: 'care', tricks: 'tricks', emotions: 'tricks', games: 'games', magic: 'look', say: 'say', more: 'service' };

/** отдельные пункты, которые живут не в группе своего раздела */
const ITEM_GROUP: Record<string, GroupId> = {
  sing: 'games',
  other: 'look',
  sticker: 'look',
  'ui:unstick': 'look',
  'ui:reanchor': 'world',
  'ui:micmode': 'service',
};

export function groupOf(item: CatalogItem, sectionId: string): GroupId {
  if (ITEM_GROUP[item.id]) return ITEM_GROUP[item.id];
  if (item.id.startsWith('home:') || item.id.startsWith('zone:')) return 'world';
  return SECTION_GROUP[sectionId] ?? 'service';
}

/** разделы каталога → группы (пустые не показываем); extra — пункты без раздела (десктоп: «Сдёрнуть наклейки», комнаты) */
export function groupCatalog(sections: CatalogSection[], extra: { item: CatalogItem; section: string }[] = []): CatalogGroup[] {
  const by = new Map<GroupId, CatalogItem[]>();
  const seen = new Set<string>();
  const put = (it: CatalogItem, sec: string) => {
    if (seen.has(it.id)) return;
    seen.add(it.id);
    const g = groupOf(it, sec);
    if (!by.has(g)) by.set(g, []);
    by.get(g)!.push(it);
  };
  for (const s of sections) for (const it of s.items) put(it, s.id);
  for (const e of extra) put(e.item, e.section);
  return GROUP_ORDER.filter((g) => by.get(g)?.length).map((g) => ({ id: g, ...GROUP_META[g], items: by.get(g)! }));
}

/** «Часто»: последние выбранные + то, что кот предлагает прямо сейчас (только пункты, что есть в каталоге) */
export function oftenGroup(groups: CatalogGroup[], recent: readonly string[], suggested: readonly string[], max = 8): CatalogGroup | null {
  const all = new Map(groups.flatMap((g) => g.items).map((i) => [i.id, i]));
  const out: CatalogItem[] = [];
  for (const id of [...suggested, ...recent]) {
    const it = all.get(id);
    if (it && !out.includes(it) && out.length < max) out.push(it);
  }
  return out.length ? { id: 'often', ...GROUP_META.often, items: out } : null;
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();

/** поиск по подписи (и id): каждое слово запроса — начало слова подписи или часть id; пустой запрос — всё */
export function filterGroups(groups: CatalogGroup[], query: string): CatalogGroup[] {
  const q = norm(query);
  if (!q) return groups;
  const words = q.split(' ');
  const hit = (it: CatalogItem) => {
    const label = norm(it.label);
    const lw = label.split(' ');
    return words.every((w) => lw.some((x) => x.startsWith(w)) || label.includes(w) || it.id.toLowerCase().includes(w));
  };
  return groups.map((g) => ({ ...g, items: g.items.filter(hit) })).filter((g) => g.items.length);
}

/** первый пункт после фильтра (Enter в поиске) */
export function firstMatch(groups: CatalogGroup[], query: string): CatalogItem | null {
  return filterGroups(groups, query)[0]?.items[0] ?? null;
}

/** последние выбранные пункты (для «Часто»): localStorage, без него — в памяти */
export class RecentStore {
  private ids: string[] = [];
  constructor(private store: Pick<Storage, 'getItem' | 'setItem'> | null = safe(), private key = 'ar.catalog.recent', private max = 8) {
    try {
      const v = JSON.parse(store?.getItem(key) ?? '[]');
      if (Array.isArray(v)) this.ids = v.filter((x) => typeof x === 'string').slice(0, max);
    } catch {
      /* битое значение */
    }
  }
  get list(): readonly string[] {
    return this.ids;
  }
  push(id: string) {
    this.ids = [id, ...this.ids.filter((x) => x !== id)].slice(0, this.max);
    try {
      this.store?.setItem(this.key, JSON.stringify(this.ids));
    } catch {
      /* приватный режим */
    }
  }
}

function safe(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Сдвиг кота, чтобы лист/панель его не закрывали: прямоугольник кота (без сдвига) и свободная область → смещение и масштаб.
 * Масштаб — вокруг макушки (cx, top); применяется transform холста (app.ts) и обратным преобразованием в попадании по коту.
 */
export interface ViewShift {
  dx: number;
  dy: number;
  s: number;
  ox: number;
  oy: number;
}
export const NO_SHIFT: ViewShift = { dx: 0, dy: 0, s: 1, ox: 0, oy: 0 };

/** allowScale = false — только сдвиг (дом: комната в том же холсте, уменьшение открыло бы пустые края) */
export function fitShift(cat: { top: number; bottom: number; cx: number; half: number } | null, free: { top: number; bottom: number; left: number; right: number }, pad = 10, allowScale = true): ViewShift {
  if (!cat) return NO_SHIFT;
  const h = Math.max(1, cat.bottom - cat.top);
  const w = Math.max(1, cat.half * 2);
  const availH = Math.max(40, free.bottom - free.top - pad * 2);
  const availW = Math.max(40, free.right - free.left - pad * 2);
  const s = allowScale ? Math.min(1, availH / h, availW / w) : 1;
  const ox = cat.cx, oy = cat.top;
  // после масштаба вокруг (cx, top): кот от top до top + s·h, ширина s·w
  let dy = 0;
  const bottom = oy + s * h;
  if (bottom > free.bottom - pad) dy = free.bottom - pad - bottom;
  if (oy + dy < free.top + pad) dy = free.top + pad - oy;
  let dx = 0;
  const l = ox - (s * w) / 2, r = ox + (s * w) / 2;
  if (r > free.right - pad) dx = free.right - pad - r;
  if (l + dx < free.left + pad) dx = free.left + pad - l;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && s > 0.999) return NO_SHIFT;
  return { dx, dy, s, ox, oy };
}

/** экранная точка (после сдвига) → точка без сдвига (для попадания по коту) */
export function unshiftPoint(v: ViewShift, x: number, y: number): { x: number; y: number } {
  return { x: v.ox + (x - v.dx - v.ox) / v.s, y: v.oy + (y - v.dy - v.oy) / v.s };
}
/** точка без сдвига → экранная (якоря эффектов, пузырь) */
export function shiftPoint(v: ViewShift, x: number, y: number): { x: number; y: number } {
  return { x: v.ox + (x - v.ox) * v.s + v.dx, y: v.oy + (y - v.oy) * v.s + v.dy };
}
/** CSS transform холста: translate(dx,dy) · scale(s) вокруг (ox, oy) */
export function shiftCss(v: ViewShift): string {
  if (v === NO_SHIFT || (v.s === 1 && !v.dx && !v.dy)) return '';
  return `translate(${(v.dx + v.ox * (1 - v.s)).toFixed(1)}px, ${(v.dy + v.oy * (1 - v.s)).toFixed(1)}px) scale(${v.s.toFixed(4)})`;
}

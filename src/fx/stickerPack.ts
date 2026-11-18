/**
 * Пак наклеек «СберКот» (public/stickers/sber, манифест генерирует scripts/stickers/gen_sber_pack.py).
 * Подбор: при смене образа — тематические нового кота + 2–3 общих; «Чудеса → Наклейки» — случайная из пака
 * (не та же, что в прошлый раз). Коллекция «собрал N из M» — localStorage.
 */
import manifest from './stickerPack.manifest.json';
import type { StickerSpec } from '../persona/types';

export type PackTheme = 'cat' | 'sber' | 'friends' | 'words' | 'hooligan' | 'kind' | 'glitter';
export interface PackSticker { id: string; title: string; theme: PackTheme; personas: string[]; src: string }

export const PACK: readonly PackSticker[] = manifest.stickers as PackSticker[];
export const PACK_THEMES: Record<PackTheme, string> = manifest.themes as Record<PackTheme, string>;
/** наклеек на стекле одновременно — не больше */
export const MAX_ON_GLASS = 8;
/** общих (не тематических) наклеек при смене образа */
const COMMON_ON_COVER = 3;
/** общие темы: СберКот, детские темы Сбера, добрые слова */
const COMMON: ReadonlySet<PackTheme> = new Set(['cat', 'sber', 'words']);

/**
 * Редакция MVP (feature('stickers.pack') выключена): прежние процедурные наклейки кота, без грубых и «взрослых» надписей
 * (убраны «ТУТ БЫЛ КОТ», «ЙО!», «ХОП» — зеркальная «ХОП» читалась как «ПОХ», граффити-тег «КОТ»; надписи больше не зеркалятся).
 */
export const LEGACY: Record<'hooligan' | 'kind' | 'glitter', StickerSpec[]> = {
  hooligan: [{ kind: 'star' }, { kind: 'text', text: 'КРУТО' }, { kind: 'bolt' }, { kind: 'text', text: 'СКЕЙТ' }, { kind: 'star' }, { kind: 'text', text: 'ЛУЧШИЙ' }],
  kind: [{ kind: 'heart' }, { kind: 'text', text: 'ТЫ СУПЕР' }, { kind: 'star' }, { kind: 'heart' }, { kind: 'text', text: 'МУР' }, { kind: 'text', text: 'ОБНИМУ' }],
  glitter: [{ kind: 'holo' }, { kind: 'heart' }, { kind: 'star' }, { kind: 'text', text: 'ВАУ' }, { kind: 'holo' }, { kind: 'text', text: 'БЛЕСК' }],
};

/** наклейки кота в этой редакции: пак (как в meta.json) или прежние процедурные (MVP) — по коту, чьи наклейки пришли */
export function editionStickers(specs: StickerSpec[], packOn: boolean): StickerSpec[] {
  if (packOn) return specs;
  if (!specs.some((s) => s.kind === 'image')) return specs;
  const votes = new Map<string, number>();
  for (const s of specs) for (const p of packById(packIdOf(s) ?? '')?.personas ?? []) votes.set(p, (votes.get(p) ?? 0) + 1);
  const who = [...votes].sort((x, y) => y[1] - x[1])[0]?.[0] as keyof typeof LEGACY | undefined;
  return LEGACY[who ?? 'kind'] ?? LEGACY.kind;
}

export const packSpec = (p: PackSticker): StickerSpec => ({ kind: 'image', src: p.src, id: p.id });
export const packById = (id: string) => PACK.find((p) => p.id === id);
/** id наклейки пака по спецификации (по id или по пути к картинке) */
export const packIdOf = (s: StickerSpec): string | undefined => s.id ?? PACK.find((p) => p.src === s.src)?.id;

const shuffle = <T>(a: T[], rnd: () => number): T[] => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/**
 * Набор для заклеивания экрана при смене образа: count наклеек, из них COMMON_ON_COVER общих, остальные — тематические
 * нового кота (его stickers из meta.json, а если там не пак — по полю personas манифеста). Порядок перемешан.
 */
export function coverSet(personaStickers: StickerSpec[], count = MAX_ON_GLASS, persona?: string, rnd: () => number = Math.random): StickerSpec[] {
  count = Math.max(1, Math.min(MAX_ON_GLASS, count));
  let themed = personaStickers.filter((s) => s.kind === 'image' && packIdOf(s));
  if (!themed.length && persona) themed = PACK.filter((p) => p.personas.includes(persona)).map(packSpec);
  const ids = new Set(themed.map(packIdOf));
  const nCommon = themed.length ? Math.min(COMMON_ON_COVER, count - 1) : count;
  const common = shuffle(PACK.filter((p) => COMMON.has(p.theme) && !ids.has(p.id)), rnd).slice(0, nCommon).map(packSpec);
  const t = shuffle([...themed], rnd);
  const out = [...common];
  for (let i = 0; out.length < count && t.length; i++) out.push(t[i % t.length]);
  return shuffle(out, rnd);
}

let lastRandom = '';
/** случайная наклейка пака, не та же, что в прошлый раз */
export function nextRandom(rnd: () => number = Math.random): StickerSpec {
  const pool = PACK.filter((p) => p.id !== lastRandom);
  const p = pool[Math.floor(rnd() * pool.length)] ?? PACK[0];
  lastRandom = p.id;
  return packSpec(p);
}

// ───────────── коллекция ─────────────
const KEY = 'ar.stickers.collected';
let cache: Set<string> | null = null;
const store = (): Set<string> => {
  if (cache) return cache;
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '[]');
    cache = new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string' && packById(x)) : []);
  } catch {
    cache = new Set();
  }
  return cache;
};
/** отметить наклейку собранной; true — новая в коллекции */
export function collect(spec: StickerSpec): boolean {
  const id = packIdOf(spec);
  if (!id || store().has(id)) return false;
  store().add(id);
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify([...store()]));
  } catch {
    /* приватный режим — коллекция только на сессию */
  }
  return true;
}
export const collection = () => ({ n: store().size, total: PACK.length, ids: [...store()] });
/** для тестов: забыть коллекцию в памяти (localStorage перечитается) */
export function resetCollectionCache() {
  cache = null;
  lastRandom = '';
}

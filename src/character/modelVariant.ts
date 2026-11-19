/**
 * Поколение моделей котов. По умолчанию во всех редакциях — v1 (вид как на 841b373: модели bb768e9 и мех/тон/лицо тех
 * же значений). v2 — только ?models=v2: в lab и со страницы /test (PARAMS models → feature model.v2).
 *
 * ?models=v2 — у каждого кота своя основа, та, что ближе к рефам персонажа (design/cut/<кот>, docs/models/persona_*):
 *   • Блёстка — v2 (c686be3: форма головы по рефам, фатин, одежда отдельными мешами, коллайдеры модельщика);
 *   • Хулиган и Добряк — p1: геометрия v1 (голова и наушники ближе к рефам, чем у v2) + глаза по рефам
 *     (scripts/models/persona_tune.py: веко открыто, подводка) → models/v2/<кот>_p1.glb; прокси — как у v1 (геометрия та же): models/<кот>_v1_colliders.json.
 * ?models=v2h — геометрия v2 у всех трёх (для сравнения). Мех, тон и лицо при v2/v2h берут значения v2
 * (furShell, furTone, faceWrinkles, glbCharacter PERSONA_FACE).
 */
export type ModelsVariant = 'v1' | 'v2' | 'v2h';

/** основа кота при ?models=v2: v2 — геометрия v2, p1 — v1 с правками по рефам персонажа */
export const V2_BASE: Record<string, 'v2' | 'p1'> = { glitter: 'v2', hooligan: 'p1', kind: 'p1' };

/** ?models=v2 → 'v2', ?models=v2h → 'v2h', иначе 'v1' (адрес уже прошёл guardUrl: в MVP/пилоте без /test параметра нет) */
export function modelsVariant(search = typeof location !== 'undefined' ? location.search : ''): ModelsVariant {
  const m = new URLSearchParams(search).get('models');
  return m === 'v2' ? 'v2' : m === 'v2h' ? 'v2h' : 'v1';
}

export const modelsV2 = (search?: string) => modelsVariant(search) !== 'v1';

/** путь модели характера: models/kind_v1.glb → models/v2/kind_p1.glb (v2) | models/v2/kind_v2.glb (v2h) */
export function variantGlb(p: string, variant: ModelsVariant = modelsVariant()): string {
  if (variant === 'v1') return p;
  const m = p.match(/^(.*?)models\/(hooligan|kind|glitter)_v1\.glb$/);
  if (!m) return p;
  const base = variant === 'v2h' ? 'v2' : V2_BASE[m[2]] ?? 'v2';
  return `${m[1]}models/v2/${m[2]}_${base}.glb`;
}

/**
 * прокси столкновений к модели (docs/animations/COLLISION.md): геометрия v2 — от модельщика (models/v2/kind_v2.glb →
 * models/v2/kind_colliders.json); v1 и p1 (та же геометрия v1) — посчитаны тем же scripts/models/colliders.py по v1 GLB
 * (models/kind_v1.glb, models/v2/kind_p1.glb → models/kind_v1_colliders.json); чужая модель (?glb=…) — null
 */
export function collidersUrl(glb: string): string | null {
  const m = glb.match(/^(.*\/)?([a-z]+)_v2\.glb$/i);
  if (m && /(^|\/)v2\/$/.test(m[1] ?? '')) return `${m[1]}${m[2]}_colliders.json`;
  const m1 = glb.match(/^(.*\/)?(hooligan|kind|glitter)_v1\.glb$/);
  if (m1) return `${m1[1] ?? ''}${m1[2]}_v1_colliders.json`;
  const p1 = glb.match(/^(.*\/)?v2\/(hooligan|kind|glitter)_p1\.glb$/);
  return p1 ? `${p1[1] ?? ''}${p1[2]}_v1_colliders.json` : null;
}

/**
 * Поколение моделей котов. По умолчанию во всех редакциях — v1 (вид как на 841b373: модели bb768e9 и мех/тон/лицо тех
 * же значений). v2 (c686be3: форма головы по рефам, наушники, фатин, одежда отдельными мешами, без проникновений,
 * коллайдеры модельщика) — только ?models=v2: в lab и со страницы /test (PARAMS models → feature model.v2).
 *
 * Модели v2 лежат рядом: public/models/v2/<кот>_v2.glb + public/models/v2/<кот>_colliders.json (геометрия и прокси
 * связаны — у v1 файла коллайдеров нет, прокси строятся из меша в рантайме). Мех, тон и лицо выбирают свои значения
 * по тому же параметру (furShell, furTone, faceWrinkles, glbCharacter PERSONA_FACE).
 */
export type ModelsVariant = 'v1' | 'v2';

/** ?models=v2 → 'v2', иначе 'v1' (адрес уже прошёл guardUrl: в MVP/пилоте без /test параметра нет) */
export function modelsVariant(search = typeof location !== 'undefined' ? location.search : ''): ModelsVariant {
  return new URLSearchParams(search).get('models') === 'v2' ? 'v2' : 'v1';
}

export const modelsV2 = (search?: string) => modelsVariant(search) === 'v2';

/** путь модели характера в выбранном поколении: models/kind_v1.glb → models/v2/kind_v2.glb */
export function variantGlb(p: string, variant: ModelsVariant = modelsVariant()): string {
  if (variant !== 'v2') return p;
  const m = p.match(/^(.*?)models\/(hooligan|kind|glitter)_v1\.glb$/);
  return m ? `${m[1]}models/v2/${m[2]}_v2.glb` : p;
}

/** коллайдеры модельщика к модели: только у v2 (models/v2/kind_v2.glb → models/v2/kind_colliders.json); v1 — null */
export function collidersUrl(glb: string): string | null {
  const m = glb.match(/^(.*\/)?([a-z]+)_v2\.glb$/i);
  return m && /(^|\/)v2\/$/.test(m[1] ?? '') ? `${m[1]}${m[2]}_colliders.json` : null;
}

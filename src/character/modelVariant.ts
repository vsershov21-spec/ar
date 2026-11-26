/**
 * Поколение моделей котов. С 20.11 по умолчанию во всех редакциях (mvp, lab, пилот /mvp) — v2: основы по рефам персонажей
 * и мех/тон/лицо v2. Прежний вид (как на 841b373: модели bb768e9 и мех/тон/лицо тех же значений) — ?models=v1,
 * геометрия v2 для сравнения — ?models=v2h; оба — в lab и со страницы /test (PARAMS models → feature model.variants).
 *
 * v2 (по умолчанию; ?models=v2 — то же) — у каждого кота своя основа, та, что ближе к рефам персонажа (design/cut/<кот>, docs/models/persona_*):
 *   • Блёстка — p1 (20.11): геометрия v1 + короткая пачка из фатина с тонкой золотой кромкой, звёзды у висков,
 *     глаза с ресницами (tulle.py --puff 1.0 --bell 4 … → untangle → persona_tune.py --clean, docs/models/README.md)
 *     → models/v2/glitter_p1.glb, свои прокси;
 *   • Хулиган и Добряк — p1: геометрия v1 (голова и наушники ближе к рефам, чем у v2) + глаза по рефам
 *     (scripts/models/persona_tune.py: веко открыто, подводка) → models/v2/<кот>_p1.glb; прокси — как у v1 (геометрия та же): models/<кот>_v1_colliders.json.
 * ?models=v2h — геометрия v2 у всех трёх (для сравнения). Мех, тон и лицо при v2/v2h берут значения v2
 * (furShell, furTone, faceWrinkles, glbCharacter PERSONA_FACE).
 */
import { feature } from '../config/edition';

/**
 * p3 — Блёстка, пересозданная по развороту продакта 23.11 (Tripo multiview → scripts/models/glitter_p3.py: тот же
 * скелет p1, лицо-накладки p1, рот шейдером) → models/v2/glitter_p3.glb + glitter_p3_colliders.json. Остальные коты —
 * как v2. Включение: ?models=p3 (lab; MVP и пилот — только со страницы /test, ?from=test); по умолчанию — функция
 * model.glitterP3 (lab — вкл., MVP и пилот — выкл., решит продакт по листу docs/qa/glitter/glitter_p3_sheet.jpg);
 * ?models=v2 — явный p1 там, где p3 по умолчанию.
 */
/**
 * p4 — Блёстка из модели продакта Tripo (4 вида, по частям, Auto Rig Mixamo) тем же конвейером, что Хулиган и Добряк
 * (scripts/models/build_glitter_p4.sh: уши/хвост rig_cat, глаза и веки eyeRig, брови, MouthD — face_detail.py,
 * мех-оболочки, прокси) → models/v2/glitter_p4.glb (лицо шейдером, как p1 в пилоте; при faceMode 'morph' — тоже он:
 * риг лица p2 для этой сетки пока не собирается) + glitter_p4_colliders.json. Только ?models=p4 (lab; MVP и пилот — со страницы /test), по умолчанию нигде.
 */
/**
 * v5 — Блёстка продакта из Tripo «как есть» (одна цельная сетка, 4 вида, H3.1, текстура 4K, Auto Rig Mixamo;
 * scripts/models/build_glitter_v5.sh): вид Tripo 1:1 — лицо, текстура и форма не меняются (без FurTone, без
 * наших глаз/рта); добавлены только скелет как у Хулигана (концевые кости, уши, хвост), веки-«шторки» с ресницами
 * Tripo и морфы рта/бровей (character/v5Face.ts) → models/v2/glitter_v5.glb + glitter_v5_colliders.json.
 * Только ?models=v5 (lab; MVP и пилот — со страницы /test), по умолчанию нигде; лицо — свои морфы при любом faceMode.
 */
export type ModelsVariant = 'v1' | 'v2' | 'v2h' | 'p3' | 'p4' | 'v5';

/**
 * Лицо котов v2 (основа p1): 'morph' — риг лица p2 (scripts/models/face_rig.py: рот геометрией, полость, клычки,
 * язык, морфы визем и эмоций, драйвер faceMorphs.ts) → models/v2/<кот>_p2.glb; 'shader' — как было (p1, рот шейдером
 * mouthRig.ts). По умолчанию — функция face.morph (lab — вкл., MVP и пилот — выкл., пока продакт не посмотрит);
 * сравнение — ?face=morph | ?face=shader (lab; MVP и пилот — только со страницы /test, ?from=test).
 */
export type FaceMode = 'morph' | 'shader';
export function faceMode(search = typeof location !== 'undefined' ? location.search : '', on = feature('face.morph')): FaceMode {
  const f = new URLSearchParams(search).get('face');
  if (f === 'morph' || f === 'shader') return f;
  return on ? 'morph' : 'shader';
}

/** основа кота в v2 (по умолчанию): v2 — геометрия v2, p1 — v1 с правками по рефам персонажа */
export const V2_BASE: Record<string, 'v2' | 'p1'> = { glitter: 'p1', hooligan: 'p1', kind: 'p1' };

/**
 * p1 со своими прокси (геометрия отличается от v1): Блёстка — юбка Tripo заменена фатином (tulle.py)
 * и звёзды-заколки → models/v2/glitter_p1_colliders.json (scripts/models/colliders.py по p1)
 */
export const P1_OWN_COLLIDERS = new Set(['glitter', 'hooligan', 'kind']);

/**
 * ?models=v1 → 'v1', ?models=v2h → 'v2h', ?models=p3 → 'p3', ?models=p4 → 'p4', ?models=v5 → 'v5', ?models=v2 → 'v2'; без параметра — 'p3', если включена
 * функция model.glitterP3 (lab), иначе 'v2' (адрес уже прошёл guardUrl: в MVP/пилоте без /test параметра нет)
 */
export function modelsVariant(search = typeof location !== 'undefined' ? location.search : '', p3 = feature('model.glitterP3')): ModelsVariant {
  const m = new URLSearchParams(search).get('models');
  return m === 'v1' ? 'v1' : m === 'v2h' ? 'v2h' : m === 'p3' ? 'p3' : m === 'p4' ? 'p4' : m === 'v5' ? 'v5' : m === 'v2' ? 'v2' : p3 ? 'p3' : 'v2';
}

export const modelsV2 = (search?: string) => modelsVariant(search) !== 'v1';

/**
 * путь модели характера: models/kind_v1.glb → models/v2/kind_p1.glb (v2, лицо шейдером) | models/v2/kind_p2.glb
 * (v2, риг лица p2 — faceMode 'morph') | models/v2/kind_v2.glb (v2h)
 */
export function variantGlb(p: string, variant: ModelsVariant = modelsVariant(), face: FaceMode = faceMode()): string {
  if (variant === 'v1') return p;
  const m = p.match(/^(.*?)models\/(hooligan|kind|glitter)_v1\.glb$/);
  if (!m) return p;
  if (variant === 'p3' && m[2] === 'glitter') return `${m[1]}models/v2/glitter_p3.glb`;
  // p4: лицо шейдером при любом faceMode — риг лица p2 (p4m) у этой сетки пока не собирается (build_glitter_p4.sh)
  if (variant === 'p4' && m[2] === 'glitter') return `${m[1]}models/v2/glitter_p4.glb`;
  // v5: лицо Tripo со своими морфами (веки, рот) при любом faceMode
  if (variant === 'v5' && m[2] === 'glitter') return `${m[1]}models/v2/glitter_v5.glb`;
  let base: string = variant === 'v2h' ? 'v2' : V2_BASE[m[2]] ?? 'v2';
  if (base === 'p1' && face === 'morph') base = 'p2';
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
  const p3 = glb.match(/^(.*\/)?v2\/glitter_p3\.glb$/);
  if (p3) return `${p3[1] ?? ''}v2/glitter_p3_colliders.json`;
  // p4m (риг лица) — та же геометрия тела, что у p4
  const p4 = glb.match(/^(.*\/)?v2\/glitter_p4m?\.glb$/);
  if (p4) return `${p4[1] ?? ''}v2/glitter_p4_colliders.json`;
  const v5 = glb.match(/^(.*\/)?v2\/glitter_v5\.glb$/);
  if (v5) return `${v5[1] ?? ''}v2/glitter_v5_colliders.json`;
  // p2 (риг лица) — та же геометрия тела, что у p1: прокси те же
  const p1 = glb.match(/^(.*\/)?v2\/(hooligan|kind|glitter)_p[12]\.glb$/);
  if (!p1) return null;
  return P1_OWN_COLLIDERS.has(p1[2]) ? `${p1[1] ?? ''}v2/${p1[2]}_p1_colliders.json` : `${p1[1] ?? ''}${p1[2]}_v1_colliders.json`;
}

/**
 * Блёстка v5 (models/v2/glitter_v5.glb, scripts/models/build_glitter_v5.sh): лицо Tripo как есть — нарисованные глаза,
 * ресницы, нос и открытая улыбка; мимика — поверх, без замены лица:
 *  • веки — меш Lids_V5 (материал и текстура тела): в покое вырожден в линию у верхней дуги ресниц (не виден), при
 *    моргании «шторка» в мех над глазом опускается на нарисованный глаз, у её кромки — та же дуга ресниц Tripo.
 *    Путь закрытия — 4 ключа lid{L,R}_1..4 (каждый — шаг от предыдущего положения): веко идёт по куполу глаза, а не по
 *    хорде (хорда при одном ключе уходила в глаз на 4 мм). Косого века (злость/грусть) нет — одним ключом оно резало
 *    радужку; злость и грусть — брови, рот и общее прикрытие (lidPose: brow_down/brow_sad прикрывают веко);
 *  • рот, брови, щёки — ключи тела с именами весов лица (mouth_A/E/O/U/M, smile, smirk, frown, brow_*, cheek_up):
 *    их ведёт прежний цикл GlbCharacter по MORPH_TARGETS.
 * Здесь — только веки: веса лица → влияния ключей Lids_V5 (чистая функция, тесты tests/glitterV5.test.ts).
 */
import { lidPose } from './eyeRig';

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** число ключей пути закрытия века */
export const V5_LID_KEYS = 4;

/** веса лица → влияния ключей век Lids_V5 (имя ключа → вес) */
export function v5LidWeights(w: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const side of ['L', 'R'] as const) {
    const p = lidPose(w, side, 0);
    // нижнего века у v5 нет: прищур (нижнее веко у eyeRig без моргания и смеха) — немного верхним
    const lo = lidPose({ ...w, [`blink_${side}`]: 0, [`wink_${side}`]: 0, eyes_laugh: 0 }, side, 0).lo;
    const c = clamp(p.up + 0.3 * lo * (1 - p.up), 0, 1);
    for (let k = 1; k <= V5_LID_KEYS; k++) out[`lid${side}_${k}`] = clamp(V5_LID_KEYS * c - (k - 1), 0, 1);
  }
  return out;
}

/** меш век v5 и его ключи; null — у модели нет */
export interface V5Lids {
  mesh: { morphTargetDictionary?: Record<string, number>; morphTargetInfluences?: number[] };
}

export function applyV5Lids(lids: V5Lids, w: Record<string, number>) {
  const d = lids.mesh.morphTargetDictionary, inf = lids.mesh.morphTargetInfluences;
  if (!d || !inf) return;
  const lw = v5LidWeights(w);
  for (const k in lw) {
    const i = d[k];
    if (i !== undefined) inf[i] = lw[k];
  }
}

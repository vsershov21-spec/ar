/**
 * Пакеты движений (docs/qa/ui/quick/SPEED.md): библиотека anims_v1.glb при сборке делится на «стартовый» пакет — с ним
 * кот садится на карту — и «остальное», которое догружается в фоне после посадки (GlbCharacter.loadDeferred).
 * Делит scripts/build/vite-model-opt.mjs (scripts/build/anim-pack.mjs), рантайм берёт пути из __ANIM_PACKS__ (modelUrl.ts).
 *
 * START_IDS — id каталога (content/animations.json), которые нужны с первой секунды: покой, пробуждение
 * (src/awake/timeline.ts), знакомство (реплики сценария intro), касания по зонам и глажка, фирменный двойной тап.
 * Список — по стенду scripts/qa/anim-start-probe.mjs (что кот реально играет в первую минуту) и реакциям характеров.
 * startClipNames переводит их в имена клипов GLB по тем же правилам, что GlbCharacter (своё имя, псевдоним Tripo — первый
 * по порядку библиотеки, монтаж cut — его исходник, опора fallback) — так в стартовом пакете под каждым id играет тот же
 * клип, что и в полной библиотеке.
 *
 * Модуль без зависимостей рантайма (только tripoAlias.ts): его читает и сборка.
 */
import { TRIPO_ALIAS } from './tripoAlias';

export const START_IDS: readonly string[] = [
  // покой (calmIdles: без наушников, скейта, кружения…)
  'idle_breathe', 'idle_look_around', 'idle_yawn', 'idle_stretch', 'sit_idle',
  // пробуждение: полёт (jump / idle_yawn), посадка, «проснулся», привет; повторный визит — прыжок
  'jump', 'appear_jump_in', 'wake_startle', 'wave', 'celebrate',
  // знакомство и разговор: реплики сценария intro, ответы «да/нет/не понял»
  'talk_casual', 'talk_excited', 'listen', 'point_button', 'think', 'proud', 'laugh', 'surprised', 'flinch', 'offended', 'shy',
  // касания по зонам, глажка, стекло (тап мимо кота), выглядывание при потере карты
  'poke_head', 'poke_cheek', 'poke_belly', 'poke_paw', 'poke_tail', 'purr_stroke', 'press_glass', 'knock_glass', 'scratch_glass',
  'peek_from_edge', 'breath_draw', 'hug_screen', 'sticker_react',
  // фирменный двойной тап характеров
  'gum_blow', 'kind_bubbles', 'glitter_throw',
];

export interface PackClipDef {
  id: string;
  fallback?: string;
  cut?: { src?: string; keep?: [number, number][] };
}

/** имя клипа GLB → ключ (как GlbCharacter.addClip) */
export const clipKey = (name: string) => name.toLowerCase().replace(/^.*\|/, '');

/**
 * Имена клипов библиотеки (в её порядке), без которых START_IDS в стартовом пакете сыграли бы не то, что в полной.
 * libNames — имена клипов GLB по порядку; defs — каталог (content/animations.json clips: fallback, cut).
 */
export function startClipNames(libNames: readonly string[], defs: readonly PackClipDef[], ids: readonly string[] = START_IDS): string[] {
  // одинаковые имена в библиотеке бывают (склейка выгрузок Tripo): как в GlbCharacter, выигрывает последний
  const byKey = new Map<string, string>();
  for (const n of libNames) byKey.set(clipKey(n), n);
  const def = new Map(defs.map((d) => [d.id, d]));
  const need = new Set<string>();
  const seen = new Set<string>();
  const add = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    // своё имя
    const own = byKey.get(id);
    if (own) need.add(own);
    // псевдоним: первый клип библиотеки (по её порядку), у которого id в TRIPO_ALIAS
    if (!own) {
      const al = libNames.find((n) => (TRIPO_ALIAS[clipKey(n)] ?? []).includes(id));
      if (al) need.add(al);
    }
    const d = def.get(id);
    // монтаж: исходник (cut.src, иначе свой id, иначе первый пресет из TRIPO_ALIAS) — как GlbCharacter.cutClips
    if (d?.cut?.keep?.length) {
      const alias = Object.keys(TRIPO_ALIAS).find((k) => TRIPO_ALIAS[k].includes(id) && byKey.has(k));
      const src = byKey.get(d.cut.src ?? '') ?? byKey.get(id) ?? (alias ? byKey.get(alias) : undefined);
      if (src) need.add(src);
    }
    // опора: клипа нет — играет опора (её саму разрешаем так же)
    if (d?.fallback && !own) add(d.fallback);
  };
  for (const id of ids) add(id);
  return libNames.filter((n) => need.has(n));
}

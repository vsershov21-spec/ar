/**
 * Каталог клипов тела — content/animations.json (источник правды): длительность, петля, rootMotion,
 * слой body/additive, blendInMs. Плюс старые имена (до каталога) → новые id, и выбор idle по весам характера.
 * Неизвестный клип не роняет: предупреждение в лог (один раз) и idle.
 */
import anim from '../../content/animations.json';

export interface ClipDef {
  id: string;
  durationS: number;
  loop: boolean;
  rootMotion: boolean;
  layer: 'body' | 'additive' | 'face';
  blendInMs: number;
  persona: string;
  priority: string;
  usedBy: string[];
  notes: string;
  /**
   * Клипа ещё нет в библиотеке (anims_v1.glb) — что играть вместо него: существующий клип-опора, поверх него
   * сцена добавляет путь корня и мелкие поправки костей (кровать: src/home/bedFlow.ts). Настоящий клип с этим id
   * в GLB сам займёт место (своё имя важнее опоры).
   */
  fallback?: string;
  /**
   * Монтаж клипа из библиотеки (animPrep.spliceClip): src — имя клипа в GLB (по умолчанию свой id или пресет Tripo,
   * который сейчас играет под этим id), keep — куски [от, до] в секундах исходника, speed — темп поверх animPrep.
   * Так длинные T2M-клипы (тычки ≈ 5 с, скрещённые лапы 17 с) становятся реакциями на 1,5–3 с без новой генерации.
   * Настоящий клип нужной длины (Meshy) с этим id — cut снять.
   */
  cut?: { src?: string; keep: [number, number][]; speed?: number };
  /** переход в покой после конца клипа, мс (больше blendInMs покоя — мягче возврат) */
  blendOutMs?: number;
  /**
   * Клип Meshy (docs/animations/MESHY.md, scripts/models/t2m_prompts_v2.json specs[id].meshy): как играть, когда он
   * пришёл (meshyClips.ts → GlbCharacter.addExternalClip). Нет клипа — ничего из этого не действует, играет как раньше.
   */
  meshy?: MeshyRule;
}

export interface MeshyRule {
  /** петля (из спеки Meshy; главнее loop каталога и манифеста) */
  loop: boolean;
  blendInMs?: number;
  blendOutMs?: number;
  /**
   * Где этот клип заменяет текущий, когда пришёл настоящий: события реакций ('treat'), кнопки ('action:scratch'),
   * точки кода ('code:goodbye', 'code:stage.turn'). Для клипов, которые уже стоят на своём месте (poke_*, wave, кровать),
   * не нужно — их id и так играют.
   */
  on?: string[];
  /** заменяет только эти клипы реакции (иначе любой) */
  from?: string[];
  /** цепочка: после конца (петля — через holdS) играет этот клип, если он тоже настоящий */
  then?: string;
  holdS?: number;
}

const DEFS = new Map<string, ClipDef>();
for (const c of (anim as { clips: ClipDef[] }).clips) DEFS.set(c.id, c);

export const CLIP_IDS: readonly string[] = [...DEFS.keys()];
export const clipDef = (id: string): ClipDef | undefined => DEFS.get(id);
/** клипы каталога с опорой fallback (их ещё нет в библиотеке движений) */
export const FALLBACK_CLIPS: readonly ClipDef[] = [...DEFS.values()].filter((d) => !!d.fallback);
/** клипы каталога с монтажом cut (собираются из клипа библиотеки при загрузке GLB) */
export const CUT_CLIPS: readonly ClipDef[] = [...DEFS.values()].filter((d) => !!d.cut?.keep?.length);

/** клипы с правилами Meshy (ожидаемые id; совпадают со specs[*].meshy в t2m_prompts_v2.json — tests/meshyMap.test.ts) */
export const MESHY_IDS: readonly string[] = [...DEFS.values()].filter((d) => !!d.meshy).map((d) => d.id);

/**
 * Какой клип играть на событии/кнопке/точке кода: настоящий клип Meshy (есть у персонажа — real(id)) с правилом
 * meshy.on для этого места и характера — вместо clip; иначе clip как есть (опора, монтаж cut, псевдоним — всё как было).
 * where — 'treat' | 'action:scratch' | 'code:goodbye'; несколько мест — первое совпадение.
 */
export function meshyUpgrade(where: string | string[], clip: string | undefined, personaId: string, real: (id: string) => boolean): string | undefined {
  const keys = Array.isArray(where) ? where : [where];
  for (const d of DEFS.values()) {
    const r = d.meshy;
    if (!r?.on || (d.persona !== 'all' && d.persona !== personaId)) continue;
    if (!keys.some((k) => r.on!.includes(k))) continue;
    if (r.from && (!clip || !r.from.includes(LEGACY_CLIP[clip] ?? clip))) continue;
    if (!real(d.id)) continue;
    return d.id;
  }
  return clip;
}

/** цепочка клипа Meshy (sit_down → sit_idle → stand_up, fall_asleep → sleep_loop): следующий, только если он настоящий */
export function meshyChain(id: string, real: (id: string) => boolean): { then: string; holdS?: number } | null {
  const r = DEFS.get(id)?.meshy;
  if (!r?.then || !real(id) || !real(r.then)) return null;
  return { then: r.then, holdS: r.holdS };
}

/**
 * Определение клипа, когда играет клип Meshy: монтаж cut и опора fallback — для старого клипа, снимаются; петля и
 * переходы — из правила meshy; длительность — реальная (dur, после animPrep).
 */
export function meshyDef(def: ClipDef, dur?: number): ClipDef {
  const r = def.meshy;
  const out: ClipDef = { ...def, cut: undefined, fallback: undefined };
  if (r) {
    out.loop = r.loop;
    if (r.blendInMs !== undefined) out.blendInMs = r.blendInMs;
    if (r.blendOutMs !== undefined) out.blendOutMs = r.blendOutMs;
  }
  if (dur && dur > 0) out.durationS = dur;
  return out;
}

/** старые имена клипов (director, спрайт-манифест) → id каталога. 'idle' — особый: выбор по весам характера */
export const LEGACY_CLIP: Record<string, string> = {
  appear: 'appear_jump_in',
  talk: 'talk_casual',
  sticker: 'sticker_slap',
  scratch: 'scratch_glass',
  bubble_gum: 'gum_blow',
  glitter_burst: 'glitter_throw',
  heart_draw: 'breath_draw',
  sit: 'sit_down',
  run_home: 'run',
  bored: 'idle_yawn',
};

let warn: (m: string) => void = (m) => console.warn(m);
const warned = new Set<string>();
export function setClipLogger(fn: (m: string) => void) {
  warn = fn;
}

/**
 * Имя клипа (id каталога, старое имя, 'idle', 'dance') → определение. 'dance' → dance_<характер>.
 * null — неизвестно (предупреждение один раз).
 */
export function resolveClip(name: string, personaId = 'hooligan'): ClipDef | null {
  if (name === 'dance') name = DEFS.has(`dance_${personaId}`) ? `dance_${personaId}` : 'dance_hooligan';
  const id = LEGACY_CLIP[name] ?? name;
  const d = DEFS.get(id);
  if (!d && name !== 'idle' && name !== 'none') {
    if (!warned.has(name)) {
      warned.add(name);
      warn(`[clip] неизвестный клип «${name}» — заглушка idle (нет в content/animations.json)`);
    }
  }
  return d ?? null;
}

/** клип известен (каталог, старое имя, idle/dance) */
export const knownClip = (name: string) => name === 'idle' || name === 'dance' || DEFS.has(LEGACY_CLIP[name] ?? name);

/**
 * Выбор idle по весам из meta.idles: случайная смена каждые 4–9 с (петли) или по окончании клипа,
 * один и тот же клип не два раза подряд (если есть из чего выбрать).
 */
export class IdlePicker {
  constructor(public idles: { clip: string; weight: number }[], private rnd: () => number = Math.random) {}

  next(prev?: string): string {
    const list = this.idles.filter((i) => DEFS.has(i.clip) && i.weight > 0);
    if (!list.length) return 'idle_breathe';
    const pool = list.length > 1 && prev ? list.filter((i) => i.clip !== prev) : list;
    const total = pool.reduce((s, i) => s + i.weight, 0);
    let r = this.rnd() * total;
    for (const i of pool) {
      r -= i.weight;
      if (r < 0) return i.clip;
    }
    return pool[pool.length - 1].clip;
  }

  /** сколько держать петлевой idle, с (4–9) */
  holdS(): number {
    return 4 + this.rnd() * 5;
  }
}

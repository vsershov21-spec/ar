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
}

const DEFS = new Map<string, ClipDef>();
for (const c of (anim as { clips: ClipDef[] }).clips) DEFS.set(c.id, c);

export const CLIP_IDS: readonly string[] = [...DEFS.keys()];
export const clipDef = (id: string): ClipDef | undefined => DEFS.get(id);

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

/**
 * Контент (content/animations.json, fx.json, sounds.json) описывает финальный набор: 71 клип, 31 эффект, 43 звука.
 * Прототип пока умеет меньше. Здесь — сведение контентного id к тому, что есть в рантайме.
 * Как только модуль персонажа/эффектов/звука научится новому id, он начинает играть напрямую
 * (проверка isClip / audio.has / fx.play), таблица — только запасной вариант.
 */
import { isClip, type ClipName } from '../character/types';
import type { FxName } from './types';

const CLIP: Record<string, ClipName> = {
  appear_jump_in: 'appear', dive_out: 'run_home', fall_off_card: 'tumble', peek_from_edge: 'listen',
  dizzy: 'tumble', sit_down: 'sit', sit_idle: 'sit', stand_up: 'idle', sleep_loop: 'bored', wake_startle: 'jump',
  point_button: 'wave', talk_casual: 'talk', talk_excited: 'talk', think: 'listen', shy: 'bored', surprised: 'jump',
  offended: 'bored', proud: 'wave', comfort: 'listen', cover_ears: 'bored', lean_in: 'press_glass', celebrate: 'dance',
  sing: 'dance', scratch_glass: 'scratch', slide_down_glass: 'press_glass', breath_draw: 'heart_draw', hug_screen: 'press_glass',
  sticker_slap: 'sticker', sticker_react: 'laugh', gum_blow: 'bubble_gum', kind_bubbles: 'wave', glitter_throw: 'glitter_burst',
  snowglobe_shake: 'glitter_burst', purr_stroke: 'laugh', poke_head: 'laugh', poke_cheek: 'laugh', poke_belly: 'laugh',
  poke_paw: 'wave', poke_tail: 'jump', flinch: 'bored', dance_hooligan: 'dance', dance_kind: 'dance', dance_glitter: 'dance',
  echo_speak: 'talk', idle_yawn: 'bored',
};

export function runtimeClip(id: string | undefined): ClipName | null {
  if (!id || id === 'none') return null;
  if (isClip(id)) return id;
  if (CLIP[id]) return CLIP[id];
  if (id.startsWith('idle_')) return 'idle';
  return null; // аддитивные (уши, хвост) — пока без клипа
}

const FX: Record<string, FxName> = {
  knock: 'knock', claws: 'claws', gum_bubble: 'gum_bubble', glitch: 'glitch', skate_sparks: 'glitter_burst', tag_spray: 'sticker',
  steam: 'steam_heart', steam_draw: 'steam_heart', steam_heart: 'steam_heart', soap_bubbles: 'glitter_burst', warm_lights: 'glitter_burst',
  hearts_float: 'glitter_burst', paw_print: 'knock', glitter_burst: 'glitter_burst', glitter_trail: 'glitter_trail', snow_globe: 'snow_globe',
  holo_shine: 'sticker', kiss_print: 'steam_heart', glass_cat: 'glass_cat', sticker: 'sticker', confetti: 'glitter_burst',
};

/** null — эффект делает другой код (наклейки сценария, UI-подсветка) или его пока нет */
export const runtimeFx = (id: string | undefined): FxName | null => (id && FX[id]) || null;

const SOUND: Record<string, string> = {
  claws_glass: 'claws', sparkle_burst: 'glitter', sparkle_swipe: 'sparkle_trail', snowglobe: 'glitter', shimmer: 'glitter',
  whoosh_big: 'whoosh', boing: 'pop_appear', giggle: 'bleep', chime_soft: 'chime', breath: 'steam', bubbles: 'bleep',
  pop_soft: 'gum_pop', bubble_pop_small: 'gum_pop', dizzy: 'shake', gasp: 'bleep', hmph: 'bleep', meow_short: 'bleep',
  listen_on: 'chime', listen_off: 'bleep', kiss: 'bleep', confetti: 'pop_appear', land_soft: 'pop_appear', paw_glass: 'glass_knock',
  finger_squeak: 'glass_squeak', skate_grind: 'whoosh', spray: 'steam', ui_tap: 'bleep',
};

/** has — проверка, что звук есть в аудиоспрайте */
export function runtimeSound(id: string | undefined, has: (s: string) => boolean): string | null {
  if (!id || id === 'none') return null;
  if (has(id)) return id;
  const m = SOUND[id];
  return m && has(m) ? m : null;
}

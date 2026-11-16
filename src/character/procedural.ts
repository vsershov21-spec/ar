/**
 * Процедурные костные анимации для GLB-заглушки (у модели нет клипов).
 * Каждая функция возвращает смещения поворотов костей (эйлеры, рад, в локальных осях кости)
 * и смещение корня. Кости — имена Mixamo без префикса.
 * Когда придёт модель с настоящими клипами (docs/CHARACTER_SPEC.md), GlbCharacter
 * автоматически переключится на AnimationMixer, а этот файл останется как fallback.
 */

export type BoneOffsets = Record<string, [number, number, number]>;
export interface ProcPose { bones: BoneOffsets; root: { x?: number; y?: number; z?: number; rx?: number; ry?: number; rz?: number; s?: number } }

const S = Math.sin;
const tri = (k: number) => S(Math.min(1, Math.max(0, k)) * Math.PI);

/** k — нормированное время клипа 0..1 (для петель — фаза), t — секунды с начала клипа. */
const BASE: Record<string, (k: number, t: number) => ProcPose> = {
  idle: (_k, t) => ({
    bones: {
      Spine1: [0.03 * S(t * 1.8), 0, 0.025 * S(t * 0.9)],
      Head: [0.04 * S(t * 1.6), 0.12 * S(t * 0.7), 0.03 * S(t * 0.5)],
      LeftArm: [0, 0, 0.06 * S(t * 2.2)],
      RightArm: [0, 0, -0.06 * S(t * 2.2 + 1)],
    },
    root: { y: 0.004 * S(t * 3.6) },
  }),
  appear: (k) => ({
    bones: { LeftArm: [0, 0, -0.9 * tri(k * 1.3)], RightArm: [0, 0, 0.9 * tri(k * 1.3)], Spine1: [-0.15 * tri(k), 0, 0] },
    root: { y: 0.35 * tri(Math.min(1, k * 1.4)), s: Math.min(1, 0.2 + k * 2.2), ry: (1 - Math.min(1, k * 1.5)) * Math.PI * 2 },
  }),
  knock_glass: (k, t) => ({
    bones: { RightArm: [-1.1 * tri(k), 0, 0.6 * tri(k)], RightForeArm: [0, 0, 0.5 * S(t * 18) * tri(k)], Spine1: [0.15 * tri(k), 0, 0] },
    root: { z: 0.1 * tri(k) },
  }),
  press_glass: (k) => ({
    bones: { Spine1: [0.3 * tri(k), 0, 0], Head: [0.1 * tri(k), 0, 0.3 * tri(k)], LeftArm: [-1.2 * tri(k), 0, 0], RightArm: [-1.2 * tri(k), 0, 0] },
    root: { z: 0.2 * tri(k) },
  }),
  scratch: (k, t) => ({
    bones: { RightArm: [-1.3 * tri(k), 0, 0.4 * S(t * 14)], LeftArm: [-1.3 * tri(k), 0, -0.4 * S(t * 14 + 1)], Spine1: [0.2 * tri(k), 0, 0] },
    root: { z: 0.08 * tri(k) },
  }),
  tumble: (k) => ({
    bones: { Spine1: [0.4 * tri(k), 0, 0], LeftUpLeg: [-0.8 * tri(k), 0, 0], RightUpLeg: [-0.8 * tri(k), 0, 0] },
    root: { y: 0.4 * tri(k), rx: -k * Math.PI * 2 },
  }),
  sticker: (k) => ({
    bones: { RightArm: [-1.4 * tri(k), 0, 0.2], RightForeArm: [0, 0, -0.3 * tri(k)], Spine1: [0.12 * tri(k), 0, 0] },
    root: { z: 0.12 * tri(k) },
  }),
  talk: (_k, t) => ({
    bones: { Head: [0.06 * S(t * 7), 0.05 * S(t * 2), 0], RightArm: [-0.25 - 0.15 * S(t * 3), 0, 0.2], RightForeArm: [0, 0, 0.3 * S(t * 3)] },
    root: {},
  }),
  listen: (_k, t) => ({ bones: { Head: [0.05, 0, 0.25 + 0.03 * S(t * 1.3)], Spine1: [0.05, 0, 0.05] }, root: {} }),
  laugh: (k, t) => ({
    bones: { Spine1: [-0.15 * tri(k) + 0.08 * S(t * 25) * tri(k), 0, 0], Head: [-0.25 * tri(k), 0, 0], LeftArm: [-0.4 * tri(k), 0, 0], RightArm: [-0.4 * tri(k), 0, 0] },
    root: { y: 0.02 * Math.abs(S(t * 25)) * tri(k) },
  }),
  bored: (k, t) => ({
    bones: { Spine1: [0.25 * tri(k), 0, 0], Head: [0.3 * tri(k), 0.2 * S(t), 0], LeftArm: [0, 0, 0.15 * tri(k)], RightArm: [0, 0, -0.15 * tri(k)] },
    root: { y: -0.03 * tri(k) },
  }),
  run_home: (k, t) => ({
    bones: { LeftUpLeg: [0.8 * S(t * 16), 0, 0], RightUpLeg: [-0.8 * S(t * 16), 0, 0], LeftArm: [-0.6 * S(t * 16), 0, 0], RightArm: [0.6 * S(t * 16), 0, 0] },
    root: { ry: Math.PI * Math.min(1, k * 3), z: -1.2 * k, s: 1 - 0.7 * k },
  }),
  dance: (k, t) => ({
    bones: { Hips: [0, 0, 0.12 * S(t * 8)], Spine1: [0, 0.2 * S(t * 4), -0.15 * S(t * 8)], LeftArm: [-0.8 + 0.4 * S(t * 8), 0, 0], RightArm: [-0.8 - 0.4 * S(t * 8), 0, 0], Head: [0, 0, 0.2 * S(t * 8)] },
    root: { y: 0.03 * Math.abs(S(t * 8)) * tri(k) },
  }),
  bubble_gum: (k, t) => ({
    bones: { Head: [-0.35 * tri(k), 0, 0.05 * S(t * 3)], Spine1: [-0.12 * tri(k), 0, 0], RightArm: [0, 0, -0.2 * tri(k)], LeftArm: [0, 0, 0.2 * tri(k)] },
    root: {},
  }),
  glitter_burst: (k) => ({
    bones: { LeftArm: [0, 0, -1.6 * tri(k)], RightArm: [0, 0, 1.6 * tri(k)], Head: [-0.3 * tri(k), 0, 0] },
    root: { y: 0.25 * tri(k) },
  }),
  heart_draw: (k) => ({
    bones: {
      RightArm: [-1.3 + 0.35 * Math.cos(k * Math.PI * 2), 0, 0.35 * S(k * Math.PI * 2)],
      RightForeArm: [0, 0, -0.3],
      Spine1: [0.12, 0, 0],
    },
    root: { z: 0.15 * tri(k) },
  }),
};

/**
 * Клипы каталога (content/animations.json) → ближайшая процедурная поза GLB-заглушки.
 * Финальная модель приносит свои клипы с теми же id — тогда играет AnimationMixer, это не используется.
 */
export const NEAREST: Record<string, string> = {
  idle_breathe: 'idle', idle_look_around: 'idle', idle_stretch: 'glitter_burst', idle_yawn: 'bored', idle_tail_play: 'dance',
  idle_hooligan_skate: 'dance', idle_hooligan_headphones: 'talk', idle_kind_hug_self: 'bored', idle_kind_cocoa: 'bubble_gum',
  idle_glitter_mirror: 'listen', idle_glitter_twirl: 'dance', appear_jump_in: 'appear', dive_out: 'run_home', fall_off_card: 'tumble',
  peek_from_edge: 'listen', walk: 'run_home', run: 'run_home', turn_left: 'idle', turn_right: 'idle', jump: 'glitter_burst', flip: 'tumble',
  dizzy: 'dance', sit_down: 'bored', sit_idle: 'bored', stand_up: 'idle', sleep_loop: 'bored', wake_startle: 'glitter_burst',
  wave: 'knock_glass', point_button: 'knock_glass', talk_casual: 'talk', talk_excited: 'talk', think: 'listen', shy: 'bored',
  surprised: 'glitter_burst', offended: 'bored', proud: 'glitter_burst', comfort: 'press_glass', cover_ears: 'glitter_burst',
  lean_in: 'press_glass', celebrate: 'glitter_burst', sing: 'talk', scratch_glass: 'scratch', slide_down_glass: 'press_glass',
  breath_draw: 'heart_draw', hug_screen: 'press_glass', sticker_slap: 'sticker', sticker_react: 'listen', gum_blow: 'bubble_gum',
  kind_bubbles: 'bubble_gum', glitter_throw: 'glitter_burst', snowglobe_shake: 'dance', purr_stroke: 'listen', poke_head: 'laugh',
  poke_cheek: 'laugh', poke_belly: 'laugh', poke_paw: 'knock_glass', poke_tail: 'glitter_burst', flinch: 'tumble',
  dance_hooligan: 'dance', dance_kind: 'dance', dance_glitter: 'dance', echo_speak: 'talk',
};

export function procFor(id: string): (k: number, t: number) => ProcPose {
  return BASE[id] ?? BASE[NEAREST[id] ?? ''] ?? BASE.idle!;
}

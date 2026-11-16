import type * as THREE from 'three';
import type { Persona } from '../persona/types';
import type { MouthShape, Viseme } from '../lipsync/visemes';

/** Клипы из спецификации (docs/CHARACTER_SPEC.md). Длительность в секундах. */
export const CLIPS = {
  // rootMotion: true — клип сам смещает корень (Root), false — на месте (смещение делает Stage/локомоция)
  idle: { dur: 4, loop: true, rootMotion: false },
  walk: { dur: 1.0, loop: true, rootMotion: false },
  run: { dur: 0.6, loop: true, rootMotion: false },
  jump: { dur: 1.0, loop: false, rootMotion: true },
  flip: { dur: 1.2, loop: false, rootMotion: true },
  tumble: { dur: 1.2, loop: false, rootMotion: true },
  turn_left: { dur: 0.6, loop: false, rootMotion: true },
  turn_right: { dur: 0.6, loop: false, rootMotion: true },
  sit: { dur: 3, loop: false, rootMotion: false },
  wave: { dur: 1.6, loop: false, rootMotion: false },
  appear: { dur: 2, loop: false, rootMotion: true },
  knock_glass: { dur: 1.2, loop: false, rootMotion: false },
  press_glass: { dur: 2.5, loop: false, rootMotion: false },
  scratch: { dur: 1.0, loop: false, rootMotion: false },
  sticker: { dur: 1.0, loop: false, rootMotion: false },
  talk: { dur: 2, loop: true, rootMotion: false },
  listen: { dur: 3, loop: true, rootMotion: false },
  laugh: { dur: 1.6, loop: false, rootMotion: false },
  bored: { dur: 3, loop: false, rootMotion: false },
  run_home: { dur: 1.5, loop: false, rootMotion: true },
  dance: { dur: 3, loop: false, rootMotion: false },
  bubble_gum: { dur: 3.2, loop: false, rootMotion: false },
  glitter_burst: { dur: 1.4, loop: false, rootMotion: false },
  heart_draw: { dur: 2.6, loop: false, rootMotion: false },
} as const;
export type ClipName = keyof typeof CLIPS;
export const isClip = (s: string): s is ClipName => s in CLIPS;

export type Emote = 'neutral' | 'happy' | 'angry' | 'wink' | 'blink' | 'smirk';

export interface PlayOptions {
  loop?: boolean;
  onEnd?: () => void;
}

/**
 * Единый API персонажа для 3D (GLB) и спрайт/видео-режима.
 * object — корень: ноги в (0,0,0), рост = 1, лицом в +Z, вверх +Y. Масштаб/поза задаёт Stage.
 */
export interface Character {
  readonly kind: 'glb' | 'sprite' | 'rig';
  readonly object: THREE.Object3D;
  load(): Promise<void>;
  setPersona(p: Persona): void;
  play(clip: ClipName, opts?: PlayOptions): void;
  readonly currentClip: ClipName;
  /** повернуть голову/взгляд на точку в мировых координатах (null — вперёд) */
  lookAt(world: THREE.Vector3 | null): void;
  emote(e: Emote, ms?: number): void;
  /**
   * Липсинк: доминирующая визема (Rhubarb A–H, X), её вес 0..1 и сглаженные параметры рта.
   * 3D — блендшейпы mouth_A/E/O/U/M (или челюсть), спрайт — PNG-оверлей рта.
   */
  setMouth(viseme: Viseme, weight: number, shape: MouthShape): void;
  update(dt: number, camera: THREE.Camera): void;
  /** попадание луча в кота */
  hitTest(ray: THREE.Raycaster): boolean;
  /** URL картинки текущей позы (для эффекта «кот у стекла»), если есть */
  posterImage(): HTMLImageElement | null;
  dispose(): void;
}

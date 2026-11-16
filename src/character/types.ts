import type * as THREE from 'three';
import type { Persona } from '../persona/types';
import type { MouthShape, Viseme } from '../lipsync/visemes';
import type { AnchorName } from '../fx/core';
import { knownClip, resolveClip, clipDef } from './clips';

/**
 * Имя клипа: id из content/animations.json (71 шт.), 'idle' (выбор по весам характера),
 * 'dance' (танец характера) или старое имя (appear, talk, sticker…, см. LEGACY_CLIP).
 */
export type ClipName = string;

/** клип известен каталогу (или это idle/dance/старое имя) */
export const isClip = (s: string): boolean => knownClip(s);

/**
 * Совместимость: длительность/петля по имени клипа (старый объект CLIPS[name]).
 * Источник — content/animations.json.
 */
export const CLIPS: Record<string, { dur: number; loop: boolean; rootMotion: boolean }> = new Proxy({} as Record<string, { dur: number; loop: boolean; rootMotion: boolean }>, {
  get: (_t, name: string) => {
    const d = name === 'idle' ? clipDef('idle_breathe') : resolveClip(name);
    return { dur: d?.durationS ?? 2, loop: d?.loop ?? name === 'idle', rootMotion: d?.rootMotion ?? false };
  },
  has: (_t, name: string) => knownClip(name),
  ownKeys: () => [],
});

export type Emote = 'neutral' | 'happy' | 'angry' | 'wink' | 'blink' | 'smirk';

export interface PlayOptions {
  loop?: boolean;
  onEnd?: () => void;
}

/**
 * Единый API персонажа для 3D (GLB), риг-заглушки и спрайт/видео-режима.
 * object — корень: ноги в (0,0,0), рост = 1, лицом в +Z, вверх +Y. Масштаб/поза задаёт Stage.
 */
export interface Character {
  readonly kind: 'glb' | 'sprite' | 'rig';
  readonly object: THREE.Object3D;
  load(): Promise<void>;
  /** характер: скин (меши GLB show/hide, палитра заглушки), idle с весами — из content/src/<id>.meta.json */
  setPersona(p: Persona): void;
  /** клип тела (с переходом blendInMs) или additive (уши/хвост) поверх текущего */
  play(clip: ClipName, opts?: PlayOptions): void;
  /** текущий клип тела (id каталога) */
  readonly currentClip: ClipName;
  /** пресет лица из content/face.json; ms > 0 — на время */
  face(preset: string, ms?: number): void;
  /** повернуть голову/взгляд на точку в мировых координатах (null — к камере) */
  lookAt(world: THREE.Vector3 | null): void;
  /** старые эмоции → пресеты лица; 'blink' — моргнуть */
  emote(e: Emote, ms?: number): void;
  /**
   * Липсинк: доминирующая визема (Rhubarb A–H, X), её вес 0..1 и сглаженные параметры рта.
   * 3D — блендшейпы mouth_A/E/O/U/M (или челюсть), спрайт — PNG-оверлей рта.
   */
  setMouth(viseme: Viseme, weight: number, shape: MouthShape): void;
  update(dt: number, camera: THREE.Camera): void;
  /** попадание луча в кота */
  hitTest(ray: THREE.Raycaster): boolean;
  /** зона касания: head | cheek | belly | paw | tail | body; null — мимо */
  hitZone?(ray: THREE.Raycaster): TouchZone | null;
  /** точка части кота в локальных координатах object (ноги в 0, рост 1) — для эффектов; null — по умолчанию */
  anchorLocal?(name: AnchorName): THREE.Vector3 | null;
  /** картинка текущей позы (для эффекта «кот у стекла»), если есть */
  posterImage(): HTMLImageElement | null;
  dispose(): void;
}

export type TouchZone = 'head' | 'cheek' | 'belly' | 'paw' | 'tail' | 'body';

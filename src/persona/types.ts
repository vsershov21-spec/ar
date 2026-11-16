/**
 * Характер (persona) в формате content/personas/<id>.json — его собирает content/build.py
 * из content/src/<id>.meta.json + <id>.lines.txt. Правится без кода.
 */
export type PersonaId = 'hooligan' | 'kind' | 'glitter';
/** порядок важен: смена встряской идёт по кругу hooligan → kind → glitter → hooligan */
export const PERSONA_IDS: readonly PersonaId[] = ['hooligan', 'kind', 'glitter'];
export const isPersonaId = (s: unknown): s is PersonaId => typeof s === 'string' && (PERSONA_IDS as readonly string[]).includes(s);

export type Emotion =
  | 'neutral' | 'happy' | 'cheeky' | 'surprised' | 'annoyed' | 'shy' | 'proud'
  | 'sad' | 'excited' | 'caring' | 'sleepy' | 'whisper' | 'offended';

/** Одна реплика: id вида «kind.intro.02» — по нему ищется запись голоса и проигрывается в debug. */
export interface ContentLine {
  id: string;
  text: string;
  emotion: Emotion;
  /** пресет лица из content/face.json (если в строке не задан — из emotionToFace) */
  face: string;
  clip?: string;
  fx?: string;
  sound?: string;
}

/** Значения по умолчанию для события («## событие | clip=… fx=… sound=…»). */
export interface ReactionDefaults {
  clip?: string;
  fx?: string;
  sound?: string;
  face?: string;
}

export interface PersonaVoice {
  piperVoice: string;
  pitchSemitones: number;
  rate: number;
  echoPitchSemitones: number;
  echoRate: number;
  elevenVoiceDesign?: string;
  actorDirection?: string;
}

/** Рантайм-эффекты, которые сейчас умеет FxLayer (контентные id эффектов сводятся к ним, см. runtimeMap.ts). */
export type FxName =
  | 'glitter_burst' | 'glitter_trail' | 'snow_globe'
  | 'gum_bubble' | 'claws' | 'glitch' | 'steam_heart'
  | 'glass_cat' | 'sticker' | 'knock' | 'none';

export type StickerKind = 'tag' | 'bolt' | 'text' | 'heart' | 'star' | 'holo' | 'skull_free_smile' | 'image';
export interface StickerSpec {
  kind: StickerKind;
  text?: string;
  /** для kind=image — путь к PNG (public/...) */
  src?: string;
  color?: string;
}

export interface Palette { primary: string; secondary: string; accent: string; fx: string[] }

export interface Riddle {
  id: string;
  /** текст загадки (кот произносит) */
  q: string;
  /** правильный ответ — кот называет его, если не угадали */
  answer: string;
  /** ключевые слова (основы): ответ ребёнка засчитывается, если содержит любое */
  keywords: string[];
  /** подсказка после первой неверной попытки */
  hint: string;
}

export interface Persona {
  id: PersonaId;
  name: string;
  /** подпись на стикере выбора */
  title: string;
  /** род, в котором характер говорит о себе */
  selfGender: 'm' | 'f';
  summary: string;
  speechRules: string[];
  voice: PersonaVoice;
  palette: Palette;
  outfit: { meshes: string[]; description: string; props: string[] };
  /** idle-набор с весами (случайный выбор пропорционально weight) */
  idles: { clip: string; weight: number }[];
  /** фирменный трюк */
  signature: { event: string; clip: string; fx: string[]; sound: string };
  /** настройки эффектов под характер: fxId → параметры */
  fxTuning: Record<string, Record<string, number>>;
  /** фоновый звук комнаты */
  ambience: string;
  stickers: StickerSpec[];
  /** 3D-режим: какие меши GLB показать/скрыть (подстроки имён), тон одежды */
  glb?: { show?: string[]; hide?: string[]; tint?: Record<string, string> };
  reactions: Record<string, ReactionDefaults>;
  /** реплики по событиям content/events.json — только этого характера */
  lines: Record<string, ContentLine[]>;
  /** загадки характера (из content/dialogs.json) */
  riddles: Riddle[];
  contentVersion: number;
}

/** Каталог событий content/events.json */
export interface EventDef {
  id: string;
  group: 'scenario' | 'input' | 'voice' | 'context' | 'dialog';
  /** 0 фон, 1 реакция, 2 сценарий, 3 безопасность/важное */
  priority: 0 | 1 | 2 | 3;
  cooldownMs: number;
  interruptible: boolean;
  trigger: string;
}

export interface FacePreset { id: string; weights: Record<string, number>; ears: number; pupils: number }

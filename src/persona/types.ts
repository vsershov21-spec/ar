/** Описание характера (persona). Хранится в public/personas/<id>.json — правится без кода. */
export type PersonaId = 'hooligan' | 'glitter' | (string & {});

/** Реплика: текст (субтитр + синтез речи) и опционально записанный файл. */
export interface Line {
  text: string;
  /** путь к записанной реплике (public/voice/...), если есть — играет файл с липсинком по амплитуде */
  audio?: string;
  /** клип, который играть во время реплики */
  clip?: string;
}
export type LineSpec = string | Line;

export type FxName =
  | 'glitter_burst' | 'glitter_trail' | 'snow_globe'
  | 'gum_bubble' | 'claws' | 'glitch' | 'steam_heart'
  | 'glass_cat' | 'sticker' | 'knock' | 'none';

/** Реакция на событие: что сказать, какой звук, эффект, клип. */
export interface Reaction {
  lines?: LineSpec[];
  sound?: string | string[];
  fx?: FxName | FxName[];
  clip?: string;
  /** спрятать кота на N мс (встряска у Хулигана) */
  hideMs?: number;
}

export type StickerKind = 'tag' | 'bolt' | 'text' | 'heart' | 'star' | 'holo' | 'skull_free_smile' | 'image';
export interface StickerSpec {
  kind: StickerKind;
  text?: string;
  /** для kind=image — путь к PNG (public/...) */
  src?: string;
  color?: string;
}

export interface Persona {
  id: PersonaId;
  name: string;
  /** подпись на стикере выбора */
  title: string;
  palette: { primary: string; secondary: string; accent: string; fx: string[] };
  voice: { pitch: number; rate: number };
  /** ключ — событие сценария/ввода; значение — реакция */
  reactions: Record<string, Reaction>;
  /** реплики по ключам сценария (intro, ask_name, lost, outro, ...) */
  lines: Record<string, LineSpec[]>;
  stickers: StickerSpec[];
  /** фирменный трюк */
  signature: Reaction;
  /** 3D-режим: какие меши GLB показать/скрыть (подстроки имён), тон одежды */
  glb?: { show?: string[]; hide?: string[]; tint?: Record<string, string> };
}

export const normLine = (l: LineSpec): Line => (typeof l === 'string' ? { text: l } : l);

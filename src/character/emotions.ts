/**
 * Эмоции кота поверх пресета реплики: событие сценария → [пресет content/face.json, сила 0..1, длительность мс (0 — до
 * следующей эмоции)]. Пресет реплики остаётся базой, эмоция плавно перекрывает его и уходит (Character.setEmotion).
 * Так мимика видна при тапе, находке карты, встряске, поглаживании и долгой тишине, даже если у реплики лицо «neutral».
 */
export type EmotionCue = [preset: string, weight: number, ms: number];

export const EVENT_EMOTION: Record<string, EmotionCue> = {
  // касания
  tap_cat: ['laugh', 1, 1600],
  tap_cat_belly: ['laugh', 1, 1800],
  tap_cat_head: ['happy', 1, 1500],
  tap_cat_paw: ['surprised', 0.8, 900],
  tap_cat_tail: ['surprised', 1, 1100],
  poke_combo: ['pout', 1, 2200],
  poke_hard: ['pout', 1, 2600],
  stroke: ['shy', 1, 2600],
  // «Обнять» (долгая глажка / кнопка): тёплое лицо, глаза прищурены
  stroke_long: ['purr', 1, 3000],
  double_tap: ['wink_l', 1, 1300],
  // угощение: радость, рот «жуёт» (mouth_* — FaceLife не трогает, эмоция happy с открытым ртом)
  treat: ['excited', 1, 2200],
  // фирменные действия пилота: скейт, какао, зеркальце, пузыри/блёстки (gum), «к стеклу» (longpress)
  skate: ['excited', 1, 2500],
  cocoa: ['caring', 1, 3000],
  mirror: ['proud', 1, 2600],
  gum: ['cheeks_gum', 1, 2000],
  longpress: ['squished', 1, 2200],
  // стекло пальцем: царапины — кот удивлён и смеётся, стук — прислушивается
  swipe: ['surprised', 0.9, 1100],
  tap_screen: ['listen', 0.8, 900],
  // камера и карта
  card_found: ['surprised', 1, 1300],
  card_lost: ['sad', 0.8, 2000],
  shake: ['dizzy', 1, 3500],
  // тишина и сон
  silence: ['sleepy', 1, 4500],
  bored: ['sleepy', 0.8, 3000],
  sleep: ['sleep', 1, 0],
  wake_up: ['surprised', 1, 1200],
  // разговор
  compliment: ['shy', 1, 2600],
  thanks: ['happy', 1, 1500],
  rude: ['pout', 1, 2600],
  sad: ['sad', 0.85, 2600],
  scared: ['sad', 0.6, 2000],
  joke: ['laugh', 1, 1700],
  riddle_right: ['laugh', 0.9, 1500],
  flip: ['happy', 1, 1500],
  jump: ['happy', 1, 1300],
  dance: ['happy', 1, 1800],
  sticker_peel: ['surprised', 0.8, 900],
  // смена кота: «Другого?» — удивлён, «Тряси!» — азарт, новый кот — радость
  switch_ask: ['surprised', 0.9, 1600],
  switch_start: ['excited', 1, 1500],
  shake_prompt: ['excited', 0.8, 1500],
  hello_new: ['happy', 1, 1800],
  // загадка / повторялка: думает, слушает
  riddle: ['think', 1, 2000],
  echo_start: ['listen', 1, 1800],
  no_name: ['wink_r', 1, 1200],
};

/** характер подменяет эмоцию события: Хулиган на тап ухмыляется, Блёстка подмигивает на двойной тап */
export const PERSONA_EMOTION: Record<string, Partial<Record<string, EmotionCue>>> = {
  hooligan: { tap_cat_head: ['smug', 1, 1500], double_tap: ['smug', 1, 1500], thanks: ['smug', 0.9, 1400], skate: ['smug', 1, 2500], longpress: ['cheeky', 1, 2200], stroke_long: ['shy', 1, 2600] },
  kind: { stroke_long: ['caring', 1, 3200], treat: ['smile_big', 1, 2400], gum: ['happy', 1, 2200] },
  glitter: { tap_cat_head: ['wink_r', 1, 1200], double_tap: ['wink_r', 1, 1300], mirror: ['wink_r', 1, 2400], gum: ['excited', 1, 2000], longpress: ['shy', 1, 2200] },
};

export function emotionFor(event: string, persona: string): EmotionCue | null {
  return PERSONA_EMOTION[persona]?.[event] ?? EVENT_EMOTION[event] ?? null;
}

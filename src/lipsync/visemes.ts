/** Виземы — формы рта Rhubarb (A–H, X); одинаковый набор для 3D-блендшейпов и спрайтовых PNG. */
export type Viseme = 'X' | 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H';
export const VISEMES: Viseme[] = ['X', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

/** Параметры рта для каждой формы: раскрытие челюсти, ширина, округлость губ */
export interface MouthShape { open: number; wide: number; round: number }
export const VISEME_SHAPE: Record<Viseme, MouthShape> = {
  X: { open: 0, wide: 0, round: 0 },       // покой
  A: { open: 0, wide: 0, round: 0 },       // М Б П — губы сомкнуты
  B: { open: 0.2, wide: 0.3, round: 0 },   // большинство согласных, «и»
  C: { open: 0.45, wide: 0.5, round: 0 },  // «э», «е»
  D: { open: 0.9, wide: 0.4, round: 0 },   // «а» — широко
  E: { open: 0.55, wide: 0, round: 0.6 },  // «о»
  F: { open: 0.25, wide: 0, round: 1 },    // «у», «ю» — трубочкой
  G: { open: 0.12, wide: 0.2, round: 0 },  // «ф», «в» — зубы на губе
  H: { open: 0.4, wide: 0.3, round: 0 },   // «л» — язык
};

/** Блендшейпы финальной модели (docs/CHARACTER_SPEC.md): веса на каждую визему */
export const VISEME_TO_BLENDSHAPES: Record<Viseme, Record<string, number>> = {
  X: {}, A: { mouth_M: 1 }, B: { mouth_E: 0.4 }, C: { mouth_E: 1 }, D: { mouth_A: 1 },
  E: { mouth_O: 1 }, F: { mouth_U: 1 }, G: { mouth_M: 0.4, mouth_E: 0.3 }, H: { mouth_A: 0.45 },
};

/** wawa-lipsync (Oculus-визем) → Rhubarb */
export const WAWA_TO_RHUBARB: Record<string, Viseme> = {
  viseme_sil: 'X', viseme_PP: 'A', viseme_FF: 'G', viseme_TH: 'H', viseme_DD: 'B', viseme_kk: 'B', viseme_CH: 'B',
  viseme_SS: 'B', viseme_nn: 'B', viseme_RR: 'B', viseme_aa: 'D', viseme_E: 'C', viseme_I: 'B', viseme_O: 'E', viseme_U: 'F',
};

export interface MouthCue { start: number; end: number; value: string }

/**
 * Псевдо-cues из русского текста — для speechSynthesis (звук которого недоступен Web Audio).
 * Буквы → визем, длительности по типу звука, затем масштаб под оценку длительности фразы.
 */
const V: Record<string, Viseme> = {
  а: 'D', я: 'D', о: 'E', ё: 'E', у: 'F', ю: 'F', э: 'C', е: 'C', и: 'B', ы: 'B',
  м: 'A', б: 'A', п: 'A', ф: 'G', в: 'G', л: 'H',
};
const VOWELS = new Set('аяоёуюэеиы');
export function cuesFromText(text: string, totalSec: number): MouthCue[] {
  const t = text.toLowerCase();
  const raw: { v: Viseme; d: number }[] = [];
  for (const ch of t) {
    if (/[.!?…]/.test(ch)) raw.push({ v: 'X', d: 0.28 });
    else if (/[,;:—-]/.test(ch)) raw.push({ v: 'X', d: 0.16 });
    else if (ch === ' ') raw.push({ v: 'X', d: 0.03 });
    else if (/[а-яё]/.test(ch)) raw.push({ v: V[ch] ?? 'B', d: VOWELS.has(ch) ? 0.11 : 0.055 });
  }
  const sum = raw.reduce((a, r) => a + r.d, 0) || 1;
  const k = totalSec / sum;
  const out: MouthCue[] = [];
  let at = 0;
  for (const r of raw) {
    const d = r.d * k;
    const last = out[out.length - 1];
    if (last && last.value === r.v) last.end += d;
    else out.push({ start: at, end: at + d, value: r.v });
    at += d;
  }
  return out;
}

export function estimateSpeechSec(text: string, rate = 1) {
  const vowels = [...text.toLowerCase()].filter((c) => VOWELS.has(c)).length;
  const pauses = (text.match(/[.!?…,;:—]/g) ?? []).length;
  return (vowels * 0.19 + pauses * 0.2 + 0.3) / rate;
}

export function cueAt(cues: MouthCue[], t: number): Viseme {
  // бинпоиск не нужен: реплики короткие
  for (const c of cues) if (t >= c.start && t < c.end) return (c.value as Viseme) ?? 'X';
  return 'X';
}

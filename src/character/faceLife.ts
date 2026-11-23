/**
 * Живость лица и головы 3D-кота (поверх клипа, пресета лица и липсинка):
 *  • рот — блендшейпы из сглаженных параметров рта (open/wide/round), а не из одной виземы: открывается заметно и плавно;
 *  • голова во время речи — кивки в такт слогам, лёгкое покачивание и наклон (как у Talking Tom), с открытием рта чуть вверх;
 *  • в покое — микромимика раз в 3–8 с (полуулыбка, прищур, ухмылка у Хулигана, румянец у Блёстки), дрейф головы, дыхание.
 * Всё детерминировано при заданном rnd (тесты), без аллокаций в кадре.
 */
import type { MouthShape, Viseme } from '../lipsync/visemes';

export interface LifeInput { persona: string; preset: string; open: number; idle: boolean }
export interface HeadLife { yaw: number; pitch: number; roll: number; breath: number }

interface Micro { weights: Record<string, number>; dur: number }

/** микромимика по характеру: Хулиган ухмыляется, Добряк улыбается, Блёстка улыбается (без румянца) */
const MICRO: Record<string, Micro[]> = {
  hooligan: [
    { weights: { smirk: 0.55 }, dur: 1.6 },
    { weights: { eyes_squint: 0.35, smirk: 0.3 }, dur: 1.3 },
    { weights: { smile: 0.3 }, dur: 1.2 },
  ],
  kind: [
    { weights: { smile: 0.45 }, dur: 1.8 },
    { weights: { smile: 0.3, eyes_squint: 0.25 }, dur: 1.5 },
    { weights: { blush: 0.4, smile: 0.25 }, dur: 1.6 },
  ],
  glitter: [
    { weights: { smile: 0.5, eyes_squint: 0.2 }, dur: 1.5 },
    { weights: { smile: 0.45, cheek_up: 0.3 }, dur: 1.8 }, // 23.11: без румянца (разворот 1123)
    { weights: { wink_R: 1, smile: 0.4 }, dur: 0.55 },
  ],
};
/** при этих пресетах микромимика не мешает (сон, обида и т.п.) */
const CALM = new Set(['neutral', 'listen', 'think', 'caring', 'happy', 'proud']);

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class FaceLife {
  readonly head: HeadLife = { yaw: 0, pitch: 0, roll: 0, breath: 0 };
  /** сглаженная «громкость» речи 0..1: быстро растёт, медленно спадает (голова не замирает между словами) */
  talk = 0;
  private t = 0;
  private open = 0;
  private openPrev = 0;
  private nod = 0;
  private nodV = 0;
  private micro: Micro | null = null;
  private microT = 0;
  private nextMicro = 4;
  private seed = Math.random() * 100;
  private readonly out: Record<string, number> = {};

  constructor(private rnd: () => number = Math.random) {
    this.nextMicro = 3 + rnd() * 4;
  }

  /** липсинк → веса mouth_*; пусто в тишине (тогда рот берёт пресет лица целиком) */
  static mouthWeights(v: Viseme, w: number, s: MouthShape): Record<string, number> {
    const open = clamp01(s.open), round = clamp01(s.round), wide = clamp01(s.wide);
    const closed = v === 'A' ? clamp01(w) : 0;
    if (open < 0.01 && closed < 0.01 && round < 0.01) return {};
    return {
      // до 1.3: ключ линейный — рот и челюсть раскрываются дальше нарисованного максимума, рот виден издалека
      mouth_A: Math.min(1.3, open * 1.4 * (1 - round * 0.85)),
      mouth_E: clamp01(wide * 0.9 * (1 - round)),
      mouth_O: Math.min(1.2, round * clamp01((open - 0.2) * 3) * 1.6),
      mouth_U: clamp01(round * (1 - clamp01((open - 0.2) * 3))),
      mouth_M: closed,
    };
  }

  update(dt: number, i: LifeInput): Record<string, number> {
    this.t += dt;
    const t = this.t + this.seed;
    // речь: огибающая открытия рта
    const target = i.open > 0.05 ? 1 : 0;
    this.talk += (target - this.talk) * (1 - Math.exp(-dt / (target ? 0.08 : 0.6)));
    this.open += (i.open - this.open) * (1 - Math.exp(-dt / 0.05));
    // кивок на каждый «слог»: рот резко открылся → толчок пружины
    const dOpen = this.open - this.openPrev;
    this.openPrev = this.open;
    if (dt > 0 && dOpen / dt > 2.5) this.nodV += 0.9 * Math.min(1, dOpen * 4);
    // пружина кивка (ω≈14, ζ≈0.45)
    this.nodV += (-this.nod * 196 - this.nodV * 12.6) * dt;
    this.nod += this.nodV * dt;
    const k = this.talk;
    const h = this.head;
    // в покое — медленный дрейф; в речи — покачивание, наклон, кивки, голова чуть вверх на открытом рту
    h.yaw = 0.025 * Math.sin(t * 0.37) + k * (0.09 * Math.sin(t * 1.9) + 0.04 * Math.sin(t * 3.1));
    h.pitch = 0.02 * Math.sin(t * 0.53 + 1) + k * (0.05 * Math.sin(t * 2.3) + 0.06 * this.open) - this.nod * 0.09;
    h.roll = 0.02 * Math.sin(t * 0.29 + 2) + k * 0.06 * Math.sin(t * 1.3 + 0.5);
    h.breath = 0.018 * Math.sin((this.t * Math.PI * 2) / 3.4);

    // микромимика: только в покое, без речи и при спокойном пресете
    for (const key in this.out) this.out[key] = 0;
    if (this.micro) {
      this.microT += dt;
      const m = this.micro;
      const p = this.microT / m.dur;
      if (p >= 1) this.micro = null;
      else {
        const env = Math.sin(Math.PI * Math.min(1, p)) ** 0.6;
        for (const key in m.weights) this.out[key] = m.weights[key] * env * (1 - k);
      }
    } else if (this.t > this.nextMicro) {
      this.nextMicro = this.t + 3 + this.rnd() * 5;
      const list = MICRO[i.persona] ?? MICRO.kind;
      if (k < 0.1 && CALM.has(i.preset)) {
        this.micro = list[Math.floor(this.rnd() * list.length) % list.length];
        this.microT = 0;
      }
    }
    // брови «подпрыгивают» на ударных слогах (как у Тома): от пружины кивка
    if (k > 0.05) this.out.brow_up = Math.max(this.out.brow_up ?? 0, k * Math.min(0.55, Math.max(0, this.nod) * 5));
    return this.out;
  }
}

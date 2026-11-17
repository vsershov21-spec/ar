/**
 * Лицо — content/face.json: пресеты весов блендшейпов, уши (−1 прижаты … 1 торчком), зрачки (0.6 … 1.4).
 * FaceMixer плавно переходит между пресетами (120–200 мс) и моргает раз в 3–5 с, кроме пресетов noBlink.
 * Липсинк (mouth_*) накладывается поверх — его делает персонаж.
 */
import faceJson from '../../content/face.json';

export interface FacePreset { id: string; weights: Record<string, number>; ears: number; pupils: number; noBlink?: boolean; gaze?: [number, number] }

const PRESETS = new Map<string, FacePreset>();
for (const p of (faceJson as unknown as { presets: FacePreset[] }).presets) PRESETS.set(p.id, p);
export const FACE_IDS: readonly string[] = [...PRESETS.keys()];
export const MORPH_TARGETS: readonly string[] = (faceJson as { morphTargets: string[] }).morphTargets;
export const facePreset = (id: string) => PRESETS.get(id);

/** старые эмоции Character.emote → пресеты */
export const EMOTE_FACE: Record<string, string> = { neutral: 'neutral', happy: 'happy', angry: 'annoyed', wink: 'wink', smirk: 'smirk' };

export interface FaceState { weights: Record<string, number>; ears: number; pupils: number; blink: number }

const warned = new Set<string>();

export class FaceMixer {
  /** текущее состояние (после update) */
  readonly cur: FaceState = { weights: {}, ears: 0, pupils: 1, blink: 0 };
  private from: FaceState = { weights: {}, ears: 0, pupils: 1, blink: 0 };
  private to: FacePreset = PRESETS.get('neutral') ?? { id: 'neutral', weights: {}, ears: 0, pupils: 1 };
  private base: string = 'neutral';
  private t = 1;
  private dur = 0.16;
  private untilS = 0;
  private time = 0;
  private blinkT = 0;
  private nextBlink = 3;
  /** id текущего пресета */
  get preset() {
    return this.to.id;
  }

  constructor(private rnd: () => number = Math.random, private log: (m: string) => void = (m) => console.warn(m)) {
    this.nextBlink = 3 + rnd() * 2;
  }

  /**
   * Пресет лица; ms > 0 — на время, потом возврат к базовому; transitionMs — 120–200 мс.
   * Неизвестный id → предупреждение (один раз) и neutral.
   */
  set(id: string, ms = 0, transitionMs = 160) {
    let p = PRESETS.get(id);
    if (!p) {
      if (!warned.has(id)) {
        warned.add(id);
        this.log(`[face] неизвестный пресет «${id}» — neutral (нет в content/face.json)`);
      }
      p = PRESETS.get('neutral')!;
    }
    if (ms <= 0) this.base = p.id;
    this.untilS = ms > 0 ? this.time + ms / 1000 : 0;
    this.from = { weights: { ...this.cur.weights }, ears: this.cur.ears, pupils: this.cur.pupils, blink: 0 };
    this.to = p;
    this.t = 0;
    this.dur = Math.min(0.2, Math.max(0.12, transitionMs / 1000));
  }

  /** моргнуть сейчас */
  blink() {
    if (!this.to.noBlink) this.blinkT = 0.001;
  }

  update(dt: number): FaceState {
    this.time += dt;
    if (this.untilS && this.time >= this.untilS) {
      this.untilS = 0;
      this.set(this.base);
    }
    this.t = Math.min(1, this.t + dt / this.dur);
    const k = this.t * this.t * (3 - 2 * this.t);
    const w: Record<string, number> = {};
    const keys = new Set([...Object.keys(this.from.weights), ...Object.keys(this.to.weights)]);
    for (const key of keys) {
      const v = (this.from.weights[key] ?? 0) + ((this.to.weights[key] ?? 0) - (this.from.weights[key] ?? 0)) * k;
      if (v > 0.001) w[key] = v;
    }
    this.cur.weights = w;
    this.cur.ears = this.from.ears + (this.to.ears - this.from.ears) * k;
    this.cur.pupils = this.from.pupils + (this.to.pupils - this.from.pupils) * k;
    // моргание: 150 мс раз в 3–5 с, кроме noBlink (сон, мурчание, головокружение)
    if (this.to.noBlink) {
      this.blinkT = 0;
      this.cur.blink = 0;
    } else {
      if (this.blinkT > 0) {
        this.blinkT += dt;
        if (this.blinkT > 0.15) this.blinkT = 0;
      } else if (this.time >= this.nextBlink) {
        this.blinkT = 0.001;
        this.nextBlink = this.time + 3 + this.rnd() * 2;
      }
      this.cur.blink = this.blinkT > 0 ? Math.sin((this.blinkT / 0.15) * Math.PI) : 0;
    }
    return this.cur;
  }
}

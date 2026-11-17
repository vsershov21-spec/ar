/**
 * Детекторы по уровню микрофона — чистые функции/классы без Web Audio (тестируются в Node).
 * Вход — кадры по 10 мс: rms (линейный 0..1), peak (макс. |x|), zcr (доля пересечений нуля).
 *
 *  NoiseFloor — шумовой порог: первые 2 с после включения микрофона — калибровка (медиана),
 *               дальше медленно следует за тишиной (вверх медленно, вниз быстро).
 *  Vad        — начало/конец фразы: энергия выше порога ≥ 120 мс = начало; 400 мс тишины = конец; максимум 6 с.
 *  SoundEvents — без распознавания речи: loud (крик: громко ≥ 400 мс), clap (хлопок: пик < 80 мс),
 *               whisper (фраза есть, но тихая и «шумная» по спектру — шёпот без голоса).
 */

export interface Frame { rms: number; peak: number; zcr: number }
export const FRAME_MS = 10;
export const db = (v: number) => 20 * Math.log10(Math.max(v, 1e-7));

export class NoiseFloor {
  /** шум, dBFS */
  floorDb = -60;
  calibrated = false;
  private calib: number[] = [];
  constructor(public calibMs = 2000) {}

  /** начать калибровку заново (новое включение микрофона) */
  reset(keepValue = true) {
    this.calib = [];
    this.calibrated = false;
    if (!keepValue) this.floorDb = -60;
  }

  push(f: Frame, speaking: boolean) {
    const d = db(f.rms);
    if (!this.calibrated) {
      this.calib.push(d);
      if (this.calib.length * FRAME_MS >= this.calibMs) {
        const s = [...this.calib].sort((a, b) => a - b);
        // 30-й перцентиль: ребёнок мог заговорить сразу — не даём речи поднять порог
        this.floorDb = Math.min(-25, Math.max(-75, s[Math.floor(s.length * 0.3)]));
        this.calibrated = true;
      } else if (this.calib.length === 20) {
        // за 200 мс — грубая оценка, чтобы VAD работал во время калибровки
        const s = [...this.calib].sort((a, b) => a - b);
        this.floorDb = Math.min(-25, Math.max(-75, s[5]));
      }
      return;
    }
    if (speaking) return;
    // вниз — быстро, вверх — медленно (≈ +1 дБ за 3 с тишины)
    if (d < this.floorDb) this.floorDb += (d - this.floorDb) * 0.05;
    else this.floorDb += Math.min(d - this.floorDb, 6) * 0.0006;
    this.floorDb = Math.min(-25, Math.max(-80, this.floorDb));
  }
}

export interface VadOpts {
  /** превышение над шумом для «речи», дБ */
  marginDb: number;
  /** абсолютный минимум речи, dBFS */
  minDb: number;
  startMs: number;
  endSilenceMs: number;
  maxMs: number;
}
export const VAD_DEFAULTS: VadOpts = { marginDb: 12, minDb: -50, startMs: 120, endSilenceMs: 400, maxMs: 6000 };

export type VadEvent = { type: 'start'; atMs: number } | { type: 'end'; durMs: number; reason: 'silence' | 'max' } | null;

export class Vad {
  speaking = false;
  /** длительность текущей фразы, мс */
  durMs = 0;
  private above = 0;
  private below = 0;
  /** статистика фразы — для шёпота */
  stats = { sumDb: 0, n: 0, sumZcr: 0, voicedN: 0 };
  constructor(public floor: NoiseFloor, public opts: VadOpts = VAD_DEFAULTS) {}

  threshold() {
    return Math.max(this.floor.floorDb + this.opts.marginDb, this.opts.minDb);
  }

  push(f: Frame): VadEvent {
    const d = db(f.rms);
    const loud = d > this.threshold();
    if (!this.speaking) {
      this.above = loud ? this.above + FRAME_MS : 0;
      if (this.above >= this.opts.startMs) {
        this.speaking = true;
        this.durMs = this.above;
        this.below = 0;
        this.stats = { sumDb: 0, n: 0, sumZcr: 0, voicedN: 0 };
        return { type: 'start', atMs: this.above };
      }
      return null;
    }
    this.durMs += FRAME_MS;
    if (loud) {
      this.below = 0;
      this.stats.sumDb += d;
      this.stats.sumZcr += f.zcr;
      this.stats.n++;
    } else this.below += FRAME_MS;
    if (this.below >= this.opts.endSilenceMs) {
      this.speaking = false;
      return { type: 'end', durMs: this.durMs - this.below, reason: 'silence' };
    }
    if (this.durMs >= this.opts.maxMs) {
      this.speaking = false;
      return { type: 'end', durMs: this.durMs, reason: 'max' };
    }
    return null;
  }

  reset() {
    this.speaking = false;
    this.above = this.below = this.durMs = 0;
  }
}

export type SoundEvent = 'loud' | 'clap' | 'whisper';
export interface SoundEventOpts {
  /** крик: выше этого уровня, dBFS, и выше шума на loudMarginDb */
  loudDb: number;
  loudMarginDb: number;
  loudMs: number;
  /** хлопок: пик над шумом, дБ; длительность громкой части < clapMaxMs */
  clapMarginDb: number;
  clapPeakDb: number;
  clapMaxMs: number;
  /** шёпот: средний уровень фразы ниже whisperDb и шумность (zcr) выше whisperZcr; фраза ≥ 500 мс */
  whisperDb: number;
  whisperZcr: number;
  whisperMinMs: number;
  cooldownMs: Record<SoundEvent, number>;
}
export const SOUND_DEFAULTS: SoundEventOpts = {
  loudDb: -14, loudMarginDb: 30, loudMs: 400,
  clapMarginDb: 28, clapPeakDb: -12, clapMaxMs: 80,
  whisperDb: -38, whisperZcr: 0.12, whisperMinMs: 500,
  // как в content/events.json
  cooldownMs: { loud: 15000, whisper: 8000, clap: 20000 },
};

export class SoundEvents {
  private loudMs = 0;
  private burstMs = 0;
  private burstPeak = -120;
  private quietBefore = 0;
  private last: Record<SoundEvent, number> = { loud: -1e9, whisper: -1e9, clap: -1e9 };
  private t = 0;
  constructor(public floor: NoiseFloor, public opts: SoundEventOpts = SOUND_DEFAULTS) {}

  private fire(e: SoundEvent): SoundEvent | null {
    if (this.t - this.last[e] < this.opts.cooldownMs[e]) return null;
    this.last[e] = this.t;
    return e;
  }

  /** кадр 10 мс → событие (или null) */
  push(f: Frame): SoundEvent | null {
    this.t += FRAME_MS;
    const d = db(f.rms), pk = db(f.peak), fl = this.floor.floorDb;
    let out: SoundEvent | null = null;
    // крик: долго и громко
    if (d > this.opts.loudDb && d > fl + this.opts.loudMarginDb) {
      this.loudMs += FRAME_MS;
      if (this.loudMs >= this.opts.loudMs) {
        out = this.fire('loud');
        this.loudMs = -1e6; // один раз на эпизод
      }
    } else if (d < this.opts.loudDb - 6) this.loudMs = 0;
    // хлопок: резкий пик из тишины, громкая часть короче 80 мс
    const hot = pk > this.opts.clapPeakDb && d > fl + this.opts.clapMarginDb;
    if (hot) {
      this.burstMs += FRAME_MS;
      this.burstPeak = Math.max(this.burstPeak, pk);
    } else if (this.burstMs > 0) {
      const short = this.burstMs <= this.opts.clapMaxMs && this.quietBefore >= 150;
      this.burstMs = 0;
      this.burstPeak = -120;
      if (short && !out) out = this.fire('clap');
    }
    if (!hot) this.quietBefore = d < fl + 12 ? this.quietBefore + FRAME_MS : 0;
    return out;
  }

  /** конец фразы (от Vad): была ли это шёпотная речь */
  phraseEnded(durMs: number, stats: { sumDb: number; n: number; sumZcr: number }): SoundEvent | null {
    if (durMs < this.opts.whisperMinMs || stats.n < 20) return null;
    const meanDb = stats.sumDb / stats.n, meanZcr = stats.sumZcr / stats.n;
    if (meanDb < this.opts.whisperDb && meanZcr > this.opts.whisperZcr) return this.fire('whisper');
    return null;
  }
}

/** разбить буфер на кадры по 10 мс */
export function toFrames(x: Float32Array, sampleRate: number, carry?: { buf: Float32Array; n: number }): Frame[] {
  const step = Math.round(sampleRate * FRAME_MS / 1000);
  const out: Frame[] = [];
  let src = x;
  if (carry && carry.n) {
    src = new Float32Array(carry.n + x.length);
    src.set(carry.buf.subarray(0, carry.n));
    src.set(x, carry.n);
  }
  let i = 0;
  for (; i + step <= src.length; i += step) {
    let s = 0, pk = 0, z = 0;
    for (let j = i; j < i + step; j++) {
      const v = src[j];
      s += v * v;
      const a = v < 0 ? -v : v;
      if (a > pk) pk = a;
      if (j > i && (v >= 0) !== (src[j - 1] >= 0)) z++;
    }
    out.push({ rms: Math.sqrt(s / step), peak: pk, zcr: z / step });
  }
  if (carry) {
    const rest = src.length - i;
    if (carry.buf.length < rest) carry.buf = new Float32Array(rest * 2);
    carry.buf.set(src.subarray(i));
    carry.n = rest;
  }
  return out;
}

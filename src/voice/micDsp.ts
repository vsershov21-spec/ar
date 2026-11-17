/**
 * Обработка звука микрофона «на месте» — в потоке звука (AudioWorklet, micWorklet.ts), а где его нет —
 * в ScriptProcessor. Без зависимостей от DOM/Web Audio (тестируется в Node).
 *
 * На каждый блок (~85 мс) отдаёт одно сообщение:
 *   pcm    — исходный звук (частота контекста) — для повтора;
 *   asr    — 16 кГц, шкала int16 (×32768) — ровно то, что ест Vosk: главный поток ничего не пересчитывает
 *            и не пересэмплирует, а Kaldi не гоняет свой ресемплер 48→16 кГц (втрое меньше данных в воркер);
 *   frames — кадры по 10 мс [rms, peak, zcr]… — для VAD / громкости / шёпота.
 */
import { FRAME_MS } from './vad';

export const ASR_SR = 16000;

export interface MicChunk {
  pcm: Float32Array;
  asr: Float32Array;
  /** [rms, peak, zcr] × n */
  frames: Float32Array;
  sampleRate: number;
}

/** биквад-ФНЧ (Баттерворт, RBJ) — состояние между блоками */
class Biquad {
  private b0: number; private b1: number; private b2: number; private a1: number; private a2: number;
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;
  constructor(sr: number, fc: number, q = Math.SQRT1_2) {
    const w = (2 * Math.PI * fc) / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
    this.b0 = (1 - c) / 2 / a0;
    this.b1 = (1 - c) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * c) / a0;
    this.a2 = (1 - al) / a0;
  }
  run(x: Float32Array) {
    let { x1, x2, y1, y2 } = this;
    const { b0, b1, b2, a1, a2 } = this;
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      const y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = v; y2 = y1; y1 = y;
      x[i] = y;
    }
    this.x1 = x1; this.x2 = x2; this.y1 = y1; this.y2 = y2;
  }
}

/** Пересэмплирование в 16 кГц: ФНЧ 6.8 кГц (3 биквада, −36 дБ/окт) + линейная интерполяция; потоковое */
export class To16k {
  private lp: Biquad[];
  private step: number;
  private pos = 0;
  private prev = 0;
  private tmp = new Float32Array(0);
  constructor(readonly sr: number) {
    this.step = sr / ASR_SR;
    this.lp = sr > ASR_SR * 1.05 ? [0, 1, 2].map(() => new Biquad(sr, 6800)) : [];
  }
  /** x не меняется; scale — множитель выхода */
  run(x: Float32Array, scale = 1): Float32Array {
    if (this.tmp.length < x.length) this.tmp = new Float32Array(x.length);
    const y = this.tmp.subarray(0, x.length);
    y.set(x);
    for (const f of this.lp) f.run(y);
    const n = y.length;
    const out = new Float32Array(Math.max(0, Math.ceil((n - 1 - this.pos) / this.step)));
    let k = 0, pos = this.pos;
    // позиция pos — в «расширенном» массиве [prev, y0, y1, …] со сдвигом −1
    while (pos < n - 1 && k < out.length) {
      const i = Math.floor(pos), fr = pos - i;
      const a = i < 0 ? this.prev : y[i], b = y[i + 1];
      out[k++] = (a + (b - a) * fr) * scale;
      pos += this.step;
    }
    this.pos = pos - n;
    this.prev = y[n - 1];
    return k === out.length ? out : out.slice(0, k);
  }
}

/** кадры по 10 мс (rms, peak, zcr) с переносом остатка между блоками */
export class Framer {
  private step: number;
  private carry: Float32Array;
  private n = 0;
  constructor(sr: number) {
    this.step = Math.round((sr * FRAME_MS) / 1000);
    this.carry = new Float32Array(this.step);
  }
  run(x: Float32Array): Float32Array {
    const step = this.step;
    const total = this.n + x.length;
    const out = new Float32Array(Math.floor(total / step) * 3);
    let k = 0, j = 0;
    // сначала добираем кадр из остатка
    const take = (src: Float32Array, from: number, len: number) => {
      // кадр из carry[0..n) + src[from..from+len)
      let s = 0, pk = 0, z = 0, prev = 0, first = true;
      const visit = (v: number) => {
        s += v * v;
        const a = v < 0 ? -v : v;
        if (a > pk) pk = a;
        if (!first && (v >= 0) !== (prev >= 0)) z++;
        first = false;
        prev = v;
      };
      for (let i = 0; i < this.n; i++) visit(this.carry[i]);
      for (let i = from; i < from + len; i++) visit(src[i]);
      out[k++] = Math.sqrt(s / step);
      out[k++] = pk;
      out[k++] = z / step;
    };
    if (this.n && this.n + x.length >= step) {
      const need = step - this.n;
      take(x, 0, need);
      this.n = 0;
      j = need;
    }
    for (; j + step <= x.length; j += step) take(x, j, step);
    // остаток
    for (; j < x.length; j++) this.carry[this.n++] = x[j];
    return out;
  }
}

/** Блоки из квантов по 128 (AudioWorklet) или сразу 4096 (ScriptProcessor) → MicChunk */
export class MicDsp {
  private block: Float32Array;
  private fill = 0;
  private framer: Framer;
  private rs: To16k;
  constructor(readonly sampleRate: number, private onChunk: (c: MicChunk) => void, blockSize = sampleRate >= 32000 ? 4096 : 2048) {
    this.block = new Float32Array(blockSize);
    this.framer = new Framer(sampleRate);
    this.rs = new To16k(sampleRate);
  }
  push(x: Float32Array) {
    let i = 0;
    while (i < x.length) {
      const n = Math.min(x.length - i, this.block.length - this.fill);
      this.block.set(x.subarray(i, i + n), this.fill);
      this.fill += n;
      i += n;
      if (this.fill === this.block.length) {
        const pcm = this.block;
        this.block = new Float32Array(pcm.length);
        this.fill = 0;
        this.onChunk({ pcm, asr: this.rs.run(pcm, 32768), frames: this.framer.run(pcm), sampleRate: this.sampleRate });
      }
    }
  }
}

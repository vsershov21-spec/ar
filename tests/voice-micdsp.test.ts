import { describe, it, expect } from 'vitest';
import { MicDsp, To16k, Framer, ASR_SR, type MicChunk } from '../src/voice/micDsp';
import { toFrames } from '../src/voice/vad';

const tone = (sr: number, f: number, sec: number, a = 0.5) => Float32Array.from({ length: Math.round(sr * sec) }, (_, i) => a * Math.sin((2 * Math.PI * f * i) / sr));
const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);

describe('micDsp: обработка микрофона в потоке звука', () => {
  it('кадры 10 мс совпадают с toFrames при любой нарезке на кванты', () => {
    const sr = 48000, x = tone(sr, 440, 1), ref = toFrames(x, sr);
    const fr = new Framer(sr);
    const parts: number[] = [];
    for (let i = 0; i < x.length; i += 128) parts.push(...fr.run(x.subarray(i, i + 128)));
    expect(parts.length / 3).toBe(ref.length);
    for (let k = 0; k < ref.length; k++) {
      expect(parts[k * 3]).toBeCloseTo(ref[k].rms, 5);
      expect(parts[k * 3 + 1]).toBeCloseTo(ref[k].peak, 5);
    }
  });

  it('16 кГц: длина верная, речевой тон проходит, выше 8 кГц — подавлен (без алиасинга)', () => {
    for (const sr of [48000, 44100]) {
      const r = new To16k(sr);
      let out: number[] = [];
      const x = tone(sr, 1000, 2);
      for (let i = 0; i < x.length; i += 128) out.push(...r.run(x.subarray(i, i + 128)));
      expect(Math.abs(out.length - 2 * ASR_SR)).toBeLessThan(3);
      expect(rms(Float32Array.from(out.slice(800)))).toBeGreaterThan(0.33);
      const hi = new To16k(sr);
      out = [];
      const y = tone(sr, 12000, 1);
      for (let i = 0; i < y.length; i += 128) out.push(...hi.run(y.subarray(i, i + 128)));
      expect(rms(Float32Array.from(out.slice(800)))).toBeLessThan(0.02); // −28 дБ и ниже
    }
  });

  it('блоки по 4096: pcm целиком, asr в шкале int16, кадры — на месте', () => {
    const got: MicChunk[] = [];
    const d = new MicDsp(48000, (c) => got.push(c));
    const x = tone(48000, 300, 0.5, 0.25);
    for (let i = 0; i < x.length; i += 128) d.push(x.subarray(i, i + 128));
    expect(got.length).toBe(Math.floor(x.length / 4096));
    expect(got[1].pcm.length).toBe(4096);
    expect([8, 9]).toContain(got[1].frames.length / 3); // 4096 / 480
    expect(Math.max(...got[2].asr)).toBeGreaterThan(0.2 * 32768);
    expect(got[2].asr.length).toBeGreaterThan(1360);
    expect(got[2].asr.length).toBeLessThan(1368);
  });
});

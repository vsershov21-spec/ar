import { describe, it, expect, beforeAll } from 'vitest';
import { VoskAsr } from '../src/voice/asr';
import type { MicInput } from '../src/voice/mic';

/** энергия: в окне ответа звук идёт в Vosk, только пока есть голос; начало фразы — из кольца 400 мс */
describe('VoskAsr.gate', () => {
  beforeAll(() => {
    (globalThis as any).window ??= globalThis;
  });

  it('тишина не кормит распознаватель, начало фразы (≤ 400 мс) уходит перед голосом', async () => {
    const SR = 48000, CH = 4096;
    const listeners = new Set<(b: Float32Array) => void>();
    const mic = {
      supported: true, sampleRate: SR, level: 0, error: null,
      acquire: () => Promise.resolve(true), release: () => {},
      on: (fn: (b: Float32Array) => void) => (listeners.add(fn), () => listeners.delete(fn)),
    } as unknown as MicInput;
    let fed = 0;
    class Rec {
      on() {}
      acceptWaveformFloat(b: Float32Array) {
        fed += b.length;
      }
      retrieveFinalResult() {}
      remove() {}
    }
    const asr = new VoskAsr(mic);
    (asr as any).model = { KaldiRecognizer: Rec };
    (asr as any).loading = Promise.resolve(true);
    let voice = false;
    asr.gate = () => voice;
    await asr.start();
    const push = (n: number) => {
      for (let i = 0; i < n; i++) listeners.forEach((fn) => fn(new Float32Array(CH)));
    };
    push(60); // ~5 с тишины в окне ответа
    expect(fed).toBe(0);
    voice = true;
    push(12); // ~1 с голоса
    const pre = fed - 12 * CH;
    expect(pre).toBeGreaterThanOrEqual(SR * 0.4);
    expect(pre).toBeLessThanOrEqual(SR * 0.4 + 2 * CH);
    asr.gate = null;
    voice = false;
    push(3);
    expect(fed).toBe(pre + 15 * CH); // без gate — всё подряд (кнопка, фраза по VAD)
    asr.abort();
  });
});

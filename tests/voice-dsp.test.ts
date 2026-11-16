import { describe, it, expect } from 'vitest';
import { pitchShift, loudnessLufs, normalizeLoudness, resample, frames } from '../src/audio/dsp';
import { phonesFromIpa, phonesFromText, alignPhones, cuesFromAlignment, cuesFromAmplitude } from '../src/lipsync/ru';
import { NoiseFloor, Vad, SoundEvents, toFrames } from '../src/voice/vad';
import { unpackCues, extractName } from '../src/voice/voicePlayer';
import { DialogQueue } from '../src/voice/dialog';

const sine = (sr: number, sec: number, f: number, a = 0.3) => Float32Array.from({ length: Math.round(sr * sec) }, (_, i) => a * Math.sin((2 * Math.PI * f * i) / sr));
const zc = (x: Float32Array) => { let z = 0; for (let i = 1; i < x.length; i++) if ((x[i] >= 0) !== (x[i - 1] >= 0)) z++; return z; };

describe('dsp', () => {
  it('сдвиг тона +12 пт удваивает частоту и сохраняет длительность', () => {
    const sr = 16000, x = sine(sr, 1, 200);
    const y = pitchShift(x, sr, 12, 1);
    expect(Math.abs(y.length - x.length)).toBeLessThan(sr * 0.01);
    const f = zc(y.subarray(2000, 14000)) / 2 / (12000 / sr);
    expect(f).toBeGreaterThan(380);
    expect(f).toBeLessThan(420);
  });
  it('темп 1.25 — короче в 1.25 раза, тон тот же', () => {
    const sr = 16000, x = sine(sr, 1, 300);
    const y = pitchShift(x, sr, 0, 1.25);
    expect(Math.abs(y.length - sr / 1.25)).toBeLessThan(sr * 0.01);
    const f = zc(y.subarray(1000, y.length - 1000)) / 2 / ((y.length - 2000) / sr);
    expect(Math.abs(f - 300)).toBeLessThan(12);
  });
  it('громкость: синус 1 кГц, RMS −20 dBFS = −20 LUFS (BS.1770: 0 dBFS-пик ≈ −3 LUFS); нормализация к −16', () => {
    const sr = 48000, x = sine(sr, 2, 1000, 0.1 * Math.SQRT2);
    expect(Math.abs(loudnessLufs(x, sr) + 20)).toBeLessThan(0.2);
    const y = normalizeLoudness(x, sr, -16, -1.5);
    expect(Math.abs(loudnessLufs(y, sr) + 16)).toBeLessThan(0.5);
    expect(Math.max(...y.map(Math.abs))).toBeLessThanOrEqual(Math.pow(10, -1.5 / 20) + 1e-3);
  });
  it('пересэмплирование меняет длину', () => expect(resample(sine(48000, 0.5, 440), 0.5).length).toBe(12000));
});

describe('русский липсинк', () => {
  it('IPA espeak → виземы: мама/папа смыкают губы, «у» — трубочка', () => {
    const ph = phonesFromIpa('mˈamə pˈapə\nkʊ');
    expect(ph.filter((p) => p.v === 'A').length).toBe(4);
    expect(ph.some((p) => p.p === '|')).toBe(true);
    expect(ph.find((p) => p.p === 'ʊ')?.v).toBe('F');
  });
  it('буквенный путь: ш/ж/ч — B, л — H, о — E', () => {
    const v = phonesFromText('шлём ночь').map((p) => p.v).join('');
    expect(v).toContain('H');
    expect(v.startsWith('B')).toBe(true);
    expect(v).toContain('E');
  });
  it('выравнивание: гласные ложатся на громкие участки, паузы — на тишину', () => {
    const sr = 16000;
    // «а» 200 мс — тишина 300 мс — «а» 200 мс
    const x = new Float32Array(sr * 0.7);
    x.set(sine(sr, 0.2, 220), 0);
    x.set(sine(sr, 0.2, 220), Math.round(sr * 0.5));
    const ph = phonesFromText('а. а');
    const f = frames(x, sr);
    const t = alignPhones(ph, f);
    const cues = cuesFromAlignment(ph, t, 0.7);
    const at = (s: number) => cues.find((c) => s >= c.start && s < c.end)?.value;
    expect(at(0.1)).toBe('D');
    expect(at(0.35)).toBe('X');
    expect(at(0.6)).toBe('D');
    const amp = cuesFromAmplitude(f, 0.7);
    expect(amp.find((c) => 0.35 >= c.start && 0.35 < c.end)?.value).toBe('X');
  });
  it('упаковка cues и имя из шаблона', () => {
    expect(unpackCues('X0 D120 A300', 0.5)).toEqual([
      { start: 0, end: 0.12, value: 'X' }, { start: 0.12, end: 0.3, value: 'D' }, { start: 0.3, end: 0.5, value: 'A' },
    ]);
    expect(extractName('{name}! Звучит круто.', 'Маша! Звучит круто.')).toBe('Маша');
    expect(extractName('О, {name}. Будем знакомы!', 'О, Тёма. Будем знакомы!')).toBe('Тёма');
  });
});

describe('VAD и события громкости', () => {
  const run = (sr: number, parts: [number, number][]) => {
    const fl = new NoiseFloor(2000);
    const vad = new Vad(fl), se = new SoundEvents(fl);
    const out: string[] = [];
    let t = 0;
    for (const [sec, amp] of parts) {
      const x = amp ? sine(sr, sec, 300, amp) : Float32Array.from({ length: sr * sec }, () => (Math.random() - 0.5) * 0.002);
      for (const f of toFrames(x, sr)) {
        t += 10;
        fl.push(f, vad.speaking);
        const e = vad.push(f);
        if (e) out.push(`${e.type}@${t}`);
        const s = se.push(f);
        if (s) out.push(`${s}@${t}`);
      }
    }
    return { out, fl };
  };
  it('калибровка шума за 2 с, фраза: начало и конец через 400 мс тишины', () => {
    const { out, fl } = run(16000, [[2, 0], [1, 0.05], [1, 0]]);
    expect(fl.calibrated).toBe(true);
    expect(fl.floorDb).toBeLessThan(-50);
    expect(out.some((e) => e.startsWith('start@'))).toBe(true);
    const end = out.find((e) => e.startsWith('end@'))!;
    const tEnd = Number(end.split('@')[1]);
    expect(tEnd).toBeGreaterThanOrEqual(3400);
    expect(tEnd).toBeLessThan(3500);
  });
  it('максимум фразы 6 с', () => {
    const { out } = run(16000, [[2, 0], [7, 0.05]]);
    expect(out.filter((e) => e.startsWith('end@')).length).toBeGreaterThanOrEqual(1);
  });
  it('крик (громко > 400 мс) → loud', () => {
    const { out } = run(16000, [[2, 0], [0.6, 0.6], [0.5, 0]]);
    expect(out.some((e) => e.startsWith('loud'))).toBe(true);
  });
  it('хлопок (пик 50 мс из тишины) → clap, но не loud', () => {
    const { out } = run(16000, [[2, 0], [0.05, 0.9], [0.5, 0]]);
    expect(out.some((e) => e.startsWith('clap'))).toBe(true);
    expect(out.some((e) => e.startsWith('loud'))).toBe(false);
  });
  it('шёпот: тихая шумная фраза → whisper', () => {
    const fl = new NoiseFloor(2000);
    fl.floorDb = -70;
    fl.calibrated = true;
    const se = new SoundEvents(fl);
    expect(se.phraseEnded(900, { sumDb: -44 * 80, n: 80, sumZcr: 0.3 * 80 })).toBe('whisper');
    expect(se.phraseEnded(900, { sumDb: -24 * 80, n: 80, sumZcr: 0.05 * 80 })).toBe(null);
  });
});

describe('очередь: перебивание', () => {
  it('bargeIn: реплика затухает, сценарий ждёт release, болтовня выбрасывается', async () => {
    const log: string[] = [];
    const player = { cancel: () => log.push('cancel'), fadeOut: (ms: number) => log.push(`fade${ms}`) };
    const q = new DialogQueue(player);
    let end1!: () => void;
    q.say('reaction', () => new Promise<void>((r) => ((end1 = r), log.push('r1'))));
    q.say('scenario', async () => void log.push('s1'));
    q.bargeIn(120);
    expect(log).toEqual(['r1', 'fade120']);
    end1();
    await new Promise((r) => setTimeout(r, 0));
    expect(log).not.toContain('s1');
    expect(q.say('chatter', async () => void log.push('c1'))).toBe(false);
    q.release();
    await new Promise((r) => setTimeout(r, 0));
    expect(log).toContain('s1');
  });
});

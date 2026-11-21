/**
 * Синхронность голоса и пузыря (жалоба с iPhone 20.11: «озвучка запаздывает» — пузырь и реакция шли сразу, а голос —
 * после сети и декодирования mp3). VoicePlayer на фейковом Web Audio: сеть и декодирование — с задержкой.
 *  • onStart — в момент слышимого старта; разбор задержки (timings: fetch, decode, hold, resume);
 *  • warmEvents — все варианты события сжатыми, первые — декодированными: реплика «сейчас» ≤ 150 мс до звука;
 *  • LRU сжатых и декодированных по объёму; cancel без звука — без «качелей» приглушения;
 *  • режиссёр показывает пузырь по onStart (а не до записи).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { VoicePlayer, RAW_CACHE_BYTES } from '../src/voice/voicePlayer';
import { makeDirector } from './helpers/directorHarness';

const FETCH_MS = 220, DECODE_MS = 40;

function fakeAudio(o: { state?: AudioContextState } = {}) {
  let t = 0; // currentTime по performance.now (фейковые таймеры)
  const ducks: boolean[] = [];
  const started: number[] = [];
  const ctx = {
    get currentTime() {
      return performance.now() / 1000 + t;
    },
    state: o.state ?? 'running',
    sampleRate: 48000,
    baseLatency: 0.01,
    outputLatency: 0.02,
    resume: vi.fn(async function (this: { state: string }) {
      await new Promise((r) => setTimeout(r, 30));
      ctx.state = 'running';
    }),
    decodeAudioData: (b: ArrayBuffer) =>
      new Promise((r) => setTimeout(() => r({ length: 48000 * 2, numberOfChannels: 1, sampleRate: 48000, duration: 2, getChannelData: () => new Float32Array(4800), bytes: b.byteLength }), DECODE_MS)),
    createGain: () => ({ gain: { value: 1, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {} }),
    createBufferSource() {
      const s = {
        buffer: null as unknown,
        onended: null as null | (() => void),
        connect() {},
        disconnect() {},
        start(at: number) {
          started.push(performance.now() + Math.max(0, at - ctx.currentTime) * 1000);
          setTimeout(() => s.onended?.(), 2000);
        },
        stop() {
          setTimeout(() => s.onended?.(), 0);
        },
      };
      return s;
    },
  };
  void t;
  const audio = { ctx, voiceOut: () => ({}), duck: (on: boolean) => ducks.push(on) };
  return { audio, ctx, ducks, started };
}

/** манифест ElevenLabs: событие → 4 варианта, ~25 КБ каждый */
function manifest(events: string[], persona = 'kind') {
  const lines: Record<string, unknown> = {};
  for (const ev of events) for (let i = 1; i <= 4; i++) lines[`${persona}.${ev}.0${i}`] = { f: `el/${persona}/${ev}.0${i}.mp3`, d: 2, o: 0, c: 'X0', t: `${ev} ${i}` };
  return { lines, templates: {} };
}

function install(man: object) {
  const fetched: string[] = [];
  globalThis.fetch = vi.fn(async (u: string) => {
    const url = String(u);
    if (url.endsWith('voice/el/manifest.json')) return { ok: true, headers: { get: () => 'application/json' }, json: async () => man } as unknown as Response;
    fetched.push(url);
    await new Promise((r) => setTimeout(r, FETCH_MS));
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(25_000) } as unknown as Response;
  }) as unknown as typeof fetch;
  return fetched;
}

const req = (ev: string, i: number) => ({ persona: 'kind', template: `${ev} ${i}`, text: `${ev} ${i}`, pitch: 1, rate: 1, lineId: `kind.${ev}.0${i}` });
const p90 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(xs.length * 0.9) - 1)];

describe('VoicePlayer: старт звука, прогрев, кэши', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = realFetch;
  });

  it('холодная реплика: onStart — когда звук пошёл; timings раскладывают задержку на сеть и декодирование', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    const { audio, started } = fakeAudio();
    install(manifest(['dance']));
    const v = new VoicePlayer(audio as never);
    await v.load();
    const t0 = performance.now();
    let startAt = -1;
    const p = v.speak(req('dance', 1), { onStart: () => (startAt = performance.now()) });
    await vi.advanceTimersByTimeAsync(400);
    expect(started.length).toBe(1);
    expect(startAt - t0).toBeGreaterThanOrEqual(FETCH_MS + DECODE_MS);
    // onStart не раньше слышимого старта (старт буфера + задержка вывода)
    expect(startAt).toBeGreaterThanOrEqual(started[0]);
    const t = v.timings.at(-1)!;
    expect(t.warm).toBe(false);
    expect(t.fetchMs).toBeGreaterThanOrEqual(FETCH_MS - 1);
    expect(t.decodeMs).toBeGreaterThanOrEqual(DECODE_MS - 1);
    expect(t.startMs).toBeGreaterThanOrEqual(FETCH_MS + DECODE_MS);
    await vi.advanceTimersByTimeAsync(2500);
    await p;
  });

  it('после прогрева: p90 «нажатие → звук» ≤ 150 мс (декодированные — сразу, сжатые — одно декодирование)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    const { audio } = fakeAudio();
    const evs = ['dance', 'flip', 'stroke', 'tap_cat_head', 'tap_cat_belly', 'treat'];
    const fetched = install(manifest(evs));
    const v = new VoicePlayer(audio as never);
    await v.load();
    // смена кота: все варианты сжатыми; чипы (dance, flip) — декодированными
    v.warmEvents('kind', evs, { fetch: 6, decode: 0 });
    v.warmEvents('kind', ['dance', 'flip'], { fetch: 6, decode: 6 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(new Set(fetched).size).toBe(evs.length * 4);
    expect(v.isWarm(req('dance', 3))).toBe(true);
    expect(v.isWarm(req('stroke', 2))).toBe(false); // сжатая, не декодирована
    const lat: number[] = [];
    for (let k = 0; k < 24; k++) {
      const ev = evs[k % evs.length], i = 1 + ((k * 7) % 4);
      const t0 = performance.now();
      let at = -1;
      const p = v.speak(req(ev, i), { onStart: () => (at = performance.now()) });
      await vi.advanceTimersByTimeAsync(300);
      expect(at).toBeGreaterThan(0);
      lat.push(at - t0);
      await vi.advanceTimersByTimeAsync(2000);
      await p;
    }
    expect(fetched.length).toBe(evs.length * 4); // после прогрева — ни одного запроса
    expect(p90(lat)).toBeLessThanOrEqual(150);
  });

  it('контекст «interrupted» (iOS): resume до старта, ожидание видно в timings', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    const { audio, ctx } = fakeAudio({ state: 'interrupted' as AudioContextState });
    install(manifest(['dance']));
    const v = new VoicePlayer(audio as never);
    await v.load();
    const p = v.speak(req('dance', 1));
    await vi.advanceTimersByTimeAsync(600);
    expect(ctx.resume).toHaveBeenCalled();
    expect(v.timings.at(-1)!.resumeMs).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(2500);
    await p;
  });

  it('cancel без звука — без остановок и без снятия приглушения (нет двойного cancel)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    const { audio, ducks } = fakeAudio();
    install(manifest(['dance']));
    const v = new VoicePlayer(audio as never);
    await v.load();
    v.cancel();
    v.cancel();
    expect(ducks).toEqual([]);
    // реплика за репликой: приглушение не отпускается между ними
    v.warmEvents('kind', ['dance'], { decode: 4 });
    await vi.advanceTimersByTimeAsync(2000);
    void v.speak(req('dance', 1));
    await vi.advanceTimersByTimeAsync(100);
    void v.speak(req('dance', 2)); // перебили следующей
    await vi.advanceTimersByTimeAsync(100);
    expect(ducks.filter((d) => !d).length).toBe(0);
    v.cancel();
    await vi.advanceTimersByTimeAsync(500);
    expect(ducks.at(-1)).toBe(false);
  });

  it('LRU: сжатые не больше RAW_CACHE_BYTES, декодированные — VOICE_CACHE_BYTES', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
    const { audio } = fakeAudio();
    const evs = Array.from({ length: 80 }, (_, i) => `ev${i}`);
    install(manifest(evs));
    const v = new VoicePlayer(audio as never);
    await v.load();
    v.warmEvents('kind', evs, { fetch: 4, decode: 1 });
    await vi.advanceTimersByTimeAsync(60_000);
    const st = v.cacheStats();
    expect(st.rawMb * 1048576).toBeLessThanOrEqual(RAW_CACHE_BYTES);
    expect(st.mb).toBeLessThanOrEqual(12);
    expect(st.rawEntries).toBeGreaterThan(200);
  });
});

describe('режиссёр: пузырь = голос', () => {
  let h: Awaited<ReturnType<typeof makeDirector>> | null = null;
  afterEach(() => {
    h?.done();
    h = null;
  });

  it('пузырь показан в момент старта звука, не раньше; запись не готова — реакция ждёт её ≤ 300 мс', async () => {
    h = await makeDirector({ memory: { met: true, name: 'Маша', persona: 'hooligan', visits: 3 } });
    await h.boot();
    await h.until(() => !h!.d.queue.busy);
    const v = h.voice as typeof h.voice & { startHook?: boolean; isWarm?: () => boolean; warmLine?: () => Promise<void> };
    const LOAD = 180;
    const starts: number[] = [];
    v.startHook = true;
    v.isWarm = () => false;
    v.warmLine = () => new Promise((r) => setTimeout(r, LOAD));
    const speak = v.speak.bind(v);
    v.speak = (async (r: { lineId?: string; text: string; template: string }, hooks?: { onStart?: () => void }) => {
      // запись уже «готова» (warmLine) — звук через 20 мс
      setTimeout(() => {
        starts.push(h!.T());
        hooks?.onStart?.();
      }, 20);
      return speak(r);
    }) as typeof v.speak;
    const b0 = h.bubble.length, c0 = h.clips.length;
    const t0 = h.T();
    h.d.action('dance');
    await h.tick(3000);
    const shown = h.bubble.slice(b0).filter((b) => b.on);
    expect(shown.length).toBeGreaterThan(0);
    expect(starts.length).toBeGreaterThan(0);
    // пузырь — не раньше звука и не позже чем через кадр
    expect(shown[0].t).toBeGreaterThanOrEqual(starts[0]);
    expect(shown[0].t - starts[0]).toBeLessThanOrEqual(0.1);
    // и звук, и пузырь — не позже 0,3 с + старт после нажатия
    expect(starts[0] - t0).toBeLessThanOrEqual(0.5);
    expect(h.clips.length).toBeGreaterThan(c0);
  });
});

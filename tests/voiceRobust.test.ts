/**
 * Озвучка не вешает сценарий (iPhone 22.11, показ в офисе: «со звуком опять проблемы — зависал и не грузился»).
 * VoicePlayer на фейковом Web Audio: сеть висит / 404 / decodeAudioData не отвечает / контекст «interrupted» и не
 * просыпается / часы контекста стоят посреди реплики — в каждом случае пузырь показывается (onStart), speak завершается
 * за длину реплики, причина — в timings. Фон: придержан до посадки кота, только текущий кот, медленная сеть — по одному.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { VoicePlayer, VOICE_START_TIMEOUT_MS, STALL_CHECK_MS } from '../src/voice/voicePlayer';

type Mode = 'ok' | 'hang' | '404';
function fakeAudio(o: { state?: string; frozen?: boolean; decodeHang?: boolean; resumeHang?: boolean } = {}) {
  const started: number[] = [];
  const frozenAt = performance.now() / 1000;
  const ctx = {
    get currentTime() {
      return o.frozen ? frozenAt : performance.now() / 1000;
    },
    state: o.state ?? 'running',
    sampleRate: 48000,
    baseLatency: 0.01,
    outputLatency: 0.02,
    resume: vi.fn(() => (o.resumeHang ? new Promise<void>(() => {}) : new Promise<void>((r) => setTimeout(() => ((ctx.state = 'running'), r()), 30)))),
    decodeAudioData: () =>
      o.decodeHang ? new Promise(() => {}) : new Promise((r) => setTimeout(() => r({ length: 96000, numberOfChannels: 1, sampleRate: 48000, duration: 2, getChannelData: () => new Float32Array(4800) }), 40)),
    createGain: () => ({ gain: { value: 1, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {} }),
    createBufferSource() {
      const s = {
        buffer: null as unknown,
        onended: null as null | (() => void),
        connect() {},
        disconnect() {},
        start() {
          started.push(performance.now());
          // часы стоят — onended не придёт никогда (как на iPhone при «interrupted» посреди реплики)
          if (!o.frozen) setTimeout(() => s.onended?.(), 2000);
        },
        stop() {
          if (!o.frozen) setTimeout(() => s.onended?.(), 0);
        },
      };
      return s;
    },
  };
  return { audio: { ctx, voiceOut: () => ({}), duck: () => undefined }, ctx, started };
}

function manifest(events: string[], persona = 'kind', hash = 'a') {
  const lines: Record<string, unknown> = {};
  for (const ev of events) for (let i = 1; i <= 4; i++) lines[`${persona}.${ev}.0${i}`] = { f: `el/${persona}/${ev}.0${i}.${hash}.mp3`, d: 2, o: 0, c: 'X0', t: `${ev} ${i}` };
  return { lines, templates: {} };
}

function install(getMan: () => object, mode: (url: string) => Mode = () => 'ok', fetchMs = 220) {
  const fetched: string[] = [];
  let maxPar = 0, par = 0;
  globalThis.fetch = vi.fn(async (u: string) => {
    const url = String(u);
    if (url.endsWith('voice/el/manifest.json')) return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => getMan() } as unknown as Response;
    fetched.push(url);
    const m = mode(url);
    if (m === 'hang') return new Promise<Response>(() => {});
    par++;
    maxPar = Math.max(maxPar, par);
    await new Promise((r) => setTimeout(r, fetchMs));
    par--;
    if (m === '404') return { ok: false, status: 404 } as unknown as Response;
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(25_000) } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetched, maxPar: () => maxPar };
}

const req = (ev: string, i: number) => ({ persona: 'kind', template: `${ev} ${i}`, text: `${ev} ${i}`, pitch: 1, rate: 1, lineId: `kind.${ev}.0${i}` });
const FAKE: Parameters<typeof vi.useFakeTimers>[0] = { toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] };

/** speak: когда показан пузырь (onStart) и когда завершился — мс от вызова */
async function timed(v: VoicePlayer, r: ReturnType<typeof req>, budget = 8000) {
  const t0 = performance.now();
  let startAt = -1, endAt = -1;
  const p = v.speak(r, { onStart: () => (startAt = performance.now() - t0) }).then(() => (endAt = performance.now() - t0));
  for (let t = 0; t < budget && endAt < 0; t += 100) await vi.advanceTimersByTimeAsync(100);
  void p;
  return { startAt, endAt };
}

describe('VoicePlayer: ни один звук не вешает сценарий', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = realFetch;
  });

  it('сеть висит: пузырь без звука ≤ VOICE_START_TIMEOUT_MS, speak — за длину реплики; причина net_slow', async () => {
    vi.useFakeTimers(FAKE);
    const { audio, started } = fakeAudio();
    install(() => manifest(['dance']), () => 'hang');
    const v = new VoicePlayer(audio as never);
    await v.load();
    const r = await timed(v, req('dance', 1));
    expect(r.startAt).toBeGreaterThan(0);
    expect(r.startAt).toBeLessThanOrEqual(VOICE_START_TIMEOUT_MS + 50);
    expect(r.endAt).toBeGreaterThan(0);
    expect(r.endAt).toBeLessThanOrEqual(VOICE_START_TIMEOUT_MS + 2000 + 300);
    expect(started.length).toBe(0);
    const t = v.timings.at(-1)!;
    expect(t.outcome).toBe('silent');
    expect(t.reason).toBe('net_slow');
    expect(v.last?.source).toBe('silent:net_slow');
    // запрос оборван по таймауту — следующая реплика с тем же файлом знает причину
    await vi.advanceTimersByTimeAsync(8000);
    const r2 = await timed(v, req('dance', 1));
    expect(r2.startAt).toBeLessThanOrEqual(VOICE_START_TIMEOUT_MS + 50);
    expect(r2.endAt).toBeGreaterThan(0);
  });

  it('404 (манифест старше файлов после пересборки): манифест перечитан, звучит новый файл в ту же реплику', async () => {
    vi.useFakeTimers(FAKE);
    const { audio, started } = fakeAudio();
    let hash = 'old';
    const { fetched } = install(() => manifest(['dance'], 'kind', hash), (u) => (u.includes('.old.') ? '404' : 'ok'), 150);
    const v = new VoicePlayer(audio as never);
    await v.load();
    hash = 'new'; // на сервере уже новая сборка
    const r = await timed(v, req('dance', 1));
    expect(fetched.some((u) => u.includes('.old.'))).toBe(true);
    expect(fetched.some((u) => u.includes('.new.'))).toBe(true);
    expect(started.length).toBe(1);
    expect(v.timings.at(-1)!.outcome).toBe('ok');
    expect(r.startAt).toBeLessThan(VOICE_START_TIMEOUT_MS);
  });

  it('404 и нового файла нет: пузырь без звука, причина http_404, сценарий идёт', async () => {
    vi.useFakeTimers(FAKE);
    const { audio } = fakeAudio();
    install(() => manifest(['dance']), () => '404', 100);
    const v = new VoicePlayer(audio as never);
    await v.load();
    const r = await timed(v, req('dance', 2));
    expect(r.startAt).toBeGreaterThan(0);
    expect(r.endAt).toBeGreaterThan(0);
    expect(v.timings.at(-1)!.reason).toBe('http_404');
  });

  it('decodeAudioData не отвечает: пузырь без звука, speak завершается', async () => {
    vi.useFakeTimers(FAKE);
    const { audio } = fakeAudio({ decodeHang: true });
    install(() => manifest(['dance']));
    const v = new VoicePlayer(audio as never);
    await v.load();
    const r = await timed(v, req('dance', 1));
    expect(r.startAt).toBeLessThanOrEqual(VOICE_START_TIMEOUT_MS + 50);
    expect(r.endAt).toBeGreaterThan(0);
    expect(v.timings.at(-1)!.reason).toBe('decode_slow');
  });

  it('контекст «interrupted» и resume не отвечает (iOS вне жеста): пузырь без звука, причина ctx_interrupted, будим дальше', async () => {
    vi.useFakeTimers(FAKE);
    const { audio, ctx, started } = fakeAudio({ state: 'interrupted', resumeHang: true });
    install(() => manifest(['dance']));
    const v = new VoicePlayer(audio as never);
    await v.load();
    const r = await timed(v, req('dance', 1));
    expect(r.startAt).toBeGreaterThan(0);
    expect(r.endAt).toBeGreaterThan(0);
    expect(started.length).toBe(0);
    expect(v.timings.at(-1)!.reason).toBe('ctx_interrupted');
    const n = ctx.resume.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(ctx.resume.mock.calls.length).toBeGreaterThan(n);
  });

  it('часы контекста встали посреди реплики (onended не придёт): остаток молча, speak завершается', async () => {
    vi.useFakeTimers(FAKE);
    const { audio, started } = fakeAudio({ frozen: true });
    install(() => manifest(['dance']));
    const v = new VoicePlayer(audio as never);
    await v.load();
    const r = await timed(v, req('dance', 1));
    expect(started.length).toBe(1);
    expect(r.startAt).toBeGreaterThan(0);
    expect(r.endAt).toBeGreaterThan(STALL_CHECK_MS);
    expect(r.endAt).toBeLessThan(4500);
    expect(v.speaking).toBe(false);
  });

  it('cancel, пока реплика ждёт hold (ребёнок говорит): speak выходит сразу, а не через 8 с', async () => {
    vi.useFakeTimers(FAKE);
    const { audio } = fakeAudio();
    install(() => manifest(['dance']));
    const v = new VoicePlayer(audio as never);
    await v.load();
    v.hold(8000);
    let done = false;
    void v.speak(req('dance', 1)).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(100);
    v.cancel();
    await vi.advanceTimersByTimeAsync(50);
    expect(done).toBe(true);
  });
});

describe('VoicePlayer: фоновая докачка', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = realFetch;
  });

  it('придержана до посадки кота; сначала первые варианты всех событий; смена кота — очередь прежнего прочь', async () => {
    vi.useFakeTimers(FAKE);
    const { audio } = fakeAudio();
    const evs = ['dance', 'flip', 'stroke'];
    const { fetched, maxPar } = install(() => ({ lines: { ...manifest(evs).lines, ...manifest(evs, 'glitter').lines }, templates: {} }));
    const v = new VoicePlayer(audio as never);
    await v.load();
    v.holdBackground(true);
    v.warmEvents('kind', evs, { fetch: 4, decode: 0 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetched.length).toBe(0);
    v.holdBackground(false);
    await vi.advanceTimersByTimeAsync(250);
    // первые варианты — первыми
    expect(fetched.slice(0, 2).every((u) => /\.01\./.test(u))).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    v.warmEvents('glitter', ['dance'], { fetch: 4, decode: 0 });
    await vi.advanceTimersByTimeAsync(5000);
    const after = fetched.filter((u) => u.includes('/kind/'));
    expect(after.length).toBeLessThan(evs.length * 4); // докачка прежнего кота оборвана
    expect(fetched.filter((u) => u.includes('/glitter/')).length).toBe(4);
    expect(maxPar()).toBeLessThanOrEqual(2);
  });

  it('медленная сеть: по одному запросу и только первые два варианта события', async () => {
    vi.useFakeTimers(FAKE);
    const { audio } = fakeAudio();
    const evs = ['dance', 'flip'];
    const { fetched, maxPar } = install(() => manifest(evs), () => 'ok', 1800);
    const v = new VoicePlayer(audio as never);
    await v.load();
    v.warmEvents('kind', evs, { fetch: 4, decode: 0 });
    await vi.advanceTimersByTimeAsync(30_000);
    // первые два запроса ушли параллельно (сеть ещё не измерена), дальше — по одному и без 3-х/4-х вариантов
    expect(maxPar()).toBeLessThanOrEqual(2);
    expect(fetched.filter((u) => /\.0[34]\./.test(u)).length).toBe(0);
  });

  it('реплика «сейчас» идёт мимо фона, фон ждёт её', async () => {
    vi.useFakeTimers(FAKE);
    const { audio, started } = fakeAudio();
    const evs = Array.from({ length: 10 }, (_, i) => `ev${i}`);
    const { fetched } = install(() => manifest([...evs, 'dance']));
    const v = new VoicePlayer(audio as never);
    await v.load();
    v.warmEvents('kind', evs, { fetch: 4, decode: 0 });
    await vi.advanceTimersByTimeAsync(10);
    const r = await timed(v, req('dance', 3), 600);
    expect(started.length).toBe(1);
    expect(r.startAt).toBeLessThan(600);
    expect(fetched.some((u) => u.includes('dance.03'))).toBe(true);
  });
});

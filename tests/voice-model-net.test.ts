import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VoskAsr, checkModel, fetchModelWithProgress } from '../src/voice/asr';
import type { MicInput } from '../src/voice/mic';

/**
 * VOX-01 (аудит пилота 24.11): загрузка модели Vosk висела на HEAD, на заголовках GET и на чтении тела — без
 * AbortSignal статус оставался «loading» навсегда. OPT-01: prefetch / preload / первая команда — одна загрузка архива,
 * отмена при запрете микрофона.
 */
vi.mock('vosk-browser', () => ({ createModel: async () => ({ KaldiRecognizer: class {} }) }));

const mic = { supported: true, asrRate: 16000, level: 0, error: null, acquire: () => Promise.resolve(true), release: () => {}, on: () => () => {} } as unknown as MicInput;
const NET = { headMs: 40, getMs: 40, stallMs: 40 };
const archiveHeaders = { 'content-type': 'application/gzip', 'content-length': '2000000' };
/** тело, которое отдаёт кусок и замирает; cancel() отмечается */
function stallBody(state: { cancelled: boolean }) {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(1000));
    },
    cancel() {
      state.cancelled = true;
    },
  });
}
const never = () => new Promise<Response>(() => undefined);

describe('модель Vosk: сетевые дедлайны (VOX-01)', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('location', { href: 'https://ar.vershov.com/mvp/' });
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('HEAD не отвечает — checkModel сдаётся по дедлайну, запрос отменён сигналом', async () => {
    let sig: AbortSignal | undefined;
    const f = ((_u: string, init?: RequestInit) => ((sig = init?.signal ?? undefined), never())) as typeof fetch;
    const r = await checkModel('models/x.tar.gz', f, { headMs: 30 });
    expect(r).toEqual({ ok: false, why: 'no-model timeout head' });
    expect(sig?.aborted).toBe(true);
  });

  it('GET без заголовков и тело без байтов — ошибка по дедлайну, reader отпущен', async () => {
    await expect(fetchModelWithProgress('models/x.tar.gz', () => {}, { fetch: never as unknown as typeof fetch, getMs: 30 })).rejects.toThrow('no-model timeout get');
    const st = { cancelled: false };
    const f = (() => Promise.resolve(new Response(stallBody(st), { status: 200, headers: archiveHeaders }))) as unknown as typeof fetch;
    const prog: number[] = [];
    await expect(fetchModelWithProgress('models/x.tar.gz', (p) => prog.push(p), { fetch: f, stallMs: 30 })).rejects.toThrow('no-model timeout body');
    expect(prog.length).toBeGreaterThan(0);
    expect(st.cancelled).toBe(true);
    // HTML вместо архива на GET — не «скачали»
    const html = (() => Promise.resolve(new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }))) as unknown as typeof fetch;
    await expect(fetchModelWithProgress('models/x.tar.gz', () => {}, { fetch: html })).rejects.toThrow('no-model html');
  });

  for (const stage of ['head', 'get', 'body'] as const) {
    it(`зависание на ${stage}: prefetch → error (не loading навсегда); модель вернулась — повтор доходит до готовности`, async () => {
      let now = 1000;
      vi.spyOn(performance, 'now').mockImplementation(() => now);
      let healthy = false;
      const st = { cancelled: false };
      const calls: string[] = [];
      const f = ((_u: string, init?: RequestInit) => {
        const m = init?.method ?? 'GET';
        calls.push(m);
        if (healthy) return Promise.resolve(new Response(m === 'HEAD' ? null : new Uint8Array(2000), { status: 200, headers: archiveHeaders }));
        if (m === 'HEAD') return stage === 'head' ? never() : Promise.resolve(new Response(null, { status: 200, headers: archiveHeaders }));
        if (stage === 'get') return never();
        return Promise.resolve(new Response(stallBody(st), { status: 200, headers: archiveHeaders }));
      }) as typeof fetch;
      const asr = new VoskAsr(mic);
      asr.net = { ...NET, fetch: f };
      const states: string[] = [];
      asr.onState = (s, m) => states.push(m ? `${s}:${m}` : s);
      const t0 = Date.now();
      expect(await asr.prefetch()).toBe(false);
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(states[0]).toBe('loading');
      expect(states.at(-1)).toMatch(new RegExp(`^error:no-model timeout ${stage}`));
      expect(asr.health).toBe('down');
      if (stage === 'body') expect(st.cancelled).toBe(true);
      // повтор после паузы и восстановления модели: готово, прежний запрос не висит
      healthy = true;
      now += 60_000;
      expect(await asr.preload()).toBe(true);
      expect(asr.ready).toBe(true);
      expect(asr.health).toBe('ok');
      expect(states.at(-1)).toBe('idle');
    });
  }
});

describe('модель Vosk: одна загрузка на всех (OPT-01)', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('location', { href: 'https://ar.vershov.com/mvp/' });
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('prefetch + preload + первая команда одновременно — один HEAD и один GET архива', async () => {
    const calls: string[] = [];
    const f = ((_u: string, init?: RequestInit) => {
      calls.push(init?.method ?? 'GET');
      return new Promise<Response>((r) => setTimeout(() => r(new Response(init?.method === 'HEAD' ? null : new Uint8Array(4000), { status: 200, headers: archiveHeaders })), 10));
    }) as typeof fetch;
    const asr = new VoskAsr(mic);
    asr.net = { ...NET, getMs: 2000, stallMs: 2000, headMs: 2000, fetch: f };
    const [a, b, c] = await Promise.all([asr.prefetch(), asr.preload(), asr.preload()]);
    expect([a, b, c]).toEqual([true, true, true]);
    expect(calls).toEqual(['HEAD', 'GET']);
    // уже готово: ни запроса
    expect(await asr.prefetch()).toBe(true);
    expect(await asr.preload()).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('prefetch, потом (после посадки) preload — архив не перекачивается', async () => {
    const calls: string[] = [];
    const f = ((_u: string, init?: RequestInit) => (calls.push(init?.method ?? 'GET'), Promise.resolve(new Response(init?.method === 'HEAD' ? null : new Uint8Array(10), { status: 200, headers: archiveHeaders })))) as typeof fetch;
    const asr = new VoskAsr(mic);
    asr.net = { ...NET, fetch: f };
    expect(await asr.prefetch()).toBe(true);
    expect(await asr.preload()).toBe(true);
    expect(calls).toEqual(['HEAD', 'GET']);
  });

  it('cancel() (микрофон запретили) — загрузка прервана, без ошибки и без засчитанной попытки', async () => {
    const st = { cancelled: false };
    let sig: AbortSignal | undefined;
    const f = ((_u: string, init?: RequestInit) => {
      if (init?.method === 'HEAD') return Promise.resolve(new Response(null, { status: 200, headers: archiveHeaders }));
      sig = init?.signal ?? undefined;
      return Promise.resolve(new Response(stallBody(st), { status: 200, headers: archiveHeaders }));
    }) as typeof fetch;
    const asr = new VoskAsr(mic);
    asr.net = { headMs: 5000, getMs: 5000, stallMs: 5000, fetch: f };
    const states: string[] = [];
    asr.onState = (s, m) => states.push(m ? `${s}:${m}` : s);
    const p = asr.prefetch();
    const q = asr.preload();
    await new Promise((r) => setTimeout(r, 20));
    asr.cancel();
    expect(await p).toBe(false);
    expect(await q).toBe(false);
    expect(sig?.aborted).toBe(true);
    expect(st.cancelled).toBe(true);
    expect(states.some((s) => s.startsWith('error'))).toBe(false);
    expect(states.at(-1)).toBe('idle');
    expect(asr.health).toBe('unknown');
    expect(asr.unavailable).toBe(false);
  });
});

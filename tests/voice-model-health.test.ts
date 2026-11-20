import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VoskAsr, checkModel, MODEL_MAX_ATTEMPTS, MODEL_RETRY_MS } from '../src/voice/asr';
import type { MicInput } from '../src/voice/mic';

/**
 * P0-2 (аудит голоса 20.11): модели Vosk нет на сервере → раньше архив 45 МБ перезапрашивался на каждую фразу
 * (15 раз за минуту). Теперь: health-проверка HEAD, не больше MODEL_MAX_ATTEMPTS попыток за сессию с паузой.
 */
const mic = { supported: true, asrRate: 16000, level: 0, error: null, acquire: () => Promise.resolve(true), release: () => {}, on: () => () => {} } as unknown as MicInput;

describe('модель Vosk: health и попытки', () => {
  let calls: { url: string; method: string }[];
  let now = 1000;
  const store = new Map<string, string>();
  beforeEach(() => {
    calls = [];
    now = 1000;
    store.clear();
    vi.stubGlobal('location', { href: 'https://ar.vershov.com/mvp/' });
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET' });
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    vi.spyOn(performance, 'now').mockImplementation(() => now);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('HEAD 404 / HTML вместо архива / маленький файл — модели нет', async () => {
    expect((await checkModel('models/x.tar.gz')).ok).toBe(false);
    const html = () => Promise.resolve(new Response('', { status: 200, headers: { 'content-type': 'text/html' } }));
    expect(await checkModel('models/x.tar.gz', html as typeof fetch)).toMatchObject({ ok: false, why: 'no-model html' });
    const tiny = () => Promise.resolve(new Response('', { status: 200, headers: { 'content-type': 'application/gzip', 'content-length': '512' } }));
    expect((await checkModel('models/x.tar.gz', tiny as typeof fetch)).ok).toBe(false);
    const ok = () => Promise.resolve(new Response('', { status: 200, headers: { 'content-type': 'application/gzip', 'content-length': '46000000' } }));
    expect((await checkModel('models/x.tar.gz', ok as typeof fetch)).ok).toBe(true);
  });

  it('нет модели: одно сообщение об ошибке, 2 попытки за сессию с паузой, архив (GET) не качается, start() не грузит', async () => {
    const asr = new VoskAsr(mic);
    const states: string[] = [];
    asr.onState = (s, m) => states.push(`${s}${m ? ':' + m : ''}`);
    expect(await asr.preload()).toBe(false);
    expect(asr.health).toBe('down');
    expect(asr.unavailable).toBe(true);
    // сразу снова (каждая фраза в «слушаю всегда») — без запросов
    for (let i = 0; i < 15; i++) {
      expect(await asr.preload()).toBe(false);
      await asr.start();
    }
    expect(calls).toHaveLength(1);
    now += MODEL_RETRY_MS + 1;
    expect(asr.unavailable).toBe(false);
    expect(await asr.preload()).toBe(false);
    expect(asr.health).toBe('dead');
    now += MODEL_RETRY_MS * 10;
    for (let i = 0; i < 5; i++) expect(await asr.preload()).toBe(false);
    expect(asr.unavailable).toBe(true);
    expect(calls).toHaveLength(MODEL_MAX_ATTEMPTS);
    expect(calls.every((c) => c.method === 'HEAD')).toBe(true);
    expect(states.filter((s) => s.startsWith('error')).length).toBe(MODEL_MAX_ATTEMPTS);
    expect(states.find((s) => s.startsWith('error'))).toMatch(/no-model/);
  });

  it('prefetch (с жеста) и preload (после посадки) — одна попытка, а не две', async () => {
    const asr = new VoskAsr(mic);
    const a = asr.prefetch();
    const b = asr.preload();
    expect(await a).toBe(false);
    expect(await b).toBe(false);
    expect(calls).toHaveLength(1);
    expect(asr.health).toBe('down');
  });
});

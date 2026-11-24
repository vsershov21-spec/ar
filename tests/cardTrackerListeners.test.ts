// @vitest-environment jsdom
/**
 * AR-04 (независимый аудит 24.11): каждый цикл «Мой дом» → «На карту» (CardTracker.stop → startVideo → start)
 * добавлял на document ещё один слушатель visibilitychange (5 → 6 → 7 → 8). Теперь он живёт, пока живёт камера
 * трекера (AbortController, снимается в stop): после 10 циклов — столько же, сколько после первого входа; дома — 0
 * живых видеодорожек и воркеров карты.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CardTracker } from '../src/tracker/cardTracker';

class FakeTrack {
  readyState: 'live' | 'ended' = 'live';
  muted = false;
  onended: (() => void) | null = null;
  constructor(readonly kind: 'video' | 'audio', private reg: FakeTrack[]) {
    reg.push(this);
  }
  stop() {
    this.readyState = 'ended';
  }
  get live() {
    return this.readyState === 'live' && this.reg.includes(this);
  }
}

describe('AR-04: CardTracker — слушатели и камера по циклам дом ↔ карта', () => {
  const tracks: FakeTrack[] = [];
  const workers: { terminated: boolean }[] = [];
  /** живые слушатели visibilitychange на document (с учётом AbortSignal) */
  let vis = 0;
  const origAdd = document.addEventListener.bind(document);
  const origRemove = document.removeEventListener.bind(document);

  beforeEach(() => {
    tracks.length = 0;
    workers.length = 0;
    vis = 0;
    vi.spyOn(document, 'addEventListener').mockImplementation((type: string, fn: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions) => {
      if (type === 'visibilitychange') {
        const sig = typeof opts === 'object' ? opts.signal : undefined;
        if (!sig?.aborted) {
          vis++;
          sig?.addEventListener('abort', () => vis--, { once: true });
        }
      }
      origAdd(type, fn, opts);
    });
    vi.spyOn(document, 'removeEventListener').mockImplementation((type: string, fn: EventListenerOrEventListenerObject, opts?: boolean | EventListenerOptions) => {
      if (type === 'visibilitychange') vis--;
      origRemove(type, fn, opts);
    });
    const gum = vi.fn(async (c: MediaStreamConstraints) => {
      const t: FakeTrack[] = [new FakeTrack('video', tracks)];
      if (c.audio) t.push(new FakeTrack('audio', tracks));
      return { getTracks: () => t, getVideoTracks: () => t.filter((x) => x.kind === 'video'), getAudioTracks: () => t.filter((x) => x.kind === 'audio') };
    });
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: gum }, configurable: true });
    vi.stubGlobal('MediaStream', class {
      constructor(private t: FakeTrack[] = []) {}
      getTracks() {
        return this.t;
      }
      getVideoTracks() {
        return this.t.filter((x) => x.kind === 'video');
      }
      getAudioTracks() {
        return this.t.filter((x) => x.kind === 'audio');
      }
    });
    vi.stubGlobal('Worker', class {
      onmessage: unknown = null;
      onerror: unknown = null;
      rec = { terminated: false };
      constructor() {
        workers.push(this.rec);
      }
      postMessage() {}
      terminate() {
        this.rec.terminated = true;
      }
    });
    vi.stubGlobal('requestAnimationFrame', () => 0);
    // new URL('./card/worker.ts', import.meta.url): в jsdom база модуля — не URL; адрес воркера здесь не важен
    const RealURL = URL;
    vi.stubGlobal('URL', class extends RealURL {
      constructor(u: string | URL, b?: string | URL) {
        try {
          super(u, b);
        } catch {
          super(String(u), 'http://localhost/');
        }
      }
    });
    // <video>: srcObject → loadedmetadata, play — без настоящего медиа
    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
      configurable: true,
      get(this: HTMLMediaElement & { _so?: unknown }) {
        return this._so ?? null;
      },
      set(this: HTMLMediaElement & { _so?: unknown }, v: unknown) {
        this._so = v;
        queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata')));
      },
    });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    // 2D-контекст: любые вызовы — пустые (рисование подсказок здесь не проверяем)
    const ctx2d = new Proxy({}, { get: (_t, k) => (k === 'canvas' ? document.createElement('canvas') : () => undefined), set: () => true });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx2d as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('10 циклов: слушателей visibilitychange — как после первого входа, дома 0 дорожек видео и воркеров', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const tr = new CardTracker(root);
    const liveVideo = () => tracks.filter((t) => t.kind === 'video' && t.readyState === 'live').length;
    const liveWorkers = () => workers.filter((w) => !w.terminated).length;
    await tr.startVideo();
    await tr.start();
    const first = vis;
    expect(first).toBe(1);
    expect(liveVideo()).toBe(1);
    expect(liveWorkers()).toBe(1);
    for (let k = 0; k < 10; k++) {
      tr.stop(); // «Мой дом»
      expect(vis).toBe(0);
      expect(liveVideo()).toBe(0);
      expect(liveWorkers()).toBe(0);
      await tr.startVideo(); // «На карту» — из жеста
      await tr.start();
      expect(vis).toBe(first);
      expect(liveVideo()).toBe(1);
      expect(liveWorkers()).toBe(1);
    }
    tr.stop();
    expect(vis).toBe(0);
  });
});

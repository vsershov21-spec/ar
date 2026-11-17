/**
 * Распознавание речи — интерфейс Asr и два движка:
 *  - VoskAsr (ПО УМОЛЧАНИЮ): vosk-browser (Kaldi в WebAssembly), маленькая русская модель — полностью офлайн,
 *    звук не покидает телефон. Словарь ограничен грамматикой (фразы intents.ru.json + имена) — точнее
 *    на детской речи и не «додумывает» лишнего. ?grammar=0 — свободный словарь (для отладки).
 *    Модель (~45 МБ) грузится лениво при первом нажатии микрофона, с прогрессом; кладётся в Cache Storage.
 *  - WebSpeechAsr (только ?asr=web): webkitSpeechRecognition. В Chrome звук уходит на серверы Google —
 *    на пилоте с детьми нельзя, поэтому только по флагу.
 * Звук для Vosk берётся из общего MicInput (тот же поток, что VAD/громкость/повтор) — уже 16 кГц и в шкале int16
 * (пересчитан в AudioWorklet, micDsp.ts): в воркер Vosk уходит как есть, главный поток его не трогает.
 * Сам Kaldi работает в своём воркере (vosk-browser) и получает звук только пока идёт фраза (VAD / окно ответа).
 */
import { asset } from '../core/util';
import type { MicInput } from './mic';
import { perf } from '../core/perf';

export type AsrState = 'idle' | 'loading' | 'listening' | 'error';

export interface Asr {
  readonly name: string;
  readonly supported: boolean;
  /** preroll — начало фразы (16 кГц ×32768, как MicChunk.asr) */
  start(preroll?: Float32Array[]): void;
  stop(): void;
  /** прервать без результата */
  abort(): void;
  /** не кормить распознаватель (кот говорит) — звук игнорируется */
  paused: boolean;
  onResult: (text: string) => void;
  onInterim: (text: string) => void;
  onState: (s: AsrState, msg?: string) => void;
  /** уровень сигнала 0..1 (если движок даёт доступ к звуку) */
  onLevel: (v: number) => void;
  /** прогресс загрузки модели 0..1 */
  onProgress: (p: number) => void;
  /** заранее загрузить модель (без микрофона) */
  preload?(): Promise<boolean>;
  setGrammar?(phrases: string[] | null): void;
  /** сколько слов вне грамматики ([unk]) было в последней фразе — «речь есть, но не из словаря» */
  lastUnk?: number;
  /**
   * Энергия: звук в распознаватель — только пока gate() true (в окне ответа — пока в микрофоне есть голос);
   * тишина копится в кольце 400 мс и уходит перед началом фразы. null — всё подряд (кнопка, VAD-фраза).
   */
  gate?: (() => boolean) | null;
}

const MAX_HOLD_MS = 8000;

export class WebSpeechAsr implements Asr {
  readonly name = 'webspeech';
  private rec: any = null;
  private active = false;
  private finalText = '';
  private lastInterim = '';
  private timer = 0;
  private aborted = false;
  paused = false;
  onResult = (_: string) => {};
  onInterim = (_: string) => {};
  onState = (_: AsrState, _m?: string) => {};
  onLevel = (_: number) => {};
  onProgress = (_: number) => {};

  get supported() {
    return typeof window !== 'undefined' && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
  }

  start() {
    if (!this.supported || this.active) return;
    const C = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const rec = new C();
    rec.lang = 'ru-RU';
    rec.interimResults = true;
    rec.continuous = true;
    rec.maxAlternatives = 1;
    this.finalText = '';
    this.lastInterim = '';
    this.aborted = false;
    rec.onresult = (e: any) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) this.finalText += r[0].transcript + ' ';
        else interim += r[0].transcript;
      }
      this.lastInterim = (this.finalText + interim).trim();
      this.onInterim(this.lastInterim);
      this.onLevel(0.6 + Math.random() * 0.4); // у Web Speech нет доступа к звуку — индикатор «слышу»
    };
    rec.onspeechstart = () => this.onLevel(0.5);
    rec.onerror = (e: any) => this.onState('error', e.error);
    rec.onend = () => {
      clearTimeout(this.timer);
      const text = this.finalText.trim() || this.lastInterim;
      this.active = false;
      this.onLevel(0);
      this.onState('idle');
      if (text && !this.aborted && !this.paused) this.onResult(text);
    };
    this.rec = rec;
    this.active = true;
    try {
      rec.start();
      this.onState('listening');
      this.timer = window.setTimeout(() => this.stop(), MAX_HOLD_MS);
    } catch (err) {
      this.active = false;
      this.onState('error', String(err));
    }
  }

  stop() {
    try {
      this.rec?.stop();
    } catch {
      /* ignore */
    }
  }

  abort() {
    this.aborted = true;
    this.stop();
  }
}

export const VOSK_MODEL_URL = 'models/vosk-ru-small-0.22/model.tar.gz';
const CACHE = 'ar-cat-vosk-v1';

/** Скачать модель с прогрессом и положить в Cache Storage (повторно — из кэша, без сети) */
export async function fetchModelWithProgress(url: string, onProgress: (p: number) => void): Promise<boolean> {
  const full = new URL(asset(url), location.href).href;
  let cache: Cache | null = null;
  try {
    cache = await caches.open(CACHE);
    const hit = await cache.match(full);
    if (hit) {
      onProgress(1);
      return true;
    }
  } catch {
    cache = null; // Cache Storage недоступен (http, приватный режим) — просто качаем
  }
  const r = await fetch(full);
  if (!r.ok) throw new Error(`no-model ${r.status}`);
  const total = Number(r.headers.get('content-length') || 0) || 46_000_000;
  if (!r.body) {
    const b = await r.blob();
    await cache?.put(full, new Response(b, { headers: r.headers })).catch(() => undefined);
    onProgress(1);
    return true;
  }
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress(Math.min(0.99, got / total));
  }
  const blob = new Blob(chunks as BlobPart[], { type: r.headers.get('content-type') ?? 'application/gzip' });
  await cache?.put(full, new Response(blob, { headers: { 'content-type': blob.type, 'content-length': String(blob.size) } })).catch(() => undefined);
  onProgress(1);
  return true;
}

export class VoskAsr implements Asr {
  readonly name = 'vosk';
  private model: any = null;
  private loading: Promise<boolean> | null = null;
  private rec: any = null;
  private off: (() => void) | null = null;
  private partial = '';
  private final = '';
  private timer = 0;
  private listening = false;
  private aborted = false;
  private grammar: string[] | null = null;
  private unkFinal = 0;
  private unkPartial = 0;
  lastUnk = 0;
  paused = false;
  gate: (() => boolean) | null = null;
  private held: Float32Array[] = [];
  private heldLen = 0;
  onResult = (_: string) => {};
  onInterim = (_: string) => {};
  onState = (_: AsrState, _m?: string) => {};
  onLevel = (_: number) => {};
  onProgress = (_: number) => {};

  constructor(private mic: MicInput, private modelUrl = VOSK_MODEL_URL) {}

  get supported() {
    return this.mic.supported && typeof WebAssembly !== 'undefined';
  }

  setGrammar(phrases: string[] | null) {
    this.grammar = phrases;
  }

  preload(): Promise<boolean> {
    this.loading ??= (async () => {
      try {
        this.onState('loading');
        // модель (сеть или Cache Storage) и сам движок (≈2.4 МБ gzip) — параллельно
        const [, vosk] = await Promise.all([fetchModelWithProgress(this.modelUrl, (p) => this.onProgress(p)), import('vosk-browser')]);
        this.model = await vosk.createModel(new URL(asset(this.modelUrl), location.href).href);
        this.onState('idle');
        return true;
      } catch (e) {
        this.loading = null;
        this.onState('error', /no-model|404|fetch|load/i.test(String(e)) ? 'no-model' : String(e));
        return false;
      }
    })();
    return this.loading;
  }

  async start(preroll?: Float32Array[]) {
    if (this.listening) return;
    this.listening = true;
    this.aborted = false;
    this.final = '';
    this.partial = '';
    this.unkFinal = this.unkPartial = this.lastUnk = 0;
    const micOk = this.mic.acquire();
    const ok = await this.preload();
    if (!(await micOk) || !ok) {
      this.listening = false;
      this.mic.release();
      if (ok) this.onState('error', this.mic.error ?? 'mic');
      return;
    }
    if (!this.listening) {
      this.mic.release();
      return;
    }
    const sr = this.mic.asrRate;
    const rec = this.grammar ? new this.model.KaldiRecognizer(sr, JSON.stringify(this.grammar)) : new this.model.KaldiRecognizer(sr);
    rec.on('result', (m: any) => {
      const t: string = m.result?.text ?? '';
      this.unkFinal += (t.match(/\[unk\]/g) ?? []).length;
      this.unkPartial = 0;
      this.partial = ''; // итог сегмента пришёл — его частичный вариант не дублируем
      const clean = t.replace(/\[unk\]/g, '').trim();
      if (clean) this.final += clean + ' ';
    });
    rec.on('partialresult', (m: any) => {
      const raw: string = m.result?.partial ?? '';
      this.unkPartial = (raw.match(/\[unk\]/g) ?? []).length;
      this.partial = raw.replace(/\[unk\]/g, '').trim();
      this.onInterim((this.final + this.partial).trim());
    });
    this.rec = rec;
    for (const b of preroll ?? []) this.feed(rec, b, sr);
    this.held = [];
    this.heldLen = 0;
    this.off = this.mic.on((c) => {
      const buf = c.asr;
      this.onLevel(this.mic.level);
      if (this.paused) return;
      if (this.gate && !this.gate()) {
        // тишина: не будим распознаватель, держим последние 400 мс — начало фразы не потеряется
        this.held.push(buf);
        this.heldLen += buf.length;
        while (this.held.length > 1 && this.heldLen - this.held[0].length > sr * 0.4) this.heldLen -= this.held.shift()!.length;
        return;
      }
      if (this.held.length) {
        for (const b of this.held) this.feed(rec, b, sr);
        this.held = [];
        this.heldLen = 0;
      }
      this.feed(rec, buf, sr);
    });
    this.onState('listening');
    this.timer = window.setTimeout(() => this.stop(), MAX_HOLD_MS);
  }

  /**
   * Звук уже 16 кГц и ×32768: шлём в воркер Vosk напрямую (acceptWaveformFloat заново умножал бы каждый
   * отсчёт в главном потоке). Без передачи владения — тот же буфер лежит в кольце начала фразы.
   */
  private feed(rec: { id?: string; acceptWaveformFloat(b: Float32Array, sr: number): void }, buf: Float32Array, sr: number) {
    perf.count('asr');
    perf.count('asrSec', buf.length / sr);
    try {
      const m = this.model;
      if (rec.id && typeof m?.postMessage === 'function') m.postMessage({ action: 'audioChunk', data: buf, recognizerId: rec.id, sampleRate: sr });
      else rec.acceptWaveformFloat(buf.map((v) => v / 32768), sr);
    } catch {
      /* ignore */
    }
  }

  stop() {
    if (!this.listening) return;
    this.listening = false;
    clearTimeout(this.timer);
    // дать распознавателю дожевать хвост
    setTimeout(() => {
      try {
        this.rec?.retrieveFinalResult();
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        const text = (this.final + this.partial).replace(/\s+/g, ' ').trim();
        this.lastUnk = this.unkFinal + this.unkPartial;
        this.cleanup();
        this.onLevel(0);
        this.onState('idle');
        // пусто, но были слова вне грамматики — тоже результат: ребёнок что-то сказал (ответим «не понял»)
        if ((text || this.lastUnk) && !this.aborted) this.onResult(text);
      }, 250);
    }, 300);
  }

  abort() {
    this.aborted = true;
    this.stop();
  }

  /** модель уже в памяти (тогда recognizeOnce работает быстро) */
  get ready() {
    return !!this.model;
  }

  /** Разовое распознавание записи с маленькой грамматикой (стоп-слова в режиме повтора). null — модели нет. */
  recognizeOnce(pcm: Float32Array, sr: number, grammar: string[]): Promise<string | null> {
    if (!this.model) return Promise.resolve(null);
    return new Promise((resolve) => {
      const rec = new this.model.KaldiRecognizer(sr, JSON.stringify(grammar));
      let text = '';
      const done = () => {
        clearTimeout(t);
        try {
          rec.remove();
        } catch {
          /* ignore */
        }
        resolve(text.replace(/\[unk\]/g, '').trim() || null);
      };
      const t = setTimeout(done, 1500);
      rec.on('result', (m: any) => {
        text += ' ' + (m.result?.text ?? '');
        done();
      });
      for (let i = 0; i < pcm.length; i += 4096) rec.acceptWaveformFloat(pcm.subarray(i, i + 4096), sr);
      rec.retrieveFinalResult();
    });
  }

  private cleanup() {
    this.off?.();
    this.off = null;
    if (this.rec) this.mic.release();
    try {
      this.rec?.remove();
    } catch {
      /* ignore */
    }
    this.rec = null;
  }
}

/** ?asr=web — Web Speech (только по флагу), иначе Vosk */
export function makeAsr(kind: string | null, mic: MicInput): Asr {
  if (kind === 'web' || kind === 'webspeech') return new WebSpeechAsr();
  return new VoskAsr(mic);
}

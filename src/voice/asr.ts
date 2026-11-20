/**
 * Распознавание речи — интерфейс Asr и два движка:
 *  - VoskAsr (ПО УМОЛЧАНИЮ): vosk-browser (Kaldi в WebAssembly), маленькая русская модель — полностью офлайн,
 *    звук не покидает телефон. Словарь ограничен грамматикой (фразы intents.ru.json + имена) — точнее
 *    на детской речи и не «додумывает» лишнего. ?grammar=0 — свободный словарь (для отладки).
 *    Модель (~45 МБ) грузится лениво (через 3 с после «Разбудить» или при первом нажатии), с прогрессом;
 *    воркер vosk-browser хранит её распакованной в IndexedDB (повторно — без сети).
 *  - WebSpeechAsr (только ?asr=web): webkitSpeechRecognition. В Chrome звук уходит на серверы Google —
 *    на пилоте с детьми нельзя, поэтому только по флагу.
 * Звук для Vosk берётся из общего MicInput (тот же поток, что VAD/громкость/повтор) — уже 16 кГц и в шкале int16
 * (пересчитан в AudioWorklet, micDsp.ts): в воркер Vosk уходит как есть, главный поток его не трогает.
 * Сам Kaldi работает в своём воркере (vosk-browser) и получает звук только пока идёт фраза (VAD / окно ответа).
 */
import { asset } from '../core/util';
import type { MicInput } from './mic';
import { perf } from '../core/perf';
import { feature } from '../config/edition';

export type AsrState = 'idle' | 'loading' | 'listening' | 'error';
/**
 * Здоровье офлайн-модели: unknown — ещё не пробовали; ok — модель в памяти; down — попытка не удалась, следующая не
 * раньше RETRY_MS; dead — MAX_ATTEMPTS попыток за сессию не удались, больше не грузим (голос выключен до перезагрузки).
 */
export type ModelHealth = 'unknown' | 'loading' | 'ok' | 'down' | 'dead';
/** попыток загрузить модель за сессию (раньше — на каждую фразу: 15 запросов 45 МБ за минуту) */
export const MODEL_MAX_ATTEMPTS = 2;
/** пауза перед второй попыткой */
export const MODEL_RETRY_MS = 30_000;

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
  /** только скачать модель в HTTP-кэш (без распаковки в воркере): с жеста «Разбудить», пока ищем карту */
  prefetch?(): Promise<boolean>;
  /** здоровье модели (Vosk); у Web Speech — всегда ok */
  readonly health?: ModelHealth;
  /** модель готова: распознавание стартует сразу */
  readonly ready?: boolean;
  /** распознавание сейчас невозможно и запускать его не нужно (модели нет, ждём паузу перед повтором) */
  readonly unavailable?: boolean;
  /** уверенность распознавателя в слове последней фразы 0..1 (Vosk setWords); undefined — не знаем */
  wordConf?(word: string): number | undefined;
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
/** старый кэш (Cache Storage, 45 МБ копии архива) — больше не нужен: удаляем */
const OLD_CACHE = 'ar-cat-vosk-v1';
const READY_KEY = 'ar.vosk.ready';

/**
 * Прогресс загрузки модели для подсказки «Загружаю распознавание… N%».
 * Архив качает и распаковывает сам воркер Vosk (vosk-browser) и хранит распакованным в IndexedDB; этот запрос лишь
 * прогревает HTTP-кэш (/models — immutable, воркер берёт оттуда же) и считает байты. Раньше архив ещё и копился
 * в главном потоке (45 МБ кусков + 45 МБ Blob) и клался второй копией в Cache Storage, которую никто не читал.
 * Модель уже разворачивалась на этом телефоне (метка в localStorage) — не качаем вовсе.
 */
export async function fetchModelWithProgress(url: string, onProgress: (p: number) => void): Promise<boolean> {
  const full = new URL(asset(url), location.href).href;
  void globalThis.caches?.delete(OLD_CACHE).catch(() => undefined);
  try {
    if (localStorage.getItem(READY_KEY) === full) {
      onProgress(1);
      return true;
    }
  } catch {
    /* приватный режим */
  }
  const r = await fetch(full);
  if (!r.ok) throw new Error(`no-model ${r.status}`);
  const total = Number(r.headers.get('content-length') || 0) || 46_000_000;
  if (!r.body) {
    await r.arrayBuffer();
    onProgress(1);
    return true;
  }
  const reader = r.body.getReader();
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length; // байты не держим
    onProgress(Math.min(0.99, got / total));
  }
  onProgress(1);
  return true;
}

/**
 * Health-проверка модели до скачивания 45 МБ: HEAD. 404/410, сеть, HTML вместо архива (SPA-фолбэк Caddy отдаёт
 * index.html с 200 на любой путь) или подозрительно маленький файл — модели нет. Модель уже разворачивалась на этом
 * телефоне (лежит в IndexedDB воркера) — не проверяем: работает и без сети.
 */
export async function checkModel(url: string, f: typeof fetch = (...a) => fetch(...a)): Promise<{ ok: boolean; why?: string }> {
  const full = new URL(asset(url), location.href).href;
  try {
    if (localStorage.getItem(READY_KEY) === full) return { ok: true };
  } catch {
    /* приватный режим */
  }
  let r: Response;
  try {
    r = await f(full, { method: 'HEAD', cache: 'no-store' });
  } catch (e) {
    return { ok: false, why: 'no-model fetch ' + String((e as Error)?.message ?? e).slice(0, 60) };
  }
  // HEAD не поддержан (405/501) — пусть решает GET
  if (r.status === 405 || r.status === 501) return { ok: true };
  if (!r.ok) return { ok: false, why: `no-model ${r.status}` };
  const type = r.headers.get('content-type') ?? '';
  if (/text\/html/i.test(type)) return { ok: false, why: 'no-model html' };
  const len = Number(r.headers.get('content-length') || 0);
  if (len && len < 1_000_000) return { ok: false, why: `no-model size ${len}` };
  return { ok: true };
}

function markModelReady(url: string) {
  try {
    localStorage.setItem(READY_KEY, new URL(asset(url), location.href).href);
  } catch {
    /* ignore */
  }
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

  /** здоровье модели (MODEL_MAX_ATTEMPTS попыток за сессию, между ними MODEL_RETRY_MS) */
  health: ModelHealth = 'unknown';
  private attempts = 0;
  private nextTryAt = 0;
  private prefetching: Promise<boolean> | null = null;

  /** распознавание сейчас невозможно: модели нет (dead) или ждём паузу перед второй попыткой */
  get unavailable() {
    if (this.model) return false;
    if (this.health === 'dead') return true;
    return this.health === 'down' && performance.now() < this.nextTryAt;
  }

  private fail(why: string) {
    this.loading = null;
    this.prefetching = null;
    this.health = this.attempts >= MODEL_MAX_ATTEMPTS ? 'dead' : 'down';
    this.nextTryAt = performance.now() + MODEL_RETRY_MS;
    this.onState('error', /no-model|404|fetch|load|html/i.test(why) ? `no-model ${why}` : why);
  }

  /** можно ли начать новую попытку (не dead, пауза прошла); засчитывает попытку */
  private takeAttempt(): boolean {
    if (this.health === 'dead') return false;
    if (this.health === 'down' && performance.now() < this.nextTryAt) return false;
    this.attempts++;
    this.health = 'loading';
    return true;
  }

  /**
   * Только скачать архив в HTTP-кэш (с прогрессом) после health-проверки — без распаковки: распаковка в воркере Vosk
   * на iPhone забирает процессор у трекера карты, поэтому её (preload) app.ts запускает после посадки кота.
   */
  prefetch(): Promise<boolean> {
    if (this.model) return Promise.resolve(true);
    if (this.loading) return this.loading;
    if (this.prefetching) return this.prefetching;
    if (!this.takeAttempt()) return Promise.resolve(false);
    this.prefetching = (async () => {
      try {
        this.onState('loading');
        const h = await checkModel(this.modelUrl);
        if (!h.ok) throw new Error(h.why);
        await Promise.all([fetchModelWithProgress(this.modelUrl, (p) => this.onProgress(p)), import('vosk-browser')]);
        // скачали — попытка засчитана, распаковка (preload) продолжит её без новой
        this.health = 'unknown';
        this.attempts--;
        this.onState('idle');
        return true;
      } catch (e) {
        this.fail(String((e as Error)?.message ?? e));
        return false;
      } finally {
        this.prefetching = null;
      }
    })();
    return this.prefetching;
  }

  preload(): Promise<boolean> {
    if (this.model) return Promise.resolve(true);
    if (this.loading) return this.loading;
    const pre = this.prefetching;
    if (pre) return (this.loading = pre.then((ok) => (this.loading = null, ok ? this.preload() : false)));
    if (!this.takeAttempt()) return Promise.resolve(false);
    this.loading = (async () => {
      try {
        this.onState('loading');
        const h = await checkModel(this.modelUrl);
        if (!h.ok) throw new Error(h.why);
        // модель (сеть или HTTP-кэш) и сам движок (≈2.4 МБ gzip) — параллельно
        const [, vosk] = await Promise.all([fetchModelWithProgress(this.modelUrl, (p) => this.onProgress(p)), import('vosk-browser')]);
        this.model = await vosk.createModel(new URL(asset(this.modelUrl), location.href).href);
        markModelReady(this.modelUrl);
        this.health = 'ok';
        this.onState('idle');
        return true;
      } catch (e) {
        this.fail(String((e as Error)?.message ?? e));
        return false;
      }
    })();
    return this.loading;
  }

  async start(preroll?: Float32Array[]) {
    if (this.listening) return;
    // модели нет и повторять рано — не перезапрашиваем 45 МБ на каждую фразу; состояние — сразу «idle»
    if (this.unavailable) {
      this.onState('idle');
      return;
    }
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

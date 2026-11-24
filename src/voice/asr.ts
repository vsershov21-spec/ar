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
/**
 * Распаковка модели в воркере Vosk не ответила за столько — попытка не удалась (iPhone: воркер мог упасть по памяти
 * молча; раньше health оставался «loading» навсегда — голос не работал, а кот звал говорить и тоста не было)
 */
export const MODEL_UNPACK_TIMEOUT_MS = 150_000;
/**
 * Сетевые дедлайны загрузки модели (VOX-01): HEAD-проверка, заголовки ответа GET и пауза между кусками тела.
 * Раньше любое из трёх ожиданий могло висеть бесконечно — статус «loading» навсегда, повтора не было.
 */
export const MODEL_HEAD_TIMEOUT_MS = 10_000;
export const MODEL_GET_TIMEOUT_MS = 20_000;
/** тело архива: ни одного байта за столько — попытка не удалась (медленная сеть даёт куски чаще) */
export const MODEL_STALL_TIMEOUT_MS = 20_000;

export interface ModelFetchOpts {
  /** внешняя отмена (VoskAsr.cancel: микрофон запретили, попытка провалилась) */
  signal?: AbortSignal;
  headMs?: number;
  getMs?: number;
  stallMs?: number;
  fetch?: typeof fetch;
}

const reasonOf = (s: AbortSignal, d = 'no-model aborted') => (s.reason instanceof Error ? s.reason : new Error(typeof s.reason === 'string' ? s.reason : d));
/** обещание, которое сдаётся по сигналу (даже если тот, кто его дал, сигнал не слушает — чужой fetch, тело ответа) */
function abortable<T>(p: Promise<T>, s: AbortSignal): Promise<T> {
  if (s.aborted) return Promise.reject(reasonOf(s));
  return new Promise<T>((res, rej) => {
    const on = () => rej(reasonOf(s));
    s.addEventListener('abort', on, { once: true });
    p.then(
      (v) => (s.removeEventListener('abort', on), res(v)),
      (e) => (s.removeEventListener('abort', on), rej(e)),
    );
  });
}
/** свой AbortController попытки, связанный с внешним сигналом */
function linked(outer?: AbortSignal): AbortController {
  const c = new AbortController();
  if (outer) {
    if (outer.aborted) c.abort(reasonOf(outer));
    else outer.addEventListener('abort', () => c.abort(reasonOf(outer)), { once: true });
  }
  return c;
}

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
  /** отменить загрузку модели (микрофон запретили): без ошибки и без засчитанной попытки */
  cancel?(): void;
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
export async function fetchModelWithProgress(url: string, onProgress: (p: number) => void, o: ModelFetchOpts = {}): Promise<boolean> {
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
  const f = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const ctrl = linked(o.signal);
  const sig = ctrl.signal;
  let timer = 0 as unknown as ReturnType<typeof setTimeout>;
  const arm = (ms: number, what: string) => {
    clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(new Error(`no-model timeout ${what}`)), ms);
  };
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    arm(o.getMs ?? MODEL_GET_TIMEOUT_MS, 'get');
    const r = await abortable(f(full, { signal: sig }), sig);
    if (!r.ok) throw new Error(`no-model ${r.status}`);
    if (/text\/html/i.test(r.headers.get('content-type') ?? '')) throw new Error('no-model html');
    const total = Number(r.headers.get('content-length') || 0) || 46_000_000;
    if (!r.body) {
      arm(o.stallMs ?? MODEL_STALL_TIMEOUT_MS, 'body');
      await abortable(r.arrayBuffer(), sig);
      onProgress(1);
      return true;
    }
    reader = r.body.getReader();
    let got = 0;
    for (;;) {
      arm(o.stallMs ?? MODEL_STALL_TIMEOUT_MS, 'body');
      const { done, value } = await abortable(reader.read(), sig);
      if (done) break;
      got += value.length; // байты не держим
      onProgress(Math.min(0.99, got / total));
    }
    reader = null;
    onProgress(1);
    return true;
  } catch (e) {
    throw sig.aborted ? reasonOf(sig) : e;
  } finally {
    clearTimeout(timer);
    // сдались посреди тела (дедлайн, отмена) — отпустить поток и сам запрос, чтобы прежняя попытка не качала дальше
    if (reader) void reader.cancel().catch(() => undefined);
    if (!sig.aborted) ctrl.abort(new Error('no-model done'));
  }
}

/**
 * Health-проверка модели до скачивания 45 МБ: HEAD. 404/410, сеть, HTML вместо архива (SPA-фолбэк Caddy отдаёт
 * index.html с 200 на любой путь) или подозрительно маленький файл — модели нет. Модель уже разворачивалась на этом
 * телефоне (лежит в IndexedDB воркера) — не проверяем: работает и без сети.
 */
export async function checkModel(url: string, f: typeof fetch = (...a) => fetch(...a), o: ModelFetchOpts = {}): Promise<{ ok: boolean; why?: string }> {
  const full = new URL(asset(url), location.href).href;
  try {
    if (localStorage.getItem(READY_KEY) === full) return { ok: true };
  } catch {
    /* приватный режим */
  }
  let r: Response;
  const ctrl = linked(o.signal);
  const tm = setTimeout(() => ctrl.abort(new Error('no-model timeout head')), o.headMs ?? MODEL_HEAD_TIMEOUT_MS);
  try {
    r = await abortable(f(full, { method: 'HEAD', cache: 'no-store', signal: ctrl.signal }), ctrl.signal);
  } catch (e) {
    const m = String((e as Error)?.message ?? e);
    return { ok: false, why: /^no-model|^cancel/.test(m) ? m : 'no-model fetch ' + m.slice(0, 60) };
  } finally {
    clearTimeout(tm);
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
  /** слова последней фразы и их уверенность (setWords(true)): нормализованное слово → минимальная conf */
  private words = new Map<string, number>();
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
  /**
   * Одна загрузка архива на попытку (OPT-01): HEAD + GET с прогрессом в HTTP-кэш. prefetch, preload и первая команда
   * (start → preload) ждут ЭТО обещание — второй полной передачи архива из главного потока нет; воркер Vosk потом
   * берёт архив из HTTP-кэша. Отменяется cancel() (микрофон запретили) и сетевыми дедлайнами.
   */
  private download: Promise<void> | null = null;
  /** архив уже скачан в этой сессии (в HTTP-кэше) — preload сразу распаковывает */
  private downloaded = false;
  private ctrl: AbortController | null = null;
  private cancelled = false;
  /** дедлайны (тесты ставят короткие) */
  net: ModelFetchOpts = {};

  private fetchArchive(): Promise<void> {
    if (this.downloaded) return Promise.resolve();
    if (this.download) return this.download;
    const ctrl = (this.ctrl = new AbortController());
    const o = { ...this.net, signal: ctrl.signal };
    const d = (async () => {
      const h = await checkModel(this.modelUrl, this.net.fetch, o);
      if (!h.ok) throw new Error(h.why);
      await fetchModelWithProgress(this.modelUrl, (p) => this.onProgress(p), o);
      this.downloaded = true;
    })();
    this.download = d;
    const done = () => {
      if (this.download === d) this.download = null;
      if (this.ctrl === ctrl) this.ctrl = null;
    };
    d.then(done, done);
    return d;
  }

  /**
   * Отменить загрузку модели (микрофон запретили — 46 МБ не нужны): попытка не засчитывается, ошибки нет,
   * статус — idle. Распаковку в воркере не прерывает (её держит MODEL_UNPACK_TIMEOUT_MS).
   */
  cancel() {
    if (!this.ctrl) return;
    this.cancelled = true;
    this.ctrl.abort(new Error('cancel'));
  }
  private settleCancel(): boolean {
    if (!this.cancelled) return false;
    this.cancelled = false;
    this.loading = null;
    this.prefetching = null;
    this.attempts = Math.max(0, this.attempts - 1);
    this.health = 'unknown';
    this.onState('idle');
    return true;
  }

  /** распознавание сейчас невозможно: модели нет (dead) или ждём паузу перед второй попыткой */
  get unavailable() {
    if (this.model) return false;
    if (this.health === 'dead') return true;
    return this.health === 'down' && performance.now() < this.nextTryAt;
  }

  private fail(why: string) {
    this.ctrl?.abort(new Error(why));
    this.loading = null;
    this.prefetching = null;
    this.health = this.attempts >= MODEL_MAX_ATTEMPTS ? 'dead' : 'down';
    this.nextTryAt = performance.now() + MODEL_RETRY_MS;
    this.onState('error', /^no-model/.test(why) ? why : /no-model|404|fetch|load|html/i.test(why) ? `no-model ${why}` : why);
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
    if (this.downloaded) return Promise.resolve(true);
    if (!this.takeAttempt()) return Promise.resolve(false);
    this.prefetching = (async () => {
      try {
        this.onState('loading');
        await Promise.all([this.fetchArchive(), import('vosk-browser')]);
        // скачали — попытка засчитана, распаковка (preload) продолжит её без новой
        this.health = 'unknown';
        this.attempts--;
        this.onState('idle');
        return true;
      } catch (e) {
        if (!this.settleCancel()) this.fail(String((e as Error)?.message ?? e));
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
        // архив (одна общая загрузка с prefetch; уже скачан — сразу) и сам движок (≈2.4 МБ gzip) — параллельно
        const [, vosk] = await Promise.all([this.fetchArchive(), import('vosk-browser')]);
        let tm = 0 as unknown as ReturnType<typeof setTimeout>;
        const model = await Promise.race([
          vosk.createModel(new URL(asset(this.modelUrl), location.href).href),
          new Promise<never>((_, rej) => (tm = setTimeout(() => rej(new Error('load timeout')), MODEL_UNPACK_TIMEOUT_MS))),
        ]).finally(() => clearTimeout(tm));
        this.model = model;
        markModelReady(this.modelUrl);
        this.health = 'ok';
        this.onState('idle');
        return true;
      } catch (e) {
        if (!this.settleCancel()) this.fail(String((e as Error)?.message ?? e));
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
    this.words.clear();
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
    // уверенность по словам: имя, в котором модель не уверена, переспрашиваем (VoiceEngine.nameStep)
    try {
      rec.setWords?.(true);
    } catch {
      /* старая версия vosk-browser */
    }
    rec.on('result', (m: any) => {
      const t: string = m.result?.text ?? '';
      for (const w of (m.result?.result ?? []) as { word?: string; conf?: number }[]) {
        if (!w?.word || typeof w.conf !== 'number') continue;
        const k = w.word.toLowerCase().replace(/ё/g, 'е');
        this.words.set(k, Math.min(this.words.get(k) ?? 1, w.conf));
      }
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

  wordConf(word: string): number | undefined {
    return this.words.get(word.toLowerCase().replace(/ё/g, 'е'));
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

/** ?asr=web — Web Speech (только по флагу и только где включено asr.web: lab), иначе Vosk */
export function makeAsr(kind: string | null, mic: MicInput): Asr {
  if ((kind === 'web' || kind === 'webspeech') && feature('asr.web')) return new WebSpeechAsr();
  return new VoskAsr(mic);
}

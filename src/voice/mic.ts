/**
 * Микрофон — один поток getUserMedia на всё: распознавание (Vosk), VAD, громкость (крик/шёпот/хлопок), повтор.
 * Звук идёт через единственный AudioContext приложения (Audio.ctx, его же использует Howler): на iOS второй
 * контекст или повторный getUserMedia рвут камеру и глушат друг друга.
 *
 * Обработка — в AudioWorklet (micWorklet.ts, поток звука): кадры 10 мс для VAD и 16 кГц для Vosk считаются там,
 * главный поток получает одно сообщение на ~85 мс. Нет AudioWorklet (старый браузер) или модуль не загрузился —
 * ScriptProcessor 4096 с той же обработкой (micDsp.ts) в главном потоке. ?micnode=sp — принудительно ScriptProcessor.
 *
 * Подписчики получают MicChunk: pcm (частота контекста, для повтора), asr (16 кГц ×32768, для Vosk), frames.
 * Аудиосессию iOS микрофон НЕ переключает: тип выставляется один раз в Audio.unlock() (см. audio.ts).
 */
import type { Audio } from '../audio/audio';
import { NoiseFloor, type Frame } from './vad';
import { MicDsp, ASR_SR, type MicChunk } from './micDsp';
import { perf } from '../core/perf';

export type { MicChunk };
export interface MicEvent extends MicChunk {
  /** кадры 10 мс */
  list: Frame[];
}
export type MicListener = (c: MicEvent) => void;
/**
 * Что со входом (для индикатора на кнопке и телеметрии mic_issue):
 *  closed — не открыт; ok — кадры идут; ctx — AudioContext не «running» (iOS: interrupted после камеры/звонка — звук
 *  в ворклет не идёт); silent — кадров нет / одни нули при «running»; muted — iOS заглушила дорожку; ended — дорожка
 *  завершилась (звонок, Siri), переоткрываем.
 */
export type MicHealth = 'closed' | 'ok' | 'ctx' | 'silent' | 'muted' | 'ended';

/** iOS: ctx.resume() у «interrupted» контекста вне жеста может не ответить никогда — ждём не дольше */
export const MIC_RESUME_WAIT_MS = 700;
/** модуль AudioWorklet не загрузился за столько — ScriptProcessor (открытие микрофона не виснет) */
export const MIC_WORKLET_WAIT_MS = 3000;
/** кадров нет дольше — «не слышу» (и будим контекст / пересобираем узлы) */
export const MIC_STALL_MS = 1500;
/** одни цифровые нули дольше — «не слышу» (настоящий микрофон даже в тишине даёт шум ≥ −100 dBFS) */
export const MIC_ZERO_MS = 4000;
const ZERO_DB = -115;

function within<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return Promise.race([p, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))]);
}

/** модуль ворклета загружается в контекст один раз */
const workletLoaded = new WeakMap<BaseAudioContext, Promise<boolean>>();
function loadWorklet(ctx: AudioContext): Promise<boolean> {
  let p = workletLoaded.get(ctx);
  if (!p) {
    p = (async () => {
      if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') return false;
      if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('micnode') === 'sp') return false;
      try {
        const { default: url } = await import('./micWorklet.ts?worker&url');
        await ctx.audioWorklet.addModule(url);
        return true;
      } catch (e) {
        console.warn('[mic] AudioWorklet недоступен — ScriptProcessor', e);
        return false;
      }
    })();
    workletLoaded.set(ctx, p);
  }
  return p;
}

export class MicInput {
  readonly floor = new NoiseFloor(2000);
  private stream: MediaStream | null = null;
  private src: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;
  private listeners = new Set<MicListener>();
  private opening: Promise<boolean> | null = null;
  private users = 0;
  private idleTimer = 0;
  /** чем обрабатывается звук: 'worklet' | 'script' (для debug/стенда) */
  nodeKind: 'worklet' | 'script' | null = null;
  /** уровень 0..1 (для индикатора) */
  level = 0;
  /** последний кадр dBFS */
  lastDb = -120;
  /** ошибка последнего открытия: 'not-allowed' | 'no-device' | 'unsupported' | … */
  error: string | null = null;
  /** когда пришёл последний кадр из ворклета (performance.now) */
  private lastChunkAt = 0;
  /** с какого момента идут одни нули (0 — не нули) */
  private zeroSince = 0;
  private watchTimer = 0;
  private openedAt = 0;
  private rebuilt = false;
  private reopens = 0;
  /** состояние входа (индикатор «не слышу», телеметрия) */
  health: MicHealth = 'closed';
  /** вход сломался/починился: причина (MicHealth) — engine шлёт в аналитику mic_issue (без звука и текста) */
  onHealth: ((h: MicHealth, info: Record<string, unknown>) => void) | null = null;
  /** Не закрываем: на iOS повторный getUserMedia и смена аудиосессии (playback ↔ play-and-record) рвут камеру —
   *  фон становится чёрным. Микрофон, раз открытый, живёт до ухода со страницы. */
  idleCloseMs = Infinity;

  /** готовая аудиодорожка из общего запроса камеры (iOS: один getUserMedia на камеру и микрофон — без второго
   *  запроса, который рвёт видео). Берётся при первом открытии; нет/завершилась — открываем свой getUserMedia. */
  private preStream: MediaStream | null = null;
  adopt(stream: MediaStream | null) {
    if (stream?.getAudioTracks().some((t) => t.readyState === 'live')) this.preStream = stream;
  }

  constructor(private audio: Audio) {}

  get supported() {
    return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  }
  get isOpen() {
    return !!this.node;
  }
  get sampleRate() {
    return this.audio.ctx?.sampleRate ?? 48000;
  }
  /** частота chunk.asr */
  readonly asrRate = ASR_SR;

  on(fn: MicListener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Захватить микрофон (счётчик пользователей). Вызывать из жеста при первом разе (iOS). */
  acquire(): Promise<boolean> {
    this.users++;
    clearTimeout(this.idleTimer);
    return this.open();
  }

  /** микрофон кому-то нужен, но закрыт (iOS закрыла дорожку при звонке/сворачивании) — открыть снова */
  ensureOpen(): Promise<boolean> {
    return this.users > 0 ? this.open() : Promise.resolve(false);
  }

  /** Отпустить; когда пользователей нет — закрыть через idleCloseMs */
  release() {
    this.users = Math.max(0, this.users - 1);
    if (this.users === 0) {
      clearTimeout(this.idleTimer);
      if (Number.isFinite(this.idleCloseMs)) this.idleTimer = window.setTimeout(() => this.users === 0 && this.close(), this.idleCloseMs);
    }
  }

  /**
   * Доступ к микрофону запрещён (или микрофона нет): больше не спрашиваем в эту сессию — повторные getUserMedia
   * на iOS сразу отклоняются, а в других браузерах снова показывают запрос поверх игры. Вернуть — перезагрузкой.
   */
  get denied() {
    return this.error === 'not-allowed' || this.error === 'no-device';
  }
  /** колбэк: доступ запретили (один раз за сессию) */
  onDenied: ((why: string) => void) | null = null;
  private deniedFired = false;

  /**
   * Запрет уже известен: камера и микрофон спрашивались одним запросом (заставка быстрого входа, cardTracker), и
   * микрофон не дали — не спрашиваем снова и сообщаем один раз (тост «Нет доступа к микрофону», voiceIn().mic = false).
   * Другие ошибки (камера+микрофон не вышли вместе по иной причине) — не запрет: микрофон попробует открыться сам.
   */
  markDenied(name: string) {
    if (this.node || this.denied) return;
    if (name !== 'NotAllowedError' && name !== 'SecurityError' && name !== 'NotFoundError') return;
    this.error = name === 'NotFoundError' ? 'no-device' : 'not-allowed';
    if (!this.deniedFired) {
      this.deniedFired = true;
      this.onDenied?.(this.error);
    }
  }

  private open(): Promise<boolean> {
    if (this.node) return Promise.resolve(true);
    if (this.denied) return Promise.resolve(false);
    if (this.opening) return this.opening;
    // Сначала присваиваем, потом очищаем по завершении. Раньше было `opening ??= (async () => {… finally opening = null})()`:
    // если открыть было нельзя сразу (AudioContext ещё не создан — «слушаю всегда» до жеста), finally срабатывал
    // синхронно ДО присваивания, и в opening навсегда оставался готовый false — микрофон больше не открывался никогда.
    const p = this.doOpen();
    this.opening = p;
    void p.then(() => {
      if (this.opening === p) this.opening = null;
    });
    return p;
  }

  private async doOpen(): Promise<boolean> {
    const ctx = this.audio.ctx;
    if (!this.supported || !ctx) {
      this.error = 'unsupported';
      return false;
    }
    // до жеста (Audio.unlock) не открываем: «слушаю всегда» откроет снова после камеры (App.wake → resumeAuto)
    if (!this.audio.unlocked) {
      this.error = 'locked';
      return false;
    }
    try {
      // iOS: после камеры контекст бывает «interrupted», и resume() вне жеста не отвечает никогда — раньше открытие
      // микрофона висело на этом await навсегда (opening не сбрасывался: «слушаю всегда» не открывался до перезагрузки).
      // Не ждём дольше MIC_RESUME_WAIT_MS: узлы подключим и так, звук пойдёт, когда контекст проснётся (касание, реплика)
      if (ctx.state !== 'running') await within(ctx.resume().catch(() => undefined), MIC_RESUME_WAIT_MS);
      // модуль ворклета — параллельно с запросом доступа (getUserMedia ждёт ответа ребёнка/родителя)
      const wl = within(loadWorklet(ctx), MIC_WORKLET_WAIT_MS).then((ok) => ok === true);
      // эхоподавление нужно: кот не слышит себя, голосом можно перебить. На iOS оно включает «голосовую обработку»,
      // и звук приложения играет тише; ?aec=0 — без него (проверить громкость на устройстве)
      const aec = typeof location === 'undefined' || new URLSearchParams(location.search).get('aec') !== '0';
      const pre = this.preStream;
      this.preStream = null;
      this.stream = pre && pre.getAudioTracks().some((t) => t.readyState === 'live')
        ? pre
        : await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: aec, noiseSuppression: aec, autoGainControl: false, channelCount: 1 },
          });
      this.src = ctx.createMediaStreamSource(this.stream);
      const sr = ctx.sampleRate;
      let node: AudioWorkletNode | ScriptProcessorNode;
      if (await wl) {
        const w = new AudioWorkletNode(ctx, 'mic-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit' });
        w.port.onmessage = (e: MessageEvent<MicChunk>) => this.node === w && this.process(e.data);
        node = w;
        this.nodeKind = 'worklet';
      } else {
        // 4096 отсчётов (≈ 85 мс при 48 кГц) — та же обработка (micDsp), но в главном потоке
        const dsp = new MicDsp(sr, (c) => this.process(c), 4096);
        const sp = ctx.createScriptProcessor(4096, 1, 1);
        sp.onaudioprocess = (e) => dsp.push(e.inputBuffer.getChannelData(0));
        node = sp;
        this.nodeKind = 'script';
      }
      // узел работает, только если подключён к выходу — через нулевую громкость
      this.sink = ctx.createGain();
      this.sink.gain.value = 0;
      this.src.connect(node);
      node.connect(this.sink);
      this.sink.connect(ctx.destination);
      this.node = node;
      // iOS: звонок/Siri/сворачивание может завершить дорожку — тогда микрофон считаем закрытым (откроется заново)
      const track = this.stream.getAudioTracks()[0];
      if (track) track.onended = () => {
        if (this.node === node) {
          this.error = 'ended';
          this.cleanup();
          this.setHealth('ended');
          this.reopenSoon();
        }
      };
      this.floor.reset(true); // калибровка шума 2 с после включения
      this.error = null;
      this.openedAt = this.lastChunkAt = performance.now();
      this.zeroSince = 0;
      this.rebuilt = false;
      this.setHealth('ok');
      this.watch();
      return true;
    } catch (e: any) {
      this.error = e?.name === 'NotAllowedError' || e?.name === 'SecurityError' ? 'not-allowed' : e?.name === 'NotFoundError' ? 'no-device' : String(e?.message ?? e);
      this.cleanup();
      if (this.denied && !this.deniedFired) {
        this.deniedFired = true;
        this.onDenied?.(this.error);
      }
      return false;
    }
  }

  /**
   * Сторож входа (раз в секунду, пока открыт): кадров нет или одни нули — «не слышу». Контекст не «running» —
   * будим (без ожидания); при «running» без кадров 4 с — один раз пересобираем узлы (iOS после смены маршрута звука);
   * дорожка завершилась — открываем заново (не больше 2 раз за сессию).
   */
  private watch() {
    clearInterval(this.watchTimer);
    if (typeof window === 'undefined') return;
    this.watchTimer = window.setInterval(() => this.check(), 1000);
  }

  /** одна проверка сторожа (публично — для тестов) */
  check(now = performance.now()) {
    const node = this.node, ctx = this.audio.ctx;
    if (!node || !ctx) return this.setHealth('closed');
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    const track = this.stream?.getAudioTracks()[0];
    if (track && track.readyState === 'ended') {
      this.error = 'ended';
      this.cleanup();
      this.setHealth('ended');
      return void this.reopenSoon();
    }
    const stalled = now - this.lastChunkAt > MIC_STALL_MS;
    if (stalled && ctx.state !== 'running') {
      void ctx.resume().catch(() => undefined);
      return this.setHealth('ctx', { state: ctx.state });
    }
    if (stalled && now - this.lastChunkAt > 4000 && !this.rebuilt) {
      this.rebuilt = true;
      this.rewire();
    }
    if (track?.muted) return this.setHealth('muted');
    if (stalled) return this.setHealth('silent', { why: 'no_chunks', ms: Math.round(now - this.lastChunkAt) });
    if (this.zeroSince && now - this.zeroSince > MIC_ZERO_MS) return this.setHealth('silent', { why: 'zeros' });
    this.setHealth('ok');
  }

  private setHealth(h: MicHealth, info: Record<string, unknown> = {}) {
    if (h === this.health) return;
    const prev = this.health;
    this.health = h;
    this.onHealth?.(h, { ...info, prev, node: this.nodeKind, ctx: this.audio.ctx?.state, sr: this.audio.ctx?.sampleRate, upMs: Math.round(performance.now() - this.openedAt) });
  }

  /** источник → узел → выход заново (тот же поток) */
  private rewire() {
    const ctx = this.audio.ctx;
    if (!ctx || !this.stream || !this.node || !this.sink) return;
    try {
      this.src?.disconnect();
      this.src = ctx.createMediaStreamSource(this.stream);
      this.src.connect(this.node);
    } catch (e) {
      console.warn('[mic] пересборка узлов', e);
    }
  }

  private reopenSoon() {
    if (this.users <= 0 || this.reopens >= 2 || this.denied) return;
    this.reopens++;
    setTimeout(() => void this.open(), 500);
  }

  private process(c: MicChunk) {
    perf.count('mic');
    const t = performance.now();
    this.lastChunkAt = t;
    const f = c.frames;
    const list: Frame[] = [];
    for (let i = 0; i + 2 < f.length; i += 3) {
      const fr = { rms: f[i], peak: f[i + 1], zcr: f[i + 2] };
      list.push(fr);
      this.lastDb = 20 * Math.log10(Math.max(fr.rms, 1e-7));
      // индикатор: −60…−10 dBFS → 0…1, сглаживание
      const v = Math.min(1, Math.max(0, (this.lastDb + 60) / 50));
      this.level += (v - this.level) * (v > this.level ? 0.5 : 0.15);
    }
    if (this.lastDb > ZERO_DB) this.zeroSince = 0;
    else if (!this.zeroSince) this.zeroSince = t;
    if (this.health !== 'ok' && this.health !== 'muted' && this.lastDb > ZERO_DB) this.setHealth('ok');
    const ev = c as MicEvent;
    ev.list = list;
    for (const fn of this.listeners) fn(ev);
  }

  close() {
    clearTimeout(this.idleTimer);
    this.cleanup();
    this.level = 0;
    this.setHealth('closed');
  }

  private cleanup() {
    clearInterval(this.watchTimer);
    try {
      this.node?.disconnect();
      this.src?.disconnect();
      this.sink?.disconnect();
    } catch {
      /* ignore */
    }
    const n = this.node;
    if (n && 'onaudioprocess' in n) n.onaudioprocess = null;
    if (n && 'port' in n) {
      n.port.onmessage = null;
      n.port.postMessage('stop');
    }
    this.node = null;
    this.nodeKind = null;
    this.src = null;
    this.sink = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}

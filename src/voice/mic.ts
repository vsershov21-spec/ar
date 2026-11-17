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
  /** Не закрываем: на iOS повторный getUserMedia и смена аудиосессии (playback ↔ play-and-record) рвут камеру —
   *  фон становится чёрным. Микрофон, раз открытый, живёт до ухода со страницы. */
  idleCloseMs = Infinity;

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

  private open(): Promise<boolean> {
    if (this.node) return Promise.resolve(true);
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
      if (ctx.state !== 'running') await ctx.resume().catch(() => undefined);
      // модуль ворклета — параллельно с запросом доступа (getUserMedia ждёт ответа ребёнка/родителя)
      const wl = loadWorklet(ctx);
      // эхоподавление нужно: кот не слышит себя, голосом можно перебить. На iOS оно включает «голосовую обработку»,
      // и звук приложения играет тише; ?aec=0 — без него (проверить громкость на устройстве)
      const aec = typeof location === 'undefined' || new URLSearchParams(location.search).get('aec') !== '0';
      this.stream = await navigator.mediaDevices.getUserMedia({
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
        }
      };
      this.floor.reset(true); // калибровка шума 2 с после включения
      this.error = null;
      return true;
    } catch (e: any) {
      this.error = e?.name === 'NotAllowedError' ? 'not-allowed' : e?.name === 'NotFoundError' ? 'no-device' : String(e?.message ?? e);
      this.cleanup();
      return false;
    }
  }

  private process(c: MicChunk) {
    perf.count('mic');
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
    const ev = c as MicEvent;
    ev.list = list;
    for (const fn of this.listeners) fn(ev);
  }

  close() {
    clearTimeout(this.idleTimer);
    this.cleanup();
    this.level = 0;
  }

  private cleanup() {
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

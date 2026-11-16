/**
 * Микрофон — один поток getUserMedia на всё: распознавание (Vosk), VAD, громкость (крик/шёпот/хлопок), повтор.
 * Звук идёт через AudioContext Howler (на iOS — один контекст на страницу, так проигрыш и запись не глушат
 * друг друга). ScriptProcessor (устарел, но работает везде, включая iOS Safari 14+); нет — AudioWorklet не нужен:
 * кадры 10 мс считаются в главном потоке за доли миллисекунды.
 *
 * Подписчики получают сырой буфер и кадры по 10 мс. Микрофон не держим открытым без нужды:
 * close() через idleCloseMs после последнего release() — иначе iOS держит «красную точку» и режим разговора.
 */
import type { Audio } from '../audio/audio';
import { NoiseFloor, toFrames, type Frame } from './vad';

export type MicListener = (buf: Float32Array, frames: Frame[], sampleRate: number) => void;

export class MicInput {
  readonly floor = new NoiseFloor(2000);
  private stream: MediaStream | null = null;
  private src: MediaStreamAudioSourceNode | null = null;
  private node: ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;
  private listeners = new Set<MicListener>();
  private opening: Promise<boolean> | null = null;
  private users = 0;
  private idleTimer = 0;
  private carry = { buf: new Float32Array(4096), n: 0 };
  /** уровень 0..1 (для индикатора) */
  level = 0;
  /** последний кадр dBFS */
  lastDb = -120;
  /** ошибка последнего открытия: 'not-allowed' | 'no-device' | 'unsupported' | … */
  error: string | null = null;
  idleCloseMs = 8000;

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

  /** Отпустить; когда пользователей нет — закрыть через idleCloseMs */
  release() {
    this.users = Math.max(0, this.users - 1);
    if (this.users === 0) {
      clearTimeout(this.idleTimer);
      this.idleTimer = window.setTimeout(() => this.users === 0 && this.close(), this.idleCloseMs);
    }
  }

  private open(): Promise<boolean> {
    if (this.node) return Promise.resolve(true);
    this.opening ??= (async () => {
      const ctx = this.audio.ctx;
      if (!this.supported || !ctx) {
        this.error = 'unsupported';
        return false;
      }
      try {
        if (ctx.state !== 'running') await ctx.resume().catch(() => undefined);
        this.audio.setSession('play-and-record');
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false, channelCount: 1 },
        });
        this.src = ctx.createMediaStreamSource(this.stream);
        const node = ctx.createScriptProcessor(2048, 1, 1);
        node.onaudioprocess = (e) => this.process(e.inputBuffer.getChannelData(0), ctx.sampleRate);
        // ScriptProcessor работает, только если подключён к выходу — через нулевую громкость
        this.sink = ctx.createGain();
        this.sink.gain.value = 0;
        this.src.connect(node);
        node.connect(this.sink);
        this.sink.connect(ctx.destination);
        this.node = node;
        this.floor.reset(true); // калибровка шума 2 с после включения
        this.error = null;
        return true;
      } catch (e: any) {
        this.error = e?.name === 'NotAllowedError' ? 'not-allowed' : e?.name === 'NotFoundError' ? 'no-device' : String(e?.message ?? e);
        this.audio.setSession('playback');
        this.cleanup();
        return false;
      } finally {
        this.opening = null;
      }
    })();
    return this.opening;
  }

  private process(x: Float32Array, sr: number) {
    const frames = toFrames(x, sr, this.carry);
    for (const f of frames) {
      this.lastDb = 20 * Math.log10(Math.max(f.rms, 1e-7));
      // индикатор: −60…−10 dBFS → 0…1, сглаживание
      const v = Math.min(1, Math.max(0, (this.lastDb + 60) / 50));
      this.level += (v - this.level) * (v > this.level ? 0.5 : 0.15);
    }
    for (const fn of this.listeners) fn(x, frames, sr);
  }

  close() {
    clearTimeout(this.idleTimer);
    this.cleanup();
    this.audio.setSession('playback');
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
    if (this.node) this.node.onaudioprocess = null;
    this.node = null;
    this.src = null;
    this.sink = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.carry.n = 0;
  }
}

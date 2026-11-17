/**
 * ПОВТОР («эхо», как у Говорящего Тома): ребёнок говорит — кот повторяет смешным голосом.
 *
 *  1. Микрофон открыт, VAD: энергия выше шума ≥ 120 мс — начало фразы (+250 мс записи «до»),
 *     400 мс тишины — конец, максимум 6 с.
 *  2. Запись — только в памяти. Обработка (воркер): 24 кГц, сдвиг тона +echoPitchSemitones и темп echoRate
 *     из пресета характера (фазовый вокодер), −16 LUFS.
 *  3. Проигрыш через VoicePlayer.playBuffer: рот по амплитуде, клип echo_speak. Пока кот повторяет —
 *     микрофон не слушается (кот не повторяет сам себя).
 *  4. Исходная и обработанная записи затираются нулями сразу после проигрыша; никуда не отправляются и
 *     не сохраняются.
 *  5. «Хватит»/«стоп» во время повтора: если модель Vosk уже загружена, фраза сначала проверяется
 *     маленькой грамматикой стоп-слов — и тогда кот не повторяет, а выходит из режима.
 *  6. События: echo_start, echo_done {count}, echo_stop {reason}. Автовыход — 20 с без речи
 *     (в режиме deferred таймаут ведёт сценарий: listen echo 20 000 мс в dialogs.json).
 */
import type { MicInput } from './mic';
import type { VoicePlayer } from './voicePlayer';
import { Vad, VAD_DEFAULTS } from './vad';
import type { MicEvent } from './mic';
import { ECHO_SR, processEcho } from './echoDsp';

export interface EchoPreset { echoPitchSemitones: number; echoRate: number }
export type EchoEvent =
  | { id: 'echo_start' }
  | { id: 'echo_done'; count: number }
  | { id: 'echo_stop'; reason: 'intent' | 'button' | 'timeout' | 'api' }
  | { id: 'echo_speaking'; clip: string; durationSec: number }
  | { id: 'echo_listening' }
  /** deferred: запись готова — её заберёт VoicePlayer.echo() (через сценарий) */
  | { id: 'echo_ready'; durationSec: number }
  /** deferred: распознано стоп-слово */
  | { id: 'echo_stopword'; text: string };

const PREROLL_MS = 250;
const IDLE_EXIT_MS = 20000;
const STOP_GRAMMAR = ['хватит', 'стоп', 'хватит повторять', 'не повторяй', 'перестань', 'всё', 'все', '[unk]'];

export class EchoMode {
  active = false;
  count = 0;
  /** что сейчас: ждём речь / пишем / обрабатываем / говорим */
  phase: 'off' | 'waiting' | 'recording' | 'processing' | 'ready' | 'speaking' = 'off';
  /**
   * direct — сам играет повтор (window.__voice.echo.start, без сценария);
   * deferred — отдаёт готовую запись сценарию (диалог «echo» в content/dialogs.json: director.echo → VoicePlayer.echo)
   */
  delivery: 'direct' | 'deferred' = 'direct';
  private ready: AudioBuffer | null = null;
  private readyTimer = 0;
  private vad: Vad;
  private off: (() => void) | null = null;
  private chunks: Float32Array[] = [];
  private pre: Float32Array[] = [];
  private preLen = 0;
  private lastSpeech = 0;
  private idleTimer = 0;
  private worker: Worker | null = null;
  private seq = 0;
  /** пока true — кадры игнорируются (говорит кот + 250 мс) */
  gated = () => false;
  /** проверка стоп-слова (VoskAsr.recognizeOnce) — если есть */
  checkStop: ((pcm: Float32Array, sr: number, grammar: string[]) => Promise<string | null>) | null = null;
  onEvent: (e: EchoEvent) => void = () => {};

  constructor(private mic: MicInput, private voice: VoicePlayer, private preset: () => EchoPreset) {
    this.vad = new Vad(mic.floor, { ...VAD_DEFAULTS, endSilenceMs: 400, maxMs: 6000 });
  }

  async start(delivery: 'direct' | 'deferred' = 'direct') {
    this.delivery = delivery;
    if (this.active) return true;
    this.active = true;
    this.count = 0;
    this.onEvent({ id: 'echo_start' });
    const ok = await this.mic.acquire();
    if (!ok || !this.active) {
      if (ok) this.mic.release();
      this.active = false;
      this.phase = 'off';
      return false;
    }
    this.phase = 'waiting';
    this.vad.reset();
    this.lastSpeech = performance.now();
    this.off = this.mic.on((c) => this.onAudio(c));
    this.idleTimer = window.setInterval(() => {
      if (this.delivery === 'direct' && this.phase === 'waiting' && performance.now() - this.lastSpeech > IDLE_EXIT_MS) this.stop('timeout');
    }, 1000);
    this.onEvent({ id: 'echo_listening' });
    return true;
  }

  stop(reason: 'intent' | 'button' | 'timeout' | 'api' = 'api') {
    if (!this.active) return;
    this.active = false;
    this.phase = 'off';
    clearInterval(this.idleTimer);
    this.off?.();
    this.off = null;
    this.wipe();
    this.mic.release();
    this.onEvent({ id: 'echo_stop', reason });
  }

  /** забрать готовую запись (deferred). После проигрыша вызвать played(). */
  take(): AudioBuffer | null {
    clearTimeout(this.readyTimer);
    const b = this.ready;
    this.ready = null;
    if (b) this.phase = 'speaking';
    return b;
  }

  /** повтор отыгран — снова слушаем */
  played() {
    if (!this.active) return;
    this.count++;
    this.phase = 'waiting';
    this.vad.reset();
    this.lastSpeech = performance.now();
  }

  /** готовая запись не нужна (окно закрыто) — выбросить и слушать дальше */
  discard() {
    this.dropReady();
    if (this.active) {
      this.phase = 'waiting';
      this.vad.reset();
    }
  }

  private dropReady() {
    clearTimeout(this.readyTimer);
    this.ready?.getChannelData(0).fill(0);
    this.ready = null;
  }

  private wipe() {
    this.dropReady();
    for (const c of this.chunks) c.fill(0);
    for (const c of this.pre) c.fill(0);
    this.chunks = [];
    this.pre = [];
    this.preLen = 0;
  }

  private onAudio(c: MicEvent) {
    if (!this.active) return;
    const frames = c.list, sr = c.sampleRate;
    if (this.phase === 'processing' || this.phase === 'ready' || this.phase === 'speaking' || this.gated()) {
      if (this.phase === 'recording') {
        // заговорил кот / окно закрылось посреди фразы — запись выбрасываем
        this.wipe();
        this.phase = 'waiting';
      }
      this.vad.reset();
      return;
    }
    // исходный звук блока — свой у каждого блока (никто больше его не держит): без копии
    const copy = c.pcm;
    if (this.phase === 'recording') this.chunks.push(copy);
    else {
      // кольцо «до начала фразы»
      this.pre.push(copy);
      this.preLen += copy.length;
      while (this.pre.length > 1 && this.preLen - this.pre[0].length >= (PREROLL_MS / 1000) * sr) this.preLen -= this.pre.shift()!.fill(0).length;
    }
    for (const f of frames) {
      const ev = this.vad.push(f);
      if (ev?.type === 'start' && this.phase === 'waiting') {
        this.phase = 'recording';
        this.chunks = this.pre;
        this.pre = [];
        this.preLen = 0;
        this.lastSpeech = performance.now();
      } else if (ev?.type === 'end' && this.phase === 'recording') {
        this.lastSpeech = performance.now();
        void this.finish(sr);
        return;
      }
    }
  }

  private async finish(sr: number) {
    this.phase = 'processing';
    const n = this.chunks.reduce((a, c) => a + c.length, 0);
    const pcm = new Float32Array(n);
    let at = 0;
    for (const c of this.chunks) {
      pcm.set(c, at);
      at += c.length;
    }
    this.wipe();
    try {
      // «хватит» — не повторяем, выходим
      if (this.checkStop && n < sr * 2.5) {
        const t = await this.checkStop(pcm, sr, STOP_GRAMMAR).catch(() => null);
        if (t && /хватит|стоп|повторяй|перестань|^вс[её]$/.test(t)) {
          pcm.fill(0);
          if (this.delivery === 'deferred') {
            this.phase = 'waiting';
            this.onEvent({ id: 'echo_stopword', text: t });
          } else this.stop('intent');
          return;
        }
      }
      const p = this.preset();
      const out = await this.process(pcm, sr, p.echoPitchSemitones, p.echoRate);
      const ctx = this.voice.ctx;
      if (!this.active || !ctx || out.length < ECHO_SR * 0.15) {
        out.fill(0);
        return;
      }
      const ab = ctx.createBuffer(1, out.length, ECHO_SR);
      ab.copyToChannel(out as Float32Array<ArrayBuffer>, 0);
      out.fill(0);
      if (this.delivery === 'deferred') {
        this.dropReady();
        this.ready = ab;
        this.phase = 'ready';
        // сценарий не забрал за 6 с — выбрасываем и слушаем дальше
        this.readyTimer = window.setTimeout(() => {
          if (this.phase === 'ready') {
            this.dropReady();
            this.phase = 'waiting';
          }
        }, 6000);
        this.onEvent({ id: 'echo_ready', durationSec: ab.duration });
        return;
      }
      this.phase = 'speaking';
      this.onEvent({ id: 'echo_speaking', clip: 'echo_speak', durationSec: ab.duration });
      await this.voice.playBuffer(ab);
      ab.getChannelData(0).fill(0); // обработанную запись — тоже затираем
      this.count++;
      if (this.active) this.onEvent({ id: 'echo_done', count: this.count });
      if (this.active) {
        this.phase = 'waiting';
        this.vad.reset();
        this.lastSpeech = performance.now();
      }
    } finally {
      pcm.fill(0);
      if (this.active && this.phase === 'processing') this.phase = 'waiting';
    }
  }

  private process(pcm: Float32Array, sr: number, st: number, rate: number): Promise<Float32Array> {
    try {
      this.worker ??= new Worker(new URL('./echoWorker.ts', import.meta.url), { type: 'module' });
    } catch {
      this.worker = null;
    }
    const w = this.worker;
    if (!w) return Promise.resolve(processEcho(pcm, sr, st, rate));
    const id = ++this.seq;
    const send = Float32Array.from(pcm);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        w.removeEventListener('message', on);
        resolve(processEcho(pcm, sr, st, rate));
      }, 5000);
      const on = (e: MessageEvent) => {
        if (e.data?.id !== id) return;
        clearTimeout(t);
        w.removeEventListener('message', on);
        resolve(e.data.out as Float32Array);
      };
      w.addEventListener('message', on);
      w.postMessage({ id, pcm: send, sr, st, rate }, [send.buffer]);
    });
  }
}

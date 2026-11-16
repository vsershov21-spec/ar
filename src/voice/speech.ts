/**
 * Голос:
 *  - распознавание: Web Speech API (webkitSpeechRecognition, ru-RU), режим «держи и говори».
 *    Аудио обрабатывает сам браузер/ОС; приложение ничего никуда не отправляет и не хранит.
 *    (Важно: в Chrome распознавание выполняется сервером Google, в Safari — Apple/на устройстве.
 *    См. docs/MECHANICS.md → «Голос и приватность».)
 *  - ответ: заранее заданные реплики; если у реплики есть записанный файл — играем его
 *    через Web Audio с липсинком по амплитуде (AnalyserNode), иначе speechSynthesis ru-RU
 *    с pitch/rate персоны и псевдо-липсинком.
 */
import { asset } from '../core/util';

type SR = any;

export class SpeechInput {
  private rec: SR | null = null;
  private active = false;
  private finalText = '';
  onResult: (text: string) => void = () => {};
  onInterim: (text: string) => void = () => {};
  onState: (s: 'listening' | 'idle' | 'error', msg?: string) => void = () => {};

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
    rec.onresult = (e: any) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) this.finalText += r[0].transcript + ' ';
        else interim += r[0].transcript;
      }
      this.lastInterim = (this.finalText + interim).trim();
      this.onInterim(this.lastInterim);
    };
    rec.onerror = (e: any) => {
      this.onState('error', e.error);
    };
    rec.onend = () => {
      const text = this.finalText.trim() || this.lastInterim;
      this.active = false;
      this.onState('idle');
      if (text) this.onResult(text);
      this.lastInterim = '';
    };
    this.rec = rec;
    this.active = true;
    try {
      rec.start();
      this.onState('listening');
    } catch (err) {
      this.active = false;
      this.onState('error', String(err));
    }
  }
  private lastInterim = '';

  stop() {
    try {
      this.rec?.stop();
    } catch {
      /* ignore */
    }
  }
}

export interface Speaker {
  speak(text: string, opts: { pitch: number; rate: number; audio?: string }): Promise<void>;
  cancel(): void;
  /** текущая «открытость рта» 0..1 */
  mouth(): number;
}

export class VoiceOut implements Speaker {
  private speaking = false;
  private boundaryPulse = 0;
  private analyser: AnalyserNode | null = null;
  private buf = new Uint8Array(512);
  private src: AudioBufferSourceNode | null = null;
  private voice: SpeechSynthesisVoice | null = null;
  private startedAt = 0;
  muted = false;

  constructor(private getCtx: () => AudioContext | null) {
    if (typeof speechSynthesis !== 'undefined') {
      const pickVoice = () => {
        const vs = speechSynthesis.getVoices();
        this.voice = vs.find((v) => v.lang === 'ru-RU' && /Milena|Милена|Google/i.test(v.name)) ?? vs.find((v) => v.lang.startsWith('ru')) ?? null;
      };
      pickVoice();
      speechSynthesis.addEventListener?.('voiceschanged', pickVoice);
    }
  }

  /** iOS: первый вызов speechSynthesis должен быть из жеста — проговариваем пустую строку */
  unlock() {
    try {
      if (typeof speechSynthesis === 'undefined') return;
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
    } catch {
      /* ignore */
    }
  }

  cancel() {
    try {
      speechSynthesis?.cancel();
    } catch {
      /* ignore */
    }
    try {
      this.src?.stop();
    } catch {
      /* ignore */
    }
    this.speaking = false;
  }

  async speak(text: string, opts: { pitch: number; rate: number; audio?: string }): Promise<void> {
    this.cancel();
    if (this.muted) return;
    if (opts.audio) {
      const ok = await this.playFile(opts.audio).catch(() => false);
      if (ok) return;
    }
    if (typeof speechSynthesis === 'undefined') return;
    return new Promise<void>((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ru-RU';
      if (this.voice) u.voice = this.voice;
      u.pitch = opts.pitch;
      u.rate = opts.rate;
      u.onstart = () => {
        this.speaking = true;
        this.startedAt = performance.now();
      };
      u.onboundary = () => {
        this.boundaryPulse = 1;
      };
      const end = () => {
        this.speaking = false;
        resolve();
      };
      u.onend = end;
      u.onerror = end;
      speechSynthesis.speak(u);
      // страховка: на некоторых устройствах onend не приходит
      setTimeout(end, 1500 + text.length * 90);
    });
  }

  private async playFile(url: string): Promise<boolean> {
    const ctx = this.getCtx();
    if (!ctx) return false;
    const data = await fetch(asset(url)).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject()));
    const buffer = await ctx.decodeAudioData(data);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    an.connect(ctx.destination);
    this.analyser = an;
    this.src = src;
    this.speaking = true;
    await new Promise<void>((resolve) => {
      src.onended = () => {
        this.speaking = false;
        this.analyser = null;
        resolve();
      };
      src.start();
    });
    return true;
  }

  mouth(): number {
    if (!this.speaking) return 0;
    if (this.analyser) {
      // RMS по временной форме волны → 0..1
      this.analyser.getByteTimeDomainData(this.buf);
      let sum = 0;
      for (let i = 0; i < this.buf.length; i++) {
        const v = (this.buf[i] - 128) / 128;
        sum += v * v;
      }
      return Math.min(1, Math.sqrt(sum / this.buf.length) * 5);
    }
    // speechSynthesis не даёт звук в Web Audio — псевдо-липсинк: слоги ~7 Гц + импульс на границе слова
    this.boundaryPulse *= 0.85;
    const t = (performance.now() - this.startedAt) / 1000;
    const syll = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI * 6.5) * Math.sin(t * 2 * Math.PI * 1.3 + 1);
    return Math.min(1, 0.25 + 0.55 * Math.abs(syll) + 0.3 * this.boundaryPulse);
  }
}

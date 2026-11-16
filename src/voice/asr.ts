/**
 * Распознавание речи — интерфейс Asr и два движка:
 *  - WebSpeechAsr (по умолчанию): webkitSpeechRecognition ru-RU. Аудио обрабатывает браузер/ОС
 *    (Chrome — серверы Google, Safari — Apple/на устройстве). Приложение ничего не сохраняет и не отправляет само.
 *  - VoskAsr (?asr=vosk): vosk-browser (Kaldi в WebAssembly), маленькая русская модель — полностью офлайн.
 *    Модель грузится лениво из /models/vosk-ru-small/model.tar.gz (в репозиторий не входит, см. docs/VOICE.md).
 * Режим «держи и говори»: start() на нажатие, stop() на отпускание, авто-стоп по таймауту.
 */
import { asset } from '../core/util';

export type AsrState = 'idle' | 'loading' | 'listening' | 'error';

export interface Asr {
  readonly name: string;
  readonly supported: boolean;
  start(): void;
  stop(): void;
  onResult: (text: string) => void;
  onInterim: (text: string) => void;
  onState: (s: AsrState, msg?: string) => void;
  /** уровень сигнала 0..1 (если движок даёт доступ к звуку) */
  onLevel: (v: number) => void;
}

const MAX_HOLD_MS = 8000;

export class WebSpeechAsr implements Asr {
  readonly name = 'webspeech';
  private rec: any = null;
  private active = false;
  private finalText = '';
  private lastInterim = '';
  private timer = 0;
  onResult = (_: string) => {};
  onInterim = (_: string) => {};
  onState = (_: AsrState, _m?: string) => {};
  onLevel = (_: number) => {};

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
      if (text) this.onResult(text);
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
}

export class VoskAsr implements Asr {
  readonly name = 'vosk';
  readonly supported = typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof WebAssembly !== 'undefined';
  private model: any = null;
  private loading: Promise<any> | null = null;
  private rec: any = null;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: ScriptProcessorNode | null = null;
  private partial = '';
  private final = '';
  private timer = 0;
  private listening = false;
  onResult = (_: string) => {};
  onInterim = (_: string) => {};
  onState = (_: AsrState, _m?: string) => {};
  onLevel = (_: number) => {};

  constructor(private modelUrl = 'models/vosk-ru-small/model.tar.gz', private getCtx: () => AudioContext | null = () => null) {}

  private loadModel() {
    this.loading ??= (async () => {
      this.onState('loading');
      const { createModel } = await import('vosk-browser');
      this.model = await createModel(asset(this.modelUrl));
      return this.model;
    })();
    return this.loading;
  }

  async start() {
    if (this.listening) return;
    this.listening = true;
    try {
      await this.loadModel();
      this.ctx = this.getCtx() ?? new AudioContext();
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
      if (!this.listening) return this.cleanup();
      const rec = new this.model.KaldiRecognizer(this.ctx.sampleRate);
      rec.on('result', (m: any) => {
        const t = m.result?.text ?? '';
        if (t) this.final += t + ' ';
      });
      rec.on('partialresult', (m: any) => {
        this.partial = m.result?.partial ?? '';
        this.onInterim((this.final + this.partial).trim());
      });
      this.rec = rec;
      const src = this.ctx.createMediaStreamSource(this.stream);
      // ScriptProcessor устарел, но работает везде, включая iOS Safari; AudioWorklet — улучшение на потом
      const node = this.ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (e) => {
        const data = e.inputBuffer.getChannelData(0);
        let sum = 0;
        for (let i = 0; i < data.length; i += 16) sum += data[i] * data[i];
        this.onLevel(Math.min(1, Math.sqrt(sum / (data.length / 16)) * 8));
        try {
          rec.acceptWaveform(e.inputBuffer);
        } catch {
          /* ignore */
        }
      };
      src.connect(node);
      node.connect(this.ctx.destination);
      this.node = node;
      this.final = '';
      this.partial = '';
      this.onState('listening');
      this.timer = window.setTimeout(() => this.stop(), MAX_HOLD_MS);
    } catch (e) {
      this.listening = false;
      this.onState('error', /404|fetch|load/i.test(String(e)) ? 'no-model' : String(e));
      this.cleanup();
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
        const text = (this.final + this.partial).trim();
        this.cleanup();
        this.onLevel(0);
        this.onState('idle');
        if (text) this.onResult(text);
      }, 250);
    }, 300);
  }

  private cleanup() {
    this.node?.disconnect();
    this.node = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    try {
      this.rec?.remove();
    } catch {
      /* ignore */
    }
    this.rec = null;
  }
}

export function makeAsr(kind: string | null, getCtx: () => AudioContext | null): Asr {
  if (kind === 'vosk') return new VoskAsr('models/vosk-ru-small/model.tar.gz', getCtx);
  return new WebSpeechAsr();
}

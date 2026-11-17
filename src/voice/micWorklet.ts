/**
 * AudioWorklet микрофона: кадры VAD и 16 кГц для Vosk считаются в потоке звука, главному потоку — одно
 * сообщение на ~85 мс (буферы передаются, не копируются). Вместо ScriptProcessor: тот будил главный поток
 * и конкурировал с рендером AR за кадр (на iOS — ещё и щелчки звука при загруженном главном потоке).
 * Собирается Vite отдельным файлом (`?worker&url`), грузится audioWorklet.addModule.
 */
import { MicDsp, type MicChunk } from './micDsp';

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

class MicTap extends AudioWorkletProcessor {
  private dsp = new MicDsp(sampleRate, (c: MicChunk) => this.port.postMessage(c, [c.pcm.buffer, c.asr.buffer, c.frames.buffer]));
  private on = true;
  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      if (e.data === 'stop') this.on = false;
    };
  }
  process(inputs: Float32Array[][]) {
    if (!this.on) return false;
    const ch = inputs[0]?.[0];
    if (ch && ch.length) this.dsp.push(ch);
    return true;
  }
}

registerProcessor('mic-tap', MicTap);

/**
 * Звук раскраски карты — синтез Web Audio (файлов в спрайте нет):
 *   rattle — баллончик трясут: шарик стучит внутри (щелчки ~9 в секунду, 0,8 с);
 *   ToolSound — шипение баллончика (шум через полосовой фильтр; высота и громкость — от скорости сопла) или шорох
 *               кисти (низкий мягкий шум), включается и гаснет плавно — «пш-ш» с началом и концом мазка.
 */
type Out = (volume: number) => GainNode | null;

function noiseBuffer(ctx: BaseAudioContext, sec = 1.5): AudioBuffer {
  const b = ctx.createBuffer(1, Math.round(ctx.sampleRate * sec), ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}
const buffers = new WeakMap<BaseAudioContext, AudioBuffer>();
const noise = (ctx: BaseAudioContext) => {
  let b = buffers.get(ctx);
  if (!b) buffers.set(ctx, (b = noiseBuffer(ctx)));
  return b;
};

/** «цок-цок-цок»: шарик в баллончике, dur с */
export function rattle(out: Out, dur = 0.8, volume = 0.55) {
  const o = out(volume);
  if (!o) return;
  const ctx = o.context;
  const t0 = ctx.currentTime + 0.01;
  const n = Math.max(3, Math.round(dur * 9));
  for (let i = 0; i < n; i++) {
    const at = t0 + (i / n) * dur + (Math.random() - 0.5) * 0.015;
    const src = ctx.createBufferSource();
    src.buffer = noise(ctx);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2600 + Math.random() * 1600;
    bp.Q.value = 7;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(i % 2 ? 0.7 : 1, at + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
    src.connect(bp).connect(env).connect(o);
    src.start(at, Math.random() * 1.2, 0.07);
  }
  setTimeout(() => o.disconnect(), (dur + 0.4) * 1000);
}

/** непрерывный звук инструмента: on/off с плавным входом, speed — скорость сопла (ширин карты в секунду) */
export class ToolSound {
  private src: AudioBufferSourceNode | null = null;
  private bp: BiquadFilterNode | null = null;
  private env: GainNode | null = null;
  private out: GainNode | null = null;
  private on = false;
  constructor(private make: Out, private tool: 'spray' | 'brush', private volume = 0.5) {}

  private ensure(): boolean {
    if (this.env) return true;
    const o = this.make(this.volume);
    if (!o) return false;
    const ctx = o.context;
    const src = ctx.createBufferSource();
    src.buffer = noise(ctx);
    src.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = this.tool === 'spray' ? 1800 : 250;
    const bp = ctx.createBiquadFilter();
    bp.type = this.tool === 'spray' ? 'bandpass' : 'lowpass';
    bp.frequency.value = this.tool === 'spray' ? 5200 : 1100;
    bp.Q.value = this.tool === 'spray' ? 0.8 : 0.7;
    const env = ctx.createGain();
    env.gain.value = 0;
    src.connect(hp).connect(bp).connect(env).connect(o);
    src.start();
    this.src = src;
    this.bp = bp;
    this.env = env;
    this.out = o;
    return true;
  }

  set(on: boolean, speed = 0) {
    if (!on && !this.env) return;
    if (!this.ensure()) return;
    const ctx = this.env!.context;
    const t = ctx.currentTime;
    const sp = Math.max(0, Math.min(3, speed));
    if (this.tool === 'spray') {
      // быстрее ведёт — выше и громче «пш-ш»
      this.bp!.frequency.setTargetAtTime(4300 + sp * 1300, t, 0.05);
      this.env!.gain.setTargetAtTime(on ? 0.55 + sp * 0.15 : 0, t, on ? (this.on ? 0.06 : 0.02) : 0.05);
    } else {
      this.bp!.frequency.setTargetAtTime(700 + sp * 900, t, 0.06);
      this.env!.gain.setTargetAtTime(on ? 0.12 + sp * 0.35 : 0, t, 0.06);
    }
    this.on = on;
  }

  dispose() {
    try {
      this.src?.stop();
    } catch {
      /* уже остановлен */
    }
    this.out?.disconnect();
    this.src = this.bp = this.env = this.out = null;
    this.on = false;
  }
}

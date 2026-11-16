/**
 * Липсинк: один API для трёх источников виземы:
 *  1) готовые mouth cues (Rhubarb, офлайн при сборке) — точнее всего;
 *  2) рантайм-анализ звука wawa-lipsync — для записей без cues;
 *  3) cues из текста — для speechSynthesis-фоллбэка.
 * Выход: сглаженные веса визем (коартикуляция: переход ~70 мс), доминирующая визема и параметры рта.
 */
import { Lipsync as Wawa } from 'wawa-lipsync';
import { VISEMES, VISEME_SHAPE, WAWA_TO_RHUBARB, cueAt, type MouthCue, type MouthShape, type Viseme } from './visemes';

type Source =
  | { kind: 'none' }
  | { kind: 'cues'; cues: MouthCue[]; clock: () => number; t0: number }
  | { kind: 'wawa'; wawa: Wawa };

export class LipSync {
  readonly weights = Object.fromEntries(VISEMES.map((v) => [v, v === 'X' ? 1 : 0])) as Record<Viseme, number>;
  dominant: Viseme = 'X';
  target: Viseme = 'X';
  readonly shape: MouthShape = { open: 0, wide: 0, round: 0 };
  private src: Source = { kind: 'none' };
  private wawa: Wawa | null = null;
  /** постоянная времени перехода между формами, с */
  tau = 0.07;

  /** cues со своими часами (ctx.currentTime для Web Audio, performance для speechSynthesis) */
  playCues(cues: MouthCue[], clock: () => number) {
    this.src = { kind: 'cues', cues, clock, t0: clock() };
  }

  /** анализ звука в реальном времени: подключаем анализатор wawa к нашему AudioContext */
  playAnalyser(ctx: AudioContext, input: AudioNode) {
    if (!this.wawa) {
      const w = new Wawa({ fftSize: 1024, historySize: 8 }) as any;
      // у wawa свой AudioContext — закрываем его (лимит контекстов на iOS) и подменяем на наш
      try {
        void w.audioContext.close();
      } catch {
        /* ignore */
      }
      w.audioContext = ctx;
      w.analyser = ctx.createAnalyser();
      w.analyser.fftSize = 1024;
      w.dataArray = new Uint8Array(w.analyser.frequencyBinCount);
      w.sampleRate = ctx.sampleRate;
      w.binWidth = ctx.sampleRate / 1024;
      this.wawa = w;
    }
    const w = this.wawa as any;
    w.history = [];
    w.features = null;
    w.state = 'silence';
    input.connect(w.analyser);
    this.src = { kind: 'wawa', wawa: this.wawa! };
  }

  stop() {
    this.src = { kind: 'none' };
  }

  get active() {
    return this.src.kind !== 'none';
  }

  update(dt: number) {
    const s = this.src;
    let t: Viseme = 'X';
    if (s.kind === 'cues') t = cueAt(s.cues, s.clock() - s.t0);
    else if (s.kind === 'wawa') {
      s.wawa.processAudio();
      t = WAWA_TO_RHUBARB[s.wawa.viseme] ?? 'X';
    }
    this.target = t;
    const k = 1 - Math.exp(-dt / this.tau);
    let best: Viseme = 'X', bw = -1;
    this.shape.open = this.shape.wide = this.shape.round = 0;
    for (const v of VISEMES) {
      this.weights[v] += ((v === t ? 1 : 0) - this.weights[v]) * k;
      const w = this.weights[v];
      if (w > bw) {
        bw = w;
        best = v;
      }
      const sh = VISEME_SHAPE[v];
      this.shape.open += sh.open * w;
      this.shape.wide += sh.wide * w;
      this.shape.round += sh.round * w;
    }
    this.dominant = best;
  }
}

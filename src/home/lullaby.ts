/**
 * Колыбельная-подложка, когда кота укрывают одеялом: мягкий аккорд-пэд (две расстроенные синусоиды через фильтр)
 * и тихий колокольчик — своя пентатоническая фраза, ~7 с. Синтез Web Audio на общем контексте приложения
 * (Audio.ctx), громкость низкая, затухает сама; stop() — сразу тише (разбудили).
 */
export interface Lullaby {
  stop(): void;
}

/** ноты фразы: полутоны от ля малой октавы (220 Гц) и доли такта */
const MELODY: [number, number][] = [[12, 1], [9, 1], [7, 2], [9, 1], [12, 1], [14, 2], [12, 1], [9, 1], [7, 3]];
const CHORDS: number[][] = [[0, 7, 12], [-3, 4, 9], [-5, 2, 7], [0, 7, 12]];

export function playLullaby(ctx: AudioContext, out: AudioNode, volume = 0.16, beat = 0.42): Lullaby {
  const t0 = ctx.currentTime + 0.05;
  const master = ctx.createGain();
  master.gain.setValueAtTime(0, t0);
  master.gain.linearRampToValueAtTime(volume, t0 + 1.2);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 1400;
  lp.Q.value = 0.4;
  master.connect(lp).connect(out);
  const hz = (st: number) => 220 * Math.pow(2, st / 12);
  const nodes: AudioScheduledSourceNode[] = [];
  // пэд: аккорд на 4 доли, медленная атака и спад
  const bar = beat * 4;
  CHORDS.forEach((ch, i) => {
    const at = t0 + i * bar;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(0.22, at + bar * 0.45);
    g.gain.linearRampToValueAtTime(0, at + bar * 1.15);
    g.connect(master);
    for (const st of ch)
      for (const det of [-6, 6]) {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = hz(st - 12);
        o.detune.value = det;
        o.connect(g);
        o.start(at);
        o.stop(at + bar * 1.2);
        nodes.push(o);
      }
  });
  // колокольчик: треугольник с быстрым спадом
  let t = t0 + beat;
  for (const [st, d] of MELODY) {
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = hz(st);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.32, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + beat * d * 1.6);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + beat * d * 1.7);
    nodes.push(o);
    t += beat * d;
  }
  const end = Math.max(t, t0 + bar * CHORDS.length) + 0.6;
  master.gain.setValueAtTime(volume, end - 1.6);
  master.gain.linearRampToValueAtTime(0, end);
  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      const now = ctx.currentTime;
      master.gain.cancelScheduledValues(now);
      master.gain.setValueAtTime(master.gain.value, now);
      master.gain.linearRampToValueAtTime(0, now + 0.25);
      for (const n of nodes) {
        try {
          n.stop(now + 0.3);
        } catch {
          /* уже остановлен */
        }
      }
    },
  };
}

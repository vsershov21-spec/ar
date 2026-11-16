declare const process: { env: Record<string, string | undefined>; stderr: { write: (s: string) => void } };
import { it } from 'vitest';
import { CardDetector } from '../../src/tracker/card/detector';
import { renderCardScene, cornerError } from '../helpers/synthCard';

const COLORS: [string, [number, number, number], string][] = [
  ['green', [33, 160, 56], 'doodle'], ['navy', [20, 30, 70], 'gradient'], ['black', [18, 18, 20], 'plain'],
  ['white', [235, 235, 238], 'plain'], ['gold', [200, 165, 90], 'gradient'], ['kids', [120, 60, 200], 'stripes'],
];
it.skipIf(!process.env.EXPLORE)('explore', () => {
  const conds: [string, any][] = (process.env.CONDS ? JSON.parse(process.env.CONDS) : [
    ['base', {}], ['tilt50', { tilt: 50 }], ['tilt65', { tilt: 65 }], ['plain', { bg: 'plain' }], ['dark', { bg: 'dark' }],
    ['white', { bg: 'white' }], ['paper', { bg: 'paper' }], ['clutter', { bg: 'clutter' }], ['finger', { finger: true }],
    ['glare', { glare: true }], ['low', { light: 0.3, noise: 7 }], ['blur2', { blur: 2 }], ['far', { dist: 5.5 }], ['near', { dist: 1.3, tilt: 15 }],
    ['offc', { ox: 0.3, oy: 0.2, dist: 2.4 }],
    ['nocard', { noCard: true }], ['nocard-clutter', { noCard: true, bg: 'clutter' }], ['nocard-paper', { noCard: true, bg: 'paper' }],
  ]);
  const N = Number(process.env.N ?? 12);
  for (const [name, o] of conds) {
    let ok = 0, wrong = 0, errs: number[] = [], ms = 0, miss: string[] = [];
    for (let s = 0; s < N; s++) {
      const col = COLORS[s % COLORS.length];
      const fr = renderCardScene({ tilt: 20 + (s * 7) % 30, yaw: s * 37, dist: 2.2 + (s % 3) * 0.4, noise: 3, blur: 1, card: { rgb: col[1], design: col[2] as any }, ...o, seed: s + 1 });
      const d = new CardDetector();
      const t = performance.now();
      const r = d.process(fr.rgba, fr.w, fr.h, { focal: process.env.NOFOCAL ? undefined : fr.focal, forceDetect: true });
      ms += performance.now() - t;
      if (r.quad && r.score >= 0.5) {
        const e = cornerError(r.quad, fr.corners);
        if (e.max < 5) { ok++; errs.push(e.mean); } else { wrong++; miss.push(`${s}:${col[0]}:wrong${r.score.toFixed(2)}`); }
      } else miss.push(`${s}:${col[0]}${r.quad ? ':' + r.score.toFixed(2) : ''}`);
    }
    const me = errs.length ? errs.reduce((a, b) => a + b) / errs.length : 0;
    process.stderr.write(`\n${name.padEnd(15)} ${ok}/${N} wrong ${wrong} err ${me.toFixed(2)}px ${(ms / N).toFixed(1)}ms  ${miss.join(' ')}`);
  }
}, 600000);

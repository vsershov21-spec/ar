import { describe, expect, it } from 'vitest';
import { TailRig, pickMode, type TailInput } from '../src/character/tailRig';

const base: TailInput = { clip: 'idle_breathe', face: 'neutral', faceEars: 0, additive: [], persona: 'kind', speaking: 0, hipsYawVel: 0, hipsUpVel: 0 };
function seeded(seed = 1) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}
function run(input: Partial<TailInput>, seconds = 4, rig = new TailRig(seeded())) {
  const frames = [];
  for (let t = 0; t < seconds; t += 1 / 60) frames.push(rig.update(1 / 60, { ...base, ...input }));
  return frames;
}

describe('TailRig: выбор режима', () => {
  it('эмоции и клипы', () => {
    expect(pickMode({ clip: 'idle_breathe', face: 'neutral', additive: [] })).toBe('idle');
    expect(pickMode({ clip: 'idle_breathe', face: 'happy', additive: [] })).toBe('wag');
    expect(pickMode({ clip: 'idle_breathe', face: 'sad', additive: [] })).toBe('sad');
    expect(pickMode({ clip: 'idle_breathe', face: 'offended', additive: [] })).toBe('angry');
    expect(pickMode({ clip: 'idle_breathe', face: 'surprised', additive: [] })).toBe('puff');
    expect(pickMode({ clip: 'walk', face: 'happy', additive: [] })).toBe('walk');
    expect(pickMode({ clip: 'run', face: 'neutral', additive: [] })).toBe('run');
    expect(pickMode({ clip: 'dance_glitter', face: 'neutral', additive: [] })).toBe('dance');
    expect(pickMode({ clip: 'sleep_loop', face: 'sleep', additive: [] })).toBe('sleep');
    expect(pickMode({ clip: 'purr_stroke', face: 'purr', additive: [] })).toBe('purr');
    expect(pickMode({ clip: 'poke_tail', face: 'neutral', additive: [] })).toBe('whip');
    expect(pickMode({ clip: 'idle_breathe', face: 'neutral', additive: ['tail_wag'] })).toBe('wag');
    expect(pickMode({ clip: 'idle_breathe', face: 'happy', additive: ['tail_puff'] })).toBe('puff');
  });
});

describe('TailRig: движение', () => {
  it('углы конечны и в пределах при любых входах', () => {
    for (const face of ['neutral', 'happy', 'sad', 'surprised', 'offended', 'listen', 'sleep', 'purr'])
      for (const clip of ['idle_breathe', 'walk', 'run', 'dance_hooligan', 'poke_tail', 'sleep_loop'])
        for (const persona of ['hooligan', 'kind', 'glitter']) {
          const fr = run({ face, clip, persona, hipsYawVel: 10, hipsUpVel: -3 }, 1);
          for (const f of fr) {
            for (const [a, b] of f.tail) {
              expect(Number.isFinite(a) && Math.abs(a) <= 1.2).toBe(true);
              expect(Number.isFinite(b) && Math.abs(b) <= 1.2).toBe(true);
            }
            expect(Math.abs(f.earL[0]) <= 1.2 && Math.abs(f.earR[0]) <= 1.2).toBe(true);
          }
        }
  });

  const range = (fr: ReturnType<typeof run>, seg = 3) => {
    const xs = fr.slice(60).map((f) => f.tail[seg][0]);
    return Math.max(...xs) - Math.min(...xs);
  };
  const meanLift = (fr: ReturnType<typeof run>) => fr.slice(60).reduce((a, f) => a + f.tail[3][1], 0) / (fr.length - 60);

  it('радость машет сильнее покоя, грусть опускает хвост, испуг поднимает', () => {
    expect(range(run({ face: 'happy' }))).toBeGreaterThan(range(run({ face: 'neutral' })) * 1.5);
    expect(meanLift(run({ face: 'sad' }))).toBeLessThan(meanLift(run({ face: 'neutral' })) - 0.1);
    expect(meanLift(run({ face: 'surprised' }))).toBeGreaterThan(meanLift(run({ face: 'neutral' })) + 0.1);
  });

  it('у характеров разная манера', () => {
    const k = range(run({ face: 'happy', persona: 'kind' }));
    const g = range(run({ face: 'happy', persona: 'glitter' }));
    expect(g).toBeGreaterThan(k);
  });

  it('кончик качается сильнее корня (волна)', () => {
    const fr = run({ face: 'happy' });
    expect(range(fr, 3)).toBeGreaterThan(range(fr, 0) * 1.5);
  });

  it('поворот тела отбрасывает хвост в обратную сторону', () => {
    const still = run({}, 0.3, new TailRig(seeded(3)));
    const turn = run({ hipsYawVel: 8 }, 0.3, new TailRig(seeded(3)));
    expect(turn.at(-1)!.tail[3][0]).toBeLessThan(still.at(-1)!.tail[3][0] - 0.05);
  });

  it('уши: прижаты при обиде, торчком при слушании, сами подёргиваются', () => {
    const off = run({ face: 'offended', faceEars: -0.8 });
    const lis = run({ face: 'listen', faceEars: 1 });
    expect(off.at(-1)!.earL[0]).toBeLessThan(-0.2);
    expect(lis.at(-1)!.earL[0]).toBeGreaterThan(0.2);
    const idle = run({}, 12);
    const d = idle.map((f, i) => (i ? Math.abs(f.earL[0] - idle[i - 1].earL[0]) + Math.abs(f.earR[0] - idle[i - 1].earR[0]) : 0));
    expect(Math.max(...d)).toBeGreaterThan(0.01);
  });
});

import { describe, it, expect } from 'vitest';
import { DialogQueue } from '../src/voice/dialog';
import { cuesFromText, cueAt, estimateSpeechSec } from '../src/lipsync/visemes';

const deferred = () => {
  let resolve!: () => void;
  const p = new Promise<void>((r) => (resolve = r));
  return { p, resolve };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('очередь реплик', () => {
  const setup = () => {
    let cancels = 0;
    const log: string[] = [];
    const q = new DialogQueue({ cancel: () => cancels++ });
    const line = (name: string) => {
      const d = deferred();
      return { d, run: () => (log.push(name), d.p) };
    };
    return { q, log, line, cancels: () => cancels };
  };

  it('реакция не перебивает реплику сценария', () => {
    const { q, log, line } = setup();
    const a = line('scenario');
    q.say('scenario', a.run);
    expect(q.say('reaction', line('tap').run)).toBe(false);
    expect(log).toEqual(['scenario']);
  });

  it('реакция перебивает болтовню и другую реакцию', () => {
    const { q, log, line, cancels } = setup();
    q.say('chatter', line('filler').run);
    q.say('reaction', line('tap1').run);
    q.say('reaction', line('tap2').run);
    expect(log).toEqual(['filler', 'tap1', 'tap2']);
    expect(cancels()).toBe(2);
  });

  it('сценарий встаёт в очередь за реакцией и идёт следом', async () => {
    const { q, log, line } = setup();
    const r = line('tap');
    q.say('reaction', r.run);
    q.say('scenario', line('outro').run);
    expect(log).toEqual(['tap']);
    r.d.resolve();
    await tick();
    expect(log).toEqual(['tap', 'outro']);
  });

  it('болтовня — только в тишине', () => {
    const { q, line } = setup();
    q.say('scenario', line('s').run);
    expect(q.say('chatter', line('c').run)).toBe(false);
  });
});

describe('визем из текста (фоллбэк синтеза)', () => {
  it('гласные и губные дают правильные формы, длительность сохраняется', () => {
    const cues = cuesFromText('Мама, ау!', 1.2);
    const vals = cues.map((c) => c.value).join('');
    expect(vals).toContain('A'); // м
    expect(vals).toContain('D'); // а
    expect(vals).toContain('F'); // у
    expect(cues[cues.length - 1].end).toBeCloseTo(1.2, 5);
    expect(cueAt(cues, 0.01)).toBe('A');
    expect(cueAt(cues, 5)).toBe('X');
  });
  it('оценка длительности растёт с длиной фразы', () => {
    expect(estimateSpeechSec('Ты чё, с картой, что ли? Ничего себе.')).toBeGreaterThan(estimateSpeechSec('Йо!'));
  });
});

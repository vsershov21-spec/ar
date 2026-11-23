/**
 * «Просыпайся» голосом: интент wake (content/intents.ru.json) и дрёма на карте — фраза будит кота, как касание
 * («А? Я не спал!», wake_up), «Zzz» гаснет; кот не спит — «доброе утро» / «вставай» — приветствие, не «не понял».
 * Дома эти фразы ловит кровать раньше режиссёра (tests/bed.test.ts).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { matchIntent, grammarPhrases } from '../src/voice/intents';
import { makeChaos } from './helpers/chaos';

const WAKE = ['просыпайся', 'проснись', 'вставай', 'подъём', 'подъем', 'хватит спать', 'не спи', 'проснись котик', 'ну просыпайся', 'пора вставать', 'просыпайса'];

describe('интент wake', () => {
  it.each(WAKE)('«%s» → wake', (p) => expect(matchIntent(p).intent).toBe('wake'));
  it('«доброе утро» — приветствие (словарь), «привет» — не wake', () => {
    expect(matchIntent('доброе утро').intent).toBe('hello');
    expect(matchIntent('привет').intent).toBe('hello');
    expect(matchIntent('хватит').intent).toBe('echo_stop');
    expect(matchIntent('спать').intent).not.toBe('wake');
  });
  it('фразы есть в грамматике Vosk (и «подъём» с «ё»)', () => {
    const g = new Set(grammarPhrases());
    for (const p of ['просыпайся', 'проснись', 'вставай', 'подъем', 'подъём', 'доброе утро']) expect(g.has(p), p).toBe(true);
  });
});

type C = Awaited<ReturnType<typeof makeChaos>>;
let c: C | null = null;
afterEach(() => {
  c?.done();
  c = null;
});
const MET = { met: true, name: 'Маша', persona: 'hooligan', visits: 3 };

async function dozed(seed: number) {
  c = await makeChaos({ memory: MET, seed });
  await c.boot();
  await c.until(c.quiet, 10_000);
  (c.d as unknown as { idleStep(s: string): void }).idleStep('doze');
  await c.until(c.quiet, 5000);
  expect(c.d.dozing).toBe(true);
  return c;
}

describe('дрёма на карте: разбудить голосом', () => {
  for (const [i, phrase] of ['просыпайся', 'проснись', 'вставай', 'подъём', 'доброе утро'].entries()) {
    it(`«${phrase}» будит: wake_up, «Zzz» погашен, не «не понял»`, async () => {
      const c = await dozed(21 + i);
      const t0 = c.T();
      c.d.text(phrase);
      await c.until(c.quiet, 8000);
      expect(c.d.dozing).toBe(false);
      const said = c.spoken.filter((s) => s.t >= t0).map((s) => s.event);
      expect(said).toContain('wake_up');
      expect(said).not.toContain('unknown');
      expect(said).not.toContain('help');
      expect(c.fxLog.filter((x) => x.id === 'zzz' && x.op === 'stop').length).toBeGreaterThan(0);
    });
  }

  it('кот не спит: «вставай» / «доброе утро» — приветствие, не «не понял»', async () => {
    c = await makeChaos({ memory: MET, seed: 31 });
    await c.boot();
    await c.until(c.quiet, 10_000);
    for (const p of ['вставай', 'доброе утро']) {
      const t0 = c.T();
      c.d.text(p);
      await c.until(c.quiet, 8000);
      const said = c.spoken.filter((s) => s.t >= t0).map((s) => s.event);
      expect(said, p).not.toContain('unknown');
      expect(said, p).not.toContain('wake_up');
      expect(c.d.dozing).toBe(false);
    }
  });

  it('другая команда в дрёме («сделай сальто») — просыпается молча и выполняет, без wake_up', async () => {
    const c = await dozed(41);
    const t0 = c.T();
    c.d.text('сделай сальто');
    await c.until(c.quiet, 8000);
    expect(c.d.dozing).toBe(false);
    expect(c.spoken.filter((s) => s.t >= t0).map((s) => s.event)).not.toContain('wake_up');
  });
});

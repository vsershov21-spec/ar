/**
 * BED-05, режиссёр: реплика с valid (кровать привязывает пробуждение к циклу сна) проверяется, когда очередь до неё дошла:
 * цикл сменился («Разбудить» → сразу «Уложить спать») — ни голоса, ни клипа wake_startle поверх позы сна. У всех трёх котов.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { makeDirector } from './helpers/directorHarness';

describe.each(['hooligan', 'kind', 'glitter'])('BED-05: отложенная реплика пробуждения (%s)', (persona) => {
  let h: Awaited<ReturnType<typeof makeDirector>>;
  afterEach(() => h?.done());

  it('ждала очереди, цикл сменился — пропуск без клипа и голоса; цикл тот же — звучит с wake_startle', async () => {
    h = await makeDirector({ memory: { met: true, name: 'Маша', persona } });
    await h.boot();
    await h.until(() => !h.d.queue.busy && !h.voice.speaking, 20_000);
    for (const stale of [true, false]) {
      await h.tick(9000); // реплики не повторяются чаще раза в 8 с
      const from = h.T();
      let cycle = 1;
      const gen = cycle;
      // очередь занята репликой сценария — пробуждение ждёт
      expect(h.d.speakEvent('wake_morning', { force: true, scenario: true })).toBe(true);
      expect(h.d.speakEvent('wake_forced', { force: true, valid: () => cycle === gen })).toBe(true);
      if (stale) cycle++; // «Уложить спать» — новый цикл сна
      await h.until(() => !h.d.queue.busy && !h.voice.speaking, 20_000);
      const said = h.spoken.filter((s) => s.t >= from).map((s) => s.id);
      const forced = said.filter((id) => id.includes('.wake_forced.'));
      const startles = h.clips.filter((c) => c.t >= from && c.clip === 'wake_startle').length;
      if (stale) {
        expect(forced).toEqual([]);
        expect(h.log.some((l) => l.t >= from && l.s.includes('устарела'))).toBe(true);
      } else {
        expect(forced.length).toBe(1);
        expect(startles).toBeGreaterThanOrEqual(1);
      }
    }
  }, 60000);
});

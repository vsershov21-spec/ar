/**
 * Озвученные пузыри пилота (запись ElevenLabs 20.11, voice-src/el_batch_delta_2026-11-20-pilot-bubbles.jsonl):
 *   • «Это я пока не умею. Давай лучше <фирменное>!» (pilot_cut, config/pilot.ts cutRedirect → director.voicedBubble);
 *   • «Чуть позже! Давай ещё немного поиграем со мной.» (pilot_switch_later, scenario/switchGate.ts → director.sayLater).
 * Запись есть — пузырь вместе с голосом (speakEvent, onStart; запись не готова — ждём ≤ 300 мс). mp3 ещё нет на сервере —
 * немой пузырь сразу, как раньше.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { loadVoiced, makeDirector } from './helpers/directorHarness';
import { SwitchCooldown, cutRedirect } from '../src/config/pilot';
import { wireSwitchCooldown } from '../src/scenario/switchGate';
import { VOICE_WARM_WAIT_MS } from '../src/director';

const mem = { met: true, name: 'Маша', persona: 'hooligan', visits: 3 };
type H = Awaited<ReturnType<typeof makeDirector>>;

/** набор озвученного без шести реплик пилота — «mp3 ещё не на сервере» */
function withoutPilot() {
  const v = loadVoiced();
  for (const id of [...v.keys()]) if (id.includes('.pilot_')) v.delete(id);
  return v;
}

/** плеер со стартом звука по onStart: запись готовится load мс (warmLine), звук — через 20 мс после готовности */
function hookStart(h: H, load: number) {
  const v = h.voice as typeof h.voice & { startHook?: boolean; isWarm?: () => boolean; warmLine?: () => Promise<void> };
  const starts: number[] = [];
  v.startHook = true;
  v.isWarm = () => false;
  v.warmLine = () => new Promise((r) => setTimeout(r, load));
  const speak = v.speak.bind(v);
  v.speak = (async (r: { lineId?: string; text: string; template: string }, hooks?: { onStart?: () => void }) => {
    setTimeout(() => {
      starts.push(h.T());
      hooks?.onStart?.();
    }, 20);
    return speak(r);
  }) as typeof v.speak;
  return starts;
}

const cut = (h: H, intent = 'jump') => {
  const r = cutRedirect(h.d.persona.id, intent, () => undefined)!;
  return r.event ? h.d.voicedBubble(r.event, r.text) : h.d.bubble(r.text);
};

describe('пилот: озвученные пузыри', () => {
  let h: H | null = null;
  afterEach(() => {
    h?.done();
    h = null;
  });

  it.each(['hooligan', 'kind', 'glitter'])('pilot_cut (%s): запись есть — пузырь её текстом вместе с голосом', async (persona) => {
    h = await makeDirector({ memory: { ...mem, persona } });
    await h.boot();
    await h.until(() => !h!.d.queue.busy);
    const b0 = h.bubble.length, s0 = h.spoken.length;
    expect(cut(h)).toBe(true);
    await h.tick(300);
    const said = h.spoken.slice(s0);
    expect(said.map((s) => s.id)).toEqual([`${persona}.pilot_cut.01`]);
    const shown = h.bubble.slice(b0).filter((b) => b.on);
    expect(shown.map((b) => b.text)).toEqual([said[0].text]);
    expect(said[0].text).toMatch(/^Это я пока не умею\. Давай лучше /);
  });

  it('pilot_cut: запись не готова — пузырь и звук вместе, не позже чем через 300 мс', async () => {
    h = await makeDirector({ memory: mem });
    await h.boot();
    await h.until(() => !h!.d.queue.busy);
    const starts = hookStart(h, 5000); // сеть «висит» — ждём не дольше VOICE_WARM_WAIT_MS
    const b0 = h.bubble.length;
    const t0 = h.T();
    cut(h);
    await h.tick(1000);
    const shown = h.bubble.slice(b0).filter((b) => b.on);
    expect(shown.length).toBe(1);
    expect(starts.length).toBe(1);
    expect(shown[0].t).toBeGreaterThanOrEqual(starts[0]);
    expect(shown[0].t - t0).toBeLessThanOrEqual(VOICE_WARM_WAIT_MS / 1000 + 0.15);
  });

  it('pilot_cut: mp3 ещё нет на сервере — немой пузырь сразу, без голоса', async () => {
    h = await makeDirector({ memory: mem, voiced: withoutPilot() });
    await h.boot();
    await h.until(() => !h!.d.queue.busy);
    hookStart(h, 5000);
    const b0 = h.bubble.length, s0 = h.spoken.length;
    const t0 = h.T();
    expect(cut(h)).toBe(true);
    const shown = h.bubble.slice(b0).filter((b) => b.on);
    expect(shown.map((b) => b.text)).toEqual(['Это я пока не умею. Давай лучше на скейте покатаюсь!']);
    expect(shown[0].t - t0).toBeLessThanOrEqual(0.01);
    await h.tick(1000);
    expect(h.spoken.slice(s0).some((s) => /pilot_cut/.test(s.id))).toBe(false);
  });

  it('pilot_cut: повтор той же команды за 8 с — пузырь не дублируется', async () => {
    h = await makeDirector({ memory: mem });
    await h.boot();
    await h.until(() => !h!.d.queue.busy);
    const s0 = h.spoken.length;
    cut(h);
    await h.tick(5000);
    cut(h, 'sit');
    await h.tick(1000);
    expect(h.spoken.slice(s0).filter((s) => /pilot_cut/.test(s.id)).length).toBe(1);
  });

  it('pilot_switch_later: запись есть — «Чуть позже! Давай ещё немного поиграем со мной.» голосом; без записи — срок в немом пузыре', async () => {
    for (const voiced of [undefined, withoutPilot()]) {
      h = await makeDirector({ memory: mem, voiced });
      await h.boot();
      await h.until(() => !h!.d.queue.busy);
      const cd = new SwitchCooldown(60_000);
      cd.mark(performance.now());
      const gate = wireSwitchCooldown(h.d, cd, () => performance.now());
      h.d.intentGate = (hh) => gate(hh.type, !!hh.button);
      const b0 = h.bubble.length, s0 = h.spoken.length;
      h.d.action('other');
      await h.tick(200);
      const shown = h.bubble.slice(b0).filter((b) => b.on);
      const said = h.spoken.slice(s0).filter((s) => /pilot_switch_later/.test(s.id));
      expect(shown.length).toBe(1);
      if (!voiced) {
        expect(said.map((s) => s.id)).toEqual(['hooligan.pilot_switch_later.01']);
        expect(shown[0].text).toBe('Чуть позже! Давай ещё немного поиграем со мной.');
      } else {
        expect(said).toEqual([]);
        expect(shown[0].text).toMatch(/^Чуть позже! Другой кот — через \d+ (мин|с)\./);
      }
      expect(h.d.state.dialog?.id).not.toBe('switch');
      h.done();
      h = null;
    }
  });
});

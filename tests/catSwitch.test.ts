/**
 * Смена кота подряд: «смена → смена → смена» без кулдауна (lab) и с кулдауном пилота (/mvp, pilot.switchCooldown).
 * Жалоба с iPhone 21.11: «при второй смене кота не открывался выбор кота» — это кулдаун 3 мин, но кнопка молчала:
 * пузырь «Чуть позже!» глотал дедуп 8 с, а на кнопке не было видно, когда смена снова будет можно.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { makeDirector } from './helpers/directorHarness';
import { SwitchCooldown, cooldownMs, laterText, waitLabel, SWITCH_COOLDOWN_MS } from '../src/config/pilot';
import { wireSwitchCooldown } from '../src/scenario/switchGate';
import { filterSearch } from '../src/config/edition';

const mem = { met: true, name: 'Маша', persona: 'hooligan', visits: 3 };
type H = Awaited<ReturnType<typeof makeDirector>>;

/** кнопка «Другой кот» → «давай» → встряска: кот сменился? */
async function switchOnce(h: H): Promise<{ asked: boolean; changed: boolean }> {
  const before = h.d.persona.id;
  h.d.action('other');
  await h.tick(3000);
  const asked = h.d.state.dialog?.id === 'switch';
  if (asked) {
    h.d.text('давай');
    await h.tick(5000);
    h.d.interaction('shake');
    await h.tick(6000);
  }
  return { asked, changed: h.d.persona.id !== before };
}

/** подключить кулдаун, как app.ts applyEdition (тот же wireSwitchCooldown) */
function pilot(h: H, ms = SWITCH_COOLDOWN_MS) {
  const cd = new SwitchCooldown(ms);
  let changes = 0;
  const gate = wireSwitchCooldown(h.d, cd, () => performance.now(), () => changes++);
  h.d.intentGate = (hh) => gate(hh.type, !!hh.button);
  return { cd, changes: () => changes };
}

const laterBubbles = (h: H, from = 0) => h.bubble.slice(from).filter((b) => b.on && /Чуть позже/.test(b.text));

describe('смена кота подряд', () => {
  let h: H | null = null;
  afterEach(() => {
    h?.done();
    h = null;
  });

  it('без кулдауна (lab): смена → смена → смена — каждый раз вопрос и новый кот', async () => {
    h = await makeDirector({ memory: mem });
    await h.boot();
    await h.until(() => !h!.d.queue.busy);
    const seen = [h.d.persona.id];
    for (let i = 0; i < 3; i++) {
      const r = await switchOnce(h);
      expect(r).toEqual({ asked: true, changed: true });
      seen.push(h.d.persona.id);
      expect(h.d.state.phase).toBe('play');
      expect(h.d.orch.current?.id).not.toBe('switch'); // оркестратор отпустил смену
    }
    expect(seen).toEqual(['hooligan', 'kind', 'glitter', 'hooligan']);
  });

  it('оркестратор держит «switch», пока экран заклеен (кнопки не стартуют поверх наклеек)', async () => {
    h = await makeDirector({ memory: mem });
    await h.boot();
    await h.until(() => !h!.d.queue.busy);
    h.d.text('давай другого');
    await h.tick(6000);
    expect(h.d.state.phase).toBe('switching');
    expect(h.d.orch.current?.id).toBe('switch');
    h.d.interaction('shake');
    await h.tick(3000);
    expect(h.d.orch.current?.id ?? null).not.toBe('switch');
  });

  it('с кулдауном (пилот): вторая смена раньше срока — «Чуть позже!» с временем на КАЖДОЕ нажатие (не молчит), после срока — снова вопрос', async () => {
    h = await makeDirector({ memory: mem });
    await h.boot();
    await h.until(() => !h!.d.queue.busy);
    const { cd } = pilot(h, 60_000);
    expect(await switchOnce(h)).toEqual({ asked: true, changed: true });
    expect(cd.allow(performance.now())).toBe(false);
    // вторая смена через ~14 с: выбора нет, но пузырь «Чуть позже» показан и говорит, когда можно
    let b0 = h.bubble.length;
    const r2 = await switchOnce(h);
    expect(r2).toEqual({ asked: false, changed: false });
    const l1 = laterBubbles(h, b0);
    expect(l1.length).toBe(1);
    expect(l1[0].text).toMatch(/Другой кот — через \d+ с/);
    // нажали ещё раз через 4 с (пузырь уже ушёл) — снова пузырь, а не тишина (раньше дедуп 8 с глотал)
    b0 = h.bubble.length;
    await h.tick(1000);
    h.d.action('other');
    await h.tick(500);
    expect(laterBubbles(h, b0).length).toBe(1);
    // частые нажатия, пока пузырь на экране, его не дублируют
    b0 = h.bubble.length;
    for (let i = 0; i < 3; i++) {
      h.d.action('other');
      await h.tick(800);
    }
    expect(laterBubbles(h, b0).length).toBe(0);
    // голосом тоже «Чуть позже», без смены
    await h.tick(4000);
    b0 = h.bubble.length;
    h.d.text('давай другого');
    await h.tick(500);
    expect(h.d.state.phase).not.toBe('switching');
    expect(laterBubbles(h, b0).length).toBe(1);
    // срок вышел — третья смена идёт как обычно
    await h.until(() => cd.allow(performance.now()), 70_000);
    await h.tick(1000);
    expect(await switchOnce(h)).toEqual({ asked: true, changed: true });
    expect(h.d.persona.id).toBe('glitter');
  }, 30_000);

  it('с кулдауном: смену отменили «нет» на наклейках — кулдаун не тратится, следующая смена сразу', async () => {
    h = await makeDirector({ memory: mem });
    await h.boot();
    await h.until(() => !h!.d.queue.busy);
    const { cd, changes } = pilot(h);
    h.d.text('давай другого');
    await h.tick(5000);
    expect(h.d.state.phase).toBe('switching');
    expect(cd.allow(performance.now())).toBe(false);
    h.d.text('нет');
    await h.tick(2000);
    expect(h.d.persona.id).toBe('hooligan');
    expect(cd.allow(performance.now())).toBe(true);
    expect(changes()).toBeGreaterThanOrEqual(2); // начало и отмена — кнопка пересчитывает таймер
    expect(await switchOnce(h)).toEqual({ asked: true, changed: true });
  });

  it('с кулдауном 0 (?cooldown=0 для /test): смена → смена → смена без «Чуть позже»', async () => {
    h = await makeDirector({ memory: mem });
    await h.boot();
    await h.until(() => !h!.d.queue.busy);
    pilot(h, cooldownMs('?cooldown=0'));
    const b0 = h.bubble.length;
    for (let i = 0; i < 3; i++) expect(await switchOnce(h)).toEqual({ asked: true, changed: true });
    expect(laterBubbles(h, b0).length).toBe(0);
  });
});

describe('кулдаун смены кота: текст, таймер, параметр', () => {
  it('cooldownMs: ?cooldown=<с>, по умолчанию 3 мин', () => {
    expect(cooldownMs('')).toBe(SWITCH_COOLDOWN_MS);
    expect(cooldownMs('?cooldown=10')).toBe(10_000);
    expect(cooldownMs('?cooldown=0')).toBe(0);
    expect(cooldownMs('?cooldown=abc')).toBe(SWITCH_COOLDOWN_MS);
  });
  it('таймер на кнопке и срок в пузыре', () => {
    expect(waitLabel(161_000)).toBe('2:41');
    expect(waitLabel(9_000)).toBe('0:09');
    expect(laterText(150_000)).toMatch(/через 3 мин/);
    expect(laterText(40_000)).toMatch(/через 40 с/);
  });
  it('undo возвращает прошлую отметку', () => {
    const c = new SwitchCooldown(1000);
    c.mark(0);
    c.mark(5000);
    c.undo();
    expect(c.allow(5000)).toBe(true);
  });
  it('?cooldown — только lab и страница /test (в пилоте без ?from=test вырезается)', () => {
    expect(filterSearch('cooldown=5', 'lab').search).toBe('cooldown=5');
    expect(filterSearch('cooldown=5', 'pilot').removed).toContain('cooldown=5');
    expect(filterSearch('cooldown=5&from=test', 'pilot').search).toContain('cooldown=5');
  });
});

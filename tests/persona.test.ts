import { describe, it, expect } from 'vitest';
import { loadTestContent, seeded } from './helpers/content';
import { PersonaContext, semitonesToWebPitch } from '../src/persona/context';
import { LinePicker, NO_REPEAT } from '../src/persona/picker';
import { LineQueue } from '../src/persona/lineQueue';
import { PERSONA_IDS, type PersonaId } from '../src/persona/types';

const content = loadTestContent();
// события только с реакцией (клип/эффект без слов: фирменные действия пилота skate/cocoa/mirror) — без реплик
const events = [...content.events.keys()].filter((ev) => PERSONA_IDS.some((pid) => (content.personas.get(pid)!.lines[ev]?.length ?? 0) > 0));

describe('изоляция характера', () => {
  it('для каждого события и характера — реплика только своего характера', () => {
    for (const pid of PERSONA_IDS) {
      const ctx = new PersonaContext(content, pid, seeded(7));
      const own = new Set(Object.values(ctx.persona.lines).flat().map((l) => l.id));
      for (const ev of events) {
        for (let i = 0; i < 4; i++) {
          const pk = ctx.line(ev, { force: true, name: 'Маша' });
          expect(pk, `${pid}.${ev}`).not.toBeNull();
          expect(pk!.persona).toBe(pid);
          expect(pk!.line.id.startsWith(`${pid}.${ev}.`)).toBe(true);
          expect(own.has(pk!.line.id)).toBe(true);
        }
      }
    }
  });

  it('после смены характера реплики, голос, idle, трюк, наклейки — нового', () => {
    const ctx = new PersonaContext(content, 'hooligan', seeded(3));
    const changes: string[] = [];
    ctx.on('change', (c) => changes.push(`${c.from}→${c.to}`));
    expect(ctx.set('kind')).toBe(true);
    expect(changes).toEqual(['hooligan→kind']);
    expect(ctx.line('intro', { force: true })!.persona).toBe('kind');
    expect(ctx.voice.piperVoice).toBe(content.personas.get('kind')!.voice.piperVoice);
    expect(ctx.voice.rate).toBe(content.personas.get('kind')!.voice.rate);
    expect(ctx.voice.echo.pitchSemitones).toBe(content.personas.get('kind')!.voice.echoPitchSemitones);
    expect(ctx.signature.clip).toBe('kind_bubbles');
    expect(ctx.stickers).toBe(content.personas.get('kind')!.stickers);
    expect(ctx.ambience).toBe('amb_room_kind');
    const kindIdles = new Set(content.personas.get('kind')!.idles.map((i) => i.clip));
    for (let i = 0; i < 50; i++) expect(kindIdles.has(ctx.pickIdle())).toBe(true);
    expect(ctx.set('kind')).toBe(false);
  });

  it('idle выбирается пропорционально весам', () => {
    const ctx = new PersonaContext(content, 'kind', seeded(11));
    const n = new Map<string, number>();
    for (let i = 0; i < 6000; i++) {
      const c = ctx.pickIdle();
      n.set(c, (n.get(c) ?? 0) + 1);
    }
    // idle_breathe ×4 из суммы 11
    expect(n.get('idle_breathe')! / 6000).toBeGreaterThan(0.3);
    expect(n.get('idle_breathe')! / 6000).toBeLessThan(0.43);
  });

  it('смена по кругу: hooligan → kind → glitter → hooligan', () => {
    const ctx = new PersonaContext(content, 'hooligan');
    expect(ctx.next()).toBe('kind');
    expect(ctx.next('kind')).toBe('glitter');
    expect(ctx.next('glitter')).toBe('hooligan');
  });

  it('pitch в полутонах → speechSynthesis', () => {
    expect(semitonesToWebPitch(0)).toBe(1);
    expect(semitonesToWebPitch(12)).toBe(2);
    expect(semitonesToWebPitch(3)).toBeCloseTo(1.189, 2);
  });
});

describe('выбор реплик', () => {
  const p = content.personas.get('hooligan')!;

  it(`без повтора последних ${NO_REPEAT} в событии`, () => {
    const pk = new LinePicker(content, seeded(5));
    const ids: string[] = [];
    for (let i = 0; i < 200; i++) ids.push(pk.pick(p, 'tap_screen', { force: true })!.line.id);
    const n = p.lines.tap_screen.length;
    const win = Math.min(NO_REPEAT, n - 1);
    for (let i = win; i < ids.length; i++) expect(ids.slice(i - win, i)).not.toContain(ids[i]);
  });

  it('cooldownMs: повтор события раньше срока не звучит, force — звучит', () => {
    const pk = new LinePicker(content, seeded(5));
    const cd = content.events.get('joke')!.cooldownMs;
    expect(pk.pick(p, 'joke', { now: 1000 })).not.toBeNull();
    expect(pk.pick(p, 'joke', { now: 1000 + cd - 1 })).toBeNull();
    expect(pk.pick(p, 'joke', { now: 1000 + cd - 1, force: true })).not.toBeNull();
    expect(pk.pick(p, 'joke', { now: 1000 + 2 * cd })).not.toBeNull();
  });

  it('strict: без озвученных вариантов реплики нет; с озвученными — только они', () => {
    const pk = new LinePicker(content, seeded(5));
    expect(pk.pick(p, 'tap_screen', { force: true, prefer: () => false, strict: true })).toBeNull();
    const first = p.lines.tap_screen[0].id;
    for (let i = 0; i < 5; i++) expect(pk.pick(p, 'tap_screen', { force: true, prefer: (l) => l.id === first, strict: true })!.line.id).toBe(first);
    expect(pk.pick(p, 'tap_screen', { force: true, prefer: () => false })).not.toBeNull();
  });

  it('приоритет и interruptible берутся из events.json', () => {
    const pk = new LinePicker(content);
    const sad = pk.pick(p, 'sad', { force: true })!;
    expect(sad.priority).toBe(3);
    expect(sad.interruptible).toBe(false);
    expect(pk.pick(p, 'filler', { force: true })!.priority).toBe(0);
  });

  it('{name} — только если имя есть в словаре names.ru.txt', () => {
    const kind = content.personas.get('kind')!;
    const pk = new LinePicker(content, seeded(2));
    for (let i = 0; i < 30; i++) {
      const a = pk.pick(kind, 'welcome_back', { name: 'Абырвалг', force: true })!;
      expect(a.text).not.toMatch(/\{name\}|Абырвалг/);
      expect(a.line.text).not.toContain('{name}');
    }
    const named = new Set<string>();
    for (let i = 0; i < 30; i++) named.add(pk.pick(kind, 'welcome_back', { name: 'маша', force: true })!.text);
    expect([...named].some((t) => t.includes('Маша'))).toBe(true);
    expect([...named].every((t) => !t.includes('{name}'))).toBe(true);
  });

  it('эмоция → пресет лица из face.json', () => {
    const faces = new Set(content.face.presets.map((f) => f.id));
    const pk = new LinePicker(content);
    for (const pid of PERSONA_IDS)
      for (const ev of events) {
        const l = pk.pick(content.personas.get(pid)!, ev, { force: true, name: 'Маша' })!;
        expect(faces.has(l.face), `${l.line.id}: ${l.face}`).toBe(true);
      }
    // без face в строке и у события — по эмоции; у события есть face — он
    expect(p.lines.yes.find((x) => x.emotion === 'cheeky')!.face).toBe(content.face.emotionToFace.cheeky);
    expect(p.lines.no_name.find((x) => x.emotion === 'neutral')!.face).toBe('wink');
  });

  it('реплика по id', () => {
    const pk = new LinePicker(content);
    const r = pk.byId(content.personas, 'kind.intro.02');
    expect(r?.persona).toBe('kind');
    expect(r?.event).toBe('intro');
    expect(pk.byId(content.personas, 'kind.nope.01')).toBeNull();
  });
});

describe('очередь реплик и смена характера', () => {
  const deferred = () => {
    let resolve!: () => void;
    const p = new Promise<void>((r) => (resolve = r));
    return { p, resolve };
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const setup = () => {
    const log: string[] = [];
    const stops: boolean[] = [];
    let softDone: (() => void) | null = null;
    const q = new LineQueue({
      stop: (soft) => {
        stops.push(soft);
        if (soft) return new Promise<void>((r) => (softDone = r));
      },
    });
    const ds = new Map<string, ReturnType<typeof deferred>>();
    const say = (name: string, persona: PersonaId, priority = 2, interruptible = true) => {
      const d = deferred();
      ds.set(name, d);
      return q.say({ persona, event: name, priority, interruptible, run: () => (log.push(name), d.p) });
    };
    return { q, log, stops, say, ds, finishSoft: () => softDone?.() };
  };

  it('при смене характера очередь старого очищается, звучащая — мягко дорезается до слога', async () => {
    const { q, log, stops, say, finishSoft } = setup();
    say('h1', 'hooligan');
    say('h2', 'hooligan');
    say('h3', 'hooligan');
    expect(log).toEqual(['h1']);
    q.switchPersona('kind');
    expect(stops).toEqual([true]);
    say('k1', 'kind');
    await tick();
    expect(log).toEqual(['h1']); // ждём конец слога
    finishSoft();
    await tick();
    await tick();
    expect(log).toEqual(['h1', 'k1']);
    expect(q.pending.length).toBe(0);
  });

  it('реплики нового характера в очереди сохраняются', () => {
    const { q, say } = setup();
    say('h1', 'hooligan');
    say('k0', 'kind');
    say('h2', 'hooligan');
    q.switchPersona('kind');
    // звучащая h1 дорезается, в очереди остаётся только k0
    expect(q.pending.map((x) => x.event)).toEqual(['k0']);
  });

  it('приоритеты: безопасность перебивает всё, реакция не перебивает неперебиваемый сценарий, фон — только в тишине', async () => {
    const { q, log, stops, say, ds } = setup();
    say('intro', 'kind', 2, false);
    expect(say('tap', 'kind', 1)).toBe(false);
    expect(say('filler', 'kind', 0)).toBe(false);
    expect(say('sad', 'kind', 3, false)).toBe(true);
    expect(stops).toEqual([false]);
    expect(log).toEqual(['intro', 'sad']);
    ds.get('sad')!.resolve();
    await tick();
    await tick();
    expect(q.busy).toBe(false);
    say('ask', 'kind', 2, true);
    expect(say('tap2', 'kind', 1)).toBe(true); // interruptible-сценарий можно перебить касанием
    expect(log.at(-1)).toBe('tap2');
  });

  it('whenIdle — после последней реплики', async () => {
    const { q, say, ds } = setup();
    say('a', 'kind');
    say('b', 'kind');
    let idle = false;
    void q.whenIdle().then(() => (idle = true));
    ds.get('a')!.resolve();
    await tick();
    await tick();
    expect(idle).toBe(false);
    ds.get('b')!.resolve();
    await tick();
    await tick();
    expect(idle).toBe(true);
  });
});

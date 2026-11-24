// @vitest-environment jsdom
/**
 * Кровать кота (src/home/bed.ts, bedFlow.ts): автомат сна (тап во сне не будит, три тапа подряд — будят),
 * время суток (предложения, утро), голосовые фразы, и вместе с HomeMode: Zzz снимаются при уходе из спальни,
 * из дома и при пробуждении, чипы не залипают при смене комнаты.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { STAND_Z, BedMachine, BedOfferRule, TUCK_STEPS, WAKE_STEPS, QUICK_WAKE_STEPS, TAP_WINDOW_MS, OFFER_QUIET_MS, bedIntent, daypart, morningWake, isNight } from '../src/home/bed';
import { HomeMode, type HomeHost } from '../src/home/homeMode';
import { CAT_Z, type Room } from '../src/home/room';
import { loadMemory } from '../src/scenario/memory';
import { ZONES } from '../src/home/zones';
import { BED } from '../src/home/bed';

const TUCK_MS = TUCK_STEPS.reduce((s, x) => s + x.ms, 0);
const WAKE_MS = WAKE_STEPS.reduce((s, x) => s + x.ms, 0);
const QUICK_MS = QUICK_WAKE_STEPS.reduce((s, x) => s + x.ms, 0);

/** прогнать автомат до конца перехода */
function run(m: BedMachine, from: number, ms: number, step = 50) {
  for (let t = from; t <= from + ms; t += step) m.tick(t);
  return from + ms;
}

describe('автомат сна', () => {
  it('уложить: подойти → забраться → лечь → одеяло → спит; второй раз уложить нельзя', () => {
    const m = new BedMachine();
    expect(m.tuck(0, 'chip')).toBe(true);
    expect(m.state).toBe('tucking');
    expect(m.step?.id).toBe('approach');
    const seen: string[] = [];
    for (let t = 0; t <= TUCK_MS + 50; t += 50) for (const e of m.tick(t)) seen.push(e.step?.id ?? e.done!);
    expect(seen).toEqual(['get_into_bed', 'lie_down_side', 'cover', 'asleep']);
    expect(m.state).toBe('asleep');
    expect(m.tuck(TUCK_MS + 100)).toBe(false);
  });

  it('тап во сне не будит: бормочет, второй — ворочается; тишина — спит сколько угодно', () => {
    const m = new BedMachine();
    m.tuck(0);
    let t = run(m, 0, TUCK_MS + 50);
    expect(m.tap(t)).toBe('murmur');
    expect(m.state).toBe('asleep');
    expect(m.tap(t + 400)).toBe('turn');
    expect(m.state).toBe('asleep');
    // долгая тишина: кот сам не просыпается
    t = run(m, t + 400, 10 * 60_000, 1000);
    expect(m.state).toBe('asleep');
  });

  it('три тапа за 1,6 с — просыпается в обратном порядке: одеяло к изножью → потянуться и сесть → спрыгнуть → на место', () => {
    const m = new BedMachine();
    m.sleepNow(0);
    expect(m.tap(1000)).toBe('murmur');
    expect(m.tap(1300)).toBe('turn');
    expect(m.tap(1600)).toBe('wake');
    expect(m.state).toBe('waking');
    expect(m.wakeWhy).toBe('taps');
    const seen: string[] = [];
    expect(m.step?.id).toBe('uncover');
    for (let t = 1600; t <= 1600 + WAKE_MS + 50; t += 50) for (const e of m.tick(t)) seen.push(e.step?.id ?? e.done!);
    expect(m.step).toBeNull(); // шаги уже пройдены в цикле
    expect(seen).toEqual(['wake_stretch_in_bed', 'hop_out_of_bed', 'walk_back', 'awake']);
    expect(m.state).toBe('awake');
  });

  it('медленные тапы (реже окна) не будят; поглаживание не считается', () => {
    const m = new BedMachine();
    m.sleepNow(0);
    for (let i = 1; i <= 8; i++) expect(m.tap(i * (TAP_WINDOW_MS / 2 + 100))).not.toBe('wake');
    expect(m.state).toBe('asleep');
    const m2 = new BedMachine();
    m2.sleepNow(0);
    for (let i = 0; i < 10; i++) expect(m2.tap(100 + i * 50, true)).not.toBe('wake');
    expect(m2.state).toBe('asleep');
  });

  it('в переходе касания без ответа; разбудить можно и пока укладывается', () => {
    const m = new BedMachine();
    m.tuck(0);
    expect(m.tap(100)).toBe('none');
    expect(m.wake(200, 'chip')).toBe(true);
    expect(m.state).toBe('waking');
    expect(m.wake(300, 'chip')).toBe(false);
  });
});

describe('время суток и голос', () => {
  it('точка кота в зоне — та же, что у комнаты', () => {
    expect(STAND_Z).toBe(CAT_Z);
  });

  it('части суток', () => {
    expect(daypart(7)).toBe('morning');
    expect(daypart(12)).toBe('day');
    expect(daypart(14)).toBe('nap');
    expect(daypart(18)).toBe('afternoon');
    expect(daypart(21)).toBe('evening');
    expect(daypart(2)).toBe('night');
    expect(isNight(22)).toBe(true);
    expect(isNight(14)).toBe(false);
  });

  it('предложения: днём «вздремнём?», вечером зевает; раз за сессию; «не хочу» — 10 мин тишины; утром и днём — ничего', () => {
    const base = { state: 'awake' as const, home: true, busy: false };
    const r = new BedOfferRule();
    expect(r.check({ ...base, now: 0, hour: 14, quietMs: 5000 })).toBeNull();
    expect(r.check({ ...base, now: 0, hour: 14, quietMs: OFFER_QUIET_MS })).toBe('nap_offer');
    expect(r.check({ ...base, now: 1, hour: 14, quietMs: OFFER_QUIET_MS })).toBeNull();
    expect(r.check({ ...base, now: 2, hour: 21, quietMs: 0, enteredBedroom: true })).toBe('evening_yawn');
    expect(new BedOfferRule().check({ ...base, now: 0, hour: 9, quietMs: 1e6 })).toBeNull();
    expect(new BedOfferRule().check({ ...base, now: 0, hour: 21, quietMs: 1e6, busy: true })).toBeNull();
    const d = new BedOfferRule();
    d.decline(0);
    expect(d.check({ ...base, now: 60_000, hour: 21, quietMs: 1e6 })).toBeNull();
    expect(d.check({ ...base, now: 11 * 60_000, hour: 21, quietMs: 1e6 })).toBe('evening_yawn');
  });

  it('утро: первый вход за день — кот спит; второй раз в тот же день — нет', () => {
    expect(morningWake(8, '2026-11-18', undefined)).toBe(true);
    expect(morningWake(8, '2026-11-18', '2026-11-18')).toBe(false);
    expect(morningWake(8, '2026-11-19', '2026-11-18')).toBe(true);
    expect(morningWake(14, '2026-11-18', undefined)).toBe(false);
  });

  it('фразы: спать / баю-бай / ложись спать; просыпайся / утро / хватит спать; да / нет', () => {
    for (const t of ['спать', 'Ложись спать!', 'баю-бай', 'баю бай', 'спокойной ночи', 'давай в кроватку']) expect(bedIntent(t), t).toBe('sleep');
    for (const t of ['просыпайся', 'Утро!', 'доброе утро', 'хватит спать', 'не спи', 'вставай']) expect(bedIntent(t), t).toBe('wake');
    expect(bedIntent('да')).toBe('yes');
    expect(bedIntent('не хочу')).toBe('no');
    expect(bedIntent('танцуй')).toBeNull();
  });
});

// ───────────── вместе с HomeMode ─────────────

function fakeRoom() {
  const group = new THREE.Group();
  const anchor = new THREE.Group();
  group.add(anchor);
  const r = {
    group, anchor, light: 1,
    setLight: vi.fn((k: number) => void (r.light = k)),
    showBowl: vi.fn(), bounceBall: vi.fn(), placeAnchor: vi.fn(), update: vi.fn(), dispose: vi.fn(),
  };
  return r;
}

function makeHost() {
  const scene = new THREE.Scene();
  const cardAnchor = new THREE.Group();
  scene.add(cardAnchor);
  const tracker = { anchor: cardAnchor, isTracking: true, withAudio: true, start: vi.fn(() => Promise.resolve()), stop: vi.fn(), reanchor: vi.fn() };
  const director = {
    state: { phase: 'play', appeared: true, cardVisible: true, dialog: null as unknown, paused: false },
    dozing: false,
    ladder: { quiet: 0, quietFor() { return this.quiet; }, reset: vi.fn() },
    queue: { busy: false },
    dispatch: vi.fn(),
    speakEvent: vi.fn(() => true),
    hasVoiced: vi.fn(() => false),
    showLine: vi.fn(() => true),
    action: vi.fn(),
    interaction: vi.fn((k: string) => {
      if (k === 'sleep') director.dozing = true;
      if (k === 'wake_up') director.dozing = false;
    }),
    activity: vi.fn(),
    log: vi.fn(),
  };
  const character = { play: vi.fn(), currentClip: 'idle', face: vi.fn() };
  const stage = {
    root: new THREE.Group(), cfg: { yawFollow: true, height: 1.1 },
    useView: vi.fn(), setMode: vi.fn(), resetPosition: vi.fn(), show: vi.fn(), walking: false,
    anchorScreen: () => ({ x: 195, y: 500 }),
  };
  const uiRoot = document.createElement('div');
  const root = document.createElement('div');
  root.appendChild(uiRoot);
  document.body.appendChild(root);
  const ui = { root: uiRoot, toast: vi.fn(), closeCatalog: vi.fn(), nudge: vi.fn(), hidePressMenu: vi.fn(), error: vi.fn(), canReanchor: true };
  const fx = { play: vi.fn(), stop: vi.fn(), kill: vi.fn(), clearParticles: vi.fn(), filter: null as ((id: string) => boolean) | null };
  const rooms: ReturnType<typeof fakeRoom>[] = [];
  const host: HomeHost = {
    root, scene, renderer: { setClearColor: vi.fn() }, tracker, stage, director, character: () => character, ui,
    audio: { play: vi.fn() }, energy: { activity: vi.fn() }, suggest: vi.fn(), fx,
    buildRoom: () => {
      const r = fakeRoom();
      rooms.push(r);
      return Promise.resolve(r as unknown as Room);
    },
  };
  return { host, director, character, stage, fx, rooms };
}

const tick = async (home: HomeMode, ms: number, step = 50) => {
  for (let t = 0; t < ms; t += step) {
    await vi.advanceTimersByTimeAsync(step);
    home.update(step / 1000, performance.now());
  }
};

async function atHome(hour = 12, zone?: string) {
  vi.setSystemTime(new Date(2026, 10, 18, hour, 0));
  const env = makeHost();
  const home = new HomeMode(env.host, { bed: true });
  if (zone) (home as unknown as { zone: string }).zone = zone;
  home.enter();
  await tick(home, 1200);
  return { ...env, home, bed: home.bed! };
}

async function asleep(hour = 12) {
  const env = await atHome(hour, 'bedroom');
  expect(env.home.zone).toBe('bedroom');
  expect(env.home.chips([]).map((c) => c.id)).toEqual(['home:sleep']);
  env.home.act('home:sleep');
  await tick(env.home, TUCK_MS + 300);
  expect(env.bed.state).toBe('asleep');
  return env;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('кровать в доме', () => {
  it('спальня: кот стоит сбоку от кровати (у изножья), а не перед ней; камера отодвинута — кровать целиком', async () => {
    const { home, rooms } = await atHome(12, 'bedroom');
    const bedroom = ZONES.find((z) => z.id === 'bedroom')!;
    const last = rooms[0].placeAnchor.mock.calls.at(-1)!;
    expect(last[0]).toBe(bedroom.spot!.x);
    expect(last[3]).toBe(bedroom.spot!.z);
    // изножье кровати правее точки кота
    expect(bedroom.x + BED.dx - BED.length / 2).toBeGreaterThan(bedroom.spot!.x + 0.15);
    expect(bedroom.cam!.zoom).toBeGreaterThan(1.5);
    void home;
  });

  it('над спящим — только Zzz: фильтр эффектов; пробуждение убирает Zzz сразу (kill), фильтр снимается', async () => {
    const env = await asleep();
    const fx = env.host.fx as unknown as { filter: ((id: string) => boolean) | null; kill: ReturnType<typeof vi.fn> };
    expect(fx.filter?.('hearts_float')).toBe(false);
    expect(fx.filter?.('zzz')).toBe(true);
    env.home.act('home:wake');
    expect(fx.kill).toHaveBeenCalled();
    expect(fx.kill.mock.calls.some((c) => c[0]('zzz') === true)).toBe(true);
    expect(fx.filter).toBeNull();
  });

  it('«Уложить спать»: кот в кровати, дрёма режиссёра, Zzz, свет ночь, чипы «Разбудить» / «Открыть шторку», реплика пузырём', async () => {
    const { home, bed, director, fx, character, rooms } = await asleep();
    expect(director.dozing).toBe(true);
    expect(fx.play).toHaveBeenCalledWith('zzz');
    expect(bed.zzz).toBe(true);
    expect(character.play).toHaveBeenLastCalledWith('sleep_loop_bed', { loop: true });
    expect(rooms[0].setLight).toHaveBeenLastCalledWith(0.15);
    expect(home.chips([]).map((c) => c.id)).toEqual(['home:wake', 'home:shade']);
    // «укрой меня» без озвучки — пузырём (строгий режим: не голосом)
    expect(director.showLine).toHaveBeenCalledWith('tuck_in');
    expect(director.speakEvent).not.toHaveBeenCalledWith('tuck_in', expect.anything());
  });

  it('тап во сне не будит (бормочет), три тапа подряд — будят; Zzz снимаются, кот на полу', async () => {
    const { home, bed, director, fx } = await asleep();
    expect(home.onTouch('tap_cat', { x: 195, y: 500 })).toBe(true);
    await tick(home, 100);
    expect(bed.state).toBe('asleep');
    expect(director.showLine).toHaveBeenCalledWith('asleep_murmur');
    expect(director.dozing).toBe(true);
    await tick(home, 2000);
    // три быстрых тапа
    home.onTouch('tap_cat');
    await tick(home, 100);
    home.onTouch('tap_cat_head');
    await tick(home, 100);
    expect(bed.state).toBe('asleep');
    home.onTouch('tap_cat_belly');
    expect(bed.state).toBe('waking');
    expect(fx.kill).toHaveBeenCalled();
    expect(bed.zzz).toBe(false);
    expect(director.dozing).toBe(false);
    expect(home.chips([])).toEqual([]);
    await tick(home, WAKE_MS + 200);
    expect(bed.state).toBe('awake');
    expect(director.showLine).toHaveBeenLastCalledWith('wake_forced');
    // касания снова — режиссёру
    expect(home.onTouch('tap_cat')).toBe(false);
    expect(home.chips([]).map((c) => c.id)).toEqual(['home:sleep']);
  });

  it('«Разбудить» — потянулся, спрыгнул, «доброе утро»; карта, лампа, шторка — как днём', async () => {
    const { home, bed, director, rooms } = await asleep();
    await tick(home, 16_000); // поспал подольше — «доброе утро», а не «я только уснул»
    home.act('home:wake');
    expect(bed.state).toBe('waking');
    await tick(home, WAKE_MS + 200);
    expect(bed.state).toBe('awake');
    expect(director.showLine).toHaveBeenLastCalledWith('wake_morning');
    expect(rooms[0].setLight).toHaveBeenLastCalledWith(1);
  });

  it('уход в другую комнату: кот спит в кровати, Zzz сняты, чипов прошлой комнаты нет; вернулись — Zzz снова', async () => {
    const { home, bed, director, fx, rooms } = await asleep();
    const placed = rooms[0].placeAnchor.mock.calls.length;
    expect(home.go('living')).toBe(true);
    expect(director.interaction).not.toHaveBeenCalledWith('wake_up');
    // во время перебежки — без чипов (раньше висели чипы спальни)
    expect(home.chips([])).toEqual([]);
    await tick(home, 1100);
    expect(home.zone).toBe('living');
    expect(bed.state).toBe('asleep');
    expect(bed.zzz).toBe(false);
    expect(fx.kill).toHaveBeenCalled();
    // кот не бежал в гостиную: якорь двигает только кровать (точка спальни)
    for (const c of rooms[0].placeAnchor.mock.calls.slice(placed)) expect(c[0]).toBeGreaterThan(3);
    expect(home.chips([]).map((c) => c.id)).toEqual(['home:to_bed', 'home:wake']);
    // касание пустой гостиной сон не трогает
    expect(home.onTouch('tap_screen', { x: 10, y: 10 })).toBe(true);
    expect(bed.state).toBe('asleep');
    home.act('home:to_bed');
    await tick(home, 1100);
    expect(home.zone).toBe('bedroom');
    expect(bed.zzz).toBe(true);
  });

  it('«Разбудить» из другой комнаты: сначала в спальню, потом будим', async () => {
    const { home, bed } = await asleep();
    home.go('living');
    await tick(home, 1100);
    home.act('home:wake');
    expect(home.zone).toBe('bedroom');
    await tick(home, 1100);
    expect(bed.state).toBe('waking');
  });

  it('«На карту» во сне: Zzz комнаты снимаются, кот дремлет у карты; касание на карте будит — кровать сбрасывается', async () => {
    const { home, bed, director, fx, character } = await asleep();
    fx.kill.mockClear();
    expect(home.exit()).toBe(true);
    expect(fx.kill).toHaveBeenCalled();
    expect(director.interaction).not.toHaveBeenCalledWith('wake_up');
    await tick(home, 1200);
    expect(home.phase).toBe('ar');
    expect(character.play).toHaveBeenLastCalledWith('sleep_loop', { loop: true });
    expect(bed.state).toBe('asleep');
    // на карте — Zzz режиссёра-дрёмы (кот виден)
    expect(bed.zzz).toBe(true);
    // ребёнок тапнул по коту на карте — режиссёр разбудил
    director.dozing = false;
    await tick(home, 100);
    expect(bed.state).toBe('awake');
    expect(bed.zzz).toBe(false);
  });

  it('кнопка-команда во сне (режиссёр разбудил сам): быстро спрыгнуть, без реплики пробуждения', async () => {
    const { home, bed, director } = await asleep();
    director.dozing = false; // director.action → childAct
    await tick(home, 100);
    expect(bed.state).toBe('waking');
    await tick(home, QUICK_MS + 200);
    expect(bed.state).toBe('awake');
    expect(director.showLine).not.toHaveBeenCalledWith('wake_morning');
  });

  it('голос: «ложись спать» в гостиной — кот бежит в спальню и ложится; «просыпайся» — встаёт', async () => {
    const { home, bed } = await atHome(12);
    expect(home.zone).toBe('living');
    expect(home.onText('ложись спать')).toBe(true);
    expect(home.zone).toBe('bedroom');
    await tick(home, 1100 + TUCK_MS + 300);
    expect(bed.state).toBe('asleep');
    expect(home.onText('танцуй')).toBe(true); // во сне — бормочет, не просыпается
    expect(bed.state).toBe('asleep');
    expect(home.onText('мне грустно', true)).toBe(false); // безопасность — режиссёру
    expect(home.onText('просыпайся')).toBe(true);
    expect(bed.state).toBe('waking');
  });

  it('утро: первый вход за день — кот спит в кровати (спальня), шторка будит, «доброе утро»; второй вход — бодрый', async () => {
    const { home, bed, director } = await atHome(8);
    expect(home.zone).toBe('bedroom');
    expect(bed.state).toBe('asleep');
    expect(bed.morning).toBe(true);
    expect(home.chips([]).map((c) => c.id)).toEqual(['home:wake', 'home:shade']);
    expect(loadMemory().home?.morning).toBe('2026-11-18');
    home.act('home:shade');
    expect(bed.state).toBe('waking');
    await tick(home, WAKE_MS + 200);
    expect(director.showLine).toHaveBeenLastCalledWith('wake_morning');
    home.exit();
    await tick(home, 1200);
    home.enter();
    await tick(home, 1200);
    expect(bed.state).toBe('awake');
  });

  it('вечер: тишина — кот зевает и зовёт спать (чипы), «Уложить спать» — «спокойной ночи»', async () => {
    const { home, bed, director } = await atHome(21);
    director.ladder.quiet = 25_000;
    await tick(home, 100);
    expect(bed.offer?.kind).toBe('evening_yawn');
    expect(director.showLine).toHaveBeenCalledWith('evening_yawn');
    expect(home.chips([]).map((c) => c.id)).toEqual(['home:bed_yes', 'home:bed_no']);
    home.act('home:bed_yes');
    await tick(home, 1100 + TUCK_MS + 300);
    expect(bed.state).toBe('asleep');
    expect(director.showLine).toHaveBeenCalledWith('goodnight');
  });

  it('днём «Не хочу» — предложение уходит, чипы зоны', async () => {
    const { home, bed, director } = await atHome(14);
    director.ladder.quiet = 25_000;
    await tick(home, 100);
    expect(bed.offer?.kind).toBe('nap_offer');
    home.act('home:bed_no');
    expect(bed.offer).toBeNull();
    expect(home.chips([]).map((c) => c.id)).toEqual(['home:dance', 'home:ball']);
  });
});

describe('BED-05: отложенное пробуждение не перебивает новый сон', () => {
  it('«Разбудить» → сразу «Уложить спать» × 10: реплика пробуждения прошлого цикла не играет wake_startle поверх сна', async () => {
    const env = await asleep();
    const { home, bed, director, character } = env;
    // озвучено: реплики идут через очередь режиссёра — отложенно (как при занятой очереди / записи, которая грузится)
    director.hasVoiced.mockImplementation(() => true);
    const queue: { event: string; valid?: () => boolean }[] = [];
    director.speakEvent.mockImplementation(((event: string, o?: { valid?: () => boolean }) => (queue.push({ event, valid: o?.valid }), true)) as never);
    const CLIP: Record<string, string> = { wake_forced: 'wake_startle', wake_morning: 'wake_startle', tuck_in: 'yawn', goodnight: 'yawn' };
    /** очередь дошла до реплик: режиссёр играет клип реплики, если она ещё уместна (director.perform → valid) */
    const flush = () => {
      for (const q of queue.splice(0)) if (!q.valid || q.valid()) character.play(CLIP[q.event] ?? 'talk');
    };
    for (let k = 0; k < 10; k++) {
      home.act('home:wake');
      await tick(home, WAKE_MS + 100);
      expect(bed.state).toBe('awake');
      expect(queue.some((q) => /^wake_/.test(q.event))).toBe(true);
      expect(queue.every((q) => !q.valid || q.valid())).toBe(true); // пока кот бодр — реплика уместна
      home.act('home:sleep');
      await tick(home, TUCK_MS + 200);
      expect(bed.state).toBe('asleep');
      character.play.mockClear();
      flush();
      // ни одной реплики пробуждения прошлого цикла; поза сна не перебита
      expect(character.play).not.toHaveBeenCalledWith('wake_startle');
      expect(director.dozing).toBe(true);
    }
  });
});

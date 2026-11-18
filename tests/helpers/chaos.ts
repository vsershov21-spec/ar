/**
 * Хаос-стенд режиссёра (docs/qa/CHAOS.md): поверх directorHarness — настоящий толкователь касаний (TouchInterpreter)
 * и персонаж на настоящем ClipState (как у 3D-кота: петли, одноразовые клипы, возврат в покой), связанные так же,
 * как в app.ts (bindInput / touchCat). Ребёнок «бьёт» по экрану: тапы по зонам кота и мимо, поглаживание, долгое
 * нажатие, кнопки каталога, чипы, фразы. Снимаются метрики: время обработки касания (реальные часы), очередь
 * реплик, кто кого перебил, клипы, эмоции, таймеры.
 *
 *   const c = await makeChaos({ memory: { met: true, persona: 'kind' } });
 *   await c.boot();
 *   await c.storm({ ms: 20_000, rate: [5, 15] });
 *   await c.settle(8000);
 *   c.report()
 */
import { vi } from 'vitest';
import { makeDirector, type HarnessOpts } from './directorHarness';
import { seeded } from './content';
import { TouchInterpreter, type TouchEvent } from '../../src/input/interpreter';
import { ClipState } from '../../src/character/clipState';
import { personaMeta } from '../../src/character/personaMeta';
import type { TouchZone } from '../../src/character/types';
import type { Persona } from '../../src/persona/types';
import { ACTIONS } from '../../src/scenario/actions';

/** экран 390×844, кот — прямоугольник посередине; зоны — как hitZone 3D-кота (грубо) */
export const CAT = { l: 140, r: 250, t: 250, b: 600 };
export function zoneAt(x: number, y: number): TouchZone | null {
  if (x < CAT.l || x > CAT.r || y < CAT.t || y > CAT.b) return null;
  if (y < 330) return 'head';
  if (y < 360 && (x < 165 || x > 225)) return 'cheek';
  if (x > 232 && y > 470) return 'tail';
  if (y > 545) return 'paw';
  if (y > 400) return 'belly';
  return 'body';
}
export const ZONE_PT: Record<string, [number, number]> = {
  head: [195, 290], cheek: [152, 345], belly: [195, 470], paw: [180, 580], tail: [242, 500], body: [195, 380], miss: [40, 300],
};

/** зона → клип тычка, если у характера нет своей реакции (как POKE_CLIP в app.ts) */
const POKE_CLIP: Record<string, string> = {
  tap_cat_head: 'poke_head', tap_cat_cheek: 'poke_cheek', tap_cat_belly: 'poke_belly', tap_cat_paw: 'poke_paw', tap_cat_tail: 'poke_tail',
  poke_combo: 'offended', poke_hard: 'flinch', stroke: 'purr_stroke', stroke_long: 'hug_screen',
};

/** клипы, которые законно держатся долго (сон, ходьба по карте) — не «залипание» */
const LONG_OK = /^(idle|sleep_loop|walk|run)/;

export interface ChaosOpts extends HarnessOpts {
  /** фразы ребёнка и подписи чипов (как будто сказал или нажал) */
  phrases?: string[];
}

export async function makeChaos(o: ChaosOpts = {}) {
  const h = await makeDirector(o);
  const d = h.d;
  const rnd = seeded(o.seed ?? 11);

  // ── персонаж: настоящий ClipState ──
  const plays: { t: number; clip: string; id: string; loop: boolean }[] = [];
  const emos: { t: number; name: string; until: number }[] = [];
  const cs = new ClipState([], seeded(5));
  const ch = {
    kind: 'glb' as const,
    object: {},
    cs,
    get currentClip() {
      return cs.requested;
    },
    async load() {},
    setPersona(p: Persona) {
      cs.setIdles(personaMeta(p.id).idles, p.id);
    },
    play(c: string, opts: { loop?: boolean; onEnd?: () => void } = {}) {
      const id = cs.play(c, opts);
      plays.push({ t: performance.now(), clip: c, id, loop: cs.cur.loop });
    },
    update(dt: number) {
      cs.update(dt);
    },
    setEmotion(name: string, _w = 1, ms = 1500) {
      emos.push({ t: performance.now(), name, until: ms > 0 ? performance.now() + ms : Infinity });
    },
    clearEmotion() {
      const e = emos.at(-1);
      if (e && e.until > performance.now() + 500) e.until = performance.now() + 500;
    },
    face() {},
    setFace() {},
    emote() {},
    setMouth() {},
    lookAt() {},
    reach() {},
    hitTest: () => false,
    posterImage: () => null,
    dispose() {},
  };
  d.setCharacter(ch as never);

  // ── очередь реплик: кто кого перебил ──
  type Meta = { id: number; event: string; priority: number; interruptible: boolean; done: boolean; t: number };
  const accepted: Meta[] = [];
  const interrupts: { victim: Meta; by: Meta; t: number }[] = [];
  const metaOf = new WeakMap<object, Meta>();
  let maxPending = 0;
  let seq = 0;
  const q = d.queue;
  const say = q.say.bind(q);
  (q as { say: typeof q.say }).say = (item) => {
    const m: Meta = { id: ++seq, event: item.event, priority: item.priority, interruptible: item.interruptible, done: false, t: performance.now() };
    const run = item.run;
    const wrapped = async () => {
      try {
        await run();
      } finally {
        m.done = true;
      }
    };
    metaOf.set(wrapped, m);
    const before = q.current;
    const ok = say({ ...item, run: wrapped });
    const after = q.current;
    if (ok) accepted.push(m);
    const bm = before ? metaOf.get(before.run) : undefined;
    if (before && after !== before && bm && !bm.done) interrupts.push({ victim: bm, by: m, t: performance.now() });
    maxPending = Math.max(maxPending, q.pending.length);
    return ok;
  };

  // ── ввод: TouchInterpreter → режиссёр (как App.bindInput / touchCat) ──
  const touchEvents: TouchEvent[] = [];
  const touchCat = (event: string, p: { x?: number; y?: number } = {}) => {
    const has = !!d.persona.reactions?.[event];
    d.interaction(has ? event : 'tap_cat', p);
    if (!has && POKE_CLIP[event]) ch.play(POKE_CLIP[event], { loop: event === 'stroke' });
  };
  const onTouch = (e: TouchEvent) => {
    touchEvents.push(e);
    switch (e.type) {
      case 'tap_cat':
        return touchCat(e.event, e);
      case 'poke_combo':
      case 'poke_hard':
      case 'stroke':
      case 'stroke_long':
        return touchCat(e.type, e);
      case 'stroke_end':
        if (/purr_stroke|hug_screen/.test(ch.currentClip)) ch.play('idle');
        return;
      case 'double_tap':
        if (d.persona.reactions?.double_tap) d.interaction('double_tap', e);
        else (d as unknown as { signature(): void }).signature();
        return;
      case 'tap_screen':
        return d.interaction('tap_screen', e);
      case 'longpress':
        return d.interaction('longpress', e);
      case 'swipe':
        return d.interaction('swipe', { x: e.x, y: e.y, from: e.path[0], path: e.path });
      case 'spam':
        return d.interaction('spam');
    }
  };
  const touch = new TouchInterpreter(onTouch, (x, y) => zoneAt(x, y));

  /** время обработки ввода на «главном потоке», мс (реальные часы, не фейковые) */
  const cost: number[] = [];
  const timed = (f: () => void) => {
    const t0 = process.hrtime.bigint();
    f();
    cost.push(Number(process.hrtime.bigint() - t0) / 1e6);
  };

  // ── кадры: таймеры, промисы, режиссёр, толкователь, персонаж ──
  const frame = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms);
    const t = performance.now();
    timed(() => touch.tick(t));
    d.update(ms / 1000);
    ch.update(ms / 1000);
    maxPending = Math.max(maxPending, q.pending.length);
  };
  const tick = async (ms: number) => {
    for (let left = ms; left > 0; left -= 50) await frame(Math.min(50, left));
  };

  const tap = async (zone: string) => {
    const [x, y] = ZONE_PT[zone];
    timed(() => touch.down(x, y, performance.now()));
    await frame(40);
    timed(() => touch.up(x, y, performance.now()));
  };
  const stroke = async (ms = 1200) => {
    let x = 160, y = 420;
    timed(() => touch.down(x, y, performance.now()));
    for (let k = 0; k < ms / 50; k++) {
      await frame(50);
      x = 160 + ((k * 12) % 70);
      y = 420 + Math.sin(k / 2) * 6;
      timed(() => touch.move(x, y, performance.now()));
    }
    timed(() => touch.up(x, y, performance.now()));
  };
  const longpress = async (ms = 900) => {
    const [x, y] = ZONE_PT.body;
    timed(() => touch.down(x, y, performance.now()));
    for (let k = 0; k < ms / 50; k++) await frame(50);
    timed(() => touch.up(x, y, performance.now()));
  };
  const phrases = o.phrases ?? ['привет', 'танцуй', 'загадай загадку', 'ты классный', 'расскажи шутку', 'как дела', 'сдаюсь', 'да', 'нет', 'камень', 'весёлый', 'абракадабра', 'спой песенку'];
  const buttons = ACTIONS.filter((a) => a !== 'other' && a !== 'sleep');

  type Kind = 'tap' | 'miss' | 'stroke' | 'long' | 'button' | 'chip' | 'phrase';
  const pickKind = (mix: Partial<Record<Kind, number>>): Kind => {
    const e = Object.entries(mix) as [Kind, number][];
    let x = rnd() * e.reduce((s, [, w]) => s + w, 0);
    for (const [k, w] of e) if ((x -= w) < 0) return k;
    return e[0][0];
  };
  const DEFAULT_MIX: Partial<Record<Kind, number>> = { tap: 60, miss: 8, stroke: 8, long: 4, button: 10, chip: 5, phrase: 5 };
  const kinds: Kind[] = [];

  /** буря касаний: rate — касаний в секунду (случайно в диапазоне), mix — доли видов ввода */
  const storm = async (s: { ms: number; rate?: [number, number]; mix?: Partial<Record<Kind, number>>; between?: () => Promise<void> | void }) => {
    const [lo, hi] = s.rate ?? [5, 15];
    const end = performance.now() + s.ms;
    while (performance.now() < end) {
      const k = pickKind(s.mix ?? DEFAULT_MIX);
      kinds.push(k);
      const t0 = performance.now();
      if (k === 'tap') await tap(['head', 'cheek', 'belly', 'paw', 'tail', 'body'][Math.floor(rnd() * 6)]);
      else if (k === 'miss') await tap('miss');
      else if (k === 'stroke') await stroke(600 + rnd() * 1800);
      else if (k === 'long') await longpress();
      else if (k === 'button') timed(() => d.action(buttons[Math.floor(rnd() * buttons.length)]));
      else timed(() => d.text(phrases[Math.floor(rnd() * phrases.length)]));
      await s.between?.();
      const gap = 1000 / (lo + rnd() * (hi - lo)) - (performance.now() - t0);
      if (gap > 0) await tick(Math.round(gap));
    }
  };

  const settle = (ms: number) => tick(ms);
  const timers = () => vi.getTimerCount();
  const idleWaiters = () => ((q as unknown as { idleWaiters: unknown[] }).idleWaiters ?? []).length;
  const listeners = () => {
    const m = (d as unknown as { map: Map<string, Set<unknown>> }).map;
    let n = 0;
    m.forEach((s) => (n += s.size));
    return n;
  };

  /** нарушения правил очереди (docs/scenario/LOGIC.md, «Кто кого прерывает») */
  const badInterrupts = () =>
    interrupts.filter(({ victim: v, by: b }) => {
      if (b.priority <= 0) return true; // фон не перебивает
      if (v.priority >= 3) return true; // безопасность не перебивается
      if (v.priority === 2 && !v.interruptible && b.priority < 3) return true; // неперебиваемый шаг сценария
      if (v.priority === 2 && b.priority === 2) return true; // сценарий за сценарием — по очереди
      return false;
    });

  /** одна и та же реплика два раза подряд (не перебитая первая) */
  const repeats = (from = 0) => {
    const s = h.spoken.filter((x) => x.t >= from);
    const out: string[] = [];
    for (let i = 1; i < s.length; i++) if (s[i].id === s[i - 1].id && !/^echo:/.test(s[i].id)) out.push(`${s[i].id} @${s[i].t}`);
    return out;
  };

  /** клип не покоя, который держится дольше ms (петля реакции без выхода) */
  const stuckClip = () => (LONG_OK.test(cs.cur.id) || cs.idleMode || q.busy || h.voice.speaking ? null : `${ch.currentClip}→${cs.cur.id} ${cs.cur.loop ? 'loop' : ''}`);
  /** эмоция, которая не закончится сама (последняя поставленная — она на лице; «sleep» без срока законна только в дрёме) */
  const stuckEmotion = () => {
    const e = emos.at(-1);
    return e && e.until === Infinity && !(d.dozing && e.name === 'sleep') ? [e.name] : [];
  };

  /** реакции-клипы в секунду: пики (сколько раз в одну секунду кот сменил клип реакции) */
  const clipRate = (from = 0) => {
    const r = plays.filter((p) => p.t >= from && !/^(idle|talk)/.test(p.clip));
    let peak = 0;
    for (let i = 0, j = 0; i < r.length; i++) {
      while (r[i].t - r[j].t > 1000) j++;
      peak = Math.max(peak, i - j + 1);
    }
    return peak;
  };

  const pct = (a: number[], p: number) => {
    const s = [...a].sort((x, y) => x - y);
    return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : 0;
  };

  return {
    ...h, h, ch, cs, plays, emos, accepted, interrupts, touchEvents, cost, touch, kinds,
    tick, frame, tap, stroke, longpress, storm, settle, timers, idleWaiters, listeners, badInterrupts, repeats, stuckClip, stuckEmotion, clipRate,
    maxPending: () => maxPending,
    resetMax: () => void (maxPending = q.pending.length),
    costStats: () => ({ n: cost.length, p50: +pct(cost, 0.5).toFixed(3), p99: +pct(cost, 0.99).toFixed(3), max: +Math.max(0, ...cost).toFixed(3) }),
    async boot() {
      d.dispatch({ type: 'wake' });
      d.dispatch({ type: 'card_found' });
      for (let i = 0; i < 100 && d.state.phase === 'appear'; i++) await tick(100);
    },
    /** кот договорил, очередь пуста */
    quiet: () => !q.busy && !h.voice.speaking,
  };
}

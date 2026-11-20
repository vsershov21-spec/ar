/**
 * Оркестратор действий (src/scenario/orchestrator.ts) и его работа в режиссёре: одно действие, очередь на одно место,
 * блок повторных нажатий, реплика принадлежит своему действию, «Чуть позже!» не по кругу, смена кота не поверх сцены.
 * Жалобы — запись с iPhone 20.11 (docs/qa/ORCHESTRATOR.md).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { LineDedupe, Orchestrator, QUEUE_TTL_MS, REPEAT_MS } from '../src/scenario/orchestrator';
import { makeDirector } from './helpers/directorHarness';

function clock() {
  let t = 1000;
  return { now: () => t, add: (ms: number) => (t += ms) };
}

describe('Orchestrator: правила', () => {
  it('повторное нажатие той же кнопки — не выполняется', () => {
    const c = clock();
    const o = new Orchestrator(c.now);
    expect(o.request('flip').verdict).toBe('start');
    c.add(200);
    expect(o.request('flip').verdict).toBe('repeat');
    c.add(REPEAT_MS);
    // сальто ещё в защищённом окне (minMs 1600) — тоже повтор
    expect(o.request('flip').verdict).toBe('repeat');
  });

  it('номер не вытесняется до minMs: новое действие ждёт и стартует, когда номер кончился', () => {
    const c = clock();
    const o = new Orchestrator(c.now);
    o.request('skate');
    c.add(500);
    expect(o.request('dance').verdict).toBe('queued');
    expect(o.request('flip').verdict).toBe('queued');
    expect(o.pending?.id).toBe('flip'); // одно место — последнее нажатие
    c.add(1000);
    expect(o.tick(true)).toBeNull(); // тело ещё занято
    c.add(5000);
    expect(o.tick(false)).toBe('flip');
    expect(o.current).toBeNull();
  });

  it('ласка вытесняется сразу; у вытесненного снимаются реплики (onCancel)', () => {
    const c = clock();
    const o = new Orchestrator(c.now);
    const cancelled: string[] = [];
    o.onCancel = (a) => cancelled.push(a.id);
    o.request('pet');
    c.add(300);
    const r = o.request('tickle');
    expect(r.verdict).toBe('start');
    expect(cancelled).toEqual(['pet']);
    expect(o.current?.id).toBe('tickle');
  });

  it('очередь устаревает', () => {
    const c = clock();
    const o = new Orchestrator(c.now);
    o.request('skate');
    c.add(100);
    o.request('dance');
    c.add(QUEUE_TTL_MS + 100);
    expect(o.tick(true)).toBeNull();
    expect(o.pending).toBeNull();
  });

  it('сцена снаружи (раскраска): действие ждёт, раскраску просят закончить; переход в дом — просто ждёт', () => {
    const c = clock();
    const o = new Orchestrator(c.now);
    let scene: { id: string; interruptible: boolean } | null = { id: 'paint', interruptible: true };
    const asked: string[] = [];
    o.external = () => scene;
    o.interrupt = (s) => (asked.push(s.id), true);
    expect(o.request('dance').verdict).toBe('queued');
    expect(asked).toEqual(['paint']);
    expect(o.tick(false)).toBeNull();
    scene = null;
    expect(o.tick(false)).toBe('dance');
    scene = { id: 'home', interruptible: false };
    expect(o.request('flip').verdict).toBe('queued');
    expect(asked).toEqual(['paint']);
    expect(o.blocking()).toBe('home');
  });

  it('действие кончается само: тело в покое после minMs или по maxMs', () => {
    const c = clock();
    const o = new Orchestrator(c.now);
    o.request('cocoa');
    c.add(1000);
    o.tick(false);
    expect(o.current?.id).toBe('cocoa'); // minMs 4200
    c.add(3500);
    o.tick(false);
    expect(o.current).toBeNull();
    o.request('dance');
    c.add(20_000);
    o.tick(true);
    expect(o.current).toBeNull();
  });
});

describe('LineDedupe', () => {
  it('одинаковый текст не чаще раза в 8 с', () => {
    const c = clock();
    const d = new LineDedupe(c.now);
    expect(d.allow('Чуть позже! Давай ещё немного поиграем со мной.')).toBe(true);
    c.add(2000);
    expect(d.allow('чуть позже! давай ещё немного поиграем со мной.')).toBe(false);
    expect(d.allow('Другое')).toBe(true);
    c.add(6500);
    expect(d.allow('Чуть позже! Давай ещё немного поиграем со мной.')).toBe(true);
  });
});

type H = Awaited<ReturnType<typeof makeDirector>>;
let h: H | null = null;
afterEach(() => {
  h?.done();
  h = null;
});

describe('режиссёр + оркестратор', () => {
  const mem = { met: true, name: 'Маша', persona: 'hooligan' as const, visits: 3 };

  it('частые нажатия «Сальто» — один номер и одна реплика', async () => {
    h = await makeDirector({ memory: mem });
    await h.boot();
    await h.until(() => !h!.d.queue.busy);
    const n0 = h.spoken.length, c0 = h.clips.length;
    for (let i = 0; i < 5; i++) {
      h.d.action('flip');
      await h.tick(100);
    }
    await h.until(() => !h!.d.queue.busy);
    expect(h.spoken.length - n0).toBeLessThanOrEqual(1);
    expect(h.clips.slice(c0).filter((c) => /flip/.test(c.clip)).length).toBeLessThanOrEqual(1);
  });

  it('«Другой кот» раньше срока: «Чуть позже!» один раз, без вопроса «хочешь, стану другим?»', async () => {
    h = await makeDirector({ memory: mem });
    await h.boot();
    await h.until(() => !h!.d.queue.busy);
    h.d.switchReady = () => false;
    const b0 = h.bubble.length, n0 = h.spoken.length;
    for (let i = 0; i < 4; i++) {
      h.d.action('other');
      await h.tick(900);
    }
    const later = h.bubble.slice(b0).filter((b) => b.on && /Чуть позже/.test(b.text));
    expect(later.length).toBe(1);
    expect(h.spoken.slice(n0).some((s) => /switch_ask/.test(s.event))).toBe(false);
    expect(h.d.state.phase).not.toBe('switching');
  });

  it('новое действие снимает реплики прошлого: реплика всегда своего действия', async () => {
    h = await makeDirector({ memory: mem });
    await h.boot();
    await h.until(() => !h!.d.queue.busy);
    h.d.action('pet');
    await h.tick(200);
    h.d.action('riddle');
    await h.tick(100);
    // в очереди нет реплик «погладить» после старта загадки
    const tok = h.d.orch.token;
    expect(h.d.queue.pending.every((it) => it.owner === undefined || it.owner === tok)).toBe(true);
    expect(h.d.orch.current?.id).toBe('riddle');
  });

  it('смена кота во время сцены снаружи (раскраска) — ждёт её конца, наклейки не поверх', async () => {
    h = await makeDirector({ memory: mem });
    await h.boot();
    await h.until(() => !h!.d.queue.busy);
    let painting = true;
    h.d.orch.external = () => (painting ? { id: 'paint', interruptible: false } : null);
    h.d.text('давай другого');
    await h.tick(300);
    expect(h.d.state.phase).not.toBe('switching');
    painting = false;
    await h.tick(300);
    expect(h.d.state.phase).toBe('switching');
  });
});

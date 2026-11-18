/**
 * Хаотичные тапы ребёнка (docs/qa/CHAOS.md): 5–15 касаний в секунду по зонам кота и мимо, вперемешку с поглаживанием,
 * долгим нажатием, кнопками каталога, чипами и фразами — в свободной игре, посреди реплики, в каждой мини-игре,
 * в знакомстве, в дрёме и при смене кота. Режиссёр, автомат, очередь, толкователь касаний и ClipState — настоящие,
 * время — фейковое (vitest), время обработки касания — по реальным часам.
 *
 * Общие ассерты (после бури и 8 с покоя): очередь реплик не росла, никто не перебил реплику против правил LOGIC.md,
 * одна и та же реплика не звучит два раза подряд, кот в покое (не в петле реакции), эмоции погасли, ожидающих
 * «тишины» обещаний нет, слушателей и таймеров не прибавилось, касание обрабатывается < 2 мс (p99).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { makeChaos } from './helpers/chaos';

type C = Awaited<ReturnType<typeof makeChaos>>;
let c: C | null = null;
afterEach(() => {
  c?.done();
  c = null;
});

const MET = { met: true, name: 'Маша', persona: 'hooligan', visits: 3 };

/** общие проверки после бури: settle — покой, мс (кот договаривает, клипы и эмоции гаснут) */
async function invariants(c: C, base: { timers: number; listeners: number }, o: { settle?: number; maxPending?: number; idleClip?: boolean; clipRate?: number } = {}) {
  await c.settle(o.settle ?? 8000);
  const bad = c.badInterrupts().map((x) => `${x.victim.event}(p${x.victim.priority}${x.victim.interruptible ? '' : '!'}) ← ${x.by.event}(p${x.by.priority})`);
  expect(bad, 'перебивания против правил очереди').toEqual([]);
  expect(c.maxPending(), 'очередь реплик выросла').toBeLessThanOrEqual(o.maxPending ?? 4);
  expect(c.repeats(), 'одна реплика два раза подряд').toEqual([]);
  expect(c.quiet(), 'кот всё ещё говорит после покоя').toBe(true);
  if (o.idleClip !== false) expect(c.stuckClip(), 'клип реакции «залип»').toBeNull();
  expect(c.stuckEmotion(), 'эмоция «залипла»').toEqual([]);
  expect(c.idleWaiters(), 'висят ожидания тишины очереди').toBe(0);
  expect(c.listeners(), 'слушатели режиссёра прибавились').toBe(base.listeners);
  expect(c.timers() - base.timers, 'таймеры копятся').toBeLessThanOrEqual(3);
  const st = c.costStats();
  expect(st.p99, `обработка касания p99 ${st.p99} мс (max ${st.max})`).toBeLessThan(2);
  // кот не «дёргается»: тапы меняют клип не чаще раза в 350 мс, SpamGuard (5 тапов за 2 с → 3 с игнор); кнопки и фразы — сразу
  expect(c.clipRate(), 'смен клипа реакции в секунду').toBeLessThanOrEqual(o.clipRate ?? 8);
}

const baseOf = (c: C) => ({ timers: c.timers(), listeners: c.listeners() });

describe('хаос: свободная игра', () => {
  it('20 с бури (тапы по зонам, мимо, глажка, долгое, кнопки, чипы, фразы) — кот отвечает, ничего не копится', async () => {
    c = await makeChaos({ memory: MET });
    await c.boot();
    await c.until(c.quiet, 10_000);
    const base = baseOf(c);
    const n0 = c.spoken.length;
    await c.storm({ ms: 20_000 });
    expect(c.spoken.length - n0, 'кот вообще отвечал').toBeGreaterThan(3);
    await invariants(c, base);
    expect(['play', 'free']).toContain(c.d.state.phase);
  });

  it('только тапы 15/с по одной зоне: spam → пауза, без лавины реакций', async () => {
    c = await makeChaos({ memory: MET, seed: 3 });
    await c.boot();
    await c.until(c.quiet, 10_000);
    const base = baseOf(c);
    const t0 = c.T();
    await c.storm({ ms: 10_000, rate: [14, 15], mix: { tap: 1 } });
    const said = c.spoken.filter((s) => s.t >= t0);
    // 150 тапов → не больше реплики в секунду
    expect(said.length).toBeLessThanOrEqual(10);
    expect(c.touchEvents.filter((e) => e.type === 'spam').length).toBeGreaterThan(0);
    await invariants(c, base, { clipRate: 4 });
  });

  it('посреди длинной реплики («расскажи сказку») — реакция перебивает, хвостов нет', async () => {
    c = await makeChaos({ memory: MET, seed: 5 });
    await c.boot();
    await c.until(c.quiet, 10_000);
    const base = baseOf(c);
    c.d.text('расскажи сказку');
    await c.tick(600);
    await c.storm({ ms: 6000, rate: [8, 12] });
    await invariants(c, base);
  });
});

describe('хаос: мини-игры', () => {
  for (const g of ['riddle', 'emo', 'rps', 'simon', 'echo'] as const) {
    it(`${g}: касания посреди игры — без слов, игра идёт; потом буря с кнопками — игра закрывается словами`, async () => {
      c = await makeChaos({ memory: MET, seed: 7 });
      await c.boot();
      await c.until(c.quiet, 10_000);
      const base = baseOf(c);
      c.d.action(g);
      expect(await c.until(c.listening, 15_000), `${g}: кот не дождался ответа`).toBe(true);
      const dlg = c.d.state.dialog?.id;
      const n0 = c.spoken.length;
      // только касания: игра не перебивается словами
      await c.storm({ ms: 5000, rate: [6, 12], mix: { tap: 6, miss: 1, stroke: 1, long: 1 } });
      const words = c.spoken.slice(n0).filter((s) => !/riddle|emo|rps|simon|echo|game|listen_|again|hint/.test(s.id));
      expect(words.map((s) => s.id), `${g}: касания перебили игру словами`).toEqual([]);
      // окно ответа истечёт (кот переспросит / закроет игру) — это нормально; если игра ещё идёт, это та же игра
      if (c.d.state.dialog) expect(c.d.state.dialog.id).toBe(dlg);
      // всё вперемешку
      await c.storm({ ms: 12_000 });
      await invariants(c, base, { settle: 25_000, maxPending: 4 });
      // через 25 с покоя игра закончилась словами (или ещё ждёт ответа — но кот молчит и в покое)
      expect(c.d.state.phase === 'play' || c.d.state.phase === 'free').toBe(true);
    });
  }
});

describe('хаос: знакомство', () => {
  it('буря касаний во время знакомства: шаги не перебиваются и не теряются', async () => {
    c = await makeChaos({ seed: 9 });
    await c.boot();
    expect(c.d.state.phase).toBe('ask_name');
    const base = baseOf(c);
    await c.storm({ ms: 8000, rate: [6, 15], mix: { tap: 8, miss: 2, stroke: 1, long: 1, button: 1 } });
    const intro = c.spoken.filter((s) => /meet_card|meet_congrats|ask_name/.test(s.event));
    expect(intro.map((s) => s.event).slice(0, 2)).toEqual(['meet_card', 'meet_congrats']);
    expect(intro.filter((s) => s.interrupted).map((s) => s.id), 'шаг знакомства оборван').toEqual([]);
    c.d.text('Маша');
    expect(await c.until(() => c!.d.state.phase === 'play' && c!.quiet(), 40_000)).toBe(true);
    await invariants(c, base);
  });
});

describe('хаос: дрёма', () => {
  it('первое касание будит один раз («А? Я не спал!»), остальное — обычная игра; «Zzz» погашен', async () => {
    c = await makeChaos({ memory: MET, seed: 13 });
    await c.boot();
    await c.until(c.quiet, 10_000);
    const base = baseOf(c);
    (c.d as unknown as { idleStep(s: string): void }).idleStep('doze');
    await c.until(c.quiet, 5000);
    expect(c.d.dozing).toBe(true);
    const t0 = c.T();
    await c.storm({ ms: 8000, rate: [8, 15], mix: { tap: 1 } });
    expect(c.d.dozing).toBe(false);
    const wakes = c.spoken.filter((s) => s.t >= t0 && s.event === 'wake_up');
    expect(wakes.length).toBeLessThanOrEqual(1);
    expect(c.fxLog.filter((x) => x.id === 'zzz' && x.op === 'stop').length).toBeGreaterThan(0);
    await invariants(c, base);
  });
});

describe('хаос: смена кота', () => {
  it('экран заклеен: буря касаний не ломает смену; без встряски наклейки слетают сами, новый кот здоровается один раз', async () => {
    c = await makeChaos({ memory: MET, seed: 17 });
    await c.boot();
    await c.until(c.quiet, 10_000);
    const base = baseOf(c);
    c.d.text('давай другого');
    expect(c.d.state.phase).toBe('switching');
    const t0 = c.T();
    await c.storm({ ms: 6000, rate: [6, 12], mix: { tap: 6, miss: 2, stroke: 1 } });
    expect(await c.until(() => c!.d.state.phase === 'play', 20_000)).toBe(true);
    expect(c.d.persona.id).toBe('kind');
    expect(c.spoken.filter((s) => s.t >= t0 && s.event === 'hello_new').length).toBe(1);
    await c.storm({ ms: 6000 });
    await invariants(c, base);
  });
});

describe('хаос: найденные баги (docs/qa/BUGS.md № 19–25)', () => {
  it('№ 19: тапы 15/с — реплика на тап не обрывается следующим тапом на полуслове', async () => {
    c = await makeChaos({ memory: MET, seed: 3 });
    await c.boot();
    await c.until(c.quiet, 10_000);
    const t0 = c.T();
    await c.storm({ ms: 8000, rate: [14, 15], mix: { tap: 1 } });
    await c.settle(3000);
    const taps = c.spoken.filter((s) => s.t >= t0 && /^tap_cat/.test(s.event));
    // обрыв раньше 0,9 с — только чем-то главнее тапа (spam, комбо), не следующим тапом
    const cut = taps.filter((s) => s.interrupted && s.end! - s.t < 0.85 && /^tap_cat/.test(c!.spoken[c!.spoken.indexOf(s) + 1]?.event ?? ''));
    expect(cut.map((s) => `${s.id}@${s.t}`)).toEqual([]);
  });

  it('№ 20: смена клипа реакции на тапах — не чаще раза в 350 мс', async () => {
    c = await makeChaos({ memory: MET, seed: 4 });
    await c.boot();
    await c.until(c.quiet, 10_000);
    const p0 = performance.now();
    await c.storm({ ms: 6000, rate: [14, 15], mix: { tap: 1 } });
    const r = c.plays.filter((p) => p.t >= p0 && /^poke_|^laugh|^jump|^wave/.test(p.clip));
    const gaps = r.slice(1).map((p, i) => p.t - r[i].t);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(340);
  });

  it('№ 21: петля реакции (долгое нажатие → press_glass, help → talk_excited) возвращается в покой', async () => {
    c = await makeChaos({ memory: MET, seed: 6 });
    await c.boot();
    await c.until(c.quiet, 10_000);
    await c.longpress();
    expect(c.cs.cur.loop && !c.cs.idleMode).toBe(true);
    await c.settle(5000);
    expect(c.stuckClip()).toBeNull();
    c.d.text('что ты умеешь');
    await c.until(c.quiet, 10_000);
    await c.settle(4000);
    expect(c.stuckClip()).toBeNull();
  });

  it('№ 22: вариант покоя — один проход: дальше снова варианты и «говорящее» тело на репликах', async () => {
    c = await makeChaos({ memory: MET, seed: 8 });
    await c.boot();
    await c.until(c.quiet, 10_000);
    const p0 = performance.now();
    await c.settle(60_000);
    const idles = c.plays.filter((p) => p.t >= p0 && /^idle_/.test(p.clip));
    expect(idles.length).toBeGreaterThanOrEqual(3);
    expect(idles.every((p) => !p.loop)).toBe(true);
    // реплики лестницы тишины в этой минуте — с клипом talk
    expect(c.plays.some((p) => p.t >= p0 && p.clip === 'talk')).toBe(true);
  });

  it('№ 23: дрёма → кнопка будит молча, лицо «сплю» снимается', async () => {
    c = await makeChaos({ memory: MET, seed: 10 });
    await c.boot();
    await c.until(c.quiet, 10_000);
    (c.d as unknown as { idleStep(s: string): void }).idleStep('doze');
    await c.until(c.quiet, 5000);
    expect(c.emos.at(-1)?.name).toBe('sleep');
    c.d.action('riddle');
    expect(c.d.dozing).toBe(false);
    await c.settle(1000);
    expect(c.stuckEmotion()).toEqual([]);
  });

  it('№ 24: игру бросили ради другой — её недосказанные реплики не звучат; та же кнопка — игра заново, без двойного вступления', async () => {
    c = await makeChaos({ memory: MET, seed: 12 });
    await c.boot();
    await c.until(c.quiet, 10_000);
    c.d.action('emo');
    expect(await c.until(c.listening, 15_000)).toBe(true);
    const t0 = c.T();
    // два ответа подряд («не то», «не то» → «это был …», «ещё?») и сразу кнопка другой игры
    c.d.text('абракадабра');
    c.d.text('абракадабра');
    c.d.action('rps');
    await c.until(() => c!.listening(), 20_000);
    expect(c.spoken.filter((s) => s.t >= t0 && !s.interrupted && /^emo_/.test(s.event)).map((s) => s.id)).toEqual([]);
    expect(c.d.state.dialog?.id).toBe('rps');
    // «Повтори движение» дважды подряд
    c.d.action('simon');
    await c.tick(300);
    const t1 = c.T();
    c.d.action('simon');
    await c.until(() => c!.listening(), 20_000);
    expect(c.events(t1).filter((e) => e === 'simon_start').length).toBeLessThanOrEqual(1);
    expect(c.maxPending()).toBeLessThanOrEqual(3);
  });

  it('№ 25: повторялка — ребёнок тараторит: кот повторяет последнее, очередь повторов не копится', async () => {
    c = await makeChaos({ memory: MET, seed: 14 });
    await c.boot();
    await c.until(c.quiet, 10_000);
    c.d.action('echo');
    expect(await c.until(c.listening, 15_000)).toBe(true);
    c.resetMax();
    const t0 = c.T();
    for (const t of ['раз', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь']) {
      c.d.text(t);
      await c.tick(150);
    }
    expect(c.maxPending()).toBeLessThanOrEqual(2);
    await c.until(c.quiet, 15_000);
    const echoes = c.spoken.filter((s) => s.t >= t0 && /^echo:/.test(s.id));
    expect(echoes.length).toBeLessThanOrEqual(3);
    expect(echoes.at(-1)?.text).toBe('семь');
  });

  it('сводка: время обработки ввода (p50 / p99 / max, мс) на 60 с бури', async () => {
    c = await makeChaos({ memory: MET, seed: 21 });
    await c.boot();
    await c.until(c.quiet, 10_000);
    await c.storm({ ms: 60_000 });
    const st = c.costStats();
    expect(c.maxPending(), 'очередь реплик').toBeLessThanOrEqual(4);
    console.info(`[chaos] ввод: ${st.n} вызовов, p50 ${st.p50} мс, p99 ${st.p99} мс, max ${st.max} мс; реплик ${c.spoken.length}, перебиваний ${c.interrupts.length}, макс. очередь ${c.maxPending()}`);
    expect(st.p99).toBeLessThan(2);
  });
});

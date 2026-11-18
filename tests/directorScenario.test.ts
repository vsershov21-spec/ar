/**
 * Сценарии жизни кота на фейковом времени (docs/scenario/LOGIC.md): последовательность действий ребёнка →
 * какие реплики и в каком порядке говорит кот. Контент, озвучка (el_batch_all), автомат, очередь, лестница тишины — настоящие.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { makeDirector } from './helpers/directorHarness';

type H = Awaited<ReturnType<typeof makeDirector>>;
let h: H | null = null;
afterEach(() => {
  h?.done();
  h = null;
});
const ev = (h: H, from = 0) => h.events(from);

describe('знакомство (новый ребёнок)', () => {
  it('проходит полностью и голосом: карта → поздравление → имя → ответ → «я — …» → как играть', async () => {
    h = await makeDirector();
    await h.boot();
    expect(h.d.state.phase).toBe('ask_name');
    expect(await h.until(h.listening)).toBe(true);
    expect(ev(h)).toEqual(['meet_card', 'meet_congrats', 'ask_name']);
    expect(h.listens.at(-1)?.mode).toBe('name');
    h.d.text('Маша');
    await h.until(() => !h!.d.queue.busy && h!.d.state.phase === 'play');
    expect(ev(h)).toEqual(['meet_card', 'meet_congrats', 'ask_name', 'nice_name', 'meet_self', 'meet_skills']);
    // каждая реплика — записью
    for (const s of h.spoken) expect(h.isVoiced('hooligan', s.id, s.text, s.text) || h.voiced.has(s.id), s.id).toBe(true);
    expect(h.d.state.met).toBe(true);
    expect(JSON.parse(localStorage.getItem('sber-ar-cat:v1')!).met).toBe(true);
  });

  it('имя раньше вопроса: вопрос «как тебя зовут?» снимается, шаги после имени не теряются', async () => {
    h = await makeDirector();
    await h.boot();
    await h.tick(500); // кот ещё говорит «это твоя карта?»
    h.d.text('Маша');
    await h.until(() => !h!.d.queue.busy && h!.d.state.phase === 'play');
    const e = ev(h);
    expect(e).not.toContain('ask_name');
    expect(e.slice(-3)).toEqual(['nice_name', 'meet_self', 'meet_skills']);
  });

  it('касания во время знакомства — без слов: шаги знакомства не перебиваются', async () => {
    h = await makeDirector();
    await h.boot();
    await h.tick(800);
    h.d.interaction('tap_cat');
    h.d.interaction('tap_cat_head');
    await h.until(h.listening);
    expect(ev(h)).toEqual(['meet_card', 'meet_congrats', 'ask_name']);
    expect(h.spoken.every((s) => !s.interrupted)).toBe(true);
    expect(h.clips.some((c) => /poke|laugh/.test(c.clip))).toBe(true);
  });

  it('молчит на вопрос имени: переспрашивает один раз, потом «ладно, без имени» и дальше', async () => {
    h = await makeDirector();
    await h.boot();
    await h.until(() => h!.d.state.phase === 'play' && !h!.d.queue.busy, 40_000);
    expect(ev(h)).toEqual(['meet_card', 'meet_congrats', 'ask_name', 'ask_name_again', 'no_name', 'meet_self', 'meet_skills']);
  });
});

describe('повторный визит', () => {
  it('короткое тёплое «с возвращением, Маша» — одна реплика, без знакомства', async () => {
    h = await makeDirector({ memory: { met: true, name: 'Маша', persona: 'kind', visits: 3 } });
    await h.boot();
    await h.until(() => !h!.d.queue.busy);
    expect(h.d.state.phase).toBe('play');
    expect(ev(h)).toEqual(['welcome_back']);
    expect(h.d.persona.id).toBe('kind');
  });
});

describe('лестница тишины: ребёнок молчит 3 минуты', () => {
  it('ты тут? → предлагает занятие → мысль вслух → другое занятие → дрёма; потом тихо, без повторов', async () => {
    h = await makeDirector({ memory: { met: true, name: 'Маша', persona: 'hooligan', visits: 3 } });
    await h.boot();
    const start = h.T();
    await h.tick(180_000);
    const e = ev(h, start).filter((x) => x !== 'welcome_back');
    expect(e).toEqual(['silence', 'offer_riddle', 'filler', 'offer_rps', 'sleep']);
    expect(h.d.dozing).toBe(true);
    // никакая запись не прозвучала дважды
    const ids = h.spoken.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    // между репликами кота сам по себе — не меньше 12 с
    const own = h.spoken.filter((s) => s.t >= start);
    for (let i = 1; i < own.length; i++) expect(own[i].t - own[i - 1].t).toBeGreaterThanOrEqual(12);
  });

  it('дрёма: касание будит («А? Я не спал!»), и лестница начинается заново', async () => {
    h = await makeDirector({ memory: { met: true, name: 'Маша', persona: 'hooligan', visits: 3 } });
    await h.boot();
    await h.tick(130_000);
    expect(h.d.dozing).toBe(true);
    const t = h.T();
    h.d.interaction('tap_cat');
    await h.tick(3000);
    expect(ev(h, t)).toEqual(['wake_up']);
    expect(h.d.dozing).toBe(false);
    await h.tick(12_000);
    expect(ev(h, t)).toEqual(['wake_up', 'silence']);
  });

  // QA-стенд (docs/qa/BUGS.md): «Zzz» — петля, без остановки буквы летали над проснувшимся котом до конца сессии
  it('дрёма: «Zzz» над котом только пока спит — касание или кнопка останавливают петлю', async () => {
    h = await makeDirector({ memory: { met: true, name: 'Маша', persona: 'hooligan', visits: 3 } });
    await h.boot();
    await h.tick(130_000);
    expect(h.d.dozing).toBe(true);
    const zzz = () => h!.fxLog.filter((f) => f.id === 'zzz').map((f) => f.op);
    expect(zzz().at(-1)).toBe('play');
    h.d.interaction('tap_cat');
    await h.tick(1000);
    expect(zzz().at(-1)).toBe('stop');
    // снова заснул — и разбужен кнопкой
    await h.tick(130_000);
    expect(h.d.dozing).toBe(true);
    expect(zzz().at(-1)).toBe('play');
    h.d.action('dance');
    await h.tick(1000);
    expect(h.d.dozing).toBe(false);
    expect(zzz().at(-1)).toBe('stop');
  });

  it('«Усыпи»: проснулся сам — «Zzz» остановлен', async () => {
    h = await makeDirector({ memory: { met: true, name: 'Маша', persona: 'hooligan', visits: 3 } });
    await h.boot();
    await h.tick(3000);
    h.d.action('sleep');
    await h.tick(1000);
    expect(h.fxLog.filter((f) => f.id === 'zzz').at(-1)?.op).toBe('play');
    await h.tick(8000);
    expect(h.d.dozing).toBe(false);
    expect(h.fxLog.filter((f) => f.id === 'zzz').at(-1)?.op).toBe('stop');
  });

  it('«Хочешь загадку?» → «да» → загадка; ответ → похвала → «ещё?» → тишина → кот закрывает игру', async () => {
    h = await makeDirector({ memory: { met: true, name: 'Маша', persona: 'kind', visits: 3 } });
    await h.boot();
    await h.until(() => h!.events().includes('offer_riddle'), 60_000);
    await h.until(h.listening);
    const t = h.T();
    h.d.text('да');
    await h.until(() => h!.d.state.dialog?.listening === 'riddle' && !h!.d.queue.busy);
    expect(ev(h, t)).toEqual(['riddle.r01']);
    h.d.text('кошка');
    await h.until(() => h!.d.state.dialog?.listening === 'intent' && !h!.d.queue.busy);
    await h.tick(7000); // молчит на «ещё одну?»
    await h.until(() => !h!.d.queue.busy && !h!.d.state.dialog);
    expect(ev(h, t)).toEqual(['riddle.r01', 'riddle_right', 'riddle_more', 'riddle_bye']);
  });
});

describe('действие ребёнка главнее болтовни кота', () => {
  it('кнопка во время мысли вслух: реакция сразу, мысль обрывается', async () => {
    h = await makeDirector({ memory: { met: true, name: 'Маша', persona: 'glitter', visits: 3 } });
    await h.boot();
    await h.until(() => h!.d.queue.current?.event === 'silence', 30_000);
    await h.tick(400);
    const t = h.T();
    h.d.action('dance');
    await h.tick(300);
    expect(ev(h, t)).toEqual(['dance']);
    expect(h.spoken.find((s) => s.event === 'silence')!.interrupted).toBe(true);
    // после действия кот сам молчит не меньше 12 с
    await h.tick(11_000);
    expect(ev(h, t)).toEqual(['dance']);
  });

  it('кнопка посреди загадки — не «неверный ответ»: загадка заканчивается, кот танцует', async () => {
    h = await makeDirector({ memory: { met: true, name: 'Маша', persona: 'hooligan', visits: 3 } });
    await h.boot();
    await h.until(() => !h!.d.queue.busy);
    h.d.action('riddle');
    await h.until(h.listening);
    const t = h.T();
    h.d.action('dance');
    await h.tick(8000);
    expect(ev(h, t)).toEqual(['dance']);
    expect(h.d.state.dialog).toBeNull();
  });

  it('кнопки подряд: на каждую — своя реакция, без хвостов прошлых', async () => {
    h = await makeDirector({ memory: { met: true, name: 'Маша', persona: 'kind', visits: 3 } });
    await h.boot();
    await h.until(() => !h!.d.queue.busy);
    const t = h.T();
    for (const id of ['pet', 'tickle', 'dance', 'flip', 'treat']) {
      h.d.action(id);
      await h.tick(1500);
    }
    await h.tick(6000);
    expect(ev(h, t)).toEqual(['stroke', 'tap_cat_belly', 'dance', 'flip', 'treat']);
  });

  it('касание во время загадки — без слов, загадка идёт дальше', async () => {
    h = await makeDirector({ memory: { met: true, name: 'Маша', persona: 'glitter', visits: 3 } });
    await h.boot();
    await h.until(() => !h!.d.queue.busy);
    h.d.text('загадай загадку');
    await h.tick(1500);
    h.d.interaction('tap_cat');
    await h.until(h.listening);
    expect(ev(h).filter((e) => e !== 'welcome_back')).toEqual(['riddle', 'riddle.r01']);
  });

  it('«Удиви» — удивление, а не «кто хлопнул?»; «Подразни» — не «три раза в одно место»', async () => {
    h = await makeDirector({ memory: { met: true, name: 'Маша', persona: 'hooligan', visits: 3 } });
    await h.boot();
    await h.until(() => !h!.d.queue.busy);
    const t = h.T();
    h.d.action('surprise');
    await h.tick(5000);
    h.d.action('tease');
    await h.tick(5000);
    expect(ev(h, t)).toEqual(['surprise', 'tease']);
  });
});

describe('пузырь и озвучка', () => {
  it('пузырь исчезает вместе с концом реплики', async () => {
    h = await makeDirector({ memory: { met: true, name: 'Маша', persona: 'hooligan', visits: 3 } });
    await h.boot();
    await h.until(() => !h!.d.queue.busy);
    const s = h.spoken[0];
    const hide = h.bubble.find((b) => !b.on && b.t >= s.t)!;
    expect(hide.t - s.end!).toBeLessThan(0.3);
  });

  it('событие без озвученных вариантов — кот молчит (ни пузыря, ни робот-голоса), клип реакции остаётся', async () => {
    const { loadVoiced } = await import('./helpers/directorHarness');
    const voiced = loadVoiced();
    for (const id of [...voiced.keys()]) if (id.startsWith('hooligan.tap_cat_tail.')) voiced.delete(id);
    h = await makeDirector({ memory: { met: true, name: 'Маша', persona: 'hooligan', visits: 3 }, voiced });
    await h.boot();
    await h.until(() => !h!.d.queue.busy);
    const t = h.T(), nb = h.bubble.length;
    h.d.interaction('tap_cat_tail');
    await h.tick(3000);
    expect(ev(h, t)).toEqual([]);
    expect(h.bubble.length).toBe(nb);
    expect(h.clips.some((c) => c.t >= t && c.clip === 'poke_tail')).toBe(true);
  });

  it('пока не озвучены вопросы «Хочешь загадку?», кот подсказывает занятие озвученной репликой', async () => {
    const { loadVoiced } = await import('./helpers/directorHarness');
    const voiced = loadVoiced();
    for (const id of [...voiced.keys()]) if (/\.offer_/.test(id)) voiced.delete(id);
    h = await makeDirector({ memory: { met: true, name: 'Маша', persona: 'kind', visits: 3 }, voiced });
    await h.boot();
    await h.tick(40_000);
    expect(ev(h).filter((e) => e !== 'welcome_back')).toEqual(['silence', 'bored']);
  });
});

describe('карта и смена кота', () => {
  it('карта пропала — «где карта?», вернулась — «вот она»; быстрое мигание — без лишних слов', async () => {
    h = await makeDirector({ memory: { met: true, name: 'Маша', persona: 'kind', visits: 3 } });
    await h.boot();
    await h.until(() => !h!.d.queue.busy);
    const t = h.T();
    h.lost();
    await h.tick(5000);
    h.found();
    await h.tick(4000);
    h.lost();
    await h.tick(1000);
    h.found();
    await h.tick(4000);
    expect(ev(h, t)).toEqual(['card_lost', 'card_found']);
  });

  it('другой кот: «переоденусь» → встряска → новый кот здоровается одной репликой', async () => {
    h = await makeDirector({ memory: { met: true, name: 'Маша', persona: 'hooligan', visits: 3 } });
    await h.boot();
    await h.until(() => !h!.d.queue.busy);
    const t = h.T();
    h.d.action('other');
    await h.tick(3000);
    // одно касание «Другой кот» могло быть случайным — кот переспрашивает
    expect(h.d.state.dialog?.id).toBe('switch');
    expect(h.d.state.phase).not.toBe('switching');
    h.d.text('давай');
    await h.tick(5000);
    h.d.interaction('shake');
    await h.tick(6000);
    expect(ev(h, t)).toEqual(['switch_ask', 'switch_start', 'shake_prompt', 'hello_new']);
    expect(h.d.persona.id).toBe('kind');
    expect(h.spoken.at(-1)!.id.startsWith('kind.')).toBe(true);
  });

  it('другой кот: «не надо» или 8 с тишины — смены нет; голосом «давай другого» — сразу', async () => {
    h = await makeDirector({ memory: { met: true, name: 'Маша', persona: 'hooligan', visits: 3 } });
    await h.boot();
    await h.until(() => !h!.d.queue.busy);
    h.d.action('other');
    await h.tick(3000);
    h.d.text('не надо');
    await h.tick(3000);
    expect(h.d.state.dialog).toBeNull();
    expect(h.d.state.phase).toBe('play');
    h.d.action('other');
    await h.tick(14000);
    expect(h.d.state.dialog).toBeNull();
    expect(h.d.state.phase).toBe('play');
    expect(h.d.persona.id).toBe('hooligan');
    h.d.text('давай другого');
    await h.tick(1000);
    expect(h.d.state.phase).toBe('switching');
  });

  it('экран заклеен: «нет» — отмена, кот прежний; без встряски — наклейки сдёргиваются сами', async () => {
    h = await makeDirector({ memory: { met: true, name: 'Маша', persona: 'hooligan', visits: 3 } });
    await h.boot();
    await h.until(() => !h!.d.queue.busy);
    h.d.text('давай другого');
    await h.tick(5000);
    expect(h.d.state.phase).toBe('switching');
    h.d.text('нет');
    await h.tick(2000);
    expect(h.d.state.phase).toBe('play');
    expect(h.d.persona.id).toBe('hooligan');
    h.d.text('давай другого');
    await h.tick(5000);
    expect(h.d.state.phase).toBe('switching');
    await h.tick(17000);
    expect(h.d.state.phase).toBe('play');
    expect(h.d.persona.id).toBe('kind');
  });
});

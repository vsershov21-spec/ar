/**
 * Мини-игры с выбором (docs/scenario/CONTENT_NIGHT.md): угадай эмоцию, камень-ножницы-бумага, повтори движение.
 * Правила LOGIC.md: касания во время игры — без слов, кнопка завершает игру (кроме кнопок движений в «Повтори движение»),
 * конец игры — всегда словами. Плюс частые вопросы ребёнка (где живёшь, что любишь, сказка…) и «мне скучно».
 */
import { describe, it, expect, afterEach } from 'vitest';
import { dialogsFile, loadTestContent } from './helpers/content';
import { gameKey, initialState, makeScenarioConfig, step as rawStep, type Action, type ScenarioEvent, type ScenarioState } from '../src/scenario/machine';
import { matchIntent, grammarPhrases } from '../src/voice/intents';
import { ACTION_ROUTE } from '../src/scenario/actions';
import { OFFERS } from '../src/scenario/initiative';
import { PERSONA_IDS } from '../src/persona/types';
import { makeDirector } from './helpers/directorHarness';

const content = loadTestContent();
// random 0 → кот всегда загадывает первый подходящий вариант (не тот же, что в прошлый раз)
const cfg = makeScenarioConfig(dialogsFile, { random: () => 0 });
const step = (s: ScenarioState, e: ScenarioEvent) => rawStep(s, e, cfg);
const run = (s: ScenarioState, events: ScenarioEvent[]) => {
  const all: Action[] = [];
  for (const e of events) {
    const r = step(s, e);
    s = r.state;
    all.push(...r.actions);
  }
  return { s, all };
};
const says = (a: Action[]) => a.filter((x) => x.type === 'say').map((x) => (x as { key: string }).key);
const heard = (type: string, extra: Record<string, unknown> = {}): ScenarioEvent => ({ type: 'intent', intent: { type, text: type, ...extra } });
const answer = (value: string | null): ScenarioEvent => ({ type: 'game_answer', value, text: String(value) });
const timeout = (s: ScenarioState): ScenarioEvent => ({ type: 'listen_timeout', token: s.listenToken });
const inPlay = () =>
  run(initialState(), [{ type: 'wake' }, { type: 'card_found' }, { type: 'timer', id: 'appear_done' }, { type: 'skip_name' }, { type: 'choose', persona: 'hooligan' }]).s;

describe('контент мини-игр', () => {
  it('у каждого характера есть реплики всех событий игр и предложений', () => {
    const evs = [...content.events.keys()].filter((e) => /^(emo_|rps_|simon_|game_|offer_)/.test(e));
    expect(evs.length).toBeGreaterThan(30);
    for (const pid of PERSONA_IDS) for (const e of evs) expect(content.personas.get(pid)!.lines[e]?.length ?? 0, `${pid}.${e}`).toBeGreaterThan(0);
  });
  it('у каждого предложения из круга OFFERS есть узел диалога offer', () => {
    for (const o of OFFERS) expect(dialogsFile.dialogs.offer.nodes[o], o).toBeTruthy();
  });
  it('по 5 вариантов на частые касания и действия', () => {
    for (const pid of PERSONA_IDS)
      for (const e of ['tap_cat_head', 'tap_cat_belly', 'tap_cat_paw', 'tap_cat_tail', 'stroke', 'treat', 'dance', 'flip', 'double_tap'])
        expect(content.personas.get(pid)!.lines[e].length, `${pid}.${e}`).toBeGreaterThanOrEqual(5);
  });
  it('новые реплики без длинного тире', () => {
    for (const pid of PERSONA_IDS)
      for (const [e, ls] of Object.entries(content.personas.get(pid)!.lines))
        if (/^(emo_|rps_|simon_|game_|offer_(emo|rps|simon)|where_live|likes|friends|tale|friend|how_are_you)/.test(e)) for (const l of ls) expect(l.text, l.id).not.toMatch(/—/);
  });
});

describe('камень-ножницы-бумага', () => {
  it('правила → «раз, два, три» → ответ → кот объявляет выбор и кто выиграл → «ещё?» → нет → конец словами', () => {
    let { s, all } = run(inPlay(), [heard('rps')]);
    expect(s.dialog?.id).toBe('rps');
    expect(s.dialog?.listening).toBe('rps');
    expect(says(all)).toEqual(['rps_start', 'rps_go']);
    const cat = s.game!.pick!;
    expect(['rock', 'scissors', 'paper']).toContain(cat);
    // ребёнок выбирает то, что бьёт выбор кота
    const win = dialogsFile.games!.rps.items.find((i) => i.beats === cat)!.id;
    ({ s, all } = run(s, [answer(win)]));
    expect(says(all)).toEqual([`rps_is_${cat}`, 'rps_win', 'game_more']);
    ({ s, all } = run(s, [heard('no')]));
    expect(says(all)).toEqual(['game_bye']);
    expect(s.dialog).toBeNull();
  });
  it('ничья и поражение; «да» на «ещё?» — новый раунд без правил', () => {
    let { s } = run(inPlay(), [heard('rps')]);
    let r = run(s, [answer(s.game!.pick)]);
    expect(says(r.all)).toContain('rps_draw');
    r = run(r.s, [heard('yes')]);
    expect(says(r.all)).toEqual(['rps_go']);
    const cat = r.s.game!.pick!;
    const lose = dialogsFile.games!.rps.items.find((i) => i.id !== cat && i.beats !== cat)!.id;
    expect(says(run(r.s, [answer(lose)]).all)).toContain('rps_lose');
  });
  it('не разобрали → переспрашивает один раз; тишина → конец словами', () => {
    let { s, all } = run(inPlay(), [heard('rps')]);
    ({ s, all } = run(s, [answer(null)]));
    expect(says(all)).toEqual(['rps_again']);
    ({ s, all } = run(s, [timeout(s)]));
    expect(says(all)).toEqual(['game_bye']);
    expect(s.dialog).toBeNull();
  });
  it('gameKey: камень бьёт ножницы, ножницы — бумагу, бумага — камень', () => {
    const g = (pick: string) => ({ id: 'rps', pick, round: 1, last: null });
    expect(gameKey(cfg, g('scissors'), 'rock')).toBe('win');
    expect(gameKey(cfg, g('paper'), 'scissors')).toBe('win');
    expect(gameKey(cfg, g('rock'), 'paper')).toBe('win');
    expect(gameKey(cfg, g('paper'), 'rock')).toBe('lose');
    expect(gameKey(cfg, g('rock'), 'rock')).toBe('draw');
    expect(gameKey(cfg, g('rock'), '$giveup')).toBe('giveup');
  });
});

describe('угадай эмоцию', () => {
  it('кот показывает эмоцию после вопроса; угадано → похвала → ещё; мимо дважды → «это был …»', () => {
    let { s, all } = run(inPlay(), [heard('emo_game')]);
    expect(s.dialog).toMatchObject({ id: 'emo', listening: 'emo' });
    expect(says(all)).toEqual(['emo_start', 'emo_ask']);
    const pick = s.game!.pick!;
    expect(all.find((a) => a.type === 'game_show')).toMatchObject({ face: expect.any(String) });
    ({ s, all } = run(s, [answer(pick)]));
    expect(says(all)).toEqual(['emo_right', 'game_more']);
    ({ s, all } = run(s, [heard('yes')]));
    expect(says(all)).toEqual(['emo_ask']);
    // новая эмоция — не та же
    expect(s.game!.pick).not.toBe(pick);
    const p2 = s.game!.pick!;
    ({ s, all } = run(s, [answer(pick)]));
    expect(says(all)).toEqual(['emo_wrong']);
    expect(all.some((a) => a.type === 'game_show')).toBe(true); // показывает ещё раз
    ({ s, all } = run(s, [timeout(s)]));
    expect(says(all)).toEqual([`emo_is_${p2}`, 'game_more']);
    ({ s, all } = run(s, [timeout(s)]));
    expect(says(all)).toEqual(['game_bye']);
  });
  it('касание во время игры — без слов, игра идёт', () => {
    const { s } = run(inPlay(), [heard('emo_game')]);
    const r = step(s, { type: 'interaction', kind: 'tap_cat_belly' });
    expect(r.actions).toContainEqual({ type: 'react', event: 'tap_cat_belly', quiet: true });
    expect(r.state.dialog?.id).toBe('emo');
  });
  it('кнопка (танец) завершает игру и выполняется', () => {
    const { s } = run(inPlay(), [heard('emo_game')]);
    const r = step(s, heard('dance', { button: true }));
    expect(r.state.dialog).toBeNull();
    expect(r.actions).toContainEqual({ type: 'react', event: 'dance' });
  });
  it('«мне грустно» посреди игры — поддержка (безопасность главнее)', () => {
    const { s } = run(inPlay(), [heard('emo_game')]);
    const r = step(s, heard('sad'));
    expect(r.state.dialog).toBeNull();
    expect(says(r.actions)).toContain('sad');
  });
});

describe('повтори движение', () => {
  it('кнопка движения — ответ, а не конец игры; три из трёх → победа', () => {
    let { s, all } = run(inPlay(), [heard('simon')]);
    expect(says(all)).toEqual(['simon_start', 'simon_ask']);
    expect(all.find((a) => a.type === 'game_show')).toMatchObject({ event: s.game!.pick });
    for (let i = 1; i <= 3; i++) {
      ({ s, all } = run(s, [heard(s.game!.pick!, { button: true })]));
      if (i < 3) {
        expect(says(all)).toEqual(['simon_right']);
        expect(s.dialog?.listening).toBe('simon');
      } else expect(says(all)).toEqual(['simon_done', 'game_more']);
    }
    ({ s, all } = run(s, [heard('yes')]));
    expect(says(all)).toEqual(['simon_ask']);
    expect(s.game!.round).toBe(1);
  });
  it('не та кнопка → показывает ещё раз; снова мимо → называет движение', () => {
    let { s, all } = run(inPlay(), [heard('simon')]);
    const pick = s.game!.pick!;
    const other = dialogsFile.games!.simon.items.find((i) => i.id !== pick)!.id;
    ({ s, all } = run(s, [heard(other, { button: true })]));
    expect(says(all)).toEqual(['simon_wrong']);
    expect(all.find((a) => a.type === 'game_show')).toMatchObject({ event: pick });
    ({ s, all } = run(s, [heard(other, { button: true })]));
    expect(says(all)).toEqual([`simon_is_${pick}`, 'game_more']);
  });
  it('другая кнопка (загадка) завершает игру и запускает загадку', () => {
    const { s } = run(inPlay(), [heard('simon')]);
    const r = step(s, heard('riddle', { button: true }));
    expect(r.state.dialog?.id).toBe('riddle');
  });
});

describe('предложения и «мне скучно»', () => {
  it('«да» на offer_rps / offer_emo / offer_simon запускает игру с правил', () => {
    for (const [what, first] of [['rps', 'rps_start'], ['emo', 'emo_start'], ['simon', 'simon_start']]) {
      let { s } = run(inPlay(), [{ type: 'offer', what }]);
      expect(s.dialog?.id).toBe('offer');
      const r = run(s, [heard('yes')]);
      expect(r.s.dialog?.id, what).toBe(what);
      expect(says(r.all)[0]).toBe(first);
    }
  });
  it('«мне скучно» — кот предлагает занятие (offer_next)', () => {
    const r = step(inPlay(), heard('bored'));
    expect(r.actions).toContainEqual({ type: 'offer_next' });
  });
  it('кнопки мини-игр в таблице действий', () => {
    expect(ACTION_ROUTE.emo).toEqual({ say: 'emo_game', text: 'угадай эмоцию' });
    expect(ACTION_ROUTE.rps.say).toBe('rps');
    expect(ACTION_ROUTE.simon.say).toBe('simon');
  });
});

describe('голос: частые фразы детей', () => {
  it.each([
    ['где ты живёшь', 'where_live'],
    ['а где твой дом', 'where_live'],
    ['что ты любишь', 'likes'],
    ['какая твоя любимая еда', 'likes'],
    ['у тебя есть друзья', 'friends'],
    ['с кем ты дружишь', 'friends'],
    ['расскажи сказку', 'tale'],
    ['расскажи историю', 'tale'],
    ['давай дружить', 'friend'],
    ['будь моим другом', 'friend'],
    ['как дела', 'how_are_you'],
    ['как у тебя дела', 'how_are_you'],
    ['ты кто', 'name_ask'],
    ['как тебя зовут', 'name_ask'],
    ['мне скучно', 'bored'],
    ['мне грустно', 'sad'],
    ['мне обидно', 'sad'],
    ['пока', 'bye'],
    ['мне надо идти', 'bye'],
    ['угадай эмоцию', 'emo_game'],
    ['давай в камень ножницы бумага', 'rps'],
    ['повтори движение', 'simon'],
    ['повторяй за мной', 'echo_start'],
    ['ты классный', 'compliment'],
  ])('«%s» → %s', (p, i) => expect(matchIntent(p).intent).toBe(i));
  it('у каждого характера есть ответы на новые вопросы', () => {
    for (const pid of PERSONA_IDS)
      for (const e of ['where_live', 'likes', 'friends', 'tale', 'friend', 'how_are_you', 'name_ask'])
        expect(content.personas.get(pid)!.lines[e]?.length ?? 0, `${pid}.${e}`).toBeGreaterThanOrEqual(3);
  });
  it('в играх кот не спрашивает о себе ребёнка и не называет его с родом', () => {
    // ответы на «где живёшь» — про кота, без встречных вопросов
    for (const pid of PERSONA_IDS) for (const l of content.personas.get(pid)!.lines.where_live) expect(l.text).not.toMatch(/\?/);
  });
  it('слова-ответы игр — в грамматике Vosk', () => {
    const g = grammarPhrases();
    for (const w of ['камень', 'ножницы', 'бумага', 'весёлый', 'грустный', 'сонный', 'прыжок', 'сальто', 'где ты живешь', 'расскажи сказку', 'давай дружить'])
      expect(g, w).toContain(w === 'весёлый' ? 'веселый' : w);
  });
});

describe('режиссёр: игры голосом и кнопками', () => {
  type H = Awaited<ReturnType<typeof makeDirector>>;
  let h: H | null = null;
  afterEach(() => {
    h?.done();
    h = null;
  });

  it('камень-ножницы-бумага голосом: «камень» → кот объявляет выбор и итог', async () => {
    h = await makeDirector({ memory: { met: true, name: 'Маша', persona: 'hooligan', visits: 3 } });
    await h.boot();
    await h.until(() => !h!.d.queue.busy);
    h.d.text('давай в камень ножницы бумага');
    await h.until(() => h!.d.state.dialog?.listening === 'rps' && !h!.d.queue.busy);
    expect(h.d.gameChoices()?.options.map((o) => o.label)).toEqual(['Камень', 'Ножницы', 'Бумага']);
    const t = h.T();
    h.d.text('камень');
    await h.until(() => h!.d.state.dialog?.listening === 'intent' && !h!.d.queue.busy);
    const e = h.events(t);
    expect(e[0]).toMatch(/^rps_is_/);
    expect(['rps_win', 'rps_lose', 'rps_draw']).toContain(e[1]);
    expect(e[2]).toBe('game_more');
  });

  it('угадай эмоцию: «грустный» — это ответ, а не «мне грустно»', async () => {
    h = await makeDirector({ memory: { met: true, persona: 'kind', visits: 3 } });
    await h.boot();
    await h.until(() => !h!.d.queue.busy);
    h.d.action('emo');
    await h.until(() => h!.d.state.dialog?.listening === 'emo' && !h!.d.queue.busy);
    h.d.text('ты грустный');
    expect(h.d.state.dialog?.id).toBe('emo');
    h.d.text('мне грустно');
    expect(h.d.state.dialog).toBeNull();
    await h.until(() => !h!.d.queue.busy);
    expect(h.events()).toContain('sad');
  });

  it('повтори движение: кнопка «Прыгни» — ответ; конец игры словами', async () => {
    h = await makeDirector({ memory: { met: true, persona: 'glitter', visits: 3 } });
    await h.boot();
    await h.until(() => !h!.d.queue.busy);
    h.d.action('simon');
    await h.until(() => h!.d.state.dialog?.listening === 'simon' && !h!.d.queue.busy);
    const pick = h.d.state.game!.pick!;
    // клип движения показан после реплики
    expect(h.clips.length).toBeGreaterThan(0);
    h.d.action(pick as never);
    expect(h.d.state.dialog?.id).toBe('simon');
    await h.until(() => !h!.d.queue.busy);
    expect(h.events()).toContain('simon_right');
    // тишина до конца: показ ещё раз → «это был …» → «ещё?» → «ладно, потом»
    await h.until(() => !h!.d.state.dialog && !h!.d.queue.busy, 60_000);
    expect(h.events().at(-1)).toBe('game_bye');
  });

  it('«мне скучно» — кот сразу предлагает занятие', async () => {
    h = await makeDirector({ memory: { met: true, persona: 'hooligan', visits: 3 } });
    await h.boot();
    await h.until(() => !h!.d.queue.busy);
    const t = h.T();
    h.d.text('мне скучно');
    await h.until(() => !h!.d.queue.busy);
    expect(h.events(t)[0]).toMatch(/^offer_/);
    expect(h.d.state.dialog?.id).toBe('offer');
  });
});

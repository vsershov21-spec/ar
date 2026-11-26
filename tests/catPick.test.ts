import { describe, it, expect } from 'vitest';
import { initialState, step as rawStep, makeScenarioConfig, withPick, PICK_INTRO_MS, type ScenarioEvent, type ScenarioState, type Action } from '../src/scenario/machine';
import { validateDialogs } from '../src/scenario/dialogs';
import { awakePlan } from '../src/awake/timeline';
import { SKATE_SHOW_ORDER, SKATE_SHOW_TOTAL, SHOW_RIDE_FROM, SHOW_RIDE_TO } from '../src/character/skateTiming';
import { skatePose, BOARD, FEET_ON_DECK } from '../src/character/skateRig';
import { APPEAR_ATTR } from '../src/config/pilot';
import { PICK_LINE, PICK_TITLE } from '../src/director';
import { dialogsFile } from './helpers/content';
import events from '../content/events.json';

const eventIds = new Set((events as unknown as { events: { id: string }[] }).events.map((e) => e.id));

// выбор кота листом (feature pilot.catPick, 26.11): три разных кота — после имени и позже «Позвать другого кота»
const cfg = makeScenarioConfig(dialogsFile, { random: () => 0.5, pickCat: true });
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
const has = (a: Action[], type: string, extra: Record<string, unknown> = {}) => a.some((x) => x.type === type && Object.entries(extra).every(([k, v]) => (x as any)[k] === v));
const says = (a: Action[]) => a.filter((x) => x.type === 'say').map((x) => (x as { key: string }).key);
const toName: ScenarioEvent[] = [{ type: 'wake' }, { type: 'card_found' }, { type: 'timer', id: 'appear_done' }];
const playing = (persona: 'hooligan' | 'kind' | 'glitter' = 'hooligan') => run(initialState({ met: true, persona, visits: 3 }), toName).s;

describe('выбор кота: знакомство', () => {
  it('диалоги с выбором валидны (узлы pick, pick_wait, pick_auto, диалог pick)', () => {
    const f = withPick(dialogsFile);
    expect(validateDialogs(f, eventIds)).toEqual([]);
    expect(f.dialogs.intro.nodes.nice.next).toBe('pick');
    expect(f.dialogs.intro.nodes.noname.next).toBe('pick');
    expect(f.dialogs.pick).toBeTruthy();
    // общий контент не тронут (lab/mvp без pilot.catPick — как было)
    expect(dialogsFile.dialogs.intro.nodes.nice.next).toBe('self');
  });

  it('после «Пропустить»: лист «Выбери своего кота» → выбран Добряк → вспышка, он знакомится сам → игра', () => {
    let { s, all } = run(initialState(), [...toName, { type: 'skip_name' }]);
    expect(s.phase).toBe('choose');
    expect(has(all, 'offer_pick', { where: 'intro' })).toBe(true);
    expect(says(all)).toEqual(['meet_card', 'meet_congrats', 'ask_name', 'no_name']);
    // meet_self ещё не звучит: его скажет выбранный
    const r = step(s, { type: 'choose', persona: 'kind' });
    s = r.state;
    all = r.actions;
    expect(has(all, 'swap_persona', { persona: 'kind' })).toBe(true);
    expect(has(all, 'hide_choice')).toBe(true);
    expect(all.findIndex((x) => x.type === 'swap_persona')).toBeLessThan(all.findIndex((x) => x.type === 'say' && x.key === 'meet_self'));
    expect(says(all)).toEqual(['meet_self', 'meet_skills']);
    expect(s.persona).toBe('kind');
    expect(s.phase).toBe('play');
    expect(s.met).toBe(true);
    expect(all.some((x) => x.type === 'remember' && x.patch.persona === 'kind')).toBe(true);
    // без наклеек, «переодеваюсь» и реплик «Добряк? Ладно, буду милым» (это не один кот в разных образах)
    expect(has(all, 'cover_stickers')).toBe(false);
    expect(says(all).some((k) => k.startsWith('choose_') || k === 'switch_start' || k === 'hello_new')).toBe(false);
  });

  it('после имени — тот же лист; выбор голосом («Блёстка»)', () => {
    let { s } = run(initialState(), [...toName, { type: 'intent', intent: { type: 'name', name: 'Маша', known: true } }]);
    expect(s.phase).toBe('choose');
    expect(s.name).toBe('Маша');
    const r = step(s, { type: 'intent', intent: { type: 'choose_glitter', text: 'блёстка' } });
    s = r.state;
    expect(has(r.actions, 'swap_persona', { persona: 'glitter' })).toBe(true);
    expect(s.persona).toBe('glitter');
    expect(s.phase).toBe('play');
  });

  it('лист не тронули 2 × 25 с — знакомится тот, кто вышел из карты; касания во время листа — без слов', () => {
    let { s } = run(initialState(), [...toName, { type: 'skip_name' }]);
    const tap = step(s, { type: 'interaction', kind: 'tap_cat_head' });
    expect(tap.actions.every((x) => x.type !== 'react' || (x as { quiet?: boolean }).quiet)).toBe(true);
    expect(PICK_INTRO_MS).toBe(25_000);
    let r = step(s, { type: 'listen_timeout', token: s.listenToken });
    s = r.state;
    expect(s.phase).toBe('choose');
    r = step(s, { type: 'listen_timeout', token: s.listenToken });
    s = r.state;
    expect(has(r.actions, 'hide_choice')).toBe(true);
    expect(has(r.actions, 'swap_persona')).toBe(false);
    expect(says(r.actions)).toEqual(['meet_self', 'meet_skills']);
    expect(s.persona).toBe('hooligan');
    expect(s.phase).toBe('play');
  });

  it('тот же кот, что вышел, — тоже вспышка и предмет (swap на себя), знакомство дальше', () => {
    const { s } = run(initialState(), [...toName, { type: 'skip_name' }]);
    const r = step(s, { type: 'choose', persona: 'hooligan' });
    expect(has(r.actions, 'swap_persona', { persona: 'hooligan' })).toBe(true);
    expect(r.state.phase).toBe('play');
  });

  it('без pilot.catPick — как было: после имени сразу «я — …», без листа', () => {
    const plain = makeScenarioConfig(dialogsFile, { random: () => 0.5 });
    let s = initialState();
    const all: Action[] = [];
    for (const e of [...toName, { type: 'skip_name' } as ScenarioEvent]) {
      const r = rawStep(s, e, plain);
      s = r.state;
      all.push(...r.actions);
    }
    expect(s.phase).toBe('play');
    expect(has(all, 'offer_pick')).toBe(false);
  });
});

describe('выбор кота: позже в игре («Позвать другого кота»)', () => {
  it('кнопка «Другой кот» → лист с другими котами (без «Давай!/Не надо» и наклеек) → касание — новый кот здоровается', () => {
    let s = playing('hooligan');
    let r = step(s, { type: 'intent', intent: { type: 'change_persona', button: true } });
    s = r.state;
    expect(has(r.actions, 'offer_pick', { where: 'play' })).toBe(true);
    expect(s.dialog?.id).toBe('pick');
    expect(s.phase).toBe('play');
    expect(says(r.actions)).not.toContain('switch_ask');
    r = step(s, { type: 'choose', persona: 'glitter' });
    s = r.state;
    expect(has(r.actions, 'swap_persona', { persona: 'glitter' })).toBe(true);
    expect(says(r.actions)).toEqual(['meet_self']);
    expect(s.persona).toBe('glitter');
    expect(s.dialog).toBeNull();
    expect(s.phase).toBe('play');
    expect(has(r.actions, 'cover_stickers')).toBe(false);
  });

  it('голосом «давай другого» / «поменяйся» — тот же лист; «хочу Добряка» — сразу он', () => {
    let s = playing('hooligan');
    let r = step(s, { type: 'intent', intent: { type: 'change_persona', text: 'давай другого' } });
    expect(has(r.actions, 'offer_pick', { where: 'play' })).toBe(true);
    expect(r.state.phase).toBe('play');
    r = step(s, { type: 'intent', intent: { type: 'choose_kind', text: 'хочу добряка' } });
    s = r.state;
    expect(has(r.actions, 'swap_persona', { persona: 'kind' })).toBe(true);
    expect(s.persona).toBe('kind');
    // уже он — без вспышки, короткое «да»
    r = step(s, { type: 'intent', intent: { type: 'choose_kind', text: 'добряк' } });
    expect(has(r.actions, 'swap_persona')).toBe(false);
  });

  it('«Не сейчас» / «нет» / 15 с тишины — лист уходит, кот прежний; другая кнопка — лист уходит и кнопка выполняется', () => {
    const s0 = playing('kind');
    const open = step(s0, { type: 'intent', intent: { type: 'change_persona', button: true } }).state;
    for (const e of [{ type: 'intent', intent: { type: 'no', text: 'нет' } }, { type: 'listen_timeout', token: open.listenToken }] as ScenarioEvent[]) {
      const r = step(open, e);
      expect(has(r.actions, 'hide_choice')).toBe(true);
      expect(r.state.persona).toBe('kind');
      expect(r.state.dialog).toBeNull();
    }
    const r = step(open, { type: 'intent', intent: { type: 'dance', button: true } });
    expect(has(r.actions, 'hide_choice')).toBe(true);
    expect(has(r.actions, 'react', { event: 'dance' })).toBe(true);
  });

  it('событие choose в игре (лист, debug) — смена кота (swap_persona), а не только реплика (запись 26.11)', () => {
    const r = step(playing('hooligan'), { type: 'choose', persona: 'kind' });
    expect(has(r.actions, 'swap_persona', { persona: 'kind' })).toBe(true);
    expect(r.state.persona).toBe('kind');
  });
});

describe('предмет появления и вид появления', () => {
  it('у каждого кота свой предмет: скейт / какао / зеркальце', () => {
    expect(APPEAR_ATTR).toEqual({ hooligan: 'skate_show', kind: 'cocoa_show', glitter: 'mirror' });
  });
  it('тексты листа — «разные коты», а не «каким мне быть»', () => {
    expect(PICK_TITLE.intro).toBe('Выбери своего кота');
    expect(PICK_TITLE.play).toBe('Позвать другого кота');
    expect(PICK_LINE.intro).toBe('Выбери, кто будет с тобой!');
    for (const t of [...Object.values(PICK_TITLE), ...Object.values(PICK_LINE)]) expect(t).not.toMatch(/быть|бываю|образ|переоде/i);
  });
  it('выезд на скейте: доска всё время на колёсах под котом (без кикфлипа, олли и подброса в лапу), стопы на деке на проезде', () => {
    expect(SKATE_SHOW_ORDER).toEqual(['rise', 'push', 'ride', 'roll', 'hopoff', 'fade']);
    expect(SHOW_RIDE_TO).toBeGreaterThan(SHOW_RIDE_FROM);
    for (let t = 0; t < SKATE_SHOW_TOTAL; t += 1 / 30) {
      const f = skatePose(t, undefined, SKATE_SHOW_ORDER);
      expect(f.roll, `${t}`).toBe(0);
      expect(f.carry, `${t}`).toBe(0);
      expect(Math.abs(f.pitch), `${t}`).toBeLessThan(1e-6);
      expect(f.board.y, `${t}`).toBe(0);
      if (f.phase === 'push' || f.phase === 'ride' || f.phase === 'roll') {
        expect(f.feetW).toBe(1);
        expect(f.standOn).toBeCloseTo(BOARD.deck, 6);
      }
    }
    expect(skatePose(SKATE_SHOW_TOTAL + 0.01, undefined, SKATE_SHOW_ORDER).phase).toBe('done');
    // доска появляется, пока стопы над ней (подпрыгнул): к середине роста — масштаб ≥ 0,9, кот в воздухе
    const mid = skatePose(0.25, undefined, SKATE_SHOW_ORDER);
    expect(mid.boardScale).toBeGreaterThan(0.85);
    expect(mid.lift).toBeGreaterThan(0.05);
    expect(FEET_ON_DECK.front.y).toBeCloseTo(BOARD.deck, 6);
  });
  it('пробуждение Хулигана: без сальто «вверх ногами» и без доски сцены (запись 26.11)', () => {
    for (const kind of ['first', 'short'] as const) {
      const p = awakePlan('hooligan', kind);
      for (let t = 0; t < p.dur; t += 0.02) {
        expect(p.pose(t).flip).toBe(0);
        expect(p.skate(t)).toBe(0);
      }
    }
  });
});

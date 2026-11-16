import { describe, it, expect } from 'vitest';
import { initialState, step, type ScenarioEvent, type ScenarioState, type Action } from '../src/scenario/machine';
import { loadMemory, saveMemory } from '../src/scenario/memory';

const run = (s: ScenarioState, events: ScenarioEvent[]) => {
  const all: Action[] = [];
  for (const e of events) {
    const r = step(s, e);
    s = r.state;
    all.push(...r.actions);
  }
  return { s, all };
};
const has = (a: Action[], type: string, extra: Record<string, unknown> = {}) =>
  a.some((x) => x.type === type && Object.entries(extra).every(([k, v]) => (x as any)[k] === v));

const toChoose: ScenarioEvent[] = [{ type: 'wake' }, { type: 'card_found' }, { type: 'timer', id: 'appear_done' }];

describe('сценарий первой встречи', () => {
  it('пробуждение → сканирование → появление → вопрос имени', () => {
    const { s, all } = run(initialState(), toChoose);
    expect(s.phase).toBe('ask_name');
    expect(s.visits).toBe(1);
    expect(has(all, 'appear')).toBe(true);
    expect(has(all, 'say', { key: 'intro' })).toBe(true);
    expect(has(all, 'ui', { ui: 'name_prompt', show: true })).toBe(true);
  });

  it('имя голосом → выбор → 5 с без выбора = Хулиган', () => {
    const { s, all } = run(initialState(), [
      ...toChoose,
      { type: 'intent', intent: { type: 'name', name: 'Маша' } },
      { type: 'choice_shown' },
      { type: 'timer', id: 'choose_timeout' },
    ]);
    expect(s.name).toBe('Маша');
    expect(s.persona).toBe('hooligan');
    expect(s.phase).toBe('play');
    expect(has(all, 'timer', { id: 'choose_timeout', ms: 5000 })).toBe(true);
    expect(has(all, 'remember')).toBe(true);
    expect(has(all, 'signature')).toBe(true);
  });

  it('пропуск имени и выбор Блёстки тапом', () => {
    const { s, all } = run(initialState(), [...toChoose, { type: 'skip_name' }, { type: 'choice_shown' }, { type: 'choose', persona: 'glitter' }]);
    expect(s.persona).toBe('glitter');
    expect(s.name).toBeNull();
    expect(has(all, 'say', { key: 'no_name' })).toBe(true);
  });

  it('3 взаимодействия → приглашение в СберKids', () => {
    let { s, all } = run(initialState(), [...toChoose, { type: 'skip_name' }, { type: 'choose', persona: 'hooligan' }]);
    ({ s, all } = run(s, [
      { type: 'interaction', kind: 'tap_cat' },
      { type: 'interaction', kind: 'swipe' },
      { type: 'shake' },
    ]));
    expect(has(all, 'timer', { id: 'outro' })).toBe(true);
    ({ s, all } = run(s, [{ type: 'timer', id: 'outro' }]));
    expect(s.phase).toBe('free');
    expect(has(all, 'ui', { ui: 'sberkids', show: true })).toBe(true);
    expect(has(all, 'say', { key: 'outro' })).toBe(true);
  });

  it('вопрос про деньги сразу ведёт к брату', () => {
    let { s } = run(initialState(), [...toChoose, { type: 'skip_name' }, { type: 'choose', persona: 'hooligan' }]);
    const r = step(s, { type: 'intent', intent: { type: 'money' } });
    expect(r.state.outroShown).toBe(true);
    expect(has(r.actions, 'react', { event: 'money' })).toBe(true);
    expect(has(r.actions, 'ui', { ui: 'sberkids', show: true })).toBe(true);
  });

  it('потеря карты: кот остаётся и говорит, поза фиксируется', () => {
    let { s } = run(initialState(), [...toChoose]);
    let r = step(s, { type: 'card_lost' });
    expect(has(r.actions, 'hold_pose')).toBe(true);
    expect(has(r.actions, 'react', { event: 'card_lost' })).toBe(true);
    expect(r.state.phase).toBe('ask_name');
    r = step(r.state, { type: 'card_found' });
    expect(has(r.actions, 'resume_pose')).toBe(true);
  });

  it('потеря карты до появления — без реплики', () => {
    const { s } = run(initialState(), [{ type: 'wake' }, { type: 'card_found' }]);
    const r = step(s, { type: 'card_lost' });
    expect(r.actions).toHaveLength(0);
  });

  it('смена характера: «давай другого» → заклеивание → встряска → новый образ', () => {
    let { s } = run(initialState(), [...toChoose, { type: 'skip_name' }, { type: 'choose', persona: 'hooligan' }]);
    let r = step(s, { type: 'intent', intent: { type: 'switch' } });
    expect(r.state.phase).toBe('switching');
    expect(has(r.actions, 'cover_stickers', { persona: 'glitter' })).toBe(true);
    r = step(r.state, { type: 'covered' });
    expect(has(r.actions, 'say', { key: 'shake_prompt' })).toBe(true);
    expect(has(r.actions, 'ui', { ui: 'shake_button', show: true })).toBe(true);
    // тап во время заклеивания не ломает сценарий
    r = step(r.state, { type: 'interaction', kind: 'tap_screen' });
    expect(r.state.phase).toBe('switching');
    r = step(r.state, { type: 'shake' });
    expect(r.state.persona).toBe('glitter');
    expect(r.state.phase).toBe('play');
    expect(has(r.actions, 'blow_stickers')).toBe(true);
    expect(has(r.actions, 'remember')).toBe(true);
  });

  it('скука: первая тишина — реплика, вторая подряд — смена характера', () => {
    let { s } = run(initialState(), [...toChoose, { type: 'skip_name' }, { type: 'choose', persona: 'glitter' }]);
    let r = step(s, { type: 'silence' });
    expect(has(r.actions, 'react', { event: 'silence' })).toBe(true);
    r = step(r.state, { type: 'silence' });
    expect(r.state.phase).toBe('switching');
    expect(r.state.switchTo).toBe('hooligan');
  });

  it('повторный визит: узнаёт по имени, без анкеты', () => {
    const { s, all } = run(initialState({ name: 'Петя', persona: 'glitter', visits: 3 }), toChoose);
    expect(s.phase).toBe('play');
    expect(has(all, 'say', { key: 'welcome_back' })).toBe(true);
    expect(has(all, 'set_persona', { persona: 'glitter' })).toBe(true);
  });
});

describe('память', () => {
  it('сохраняет и читает; битый JSON и недоступное хранилище не роняют', () => {
    const m = new Map<string, string>();
    const st = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    saveMemory({ name: 'Аня', visits: 2 }, st);
    expect(loadMemory(st)).toEqual({ name: 'Аня', persona: null, visits: 2 });
    m.set('sber-ar-cat:v1', '{oops');
    expect(loadMemory(st).visits).toBe(0);
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(() => saveMemory({ name: 'X' }, broken)).not.toThrow();
    expect(loadMemory(broken).name).toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import { dialogsFile, loadTestContent } from './helpers/content';
import { initialState, makeScenarioConfig, step as rawStep, type Action, type ScenarioEvent, type ScenarioState } from '../src/scenario/machine';
import { validateDialogs } from '../src/scenario/dialogs';
import { answerMatches } from '../src/scenario/intentMatch';
import { matchIntent } from '../src/voice/intents';
import { contextEvent } from '../src/scenario/session';
import { PERSONA_IDS } from '../src/persona/types';

const content = loadTestContent();
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
const says = (a: Action[]) => a.filter((x) => x.type === 'say' || x.type === 'say_riddle').map((x) => (x.type === 'say' ? x.key : `$riddle.${x.part}`));
const lastListen = (a: Action[]) => [...a].reverse().find((x) => x.type === 'listen') as Extract<Action, { type: 'listen' }> | undefined;
const heard = (type: string, extra: Record<string, unknown> = {}): ScenarioEvent => ({ type: 'intent', intent: { type, text: type, ...extra } });
const toChoose: ScenarioEvent[] = [{ type: 'wake' }, { type: 'card_found' }, { type: 'timer', id: 'appear_done' }];
const inPlay = (persona: 'hooligan' | 'kind' | 'glitter' = 'hooligan') =>
  run(initialState(), [...toChoose, { type: 'skip_name' }, { type: 'choose', persona }]).s;

describe('dialogs.json', () => {
  it('ссылки на события и узлы целы', () => {
    expect(validateDialogs(dialogsFile, new Set(content.events.keys()))).toEqual([]);
  });
  it('по 8 загадок на характер, у каждой ответ и ключевые слова, ответ проходит свою проверку', () => {
    for (const pid of PERSONA_IDS) {
      const rs = content.personas.get(pid)!.riddles;
      expect(rs.length).toBeGreaterThanOrEqual(8);
      for (const r of rs) {
        expect(r.keywords.length).toBeGreaterThan(0);
        expect(answerMatches(r.answer, r.keywords), `${pid}.${r.id}: ${r.answer}`).toBe(true);
        expect(answerMatches(`это ${r.answer}!`, r.keywords)).toBe(true);
        expect(answerMatches('абракадабра', r.keywords)).toBe(false);
      }
    }
  });
});

describe('знакомство', () => {
  it('ask_name → окно 5 с → имя → nice_name → choose', () => {
    let { s, all } = run(initialState(), toChoose);
    expect(s.dialog?.id).toBe('intro');
    expect(lastListen(all)).toMatchObject({ mode: 'name', ms: 5000 });
    ({ s, all } = run(s, [heard('name', { name: 'Маша', known: true })]));
    expect(says(all)).toEqual(['nice_name', 'choose']);
    expect(s.name).toBe('Маша');
    expect(all.some((a) => a.type === 'remember' && a.patch.name === 'Маша')).toBe(true);
    expect(s.phase).toBe('choose');
    expect(all.some((a) => a.type === 'offer_choice')).toBe(true);
  });
  it('имя не из словаря — не запоминаем, но знакомство идёт', () => {
    const { s, all } = run(initialState(), [...toChoose, heard('name', { name: 'Зюзя', known: false })]);
    expect(s.name).toBeNull();
    expect(says(all)).toContain('nice_name');
    expect(all.some((a) => a.type === 'remember' && a.patch.name)).toBe(false);
  });
  it('тишина → переспросить один раз → тишина → no_name → choose', () => {
    let { s, all } = run(initialState(), toChoose);
    ({ s, all } = run(s, [{ type: 'listen_timeout', token: lastListen(all)!.token }]));
    expect(says(all)).toEqual(['ask_name_again']);
    ({ s, all } = run(s, [{ type: 'listen_timeout', token: lastListen(all)!.token }]));
    expect(says(all)).toEqual(['no_name', 'choose']);
  });
  it('старый таймаут окна игнорируется', () => {
    let { s, all } = run(initialState(), toChoose);
    const old = lastListen(all)!.token;
    ({ s } = run(s, [heard('unknown')]));
    const r = step(s, { type: 'listen_timeout', token: old });
    expect(r.actions).toEqual([]);
  });
  it('«не скажу» → no_name; выбор голосом «добряк»', () => {
    let { s, all } = run(run(initialState(), toChoose).s, [heard('no')]);
    expect(says(all)).toEqual(['no_name', 'choose']);
    ({ s, all } = run(s, [heard('choose_kind')]));
    expect(s.persona).toBe('kind');
    expect(says(all)).toEqual(['choose_kind', 'invite']);
    expect(all.findIndex((a) => a.type === 'set_persona')).toBeLessThan(all.findIndex((a) => a.type === 'say'));
    expect(s.phase).toBe('play');
  });
  it('выбор тапом по стикеру во время вопроса', () => {
    const { s } = run(initialState(), [...toChoose, { type: 'choose', persona: 'glitter' }]);
    expect(s.persona).toBe('glitter');
    expect(s.dialog).toBeNull();
  });
});

describe('«пока?»', () => {
  it('bye → да → goodbye, кот уходит', () => {
    let { s, all } = run(inPlay(), [heard('bye')]);
    expect(says(all)).toEqual(['bye']);
    expect(lastListen(all)?.mode).toBe('intent');
    ({ s, all } = run(s, [heard('yes')]));
    expect(says(all)).toEqual(['goodbye']);
    expect(all.some((a) => a.type === 'goodbye')).toBe(true);
    expect(s.phase).toBe('gone');
    // вернулся — кот снова появляется
    ({ s, all } = run(s, [{ type: 'interaction', kind: 'tap_screen' }, { type: 'timer', id: 'appear_done' }]));
    expect(says(all)).toContain('welcome_back');
  });
  it('bye → нет → bye_cancel, играем', () => {
    const { s, all } = run(inPlay(), [heard('bye'), heard('no')]);
    expect(says(all)).toEqual(['bye', 'bye_cancel']);
    expect(s.phase).toBe('play');
    expect(s.dialog).toBeNull();
  });
  it('bye → тишина → молча остаёмся', () => {
    let { s, all } = run(inPlay(), [heard('bye')]);
    ({ s, all } = run(s, [{ type: 'listen_timeout', token: lastListen(all)!.token }]));
    expect(says(all)).toEqual([]);
    expect(s.dialog).toBeNull();
  });
});

describe('«хочешь к брату?»', () => {
  it('money → «это к брату» → да → открыть СберKids', () => {
    let { s, all } = run(inPlay('kind'), [heard('money')]);
    expect(says(all)).toEqual(['money', 'sberkids_ask']);
    ({ s, all } = run(s, [heard('yes')]));
    expect(says(all)).toEqual(['sberkids_yes']);
    expect(all.some((a) => a.type === 'open_sberkids')).toBe(true);
    expect(s.dialog).toBeNull();
  });
  it('sberkids → нет → вернуться к игре', () => {
    const { s, all } = run(inPlay(), [heard('sberkids'), heard('no')]);
    expect(says(all)).toEqual(['sberkids', 'sberkids_no']);
    expect(all.some((a) => a.type === 'open_sberkids')).toBe(false);
    expect(s.phase).toBe('play');
  });
  it('тишина — только кнопка', () => {
    let { s, all } = run(inPlay(), [heard('money')]);
    ({ s, all } = run(s, [{ type: 'listen_timeout', token: lastListen(all)!.token }]));
    expect(all.some((a) => a.type === 'ui' && a.ui === 'sberkids' && a.show)).toBe(true);
    expect(all.some((a) => a.type === 'open_sberkids')).toBe(false);
  });
});

describe('загадка', () => {
  it('загадывает → верно → хвалит → ещё? → да → новая загадка', () => {
    let { s, all } = run(inPlay(), [heard('riddle')]);
    expect(says(all)).toEqual(['riddle', '$riddle.q']);
    expect(s.riddleSeq).toBe(1);
    expect(lastListen(all)).toMatchObject({ mode: 'riddle', ms: 8000 });
    ({ s, all } = run(s, [{ type: 'answer', result: 'right' }]));
    expect(says(all)).toEqual(['riddle_right', 'riddle_more']);
    ({ s, all } = run(s, [heard('yes')]));
    expect(says(all)).toEqual(['$riddle.q']);
    expect(s.riddleSeq).toBe(2);
  });
  it('мимо → подсказка → мимо → говорит ответ → «нет» → riddle_bye', () => {
    let { s, all } = run(inPlay(), [heard('riddle'), { type: 'answer', result: 'wrong' }]);
    expect(says(all).slice(-2)).toEqual(['riddle_hint', '$riddle.hint']);
    ({ s, all } = run(s, [{ type: 'answer', result: 'wrong' }]));
    expect(says(all)).toEqual(['riddle_answer', 'riddle_more']);
    ({ s, all } = run(s, [heard('no')]));
    expect(says(all)).toEqual(['riddle_bye']);
    expect(s.dialog).toBeNull();
  });
  it('«не знаю» сразу — ответ', () => {
    const { all } = run(inPlay(), [heard('riddle'), heard('giveup')]);
    expect(says(all).slice(-2)).toEqual(['riddle_answer', 'riddle_more']);
  });
  it('«пока» посреди загадки — переходит в диалог прощания', () => {
    const { s, all } = run(inPlay(), [heard('riddle'), heard('bye')]);
    expect(s.dialog?.id).toBe('bye');
    expect(says(all).at(-1)).toBe('bye');
  });
});

describe('повторялка', () => {
  it('echo_start → echo ×N (реакция после 1-го и каждого 4-го) → echo_stop', () => {
    let { s, all } = run(inPlay('glitter'), [heard('echo_start')]);
    expect(says(all)).toEqual(['echo_start']);
    expect(lastListen(all)).toMatchObject({ mode: 'echo', ms: 20000 });
    const done: number[] = [];
    for (let i = 1; i <= 8; i++) {
      ({ s, all } = run(s, [{ type: 'intent', intent: { type: 'unknown', text: `фраза ${i}` } }]));
      expect(all.find((a) => a.type === 'echo')).toMatchObject({ text: `фраза ${i}` });
      if (says(all).includes('echo_done')) done.push(i);
      expect(s.dialog?.listening).toBe('echo');
    }
    expect(done).toEqual([1, 4, 8]);
    // даже «привет» в режиме повтора — повторяется
    ({ all } = run(s, [heard('hello')]));
    expect(all.some((a) => a.type === 'echo')).toBe(true);
    ({ s, all } = run(s, [heard('echo_stop')]));
    expect(says(all)).toEqual(['echo_stop']);
    expect(s.dialog).toBeNull();
  });
  it('20 с тишины — выключается', () => {
    let { s, all } = run(inPlay(), [heard('echo_start')]);
    ({ s, all } = run(s, [{ type: 'listen_timeout', token: lastListen(all)!.token }]));
    expect(says(all)).toEqual(['echo_stop']);
  });
});

describe('грустно / страшно', () => {
  it('поддержка прерывает любой диалог, подсказка взрослого, 10 с без игры', () => {
    let { s, all } = run(inPlay(), [heard('riddle'), heard('sad')]);
    expect(says(all).at(-1)).toBe('sad');
    expect(all.some((a) => a.type === 'adult_hint')).toBe(true);
    expect(all.some((a) => a.type === 'timer' && a.id === 'pause_end' && a.ms === 10_000)).toBe(true);
    expect(s.paused).toBe(true);
    expect(s.dialog).toBeNull();
    // во время паузы — без игры и без вопросов
    ({ s, all } = run(s, [{ type: 'interaction', kind: 'tap_cat' }, heard('joke'), heard('riddle'), { type: 'silence' }]));
    expect(all.filter((a) => a.type === 'react' || a.type === 'say')).toEqual([]);
    // страшно — снова поддержка даже на паузе
    ({ s, all } = run(s, [heard('scared')]));
    expect(says(all)).toEqual(['scared']);
    ({ s, all } = run(s, [{ type: 'timer', id: 'pause_end' }, { type: 'interaction', kind: 'tap_cat' }]));
    expect(s.paused).toBe(false);
    expect(all.some((a) => a.type === 'react' && a.event === 'tap_cat')).toBe(true);
  });
  it('на знакомстве тоже', () => {
    const { all } = run(initialState(), [...toChoose, heard('scared')]);
    expect(says(all).at(-1)).toBe('scared');
  });
});

describe('голос ребёнка → интент: словарь content/intents.ru.json для диалогов', () => {
  const t = (s: string, question = false) => matchIntent(s, { question }).intent;
  it.each([
    ['мне грустно', 'sad'],
    ['мне очень страшно', 'scared'],
    ['повторяй за мной', 'echo_start'],
    ['хватит', 'echo_stop'],
    ['пока', 'bye'],
    ['покажи трюк', 'gum'],
    ['Сколько у меня денег?', 'money'],
    ['хочу к брату', 'sberkids'],
    ['Загадай загадку', 'riddle'],
    ['будь добряком', 'choose_kind'],
    ['хулиган', 'choose_hooligan'],
    ['блёстка', 'choose_glitter'],
  ])('«%s» → %s', (s, type) => expect(t(s)).toBe(type));
  it('ответы на вопрос кота: да / нет / не знаю', () => {
    expect(t('да', true)).toBe('yes');
    expect(t('неа', true)).toBe('no');
    expect(t('не знаю', true)).toBe('giveup');
    expect(t('сдаюсь', true)).toBe('giveup');
  });
  it('все интенты-триггеры диалогов есть в словаре', () => {
    const ids = new Set(content.intents.map((i) => i.intent));
    for (const k of Object.keys(dialogsFile.triggers)) expect(ids.has(k), k).toBe(true);
  });
});

describe('имя (словарь names.ru.txt)', () => {
  it('из словаря — known, иначе нет', () => {
    expect(matchIntent('Меня зовут Маша', { expectName: true })).toMatchObject({ intent: 'name', name: 'Маша', known: true });
    expect(matchIntent('Зюзя', { expectName: true })).toMatchObject({ intent: 'name', known: false });
    expect(matchIntent('не скажу', { expectName: true }).intent).toBe('skip');
  });
});

describe('контекст входа', () => {
  const at = (h: number, day = 10) => new Date(2026, 10, day, h, 0, 0);
  it.each([
    [at(8), null, 'morning'],
    [at(21), null, 'evening'],
    [at(14), null, null],
    [at(14), at(9, 9).getTime(), 'first_time_today'],
    [at(14), at(9, 2).getTime(), 'long_absence'],
    [at(8), at(7).getTime(), null],
    [at(21), at(15).getTime(), 'evening'],
  ])('%s, прошлый вход %s → %s', (now, last, ev) => expect(contextEvent(now as Date, last as number | null)).toBe(ev));
});

import { describe, it, expect } from 'vitest';
import { Suggester, hintText, type SuggestSnapshot, MAX_CHIPS, FIRST_MINUTES_MS, AFTER_GAME_MS, UPSET_MS, HINT_FIRST_MS, HINT_LONG_MS, HINT_SHOW_MS } from '../src/scenario/suggest';
import { loadTestContent } from './helpers/content';
import { buildCatalog, catalogEnv } from '../src/ui/actionCatalog';
import { PERSONA_IDS } from '../src/persona/types';

const content = loadTestContent();
const env = catalogEnv(content.intents, content.dialogs.triggers);
const availFor = (pid: string) => {
  const m = new Map<string, { label: string; icon: string }>();
  for (const s of buildCatalog(content.personas.get(pid as never)!, env)) for (const it of s.items) if ('action' in it.run) m.set(it.id, { label: it.label, icon: it.icon });
  return m;
};

function snap(o: Partial<SuggestSnapshot> & { triedIds?: string[] } = {}): SuggestSnapshot {
  const tried = new Set(o.triedIds ?? []);
  return {
    now: 0, phase: 'play', appeared: true, dialog: null, paused: false, dozing: false, speaking: false, quietMs: 0, visits: 5,
    available: availFor('hooligan'), tried: (id) => tried.has(id), ...o,
  };
}
const ids = (s: Suggester, o: Parameters<typeof snap>[0]) => s.update(snap(o)).chips.map((c) => c.id);

describe('чипы кота (scenario/suggest.ts)', () => {
  it('не игра — чипов нет; в игре — не больше двух', () => {
    const s = new Suggester();
    expect(ids(s, { phase: 'ask_name' })).toEqual([]);
    expect(ids(s, { phase: 'play', appeared: false })).toEqual([]);
    for (const pid of PERSONA_IDS) {
      const c = new Suggester().update(snap({ available: availFor(pid), now: 1 })).chips;
      expect(c.length).toBeGreaterThan(0);
      expect(c.length).toBeLessThanOrEqual(MAX_CHIPS);
      // каждый чип-действие есть в каталоге характера
      for (const ch of c) if ('action' in ch.run) expect(availFor(pid).has(ch.run.action)).toBe(true);
    }
  });

  it('первые минуты: «Погладь меня» + игра; погладили — «Загадка», «Танец»', () => {
    const s = new Suggester();
    const first = s.update(snap({ now: 1000 })).chips;
    expect(first.map((c) => c.id)).toEqual(['pet', 'riddle']);
    expect(first[0].label).toBe('Погладь меня');
    s.note('pet');
    expect(ids(s, { now: 2000, triedIds: ['pet'] })).toEqual(['riddle', 'dance']);
    // прошли первые минуты, не гладили — обычные игры
    expect(ids(new Suggester(), { now: 0 })[0]).toBe('pet');
    const late = new Suggester();
    late.update(snap({ now: 0 }));
    expect(ids(late, { now: FIRST_MINUTES_MS + 1 })).toEqual(['riddle', 'dance']);
  });

  it('предлагает то, чего ребёнок ещё не пробовал, и не повторяет только что сделанное', () => {
    const s = new Suggester();
    s.update(snap({ now: 0 }));
    const t = FIRST_MINUTES_MS + 1;
    s.note('dance');
    // танцевали только что — игра другая; вторая — непробованное
    expect(ids(s, { now: t, triedIds: ['pet', 'dance'] })).toEqual(['riddle', 'echo']);
    expect(ids(s, { now: t, triedIds: ['pet', 'dance', 'echo'] })).toEqual(['riddle', 'treat']);
    s.note('riddle');
    s.note('treat');
    expect(ids(s, { now: t, triedIds: ['pet', 'dance', 'echo', 'riddle', 'treat'] })).toEqual(['echo', 'tickle']);
  });

  it('мини-игра: загадка → «Сдаюсь»; «ещё?» → «Ещё загадку» / «Повторяй»; после — снова «Ещё загадку»', () => {
    const marked: string[] = [];
    const s = new Suggester((id) => marked.push(id));
    s.update(snap({ now: 0 }));
    const ask = { id: 'riddle', node: 'ask', listening: true, expect: ['right', 'giveup', 'wrong', 'timeout'] };
    const c = s.update(snap({ now: 1000, dialog: ask })).chips;
    expect(c.map((x) => x.id)).toEqual(['giveup']);
    expect(c[0].run).toEqual({ say: 'сдаюсь' });
    expect(marked).toEqual(['riddle']);
    // кот говорит ответ — чипы не прыгают
    expect(ids(s, { now: 1500, dialog: { ...ask, node: 'answer', listening: false, expect: [] } })).toEqual(['giveup']);
    const more = s.update(snap({ now: 2000, dialog: { id: 'riddle', node: 'more', listening: true, expect: ['yes', 'riddle', 'no', 'timeout', '*'] } })).chips;
    expect(more.map((x) => x.label)).toEqual(['Ещё загадку', 'Повторяй']);
    // загадка закончилась — ещё AFTER_GAME_MS предлагает продолжить
    expect(s.update(snap({ now: 3000, triedIds: ['pet'] })).chips[0]).toMatchObject({ id: 'riddle', label: 'Ещё загадку' });
    expect(ids(s, { now: 3000 + AFTER_GAME_MS + 1, triedIds: ['pet', 'riddle'] })[0]).not.toBe('riddle');
  });

  it('повторялка → «Хватит»; предложение кота → «Давай!» / «Не хочу»; другие вопросы — «Да» / «Нет»', () => {
    const s = new Suggester();
    expect(s.update(snap({ dialog: { id: 'echo', node: 'listen', listening: true, expect: ['echo_stop', 'timeout', '*'] } })).chips.map((c) => c.run)).toEqual([{ say: 'хватит' }]);
    const offer = s.update(snap({ dialog: { id: 'offer', node: 'dance', listening: true, expect: ['yes', 'dance', 'no', 'timeout', '*'] } })).chips;
    expect(offer.map((c) => c.label)).toEqual(['Давай!', 'Не хочу']);
    expect(ids(s, { dialog: { id: 'bye', node: 'ask', listening: true, expect: ['yes', 'no'] } })).toEqual(['yes', 'no']);
  });

  it('варианты мини-игры (Director.gameChoices) — ответы, до трёх', () => {
    const s = new Suggester();
    const c = s.update(snap({ game: { id: 'rps', options: [{ id: 'rock', label: 'Камень' }, { id: 'scissors', label: 'Ножницы' }, { id: 'paper', label: 'Бумага' }] }, dialog: { id: 'rps', node: 'ask', listening: true, expect: [] } })).chips;
    expect(c.map((x) => x.label)).toEqual(['Камень', 'Ножницы', 'Бумага']);
    expect(c[1].run).toEqual({ say: 'Ножницы' });
  });

  it('эмоции: дремлет — «Разбуди меня»; грустно — «Обними»; обиделся — помириться', () => {
    const s = new Suggester();
    s.update(snap({ now: 0 }));
    const t = FIRST_MINUTES_MS + 1;
    const doze = s.update(snap({ now: t, dozing: true })).chips;
    expect(doze.map((c) => [c.id, c.label])).toEqual([['pet', 'Разбуди меня']]);
    expect(ids(s, { now: t, paused: true })).toEqual(['hug', 'pet']);
    s.upset(t);
    expect(ids(s, { now: t + 1000, triedIds: ['pet'] })).toEqual(['hug', 'treat']);
    expect(ids(s, { now: t + UPSET_MS + 1, triedIds: ['pet'] })).toEqual(['riddle', 'dance']);
  });

  it('новые игры (камень-ножницы, рожицы, делай как я) — только с озвученным началом', () => {
    const t = FIRST_MINUTES_MS + 1;
    const tried = ['pet', 'riddle', 'dance', 'echo'];
    const all = (voiced: (e: string) => boolean) => {
      const s = new Suggester();
      s.update(snap({ now: 0, voiced }));
      s.note('riddle');
      s.note('dance');
      s.note('echo');
      return ids(s, { now: t, triedIds: tried, voiced });
    };
    expect(all(() => false)).not.toContain('rps');
    expect(all(() => false)).not.toContain('emo');
    expect(all((e) => e === 'rps_start')[0]).toBe('rps');
    // игра началась голосом — точка «новое» в каталоге гаснет
    const marked: string[] = [];
    const s = new Suggester((id) => marked.push(id));
    s.update(snap({ dialog: { id: 'rps', node: 'ask', listening: false, expect: [] } }));
    expect(marked).toEqual(['rps']);
  });

  it('у характера нет действия — чипа нет (берётся следующее)', () => {
    const avail = availFor('kind');
    avail.delete('riddle');
    const s = new Suggester();
    s.update(snap({ now: 0, available: avail }));
    expect(ids(s, { now: FIRST_MINUTES_MS + 1, available: avail, triedIds: ['pet'] })).toEqual(['dance', 'echo']);
  });
});

describe('подсказка от кота в пузыре', () => {
  it('первый визит: после короткой тишины, один раз за тишину, ненадолго', () => {
    const s = new Suggester();
    expect(s.update(snap({ now: 0, visits: 1, quietMs: 0 })).hint).toBeNull();
    expect(s.update(snap({ now: HINT_FIRST_MS - 100, visits: 1, quietMs: HINT_FIRST_MS - 100 })).hint).toBeNull();
    const t = HINT_FIRST_MS + 100;
    expect(s.update(snap({ now: t, visits: 1, quietMs: t })).hint).toBe('Погладь меня или скажи «танцуй»');
    expect(s.update(snap({ now: t + HINT_SHOW_MS + 1, visits: 1, quietMs: t + HINT_SHOW_MS + 1 })).hint).toBeNull();
    // ребёнок что-то сделал (тишина с нуля) — в следующей тишине снова можно
    s.update(snap({ now: t + 9000, visits: 1, quietMs: 0 }));
    expect(s.update(snap({ now: t + 9000 + HINT_FIRST_MS, visits: 1, quietMs: HINT_FIRST_MS + 10 })).hint).not.toBeNull();
  });

  it('не первый визит — только после долгой тишины; кот говорит / диалог / дрёма — нет', () => {
    const s = new Suggester();
    expect(s.update(snap({ now: 0, visits: 6, quietMs: HINT_FIRST_MS + 1000 })).hint).toBeNull();
    expect(s.update(snap({ now: 100, visits: 6, quietMs: HINT_LONG_MS + 1, speaking: true })).hint).toBeNull();
    expect(s.update(snap({ now: 200, visits: 6, quietMs: HINT_LONG_MS + 2, dozing: true })).hint).toBeNull();
    expect(s.update(snap({ now: 300, visits: 6, quietMs: HINT_LONG_MS + 3 })).hint).toMatch(/^Погладь меня|^Скажи мне/);
  });

  it('текст подсказки: что сказать голосом', () => {
    const chip = (id: string, label: string) => ({ id, label, icon: '', run: { action: id as never } });
    expect(hintText([chip('riddle', 'Загадка'), chip('dance', 'Танец')], true)).toBe('Скажи мне «загадай загадку»');
    expect(hintText([chip('treat', 'Угости меня')], true)).toBe('Нажми «Угости меня» внизу');
    expect(hintText([chip('treat', 'Угости меня')], false)).toBe('Погладь меня или скажи «танцуй»');
  });
});

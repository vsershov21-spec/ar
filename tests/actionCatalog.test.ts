import { describe, it, expect, vi } from 'vitest';
import { loadTestContent, dialogsFile } from './helpers/content';
import { buildCatalog, catalogEnv, routeItem, phraseIntent, actionWorks, TriedStore, SAY_PHRASES, type CatalogItem } from '../src/ui/actionCatalog';
import { ACTION_ROUTE, ACTIONS } from '../src/scenario/actions';
import { ACTION_BAR } from '../src/ui/ui';
import { initialState, step, makeScenarioConfig, type ScenarioState } from '../src/scenario/machine';
import { PERSONA_IDS, type Persona } from '../src/persona/types';
import { runtimeClip } from '../src/persona/runtimeMap';

const content = loadTestContent();
const env = catalogEnv(content.intents, content.dialogs.triggers);
const cfg = makeScenarioConfig(dialogsFile, { random: () => 0.5 });
const play: ScenarioState = { ...initialState(), phase: 'play', appeared: true, met: true, cardVisible: true, persona: 'kind' };

describe('каталог «Что умеет кот»: только поддержанные действия', () => {
  it.each(PERSONA_IDS)('%s: все разделы, у каждого пункта есть реплика или видимая реакция', (pid) => {
    const p = content.personas.get(pid)!;
    const secs = buildCatalog(p, env);
    expect(secs.map((s) => s.id)).toEqual(['care', 'tricks', 'games', 'emotions', 'magic', 'say']);
    const ids = new Set<string>();
    for (const s of secs) {
      expect(s.items.length).toBeGreaterThan(0);
      for (const it of s.items) {
        expect(ids.has(it.id), it.id).toBe(false);
        ids.add(it.id);
        if ('action' in it.run) {
          const r = ACTION_ROUTE[it.run.action];
          const ev = 'touch' in r ? r.touch : r.say === 'change_persona' ? 'switch_start' : r.say;
          const dialog = 'say' in r && !!content.dialogs.triggers[r.say];
          const sig = ev === 'double_tap' && !!p.signature;
          const visible = (p.lines[ev]?.length ?? 0) > 0 || !!runtimeClip(p.reactions[ev]?.clip) || !!p.reactions[ev]?.fx;
          expect(dialog || sig || visible, `${pid}.${it.id}`).toBe(true);
        }
      }
    }
    // всё из панели действий есть и в каталоге
    for (const a of ACTION_BAR) expect(ids.has(a.id), a.id).toBe(true);
  });

  it('у характера нет реакции — пункта нет; без загадок — нет «Загадки»; пустой раздел не показывается', () => {
    const base = content.personas.get('kind')!;
    const lines = { ...base.lines, tap_cat_cheek: [], sing: [] };
    const reactions = { ...base.reactions };
    delete reactions.tap_cat_cheek;
    delete reactions.sing;
    const p = { ...base, lines, reactions, riddles: [] } as Persona;
    const all = buildCatalog(p, env).flatMap((s) => s.items.map((i) => i.id));
    expect(all).not.toContain('cheek');
    expect(all).not.toContain('sing');
    expect(all).not.toContain('riddle');
    expect(all).not.toContain('say:riddle');
    expect(all).not.toContain('say:sing');
    expect(all).toContain('pet');
    // без словаря интентов — нет ни команд, ни фраз
    const none = buildCatalog(base, { intents: new Set(), triggers: {} });
    expect(none.find((s) => s.id === 'say')).toBeUndefined();
    expect(none.flatMap((s) => s.items).every((i) => 'action' in i.run && 'touch' in ACTION_ROUTE[i.run.action])).toBe(true);
    // «Усыпи» — только если кот умеет и проснуться
    const noWake = { ...base, lines: { ...base.lines, wake_up: [] }, reactions: { ...base.reactions, wake_up: {} } } as Persona;
    expect(actionWorks(noWake, 'sleep', env)).toBe(false);
  });

  it('подписи «Чудес» — по эффекту характера', () => {
    const label = (pid: 'kind' | 'hooligan' | 'glitter', id: string) =>
      buildCatalog(content.personas.get(pid)!, env).flatMap((s) => s.items).find((i) => i.id === id)?.label;
    expect(label('kind', 'bubbles')).toBe('Пузыри');
    expect(label('hooligan', 'bubbles')).toBe('Жвачка');
    expect(label('glitter', 'bubbles')).toBe('Блёстки');
    expect(label('hooligan', 'draw')).toBe('Граффити');
  });

  it('фразы «Скажи мне» распознаются тем же разбором, что и голос', () => {
    for (const f of SAY_PHRASES) expect(phraseIntent(f.text), f.text).toBe(f.intent);
    // команды-кнопки: текст для лога понимается как тот же интент
    for (const id of ACTIONS) {
      const r = ACTION_ROUTE[id];
      if ('say' in r) expect(phraseIntent(r.text), id).toBe(r.say);
    }
  });
});

describe('маршрутизация тапа', () => {
  it('действие → режиссёр, фраза → голосовой вход', () => {
    const action = vi.fn(), say = vi.fn();
    routeItem({ id: 'flip', label: 'Сальто', icon: 'flip', run: { action: 'flip' } }, { action, say });
    routeItem({ id: 'say:hello', label: 'Привет!', icon: 'chat', run: { say: 'Привет!' } } as CatalogItem, { action, say });
    expect(action).toHaveBeenCalledWith('flip');
    expect(say).toHaveBeenCalledWith('Привет!');
    expect(action).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledTimes(1);
  });

  it.each(ACTIONS)('%s: в игре сценарий отвечает реакцией или диалогом', (id) => {
    const r = ACTION_ROUTE[id];
    const res = 'say' in r
      ? step(play, { type: 'intent', intent: { type: r.say, text: r.text } }, cfg)
      : r.touch === 'shake' ? step(play, { type: 'shake' }, cfg) : step(play, { type: 'interaction', kind: r.touch }, cfg);
    const kinds = res.actions.map((a) => a.type);
    if ('say' in r && r.say === 'change_persona') expect(res.state.phase).toBe('switching');
    else if ('say' in r && content.dialogs.triggers[r.say]) expect(res.state.dialog).not.toBeNull();
    else if ('touch' in r && r.touch === 'double_tap') expect(kinds).toContain('signature');
    else {
      const ev = 'say' in r ? r.say : r.touch;
      expect(res.actions).toContainEqual({ type: 'react', event: ev });
    }
  });
});

describe('точки «новое»', () => {
  it('отмечает пробованное, считает «открыто N из M» и переживает перезапуск', () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const secs = buildCatalog(content.personas.get('glitter')!, env);
    const total = secs.flatMap((s) => s.items).length;
    const t = new TriedStore(store);
    expect(t.count(secs)).toEqual({ tried: 0, total });
    expect(t.mark('pet')).toBe(true);
    expect(t.mark('pet')).toBe(false);
    t.mark('say:hello');
    expect(new TriedStore(store).count(secs)).toEqual({ tried: 2, total });
    // битое значение и нет хранилища — не падает
    mem.set('ar.catalog.tried', '{');
    expect(new TriedStore(store).has('pet')).toBe(false);
    expect(new TriedStore(null).mark('pet')).toBe(true);
  });
});

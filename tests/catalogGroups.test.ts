import { describe, it, expect } from 'vitest';
import { loadTestContent } from './helpers/content';
import { buildCatalog, catalogEnv, moreSection, type CatalogItem } from '../src/ui/actionCatalog';
import { groupCatalog, filterGroups, firstMatch, oftenGroup, fitShift, shiftPoint, unshiftPoint, RecentStore, GROUP_ORDER, NO_SHIFT } from '../src/ui/catalogGroups';
import { deskHotkey, deskActive, testTabAllowed, DESK_MIN_W } from '../src/ui/deskPanel';
import { PERSONA_IDS } from '../src/persona/types';

const content = loadTestContent();
const env = catalogEnv(content.intents, content.dialogs.triggers);

describe('группы каталога (лист телефона и десктоп-панель): тот же источник, ничего не теряется', () => {
  it.each(PERSONA_IDS)('%s: каждый пункт каталога — ровно в одной группе', (pid) => {
    const secs = buildCatalog(content.personas.get(pid)!, env);
    const more = moreSection({ reanchor: true, mic: 'auto' })!;
    const home: CatalogItem = { id: 'home:go', label: 'Мой дом', icon: 'home_house', run: { ui: 'home' } };
    const withHome = secs.map((s) => (s.id === 'games' ? { ...s, items: [home, ...s.items] } : s));
    const extra = [
      { item: { id: 'ui:unstick', label: 'Сдёрнуть наклейки', icon: 'sticker', run: { ui: 'unstick' as const } }, section: 'magic' },
      { item: { id: 'zone:kitchen', label: 'Кухня', icon: 'home_kitchen', run: { ui: 'zone' as const } }, section: 'world' },
    ];
    const groups = groupCatalog([...withHome, more], extra);
    const src = [...withHome, more].flatMap((s) => s.items.map((i) => i.id)).concat(extra.map((e) => e.item.id));
    const got = groups.flatMap((g) => g.items.map((i) => i.id));
    expect([...got].sort()).toEqual([...new Set(src)].sort());
    expect(new Set(got).size).toBe(got.length);
    // порядок групп и раскладка по разделам из задачи
    expect(groups.map((g) => g.id)).toEqual(GROUP_ORDER.filter((id) => groups.some((g) => g.id === id)));
    const where = (id: string) => groups.find((g) => g.items.some((i) => i.id === id))?.id;
    expect(where('pet')).toBe('care');
    expect(where('flip')).toBe('tricks');
    expect(where('riddle')).toBe('games');
    expect(where('other')).toBe('look');
    expect(where('ui:unstick')).toBe('look');
    expect(where('home:go')).toBe('world');
    expect(where('zone:kitchen')).toBe('world');
    expect(where('ui:reanchor')).toBe('world');
    expect(where('ui:micmode')).toBe('service');
    expect(where('say:compliment')).toBe('say');
  });

  it('поиск: по началу слова, без регистра и ё; Enter — первый найденный', () => {
    const groups = groupCatalog(buildCatalog(content.personas.get('kind')!, env));
    const f = filterGroups(groups, 'КЛАСС');
    expect(f.flatMap((g) => g.items.map((i) => i.id))).toContain('say:compliment');
    expect(filterGroups(groups, 'щек').flatMap((g) => g.items.map((i) => i.id))).toContain('tickle');
    expect(filterGroups(groups, 'щёчки').flatMap((g) => g.items.map((i) => i.id))).toContain('cheek');
    expect(filterGroups(groups, '')).toBe(groups);
    expect(filterGroups(groups, 'абырвалг')).toEqual([]);
    expect(firstMatch(groups, 'сальт')?.id).toBe('flip');
    expect(firstMatch(groups, 'абырвалг')).toBeNull();
  });

  it('«Часто»: предложения кота, потом последние; только пункты каталога', () => {
    const groups = groupCatalog(buildCatalog(content.personas.get('kind')!, env));
    const o = oftenGroup(groups, ['flip', 'nope', 'pet'], ['riddle', 'giveup'])!;
    expect(o.items.map((i) => i.id)).toEqual(['riddle', 'flip', 'pet']);
    expect(oftenGroup(groups, [], [])).toBeNull();
    const mem = new Map<string, string>();
    const st = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const r = new RecentStore(st, 'k', 3);
    for (const id of ['a', 'b', 'a', 'c', 'd']) r.push(id);
    expect(r.list).toEqual(['d', 'c', 'a']);
    expect(new RecentStore(st, 'k', 3).list).toEqual(['d', 'c', 'a']);
  });
});

describe('сдвиг кота из-под листа', () => {
  const free = { top: 24, bottom: 430, left: 0, right: 390 };
  it('кот целиком над листом; уже над ним — без сдвига', () => {
    expect(fitShift({ top: 100, bottom: 300, cx: 195, half: 60 }, free)).toBe(NO_SHIFT);
    const v = fitShift({ top: 300, bottom: 620, cx: 195, half: 90 }, free);
    const top = shiftPoint(v, 195, 300), bottom = shiftPoint(v, 195, 620);
    expect(top.y).toBeGreaterThanOrEqual(free.top);
    expect(bottom.y).toBeLessThanOrEqual(free.bottom);
    // большой кот — уменьшается
    const big = fitShift({ top: 100, bottom: 800, cx: 195, half: 120 }, free);
    expect(big.s).toBeLessThan(1);
    expect(shiftPoint(big, 195, 800).y).toBeLessThanOrEqual(free.bottom);
    // касание по сдвинутому коту попадает в тот же пиксель несдвинутого
    const p = shiftPoint(big, 180, 500), q = unshiftPoint(big, p.x, p.y);
    expect(q.x).toBeCloseTo(180, 5);
    expect(q.y).toBeCloseTo(500, 5);
  });
});

describe('десктоп-панель: клавиши и включение', () => {
  it('клавиши', () => {
    expect(deskHotkey({ key: 'Tab' }, false)).toEqual({ kind: 'toggle' });
    expect(deskHotkey({ key: '\\', code: 'Backslash' }, false)).toEqual({ kind: 'toggle' });
    expect(deskHotkey({ key: 'ё', code: 'Backslash' }, false)).toEqual({ kind: 'toggle' });
    expect(deskHotkey({ key: '/', code: 'Slash' }, false)).toEqual({ kind: 'search' });
    expect(deskHotkey({ key: '3', code: 'Digit3' }, false)).toEqual({ kind: 'chip', index: 2 });
    expect(deskHotkey({ key: '3', code: 'Digit3' }, true)).toBeNull();
    expect(deskHotkey({ key: 'Tab', metaKey: true }, false)).toBeNull();
    expect(deskHotkey({ key: 'Escape' }, true)).toEqual({ kind: 'escape' });
    expect(deskHotkey({ key: 'r', code: 'KeyR' }, false)).toBeNull(); // вид — orbit.ts
  });
  it('только десктоп-просмотр и окно ≥ 900 px; «Тест» — lab или ?debug / ?from=test', () => {
    expect(deskActive(true, 1440)).toBe(true);
    expect(deskActive(true, DESK_MIN_W - 1)).toBe(false);
    expect(deskActive(false, 1440)).toBe(false);
    expect(testTabAllowed('?desktop', '', false)).toBe(false);
    expect(testTabAllowed('?desktop&debug', '', false)).toBe(true);
    expect(testTabAllowed('?desktop&from=test', '', false)).toBe(true);
    expect(testTabAllowed('?desktop', '', true)).toBe(true);
  });
});

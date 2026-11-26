// Пилот без «ласки» (feature pilot.noCare, продакт 26.11): в меню и репликах нет «погладь / пощекочи / обними / ласка»;
// левая колонка меню «Сюрпризы» — значки сервисов с «?» (онборды), угостить, дай лапу. Плюс «яйцо покемона» в пробуждении.
import { describe, it, expect } from 'vitest';
import { loadTestContent, dialogsFile } from './helpers/content';
import { buildCatalog, catalogEnv, moreSection, type CatalogItem, type CatalogSection } from '../src/ui/actionCatalog';
import { CARE_RE, editionDialogs, noCareLines } from '../src/persona/content';
import { PERSONA_IDS } from '../src/persona/types';
import { CARE_ACTIONS, PILOT_SIGNATURE, pilotCommon, cutAction } from '../src/config/pilot';
import { groupCatalog } from '../src/ui/catalogGroups';
import { tapsTo, tomLayout, tomModel } from '../src/ui/tomLayout';
import { SVC_ITEMS } from '../src/config/onboards';
import { Suggester, hintText, type SuggestSnapshot } from '../src/scenario/suggest';
import { awakePlan, HOPS_FIRST, PILLAR_FIRST } from '../src/awake/timeline';

const content = loadTestContent();
const env = catalogEnv(content.intents, editionDialogs(dialogsFile, false).triggers);
const NO_CARE = { signature: true, pilot: true, noCare: true };
const CARE_WORDS = /погладь|гладить|пощекоч|щекотка|обними|обнять|ласк|почесать/i;

function groups(pid: (typeof PERSONA_IDS)[number]) {
  const secs: CatalogSection[] = buildCatalog(content.personas.get(pid)!, env, NO_CARE);
  const homeIt: CatalogItem = { id: 'home:go', label: 'Мой дом', icon: 'home_house', run: { ui: 'home' } };
  const withHome = secs.map((s) => (s.id === 'games' ? { ...s, items: [homeIt, ...s.items] } : s));
  const extra = SVC_ITEMS.map((s) => ({ item: { id: s.id, label: s.label, icon: s.icon, run: { ui: 'onb' as const } }, section: 'svc' }));
  return groupCatalog([...withHome, moreSection({ reanchor: true, mic: 'auto' })!], extra);
}

describe('пилот без «ласки»: каталог и меню', () => {
  it('общие действия: угостить, дай лапу, танец, сальто — без погладить/почесать/щекотки/обнять', () => {
    expect([...pilotCommon(true)]).toEqual(['treat', 'paw', 'dance', 'flip']);
    for (const id of CARE_ACTIONS) expect(pilotCommon(true)).not.toContain(id);
    // «как было» (lab, тесты без флага) — 8 общих
    expect(pilotCommon(false).length).toBe(8);
  });
  it.each(PERSONA_IDS)('%s: в каталоге и в колонках нет слов ласки; слева «Сюрпризы» — Самокат?, СберKids?, лапа, угостить', (pid) => {
    const g = groups(pid);
    const all = g.flatMap((x) => x.items);
    for (const it of all) expect(it.label, it.id).not.toMatch(CARE_WORDS);
    for (const id of CARE_ACTIONS) expect(all.map((i) => i.id)).not.toContain(id);
    const model = tomModel(g, { home: null });
    expect(model.left.map((i) => i.id)).toEqual(['svc:samokat', 'svc:kids', 'paw', 'treat']);
    expect(model.right.slice(0, 2).map((i) => i.id)).toEqual(['dance', 'flip']);
    expect(model.right.map((i) => i.id)).toEqual(expect.arrayContaining([...PILOT_SIGNATURE[pid]]));
    // значки сервисов — одним касанием на телефоне
    const plan = tomLayout({ w: 390, h: 844, safe: { t: 47, b: 34 }, left: model.left.length, right: model.right.length, room: false }, { cx: 195, top: 330, bottom: 640, half: 105 });
    for (const s of SVC_ITEMS) expect(tapsTo(model, plan, s.id), s.id).toBe(1);
  });
  it('голосом «погладь» — как вырезанное действие («Давай лучше …»)', () => {
    expect(cutAction('kind', 'pet')).toBe(null); // в lab-тестах погладить есть (флаг выкл.)
  });
});

describe('пилот без «ласки»: реплики', () => {
  it.each(PERSONA_IDS)('%s: ни одна реплика не зовёт гладить/щекотать/обнимать; события не пропадают', (pid) => {
    const p = content.personas.get(pid)!;
    const q = noCareLines(p, true);
    for (const [ev, ls] of Object.entries(q.lines)) for (const l of ls) expect(l.text, `${ev} ${l.id}`).not.toMatch(CARE_RE);
    // знакомство: «что я умею» — озвученные варианты help без ласки (с их id — та же запись)
    expect(q.lines.meet_skills?.length).toBeGreaterThan(0);
    for (const l of q.lines.meet_skills) expect(l.id).toMatch(new RegExp(`^${pid}\\.help\\.`));
    // та же фраза не звучит дважды подряд: в help её больше нет
    for (const l of q.lines.meet_skills) expect((q.lines.help ?? []).map((x) => x.id)).not.toContain(l.id);
    // поддержка («мне грустно») остаётся
    expect(q.lines.sad?.length).toBeGreaterThan(0);
    // «щекотно!» на тычок в живот — реакция, не приглашение: остаётся
    expect(q.lines.tap_cat_belly?.length).toBeGreaterThan(0);
    // выключено — как было
    expect(noCareLines(p, false)).toBe(p);
  });
});

describe('пилот без «ласки»: подсказки кота', () => {
  const avail = new Map([['treat', { label: 'Угостить', icon: 'fish' }], ['dance', { label: 'Танец', icon: 'note' }], ['riddle', { label: 'Загадка', icon: 'quest' }]]);
  const snap = (o: Partial<SuggestSnapshot> = {}): SuggestSnapshot => ({
    now: 0, phase: 'play', appeared: true, dialog: null, paused: false, dozing: false, speaking: false, quietMs: 0, visits: 5, available: avail, tried: () => false, ...o,
  });
  it('кот дремлет — «Разбуди меня» угощением; подсказка в пузыре не зовёт гладить', () => {
    const s = new Suggester();
    const doze = s.update(snap({ dozing: true })).chips;
    expect(doze.map((c) => [c.id, c.label])).toEqual([['treat', 'Разбуди меня']]);
    const h = s.update(snap({ now: 200_000, quietMs: 60_000, visits: 1 })).hint;
    expect(h).toBeTruthy();
    expect(h!).not.toMatch(CARE_WORDS);
    expect(hintText([{ id: 'dance', label: 'Танец', icon: 'note', run: { action: 'dance' } }], true)).not.toMatch(CARE_WORDS);
  });
});

describe('пробуждение «как яйцо покемона»: карта дрожит и подпрыгивает, потом столб света', () => {
  it.each(PERSONA_IDS)('%s: три подскока, каждый выше; дрожь сильнее; столб — после подскоков', (pid) => {
    const p = awakePlan(pid, 'first');
    const peaks = HOPS_FIRST.map(([t]) => p.hop(t + 0.1).z);
    expect(peaks[0]).toBeGreaterThan(0.01);
    expect(peaks[1]).toBeGreaterThan(peaks[0]);
    expect(peaks[2]).toBeGreaterThan(peaks[1]);
    const shake = (t0: number) => {
      let m = 0;
      for (let t = t0 - 0.2; t < t0; t += 0.005) m = Math.max(m, Math.hypot(p.hop(t).x, p.hop(t).y));
      return m;
    };
    expect(shake(HOPS_FIRST[2][0])).toBeGreaterThan(shake(HOPS_FIRST[0][0]));
    // свечение «крышки» растёт серией к серии
    expect(p.hop(HOPS_FIRST[2][0]).k).toBeGreaterThan(p.hop(HOPS_FIRST[0][0]).k);
    // до последнего приземления столба нет; потом столб растёт и кот выходит после него
    const lastLand = HOPS_FIRST[2][0] + 0.2;
    expect(p.pillar(lastLand - 0.05).k).toBe(0);
    expect(PILLAR_FIRST).toBeGreaterThanOrEqual(lastLand - 0.06);
    expect(p.pillar(PILLAR_FIRST + 0.4).h).toBeGreaterThan(0.5);
    expect(p.tPop).toBeGreaterThan(PILLAR_FIRST + 0.4);
    // после столба карта лежит спокойно
    expect(p.hop(p.tPop).z).toBe(0);
    expect(p.hop(p.tPop).k).toBe(0);
    // стук карты о стол — громче с каждой серией
    const thumps = p.events.filter((e) => e.type === 'sfx' && e.id === 'land_soft').map((e) => (e as { vol?: number }).vol ?? 1);
    expect(thumps.length).toBe(3);
    expect(thumps[2]).toBeGreaterThan(thumps[0]);
  });
});

// редакция pilot (https://ar.vershov.com/mvp, docs/EDITIONS.md «Пилот»): наборы и лимиты src/config/pilot.ts
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import fxCatalog from '../content/fx.json';
import { loadTestContent, dialogsFile } from './helpers/content';
import { buildCatalog, catalogEnv, moreSection, type CatalogSection } from '../src/ui/actionCatalog';
import { editionDialogs } from '../src/persona/content';
import { PERSONA_IDS, type PersonaId } from '../src/persona/types';
import { ACTION_ROUTE, type ActionId } from '../src/scenario/actions';
import { PILOT_COMMON, PILOT_CUT_EVENT, PILOT_CUT_TEXT, PILOT_SIGNATURE, PILOT_FX, SYSTEM_FX, SWITCH_COOLDOWN_MS, SWITCH_LATER_EVENT, SWITCH_LATER_TEXT, SwitchCooldown, cutAction, cutRedirect, fxAllowed, limitCatalog, pilotItemAllowed } from '../src/config/pilot';
import { Suggester, type SuggestSnapshot } from '../src/scenario/suggest';
import { groupCatalog } from '../src/ui/catalogGroups';

const content = loadTestContent();
// диалоги — как в сборке пилота: без новых игр (games.new выкл.)
const env = catalogEnv(content.intents, editionDialogs(dialogsFile, false).triggers);
const PILOT = { signature: true, pilot: true };
const ids = (secs: CatalogSection[]) => secs.flatMap((s) => s.items.map((i) => i.id));

/** пункты мира и служебные, которые к каталогу добавляют app.ts (withHome, extraItems) и ui.ts (moreSection) */
const world = (home: boolean): CatalogSection[] => [
  { id: 'games', title: 'Игры', icon: 'quest', items: [{ id: home ? 'home:back' : 'home:go', label: home ? 'На карту' : 'Мой дом', icon: 'home_house', run: { ui: 'home' } }] },
  { id: 'more', title: 'Мир', icon: 'home_house', items: home ? [{ id: 'zone:kitchen', label: 'Кухня', icon: 'home_kitchen', run: { ui: 'zone' } }, { id: 'zone:bedroom', label: 'Спальня', icon: 'home_moon', run: { ui: 'zone' } }] : [] },
  moreSection({ reanchor: true, mic: 'auto' })!,
];

describe('пилот: каталог на кота — ровно 8 общих + 2 фирменных, игры, «Другой кот» и мир', () => {
  it.each(PERSONA_IDS)('%s', (pid) => {
    const p = content.personas.get(pid)!;
    const secs = buildCatalog(p, env, PILOT);
    const acts = ids(secs);
    const want = [...PILOT_COMMON, ...PILOT_SIGNATURE[pid], 'riddle', 'other'];
    expect(new Set(acts)).toEqual(new Set(want));
    expect(acts).toHaveLength(12);
    // действий кота — ровно 10
    expect(acts.filter((a) => !['riddle', 'other'].includes(a))).toHaveLength(10);
    // ни «Эмоций», ни «Скажи мне», ни наклеек
    expect(secs.map((s) => s.id)).not.toContain('emotions');
    expect(secs.map((s) => s.id)).not.toContain('say');
    for (const cut of ['sticker', 'jump', 'sing', 'wave', 'sit', 'trick', 'laugh', 'surprise', 'shy', 'tease', 'dizzy', 'sleep', 'knock', 'emo', 'rps', 'simon', 'cheek']) expect(acts, cut).not.toContain(cut);
    // мир и служебное — проходят, в сетке листа — вкладка «Мир»
    for (const home of [false, true]) {
      const all = limitCatalog(pid, [...secs, ...world(home)]);
      const w = ids(all).filter((i) => /^(home:|zone:|ui:)/.test(i));
      expect(w).toEqual(home ? ['home:back', 'zone:kitchen', 'zone:bedroom', 'ui:micmode', 'ui:reanchor'] : ['home:go', 'ui:micmode', 'ui:reanchor']);
      expect(groupCatalog(all).map((g) => g.id)).toContain('world');
    }
  });

  it('фирменные — только у своего кота (в lab тоже), в MVP их нет', () => {
    const own: Record<PersonaId, string> = { hooligan: 'skate', kind: 'cocoa', glitter: 'mirror' };
    for (const pid of PERSONA_IDS) {
      const p = content.personas.get(pid)!;
      const lab = ids(buildCatalog(p, env, { signature: true, pilot: false }));
      const mvp = ids(buildCatalog(p, env, { signature: false, pilot: false }));
      for (const [who, id] of Object.entries(own)) expect(lab.includes(id), `${pid}/${id}`).toBe(who === pid);
      for (const id of Object.values(own)) expect(mvp).not.toContain(id);
      // у фирменного есть видимая реакция: клип (и эффект скейта)
      const r = p.reactions[own[pid]];
      expect(r?.clip, pid).toMatch(/^idle_/);
    }
    expect(content.personas.get('hooligan')!.reactions.skate.fx).toBe('skate_sparks');
    for (const id of ['skate', 'cocoa', 'mirror'] as ActionId[]) expect(ACTION_ROUTE[id]).toEqual({ touch: id });
  });

  it('подписи фирменных: Добряк — «Пузыри», Блёстка — «Блёстки», Хулиган — «К стеклу»', () => {
    const label = (pid: PersonaId, id: string) => buildCatalog(content.personas.get(pid)!, env, PILOT).flatMap((s) => s.items).find((i) => i.id === id)?.label;
    expect(label('kind', 'bubbles')).toBe('Пузыри');
    expect(label('glitter', 'bubbles')).toBe('Блёстки');
    expect(label('hooligan', 'glass')).toBe('К стеклу');
    expect(label('hooligan', 'skate')).toBe('Скейт');
    expect(label('kind', 'cocoa')).toBe('Какао');
    expect(label('glitter', 'mirror')).toBe('Зеркальце');
  });

  it('чипы кота — только из каталога пилота', () => {
    for (const pid of PERSONA_IDS) {
      const available = new Map(buildCatalog(content.personas.get(pid)!, env, PILOT).flatMap((s) => s.items).map((i) => [i.id, { label: i.label, icon: i.icon }]));
      const sg = new Suggester();
      const seen = new Set<string>();
      const snap = (now: number, tried: Set<string>): SuggestSnapshot => ({ now, phase: 'play', appeared: true, dialog: null, paused: false, dozing: false, speaking: false, quietMs: 0, visits: 5, available, tried: (id) => tried.has(id), voiced: () => true });
      const tried = new Set<string>();
      for (let t = 0; t < 400; t++) {
        const r = sg.update(snap(200_000 + t * 1000, tried));
        for (const c of r.chips) {
          seen.add(c.id);
          tried.add(c.id);
          sg.note(c.id);
        }
      }
      for (const id of seen) expect(pilotItemAllowed(pid, id), `${pid}: ${id}`).toBe(true);
      expect(seen.size).toBeGreaterThan(3);
    }
  });
});

describe('пилот: голосовые команды вырезанных действий не выполняются', () => {
  it.each(PERSONA_IDS)('%s', (pid) => {
    // команды действий вне набора — «давай лучше» (интентом сценарий их уже не получает: director.intentGate)
    for (const it of ['jump', 'sit', 'wave', 'sing', 'stickers', 'emo_game', 'rps', 'simon']) {
      const r = cutRedirect(pid, it, () => undefined);
      expect(r, it).not.toBeNull();
      expect(r!.text).toMatch(/^Это я пока не умею\. Давай лучше /);
      expect(r!.chips).toHaveLength(2);
      for (const c of r!.chips) expect(pilotItemAllowed(pid, c), c).toBe(true);
    }
    // в наборе и разговор — как обычно
    for (const it of ['flip', 'dance', 'riddle', 'change_persona', 'hello', 'joke', 'compliment', 'sad', 'name_ask', 'yes', 'no', 'unknown']) expect(cutAction(pid, it), it).toBeNull();
  });
  it('«надуй пузырь» (gum): у Добряка и Блёстки — их фирменное, у Хулигана (жвачка) — вне набора', () => {
    expect(cutAction('kind', 'gum')).toBeNull();
    expect(cutAction('glitter', 'gum')).toBeNull();
    expect(cutAction('hooligan', 'gum')).toBe('bubbles');
  });
  it('замена — первым фирменное кота, подпись из каталога', () => {
    const r = cutRedirect('hooligan', 'jump', (id) => (id === 'skate' ? 'Скейт' : undefined))!;
    expect(r.chips[0]).toBe('skate');
    // текст = озвученная реплика pilot_cut (фирменное кота), пузырь с голосом
    expect(r.text).toBe('Это я пока не умею. Давай лучше на скейте покатаюсь!');
    expect(r.event).toBe(PILOT_CUT_EVENT);
  });
  it.each(PERSONA_IDS)('%s: «Это я пока не умею…» и «Чуть позже!» — тексты совпадают с репликами content (озвучка pilot_cut / pilot_switch_later)', (pid) => {
    const lines = (JSON.parse(fs.readFileSync(path.resolve(__dirname, `../content/personas/${pid}.json`), 'utf8')) as { lines: Record<string, { id: string; text: string }[]> }).lines;
    expect(lines[PILOT_CUT_EVENT].map((l) => l.text)).toEqual([PILOT_CUT_TEXT[pid]]);
    expect(lines[SWITCH_LATER_EVENT].map((l) => l.text)).toEqual([SWITCH_LATER_TEXT]);
    // первый чип замены — всегда фирменное кота: у любой вырезанной команды текст записи
    for (const it of ['jump', 'sit', 'wave', 'sing', 'stickers', 'rps']) {
      const r = cutRedirect(pid, it, () => undefined)!;
      expect(r.chips[0]).toBe(PILOT_SIGNATURE[pid][0]);
      expect(r.text).toBe(PILOT_CUT_TEXT[pid]);
    }
  });
  it('чипы замены держатся первыми REDIRECT_MS', () => {
    const available = new Map([['pet', { label: 'Погладить', icon: 'hand' }], ['dance', { label: 'Танец', icon: 'note' }], ['skate', { label: 'Скейт', icon: 'skate' }]]);
    const sg = new Suggester();
    const s = (now: number): SuggestSnapshot => ({ now, phase: 'play', appeared: true, dialog: null, paused: false, dozing: false, speaking: false, quietMs: 0, visits: 5, available, tried: () => true });
    sg.update(s(0));
    sg.prefer(['skate', 'dance'], 1000);
    expect(sg.update(s(2000)).chips.map((c) => c.id)).toEqual(['skate', 'dance']);
  });
});

describe('пилот: смена кота не чаще раза в 3 мин', () => {
  it('первая — можно, повтор раньше 3 мин — нет, после — можно', () => {
    const c = new SwitchCooldown();
    expect(SWITCH_COOLDOWN_MS).toBe(180_000);
    expect(c.allow(0)).toBe(true);
    c.mark(1000);
    expect(c.allow(1000 + 60_000)).toBe(false);
    expect(c.wait(1000 + 60_000)).toBe(120_000);
    expect(c.allow(1000 + 179_999)).toBe(false);
    expect(c.allow(1000 + 180_000)).toBe(true);
    expect(c.wait(1000 + 180_000)).toBe(0);
  });
});

describe('пилот: эффекты — белый список 2–3 на кота', () => {
  const known = new Set((fxCatalog as unknown as { fx: { id: string }[] }).fx.map((e) => e.id));
  it.each(PERSONA_IDS)('%s', (pid) => {
    // «части» одного эффекта (пятна жвачки к пузырю) не считаем отдельным эффектом
    const main = PILOT_FX[pid].filter((f) => f !== 'gum_splat');
    expect(main.length).toBeGreaterThanOrEqual(2);
    expect(main.length).toBeLessThanOrEqual(3);
    for (const f of [...PILOT_FX[pid], ...SYSTEM_FX]) if (f !== 'none') expect(known.has(f), f).toBe(true);
    // фирменные действия кота показывают свой эффект
    const p = content.personas.get(pid)!;
    for (const a of PILOT_SIGNATURE[pid]) {
      const r = ACTION_ROUTE[a];
      const ev = 'touch' in r ? r.touch : r.say;
      const fx = p.reactions[ev]?.fx;
      if (fx) expect(fxAllowed(pid, fx), `${pid}.${a}: ${fx}`).toBe(true);
    }
    // чужие и «лишние» — нет
    expect(fxAllowed(pid, 'dizzy_stars')).toBe(false);
    expect(fxAllowed(pid, 'warm_lights')).toBe(false);
    // стекло пальцем и служебные — у всех
    for (const f of ['claws', 'steam_draw', 'zzz', 'stickers_blow']) expect(fxAllowed(pid, f)).toBe(true);
  });
});

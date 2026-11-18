// меню «как у Говорящего Тома» (feature ui.tomLayout, docs/ui/TOM_LAYOUT.md): раскладка, досягаемость, автоскрытие
import { describe, it, expect } from 'vitest';
import { loadTestContent, dialogsFile } from './helpers/content';
import { buildCatalog, catalogEnv, moreSection, type CatalogItem, type CatalogSection } from '../src/ui/actionCatalog';
import { editionDialogs } from '../src/persona/content';
import { PERSONA_IDS } from '../src/persona/types';
import { PILOT_COMMON, PILOT_SIGNATURE } from '../src/config/pilot';
import { groupCatalog } from '../src/ui/catalogGroups';
import { paintCatalogItems } from '../src/card/paintPlan';
import { FEATURES } from '../src/config/edition';
import {
  TOM_IDLE_MS, TomAutoHide, catHit, disabledReason, rectsHit, roomItems, tapsTo, tomLayout, tomModel, type CatBox, type Rect, type TomPlan,
} from '../src/ui/tomLayout';

const content = loadTestContent();
const env = catalogEnv(content.intents, editionDialogs(dialogsFile, false).triggers);
const PILOT = { signature: true, pilot: true };

/** группы каталога пилота так, как их собирает ui.ts: разделы кота + «Мой дом» (app.ts withHome) + «Ещё» + раскраска */
function pilotGroups(pid: (typeof PERSONA_IDS)[number], home: 'kitchen' | 'living' | 'bedroom' | null = null, painted = false) {
  const secs: CatalogSection[] = buildCatalog(content.personas.get(pid)!, env, PILOT);
  const homeIt: CatalogItem = home ? { id: 'home:back', label: 'На карту', icon: 'home_card', run: { ui: 'home' } } : { id: 'home:go', label: 'Мой дом', icon: 'home_house', run: { ui: 'home' } };
  const withHome = secs.map((s) => (s.id === 'games' ? { ...s, items: [homeIt, ...s.items] } : s));
  const more = moreSection({ reanchor: true, mic: 'auto' })!;
  const extra = paintCatalogItems(painted).map((item) => ({ item: item as CatalogItem, section: 'magic' }));
  if (home) for (const z of ['kitchen', 'living', 'bedroom'].filter((z) => z !== home)) extra.push({ item: { id: `zone:${z}`, label: z, icon: 'home_house', run: { ui: 'zone' } }, section: 'world' });
  return groupCatalog([...withHome, more], extra);
}

const SCREENS = [
  { w: 360, h: 740, safe: { t: 24, b: 0 } },
  { w: 390, h: 844, safe: { t: 47, b: 34 } },
  { w: 430, h: 932, safe: { t: 59, b: 34 } },
  { w: 844, h: 390, safe: { l: 47, r: 47, b: 21 } },
];
/** кот на карте в нижней середине (как на телефоне), левее/правее, крупно (телефон близко), дома */
function cats(w: number, h: number): { name: string; cat: CatBox; typical?: boolean }[] {
  const land = w > h;
  const mk = (cx: number, top: number, bottom: number, k = 0.34): CatBox => ({ cx, top, bottom, half: Math.max(40, (bottom - top) * k) });
  if (land)
    return [
      { name: 'центр', cat: mk(w / 2, h * 0.26, h * 0.8), typical: true },
      { name: 'левее', cat: mk(w * 0.36, h * 0.3, h * 0.82) },
      { name: 'правее', cat: mk(w * 0.64, h * 0.3, h * 0.82) },
      { name: 'крупно', cat: mk(w / 2, h * 0.08, h * 0.98, 0.45) },
    ];
  return [
    { name: 'центр', cat: mk(w / 2, h * 0.42, h * 0.76), typical: true },
    { name: 'дом', cat: mk(w / 2, h * 0.3, h * 0.7, 0.32), typical: true },
    { name: 'левее', cat: mk(w * 0.36, h * 0.45, h * 0.78) },
    { name: 'правее', cat: mk(w * 0.66, h * 0.4, h * 0.75) },
    { name: 'крупно', cat: mk(w / 2, h * 0.22, h * 0.82, 0.44) },
    { name: 'у края', cat: mk(w * 0.18, h * 0.4, h * 0.8) },
  ];
}
const inScreen = (r: Rect, w: number, h: number) => r.x >= 0 && r.y >= 0 && r.x + r.w <= w + 0.5 && r.y + r.h <= h + 0.5;
const allSlots = (p: TomPlan) => [...p.left.slots, ...p.right.slots];

describe('tomLayout: колонки не налезают на кота', () => {
  for (const s of SCREENS)
    for (const c of cats(s.w, s.h))
      it(`${s.w}×${s.h}, кот ${c.name}`, () => {
        for (const room of [false, true]) {
          const p = tomLayout({ w: s.w, h: s.h, safe: s.safe, left: 6, right: 6, room }, c.cat);
          for (const r of allSlots(p)) {
            expect(catHit(r, c.cat), `ячейка ${JSON.stringify(r)} на коте`).toBe(false);
            expect(inScreen(r, s.w, s.h)).toBe(true);
            // не под верхней полосой (safe-area + прогресс), не на ряду чипов и не в доке
            expect(r.y).toBeGreaterThanOrEqual((s.safe.t ?? 0) + 48);
            expect(rectsHit(r, p.chips), 'ряд чипов').toBe(false);
            if (p.room) expect(rectsHit(r, p.room), 'ряд комнаты').toBe(false);
            if (!p.land) expect(r.y + r.h).toBeLessThanOrEqual(p.dockTop);
            expect(r.y + r.h).toBeLessThanOrEqual(s.h - (s.safe.b ?? 0));
          }
          // колонки — у своих краёв с учётом safe-area, друг на друга не налезают
          for (const r of p.left.slots) expect(r.x).toBeGreaterThanOrEqual(Math.max(6, ((s.safe as { l?: number }).l ?? 0) + 4) - 0.01);
          for (const r of p.right.slots) expect(r.x + r.w).toBeLessThanOrEqual(s.w - Math.max(6, ((s.safe as { r?: number }).r ?? 0) + 4) + 0.01);
          for (const a of p.left.slots) for (const b of p.right.slots) expect(rectsHit(a, b)).toBe(false);
          // спрятанная колонка — язычок, и он тоже мимо кота
          for (const col of [p.left, p.right]) if (col.mode === 'tab') expect(catHit(col.tab, c.cat)).toBe(false);
          // обычный кот в нижней середине: обе колонки на экране целиком
          if (c.typical) {
            expect(p.left.mode, 'левая').not.toBe('tab');
            expect(p.right.mode, 'правая').not.toBe('tab');
            expect(p.left.cap).toBe(6);
            expect(p.right.cap).toBe(6);
          }
        }
      });
  it('альбомная: колонки — сетки 2×3, док и чипы между ними', () => {
    const p = tomLayout({ w: 844, h: 390, left: 6, right: 6 }, cats(844, 390)[0].cat);
    expect(p.land).toBe(true);
    expect(p.left.cols).toBe(2);
    expect(p.free.left).toBeLessThan(844 / 2 - 150);
    expect(p.free.right).toBeGreaterThan(844 / 2 + 150);
  });
  it('держит прежний режим колонки, пока он не налезает на кота (без дрожания)', () => {
    // кот в 10 px от колонки: обычная колонка помещается, но без запаса
    const cat: CatBox = { cx: 195, top: 300, bottom: 600, half: 111 };
    const a = tomLayout({ w: 390, h: 844, left: 6, right: 6 }, cat);
    expect(a.left.mode).toBe('col');
    const b = tomLayout({ w: 390, h: 844, left: 6, right: 6, prefer: { l: 'coltop', r: 'coltop' } }, cat);
    expect(b.left.mode).toBe('coltop');
    // кот ушёл далеко — назад к лучшему режиму
    const far: CatBox = { cx: 195, top: 300, bottom: 600, half: 70 };
    expect(tomLayout({ w: 390, h: 844, left: 6, right: 6, prefer: { l: 'grid', r: 'grid' } }, far).left.mode).toBe('col');
    // крупный кот вплотную к колонке — режим меняется, кот важнее
    const big: CatBox = { cx: 195, top: 150, bottom: 700, half: 170 };
    const c = tomLayout({ w: 390, h: 844, left: 6, right: 6, prefer: { l: 'col', r: 'col' } }, big);
    for (const r of allSlots(c)) expect(catHit(r, big)).toBe(false);
  });
});

describe('tomModel: каждое действие пилота — не больше двух касаний', () => {
  for (const pid of PERSONA_IDS)
    for (const home of [null, 'kitchen', 'bedroom'] as const)
      it(`${pid}${home ? `, дома (${home})` : ', на карте'}`, () => {
        const groups = pilotGroups(pid, home, pid === 'kind');
        const model = tomModel(groups, { home });
        // левая колонка — «Ласка» в порядке продакта, правая — танец, сальто, 2 фирменных, раскраска, «Другой кот»
        expect(model.left.map((i) => i.id)).toEqual(['pet', 'scratch', 'tickle', 'hug', 'paw', 'treat']);
        expect(model.right.slice(0, 2).map((i) => i.id)).toEqual(['dance', 'flip']);
        expect(model.right.map((i) => i.id)).toEqual(expect.arrayContaining([...PILOT_SIGNATURE[pid], 'ui:paint', 'other']));
        expect(model.games.map((i) => i.id)).toEqual(['riddle', 'echo']);
        expect(model.home?.id).toBe(home ? 'home:back' : 'home:go');
        for (const s of SCREENS) {
          const plan = tomLayout({ w: s.w, h: s.h, safe: s.safe, left: model.left.length, right: model.right.length, room: !!home }, cats(s.w, s.h)[0].cat);
          const want = [...PILOT_COMMON, ...PILOT_SIGNATURE[pid], 'riddle', 'echo', 'other', 'ui:paint', home ? 'home:back' : 'home:go', 'ui:micmode', ...(home ? [] : ['ui:reanchor']), ...model.room.map((i) => i.id)];
          for (const id of want) expect(tapsTo(model, plan, id), `${id} (${s.w}×${s.h})`).toBeLessThanOrEqual(2);
          // и вообще всё из каталога (кроме комнат — они стрелками): ничего не потерялось
          for (const it of groups.flatMap((g) => g.items)) if (!it.id.startsWith('zone:') && !(home && it.id === 'ui:reanchor')) expect(tapsTo(model, plan, it.id), it.id).toBeLessThanOrEqual(2);
          // самое частое — одним касанием: вся «Ласка», танец, сальто, фирменные
          if (!plan.land || s.h >= 390) for (const id of [...PILOT_COMMON, ...PILOT_SIGNATURE[pid]]) expect(tapsTo(model, plan, id), id).toBe(1);
        }
      });
  it('дома — действия комнаты: кухня угостить/какао, спальня уложить/разбудить, гостиная мячик/танец', () => {
    expect(roomItems('kitchen').map((i) => i.id)).toEqual(['home:treat', 'home:cocoa']);
    expect(roomItems('bedroom').map((i) => i.id)).toEqual(['home:sleep', 'home:wake']);
    expect(roomItems('living').map((i) => i.id)).toEqual(['home:ball', 'home:dance']);
    expect(roomItems(null)).toEqual([]);
  });
  it('неактивные кнопки объясняют почему', () => {
    expect(disabledReason({ id: 'ui:paint' }, { home: null, paintBlocked: true })).toBe('Сначала покажи мне карту');
    expect(disabledReason({ id: 'ui:paint' }, { home: 'kitchen' })).toBe('Сначала покажи мне карту');
    expect(disabledReason({ id: 'ui:paint' }, { home: null, paintBlocked: false })).toBeNull();
    expect(disabledReason({ id: 'home:wake' }, { home: 'bedroom', sleeping: false })).toBeTruthy();
    expect(disabledReason({ id: 'home:sleep' }, { home: 'bedroom', sleeping: true })).toBeTruthy();
    expect(disabledReason({ id: 'pet' }, { home: null })).toBeNull();
  });
  it('лишние пункты (lab) уходят в «Ещё» последней ячейки — тоже два касания', () => {
    const many = Array.from({ length: 11 }, (_, i): CatalogItem => ({ id: `a${i}`, label: `A${i}`, icon: 'star', run: { action: 'pet' } }));
    const model = { left: many, right: [], games: [], service: [], home: null, room: [] };
    const plan = tomLayout({ w: 390, h: 844, left: 11, right: 0 }, null);
    expect(plan.left.cap).toBeLessThan(11);
    expect(tapsTo(model, plan, 'a0')).toBe(1);
    expect(tapsTo(model, plan, 'a10')).toBe(2);
  });
});

describe('TomAutoHide: колонки уезжают к краю', () => {
  it('через 6 с без касаний; касание где угодно — таймер заново; вернуть — касание у края', () => {
    const a = new TomAutoHide();
    a.reveal(0);
    expect(a.hidden(TOM_IDLE_MS - 1, null)).toBe(false);
    a.touch(5000);
    expect(a.hidden(5000 + TOM_IDLE_MS - 1, null)).toBe(false);
    expect(a.hidden(5000 + TOM_IDLE_MS, null)).toBe(true);
    // спрятаны: обычное касание их не возвращает
    a.touch(20000);
    expect(a.hidden(20001, null)).toBe(true);
    a.reveal(20002);
    expect(a.hidden(20003, null)).toBe(false);
  });
  it('на время сцен (пробуждение, раскраска, сон, переход) — сразу; после — возвращаются сами', () => {
    const a = new TomAutoHide();
    a.reveal(0);
    for (const b of ['awake', 'paint', 'sleep', 'cutscene'] as const) expect(a.hidden(100, b)).toBe(true);
    expect(a.hidden(200, null)).toBe(false);
    expect(a.hidden(200 + TOM_IDLE_MS, null)).toBe(true);
  });
  it('поповер или подсказка открыты — не прячем', () => {
    const a = new TomAutoHide();
    a.reveal(0);
    expect(a.hidden(TOM_IDLE_MS * 2, null, true)).toBe(false);
  });
});

describe('редакции', () => {
  it('ui.tomLayout: пилот и lab — да, MVP — прежний лист', () => {
    expect(FEATURES['ui.tomLayout']).toMatchObject({ mvp: false, lab: true, pilot: true });
  });
});

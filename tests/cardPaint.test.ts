// @vitest-environment jsdom
/**
 * Раскраска карты (src/card/paint.ts, paintPlan.ts; feature card.paint): когда кот предлагает, только на захваченной
 * карте, память о рисунке (туда и обратно, сервер прогресса), пункт каталога в пилоте, мазок закрывает карту целиком
 * (номер и имя не видны), полный проход раскраски без трёхмерной сцены.
 */
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import {
  OFFER_FIRST_MS, OFFER_PLAY_MS, PAINT_KEY, PAINT_STYLE, PaintOfferRule, erasePaint, findSwatch, headFromCat, loadPaint, paintBlocked, paintCatalogItems,
  paintRows, savePaint, strokeCoverage, rng,
} from '../src/card/paintPlan';
import { CardPaint, type CardPaintHost } from '../src/card/paint';
import { CARD_ASPECT } from '../src/config';
import { PERSONA_IDS } from '../src/persona/types';
import { limitCatalog, pilotItemAllowed } from '../src/config/pilot';
import { buildCatalog, catalogEnv, type CatalogSection } from '../src/ui/actionCatalog';
import { groupCatalog } from '../src/ui/catalogGroups';
import { editionDialogs } from '../src/persona/content';
import { loadTestContent, dialogsFile } from './helpers/content';
import { isProgressKey } from '../src/progress/sync';
import { sanitize, EVENTS } from '../src/analytics';
import { featureIn, filterSearch } from '../src/config/edition';

class MemStore {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

describe('предложение «Хочешь, раскрашу твою карту?»', () => {
  it('не в первую минуту, даже после игры', () => {
    const r = new PaintOfferRule();
    r.begin(0);
    r.gameEnd();
    expect(r.due(10_000, true)).toBe(false);
    expect(r.due(OFFER_FIRST_MS - 1, true)).toBe(false);
    expect(r.due(OFFER_FIRST_MS + 1, true)).toBe(true);
  });
  it('без игры — после 90 с, и только когда кот свободен', () => {
    const r = new PaintOfferRule();
    r.begin(1000);
    expect(r.due(1000 + 80_000, true)).toBe(false);
    expect(r.due(1000 + OFFER_PLAY_MS, false)).toBe(false);
    expect(r.due(1000 + OFFER_PLAY_MS, true)).toBe(true);
  });
  it('один раз за сессию; раскрасили сами — не предлагает', () => {
    const r = new PaintOfferRule();
    r.begin(0);
    expect(r.due(OFFER_PLAY_MS, true)).toBe(true);
    r.mark();
    expect(r.due(OFFER_PLAY_MS * 3, true)).toBe(false);
    const s = new PaintOfferRule();
    s.begin(0);
    s.done();
    expect(s.due(OFFER_PLAY_MS * 2, true)).toBe(false);
  });
  it('до выхода кота на карту — не предлагает', () => {
    expect(new PaintOfferRule().due(10 * OFFER_PLAY_MS, true)).toBe(false);
  });
});

describe('где можно рисовать: только кот на захваченной карте', () => {
  const ok = { home: false, tracking: true, locked: true, catOnCard: true };
  it.each([
    [{}, null],
    [{ home: true }, 'need_card'],
    [{ tracking: false }, 'need_card'],
    [{ locked: false }, 'need_card'],
    [{ catOnCard: false }, 'need_card'],
  ])('%j → %s', (patch, want) => expect(paintBlocked({ ...ok, ...patch })).toBe(want));
});

describe('мазок закрывает карту целиком (номер и имя не видны на скриншоте)', () => {
  it('три ряда змейкой с перекрытием, неровный край кисти тоже не открывает карту', () => {
    expect(strokeCoverage(CARD_ASPECT, 60, 0)).toBe(1);
    expect(strokeCoverage(CARD_ASPECT, 60, 0.12)).toBe(1);
    const { rows } = paintRows(CARD_ASPECT);
    expect(rows.map((r) => r.dir)).toEqual([1, -1, 1]);
  });
  it('кончик кисти дотягивается до края карты, когда кот у края', () => {
    expect(headFromCat(0.36)).toBeGreaterThan(0.5);
    expect(headFromCat(-0.36)).toBeLessThan(-0.5);
    expect(headFromCat(0)).toBe(0);
  });
});

describe('палитры и рисунки котов', () => {
  it('у каждого кота 3 цвета и свой рисунок, инструмент и клип', () => {
    expect(PAINT_STYLE.hooligan).toMatchObject({ pattern: 'graffiti', tool: 'spray', clip: 'paint_spray' });
    expect(PAINT_STYLE.kind).toMatchObject({ pattern: 'hearts', tool: 'brush', clip: 'paint_brush' });
    expect(PAINT_STYLE.glitter).toMatchObject({ pattern: 'stars', tool: 'brush', clip: 'paint_brush' });
    expect(PAINT_STYLE.hooligan.swatches.map((s) => s.id)).toEqual(['lime', 'pink', 'purple']);
    expect(PAINT_STYLE.kind.swatches.map((s) => s.id)).toEqual(['mint', 'peach', 'sky']);
    expect(PAINT_STYLE.glitter.swatches.map((s) => s.id)).toEqual(['lilac', 'gold', 'turquoise']);
    for (const pid of PERSONA_IDS) for (const s of PAINT_STYLE[pid].swatches) expect(sanitize('paint_start', { color: s.id })?.props.color).toBe(s.id);
  });
  it('зерно — тот же рисунок', () => {
    const a = rng(42), b = rng(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

describe('память о рисунке: {pattern, color, seed}', () => {
  it('туда и обратно; ключ уходит на сервер прогресса', () => {
    const st = new MemStore();
    expect(loadPaint(st)).toBeNull();
    savePaint({ pattern: 'hearts', color: 'peach', seed: 123456789 }, st);
    expect(loadPaint(st)).toEqual({ pattern: 'hearts', color: 'peach', seed: 123456789 });
    expect(isProgressKey(PAINT_KEY)).toBe(true);
    // новый рисунок заменяет старый
    savePaint({ pattern: 'graffiti', color: 'lime', seed: 7 }, st);
    expect(loadPaint(st)).toEqual({ pattern: 'graffiti', color: 'lime', seed: 7 });
    erasePaint(st);
    expect(loadPaint(st)).toBeNull();
  });
  it('мусор в памяти — без рисунка', () => {
    const st = new MemStore();
    for (const v of ['{', '{"pattern":"logo","color":"lime","seed":1}', '{"pattern":"hearts","color":"lime","seed":1}', '{"pattern":"stars","color":"gold"}']) {
      st.setItem(PAINT_KEY, v);
      expect(loadPaint(st), v).toBeNull();
    }
    expect(findSwatch('stars', 'gold')?.others.map((o) => o.id)).toEqual(['lilac', 'turquoise']);
  });
  it('в памяти нет ничего о карте: только узор, цвет и зерно', () => {
    const st = new MemStore();
    savePaint({ pattern: 'stars', color: 'lilac', seed: 1 }, st);
    expect(Object.keys(JSON.parse(st.getItem(PAINT_KEY)!))).toEqual(['pattern', 'color', 'seed']);
  });
});

describe('пункт каталога «Раскрасить карту» — вкладка «Образ», в пилоте тоже', () => {
  const content = loadTestContent();
  const env = catalogEnv(content.intents, editionDialogs(dialogsFile, false).triggers);
  it.each(PERSONA_IDS)('%s', (pid) => {
    const secs: CatalogSection[] = [...buildCatalog(content.personas.get(pid)!, env, { signature: true, pilot: true }), { id: 'magic', title: 'Чудеса', icon: 'sparkle', items: paintCatalogItems(true) }];
    const kept = limitCatalog(pid, secs).flatMap((s) => s.items.map((i) => i.id));
    expect(kept).toContain('ui:paint');
    expect(kept).toContain('ui:paint_erase');
    expect(pilotItemAllowed(pid, 'ui:paint')).toBe(true);
    const look = groupCatalog(limitCatalog(pid, secs)).find((g) => g.id === 'look');
    expect(look?.items.map((i) => i.id)).toEqual(expect.arrayContaining(['ui:paint', 'ui:paint_erase']));
    expect(look?.items.find((i) => i.id === 'ui:paint')?.label).toBe('Раскрасить карту');
  });
  it('«Стереть» — только когда есть рисунок', () => {
    expect(paintCatalogItems(false).map((i) => i.id)).toEqual(['ui:paint']);
  });
});

describe('редакции и аналитика', () => {
  it('card.paint: пилот и lab — да, MVP — нет; ?flow=paint в MVP вырезан даже со страницы /test', () => {
    expect(featureIn('pilot', 'card.paint')).toBe(true);
    expect(featureIn('lab', 'card.paint')).toBe(true);
    expect(featureIn('mvp', 'card.paint')).toBe(false);
    expect(filterSearch('?flow=paint&from=test', 'mvp').search).toBe('from=test');
    expect(filterSearch('?flow=paint&swatch=1&from=test', 'pilot').search).toBe('flow=paint&swatch=1&from=test');
    expect(filterSearch('?flow=paint&swatch=1', 'lab').search).toBe('flow=paint&swatch=1');
  });
  it('события без персональных данных', () => {
    for (const e of ['paint_offer', 'paint_start', 'paint_done', 'paint_erase']) expect(EVENTS as readonly string[]).toContain(e);
    expect(sanitize('paint_start', { color: 'lime', name: 'Маша', card: '4276' })?.props).toEqual({ color: 'lime' });
    expect(sanitize('paint_done', { seed: 5 })?.props).toEqual({});
  });
});

// ───────────── контроллер без трёхмерной сцены ─────────────

function host(o: { tracking?: boolean; locked?: boolean; home?: boolean; storage?: MemStore } = {}) {
  const state = { tracking: o.tracking ?? true, locked: o.locked ?? true, home: o.home ?? false };
  const lost: (() => void)[] = [];
  const handlers: Record<string, ((v: unknown) => void)[]> = {};
  const director = {
    intentGate: null as null | ((h: { type: string; text?: string }, st: unknown) => boolean),
    state: { appeared: true, phase: 'play', dialog: null, paused: false },
    persona: { id: 'kind', name: 'Добряк' },
    dozing: false,
    queue: { busy: false },
    ladder: { reset: vi.fn(), quietFor: () => 60_000 },
    showLine: vi.fn(() => true),
    activity: vi.fn(),
    on: (t: string, fn: (v: unknown) => void) => ((handlers[t] ??= []).push(fn), () => undefined),
  };
  const stage = {
    root: { visible: true }, atGlass: false, walking: false, pos: new THREE.Vector2(), cfg: { footX: 0, footY: -0.1 },
    walkTo: vi.fn(() => false), cancelWalk: vi.fn(), anchorScreen: () => ({ x: 0, y: 0, s: 100 }),
  };
  const tracker = {
    anchor: new THREE.Group(), aspect: CARD_ASPECT, onLost: (cb: () => void) => (lost.push(cb), () => undefined),
    get isTracking() {
      return state.tracking;
    },
    get isLocked() {
      return state.locked;
    },
  };
  const character = { holdProp: vi.fn(), play: vi.fn() };
  const h = {
    root: document.body, tracker, stage, director, ui: { closeCatalog: vi.fn(), say: vi.fn(), isCatalogOpen: false }, audio: { play: vi.fn() },
    character: () => character, home: () => ({ active: state.home, inRoom: state.home }), awakeActive: () => false, kickSuggest: vi.fn(), log: () => undefined,
    storage: o.storage ?? new MemStore(),
  } as unknown as CardPaintHost;
  return { h, state, director, stage, character, lost, emit: (t: string, v: unknown) => handlers[t]?.forEach((f) => f(v)) };
}

describe('CardPaint: вход только на карте, полный проход, память', () => {
  it('карта не захвачена или кот дома — «Сначала покажи мне карту», лист не открывается', () => {
    for (const s of [{ locked: false }, { tracking: false }, { home: true }]) {
      const t = host(s);
      const p = new CardPaint(t.h);
      expect(p.request('catalog')).toBe(false);
      expect(p.sheetOpen).toBe(false);
      expect(t.director.showLine).toHaveBeenCalledWith('paint_need_card');
      expect(p.start(0)).toBe(false);
      expect(p.painting).toBe(false);
    }
  });
  it('голос «раскрась карту» — съеден раскраской и открывает лист цветов', () => {
    const t = host();
    const p = new CardPaint(t.h);
    expect(t.director.intentGate!({ type: 'paint_card', text: 'раскрась карту' }, {})).toBe(true);
    expect(p.sheetOpen).toBe(true);
    expect(t.director.showLine).toHaveBeenCalledWith('paint_choose');
    expect(document.querySelectorAll('.paint-sheet .ps-sw')).toHaveLength(3);
    // «не надо» голосом — лист закрыт
    expect(t.director.intentGate!({ type: 'no', text: 'не надо' }, {})).toBe(true);
    expect(p.sheetOpen).toBe(false);
    // чужие интенты — дальше по цепочке
    expect(t.director.intentGate!({ type: 'dance', text: 'танцуй' }, {})).toBe(false);
  });
  it('раскраска до конца: кисть в лапе, «Та-да!», рисунок в памяти и снова на следующем визите', () => {
    const store = new MemStore();
    const t = host({ storage: store });
    const p = new CardPaint(t.h);
    expect(p.start(2, 99)).toBe(true);
    expect(t.character.holdProp).toHaveBeenCalledWith('paint_brush', PAINT_STYLE.kind.swatches[2].main);
    let s = 0;
    while (p.painting && s < 30) {
      p.update(0.05);
      s += 0.05;
    }
    expect(p.painting).toBe(false);
    // кот стоит на месте (walkTo — false): мазок идёт по времени, 5–8 с
    expect(s).toBeGreaterThan(5);
    expect(s).toBeLessThan(8.5);
    expect(p.progress).toBe(1);
    expect(t.character.holdProp).toHaveBeenLastCalledWith(null);
    expect(t.character.play).toHaveBeenCalledWith('celebrate');
    expect(t.director.showLine).toHaveBeenCalledWith('paint_done');
    expect(loadPaint(store)).toEqual({ pattern: 'hearts', color: 'sky', seed: 99 });
    const again = new CardPaint(host({ storage: store }).h);
    expect(again.saved).toEqual({ pattern: 'hearts', color: 'sky', seed: 99 });
    expect(again.catalogItems().map((i) => i.id)).toContain('ui:paint_erase');
    expect(again.erase()).toBe(true);
    expect(loadPaint(store)).toBeNull();
  });
  it('карта ушла посреди раскраски — дорисовано сразу, кот отпускает кисть', () => {
    const store = new MemStore();
    const t = host({ storage: store });
    const p = new CardPaint(t.h);
    p.start(0, 5);
    p.update(0.5);
    t.state.tracking = false;
    t.lost.forEach((f) => f());
    expect(p.painting).toBe(false);
    expect(t.stage.cancelWalk).toHaveBeenCalled();
    expect(t.character.holdProp).toHaveBeenLastCalledWith(null);
    expect(loadPaint(store)?.color).toBe('mint');
  });
  it('кот сам предлагает после 90 с игры: чипы «Раскрась! / Не сейчас», «да» открывает лист', () => {
    const t = host();
    const p = new CardPaint(t.h);
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValue(1000);
    t.emit('phase', 'play');
    now.mockReturnValue(1000 + 30_000);
    p.update(0.6);
    expect(p.chips([])).toEqual([]);
    now.mockReturnValue(1000 + OFFER_PLAY_MS + 10);
    p.update(0.6);
    expect(t.director.showLine).toHaveBeenCalledWith('paint_offer');
    expect(p.chips([]).map((c) => c.id)).toEqual(['paint:yes', 'paint:no']);
    expect(t.director.intentGate!({ type: 'unknown', text: 'да' }, {})).toBe(true);
    expect(p.sheetOpen).toBe(true);
    p.closeSheet();
    now.mockRestore();
  });
});

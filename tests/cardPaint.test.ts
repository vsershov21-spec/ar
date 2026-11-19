// @vitest-environment jsdom
/**
 * Раскраска карты (src/card/paint.ts, paintPlan.ts; feature card.paint): когда кот предлагает, только на захваченной
 * карте, память о рисунке (туда и обратно, сервер прогресса), пункт каталога в пилоте, мазок закрывает карту целиком
 * (номер и имя не видны), полный проход раскраски без трёхмерной сцены.
 */
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import {
  OFFER_FIRST_MS, OFFER_PLAY_MS, PAINT_KEY, PAINT_STYLE, PaintOfferRule, erasePaint, findSwatch, loadPaint, paintBlocked, paintCatalogItems,
  savePaint, rng, choreograph, baseCoverage, nozzleHit, sprayRadius, canvasToCard, cardToUv, pointAt, paintSpots, ART_SPAN, type Step,
} from '../src/card/paintPlan';
import { ART_LAYERS, artStrokes } from '../src/card/paintArt';
import { PropRig } from '../src/character/props';
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

const W = 1024, H = 646;
const planFor = (id: 'hooligan' | 'kind' | 'glitter', seed = 20261118) => {
  const st = PAINT_STYLE[id];
  return choreograph(artStrokes(W, H, st.pattern, st.swatches[0], st.swatches.slice(1), seed), W, H, CARD_ASPECT, st.tool);
};
const firstIdx = (steps: Step[], f: (s: Step) => boolean) => steps.findIndex(f);
const phaseIdx = (steps: Step[], ph: string) => firstIdx(steps, (s) => s.k === 'stroke' && s.s.phase === ph);

describe('мазок закрывает карту целиком (номер и имя не видны на скриншоте)', () => {
  it('фон широкими рядами закрывает всю карту, неровный край штампа тоже не открывает её — у всех котов и зёрен', () => {
    for (const id of PERSONA_IDS)
      for (const seed of [1, 99, 20261118]) {
        const c = planFor(id, seed);
        expect(baseCoverage(c, CARD_ASPECT, 60, 0), `${id}/${seed}`).toBe(1);
        expect(baseCoverage(c, CARD_ASPECT, 60, 0.12), `${id}/${seed}`).toBe(1);
      }
  });
  it('у каждого слоя рисунка есть мазок, который его открывает; фон — первый слой', () => {
    for (const id of PERSONA_IDS) {
      const st = PAINT_STYLE[id];
      const c = planFor(id);
      const opened = new Set([...c.steps.flatMap((s) => (s.k === 'stroke' ? [s.s.layer] : [])), ...c.drips.map((d) => d.s.layer)]);
      expect([...opened].sort(), id).toEqual([...ART_LAYERS[st.pattern]].sort());
      expect(ART_LAYERS[st.pattern][0]).toBe('bg');
    }
  });
  it('холст ↔ карта: углы холста — за краем карты (рисунок шире на 2 %)', () => {
    const tl = canvasToCard(0, 0, W, H, CARD_ASPECT), br = canvasToCard(W, H, W, H, CARD_ASPECT);
    expect(tl.x).toBeCloseTo(-ART_SPAN / 2, 6);
    expect(tl.y).toBeCloseTo(ART_SPAN / CARD_ASPECT / 2, 6);
    expect(br.x).toBeGreaterThan(0.5);
    expect(br.y).toBeLessThan(-0.5 / CARD_ASPECT);
    const uv = cardToUv(canvasToCard(300, 200, W, H, CARD_ASPECT), CARD_ASPECT);
    expect(uv.u * W).toBeCloseTo(300, 6);
    expect(uv.v * H).toBeCloseTo(200, 6);
  });
});

describe('хореография: как настоящее граффити / рисунок кистью', () => {
  it('Хулиган: трясёт баллончик → тег и обводка → фон → заливка → кляксы; отошёл, посмотрел → звёзды и стрелки последними', () => {
    const { steps, drips } = planFor('hooligan');
    const shake = firstIdx(steps, (s) => s.k === 'shake');
    const outline = phaseIdx(steps, 'outline'), base = phaseIdx(steps, 'base'), fill = phaseIdx(steps, 'fill'), splat = phaseIdx(steps, 'splat');
    const admire = firstIdx(steps, (s) => s.k === 'admire'), star = phaseIdx(steps, 'star'), flourish = phaseIdx(steps, 'flourish');
    expect(shake).toBeGreaterThanOrEqual(0);
    expect(shake).toBeLessThan(outline);
    expect(outline).toBeLessThan(base);
    expect(base).toBeLessThan(fill);
    expect(fill).toBeLessThan(splat);
    expect(admire).toBeGreaterThan(splat);
    expect(star).toBeGreaterThan(admire);
    expect(flourish).toBeGreaterThan(star);
    expect(steps[steps.length - 1].k).toBe('show');
    // перед второй половиной — снова трясёт
    expect(steps.filter((s) => s.k === 'shake')).toHaveLength(2);
    // потёки стекают сами — после заливки / фона своей половины, с задержкой
    expect(drips.length).toBeGreaterThan(5);
    for (const d of drips) {
      expect(d.delay).toBeGreaterThan(0.2);
      const at = steps[d.after];
      expect(at.k === 'stroke' && ['base', 'fill', 'splat', 'outline'].includes(at.s.phase)).toBe(true);
      expect(d.s.pts[1].y).toBeLessThan(d.s.pts[0].y); // вниз по картинке
    }
  });
  it('Добряк и Блёстка: макают кисть → волнистый фон → штампы → точки; большое сердце / звезда — после «посмотрел»', () => {
    for (const id of ['kind', 'glitter'] as const) {
      const { steps } = planFor(id);
      const dip = firstIdx(steps, (s) => s.k === 'dip'), base = phaseIdx(steps, 'base'), item = phaseIdx(steps, 'item'), dab = phaseIdx(steps, 'dab');
      const admire = firstIdx(steps, (s) => s.k === 'admire'), flourish = phaseIdx(steps, 'flourish');
      expect(dip).toBeGreaterThanOrEqual(0);
      expect(dip).toBeLessThan(base);
      expect(base).toBeLessThan(item);
      expect(item).toBeLessThan(dab);
      expect(flourish).toBeGreaterThan(admire);
      // волна: у мазка фона кисти y меняется вдоль ряда
      const b = steps[base];
      if (b.k !== 'stroke') throw new Error('base');
      const ys = new Set(b.s.pts.slice(0, 8).map((p) => p.y.toFixed(3)));
      expect(ys.size).toBeGreaterThan(3);
    }
  });
  it('кот не идёт через карту: 2–3 точки у краёв (на столе рядом с картой), шаг назад — спиной', () => {
    for (const id of PERSONA_IDS) {
      const { steps } = planFor(id);
      const walks = steps.filter((s): s is Extract<Step, { k: 'walk' }> => s.k === 'walk');
      const spots = new Set(walks.filter((w) => !w.back).map((w) => `${w.to.x.toFixed(2)},${w.to.y.toFixed(2)}`));
      expect(spots.size).toBeGreaterThanOrEqual(2);
      expect(spots.size).toBeLessThanOrEqual(5);
      expect(walks.some((w) => w.to.y > 0.5 / CARD_ASPECT && Math.abs(w.to.x) < 0.1)).toBe(true);
      for (const w of walks) expect(Math.abs(w.to.x) > 0.5 || Math.abs(w.to.y) > 0.5 / CARD_ASPECT).toBe(true); // на столе у края
      // путь между точками не идёт через карту: соседние точки — по одну сторону карты или через дальний край
      let prev = { x: 0, y: -0.1 };
      for (const w of walks.slice(1)) {
        const from = prev, to = w.to;
        prev = to;
        if (Math.abs(from.x) > 0.5 && Math.abs(to.x) > 0.5) expect(Math.sign(from.x)).toBe(Math.sign(to.x));
      }
      expect(walks.some((w) => w.back)).toBe(true);
    }
    expect(paintSpots(CARD_ASPECT).L.x).toBeLessThan(0);
  });
  it('время мазков: у всех мазков длительность > 0, пути — по скорости инструмента; вся раскраска 10–18 с', () => {
    for (const id of PERSONA_IDS) {
      const c = planFor(id);
      for (const s of c.steps) if (s.k === 'stroke') {
        expect(s.s.dur).toBeGreaterThan(0.05);
        expect(s.gap).toBeGreaterThanOrEqual(0.05);
        expect(s.gap).toBeLessThanOrEqual(0.26);
      }
      for (const d of c.drips) expect(d.s.dur).toBeGreaterThanOrEqual(0.5);
      expect(c.total, id).toBeGreaterThan(10);
      expect(c.total, id).toBeLessThan(18);
    }
  });
  it('точка на пути по доле длины', () => {
    const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }];
    expect(pointAt(pts, 0)).toEqual({ x: 0, y: 0 });
    expect(pointAt(pts, 0.25)).toEqual({ x: 0.5, y: 0 });
    expect(pointAt(pts, 0.75)).toEqual({ x: 1, y: 0.5 });
    expect(pointAt(pts, 1)).toEqual({ x: 1, y: 1 });
  });
});

describe('сопло → карта: краска там, куда смотрит сопло', () => {
  it('луч сопла пересекает плоскость карты; вверх / вдоль карты — мимо', () => {
    const h = nozzleHit({ x: 0.1, y: 0.4, z: 0.3 }, { x: 0, y: -1, z: -1 })!;
    expect(h.x).toBeCloseTo(0.1, 6);
    expect(h.y).toBeCloseTo(0.1, 6);
    expect(h.dist).toBeCloseTo(Math.hypot(0.3, 0.3), 6);
    expect(nozzleHit({ x: 0, y: 0, z: 0.3 }, { x: 0, y: 1, z: 0.2 })).toBeNull();
    expect(nozzleHit({ x: 0, y: 0, z: 0.3 }, { x: 1, y: 0, z: 0 })).toBeNull();
    // дальше — шире пятно, но не меньше радиуса мазка и не больше 1,6 радиуса
    expect(sprayRadius(0.05, 0.1)).toBeGreaterThanOrEqual(0.05);
    expect(sprayRadius(0.05, 0.6)).toBeGreaterThan(sprayRadius(0.05, 0.2));
    expect(sprayRadius(0.05, 5)).toBeCloseTo(0.08, 6);
  });
  it('PropRig.aim: баллончик и кисть повёрнуты так, что луч сопла (кончика) проходит через точку прицела', async () => {
    for (const id of ['paint_spray', 'paint_brush']) {
      const root = new THREE.Group();
      root.scale.setScalar(1.1);
      root.position.set(0.2, 0.4, 0);
      const hand = new THREE.Object3D();
      hand.position.set(-0.2, 0.55, 0.25);
      root.add(hand);
      const rig = new PropRig(async () => new THREE.Object3D(), () => hand, root);
      root.updateMatrixWorld(true);
      rig.hold(id, '#ff00ff');
      await new Promise((r) => setTimeout(r, 0));
      for (const target of [new THREE.Vector3(0.1, 0, 0.6), new THREE.Vector3(-0.3, 0, 0.9), new THREE.Vector3(0.4, 0, 0.3)]) {
        rig.aim(target.clone().applyMatrix4(root.matrixWorld), 1);
        rig.update('idle');
        const t = rig.tip()!;
        expect(t, id).not.toBeNull();
        // ближайшая точка луча к цели
        const w = target.clone().applyMatrix4(root.matrixWorld);
        const k = w.clone().sub(t.o).dot(t.d);
        expect(k, id).toBeGreaterThan(0);
        expect(t.o.clone().addScaledVector(t.d, k).distanceTo(w), id).toBeLessThan(0.005);
      }
      rig.aim(null);
      rig.update('idle');
    }
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
    while (p.painting && s < 40) {
      p.update(0.05);
      s += 0.05;
    }
    expect(p.painting).toBe(false);
    // кот стоит на месте (walkTo — false): мазки идут по времени, 10–18 с
    expect(s).toBeGreaterThan(9);
    expect(s).toBeLessThan(18);
    expect(p.progress).toBe(1);
    expect(t.character.holdProp).toHaveBeenLastCalledWith(null);
    expect(t.character.play).toHaveBeenCalledWith('celebrate', { force: true });
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

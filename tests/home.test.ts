// @vitest-environment jsdom
/**
 * «Мир кота» без камеры (src/home): переход AR → дом → AR без утечек (камера освобождается и снова открывается
 * в жесте «На карту» одним запросом), свайпы между зонами, действия зон, предложения «пойдём домой», память.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { HomeMode, prepareHomeFlow, type HomeHost } from '../src/home/homeMode';
import { HomeOfferRule, LOST_OFFER_MS, QUIET_OFFER_MS, QUIET_OFFER_GAP_MS, ZONES, offerChips, zoneAfterSwipe } from '../src/home/zones';
import { buildRoom, CAT_Z, type Room } from '../src/home/room';
import { loadMemory, saveMemory } from '../src/scenario/memory';
import type { Chip } from '../src/scenario/suggest';

function fakeRoom() {
  const group = new THREE.Group();
  const anchor = new THREE.Group();
  group.add(anchor);
  const r = {
    group, anchor, light: 1,
    setLight: vi.fn((k: number) => void (r.light = k)),
    showBowl: vi.fn(), bounceBall: vi.fn(), placeAnchor: vi.fn(), update: vi.fn(), dispose: vi.fn(),
  };
  return r;
}

function makeHost() {
  const gum = { calls: 0, active: 1 }; // камера открыта (кот на карте)
  const scene = new THREE.Scene();
  const cardAnchor = new THREE.Group();
  scene.add(cardAnchor);
  const listeners = new Set<() => void>();
  const tracker = {
    anchor: cardAnchor, isTracking: true, withAudio: true,
    // как CardTracker: getUserMedia — синхронно в начале start() (до первого await), stop() гасит дорожки
    start: vi.fn(() => {
      gum.calls++;
      gum.active++;
      return Promise.resolve();
    }),
    stop: vi.fn(() => {
      gum.active = Math.max(0, gum.active - 1);
    }),
    reanchor: vi.fn(),
  };
  const director = {
    state: { phase: 'play', appeared: true, cardVisible: true, dialog: null as unknown, paused: false },
    dozing: false,
    ladder: { quiet: 0, quietFor() { return this.quiet; }, reset: vi.fn() },
    queue: { busy: false },
    dispatch: vi.fn((e: { type: string }) => {
      if (e.type === 'card_found') director.state.cardVisible = true;
      if (e.type === 'card_lost') director.state.cardVisible = false;
    }),
    speakEvent: vi.fn(() => true),
    voiced: true,
    hasVoiced: vi.fn(() => director.voiced),
    action: vi.fn(),
    interaction: vi.fn((k: string) => {
      if (k === 'sleep') director.dozing = true;
      if (k === 'wake_up') director.dozing = false;
    }),
    activity: vi.fn(),
    log: vi.fn(),
  };
  const character = { play: vi.fn(), currentClip: 'idle', face: vi.fn() };
  const stage = {
    root: new THREE.Group(),
    cfg: { yawFollow: true, height: 1.1 },
    useView: vi.fn(),
    setMode: vi.fn(),
    resetPosition: vi.fn(),
    show: vi.fn(),
    walking: false,
    anchorScreen: () => ({ x: 195, y: 500 }),
  };
  const uiRoot = document.createElement('div');
  const root = document.createElement('div');
  root.appendChild(uiRoot);
  document.body.appendChild(root);
  const ui = { root: uiRoot, toast: vi.fn(), closeCatalog: vi.fn(), nudge: vi.fn(), hidePressMenu: vi.fn(), error: vi.fn(), canReanchor: true };
  const rooms: ReturnType<typeof fakeRoom>[] = [];
  const host: HomeHost = {
    root, scene, renderer: { setClearColor: vi.fn() }, tracker, stage, director, character: () => character, ui,
    audio: { play: vi.fn() }, energy: { activity: vi.fn() }, suggest: vi.fn(),
    buildRoom: () => {
      const r = fakeRoom();
      rooms.push(r);
      return Promise.resolve(r as unknown as Room);
    },
  };
  void listeners;
  return { host, tracker, director, stage, character, ui, scene, rooms, gum, root };
}

const tick = async (home: HomeMode, ms: number, step = 50) => {
  for (let t = 0; t < ms; t += step) {
    await vi.advanceTimersByTimeAsync(step);
    home.update(step / 1000, performance.now());
  }
};

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('зоны и правила', () => {
  it('свайп влево — зона правее, вправо — левее; край и вертикаль — null', () => {
    expect(zoneAfterSwipe('living', 'left')).toBe('bedroom');
    expect(zoneAfterSwipe('living', 'right')).toBe('kitchen');
    expect(zoneAfterSwipe('bedroom', 'left')).toBeNull();
    expect(zoneAfterSwipe('kitchen', 'right')).toBeNull();
    expect(zoneAfterSwipe('living', 'up')).toBeNull();
    expect(ZONES.map((z) => z.id)).toEqual(['kitchen', 'living', 'bedroom']);
  });

  it('кот зовёт домой: карта потеряна > 6 с — один раз на потерю; тишина — не чаще раза в 3 мин; память «был дома»', () => {
    const r = new HomeOfferRule();
    const env = { now: 0, playing: true, home: false, cardVisible: false, lostSince: 1000, quietMs: 0, busy: false };
    expect(r.check({ ...env, now: 1000 + LOST_OFFER_MS - 1 })).toBeNull();
    expect(r.check({ ...env, now: 1000 + LOST_OFFER_MS })).toBe('lost');
    expect(r.check({ ...env, now: 1000 + LOST_OFFER_MS + 5000 })).toBeNull();
    expect(r.check({ ...env, lostSince: 20_000, now: 20_000 + LOST_OFFER_MS })).toBe('lost');
    const q = { ...env, cardVisible: true, lostSince: -1 };
    expect(r.check({ ...q, now: 50_000, quietMs: QUIET_OFFER_MS - 1 })).toBeNull();
    expect(r.check({ ...q, now: 50_000, quietMs: QUIET_OFFER_MS })).toBe('quiet');
    expect(r.check({ ...q, now: 60_000, quietMs: QUIET_OFFER_MS + 10_000 })).toBeNull();
    expect(r.check({ ...q, now: 50_000 + QUIET_OFFER_GAP_MS, quietMs: QUIET_OFFER_MS })).toBe('quiet');
    expect(r.check({ ...q, now: 1e6, quietMs: 1e6, busy: true })).toBeNull();
    expect(r.check({ ...q, now: 2e6, quietMs: 1e6, playing: false })).toBeNull();
    r.pendingMemory = true;
    expect(r.check({ ...q, now: 3e6, quietMs: 0 })).toBe('memory');
    expect(offerChips('lost').map((c) => c.id)).toEqual(['home:go', 'home:find']);
    expect(offerChips('quiet').map((c) => c.id)).toEqual(['home:go', 'home:later']);
  });
});

describe('переход AR → дом → AR', () => {
  it('камера освобождается при входе и открывается в жесте «На карту» (синхронно, одна видеодорожка); три круга без утечек', async () => {
    const { host, tracker, director, stage, scene, rooms, gum, root } = makeHost();
    const home = new HomeMode(host);
    const addL = vi.spyOn(window, 'addEventListener');
    const remL = vi.spyOn(window, 'removeEventListener');
    const sceneKids = scene.children.length;
    for (let round = 0; round < 3; round++) {
      expect(home.enter('test')).toBe(true);
      expect(home.phase).toBe('to_home');
      expect(home.enter('again')).toBe(false); // повторное нажатие во время портала
      await tick(home, 1200);
      expect(home.phase).toBe('home');
      expect(tracker.stop).toHaveBeenCalledTimes(round + 1);
      expect(gum.active).toBe(0); // камера закрыта
      expect(tracker.isTracking).toBe(true); // дома кот «на месте» для режиссёра и эффектов
      expect(tracker.anchor.visible).toBe(false);
      expect(stage.useView).toHaveBeenLastCalledWith({ anchor: rooms[0].anchor, camera: home.camera });
      expect(root.classList.contains('home-on')).toBe(true);
      expect(loadMemory().home).toEqual({ where: 'home', zone: home.zone });

      // «На карту»: getUserMedia — ещё внутри обработчика нажатия
      const before = gum.calls;
      expect(home.exit()).toBe(true);
      expect(gum.calls).toBe(before + 1);
      expect(tracker.withAudio).toBe(false); // микрофон уже открыт — только видео
      expect(tracker.reanchor).toHaveBeenCalledTimes(round + 1);
      expect(home.exit()).toBe(false); // двойное нажатие — второго запроса камеры нет
      expect(gum.calls).toBe(before + 1);
      tracker.isTracking = false; // карта ещё не найдена
      await tick(home, 1200);
      expect(home.phase).toBe('ar');
      expect(stage.useView).toHaveBeenLastCalledWith(null);
      expect(director.dispatch).toHaveBeenLastCalledWith({ type: 'card_lost' });
      expect(stage.setMode).toHaveBeenLastCalledWith('glass');
      expect(tracker.anchor.visible).toBe(true);
      expect(root.classList.contains('home-on')).toBe(false);
      expect(loadMemory().home?.where).toBe('ar');
      // карта нашлась (как CardTracker → режиссёр)
      tracker.isTracking = true;
      director.state.cardVisible = true;
    }
    expect(rooms.length).toBe(1); // комната строится один раз
    expect(scene.children.length).toBe(sceneKids); // комнаты в сцене нет
    expect(gum.calls).toBe(3);
    expect(gum.active).toBe(1); // одна камера: каждая открытая на «На карту» закрыта при следующем входе
    const added = addL.mock.calls.filter((c) => (c[0] as string) === 'deviceorientation').length;
    const removed = remL.mock.calls.filter((c) => (c[0] as string) === 'deviceorientation').length;
    expect(added).toBe(3);
    expect(removed).toBe(3);
    expect(root.querySelectorAll('.home-hud').length).toBe(1);
    expect(root.querySelectorAll('.home-portal').length).toBe(1);
    expect(home.stats).toEqual({ enter: 3, exit: 3, cameraStops: 3, cameraStarts: 3 });
    home.dispose();
    expect(root.querySelectorAll('.home-hud, .home-portal').length).toBe(0);
  });

  it('вход при потерянной карте: режиссёр получает card_found молча («вот она!» не звучит), кот на полу', async () => {
    const { host, director, stage, tracker } = makeHost();
    director.state.cardVisible = false;
    (director as unknown as { cardLostSaid: boolean }).cardLostSaid = true;
    tracker.isTracking = false;
    const home = new HomeMode(host);
    home.enter('lost');
    await tick(home, 1200);
    expect(director.dispatch).toHaveBeenCalledWith({ type: 'card_found' });
    expect((director as unknown as { cardLostSaid: boolean }).cardLostSaid).toBe(false);
    expect(stage.setMode).toHaveBeenCalledWith('card');
    expect(director.speakEvent).toHaveBeenCalledWith('home_enter', { background: true });
  });

  it('до конца знакомства домой нельзя', () => {
    const { host, director } = makeHost();
    director.state.phase = 'ask_name';
    const home = new HomeMode(host);
    expect(home.enter()).toBe(false);
    expect(home.catalogItem()).toBeNull();
    director.state.phase = 'play';
    expect(home.catalogItem()?.id).toBe('home:go');
  });

  it('реплики без озвучки не звучат: только подпись зоны', async () => {
    const { host, director } = makeHost();
    director.voiced = false;
    const home = new HomeMode(host);
    home.enter();
    await tick(home, 1200);
    expect(director.speakEvent).not.toHaveBeenCalled();
    expect(host.ui.root.querySelector('.hz-l')?.textContent).toBe('Гостиная');
  });
});

describe('дома: свайпы, действия, чипы', () => {
  async function atHome() {
    const env = makeHost();
    const home = new HomeMode(env.host);
    home.enter();
    await tick(home, 1200);
    return { ...env, home };
  }

  it('свайп влево/вправо — соседняя комната: кот бежит, подпись и память меняются; край — упор; вертикальный — мимо', async () => {
    const { home, character, stage, host } = await atHome();
    expect(home.zone).toBe('living');
    expect(home.onSwipe('up')).toBe(false);
    expect(home.onSwipe('left')).toBe(true);
    expect(home.zone).toBe('bedroom');
    expect(home.moving).toBe(true);
    expect(character.play).toHaveBeenLastCalledWith('run', { loop: true });
    expect(stage.cfg.yawFollow).toBe(false);
    expect(home.onSwipe('right')).toBe(true); // во время бега — не сбивается
    expect(home.zone).toBe('bedroom');
    await tick(home, 1100);
    expect(home.moving).toBe(false);
    expect(stage.cfg.yawFollow).toBe(true);
    expect(host.ui.root.querySelector('.hz-l')?.textContent).toBe('Спальня');
    expect(loadMemory().home).toEqual({ where: 'home', zone: 'bedroom' });
    expect(home.onSwipe('left')).toBe(true); // край комнаты
    expect(home.zone).toBe('bedroom');
    // стрелка у края
    (host.ui.root.querySelector('[data-h="prev"]') as HTMLElement).click();
    expect(home.zone).toBe('living');
    await tick(home, 1100);
    home.onSwipe('right');
    await tick(home, 1100);
    expect(home.zone).toBe('kitchen');
  });

  it('кухня: «Угостить» — миска и угощение; «Какао» — клип с кружкой; спальня: «Уложить спать» — сон и приглушённый свет', async () => {
    const { home, rooms, director, character } = await atHome();
    home.go('kitchen');
    await tick(home, 1100);
    const chips = home.chips([]);
    expect(chips.map((c) => c.id)).toEqual(['home:treat', 'home:cocoa']);
    home.act('home:treat');
    expect(rooms[0].showBowl).toHaveBeenLastCalledWith(true);
    expect(director.action).toHaveBeenLastCalledWith('treat');
    await vi.advanceTimersByTimeAsync(7100);
    expect(rooms[0].showBowl).toHaveBeenLastCalledWith(false);
    home.act('home:cocoa');
    expect(character.play).toHaveBeenLastCalledWith('idle_kind_cocoa');
    home.go('living');
    await tick(home, 1100);
    home.go('bedroom');
    await tick(home, 1100);
    expect(home.chips([]).map((c) => c.id)).toEqual(['home:sleep']);
    home.act('home:sleep');
    expect(director.interaction).toHaveBeenLastCalledWith('sleep');
    await tick(home, 200);
    expect(rooms[0].setLight).toHaveBeenLastCalledWith(0.15);
    // спит — чипы кота («Разбуди меня»), не действия зоны
    const wake: Chip = { id: 'pet', label: 'Разбуди меня', icon: 'hand', run: { action: 'pet' } };
    expect(home.chips([wake])).toEqual([wake]);
    // перебежка будит
    home.go('living');
    expect(director.interaction).toHaveBeenLastCalledWith('wake_up');
    await tick(home, 1100);
    expect(rooms[0].setLight).toHaveBeenLastCalledWith(1);
  });

  it('гостиная: «Потанцуем» — танец, «Мячик» — мячик прыгает; вопрос кота / мини-игра — чипы ответа как обычно', async () => {
    const { home, director, rooms } = await atHome();
    expect(home.chips([]).map((c) => c.id)).toEqual(['home:dance', 'home:ball']);
    home.act('home:dance');
    expect(director.action).toHaveBeenLastCalledWith('dance');
    home.act('home:ball');
    expect(rooms[0].bounceBall).toHaveBeenCalled();
    const answer: Chip = { id: 'yes', label: 'Да', icon: 'yes', run: { say: 'да' } };
    expect(home.chips([answer])).toEqual([answer]);
    director.state.dialog = { id: 'riddle' };
    const extra: Chip = { id: 'riddle', label: 'Загадка', icon: 'quest', run: { action: 'riddle' } };
    expect(home.chips([extra])).toEqual([extra]);
  });

  it('на карте: карта потеряна 6 с — «Пойдём!» / «Найду карту»; «Найду карту» убирает предложение', async () => {
    const { host, tracker, director } = makeHost();
    const home = new HomeMode(host);
    tracker.isTracking = false;
    home.update(0.05, 1000);
    home.update(0.05, 1000 + LOST_OFFER_MS + 10);
    expect(home.chips([]).map((c) => c.id)).toEqual(['home:go', 'home:find']);
    expect(director.speakEvent).toHaveBeenCalledWith('home_offer', { background: false });
    home.act('home:find');
    expect(home.chips([]).map((c) => c.id)).toEqual([]);
    // снова — только после новой потери
    home.update(0.05, 1000 + LOST_OFFER_MS * 3);
    expect(home.offer).toBeNull();
  });
});

describe('память и флоу', () => {
  it('кот был дома в прошлый раз — зона восстанавливается, кот позовёт домой в первую паузу', () => {
    saveMemory({ home: { where: 'home', zone: 'kitchen' } });
    const { host } = makeHost();
    const home = new HomeMode(host);
    expect(home.zone).toBe('kitchen');
    expect(home.offers.pendingMemory).toBe(true);
    home.update(0.05, 100);
    expect(home.chips([]).map((c) => c.id)).toEqual(['home:go', 'home:later']);
  });

  it('битая память не ломает загрузку', () => {
    localStorage.setItem('sber-ar-cat:v1', JSON.stringify({ visits: 2, home: { where: 'moon', zone: 5 } }));
    expect(loadMemory().home).toBeUndefined();
  });

  it('?flow=home — без знакомства (память «знакомы» до режиссёра)', () => {
    prepareHomeFlow('?flow=home');
    expect(loadMemory().met).toBe(true);
    localStorage.clear();
    prepareHomeFlow('?flow=riddle');
    expect(loadMemory().met).toBeUndefined();
  });
});

describe('комната (three.js)', () => {
  it('строится, пол — плоскость карты: +Z карты смотрит вверх, кот стоит на CAT_Z; dispose без ошибок', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const room = buildRoom();
    let meshes = 0, verts = 0;
    room.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        meshes++;
        verts += m.geometry.getAttribute('position').count;
      }
    });
    // запечённое освещение: несколько сеток на всю комнату, не сотни
    expect(meshes).toBeLessThan(40);
    expect(verts).toBeLessThan(120_000);
    room.placeAnchor(ZONES[2].x, ZONES[2].floorY);
    room.group.updateMatrixWorld(true);
    const foot = new THREE.Vector3(0, -0.1, 0).applyMatrix4(room.anchor.matrixWorld);
    expect(foot.x).toBeCloseTo(ZONES[2].x, 5);
    expect(foot.y).toBeCloseTo(ZONES[2].floorY, 5);
    expect(foot.z).toBeCloseTo(CAT_Z, 5);
    const up = new THREE.Vector3(0, 0, 1).transformDirection(room.anchor.matrixWorld);
    expect(up.y).toBeCloseTo(1, 5);
    room.setLight(0);
    for (let i = 0; i < 40; i++) room.update(0.1);
    expect(room.light).toBe(0);
    expect(() => room.dispose()).not.toThrow();
    err.mockRestore();
  });
});

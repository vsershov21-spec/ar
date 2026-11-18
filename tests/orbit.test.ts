import { describe, it, expect } from 'vitest';
import { DragGate, OrbitPointers, OrbitView, ORBIT, isDesktopView, noCardCameraOff, orbitKey, type OrbitPointer } from '../src/input/orbit';
import { TouchInterpreter, type TouchEvent } from '../src/input/interpreter';
import { filterSearch } from '../src/config/edition';

const pose = () => ({ spin: 0, tilt: 1.05, distance: 2.6 });
const mouse = (x: number, y: number, t: number, extra: Partial<OrbitPointer> = {}): OrbitPointer => ({ pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y, button: 0, timeStamp: t, ...extra });
const finger = (id: number, x: number, y: number, t: number): OrbitPointer => ({ pointerId: id, pointerType: 'touch', clientX: x, clientY: y, timeStamp: t });

describe('DragGate: клик или перетаскивание', () => {
  it('сдвиг меньше 6 px — клик (тап)', () => {
    const g = new DragGate();
    g.down(100, 100);
    expect(g.move(103, 104)).toBeNull(); // 5 px
    expect(g.up()).toBe('tap');
  });
  it('от 6 px — перетаскивание, дальше — приращения', () => {
    const g = new DragGate();
    g.down(100, 100);
    expect(g.move(106, 100)).toEqual({ dx: 6, dy: 0 });
    expect(g.move(110, 97)).toEqual({ dx: 4, dy: -3 });
    expect(g.up()).toBe('drag');
  });
  it('порог — ORBIT.dragPx (не меньше 6)', () => expect(ORBIT.dragPx).toBeGreaterThanOrEqual(6));
});

/** Input в миниатюре: те же решения, что src/input/input.ts (orbit → touch) */
function harness() {
  const ev: TouchEvent[] = [];
  const touch = new TouchInterpreter((e) => ev.push(e), (x) => (x < 200 ? 'head' : null));
  const target = pose();
  const view = new OrbitView(target);
  const o = new OrbitPointers(view);
  let active: number | null = null;
  const down = (e: OrbitPointer) => {
    const v = o.down(e);
    if (v === 'take') {
      if (active !== null) touch.cancel();
      active = null;
      return;
    }
    if (v === 'swallow' || active !== null) return;
    active = e.pointerId;
    touch.down(e.clientX, e.clientY, e.timeStamp);
  };
  const move = (e: OrbitPointer) => {
    const v = o.move(e);
    if (v === 'take') {
      if (e.pointerId === active) touch.cancel(), (active = null);
      return;
    }
    if (v === 'swallow' || e.pointerId !== active) return;
    touch.move(e.clientX, e.clientY, e.timeStamp);
  };
  const up = (e: OrbitPointer) => {
    if (o.up(e) !== 'pass') {
      if (e.pointerId === active) touch.cancel(), (active = null);
      return;
    }
    if (e.pointerId !== active) return;
    active = null;
    touch.up(e.clientX, e.clientY, e.timeStamp);
  };
  return { ev, touch, view, target, down, move, up, types: () => ev.map((e) => e.type) };
}

describe('вращение мышью не ломает тапы по коту', () => {
  it('клик по коту (сдвиг 3 px) — тап по зоне, вид не меняется', () => {
    const h = harness();
    h.down(mouse(100, 100, 0));
    h.move(mouse(102, 102, 40));
    h.up(mouse(102, 102, 90));
    expect(h.types()).toEqual(['tap_cat']);
    expect(h.view.changed).toBe(false);
  });
  it('перетаскивание по коту — поворот, без тапа и глажки', () => {
    const h = harness();
    h.down(mouse(100, 100, 0));
    for (let i = 1; i <= 30; i++) h.move(mouse(100 + i * 6, 100, i * 16)); // медленно, 180 px — пальцем было бы глажкой
    h.up(mouse(280, 100, 500));
    h.touch.tick(1000);
    expect(h.types().filter((t) => t !== 'drag')).toEqual([]);
    expect(h.target.spin).toBeGreaterThan(1);
    expect(h.view.spun).toBe(true);
  });
  it('Shift + перетаскивание по коту — глажка, как пальцем', () => {
    const h = harness();
    h.down(mouse(50, 100, 0, { shiftKey: true }));
    for (let i = 1; i <= 30; i++) h.move(mouse(50 + i * 4, 100, i * 30));
    h.up(mouse(170, 100, 950));
    expect(h.types()).toContain('stroke');
    expect(h.view.changed).toBe(false);
  });
  it('двойной клик после поворота — сброс вида, второй клик не тап; без поворота — двойной тап как раньше', () => {
    const h = harness();
    h.down(mouse(300, 100, 0));
    h.move(mouse(340, 130, 30));
    h.up(mouse(340, 130, 60));
    expect(h.view.changed).toBe(true);
    h.down(mouse(300, 300, 1000));
    h.up(mouse(300, 300, 1050));
    h.down(mouse(301, 300, 1200));
    h.up(mouse(301, 300, 1250));
    expect(h.view.changed).toBe(false);
    h.touch.tick(2000);
    expect(h.types()).toEqual(['tap_screen']); // первый клик — одиночный тап мимо кота, второй проглочен
    // вид не меняли — двойной клик мимо кота = фирменный трюк
    h.down(mouse(300, 300, 3000));
    h.up(mouse(300, 300, 3040));
    h.down(mouse(300, 300, 3200));
    h.up(mouse(300, 300, 3240));
    expect(h.types()).toContain('double_tap');
  });
  it('правая кнопка — сразу поворот, без тапа', () => {
    const h = harness();
    h.down(mouse(100, 100, 0, { button: 2 }));
    h.move(mouse(102, 100, 20, { button: 2 }));
    h.up(mouse(102, 100, 40, { button: 2 }));
    expect(h.types()).toEqual([]);
    expect(h.target.spin).not.toBe(0);
  });
});

describe('касание: два пальца вращают, один — как раньше', () => {
  it('один палец — тап по коту', () => {
    const h = harness();
    h.down(finger(5, 100, 100, 0));
    h.up(finger(5, 100, 100, 80));
    expect(h.types()).toEqual(['tap_cat']);
  });
  it('второй палец отменяет жест первого и вращает/приближает', () => {
    const h = harness();
    h.down(finger(5, 100, 100, 0));
    h.down(finger(6, 200, 100, 30));
    h.move(finger(5, 140, 100, 60));
    h.move(finger(6, 260, 100, 60)); // центр сдвинулся вправо, пальцы разошлись
    h.up(finger(5, 140, 100, 120));
    h.up(finger(6, 260, 100, 130));
    h.touch.tick(1000);
    expect(h.types().filter((t) => t !== 'drag')).toEqual([]);
    expect(h.target.spin).toBeGreaterThan(0);
    expect(h.target.distance).toBeLessThan(2.6);
  });
});

describe('пределы, клавиши, параметры', () => {
  it('наклон и расстояние в пределах', () => {
    const t = pose();
    const v = new OrbitView(t);
    v.drag(0, -100000);
    expect(t.tilt).toBe(ORBIT.tiltMax);
    v.drag(0, 100000);
    expect(t.tilt).toBe(ORBIT.tiltMin);
    v.zoom(1000);
    expect(t.distance).toBe(ORBIT.distMin);
    v.zoom(0.0001);
    expect(t.distance).toBe(ORBIT.distMax);
    v.reset();
    expect(t).toEqual(pose());
  });
  it('стрелки, +/−, R; не с Cmd/Ctrl', () => {
    const t = pose();
    const v = new OrbitView(t);
    expect(orbitKey(v, { key: 'ArrowRight' })).toBe(true);
    expect(t.spin).toBeCloseTo(ORBIT.keySpin);
    expect(orbitKey(v, { key: '+' })).toBe(true);
    expect(t.distance).toBeLessThan(2.6);
    expect(orbitKey(v, { key: 'к', code: 'KeyR' })).toBe(true);
    expect(v.changed).toBe(false);
    expect(orbitKey(v, { key: 'r', code: 'KeyR', metaKey: true })).toBe(false); // Cmd+R — перезагрузка
    expect(orbitKey(v, { key: 'a', code: 'KeyA' })).toBe(false);
  });
  it('?desktop — псевдоним nocard=off; десктоп-просмотр только без касаний', () => {
    expect(noCardCameraOff('?desktop')).toBe(true);
    expect(noCardCameraOff('?desktop&nocard=cam')).toBe(false);
    expect(noCardCameraOff('?nocard')).toBe(false);
    expect(isDesktopView('?nocard=off', false)).toBe(true);
    expect(isDesktopView('?nocard=off', true)).toBe(false);
    expect(isDesktopView('?desktop', false)).toBe(true);
  });
  it('редакции: ?desktop в lab — сразу, в MVP — только с from=test', () => {
    expect(filterSearch('?desktop', 'lab').search).toBe('desktop');
    expect(filterSearch('?desktop', 'mvp').removed).toEqual(['desktop']);
    expect(filterSearch('?from=test&desktop', 'mvp').search).toBe('from=test&desktop');
  });
});

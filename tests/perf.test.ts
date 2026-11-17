import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { AdaptiveQuality, QUALITY_LEVELS } from '../src/core/perf';
import { setFurQuality } from '../src/character/furShell';
import { modelUrl } from '../src/core/modelUrl';

/** n секунд кадров с частотой fps */
const run = (q: AdaptiveQuality, fps: number, sec: number) => {
  for (let t = 0; t < sec; t += 1 / fps) q.tick(1 / fps);
};

describe('адаптивное качество', () => {
  it('на 60 к/с ничего не меняет (уровень 0 = как без адаптации)', () => {
    const q = new AdaptiveQuality(null);
    run(q, 60, 30);
    expect(q.level).toBe(0);
    expect(QUALITY_LEVELS[0]).toEqual({ dprCap: 2, fur: 1, trackerHz: 0 });
  });

  it('медленно — снижает по ступеньке с паузой, быстро — возвращает не раньше чем через 10 с', () => {
    const q = new AdaptiveQuality(null);
    const seen: number[] = [];
    q.onChange = (_l, i) => seen.push(i);
    run(q, 20, 3 + 2.2); // разогрев 3 с + окно
    expect(q.level).toBe(1);
    run(q, 20, 30);
    expect(q.level).toBe(QUALITY_LEVELS.length - 1);
    expect(seen).toEqual([1, 2, 3]);
    run(q, 60, 9);
    expect(q.level).toBe(3);
    run(q, 60, 40);
    expect(q.level).toBe(0);
  });

  it('экран 30 Гц (энергосбережение iOS) — не «тормоза»: качество не трогаем', () => {
    const q = new AdaptiveQuality(null);
    run(q, 30, 30);
    expect(q.level).toBe(0);
  });

  it('?q=N фиксирует уровень', () => {
    const q = new AdaptiveQuality('2');
    run(q, 10, 30);
    expect(q.level).toBe(2);
    expect(q.fixed).toBe(true);
  });
});

describe('мех: доля оболочек', () => {
  const model = () => {
    const g = new THREE.Group();
    for (let k = 1; k <= 4; k++) {
      const m = new THREE.Mesh();
      m.name = `BD_FurShell_${k}`;
      g.add(m);
    }
    return g;
  };
  const vis = (g: THREE.Group) => g.children.map((c) => (c.visible ? 1 : 0)).join('');

  it('оставляет равномерные слои и всегда — внешний', () => {
    const g = model();
    setFurQuality(g, 1);
    expect(vis(g)).toBe('1111');
    setFurQuality(g, 0.5);
    expect(vis(g)).toBe('0101');
    setFurQuality(g, 0.25);
    expect(vis(g)).toBe('0001');
    setFurQuality(g, 1);
    expect(vis(g)).toBe('1111');
  });
});

describe('пути моделей', () => {
  it('без сборки (dev, тесты) — исходный путь', () => {
    expect(modelUrl('models/kind_v1.glb')).toBe('models/kind_v1.glb');
  });
});

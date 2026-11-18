import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { AdaptiveQuality, QUALITY_LEVELS } from '../src/core/perf';
import { FUR_LEVELS, buildFurShells, furLayersFor, furVisibleCount, setFurEnergy, setFurQuality } from '../src/character/furShell';
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

describe('мех: уровни, LOD и доля оболочек', () => {
  it('?fur=0..3 — уровни, ≥4 — число оболочек; по умолчанию телефон 8, ПК 12', () => {
    expect(furLayersFor(undefined, '?fur=0')).toBe(0);
    expect(furLayersFor(undefined, '?fur=1')).toBe(4);
    expect(furLayersFor(undefined, '?fur=2')).toBe(8);
    expect(furLayersFor(undefined, '?fur=3')).toBe(12);
    expect(furLayersFor(undefined, '?fur=6')).toBe(6);
    expect(furLayersFor(undefined, '?fur=40')).toBe(16);
    expect(furLayersFor(undefined, '', true)).toBe(FUR_LEVELS[2]);
    expect(furLayersFor(undefined, '', false)).toBe(FUR_LEVELS[3]);
  });

  it('видимых оболочек: качество × энергия × размер на экране, не меньше 2', () => {
    expect(furVisibleCount(12, 1, 1, 0)).toBe(12);
    expect(furVisibleCount(12, 1, 1, 1000)).toBe(12);
    expect(furVisibleCount(12, 1, 0.5, 1000)).toBe(6);
    expect(furVisibleCount(12, 0.25, 0.5, 1000)).toBe(2);
    expect(furVisibleCount(12, 1, 1, 60)).toBe(4); // кот мелкий — 30 %
    expect(furVisibleCount(12, 0, 1, 1000)).toBe(0);
    expect(furVisibleCount(0, 1, 1, 1000)).toBe(0);
  });

  const model = () => {
    const g = new THREE.Group();
    const geo = new THREE.BoxGeometry(0.1, 0.1, 0.1);
    const n = geo.attributes.position.count;
    geo.setAttribute('_furlen', new THREE.Float32BufferAttribute(new Float32Array(n).fill(0.01), 1));
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(n * 4), 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(n * 4).map((_, i) => (i % 4 ? 0 : 1)), 4));
    const bone = new THREE.Bone();
    const sm = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial());
    sm.name = 'BD_FurShell';
    sm.add(bone);
    sm.bind(new THREE.Skeleton([bone]));
    g.add(sm);
    return g;
  };
  it('оставляет равномерные слои и всегда — внешний; энергия убавляет слои', () => {
    const g = new THREE.Group();
    g.add(model());
    const root = g.children[0] as THREE.Group;
    // модель строится как в рантайме: оболочки — соседи BD_FurShell
    const shells = buildFurShells(root);
    const n = shells.length;
    expect(n).toBeGreaterThan(0);
    const all = '1'.repeat(n);
    const cnt = (s: string) => s.split('').filter((c) => c === '1').length;
    const v = () => root.children.filter((c) => /^BD_FurShell_/.test(c.name)).map((c) => (c.visible ? 1 : 0)).join('');
    setFurQuality(g, 1);
    expect(v()).toBe(all);
    setFurQuality(g, 0.5);
    expect(cnt(v())).toBe(Math.max(2, Math.round(n / 2)));
    expect(v().endsWith('1')).toBe(true);
    setFurEnergy('doze');
    setFurQuality(g, 1);
    expect(cnt(v())).toBe(Math.max(2, Math.round(n / 2)));
    setFurEnergy('normal');
    setFurQuality(g, 1);
    expect(v()).toBe(all);
  });
});

describe('пути моделей', () => {
  it('без сборки (dev, тесты) — исходный путь', () => {
    expect(modelUrl('models/kind_v1.glb')).toBe('models/kind_v1.glb');
  });
});

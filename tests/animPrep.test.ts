import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { prepareClip, retargetTracks, gaussSmooth } from '../src/character/animPrep';
import { blendSeconds } from '../src/character/animBlend';

const quatTrack = (name: string, times: number[], angles: number[]) => {
  const v: number[] = [];
  const q = new THREE.Quaternion();
  for (const a of angles) v.push(...q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), a).toArray());
  return new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, times, v);
};

describe('animPrep', () => {
  it('перепривязывает треки второго скелета (mixamorigHips_1 → mixamorigHips) и выбрасывает лишнее', () => {
    const names = new Set(['mixamorigHips', 'mixamorigLeftArm']);
    const clip = new THREE.AnimationClip('x', 1, [
      quatTrack('mixamorigLeftArm_1', [0, 1], [0, 1]),
      new THREE.VectorKeyframeTrack('mixamorigHips_2.position', [0, 1], [0, 0, 0, 1, 1, 1]),
      quatTrack('mixamorigNope', [0, 1], [0, 1]),
    ]);
    const r = retargetTracks(clip, names);
    expect(r).toEqual({ retargeted: 2, dropped: 1 });
    expect(clip.tracks.map((t) => t.name)).toEqual(['mixamorigLeftArm.quaternion', 'mixamorigHips.position']);
  });

  it('закрывает шов петли и фиксирует горизонталь корня', () => {
    const names = new Set(['mixamorigSpine', 'mixamorigHips']);
    const T = [0, 1, 2, 3, 4];
    const clip = new THREE.AnimationClip('talk', 4, [
      quatTrack('mixamorigSpine', T, [0, 0.3, 0.6, 0.9, 1.2]), // конец далеко от начала — «щелчок» на шве
      new THREE.VectorKeyframeTrack('mixamorigHips.position', T, [0, 1, 0, 0.5, 1, 0.2, 1, 1, 0.4, 1.5, 1, 0.6, 2, 1, 0.8]),
    ]);
    const info = prepareClip(clip, names, { isLoop: () => true });
    expect(info.seam0).toBeGreaterThan(1);
    expect(info.seam).toBeLessThan(0.01);
    const hp = clip.tracks.find((t) => t.name.endsWith('.position'))!.values;
    for (let i = 0; i < hp.length; i += 3) {
      expect(hp[i]).toBeCloseTo(hp[0]);
      expect(hp[i + 2]).toBeCloseTo(hp[2]);
    }
  });

  it('обрезает неподвижное начало одноразового клипа', () => {
    const names = new Set(['mixamorigRightArm']);
    const clip = new THREE.AnimationClip('poke', 4, [quatTrack('mixamorigRightArm', [0, 2, 3, 4], [0, 0, 1, 0.5])]);
    const info = prepareClip(clip, names, { isLoop: () => false });
    expect(info.trimStart).toBeGreaterThan(1.7);
    expect(clip.duration).toBeLessThan(2.4);
  });

  it('сглаживание убирает дрожание и не сдвигает ровное движение', () => {
    const n = 31;
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) v[i] = i * 0.1 + (i % 2 ? 0.05 : -0.05);
    const s = gaussSmooth(v, n, 1, 1.1, false);
    let jit = 0;
    for (let i = 2; i < n - 2; i++) jit = Math.max(jit, Math.abs(s[i] - i * 0.1));
    expect(jit).toBeLessThan(0.02);
  });

  it('длительность перехода: не резче 0,15 с, смена покоя мягче', () => {
    expect(blendSeconds(50, 'idle_breathe', 'poke_head')).toBeCloseTo(0.15);
    expect(blendSeconds(300, 'idle_breathe', 'idle_look_around')).toBeGreaterThanOrEqual(0.6);
    expect(blendSeconds(150, 'wave', 'idle_breathe')).toBeGreaterThanOrEqual(0.45);
  });
});

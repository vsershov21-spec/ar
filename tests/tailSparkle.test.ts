import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { tailFactor } from '../src/character/tailSparkle';
import { MouthRig } from '../src/character/mouthRig';

describe('Блёстка v2 (по умолчанию): искра хвоста и язык в покое', () => {
  it('доля кончика хвоста — по весам скина, к кончику больше, вне хвоста 0', () => {
    const rank = new Map([[10, 1], [11, 2], [12, 3], [13, 4]]);
    expect(tailFactor([0, 1, 2, 3], [0.5, 0.5, 0, 0], rank, 4)).toBe(0);
    expect(tailFactor([13, 0, 0, 0], [1, 0, 0, 0], rank, 4)).toBe(1);
    expect(tailFactor([10, 11, 0, 0], [0.5, 0.5, 0, 0], rank, 4)).toBeCloseTo(0.375);
  });
  it('язык: без настройки — как у всех (v1), у Блёстки — меньше и глубже', () => {
    const rig = new MouthRig(new THREE.Mesh(), { o: [0, 0, 0], ex: [1, 0, 0], ey: [0, 1, 0], W: 1, nose: 0.3, jaw: {} });
    expect(rig.uniforms.uMD.value.toArray()).toEqual([1, 0, 1, 0]);
    rig.setTongue({ size: 0.6, deeper: 0.1, tone: 0.82 });
    expect(rig.uniforms.uMD.value.x).toBeCloseTo(0.6);
    rig.setTongue(undefined);
    expect(rig.uniforms.uMD.value.toArray()).toEqual([1, 0, 1, 0]);
  });
});

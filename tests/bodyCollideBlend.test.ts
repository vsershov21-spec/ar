/**
 * Прокси со скином на нескольких костях (colliders.json volumes[].blend, 24.11): шарф/дуга наушников у плеча едут как
 * вершины ткани (линейный скин), а не только за шеей; прокси p1 Хулигана и Добряка — со скином из модели.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import * as THREE from 'three';
import { BodyCollider, proxyDepth, type CollidersJson } from '../src/character/bodyCollide';

function rig() {
  const root = new THREE.Group();
  const mk = (name: string, parent: THREE.Object3D, pos: [number, number, number]) => {
    const b = new THREE.Bone();
    b.name = 'mixamorig' + name;
    b.position.set(...pos);
    parent.add(b);
    return b;
  };
  const hips = mk('Hips', root, [0, 0.45, 0]);
  const neck = mk('Neck', hips, [0, 0.1, 0]);
  const sh = mk('RightShoulder', hips, [-0.05, 0.05, 0]);
  root.updateMatrixWorld(true);
  const bones = new Map<string, THREE.Object3D>([['Hips', hips], ['Neck', neck], ['RightShoulder', sh]]);
  return { root, neck, sh, bone: (n: string) => bones.get(n) };
}

describe('BodyCollider: прокси со скином (blend)', () => {
  it('капсула с весами Neck 0,5 / RightShoulder 0,5 едет на полпути между костями', () => {
    const { root, sh, bone } = rig();
    const json: CollidersJson = {
      volumes: [
        { name: 'scarf_0', bone: 'Neck', type: 'capsule', a: [-0.1, 0.55, 0], b: [-0.1, 0.55, 0.05], r: 0.02, blend: [['Neck', 0.5], ['RightShoulder', 0.5]] },
        { name: 'scarf_1', bone: 'Neck', type: 'capsule', a: [-0.1, 0.55, 0], b: [-0.1, 0.55, 0.05], r: 0.02 },
      ],
    };
    const c = new BodyCollider(root, bone);
    c.build(root, json);
    const [pb, pn] = c.proxies;
    expect(pb.blend?.w).toEqual([0.5, 0.5]);
    // ключица поднимает плечо на 4 см: смешанный прокси — на 2 см, прокси на шее — на месте
    sh.position.y += 0.04;
    root.updateMatrixWorld(true);
    c.measurePairs(); // prepare → updateBlend
    const p = new THREE.Vector3(-0.1, 0.57, 0.025);
    expect(proxyDepth(pb, p, 0)).toBeCloseTo(0.02, 3);
    expect(proxyDepth(pn, p, 0)).toBeCloseTo(0, 3);
  });

  it('прокси p1 Хулигана и Добряка: шарф/дуга у плеча со скином ключицы, веса в сумме 1', () => {
    for (const [cat, re] of [['hooligan', /^headphones_/], ['kind', /^scarf_/]] as const) {
      const j = JSON.parse(fs.readFileSync(`public/models/v2/${cat}_p1_colliders.json`, 'utf8')) as CollidersJson;
      const vs = j.volumes!.filter((v) => re.test(v.name));
      expect(vs.length, cat).toBeGreaterThan(5);
      const withBlend = vs.filter((v) => v.blend?.length);
      expect(withBlend.length, cat).toBeGreaterThan(4);
      for (const v of withBlend) expect(v.blend!.reduce((a, [, w]) => a + w, 0)).toBeCloseTo(1, 2);
      expect(withBlend.some((v) => v.blend!.some(([b]) => b === 'RightShoulder')), cat).toBe(true);
    }
  });
});

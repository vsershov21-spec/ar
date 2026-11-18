import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
// @ts-expect-error — .mjs без типов (серверный скрипт без зависимостей)
import { readGlb, writeGlb, slimGlb, glbAnimInfo, pickClips, metaDuration } from '../scripts/meshy/motion.mjs';
import { skelFrom, retargetClip } from '../src/character/meshyClips';

/** hooligan_v1.glb + синтетическая анимация Spine (как GLB анимации Meshy: меш, скин, клип) */
function withAnim() {
  const { json, bin } = readGlb(fs.readFileSync('public/models/hooligan_v1.glb'));
  const spine = json.nodes.findIndex((n: { name: string }) => n.name === 'mixamorig:Spine');
  const hips = json.nodes.findIndex((n: { name: string }) => n.name === 'mixamorig:Hips');
  const t = new Float32Array([0, 1]);
  const q0 = json.nodes[spine].rotation ?? [0, 0, 0, 1];
  const q1 = new THREE.Quaternion().fromArray(q0).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.6)).toArray();
  const r = new Float32Array([...q0, ...q1]);
  const p0 = json.nodes[hips].translation ?? [0, 0, 0];
  const p = new Float32Array([...p0, p0[0], p0[1] + 0.05, p0[2]]);
  const extra = Buffer.concat([Buffer.from(t.buffer), Buffer.from(r.buffer), Buffer.from(p.buffer)]);
  const base = Math.ceil(bin.length / 4) * 4;
  const nb = Buffer.concat([bin, Buffer.alloc(base - bin.length), extra]);
  const bv = json.bufferViews.length;
  json.bufferViews.push({ buffer: 0, byteOffset: base, byteLength: 8 }, { buffer: 0, byteOffset: base + 8, byteLength: 32 }, { buffer: 0, byteOffset: base + 40, byteLength: 24 });
  const ac = json.accessors.length;
  json.accessors.push(
    { bufferView: bv, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
    { bufferView: bv + 1, componentType: 5126, count: 2, type: 'VEC4' },
    { bufferView: bv + 2, componentType: 5126, count: 2, type: 'VEC3' },
  );
  json.animations = [{ name: 'Armature|clip0', samplers: [{ input: ac, output: ac + 1 }, { input: ac, output: ac + 2 }], channels: [{ sampler: 0, target: { node: spine, path: 'rotation' } }, { sampler: 1, target: { node: hips, path: 'translation' } }] }];
  json.buffers[0].byteLength = nb.length;
  return writeGlb(json, nb);
}

const parse = (b: Buffer) => new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer, '');

describe('scripts/meshy/motion.mjs: облегчение GLB', () => {
  it('меши и текстуры уходят, анимация и поза привязки (extras.bindWorld) остаются', async () => {
    const full = withAnim();
    const slim: Buffer = slimGlb(full);
    expect(slim.length).toBeLessThan(full.length / 20);
    const { json } = readGlb(slim);
    expect(json.meshes).toBeUndefined();
    expect(json.images).toBeUndefined();
    expect(glbAnimInfo(slim)).toMatchObject({ anims: 1, tracks: 2, dur: 1 });
    const g = await parse(slim);
    expect(g.animations[0].tracks.length).toBe(2);
    const sk = skelFrom(g.scene, (o) => !(o as THREE.Mesh).isMesh);
    const hips = sk.bones.get('hips')!;
    expect(sk.bones.get('spine')!.bindQ).toBeTruthy();
    // поза привязки из IBM — в той же системе, что и узлы: у этой модели покой = привязка
    g.scene.updateMatrixWorld(true);
    const hipsNode = g.scene.getObjectByName('mixamorigHips')!;
    expect(hipsNode.userData.bindWorld).toHaveLength(16);
    const wp = hipsNode.getWorldPosition(new THREE.Vector3());
    expect(hips.bindP.distanceTo(wp)).toBeLessThan(1e-3);
    expect(sk.hipsH).toBeGreaterThan(0.15);

    // перенос на самого себя — тождество (оси Tripo повёрнуты, математика не должна их «чинить»)
    const { clip } = retargetClip(g.animations[0], sk, sk, 'x');
    const src = g.animations[0].tracks.find((t) => t.name === 'mixamorigSpine.quaternion')!;
    const out = clip.tracks.find((t) => t.name === 'mixamorigSpine.quaternion')!;
    const a = new THREE.Quaternion().fromArray(src.values, 4);
    const b = new THREE.Quaternion().fromArray(out.values, out.values.length - 4);
    expect(a.angleTo(b)).toBeLessThan(1e-3);
    const hp = clip.tracks.find((t) => t.name === 'mixamorigHips.position')!.values;
    expect(hp[hp.length - 2] - hp[1]).toBeCloseTo(0.05, 3);
  });

  it('выбор клипов: P0 = 33 с «Сном и кроватью», длительность 2–10 шаг 0,5, промпт ≤ 400', () => {
    const d = JSON.parse(fs.readFileSync('scripts/models/t2m_prompts_v2.json', 'utf8'));
    const p0 = pickClips(d, { set: 'p0' });
    expect(p0.length).toBe(33);
    expect(p0.map((c: { id: string }) => c.id)).toEqual(expect.arrayContaining(['get_into_bed', 'lie_down_side', 'sleep_loop_bed', 'turn_over_sleep', 'wake_stretch_in_bed', 'hop_out_of_bed']));
    for (const c of [...p0, ...pickClips(d, { set: 'p1' })]) {
      expect(c.prompt.length, c.id).toBeLessThanOrEqual(400);
      expect(c.duration * 2).toBe(Math.round(c.duration * 2));
      expect(c.duration).toBeGreaterThanOrEqual(2);
      expect(c.tz, `${c.id}: нет specs.meshy`).toBe(true);
    }
    expect(metaDuration(0.9)).toBe(2);
    expect(metaDuration(2.2)).toBe(2.5);
    expect(metaDuration(4)).toBe(4);
    expect(pickClips(d, { only: ['poke_head', 'world_hungry'] }).map((c: { id: string }) => c.id)).toEqual(['poke_head', 'world_hungry']);
  });
});

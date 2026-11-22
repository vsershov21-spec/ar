import { describe, expect, it, beforeEach } from 'vitest';
import * as THREE from 'three';
import { normBone, parseManifest, retargetClip, skelFrom, loadMeshyClips, resetMeshyCache, meshyWanted, meshyStatus, PILOT_MESHY_OFF } from '../src/character/meshyClips';
import { GlbCharacter } from '../src/character/glbCharacter';

const bone = (name: string, parent: THREE.Object3D, pos: [number, number, number], q = new THREE.Quaternion()) => {
  const b = new THREE.Bone();
  b.name = name;
  b.position.set(...pos);
  b.quaternion.copy(q);
  parent.add(b);
  return b;
};
const axis = (x: number, y: number, z: number, a: number) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(x, y, z).normalize(), a);

/** источник «как из FBX Meshy»: Armature повёрнут −90° по X и масштаб 0,01, кости с осями Mixamo (без поворотов) */
function source() {
  const scene = new THREE.Group();
  const arm = new THREE.Group();
  arm.name = 'Armature';
  arm.quaternion.copy(axis(1, 0, 0, -Math.PI / 2));
  arm.scale.setScalar(0.01);
  scene.add(arm);
  const hips = bone('mixamorig:Hips', arm, [0, 0, 100]); // мир: y = 1
  const spine = bone('mixamorig:Spine', hips, [0, 0, 10]);
  const larm = bone('mixamorig:LeftArm', spine, [20, 0, 20]);
  bone('mixamorig:LeftHandIndex1', larm, [10, 0, 0]);
  bone('mixamorig:LeftFoot', hips, [10, 0, -90]); // мир: y = 0,1 → таз 0,9 над стопой
  scene.updateMatrixWorld(true);
  return { scene, hips, spine };
}

/** наш риг «как Tripo»: Hips повёрнут −90° по Y, у Spine свой локальный поворот, хвост — лишняя кость */
function target() {
  const root = new THREE.Group();
  const arm = new THREE.Group();
  arm.name = 'Armature';
  root.add(arm);
  const hips = bone('mixamorigHips', arm, [0, 0.45, 0], axis(0, 1, 0, -Math.PI / 2));
  const spine = bone('mixamorigSpine', hips, [0, 0.05, 0], axis(0, 0, 1, Math.PI / 6));
  bone('mixamorigLeftArm', spine, [0.1, 0.1, 0], axis(1, 1, 0, 0.4));
  bone('mixamorigLeftFoot', hips, [0, -0.4, 0]);
  bone('Tail1', hips, [0, 0, -0.1]);
  root.updateMatrixWorld(true);
  return { root, hips, spine };
}

describe('meshyClips: имена костей', () => {
  it('снимает префиксы mixamorig, суффиксы _N и регистр', () => {
    expect(normBone('mixamorig:LeftArm')).toBe('leftarm');
    expect(normBone('mixamorigLeftArm')).toBe('leftarm');
    expect(normBone('mixamorigLeftArm_2')).toBe('leftarm');
    expect(normBone('mixamorig5:Hips')).toBe('hips');
    expect(normBone('Armature|mixamorig:Spine1')).toBe('spine1');
    expect(normBone('Tail1')).toBe('tail1');
  });
});

describe('meshyClips: перенос клипа на наш скелет', () => {
  it('поворот кости в мире и подъём таза совпадают, пальцы и хвост не переносятся', () => {
    const s = source();
    const t = target();
    const src = skelFrom(s.scene);
    const dst = skelFrom(t.root);
    expect(src.hipsH).toBeCloseTo(0.9, 5);
    expect(dst.hipsH).toBeCloseTo(0.4, 5);

    // в мире: Spine повернулся на 45° вокруг вертикали, таз поднялся на 0,18 (20 % высоты таза)
    const D = axis(0, 1, 0, Math.PI / 4);
    const hipsW = s.hips.getWorldQuaternion(new THREE.Quaternion());
    const spineBindW = s.spine.getWorldQuaternion(new THREE.Quaternion());
    const spineLocal = hipsW.clone().invert().multiply(D.clone().multiply(spineBindW));
    const upLocal = new THREE.Vector3(0, 0.18, 0).add(s.hips.getWorldPosition(new THREE.Vector3())).applyMatrix4(s.hips.parent!.matrixWorld.clone().invert());
    const clip = new THREE.AnimationClip('m', 1, [
      new THREE.QuaternionKeyframeTrack('mixamorigSpine.quaternion', [0, 1], [...s.spine.quaternion.toArray(), ...spineLocal.toArray()]),
      new THREE.QuaternionKeyframeTrack('mixamorigLeftHandIndex1.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0.7071, 0.7071]),
      new THREE.VectorKeyframeTrack('mixamorigHips.position', [0, 1], [...s.hips.position.toArray(), ...upLocal.toArray()]),
    ]);
    const { clip: out, info } = retargetClip(clip, src, dst, 'sit_down');
    expect(out.name).toBe('sit_down');
    expect(info.dropped).toContain('lefthandindex1');
    expect(info.scale).toBeCloseTo(0.4 / 0.9, 5);
    const names = out.tracks.map((x) => x.name);
    expect(names).toContain('mixamorigSpine.quaternion');
    expect(names).toContain('mixamorigHips.position');
    expect(names.some((n) => /Tail|Index/.test(n))).toBe(false);

    const bindT = t.spine.getWorldQuaternion(new THREE.Quaternion());
    const mx = new THREE.AnimationMixer(t.root);
    mx.clipAction(out).play();
    mx.setTime(0);
    t.root.updateMatrixWorld(true);
    expect(t.spine.getWorldQuaternion(new THREE.Quaternion()).angleTo(bindT)).toBeLessThan(1e-3);
    expect(t.hips.getWorldPosition(new THREE.Vector3()).y).toBeCloseTo(0.45, 4);
    mx.setTime(1 - 1e-6);
    t.root.updateMatrixWorld(true);
    const want = D.clone().multiply(bindT);
    expect(t.spine.getWorldQuaternion(new THREE.Quaternion()).angleTo(want)).toBeLessThan(2e-3);
    expect(t.hips.getWorldPosition(new THREE.Vector3()).y).toBeCloseTo(0.45 + 0.08, 3);
  });

  it('поза привязки из userData.bindWorld важнее позы узлов (облегчённый GLB)', () => {
    const s = source();
    const bind = s.spine.matrixWorld.clone();
    s.spine.quaternion.copy(axis(1, 0, 0, 0.5)); // узел не в позе привязки
    s.spine.userData.bindWorld = bind.toArray();
    const sk = skelFrom(s.scene);
    const q = new THREE.Quaternion();
    bind.decompose(new THREE.Vector3(), q, new THREE.Vector3());
    expect(sk.bones.get('spine')!.bindQ.angleTo(q)).toBeLessThan(1e-6);
  });
});

describe('meshyClips: манифест', () => {
  it('берёт только корректные записи, без путей и повторов', () => {
    const r = parseManifest({
      clips: [
        { id: 'poke_head', file: 'poke_head.glb', loop: false, duration: 2 },
        { id: 'sleep_loop_bed', loop: true },
        { id: 'poke_head', file: 'x.glb' },
        { id: '../evil', file: 'a.glb' },
        { id: 'ok_id', file: '../../etc/passwd.glb' },
        { id: 'Bad Id' },
        null,
      ],
    });
    expect(r).toEqual([
      { id: 'poke_head', file: 'poke_head.glb', loop: false, duration: 2 },
      { id: 'sleep_loop_bed', file: 'sleep_loop_bed.glb', loop: true, duration: 0 },
    ]);
    expect(parseManifest(null)).toEqual([]);
    expect(parseManifest({ clips: 'x' })).toEqual([]);
  });

  it('?meshy=0 выключает, без функции — выключено', () => {
    expect(meshyWanted(true, '?flow=home')).toBe(true);
    expect(meshyWanted(true, '?meshy=0')).toBe(false);
    expect(meshyWanted(false, '')).toBe(false);
  });
});

describe('meshyClips: загрузка и замена опоры', () => {
  beforeEach(() => resetMeshyCache());

  it('нет манифеста (404) — ничего не регистрирует', async () => {
    const t = target();
    const got: string[] = [];
    const host = { skel: skelFrom(t.root), addExternalClip: async (id: string) => void got.push(id) };
    const r = await loadMeshyClips(host, { fetchJson: async () => null, loadGlb: async () => Promise.reject(new Error('не должен')) });
    expect(r).toEqual([]);
    expect(got).toEqual([]);
  });

  it('клип из манифеста встаёт вместо опоры fallback (get_into_bed → jump)', async () => {
    const t = target();
    const ch = new GlbCharacter();
    const priv = ch as unknown as { model: THREE.Object3D; inner: THREE.Group; mixer: THREE.AnimationMixer; addFallbacks(): void; addClip(c: THREE.AnimationClip): void };
    priv.inner.add(t.root);
    priv.model = t.root;
    priv.mixer = new THREE.AnimationMixer(t.root);
    ch.skel = skelFrom(t.root);
    priv.addClip(new THREE.AnimationClip('jump', 1, [new THREE.QuaternionKeyframeTrack('mixamorigSpine.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1])]));
    priv.addFallbacks();
    expect(ch.procedural.has('get_into_bed')).toBe(true);
    expect(ch.actions.get('get_into_bed')!.getClip().name).toBe('jump');

    const s = source();
    const T = [0, 0.5, 1, 1.5, 2];
    const vals: number[] = [];
    for (const a of [0, 0.4, 0.8, 0.4, 0]) vals.push(...axis(1, 0, 0, a).toArray());
    const clip = new THREE.AnimationClip('Armature|meshy', 2, [new THREE.QuaternionKeyframeTrack('mixamorigSpine.quaternion', T, vals)]);
    const r = await loadMeshyClips(ch, {
      fetchJson: async (u) => (u.endsWith('manifest.json') ? { clips: [{ id: 'get_into_bed', file: 'get_into_bed.glb', loop: false, duration: 2 }] } : null),
      loadGlb: async () => ({ scene: s.scene, animations: [clip] }),
    });
    expect(r).toEqual(['get_into_bed']);
    expect(ch.procedural.has('get_into_bed')).toBe(false);
    expect(ch.actions.get('get_into_bed')!.getClip().name).toBe('get_into_bed');
    expect(ch.actions.get('jump')!.getClip().name).toBe('jump');
    expect(ch.externalClips.map((e) => e.id)).toEqual(['get_into_bed']);
  });
});

describe('meshyClips: блок-лист пилота', () => {
  beforeEach(() => resetMeshyCache());

  it('выключенный id не грузится и не регистрируется (играет прежний клип), остальные — как раньше', async () => {
    const t = target();
    const got: string[] = [];
    const host = { skel: skelFrom(t.root), addExternalClip: async (id: string) => void got.push(id) };
    const s = source();
    const clip = new THREE.AnimationClip('Armature|meshy', 2, [new THREE.QuaternionKeyframeTrack('mixamorigSpine.quaternion', [0, 2], [0, 0, 0, 1, 0, 0, 0, 1])]);
    const asked: string[] = [];
    const r = await loadMeshyClips(host, {
      fetchJson: async () => ({ clips: [{ id: 'bad_clip', file: 'bad_clip.glb' }, { id: 'good_clip', file: 'good_clip.glb' }] }),
      loadGlb: async (u) => (asked.push(u), { scene: s.scene, animations: [clip] }),
      blocked: { bad_clip: 'уходит под пол' },
    });
    expect(r).toEqual(['good_clip']);
    expect(got).toEqual(['good_clip']);
    expect(asked.some((u) => u.includes('bad_clip'))).toBe(false);
    expect(meshyStatus.get('bad_clip')).toMatchObject({ state: 'rejected', reason: 'выключен в пилоте: уходит под пол' });
  });

  it('PILOT_MESHY_OFF: id клипов (манифест), у каждого причина; новые тела «с предметом», скейт и спрей — выключены', () => {
    for (const [id, why] of Object.entries(PILOT_MESHY_OFF)) {
      expect(id).toMatch(/^[a-z0-9_]+$/);
      expect(why.length, id).toBeGreaterThan(3);
    }
    for (const id of ['hold_sip_body', 'hold_treat_body', 'hold_mirror_body', 'skate_hop_on', 'skate_cruise', 'skate_ollie_air', 'skate_hop_off', 'spray_low_sweep']) {
      expect(PILOT_MESHY_OFF[id], id).toBeTruthy();
    }
  });
});

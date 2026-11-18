/**
 * Клипы Meshy: где какой клип играет (content/animations.json meshy), что меняется, когда он пришёл (cut и опоры снимаются,
 * поправки сцены выключаются, своя петля и переходы), и какие клипы отвергаются (NaN, таз, пределы, проникновение).
 * Синтетические клипы «как из Meshy»: кости mixamorig:*, Armature масштаб 0,01, человек 1,7 м.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import * as THREE from 'three';
import fs from 'node:fs';
import { MESHY_IDS, clipDef, meshyChain, meshyDef, meshyUpgrade } from '../src/character/clips';
import { ClipState } from '../src/character/clipState';
import { checkClip, loadMeshyClips, meshyStatus, resetMeshyCache, retargetClip, skelFrom } from '../src/character/meshyClips';
import { meshyReportText, meshyReportWanted, meshyRows } from '../src/character/meshyReport';
import { trimStill } from '../src/character/animPrep';
import { GlbCharacter } from '../src/character/glbCharacter';
import { PERSONA_META } from '../src/character/personaMeta';

const bone = (name: string, parent: THREE.Object3D, pos: [number, number, number], q = new THREE.Quaternion()) => {
  const b = new THREE.Bone();
  b.name = name;
  b.position.set(...pos);
  b.quaternion.copy(q);
  parent.add(b);
  return b;
};
const axis = (x: number, y: number, z: number, a: number) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(x, y, z).normalize(), a);

/** источник Meshy: человек 1,7 м, Armature −90° по X и 0,01 (см), кости Mixamo без своих поворотов */
function meshyRig() {
  const scene = new THREE.Group();
  const arm = new THREE.Group();
  arm.name = 'Armature';
  arm.quaternion.copy(axis(1, 0, 0, -Math.PI / 2));
  arm.scale.setScalar(0.01);
  scene.add(arm);
  const hips = bone('mixamorig:Hips', arm, [0, 0, 95]); // таз 0,95 м
  const spine = bone('mixamorig:Spine', hips, [0, 0, 10]);
  const neck = bone('mixamorig:Neck', spine, [0, 0, 45]);
  bone('mixamorig:Head', neck, [0, 0, 10]);
  bone('mixamorig:LeftArm', spine, [20, 0, 35]);
  bone('mixamorig:LeftFoot', hips, [10, 0, -87]); // стопа 0,08 м → таз 0,87 над стопой
  scene.updateMatrixWorld(true);
  return { scene, hips, spine };
}
/** наш кот (рост ≈ 1): Hips Tripo повёрнут −90° по Y */
function catRig() {
  const root = new THREE.Group();
  const arm = new THREE.Group();
  arm.name = 'Armature';
  root.add(arm);
  const hips = bone('mixamorigHips', arm, [0, 0.45, 0], axis(0, 1, 0, -Math.PI / 2));
  const spine = bone('mixamorigSpine', hips, [0, 0.05, 0]);
  const neck = bone('mixamorigNeck', spine, [0, 0.2, 0]);
  bone('mixamorigHead', neck, [0, 0.05, 0]);
  bone('mixamorigLeftArm', spine, [0.1, 0.15, 0]);
  bone('mixamorigLeftFoot', hips, [0, -0.4, 0]);
  root.updateMatrixWorld(true);
  return { root, hips, spine };
}
const qTrack = (node: string, T: number[], qs: THREE.Quaternion[]) => new THREE.QuaternionKeyframeTrack(`${node}.quaternion`, T, qs.flatMap((q) => q.toArray()));
const T5 = [0, 0.5, 1, 1.5, 2];

describe('Meshy: карта клипов', () => {
  it('ожидаемые id = specs[*].meshy в t2m_prompts_v2.json, у всех есть клип в каталоге', () => {
    const specs = JSON.parse(fs.readFileSync('scripts/models/t2m_prompts_v2.json', 'utf8')).specs as Record<string, { meshy?: unknown; loop?: boolean }>;
    const want = Object.keys(specs).filter((k) => specs[k].meshy).sort();
    expect([...MESHY_IDS].sort()).toEqual(want);
    // петля правила = петля спеки (манифест пишет её же)
    for (const id of want) expect(clipDef(id)!.meshy!.loop, id).toBe(!!specs[id].loop);
  });

  it('событие → клип по характеру; без клипа Meshy — прежний клип', () => {
    const all = (id: string) => MESHY_IDS.includes(id);
    const none = () => false;
    const cases: [string | string[], string, string, string][] = [
      ['treat', 'celebrate', 'hooligan', 'treat_eat_hooligan'],
      ['treat', 'celebrate', 'kind', 'treat_eat_kind'],
      ['treat', 'celebrate', 'glitter', 'treat_eat_glitter'],
      ['surprise', 'surprised', 'kind', 'surprise_trick_kind'],
      ['tease', 'offended', 'glitter', 'tease_glitter'],
      ['emo_is_sad', 'ears_back', 'hooligan', 'sad_sigh'],
      ['rps_is_rock', 'proud', 'kind', 'rps_throw'],
      ['sleep', 'sleep_loop', 'kind', 'fall_asleep'],
      ['wake_up', 'wake_startle', 'glitter', 'wake_up'],
      ['stroke_long', 'purr_stroke', 'hooligan', 'hug_receive_hooligan'],
      ['stroke_long', 'purr_stroke', 'glitter', 'hug_receive_glitter'],
      ['skate', 'idle_hooligan_skate', 'hooligan', 'skate_ride'],
      [['tap_cat_head', 'action:scratch'], 'poke_head', 'kind', 'scratch_enjoy'],
      ['code:goodbye', 'run_home', 'kind', 'dive_out'],
    ];
    for (const [w, from, p, to] of cases) {
      expect(meshyUpgrade(w, from, p, all), `${w} ${p}`).toBe(to);
      expect(meshyUpgrade(w, from, p, none), `${w} ${p} без Meshy`).toBe(from);
    }
    expect(meshyUpgrade('code:stage.turn', undefined, 'kind', all)).toBe('turn_step');
    // у Добряка своего «обнять» нет — остаётся его клип (hug_screen / purr_stroke)
    expect(meshyUpgrade('stroke_long', 'purr_stroke', 'kind', all)).toBe('purr_stroke');
    // from: тап по голове пальцем (не кнопка «Почесать») — тычок; реплика с другим клипом — без замены
    expect(meshyUpgrade('tap_cat_head', 'poke_head', 'kind', all)).toBe('poke_head');
    expect(meshyUpgrade('surprise', 'laugh', 'kind', all)).toBe('laugh');
    // клип есть, но не Meshy именно этот — тоже без замены
    expect(meshyUpgrade('treat', 'celebrate', 'kind', (id) => id === 'treat_eat_hooligan')).toBe('celebrate');
  });

  it('цепочки — только если оба клипа настоящие', () => {
    const all = () => true;
    expect(meshyChain('sit_down', all)).toEqual({ then: 'sit_idle', holdS: undefined });
    expect(meshyChain('sit_idle', all)).toEqual({ then: 'stand_up', holdS: 5 });
    expect(meshyChain('fall_asleep', all)?.then).toBe('sleep_loop');
    expect(meshyChain('sit_down', (id) => id === 'sit_down')).toBeNull();
    expect(meshyChain('poke_head', all)).toBeNull();
  });

  it('клип Meshy: cut и fallback сняты, петля и переходы — из правила', () => {
    const poke = clipDef('poke_head')!;
    expect(poke.cut).toBeTruthy();
    const m = meshyDef(poke, 1.3);
    expect(m.cut).toBeUndefined();
    expect(m.durationS).toBe(1.3);
    expect(m.blendOutMs).toBe(300);
    const bed = clipDef('lie_down_side')!;
    expect(bed.fallback).toBe('sleep_loop');
    expect(meshyDef(bed).fallback).toBeUndefined();
    // press_glass в каталоге — петля (T2M 5 с), клип Meshy — один раз (3 с)
    expect(clipDef('press_glass')!.loop).toBe(true);
    expect(meshyDef(clipDef('press_glass')!).loop).toBe(false);
  });

  it('ClipState: определение Meshy поверх каталога, мягкий возврат blendOutMs', () => {
    const cs = new ClipState(PERSONA_META.hooligan.idles, () => 0.1);
    cs.defOverride.set('press_glass', meshyDef(clipDef('press_glass')!, 1));
    cs.play('press_glass');
    expect(cs.cur.loop).toBe(false);
    cs.update(1.05);
    expect(cs.idleMode).toBe(true);
    expect(cs.cur.def.blendInMs).toBeGreaterThanOrEqual(300);
  });

  it('отчёт: состояние и где играет', () => {
    resetMeshyCache();
    meshyStatus.set('treat_eat_kind', { id: 'treat_eat_kind', state: 'loaded', dur: 2.1 });
    meshyStatus.set('wave', { id: 'wave', state: 'rejected', reason: 'NaN в x' });
    const reactions = { hooligan: { wave: { clip: 'wave' }, tap_cat_paw: { clip: 'poke_paw' } }, kind: { wave: { clip: 'wave' }, tap_cat_paw: { clip: 'wave' } }, glitter: { wave: { clip: 'wave' }, tap_cat_paw: { clip: 'wave' } } };
    const rows = meshyRows(meshyStatus, reactions, new Map([['treat_eat_kind', 1.2]]));
    const r = Object.fromEntries(rows.map((x) => [x.id, x]));
    expect(r.treat_eat_kind).toMatchObject({ state: 'loaded', dur: 2.1, pen: 1.2, usedBy: ['treat'] });
    expect(r.wave.state).toBe('rejected');
    expect(r.wave.usedBy).toEqual(expect.arrayContaining(['wave', 'tap_cat_paw (ДБ)']));
    expect(r.sit_idle.state).toBe('pending');
    expect(meshyReportText(rows)).toMatch(/загружено 1, нет 0, отвергнуто 1/);
    expect(meshyReportWanted('?meshyreport', true, false)).toBe(true);
    expect(meshyReportWanted('?meshyreport', false, false)).toBe(false);
    expect(meshyReportWanted('?meshyreport&from=test', false, true)).toBe(true);
    resetMeshyCache();
  });
});

describe('Meshy: перенос 1,7 м → кот и проверка', () => {
  it('высота таза масштабируется, −90° Hips Tripo учтён, проверка пропускает нормальный клип', () => {
    const s = meshyRig();
    const t = catRig();
    const src = skelFrom(s.scene), dst = skelFrom(t.root);
    expect(src.hipsH).toBeCloseTo(0.87, 5);
    expect(dst.hipsH).toBeCloseTo(0.4, 5);
    // присед: таз вниз на 0,3 м, наклон спины 30° вперёд (в мире)
    const down = s.hips.position.clone().add(new THREE.Vector3(0, 0, -30));
    const lean = axis(1, 0, 0, 0.5);
    const clip = new THREE.AnimationClip('m', 2, [
      new THREE.VectorKeyframeTrack('mixamorigHips.position', [0, 1, 2], [...s.hips.position.toArray(), ...down.toArray(), ...s.hips.position.toArray()]),
      qTrack('mixamorigSpine', [0, 1, 2], [new THREE.Quaternion(), lean, new THREE.Quaternion()]),
    ]);
    const { clip: out } = retargetClip(clip, src, dst, 'sit_down');
    const hp = out.tracks.find((x) => x.name.endsWith('.position'))!;
    const it = (hp as unknown as { createInterpolant(): THREE.Interpolant }).createInterpolant();
    const y1 = (it.evaluate(1) as unknown as number[])[1];
    expect(0.45 - y1).toBeCloseTo((0.3 * 0.4) / 0.87, 3);
    // наклон в мире кота — тот же (вокруг оси X мира, несмотря на −90° у Hips)
    const sp = out.tracks.find((x) => x.name === 'mixamorigSpine.quaternion')!;
    const q1 = new THREE.Quaternion().fromArray((sp as unknown as { createInterpolant(): THREE.Interpolant }).createInterpolant().evaluate(1) as unknown as number[]);
    t.spine.quaternion.copy(q1);
    t.root.updateMatrixWorld(true);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(t.spine.getWorldQuaternion(new THREE.Quaternion()));
    expect(up.z).toBeCloseTo(Math.sin(0.5), 2);
    expect(checkClip(out, dst)).toEqual({ ok: true });
  });

  it('отвергает: NaN, огромное смещение таза, поворот за предел, скачок за кадр', () => {
    const t = catRig();
    const dst = skelFrom(t.root);
    const nan = new THREE.AnimationClip('a', 1, [qTrack('mixamorigSpine', [0, 1], [new THREE.Quaternion(), new THREE.Quaternion(NaN, 0, 0, 1)])]);
    expect(checkClip(nan, dst)).toMatchObject({ ok: false, reason: expect.stringMatching(/NaN/) });
    // единицы перепутаны: таз уехал на 100 «метров»
    const far = new THREE.AnimationClip('b', 1, [new THREE.VectorKeyframeTrack('mixamorigHips.position', [0, 1], [0, 0.45, 0, 100, 0.45, 0])]);
    expect(checkClip(far, dst)).toMatchObject({ ok: false, reason: expect.stringMatching(/таз/) });
    // голова назад на 150°
    const head = new THREE.AnimationClip('c', 1, [qTrack('mixamorigHead', [0, 0.5, 1], [new THREE.Quaternion(), axis(1, 0, 0, 1.3), axis(1, 0, 0, 2.6)])]);
    expect(checkClip(head, dst)).toMatchObject({ ok: false, reason: expect.stringMatching(/head: поворот/) });
    // рука за один кадр (1/30 с) на 170°
    const spike = new THREE.AnimationClip('d', 1, [qTrack('mixamorigLeftArm', [0, 0.5, 0.5333, 1], [new THREE.Quaternion(), new THREE.Quaternion(), axis(0, 0, 1, 2.97), axis(0, 0, 1, 2.97)])]);
    const { clip: s30 } = { clip: spike };
    expect(checkClip(s30, dst)).toMatchObject({ ok: false, reason: expect.stringMatching(/скачок/) });
    expect(checkClip(new THREE.AnimationClip('e', 0.1, []), dst).ok).toBe(false);
  });

  it('неподвижный хвост 2-секундного клипа срезается (не короче 0,6 с)', () => {
    const vals = [new THREE.Quaternion(), axis(1, 0, 0, 0.8), new THREE.Quaternion(), axis(1, 0, 0, 0.01), axis(1, 0, 0, 0.02)];
    const clip = new THREE.AnimationClip('poke_head', 2, [qTrack('mixamorigSpine', T5, vals)]);
    const cut = trimStill(clip);
    expect(cut).toBeGreaterThan(0.3);
    expect(clip.duration).toBeGreaterThanOrEqual(0.6);
    expect(clip.duration).toBeLessThan(1.7);
    const still = new THREE.AnimationClip('x', 2, [qTrack('mixamorigSpine', [0, 2], [new THREE.Quaternion(), new THREE.Quaternion()])]);
    expect(trimStill(still)).toBeCloseTo(1.4, 1); // до 0,6 с
  });
});

describe('Meshy: загрузка и отчёт состояний', () => {
  beforeEach(() => resetMeshyCache());

  it('missing / rejected / loaded; отвергнутый — прежний клип остаётся', async () => {
    const t = catRig();
    const s = meshyRig();
    const host = { skel: skelFrom(t.root), got: [] as string[], addExternalClip: async (id: string) => (id === 'tease_kind' ? 'проникновение 9 мм (LHand:head)' : void host.got.push(id)) };
    const good = new THREE.AnimationClip('Armature|m', 2, [qTrack('mixamorigSpine', T5, [0, 0.3, 0.5, 0.3, 0].map((a) => axis(1, 0, 0, a)))]);
    const bad = new THREE.AnimationClip('Armature|m', 2, [qTrack('mixamorigSpine', [0, 1, 2], [new THREE.Quaternion(), new THREE.Quaternion(NaN, NaN, 0, 1), new THREE.Quaternion()])]);
    const r = await loadMeshyClips(host, {
      expected: ['poke_head', 'wave', 'treat_eat_kind', 'tease_kind', 'sit_idle'],
      loopOf: (id, l) => clipDef(id)?.meshy?.loop ?? l,
      fetchJson: async () => ({ clips: [{ id: 'poke_head' }, { id: 'wave' }, { id: 'treat_eat_kind' }, { id: 'tease_kind' }] }),
      loadGlb: async (u) => {
        if (u.includes('treat_eat_kind')) throw new Error(`${u}: 404`);
        return { scene: s.scene, animations: [u.includes('wave') ? bad : good] };
      },
    });
    expect(r).toEqual(['poke_head']);
    expect(host.got).toEqual(['poke_head']);
    expect(meshyStatus.get('poke_head')?.state).toBe('loaded');
    expect(meshyStatus.get('wave')).toMatchObject({ state: 'rejected', reason: expect.stringMatching(/NaN|ненорм/) });
    expect(meshyStatus.get('treat_eat_kind')?.state).toBe('missing');
    expect(meshyStatus.get('tease_kind')).toMatchObject({ state: 'rejected', reason: expect.stringMatching(/проникновение/) });
    expect(meshyStatus.get('sit_idle')).toMatchObject({ state: 'missing', reason: 'нет в манифесте' });
  });

  it('в коте: Meshy-клип заменяет монтаж cut и опору, своя петля, clipSource = meshy', async () => {
    const t = catRig();
    const ch = new GlbCharacter();
    const priv = ch as unknown as { model: THREE.Object3D; inner: THREE.Group; mixer: THREE.AnimationMixer; addFallbacks(): void; addClip(c: THREE.AnimationClip): void; clips: ClipState };
    priv.inner.add(t.root);
    priv.model = t.root;
    priv.mixer = new THREE.AnimationMixer(t.root);
    ch.skel = skelFrom(t.root);
    // старый клип poke_head (5 с) смонтирован cut → 1,5 с; press_glass — петля T2M; кровать — опора sleep_loop
    for (const [n, d] of [['poke_head', 1.5], ['press_glass', 5], ['sleep_loop', 4]] as const) priv.addClip(new THREE.AnimationClip(n, d, [qTrack('mixamorigSpine', [0, d], [new THREE.Quaternion(), new THREE.Quaternion()])]));
    priv.addFallbacks();
    expect(ch.clipSource('lie_down_side')).toBe('fallback');
    expect(ch.clipSource('poke_head')).toBe('own');
    const s = meshyRig();
    const mk = () => new THREE.AnimationClip('Armature|m', 2, [qTrack('mixamorigSpine', T5, [0, 0.4, 0.6, 0.4, 0].map((a) => axis(1, 0, 0, a)))]);
    await loadMeshyClips(ch, {
      loopOf: (id, l) => clipDef(id)?.meshy?.loop ?? l,
      fetchJson: async () => ({ clips: [{ id: 'poke_head', loop: true }, { id: 'press_glass', loop: true }, { id: 'lie_down_side' }] }),
      loadGlb: async () => ({ scene: s.scene, animations: [mk()] }),
    });
    for (const id of ['poke_head', 'press_glass', 'lie_down_side']) expect(ch.clipSource(id), id).toBe('meshy');
    // опора снята: сцена (bedFlow.isProc) больше не крутит кота и не правит ноги
    expect(ch.procedural.has('lie_down_side')).toBe(false);
    // петля — по правилу (спека: один раз), а не манифест (true) и не каталог (press_glass — петля)
    priv.clips.play('press_glass');
    expect(priv.clips.cur.loop).toBe(false);
    expect(priv.clips.cur.def.cut).toBeUndefined();
    priv.clips.play('poke_head');
    expect(priv.clips.cur.def.cut).toBeUndefined();
    expect(priv.clips.cur.def.blendOutMs).toBe(300);
  });
});

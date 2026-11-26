import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

/** Блёстка p4: модель продакта Tripo (Auto Rig) тем же конвейером, что Хулиган и Добряк (scripts/models/build_glitter_p4.sh) */
const read = (f: string) => {
  const b = fs.readFileSync(f);
  return JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString());
};
type J = { skins: { joints: number[] }[]; nodes: { name: string; extras?: Record<string, unknown>; mesh?: number }[]; meshes: { name: string; extras?: { targetNames?: string[] } }[]; asset: { extras?: Record<string, unknown> } };

describe('glitter p4: флаг ?models=p4', () => {
  it('modelsVariant/variantGlb/collidersUrl: p4 только явным параметром, лицо шейдером', async () => {
    const { modelsVariant, variantGlb, collidersUrl } = await import('../src/character/modelVariant');
    expect(modelsVariant('?models=p4', false)).toBe('p4');
    expect(modelsVariant('', false)).toBe('v2');
    expect(variantGlb('/models/glitter_v1.glb', 'p4', 'shader')).toBe('/models/v2/glitter_p4.glb');
    expect(variantGlb('/models/glitter_v1.glb', 'p4', 'morph')).toBe('/models/v2/glitter_p4.glb');
    expect(variantGlb('/models/hooligan_v1.glb', 'p4', 'shader')).toBe('/models/v2/hooligan_p1.glb');
    expect(variantGlb('/models/kind_v1.glb', 'p4', 'morph')).toBe('/models/v2/kind_p2.glb');
    expect(collidersUrl('/models/v2/glitter_p4.glb')).toBe('/models/v2/glitter_p4_colliders.json');
  });

  it('редакции: ?models=p4 — lab, в MVP и пилоте — только со страницы /test', async () => {
    const { filterSearch, PARAMS } = await import('../src/config/edition');
    expect(filterSearch('?models=p4', 'lab').search).toBe('models=p4');
    expect(filterSearch('?models=p4', 'pilot').search).toBe('');
    expect(filterSearch('?from=test&models=p4', 'pilot').search).toBe('from=test&models=p4');
    expect(PARAMS.models.keep).not.toContain('p4');
  });

  it('GLB: скелет Mixamo + уши и хвост как у Хулигана, глаза eyeRig, рот MouthD, мех, пачка и золото, прокси', () => {
    const p4: J = read('public/models/v2/glitter_p4.glb'), h: J = read('public/models/v2/hooligan_p1.glb');
    const bones = (j: J) => j.skins[0].joints.map((k) => j.nodes[k].name).sort();
    expect(bones(p4)).toEqual(bones(h));
    for (const b of ['LeftEar1', 'RightEar1', 'Tail1', 'Tail4']) expect(bones(p4)).toContain(b);
    const names = p4.nodes.map((n) => n.name);
    for (const n of ['Eye_L', 'Eye_R', 'EyeBall_L', 'LidUp_L', 'LidLo_R', 'Tear_L', 'Brows', 'Whiskers', 'MouthD', 'BD_FurShell', 'Skirt_P4', 'Bow_Glitter', 'Blush'])
      expect(names).toContain(n);
    expect(p4.nodes[0].name === 'Armature' || names.includes('Armature')).toBe(true);
    expect(names).not.toContain('node_0'); // обёртки Tripo сняты (иначе кот лежит)
    const eye = p4.nodes.find((n) => n.name === 'Eye_L')!;
    expect(eye.extras?.persona).toBe('glitter');
    expect(p4.asset.extras?.glitterP4).toBeTruthy();
    const body = p4.meshes.find((m) => m.extras?.targetNames?.includes('mouth_A'))!;
    expect(body.extras!.targetNames).toEqual(expect.arrayContaining(['mouth_A', 'mouth_O', 'smile', 'brow_up', 'cheek_up', 'frown']));
    const col = JSON.parse(fs.readFileSync('public/models/v2/glitter_p4_colliders.json', 'utf8'));
    expect(col.volumes.map((v: { name: string }) => v.name)).toEqual(expect.arrayContaining(['head', 'torso', 'skirt', 'bow']));
  });

  it('доводка лица 26.11: веки в тон меха (extras.lidTone), 4 лепестка ресниц, рот в покое и резцы (extras.mouth)', async () => {
    const p4: J = read('public/models/v2/glitter_p4.glb');
    for (const side of ['L', 'R']) {
      const eye = p4.nodes.find((n) => n.name === `Eye_${side}`)!;
      expect((eye.extras?.lidTone as number[]).length).toBe(4);
      const up = p4.nodes.find((n) => n.name === `LidUp_${side}`)!;
      expect((p4.meshes[up.mesh!].extras as { petals?: number } | undefined)?.petals).toBe(4);
    }
    const md = p4.nodes.find((n) => n.name === 'MouthD')!;
    const mouth = md.extras?.mouth as { rest: Record<string, number>; teeth: number[]; tongue: object; jaw: object };
    expect(mouth.rest.mouth_A).toBeLessThan(0.46); // челюсть тела в покое — меньше, чем у p1 (PERSONA_FACE_V2)
    // v3 (продакт: «больше на зайца»): клычки у уголков (форма 0), а не два резца по центру; рот открыт рисунком
    expect(mouth.teeth[0]).toBe(0);
    expect(mouth.teeth[2]).toBeGreaterThan(0.6);
    expect(mouth.rest.mouth_open).toBeGreaterThan(mouth.rest.mouth_A);
    // рантайм: зубки и язык — из extras модели, у остальных — как было
    const THREE = await import('three');
    const { MouthRig } = await import('../src/character/mouthRig');
    const mk = (ex: object) => {
      const m = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
      m.name = 'MouthD';
      m.userData.mouth = { o: [0, 0, 0], ex: [1, 0, 0], ey: [0, 1, 0], W: 1, nose: 0.3, jaw: {}, ...ex };
      const g = new THREE.Group(); g.add(m);
      return MouthRig.find(g)!;
    };
    const own = mk({ teeth: mouth.teeth, tongue: mouth.tongue, rest: mouth.rest }), def = mk({});
    expect(own.uniforms.uME.value.toArray()).toEqual(mouth.teeth);
    expect(def.uniforms.uME.value.toArray()).toEqual([0, 1, 0.5, 1]);
    own.setTongue({ size: 0.6, deeper: 0.1, tone: 0.82 });
    expect(own.uniforms.uMD.value.x).toBeCloseTo((mouth.tongue as { size: number }).size);
    def.setTongue({ size: 0.6, deeper: 0.1, tone: 0.82 });
    expect(def.uniforms.uMD.value.x).toBeCloseTo(0.6);
    expect(own.ex.rest).toEqual(mouth.rest);
  });

  it('v3: голова и мордочка по наложению на реф — своя морда, нос розовый, один блик, подводка толще', async () => {
    const p4: J = read('public/models/v2/glitter_p4.glb');
    const parts = (p4.asset.extras?.glitterP4 as { parts: Record<string, { role: string }> }).parts;
    const roles = Object.values(parts).map((q) => q.role);
    expect(Object.keys(parts)).toContain('cap_muzzle_v3'); // морда Tripo (вытянутый блок, раздвоенная губа) — своей заплаткой
    expect(roles).not.toContain('muzzle');
    expect(roles).not.toContain('brow'); // брови — мягкие заплатки мехом
    expect(roles).toContain('browcap');
    const eye = p4.nodes.find((n) => n.name === 'Eye_L')!;
    const hi = eye.extras?.hi as number[];
    expect(hi.length).toBe(5);
    expect(hi[3]).toBe(0); // второй блик выключен
    expect(eye.extras?.lash as number).toBeGreaterThan(1.6);
    // рантайм: mouth_open раскрывает рисунок рта без челюсти тела; у других котов ключа нет — как было
    const { mouthParams } = await import('../src/character/mouthRig');
    expect(mouthParams({ mouth_open: 0.7 }, { mouth_A: 0.4 }).drop).toBeCloseTo(0.28);
    expect(mouthParams({ mouth_A: 0.5 }, { mouth_A: 0.4 }).drop).toBeCloseTo(0.2);
    expect(mouthParams({ mouth_A: 0.9, mouth_open: 0.1 }, { mouth_A: 0.4 }).drop).toBeCloseTo(0.36);
    // блики: без extras.hi — прежние значения шейдера
    const THREE = await import('three');
    const { EyeRig } = await import('../src/character/eyeRig');
    const r = new EyeRig();
    expect(r.uniforms.uHiP.value.toArray()).toEqual([-0.42, 0.5, 1, 1]);
    expect(r.uniforms.uHiK.value).toBe(0);
    void THREE;
  });
});

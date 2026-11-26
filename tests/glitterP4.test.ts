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
});

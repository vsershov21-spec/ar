import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

/** Блёстка v5: модель продакта Tripo «как есть» (scripts/models/build_glitter_v5.sh) — вид 1:1, скелет как у Хулигана, веки и морфы */
const read = (f: string) => {
  const b = fs.readFileSync(f);
  return JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString());
};
type J = {
  skins: { joints: number[] }[];
  nodes: { name: string; mesh?: number }[];
  meshes: { name: string; extras?: { targetNames?: string[] } }[];
  materials: { name: string }[];
  asset: { extras?: Record<string, unknown> };
};

describe('glitter v5: флаг ?models=v5', () => {
  it('modelsVariant/variantGlb/collidersUrl: v5 только явным параметром, лицо своё при любом faceMode', async () => {
    const { modelsVariant, variantGlb, collidersUrl } = await import('../src/character/modelVariant');
    expect(modelsVariant('?models=v5', false)).toBe('v5');
    expect(modelsVariant('', false)).toBe('v2');
    expect(variantGlb('/models/glitter_v1.glb', 'v5', 'shader')).toBe('/models/v2/glitter_v5.glb');
    expect(variantGlb('/models/glitter_v1.glb', 'v5', 'morph')).toBe('/models/v2/glitter_v5.glb');
    expect(variantGlb('/models/hooligan_v1.glb', 'v5', 'shader')).toBe('/models/v2/hooligan_p1.glb');
    expect(variantGlb('/models/kind_v1.glb', 'v5', 'morph')).toBe('/models/v2/kind_p2.glb');
    expect(variantGlb('/models/glitter_v1.glb', 'v2', 'shader')).toBe('/models/v2/glitter_p1.glb');
    expect(collidersUrl('/models/v2/glitter_v5.glb')).toBe('/models/v2/glitter_v5_colliders.json');
  });

  it('редакции: ?models=v5 — lab, в MVP и пилоте — только со страницы /test', async () => {
    const { filterSearch, PARAMS } = await import('../src/config/edition');
    expect(filterSearch('?models=v5', 'lab').search).toBe('models=v5');
    expect(filterSearch('?models=v5', 'pilot').search).toBe('');
    expect(filterSearch('?models=v5', 'mvp').search).toBe('');
    expect(filterSearch('?from=test&models=v5', 'pilot').search).toBe('from=test&models=v5');
    expect(PARAMS.models.keep).not.toContain('v5');
  });

  it('GLB: 71 кость как у Хулигана, одна сетка Tripo + веки, ключи рта/бровей, без меха и накладок лица', () => {
    const v5: J = read('public/models/v2/glitter_v5.glb'), h: J = read('public/models/v2/hooligan_p1.glb');
    const bones = (j: J) => j.skins[0].joints.map((k) => j.nodes[k].name).sort();
    expect(bones(v5)).toEqual(bones(h));
    const names = v5.nodes.map((n) => n.name);
    expect(names).toContain('Body_Glitter_V5');
    expect(names).toContain('Lids_V5');
    expect(names).not.toContain('node_0');
    // лицо Tripo как есть: ни наших глаз, ни шейдерного рта, ни меха, ни меток лица (FurTone/складки их ищут)
    for (const n of ['Eye_L', 'MouthD', 'Brows', 'BD_FurShell', 'Blush']) expect(names).not.toContain(n);
    expect(v5.asset.extras?.glitterV5).toBeTruthy();
    const body = v5.meshes.find((m) => m.name === 'Body_Glitter_V5')!;
    expect(body.extras!.targetNames).toEqual(expect.arrayContaining(['mouth_A', 'mouth_E', 'mouth_O', 'mouth_U', 'mouth_M', 'smile', 'frown', 'brow_up', 'brow_sad']));
    const lids = v5.meshes.find((m) => m.name === 'Lids_V5')!;
    expect(lids.extras!.targetNames).toEqual(['lidL_1', 'lidL_2', 'lidL_3', 'lidL_4', 'lidR_1', 'lidR_2', 'lidR_3', 'lidR_4']);
    const col = JSON.parse(fs.readFileSync('public/models/v2/glitter_v5_colliders.json', 'utf8'));
    expect(col.volumes.map((v: { name: string }) => v.name)).toEqual(expect.arrayContaining(['head', 'torso', 'skirt', 'bow']));
  });

  it('веки: покой — 0, моргание — весь путь, прищур — часть, подмигнуть — одно веко', async () => {
    const { v5LidWeights } = await import('../src/character/v5Face');
    const sum = (w: Record<string, number>, s: string) => [1, 2, 3, 4].reduce((a, k) => a + w[`lid${s}_${k}`], 0);
    expect(sum(v5LidWeights({}), 'L')).toBe(0);
    expect(sum(v5LidWeights({}), 'R')).toBe(0);
    const b = v5LidWeights({ blink_L: 1, blink_R: 1 });
    expect(sum(b, 'L')).toBe(4);
    expect(sum(b, 'R')).toBe(4);
    const half = v5LidWeights({ blink_L: 0.5 });
    expect(half.lidL_1).toBe(1);
    expect(half.lidL_2).toBe(1);
    expect(half.lidL_3).toBe(0);
    const sq = v5LidWeights({ eyes_squint: 1 });
    expect(sum(sq, 'L')).toBeGreaterThan(0.5);
    expect(sum(sq, 'L')).toBeLessThan(4);
    const wk = v5LidWeights({ wink_R: 1 });
    expect(sum(wk, 'R')).toBe(4);
    expect(sum(wk, 'L')).toBe(0);
    // ключ не больше 1 (сумма моргания и прищура не уводит веко за кромку)
    for (const v of Object.values(v5LidWeights({ blink_L: 1, eyes_squint: 1, eyes_laugh: 1 }))) expect(v).toBeLessThanOrEqual(1);
  });
});

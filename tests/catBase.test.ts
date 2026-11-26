import fs from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

/** База котов + скины (docs/models/BASE.md, scripts/models/build_base.sh, src/character/catSkin.ts), флаг ?models=base */
const read = (f: string) => {
  const b = fs.readFileSync(f);
  return JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString());
};
type J = {
  skins: { joints: number[] }[];
  nodes: { name: string; extras?: Record<string, unknown>; mesh?: number; skin?: number }[];
  meshes: { name: string; extras?: { targetNames?: string[] } }[];
  asset: { extras?: Record<string, unknown> };
};
const CATS = ['glitter', 'hooligan', 'kind'] as const;
const bones = (j: J) => j.skins[0].joints.map((k) => j.nodes[k].name);

describe('база котов: флаг ?models=base', () => {
  it('modelsVariant/variantGlb/collidersUrl: скин по коту, база — рядом', async () => {
    const { modelsVariant, variantGlb, collidersUrl } = await import('../src/character/modelVariant');
    const { baseOfSkinUrl, isSkinUrl, skinBaseUrl } = await import('../src/character/catSkin');
    expect(modelsVariant('?models=base', false)).toBe('base');
    expect(modelsVariant('', false)).toBe('v2');
    for (const c of CATS) {
      const u = variantGlb(`/models/${c}_v1.glb`, 'base', 'morph');
      expect(u).toBe(`/models/base/skin_${c}.glb`);
      expect(isSkinUrl(u.slice(1))).toBe(true);
      expect(baseOfSkinUrl(u)).toBe('/models/base/cat_base.glb');
      expect(skinBaseUrl(u, { base: 'cat_base.glb' })).toBe('/models/base/cat_base.glb');
      expect(collidersUrl(u)).toBe(`/models/base/skin_${c}_colliders.json`);
    }
    // по умолчанию — прежние модели (пилот не меняется)
    expect(variantGlb('/models/kind_v1.glb', 'v2', 'shader')).toBe('/models/v2/kind_p1.glb');
    expect(isSkinUrl('models/v2/kind_p1.glb')).toBe(false);
  });

  it('редакции: ?models=base — lab, в MVP и пилоте — только со страницы /test', async () => {
    const { filterSearch, PARAMS } = await import('../src/config/edition');
    expect(filterSearch('?models=base', 'lab').search).toBe('models=base');
    expect(filterSearch('?models=base', 'pilot').search).toBe('');
    expect(filterSearch('?from=test&models=base', 'pilot').search).toBe('from=test&models=base');
    expect(PARAMS.models.keep).not.toContain('base');
  });

  it('GLB базы: скелет как у p1, без одежды, риг лица на морфах, торс отдельно', () => {
    const b: J = read('public/models/base/cat_base.glb'), h: J = read('public/models/v2/hooligan_p1.glb');
    expect([...bones(b)].sort()).toEqual([...bones(h)].sort());
    for (const n of ['LeftEar1', 'RightEar1', 'Tail1', 'Tail4']) expect(bones(b).some((x) => x.endsWith(n))).toBe(true);
    const names = b.nodes.map((n) => n.name);
    for (const n of ['FaceSkin', 'MouthCavity', 'Teeth', 'Tongue', 'Eye_L', 'LidUp_R', 'Brows', 'BD_FurShell', 'BD_FurShellFace', 'BodyTorso']) expect(names).toContain(n);
    for (const n of ['Skirt_P4', 'Bow_Glitter', 'MouthD']) expect(names).not.toContain(n);
    expect(names.some((n) => /^(Hoodie|Cap|Scarf|Shoes|Boots|Headphones)_/.test(n))).toBe(false);
    const fs_ = b.nodes.find((n) => n.name === 'FaceSkin')!;
    const keys = b.meshes[fs_.mesh!].extras!.targetNames!;
    for (const k of ['vis_A', 'vis_D', 'vis_H', 'smile', 'smile_open', 'smirk', 'frown', 'surprise', 'pout', 'tongue_out', 'blink_L', 'blink_R', 'squint', 'wide', 'brow_up', 'brow_down', 'brow_angry', 'brow_sad', 'cheek_up', 'cheeks_gum', 'nose_wrinkle'])
      expect(keys).toContain(k);
    expect(b.asset.extras?.catBase).toBeTruthy();
  });

  it('скины: тот же скелет, только одежда, вид в extras.catSkin, свои прокси', () => {
    const b: J = read('public/models/base/cat_base.glb');
    const want: Record<string, string[]> = {
      glitter: ['Hoodie_Glitter', 'Skirt_P4', 'Bow_Glitter'],
      hooligan: ['Hoodie_Hooligan', 'Cap_Hooligan', 'Headphones_Hooligan', 'Shoes_Hooligan'],
      kind: ['Hoodie_Kind', 'Scarf_Kind', 'Boots_Kind'],
    };
    for (const c of CATS) {
      const s: J = read(`public/models/base/skin_${c}.glb`);
      expect(bones(s)).toEqual(bones(b));
      const meshNodes = s.nodes.filter((n) => n.mesh !== undefined);
      for (const n of want[c]) expect(meshNodes.map((x) => x.name)).toContain(n);
      for (const n of meshNodes) expect(n.skin).toBe(0);
      expect(meshNodes.some((n) => /FaceSkin|BD_Fur|tripo_mesh/.test(n.name))).toBe(false);
      const look = s.asset.extras?.catSkin as { persona: string; base: string; rest: object; hide: string[] };
      expect(look.persona).toBe(c);
      expect(look.base).toBe('cat_base.glb');
      expect(look.hide).toContain('BodyTorso');
      const col = JSON.parse(fs.readFileSync(`public/models/base/skin_${c}_colliders.json`, 'utf8'));
      expect(col.volumes.map((v: { name: string }) => v.name)).toEqual(expect.arrayContaining(['head', 'torso']));
    }
  });

  it('graftSkin: меши скина — на кости базы по имени; applySkinLook: веки, лепестки ресниц, скрытые меши, мех под обувью', async () => {
    const { graftSkin, applySkinLook } = await import('../src/character/catSkin');
    const mkSkel = () => {
      const root = new THREE.Bone(); root.name = 'mixamorigHips';
      const foot = new THREE.Bone(); foot.name = 'mixamorigLeftFoot'; foot.position.y = -0.2; root.add(foot);
      const arm = new THREE.Group(); arm.name = 'Armature'; arm.add(root);
      return { arm, root, foot };
    };
    const base = mkSkel(), skin = mkSkel();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 1, 0, 1, 0, 0], 3));
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
    const cloth = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial());
    cloth.name = 'Shoes_Test';
    skin.arm.add(cloth);
    skin.arm.updateMatrixWorld(true);
    cloth.bind(new THREE.Skeleton([skin.root, skin.foot]));
    const bscene = new THREE.Group(); bscene.add(base.arm);
    // тело базы с мехом на тех же костях
    const bgeo = geo.clone();
    bgeo.setAttribute('_furlen', new THREE.Float32BufferAttribute([0.005, 0.005, 0.005], 1));
    const fur = new THREE.SkinnedMesh(bgeo, new THREE.MeshStandardMaterial()); fur.name = 'BD_FurShell';
    base.arm.add(fur); base.arm.updateMatrixWorld(true); fur.bind(new THREE.Skeleton([base.root, base.foot]));
    const torso = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial()); torso.name = 'BodyTorso'; base.arm.add(torso);
    const eye = new THREE.Group(); eye.name = 'Eye_L'; eye.userData = { restUp: 0.1, lash: 2.3 }; bscene.add(eye);
    const lidLo = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial()); lidLo.name = 'LidLo_L';
    lidLo.geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Array(9).fill(0), 3));
    const lidUp = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial()); lidUp.name = 'LidUp_L';
    lidUp.geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Array(18).fill(0), 3));
    lidUp.geometry.setIndex([0, 1, 2, 3, 4, 5]);
    bscene.add(lidLo, lidUp);

    expect(graftSkin(bscene, skin.arm)).toBe(1);
    expect(cloth.parent).toBe(base.arm);
    expect(cloth.skeleton.bones[1]).toBe(base.foot);
    expect(cloth.userData.skinPart).toBe(true);
    applySkinLook(bscene, { version: 1, persona: 'hooligan', base: 'cat_base.glb', restUp: 0.3, lash: 1.4, petals: 0, hide: ['BodyTorso'], furOff: ['LeftFoot'] });
    expect(eye.userData.restUp).toBe(0.3);
    expect(eye.userData.lash).toBe(1.4);
    expect(torso.visible).toBe(false);
    expect(Array.from(lidUp.geometry.getIndex()!.array)).toEqual([0, 1, 2]); // лепесток (вершины после века) убран
    const fl = fur.geometry.getAttribute('_furlen');
    expect(fl.getX(0)).toBe(0); // вершина на стопе — без меха
    expect(fl.getX(1)).toBeCloseTo(0.005);
  });
});

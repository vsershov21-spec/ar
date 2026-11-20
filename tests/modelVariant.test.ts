import { describe, expect, it } from 'vitest';
import { collidersUrl, modelsVariant, variantGlb } from '../src/character/modelVariant';
import { filterSearch } from '../src/config/edition';
import { FurTone } from '../src/character/furTone';

describe('поколение моделей котов: v1 по умолчанию, v2 — ?models=v2 (lab и /test)', () => {
  it('без параметра — v1 и исходные пути, прокси v1 рядом с моделью', () => {
    expect(modelsVariant('')).toBe('v1');
    expect(modelsVariant('?models=v1')).toBe('v1');
    expect(variantGlb('models/kind_v1.glb', 'v1')).toBe('models/kind_v1.glb');
    // v1 — свои прокси (scripts/models/colliders.py по v1 GLB), чужая модель — без файла
    expect(collidersUrl('models/kind_v1.glb')).toBe('models/kind_v1_colliders.json');
    expect(collidersUrl('models/hooligan_v1.glb')).toBe('models/hooligan_v1_colliders.json');
    expect(collidersUrl('models/character.glb')).toBeNull();
  });
  it('?models=v2 — у каждого кота основа ближе к рефам персонажа: все трое — p1 (геометрия v1 + правки по design/cut)', () => {
    expect(modelsVariant('?nocard=off&models=v2')).toBe('v2');
    const g = variantGlb('models/glitter_v1.glb', 'v2');
    expect(g).toBe('models/v2/glitter_p1.glb');
    // у Блёстки p1 своя геометрия (фатин вместо юбки Tripo) — свои прокси
    expect(collidersUrl(g)).toBe('models/v2/glitter_p1_colliders.json');
    for (const c of ['hooligan', 'kind']) {
      const p = variantGlb(`models/${c}_v1.glb`, 'v2');
      expect(p).toBe(`models/v2/${c}_p1.glb`);
      // геометрия v1 — прокси v1 (colliders.py по v1 GLB), коллайдеры модельщика (под v2) не подходят
      expect(collidersUrl(p)).toBe(`models/${c}_v1_colliders.json`);
    }
  });
  it('?models=v2h — геометрия v2 у всех трёх с коллайдерами модельщика', () => {
    expect(modelsVariant('?models=v2h')).toBe('v2h');
    for (const c of ['hooligan', 'kind', 'glitter']) {
      const g = variantGlb(`models/${c}_v1.glb`, 'v2h');
      expect(g).toBe(`models/v2/${c}_v2.glb`);
      expect(collidersUrl(g)).toBe(`models/v2/${c}_colliders.json`);
    }
    // чужая модель (?glb=…) не подменяется
    expect(variantGlb('models/character.glb', 'v2')).toBe('models/character.glb');
  });
  it('параметр models: в lab остаётся, в MVP и пилоте — только со страницы /test', () => {
    expect(filterSearch('?models=v2', 'lab').search).toBe('models=v2');
    expect(filterSearch('?models=v2', 'mvp').search).toBe('');
    expect(filterSearch('?models=v2', 'pilot').search).toBe('');
    expect(filterSearch('?from=test&models=v2', 'pilot').search).toBe('from=test&models=v2');
  });
  it('тон меха: наушники и фатин v2 не тонируются, у v1 — как раньше', () => {
    expect(FurTone.isFur('Headphones_Hooligan', true)).toBe(false);
    expect(FurTone.isFur('Skirt_Glitter', true)).toBe(false);
    expect(FurTone.isFur('Headphones_Hooligan', false)).toBe(true);
  });
});

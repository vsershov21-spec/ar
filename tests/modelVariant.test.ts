import { describe, expect, it } from 'vitest';
import { collidersUrl, modelsVariant, variantGlb } from '../src/character/modelVariant';
import { filterSearch } from '../src/config/edition';
import { FurTone } from '../src/character/furTone';

describe('поколение моделей котов: v1 по умолчанию, v2 — ?models=v2 (lab и /test)', () => {
  it('без параметра — v1 и исходные пути, коллайдеров модельщика нет', () => {
    expect(modelsVariant('')).toBe('v1');
    expect(modelsVariant('?models=v1')).toBe('v1');
    expect(variantGlb('models/kind_v1.glb', 'v1')).toBe('models/kind_v1.glb');
    expect(collidersUrl('models/kind_v1.glb')).toBeNull();
    expect(collidersUrl('models/hooligan_v1.glb')).toBeNull();
  });
  it('?models=v2 — модели и коллайдеры из public/models/v2', () => {
    expect(modelsVariant('?nocard=off&models=v2')).toBe('v2');
    for (const c of ['hooligan', 'kind', 'glitter']) {
      const g = variantGlb(`models/${c}_v1.glb`, 'v2');
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

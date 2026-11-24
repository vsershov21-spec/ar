// GLB-кровать Meshy (public/models/props/bed.glb) — только lab; пилот и MVP — процедурная кровать (docs/qa/bed/GLB_1123.md)
import { describe, expect, it } from 'vitest';
import { featureIn, filterSearch } from '../src/config/edition';
import { bedGlbWanted } from '../src/home/room';

describe('home.bedGlb: GLB-кровать', () => {
  it('выключена в пилоте и MVP, включена в lab', () => {
    expect(featureIn('pilot', 'home.bedGlb')).toBe(false);
    expect(featureIn('mvp', 'home.bedGlb')).toBe(false);
    expect(featureIn('lab', 'home.bedGlb')).toBe(true);
  });
  it('по умолчанию — по функции; ?bedglb=1|0 переопределяет', () => {
    expect(bedGlbWanted('', false)).toBe(false);
    expect(bedGlbWanted('?flow=home', true)).toBe(true);
    expect(bedGlbWanted('?bedglb=1', false)).toBe(true);
    expect(bedGlbWanted('?bedglb=0', true)).toBe(false);
  });
  it('в пилоте ?bedglb вырезается, кроме ссылок со страницы /test', () => {
    expect(filterSearch('?bedglb=1', 'pilot').search).toBe('');
    expect(filterSearch('?bedglb=1&from=test', 'pilot').search).toContain('bedglb=1');
    expect(filterSearch('?bedglb=1', 'lab').search).toContain('bedglb=1');
  });
});

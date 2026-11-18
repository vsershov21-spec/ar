/**
 * Отпечаток дизайна (src/tracker/card/fingerprint.ts) и база дизайнов каталога (designDb.ts).
 * Каталог в репозитории не лежит — позитивы здесь: 14 уменьшенных дизайнов из tests/fixtures/cards/designs (они есть в
 * базе); негативы — процедурные карты других банков и предметы, скриншоты из docs/ на карточке. Полная калибровка и
 * стресс-набор по всем дизайнам — designdb.gen.test.ts и stress.test.ts.
 */
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { readdirSync } from 'node:fs';
import { classifyCard } from '../../src/tracker/card/verify';
import { designDb, matchDesign, fpProf } from '../../src/tracker/card/fingerprint';
import { DESIGN_DB_INFO } from '../../src/tracker/card/designDb';
import { renderCardScene, rng, type Tex } from '../helpers/synthCard';
import { design, OTHER_DESIGNS, NOT_CARDS, NOT_CARD_SHAPE } from '../helpers/cardDesigns';
import { randomCond } from '../helpers/stress';

const FIX = new URL('../fixtures/cards/designs/', import.meta.url).pathname;
async function tex(file: string, width?: number): Promise<Tex> {
  let s = sharp(file).removeAlpha();
  if (width) s = s.resize({ width, height: Math.round(width / 1.586), fit: 'fill' });
  const { data, info } = await s.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { rgba: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), w: info.width, h: info.height };
}

/** вердикт по кадру сцены с условиями стресс-набора (наклон, свет, блик, смаз, палец, стол) */
function shot(t: Tex, seed: number, shape?: { aspect: number; radius: number }) {
  const R = rng(seed * 2654435761);
  for (let i = 0; i < 4; i++) R();
  const c = randomCond(R);
  const f = renderCardScene({ ...c, w: 480, h: 360, tex: t, shape, ss: 2, seed, noiseSeed: seed });
  const q = f.corners.map((p) => ({ x: p.x + (R() - 0.5) * 1.4, y: p.y + (R() - 0.5) * 1.4 }));
  return classifyCard(f, q, { f: f.focal, cx: f.w / 2, cy: f.h / 2 })!;
}

describe('отпечаток дизайна карты', () => {
  it('база: все записи каталога, компактно', () => {
    const db = designDb();
    expect(db.length).toBe(DESIGN_DB_INFO.n);
    expect(db.length).toBeGreaterThanOrEqual(70);
    // дизайны без знака Сбера на лицевой стороне — в базе и узнаются (порог > 0)
    for (const id of [29, 41, 42, 43, 121, 123, 125]) expect(db.find((e) => e.id === id)?.thr ?? 0).toBeGreaterThan(0);
  });

  it('дизайны из фикстур узнаются по отпечатку (свой номер), в разных условиях', async () => {
    let hit = 0, own = 0, n = 0;
    const files = readdirSync(FIX).sort();
    for (const [i, f] of files.entries()) {
      const id = +f.replace(/\D/g, '');
      const t = await tex(FIX + f);
      for (let k = 0; k < 4; k++) {
        const v = shot(t, 100 + i * 10 + k);
        n++;
        if (v.f.designHit) hit++;
        if (v.f.designHit && v.f.designId === id) own++;
      }
    }
    console.log(`fixtures: hit ${hit}/${n}, свой номер ${own}`);
    expect(hit / n).toBeGreaterThanOrEqual(0.6);
    expect(own).toBeGreaterThanOrEqual(hit - 2);
  }, 120_000);

  it('чужие карты, предметы и картинки на карточке — не известный дизайн', async () => {
    const neg: string[] = [];
    let n = 0, seed = 7000;
    for (const k of OTHER_DESIGNS) for (let s = 1; s <= 3; s++) for (let r = 0; r < 2; r++, n++) if (shot(design(k, s), seed++).f.designHit) neg.push(`${k}#${s}`);
    for (const k of NOT_CARDS) for (let s = 1; s <= 2; s++, n++) if (shot(design(k, s), seed++, NOT_CARD_SHAPE[k]).f.designHit) neg.push(`${k}#${s}`);
    // скриншоты и картинки из docs/ как «дизайн чужой карты» (там есть и СберКот из приложения — жёсткий негатив)
    const dir = new URL('../../docs/', import.meta.url).pathname;
    const pics = readdirSync(dir + 'ui').filter((f) => f.endsWith('.png')).sort().filter((_, i) => i % 6 === 0).map((f) => dir + 'ui/' + f);
    for (const p of pics) {
      const t = await tex(p, 300);
      for (let r = 0; r < 2; r++, n++) {
        const v = shot(t, seed++);
        if (v.f.designHit) neg.push(`${p.split('/').pop()} → #${v.f.designId} ${v.f.design.toFixed(2)}`);
      }
    }
    console.log(`negatives: ${neg.length}/${n}`, neg.join(', '));
    expect(neg.length).toBe(0);
  }, 120_000);

  it('сопоставление со всей базой — доли миллисекунды', async () => {
    const t = await tex(FIX + readdirSync(FIX)[0]);
    const f = renderCardScene({ w: 480, h: 360, tex: t, tilt: 30, dist: 2.4, ss: 1 });
    classifyCard(f, f.corners); // прогрев
    fpProf.ms = fpProf.n = 0;
    const R = new Float32Array(200 * 126).fill(0.5), G = R.slice(), B = R.slice();
    for (let i = 0; i < R.length; i++) (R[i] = (i % 200) / 200), (G[i] = ((i / 200) | 0) / 126);
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) matchDesign(R, G, B, 200, 126);
    const ms = (performance.now() - t0) / 50;
    console.log(`matchDesign: ${ms.toFixed(2)} мс`);
    expect(ms).toBeLessThan(3);
  });
});

/**
 * База отпечатков дизайнов карт Сбера (src/tracker/card/designDb.ts) и её калибровка.
 *   GEN_DB=1 npx vitest run tests/card/designdb.gen.test.ts      — собрать базу из каталога (PDF) и записать designDb.ts
 *   FP_EXPLORE=1 …                                              — только цифры (позитивы/негативы, пороги)
 * Негативы для порогов — NEG_DIR (картинки-«чужие карты»: фото, скриншоты, кадры; по умолчанию /tmp/neg) +
 * процедурные карты других банков и предметы (tests/helpers/cardDesigns.ts). Каталог и негативы в репозиторий
 * не кладём; в базе — только дескрипторы.
 */
import { describe, it } from 'vitest';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { cardCorners, warpCard, canonicalPlanes, CW, CH } from '../../src/tracker/card/verify';
import { describe as describeCard, entryFromDesc, encodeEntry, similarity, newDesc, type DbEntry, type Desc } from '../../src/tracker/card/fingerprint';
import { CATALOG_IDS, catalogAvailable, catalogDesign, loadTex } from '../helpers/catalog';
import { renderCardScene, rng, type Tex } from '../helpers/synthCard';
import { design, OTHER_DESIGNS, NOT_CARDS, NOT_CARD_SHAPE } from '../helpers/cardDesigns';
import { randomCond, condLabel } from '../helpers/stress';

const on = !!(process.env.GEN_DB || process.env.FP_EXPLORE) && catalogAvailable();
const NEG_DIR = process.env.NEG_DIR ?? '/tmp/neg';

function descOfTex(t: Tex): Desc {
  warpCard(t, [{ x: -0.5, y: -0.5 }, { x: t.w - 0.5, y: -0.5 }, { x: t.w - 0.5, y: t.h - 0.5 }, { x: -0.5, y: t.h - 0.5 }]);
  const { R, G, B } = canonicalPlanes();
  return describeCard(R, G, B, CW, CH, newDesc());
}

/** дескриптор карты в синтетической сцене (условия — как в стресс-наборе) */
export let lastLabel = '';
export function descOfScene(t: Tex, seed: number, shape?: { aspect: number; radius: number }): Desc {
  const R = rng(seed * 2654435761);
  for (let i = 0; i < 4; i++) R();
  const c = randomCond(R);
  lastLabel = condLabel(c);
  const big = R() < 0.5;
  const f = renderCardScene({ ...c, w: big ? 480 : 320, h: big ? 360 : 240, tex: t, shape, ss: 2, seed, noiseSeed: seed });
  const q = f.corners.map((p) => ({ x: p.x + (R() - 0.5) * 1.4, y: p.y + (R() - 0.5) * 1.4 }));
  warpCard(f, cardCorners(q, { f: f.focal, cx: f.w / 2, cy: f.h / 2 }));
  const { R: r, G, B } = canonicalPlanes();
  return describeCard(r, G, B, CW, CH, newDesc());
}

const best = (d: Desc, e: DbEntry) => Math.max(similarity(d, e, false), similarity(d, e, true));
const pct = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN;
};

describe.skipIf(!on)('база отпечатков дизайнов', () => {
  it('сборка и калибровка', async () => {
    const entries: DbEntry[] = [];
    const tex = new Map<number, Tex>();
    for (const id of CATALOG_IDS) {
      const t = await catalogDesign(id);
      tex.set(id, t);
      entries.push(entryFromDesc(id, 0.5, descOfTex(t)));
    }
    // негативы: картинки из NEG_DIR, процедурные чужие карты и предметы
    const negs: { name: string; d: Desc }[] = [];
    let seed = 1000;
    if (existsSync(NEG_DIR))
      for (const f of readdirSync(NEG_DIR).sort()) {
        const t = await loadTex(NEG_DIR + '/' + f);
        for (let k = 0; k < 2; k++) negs.push({ name: f, d: descOfScene(t, seed++) });
      }
    for (const k of OTHER_DESIGNS) for (let s = 1; s <= 3; s++) negs.push({ name: k, d: descOfScene(design(k, s), seed++) });
    for (const k of NOT_CARDS) for (let s = 1; s <= 2; s++) negs.push({ name: k, d: descOfScene(design(k, s), seed++, NOT_CARD_SHAPE[k]) });
    // позитивы: каждый дизайн в 8 случайных условиях
    const pos = new Map<number, number[]>();
    const posAll: number[] = [];
    const conf: string[] = [];
    const byCond: Record<string, number[]> = {};
    for (const e of entries) {
      const v: number[] = [];
      for (let k = 0; k < 8; k++) {
        const d = descOfScene(tex.get(e.id)!, 5000 + e.id * 31 + k);
        const own = best(d, e);
        v.push(own);
        for (const lb of lastLabel.split('+')) (byCond[lb] ??= []).push(own);
        posAll.push(own);
        // путаница с другими записями (для справки: другие дизайны Сбера — это тоже «Сбер»)
        let bo = 0, bid = -1;
        for (const o of entries) if (o !== e) {
          const s = best(d, o);
          if (s > bo) (bo = s), (bid = o.id);
        }
        if (bo > own) conf.push(`${e.id}→${bid} ${own.toFixed(2)}/${bo.toFixed(2)}`);
      }
      pos.set(e.id, v);
    }
    // порог записи: выше максимума по негативам с запасом, не ниже общего минимума
    const T_MIN = +(process.env.T_MIN ?? 0.66), MARGIN = +(process.env.MARGIN ?? 0.08);
    const lines: string[] = [];
    const negMaxAll: number[] = [];
    for (const e of entries) {
      let nm = 0, nn = '';
      for (const n of negs) {
        const s = best(n.d, e);
        if (s > nm) (nm = s), (nn = n.name);
      }
      negMaxAll.push(nm);
      const p = pos.get(e.id)!;
      let thr = Math.max(T_MIN, nm + MARGIN);
      const p25 = pct(p, 0.25);
      if (e.sd < 0.03 || thr > 0.95) thr = 0; // «обычный» дизайн (ровный цвет) — только по знаку
      e.thr = thr;
      const rec = thr ? p.filter((x) => x >= thr).length / p.length : 0;
      lines.push(`${String(e.id).padStart(3)} sd ${e.sd.toFixed(3)} pos min ${Math.min(...p).toFixed(2)} p25 ${p25.toFixed(2)} med ${pct(p, 0.5).toFixed(2)} | neg max ${nm.toFixed(2)} (${nn}) → thr ${thr.toFixed(2)} recall ${(100 * rec).toFixed(0)}%`);
    }
    if (process.env.FP_LINES) console.log(lines.join('\n'));
    const recs0 = entries.filter((e) => e.thr > 0).map((e) => pos.get(e.id)!.filter((x) => x >= e.thr).length / 8);
    console.log('recall при пороге записи: среднее', (100 * recs0.reduce((a, b) => a + b, 0) / recs0.length).toFixed(1) + '%', 'записей', recs0.length, 'порог медиана', pct(entries.map((e) => e.thr), 0.5).toFixed(2));
    console.log('позитивы: p10', pct(posAll, 0.1).toFixed(2), 'p50', pct(posAll, 0.5).toFixed(2), '| негативы (max по записи): p50', pct(negMaxAll, 0.5).toFixed(2), 'p90', pct(negMaxAll, 0.9).toFixed(2), 'max', Math.max(...negMaxAll).toFixed(2), '| негативов', negs.length);
    console.log('по условиям (доля ≥ 0,62 / медиана):', Object.entries(byCond).map(([k, v]) => `${k} ${(100 * v.filter((x) => x >= 0.62).length / v.length).toFixed(0)}%/${pct(v, 0.5).toFixed(2)} n${v.length}`).join(' · '));
    console.log('путаница:', conf.length, conf.slice(0, 30).join(', '));
    if (process.env.GEN_DB) {
      const recs = entries.map((e) => encodeEntry(e.id, e.thr, { l: e.l, c: e.c, cm: e.cm, ok: Uint8Array.from(e.white, (x) => (x ? 2 : 1)), sd: e.sd }));
      const all = new Uint8Array(recs.reduce((s, r) => s + r.length, 0));
      let p = 0;
      for (const r of recs) all.set(new Uint8Array(r.buffer), p), (p += r.length);
      const b64 = Buffer.from(all).toString('base64');
      const out =
        `// СГЕНЕРИРОВАНО tests/card/designdb.gen.test.ts (GEN_DB=1) — не править руками.\n` +
        `// Отпечатки ${entries.length} дизайнов каталога карт Сбера (int8-дескрипторы, не изображения), src/tracker/card/fingerprint.ts.\n` +
        `export const DESIGN_DB =\n  '${b64.match(/.{1,160}/g)!.join("' +\n  '")}';\n` +
        `export const DESIGN_DB_INFO = { n: ${entries.length}, off: ${entries.filter((e) => !e.thr).length}, ids: [${entries.map((e) => e.id).join(', ')}] };\n`;
      writeFileSync(new URL('../../src/tracker/card/designDb.ts', import.meta.url), out);
      console.log('designDb.ts:', all.length, 'байт,', b64.length, 'base64');
    }
  }, 3_600_000);
});

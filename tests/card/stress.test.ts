/**
 * Стресс-набор трекера карты: все дизайны каталога × условия съёмки → доля посадок, время до посадки,
 * стабильность после посадки; негативы (карты других банков, картинки на карточках, книги, телефоны, бумага,
 * визитки) → ложные посадки. Полный цикл как в приложении: кадр ×2 → кадр детектора 320 × 240 + фрагмент под
 * проверку «Сбер» → воркер (CardPipeline) → сессия главного потока (CardSession) → машина состояний.
 *
 *   STRESS=1 npx vitest run tests/card/stress.test.ts                 — всё (каталог из CATALOG_PDF, ~1 ч на 2 ядрах)
 *   STRESS=1 SHARD=0/2 …, SHARD=1/2 …                                 — половины (два процесса), итог — STRESS_OUT
 *   STRESS=1 QUICK=1 …                                                 — 14 дизайнов из фикстур, меньше условий
 *   STRESS_PART=pos|neg                                                — только позитивы / негативы
 * Итог: JSON (STRESS_OUT, по умолчанию /tmp/stress-<shard>.json); сводку печатает tests/card/stressReport.ts.
 */
import { describe, it } from 'vitest';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { runBench, type BenchResult, type Scenario } from '../helpers/cardBench';
import { BenchCardSession } from '../helpers/newSession';
import { sceneCorners, rng, type SynthOptions, type Tex } from '../helpers/synthCard';
import { focalFromFov } from '../../src/tracker/card/detector';
import { CATALOG_IDS, NO_LOGO_IDS, catalogAvailable, catalogDesign, loadTex } from '../helpers/catalog';
import { CARD_CM, LIGHTS, TABLES, panoFrames, type Table } from '../helpers/stress';
import { design, OTHER_DESIGNS, NOT_CARDS, NOT_CARD_SHAPE } from '../helpers/cardDesigns';

const on = !!process.env.STRESS;
const QUICK = !!process.env.QUICK;
const NEG_DIR = process.env.NEG_DIR ?? '/tmp/neg';
const [SH, SN] = (process.env.SHARD ?? '0/1').split('/').map(Number);

export interface Cond {
  name: string;
  o: Partial<SynthOptions>;
  /** амплитуда медленного дрейфа телефона, градусы */
  drift?: number;
}

const cm = (x: number) => x / CARD_CM;
export const CONDS: Cond[] = [
  { name: 'обычно (35°, 25 см)', o: {} },
  { name: 'наклон 20°', o: { tilt: 20 } },
  { name: 'наклон 50°', o: { tilt: 50 } },
  { name: 'наклон 65°', o: { tilt: 65 } },
  { name: 'близко 15 см', o: { dist: cm(15) } },
  { name: 'далеко 35 см', o: { dist: cm(35) } },
  { name: 'далеко 45 см', o: { dist: cm(45) } },
  { name: 'поворот 30°', o: { yaw: 30 } },
  { name: 'поворот 90°', o: { yaw: 90 } },
  { name: 'вверх ногами', o: { yaw: 180 } },
  { name: 'блики-пятна', o: { glareSpots: 2 } },
  { name: 'тёплый свет', o: LIGHTS.тёплый },
  { name: 'холодный свет', o: LIGHTS.холодный },
  { name: 'тусклый свет', o: LIGHTS.тусклый },
  { name: 'смаз движения', o: { motion: [5, 2] }, drift: 4 },
  { name: 'шум', o: { noise: 9 } },
  { name: 'палец на углу', o: { fingerCard: { u: 0.04, v: 0.92 } } },
  { name: 'палец на знаке', o: { fingerCard: { u: 0.1, v: 0.16 } } },
];
const QUICK_CONDS = ['обычно (35°, 25 см)', 'наклон 65°', 'далеко 45 см', 'вверх ногами', 'блики-пятна', 'тусклый свет', 'смаз движения', 'палец на знаке'];

/** сцена: карта (или предмет) на столе, телефон в руке — тремор и медленный дрейф; кадр ×2 */
export function stressScenario(name: string, tex: Tex | null, c: Cond, table: Table, seed: number, duration: number, shape?: { aspect: number; radius: number }): Scenario {
  const w = 320, h = 240, K = 2;
  const R = rng(seed * 7919 + 13);
  for (let i = 0; i < 3; i++) R();
  const ph = R() * 6;
  const drift = c.drift ?? 1.5;
  const base: SynthOptions = { tilt: 35, yaw: 0, dist: cm(25), bg: table, noise: 2.5, seed, tableOnPlane: false, tex: tex ?? undefined, shape, ...c.o };
  const rot = (t: number): [number, number, number] => [
    0.15 * Math.sin(t * 47 + ph) + 0.1 * Math.sin(t * 71) + drift * Math.sin(t * 0.9 + ph),
    0.2 * Math.sin(t * 53 + 1) + drift * 1.3 * Math.sin(t * 0.7 + 2 * ph),
    0.4 * drift * Math.sin(t * 0.5 + ph),
  ];
  const frameAt = panoFrames(base, w, h, K, 1.5, rot, seed);
  return {
    name,
    duration,
    verify: true,
    w,
    h,
    focal: focalFromFov(w, h, 63),
    frame: () => null,
    hi: frameAt,
    hiK: K,
    gt: (t) => sceneCorners({ ...base, w, h, camRot: rot(t) }),
    rot,
  };
}

/** визитка: белая/кремовая, строки текста (90 × 50 мм) */
function businessCard(seed: number): Tex {
  const R = rng(seed);
  const w = 300, hh = 167;
  const rgba = new Uint8ClampedArray(w * hh * 4);
  const bg = R() < 0.5 ? [245, 243, 236] : [30, 40, 60];
  const fg = bg[0] > 128 ? [40, 40, 50] : [230, 220, 190];
  const lines = Array.from({ length: 5 }, (_, i) => ({ y: 30 + i * 24 + R() * 6, x0: 20 + R() * 20, x1: 120 + R() * 150, th: i === 0 ? 7 : 3 }));
  for (let y = 0; y < hh; y++)
    for (let x = 0; x < w; x++) {
      let c = bg;
      for (const l of lines) if (Math.abs(y - l.y) < l.th && x > l.x0 && x < l.x1 && (Math.floor(x / 5) + l.th) % 4 !== 0) c = fg;
      const k = (y * w + x) * 4;
      rgba[k] = c[0];
      rgba[k + 1] = c[1];
      rgba[k + 2] = c[2];
      rgba[k + 3] = 255;
    }
  return { rgba, w, h: hh };
}

async function fixtureDesigns(): Promise<{ id: number; tex: Tex }[]> {
  const dir = new URL('../fixtures/cards/designs/', import.meta.url).pathname;
  const out: { id: number; tex: Tex }[] = [];
  for (const f of readdirSync(dir).sort()) {
    const { data, info } = await sharp(dir + f).removeAlpha().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    out.push({ id: +f.replace(/\D/g, ''), tex: { rgba: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), w: info.width, h: info.height } });
  }
  return out;
}

export interface StressRow {
  kind: 'pos' | 'neg';
  item: string;
  group: string;
  cond: string;
  table: string;
  landed: boolean;
  tLock: number;
  verified: boolean;
  design: number;
  locked: number;
  losses: number;
  reanchors: number;
  err: number;
  p90: number;
  workerMs: number;
  workerP95: number;
  stages?: Record<string, number>;
  msBy?: Record<string, { n: number; mean: number; p95: number }>;
  preHit?: number;
  verN?: number;
  sberAt?: number;
  detTop?: number;
  detAny?: number;
}

function row(kind: 'pos' | 'neg', item: string, group: string, cond: string, table: string, r: BenchResult): StressRow {
  return {
    kind, item, group, cond, table,
    landed: r.tLock >= 0, tLock: r.tLock, verified: !!r.verified, design: r.design ?? -1,
    locked: r.locked, losses: r.losses, reanchors: r.reanchors, err: r.err, p90: r.p90, workerMs: r.workerMs ?? NaN, workerP95: r.workerP95 ?? NaN, stages: r.stages, msBy: r.msBy, preHit: r.preHit, verN: r.verN, sberAt: r.sberAt, detTop: r.detTop, detAny: r.detAny,
  };
}

describe.skipIf(!on)('стресс-набор трекера карты', () => {
  it('позитивы и негативы', async () => {
    const rows: StressRow[] = [];
    const part = process.env.STRESS_PART;
    const out = process.env.STRESS_OUT ?? `/tmp/stress-${SH}.json`;
    const save = () => writeFileSync(out, JSON.stringify(rows));
    const only = process.env.CONDS?.split(',');
    const conds = only ? CONDS.filter((_c, i) => only.includes(String(i))) : QUICK ? CONDS.filter((c) => QUICK_CONDS.includes(c.name)) : CONDS;
    let n = 0;
    const mine = () => n++ % SN === SH;
    if (part !== 'neg') {
      const designs = QUICK || !catalogAvailable() ? await fixtureDesigns() : await Promise.all(CATALOG_IDS.map(async (id) => ({ id, tex: await catalogDesign(id) })));
      const step = Number(process.env.DSTEP ?? 1);
      for (const [di, d] of designs.entries())
        for (const [ci, c] of conds.entries()) {
          if (di % step) continue;
          if (!mine()) continue;
          const table = TABLES[(di + ci) % TABLES.length];
          const sc = stressScenario(`${d.id} ${c.name}`, d.tex, c, table, 100 + di * 37 + ci, 5);
          const r = await runBench(sc, () => new BenchCardSession(true), { stopAfterLock: 2 });
          rows.push(row('pos', String(d.id), NO_LOGO_IDS.includes(d.id) ? 'без знака' : 'со знаком', c.name, table, r));
          save();
        }
      save();
    }
    if (part !== 'pos') {
      const negs: { item: string; group: string; tex: Tex; shape?: { aspect: number; radius: number } }[] = [];
      for (const k of OTHER_DESIGNS) for (let s = 1; s <= 3; s++) negs.push({ item: `${k}#${s}`, group: 'карта другого банка', tex: design(k, s) });
      for (const k of NOT_CARDS) for (let s = 1; s <= 2; s++) negs.push({ item: `${k}#${s}`, group: k === 'book' || k === 'notebook' ? 'книга/тетрадь' : k === 'phone' || k === 'screen' || k === 'laptop' ? 'телефон/экран' : 'бумага/коробка', tex: design(k, s), shape: NOT_CARD_SHAPE[k] });
      for (let s = 1; s <= 4; s++) negs.push({ item: `визитка#${s}`, group: 'визитка', tex: businessCard(s), shape: { aspect: 90 / 50, radius: 0.01 } });
      if (existsSync(NEG_DIR)) {
        const files = readdirSync(NEG_DIR).sort();
        const take = QUICK ? 12 : 45;
        for (let i = 0; i < take; i++) {
          const f = files[Math.floor((i * files.length) / take)];
          negs.push({ item: f, group: 'картинка на карте (чужой дизайн)', tex: await loadTex(NEG_DIR + '/' + f) });
        }
      }
      const nc = QUICK ? [CONDS[0], CONDS[2]] : process.env.NEG_CONDS ? process.env.NEG_CONDS.split(',').map((i) => CONDS[+i]) : [CONDS[0], CONDS[2], CONDS[6], CONDS[10], CONDS[13]];
      for (const [ni, ng] of negs.entries())
        for (const [ci, c] of nc.entries()) {
          if (!mine()) continue;
          const table = TABLES[(ni + ci) % TABLES.length];
          const sc = stressScenario(`${ng.item} ${c.name}`, ng.tex, c, table, 9000 + ni * 11 + ci, 7, ng.shape);
          const r = await runBench(sc, () => new BenchCardSession(true), { stopAfterLock: 0.5 });
          rows.push(row('neg', ng.item, ng.group, c.name, table, r));
          save();
        }
      save();
    }
  }, 6 * 3_600_000);
});

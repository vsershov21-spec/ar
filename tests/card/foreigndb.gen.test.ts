/**
 * Отпечатки карт ДРУГИХ банков (src/tracker/card/foreignDb.ts) — из записей, на которых они проходили проверку знака.
 *   FOREIGN_DIR=/путь/к/клипам npx vitest run tests/card/foreigndb.gen.test.ts   — собрать и записать foreignDb.ts
 * Клипы (в репозиторий не кладём, см. docs/qa/CARD_MATRIX.md) — нарезка записей экрана iPhone, `eval.json` с обрезкой
 * камеры как у `card:eval`. Дескриптор берётся с кадров проверки (фрагмент кадра ≥ 90 px, резкий) в окне FOREIGN ниже;
 * запись — «медоид» этих кадров. Порог записи — max(0,62; лучшая похожесть на карты Сбера + 0,1): каталог (сцены
 * стресс-набора) и кадры Сбера из клипов POSITIVE.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cardCorners, warpCard, canonicalPlanes, lastVerdict, CW, CH } from '../../src/tracker/card/verify';
import { describe as describeCard, entryFromDesc, encodeEntry, similarity, newDesc, setForeignDb, type Desc } from '../../src/tracker/card/fingerprint';
import { CATALOG_IDS, catalogAvailable, catalogDesign } from '../helpers/catalog';
import { renderCardScene, rng, type Tex } from '../helpers/synthCard';
import { randomCond } from '../helpers/stress';
import { loadClip } from './eval/clip';
import { replayClip } from './eval/replay';

const DIR = process.env.FOREIGN_DIR ?? '';
const on = !!DIR && existsSync(DIR) && catalogAvailable();

/** id записи → клип и окно (с), где в кадре только эта карта */
const FOREIGN: { id: number; name: string; clip: string; from?: number; to?: number }[] = [
  { id: 1001, name: 'золотая с картой мира (не Сбер), 23.11', clip: 'neg_gold_world', from: 1.0, to: 1.6 },
  { id: 1002, name: 'красная Альфа, 23.11', clip: 'neg_alfa_red_1123', from: 0.5 },
  { id: 1003, name: 'красная Альфа, 20.11', clip: 'neg_alfa_red' },
  { id: 1004, name: 'серая металлическая, 23.11', clip: 'neg_metal_grey' },
];
const POSITIVE = ['sber_old_mir', 'sber_debit_adult', 'sber_black_credit', 'sber_old_pan', 'b_hooligan_play', 'e_glitter_paint'];

async function clipDescs(name: string, from = 0, to = 1e9): Promise<Desc[]> {
  const f = join(DIR, name + '.mp4');
  if (!existsSync(f)) return [];
  const out: Desc[] = [];
  setForeignDb([]); // без старой базы: иначе кадры чужой карты уже помечены
  await replayClip(loadClip(f), {
    workerMs: 45,
    onResult: (i, o) => {
      const t = i / 30;
      const v = lastVerdict();
      if (!o.ver?.checked || !v || t < from || t > to || v.f.px < 90 || v.f.sharp < 0.3) return;
      const { R, G, B } = canonicalPlanes();
      out.push(describeCard(R, G, B, CW, CH, newDesc()));
    },
  });
  setForeignDb(null);
  return out;
}

function sceneDesc(t: Tex, seed: number): Desc {
  const R = rng(seed * 2654435761);
  for (let i = 0; i < 4; i++) R();
  const c = randomCond(R);
  const big = R() < 0.5;
  const f = renderCardScene({ ...c, w: big ? 480 : 320, h: big ? 360 : 240, tex: t, ss: 2, seed, noiseSeed: seed });
  const q = f.corners.map((p) => ({ x: p.x + (R() - 0.5) * 1.4, y: p.y + (R() - 0.5) * 1.4 }));
  warpCard(f, cardCorners(q, { f: f.focal, cx: f.w / 2, cy: f.h / 2 }));
  const { R: r, G, B } = canonicalPlanes();
  return describeCard(r, G, B, CW, CH, newDesc());
}

describe.skipIf(!on)('база отпечатков чужих карт', () => {
  it('сборка и калибровка', async () => {
    const sber: Desc[] = [];
    for (const id of CATALOG_IDS) {
      const t = await catalogDesign(id);
      for (let s = 0; s < 4; s++) sber.push(sceneDesc(t, id * 10 + s + 7));
    }
    for (const p of POSITIVE) sber.push(...(await clipDescs(p)));
    const parts: Int8Array[] = [];
    const names: Record<number, string> = {};
    for (const fr of FOREIGN) {
      const ds = await clipDescs(fr.clip, fr.from, fr.to);
      if (ds.length < 3) continue;
      const best = (d: Desc, e: ReturnType<typeof entryFromDesc>) => Math.max(similarity(d, e, false), similarity(d, e, true));
      let bi = 0, bm = -1;
      ds.forEach((d, i) => {
        const e = entryFromDesc(fr.id, 0.5, d);
        const s = ds.map((q) => best(q, e)).sort((a, b) => a - b);
        if (s[s.length >> 1] > bm) (bm = s[s.length >> 1]), (bi = i);
      });
      const e = entryFromDesc(fr.id, 0.5, ds[bi]);
      const sMax = Math.max(...sber.map((d) => best(d, e)));
      const thr = Math.max(0.62, sMax + 0.1);
      const own = ds.map((d) => best(d, e));
      const recall = own.filter((x) => x >= thr).length / own.length;
      console.log(`${fr.id} ${fr.name}: кадров ${ds.length}, Сбер max ${sMax.toFixed(2)} → порог ${thr.toFixed(2)}, свои ≥ порога ${(recall * 100).toFixed(0)} %`);
      if (thr >= 0.95 || recall < 0.5) continue; // не отличается от Сбера — не берём
      parts.push(encodeEntry(fr.id, thr, ds[bi]));
      names[fr.id] = fr.name;
    }
    expect(parts.length).toBeGreaterThan(0);
    const raw = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0;
    for (const p of parts) raw.set(new Uint8Array(p.buffer), o), (o += p.length);
    const b64 = Buffer.from(raw).toString('base64');
    const lines = b64.match(/.{1,180}/g)!.map((l) => `  '${l}'`).join(' +\n');
    writeFileSync(
      new URL('../../src/tracker/card/foreignDb.ts', import.meta.url),
      `// СГЕНЕРИРОВАНО tests/card/foreigndb.gen.test.ts (FOREIGN_DIR=…) — не править руками.\n` +
        `// Отпечатки карт других банков, которые на записях с iPhone проходили проверку знака Сбера (int8-дескрипторы, не изображения).\n` +
        `export const FOREIGN_DB =\n${lines};\n` +
        `export const FOREIGN_DB_INFO = { n: ${parts.length}, names: ${JSON.stringify(names)} as Record<number, string> };\n`,
    );
  }, 1_800_000);
});

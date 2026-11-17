/**
 * Стенд трекера карты «до / после» (docs/CARD_DETECTION.md, раздел «Стенд»). Тяжёлый — только по запросу:
 *   BENCH=1 npx vitest run tests/card/bench.test.ts            — синтетика
 *   BENCH=1 VIDEO=1 npx vitest run tests/card/bench.test.ts    — + записи с iPhone (нужен ffmpeg и файлы в CARD_VIDEOS)
 * SESS=old|new|both (по умолчанию both). Итог — JSON в BENCH_OUT (по умолчанию /tmp/bench-card.json).
 */
import { describe, it } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { runBench, synthScenarios, videoScenario, type BenchResult, type BenchSession, type Scenario } from '../helpers/cardBench';
import { LegacySession } from '../helpers/legacySession';

const on = !!process.env.BENCH;

async function sessions(): Promise<Record<string, (verify: boolean) => BenchSession>> {
  const out: Record<string, (verify: boolean) => BenchSession> = {};
  const which = process.env.SESS ?? 'both';
  if (which !== 'new') out['до'] = (v) => new LegacySession(v);
  if (which !== 'old') {
    try {
      const { BenchCardSession } = await import('../helpers/newSession');
      out['после'] = (v) => new BenchCardSession(v);
    } catch {
      /* новой сессии ещё нет */
    }
  }
  return out;
}

const fmt = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—');

describe.skipIf(!on)('стенд трекера карты', () => {
  it('синтетика и записи', async () => {
    const scs: Scenario[] = synthScenarios();
    const only = process.env.ONLY;
    if (process.env.VIDEO) {
      const vids = (process.env.CARD_VIDEOS ?? '/home/claude/cardsamples/rec_a.mp4:0:70,/home/claude/cardsamples/rec_b.mp4:0:70').split(',');
      for (const v of vids) {
        const [f, from, dur] = v.split(':');
        if (existsSync(f)) scs.push(await videoScenario(f.split('/').pop()! + ` ${from}–${+from + +dur} с`, f, +from, +dur));
      }
    }
    const ss = await sessions();
    const res: BenchResult[] = [];
    for (const sc of scs) {
      if (only && !sc.name.includes(only)) continue;
      for (const [name, mk] of Object.entries(ss)) {
        const r = await runBench(sc, () => mk(sc.verify));
        r.session = name;
        res.push(r);
        console.log(
          `${sc.name.padEnd(28)} ${name.padEnd(6)} tLock ${fmt(r.tLock)}с  locked ${fmt(100 * r.locked, 0)}%  falseLoss ${r.falseLoss}  losses ${r.losses}  reanchor ${r.reanchors}  ` +
            `jitter ${fmt(r.jitter)}px  err ${fmt(r.err)}px  p90 ${fmt(r.p90)}px  jIdx ${fmt(r.jitterIdx)}px  ${JSON.stringify(r.states)}`,
        );
      }
    }
    writeFileSync(process.env.BENCH_OUT ?? '/tmp/bench-card.json', JSON.stringify(res, null, 1));
  }, 3_600_000);
});

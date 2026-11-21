#!/usr/bin/env node
// Сравнение двух прогонов стенда по сценариям второго (частичный прогон --only): пик ω (любой кадр), щелчок на стыке,
// скольжение лап, проникновение (мм / % кадров > 1 мм), тело ниже опоры, лёжа в опоре, дрожь покоя p95.
//   node scripts/qa/anim-audit/compare.mjs before p1           (сначала audit-report.mjs для обоих тегов)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.ANIM_AUDIT_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../bench-out/anim-audit');
const [A, B] = process.argv.slice(2);
const sum = (t) => JSON.parse(fs.readFileSync(`${BASE}/summary_${t}.json`, 'utf8'));
const raw = (t) => JSON.parse(fs.readFileSync(`${BASE}/raw/${t}.json`, 'utf8'));
const LIE = /sleep|bed|lie_/;
const q = (a, p) => (a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0);
function metrics(t) {
  const S = sum(t), R = raw(t), out = {};
  for (const o of S) {
    const r = R.cats.find((c) => c.cat === o.cat)?.results.find((x) => x.id === o.id);
    const fr = r ? r.frames.filter((f) => !f.mark) : [];
    const top = fr.reduce((m, f) => (f.w > m.w ? f : m), { w: 0 });
    const lie = fr.filter((f) => f.vis && LIE.test(f.clip));
    const idle = fr.filter((f) => f.idle && !f.sw && f.t > 800 && f.jit !== undefined).map((f) => f.jit);
    out[`${o.cat}/${o.id}`] = {
      W: +top.w.toFixed(1), Wat: top.w ? `${top.wb}@${top.clip}/${top.t}` : '', pop: o.pop, slide: o.slide, pen: o.penMM, penPct: o.penPct, pair: o.penPair,
      floor: o.floor.gbody ?? 0, lie: lie.length ? Math.min(...lie.map((f) => f.gbody ?? 0)) : null, jit95: idle.length > 20 ? q(idle, 0.95) : null, end: o.endClip,
    };
  }
  return out;
}
const a = metrics(A), b = metrics(B);
const f = (x) => (x === null || x === undefined ? '—' : x);
console.log(`| сценарий | ω пик ${A} → ${B} | щелчок | лапы мм | проникн. мм (% > 1) | пол / лёжа мм | дрожь p95 ° |`);
console.log('|---|---|---|---|---|---|---|');
for (const k of Object.keys(b)) {
  const x = a[k] ?? {}, y = b[k];
  console.log(`| ${k} | ${f(x.W)} → **${y.W}** (${y.Wat}) | ${f(x.pop)} → ${y.pop} | ${f(x.slide)} → ${y.slide} | ${f(x.pen)} (${f(x.penPct)}) → ${y.pen} (${y.penPct}) ${y.pen > 1 ? y.pair : ''} | ${f(x.floor)} / ${f(x.lie)} → ${y.floor} / ${f(y.lie)} | ${f(x.jit95)} → ${f(y.jit95)} |`);
}

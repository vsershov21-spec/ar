#!/usr/bin/env node
// Сводка стенда реакций по пунктам «пол / скейт / зеркальце / какао» (20.11): до → после.
//   node scripts/qa/ground-props.mjs before after   — bench-out/reactions/<tag>.json → docs/qa/GROUND_PROPS.md (таблица)
// Метрики (scripts/qa/reactions-probe.js):
//   gbody — самая низкая точка тела без ног (капсулы касаний GLB: голова, корпус, лапы), мм над опорой; < 0 — в карте/столе;
//   gmin  — то же по объёмам ground clamp (прокси одежды + кисти/стопы) после подъёма (только «после»);
//   lift  — подъём корня ground clamp, мм; propMM — от точки хвата предмета до кисти, мм (держит — единицы мм).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [A = 'before', B = 'after'] = process.argv.slice(2);
const load = (t) => JSON.parse(fs.readFileSync(path.join(root, 'bench-out/reactions', `${t}.json`), 'utf8'));
const a = load(A), b = load(B);
const LABEL = { act_flip: 'Сальто', paint: 'Раскраска', sig_skate: 'Скейт', sig_cocoa: 'Какао', sig_mirror: 'Зеркальце', act_treat: 'Угостить (рыбка)' };
const INTENDED = /dive|appear|goodbye|run_home|sink|sleep|bed|lie_|fall_off/;
const med = (x) => (x.length ? [...x].sort((p, q) => p - q)[Math.floor(x.length / 2)] : null);

function stats(r) {
  const fr = r.frames.filter((f) => !f.mark && f.vis && !INTENDED.test(f.clip));
  const gb = fr.map((f) => f.gbody ?? 0);
  const below = gb.filter((v) => v < -1).length;
  const gm = fr.filter((f) => f.gmin !== undefined && f.gpart).map((f) => f.gmin);
  const lift = Math.max(0, ...fr.map((f) => (f.lift ?? 0) * (r.catMM ?? 94)));
  const prop = fr.filter((f) => f.propMM >= 0 && /:(raise|use|lower)$/.test(f.act ?? '')).map((f) => f.propMM);
  return {
    gbody: gb.length ? Math.min(...gb) : null,
    below: gb.length ? Math.round((below / gb.length) * 100) : 0,
    gmin: gm.length ? Math.min(...gm) : null,
    lift,
    prop: med(prop),
    acts: [...new Set(fr.map((f) => f.act).filter(Boolean))].length,
  };
}
const fmt = (v, d = 1) => (v === null || v === undefined ? '—' : (+v).toFixed(d));
const rows = [];
for (const cb of b.cats) {
  const ca = a.cats.find((c) => c.cat === cb.cat);
  for (const rb of cb.results) {
    const ra = ca?.results.find((r) => r.id === rb.id);
    const sa = ra ? stats(ra) : null, sb = stats(rb);
    rows.push(`| ${cb.cat} | ${LABEL[rb.id] ?? rb.id} | ${fmt(sa?.gbody)} (${sa?.below ?? '—'} %) | ${fmt(sb.gbody)} (${sb.below} %) | ${fmt(sb.gmin)} | ${fmt(sb.lift)} | ${fmt(sb.prop)} | ${ra ? `[до](ground_props/before/${cb.cat}_${rb.id}.png) · ` : ''}[после](ground_props/after/${cb.cat}_${rb.id}.png) |`);
  }
}
const md = `# Пол, скейт, зеркальце, какао — стенд до/после (20.11)

Стенд реакций (\`node scripts/qa/reactions.mjs --zoom --only sig_skate,sig_cocoa,sig_mirror,act_treat,paint,act_flip\`),
сводка — \`node scripts/qa/ground-props.mjs ${A} ${B}\`. Пилот, коты v2, без клипов Meshy (на сервере; локально — опоры).
«До» — origin/main 09e83a9 тем же стендом; «после» — ветка оркестратора.

- **gbody** — самая низкая точка тела без ног (голова, корпус, лапы — капсулы касаний), мм на карте над опорой; в скобках —
  доля кадров ниже −1 мм (в карте/столе). Меряется одинаково в обеих сборках.
- **gmin** — то же по объёмам ground clamp (прокси одежды и головы + кисти и стопы) после подъёма; < 0 — проникновение.
- **lift** — наибольший подъём корня ground clamp, мм. **хват** — медиана расстояния точки хвата предмета до кости кисти, мм
  (фазы «поднёс / пользуется / опускает»).

| кот | действие | gbody до | gbody после | gmin после | lift | хват, мм | листы |
|---|---|---|---|---|---|---|---|
${rows.join('\n')}
${fs.existsSync(path.join(root, 'docs/qa/GROUND_PROPS.notes.md')) ? '\n' + fs.readFileSync(path.join(root, 'docs/qa/GROUND_PROPS.notes.md'), 'utf8') : ''}`;
fs.writeFileSync(path.join(root, 'docs/qa/GROUND_PROPS.md'), md);
console.log(md);

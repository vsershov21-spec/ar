#!/usr/bin/env node
// Ноги и лицо по сырым замерам аудита (audit.mjs + audit-probe.js, поля st/hw/kA/kF/kO/fv/fj и fPre/emoS/lid/spiral):
// «ноги как желе» (23.11) — ширина стойки к ширине таза, сгиб и направление колена, скорость и дрожь стоп в покое и в
// реакциях; «глаза залипают» — сколько держатся полуприкрытые веки, спирали и хмурость после конца действия.
//
//   node scripts/qa/anim-audit/legs.mjs <tag> [<tagДо>] [--md FILE]   — таблица кот × сценарий (до → после)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const tags = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
const BASE = path.resolve(root, arg('--out', 'bench-out/anim-audit'));
const load = (t) => JSON.parse(fs.readFileSync(path.join(BASE, 'raw', `${t}.json`), 'utf8'));
/** в воздухе / лёжа / ходьба: стопы не опора */
const AIR = /jump|flip|tumble|celebrate|appear|dive|skate|bed|sleep|lie_|walk|run|sit_|fall/;
const pct = (a, p) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
};
const r1 = (v) => +v.toFixed(1);

/** метрики сценария; rest — только кадры покоя (idle*, без действия) */
export function legStats(res) {
  const fr = res.frames.filter((f) => f.st !== undefined && f.vis !== 0);
  const ground = fr.filter((f) => !AIR.test(f.clip) && !f.walk && !(f.lift > 0.005));
  const rest = ground.filter((f) => /^idle/.test(f.clip) && !f.act);
  const S = (frames) => {
    if (!frames.length) return null;
    const ratio = frames.map((f) => f.st / Math.max(1, f.hw));
    const fv = frames.flatMap((f) => f.fv);
    const fj = frames.flatMap((f) => f.fj);
    const kF = frames.flatMap((f) => f.kF);
    const kO = frames.flatMap((f) => f.kO);
    const kA = frames.flatMap((f) => f.kA);
    // «резиновость»: сгиб колена меняется туда-сюда — сумма модулей второй разности угла, °/кадр
    let wob = 0;
    for (let i = 2; i < frames.length; i++) for (let s = 0; s < 2; s++) wob = Math.max(wob, Math.abs(frames[i].kA[s] - 2 * frames[i - 1].kA[s] + frames[i - 2].kA[s]));
    return {
      n: frames.length,
      stMax: r1(Math.max(...ratio)),
      stAvg: r1(ratio.reduce((a, b) => a + b, 0) / ratio.length),
      kBack: r1(Math.min(0, ...kF)),
      kOut: r1(Math.max(...kO)),
      kAmax: r1(Math.max(...kA)),
      fv95: r1(pct(fv, 0.95)),
      fvMax: r1(Math.max(...fv)),
      fj95: +pct(fj, 0.95).toFixed(2),
      fjMax: +Math.max(...fj).toFixed(2),
      wob: r1(wob),
    };
  };
  return { all: S(ground), rest: S(rest) };
}

/** лицо: после конца сценарного действия (последние 40 % записи) — доля кадров с прикрытыми веками/спиралью/хмуростью */
export function faceStats(res) {
  const fr = res.frames.filter((f) => f.lid !== undefined);
  if (!fr.length) return null;
  const tail = fr.slice(Math.floor(fr.length * 0.6));
  const share = (k, th) => r1((100 * tail.filter((f) => f[k] > th).length) / tail.length);
  // моргание: самое долгое окно без моргания (blink > 0.5), с
  let gap = 0, cur = 0;
  for (const f of fr) {
    cur = f.blink > 0.5 ? 0 : cur + 1 / 30;
    gap = Math.max(gap, cur);
  }
  return { lid: share('lid', 0.45), spiral: share('spiral', 0.3), frown: share('frown', 0.35), noBlink: r1(gap), pre: [...new Set(tail.map((f) => f.fPre))].join('/') };
}

function main() {
  const [tag, before] = tags;
  const A = load(tag), B = before ? load(before) : null;
  const lines = [`# Ноги и лицо: ${tag}${before ? ` (до: ${before})` : ''}`, '', 'st — стопы/таз (ширина стойки, × ширины таза), kBack — колено назад от линии бедро→стопа (мм, < 0 — обратный сгиб), kOut — колено наружу (мм), fv95 — скорость стопы p95 (мм/с), fj — дрожь стопы p95/max (мм), wob — «резина»: вторая разность угла колена (°/кадр). Покой — кадры idle* без действия.', ''];
  lines.push('| кот | сценарий | st покой ср/макс | st макс | kBack | kOut | fv95 покой | fv95 | fj p95/max | wob | лицо: веки/спираль/хмурь % хвоста, без моргания с |', '|---|---|---|---|---|---|---|---|---|---|---|');
  const cell = (a, b, k, fmt = (v) => v) => {
    const va = a?.[k], vb = b?.[k];
    if (va === undefined) return '—';
    return vb === undefined ? `${fmt(va)}` : `${fmt(vb)} → ${fmt(va)}`;
  };
  for (const c of A.cats) {
    const cb = B?.cats.find((x) => x.cat === c.cat);
    for (const r of c.results) {
      const rb = cb?.results.find((x) => x.id === r.id);
      const s = legStats(r), sb = rb ? legStats(rb) : null;
      const f = faceStats(r), fb = rb ? faceStats(rb) : null;
      const fs_ = (x) => (x ? `${x.lid}/${x.spiral}/${x.frown}, ${x.noBlink}` : '—');
      lines.push(`| ${c.cat} | ${r.id} | ${s.rest ? cell(s.rest, sb?.rest, 'stAvg') + ' / ' + cell(s.rest, sb?.rest, 'stMax') : '—'} | ${cell(s.all, sb?.all, 'stMax')} | ${cell(s.all, sb?.all, 'kBack')} | ${cell(s.all, sb?.all, 'kOut')} | ${cell(s.rest, sb?.rest, 'fv95')} | ${cell(s.all, sb?.all, 'fv95')} | ${cell(s.all, sb?.all, 'fj95')}/${cell(s.all, sb?.all, 'fjMax')} | ${cell(s.all, sb?.all, 'wob')} | ${fb ? fs_(fb) + ' → ' : ''}${fs_(f)} |`);
    }
  }
  const out = lines.join('\n') + '\n';
  const md = arg('--md', '');
  if (md) fs.writeFileSync(path.resolve(root, md), out);
  console.log(out);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();

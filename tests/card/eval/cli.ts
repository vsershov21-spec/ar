/**
 * `npm run card:eval -- [пути…] [флаги]` — записи → цифры (docs/qa/CARD_MATRIX.md, docs/CARD_DETECTION.md «Стенд записей»).
 *
 *   пути            видео или папки (по умолчанию /srv/ar-extra/card-rec); сайдкары — tests/card/eval/clip.ts
 *   --synth         добавить синтетические клипы с истинными углами (приближение, наклон, облёт, встряска, всё сразу)
 *   --baseline F    сравнить с прошлым JSON: хуже допуска — код выхода 1 (регрессия)
 *   --tol 0.15      допуск относительно базы (доля) + абсолютные зазоры по метрикам (GATES)
 *   --save-baseline F  записать итог как новую базу
 *   --out DIR       куда отчёт (по умолчанию docs/qa/card-eval): <дата>.md и <дата>.json
 *   --name S        имя отчёта вместо даты
 *   --phonek 2.5    мс ноутбука → мс телефона; --worker-ms N — постоянное время воркера (детерминированно)
 *   --camlat 33     задержка камеры, с которой начинает трекер; --camlat-fixed — не уточнять
 *   --no-oracle     без эталона-оракула (быстрее вдвое, без ошибок положения)
 *   --from S --to S кусок записи (для всех путей)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listVideos, loadClip } from './clip';
import { oracleQuads, replayClip, type ClipMetrics, type EvalClip } from './replay';
import { MOTIONS, synthClip } from './synthClip';
import { design } from '../../helpers/cardDesigns';

export const DEFAULT_DIR = '/srv/ar-extra/card-rec';

/** метрики регрессии: [путь, больше — хуже?, абсолютный зазор] */
export const GATES: [string, boolean, number][] = [
  ['timeToLand', true, 0.3],
  ['falseLandings', true, 0],
  ['wrongPlace', true, 0],
  ['visibleLosses', true, 0],
  ['errMm.p90', true, 1],
  ['jitterMm', true, 0.5],
  ['scaleErr.p90', true, 1],
  ['headMm.p90', true, 1],
  ['upsideFrac', true, 0.01],
  ['normalFlips', true, 1],
  ['lockedFrac', false, 0.03],
  ['cpu.mean', true, 2],
];

const get = (o: unknown, p: string): number => p.split('.').reduce((a: unknown, k) => (a as Record<string, unknown>)?.[k], o) as number;

export function compare(cur: ClipMetrics[], base: ClipMetrics[], tol: number): string[] {
  const bad: string[] = [];
  for (const c of cur) {
    const b = base.find((x) => x.clip === c.clip);
    if (!b) continue;
    for (const [p, higherWorse, abs] of GATES) {
      const x = get(c, p), y = get(b, p);
      if (!Number.isFinite(y)) continue;
      if (!Number.isFinite(x)) {
        // посадка/метрика пропала совсем (кот не сел) — регрессия
        if (p === 'timeToLand' || p.startsWith('errMm')) bad.push(`${c.clip}: ${p} — было ${fmt(y)}, стало «нет»`);
        continue;
      }
      const lim = higherWorse ? y * (1 + tol) + abs : y * (1 - tol) - abs;
      if (higherWorse ? x > lim : x < lim) bad.push(`${c.clip}: ${p} ${fmt(x)} хуже базы ${fmt(y)} (допуск ${fmt(lim)})`);
    }
  }
  return bad;
}

const fmt = (x: number, d = 2) => (Number.isFinite(x) ? (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(d)) : '—');

function parse(argv: string[]) {
  const o: Record<string, string | boolean> = {};
  const paths: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (['synth', 'no-oracle', 'camlat-fixed'].includes(k)) o[k] = true;
      else (o[k] = v ?? ''), i++;
    } else paths.push(a);
  }
  return { o, paths };
}

export function synthSet(): EvalClip[] {
  const tex = design('sber-green');
  return Object.entries(MOTIONS).map(([name, m]) => synthClip({ name: 'synth_' + name, ...m, tex }));
}

/** строка сводной таблицы */
function row(m: ClipMetrics): string {
  const rec = m.recovery.length ? fmt(Math.max(...m.recovery), 1) : '—';
  return `| ${m.clip} | ${m.ref} | ${fmt(m.timeToLand)} | ${m.landings} / ${m.falseLandings} | ${m.losses} / ${m.visibleLosses} (${rec}) | ${m.wrongPlace} | ${(m.lockedFrac * 100).toFixed(0)} % | ${fmt(m.errMm.p50, 1)} / ${fmt(m.errMm.p90, 1)} | ${Number.isFinite(m.within5mm) ? (m.within5mm * 100).toFixed(0) + ' %' : '—'} | ${fmt(m.jitterMm)} / ${fmt(m.jitterPx)} | ${fmt(m.scaleErr.p90, 1)} | ${fmt(m.headMm.p90, 1)} | ${((m.upsideFrac ?? 0) * 100).toFixed(1)} % / ${m.normalFlips ?? 0} | ${fmt(m.cpu.mean, 1)} / ${fmt(m.cpu.p95, 1)} | ${fmt(m.focalEnd, 0)} · ${fmt(m.camLatEnd, 0)} |`;
}

export function report(all: ClipMetrics[], opts: { title: string; args: string; regress?: string[]; baseline?: string }): string {
  const L: string[] = [];
  L.push(`# Карта: оценка по записям — ${opts.title}`, '');
  L.push(`Команда: \`npm run card:eval -- ${opts.args}\`. Как читать — docs/CARD_DETECTION.md («Стенд записей»), матрица съёмки — docs/qa/CARD_MATRIX.md.`, '');
  L.push('Эталон: `gt` — разметка/синтетика (абсолютные ошибки), `oracle` — тот же трекер на каждом кадре без задержки (видно отставание и дрожание кота, а не общие ошибки ведения). Мм — на плоскости карты; кадр детектора 320 px по длинной стороне.', '');
  L.push('| клип | эталон | посадка, с | посадок / ложных | уходов из ведения / видимых потерь (макс. восстановление, с) | «не туда» | в ведении | ошибка, мм p50 / p90 | в ±5 мм | дрожание, мм / px | масштаб p90, % | «голова» p90, мм | вверх ногами / переворотов | воркер, мс сред. / p95 | фокус px · задержка мс |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const m of all) L.push(row(m));
  L.push('');
  const pos = all.filter((m) => !m.negative);
  const lands = pos.map((m) => m.timeToLand).filter(Number.isFinite).sort((a, b) => a - b);
  const p90 = lands.length ? lands[Math.min(lands.length - 1, Math.floor(lands.length * 0.9))] : NaN;
  const fl = all.reduce((s, m) => s + m.falseLandings, 0);
  const minutes = all.reduce((s, m) => s + m.duration, 0) / 60;
  const vl = all.reduce((s, m) => s + m.visibleLosses, 0);
  const rec = all.flatMap((m) => m.recovery);
  L.push('## Критерии этапа «Карта»', '');
  L.push('| критерий | цель | сейчас |', '|---|---|---|');
  L.push(`| посадка p90 после входа карты в кадр | ≤ 3 с | ${fmt(p90)} с (${lands.length} из ${pos.length} клипов сели) |`);
  L.push(`| ложные посадки (негативы и «не туда») | 0 | ${fl} |`);
  const in5 = pos.map((m) => m.within5mm).filter(Number.isFinite);
  L.push(`| кот на карте в ±5 мм (доля кадров) | ~100 % | ${in5.length ? ((in5.reduce((a, b) => a + b, 0) / in5.length) * 100).toFixed(0) + ' %' : '—'} (среднее по клипам) |`);
  L.push(`| потерь на 5 мин игры | ≤ 1 | ${minutes > 0 ? ((vl / minutes) * 5).toFixed(1) : '—'} (${vl} за ${minutes.toFixed(1)} мин) |`);
  L.push(`| восстановление | ≤ 1,5 с | ${rec.length ? 'макс. ' + fmt(Math.max(...rec), 1) + ' с' : '—'} |`);
  L.push(`| пересадка «не туда» | 0 | ${all.reduce((s, m) => s + m.wrongPlace, 0)} |`);
  L.push(`| 10 мин без троттлинга при ≥ 30 к/с | — | стенд не меряет; время воркера на кадр — в таблице (×phoneK на телефоне) |`, '');
  if (opts.baseline) {
    L.push(`## Сравнение с базой (${opts.baseline})`, '');
    L.push(opts.regress?.length ? opts.regress.map((x) => '- ❌ ' + x).join('\n') : '- регрессий нет', '');
  }
  L.push('## Журнал (последние переходы) по клипам', '');
  for (const m of all) L.push(`<details><summary>${m.clip}</summary>\n\n\`\`\`\n${m.log.join('\n')}\n\`\`\`\n</details>\n`);
  return L.join('\n');
}

export async function main(argv: string[]): Promise<number> {
  const { o, paths } = parse(argv);
  const inputs = paths.length ? paths : existsSync(DEFAULT_DIR) ? [DEFAULT_DIR] : [];
  const over: Record<string, number> = {};
  if (o.from) over.from = Number(o.from);
  if (o.to) over.to = Number(o.to);
  const clips: EvalClip[] = listVideos(inputs).map((f) => loadClip(f, over));
  if (o.synth) clips.push(...synthSet());
  if (!clips.length) {
    console.error(`нет записей: укажите видео/папку (по умолчанию ${DEFAULT_DIR}) или --synth`);
    return 2;
  }
  const camLatMs = o.camlat ? Number(o.camlat) : 33;
  const all: ClipMetrics[] = [];
  for (const c of clips) {
    const t0 = Date.now();
    const oracle = !c.gt && !o['no-oracle'] ? await oracleQuads(c, camLatMs) : null;
    const m = await replayClip(c, { oracle, camLatMs, fixedLat: !!o['camlat-fixed'], phoneK: o.phonek ? Number(o.phonek) : undefined, workerMs: o['worker-ms'] ? Number(o['worker-ms']) : c.name.startsWith('synth_') ? 45 : undefined });
    all.push(m);
    console.log(`${c.name}: посадка ${fmt(m.timeToLand)} с · ложных ${m.falseLandings} · потерь ${m.visibleLosses} · ошибка p90 ${fmt(m.errMm.p90, 1)} мм · дрожание ${fmt(m.jitterMm)} мм · масштаб p90 ${fmt(m.scaleErr.p90, 1)} % · воркер ${fmt(m.cpu.mean, 1)} мс (${((Date.now() - t0) / 1000).toFixed(0)} с)`);
  }
  const tol = o.tol ? Number(o.tol) : 0.15;
  let regress: string[] | undefined;
  if (typeof o.baseline === 'string') {
    const base = JSON.parse(readFileSync(o.baseline, 'utf8')) as { clips: ClipMetrics[] };
    regress = compare(all, base.clips, tol);
  }
  const date = new Date().toISOString().slice(0, 10);
  const name = typeof o.name === 'string' ? o.name : date;
  const out = typeof o.out === 'string' ? o.out : 'docs/qa/card-eval';
  mkdirSync(out, { recursive: true });
  const json = { date, args: argv.join(' '), clips: all };
  writeFileSync(join(out, name + '.json'), JSON.stringify(json, null, 1));
  writeFileSync(join(out, name + '.md'), report(all, { title: name, args: argv.join(' '), regress, baseline: typeof o.baseline === 'string' ? o.baseline : undefined }));
  if (typeof o['save-baseline'] === 'string') writeFileSync(o['save-baseline'], JSON.stringify(json, null, 1));
  console.log(`отчёт: ${join(out, name + '.md')}`);
  if (regress?.length) {
    console.error('РЕГРЕССИЯ:\n' + regress.join('\n'));
    return 1;
  }
  return 0;
}

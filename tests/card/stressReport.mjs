// Сводка стресс-набора (tests/card/stress.test.ts) в markdown: node tests/card/stressReport.mjs /tmp/stress-*.json
import { readFileSync } from 'node:fs';

const rows = process.argv.slice(2).flatMap((f) => JSON.parse(readFileSync(f, 'utf8')));
const pos = rows.filter((r) => r.kind === 'pos');
const neg = rows.filter((r) => r.kind === 'neg');
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(0) + ' %' : '—');
const med = (v) => {
  const s = v.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
};
const p90 = (v) => {
  const s = v.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length * 0.9)] : NaN;
};
const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d).replace('.', ',') : '—');
const group = (arr, key) => {
  const m = new Map();
  for (const r of arr) {
    const k = key(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
};

function posTable(title, key) {
  const out = [`| ${title} | посадок | по знаку/дизайну | время до посадки, с (медиана / p90) | в ведении после посадки | ошибка, px (сред.) | потерь / пересадок |`, '|---|---|---|---|---|---|---|'];
  for (const [k, v] of group(pos, key)) {
    const l = v.filter((r) => r.landed);
    out.push(`| ${k} | ${pct(l.length, v.length)} (${l.length}/${v.length}) | ${pct(l.filter((r) => r.verified).length, l.length)} | ${f(med(l.map((r) => r.tLock)), 2)} / ${f(p90(l.map((r) => r.tLock)), 2)} | ${pct(l.reduce((s, r) => s + r.locked, 0), l.length)} | ${f(med(l.map((r) => r.err)))} | ${l.reduce((s, r) => s + r.losses, 0)} / ${l.reduce((s, r) => s + r.reanchors, 0)} |`);
  }
  return out.join('\n');
}

const lines = [];
if (pos.length) {
  const l = pos.filter((r) => r.landed);
  lines.push(`Позитивы: ${pos.length} прогонов (${new Set(pos.map((r) => r.item)).size} дизайнов × ${new Set(pos.map((r) => r.cond)).size} условий), посадок ${pct(l.length, pos.length)}, по знаку/дизайну ${pct(l.filter((r) => r.verified).length, l.length)}, медиана времени ${f(med(l.map((r) => r.tLock)), 2)} с.`);
  lines.push('', posTable('условие', (r) => r.cond), '', posTable('стол', (r) => r.table), '', posTable('дизайн', (r) => r.group));
  const bad = [...group(pos, (r) => r.item)].map(([k, v]) => [k, v.filter((r) => !r.landed).map((r) => r.cond)]).filter(([, v]) => v.length >= Math.ceil(0.6 * new Set(pos.map((r) => r.cond)).size));
  if (bad.length) lines.push('', 'Дизайны, где кот не сел в ≥ 60 % условий: ' + bad.map(([k, v]) => `${k} (${v.length})`).join(', '));
}
if (neg.length) {
  lines.push('', '| негатив | прогонов | ложных посадок | из них «по форме» | «Сбер» по знаку/дизайну |', '|---|---|---|---|---|');
  for (const [k, v] of group(neg, (r) => r.group)) {
    const l = v.filter((r) => r.landed);
    lines.push(`| ${k} | ${v.length} | ${l.length} | ${l.filter((r) => !r.verified).length} | ${l.filter((r) => r.verified).length} |`);
  }
  const fl = neg.filter((r) => r.landed);
  if (fl.length) lines.push('', 'Ложные посадки: ' + fl.map((r) => `${r.item} / ${r.cond} / ${r.table}${r.verified ? ' (Сбер' + (r.design >= 0 ? ' #' + r.design : '') + ')' : ' (по форме)'}`).join('; '));
}
const ms = rows.map((r) => r.workerMs).filter(Number.isFinite);
const stg = {};
for (const r of rows) for (const [k, v] of Object.entries(r.stages ?? {})) (stg[k] ??= []).push(v);
const by = {};
for (const r of rows) for (const [k, v] of Object.entries(r.msBy ?? {})) (by[k] ??= []).push(v);
if (Object.keys(stg).length) {
  lines.push('', '| этап воркера | среднее на кадр, мс (медиана по прогонам) |', '|---|---|');
  const names = { pre: 'серый кадр + пирамида', key: 'ключевой кадр (после посадки)', flow: 'поток / поверхность', detect: 'полный поиск (края, отрезки, четырёхугольники)', verify: 'проверка «Сбер» (выпрямление, чип, знак, отпечаток)', other: 'прочее (блик, яркость)' };
  for (const [k, v] of Object.entries(stg)) lines.push(`| ${names[k] ?? k} | ${f(med(v), 2)} |`);
  for (const [k, v] of Object.entries(by)) lines.push(`| всего, ${k === 'locked' ? 'после посадки' : 'до посадки'} | среднее ${f(med(v.map((x) => x.mean)))}, p95 ${f(med(v.map((x) => x.p95)))} |`);
}
lines.push('', `Время воркера на кадр (ноутбук, Node): медиана ${f(med(ms))} мс, p90 ${f(p90(ms))} мс, худший прогон p95 ${f(Math.max(...rows.map((r) => r.workerP95).filter(Number.isFinite)))} мс.`);
console.log(lines.join('\n'));

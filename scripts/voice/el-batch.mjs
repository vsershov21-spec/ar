#!/usr/bin/env node
// Пакет для озвучки ElevenLabs: voice-src/el_batch_all.jsonl — всё, что ещё не озвучено или изменилось.
//
//   node scripts/voice/el-batch.mjs            — собрать пакет (без сети), обновить сводку в docs/VOICE.md
//   node scripts/voice/el-batch.mjs --all      — в пакет всё, без учёта уже озвученного
//   node scripts/voice/el-batch.mjs --check    — только проверить, что пакет свежий (код 1, если нет)
//
// «Уже озвучено» — voice-src/el_voiced_base.tsv (id и текст с пометкой, как ушёл в API первым прогоном — 150 реплик).
// Задание попадает в пакет, если его id там нет или текст отличается. Раннер (eleven.mjs --batch) дополнительно
// пропускает всё, что уже лежит на сервере с тем же хэшем, так что лишний запуск ничего не тратит.
// Строка пакета: { id, kind: line|part|slot, persona, voice_id, model_id, text (в API), plain (для фонем), t (субтитр),
//   out (файл относительно папки озвучки), h (хэш), chars, [line, slot, part, lead, tpl, parts, v, event, emotion] }.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildJobs } from './el-common.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const OUT = path.join(root, 'voice-src/el_batch_all.jsonl');
const BASE = path.join(root, 'voice-src/el_voiced_base.tsv');

const base = new Map();
if (fs.existsSync(BASE))
  for (const row of fs.readFileSync(BASE, 'utf8').split('\n')) {
    const [id, text] = row.split('\t');
    if (id && text) base.set(id, text);
  }

const jobs = buildJobs(root);
const todo = flag('--all') ? jobs : jobs.filter((j) => base.get(j.id) !== j.text);
const body = todo.map((j) => JSON.stringify(j)).join('\n') + '\n';

if (flag('--check')) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (cur !== body) {
    console.error('el_batch_all.jsonl устарел: node scripts/voice/el-batch.mjs');
    process.exit(1);
  }
  console.log('el_batch_all.jsonl свежий');
  process.exit(0);
}
fs.writeFileSync(OUT, body);

// сводка
const sum = (list) => list.reduce((a, j) => a + j.chars, 0);
const personas = [...new Set(jobs.map((j) => j.persona))];
const kinds = { line: 'реплики', part: 'куски со слотом', slot: 'имена и ответы' };
const unchanged = jobs.filter((j) => base.get(j.id) === j.text).length;
const changedVoiced = jobs.filter((j) => base.has(j.id) && base.get(j.id) !== j.text).length;
const rows = personas.map((p) => {
  const t = todo.filter((j) => j.persona === p);
  return `| ${p} | ${t.length} | ${sum(t).toLocaleString('ru-RU')} | ${Object.keys(kinds).map((k) => `${t.filter((j) => j.kind === k).length}/${sum(t.filter((j) => j.kind === k)).toLocaleString('ru-RU')}`).join(' · ')} |`;
});
const md = [
  '<!-- el-batch:start (пишет node scripts/voice/el-batch.mjs) -->',
  `Пакет \`voice-src/el_batch_all.jsonl\`: **${todo.length} заданий, ${sum(todo).toLocaleString('ru-RU')} символов** (с пометками интонации, как считает ElevenLabs).`,
  `Уже озвучено и не менялось: ${unchanged}; из первого прогона перепишется (текст поменялся): ${changedVoiced}.`,
  '',
  '| Характер | Заданий | Символов | реплики · куски со слотом · имена и ответы (шт./симв.) |',
  '|---|---|---|---|',
  ...rows,
  `| **всего** | **${todo.length}** | **${sum(todo).toLocaleString('ru-RU')}** | ${Object.keys(kinds).map((k) => `${todo.filter((j) => j.kind === k).length}/${sum(todo.filter((j) => j.kind === k)).toLocaleString('ru-RU')}`).join(' · ')} |`,
  '<!-- el-batch:end -->',
].join('\n');
const vp = path.join(root, 'docs/VOICE.md');
const doc = fs.readFileSync(vp, 'utf8');
const re = /<!-- el-batch:start[\s\S]*?<!-- el-batch:end -->/;
if (re.test(doc)) fs.writeFileSync(vp, doc.replace(re, md));
else console.warn('docs/VOICE.md: нет меток el-batch — сводку не вписал');

console.log(`el_batch_all.jsonl: ${todo.length} заданий, ${sum(todo)} символов (всего заданий ${jobs.length}, ${sum(jobs)} симв.; без изменений ${unchanged})`);
for (const p of personas) {
  const t = todo.filter((j) => j.persona === p);
  console.log(`  ${p}: ${t.length} заданий, ${sum(t)} символов`);
}

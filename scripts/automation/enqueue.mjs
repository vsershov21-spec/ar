#!/usr/bin/env node
// Постановка задачи ar-auto (локально, для Claude) и чтение результатов из ветки server-out. docs/automation/README.md.
//
//   node scripts/automation/enqueue.mjs status [--note "…"]
//   node scripts/automation/enqueue.mjs script scripts/deploy/caddy-encode.sh [--env DRY=1] [--timeout 30] [-- arg1 arg2]
//   node scripts/automation/enqueue.mjs audit [--timeout 120]
//   node scripts/automation/enqueue.mjs meshy --max-credits 30 -- --only wave     (и tripo / eleven — как в automation/README.md)
//     общие: --id <id> (иначе <kind>-<дата>-<sha7>), --ref <sha> (иначе HEAD), --dry (только показать)
//   node scripts/automation/enqueue.mjs result <id>        — git fetch origin server-out → summary.json + хвост log.txt
//   node scripts/automation/enqueue.mjs wait <id> [мин]    — ждать итог (fetch раз в минуту, по умолчанию 30 мин)
//   node scripts/automation/enqueue.mjs list               — out/status.json: последние задачи
//
// Задача добавляется в automation/queue.json с ref = HEAD (код скрипта — из этого коммита). Дальше — закоммитить
// queue.json и запушить в main (по правилам репо: rebase → tsc + vitest + build → push). Сервер возьмёт задачу
// за ≤ 5 мин, ref обязан быть в истории main, иначе задача — rejected.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateJob, validateQueue, OPS_KINDS, KINDS } from './ar-auto.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const QUEUE = path.join(ROOT, 'automation/queue.json');

/** id задачи: <kind>-<ггггммдд-ччмм>-<sha7>[-n], уникальный в очереди */
export function makeId(kind, sha, taken, d = new Date()) {
  const ts = d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
  const base = `${kind}-${ts}-${sha.slice(0, 7)}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/** разбор командной строки → черновик задачи (без id/ref) */
export function parseCli(argv) {
  const [kind, ...rest] = argv;
  if (!KINDS.includes(kind)) throw new Error(`вид задачи: ${KINDS.join(' | ')}`);
  const dd = rest.indexOf('--');
  const opts = dd >= 0 ? rest.slice(0, dd) : rest;
  const args = dd >= 0 ? rest.slice(dd + 1) : [];
  const o = { kind, args, env: {}, flags: {} };
  for (let i = 0; i < opts.length; i++) {
    const a = opts[i];
    const val = () => {
      if (i + 1 >= opts.length) throw new Error(`${a}: нужно значение`);
      return opts[++i];
    };
    if (a === '--env') {
      const [k, ...v] = val().split('=');
      o.env[k] = v.join('=');
    } else if (a === '--timeout') o.timeoutMin = Number(val());
    else if (a === '--note') o.note = val();
    else if (a === '--id') o.id = val();
    else if (a === '--ref') o.ref = val();
    else if (a === '--max-credits') o.maxCredits = Number(val());
    else if (a === '--dry') o.flags.dry = true;
    else if (!a.startsWith('-') && kind === 'script' && !o.path) o.path = a;
    else throw new Error(`непонятный аргумент ${a} (аргументы скрипта — после --)`);
  }
  return o;
}

/** черновик + sha → объект задачи для queue.json */
export function buildJob(o, sha, taken) {
  const j = { id: o.id ?? makeId(o.kind, sha, taken), kind: o.kind };
  if (OPS_KINDS.includes(o.kind)) {
    if (o.kind !== 'status') j.ref = o.ref ?? sha;
    if (o.path) j.path = o.path;
    if (o.args.length) j.args = o.args;
    if (Object.keys(o.env).length) j.env = o.env;
    if (o.timeoutMin !== undefined) j.timeoutMin = o.timeoutMin;
  } else {
    j.args = o.args;
    j.maxCredits = o.maxCredits ?? 0;
  }
  if (o.note) j.note = o.note;
  return j;
}

/** добавить задачу в очередь (с проверкой той же функцией, что на сервере) */
export function addToQueue(queue, job) {
  const jobs = Array.isArray(queue?.jobs) ? queue.jobs : [];
  const r = validateJob(job, new Set(jobs.map((x) => x.id)));
  if (r.error) throw new Error(r.error);
  const next = { ...queue, jobs: [...jobs, job] };
  const v = validateQueue(next);
  if (v.errors.length) throw new Error(v.errors.join('; '));
  return next;
}

const git = (...a) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' });

function fetchOut() {
  const r = git('fetch', '-q', 'origin', 'server-out');
  if (r.status !== 0) throw new Error(`git fetch origin server-out: ${r.stderr.trim() || 'нет ветки (ar-auto ещё ничего не выгрузил?)'}`);
}
const show = (p) => {
  const r = git('show', `origin/server-out:${p}`);
  return r.status === 0 ? r.stdout : null;
};

function result(id, quiet = false) {
  fetchOut();
  const s = show(`out/${id}/summary.json`);
  if (!s) {
    if (!quiet) {
      const err = show('out/_queue/errors.json');
      console.log(`out/${id}/summary.json пока нет.${err && err.includes(id) ? '\nОшибка очереди:\n' + err : ''}`);
    }
    return null;
  }
  const sum = JSON.parse(s);
  console.log(`== out/${id}/summary.json\n${s}`);
  const log = show(`out/${id}/log.txt`);
  if (log) console.log(`== out/${id}/log.txt (хвост)\n${log.split('\n').slice(-60).join('\n')}`);
  const ls = git('ls-tree', '-r', '--name-only', 'origin/server-out', `out/${id}/`);
  console.log(`== файлы\n${ls.stdout.trim()}\nвыгрузить: git archive origin/server-out out/${id} | tar -x -C /tmp/ar-out`);
  return sum;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === '-h' || cmd === '--help') {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 12).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    return;
  }
  if (cmd === 'result') {
    if (!result(rest[0])) process.exitCode = 1;
    return;
  }
  if (cmd === 'list') {
    fetchOut();
    console.log(show('out/status.json') ?? 'нет out/status.json');
    return;
  }
  if (cmd === 'wait') {
    const until = Date.now() + Number(rest[1] ?? 30) * 60000;
    for (;;) {
      const s = (() => {
        try {
          return result(rest[0], true);
        } catch {
          return null;
        }
      })();
      if (s && ['done', 'failed', 'rejected'].includes(s.status)) return;
      if (Date.now() > until) {
        console.log(`итога нет (статус: ${s?.status ?? 'нет summary'}) — позже: node scripts/automation/enqueue.mjs result ${rest[0]}`);
        process.exitCode = 1;
        return;
      }
      await new Promise((r) => setTimeout(r, 60000));
    }
  }
  const o = parseCli([cmd, ...rest]);
  const sha = git('rev-parse', 'HEAD').stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('нет HEAD');
  const ref = o.ref ?? sha;
  if (o.path && git('cat-file', '-e', `${ref}:${o.path}`).status !== 0) throw new Error(`${o.path} нет в коммите ${ref.slice(0, 7)}`);
  git('fetch', '-q', 'origin', 'main');
  if (OPS_KINDS.includes(o.kind) && o.kind !== 'status' && git('merge-base', '--is-ancestor', ref, 'origin/main').status !== 0)
    console.log(`внимание: ${ref.slice(0, 7)} ещё не в origin/main — запушьте его вместе с queue.json, иначе сервер отклонит задачу`);
  const queue = JSON.parse(fs.readFileSync(QUEUE, 'utf8'));
  const job = buildJob(o, sha, new Set((queue.jobs ?? []).map((x) => x.id)));
  const next = addToQueue(queue, job);
  console.log(JSON.stringify(job, null, 2));
  if (o.flags.dry) return console.log('(--dry: queue.json не изменён)');
  fs.writeFileSync(QUEUE, JSON.stringify(next, null, 2) + '\n');
  console.log(`добавлено в automation/queue.json. Дальше:
  git add automation/queue.json && git commit -m "ar-auto: ${job.id}" && (rebase → tsc + vitest + build) && git push origin HEAD:main
Результат (сервер берёт очередь раз в 5 мин):
  node scripts/automation/enqueue.mjs wait ${job.id}
  # или вручную: git fetch origin server-out && git show origin/server-out:out/${job.id}/summary.json`);
}

const isMain = (() => {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) main().catch((e) => {
  console.error(`enqueue: ${e.message}`);
  process.exit(1);
});

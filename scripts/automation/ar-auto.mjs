#!/usr/bin/env node
// ar-auto: очередь генераций из GitHub → запуск на сервере swe → результаты обратно в ветку server-out.
// Node 22, без зависимостей. Запускается от root таймером ar-auto.timer (раз в 5 мин), см. automation/README.md.
//
//   ar-auto tick [--wait]   — забрать automation/queue.json из main (по sha), запустить по одной задаче каждого вида
//   ar-auto run-job <id>    — выполнить задачу (вызывает tick через systemd-run, юнит ar-auto-job-<вид>)
//   ar-auto status          — последние задачи, траты за сегодня, что идёт сейчас
//   ar-auto push            — выгрузить накопленное в server-out
//   ar-auto mirror          — обновить out/latest/meshy и выгрузить
//
// Безопасность: аргументы — только белый список флагов и значений; бюджет задачи (maxCredits) и дневной потолок
// на провайдера (/etc/ar-auto.env) проверяются до запуска и передаются скриптам как жёсткий лимит; одновременно —
// не больше одной задачи каждого вида; токен GitHub читается из файла и передаётся git только через окружение,
// в логи и выгрузку не попадает (как и ключи Meshy/ElevenLabs); в server-out уходят только файлы под out/.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

export const KINDS = ['meshy', 'tripo', 'eleven'];
/** белый список: флаг → проверка значения */
export const ALLOWED = {
  meshy: { '--only': /^[a-z0-9_]+(,[a-z0-9_]+)*$/, '--redo': /^[a-z0-9_]+(,[a-z0-9_]+)*$/, '--set': /^(p0|p1|p2|all)(,(p0|p1|p2))*$/ },
  tripo: { '--only': /^[a-z0-9_]+(,[a-z0-9_]+)*$/ },
  eleven: { '--only': /^[a-z0-9_-]+$/ },
};
export const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** потолок maxCredits одной задачи (eleven — символы) — защита от опечатки сверх дневного лимита */
export const JOB_HARD_MAX = { meshy: 2000, tripo: 2000, eleven: 200000 };
export const DEFAULT_CAPS = { meshy: 400, tripo: 400, eleven: 20000 };
export const FINAL = new Set(['done', 'failed', 'rejected']);

// ───────────────────────── чистые функции (tests/automation.test.ts) ─────────────────────────

/** одна задача очереди → { job } или { error } */
export function validateJob(j, seen = new Set()) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { error: 'задача — не объект' };
  const id = j.id;
  if (typeof id !== 'string' || !ID_RE.test(id)) return { error: `id ${JSON.stringify(id)}: нужно [a-z0-9._-], до 64 символов` };
  if (seen.has(id)) return { error: `${id}: повтор id` };
  if (!KINDS.includes(j.kind)) return { error: `${id}: kind ${JSON.stringify(j.kind)} — только ${KINDS.join('|')}` };
  const args = j.args ?? [];
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) return { error: `${id}: args — массив строк` };
  if (args.length % 2) return { error: `${id}: args парами «флаг значение»` };
  const allowed = ALLOWED[j.kind];
  const flags = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const [f, v] = [args[i], args[i + 1]];
    if (!Object.hasOwn(allowed, f)) return { error: `${id}: флаг ${f} не разрешён для ${j.kind} (можно: ${Object.keys(allowed).join(' ')})` };
    if (flags.has(f)) return { error: `${id}: флаг ${f} дважды` };
    if (v.length > 300 || !allowed[f].test(v)) return { error: `${id}: значение ${JSON.stringify(v.slice(0, 40))} для ${f} не прошло проверку` };
    flags.add(f);
  }
  const mc = j.maxCredits;
  if (!Number.isInteger(mc) || mc < 0) return { error: `${id}: maxCredits — целое ≥ 0` };
  if (mc > JOB_HARD_MAX[j.kind]) return { error: `${id}: maxCredits ${mc} > потолка задачи ${JOB_HARD_MAX[j.kind]}` };
  if (j.kind === 'meshy' && args.length && mc === 0) return { error: `${id}: генерация Meshy с maxCredits 0 — нечего запускать (без args — только зеркало)` };
  const note = typeof j.note === 'string' ? j.note.slice(0, 300) : '';
  return { job: { id, kind: j.kind, args: [...args], maxCredits: mc, note } };
}

/** вся очередь → { jobs, errors } (плохие задачи пропускаются, остальные работают) */
export function validateQueue(q) {
  const list = Array.isArray(q) ? q : q?.jobs;
  if (!Array.isArray(list)) return { jobs: [], errors: ['queue.json: нужен { "jobs": [...] }'] };
  if (list.length > 500) return { jobs: [], errors: ['queue.json: больше 500 задач'] };
  const seen = new Set(), jobs = [], errors = [];
  for (const j of list) {
    const r = validateJob(j, seen);
    if (typeof j?.id === 'string') seen.add(j.id);
    if (r.error) errors.push(r.error);
    else jobs.push(r.job);
  }
  return { jobs, errors };
}

/** «мирор» Meshy: задача без аргументов — ничего не генерирует */
export const isMirror = (job) => job.kind === 'meshy' && job.args.length === 0;

/** календарный день (UTC) для дневных лимитов */
export const dayOf = (d = new Date()) => new Date(d).toISOString().slice(0, 10);

/** дневные потолки из env-файла */
export function dailyCaps(env = {}) {
  const n = (v, d) => (v !== undefined && /^\d+$/.test(String(v).trim()) ? Number(v) : d);
  return { meshy: n(env.AUTO_DAILY_MESHY, DEFAULT_CAPS.meshy), tripo: n(env.AUTO_DAILY_TRIPO, DEFAULT_CAPS.tripo), eleven: n(env.AUTO_DAILY_EL_CHARS, DEFAULT_CAPS.eleven) };
}

/** потрачено за день по виду: факт (credits) или резерв идущей задачи */
export function spentToday(records, kind, day) {
  let s = 0;
  for (const r of records) {
    if (r.job?.kind !== kind || r.day !== day) continue;
    if (!['running', 'done', 'failed'].includes(r.status)) continue;
    s += Number(r.credits ?? r.reserved ?? 0) || 0;
  }
  return s;
}

/**
 * решение до запуска: estimate — оценка из плана (null — неизвестна, как у ElevenLabs)
 * → { action: 'run'|'nothing'|'defer'|'reject', limit, reason }
 */
export function decide({ job, estimate, spent, cap }) {
  const left = Math.max(0, cap - spent);
  if (estimate === 0) return { action: 'nothing', limit: 0, reason: 'нечего генерировать (всё уже есть)' };
  if (estimate == null) {
    if (job.maxCredits === 0) return { action: 'reject', limit: 0, reason: 'maxCredits 0' };
    if (left <= 0) return { action: 'defer', limit: 0, reason: `дневной лимит ${cap} исчерпан (потрачено ${spent})` };
    return { action: 'run', limit: Math.min(job.maxCredits, left), reason: '' };
  }
  if (!Number.isFinite(estimate) || estimate < 0) return { action: 'reject', limit: 0, reason: 'оценка не распознана' };
  if (estimate > job.maxCredits) return { action: 'reject', limit: 0, reason: `оценка ${estimate} > maxCredits ${job.maxCredits}` };
  if (estimate > cap) return { action: 'reject', limit: 0, reason: `оценка ${estimate} > дневного лимита ${cap}` };
  if (estimate > left) return { action: 'defer', limit: 0, reason: `дневной лимит: осталось ${left} из ${cap}, нужно ${estimate}` };
  return { action: 'run', limit: Math.min(job.maxCredits, left), reason: '' };
}

/**
 * следующая задача вида: первая по порядку очереди, не завершённая; отложенная из-за лимита — только в новый день.
 * Пока первая отложена, следующие того же вида ждут (порядок важен).
 */
export function pickNext(jobs, recs, kind, day) {
  for (const job of jobs) {
    if (job.kind !== kind) continue;
    const r = recs[job.id];
    if (!r) return job;
    if (FINAL.has(r.status)) continue;
    if (r.status === 'deferred') return r.deferKind === 'busy' || r.deferredDay !== day ? job : null;
    return null; // queued/running — ждём
  }
  return null;
}

/** маскирует секреты: точные значения и типовые форматы ключей */
export function redact(text, secrets = []) {
  let s = String(text);
  for (const x of secrets) if (x && x.length >= 8) s = s.split(x).join('***');
  return s
    .replace(/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, '***')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '***')
    .replace(/\bmsy_[A-Za-z0-9_-]{8,}/g, '***')
    .replace(/\b(sk|tsk)_[A-Za-z0-9_-]{16,}/g, '***')
    .replace(/(authorization:\s*(basic|bearer|token)\s+)\S+/gi, '$1***')
    .replace(/(xi-api-key:\s*)\S+/gi, '$1***')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1***@');
}

/** путь внутри выгрузки: только out/…, без .., без странных символов */
export function safeOutPath(p) {
  if (typeof p !== 'string' || p.length > 200) return false;
  if (!/^out\/[A-Za-z0-9._/-]+$/.test(p)) return false;
  return !p.split('/').some((x) => x === '' || x === '.' || x === '..' || x.startsWith('.'));
}

// разбор выводов существующих скриптов
export function parseMeshyPlan(t) {
  const m = /к генерации: (\d+) из (\d+); оценка ≈ (\d+) кредитов/.exec(t);
  return m ? { todo: Number(m[1]), total: Number(m[2]), estimate: Number(m[3]) } : null;
}
export function parseMeshyRun(t) {
  const b = /баланс: (\d+(?:\.\d+)?) кредитов/.exec(t), a = /баланс после: (\d+(?:\.\d+)?)/.exec(t);
  const codes = [...t.matchAll(/=== \S+ код (\d+) ===/g)];
  return {
    before: b ? Number(b[1]) : null,
    after: a ? Number(a[1]) : null,
    code: codes.length ? Number(codes.at(-1)[1]) : null,
    made: [...t.matchAll(/✓ ([a-z0-9_]+)\.glb /g)].map((m) => m[1]),
    submitted: /риг: отправляю|▶ [a-z0-9_]+: (движение|анимация)/.test(t),
    errors: [...t.matchAll(/^.*[✗■].*$/gm)].map((m) => m[0].slice(0, 300)),
  };
}
export function parseTripoPlan(t) {
  const e = /оценка ≈ (\d+) кредитов/.exec(t), g = /к генерации: (\d+) из (\d+)/.exec(t);
  return e && g ? { estimate: Number(e[1]), todo: Number(g[1]), total: Number(g[2]) } : null;
}
export function parseTripoRun(t) {
  const started = [...t.matchAll(/▶ ([a-z0-9_]+) · ~(\d+) кр\./g)];
  return {
    credits: started.reduce((s, m) => s + Number(m[2]), 0),
    started: started.map((m) => m[1]),
    made: [...t.matchAll(/✓ ([a-z0-9_]+)\.glb/g)].map((m) => m[1]),
    errors: [...t.matchAll(/^.*[✗■].*$/gm)].map((m) => m[0].slice(0, 300)),
    finished: /=== done ===/.test(t),
  };
}
export function parseElevenRun(t) {
  const m = /Готово: новых (\d+), пропущено (\d+), ошибок (\d+).*?символов в этом прогоне (\d+); осталось (\d+)/.exec(t);
  return m ? { done: Number(m[1]), skipped: Number(m[2]), failed: Number(m[3]), chars: Number(m[4]), left: Number(m[5]) } : null;
}
export const parseBgPid = (t) => {
  const m = /в фоне \(pid (\d+)\)/.exec(t);
  return m ? Number(m[1]) : null;
};
/** env-файл KEY=VALUE (без выполнения shell) */
export function parseEnv(text) {
  const o = {};
  for (const line of String(text).split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    o[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return o;
}

// ───────────────────────── окружение ─────────────────────────

const OWNER_REPO = process.env.AUTO_REPO || 'vsershov21-spec/ar';
const API = process.env.AUTO_GH_API || 'https://api.github.com';
const RAW_BASE = process.env.AUTO_RAW || 'https://raw.githubusercontent.com';
const GIT_URL = process.env.AUTO_GIT_URL || `https://github.com/${OWNER_REPO}.git`;
const BRANCH = 'server-out';
const ENV_FILE = process.env.AUTO_ENV_FILE || '/etc/ar-auto.env';
const VAR = process.env.AUTO_VAR || '/var/lib/ar-auto';
const EXTRA = process.env.AUTO_EXTRA || '/srv/ar-extra';
const CMDR = '/var/lib/vershov-commander/ar';
const MESHY_DIR = path.join(EXTRA, 'models/anims/meshy');
const PROPS_DIR = path.join(EXTRA, 'models/props');
const STAGE = path.join(VAR, 'out');
const JOBS = path.join(VAR, 'jobs');
const LOGS = path.join(VAR, 'logs');
const WORK = path.join(VAR, 'work');
const SELF = process.env.AUTO_SELF || '/opt/ar-auto/ar-auto.sh';
const KB = 1024;

let ENV = {};
let SECRETS = [];
function loadEnv() {
  try {
    ENV = parseEnv(fs.readFileSync(ENV_FILE, 'utf8'));
  } catch {
    ENV = {};
  }
  const read = (f) => {
    try {
      return fs.readFileSync(f, 'utf8');
    } catch {
      return '';
    }
  };
  SECRETS = [ENV.GH_TOKEN, ...Object.values(parseEnv(read('/etc/ar-meshy.env'))), read('/var/lib/vershov-commander/.elevenlabs_key').trim()].filter(Boolean);
  for (const d of [VAR, STAGE, JOBS, LOGS, WORK]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
}
const caps = () => dailyCaps(ENV);
const num = (k, d) => (/^\d+$/.test(ENV[k] ?? '') ? Number(ENV[k]) : d);
const MESHY_MAX = () => num('AUTO_MESHY_MAX_KB', 200) * KB;
const TRIPO_MAX = () => num('AUTO_TRIPO_MAX_KB', 2048) * KB;

const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return d;
  }
};
function writeJson(f, v) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2) + '\n');
  fs.renameSync(tmp, f);
}
const say = (...a) => console.log(redact(a.join(' '), SECRETS));

const recFile = (id) => path.join(JOBS, `${id}.json`);
const loadRec = (id) => readJson(recFile(id), null);
const saveRec = (r) => writeJson(recFile(r.id), r);
function allRecs() {
  const o = {};
  for (const f of fs.readdirSync(JOBS)) if (f.endsWith('.json')) {
    const r = readJson(path.join(JOBS, f), null);
    if (r?.id) o[r.id] = r;
  }
  return o;
}

function ghHeaders() {
  const h = { 'User-Agent': 'ar-auto', Accept: 'application/vnd.github+json' };
  if (ENV.GH_TOKEN) h.Authorization = `Bearer ${ENV.GH_TOKEN}`;
  return h;
}
async function latestSha() {
  const r = await fetch(`${API}/repos/${OWNER_REPO}/commits/main`, { headers: ghHeaders(), signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`GitHub API ${r.status}`);
  const sha = (await r.json())?.sha;
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error('GitHub API: нет sha');
  return sha;
}
const rawUrl = (sha) => `${RAW_BASE}/${OWNER_REPO}/${sha}`;
async function fetchText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'ar-auto' }, signal: AbortSignal.timeout(60000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${url.replace(/^https?:\/\/[^/]+/, '')}: ${r.status}`);
  return r.text();
}
async function fetchScript(sha, rel, dest) {
  const t = await fetchText(`${rawUrl(sha)}/${rel}`);
  if (!t) throw new Error(`нет ${rel} в ${sha.slice(0, 7)}`);
  fs.writeFileSync(dest, t, { mode: 0o700 });
  return dest;
}

const pgrep = (pat) => spawnSync('pgrep', ['-f', pat], { encoding: 'utf8' }).status === 0;
const alive = (pid) => !!pid && fs.existsSync(`/proc/${pid}`);
const unitActive = (u) => spawnSync('systemctl', ['is-active', '--quiet', u]).status === 0;
const hasSystemd = () => !process.env.AUTO_NO_SYSTEMD && spawnSync('systemctl', ['--version']).status === 0 && fs.existsSync('/run/systemd/system');

/** запуск команды с логом в файл; возвращает { code, out } (вывод — для разбора, лог — без секретов) */
function run(cmd, args, { env = {}, log, timeoutMs = 0, cwd } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const on = (c) => {
      const s = c.toString();
      out += s;
      if (out.length > 4e6) out = out.slice(-2e6);
      if (log) fs.appendFileSync(log, redact(s, SECRETS));
    };
    p.stdout.on('data', on);
    p.stderr.on('data', on);
    const t = timeoutMs ? setTimeout(() => p.kill('SIGTERM'), timeoutMs) : null;
    p.on('close', (code) => {
      if (t) clearTimeout(t);
      resolve({ code: code ?? -1, out });
    });
    p.on('error', (e) => resolve({ code: -1, out: out + e.message }));
  });
}
const logTo = (log, s) => fs.appendFileSync(log, redact(`[ar-auto ${now()}] ${s}\n`, SECRETS));

/** дождаться фонового процесса (motion-run/el-run запускают setsid nohup) */
async function waitPid(pid, log, label) {
  let n = 0;
  while (alive(pid)) {
    await sleep(15000);
    if (++n % 40 === 0) logTo(log, `${label}: ещё идёт (${Math.round((n * 15) / 60)} мин)`);
  }
}
/** новая часть лог-файла с offset */
function readFrom(file, offset) {
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const b = Buffer.alloc(Math.max(0, size - offset));
    fs.readSync(fd, b, 0, b.length, offset);
    fs.closeSync(fd);
    return b.toString();
  } catch {
    return '';
  }
}
const fsize = (f) => {
  try {
    return fs.statSync(f).size;
  } catch {
    return 0;
  }
};
function fixPerms(dir) {
  spawnSync('chown', ['-R', 'vershov-commander:caddy', dir]);
  spawnSync('chmod', ['-R', 'g+rX,o+r', dir]);
}

// ───────────────────────── выгрузка в server-out ─────────────────────────

const dirty = () => fs.writeFileSync(path.join(VAR, 'dirty'), now());
function stageDir(...p) {
  const d = path.join(STAGE, ...p);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function copyLimited(src, dst, max) {
  const s = fs.statSync(src);
  if (s.size > max) return false;
  fs.copyFileSync(src, dst);
  return true;
}
/** зеркало /srv/ar-extra/models/anims/meshy → out/latest/meshy; true — если изменилось */
function stageMeshyMirror() {
  const manF = path.join(MESHY_DIR, 'manifest.json');
  if (!fs.existsSync(manF)) return false;
  const man = readJson(manF, { clips: [] });
  const dst = path.join(STAGE, 'latest', 'meshy');
  const files = (man.clips ?? []).map((c) => c.file).filter((f) => /^[a-z0-9_]+\.glb$/.test(f ?? ''));
  const h = crypto.createHash('sha256');
  for (const f of files) {
    const p = path.join(MESHY_DIR, f);
    if (fs.existsSync(p)) h.update(`${f}:${fs.statSync(p).size}:${fs.statSync(p).mtimeMs}\n`);
  }
  h.update(fs.readFileSync(manF));
  const hash = h.digest('hex');
  const st = readJson(path.join(VAR, 'state.json'), {});
  if (st.mirrorHash === hash && fs.existsSync(path.join(dst, 'manifest.json'))) return false;
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  const skipped = [];
  let n = 0, bytes = 0;
  for (const f of files) {
    const p = path.join(MESHY_DIR, f);
    if (!fs.existsSync(p)) continue;
    if (copyLimited(p, path.join(dst, f), MESHY_MAX())) n++, (bytes += fs.statSync(p).size);
    else skipped.push({ file: f, bytes: fs.statSync(p).size });
  }
  fs.copyFileSync(manF, path.join(dst, 'manifest.json'));
  writeJson(path.join(dst, '_mirror.json'), { updated: now(), clips: files.length, copied: n, bytes, maxBytes: MESHY_MAX(), skipped });
  writeJson(path.join(VAR, 'state.json'), { ...readJson(path.join(VAR, 'state.json'), {}), mirrorHash: hash, mirrorAt: now() });
  dirty();
  return true;
}

/** все файлы под dir (относительные пути) */
function walk(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else if (e.isFile()) out.push(path.relative(base, p));
  }
  return out;
}
/** храним не больше 100 папок задач (старые удаляются из выгрузки) */
function pruneStage() {
  const ids = fs.readdirSync(STAGE).filter((d) => !['latest', '_server', '_queue', 'status.json'].includes(d));
  if (ids.length <= 100) return;
  ids.sort((a, b) => fs.statSync(path.join(STAGE, a)).mtimeMs - fs.statSync(path.join(STAGE, b)).mtimeMs);
  for (const d of ids.slice(0, ids.length - 100)) fs.rmSync(path.join(STAGE, d), { recursive: true, force: true });
}

function gitEnv() {
  const env = { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false', GIT_AUTHOR_NAME: 'ar-auto', GIT_AUTHOR_EMAIL: 'ar-auto@swe.local', GIT_COMMITTER_NAME: 'ar-auto', GIT_COMMITTER_EMAIL: 'ar-auto@swe.local' };
  if (ENV.GH_TOKEN) {
    // токен — только в окружении процесса git (не в URL, не в аргументах, не в .git/config)
    const host = new URL(GIT_URL).origin + '/';
    Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${host}.extraheader`, GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${ENV.GH_TOKEN}`).toString('base64')}` });
  }
  return env;
}
const git = (args, cwd) => spawnSync('git', args, { cwd, env: { ...process.env, ...gitEnv() }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** выгрузка: временный клон server-out (depth 1) → out/ = содержимое STAGE → один коммит без истории → push с lease */
async function push(msg = 'ar-auto') {
  if (!ENV.GH_TOKEN) return say('push: нет GH_TOKEN в', ENV_FILE, '— пропускаю'), false;
  const lock = path.join(VAR, 'push.lock');
  for (let i = 0; ; i++) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 15 * 60000) fs.rmSync(lock, { recursive: true, force: true });
      } catch { /* гонка — повтор */ }
      if (i > 120) return say('push: занято другим процессом'), false;
      await sleep(5000);
    }
  }
  try {
    for (let attempt = 1; attempt <= 4; attempt++) {
      fs.rmSync(path.join(VAR, 'dirty'), { force: true });
      const tmp = fs.mkdtempSync(path.join(WORK, 'push-'));
      try {
        let r = git(['ls-remote', '--heads', GIT_URL, `refs/heads/${BRANCH}`]);
        if (r.status !== 0) throw new Error(`ls-remote: ${redact(r.stderr, SECRETS).trim().slice(0, 300)}`);
        const exists = r.stdout.trim() !== '';
        let lease;
        if (exists) {
          r = git(['clone', '-q', '--depth', '1', '--single-branch', '-b', BRANCH, GIT_URL, tmp]);
          if (r.status !== 0) throw new Error(`clone: ${redact(r.stderr, SECRETS).trim().slice(0, 300)}`);
          lease = git(['rev-parse', 'HEAD'], tmp).stdout.trim();
          // первый запуск на новом сервере: подхватить то, что уже выгружено
          if (!fs.existsSync(path.join(STAGE, 'status.json')) && fs.existsSync(path.join(tmp, 'out'))) fs.cpSync(path.join(tmp, 'out'), STAGE, { recursive: true });
        } else {
          // ветки ещё нет — создаём (orphan: общий корень с main не нужен)
          git(['init', '-q'], tmp);
          git(['remote', 'add', 'origin', GIT_URL], tmp);
          lease = '';
        }
        pruneStage();
        for (const e of fs.readdirSync(tmp)) if (e !== '.git') fs.rmSync(path.join(tmp, e), { recursive: true, force: true });
        fs.cpSync(STAGE, path.join(tmp, 'out'), { recursive: true });
        fs.writeFileSync(path.join(tmp, 'out', 'README.txt'), 'Выгрузка сервера swe (scripts/automation/ar-auto.mjs). Ветка перезаписывается одним коммитом. См. automation/README.md в main.\n');
        git(['add', '-A'], tmp);
        const files = git(['ls-files'], tmp).stdout.split('\n').filter(Boolean);
        const bad = files.filter((f) => !safeOutPath(f));
        if (bad.length) throw new Error(`отказ: файлы вне out/ или с недопустимым именем: ${bad.slice(0, 5).join(', ')}`);
        const total = files.reduce((s, f) => s + fsize(path.join(tmp, f)), 0);
        if (total > 300 * 1024 * 1024) throw new Error(`отказ: выгрузка ${Math.round(total / 1048576)} МБ > 300 МБ`);
        const tree = git(['write-tree'], tmp).stdout.trim();
        if (lease) {
          const oldTree = git(['rev-parse', 'HEAD^{tree}'], tmp).stdout.trim();
          if (oldTree === tree) return say('push: без изменений'), true;
        }
        const c = git(['commit-tree', tree, '-m', msg.slice(0, 200)], tmp).stdout.trim();
        r = git(['push', '-q', `--force-with-lease=refs/heads/${BRANCH}:${lease}`, 'origin', `${c}:refs/heads/${BRANCH}`], tmp);
        if (r.status === 0) return say(`push: ${BRANCH} ← ${c.slice(0, 7)} (${files.length} файлов, ${Math.round(total / 1024)} КБ)`), true;
        say(`push: попытка ${attempt} не прошла: ${redact(r.stderr, SECRETS).trim().slice(0, 300)}`);
      } catch (e) {
        say('push:', e.message);
        if (/^отказ/.test(e.message)) return false;
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
      dirty();
      await sleep(5000 * attempt);
    }
    return false;
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

// ───────────────────────── задачи ─────────────────────────

function stageJob(rec, logFile) {
  const d = stageDir(rec.id);
  const { job, ...rest } = rec;
  writeJson(path.join(d, 'summary.json'), { ...rest, kind: job.kind, args: job.args, maxCredits: job.maxCredits, note: job.note });
  if (logFile && fs.existsSync(logFile)) {
    const lines = redact(fs.readFileSync(logFile, 'utf8'), SECRETS).split('\n');
    fs.writeFileSync(path.join(d, 'log.txt'), lines.slice(-300).join('\n'));
  }
  dirty();
}

/** пересборка сайта: файлы в /srv/ar-extra попадают в релиз только при сборке */
async function rebuild(log) {
  const before = fs.existsSync('/srv/ar/current') ? fs.realpathSync('/srv/ar/current') : null;
  if (ENV.AUTO_REBUILD_CMD) {
    logTo(log, 'пересборка: AUTO_REBUILD_CMD');
    await run('bash', ['-c', ENV.AUTO_REBUILD_CMD], { log, timeoutMs: 30 * 60000 });
  } else if (hasSystemd() && spawnSync('systemctl', ['cat', 'ar-update.service']).status === 0) {
    logTo(log, 'пересборка: systemctl start ar-update');
    spawnSync('systemctl', ['start', '--no-block', 'ar-update.service']);
    const t0 = Date.now();
    await sleep(5000);
    while (unitActive('ar-update.service') && Date.now() - t0 < 30 * 60000) await sleep(10000);
  } else return { triggered: false, reason: 'нет ar-update.service' };
  const after = fs.existsSync('/srv/ar/current') ? fs.realpathSync('/srv/ar/current') : null;
  const res = { triggered: true, at: now(), releaseBefore: before, releaseAfter: after, changed: before !== after };
  logTo(log, `пересборка: релиз ${res.changed ? 'новый ' + after : 'не сменился (если ar-update не собирает без нового коммита — задать AUTO_REBUILD_CMD в ' + ENV_FILE + ')'}`);
  return res;
}

const busyPattern = { meshy: 'scripts/meshy/motion.mjs|ar/meshy/motion.mjs', tripo: 'props-run|tripo make', eleven: 'eleven.mjs --batch' };

async function jobMeshy(rec, log, ctx) {
  const { job, sha } = rec;
  if (isMirror(job)) {
    stageMeshyMirror();
    const man = readJson(path.join(MESHY_DIR, 'manifest.json'), { clips: [] });
    const m = readJson(path.join(STAGE, 'latest/meshy/_mirror.json'), {});
    logTo(log, `зеркало: клипов в манифесте ${man.clips?.length ?? 0}, выгружено ${m.copied ?? 0}, пропущено по размеру ${m.skipped?.length ?? 0}`);
    return { status: 'done', credits: 0, files: { mirror: 'out/latest/meshy/', clips: man.clips?.length ?? 0, copied: m.copied ?? 0, skipped: m.skipped ?? [] } };
  }
  const script = await fetchScript(sha, 'scripts/meshy/motion-run.sh', path.join(WORK, 'meshy-run.sh'));
  const env = { MESHY_RAW: rawUrl(sha) };
  const plan = await run('bash', [script, ...job.args], { env, log, timeoutMs: 10 * 60000 });
  const p = parseMeshyPlan(plan.out);
  if (!p) return { status: 'failed', credits: 0, reason: 'план Meshy не распознан (см. log.txt)' };
  const d = decide({ job, estimate: p.todo ? p.estimate : 0, spent: ctx.spent, cap: ctx.cap });
  if (d.action !== 'run') return { decision: d, estimate: p.estimate };
  const manF = path.join(MESHY_DIR, 'manifest.json');
  const before = new Map((readJson(manF, { clips: [] }).clips ?? []).map((c) => [c.id, c.created]));
  ctx.reserve(p.estimate);
  const logF = path.join(CMDR, 'meshy.log');
  const off = fsize(logF);
  const go = await run('bash', [script, '--go', ...job.args, '--max-credits', String(d.limit)], { env, log, timeoutMs: 10 * 60000 });
  const pid = parseBgPid(go.out);
  if (!pid) return { status: 'failed', credits: 0, reason: /Уже идёт/.test(go.out) ? 'занято ручным запуском' : 'не запустилось (см. log.txt)' };
  await waitPid(pid, log, 'meshy');
  const t = readFrom(logF, off);
  fs.appendFileSync(log, redact(t, SECRETS));
  const r = parseMeshyRun(t);
  const after = readJson(manF, { clips: [] });
  const fresh = (after.clips ?? []).filter((c) => before.get(c.id) !== c.created);
  const dst = stageDir(job.id, 'meshy');
  const copied = [], big = [];
  for (const c of fresh) {
    const src = path.join(MESHY_DIR, c.file);
    if (!fs.existsSync(src)) continue;
    (copyLimited(src, path.join(dst, c.file), MESHY_MAX()) ? copied : big).push(c.file);
  }
  fs.writeFileSync(path.join(dst, 'manifest.json'), JSON.stringify({ ...after, clips: fresh }, null, 2));
  stageMeshyMirror();
  let credits = r.before != null && r.after != null ? Math.max(0, Math.round(r.before - r.after)) : null;
  if (credits == null) credits = fresh.length || r.submitted ? p.estimate : 0; // баланс не узнали — считаем по оценке
  return {
    status: r.code === 0 && !r.errors.length ? 'done' : fresh.length ? 'done' : 'failed', credits, estimate: p.estimate,
    reason: r.errors.slice(0, 10).join(' | ') || undefined, extraChanged: fresh.length > 0,
    files: { new: fresh.map((c) => c.id), copied: copied.map((f) => `out/${job.id}/meshy/${f}`), tooBig: big, exitCode: r.code },
  };
}

async function jobTripo(rec, log, ctx) {
  const { job, sha } = rec;
  const script = await fetchScript(sha, 'scripts/tripo/props-run.sh', path.join(WORK, 'props-run.sh'));
  const env = { TRIPO_RAW: rawUrl(sha), HOME: process.env.HOME || '/root' };
  const plan = await run('bash', [script, ...job.args], { env, log, timeoutMs: 15 * 60000 });
  const p = parseTripoPlan(plan.out);
  if (!p) return { status: 'failed', credits: 0, reason: 'план Tripo не распознан (см. log.txt)' };
  const d = decide({ job, estimate: p.todo ? p.estimate : 0, spent: ctx.spent, cap: ctx.cap });
  if (d.action !== 'run') return { decision: d, estimate: p.estimate };
  ctx.reserve(p.estimate);
  const t0 = Date.now();
  const go = await run('bash', [script, '--go', ...job.args, '--max-credits', String(d.limit)], { env, log, timeoutMs: 6 * 3600000 });
  const r = parseTripoRun(go.out);
  const dst = stageDir(job.id, 'tripo');
  const copied = [], big = [];
  for (const f of fs.existsSync(PROPS_DIR) ? fs.readdirSync(PROPS_DIR) : []) {
    if (!/^[a-z0-9_]+\.(glb|png)$/.test(f)) continue;
    const src = path.join(PROPS_DIR, f);
    if (fs.statSync(src).mtimeMs < t0 - 1000) continue;
    (copyLimited(src, path.join(dst, f), TRIPO_MAX()) ? copied : big).push(f);
  }
  return {
    status: r.made.length || (go.code === 0 && !r.errors.length) ? 'done' : 'failed', credits: r.credits, estimate: p.estimate,
    reason: r.errors.slice(0, 10).join(' | ') || undefined, extraChanged: r.made.length > 0,
    files: { new: r.made, copied: copied.map((f) => `out/${job.id}/tripo/${f}`), tooBig: big, exitCode: go.code },
  };
}

function mp3List() {
  for (const d of [path.join(EXTRA, 'voice-el'), path.join(CMDR, 'voice-el')]) if (fs.existsSync(path.join(d, 'manifest.json'))) return { dir: d, files: new Set(walk(d).filter((f) => f.endsWith('.mp3'))) };
  return { dir: path.join(EXTRA, 'voice-el'), files: new Set() };
}

async function jobEleven(rec, log, ctx) {
  const { job, sha } = rec;
  const d = decide({ job, estimate: null, spent: ctx.spent, cap: ctx.cap });
  if (d.action !== 'run') return { decision: d };
  const script = await fetchScript(sha, 'scripts/voice/el-run.sh', path.join(WORK, 'el-run.sh'));
  const elLog = path.join(VAR, 'el-run.log');
  const env = { EL_REF: sha, EL_WORK: path.join(WORK, 'el-work'), EL_LOG: elLog, HOME: process.env.HOME || '/root' };
  const before = mp3List();
  ctx.reserve(d.limit);
  const off = fsize(elLog);
  const go = await run('bash', [script, ...job.args, '--max-chars', String(d.limit)], { env, log, timeoutMs: 20 * 60000 });
  const pid = parseBgPid(go.out);
  if (!pid) return { status: 'failed', credits: 0, reason: /Уже идёт/.test(go.out) ? 'занято ручным запуском' : 'не запустилось (см. log.txt)' };
  await waitPid(pid, log, 'eleven');
  const t = readFrom(elLog, off);
  fs.appendFileSync(log, redact(t, SECRETS));
  const r = parseElevenRun(t);
  const after = mp3List();
  const fresh = [...after.files].filter((f) => !before.files.has(f)).sort();
  if (fresh.length) fixPerms(after.dir);
  const dst = stageDir(job.id);
  fs.writeFileSync(path.join(dst, 'new-mp3.txt'), fresh.join('\n') + (fresh.length ? '\n' : ''));
  return {
    status: r && (r.done > 0 || r.failed === 0) ? 'done' : 'failed', credits: r ? r.chars : d.limit, unit: 'chars',
    reason: r ? (r.failed ? `ошибок ${r.failed}` : undefined) : 'итог ElevenLabs не распознан — списание посчитано по лимиту',
    extraChanged: fresh.length > 0, files: { newMp3: fresh.length, list: `out/${job.id}/new-mp3.txt`, left: r?.left ?? null, dir: after.dir },
  };
}

async function runJob(id) {
  loadEnv();
  const rec = loadRec(id);
  if (!rec) return say('нет задачи', id);
  if (FINAL.has(rec.status)) return say(id, 'уже', rec.status);
  const log = path.join(LOGS, `${id}.log`);
  const { job } = rec;
  const day = dayOf();
  const cap = caps()[job.kind];
  const others = Object.values(allRecs()).filter((r) => r.id !== id);
  const ctx = {
    spent: spentToday(others, job.kind, day), cap,
    reserve: (n) => {
      Object.assign(rec, { status: 'running', reserved: n, day });
      saveRec(rec);
    },
  };
  const prevReason = rec.reason;
  Object.assign(rec, { status: 'starting', started: now(), day, attempts: (rec.attempts ?? 0) + 1 });
  delete rec.reason;
  saveRec(rec);
  logTo(log, `задача ${id} (${job.kind} ${job.args.join(' ')}) · sha ${rec.sha.slice(0, 7)} · maxCredits ${job.maxCredits} · сегодня потрачено ${ctx.spent}/${cap}`);
  let res;
  try {
    if (!isMirror(job) && pgrep(busyPattern[job.kind])) res = { decision: { action: 'defer', reason: 'идёт ручной запуск того же вида' }, busy: true };
    else res = await ({ meshy: jobMeshy, tripo: jobTripo, eleven: jobEleven })[job.kind](rec, log, ctx);
  } catch (e) {
    res = { status: 'failed', credits: rec.reserved ?? 0, reason: `ошибка ar-auto: ${e.message}` };
  }
  if (res.decision) {
    const a = res.decision.action;
    if (a === 'nothing') res = { status: 'done', credits: 0, reason: res.decision.reason, estimate: res.estimate ?? 0 };
    else if (a === 'reject') res = { status: 'rejected', credits: 0, reason: res.decision.reason, estimate: res.estimate };
    else {
      Object.assign(rec, { status: 'deferred', deferKind: res.busy ? 'busy' : 'budget', deferredDay: day, reason: res.decision.reason, estimate: res.estimate, finished: now() });
      delete rec.reserved;
      saveRec(rec);
      logTo(log, `отложено: ${rec.reason}`);
      if (prevReason !== rec.reason || !fs.existsSync(path.join(STAGE, id, 'summary.json'))) stageJob(rec, log), await push(`ar-auto: ${id} отложена`);
      return;
    }
  }
  const { extraChanged, ...keep } = res;
  Object.assign(rec, keep, { finished: now() });
  delete rec.reserved;
  delete rec.deferKind;
  if (extraChanged) {
    fixPerms(job.kind === 'meshy' ? MESHY_DIR : job.kind === 'tripo' ? PROPS_DIR : path.join(EXTRA, 'voice-el'));
    rec.rebuild = await rebuild(log);
  }
  saveRec(rec);
  logTo(log, `итог: ${rec.status} · ${rec.unit === 'chars' ? 'символов' : 'кредитов'} ${rec.credits}${rec.reason ? ' · ' + rec.reason : ''}`);
  stageJob(rec, log);
  stageStatus();
  await push(`ar-auto: ${id} ${rec.status}`);
}

// ───────────────────────── tick / status ─────────────────────────

function statusObj() {
  const recs = Object.values(allRecs()).sort((a, b) => String(b.queuedAt).localeCompare(String(a.queuedAt)));
  const day = dayOf(), c = caps();
  return {
    day, caps: c,
    spentToday: Object.fromEntries(KINDS.map((k) => [k, spentToday(recs, k, day)])),
    running: KINDS.filter((k) => workerActive(k)),
    jobs: recs.slice(0, 60).map((r) => ({ id: r.id, kind: r.job?.kind, status: r.status, credits: r.credits ?? r.reserved ?? null, unit: r.unit, reason: r.reason, queuedAt: r.queuedAt, finished: r.finished, sha: r.sha?.slice(0, 7) })),
  };
}
function stageStatus(extra = {}) {
  const f = path.join(STAGE, 'status.json');
  const s = { ...statusObj(), ...extra };
  const old = readJson(f, {});
  const strip = (o) => JSON.stringify({ ...o, updated: 0, sha: 0, tick: 0 });
  if (strip(old) === strip(s)) return false;
  writeJson(f, { ...s, updated: now() });
  dirty();
  return true;
}

function workerActive(kind) {
  if (hasSystemd()) return unitActive(`ar-auto-job-${kind}.service`);
  const pid = Number(readJson(path.join(VAR, `worker-${kind}.json`), {}).pid);
  return alive(pid);
}
function spawnWorker(kind, id) {
  if (hasSystemd()) {
    const r = spawnSync('systemd-run', ['--unit', `ar-auto-job-${kind}`, '--collect', '--quiet', '--property=RuntimeMaxSec=12h', '--setenv=HOME=/root', '--setenv=PATH=' + process.env.PATH, SELF, 'run-job', id], { encoding: 'utf8' });
    if (r.status !== 0) say(`${kind}: systemd-run: ${(r.stderr || '').trim()}`);
    return r.status === 0;
  }
  const p = spawn(process.execPath, [new URL(import.meta.url).pathname, 'run-job', id], { detached: true, stdio: 'ignore' });
  p.unref();
  writeJson(path.join(VAR, `worker-${kind}.json`), { pid: p.pid, id });
  return true;
}

async function tick(wait) {
  loadEnv();
  const lock = path.join(VAR, 'tick.lock');
  try {
    if (Date.now() - fs.statSync(lock).mtimeMs > 30 * 60000) fs.rmSync(lock, { force: true });
  } catch { /* нет замка */ }
  let fd;
  try {
    fd = fs.openSync(lock, 'wx');
  } catch {
    return say('tick: уже идёт другой tick');
  }
  let started = [];
  try {
    started = (await tickLocked()) ?? [];
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
  }
  if (!wait || !started.length) return;
  // для install.sh: дождаться коротких задач (зеркало), длинные генерации идут дальше в фоне
  const t0 = Date.now();
  await sleep(3000);
  while (started.some((k) => workerActive(k)) && Date.now() - t0 < 10 * 60000) await sleep(5000);
  const left = started.filter((k) => workerActive(k));
  if (left.length) say(`ещё идут в фоне: ${left.join(', ')} — ar-auto status`);
}

async function tickLocked() {
  let sha, queue;
  try {
    sha = await latestSha();
    const t = await fetchText(`${rawUrl(sha)}/automation/queue.json`);
    queue = t ? JSON.parse(t) : { jobs: [] };
  } catch (e) {
    return say('tick: нет очереди —', e.message);
  }
  const { jobs, errors } = validateQueue(queue);
  const qf = path.join(STAGE, '_queue', 'errors.json');
  if (JSON.stringify(readJson(qf, {}).errors ?? []) !== JSON.stringify(errors)) writeJson(qf, { sha, errors, at: now() }), dirty();
  for (const e of errors) say('очередь:', e);
  const recs = allRecs();
  // задачи, прерванные перезагрузкой/сбоем: не начатые — снова в очередь, начатые — failed (оплаченное повторяет только новая задача)
  for (const r of Object.values(recs)) {
    if (!['queued', 'starting', 'running'].includes(r.status) || workerActive(r.job.kind)) continue;
    if (r.status === 'queued' && Date.now() - Date.parse(r.queuedAt) < 120000) continue;
    if (r.status === 'queued') delete recs[r.id], fs.rmSync(recFile(r.id), { force: true });
    else {
      Object.assign(r, { status: 'failed', reason: 'прервано (перезагрузка или сбой); повтор — новой задачей с другим id', credits: r.credits ?? r.reserved ?? 0, finished: now() });
      saveRec(r);
      stageJob(r, path.join(LOGS, `${r.id}.log`));
    }
  }
  const day = dayOf();
  const started = [];
  for (const kind of KINDS) {
    if (workerActive(kind)) continue;
    const job = pickNext(jobs, recs, kind, day);
    if (!job) continue;
    const prev = recs[job.id];
    const rec = { ...(prev ?? {}), id: job.id, job, sha, status: 'queued', queuedAt: prev?.queuedAt ?? now() };
    saveRec(rec);
    if (spawnWorker(kind, job.id)) started.push(kind), say(`запущено: ${job.id} (${kind})`);
  }
  if (!workerActive('meshy') && !started.includes('meshy')) stageMeshyMirror();
  stageStatus({ sha, tick: now() });
  const st = readJson(path.join(VAR, 'state.json'), {});
  writeJson(path.join(VAR, 'state.json'), { ...st, tick: now(), sha, queueErrors: errors, jobs: Object.fromEntries(Object.values(allRecs()).map((r) => [r.id, r.status])) });
  if (fs.existsSync(path.join(VAR, 'dirty'))) await push('ar-auto: статус');
  return started;
}

function status() {
  loadEnv();
  const s = statusObj();
  console.log(`ar-auto · ${s.day} (UTC)`);
  for (const k of KINDS) console.log(`  ${k.padEnd(7)} сегодня ${s.spentToday[k]} / ${s.caps[k]}${k === 'eleven' ? ' симв.' : ' кр.'}${s.running.includes(k) ? ' · идёт задача' : ''}`);
  console.log('последние задачи:');
  for (const j of s.jobs.slice(0, 15)) console.log(`  ${String(j.finished ?? j.queuedAt ?? '').slice(0, 16)}  ${j.status.padEnd(9)} ${j.kind.padEnd(7)} ${j.id}${j.credits != null ? ` · ${j.credits}` : ''}${j.reason ? ` · ${j.reason}` : ''}`);
  if (!s.jobs.length) console.log('  (пока нет)');
  const st = readJson(path.join(VAR, 'state.json'), {});
  if (st.mirrorAt) console.log(`зеркало Meshy: ${st.mirrorAt}`);
  console.log(`токен GitHub: ${ENV.GH_TOKEN ? 'есть' : 'НЕТ'} · выгрузка: ${fs.existsSync(path.join(VAR, 'dirty')) ? 'есть невыгруженное' : 'актуальна'} · ветка ${BRANCH}`);
  if (hasSystemd()) {
    const t = spawnSync('systemctl', ['list-timers', 'ar-auto.timer', '--no-pager'], { encoding: 'utf8' }).stdout.split('\n').slice(0, 2).join('\n');
    console.log(t);
  }
}

const isMain = (() => {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  const [cmd, arg] = process.argv.slice(2);
  const go = {
    tick: () => tick(process.argv.includes('--wait')),
    'run-job': () => (ID_RE.test(arg ?? '') ? runJob(arg) : say('run-job <id>')),
    status: async () => status(),
    push: async () => (loadEnv(), push('ar-auto: ручная выгрузка')),
    mirror: async () => (loadEnv(), stageMeshyMirror(), push('ar-auto: зеркало Meshy')),
  }[cmd];
  if (!go) {
    console.log('ar-auto tick [--wait] | run-job <id> | status | push | mirror');
    process.exit(cmd ? 1 : 0);
  }
  go().catch((e) => {
    console.error(redact(`ar-auto: ${e.stack ?? e.message}`, SECRETS));
    process.exit(1);
  });
}

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import {
  validateJob, validateQueue, pickNext, laneOf, redact, scriptAllowed, globToRe, scriptArgsPolicy, scriptEnv, refStatusOk,
  auditPick, keepHeaders, manifestCount, secretLike, ARG_RE, LANES, FINAL,
  // @ts-expect-error — .mjs без типов (серверный скрипт без зависимостей)
} from '../scripts/automation/ar-auto.mjs';
// @ts-expect-error — .mjs без типов
import { makeId, parseCli, buildJob, addToQueue } from '../scripts/automation/enqueue.mjs';

type J = Record<string, unknown>;
const SHA = '0123456789abcdef0123456789abcdef01234567';
const sc = (o: J = {}): J => ({ id: 's1', kind: 'script', ref: SHA.slice(0, 7), path: 'scripts/deploy/caddy-encode.sh', ...o });

describe('ar-auto ops: разбор очереди', () => {
  it('script / audit / status — корректные задачи и значения по умолчанию', () => {
    const s = validateJob(sc({ args: ['--only', 'a,b', 'x=1'], env: { DRY: '1' }, timeoutMin: 15, note: 'n' })).job;
    expect(s).toMatchObject({ kind: 'script', ref: SHA.slice(0, 7), path: 'scripts/deploy/caddy-encode.sh', args: ['--only', 'a,b', 'x=1'], env: { DRY: '1' }, timeoutMin: 15, maxCredits: 0 });
    expect(validateJob(sc()).job.timeoutMin).toBe(30);
    expect(validateJob({ id: 'a1', kind: 'audit', ref: SHA }).job).toMatchObject({ timeoutMin: 120, ref: SHA });
    expect(validateJob({ id: 'st', kind: 'status' }).job).toMatchObject({ kind: 'status', ref: null, timeoutMin: 5 });
    expect(validateJob({ id: 'st', kind: 'status', ref: SHA }).job.ref).toBe(SHA);
  });

  it('ref обязателен для script и audit: sha 7–40 [0-9a-f]', () => {
    for (const ref of [undefined, '', 'main', 'abc123', 'ABCDEF0', SHA + '0', 'g123456', '0123456;id'])
      expect(validateJob(sc({ ref })).error, String(ref)).toMatch(/ref/);
    expect(validateJob({ id: 'a1', kind: 'audit' }).error).toMatch(/ref/);
    expect(validateJob({ id: 'st', kind: 'status', ref: 'main' }).error).toMatch(/ref/);
  });

  it('args — массив безопасных строк, без shell-символов', () => {
    for (const a of ['a b', '$(id)', '`id`', 'a;b', 'a|b', 'a&b', "a'b", 'a"b', 'a\nb', '>x', 'x'.repeat(201)]) {
      expect(ARG_RE.test(a), a).toBe(false);
      expect(validateJob(sc({ args: [a] })).error, a).toBeTruthy();
    }
    expect(validateJob(sc({ args: 'x' })).error).toBeTruthy();
    expect(validateJob(sc({ args: [1] })).error).toBeTruthy();
    expect(validateJob(sc({ args: Array(41).fill('x') })).error).toBeTruthy();
  });

  it('env — только белый список; REF только равный ref задачи', () => {
    expect(validateJob(sc({ env: { DRY: '1', VERBOSE: '0' } })).job).toBeTruthy();
    expect(validateJob(sc({ env: { REF: SHA } })).job).toBeTruthy();
    for (const env of [{ PATH: '/x' }, { LD_PRELOAD: '/x.so' }, { GH_TOKEN: 'x' }, { DRY: 'yes' }, { DRY: 1 }, { REF: 'main' }, { REF: 'f'.repeat(40) }, []])
      expect(validateJob(sc({ env })).error, JSON.stringify(env)).toBeTruthy();
  });

  it('timeoutMin: script ≤ 120, audit ≤ 120, status ≤ 5', () => {
    expect(validateJob(sc({ timeoutMin: 120 })).job).toBeTruthy();
    for (const t of [0, -1, 121, 1.5, '10']) expect(validateJob(sc({ timeoutMin: t })).error, String(t)).toBeTruthy();
    expect(validateJob({ id: 'a', kind: 'audit', ref: SHA, timeoutMin: 121 }).error).toBeTruthy();
    expect(validateJob({ id: 'a', kind: 'status', timeoutMin: 6 }).error).toBeTruthy();
  });

  it('у audit/status нет path/args/env; ops не принимает maxCredits > 0', () => {
    expect(validateJob({ id: 'a', kind: 'audit', ref: SHA, args: ['x'] }).error).toBeTruthy();
    expect(validateJob({ id: 'a', kind: 'audit', ref: SHA, path: 'scripts/deploy/x.sh' }).error).toBeTruthy();
    expect(validateJob({ id: 'a', kind: 'status', env: { DRY: '1' } }).error).toBeTruthy();
    expect(validateJob(sc({ maxCredits: 10 })).error).toBeTruthy();
  });

  it('очередь из репо проходит (реальных ops-задач в ней нет)', () => {
    const q = JSON.parse(fs.readFileSync('automation/queue.json', 'utf8'));
    const { errors, jobs } = validateQueue(q);
    expect(errors).toEqual([]);
    expect(jobs.filter((j: J) => ['script', 'audit', 'status'].includes(j.kind as string))).toEqual([]);
  });
});

describe('ar-auto ops: белый список скриптов', () => {
  it('разрешено', () => {
    for (const p of ['scripts/deploy/caddy-encode.sh', 'scripts/deploy/pilot-setup.sh', 'scripts/qa/anim-audit/server-run.sh', 'scripts/qa/server-run.sh', 'scripts/qa/a/b/server-run.sh',
      'scripts/voice/el-run.sh', 'scripts/meshy/motion-run.sh', 'scripts/meshy/props-run.sh', 'scripts/tripo/props-run.sh'])
      expect(scriptAllowed(p), p).toBe(true);
  });
  it('запрещено: другие папки, вложенные deploy, обход путей, скрытые, не .sh', () => {
    for (const p of ['scripts/deploy/x.mjs', 'scripts/deploy/sub/x.sh', 'scripts/deploy/../automation/install.sh', 'scripts/deploy/.x.sh', '/scripts/deploy/x.sh',
      './scripts/deploy/x.sh', 'scripts/qa/anim-audit/audit.mjs', 'scripts/qa/../deploy/server-run.sh', 'scripts/qa/x/../server-run.sh', 'scripts/qa//server-run.sh',
      'scripts/automation/install.sh', 'scripts/voice/eleven.mjs', 'scripts/meshy/motion.mjs', 'scripts/deploy/x.sh\n', 'scripts/deploy/a b.sh', 'scripts/Deploy/x.sh', '', null, 5])
      expect(scriptAllowed(p), String(p)).toBe(false);
  });
  it('glob → regex', () => {
    expect(globToRe('scripts/qa/**/server-run.sh').test('scripts/qa/x/y/server-run.sh')).toBe(true);
    expect(globToRe('scripts/deploy/*.sh').test('scripts/deploy/a/b.sh')).toBe(false);
  });
  it('скрипты провайдеров — только без трат (генерация — через meshy/tripo/eleven с бюджетом)', () => {
    expect(scriptArgsPolicy('scripts/meshy/motion-run.sh', ['--go'])).toMatch(/meshy/);
    expect(scriptArgsPolicy('scripts/meshy/motion-run.sh', ['--set', 'p1'])).toBeNull();
    expect(scriptArgsPolicy('scripts/tripo/props-run.sh', ['--go', '--only', 'bed'])).toMatch(/tripo/);
    expect(scriptArgsPolicy('scripts/voice/el-run.sh', [])).toMatch(/--plan/);
    expect(scriptArgsPolicy('scripts/voice/el-run.sh', ['--plan'])).toBeNull();
    expect(validateJob(sc({ path: 'scripts/meshy/motion-run.sh', args: ['--go'] })).error).toBeTruthy();
    expect(validateJob(sc({ path: 'scripts/voice/el-run.sh', args: ['--plan'] })).job).toBeTruthy();
  });
  it('ref годится только как предок main', () => {
    expect(refStatusOk('ahead')).toBe(true);
    expect(refStatusOk('identical')).toBe(true);
    for (const s of ['behind', 'diverged', undefined, '']) expect(refStatusOk(s)).toBe(false);
  });
});

describe('ar-auto ops: окружение и маскирование', () => {
  it('окружение скрипта чистое: REF и *_RAW — на коммит задачи, без секретов ar-auto', () => {
    const job = validateJob(sc({ env: { DRY: '1' } })).job;
    const env = scriptEnv({ sha: SHA, job, rawBase: 'https://raw.githubusercontent.com/o/r', path: '/usr/bin', work: '/w' });
    expect(env).toMatchObject({ REF: SHA, DRY: '1', MESHY_RAW: `https://raw.githubusercontent.com/o/r/${SHA}`, TRIPO_RAW: `https://raw.githubusercontent.com/o/r/${SHA}`, EL_REF: SHA, EL_LOG: '/w/el-run.log', PATH: '/usr/bin' });
    expect(Object.keys(env).some((k) => /TOKEN|KEY|SECRET|GIT_CONFIG/.test(k))).toBe(false);
    const forged = scriptEnv({ sha: SHA, job: { ...job, env: { REF: 'main', GH_TOKEN: 'x' } }, rawBase: 'r' });
    expect(forged.REF).toBe(SHA);
    expect(forged.GH_TOKEN).toBeUndefined();
  });

  it('маскируются ключи Meshy/Tripo/ElevenLabs/GitHub в любом виде', () => {
    const pat = 'github_pat_' + 'A1'.repeat(20);
    const t = [
      `GH_TOKEN=${pat}`, 'MESHY_API_KEY=msy_live_abcdef123456', 'tsk_abcdefghijklmnop1234', 'xi-api-key: 0123456789abcdef0123',
      'ELEVENLABS_API_KEY="sk_0123456789abcdef0123"', '{"api_key": "zzzz-1111-yyyy-2222", "apiKey":"q1w2e3r4t5y6"}', 'Authorization: Bearer abc.def.ghi',
      'TRIPO_TOKEN: abcdef987654321', 'secret-from-file-123456',
    ].join('\n');
    const r = redact(t, ['secret-from-file-123456']);
    for (const x of [pat, 'msy_live', 'tsk_abc', '0123456789abcdef0123', 'zzzz-1111', 'q1w2e3r4', 'abc.def.ghi', 'abcdef987654321', 'secret-from-file'])
      expect(r, x).not.toContain(x);
    expect(r).toContain('GH_TOKEN=***');
    // обычный лог не портится
    const plain = 'клипов 33, баланс 500 кредитов · https://ar.vershov.com/mvp/ · HTTP/2 200 · REF=0123456789abcdef';
    expect(redact(plain)).toBe(plain);
  });

  it('значения из конфига Tripo попадают в список маскировки', () => {
    const s = secretLike('{"api_key":"tsk_9f8e7d6c5b4a39281706","server":"https://api.tripo3d.ai","x":"short"}');
    expect(s).toContain('tsk_9f8e7d6c5b4a39281706');
    expect(s.some((x: string) => x.includes('tripo3d'))).toBe(false);
  });

  it('status: из заголовков — только безопасные строки', () => {
    const h = keepHeaders('HTTP/2 200\r\nset-cookie: sid=secret\r\ncontent-type: text/html\r\ncache-control: no-cache\r\nx-api-key: zzz\r\n');
    expect(h).toEqual(['HTTP/2 200', 'content-type: text/html', 'cache-control: no-cache']);
  });

  it('счётчик манифеста и выбор файлов аудита', () => {
    expect(manifestCount({ clips: [1, 2, 3] })).toBe(3);
    expect(manifestCount([1, 2])).toBe(2);
    expect(manifestCount({ lines: { a: 1, b: 2 } })).toBe(2);
    expect(manifestCount(null)).toBeNull();
    const { md, json } = auditPick(['table_srv_meshy.md', 'idle_srv_meshy.md', 'REACTIONS_audit.md', 'summary_srv_base.json', 'raw', 'sheets', 'x.md', '../table_x.md', 'summary_x.txt']);
    expect(md).toEqual(['table_srv_meshy.md', 'idle_srv_meshy.md', 'REACTIONS_audit.md']);
    expect(json).toEqual(['summary_srv_base.json']);
  });
});

describe('ar-auto ops: однократность и параллелизм', () => {
  const day = '2026-11-22';
  const ops = [
    validateJob(sc({ id: 'o1' })).job, validateJob({ id: 'o2', kind: 'status' }).job, validateJob({ id: 'o3', kind: 'audit', ref: SHA }).job,
  ];
  const m = validateJob({ id: 'm1', kind: 'meshy', args: [], maxCredits: 0 }).job;
  const jobs = [m, ...ops];

  it('script/audit/status — одна полоса ops (параллелизм 1), провайдеры — свои', () => {
    expect(LANES).toEqual(['meshy', 'tripo', 'eleven', 'ops']);
    expect(['script', 'audit', 'status'].map(laneOf)).toEqual(['ops', 'ops', 'ops']);
    expect(pickNext(jobs, {}, 'ops', day).id).toBe('o1');
    expect(pickNext(jobs, {}, 'meshy', day).id).toBe('m1');
    expect(pickNext(jobs, { o1: { status: 'running' } }, 'ops', day)).toBeNull(); // пока идёт o1 — остальные ждут
    expect(pickNext(jobs, { o1: { status: 'queued' } }, 'ops', day)).toBeNull();
  });

  it('выполненная (done/failed/rejected) не повторяется; id в очереди уникален', () => {
    for (const st of FINAL) expect(pickNext(jobs, { o1: { status: st } }, 'ops', day).id).toBe('o2');
    expect(pickNext(jobs, { o1: { status: 'done' }, o2: { status: 'failed' }, o3: { status: 'rejected' } }, 'ops', day)).toBeNull();
    expect(pickNext(jobs, { o1: { status: 'deferred', deferKind: 'busy', deferredDay: day } }, 'ops', day).id).toBe('o1');
    const { jobs: ok, errors } = validateQueue({ jobs: [sc({ id: 'x' }), { id: 'x', kind: 'status' }] });
    expect(ok.length).toBe(1);
    expect(errors[0]).toMatch(/повтор/);
  });
});

describe('enqueue.mjs', () => {
  it('id: вид-дата-sha7, без повторов', () => {
    const d = new Date('2026-11-22T10:04:59Z');
    expect(makeId('status', SHA, new Set(), d)).toBe('status-20261122-1004-0123456');
    expect(makeId('status', SHA, new Set(['status-20261122-1004-0123456']), d)).toBe('status-20261122-1004-0123456-2');
    expect(validateJob({ id: makeId('script', SHA, new Set(), d), kind: 'status' }).job).toBeTruthy();
  });

  it('разбор командной строки и сборка задачи с текущим sha', () => {
    const o = parseCli(['script', 'scripts/deploy/caddy-encode.sh', '--env', 'DRY=1', '--timeout', '10', '--', '--only', 'x']);
    const j = buildJob(o, SHA, new Set());
    expect(j).toMatchObject({ kind: 'script', ref: SHA, path: 'scripts/deploy/caddy-encode.sh', args: ['--only', 'x'], env: { DRY: '1' }, timeoutMin: 10 });
    expect(buildJob(parseCli(['status']), SHA, new Set()).ref).toBeUndefined();
    expect(buildJob(parseCli(['audit']), SHA, new Set()).ref).toBe(SHA);
    expect(buildJob(parseCli(['meshy', '--max-credits', '30', '--', '--only', 'wave']), SHA, new Set())).toMatchObject({ args: ['--only', 'wave'], maxCredits: 30 });
    expect(() => parseCli(['shell'])).toThrow();
    expect(() => parseCli(['script', 'a', 'b'])).toThrow();
  });

  it('в очередь — только то, что пройдёт проверку сервера; повтор id — отказ', () => {
    const q = { jobs: [{ id: 'mirror-meshy', kind: 'meshy', args: [], maxCredits: 0 }] };
    const j = buildJob(parseCli(['status']), SHA, new Set());
    const next = addToQueue(q, j);
    expect(next.jobs.length).toBe(2);
    expect(q.jobs.length).toBe(1);
    expect(() => addToQueue(next, j)).toThrow(/повтор/);
    expect(() => addToQueue(q, buildJob(parseCli(['script', 'scripts/automation/install.sh']), SHA, new Set()))).toThrow(/белом списке/);
  });
});

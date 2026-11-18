import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import {
  validateJob, validateQueue, decide, spentToday, pickNext, dailyCaps, redact, safeOutPath, isMirror, parseEnv,
  parseMeshyPlan, parseMeshyRun, parseTripoPlan, parseTripoRun, parseElevenRun, parseBgPid, JOB_HARD_MAX,
  // @ts-expect-error — .mjs без типов (серверный скрипт без зависимостей)
} from '../scripts/automation/ar-auto.mjs';

type Job = { id: string; kind: string; args: string[]; maxCredits: number; note: string };
const job = (o: Partial<Job> = {}): Job => ({ id: 'j1', kind: 'meshy', args: ['--only', 'wave'], maxCredits: 30, note: '', ...o });

describe('ar-auto: проверка очереди', () => {
  it('рабочая очередь из репозитория проходит, mirror-meshy — без генерации', () => {
    const q = JSON.parse(fs.readFileSync('automation/queue.json', 'utf8'));
    const { jobs, errors } = validateQueue(q);
    expect(errors).toEqual([]);
    const m = jobs.find((j: Job) => j.id === 'mirror-meshy');
    expect(m).toBeTruthy();
    expect(isMirror(m)).toBe(true);
    expect(m.maxCredits).toBe(0);
  });

  it('разрешённые флаги по видам', () => {
    expect(validateJob(job({ args: ['--only', 'wave,sit_down'] })).job).toBeTruthy();
    expect(validateJob(job({ args: ['--redo', 'wave'] })).job).toBeTruthy();
    expect(validateJob(job({ args: ['--set', 'p1'] })).job).toBeTruthy();
    expect(validateJob(job({ args: ['--set', 'p0,p1'] })).job).toBeTruthy();
    expect(validateJob(job({ kind: 'tripo', args: ['--only', 'bed'] })).job).toBeTruthy();
    expect(validateJob(job({ kind: 'eleven', args: ['--only', 'hooligan'], maxCredits: 3000 })).job).toBeTruthy();
    expect(validateJob(job({ kind: 'tripo', args: [] })).job).toBeTruthy();
  });

  it('отказ: чужие флаги, инъекции, --go, лишние значения', () => {
    const bad: Partial<Job>[] = [
      { args: ['--go'] },
      { args: ['--go', 'x'] },
      { args: ['--model-url', 'https://evil/x.glb'] },
      { args: ['--new-rig', 'x'] },
      { args: ['--only', 'wave;rm -rf /'] },
      { args: ['--only', '$(id)'] },
      { args: ['--only', 'wave', '--only', 'sit'] },
      { args: ['--only'] },
      { args: ['--set', 'p9'] },
      { kind: 'tripo', args: ['--redo', 'bed'] },
      { kind: 'tripo', args: ['--max-credits', '9999'] },
      { kind: 'eleven', args: ['--max-chars', '999999'] },
      { kind: 'eleven', args: ['--only', 'a b'] },
      { kind: 'shell' as string },
      { args: [1 as unknown as string, 'x'] },
    ];
    for (const b of bad) expect(validateJob(job(b)).error, JSON.stringify(b)).toBeTruthy();
  });

  it('id: безопасное имя папки, уникальность', () => {
    for (const id of ['../x', 'a/b', '.hidden', '', 'A', 'x'.repeat(65), 'a b']) expect(validateJob(job({ id })).error, id).toBeTruthy();
    expect(validateJob(job({ id: 'meshy-wave.v2_1' })).job).toBeTruthy();
    const { jobs, errors } = validateQueue({ jobs: [job(), job(), job({ id: 'j2' })] });
    expect(jobs.map((j: Job) => j.id)).toEqual(['j1', 'j2']);
    expect(errors[0]).toMatch(/повтор/);
  });

  it('maxCredits: целое, не выше потолка задачи; генерация Meshy с 0 — ошибка', () => {
    expect(validateJob(job({ maxCredits: -1 })).error).toBeTruthy();
    expect(validateJob(job({ maxCredits: 1.5 })).error).toBeTruthy();
    expect(validateJob(job({ maxCredits: '30' as unknown as number })).error).toBeTruthy();
    expect(validateJob(job({ maxCredits: JOB_HARD_MAX.meshy + 1 })).error).toBeTruthy();
    expect(validateJob(job({ maxCredits: 0 })).error).toBeTruthy();
    expect(validateJob(job({ args: [], maxCredits: 0 })).job).toBeTruthy();
  });

  it('плохая очередь целиком', () => {
    expect(validateQueue(null).errors.length).toBe(1);
    expect(validateQueue({ jobs: 'x' }).errors.length).toBe(1);
    expect(validateQueue([job()]).jobs.length).toBe(1);
  });
});

describe('ar-auto: бюджет', () => {
  const day = '2026-11-19';
  const rec = (id: string, kind: string, status: string, credits: number | null, reserved?: number, d = day) => ({ id, job: { kind }, status, credits, reserved, day: d });

  it('потрачено за день: факт + резерв идущих, другие виды и дни не считаются', () => {
    const recs = [
      rec('a', 'meshy', 'done', 120), rec('b', 'meshy', 'failed', 13), rec('c', 'meshy', 'running', null, 50),
      rec('d', 'meshy', 'rejected', 999), rec('e', 'meshy', 'deferred', null, 77), rec('f', 'tripo', 'done', 220),
      rec('g', 'meshy', 'done', 300, undefined, '2026-11-18'),
    ];
    expect(spentToday(recs, 'meshy', day)).toBe(183);
    expect(spentToday(recs, 'tripo', day)).toBe(220);
    expect(spentToday(recs, 'eleven', day)).toBe(0);
  });

  it('решение по оценке', () => {
    const j = job({ maxCredits: 100 });
    expect(decide({ job: j, estimate: 0, spent: 0, cap: 400 }).action).toBe('nothing');
    expect(decide({ job: j, estimate: 101, spent: 0, cap: 400 }).action).toBe('reject');
    expect(decide({ job: job({ maxCredits: 500 }), estimate: 450, spent: 0, cap: 400 }).action).toBe('reject');
    expect(decide({ job: j, estimate: 90, spent: 350, cap: 400 })).toMatchObject({ action: 'defer' });
    expect(decide({ job: j, estimate: 90, spent: 300, cap: 400 })).toMatchObject({ action: 'run', limit: 100 });
    expect(decide({ job: j, estimate: 40, spent: 330, cap: 400 })).toMatchObject({ action: 'run', limit: 70 });
    expect(decide({ job: j, estimate: NaN, spent: 0, cap: 400 }).action).toBe('reject');
  });

  it('без оценки (ElevenLabs): лимит = min(maxCredits, остаток дня)', () => {
    const j = job({ kind: 'eleven', maxCredits: 5000 });
    expect(decide({ job: j, estimate: null, spent: 0, cap: 20000 })).toMatchObject({ action: 'run', limit: 5000 });
    expect(decide({ job: j, estimate: null, spent: 18000, cap: 20000 })).toMatchObject({ action: 'run', limit: 2000 });
    expect(decide({ job: j, estimate: null, spent: 20000, cap: 20000 }).action).toBe('defer');
  });

  it('дневные лимиты из env, по умолчанию 400/400/20000', () => {
    expect(dailyCaps({})).toEqual({ meshy: 400, tripo: 400, eleven: 20000 });
    expect(dailyCaps(parseEnv('AUTO_DAILY_MESHY=150\nAUTO_DAILY_TRIPO="0"\nAUTO_DAILY_EL_CHARS=abc\n# x=1'))).toEqual({ meshy: 150, tripo: 0, eleven: 20000 });
  });

  it('выбор задачи: по порядку, одна на вид, отложенная по лимиту ждёт нового дня', () => {
    const jobs = [job({ id: 'm1' }), job({ id: 't1', kind: 'tripo' }), job({ id: 'm2' })];
    expect(pickNext(jobs, {}, 'meshy', day).id).toBe('m1');
    expect(pickNext(jobs, { m1: { status: 'done' } }, 'meshy', day).id).toBe('m2');
    expect(pickNext(jobs, { m1: { status: 'running' } }, 'meshy', day)).toBeNull();
    expect(pickNext(jobs, { m1: { status: 'deferred', deferKind: 'budget', deferredDay: day } }, 'meshy', day)).toBeNull();
    expect(pickNext(jobs, { m1: { status: 'deferred', deferKind: 'budget', deferredDay: '2026-11-18' } }, 'meshy', day).id).toBe('m1');
    expect(pickNext(jobs, { m1: { status: 'deferred', deferKind: 'busy', deferredDay: day } }, 'meshy', day).id).toBe('m1');
    expect(pickNext(jobs, { m1: { status: 'rejected' }, m2: { status: 'failed' } }, 'meshy', day)).toBeNull();
    expect(pickNext(jobs, {}, 'tripo', day).id).toBe('t1');
    expect(pickNext(jobs, {}, 'eleven', day)).toBeNull();
  });
});

describe('ar-auto: безопасность выгрузки', () => {
  it('секреты маскируются', () => {
    const s = redact('key msy_abcdEFGH1234 tok ghp_' + 'a'.repeat(36) + ' pat github_pat_' + 'B'.repeat(40) + ' AUTHORIZATION: basic eHg6eXk= https://u:p@github.com/x mysecretvalue', ['mysecretvalue']);
    expect(s).not.toMatch(/msy_abcd|ghp_a|github_pat_B|eHg6|u:p@|mysecretvalue/);
  });
  it('только out/…', () => {
    for (const p of ['out/j1/summary.json', 'out/latest/meshy/wave.glb', 'out/_queue/errors.json']) expect(safeOutPath(p), p).toBe(true);
    for (const p of ['README.md', 'src/x.ts', 'out/../src/x', 'out//x', 'out/.git/config', 'out/a b', '/out/x', 'out/x/./y']) expect(safeOutPath(p), p).toBe(false);
  });
});

describe('ar-auto: разбор вывода скриптов', () => {
  it('Meshy: план и прогон', () => {
    const plan = '[12:00] баланс: 500 кредитов\n• wave 2 с prime · 13 кр.\n[12:00] к генерации: 2 из 33; оценка ≈ 26 кредитов (риг 0 + движение 10/клип + анимация 3/клип); баланс 500';
    expect(parseMeshyPlan(plan)).toEqual({ todo: 2, total: 33, estimate: 26 });
    expect(parseMeshyPlan('ничего')).toBeNull();
    const run = '=== 2026 meshy --only wave ===\nбаланс: 500 кредитов\n▶ wave: движение abc (2 с)\n✓ wave.glb 80 КБ · 2 с · треков 52 · кредиты 10+3\n✗ sit: анимация FAILED x\nбаланс после: 487\n=== 2026-11-19T12:00:00+03:00 код 0 ===';
    expect(parseMeshyRun(run)).toMatchObject({ before: 500, after: 487, code: 0, made: ['wave'], submitted: true });
    expect(parseMeshyRun(run).errors.length).toBe(1);
    expect(parseMeshyRun('баланс: 10 кредитов\n✗ стоп: оценка 26 кредитов > --max-credits 20').submitted).toBe(false);
  });
  it('Tripo: план и прогон', () => {
    expect(parseTripoPlan('• bed — ~110 кредитов\nоценка ≈ 220 кредитов\nк генерации: 2 из 9 (≈110 кредитов за предмет)')).toEqual({ estimate: 220, todo: 2, total: 9 });
    const r = parseTripoRun('▶ bed · ~110 кр.\n✓ bed.glb 1.2M\n▶ mug · ~90 кр.\n✗ mug — код 1\n=== done ===');
    expect(r).toMatchObject({ credits: 200, started: ['bed', 'mug'], made: ['bed'], finished: true });
  });
  it('ElevenLabs и pid фона', () => {
    expect(parseElevenRun('Готово: новых 12, пропущено 3, ошибок 0, остановлено: лимит 500 символов; символов в этом прогоне 480; осталось 7; всего в манифесте 100, 1.00 МБ'))
      .toEqual({ done: 12, skipped: 3, failed: 0, chars: 480, left: 7 });
    expect(parseBgPid('Генерация в фоне (pid 4242). Лог: …')).toBe(4242);
    expect(parseBgPid('Озвучка запущена в фоне (pid 77). Лог')).toBe(77);
    expect(parseBgPid('Уже идёт генерация')).toBeNull();
  });
});

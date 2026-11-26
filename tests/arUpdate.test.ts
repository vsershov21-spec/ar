/**
 * server/ar-update/ar-update.sh (docs/RELEASE.md): main → корень и /lab, ветка release → /mvp.
 * Стенд: локальный «GitHub» (bare-репо), фиктивная сборка (dist/index.html, dist/lab, dist/mvp, models/opt/<sha>),
 * AR_ENV / AR_BASE вместо /etc/ar/ar.env и /srv/ar. Проверяем, что push в main не трогает /mvp, release собирается
 * один раз (кэш), упавший release оставляет прежний /mvp без повторов, ассеты release докладываются в корень.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error — .mjs без типов (серверный скрипт без зависимостей)
import { scriptAllowed } from '../scripts/automation/ar-auto.mjs';

const SCRIPT = path.resolve('server/ar-update/ar-update.sh');
const has = (c: string) => spawnSync('sh', ['-c', `command -v ${c}`]).status === 0;

const BUILD = `import fs from 'node:fs'; import { execSync } from 'node:child_process';
const sha = execSync('git rev-parse --short=7 HEAD').toString().trim();
const eds = (process.env.AR_EDITIONS ?? 'mvp,lab,pilot').split(',');
if (fs.existsSync('FAIL')) process.exit(1);
fs.rmSync('dist', { recursive: true, force: true });
const w = (p, t) => { fs.mkdirSync(p.split('/').slice(0, -1).join('/'), { recursive: true }); fs.writeFileSync(p, t); };
if (eds.includes('mvp')) { w('dist/index.html', 'root ' + sha); w('dist/models/opt/cat.' + sha + '.glb', 'm'); }
if (eds.includes('lab')) w('dist/lab/index.html', 'lab ' + sha);
if (eds.includes('pilot')) w('dist/mvp/index.html', 'pilot ' + sha);
`;

describe.skipIf(!has('git') || !has('bash') || !has('npm'))('ar-update: /mvp из ветки release', () => {
  it('main → корень и /lab, release → /mvp; кэш release; упавший release — прежний /mvp', () => {
    const T = fs.mkdtempSync(path.join(os.tmpdir(), 'arup-'));
    const src = path.join(T, 'src'), base = path.join(T, 'base'), remote = path.join(T, 'remote.git');
    fs.mkdirSync(src);
    fs.mkdirSync(base);
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: src, stdio: 'pipe' }).toString().trim();
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', private: true, scripts: { build: 'node build.mjs' } }));
    fs.writeFileSync(path.join(src, 'package-lock.json'), JSON.stringify({ name: 'x', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'x', version: '1.0.0' } } }));
    fs.writeFileSync(path.join(src, 'build.mjs'), BUILD);
    const commit = (m: string) => (git('add', '-A'), git('commit', '-qm', m), git('rev-parse', '--short=7', 'HEAD'));
    const c1 = commit('c1');
    execFileSync('git', ['clone', '-q', '--bare', src, remote]);
    fs.writeFileSync(path.join(T, 'ar.env'), `REPO_URL=file://${remote}\nBRANCH=main\n`);
    const read = (p: string) => fs.readFileSync(path.join(base, 'current', p), 'utf8');
    const run = () => {
      const r = spawnSync('bash', [SCRIPT], { env: { ...process.env, AR_ENV: path.join(T, 'ar.env'), AR_BASE: base }, encoding: 'utf8' });
      expect(r.status, fs.existsSync(path.join(base, 'update.log')) ? fs.readFileSync(path.join(base, 'update.log'), 'utf8').slice(-1500) : r.stderr).toBe(0);
      return { name: path.basename(fs.readlinkSync(path.join(base, 'current'))), root: read('index.html'), lab: read('lab/index.html'), mvp: read('mvp/index.html') };
    };
    const push = (ref: string) => execFileSync('git', ['push', '-q', remote, ref], { cwd: src, stdio: 'pipe' });
    try {
      // ветки release нет — как раньше: всё из main
      expect(run()).toEqual({ name: c1, root: `root ${c1}`, lab: `lab ${c1}`, mvp: `pilot ${c1}` });
      // release = main
      fs.writeFileSync(path.join(src, 'a'), '1');
      const c2 = commit('c2');
      push('main');
      push('HEAD:refs/heads/release');
      expect(run()).toEqual({ name: `${c2}-r${c2}`, root: `root ${c2}`, lab: `lab ${c2}`, mvp: `pilot ${c2}` });
      // push в main: корень и /lab — новые, /mvp — release (из кэша, без пересборки); модели release — в корне
      fs.writeFileSync(path.join(src, 'a'), '2');
      const c3 = commit('c3');
      push('main');
      expect(run()).toEqual({ name: `${c3}-r${c2}`, root: `root ${c3}`, lab: `lab ${c3}`, mvp: `pilot ${c2}` });
      expect(fs.existsSync(path.join(base, 'current/models/opt', `cat.${c2}.glb`))).toBe(true);
      expect(fs.existsSync(path.join(base, 'current/models/opt', `cat.${c3}.glb`))).toBe(true);
      // ничего не менялось — релиз тот же
      expect(run().name).toBe(`${c3}-r${c2}`);
      // release на коммите, который не собирается: /mvp прежний, повторов нет
      fs.writeFileSync(path.join(src, 'FAIL'), '');
      const bad = commit('bad');
      push('HEAD:refs/heads/release');
      expect(run()).toMatchObject({ name: `${c3}-r${c2}`, mvp: `pilot ${c2}` });
      expect(fs.existsSync(path.join(base, 'release-dist', `${bad}.failed`))).toBe(true);
      expect(run().name).toBe(`${c3}-r${c2}`);
      // починили — новый release на /mvp, main прежний (без пересборки корня)
      fs.rmSync(path.join(src, 'FAIL'));
      const fix = commit('fix');
      push('HEAD:refs/heads/release');
      expect(run()).toEqual({ name: `${c3}-r${fix}`, root: `root ${c3}`, lab: `lab ${c3}`, mvp: `pilot ${fix}` });
      const log = fs.readFileSync(path.join(base, 'update.log'), 'utf8');
      expect(log.match(/сборка release /g)?.length).toBe(3); // c2, bad, fix — c2 второй раз из кэша
      expect(log).toContain(`main ${c3} без изменений`);
    } finally {
      fs.rmSync(T, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('ветка release: что может запустить ar-auto', () => {
  it('установка и проверка — в белом списке; сам ar-update.sh и выпуск (push release) — нет', () => {
    expect(scriptAllowed('scripts/deploy/release-setup.sh')).toBe(true);
    expect(scriptAllowed('scripts/deploy/release-check.sh')).toBe(true);
    expect(scriptAllowed('server/ar-update/ar-update.sh')).toBe(false);
    expect(scriptAllowed('scripts/release/promote-release.sh')).toBe(false);
  });
  it('promote-release: только fast-forward (без --force), полные проверки до push', () => {
    const s = fs.readFileSync(path.resolve('scripts/release/promote-release.sh'), 'utf8');
    expect(s).not.toMatch(/push[^\n]*(--force|-f\b)/);
    expect(s).toMatch(/merge-base --is-ancestor "\$SHA" origin\/main/);
    for (const c of ['npx tsc --noEmit', 'npx vitest run --no-file-parallelism', 'npm run build', 'npm run e2e:pilot']) expect(s).toContain(c);
    expect(s.indexOf('npm run e2e:pilot')).toBeLessThan(s.indexOf('git push origin'));
  });
});

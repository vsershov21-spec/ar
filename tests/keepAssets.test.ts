// PERF-02: окно совместимости хэшированных ассетов между релизами (scripts/build/keep-assets.mjs)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error — .mjs без типов
import { keepAssets } from '../scripts/build/keep-assets.mjs';

let tmp: string;
const H = 3600_000;
const put = (root: string, rel: string, body = rel) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
};
/** «сборка»: чистый dist с указанными файлами */
const build = (files: string[]) => {
  const d = path.join(tmp, 'dist');
  fs.rmSync(d, { recursive: true, force: true });
  for (const f of files) put(d, f);
  put(d, 'mvp/index.html', '<html>');
  return d;
};
const read = (p: string) => fs.readFileSync(p, 'utf8');

describe('keep-assets: ассеты прошлых релизов', () => {
  beforeEach(() => (tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-'))));
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('первый запуск: ассеты текущего релиза — в пул и симлинками в новую сборку; свои файлы не трогаем', () => {
    const prev = path.join(tmp, 'rel-a');
    put(prev, 'mvp/assets/main-OLD.js', 'old main');
    put(prev, 'models/opt/cat.aaaa.glb', 'old glb');
    put(prev, 'mvp/assets/shared-S.js', 'shared');
    put(prev, 'mvp/index.html', '<old html>');
    const dist = build(['mvp/assets/main-NEW.js', 'mvp/assets/shared-S.js', 'models/opt/cat.bbbb.glb']);
    const pool = path.join(tmp, 'pool');
    const r = keepAssets({ dist, pool, prev, now: 100 * H });
    expect(r.kept).toBe(2);
    expect(fs.lstatSync(path.join(dist, 'mvp/assets/main-OLD.js')).isSymbolicLink()).toBe(true);
    expect(read(path.join(dist, 'mvp/assets/main-OLD.js'))).toBe('old main');
    expect(read(path.join(dist, 'models/opt/cat.aaaa.glb'))).toBe('old glb');
    expect(fs.lstatSync(path.join(dist, 'mvp/assets/shared-S.js')).isFile()).toBe(true);
    expect(read(path.join(dist, 'mvp/assets/main-NEW.js'))).toBe('mvp/assets/main-NEW.js');
    // HTML и прочее прошлого релиза не переносится
    expect(read(path.join(dist, 'mvp/index.html'))).toBe('<html>');
  });

  it('окно: файл держится WINDOW после того, как перестал быть своим, потом — из пула и из сборки', () => {
    const pool = path.join(tmp, 'pool');
    keepAssets({ dist: build(['assets/main-A.js']), pool, now: 0 });
    let dist = build(['assets/main-B.js']);
    keepAssets({ dist, pool, now: 1 * H, windowMs: 48 * H });
    expect(read(path.join(dist, 'assets/main-A.js'))).toBe('assets/main-A.js');
    dist = build(['assets/main-C.js']);
    keepAssets({ dist, pool, now: 30 * H, windowMs: 48 * H });
    expect(fs.existsSync(path.join(dist, 'assets/main-A.js'))).toBe(true);
    expect(fs.existsSync(path.join(dist, 'assets/main-B.js'))).toBe(true);
    dist = build(['assets/main-D.js']);
    keepAssets({ dist, pool, now: 49 * H, windowMs: 48 * H });
    expect(fs.existsSync(path.join(dist, 'assets/main-A.js'))).toBe(false); // свой в последний раз в 0 ч
    expect(fs.existsSync(path.join(pool, 'assets/main-A.js'))).toBe(false);
    expect(fs.existsSync(path.join(dist, 'assets/main-B.js'))).toBe(true); // свой в 1 ч
    expect(fs.existsSync(path.join(dist, 'assets/main-C.js'))).toBe(true);
  });

  it('предел размера: вытесняются самые давние чужие, свои — никогда', () => {
    const pool = path.join(tmp, 'pool');
    keepAssets({ dist: build(['assets/a-1.js']), pool, now: 0 });
    keepAssets({ dist: build(['assets/b-2.js']), pool, now: 1 });
    const dist = build(['assets/c-3.js']);
    const r = keepAssets({ dist, pool, now: 2, capBytes: 30 });
    expect(fs.existsSync(path.join(dist, 'assets/a-1.js'))).toBe(false);
    expect(fs.existsSync(path.join(dist, 'assets/b-2.js'))).toBe(true);
    expect(fs.existsSync(path.join(dist, 'assets/c-3.js'))).toBe(true);
    expect(r.bytes).toBeLessThanOrEqual(30);
  });
});

// attach-extra: фильтр служебных файлов генераций и пропуск нечитаемых файлов (не роняет весь шаг)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error — .mjs без типов
import { attachExtra, skipEntry } from '../scripts/voice/attach-extra.mjs';

let tmp: string;
const put = (rel: string, body = rel) => {
  const f = path.join(tmp, 'src', rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
  return f;
};
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-extra-'));
  fs.mkdirSync(path.join(tmp, 'dist'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('attach-extra: фильтр', () => {
  it('служебные файлы генераций не копируются', () => {
    for (const n of ['glitter_p3_m6_task.json', 'glitter_p3_m6_img0.png', 'glitter_p3_m71_img12.png', 'glitter_p3_m6_thumb_front.png', 'glitter_p3_m6_geo.glb'])
      expect(skipEntry('models/props', n)).toBe(true);
  });
  it('готовые модели, превью, Vosk и озвучка копируются', () => {
    for (const n of ['glitter_p3_m6.glb', 'glitter_p3_m6.png', 'bed.glb', 'manifest.json', 'am', 'final.mdl'])
      expect(skipEntry('models/props', n)).toBe(false);
    expect(skipEntry('', 'models', true)).toBe(false);
  });
  it('прежние исключения на месте', () => {
    expect(skipEntry('', 'voice-el', true)).toBe(true);
    expect(skipEntry('', 'progress', true)).toBe(true);
    expect(skipEntry('voice', 'a.mp3.json')).toBe(true);
    expect(skipEntry('voice', '.tmp')).toBe(true);
    expect(skipEntry('models', 'progress', true)).toBe(false);
  });
});

describe('attach-extra: копирование', () => {
  it('копирует нужное, служебное пропускает', () => {
    put('models/vosk-small-ru/am/final.mdl');
    put('models/props/glitter_p3_m6.glb');
    put('models/props/glitter_p3_m6_task.json');
    put('models/props/glitter_p3_m6_geo.glb');
    put('progress/x.json');
    const r = attachExtra(path.join(tmp, 'src'), path.join(tmp, 'dist'), () => {});
    expect(r.files).toBe(2);
    expect(fs.existsSync(path.join(tmp, 'dist/models/vosk-small-ru/am/final.mdl'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'dist/models/props/glitter_p3_m6.glb'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'dist/models/props/glitter_p3_m6_task.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'dist/progress'))).toBe(false);
  });
  const eacces = () => Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
  it('нечитаемый файл — предупреждение и пропуск, остальное копируется', () => {
    put('models/props/aaa_locked.glb');
    put('models/props/zzz.glb');
    put('models/vosk-small-ru/am/final.mdl');
    const orig = fs.copyFileSync;
    const spy = vi.spyOn(fs, 'copyFileSync').mockImplementation((a, b, m) => {
      if (String(a).endsWith('aaa_locked.glb')) throw eacces();
      return orig(a, b, m);
    });
    const warns: string[] = [];
    try {
      const r = attachExtra(path.join(tmp, 'src'), path.join(tmp, 'dist'), (m: string) => warns.push(m));
      expect(r.files).toBe(2);
      expect(r.skipped).toEqual([{ path: path.join('models/props/aaa_locked.glb'), reason: 'EACCES' }]);
    } finally {
      spy.mockRestore();
    }
    expect(warns.join('\n')).toMatch(/aaa_locked\.glb/);
    expect(fs.existsSync(path.join(tmp, 'dist/models/vosk-small-ru/am/final.mdl'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'dist/models/props/zzz.glb'))).toBe(true);
  });
  it.skipIf(isRoot)('реально нечитаемый файл (chmod 000, не под root)', () => {
    fs.chmodSync(put('models/props/locked.glb'), 0o000);
    put('models/vosk-small-ru/am/final.mdl');
    const r = attachExtra(path.join(tmp, 'src'), path.join(tmp, 'dist'), () => {});
    expect(r.files).toBe(1);
    expect(r.skipped.length).toBe(1);
  });
  it('нечитаемая папка — пропуск, соседние копируются', () => {
    put('models/locked/x.glb');
    put('models/vosk-small-ru/am/final.mdl');
    const orig = fs.readdirSync;
    const spy = vi.spyOn(fs, 'readdirSync').mockImplementation(((d: string, o: unknown) => {
      if (String(d).endsWith('locked')) throw eacces();
      return orig(d, o as never);
    }) as never);
    try {
      const r = attachExtra(path.join(tmp, 'src'), path.join(tmp, 'dist'), () => {});
      expect(r.files).toBe(1);
      expect(r.skipped.map((x: { path: string }) => x.path)).toEqual([path.join('models/locked')]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('ar-auto: права после генерации (fixPerms)', () => {
  it('файлы 0644, каталоги 0755, владелец — как у родителя не от root', async () => {
    // @ts-expect-error — .mjs без типов
    const { fixPerms, extraOwner, extraDirsOf } = await import('../scripts/automation/ar-auto.mjs');
    const base = path.join(tmp, 'extra');
    fs.mkdirSync(base);
    if (isRoot) fs.chownSync(base, 65534, 65534);
    const old = process.umask(0o077);
    try {
      fs.mkdirSync(path.join(base, 'props/sub'), { recursive: true });
      fs.writeFileSync(path.join(base, 'props/glitter_p3_m6_task.json'), '{}');
      fs.writeFileSync(path.join(base, 'props/sub/x.glb'), 'g');
    } finally {
      process.umask(old);
    }
    const mode = (r: string) => fs.statSync(path.join(base, r)).mode & 0o777;
    expect(mode('props/glitter_p3_m6_task.json')).toBe(0o600);
    if (isRoot) expect(extraOwner(path.join(base, 'props'))).toEqual({ uid: 65534, gid: 65534 });
    fixPerms(path.join(base, 'props'));
    expect(mode('props')).toBe(0o755);
    expect(mode('props/sub')).toBe(0o755);
    expect(mode('props/glitter_p3_m6_task.json')).toBe(0o644);
    expect(mode('props/sub/x.glb')).toBe(0o644);
    if (isRoot) expect(fs.statSync(path.join(base, 'props/sub/x.glb')).uid).toBe(65534);
    expect(fixPerms(path.join(base, 'нет'))).toBe(0);
    const dirs = { meshy: 'M', props: 'P', voice: 'V' };
    expect(extraDirsOf('meshy', dirs)).toEqual(['M', 'P']);
    expect(extraDirsOf('tripo', dirs)).toEqual(['P']);
    expect(extraDirsOf('eleven', dirs)).toEqual(['V']);
    expect(extraDirsOf('script', dirs)).toEqual([]);
  });
});

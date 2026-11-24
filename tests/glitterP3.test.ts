import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
// @ts-expect-error — .mjs без типов (серверный скрипт без зависимостей)
import { pickModels, splitGlb } from '../scripts/meshy/image3d.mjs';

/** Блёстка p3 (пересоздание по развороту 23.11): входы генерации Tripo multiview */
describe('glitter p3: генерация по видам', () => {
  const d = JSON.parse(fs.readFileSync('scripts/models/t2m_prompts_v2.json', 'utf8'));
  const e = d.props.glitter_p3_tripo;

  it('виды front/left/back/right лежат в репо (PNG 1024)', () => {
    expect(Object.keys(e.views).sort()).toEqual(['back', 'front', 'left', 'right']);
    for (const f of Object.values(e.views) as string[]) {
      const b = fs.readFileSync(f);
      expect(b.subarray(1, 4).toString()).toBe('PNG');
      expect(b.readUInt32BE(16)).toBe(1024);
    }
  });

  it('props-run.sh: персонаж по видам — только явным --only, параметры проходят белый список', () => {
    const src = fs.readFileSync('scripts/tripo/props-run.sh', 'utf8');
    const m = /node -e '([\s\S]*?)' "\$WORK\/prompts.json"/.exec(src);
    expect(m).toBeTruthy();
    const run = (only: string) => execFileSync('node', ['-e', m![1], path.resolve('scripts/models/t2m_prompts_v2.json'), only], { encoding: 'utf8' });
    expect(run('')).not.toMatch(/glitter_p3_tripo/);
    const line = run('glitter_p3_tripo').trim().split('\t');
    expect(line[0]).toBe('glitter_p3_tripo');
    expect(line[1]).toBe('VIEWS');
    expect(line[2]).toMatch(/^front=design\/refs\/glitter_views\/front\.png /);
    for (const a of line[3].split(' ')) expect(a).toMatch(/^(--model=[a-z0-9.-]+|[a-z_]+=[A-Za-z0-9_.-]+)$/);
  });
});

describe('glitter p3: Meshy Multi-Image to 3D (image3d.mjs)', () => {
  const d = JSON.parse(fs.readFileSync('scripts/models/t2m_prompts_v2.json', 'utf8'));

  it('models3d: 4 вида из репо, параметры по белому списку, оценка в лимите', () => {
    const m = { pickModels, splitGlb };
    const ms = m.pickModels(d, ['glitter_p3_m71', 'glitter_p3_m6']);
    expect(ms).toHaveLength(2);
    for (const x of ms) {
      expect(x.images).toHaveLength(4);
      for (const f of x.images) expect(fs.existsSync(f)).toBe(true);
      expect(x.estimate).toBeLessThanOrEqual(60);
    }
    expect(() => m.pickModels({ models3d: { a: { images: ['x.png'], params: { image_urls: [] } } } }, ['a'])).toThrow(/не разрешён/);
    expect(() => m.pickModels({ models3d: { a: { images: ['../x.png'] } } }, ['a'])).toThrow(/плохой путь/);
  });

  it('splitGlb: сетка без картинок + картинки отдельно', () => {
    const m = { pickModels, splitGlb };
    const { glb, images } = m.splitGlb(fs.readFileSync('public/models/v2/glitter_p1.glb'));
    expect(images.length).toBeGreaterThan(0);
    expect(glb.length).toBeLessThan(fs.statSync('public/models/v2/glitter_p1.glb').size);
    const jl = glb.readUInt32LE(12);
    const json = JSON.parse(glb.subarray(20, 20 + jl).toString());
    expect(json.images.every((i: { uri?: string }) => i.uri)).toBe(true);
    expect(glb.readUInt32LE(8)).toBe(glb.length);
  });

  it('motion-run.sh: id из models3d → image3d.mjs, клипы — как прежде motion.mjs', () => {
    const src = fs.readFileSync('scripts/meshy/motion-run.sh', 'utf8');
    const m = /node -e '([^']+)' "\$WORK\/prompts.json" "\$ONLYV"/.exec(src);
    expect(m).toBeTruthy();
    const ok = (ids: string) => {
      try {
        execFileSync('node', ['-e', m![1], path.resolve('scripts/models/t2m_prompts_v2.json'), ids]);
        return true;
      } catch {
        return false;
      }
    };
    expect(ok(',glitter_p3_m71,glitter_p3_m6')).toBe(true);
    expect(ok(',wave')).toBe(false);
    expect(ok(',glitter_p3_m71,wave')).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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

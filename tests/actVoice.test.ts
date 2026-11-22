import { describe, expect, it } from 'vitest';
import { ACT_VOICE } from '../src/director';
import hooligan from '../content/personas/hooligan.json';
import kind from '../content/personas/kind.json';
import glitter from '../content/personas/glitter.json';

const P: Record<string, { lines: Record<string, { id: string; text: string }[]>; signature?: unknown }> = { hooligan, kind, glitter } as never;

describe('фирменное действие кнопкой — записанная реплика близкого события (ACT_VOICE)', () => {
  it('скейт, какао, зеркальце: у каждого id есть реплика в контенте своего кота, без призыва говорить', () => {
    expect(Object.keys(ACT_VOICE).sort()).toEqual(['cocoa', 'mirror', 'skate']);
    const owner: Record<string, string> = { skate: 'hooligan', cocoa: 'kind', mirror: 'glitter' };
    for (const [act, v] of Object.entries(ACT_VOICE)) {
      expect(v.ids.length, act).toBeGreaterThan(0);
      expect(v.at).toBeGreaterThanOrEqual(0);
      expect(v.at).toBeLessThan(1);
      for (const id of v.ids) {
        const [pid, ...rest] = id.split('.');
        expect(pid, id).toBe(owner[act]);
        const line = P[pid].lines[rest.slice(0, -1).join('.')]?.find((l) => l.id === id);
        expect(line, id).toBeTruthy();
        expect(line!.text).not.toMatch(/скажи|повторяй/i);
      }
    }
  });
});

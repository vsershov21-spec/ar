import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { START_IDS, startClipNames, clipKey, type PackClipDef } from '../src/character/animPacks';
import { TRIPO_ALIAS } from '../src/character/tripoAlias';

// имена клипов библиотеки по порядку — из JSON-части GLB (без декодирования буферов)
function libNames(file = 'public/models/anims_v1.glb'): string[] {
  const b = readFileSync(file);
  const len = b.readUInt32LE(12);
  const j = JSON.parse(b.subarray(20, 20 + len).toString('utf8'));
  return j.animations.map((a: { name: string }) => a.name);
}
const DEFS: PackClipDef[] = JSON.parse(readFileSync('content/animations.json', 'utf8')).clips;

/** как GlbCharacter: addClip по порядку (своё имя главнее, первый псевдоним выигрывает), монтаж cut, опора fallback */
function resolve(names: string[]): Map<string, string> {
  const slot = new Map<string, string>();
  const aliased = new Set<string>();
  const byKey = new Map(names.map((n) => [clipKey(n), n]));
  for (const n of names) {
    const k = clipKey(n);
    slot.set(k, n);
    aliased.delete(k);
    for (const a of TRIPO_ALIAS[k] ?? []) {
      if (slot.has(a) && !aliased.has(a)) continue;
      if (aliased.has(a)) continue;
      slot.set(a, n);
      aliased.add(a);
    }
  }
  for (const d of DEFS) {
    if (!d.cut?.keep?.length) continue;
    const alias = Object.keys(TRIPO_ALIAS).find((k) => TRIPO_ALIAS[k].includes(d.id) && byKey.has(k));
    const src = byKey.get(d.cut.src ?? '') ?? byKey.get(d.id) ?? (alias ? byKey.get(alias) : undefined);
    if (src) {
      slot.set(d.id, 'cut:' + src);
      aliased.delete(d.id);
    }
  }
  for (const d of DEFS) {
    if (!d.fallback) continue;
    if (slot.has(d.id) && !aliased.has(d.id)) continue;
    const base = slot.get(d.fallback);
    if (base) slot.set(d.id, 'fallback:' + base);
  }
  return slot;
}

describe('animPacks: стартовый пакет движений', () => {
  const names = libNames();
  const start = startClipNames(names, DEFS);

  it('меньше половины библиотеки, но не пустой', () => {
    expect(start.length).toBeGreaterThan(10);
    expect(start.length).toBeLessThan(names.length / 2);
  });

  it('под каждым стартовым id — тот же клип, что в полной библиотеке', () => {
    const full = resolve(names), part = resolve(start);
    for (const id of START_IDS) expect([id, part.get(id)]).toEqual([id, full.get(id)]);
  });

  it('порядок клипов — как в библиотеке (одинаковые имена — оба в одном пакете)', () => {
    const set = new Set(start);
    expect(start).toEqual(names.filter((n) => set.has(n)));
  });
});

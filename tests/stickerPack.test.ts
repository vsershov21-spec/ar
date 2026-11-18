import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PACK, PACK_THEMES, LEGACY, editionStickers, coverSet, nextRandom, collect, collection, resetCollectionCache, packSpec, packIdOf, MAX_ON_GLASS } from '../src/fx/stickerPack';
import { seeded } from './helpers/content';

const root = path.resolve(__dirname, '..');
const meta = (p: string) => JSON.parse(fs.readFileSync(path.join(root, `content/src/${p}.meta.json`), 'utf8'));
const PERSONAS = ['hooligan', 'kind', 'glitter'] as const;

describe('пак наклеек СберКота', () => {
  it('16–32 наклейки, id уникальны, у каждой есть SVG в public/stickers/sber', () => {
    expect(PACK.length).toBeGreaterThanOrEqual(16);
    expect(PACK.length).toBeLessThanOrEqual(32);
    expect(new Set(PACK.map((p) => p.id)).size).toBe(PACK.length);
    for (const p of PACK) {
      expect(p.src).toMatch(/^stickers\/sber\/[a-z_]+\.svg$/);
      const svg = fs.readFileSync(path.join(root, 'public', p.src), 'utf8');
      expect(svg.startsWith('<svg'), p.id).toBe(true);
      expect(svg.length, `${p.id}: лёгкий вектор`).toBeLessThan(12_000);
      // слова — контурами: на телефоне не зависят от шрифта; ни растров, ни внешних ссылок
      expect(svg).not.toMatch(/<text|<image|https?:\/\/(?!www\.w3\.org)/);
    }
  });

  it('манифест в public и в src совпадают', () => {
    const a = fs.readFileSync(path.join(root, 'public/stickers/sber/manifest.json'), 'utf8');
    const b = fs.readFileSync(path.join(root, 'src/fx/stickerPack.manifest.json'), 'utf8');
    expect(a).toBe(b);
  });

  it('все темы на месте: СберКот, Сбер, друзья кота, слова, три кота', () => {
    for (const t of Object.keys(PACK_THEMES)) expect(PACK.some((p) => p.theme === t), t).toBe(true);
    for (const pid of PERSONAS) expect(PACK.filter((p) => p.theme === pid).length, pid).toBeGreaterThanOrEqual(2);
  });

  it('ни грубых и «взрослых» надписей, ни логотипов', () => {
    const bad = /пох|хоп|йо|тут был|лох|отстой|дурак|сбер\s*(банк|id)|звук|2гис|окко|самокат|logo/i;
    for (const p of PACK) expect(`${p.id} ${p.title}`, p.id).not.toMatch(bad);
  });

  it('у каждого кота в meta.json — только наклейки пака, его тематические', () => {
    for (const pid of PERSONAS) {
      const st = meta(pid).stickers as { kind: string; src?: string; id?: string }[];
      expect(st.length).toBeGreaterThanOrEqual(4);
      for (const s of st) {
        expect(s.kind, pid).toBe('image');
        const p = PACK.find((x) => x.id === s.id);
        expect(p, `${pid}: ${s.id}`).toBeTruthy();
        expect(p!.src).toBe(s.src);
        expect(p!.personas.includes(pid) || p!.theme === pid, `${pid}: ${s.id}`).toBe(true);
      }
    }
  });
});

describe('подбор наклеек', () => {
  it('смена образа: не больше 8, из них 3 общих, остальные — тематические нового кота', () => {
    for (const pid of PERSONAS) {
      const themed = (meta(pid).stickers as { kind: 'image'; src: string; id: string }[]);
      const ids = new Set(themed.map((s) => s.id));
      for (let k = 0; k < 20; k++) {
        const set = coverSet(themed, 8, pid, seeded(k));
        expect(set.length).toBe(8);
        const common = set.filter((s) => !ids.has(packIdOf(s)!));
        expect(common.length).toBe(3);
        for (const c of common) expect(['cat', 'sber', 'words']).toContain(PACK.find((p) => p.id === packIdOf(c))!.theme);
      }
    }
    expect(coverSet([], 14).length).toBe(MAX_ON_GLASS);
    // старый пресет без пака — тематические по манифесту
    expect(coverSet([{ kind: 'star' }], 8, 'kind', seeded(1)).filter((s) => PACK.find((p) => p.id === s.id)?.personas.includes('kind')).length).toBeGreaterThanOrEqual(5);
  });

  it('«Чудеса → Наклейки»: случайная из пака, подряд не повторяется, за 200 раз — почти весь пак', () => {
    const rnd = seeded(3);
    let prev = '';
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const s = nextRandom(rnd);
      expect(s.id).not.toBe(prev);
      prev = s.id!;
      seen.add(prev);
    }
    expect(seen.size).toBeGreaterThanOrEqual(PACK.length - 2);
  });
});

describe('Хулиган: уличные наклейки', () => {
  it('у Хулигана больше всех наклеек, смена образа берёт из всего его набора', () => {
    const themed = meta('hooligan').stickers as { kind: 'image'; src: string; id: string }[];
    expect(themed.length).toBeGreaterThanOrEqual(12);
    for (const id of ['h_bam', 'h_ogon', 'h_legend', 'h_bolt', 'h_spray', 'h_sneaker', 'h_cap']) expect(themed.map((s) => s.id)).toContain(id);
    const seen = new Set<string>();
    for (let k = 0; k < 60; k++) for (const s of coverSet(themed, 8, 'hooligan', seeded(k))) seen.add(packIdOf(s)!);
    for (const s of themed) expect(seen.has(s.id), s.id).toBe(true);
  });

  it('уличные слова проверены (docs/stickers/WORDS_CHECK.md) и не складываются в грубое ни в какую сторону', () => {
    const doc = fs.readFileSync(path.join(root, 'docs/stickers/WORDS_CHECK.md'), 'utf8');
    const words = PACK.filter((p) => p.theme === 'hooligan' && /^«/.test(p.title)).map((p) => p.title.replace(/[«»!]/g, '').toUpperCase());
    expect(words.length).toBeGreaterThanOrEqual(3);
    const bad = /ПОХ|ХОП|ХУ|ЙО|ЖОП|ЛОХ|БЛЯ|СУК|ПИЗ|ЕБ|ЁБ|ГОВН|СРА|ДУР|ТУП|УБ[ЬИ]|ПУШК|БОМБ/;
    for (const w of words) {
      expect(doc, `${w} — нет в таблице проверки`).toContain(w);
      const forms = [w, [...w].reverse().join(''), w.slice(1), w.slice(0, -1), [...w.slice(1)].reverse().join(''), [...w.slice(0, -1)].reverse().join('')];
      for (const f of forms) expect(f, w).not.toMatch(bad);
    }
  });

  it('надписи-картинки пака не зеркалятся', () => {
    const src = fs.readFileSync(path.join(root, 'src/fx/stickers.ts'), 'utf8');
    expect(src).toMatch(/mirrored && spec\.kind !== 'text' && spec\.kind !== 'tag' && spec\.kind !== 'image'/);
  });
});

describe('коллекция «собрал N из M»', () => {
  beforeEach(() => {
    const m = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k),
    };
    resetCollectionCache();
  });

  it('считает уникальные, переживает перезапуск, чужие id не берёт', () => {
    expect(collection().n).toBe(0);
    expect(collect(packSpec(PACK[0]))).toBe(true);
    expect(collect(packSpec(PACK[0]))).toBe(false);
    expect(collect({ kind: 'image', src: PACK[1].src })).toBe(true);
    expect(collect({ kind: 'star' })).toBe(false);
    resetCollectionCache();
    expect(collection()).toMatchObject({ n: 2, total: PACK.length });
    localStorage.setItem('ar.stickers.collected', JSON.stringify(['nope', PACK[2].id]));
    resetCollectionCache();
    expect(collection().ids).toEqual([PACK[2].id]);
  });
});

describe('редакции: MVP без пака', () => {
  it('прежние наклейки кота — без грубых надписей и без зеркальных «ХОП»', () => {
    for (const set of Object.values(LEGACY))
      for (const s of set) expect(`${s.kind} ${s.text ?? ''}`).not.toMatch(/пох|хоп|йо|тут был|кот\b|skull/i);
  });
  it('пак выключен — у каждого кота свои прежние наклейки; включён — пак как в meta.json', () => {
    for (const pid of PERSONAS) {
      const st = meta(pid).stickers;
      expect(editionStickers(st, true)).toBe(st);
      expect(editionStickers(st, false)).toBe(LEGACY[pid]);
    }
    const old = [{ kind: 'heart' as const }];
    expect(editionStickers(old, false)).toBe(old);
  });
});

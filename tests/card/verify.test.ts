/**
 * «Это банковская карта Сбера?» — проверка по содержимому (src/tracker/card/verify.ts).
 *
 * Реальные кадры (tests/fixtures/cards/real.json): записи экрана iPhone продакта — карта Сбера (персональный
 * дизайн, белый знак на тёмно-синем) на столе, рядом бутылка; номер/имя/срок размыты. Поверх видео на записях
 * нарисованы UI и кот — это хуже, чем то, что видит детектор в приложении (там чистый кадр камеры).
 * Плюс фото той же карты. Синтетика: процедурные дизайны (tests/helpers/cardDesigns.ts) и уменьшенные дизайны
 * из каталога карт Сбера (tests/fixtures/cards/designs) на столе с наклоном, шумом, размытием.
 *
 * EXPLORE=1 — печать сводки (цифры для docs/CARD_DETECTION.md).
 */
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { readFileSync, readdirSync } from 'node:fs';
import { CardEvidence, classifyCard, HIT, type CardKind, type CardVerdict } from '../../src/tracker/card/verify';
import { renderCardScene, rng, type Tex } from '../helpers/synthCard';
import { design, SBER_DESIGNS, OTHER_DESIGNS, NOT_CARDS, NOT_CARD_SHAPE } from '../helpers/cardDesigns';

const FIX = new URL('../fixtures/cards/', import.meta.url).pathname;
const log = (...a: unknown[]) => process.env.EXPLORE && console.log(...a);

interface Img {
  rgba: Uint8ClampedArray;
  w: number;
  h: number;
}
async function load(f: string, width?: number): Promise<Img> {
  let s = sharp(f).ensureAlpha();
  if (width) s = s.resize({ width, kernel: 'linear' as never });
  const { data, info } = await s.raw().toBuffer({ resolveWithObject: true });
  return { rgba: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), w: info.width, h: info.height };
}

interface Fixture {
  file: string;
  w: number;
  h: number;
  cands: { q: [number, number][]; card: 0 | 1 }[];
}
const real: { frames: Fixture[] } = JSON.parse(readFileSync(FIX + 'real.json', 'utf8'));

/** классификация кандидатов реального кадра: hi — кадр как есть (384 px), lo — как в детекторе (320 px по длинной) */
async function classifyFixture(fx: Fixture) {
  const hi = await load(FIX + fx.file);
  const k = 320 / Math.max(hi.w, hi.h);
  const lo = await load(FIX + fx.file, Math.round(hi.w * k));
  const kk = lo.w / hi.w;
  return fx.cands.map((c) => {
    const q = c.q.map(([x, y]) => ({ x, y }));
    const ql = c.q.map(([x, y]) => ({ x: (x + 0.5) * kk - 0.5, y: (y + 0.5) * kk - 0.5 }));
    return { card: c.card, hi: classifyCard(hi, q)!, lo: classifyCard(lo, ql)! };
  });
}

describe('карта Сбера на реальных кадрах', () => {
  it('фото персональной карты: чип и знак Сбера (белый контур на фото) находятся', async () => {
    const fx = real.frames.find((f) => f.file.startsWith('photo'))!;
    const [r] = await classifyFixture(fx);
    log('photo hi', r.hi.f, 'lo', r.lo.f);
    expect(r.hi.f.chip).toBeGreaterThanOrEqual(HIT.chip);
    expect(r.hi.f.logo).toBeGreaterThanOrEqual(HIT.logo);
    expect(r.hi.sber).toBeGreaterThan(0.5);
    // та же карта мельче (≈ 180 px шириной — как в кадре детектора на 320 px): чип виден, знак — уже на грани
    expect(r.lo.f.chip).toBeGreaterThanOrEqual(HIT.chip);
  });

  it('записи экрана: карта Сбера набирает уверенность за несколько кадров, бутылка/стол/экран — никогда', async () => {
    const frames = real.frames.filter((f) => !f.file.startsWith('photo'));
    const evHi = new CardEvidence(), evLo = new CardEvidence(), negHi = new CardEvidence(), negLo = new CardEvidence();
    const pos: CardVerdict[] = [], neg: CardVerdict[] = [], posLo: CardVerdict[] = [], negLo2: CardVerdict[] = [];
    let firstHi = -1, firstLo = -1, i = 0;
    const negStates = new Set<CardKind>();
    for (const fx of frames) {
      const rs = await classifyFixture(fx);
      // одна «дорожка» на кадр: лучший по детектору кандидат-карта (первый в списке)
      const p = rs.find((r) => r.card === 1);
      if (p) {
        i++;
        pos.push(p.hi);
        posLo.push(p.lo);
        if (evHi.push(p.hi) === 'sber' && firstHi < 0) firstHi = i;
        if (evLo.push(p.lo) === 'sber' && firstLo < 0) firstLo = i;
      }
      for (const r of rs.filter((r) => r.card === 0)) {
        neg.push(r.hi);
        negLo2.push(r.lo);
        // все не-карты подряд в одну «дорожку» — строже, чем в жизни
        negStates.add(negHi.push(r.hi));
        negStates.add(negLo.push(r.lo));
      }
    }
    const rate = (a: CardVerdict[], f: (v: CardVerdict) => boolean) => a.filter(f).length / a.length;
    const sum = {
      positives: pos.length,
      negatives: neg.length,
      hi: { logoHit: rate(pos, (v) => v.f.logo >= HIT.logo), chipHit: rate(pos, (v) => v.f.chip >= HIT.chip), negLogoHit: rate(neg, (v) => v.f.logo >= HIT.logo), negChipHit: rate(neg, (v) => v.f.chip >= HIT.chip), firstSberFrame: firstHi },
      lo: { logoHit: rate(posLo, (v) => v.f.logo >= HIT.logo), chipHit: rate(posLo, (v) => v.f.chip >= HIT.chip), negLogoHit: rate(negLo2, (v) => v.f.logo >= HIT.logo), negChipHit: rate(negLo2, (v) => v.f.chip >= HIT.chip), firstSberFrame: firstLo },
      negStates: [...negStates],
    };
    log('real', JSON.stringify(sum));
    expect(firstHi).toBeGreaterThan(0);
    expect(firstHi).toBeLessThanOrEqual(5);
    expect(firstLo).toBeGreaterThan(0);
    expect(sum.hi.negLogoHit).toBeLessThanOrEqual(0.03);
    expect(sum.hi.negChipHit).toBeLessThanOrEqual(0.03);
    expect(negStates.has('sber')).toBe(false);
    expect(negStates.has('card')).toBe(false);
  }, 60000);
});

/** короткая «съёмка» одного предмета: 3 кадра с дрожанием позы и шумом */
function shoot(tex: Tex, seed: number, shape?: { aspect: number; radius: number }, n = 3) {
  const R = rng(seed);
  const bgs = ['wood', 'plain', 'dark', 'white', 'clutter'] as const;
  const base = { tilt: 10 + R() * 40, yaw: (R() - 0.5) * 50 + (R() < 0.2 ? 180 : 0), dist: 2 + R() * 0.7, ox: (R() - 0.5) * 0.2, oy: (R() - 0.5) * 0.2, bg: bgs[Math.floor(R() * bgs.length)], light: 0.7 + R() * 0.4 };
  const out: CardVerdict[] = [];
  for (let k = 0; k < n; k++) {
    const f = renderCardScene({ w: 480, h: 360, ...base, tilt: base.tilt + k * 2, yaw: base.yaw + k, tex, shape, noise: 3, blur: k === 1 ? 1 : 0, seed: seed + 1, noiseSeed: k + 1 });
    // углы — как у детектора: с ошибкой до ±0,7 px
    const q = f.corners.map((c) => ({ x: c.x + (R() - 0.5) * 1.4, y: c.y + (R() - 0.5) * 1.4 }));
    out.push(classifyCard(f, q, { f: f.focal, cx: f.w / 2, cy: f.h / 2 })!);
  }
  return out;
}
function verdictOf(vs: CardVerdict[]) {
  const ev = new CardEvidence();
  let s: CardKind = 'unknown';
  for (const v of vs) s = ev.push(v);
  return s;
}

describe('синтетика: дизайны карт и предметы-негативы', () => {
  it('карты Сбера (процедурные и из каталога) → «Сбер»; карты других банков — не Сбер; оборот — «переверни»', async () => {
    const res: Record<string, Record<string, number>> = {};
    const add = (g: string, s: CardKind) => ((res[g] ??= {}), (res[g][s] = (res[g][s] ?? 0) + 1));
    let seed = 1;
    for (const k of SBER_DESIGNS) for (let s = 1; s <= 1; s++) add('sber-synth', verdictOf(shoot(design(k, s), seed++)));
    for (const f of readdirSync(FIX + 'designs').sort()) add('sber-catalog', verdictOf(shoot(await load(FIX + 'designs/' + f), seed++)));
    for (const k of OTHER_DESIGNS) for (let s = 1; s <= 2; s++) add('other', verdictOf(shoot(design(k, s), seed++)));
    for (const k of ['back', 'back-sber'] as const) add('back', verdictOf(shoot(design(k, 1), seed++)));
    log('synth cards', JSON.stringify(res));
    const n = (g: string) => Object.values(res[g]).reduce((a, b) => a + b, 0);
    expect((res['sber-synth'].sber ?? 0) / n('sber-synth')).toBeGreaterThanOrEqual(0.85);
    expect((res['sber-catalog'].sber ?? 0) / n('sber-catalog')).toBeGreaterThanOrEqual(0.85);
    expect(res.other.sber ?? 0).toBe(0);
    expect(res.back.sber ?? 0).toBe(0);
  }, 120000);

  it('не карты (лист, книга, телефон, ноутбук, коробка, экран, тетрадь) — ни «Сбер», ни «карта»', () => {
    const res: Record<string, number> = {};
    let seed = 500;
    for (const k of NOT_CARDS) for (let s = 1; s <= 2; s++) {
      const st = verdictOf(shoot(design(k, s), seed++, NOT_CARD_SHAPE[k]));
      res[st] = (res[st] ?? 0) + 1;
    }
    log('synth not-cards', JSON.stringify(res));
    expect(res.sber ?? 0).toBe(0);
    expect(res.card ?? 0).toBe(0);
  }, 120000);
});

describe('накопление уверенности', () => {
  const v = (logo: number, chip: number, back = 0, sharp = 1): CardVerdict => ({ card: 0, sber: logo, side: back > chip ? 'back' : 'front', ms: 0, f: { chip, back, logo, green: 0, ps: 0, corners: 0.5, tex: 1, flat: 0, sharp, px: 150 } });
  it('один удачный кадр — ещё не Сбер; два — Сбер', () => {
    const ev = new CardEvidence();
    expect(ev.push(v(0.9, 0.8))).toBe('unknown');
    expect(ev.push(v(0.2, 0.8))).toBe('unknown');
    expect(ev.push(v(0.8, 0.5))).toBe('sber');
  });
  it('размытые кадры не голосуют', () => {
    const ev = new CardEvidence();
    for (let i = 0; i < 10; i++) ev.push(v(0, 0, 0, 0.1));
    expect(ev.state).toBe('unknown');
  });
  it('чужая карта — только после 10+ кадров с чипом и без знака', () => {
    const ev = new CardEvidence();
    const st: CardKind[] = [];
    for (let i = 0; i < 12; i++) st.push(ev.push(v(0.1, 0.9)));
    expect(st.slice(0, 9).every((s) => s === 'unknown')).toBe(true);
    expect(st[11]).toBe('card');
  });
  it('не карта — 6 кадров без признаков', () => {
    const ev = new CardEvidence();
    for (let i = 0; i < 6; i++) ev.push(v(0, 0.1));
    expect(ev.state).toBe('notcard');
  });
});

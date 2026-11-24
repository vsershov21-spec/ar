/**
 * CARD-01/02 (независимый аудит 24.11): кот сидел на карте Сбера, карту убрали (HOLD → RELOCALIZE), на то же место
 * положили карту другого банка — раньше первый же её кадр возвращал кота (locked за ~83 мс) с прежним классом «sber»:
 * машина состояний в HOLD/RELOCALIZE сажала по одной геометрии, а ключевой кадр переснимался на чужую карту.
 * Теперь повторная посадка — только по свежей проверке класса ЭТОГО кандидата (pipeline.ts fresh), геометрия — подсказка;
 * после LOST окно проверки начинается заново (verifier.ts). Своя карта возвращается так же быстро, как раньше.
 * Тот же сценарий на кадрах аудита (960 × 540, card.png) — отчёт в коммите; здесь — синтетика из каталога дизайнов.
 */
import { describe, expect, it } from 'vitest';
import { CardPipeline } from '../../src/tracker/card/pipeline';
import { CardSession } from '../../src/tracker/card/session';
import { renderCardScene, type Tex } from '../helpers/synthCard';
import { design } from '../helpers/cardDesigns';
import sharp from 'sharp';

function half(f: { rgba: Uint8ClampedArray; w: number; h: number }) {
  const w = f.w >> 1, h = f.h >> 1, o = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let k = 0; k < 4; k++) {
        const a = (2 * y * f.w + 2 * x) * 4 + k;
        o[(y * w + x) * 4 + k] = (f.rgba[a] + f.rgba[a + 4] + f.rgba[a + f.w * 4] + f.rgba[a + f.w * 4 + 4]) / 4;
      }
  return { rgba: o, w, h };
}

type Shot = { lo: { rgba: Uint8ClampedArray; w: number; h: number }; hi: { rgba: Uint8ClampedArray; w: number; h: number }; focal: number };
const shots = (tex: Tex | null): Shot[] =>
  [0, 1, 2].map((i) => {
    const hi = renderCardScene({ w: 640, h: 480, tilt: 32, yaw: 10, dist: 2.4, ox: 0, oy: 0, bg: 'wood', tex: tex ?? undefined, noCard: !tex, noise: 3, seed: 4, noiseSeed: i + 1 });
    return { hi, lo: half(hi), focal: hi.focal / 2 };
  });

// своя карта — макет из пилота (public/targets/card.png, как на кадрах аудита), чужая — карта другого банка из каталога
const png = await sharp('public/targets/card.png').removeAlpha().resize({ width: 512, height: 323, fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const cardTex: Tex = { rgba: new Uint8ClampedArray(png.data), w: png.info.width, h: png.info.height };
const media = { sber: shots(cardTex), foreign: shots(design('other-green', 2)), blank: shots(null) };
type Label = keyof typeof media;

interface StepOut { label: Label; frames: number; locked: number; newLocks: number; firstLockMs: number | null; found: number; lost: number; end: string }

function run(spec: [Label, number][]): StepOut[] {
  const pipe = new CardPipeline(), sess = new CardSession(true);
  const f0 = media.sber[0];
  sess.K = { f: f0.focal, cx: f0.lo.w / 2, cy: f0.lo.h / 2 };
  sess.w = f0.lo.w;
  sess.h = f0.lo.h;
  let t = 0;
  const out: StepOut[] = [];
  for (const [label, count] of spec) {
    const start = t;
    const s: StepOut = { label, frames: count, locked: 0, newLocks: 0, firstLockMs: null, found: 0, lost: 0, end: '' };
    for (let i = 0; i < count; i++) {
      t += 83.333;
      const m = media[label][i % 3];
      const before = sess.state;
      const req = sess.request(t, null);
      const r = pipe.process({ rgba: m.lo.rgba, w: m.lo.w, h: m.lo.h, focal: m.focal, verify: true, ...req, crop: { img: m.hi, x0: 0, y0: 0, w: m.lo.w, h: m.lo.h } });
      if (!r) continue;
      const st = sess.onResult(r, null, t, NaN, t);
      if (st.found) s.found++;
      if (st.lost) s.lost++;
      if (sess.state === 'locked') {
        s.locked++;
        if (before !== 'locked') s.newLocks++;
        s.firstLockMs ??= Math.round(t - start);
      }
    }
    s.end = sess.state;
    out.push(s);
  }
  return out;
}

describe('CARD-01/02: после потери карты чужая карта на том же месте кота не получает', () => {
  it('lock → пустые (RELOCALIZE) → чужая: 0 новых locked; своя карта снова — за ≤ 0,3 с', () => {
    const [first, blank, foreign, back] = run([['sber', 30], ['blank', 28], ['foreign', 30], ['sber', 20]]);
    expect(first.newLocks).toBe(1);
    expect(blank.end).toBe('relocalize');
    expect(foreign.newLocks).toBe(0);
    expect(foreign.locked).toBe(0);
    expect(back.newLocks).toBe(1);
    expect(back.firstLockMs!).toBeLessThanOrEqual(300);
  }, 120000);

  it('короткая потеря (HOLD) → чужая: не садим; своя после HOLD — за ≤ 0,3 с', () => {
    const [, blank, sber, blank2, foreign, back] = run([['sber', 30], ['blank', 8], ['sber', 10], ['blank', 8], ['foreign', 20], ['sber', 10]]);
    expect(blank.end).toBe('hold');
    expect(sber.firstLockMs!).toBeLessThanOrEqual(300);
    expect(blank2.end).toBe('hold');
    expect(foreign.locked).toBe(0);
    expect(back.firstLockMs!).toBeLessThanOrEqual(300);
  }, 120000);

  it('чужая карта на месте своей до LOST и после: прежний «sber» не наследуется, своя — снова по проверке', () => {
    // чужая лежит дольше LOST_MAX_MS: кот спрашивает «Где карта?», кандидат — с нуля (раньше окно проверки
    // сохраняло «sber», и через RELAND_MS кот садился на чужую)
    const [, , foreign, sber] = run([['sber', 30], ['blank', 28], ['foreign', 170], ['sber', 30]]);
    expect(foreign.lost).toBe(1);
    expect(foreign.locked).toBe(0);
    expect(sber.newLocks).toBe(1);
    expect(sber.found).toBe(1);
  }, 120000);
});

describe('AR-05: «карта потеряна» — одно событие на подтверждённую посадку', () => {
  it('locked → lost → (candidate ↔ lost) × 10 — один lost; следующая посадка → потеря — ещё ровно один', () => {
    const spec: [Label, number][] = [['sber', 30], ['blank', 80]];
    for (let k = 0; k < 10; k++) spec.push(['foreign', 4], ['blank', 8]);
    spec.push(['sber', 30], ['blank', 80]);
    const steps = run(spec);
    const lostAt = (from: number, to: number) => steps.slice(from, to).reduce((s, x) => s + x.lost, 0);
    expect(steps[1].lost).toBe(1);
    // кандидат действительно появлялся и пропадал (а не «молчал»)
    const flips = steps.slice(2, 22).filter((s) => s.label === 'foreign' && s.end === 'candidate').length;
    expect(flips).toBeGreaterThanOrEqual(8);
    expect(lostAt(2, 22)).toBe(0);
    expect(steps[22].newLocks).toBe(1);
    expect(steps[22].found).toBe(1);
    expect(steps[23].lost).toBe(1);
    expect(lostAt(0, steps.length)).toBe(2);
  }, 180000);
});

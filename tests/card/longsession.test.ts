/**
 * Долгая сессия (5 мин) с котом на карте: медленный дрейф света (тусклее/теплее и обратно), дрейф телефона,
 * рука ребёнка на карте (палец и ладонь), карта частично за краем кадра, увод камеры с карты и возврат (короткий
 * и долгий — до «Где карта?»), рядом лежит карта другого банка. Кот в кадре камеры не рисуется (он только на
 * экране), рука — рисуется. Требования: ни одной ложной пересадки, кот не «переезжает» на чужую карту, после
 * возврата снова на карте.
 *
 *   LONG=1 npx vitest run tests/card/longsession.test.ts        — 5 мин (≈ 3–4 мин счёта)
 *   LONG=1 LONG_S=60 …                                         — короче
 * Короткая версия (40 с) входит в обычный прогон.
 */
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { readdirSync } from 'node:fs';
import { runBench, type BenchResult, type Scenario } from '../helpers/cardBench';
import { BenchCardSession } from '../helpers/newSession';
import { sceneCorners, type SynthOptions, type Tex } from '../helpers/synthCard';
import { focalFromFov } from '../../src/tracker/card/detector';
import { CARD_CM, panoFrames } from '../helpers/stress';
import { design } from '../helpers/cardDesigns';

async function fixture(name: string): Promise<Tex> {
  const dir = new URL('../fixtures/cards/designs/', import.meta.url).pathname;
  const f = readdirSync(dir).find((x) => x.includes(name))!;
  const { data, info } = await sharp(dir + f).removeAlpha().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { rgba: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), w: info.width, h: info.height };
}

/** события сценария: [начало, конец) в секундах */
interface Plan {
  pans: [number, number, number][]; // увод камеры: начало, длительность, угол°
  edge: [number, number][]; // карта наполовину за краем
  finger: [number, number][];
  palm: [number, number][];
}

function plan(T: number): Plan {
  const pans: [number, number, number][] = [];
  for (let t = 25; t + 10 < T; t += 40) pans.push([t, t % 80 === 65 ? 9 : 3, t % 80 === 25 ? 30 : -30]);
  return {
    pans,
    edge: T > 100 ? [[100, 110]] : [[12, 17]],
    finger: T > 100 ? [[55, 68], [200, 210]] : [[6, 10]],
    palm: T > 100 ? [[150, 158], [250, 256]] : [[20, 23]],
  };
}
const inAny = (t: number, r: [number, number][]) => r.some(([a, b]) => t >= a && t < b);
const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * x));

export function longScenario(T: number, tex: Tex, other: Tex): Scenario {
  const w = 320, h = 240, K = 2;
  const P = plan(T);
  const base: SynthOptions = { tilt: 38, yaw: 12, dist: 26 / CARD_CM, bg: 'wood', noise: 2.5, seed: 21, tableOnPlane: true, tex, card2: { tex: other, x: 1.45, y: 0.05, rot: 8 } };
  const rot = (t: number): [number, number, number] => {
    let ry = 2.5 * Math.sin(t * 0.13) + 0.2 * Math.sin(t * 53 + 1);
    let rx = 2 * Math.sin(t * 0.09 + 1) + 0.15 * Math.sin(t * 47) + 0.1 * Math.sin(t * 71);
    // увод камеры с карты (кивок вверх/вниз на 30°: карта целиком уходит из кадра) и возврат
    for (const [a, d, ang] of P.pans) rx += ang * (ease((t - a) / 0.8) - ease((t - a - d) / 0.8));
    // карта наполовину за краем: поворот вбок на 24°
    for (const [a, b] of P.edge) ry += 24 * (ease((t - a) / 1.5) - ease((t - b + 1.5) / 1.5));
    return [rx, ry, 0.6 * Math.sin(t * 0.05)];
  };
  // свет: медленно тускнеет и теплеет (период 2 мин), минимум 45 %
  const light = (t: number) => {
    const k = 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / 120);
    return { l: 1 - 0.55 * k, r: 1 + 0.08 * k, b: 1 - 0.2 * k };
  };
  const gtAt = (t: number) => sceneCorners({ ...base, w, h, camRot: rot(t) });
  const post = (t: number, out: Uint8ClampedArray, W: number, H: number) => {
    const L = light(t);
    for (let i = 0; i < out.length; i += 4) {
      out[i] = out[i] * L.l * L.r;
      out[i + 1] = out[i + 1] * L.l;
      out[i + 2] = out[i + 2] * L.l * L.b;
    }
    // рука ребёнка: капсула от нижнего края к точке на карте (палец ~ 1/4 ширины карты, ладонь ~ 2/3)
    const finger = inAny(t, P.finger), palm = inAny(t, P.palm);
    if (!finger && !palm) return;
    const q = gtAt(t).map((p) => ({ x: (p.x + 0.5) * K - 0.5, y: (p.y + 0.5) * K - 0.5 }));
    const cw = Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y);
    const u = finger ? 0.35 + 0.25 * Math.sin(t * 1.3) : 0.55, v = finger ? 0.45 : 0.55;
    const tip = { x: (1 - v) * ((1 - u) * q[0].x + u * q[1].x) + v * ((1 - u) * q[3].x + u * q[2].x), y: (1 - v) * ((1 - u) * q[0].y + u * q[1].y) + v * ((1 - u) * q[3].y + u * q[2].y) };
    const r = cw * (finger ? 0.12 : 0.36);
    const from = { x: tip.x + W * 0.15, y: H + r };
    const dx = tip.x - from.x, dy = tip.y - from.y, dd = dx * dx + dy * dy;
    for (let y = Math.max(0, Math.floor(tip.y - r)); y < H; y++)
      for (let x = 0; x < W; x++) {
        const tt = Math.max(0, Math.min(1, ((x - from.x) * dx + (y - from.y) * dy) / dd));
        const d = Math.hypot(x - from.x - dx * tt, y - from.y - dy * tt);
        if (d >= r) continue;
        const k = 0.78 + 0.22 * (1 - (d / r) ** 2);
        const o = (y * W + x) * 4;
        out[o] = 214 * k * L.l;
        out[o + 1] = 160 * k * L.l;
        out[o + 2] = 128 * k * L.l;
      }
  };
  return {
    name: `долгая сессия ${T} с`,
    duration: T,
    verify: true,
    w,
    h,
    focal: focalFromFov(w, h, 63),
    frame: () => null,
    hi: panoFrames(base, w, h, K, 3.4, rot, 5, post),
    hiK: K,
    gt: gtAt,
    rot,
  };
}

export async function runLong(T: number): Promise<BenchResult> {
  const sc = longScenario(T, await fixture('122'), design('other-green', 2));
  return runBench(sc, () => new BenchCardSession(true));
}

const fmt = (r: BenchResult) =>
  `посадка ${r.tLock.toFixed(2)} с · в ведении ${(100 * r.locked).toFixed(1)} % · кот скрыт при карте в кадре ${(100 * (r.hiddenFrac ?? 0)).toFixed(1)} % · «не там» ${(100 * (r.farFrac ?? 0)).toFixed(2)} % · ` +
  `ошибка ${r.err.toFixed(2)} / p90 ${r.p90.toFixed(2)} px · уходов из ведения ${r.losses} (ложных ${r.falseLoss}) · «где карта?» ${r.lostEvents} · пересадок ${r.reanchors} · воркер ${r.workerMs?.toFixed(1)} мс`;

describe('долгая сессия: свет, рука, край, уходы и возвраты, чужая карта рядом', () => {
  it('40 с: без ложных пересадок, кот не уходит на чужую карту', async () => {
    const r = await runLong(40);
    console.log('long40', fmt(r));
    expect(r.tLock).toBeGreaterThanOrEqual(0);
    expect(r.reanchors).toBe(0);
    expect(r.farFrac ?? 0).toBeLessThan(0.01);
    expect(r.err).toBeLessThan(4);
  }, 600_000);
  it.skipIf(!process.env.LONG)('5 мин', async () => {
    const r = await runLong(+(process.env.LONG_S ?? 300));
    console.log('long', fmt(r), JSON.stringify(r.states));
    expect(r.reanchors).toBe(0);
    expect(r.farFrac ?? 0).toBeLessThan(0.01);
  }, 3_600_000);
});

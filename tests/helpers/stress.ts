/**
 * Условия стресс-набора трекера карты: наклон, расстояние, поворот в плоскости, блики, свет, смаз, шум, палец,
 * столы. Одна точка правды для калибровки базы отпечатков (designdb.gen.test.ts) и стенда (stress.test.ts).
 */
import { renderCardScene, camMatrix, motionBlur, boxBlur, rng, type SynthOptions } from './synthCard';
import { focalFromFov } from '../../src/tracker/card/detector';

/** ширина карты, см */
export const CARD_CM = 8.56;
export const TABLES = ['wood', 'white', 'dark', 'check', 'gloss'] as const;
export type Table = (typeof TABLES)[number];

export const LIGHTS = {
  норм: { light: 1 },
  тёплый: { light: 0.95, tint: [1.12, 0.96, 0.72] as [number, number, number] },
  холодный: { light: 1, tint: [0.82, 0.96, 1.18] as [number, number, number] },
  тусклый: { light: 0.38, noise: 7 },
} satisfies Record<string, Partial<SynthOptions>>;

/** случайные условия (калибровка): R — генератор 0..1 */
export function randomCond(R: () => number): SynthOptions {
  const lights = Object.values(LIGHTS);
  const L = lights[Math.floor(R() * lights.length)];
  const cm = 15 + R() * 30;
  const o: SynthOptions = {
    tilt: 20 + R() * 45,
    yaw: R() * 360,
    dist: cm / CARD_CM,
    ox: (R() - 0.5) * 0.15,
    oy: (R() - 0.5) * 0.15,
    bg: TABLES[Math.floor(R() * TABLES.length)],
    noise: 2.5,
    ...L,
  };
  const x = R();
  if (x < 0.2) o.glareSpots = 1 + Math.floor(R() * 3);
  else if (x < 0.35) o.motion = [(R() - 0.5) * 8, (R() - 0.5) * 8];
  else if (x < 0.5) o.fingerCard = R() < 0.5 ? { u: 0.08, v: 0.12 } : { u: 0.9 + R() * 0.08, v: 0.85 };
  else if (x < 0.6) o.blur = 1;
  return o;
}

/** короткая подпись условий (сводки) */
export function condLabel(o: SynthOptions): string {
  const t: string[] = [];
  if (o.glareSpots) t.push('блик');
  if (o.motion) t.push('смаз');
  if (o.fingerCard) t.push('палец');
  if (o.blur) t.push('размыто');
  if (o.tint) t.push(o.tint[2] < 1 ? 'тёплый' : 'холодный');
  if ((o.light ?? 1) < 0.6) t.push('тусклый');
  if ((o.dist ?? 0) * CARD_CM > 35) t.push('далеко');
  if ((o.tilt ?? 0) > 50) t.push('наклон>50');
  return t.join('+') || 'норм';
}

/**
 * Кадры камеры ×K для неподвижной сцены и поворачивающегося телефона: панорама рендерится один раз (шире кадра в
 * margin раз), каждый кадр — её проекция через гомографию поворота K·R·K⁻¹ (в 20 раз быстрее рендера), затем смаз,
 * размытие, шум. post(t, rgba, W, H) — свои изменения кадра (свет, рука).
 */
export function panoFrames(
  base: SynthOptions,
  w: number,
  h: number,
  K: number,
  margin: number,
  rot: (t: number) => [number, number, number],
  seed: number,
  post?: (t: number, out: Uint8ClampedArray, W: number, H: number) => void,
) {
  const W = w * K, H = h * K, f = focalFromFov(W, H, base.hfov ?? 63);
  const PW = Math.round(W * margin), PH = Math.round(H * margin);
  const pano = renderCardScene({ ...base, w: PW, h: PH, hfov: (2 * Math.atan(PW / 2 / f) * 180) / Math.PI, ss: 2, noise: 0, motion: undefined, blur: undefined, camRot: undefined });
  return (t: number, i: number) => {
    const Rc = camMatrix(rot(t));
    const out = new Uint8ClampedArray(W * H * 4);
    const pr = pano.rgba, pcx = PW / 2, pcy = PH / 2;
    for (let y = 0; y < H; y++) {
      const dy = -(y + 0.5 - H / 2) / f;
      for (let x = 0; x < W; x++) {
        const dx = (x + 0.5 - W / 2) / f;
        const X = Rc[0] * dx + Rc[1] * dy - Rc[2], Y = Rc[3] * dx + Rc[4] * dy - Rc[5], Z = Rc[6] * dx + Rc[7] * dy - Rc[8];
        let sx = pcx + (f * X) / -Z - 0.5, sy = pcy - (f * Y) / -Z - 0.5;
        sx = sx < 0 ? 0 : sx > PW - 1.001 ? PW - 1.001 : sx;
        sy = sy < 0 ? 0 : sy > PH - 1.001 ? PH - 1.001 : sy;
        const xi = sx | 0, yi = sy | 0, fx = sx - xi, fy = sy - yi;
        const a = (yi * PW + xi) * 4, b = a + 4, c = a + PW * 4, d = c + 4;
        const o = (y * W + x) * 4;
        for (let k = 0; k < 3; k++) out[o + k] = (pr[a + k] * (1 - fx) + pr[b + k] * fx) * (1 - fy) + (pr[c + k] * (1 - fx) + pr[d + k] * fx) * fy;
        out[o + 3] = 255;
      }
    }
    post?.(t, out, W, H);
    if (base.motion) motionBlur(out, W, H, base.motion[0] * K, base.motion[1] * K);
    if (base.blur) boxBlur(out, W, H, base.blur * K);
    const nz = (base.noise ?? 0) * 1.4; // кадр ×2 потом усредняется 2 × 2 — шум вдвое меньше; ×1,4 ≈ как у кадра 320
    if (nz) {
      const RN = rng(i * 7919 + seed);
      for (let k = 0; k < out.length; k += 4) {
        const u = Math.max(1e-9, RN()), v = RN();
        const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * nz;
        out[k] += g;
        out[k + 1] += g;
        out[k + 2] += g;
      }
    }
    return out;
  };
}

/**
 * Синтетические клипы с ИСТИННЫМИ углами и гироскопом для оценки (tests/card/eval.test.ts, `npm run card:eval -- --synth`):
 * карта и стол на одной плоскости, телефон движется в 6 степенях свободы (приближение 45→25 см, наклон 20→70°,
 * облёт, встряска, тремор руки). Плоскость рендерится один раз сверху (текстура), кадр — её перспективная проекция
 * (луч пикселя → плоскость → текстура), поэтому сдвиг телефона (а не только поворот) — честный.
 *
 * Мир: плоскость Z = 0, карта в начале координат, +Y — дальний край карты («верх»), +Z — вверх от стола.
 * Камера — как в three.js (смотрит в −Z, +Y вверх); ориентация камеры в мире — то, что отдаёт гироскоп
 * (deviceQuaternion в OrientationHold).
 */
import * as THREE from 'three';
import { renderCardScene, boxBlur, rng, type Tex } from '../../helpers/synthCard';
import { focalFromFov } from '../../../src/tracker/card/detector';
import { CARD_ASPECT, type Quad } from '../../../src/tracker/card/geometry';
import type { EvalClip } from './replay';

export const CARD_CM = 8.56;

export interface CamPose {
  /** расстояние до точки взгляда, см */
  cm: number;
  /** наклон от вертикали, градусы (0 — сверху) */
  tilt: number;
  /** облёт вокруг карты, градусы */
  az: number;
  /** точка взгляда на плоскости (ширины карты) */
  lx?: number;
  ly?: number;
  /** доворот телефона в его осях (кивок, поворот, крен), градусы — тремор, встряска */
  shake?: [number, number, number];
}

export interface SynthClipOpts {
  name: string;
  duration: number;
  pose: (t: number) => CamPose;
  /** истинный угол обзора камеры по длинной стороне, градусы (трекер о нём не знает — начинает с focal) */
  hfov?: number;
  /** фокус, с которого начинает трекер (px детектора); по умолчанию — по DEFAULT_HFOV, как CardTracker без калибровки */
  focal?: number;
  /** задержка камеры: кадр, снятый в t, на экране с t + camLat, с */
  camLat?: number;
  /** шум гироскопа, градусы на отсчёт */
  gyroNoise?: number;
  /** без гироскопа */
  noGyro?: boolean;
  tex?: Tex;
  bg?: 'wood' | 'white' | 'dark' | 'check' | 'gloss' | 'plain';
  seed?: number;
  /** портрет 180 × 320 (как iPhone) или ландшафт */
  portrait?: boolean;
  fps?: number;
}

const panoCache = new Map<string, { rgba: Uint8ClampedArray; n: number; ppw: number }>();

/** стол с картой сверху: квадрат n × n, ppw px на ширину карты, карта в центре */
function pano(tex: Tex | undefined, bg: string, seed: number) {
  const key = `${bg}:${seed}:${tex ? tex.w + 'x' + tex.h + ':' + tex.rgba[(tex.rgba.length >> 1) & ~3] : 'doodle'}`;
  const c = panoCache.get(key);
  if (c) return c;
  const n = 1600, ppw = 200;
  // фронтальный вид: X → n/2 + f0·X/D0 — подобие плоскости, f0/D0 = ppw
  const hfov = 90, f0 = n / 2 / Math.tan((hfov * Math.PI) / 360);
  const fr = renderCardScene({ w: n, h: n, hfov, dist: f0 / ppw, tilt: 0, yaw: 0, tableOnPlane: true, bg: bg as never, tex, seed, ss: 2, noise: 0, card: { rgb: [33, 160, 56], design: 'doodle' } });
  const p = { rgba: fr.rgba, n, ppw };
  panoCache.set(key, p);
  return p;
}

/** ориентация камеры в мире (столбцы — оси камеры) и положение, единицы — ширина карты */
export function camWorld(p: CamPose): { R: THREE.Matrix4; C: THREE.Vector3 } {
  const d = (p.cm / CARD_CM), th = (p.tilt * Math.PI) / 180, az = (p.az * Math.PI) / 180;
  const T = new THREE.Vector3(p.lx ?? 0, p.ly ?? 0, 0);
  const C = new THREE.Vector3(-d * Math.sin(th) * Math.sin(az), -d * Math.sin(th) * Math.cos(az), d * Math.cos(th)).add(T);
  const fwd = T.clone().sub(C).normalize();
  const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 0, 1));
  if (right.lengthSq() < 1e-9) right.set(Math.cos(az), -Math.sin(az), 0);
  right.normalize();
  const back = fwd.clone().negate();
  const up = new THREE.Vector3().crossVectors(back, right);
  const R = new THREE.Matrix4().makeBasis(right, up, back);
  if (p.shake) {
    const s = p.shake.map((x) => (x * Math.PI) / 180);
    R.multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(s[0], s[1], s[2], 'YXZ')));
  }
  return { R, C };
}

export function synthClip(o: SynthClipOpts): EvalClip & { hfov: number } {
  const fps = o.fps ?? 30;
  const n = Math.round(o.duration * fps);
  const portrait = o.portrait ?? true;
  const w = portrait ? 180 : 320, h = portrait ? 320 : 240, K = 2;
  const W = w * K, H = h * K;
  const hfov = o.hfov ?? 63;
  const fHi = focalFromFov(W, H, hfov);
  const P = pano(o.tex, o.bg ?? 'wood', o.seed ?? 3);
  const camLat = o.camLat ?? 0.033;
  const hh = 0.5 / CARD_ASPECT;
  const corners = [new THREE.Vector3(-0.5, hh, 0), new THREE.Vector3(0.5, hh, 0), new THREE.Vector3(0.5, -hh, 0), new THREE.Vector3(-0.5, -hh, 0)];
  const fLo = fHi / K;
  const project = (p: CamPose): Quad | null => {
    const { R, C } = camWorld(p);
    const Rt = R.clone().transpose();
    const out = [];
    for (const c of corners) {
      const v = c.clone().sub(C).applyMatrix4(Rt);
      if (v.z > -1e-3) return null;
      // центры пикселей — целые координаты (как synthCard и детектор)
      out.push({ x: w / 2 + (fLo * v.x) / -v.z - 0.5, y: h / 2 - (fLo * v.y) / -v.z - 0.5 });
    }
    return out as Quad;
  };
  const render = (i: number): Uint8ClampedArray => {
    const { R, C } = camWorld(o.pose(i / fps));
    const e = R.elements;
    const out = new Uint8ClampedArray(W * H * 4);
    const pr = P.rgba, N = P.n, ppw = P.ppw;
    const R0 = rng(i * 7919 + (o.seed ?? 3));
    for (let y = 0; y < H; y++) {
      const dy = -(y + 0.5 - H / 2) / fHi;
      for (let x = 0; x < W; x++) {
        const dx = (x + 0.5 - W / 2) / fHi;
        // луч в мире: R · (dx, dy, −1)
        const rx = e[0] * dx + e[4] * dy - e[8], ry = e[1] * dx + e[5] * dy - e[9], rz = e[2] * dx + e[6] * dy - e[10];
        const o4 = (y * W + x) * 4;
        if (rz > -1e-6) {
          out[o4] = out[o4 + 1] = out[o4 + 2] = 200;
          out[o4 + 3] = 255;
          continue;
        }
        const s = -C.z / rz;
        const X = C.x + rx * s, Y = C.y + ry * s;
        let sx = N / 2 + X * ppw - 0.5, sy = N / 2 - Y * ppw - 0.5;
        // за краем текстуры — зеркально (стол продолжается)
        const per = 2 * (N - 1);
        sx = ((sx % per) + per) % per;
        sy = ((sy % per) + per) % per;
        if (sx > N - 1) sx = per - sx;
        if (sy > N - 1) sy = per - sy;
        sx = Math.min(N - 1.001, sx);
        sy = Math.min(N - 1.001, sy);
        const xi = sx | 0, yi = sy | 0, fx = sx - xi, fy = sy - yi;
        const a = (yi * N + xi) * 4, b = a + 4, c = a + N * 4, d = c + 4;
        for (let k = 0; k < 3; k++) out[o4 + k] = (pr[a + k] * (1 - fx) + pr[b + k] * fx) * (1 - fy) + (pr[c + k] * (1 - fx) + pr[d + k] * fx) * fy;
        out[o4 + 3] = 255;
      }
    }
    boxBlur(out, W, H, 1);
    for (let k = 0; k < out.length; k += 4) {
      const g = (R0() + R0() + R0() - 1.5) * 4;
      out[k] += g;
      out[k + 1] += g;
      out[k + 2] += g;
    }
    return out;
  };
  // гироскоп 60 Гц: ориентация камеры в мире + шум (белый, градусы)
  const gyro: EvalClip['gyro'] = [];
  if (!o.noGyro) {
    const RN = rng(77 + (o.seed ?? 3));
    const nz = ((o.gyroNoise ?? 0.1) * Math.PI) / 180;
    for (let t = 0; t <= o.duration + camLat + 0.1; t += 1 / 60) {
      const { R } = camWorld(o.pose(Math.min(o.duration, t)));
      const q = new THREE.Quaternion().setFromRotationMatrix(R);
      const dq = new THREE.Quaternion().setFromEuler(new THREE.Euler((RN() - 0.5) * 2 * nz, (RN() - 0.5) * 2 * nz, (RN() - 0.5) * 2 * nz));
      q.multiply(dq);
      gyro.push({ t, q: [q.x, q.y, q.z, q.w] });
    }
  }
  const gt = Array.from({ length: n }, (_, i) => project(o.pose(i / fps)));
  const enter = gt.findIndex((q) => !!q && q.every((p) => p.x > 1 && p.y > 1 && p.x < w - 2 && p.y < h - 2));
  return {
    name: o.name,
    w,
    h,
    hiK: K,
    n,
    hfov,
    frameTime: (i) => i / fps + camLat,
    frames: () => ({ get: (i) => (i < n ? render(i) : null) }),
    focal: o.focal ?? focalFromFov(w, h),
    verify: true,
    gt: (i) => gt[i] ?? null,
    gyro: o.noGyro ? undefined : gyro.map((g) => ({ ...g, t: g.t })),
    enterAt: enter >= 0 ? enter / fps + camLat : undefined,
    trueFocal: fHi / K,
  };
}

const ease = (t: number, a: number, b: number) => {
  const k = Math.max(0, Math.min(1, (t - a) / (b - a)));
  return k * k * (3 - 2 * k);
};
/** тремор руки ребёнка: ~0,3° на 5–9 Гц + медленный дрейф */
export const tremor = (t: number, k = 1): [number, number, number] => [
  k * (0.25 * Math.sin(t * 37) + 0.15 * Math.sin(t * 57 + 1) + 0.6 * Math.sin(t * 0.9)),
  k * (0.25 * Math.sin(t * 43 + 2) + 0.8 * Math.sin(t * 0.7 + 1)),
  k * 0.3 * Math.sin(t * 0.5),
];

/** движения матрицы съёмки (docs/qa/CARD_MATRIX.md): те же, что снимает команда, — с истинными углами */
export const MOTIONS: Record<string, { duration: number; pose: (t: number) => CamPose }> = {
  // 1,5 с держим на 40 см, потом приближаем 45 → 25 см за 2,5 с, держим, отдаляем
  approach: { duration: 9, pose: (t) => ({ cm: 42 - 17 * ease(t, 2, 4.5) + 17 * ease(t, 6, 8.5), tilt: 40, az: 0, shake: tremor(t) }) },
  // наклон 25° → 70° → 25° на 28 см
  tilt: { duration: 9, pose: (t) => ({ cm: 28, tilt: 25 + 45 * ease(t, 2, 4.5) - 45 * ease(t, 6, 8.5), az: 0, shake: tremor(t) }) },
  // облёт 0 → 70° на 30 см, 45°
  orbit: { duration: 8, pose: (t) => ({ cm: 30, tilt: 45, az: 70 * ease(t, 2, 6), shake: tremor(t) }) },
  // встряска: ±8° 3 Гц на 1,5 с
  shake: { duration: 6, pose: (t) => ({ cm: 30, tilt: 40, az: 0, shake: (tremor(t).map((x, k) => x + (t > 2.5 && t < 4 ? [8, 5, 0][k] * Math.sin((t - 2.5) * 19) : 0)) as [number, number, number]) }) },
  // всё сразу: приближение и наклон одновременно, ребёнок ведёт телефон по дуге
  combo: { duration: 10, pose: (t) => ({ cm: 42 - 16 * ease(t, 2, 5) + 10 * ease(t, 7, 9.5), tilt: 30 + 35 * ease(t, 2.5, 5.5) - 25 * ease(t, 7, 9.5), az: 25 * Math.sin(t * 0.6), lx: 0.15 * Math.sin(t * 0.8), shake: tremor(t, 1.4) }) },
};

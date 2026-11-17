/**
 * Синтетические кадры «карта на столе» для тестов детектора. Независимая от детектора геометрия:
 * для каждого пикселя — луч камеры → пересечение с плоскостью карты (без гомографий из geometry.ts).
 * Сглаживание краёв — 3×3 подвыборки. Всё детерминировано (seed).
 */
export interface SynthOptions {
  /** текстура стола лежит на плоскости карты (а не на экране) — для проверки ведения по поверхности */
  tableOnPlane?: boolean;
  w?: number;
  h?: number;
  /** горизонтальный угол обзора по длинной стороне, градусы */
  hfov?: number;
  /** наклон карты от фронтального вида, градусы (0 — смотрим сверху перпендикулярно) */
  tilt?: number;
  /** поворот карты в своей плоскости, градусы */
  yaw?: number;
  /** расстояние до карты, в ширинах карты */
  dist?: number;
  /** сдвиг центра карты в долях кадра */
  ox?: number;
  oy?: number;
  card?: { rgb: [number, number, number]; design?: 'plain' | 'doodle' | 'gradient' | 'stripes' };
  /** картинка на «карте» (дизайн карты или поверхность предмета), растягивается на весь прямоугольник */
  tex?: Tex;
  /** форма предмета: соотношение сторон и радиус скругления (доля ширины). По умолчанию — карта ID-1 */
  shape?: { aspect: number; radius: number };
  /** фон — картинка (растягивается на кадр) вместо процедурного стола */
  bgImage?: Tex;
  bg?: 'wood' | 'plain' | 'dark' | 'clutter' | 'paper' | 'white';
  finger?: boolean;
  glare?: boolean;
  /** множитель яркости (тусклый свет) */
  light?: number;
  noise?: number;
  blur?: number;
  seed?: number;
  /** отдельное зерно шума сенсора (по кадрам разное, как у настоящей камеры) */
  noiseSeed?: number;
  /** без карты (негативный пример) */
  noCard?: boolean;
}

export interface Tex {
  rgba: Uint8ClampedArray | Uint8Array;
  w: number;
  h: number;
}

/** билинейная выборка из текстуры, u, v ∈ [0, 1] */
export function texAt(t: Tex, u: number, v: number): [number, number, number] {
  const x = Math.min(t.w - 1.001, Math.max(0, u * t.w - 0.5)), y = Math.min(t.h - 1.001, Math.max(0, v * t.h - 0.5));
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
  const a = (y0 * t.w + x0) * 4, b = a + 4, c = a + t.w * 4, d = c + 4;
  const out: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 3; k++) out[k] = (t.rgba[a + k] * (1 - fx) + t.rgba[b + k] * fx) * (1 - fy) + (t.rgba[c + k] * (1 - fx) + t.rgba[d + k] * fx) * fy;
  return out;
}

export interface SynthFrame {
  w: number;
  h: number;
  rgba: Uint8ClampedArray;
  /** острые углы карты TL, TR, BR, BL в пикселях (центры пикселей — целые координаты) */
  corners: { x: number; y: number }[];
  focal: number;
}

export const CARD_A = 85.6 / 53.98;
const CARD_R = 3.18 / 85.6;

export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

type V3 = [number, number, number];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function rotX(v: V3, a: number): V3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [v[0], c * v[1] - s * v[2], s * v[1] + c * v[2]];
}
function rotZ(v: V3, a: number): V3 {
  const c = Math.cos(a), s = Math.sin(a);
  return [c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]];
}

export function renderCardScene(o: SynthOptions = {}): SynthFrame {
  const w = o.w ?? 320, h = o.h ?? 240;
  const R = rng(o.seed ?? 1);
  const f = Math.max(w, h) / 2 / Math.tan(((o.hfov ?? 63) * Math.PI) / 360);
  const cx = w / 2, cy = h / 2;
  const tilt = ((o.tilt ?? 0) * Math.PI) / 180, yaw = ((o.yaw ?? 0) * Math.PI) / 180;
  const D = o.dist ?? 2.2;
  // базис карты: X, Y в плоскости, N — нормаль к камере; камера смотрит в −Z (как three.js)
  const tr = (v: V3) => rotX(rotZ(v, yaw), -tilt);
  const r1 = tr([1, 0, 0]), r2 = tr([0, 1, 0]), r3 = tr([0, 0, 1]);
  const t: V3 = [(o.ox ?? 0) * D * (w / f), -(o.oy ?? 0) * D * (h / f), -D];
  const aspect = o.shape?.aspect ?? CARD_A;
  const radius = o.shape?.radius ?? CARD_R;
  const hh = 0.5 / aspect;
  const proj = (X: number, Y: number) => {
    const P: V3 = [X * r1[0] + Y * r2[0] + t[0], X * r1[1] + Y * r2[1] + t[1], X * r1[2] + Y * r2[2] + t[2]];
    return { x: cx + (f * P[0]) / -P[2] - 0.5, y: cy - (f * P[1]) / -P[2] - 0.5 };
  };
  const corners = [proj(-0.5, hh), proj(0.5, hh), proj(0.5, -hh), proj(-0.5, -hh)];

  // фон
  const bg = o.bg ?? 'wood';
  const woodBase: V3 = [130 + R() * 40, 90 + R() * 25, 55 + R() * 20];
  const grainAng = R() * Math.PI, grainF = 0.15 + R() * 0.2;
  const clutter: { kind: 'circle' | 'rect' | 'line'; x: number; y: number; a: number; b: number; ang: number; rgb: V3 }[] = [];
  if (bg === 'clutter') {
    for (let i = 0; i < 9; i++) {
      const kind = (['circle', 'rect', 'line'] as const)[i % 3];
      // прямоугольники заведомо не «карточного» вида: квадраты и длинные полосы
      const a = 10 + R() * 40;
      const b = kind === 'rect' ? (R() < 0.5 ? a : a * (3 + R() * 2)) : kind === 'line' ? 1.5 : a;
      clutter.push({ kind, x: R() * w, y: R() * h, a, b, ang: R() * Math.PI, rgb: [R() * 255, R() * 255, R() * 255] });
    }
  }
  const paperLines = bg === 'paper';
  const bgColor = (x: number, y: number): V3 => {
    let c: V3;
    if (bg === 'plain') c = [175, 172, 165];
    else if (bg === 'dark') c = [38, 36, 40];
    else if (bg === 'white' || bg === 'paper') c = [236, 235, 230];
    else {
      const u = x * Math.cos(grainAng) + y * Math.sin(grainAng), v = -x * Math.sin(grainAng) + y * Math.cos(grainAng);
      const g = Math.sin(u * grainF + 3 * Math.sin(v * 0.02)) * 0.5 + 0.5;
      const k = 0.78 + 0.22 * g + 0.06 * Math.sin(u * 0.9 + v * 0.05);
      c = [woodBase[0] * k, woodBase[1] * k, woodBase[2] * k];
    }
    if (o.bgImage) c = texAt(o.bgImage, x / w, y / h);
    if (paperLines && Math.abs(((y + 3) % 14) - 7) < 0.8 && x > 20 && x < w - 30) c = [60, 60, 70];
    for (const k of clutter) {
      const dx = x - k.x, dy = y - k.y;
      const u = dx * Math.cos(k.ang) + dy * Math.sin(k.ang), v = -dx * Math.sin(k.ang) + dy * Math.cos(k.ang);
      const inside = k.kind === 'circle' ? u * u + v * v < k.a * k.a : Math.abs(u) < k.b / 2 + (k.kind === 'line' ? 60 : 0) && Math.abs(v) < (k.kind === 'line' ? 0.9 : k.a / 2);
      if (inside) c = k.rgb;
    }
    return c;
  };

  // текстура стола на плоскости (едет вместе с картой — проверка ведения по поверхности)
  const planeTex = (X: number, Y: number): V3 => {
    const u = X * 140, v = Y * 140;
    const base = bgColor(u * 0.6 + 500, v * 0.6 + 500);
    const gx = Math.floor(u / 9), gy = Math.floor(v / 9);
    const hsh = Math.sin(gx * 127.1 + gy * 311.7) * 43758.5453;
    const r = hsh - Math.floor(hsh);
    if (r > 0.72) {
      const fx = u / 9 - gx - 0.5, fy = v / 9 - gy - 0.5;
      if (fx * fx + fy * fy < 0.09 + 0.06 * r) return [base[0] * 0.55, base[1] * 0.55, base[2] * 0.6];
    }
    return base;
  };

  // карта
  const card = o.card ?? { rgb: [33, 160, 56] as [number, number, number], design: 'doodle' as const };
  const design = card.design ?? 'plain';
  const doodles: { x: number; y: number; r: number }[] = [];
  for (let i = 0; i < 14; i++) doodles.push({ x: (R() - 0.5) * 0.9, y: (R() - 0.5) * 0.55, r: 0.02 + R() * 0.06 });
  const cardColor = (X: number, Y: number): V3 => {
    if (o.tex) return texAt(o.tex, X + 0.5, (hh - Y) / (2 * hh));
    let [r, g, b] = card.rgb;
    if (design === 'gradient') {
      const k = 0.6 + 0.8 * (X + 0.5) / 1;
      r *= k;
      g *= k;
      b *= k;
    } else if (design === 'stripes') {
      if (Math.sin((X + Y) * 40) > 0.4) [r, g, b] = [r * 0.6 + 90, g * 0.6 + 90, b * 0.6 + 90];
    } else if (design === 'doodle') {
      for (const d of doodles) {
        const q = Math.hypot(X - d.x, Y - d.y);
        if (Math.abs(q - d.r) < 0.004) [r, g, b] = [r * 0.5 + 120, g * 0.5 + 120, b * 0.5 + 120];
      }
      // чип
      if (X > -0.36 && X < -0.24 && Y > -0.02 && Y < 0.07) [r, g, b] = [225, 225, 225];
    }
    return [r, g, b];
  };
  const inCard = (X: number, Y: number) => {
    const ax = Math.abs(X), ay = Math.abs(Y);
    if (ax > 0.5 || ay > hh) return false;
    const qx = ax - (0.5 - radius), qy = ay - (hh - radius);
    if (qx > 0 && qy > 0) return qx * qx + qy * qy <= radius * radius;
    return true;
  };
  const N = dot(r3, t);
  // палец: капсула от края кадра к точке на стороне карты
  const fingerAt = proj(-0.1 + R() * 0.3, -hh);
  const fingerFrom = { x: fingerAt.x + (R() - 0.5) * w * 0.3, y: h + 20 };
  const fingerR = Math.max(w, h) * 0.045;
  const inFinger = (x: number, y: number) => {
    if (!o.finger) return 0;
    const ax = fingerFrom.x, ay = fingerFrom.y, bx = fingerAt.x, by = fingerAt.y - fingerR * 0.6;
    const dx = bx - ax, dy = by - ay;
    const tt = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    const d = Math.hypot(x - ax - dx * tt, y - ay - dy * tt);
    return d < fingerR ? 1 - (d / fingerR) ** 2 : 0;
  };
  const glareC = proj((R() - 0.5) * 0.4, (R() - 0.5) * 0.2);

  const rgba = new Uint8ClampedArray(w * h * 4);
  const SS = 3;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let ar = 0, ag = 0, ab = 0;
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS;
          let c: V3 | null = null;
          if (!o.noCard || o.tableOnPlane) {
            const d: V3 = [(px - cx) / f, -(py - cy) / f, -1];
            const den = dot(r3, d);
            if (Math.abs(den) > 1e-9) {
              const s = N / den;
              if (s > 0) {
                const P: V3 = [d[0] * s - t[0], d[1] * s - t[1], d[2] * s - t[2]];
                const X = dot(P, r1), Y = dot(P, r2);
                if (o.tableOnPlane && (o.noCard || !inCard(X, Y))) c = planeTex(X, Y);
                else if (inCard(X, Y)) {
                  c = cardColor(X, Y);
                  if (o.glare) {
                    const gd = Math.hypot(px - glareC.x, (py - glareC.y) * 1.8) / (w * 0.09);
                    const k = Math.exp(-gd * gd) * 0.85;
                    c = [c[0] + (255 - c[0]) * k, c[1] + (255 - c[1]) * k, c[2] + (255 - c[2]) * k];
                  }
                }
              }
            }
          }
          if (!c) c = bgColor(px, py);
          const fk = inFinger(px, py);
          if (fk > 0) c = [215 * (0.75 + 0.25 * fk), 160 * (0.75 + 0.25 * fk), 130 * (0.75 + 0.25 * fk)];
          ar += c[0];
          ag += c[1];
          ab += c[2];
        }
      const i = (y * w + x) * 4;
      rgba[i] = ar / (SS * SS);
      rgba[i + 1] = ag / (SS * SS);
      rgba[i + 2] = ab / (SS * SS);
      rgba[i + 3] = 255;
    }
  if (o.blur) boxBlur(rgba, w, h, o.blur);
  const light = o.light ?? 1, noise = o.noise ?? 0;
  if (light !== 1 || noise) {
    const RN = o.noiseSeed != null ? rng(o.noiseSeed * 7919 + 17) : R;
    const g = () => {
      // нормальный шум (Бокс–Мюллер)
      const u = Math.max(1e-9, RN()), v = RN();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    for (let i = 0; i < rgba.length; i += 4) {
      const n = noise ? g() * noise : 0;
      for (let k = 0; k < 3; k++) rgba[i + k] = rgba[i + k] * light + n + (noise ? g() * noise * 0.3 : 0);
    }
  }
  return { w, h, rgba, corners, focal: f };
}

function boxBlur(d: Uint8ClampedArray, w: number, h: number, r: number) {
  const tmp = new Float32Array(w * h * 4);
  const k = 2 * r + 1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (let o = -r; o <= r; o++) s += d[(y * w + Math.min(w - 1, Math.max(0, x + o))) * 4 + c];
        tmp[(y * w + x) * 4 + c] = s / k;
      }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (let o = -r; o <= r; o++) s += tmp[(Math.min(h - 1, Math.max(0, y + o)) * w + x) * 4 + c];
        d[(y * w + x) * 4 + c] = s / k;
      }
}

/** ошибка углов: среднее и максимум (px) при лучшем циклическом сопоставлении */
export function cornerError(det: { x: number; y: number }[], gt: { x: number; y: number }[]) {
  let best = { mean: Infinity, max: Infinity };
  for (let k = 0; k < 4; k++)
    for (const dir of [1, -1]) {
      let s = 0, m = 0;
      for (let i = 0; i < 4; i++) {
        const d = det[(k + dir * i + 8) % 4];
        const e = Math.hypot(d.x - gt[i].x, d.y - gt[i].y);
        s += e;
        m = Math.max(m, e);
      }
      if (s / 4 < best.mean) best = { mean: s / 4, max: m };
    }
  return best;
}

/**
 * Геометрия детектора карты: гомография, четырёхугольники, поза карты по 4 углам, оценка фокуса.
 * Чистые функции без three.js и DOM — работают в Web Worker и в тестах.
 *
 * Соглашения:
 *  - точки изображения — пиксели, x вправо, y вниз;
 *  - Mat3 — 9 чисел построчно (row-major);
 *  - поза — в системе камеры three.js: камера в начале координат, смотрит в −Z, +Y вверх;
 *    модель карты: центр в 0, ширина (длинная сторона) = 1, +X вправо, +Y к «верхнему» краю, +Z — нормаль к зрителю.
 */
export interface Pt {
  x: number;
  y: number;
}
export type Quad = [Pt, Pt, Pt, Pt];
export type Mat3 = number[];
export interface Intrinsics {
  f: number;
  cx: number;
  cy: number;
}

/** ISO/IEC 7810 ID-1: 85.60 × 53.98 мм, радиус скругления 3.18 мм */
export const CARD_ASPECT = 85.6 / 53.98;
export const CARD_RADIUS = 3.18 / 85.6;

/** Решение A·x = b (n×n) методом Гаусса с выбором ведущего элемента; null — вырожденная система. */
export function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    if (p !== c) [M[p], M[c]] = [M[c], M[p]];
    for (let r = c + 1; r < n; r++) {
      const k = M[r][c] / M[c][c];
      if (k === 0) continue;
      for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let j = r + 1; j < n; j++) s -= M[r][j] * x[j];
    x[r] = s / M[r][r];
  }
  return x;
}

/** нормализация Хартли: центр в 0, среднее расстояние √2 */
function normalizer(pts: Pt[]): Mat3 {
  let mx = 0, my = 0;
  for (const p of pts) {
    mx += p.x;
    my += p.y;
  }
  mx /= pts.length;
  my /= pts.length;
  let d = 0;
  for (const p of pts) d += Math.hypot(p.x - mx, p.y - my);
  d = d / pts.length || 1;
  const s = Math.SQRT2 / d;
  return [s, 0, -s * mx, 0, s, -s * my, 0, 0, 1];
}

/**
 * Гомография src → dst по 4+ парам точек (DLT с h33 = 1, МНК при N > 4, нормализация Хартли).
 * null — вырожденная конфигурация (три точки на прямой и т. п.).
 */
export function homography(src: Pt[], dst: Pt[]): Mat3 | null {
  const n = src.length;
  if (n < 4 || dst.length !== n) return null;
  const Ts = normalizer(src), Td = normalizer(dst);
  const s = src.map((p) => applyH(Ts, p));
  const d = dst.map((p) => applyH(Td, p));
  const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const Atb = new Array(8).fill(0);
  const add = (row: number[], rhs: number) => {
    for (let i = 0; i < 8; i++) {
      if (row[i] === 0) continue;
      Atb[i] += row[i] * rhs;
      for (let j = 0; j < 8; j++) AtA[i][j] += row[i] * row[j];
    }
  };
  for (let i = 0; i < n; i++) {
    const { x, y } = s[i], { x: u, y: v } = d[i];
    add([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
    add([0, 0, 0, x, y, 1, -v * x, -v * y], v);
  }
  const h = solveLinear(AtA, Atb);
  if (!h || h.some((v) => !Number.isFinite(v))) return null;
  const Hn = [...h, 1];
  // H = Td⁻¹ · Hn · Ts
  const H = mul3(mul3(invert3(Td)!, Hn), Ts);
  const k = H[8];
  if (Math.abs(k) < 1e-12) return H;
  return H.map((v) => v / k);
}

export function applyH(H: Mat3, p: Pt): Pt {
  const w = H[6] * p.x + H[7] * p.y + H[8];
  return { x: (H[0] * p.x + H[1] * p.y + H[2]) / w, y: (H[3] * p.x + H[4] * p.y + H[5]) / w };
}

export function mul3(a: Mat3, b: Mat3): Mat3 {
  const r = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
}

export function invert3(m: Mat3): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) return null;
  const k = 1 / det;
  return [A * k, -(b * i - c * h) * k, (b * f - c * e) * k, B * k, (a * i - c * g) * k, -(a * f - c * d) * k, C * k, -(a * h - b * g) * k, (a * e - b * d) * k];
}

/** прямая a·x + b·y = c, (a, b) — единичная нормаль */
export interface Line {
  a: number;
  b: number;
  c: number;
}
export function lineThrough(p: Pt, q: Pt): Line {
  const dx = q.x - p.x, dy = q.y - p.y;
  const L = Math.hypot(dx, dy) || 1;
  const a = -dy / L, b = dx / L;
  return { a, b, c: a * p.x + b * p.y };
}
export function intersect(l1: Line, l2: Line): Pt | null {
  const det = l1.a * l2.b - l1.b * l2.a;
  if (Math.abs(det) < 1e-9) return null;
  return { x: (l1.c * l2.b - l1.b * l2.c) / det, y: (l1.a * l2.c - l1.c * l2.a) / det };
}

/** площадь со знаком (в координатах изображения: > 0 — обход по часовой стрелке на экране) */
export function signedArea(q: Pt[]): number {
  let s = 0;
  for (let i = 0; i < q.length; i++) {
    const p = q[i], r = q[(i + 1) % q.length];
    s += p.x * r.y - r.x * p.y;
  }
  return s / 2;
}

export function isConvex(q: Pt[]): boolean {
  let sign = 0;
  for (let i = 0; i < q.length; i++) {
    const a = q[i], b = q[(i + 1) % q.length], c = q[(i + 2) % q.length];
    const z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(z) < 1e-9) return false;
    const s = Math.sign(z);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** упорядочить по часовой стрелке на экране (y вниз), начиная с произвольной вершины */
export function orderClockwise(q: Pt[]): Quad {
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4, cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  return [...q].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx)) as Quad;
}

export function rotateQuad(q: Quad, k: number): Quad {
  return [0, 1, 2, 3].map((i) => q[(i + k) % 4]) as Quad;
}

export function quadCenter(q: Pt[]): Pt {
  return { x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4, y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4 };
}

export function quadDiag(q: Pt[]): number {
  return Math.max(Math.hypot(q[0].x - q[2].x, q[0].y - q[2].y), Math.hypot(q[1].x - q[3].x, q[1].y - q[3].y));
}

/** средняя дистанция между соответствующими вершинами */
export function quadDistance(a: Pt[], b: Pt[]): number {
  let s = 0;
  for (let i = 0; i < 4; i++) s += Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y);
  return s / 4;
}

/** поворот нумерации b, ближайший к a (для сопоставления углов между кадрами) */
export function alignQuad(b: Quad, a: Pt[]): Quad {
  let best = b, bd = Infinity;
  for (let k = 0; k < 4; k++) {
    const r = rotateQuad(b, k);
    const d = quadDistance(a, r);
    if (d < bd) {
      bd = d;
      best = r;
    }
  }
  return best;
}

export function pointInQuad(p: Pt, q: Pt[]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const z = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    const s = Math.sign(z);
    if (s === 0) continue;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

const UNIT: Pt[] = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];

/**
 * Метрическая проверка четырёхугольника при известном фокусе: во что он «разворачивается» в 3D.
 * aspect — отношение стороны q0→q1 к стороне q1→q2 у прямоугольника в пространстве;
 * cos — косинус угла между этими сторонами в 3D (0 — прямой угол).
 */
export function metricShape(q: Pt[], K: Intrinsics): { aspect: number; cos: number } | null {
  const n = q.map((p) => ({ x: (p.x - K.cx) / K.f, y: (p.y - K.cy) / K.f }));
  const H = homography(UNIT, n);
  if (!H) return null;
  const g1 = [H[0], H[3], H[6]], g2 = [H[1], H[4], H[7]];
  const n1 = Math.hypot(g1[0], g1[1], g1[2]), n2 = Math.hypot(g2[0], g2[1], g2[2]);
  if (n1 < 1e-12 || n2 < 1e-12) return null;
  return { aspect: n1 / n2, cos: (g1[0] * g2[0] + g1[1] * g2[1] + g1[2] * g2[2]) / (n1 * n2) };
}

/**
 * Оценка фокуса (в пикселях) по одному виду прямоугольника с известным соотношением сторон
 * (ортогональность сторон + равенство норм после масштаба). Работает только при заметной перспективе;
 * при фронтальном виде — null. aspect — отношение стороны q0→q1 к q1→q2 в 3D.
 */
export function estimateFocal(q: Pt[], cx: number, cy: number, aspect: number): number | null {
  const s = 1 / Math.max(1, Math.abs(cx), Math.abs(cy));
  const c = q.map((p) => ({ x: (p.x - cx) * s, y: (p.y - cy) * s }));
  const H = homography(UNIT, c);
  if (!H) return null;
  const [h11, h12, , h21, h22, , h31, h32] = H;
  // перспективная часть должна быть заметной относительно масштаба
  const scale = Math.hypot(h11, h21, h12, h22);
  if (Math.hypot(h31, h32) < 0.04 * scale) return null;
  // x = 1/f²:  a1·x + b1 = 0 (ортогональность), a2·x + b2 = 0 (|r1| = |r2|)
  const a1 = h11 * h12 + h21 * h22, b1 = h31 * h32;
  const A2 = aspect * aspect;
  const a2 = h11 * h11 + h21 * h21 - A2 * (h12 * h12 + h22 * h22), b2 = h31 * h31 - A2 * h32 * h32;
  // уравнения в разном масштабе — приводим к одной «размерности»
  const w1 = 1 / (Math.abs(a1) + Math.abs(b1) * 1e-3 + 1e-12), w2 = 1 / (Math.abs(a2) + Math.abs(b2) * 1e-3 + 1e-12);
  const den = w1 * w1 * a1 * a1 + w2 * w2 * a2 * a2;
  if (den < 1e-18) return null;
  const x = -(w1 * w1 * a1 * b1 + w2 * w2 * a2 * b2) / den;
  if (!(x > 0)) return null;
  const f = 1 / Math.sqrt(x) / s;
  return Number.isFinite(f) ? f : null;
}

export interface Pose {
  /** столбцы r1 r2 r3 (поворот модели карты в систему камеры), построчно 3×3 */
  R: number[];
  /** центр карты в системе камеры (в ширинах карты), z < 0 */
  t: [number, number, number];
  /** средняя ошибка перепроецирования углов, px */
  err: number;
}

/** углы модели карты: TL, TR, BR, BL (ширина 1, +Y вверх) */
export function cardModel(aspect = CARD_ASPECT): Quad {
  const h = 0.5 / aspect;
  return [{ x: -0.5, y: h }, { x: 0.5, y: h }, { x: 0.5, y: -h }, { x: -0.5, y: -h }];
}

/**
 * Поза карты по 4 углам изображения (TL, TR, BR, BL — по часовой стрелке на экране) и внутренним параметрам.
 * Гомография модель → нормализованные координаты, разложение H ∝ F·[r1 r2 t] (F = diag(1, 1, −1):
 * у three.js камера смотрит в −Z), ортонормализация r1, r2.
 */
export function poseFromQuad(q: Quad, K: Intrinsics, aspect = CARD_ASPECT): Pose | null {
  const model = cardModel(aspect);
  const n = q.map((p) => ({ x: (p.x - K.cx) / K.f, y: -(p.y - K.cy) / K.f }));
  const H = homography(model, n);
  if (!H) return null;
  // F·H
  const g1 = [H[0], H[3], -H[6]], g2 = [H[1], H[4], -H[7]], g3 = [H[2], H[5], -H[8]];
  const n1 = Math.hypot(...g1), n2 = Math.hypot(...g2);
  if (n1 < 1e-12 || n2 < 1e-12) return null;
  let lam = 2 / (n1 + n2);
  if (g3[2] * lam > 0) lam = -lam;
  const r1 = g1.map((v) => v * lam), r2 = g2.map((v) => v * lam), t = g3.map((v) => v * lam) as [number, number, number];
  // ортонормализация: биссектриса ± полуразность
  const u = norm(r1), v = norm(r2);
  const p = norm(u.map((x, i) => x + v[i])), m = norm(u.map((x, i) => x - v[i]));
  const R1 = p.map((x, i) => (x + m[i]) * Math.SQRT1_2), R2 = p.map((x, i) => (x - m[i]) * Math.SQRT1_2);
  const R3 = cross(R1, R2);
  const R = [R1[0], R2[0], R3[0], R1[1], R2[1], R3[1], R1[2], R2[2], R3[2]];
  let err = 0;
  for (let i = 0; i < 4; i++) {
    const pr = projectPoint(R, t, model[i].x, model[i].y, 0, K);
    if (!pr) return null;
    err += Math.hypot(pr.x - q[i].x, pr.y - q[i].y);
  }
  return { R, t, err: err / 4 };
}

/** точка модели (X, Y, Z) → пиксели изображения при позе (R, t) */
export function projectPoint(R: number[], t: number[], X: number, Y: number, Z: number, K: Intrinsics): Pt | null {
  const x = R[0] * X + R[1] * Y + R[2] * Z + t[0];
  const y = R[3] * X + R[4] * Y + R[5] * Z + t[1];
  const z = R[6] * X + R[7] * Y + R[8] * Z + t[2];
  if (z > -1e-6) return null;
  return { x: K.cx + (K.f * x) / -z, y: K.cy - (K.f * y) / -z };
}

function norm(v: number[]) {
  const l = Math.hypot(...v) || 1;
  return v.map((x) => x / l);
}
function cross(a: number[], b: number[]) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/**
 * Нумерация углов карты: TL, TR, BR, BL так, чтобы q0→q1 была длинной стороной (по метрике при фокусе K),
 * а «верх» (q0–q1) — дальний от зрителя край (выше на экране). prev — прошлая нумерация: при наличии
 * берём ближайший к ней из двух вариантов (поворот на 180° неотличим у симметричной карты — не прыгаем).
 */
export function labelCard(q: Pt[], K: Intrinsics, prev?: Pt[] | null): Quad {
  const c = orderClockwise(q);
  const m = metricShape(c, K);
  // c0→c1 короткая сторона → начинаем со следующей вершины
  const base = m && m.aspect < 1 ? rotateQuad(c, 1) : c;
  const alt = rotateQuad(base, 2);
  if (prev) {
    // непрерывность ориентации: из нумераций, которые дают правдоподобную позу, берём ту, у которой
    // первая сторона повёрнута меньше всего относительно прошлой. Так кот не крутится на 90°/180°,
    // когда соотношение сторон под углом или у края кадра определяется неуверенно.
    const cands: { r: Quad; err: number }[] = [];
    for (let k = 0; k < 4; k++) {
      const r = rotateQuad(c, k);
      const p = poseFromQuad(r, K, CARD_ASPECT);
      cands.push({ r, err: p ? p.err : Infinity });
    }
    const best = Math.min(...cands.map((x) => x.err));
    const ok = cands.filter((x) => x.err <= best * 1.6 + 1.5);
    const dir = (r: Pt[]) => Math.atan2(r[1].y - r[0].y + r[2].y - r[3].y, r[1].x - r[0].x + r[2].x - r[3].x);
    const d0 = dir(prev);
    let pick = ok[0]?.r ?? base, bestD = Infinity;
    for (const x of ok) {
      const d = Math.abs(Math.atan2(Math.sin(dir(x.r) - d0), Math.cos(dir(x.r) - d0)));
      if (d < bestD) (bestD = d), (pick = x.r);
    }
    return pick;
  }
  const top = (r: Quad) => r[0].y + r[1].y - r[2].y - r[3].y;
  return top(base) <= top(alt) ? base : alt;
}

/** Контур скруглённого прямоугольника карты (в координатах модели), steps точек на дугу */
export function roundedCardOutline(aspect = CARD_ASPECT, radius = CARD_RADIUS, steps = 6): Pt[] {
  const hw = 0.5, hh = 0.5 / aspect, r = radius;
  const centers = [
    { x: hw - r, y: hh - r, a0: 0 },
    { x: hw - r, y: -hh + r, a0: -Math.PI / 2 },
    { x: -hw + r, y: -hh + r, a0: -Math.PI },
    { x: -hw + r, y: hh - r, a0: Math.PI / 2 },
  ];
  // обход TR → BR → BL → TL: по часовой на экране (Y модели вверх)
  const out: Pt[] = [];
  for (const c of centers)
    for (let i = 0; i <= steps; i++) {
      const a = c.a0 + Math.PI / 2 - (i / steps) * (Math.PI / 2);
      out.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
    }
  return out;
}

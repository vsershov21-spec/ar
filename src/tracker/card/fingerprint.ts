/**
 * Отпечаток дизайна карты: узнаём известные дизайны Сбера по картинке, даже если на лицевой стороне нет знака
 * (детские иллюстрации каталога: 041–043, 121, 123, 125 и др.).
 *
 * Дескриптор считается по выпрямленной карте (канонический прямоугольник verify.ts, 200 × 126):
 *   - яркость по сетке 16 × 10 (среднее по клетке) с вычтенной плоскостью (неровный свет, блик-градиент) —
 *     «перцептивный хэш» без DCT: сравнение — робастной регрессией L_кадр ≈ a·L_дизайн + b (автоэкспозиция,
 *     контраст, тусклый свет), клетки-выбросы (палец, блик, чип, номер) ограничены сверху;
 *   - цветность по сетке 8 × 5: (R − G)/S, (R + G − 2B)/S, S = R + G + B — без яркости; из неё вычитается
 *     средняя по карте (тёплый/холодный свет сдвигает цветность целиком), сама средняя — отдельный мягкий член;
 *   - клетки, где > 25 % точек пересвечены (блик), не участвуют.
 * База (designDb.ts) — только дескрипторы (int8), не изображения; собирается из каталога дизайнов
 * (tests/card/designdb.gen.test.ts, GEN_DB=1). Сопоставление — все записи × 2 ориентации карты (0° и 180°),
 * ≈ 0,1–0,3 мс в воркере.
 *
 * Решение «это известный дизайн»: score лучшей записи ≥ её порога (порог записи — из калибровки на негативах:
 * чем «обычнее» дизайн, тем строже) — и по нескольким кадрам (CardEvidence), как знак.
 *
 * ПРИВАТНОСТЬ: дескриптор 16 × 10 — не картинка карты; номер/имя по нему не прочитать (клетка ≈ 5 × 5 мм).
 */
import { DESIGN_DB } from './designDb';
import { FOREIGN_DB } from './foreignDb';

export const GX = 16, GY = 10;
export const CGX = 8, CGY = 5;
const NL = GX * GY, NC = CGX * CGY;

/** вес клетки (координаты дизайна): чип, номер, имя, логотипы ПС и Сбера — общие для многих карт или отличаются от каталога */
export const CELL_W = new Float32Array(NL);
for (let j = 0; j < GY; j++)
  for (let i = 0; i < GX; i++) {
    const u = (i + 0.5) / GX, v = (j + 0.5) / GY;
    let w = 1;
    if (u > 0.06 && u < 0.3 && v > 0.27 && v < 0.65) w = 0.15; // чип (на части картинок каталога его нет)
    else if (v > 0.52 && v < 0.72) w = 0.5; // номер
    else if (v > 0.76 && u < 0.6) w = 0.5; // имя / срок
    else if (u > 0.68 && v > 0.74) w = 0.4; // МИР — на всех картах
    else if (u < 0.2 && v < 0.27) w = 0.5; // знак Сбера
    CELL_W[j * GX + i] = w;
  }

export interface Desc {
  /** яркость по сетке, плоскость вычтена, 0..1 → примерно ±0,5 */
  l: Float32Array;
  /** цветность по крупной сетке после выравнивания каналов по среднему карты (2 канала подряд) */
  c: Float32Array;
  /** средняя цветность */
  cm: [number, number];
  /** 0 — нет данных, 1 — годна, 2 — пересвечена (блик или белый рисунок) */
  ok: Uint8Array;
  /** разброс яркости по клеткам (после вычитания плоскости) */
  sd: number;
}

export function newDesc(): Desc {
  return { l: new Float32Array(NL), c: new Float32Array(NC * 2), cm: [0, 0], ok: new Uint8Array(NL), sd: 0 };
}

const accL = new Float64Array(NL), accN = new Float64Array(NL), accHot = new Float64Array(NL);
const accC = new Float64Array(NC * 3), accCN = new Float64Array(NC);

/**
 * Дескриптор канонического изображения (R, G, B 0..1, cw × ch построчно). Поля 3 % по краям не берём (скругления,
 * неточные углы). Шаг выборки 2 px — клетка 12 × 12 px даёт 36 точек: хватает и быстро (≈ 0,05 мс).
 * Пересвеченные точки (min(R,G,B) > 0,93) в яркость входят (белый рисунок — тоже рисунок), но клетка, где их > 25 %,
 * помечается hot: при сравнении она участвует, только если и в дизайне там белое (иначе это блик).
 * Цветность — по средним цветам крупных клеток, каждый канал поделён на своё среднее по карте (фон Крис: тёплый и
 * холодный свет — множители каналов — уходят).
 */
export function describe(R: Float32Array, G: Float32Array, B: Float32Array, cw: number, ch: number, out: Desc = newDesc()): Desc {
  accL.fill(0);
  accN.fill(0);
  accHot.fill(0);
  accC.fill(0);
  accCN.fill(0);
  const x0 = 0.03 * cw, x1 = 0.97 * cw, y0 = 0.03 * ch, y1 = 0.97 * ch;
  const sx = GX / (x1 - x0), sy = GY / (y1 - y0);
  // средние каналов по карте (фон Крис: и яркость, и цветность — по выровненным каналам)
  let mR = 0, mG = 0, mB = 0, mN = 0;
  for (let y = Math.ceil(y0); y < y1; y += 2)
    for (let x = Math.ceil(x0); x < x1; x += 2) {
      const k = y * cw + x;
      const r = R[k], g = G[k], b = B[k];
      mR += r;
      mG += g;
      mB += b;
      mN++;
    }
  mR = mN ? mR / mN : 1;
  mG = mN ? mG / mN : 1;
  mB = mN ? mB / mN : 1;
  const msum = mR + mG + mB;
  // множители каналов: каждый канал к своему среднему, общая яркость карты — к 0,5 (средний серый)
  const kr = 0.5 / Math.max(0.12, mR), kg = 0.5 / Math.max(0.12, mG), kb = 0.5 / Math.max(0.12, mB);
  for (let y = Math.ceil(y0); y < y1; y += 2) {
    const j = Math.min(GY - 1, ((y - y0) * sy) | 0);
    const cj = (j * CGY / GY) | 0;
    for (let x = Math.ceil(x0); x < x1; x += 2) {
      const i = Math.min(GX - 1, ((x - x0) * sx) | 0);
      const k = y * cw + x;
      const r = R[k], g = G[k], b = B[k];
      const cell = j * GX + i;
      accN[cell]++;
      const rn = r * kr, gn = g * kg, bn = b * kb;
      accL[cell] += 0.299 * rn + 0.587 * gn + 0.114 * bn;
      const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
      if (mn > 0.93) {
        accHot[cell]++;
        continue;
      }
      const ci = cj * CGX + ((i * CGX / GX) | 0);
      accC[ci * 3] += rn;
      accC[ci * 3 + 1] += gn;
      accC[ci * 3 + 2] += bn;
      accCN[ci]++;
    }
  }
  // яркость: среднее по клеткам, затем вычесть плоскость a + b·u + c·v (МНК по клеткам без блика)
  let n = 0;
  let S00 = 0, S01 = 0, S02 = 0, S11 = 0, S12 = 0, S22 = 0, T0 = 0, T1 = 0, T2 = 0;
  for (let cell = 0; cell < NL; cell++) {
    if (!accN[cell]) {
      out.ok[cell] = 0;
      out.l[cell] = 0;
      continue;
    }
    const hot = accHot[cell] > 0.25 * accN[cell];
    out.ok[cell] = hot ? 2 : 1;
    const l = accL[cell] / accN[cell];
    out.l[cell] = l;
    const u = ((cell % GX) + 0.5) / GX - 0.5, v = (((cell / GX) | 0) + 0.5) / GY - 0.5;
    S00 += 1;
    S01 += u;
    S02 += v;
    S11 += u * u;
    S12 += u * v;
    S22 += v * v;
    T0 += l;
    T1 += l * u;
    T2 += l * v;
    n++;
  }
  const pl = n >= 8 ? solve3(S00, S01, S02, S11, S12, S22, T0, T1, T2) : [0.5, 0, 0];
  let ss = 0;
  for (let cell = 0; cell < NL; cell++) {
    if (!out.ok[cell]) continue;
    const u = ((cell % GX) + 0.5) / GX - 0.5, v = (((cell / GX) | 0) + 0.5) / GY - 0.5;
    const r = out.l[cell] - (pl[0] + pl[1] * u + pl[2] * v);
    out.l[cell] = r;
    ss += r * r;
  }
  out.sd = n ? Math.sqrt(ss / n) : 0;
  // цветность по выровненным каналам; средняя цветность карты (до выравнивания) — отдельно
  out.cm[0] = msum > 0.05 ? (mR - mG) / msum : 0;
  out.cm[1] = msum > 0.05 ? (mR + mG - 2 * mB) / msum : 0;
  for (let ci = 0; ci < NC; ci++) {
    const cn = accCN[ci];
    const r = accC[ci * 3] / cn, g = accC[ci * 3 + 1] / cn, b = accC[ci * 3 + 2] / cn;
    const s3 = r + g + b;
    if (cn < 3 || s3 < 0.15) {
      out.c[ci * 2] = out.c[ci * 2 + 1] = NaN;
      continue;
    }
    out.c[ci * 2] = (r - g) / s3;
    out.c[ci * 2 + 1] = (r + g - 2 * b) / s3;
  }
  return out;
}

function solve3(a: number, b: number, c: number, d: number, e: number, f: number, t0: number, t1: number, t2: number): [number, number, number] {
  // симметричная 3×3 [[a b c] [b d e] [c e f]]
  const det = a * (d * f - e * e) - b * (b * f - c * e) + c * (b * e - c * d);
  if (Math.abs(det) < 1e-12) return [a > 0 ? t0 / a : 0, 0, 0];
  const x0 = (t0 * (d * f - e * e) - b * (t1 * f - e * t2) + c * (t1 * e - d * t2)) / det;
  const x1 = (a * (t1 * f - e * t2) - t0 * (b * f - c * e) + c * (b * t2 - t1 * c)) / det;
  const x2 = (a * (d * t2 - t1 * e) - b * (b * t2 - t1 * c) + t0 * (b * e - c * d)) / det;
  return [x0, x1, x2];
}

// ───── база: int8, по записи — id, порог, разброс, средняя цветность, яркость NL, цветность 2·NC ─────
export interface DbEntry {
  /** номер дизайна в каталоге */
  id: number;
  /** порог score, при котором дизайн считаем узнанным (0 — запись не узнаётся: слишком «обычная») */
  thr: number;
  l: Float32Array;
  c: Float32Array;
  cm: [number, number];
  sd: number;
  /** клетка дизайна белая/пересвеченная (там блик не отличить от рисунка) */
  white: Uint8Array;
}

const L_Q = 1 / 100; // яркость: ±1,27
const C_Q = 1 / 256; // цветность: ±0,5
export const REC = 6 + NL + 2 * NC + NL / 8;

export function encodeEntry(id: number, thr: number, d: Desc): Int8Array {
  const o = new Int8Array(REC);
  const q = (x: number, k: number) => Math.max(-127, Math.min(127, Math.round(x / k)));
  o[0] = id & 0x7f;
  o[1] = (id >> 7) & 0x7f;
  o[2] = Math.round(thr * 100);
  o[3] = q(d.sd, L_Q);
  o[4] = q(d.cm[0], C_Q);
  o[5] = q(d.cm[1], C_Q);
  for (let k = 0; k < NL; k++) o[6 + k] = q(d.l[k], L_Q);
  for (let k = 0; k < 2 * NC; k++) o[6 + NL + k] = Number.isFinite(d.c[k]) ? q(d.c[k], C_Q) : -128;
  for (let k = 0; k < NL; k++) if (d.ok[k] === 2) o[6 + NL + 2 * NC + (k >> 3)] |= 1 << (k & 7);
  return o;
}

export function decodeDb(b64: string): DbEntry[] {
  if (!b64) return [];
  const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const raw = new Int8Array(bin.length);
  for (let i = 0; i < bin.length; i++) raw[i] = (bin.charCodeAt(i) << 24) >> 24;
  const out: DbEntry[] = [];
  for (let p = 0; p + REC <= raw.length; p += REC) {
    const l = new Float32Array(NL), c = new Float32Array(2 * NC);
    for (let k = 0; k < NL; k++) l[k] = raw[p + 6 + k] * L_Q;
    for (let k = 0; k < 2 * NC; k++) c[k] = raw[p + 6 + NL + k] === -128 ? NaN : raw[p + 6 + NL + k] * C_Q;
    const white = new Uint8Array(NL);
    for (let k = 0; k < NL; k++) white[k] = (raw[p + 6 + NL + 2 * NC + (k >> 3)] >> (k & 7)) & 1;
    out.push({ id: raw[p] + (raw[p + 1] << 7), thr: raw[p + 2] / 100, sd: raw[p + 3] * L_Q, cm: [raw[p + 4] * C_Q, raw[p + 5] * C_Q], l, c, white });
  }
  return out;
}

let db: DbEntry[] | null = null;
export function designDb(): DbEntry[] {
  return (db ??= decodeDb(DESIGN_DB));
}
let fdb: DbEntry[] | null = null;
/**
 * Отпечатки карт ДРУГИХ банков, которые на записях с iPhone проходили проверку знака (foreignDb.ts): совпал такой
 * отпечаток — знак Сбера в этом кадре не засчитываем (кольцо-«мишень» чужого банка на 7 px не отличить от знака).
 */
export function foreignDb(): DbEntry[] {
  return (fdb ??= decodeDb(FOREIGN_DB));
}
export function setForeignDb(entries: DbEntry[] | null) {
  fdb = entries;
}

/** тесты и генератор базы: подменить базу */
export function setDesignDb(entries: DbEntry[] | null) {
  db = entries;
}

export function entryFromDesc(id: number, thr: number, d: Desc): DbEntry {
  return { id, thr, l: Float32Array.from(d.l), c: Float32Array.from(d.c), cm: [d.cm[0], d.cm[1]], sd: d.sd, white: Uint8Array.from(d.ok, (x) => (x === 2 ? 1 : 0)) };
}

/** допуски: остаток яркости (в долях разброса карты), разность цветности */
const TAU_L = 0.7;
const TAU_C = 0.09;
/** нижняя граница допуска по яркости (яркость карты приведена к среднему 0,5) */
const TOL_L_MIN = 0.035;
const BRIGHT_CAP = 0.5;
/** доля годных клеток (по весу), без которой не судим */
const MIN_VALID = 0.55;

export interface Match {
  id: number;
  /** 0..1 — похожесть лучшей записи */
  score: number;
  /** score выше порога записи */
  hit: boolean;
  /** запас над порогом (score − thr) */
  margin: number;
  rot180: boolean;
}

/** индекс клетки при повороте карты на 180° */
const FLIP = new Int32Array(NL);
const CFLIP = new Int32Array(NC);
for (let k = 0; k < NL; k++) FLIP[k] = NL - 1 - k;
for (let k = 0; k < NC; k++) CFLIP[k] = NC - 1 - k;

/** составляющие последнего similarity (отладка) */
export const simDbg = { l: 0, c: 0, m: 0, a: 0, why: '' };

/** в регрессию яркости — только непересвеченные клетки (у пересвеченных яркость обрезана) */
const fit = (q: Desc, e: DbEntry, k: number, kq: number) => q.ok[kq] === 1 && e.white[k] === 0;

/**
 * Похожесть дескриптора кадра q на запись e (ориентация flip — карта повёрнута на 180°). 0..1.
 * Яркость: робастная регрессия q ≈ a·e + b (два прохода: МНК → МНК по клеткам с малым остатком), стоимость
 * клетки — min(1, (остаток / (TAU_L·sd))²), sd — разброс записи. Цветность: min(1, (Δ/TAU_C)²) по клеткам +
 * сдвиг средней цветности сверх 0,06 (свет). Итог — 1 − взвешенная средняя стоимость.
 */
export function similarity(q: Desc, e: DbEntry, flip: boolean): number {
  simDbg.why = 'sd';
  if (e.sd < 0.02 || q.sd < 0.012) return 0;
  // проход 1: МНК по клеткам без пересвета (и в кадре, и в дизайне)
  let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, wTot = 0;
  for (let k = 0; k < NL; k++) {
    const w = CELL_W[k];
    wTot += w;
    const kq = flip ? FLIP[k] : k;
    if (!fit(q, e, k, kq)) continue;
    const x = e.l[k], y = q.l[kq];
    sw += w;
    sx += w * x;
    sy += w * y;
    sxx += w * x * x;
    sxy += w * x * y;
  }
  simDbg.why = 'fit';
  if (sw < 0.12 * wTot) return 0;
  let a = (sw * sxy - sx * sy) / Math.max(1e-9, sw * sxx - sx * sx);
  let b = (sy - a * sx) / sw;
  // проходы 2–3: только клетки с остатком в пределах допуска (палец, блик, чип — выбросы)
  for (let pass = 0; pass < 2; pass++) {
    const tol = (pass === 0 ? 2.2 : 1.2) * Math.abs(a) * Math.max(TAU_L * e.sd, TOL_L_MIN);
    sw = sx = sy = sxx = sxy = 0;
    for (let k = 0; k < NL; k++) {
      const kq = flip ? FLIP[k] : k;
      if (!fit(q, e, k, kq)) continue;
      const r = q.l[kq] - (a * e.l[k] + b);
      if (Math.abs(r) > tol) continue;
      const w = CELL_W[k], x = e.l[k], y = q.l[kq];
      sw += w;
      sx += w * x;
      sy += w * y;
      sxx += w * x * x;
      sxy += w * x * y;
    }
    if (sw < 0.1 * wTot) break;
    const den = sw * sxx - sx * sx;
    if (den < 1e-9) break;
    a = (sw * sxy - sx * sy) / den;
    b = (sy - a * sx) / sw;
  }
  // контраст должен быть того же знака и правдоподобной силы
  simDbg.a = a;
  simDbg.why = 'a';
  if (!(a > 0.25 && a < 3)) return 0;
  const tolL = a * Math.max(TAU_L * e.sd, TOL_L_MIN);
  let costL = 0, wOk = 0;
  for (let k = 0; k < NL; k++) {
    const kq = flip ? FLIP[k] : k;
    const w = CELL_W[k];
    if (q.ok[kq] === 0) continue;
    wOk += w;
    if (q.ok[kq] === 2) {
      // пересвет в кадре: в дизайне белое — согласны; иначе блик — «не знаю» (полстоимости)
      costL += e.white[k] ? 0 : 0.35 * w;
      continue;
    }
    const r = (q.l[kq] - (a * e.l[k] + b)) / tolL;
    const c = r * r;
    // ярче, чем ждали, — скорее блик, чем другой рисунок: стоимость такой клетки не больше BRIGHT_CAP
    costL += w * (c > 1 ? (r > 0 ? BRIGHT_CAP : 1) : r > 0 && c > BRIGHT_CAP ? BRIGHT_CAP : c);
  }
  simDbg.why = 'valid';
  if (wOk < MIN_VALID * wTot) return 0;
  simDbg.why = '';
  costL /= wOk;
  let costC = 0, nC = 0;
  for (let k = 0; k < NC; k++) {
    const kq = flip ? CFLIP[k] : k;
    const e0 = e.c[k * 2], e1 = e.c[k * 2 + 1], q0 = q.c[kq * 2], q1 = q.c[kq * 2 + 1];
    if (!(Number.isFinite(e0) && Number.isFinite(q0))) continue;
    const d = ((q0 - e0) ** 2 + (q1 - e1) ** 2) / (TAU_C * TAU_C);
    costC += d > 1 ? 1 : d;
    nC++;
  }
  costC = nC ? costC / nC : 1;
  const dm = Math.hypot(q.cm[0] - e.cm[0], q.cm[1] - e.cm[1]);
  const costM = Math.min(1, Math.max(0, dm - 0.1) / 0.2);
  const cost = 0.6 * costL + 0.3 * costC + 0.1 * costM;
  simDbg.l = costL;
  simDbg.c = costC;
  simDbg.m = costM;
  simDbg.a = a;
  return 1 - cost;
}

const qd = newDesc();
export const fpProf = { ms: 0, n: 0 };

/** лучшая запись базы для канонического изображения (R, G, B — буферы verify.ts) */
export function matchDesign(R: Float32Array, G: Float32Array, B: Float32Array, cw: number, ch: number, entries: DbEntry[] = designDb()): Match {
  const best: Match = { id: -1, score: 0, hit: false, margin: -1, rot180: false };
  if (!entries.length) return best;
  describe(R, G, B, cw, ch, qd);
  for (const e of entries) {
    if (e.thr <= 0) continue;
    for (const flip of [false, true]) {
      const s = similarity(qd, e, flip);
      const m = s - e.thr;
      if (m > best.margin) {
        best.margin = m;
        best.score = s;
        best.id = e.id;
        best.rot180 = flip;
      }
    }
  }
  best.hit = best.margin >= 0;
  return best;
}

/** дескриптор последнего matchDesign (тесты) */
export function lastDesc(): Desc {
  return qd;
}

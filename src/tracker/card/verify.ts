/**
 * «Это банковская карта? Это карта Сбера?» — проверка кандидата-четырёхугольника по содержимому.
 *
 * Кандидат выпрямляется гомографией в канонический прямоугольник карты (200 × 126, цвет; длинная сторона —
 * ширина) и по нему считаются признаки:
 *   chip    — чип EMV: металлический (золото/серебро) прямоугольник в зоне по ISO 7816 (у короткого края
 *             посередине; при повороте карты на 180° — у другого), отличается по цвету от фона и обведён краем;
 *   back    — оборот: тёмная ровная магнитная полоса во всю ширину у длинного края;
 *   logo    — знак Сбера по ФОРМЕ: кольцо с «галочкой» внутри (кольцо разомкнуто справа вверху), в углу карты
 *             (любая ориентация дизайна). Цвет не важен: белый на фото, зелёный градиент, чёрный на белом —
 *             сравниваем яркость штрихов с фоном внутри и вокруг;
 *   green   — фирменный жёлто-зелёно-голубой цвет (компактный круглый градиентный знак или зелёное тело карты) —
 *             дополнительный признак Сбера;
 *   ps      — логотип платёжной системы: контрастная клякса в углу;
 *   corners — скруглённые углы (радиус 3,18 мм): у острого угла — фон, а не тело карты;
 *   tex     — внутри есть рисунок; flat — антипризнак «ровная поверхность» (лист, выключенный экран, коробка).
 * Признаки → логистическая модель «карта» и правило «Сбер» (веса подобраны на реальных кадрах и синтетике
 * из каталога дизайнов, tests/card/verify.test.ts).
 *
 * ПРИВАТНОСТЬ: ничего не читаем — ни номер, ни имя, ни срок, ни CVC (никакого OCR). Изображение карты нигде не
 * сохраняется и никуда не отправляется: всё считается в памяти воркера (буферы переиспользуются и
 * перезаписываются следующим кадром). См. docs/PRIVACY.md.
 */
import { matchDesign } from './fingerprint';
import { type Pt, type Intrinsics, CARD_ASPECT, CARD_RADIUS, homography, applyH, metricShape, orderClockwise, rotateQuad, type Quad } from './geometry';

export const CW = 200;
export const CH = 126;

export interface Img {
  rgba: Uint8ClampedArray | Uint8Array;
  w: number;
  h: number;
}

export interface CardFeatures {
  chip: number;
  back: number;
  /** знак Сбера по форме (кольцо с галочкой) */
  logo: number;
  /** фирменный зелёный (градиентный знак или тело карты) */
  green: number;
  /** похожесть на лучший известный дизайн Сбера по отпечатку 0..1 (fingerprint.ts) */
  design: number;
  /** отпечаток совпал с известным дизайном (score ≥ порога записи) */
  designHit: boolean;
  /** номер дизайна в каталоге (−1 — нет) */
  designId: number;
  ps: number;
  corners: number;
  tex: number;
  flat: number;
  /** резкость (для переверификации: размытый кадр — «не знаю», а не «не карта») */
  sharp: number;
  /** ширина карты в пикселях источника (на маленькой карте мелкие признаки не видны) */
  px: number;
}

export interface CardVerdict {
  /** вероятность «банковская карта» 0..1 */
  card: number;
  /** «карта Сбера» 0..1 (при условии, что карта) */
  sber: number;
  side: 'front' | 'back';
  f: CardFeatures;
  ms: number;
}

/** веса логистической модели «карта» (подбор — tests/card/verify.test.ts, EXPLORE=1) */
export const CARD_W = { b: -3.0, chip: 5.0, back: 5.0, logo: 2.5, ps: 0.8, corners: 0.8, tex: 1.6, flat: -3.0 };
/** порог «это Сбер» по признаку sber */
export const SBER_MIN = 0.5;

const sig = (z: number) => 1 / (1 + Math.exp(-z));
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ───── буферы канонического изображения (переиспользуются: ни одной аллокации на кадр) ─────
const N = CW * CH;
const R = new Float32Array(N), G = new Float32Array(N), B = new Float32Array(N);
const L = new Float32Array(N), S = new Float32Array(N), Hh = new Float32Array(N), V = new Float32Array(N);
const GM = new Float32Array(N);
const IW = CW + 1;
const iR = new Float64Array(IW * (CH + 1)), iG = new Float64Array(IW * (CH + 1)), iB = new Float64Array(IW * (CH + 1));
const iL = new Float64Array(IW * (CH + 1)), iL2 = new Float64Array(IW * (CH + 1));
const mask = new Uint8Array(N);
const lab = new Int32Array(N);
const stack = new Int32Array(N);

/**
 * Нумерация углов так, чтобы q0→q1 была длинной стороной карты (по метрике при фокусе K, иначе — по длине
 * на изображении). Порядок — по часовой стрелке на экране: лицевая сторона к камере не отражается.
 */
export function cardCorners(q: Pt[], K?: Intrinsics): Quad {
  const c = orderClockwise(q);
  let long01: boolean;
  const m = K ? metricShape(c, K) : null;
  const d = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
  const img01 = (d(c[0], c[1]) + d(c[2], c[3])) / (d(c[1], c[2]) + d(c[3], c[0]));
  if (m && Number.isFinite(m.aspect) && Math.abs(Math.log(m.aspect)) > 0.15) long01 = m.aspect >= 1;
  else long01 = img01 >= 1;
  return long01 ? c : rotateQuad(c, 1);
}

/** выпрямить карту: q — TL, TR, BR, BL (q0→q1 — длинная сторона) */
export function warpCard(img: Img, q: Quad): boolean {
  const H = homography([{ x: 0, y: 0 }, { x: CW, y: 0 }, { x: CW, y: CH }, { x: 0, y: CH }], q);
  if (!H) return false;
  const { rgba, w, h } = img;
  // прямой проход по строке: числители и знаменатель гомографии линейны по x
  let i = 0;
  for (let y = 0; y < CH; y++) {
    const yy = y + 0.5;
    let nx = H[0] * 0.5 + H[1] * yy + H[2], ny = H[3] * 0.5 + H[4] * yy + H[5], dw = H[6] * 0.5 + H[7] * yy + H[8];
    for (let x = 0; x < CW; x++, i++, nx += H[0], ny += H[3], dw += H[6]) {
      let sx = nx / dw - 0.5, sy = ny / dw - 0.5;
      if (!(sx >= 0)) sx = 0;
      if (!(sy >= 0)) sy = 0;
      if (sx > w - 1.001) sx = w - 1.001;
      if (sy > h - 1.001) sy = h - 1.001;
      const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
      const a = (y0 * w + x0) * 4, b = a + 4, c = a + w * 4, d = c + 4;
      const w00 = (1 - fx) * (1 - fy), w01 = fx * (1 - fy), w10 = (1 - fx) * fy, w11 = fx * fy;
      R[i] = (rgba[a] * w00 + rgba[b] * w01 + rgba[c] * w10 + rgba[d] * w11) / 255;
      G[i] = (rgba[a + 1] * w00 + rgba[b + 1] * w01 + rgba[c + 1] * w10 + rgba[d + 1] * w11) / 255;
      B[i] = (rgba[a + 2] * w00 + rgba[b + 2] * w01 + rgba[c + 2] * w10 + rgba[d + 2] * w11) / 255;
    }
  }
  for (let k = 0; k < N; k++) {
    const r = R[k], g = G[k], bb = B[k];
    const mx = r > g ? (r > bb ? r : bb) : g > bb ? g : bb;
    const mn = r < g ? (r < bb ? r : bb) : g < bb ? g : bb;
    const dd = mx - mn;
    V[k] = mx;
    S[k] = mx > 1e-3 ? dd / mx : 0;
    L[k] = 0.299 * r + 0.587 * g + 0.114 * bb;
    let hu = 0;
    if (dd > 1e-4) {
      if (mx === r) hu = ((g - bb) / dd) % 6;
      else if (mx === g) hu = (bb - r) / dd + 2;
      else hu = (r - g) / dd + 4;
      hu *= 60;
      if (hu < 0) hu += 360;
    }
    Hh[k] = hu;
  }
  GM.fill(0);
  for (let y = 1; y < CH - 1; y++)
    for (let x = 1; x < CW - 1; x++) {
      const k = y * CW + x;
      const gx = L[k + 1] - L[k - 1], gy = L[k + CW] - L[k - CW];
      const cx = Math.abs(R[k + 1] - R[k - 1]) + Math.abs(B[k + 1] - B[k - 1]);
      const cy = Math.abs(R[k + CW] - R[k - CW]) + Math.abs(B[k + CW] - B[k - CW]);
      GM[k] = Math.hypot(gx, gy) + 0.25 * (cx + cy);
    }
  // интегральные изображения
  for (let y = 0; y < CH; y++) {
    let sr = 0, sg = 0, sb = 0, sl = 0, sl2 = 0;
    for (let x = 0; x < CW; x++) {
      const k = y * CW + x;
      sr += R[k];
      sg += G[k];
      sb += B[k];
      sl += L[k];
      sl2 += L[k] * L[k];
      const o = (y + 1) * IW + x + 1, up = y * IW + x + 1;
      iR[o] = iR[up] + sr;
      iG[o] = iG[up] + sg;
      iB[o] = iB[up] + sb;
      iL[o] = iL[up] + sl;
      iL2[o] = iL2[up] + sl2;
    }
  }
  return true;
}

interface Box {
  r: number;
  g: number;
  b: number;
  l: number;
  sd: number;
}
/** средний цвет, яркость и разброс яркости прямоугольника [x0, x1) × [y0, y1) (в px канонического) */
function boxMean(x0: number, y0: number, x1: number, y1: number): Box {
  x0 = Math.max(0, Math.min(CW - 1, Math.round(x0)));
  y0 = Math.max(0, Math.min(CH - 1, Math.round(y0)));
  x1 = Math.max(x0 + 1, Math.min(CW, Math.round(x1)));
  y1 = Math.max(y0 + 1, Math.min(CH, Math.round(y1)));
  const a = y0 * IW + x0, b = y0 * IW + x1, c = y1 * IW + x0, d = y1 * IW + x1;
  const n = (x1 - x0) * (y1 - y0);
  const s = (A: Float64Array) => (A[d] - A[b] - A[c] + A[a]) / n;
  const l = s(iL);
  return { r: s(iR), g: s(iG), b: s(iB), l, sd: Math.sqrt(Math.max(0, s(iL2) - l * l)) };
}

function hueSat(c: { r: number; g: number; b: number }) {
  const mx = Math.max(c.r, c.g, c.b), mn = Math.min(c.r, c.g, c.b), d = mx - mn;
  let hu = 0;
  if (d > 1e-4) {
    if (mx === c.r) hu = ((c.g - c.b) / d) % 6;
    else if (mx === c.g) hu = (c.b - c.r) / d + 2;
    else hu = (c.r - c.g) / d + 4;
    hu *= 60;
    if (hu < 0) hu += 360;
  }
  return { h: hu, s: mx > 1e-3 ? d / mx : 0, v: mx };
}

/** «металл»: золото (жёлто-оранжевый, умеренная насыщенность) или серебро (почти без цвета, не чёрное) */
export function metallic(c: { r: number; g: number; b: number }) {
  const { h, s, v } = hueSat(c);
  const gold = h >= 20 && h <= 62 && s >= 0.12 && s <= 0.75 && v > 0.28 ? 1 - Math.abs(h - 42) / 32 : 0;
  const silver = s < 0.17 && v > 0.33 && v < 0.97 ? 1 - s / 0.22 : 0;
  return clamp01(Math.max(gold * 1.2, silver * 0.75));
}

// ───── чип: перебор прямоугольников (положение и размер) по интегралам направленных градиентов ─────
const GXI = new Float32Array((CW + 1) * CH); // по строкам: накопленная |∂/∂y| (края горизонтальных сторон)
const GYI = new Float32Array((CH + 1) * CW); // по столбцам: накопленная |∂/∂x| (края вертикальных сторон)
const iGold = new Float32Array(IW * (CH + 1)), iSilv = new Float32Array(IW * (CH + 1));

function chipPrep() {
  for (let y = 0; y < CH; y++) {
    let acc = 0;
    GXI[y * (CW + 1)] = 0;
    for (let x = 0; x < CW; x++) {
      const k = y * CW + x;
      let g = 0;
      if (y > 0 && y < CH - 1) g = Math.abs(L[k + CW] - L[k - CW]) + 0.3 * (Math.abs(R[k + CW] - R[k - CW]) + Math.abs(B[k + CW] - B[k - CW]));
      acc += g;
      GXI[y * (CW + 1) + x + 1] = acc;
    }
  }
  for (let x = 0; x < CW; x++) {
    let acc = 0;
    GYI[x * (CH + 1)] = 0;
    for (let y = 0; y < CH; y++) {
      const k = y * CW + x;
      let g = 0;
      if (x > 0 && x < CW - 1) g = Math.abs(L[k + 1] - L[k - 1]) + 0.3 * (Math.abs(R[k + 1] - R[k - 1]) + Math.abs(B[k + 1] - B[k - 1]));
      acc += g;
      GYI[x * (CH + 1) + y + 1] = acc;
    }
  }
  for (let y = 0; y < CH; y++) {
    let sg = 0, ss = 0;
    for (let x = 0; x < CW; x++) {
      const k = y * CW + x;
      const h = Hh[k], sa = S[k], v = V[k];
      if (h >= 20 && h <= 62 && sa >= 0.15 && sa <= 0.8 && v > 0.3) sg++;
      else if (sa < 0.15 && v > 0.35 && v < 0.98) ss++;
      const o = (y + 1) * IW + x + 1, up = y * IW + x + 1;
      iGold[o] = iGold[up] + sg;
      iSilv[o] = iSilv[up] + ss;
    }
  }
}
/** горизонтальный отрезок [x0, x1) на строке y: средний вертикальный градиент (максимум по y ± 1) */
function hEdge(x0: number, x1: number, y: number) {
  let m = 0;
  for (let d = -1; d <= 1; d++) {
    const yy = y + d;
    if (yy < 1 || yy >= CH - 1) continue;
    const o = yy * (CW + 1);
    const v = (GXI[o + x1] - GXI[o + x0]) / (x1 - x0);
    if (v > m) m = v;
  }
  return m;
}
function vEdge(y0: number, y1: number, x: number) {
  let m = 0;
  for (let d = -1; d <= 1; d++) {
    const xx = x + d;
    if (xx < 1 || xx >= CW - 1) continue;
    const o = xx * (CH + 1);
    const v = (GYI[o + y1] - GYI[o + y0]) / (y1 - y0);
    if (v > m) m = v;
  }
  return m;
}
function boxSum(I: Float32Array, x0: number, y0: number, x1: number, y1: number) {
  return (I[y1 * IW + x1] - I[y0 * IW + x1] - I[y1 * IW + x0] + I[y0 * IW + x0]) / Math.max(1, (x1 - x0) * (y1 - y0));
}

export const chipBest = { x0: 0, y0: 0, x1: 0, y1: 0, e: 0, d: 0, metal: 0, s: 0 };
/**
 * Чип в зоне ISO 7816 (лицевая сторона; flip — карта повёрнута на 180°): прямоугольник 0,085–0,15 ширины
 * карты с краем по всем четырём сторонам (заметно сильнее, чем рядом снаружи), металлического цвета внутри.
 */
function chipScore(flip: boolean, card: Box) {
  chipBest.s = 0;
  // грубо (шаг 3 px) → уточнение ±1 px вокруг лучшего
  let bw = 0, bh = 0, bx = 0, by = 0, best = 0;
  for (let w = Math.round(0.085 * CW); w <= 0.15 * CW; w += 3)
    for (let h = Math.round(w / 1.45); h <= w / 0.95 && h <= 0.24 * CH; h += 3)
      for (let ucx = 0.1 * CW; ucx <= 0.25 * CW; ucx += 3)
        for (let vcy = 0.33 * CH; vcy <= 0.62 * CH; vcy += 3) {
          const cx = flip ? CW - ucx : ucx, cy = flip ? CH - vcy : vcy;
          const sc = chipAt(cx, cy, w, h, card);
          if (sc > best) (best = sc), (bw = w), (bh = h), (bx = cx), (by = cy);
        }
  if (best <= 0) return 0;
  for (let dw = -2; dw <= 2; dw++)
    for (let dh = -2; dh <= 2; dh++)
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++) {
          const sc = chipAt(bx + dx, by + dy, bw + dw, bh + dh, card);
          if (sc > best) best = sc;
        }
  return best;
}

function chipAt(cx: number, cy: number, w: number, h: number, card: Box) {
  const o = 3; // смещение «соседних» линий наружу, px
  const x0 = Math.round(cx - w / 2), x1 = x0 + w, y0 = Math.round(cy - h / 2), y1 = y0 + h;
  if (x0 < o + 2 || y0 < o + 2 || x1 > CW - o - 2 || y1 > CH - o - 2) return 0;
  const t = hEdge(x0 + 2, x1 - 2, y0), bt = hEdge(x0 + 2, x1 - 2, y1);
  const l = vEdge(y0 + 2, y1 - 2, x0), r = vEdge(y0 + 2, y1 - 2, x1);
  // вторая по слабости сторона (одну может «съесть» блик)
  let a1 = t, a2 = bt, a3 = l, a4 = r, tmp;
  if (a1 > a2) (tmp = a1), (a1 = a2), (a2 = tmp);
  if (a3 > a4) (tmp = a3), (a3 = a4), (a4 = tmp);
  const second = a1 < a3 ? Math.min(a2, a3) : Math.min(a1, a4);
  if (second < 0.04) return 0;
  const ref = (hEdge(x0 + 2, x1 - 2, y0 - o) + hEdge(x0 + 2, x1 - 2, y1 + o) + vEdge(y0 + 2, y1 - 2, x0 - o) + vEdge(y0 + 2, y1 - 2, x1 + o)) / 4;
  const e = clamp01((second / (ref + 0.025) - 1.0) / 1.3);
  if (e <= 0) return 0;
  const mx0 = x0 + 2, mx1 = x1 - 2, my0 = y0 + 2, my1 = y1 - 2;
  const gold = boxSum(iGold, mx0, my0, mx1, my1), silv = boxSum(iSilv, mx0, my0, mx1, my1);
  if (e * (0.25 + 0.75 * clamp01(Math.max(gold * 1.5, silv))) <= chipBest.s * 0.5) return 0;
  const core = boxMean(mx0, my0, mx1, my1);
  const ring = boxMean(x0 - o - 2, y0 - o - 2, x1 + o + 2, y1 + o + 2);
  const diff = Math.max(Math.hypot(core.r - ring.r, core.g - ring.g, core.b - ring.b) * 1.6, 0.7 * Math.hypot(core.r - card.r, core.g - card.g, core.b - card.b));
  const d = clamp01(diff / 0.15);
  // серебро (серый) встречается везде — засчитываем, только если чип заметно отличается от карты вокруг
  const metal = clamp01(Math.max(gold * 1.5, silv * 0.55 * d));
  const sc = e * (0.25 + 0.75 * metal) * (0.55 + 0.45 * d);
  if (sc > chipBest.s) {
    chipBest.s = sc;
    chipBest.x0 = x0;
    chipBest.y0 = y0;
    chipBest.x1 = x1;
    chipBest.y1 = y1;
    chipBest.e = e;
    chipBest.d = d;
    chipBest.metal = metal;
  }
  return sc;
}

/** магнитная полоса (оборот): тёмная ровная полоса во всю ширину у длинного края */
function backScore(flip: boolean) {
  let best = 0;
  for (const [v0, v1] of [[0.08, 0.26], [0.1, 0.3], [0.06, 0.22], [0.12, 0.3]]) {
    const a0 = flip ? 1 - v1 : v0, a1 = flip ? 1 - v0 : v1;
    const band = boxMean(0.03 * CW, a0 * CH + 2, 0.97 * CW, a1 * CH - 2);
    const rest = flip ? boxMean(0.04 * CW, 0.05 * CH, 0.96 * CW, (a0 - 0.08) * CH) : boxMean(0.04 * CW, (a1 + 0.08) * CH, 0.96 * CW, 0.95 * CH);
    let cm = 0, c2 = 0;
    for (let k = 0; k < 8; k++) {
      const l = boxMean((0.03 + k * 0.1175) * CW, a0 * CH + 2, (0.03 + (k + 1) * 0.1175) * CW, a1 * CH - 2).l;
      cm += l;
      c2 += l * l;
    }
    cm /= 8;
    const csd = Math.sqrt(Math.max(0, c2 / 8 - cm * cm));
    const dark = clamp01((0.45 - band.l) / 0.25);
    const contrast = clamp01((rest.l - band.l - 0.1) / 0.2);
    const even = clamp01(1 - (csd + band.sd * 0.5) / 0.12);
    const s = dark * contrast * even;
    if (s > best) best = s;
  }
  return best;
}

// ───── знак Сбера по форме: кольцо с галочкой ─────
// единица — внешний радиус кольца; y вниз; кольцо разомкнуто справа вверху, хвост галочки уходит в разрыв
const LOGO_RING: [number, number][] = [];
for (let a = -5; a <= 250; a += 15) LOGO_RING.push([0.84 * Math.cos((a * Math.PI) / 180), 0.84 * Math.sin((a * Math.PI) / 180)]);
const LOGO_CHECK: [number, number][] = [];
{
  // галочка: короткий штрих вниз-вправо и начало длинного вверх-вправо (длина хвоста у знаков разная — берём начало)
  const P: [number, number][] = [[-0.42, -0.1], [-0.05, 0.18], [0.6, -0.42]];
  for (let k = 0; k <= 4; k++) LOGO_CHECK.push([P[0][0] + (P[1][0] - P[0][0]) * (k / 4), P[0][1] + (P[1][1] - P[0][1]) * (k / 4)]);
  for (let k = 1; k <= 4; k++) LOGO_CHECK.push([P[1][0] + (P[2][0] - P[1][0]) * (k * 0.15), P[1][1] + (P[2][1] - P[1][1]) * (k * 0.15)]);
}
const LOGO_IN: [number, number][] = [[0, -0.5], [-0.3, -0.45], [-0.1, -0.3], [0.15, -0.2], [0.45, 0.22], [-0.45, 0.32], [0.1, 0.55], [-0.2, 0.52], [0.32, 0.45]];
/** разрыв кольца справа вверху — там фон (хвост галочки проходит ближе к центру) */
const LOGO_GAP: [number, number][] = [-50, -56].map((a) => [0.93 * Math.cos((a * Math.PI) / 180), 0.93 * Math.sin((a * Math.PI) / 180)] as [number, number]);
const LOGO_OUT: [number, number][] = [];
for (let a = 0; a < 360; a += 30) LOGO_OUT.push([1.42 * Math.cos((a * Math.PI) / 180), 1.42 * Math.sin((a * Math.PI) / 180)]);

let LS: Float32Array = L; // откуда берём яркость для знака: L (резкая) или LB (размытая, грубый поиск)
const LB = new Float32Array(N);
function sampleL(x: number, y: number) {
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x > CW - 1.001) x = CW - 1.001;
  if (y > CH - 1.001) y = CH - 1.001;
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, k = y0 * CW + x0;
  return (LS[k] * (1 - fx) + LS[k + 1] * fx) * (1 - fy) + (LS[k + CW] * (1 - fx) + LS[k + CW + 1] * fx) * fy;
}

const vals = new Float32Array(64);
let nv = 0;
/** яркости в точках шаблона (в vals[from..]) и их среднее */
function sampleSet(pts: [number, number][], cx: number, cy: number, r: number, c: number, s: number) {
  let m = 0;
  for (let i = 0; i < pts.length; i++) {
    const u = pts[i][0], v = pts[i][1];
    const l = sampleL(cx + r * (c * u - s * v), cy + r * (s * u + c * v));
    vals[nv++] = l;
    m += l;
  }
  return m / pts.length;
}
/** доля значений vals[a..b) по «ту сторону» порога t (sign > 0 — выше) */
function fracSide(a: number, b: number, t: number, sign: number) {
  let n = 0;
  for (let i = a; i < b; i++) if ((vals[i] - t) * sign > 0) n++;
  return n / (b - a);
}

/**
 * Оценка знака в точке (cx, cy) радиуса r, повёрнутого на rot·90°. Устойчиво к выбросам (буква рядом, блик):
 * считаем, какая доля точек кольца и галочки ярче/темнее середины между ними и фоном, а фона — наоборот.
 * strict = false — мягкая оценка для грубого поиска (без порогов), true — итоговая 0..1.
 */
export function logoAt(cx: number, cy: number, r: number, rot: number, strict = true) {
  const c = [1, 0, -1, 0][rot], s = [0, 1, 0, -1][rot];
  nv = 0;
  const rm = sampleSet(LOGO_RING, cx, cy, r, c, s);
  const e1 = nv;
  const cm = sampleSet(LOGO_CHECK, cx, cy, r, c, s);
  const e2 = nv;
  const im = sampleSet(LOGO_IN, cx, cy, r, c, s);
  const e3 = nv;
  const om = sampleSet(LOGO_OUT, cx, cy, r, c, s);
  const e4 = nv;
  const mb = (im + om) / 2;
  const dr = rm - mb, dc = cm - mb;
  if (dr * dc <= 0) return 0;
  const sign = dr > 0 ? 1 : -1;
  const t = mb + dr * 0.5;
  if (!strict) {
    // грубый поиск по размытой яркости: средние доли (без секторов) — только чтобы выбрать места для точной проверки
    const p = fracSide(0, e1, t, sign) * fracSide(e1, e2, mb + dc * 0.5, sign) * fracSide(e2, e3, t, -sign) * Math.min(1, fracSide(e3, e4, t, -sign) + 0.2);
    return p * Math.min(1, Math.abs(dr) / 0.1);
  }
  sampleSet(LOGO_GAP, cx, cy, r, c, s);
  const e5 = nv;
  // кольцо — по секторам (справа, снизу, слева, сверху): знак — замкнутая дуга, а не край пятна
  const q = e1 >> 2;
  const fr = Math.min(fracSide(0, q, t, sign), fracSide(q, 2 * q, t, sign), fracSide(2 * q, 3 * q, t, sign), fracSide(3 * q, e1, t, sign));
  const fc = fracSide(e1, e2, mb + dc * 0.5, sign);
  // фон внутри: верхняя и нижняя половины (по построению LOGO_IN: первые 4 — верх, остальные — низ)
  const fi = Math.min(fracSide(e2, e2 + 4, t, -sign), fracSide(e2 + 4, e3, t, -sign));
  const fo = fracSide(e3, e4, t, -sign);
  const fg = fracSide(e4, e5, t, -sign);
  const p = fr * fc * fi * Math.min(1, fo + 0.15) * (0.6 + 0.4 * fg);
  if (Math.abs(dr) < 0.07 || Math.abs(dc) < 0.05) return 0;
  return clamp01((p - 0.3) / 0.45) * clamp01(Math.abs(dr) / 0.12);
}

/** где нашёлся знак (debug, тесты) */
export const logoBest = { x: 0, y: 0, r: 0, rot: 0, s: 0 };

const seeds: { x: number; y: number; r: number; rot: number; s: number }[] = [];
/** знак Сбера у угла «верх-лево» дизайна: любая из 4 ориентаций дизайна на карте. Грубо (размытая яркость) → точно */
function logoScore() {
  // размытие 3×3 для грубого поиска: шире «воронка» вокруг правильного положения
  for (let y = 1; y < CH - 1; y++)
    for (let x = 1; x < CW - 1; x++) {
      const k = y * CW + x;
      LB[k] = (L[k - CW - 1] + L[k - CW] + L[k - CW + 1] + L[k - 1] + L[k] + L[k + 1] + L[k + CW - 1] + L[k + CW] + L[k + CW + 1]) / 9;
    }
  LS = LB;
  seeds.length = 0;
  // (правый? нижний? поворот знака ×90°)
  const combos: [number, number, number][] = [
    [0, 0, 0], // обычная ориентация: левый верхний
    [1, 1, 2], // карта перевёрнута: правый нижний, знак повёрнут на 180°
    [1, 0, 1], // вертикальный дизайн: правый верхний, поворот +90°
    [0, 1, 3], // вертикальный дизайн, повёрнутый иначе: левый нижний, −90°
  ];
  for (const [fx, fy, rot] of combos) {
    const vert = rot === 1 || rot === 3;
    // три лучших несоседних места для этой ориентации
    const top: { x: number; y: number; r: number; s: number }[] = [];
    for (let rr = 0.031; rr <= 0.064; rr += 0.0085) {
      const r = rr * CW;
      // a — вдоль «горизонтали» дизайна, b — вдоль его «вертикали» (px канонического)
      for (let a = 0.045 * CW; a <= 0.19 * CW; a += 2.5)
        for (let b = 0.07 * CH; b <= 0.32 * CH; b += 2.5) {
          const ux = vert ? b : a, vy = vert ? a : b;
          if (vy > 0.45 * CH) continue;
          const cx = fx ? CW - ux : ux, cy = fy ? CH - vy : vy;
          const sc = logoAt(cx, cy, r, rot, false);
          if (sc <= 0 || (top.length === 3 && sc <= top[2].s)) continue;
          const near = top.findIndex((t) => Math.hypot(t.x - cx, t.y - cy) < 4);
          if (near >= 0) {
            if (sc > top[near].s) top[near] = { x: cx, y: cy, r, s: sc };
          } else {
            top.push({ x: cx, y: cy, r, s: sc });
          }
          top.sort((p, q) => q.s - p.s);
          if (top.length > 3) top.length = 3;
        }
    }
    for (const t of top) seeds.push({ ...t, rot });
  }
  LS = L;
  let best = 0;
  for (const sd of seeds) {
    if (sd.s < 0.05) continue;
    for (let dr = -2; dr <= 2; dr += 1)
      for (let dx = -1.5; dx <= 1.5; dx += 0.75)
        for (let dy = -1.5; dy <= 1.5; dy += 0.75) {
          const sc = logoAt(sd.x + dx, sd.y + dy, sd.r + dr, sd.rot);
          if (sc > best) {
            best = sc;
            logoBest.x = sd.x + dx;
            logoBest.y = sd.y + dy;
            logoBest.r = sd.r + dr;
            logoBest.rot = sd.rot;
          }
        }
  }
  logoBest.s = best;
  return best;
}

/** фирменный зелёный: компактная круглая жёлто-зелёно-голубая клякса или зелёное тело карты */
function greenScore(): number {
  let body = 0, tot = 0;
  const m = 6;
  for (let y = m; y < CH - m; y++)
    for (let x = m; x < CW - m; x++) {
      const k = y * CW + x;
      tot++;
      const h = Hh[k], s = S[k], v = V[k];
      mask[k] = h >= 70 && h <= 205 && s > 0.33 && v > 0.28 ? 1 : 0;
      if (h >= 100 && h <= 160 && s > 0.42 && v > 0.3) body++;
    }
  const bodyFrac = body / (tot || 1);
  lab.fill(0);
  let best = 0, nl = 0;
  const areaCard = CW * CH;
  for (let y = m; y < CH - m; y++)
    for (let x = m; x < CW - m; x++) {
      const k0 = y * CW + x;
      if (!mask[k0] || lab[k0]) continue;
      nl++;
      let sp = 0;
      stack[sp++] = k0;
      lab[k0] = nl;
      let area = 0, minx = x, maxx = x, miny = y, maxy = y, hs = 0, hs2 = 0, ends = 0;
      while (sp) {
        const k = stack[--sp];
        area++;
        const kx = k % CW, ky = (k / CW) | 0;
        if (kx < minx) minx = kx;
        if (kx > maxx) maxx = kx;
        if (ky < miny) miny = ky;
        if (ky > maxy) maxy = ky;
        const h = Hh[k];
        hs += h;
        hs2 += h * h;
        if (h < 105 || h > 165) ends++;
        if (kx > m && !lab[k - 1] && mask[k - 1]) (lab[k - 1] = nl), (stack[sp++] = k - 1);
        if (kx < CW - m - 1 && !lab[k + 1] && mask[k + 1]) (lab[k + 1] = nl), (stack[sp++] = k + 1);
        if (ky > m && !lab[k - CW] && mask[k - CW]) (lab[k - CW] = nl), (stack[sp++] = k - CW);
        if (ky < CH - m - 1 && !lab[k + CW] && mask[k + CW]) (lab[k + CW] = nl), (stack[sp++] = k + CW);
      }
      const bw = maxx - minx + 1, bh = maxy - miny + 1;
      const af = area / areaCard;
      if (af < 0.002 || af > 0.035) continue;
      const asp = bw / bh;
      if (asp < 0.6 || asp > 1.7) continue;
      const fill = area / (bw * bh);
      if (fill < 0.35) continue;
      const hm = hs / area, hsd = Math.sqrt(Math.max(0, hs2 / area - hm * hm));
      const round = clamp01(1 - Math.abs(asp - 1) / 0.7) * clamp01(1 - Math.abs(fill - 0.7) / 0.4);
      const grad = clamp01(hsd / 25) * 0.5 + clamp01(ends / area / 0.15) * 0.5;
      const sc = round * grad;
      if (sc > best) best = sc;
    }
  return clamp01(Math.max(best * 1.2, (bodyFrac - 0.35) / 0.25));
}

/**
 * Логотип платёжной системы в углу (правый нижний при обычной ориентации, или противоположный при 180°):
 * МИР — зелёные буквы (вытянутая по горизонтали зелёная область, часто на светлой плашке);
 * Mastercard — красный и жёлто-оранжевый круги рядом; Visa/UnionPay — компактная контрастная надпись.
 */
function psScore(card: Box) {
  let best = 0;
  for (const flip of [false, true]) {
    const u0 = flip ? 0.04 : 0.62, u1 = flip ? 0.38 : 0.96, v0 = flip ? 0.06 : 0.66, v1 = flip ? 0.34 : 0.94;
    let green = 0, red = 0, yellow = 0, light = 0, far = 0, n = 0;
    let gx0 = 1e9, gx1 = -1, gy0 = 1e9, gy1 = -1;
    for (let y = Math.round(v0 * CH); y < v1 * CH; y++)
      for (let x = Math.round(u0 * CW); x < u1 * CW; x++) {
        const k = y * CW + x;
        n++;
        const h = Hh[k], sa = S[k], v = V[k];
        if (h >= 95 && h <= 175 && sa > 0.4 && v > 0.25) {
          green++;
          if (x < gx0) gx0 = x;
          if (x > gx1) gx1 = x;
          if (y < gy0) gy0 = y;
          if (y > gy1) gy1 = y;
        }
        if ((h < 15 || h > 340) && sa > 0.5 && v > 0.4) red++;
        if (h >= 25 && h <= 55 && sa > 0.5 && v > 0.5) yellow++;
        if (sa < 0.15 && v > 0.8) light++;
        if (Math.hypot(R[k] - card.r, G[k] - card.g, B[k] - card.b) > 0.3) far++;
      }
    n = n || 1;
    const gf = green / n;
    const gw = gx1 - gx0 + 1, gh = gy1 - gy0 + 1;
    const mir = gf > 0.02 && gf < 0.35 && gw > 1.8 * gh ? clamp01(gf / 0.06) * (0.6 + 0.4 * clamp01(light / n / 0.15)) : 0;
    const mc = clamp01(Math.min(red, yellow) / n / 0.04);
    const other = 0.5 * clamp01(1 - Math.abs(far / n - 0.25) / 0.2);
    const sc = Math.max(mir, mc, other);
    if (sc > best) best = sc;
  }
  return best;
}

/** скруглённые углы: у острого угла (внутри квадрата радиуса) — фон, а не тело карты */
function cornerScore(img: Img, q: Quad) {
  const hh = 1 / CARD_ASPECT;
  const H = homography([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: hh }, { x: 0, y: hh }], q);
  if (!H) return 0.5;
  const r = CARD_RADIUS;
  const px = (u: number, v: number) => {
    const p = applyH(H, { x: u, y: v });
    const x = Math.round(p.x), y = Math.round(p.y);
    if (!(x >= 0 && y >= 0 && x < img.w && y < img.h)) return null;
    const k = (y * img.w + x) * 4;
    return [img.rgba[k] / 255, img.rgba[k + 1] / 255, img.rgba[k + 2] / 255];
  };
  const p0 = applyH(H, { x: 0, y: 0 }), p1 = applyH(H, { x: r, y: 0 });
  if (Math.hypot(p1.x - p0.x, p1.y - p0.y) < 4) return 0.5; // радиус меньше 4 px — на этом разрешении не видно
  let s = 0, n = 0;
  for (const [cu, cv, du, dv] of [[0, 0, 1, 1], [1, 0, -1, 1], [1, hh, -1, -1], [0, hh, 1, -1]]) {
    const corner = px(cu + du * r * 0.2, cv + dv * r * 0.2);
    const inside = px(cu + du * r * 1.7, cv + dv * r * 1.7);
    const outA = px(cu - du * r * 0.9, cv + dv * r * 3), outB = px(cu + du * r * 3, cv - dv * r * 0.9);
    if (!corner || !inside || !outA || !outB) continue;
    const out = [(outA[0] + outB[0]) / 2, (outA[1] + outB[1]) / 2, (outA[2] + outB[2]) / 2];
    const dIn = Math.hypot(corner[0] - inside[0], corner[1] - inside[1], corner[2] - inside[2]);
    const dOut = Math.hypot(corner[0] - out[0], corner[1] - out[1], corner[2] - out[2]);
    const sep = Math.hypot(inside[0] - out[0], inside[1] - out[1], inside[2] - out[2]);
    if (sep < 0.12) continue; // карта того же цвета, что и стол, — не судим
    s += clamp01(0.5 + (dIn - dOut) / sep);
    n++;
  }
  return n ? s / n : 0.5;
}

const gl: number[] = [];
/** профиль по частям (мс, накопительно) — для тестов производительности */
export const prof = { warp: 0, stats: 0, chip: 0, logo: 0, green: 0, n: 0 };

/**
 * Проверить кандидата. img — кадр (или фрагмент кадра в большем разрешении), quad — углы карты в его пикселях,
 * K — фокус в пикселях img (для выбора длинной стороны под сильным наклоном).
 */
export function classifyCard(img: Img, quad: Pt[], K?: Intrinsics): CardVerdict | null {
  const t0 = now();
  const q = cardCorners(quad, K);
  if (!warpCard(img, q)) return null;
  const t1 = now();
  const card = boxMean(0.04 * CW, 0.06 * CH, 0.96 * CW, 0.94 * CH);
  gl.length = 0;
  for (let y = 6; y < CH - 6; y += 3)
    for (let x = 6; x < CW - 6; x += 3) {
      const g = GM[y * CW + x];
      gl.push(g);
    }
  gl.sort((a, b) => a - b);
  const g90 = gl[Math.floor(gl.length * 0.9)] ?? 0;
  let busy = 0;
  for (const g of gl) if (g > 0.06) busy++;
  const busyFrac = busy / (gl.length || 1);

  const t2 = now();
  chipPrep();
  const chip = Math.max(chipScore(false, card), chipScore(true, card));
  const t3 = now();
  const back = Math.max(backScore(false), backScore(true));
  const logo = logoScore();
  const t4 = now();
  const green = greenScore();
  const dm = matchDesign(R, G, B, CW, CH);
  const t5 = now();
  prof.warp += t1 - t0;
  prof.stats += t2 - t1;
  prof.chip += t3 - t2;
  prof.logo += t4 - t3;
  prof.green += t5 - t4;
  prof.n++;
  const ps = psScore(card);
  const corners = cornerScore(img, q);
  const tex = clamp01(busyFrac / 0.12) * 0.6 + clamp01(card.sd / 0.12) * 0.4;
  const flat = clamp01(1 - busyFrac / 0.04) * clamp01(1 - card.sd / 0.08);
  const sharp = clamp01(g90 / 0.1);
  const pxw = Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y);
  const f: CardFeatures = { chip, back, logo, green, design: dm.score, designHit: dm.hit, designId: dm.id, ps, corners, tex, flat, sharp, px: pxw };
  const W = CARD_W;
  const z = W.b + W.chip * chip + W.back * back + W.logo * logo + W.ps * ps + W.corners * (corners - 0.5) * 2 + W.tex * tex + W.flat * flat;
  const pCard = sig(z);
  // Сбер: знак по форме; фирменный зелёный — только вместе с чипом (зелёная книга — не карта Сбера)
  // зелёный цвет сам по себе — не Сбер (зелёные карты есть и у других банков): только усиливает найденный знак
  // известный дизайн каталога (отпечаток) — тоже Сбер, даже без знака на лицевой стороне
  const sber = Math.max(clamp01(logo * 1.1 + (logo > 0.3 ? 0.25 * green : 0)), dm.hit ? 0.9 : 0);
  return { card: pCard, sber, side: back > chip && back > 0.4 ? 'back' : 'front', f, ms: now() - t0 };
}

export function fmtFeatures(v: CardVerdict | null): string {
  if (!v) return 'ver —';
  const f = v.f, p = (x: number) => x.toFixed(2);
  return `chip ${p(f.chip)} sber ${p(f.logo)}/${p(f.green)} design ${f.designHit ? '#' + f.designId + ' ' : ''}${p(f.design)} ps ${p(f.ps)} corners ${p(f.corners)} back ${p(f.back)} tex ${p(f.tex)} flat ${p(f.flat)} → card ${p(v.card)} sber ${p(v.sber)} ${v.side}`;
}

/** буферы последнего выпрямленного изображения (R, G, B 0..1, CW × CH) — для отпечатка дизайна */
export function canonicalPlanes() {
  return { R, G, B };
}

/** последнее выпрямленное изображение карты как RGBA (только для отладки и тестов) */
export function canonicalRGBA(): Uint8ClampedArray {
  const out = new Uint8ClampedArray(N * 4);
  for (let k = 0; k < N; k++) {
    out[k * 4] = R[k] * 255;
    out[k * 4 + 1] = G[k] * 255;
    out[k * 4 + 2] = B[k] * 255;
    out[k * 4 + 3] = 255;
  }
  return out;
}

// ───────────── накопление уверенности по кадрам ─────────────

export type CardKind = 'unknown' | 'notcard' | 'card' | 'back' | 'sber';

/** пороги «попадания» в одном кадре (подбор — tests/card/verify.test.ts) */
export const HIT = { logo: 0.6, chip: 0.75, back: 0.6, miss: 0.3 };

/**
 * Решение по нескольким кадрам одного и того же кандидата (одной «дорожки» трекинга). Один кадр ничего не
 * решает: размытие, блик, палец. Считаем «попадания» признаков в окне последних кадров:
 *   sber    — знак Сбера найден хотя бы в 2 кадрах (и не реже чем в каждом 4-м);
 *   back    — магнитная полоса в 2+ кадрах (оборот: «переверни карту»);
 *   card    — чип в 4+ кадрах из 10+, а знака Сбера ни разу (карта другого банка — говорим не сразу,
 *             чтобы не обидеть владельца карты Сбера, у которого знак плохо виден);
 *   notcard — 6+ кадров без единого признака карты.
 * Неуверенные кадры (размытые, карта мельче 60 px) пропускаем — они не голосуют ни «за», ни «против».
 */
export class CardEvidence {
  readonly win: { logo: number; chip: number; back: number; design: number; id: number; t: number }[] = [];
  state: CardKind = 'unknown';
  last: CardVerdict | null = null;
  /**
   * Дизайн карты, на которой кот уже сидел (узнан по отпечатку при решении «Сбер»). Переживает reset(): вернули ту же
   * карту после «Где карта?» — хватает одного совпадения отпечатка с этим дизайном, а не двух.
   */
  known = -1;
  constructor(public size = 12) {}
  reset() {
    this.win.length = 0;
    this.state = 'unknown';
    this.last = null;
  }
  /** usable — кадр годится для голосования */
  static usable(v: CardVerdict) {
    return v.f.sharp >= 0.3 && v.f.px >= 60;
  }
  push(v: CardVerdict, t = 0): CardKind {
    this.last = v;
    // мелкая карта (40–60 px, 40–45 см, без фрагмента в большем разрешении): знак и чип там не разобрать, а отпечаток
    // дизайна (сетка 16 × 10) — ещё да: в окно идёт только совпадение отпечатка, «нет признаков» не голосует
    const small = !CardEvidence.usable(v) && v.f.sharp >= 0.3 && v.f.px >= 40 && v.side === 'front' && v.f.designHit;
    if (small) {
      this.win.push({ logo: 0, chip: 0, back: 0, design: 1, id: v.f.designId, t });
      if (this.win.length > this.size) this.win.shift();
      this.state = this.decide();
      return this.state;
    }
    if (!CardEvidence.usable(v)) return this.state;
    const front = v.side === 'front';
    this.win.push({ logo: front ? v.f.logo : 0, chip: v.f.chip, back: v.f.back, design: front && v.f.designHit ? 1 : 0, id: v.f.designHit ? v.f.designId : -1, t });
    if (this.win.length > this.size) this.win.shift();
    this.state = this.decide();
    return this.state;
  }
  counts() {
    let sber = 0, chip = 0, back = 0, none = 0, maxLogo = 0, design = 0, maxChip = 0, nLogo = 0, nChip = 0;
    for (const w of this.win) {
      // знак Сбера ИЛИ известный дизайн каталога
      if (w.logo >= HIT.logo || w.design >= 1) sber++;
      if (w.design >= 1) design++;
      if (w.chip >= HIT.chip) chip++;
      if (w.back >= HIT.back) back++;
      if (w.logo < HIT.miss && w.chip < HIT.miss && w.back < HIT.miss && w.design < 1) none++;
      if (w.logo > maxLogo) maxLogo = w.logo;
      if (w.chip > maxChip) maxChip = w.chip;
      if (w.logo >= 0.3) nLogo++;
      if (w.chip >= 0.35) nChip++;
    }
    return { n: this.win.length, sber, chip, back, none, maxLogo, design, maxChip, nLogo, nChip };
  }
  private decide(): CardKind {
    const c = this.counts();
    if (c.sber >= 2 && c.sber * 4 >= c.n) {
      for (let i = this.win.length - 1; i >= 0; i--) if (this.win[i].id >= 0) {
        this.known = this.win[i].id;
        break;
      }
      return 'sber';
    }
    // та же карта, что была под котом (тот же дизайн каталога), — достаточно одного совпадения
    if (this.known >= 0 && this.win.some((w) => w.id === this.known)) return 'sber';
    if (c.back >= 2 && c.back >= c.chip) return 'back';
    if (c.n >= 10 && c.chip >= 4 && c.sber === 0 && c.maxLogo < 0.45) return 'card';
    if (c.n >= 6 && c.chip === 0 && c.back === 0 && c.sber === 0 && c.none * 2 >= c.n) return 'notcard';
    // уже решённое не «отменяем» одним кадром: держим, пока окно не скажет иное
    if (this.state === 'sber' && c.sber >= 1) return 'sber';
    return this.state === 'notcard' && c.sber + c.chip + c.back === 0 ? 'notcard' : 'unknown';
  }
}

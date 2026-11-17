/**
 * Ключевой кадр карты и выравнивание по нему (против дрейфа и дрожания после посадки).
 *
 * При посадке запоминаем выпрямленную карту с полосой стола вокруг (шаблон в «нормированных» координатах
 * плоскости: длинная сторона карты — от −1 до 1). Дальше в каждом кадре ищем гомографию шаблон → кадр
 * обратно-композиционным Лукасом–Канаде (Baker & Matthews, «Lucas-Kanade 20 Years On») по пирамиде:
 *  - точки шаблона с сильным градиентом (края карты, рисунок, текстура стола рядом) — до ~1200 на уровень;
 *  - робастные веса (Хьюбер → Тьюки по MAD): рука, кот, блик — выбросы, не тянут позу;
 *  - яркость/контраст (автоэкспозиция) компенсируются линейно на каждой итерации;
 *  - начальное приближение — поза прошлого кадра × поворот по гироскопу (H = K·R·K⁻¹) или ведение потоком.
 * Шаблон не обновляется кадр за кадром (иначе дрейф накапливается, как у чистого кадр-к-кадру), а только
 * изредка — когда карта заметно приблизилась/отдалилась, и только по уже выровненной позе (без скачка).
 * Подход — Vacchetti/Lepetit (ключевые кадры против дрейфа) + «reference-free drift-corrected» LK.
 */
import { applyH, homography, invert3, isConvex, mul3, solveLinear, type Mat3, type Pt, type Quad, CARD_ASPECT } from './geometry';

/** полоса стола вокруг карты в шаблоне, в половинах ширины карты */
const MARGIN = 0.3;
const HB = 1 / CARD_ASPECT; // полувысота карты в нормированных координатах
/** нормированные углы карты (длинная сторона по x) */
export const KEY_CORNERS: Quad = [{ x: -1, y: -HB }, { x: 1, y: -HB }, { x: 1, y: HB }, { x: -1, y: HB }];

interface Level {
  /** нормированные координаты точек, значение шаблона, «крутые» производные SD (8 на точку) */
  u: Float32Array;
  v: Float32Array;
  T: Float32Array;
  SD: Float32Array;
  n: number;
}

export interface AlignResult {
  H: Mat3;
  quad: Quad;
  /** ZNCC по согласным точкам */
  zncc: number;
  /** доля согласных точек (из тех, что в кадре) */
  inl: number;
  /** доля точек шаблона в кадре */
  vis: number;
  iters: number;
}

export class KeyframeTracker {
  private levels: Level[] = [];
  /** поворот нумерации: углы детектора q[i] ↔ KEY_CORNERS[(i − rot) mod 4] */
  private rot = 0;
  /** px кадра на нормированную единицу при съёмке шаблона */
  scale = 0;
  ready = false;
  capturedAt = 0;

  reset() {
    this.ready = false;
    this.levels = [];
  }

  /** гомография нормированные → кадр по углам детектора (с нумерацией шаблона) */
  homographyFor(q: Pt[]): Mat3 | null {
    const src = [0, 1, 2, 3].map((i) => KEY_CORNERS[(i - this.rot + 4) % 4]);
    return homography(src, q);
  }

  /** углы в нумерации детектора по гомографии */
  quadOf(H: Mat3): Quad {
    return [0, 1, 2, 3].map((i) => applyH(H, KEY_CORNERS[(i - this.rot + 4) % 4])) as Quad;
  }

  /**
   * Снять шаблон с кадра (серый, уровень 0 пирамиды детектора) по углам карты q (нумерация детектора).
   * H — уже известная гомография (обновление шаблона без скачка), иначе — по углам.
   */
  capture(gray: Float32Array, w: number, h: number, q: Quad, t: number, H?: Mat3): boolean {
    if (!H) {
      // длинная сторона карты — q0→q1, иначе сдвигаем нумерацию
      const d = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
      this.rot = d(q[0], q[1]) + d(q[2], q[3]) >= d(q[1], q[2]) + d(q[3], q[0]) ? 0 : 1;
      const Hq = this.homographyFor(q);
      if (!Hq) return false;
      H = Hq;
    }
    const qq = this.quadOf(H);
    const wPx = (Math.hypot(qq[0].x - qq[1].x, qq[0].y - qq[1].y) + Math.hypot(qq[3].x - qq[2].x, qq[3].y - qq[2].y)) / 2;
    // px шаблона на нормированную единицу: как в кадре (не больше — нечего выдумывать), 20…56
    const s = Math.max(20, Math.min(56, wPx / 2));
    const tw = Math.round(2 * (1 + MARGIN) * s), th = Math.round(2 * (HB + MARGIN) * s);
    const T = new Float32Array(tw * th);
    for (let j = 0; j < th; j++)
      for (let i = 0; i < tw; i++) {
        const u = (i + 0.5) / s - (1 + MARGIN), v = (j + 0.5) / s - (HB + MARGIN);
        const p = applyH(H, { x: u, y: v });
        T[j * tw + i] = p.x < 0 || p.y < 0 || p.x > w - 1.001 || p.y > h - 1.001 ? NaN : bilinear(gray, w, p.x, p.y);
      }
    // уровни шаблона 2×2 (NaN за краем кадра заразен — так и надо)
    const levels: Level[] = [];
    let cur = T, cw = tw, chh = th;
    for (let l = 0; l < 3; l++) {
      if (l > 0) {
        const nw = cw >> 1, nh = chh >> 1, nx = new Float32Array(nw * nh);
        for (let j = 0; j < nh; j++)
          for (let i = 0; i < nw; i++) {
            const a = 2 * j * cw + 2 * i;
            nx[j * nw + i] = (cur[a] + cur[a + 1] + cur[a + cw] + cur[a + cw + 1]) * 0.25;
          }
        cur = nx;
        cw = nw;
        chh = nh;
      }
      levels.push(selectPoints(cur, cw, chh, s / (1 << l), [1300, 650, 300][l], 1 + MARGIN, HB + MARGIN));
    }
    if (levels[0].n < 60 || levels[1].n < 30 || levels[2].n < 12) return false;
    this.levels = levels;
    this.scale = s;
    this.ready = true;
    this.capturedAt = t;
    return true;
  }

  /**
   * Выровнять шаблон в кадре: pyr — пирамида серого (уровень 0 — кадр детектора), H0 — начальное приближение.
   * null — не сошлось / мало точек в кадре.
   */
  align(pyr: Float32Array[], dims: [number, number][], H0: Mat3): AlignResult | null {
    if (!this.ready) return null;
    let H = H0;
    let iters = 0;
    let last: { zncc: number; inl: number; vis: number } = { zncc: 0, inl: 0, vis: 0 };
    for (let l = Math.min(this.levels.length, pyr.length) - 1; l >= 0; l--) {
      const k = 1 / (1 << l), o = 0.5 * k - 0.5;
      const S: Mat3 = [k, 0, o, 0, k, o, 0, 0, 1];
      const Si: Mat3 = [1 / k, 0, -o / k, 0, 1 / k, -o / k, 0, 0, 1];
      let Hl = mul3(S, H);
      // грубый уровень: сначала только сдвиг (широкая зона сходимости), потом все 8 параметров
      if (l === this.levels.length - 1 && l > 0) {
        const t = this.alignLevel(this.levels[l], pyr[l], dims[l][0], dims[l][1], Hl, 8, true);
        if (t) Hl = t.H;
      }
      const r = this.alignLevel(this.levels[l], pyr[l], dims[l][0], dims[l][1], Hl, l === 0 ? 10 : 12);
      if (!r) return null;
      Hl = r.H;
      iters += r.iters;
      last = r;
      H = mul3(Si, Hl);
    }
    const quad = this.quadOf(H);
    if (!isConvex(quad) || quad.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
    return { H, quad, zncc: last.zncc, inl: last.inl, vis: last.vis, iters };
  }

  private alignLevel(L: Level, img: Float32Array, w: number, h: number, H: Mat3, maxIt: number, shiftOnly = false) {
    const n = L.n;
    const Iw = new Float32Array(n), ok = new Uint8Array(n), wt = new Float32Array(n), e = new Float32Array(n);
    const absE: number[] = [];
    let a = 1, b = 0;
    let iters = 0;
    let robust = 0;
    for (let it = 0; it < maxIt; it++) {
      iters++;
      // 1. выборка кадра под текущей гомографией
      let vis = 0;
      for (let i = 0; i < n; i++) {
        const u = L.u[i], v = L.v[i];
        const z = H[6] * u + H[7] * v + H[8];
        const x = (H[0] * u + H[1] * v + H[2]) / z, y = (H[3] * u + H[4] * v + H[5]) / z;
        if (!(x >= 1 && y >= 1 && x <= w - 2.001 && y <= h - 2.001)) {
          ok[i] = 0;
          continue;
        }
        ok[i] = 1;
        vis++;
        Iw[i] = bilinear(img, w, x, y);
      }
      if (vis < Math.max(10, n * 0.3)) return null;
      // 2. яркость/контраст: T ≈ a·I + b (взвешенный МНК)
      if (it > 0 || robust) {
        let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
        for (let i = 0; i < n; i++) {
          if (!ok[i]) continue;
          const q = it === 0 ? 1 : wt[i];
          sw += q;
          sx += q * Iw[i];
          sy += q * L.T[i];
          sxx += q * Iw[i] * Iw[i];
          sxy += q * Iw[i] * L.T[i];
        }
        const den = sw * sxx - sx * sx;
        if (sw > 10 && den > 1e-6) {
          a = Math.max(0.5, Math.min(2, (sw * sxy - sx * sy) / den));
          b = (sy - a * sx) / sw;
        }
      } else {
        let mi = 0, mt = 0, c = 0;
        for (let i = 0; i < n; i++) if (ok[i]) (mi += Iw[i]), (mt += L.T[i]), c++;
        b = (mt - mi) / c;
      }
      // 3. ошибки и робастные веса (MAD)
      absE.length = 0;
      for (let i = 0; i < n; i++) {
        if (!ok[i]) continue;
        e[i] = a * Iw[i] + b - L.T[i];
        absE.push(Math.abs(e[i]));
      }
      absE.sort((x, y) => x - y);
      const sigma = Math.max(2.5, 1.4826 * absE[absE.length >> 1]);
      const tukey = it >= 2;
      const c = tukey ? 4.685 * sigma : 1.345 * sigma;
      robust = 1;
      // 4. нормальные уравнения (8×8, симметричные)
      const A = new Float64Array(64), g = new Float64Array(8);
      for (let i = 0; i < n; i++) {
        if (!ok[i]) {
          wt[i] = 0;
          continue;
        }
        const r = Math.abs(e[i]);
        let q: number;
        if (tukey) q = r < c ? (1 - (r / c) ** 2) ** 2 : 0;
        else q = r <= c ? 1 : c / r;
        wt[i] = q;
        if (q === 0) continue;
        const sd = i * 8;
        for (let p = 0; p < 8; p++) {
          const sp = L.SD[sd + p] * q;
          g[p] += sp * e[i];
          for (let r2 = p; r2 < 8; r2++) A[p * 8 + r2] += sp * L.SD[sd + r2];
        }
      }
      const M: number[][] = [];
      for (let p = 0; p < 8; p++) {
        M.push([]);
        for (let r2 = 0; r2 < 8; r2++) M[p].push(r2 >= p ? A[p * 8 + r2] : A[r2 * 8 + p]);
        M[p][p] *= 1.0001;
      }
      let dp: number[] | null;
      if (shiftOnly) {
        const a2 = M[2][2], b2 = M[2][5], c2 = M[5][5], det = a2 * c2 - b2 * b2;
        dp = det > 1e-9 ? [0, 0, (c2 * g[2] - b2 * g[5]) / det, 0, 0, (a2 * g[5] - b2 * g[2]) / det, 0, 0] : null;
      } else dp = solveLinear(M, Array.from(g));
      if (!dp || dp.some((x) => !Number.isFinite(x))) return null;
      // 5. W ← W ∘ W(Δp)⁻¹
      const Wd: Mat3 = [1 + dp[0], dp[1], dp[2], dp[3], 1 + dp[4], dp[5], dp[6], dp[7], 1];
      const Wi = invert3(Wd);
      if (!Wi) return null;
      H = mul3(H, Wi);
      const nz = H[8];
      if (Math.abs(nz) > 1e-12) H = H.map((x) => x / nz);
      // сдвиг углов карты по нормированным координатам × масштаб кадра
      const sc = Math.hypot(H[0], H[3]);
      const move = (Math.abs(dp[2]) + Math.abs(dp[5]) + Math.abs(dp[0]) + Math.abs(dp[4]) + Math.abs(dp[1]) + Math.abs(dp[3])) * sc;
      if (it >= 3 && move < 0.03) break;
    }
    // качество: ZNCC по согласным точкам, доля согласных
    let vis = 0, inl = 0, sI = 0, sT = 0, sII = 0, sTT = 0, sIT = 0;
    for (let i = 0; i < n; i++) {
      if (!ok[i]) continue;
      vis++;
      if (wt[i] < 0.3) continue;
      inl++;
      sI += Iw[i];
      sT += L.T[i];
      sII += Iw[i] * Iw[i];
      sTT += L.T[i] * L.T[i];
      sIT += Iw[i] * L.T[i];
    }
    const vI = sII - (sI * sI) / Math.max(1, inl), vT = sTT - (sT * sT) / Math.max(1, inl);
    const zncc = inl > 10 && vI > 1e-6 && vT > 1e-6 ? (sIT - (sI * sT) / inl) / Math.sqrt(vI * vT) : 0;
    return { H, iters, zncc, inl: vis ? inl / vis : 0, vis: vis / n };
  }
}

function bilinear(img: Float32Array, w: number, x: number, y: number) {
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * w + x0;
  return (img[i] * (1 - fx) + img[i + 1] * fx) * (1 - fy) + (img[i + w] * (1 - fx) + img[i + w + 1] * fx) * fy;
}

/** точки шаблона с сильным градиентом, по одной лучшей на клетку 3×3 (равномерно по шаблону) */
function selectPoints(T: Float32Array, tw: number, th: number, s: number, max: number, ox: number, oy: number): Level {
  const cand: { i: number; j: number; g: number; gx: number; gy: number }[] = [];
  const C = 3;
  for (let cj = 1; cj < th - 1; cj += C)
    for (let ci = 1; ci < tw - 1; ci += C) {
      let best: (typeof cand)[number] | null = null;
      for (let j = cj; j < Math.min(th - 1, cj + C); j++)
        for (let i = ci; i < Math.min(tw - 1, ci + C); i++) {
          const k = j * tw + i;
          const gx = (T[k + 1] - T[k - 1]) * 0.5, gy = (T[k + tw] - T[k - tw]) * 0.5;
          const g = gx * gx + gy * gy;
          if (!Number.isFinite(g) || !Number.isFinite(T[k])) continue;
          if (!best || g > best.g) best = { i, j, g, gx, gy };
        }
      if (best && best.g > 16) cand.push(best);
    }
  cand.sort((a, b) => b.g - a.g);
  const n = Math.min(max, cand.length);
  const L: Level = { u: new Float32Array(n), v: new Float32Array(n), T: new Float32Array(n), SD: new Float32Array(n * 8), n };
  for (let k = 0; k < n; k++) {
    const c = cand[k];
    const u = (c.i + 0.5) / s - ox, v = (c.j + 0.5) / s - oy;
    // производные по нормированным координатам
    const Tu = c.gx * s, Tv = c.gy * s;
    L.u[k] = u;
    L.v[k] = v;
    L.T[k] = T[c.j * tw + c.i];
    const sd = k * 8;
    L.SD[sd] = Tu * u;
    L.SD[sd + 1] = Tu * v;
    L.SD[sd + 2] = Tu;
    L.SD[sd + 3] = Tv * u;
    L.SD[sd + 4] = Tv * v;
    L.SD[sd + 5] = Tv;
    L.SD[sd + 6] = -Tu * u * u - Tv * u * v;
    L.SD[sd + 7] = -Tu * u * v - Tv * v * v;
  }
  return L;
}

/** серая пирамида (как у детектора: [1 4 6 4 1]-размытие, яркость, уровни 2×2) — для тестов и стенда */
export function grayPyramid(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, levels = 3): { pyr: Float32Array[]; dims: [number, number][] } {
  const g = new Float32Array(w * h), t = new Float32Array(w * h);
  for (let i = 0, j = 0; i < w * h; i++, j += 4) g[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
  const K = [1, 4, 6, 4, 1];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -2; k <= 2; k++) s += K[k + 2] * g[y * w + Math.min(w - 1, Math.max(0, x + k))];
      t[y * w + x] = s / 16;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -2; k <= 2; k++) s += K[k + 2] * t[Math.min(h - 1, Math.max(0, y + k)) * w + x];
      g[y * w + x] = s / 16;
    }
  const pyr = [g], dims: [number, number][] = [[w, h]];
  for (let l = 1; l < levels; l++) {
    const [pw, ph] = dims[l - 1], lw = pw >> 1, lh = ph >> 1, src = pyr[l - 1], dst = new Float32Array(lw * lh);
    for (let y = 0; y < lh; y++)
      for (let x = 0; x < lw; x++) {
        const i = 2 * y * pw + 2 * x;
        dst[y * lw + x] = (src[i] + src[i + 1] + src[i + pw] + src[i + pw + 1]) * 0.25;
      }
    pyr.push(dst);
    dims.push([lw, lh]);
  }
  return { pyr, dims };
}

/**
 * Зона номера карты для записей (?rec в приложении, scripts/bench/blur-card-numbers.mjs): нижние 60 % карты по её
 * четырёхугольнику (TL TR BR BL — «верх» карты = дальний край, как labelCard). Номер, имя и срок на картах Сбера —
 * в нижней половине лицевой стороны; верх (знак, чип) остаётся для проверки «Сбер» и отпечатка дизайна.
 * Это второй слой защиты: первый — закрыть номер наклейкой/пальцем при съёмке (docs/qa/CARD_MATRIX.md).
 */
import { applyH, homography, type Pt, type Quad } from './geometry';

/** многоугольник зоны номера в координатах кадра; frac — доля высоты карты снизу, margin — запас за края карты */
export function numberZone(q: Quad, frac = 0.6, margin = 0.04, steps = 4): Pt[] | null {
  const H = homography([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], q);
  if (!H) return null;
  const u0 = -margin, u1 = 1 + margin, v0 = 1 - frac, v1 = 1 + margin;
  const pts: Pt[] = [];
  // по сторонам — несколько точек (перспектива: прямые остаются прямыми, но так проще и для обрезки по кадру)
  for (let i = 0; i <= steps; i++) pts.push(applyH(H, { x: u0 + ((u1 - u0) * i) / steps, y: v0 }));
  for (let i = 0; i <= steps; i++) pts.push(applyH(H, { x: u1, y: v0 + ((v1 - v0) * i) / steps }));
  for (let i = 0; i <= steps; i++) pts.push(applyH(H, { x: u1 - ((u1 - u0) * i) / steps, y: v1 }));
  for (let i = 0; i <= steps; i++) pts.push(applyH(H, { x: u0, y: v1 - ((v1 - v0) * i) / steps }));
  return pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)) ? pts : null;
}

/** точка внутри многоугольника (чёт-нечет) */
function inside(poly: Pt[], x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

/**
 * Пикселизация многоугольника в RGBA-кадре: клетка cell px (по умолчанию — 1/10 длинной стороны зоны, не меньше 6),
 * в клетке — средний цвет. Цифры номера (≈ 1/20 ширины карты) не читаются, крупные края карты остаются.
 */
export function pixelatePolygon(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, poly: Pt[], cell?: number) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of poly) (x0 = Math.min(x0, p.x)), (y0 = Math.min(y0, p.y)), (x1 = Math.max(x1, p.x)), (y1 = Math.max(y1, p.y));
  x0 = Math.max(0, Math.floor(x0));
  y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(w - 1, Math.ceil(x1));
  y1 = Math.min(h - 1, Math.ceil(y1));
  if (x1 <= x0 || y1 <= y0) return;
  const c = Math.max(6, Math.round(cell ?? Math.max(x1 - x0, y1 - y0) / 10));
  for (let by = y0; by <= y1; by += c)
    for (let bx = x0; bx <= x1; bx += c) {
      let r = 0, g = 0, b = 0, n = 0;
      const ex = Math.min(x1, bx + c - 1), ey = Math.min(y1, by + c - 1);
      for (let y = by; y <= ey; y++)
        for (let x = bx; x <= ex; x++) {
          if (!inside(poly, x + 0.5, y + 0.5)) continue;
          const i = (y * w + x) * 4;
          r += rgba[i];
          g += rgba[i + 1];
          b += rgba[i + 2];
          n++;
        }
      if (!n) continue;
      r /= n;
      g /= n;
      b /= n;
      for (let y = by; y <= ey; y++)
        for (let x = bx; x <= ex; x++) {
          if (!inside(poly, x + 0.5, y + 0.5)) continue;
          const i = (y * w + x) * 4;
          rgba[i] = r;
          rgba[i + 1] = g;
          rgba[i + 2] = b;
        }
    }
}

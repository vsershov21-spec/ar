/** Зоны касания спрайт-режима: прямоугольники в кадре позы (чистая логика, покрыта тестами). */
import type { TouchZone } from './types';

/** нормированные прямоугольники зон касания в кадре позы [x0, y0, x1, y1] (0..1 от левого верхнего угла) */
export type ZoneRects = Partial<Record<TouchZone, [number, number, number, number][]>>;
export const DEFAULT_ZONES: ZoneRects = {
  cheek: [[0.12, 0.2, 0.3, 0.38], [0.7, 0.2, 0.88, 0.38]],
  head: [[0.1, 0.0, 0.9, 0.42]],
  paw: [[0.0, 0.42, 0.2, 0.72], [0.8, 0.42, 1.0, 0.72], [0.2, 0.88, 0.8, 1.0]],
  tail: [[0.8, 0.72, 1.0, 0.95]],
  belly: [[0.32, 0.55, 0.68, 0.8]],
};
/** зона по координатам в кадре (u — слева направо, v — сверху вниз); порядок проверки: щека → голова → лапа → хвост → живот → тело */
export function zoneFromUv(u: number, v: number, rects: ZoneRects = DEFAULT_ZONES): TouchZone {
  for (const z of ['cheek', 'head', 'paw', 'tail', 'belly'] as TouchZone[])
    for (const [x0, y0, x1, y1] of rects[z] ?? []) if (u >= x0 && u <= x1 && v >= y0 && v <= y1) return z;
  return 'body';
}

/**
 * Раскраска карты (feature 'card.paint': pilot и lab — да, mvp — нет) — СЛЕДУЮЩИЙ ЭТАП пилота
 * (документ продакта «СберКот AR — конструкция MVP для пилота»). Сейчас — только флаг и пустая точка входа,
 * чтобы включение функции было одной строкой в FEATURES, а не правкой app.ts.
 *
 * TODO(card.paint): ребёнок раскрашивает свою карту пальцем (контур карты из tracker/card → холст поверх карты,
 * палитра кота, сохранение в память без картинки самой карты — данных карты не храним и не отправляем).
 */
export interface CardPaintHost {
  log(s: string): void;
}

/** точка входа (app.ts после старта режиссёра). false — раскраски пока нет */
export function startCardPaint(h: CardPaintHost): boolean {
  h.log('card.paint: раскраска карты — следующий этап (src/card/paint.ts), пока ничего не делает');
  return false;
}

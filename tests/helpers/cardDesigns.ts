/**
 * Процедурные «дизайны» банковских карт и поверхности предметов-негативов для синтетических тестов.
 * Ничего не копируем один-в-один: знак Сбера — кольцо с галочкой (форма), логотипы платёжных систем —
 * цветные кляксы/буквы-блоки похожего вида, номер — серые «цифры»-прямоугольники (ненастоящий).
 * Текстура 256 × 161 (ID-1), начало координат — левый верхний угол лицевой стороны.
 */
import { rng, type Tex } from './synthCard';

export const TW = 256;
export const TH = 161;
type RGB = [number, number, number];

class Canvas implements Tex {
  w: number;
  h: number;
  rgba: Uint8ClampedArray;
  constructor(w = TW, h = TH) {
    this.w = w;
    this.h = h;
    this.rgba = new Uint8ClampedArray(w * h * 4);
  }
  /** закрасить пиксели, где f(x, y) даёт покрытие 0..1 (сглаживание 2×2) */
  paint(f: (x: number, y: number) => number, col: RGB | ((x: number, y: number) => RGB), x0 = 0, y0 = 0, x1 = this.w, y1 = this.h) {
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(this.h, Math.ceil(y1)); y++)
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(this.w, Math.ceil(x1)); x++) {
        let a = 0;
        for (const [sx, sy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) a += f(x + sx, y + sy) ? 0.25 : 0;
        if (!a) continue;
        const c = typeof col === 'function' ? col(x + 0.5, y + 0.5) : col;
        const i = (y * this.w + x) * 4;
        for (let k = 0; k < 3; k++) this.rgba[i + k] = this.rgba[i + k] * (1 - a) + c[k] * a;
        this.rgba[i + 3] = 255;
      }
  }
  fill(col: RGB | ((x: number, y: number) => RGB)) {
    this.paint(() => 1, col);
  }
  rect(x: number, y: number, w: number, h: number, col: RGB | ((x: number, y: number) => RGB), r = 0) {
    this.paint((px, py) => {
      const dx = Math.max(x + r - px, 0, px - (x + w - r)), dy = Math.max(y + r - py, 0, py - (y + h - r));
      return px >= x && px <= x + w && py >= y && py <= y + h && dx * dx + dy * dy <= r * r ? 1 : 0;
    }, col, x - 1, y - 1, x + w + 1, y + h + 1);
  }
  circle(cx: number, cy: number, r: number, col: RGB | ((x: number, y: number) => RGB)) {
    this.paint((x, y) => ((x - cx) ** 2 + (y - cy) ** 2 <= r * r ? 1 : 0), col, cx - r - 1, cy - r - 1, cx + r + 1, cy + r + 1);
  }
  line(pts: [number, number][], wid: number, col: RGB) {
    const segD = (x: number, y: number) => {
      let m = Infinity;
      for (let i = 0; i + 1 < pts.length; i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
        const dx = bx - ax, dy = by - ay;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
        m = Math.min(m, Math.hypot(x - ax - dx * t, y - ay - dy * t));
      }
      return m;
    };
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    this.paint((x, y) => (segD(x, y) <= wid / 2 ? 1 : 0), col, Math.min(...xs) - wid, Math.min(...ys) - wid, Math.max(...xs) + wid, Math.max(...ys) + wid);
  }
}

/** знак Сбера по форме: кольцо, разомкнутое справа вверху, и галочка; col — цвет или градиент */
export function sberMark(c: Canvas, cx: number, cy: number, R: number, col: RGB | 'gradient') {
  const grad = (x: number, y: number): RGB => {
    // жёлто-зелёный → зелёный → голубой по углу
    const a = (Math.atan2(y - cy, x - cx) + Math.PI) / (2 * Math.PI);
    const k = a < 0.5 ? a * 2 : 2 - a * 2;
    return [Math.round(40 + 160 * (1 - k)), Math.round(170 + 50 * k), Math.round(60 + 170 * k * k)];
  };
  const colour = col === 'gradient' ? grad : col;
  const sw = 0.24 * R;
  c.paint((x, y) => {
    const d = Math.hypot(x - cx, y - cy);
    if (Math.abs(d - (R - sw / 2)) > sw / 2) return 0;
    const ang = (Math.atan2(y - cy, x - cx) * 180) / Math.PI; // y вниз: −90 — верх
    return ang > -70 && ang < -8 ? 0 : 1;
  }, colour, cx - R - 1, cy - R - 1, cx + R + 1, cy + R + 1);
  c.line([[cx - 0.44 * R, cy - 0.1 * R], [cx - 0.06 * R, cy + 0.2 * R], [cx + 0.72 * R, cy - 0.48 * R]], sw, col === 'gradient' ? [40, 170, 70] : col);
}

/** «словесный знак» — строка из букв-блоков (без настоящих букв) */
function wordmark(c: Canvas, x: number, y: number, h: number, n: number, col: RGB) {
  let px = x;
  for (let i = 0; i < n; i++) {
    const w = h * (0.55 + 0.1 * (i % 3));
    // буква как рамка с разрывом — похоже на текст по краям, но не читается
    c.rect(px, y, w, h * 0.18, col);
    c.rect(px, y, w * 0.2, h, col);
    if (i % 2) c.rect(px, y + h * 0.82, w, h * 0.18, col);
    else c.rect(px + w * 0.8, y, w * 0.2, h, col);
    px += w + h * 0.25;
  }
}

/** чип: золото/серебро, скругления, контактные площадки */
export function chip(c: Canvas, x = 0.13 * TW, y = 0.36 * TH, silver = false) {
  const w = 0.12 * TW, h = 0.16 * TH;
  const base: RGB = silver ? [196, 198, 200] : [214, 178, 96];
  c.rect(x, y, w, h, (px, py) => {
    const k = 0.85 + 0.25 * ((px - x) / w) - 0.1 * ((py - y) / h);
    return [base[0] * k, base[1] * k, base[2] * k] as RGB;
  }, 0.12 * w);
  const line: RGB = silver ? [120, 122, 126] : [120, 92, 40];
  c.rect(x + w * 0.33, y + 1, 1, h - 2, line);
  c.rect(x + w * 0.66, y + 1, 1, h - 2, line);
  c.rect(x + 1, y + h * 0.33, w * 0.33, 1, line);
  c.rect(x + 1, y + h * 0.66, w * 0.33, 1, line);
  c.rect(x + w * 0.66, y + h * 0.33, w * 0.33 - 1, 1, line);
  c.rect(x + w * 0.66, y + h * 0.66, w * 0.33 - 1, 1, line);
}

/** псевдономер и подписи (серые блоки-«цифры», ненастоящие) */
function number(c: Canvas, col: RGB) {
  for (let g = 0; g < 4; g++) for (let d = 0; d < 4; d++) c.rect(0.08 * TW + g * 0.205 * TW + d * 0.045 * TW, 0.6 * TH, 0.032 * TW, 0.07 * TH, col, 1);
  for (let d = 0; d < 9; d++) c.rect(0.08 * TW + d * 0.03 * TW, 0.82 * TH, 0.022 * TW, 0.045 * TH, col, 1);
}

/** логотипы платёжных систем (формы, не копии) */
function psLogo(c: Canvas, kind: 'mir' | 'visa' | 'mc' | 'up') {
  const x = 0.7 * TW, y = 0.76 * TH;
  if (kind === 'mir') {
    c.rect(x - 4, y - 4, 0.27 * TW, 0.17 * TH, [245, 245, 245], 4);
    wordmark(c, x + 3, y + 2, 0.1 * TH, 3, [30, 150, 60]);
  } else if (kind === 'visa') wordmark(c, x + 2, y + 4, 0.09 * TH, 4, [245, 245, 250]);
  else if (kind === 'mc') {
    c.circle(x + 18, y + 12, 11, [235, 30, 40]);
    c.circle(x + 32, y + 12, 11, [250, 160, 30]);
  } else {
    c.rect(x, y, 22, 18, [220, 30, 40], 2);
    c.rect(x + 16, y, 22, 18, [20, 60, 160], 2);
    c.rect(x + 32, y, 22, 18, [20, 130, 120], 2);
  }
}

function blobs(c: Canvas, R: () => number, n: number, palette: RGB[], rmin = 6, rmax = 30) {
  for (let i = 0; i < n; i++) c.circle(R() * TW, R() * TH, rmin + R() * (rmax - rmin), palette[i % palette.length]);
}

export type SberDesign = 'sber-green' | 'sber-photo' | 'sber-black' | 'sber-white' | 'sber-kids' | 'sber-red' | 'sber-vertical';
export type OtherDesign = 'other-blue' | 'other-yellow' | 'other-red' | 'other-green' | 'other-black';
export type BackDesign = 'back' | 'back-sber';
export type NotCard = 'paper' | 'book' | 'phone' | 'laptop' | 'box' | 'screen' | 'notebook';

export const SBER_DESIGNS: SberDesign[] = ['sber-green', 'sber-photo', 'sber-black', 'sber-white', 'sber-kids', 'sber-red', 'sber-vertical'];
export const OTHER_DESIGNS: OtherDesign[] = ['other-blue', 'other-yellow', 'other-red', 'other-green', 'other-black'];
export const NOT_CARDS: NotCard[] = ['paper', 'book', 'phone', 'laptop', 'box', 'screen', 'notebook'];

/** соотношение сторон и радиус предметов-негативов (в кадре детектор пропускает только «карточные» пропорции) */
export const NOT_CARD_SHAPE: Record<NotCard, { aspect: number; radius: number }> = {
  paper: { aspect: 1.414, radius: 0 },
  book: { aspect: 1.5, radius: 0.004 },
  phone: { aspect: 1.62, radius: 0.08 }, // телефон в чехле «на ребре» / планшет — пропорции близки к карте
  laptop: { aspect: 1.55, radius: 0.025 },
  box: { aspect: 1.6, radius: 0 },
  screen: { aspect: 1.6, radius: 0.01 },
  notebook: { aspect: 1.45, radius: 0.01 },
};

export function design(kind: SberDesign | OtherDesign | BackDesign | NotCard, seed = 1): Tex {
  const R = rng(seed * 977 + 13);
  const c = new Canvas();
  const ps = (['mir', 'mir', 'visa', 'mc', 'up'] as const)[Math.floor(R() * 5)];
  switch (kind) {
    case 'sber-green':
      c.fill((x, y) => [26 + (x / TW) * 20, 150 + (y / TH) * 30, 60 + (x / TW) * 30]);
      blobs(c, R, 4, [[40, 175, 80], [20, 130, 55]], 20, 50);
      sberMark(c, 0.09 * TW, 0.15 * TH, 0.045 * TW, [255, 255, 255]);
      wordmark(c, 0.16 * TW, 0.1 * TH, 0.1 * TH, 4, [255, 255, 255]);
      chip(c);
      number(c, [225, 240, 225]);
      psLogo(c, ps);
      break;
    case 'sber-photo': {
      // персональный дизайн: «фото» здания (тёплое), тёмно-синее небо, белый знак и слово
      c.fill((x, y) => (y < 0.33 * TH ? [30, 45, 95] : [170 + 40 * Math.sin(x * 0.3), 100 + 30 * Math.sin(x * 0.17 + y * 0.2), 50]));
      for (let i = 0; i < 18; i++) c.rect(R() * TW, 0.3 * TH + R() * 0.5 * TH, 4 + R() * 20, 4 + R() * 30, [200 + R() * 50, 140 + R() * 60, 60 + R() * 40]);
      for (let i = 0; i < 10; i++) c.rect(R() * TW, 0.33 * TH, 2, 0.4 * TH, [90, 50, 25]);
      sberMark(c, 0.085 * TW, 0.14 * TH, 0.04 * TW, [240, 240, 245]);
      wordmark(c, 0.15 * TW, 0.095 * TH, 0.09 * TH, 7, [240, 240, 245]);
      c.circle(0.88 * TW, 0.15 * TH, 10, [215, 220, 235]);
      chip(c);
      number(c, [235, 225, 215]);
      psLogo(c, 'mir');
      break;
    }
    case 'sber-black':
      c.fill([22, 22, 26]);
      for (let i = 0; i < 6; i++) c.line([[R() * TW, R() * TH], [R() * TW, R() * TH], [R() * TW, R() * TH]], 1.5, [70, 70, 80]);
      sberMark(c, 0.09 * TW, 0.15 * TH, 0.045 * TW, 'gradient');
      chip(c, undefined, undefined, R() < 0.5);
      number(c, [150, 150, 155]);
      psLogo(c, ps);
      break;
    case 'sber-white':
      c.fill([240, 241, 238]);
      blobs(c, R, 3, [[215, 235, 220], [225, 228, 240]], 20, 45);
      sberMark(c, 0.09 * TW, 0.15 * TH, 0.045 * TW, 'gradient');
      wordmark(c, 0.16 * TW, 0.1 * TH, 0.1 * TH, 4, [30, 150, 60]);
      chip(c, undefined, undefined, true);
      number(c, [120, 125, 130]);
      psLogo(c, ps);
      break;
    case 'sber-kids':
      c.fill((x, y) => [250, 200 + 40 * (y / TH), 60 + 80 * (x / TW)]);
      blobs(c, R, 14, [[255, 120, 160], [120, 200, 255], [255, 255, 255], [160, 120, 240], [90, 210, 120]], 6, 26);
      c.circle(0.62 * TW, 0.5 * TH, 0.28 * TH, [150, 150, 175]); // «персонаж»
      c.circle(0.56 * TW, 0.45 * TH, 6, [255, 255, 255]);
      c.circle(0.68 * TW, 0.45 * TH, 6, [255, 255, 255]);
      sberMark(c, 0.09 * TW, 0.15 * TH, 0.045 * TW, [255, 255, 255]);
      chip(c);
      psLogo(c, 'mir');
      break;
    case 'sber-red':
      c.fill((x) => [200 + 30 * (x / TW), 30, 45]);
      c.line([[0, TH], [TW * 0.6, 0]], 30, [230, 60, 70]);
      sberMark(c, 0.09 * TW, 0.15 * TH, 0.045 * TW, [255, 255, 255]);
      wordmark(c, 0.16 * TW, 0.1 * TH, 0.1 * TH, 7, [255, 255, 255]);
      chip(c);
      number(c, [250, 210, 210]);
      psLogo(c, ps);
      break;
    case 'sber-vertical': {
      // вертикальный дизайн: знак у «верха» дизайна = у правого короткого края, повёрнут на 90°
      c.fill((x, y) => [40 + 60 * (y / TH), 120 + 60 * (x / TW), 200]);
      blobs(c, R, 8, [[255, 255, 255], [90, 200, 255], [30, 90, 180]], 8, 25);
      const canvasRot = new Canvas(TH, TW);
      canvasRot.fill([0, 0, 0]);
      sberMark(canvasRot, 0.15 * TH, 0.085 * TW, 0.045 * TW, [255, 255, 255]);
      // переносим знак повёрнутым: (x', y') портрет → (TW − y', x') ландшафт
      for (let y = 0; y < TW; y++)
        for (let x = 0; x < TH; x++) {
          const i = (y * TH + x) * 4;
          if (canvasRot.rgba[i] < 30) continue;
          const lx = TW - 1 - y, ly = x;
          const j = (ly * TW + lx) * 4;
          const a = canvasRot.rgba[i] / 255;
          for (let k = 0; k < 3; k++) c.rgba[j + k] = c.rgba[j + k] * (1 - a) + 255 * a;
        }
      chip(c);
      break;
    }
    case 'other-blue':
      c.fill((x, y) => [10, 40 + 40 * (y / TH), 140 + 60 * (x / TW)]);
      wordmark(c, 0.07 * TW, 0.1 * TH, 0.11 * TH, 3, [255, 255, 255]);
      c.rect(0.07 * TW, 0.24 * TH, 0.2 * TW, 3, [80, 180, 255]);
      chip(c, undefined, undefined, true);
      number(c, [220, 230, 255]);
      psLogo(c, ps);
      break;
    case 'other-yellow':
      c.fill([250, 215, 40]);
      c.rect(0.06 * TW, 0.08 * TH, 0.12 * TW, 0.17 * TH, [30, 30, 30], 3); // щит-эмблема
      c.rect(0.085 * TW, 0.12 * TH, 0.07 * TW, 0.04 * TH, [250, 215, 40]);
      wordmark(c, 0.2 * TW, 0.1 * TH, 0.1 * TH, 6, [30, 30, 30]);
      chip(c);
      number(c, [60, 60, 60]);
      psLogo(c, ps);
      break;
    case 'other-red':
      c.fill([225, 35, 40]);
      c.line([[0.06 * TW, 0.3 * TH], [0.11 * TW, 0.07 * TH], [0.16 * TW, 0.3 * TH]], 5, [255, 255, 255]);
      c.rect(0.06 * TW, 0.32 * TH, 0.1 * TW, 4, [255, 255, 255]);
      chip(c);
      number(c, [255, 220, 220]);
      psLogo(c, ps);
      break;
    case 'other-green':
      // зелёный банк с круглым знаком без галочки — трудный негатив для «Сбера»
      c.fill((x) => [20 + 20 * (x / TW), 140, 70]);
      c.circle(0.09 * TW, 0.15 * TH, 0.045 * TW, [255, 255, 255]);
      c.circle(0.09 * TW, 0.15 * TH, 0.022 * TW, [20, 140, 70]);
      wordmark(c, 0.16 * TW, 0.1 * TH, 0.1 * TH, 5, [255, 255, 255]);
      chip(c);
      number(c, [225, 245, 225]);
      psLogo(c, ps);
      break;
    case 'other-black':
      c.fill([28, 28, 34]);
      c.rect(0.06 * TW, 0.08 * TH, 0.09 * TW, 0.09 * TW, [200, 170, 90], 4);
      wordmark(c, 0.18 * TW, 0.1 * TH, 0.09 * TH, 5, [200, 170, 90]);
      chip(c);
      number(c, [160, 160, 160]);
      psLogo(c, ps);
      break;
    case 'back':
    case 'back-sber':
      c.fill([235, 236, 238]);
      c.rect(0, 0.09 * TH, TW, 0.18 * TH, [25, 25, 28]);
      c.rect(0.06 * TW, 0.38 * TH, 0.6 * TW, 0.13 * TH, (x) => (Math.floor(x / 4) % 2 ? [250, 250, 245] : [225, 230, 240]));
      for (let i = 0; i < 4; i++) c.rect(0.06 * TW, 0.62 * TH + i * 0.07 * TH, 0.5 * TW, 0.03 * TH, [140, 140, 145]);
      if (kind === 'back-sber') sberMark(c, 0.88 * TW, 0.78 * TH, 0.04 * TW, 'gradient');
      break;
    case 'paper':
      c.fill([238, 237, 232]);
      if (R() < 0.6) for (let i = 0; i < 9; i++) c.rect(0.1 * TW, 0.12 * TH + i * 0.085 * TH, (0.5 + R() * 0.35) * TW, 2, [80, 80, 90]);
      break;
    case 'book': {
      const base: RGB = [R() * 200 + 30, R() * 200 + 30, R() * 200 + 30];
      c.fill(base);
      c.rect(0.1 * TW, 0.15 * TH, 0.8 * TW, 0.22 * TH, [255 - base[0], 255 - base[1], 255 - base[2]]);
      wordmark(c, 0.15 * TW, 0.2 * TH, 0.12 * TH, 6, base);
      c.circle(0.5 * TW, 0.68 * TH, 0.2 * TH, [base[1], base[2], base[0]]);
      wordmark(c, 0.3 * TW, 0.88 * TH, 0.06 * TH, 6, [250, 250, 250]);
      break;
    }
    case 'phone':
      c.fill([18, 18, 22]);
      c.rect(0.04 * TW, 0.06 * TH, 0.92 * TW, 0.88 * TH, (x, y) => [30 + 25 * (x / TW), 32 + 20 * (y / TH), 45], 6);
      c.rect(0.45 * TW, 0.08 * TH, 0.1 * TW, 0.05 * TH, [5, 5, 8], 4);
      break;
    case 'laptop':
      c.fill([120, 122, 128]);
      for (let r = 0; r < 5; r++) for (let k = 0; k < 13; k++) c.rect(0.06 * TW + k * 0.068 * TW, 0.15 * TH + r * 0.11 * TH, 0.058 * TW, 0.09 * TH, [35, 35, 38], 2);
      c.rect(0.33 * TW, 0.72 * TH, 0.34 * TW, 0.22 * TH, [105, 107, 112], 4);
      break;
    case 'box':
      c.fill((x, y) => [180 + 10 * Math.sin(x * 0.4), 140 + 8 * Math.sin(y * 0.3), 95]);
      c.rect(0, 0.45 * TH, TW, 0.12 * TH, [200, 175, 135]);
      wordmark(c, 0.1 * TW, 0.15 * TH, 0.1 * TH, 5, [60, 40, 30]);
      break;
    case 'screen': {
      // экран телефона/планшета с приложением: светлые карточки, цветные иконки
      c.fill([245, 246, 250]);
      c.rect(0.05 * TW, 0.05 * TH, 0.9 * TW, 0.2 * TH, [40, 160, 80], 6);
      for (let i = 0; i < 8; i++) c.rect(0.06 * TW + (i % 4) * 0.23 * TW, 0.35 * TH + Math.floor(i / 4) * 0.3 * TH, 0.18 * TW, 0.22 * TH, [R() * 255, R() * 255, R() * 255], 8);
      break;
    }
    case 'notebook':
      c.fill([40 + R() * 60, 70 + R() * 80, 120 + R() * 100]);
      c.rect(0.08 * TW, 0, 0.03 * TW, TH, [20, 20, 30]);
      c.rect(0.3 * TW, 0.3 * TH, 0.5 * TW, 0.25 * TH, [245, 245, 245], 3);
      for (let i = 0; i < 3; i++) c.rect(0.33 * TW, 0.34 * TH + i * 0.06 * TH, 0.4 * TW, 2, [90, 90, 90]);
      break;
  }
  // лёгкий шум печати
  const RN = rng(seed * 31 + 7);
  for (let i = 0; i < c.rgba.length; i += 4) {
    const n = (RN() - 0.5) * 8;
    for (let k = 0; k < 3; k++) c.rgba[i + k] = c.rgba[i + k] + n;
    c.rgba[i + 3] = 255;
  }
  return c;
}

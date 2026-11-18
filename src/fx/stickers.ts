/**
 * Отрисовка наклейки в канвас: пак СберКота — SVG-картинки (kind=image, белая вырубка уже в рисунке),
 * процедурные формы — для debug и старых пресетов. Текст не зеркалится: ребёнок читает наклейку с лица.
 */
import type { StickerSpec } from '../persona/types';
import { asset } from '../core/util';

const imgCache = new Map<string, HTMLImageElement>();
export function preloadStickerImage(src: string): HTMLImageElement {
  let i = imgCache.get(src);
  if (i) return i;
  i = new Image();
  i.decoding = 'async';
  i.src = asset(src);
  imgCache.set(src, i);
  return i;
}
/** картинка наклейки ещё грузится — промис загрузки (нарисовать заново), иначе null */
export function stickerImagePending(spec: StickerSpec): Promise<void> | null {
  if (spec.kind !== 'image' || !spec.src) return null;
  const img = preloadStickerImage(spec.src);
  if (img.complete) return null;
  return new Promise((r) => {
    img.addEventListener('load', () => r(), { once: true });
    img.addEventListener('error', () => r(), { once: true });
  });
}

function heartPath(g: CanvasRenderingContext2D, s: number) {
  g.beginPath();
  g.moveTo(0, s * 0.35);
  g.bezierCurveTo(-s * 0.95, -s * 0.25, -s * 0.45, -s * 0.95, 0, -s * 0.45);
  g.bezierCurveTo(s * 0.45, -s * 0.95, s * 0.95, -s * 0.25, 0, s * 0.35);
  g.closePath();
}
function starPath(g: CanvasRenderingContext2D, r: number, n = 5, inner = 0.45) {
  g.beginPath();
  for (let i = 0; i < n * 2; i++) {
    const a = (i * Math.PI) / n - Math.PI / 2;
    const rr = i % 2 ? r * inner : r;
    g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  g.closePath();
}
function boltPath(g: CanvasRenderingContext2D, s: number) {
  const p = [[0.15, -0.95], [-0.55, 0.12], [-0.05, 0.12], [-0.2, 0.95], [0.55, -0.2], [0.05, -0.2], [0.3, -0.95]];
  g.beginPath();
  p.forEach(([x, y], i) => (i ? g.lineTo(x * s, y * s) : g.moveTo(x * s, y * s)));
  g.closePath();
}

export interface StickerArt {
  face: HTMLCanvasElement;
  /** обратная сторона (серо-белый силуэт) — для загнутого уголка */
  back: HTMLCanvasElement;
  /** мягкая тень силуэта (поле SHADOW_PAD с каждой стороны) */
  shadow: HTMLCanvasElement;
}
/** поле тени вокруг наклейки, доля размера */
export const SHADOW_PAD = 0.18;

/** Рисует наклейку в канвас size×size; mirrored — вид «с обратной стороны стекла» (только процедурные без текста). */
export function renderSticker(spec: StickerSpec, size: number, palette: { primary: string; secondary: string; accent: string }, mirrored = false): StickerArt {
  const face = document.createElement('canvas');
  face.width = face.height = size;
  const g = face.getContext('2d')!;
  const s = size / 2;
  g.translate(s, s);
  // надписи не зеркалим никогда: «ХОП» с обратной стороны читался как «ПОХ»
  if (mirrored && spec.kind !== 'text' && spec.kind !== 'tag' && spec.kind !== 'image') g.scale(-1, 1);
  const border = Math.max(4, size * 0.05);
  const outline = (draw: () => void, fill: string | CanvasGradient) => {
    // белая вырубка вокруг формы (тень рисует StickerSheet)
    g.save();
    draw();
    g.lineJoin = 'round';
    g.lineWidth = border * 2;
    g.strokeStyle = '#fff';
    g.stroke();
    g.restore();
    draw();
    g.fillStyle = fill;
    g.fill();
  };
  const col = spec.color;
  switch (spec.kind) {
    case 'heart': {
      const grd = g.createLinearGradient(-s, -s, s, s);
      grd.addColorStop(0, col ?? '#FFB3E6');
      grd.addColorStop(1, col ? shade(col, -0.25) : palette.primary);
      outline(() => heartPath(g, s * 0.82), grd);
      break;
    }
    case 'star': {
      const grd = g.createRadialGradient(0, -s * 0.2, 2, 0, 0, s);
      grd.addColorStop(0, '#FFF6C8');
      grd.addColorStop(1, col ?? palette.accent);
      outline(() => starPath(g, s * 0.8), grd);
      break;
    }
    case 'holo': {
      const grd = g.createConicGradient(0, 0, 0);
      ['#FFB3E6', '#B9A3FF', '#8FF0D0', '#FFF3A0', '#FFB3E6'].forEach((c, i) => grd.addColorStop(i / 4, c));
      outline(() => {
        g.beginPath();
        g.arc(0, 0, s * 0.78, 0, Math.PI * 2);
      }, grd);
      g.fillStyle = 'rgba(255,255,255,0.85)';
      starPath(g, s * 0.35, 4, 0.3);
      g.fill();
      break;
    }
    case 'bolt':
      outline(() => boltPath(g, s * 0.85), col ?? palette.secondary);
      g.lineWidth = size * 0.03;
      g.strokeStyle = '#111';
      boltPath(g, s * 0.85);
      g.stroke();
      break;
    case 'tag': {
      outline(() => {
        g.beginPath();
        g.ellipse(0, 0, s * 0.9, s * 0.55, -0.15, 0, Math.PI * 2);
      }, '#141414');
      // подтёки краски
      g.fillStyle = col ?? palette.accent;
      for (let i = 0; i < 4; i++) {
        const x = -s * 0.5 + i * s * 0.33;
        g.beginPath();
        g.roundRect(x, s * 0.2, s * 0.07, s * (0.25 + 0.12 * (i % 2)), s * 0.035);
        g.fill();
      }
      g.rotate(-0.15);
      g.font = `900 ${s * 0.55}px "Arial Black", Impact, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineWidth = s * 0.12;
      g.strokeStyle = col ?? palette.accent;
      g.strokeText(spec.text ?? 'КОТ', 0, 0);
      g.fillStyle = palette.secondary;
      g.fillText(spec.text ?? 'КОТ', 0, 0);
      break;
    }
    case 'text': {
      const text = spec.text ?? 'ТУТ БЫЛ КОТ';
      const words = text.split(' ');
      outline(() => {
        g.beginPath();
        g.roundRect(-s * 0.9, -s * 0.55, s * 1.8, s * 1.1, s * 0.16);
      }, palette.primary === '#111111' ? '#111' : palette.primary);
      g.strokeStyle = palette.secondary;
      g.lineWidth = s * 0.05;
      g.beginPath();
      g.roundRect(-s * 0.8, -s * 0.45, s * 1.6, s * 0.9, s * 0.1);
      g.stroke();
      g.fillStyle = palette.primary === '#111111' ? palette.secondary : '#fff';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      const lines = words.length > 2 ? [words.slice(0, 2).join(' '), words.slice(2).join(' ')] : [text];
      const fs = Math.min(s * 0.42, (s * 1.5) / Math.max(...lines.map((l) => l.length)) * 1.7);
      g.font = `900 ${fs}px "Arial Black", Impact, sans-serif`;
      lines.forEach((l, i) => g.fillText(l, 0, (i - (lines.length - 1) / 2) * fs * 1.05));
      break;
    }
    case 'image': {
      const img = spec.src ? preloadStickerImage(spec.src) : null;
      if (img?.complete && img.naturalWidth) {
        // SVG пака: квадрат 240×240 с вырубкой — во весь размер, растр в нужном разрешении
        const k = Math.min(size / img.naturalWidth, size / img.naturalHeight);
        g.drawImage(img, (-img.naturalWidth * k) / 2, (-img.naturalHeight * k) / 2, img.naturalWidth * k, img.naturalHeight * k);
      } else {
        // ещё грузится — круглая зелёная заглушка (StickerSheet перерисует по load)
        outline(() => {
          g.beginPath();
          g.arc(0, 0, s * 0.7, 0, Math.PI * 2);
        }, '#21A038');
      }
      break;
    }
    default:
      outline(() => starPath(g, s * 0.8), palette.accent);
  }
  // «обратная сторона» — силуэт серо-белым (для загнутого уголка)
  const back = document.createElement('canvas');
  back.width = back.height = size;
  const b = back.getContext('2d')!;
  b.drawImage(face, 0, 0);
  b.globalCompositeOperation = 'source-in';
  const bg = b.createLinearGradient(0, 0, size, size);
  bg.addColorStop(0, '#f2f4f3');
  bg.addColorStop(1, '#b7c2bc');
  b.fillStyle = bg;
  b.fillRect(0, 0, size, size);
  // тень: силуэт тёмно-зелёным с размытием (сам рисунок уводим за край — остаётся только тень)
  const pad = Math.round(size * SHADOW_PAD);
  const shadow = document.createElement('canvas');
  shadow.width = shadow.height = size + pad * 2;
  const sg = shadow.getContext('2d')!;
  const off = size * 4;
  sg.shadowColor = 'rgba(6,40,22,0.55)';
  sg.shadowBlur = size * 0.06;
  sg.shadowOffsetX = off;
  sg.drawImage(face, pad - off, pad);
  return { face, back, shadow };
}

function shade(hex: string, k: number) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v + v * k)));
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

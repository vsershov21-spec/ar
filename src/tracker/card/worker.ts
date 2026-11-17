/// <reference lib="webworker" />
/**
 * Web Worker детектора карты: кадр RGBA (уменьшенный) → углы карты. Один детектор на всё время:
 * он помнит прошлый кадр и между полными поисками ведёт карту оптическим потоком.
 */
import { CardDetector } from './detector';

const det = new CardDetector();

export interface CardWorkerIn {
  rgba: ArrayBuffer;
  /** кадр камеры без копирования на главном потоке (WebCodecs VideoFrame): уменьшаем и читаем пиксели здесь */
  frame?: VideoFrame;
  w: number;
  h: number;
  focal: number;
  debug?: boolean;
  reset?: boolean;
  /** кот посажен: держаться этой карты */
  lock?: boolean;
  /** где карта должна быть (кадр детектора), пока её не видно */
  hint?: { x: number; y: number }[] | null;
  /** энергобюджет: полный поиск раз в N кадров (кот посажен, телефон неподвижен — реже) */
  detectEvery?: number;
}
export interface CardWorkerOut {
  quad: { x: number; y: number }[] | null;
  score: number;
  mode: string;
  ms: number;
  buf: ArrayBuffer;
}

self.onmessage = (e: MessageEvent<CardWorkerIn>) => {
  const m = e.data;
  if (m.reset) {
    det.reset();
    if (m.w <= 1) return; // только сброс (сменился размер кадра) — без ответа
  }
  if (m.lock !== undefined) det.locked = m.lock;
  if (m.hint !== undefined) det.hint = (m.hint as never) ?? null;
  if (m.detectEvery) det.params.detectEvery = m.detectEvery;
  let out: CardWorkerOut;
  if (m.frame) {
    const px = readFrame(m.frame, m.w, m.h);
    if (!px) {
      (self as unknown as Worker).postMessage({ quad: null, score: 0, mode: 'no-frame', ms: 0, buf: new ArrayBuffer(4) } satisfies CardWorkerOut);
      return;
    }
    m.rgba = px.buffer as ArrayBuffer;
  }
  try {
    const r = det.process(new Uint8ClampedArray(m.rgba), m.w, m.h, { focal: m.focal });
    out = { quad: r.quad, score: r.score, mode: r.mode, ms: r.ms, buf: m.rgba };
  } catch (err) {
    out = { quad: null, score: 0, mode: 'error:' + String(err), ms: 0, buf: m.rgba };
  }
  (self as unknown as Worker).postMessage(out, [m.rgba]);
};

/**
 * VideoFrame → RGBA w×h (OffscreenCanvas 2D, холст переиспользуется). Кадр закрываем всегда — иначе камера встанет.
 * null — не умеем (нет OffscreenCanvas) или кадр повёрнут относительно ожидаемого (другие пропорции).
 */
let oc: OffscreenCanvas | null = null;
let og: OffscreenCanvasRenderingContext2D | null = null;
function readFrame(f: VideoFrame, w: number, h: number): Uint8ClampedArray | null {
  try {
    if (Math.abs(f.displayWidth / f.displayHeight - w / h) > 0.03) return null;
    if (!oc) {
      if (typeof OffscreenCanvas === 'undefined') return null;
      oc = new OffscreenCanvas(w, h);
      og = oc.getContext('2d', { willReadFrequently: true });
    }
    if (!og) return null;
    if (oc.width !== w || oc.height !== h) {
      oc.width = w;
      oc.height = h;
    }
    og.drawImage(f, 0, 0, w, h);
    return og.getImageData(0, 0, w, h).data;
  } catch {
    return null;
  } finally {
    f.close();
  }
}

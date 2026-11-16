/// <reference lib="webworker" />
/**
 * Web Worker детектора карты: кадр RGBA (уменьшенный) → углы карты. Один детектор на всё время:
 * он помнит прошлый кадр и между полными поисками ведёт карту оптическим потоком.
 */
import { CardDetector } from './detector';

const det = new CardDetector();

export interface CardWorkerIn {
  rgba: ArrayBuffer;
  w: number;
  h: number;
  focal: number;
  debug?: boolean;
  reset?: boolean;
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
  if (m.reset) det.reset();
  let out: CardWorkerOut;
  try {
    const r = det.process(new Uint8ClampedArray(m.rgba), m.w, m.h, { focal: m.focal });
    out = { quad: r.quad, score: r.score, mode: r.mode, ms: r.ms, buf: m.rgba };
  } catch (err) {
    out = { quad: null, score: 0, mode: 'error:' + String(err), ms: 0, buf: m.rgba };
  }
  (self as unknown as Worker).postMessage(out, [m.rgba]);
};

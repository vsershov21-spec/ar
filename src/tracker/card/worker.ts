/// <reference lib="webworker" />
/**
 * Web Worker детектора карты: кадр RGBA (уменьшенный) → углы карты. Один детектор на всё время:
 * он помнит прошлый кадр и между полными поисками ведёт карту оптическим потоком.
 */
import { CardDetector } from './detector';
import { CardVerifier, type CropIn, type VerifyReport } from './verifier';

const det = new CardDetector();
/** «это карта Сбера?» по содержимому кандидата (verify.ts) */
const ver = new CardVerifier();
/** полный поиск раз в N кадров (энергобюджет) */
let detectEvery = det.params.detectEvery;

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
  /** проверять «это карта Сбера?» (false — ?anycard: любой прямоугольник) */
  verify?: boolean;
  /**
   * Фрагмент кадра вокруг ожидаемой карты в большем разрешении (для чипа и знака): rgba — уже прочитанные
   * пиксели (главный поток), или только прямоугольник — тогда воркер вырежет его из frame сам.
   * x0, y0, w, h — прямоугольник в px кадра детектора; cw × ch — размер фрагмента.
   */
  crop?: { x0: number; y0: number; w: number; h: number; cw: number; ch: number; rgba?: ArrayBuffer } | null;
}
export interface CardWorkerOut {
  quad: { x: number; y: number }[] | null;
  score: number;
  mode: string;
  ms: number;
  buf: ArrayBuffer;
  /** проверка по содержимому (нет — проверка выключена) */
  ver?: VerifyReport;
}

self.onmessage = (e: MessageEvent<CardWorkerIn>) => {
  const m = e.data;
  if (m.reset) {
    det.reset();
    ver.reset();
    if (m.w <= 1) return; // только сброс (сменился размер кадра) — без ответа
  }
  if (m.lock !== undefined) det.locked = m.lock;
  if (m.hint !== undefined) det.hint = (m.hint as never) ?? null;
  if (m.detectEvery) detectEvery = m.detectEvery;
  // пока кот не посажен и идёт проверка «это карта Сбера?» — полный поиск через кадр: проверяем только кадры
  // полного поиска (точные углы). По времени полный поиск ≈ ведению потоком (края считаются в каждом кадре)
  det.params.detectEvery = !det.locked && m.verify !== false ? Math.min(2, detectEvery) : detectEvery;
  let out: CardWorkerOut;
  let crop: CropIn | null = null;
  if (m.frame) {
    const px = readFrame(m.frame, m.w, m.h, m.crop ?? null);
    if (!px) {
      (self as unknown as Worker).postMessage({ quad: null, score: 0, mode: 'no-frame', ms: 0, buf: new ArrayBuffer(4) } satisfies CardWorkerOut);
      return;
    }
    m.rgba = px.buffer as ArrayBuffer;
    if (cropPx && m.crop) crop = { img: { rgba: cropPx, w: m.crop.cw, h: m.crop.ch }, x0: m.crop.x0, y0: m.crop.y0, w: m.crop.w, h: m.crop.h };
  } else if (m.crop?.rgba) crop = { img: { rgba: new Uint8ClampedArray(m.crop.rgba), w: m.crop.cw, h: m.crop.ch }, x0: m.crop.x0, y0: m.crop.y0, w: m.crop.w, h: m.crop.h };
  try {
    const lo = new Uint8ClampedArray(m.rgba);
    const r = det.process(lo, m.w, m.h, { focal: m.focal });
    out = { quad: r.quad, score: r.score, mode: r.mode, ms: r.ms, buf: m.rgba };
    if (m.verify !== false) {
      out.ver = ver.step(det, r, { rgba: lo, w: m.w, h: m.h }, { f: m.focal, cx: m.w / 2, cy: m.h / 2 }, performance.now(), crop);
      out.ms += out.ver.ms;
    }
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
let cc: OffscreenCanvas | null = null;
let cg: OffscreenCanvasRenderingContext2D | null = null;
/** фрагмент кадра в большем разрешении (если просили) — читается из того же VideoFrame до его закрытия */
let cropPx: Uint8ClampedArray | null = null;
function readFrame(f: VideoFrame, w: number, h: number, crop: CardWorkerIn['crop']): Uint8ClampedArray | null {
  cropPx = null;
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
    const data = og.getImageData(0, 0, w, h).data;
    if (crop && !crop.rgba) {
      try {
        const k = f.displayWidth / w;
        if (!cc) {
          cc = new OffscreenCanvas(crop.cw, crop.ch);
          cg = cc.getContext('2d', { willReadFrequently: true });
        }
        if (cg) {
          if (cc.width !== crop.cw || cc.height !== crop.ch) {
            cc.width = crop.cw;
            cc.height = crop.ch;
          }
          cg.drawImage(f, crop.x0 * k, crop.y0 * k, crop.w * k, crop.h * k, 0, 0, crop.cw, crop.ch);
          cropPx = cg.getImageData(0, 0, crop.cw, crop.ch).data;
        }
      } catch {
        cropPx = null;
      }
    }
    return data;
  } catch {
    return null;
  } finally {
    f.close();
  }
}

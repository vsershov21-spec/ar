/**
 * Модели: путь с учётом сжатия при сборке и ранняя загрузка.
 *
 * modelUrl: «models/kind_v1.glb» → «models/opt/kind_v1.<хэш>.glb» (meshopt + KTX2, scripts/build/vite-model-opt.mjs).
 * В dev и тестах карты нет — исходный путь. ?modelopt=0 — исходные модели (сравнить на телефоне).
 *
 * prefetchModel/fetchModel: App начинает качать модель выбранного характера и библиотеку движений сразу при старте,
 * параллельно с контентом и звуками; загрузчик персонажа забирает уже идущий запрос, а не начинает новый.
 */
import { asset } from './util';

declare const __MODEL_OPT__: Record<string, string> | undefined;

const MAP: Record<string, string> = typeof __MODEL_OPT__ !== 'undefined' ? __MODEL_OPT__ : {};
const OFF = typeof location !== 'undefined' && /[?&]modelopt=0\b/.test(location.search);

export function modelUrl(p: string): string {
  if (OFF) return p;
  return MAP[p.replace(/^\.?\//, '')] ?? p;
}

const pending = new Map<string, Promise<ArrayBuffer>>();

function get(url: string, priority: 'high' | 'low' | 'auto' = 'auto'): Promise<ArrayBuffer> {
  const init = { priority } as RequestInit;
  return fetch(asset(url), init).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${url}: ${r.status}`))));
}

/** начать загрузку заранее (путь — исходный, как в config.ts) */
export function prefetchModel(p: string, priority: 'high' | 'low' | 'auto' = 'auto') {
  const url = modelUrl(p);
  if (pending.has(url)) return;
  const pr = get(url, priority);
  pr.catch(() => pending.delete(url));
  pending.set(url, pr);
}

/** байты модели: из ранней загрузки, если она была, иначе — запрос сейчас (одноразово: буфер отдаётся парсеру) */
export function fetchModel(p: string): Promise<ArrayBuffer> {
  const url = modelUrl(p);
  const pr = pending.get(url);
  if (pr) {
    pending.delete(url);
    return pr;
  }
  return get(url);
}

/** прогреть HTTP-кэш (модели других характеров — смена образа без ожидания); буфер не держим */
export function warmModel(p: string) {
  void get(modelUrl(p), 'low').catch(() => undefined);
}

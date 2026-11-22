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
/** пакеты движений (src/character/animPacks.ts): исходная библиотека → пакет «остальное»; стартовый — в __MODEL_OPT__ */
declare const __ANIM_REST__: Record<string, string> | undefined;

const MAP: Record<string, string> = typeof __MODEL_OPT__ !== 'undefined' ? __MODEL_OPT__ : {};
const REST: Record<string, string> = typeof __ANIM_REST__ !== 'undefined' ? __ANIM_REST__ : {};
const OFF = typeof location !== 'undefined' && /[?&]modelopt=0\b/.test(location.search);

export function modelUrl(p: string): string {
  if (OFF) return p;
  return MAP[p.replace(/^\.?\//, '')] ?? p;
}

/**
 * Библиотека движений поделена при сборке: modelUrl(библиотеки) — стартовый пакет, это — пакет «остальное»
 * (null — пакетов нет: dev, тесты, ?modelopt=0 — библиотека целиком).
 */
export function animRestUrl(p: string): string | null {
  if (OFF) return null;
  return REST[p.replace(/^\.?\//, '')] ?? null;
}

const pending = new Map<string, Promise<ArrayBuffer>>();

function get(url: string, priority: 'high' | 'low' | 'auto' = 'auto'): Promise<ArrayBuffer> {
  // запрос, начатый ещё заставкой (index.html, до бандла — src/quick/splash.ts earlyModelScript): тот же, не второй
  const plain = () => fetch(asset(url), { priority } as RequestInit).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${url}: ${r.status}`))));
  const early = takeEarly(asset(url));
  return early ? early.catch(plain) : plain();
}

/** ранние запросы заставки: window.__arEarly[адрес] — промис байтов; забираем один раз */
function takeEarly(abs: string): Promise<ArrayBuffer> | null {
  const box = typeof window !== 'undefined' ? (window as unknown as { __arEarly?: Record<string, Promise<ArrayBuffer> | undefined> }).__arEarly : undefined;
  if (!box) return null;
  const key = new URL(abs, location.href).href;
  const p = box[key];
  if (!p) return null;
  delete box[key];
  return p;
}

/** байты по уже готовому адресу (сжатый пакет, клип) — с той же проверкой ранних запросов */
export function fetchUrl(url: string, priority: 'high' | 'low' | 'auto' = 'auto'): Promise<ArrayBuffer> {
  return get(url, priority);
}

/** начать загрузку заранее (путь — исходный, как в config.ts) */
export function prefetchModel(p: string, priority: 'high' | 'low' | 'auto' = 'auto') {
  const url = modelUrl(p);
  if (pending.has(url)) return;
  const pr = get(url, priority);
  pr.catch(() => pending.delete(url));
  pending.set(url, pr);
}

/** все начатые ранние загрузки (кот, стартовые движения) закончились — дальше можно качать звуки */
export function prefetchSettled(): Promise<void> {
  return Promise.allSettled([...pending.values()]).then(() => undefined);
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

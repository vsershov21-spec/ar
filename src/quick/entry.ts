/**
 * Быстрый вход (feature 'intro.quick', docs/EDITIONS.md): от ссылки до кота на карте — одно нажатие.
 * Экран — заставка в index.html (src/quick/splash.ts), она живёт до бандла. Здесь — связка с приложением:
 *   · ready(): приложение готово → нажатие, сделанное раньше (window.__quick.tapped), запускает app.wake();
 *   · busy/hide/denied — состояние кнопки, уход заставки (камера пошла), экран «Без камеры кот не увидит карту»;
 *   · онбординг UI (.start, intro.tour) не показывается: всё про кота и кнопки — в игре (знакомство + подсказки);
 *   · подписи к подсказкам «нажми сюда» и фразы поиска карты — то, что раньше было на экранах 2–4 тура.
 * Без заставки в странице (MVP, флаг выключен) quickEntry() → null — всё по-старому.
 */
import { feature } from '../config/edition';
import { quickBridge, type QuickBridge } from './early';

export interface QuickHost {
  wake(): void;
  log?(s: string): void;
}

export class QuickEntry {
  constructor(readonly q: QuickBridge) {}
  /** приложение готово: нажатия заставки → wake; нажали раньше — будим сразу */
  ready(host: QuickHost) {
    const q = this.q;
    q.ready = true;
    q.onTap = () => host.wake();
    q.onRetry = () => host.wake();
    // камеру до готовности не дали — ждём «Попробовать ещё раз» (экран отказа уже на месте), сами не дёргаем
    if (q.tapped && !this.earlyFailed) {
      host.log?.('быстрый вход: нажали до готовности — будим');
      host.wake();
    }
  }
  busy(on: boolean) {
    this.q.busy?.(on);
  }
  hide() {
    this.q.hide?.();
  }
  search() {
    this.q.search?.();
  }
  /**
   * Нажали до готовности приложения: трекер уже создан (это первое, что делает App.init) — камеру включаем сразу,
   * не дожидаясь модели кота (на медленной сети — десятки секунд). Ребёнок кладёт карту, пока кот догружается.
   */
  earlyFailed = false;
  preWake(start: () => void) {
    const q = this.q;
    if (q.ready) return;
    if (q.tapped) start();
    else q.onTap = () => start();
    q.onRetry = () => {
      this.earlyFailed = false;
      start();
    };
  }
  /** камеру не дали (или её нет): экран с подсказкой и «Попробовать ещё раз»; повторный отказ (счёт — в заставке) — ещё и «Обновить» */
  denied(e: unknown) {
    const err = e as { name?: string; message?: string } | null;
    this.q.denied?.({ name: err?.name ?? 'Error', message: String(err?.message ?? e) });
  }
}

let inst: QuickEntry | null | undefined;
/** быстрый вход включён и заставка в странице */
export function quickEntry(): QuickEntry | null {
  if (inst !== undefined) return inst;
  const q = feature('intro.quick') ? quickBridge() : null;
  return (inst = q ? new QuickEntry(q) : null);
}

/** экраны 2–4 прежнего тура → подписи к подсказкам «нажми сюда» (ui/hints.ts, экскурсия по кнопкам) */
export const QUICK_HINT_CAPTIONS: { sel: string; text: string }[] = [
  { sel: '.tom-col.l .tom-btn', text: 'Погладь, накорми, пощекочи' },
  { sel: '.tom-col.r .tom-btn', text: 'Трюки и образ кота' },
  { sel: '.tom-games', text: 'Игры, раскраска и дом кота' },
  { sel: '.mic', text: 'Скажи коту что-нибудь' },
  { sel: '.pawbtn', text: 'Всё, что умеет кот' },
  { sel: '.sug', text: 'Кот предлагает' },
];
export function hintCaption(b: Element): string | null {
  for (const c of QUICK_HINT_CAPTIONS) if (b.matches(c.sel)) return c.text;
  return null;
}

/**
 * Фразы поиска карты (плашка снизу, ui/cardSearch.ts SEARCH_LINES + экран «как держать телефон» прежнего тура):
 * кота не показываем — только глаза в плашке и лапки по краю карты.
 */
export const QUICK_SEARCH_LINES = [
  'Положи карту Сбера на стол — я выгляну',
  'Держи телефон над картой, как для фото',
  'Нюх-нюх… чую карту!',
  'Карту показывай только маме или папе',
];

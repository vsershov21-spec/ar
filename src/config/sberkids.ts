/**
 * Переход «Войти в СберKids» (карточка-чип, ui/kidsOffer.ts). Адреса — ЕДИНСТВЕННОЕ место, где они задаются.
 *
 * TODO(СберKids): реальные значения нужно получить у команды СберKids — см. docs/EDITIONS.md, строка `sberkids.offer`:
 *   1) SBERKIDS_DEEPLINK — схема/универсальная ссылка, которая открывает приложение СберKids на телефоне ребёнка
 *      (iOS Universal Link и Android App Link / intent), лучше сразу на экран «кот» или главный, с меткой источника;
 *   2) SBERKIDS_WEB_FALLBACK — страница, куда вести, если приложения нет (лендинг / стор с выбором платформы);
 *   3) какие utm/параметры источника они принимают (без персональных данных: только метка «ar_cat», место «home|play»).
 * Пока здесь плейсхолдеры: isPlaceholder() → диплинк не открывается, ведём на проверенную страницу из ASSETS.sberKidsUrl.
 */
import { ASSETS } from '../config';

export const SBERKIDS_DEEPLINK = 'TODO_SBERKIDS_DEEPLINK'; // TODO: например «<схема>://…» или https-универсальная ссылка — у команды СберKids
export const SBERKIDS_WEB_FALLBACK = 'TODO_SBERKIDS_WEB_FALLBACK'; // TODO: веб-страница СберKids для тех, у кого нет приложения

/** когда предлагать: после стольких действий ребёнка или стольких секунд игры (что раньше), не раньше MIN_PLAY_S */
export const KIDS_OFFER = {
  actions: 12,
  playSec: 240,
  minPlaySec: 90,
  /** дома — через столько секунд после входа (ребёнок осмотрелся) */
  homeDelaySec: 6,
  /** чип сам уходит через столько секунд */
  autoHideSec: 14,
  /** сколько раз за сессию максимум (дом + игра) */
  perSession: 2,
  /** ждём, что приложение откроется; страница всё ещё видна — ведём на веб-фолбэк */
  fallbackMs: 1400,
} as const;

export const isPlaceholder = (url: string) => !url || /^TODO/i.test(url);

/** куда вести: диплинк (если задан) и веб-страница (заданная или проверенная страница СберKids из config) */
export function kidsTargets(): { deeplink: string | null; web: string } {
  return {
    deeplink: isPlaceholder(SBERKIDS_DEEPLINK) ? null : SBERKIDS_DEEPLINK,
    web: isPlaceholder(SBERKIDS_WEB_FALLBACK) ? ASSETS.sberKidsUrl : SBERKIDS_WEB_FALLBACK,
  };
}

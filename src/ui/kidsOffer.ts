/**
 * Ненавязчивая карточка-чип «Войти в СберKids» (feature 'sberkids.offer'): маленькая, закрываемая, над нижними
 * кнопками, сама уходит через ~14 с. Когда:
 *   · 'home' — ребёнок пришёл к коту домой (через несколько секунд, когда осмотрелся);
 *   · 'play' — онбординг пройден и ребёнок поиграл: N действий или несколько минут игры (что раньше).
 * Не чаще KIDS_OFFER.perSession раз за сессию и каждое место — раз за сессию (localStorage, ui/hints.ts SessionMarks).
 * В счёт — показ, который ребёнок видел: закрыл, нажал, карточка ушла сама или пробыла ≥ KIDS_OFFER.seenMs. Убрал её
 * «занятый» кот сразу (кот позвал домой, уснул — диалог начался в ту же секунду) — место не тратится, карточка вернётся.
 * Клик: диплинк из config/sberkids.ts (если задан), иначе / если приложение не открылось — веб-страница.
 * Аналитика (без PII): sberkids_click { kind: deeplink_home|deeplink_play|web_home|web_play|close_home|close_play }.
 */
import { track } from '../analytics';
import { KIDS_OFFER, kidsTargets } from '../config/sberkids';
import { SessionMarks } from './hints';

export type KidsWhere = 'home' | 'play';

export interface KidsOfferHost {
  root: HTMLElement;
  playing(): boolean;
  home(): boolean;
  /** кот занят (диалог, пробуждение, раскраска, туман) — карточку не показываем */
  busy(): boolean;
  /** не открылось приложение и всплывающее окно заблокировано — показать лист со ссылкой (жест ребёнка) */
  showSheet(url: string): void;
  log?(s: string): void;
}

const LOGO = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#21a038"/><path d="M7 12.5l3.2 3.2L17.5 8.4" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export class KidsOffer {
  readonly el: HTMLDivElement;
  private marks: SessionMarks;
  private actions = 0;
  private playSince = 0;
  private homeSince = 0;
  private where: KidsWhere | null = null;
  private shownAt = 0;
  private hideTimer = 0;
  private timer = 0;

  constructor(private h: KidsOfferHost, store?: Pick<Storage, 'getItem' | 'setItem'> | null) {
    this.marks = new SessionMarks('sber-ar-cat:kids-offer', store === undefined ? undefined : store);
    const el = document.createElement('div');
    el.className = 'kids-card hidden';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'СберKids');
    el.innerHTML = `<button type="button" class="kc-go" data-k="go">${LOGO}<span>Войти в СберKids</span></button>
      <button type="button" class="kc-x" data-k="close" aria-label="Закрыть">×</button>`;
    h.root.appendChild(el);
    this.el = el;
    el.addEventListener('click', (e) => {
      const k = (e.target as HTMLElement).closest('[data-k]')?.getAttribute('data-k');
      if (k === 'go') this.go();
      if (k === 'close') {
        if (this.where) track('sberkids_click', { kind: `close_${this.where}` });
        this.hide();
      }
    });
    this.timer = window.setInterval(() => this.tick(), 1000);
  }

  /** действие ребёнка (кнопка, чип, касание кота) */
  noteAction() {
    this.actions++;
  }
  get visible() {
    return !this.el.classList.contains('hidden');
  }
  /** снимки и отладка: показать сразу */
  force(where: KidsWhere = 'play') {
    this.show(where);
  }

  private tick() {
    const h = this.h, now = performance.now();
    if (h.playing() && !this.playSince) this.playSince = now;
    const home = h.home();
    if (home && !this.homeSince) this.homeSince = now;
    if (!home) this.homeSince = 0;
    if (this.visible) {
      this.place();
      if (h.busy()) this.hide(performance.now() - this.shownAt >= KIDS_OFFER.seenMs);
      return;
    }
    if (!h.playing() || h.busy() || this.count() >= KIDS_OFFER.perSession) return;
    if (home && this.homeSince && now - this.homeSince > KIDS_OFFER.homeDelaySec * 1000 && !this.marks.has('home')) return this.show('home');
    const playS = this.playSince ? (now - this.playSince) / 1000 : 0;
    if (!home && !this.marks.has('play') && playS >= KIDS_OFFER.minPlaySec && (this.actions >= KIDS_OFFER.actions || playS >= KIDS_OFFER.playSec)) this.show('play');
  }
  private count() {
    return (this.marks.has('home') ? 1 : 0) + (this.marks.has('play') ? 1 : 0);
  }

  private show(where: KidsWhere) {
    this.where = where;
    this.shownAt = performance.now();
    this.el.dataset.where = where;
    this.el.classList.remove('hidden');
    this.place();
    this.h.log?.(`СберKids: карточка (${where})`);
    clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => this.hide(), KIDS_OFFER.autoHideSec * 1000);
  }
  /** seen = false — карточку убрали сразу (кот занят): показ не в счёт, место ещё свободно */
  hide(seen = true) {
    clearTimeout(this.hideTimer);
    if (this.visible && this.where && seen) this.marks.mark(this.where);
    this.el.classList.add('hidden');
  }

  /** над самым верхним из нижних рядов (чипы кота, ряд комнаты, док) — не на коте и не на кнопках */
  private place() {
    const root = this.h.root, rr = root.getBoundingClientRect();
    let top = rr.height - 120;
    for (const sel of ['.dock', '.chips.suggest', '.tom-room', '.home-hud .hh-row']) {
      const e = root.querySelector(sel) as HTMLElement | null;
      if (!e || e.classList.contains('hidden') || !e.offsetParent) continue;
      const r = e.getBoundingClientRect();
      if (r.height > 4 && r.top - rr.top < top) top = r.top - rr.top;
    }
    this.el.style.bottom = `${Math.round(rr.height - top + 10)}px`;
  }

  /** «Войти в СберKids»: диплинк (в жесте ребёнка) → не открылось за ~1,4 с → веб-страница */
  private go() {
    const where = this.where ?? 'play';
    this.hide();
    goKids(where, (url) => this.h.showSheet(url));
  }

  dispose() {
    clearInterval(this.timer);
    this.hide();
  }
}

/** новая вкладка в жесте ребёнка (с noopener window.open всегда отдаёт null — поэтому opener обнуляем сами) */
export function openTab(url: string): boolean {
  try {
    const w = window.open(url, '_blank');
    if (!w) return false;
    w.opener = null;
    return true;
  } catch {
    return false;
  }
}

/**
 * Переход в СберKids (карточка-чип и онборд СберKids, ui/serviceOnboard.ts) — в жесте ребёнка:
 * универсальная https-ссылка — новой вкладкой; схема приложения — location.href и через ~1,4 с, если страница всё ещё
 * видна, веб-страница листом; диплинка нет — веб-страница (config/sberkids.ts kidsTargets).
 * mark — метка точки к ссылке (онборд: utm_source=ar_cat, utm_content=onb, utm_campaign=<?src>, config/onboards.ts withMark).
 * Аналитика: sberkids_click { kind: deeplink_<where> | web_<where> }. Возвращает, куда ушли.
 */
export function goKids(where: string, showSheet: (url: string) => void, mark?: (url: string) => string): 'deeplink' | 'web' {
  const t = kidsTargets();
  const deeplink = t.deeplink && mark ? mark(t.deeplink) : t.deeplink;
  const web = mark ? mark(t.web) : t.web;
  if (deeplink && /^https:/i.test(deeplink)) {
    // универсальная ссылка: приложение есть — откроется оно, нет — её же веб-страница
    track('sberkids_click', { kind: `deeplink_${where}` });
    if (!openTab(deeplink)) showSheet(deeplink);
    return 'deeplink';
  }
  if (deeplink) {
    track('sberkids_click', { kind: `deeplink_${where}` });
    const t0 = performance.now();
    const fallback = window.setTimeout(() => {
      // страница всё ещё видна — приложение не открылось: веб-фолбэк (лист со ссылкой — новый жест, без блокировки окна)
      if (document.visibilityState === 'visible' && performance.now() - t0 < KIDS_OFFER.fallbackMs + 1500) showSheet(web);
    }, KIDS_OFFER.fallbackMs);
    document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && clearTimeout(fallback), { once: true });
    location.href = deeplink;
    return 'deeplink';
  }
  track('sberkids_click', { kind: `web_${where}` });
  if (!openTab(web)) showSheet(web);
  return 'web';
}

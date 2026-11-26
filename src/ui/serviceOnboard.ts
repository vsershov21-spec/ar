/**
 * Онборды в сервисы (feature 'onb.services', docs/scenario/ONBOARDS.md): ребёнок жмёт значок сервиса с «?» в левой
 * колонке меню («Сюрпризы», ui/tomLayout.ts) — кот проводит маленький онборд, панель снизу, кот сдвинут над ней.
 *
 *   Самокат:  «Ой! Это Самокат, у них столько вкусняшек!» → «Смотри, собираю нам перекус после школы!» — 6 продуктов
 *             летят от кота в корзину, счётчик растёт → лист «Перекус от <кота>» с кнопкой «Отправить маме на оплату»
 *             (диплинк Самоката — config/onboards.ts SAMOKAT_DEEPLINK; пока плейсхолдер — честная заглушка «покажи маме»).
 *   СберKids: «А это СберKids. Тут живут твои деньги и копилка!» → карточка «Копилка на мечту», в неё летят монетки,
 *             прогресс растёт → экскурс 3 шага (копилка, задания, карта) → «Войти в СберKids» (ui/kidsOffer.ts goKids,
 *             существующий переход config/sberkids.ts с меткой точки ?src).
 *
 * Реплики — пузырём без голоса (записей ElevenLabs пока нет, список — config/onboards.ts ONB_VOICE_LINES).
 * Аналитика: onb_step { svc, step, n?, kind?, at? } на каждый шаг; без имени ребёнка и текстов (152-ФЗ, docs/ANALYTICS.md).
 * Пока онборд идёт — сцена снаружи режиссёра (app.ts wireOrchestrator: кнопка другого действия закрывает онборд),
 * колонки меню спрятаны (uiContext busy 'onb'), чипы и карточка СберKids — тоже (класс onb-on на корне UI).
 */
import './onboard.css';
import { track } from '../analytics';
import { FROM_CAT, KIDS_TOUR, ONB_EVENTS, ONB_LINES, ONB_MS, PIGGY, SAMOKAT_DEEPLINK, SNACKS, isPlaceholderUrl, withMark, type SvcId } from '../config/onboards';
import type { PersonaId } from '../persona/types';
import { goKids, openTab } from './kidsOffer';

export interface OnbHost {
  root: HTMLElement;
  persona(): { id: PersonaId; name: string };
  /**
   * реплика кота: event — событие content (голос ElevenLabs, у каждого кота свой текст; нет записи — пузырь текстом кота),
   * text — запасной текст пузыря, ms — сколько его держать; cut — ребёнок нажал кнопку: прежняя реплика онборда
   * обрывается (иначе новая ждёт, пока та договорит)
   */
  say(text: string, ms?: number, event?: string, cut?: boolean): void;
  /** онборд закрыт не своей кнопкой — недоговорённые реплики онборда снять */
  hush?(): void;
  /** клип кота (point_button, celebrate…) */
  clip(name: string): void;
  sound(id: string): void;
  /** экранная точка кота, откуда вылетают продукты и монетки (лапы/грудь), px */
  catPoint(): { x: number; y: number } | null;
  /** ребёнок что-то сделал / онборд идёт — лестница тишины не копится */
  activity(): void;
  /** область над панелью (кот сдвигается туда, как над листом каталога); null — вернуть */
  shift(free: { top: number; bottom: number; left: number; right: number } | null): void;
  /** не открылось окно — лист со ссылкой СберKids (ui.showKids) */
  showSheet(url: string): void;
  /** метка точки из QR (?src, src/analytics readSrc) */
  src(): string | null;
  log?(s: string): void;
}

/** простые иконки перекуса (24×24): яблоко, банан, йогурт, сок, сырок, печенье */
export const SNACK_SVG: Record<string, string> = {
  apple: '<svg viewBox="0 0 24 24"><path d="M12 7.5c-1.6-1.2-5.5-1.4-6.5 2.4-.9 3.6 1.4 9.4 4.2 9.6 1 .1 1.5-.5 2.3-.5s1.3.6 2.3.5c2.8-.2 5.1-6 4.2-9.6-1-3.8-4.9-3.6-6.5-2.4z" fill="#ff4d4d"/><path d="M12 7.5c.1-1.8.8-3.2 2.2-4" stroke="#6b3b12" stroke-width="1.6" fill="none" stroke-linecap="round"/><path d="M13 5.6c1.6-1.4 3.4-1.2 4.2-.6-.9 1.4-2.6 1.9-4.2.6z" fill="#3fbf4a"/></svg>',
  banana: '<svg viewBox="0 0 24 24"><path d="M5 6.5c-.6 6.4 4.1 12 11.6 11.4 1.4-.1 2.7-.6 3.4-1.4-6.2.4-10.4-3.6-11.6-10.2z" fill="#ffd23a"/><path d="M4.4 6.8 5.8 5" stroke="#7a5a12" stroke-width="1.8" stroke-linecap="round"/><path d="M8.4 6.4c1.2 5.6 4.8 9 10.6 10" stroke="#e0a800" stroke-width="1.1" fill="none"/></svg>',
  yogurt: '<svg viewBox="0 0 24 24"><path d="M6.5 8h11l-1.3 11.2a1.6 1.6 0 0 1-1.6 1.3H9.4a1.6 1.6 0 0 1-1.6-1.3z" fill="#fff"/><path d="M6.5 8h11l-.5 4.2H7z" fill="#ff7fb3"/><rect x="5.5" y="5.5" width="13" height="3" rx="1.2" fill="#c9d6e3"/><circle cx="12" cy="15.8" r="1.8" fill="#ffb8d5"/></svg>',
  juice: '<svg viewBox="0 0 24 24"><path d="M7.5 8.5 10 5.5h4l2.5 3V20a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1z" fill="#ffa53a"/><path d="M7.5 11h9v6.5h-9z" fill="#fff4dc"/><circle cx="12" cy="14.2" r="2" fill="#ff7a1a"/><path d="M13.5 5.5 15 2.5" stroke="#4aa3ff" stroke-width="1.6" stroke-linecap="round"/></svg>',
  cheese: '<svg viewBox="0 0 24 24"><rect x="4" y="8.5" width="16" height="7" rx="3.5" fill="#6b3b2a"/><rect x="4" y="8.5" width="16" height="3.6" rx="1.8" fill="#8a4f38"/><path d="M8 15.5h8" stroke="#ffd9a8" stroke-width="1.4"/><circle cx="16.5" cy="10.5" r=".9" fill="#ffd9a8"/></svg>',
  cookie: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="#d9a05b"/><circle cx="9" cy="9.5" r="1.3" fill="#5a3315"/><circle cx="14.6" cy="10.4" r="1.1" fill="#5a3315"/><circle cx="11" cy="14.6" r="1.2" fill="#5a3315"/><circle cx="15.2" cy="15" r=".9" fill="#5a3315"/></svg>',
};
const CART_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h2.4l2.2 10.6a1.6 1.6 0 0 0 1.6 1.3h7.7a1.6 1.6 0 0 0 1.6-1.2L20.2 8H6.3"/><circle cx="9.5" cy="19.5" r="1.4" fill="currentColor"/><circle cx="17" cy="19.5" r="1.4" fill="currentColor"/></svg>';
const COIN_SVG = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="#ffc83a"/><circle cx="12" cy="12" r="6.6" fill="#ffd966" stroke="#e0a400" stroke-width="1.2"/><path d="M10 9h3a1.8 1.8 0 0 1 0 3.6h-3V9zm0 3.6v3M9 14.2h3.6" stroke="#b07a00" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>';
const TOUR_SVG: Record<string, string> = {
  piggy: '<svg viewBox="0 0 48 48"><ellipse cx="24" cy="27" rx="15" ry="11.5" fill="#ff9fc2"/><circle cx="35.5" cy="26" r="4.6" fill="#ffb6d0"/><circle cx="34.5" cy="25.6" r=".9" fill="#7a2e4a"/><circle cx="36.8" cy="25.6" r=".9" fill="#7a2e4a"/><circle cx="29" cy="21" r="1.4" fill="#4a1d2e"/><path d="M14 17.5l2.5-5 3.5 4.5" fill="#ff9fc2"/><rect x="20" y="15" width="8" height="2.2" rx="1.1" fill="#7a2e4a"/><path d="M15 37v3.5M31 37v3.5" stroke="#ff8ab3" stroke-width="3.2" stroke-linecap="round"/></svg>',
  tasks: '<svg viewBox="0 0 48 48"><rect x="10" y="7" width="28" height="34" rx="5" fill="#fff" stroke="#21a038" stroke-width="2.4"/><path d="M16 17l3 3 5-6M16 28l3 3 5-6" stroke="#21a038" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M27 18h6M27 29h6" stroke="#9bd5a8" stroke-width="2.6" stroke-linecap="round"/><path d="M33 4l1.6 3.4 3.6.4-2.7 2.5.8 3.6L33 12l-3.3 1.9.8-3.6-2.7-2.5 3.6-.4z" fill="#ffc83a"/></svg>',
  card: '<svg viewBox="0 0 48 48"><rect x="5" y="12" width="38" height="24" rx="4.5" fill="#21a038"/><rect x="5" y="12" width="38" height="24" rx="4.5" fill="url(#g)" opacity=".5"/><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#2bd36a"/><stop offset="1" stop-color="#0b5c63"/></linearGradient></defs><rect x="10" y="20" width="8" height="6" rx="1.5" fill="#f7e6a6"/><path d="M10 31h12" stroke="#fff" stroke-width="2" stroke-linecap="round" opacity=".8"/><circle cx="36" cy="18.5" r="2.8" fill="none" stroke="#fff" stroke-width="1.8"/></svg>',
};
const KIDS_LOGO = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#21a038"/><path d="M7 12.5l3.2 3.2L17.5 8.4" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const SAMOKAT_LOGO = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#ff335f"/><path d="M7 16.5h6.2l2.4-8h2" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="7.5" cy="16.5" r="1.6" fill="#fff"/><circle cx="16" cy="16.5" r="1.6" fill="#fff"/></svg>';

/** 1 вкусняшка, 2 вкусняшки, 5 вкусняшек */
export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

export type OnbStage = 'store' | 'sheet' | 'sent' | 'piggy' | 'tour' | 'go';

export class ServiceOnboard {
  readonly el: HTMLDivElement;
  private panel: HTMLDivElement;
  private fly: HTMLDivElement;
  private timers: number[] = [];
  private svcNow: SvcId | null = null;
  private stageNow: OnbStage | null = null;
  private count = 0;
  private tourAt = 0;
  private piggyPct = 0;
  private coins = 0;
  /** пока онборд открыт — лестница тишины кота не копится («Ты тут?» поверх онборда) */
  private keep = 0;
  /** шаги этого онборда (снимки, тесты): метки в порядке */
  readonly steps: string[] = [];

  constructor(private h: OnbHost) {
    const el = document.createElement('div');
    el.className = 'onb hidden';
    el.setAttribute('role', 'dialog');
    el.innerHTML = '<div class="onb-fly" aria-hidden="true"></div><div class="onb-panel"></div>';
    h.root.appendChild(el);
    this.el = el;
    this.fly = el.querySelector('.onb-fly') as HTMLDivElement;
    this.panel = el.querySelector('.onb-panel') as HTMLDivElement;
    this.panel.addEventListener('click', (e) => {
      const k = (e.target as HTMLElement).closest('[data-k]')?.getAttribute('data-k');
      if (k) this.press(k);
    });
  }

  get active(): SvcId | null {
    return this.svcNow;
  }
  get stage(): OnbStage | null {
    return this.stageNow;
  }
  /** продуктов в корзине (Самокат) */
  get cart(): number {
    return this.count;
  }
  /** наполнение копилки, % (СберKids) */
  get piggy(): number {
    return this.piggyPct;
  }

  /** ребёнок нажал значок сервиса (svc:samokat / svc:kids) */
  open(svc: SvcId) {
    if (this.svcNow) this.close('restart');
    this.svcNow = svc;
    this.steps.length = 0;
    this.count = 0;
    this.tourAt = 0;
    this.piggyPct = 0;
    this.el.className = `onb onb-${svc}`;
    this.el.setAttribute('aria-label', svc === 'samokat' ? 'Самокат' : 'СберKids');
    this.h.root.classList.add('onb-on');
    clearInterval(this.keep);
    this.keep = window.setInterval(() => this.h.activity(), 1500);
    this.step('open');
    if (svc === 'samokat') this.samokat();
    else this.kids();
  }

  /** закрыть (×, «Не сейчас», другое действие кота, смена кота); reason — для лога и шага close */
  close(reason = 'close') {
    const svc = this.svcNow;
    if (!svc) return;
    this.timers.forEach((t) => clearTimeout(t));
    this.timers = [];
    clearInterval(this.keep);
    if (reason !== 'done') this.step('close', { at: this.stageNow ?? 'open' });
    this.svcNow = null;
    this.stageNow = null;
    this.el.classList.add('hidden');
    this.fly.innerHTML = '';
    this.h.root.classList.remove('onb-on');
    this.h.shift(null);
    // «Не сейчас» / «Готово» / «Войти» — прощальная реплика договаривает; закрыли иначе (команда коту, ×) — тишина
    if (reason !== 'later' && reason !== 'done') this.h.hush?.();
    this.h.log?.(`онборд ${svc}: закрыт (${reason})`);
  }

  dispose() {
    this.close('dispose');
    this.el.remove();
  }

  // ───────────── Самокат ─────────────
  private samokat() {
    const L = ONB_LINES.samokat, E = ONB_EVENTS.samokat;
    this.setStage('store', `
      <div class="onb-head">${SAMOKAT_LOGO}<b>Самокат</b><button type="button" class="onb-x" data-k="close" aria-label="Закрыть">×</button></div>
      <div class="onb-cart"><span class="onb-cart-ico">${CART_SVG}<em class="onb-count">0</em></span>
        <span class="onb-slots">${SNACKS.map((s) => `<i data-s="${s.id}" aria-label="${s.label}"></i>`).join('')}</span></div>
      <p class="onb-cap">Кот собирает перекус…</p>`);
    this.say(L.hello, ONB_MS.hello + 400, E.hello);
    this.h.clip('surprised');
    this.step('hello');
    this.later(ONB_MS.hello, () => {
      this.say(L.collect, SNACKS.length * ONB_MS.snack + ONB_MS.fly + 900, E.collect);
      this.h.clip('point_button');
      this.step('collect');
      SNACKS.forEach((s, i) => this.later(i * ONB_MS.snack, () => this.throwSnack(s.id, i)));
    });
  }

  private throwSnack(id: string, i: number) {
    const to = this.panel.querySelector('.onb-cart-ico') as HTMLElement | null;
    this.flyTo(SNACK_SVG[id] ?? '', to, 'onb-snack', () => {
      this.count++;
      const c = this.panel.querySelector('.onb-count');
      if (c) c.textContent = String(this.count);
      to?.classList.remove('bump');
      void to?.offsetWidth;
      to?.classList.add('bump');
      const slot = this.panel.querySelector(`.onb-slots [data-s="${id}"]`);
      if (slot) slot.innerHTML = SNACK_SVG[id] ?? '';
      this.h.sound('pop_soft');
      this.step('item', { n: i + 1 });
      // всё в корзине — лист «Перекус от …» (по прилёту последнего, а не по часам: телефон мог притормозить)
      if (this.count === SNACKS.length) this.later(ONB_MS.toSheet, () => this.samokatSheet());
    });
  }

  private samokatSheet() {
    const L = ONB_LINES.samokat, E = ONB_EVENTS.samokat;
    const p = this.h.persona();
    this.setStage('sheet', `
      <div class="onb-head">${SAMOKAT_LOGO}<b>Перекус от ${FROM_CAT[p.id] ?? 'кота'}</b><button type="button" class="onb-x" data-k="close" aria-label="Закрыть">×</button></div>
      <ul class="onb-list">${SNACKS.map((s) => `<li>${SNACK_SVG[s.id] ?? ''}<span>${s.label}</span></li>`).join('')}</ul>
      <p class="onb-cap">${this.count} ${plural(this.count, 'вкусняшка', 'вкусняшки', 'вкусняшек')} после школы</p>
      <button type="button" class="onb-btn" data-k="send">Отправить маме на оплату</button>
      <button type="button" class="onb-btn ghost" data-k="later">Не сейчас</button>`);
    this.say(L.sheet, 5000, E.sheet);
    this.h.clip('celebrate');
    this.h.sound('chime_soft');
    this.step('sheet', { n: this.count });
  }

  private samokatSend() {
    const L = ONB_LINES.samokat, E = ONB_EVENTS.samokat;
    const url = isPlaceholderUrl(SAMOKAT_DEEPLINK) ? null : withMark(SAMOKAT_DEEPLINK, 'onb', this.h.src());
    let kind: 'deeplink' | 'stub' = 'stub';
    if (url) {
      kind = 'deeplink';
      if (/^https:/i.test(url)) {
        if (!openTab(url)) location.href = url;
      } else location.href = url;
    }
    this.step('send', { kind });
    // заглушка: диплинка Самоката ещё нет — честно просим показать экран маме (ничего не «отправилось»)
    this.setStage('sent', `
      <div class="onb-head">${SAMOKAT_LOGO}<b>Перекус от ${FROM_CAT[this.h.persona().id] ?? 'кота'}</b><button type="button" class="onb-x" data-k="close" aria-label="Закрыть">×</button></div>
      <ul class="onb-list sm">${SNACKS.map((s) => `<li>${SNACK_SVG[s.id] ?? ''}</li>`).join('')}</ul>
      <p class="onb-note">${kind === 'stub' ? 'Покажи этот экран маме или папе — они закажут перекус в Самокате.' : 'Отправили! Мама увидит перекус в Самокате.'}</p>
      <button type="button" class="onb-btn" data-k="done">Готово</button>`);
    this.say(kind === 'stub' ? L.stub : L.sent, 4200, kind === 'stub' ? E.stub : E.sent);
    this.h.clip('celebrate');
    this.h.sound('confetti');
  }

  // ───────────── СберKids ─────────────
  private kids() {
    const L = ONB_LINES.kids, E = ONB_EVENTS.kids;
    this.setStage('piggy', `
      <div class="onb-head">${KIDS_LOGO}<b>СберKids</b><button type="button" class="onb-x" data-k="close" aria-label="Закрыть">×</button></div>
      <div class="onb-piggy"><span class="onb-pig">${TOUR_SVG.piggy}</span>
        <span class="onb-goal"><b>Копилка на мечту</b><span class="onb-bar"><i style="width:${PIGGY.from}%"></i></span><em class="onb-pct">${PIGGY.from}%</em></span></div>
      <p class="onb-cap">Монетки летят в копилку…</p>`);
    this.piggyPct = PIGGY.from;
    this.say(L.hello, ONB_MS.hello + 400, E.hello);
    this.h.clip('point_button');
    this.step('hello');
    this.later(ONB_MS.hello * 0.6, () => {
      this.step('piggy');
      this.coins = 0;
      for (let i = 0; i < PIGGY.coins; i++) this.later(i * ONB_MS.coin, () => this.throwCoin(i));
      this.later(ONB_MS.hello * 0.4 + 200, () => this.say(L.piggy, 2600, E.piggy));
    });
  }

  private throwCoin(i: number) {
    const to = this.panel.querySelector('.onb-pig') as HTMLElement | null;
    this.flyTo(COIN_SVG, to, 'onb-coin', () => {
      this.piggyPct = Math.round(PIGGY.from + ((PIGGY.to - PIGGY.from) * (i + 1)) / PIGGY.coins);
      const bar = this.panel.querySelector('.onb-bar i') as HTMLElement | null;
      if (bar) bar.style.width = `${this.piggyPct}%`;
      const pct = this.panel.querySelector('.onb-pct');
      if (pct) pct.textContent = `${this.piggyPct}%`;
      to?.classList.remove('bump');
      void to?.offsetWidth;
      to?.classList.add('bump');
      this.h.sound('shimmer');
      this.step('coin', { n: i + 1 });
      // все монетки в копилке — экскурс
      if (++this.coins === PIGGY.coins) this.later(ONB_MS.toSheet, () => this.tour(0));
    });
  }

  /** экскурс: шаг k (0…2) — карточка «что можно в СберKids», «Дальше»; после последнего — «Войти в СберKids» */
  private tour(k: number) {
    this.clearTimers();
    if (k >= KIDS_TOUR.length) return this.kidsGo();
    this.tourAt = k;
    const t = KIDS_TOUR[k];
    this.setStage('tour', `
      <div class="onb-head">${KIDS_LOGO}<b>Что есть в СберKids</b><button type="button" class="onb-x" data-k="close" aria-label="Закрыть">×</button></div>
      <div class="onb-tour" data-t="${t.id}"><span class="onb-tico">${TOUR_SVG[t.icon] ?? ''}</span><span><b>${t.title}</b><small>${t.text}</small></span></div>
      <div class="onb-dots">${KIDS_TOUR.map((_, i) => `<i class="${i === k ? 'on' : ''}"></i>`).join('')}</div>
      <button type="button" class="onb-btn" data-k="next">${k === KIDS_TOUR.length - 1 ? 'Понятно!' : 'Дальше'}</button>`);
    this.say(ONB_LINES.kids.tour[k] ?? '', ONB_MS.tourAuto, ONB_EVENTS.kids.tour[k]);
    this.h.clip(k === 1 ? 'proud' : 'point_button');
    this.step('tour', { n: k + 1 });
    // ребёнок не нажал «Дальше» — листаем сами
    this.later(ONB_MS.tourAuto, () => this.tour(k + 1));
  }

  private kidsGo() {
    this.setStage('go', `
      <div class="onb-head">${KIDS_LOGO}<b>СберKids</b><button type="button" class="onb-x" data-k="close" aria-label="Закрыть">×</button></div>
      <div class="onb-piggy sm"><span class="onb-pig">${TOUR_SVG.piggy}</span><span class="onb-goal"><b>Копилка на мечту</b><span class="onb-bar"><i style="width:${this.piggyPct}%"></i></span><em class="onb-pct">${this.piggyPct}%</em></span></div>
      <button type="button" class="onb-btn kids" data-k="kids_go">${KIDS_LOGO}<span>Войти в СберKids</span></button>
      <button type="button" class="onb-btn ghost" data-k="later">Потом</button>`);
    this.say(ONB_LINES.kids.go, 6000, ONB_EVENTS.kids.go);
    this.h.clip('wave');
    this.h.sound('chime_soft');
    this.step('go_offer');
  }

  // ───────────── кнопки ─────────────
  /** идёт обработка нажатия ребёнка: реплика шага обрывает прежнюю (say → cut) */
  private pressing = false;
  private press(k: string) {
    this.pressing = true;
    try {
      this.pressNow(k);
    } finally {
      this.pressing = false;
    }
  }
  private pressNow(k: string) {
    this.h.activity();
    const svc = this.svcNow;
    if (!svc) return;
    if (k === 'close') return this.close('close');
    if (k === 'later') {
      this.say(svc === 'samokat' ? ONB_LINES.samokat.later : ONB_LINES.kids.later, 2600, svc === 'samokat' ? ONB_EVENTS.samokat.later : ONB_EVENTS.kids.later);
      return this.close('later');
    }
    if (k === 'send') return this.samokatSend();
    if (k === 'done') {
      this.step('done');
      return this.close('done');
    }
    if (k === 'next') return this.tour(this.tourAt + 1);
    if (k === 'kids_go') {
      // существующий переход в СберKids (config/sberkids.ts) с меткой точки ?src: sberkids_click kind deeplink_onb|web_onb
      const src = this.h.src();
      const kind = goKids('onb', (url) => this.h.showSheet(url), (url) => withMark(url, 'onb', src));
      this.step('go', { kind });
      this.later(400, () => this.close('done'));
    }
  }

  // ───────────── общее ─────────────
  private step(step: string, extra: { n?: number; kind?: string; at?: string } = {}) {
    const svc = this.svcNow;
    if (!svc) return;
    this.steps.push(step);
    track('onb_step', { svc, step, ...extra });
    this.h.activity();
    this.h.log?.(`онборд ${svc}: ${step}${extra.n ? ' ' + extra.n : ''}${extra.kind ? ' ' + extra.kind : ''}`);
  }

  private say(text: string, ms: number, event?: string) {
    if (text) this.h.say(text, ms, event, this.pressing);
  }

  private setStage(stage: OnbStage, html: string) {
    this.stageNow = stage;
    this.el.dataset.stage = stage;
    this.panel.innerHTML = html;
    // кот — над панелью (как над листом каталога), когда панель встала
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (f: () => void) => window.setTimeout(f, 16);
    raf(() => {
      if (!this.svcNow) return;
      const rr = this.h.root.getBoundingClientRect(), pr = this.panel.getBoundingClientRect();
      if (pr.height > 0) this.h.shift({ top: 0, bottom: pr.top - rr.top, left: 0, right: rr.width });
    });
  }

  private later(ms: number, f: () => void) {
    const t = window.setTimeout(() => {
      this.timers = this.timers.filter((x) => x !== t);
      if (this.svcNow) f();
    }, ms);
    this.timers.push(t);
  }
  private clearTimers() {
    this.timers.forEach((t) => clearTimeout(t));
    this.timers = [];
  }

  /** предмет вылетает от кота и дугой падает в цель (корзина, копилка); done — когда долетел */
  private flyTo(svg: string, to: HTMLElement | null, cls: string, done: () => void) {
    const rr = this.h.root.getBoundingClientRect();
    const from = this.h.catPoint() ?? { x: rr.width / 2, y: rr.height * 0.35 };
    const tr = to?.getBoundingClientRect();
    const end = tr && tr.width ? { x: tr.left - rr.left + tr.width / 2, y: tr.top - rr.top + tr.height / 2 } : { x: rr.width / 2, y: rr.height - 120 };
    const it = document.createElement('i');
    it.className = `onb-item ${cls}`;
    it.innerHTML = svg;
    it.style.left = `${Math.round(from.x)}px`;
    it.style.top = `${Math.round(from.y)}px`;
    this.fly.appendChild(it);
    const dx = end.x - from.x, dy = end.y - from.y;
    // дуга: вверх и в сторону, потом вниз в цель; чуть вращается
    const side = Math.random() < 0.5 ? -1 : 1;
    const peak = Math.min(-60, dy * -0.25 - 70);
    // «долетел» — по таймеру онборда (шаги и счётчик не зависят от того, как браузер крутит анимации);
    // анимация — только вид, сама убирает предмет
    this.later(ONB_MS.fly, () => {
      it.remove();
      done();
    });
    if (typeof it.animate === 'function') {
      const a = it.animate(
        [
          { transform: 'translate(-50%,-50%) translate(0px,0px) scale(.3) rotate(0deg)', opacity: 0 },
          { transform: `translate(-50%,-50%) translate(${dx * 0.3 + side * 40}px,${peak}px) scale(1.15) rotate(${side * 25}deg)`, opacity: 1, offset: 0.4 },
          { transform: `translate(-50%,-50%) translate(${dx}px,${dy}px) scale(.55) rotate(${side * 60}deg)`, opacity: 1 },
        ],
        { duration: ONB_MS.fly, easing: 'cubic-bezier(.3,.7,.4,1)', fill: 'forwards' },
      );
      a.onfinish = () => it.remove();
    }
  }
}

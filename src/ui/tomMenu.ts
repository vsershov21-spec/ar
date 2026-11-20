/**
 * Меню «как у Говорящего Тома» на экране (feature 'ui.tomLayout', docs/ui/TOM_LAYOUT.md). Раскладка и правила —
 * ui/tomLayout.ts (чистая логика), здесь — только DOM:
 *   · колонки круглых кнопок у левого («Ласка») и правого («Трюки/Образ») края, кот — в центре; колонка, которой
 *     некуда встать мимо кота (catRect), уходит в язычок у края;
 *   · сверху — прогресс «открыто N из M»; снизу — док: звук · «Мой дом»/«На карту» · микрофон · «Игры» · «Ещё»;
 *     дома над доком — ряд действий комнаты, по краям ряда — стрелки комнат (кнопки HomeMode, переставлены CSS);
 *   · чипы кота (1–2) — рядом над доком, между колонками; колонки им не мешают;
 *   · колонки прячутся к краю через 6 с без касаний и на время сцен (пробуждение, раскраска, сон, переход домой);
 *     касание у края или по язычку — возвращает;
 *   · красная точка «новое», неактивные кнопки с подсказкой («Сначала покажи мне карту»), долгое нажатие — подсказка,
 *     касание — короткий «прыг».
 * Выбор пункта — тот же путь, что у листа каталога: UiHandlers.onCatalogPick (app.ts runCatalogItem).
 */
import type { CatalogItem } from './actionCatalog';
import type { CatalogGroup } from './catalogGroups';
import type { Chip } from '../scenario/suggest';
import {
  TOM_IDLE_MS, TomAutoHide, disabledReason, shortLabel, tomLayout, tomModel, type ColMode, type ColumnPlan, type Rect, type TomBusy, type TomCtx, type TomModel, type TomPlan,
} from './tomLayout';

/** что меню берёт у приложения (через UiHandlers.uiContext) */
export interface TomUiCtx extends TomCtx {
  busy: TomBusy;
}

export interface TomHost {
  root: HTMLElement;
  dock: HTMLElement;
  micSlot: HTMLElement;
  groups(): CatalogGroup[];
  ctx(): TomUiCtx;
  catRect(): { top: number; bottom: number; cx: number; half: number } | null;
  tried: { has(id: string): boolean; mark(id: string): boolean };
  recent: { push(id: string): void };
  icon(id: string): string;
  pick(it: CatalogItem): void;
  /** подсказка над микрофоном (неактивная кнопка, «сначала познакомимся») */
  hint(text: string): void;
  /** игра началась (до этого кнопки меню приглушены) */
  playing(): boolean;
  /** сценарий прячет чипы (знакомство, листы) — колонки тоже прячем */
  scenarioQuiet(): boolean;
}

/** подсказки долгого нажатия: что сделает кот (коротко, от лица кота) */
const TIP: Record<string, string> = {
  pet: 'Погладь меня — я замурчу',
  scratch: 'Почеши за ушком',
  tickle: 'Пощекочи — я хихикаю!',
  hug: 'Обними меня крепко',
  paw: 'Дам тебе лапу',
  treat: 'Угости меня рыбкой',
  dance: 'Станцую для тебя',
  flip: 'Сделаю сальто',
  other: 'Позову другого кота',
  'ui:paint': 'Раскрашу твою карту',
  'ui:paint_erase': 'Сотру рисунок с карты',
  riddle: 'Загадаю загадку',
  echo: 'Буду повторять за тобой',
};

/** короткая причина под подписью неактивной кнопки (полная — по нажатию, над микрофоном) */
export function whyShort(why: string): string {
  if (/карт/i.test(why)) return 'нужна карта';
  if (/сплю/i.test(why)) return /не сплю/i.test(why) ? 'не спит' : 'спит';
  return 'позже';
}

export class TomMenu {
  readonly el: HTMLDivElement;
  private colL: HTMLDivElement;
  private colR: HTMLDivElement;
  private tabL: HTMLButtonElement;
  private tabR: HTMLButtonElement;
  private room: HTMLDivElement;
  private top: HTMLDivElement;
  private pop: HTMLDivElement;
  private tip: HTMLDivElement;
  private safeProbe: HTMLElement;
  private homeBtn: HTMLButtonElement;
  readonly gamesBtn: HTMLButtonElement;
  private gearBtn: HTMLButtonElement;
  private auto = new TomAutoHide();
  private plan: TomPlan | null = null;
  private model: TomModel | null = null;
  private ctxNow: TomUiCtx = { home: null, busy: null };
  private key = '';
  private hiddenNow = false;
  private popFor = '';
  private popTimer = 0;
  private tipTimer = 0;
  private timer = 0;
  private on = false;

  constructor(private h: TomHost) {
    const el = document.createElement('div');
    el.className = 'tom';
    el.innerHTML = `
      <div class="tom-top"><button type="button" class="tom-prog" data-t="prog" aria-label="Открыто"><span class="tp-ico">${h.icon('trophy')}</span><span class="tp-n">0/0</span></button></div>
      <div class="tom-col l" role="toolbar" aria-label="Ласка"></div>
      <div class="tom-col r" role="toolbar" aria-label="Трюки и образ"></div>
      <button type="button" class="tom-tab l" data-t="tab" aria-label="Показать кнопки">${h.icon('chev_r')}</button>
      <button type="button" class="tom-tab r" data-t="tab" aria-label="Показать кнопки">${h.icon('chev_l')}</button>
      <div class="tom-room" role="toolbar" aria-label="Комната"></div>
      <div class="tom-pop hidden" role="dialog"></div>
      <div class="tom-tip hidden" role="tooltip"></div>
      <i class="tom-safe" aria-hidden="true"></i>`;
    h.root.appendChild(el);
    this.el = el;
    const q = <T extends HTMLElement>(s: string) => el.querySelector(s) as T;
    this.colL = q('.tom-col.l');
    this.colR = q('.tom-col.r');
    this.tabL = q('.tom-tab.l');
    this.tabR = q('.tom-tab.r');
    this.room = q('.tom-room');
    this.top = q('.tom-top');
    this.pop = q('.tom-pop');
    this.tip = q('.tom-tip');
    this.safeProbe = q('.tom-safe');
    // док: звук · «Мой дом» · микрофон · «Игры» · «Ещё»
    const mk = (cls: string, icon: string, label: string) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `tom-dbtn ${cls}`;
      b.innerHTML = `<span class="tb-ico">${h.icon(icon)}</span><span class="tb-l"></span>`;
      (b.querySelector('.tb-l') as HTMLElement).textContent = label;
      return b;
    };
    this.homeBtn = mk('tom-home', 'home_house', 'Мой дом');
    this.gamesBtn = mk('tom-games', 'games', 'Игры');
    this.gamesBtn.setAttribute('aria-haspopup', 'dialog');
    this.gearBtn = document.createElement('button');
    this.gearBtn.type = 'button';
    this.gearBtn.className = 'iconbtn tom-gear';
    this.gearBtn.setAttribute('aria-label', 'Ещё');
    this.gearBtn.innerHTML = h.icon('gear');
    h.dock.insertBefore(this.homeBtn, h.micSlot);
    h.micSlot.after(this.gamesBtn);
    this.gamesBtn.after(this.gearBtn);
    this.wire();
  }

  // ───────────── вкл/выкл ─────────────
  /** меню включено (feature + не десктоп-панель) */
  setOn(v: boolean) {
    if (v === this.on) return;
    this.on = v;
    this.h.root.classList.toggle('tom-on', v);
    this.el.classList.toggle('hidden', !v);
    clearInterval(this.timer);
    if (v) {
      this.auto.reveal(performance.now());
      this.timer = window.setInterval(() => this.tick(), 250);
      this.tick(true);
    } else this.closePop();
  }
  get active() {
    return this.on;
  }
  get popOpen() {
    return !!this.popFor;
  }
  /** колонки сейчас спрятаны (снимки, тесты) */
  get hidden() {
    return this.hiddenNow;
  }
  get layout() {
    return this.plan;
  }
  get items() {
    return this.model;
  }

  // ───────────── события ─────────────
  private wire() {
    const h = this.h;
    this.el.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('[data-t]') as HTMLElement | null;
      if (!t) return;
      const a = t.dataset.t;
      if (a === 'tab') this.reveal(t.classList.contains('l') ? 'l' : 'r');
      if (a === 'prog') this.showTip(t, this.progText());
    });
    this.homeBtn.addEventListener('click', () => {
      if (this.gate(this.homeBtn)) return;
      const it = this.model?.home;
      if (!it) return void this.refuse(this.homeBtn, 'Подожди чуть-чуть — я ещё не готов');
      this.tap(this.homeBtn);
      this.closePop();
      h.pick(it);
    });
    this.gamesBtn.addEventListener('click', () => {
      if (this.gate(this.gamesBtn)) return;
      this.tap(this.gamesBtn);
      this.togglePop('games', 'Игры', this.model?.games ?? [], this.gamesBtn);
    });
    this.gearBtn.addEventListener('click', () => {
      if (this.gate(this.gearBtn)) return;
      this.tap(this.gearBtn);
      this.togglePop('service', 'Ещё', this.model?.service ?? [], this.gearBtn);
    });
    // любое касание — таймер автоскрытия заново; у края экрана — колонки выезжают; мимо поповера — закрыть
    document.addEventListener('pointerdown', (e) => {
      if (!this.on) return;
      const now = performance.now();
      this.auto.touch(now);
      const W = h.root.clientWidth;
      const tgt = e.target as HTMLElement | null;
      const edge = e.clientX < 30 ? 'l' : e.clientX > W - 30 ? 'r' : null;
      if (edge && (this.hiddenNow || this.plan?.[edge === 'l' ? 'left' : 'right'].mode === 'tab')) this.reveal(edge);
      if (this.popFor && !tgt?.closest?.('.tom-pop, .tom-games, .tom-gear, .tom-more')) this.closePop();
    }, true);
  }
  /** до первой игры кнопки приглушены: кот объясняет */
  private gate(b: HTMLElement): boolean {
    if (this.h.playing()) return false;
    this.refuse(b, 'Сначала познакомимся — потом покажу, что умею');
    return true;
  }
  /** колонки выезжают; side — ребёнок тянет именно эту (если ей нет места мимо кота — встаёт поверх, до автоскрытия) */
  reveal(side?: 'l' | 'r') {
    const now = performance.now();
    this.auto.reveal(now);
    if (side && this.plan?.[side === 'l' ? 'left' : 'right'].mode === 'tab') this.forceUntil[side] = now + TOM_IDLE_MS;
    this.tick(true);
  }
  private forceUntil = { l: 0, r: 0 };
  private tap(b: HTMLElement) {
    b.classList.remove('tapped', 'nope');
    void b.offsetWidth;
    b.classList.add('tapped');
  }
  private refuse(b: HTMLElement, why: string) {
    b.classList.remove('tapped', 'nope');
    void b.offsetWidth;
    b.classList.add('nope');
    this.h.hint(why);
  }

  // ───────────── кадр ─────────────
  /** раз в 250 мс: контекст, кот, автоскрытие; перерисовка — только когда что-то поменялось */
  tick(force = false) {
    if (!this.on) return;
    const h = this.h;
    const ctx = h.ctx();
    this.ctxNow = ctx;
    const model = tomModel(h.groups(), ctx);
    const W = h.root.clientWidth, H = h.root.clientHeight;
    const dock = h.dock.getBoundingClientRect(), root = h.root.getBoundingClientRect();
    // safe-area: env() читается только через вычисленный стиль элемента-пробника (padding: env(...))
    const cs = getComputedStyle(this.safeProbe);
    const safe = { t: parseFloat(cs.paddingTop) || 0, b: parseFloat(cs.paddingBottom) || 0, l: parseFloat(cs.paddingLeft) || 0, r: parseFloat(cs.paddingRight) || 0 };
    // верх кнопок дока: рамка дока минус его верхний отступ (12 px)
    const dockTop = dock.height ? dock.top - root.top + 8 : undefined;
    const cat = h.catRect();
    const q = (v: number) => Math.round(v / 8);
    const catKey = cat ? `${q(cat.top)},${q(cat.bottom)},${q(cat.cx)},${q(cat.half)}` : '-';
    const ids = (a: CatalogItem[]) => a.map((i) => `${i.id}:${i.label}`).join(',');
    const modelKey = [ids(model.left), ids(model.right), ids(model.games), ids(model.service), ids(model.room), model.home?.id ?? '-'].join('|');
    const st = (it: CatalogItem) => (this.h.tried.has(it.id) ? 1 : 0) + (disabledReason(it, ctx) ? 2 : 0);
    const stateKey = [...model.left, ...model.right, ...model.games, ...model.room].map(st).join('');
    const now = performance.now();
    const ignoreCat = { l: now < this.forceUntil.l, r: now < this.forceUntil.r };
    const key = `${W}x${H}|${dockTop ?? ''}|${catKey}|${modelKey}|${stateKey}|${h.playing()}|${ignoreCat.l}${ignoreCat.r}`;
    const busy: TomBusy = ctx.busy ?? (h.scenarioQuiet() || !h.playing() ? 'cutscene' : null);
    const hidden = this.auto.hidden(performance.now(), busy, !!this.popFor || this.tipOn);
    if (force || key !== this.key) {
      this.key = key;
      this.model = model;
      const prefer = this.plan ? { l: this.plan.left.mode as ColMode, r: this.plan.right.mode as ColMode } : undefined;
      this.plan = tomLayout({ w: W, h: H, safe, left: model.left.length, right: model.right.length, room: model.room.length > 0, dockTop, prefer, ignoreCat }, cat);
      this.render();
    }
    if (hidden !== this.hiddenNow || force) {
      this.hiddenNow = hidden;
      this.el.classList.toggle('cols-out', hidden);
      if (hidden) this.closePop();
    }
    this.h.root.classList.toggle('tom-play', h.playing());
  }

  // ───────────── рисование ─────────────
  private render() {
    const p = this.plan!, m = this.model!;
    const rs = this.h.root.style;
    rs.setProperty('--tom-chips-b', `${Math.round(p.h - p.chips.y - p.chips.h)}px`);
    rs.setProperty('--tom-free-l', `${Math.round(p.free.left)}px`);
    rs.setProperty('--tom-free-r', `${Math.round(p.w - p.free.right)}px`);
    rs.setProperty('--tom-btn', `${p.btn}px`);
    if (p.room) rs.setProperty('--tom-room-b', `${Math.round(p.h - p.room.y - p.room.h)}px`);
    this.el.classList.toggle('land', p.land);
    this.renderCol(this.colL, this.tabL, p.left, m.left, 'Ласка');
    this.renderCol(this.colR, this.tabR, p.right, m.right, 'Трюки');
    this.renderRoom(p, m.room);
    this.h.root.classList.toggle('tom-room-on', !!p.room);
    // док: «Мой дом» / «На карту»
    const hm = m.home;
    const homeLabel = this.ctxNow.home ? 'На карту' : 'Мой дом';
    (this.homeBtn.querySelector('.tb-l') as HTMLElement).textContent = homeLabel;
    this.homeBtn.querySelector('.tb-ico')!.innerHTML = this.h.icon(this.ctxNow.home ? 'home_card' : 'home_house');
    this.homeBtn.classList.toggle('dis', !hm);
    this.homeBtn.classList.toggle('back', !!this.ctxNow.home);
    this.homeBtn.setAttribute('aria-label', homeLabel);
    this.gamesBtn.classList.toggle('new', m.games.some((i) => this.isNew(i)));
    this.gearBtn.classList.toggle('hidden', !m.service.length);
    const n = this.progress();
    (this.top.querySelector('.tp-n') as HTMLElement).textContent = `${n.tried}/${n.total}`;
    this.top.querySelector('.tom-prog')!.setAttribute('aria-label', this.progText());
    // поповер открыт — обновить его пункты (точки «новое»)
    if (this.popFor === 'games') this.fillPop('Игры', m.games);
    else if (this.popFor === 'service') this.fillPop('Ещё', m.service);
  }
  private progress() {
    const m = this.model;
    if (!m) return { tried: 0, total: 0 };
    const all = [...m.left, ...m.right, ...m.games].filter((i) => !('ui' in i.run));
    return { tried: all.filter((i) => this.h.tried.has(i.id)).length, total: all.length };
  }
  private progText() {
    const n = this.progress();
    return n.tried >= n.total ? `Ты попробовал всё — ${n.total} из ${n.total}!` : `Открыто ${n.tried} из ${n.total}. Ищи кнопки с красной точкой!`;
  }
  private isNew(it: CatalogItem) {
    return !('ui' in it.run) && !this.h.tried.has(it.id);
  }

  private renderCol(col: HTMLDivElement, tab: HTMLButtonElement, plan: ColumnPlan, items: CatalogItem[], title: string) {
    col.dataset.mode = plan.mode;
    const tabbed = plan.mode === 'tab';
    col.classList.toggle('none', tabbed || !items.length);
    const t = plan.tab;
    Object.assign(tab.style, { top: `${t.y}px`, height: `${t.h}px` });
    tab.classList.toggle('forced', tabbed && items.length > 0);
    tab.classList.toggle('new', items.some((i) => this.isNew(i)));
    tab.classList.toggle('none', !items.length);
    if (tabbed || !items.length) return;
    const r = plan.rect;
    Object.assign(col.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    col.style.setProperty('--tom-btn', `${plan.btn}px`);
    col.classList.toggle('sm', plan.btn < (this.plan?.btn ?? plan.btn));
    const want: HTMLElement[] = [];
    if (plan.mode === 'col' || plan.mode === 'colsm') {
      let head = col.querySelector(':scope > .tom-head') as HTMLElement | null;
      if (!head) {
        head = document.createElement('div');
        head.className = 'tom-head';
      }
      head.textContent = title;
      want.push(head);
    }
    const over = items.length > plan.cap;
    const shown = over ? items.slice(0, plan.cap - 1) : items;
    shown.forEach((it, i) => want.push(this.place(this.getBtn(`col${plan.side}`, it), plan.slots[i], r)));
    if (over) {
      const rest = items.slice(plan.cap - 1);
      const more = this.getMore(plan.side);
      more.classList.toggle('new', rest.some((i) => this.isNew(i)));
      this.moreItems[plan.side] = { title, items: rest };
      want.push(this.place(more, plan.slots[plan.cap - 1], r));
    }
    this.reconcile(col, want);
  }
  /** дети контейнера — ровно эти узлы и в этом порядке; уже стоящие на месте не трогаем (анимации и нажатия не сбиваются) */
  private reconcile(box: HTMLElement, want: HTMLElement[]) {
    const keep = new Set(want);
    for (const c of [...box.children]) if (!keep.has(c as HTMLElement)) c.remove();
    want.forEach((el, i) => {
      if (box.children[i] !== el) box.insertBefore(el, box.children[i] ?? null);
    });
  }
  private moreItems: Record<'l' | 'r', { title: string; items: CatalogItem[] }> = { l: { title: '', items: [] }, r: { title: '', items: [] } };
  private moreBtn: Partial<Record<'l' | 'r', HTMLButtonElement>> = {};
  private getMore(side: 'l' | 'r') {
    let more = this.moreBtn[side];
    if (!more) {
      more = this.btn({ id: 'tom:more', label: 'Ещё', icon: 'dots', run: { ui: 'home' } });
      more.classList.add('tom-more');
      const m = more;
      m.onclick = () => {
        this.tap(m);
        const x = this.moreItems[side];
        this.togglePop(`more-${side}`, x.title, x.items, m);
      };
      this.moreBtn[side] = more;
    }
    return more;
  }
  private place(b: HTMLElement, s: Rect, r: Rect) {
    Object.assign(b.style, { left: `${s.x - r.x}px`, top: `${s.y - r.y}px`, width: `${s.w}px`, height: `${s.h}px` });
    return b;
  }
  private renderRoom(p: TomPlan, items: CatalogItem[]) {
    const box = this.room;
    box.classList.toggle('hidden', !p.room || !items.length);
    // «Уложить» / «Разбудить»: на экране только та, что сейчас работает (запись 20.11: «Разбудить» с замочком у бодрого кота)
    const live = items.filter((it) => !(it.id === 'home:wake' && !this.ctxNow.sleeping) && !(it.id === 'home:sleep' && this.ctxNow.sleeping));
    this.reconcile(box, p.room ? live.map((it) => this.getBtn('room', it)) : []);
  }

  /** круглая кнопка: иконка, короткая подпись, точка «новое» */
  private btn(it: CatalogItem): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tom-btn';
    b.dataset.item = it.id;
    if ('action' in it.run) b.dataset.act = it.run.action;
    b.innerHTML = `<span class="tb-ico">${this.h.icon(it.icon) || this.h.icon('star')}</span><span class="tb-l"></span>`;
    (b.querySelector('.tb-l') as HTMLElement).textContent = shortLabel(it);
    b.setAttribute('aria-label', it.label);
    return b;
  }
  private tipOn = false;
  /** кнопки живут между перерисовками (scope:id): перерисовка только двигает их и меняет точки/неактивность */
  private cache = new Map<string, { b: HTMLButtonElement; it: CatalogItem; stub: boolean }>();
  private getBtn(scope: string, it: CatalogItem): HTMLButtonElement {
    const k = `${scope}:${it.id}`;
    let e = this.cache.get(k);
    // иконки дома регистрируются позже (HomeMode): кнопку со «звёздочкой-заглушкой» пересоздаём, когда иконка появилась
    if (!e || e.it.label !== it.label || e.it.icon !== it.icon || (e.stub && this.h.icon(it.icon))) {
      const entry: { b: HTMLButtonElement; it: CatalogItem; stub: boolean } = { b: null as unknown as HTMLButtonElement, it, stub: !this.h.icon(it.icon) };
      entry.b = this.itemBtn(() => entry.it, scope === 'pop' ? (x) => (this.closePop(), this.pickItem(x)) : (x) => this.pickItem(x));
      e = entry;
      this.cache.set(k, e);
    }
    e.it = it;
    const why = disabledReason(it, this.ctxNow);
    e.b.classList.toggle('dis', !!why);
    e.b.classList.toggle('new', !why && this.isNew(it));
    if (why) e.b.setAttribute('aria-disabled', 'true');
    else e.b.removeAttribute('aria-disabled');
    // замочек без объяснения непонятен (запись 20.11): под подписью — коротко, почему кнопка не работает
    const l = e.b.querySelector('.tb-l') as HTMLElement | null;
    const txt = why ? whyShort(why) : shortLabel(it);
    if (l && l.textContent !== txt) l.textContent = txt;
    return e.b;
  }
  private itemBtn(cur: () => CatalogItem, pick: (it: CatalogItem) => void): HTMLButtonElement {
    const b = this.btn(cur());
    // долгое нажатие — подсказка, без выбора
    let fired = false;
    b.addEventListener('pointerdown', () => {
      fired = false;
      clearTimeout(this.tipTimer);
      this.tipTimer = window.setTimeout(() => {
        fired = true;
        const it = cur();
        this.showTip(b, disabledReason(it, this.ctxNow) ?? `${TIP[it.id] ?? it.label}${this.isNew(it) ? ' — ещё не пробовал!' : ''}`);
      }, 480);
    });
    const cancel = () => clearTimeout(this.tipTimer);
    b.addEventListener('pointerup', cancel);
    b.addEventListener('pointerleave', cancel);
    b.addEventListener('pointercancel', cancel);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    b.onclick = () => {
      if (fired) return void (fired = false);
      if (!this.h.playing()) return void this.refuse(b, 'Сначала познакомимся — потом покажу, что умею');
      const it = cur();
      const w = disabledReason(it, this.ctxNow);
      if (w) return void this.refuse(b, w);
      this.tap(b);
      pick(it);
    };
    return b;
  }
  private pickItem(it: CatalogItem) {
    if (!('ui' in it.run)) this.h.tried.mark(it.id);
    this.h.recent.push(it.id);
    this.auto.touch(performance.now());
    this.h.pick(it);
    // точка «новое» гаснет сразу, остальное — на следующем такте
    this.tick(true);
  }

  // ───────────── поповер ─────────────
  private togglePop(id: string, title: string, items: CatalogItem[], anchor: HTMLElement) {
    if (this.popFor === id) return this.closePop();
    if (!items.length) return;
    this.popFor = id;
    this.pop.dataset.for = id;
    this.fillPop(title, items);
    this.pop.classList.remove('hidden');
    anchor.classList.add('on');
    anchor.setAttribute('aria-expanded', 'true');
    this.popAnchor = anchor;
    this.placePop(anchor);
    clearTimeout(this.popTimer);
    this.popTimer = window.setTimeout(() => this.closePop(), 8000);
  }
  private popAnchor: HTMLElement | null = null;
  private fillPop(title: string, items: CatalogItem[]) {
    this.pop.setAttribute('aria-label', title);
    let t = this.pop.querySelector('.tom-pop-t') as HTMLElement | null, g = this.pop.querySelector('.tom-pop-g') as HTMLElement | null;
    if (!t || !g) {
      this.pop.innerHTML = `<div class="tom-pop-t"></div><div class="tom-pop-g"></div>`;
      t = this.pop.querySelector('.tom-pop-t') as HTMLElement;
      g = this.pop.querySelector('.tom-pop-g') as HTMLElement;
    }
    t.textContent = title;
    g.style.setProperty('--n', String(Math.min(4, items.length)));
    this.reconcile(g, items.map((it) => this.getBtn('pop', it)));
  }
  private placePop(anchor: HTMLElement) {
    const W = this.h.root.clientWidth, H = this.h.root.clientHeight;
    const a = anchor.getBoundingClientRect(), root = this.h.root.getBoundingClientRect();
    const pw = this.pop.offsetWidth, ph = this.pop.offsetHeight;
    const ax = a.left - root.left, ay = a.top - root.top;
    let x: number, y: number;
    const side = anchor.closest('.tom-col');
    if (side) {
      // «Ещё» колонки: рядом с колонкой, к центру экрана
      x = side.classList.contains('l') ? ax + a.width + 6 : ax - pw - 6;
      y = ay + a.height / 2 - ph / 2;
    } else {
      x = ax + a.width / 2 - pw / 2;
      y = ay - ph - 10;
    }
    x = Math.max(8, Math.min(W - pw - 8, x));
    y = Math.max(8, Math.min(H - ph - 8, y));
    this.pop.style.left = `${Math.round(x)}px`;
    this.pop.style.top = `${Math.round(y)}px`;
    this.pop.style.setProperty('--ax', `${Math.round(ax + a.width / 2 - x)}px`);
  }
  closePop() {
    clearTimeout(this.popTimer);
    if (!this.popFor) return;
    this.popFor = '';
    this.pop.classList.add('hidden');
    this.popAnchor?.classList.remove('on');
    this.popAnchor?.setAttribute('aria-expanded', 'false');
    this.popAnchor = null;
  }

  // ───────────── подсказка долгого нажатия ─────────────
  private showTip(b: HTMLElement, text: string) {
    const tip = this.tip;
    tip.textContent = text;
    tip.classList.remove('hidden');
    const W = this.h.root.clientWidth;
    const r = b.getBoundingClientRect(), root = this.h.root.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    const inCol = b.closest('.tom-col');
    let x = r.left - root.left + r.width / 2 - tw / 2, y = r.top - root.top - th - 8;
    if (inCol) {
      x = inCol.classList.contains('l') ? r.right - root.left + 6 : r.left - root.left - tw - 6;
      y = r.top - root.top + r.width / 2 - th / 2;
    }
    tip.style.left = `${Math.round(Math.max(8, Math.min(W - tw - 8, x)))}px`;
    tip.style.top = `${Math.round(Math.max(8, y))}px`;
    this.tipOn = true;
    clearTimeout(this.tipHide);
    this.tipHide = window.setTimeout(() => {
      tip.classList.add('hidden');
      this.tipOn = false;
    }, 2000);
  }
  private tipHide = 0;

  // ───────────── чипы кота ─────────────
  /** дома: действия комнаты уже в ряду комнаты — в чипах кота их не повторяем */
  filterChips(chips: Chip[]): Chip[] {
    if (!this.on) return chips;
    const room = new Set((this.model?.room ?? []).map((i) => i.id));
    return chips.filter((c) => !room.has(c.id) && c.id !== 'home:back');
  }
}

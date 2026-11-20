/**
 * Подсказки ребёнку «нажми сюда» (feature 'ui.hints'): пульсирующее кольцо вокруг кнопки и палец, который по ней
 * «стучит». Не закрывают кота (палец сдвигается из прямоугольника морды), не мешают касаниям (pointer-events: none) и
 * пропадают от любого касания. Каждая подсказка — не больше раза за сессию; память — localStorage (try/catch).
 *
 * Когда (HintsController.tick, раз в 500 мс, только в игре и когда кот ни о чём не спрашивает):
 *   · tour — после онбординга и знакомства: 2–3 главные кнопки по очереди (первая кнопка «Ласки», «Игры», микрофон),
 *     пока ребёнок не коснулся экрана (это и есть «первое касание»);
 *   · idle:1…3 — ~9 с без касаний: одна кнопка (чип кота, «Ласка», «Игры»), каждая — раз за сессию;
 *   · mode:home / mode:card — сразу после смены режима (дома — первая кнопка комнаты, на карте — «Ласка»).
 * Чистая логика (выбор подсказки, хранилище сессии) — без DOM, покрыта тестом tests/hints.test.ts.
 */

export type HintId = 'tour' | 'idle:1' | 'idle:2' | 'idle:3' | 'mode:home' | 'mode:card';

/** без касаний столько мс — подсказка бездействия */
export const IDLE_MS = 9000;
/** шаг экскурсии по кнопкам */
export const TOUR_STEP_MS = 2300;
/** новая сессия, если не играли столько мс */
export const SESSION_GAP_MS = 30 * 60_000;
/** экскурсию показываем не больше стольких сессий вообще (дальше ребёнок и так знает кнопки) */
export const TOUR_MAX_SESSIONS = 3;

type Store = Pick<Storage, 'getItem' | 'setItem'>;
interface Saved {
  /** начало сессии и последнее касание (мс) */
  sid: number;
  at: number;
  /** показанные в этой сессии */
  shown: string[];
  /** сколько сессий показывалась каждая */
  ever: Record<string, number>;
}

/** «уже показывали в этой сессии»: localStorage, переживает перезагрузку вкладки; через 30 мин — новая сессия */
export class SessionMarks {
  private s: Saved;
  constructor(private key: string, private store: Store | null = safeLocal(), private now = () => Date.now()) {
    const t = now();
    let s: Saved | null = null;
    try {
      const raw = store?.getItem(key);
      if (raw) s = JSON.parse(raw) as Saved;
    } catch {
      s = null;
    }
    if (!s || typeof s.at !== 'number' || !Array.isArray(s.shown)) s = { sid: t, at: t, shown: [], ever: {} };
    if (t - s.at > SESSION_GAP_MS) s = { sid: t, at: t, shown: [], ever: s.ever ?? {} };
    this.s = s;
    this.save();
  }
  has(id: string) {
    return this.s.shown.includes(id);
  }
  /** сколько сессий подряд это уже показывали (включая текущую, если показано) */
  ever(id: string) {
    return this.s.ever[id] ?? 0;
  }
  mark(id: string) {
    if (this.has(id)) return;
    this.s.shown.push(id);
    this.s.ever[id] = (this.s.ever[id] ?? 0) + 1;
    this.save();
  }
  touch() {
    this.s.at = this.now();
    this.save();
  }
  private save() {
    try {
      this.store?.setItem(this.key, JSON.stringify(this.s));
    } catch {
      /* приватный режим / квота — подсказки просто покажутся ещё раз */
    }
  }
}

function safeLocal(): Store | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** состояние приложения для выбора подсказки */
export interface HintState {
  /** идёт игра (знакомство пройдено) */
  playing: boolean;
  /** кот занят: диалог/игра, пробуждение, раскраска, листы, туман, поповер — подсказок нет */
  busy: boolean;
  /** дома / на карте */
  home: boolean;
  /** мс с последнего касания */
  idleMs: number;
  /** мс с начала игры */
  playMs: number;
  /** ребёнок уже касался экрана после начала игры */
  touched: boolean;
}

/** какую подсказку показать сейчас (null — никакую); seen — уже показанные в сессии */
export function pickHint(s: HintState, seen: (id: HintId) => boolean, tourEver: number, modeChanged: 'home' | 'card' | null): HintId | null {
  if (!s.playing || s.busy) return null;
  if (modeChanged === 'home' && !seen('mode:home')) return 'mode:home';
  if (modeChanged === 'card' && !seen('mode:card')) return 'mode:card';
  // экскурсия: в начале игры, пока ребёнок ничего не трогал (1,5 с — кот успевает поздороваться)
  if (!s.touched && !s.home && s.playMs > 1500 && !seen('tour') && tourEver < TOUR_MAX_SESSIONS) return 'tour';
  if (s.idleMs >= IDLE_MS) for (const id of ['idle:1', 'idle:2', 'idle:3'] as const) if (!seen(id)) return id;
  return null;
}

// ───────────── DOM ─────────────

const FINGER = '<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M18 30V9a3.5 3.5 0 0 1 7 0v13l1-.2V16a3.3 3.3 0 0 1 6.5 0v7l.8.1v-4a3.2 3.2 0 0 1 6.3 0V30c0 8-5 14-12.5 14-5 0-8-2.6-10.8-7.4L11.6 31a3.2 3.2 0 0 1 5-4z" fill="#fff" stroke="#1f2a2e" stroke-width="2.2" stroke-linejoin="round"/></svg>';

export interface FaceBox { l: number; r: number; t: number; b: number }

/** кольцо + палец над кнопкой */
export class HintPointer {
  readonly el: HTMLDivElement;
  private hand: HTMLElement;
  private target: HTMLElement | null = null;
  private raf = 0;
  constructor(private root: HTMLElement, private face: () => FaceBox | null) {
    const el = document.createElement('div');
    el.className = 'hintp hidden';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = `<i class="hintp-ring"></i><i class="hintp-ring r2"></i><div class="hintp-hand">${FINGER}</div>`;
    root.appendChild(el);
    this.el = el;
    this.hand = el.querySelector('.hintp-hand') as HTMLElement;
  }
  get on() {
    return !!this.target;
  }
  show(b: HTMLElement) {
    this.target = b;
    b.classList.add('hint-on');
    this.el.classList.remove('hidden');
    this.place();
    cancelAnimationFrame(this.raf);
    const loop = () => {
      if (!this.target) return;
      this.place();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }
  hide() {
    this.target?.classList.remove('hint-on');
    this.target = null;
    cancelAnimationFrame(this.raf);
    this.el.classList.add('hidden');
  }
  private place() {
    const b = this.target;
    if (!b) return;
    if (!visible(b)) return this.hide();
    const r = b.getBoundingClientRect(), o = this.root.getBoundingClientRect();
    // кольцо — вокруг круглой части кнопки (иконки), если она есть
    const ico = (b.querySelector('.tb-ico, .sug-ico, svg') as HTMLElement | null) ?? b;
    const ri = ico === b ? r : ico.getBoundingClientRect();
    const cx = ri.left + ri.width / 2 - o.left, cy = ri.top + ri.height / 2 - o.top;
    const d = Math.max(ri.width, ri.height) + 14;
    this.el.style.left = `${Math.round(cx)}px`;
    this.el.style.top = `${Math.round(cy)}px`;
    this.el.style.setProperty('--d', `${Math.round(d)}px`);
    // палец: кончик — на кнопке; рука — к ближнему краю экрана (не к коту в центре); морду не закрывает
    const W = this.root.clientWidth;
    const left = cx < W / 2;
    let dx = left ? 6 : -6, dy = Math.max(10, ri.height * 0.3);
    const f = this.face();
    const hx = cx + dx + (left ? 0 : -48), hy = cy + dy;
    if (f && hx < f.r && hx + 48 > f.l && hy < f.b && hy + 48 > f.t) dy += f.b - hy + 4;
    this.hand.style.transform = `translate(${dx}px, ${dy}px) scaleX(${left ? 1 : -1})`;
  }
}

export function visible(b: HTMLElement | null): b is HTMLElement {
  if (!b || !b.isConnected) return false;
  if (b.closest('.hidden, [hidden]')) return false;
  if (b.classList.contains('dis') || b.getAttribute('aria-disabled') === 'true') return false;
  const r = b.getBoundingClientRect();
  if (r.width < 8 || r.height < 8) return false;
  if (r.right < 4 || r.left > innerWidth - 4 || r.bottom < 4 || r.top > innerHeight - 4) return false;
  const cs = getComputedStyle(b);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.3;
}

/** что приложение даёт контроллеру подсказок */
export interface HintsHost {
  root: HTMLElement;
  playing(): boolean;
  busy(): boolean;
  home(): boolean;
  face(): FaceBox | null;
  log?(s: string): void;
}

/** кнопки-кандидаты по подсказке (первая видимая — цель) */
const TARGETS: Record<string, string[]> = {
  tour: ['.tom-col.l .tom-btn', '.tom-games', '.mic', '.sug', '.pawbtn'],
  'idle:1': ['.chips.suggest .sug', '.tom-col.l .tom-btn', '.pawbtn'],
  'idle:2': ['.tom-col.l .tom-btn', '.tom-col.r .tom-btn', '.pawbtn'],
  'idle:3': ['.tom-games', '.mic', '.pawbtn'],
  'mode:home': ['.tom-room .tom-btn', '.home-arrow.r', '.tom-col.l .tom-btn'],
  'mode:card': ['.tom-col.l .tom-btn', '.chips.suggest .sug', '.pawbtn'],
};

export class HintsController {
  readonly marks: SessionMarks;
  readonly pointer: HintPointer;
  private lastTouch = performance.now();
  private playSince = 0;
  private touched = false;
  private wasHome: boolean | null = null;
  private modeChanged: 'home' | 'card' | null = null;
  private modeAt = 0;
  private timer = 0;
  private stepTimer = 0;
  private current: HintId | null = null;
  constructor(private h: HintsHost, store?: Pick<Storage, 'getItem' | 'setItem'> | null) {
    this.marks = new SessionMarks('sber-ar-cat:hints', store === undefined ? undefined : store);
    this.pointer = new HintPointer(h.root, () => h.face());
    // любое касание: подсказка уходит, отсчёт бездействия заново
    document.addEventListener('pointerdown', () => this.onTouch(), true);
    this.timer = window.setInterval(() => this.tick(), 500);
  }
  /** подсказка сейчас на экране (тесты, снимки) */
  get showing() {
    return this.current;
  }
  onTouch() {
    this.lastTouch = performance.now();
    if (this.playSince) this.touched = true;
    this.marks.touch();
    this.stop();
  }
  stop() {
    clearTimeout(this.stepTimer);
    this.pointer.hide();
    this.current = null;
  }
  tick() {
    const h = this.h, now = performance.now();
    const playing = h.playing();
    if (playing && !this.playSince) this.playSince = now;
    const home = h.home();
    if (this.wasHome !== null && home !== this.wasHome) {
      this.modeChanged = home ? 'home' : 'card';
      this.modeAt = now;
      this.stop();
    }
    this.wasHome = home;
    // смена режима «помнится» 6 с: за это время переход (портал, комната) успевает закончиться
    if (this.modeChanged && now - this.modeAt > 6000) this.modeChanged = null;
    const busy = h.busy();
    if (busy && this.current) this.stop();
    if (this.current) return;
    const id = pickHint(
      { playing, busy, home, idleMs: now - this.lastTouch, playMs: this.playSince ? now - this.playSince : 0, touched: this.touched },
      (x) => this.marks.has(x), this.marks.ever('tour'), this.modeChanged && now - this.modeAt > 1800 ? this.modeChanged : null,
    );
    if (!id) return;
    const targets = this.targets(id);
    if (!targets.length) return;
    this.marks.mark(id);
    if (id.startsWith('mode:')) this.modeChanged = null;
    this.current = id;
    h.log?.(`подсказка «нажми сюда»: ${id}`);
    this.run(targets, 0, id === 'tour' ? TOUR_STEP_MS : 3200);
  }
  private run(targets: HTMLElement[], i: number, ms: number) {
    if (i >= targets.length || !visible(targets[i])) return this.stop();
    this.pointer.show(targets[i]);
    this.stepTimer = window.setTimeout(() => {
      this.pointer.hide();
      this.stepTimer = window.setTimeout(() => this.run(targets, i + 1, ms), 250);
    }, ms);
  }
  /** кнопки подсказки: экскурсия — до трёх разных, остальные — одна */
  private targets(id: HintId): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (const sel of TARGETS[id] ?? []) {
      const b = [...this.h.root.querySelectorAll<HTMLElement>(sel)].find((x) => visible(x));
      if (b && !out.includes(b)) out.push(b);
      if (out.length >= (id === 'tour' ? 3 : 1)) break;
    }
    return out;
  }
  dispose() {
    clearInterval(this.timer);
    this.stop();
  }
}

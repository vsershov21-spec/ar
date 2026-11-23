/**
 * Воронка пилота (docs/ANALYTICS.md): маленькие события → navigator.sendBeacon → POST /api/progress/event
 * (server/progress, таблица events). Редакции pilot и lab (feature 'analytics'); ?noanalytics — выключить.
 *
 * Без персональных данных: только id устройства (тот же случайный UUID, что у прогресса), редакция, имя события и
 * свойства из белого списка (числа и короткие латинские id). Имя ребёнка, речь, тексты и данные карты не уходят никогда:
 * sanitize() отбрасывает всё, чего нет в PROPS, а строки — только [a-z0-9_:.-] до 32 символов.
 */
import { EDITION, feature } from '../config/edition';
import { getDeviceId, safeStorage } from '../progress/device';
import { quickBridge } from '../quick/early';

export const EVENTS = [
  'open', 'onboarding_done', 'camera_granted', 'card_landed', 'awake_done', 'named', 'action', 'game_start', 'game_end',
  'cat_switch', 'home_enter', 'sleep', 'wake', 'card_lost', 'sberkids_click', 'session_end',
  // раскраска карты (src/card/paint.ts)
  'paint_offer', 'paint_start', 'paint_done', 'paint_erase',
  // быстрый вход (feature 'intro.quick', src/quick): воронка по шагам, ms — от начала навигации
  'page_open', 'splash_shown', 'cta_tap', 'camera_denied', 'camera_retry', 'mic_granted', 'mic_denied', 'terms_open',
  'card_search_start', 'card_found', 'cat_awake', 'first_action',
  // озвучка (src/voice/voicePlayer.ts): реплика без звука или поздно — причина и мс (без текста, имени, id реплики)
  'voice_issue',
] as const;
export type EventName = (typeof EVENTS)[number];

type Kind = 'num' | 'id';
/** свойства события: только эти ключи и типы (остальное выбрасывается) */
export const PROPS: Partial<Record<EventName, Record<string, Kind>>> = {
  card_landed: { ms: 'num' },
  camera_granted: { ms: 'num' },
  page_open: { ms: 'num' },
  splash_shown: { ms: 'num' },
  cta_tap: { ms: 'num', early: 'num' },
  camera_denied: { ms: 'num' },
  camera_retry: { ms: 'num' },
  mic_granted: { ms: 'num' },
  mic_denied: { ms: 'num' },
  terms_open: { ms: 'num' },
  card_search_start: { ms: 'num' },
  card_found: { ms: 'num' },
  cat_awake: { ms: 'num' },
  first_action: { ms: 'num', id: 'id' },
  action: { id: 'id' },
  game_start: { id: 'id' },
  game_end: { id: 'id' },
  cat_switch: { to: 'id' },
  home_enter: { reason: 'id' },
  card_lost: { count: 'num' },
  sberkids_click: { kind: 'id' },
  session_end: { sec: 'num' },
  paint_start: { color: 'id' },
  voice_issue: { reason: 'id', ms: 'num', net: 'num', dec: 'num', warm: 'num', ev: 'id', ctx: 'id' },
};
const ID_RE = /^[a-z0-9_:.-]{1,32}$/i;

/**
 * Шаги воронки входа под прежними именами: событие → его имя в воронке входа (раз за сессию, с ms от навигации).
 * Старые события остаются как были (сводка за прошлые дни сравнима).
 */
export const ALIAS: Partial<Record<EventName, EventName>> = { open: 'page_open', card_landed: 'card_found', awake_done: 'cat_awake', action: 'first_action' };
/** события только раз за сессию (и из очереди заставки, и из приложения — второе отбрасывается) */
export const ONCE: ReadonlySet<string> = new Set(['page_open', 'splash_shown', 'cta_tap', 'camera_granted', 'mic_granted', 'mic_denied', 'card_search_start', 'card_found', 'cat_awake', 'first_action']);

/**
 * Метка источника из QR (?src=<банк/точка>): только латиница и цифры, до 32 символов, иначе — нет метки.
 * Сохраняется (localStorage ar.src, 30 дней): ребёнок открыл ссылку из истории без метки — сессия всё равно «из точки».
 * Это не персональные данные: метка — точка раздачи QR, одна на всех детей.
 */
export const SRC_RE = /^[A-Za-z0-9]{1,32}$/;
export const SRC_TTL_MS = 30 * 86_400_000;
export function readSrc(search: string, store: Pick<Storage, 'getItem' | 'setItem'> | null, now = Date.now()): string | null {
  const v = new URLSearchParams(search).get('src');
  if (v !== null && SRC_RE.test(v)) {
    try {
      store?.setItem('ar.src', JSON.stringify({ v, at: now }));
    } catch {
      /* приватный режим */
    }
    return v;
  }
  try {
    const s = JSON.parse(store?.getItem('ar.src') ?? 'null') as { v?: string; at?: number } | null;
    if (s && typeof s.v === 'string' && SRC_RE.test(s.v) && typeof s.at === 'number' && now - s.at < SRC_TTL_MS) return s.v;
  } catch {
    /* битая запись — без метки */
  }
  return null;
}

export type Props = Record<string, string | number>;

/** белый список: неизвестное событие — null; свойства — только из PROPS, числа — целые 0…10⁷, строки — латинские id */
export function sanitize(name: string, props: Record<string, unknown> = {}): { name: EventName; props: Props } | null {
  if (!(EVENTS as readonly string[]).includes(name)) return null;
  const rules = PROPS[name as EventName] ?? {};
  const out: Props = {};
  for (const [k, kind] of Object.entries(rules)) {
    const v = props[k];
    if (kind === 'num' && typeof v === 'number' && Number.isFinite(v)) out[k] = Math.max(0, Math.min(1e7, Math.round(v)));
    else if (kind === 'id' && typeof v === 'string' && ID_RE.test(v)) out[k] = v;
  }
  return { name: name as EventName, props: out };
}

export interface AnalyticsOptions {
  device: string;
  edition: string;
  send: (url: string, body: string) => boolean;
  now?: () => number;
  /** не больше стольких событий за сессию (и сервер режет по устройству) */
  max?: number;
  /** метка источника из QR (readSrc) — в каждое событие */
  src?: string | null;
  /** мс от начала навигации (шаги воронки входа) */
  clock?: () => number;
}

export const ENDPOINT = '/api/progress/event';

export class Analytics {
  private n = 0;
  private once = new Set<string>();
  readonly startedAt: number;
  constructor(private o: AnalyticsOptions) {
    this.startedAt = (o.now ?? Date.now)();
  }
  /** событие; once — только первое за сессию (open, onboarding_done, camera_granted, card_landed…) */
  track(name: EventName, props: Record<string, unknown> = {}, once = false): boolean {
    if (once) {
      if (this.once.has(name)) return false;
      this.once.add(name);
    }
    const ev = sanitize(name, props);
    if (!ev || this.n >= (this.o.max ?? 400)) return false;
    this.n++;
    const body = JSON.stringify({ device: this.o.device, edition: this.o.edition, name: ev.name, props: ev.props, ts: (this.o.now ?? Date.now)(), ...(this.o.src ? { src: this.o.src } : {}) });
    let ok = false;
    try {
      ok = this.o.send(ENDPOINT, body);
    } catch {
      ok = false;
    }
    const alias = ALIAS[ev.name];
    if (alias) this.track(alias, { ms: this.o.clock?.() ?? 0, ...(ev.props.id ? { id: ev.props.id } : {}) }, true);
    return ok;
  }
  /** сколько секунд идёт сессия */
  seconds() {
    return Math.round(((this.o.now ?? Date.now)() - this.startedAt) / 1000);
  }
}

/** выключено: редакция без аналитики, ?noanalytics или нет sendBeacon (тогда track — пустой) */
const NOOP = { track: () => false, seconds: () => 0 } as unknown as Analytics;
let inst: Analytics | null = null;

export function analyticsEnabled(search = typeof location !== 'undefined' ? location.search : ''): boolean {
  return feature('analytics') && !new URLSearchParams(search).has('noanalytics') && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function';
}

/** main.ts, после bootProgress (тот же id устройства) */
export function bootAnalytics(): Analytics {
  if (inst) return inst;
  if (!analyticsEnabled()) return (inst = NOOP);
  let store: Storage | null = null;
  try {
    store = localStorage;
  } catch {
    store = null;
  }
  inst = new Analytics({
    device: getDeviceId(safeStorage()),
    edition: EDITION,
    send: (url, body) => navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' })),
    src: readSrc(location.search, store),
    clock: () => performance.now(),
  });
  (window as unknown as { __analytics: Analytics }).__analytics = inst;
  inst.track('open', {}, true);
  // быстрый вход: шаги, которые заставка (src/quick/splash.ts) записала до бандла, и дальше — сразу
  const q = quickBridge();
  if (q) {
    const a = inst;
    for (const [n, p] of q.ev.splice(0)) a.track(n as EventName, p, ONCE.has(n));
    q.track = (n, p) => {
      a.track(n as EventName, p, ONCE.has(n));
    };
  }
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    inst!.track('session_end', { sec: inst!.seconds() });
  };
  addEventListener('pagehide', end);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') end();
    else ended = false;
  });
  return inst;
}

/** событие воронки (до bootAnalytics и без аналитики — ничего) */
export function track(name: EventName, props: Record<string, unknown> = {}, once = false): void {
  inst?.track(name, props, once || ONCE.has(name));
}

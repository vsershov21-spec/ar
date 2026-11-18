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

export const EVENTS = [
  'open', 'onboarding_done', 'camera_granted', 'card_landed', 'awake_done', 'named', 'action', 'game_start', 'game_end',
  'cat_switch', 'home_enter', 'sleep', 'wake', 'card_lost', 'sberkids_click', 'session_end',
] as const;
export type EventName = (typeof EVENTS)[number];

type Kind = 'num' | 'id';
/** свойства события: только эти ключи и типы (остальное выбрасывается) */
export const PROPS: Partial<Record<EventName, Record<string, Kind>>> = {
  card_landed: { ms: 'num' },
  action: { id: 'id' },
  game_start: { id: 'id' },
  game_end: { id: 'id' },
  cat_switch: { to: 'id' },
  home_enter: { reason: 'id' },
  card_lost: { count: 'num' },
  sberkids_click: { kind: 'id' },
  session_end: { sec: 'num' },
};
const ID_RE = /^[a-z0-9_:.-]{1,32}$/i;

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
    const body = JSON.stringify({ device: this.o.device, edition: this.o.edition, name: ev.name, props: ev.props, ts: (this.o.now ?? Date.now)() });
    try {
      return this.o.send(ENDPOINT, body);
    } catch {
      return false;
    }
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
  inst = new Analytics({
    device: getDeviceId(safeStorage()),
    edition: EDITION,
    send: (url, body) => navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' })),
  });
  (window as unknown as { __analytics: Analytics }).__analytics = inst;
  inst.track('open', {}, true);
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
  inst?.track(name, props, once);
}

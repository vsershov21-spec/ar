/**
 * Признак устройства для серверного прогресса: случайный UUID v4 при первом запуске.
 * Хранится в localStorage (`ar.device`) и дублируется в cookie (`ar_device`, ~400 дней) — если одно из двух очистили,
 * восстанавливаем из другого. Никакого фингерпринтинга браузера (модель, экран, шрифты и т. п. не используются):
 * очистили и то и другое — это новое устройство.
 */
import { STORAGE_PREFIX } from '../config/edition';

export const DEVICE_KEY = 'ar.device';
/** cookie редакции: lab — свой id устройства (`lab_ar_device`), ключ localStorage lab и так с префиксом (config/edition.ts) */
export const cookieName = (prefix = STORAGE_PREFIX) => (prefix ? prefix.replace(/[^a-z0-9]/gi, '') + '_' : '') + 'ar_device';
const COOKIE = cookieName();
const RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const isDeviceId = (s: unknown): s is string => typeof s === 'string' && RE.test(s);

/** короткий код для продакта (сброс на /test/admin): 6 hex-символов, тот же расчёт на сервере (server/progress/store.mjs) */
export const deviceCode = (id: string) => id.replace(/-/g, '').slice(0, 6).toUpperCase();

export function newUuid(rnd?: (b: Uint8Array) => Uint8Array): string {
  if (!rnd && typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = new Uint8Array(16);
  if (rnd) b.set(rnd(b));
  else crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export interface CookieJar {
  cookie: string;
}

function readCookie(jar: CookieJar | null): string | null {
  try {
    const m = jar?.cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
    return m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}

function writeCookie(jar: CookieJar | null, id: string) {
  try {
    if (!jar) return;
    const secure = typeof location !== 'undefined' && location.protocol === 'https:' ? '; Secure' : '';
    jar.cookie = `${COOKIE}=${id}; Max-Age=34560000; Path=/; SameSite=Lax${secure}`;
  } catch {
    /* cookie запрещены */
  }
}

/** id устройства (создаёт при первом вызове). storage/jar — для тестов; null — недоступно */
export function getDeviceId(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage(),
  jar: CookieJar | null = typeof document !== 'undefined' ? document : null,
): string {
  let ls: string | null = null;
  try {
    ls = storage?.getItem(DEVICE_KEY) ?? null;
  } catch {
    /* приватный режим */
  }
  const ck = readCookie(jar);
  const id = isDeviceId(ls) ? ls : isDeviceId(ck) ? ck : newUuid();
  if (ls !== id) {
    try {
      storage?.setItem(DEVICE_KEY, id);
    } catch {
      /* ignore */
    }
  }
  if (ck !== id) writeCookie(jar, id);
  return id;
}

export function safeStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

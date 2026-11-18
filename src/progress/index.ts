/**
 * Точка входа серверного прогресса (вызывается из main.ts до создания App).
 *   ?reset=1     — сбросить прогресс этого устройства (локально сразу, на сервере — при первом ответе)
 *   ?noname      — не отправлять имя ребёнка на сервер (или сборка с VITE_PROGRESS_NAME=0)
 *   ?progress=0  — без сервера, только localStorage (или сборка с VITE_PROGRESS=0)
 * Консоль: __progress.code, __progress.sync.state, __progress.sync.flush().
 */
import { ProgressSync } from './sync';
import { deviceCode, getDeviceId, safeStorage } from './device';
import { EDITION, feature } from '../config/edition';

export interface ProgressHandle {
  device: string;
  code: string;
  sync: ProgressSync | null;
}

let handle: ProgressHandle | null = null;

const env = (k: string): string | undefined => (import.meta as any).env?.[k];

/** признак «не отправлять имя»: ?noname или VITE_PROGRESS_NAME=0 */
export function sendNameAllowed(search = typeof location !== 'undefined' ? location.search : '') {
  return !new URLSearchParams(search).has('noname') && env('VITE_PROGRESS_NAME') !== '0';
}

export function bootProgress(log?: (s: string) => void): ProgressHandle {
  if (handle) return handle;
  const q = new URLSearchParams(location.search);
  const storage = safeStorage();
  const device = getDeviceId(storage);
  handle = { device, code: deviceCode(device), sync: null };
  (window as any).__progress = handle;
  // редакция без серверного прогресса (config/edition.ts, progress.server) — только localStorage
  if (!storage || !feature('progress.server') || q.get('progress') === '0' || env('VITE_PROGRESS') === '0') return handle;

  const sync = new ProgressSync({ device, storage, sendName: sendNameAllowed(), edition: EDITION, log: log ?? ((s) => console.info(s)) });
  handle.sync = sync;
  if (q.get('reset') === '1') {
    sync.markReset();
    // убираем reset=1 из адреса (перезагрузка не сбросит снова), остальные параметры — как были (?debug без «=»)
    const qs = location.search.slice(1).split('&').filter((x) => x && !/^reset(=|$)/.test(x)).join('&');
    try {
      history.replaceState(history.state, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
    } catch {
      /* ignore */
    }
  }
  void sync.start();
  sync.attach(window);
  return handle;
}

/** не дольше 1,5 с с момента bootProgress: App ждёт это перед чтением памяти (обычно ответ приходит раньше, чем грузится контент) */
export function progressReady(): Promise<unknown> {
  return handle?.sync?.ready ?? Promise.resolve();
}

/** история сессии: смены фазы и кота (кратко, без текста реплик и речи ребёнка) */
export function trackSession(director: { on(t: 'phase' | 'persona', fn: (v: string) => void): unknown; personas: { id: string } }) {
  const s = handle?.sync;
  if (!s) return;
  s.sessionStart(director.personas.id);
  director.on('phase', (p) => s.sessionEvent('phase:' + p));
  director.on('persona', (id) => s.sessionEvent('cat:' + id));
}

export function progressHandle() {
  return handle;
}

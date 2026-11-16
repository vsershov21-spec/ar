/**
 * Контекст входа: время суток и сколько не виделись. Добавка-префикс к приветствию.
 *  long_absence     — не заходили больше 3 дней;
 *  morning          — первый вход за день, 6:00–11:00;
 *  evening          — вход 20:00–23:00;
 *  first_time_today — первый вход за день в остальное время (только для повторных визитов).
 */
export type ContextEvent = 'long_absence' | 'morning' | 'evening' | 'first_time_today';

export const DAY_MS = 24 * 3600 * 1000;
export const LONG_ABSENCE_MS = 3 * DAY_MS;

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

export function contextEvent(now: Date, lastVisitAt: number | null): ContextEvent | null {
  const h = now.getHours();
  const firstVisit = !lastVisitAt;
  const firstToday = firstVisit || dayKey(new Date(lastVisitAt)) !== dayKey(now);
  if (!firstVisit && now.getTime() - lastVisitAt! > LONG_ABSENCE_MS) return 'long_absence';
  if (firstToday && h >= 6 && h < 11) return 'morning';
  if (h >= 20 && h < 23) return 'evening';
  if (firstToday && !firstVisit) return 'first_time_today';
  return null;
}

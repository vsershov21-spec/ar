export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const rand = (a: number, b: number) => a + Math.random() * (b - a);
export const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const easeOutBack = (t: number) => {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
export const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
/**
 * Путь к ассету из public/ (модели, озвучка, Vosk, звуки, видео…) с учётом base (vite) — чтобы работало в подпапке.
 * Редакция lab (/lab/, docs/EDITIONS.md): html/js/css — под base '/lab/', а тяжёлые ассеты — общие из корня сайта:
 * сборка lab задаёт VITE_ASSET_BASE='/' и не копирует public/ (scripts/build/editions.mjs).
 */
const ASSET_BASE: string = import.meta.env.VITE_ASSET_BASE || import.meta.env.BASE_URL;
export const asset = (p: string) => ASSET_BASE + p.replace(/^\//, '');

/**
 * Каталог эффектов — content/fx.json (источник правды) + fxTuning характера поверх params.
 * Неизвестный id не роняет приложение: предупреждение в лог (один раз) и заглушка-«пустышка».
 */
import fxJson from '../../content/fx.json';

export type FxLayerKind = 'glass' | 'world' | 'ui';
export type FxParams = Record<string, unknown>;

export interface FxDef {
  id: string;
  layer: FxLayerKind;
  /** 0 — живёт, пока не остановят (ui-индикаторы) */
  durationMs: number;
  persona: string;
  sound: string;
  params: FxParams;
  notes?: string;
}

/** fxTuning характера: id эффекта → переопределения params */
export type FxTuning = Record<string, FxParams>;

const DEFS = new Map<string, FxDef>();
for (const f of (fxJson as { fx: FxDef[] }).fx) DEFS.set(f.id, f);

export const FX_IDS: readonly string[] = [...DEFS.keys()];

const warned = new Set<string>();
let warn: (msg: string) => void = (m) => console.warn(m);
/** куда писать предупреждения (debug-лог) */
export function setFxCatalogLogger(fn: (msg: string) => void) {
  warn = fn;
}

export function hasFx(id: string): boolean {
  return DEFS.has(id);
}

/**
 * Определение эффекта с параметрами характера поверх. Неизвестный id → заглушка (layer ui, 0 мс, без звука)
 * с флагом stub=true и предупреждением в лог.
 */
export function resolveFx(id: string, tuning?: FxTuning, extra?: FxParams): FxDef & { stub?: boolean } {
  const d = DEFS.get(id);
  if (!d) {
    if (!warned.has(id)) {
      warned.add(id);
      warn(`[fx] неизвестный эффект «${id}» — заглушка (нет в content/fx.json)`);
    }
    return { id, layer: 'ui', durationMs: 0, persona: 'all', sound: 'none', params: { ...extra }, stub: true };
  }
  return { ...d, params: { ...d.params, ...(tuning?.[id] ?? {}), ...(extra ?? {}) } };
}

/** типобезопасное чтение параметров */
export const num = (p: FxParams, k: string, def: number): number => (typeof p[k] === 'number' ? (p[k] as number) : def);
export const bool = (p: FxParams, k: string, def: boolean): boolean => (typeof p[k] === 'boolean' ? (p[k] as boolean) : def);
export const str = (p: FxParams, k: string, def: string): string => (typeof p[k] === 'string' ? (p[k] as string) : def);
export const range = (p: FxParams, k: string, def: [number, number]): [number, number] => {
  const v = p[k];
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' ? [v[0], v[1] as number] : def;
};
export const list = (p: FxParams, k: string, def: string[]): string[] => (Array.isArray(p[k]) ? (p[k] as string[]) : def);

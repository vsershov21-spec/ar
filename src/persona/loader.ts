import type { Persona } from './types';
import { asset } from '../core/util';

export async function loadPersonas(urls: string[]): Promise<Map<string, Persona>> {
  const map = new Map<string, Persona>();
  const list = await Promise.all(urls.map((u) => fetch(asset(u)).then((r) => r.json() as Promise<Persona>)));
  for (const p of list) map.set(p.id, p);
  return map;
}

/** Подстановка {name} и т.п. */
export const fill = (text: string, vars: Record<string, string> = {}) => text.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');

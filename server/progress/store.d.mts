export const DEVICE_RE: RegExp;
export function deviceCode(device: string): string;
/** JSON-значение ключа прогресса без полей, похожих на имя ребёнка (не JSON — как есть) */
export function stripName(v: string): string;
/** документ устройства без имени ребёнка; второе значение — было ли что вырезать */
export function stripDocNames<T extends { data?: Record<string, string> }>(doc: T): [T, boolean];
export function openStore(dir: string, kind?: 'auto' | 'sqlite' | 'file'): Promise<{ kind: 'sqlite' | 'file'; list(): string[]; get(device: string): any; put(doc: any): void; close(): void }>;

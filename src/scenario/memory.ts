/** Память между визитами в localStorage. Всё в try/catch: приватный режим Safari / запрет хранилища. */
import type { PersonaId } from '../persona/types';

export interface Memory { name: string | null; persona: PersonaId | null; visits: number }
const KEY = 'sber-ar-cat:v1';

export function loadMemory(storage: Pick<Storage, 'getItem'> | null = safeStorage()): Memory {
  const def: Memory = { name: null, persona: null, visits: 0 };
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return def;
    const o = JSON.parse(raw);
    return {
      name: typeof o.name === 'string' ? o.name.slice(0, 30) : null,
      persona: typeof o.persona === 'string' ? o.persona : null,
      visits: Number.isFinite(o.visits) ? o.visits : 0,
    };
  } catch {
    return def;
  }
}

export function saveMemory(patch: Partial<Memory>, storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()): Memory {
  const cur = { ...loadMemory(storage), ...patch };
  try {
    storage?.setItem(KEY, JSON.stringify(cur));
  } catch {
    /* хранилище недоступно — работаем без памяти */
  }
  return cur;
}

export function clearMemory() {
  try {
    safeStorage()?.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

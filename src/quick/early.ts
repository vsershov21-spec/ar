/**
 * Мост между встроенным скриптом заставки (src/quick/splash.ts, работает до бандла) и приложением: всё, что
 * заставка успела сделать в жесте «Узнать, кто там», лежит в window.__quick. Без заставки (MVP, ?desktop…) —
 * всё возвращает null, и модули работают как раньше.
 */
export interface EarlyCam {
  stream?: MediaStream;
  /** камера+микрофон вместе не вышло — имя ошибки микрофона (камера открыта отдельно) */
  mic?: string;
  error?: { name: string; message: string };
}

export interface QuickBridge {
  ev: [string, Record<string, unknown>][];
  tapped: boolean;
  ready: boolean;
  ctx?: AudioContext;
  cam?: Promise<EarlyCam> | null;
  motion?: Promise<boolean>;
  track?: (name: string, props: Record<string, unknown>) => void;
  emit?: (name: string, props?: Record<string, unknown>) => void;
  onTap?: () => void;
  onRetry?: () => void;
  busy?: (on: boolean) => void;
  denied?: (e: { name: string; message: string }, second?: boolean) => void;
  hide?: () => void;
  /** камера пошла, приложение ещё качается: заставка → плашка «Положи карту…» поверх камеры */
  search?: () => void;
}

export function quickBridge(): QuickBridge | null {
  if (typeof window === 'undefined') return null;
  const q = (window as unknown as { __quick?: QuickBridge }).__quick;
  return q && Array.isArray(q.ev) ? q : null;
}

/** поток камеры (и микрофона), открытый заставкой в жесте; забирается один раз */
export function takeEarlyCamera(): Promise<EarlyCam> | null {
  const q = quickBridge();
  const p = q?.cam ?? null;
  if (q) q.cam = null;
  return p;
}

/** разрешение датчиков движения (iOS), запрошенное в жесте; забирается один раз */
export function takeEarlyMotion(): Promise<boolean> | null {
  const q = quickBridge();
  const p = q?.motion ?? null;
  if (q) q.motion = undefined;
  return p;
}

/** AudioContext, разбуженный заставкой в жесте (Audio берёт его вместо своего) */
export function earlyAudioContext(): AudioContext | null {
  return quickBridge()?.ctx ?? null;
}
/** Audio создал контекст сам — отдать заставке (жест на ней будит тот же контекст, а не второй) */
export function shareAudioContext(ctx: AudioContext) {
  const q = quickBridge();
  if (q && !q.ctx) q.ctx = ctx;
}

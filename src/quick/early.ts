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
  /** бандл исполнился (BOOT-01): заставка снимает дедлайн загрузки; после дедлайна — возвращает кнопку */
  boot?: () => void;
  booted?: boolean;
  /** приложение не поднялось: экран «Попробовать снова», ранние дорожки остановлены */
  fail?: (why: string) => void;
  /** причина сбоя загрузки ('script' | 'noboot' | 'timeout' | 'init'), false/undefined — сбоя нет */
  failed?: string | false;
  /** потоки, открытые заставкой (их останавливает сбой загрузки) */
  streams?: MediaStream[];
  /** дедлайн загрузки для тестов, мс (иначе BOOT_MS) */
  bootMs?: number;
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

/**
 * Первая строка кода бандла (main.ts): заставка снимает дедлайн загрузки (src/quick/splash.ts BOOT_MS) и убирает
 * из адреса метку перезагрузки _boot (кнопка «Попробовать снова»).
 */
export function markBooted() {
  const q = quickBridge();
  q?.boot?.();
  if (typeof location === 'undefined' || !/[?&]_boot=/.test(location.search)) return;
  try {
    const u = new URL(location.href);
    u.searchParams.delete('_boot');
    history.replaceState(history.state, '', u.pathname + u.search + u.hash);
  } catch {
    /* ignore */
  }
}

/** App.init упал: экран «Кот не проснулся» с «Попробовать снова» (камера и микрофон заставки — стоп) */
export function bootFailed(why = 'init') {
  quickBridge()?.fail?.(why);
}

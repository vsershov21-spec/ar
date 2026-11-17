/**
 * Энергобюджет: сколько кадров рисовать и как часто гонять трекер — по тому, что сейчас происходит,
 * а не «максимум всегда». Адаптация по fps (perf.ts) спасает слабые телефоны от тормозов, но не от нагрева:
 * iPhone держит 60 к/с и при этом жжёт батарею. Здесь — наоборот: частота по нужде.
 *
 *   boost  60 к/с — быстрые действия: реакция кота (не idle-клип), ходьба, живые эффекты, палец на экране (+1,2 с)
 *   normal 30 к/с — по умолчанию на телефоне (камера сама даёт 30 к/с: кот не «отстаёт» от видео)
 *   calm   20 к/с — кот в покое, телефон неподвижен ≥ 1,5 с (гироскоп < 4°/с, карта не едет), никто не говорит
 *   doze   12 к/с — «кот дремлет»: 60 с без касаний, речи и движения телефона
 *
 * Трекер (только после посадки кота; поиск карты до посадки — как был, по каждому кадру камеры):
 *   телефон движется / трекер теряет карту → полная частота камеры; ровно → 15 Гц; покой → 10 Гц; дрёма → 5 Гц.
 *   Полный поиск карты (detect) реже в покое: раз в 10 кадров трекера вместо 6.
 *
 * Чистая логика без DOM (тесты — energy.test.ts); датчики и счётчики подключает app.ts.
 * ?fps=60|30|… — зафиксировать частоту рендера; ?energy=0 — выключить бюджет (как раньше), ?energy=1 — включить на ПК.
 */

export type EnergyMode = 'boost' | 'normal' | 'calm' | 'doze';

export const RENDER_FPS: Record<EnergyMode, number> = { boost: 60, normal: 30, calm: 20, doze: 12 };
export const TRACKER_HZ: Record<EnergyMode, number> = { boost: 15, normal: 15, calm: 10, doze: 5 };

/**
 * Фоновые петли эффектов: идут, пока длится состояние (кот слушает, повторяет, спит), и не считаются «быстрым действием».
 * Иначе спящий кот с «Zzz» держал бы 60 к/с всю дрёму и энергобюджет никогда не уходил бы в «doze».
 */
export const AMBIENT_FX: ReadonlySet<string> = new Set(['listen_ears', 'echo_wave', 'zzz']);
/** живой эффект требует частоты «boost» (взрыв блёсток, жвачка, наклейки), а не фоновая петля */
export const fxNeedsBoost = (id: string): boolean => !AMBIENT_FX.has(id);

export interface EnergyInput {
  /** мс */
  now: number;
  /** кот на экране */
  catVisible: boolean;
  /** быстрое действие прямо сейчас (не idle-клип, ходьба, эффекты, жест) */
  action: boolean;
  /** кто-то говорит (кот или ребёнок): рот/лицо — не реже 30 к/с */
  talking: boolean;
  /** кот посажен на карту (трекер может работать реже) */
  locked: boolean;
  /** у трекера проблемы: карту только что потеряли (≤ 3 с) / ведём по поверхности — трекер на полную */
  trouble: boolean;
}

export interface EnergyOut {
  mode: EnergyMode;
  renderFps: number;
  /** потолок частоты трекера, Гц (0 — без потолка: каждый кадр камеры) */
  trackerHz: number;
  /** полный поиск карты раз в N кадров трекера */
  detectEvery: number;
}

/** движение телефона, °/с: выше — «движется» (трекер на полную) */
const MOVE_DPS = 25;
/** ниже — «неподвижен» */
const STILL_DPS = 4;
/** карта по экрану: доля диагонали в секунду */
const MOVE_QUAD = 0.6;
const STILL_QUAD = 0.08;

export class EnergyBudget {
  enabled: boolean;
  /** ?fps=N — рендер всегда N */
  readonly fixedFps: number;
  idleMs = 60000;
  stillMs = 1500;
  boostMs = 1200;

  private lastActivity = 0;
  private boostUntil = 0;
  private stillSince = -1;
  private fullUntil = 0;
  private gyro = 0;
  private hasGyro = false;
  private quad = 0;
  private lastRender = -1e9;
  out: EnergyOut = { mode: 'normal', renderFps: 60, trackerHz: 0, detectEvery: 6 };

  constructor(opts: { enabled: boolean; fixedFps?: number; now?: number }) {
    this.enabled = opts.enabled;
    this.fixedFps = opts.fixedFps && opts.fixedFps > 0 ? opts.fixedFps : 0;
    this.lastActivity = opts.now ?? 0;
  }

  /** касание, речь, встряска: сбросить дрёму и коротко — 60 к/с */
  activity(now: number, boost = true) {
    this.lastActivity = now;
    if (boost) {
      this.boostUntil = Math.max(this.boostUntil, now + this.boostMs);
      // следующий rAF — сразу кадр (app.ts проверяет due() до пересчёта режима): из дрёмы реакция без ожидания 83 мс
      this.lastRender = -1e9;
    }
  }

  /** скорость поворота телефона, °/с (devicemotion.rotationRate) */
  gyroSample(dps: number, now: number) {
    this.hasGyro = true;
    // быстро вверх, медленно вниз: короткий рывок не теряется между кадрами
    this.gyro = dps > this.gyro ? dps : this.gyro * 0.9 + dps * 0.1;
    if (dps > MOVE_DPS) this.lastActivity = now;
  }

  /** скорость карты на экране, доля диагонали в секунду (из последовательных углов трекера) */
  quadSample(v: number) {
    this.quad = v > this.quad ? v : this.quad * 0.8 + v * 0.2;
  }

  get moving() {
    return this.gyro > MOVE_DPS || this.quad > MOVE_QUAD;
  }

  get phoneDps() {
    return this.gyro;
  }

  update(i: EnergyInput): EnergyOut {
    const still = (this.hasGyro ? this.gyro < STILL_DPS : true) && this.quad < STILL_QUAD;
    if (!still) this.stillSince = -1;
    else if (this.stillSince < 0) this.stillSince = i.now;
    if (i.action || i.talking) this.lastActivity = Math.max(this.lastActivity, i.now);
    if (this.moving || i.trouble) this.fullUntil = i.now + 1000;

    let mode: EnergyMode;
    if (i.action || i.now < this.boostUntil) mode = 'boost';
    else if (i.now - this.lastActivity > this.idleMs) mode = 'doze';
    else if (i.catVisible && !i.talking && this.stillSince >= 0 && i.now - this.stillSince >= this.stillMs) mode = 'calm';
    else mode = 'normal';

    let fps = this.fixedFps || (this.enabled ? RENDER_FPS[mode] : 0);
    // кот не на экране — рисовать нечего, кроме эффектов: хватает 30 (эффекты сами поднимут до 60 через action)
    if (!this.fixedFps && this.enabled && !i.catVisible && mode !== 'boost') fps = Math.min(fps, 30);

    let hz = 0;
    let detectEvery = 6;
    if (this.enabled && i.locked && i.now >= this.fullUntil) {
      hz = TRACKER_HZ[mode];
      if (mode === 'calm' || mode === 'doze') detectEvery = 10;
    }
    this.out = { mode, renderFps: fps, trackerHz: hz, detectEvery };
    return this.out;
  }

  /**
   * Рисовать ли этот кадр (rAF приходит 60/120 раз в секунду): пропускаем лишние целиком — и логику, и рендер.
   * Допуск 3 мс: при 60 Гц экрана 30 к/с — ровно каждый второй кадр, а не «то 2, то 3».
   */
  due(now: number): boolean {
    const fps = this.out.renderFps;
    if (!fps || fps >= 120) {
      this.lastRender = now;
      return true;
    }
    if (now - this.lastRender >= 1000 / fps - 3) {
      this.lastRender = now;
      return true;
    }
    return false;
  }

  /** предел шага анимаций: при 12 к/с шаг 83 мс — не обрезать до 50 мс (иначе кот в дрёме двигается в замедленной съёмке) */
  get maxDt() {
    const fps = this.out.renderFps || 60;
    return Math.min(0.1, Math.max(0.05, 1.25 / fps));
  }
}

/** телефон/планшет (energy по умолчанию включён) */
export function isMobileDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod|Android|Mobile/i.test(ua)) return true;
  // iPadOS притворяется Mac'ом
  return /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;
}

/**
 * pixelRatio по умолчанию: телефон — 1,5 (ПК — до 2).
 * Почему 1,5: видео камеры 720×1280 растянуто «cover» на экран 390×844 → ≈ 1,5 пикселя видео на CSS-пиксель;
 * кот чётче фона не нужен, а буфер 1,75 (было для 390×844) — на 36% больше пикселей (заливка, MSAA, композитинг).
 * Маленькие экраны (SE 375×667) — тоже 1,5: было 2 (×1,8 пикселей при той же камере).
 */
export function defaultPixelRatio(_cssW: number, _cssH: number, dpr: number, mobile: boolean): number {
  const d = dpr || 1;
  return Math.min(d, mobile ? MOBILE_PR : 2);
}
export const MOBILE_PR = 1.5;
